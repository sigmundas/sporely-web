import './style.css'
import './theme.js'   // applies saved theme immediately, no flash

// Startup instrumentation is imported as early as possible so `mark(...)`
// calls throughout boot can anchor to the module-load timestamp. The module
// itself performs no I/O.
import { mark as _bootMark, measure as _bootMeasure } from './boot-timings.js'
_bootMark('js-init-start')

import { supabase, SUPABASE_ORIGIN, hadEarlyBootSignOut, stopEarlyAuthEventCapture } from './supabase.js'
import { isExplicitAuthRejection, isTransportSessionError, probeBackendReachability } from './auth-classification.js'
import { getLocale, initI18n, onLocaleChange, setLocale, t } from './i18n.js'
import { state } from './state.js'
import { clearSharedAuthSessionCache, getSharedAuthSession, seedSharedAuthSession } from './auth-session.js'
import { consumeExplicitSignOutRequest, performExplicitSignOut } from './auth-signout.js'
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
  showAuthOverlayForReauth,
  switchToLogin,
  switchToResetPassword,
} from './screens/auth.js'
import { initHome, refreshHome, refreshHomeSafe, renderHomeFromCache, resetHomeSectionTracking } from './screens/home.js'
import { clearAllHomeCaches, clearHomeCache } from './home-cache.js'
import { initFinds, loadFinds, requestFindsRefresh, CONNECTIVITY_REVALIDATION_REQUEST_EVENT } from './screens/finds.js'
import { initCapture } from './screens/capture.js'
import { buildReviewGrid, initReview, restoreReviewDraft } from './screens/review.js'
import { initFindDetail } from './screens/find_detail.js'
import { initPhotoViewer } from './photo-viewer.js'
import { initImportReview, openNativeCamera, renderSessions, restoreImportSessions } from './screens/import_review.js'
import { clearImportSessions, clearImportSessionsStrict, loadImportSessions } from './import-store.js'
import { clearReviewDraftStrict, loadReviewDraft } from './review-draft-store.js'
import { forceCloseProfileOverlay, initProfile, loadProfile, openProfileOverlay, refreshHeaderProfileButtons, renderCachedHeaderProfileButtons } from './screens/profile.js'
import { setReauthHandler } from './reauth.js'
import { AUTH_STATE, getAuthState, isUserAlreadyResolved, setAuthState, subscribeAuthState } from './auth-state.js'
import { requireCloudMutation } from './capabilities.js'
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
  mergeCloudPlanForOfflineFallback,
  reviveCachedCloudPlan,
} from './cloud-plan.js'
import { clearMediaUrlCache } from './images.js'
import { notifyProtectedMediaSessionChange } from './protected-media.js'
import { clearAllCachedMedia, clearMediaCacheForUser } from './media-cache.js'
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
import { SYNC_SUCCESS_EVENT, triggerSync } from './sync-queue.js'
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
import { bindNativeNetworkMonitor, unbindNativeNetworkMonitor } from './native-network.js'

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
// Users the online resolution pipeline reached a terminal destination for
// (`complete-home` or `incomplete-profile-setup`) at least once this process
// lifetime. NB: presence in this set alone is NOT a signal the user is
// currently in a terminally resolved auth state — the process can transition
// through AUTHENTICATED_CACHED / AUTHENTICATED_REAUTH_REQUIRED and back
// without leaving/re-entering the set. The resolver dedupe must combine this
// with `isTerminallyResolvedAuthState(currentAuth.state)` — see
// `_isUserAlreadyResolved` and PLAN-startup.md "Round 5 — cached reconnect
// no-op regression".
const _resolvedUsers = new Set()       // userId (reached COMPLETE / INCOMPLETE at least once)

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
//
// STAGE B FINAL BEHAVIOR (spec L1):
//   * AUTHENTICATED_CACHED  → visible.
//   * AUTHENTICATED_REAUTH_REQUIRED → HIDDEN (backend reachable; the pill
//     would misinform the user that they are offline).
//   * AUTHENTICATED_COMPLETE / anything else → hidden.
//   * `navigator.onLine` is never consulted here.
//
// A subscription bound at boot mirrors the current auth-state onto the pill
// so `_syncCachedStateWithReachability` toggles that flip the state also
// flip the indicator without any extra call site.
function _setOfflineIndicator(visible) {
  try {
    const el = document.getElementById('app-offline-indicator')
    if (!el) return
    el.style.display = visible ? 'flex' : 'none'
    // Status-chip precedence (QA round 3): the Offline pill SUPERSEDES the
    // header Sync tag — never render both (they visually overlapped on
    // narrow Android widths). While CACHED, pending-upload state belongs to
    // the Finds queue cards; the Sync tag may only return via
    // checkSyncStatus() once the app is AUTHENTICATED_COMPLETE again.
    if (visible) {
      const syncTag = document.getElementById('header-sync-tag')
      if (syncTag) syncTag.style.display = 'none'
    }
  } catch (_) { /* DOM missing in test envs */ }
}

function _shouldShowOfflineIndicatorForState(stateValue) {
  return stateValue === AUTH_STATE.AUTHENTICATED_CACHED
}

let _offlineIndicatorSubscriptionBound = false
function _bindOfflineIndicatorToAuthState() {
  if (_offlineIndicatorSubscriptionBound) return
  _offlineIndicatorSubscriptionBound = true
  try {
    subscribeAuthState(next => {
      _setOfflineIndicator(_shouldShowOfflineIndicatorForState(next?.state))
    })
  } catch (err) { console.warn('offline-indicator subscription failed:', err) }
}
_bindOfflineIndicatorToAuthState()

// Field-offline reconnect: when the auth capability transitions from a
// cached / reauth-required reveal state to AUTHENTICATED_COMPLETE for the
// same user, drain the sync queue and reconcile the screens that rendered
// offline/reauth shells. This is the authoritative trigger — raw `online`
// events cannot upload because sync-queue.js gates triggerSync() on
// canPerformCloudMutation(). Duplicate starts are prevented by
// triggerSync()'s in-flight guard.
//
// Screen reconciliation is deliberately NOT gated on `state.currentScreen`:
// during Finds → Profile → login overlay → same-user reauth the transition
// fires while another surface is on top, and the stale REAUTH/offline
// rendering would otherwise persist until the user poked a tab. The Finds
// DOM exists regardless of the active screen, and `loadFinds()` guards
// itself with a sequence counter, so refreshing it here is race-safe.
// The header identity refresh runs HERE — after COMPLETE — because the
// in-place revalidation's own header call executes while the state is still
// CACHED/REAUTH, where the capability gate forces the cache-only initials
// render (device QA: avatar stayed initials until Profile was opened).
let _lastAuthCompleteUserId = null
let _reconnectSubscribeBound = false
function _bindReconnectTriggerToAuthState() {
  if (_reconnectSubscribeBound) return
  _reconnectSubscribeBound = true
  const cachedLike = new Set([AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED])
  let prev = getAuthState()?.state || AUTH_STATE.RESOLVING
  let prevUid = getAuthState()?.userId || null
  try {
    subscribeAuthState(next => {
      const nextState = next?.state
      const nextUid = next?.userId || null
      const wasCached = cachedLike.has(prev)
      if (nextState === AUTH_STATE.AUTHENTICATED_COMPLETE && nextUid) {
        const sameUser = prevUid === nextUid || _lastAuthCompleteUserId === nextUid
        const shouldTriggerReconnect = wasCached && sameUser
        _lastAuthCompleteUserId = nextUid
        if (shouldTriggerReconnect) {
          console.info('[sync] reconnect trigger (auth COMPLETE transition)')
          try { void triggerSync() } catch (err) { console.warn('reconnect triggerSync failed:', err) }
          try { requestFindsRefresh(0) } catch (err) { console.warn('reconnect requestFindsRefresh failed:', err) }
          void refreshHeaderProfileButtons().catch(err => console.warn('reconnect header refresh failed:', err))
        }
      }
      prev = nextState
      prevUid = nextUid
    })
  } catch (err) { console.warn('reconnect auth-state subscription failed:', err) }
}
_bindReconnectTriggerToAuthState()

// ── Single connectivity-revalidation entry point ─────────────────────────────
//
// Native network events, the native resume/getStatus check, the browser
// `online`/`focus`/`visibilitychange` fallbacks, the deferred re-probe and
// the bounded cached-mode watchdog ALL converge here. A burst of platform
// events therefore issues at most ONE backend revalidation:
//
//   * cached/reauth states → `_attemptCachedRevalidation(reason)`, which
//     holds the single `_cachedRevalidationInFlight` guard (one probe +
//     one session refresh per burst) and routes same-user recovery through
//     `resolveAuthenticatedSessionOnce` (per-user in-flight map).
//   * AUTHENTICATED_COMPLETE → nothing to revalidate; the signal is only a
//     nudge for the sync queue. `triggerSync()` self-dedupes an active pass
//     and re-checks `canPerformCloudMutation()` — device connectivity can
//     never bypass the capability gate.
//   * every other state (RESOLVING / UNAUTHENTICATED / INCOMPLETE) → no-op.
//
// `connected === true` from the OS is ONLY a wake-up signal: the actual
// transition to AUTHENTICATED_COMPLETE still requires the reachability
// probe + session refresh + profile revalidation pipeline to succeed.
// `options.force` (explicit user action, e.g. Finds pull-to-refresh) bypasses
// the automatic-attempt throttle — never the auth/capability gates or the
// single-flight guard.
function requestConnectivityRevalidation(reason, options = {}) {
  const current = getAuthState()
  console.info(`[auth] reconnect requested reason=${reason} state=${current.state}`)
  if (current.state === AUTH_STATE.AUTHENTICATED_COMPLETE) {
    console.info('[sync] reconnect trigger (already COMPLETE — queue nudge)')
    try { void triggerSync() } catch (err) { console.warn('connectivity sync nudge failed:', err) }
    return
  }
  void _attemptCachedRevalidation(reason, options)
}

// Manual recovery escape hatch (QA round 3): pull-to-refresh on Finds while
// the app is in a cached/reauth state dispatches this event instead of the
// doomed remote loader. It funnels into the SAME deduped + capability-gated
// revalidation entry point — it can never bypass auth gates, and a genuinely
// offline device simply stays on the offline queue view.
try {
  window.addEventListener(CONNECTIVITY_REVALIDATION_REQUEST_EVENT, event => {
    requestConnectivityRevalidation(
      String(event?.detail?.reason || 'manual-refresh'),
      { force: event?.detail?.force === true },
    )
  })
} catch (_) { /* no window in test envs */ }

// Native Capacitor builds: bind the OS connectivity monitor once for the app
// lifetime (no-op on web — the browser fallback listeners bound by the
// cached-revalidation scheduler further down and sync-queue's own
// `online`/`focus` listeners remain the web mechanism). Both the
// `networkStatusChange` false→true edge and the foreground
// `Network.getStatus()` check funnel into the deduped entry point above.
let _nativeNetworkMonitorRequested = false
function _bindNativeConnectivityMonitor() {
  if (_nativeNetworkMonitorRequested) return
  _nativeNetworkMonitorRequested = true
  void bindNativeNetworkMonitor({
    onConnectivityRestored: reason => requestConnectivityRevalidation(reason),
    onConnectivityLost: reason => handleConnectivityLost(reason),
  }).catch(err => console.warn('native network monitor bind failed:', err))
}
_bindNativeConnectivityMonitor()

// ── Single connectivity-LOSS entry point ─────────────────────────────────────
//
// QA round 2: airplane mode while AUTHENTICATED_COMPLETE previously left the
// app in a stale "online" state (Offline pill never shown, Finds ran doomed
// remote loaders, Save could surface transport errors). The native
// networkStatusChange true→false edge and the resume getStatus()===false
// check now converge here; on web the window `offline` event acts as the
// same LOSS HINT (navigator.onLine is never proof the backend IS reachable,
// but "the OS says we have no route" is a safe reason to stop pretending
// we are COMPLETE).
//
// Downgrade policy — COMPLETE → AUTHENTICATED_CACHED for the SAME user, only
// when the trusted local identity invariants hold:
//   1. auth state is AUTHENTICATED_COMPLETE with a userId,
//   2. state.user.id matches that userId,
//   3. the last-validated-account snapshot belongs to that user,
//   4. the local-data owner is that user.
// If any gate fails we fail closed: log and take NO action (never reveal
// cached data on a mismatched identity; the capability gate still protects
// writes). The downgrade NEVER signs out, never clears the Supabase session,
// trusted caches or queued work, and does not rebuild the shell — the
// existing auth-state subscriptions handle the consequences (Offline pill,
// capability denial, cached-mode watchdog arming, Finds offline swap below).
export function handleConnectivityLost(reason) {
  const current = getAuthState()
  if (current.state !== AUTH_STATE.AUTHENTICATED_COMPLETE) return { downgraded: false, reason: 'not-complete' }
  const uid = current.userId
  if (!uid || state.user?.id !== uid) {
    console.warn('connectivity loss: identity invariant failed (state.user mismatch); no downgrade')
    return { downgraded: false, reason: 'user-mismatch' }
  }
  let snapshot
  try { snapshot = readLastValidatedAccount() } catch (_) { snapshot = null }
  if (!snapshot?.userId || snapshot.userId !== uid) {
    console.warn('connectivity loss: no trusted snapshot for current user; no downgrade')
    return { downgraded: false, reason: 'snapshot-mismatch' }
  }
  let owner
  try { owner = getLocalDataOwner() } catch (_) { owner = null }
  if (owner !== uid) {
    console.warn('connectivity loss: local-data owner mismatch; no downgrade')
    return { downgraded: false, reason: 'owner-mismatch' }
  }
  _authLog('connectivity_lost_downgrade', { reason, userId: uid })
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: uid })
  // Finds must follow the loss immediately: re-render swaps to the offline
  // shell; the load-sequence guard in loadFinds() discards any in-flight
  // stale remote results.
  if (state.currentScreen === 'finds') {
    try { requestFindsRefresh(0) } catch (err) { console.warn('offline finds swap failed:', err) }
  }
  return { downgraded: true, reason }
}

// Web/PWA loss hint: `offline` fires when the OS reports no network route.
// Bound once; harmless on native (the plugin edge usually fires first and
// handleConnectivityLost self-guards on auth state).
try {
  window.addEventListener('offline', () => { void handleConnectivityLost('window-offline') })
} catch (_) { /* no window in test envs */ }

// ── Bounded cached-mode reconnect watchdog ───────────────────────────────────
//
// QA round 4: the round-3 watchdog gated the backend probe on
// `Network.getStatus().connected === true` — on the test device that status
// never turned true (stale/undelivered plugin state), so NO backend probe
// was ever attempted and a live airplane-off left the app CACHED until a
// process restart. Device QA has now proven twice that native connectivity
// state is not reliable enough to be a PREREQUISITE for recovery.
//
// The watchdog is therefore a direct, simple backend-probe loop:
//   while auth === AUTHENTICATED_CACHED AND app visible AND same trusted
//   user → every ~15s → requestConnectivityRevalidation('cached-watchdog')
//   → probeBackendReachability() (the actual authority) → unreachable:
//   remain CACHED; reachable: session refresh → same user →
//   AUTHENTICATED_COMPLETE → triggerSync() + Finds refresh.
//
// This is intentionally a real HTTP probe. Acceptable because it runs ONLY
// while CACHED, ONLY foregrounded, ONLY every ~15s, and stops the moment the
// state leaves AUTHENTICATED_CACHED (COMPLETE / REAUTH_REQUIRED /
// UNAUTHENTICATED / account transition → RESOLVING / sign-out) or the app is
// hidden. It never polls in healthy COMPLETE or in REAUTH_REQUIRED.
// navigator.onLine, Capacitor Network.connected and networkStatusChange are
// WAKE-UP HINTS ONLY (fast path) — none of them gate this loop.
export const CACHED_WATCHDOG_INTERVAL_MS = 15_000
let _cachedWatchdogTimer = null
let _cachedWatchdogBound = false

function _stopCachedRevalidationWatchdog() {
  if (_cachedWatchdogTimer) {
    clearTimeout(_cachedWatchdogTimer)
    _cachedWatchdogTimer = null
  }
}

function _cachedWatchdogEligible() {
  const current = getAuthState()
  if (current.state !== AUTH_STATE.AUTHENTICATED_CACHED) return false
  if (!current.userId || state.user?.id !== current.userId) return false
  try {
    if (document.visibilityState !== 'visible') return false
  } catch (_) { return false }
  return true
}

function _cachedWatchdogTick() {
  _cachedWatchdogTimer = null
  if (!_cachedWatchdogEligible()) return
  console.info('[network] cached watchdog tick')
  // Direct backend revalidation attempt — NO Network.getStatus / onLine
  // prerequisite. The single-flight guard + automatic-attempt throttle in
  // _attemptCachedRevalidation dedupe this against event-driven wake-ups.
  requestConnectivityRevalidation('cached-watchdog')
  if (!_cachedWatchdogEligible()) return
  _armCachedRevalidationWatchdog()
}

function _armCachedRevalidationWatchdog() {
  if (_cachedWatchdogTimer) return
  if (!_cachedWatchdogEligible()) return
  _cachedWatchdogTimer = setTimeout(() => { _cachedWatchdogTick() }, CACHED_WATCHDOG_INTERVAL_MS)
}

function _bindCachedRevalidationWatchdog() {
  if (_cachedWatchdogBound) return
  _cachedWatchdogBound = true
  try {
    subscribeAuthState(next => {
      if (next?.state === AUTH_STATE.AUTHENTICATED_CACHED) _armCachedRevalidationWatchdog()
      else _stopCachedRevalidationWatchdog()
    })
  } catch (err) { console.warn('watchdog auth-state subscription failed:', err) }
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _armCachedRevalidationWatchdog()
      else _stopCachedRevalidationWatchdog()
    })
  } catch (_) { /* DOM missing in test envs */ }
}
_bindCachedRevalidationWatchdog()

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
    // Stage B final: never let a FALLBACK plan clobber a known-good
    // CACHED/NETWORK plan. The merge helper picks the authoritative one.
    const next = await fetchCloudPlanProfile(uid)
    state.cloudPlan = mergeCloudPlanForOfflineFallback(state.cloudPlan, next)
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
      // Stage B: the persistent media blob cache is cleared in full too.
      // The revoked cached-shell state means we lose warmed thumbnails on
      // the next launch until an online refresh, but that is the explicit
      // user intent of "Clear local cache".
      await clearAllCachedMedia()
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
  // Skip only when the user has previously reached a terminally resolved
  // destination (COMPLETE / INCOMPLETE) AND the current auth state is still
  // that terminal state for the same user. CACHED / REAUTH_REQUIRED are
  // NOT terminal — falling through lets `_resolveAndRouteForUser` take the
  // in-place revalidation branch and lift the state back to COMPLETE.
  if (isUserAlreadyResolved(user.id, _resolvedUsers, currentAuth)) {
    return Promise.resolve({ status: 'noop' })
  }

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
  // Stage B device-QA regression fix: the initial ONLINE resolution held a
  // locally persisted session, but the profile fetch failed against an
  // unreachable backend, and the trusted cached shell was revealed instead
  // for the SAME user. Deliberately NOT a success status —
  // `resolveAuthenticatedSessionOnce` must not mark the user resolved, so
  // the existing cached-revalidation triggers re-run the full pipeline on
  // reconnect (which takes the same-user in-place path to COMPLETE).
  CACHED_OFFLINE_FALLBACK: 'cached-offline-fallback',
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
  // The REAUTH_REQUIRED recovery flow signs in over the visible cached shell
  // via the auth overlay; a successful same-user reauth lands here, so the
  // overlay must be dismissed. No-op when it was never shown. Guarded so a
  // background revalidation can never dismiss an in-progress password reset.
  if (document.getElementById('reset-password-form')?.style.display !== 'block') {
    hideAuthOverlay()
  }
  _authLog('in_place_revalidation_completed', {})

  void (async () => {
    let cloudPlan = null
    try { cloudPlan = await fetchCloudPlanProfile(user.id) }
    catch (err) { console.warn('[cached-auth] cloud plan fetch on in-place revalidation failed:', err) }
    if (cloudPlan) state.cloudPlan = mergeCloudPlanForOfflineFallback(state.cloudPlan, cloudPlan)
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
    // Stage B device-QA regression fix: `supabase.auth.getSession()` returns
    // a locally persisted session even in airplane mode, so an offline cold
    // start lands HERE (transport-failed profile fetch) instead of in
    // `_tryCachedAuthenticatedBoot`. Attempt the trusted cached-shell
    // fallback — SAME user only, and only when a post-failure probe confirms
    // the backend is unreachable — before surfacing the blocking error.
    let fallback
    try {
      fallback = await _tryCachedFallbackAfterProfileFetchFailure({ user, error, generation })
    } catch (fallbackErr) {
      console.warn('Cached fallback after profile-fetch failure threw; keeping error surface:', fallbackErr)
      fallback = 'denied'
    }
    if (fallback === 'revealed') return { status: RESOLUTION_STATUS.CACHED_OFFLINE_FALLBACK }
    if (fallback === 'stale') return { status: RESOLUTION_STATUS.STALE }
    // The fallback may have awaited its reachability probe — re-verify the
    // transition so a superseded resolution never paints the error surface
    // over a newer account's UI.
    if (!isCurrentAccountTransition(generation, expectedUserId, user.id)) {
      _authLog('stale_account_result_discarded', { source: 'profile_fetch_error_surface' })
      return { status: RESOLUTION_STATUS.STALE }
    }
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
      onSetupSignOut: async () => { await performExplicitSignOut() },
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
    if (cloudPlan) state.cloudPlan = mergeCloudPlanForOfflineFallback(state.cloudPlan, cloudPlan)
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
    try { await performExplicitSignOut() }
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
    // Stage B: clear the previous user's persistent media blobs on account
    // switch too. The store is userId-keyed so B can never read A's blobs
    // even if this delete fails — but explicit cleanup keeps quotas
    // predictable.
    if (!(await clearMediaCacheForUser(previousUserId))) {
      console.warn('Media cache clear on account switch failed; entries remain user-scoped.')
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
        // Stage B2b: iNat linking runs OAuth against a live authenticated
        // session. Refuse in CACHED / REAUTH_REQUIRED so we don't init the
        // lazy SocialLogin plugin for a doomed request. Note: Stage A's
        // lazy loader is untouched — the plugin still only imports on
        // demand for legitimate connects.
        if (!requireCloudMutation({ showToast }).allowed) return
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
        // Forgetting the local iNat session is a local mutation only —
        // intentionally NOT gated by capability. It removes local tokens
        // so the user can end their linked-session offline.
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

  // Boot-time diagnostics: auth-js `initialize()` may have removed a stored
  // session and emitted SIGNED_OUT before main.js subscribed (non-retryable
  // refresh rejection — e.g. rotation race). Distinguish that from "no
  // session was ever stored" so the limbo is explainable next time.
  const earlySignOut = hadEarlyBootSignOut()

  // Server-confirmed rejection: the session is genuinely unrecoverable, but
  // this device holds trusted SAME-USER local data (owner === snapshot,
  // checked above) which may include queued observations. Reveal the cached
  // shell in AUTHENTICATED_REAUTH_REQUIRED — capability gates keep all cloud
  // ops blocked, and the Profile sheet surfaces "Sign in again". Falling
  // through to the bare login overlay here would hide local work and give a
  // rejection the same UX as a fresh install. A rejection implies the server
  // answered, so it doubles as a reachability proof — no probe needed.
  if (sessionError && _isExplicitAuthRejection(sessionError)) {
    _authLog('cached_boot_auth_reject_reauth', { code: _safeErrorCode(sessionError), earlySignOut })
    await _revealTrustedCachedShell({
      snapshot,
      targetState: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED,
      reachability: 'reachable',
      reason: 'auth-rejected',
    })
    return true
  }

  // Reachability probe drives the state selection. Do it BEFORE any DOM
  // changes so an unreachable-with-transient-throw scenario still routes
  // through the same code path.
  _bootMark('reachability-probe-started', { sessionThrown: !!sessionError })
  let reachability = 'unreachable'
  try { reachability = await probe() }
  catch (_) { reachability = 'unreachable' }
  _bootMark('reachability-probe-completed', { reachability })
  _authLog('reachability_probe', { hasHashError: !!hasHashError, reachability, sessionThrown: !!sessionError, earlySignOut })

  const targetState = reachability === 'reachable'
    ? AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
    : AUTH_STATE.AUTHENTICATED_CACHED

  // If the backend is REACHABLE but our session is missing, the reveal below
  // enters AUTHENTICATED_REAUTH_REQUIRED and the user reauths (or the
  // reconnect triggers pick up a materialized session). If UNREACHABLE, the
  // reveal enters AUTHENTICATED_CACHED and schedules the reconnect triggers
  // so a network heal transitions us out of cached mode.
  await _revealTrustedCachedShell({
    snapshot,
    targetState,
    reachability,
    reason: sessionError ? 'transport-error' : (earlySignOut ? 'session-removed-at-init' : 'no-session'),
  })
  // Both 'revealed' and 'stale' count as handled: a stale reveal means a
  // newer online transition is now in charge — do NOT fall through to the
  // unauthenticated flow.
  return true
}

// Stage B device-QA regression fix (persisted-local-session offline cold
// start). `supabase.auth.getSession()` returns a locally persisted session
// even in airplane mode, so the initial boot takes the ONLINE resolution
// path; its profile fetch then fails with a transport error ("TypeError:
// Failed to fetch") and previously surfaced the blocking profile-resolution
// error — the MOST COMMON offline launch never reached AUTHENTICATED_CACHED.
//
// This helper runs ONLY after a profile-resolution failure inside
// `_resolveAndRouteForUser` — never on the healthy path, so Stage A startup
// performance is untouched (ZERO reachability probes when the profile fetch
// succeeds).
//
// The cached fallback is allowed ONLY when ALL of these hold:
//   1. the profile-fetch error is NOT a server-confirmed auth rejection
//      (explicit rejection keeps the existing rejection/sign-out semantics)
//      AND the error is transport-shaped — a well-formed server failure
//      (RLS / schema / server bug) must keep the blocking error surface;
//   2. `readLastValidatedAccount()` returns a valid snapshot;
//   3. the snapshot belongs to the SAME user as the local session
//      (`snapshot.userId === user.id`) — never reveal another user's cache;
//   4. `getLocalDataOwner() === user.id` (Stage B1 privacy boundary);
//   5. a reachability probe — run only NOW, after the failure — classifies
//      the backend as unreachable. A reachable backend means the failure is
//      real and must stay visible (never disguise server errors as offline).
//
// Returns:
//   'revealed' — the trusted cached shell is up (single shared reveal path).
//   'stale'    — a newer account transition superseded us; nothing painted.
//   'denied'   — conditions not met; the caller keeps the existing blocking
//                profile-resolution error surface.
async function _tryCachedFallbackAfterProfileFetchFailure({ user, error, generation, probe = probeBackendReachability }) {
  if (!user?.id) return 'denied'
  // Gate 1 — error classification. Synchronous, zero network.
  if (_isExplicitAuthRejection(error)) {
    _authLog('cached_fallback_skipped_auth_reject', { code: _safeErrorCode(error) })
    return 'denied'
  }
  if (!_isTransportSessionError(error)) {
    _authLog('cached_fallback_skipped_non_transport', { code: _safeErrorCode(error) })
    return 'denied'
  }
  // Gates 2–4 — trusted local identity for the SAME user. Synchronous,
  // zero network. Unlike `_tryCachedAuthenticatedBoot` (which has no session
  // and trusts owner === snapshot alone), this path holds a session user and
  // requires BOTH markers to equal that exact user id.
  const snapshot = readLastValidatedAccount()
  if (!snapshot) {
    _authLog('cached_fallback_skipped_no_snapshot', {})
    return 'denied'
  }
  if (snapshot.userId !== user.id) {
    _authLog('cached_fallback_snapshot_user_mismatch', {})
    return 'denied'
  }
  const owner = getLocalDataOwner()
  if (!owner || owner !== user.id) {
    _authLog('cached_fallback_owner_mismatch', { hasOwner: !!owner })
    return 'denied'
  }
  // Gate 5 — reachability. This probe exists ONLY on this failure path.
  _bootMark('reachability-probe-started', { trigger: 'profile-fetch-failure' })
  let reachability
  try { reachability = await probe() }
  catch (_) { reachability = 'unreachable' }
  _bootMark('reachability-probe-completed', { reachability, trigger: 'profile-fetch-failure' })
  _authLog('cached_fallback_probe', { reachability })
  if (reachability !== 'unreachable') {
    _authLog('cached_fallback_skipped_backend_reachable', {})
    return 'denied'
  }
  // Stale-async safety: the probe awaited — a newer account transition may
  // own the UI now. The reveal below opens its own transition generation;
  // never open one over a newer transition's back.
  if (!isCurrentAccountTransition(generation, user.id, user.id)) {
    _authLog('stale_account_result_discarded', { source: 'cached_fallback_probe' })
    return 'stale'
  }
  // Backend unreachable + trusted same-user snapshot → the fallback always
  // reveals AUTHENTICATED_CACHED (never REAUTH_REQUIRED — that state is for
  // "reachable but no session", which cannot be this branch).
  return _revealTrustedCachedShell({
    snapshot,
    targetState: AUTH_STATE.AUTHENTICATED_CACHED,
    reachability,
    reason: 'profile-fetch-transport',
  })
}

// ── SINGLE trusted cached-shell reveal ───────────────────────────────────────
//
// Both cached entry points converge here so there is exactly ONE
// implementation of "reveal the shell from the persisted snapshot":
//
//   1. `_tryCachedAuthenticatedBoot` — no usable local session at boot
//      (Stage B1: null session, or getSession() threw a transport error).
//   2. `_tryCachedFallbackAfterProfileFetchFailure` — a locally persisted
//      session EXISTS but the initial online resolution failed against an
//      unreachable backend (the airplane-mode cold start observed in
//      device QA).
//
// Callers own ALL trust decisions (snapshot validity, owner match, same-user
// equality, rejection classification, reachability). This function only
// performs the reveal — and re-verifies its own account-transition
// generation at every await boundary so a superseded reveal paints nothing.
//
// Returns 'revealed' when the cached shell is up, or 'stale' when a newer
// account transition took over mid-flight.
async function _revealTrustedCachedShell({ snapshot, targetState, reachability, reason }) {
  _bootMark('cached-auth-selected', {
    hasCloudPlan: !!snapshot.cloudPlan,
    reachability,
    reason,
    targetState,
  })
  _authLog('cached_boot_selected', {
    hasCloudPlan: !!snapshot.cloudPlan,
    reachability,
    reason,
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
  try { forceCloseProfileOverlay() } catch (err) { console.warn('forceCloseProfileOverlay in cached reveal failed:', err) }
  _hideProfileResolutionError()

  // Init the shell + restore drafts behind the blocker.
  await _ensureAppReadyForUser(state.user)
  if (!isCurrentAccountTransition(generation, expectedUserId, state.user?.id)) {
    _authLog('cached_boot_stale', { source: 'ensure_ready' })
    return 'stale'
  }

  // Paint header chrome from cached profile summary (synchronous, no
  // Supabase). Never attempt a signed-URL avatar here — the loader would
  // require a network fetch that we know is failing.
  try {
    renderCachedHeaderProfileButtons(snapshot.profileSummary, { email: snapshot.email })
    _bootMark('cached-header-rendered')
  } catch (err) {
    console.warn('renderCachedHeaderProfileButtons in cached reveal failed:', err)
  }

  setAuthState({ state: targetState, userId: snapshot.userId })
  navigate('home')
  _bootMark('app-shell-initialized')
  hideAuthOverlay()
  hideAccountTransitionBlocker()
  // Offline pill follows the Stage B FINAL matrix (L1): visible for
  // AUTHENTICATED_CACHED, hidden for AUTHENTICATED_REAUTH_REQUIRED (backend
  // reachable — the pill would misinform). The auth-state subscription
  // mirrors this too; the explicit call keeps reveal timing deterministic.
  _setOfflineIndicator(_shouldShowOfflineIndicatorForState(targetState))
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
      console.warn('Cached Home render on cached reveal failed:', err)
    }
  })()

  // Reuse the existing reconnect machinery — listeners bind once, and the
  // single deferred re-probe only schedules when the backend was UNREACHABLE.
  _scheduleCachedRevalidation({ initialReachability: reachability })
  return 'revealed'
}

let _cachedRevalidationListenersBound = false
let _cachedRevalidationInFlight = false
let _deferredReprobeScheduled = false

// Browser/window fallback wake-up listeners for the revalidation pipeline.
// QA round 4 audit: these were previously bound only inside
// `_scheduleCachedRevalidation`, which runs only on the cached BOOT reveal
// paths — so a RUNTIME COMPLETE→CACHED downgrade (start online → airplane →
// restore) had NO `online`/`focus`/`visibility` wake-ups at all; recovery
// depended entirely on the native plugin event (unreliable on device) and
// the status-gated round-3 watchdog. Bound at module init instead, once.
// All wake-ups converge on the same deduped + throttled entry point; a
// wake-up in a non-cached state is a no-op (or a COMPLETE queue nudge).
function _bindRevalidationWakeupListeners() {
  if (_cachedRevalidationListenersBound) return
  _cachedRevalidationListenersBound = true
  const trigger = reason => requestConnectivityRevalidation(reason)
  try {
    window.addEventListener('online', () => trigger('web-online'))
  } catch (_) { /* no window in test envs */ }
  try {
    window.addEventListener('focus', () => trigger('focus'))
  } catch (_) { /* no window in test envs */ }
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') trigger('visibility')
    })
  } catch (_) { /* DOM missing in test envs */ }
}
_bindRevalidationWakeupListeners()

function _scheduleCachedRevalidation({ initialReachability = 'unreachable' } = {}) {
  _bindRevalidationWakeupListeners()
  // Single deferred re-probe. Only scheduled when the initial probe said
  // UNREACHABLE — a reachable backend already produced a definitive answer
  // (the state is AUTHENTICATED_REAUTH_REQUIRED and no timer will fix that;
  // the user has to sign in or the reconnect triggers materialize a fresh
  // session). This replaces the earlier unconditional 3s retry that fired
  // even when the state was already known.
  if (!_deferredReprobeScheduled && initialReachability === 'unreachable') {
    _deferredReprobeScheduled = true
    setTimeout(() => { void _attemptCachedRevalidation('deferred-probe') }, 5000)
  }
}

// Throttle AUTOMATIC backend revalidation attempts (QA round 4): the 15s
// cached watchdog plus a burst of event wake-ups (native change / resume /
// visibility / web online) must produce at most ~one probe + session refresh
// per interval. Kept slightly BELOW the watchdog interval so consecutive
// watchdog ticks are never skipped by timer jitter. Explicit user actions
// (Finds pull-to-refresh → { force: true }) bypass the throttle for an
// immediate retry — never the cached-state gate or the single-flight guard.
export const CACHED_REVALIDATION_MIN_RETRY_MS = 12_000
const USER_INITIATED_REVALIDATION_REASONS = new Set(['finds-pull-refresh'])
let _lastRevalidationAttemptAt = 0

async function _attemptCachedRevalidation(source, { force = false } = {}) {
  if (_cachedRevalidationInFlight) return
  const current = getAuthState()
  const cachedStates = new Set([AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED])
  if (!cachedStates.has(current.state)) return
  const now = Date.now()
  if (!force
    && !USER_INITIATED_REVALIDATION_REASONS.has(source)
    && now - _lastRevalidationAttemptAt < CACHED_REVALIDATION_MIN_RETRY_MS) {
    return
  }
  _lastRevalidationAttemptAt = now
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
    console.info(`[auth] reconnect probe reachable=${reachability === 'reachable'}`)

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
        // Server said no — the session is unrecoverable. Do NOT sign out
        // here: signOut fires the SIGNED_OUT purge (drafts, snapshot, owner
        // marker, caches) and would silently destroy observations queued
        // while in cached/limbo mode. Pin AUTHENTICATED_REAUTH_REQUIRED
        // instead — capability gates keep every cloud op blocked, and the
        // Profile sheet surfaces the explicit "Sign in again" recovery
        // action. A rejection implies the server answered → reachable.
        _syncCachedStateWithReachability(current.userId, 'reachable')
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
    console.info(`[auth] reconnect session same-user=${session.user.id === current.userId}`)
    try {
      await resolveAuthenticatedSessionOnce(session, `cached_revalidation:${source}`)
      _bootMark('revalidation-completed')
      _authLog('cached_revalidation_completed', { ok: true })
      console.info(`[auth] reconnect state ${getAuthState()?.state === AUTH_STATE.AUTHENTICATED_COMPLETE ? 'COMPLETE' : 'CACHED'}`)
    } catch (err) {
      _authLog('cached_revalidation_completed', { ok: false, code: _safeErrorCode(err) })
      console.info('[auth] reconnect state CACHED (resolve failed)')
    }
  } finally {
    _cachedRevalidationInFlight = false
  }
}

// A SIGNED_OUT may only be downgraded to REAUTH_REQUIRED (instead of the
// full purge) when EVERY trust marker agrees on one user: a valid snapshot,
// the local-data-owner marker, the live auth state, and the in-memory user.
// Any mismatch fails closed to the ordinary purge path — never retain data
// across an ambiguous identity boundary.
function _isInternalSessionLossForTrustedUser() {
  const current = getAuthState()
  const authedStates = new Set([
    AUTH_STATE.AUTHENTICATED_COMPLETE,
    AUTH_STATE.AUTHENTICATED_CACHED,
    AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED,
  ])
  if (!authedStates.has(current.state)) return false
  let snapshot = null
  try { snapshot = readLastValidatedAccount() } catch (_) { return false }
  if (!snapshot?.userId) return false
  const owner = getLocalDataOwner()
  return owner === snapshot.userId
    && current.userId === snapshot.userId
    && state.user?.id === snapshot.userId
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

  // REAUTH_REQUIRED recovery: every "Sign in again" surface (Profile sheet,
  // Home banner, Finds notice) routes through the single
  // `beginReauthentication()` seam in reauth.js, whose handler is injected
  // here. Authenticate FIRST — never signOut() — so queued observations,
  // drafts, and the trusted same-user snapshot survive. A successful
  // sign-in fires SIGNED_IN → resolveAuthenticatedSessionOnce → same-user
  // in-place revalidation → AUTHENTICATED_COMPLETE (queue drain + screen
  // reconciliation bound to that transition). A different-user sign-in
  // takes the existing full account-transition boundary unchanged.
  setReauthHandler(prefillEmail => {
    ensureAuthUiInitialized(true)
    switchToLogin(prefillEmail || state.user?.email || '')
    showAuthOverlayForReauth()
  })

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
      // Classify BEFORE purging: auth-js emits SIGNED_OUT on its own when it
      // removes an unrecoverable stored session (non-retryable refresh
      // rejection — rotation race / server-side revocation), with no app
      // code asking to sign out. Purging on that event would destroy
      // observations/drafts queued while cached/limbo. Only an explicit
      // app-initiated sign-out keeps the full purge semantics; internal
      // session loss for the trusted same-user shell pins REAUTH_REQUIRED
      // so the Profile sheet's "Sign in again" recovery applies.
      const explicitSignOut = consumeExplicitSignOutRequest()
      if (!explicitSignOut && _isInternalSessionLossForTrustedUser()) {
        const current = getAuthState()
        clearSharedAuthSessionCache()
        _resolvedUsers.delete(current.userId)
        setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: current.userId })
        _setOfflineIndicator(false)
        _authLog('signed_out_internal_session_loss', { fromState: current.state })
        return
      }
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
      // Stage B: the persistent media blob cache is user-scoped. Explicit
      // sign-out clears this user's media unconditionally (not blocked by
      // draft-purge failure). Delete failures are only logged — the store
      // is userId-keyed, so remnants cannot leak into another user's
      // session anyway, and the next successful online sign-in as the
      // same user will overwrite them.
      const mediaCleared = signedOutUserId
        ? await clearMediaCacheForUser(signedOutUserId)
        : await clearAllCachedMedia()
      if (!mediaCleared) console.warn('Media cache clear on sign-out failed; entries remain userId-keyed.')
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
    notifyProtectedMediaSessionChange(event, session)
    setTimeout(() => {
      enqueueAuthEvent(event, session, _handleDeferredAuthEvent)
    }, 0)
  })
  _authStateSubscription = subscription
  // The app's subscription is live — the early-boot capture window (events
  // emitted during auth-js initialize(), before this line) is over.
  stopEarlyAuthEventCapture()

  window.addEventListener('pagehide', () => {
    _authStateSubscription?.unsubscribe?.()
    _authStateSubscription = null
    _stopCachedRevalidationWatchdog()
    void unbindNativeNetworkMonitor()
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
