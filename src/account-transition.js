// Account-transition boundary. Owns two concerns:
//
//   1. A monotonically-increasing generation token so late async results
//      from account A cannot mutate DOM after account B has authenticated.
//      Consumers capture a token before starting work and verify it hasn't
//      moved before writing to the DOM.
//
//   2. A single opaque blocking overlay (`#account-transition-overlay`) that
//      the auth resolution keeps visible from "sign-in succeeded" through
//      "destination screen is populated for the new user". Prevents any
//      frame in which account A's Home is visible after B has authenticated.
//
// This module intentionally has NO Supabase or router dependency so it can
// be unit-tested in Node.

let _generation = 0

export function beginAccountTransition() {
  _generation += 1
  return _generation
}

export function currentAccountGeneration() {
  return _generation
}

// Consumers should CHECK this before every DOM write after an await.
// Verifies both the generation and the current expected userId. If either
// differs the caller must discard its result and NOT touch the DOM.
export function isCurrentAccountTransition(generation, expectedUserId, actualUserId) {
  if (generation !== _generation) return false
  if (expectedUserId && expectedUserId !== actualUserId) return false
  return true
}

// Called from a fresh sign-in / account switch. Synchronously blanks
// user-scoped rendered content so the browser cannot paint account A's DOM
// after we've started resolving account B. Does NOT remove event listeners
// and does NOT re-init screens — this is a data reset, not a structural one.
//
// The list is intentionally exhaustive: every place we render a user's
// name/avatar/counts/entries in the current app. If a new user-scoped
// surface is added, it must be added here too.
const CLEARED_TEXT_IDS = [
  'home-username', 'home-user-full-name',
  'home-total-finds', 'home-species-count',
  // Stage B2a fix: the actual Home containers/stat values. The previous
  // entries ('home-recent-finds' etc.) did not match any DOM id, so cached
  // Home content would have survived an A→B transition once Home began
  // rendering persisted models.
  'recent-finds-list', 'recent-comments-list', 'home-friend-requests-list',
  'hstat-obs', 'hstat-sp', 'hstat-spores',
  'home-cloud-plan-summary',
  'finds-list', 'finds-species-list', 'finds-empty-state',
  'find-detail-title', 'find-detail-subtitle', 'find-detail-comments-list',
  'people-list',
  'profile-username', 'profile-fullname', 'profile-bio',
  'profile-email-display',
  'profile-cloud-upload-mode', 'profile-cloud-usage',
  'profile-storage-usage', 'profile-image-count',
  'friends-list', 'pending-list',
  'settings-inat-status', 'profile-inat-status',
]

const CLEARED_HTML_IDS = [
  'recent-finds-list', 'recent-comments-list', 'home-friend-requests-list',
  'finds-list', 'friends-list', 'pending-list', 'people-list',
  'find-detail-comments-list',
]

const AVATAR_IMG_IDS = [
  'home-profile-img', 'finds-profile-img', 'map-profile-img', 'people-profile-img',
  'profile-avatar-img',
]

const AVATAR_INITIALS_IDS = [
  'home-profile-initials', 'finds-profile-initials', 'map-profile-initials', 'people-profile-initials',
  'profile-avatar-initials',
]

export function clearUserScopedUi(doc = _defaultDoc()) {
  if (!doc) return
  for (const id of CLEARED_HTML_IDS) {
    const el = doc.getElementById?.(id)
    if (el) el.innerHTML = ''
  }
  for (const id of CLEARED_TEXT_IDS) {
    const el = doc.getElementById?.(id)
    if (!el) continue
    // Inputs keep the shape but drop the value; label-like nodes drop text.
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      el.value = ''
    } else {
      el.textContent = ''
    }
  }
  for (const id of AVATAR_IMG_IDS) {
    const el = doc.getElementById?.(id)
    if (!el) continue
    el.removeAttribute?.('src')
    if (el.style) el.style.display = 'none'
  }
  for (const id of AVATAR_INITIALS_IDS) {
    const el = doc.getElementById?.(id)
    if (!el) continue
    el.textContent = ''
    if (el.style) el.style.display = ''
  }
}

// Opaque blocking overlay. Kept in DOM so it also survives across module
// reloads. Prevents interaction with any underlying screen while we resolve.
export function showAccountTransitionBlocker(doc = _defaultDoc()) {
  const el = doc?.getElementById?.('account-transition-overlay')
  if (el && el.style) el.style.display = 'flex'
}

export function hideAccountTransitionBlocker(doc = _defaultDoc()) {
  const el = doc?.getElementById?.('account-transition-overlay')
  if (el && el.style) el.style.display = 'none'
}

export function _resetForTests() {
  _generation = 0
}

function _defaultDoc() {
  try { return globalThis.document || null } catch { return null }
}

// Ids exported for tests to assert the exhaustive list without pulling in
// index.html.
export const _CLEARED_TEXT_IDS = CLEARED_TEXT_IDS
export const _CLEARED_HTML_IDS = CLEARED_HTML_IDS
export const _AVATAR_IMG_IDS = AVATAR_IMG_IDS
export const _AVATAR_INITIALS_IDS = AVATAR_INITIALS_IDS
