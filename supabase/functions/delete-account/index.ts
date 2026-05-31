/// <reference lib="dom" />
/// <reference lib="deno.ns" />

import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const mediaUploadBaseUrl = (Deno.env.get('MEDIA_UPLOAD_BASE_URL') ?? 'https://upload.sporely.no').replace(/\/+$/, '')

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Missing Authorization header' }, 401)
    }

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const uid = user.id

    // Canonical observation media now lives in R2, so delete the current
    // observation-image keys through the upload worker first.
    await deleteObservationMedia(uid, authHeader)

    // Legacy Supabase Storage cleanup remains as a compatibility sweep for
    // old pre-migration observation-images rows and avatars.
    await deleteFolderContents('observation-images', uid)
    await deleteFolderContents('avatars', uid)

    await admin.from('comments').delete().eq('user_id', uid)
    await admin.from('observation_shares').delete().eq('shared_with_id', uid)
    await admin.from('friendships').delete().or(`requester_id.eq.${uid},addressee_id.eq.${uid}`)
    await admin.from('user_blocks').delete().or(`blocker_id.eq.${uid},blocked_id.eq.${uid}`)

    const { data: observations, error: observationsError } = await admin
      .from('observations')
      .select('id')
      .eq('user_id', uid)

    if (observationsError) {
      throw new Error(`Failed to load observations for account deletion: ${observationsError.message}`)
    }

    const observationIds = (observations || []).map(obs => obs.id)
    if (observationIds.length) {
      await admin.from('comments').delete().in('observation_id', observationIds)
      await admin.from('observation_images').delete().in('observation_id', observationIds)
      await admin.from('observation_shares').delete().in('observation_id', observationIds)
      await admin.from('observations').delete().in('id', observationIds)
    }

    // Also delete desktop-app synced tables to prevent FK constraint errors.
    await admin.from('spore_measurements').delete().eq('user_id', uid)
    await admin.from('calibrations').delete().eq('user_id', uid)

    await admin.from('profiles').delete().eq('id', uid)

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(uid)
    if (deleteUserError) {
      console.error('deleteUser failed:', deleteUserError)
      return json({ error: deleteUserError.message }, 500)
    }

    return json({ ok: true })
  } catch (error) {
    console.error(error)
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500)
  }
})

async function deleteObservationMedia(uid: string, authHeader: string) {
  const { data, error } = await admin
    .from('observation_images')
    .select('storage_path')
    .eq('user_id', uid)

  if (error) {
    throw new Error(`Failed to load observation media for account deletion: ${error.message}`)
  }

  const keys = new Set<string>()
  for (const row of data || []) {
    for (const key of observationMediaDeleteTargets(row.storage_path)) {
      if (key) keys.add(key)
    }
  }

  for (const key of keys) {
    await deleteMediaViaWorker(key, authHeader)
  }
}

function observationMediaDeleteTargets(storagePath: string) {
  const normalizedPath = normalizeStoragePath(storagePath)
  if (!normalizedPath) return []

  const segments = normalizedPath.split('/').filter(Boolean)
  const fileName = segments.pop() || ''
  if (!fileName) return [normalizedPath]

  const dir = segments.join('/')
  const originalName = fileName.startsWith('thumb_') ? fileName.slice('thumb_'.length) : fileName
  const thumbName = fileName.startsWith('thumb_') ? fileName : `thumb_${fileName}`

  return [...new Set([joinStoragePath(dir, originalName), joinStoragePath(dir, thumbName)])]
}

function joinStoragePath(dir: string, fileName: string) {
  return dir ? `${dir}/${fileName}` : fileName
}

function normalizeStoragePath(storagePath: string) {
  return String(storagePath ?? '').trim().replace(/^\/+/, '')
}

async function deleteMediaViaWorker(storagePath: string, authHeader: string) {
  const normalizedPath = normalizeStoragePath(storagePath)
  if (!normalizedPath) return

  const response = await fetch(`${mediaUploadBaseUrl}/upload/${encodeObjectKey(normalizedPath)}`, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader,
    },
  })

  if (!response.ok) {
    const responseText = await response.text()
    let detail = response.statusText || 'Delete failed'
    if (responseText) {
      try {
        const payload = JSON.parse(responseText)
        if (payload?.error) detail = payload.error
        else if (payload?.message) detail = payload.message
      } catch (_) {
        detail = responseText
      }
    }
    throw new Error(`Worker delete failed for ${normalizedPath}: ${detail}`)
  }
}

function encodeObjectKey(storagePath: string) {
  return normalizeStoragePath(storagePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

async function deleteFolderContents(bucket: string, uid: string) {
  const folders = [{ path: uid, prefix: uid }]

  while (folders.length) {
    const current = folders.pop()
    if (!current) continue

    let offset = 0
    while (true) {
      const { data, error } = await admin.storage.from(bucket).list(current.path, {
        limit: 1000,
        offset,
      })

      if (error) {
        throw new Error(`Failed listing files from ${bucket}: ${error.message}`)
      }
      if (!data?.length) break

      const files: string[] = []
      for (const item of data) {
        if (!item.name) continue
        const itemPath = `${current.prefix}/${item.name}`
        if (item.id) {
          files.push(itemPath)
        } else {
          folders.push({ path: itemPath, prefix: itemPath })
        }
      }

      if (files.length) {
        const { error: removeError } = await admin.storage.from(bucket).remove(files)
        if (removeError) {
          throw new Error(`Failed removing files from ${bucket}: ${removeError.message}`)
        }
      }

      if (data.length < 1000) break
      offset += data.length
    }
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}
