import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://zkpjklzfwzefhjluvhfw.supabase.co'
const SUPABASE_KEY = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_nZrERVFN3WR4Aqn2yggc7Q_siAG1TCV'
const SUPABASE_AUTH_OPTIONS = {
  flowType: 'pkce',
  detectSessionInUrl: (url) => !url?.pathname?.startsWith('/auth/callback'),
}

const GLOBAL_SUPABASE_KEY = '__sporelySupabaseClient__'

function _getSupabaseSingleton() {
  const globalScope = globalThis
  if (!globalScope[GLOBAL_SUPABASE_KEY]) {
    globalScope[GLOBAL_SUPABASE_KEY] = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: SUPABASE_AUTH_OPTIONS,
    })
  }
  return globalScope[GLOBAL_SUPABASE_KEY]
}

export const supabase = _getSupabaseSingleton()

// Boot-time auth-event capture. auth-js `initialize()` runs
// `_recoverAndRefresh()` as soon as the client is created; a non-retryable
// refresh rejection (e.g. refresh-token rotation race after a process kill)
// removes the stored session and emits SIGNED_OUT BEFORE main.js has
// registered its `onAuthStateChange` subscription — so the app's sign-out
// purge/classification never sees it. Record event NAMES only (never
// sessions/tokens) so the cached-boot classifier and diagnostics can tell
// "session was actively removed at init" apart from "no session stored".
const _earlyAuthEvents = []
let _earlyAuthCaptureActive = true
const _earlyAuthSubscription = supabase.auth.onAuthStateChange(event => {
  if (!_earlyAuthCaptureActive) return
  if (_earlyAuthEvents.length < 8) _earlyAuthEvents.push(event)
})

export function getEarlyBootAuthEvents() {
  return _earlyAuthEvents.slice()
}

export function hadEarlyBootSignOut() {
  return _earlyAuthEvents.includes('SIGNED_OUT')
}

// Called by main.js once its own subscription is live; capture stops so the
// buffer only ever describes the pre-subscription window.
export function stopEarlyAuthEventCapture() {
  _earlyAuthCaptureActive = false
  try { _earlyAuthSubscription?.data?.subscription?.unsubscribe?.() } catch (_) { /* best-effort */ }
}
// Stage B1 reachability probe needs the raw origin so it can issue a
// tiny anon fetch against `/auth/v1/health` without going through the
// supabase-js client (which would try to attach the missing session).
export const SUPABASE_ORIGIN = SUPABASE_URL
// The probe identifies itself to the API gateway with the PUBLISHABLE key
// only (an anonymous request would 401 at the gateway). Never a user access
// token, never a secret credential.
export const SUPABASE_PUBLISHABLE_KEY = SUPABASE_KEY
