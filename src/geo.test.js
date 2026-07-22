import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { state } from './state.js'
import {
  LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS,
  LOCATION_CLOCK_SKEW_MS,
  LOCATION_FIX_MAX_AGE_MS,
  beginCaptureLocationSession,
  checkLocationCapabilityAndPermission,
  getCaptureSessionRequestToken,
  __getCaptureLocationSessionRequestTokenForTests,
  endCaptureLocationSession,
  requestFreshLocation,
  resumeCaptureLocationSession,
  suspendCaptureLocationSession,
  setLocationPreference,
  startLocationWatch,
  stopLocationWatch,
} from './geo.js'

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

let restoreStack = []
let emittedEvents = []
let documentListeners = new Map()

function _restoreGlobals() {
  while (restoreStack.length) {
    const restore = restoreStack.pop()
    try {
      restore()
    } catch {}
  }
}

function _setGlobalProperty(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  restoreStack.push(() => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
      return
    }
    Reflect.deleteProperty(globalThis, name)
  })
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

function _installEnvironment({
  geolocation = null,
  permissionState = 'granted',
} = {}) {
  emittedEvents = []
  documentListeners = new Map()
  const permissions = permissionState == null
    ? undefined
    : {
        query: async () => ({ state: permissionState }),
      }
  const document = {
    hidden: false,
    visibilityState: 'visible',
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
  _setGlobalProperty('window', {
    dispatchEvent(event) {
      emittedEvents.push(event)
      return true
    },
  })
  _setGlobalProperty('document', document)
  _setGlobalProperty('navigator', {
    geolocation,
    permissions,
  })
}

function _stateEvents() {
  return emittedEvents.filter(event => event?.type === 'sporely:location-state-changed')
}

function _resetState() {
  state.location = defaultLocationState()
  state.captureSessionLocation = defaultCaptureSessionLocationState()
}

function _setCurrentSessionFix({ timestamp = Date.now(), lat = 63, lon = 10 } = {}) {
  state.captureSessionLocation.sessionStartAt = new Date(timestamp - 1_000)
  state.captureSessionLocation.fix = {
    lat,
    lon,
    accuracy: 4,
    altitude: 12,
    timestamp,
  }
}

function _dispatchVisibilityChange(hidden) {
  globalThis.document.hidden = hidden
  globalThis.document.visibilityState = hidden ? 'hidden' : 'visible'
  globalThis.document.dispatchEvent({ type: 'visibilitychange' })
}

afterEach(() => {
  try {
    stopLocationWatch()
  } catch {}
  _resetState()
  _restoreGlobals()
})

test('disabled preference clears fixes and blocks acquisition', async () => {
  let watchCalls = 0
  let currentPositionCalls = 0
  const clearCalls = []

  _installEnvironment({
    geolocation: {
      watchPosition() {
        watchCalls += 1
        return 21
      },
      getCurrentPosition() {
        currentPositionCalls += 1
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  state.location.watchId = 9
  state.location.fix = {
    lat: 63.1,
    lon: 10.1,
    accuracy: 5,
    altitude: 0,
    timestamp: Date.now(),
  }
  _setCurrentSessionFix({ timestamp: Date.now() - 5_000 })

  setLocationPreference('disabled')

  assert.equal(state.location.preference, 'disabled')
  assert.equal(state.location.fix, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
  assert.deepEqual(clearCalls, [9])
  assert.equal(_stateEvents().length > 0, true)

  await startLocationWatch()
  await requestFreshLocation()
  assert.equal(watchCalls, 0)
  assert.equal(currentPositionCalls, 0)

  await startLocationWatch({ internalOverride: true, captureSessionRequestToken: __getCaptureLocationSessionRequestTokenForTests() })
  assert.equal(watchCalls, 0)
})

test('enabled preference allows acquisition only with the current session token', async () => {
  let currentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        currentPositionCalls += 1
        success({
          coords: {
            latitude: 63.6,
            longitude: 10.6,
            accuracy: 4,
            altitude: 5,
          },
          timestamp: Date.now(),
        })
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  setLocationPreference('enabled')
  const currentToken = __getCaptureLocationSessionRequestTokenForTests()
  const staleToken = currentToken
  beginCaptureLocationSession()
  const freshToken = __getCaptureLocationSessionRequestTokenForTests()

  const blocked = await requestFreshLocation({
    internalOverride: true,
    captureSessionRequestToken: staleToken,
    timeoutMs: 50,
  })
  const allowed = await requestFreshLocation({
    internalOverride: true,
    captureSessionRequestToken: freshToken,
    timeoutMs: 50,
  })

  assert.equal(currentPositionCalls, 1)
  assert.equal(blocked.status, 'idle')
  assert.equal(allowed.status, 'fix')
  assert.equal(state.location.fix.lat, 63.6)
})

test('new session clears previous-session fix', () => {
  _installEnvironment()

  state.captureSessionLocation.sessionStartAt = new Date(Date.now() - 10_000)
  state.captureSessionLocation.fix = {
    lat: 63.1,
    lon: 10.1,
    accuracy: 8,
    altitude: 4,
    timestamp: Date.now() - 9_000,
  }

  beginCaptureLocationSession()

  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.captureSessionLocation.sessionStartAt instanceof Date, true)
})

test('permission denied clears a previous global fix and stale session fix', async () => {
  const clearCalls = []
  _installEnvironment({
    geolocation: {
      watchPosition() {
        return 17
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
    permissionState: 'denied',
  })

  state.location.watchId = 17
  state.location.fix = {
    lat: 61,
    lon: 11,
    accuracy: 4,
    altitude: 8,
    timestamp: Date.now() - 60_000,
  }
  state.captureSessionLocation.sessionStartAt = new Date()
  state.captureSessionLocation.fix = {
    lat: 62,
    lon: 12,
    accuracy: 5,
    altitude: 9,
    timestamp: Date.now() - 120_000,
  }

  await checkLocationCapabilityAndPermission()

  assert.equal(state.location.fix, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.deepEqual(clearCalls, [17])
})

test('permission denied can preserve a fix captured during the current session', async () => {
  _installEnvironment({
    geolocation: {
      watchPosition() {
        return 41
      },
      clearWatch() {},
    },
    permissionState: 'denied',
  })

  const sessionStart = Date.now() - 2_000
  state.captureSessionLocation.sessionStartAt = new Date(sessionStart)
  state.captureSessionLocation.fix = {
    lat: 63.2,
    lon: 10.2,
    accuracy: 3,
    altitude: 7,
    timestamp: sessionStart + 500,
  }
  state.location.fix = {
    lat: 60,
    lon: 9,
    accuracy: 6,
    altitude: 4,
    timestamp: sessionStart - 20_000,
  }

  await checkLocationCapabilityAndPermission()

  assert.equal(state.location.fix, null)
  assert.deepEqual(state.captureSessionLocation.fix, {
    lat: 63.2,
    lon: 10.2,
    accuracy: 3,
    altitude: 7,
    timestamp: sessionStart + 500,
  })
})

test('stale fix before sessionStartAt is rejected for the session', async () => {
  _installEnvironment({
    geolocation: {
      watchPosition(success) {
        success({
          coords: {
            latitude: 63.7,
            longitude: 10.7,
            accuracy: 3,
            altitude: 11,
          },
          timestamp: Date.now() - 40_000,
        })
        return 83
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  state.captureSessionLocation.sessionStartAt = new Date(Date.now() - 1_000)

  await startLocationWatch()

  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.fix, null)
})

test('more accurate session fix replaces coarse fix and later coarse fixes do not', async () => {
  let successCallback = null
  _installEnvironment({
    geolocation: {
      watchPosition(success) {
        successCallback = success
        return 91
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  state.captureSessionLocation.sessionStartAt = new Date(Date.now() - 5_000)

  await startLocationWatch({ requestFreshFix: true })
  successCallback({
    coords: {
      latitude: 63.2,
      longitude: 10.2,
      accuracy: 40,
      altitude: 7,
    },
    timestamp: Date.now() - 1_000,
  })
  successCallback({
    coords: {
      latitude: 63.3,
      longitude: 10.3,
      accuracy: 9,
      altitude: 7,
    },
    timestamp: Date.now(),
  })
  successCallback({
    coords: {
      latitude: 63.4,
      longitude: 10.4,
      accuracy: 25,
      altitude: 7,
    },
    timestamp: Date.now() + 1,
  })

  assert.equal(state.captureSessionLocation.fix.accuracy, 9)
  assert.equal(state.location.fix.accuracy, 25)
})

test('session suspension and late resume results after end are ignored', async () => {
  let watchCalls = 0
  let getCurrentPositionSuccess
  const clearCalls = []
  _installEnvironment({
    geolocation: {
      watchPosition() {
        watchCalls += 1
        return 44
      },
      getCurrentPosition(success) {
        getCurrentPositionSuccess = success
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  state.location.preference = 'enabled'
  await startLocationWatch()
  suspendCaptureLocationSession()
  assert.equal(clearCalls.includes(44), true)

  const resumePromise = resumeCaptureLocationSession({ timeoutMs: 20 })
  endCaptureLocationSession()
  getCurrentPositionSuccess?.({
    coords: {
      latitude: 63.8,
      longitude: 10.8,
      accuracy: 5,
      altitude: 3,
    },
    timestamp: Date.now(),
  })
  await resumePromise

  assert.equal(watchCalls, 1)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.watchId, null)
})

test('visibility listener is installed once per document', async () => {
  _installEnvironment({
    geolocation: {
      watchPosition() {
        return 55
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  beginCaptureLocationSession()

  assert.equal(documentListeners.get('visibilitychange')?.length, 1)
})

test('maxAgeMs 0 never reuses the cached fix', async () => {
  let getCurrentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        getCurrentPositionCalls += 1
        success({
          coords: {
            latitude: 64.5,
            longitude: 11.5,
            accuracy: 2.5,
            altitude: 14,
          },
          timestamp: Date.now(),
        })
      },
    },
    permissionState: 'granted',
  })

  state.location.fix = {
    lat: 61,
    lon: 10,
    accuracy: 8,
    altitude: 3,
    timestamp: Date.now(),
  }

  const result = await requestFreshLocation({ maxAgeMs: 0, timeoutMs: 100, enableHighAccuracy: false })

  assert.equal(getCurrentPositionCalls, 1)
  assert.equal(result.status, 'fix')
  assert.equal(state.location.fix.lat, 64.5)
  assert.equal(state.location.fix.lon, 11.5)
})

test('fresh request accepts a realistic slightly old timestamp', async () => {
  let getCurrentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        getCurrentPositionCalls += 1
        success({
          coords: {
            latitude: 64.25,
            longitude: 11.25,
            accuracy: 4,
            altitude: 15,
          },
          timestamp: Date.now() - 1_000,
        })
      },
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  const result = await requestFreshLocation({
    maximumAgeMs: 0,
    acceptedFixMaxAgeMs: LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS,
    timeoutMs: 100,
  })

  assert.equal(getCurrentPositionCalls, 1)
  assert.equal(result.status, 'fix')
  assert.equal(state.location.fix.lat, 64.25)
  assert.equal(state.captureSessionLocation.fix.lat, 64.25)
})

test('maximumAgeMs 0 does not imply zero timestamp tolerance', async () => {
  let receivedOptions = null
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success, error, options) {
        void error
        receivedOptions = options
        success({
          coords: {
            latitude: 64.75,
            longitude: 11.75,
            accuracy: 3,
            altitude: 16,
          },
          timestamp: Date.now() - 1_000,
        })
      },
    },
    permissionState: 'granted',
  })

  const result = await requestFreshLocation({
    maximumAgeMs: 0,
    acceptedFixMaxAgeMs: 30_000,
    timeoutMs: 100,
  })

  assert.equal(receivedOptions.maximumAge, 0)
  assert.equal(result.status, 'fix')
  assert.equal(state.location.fix.lat, 64.75)
})

test('bounded one-shot success updates the location state', async () => {
  let getCurrentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        getCurrentPositionCalls += 1
        setTimeout(() => {
          success({
            coords: {
              latitude: 63.12345,
              longitude: 10.54321,
              accuracy: 7.5,
              altitude: 0,
            },
            timestamp: Date.now(),
          })
        }, 5)
      },
    },
    permissionState: 'granted',
  })

  state.captureSessionLocation.sessionStartAt = new Date(Date.now() - 5_000)
  const result = await requestFreshLocation({ timeoutMs: 100, maxAgeMs: 10_000 })

  assert.equal(getCurrentPositionCalls, 1)
  assert.equal(result.status, 'fix')
  assert.equal(state.location.status, 'fix')
  assert.deepEqual(state.location.fix, {
    lat: 63.12345,
    lon: 10.54321,
    accuracy: 7.5,
    altitude: 0,
    timestamp: state.location.fix.timestamp,
  })
  assert.equal(state.location.fix.altitude, 0)
  assert.equal(state.captureSessionLocation.fix.altitude, 0)
  assert.equal(_stateEvents().length > 0, true)
  assert.equal(state.location.watchId, null)
})

test('bounded one-shot timeout resolves on timeout', async () => {
  let getCurrentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition() {
        getCurrentPositionCalls += 1
      },
    },
    permissionState: 'granted',
  })

  const result = await requestFreshLocation({ timeoutMs: 10, maxAgeMs: 0 })

  assert.equal(getCurrentPositionCalls, 1)
  assert.equal(result.status, 'timeout')
  assert.equal(state.location.status, 'timeout')
  assert.equal(state.location.error?.kind, 'timeout')
  assert.equal(_stateEvents().length > 0, true)
  assert.equal(state.location.watchId, null)
})

test('late one-shot success callback after timeout is ignored', async () => {
  let getCurrentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        getCurrentPositionCalls += 1
        setTimeout(() => {
          success({
            coords: {
              latitude: 63.98765,
              longitude: 10.87654,
              accuracy: 1.5,
              altitude: 19,
            },
            timestamp: Date.now(),
          })
        }, 25)
      },
    },
    permissionState: 'granted',
  })

  const result = await requestFreshLocation({ timeoutMs: 5, maxAgeMs: 0 })
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(getCurrentPositionCalls, 1)
  assert.equal(result.status, 'timeout')
  assert.equal(state.location.status, 'timeout')
  assert.equal(state.location.fix, null)
  assert.equal(_stateEvents().length > 0, true)
})

test('one-shot permission denial clears a previous global fix', async () => {
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success, error) {
        error({ code: 1, message: 'denied' })
      },
    },
    permissionState: 'granted',
  })

  state.location.fix = {
    lat: 61.5,
    lon: 10.5,
    accuracy: 3,
    altitude: 11,
    timestamp: Date.now() - 1_000,
  }

  const result = await requestFreshLocation({ timeoutMs: 100, maxAgeMs: 0 })

  assert.equal(result.permission, 'denied')
  assert.equal(state.location.fix, null)
  assert.equal(state.location.status, 'error')
  assert.equal(state.location.error?.kind, 'permission-denied')
  assert.equal(_stateEvents().length > 0, true)
})

test('location-state-changed only reflects accepted fixes', async () => {
  let getCurrentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success, error) {
        getCurrentPositionCalls += 1
        if (getCurrentPositionCalls === 1) {
          success({
            coords: {
              latitude: 63.8,
              longitude: 10.8,
              accuracy: 4,
              altitude: 6,
            },
            timestamp: Date.now(),
          })
          return
        }
        error({ code: 3, message: 'timeout' })
      },
    },
    permissionState: 'granted',
  })

  await setLocationPreference('enabled')
  await requestFreshLocation({ timeoutMs: 100, maxAgeMs: 0 })
  const afterSuccess = _stateEvents().length

  await requestFreshLocation({ timeoutMs: 10, maxAgeMs: 0 })

  assert.ok(_stateEvents().length > afterSuccess)
})

test('synchronous watch error does not leave a watchId stored', async () => {
  const clearCalls = []
  _installEnvironment({
    geolocation: {
      watchPosition(success, error) {
        void success
        error({ code: 2, message: 'unavailable' })
        return 42
      },
      clearWatch(id) {
        clearCalls.push(id)
      },
    },
    permissionState: 'granted',
  })

  const result = await startLocationWatch()

  assert.equal(result.status, 'unavailable')
  assert.equal(state.location.watchId, null)
  assert.deepEqual(clearCalls, [42])
  assert.equal(_stateEvents().length > 0, true)
})

test('fresh watch accepts a realistic slightly old timestamp', async () => {
  _installEnvironment({
    geolocation: {
      watchPosition(success) {
        success({
          coords: {
            latitude: 63.55,
            longitude: 10.55,
            accuracy: 6,
            altitude: 21,
          },
          timestamp: Date.now() - 1_000,
        })
        return 51
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  setLocationPreference('enabled')
  const result = await startLocationWatch({
    maximumAgeMs: 0,
    acceptedFixMaxAgeMs: 30_000,
    requestFreshFix: true,
  })

  assert.equal(result.status, 'fix')
  assert.equal(state.location.fix.lat, 63.55)
  assert.equal(state.captureSessionLocation.fix.lat, 63.55)
})

test('watch timeout after a valid current-session fix is nonfatal', async () => {
  let watchError = null
  _installEnvironment({
    geolocation: {
      watchPosition(success, error) {
        success({
          coords: {
            latitude: 63.25,
            longitude: 10.25,
            accuracy: 7,
            altitude: 30,
          },
          timestamp: Date.now(),
        })
        watchError = error
        return 52
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  setLocationPreference('enabled')
  await startLocationWatch({ captureSessionRequestToken: __getCaptureLocationSessionRequestTokenForTests() })

  assert.equal(state.captureSessionLocation.fix?.lat, 63.25)

  watchError?.({ code: 3, message: 'timeout' })

  assert.equal(state.captureSessionLocation.fix?.lat, 63.25)
  assert.equal(state.location.status, 'fix')
  assert.equal(state.location.error, null)
})

test('future timestamps beyond the tolerated skew are rejected', async () => {
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        success({
          coords: {
            latitude: 64.4,
            longitude: 11.4,
            accuracy: 3.1,
            altitude: 13,
          },
          timestamp: Date.now() + LOCATION_CLOCK_SKEW_MS + 60_000,
        })
      },
    },
    permissionState: 'granted',
  })

  const result = await requestFreshLocation({ timeoutMs: 100, maxAgeMs: LOCATION_FIX_MAX_AGE_MS })

  assert.equal(result.status, 'error')
  assert.equal(state.location.fix, null)
  assert.equal(state.location.error?.kind, 'invalid-fix')
  assert.equal(_stateEvents().length > 0, true)
})

test('disabled preference cannot be bypassed with internalOverride', async () => {
  let getCurrentPositionCalls = 0
  let watchCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition() {
        getCurrentPositionCalls += 1
      },
      watchPosition() {
        watchCalls += 1
        return 77
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  const sessionToken = __getCaptureLocationSessionRequestTokenForTests()
  setLocationPreference('disabled')

  const oneShot = await requestFreshLocation({
    internalOverride: true,
    captureSessionRequestToken: sessionToken,
    timeoutMs: 50,
  })
  const watchState = await startLocationWatch({
    internalOverride: true,
    captureSessionRequestToken: sessionToken,
  })

  assert.equal(getCurrentPositionCalls, 0)
  assert.equal(watchCalls, 0)
  assert.equal(oneShot.status, 'idle')
  assert.equal(watchState.status, 'idle')
  assert.equal(state.location.fix, null)
})

test('old-session one-shot result is ignored after the session ends', async () => {
  let successCallback = null
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        successCallback = success
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  setLocationPreference('enabled')
  const sessionToken = __getCaptureLocationSessionRequestTokenForTests()

  const request = requestFreshLocation({
    timeoutMs: 100,
    maxAgeMs: 0,
    captureSessionRequestToken: sessionToken,
  })
  for (let i = 0; i < 10 && state.location.status !== 'locating'; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(state.location.status, 'locating')
  endCaptureLocationSession()
  successCallback?.({
    coords: {
      latitude: 63.75,
      longitude: 10.75,
      accuracy: 6,
      altitude: 4,
    },
    timestamp: Date.now(),
  })

  const result = await request

  assert.equal(result.status, 'idle')
  assert.equal(state.location.fix, null)
  assert.equal(state.captureSessionLocation.fix, null)
})

test('old-session watch result is ignored after the session ends', async () => {
  let watchSuccess = null
  _installEnvironment({
    geolocation: {
      watchPosition(success) {
        watchSuccess = success
        return 88
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  setLocationPreference('enabled')
  await startLocationWatch({ captureSessionRequestToken: __getCaptureLocationSessionRequestTokenForTests() })
  endCaptureLocationSession()
  watchSuccess?.({
    coords: {
      latitude: 63.85,
      longitude: 10.85,
      accuracy: 5,
      altitude: 9,
    },
    timestamp: Date.now(),
  })

  assert.equal(state.location.fix, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.location.watchId, null)
})

test('runtime location consumers no longer reference the legacy gps alias or event', () => {
  const runtimeFiles = [
    new URL('./screens/capture.js', import.meta.url),
    new URL('./screens/review.js', import.meta.url),
    new URL('./screens/import_review.js', import.meta.url),
    new URL('./screens/find_detail.js', import.meta.url),
    new URL('./screens/map.js', import.meta.url),
    new URL('./geo.js', import.meta.url),
    new URL('./state.js', import.meta.url),
  ]

  for (const file of runtimeFiles) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /\bstate\.gps\b/)
    assert.doesNotMatch(source, /\bstartGeo\b/)
    assert.doesNotMatch(source, /sporely:gps-updated/)
  }
})

test('getCaptureSessionRequestToken returns the live token and is the only accepted override token', async () => {
  let currentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        currentPositionCalls += 1
        success({
          coords: { latitude: 63.6, longitude: 10.6, accuracy: 4, altitude: 5 },
          timestamp: Date.now(),
        })
      },
      watchPosition() { return 31 },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  endCaptureLocationSession()
  assert.equal(getCaptureSessionRequestToken(), null)

  beginCaptureLocationSession()
  setLocationPreference('enabled')
  const token = getCaptureSessionRequestToken()
  assert.notEqual(token, null)
  assert.equal(token, __getCaptureLocationSessionRequestTokenForTests())

  await requestFreshLocation({ internalOverride: true, captureSessionRequestToken: token })
  assert.equal(currentPositionCalls, 1)

  // A review-layer session key must be rejected — this exact string shape
  // silently disabled all save-time GPS requests before the Stage 1 fix.
  await requestFreshLocation({ internalOverride: true, captureSessionRequestToken: `live:${Date.now()}` })
  assert.equal(currentPositionCalls, 1)

  endCaptureLocationSession()
  assert.equal(getCaptureSessionRequestToken(), null)
})

test('session fix ignores fixes taken after the capture window closes', async () => {
  let currentPositionCalls = 0
  _installEnvironment({
    geolocation: {
      getCurrentPosition(success) {
        currentPositionCalls += 1
        success({
          coords: { latitude: 63.9, longitude: 10.9, accuracy: 5, altitude: 1 },
          timestamp: Date.now(),
        })
      },
      clearWatch() {},
    },
    permissionState: 'granted',
  })

  beginCaptureLocationSession()
  state.captureSessionLocation.captureWindowEndAt = Date.now() - 1_000

  const result = await requestFreshLocation({ maximumAgeMs: 0, timeoutMs: 100 })

  // The global fix still updates (maps etc.), but the session fix — the
  // observation's location source — stays pinned to the capture window.
  assert.equal(currentPositionCalls, 1)
  assert.equal(result.status, 'fix')
  assert.equal(state.location.fix.lat, 63.9)
  assert.equal(state.captureSessionLocation.fix, null)

  state.captureSessionLocation.captureWindowEndAt = Date.now() + 60_000
  await requestFreshLocation({ maximumAgeMs: 0, timeoutMs: 100 })
  assert.equal(state.captureSessionLocation.fix.lat, 63.9)

  endCaptureLocationSession()
  assert.equal(state.captureSessionLocation.captureWindowEndAt, null)
})
