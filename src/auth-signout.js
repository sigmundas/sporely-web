// Explicit (app/user-initiated) sign-out seam.
//
// auth-js ALSO emits SIGNED_OUT internally when it removes an unrecoverable
// stored session on its own (`_callRefreshToken` → `_removeSession` on a
// non-retryable refresh rejection — e.g. a rotation race or a server-side
// revocation) — without any app code calling signOut(). The main.js
// SIGNED_OUT handler must be able to tell the two apart:
//
//   * explicit sign-out (Logg ut, delete account, setup "use another
//     account", password-reset flows, resolution-error escape) keeps its
//     full purge semantics — drafts, snapshot, owner marker, caches;
//   * internal session loss must NOT destroy queued observations/drafts;
//     it pins AUTHENTICATED_REAUTH_REQUIRED so the Profile sheet's
//     "Sign in again" recovery applies.
//
// Every signOut() in the app MUST route through performExplicitSignOut so
// the deferred SIGNED_OUT handler can classify the event. A direct
// `supabase.auth.signOut()` call would be misclassified as internal session
// loss and skip the privacy purge.
import { supabase } from './supabase.js'

let _explicitSignOutRequested = false

export async function performExplicitSignOut(options) {
  // Set BEFORE the call so the flag exists by the time SIGNED_OUT reaches
  // the app: main.js defers every onAuthStateChange callback by one
  // macrotask (setTimeout 0), and the deferred handler consumes the flag.
  _explicitSignOutRequested = true
  return supabase.auth.signOut(options)
}

// One-shot consume by the deferred SIGNED_OUT handler. If an explicit
// signOut() threw before emitting, the flag stays set so the NEXT
// SIGNED_OUT still honors the user's intent to sign out (fails closed to
// the purge, never to data retention for a departing user).
export function consumeExplicitSignOutRequest() {
  const requested = _explicitSignOutRequested
  _explicitSignOutRequested = false
  return requested
}

export function _resetExplicitSignOutForTests() {
  _explicitSignOutRequested = false
}
