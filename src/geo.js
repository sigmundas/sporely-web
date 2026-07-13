import { state } from './state.js'
import { setLocationPreference as persistLocationPreference } from './settings.js'

export const LOCATION_FIX_MAX_AGE_MS = 5 * 60 * 1000
export const LOCATION_CLOCK_SKEW_MS = 10 * 1000
export const LOCATION_STATE_CHANGED_EVENT = 'sporely:location-state-changed'
export const LEGACY_GPS_UPDATED_EVENT = 'sporely:gps-updated'

const LOCATION_PREFERENCES = new Set(['ask', 'enabled', 'disabled'])
const GEOLOCATION_ERROR_CODES = {
  permissionDenied: 1,
  positionUnavailable: 2,
  timeout: 3,
}

function _normalizePreference(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return LOCATION_PREFERENCES.has(normalized) ? normalized : 'ask'
}

function _finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function _normalizeMaxAgeMs(value) {
  const maxAge = Number(value)
  return Number.isFinite(maxAge) ? Math.max(0, maxAge) : LOCATION_FIX_MAX_AGE_MS
}

function _normalizeTimeoutMs(value) {
  const timeout = Number(value)
  return Number.isFinite(timeout) ? Math.max(0, timeout) : 10_000
}

function _createCustomEvent(name, detail) {
  if (typeof globalThis.CustomEvent === 'function') {
    return new globalThis.CustomEvent(name, { detail })
  }
  return { type: name, detail }
}

function _dispatchEvent(name, detail) {
  globalThis.window?.dispatchEvent?.(_createCustomEvent(name, detail))
}

function _cloneFix(fix) {
  if (!fix) return null
  return {
    lat: fix.lat,
    lon: fix.lon,
    accuracy: fix.accuracy ?? null,
    altitude: fix.altitude ?? null,
    timestamp: fix.timestamp,
  }
}

function _cloneLocationState() {
  return {
    ...state.location,
    fix: _cloneFix(state.location.fix),
    error: state.location.error ? { ...state.location.error } : null,
  }
}

function _cloneCaptureSessionLocation() {
  return {
    ...state.captureSessionLocation,
    fix: _cloneFix(state.captureSessionLocation.fix),
  }
}

function _emitLocationStateChanged() {
  _dispatchEvent(LOCATION_STATE_CHANGED_EVENT, {
    location: _cloneLocationState(),
    captureSessionLocation: _cloneCaptureSessionLocation(),
  })
}

function _emitAcceptedFix(fix) {
  _emitLocationStateChanged()
  _dispatchEvent(LEGACY_GPS_UPDATED_EVENT, _cloneFix(fix))
}

function _supportsGeolocation() {
  return !!globalThis.navigator?.geolocation
}

function _isValidCoordinate(lat, lon) {
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && lat >= -90
    && lat <= 90
    && lon >= -180
    && lon <= 180
    && !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
}

function _isFreshFix(fix, maxAgeMs = LOCATION_FIX_MAX_AGE_MS) {
  if (!fix) return false
  const timestamp = Number(fix.timestamp)
  if (!Number.isFinite(timestamp)) return false
  const normalizedMaxAge = _normalizeMaxAgeMs(maxAgeMs)
  const ageMs = Date.now() - timestamp
  if (!Number.isFinite(ageMs)) return false
  if (ageMs < -LOCATION_CLOCK_SKEW_MS) return false
  return ageMs <= normalizedMaxAge
}

function _isAcceptableFixTimestamp(timestamp, maxAgeMs = LOCATION_FIX_MAX_AGE_MS) {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const normalizedMaxAge = _normalizeMaxAgeMs(maxAgeMs)
  const ageMs = Date.now() - ts
  if (!Number.isFinite(ageMs)) return false
  if (ageMs < -LOCATION_CLOCK_SKEW_MS) return false
  return ageMs <= normalizedMaxAge
}

function _pruneStaleGlobalFix(maxAgeMs = LOCATION_FIX_MAX_AGE_MS) {
  if (!state.location.fix) return false
  if (_isFreshFix(state.location.fix, maxAgeMs)) return false
  state.location.fix = null
  return true
}

function _currentSessionStartMs() {
  const sessionStart = state.captureSessionLocation.sessionStartAt
  if (sessionStart instanceof Date) return Number(sessionStart.getTime())
  return _finiteNumber(sessionStart)
}

function _sessionFixIsCurrent(fix) {
  if (!fix) return false
  const sessionStartMs = _currentSessionStartMs()
  const fixTimestamp = Number(fix.timestamp)
  return Number.isFinite(sessionStartMs) && Number.isFinite(fixTimestamp) && fixTimestamp >= sessionStartMs
}

function _updateCaptureSessionFixFromAcceptedFix(fix) {
  if (!(state.captureSessionLocation.requestingFreshFix || state.captureSessionLocation.sessionStartAt)) return
  state.captureSessionLocation.fix = _cloneFix(fix)
  state.captureSessionLocation.requestingFreshFix = false
}

function _acceptFix(position, options = {}) {
  const coords = position?.coords || {}
  const lat = Number(coords.latitude)
  const lon = Number(coords.longitude)
  if (!_isValidCoordinate(lat, lon)) return null

  const timestamp = _finiteNumber(position?.timestamp)
  if (!_isAcceptableFixTimestamp(timestamp, options.maxAgeMs)) return null

  const fix = {
    lat,
    lon,
    accuracy: _finiteNumber(coords.accuracy),
    altitude: _finiteNumber(coords.altitude),
    timestamp,
  }

  state.location.fix = fix
  state.location.status = 'fix'
  state.location.error = null
  state.location.permission = 'granted'

  _updateCaptureSessionFixFromAcceptedFix(fix)
  _emitAcceptedFix(fix)
  return fix
}

function _createDeniedError(message = 'Permission denied') {
  return {
    code: GEOLOCATION_ERROR_CODES.permissionDenied,
    kind: 'permission-denied',
    message,
    name: 'PermissionDeniedError',
    status: 'error',
  }
}

function _createDisabledError() {
  return {
    code: null,
    kind: 'disabled',
    message: 'Location preference disabled',
    name: 'LocationDisabledError',
    status: 'idle',
  }
}

function _createUnsupportedError() {
  return {
    code: null,
    kind: 'unsupported',
    message: 'Geolocation is not supported',
    name: 'UnsupportedError',
    status: 'unavailable',
  }
}

function _createInvalidFixError() {
  return {
    code: null,
    kind: 'invalid-fix',
    message: 'Invalid location fix',
    name: 'InvalidPositionError',
    status: 'error',
  }
}

function _createTimeoutError(message = 'Location request timed out') {
  return {
    code: GEOLOCATION_ERROR_CODES.timeout,
    kind: 'timeout',
    message,
    name: 'TimeoutError',
    status: 'timeout',
  }
}

function _classifyGeolocationError(error) {
  if (String(error?.kind || '').trim().toLowerCase() === 'invalid-fix') {
    return {
      code: Number.isFinite(Number(error?.code)) ? Number(error.code) : null,
      kind: 'invalid-fix',
      message: error?.message || 'Invalid location fix',
      name: error?.name || 'InvalidPositionError',
      status: 'error',
    }
  }

  const code = Number(error?.code)
  if (code === GEOLOCATION_ERROR_CODES.permissionDenied) {
    return _createDeniedError(error?.message)
  }
  if (code === GEOLOCATION_ERROR_CODES.timeout) {
    return _createTimeoutError(error?.message)
  }
  if (code === GEOLOCATION_ERROR_CODES.positionUnavailable) {
    return {
      code,
      kind: 'position-unavailable',
      message: error?.message || 'Position unavailable',
      name: error?.name || 'PositionUnavailableError',
      status: 'unavailable',
    }
  }

  const name = String(error?.name || '').trim() || 'GeolocationError'
  const lowerName = name.toLowerCase()
  if (lowerName.includes('timeout')) return _createTimeoutError(error?.message)
  if (lowerName.includes('permission') || lowerName.includes('denied')) return _createDeniedError(error?.message)
  if (lowerName.includes('unavailable')) {
    return {
      code: Number.isFinite(code) ? code : null,
      kind: 'position-unavailable',
      message: error?.message || 'Position unavailable',
      name,
      status: 'unavailable',
    }
  }

  return {
    code: Number.isFinite(code) ? code : null,
    kind: 'error',
    message: error?.message || 'Geolocation error',
    name,
    status: 'error',
  }
}

function _clearWatchId(watchId = state.location.watchId) {
  if (watchId == null) return false
  const clearWatch = globalThis.navigator?.geolocation?.clearWatch
  if (typeof clearWatch === 'function') {
    try {
      clearWatch.call(globalThis.navigator.geolocation, watchId)
    } catch {}
  }
  if (state.location.watchId === watchId) {
    state.location.watchId = null
  }
  return true
}

function _markWatchState(status, error = null) {
  state.location.status = status
  state.location.error = error
  _emitLocationStateChanged()
}

function _clearGlobalFixAndSessionFix({
  clearSessionFix = false,
  preserveCurrentSessionFix = false,
} = {}) {
  state.location.fix = null
  if (clearSessionFix) {
    state.captureSessionLocation.fix = null
  } else if (!preserveCurrentSessionFix && state.captureSessionLocation.fix && !_sessionFixIsCurrent(state.captureSessionLocation.fix)) {
    state.captureSessionLocation.fix = null
  }
}

function _applyPermissionDeniedPolicy() {
  _clearGlobalFixAndSessionFix({
    clearSessionFix: !_sessionFixIsCurrent(state.captureSessionLocation.fix),
    preserveCurrentSessionFix: true,
  })
}

function _applyUnsupportedPolicy() {
  _clearGlobalFixAndSessionFix({
    clearSessionFix: false,
    preserveCurrentSessionFix: true,
  })
}

function _canAcquireLocation(options = {}) {
  const internalOverride = options.internalOverride === true
  if (state.location.preference === 'disabled' && !internalOverride) {
    return false
  }
  return true
}

function _stateAfterAcquireBlocked() {
  return _cloneLocationState()
}

async function _queryPermissionState() {
  const query = globalThis.navigator?.permissions?.query
  if (typeof query !== 'function') return state.location.permission

  try {
    const status = await query.call(globalThis.navigator.permissions, { name: 'geolocation' })
    const permissionState = String(status?.state || '').trim().toLowerCase()
    return permissionState || state.location.permission
  } catch {
    return state.location.permission
  }
}

function _updatePermissionSnapshot(permission) {
  state.location.permission = permission
  return permission
}

function _setUnsupportedState() {
  state.location.capability = 'unsupported'
  state.location.permission = 'unknown'
  state.location.status = 'unavailable'
  state.location.error = _createUnsupportedError()
  state.captureSessionLocation.requestingFreshFix = false
  _applyUnsupportedPolicy()
  _clearWatchId()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setDeniedState(error = _createDeniedError()) {
  state.location.permission = 'denied'
  state.location.status = 'error'
  state.location.error = error
  state.captureSessionLocation.requestingFreshFix = false
  _applyPermissionDeniedPolicy()
  _clearWatchId()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setDisabledState() {
  state.location.status = 'idle'
  state.location.error = _createDisabledError()
  state.location.fix = null
  state.captureSessionLocation.requestingFreshFix = false
  state.captureSessionLocation.fix = null
  _clearWatchId()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setWatchErrorState(error) {
  const classified = _classifyGeolocationError(error)
  if (classified.kind === 'permission-denied') return _setDeniedState(classified)

  state.location.status = classified.status
  state.location.error = classified
  state.captureSessionLocation.requestingFreshFix = false
  _pruneStaleGlobalFix()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setTerminalWatchError(error) {
  _clearWatchId()
  return _setWatchErrorState(error)
}

function _callWatchPosition(onSuccess, onError, options = {}) {
  const watchPosition = globalThis.navigator?.geolocation?.watchPosition
  if (typeof watchPosition !== 'function') {
    return { supported: false, watchId: null, terminalError: _createUnsupportedError() }
  }

  let watchId = null
  let settled = false
  let terminalError = null
  let clearWhenReady = false

  const safeClear = () => {
    if (watchId == null) {
      clearWhenReady = true
      return
    }
    _clearWatchId(watchId)
  }

  const success = position => {
    if (settled) return
    const fix = _acceptFix(position, options)
    if (!fix) {
      settled = true
      terminalError = _createInvalidFixError()
      safeClear()
      _setWatchErrorState(terminalError)
    }
  }

  const error = geolocationError => {
    if (settled) return
    settled = true
    terminalError = geolocationError
    safeClear()
    _setTerminalWatchError(geolocationError)
  }

  try {
    const returnedWatchId = watchPosition.call(
      globalThis.navigator.geolocation,
      success,
      error,
      options.positionOptions || {},
    )
    watchId = returnedWatchId
    if (clearWhenReady && watchId != null) {
      _clearWatchId(watchId)
      watchId = null
    }
  } catch (err) {
    settled = true
    terminalError = err
    safeClear()
    _setTerminalWatchError(err)
  }

  return {
    supported: true,
    watchId,
    terminalError,
  }
}

function _requestCurrentPositionOnce(options = {}) {
  const getCurrentPosition = globalThis.navigator?.geolocation?.getCurrentPosition
  if (typeof getCurrentPosition !== 'function') return null

  let settled = false
  let resolvePromise = null
  let timeoutHandle = null

  const promise = new Promise(resolve => {
    resolvePromise = resolve
  })

  const finish = result => {
    if (settled) return
    settled = true
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
    resolvePromise?.(result)
  }

  const success = position => {
    if (settled) return
    const fix = _acceptFix(position, options)
    if (!fix) {
      finish(_setWatchErrorState(_createInvalidFixError()))
      return
    }
    finish(_cloneLocationState())
  }

  const error = geolocationError => {
    if (settled) return
    finish(_setWatchErrorState(geolocationError))
  }

  const timeoutMs = _normalizeTimeoutMs(options.timeoutMs)
  timeoutHandle = timeoutMs >= 0
    ? setTimeout(() => {
        finish(_setWatchErrorState(_createTimeoutError()))
      }, timeoutMs)
    : null

  try {
    getCurrentPosition.call(
      globalThis.navigator.geolocation,
      success,
      error,
      {
        enableHighAccuracy: options.enableHighAccuracy !== false,
        maximumAge: _normalizeMaxAgeMs(options.maxAgeMs),
        timeout: timeoutMs,
      },
    )
  } catch (err) {
    finish(_setWatchErrorState(err))
  }

  return promise
}

function _requestCurrentPositionWithWatchFallback(options = {}) {
  const watchPosition = globalThis.navigator?.geolocation?.watchPosition
  if (typeof watchPosition !== 'function') {
    return Promise.resolve(_setUnsupportedState())
  }

  let settled = false
  let resolvePromise = null
  let timeoutHandle = null
  let watchId = null
  let clearWhenReady = false

  const promise = new Promise(resolve => {
    resolvePromise = resolve
  })

  const finish = result => {
    if (settled) return
    settled = true
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
    resolvePromise?.(result)
  }

  const clearWatchSafely = () => {
    if (watchId == null) {
      clearWhenReady = true
      return
    }
    _clearWatchId(watchId)
  }

  const success = position => {
    if (settled) return
    const fix = _acceptFix(position, options)
    if (!fix) {
      clearWatchSafely()
      finish(_setWatchErrorState(_createInvalidFixError()))
      return
    }
    clearWatchSafely()
    finish(_cloneLocationState())
  }

  const error = geolocationError => {
    if (settled) return
    clearWatchSafely()
    finish(_setWatchErrorState(geolocationError))
  }

  try {
    const returnedWatchId = watchPosition.call(
      globalThis.navigator.geolocation,
      success,
      error,
      {
        enableHighAccuracy: options.enableHighAccuracy !== false,
        maximumAge: _normalizeMaxAgeMs(options.maxAgeMs),
        timeout: _normalizeTimeoutMs(options.timeoutMs),
      },
    )
    watchId = returnedWatchId
    if (clearWhenReady && watchId != null) {
      _clearWatchId(watchId)
      watchId = null
    }
    if (settled) return promise
  } catch (err) {
    finish(_setWatchErrorState(err))
    return promise
  }

  const timeoutMs = _normalizeTimeoutMs(options.timeoutMs)
  timeoutHandle = timeoutMs >= 0
    ? setTimeout(() => {
        clearWatchSafely()
        finish(_setWatchErrorState(_createTimeoutError()))
      }, timeoutMs)
    : null

  return promise
}

export function getLocationFix({ allowStale = false, maxAgeMs = LOCATION_FIX_MAX_AGE_MS } = {}) {
  if (!allowStale) _pruneStaleGlobalFix(maxAgeMs)
  return _cloneFix(state.location.fix)
}

export async function checkLocationCapabilityAndPermission() {
  if (!_supportsGeolocation()) {
    return _setUnsupportedState()
  }

  state.location.capability = 'supported'
  const permission = _updatePermissionSnapshot(await _queryPermissionState())

  if (permission === 'denied') {
    return _setDeniedState()
  }

  _pruneStaleGlobalFix()
  if (state.location.watchId == null) {
    state.location.status = state.location.fix ? 'fix' : 'idle'
    state.location.error = null
  }
  _emitLocationStateChanged()
  return _cloneLocationState()
}

export async function startLocationWatch(options = {}) {
  if (!_canAcquireLocation(options)) {
    return _stateAfterAcquireBlocked()
  }

  const snapshot = await checkLocationCapabilityAndPermission()
  if (snapshot.capability === 'unsupported' || snapshot.permission === 'denied') {
    return snapshot
  }

  if (state.location.watchId != null && options.force !== true) {
    return _cloneLocationState()
  }

  if (state.location.watchId != null) {
    _clearWatchId()
  }

  state.location.status = 'locating'
  state.location.error = null
  state.captureSessionLocation.requestingFreshFix = !!options.requestFreshFix
  _emitLocationStateChanged()

  const watchStart = _callWatchPosition(
    position => {
      const fix = _acceptFix(position, {
        maxAgeMs: options.maxAgeMs,
      })
      if (!fix) {
        _setTerminalWatchError(_createInvalidFixError())
      }
    },
    error => {
      _setTerminalWatchError(error)
    },
    {
      maxAgeMs: options.maxAgeMs,
      positionOptions: {
        enableHighAccuracy: options.enableHighAccuracy !== false,
        maximumAge: options.maximumAgeMs !== undefined ? _normalizeMaxAgeMs(options.maximumAgeMs) : 0,
      },
    },
  )

  if (watchStart.terminalError && state.location.watchId == null) {
    return _cloneLocationState()
  }

  if (watchStart.watchId != null) {
    state.location.watchId = watchStart.watchId
  }

  if (watchStart.terminalError) {
    return _cloneLocationState()
  }

  return _cloneLocationState()
}

export async function requestFreshLocation(options = {}) {
  if (!_canAcquireLocation(options)) {
    return _stateAfterAcquireBlocked()
  }

  const snapshot = await checkLocationCapabilityAndPermission()
  if (snapshot.capability === 'unsupported' || snapshot.permission === 'denied') {
    return snapshot
  }

  state.captureSessionLocation.requestingFreshFix = true
  state.location.status = 'locating'
  state.location.error = null
  _emitLocationStateChanged()

  const currentPositionRequest = _requestCurrentPositionOnce({
    maxAgeMs: options.maxAgeMs,
    timeoutMs: options.timeoutMs,
    enableHighAccuracy: options.enableHighAccuracy,
  })

  if (currentPositionRequest) return currentPositionRequest

  return _requestCurrentPositionWithWatchFallback({
    maxAgeMs: options.maxAgeMs,
    timeoutMs: options.timeoutMs,
    enableHighAccuracy: options.enableHighAccuracy,
  })
}

export function stopLocationWatch() {
  _clearWatchId()
  state.captureSessionLocation.requestingFreshFix = false
  state.location.status = state.location.fix ? 'fix' : 'idle'
  state.location.error = null
  _emitLocationStateChanged()
  return _cloneLocationState()
}

export function setLocationPreference(preference) {
  const normalized = _normalizePreference(preference)
  state.location.preference = normalized
  persistLocationPreference(normalized)

  if (normalized === 'disabled') {
    return _setDisabledState()
  }

  state.location.error = null
  _emitLocationStateChanged()
  return _cloneLocationState()
}

export function startGeo(options = {}) {
  return startLocationWatch(options)
}
