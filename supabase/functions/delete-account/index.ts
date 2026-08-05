/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2'
// Deno resolves the plain-JS plan module fine; Node tests import the same
// file. Keeping it .js avoids the TS-import ceremony on both sides.
// deno-lint-ignore-file no-explicit-any
import { encodeObjectKey, normalizeStoragePath, runDeletionPlan } from './plan.js'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const mediaUploadBaseUrl = (Deno.env.get('MEDIA_UPLOAD_BASE_URL') ?? 'https://upload.sporely.no').replace(/\/+$/, '')

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Native Capacitor Android runs the WebView at https://localhost by default
// (Capacitor 4+ androidScheme). iOS uses capacitor://localhost. The web app
// lives at https://app.sporely.no.
const ALLOWED_ORIGINS = new Set([
  'https://app.sporely.no',
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
])

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || ''
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://app.sporely.no'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

Deno.serve(async req => {
  const corsHeaders = corsHeadersFor(req)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'unauthorized' }, 401, corsHeaders)
  }

  // Authenticate the caller with the anon client so RLS confirms the JWT
  // belongs to a real user; then we execute deletes with the service role.
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData?.user) {
    return json({ error: 'unauthorized' }, 401, corsHeaders)
  }
  const uid = userData.user.id

  const worker = {
    async deleteKey(key: string) {
      const url = `${mediaUploadBaseUrl}/upload/${encodeObjectKey(key)}`
      try {
        const response = await fetch(url, {
          method: 'DELETE',
          headers: { Authorization: authHeader },
        })
        if (response.ok) return { ok: true, status: response.status }
        // 404 = already deleted; the plan treats it as success.
        if (response.status === 404) return { ok: true, status: 404 }
        let detail = response.statusText || 'unknown'
        try {
          const text = await response.text()
          if (text) {
            try {
              const parsed = JSON.parse(text)
              detail = parsed?.error || parsed?.message || detail
            } catch { detail = text }
          }
        } catch { /* swallow body-read errors */ }
        return { ok: false, status: response.status, detail }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
    },
  }

  try {
    const result = await runDeletionPlan({
      uid,
      admin,
      worker,
      r2Keys: new Set<string>(),
    })

    if (result.ok) {
      logDeletionOutcome({ ok: true, completed: result.completed })
      return json({ ok: true }, 200, corsHeaders)
    }

    // Structured error surface. `stage` tells ops which step failed; `error`
    // is a client-safe short message. Detailed server-side log carries the
    // full error text with the stage label but no access token/user id.
    logDeletionOutcome({
      ok: false,
      stage: result.stage,
      error: result.error,
      completed: result.completed,
    })
    return json({ error: 'account_delete_failed', stage: result.stage || 'unknown' }, 500, corsHeaders)
  } catch (err) {
    // Should not happen — runDeletionPlan is expected to catch its own
    // stage errors — but a defensive catch prevents raw exceptions leaking.
    console.error('[delete-account] unexpected', { message: (err as Error).message })
    return json({ error: 'account_delete_failed', stage: 'unknown' }, 500, corsHeaders)
  }
})

function logDeletionOutcome(entry: {
  ok: boolean
  stage?: string
  error?: string
  completed: string[]
}) {
  // NEVER log user ids, storage paths, tokens, or profile values.
  console.info('[delete-account]', {
    ok: entry.ok,
    stage: entry.stage || null,
    completedCount: entry.completed.length,
    errorSummary: entry.error ? entry.error.slice(0, 200) : null,
  })
}

function json(body: Record<string, unknown>, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

// Keep the following exports so future callers can use them without
// duplicating logic. Not referenced at runtime here.
export { normalizeStoragePath }
