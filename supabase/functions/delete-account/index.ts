import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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

    await deleteFolderContents('observation-images', uid)
    await deleteFolderContents('avatars', uid)

    await admin.from('comments').delete().eq('user_id', uid)
    await admin.from('observation_shares').delete().eq('shared_with_id', uid)
    await admin.from('friendships').delete().or(`requester_id.eq.${uid},addressee_id.eq.${uid}`)

    const { data: observations } = await admin
      .from('observations')
      .select('id')
      .eq('user_id', uid)

    const observationIds = (observations || []).map(obs => obs.id)
    if (observationIds.length) {
      await admin.from('comments').delete().in('observation_id', observationIds)
      await admin.from('observation_images').delete().in('observation_id', observationIds)
      await admin.from('observation_shares').delete().in('observation_id', observationIds)
      await admin.from('observations').delete().in('id', observationIds)
    }

    // Also delete desktop-app synced tables to prevent FK constraint errors
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

async function deleteFolderContents(bucket: string, uid: string) {
  const folders = [{ path: uid, prefix: uid }]

  while (folders.length) {
    const current = folders.pop()
    if (!current) continue

    const { data, error } = await admin.storage.from(bucket).list(current.path, {
      limit: 1000,
      offset: 0,
    })

    if (error || !data?.length) continue

    const files = []
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
        console.error(`Failed removing files from ${bucket}:`, removeError)
      }
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
