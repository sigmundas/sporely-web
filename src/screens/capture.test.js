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
import { initCapture, startCamera, stopCamera, _setDemoModeForTests } from './capture.js'
import { isTinyCameraCaptureDimensions } from './capture.js'

function _deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

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
    // Video-element-only stub for the shutter first-frame gate. Tests trigger a
    // frame by invoking runtime.fireFirstVideoFrame(); no callback is scheduled
    // until the capture code calls requestVideoFrameCallback.
    _pendingFrameCallbacks: [],
    requestVideoFrameCallback(cb) {
      this._pendingFrameCallbacks.push(cb)
      return this._pendingFrameCallbacks.length
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
  userAgent = 'Mozilla/5.0',
  platform = 'MacIntel',
  maxTouchPoints = 0,
  getUserMediaImpl = null,
} = {}) {
  const elements = new Map()
  const listeners = new Map()
  const documentListeners = new Map()
  const events = []
  const cameraCalls = {
    getUserMedia: 0,
    watchPosition: 0,
    clearWatch: [],
    enumerateDevices: 0,
    getUserMediaConstraints: [],
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
    userAgent,
    platform,
    maxTouchPoints,
    permissions: {
      query: async () => ({ state: permissionState }),
    },
    geolocation: hasGeolocation ? geolocationState : null,
    mediaDevices: {
      getUserMedia: async constraints => {
        cameraCalls.getUserMedia += 1
        cameraCalls.getUserMediaConstraints.push(constraints)
        if (getUserMediaImpl) return getUserMediaImpl(constraints)
        return _createStream()
      },
      enumerateDevices: async () => {
        cameraCalls.enumerateDevices += 1
        return []
      },
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
    fireFirstVideoFrame() {
      const video = elements.get('camera-video')
      const cbs = video?._pendingFrameCallbacks || []
      if (!cbs.length) return false
      const cb = cbs.shift()
      cb?.(performance.now?.() ?? 0, { presentedFrames: 1 })
      return true
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
      // Bump the preflight token so a leaked fire-and-forget
      // _startCaptureLocationFlow from this test aborts at its next check
      // instead of mutating the next test's state.
      stopCamera()
    } catch {}
    try {
      activeRuntime.restore()
    } catch {}
  }
  try { _setDemoModeForTests(false) } catch {}
  activeRuntime = null
  _resetState()
})

async function _flushAsync(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

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
  // One pill: any no-fix, non-searching state reads the same actionable copy.
  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'none')
})

test('preference ask with OS permission granted skips the custom prompt and persists enabled', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 144,
    },
    permissionState: 'granted',
  })
  initCapture()

  await startCamera()
  await _flushAsync()

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(state.location.preference, 'enabled')
  assert.equal(getLocationPreference(), 'enabled')
})

test('preference ask with OS permission=prompt shows the sheet and only enables after the user taps Use my location', async () => {
  // Regression guard: on iOS Safari, permission 'prompt' silently short-circuiting
  // to enabled dropped the sheet-button user-gesture checkpoint and caused a
  // starved MediaStream (blank preview, black captures). Keep the sheet on 'prompt'.
  const runtime = _makeRuntime({
    geolocation: {
      watchId: 145,
    },
    permissionState: 'prompt',
  })
  initCapture()

  // The camera opens first and never waits for the sheet.
  await startCamera()
  assert.equal(runtime.cameraCalls.getUserMedia >= 1, true)
  await _flushAsync()

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'flex')
  assert.equal(runtime.getElement('capture-location-title').textContent, 'Add a location to this find?')
  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(getLocationPreference(), 'ask')

  runtime.getElement('capture-location-primary-btn').click()
  await _flushAsync()

  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(getLocationPreference(), 'enabled')
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
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

  await startCamera()
  await _flushAsync()
  runtime.getElement('capture-location-primary-btn').click()
  await _flushAsync()

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

  await startCamera()
  await _flushAsync()

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
})

test('persisted disabled preference skips acquisition even when OS permission is granted', async () => {
  const runtime = _makeRuntime({ permissionState: 'granted' })
  setLocationPreference('disabled')
  initCapture()

  await startCamera()
  await _flushAsync()

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsAction, 'fix')
})

test('disabled preference: pill tap opens the sheet and Try again enables acquisition', async () => {
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

  await startCamera()
  await _flushAsync()

  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')

  permissionState = 'granted'
  runtime.getElement('gps-pill').click()
  await _flushAsync()
  assert.equal(runtime.getElement('location-fix-overlay').style.display, 'flex')
  runtime.getElement('location-fix-try-again').click()
  await _flushAsync()

  assert.equal(getLocationPreference(), 'enabled')
  assert.equal(runtime.cameraCalls.watchPosition, 1)
  assert.equal(state.location.watchId, 812)
})
test('denied and unsupported states show no prompt; the pill reads No location', async () => {
  const deniedRuntime = _makeRuntime({ permissionState: 'denied' })
  setLocationPreference('enabled')
  initCapture()

  await startCamera()
  await _flushAsync()
  assert.equal(deniedRuntime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(deniedRuntime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(deniedRuntime.getElement('gps-pill').dataset.gpsAction, 'fix')
  assert.equal(deniedRuntime.cameraCalls.watchPosition, 0)
  stopCamera()

  const unsupportedRuntime = _makeRuntime({ hasGeolocation: false })
  setLocationPreference('enabled')
  initCapture()

  await startCamera()
  await _flushAsync()
  assert.equal(unsupportedRuntime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(unsupportedRuntime.getElement('gps-display').textContent, 'No location · Tap to fix')
  stopCamera()
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
  assert.equal(runtime.getElement('gps-display').textContent, 'Location captured · ±5 m')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'fix')

  state.location.preference = 'disabled'
  state.location.fix = null
  state.captureSessionLocation.fix = null
  runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'none')
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

  await startCamera()
  await _flushAsync()

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

  await startCamera()
  await _flushAsync()

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

  await startCamera()
  await _flushAsync()

  state.currentScreen = 'capture'
  navigate('home')
  await _flushAsync()

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

  await startCamera()
  await _flushAsync()

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

test('iOS web opens a single environment-facing getUserMedia and skips device probing', async () => {
  const runtime = _makeRuntime({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    platform: 'iPhone',
    maxTouchPoints: 5,
    geolocation: { watchId: 501 },
  })
  setLocationPreference('enabled')
  initCapture()

  const startPromise = startCamera()
  await startPromise

  // The multi-step torch/lens probe would call getUserMedia + enumerateDevices
  // + one more getUserMedia. iOS web must issue exactly one getUserMedia call
  // and never enumerate devices to avoid stream muting.
  assert.equal(runtime.cameraCalls.getUserMedia, 1)
  assert.equal(runtime.cameraCalls.enumerateDevices, 0)

  const constraints = runtime.cameraCalls.getUserMediaConstraints[0]
  assert.deepEqual(constraints.video.facingMode, { ideal: 'environment' })
  assert.equal(typeof constraints.video.width?.ideal, 'number')
  assert.equal(typeof constraints.video.height?.ideal, 'number')
})

test('shutter is disabled until the first video frame is delivered', async () => {
  const runtime = _makeRuntime({ geolocation: { watchId: 611 } })
  setLocationPreference('enabled')
  initCapture()

  const startPromise = startCamera()
  await startPromise

  const shutter = runtime.getElement('shutter-btn')
  // Stream is attached but no frame has been reported yet — the pipeline may
  // have handed back a starved MediaStream. Keep the shutter closed.
  assert.equal(shutter.disabled, true)

  const fired = runtime.fireFirstVideoFrame()
  assert.equal(fired, true)

  assert.equal(shutter.disabled, false)
})

test('stopping the camera resets the first-frame gate so the next session must re-arm', async () => {
  const runtime = _makeRuntime({ geolocation: { watchId: 612 } })
  setLocationPreference('enabled')
  initCapture()

  await startCamera()
  runtime.fireFirstVideoFrame()
  assert.equal(runtime.getElement('shutter-btn').disabled, false)

  stopCamera()
  // stopCamera also clears state.cameraStream, so shutter.disabled during idle
  // is not meaningful — assert on the re-arm behaviour instead.

  await startCamera()
  assert.equal(runtime.getElement('shutter-btn').disabled, true, 'shutter must re-arm on the next session')
  runtime.fireFirstVideoFrame()
  assert.equal(runtime.getElement('shutter-btn').disabled, false)
})

test('all no-fix states render the single No location pill copy', async () => {
  const runtime = _makeRuntime()
  // Drain any leaked fire-and-forget location flow from earlier tests, then
  // normalize state before asserting the idle pill.
  await _flushAsync()
  _resetState()
  initCapture()
  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'none')

  setLocationPreference('disabled')
  initCapture()
  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'none')
})
test('shutter is disabled from the moment startCamera begins, before getUserMedia resolves', async () => {
  const gumGate = _deferred()
  const runtime = _makeRuntime({
    geolocation: { watchId: 811 },
    getUserMediaImpl: () => gumGate.promise,
  })
  setLocationPreference('enabled')
  initCapture()

  const startPromise = startCamera()
  // Let preflight + acquisition awaits settle so we're actually blocked inside
  // navigator.mediaDevices.getUserMedia — not in a still-scheduled task.
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  const shutter = runtime.getElement('shutter-btn')
  assert.equal(shutter.disabled, true, 'shutter must be disabled while camera startup is pending')
  assert.equal(state.cameraStream, null, 'stream has not been attached yet')

  gumGate.resolve(_createStream())
  await startPromise

  // Stream now attached; still waiting on first frame.
  assert.equal(!!state.cameraStream, true)
  assert.equal(shutter.disabled, true, 'still disabled while awaiting first frame')

  runtime.fireFirstVideoFrame()
  assert.equal(shutter.disabled, false)
})

test('a shutter press during real-camera startup cannot enter the demo capture branch', async () => {
  const gumGate = _deferred()
  const runtime = _makeRuntime({
    geolocation: { watchId: 812 },
    getUserMediaImpl: () => gumGate.promise,
  })
  setLocationPreference('enabled')
  initCapture()

  const startPromise = startCamera()
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  // Directly invoke the shutter click handler. In production the button's
  // native `disabled` prop blocks the click; in the mock and any programmatic
  // caller, capturePhoto() must still refuse. State.cameraStream is null and
  // video.srcObject is null here — the *exact* shape that would previously
  // have entered the emoji-canvas demo branch and saved a fake capture.
  runtime.getElement('shutter-btn').click()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(state.capturedPhotos.length, 0, 'startup shutter press must not produce a demo capture')

  gumGate.resolve(_createStream())
  await startPromise
  assert.equal(state.capturedPhotos.length, 0, 'startup shutter press must not produce a demo capture after startup either')
})

test('a first-frame callback retained from a previous stream cannot unlock a new session', async () => {
  const runtime = _makeRuntime({ geolocation: { watchId: 813 } })
  setLocationPreference('enabled')
  initCapture()

  await startCamera()
  const video = runtime.getElement('camera-video')
  // Snapshot the callback that the first stream registered before we tear down.
  const staleCallback = video._pendingFrameCallbacks[0]
  assert.equal(typeof staleCallback, 'function')

  stopCamera()
  await startCamera()

  // Fire the OLD callback from stream 1. It must not flip firstFrameReady on
  // the current (stream 2) session. Only a callback registered by the new
  // session's _wireFirstFrameSignal should unlock the shutter.
  staleCallback?.(0, { presentedFrames: 1 })
  assert.equal(runtime.getElement('shutter-btn').disabled, true,
    'a stale callback from a previous stream must not enable the new shutter')

  // The current session's own callback (last registered) does unlock the shutter.
  // The mock accumulates callbacks; fire the newest one directly rather than
  // via fireFirstVideoFrame(), which would replay the stale one first.
  const currentCallback = video._pendingFrameCallbacks[video._pendingFrameCallbacks.length - 1]
  assert.notEqual(currentCallback, staleCallback, 'a new session must register a fresh callback')
  currentCallback?.(0, { presentedFrames: 2 })
  assert.equal(runtime.getElement('shutter-btn').disabled, false)
})

test('first-frame gate falls back to the playing event when requestVideoFrameCallback is unavailable', async () => {
  const runtime = _makeRuntime({ geolocation: { watchId: 814 } })
  const video = runtime.getElement('camera-video')
  // Remove rVFC to force the fallback path.
  delete video.requestVideoFrameCallback

  setLocationPreference('enabled')
  initCapture()

  await startCamera()
  const shutter = runtime.getElement('shutter-btn')
  assert.equal(shutter.disabled, true, 'still gated on the playing event')

  // Playing event without dimensions must NOT unlock the shutter — the fallback
  // has to see videoWidth/videoHeight before treating this as a live frame.
  video.dispatchEvent({ type: 'playing' })
  assert.equal(shutter.disabled, true, 'playing without dimensions is not a frame')

  video.videoWidth = 1920
  video.videoHeight = 1080
  video.dispatchEvent({ type: 'playing' })
  assert.equal(shutter.disabled, false, 'playing with dimensions unlocks the shutter')
})

test('denied state pill tap opens the sheet and the settings option opens app settings', async () => {
  const runtime = _makeRuntime({ permissionState: 'denied' })
  await _flushAsync()
  _resetState()
  const previousCapacitor = globalThis.Capacitor
  let openSettingsCalls = 0
  globalThis.Capacitor = {
    Plugins: { LocationSettings: { openLocationSettings: async () => { openSettingsCalls += 1; return { opened: "system" } } } },
  }

  try {
    initCapture()
    state.location.preference = 'enabled'
    state.location.capability = 'supported'
    state.location.permission = 'denied'
    state.location.status = 'error'
    state.location.error = { kind: 'permission-denied', message: 'denied' }
    runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })

    assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
    assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'none')
    assert.equal(runtime.getElement('gps-pill').dataset.gpsAction, 'fix')

    runtime.getElement('gps-pill').click()
    await _flushAsync()
    assert.equal(runtime.getElement('location-fix-overlay').style.display, 'flex')

    runtime.getElement('location-fix-settings').click()
    await _flushAsync()

    assert.equal(openSettingsCalls, 1)
    assert.equal(runtime.cameraCalls.watchPosition, 0)
    assert.equal(state.location.preference, 'enabled')
    assert.equal(runtime.getElement('location-fix-overlay').style.display, 'none')
  } finally {
    globalThis.Capacitor = previousCapacitor
  }
})
test('a captured session fix is never overwritten by later warnings', () => {
  const runtime = _makeRuntime({ permissionState: 'granted' })
  initCapture()

  state.location.preference = 'enabled'
  state.location.capability = 'supported'
  state.location.permission = 'granted'
  state.location.status = 'timeout'
  state.location.error = { kind: 'timeout', message: 'timed out' }
  state.location.fix = null
  runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })

  assert.equal(runtime.getElement('gps-display').textContent, 'No location · Tap to fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'none')

  // A valid capture-time fix wins over a later denied state.
  state.captureSessionLocation.sessionStartAt = new Date()
  state.captureSessionLocation.fix = { lat: 63.4, lon: 10.4, accuracy: 6, altitude: 2, timestamp: Date.now() }
  state.location.permission = 'denied'
  state.location.status = 'error'
  state.location.error = { kind: 'permission-denied', message: 'denied' }
  runtime.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })

  assert.equal(runtime.getElement('gps-display').textContent, 'Location captured · ±6 m')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'fix')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsAction, undefined)
})

test('openNativeCamera never awaits an initial GPS fix before capturePhotos', () => {
  // Regression: an awaited pre-camera GPS request blocked the native camera
  // intent by up to 6.5 s. Fire-and-forget only; capture-time locking still
  // picks up whichever in-window fix arrives before the shutter fires.
  const source = fs.readFileSync(new URL('../screens/import_review.js', import.meta.url), 'utf8')
  const start = source.indexOf('export async function openNativeCamera()')
  const end = source.indexOf('\nasync function _requestInitialNativeCameraLocation()')
  assert.ok(start >= 0 && end > start)
  const body = source.slice(start, end)
  assert.doesNotMatch(body, /\bawait\s+_requestInitialNativeCameraLocation\b/)
  assert.match(body, /void\s+_requestInitialNativeCameraLocation\(\)/)
})
