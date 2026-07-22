import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { __setReviewTestHooks, _buildReviewObservationPayload, buildReviewGrid, initReview, openImportedReview, restoreReviewDraft, formatLatLon } from './review.js'
import { LOCATION_STATE_CHANGED_EVENT, beginCaptureLocationSession, endCaptureLocationSession } from '../geo.js'
import { state } from '../state.js'
import { createDefaultObservationDraft } from '../observation-defaults.js'

function _makeElement(id, tagName = 'div') {
  const listeners = {}
  const children = new Map()
  let html = ''
  let actionButtons = null
  return {
    id,
    tagName: tagName.toUpperCase(),
    style: { display: '' },
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false },
    },
    value: '',
    checked: false,
    textContent: '',
    get innerHTML() {
      return html
    },
    set innerHTML(value) {
      html = String(value ?? '')
      this.textContent = html.replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      actionButtons = null
    },
    disabled: false,
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
    querySelector(selector) {
      if (!children.has(selector)) {
        children.set(selector, _makeElement(`${id} ${selector}`))
      }
      return children.get(selector) || null
    },
    querySelectorAll(selector) {
      if (selector === '[data-review-location-action]') {
        if (!actionButtons) {
          const matches = [...html.matchAll(/data-review-location-action="([^"]+)"/g)]
          actionButtons = matches.map((match, index) => {
            const button = _makeElement(`${id} action ${index}`, 'button')
            button.dataset.reviewLocationAction = match[1]
            return button
          })
        }
        return actionButtons
      }
      return []
    },
    appendChild() {},
    setAttribute() {},
    removeAttribute() {},
    closest() {
      return null
    },
    focus() {},
    blur() {},
    getBoundingClientRect() {
      return { width: 0, height: 0, left: 0, top: 0 }
    },
  }
}

function _snapshotReviewState() {
  let locationPreference = null
  try {
    locationPreference = globalThis.localStorage?.getItem('sporely-location-preference') ?? null
  } catch {}
  return {
    capturedPhotos: state.capturedPhotos,
    reviewContext: state.reviewContext,
    batchCount: state.batchCount,
    captureDraft: state.captureDraft,
    sessionStart: state.sessionStart,
    currentScreen: state.currentScreen,
    captureSessionLocation: {
      ...state.captureSessionLocation,
      fix: state.captureSessionLocation.fix ? { ...state.captureSessionLocation.fix } : null,
    },
    location: {
      ...state.location,
      fix: state.location.fix ? { ...state.location.fix } : null,
      error: state.location.error ? { ...state.location.error } : null,
    },
    locationPreference,
    user: state.user ? { ...state.user } : null,
  }
}

function _restoreReviewState(snapshot) {
  state.capturedPhotos = snapshot.capturedPhotos
  state.reviewContext = snapshot.reviewContext
  state.batchCount = snapshot.batchCount
  state.captureDraft = snapshot.captureDraft
  state.sessionStart = snapshot.sessionStart
  state.currentScreen = snapshot.currentScreen
  state.captureSessionLocation = snapshot.captureSessionLocation
  state.location = snapshot.location
  try {
    if (globalThis.localStorage) {
      if (snapshot.locationPreference === null) {
        globalThis.localStorage.removeItem('sporely-location-preference')
      } else {
        globalThis.localStorage.setItem('sporely-location-preference', snapshot.locationPreference)
      }
    }
  } catch {}
  state.user = snapshot.user
}

function _installReviewGlobals({
  capacitor = null,
  fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }),
  setTimeout = (fn, _ms, ...args) => {
    fn(...args)
    return 1
  },
  clearTimeout = () => {},
  navigator = null,
} = {}) {
  const restoreStack = []
  const setGlobalProperty = (name, value) => {
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

  const elements = new Map()
  const documentListeners = new Map()
  const windowListeners = new Map()
  const document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, _makeElement(id))
      }
      return elements.get(id)
    },
    createElement(tagName) {
      return _makeElement(`auto-${tagName}-${elements.size}`, tagName)
    },
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
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
  }

  const window = {
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type
        this.detail = init.detail
      }
    },
    addEventListener(type, handler) {
      const list = windowListeners.get(type) || []
      list.push(handler)
      windowListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = windowListeners.get(type) || []
      windowListeners.set(type, list.filter(entry => entry !== handler))
    },
    dispatchEvent(event) {
      for (const handler of windowListeners.get(event.type) || []) {
        handler(event)
      }
      return true
    },
  }

  setGlobalProperty('document', document)
  setGlobalProperty('window', window)
  setGlobalProperty('CustomEvent', window.CustomEvent)
  if (capacitor !== null) setGlobalProperty('Capacitor', capacitor)
  setGlobalProperty('fetch', fetch)
  setGlobalProperty('setTimeout', setTimeout)
  setGlobalProperty('clearTimeout', clearTimeout)
  if (navigator !== null) setGlobalProperty('navigator', navigator)

  return {
    document,
    window,
    elements,
    restore() {
      while (restoreStack.length) {
        const restore = restoreStack.pop()
        try {
          restore()
        } catch {}
      }
    },
  }
}

function _click(element) {
  element.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} })
}

async function _waitFor(predicate, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true
    await new Promise(resolve => setImmediate(resolve))
  }
  return predicate()
}

let reviewStateSeed = 0

function _seedReviewState({
  imported = false,
  liveFix = null,
  importedGps = null,
  location = {},
  locationName = '',
  sessionStart = null,
  user = null,
} = {}) {
  // Recent by default so the capture lock window (last photo + grace) is
  // open in live-review tests; pass an explicit old sessionStart to test
  // closed-window behavior.
  const resolvedSessionStart = sessionStart || new Date(Date.now() - 10_000 + reviewStateSeed++)
  const reviewGps = imported ? importedGps : liveFix
  state.capturedPhotos = [{
    blob: new Blob(['photo']),
    aiBlob: new Blob(['photo']),
    blobPromise: null,
    gps: reviewGps ? { ...reviewGps } : null,
    ts: new Date(resolvedSessionStart),
    emoji: '🖼️',
    aiCropRect: null,
    aiCropSourceW: null,
    aiCropSourceH: null,
    aiCropIsCustom: false,
    taxon: null,
  }]
  state.reviewContext = imported
    ? {
        source: 'import',
        gps: importedGps ? { ...importedGps } : null,
        locationName,
        locationLookup: null,
        metadataPromise: null,
      }
    : null
  state.batchCount = state.capturedPhotos.length
  state.sessionStart = resolvedSessionStart
  state.captureSessionLocation = {
    ...state.captureSessionLocation,
    fix: liveFix ? { ...liveFix } : null,
    sessionStartAt: resolvedSessionStart,
    requestingFreshFix: false,
  }
  state.location = {
    ...state.location,
    preference: location.preference || 'enabled',
    capability: location.capability || 'supported',
    permission: location.permission || 'granted',
    status: location.status || (liveFix ? 'fix' : 'idle'),
    fix: location.fix ? { ...location.fix } : null,
    error: location.error ? { ...location.error } : null,
    watchId: null,
  }
  state.user = user ? { ...user } : null
  state.captureDraft = createDefaultObservationDraft()
  state.currentScreen = 'review'
}

test('review service-tab clicks update the ai block without rebuilding the grid', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')
  const start = source.indexOf("tab.addEventListener('click', () => {")
  const end = source.indexOf('// Wire the in-card uncertain toggle (replaces the static #review-uncertain)')

  assert.ok(start >= 0)
  assert.ok(end > start)

  const block = source.slice(start, end)
  assert.match(block, /_renderReviewAiBlock\(\)/)
  assert.match(block, /shouldRunServiceFromTab\(serviceState\)/)
  assert.doesNotMatch(block, /buildReviewGrid\(\)/)

  assert.match(source, /resultsEl\.querySelectorAll\('\[data-identify-result\]'\)/)
  assert.match(source, /_renderReviewAiResults\(\)[\s\S]*resultsEl\.innerHTML = _reviewAiResultsHtml\(\)/)
})

test('review crop hint switches to adjust copy and disappears once a custom crop exists', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /const cropStatusHtml = croppedCount\s*\?\s*''\s*:\s*`<div class="capture-session-crop-status">\$\{t\('review\.aiCropHint'\)\}<\/div>`/)
  assert.match(source, /shouldShowAiCropOverlay\(p\.aiCropRect, p\.aiCropIsCustom\)/)
  assert.doesNotMatch(source, /Tap a photo to add AI crop/)
})

test('review location events update metadata without rebuilding thumbnails', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')
  const listenerStart = source.indexOf('reviewLocationStateListener = () => {')
  const listenerEnd = source.indexOf('currentWindow.addEventListener(LOCATION_STATE_CHANGED_EVENT', listenerStart)
  assert.ok(listenerStart >= 0)
  assert.ok(listenerEnd > listenerStart)

  const listenerBlock = source.slice(listenerStart, listenerEnd)
  assert.match(listenerBlock, /_syncReviewLocationStateUi\(\)/)
  assert.doesNotMatch(listenerBlock, /buildReviewGrid\(\)/)
  assert.doesNotMatch(listenerBlock, /loadThumbnails\(/)
})

test('live review uses the capture-session fix', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    const liveFix = { lat: 61.12345, lon: 10.54321, accuracy: 12.4, altitude: 432.1, timestamp: 1710000000000 }
    _seedReviewState({
      liveFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
        fix: { lat: 1, lon: 2, accuracy: 99, altitude: 5, timestamp: 1710000000100 },
      },
    })

    initReview()
    buildReviewGrid()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(env.document.getElementById('meta-coordinates').textContent, formatLatLon(liveFix, 5))
    assert.equal(env.document.getElementById('meta-accuracy').textContent, '± 12 m')
    assert.equal(env.document.getElementById('meta-altitude').textContent, '432 m ASL')
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±12 m')
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('valid session fix plus later timeout still shows location ready', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    const liveFix = { lat: 61.12345, lon: 10.54321, accuracy: 12.4, altitude: 432.1, timestamp: 1710000000000 }
    _seedReviewState({
      liveFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'timeout',
        error: { kind: 'timeout', message: 'Location request timed out' },
      },
    })

    initReview()
    buildReviewGrid()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(env.document.getElementById('meta-coordinates').textContent, formatLatLon(liveFix, 5))
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±12 m')
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('valid session fix plus later unavailable error shows no warning', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    const liveFix = { lat: 60.98765, lon: 9.54321, accuracy: 6.1, altitude: 44, timestamp: 1710000000000 }
    _seedReviewState({
      liveFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'unavailable',
        error: { kind: 'position-unavailable', message: 'Position unavailable' },
      },
    })

    initReview()
    buildReviewGrid()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(env.document.getElementById('meta-coordinates').textContent, formatLatLon(liveFix, 5))
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±6 m')
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('imported review keeps imported GPS separate from the live session fix', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    const importedGps = { lat: 63.2468, lon: 11.1357, accuracy: 8.2, altitude: 211.4, timestamp: 1710000000200 }
    const liveFix = { lat: 60.0001, lon: 9.0002, accuracy: 99.9, altitude: 12, timestamp: 1710000000300 }
    _seedReviewState({
      imported: true,
      importedGps,
      liveFix,
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
      },
    })

    initReview()
    buildReviewGrid()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(env.document.getElementById('meta-coordinates').textContent, formatLatLon(importedGps, 5))
    assert.equal(env.document.getElementById('meta-accuracy').textContent, '± 8 m')
    assert.equal(env.document.getElementById('meta-altitude').textContent, '211 m ASL')
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±8 m')
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('a delayed live fix updates the review coordinates and reverse location', async () => {
  const snapshot = _snapshotReviewState()
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  const env = _installReviewGlobals({
    fetch: async url => {
      const href = String(url)
      if (href.includes('stedsnavn.artsdatabanken.no')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            navn: 'Mossesvingen',
            dist: 0.001,
            country_code: 'no',
            country_name: 'Norge',
            source: 'artsdatabanken',
          }),
        }
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      }
    },
  })

  try {
    globalThis.setTimeout = (fn, _ms, ...args) => {
      fn(...args)
      return 1
    }
    globalThis.clearTimeout = () => {}

    const nextFix = { lat: 62.2468, lon: 10.1357, accuracy: 7.2, altitude: 155.1, timestamp: 1710000000400 }
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'locating',
      },
    })

    initReview()
    buildReviewGrid()
    assert.equal(env.document.getElementById('review-coords-text').textContent, '')
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Finding location…')

    state.captureSessionLocation.fix = { ...nextFix }
    state.location.fix = { ...nextFix }
    state.location.status = 'fix'
    state.location.error = null
    state.location.permission = 'granted'
    env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(env.document.getElementById('meta-coordinates').textContent, formatLatLon(nextFix, 5))
    assert.equal(env.document.getElementById('meta-accuracy').textContent, '± 7 m')
    assert.equal(env.document.getElementById('meta-altitude').textContent, '155 m ASL')
    assert.equal(env.document.getElementById('review-location').textContent, 'Mossesvingen')
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±7 m')
  } finally {
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('manual place names stay distinct from captured coordinates', () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    initReview()
    env.document.getElementById('location-name-input').value = 'Trailhead'
    buildReviewGrid()

    assert.equal(env.document.getElementById('location-name-input').value, 'Trailhead')
    assert.equal(env.document.getElementById('review-location').textContent, '')
    assert.equal(env.document.getElementById('meta-coordinates').textContent, '—')
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'No location · Tap to fix')
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('review never displays coordinates while claiming they will not be saved', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    const liveFix = { lat: 61.22222, lon: 10.33333, accuracy: 9.4, altitude: 88, timestamp: 1710000000000 }
    const cases = [
      {
        label: 'timeout',
        status: 'timeout',
        error: { kind: 'timeout', message: 'Location request timed out' },
      },
      {
        label: 'unavailable',
        status: 'unavailable',
        error: { kind: 'position-unavailable', message: 'Position unavailable' },
      },
    ]

    for (const item of cases) {
      _seedReviewState({
        liveFix,
        user: { id: 'user-1' },
        location: {
          preference: 'enabled',
          capability: 'supported',
          permission: 'granted',
          status: item.status,
          error: item.error,
        },
      })
      initReview()
      buildReviewGrid()
      await new Promise(resolve => setImmediate(resolve))

      const coordinates = env.document.getElementById('meta-coordinates').textContent
      assert.notEqual(coordinates, '—', item.label)
      assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±9 m', item.label)
    }
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('live review saves an existing session fix without requesting location', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let savedPayload = null

  try {
    const liveFix = { lat: 60.1111, lon: 10.2222, accuracy: 4.4, altitude: 123.0, timestamp: 1710000000600 }
    _seedReviewState({
      liveFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        return null
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(requestCount, 0)
    assert.equal(savedPayload.gps_latitude, liveFix.lat)
    assert.equal(savedPayload.gps_longitude, liveFix.lon)
    assert.equal(savedPayload.gps_accuracy, liveFix.accuracy)
    assert.equal(savedPayload.gps_altitude, liveFix.altitude)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
    assert.equal(state.captureSessionLocation.fix, null)
    assert.equal(state.captureSessionLocation.sessionStartAt, null)
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('imported review save payload preserves resolved geography from review context', () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    _seedReviewState({
      imported: true,
      importedGps: { lat: 61.5, lon: 10.2, accuracy: 12, altitude: 41 },
      locationName: 'Imported ridge',
      user: { id: 'user-1' },
    })
    env.document.getElementById('location-name-input').value = 'Imported ridge'
    state.reviewContext.locationLookup = {
      country_code: 'ca',
      region_id: 'region-456',
    }

    const obsPayload = _buildReviewObservationPayload()
    assert.equal(obsPayload.country_code, 'CA')
    assert.equal(obsPayload.region_id, 'region-456')
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('failed enqueue preserves the live session', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let consoleErrorCalls = []
  const previousConsoleError = console.error

  try {
    console.error = (...args) => {
      consoleErrorCalls.push(args)
    }

    const liveFix = { lat: 60.1111, lon: 10.2222, accuracy: 4.4, altitude: 123.0, timestamp: 1710000000600 }
    _seedReviewState({
      liveFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        return null
      },
      enqueueObservation: async () => {
        throw new Error('enqueue failed')
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await new Promise(resolve => setTimeout(resolve, 150))
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(requestCount, 0)
    assert.equal(consoleErrorCalls.length > 0, true)
    assert.match(String(consoleErrorCalls[0]?.[0] || ''), /Sync error/)
    assert.match(String(consoleErrorCalls[0]?.[1]?.message || ''), /enqueue failed/)
    assert.deepEqual(state.captureSessionLocation.fix, liveFix)
    assert.equal(state.captureSessionLocation.sessionStartAt instanceof Date, true)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    console.error = previousConsoleError
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('saving without a fix opens the sheet immediately and Try again saves the fresh fix', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let savedPayload = null

  try {
    const freshFix = { lat: 61.3333, lon: 11.4444, accuracy: 6.6, altitude: 222.2, timestamp: 1710000000700 }
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        state.captureSessionLocation.fix = { ...freshFix }
        state.location.fix = { ...freshFix }
        state.location.status = 'fix'
        state.location.error = null
        env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
        return {
          ...state.location,
          fix: state.location.fix ? { ...state.location.fix } : null,
          error: state.location.error ? { ...state.location.error } : null,
        }
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => env.document.getElementById('location-fix-overlay').style.display === 'flex')

    // No automatic GPS wait: the sheet appears immediately, no request fired.
    assert.equal(requestCount, 0)
    assert.equal(savedPayload, null)

    _click(env.document.getElementById('location-fix-try-again'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(requestCount, 1)
    assert.equal(savedPayload.gps_latitude, freshFix.lat)
    assert.equal(savedPayload.gps_longitude, freshFix.lon)
    assert.equal(savedPayload.gps_accuracy, freshFix.accuracy)
    assert.equal(savedPayload.gps_altitude, freshFix.altitude)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('save opens the sheet immediately and a failed retry re-opens it until one succeeds', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let savedPayload = null

  try {
    const retryFix = { lat: 62.5555, lon: 12.6666, accuracy: 7.7, altitude: 333.3, timestamp: 1710000000800 }
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        if (requestCount === 1) {
          state.location.status = 'timeout'
          state.location.error = { kind: 'timeout', message: 'Location request timed out' }
          env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
          return {
            ...state.location,
            fix: null,
            error: { ...state.location.error },
          }
        }
        state.captureSessionLocation.fix = { ...retryFix }
        state.location.fix = { ...retryFix }
        state.location.status = 'fix'
        state.location.error = null
        env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
        return {
          ...state.location,
          fix: { ...state.location.fix },
          error: null,
        }
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => env.document.getElementById('location-fix-overlay').style.display === 'flex')

    const sheet = env.document.getElementById('location-fix-overlay')
    assert.equal(sheet.style.display, 'flex')

    // First retry times out → the sheet reappears; second retry succeeds.
    _click(env.document.getElementById('location-fix-try-again'))
    await _waitFor(() => requestCount === 1 && sheet.style.display === 'flex')
    _click(env.document.getElementById('location-fix-try-again'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(requestCount, 2)
    assert.equal(savedPayload.gps_latitude, retryFix.lat)
    assert.equal(savedPayload.gps_longitude, retryFix.lon)
    assert.equal(sheet.style.display, 'none')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('save without coordinates preserves the preference and saves null gps fields', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let savedPayload = null

  try {
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        state.location.status = 'timeout'
        state.location.error = { kind: 'timeout', message: 'Location request timed out' }
        env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
        return {
          ...state.location,
          fix: null,
          error: { ...state.location.error },
        }
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => env.document.getElementById('location-fix-overlay').style.display === 'flex')
    _click(env.document.getElementById('location-fix-continue'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(state.location.preference, 'enabled')
    assert.equal(savedPayload.gps_latitude, null)
    assert.equal(savedPayload.gps_longitude, null)
    assert.equal(savedPayload.gps_accuracy, null)
    assert.equal(savedPayload.gps_altitude, null)
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('disabled location preference skips acquisition during save', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let savedPayload = null

  try {
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'disabled',
        capability: 'supported',
        permission: 'denied',
        status: 'idle',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        return null
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(requestCount, 0)
    assert.equal(savedPayload.gps_latitude, null)
    assert.equal(savedPayload.gps_longitude, null)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('repeated save clicks enqueue only once', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let enqueueCount = 0
  let resolveEnqueue = null

  try {
    const liveFix = { lat: 63.7777, lon: 13.8888, accuracy: 9.9, altitude: 444.4, timestamp: 1710000000900 }
    _seedReviewState({
      liveFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => null,
      enqueueObservation: async () => {
        enqueueCount += 1
        return new Promise(resolve => {
          resolveEnqueue = resolve
        })
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => enqueueCount > 0)
    assert.equal(enqueueCount, 1)
    resolveEnqueue?.()
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('cancel clears the live session and any save sheet state', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    _seedReviewState({
      liveFix: { lat: 64.1111, lon: 14.2222, accuracy: 11.1, altitude: 555.5, timestamp: 1710000001000 },
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
      },
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-close'))
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(state.capturedPhotos.length, 0)
    assert.equal(state.reviewContext, null)
    assert.equal(state.captureSessionLocation.fix, null)
    assert.equal(state.captureSessionLocation.sessionStartAt, null)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('review save flow uses the decision sheet instead of window.confirm', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /window\.confirm/)
  assert.match(source, /showLocationFixSheet\(\)/)
  assert.match(source, /_reviewDependency\('requestFreshLocation'\)\(\{\s*maxAgeMs:\s*30_000,\s*timeoutMs:\s*8_000,\s*enableHighAccuracy:\s*true,/)
})

test('review ai flow keeps the setting-selected primary service and refreshes availability without rebuilding the grid', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /reviewAiState\.activeService = _resolveReviewPhotoIdServices\(reviewAiState\.availability\)\.primary/)
  assert.match(source, /const primaryService = overrideService\s*\?\s*requestedServices\[0\]\s*:\s*\(requestedServices\[0\] \|\| photoIdServices\.primary\)/)
  assert.match(source, /reviewAiState\.activeService = primaryService/)
  assert.match(source, /const inaturalistSession = await loadInaturalistSession\(\)\s+const availabilityList = await getAvailableIdentifyServices\(\{\s+blobs: images,\s+inaturalistSession,/)
  assert.match(source, /if \(!reviewAiState\.activeService\) {\s+reviewAiState\.activeService = _resolveReviewPhotoIdServices\(reviewAiState\.availability\)\.primary\s+}/)
  assert.match(source, /reviewAiState\.running = false\s+reviewAiState\.stale = false\s+reviewAiState\.requestedFingerprint = reviewAiState\.currentFingerprint\s+reviewAiState\.activeService = primaryService\s+_renderReviewAiBlock\(\)/)
  const controlsStart = source.indexOf('function _renderReviewAiControls()')
  const controlsEnd = source.indexOf('async function _syncReviewAiAvailability()')
  assert.ok(controlsStart >= 0)
  assert.ok(controlsEnd > controlsStart)
  const controlsBlock = source.slice(controlsStart, controlsEnd)
  assert.match(controlsBlock, /review-redlist-summary/)
  assert.match(controlsBlock, /review-redlist-summary[\s\S]*data-identify-run-button/)
  const gridStart = source.indexOf('const grid = document.getElementById(\'observation-grid\')')
  const gridEnd = source.indexOf('function loadThumbnails(')
  assert.ok(gridStart >= 0)
  assert.ok(gridEnd > gridStart)
  const gridBlock = source.slice(gridStart, gridEnd)
  assert.doesNotMatch(gridBlock, /review-redlist-summary/)
  assert.doesNotMatch(source, /chooseIdentifyComparisonActiveService/)
  assert.doesNotMatch(source, /comparison\.activeService/)
  assert.doesNotMatch(source, /buildReviewGrid\(\)\s*\/\/.*availability/)
})

test('review keeps ai result state separate from manual taxon selection and queued saves', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /getReviewServiceDisplayProbability/)
  assert.match(source, /selectedPredictionByService/)
  assert.match(source, /selectedProbabilityByService/)
  assert.match(source, /aiIdentificationRuns/)
  assert.match(source, /score\.textContent = _reviewAiHasProbability\(state\.displayProbability\)/)
  assert.doesNotMatch(source, /selectedTaxon:\s*taxon/)
  assert.doesNotMatch(source, /reviewAiState\.resultsByService\[normalizeIdentifyService\(pred\.service\)\]\s*=\s*{\s*\.\.\./)
})

test('review keeps ai results visible after taxon selection and scores follow the top probability first', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  const sharedTaxonStart = source.indexOf('function setSharedTaxon(')
  const sharedTaxonEnd = source.indexOf('function applyTaxon(')
  assert.ok(sharedTaxonStart >= 0)
  assert.ok(sharedTaxonEnd > sharedTaxonStart)
  const sharedTaxonBlock = source.slice(sharedTaxonStart, sharedTaxonEnd)

  assert.match(sharedTaxonBlock, /taxon-dropdown/)
  assert.doesNotMatch(sharedTaxonBlock, /data-identify-results/)
  assert.match(source, /resultsEl\.style\.display = ''/)

  const probabilityStart = source.indexOf('export function getReviewServiceDisplayProbability')
  const probabilityEnd = source.indexOf('// ── Grid build ────────────────────────────────────────────────────────────────')
  assert.ok(probabilityStart >= 0)
  assert.ok(probabilityEnd > probabilityStart)
  const probabilityBlock = source.slice(probabilityStart, probabilityEnd)

  assert.match(probabilityBlock, /getIdentifyTopProbability/)
  assert.match(probabilityBlock, /selectedProbabilityByService/)
  assert.match(probabilityBlock, /selectedPrediction/)
})

test('review init tolerates missing review shell nodes without throwing', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    getElementById() {
      return null
    },
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
    },
  }

  try {
    assert.doesNotThrow(() => initReview())
  } finally {
    globalThis.document = previousDocument
  }
})

test('imported review does not start or resume live location', async () => {
  const restoreStack = []
  const setGlobalProperty = (name, value) => {
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
  const previousState = {
    capturedPhotos: state.capturedPhotos,
    reviewContext: state.reviewContext,
    batchCount: state.batchCount,
    captureSessionLocation: {
      ...state.captureSessionLocation,
      fix: state.captureSessionLocation.fix ? { ...state.captureSessionLocation.fix } : null,
    },
    location: {
      ...state.location,
      fix: state.location.fix ? { ...state.location.fix } : null,
      error: state.location.error ? { ...state.location.error } : null,
    },
    currentScreen: state.currentScreen,
  }
  const elements = new Map()
  const documentListeners = new Map()
  let watchCalls = 0

  const document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, _makeElement(id))
      }
      return elements.get(id)
    },
    createElement(tagName) {
      return _makeElement(`auto-${tagName}-${elements.size}`, tagName)
    },
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
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
  }

  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousNavigator = globalThis.navigator
  const previousCustomEvent = globalThis.CustomEvent
  setGlobalProperty('document', document)
  setGlobalProperty('window', {
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type
        this.detail = init.detail
      }
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true
    },
  })
  setGlobalProperty('CustomEvent', globalThis.window.CustomEvent)
  setGlobalProperty('navigator', {
    geolocation: {
      watchPosition() {
        watchCalls += 1
        return 11
      },
      clearWatch() {},
    },
    permissions: {
      query: async () => ({ state: 'granted' }),
    },
  })

  try {
    openImportedReview({
      files: [new Blob(['x'])],
      ts: new Date(),
      visibility: 'public',
      location_precision: 'exact',
      is_draft: true,
      photoGps: [],
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(watchCalls, 0)
    assert.equal(documentListeners.get('visibilitychange')?.length || 0, 0)
    assert.equal(state.reviewContext?.source, 'import')
  } finally {
    state.capturedPhotos = previousState.capturedPhotos
    state.reviewContext = previousState.reviewContext
    state.batchCount = previousState.batchCount
    state.captureSessionLocation = previousState.captureSessionLocation
    state.location = previousState.location
    state.currentScreen = previousState.currentScreen
    while (restoreStack.length) {
      const restore = restoreStack.pop()
      try {
        restore()
      } catch {}
    }
  }
})

test('imported review ignores live location events', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    initReview()
    openImportedReview({
      files: [new Blob(['x'])],
      ts: new Date('2026-07-13T12:00:00.000Z'),
      gpsLat: 61.12345,
      gpsLon: 10.54321,
      gpsAccuracy: 8,
      gpsAltitude: 44,
      locationName: 'Imported ridge',
      photoGps: [],
      visibility: 'public',
      location_precision: 'exact',
      is_draft: true,
    })
    buildReviewGrid()

    const beforeGps = env.document.getElementById('review-gps-display').textContent
    const beforeLocation = env.document.getElementById('review-location').textContent

    state.location.fix = {
      lat: 64.321,
      lon: 11.654,
      accuracy: 4,
      altitude: 99,
      timestamp: Date.now(),
    }
    state.location.status = 'fix'
    state.location.permission = 'granted'
    state.location.error = null
    env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(env.document.getElementById('review-gps-display').textContent, beforeGps)
    assert.equal(env.document.getElementById('review-location').textContent, beforeLocation)
    assert.equal(state.reviewContext?.source, 'import')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('save-time location request reaches the real geolocation API with a valid session token', async () => {
  const snapshot = _snapshotReviewState()
  let geoCalls = 0
  const env = _installReviewGlobals({
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    navigator: {
      geolocation: {
        getCurrentPosition(success) {
          geoCalls += 1
          success({
            coords: { latitude: 63.42, longitude: 10.39, accuracy: 8, altitude: 150 },
            timestamp: Date.now(),
          })
        },
        watchPosition() { return 1 },
        clearWatch() {},
      },
    },
  })
  let savedPayload = null

  try {
    beginCaptureLocationSession()
    _seedReviewState({
      liveFix: null,
      sessionStart: new Date(Date.now() - 60_000),
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    // requestFreshLocation is intentionally NOT stubbed here: this test walks
    // the real geo.js path to catch token-validation regressions the
    // dependency-injected tests cannot see (the 'live:<ms>' string vs numeric
    // session-counter mismatch that silently blocked all save-time GPS).
    __setReviewTestHooks({
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    for (let i = 0; i < 100 && env.document.getElementById('location-fix-overlay').style.display !== 'flex'; i++) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 20))
    }
    assert.equal(geoCalls, 0)
    _click(env.document.getElementById('location-fix-try-again'))
    for (let i = 0; i < 100 && savedPayload === null; i++) {
      await new Promise(resolve => globalThis.setTimeout(resolve, 20))
    }

    assert.equal(geoCalls, 1)
    assert.ok(savedPayload, 'save must complete with the fresh fix')
    assert.equal(savedPayload.gps_latitude, 63.42)
    assert.equal(savedPayload.gps_longitude, 10.39)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    endCaptureLocationSession()
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('the progress overlay is hidden whenever the save location sheet awaits a decision', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let savedPayload = null

  try {
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        state.location.status = 'timeout'
        state.location.error = { kind: 'timeout', message: 'Location request timed out' }
        env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
        return { ...state.location, fix: null, error: { ...state.location.error } }
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => env.document.getElementById('location-fix-overlay').style.display === 'flex')

    // The progress overlay paints above the review screen's stacking context;
    // if it stayed visible it would swallow the sheet's taps (freeze bug).
    assert.equal(env.document.getElementById('import-progress').style.display, 'none')
    // While a save is in flight the GPS pill is hidden: progress text and the
    // sheet are the only location feedback after Save is pressed.
    assert.equal(env.document.getElementById('review-gps-status').style.display, 'none')

    _click(env.document.getElementById('location-fix-continue'))
    await _waitFor(() => savedPayload !== null)
    assert.ok(savedPayload)
    // Save exited while still on the review screen (stubs skip navigation),
    // so the pill is restored and resynced.
    assert.equal(env.document.getElementById('review-gps-status').style.display, '')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('save location sheet is mounted at the app root, outside any screen stacking context', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const overlayIndex = html.indexOf('id="location-fix-overlay"')
  const progressIndex = html.indexOf('id="import-progress"')
  const screenReviewIndex = html.indexOf('id="screen-review"')
  const nextScreenIndex = html.indexOf('id="screen-find-detail"')

  assert.ok(overlayIndex > 0)
  assert.ok(progressIndex > 0)
  assert.ok(screenReviewIndex > 0 && nextScreenIndex > screenReviewIndex)
  assert.ok(
    !(overlayIndex > screenReviewIndex && overlayIndex < nextScreenIndex),
    'sheet must not live inside #screen-review — .screen.active z-index:1 traps it below #import-progress',
  )
  assert.ok(
    overlayIndex > progressIndex,
    'sheet must be a later sibling of #import-progress at the #app root',
  )
  // Static copy and the three (and only three) options of the shared sheet.
  assert.match(html, /Location is not ready/)
  assert.match(html, /Sporely could not determine your position\./)
  assert.match(html, /Open location settings/)
  assert.match(html, /id="location-fix-try-again"/)
  assert.match(html, /Continue without location/)
  assert.doesNotMatch(html, /Enter place manually/)
  assert.doesNotMatch(html, /Save without coordinates/)
})

test('save flow hides progress before the sheet and passes the real geo session token', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')
  assert.match(source, /_hideProgress\(\)\s*\n\s*const decision = await showLocationFixSheet\(\)/)
  assert.match(source, /captureSessionRequestToken: getCaptureSessionRequestToken\(\)/)
  assert.doesNotMatch(source, /captureSessionRequestToken: sessionToken/)
  assert.match(source, /const finalGps = locationResult\.gps \?\? null/)
})

test('closed capture window blocks silent save-time acquisition; explicit retry overrides it', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let savedPayload = null

  try {
    const retryFix = { lat: 62.9, lon: 12.9, accuracy: 6, altitude: 300, timestamp: Date.now() }
    // Photos captured 10 minutes ago — well past the 90 s grace window.
    _seedReviewState({
      liveFix: null,
      sessionStart: new Date(Date.now() - 600_000),
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        state.captureSessionLocation.fix = { ...retryFix }
        state.location.fix = { ...retryFix }
        state.location.status = 'fix'
        state.location.error = null
        env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })
        return { ...state.location, fix: { ...state.location.fix }, error: null }
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    assert.equal(Number.isFinite(state.captureSessionLocation.captureWindowEndAt), true)

    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => env.document.getElementById('location-fix-overlay').style.display === 'flex')

    // The window is closed: the app must NOT have silently requested the
    // walking-away position — it goes straight to the sheet.
    assert.equal(requestCount, 0)

    // Explicit "Try again" is user consent to use the current position.
    _click(env.document.getElementById('location-fix-try-again'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(requestCount, 1)
    assert.equal(savedPayload.gps_latitude, retryFix.lat)
    assert.equal(savedPayload.gps_longitude, retryFix.lon)
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('per-photo gps is used for a live save when the session never got a fix', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let requestCount = 0
  let savedPayload = null

  try {
    const photoGps = { lat: 59.1234, lon: 9.5678, accuracy: 12, altitude: 210 }
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'idle',
      },
    })
    state.capturedPhotos[0].gps = { ...photoGps }

    __setReviewTestHooks({
      requestFreshLocation: async () => {
        requestCount += 1
        return null
      },
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(requestCount, 0)
    assert.equal(savedPayload.gps_latitude, photoGps.lat)
    assert.equal(savedPayload.gps_longitude, photoGps.lon)
    assert.equal(savedPayload.gps_accuracy, photoGps.accuracy)
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('the more accurate of session fix and photo gps wins a live save', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()
  let savedPayload = null

  try {
    const sessionFix = { lat: 60.5, lon: 10.5, accuracy: 5, altitude: 120, timestamp: Date.now() }
    _seedReviewState({
      liveFix: sessionFix,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'fix',
      },
    })
    // A coarser at-shutter snapshot must not beat the better session fix.
    state.capturedPhotos[0].gps = { lat: 60.5001, lon: 10.5001, accuracy: 50, altitude: 120 }

    __setReviewTestHooks({
      requestFreshLocation: async () => null,
      enqueueObservation: async payload => {
        savedPayload = payload
      },
      refreshHome: async () => {},
      openFinds: async () => {},
      openLocationSuggestions: () => {},
    })

    initReview()
    buildReviewGrid()
    _click(env.document.getElementById('review-save-btn'))
    await _waitFor(() => savedPayload !== null)

    assert.equal(savedPayload.gps_latitude, sessionFix.lat)
    assert.equal(savedPayload.gps_accuracy, sessionFix.accuracy)
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('restoreReviewDraft rebuilds the live session and opens the review screen', async () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    state.currentScreen = 'home'
    state.capturedPhotos = []
    const photoTs = Date.now() - 600_000
    const restoredOk = restoreReviewDraft({
      photos: [{
        blob: new Blob(['photo'], { type: 'image/webp' }),
        aiBlob: new Blob(['photo'], { type: 'image/webp' }),
        blobPromise: null,
        gps: { lat: 61.7, lon: 9.8, accuracy: 9, altitude: 700 },
        ts: new Date(photoTs),
        emoji: '📸',
        taxon: null,
        aiCropRect: null,
        aiCropSourceW: null,
        aiCropSourceH: null,
        aiCropIsCustom: false,
      }],
      sessionStartAt: photoTs - 5_000,
      captureWindowEndAt: photoTs + 90_000,
      sessionFix: { lat: 61.7, lon: 9.8, accuracy: 4, altitude: 698, timestamp: photoTs },
      captureDraft: { habitat: 'alpine heath', notes: 'restored', uncertain: true, visibility: 'private', is_draft: true, location_precision: 'exact' },
      locationName: 'Rondane',
    })

    assert.equal(restoredOk, true)
    assert.equal(state.currentScreen, 'review')
    assert.equal(state.reviewContext, null)
    assert.equal(state.capturedPhotos.length, 1)
    assert.equal(state.capturedPhotos[0].gps.lat, 61.7)
    assert.equal(state.captureDraft.habitat, 'alpine heath')
    assert.equal(state.captureDraft.uncertain, true)
    assert.equal(state.captureSessionLocation.fix.lat, 61.7)
    assert.equal(state.captureSessionLocation.sessionStartAt.getTime(), photoTs - 5_000)
    // Photos are 10 minutes old: the capture window must be closed so a
    // save cannot silently pick up the current (post-crash) position.
    assert.equal(Number.isFinite(state.captureSessionLocation.captureWindowEndAt), true)
    assert.equal(state.captureSessionLocation.captureWindowEndAt < Date.now(), true)
    assert.equal(env.document.getElementById('location-name-input').value, 'Rondane')

    assert.equal(restoreReviewDraft(null), false)
    assert.equal(restoreReviewDraft({ photos: [] }), false)

    // Let the async location lookup kicked off by buildReviewGrid settle
    // before tearing down the fake DOM.
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})

test('review pill shows No location and tapping it opens the sheet; settings option opens app settings', async () => {
  const snapshot = _snapshotReviewState()
  let openSettingsCalls = 0
  const env = _installReviewGlobals({
    capacitor: {
      Plugins: { App: { openSettings: async () => { openSettingsCalls += 1 } } },
    },
  })

  try {
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'denied',
        status: 'error',
        error: { kind: 'permission-denied', message: 'Permission denied' },
      },
    })

    initReview()
    buildReviewGrid()

    assert.equal(env.document.getElementById('review-gps-display').textContent, 'No location · Tap to fix')
    assert.equal(env.document.getElementById('review-gps-pill').dataset.gpsState, 'none')
    assert.equal(env.document.getElementById('review-gps-pill').dataset.gpsAction, 'fix')

    _click(env.document.getElementById('review-gps-pill'))
    await _waitFor(() => env.document.getElementById('location-fix-overlay').style.display === 'flex')

    _click(env.document.getElementById('location-fix-settings'))
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))

    assert.equal(openSettingsCalls, 1)
    assert.equal(state.location.preference, 'enabled')
    assert.equal(env.document.getElementById('location-fix-overlay').style.display, 'none')
  } finally {
    __setReviewTestHooks(null)
    _restoreReviewState(snapshot)
    env.restore()
  }
})
test('review pill shows one no-location state and a captured fix is never overwritten', () => {
  const snapshot = _snapshotReviewState()
  const env = _installReviewGlobals()

  try {
    _seedReviewState({
      liveFix: null,
      user: { id: 'user-1' },
      location: {
        preference: 'enabled',
        capability: 'supported',
        permission: 'granted',
        status: 'timeout',
        error: { kind: 'timeout', message: 'Location request timed out' },
      },
    })

    initReview()
    buildReviewGrid()
    assert.equal(env.document.getElementById('review-gps-display').textContent, 'No location · Tap to fix')
    assert.equal(env.document.getElementById('review-gps-pill').dataset.gpsState, 'none')
    assert.equal(env.document.getElementById('review-gps-pill').dataset.gpsAction, 'fix')

    // A captured session fix wins over a later denied/off state.
    state.captureSessionLocation.fix = { lat: 60.2, lon: 10.3, accuracy: 7, altitude: 90, timestamp: Date.now() }
    state.location.permission = 'denied'
    state.location.status = 'error'
    state.location.error = { kind: 'permission-denied', message: 'denied' }
    env.window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })

    assert.equal(env.document.getElementById('review-gps-display').textContent, 'Location captured · ±7 m')
    assert.equal(env.document.getElementById('review-gps-pill').dataset.gpsState, 'fix')
    assert.equal(env.document.getElementById('review-gps-pill').dataset.gpsAction, undefined)
  } finally {
    _restoreReviewState(snapshot)
    env.restore()
  }
})
