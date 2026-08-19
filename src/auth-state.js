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

// Terminally resolved states — the profile-resolution pipeline has run to a
// resting destination (server-validated home or the setup screen) and does
// NOT need to re-run for the same user until state moves.
//
// Deliberately EXCLUDES `AUTHENTICATED_CACHED` and
// `AUTHENTICATED_REAUTH_REQUIRED`. Those are trusted-cache reveals: a prior
// launch validated this identity, and the shell is painted from the persisted
// snapshot so the user is not blocked, but the backend has NOT confirmed a
// session during this reveal. A live reconnect for the same user MUST re-enter
// the resolver so `_revalidateCachedRevealInPlace()` runs, refreshes the
// profile, and lifts the state to `AUTHENTICATED_COMPLETE` (which then drives
// the reconnect sync trigger). Round-5 regression: previously the resolver's
// `_resolvedUsers` dedupe treated CACHED as terminal, which turned a live
// airplane-off recovery into a permanent no-op until the app was force-quit.
export function isTerminallyResolvedAuthState(stateValue) {
  return stateValue === AUTH_STATE.AUTHENTICATED_COMPLETE
    || stateValue === AUTH_STATE.AUTHENTICATED_INCOMPLETE
}

// Pure dedupe predicate used by `resolveAuthenticatedSessionOnce` in main.js.
// Extracted so every auth state can be proven behaviorally in a unit test —
// main.js runs heavy side-effects at import, so it can't be pulled into a
// Node test directly. See PLAN-startup.md "Round 5 — cached reconnect no-op
// regression" for the concrete failure this predicate prevents.
//
// Returns true iff:
//   - a prior online resolution recorded `userId` as reaching a terminal
//     destination (`resolvedUsers.has(userId)`),
//   - the current auth state's userId matches, AND
//   - the current auth state is itself terminally resolved (COMPLETE or
//     INCOMPLETE — see `isTerminallyResolvedAuthState`).
//
// A CACHED / REAUTH_REQUIRED shell for the same previously-resolved user
// MUST return false: the trusted-cache shell was revealed without server
// validation, and a live reconnect needs to re-enter the resolver so the
// existing in-place revalidation path can lift the state back to COMPLETE.
export function isUserAlreadyResolved(userId, resolvedUsers, currentAuth) {
  if (!userId) return false
  if (!resolvedUsers?.has?.(userId)) return false
  if (currentAuth?.userId !== userId) return false
  return isTerminallyResolvedAuthState(currentAuth?.state)
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
