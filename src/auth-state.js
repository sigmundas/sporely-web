// Explicit auth/profile state machine, subscribed to by main.js and the
// profile screen. Consumers must not render authenticated app content until
// the state is `authenticated-complete` (fully server-validated) or one of
// the two "reveal-only" cached states below. If the state is
// `authenticated-incomplete`, only the Profile setup UI may be shown.
//
// AUTHENTICATED_CACHED (Stage B1):
//   The device previously completed a successful ONLINE resolution for this
//   local-data-owner, but the current launch could not reach Supabase (the
//   reachability probe classified the backend as unreachable). The shell is
//   revealed with header chrome painted from the persisted
//   last-validated-account record; background revalidation runs when the
//   network returns and transitions to AUTHENTICATED_COMPLETE. It does NOT
//   mean "server confirmed this session during this launch" — do not treat
//   it as equivalent to _COMPLETE for operations that require a live
//   session (uploads, RPCs, writes).
//
// AUTHENTICATED_REAUTH_REQUIRED (Stage B1):
//   The device previously completed a successful online resolution AND the
//   backend is currently reachable, but the local Supabase session is
//   missing/expired-and-unrefreshable. The shell is revealed with the
//   cached identity so drafts remain accessible, but authenticated network
//   operations MUST be disabled — the server can be reached, so any failing
//   auth op will produce a real 401 rather than a spurious offline error.
//   The reconnect triggers (`online`, `visibilitychange:visible`) will drive
//   the transition back to AUTHENTICATED_COMPLETE once the user reauths (or
//   the refresh mechanism recovers).

export const AUTH_STATE = Object.freeze({
  RESOLVING: 'resolving',
  UNAUTHENTICATED: 'unauthenticated',
  AUTHENTICATED_INCOMPLETE: 'authenticated-incomplete',
  AUTHENTICATED_COMPLETE: 'authenticated-complete',
  AUTHENTICATED_CACHED: 'authenticated-cached',
  AUTHENTICATED_REAUTH_REQUIRED: 'authenticated-reauth-required',
})

// Convenience predicate: is this state safe to attempt authenticated network
// writes/uploads/RPCs? Only AUTHENTICATED_COMPLETE qualifies — every other
// state either lacks a validated session (RESOLVING / UNAUTHENTICATED /
// AUTHENTICATED_CACHED / AUTHENTICATED_REAUTH_REQUIRED) or requires the
// setup screen to finish first (AUTHENTICATED_INCOMPLETE).
export function isAuthorizedForAuthenticatedNetworkOps(stateValue) {
  return stateValue === AUTH_STATE.AUTHENTICATED_COMPLETE
}

let _current = { state: AUTH_STATE.RESOLVING, userId: null }
const _subs = new Set()

export function getAuthState() {
  return _current
}

export function setAuthState(next) {
  const normalized = {
    state: next?.state || AUTH_STATE.RESOLVING,
    userId: next?.userId || null,
  }
  if (normalized.state === _current.state && normalized.userId === _current.userId) return
  _current = normalized
  for (const fn of [..._subs]) {
    try { fn(_current) } catch (err) { console.warn('auth-state subscriber threw:', err) }
  }
}

export function subscribeAuthState(fn) {
  _subs.add(fn)
  try { fn(_current) } catch (err) { console.warn('auth-state subscriber threw:', err) }
  return () => { _subs.delete(fn) }
}

// Test-only reset. Not called by production code.
export function _resetAuthStateForTests() {
  _current = { state: AUTH_STATE.RESOLVING, userId: null }
  _subs.clear()
}
