// Stage B1 refinement — pure classifier + reachability probe.
//
// Extracted from main.js so tests can import it without pulling the
// whole DOM/CSS/module graph. Kept side-effect free: no imports from
// screens, no window mutations, no timers at module load. main.js
// re-exports what it needs.

import { SUPABASE_ORIGIN, SUPABASE_PUBLISHABLE_KEY } from './supabase.js'

// Classify an error thrown while resolving a Supabase session.
//
// SERVER-CONFIRMED SESSION REJECTION — the server has ruled the stored
// session unusable. Cached boot must NOT proceed. Signals include an
// invalid/revoked/missing refresh token and a server-reported missing user
// or session.
//
// A bare "JWT expired" from the access token is NOT counted here: Supabase
// access tokens are short-lived by design; a normal boot will refresh the
// token silently, and if the refresh itself fails, we will observe the
// refresh-side signal (invalid_refresh_token / refresh_token_not_found).
// Denying cached boot on a plain expired access JWT would deny it on every
// offline launch — which is exactly the bug we are here to prevent.
export const EXPLICIT_AUTH_REJECT_TAGS = Object.freeze([
  'invalid_grant',
  'invalid refresh token',
  'invalid_refresh_token',
  'refresh_token_not_found',
  'refresh_token_already_used',
  'refresh token expired',
  'user_not_found',
  'session_not_found',
])

export function isExplicitAuthRejection(err) {
  if (!err) return false
  // Consider every string-shaped signal on the error object so both
  // top-level `code`/`error` tags and the free-text `message`/
  // `error_description` variants match. Supabase-js surfaces these
  // inconsistently across REST vs GoTrue endpoints.
  const parts = [
    err.message,
    err.error_description,
    err.error,
    err.code,
    err.name,
    typeof err === 'string' ? err : '',
  ]
  const haystack = parts
    .filter(v => v != null && v !== '')
    .map(v => String(v).toLowerCase())
    .join(' | ')
  if (!haystack) return false
  return EXPLICIT_AUTH_REJECT_TAGS.some(tag => haystack.includes(tag))
}

export function isTransportSessionError(err) {
  if (!err) return false
  const message = String(err?.message || err || '').toLowerCase()
  const tags = [
    'network',
    'failed to fetch',
    'load failed',
    'timeout',
    'timed out',
    'aborted',
    'the operation was aborted',
    'network request failed',
    'net::',
    'ecconnrefused',
    'econnreset',
    'ehostunreach',
    'connection closed',
  ]
  if (tags.some(tag => message.includes(tag))) return true
  // Only trust an EXPLICIT status field — a plain Error object with no
  // status must not fall through here (would flag every unrelated Error
  // shape as transport).
  if (err && Object.prototype.hasOwnProperty.call(err, 'status')) {
    const status = Number(err.status)
    if (Number.isFinite(status)) {
      if (status >= 500 && status < 600) return true
      if (status === 0) return true
    }
  }
  return false
}

// Minimum reachability probe (Stage B1). Sends a small GET to Supabase's
// `/auth/v1/health` with a short timeout, `no-store`, and ONLY the
// publishable `apikey` header — never the user's access token or any other
// auth header (an anonymous request 401s at the API gateway; the classifier
// tolerated that, but the request should simply be well-formed). Any
// well-formed HTTP response with status < 500 means the hop reached the
// Supabase auth server (== reachable). Transport error / timeout / DNS /
// TLS / 5xx all classify as unreachable.
//
// This is used to distinguish two failure modes that look identical to
// `supabase.auth.getSession()`:
//   * network is unreachable → AUTHENTICATED_CACHED
//   * network is reachable, session is missing/invalid → AUTHENTICATED_REAUTH_REQUIRED
//
// It is NEVER used as auth authority — the state gate for writes/uploads
// remains `AUTHENTICATED_COMPLETE`.
export async function probeBackendReachability({
  timeoutMs = 3000,
  fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
  origin = SUPABASE_ORIGIN,
  apikey = SUPABASE_PUBLISHABLE_KEY,
} = {}) {
  if (typeof fetchImpl !== 'function') return 'unreachable'
  if (!origin) return 'unreachable'
  let controller
  let timer
  try {
    controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  } catch (_) { controller = null }
  try {
    if (controller) {
      timer = setTimeout(() => {
        try { controller.abort() } catch (_) {}
      }, timeoutMs)
    }
    const url = `${String(origin).replace(/\/$/, '')}/auth/v1/health`
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller?.signal,
      ...(apikey ? { headers: { apikey } } : {}),
    })
    const status = Number(response?.status || 0)
    if (status >= 500 && status < 600) return 'unreachable'
    if (status >= 100) return 'reachable'
    return 'unreachable'
  } catch (_) {
    return 'unreachable'
  } finally {
    if (timer) clearTimeout(timer)
  }
}
