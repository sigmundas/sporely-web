import './style.css'
import './theme.js'   // applies saved theme immediately, no flash

// Startup instrumentation is imported as early as possible so `mark(...)`
// calls throughout boot can anchor to the module-load timestamp. The module
// itself performs no I/O.
import { mark as _bootMark, measure as _bootMeasure } from './boot-timings.js'
_bootMark('js-init-start')

import { supabase, SUPABASE_ORIGIN } from './supabase.js'
import { isExplicitAuthRejection, isTransportSessionError, probeBackendReachability } from './auth-classification.js'
import { getLocale, initI18n, onLocaleChange, setLocale, t } from './i18n.js'
import { state } from './state.js'
import { clearSharedAuthSessionCache, getSharedAuthSession, seedSharedAuthSession } from './auth-session.js'
import { recordClientActivity, shouldRecordOnVisibility } from './client-activity.js'

function _fireClientActivity() {
  recordClientActivity(supabase).catch(err => {
    console.warn('record_client_activity failed:', err?.message || err)
  })
}
import { navigate } from './router.js'
import { applyTheme } from './theme.js'
import { showToast } from './toast.js'
import {
  clearPasswordRecoveryHint,
  getInitialAuthState,
  hasPasswordRecoveryHint,
  initAuth,
  maybeHandleSupabaseOAuthCallback,
  showAuthError,
  showAuthOverlay,
  hideAuthOverlay,
  handleUrlHashError,
  switchToLogin,
  switchToResetPassword,
} from './screens/auth.js'
import { initHome, refreshHome, refreshHomeSafe, renderHomeFromCache, resetHomeSectionTracking } from './screens/home.js'
import { clearAllHomeCaches, clearHomeCache } from './home-cache.js'
import { initFinds, loadFinds, requestFindsRefresh } from './screens/finds.js'
import { initCapture } from './screens/capture.js'
import { buildReviewGrid, initReview, restoreReviewDraft } from './screens/review.js'
import { initFindDetail } from './screens/find_detail.js'
import { initPhotoViewer } from './photo-viewer.js'
import { initImportReview, openNativeCamera, renderSessions, restoreImportSessions } from './screens/import_review.js'
import { clearImportSessions, clearImportSessionsStrict, loadImportSessions } from './import-store.js'
import { clearReviewDraftStrict, loadReviewDraft } from './review-draft-store.js'
import { forceCloseProfileOverlay, initProfile, loadProfile, openProfileOverlay, refreshHeaderProfileButtons, renderCachedHeaderProfileButtons } from './screens/profile.js'
import { AUTH_STATE, getAuthState, setAuthState } from './auth-state.js'
import { fetchProfileWithSignupRetry, isProfileComplete } from './profile-completion.js'
import { clearLocalDataOwner, getLocalDataOwner, resolveLocalDataOwner, setLocalDataOwner } from './local-data-owner.js'
import {
  clearLastValidatedAccount,
  readLastValidatedAccount,
  updateLastValidatedCloudPlan,
  writeLastValidatedAccount,
} from './last-validated-account.js'
import {
  beginAccountTransition,
  clearUserScopedUi,
  currentAccountGeneration,
  hideAccountTransitionBlocker,
  isCurrentAccountTransition,
  showAccountTransitionBlocker,
} from './account-transition.js'
import { initPeople, loadPeople } from './screens/people.js'
import { initAiCropEditor } from './ai-crop-editor.js'
import { loadMapScreen } from './map-loader.js'
import {
  CLOUD_PLAN_SOURCE,
  fetchCloudPlanProfile,
  getCloudPlanSource,
  reviveCachedCloudPlan,
} from './cloud-plan.js'
import { clearMediaUrlCache } from './images.js'
import { notifyProtectedMediaSessionChange } from './protected-media.js'
import { initDebugDashboard } from './debug-dashboard.js'
import { hideSettingsOverlay, showSettingsOverlay } from './settings-overlay.js'
import { isWebInatOAuthConfigured } from './inaturalist.js'
import { installIrisShutterDebugControls } from './iris-shutter.js'
import {
  connectInaturalist,
  forgetInaturalistSession,
  loadInaturalistSession,
  maybeHandleInaturalistOAuthReturn,
} from './inaturalist.js'
import { syncIdentifyButtonLabels } from './identify.js'
import { SYNC_SUCCESS_EVENT } from './sync-queue.js'
import {
  getArtsorakelMaxEdge,
  getDefaultVisibility,
  getPhotoIdMode,
  setPhotoIdMode,
  getPhotoGapMinutes,
  setArtsorakelMaxEdge,
  setDefaultVisibility,
  setLastSyncAt,
  setPhotoGapMinutes,
  getUseSystemCamera,
  setUseSystemCamera,
} from './settings.js'
import { initCameraFallbackWarning, openPreferredCamera, setNativeCameraOpener, getEffectiveCameraLabel, isAndroidNativeApp } from './camera-actions.js'
import { getPlatform, isAndroidApp } from './platform.js'
import { registerNativeAuthLinkListener } from './native-auth-links.js'

initI18n()
setNativeCameraOpener(openNativeCamera)
if (import.meta.env.DEV) installIrisShutterDebugControls()

let _syncFeedbackBound = false
let _appBootstrapped = false
let _authStateSubscription = null

// Stage B2a: on the ONLINE boot path the cached Home render is sequenced
// before the single network refresh, so the cache read gets a tight budget —
// a healthy IndexedDB read is single-digit milliseconds; anything slower
// forfeits the cached paint rather than delaying fresh data. Offline boots
// use the home-cache default (4 s) since the cache is the only content.
const HOME_CACHE_ONLINE_BOOT_BUDGET_MS = 300

// ── Deferred auth event pipeline ─────────────────────────────────────────────
//
// supabase-js holds an internal auth lock while dispatching onAuthStateChange
// events. Awaiting Supabase API calls (exchangeCodeForSession, PostgREST
// queries, RPCs, signOut, getSession, ...) inside the direct listener
// deadlocks the lock: SIGNED_IN never returns, and the next auth call hangs
// forever. Fix: the direct listener MUST return synchronously without
// touching Supabase. All processing is deferred one macrotask later and
// serialized through a single promise chain so one bad event cannot
// permanently poison the queue.
let _authEventQueue = Promise.resolve()
// One in-flight resolution per user id. Prevents double-loads when the
// direct callback path (exchangeCodeForSession / signInWithPassword result)
// and the deferred SIGNED_IN event both observe the same session.
const _resolutionInFlight = new Map() // userId -> Promise
const _resolvedUsers = new Set()       // userId (completed at least once)

function _authLog(phase, extra = {}) {
  // Safe, credential-free structured phase log. Only booleans, status codes
  // and anonymized labels — never tokens/emails/codes/URLs.
  try { console.info(`[auth] ${phase}`, extra) } catch (_) {}
}

function _safeErrorCode(err) {
  if (!err) return 'unknown'
  if (typeof err === 'string') return err.slice(0, 64)
  return err?.code || err?.name || err?.status || 'error'
}

function enqueueAuthEvent(event, session, deferred) {
  _authEventQueue = _authEventQueue
    .then(() => deferred(event, session))
    .catch(err => {
      _authLog('deferred_auth_event_failed', { code: _safeErrorCode(err) })
    })
}

// Stage B1: persistent Offline indicator. Hidden by default; shown while in
// AUTHENTICATED_CACHED mode. Reveal timing matches the app-shell's — do not
// paint the indicator until reveal, otherwise the boot flash briefly shows
// the badge on top of the auth overlay.
function _setOfflineIndicator(visible) {
  try {
    const el = document.getElementById('app-offline-indicator')
    if (!el) return
    el.style.display = visible ? 'flex' : 'none'
  } catch (_) { /* DOM missing in test envs */ }
}

// Auth-classifier + reachability probe live in `auth-classification.js` so
// they can be imported into unit tests without pulling the whole DOM/CSS
// module graph. `_isExplicitAuthRejection` / `_isTransportSessionError`
// wrappers keep the existing local names used in this file.
function _isExplicitAuthRejection(err) { return isExplicitAuthRejection(err) }
function _isTransportSessionError(err) { return isTransportSessionError(err) }

function _lockPortraitOrientation() {
  const lock = globalThis.screen?.orientation?.lock
  if (typeof lock !== 'function') return
  lock.call(globalThis.screen.orientation, 'portrait').catch(() => {})
}

function initSyncFeedback() {
  if (_syncFeedbackBound) return
  _syncFeedbackBound = true

  window.addEventListener(SYNC_SUCCESS_EVENT, event => {
    const imageCount = Number(event?.detail?.imageCount || 0)
    setLastSyncAt()
    showToast(t('review.uploadedComplete', { count: imageCount }))

    if (state.currentScreen === 'finds') requestFindsRefresh()
    if (state.currentScreen === 'home') void refreshHome()
    if (state.currentScreen === 'profile') void loadProfile()
  })
}

// ── Settings panel ────────────────────────────────────────────────────────────
function initSettings() {
  const overlay = document.getElementById('settings-overlay')
  const sheet = document.getElementById('settings-sheet')
  const settingsBtn = document.getElementById('settings-btn')
  let settingsOpener = null
  let dragStartY = 0
  let dragStartX = 0
  let dragCurrentY = 0
  let dragStarted = false
  let dragTracking = false

  function _blurActiveControl() {
    const active = document.activeElement
    if (active && /^(INPUT|SELECT|TEXTAREA)$/i.test(active.tagName) && typeof active.blur === 'function') {
      active.blur()
    }
  }

  async function _refreshSettingsCloudPlan() {
    const uid = state.user?.id
    if (!uid) return
    state.cloudPlan = await fetchCloudPlanProfile(uid)
    _syncSettingsUI()
  }

  function _openSettings(event) {
    event?.preventDefault()
    settingsOpener = event?.currentTarget || document.activeElement || settingsBtn
    _blurActiveControl()
    _syncSettingsUI()
    showSettingsOverlay({ overlay })
    requestAnimationFrame(() => requestAnimationFrame(() => {
      overlay.classList.add('open')
      _blurActiveControl()
    }))
    _syncInaturalistUi() // Sync iNaturalist UI when settings are opened
    void _refreshSettingsCloudPlan()
  }

  function _closeSettings() {
    sheet.style.transition = ''
    sheet.style.transform = ''
    hideSettingsOverlay({ overlay, settingsOpener })
  }

  function _resetSettingsDrag() {
    dragStartY = 0
    dragStartX = 0
    dragCurrentY = 0
    dragStarted = false
    dragTracking = false
    sheet.style.transition = ''
    sheet.style.transform = ''
  }

  function _beginSettingsDrag(point, target) {
    if (target?.closest?.('button, input, select, textarea, a, label')) return
    dragStartY = point.clientY
    dragStartX = point.clientX
    dragCurrentY = dragStartY
    dragStarted = false
    dragTracking = true
  }

  function _moveSettingsDrag(point, event) {
    if (!dragTracking) return
    dragCurrentY = point.clientY
    const deltaY = dragCurrentY - dragStartY
    const deltaX = point.clientX - dragStartX

    if (!dragStarted) {
      if (deltaY <= 8 || Math.abs(deltaY) <= Math.abs(deltaX)) return
      if (sheet.scrollTop > 0) {
        _resetSettingsDrag()
        return
      }
      dragStarted = true
      sheet.style.transition = 'none'
    }

    event?.preventDefault?.()
    sheet.style.transform = `translateY(${Math.max(0, deltaY)}px)`
  }

  function _finishSettingsDrag() {
    if (!dragTracking) return
    const deltaY = dragCurrentY - dragStartY
    const shouldClose = dragStarted && deltaY > 86
    _resetSettingsDrag()
    if (shouldClose) _closeSettings()
  }

  settingsBtn.addEventListener('click', event => _openSettings(event))
  document.getElementById('settings-close-btn')?.addEventListener('click', _closeSettings)
  sheet.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return
    _beginSettingsDrag(event.touches[0], event.target)
  }, { passive: true })
  sheet.addEventListener('touchmove', event => {
    if (event.touches.length !== 1) return
    _moveSettingsDrag(event.touches[0], event)
  }, { passive: false })
  sheet.addEventListener('touchend', _finishSettingsDrag)
  sheet.addEventListener('touchcancel', _resetSettingsDrag)
  sheet.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') return
    _beginSettingsDrag(event, event.target)
  })
  sheet.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    _moveSettingsDrag(event, event)
  })
  sheet.addEventListener('pointerup', event => {
    if (event.pointerType === 'touch') return
    _finishSettingsDrag()
  })
  sheet.addEventListener('pointercancel', event => {
    if (event.pointerType === 'touch') return
    _resetSettingsDrag()
  })

  // Close on backdrop tap
  overlay.addEventListener('click', e => {
    if (e.target === overlay) _closeSettings()
  })

  // Theme segment buttons
  document.querySelectorAll('.theme-seg-btn[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme
      localStorage.setItem('sporely-theme', theme)
      applyTheme(theme)
      _syncSettingsUI()
    })
  })

  // Photo gap input
  const gapInput = document.getElementById('settings-gap-input')
  function _setPhotoGap(value) {
    const v = setPhotoGapMinutes(value)
    gapInput.value = v
    const isSeconds = v < 1
    gapInput.textContent = String(isSeconds ? Math.round(v * 60) : Math.round(v))
    const gapUnit = document.getElementById('settings-gap-unit')
    if (gapUnit) gapUnit.textContent = isSeconds ? 'sec' : 'min'
  }
  document.getElementById('settings-gap-decrement')?.addEventListener('click', () => {
    const current = Number.parseFloat(gapInput.value || 1)
    _setPhotoGap(current <= 1 ? current - (10 / 60) : current - 1)
  })
  document.getElementById('settings-gap-increment')?.addEventListener('click', () => {
    const current = Number.parseFloat(gapInput.value || 1)
    let next = current < 1 ? current + (10 / 60) : current + 1
    if (Math.abs(next - 1) < 0.001) next = 1
    _setPhotoGap(next)
  })

  const artsorakelMaxEdgeInput = document.getElementById('settings-artsorakel-max-edge')
  artsorakelMaxEdgeInput?.addEventListener('change', () => {
    setArtsorakelMaxEdge(artsorakelMaxEdgeInput.value)
    artsorakelMaxEdgeInput.value = String(getArtsorakelMaxEdge())
  })

  const localeSelect = document.getElementById('settings-language-select')
  localeSelect.addEventListener('change', () => {
    setLocale(localeSelect.value)
  })

  const cameraAppRow = document.getElementById('settings-camera-app-row')
  if (cameraAppRow) cameraAppRow.style.display = isAndroidApp() ? 'flex' : 'none'
  document.querySelectorAll('.settings-camera-app-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const useSystemCamera = btn.dataset.cameraApp === 'native'
      setUseSystemCamera(useSystemCamera)
      _syncSettingsUI()
    })
  })

  document.querySelectorAll('.settings-default-visibility-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setDefaultVisibility(btn.dataset.defaultVisibility)
      _syncSettingsUI()
    })
  })

  // AI Photo ID mode buttons
  document.querySelectorAll('.settings-photo-id-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPhotoIdMode(btn.dataset.photoIdMode)
      _syncSettingsUI()
    })
  })

  document.getElementById('settings-clear-cache-btn')?.addEventListener('click', async event => {
    const btn = event.currentTarget
    if (!window.confirm(t('settings.clearLocalCacheConfirm'))) return
    btn.disabled = true
    try {
      await clearImportSessions()
      clearMediaUrlCache()
      await clearAllHomeCaches()
      if (window.caches?.keys) {
        const keys = await caches.keys()
        await Promise.all(keys.map(key => caches.delete(key)))
      }
      showToast(t('settings.localCacheCleared'))
    } catch (error) {
      showToast(t('settings.localCacheFailed', { message: error?.message || error }))
    } finally {
      btn.disabled = false
    }
  })
}

function _syncSettingsUI() {
  const current = localStorage.getItem('sporely-theme') || 'auto'
  document.querySelectorAll('.theme-seg-btn[data-theme]').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === current)
  })
  const gapInput = document.getElementById('settings-gap-input')
  if (gapInput) {
    const value = getPhotoGapMinutes()
    gapInput.value = String(value)
    const isSeconds = value < 1
    gapInput.textContent = String(isSeconds ? Math.round(value * 60) : Math.round(value))
    const gapUnit = document.getElementById('settings-gap-unit')
    if (gapUnit) gapUnit.textContent = isSeconds ? 'sec' : 'min'
  }
  const artsorakelMaxEdgeInput = document.getElementById('settings-artsorakel-max-edge')
  if (artsorakelMaxEdgeInput) artsorakelMaxEdgeInput.value = String(getArtsorakelMaxEdge())
  const localeSelect = document.getElementById('settings-language-select')
  if (localeSelect) localeSelect.value = getLocale()

  const defaultVisibility = getDefaultVisibility()
  document.querySelectorAll('.settings-default-visibility-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.defaultVisibility === defaultVisibility)
  })

  const useSystemCamera = getUseSystemCamera()
  document.querySelectorAll('.settings-camera-app-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cameraApp === (useSystemCamera ? 'native' : 'sporely'))
  })
  const acCameraLabel = document.querySelector('#ac-camera .action-card-label')

  const photoIdMode = getPhotoIdMode()
  document.querySelectorAll('.settings-photo-id-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.photoIdMode === photoIdMode)
  })

  if (acCameraLabel) acCameraLabel.textContent = getEffectiveCameraLabel()
}

// Function to update iNaturalist UI elements based on platform and config
async function _syncInaturalistUi() {
  const isNativeAndroid = isAndroidNativeApp();
  const isWebConfigured = isWebInatOAuthConfigured();

  const connectBtns = document.querySelectorAll('.inat-connect-btn');
  const forgetBtns = document.querySelectorAll('.inat-forget-btn');
  const webLoginHints = document.querySelectorAll('.inat-web-login-hint');
  const statusEls = document.querySelectorAll('#profile-inat-status, #settings-inat-status');

  const session = await loadInaturalistSession();
  const canConnect = isNativeAndroid || isWebConfigured;

  connectBtns.forEach(btn => {
    btn.style.display = session.connected ? 'none' : 'block';
    btn.disabled = !canConnect;
  });

  forgetBtns.forEach(btn => {
    btn.style.display = session.connected ? 'block' : 'none';
  });

  webLoginHints.forEach(hint => {
    hint.style.display = !canConnect && !session.connected ? 'block' : 'none';
    if (!canConnect) hint.textContent = t('settings.inaturalistWebLoginHint');
  });

  statusEls.forEach(el => {
    el.textContent = session.connected
      ? t('settings.inaturalistLoggedInAs', { username: session.username })
      : t('settings.inaturalistNotLoggedIn');
  });
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function initNav() {
  document.getElementById('nav-home').addEventListener('click', () => {
    navigate('home')
    refreshHome()
  })
  document.getElementById('nav-finds').addEventListener('click', () => {
    navigate('finds')
    loadFinds()
  })
  document.getElementById('nav-map').addEventListener('click', () => navigate('map'))
  document.getElementById('map-fab')?.addEventListener('click', openPreferredCamera)
  document.getElementById('nav-people').addEventListener('click', () => {
    navigate('people')
    loadPeople({ query: document.getElementById('people-search-input')?.value.trim() || '' })
  })
  ;['home-profile-btn', 'finds-profile-btn', 'map-profile-btn', 'people-profile-btn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', event => {
      openProfileOverlay({ opener: event.currentTarget })
    })
  })
}

function _cleanInaturalistCallbackUrl() {
  try {
    window.history.replaceState({}, document.title, '/')
  } catch (error) {
    console.warn('Failed to clean iNaturalist callback URL:', error)
  }
}

async function _handleInaturalistOAuthReturn(url) {
  const outcome = await maybeHandleInaturalistOAuthReturn(url, {
    onSuccess: async () => {
      showToast(t('settings.inaturalistLoginSuccess'))
      if (_appBootstrapped) {
        await _syncInaturalistUi()
      }
    },
    onError: error => {
      showToast(t('common.errorPrefix', { message: error.message || String(error) }))
      console.error('iNaturalist OAuth failed:', error)
    },
  })

  if (outcome?.scrubUrl) {
    _cleanInaturalistCallbackUrl()
  }

  return outcome
}

// Purges the two privacy-sensitive draft stores. THROWS on failure so the
// caller can leave the owner marker in place and retry on the next boot.
async function _purgeUserDrafts() {
  await clearImportSessionsStrict()
  await clearReviewDraftStrict()
}

async function _clearInMemoryUserState() {
  // In-memory media URL cache (Supabase signed URLs).
  try { clearMediaUrlCache() } catch (err) { console.warn('clearMediaUrlCache on sign-out failed:', err) }
  // HTTP/service-worker caches.
  try {
    if (window.caches?.keys) {
      const keys = await caches.keys()
      await Promise.all(keys.map(key => caches.delete(key)))
    }
  } catch (err) { console.warn('caches purge on sign-out failed:', err) }
  // Reset in-memory `state` to defaults (keep the shape stable, just clear
  // user-scoped fields).
  state.user = null
  state.cloudPlan = null
  state.capturedPhotos = []
  state.reviewContext = null
  state.batchCount = 0
  state.searchQuery = ''
  state.observationScope = 'mine'
  state.findsScopePrimary = 'feed'
  state.findsMineScope = 'public'
  state.findsFeedScope = 'all'
  state.findsView = 'cards'
  state.findsGroupBySpecies = false
  state.findsSort = 'date'
  state.findsStatusFilter = 'all'
  state.findsTargetUserId = null
  state.findsTargetSummaryLoaded = false
  state.findsTargetUsername = null
  state.findsTargetAvatarUrl = null
  state.findsTargetDisplayName = null
  state.findsTargetBio = null
  state.findsTargetRelationship = null
  state.findsTargetFinds = 0
  state.findsTargetSpecies = 0
  state.findsTargetSpores = 0
  state.findsTargetSummaryComplete = false
}

// Central de-duplicated resolution. All auth-success paths funnel through
// this so the callback result + deferred SIGNED_IN cannot both trigger
// profile loading. Successful resolution is remembered so a token-refresh
// SIGNED_IN for the same user is a no-op; a failure clears the marker so
// retry works.
export function resolveAuthenticatedSessionOnce(session, source) {
  const user = session?.user
  if (!user?.id) return Promise.resolve({ status: 'ignored' })

  const inFlight = _resolutionInFlight.get(user.id)
  if (inFlight) return inFlight

  const currentAuth = getAuthState()
  const alreadyResolved = _resolvedUsers.has(user.id)
    && currentAuth.userId === user.id
    && currentAuth.state !== AUTH_STATE.RESOLVING
    && currentAuth.state !== AUTH_STATE.UNAUTHENTICATED
  if (alreadyResolved) return Promise.resolve({ status: 'noop' })

  _authLog('session_resolution_started', { source })
  seedSharedAuthSession(session)

  const promise = (async () => {
    try {
      const result = await _resolveAndRouteForUser(user)
      // Only successful, revealed destinations count as resolved. Error
      // and stale outcomes leave `_resolvedUsers` unchanged so a retry (or
      // a fresh transition) still runs the full pipeline.
      if (result?.status === 'complete-home' || result?.status === 'incomplete-profile-setup') {
        _resolvedUsers.add(user.id)
      }
      _authLog('session_resolution_completed', { source, ok: true, status: result?.status || 'unknown' })
      return result || { status: 'unknown' }
    } catch (err) {
      _authLog('session_resolution_completed', { source, ok: false, code: _safeErrorCode(err) })
      throw err
    } finally {
      _resolutionInFlight.delete(user.id)
    }
  })()

  _resolutionInFlight.set(user.id, promise)
  return promise
}

// Explicit resolution results. Only `complete-home` and
// `incomplete-profile-setup` reveal a destination; anything else keeps the
// app blocked. `resolveAuthenticatedSessionOnce` gates `_resolvedUsers.add`
// on these two success statuses.
const RESOLUTION_STATUS = Object.freeze({
  COMPLETE_HOME: 'complete-home',
  INCOMPLETE_PROFILE_SETUP: 'incomplete-profile-setup',
  PROFILE_FETCH_FAILED: 'profile-fetch-failed',
  STALE: 'stale',
  // Stage B2a: an in-place revalidation of the already-revealed cached shell
  // could not complete (profile fetch failed). The cached shell stays up;
  // the reconnect triggers retry later. Deliberately NOT a success status.
  CACHED_REVALIDATION_DEFERRED: 'cached-revalidation-deferred',
})

// Stage B2a: same-user revalidation of an already-revealed cached shell
// (AUTHENTICATED_CACHED / AUTHENTICATED_REAUTH_REQUIRED → COMPLETE). The
// cached Home content is VISIBLE — running the full account-transition
// pipeline would blank it behind the blocker and flash skeletons. For the
// SAME user there is no privacy boundary to enforce, so we refresh in place:
// profile check → header refresh → COMPLETE → exactly ONE Home refresh that
// hydrates over the visible cached content and persists the fresh model.
//
// Returns null when the caller must fall through to the full transition
// (profile no longer complete — the setup pipeline owns that path).
async function _revalidateCachedRevealInPlace(user) {
  const generation = currentAccountGeneration()
  _authLog('in_place_revalidation_started', {})

  const { profile, error } = await fetchProfileWithSignupRetry(user.id)
  if (!isCurrentAccountTransition(generation, user.id, state.user?.id)) {
    _authLog('stale_account_result_discarded', { source: 'in_place_profile_fetch' })
    return { status: RESOLUTION_STATUS.STALE }
  }
  if (error) {
    // Do NOT put the blocking error overlay over a working cached shell.
    // Stay in cached mode; the revalidation triggers will retry.
    console.warn('In-place revalidation profile fetch failed; staying in cached mode:', error)
    _authLog('in_place_revalidation_profile_failed', { code: _safeErrorCode(error) })
    return { status: RESOLUTION_STATUS.CACHED_REVALIDATION_DEFERRED }
  }
  if (!isProfileComplete(profile)) return null

  state.user = user
  let headerRefreshOk = true
  try {
    await refreshHeaderProfileButtons()
  } catch (err) {
    headerRefreshOk = false
    console.warn('refreshHeaderProfileButtons during in-place revalidation failed:', err)
  }
  if (!isCurrentAccountTransition(generation, user.id, state.user?.id)) {
    _authLog('stale_account_result_discarded', { source: 'in_place_header_refresh' })
    return { status: RESOLUTION_STATUS.STALE }
  }

  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: user.id })
  _setOfflineIndicator(false)
  _authLog('in_place_revalidation_completed', {})

  void (async () => {
    let cloudPlan = null
    try { cloudPlan = await fetchCloudPlanProfile(user.id) }
    catch (err) { console.warn('[cached-auth] cloud plan fetch on in-place revalidation failed:', err) }
    if (cloudPlan) state.cloudPlan = cloudPlan
    if (!isCurrentAccountTransition(generation, user.id, state.user?.id)) return
    _persistLastValidatedAccountSnapshot({
      userId: user.id,
      email: user.email || '',
      profile,
      cloudPlan,
      headerRefreshOk,
    })
  })()

  // Exactly ONE online Home refresh for this reconnect. The visible cached
  // content stays put; fresh sections replace it in place and the assembled
  // model is persisted by refreshHomeSafe.
  void (async () => {
    try {
      await refreshHomeSafe()
    } catch (err) {
      console.warn('Home hydration after in-place revalidation failed:', err)
    }
  })()

  return { status: RESOLUTION_STATUS.COMPLETE_HOME }
}

async function _resolveAndRouteForUser(user) {
  // Stage B2a: a reconnect for the SAME user whose cached shell is already
  // revealed must hydrate in place instead of re-running the transition
  // boundary (which would blank the visible cached Home). Account switches
  // (different userId) always take the full path below.
  const authAtEntry = getAuthState()
  const isCachedRevealForSameUser = (
    authAtEntry.state === AUTH_STATE.AUTHENTICATED_CACHED
    || authAtEntry.state === AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
  ) && authAtEntry.userId === user?.id && state.user?.id === user?.id
  if (isCachedRevealForSameUser) {
    const inPlace = await _revalidateCachedRevealInPlace(user)
    if (inPlace) return inPlace
    // Profile no longer complete → fall through to the full transition so
    // the setup flow owns the reveal.
  }
  // Open an explicit account-transition boundary. Every async DOM write
  // below must verify this generation before running.
  const generation = beginAccountTransition()
  const expectedUserId = user?.id || null
  _authLog('account_transition_started', {})

  // Synchronously blank prior-user content and put up the opaque blocker
  // BEFORE any await runs. Neither the browser paint pipeline nor a late
  // account-A response can leak stale DOM after this point.
  clearUserScopedUi()
  showAccountTransitionBlocker()
  setAuthState({ state: AUTH_STATE.RESOLVING, userId: expectedUserId })
  showAuthOverlay()
  try { forceCloseProfileOverlay() } catch (err) { console.warn('forceCloseProfileOverlay in transition failed:', err) }
  _hideProfileResolutionError()

  const { profile, error } = await fetchProfileWithSignupRetry(user.id)

  // Discard if a newer transition superseded us while we were awaiting the
  // profile fetch. Do NOT touch DOM or reveal anything.
  if (!isCurrentAccountTransition(generation, expectedUserId, user.id)) {
    _authLog('stale_account_result_discarded', { source: 'profile_fetch' })
    return { status: RESOLUTION_STATUS.STALE }
  }

  if (error) {
    // A profile-fetch error is NOT a sign-out. Supabase still has a session;
    // silently converting a transient network/RLS failure into an
    // unauthenticated state hides the real problem. Keep the app blocked
    // behind an error surface with explicit Try again / Sign out actions.
    // Blocker stays visible; do not reveal Home.
    console.error('Profile fetch failed during auth resolution:', error)
    _authLog('profile_completion_checked', { hasProfile: false, complete: false, fetchOk: false })
    _showProfileResolutionError(user, error)
    return { status: RESOLUTION_STATUS.PROFILE_FETCH_FAILED }
  }

  const complete = isProfileComplete(profile)
  _authLog('profile_completion_checked', {
    hasProfile: !!profile,
    hasUsername: !!(profile?.username && String(profile.username).trim()),
    hasDisplayName: !!(profile?.display_name && String(profile.display_name).trim()),
    hasProfileCompletedAt: !!profile?.profile_completed_at,
    complete,
    fetchOk: true,
  })

  if (!complete) {
    // INCOMPLETE-PROFILE branch. Prepare-then-reveal:
    //   1) init app shell + purge previous-user data (behind the blocker)
    //   2) mount Profile setup for B
    //   3) verify no newer transition superseded us
    //   4) only THEN drop the blocker + auth overlay
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: user.id })
    await _ensureAppReadyForUser(user)
    if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) {
      _authLog('stale_account_result_discarded', { source: 'ensure_ready_incomplete' })
      return { status: RESOLUTION_STATUS.STALE }
    }
    navigate('home')
    _authLog('destination_render_started', { destination: 'profile-setup' })
    await openProfileOverlay({
      setup: true,
      onSetupCompleted: async persisted => {
        // Setup save's completion — Home refresh is CRITICAL. Runs at a
        // later moment than the initial transition; capture a fresh
        // generation so a late Google callback for another account cannot
        // race this refresh either.
        const g = currentAccountGeneration()
        const uid = persisted?.id || user.id
        navigate('home')
        await refreshHome()
        if (!isCurrentAccountTransition(g, uid, state.user?.id)) {
          _authLog('stale_account_result_discarded', { source: 'setup_completion' })
          throw new Error('stale-account-transition')
        }
        setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: uid })
        try {
          await refreshHeaderProfileButtons({
            username: persisted?.username,
            display_name: persisted?.display_name,
            avatar_url: persisted?.avatar_url || '',
          })
        } catch (err) { console.warn('refreshHeaderProfileButtons after setup failed:', err) }
      },
      onSetupSignOut: async () => { await supabase.auth.signOut() },
    })
    // openProfileOverlay resolved => Profile setup DOM is mounted and its
    // `loadProfile()` has run for user B. Verify once more before dropping
    // the blocker; if a newer transition kicked off since, keep the
    // blocker (that transition will replace it).
    if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) {
      _authLog('stale_account_result_discarded', { source: 'setup_open' })
      return { status: RESOLUTION_STATUS.STALE }
    }
    _authLog('destination_render_completed', { destination: 'profile-setup' })
    hideAuthOverlay()
    hideAccountTransitionBlocker()
    _authLog('account_transition_revealed', { destination: 'profile-setup' })
    return { status: RESOLUTION_STATUS.INCOMPLETE_PROFILE_SETUP }
  }

  // COMPLETE branch. Reveal-before-hydrate (Stage A cold-start work):
  //   1) init app shell + purge previous-user data (behind the blocker)
  //   2) refresh the header avatar so B's chrome is correct before reveal
  //   3) verify no newer transition superseded us
  //   4) navigate to Home (still behind the blocker)
  //   5) drop the blocker + auth overlay -> user sees the shell with skeletons
  //   6) asynchronously hydrate Home; per-section failures render inline
  //
  // Privacy note: this does NOT weaken the August account-transition guard.
  // `clearUserScopedUi()` has already blanked A's DOM synchronously, the
  // blocker is up throughout, and we still re-verify the generation before
  // every reveal. The reveal itself now happens before the Home network
  // hydration completes, but only after we've confirmed the current user is
  // still B and the header chrome reflects B.
  await _ensureAppReadyForUser(user)
  if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) {
    _authLog('stale_account_result_discarded', { source: 'ensure_ready_complete' })
    return { status: RESOLUTION_STATUS.STALE }
  }
  _bootMark('authenticated-user-resolved')
  _authLog('destination_render_started', { destination: 'home' })

  // Header avatar/initials must land BEFORE we reveal, otherwise the shell
  // could briefly show the fallback initials for account A. A failure here
  // is not fatal — subsequent screen navigation reruns it — but reveal
  // waits for the current attempt to settle. Stage A network path is left
  // unchanged (this awaits a PostgREST fetch inside `refreshHeaderProfileButtons`);
  // the Stage B1 snapshot writer below uses the already-fetched `profile`.
  let headerRefreshOk = true
  try {
    await refreshHeaderProfileButtons()
  } catch (err) {
    headerRefreshOk = false
    console.warn('refreshHeaderProfileButtons on sign-in failed:', err)
  }
  if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) {
    _authLog('stale_account_result_discarded', { source: 'header_refresh' })
    return { status: RESOLUTION_STATUS.STALE }
  }

  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: user.id })
  // A successful online resolution supersedes any cached-mode indicator
  // that a prior boot may have shown. Hide it before revealing.
  _setOfflineIndicator(false)
  navigate('home')
  _bootMark('app-shell-initialized')
  _authLog('destination_render_completed', { destination: 'home' })
  hideAuthOverlay()
  hideAccountTransitionBlocker()
  _bootMark('app-shell-revealed')
  _authLog('account_transition_revealed', { destination: 'home' })

  // Fetch cloud plan (best-effort) and persist the last-validated-account
  // snapshot for the next cold start. `fetchCloudPlanProfile` tags its
  // result so a FALLBACK response never overwrites a previously persisted
  // good plan. This is Stage B1's authority write site.
  //
  // Ordering rationale: writing the snapshot AFTER reveal so a slow plan
  // fetch does not delay the shell. The snapshot only affects the NEXT
  // launch; the current launch is already fully online-resolved.
  void (async () => {
    let cloudPlan = null
    try { cloudPlan = await fetchCloudPlanProfile(user.id) }
    catch (err) { console.warn('[cached-auth] cloud plan fetch on resolve failed:', err) }
    if (cloudPlan) state.cloudPlan = cloudPlan
    if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) return
    _persistLastValidatedAccountSnapshot({
      userId: user.id,
      email: user.email || '',
      profile,
      cloudPlan,
      headerRefreshOk,
    })
  })()

  // Kick off Home hydration AFTER reveal so the user sees the shell
  // immediately. Stage B2a makes this cache-first: the persisted Home model
  // for THIS user renders into the skeletons first (bounded local-only read
  // — a hung IndexedDB resolves null and never blocks), then exactly ONE
  // online refresh replaces it with fresh data and persists the new model.
  // `refreshHomeSafe` renders per-section errors inline instead of throwing
  // — a failure here must not throw the user back behind the auth overlay
  // or expose stale DOM from account A.
  void (async () => {
    try {
      // Cached render strictly precedes the network refresh so stale data
      // can never paint over fresh data. Keeps skeletons when no cache.
      // The read is capped by HOME_CACHE_ONLINE_BOOT_BUDGET_MS: on the
      // ONLINE path a slow/hung IndexedDB must not delay a healthy network
      // refresh, so past the budget we skip the cached render entirely.
      await renderHomeFromCache(user.id, {
        emptyStatesWhenMissing: false,
        timeoutMs: HOME_CACHE_ONLINE_BOOT_BUDGET_MS,
      })
    } catch (err) {
      console.warn('Cache-first Home render failed:', err)
    }
    if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) return
    try {
      await refreshHomeSafe()
    } catch (err) {
      // refreshHomeSafe already swallows per-section errors, but guard
      // against future refactors that reintroduce a throw.
      console.warn('Post-reveal Home hydration failed:', err)
    } finally {
      _bootMeasure('js-init-start', 'app-shell-revealed')
      _bootMeasure('js-init-start', 'home-refresh-end')
    }
  })()

  return { status: RESOLUTION_STATUS.COMPLETE_HOME }
}

// Stage B1: persist "last successful online validation" for the cached-
// authenticated cold boot. NEVER stores Supabase tokens; only the minimal
// profile summary + last known cloudPlan. See last-validated-account.js.
function _persistLastValidatedAccountSnapshot({ userId, email, profile, cloudPlan, headerRefreshOk }) {
  if (!userId) return
  if (!profile) return // profile-fetch failure path never reaches here, but be defensive
  // Cloud-plan source guard: a FALLBACK plan is a network-failed default
  // and must not overwrite a previously persisted good plan (that path is
  // one of the main Stage B failure modes to prevent — no silent Pro
  // downgrade offline).
  const source = getCloudPlanSource(cloudPlan)
  const usableCloudPlan = source === CLOUD_PLAN_SOURCE.NETWORK ? cloudPlan : null
  const existing = readLastValidatedAccount()
  const preservedCloudPlan = existing && existing.userId === userId && existing.cloudPlan
    ? existing.cloudPlan
    : null
  const snapshotCloudPlan = usableCloudPlan || preservedCloudPlan || null
  const ok = writeLastValidatedAccount({
    userId,
    email: email || '',
    profileComplete: true,
    profileSummary: {
      username: profile?.username || null,
      display_name: profile?.display_name || null,
      avatar_url: profile?.avatar_url || null,
    },
    cloudPlan: snapshotCloudPlan,
    lastValidatedAt: Date.now(),
  })
  if (ok) {
    _bootMark('last-validated-account-written', {
      cloudPlanSource: source || 'unknown',
      headerRefreshOk: !!headerRefreshOk,
    })
    _authLog('last_validated_snapshot_written', {
      cloudPlanSource: source || 'unknown',
      preservedCachedPlan: !usableCloudPlan && !!preservedCloudPlan,
    })
  }
}

function _showProfileResolutionError(user, error) {
  const overlay = document.getElementById('profile-resolve-error-overlay')
  const message = document.getElementById('profile-resolve-error-message')
  if (message) message.textContent = error?.message || String(error || t('auth.genericError'))
  if (overlay) overlay.style.display = 'flex'
  showAuthOverlay()
  // Do NOT downgrade the auth state to UNAUTHENTICATED — Supabase still has a
  // valid session. Stay in RESOLVING so nothing renders Home.
  setAuthState({ state: AUTH_STATE.RESOLVING, userId: user?.id || null })

  const tryAgainBtn = document.getElementById('profile-resolve-error-retry')
  const signOutBtn = document.getElementById('profile-resolve-error-signout')
  const onTryAgain = async () => {
    _hideProfileResolutionError()
    await _resolveAndRouteForUser(user)
  }
  const onSignOut = async () => {
    _hideProfileResolutionError()
    try { await supabase.auth.signOut() }
    catch (err) { console.warn('Sign-out from resolution error failed:', err) }
  }
  // Replace nodes to wipe prior click handlers — this button is bound per
  // error surface, not once at boot.
  if (tryAgainBtn) {
    const fresh = tryAgainBtn.cloneNode(true)
    tryAgainBtn.parentNode.replaceChild(fresh, tryAgainBtn)
    fresh.addEventListener('click', onTryAgain)
  }
  if (signOutBtn) {
    const fresh = signOutBtn.cloneNode(true)
    signOutBtn.parentNode.replaceChild(fresh, signOutBtn)
    fresh.addEventListener('click', onSignOut)
  }
}

function _hideProfileResolutionError() {
  const overlay = document.getElementById('profile-resolve-error-overlay')
  if (overlay) overlay.style.display = 'none'
}

// Boot the app the FIRST time only. Subsequent sign-ins (including account
// switches) reuse the initialized screens and their existing listeners, so
// nothing can be double-bound across repeated sign-out/sign-in cycles. On
// account switch we clear the prior user's data but leave the DOM listeners
// in place; the refresh calls above repopulate the visible screen.
async function _ensureAppReadyForUser(user) {
  const previousUserId = state.user?.id || null
  if (previousUserId && previousUserId !== user.id) {
    // Account switch. Purge drafts BEFORE moving the owner marker; if the
    // purge throws, the marker stays with the previous user so the next
    // cold-start ownership check retries it.
    await _purgeUserDrafts()
    // Stage B2a: the previous user's Home cache follows the existing purge
    // semantics. Best-effort — the store is strictly userId-keyed, so a
    // failed delete cannot leak into the new user's session.
    if (!(await clearHomeCache(previousUserId))) {
      console.warn('Home cache clear on account switch failed; record remains user-scoped.')
    }
    setLocalDataOwner(user.id)
    await _clearInMemoryUserState()
  } else {
    // First boot on this page load: align the marker without a purge.
    setLocalDataOwner(user.id)
  }
  state.user = user
  await bootApp(user)
}

async function bootApp(user) {
  if (_appBootstrapped && state.user?.id === user?.id) {
    return
  }

  state.user = user
  showAuthError('')

  if (_appBootstrapped) return
  _appBootstrapped = true

  function runBootStep(label, fn) {
    Promise.resolve()
      .then(fn)
      .catch(error => {
        console.error(`Boot step failed: ${label}`, error)
        return null
      })
  }

  runBootStep('sync-feedback', () => initSyncFeedback())
  runBootStep('settings', () => initSettings())
  runBootStep('camera-fallback-warning', () => initCameraFallbackWarning())
  runBootStep('navigation', () => initNav())
  runBootStep('home', () => initHome())
  runBootStep('finds', () => initFinds())
  runBootStep('capture', () => initCapture())
  runBootStep('review', () => initReview())
  runBootStep('find-detail', () => initFindDetail())
  runBootStep('photo-viewer', () => initPhotoViewer())
  runBootStep('ai-crop-editor', () => initAiCropEditor())
  runBootStep('import-review', () => initImportReview())
  runBootStep('people', () => initPeople())
  runBootStep('profile', () => {
    initProfile()
    // Wire iNat buttons after profile screen is initialized
    document.querySelectorAll('.inat-connect-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const session = await connectInaturalist()
          if (session?.connected) {
            await _syncInaturalistUi()
            showToast(t('settings.inaturalistLoginSuccess'))
          }
        } catch (error) {
          console.error('[inat-oauth] connect failed', error)
          showToast(error.message)
        }
      });
    });
    document.querySelectorAll('.inat-forget-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await forgetInaturalistSession();
        await _syncInaturalistUi();
        showToast(t('settings.inaturalistLoggedOut'));
      });
    });
  })
  // NOTE: refreshHeaderProfileButtons() is intentionally NOT called here.
  // The authenticated-resolve path (`_resolveAndRouteForUser`) awaits it
  // before revealing the shell, so calling it a second time from
  // bootApp() would double-fire the profile fetch on every startup.
  runBootStep('inaturalist-ui', () => _syncInaturalistUi()) // Initial sync of iNaturalist UI
  runBootStep('identify-labels', () => syncIdentifyButtonLabels())

  runBootStep('pending-import-restore', async () => {
    // Cold-start account-switch guard: the SIGNED_OUT handler may not have
    // run last time (process kill, externally revoked session, etc.). Ask
    // the owner module to purge on mismatch BEFORE we touch the stores. The
    // purge is strict — a thrown IDB error keeps the marker in place so the
    // next boot retries and drafts stay hidden until then.
    const { outcome } = await resolveLocalDataOwner(user.id, _purgeUserDrafts, {
      // Legacy rollout: if there's no owner marker but data exists in either
      // draft store, treat as unowned pre-upgrade data and purge. Documented
      // trade-off: this may discard one pre-upgrade draft in favor of account
      // isolation across account switches.
      hasLegacyData: async () => {
        try {
          const sessions = await loadImportSessions()
          if (sessions.length > 0) return true
          const draft = await loadReviewDraft()
          return draft != null
        } catch { return false }
      },
    })
    if (outcome === 'purge_failed' || outcome === 'legacy_purge_failed') {
      console.warn('[boot] Ownership purge failed; skipping draft restore this session.')
      return
    }
    if (outcome === 'purged') {
      console.info('[boot] Purged prior owner\'s local drafts on cold-start.')
      return
    }
    // Only 'match' or 'assigned' reach here.

    const pending = await loadImportSessions()
    if (pending.length) {
      restoreImportSessions(pending)
      return
    }
    // A live review draft persists camera photos that never reached the
    // sync queue (crash/force-quit during review). The pending import wins
    // if both exist; the review draft stays stored for the next launch.
    const reviewDraft = await loadReviewDraft()
    if (reviewDraft) restoreReviewDraft(reviewDraft)
  })
}

onLocaleChange(() => {
  _syncSettingsUI()

  if (!state.user) return

  if (state.currentScreen === 'home') refreshHome()
  if (state.currentScreen === 'finds') loadFinds()
  if (state.currentScreen === 'review') buildReviewGrid()
  if (state.currentScreen === 'import-review') renderSessions()
  if (state.currentScreen === 'map') void loadMapScreen()
  if (state.currentScreen === 'people') loadPeople({ query: document.getElementById('people-search-input')?.value.trim() || '' })
  if (state.currentScreen === 'profile') loadProfile()
  _syncInaturalistUi() // Sync iNaturalist UI on locale change
  syncIdentifyButtonLabels()
})

// Cheap, side-effect-free check: does this URL look like a possible
// iNaturalist OAuth return? Startup can skip the parse when it doesn't.
function _urlLooksLikeInaturalistReturn(href) {
  if (typeof href !== 'string' || !href) return false
  try {
    const url = new URL(href)
    // Android deep-link scheme.
    if (url.protocol === 'com.sporelab.sporely:' && url.hostname === 'auth') return true
    // Web callback path.
    if (url.pathname === '/auth/inaturalist/callback') return true
    // Root rescue path only if a code+state are visible in the query.
    if ((url.pathname === '/' || url.pathname === '') && url.searchParams.get('code') && url.searchParams.get('state')) return true
    return false
  } catch (_) { return false }
}

function _urlLooksLikeSupabaseOAuthCallback(href) {
  if (typeof href !== 'string' || !href) return false
  try {
    const url = new URL(href)
    if (url.pathname !== '/auth/callback') return false
    return !!(url.searchParams.get('code') || url.searchParams.get('error') || url.searchParams.get('error_description'))
  } catch (_) { return false }
}

// Stage B1: reveal the shell for a previously-validated local account when
// the current launch cannot fully validate a Supabase session. See
// PLAN-startup.md.
//
// Preconditions checked here:
//   1. `readLastValidatedAccount()` returns a well-formed record.
//   2. `getLocalDataOwner()` === record.userId. Any mismatch fails closed:
//      snapshot is cleared and the caller falls through to unauth.
//   3. The eager session refresh did NOT produce a server-confirmed
//      session rejection (invalid_refresh_token / session_not_found /
//      user_not_found / …). Explicit rejection => normal sign-out recovery.
//
// After the preconditions pass, a small reachability probe against
// Supabase's `/auth/v1/health` selects the reveal state:
//
//   * probe UNREACHABLE  => AUTHENTICATED_CACHED — the device is offline
//     from Supabase's perspective; reconnect triggers will retry.
//   * probe REACHABLE    => AUTHENTICATED_REAUTH_REQUIRED — the server is
//     reachable but our stored session is missing; authenticated network
//     writes MUST be gated. The reconnect triggers will still re-run the
//     session refresh so that a normal refresh path can transition to
//     AUTHENTICATED_COMPLETE.
async function _tryCachedAuthenticatedBoot({ sessionError = null, hasHashError = false, probe = probeBackendReachability } = {}) {
  _bootMark('last-validated-account-loaded')
  const snapshot = readLastValidatedAccount()
  if (!snapshot) return false

  // Owner-mismatch guard (privacy). If the local IDB stores belong to a
  // different user than the persisted snapshot, we cannot trust either —
  // clear the snapshot and let the unauthenticated flow take over.
  const owner = getLocalDataOwner()
  if (!owner) {
    // No draft-owner marker at all → treat as if the device does not yet
    // trust this record. Fail closed and clear the snapshot to force a
    // fresh online sign-in the next time this device sees Supabase.
    _authLog('cached_boot_skipped_missing_owner', {})
    clearLastValidatedAccount()
    return false
  }
  if (owner !== snapshot.userId) {
    _authLog('cached_boot_owner_mismatch', {})
    clearLastValidatedAccount()
    return false
  }

  // Server-confirmed rejection must not enter cached mode; the server has
  // said "no". Only transport failures / "no session locally" fall through
  // to cached — never `navigator.onLine` as authority.
  if (sessionError && _isExplicitAuthRejection(sessionError)) {
    _authLog('cached_boot_skipped_auth_reject', { code: _safeErrorCode(sessionError) })
    return false
  }

  // Reachability probe drives the state selection. Do it BEFORE any DOM
  // changes so an unreachable-with-transient-throw scenario still routes
  // through the same code path.
  _bootMark('reachability-probe-started', { sessionThrown: !!sessionError })
  let reachability = 'unreachable'
  try { reachability = await probe() }
  catch (_) { reachability = 'unreachable' }
  _bootMark('reachability-probe-completed', { reachability })
  _authLog('reachability_probe', { reachability, sessionThrown: !!sessionError })

  const targetState = reachability === 'reachable'
    ? AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
    : AUTH_STATE.AUTHENTICATED_CACHED

  _bootMark('cached-auth-selected', {
    hasCloudPlan: !!snapshot.cloudPlan,
    reachability,
    reason: sessionError ? 'transport-error' : 'no-session',
    targetState,
  })
  _authLog('cached_boot_selected', {
    hasCloudPlan: !!snapshot.cloudPlan,
    hasHashError: !!hasHashError,
    reachability,
    targetState,
  })

  const generation = beginAccountTransition()
  const expectedUserId = snapshot.userId

  // Minimal state.user shape: everything else derives from Supabase-live
  // queries which will be gated by AUTHENTICATED_CACHED /
  // AUTHENTICATED_REAUTH_REQUIRED state.
  state.user = { id: snapshot.userId, email: snapshot.email || '' }
  if (snapshot.cloudPlan) {
    const revived = reviveCachedCloudPlan(snapshot.cloudPlan)
    if (revived) state.cloudPlan = revived
  }

  // Synchronously blank any prior-user DOM and put up the blocker BEFORE
  // any await — even for the same owner this keeps the boundary intact.
  clearUserScopedUi()
  showAccountTransitionBlocker()
  setAuthState({ state: AUTH_STATE.RESOLVING, userId: expectedUserId })
  showAuthOverlay()
  try { forceCloseProfileOverlay() } catch (err) { console.warn('forceCloseProfileOverlay in cached boot failed:', err) }
  _hideProfileResolutionError()

  // Init the shell + restore drafts behind the blocker.
  await _ensureAppReadyForUser(state.user)
  if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) {
    _authLog('cached_boot_stale', { source: 'ensure_ready' })
    return true // do not fall through — a newer online transition is now in charge
  }

  // Paint header chrome from cached profile summary (synchronous, no
  // Supabase). Never attempt a signed-URL avatar here — the loader would
  // require a network fetch that we know is failing.
  try {
    renderCachedHeaderProfileButtons(snapshot.profileSummary, { email: snapshot.email })
    _bootMark('cached-header-rendered')
  } catch (err) {
    console.warn('renderCachedHeaderProfileButtons in cached boot failed:', err)
  }

  setAuthState({ state: targetState, userId: snapshot.userId })
  navigate('home')
  _bootMark('app-shell-initialized')
  hideAuthOverlay()
  hideAccountTransitionBlocker()
  _setOfflineIndicator(true)
  _bootMark('app-shell-revealed')
  _bootMeasure('js-init-start', 'app-shell-revealed')
  _authLog('cached_boot_revealed', { targetState })

  // Stage B2a: render this user's persisted Home model — a strictly local
  // IndexedDB read, ZERO Supabase hydration. When no cache exists the boot
  // skeletons are replaced with offline empty states so the shell is never
  // a permanent shimmer. The read runs after reveal so a slow/hung
  // IndexedDB cannot delay the shell.
  void (async () => {
    try {
      if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) return
      await renderHomeFromCache(snapshot.userId)
    } catch (err) {
      console.warn('Cached Home render on offline boot failed:', err)
    }
  })()

  // If the backend is REACHABLE but our session is missing, a single
  // deferred re-probe is redundant — reveal the shell in
  // AUTHENTICATED_REAUTH_REQUIRED and let the user reauth (or the
  // reconnect triggers pick up a materialized session). If UNREACHABLE,
  // schedule the same reconnect triggers so a network heal transitions
  // us out of cached mode.
  _scheduleCachedRevalidation({ initialReachability: reachability })
  return true
}

let _cachedRevalidationListenersBound = false
let _cachedRevalidationInFlight = false
let _deferredReprobeScheduled = false

function _scheduleCachedRevalidation({ initialReachability = 'unreachable' } = {}) {
  if (!_cachedRevalidationListenersBound) {
    _cachedRevalidationListenersBound = true
    const trigger = source => { void _attemptCachedRevalidation(source) }
    try {
      window.addEventListener('online', () => trigger('online-event'))
    } catch (_) {}
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') trigger('visibility-visible')
      })
    } catch (_) {}
  }
  // Single deferred re-probe. Only scheduled when the initial probe said
  // UNREACHABLE — a reachable backend already produced a definitive answer
  // (the state is AUTHENTICATED_REAUTH_REQUIRED and no timer will fix that;
  // the user has to sign in or the reconnect triggers materialize a fresh
  // session). This replaces the earlier unconditional 3s retry that fired
  // even when the state was already known.
  if (!_deferredReprobeScheduled && initialReachability === 'unreachable') {
    _deferredReprobeScheduled = true
    setTimeout(() => { void _attemptCachedRevalidation('deferred-reprobe') }, 5000)
  }
}

async function _attemptCachedRevalidation(source) {
  if (_cachedRevalidationInFlight) return
  const current = getAuthState()
  const cachedStates = new Set([AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED])
  if (!cachedStates.has(current.state)) return
  _cachedRevalidationInFlight = true
  _bootMark('revalidation-started', { source, fromState: current.state })
  _authLog('cached_revalidation_started', { source, fromState: current.state })
  try {
    // Re-probe reachability so a network-heal / network-drop transitions
    // state correctly even if getSession() returns the same null-session
    // it returned at boot.
    let reachability = 'unreachable'
    try { reachability = await probeBackendReachability() }
    catch (_) { reachability = 'unreachable' }

    let session = null
    let sessionError = null
    try {
      clearSharedAuthSessionCache()
      session = await getSharedAuthSession({ refresh: true })
    } catch (err) {
      sessionError = err
    }
    if (sessionError) {
      if (_isExplicitAuthRejection(sessionError)) {
        _authLog('cached_revalidation_auth_rejected', { code: _safeErrorCode(sessionError) })
        // Server said no — kick a real sign-out so the SIGNED_OUT handler
        // performs the normal purge (which will also clear the snapshot).
        try { await supabase.auth.signOut() } catch (err) { console.warn('signOut after cached revalidation rejection failed:', err) }
        return
      }
      _authLog('cached_revalidation_transport_failed', { code: _safeErrorCode(sessionError) })
      // Sync state to probe result — a probe that flipped reachable while
      // the session call still failed with a transport error is unlikely
      // but harmless to reflect.
      _syncCachedStateWithReachability(current.userId, reachability)
      return
    }
    if (!session?.user) {
      _authLog('cached_revalidation_no_user', { reachability })
      _syncCachedStateWithReachability(current.userId, reachability)
      return
    }
    // Route through the normal resolve pipeline. This will refresh header +
    // cloud plan, persist a fresh snapshot, and transition state to
    // AUTHENTICATED_COMPLETE. It also handles the account-switch case
    // where a different user's session materializes.
    try {
      await resolveAuthenticatedSessionOnce(session, `cached_revalidation:${source}`)
      _bootMark('revalidation-completed')
      _authLog('cached_revalidation_completed', { ok: true })
    } catch (err) {
      _authLog('cached_revalidation_completed', { ok: false, code: _safeErrorCode(err) })
    }
  } finally {
    _cachedRevalidationInFlight = false
  }
}

function _syncCachedStateWithReachability(userId, reachability) {
  const target = reachability === 'reachable'
    ? AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
    : AUTH_STATE.AUTHENTICATED_CACHED
  const current = getAuthState()
  if (current.state === target) return
  // Only transition between the two cached-ish states; do not resurrect
  // the shell from an unauthenticated or resolving state here.
  const cachedStates = new Set([AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED])
  if (!cachedStates.has(current.state)) return
  setAuthState({ state: target, userId })
  _authLog('cached_state_synced_with_reachability', { target, reachability })
}

async function init() {
  initDebugDashboard()

  _lockPortraitOrientation()
  document.addEventListener('pointerdown', _lockPortraitOrientation, { once: true, passive: true })

  // Stage A: `initializeInaturalistOAuth()` no longer runs eagerly. The
  // native SocialLogin plugin is lazy-loaded when Google or iNaturalist is
  // actually used. On non-Android, iNat-callback parsing only runs when the
  // launch URL actually looks like an iNat return so a normal cold start
  // does not touch that code path.
  if (getPlatform() !== 'android' && _urlLooksLikeInaturalistReturn(window.location.href)) {
    await _handleInaturalistOAuthReturn(window.location.href)
  }

  const authState = getInitialAuthState()
  const hasHashError = handleUrlHashError()
  if (!authState.isRecovery && hasPasswordRecoveryHint()) {
    clearPasswordRecoveryHint()
  }
  let recoveryModeActive = authState.isRecovery && !hasHashError
  let authUiInitialized = false

  const ensureAuthUiInitialized = (skipDraftRestore = false) => {
    if (authUiInitialized) return
    initAuth(async session => {
      recoveryModeActive = false
      clearPasswordRecoveryHint()
      const bootSession = session || await getSharedAuthSession({ refresh: true })
      if (bootSession?.user) {
        try {
          await resolveAuthenticatedSessionOnce(bootSession, 'auth_form_submit')
        } catch (_) { /* handled by profile-resolution error surface */ }
      }
    }, skipDraftRestore)
    authUiInitialized = true
  }

  clearSharedAuthSessionCache()

  // Cold-start: if the app was launched by tapping an email-confirmation
  // App Link, App.getLaunchUrl gives us the URL BEFORE Vite/router touch
  // window.location. Feed it into the shared callback handler so the
  // session is exchanged before we decide which screen to render.
  let nativeCallbackResult = null
  const _nativeLinkResult = await registerNativeAuthLinkListener(async url => {
    _authLog('native_callback_received', {})
    // Immediately clear the stale "Check your inbox / Resend email" message
    // and show a neutral resolving state so the confirmed user doesn't see
    // the old signup form as though confirmation failed.
    try { showAuthError('') } catch (_) {}
    setAuthState({ state: AUTH_STATE.RESOLVING, userId: null })
    _authLog('callback_exchange_started', {})
    nativeCallbackResult = await maybeHandleSupabaseOAuthCallback(url)
    _authLog('callback_exchange_completed', { ok: nativeCallbackResult?.status === 'success' })
    if (nativeCallbackResult?.session?.user) {
      try {
        await resolveAuthenticatedSessionOnce(nativeCallbackResult.session, 'native_callback')
      } catch (_) { /* profile-resolution error surface handles UX */ }
    } else if (nativeCallbackResult?.status === 'error') {
      setAuthState({ state: AUTH_STATE.UNAUTHENTICATED, userId: null })
      showAuthOverlay()
      switchToLogin()
      showAuthError(nativeCallbackResult.errorMessage || t('auth.genericError'))
    }
  })
  _bootMark('native-auth-link-listener-registered', { registered: !!_nativeLinkResult?.registered })

  // Only invoke the Supabase OAuth callback exchange when the launch URL
  // actually looks like one. Ordinary cold starts (no code/error present)
  // skip a whole network exchange.
  const oauthCallbackResult = nativeCallbackResult
    || (_urlLooksLikeSupabaseOAuthCallback(window.location.href)
      ? await maybeHandleSupabaseOAuthCallback(window.location.href)
      : null)
  // Stage B1: capture whatever error the eager session refresh throws so a
  // later cached-boot classifier can distinguish transport from auth-reject.
  // A thrown session must NOT crash init() — the whole point of cached-boot
  // is that a network failure here is recoverable via the persisted record.
  let eagerSession = null
  let eagerSessionError = null
  try {
    eagerSession = await getSharedAuthSession({ refresh: true })
  } catch (err) {
    eagerSessionError = err
  }
  const initialSession = eagerSession || oauthCallbackResult?.session || null
  _bootMark('supabase-session-resolved', {
    hasUser: !!initialSession?.user,
    thrown: !!eagerSessionError,
  })

  // Deferred handler — runs OUTSIDE the Supabase auth lock. Safe to call
  // Supabase APIs, PostgREST, RPCs here.
  async function _handleDeferredAuthEvent(event, session) {
    if (event === 'PASSWORD_RECOVERY') {
      clearSharedAuthSessionCache()
      ensureAuthUiInitialized(true)
      recoveryModeActive = true
      showAuthOverlay()
      switchToResetPassword()
      return
    }
    if (event === 'SIGNED_IN' && session?.user) {
      _authLog('signed_in_event_deferred', { hasUser: true })
      if (recoveryModeActive || document.getElementById('reset-password-form')?.style.display === 'block') {
        return
      }
      clearSharedAuthSessionCache()
      _fireClientActivity()
      try {
        await resolveAuthenticatedSessionOnce(session, 'onAuthStateChange')
      } catch {
        // resolveAuthenticatedSessionOnce already logged via safe phase log.
        // The profile-resolution error surface handles user-visible retry.
      }
      return
    }
    if (event === 'SIGNED_OUT') {
      // Captured before in-memory state is cleared so the Home cache purge
      // below targets the right user even after _clearInMemoryUserState.
      const signedOutUserId = state.user?.id || getLocalDataOwner() || null
      // Revoke offline trust IMMEDIATELY and unconditionally. An explicit
      // sign-out must never leave a bootable offline identity behind, even
      // when the draft/cache cleanup below fails. "May this account boot
      // offline?" (the B1 snapshot) and "does this account still have local
      // data awaiting cleanup?" (the owner marker) are separate states: the
      // snapshot dies here; the owner marker is only moved after a
      // successful purge so the next boot retries the cleanup — and cached
      // boot fails closed on the missing snapshot regardless.
      clearLastValidatedAccount()
      clearSharedAuthSessionCache()
      _resolvedUsers.clear()
      _resolutionInFlight.clear()
      // Bump the transition generation FIRST so any in-flight resolution
      // for the previous user is rejected as stale before touching DOM.
      beginAccountTransition()
      // Synchronously blank prior-user DOM before any await — no A content
      // may survive after this line, and none of the following awaits may
      // paint it back.
      clearUserScopedUi()
      let purgeOk = true
      try {
        await _purgeUserDrafts()
      } catch (err) {
        purgeOk = false
        console.error('Draft purge on sign-out failed; owner marker preserved for next-boot retry:', _safeErrorCode(err))
      }
      await _clearInMemoryUserState()
      if (purgeOk) {
        // Owner marker only moves after a successful purge so the next boot
        // retries the draft cleanup (offline trust was already revoked via
        // clearLastValidatedAccount at the top of this handler).
        clearLocalDataOwner()
      }
      // Stage B2a: the Home read-model cache is cleared unconditionally —
      // explicit sign-out (and account deletion, which routes through
      // signOut) removes the user's cached Home regardless of how the draft
      // purge fared. A failed delete is only logged: with the snapshot gone,
      // cached boot fails closed and the leftover record is unreadable
      // without a fresh online sign-in as that same user.
      const cacheCleared = signedOutUserId
        ? await clearHomeCache(signedOutUserId)
        : await clearAllHomeCaches()
      if (!cacheCleared) console.warn('Home cache clear on sign-out failed; record remains gated by the revoked snapshot.')
      resetHomeSectionTracking()
      try { forceCloseProfileOverlay() } catch (err) { console.warn('forceCloseProfileOverlay failed:', _safeErrorCode(err)) }
      _hideProfileResolutionError()
      hideAccountTransitionBlocker()
      _setOfflineIndicator(false)
      setAuthState({ state: AUTH_STATE.UNAUTHENTICATED, userId: null })
      ensureAuthUiInitialized(true)
      showAuthOverlay()
      switchToLogin()
      navigate('home')
    }
  }

  // Direct listener. STRICTLY synchronous — no async, no await, no Supabase
  // calls. Only copies the event onto a queue and returns immediately so the
  // auth lock is released.
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    notifyProtectedMediaSessionChange(session)
    setTimeout(() => {
      enqueueAuthEvent(event, session, _handleDeferredAuthEvent)
    }, 0)
  })
  _authStateSubscription = subscription

  window.addEventListener('pagehide', () => {
    _authStateSubscription?.unsubscribe?.()
    _authStateSubscription = null
  }, { once: true })

  // Foreground pings keep the daily activity row's last_seen_at fresh without
  // any polling. The RPC is idempotent per (user, UTC date, client, version).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!state.user) return
    // Throttle foreground pings — boot and SIGNED_IN always fire immediately,
    // but tab-switch churn should not hammer the RPC.
    if (!shouldRecordOnVisibility()) return
    _fireClientActivity()
  })

  if (initialSession?.user && !recoveryModeActive && document.getElementById('reset-password-form')?.style.display !== 'block') {
    clearPasswordRecoveryHint()
    _fireClientActivity()
    try {
      await resolveAuthenticatedSessionOnce(initialSession, 'initial_boot')
    } catch (_) { /* error surface handles UX */ }
  } else {
    // Stage B1: cached-authenticated boot path. Only attempt when we are
    // NOT in recovery mode, NOT handling a Supabase OAuth error, and the
    // reset-password form is not already visible. `oauthCallbackResult`
    // returning `status === 'error'` means the server has actively rejected
    // this launch; treat that as an explicit auth failure and skip cached
    // boot.
    let cachedBootHandled = false
    const resetFormVisible = document.getElementById('reset-password-form')?.style.display === 'block'
    const oauthErrored = oauthCallbackResult?.status === 'error'
    if (!recoveryModeActive && !resetFormVisible && !oauthErrored && !hasHashError) {
      try {
        cachedBootHandled = await _tryCachedAuthenticatedBoot({
          sessionError: eagerSessionError,
          hasHashError,
        })
      } catch (err) {
        console.warn('Cached-authenticated boot path threw; falling through to unauth:', err)
        cachedBootHandled = false
      }
    }
    if (!cachedBootHandled) {
      setAuthState({ state: AUTH_STATE.UNAUTHENTICATED, userId: null })
      if (document.getElementById('auth-overlay').style.display !== 'flex') {
        showAuthOverlay()
      }
      ensureAuthUiInitialized(hasHashError || recoveryModeActive)
      if (recoveryModeActive) {
        switchToResetPassword()
      } else if (oauthCallbackResult?.status === 'error') {
        switchToLogin()
        showAuthError(oauthCallbackResult.errorMessage || oauthCallbackResult.error?.message || t('auth.genericError'))
      }
    }
  }

}

init()
