import { state } from './state.js'
import {
  beginCaptureLocationSession,
  checkLocationCapabilityAndPermission,
  setLocationPreference,
  startLocationWatch,
  stopLocationWatch,
} from './geo.js'

let preflightSeq = 0
let promptResolver = null
let promptMode = null
let sheetWiredWindow = null

export function nextPreflightToken() {
  preflightSeq += 1
  return preflightSeq
}

export function isPreflightCurrent(token) {
  return token === preflightSeq
}

export function cancelActivePreflight() {
  preflightSeq += 1
  _resolvePrompt(null)
}

export function initCaptureLocationSheet() {
  const overlay = document.getElementById('capture-location-overlay')
  if (!overlay) return
  if (overlay._wired && sheetWiredWindow === globalThis.window) return
  overlay._wired = true
  sheetWiredWindow = globalThis.window

  document.getElementById('capture-location-backdrop')?.addEventListener('click', () => {
    // Sheet is intentionally explicit; only button actions dismiss it.
  })
  document.getElementById('capture-location-primary-btn')?.addEventListener('click', () => {
    const mode = promptMode
    if (mode === 'ask') return _resolvePrompt('use')
    if (mode === 'denied') return _resolvePrompt('retry')
    _resolvePrompt('continue')
  })
  document.getElementById('capture-location-secondary-btn')?.addEventListener('click', () => {
    _resolvePrompt('continue')
  })
  document.getElementById('capture-gps-enable-btn')?.addEventListener('click', () => {
    void enableCaptureLocationForCurrentSession().catch(error => {
      console.warn('Unable to enable location for the current capture session:', error)
    })
  })
}

function _resolvePrompt(result) {
  const overlay = document.getElementById('capture-location-overlay')
  if (overlay) overlay.style.display = 'none'
  const resolve = promptResolver
  promptResolver = null
  promptMode = null
  if (typeof resolve === 'function') resolve(result)
}

export function showLocationPrompt(mode) {
  const overlay = document.getElementById('capture-location-overlay')
  const title = document.getElementById('capture-location-title')
  const body = document.getElementById('capture-location-body')
  const primaryBtn = document.getElementById('capture-location-primary-btn')
  const secondaryBtn = document.getElementById('capture-location-secondary-btn')
  const primaryTitle = document.getElementById('capture-location-primary-title')
  const secondaryTitle = document.getElementById('capture-location-secondary-title')

  if (!overlay || !title || !body || !primaryBtn || !secondaryBtn || !primaryTitle || !secondaryTitle) {
    return Promise.resolve(null)
  }

  promptMode = mode
  if (mode === 'ask') {
    title.textContent = 'Add a location to this find?'
    body.textContent = 'Sporely uses your location while you create the find. You can obscure the location before publishing.'
    primaryTitle.textContent = 'Use my location'
    secondaryTitle.textContent = 'Not now'
    primaryBtn.style.display = ''
    secondaryBtn.style.display = ''
  } else if (mode === 'denied') {
    title.textContent = 'Location access was denied'
    body.textContent = 'Sporely could not access location on this device. You can try again or continue without location.'
    primaryTitle.textContent = 'Try again'
    secondaryTitle.textContent = 'Continue without location'
    primaryBtn.style.display = ''
    secondaryBtn.style.display = ''
  } else {
    title.textContent = 'Automatic location unavailable'
    body.textContent = 'This platform does not support automatic location in Sporely. You can continue without it.'
    primaryTitle.textContent = 'Continue without location'
    primaryBtn.style.display = ''
    secondaryBtn.style.display = 'none'
  }

  overlay.style.display = 'flex'

  return new Promise(resolve => {
    promptResolver = resolve
  })
}

export async function enableCaptureLocationForCurrentSession() {
  setLocationPreference('enabled')
  await checkLocationCapabilityAndPermission()
  await startLocationWatch({ requestFreshFix: true })
}

export async function prepareNewFindLocation({ preserveBatch = false, token } = {}) {
  if (preserveBatch) return { shouldContinue: true, useLocation: false }

  const preference = state.location.preference
  if (preference === 'ask') {
    beginCaptureLocationSession()
    const snapshot = await checkLocationCapabilityAndPermission()
    if (!isPreflightCurrent(token)) return { shouldContinue: false, useLocation: false }

    if (snapshot.capability === 'unsupported') {
      const choice = await showLocationPrompt('unsupported')
      if (!isPreflightCurrent(token) || choice == null) return { shouldContinue: false, useLocation: false }
      if (choice === 'continue') {
        stopLocationWatch()
        return { shouldContinue: true, useLocation: false }
      }
      return { shouldContinue: false, useLocation: false }
    }

    if (snapshot.permission === 'denied') {
      const choice = await showLocationPrompt('denied')
      if (!isPreflightCurrent(token) || choice == null) return { shouldContinue: false, useLocation: false }
      if (choice === 'continue') {
        stopLocationWatch()
        return { shouldContinue: true, useLocation: false }
      }
      return prepareNewFindLocation({ preserveBatch: false, token })
    }

    if (snapshot.permission === 'granted') {
      setLocationPreference('enabled')
      return { shouldContinue: true, useLocation: true }
    }

    const choice = await showLocationPrompt('ask')
    if (!isPreflightCurrent(token) || choice == null) return { shouldContinue: false, useLocation: false }
    if (choice === 'continue') {
      stopLocationWatch()
      return { shouldContinue: true, useLocation: false }
    }
    setLocationPreference('enabled')
    return prepareNewFindLocation({ preserveBatch: false, token })
  }

  if (preference === 'disabled') {
    beginCaptureLocationSession()
    return { shouldContinue: true, useLocation: false }
  }

  beginCaptureLocationSession()
  const snapshot = await checkLocationCapabilityAndPermission()
  if (!isPreflightCurrent(token)) return { shouldContinue: false, useLocation: false }

  if (snapshot.capability === 'unsupported') {
    const choice = await showLocationPrompt('unsupported')
    if (!isPreflightCurrent(token) || choice == null) return { shouldContinue: false, useLocation: false }
    if (choice === 'continue') {
      beginCaptureLocationSession()
      stopLocationWatch()
      return { shouldContinue: true, useLocation: false }
    }
    return { shouldContinue: false, useLocation: false }
  }

  if (snapshot.permission === 'denied') {
    const choice = await showLocationPrompt('denied')
    if (!isPreflightCurrent(token) || choice == null) return { shouldContinue: false, useLocation: false }
    if (choice === 'continue') {
      beginCaptureLocationSession()
      stopLocationWatch()
      return { shouldContinue: true, useLocation: false }
    }
    return prepareNewFindLocation({ preserveBatch: false, token })
  }

  return { shouldContinue: true, useLocation: true }
}

export async function startNewFindLocationAcquisition({ useLocation, token }) {
  if (!useLocation) {
    stopLocationWatch()
    return true
  }

  const snapshot = await startLocationWatch({ requestFreshFix: true })
  if (!isPreflightCurrent(token)) return false
  if (snapshot.permission === 'granted') {
    setLocationPreference('enabled')
  }

  if (snapshot.capability === 'unsupported') {
    const choice = await showLocationPrompt('unsupported')
    if (!isPreflightCurrent(token) || choice == null) return false
    if (choice === 'continue') {
      stopLocationWatch()
      return true
    }
    return startNewFindLocationAcquisition({ useLocation: true, token })
  }

  if (snapshot.permission === 'denied') {
    const choice = await showLocationPrompt('denied')
    if (!isPreflightCurrent(token) || choice == null) return false
    if (choice === 'continue') {
      stopLocationWatch()
      return true
    }
    return startNewFindLocationAcquisition({ useLocation: true, token })
  }

  return true
}
