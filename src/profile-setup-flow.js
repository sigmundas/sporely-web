// Orchestrates the Profile setup completion transition. Kept in its own
// module so main.js and profile.js can share it without a DOM dependency.
//
// The order matters: the setup save persists the profile, then main.js
// (via `onCompleted`) advances auth-state to complete, navigates to Home,
// and awaits `refreshHome()`. Only when that resolves does the setup overlay
// dismiss — so the user never sees a blank/stale Home between save and
// reveal.
//
// CRITICAL FAILURE MODE: if `onCompleted` throws (Home refresh failed,
// network dropped, RLS blocked, etc.) we do NOT close the overlay. The user
// stays in setup mode and the caller propagates the failure so it can be
// surfaced and retried. Swallowing the error and closing the overlay would
// expose a blank/stale Home under the guise of "signed in".

export async function runProfileSetupCompletion(persisted, onCompleted, closeOverlay) {
  if (typeof onCompleted === 'function') {
    // Rethrows on failure — caller MUST leave setup mode intact and
    // surface a retryable error to the user.
    await onCompleted(persisted)
  }
  if (typeof closeOverlay === 'function') closeOverlay()
}

// Runs the setup "Use another account" sign-out. The caller keeps the
// overlay visible for the entire duration. Success drives the centralized
// SIGNED_OUT handler which finalizes cleanup and force-closes the overlay;
// failure re-throws so the caller can surface the error and keep setup open.
export async function runSetupSignOut(signOut) {
  if (typeof signOut === 'function') await signOut()
}
