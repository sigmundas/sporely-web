import { Capacitor, registerPlugin } from '@capacitor/core'
import { FilePicker } from '@capawesome/capacitor-file-picker'
import { isAndroidNativeApp } from '../camera-actions.js'
import { createImageCropMeta, getBlobImageDimensions } from '../image_crop.js'
import { debugImagePipeline, isImagePipelineDebugEnabled } from '../image-pipeline-debug.js'
import { normalizeCoordinatePair } from '../observation-shapes.js'

export const NativePhotoPicker = registerPlugin('NativePhotoPicker')
export const NativeCamera = registerPlugin('NativeCamera')

let exifrModulePromise = null
const IMPORT_AI_MAX_EDGE = 1920
const EXIF_DATETIME_PICK = ['DateTimeOriginal', 'CreateDate', 'ModifyDate']
const RAW_GPS_PICK = [
  'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef',
  'GPSAltitude', 'GPSAltitudeRef', 'GPSHPositioningError',
  'latitude', 'longitude', 'altitude',
]

export function isPickerCancel(err) {
  const message = String(err?.message || err || '').toLowerCase()
  return err?.name === 'AbortError' || err?.code === 'CANCELLED' || message.includes('cancel')
}

export async function pickImagesWithNativePhotoPicker() {
  try {
    await FilePicker.requestPermissions({ permissions: ['accessMediaLocation'] })
  } catch (error) {
    console.warn('Could not request media-location permission before import:', error)
  }
  return NativePhotoPicker.pickImages()
}

export async function nativePickedPhotoToFile(photo, index, options = {}) {
  let mimeType = normalizeNativeMimeType(photo?.mimeType, photo?.format)
  let path = photo.path

  if (mimeType === 'image/heic' || mimeType === 'image/heif' || photo?.format === 'heic' || photo?.format === 'heif') {
    try {
      if (window.Capacitor?.Plugins?.FilePicker?.convertHeicToJpeg) {
        const converted = await FilePicker.convertHeicToJpeg({ path })
        path = converted.path
        mimeType = 'image/jpeg'
      }
    } catch (e) {
      console.warn('Native HEIC conversion failed:', e)
    }
  }

  const url = Capacitor.convertFileSrc(normalizeNativePathForFetch(path))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not read native photo (${res.status})`)
  const blob = await res.blob()

  const fileName = guessNativeFileName(photo, index, mimeType)
  const file = new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  })
  if (isImagePipelineDebugEnabled()) {
    const dims = await getBlobImageDimensions(file).catch(() => null)
    debugImagePipeline('android native photo file', {
      captureSource: options.captureSource || null,
      screenPath: options.screenPath || null,
      sourceName: photo?.name || fileName,
      sourcePath: photo?.path || null,
      sourcePathType: describeNativePath(photo?.path),
      originalPath: photo?.originalPath || null,
      originalPathType: describeNativePath(photo?.originalPath),
      mimeType,
      format: photo?.format || null,
      originalMimeType: photo?.originalMimeType || null,
      originalFormat: photo?.originalFormat || null,
      convertedHeicToJpeg: mimeType === 'image/jpeg' && (photo?.format === 'heic' || photo?.format === 'heif' || photo?.originalFormat === 'heic' || photo?.originalFormat === 'heif'),
      decodedWidth: dims?.width ?? null,
      decodedHeight: dims?.height ?? null,
      nativeDebug: photo?.debug || null,
      nativePhoto: summarizeNativePhoto(photo, options),
    })
    debugImagePipeline('android native photo file ready', {
      captureSource: options.captureSource || null,
      screenPath: options.screenPath || null,
      fileName: file.name,
      fileType: file.type || null,
      fileSize: file.size || 0,
    })
  }
  return file
}

export function isHeicLikeFile(file) {
  return /\.(heic|heif)$/i.test(file?.name || '') || /heic|heif/i.test(file?.type || '')
}

function normalizeNativeMimeType(mimeType, format) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase()
  if (normalizedMime) return normalizedMime
  const normalizedFormat = String(format || '').trim().toLowerCase()
  if (normalizedFormat === 'jpg') return 'image/jpeg'
  if (normalizedFormat) return `image/${normalizedFormat}`
  return 'image/jpeg'
}

function normalizeNativePathForFetch(path) {
  const value = String(path || '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return value.startsWith('/') ? `file://${value}` : value
}

function guessNativeFileName(photo, index, mimeType) {
  const fromName = String(photo?.name || '').trim()
  if (fromName) return fromName
  const ext = mimeType === 'image/heic' ? '.heic'
    : mimeType === 'image/heif' ? '.heif'
    : mimeType === 'image/png' ? '.png'
    : '.jpg'
  return `native-import-${index + 1}${ext}`
}

function _coerceExifDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes(':') && value.includes(' ')
      ? value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
      : value
    const date = new Date(normalized)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

function _coerceExifNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const num = Number(trimmed)
    if (Number.isFinite(num)) return num
    const match = trimmed.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)
    if (!match) return null
    const parsed = Number(match[0])
    return Number.isFinite(parsed) ? parsed : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const num = _coerceExifNumber(item)
      if (num !== null) return num
    }
    return null
  }
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.numerator) && Number.isFinite(value.denominator) && value.denominator) {
      return value.numerator / value.denominator
    }
    if (Number.isFinite(value.num) && Number.isFinite(value.den) && value.den) {
      return value.num / value.den
    }
  }
  return null
}

function _toDecimalDegrees(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    const parts = value.map(_coerceExifNumber).filter(part => part !== null)
    if (!parts.length) return null
    if (parts.length === 1) return parts[0]
    if (parts.length === 2) return parts[0] + (parts[1] / 60)
    return parts[0] + (parts[1] / 60) + (parts[2] / 3600)
  }
  return _coerceExifNumber(value)
}

function _normalizeExifKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function _getRawGpsValue(rawGps, keys = []) {
  if (!rawGps || typeof rawGps !== 'object') return null
  const wanted = new Set(keys.map(_normalizeExifKey))
  for (const [key, value] of Object.entries(rawGps)) {
    if (!wanted.has(_normalizeExifKey(key))) continue
    if (value !== null && value !== undefined) return value
  }
  return null
}

function _withHemisphere(value, ref, negativeRef) {
  if (value === null) return null
  const normalized = String(ref || '').trim().toUpperCase()
  if (normalized === negativeRef) return -Math.abs(value)
  return Math.abs(value)
}

export function _extractLatLonFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return { lat: null, lon: null }

  const latValue = _getRawGpsValue(rawGps, ['latitude', 'GPSLatitude', 'Latitude', 'GpsLatitude', 'lat'])
  const lonValue = _getRawGpsValue(rawGps, ['longitude', 'GPSLongitude', 'Longitude', 'GpsLongitude', 'lon'])
  const latRef = _getRawGpsValue(rawGps, ['latitudeRef', 'GPSLatitudeRef', 'LatitudeRef', 'GpsLatitudeRef', 'latRef'])
  const lonRef = _getRawGpsValue(rawGps, ['longitudeRef', 'GPSLongitudeRef', 'LongitudeRef', 'GpsLongitudeRef', 'lonRef'])

  let lat = _toDecimalDegrees(latValue)
  let lon = _toDecimalDegrees(lonValue)

  if (lat == null) lat = _withHemisphere(_toDecimalDegrees(_getRawGpsValue(rawGps, ['GPSLatitude', 'Latitude', 'GpsLatitude'])), latRef, 'S')
  if (lon == null) lon = _withHemisphere(_toDecimalDegrees(_getRawGpsValue(rawGps, ['GPSLongitude', 'Longitude', 'GpsLongitude'])), lonRef, 'W')

  lat = _coerceExifNumber(lat)
  lon = _coerceExifNumber(lon)
  return normalizeCoordinatePair(lat, lon) || { lat: null, lon: null }
}

export function _extractAltitudeRefFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null
  const rawRef = _getRawGpsValue(rawGps, [
    'GPSAltitudeRef',
    'GpsAltitudeRef',
    'GPS Altitude Ref',
    'gpsAltitudeRef',
    'gps_altitude_ref',
    'AltitudeRef',
    'altitudeRef',
  ])
  if (rawRef === null || rawRef === undefined) return null
  if (Array.isArray(rawRef)) {
    for (const item of rawRef) {
      const next = _extractAltitudeRefFromRawGps({ GPSAltitudeRef: item })
      if (next !== null) return next
    }
    return null
  }
  if (typeof rawRef === 'number') {
    return rawRef === 0 || rawRef === 1 ? rawRef : null
  }
  if (typeof rawRef === 'string') {
    const normalized = rawRef.trim().toLowerCase()
    if (!normalized) return null
    const num = Number(normalized)
    if (Number.isFinite(num) && (num === 0 || num === 1)) return num
    if (normalized.includes('below')) return 1
    if (normalized.includes('above')) return 0
  }
  if (typeof rawRef === 'object') {
    return _extractAltitudeRefFromRawGps({
      GPSAltitudeRef: rawRef.value ?? rawRef.text ?? rawRef.description ?? rawRef.label ?? rawRef.ref ?? rawRef.altitudeRef ?? null,
    })
  }
  return null
}

export function _extractAltitudeFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null
  const altitudeValue = _getRawGpsValue(rawGps, [
    'altitude',
    'Altitude',
    'GPSAltitude',
    'GpsAltitude',
    'GPS Altitude',
    'gpsAltitude',
    'gps_altitude',
  ])
  const altitude = _coerceExifNumber(altitudeValue)
  if (!Number.isFinite(altitude)) return null
  const ref = _extractAltitudeRefFromRawGps(rawGps)
  return ref === 1 ? -Math.abs(altitude) : Math.abs(altitude)
}

export function _extractAccuracyFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null
  const accuracyValue = _getRawGpsValue(rawGps, [
    'GPSHPositioningError',
    'GpsHPositioningError',
    'GPS H Positioning Error',
    'gpsHPositioningError',
    'gps_h_positioning_error',
    'accuracy',
    'Accuracy',
  ])
  const accuracy = _coerceExifNumber(accuracyValue)
  if (!Number.isFinite(accuracy)) return null
  return accuracy
}

function _applyRawGpsCandidate(target, rawGps, sourceLabel, dbg) {
  if (!rawGps || typeof rawGps !== 'object') return
  const { lat, lon } = _extractLatLonFromRawGps(rawGps)
  if (lat !== null && target.lat === null) {
    target.lat = lat
    target.gpsSource = target.gpsSource || sourceLabel
  }
  if (lon !== null && target.lon === null) {
    target.lon = lon
    target.gpsSource = target.gpsSource || sourceLabel
  }

  const altitude = _extractAltitudeFromRawGps(rawGps)
  if (altitude !== null && target.altitude === null) {
    target.altitude = altitude
    target.altitudeSource = target.altitudeSource || sourceLabel
  }

  const accuracy = _extractAccuracyFromRawGps(rawGps)
  if (accuracy !== null && target.accuracy === null) {
    target.accuracy = accuracy
    target.gpsSource = target.gpsSource || sourceLabel
  }

  if (dbg && !dbg.gpsSource && (lat !== null || lon !== null || accuracy !== null)) {
    dbg.gpsSource = sourceLabel
  }
  if (dbg && !dbg.altitudeSource && altitude !== null) {
    dbg.altitudeSource = sourceLabel
  }
}

export async function captureNativePhotoExif(photo, file, options = {}) {
  let time = file.lastModified || Date.now()
  let lat = null
  let lon = null
  let altitude = null
  let accuracy = null
  let hasNativeTime = false
  const dbg = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    nativePath: photo?.path || null,
    nativePathType: describeNativePath(photo?.path),
    originalPath: photo?.originalPath || null,
    originalPathType: describeNativePath(photo?.originalPath),
    captureSource: options.captureSource || null,
    screenPath: options.screenPath || null,
    nativeMimeType: photo?.mimeType || null,
    altitudeSource: null,
    gpsSource: null,
    nativeExif: null,
    nativeDebug: null,
    nativePhoto: summarizeNativePhoto(photo, options),
    nativeExifOrientation: null,
    nativeExifPostOrientation: null,
    gpsResult: null,
    gpsFallback: null,
    rawGpsFile: null,
    rawGpsBuffer: null,
  }

  const target = {
    get lat() { return lat },
    set lat(value) { lat = value },
    get lon() { return lon },
    set lon(value) { lon = value },
    get altitude() { return altitude },
    set altitude(value) { altitude = value },
    get accuracy() { return accuracy },
    set accuracy(value) { accuracy = value },
    get gpsSource() { return dbg.gpsSource },
    set gpsSource(value) { dbg.gpsSource = value },
    get altitudeSource() { return dbg.altitudeSource },
    set altitudeSource(value) { dbg.altitudeSource = value },
  }

  if (photo?.exif && typeof photo.exif === 'object') {
    dbg.nativeExif = JSON.stringify(photo.exif)
    _applyRawGpsCandidate(target, photo.exif, 'nativeExif', dbg)
    dbg.nativeExifOrientation = _coerceExifNumber(photo?.debug?.preOrientation ?? photo.exif?.Orientation ?? null)
    dbg.nativeExifPostOrientation = _coerceExifNumber(photo?.debug?.postOrientation ?? photo.exif?.Orientation ?? null)
    if (photo?.debug) dbg.nativeDebug = JSON.stringify(photo.debug)

    const dt = _coerceExifDate(photo.exif.DateTimeOriginal || photo.exif.CreateDate || photo.exif.ModifyDate || photo.capturedAt)
    if (dt) {
      time = dt.getTime()
      hasNativeTime = true
    }
  }

  const nativeExifHasCoreMetadata = hasNativeTime && lat !== null && lon !== null
  const canUseFilePickerExif = !isAndroidNativeApp() && !!window.Capacitor?.Plugins?.FilePicker?.getExif

  if (!nativeExifHasCoreMetadata && canUseFilePickerExif) {
    try {
      const exif = await FilePicker.getExif({ path: photo.path })
      if (exif) {
        if (!dbg.nativeExif) dbg.nativeExif = JSON.stringify(exif)
        _applyRawGpsCandidate(target, exif, 'nativeExif', dbg)
        if (dbg.nativeExifOrientation === null) dbg.nativeExifOrientation = _coerceExifNumber(exif.Orientation ?? null)
        if (dbg.nativeExifPostOrientation === null) dbg.nativeExifPostOrientation = _coerceExifNumber(exif.Orientation ?? null)

        const dt = _coerceExifDate(exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || photo.capturedAt)
        if (dt) {
          time = dt.getTime()
          hasNativeTime = true
        }
      }
    } catch (err) {
      const message = String(err?.message || err || '')
      if (message.toLowerCase().includes('not implemented on android')) {
        if (isImagePipelineDebugEnabled()) {
          debugImagePipeline('filepicker getExif skipped on android', {
            captureSource: options.captureSource || null,
            screenPath: options.screenPath || null,
            sourcePath: photo?.path || null,
            sourcePathType: describeNativePath(photo?.path),
            reason: message,
          })
        }
      } else {
        console.warn('Native EXIF extraction failed, trying JS fallback:', err)
      }
    }
  }

  if (lat !== null && lon !== null && altitude !== null && accuracy !== null && hasNativeTime) {
    return { time, lat, lon, altitude, accuracy, dbg }
  }

  try {
    const jsExif = await captureExif(file)
    if (jsExif.lat !== null && lat === null) lat = jsExif.lat
    if (jsExif.lon !== null && lon === null) lon = jsExif.lon
    if (jsExif.altitude !== null && altitude === null) altitude = jsExif.altitude
    if (jsExif.accuracy !== null && accuracy === null) accuracy = jsExif.accuracy
    if (!hasNativeTime && jsExif.time) time = jsExif.time
    if (!dbg.gpsSource && jsExif.dbg?.gpsSource) dbg.gpsSource = `jsFallback:${jsExif.dbg.gpsSource}`
    if (!dbg.altitudeSource && jsExif.dbg?.altitudeSource) dbg.altitudeSource = `jsFallback:${jsExif.dbg.altitudeSource}`
    dbg.gpsResult = dbg.gpsResult || jsExif.dbg?.gpsResult || null
    dbg.gpsFallback = dbg.gpsFallback || jsExif.dbg?.gpsFallback || null
    dbg.rawGpsFile = dbg.rawGpsFile || jsExif.dbg?.rawGpsFile || null
    dbg.rawGpsBuffer = dbg.rawGpsBuffer || jsExif.dbg?.rawGpsBuffer || null
    dbg.jsFallback = true
  } catch (err) {
    console.warn('JS EXIF extraction fallback failed:', err)
  }

  if (isImagePipelineDebugEnabled()) {
    debugImagePipeline('android native photo exif', {
      captureSource: options.captureSource || null,
      screenPath: options.screenPath || null,
      sourceName: photo?.name || file.name || '',
      sourcePath: photo?.path || null,
      sourcePathType: describeNativePath(photo?.path),
      originalPath: photo?.originalPath || null,
      originalPathType: describeNativePath(photo?.originalPath),
      mimeType: photo?.mimeType || file.type || '',
      format: photo?.format || null,
      nativePhoto: summarizeNativePhoto(photo, options),
      nativeExifOrientation: dbg.nativeExifOrientation,
      nativeExifPostOrientation: dbg.nativeExifPostOrientation,
      nativeDebug: dbg.nativeDebug,
      nativeExif: dbg.nativeExif,
      nativePath: dbg.nativePath,
      fileName: file.name || '',
      fileType: file.type || '',
      fileSize: file.size || 0,
    })
  }

  return { time, lat, lon, altitude, accuracy, dbg }
}

function _shouldHydrateNativeMetadata(photo, file) {
  if (!isAndroidNativeApp()) return false
  if (!photo?.originalPath) return false
  if (photo.originalPath === photo.path && !_isHeicLike(file)) return false
  const rawGps = photo?.exif && typeof photo.exif === 'object' ? photo.exif : null
  const coords = _extractLatLonFromRawGps(rawGps)
  const altitude = _extractAltitudeFromRawGps(rawGps)
  const hasNativeTime = Boolean(_coerceExifDate(
    rawGps?.DateTimeOriginal || rawGps?.CreateDate || rawGps?.ModifyDate || photo?.capturedAt,
  ))
  return coords.lat === null || coords.lon === null || altitude === null || !hasNativeTime
}

export function createNativeMetadataHydrationPromise(photo, file) {
  if (!_shouldHydrateNativeMetadata(photo, file)) return null
  return _captureNativeOriginalExif(photo).catch(error => ({
    time: file.lastModified || Date.now(),
    lat: null,
    lon: null,
    altitude: null,
    accuracy: null,
    dbg: {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      nativePath: photo?.path || null,
      originalPath: photo?.originalPath || null,
      backgroundExifError: String(error),
    },
  }))
}

async function _captureNativeOriginalExif(photo) {
  const path = photo?.originalPath || photo?.path
  if (!path) throw new Error('Missing native original path')
  const mimeType = normalizeNativeMimeType(photo?.originalMimeType || photo?.mimeType, photo?.originalFormat || photo?.format)
  const url = Capacitor.convertFileSrc(normalizeNativePathForFetch(path))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not read native original photo (${res.status})`)
  const blob = await res.blob()
  const fileName = guessNativeFileName({
    name: photo?.name || '',
    mimeType,
    format: photo?.originalFormat || photo?.format,
  }, 0, mimeType)
  const originalFile = new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  })
  return captureExif(originalFile)
}

async function _getExifr() {
  if (!exifrModulePromise) {
    exifrModulePromise = import('exifr/dist/full.esm.mjs').then(module => module.default)
  }
  return exifrModulePromise
}

function _isHeicLike(file) {
  return isHeicLikeFile(file)
}

export async function captureExif(file) {
  const exifr = await _getExifr()
  let time = file.lastModified
  let lat = null
  let lon = null
  let altitude = null
  let accuracy = null
  let dbg = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    bufSize: 0,
    gpsResult: null,
    gpsFallback: null,
    rawGpsFile: null,
    rawGpsBuffer: null,
    altitudeSource: null,
    gpsSource: null,
    gpsError: null,
    exifError: null,
  }
  const fullRead = _isHeicLike(file) ? { chunked: false } : {}

  const target = {
    get lat() { return lat },
    set lat(value) { lat = value },
    get lon() { return lon },
    set lon(value) { lon = value },
    get altitude() { return altitude },
    set altitude(value) { altitude = value },
    get accuracy() { return accuracy },
    set accuracy(value) { accuracy = value },
    get gpsSource() { return dbg.gpsSource },
    set gpsSource(value) { dbg.gpsSource = value },
    get altitudeSource() { return dbg.altitudeSource },
    set altitudeSource(value) { dbg.altitudeSource = value },
  }

  try {
    const exif = await exifr.parse(file, { pick: EXIF_DATETIME_PICK, ...fullRead })
    const dt = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate
    if (dt instanceof Date) time = dt.getTime()
  } catch (_) {}

  try {
    const gpsResult = await exifr.gps(file, fullRead)
    dbg.gpsResult = gpsResult ? JSON.stringify(gpsResult) : 'null'
    _applyRawGpsCandidate(target, gpsResult, 'gpsResult', dbg)
  } catch (_) {}

  if (lat === null || lon === null || altitude === null || accuracy === null) {
    try {
      const fallback = await exifr.parse(file, { gps: true, tiff: true, xmp: true, ...fullRead })
      dbg.gpsFallback = fallback ? JSON.stringify(fallback) : 'null'
      _applyRawGpsCandidate(target, fallback, 'gpsFallback', dbg)
    } catch (_) {}
  }

  if (lat === null || lon === null || altitude === null || accuracy === null) {
    try {
      const rawGps = await exifr.parse(file, {
        pick: RAW_GPS_PICK,
        gps: true,
        tiff: true,
        reviveValues: false,
        translateValues: false,
        ...fullRead,
      })
      dbg.rawGpsFile = rawGps ? JSON.stringify(rawGps) : 'null'
      _applyRawGpsCandidate(target, rawGps, 'rawGpsFile', dbg)
    } catch (_) {}
  }

  if (lat !== null && lon !== null && altitude !== null && accuracy !== null) {
    return { time, lat, lon, altitude, accuracy, dbg }
  }

  let buf
  try {
    buf = await file.slice(0, 2 * 1024 * 1024).arrayBuffer()
    dbg.bufSize = buf.byteLength
  } catch (e) {
    dbg.bufError = String(e)
    return { time, lat, lon, altitude, accuracy, dbg }
  }

  try {
    const exif = await exifr.parse(buf, { pick: EXIF_DATETIME_PICK })
    const dt = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate
    if (dt instanceof Date) time = dt.getTime()
  } catch (e) {
    dbg.exifError = String(e)
  }

  try {
    const gpsResult = await exifr.gps(buf)
    dbg.gpsBufferResult = gpsResult ? JSON.stringify(gpsResult) : 'null'
    _applyRawGpsCandidate(target, gpsResult, 'gpsBufferResult', dbg)
  } catch (e) {
    dbg.gpsBufferError = String(e)
  }

  if (lat === null || lon === null || altitude === null || accuracy === null) {
    try {
      const rawGps = await exifr.parse(buf, {
        pick: RAW_GPS_PICK,
        gps: true,
        tiff: true,
        reviveValues: false,
        translateValues: false,
      })
      dbg.rawGpsBuffer = rawGps ? JSON.stringify(rawGps) : 'null'
      _applyRawGpsCandidate(target, rawGps, 'rawGpsBuffer', dbg)
    } catch (e) {
      dbg.rawGpsBufferError = String(e)
    }
  }

  return { time, lat, lon, altitude, accuracy, dbg }
}

export async function processFile(file, options = {}) {
  if (isAndroidNativeApp() && !!options.nativePhoto && file?.type === 'image/jpeg') {
    if (isImagePipelineDebugEnabled()) {
      debugImagePipeline('android native jpeg process', {
        captureSource: options.captureSource || options.nativePhoto?.captureSource || null,
        screenPath: options.screenPath || options.nativePhoto?.screenPath || null,
        sourceName: options.nativePhoto?.name || file.name || '',
        sourcePath: options.nativePhoto?.path || null,
        sourcePathType: describeNativePath(options.nativePhoto?.path),
        originalPath: options.nativePhoto?.originalPath || null,
        originalPathType: describeNativePath(options.nativePhoto?.originalPath),
        mimeType: options.nativePhoto?.mimeType || file.type || '',
        format: options.nativePhoto?.format || null,
        nativePhoto: summarizeNativePhoto(options.nativePhoto, options),
        nativeDebug: options.nativePhoto?.debug || null,
        fastPath: true,
        usedCanvas: false,
        stayedOriginal: true,
        fileName: file.name || '',
        fileType: file.type || '',
        fileSize: file.size || 0,
      })
    }
    return { blob: file, aiBlob: file, meta: { aiCropRect: null, aiCropSourceW: null, aiCropSourceH: null, aiCropIsCustom: false } }
  }
  try {
    const { blob, aiBlob, metaSource } = await _prepareImportBlobs(file)
    const meta = await createImageCropMeta(metaSource || blob, { preseed: true })
    return { blob, aiBlob, meta }
  } catch (_) {}
  const meta = await createImageCropMeta(file, { preseed: true }).catch(() => ({ aiCropRect: null, aiCropSourceW: null, aiCropSourceH: null, aiCropIsCustom: false }))
  return { blob: file, aiBlob: file, meta }
}

function describeNativePath(path) {
  const value = String(path || '').trim()
  if (!value) return null
  if (/^content:/i.test(value)) return 'content-uri'
  if (/^file:/i.test(value)) return 'file-uri'
  if (value.startsWith('/')) return 'file-path'
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'uri'
  return 'path'
}

function summarizeNativePhoto(photo = {}, options = {}) {
  return {
    name: photo?.name || null,
    path: photo?.path || null,
    pathType: describeNativePath(photo?.path),
    originalPath: photo?.originalPath || null,
    originalPathType: describeNativePath(photo?.originalPath),
    mimeType: photo?.mimeType || null,
    originalMimeType: photo?.originalMimeType || null,
    format: photo?.format || null,
    originalFormat: photo?.originalFormat || null,
    converted: photo?.converted === true,
    nativeOrientation: _coerceExifNumber(photo?.debug?.preOrientation ?? photo?.exif?.Orientation ?? null),
    nativePostOrientation: _coerceExifNumber(photo?.debug?.postOrientation ?? photo?.exif?.Orientation ?? null),
    captureSource: options.captureSource || null,
    screenPath: options.screenPath || null,
  }
}

function _prepareImportBlobs(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = async () => {
      try {
        const w = img.naturalWidth
        const h = img.naturalHeight
        if (!w || !h) { reject(new Error('format not supported')); return }
        const scale = Math.min(1, IMPORT_AI_MAX_EDGE / Math.max(w, h))
        const aiW = Math.max(1, Math.round(w * scale))
        const aiH = Math.max(1, Math.round(h * scale))
        const aiBlob = (aiW === w && aiH === h && file.type === 'image/jpeg') ? file : await _canvasToJpegBlob(img, aiW, aiH, 0.88)
        resolve({ blob: file, aiBlob, metaSource: file })
      } catch (error) { reject(error) } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')) }
    img.src = url
  })
}

function _canvasToJpegBlob(img, width, height, quality = 0.88) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) { reject(new Error('Canvas unavailable')); return }
    ctx.drawImage(img, 0, 0, width, height)
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/jpeg', quality)
  })
}
