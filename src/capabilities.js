// Stage B2b — centralized capability gating for online-only actions.
//
// Every user-triggered action that ultimately requires a live Supabase
// session (writes, RPCs, Edge Functions, storage uploads, AI, OAuth linking,
// iNaturalist, taxonomy search, etc.) must consult this module before it
// dispatches the request. That guarantees:
//
//   * A single source of truth for "is this action allowed right now?"
//   * A single, user-friendly message ("Internet connection required." vs.
//     "Sign in to reconnect.") that stays consistent across screens.
//   * No dependency on `navigator.onLine` for authorization decisions — the
//     capability is derived exclusively from the auth-state machine.
//
// Only AUTHENTICATED_COMPLETE authorizes authenticated network operations.
// AUTHENTICATED_CACHED / AUTHENTICATED_REAUTH_REQUIRED are cached-shell reveal
// states: local/cached work stays available, but any authenticated network
// dispatch would be doomed (offline) or fail with a real 401 (reauth needed).
//
// The capability *result* is intentionally richer than a boolean. Callers may
// key their UI or telemetry off the `reason` code:
//
//   { allowed: true }
//   { allowed: false, reason: 'offline',          message: 'Internet connection required.' }
//   { allowed: false, reason: 'reauth_required',  message: 'Sign in to reconnect.' }
//   { allowed: false, reason: 'unauthenticated',  message: 'Sign in to reconnect.' }
//   { allowed: false, reason: 'setup_incomplete', message: 'Finish setting up your account.' }
//   { allowed: false, reason: 'resolving',        message: 'Please wait…' }

import { AUTH_STATE, getAuthState } from './auth-state.js'
import { t } from './i18n.js'

export const CAPABILITY_REASON = Object.freeze({
  OFFLINE: 'offline',
  REAUTH_REQUIRED: 'reauth_required',
  UNAUTHENTICATED: 'unauthenticated',
  SETUP_INCOMPLETE: 'setup_incomplete',
  RESOLVING: 'resolving',
})

const ALLOWED = Object.freeze({ allowed: true })

function _messageForReason(reason) {
  switch (reason) {
    case CAPABILITY_REASON.OFFLINE:
      return t('common.internetRequired')
    case CAPABILITY_REASON.REAUTH_REQUIRED:
    case CAPABILITY_REASON.UNAUTHENTICATED:
      return t('common.signInToReconnect')
    case CAPABILITY_REASON.SETUP_INCOMPLETE:
      return t('common.finishSetup')
    case CAPABILITY_REASON.RESOLVING:
    default:
      return t('common.pleaseWait')
  }
}

function _denied(reason) {
  return Object.freeze({ allowed: false, reason, message: _messageForReason(reason) })
}

function _reasonForState(stateValue) {
  switch (stateValue) {
    case AUTH_STATE.AUTHENTICATED_COMPLETE: return null
    case AUTH_STATE.AUTHENTICATED_CACHED: return CAPABILITY_REASON.OFFLINE
    case AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED: return CAPABILITY_REASON.REAUTH_REQUIRED
    case AUTH_STATE.AUTHENTICATED_INCOMPLETE: return CAPABILITY_REASON.SETUP_INCOMPLETE
    case AUTH_STATE.UNAUTHENTICATED: return CAPABILITY_REASON.UNAUTHENTICATED
    case AUTH_STATE.RESOLVING:
    default:
      return CAPABILITY_REASON.RESOLVING
  }
}

function _currentAuthState(overrideState) {
  if (overrideState && typeof overrideState === 'string') return overrideState
  const snap = getAuthState()
  return snap?.state || AUTH_STATE.RESOLVING
}

// Authenticated network op — the write/upload/RPC gate. Only COMPLETE allows
// it; every other state returns a denial with a specific `reason`.
export function canUseAuthenticatedNetwork(overrideState) {
  const stateValue = _currentAuthState(overrideState)
  const reason = _reasonForState(stateValue)
  return reason ? _denied(reason) : ALLOWED
}

// Cloud mutation — same authoritative gate as canUseAuthenticatedNetwork,
// exposed under a distinct name so mutation sites document intent.
export function canPerformCloudMutation(overrideState) {
  return canUseAuthenticatedNetwork(overrideState)
}

// OAuth "connect this account to Google / iNaturalist" — this is a linking
// action that requires the authenticated pipeline. Sign-in from the Login
// screen (UNAUTHENTICATED state) is NOT gated here; see canBeginLoginOAuth.
export function canUseOAuthLink(overrideState) {
  return canUseAuthenticatedNetwork(overrideState)
}

// The Login screen's Google / password / signup / reset flows must still
// work when we are UNAUTHENTICATED. This capability describes whether the
// unauthenticated login pipeline may be started.
export function canBeginLoginOAuth(overrideState) {
  const stateValue = _currentAuthState(overrideState)
  if (stateValue === AUTH_STATE.UNAUTHENTICATED) return ALLOWED
  // AUTHENTICATED_REAUTH_REQUIRED is the one authenticated state whose ONLY
  // exit is a fresh sign-in: the backend is reachable but the stored session
  // is unrecoverable. The Profile sheet's "Sign in again" recovery action
  // starts the ordinary login pipeline here; a successful same-user sign-in
  // takes the in-place revalidation path (no purge), a different user takes
  // the full account-transition boundary.
  if (stateValue === AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED) return ALLOWED
  if (stateValue === AUTH_STATE.RESOLVING) return _denied(CAPABILITY_REASON.RESOLVING)
  // Any other AUTHENTICATED_* variant already has a live or recoverable
  // session — starting a fresh Login OAuth flow is not the right action.
  return _denied(CAPABILITY_REASON.REAUTH_REQUIRED)
}

// Truthy in the two cached-shell reveal modes. Used by call sites that want
// to render a small inline hint without deciding the exact reason.
export function isOfflineCachedMode(overrideState) {
  const stateValue = _currentAuthState(overrideState)
  return stateValue === AUTH_STATE.AUTHENTICATED_CACHED
}

export function requiresReauthentication(overrideState) {
  const stateValue = _currentAuthState(overrideState)
  return stateValue === AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
}

// Small helper: dispatches the standard denial toast, returns true when the
// caller should proceed (capability granted) and false when it should abort.
// Pass a `showToast` implementation so we do not create a circular import
// through the toast module — Node tests inject a stub.
export function requireCloudMutation({ showToast, overrideState, silent = false } = {}) {
  const capability = canPerformCloudMutation(overrideState)
  if (capability.allowed) return { allowed: true }
  if (!silent && typeof showToast === 'function') {
    try { showToast(capability.message) } catch (err) { console.warn('capability toast failed:', err) }
  }
  return capability
}

// Local operations (drafts, queued observations, cache reads, Capture,
// Import, Review, settings that are local-only) are ALWAYS allowed. This
// helper exists so call sites can be explicit about intent.
export function canPerformLocalOperation() {
  return ALLOWED
}
