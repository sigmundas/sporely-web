import { state } from './state.js'
import { startCamera, stopCamera } from './screens/capture.js'
import { buildReviewGrid } from './screens/review.js'
import { loadMap } from './screens/map.js'

// Navigation history stack
const navStack = []

function _show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'))

  const nav = document.getElementById('bottom-nav')
  nav.style.display = ['capture', 'find-detail', 'import-review'].includes(screen) ? 'none' : 'flex'

  document.getElementById(`screen-${screen}`).classList.add('active')
  const navEl = document.getElementById(`nav-${screen}`)
  if (navEl) navEl.classList.add('active')

  state.currentScreen = screen

  if (screen === 'capture') startCamera()
  else stopCamera()

  if (screen === 'review') buildReviewGrid()
  if (screen === 'map')    loadMap()
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

