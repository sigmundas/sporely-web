// Private observation location provenance (`observations.location_source` /
// `location_status`). Pure helpers: no state, no Supabase import. See the
// frozen transition table in docs/supabase-sync-contract.md.

/**
 * Origin of the observation's current coordinates.
 * @typedef {'device_gps'|'image_exif'|'manual'|'none'|'unknown'} LocationSource
 */
export const LOCATION_SOURCE = Object.freeze({
  DEVICE_GPS: 'device_gps',
  IMAGE_EXIF: 'image_exif',
  MANUAL: 'manual',
  NONE: 'none',
  UNKNOWN: 'unknown',
})

/**
 * Selected-location outcome. `acquired` for valid coordinates; otherwise the
 * latest meaningful acquisition outcome of the current session at save.
 * @typedef {'acquired'|'disabled'|'denied'|'timeout'|'skipped'|'unavailable'|'unknown'} LocationStatus
 */
export const LOCATION_STATUS = Object.freeze({
  ACQUIRED: 'acquired',
  DISABLED: 'disabled',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
  SKIPPED: 'skipped',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
})

const COORDINATE_SOURCES = new Set([
  LOCATION_SOURCE.DEVICE_GPS,
  LOCATION_SOURCE.IMAGE_EXIF,
  LOCATION_SOURCE.MANUAL,
  LOCATION_SOURCE.UNKNOWN,
])
const NO_COORDINATE_SOURCES = new Set([LOCATION_SOURCE.NONE, LOCATION_SOURCE.UNKNOWN])
// Session acquisition outcomes worth preserving when the user continues
// without coordinates. `skipped` is a save decision, never a session outcome.
const SESSION_OUTCOMES = new Set([
  LOCATION_STATUS.DISABLED,
  LOCATION_STATUS.DENIED,
  LOCATION_STATUS.TIMEOUT,
  LOCATION_STATUS.UNAVAILABLE,
  LOCATION_STATUS.UNKNOWN,
])
const NO_COORDINATE_STATUSES = new Set([...SESSION_OUTCOMES, LOCATION_STATUS.SKIPPED])
const LOCATION_SOURCE_VALUES = new Set(Object.values(LOCATION_SOURCE))
const LOCATION_STATUS_VALUES = new Set(Object.values(LOCATION_STATUS))

export const SET_OBSERVATION_LOCATION_RPC = 'set_observation_location'

/** @returns {LocationSource|null} */
export function normalizeLocationSource(value) {
  return typeof value === 'string' && LOCATION_SOURCE_VALUES.has(value) ? value : null
}

/** @returns {LocationStatus|null} */
export function normalizeLocationStatus(value) {
  return typeof value === 'string' && LOCATION_STATUS_VALUES.has(value) ? value : null
}

/**
 * Keep only a status that may be carried as the current session's outcome.
 * @returns {LocationStatus|null}
 */
export function normalizeSessionLocationOutcome(value) {
  return typeof value === 'string' && SESSION_OUTCOMES.has(value) ? value : null
}

/**
 * Map a classified geo.js error (`kind`) to a session outcome. Returns null
 * for anything that is not an acquisition failure.
 * @param {{ kind?: string }|null|undefined} error
 * @returns {LocationStatus|null}
 */
export function locationOutcomeFromGeoError(error) {
  switch (String(error?.kind || '')) {
    case 'permission-denied': return LOCATION_STATUS.DENIED
    case 'disabled': return LOCATION_STATUS.DISABLED
    case 'timeout': return LOCATION_STATUS.TIMEOUT
    case 'position-unavailable':
    case 'unsupported':
    case 'invalid-fix':
      return LOCATION_STATUS.UNAVAILABLE
    case 'error': return LOCATION_STATUS.UNKNOWN
    default: return null
  }
}

function _hasCoordinates(lat, lon) {
  const nextLat = Number(lat)
  const nextLon = Number(lon)
  return lat != null && lon != null
    && Number.isFinite(nextLat) && Number.isFinite(nextLon)
    && nextLat >= -90 && nextLat <= 90 && nextLon >= -180 && nextLon <= 180
}

/**
 * Mirror of the server CHECK: a complete pair compatible with the resulting
 * coordinate bundle. Used before every write so a provenance mistake can never
 * make an otherwise valid insert fail (and block the upload queue).
 */
export function isCompatibleLocationProvenance(bundle, source, status) {
  const lat = bundle?.gps_latitude ?? null
  const lon = bundle?.gps_longitude ?? null
  if (status === LOCATION_STATUS.ACQUIRED) {
    return COORDINATE_SOURCES.has(source) && _hasCoordinates(lat, lon)
  }
  return NO_COORDINATE_SOURCES.has(source)
    && NO_COORDINATE_STATUSES.has(status)
    && lat == null && lon == null
    && (bundle?.gps_altitude ?? null) == null
    && (bundle?.gps_accuracy ?? null) == null
}

/**
 * Decide the pair for a save, following the frozen transitions.
 *
 * - Selected coordinates: their own source (unknown if unclassified) + acquired.
 * - `decision: 'disabled'`: location preference disabled at save → none/disabled.
 * - `decision: 'continue'`: the user continued without coordinates → the
 *   session's latest meaningful outcome, or skipped when none was observed.
 * - No decision observed (e.g. an import whose acquisition was never
 *   observed): null, stored as a NULL pair.
 *
 * @param {{ gps?: { lat: number, lon: number, source?: string }|null, decision?: 'disabled'|'continue'|null, sessionOutcome?: string|null }} input
 * @returns {{ source: LocationSource, status: LocationStatus } | null}
 */
export function resolveSaveLocationProvenance({ gps = null, decision = null, sessionOutcome = null } = {}) {
  if (gps && _hasCoordinates(gps.lat, gps.lon)) {
    const source = normalizeLocationSource(gps.source)
    return {
      source: source && COORDINATE_SOURCES.has(source) ? source : LOCATION_SOURCE.UNKNOWN,
      status: LOCATION_STATUS.ACQUIRED,
    }
  }
  if (decision === 'disabled') {
    return { source: LOCATION_SOURCE.NONE, status: LOCATION_STATUS.DISABLED }
  }
  if (decision === 'continue') {
    return {
      source: LOCATION_SOURCE.NONE,
      status: normalizeSessionLocationOutcome(sessionOutcome) || LOCATION_STATUS.SKIPPED,
    }
  }
  return null
}

/**
 * Attach the pair to an observation insert payload, atomically with its
 * coordinates. An absent or incompatible pair removes both fields so the row
 * stores NULL/NULL rather than a guessed or rejected value.
 */
export function applyLocationProvenanceToPayload(payload, provenance) {
  if (!payload || typeof payload !== 'object') return payload
  const source = normalizeLocationSource(provenance?.source)
  const status = normalizeLocationStatus(provenance?.status)
  if (source && status && isCompatibleLocationProvenance(payload, source, status)) {
    payload.location_source = source
    payload.location_status = status
  } else {
    delete payload.location_source
    delete payload.location_status
  }
  return payload
}

/**
 * Queue-side guard for persisted payloads: keep a complete compatible pair,
 * otherwise drop both fields (legacy items carry neither).
 */
export function sanitizeQueuedLocationProvenance(payload) {
  if (!payload || typeof payload !== 'object') return payload
  if (payload.location_source === undefined && payload.location_status === undefined) return payload
  return applyLocationProvenanceToPayload(payload, {
    source: payload.location_source,
    status: payload.location_status,
  })
}

/** Strip the pair for targets whose schema predates the provenance migration. */
export function withoutLocationProvenance(payload) {
  const { location_source: _source, location_status: _status, ...rest } = payload || {}
  return rest
}

/**
 * Whether a PostgREST/Postgres error says the provenance columns or the aware
 * RPC do not exist on the target yet.
 */
export function isMissingLocationProvenanceError(error) {
  const code = String(error?.code || '')
  const text = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase()
  if (code === 'PGRST202' || code === '42883') {
    return text.includes(SET_OBSERVATION_LOCATION_RPC)
  }
  if (code === 'PGRST204' || code === '42703') {
    return text.includes('location_source') || text.includes('location_status')
  }
  return false
}

/**
 * Build the complete seven-argument `set_observation_location` request, or
 * null when the bundle/pair is invalid. Clearing coordinates is none/skipped.
 */
export function buildSetObservationLocationArgs({
  observationId,
  lat = null,
  lon = null,
  altitude = null,
  accuracy = null,
  source,
  status,
} = {}) {
  if (observationId == null || observationId === '') return null
  const bundle = {
    gps_latitude: lat == null ? null : Number(lat),
    gps_longitude: lon == null ? null : Number(lon),
    gps_altitude: altitude == null || !Number.isFinite(Number(altitude)) ? null : Number(altitude),
    gps_accuracy: accuracy == null || !Number.isFinite(Number(accuracy)) ? null : Number(accuracy),
  }
  const normalizedSource = normalizeLocationSource(source)
  const normalizedStatus = normalizeLocationStatus(status)
  if (!normalizedSource || !normalizedStatus) return null
  if (!isCompatibleLocationProvenance(bundle, normalizedSource, normalizedStatus)) return null
  return {
    p_observation_id: observationId,
    p_gps_latitude: bundle.gps_latitude,
    p_gps_longitude: bundle.gps_longitude,
    p_gps_altitude: bundle.gps_altitude,
    p_gps_accuracy: bundle.gps_accuracy,
    p_location_source: normalizedSource,
    p_location_status: normalizedStatus,
  }
}

/**
 * Aware coordinate change through the owner/RLS-enforced server operation.
 * Only when the target predates the migration (RPC missing) does it fall back
 * to a plain coordinate update, which stores no provenance. Any other error is
 * returned unchanged — never retried as a legacy write.
 *
 * @returns {Promise<{ error: unknown, legacyFallback: boolean }>}
 */
export async function setObservationLocation(client, request) {
  const args = buildSetObservationLocationArgs(request)
  if (!args) return { error: new Error('Invalid location/provenance combination'), legacyFallback: false }
  const { error } = await client.rpc(SET_OBSERVATION_LOCATION_RPC, args)
  if (!error) return { error: null, legacyFallback: false }
  if (!isMissingLocationProvenanceError(error) || request?.userId == null) {
    return { error, legacyFallback: false }
  }
  const { error: legacyError } = await client
    .from('observations')
    .update({
      gps_latitude: args.p_gps_latitude,
      gps_longitude: args.p_gps_longitude,
      gps_altitude: args.p_gps_altitude,
      gps_accuracy: args.p_gps_accuracy,
    })
    .eq('id', args.p_observation_id)
    .eq('user_id', request.userId)
  return { error: legacyError || null, legacyFallback: true }
}

/**
 * Tag a GPS object with the source it came from (shallow copy).
 * @returns {object|null}
 */
export function withLocationSource(gps, source) {
  if (!gps) return null
  return { ...gps, source: normalizeLocationSource(source) || LOCATION_SOURCE.UNKNOWN }
}

/**
 * Source of GPS read from a photo's own EXIF. Sporely Cam writes GPS EXIF only
 * from the location Sporely handed it, so its EXIF carries that location's
 * source, not independent image-origin GPS.
 */
export function exifGpsSourceForIngest(ingestMethod, writtenGpsSource = null) {
  if (ingestMethod === 'sporely_camera') {
    return normalizeLocationSource(writtenGpsSource) || LOCATION_SOURCE.UNKNOWN
  }
  return LOCATION_SOURCE.IMAGE_EXIF
}

/**
 * A photo's own EXIF GPS as a tagged GPS object, or null when unusable.
 * @param {{ lat?: unknown, lon?: unknown, altitude?: unknown, accuracy?: unknown }|null} exif
 */
export function photoExifGps(exif, source) {
  if (!exif || !_hasCoordinates(exif.lat, exif.lon)) return null
  const lat = Number(exif.lat)
  const lon = Number(exif.lon)
  if (Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001) return null
  const altitude = Number(exif.altitude)
  const accuracy = Number(exif.accuracy)
  return {
    lat,
    lon,
    altitude: exif.altitude != null && Number.isFinite(altitude) ? altitude : null,
    accuracy: exif.accuracy != null && Number.isFinite(accuracy) ? accuracy : null,
    source: normalizeLocationSource(source) || LOCATION_SOURCE.UNKNOWN,
  }
}

/**
 * Late original-EXIF hydration for one live review photo. Usable GPS becomes
 * that photo's GPS (with its EXIF source) unless the photo already carries its
 * own EXIF GPS; canonical selection at save then decides whether it wins
 * against the session fix. Resolves once applied; never rejects.
 * @returns {Promise<boolean>|null} whether the photo GPS changed
 */
export function attachLatePhotoExifGps(photo, metadataPromise, source) {
  if (!photo || !metadataPromise || typeof metadataPromise.then !== 'function') return null
  return Promise.resolve(metadataPromise).then(metadata => {
    if (photo.gpsFromExif === true) return false
    const gps = photoExifGps(metadata, source)
    if (!gps) return false
    photo.gps = gps
    photo.gpsFromExif = true
    return true
  }, () => false)
}
