import './style.css'
import './theme.js'   // applies saved theme immediately, no flash

import { supabase } from './supabase.js'
import { state } from './state.js'
import { startGeo } from './geo.js'
import { navigate } from './router.js'
import { applyTheme } from './theme.js'
import { initAuth, showAuthOverlay, hideAuthOverlay, handleUrlHashError } from './screens/auth.js'
import { initHome, refreshHome } from './screens/home.js'
import { initFinds, loadFinds } from './screens/finds.js'
import { initCapture } from './screens/capture.js'
import { initReview } from './screens/review.js'
import { initFindDetail } from './screens/find_detail.js'
import { initPhotoViewer } from './photo-viewer.js'
import { initImportReview, restoreImportSessions } from './screens/import_review.js'
import { loadImportSessions } from './import-store.js'
import { initMap } from './screens/map.js'
import { initProfile, loadProfile } from './screens/profile.js'

// ── Settings panel ────────────────────────────────────────────────────────────
function initSettings() {
  const overlay = document.getElementById('settings-overlay')

  function _openSettings() {
    _syncSettingsUI()
    overlay.style.display = 'block'
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('open')))
  }

  function _closeSettings() {
    overlay.classList.remove('open')
    overlay.addEventListener('transitionend', () => { overlay.style.display = 'none' }, { once: true })
  }

  document.getElementById('settings-btn').addEventListener('click', _openSettings)

  // Close on backdrop tap
  overlay.addEventListener('click', e => {
    if (e.target === overlay) _closeSettings()
  })

  // Theme segment buttons
  document.querySelectorAll('.theme-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme
      localStorage.setItem('sporely-theme', theme)
      applyTheme(theme)
      _syncSettingsUI()
    })
  })

  // Photo gap input
  const gapInput = document.getElementById('settings-gap-input')
  gapInput.addEventListener('change', () => {
    const v = Math.max(1, Math.min(120, parseInt(gapInput.value) || 1))
    gapInput.value = v
    localStorage.setItem('sporely-photo-gap', String(v))
  })
}

function _syncSettingsUI() {
  const current = localStorage.getItem('sporely-theme') || 'dark'
  document.querySelectorAll('.theme-seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === current)
  })
  const gapInput = document.getElementById('settings-gap-input')
  if (gapInput) gapInput.value = localStorage.getItem('sporely-photo-gap') || '1'
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
  document.getElementById('nav-profile').addEventListener('click', () => {
    navigate('profile')
    loadProfile()
  })
}

async function bootApp(user) {
  state.user = user

  hideAuthOverlay()
  initSettings()
  initNav()
  initHome()
  initFinds()
  initCapture()
  initReview()
  initFindDetail()
  initPhotoViewer()
  initImportReview()
  initMap()
  initProfile()
  startGeo()
  navigate('home')

  // Restore any import session that was interrupted by app suspension/kill
  const pending = await loadImportSessions()
  if (pending.length) restoreImportSessions(pending)
}

async function init() {
  handleUrlHashError()

  const { data: { session } } = await supabase.auth.getSession()

  if (session?.user) {
    await bootApp(session.user)
  } else {
    if (document.getElementById('auth-overlay').style.display !== 'flex') {
      showAuthOverlay()
    }
    initAuth(async () => {
      const { data: { session: newSession } } = await supabase.auth.getSession()
      if (newSession?.user) await bootApp(newSession.user)
    })
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user && !state.user) {
      await bootApp(session.user)
    }
    if (event === 'SIGNED_OUT') {
      state.user = null
      showAuthOverlay()
    }
  })
}

init()
