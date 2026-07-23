import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { state } from '../state.js'
import { createDefaultObservationDraft } from '../observation-defaults.js'
import {
  endCaptureLocationSession,
  stopLocationWatch,
  setLocationPreference,
} from '../geo.js'
import { getLocationPreference, setUseSystemCamera } from '../settings.js'
import { initCapture, stopCamera } from './capture.js'
import { initCaptureLocationSheet } from '../capture-location-preflight.js'
import {
  openNativeCamera,
  __setNativeCameraForTests,
  __setNativePhotoPipelineForTests,
} from './import_review.js'

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
  state.reviewContext = null
  state.currentScreen = 'home'
}

function _makeClassList() {
  const classes = new Set()
  return {
    add(...names) { names.filter(Boolean).forEach(n => classes.add(n)) },
    remove(...names) { names.filter(Boolean).forEach(n => classes.delete(n)) },
    toggle(name, force) {
      const next = force === undefined ? !classes.has(name) : !!force
      if (next) classes.add(name); else classes.delete(name)
      return next
    },
    contains(name) { return classes.has(name) },
  }
}

function _makeElement(id, tagName = 'div') {
  const listeners = {}
  const children = new Map()
  const styleStore = { display: '' }
  const style = new Proxy(styleStore, {
    get(target, prop) {
      if (prop === 'setProperty') return (name, value) => { target[name] = value }
      if (prop === 'removeProperty') return (name) => { delete target[name] }
      if (prop === 'getPropertyValue') return (name) => target[name] ?? ''
      return target[prop]
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
  return {
    id,
    tagName: tagName.toUpperCase(),
    style,
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
    addEventListener(type, handler) { listeners[type] = handler },
    removeEventListener(type, handler) { if (listeners[type] === handler) delete listeners[type] },
    dispatchEvent(event) { listeners[event.type]?.(event); return true },
    click() { listeners.click?.({ preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this }) },
    setAttribute(name, value) { this.attributes.set(name, String(value)) },
    getAttribute(name) { return this.attributes.get(name) || null },
    closest() { return null },
    focus() {},
    blur() {},
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, _makeElement(`${id} ${selector}`))
      return children.get(selector) || null
    },
    querySelectorAll() { return [] },
    appendChild() {},
    removeAttribute(name) { this.attributes.delete(name) },
    getBoundingClientRect() { return { width: 400, height: 600, left: 0, top: 0 } },
    play() { return Promise.resolve() },
  }
}

function _makeRuntime({ permissionState = 'granted', watchId = 555, deliverFix = null, getCurrentPosition = null } = {}) {
  const elements = new Map()
  const windowListeners = new Map()
  const documentListeners = new Map()
  const calls = {
    watchPosition: 0,
    getCurrentPosition: 0,
    getCurrentPositionOptions: [],
    clearWatch: [],
    nativeCamera: [],
    nativePhotoToFile: 0,
    processFile: 0,
  }

  const ensure = (id, tagName = 'div') => {
    if (!elements.has(id)) elements.set(id, _makeElement(id, tagName))
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
  ensure('review-gps-display')
  ensure('review-gps-pill')
  ensure('import-progress')
  ensure('import-progress-fill')
  ensure('import-progress-label')

  elements.get('capture-location-overlay').style.display = 'none'
  elements.get('camera-denied').style.display = 'none'
  elements.get('import-progress').style.display = 'none'

  const document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, _makeElement(id))
      return elements.get(id) || null
    },
    createElement(tagName) { return _makeElement(`auto-${tagName}-${elements.size}`, tagName) },
    addEventListener(type, handler) {
      const list = documentListeners.get(type) || []; list.push(handler); documentListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = documentListeners.get(type) || []; documentListeners.set(type, list.filter(h => h !== handler))
    },
    dispatchEvent(event) {
      for (const handler of documentListeners.get(event.type) || []) handler(event)
      return true
    },
    querySelector(selector) {
      if (selector === '.capture-viewfinder') return elements.get('capture-viewfinder') || null
      if (selector === '.capture-gps-pill') return elements.get('gps-pill') || null
      if (selector === '.review-gps-pill') return elements.get('review-gps-pill') || null
      return null
    },
    querySelectorAll() { return [] },
  }

  const localStorageStore = new Map()
  const _localStorage = {
    getItem(key) { return localStorageStore.has(key) ? localStorageStore.get(key) : null },
    setItem(key, value) { localStorageStore.set(String(key), String(value)) },
    removeItem(key) { localStorageStore.delete(String(key)) },
    clear() { localStorageStore.clear() },
  }

  const window = {
    Capacitor: {
      isNativePlatform() { return true },
      getPlatform() { return 'android' },
    },
    localStorage: _localStorage,
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail } },
    addEventListener(type, handler) {
      const list = windowListeners.get(type) || []; list.push(handler); windowListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = windowListeners.get(type) || []; windowListeners.set(type, list.filter(h => h !== handler))
    },
    dispatchEvent(event) {
      for (const handler of windowListeners.get(event.type) || []) handler(event)
      return true
    },
  }

  const geolocation = {
    watchPosition(success) {
      calls.watchPosition += 1
      if (deliverFix) {
        // Fire synchronously so state.captureSessionLocation.fix is set
        // before the caller reads it.
        success({
          coords: {
            latitude: deliverFix.lat,
            longitude: deliverFix.lon,
            accuracy: deliverFix.accuracy ?? null,
            altitude: deliverFix.altitude ?? null,
          },
          timestamp: Date.now(),
        })
      }
      return watchId
    },
    clearWatch(id) { calls.clearWatch.push(id) },
    getCurrentPosition(success, error, options) {
      calls.getCurrentPosition += 1
      calls.getCurrentPositionOptions.push(options)
      if (typeof getCurrentPosition === 'function') {
        getCurrentPosition(success, error, options)
        return
      }
      if (deliverFix) {
        success({
          coords: {
            latitude: deliverFix.lat,
            longitude: deliverFix.lon,
            accuracy: deliverFix.accuracy ?? null,
            altitude: deliverFix.altitude ?? null,
          },
          timestamp: deliverFix.timestamp ?? Date.now(),
        })
        return
      }
      error?.({ code: 3, message: 'timeout' })
    },
  }

  const navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 12)',
    platform: 'Linux',
    permissions: { query: async () => ({ state: permissionState }) },
    geolocation,
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [] }),
      enumerateDevices: async () => [],
    },
  }

  const restoreStack = []
  const setGlobal = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    restoreStack.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }

  setGlobal('document', document)
  setGlobal('window', window)
  setGlobal('navigator', navigator)
  setGlobal('CustomEvent', window.CustomEvent)
  setGlobal('localStorage', _localStorage)

  const runtime = {
    elements, calls, document, window,
    getElement: id => elements.get(id),
    getDocumentListeners: type => documentListeners.get(type) || [],
    restore() {
      while (restoreStack.length) { try { restoreStack.pop()() } catch {} }
      if (activeRuntime === runtime) activeRuntime = null
    },
  }
  activeRuntime = runtime
  return runtime
}

function _makeNativeCameraMock({ result = { photos: [] }, error = null, mode = 'capture' } = {}) {
  const mock = {
    calls: { capturePhotos: [], openSystemCamera: [] },
    async capturePhotos(options) {
      mock.calls.capturePhotos.push(options)
      if (error) throw error
      return result
    },
    async openSystemCamera() {
      mock.calls.openSystemCamera.push({})
      if (error) throw error
      return result
    },
  }
  return mock
}

function _makeSyncPickerCancel() {
  const err = new Error('cancelled')
  err.code = 'CANCELLED'
  return err
}

async function _waitFor(predicate, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return predicate()
}

const _noopLocalStorage = {
  getItem() { return null },
  setItem() {},
  removeItem() {},
  clear() {},
}

afterEach(async () => {
  if (activeRuntime) {
    try { stopCamera() } catch {}
    try { stopLocationWatch() } catch {}
    try { endCaptureLocationSession() } catch {}
    // Allow any queued async work (review lookups, AI availability) to settle
    // before restoring globals so the async tasks don't throw against undefined.
    await new Promise(resolve => setTimeout(resolve, 30))
    try { activeRuntime.restore() } catch {}
  }
  activeRuntime = null
  // Keep a permanent localStorage stub so background async work that fires
  // after teardown does not throw "Cannot read properties of undefined".
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true, value: _noopLocalStorage,
  })
  __setNativeCameraForTests(null)
  __setNativePhotoPipelineForTests({})
  _resetState()
})

test('Android native New Find launches the camera immediately; GPS request runs in parallel', async () => {
  // Camera-first: never block the native intent on a GPS fix. The initial
  // getCurrentPosition is fired in parallel with capturePhotos so any fix
  // that lands before the shutter fires is picked up by the capture window.
  let currentPositionSuccess = null
  const runtime = _makeRuntime({
    getCurrentPosition(success) {
      currentPositionSuccess = success
    },
  })
  initCapture()
  initCaptureLocationSheet()

  const nativeCamera = _makeNativeCameraMock()
  __setNativeCameraForTests(nativeCamera)

  const openPromise = openNativeCamera()
  await new Promise(resolve => setImmediate(resolve))

  // capturePhotos ran without waiting for the fix; the fix request is in flight.
  assert.equal(nativeCamera.calls.capturePhotos.length, 1)
  assert.equal(nativeCamera.calls.capturePhotos[0].gps, undefined)
  assert.equal(runtime.calls.getCurrentPosition, 1)
  assert.equal(runtime.calls.getCurrentPositionOptions[0].maximumAge, 0)
  assert.ok(typeof currentPositionSuccess === 'function', 'GPS request is still pending')

  await openPromise
})

test('granted location starts session, begins acquisition, then launches native camera', async () => {
  const runtime = _makeRuntime({ watchId: 4242 })
  initCapture()
  initCaptureLocationSheet()

  const nativeCamera = _makeNativeCameraMock({ result: { photos: [] } })
  __setNativeCameraForTests(nativeCamera)

  let sawSessionActive = false
  nativeCamera.capturePhotos = async (options) => {
    nativeCamera.calls.capturePhotos.push(options)
    sawSessionActive = state.captureSessionLocation.sessionStartAt instanceof Date
      && state.location.watchId === 4242
    return { photos: [] }
  }

  await openNativeCamera()

  assert.equal(getLocationPreference(), 'enabled')
  assert.equal(runtime.calls.watchPosition, 1)
  assert.equal(runtime.calls.getCurrentPosition, 1)
  assert.equal(nativeCamera.calls.capturePhotos.length, 1)
  assert.equal(nativeCamera.calls.openSystemCamera.length, 0)
  assert.equal(sawSessionActive, true, 'session + watch must be active when native camera launches')
})

test('"Not now" launches the native camera without location watch and keeps preference as ask', async () => {
  const runtime = _makeRuntime({ permissionState: 'blocked' })
  initCapture()
  initCaptureLocationSheet()

  const nativeCamera = _makeNativeCameraMock()
  __setNativeCameraForTests(nativeCamera)

  let sessionActiveAtLaunch = false
  nativeCamera.capturePhotos = async (options) => {
    nativeCamera.calls.capturePhotos.push(options)
    sessionActiveAtLaunch = state.captureSessionLocation.sessionStartAt instanceof Date
    return { photos: [] }
  }

  const openPromise = openNativeCamera()
  await new Promise(resolve => setImmediate(resolve))
  runtime.getElement('capture-location-secondary-btn').click()
  await openPromise

  assert.equal(runtime.calls.watchPosition, 0)
  assert.equal(getLocationPreference(), 'ask')
  assert.equal(nativeCamera.calls.capturePhotos.length, 1)
  assert.equal(sessionActiveAtLaunch, true)
})

test('System camera mode uses openSystemCamera (not capturePhotos) and still goes through preflight', async () => {
  const runtime = _makeRuntime({ permissionState: 'blocked' })
  initCapture()
  initCaptureLocationSheet()
  setUseSystemCamera(true)

  const nativeCamera = _makeNativeCameraMock()
  __setNativeCameraForTests(nativeCamera)

  const openPromise = openNativeCamera()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'flex')
  assert.equal(nativeCamera.calls.openSystemCamera.length, 0)
  runtime.getElement('capture-location-secondary-btn').click()
  await openPromise

  assert.equal(nativeCamera.calls.openSystemCamera.length, 1)
  assert.equal(nativeCamera.calls.capturePhotos.length, 0)

  setUseSystemCamera(false)
})

test('Native camera cancellation ends the live capture session cleanly', async () => {
  const runtime = _makeRuntime({ watchId: 909 })
  initCapture()
  initCaptureLocationSheet()
  setLocationPreference('enabled')

  const nativeCamera = _makeNativeCameraMock({ error: _makeSyncPickerCancel() })
  __setNativeCameraForTests(nativeCamera)

  await openNativeCamera()

  assert.equal(state.captureSessionLocation.sessionStartAt, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.watchId, null)
  assert.deepEqual(runtime.calls.clearWatch, [909])
  assert.equal(state.currentScreen, 'home')
})

test('initial native camera fix survives camera pause and resume timeout', async () => {
  const initialFix = { lat: 63.61, lon: 10.61, accuracy: 5, altitude: 25, timestamp: Date.now() - 1_000 }
  let getCurrentPositionCalls = 0
  const runtime = _makeRuntime({
    getCurrentPosition(success, error) {
      getCurrentPositionCalls += 1
      if (getCurrentPositionCalls === 1) {
        success({
          coords: {
            latitude: initialFix.lat,
            longitude: initialFix.lon,
            accuracy: initialFix.accuracy,
            altitude: initialFix.altitude,
          },
          timestamp: initialFix.timestamp,
        })
        return
      }
      error?.({ code: 3, message: 'resume timeout' })
    },
  })
  initCapture()
  initCaptureLocationSheet()

  const nativeCamera = _makeNativeCameraMock()
  __setNativeCameraForTests(nativeCamera)

  nativeCamera.capturePhotos = async (options) => {
    nativeCamera.calls.capturePhotos.push(options)
    assert.equal(state.captureSessionLocation.fix.lat, initialFix.lat)
    runtime.document.hidden = true
    runtime.document.visibilityState = 'hidden'
    runtime.document.dispatchEvent({ type: 'visibilitychange' })
    runtime.document.hidden = false
    runtime.document.visibilityState = 'visible'
    runtime.document.dispatchEvent({ type: 'visibilitychange' })
    await _waitFor(() => getCurrentPositionCalls >= 2)
    assert.equal(state.captureSessionLocation.fix.lat, initialFix.lat)
    assert.equal(state.location.status, 'fix')
    return { photos: [] }
  }

  await openNativeCamera()

  assert.equal(nativeCamera.calls.capturePhotos.length, 1)
})

test('no initial native camera fix still allows capture; the in-flight GPS request is fire-and-forget', async () => {
  let getCurrentPositionCalls = 0
  const runtime = _makeRuntime({
    getCurrentPosition(success, error) {
      void success
      getCurrentPositionCalls += 1
      error?.({ code: 3, message: 'timeout' })
    },
  })
  initCapture()
  initCaptureLocationSheet()

  const nativeCamera = _makeNativeCameraMock({
    result: { photos: [{ name: 'nofix.jpg', mimeType: 'image/jpeg' }] },
  })
  __setNativeCameraForTests(nativeCamera)
  __setNativePhotoPipelineForTests({
    async nativePickedPhotoToFile(photo, index) {
      return new File([new Blob([`bytes-${index}`], { type: 'image/jpeg' })], photo.name || `p${index}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      })
    },
    async processFile(file) {
      return {
        blob: file,
        aiBlob: file,
        meta: { aiCropRect: null, aiCropSourceW: 4000, aiCropSourceH: 3000, aiCropIsCustom: false },
      }
    },
  })

  nativeCamera.capturePhotos = async (options) => {
    nativeCamera.calls.capturePhotos.push(options)
    assert.equal(options.gps, undefined)
    return { photos: [{ name: 'nofix.jpg', mimeType: 'image/jpeg' }] }
  }

  await openNativeCamera()

  // A single fire-and-forget GPS request is enough — capture never blocks on it,
  // and no post-return retry is needed. The observation still gets a
  // capture-time-window fix from the running watch if one lands in time.
  assert.equal(nativeCamera.calls.capturePhotos.length, 1)
  assert.equal(getCurrentPositionCalls, 1)
})

test('Native camera returns photos → LIVE review uses captureSessionLocation.fix, reviewContext stays null', async () => {
  const sessionFix = { lat: 63.42, lon: 10.4, accuracy: 5, altitude: 30, timestamp: Date.now() }
  const runtime = _makeRuntime({ watchId: 707, deliverFix: sessionFix })
  initCapture()
  initCaptureLocationSheet()
  setLocationPreference('enabled')

  const nativeCamera = _makeNativeCameraMock({
    result: { photos: [{ name: 'p1.jpg', mimeType: 'image/jpeg' }, { name: 'p2.jpg', mimeType: 'image/jpeg' }] },
  })
  __setNativeCameraForTests(nativeCamera)
  __setNativePhotoPipelineForTests({
    async nativePickedPhotoToFile(photo, index) {
      return new File([new Blob([`bytes-${index}`], { type: 'image/jpeg' })], photo.name || `p${index}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      })
    },
    async processFile(file) {
      return {
        blob: file,
        aiBlob: file,
        meta: { aiCropRect: null, aiCropSourceW: 4000, aiCropSourceH: 3000, aiCropIsCustom: false },
      }
    },
  })

  await openNativeCamera()

  assert.equal(state.reviewContext, null, 'LIVE review must not set reviewContext')
  assert.equal(state.currentScreen, 'review')
  assert.equal(state.capturedPhotos.length, 2)
  assert.equal(state.capturedPhotos[0].gps.lat, sessionFix.lat)
  assert.equal(state.capturedPhotos[0].gps.lon, sessionFix.lon)
  assert.equal(state.capturedPhotos[1].gps.lat, sessionFix.lat)
  // Let review-screen background tasks (location lookup) settle before teardown.
  await new Promise(resolve => setTimeout(resolve, 20))
})

test('Native camera capturePhotos options include GPS from the live session fix', async () => {
  const sessionFix = { lat: 40.5, lon: -74.3, accuracy: 12, altitude: 20, timestamp: Date.now() }
  const runtime = _makeRuntime({ watchId: 808, deliverFix: sessionFix })
  initCapture()
  initCaptureLocationSheet()
  setLocationPreference('enabled')

  const nativeCamera = _makeNativeCameraMock()
  __setNativeCameraForTests(nativeCamera)

  await openNativeCamera()

  assert.equal(nativeCamera.calls.capturePhotos.length, 1)
  const options = nativeCamera.calls.capturePhotos[0]
  assert.equal(options.gps.latitude, sessionFix.lat)
  assert.equal(options.gps.longitude, sessionFix.lon)
  assert.equal(options.gps.altitude, sessionFix.altitude)
  assert.equal(options.gps.accuracy, sessionFix.accuracy)
})
