/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2.110.7'

import { handleReferenceCurationAction } from './actions.ts'
import { createReferenceCurationHttpHandler } from './http.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const allowedOrigins = parseAllowedOrigins(
  Deno.env.get('REFERENCE_CURATION_ALLOWED_ORIGINS') ?? '',
)

const handler = createReferenceCurationHttpHandler({
  allowedOrigins,
  authenticate: async (accessToken) => {
    if (!supabaseUrl || !supabaseAnonKey) return null
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
    const [userResult, claimsResult] = await Promise.all([
      callerClient.auth.getUser(accessToken),
      callerClient.auth.getClaims(accessToken),
    ])
    if (
      userResult.error || claimsResult.error ||
      !userResult.data.user || !claimsResult.data?.claims
    ) {
      return null
    }
    return {
      user: { id: userResult.data.user.id },
      claims: claimsResult.data.claims,
    }
  },
  dispatch: async (input) => {
    const adminClient = getAdminClient()
    return handleReferenceCurationAction({
      ...input,
      adminClient,
    })
  },
  logError: (message) => console.error(`[reference-curation] ${message}`),
})

Deno.serve(handler)

function getAdminClient() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('reference-curation is not configured')
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function parseAllowedOrigins(value: string): Set<string> {
  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean)
  return new Set(origins.filter(isValidOrigin))
}

function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === value && (url.protocol === 'https:' || url.hostname === 'localhost')
  } catch {
    return false
  }
}
