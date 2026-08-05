import './style.css'
import './theme.js'   // applies saved theme immediately, no flash

import { supabase } from './supabase.js'
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
import { initHome, refreshHome } from './screens/home.js'
import { initFinds, loadFinds, requestFindsRefresh } from './screens/finds.js'
import { initCapture } from './screens/capture.js'
import { buildReviewGrid, initReview, restoreReviewDraft } from './screens/review.js'
import { initFindDetail } from './screens/find_detail.js'
import { initPhotoViewer } from './photo-viewer.js'
import { initImportReview, openNativeCamera, renderSessions, restoreImportSessions } from './screens/import_review.js'
import { clearImportSessions, clearImportSessionsStrict, loadImportSessions } from './import-store.js'
import { clearReviewDraftStrict, loadReviewDraft } from './review-draft-store.js'
import { forceCloseProfileOverlay, initProfile, loadProfile, openProfileOverlay, refreshHeaderProfileButtons } from './screens/profile.js'
import { AUTH_STATE, getAuthState, setAuthState } from './auth-state.js'
import { fetchProfileWithSignupRetry, isProfileComplete } from './profile-completion.js'
import { clearLocalDataOwner, resolveLocalDataOwner, setLocalDataOwner } from './local-data-owner.js'
import { initPeople, loadPeople } from './screens/people.js'
import { initAiCropEditor } from './ai-crop-editor.js'
import { loadMapScreen } from './map-loader.js'
import { fetchCloudPlanProfile } from './cloud-plan.js'
import { clearMediaUrlCache } from './images.js'
import { initDebugDashboard } from './debug-dashboard.js'
import { hideSettingsOverlay, showSettingsOverlay } from './settings-overlay.js'
import { isWebInatOAuthConfigured } from './inaturalist.js'
import { installIrisShutterDebugControls } from './iris-shutter.js'
import {
  connectInaturalist,
  forgetInaturalistSession,
  initializeInaturalistOAuth,
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
      await _resolveAndRouteForUser(user)
      _resolvedUsers.add(user.id)
      _authLog('session_resolution_completed', { source, ok: true })
      return { status: 'resolved' }
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

async function _resolveAndRouteForUser(user) {
  // Always show a neutral auth-resolution surface first so the previous
  // user's Home never flashes between sign-out and sign-in.
  setAuthState({ state: AUTH_STATE.RESOLVING, userId: user?.id || null })
  showAuthOverlay()
  _hideProfileResolutionError()

  const { profile, error } = await fetchProfileWithSignupRetry(user.id)
  if (error) {
    // A profile-fetch error is NOT a sign-out. Supabase still has a session;
    // silently converting a transient network/RLS failure into an
    // unauthenticated state hides the real problem and leaves the user
    // guessing. Keep the app blocked behind an error surface with explicit
    // Try again / Sign out actions.
    console.error('Profile fetch failed during auth resolution:', error)
    _showProfileResolutionError(user, error)
    return
  }
  const complete = isProfileComplete(profile)

  if (!complete) {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: user.id })
    // Boot the app shell so Profile setup has DOM to sit inside. Setup covers
    // the shell and blocks navigation. `onSetupCompleted` is called by the
    // setup save with the persisted row so we can refresh Home BEFORE the
    // overlay is dismissed — no blank/stale Home flash.
    await _ensureAppReadyForUser(user)
    hideAuthOverlay()
    navigate('home')
    await openProfileOverlay({
      setup: true,
      onSetupCompleted: async persisted => {
        // Home refresh is CRITICAL. Preload it BEFORE flipping auth state or
        // revealing anything, so a failure here leaves setup intact and the
        // user gets a retryable error instead of a blank Home.
        navigate('home')
        await refreshHome() // rethrows on failure → profile.js keeps setup open
        setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: persisted?.id || user.id })
        // Header avatar/initials are best-effort — the app is fully usable
        // if this fails and it will refresh naturally on the next navigate.
        try {
          await refreshHeaderProfileButtons({
            username: persisted?.username,
            display_name: persisted?.display_name,
            avatar_url: persisted?.avatar_url || '',
          })
        } catch (err) { console.warn('refreshHeaderProfileButtons after setup failed:', err) }
      },
      // The setup sign-out flow re-throws on failure; profile.js keeps the
      // overlay visible and surfaces the error. On success the SIGNED_OUT
      // handler force-closes the overlay.
      onSetupSignOut: async () => { await supabase.auth.signOut() },
    })
    return
  }

  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: user.id })
  await _ensureAppReadyForUser(user)
  hideAuthOverlay()
  navigate('home')
  // Force a fresh render so a lingering DOM from a previous sign-in on this
  // page cannot flash to the new user.
  try { await refreshHome() } catch (err) { console.warn('refreshHome on sign-in failed:', err) }
  try { await refreshHeaderProfileButtons() } catch (err) { console.warn('refreshHeaderProfileButtons on sign-in failed:', err) }
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
  runBootStep('header-profile-buttons', () => refreshHeaderProfileButtons())
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

async function init() {
  initDebugDashboard()

  await initializeInaturalistOAuth()
  _lockPortraitOrientation()
  document.addEventListener('pointerdown', _lockPortraitOrientation, { once: true, passive: true })

  if (getPlatform() !== 'android') {
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
  await registerNativeAuthLinkListener(async url => {
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

  const oauthCallbackResult = nativeCallbackResult
    || await maybeHandleSupabaseOAuthCallback(window.location.href)
  const initialSession = (await getSharedAuthSession({ refresh: true })) || oauthCallbackResult?.session || null

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
      } catch (err) {
        // resolveAuthenticatedSessionOnce already logged via safe phase log.
        // The profile-resolution error surface handles user-visible retry.
      }
      return
    }
    if (event === 'SIGNED_OUT') {
      clearSharedAuthSessionCache()
      _resolvedUsers.clear()
      _resolutionInFlight.clear()
      let purgeOk = true
      try {
        await _purgeUserDrafts()
      } catch (err) {
        purgeOk = false
        console.error('Draft purge on sign-out failed; owner marker preserved for next-boot retry:', _safeErrorCode(err))
      }
      await _clearInMemoryUserState()
      if (purgeOk) clearLocalDataOwner()
      try { forceCloseProfileOverlay() } catch (err) { console.warn('forceCloseProfileOverlay failed:', _safeErrorCode(err)) }
      _hideProfileResolutionError()
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

init()
