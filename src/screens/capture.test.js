import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { createDefaultObservationDraft } from '../observation-defaults.js'
import { state } from '../state.js'
import { LOCATION_STATE_CHANGED_EVENT, setLocationPreference, stopLocationWatch } from '../geo.js'
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
    querySelector() {
      return null
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
  ensure('capture-viewfinder')

  elements.get('capture-location-overlay').style.display = 'none'
  elements.get('camera-denied').style.display = 'none'

  const document = {
    getElementById(id) {
      return elements.get(id) || null
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

test('first live-capture entry shows the location prompt', async () => {
  const runtime = _makeRuntime({
    geolocation: {
      watchPosition() {
        throw new Error('watchPosition should not be called before the user chooses')
      },
    },
  })
  initCapture()

  const startPromise = startCamera()
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'flex')
  assert.equal(runtime.getElement('capture-location-title').textContent, 'Add a location to this find?')
  assert.equal(runtime.getElement('capture-location-primary-title').textContent, 'Use my location')
  assert.equal(runtime.getElement('capture-location-secondary-title').textContent, 'Continue without location')

  stopCamera()
  await startPromise
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

test('Continue without location does not start acquisition', async () => {
  const runtime = _makeRuntime()
  initCapture()

  const startPromise = startCamera()
  runtime.getElement('capture-location-secondary-btn').click()
  await startPromise

  assert.equal(runtime.cameraCalls.watchPosition, 0)
  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
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

test('persisted disabled preference skips acquisition', async () => {
  const runtime = _makeRuntime()
  setLocationPreference('disabled')
  initCapture()

  const startPromise = startCamera()
  await startPromise

  assert.equal(runtime.getElement('capture-location-overlay').style.display, 'none')
  assert.equal(runtime.cameraCalls.watchPosition, 0)
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
  assert.equal(runtime.getElement('gps-display').textContent, 'Location access is off')
  assert.equal(runtime.getElement('gps-pill').dataset.gpsState, 'disabled')

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
