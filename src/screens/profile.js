import { supabase } from '../supabase.js'
import { formatDate, formatTime, t } from '../i18n.js'
import { state } from '../state.js'
import { showToast } from '../toast.js'
import { fetchCloudPlanProfile, formatStorageBytes, mergeCloudPlanForOfflineFallback } from '../cloud-plan.js'
import { getLastSyncAt } from '../settings.js'
import { hideProfileOverlay, showProfileOverlay } from '../profile-overlay.js'
import { isPickerCancel, nativePickedPhotoToFile, PICKER_OPTIONS_AVATAR, pickImagesWithNativePhotoPicker } from './import-helpers.js'
import { isAndroidNativeApp } from '../camera-actions.js'
import { isProfileComplete, saveProfileEdit, saveProfileSetup } from '../profile-completion.js'
import { runProfileSetupCompletion, runSetupSignOut } from '../profile-setup-flow.js'
import { canUseAuthenticatedNetwork, requireCloudMutation, requiresReauthentication } from '../capabilities.js'
import { beginReauthentication } from '../reauth.js'
import { readLastValidatedAccount } from '../last-validated-account.js'
import { performExplicitSignOut } from '../auth-signout.js'
import {
  MEDIA_KIND,
  MEDIA_PRIVACY_SCOPE,
  readCachedMedia,
  writeCachedMedia,
} from '../media-cache.js'

// ── Init (once at boot) ───────────────────────────────────────────────────────

let _profileOpener = null
let _profilePreviousScreen = 'home'
let _profileSetupMode = false
let _profileSetupCompleted = null
let _profileSetupSignOut = null
let _profileDragStartY = 0
let _profileDragStartX = 0
let _profileDragCurrentY = 0
let _profileDragStarted = false
let _profileDragTracking = false
let _profileResetDrag = () => {}
export function initProfile() {
  // Session recovery goes through the single beginReauthentication() seam
  // (never signOut — queued observations and drafts must survive).
  document.getElementById('profile-reauth-btn')?.addEventListener('click', () => {
    const email = state.user?.email || ''
    closeProfileOverlay()
    beginReauthentication(email)
  })
  document.getElementById('profile-avatar-img').addEventListener('error', _showInitialsAvatar)
  document.getElementById('sign-out-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sign-out-btn')
    const originalLabel = btn.textContent
    btn.disabled = true
    btn.textContent = t('common.pleaseWait')
    // Force-close the overlay ignoring setup-mode guard: on manual sign-out,
    // the SIGNED_OUT handler will reset the app anyway.
    _profileSetupMode = false
    closeProfileOverlay()
    // Explicit sign-out fires SIGNED_OUT which the main.js listener uses to
    // purge user-scoped caches, reset state, and show the login form. Routed
    // through the explicit seam so the handler keeps full purge semantics.
    try { await performExplicitSignOut() } catch (e) { console.warn('Sign out error:', e) }
    btn.disabled = false
    btn.textContent = originalLabel
  })
  document.getElementById('friends-blocked-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.scope-tab[data-tab]')
    if (!btn) return
    const tab = btn.dataset.tab
    document.querySelectorAll('#friends-blocked-tabs .scope-tab').forEach(b => b.classList.toggle('active', b === btn))
    document.getElementById('friends-panel').style.display = tab === 'friends' ? '' : 'none'
    document.getElementById('blocked-panel').style.display  = tab === 'blocked'  ? '' : 'none'
    if (tab === 'blocked') _loadBlocked()
  })
  document.getElementById('delete-account-btn').addEventListener('click', _deleteAccount)
  document.getElementById('profile-save-btn').addEventListener('click', _saveProfile)
  document.getElementById('profile-username')?.addEventListener('input', _syncProfileSaveEnabled)
  document.getElementById('profile-avatar-btn').addEventListener('click', _openAvatarSourcePicker)
  document.getElementById('profile-avatar-circle').addEventListener('click', _openAvatarSourcePicker)
  document.getElementById('avatar-source-overlay').addEventListener('click', e => {
    if (e.target?.id === 'avatar-source-overlay') _closeAvatarSourcePicker()
  })
  document.getElementById('avatar-source-library').addEventListener('click', () => {
    _closeAvatarSourcePicker()
    void _openAvatarLibraryPicker()
  })
  document.getElementById('avatar-source-selfie').addEventListener('click', () => {
    _closeAvatarSourcePicker()
    _openAvatarCameraPicker()
  })
  document.getElementById('avatar-source-cancel').addEventListener('click', _closeAvatarSourcePicker)
  document.getElementById('profile-avatar-input').addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (file) void _showCrop(file)
    e.target.value = ''
  })
  document.getElementById('profile-avatar-camera-input').addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (file) void _showCrop(file)
    e.target.value = ''
  })
  document.getElementById('profile-close-btn')?.addEventListener('click', closeProfileOverlay)
  document.getElementById('profile-overlay')?.addEventListener('click', e => {
    if (e.target?.id === 'profile-overlay') closeProfileOverlay()
  })
  _initProfileDragEvents()
  _initCropEvents()

  document.getElementById('profile-tos-btn')?.addEventListener('click', () => {
    window.open('https://sporely.no/terms', '_blank')
  })

  const setupSignOutBtn = document.getElementById('profile-setup-signout-btn')
  setupSignOutBtn?.addEventListener('click', async () => {
    if (!_profileSetupMode) return
    // Keep setup visible while sign-out is in flight. If sign-out fails
    // (network/RLS/etc.) we must NOT dismiss the overlay — otherwise the
    // user is stranded on Home for an account whose setup is still incomplete.
    // A successful sign-out is finalized by the centralized SIGNED_OUT
    // handler in main.js, which calls forceCloseProfileOverlay().
    const originalLabel = setupSignOutBtn.textContent
    setupSignOutBtn.disabled = true
    setupSignOutBtn.textContent = t('common.pleaseWait')
    const handler = _profileSetupSignOut
    try {
      await runSetupSignOut(handler)
      // Success path: forceCloseProfileOverlay() (driven by the SIGNED_OUT
      // handler) clears state and dismisses. Do NOT clear
      // _profileSetupCompleted / _profileSetupSignOut here so a retry after
      // a rejected in-flight signOut still works.
    } catch (err) {
      console.error('Setup sign-out failed:', err)
      showToast(t('profile.setupSignOutFailed', { message: err?.message || String(err) }))
      setupSignOutBtn.disabled = false
      setupSignOutBtn.textContent = originalLabel
    }
  })
}

// Called from main.js `SIGNED_OUT` handler. Force-dismisses the overlay
// regardless of setup mode so no stale sheet remains after sign-out (which
// might otherwise still cover the login screen).
export function forceCloseProfileOverlay() {
  _profileSetupCompleted = null
  _profileSetupSignOut = null
  _profileSetupMode = false
  const setupSignOutBtn = document.getElementById('profile-setup-signout-btn')
  if (setupSignOutBtn) {
    setupSignOutBtn.disabled = false
    setupSignOutBtn.textContent = t('profile.setupUseAnotherAccount')
  }
  _applyProfileSetupModeUi()
  const overlay = document.getElementById('profile-overlay')
  if (overlay) {
    _profileResetDrag()
    hideProfileOverlay({ overlay, profileOpener: _profileOpener })
    _profileOpener = null
  }
}

export async function openProfileOverlay({ opener = null, setup = false, onSetupCompleted = null, onSetupSignOut = null } = {}) {
  const overlay = document.getElementById('profile-overlay')
  if (!overlay) return

  _profileOpener = opener || document.activeElement || null
  _profilePreviousScreen = state.currentScreen || 'home'
  state.currentScreen = 'profile'
  _profileSetupMode = !!setup
  _profileSetupCompleted = setup ? onSetupCompleted : null
  _profileSetupSignOut = setup ? onSetupSignOut : null
  _applyProfileSetupModeUi()

  _profileResetDrag()
  showProfileOverlay({ overlay })
  requestAnimationFrame(() => requestAnimationFrame(() => {
    overlay.classList.add('open')
  }))
  await loadProfile()
}

export function closeProfileOverlay() {
  // In setup mode the user cannot dismiss the overlay until they save.
  if (_profileSetupMode) return
  const overlay = document.getElementById('profile-overlay')
  if (!overlay) return

  _profileResetDrag()
  hideProfileOverlay({ overlay, profileOpener: _profileOpener })
  state.currentScreen = _profilePreviousScreen || 'home'
  _profileOpener = null
}

// In setup mode, disable Save until the user types a username. Outside
// setup, Save is always enabled — editing an existing profile without
// changing the username is a valid no-op save.
function _syncProfileSaveEnabled() {
  const btn = document.getElementById('profile-save-btn')
  if (!btn) return
  if (!_profileSetupMode) {
    btn.disabled = false
    return
  }
  const username = String(document.getElementById('profile-username')?.value || '').trim()
  btn.disabled = !username
}

function _applyProfileSetupModeUi() {
  const overlay = document.getElementById('profile-overlay')
  if (!overlay) return
  overlay.dataset.setup = _profileSetupMode ? 'true' : ''
  const closeBtn = document.getElementById('profile-close-btn')
  const signOutBtn = document.getElementById('sign-out-btn')
  const deleteBtn = document.getElementById('delete-account-btn')
  const setupBanner = document.getElementById('profile-setup-banner')
  const title = document.getElementById('profile-title')
  if (closeBtn) closeBtn.style.display = _profileSetupMode ? 'none' : ''
  if (signOutBtn) signOutBtn.style.display = _profileSetupMode ? 'none' : ''
  if (deleteBtn) deleteBtn.style.display = _profileSetupMode ? 'none' : ''
  if (setupBanner) {
    setupBanner.style.display = _profileSetupMode ? 'block' : 'none'
    setupBanner.textContent = t('profile.setupBanner')
  }
  const setupSignOutBtn = document.getElementById('profile-setup-signout-btn')
  if (setupSignOutBtn) {
    setupSignOutBtn.style.display = _profileSetupMode ? 'block' : 'none'
    setupSignOutBtn.textContent = t('profile.setupUseAnotherAccount')
  }
  if (title) {
    title.textContent = _profileSetupMode ? t('profile.setupTitle') : t('profile.title')
  }
  _syncProfileSaveEnabled()
}

function _initProfileDragEvents() {
  const sheet = document.getElementById('profile-sheet')
  if (!sheet || sheet.dataset.dragBound === 'true') return
  sheet.dataset.dragBound = 'true'

  function _resetProfileDrag() {
    _profileDragStartY = 0
    _profileDragStartX = 0
    _profileDragCurrentY = 0
    _profileDragStarted = false
    _profileDragTracking = false
    sheet.style.transition = ''
    sheet.style.transform = ''
  }
  _profileResetDrag = _resetProfileDrag

  function _beginProfileDrag(point, target) {
    if (target?.closest?.('button, input, select, textarea, a, label')) return
    _profileDragStartY = point.clientY
    _profileDragStartX = point.clientX
    _profileDragCurrentY = _profileDragStartY
    _profileDragStarted = false
    _profileDragTracking = true
  }

  function _moveProfileDrag(point, event) {
    if (!_profileDragTracking) return
    _profileDragCurrentY = point.clientY
    const deltaY = _profileDragCurrentY - _profileDragStartY
    const deltaX = point.clientX - _profileDragStartX

    if (!_profileDragStarted) {
      if (deltaY <= 8 || Math.abs(deltaY) <= Math.abs(deltaX)) return
      if (sheet.scrollTop > 0) {
        _resetProfileDrag()
        return
      }
      _profileDragStarted = true
      sheet.style.transition = 'none'
    }

    event?.preventDefault?.()
    sheet.style.transform = `translateY(${Math.max(0, deltaY)}px)`
  }

  function _finishProfileDrag() {
    if (!_profileDragTracking) return
    const deltaY = _profileDragCurrentY - _profileDragStartY
    const shouldClose = _profileDragStarted && deltaY > 86
    _resetProfileDrag()
    if (shouldClose) closeProfileOverlay()
  }

  sheet.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return
    _beginProfileDrag(event.touches[0], event.target)
  }, { passive: true })
  sheet.addEventListener('touchmove', event => {
    if (event.touches.length !== 1) return
    _moveProfileDrag(event.touches[0], event)
  }, { passive: false })
  sheet.addEventListener('touchend', _finishProfileDrag)
  sheet.addEventListener('touchcancel', _resetProfileDrag)
  sheet.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') return
    _beginProfileDrag(event, event.target)
  })
  sheet.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    _moveProfileDrag(event, event)
  })
  sheet.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') return
    _finishProfileDrag()
  })
  sheet.addEventListener('pointercancel', event => {
    if (event.pointerType === 'touch') return
    _resetProfileDrag()
  })
}

// ── Load (called on navigate to profile) ─────────────────────────────────────

export async function loadProfile() {
  _applyReauthBannerUi()
  // CACHED / REAUTH_REQUIRED: zero authenticated network from the Profile
  // sheet. Render the cached snapshot summary instead of firing doomed
  // PostgREST reads that leave blank fields looking like live server data.
  if (!canUseAuthenticatedNetwork()?.allowed) {
    _renderProfileFromCachedSnapshot()
    return
  }
  await Promise.all([_loadProfileData(), _loadFriends(), _loadPending()])
}

// REAUTH_REQUIRED banner + gated-field state. The banner is reauth-only
// (never shown for plain offline/CACHED — that is not a "session expired"
// condition); the identity inputs are disabled in BOTH gated states because
// a save could not be dispatched anyway.
function _applyReauthBannerUi() {
  const banner = document.getElementById('profile-reauth-banner')
  const reauth = requiresReauthentication()
  if (banner) {
    banner.style.display = reauth ? 'block' : 'none'
    if (reauth) {
      const title = document.getElementById('profile-reauth-title')
      const body = document.getElementById('profile-reauth-body')
      const btn = document.getElementById('profile-reauth-btn')
      if (title) title.textContent = t('profile.sessionExpired')
      if (body) body.textContent = t('profile.sessionExpiredBody')
      if (btn) btn.textContent = t('profile.signInAgain')
    }
  }
  const gated = !canUseAuthenticatedNetwork()?.allowed
  for (const id of ['profile-username', 'profile-fullname', 'profile-bio', 'profile-save-btn']) {
    const el = document.getElementById(id)
    if (el) el.disabled = gated
  }
  if (!gated) _syncProfileSaveEnabled()
}

// Network-free profile render for the gated states: cached snapshot summary
// (same-user only), initials avatar via the cached-media path, cached cloud
// plan. Never touches Supabase.
function _renderProfileFromCachedSnapshot() {
  const uid = state.user?.id
  if (!uid) return
  let snapshot = null
  try { snapshot = readLastValidatedAccount() } catch (_) { snapshot = null }
  const summary = (snapshot && snapshot.userId === uid) ? (snapshot.profileSummary || {}) : {}
  const email = state.user?.email || ''
  // Match the online render: only the actual username fills this field
  // (email local-part fallback), never the display name.
  const normalizedUsername = _normalizeUsername(summary.username, email)
  const usernameEl = document.getElementById('profile-username')
  const fullnameEl = document.getElementById('profile-fullname')
  if (usernameEl) usernameEl.value = normalizedUsername || ''
  if (fullnameEl) fullnameEl.value = _normalizeDisplayName(summary.display_name, email) || ''
  // Bio is not part of the persisted snapshot summary; a blank disabled
  // field is honest ("could not load") — never leave a stale prior render.
  const bioEl = document.getElementById('profile-bio')
  if (bioEl) bioEl.value = ''
  const emailEl = document.getElementById('profile-email-display')
  if (emailEl) emailEl.textContent = email
  const initialsEl = document.getElementById('profile-avatar-initials')
  if (initialsEl) initialsEl.textContent = _initials(normalizedUsername || email)
  _showInitialsAvatar()
  _renderCloudPlan(state.cloudPlan)
}

// Stage B: user-scoped avatar identity for the persistent media cache.
// The avatar mediaKey is the sentinel string `self:<userId>` (never a
// signed URL, never the storage path) so B cannot read A's blob.
function _avatarIdentity(userId) {
  const uid = String(userId || '').trim()
  if (!uid) return null
  return {
    userId: uid,
    mediaKind: MEDIA_KIND.AVATAR,
    privacyScope: MEDIA_PRIVACY_SCOPE.SELF,
    mediaKey: `self:${uid}`,
    variant: 'original',
  }
}

// Best-effort: paint cached avatar blobs asynchronously into the header
// avatar <img> targets. Never throws; a miss leaves initials untouched.
async function _paintCachedAvatarInto(targets, userId, initials) {
  const identity = _avatarIdentity(userId)
  if (!identity) return
  let cached
  try { cached = await readCachedMedia(identity) }
  catch (_) { cached = null }
  if (!cached?.blob) return
  let objectUrl
  try { objectUrl = URL.createObjectURL(cached.blob) }
  catch (_) { return }
  // Guard: the state.user may have transitioned mid-await; refuse to paint
  // over a different user's chrome.
  if (state.user?.id && state.user.id !== userId) {
    try { URL.revokeObjectURL(objectUrl) } catch (_) {}
    return
  }
  for (const [imgId, initialsId] of targets) {
    const img = document.getElementById(imgId)
    const label = document.getElementById(initialsId)
    if (!img || !label) continue
    if (label.textContent !== initials) continue // super-defensive: only paint on the current identity
    img.src = objectUrl
    img.style.display = 'block'
    label.style.display = 'none'
  }
}

// Persist an avatar blob to the media cache under `self:<userId>`. Called
// after a successful upload or after a fresh online avatar fetch.
async function _persistAvatarBlob(userId, blob) {
  const identity = _avatarIdentity(userId)
  if (!identity || !blob) return
  try { await writeCachedMedia(identity, blob) } catch (_) { /* best-effort */ }
}

// Fetch a remote avatar URL as a blob (best-effort, cross-origin-safe). Used
// to warm the cache after a successful online avatar refresh. Returns null
// on failure.
async function _fetchRemoteBlob(url) {
  if (!url) return null
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'omit' })
    if (!res?.ok) return null
    const type = String(res.headers?.get?.('content-type') || '').toLowerCase()
    if (!type.startsWith('image/')) return null
    const blob = await res.blob()
    return blob
  } catch (_) { return null }
}

// Synchronous, network-free header renderer for Stage B1's cached-authenticated
// boot path. Paints initials synchronously from the persisted profile
// summary, and asynchronously swaps in the user-scoped cached avatar blob
// (if any) via the media cache. This function NEVER touches Supabase and
// NEVER assigns an http(s) URL to `img.src` — a plain `<img src=…>` would
// issue a browser-level network request, which violates the CACHED / REAUTH
// invariant that avatar rendering fires ZERO network in those states.
// `refreshHeaderProfileButtons()` remains the authoritative online path and
// will overwrite the DOM once revalidation succeeds.
//
// The `profileSummary.avatar_url` argument is intentionally ignored for
// synchronous paint. On a fresh install with no persisted blob, initials
// are the correct rendering; a background revalidation to COMPLETE will
// warm the cache and repaint on the next launch.
export function renderCachedHeaderProfileButtons(profileSummary = {}, options = {}) {
  const emailFallback = _cleanString(options?.email) || state.user?.email || ''
  const rawUsername = _cleanString(profileSummary?.username)
  const rawDisplay = _cleanString(profileSummary?.display_name)

  const normalizedUsername = _normalizeUsername(rawUsername || rawDisplay, emailFallback)
  const initials = _initials(normalizedUsername || rawDisplay || emailFallback)

  const targets = [
    ['home-profile-img', 'home-profile-initials'],
    ['finds-profile-img', 'finds-profile-initials'],
    ['map-profile-img', 'map-profile-initials'],
    ['people-profile-img', 'people-profile-initials'],
  ]

  // Synchronous initials paint on every header target. No `img.src`
  // assignment here — a browser-level GET for the http(s) URL would
  // violate the CACHED / REAUTH "zero avatar network" invariant.
  for (const [imgId, initialsId] of targets) {
    const img = document.getElementById(imgId)
    const label = document.getElementById(initialsId)
    if (!img || !label) continue

    label.textContent = initials
    img.removeAttribute('src')
    img.style.display = 'none'
    label.style.display = ''
  }

  // Stage B FINAL: kick off an async best-effort read of the persisted
  // avatar blob for this user. On hit we replace the initials with the
  // cached image. On miss we do NOTHING — no HTTP avatar request is
  // dispatched. The user id is read from `state.user` (set by the caller
  // before invoking us on the cached boot path).
  const uid = state.user?.id || ''
  if (uid) {
    void _paintCachedAvatarInto(targets, uid, initials)
  }
}

function _cleanString(value) {
  const s = String(value || '').trim()
  return s
}

export async function refreshHeaderProfileButtons(profile = null) {
  const uid = state.user?.id
  if (!uid) return

  // Stage B FINAL invariant: CACHED / REAUTH_REQUIRED must never trigger an
  // avatar network request. If the capability gate denies authenticated
  // network use, delegate to the cache-first render (initials + async
  // persistent-media paint) and return without touching Supabase storage or
  // creating an Image() probe. Callers in the online path (main.js resolve,
  // in-place revalidation, _uploadAvatar, _saveProfile) will exclusively
  // dispatch this method under AUTHENTICATED_COMPLETE.
  if (!canUseAuthenticatedNetwork()?.allowed) {
    renderCachedHeaderProfileButtons(profile || {}, { email: state.user?.email || '' })
    return
  }

  let summary = profile
  if (!summary) {
    const { data } = await supabase
      .from('profiles')
      .select('username, display_name, avatar_url')
      .eq('id', uid)
      .single()
    summary = data || {}
  }

  const normalizedUsername = _normalizeUsername(summary?.username, state.user?.email || '')
  if (summary && typeof summary === 'object') {
    summary.username = normalizedUsername
  }
  const initials = _initials(normalizedUsername || state.user?.email || '')
  const signedAvatarUrl = await _getSignedAvatarUrl(uid, true)
  let avatarUrl = ''
  let isValid = false

  if (signedAvatarUrl && await _canLoadImage(signedAvatarUrl)) {
    avatarUrl = signedAvatarUrl
    isValid = true
  }
  if (!isValid && summary?.avatar_url) {
    avatarUrl = _withCacheBust(summary.avatar_url, true)
    isValid = await _canLoadImage(avatarUrl)
  }

  const targets = [
    ['home-profile-img', 'home-profile-initials'],
    ['finds-profile-img', 'finds-profile-initials'],
    ['map-profile-img', 'map-profile-initials'],
    ['people-profile-img', 'people-profile-initials'],
  ]

  for (const [imgId, initialsId] of targets) {
    const img = document.getElementById(imgId)
    const label = document.getElementById(initialsId)
    if (!img || !label) continue

    label.textContent = initials
    if (isValid && avatarUrl) {
      img.src = avatarUrl
      img.style.display = 'block'
      label.style.display = 'none'
    } else {
      img.style.display = 'none'
      img.removeAttribute('src')
      label.style.display = ''
    }
  }

  // Stage B: warm the persistent avatar cache in the background so the
  // next cold boot (offline or otherwise) can render this avatar without
  // any HTTP request. Best-effort; a fetch/persist failure never
  // interferes with the immediate paint above.
  if (isValid && avatarUrl && uid) {
    void (async () => {
      const blob = await _fetchRemoteBlob(avatarUrl)
      if (blob) await _persistAvatarBlob(uid, blob)
    })()
  }
}


// ── Profile data (username, full_name, avatar) ────────────────────────────────

async function _loadProfileData() {
  const uid = state.user?.id
  if (!uid) return
  const { data } = await supabase
    .from('profiles')
    .select('username, display_name, bio, avatar_url')
    .eq('id', uid)
    .single()
  // Stage B final: a FALLBACK plan (network failure default) must NEVER
  // replace a known-good CACHED/NETWORK plan; that would silently downgrade
  // an offline Pro user to Free while Settings/Profile is open. Route every
  // assignment through the merge helper.
  const nextPlan = await fetchCloudPlanProfile(uid)
  state.cloudPlan = mergeCloudPlanForOfflineFallback(state.cloudPlan, nextPlan)
  if (!data) {
    _renderCloudPlan(state.cloudPlan)
    return
  }

  const normalizedUsername = _normalizeUsername(data.username, state.user?.email || '')
  document.getElementById('profile-username').value  = normalizedUsername || ''
  document.getElementById('profile-fullname').value  = _normalizeDisplayName(data.display_name, state.user?.email || '') || ''
  _syncProfileSaveEnabled()
  document.getElementById('profile-bio').value = data.bio || ''
  document.getElementById('profile-email-display').textContent = state.user?.email || ''
  const initials = _initials(normalizedUsername || state.user?.email || '')
  document.getElementById('profile-avatar-initials').textContent = initials
  await refreshHeaderProfileButtons({ ...data, username: normalizedUsername })
  if (data.avatar_url) {
    const shown = await _setProfileAvatarSource({ uid, preferredUrl: data.avatar_url })
    if (shown) {
      _renderCloudPlan(state.cloudPlan)
      return
    }
  }
  _showInitialsAvatar()
  _renderCloudPlan(state.cloudPlan)
}

async function _saveProfile() {
  const btn = document.getElementById('profile-save-btn')
  const originalLabel = btn.textContent
  btn.disabled = true
  const rawUsername    = document.getElementById('profile-username').value
  const rawDisplayName = document.getElementById('profile-fullname').value
  const username     = _normalizeUsername(rawUsername, state.user?.email || '')
  const display_name = _normalizeDisplayName(rawDisplayName, state.user?.email || '')
  const bio = document.getElementById('profile-bio').value.trim() || null

  if (_profileSetupMode && !String(rawUsername || '').trim()) {
    btn.disabled = false
    showToast(t('profile.setupIncompleteToast'))
    return
  }

  // Stage B2b: profile save is a remote profiles.update. Local-only
  // preferences (settings-overlay) remain editable offline; this remote
  // write is gated.
  if (!requireCloudMutation({ showToast }).allowed) {
    btn.disabled = false
    return
  }

  // Setup save stamps `profile_completed_at`; ordinary edits leave it alone.
  const saver = _profileSetupMode ? saveProfileSetup : saveProfileEdit
  const { persisted, error } = await saver(supabase, state.user.id, { username, display_name, bio })

  if (error) {
    btn.disabled = false
    showToast(error.code === '23505' ? t('profile.usernameTaken') : t('common.errorPrefix', { message: error.message }))
    return
  }

  document.getElementById('profile-username').value = persisted?.username || ''

  // Setup completion: keep the save button disabled through the WHOLE
  // transition (persist → auth-state → Home refresh → dismiss). If Home
  // refresh fails, stay in setup mode and surface the error so the user can
  // retry. Never dismiss the overlay unless the completion handler succeeded.
  if (_profileSetupMode && isProfileComplete(persisted)) {
    btn.textContent = t('common.pleaseWait')
    const handler = _profileSetupCompleted
    try {
      await runProfileSetupCompletion(persisted, handler, () => {
        _profileSetupCompleted = null
        _profileSetupSignOut = null
        _profileSetupMode = false
        _applyProfileSetupModeUi()
        const overlay = document.getElementById('profile-overlay')
        if (overlay) {
          _profileResetDrag()
          hideProfileOverlay({ overlay, profileOpener: _profileOpener })
          state.currentScreen = _profilePreviousScreen || 'home'
          _profileOpener = null
        }
      })
      showToast(t('profile.saved'))
    } catch (err) {
      console.error('Profile setup completion failed:', err)
      // Stay in setup mode. Do not clear _profileSetupCompleted so a retry
      // still routes through main.js. Do not show "Profile saved".
      showToast(t('profile.setupCompletionFailed', { message: err?.message || String(err) }))
    } finally {
      btn.disabled = false
      btn.textContent = originalLabel
    }
    return
  }

  btn.disabled = false
  await refreshHeaderProfileButtons({
    username: persisted?.username,
    display_name: persisted?.display_name,
    avatar_url: persisted?.avatar_url || document.getElementById('profile-avatar-img')?.getAttribute('src') || '',
  })
  showToast(t('profile.saved'))
}


// ── Avatar crop ────────────────────────────────────────────────────────────────

const CROP_OUTPUT = 400
let _cropScale = 1, _cropX = 0, _cropY = 0
let _cropBaseScale = 1, _cropViewSize = 0
let _pointers = new Map(), _lastPinchDist = 0, _lastPinchScale = 1
let _dragStartX = 0, _dragStartY = 0, _dragStartCropX = 0, _dragStartCropY = 0
let _cropShowing = false

function _openAvatarSourcePicker() {
  document.getElementById('avatar-source-overlay').style.display = 'flex'
}

function _closeAvatarSourcePicker() {
  document.getElementById('avatar-source-overlay').style.display = 'none'
}

async function _openAvatarLibraryPicker() {
  // Android app: reuse the same system photo picker as Import Photos so users
  // get the modern one-tap picker instead of the legacy Gallery/Photos chooser
  // and its broad READ_MEDIA_IMAGES permission prompt.
  if (isAndroidNativeApp()) {
    try {
      const result = await pickImagesWithNativePhotoPicker(PICKER_OPTIONS_AVATAR)
      const photos = Array.isArray(result?.photos) ? result.photos
        : Array.isArray(result?.files) ? result.files
          : []
      if (!photos.length) return // user cancelled — silent
      const file = await nativePickedPhotoToFile(photos[0], 0, {
        captureSource: 'profile-avatar',
        screenPath: 'profile',
      })
      await _showCrop(file)
      return
    } catch (error) {
      if (isPickerCancel(error)) return
      console.warn('Native avatar picker failed, falling back to browser input:', error)
    }
  }

  // Web/PWA and non-Android natives fall back to the standard <input type=file>
  // — same predictable single-image behaviour, no plugin permission surface.
  document.getElementById('profile-avatar-input').click()
}

function _openAvatarCameraPicker() {
  document.getElementById('profile-avatar-camera-input').click()
}

async function _showCrop(file) {
  const img = document.getElementById('avatar-crop-img')
  const confirmBtn = document.getElementById('avatar-crop-confirm')
  _resetCropPreview()
  _cropShowing = true
  document.getElementById('avatar-crop-overlay').style.display = 'flex'
  confirmBtn.disabled = true
  img.style.width = img.style.height = img.style.left = img.style.top = ''

  try {
    const dataUrl = await _readFileAsDataUrl(file)
    await new Promise((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('avatar-preview-load-failed'))
      img.src = dataUrl
    })
  } catch (error) {
    console.warn('Avatar crop load failed:', error)
    _closeCropOverlay()
    showToast(t('avatar.loadFailed'))
    return
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const vp = document.getElementById('avatar-crop-viewport')
      _cropViewSize = vp.offsetWidth || Math.min(window.innerWidth * 0.92, 380)
      const { naturalWidth: nw, naturalHeight: nh } = img
      _cropBaseScale = _cropViewSize / Math.min(nw, nh)
      _cropScale = 1
      _cropX = 0
      _cropY = 0
      _applyCrop()
      confirmBtn.disabled = false
    })
  })
}

function _applyCrop() {
  const img = document.getElementById('avatar-crop-img')
  const { naturalWidth: nw, naturalHeight: nh } = img
  const eff = _cropBaseScale * _cropScale
  const dw = nw * eff, dh = nh * eff
  const vs = _cropViewSize
  const maxX = Math.max(0, dw / 2 - vs / 2)
  const maxY = Math.max(0, dh / 2 - vs / 2)
  _cropX = Math.max(-maxX, Math.min(maxX, _cropX))
  _cropY = Math.max(-maxY, Math.min(maxY, _cropY))
  img.style.width  = dw + 'px'
  img.style.height = dh + 'px'
  img.style.left   = (vs / 2 + _cropX - dw / 2) + 'px'
  img.style.top    = (vs / 2 + _cropY - dh / 2) + 'px'
}

function _initCropEvents() {
  const vp = document.getElementById('avatar-crop-viewport')

  vp.addEventListener('pointerdown', e => {
    e.preventDefault()
    vp.setPointerCapture(e.pointerId)
    _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (_pointers.size === 1) {
      _dragStartX = e.clientX; _dragStartY = e.clientY
      _dragStartCropX = _cropX; _dragStartCropY = _cropY
    }
    if (_pointers.size === 2) {
      const pts = [..._pointers.values()]
      _lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      _lastPinchScale = _cropScale
    }
  })

  vp.addEventListener('pointermove', e => {
    if (!_pointers.has(e.pointerId)) return
    _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [..._pointers.values()]
    if (pts.length === 1) {
      _cropX = _dragStartCropX + (e.clientX - _dragStartX)
      _cropY = _dragStartCropY + (e.clientY - _dragStartY)
    } else if (pts.length === 2) {
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      _cropScale = Math.max(1, _lastPinchScale * (dist / _lastPinchDist))
    }
    _applyCrop()
  })

  const _end = e => { _pointers.delete(e.pointerId) }
  vp.addEventListener('pointerup', _end)
  vp.addEventListener('pointercancel', _end)

  // Mouse wheel zoom
  vp.addEventListener('wheel', e => {
    e.preventDefault()
    _cropScale = Math.max(1, _cropScale * (e.deltaY < 0 ? 1.1 : 0.91))
    _applyCrop()
  }, { passive: false })

  document.getElementById('avatar-crop-overlay').addEventListener('click', e => {
    if (e.target?.id === 'avatar-crop-overlay') _closeCropOverlay()
  })

  document.getElementById('avatar-crop-cancel').addEventListener('click', _closeCropOverlay)
  document.getElementById('avatar-crop-confirm').addEventListener('click', () => { void _confirmCrop() })
}

async function _confirmCrop() {
  const domImg = document.getElementById('avatar-crop-img')
  const confirmBtn = document.getElementById('avatar-crop-confirm')
  if (!_cropShowing || !domImg.naturalWidth || !domImg.naturalHeight) {
    showToast(t('avatar.loadFailed'))
    return
  }

  confirmBtn.disabled = true
  const { naturalWidth: nw, naturalHeight: nh } = domImg
  const eff = _cropBaseScale * _cropScale
  const vs  = _cropViewSize
  const dw  = nw * eff, dh = nh * eff
  const imgLeft = vs / 2 + _cropX - dw / 2
  const imgTop  = vs / 2 + _cropY - dh / 2
  const sx = -imgLeft / eff
  const sy = -imgTop  / eff
  const sw = vs / eff
  const sh = vs / eff

  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CROP_OUTPUT
  canvas.getContext('2d').drawImage(domImg, sx, sy, sw, sh, 0, 0, CROP_OUTPUT, CROP_OUTPUT)

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  const profileImg = document.getElementById('profile-avatar-img')
  profileImg.src = dataUrl
  profileImg.style.display = 'block'
  document.getElementById('profile-avatar-initials').style.display = 'none'

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  _closeCropOverlay()
  if (!blob) {
    confirmBtn.disabled = false
    showToast(t('avatar.loadFailed'))
    return
  }

  await _uploadAvatar(blob)
  confirmBtn.disabled = false
}

async function _uploadAvatar(blob) {
  // Stage B2b: avatar upload is a cloud storage write + profiles.update.
  // Gate before any network dispatch — the local preview will be reverted
  // on the next profile refresh in cached mode.
  if (!requireCloudMutation({ showToast }).allowed) return
  const uid  = state.user.id
  const path = `${uid}/avatar.jpg`
  const { error: upErr } = await supabase.storage
    .from('avatars')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true })
  if (upErr) { showToast(t('profile.uploadFailed', { message: upErr.message })); return }
  const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)
  const { error: dbErr } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', uid)
  if (dbErr) { showToast(t('common.errorPrefix', { message: dbErr.message })); return }
  await _setProfileAvatarSource({
    uid,
    preferredUrl: publicUrl,
    cacheBust: true,
    keepCurrentOnFailure: true,
  })
  await refreshHeaderProfileButtons({
    username: _normalizeUsername(document.getElementById('profile-username')?.value, state.user?.email || ''),
    avatar_url: publicUrl,
  })
  // Stage B: seed the persistent avatar cache directly from the uploaded
  // blob so we never depend on refetching the freshly-uploaded remote URL
  // for the next launch's warm paint.
  void _persistAvatarBlob(uid, blob)
  showToast(t('profile.photoUpdated'))
}

function _initials(str) {
  return str.split(/[\s@.]/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?'
}

function _normalizeUsername(value, fallbackEmail = '') {
  const raw = String(value || '').trim().replace(/^@+/, '')
  if (raw) {
    const [localPart] = raw.split('@')
    return localPart.trim() || null
  }
  const email = String(fallbackEmail || state.user?.email || '').trim()
  if (!email) return null
  const [localPart] = email.split('@')
  return localPart.trim() || null
}

function _normalizeDisplayName(value, fallbackEmail = '') {
  const raw = String(value || '').trim()
  if (raw) {
    const [localPart] = raw.split('@')
    return localPart.trim() || null
  }
  const email = String(fallbackEmail || state.user?.email || '').trim()
  if (!email) return null
  const [localPart] = email.split('@')
  return localPart.trim() || null
}

function _showInitialsAvatar() {
  const img = document.getElementById('profile-avatar-img')
  img.style.display = 'none'
  img.removeAttribute('src')
  document.getElementById('profile-avatar-initials').style.display = ''
}

function _closeCropOverlay() {
  _cropShowing = false
  document.getElementById('avatar-crop-overlay').style.display = 'none'
  document.getElementById('avatar-crop-confirm').disabled = false
  _resetCropPreview()
}

function _resetCropPreview() {
  const img = document.getElementById('avatar-crop-img')
  img.onload = null
  img.onerror = null
  img.removeAttribute('src')
  img.style.width = ''
  img.style.height = ''
  img.style.left = ''
  img.style.top = ''
  _cropScale = 1
  _cropX = 0
  _cropY = 0
  _cropBaseScale = 1
  _cropViewSize = 0
  _pointers.clear()
}

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('avatar-file-read-failed'))
    reader.readAsDataURL(file)
  })
}

async function _setProfileAvatarSource({ uid, preferredUrl = '', cacheBust = false, keepCurrentOnFailure = false }) {
  const img = document.getElementById('profile-avatar-img')
  const currentSrc = img.getAttribute('src') || ''
  const candidates = []

  const addCandidate = url => {
    if (url && !candidates.includes(url)) candidates.push(url)
  }

  addCandidate(await _getSignedAvatarUrl(uid, cacheBust))
  addCandidate(_withCacheBust(preferredUrl, cacheBust))

  for (const candidate of candidates) {
    if (await _canLoadImage(candidate)) {
      img.src = candidate
      img.style.display = 'block'
      document.getElementById('profile-avatar-initials').style.display = 'none'
      return true
    }
  }

  if (keepCurrentOnFailure && currentSrc) {
    img.src = currentSrc
    img.style.display = 'block'
    document.getElementById('profile-avatar-initials').style.display = 'none'
    return false
  }

  return false
}

async function _getSignedAvatarUrl(uid, cacheBust) {
  const { data, error } = await supabase.storage
    .from('avatars')
    .createSignedUrl(`${uid}/avatar.jpg`, 60 * 60)

  if (error || !data?.signedUrl) return ''
  return _withCacheBust(data.signedUrl, cacheBust)
}

function _canLoadImage(url) {
  return new Promise(resolve => {
    if (!url) { resolve(false); return }
    const probe = new Image()
    probe.onload = () => resolve(true)
    probe.onerror = () => resolve(false)
    probe.src = url
  })
}

function _withCacheBust(url, enabled) {
  if (!url) return ''
  if (!enabled) return url
  return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
}

function _renderCloudPlan(cloudPlan) {
  const normalized = cloudPlan || state.cloudPlan || {
    cloudPlan: 'free',
    fullResStorageEnabled: false,
    storageQuotaBytes: null,
    storageUsedBytes: 0,
    uploadMode: 'reduced',
  }
  const isProAccount =
    normalized.hasProAccess === true ||
    normalized.cloudPlan === 'pro' ||
    normalized.qualityProfile === 'high'

  const uploadEl = document.getElementById('profile-cloud-upload-mode')
  const usageEl = document.getElementById('profile-cloud-usage')
  const storageEl = document.getElementById('profile-storage-usage')
  const imageCountEl = document.getElementById('profile-image-count')
  const noteEl = document.getElementById('profile-cloud-plan-note')

  if (uploadEl) {
    uploadEl.textContent = t(isProAccount ? 'profile.imageResolutionPro' : 'profile.imageResolutionDefault')
  }
  if (usageEl) {
    usageEl.textContent = _formatSyncHistory(getLastSyncAt())
  }
  if (storageEl) {
    if (normalized.storageQuotaBytes) {
      storageEl.textContent = t('profile.storageUsedOfQuota', {
        used: formatStorageBytes(normalized.storageUsedBytes),
        total: formatStorageBytes(normalized.storageQuotaBytes),
      })
    } else {
      storageEl.textContent = t('profile.storageUsedOnly', {
        used: formatStorageBytes(normalized.storageUsedBytes),
      })
    }
  }
  if (imageCountEl) {
    imageCountEl.textContent = t(
      normalized.imageCount === 1 ? 'profile.imageCountValue.one' : 'profile.imageCountValue.other',
      { count: normalized.imageCount || 0 },
    )
  }
  if (noteEl) {
    noteEl.textContent = t('profile.cloudPlanInfo')
    noteEl.style.display = 'block'
  }
}

function _formatSyncHistory(date) {
  if (!date) return t('profile.syncNever')
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  const time = formatTime(date, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (sameDay) return t('profile.syncTodayAt', { time })
  return t('profile.syncAt', {
    date: formatDate(date, { day: 'numeric', month: 'short' }),
    time,
  })
}

// ── Friends list ──────────────────────────────────────────────────────────────

async function _loadFriends() {
  const uid = state.user?.id
  if (!uid) return

  const { data: friendships } = await supabase
    .from('friendships')
    .select('id, requester_id, addressee_id')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`)

  const list = document.getElementById('friends-list')

  if (!friendships?.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:13px">${t('profile.noFriends')}</div>`
    return
  }

  const friendIds = friendships.map(f => f.requester_id === uid ? f.addressee_id : f.requester_id)
  const { data: profiles } = await supabase
    .from('public_profiles').select('id, username, display_name').in('id', friendIds)

  list.innerHTML = (profiles || []).map(p => {
    const label = p.username ? `@${p.username}` : (p.display_name || p.id)
    const initial = label.replace('@', '')[0]?.toUpperCase() || '?'
    return `<div class="friend-row">
      <div class="friend-avatar">${initial}</div>
      <div class="friend-email">${_esc(label)}</div>
      <button class="friend-remove-btn" data-id="${p.id}">${t('profile.remove')}</button>
    </div>`
  }).join('')

  list.querySelectorAll('.friend-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => _removeFriend(btn.dataset.id))
  })
}

// ── Pending requests ──────────────────────────────────────────────────────────

async function _loadPending() {
  const uid = state.user?.id
  if (!uid) return

  const { data: pending } = await supabase
    .from('friendships')
    .select('id, requester_id')
    .eq('addressee_id', uid)
    .eq('status', 'pending')

  const section = document.getElementById('pending-section')
  const list    = document.getElementById('pending-list')

  if (!pending?.length) { section.style.display = 'none'; return }
  section.style.display = 'block'

  const { data: profiles } = await supabase
    .from('public_profiles').select('id, username, display_name').in('id', pending.map(p => p.requester_id))
  const pm = Object.fromEntries((profiles || []).map(p => [p.id, p]))

  list.innerHTML = pending.map(req => {
    const p = pm[req.requester_id]
    const label = p?.username ? `@${p.username}` : (p?.display_name || req.requester_id)
    return `<div class="friend-row">
      <div class="friend-avatar">${label.replace('@', '')[0]?.toUpperCase() || '?'}</div>
      <div class="friend-email">${_esc(label)}</div>
      <button class="btn-primary friend-accept-btn" data-id="${req.id}" style="padding:5px 10px;font-size:12px;flex-shrink:0">${t('profile.accept')}</button>
      <button class="friend-decline-btn" data-id="${req.id}" style="font-size:12px;padding:5px 10px;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text-dim);cursor:pointer;flex-shrink:0">${t('profile.decline')}</button>
    </div>`
  }).join('')

  list.querySelectorAll('.friend-accept-btn').forEach(b =>
    b.addEventListener('click', () => _acceptRequest(b.dataset.id)))
  list.querySelectorAll('.friend-decline-btn').forEach(b =>
    b.addEventListener('click', () => _declineRequest(b.dataset.id)))
}

async function _acceptRequest(friendshipId) {
  // Stage B2b: gate authenticated mutations. In CACHED / REAUTH_REQUIRED
  // there is no live session — dispatching the update would either fail
  // (offline) or return a real 401 (reauth). Show the standard toast and
  // leave the pending request card visible so the user can retry on
  // reconnect.
  if (!requireCloudMutation({ showToast }).allowed) return
  const { error } = await supabase
    .from('friendships').update({ status: 'accepted' }).eq('id', friendshipId)
  if (error) { showToast(t('common.errorPrefix', { message: error.message })); return }
  showToast(t('profile.friendAccepted'))
  loadProfile()
}

async function _declineRequest(friendshipId) {
  if (!requireCloudMutation({ showToast }).allowed) return
  await supabase.from('friendships').delete().eq('id', friendshipId)
  loadProfile()
}

async function _removeFriend(friendUserId) {
  if (!requireCloudMutation({ showToast }).allowed) return
  const uid = state.user.id
  await supabase.from('friendships').delete()
    .or(`and(requester_id.eq.${uid},addressee_id.eq.${friendUserId}),and(requester_id.eq.${friendUserId},addressee_id.eq.${uid})`)
  showToast(t('profile.friendRemoved'))
  loadProfile()
}

// ── Blocked users list ────────────────────────────────────────────────────────

async function _loadBlocked() {
  const uid = state.user?.id
  if (!uid) return

  const list = document.getElementById('blocked-list')

  const { data: rows, error } = await supabase.rpc('get_blocked_user_profiles')

  if (error) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:13px">${_esc(error.message)}</div>`
    return
  }

  if (!rows?.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:13px">${t('profile.noBlockedUsers')}</div>`
    return
  }

  list.innerHTML = rows.map(_blockedUserRowHtml).join('')

  list.querySelectorAll('.friend-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => _unblockUser(btn.dataset.id))
  })
}

function _blockedUserRowHtml(row) {
  const label = row.username ? `@${row.username}` : (row.display_name || t('common.unknown'))
  const initial = label.replace('@', '')[0]?.toUpperCase() || '?'
  const avatarHtml = row.avatar_url
    ? `<img src="${_esc(row.avatar_url)}" alt="" class="friend-avatar" style="object-fit:cover;border-radius:50%">`
    : `<div class="friend-avatar">${_esc(initial)}</div>`
  return `<div class="friend-row">
    ${avatarHtml}
    <div class="friend-email">${_esc(label)}</div>
    <button class="friend-remove-btn" data-id="${_esc(row.blocked_id)}">${t('profile.unblock')}</button>
  </div>`
}

export function blockedUserRowHtmlForTests(row) {
  return _blockedUserRowHtml(row)
}

async function _unblockUser(blockedId) {
  if (!requireCloudMutation({ showToast }).allowed) return
  const uid = state.user?.id
  if (!uid) return
  const { error } = await supabase
    .from('user_blocks')
    .delete()
    .eq('blocker_id', uid)
    .eq('blocked_id', blockedId)
  if (error) { showToast(t('common.errorPrefix', { message: error.message })); return }
  showToast(t('profile.unblocked'))
  _loadBlocked()
}

async function _deleteAccount() {
  const email = state.user?.email || 'this account'
  const confirmed = await _confirmDeleteAccount(email)
  if (!confirmed) return

  // Stage B2b: account deletion is an Edge Function call — requires a live
  // session. Refuse before invocation in CACHED/REAUTH_REQUIRED.
  if (!requireCloudMutation({ showToast }).allowed) return

  const btn = document.getElementById('delete-account-btn')
  btn.disabled = true
  const originalLabel = btn.textContent
  btn.textContent = t('profile.deleting')

  const { error } = await supabase.functions.invoke('delete-account', {
    body: {},
  })

  if (error) {
    btn.disabled = false
    btn.textContent = originalLabel
    // Diagnostic log for devs: dump the full supabase-js error so its
    // `context.res` / status / stage payload is available in devtools.
    // User-facing message deliberately stays generic — we never leak
    // stage names, storage paths, or ids.
    console.error('[delete-account] request failed', error)
    // "Failed to send a request to the Edge Function" from supabase-js
    // means the fetch itself never reached the function — offline, CORS
    // block, or the function URL 404s. Anything else is a structured
    // failure returned by the deployed function.
    if (String(error.message || '').toLowerCase().includes('failed to send')) {
      showToast(t('profile.deleteUnavailable'))
    } else {
      showToast(t('profile.deleteFailed', { message: error.message }))
    }
    return
  }

  // SIGNED_OUT handler in main.js performs the cache purge + UI reset.
  try { await performExplicitSignOut() } catch (e) { console.warn('Sign out error:', e) }
  btn.disabled = false
  btn.textContent = originalLabel
  showToast(t('profile.accountDeleted'))
}

// In-app replacement for window.confirm. Returns a promise that resolves to
// true only if the user pressed the destructive confirm button. Keeps the
// modal above #profile-overlay via its own z-index (1700).
function _confirmDeleteAccount(email) {
  return new Promise(resolve => {
    const overlay = document.getElementById('delete-account-overlay')
    const messageEl = document.getElementById('delete-account-message')
    const cancelBtn = document.getElementById('delete-account-cancel')
    const confirmBtn = document.getElementById('delete-account-confirm')
    if (!overlay || !confirmBtn || !cancelBtn) {
      // Fallback for environments where the markup is missing — better to
      // block deletion than to silently proceed without confirmation.
      resolve(false)
      return
    }

    if (messageEl) messageEl.textContent = t('profile.deleteConfirm', { email })
    cancelBtn.textContent = t('profile.deleteCancel')
    confirmBtn.textContent = t('profile.deleteConfirmButton')

    // Replace nodes so previous handlers do not stack across repeated opens.
    const freshCancel = cancelBtn.cloneNode(true)
    const freshConfirm = confirmBtn.cloneNode(true)
    cancelBtn.parentNode.replaceChild(freshCancel, cancelBtn)
    confirmBtn.parentNode.replaceChild(freshConfirm, confirmBtn)

    const onKey = e => { if (e.key === 'Escape') dismiss(false) }
    const onBackdrop = e => { if (e.target === overlay) dismiss(false) }

    function dismiss(result) {
      overlay.style.display = 'none'
      overlay.removeEventListener('click', onBackdrop)
      document.removeEventListener('keydown', onKey)
      resolve(result)
    }

    freshCancel.addEventListener('click', () => dismiss(false))
    freshConfirm.addEventListener('click', () => dismiss(true))
    overlay.addEventListener('click', onBackdrop)
    document.addEventListener('keydown', onKey)

    overlay.style.display = 'flex'
  })
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
