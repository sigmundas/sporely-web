import './style.css'
import './theme.js'   // applies saved theme immediately, no flash
import { Preferences } from '@capacitor/preferences'

import { supabase } from './supabase.js'
import { getLocale, initI18n, onLocaleChange, setLocale, t } from './i18n.js'
import { state } from './state.js'
import { startGeo } from './geo.js'
import { navigate } from './router.js'
import { applyTheme } from './theme.js'
import { showToast } from './toast.js'
import {
  clearPasswordRecoveryHint,
  getInitialAuthState,
  hasPasswordRecoveryHint,
  initAuth,
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
import { buildReviewGrid, initReview } from './screens/review.js'
import { initFindDetail } from './screens/find_detail.js'
import { initPhotoViewer } from './photo-viewer.js'
import { initImportReview, openNativeCamera, renderSessions, restoreImportSessions } from './screens/import_review.js'
import { clearImportSessions, loadImportSessions } from './import-store.js'
import { initProfile, loadProfile, refreshHeaderProfileButtons } from './screens/profile.js'
import { initPeople, loadPeople } from './screens/people.js'
import { initAiCropEditor } from './ai-crop-editor.js'
import { loadMapScreen } from './map-loader.js'
import { fetchCloudPlanProfile, getStoredImageResolutionMode, setStoredImageResolutionMode } from './cloud-plan.js'
import { clearMediaUrlCache } from './images.js'
import { isWebInatOAuthConfigured } from './inaturalist.js' // Assuming this function exists in inaturalist.js
import {
  buildInaturalistAuthorizationUrl,
  completeInaturalistOAuthCallback,
  forgetInaturalistSession,
  loadInaturalistSession,
  parseInaturalistCallbackUrl,
} from './inaturalist.js'
import { SYNC_SUCCESS_EVENT, triggerSync } from './sync-queue.js'
import {
  getArtsorakelMaxEdge,
  getDefaultVisibility,
  getDefaultIdService,
  setDefaultIdService,
  getPhotoGapMinutes,
  setArtsorakelMaxEdge,
  setDefaultVisibility,
  setLastSyncAt,
  setPhotoGapMinutes,
  getUseSystemCamera,
  setUseSystemCamera,
} from './settings.js'
import { initCameraFallbackWarning, openPreferredCamera, setNativeCameraOpener, getEffectiveCameraLabel, isAndroidNativeApp } from './camera-actions.js'
import { isAndroidApp } from './platform.js'

initI18n()
setNativeCameraOpener(openNativeCamera)

let _syncFeedbackBound = false
let _appBootstrapped = false

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
    _blurActiveControl()
    _syncSettingsUI()
    overlay.style.display = 'block'
    overlay.setAttribute('aria-hidden', 'false')
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
    overlay.classList.remove('open')
    overlay.setAttribute('aria-hidden', 'true')
    overlay.addEventListener('transitionend', () => { overlay.style.display = 'none' }, { once: true })
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
    _setPhotoGap(current <= 1 ? current - (5 / 60) : current - 1)
  })
  document.getElementById('settings-gap-increment')?.addEventListener('click', () => {
    const current = Number.parseFloat(gapInput.value || 1)
    let next = current < 1 ? current + (5 / 60) : current + 1
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

  document.querySelectorAll('.settings-resolution-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      setStoredImageResolutionMode(btn.dataset.imageResolutionMode)
      await _refreshSettingsCloudPlan()
      if (state.currentScreen === 'profile') loadProfile()
    })
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

  // ID service segment buttons
  document.querySelectorAll('.settings-id-service-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setDefaultIdService(btn.dataset.idService)
      _syncSettingsUI()
    })
  })

  const hdrToggle = document.getElementById('settings-hdr-toggle')
  const nativeCameraRows = [
    document.getElementById('settings-camera-label'),
    document.getElementById('settings-hdr-row'),
  ]
  nativeCameraRows.forEach(row => {
    if (row) row.style.display = isAndroidApp() ? '' : 'none'
  })
  if (hdrToggle) {
    Preferences.get({ key: 'useHdr' }).then(({ value }) => {
      hdrToggle.checked = getUseSystemCamera() ? false : value !== 'false'
    })
    hdrToggle.addEventListener('change', event => {
      Preferences.set({ key: 'useHdr', value: event.target.checked ? 'true' : 'false' })
    })
  }

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
  const current = localStorage.getItem('sporely-theme') || 'dark'
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

  const resolutionSection = document.getElementById('settings-image-resolution-section')
  const isPro = state.cloudPlan?.cloudPlan === 'pro' || !!state.cloudPlan?.fullResStorageEnabled
  if (resolutionSection) resolutionSection.style.display = isPro ? '' : 'none'

  const selectedResolution = state.cloudPlan?.imageResolutionMode || getStoredImageResolutionMode()
  document.querySelectorAll('.settings-resolution-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imageResolutionMode === selectedResolution)
  })

  const defaultVisibility = getDefaultVisibility()
  document.querySelectorAll('.settings-default-visibility-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.defaultVisibility === defaultVisibility)
  })

  const useSystemCamera = getUseSystemCamera()
  document.querySelectorAll('.settings-camera-app-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cameraApp === (useSystemCamera ? 'native' : 'sporely'))
  })
  const acCameraLabel = document.querySelector('#ac-camera .action-card-label')

  const defaultIdService = getDefaultIdService()
  document.querySelectorAll('.settings-id-service-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.idService === defaultIdService)
  })

  if (acCameraLabel) acCameraLabel.textContent = getEffectiveCameraLabel()

  const hdrToggle = document.getElementById('settings-hdr-toggle')
  const hdrRow = document.getElementById('settings-hdr-row')
  if (hdrToggle) {
    hdrToggle.disabled = useSystemCamera
    if (useSystemCamera) {
      hdrToggle.checked = false
    } else {
      Preferences.get({ key: 'useHdr' }).then(({ value }) => {
        if (!getUseSystemCamera()) hdrToggle.checked = value !== 'false'
      })
    }
    hdrRow?.classList.toggle('settings-row-disabled', useSystemCamera)
  }
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
    loadPeople()
  })
  ;['home-profile-btn', 'finds-profile-btn', 'map-profile-btn', 'people-profile-btn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      navigate('profile')
      loadProfile()
    })
  })
}

async function bootApp(user) {
  state.user = user
  hideAuthOverlay()
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
          const authUrl = await buildInaturalistAuthorizationUrl();
          window.location.href = authUrl;
        } catch (error) {
          showToast(error.message);
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
  runBootStep('geolocation', () => startGeo())
  runBootStep('inaturalist-ui', () => _syncInaturalistUi()) // Initial sync of iNaturalist UI
  runBootStep('identify-labels', () => syncIdentifyButtonLabels())

  navigate('home')

  runBootStep('profile-check', async () => {
    for (let i = 0; i < 3; i++) {
      const { data } = await supabase.from('profiles').select('id').eq('id', user.id).single()
      if (data) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    console.warn('Profile not found for user, proceeding anyway.', user.id)
  })

  runBootStep('pending-import-restore', async () => {
    const pending = await loadImportSessions()
    if (pending.length) restoreImportSessions(pending)
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
  if (state.currentScreen === 'people') loadPeople()
  if (state.currentScreen === 'profile') loadProfile()
  _syncInaturalistUi() // Sync iNaturalist UI on locale change
  syncIdentifyButtonLabels()
})

async function handleInatCallback() {
  const callbackResult = parseInaturalistCallbackUrl(window.location.href);
  if (callbackResult.matches_inat) {
    if (callbackResult.kind === 'success') {
      try {
        await completeInaturalistOAuthCallback(callbackResult.code, callbackResult.state);
        showToast(t('settings.inaturalistLoginSuccess'));
        window.history.replaceState({}, document.title, window.location.pathname);
      } catch (error) {
        showToast(t('common.errorPrefix', { message: error.message }));
        console.error('iNaturalist OAuth failed:', error);
      }
    } else if (callbackResult.kind === 'error') {
      showToast(t('common.errorPrefix', { message: callbackResult.errorDescription || callbackResult.error }));
      console.error('iNaturalist OAuth error:', callbackResult);
    }
  }
}

async function init() {
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
      const bootSession = session || (await supabase.auth.getSession()).data.session
      if (bootSession?.user) await bootApp(bootSession.user)
    }, skipDraftRestore)
    authUiInitialized = true
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      ensureAuthUiInitialized(true)
      recoveryModeActive = true
      showAuthOverlay()
      switchToResetPassword()
      return
    }
    if (event === 'SIGNED_IN' && session?.user && !state.user) {
      if (recoveryModeActive || document.getElementById('reset-password-form')?.style.display === 'block') {
        return // Do not boot app while resetting password
      }
      await bootApp(session.user)
    }
    if (event === 'SIGNED_OUT') {
      state.user = null
      ensureAuthUiInitialized(true)
      showAuthOverlay()
      switchToLogin()
      navigate('home')
    }
  })

  // Give Supabase a tick to finish any URL-based recovery bootstrap before we branch.
  await new Promise(resolve => setTimeout(resolve, 0))
  const { data: { session } } = await supabase.auth.getSession()

  if (session?.user && !recoveryModeActive && document.getElementById('reset-password-form')?.style.display !== 'block') {
    clearPasswordRecoveryHint()
    await bootApp(session.user)
  } else {
    if (document.getElementById('auth-overlay').style.display !== 'flex') {
      showAuthOverlay()
    }
    ensureAuthUiInitialized(hasHashError || recoveryModeActive)
    if (recoveryModeActive) {
      switchToResetPassword()
    }
  }

  await handleInatCallback();
}

init()
