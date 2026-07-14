import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createDefaultObservationDraft } from '../observation-defaults.js'
import { getLocationPreference } from '../settings.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import {
  LOCATION_STATE_CHANGED_EVENT,
  beginCaptureLocationSession,
  endCaptureLocationSession,
  setLocationPreference,
  stopLocationWatch,
} from '../geo.js'
import { initCapture, startCamera, stopCamera } from './capture.js'
import { isTinyCameraCaptureDimensions } from './capture.js'

const defaultLocationState = () => ({
  preference: 'ask',
  capability: 'unknown',
  permission: 'unknown',
  status: 'idle',
  fix: null,
  error: null,
  watchId: null,
})

const defaultCaptureSessionLocationState = () => ({
  fix: null,
  sessionStartAt: null,
  requestingFreshFix: false,
})

let activeRuntime = null

function _resetState() {
  state.location = defaultLocationState()
  state.captureSessionLocation = defaultCaptureSessionLocationState()
  state.sessionStart = null
  state.capturedPhotos = []
  state.captureDraft = createDefaultObservationDraft()
  state.batchCount = 0
  state.cameraStream = null
}

function _makeClassList() {
  const classes = new Set()
  return {
    add(...names) {
      names.filter(Boolean).forEach(name => classes.add(name))
    },
    remove(...names) {
      names.filter(Boolean).forEach(name => classes.delete(name))
    },
    toggle(name, force) {
      const next = force === undefined ? !classes.has(name) : !!force
      if (next) classes.add(name)
      else classes.delete(name)
      return next
    },
    contains(name) {
      return classes.has(name)
    },
  }
}

function _makeElement(id, tagName = 'div') {
  const listeners = {}
  const children = new Map()
  return {
    id,
    tagName: tagName.toUpperCase(),
    style: { display: '' },
    dataset: {},
    classList: _makeClassList(),
    textContent: '',
    innerHTML: '',
    disabled: false,
    value: '',
    checked: false,
    hidden: false,
    attributes: new Map(),
    clientWidth: 400,
    clientHeight: 600,
    onloadedmetadata: null,
    srcObject: null,
    addEventListener(type, handler) {
      listeners[type] = handler
    },
    removeEventListener(type, handler) {
      if (listeners[type] === handler) delete listeners[type]
    },
    dispatchEvent(event) {
      listeners[event.type]?.(event)
      return true
    },
    click() {
      listeners.click?.({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: this,
        target: this,
      })
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value))
    },
    getAttribute(name) {
      return this.attributes.get(name) || null
    },
    closest() {
      return null
    },
    focus() {},
    blur() {},
    querySelector(selector) {
      if (!children.has(selector)) {
        children.set(selector, _makeElement(`${id} ${selector}`))
      }
      return children.get(selector) || null
    },
    querySelectorAll() {
      return []
    },
    appendChild() {},
    removeAttribute(name) {
      this.attributes.delete(name)
    },
    getBoundingClientRect() {
      return { width: 400, height: 600, left: 0, top: 0 }
    },
    play() {
      return Promise.resolve()
    },
  }
}

function _createStream() {
  const track = {
    stopCalled: false,
    stop() {
      this.stopCalled = true
    },
    getSettings() {
      return { width: 4000, height: 3000 }
    },
    getCapabilities() {
      return {}
    },
    applyConstraints() {
      return Promise.resolve()
    },
  }
  return {
    getTracks() {
      return [track]
    },
    getVideoTracks() {
      return [track]
    },
  }
}

function _makeRuntime({
  permissionState = 'granted',
  geolocation = {},
  promptDenied = false,
  hasGeolocation = true,
} = {}) {
  const elements = new Map()
  const listeners = new Map()
  const documentListeners = new Map()
  const events = []
  const cameraCalls = {
    getUserMedia: 0,
    watchPosition: 0,
    clearWatch: [],
  }

  const ensure = (id, tagName = 'div') => {
    if (!elements.has(id)) {
      elements.set(id, _makeElement(id, tagName))
    }
    return elements.get(id)
  }

  ensure('toast')
  ensure('camera-video', 'video')
  ensure('batch-count')
  ensure('batch-area')
  ensure('bottom-nav')
  ensure('screen-home')
  ensure('screen-capture')
  ensure('screen-review')
  ensure('screen-import-review')
  ensure('nav-home')
  ensure('nav-capture')
  ensure('nav-review')
  ensure('nav-import-review')
  ensure('camera-denied')
  ensure('camera-denied-body')
  ensure('camera-retry-btn', 'button')
  ensure('shutter-btn', 'button')
  ensure('done-btn', 'button')
  ensure('capture-cancel-btn', 'button')
  ensure('capture-location-overlay')
  ensure('capture-location-backdrop', 'button')
  ensure('capture-location-sheet')
  ensure('capture-location-title')
  ensure('capture-location-body')
  ensure('capture-location-primary-btn', 'button')
  ensure('capture-location-primary-title')
  ensure('capture-location-secondary-btn', 'button')
  ensure('capture-location-secondary-title')
  ensure('gps-display')
  ensure('gps-pill')
  ensure('capture-gps-enable-btn', 'button')
  ensure('capture-viewfinder')

  elements.get('capture-location-overlay').style.display = 'none'
  elements.get('camera-denied').style.display = 'none'

  const document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, _makeElement(id))
      }
      return elements.get(id) || null
    },
    createElement(tagName) {
      return _makeElement(`auto-${tagName}-${elements.size}`, tagName)
    },
    addEventListener(type, handler) {
      const list = documentListeners.get(type) || []
      list.push(handler)
      documentListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = documentListeners.get(type) || []
      documentListeners.set(type, list.filter(entry => entry !== handler))
    },
    dispatchEvent(event) {
      for (const handler of documentListeners.get(event.type) || []) {
        handler(event)
      }
      return true
    },
    querySelector(selector) {
      if (selector === '.capture-viewfinder') return elements.get('capture-viewfinder') || null
      if (selector === '.capture-gps-pill') return elements.get('gps-pill') || null
      return null
    },
    querySelectorAll() {
      return []
    },
  }

  const window = {
    Capacitor: {
      isNativePlatform() {
        return false
      },
      getPlatform() {
        return 'web'
      },
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type
        this.detail = init.detail
      }
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) || []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || []
      listeners.set(type, list.filter(entry => entry !== handler))
    },
    dispatchEvent(event) {
      events.push(event)
      for (const handler of listeners.get(event.type) || []) {
        handler(event)
      }
      return true
    },
  }

  const geolocationState = {
    watchPosition(success, error, options) {
      cameraCalls.watchPosition += 1
      if (promptDenied) {
        error?.({ code: 1, message: 'denied' })
        return 101
      }
      geolocation.watchPosition?.(success, error, options)
      return geolocation.watchId ?? 101
    },
    clearWatch(id) {
      cameraCalls.clearWatch.push(id)
      geolocation.clearWatch?.(id)
    },
    getCurrentPosition(success, error, options) {
      geolocation.getCurrentPosition?.(success, error, options)
    },
  }

  const navigator = {
    userAgent: 'Mozilla/5.0',
    platform: 'MacIntel',
    permissions: {
      query: async () => ({ state: permissionState }),
    },
    geolocation: hasGeolocation ? geolocationState : null,
    mediaDevices: {
      getUserMedia: async () => {
        cameraCalls.getUserMedia += 1
        return _createStream()
      },
      enumerateDevices: async () => [],
    },
  }

  const localStorageStore = new Map()
  const restoreStack = []
  const setGlobal = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    restoreStack.push(() => {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      } else {
        Reflect.deleteProperty(globalThis, name)
      }
    })
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }

  setGlobal('document', document)
  setGlobal('window', window)
  setGlobal('navigator', navigator)
  setGlobal('CustomEvent', window.CustomEvent)
  setGlobal('localStorage', {
    getItem(key) {
      return localStorageStore.has(key) ? localStorageStore.get(key) : null
    },
    setItem(key, value) {
      localStorageStore.set(String(key), String(value))
    },
    removeItem(key) {
      localStorageStore.delete(String(key))
    },
    clear() {
      localStorageStore.clear()
    },
  })

  const runtime = {
    elements,
    events,
    cameraCalls,
    document,
    window,
    restore() {
      while (restoreStack.length) {
        const restore = restoreStack.pop()
        try {
          restore()
        } catch {}
      }
      if (activeRuntime === runtime) activeRuntime = null
    },
    getElement(id) {
      return elements.get(id)
    },
    getDocumentListeners(type) {
      return documentListeners.get(type) || []
    },
    async cleanup() {
      try {
        stopCamera()
      } catch {}
      try {
        stopLocationWatch()
      } catch {}
    },
  }
  activeRuntime = runtime
  return runtime
}

afterEach(() => {
  if (activeRuntime) {
    try {
      stopCamera()
    } catch {}
    try {
      stopLocationWatch()
    } catch {}
    try {
      activeRuntime.restore()
    } catch {}
  }
  activeRuntime = null
  _resetState()
})

test('tiny camera capture dimensions reject degraded iOS fallback frames', () => {
  assert.equal(isTinyCameraCaptureDimensions(144, 192), true)
  assert.equal(isTinyCameraCaptureDimensions(3024, 4032), false)
  assert.equal(isTinyCameraCaptureDimensions(800, 999), true)
  assert.equal(isTinyCameraCaptureDimensions(1000, 800), false)
})

test('capture prompt is hidden at boot and only shown when live capture starts', () => {
  const runtime = _makeRuntime()
  initCapture()

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.getElement('gps-display').textContent, 'Location not included')
})

test('preference ask with OS permission granted skips the custom prompt and persists enabled', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 144,
    },
    permissionState: 'granted',
  })
  initCapture()

  const startPromise = startCamera()
  await startPromise

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(state.location.preference, 'enabled')
  assert.equal(getLocationPreference(), 'enabled')
})

test('preference ask with an unknown OS permission starts acquisition without a second custom prompt', async () => {
  let watchSuccess = null
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 145,
      watchPosition(success) {
        watchSuccess = success
      },
    },
    permissionState: 'prompt',
  })
  initCapture()

  const startPromise = startCamera()
  await startPromise

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(getLocationPreference(), 'enabled')

  watchSuccess?.({
    coords: {
      latitude: 63.4,
      longitude: 10.4,
      accuracy: 8,
      altitude: 12,
    },
    timestamp: Date.now(),
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(state.location.permission, 'granted')
})

test('capture session starts with a fresh location session and installs one visibility listener', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 77,
    },
  })
  initCapture()

  assert.equal(runtime.getDocumentListeners('visibilitychange').length, 0)

  const startPromise = startCamera()
  runtime.getElement('capture-location-primary-btn').click()
  await startPromise

  assert.equal(runtime.getDocumentListeners('visibilitychange').length, 1)
  assert.equal(state.captureSessionLocation.sessionStartAt instanceof Date, true)
  assert.equal(state.captureSessionLocation.fix, null)
})

test('Use my location starts acquisition', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 321,
    },
  })
  initCapture()

  const startPromise = startCamera()
  runtime.getElement('capture-location-primary-btn').click()
  await startPromise

  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(runtime.cameraCalls.getUserMedia >= 1, true)
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
})

test('Not now does not start acquisition and keeps the preference as ask', async () => {
  const runtime = _makeRuntime({ permissionState: 'blocked' })
  initCapture()

  const startPromise = startCamera()
  await new Promise(resolve => setImmediate(resolve))
  runtime.getElement('capture-location-secondary-btn').click()
  await startPromise

  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(getLocationPreference(), 'ask')
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
})

test('Not now is session-only and the next new find prompts again', async () => {
  const runtime = _makeRuntime({ permissionState: 'blocked' })
  initCapture()

  const firstStart = startCamera()
  await new Promise(resolve => setImmediate(resolve))
  runtime.getElement('capture-location-secondary-btn').click()
  await firstStart

  stopCamera()
  const secondStart = startCamera()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'flex')
  runtime.getElement('capture-location-secondary-btn').click()
  await secondStart

  assert.equal(getLocationPreference(), 'ask')
})

test('persisted enabled preference skips the explanatory prompt', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 512,
    },
  })
  setLocationPreference('enabled')
  initCapture()

  const startPromise = startCamera()
  await startPromise

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
})

test('persisted disabled preference skips acquisition even when OS permission is granted', async () => {
  const runtime = _makeRuntime({ permissionState: 'granted' })
  setLocationPreference('disabled')
  initCapture()

  const startPromise = startCamera()
  await startPromise

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(runtime.getElement('capture-gps-enable-btn').hidden, false)
  assert.equal(runtime.getElement('gps-display').textContent, 'Location not included')
})

test('disabled preference enable starts acquisition for the current session', async () => {
  let permissionState = 'denied'
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 812,
      watchPosition() {
        return 812
      },
    },
  })
  globalThis.navigator.permissions.query = async () => ({ state: permissionState })

  setLocationPreference('disabled')
  initCapture()

  const startPromise = startCamera()
  await startPromise

  assert.equal(runtime.getElement('capture-gps-enable-btn').hidden, false)
  assert.equal(runtime.getElement('capture-gps-enable-btn').disabled, false)
  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(runtime.getElement('gps-display').textContent, 'Location not included')

  permissionState = 'granted'
  runtime.getElement('capture-gps-enable-btn').click()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(getLocationPreference(), 'enabled')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(state.location.watchId, 812)
  assert.equal(state.location.status, 'locating')
})

test('denied and unsupported states render the correct actions', async () => {
  const deniedRuntime = _makeRuntime({ permissionState: 'denied' })
  setLocationPreference('enabled')
  initCapture()

  const deniedPromise = startCamera()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(deniedRuntime.getElement('capture-location-title').textContent, 'Location access was denied')
  assert.equal(deniedRuntime.getElement('capture-location-primary-title').textContent, 'Try again')
  assert.equal(deniedRuntime.getElement('capture-location-secondary-title').textContent, 'Continue without location')
  assert.equal(deniedRuntime.getElement('capture-location-secondary-btn').style.display, '')
  stopCamera()
  await deniedPromise
  const unsupportedRuntime = _makeRuntime({ hasGeolocation: false })
  setLocationPreference('enabled')
  initCapture()

  const unsupportedPromise = startCamera()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(unsupportedRuntime.getElement('capture-location-title').textContent, 'Automatic location unavailable')
  assert.equal(unsupportedRuntime.getElement('capture-location-primary-title').textContent, 'Continue without location')
  assert.equal(unsupportedRuntime.getElement('capture-location-secondary-btn').style.display, 'none')
  stopCamera()
  await unsupportedPromise
})

test('OS permission denial alone never changes the Sporely preference to disabled', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchPosition(success, error) {
        error?.({ code: 1, message: 'denied' })
        return 901
      },
    },
    permissionState: 'denied',
  })
  initCapture()

  const startPromise = startCamera()
  await new Promise(resolve => setTimeout(resolve, 0))
  runtime.getElement('capture-location-secondary-btn').click()
  await startPromise

  assert.equal(state.location.preference, 'ask')
  assert.equal(getLocationPreference(), 'ask')
})

test('location-state events update the compact capture status', () => {
  const runtime = _makeRuntime()
  initCapture()

  state.location.preference = 'enabled'
  state.location.status = 'locating'
  state.captureSessionLocation.requestingFreshFix = true
  runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
  assert.equal(runtime.getElement('gps-display').textContent, 'Finding location…')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'searching')

  state.location.status = 'fix'
  state.location.fix = {
    lat: 63.1,
    lon: 10.1,
    accuracy: 4.6,
    altitude: 0,
    timestamp: Date.now(),
  }
  state.captureSessionLocation.requestingFreshFix = false
  runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
  assert.equal(runtime.getElement('gps-display').textContent, 'Location ready · ±5 m')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'fix')

  state.location.preference = 'disabled'
  runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
  assert.equal(runtime.getElement('gps-display').textContent, 'Location not included')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'disabled')
})

test('capture to review preserves the live location session and watch', async () => {
  let watchId = 401
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 401,
      watchPosition() {
        return watchId
      },
    },
  })
  initCapture()
  setLocationPreference('enabled')

  const startPromise = startCamera()
  await startPromise

  assert.equal(state.location.watchId, 401)
  assert.equal(state.captureSessionLocation.sessionStartAt instanceof Date, true)

  state.currentScreen = 'capture'
  runtime.getElement('done-btn').click()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(state.currentScreen, 'review')
  assert.equal(state.captureSessionLocation.sessionStartAt instanceof Date, true)
  assert.equal(state.location.watchId, 401)
  assert.deepEqual(runtime.cameraCalls.clearWatch, [])
})

test('cancel capture stops and clears the live session', async () => {
  const clearCalls = []
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 609,
      watchPosition() {
        return 609
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
  })
  initCapture()
  setLocationPreference('enabled')

  const startPromise = startCamera()
  await startPromise

  runtime.getElement('capture-cancel-btn').click()

  assert.equal(state.captureSessionLocation.sessionStartAt, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.watchId, null)
  assert.deepEqual(clearCalls, [609])
})

test('unrelated navigation stops and clears the live session', async () => {
  const clearCalls = []
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 707,
      watchPosition() {
        return 707
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
  })
  initCapture()
  setLocationPreference('enabled')

  const startPromise = startCamera()
  await startPromise

  state.currentScreen = 'capture'
  navigate('home')
  await startPromise

  assert.equal(state.currentScreen, 'home')
  assert.equal(state.captureSessionLocation.sessionStartAt, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.watchId, null)
  assert.deepEqual(clearCalls, [707])
})

test('session ending during resume ignores the late result', async () => {
  let getCurrentPositionResolve
  let watchCallCount = 0
  const clearCalls = []
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 702,
      watchPosition() {
        watchCallCount += 1
        return 702
      },
      getCurrentPosition(success) {
        getCurrentPositionResolve = success
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
  })
  initCapture()
  setLocationPreference('enabled')

  const startPromise = startCamera()
  await startPromise

  runtime.document.visibilityState = 'hidden'
  runtime.document.hidden = true
  runtime.document.dispatchEvent({ type: 'visibilitychange' })

  runtime.document.visibilityState = 'visible'
  runtime.document.hidden = false
  runtime.document.dispatchEvent({ type: 'visibilitychange' })

  endCaptureLocationSession()
  getCurrentPositionResolve?.({
    coords: {
      latitude: 63.9,
      longitude: 10.9,
      accuracy: 3,
      altitude: 9,
    },
    timestamp: Date.now(),
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.watchId, null)
  assert.equal(watchCallCount, 1)
  assert.deepEqual(clearCalls, [702])
})

test('capture and review expose a shared gps status pill', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const i18nSource = fs.readFileSync(new URL('../i18n.js', import.meta.url), 'utf8')

  assert.match(html, /capture-gps-pill/)
  assert.match(html, /id="gps-display"/)
  assert.match(html, /review-gps-pill/)
  assert.match(html, /id="review-gps-display"/)
  assert.doesNotMatch(html, /Creates one observation in Sporely Cloud/)

  assert.match(i18nSource, /setText\('#review-gps-display', 'common\.noGpsCaptured'\)/)
})
