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
 */

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
 * @property {Array<Object>} imageMeta
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
  const altitude = Number(value.altitude)
  const accuracy = Number(value.accuracy)
  return {
    ...coords,
    altitude: Number.isFinite(altitude) ? altitude : null,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
  }
}
