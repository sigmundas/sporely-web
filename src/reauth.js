// Single application-level entry point for session recovery from
// AUTHENTICATED_REAUTH_REQUIRED. Every "Sign in again" surface (Profile
// sheet, Home banner, Finds notice) calls `beginReauthentication()` — there
// is exactly ONE recovery pathway, injected once by main.js at init.
//
// The injected handler must authenticate WITHOUT signing out first — queued
// observations, drafts, and the trusted same-user snapshot captured during
// REAUTH_REQUIRED must survive a same-user reauth. A successful sign-in
// fires SIGNED_IN → resolveAuthenticatedSessionOnce → same-user in-place
// revalidation → AUTHENTICATED_COMPLETE (queue drain + screen reconciliation
// bound to that transition). A different-user sign-in takes the existing
// full account-transition privacy boundary unchanged.
import { requiresReauthentication } from './capabilities.js'

let _handler = null

// main.js injects the recovery entry point (auth-UI init + login overlay in
// reauth mode) so screen modules never import main.js.
export function setReauthHandler(handler) {
  _handler = typeof handler === 'function' ? handler : null
}

// Only applicable to AUTHENTICATED_REAUTH_REQUIRED — in every other state
// (including plain-offline AUTHENTICATED_CACHED) this is a no-op, so a
// stale button click can never open the login overlay over a live session.
export function beginReauthentication(prefillEmail = '') {
  if (!requiresReauthentication()) return false
  if (!_handler) return false
  _handler(prefillEmail || '')
  return true
}
