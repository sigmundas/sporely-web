import { state } from './state.js'
import { setLocationPreference as persistLocationPreference } from './settings.js'
import { LOCATION_SOURCE, locationOutcomeFromGeoError, normalizeSessionLocationOutcome } from './location-provenance.js'

export const LOCATION_FIX_MAX_AGE_MS = 5 * 60 * 1000
export const LOCATION_CLOCK_SKEW_MS = 10 * 1000
export const LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS = 30_000
const LOCATION_RESUME_TIMEOUT_MS = 10_000
export const LOCATION_STATE_CHANGED_EVENT = 'sporely:location-state-changed'

const LOCATION_PREFERENCES = new Set(['ask', 'enabled', 'disabled'])
const GEOLOCATION_ERROR_CODES = {
  permissionDenied: 1,
  positionUnavailable: 2,
  timeout: 3,
}

const liveCaptureSession = {
  active: false,
  suspendedByVisibility: false,
  resumeInFlight: false,
  requestToken: 0,
  visibilityHandler: null,
  visibilityListenerDocument: null,
}

function _normalizePreference(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return LOCATION_PREFERENCES.has(normalized) ? normalized : 'ask'
}

function _finiteNumber(value) {
  // Absent is unknown, not 0 (Number(null) === 0 would make an unmeasured
  // accuracy look perfect).
  if (value === null || value === undefined || value === '') return null
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

function _normalizeAcceptedFixMaxAgeMs(value) {
  const maxAge = Number(value)
  return Number.isFinite(maxAge) ? Math.max(0, maxAge) : LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS
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
    // Location provenance travels with the fix it describes.
    ...(fix.source !== undefined ? { source: fix.source } : {}),
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

function _captureSessionRequestIsCurrent(token) {
  return token == null || (liveCaptureSession.active && token === liveCaptureSession.requestToken)
}

// Location provenance: the latest meaningful acquisition outcome of the
// CURRENT capture session (state.captureSessionLocation.outcome). The
// generation changes only when a session starts or ends, so an asynchronous
// failure from an earlier session (including untokened requests) can never
// be attributed to a later one. Global state.location.error is not used.
let locationOutcomeGeneration = 0

// Within one session several acquisition attempts can overlap (a background
// request still pending while the user taps "Try again"). Each attempt —
// request, watch, standalone permission check, preference/unsupported
// observation — takes a monotonically increasing id when it starts; only the
// newest attempt may record a failure outcome or reset acquisition state, so a
// superseded attempt completing late cannot replace the accepted retry's
// outcome. A superseded attempt's SUCCESS is still a real device fix and stays
// eligible for the session fix (better-fix and capture-window rules apply).
let latestLocationAttempt = 0

function _beginLocationAttempt() {
  latestLocationAttempt += 1
  return latestLocationAttempt
}

function _attemptIsCurrent(attemptId) {
  return attemptId === undefined || attemptId === latestLocationAttempt
}

function _recordSessionLocationOutcome(error, generation = locationOutcomeGeneration, attemptId = undefined) {
  if (generation !== locationOutcomeGeneration) return
  if (!_attemptIsCurrent(attemptId)) return
  if (!state.captureSessionLocation.sessionStartAt) return
  const outcome = locationOutcomeFromGeoError(error)
  if (outcome) state.captureSessionLocation.outcome = outcome
}

// A request belongs to the session generation current when it STARTED. Once a
// session starts or ends, its continuations (permission queries, position
// callbacks, timers) may no longer touch session fix, outcome or acquisition
// state. `undefined` means a synchronous caller acting on the current session.
function _sessionScopeIsCurrent(generation) {
  return generation === undefined || generation === locationOutcomeGeneration
}

function _requestIsCurrent(requestToken, generation) {
  return _captureSessionRequestIsCurrent(requestToken) && _sessionScopeIsCurrent(generation)
}

function _resetSessionLocationOutcome(outcome = null) {
  locationOutcomeGeneration += 1
  state.captureSessionLocation.outcome = normalizeSessionLocationOutcome(outcome)
}

/**
 * Start a fresh outcome scope for a review session that did not begin through
 * beginCaptureLocationSession (imported review, restored draft). In-flight
 * results from the previous session are ignored from here on.
 */
export function resetCaptureSessionLocationOutcome(outcome = null) {
  _resetSessionLocationOutcome(outcome)
}

export function getCaptureSessionLocationOutcome() {
  return normalizeSessionLocationOutcome(state.captureSessionLocation.outcome)
}

function _emitLocationStateChanged() {
  _dispatchEvent(LOCATION_STATE_CHANGED_EVENT, {
    location: _cloneLocationState(),
    captureSessionLocation: _cloneCaptureSessionLocation(),
  })
}

function _emitAcceptedFix(fix) {
  _emitLocationStateChanged()
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

function _isBetterSessionFix(candidate, existing) {
  if (!candidate) return false
  if (!existing) return true

  const candidateAccuracy = _finiteNumber(candidate.accuracy)
  const existingAccuracy = _finiteNumber(existing.accuracy)
  const candidateHasAccuracy = Number.isFinite(candidateAccuracy)
  const existingHasAccuracy = Number.isFinite(existingAccuracy)

  if (candidateHasAccuracy && !existingHasAccuracy) return true
  if (!candidateHasAccuracy && existingHasAccuracy) return false
  if (candidateHasAccuracy && existingHasAccuracy) {
    if (candidateAccuracy < existingAccuracy) return true
    if (candidateAccuracy > existingAccuracy) return false
  }

  const candidateTimestamp = _finiteNumber(candidate.timestamp)
  const existingTimestamp = _finiteNumber(existing.timestamp)
  if (Number.isFinite(candidateTimestamp) && Number.isFinite(existingTimestamp)) {
    return candidateTimestamp > existingTimestamp
  }

  return false
}

function _isInternalOverrideAllowed(options = {}) {
  // Internal overrides still require a live session token and explicit user consent.
  // Today the only UI-backed consent path is persistent preference === 'enabled'.
  if (options.internalOverride !== true) return true
  if (state.location.preference !== 'enabled') return false
  const requestToken = options.captureSessionRequestToken
  if (requestToken == null) return false
  return _captureSessionRequestIsCurrent(requestToken)
}

function _isAcceptableFixTimestamp(timestamp, options = {}) {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const normalizedMaxAge = _normalizeAcceptedFixMaxAgeMs(options.acceptedFixMaxAgeMs)
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
  if (!Number.isFinite(sessionStartMs) || !Number.isFinite(fixTimestamp)) return false
  if (fixTimestamp >= sessionStartMs) return true
  return fix === state.captureSessionLocation.fix
    && fixTimestamp >= sessionStartMs - LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS
}

function _captureSessionAcceptsFixTimestamp(fixTimestamp, options = {}) {
  const sessionStartMs = _currentSessionStartMs()
  if (!Number.isFinite(fixTimestamp) || !Number.isFinite(sessionStartMs)) return false
  const captureWindowEndAt = state.captureSessionLocation.captureWindowEndAt
  const captureWindowEndMs = captureWindowEndAt == null ? null : _finiteNumber(captureWindowEndAt)
  if (Number.isFinite(captureWindowEndMs) && fixTimestamp > captureWindowEndMs) return false
  if (fixTimestamp >= sessionStartMs) return true

  const requestStartedAt = _finiteNumber(options.requestStartedAt)
  if (!Number.isFinite(requestStartedAt) || requestStartedAt < sessionStartMs) return false
  const acceptedFixMaxAgeMs = _normalizeAcceptedFixMaxAgeMs(options.acceptedFixMaxAgeMs)
  return fixTimestamp >= requestStartedAt - acceptedFixMaxAgeMs
}

function _updateCaptureSessionFixFromAcceptedFix(fix, options = {}) {
  if (!state.captureSessionLocation.sessionStartAt) return false
  if (!_sessionScopeIsCurrent(options.sessionGeneration)) return false
  const fixTimestamp = _finiteNumber(fix?.timestamp)
  if (!_captureSessionAcceptsFixTimestamp(fixTimestamp, options)) {
    return false
  }
  if (!_isBetterSessionFix(fix, state.captureSessionLocation.fix)) {
    return false
  }
  // Tagged where it is acquired: only a fix accepted here is device GPS.
  state.captureSessionLocation.fix = { ..._cloneFix(fix), source: LOCATION_SOURCE.DEVICE_GPS }
  state.captureSessionLocation.requestingFreshFix = false
  return true
}

function _acceptFix(position, options = {}) {
  const coords = position?.coords || {}
  const lat = Number(coords.latitude)
  const lon = Number(coords.longitude)
  if (!_isValidCoordinate(lat, lon)) return null

  const timestamp = _finiteNumber(position?.timestamp)
  if (!_isAcceptableFixTimestamp(timestamp, options)) return null

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

  _updateCaptureSessionFixFromAcceptedFix(fix, options)
  _clearFreshFixAcquisitionTimer()
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

// ── Fresh-fix acquisition supervisor (QA round 3) ────────────────────────────
//
// The capture-session watch (`startLocationWatch({ requestFreshFix: true })`)
// passes no `timeout` to watchPosition, and on Android a GNSS watch that
// never obtains a fix may NEVER invoke its error callback — so the UI stayed
// on "Finding location…" indefinitely (observed on the second consecutive
// offline capture; the first got a fix, which is the only path that cleared
// the state). This supervisor bounds the ACQUISITION UI, not the watch: when
// the configured timeout elapses with no accepted session fix, it clears
// `requestingFreshFix` and reports the standard timeout state, while the
// watch keeps running so a late fix for THIS session can still land (the
// session request-token safeguards keep it from touching a newer session).
// Saving is never blocked by any of this.
export const LOCATION_FRESH_FIX_ACQUISITION_TIMEOUT_MS = 30_000
let _freshFixAcquisitionTimer = null

function _clearFreshFixAcquisitionTimer() {
  if (_freshFixAcquisitionTimer != null) {
    clearTimeout(_freshFixAcquisitionTimer)
    _freshFixAcquisitionTimer = null
  }
}

function _armFreshFixAcquisitionTimer(watchId, timeoutMs = LOCATION_FRESH_FIX_ACQUISITION_TIMEOUT_MS, outcomeGeneration = locationOutcomeGeneration, outcomeAttempt = undefined) {
  _clearFreshFixAcquisitionTimer()
  const normalized = Number(timeoutMs)
  if (!Number.isFinite(normalized) || normalized <= 0) return
  _freshFixAcquisitionTimer = setTimeout(() => {
    _freshFixAcquisitionTimer = null
    // A different (or no) watch is active now — a newer session owns the UI.
    if (watchId == null || state.location.watchId !== watchId) return
    if (!_sessionScopeIsCurrent(outcomeGeneration) || !_attemptIsCurrent(outcomeAttempt)) return
    // A fix arrived (or another terminal state resolved the UI) — nothing to do.
    const stillLocating = state.location.status === 'locating'
      || state.captureSessionLocation.requestingFreshFix === true
    if (!stillLocating) return
    if (_sessionFixIsCurrent(state.captureSessionLocation.fix)) return
    // Standard timeout surface: clears requestingFreshFix, emits the state
    // change, and leaves the watch running for a late same-session fix.
    _setWatchErrorState(_createTimeoutError(), outcomeGeneration, outcomeAttempt)
  }, normalized)
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
    _clearFreshFixAcquisitionTimer()
  }
  return true
}

function _markWatchState(status, error = null) {
  state.location.status = status
  state.location.error = error
  _emitLocationStateChanged()
}

function _ensureCaptureLocationVisibilityListener() {
  const doc = globalThis.document
  if (!doc?.addEventListener) return

  if (!liveCaptureSession.visibilityHandler) {
    liveCaptureSession.visibilityHandler = () => {
      const hidden = doc.hidden === true || doc.visibilityState === 'hidden'
      const visible = doc.hidden === false || doc.visibilityState === 'visible' || doc.visibilityState == null
      if (hidden) {
        void suspendCaptureLocationSession()
        return
      }
      if (visible) {
        void resumeCaptureLocationSession()
      }
    }
  }

  if (liveCaptureSession.visibilityListenerDocument === doc) return

  if (liveCaptureSession.visibilityListenerDocument?.removeEventListener && liveCaptureSession.visibilityHandler) {
    liveCaptureSession.visibilityListenerDocument.removeEventListener('visibilitychange', liveCaptureSession.visibilityHandler)
  }

  liveCaptureSession.visibilityListenerDocument = doc
  doc.addEventListener('visibilitychange', liveCaptureSession.visibilityHandler)
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
  if (!_isInternalOverrideAllowed(options)) {
    return false
  }
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
  _recordSessionLocationOutcome(state.location.error, locationOutcomeGeneration, _beginLocationAttempt())
  state.captureSessionLocation.requestingFreshFix = false
  _applyUnsupportedPolicy()
  _clearWatchId()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setDeniedState(error = _createDeniedError(), outcomeGeneration = locationOutcomeGeneration, outcomeAttempt = undefined) {
  // The permission itself is a device-global fact; a stale or superseded
  // continuation may report it but must not touch the acquisition status or
  // the newer attempt's fix, watch or outcome.
  state.location.permission = 'denied'
  if (_sessionScopeIsCurrent(outcomeGeneration) && _attemptIsCurrent(outcomeAttempt)) {
    state.location.status = 'error'
    state.location.error = error
    _recordSessionLocationOutcome(error, outcomeGeneration, outcomeAttempt)
    state.captureSessionLocation.requestingFreshFix = false
    _applyPermissionDeniedPolicy()
    _clearWatchId()
  }
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setDisabledState() {
  state.location.status = 'idle'
  state.location.error = _createDisabledError()
  _recordSessionLocationOutcome(state.location.error, locationOutcomeGeneration, _beginLocationAttempt())
  state.location.fix = null
  state.captureSessionLocation.requestingFreshFix = false
  state.captureSessionLocation.fix = null
  _clearWatchId()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setWatchErrorState(error, outcomeGeneration = locationOutcomeGeneration, outcomeAttempt = undefined) {
  // A superseded attempt (older session or older same-session attempt) must
  // not replace the newer attempt's outcome or acquisition state.
  if (!_sessionScopeIsCurrent(outcomeGeneration) || !_attemptIsCurrent(outcomeAttempt)) return _cloneLocationState()
  const classified = _classifyGeolocationError(error)
  if (classified.kind === 'permission-denied') return _setDeniedState(classified, outcomeGeneration, outcomeAttempt)

  if (_sessionFixIsCurrent(state.captureSessionLocation.fix)) {
    state.location.status = 'fix'
    state.location.error = null
    state.location.fix = _cloneFix(state.captureSessionLocation.fix)
    state.location.permission = state.location.permission === 'denied' ? 'unknown' : state.location.permission
    state.captureSessionLocation.requestingFreshFix = false
    _emitLocationStateChanged()
    return _cloneLocationState()
  }

  state.location.status = classified.status
  state.location.error = classified
  state.captureSessionLocation.requestingFreshFix = false
  _recordSessionLocationOutcome(classified, outcomeGeneration, outcomeAttempt)
  _pruneStaleGlobalFix()
  _emitLocationStateChanged()
  return _cloneLocationState()
}

function _setTerminalWatchError(error, outcomeGeneration = locationOutcomeGeneration, outcomeAttempt = undefined) {
  _clearWatchId()
  return _setWatchErrorState(error, outcomeGeneration, outcomeAttempt)
}

function _callWatchPosition(options = {}) {
  const outcomeGeneration = options.sessionGeneration ?? locationOutcomeGeneration
  const outcomeAttempt = options.attemptId
  const watchPosition = globalThis.navigator?.geolocation?.watchPosition
  if (typeof watchPosition !== 'function') {
    return { supported: false, watchId: null, terminalError: _createUnsupportedError() }
  }

  let watchId = null
  let settled = false
  let terminalError = null
  let clearWhenReady = false
  const requestToken = options.captureSessionRequestToken ?? null
  const requestStartedAt = _finiteNumber(options.requestStartedAt) ?? Date.now()

  const safeClear = () => {
    if (watchId == null) {
      clearWhenReady = true
      return
    }
    _clearWatchId(watchId)
  }

  const success = position => {
    if (settled) return
    if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
      settled = true
      safeClear()
      return
    }
    const fix = _acceptFix(position, { ...options, requestStartedAt, sessionGeneration: outcomeGeneration })
    if (!fix) {
      settled = true
      terminalError = _createInvalidFixError()
      safeClear()
      _setWatchErrorState(terminalError, outcomeGeneration, outcomeAttempt)
    }
  }

  const error = geolocationError => {
    if (settled) return
    if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
      settled = true
      safeClear()
      return
    }
    settled = true
    terminalError = geolocationError
    safeClear()
    _setTerminalWatchError(geolocationError, outcomeGeneration, outcomeAttempt)
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
    _setTerminalWatchError(err, outcomeGeneration, outcomeAttempt)
  }

  return {
    supported: true,
    watchId,
    terminalError,
  }
}

function _requestCurrentPositionOnce(options = {}) {
  const outcomeGeneration = options.sessionGeneration ?? locationOutcomeGeneration
  const outcomeAttempt = options.attemptId
  const getCurrentPosition = globalThis.navigator?.geolocation?.getCurrentPosition
  if (typeof getCurrentPosition !== 'function') return null

  let settled = false
  let resolvePromise = null
  let timeoutHandle = null
  const requestToken = options.captureSessionRequestToken ?? null
  const requestStartedAt = Date.now()

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
    if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
      finish(_cloneLocationState())
      return
    }
    const fix = _acceptFix(position, { ...options, requestStartedAt, sessionGeneration: outcomeGeneration })
    if (!fix) {
      finish(_setWatchErrorState(_createInvalidFixError(), outcomeGeneration, outcomeAttempt))
      return
    }
    finish(_cloneLocationState())
  }

  const error = geolocationError => {
    if (settled) return
    if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
      finish(_cloneLocationState())
      return
    }
    finish(_setWatchErrorState(geolocationError, outcomeGeneration, outcomeAttempt))
  }

  const timeoutMs = _normalizeTimeoutMs(options.timeoutMs)
  timeoutHandle = timeoutMs >= 0
    ? setTimeout(() => {
        if (settled) return
        if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
          finish(_cloneLocationState())
          return
        }
        finish(_setWatchErrorState(_createTimeoutError(), outcomeGeneration, outcomeAttempt))
      }, timeoutMs)
    : null

  try {
    getCurrentPosition.call(
      globalThis.navigator.geolocation,
      success,
      error,
      {
        enableHighAccuracy: options.enableHighAccuracy !== false,
        maximumAge: _normalizeMaxAgeMs(options.maximumAgeMs ?? options.maxAgeMs ?? 0),
        timeout: timeoutMs,
      },
    )
  } catch (err) {
    finish(_setWatchErrorState(err, outcomeGeneration, outcomeAttempt))
  }

  return promise
}

function _requestCurrentPositionWithWatchFallback(options = {}) {
  const outcomeGeneration = options.sessionGeneration ?? locationOutcomeGeneration
  const outcomeAttempt = options.attemptId
  const watchPosition = globalThis.navigator?.geolocation?.watchPosition
  if (typeof watchPosition !== 'function') {
    return Promise.resolve(_setUnsupportedState())
  }

  let settled = false
  let resolvePromise = null
  let timeoutHandle = null
  let watchId = null
  let clearWhenReady = false
  const requestToken = options.captureSessionRequestToken ?? null
  const requestStartedAt = Date.now()

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
    if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
      clearWatchSafely()
      finish(_cloneLocationState())
      return
    }
    const fix = _acceptFix(position, { ...options, requestStartedAt, sessionGeneration: outcomeGeneration })
    if (!fix) {
      clearWatchSafely()
      finish(_setWatchErrorState(_createInvalidFixError(), outcomeGeneration, outcomeAttempt))
      return
    }
    clearWatchSafely()
    finish(_cloneLocationState())
  }

  const error = geolocationError => {
    if (settled) return
    if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
      clearWatchSafely()
      finish(_cloneLocationState())
      return
    }
    clearWatchSafely()
    finish(_setWatchErrorState(geolocationError, outcomeGeneration, outcomeAttempt))
  }

  try {
    const returnedWatchId = watchPosition.call(
      globalThis.navigator.geolocation,
      success,
      error,
      {
        enableHighAccuracy: options.enableHighAccuracy !== false,
        maximumAge: _normalizeMaxAgeMs(options.maximumAgeMs ?? options.maxAgeMs ?? 0),
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
    finish(_setWatchErrorState(err, outcomeGeneration, outcomeAttempt))
    return promise
  }

  const timeoutMs = _normalizeTimeoutMs(options.timeoutMs)
  timeoutHandle = timeoutMs >= 0
    ? setTimeout(() => {
        if (settled) return
        if (!_requestIsCurrent(requestToken, outcomeGeneration)) {
          clearWatchSafely()
          finish(_cloneLocationState())
          return
        }
        clearWatchSafely()
        finish(_setWatchErrorState(_createTimeoutError(), outcomeGeneration, outcomeAttempt))
      }, timeoutMs)
    : null

  return promise
}

export function getLocationFix({ allowStale = false, maxAgeMs = LOCATION_FIX_MAX_AGE_MS } = {}) {
  if (!allowStale) _pruneStaleGlobalFix(maxAgeMs)
  return _cloneFix(state.location.fix)
}

export async function checkLocationCapabilityAndPermission(options = {}) {
  const sessionGeneration = options.sessionGeneration ?? locationOutcomeGeneration
  // A standalone check is its own attempt; inside a request/watch it is that
  // attempt's permission continuation.
  const attemptId = options.attemptId ?? _beginLocationAttempt()
  if (!_supportsGeolocation()) {
    return _setUnsupportedState()
  }

  state.location.capability = 'supported'
  const permission = _updatePermissionSnapshot(await _queryPermissionState())

  if (permission === 'denied') {
    // The query started in `sessionGeneration`; a session change during the
    // await makes it stale for session state.
    return _setDeniedState(_createDeniedError(), sessionGeneration, attemptId)
  }

  _pruneStaleGlobalFix()
  // Only the owning (current) attempt may reset acquisition status; a
  // superseded permission continuation must not clobber a newer attempt's
  // locating/timeout state.
  if (state.location.watchId == null && _sessionScopeIsCurrent(sessionGeneration) && _attemptIsCurrent(attemptId)) {
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

  // An already-running watch is reused below without starting an attempt, so
  // it must not supersede in-flight attempts.
  if (state.location.watchId != null && options.force !== true) {
    return _cloneLocationState()
  }
  const sessionGeneration = locationOutcomeGeneration
  const attemptId = _beginLocationAttempt()
  const snapshot = await checkLocationCapabilityAndPermission({ sessionGeneration, attemptId })
  if (snapshot.capability === 'unsupported' || snapshot.permission === 'denied') {
    return snapshot
  }
  // The session this watch was requested for has ended or been replaced, or a
  // newer attempt superseded this one while its permission check was pending:
  // it must not start acquisition or reclaim acquisition state.
  if (!_sessionScopeIsCurrent(sessionGeneration) || !_attemptIsCurrent(attemptId)) return _cloneLocationState()

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

  const watchStart = _callWatchPosition({
    acceptedFixMaxAgeMs: options.acceptedFixMaxAgeMs,
    captureSessionRequestToken: options.captureSessionRequestToken ?? null,
    sessionGeneration,
    attemptId,
    positionOptions: {
      enableHighAccuracy: options.enableHighAccuracy !== false,
      maximumAge: options.maximumAgeMs !== undefined ? _normalizeMaxAgeMs(options.maximumAgeMs) : 0,
    },
  })

  if (watchStart.terminalError && state.location.watchId == null) {
    return _cloneLocationState()
  }

  if (watchStart.watchId != null) {
    state.location.watchId = watchStart.watchId
  }

  if (watchStart.terminalError) {
    return _cloneLocationState()
  }

  // Bound the "Finding location…" acquisition state: a GNSS watch with no
  // fix may never error on Android. After the acquisition timeout the UI
  // reports the standard timeout state while the watch keeps listening.
  if (options.requestFreshFix && watchStart.watchId != null) {
    _armFreshFixAcquisitionTimer(
      watchStart.watchId,
      options.acquisitionTimeoutMs ?? LOCATION_FRESH_FIX_ACQUISITION_TIMEOUT_MS,
      sessionGeneration,
      attemptId,
    )
  }

  return _cloneLocationState()
}

export async function requestFreshLocation(options = {}) {
  if (!_canAcquireLocation(options)) {
    return _stateAfterAcquireBlocked()
  }

  const sessionGeneration = locationOutcomeGeneration
  const attemptId = _beginLocationAttempt()
  const snapshot = await checkLocationCapabilityAndPermission({ sessionGeneration, attemptId })
  if (snapshot.capability === 'unsupported' || snapshot.permission === 'denied') {
    return snapshot
  }
  // The session this request was made for has ended or been replaced, or a
  // newer attempt superseded this one while its permission check was pending:
  // it must not start acquisition or reclaim acquisition state.
  if (!_sessionScopeIsCurrent(sessionGeneration) || !_attemptIsCurrent(attemptId)) return _cloneLocationState()

  state.captureSessionLocation.requestingFreshFix = true
  state.location.status = 'locating'
  state.location.error = null
  _emitLocationStateChanged()

  const currentPositionRequest = _requestCurrentPositionOnce({
    maximumAgeMs: options.maximumAgeMs ?? options.maxAgeMs ?? 0,
    acceptedFixMaxAgeMs: options.acceptedFixMaxAgeMs,
    timeoutMs: options.timeoutMs,
    enableHighAccuracy: options.enableHighAccuracy,
    captureSessionRequestToken: options.captureSessionRequestToken ?? null,
    sessionGeneration,
    attemptId,
  })

  if (currentPositionRequest) return currentPositionRequest

  return _requestCurrentPositionWithWatchFallback({
    maximumAgeMs: options.maximumAgeMs ?? options.maxAgeMs ?? 0,
    acceptedFixMaxAgeMs: options.acceptedFixMaxAgeMs,
    timeoutMs: options.timeoutMs,
    enableHighAccuracy: options.enableHighAccuracy,
    captureSessionRequestToken: options.captureSessionRequestToken ?? null,
    sessionGeneration,
    attemptId,
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

export function beginCaptureLocationSession(options = {}) {
  _ensureCaptureLocationVisibilityListener()
  liveCaptureSession.active = true
  liveCaptureSession.suspendedByVisibility = false
  liveCaptureSession.requestToken += 1
  const sessionStart = options.sessionStartAt instanceof Date
    ? options.sessionStartAt
    : new Date()
  if (!state.captureSessionLocation.sessionStartAt) {
    state.sessionStart = sessionStart
    state.captureSessionLocation.sessionStartAt = sessionStart
    // New session: no outcome is carried over. Re-beginning the SAME session
    // (preflight "continue" after a denial) keeps the observed outcome.
    _resetSessionLocationOutcome()
  }
  state.captureSessionLocation.fix = null
  state.captureSessionLocation.requestingFreshFix = false
  state.captureSessionLocation.captureWindowEndAt = null
  _emitLocationStateChanged()
  return _cloneCaptureSessionLocation()
}

export function suspendCaptureLocationSession() {
  if (!liveCaptureSession.active) return _cloneCaptureSessionLocation()
  liveCaptureSession.suspendedByVisibility = true
  stopLocationWatch()
  return _cloneCaptureSessionLocation()
}

export async function resumeCaptureLocationSession(options = {}) {
  if (!liveCaptureSession.active || !liveCaptureSession.suspendedByVisibility) {
    return _cloneCaptureSessionLocation()
  }
  if (liveCaptureSession.resumeInFlight) {
    return _cloneCaptureSessionLocation()
  }
  if (state.location.preference !== 'enabled') {
    return _cloneCaptureSessionLocation()
  }
  if (state.location.watchId != null) {
    liveCaptureSession.suspendedByVisibility = false
    return _cloneCaptureSessionLocation()
  }

  const resumeToken = liveCaptureSession.requestToken
  liveCaptureSession.resumeInFlight = true

  try {
    const snapshot = await checkLocationCapabilityAndPermission()
    if (!_captureSessionRequestIsCurrent(resumeToken)) return snapshot
    if (state.location.preference !== 'enabled') return snapshot
    if (snapshot.capability === 'unsupported' || snapshot.permission === 'denied') return snapshot

    await requestFreshLocation({
      maximumAgeMs: 0,
      acceptedFixMaxAgeMs: LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS,
      timeoutMs: options.timeoutMs ?? LOCATION_RESUME_TIMEOUT_MS,
      enableHighAccuracy: options.enableHighAccuracy !== false,
      captureSessionRequestToken: resumeToken,
    })

    if (!_captureSessionRequestIsCurrent(resumeToken)) return _cloneCaptureSessionLocation()
    if (state.location.preference !== 'enabled') return _cloneCaptureSessionLocation()
    if (state.location.capability === 'unsupported' || state.location.permission === 'denied') {
      return _cloneCaptureSessionLocation()
    }

    const watchStart = await startLocationWatch({
      requestFreshFix: false,
      maximumAgeMs: 0,
      acceptedFixMaxAgeMs: LOCATION_ACCEPTED_FRESH_FIX_MAX_AGE_MS,
      enableHighAccuracy: options.enableHighAccuracy !== false,
      internalOverride: true,
      captureSessionRequestToken: resumeToken,
    })
    if (_captureSessionRequestIsCurrent(resumeToken) && watchStart.watchId != null) {
      liveCaptureSession.suspendedByVisibility = false
    }
    return watchStart
  } finally {
    if (resumeToken === liveCaptureSession.requestToken) {
      liveCaptureSession.resumeInFlight = false
    }
  }
}

export function endCaptureLocationSession() {
  liveCaptureSession.active = false
  liveCaptureSession.suspendedByVisibility = false
  liveCaptureSession.resumeInFlight = false
  liveCaptureSession.requestToken += 1
  stopLocationWatch()
  state.sessionStart = null
  state.captureSessionLocation.sessionStartAt = null
  state.captureSessionLocation.fix = null
  state.captureSessionLocation.requestingFreshFix = false
  state.captureSessionLocation.captureWindowEndAt = null
  _resetSessionLocationOutcome()
  _emitLocationStateChanged()
  return _cloneCaptureSessionLocation()
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

export function getCaptureSessionRequestToken() {
  // Opaque token identifying the active live-capture session. Callers that
  // pass internalOverride to requestFreshLocation/startLocationWatch must
  // supply this token; review-layer session keys (e.g. 'live:<ms>') are NOT
  // valid here and will be rejected by _captureSessionRequestIsCurrent.
  return liveCaptureSession.active ? liveCaptureSession.requestToken : null
}

export function __getCaptureLocationSessionRequestTokenForTests() {
  // Test-only hook for race coverage. Do not use from production code.
  return liveCaptureSession.requestToken
}
