const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY
const heartbeatTable = process.env.SUPABASE_HEARTBEAT_TABLE || 'profiles'

if (!supabaseUrl) {
  console.error('SUPABASE_URL is required.')
  process.exit(1)
}

if (!supabaseKey) {
  console.error('SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY is required.')
  process.exit(1)
}

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(heartbeatTable)) {
  console.error('SUPABASE_HEARTBEAT_TABLE must be a simple table or view name.')
  process.exit(1)
}

const baseUrl = supabaseUrl.replace(/\/+$/, '')
const url = `${baseUrl}/rest/v1/${heartbeatTable}?select=id&limit=1`

const response = await fetch(url, {
  headers: {
    Accept: 'application/json',
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  },
})

if (!response.ok) {
  const body = await response.text()
  console.error(`Supabase heartbeat failed with HTTP ${response.status}.`)
  if (body) {
    console.error(body.slice(0, 1000))
  }
  process.exit(1)
}

console.log(`Supabase heartbeat OK (${response.status}) via ${heartbeatTable}.`)
