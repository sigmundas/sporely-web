// Explicit auth/profile state machine, subscribed to by main.js and the
// profile screen. Consumers must not render authenticated app content until
// the state is `authenticated-complete`. If the state is
// `authenticated-incomplete`, only the Profile setup UI may be shown.

export const AUTH_STATE = Object.freeze({
  RESOLVING: 'resolving',
  UNAUTHENTICATED: 'unauthenticated',
  AUTHENTICATED_INCOMPLETE: 'authenticated-incomplete',
  AUTHENTICATED_COMPLETE: 'authenticated-complete',
})

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
