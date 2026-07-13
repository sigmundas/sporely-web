import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { state } from './state.js'
import {
  LOCATION_CLOCK_SKEW_MS,
  LOCATION_FIX_MAX_AGE_MS,
  checkLocationCapabilityAndPermission,
  requestFreshLocation,
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
  const permissions = permissionState == null
    ? undefined
    : {
        query: async () => ({ state: permissionState }),
      }
  _setGlobalProperty('window', {
    dispatchEvent(event) {
      emittedEvents.push(event)
      return true
    },
  })
  _setGlobalProperty('navigator', {
    geolocation,
    permissions,
  })
}

function _legacyEvents() {
  return emittedEvents.filter(event => event?.type === 'sporely:gps-updated')
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

afterEach(() => {
  try {
    stopLocationWatch()
  } catch {}
  _resetState()
  _restoreGlobals()
})

test('disabled preference clears fixes and blocks acquisition unless overridden', async () => {
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
  assert.equal(state.gps, null)
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
  assert.deepEqual(clearCalls, [9])
  assert.equal(_legacyEvents().length, 0)

  await startLocationWatch()
  await requestFreshLocation()
  assert.equal(watchCalls, 0)
  assert.equal(currentPositionCalls, 0)

  await startLocationWatch({ internalOverride: true })
  assert.equal(watchCalls, 1)
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
  assert.equal(state.gps, null)
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
  assert.equal(state.gps, null)
  assert.deepEqual(state.captureSessionLocation.fix, {
    lat: 63.2,
    lon: 10.2,
    accuracy: 3,
    altitude: 7,
    timestamp: sessionStart + 500,
  })
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
  assert.equal(_legacyEvents().length, 1)
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
  assert.equal(_legacyEvents().length, 0)
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
  assert.equal(_legacyEvents().length, 0)
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
  assert.equal(state.gps, null)
  assert.equal(state.location.status, 'error')
  assert.equal(state.location.error?.kind, 'permission-denied')
  assert.equal(_legacyEvents().length, 0)
})

test('legacy gps-updated only fires for accepted fixes', async () => {
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
  const afterSuccess = _legacyEvents().length
  assert.equal(afterSuccess, 1)

  await requestFreshLocation({ timeoutMs: 10, maxAgeMs: 0 })

  assert.equal(_legacyEvents().length, 1)
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
  assert.equal(_legacyEvents().length, 0)
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
  assert.equal(_legacyEvents().length, 0)
})
