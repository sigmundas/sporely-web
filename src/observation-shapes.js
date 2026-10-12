/**
 * Shared GPS point shape passed between capture, review, import review, and save code.
 *
 * @typedef {Object} ObservationGps
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} [altitude]
 * @property {number|null} [accuracy]
 */

/**
 * Shared image object shape passed between capture, review, import review,
 * queue, and upload code. The same entry may carry the original blob, the AI
 * blob, a queued upload blob, and optional crop metadata.
 *
 * @typedef {Object} ObservationImageEntry
 * @property {Blob|null} blob
 * @property {Blob|null} aiBlob
 * @property {Blob|null} originalBlob
 * @property {Blob|null} uploadBlob
 * @property {Object|null} aiCropRect
 * @property {number|null} aiCropSourceW
 * @property {number|null} aiCropSourceH
 * @property {boolean|null} aiCropIsCustom
 * @property {Object|null} uploadMeta
 * @property {{ thumb: Blob }|null} variants
 * @property {IngestMethod|null} ingestMethod
 */

/**
 * How a photo entered Sporely (`observation_images.ingest_method`). It is
 * assigned at the entry point that produced the photo and travels with that
 * photo's own object; it is never derived from screen, MIME, dimensions, EXIF,
 * filenames, current settings or debug labels. `null` means a historical or
 * pre-provenance entry (legacy drafts/queue items) and is stored as NULL.
 *
 * @typedef {'sporely_camera'|'system_camera'|'web_camera'|'native_picker'|'web_file_picker'|'unknown'} IngestMethod
 */
export const INGEST_METHOD = Object.freeze({
  SPORELY_CAMERA: 'sporely_camera',
  SYSTEM_CAMERA: 'system_camera',
  WEB_CAMERA: 'web_camera',
  NATIVE_PICKER: 'native_picker',
  WEB_FILE_PICKER: 'web_file_picker',
  UNKNOWN: 'unknown',
})

const INGEST_METHOD_VALUES = new Set(Object.values(INGEST_METHOD))

/**
 * Keep only a known ingest method; anything else (legacy undefined, garbage)
 * becomes null so it is stored as NULL rather than rejected by the server.
 * @param {unknown} value
 * @returns {IngestMethod|null}
 */
export function normalizeIngestMethod(value) {
  return typeof value === 'string' && INGEST_METHOD_VALUES.has(value) ? value : null
}

/**
 * Review-screen photo entry shape. Capture/review code keeps the original
 * blob, optional AI blob, blob hydration promise, timestamp, GPS, crop
 * metadata, and selected taxon together.
 *
 * @typedef {Object} ReviewPhotoEntry
 * @property {Blob|null} blob
 * @property {Blob|null} aiBlob
 * @property {Promise<Blob>|null} blobPromise
 * @property {ObservationGps|null} gps
 * @property {Date|number|null} ts
 * @property {string} emoji
 * @property {Object|null} aiCropRect
 * @property {number|null} aiCropSourceW
 * @property {number|null} aiCropSourceH
 * @property {boolean|null} aiCropIsCustom
 * @property {Object|null} taxon
 * @property {IngestMethod|null} ingestMethod
 */

/**
 * Import-review session shape. Sessions keep the decoded file blobs, AI blobs,
 * crop metadata, per-photo GPS, and any pending metadata hydration promises.
 *
 * @typedef {Object} ImportSession
 * @property {string} id
 * @property {Blob[]} files
 * @property {Blob[]} aiFiles
 * @property {string[]} blobUrls
 * @property {Array<Object>} imageMeta  per-photo crop metadata plus `ingestMethod`
 * @property {Array<Promise<Object>|null>} metadataPromises
 * @property {Array<number>} photoTimes
 * @property {Array<ObservationGps|null>} photoGps
 * @property {number|null} gpsLat
 * @property {number|null} gpsLon
 * @property {number|null} gpsAltitude
 * @property {number|null} gpsAccuracy
 */

/**
 * @param {unknown} value
 * @returns {value is Blob}
 */
export function isBlob(value) {
  return value instanceof Blob || (
    value
    && typeof value.size === 'number'
    && typeof value.type === 'string'
    && typeof value.arrayBuffer === 'function'
  )
}

/**
 * Shared GPS guard for capture/import/review coordinate values.
 * @param {unknown} lat
 * @param {unknown} lon
 * @returns {boolean}
 */
export function isUsableCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false
  return !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
}

/**
 * Normalize a coordinate pair to finite numbers when both values are usable.
 * @param {unknown} lat
 * @param {unknown} lon
 * @returns {{ lat: number, lon: number } | null}
 */
export function normalizeCoordinatePair(lat, lon) {
  const nextLat = Number(lat)
  const nextLon = Number(lon)
  return isUsableCoordinate(nextLat, nextLon) ? { lat: nextLat, lon: nextLon } : null
}

/**
 * Normalize a GPS-like object at the final save/enqueue boundary.
 * @param {unknown} value
 * @returns {ObservationGps | null}
 */
export function normalizeObservationGps(value) {
  if (!value || typeof value !== 'object') return null
  const coords = normalizeCoordinatePair(
    value.lat ?? value.latitude ?? value.gps_latitude,
    value.lon ?? value.longitude ?? value.gps_longitude,
  )
  if (!coords) return null
  return {
    ...coords,
    altitude: optionalFiniteNumber(value.altitude),
    accuracy: optionalFiniteNumber(value.accuracy),
  }
}

/**
 * A measured number, or null when absent. `Number(null)` is 0, which would
 * turn an unmeasured accuracy into "perfect" and an unknown altitude into sea
 * level.
 * @param {unknown} value
 * @returns {number|null}
 */
export function optionalFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Check whether an observation has either a human-readable location or usable GPS coordinates.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasObservationLocation(value) {
  if (!value || typeof value !== 'object') return false
  const location = String(value.location ?? value.locationName ?? '').trim()
  if (location) return true
  const lat = Number(value.lat ?? value.latitude ?? value.gps_latitude ?? value.gpsLat)
  const lon = Number(value.lon ?? value.longitude ?? value.gps_longitude ?? value.gpsLon)
  return isUsableCoordinate(lat, lon)
}
