import { state } from './state.js'
import { startCamera, stopCamera } from './screens/capture.js'
import { buildReviewGrid } from './screens/review.js'
import { loadMapScreen } from './map-loader.js'
import { endCaptureLocationSession } from './geo.js'
import { markCameraStep } from './camera-timing.js'

// Navigation history stack
const navStack = []

function _show(screen) {
  const prevScreen = state.currentScreen
  if (screen === 'capture') markCameraStep('router:show:capture:start', { from: prevScreen })
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'))

  const nav = document.getElementById('bottom-nav')
  nav.style.display = ['capture', 'review', 'find-detail', 'import-review'].includes(screen) ? 'none' : 'flex'

  document.getElementById(`screen-${screen}`).classList.add('active')
  const navEl = document.getElementById(`nav-${screen}`)
  if (navEl) navEl.classList.add('active')

  state.currentScreen = screen

  const wasLiveLocationScreen = prevScreen === 'capture' || prevScreen === 'review'
  const isLiveLocationScreen = screen === 'capture' || screen === 'review'
  if (wasLiveLocationScreen && !isLiveLocationScreen) {
    endCaptureLocationSession()
  }

  if (screen === 'capture') {
    markCameraStep('router:show:capture:end')
    startCamera({ preserveBatch: prevScreen === 'review' && state.capturedPhotos.length > 0 })
  } else stopCamera()

  if (screen === 'review') buildReviewGrid()
  if (screen === 'map')    void loadMapScreen()
}

export function navigate(screen) {
  // Avoid duplicate consecutive entries (e.g. refreshHome calling navigate again)
  if (navStack[navStack.length - 1] !== screen) {
    navStack.push(screen)
  }
  _show(screen)
}

/** Navigate back one step. Returns the screen navigated to. */
export function goBack() {
  navStack.pop()  // remove current
  const prev = navStack[navStack.length - 1] || 'home'
  _show(prev)
  return prev
}
