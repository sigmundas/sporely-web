import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { state } from './state.js'
import {
  beginCaptureLocationSession,
  endCaptureLocationSession,
  getCaptureSessionLocationOutcome,
  requestFreshLocation,
  resetCaptureSessionLocationOutcome,
  setLocationPreference,
  startLocationWatch,
} from './geo.js'
import {
  LOCATION_SOURCE,
  LOCATION_STATUS,
  applyLocationProvenanceToPayload,
  buildSetObservationLocationArgs,
  exifGpsSourceForIngest,
  isCompatibleLocationProvenance,
  isMissingLocationProvenanceError,
  locationOutcomeFromGeoError,
  resolveSaveLocationProvenance,
  sanitizeQueuedLocationProvenance,
  setObservationLocation,
  withLocationSource,
  withoutLocationProvenance,
} from './location-provenance.js'

// ── Pure contract helpers ────────────────────────────────────────────────────

test('geo error kinds map to session outcomes; non-failures map to nothing', () => {
  assert.equal(locationOutcomeFromGeoError({ kind: 'permission-denied' }), 'denied')
  assert.equal(locationOutcomeFromGeoError({ kind: 'disabled' }), 'disabled')
  assert.equal(locationOutcomeFromGeoError({ kind: 'timeout' }), 'timeout')
  assert.equal(locationOutcomeFromGeoError({ kind: 'position-unavailable' }), 'unavailable')
  assert.equal(locationOutcomeFromGeoError({ kind: 'unsupported' }), 'unavailable')
  assert.equal(locationOutcomeFromGeoError({ kind: 'invalid-fix' }), 'unavailable')
  assert.equal(locationOutcomeFromGeoError({ kind: 'error' }), 'unknown')
  assert.equal(locationOutcomeFromGeoError(null), null)
  assert.equal(locationOutcomeFromGeoError({ kind: 'something-else' }), null)
})

test('frozen transitions: save provenance for each documented situation', () => {
  const fix = { lat: 63.4, lon: 10.4 }
  const cases = [
    ['fresh device fix', { gps: { ...fix, source: 'device_gps' } }, ['device_gps', 'acquired']],
    ['usable original EXIF', { gps: { ...fix, source: 'image_exif' } }, ['image_exif', 'acquired']],
    ['manual coordinates', { gps: { ...fix, source: 'manual' } }, ['manual', 'acquired']],
    ['unclassified coordinates', { gps: { ...fix } }, ['unknown', 'acquired']],
    ['denied then continue', { decision: 'continue', sessionOutcome: 'denied' }, ['none', 'denied']],
    ['timeout then continue', { decision: 'continue', sessionOutcome: 'timeout' }, ['none', 'timeout']],
    ['unavailable then continue', { decision: 'continue', sessionOutcome: 'unavailable' }, ['none', 'unavailable']],
    ['disabled then continue', { decision: 'continue', sessionOutcome: 'disabled' }, ['none', 'disabled']],
    ['preference disabled at save', { decision: 'disabled', sessionOutcome: 'timeout' }, ['none', 'disabled']],
    ['skip with no observed outcome', { decision: 'continue', sessionOutcome: null }, ['none', 'skipped']],
    ['failure then a selected fix', { gps: { ...fix, source: 'device_gps' }, decision: 'continue', sessionOutcome: 'denied' }, ['device_gps', 'acquired']],
    ['failure but manual coordinates selected', { gps: { ...fix, source: 'manual' }, sessionOutcome: 'timeout' }, ['manual', 'acquired']],
  ]
  for (const [label, input, [source, status]] of cases) {
    assert.deepEqual(resolveSaveLocationProvenance(input), { source, status }, label)
  }
  // `skipped` is a save decision, never a carried session outcome.
  assert.deepEqual(
    resolveSaveLocationProvenance({ decision: 'continue', sessionOutcome: 'skipped' }),
    { source: 'none', status: 'skipped' },
  )
  // No observed decision (import whose acquisition was never observed): NULL pair.
  assert.equal(resolveSaveLocationProvenance({}), null)
  assert.equal(resolveSaveLocationProvenance({ sessionOutcome: 'denied' }), null)
})

test('compatibility mirrors the server CHECK', () => {
  const coords = { gps_latitude: 63.4, gps_longitude: 10.4, gps_altitude: 12, gps_accuracy: 5 }
  const empty = { gps_latitude: null, gps_longitude: null, gps_altitude: null, gps_accuracy: null }
  assert.equal(isCompatibleLocationProvenance(coords, 'device_gps', 'acquired'), true)
  assert.equal(isCompatibleLocationProvenance(coords, 'unknown', 'acquired'), true)
  assert.equal(isCompatibleLocationProvenance(coords, 'none', 'acquired'), false)
  assert.equal(isCompatibleLocationProvenance(coords, 'none', 'skipped'), false)
  assert.equal(isCompatibleLocationProvenance(empty, 'device_gps', 'acquired'), false)
  assert.equal(isCompatibleLocationProvenance(empty, 'none', 'denied'), true)
  assert.equal(isCompatibleLocationProvenance(empty, 'unknown', 'unknown'), true)
  assert.equal(isCompatibleLocationProvenance(empty, 'manual', 'skipped'), false)
  // Altitude/accuracy without lat/lon is not "no coordinates".
  assert.equal(isCompatibleLocationProvenance({ ...empty, gps_accuracy: 9 }, 'none', 'timeout'), false)
  assert.equal(isCompatibleLocationProvenance({ ...coords, gps_latitude: 91 }, 'device_gps', 'acquired'), false)
})

test('payload application is atomic with coordinates and fails closed to a NULL pair', () => {
  const withCoords = { gps_latitude: 63.4, gps_longitude: 10.4, gps_altitude: null, gps_accuracy: 8 }
  assert.deepEqual(
    applyLocationProvenanceToPayload({ ...withCoords }, { source: 'device_gps', status: 'acquired' }),
    { ...withCoords, location_source: 'device_gps', location_status: 'acquired' },
  )
  // Incompatible pair → neither field (the CHECK would reject the insert).
  const mismatched = applyLocationProvenanceToPayload({ ...withCoords }, { source: 'none', status: 'denied' })
  assert.equal('location_source' in mismatched, false)
  assert.equal('location_status' in mismatched, false)
  // Null provenance removes stale fields instead of keeping half a pair.
  const stale = applyLocationProvenanceToPayload({ ...withCoords, location_source: 'manual' }, null)
  assert.equal('location_source' in stale, false)
  assert.equal('location_status' in stale, false)
})

test('queue sanitizer leaves legacy payloads untouched and drops half/incompatible pairs', () => {
  const legacy = { gps_latitude: 1, gps_longitude: 2 }
  assert.deepEqual(sanitizeQueuedLocationProvenance({ ...legacy }), legacy)
  const half = sanitizeQueuedLocationProvenance({ ...legacy, location_source: 'device_gps' })
  assert.equal('location_source' in half, false)
  const wrong = sanitizeQueuedLocationProvenance({ gps_latitude: null, gps_longitude: null, location_source: 'device_gps', location_status: 'acquired' })
  assert.equal('location_status' in wrong, false)
  const good = sanitizeQueuedLocationProvenance({ gps_latitude: null, gps_longitude: null, location_source: 'none', location_status: 'timeout' })
  assert.equal(good.location_status, 'timeout')
  assert.deepEqual(withoutLocationProvenance({ a: 1, location_source: 'x', location_status: 'y' }), { a: 1 })
})

test('missing-schema detection covers absent columns and the absent RPC only', () => {
  assert.equal(isMissingLocationProvenanceError({ code: 'PGRST204', message: "Could not find the 'location_source' column of 'observations' in the schema cache" }), true)
  assert.equal(isMissingLocationProvenanceError({ code: '42703', message: 'column "location_status" of relation "observations" does not exist' }), true)
  assert.equal(isMissingLocationProvenanceError({ code: 'PGRST202', message: 'Could not find the function public.set_observation_location(p_gps_accuracy, ...) in the schema cache' }), true)
  assert.equal(isMissingLocationProvenanceError({ code: 'PGRST204', message: "Could not find the 'captured_at' column" }), false)
  assert.equal(isMissingLocationProvenanceError({ code: '23514', message: 'violates check constraint observations_location_provenance_check' }), false)
  assert.equal(isMissingLocationProvenanceError({ code: '42501', message: 'Observation not available to owner' }), false)
})

test('aware RPC request: complete seven arguments for manual assignment and deliberate clearing', () => {
  assert.deepEqual(
    buildSetObservationLocationArgs({ observationId: 7, lat: 63.4, lon: 10.4, source: 'manual', status: 'acquired' }),
    {
      p_observation_id: 7,
      p_gps_latitude: 63.4,
      p_gps_longitude: 10.4,
      p_gps_altitude: null,
      p_gps_accuracy: null,
      p_location_source: 'manual',
      p_location_status: 'acquired',
    },
  )
  assert.deepEqual(
    buildSetObservationLocationArgs({ observationId: 7, source: LOCATION_SOURCE.NONE, status: LOCATION_STATUS.SKIPPED }),
    {
      p_observation_id: 7,
      p_gps_latitude: null,
      p_gps_longitude: null,
      p_gps_altitude: null,
      p_gps_accuracy: null,
      p_location_source: 'none',
      p_location_status: 'skipped',
    },
  )
  // Same enum pair for a new fix is allowed (device_gps → new device_gps).
  assert.equal(buildSetObservationLocationArgs({ observationId: 7, lat: 1, lon: 2, source: 'device_gps', status: 'acquired' }).p_location_source, 'device_gps')
  assert.equal(buildSetObservationLocationArgs({ observationId: 7, lat: 1, lon: 2, source: 'none', status: 'skipped' }), null)
  assert.equal(buildSetObservationLocationArgs({ observationId: 7, source: 'manual', status: 'acquired' }), null)
  assert.equal(buildSetObservationLocationArgs({ observationId: 7, lat: 1, lon: 2, source: 'manual' }), null)
  assert.equal(buildSetObservationLocationArgs({ lat: 1, lon: 2, source: 'manual', status: 'acquired' }), null)
})

function _fakeClient({ rpcError = null, updateError = null } = {}) {
  const calls = []
  return {
    calls,
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args })
      return { data: args.p_observation_id, error: rpcError }
    },
    from(table) {
      const call = { kind: 'update', table, patch: null, filters: [] }
      calls.push(call)
      const builder = {
        update(patch) { call.patch = patch; return builder },
        eq(column, value) {
          call.filters.push([column, value])
          return call.filters.length >= 2 ? Promise.resolve({ error: updateError }) : builder
        },
      }
      return builder
    },
  }
}

test('setObservationLocation writes through the RPC only', async () => {
  const client = _fakeClient()
  const result = await setObservationLocation(client, { observationId: 9, userId: 'u1', lat: 1, lon: 2, source: 'manual', status: 'acquired' })
  assert.deepEqual(result, { error: null, legacyFallback: false })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].name, 'set_observation_location')
  assert.equal(client.calls[0].args.p_location_source, 'manual')
})

test('setObservationLocation falls back to a plain coordinate update only when the RPC is absent', async () => {
  const missing = _fakeClient({ rpcError: { code: 'PGRST202', message: 'Could not find the function public.set_observation_location' } })
  const result = await setObservationLocation(missing, { observationId: 9, userId: 'u1', lat: 1, lon: 2, source: 'manual', status: 'acquired' })
  assert.deepEqual(result, { error: null, legacyFallback: true })
  assert.deepEqual(missing.calls[1].patch, { gps_latitude: 1, gps_longitude: 2, gps_altitude: null, gps_accuracy: null })
  assert.deepEqual(missing.calls[1].filters, [['id', 9], ['user_id', 'u1']])
  assert.equal('location_source' in missing.calls[1].patch, false)

  // A real refusal (non-owner, CHECK) is surfaced, never retried as a legacy write.
  const denied = _fakeClient({ rpcError: { code: '42501', message: 'Observation not available to owner' } })
  const deniedResult = await setObservationLocation(denied, { observationId: 9, userId: 'u1', lat: 1, lon: 2, source: 'manual', status: 'acquired' })
  assert.equal(deniedResult.error.code, '42501')
  assert.equal(denied.calls.length, 1)

  // Invalid bundle never reaches the server.
  const invalid = _fakeClient()
  const invalidResult = await setObservationLocation(invalid, { observationId: 9, lat: 1, lon: 2, source: 'none', status: 'skipped' })
  assert.ok(invalidResult.error)
  assert.equal(invalid.calls.length, 0)
})

test('EXIF GPS source: original images are image_exif; Sporely Cam EXIF carries the written source', () => {
  assert.equal(exifGpsSourceForIngest('native_picker'), 'image_exif')
  assert.equal(exifGpsSourceForIngest('web_file_picker'), 'image_exif')
  assert.equal(exifGpsSourceForIngest('system_camera'), 'image_exif')
  assert.equal(exifGpsSourceForIngest('sporely_camera', 'device_gps'), 'device_gps')
  assert.equal(exifGpsSourceForIngest('sporely_camera', 'image_exif'), 'image_exif')
  assert.equal(exifGpsSourceForIngest('sporely_camera', null), 'unknown')
  assert.deepEqual(withLocationSource({ lat: 1, lon: 2 }, 'device_gps'), { lat: 1, lon: 2, source: 'device_gps' })
  assert.equal(withLocationSource(null, 'device_gps'), null)
})

// ── geo.js: session-scoped outcome recording ────────────────────────────────

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const savedLocation = { ...state.location }
const savedSession = { ...state.captureSessionLocation }

function _installGeolocation(geolocation) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { geolocation },
  })
}

function _resetGeoState(preference = 'enabled') {
  endCaptureLocationSession()
  state.location = {
    ...state.location,
    preference,
    capability: 'supported',
    permission: 'granted',
    status: 'idle',
    fix: null,
    error: null,
    watchId: null,
  }
}

afterEach(() => {
  endCaptureLocationSession()
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
  state.location = { ...savedLocation }
  state.captureSessionLocation = { ...savedSession }
})

function _errorGeolocation(code) {
  return {
    getCurrentPosition(_success, error) { error({ code, message: `code ${code}` }) },
    watchPosition() { return 1 },
    clearWatch() {},
  }
}

test('geo records denied / timeout / unavailable for the current session', async () => {
  for (const [code, expected] of [[1, 'denied'], [3, 'timeout'], [2, 'unavailable']]) {
    _resetGeoState()
    _installGeolocation(_errorGeolocation(code))
    beginCaptureLocationSession()
    assert.equal(getCaptureSessionLocationOutcome(), null)
    await requestFreshLocation({ timeoutMs: 1000 })
    assert.equal(getCaptureSessionLocationOutcome(), expected, `code ${code}`)
  }
})

test('the latest meaningful outcome wins: timeout, retry, denied', async () => {
  _resetGeoState()
  beginCaptureLocationSession()
  _installGeolocation(_errorGeolocation(3))
  await requestFreshLocation({ timeoutMs: 1000 })
  assert.equal(getCaptureSessionLocationOutcome(), 'timeout')
  _installGeolocation(_errorGeolocation(1))
  await requestFreshLocation({ timeoutMs: 1000 })
  assert.equal(getCaptureSessionLocationOutcome(), 'denied')
})

test('disabling location during a session records disabled', () => {
  _resetGeoState()
  beginCaptureLocationSession()
  setLocationPreference('disabled')
  assert.equal(getCaptureSessionLocationOutcome(), 'disabled')
})

test('re-beginning the same session (preflight continue after denial) keeps the outcome', async () => {
  _resetGeoState()
  _installGeolocation(_errorGeolocation(1))
  beginCaptureLocationSession()
  await requestFreshLocation({ timeoutMs: 1000 })
  assert.equal(getCaptureSessionLocationOutcome(), 'denied')
  beginCaptureLocationSession()
  assert.equal(getCaptureSessionLocationOutcome(), 'denied')
})

test('session reset: a new session never borrows the previous session outcome', async () => {
  _resetGeoState()
  _installGeolocation(_errorGeolocation(1))
  beginCaptureLocationSession()
  await requestFreshLocation({ timeoutMs: 1000 })
  assert.equal(getCaptureSessionLocationOutcome(), 'denied')
  endCaptureLocationSession()
  assert.equal(getCaptureSessionLocationOutcome(), null)
  beginCaptureLocationSession()
  assert.equal(getCaptureSessionLocationOutcome(), null)
})

test('a stale asynchronous failure from an earlier session is ignored', async () => {
  _resetGeoState()
  let pendingError = null
  _installGeolocation({
    getCurrentPosition(_success, error) { pendingError = error },
    watchPosition() { return 1 },
    clearWatch() {},
  })
  beginCaptureLocationSession()
  // Untokened request (like the native-camera prelaunch request).
  const pending = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof pendingError, 'function')
  endCaptureLocationSession()
  beginCaptureLocationSession()
  pendingError({ code: 3, message: 'late timeout' })
  await pending
  assert.equal(getCaptureSessionLocationOutcome(), null, 'old session timeout must not reach the new session')
})

test('a stale watch error from an earlier session is ignored', async () => {
  _resetGeoState()
  let watchError = null
  _installGeolocation({
    getCurrentPosition() {},
    watchPosition(_success, error) { watchError = error; return 7 },
    clearWatch() {},
  })
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true, acquisitionTimeoutMs: 0 })
  assert.equal(typeof watchError, 'function')
  resetCaptureSessionLocationOutcome()
  watchError({ code: 2, message: 'late unavailable' })
  assert.equal(getCaptureSessionLocationOutcome(), null)
})

test('resetCaptureSessionLocationOutcome restores a persisted outcome and rejects skipped/garbage', () => {
  _resetGeoState()
  beginCaptureLocationSession()
  resetCaptureSessionLocationOutcome('timeout')
  assert.equal(getCaptureSessionLocationOutcome(), 'timeout')
  resetCaptureSessionLocationOutcome('skipped')
  assert.equal(getCaptureSessionLocationOutcome(), null)
  resetCaptureSessionLocationOutcome('bogus')
  assert.equal(getCaptureSessionLocationOutcome(), null)
})

test('outcomes are not recorded outside a capture session', async () => {
  _resetGeoState()
  _installGeolocation(_errorGeolocation(1))
  await requestFreshLocation({ timeoutMs: 1000 })
  assert.equal(state.captureSessionLocation.outcome, null)
})

// ── Upload queue: atomic insert, legacy items, pre-migration targets ───────

const queueSource = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')

function _queueFunction(name) {
  const start = queueSource.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `Missing production function ${name}`)
  return queueSource.slice(start, queueSource.indexOf('\n}', start) + 2)
}

function _queueInsertRuntime(responses) {
  const inserts = []
  const context = vm.createContext({
    console: { warn() {} },
    isMissingLocationProvenanceError,
    withoutLocationProvenance,
    supabase: {
      from(table) {
        assert.equal(table, 'observations')
        return {
          insert(payload) {
            inserts.push(structuredClone(payload))
            const response = responses[inserts.length - 1]
            return { select: () => ({ single: async () => response }) }
          },
        }
      },
    },
  })
  vm.runInContext(_queueFunction('_retryObservationInsertWithoutProvenance'), context)
  return { context, inserts }
}

test('queue sanitizes provenance before the single observation insert', () => {
  const sanitizeAt = queueSource.indexOf('sanitizeQueuedLocationProvenance(repairedPayload)')
  const insertAt = queueSource.indexOf("supabase.from('observations').insert(repairedPayload)")
  assert.ok(sanitizeAt > 0 && insertAt > sanitizeAt)
})

test('queue retries without the pair only when the target lacks the provenance columns', async () => {
  const payload = { gps_latitude: 1, gps_longitude: 2, location_source: 'device_gps', location_status: 'acquired' }
  const missing = { code: 'PGRST204', message: "Could not find the 'location_source' column of 'observations'" }
  const { context, inserts } = _queueInsertRuntime([{ data: { id: 5 }, error: null }])
  const result = await context._retryObservationInsertWithoutProvenance(missing, null, payload)
  assert.equal(result.data.id, 5)
  assert.equal(result.error, null)
  assert.deepEqual(inserts, [{ gps_latitude: 1, gps_longitude: 2 }])
  assert.deepEqual(result.payload, { gps_latitude: 1, gps_longitude: 2 })

  // A CHECK refusal (or success) is not retried and keeps the payload.
  const check = { code: '23514', message: 'violates check constraint "observations_location_provenance_check"' }
  const second = _queueInsertRuntime([])
  const refused = await second.context._retryObservationInsertWithoutProvenance(check, null, payload)
  assert.equal(refused.error, check)
  assert.equal(second.inserts.length, 0)
  const ok = await second.context._retryObservationInsertWithoutProvenance(null, { id: 9 }, payload)
  assert.equal(ok.payload, payload)
  assert.equal(second.inserts.length, 0)
})

// Stale continuations must change neither the session outcome nor the
// session's selected fix, nor start acquisition for a session that is gone.

function _installNavigator(nav) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: nav })
}

function _deferredValue() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

test('a permission query that resolves denied after a session change does not touch the new session', async () => {
  _resetGeoState()
  const query = _deferredValue()
  let positionCalls = 0
  _installNavigator({
    permissions: { query: () => query.promise },
    geolocation: { getCurrentPosition() { positionCalls += 1 }, watchPosition() { return 1 }, clearWatch() {} },
  })
  beginCaptureLocationSession()
  const pending = requestFreshLocation({ timeoutMs: 60_000 })
  endCaptureLocationSession()
  beginCaptureLocationSession()
  const newFix = { lat: 60, lon: 10, accuracy: 5, altitude: null, timestamp: Date.now() }
  state.captureSessionLocation.fix = { ...newFix }
  query.resolve({ state: 'denied' })
  await pending
  assert.equal(getCaptureSessionLocationOutcome(), null)
  assert.deepEqual(state.captureSessionLocation.fix, newFix)
  assert.equal(positionCalls, 0)
})

test('a request whose session ended during its permission check never starts acquisition', async () => {
  _resetGeoState()
  const query = _deferredValue()
  let positionCalls = 0
  _installNavigator({
    permissions: { query: () => query.promise },
    geolocation: { getCurrentPosition() { positionCalls += 1 }, watchPosition() { positionCalls += 1; return 1 }, clearWatch() {} },
  })
  beginCaptureLocationSession()
  const request = requestFreshLocation({ timeoutMs: 60_000 })
  const watch = startLocationWatch({ requestFreshFix: true })
  endCaptureLocationSession()
  beginCaptureLocationSession()
  query.resolve({ state: 'granted' })
  await request
  await watch
  assert.equal(positionCalls, 0)
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
  assert.equal(state.location.watchId, null)
})

test('a stale untokened success callback cannot set the new session fix', async () => {
  _resetGeoState()
  let success = null
  _installGeolocation({
    getCurrentPosition(onSuccess) { success = onSuccess },
    watchPosition() { return 1 },
    clearWatch() {},
  })
  beginCaptureLocationSession()
  const pending = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof success, 'function')
  endCaptureLocationSession()
  beginCaptureLocationSession()
  // Fresh timestamp: only the generation guard can reject it.
  success({ coords: { latitude: 61, longitude: 9, accuracy: 3, altitude: null }, timestamp: Date.now() + 1000 })
  await pending
  assert.equal(state.captureSessionLocation.fix, null)
  assert.equal(getCaptureSessionLocationOutcome(), null)
})

test('a stale watch success cannot set the session fix after an outcome-scope reset', async () => {
  _resetGeoState()
  let success = null
  _installGeolocation({
    getCurrentPosition() {},
    watchPosition(onSuccess) { success = onSuccess; return 8 },
    clearWatch() {},
  })
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true, acquisitionTimeoutMs: 0 })
  assert.equal(typeof success, 'function')
  resetCaptureSessionLocationOutcome()
  success({ coords: { latitude: 62, longitude: 8, accuracy: 3, altitude: null }, timestamp: Date.now() + 1000 })
  assert.equal(state.captureSessionLocation.fix, null)
})

test('a current-session success still sets the session fix (guard is not over-broad)', async () => {
  _resetGeoState()
  _installGeolocation({
    getCurrentPosition(onSuccess) {
      onSuccess({ coords: { latitude: 63, longitude: 7, accuracy: 4, altitude: null }, timestamp: Date.now() + 1000 })
    },
    watchPosition() { return 1 },
    clearWatch() {},
  })
  beginCaptureLocationSession()
  await requestFreshLocation({ timeoutMs: 60_000 })
  assert.equal(state.captureSessionLocation.fix?.lat, 63)
  // Tagged where it is acquired.
  assert.equal(state.captureSessionLocation.fix?.source, 'device_gps')
})

// ── Overlapping attempts within ONE session: only the newest records ───────

function _pendingGeolocation() {
  const calls = []
  return {
    calls,
    getCurrentPosition(success, error) { calls.push({ success, error }) },
    watchPosition(success, error) { calls.push({ success, error, watch: true }); return 11 },
    clearWatch() {},
  }
}

test('an older pending request completing after a newer retry cannot replace its outcome', async () => {
  _resetGeoState()
  const geo = _pendingGeolocation()
  _installGeolocation(geo)
  beginCaptureLocationSession()
  const older = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  const newer = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(geo.calls.length, 2)
  geo.calls[1].error({ code: 1, message: 'denied' })
  await newer
  assert.equal(getCaptureSessionLocationOutcome(), 'denied')
  geo.calls[0].error({ code: 3, message: 'late timeout' })
  await older
  assert.equal(getCaptureSessionLocationOutcome(), 'denied', 'superseded timeout must not replace the retry outcome')
})

test('a superseded watch acquisition timer cannot claim the outcome or UI of a pending newer attempt', async () => {
  _resetGeoState()
  const geo = _pendingGeolocation()
  _installGeolocation(geo)
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true, acquisitionTimeoutMs: 20 })
  const retry = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  // The old watch's timer fires while the retry is still in flight.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(getCaptureSessionLocationOutcome(), null)
  assert.equal(state.captureSessionLocation.requestingFreshFix, true, 'the pending retry still owns acquisition state')
  geo.calls.at(-1).error({ code: 2, message: 'unavailable' })
  await retry
  assert.equal(getCaptureSessionLocationOutcome(), 'unavailable')
})

test('a superseded permission continuation cannot replace a newer attempt outcome', async () => {
  _resetGeoState()
  const queries = []
  let positionError = null
  _installNavigator({
    permissions: { query: () => new Promise(resolve => queries.push(resolve)) },
    geolocation: { getCurrentPosition(_s, error) { positionError = error }, watchPosition() { return 1 }, clearWatch() {} },
  })
  beginCaptureLocationSession()
  const older = requestFreshLocation({ timeoutMs: 60_000 })
  const newer = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(queries.length, 2)
  queries[1]({ state: 'granted' })
  await new Promise(resolve => setImmediate(resolve))
  positionError({ code: 3, message: 'timeout' })
  await newer
  assert.equal(getCaptureSessionLocationOutcome(), 'timeout')
  queries[0]({ state: 'denied' })
  await older
  assert.equal(getCaptureSessionLocationOutcome(), 'timeout')
})

test('a superseded attempt that SUCCEEDS still supplies the session fix', async () => {
  _resetGeoState()
  const geo = _pendingGeolocation()
  _installGeolocation(geo)
  beginCaptureLocationSession()
  const older = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  const newer = requestFreshLocation({ timeoutMs: 60_000 })
  await new Promise(resolve => setImmediate(resolve))
  geo.calls[1].error({ code: 3, message: 'timeout' })
  await newer
  geo.calls[0].success({ coords: { latitude: 64.1, longitude: 11.2, accuracy: 6, altitude: null }, timestamp: Date.now() + 1000 })
  await older
  assert.equal(state.captureSessionLocation.fix?.lat, 64.1)
  assert.equal(state.captureSessionLocation.fix?.source, 'device_gps')
})

// ── Superseded permission continuations never (re)start acquisition ───────

function _deferredPermissionRuntime() {
  const queries = []
  const positions = []
  const watches = []
  _installNavigator({
    permissions: { query: () => new Promise(resolve => queries.push(resolve)) },
    geolocation: {
      getCurrentPosition(success, error) { positions.push({ success, error }) },
      watchPosition(success, error) { watches.push({ success, error }); return 21 },
      clearWatch() {},
    },
  })
  return { queries, positions, watches }
}

const _tick = () => new Promise(resolve => setImmediate(resolve))

test('an older granted permission arriving after the newer attempt finished does not restart acquisition', async () => {
  _resetGeoState()
  const rt = _deferredPermissionRuntime()
  beginCaptureLocationSession()
  const older = requestFreshLocation({ timeoutMs: 60_000 })
  const newer = requestFreshLocation({ timeoutMs: 60_000 })
  await _tick()
  rt.queries[1]({ state: 'granted' })
  await _tick()
  assert.equal(rt.positions.length, 1)
  rt.positions[0].error({ code: 3, message: 'timeout' })
  await newer
  assert.equal(state.location.status, 'timeout')

  rt.queries[0]({ state: 'granted' })
  await older
  assert.equal(rt.positions.length, 1, 'superseded request must not start another acquisition')
  assert.equal(rt.watches.length, 0)
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
  assert.equal(state.location.status, 'timeout')
  assert.equal(getCaptureSessionLocationOutcome(), 'timeout')
  assert.equal(state.captureSessionLocation.fix, null)
})

test('an older granted permission arriving while the newer request is active leaves it in charge', async () => {
  _resetGeoState()
  const rt = _deferredPermissionRuntime()
  beginCaptureLocationSession()
  const older = requestFreshLocation({ timeoutMs: 60_000 })
  const newer = requestFreshLocation({ timeoutMs: 60_000 })
  await _tick()
  rt.queries[1]({ state: 'granted' })
  await _tick()
  assert.equal(rt.positions.length, 1)
  assert.equal(state.location.status, 'locating')

  rt.queries[0]({ state: 'granted' })
  await older
  assert.equal(rt.positions.length, 1)
  assert.equal(state.location.status, 'locating', 'status not reset by the superseded continuation')
  assert.equal(state.captureSessionLocation.requestingFreshFix, true)

  rt.positions[0].success({ coords: { latitude: 60.5, longitude: 9.5, accuracy: 5, altitude: null }, timestamp: Date.now() + 1000 })
  await newer
  assert.equal(state.location.status, 'fix')
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
  assert.equal(state.captureSessionLocation.fix?.lat, 60.5)
  assert.equal(getCaptureSessionLocationOutcome(), null)
})

test('a superseded watch start never replaces the newer active request, and an older denial does not reset its status', async () => {
  _resetGeoState()
  const rt = _deferredPermissionRuntime()
  beginCaptureLocationSession()
  const olderWatch = startLocationWatch({ requestFreshFix: true, acquisitionTimeoutMs: 0 })
  const olderRequest = requestFreshLocation({ timeoutMs: 60_000 })
  const newer = requestFreshLocation({ timeoutMs: 60_000 })
  await _tick()
  assert.equal(rt.queries.length, 3)
  rt.queries[2]({ state: 'granted' })
  await _tick()
  assert.equal(rt.positions.length, 1)

  rt.queries[0]({ state: 'granted' })
  await olderWatch
  rt.queries[1]({ state: 'denied' })
  await olderRequest
  assert.equal(rt.watches.length, 0, 'superseded watch must not start')
  assert.equal(state.location.watchId, null)
  assert.equal(rt.positions.length, 1)
  assert.equal(state.location.status, 'locating')
  assert.equal(state.captureSessionLocation.requestingFreshFix, true)
  assert.equal(getCaptureSessionLocationOutcome(), null, 'superseded denial is not the outcome')

  rt.positions[0].error({ code: 2, message: 'unavailable' })
  await newer
  assert.equal(getCaptureSessionLocationOutcome(), 'unavailable')
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
  assert.equal(state.captureSessionLocation.fix, null)
})
