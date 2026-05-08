import { Capacitor, registerPlugin } from '@capacitor/core'
import { FilePicker } from '@capawesome/capacitor-file-picker'
import { isAndroidNativeApp } from '../camera-actions.js'
import { isUsableCoordinate } from './review.js'
import { createImageCropMeta } from '../image_crop.js'

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

export async function nativePickedPhotoToFile(photo, index) {
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
  return new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  })
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
    const num = Number(value)
    return Number.isFinite(num) ? num : null
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

function _withHemisphere(value, ref, negativeRef) {
  if (value === null) return null
  const normalized = String(ref || '').trim().toUpperCase()
  if (normalized === negativeRef) return -Math.abs(value)
  return Math.abs(value)
}

function _extractLatLonFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return { lat: null, lon: null }

  let lat = rawGps.latitude
  let lon = rawGps.longitude

  if (lat == null) lat = _withHemisphere(_toDecimalDegrees(rawGps.GPSLatitude), rawGps.GPSLatitudeRef, 'S')
  if (lon == null) lon = _withHemisphere(_toDecimalDegrees(rawGps.GPSLongitude), rawGps.GPSLongitudeRef, 'W')

  lat = _coerceExifNumber(lat)
  lon = _coerceExifNumber(lon)
  if (!isUsableCoordinate(lat, lon)) return { lat: null, lon: null }
  return { lat, lon }
}

function _extractAltitudeFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null
  const candidates = [rawGps.altitude, rawGps.GPSAltitude, rawGps.GpsAltitude]
  let altitude = null
  for (const candidate of candidates) {
    altitude = _coerceExifNumber(candidate)
    if (altitude !== null) break
  }
  if (!Number.isFinite(altitude)) return null
  const ref = _coerceExifNumber(rawGps.GPSAltitudeRef ?? rawGps.GpsAltitudeRef)
  return ref === 1 ? -Math.abs(altitude) : altitude
}

function _extractAccuracyFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null
  const candidates = [rawGps.GPSHPositioningError, rawGps.accuracy]
  let accuracy = null
  for (const candidate of candidates) {
    accuracy = _coerceExifNumber(candidate)
    if (accuracy !== null && accuracy > 0) break
  }
  if (!Number.isFinite(accuracy)) return null
  return accuracy
}

export async function captureNativePhotoExif(photo, file) {
  let time = file.lastModified || Date.now()
  let lat = null
  let lon = null
  let altitude = null
  let accuracy = null
  const dbg = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    nativePath: photo?.path || null,
    nativeMimeType: photo?.mimeType || null,
  }

  if (photo?.exif && typeof photo.exif === 'object') {
    dbg.nativeExif = JSON.stringify(photo.exif)
    const rawNativeGps = _extractLatLonFromRawGps(photo.exif)
    if (rawNativeGps.lat !== null) lat = rawNativeGps.lat
    if (rawNativeGps.lon !== null) lon = rawNativeGps.lon
    altitude = _extractAltitudeFromRawGps(photo.exif)
    accuracy = _extractAccuracyFromRawGps(photo.exif)

    const dt = _coerceExifDate(photo.exif.DateTimeOriginal || photo.exif.CreateDate || photo.exif.ModifyDate || photo.capturedAt)
    if (dt) time = dt.getTime()
    return { time, lat, lon, altitude, accuracy, dbg }
  }

  try {
    const exif = window.Capacitor?.Plugins?.FilePicker?.getExif ? await FilePicker.getExif({ path: photo.path }) : null
    if (exif) {
      dbg.nativeExif = JSON.stringify(exif)
      const rawNativeGps = _extractLatLonFromRawGps(exif)
      if (rawNativeGps.lat !== null) lat = rawNativeGps.lat
      if (rawNativeGps.lon !== null) lon = rawNativeGps.lon
      altitude = _extractAltitudeFromRawGps(exif)
      accuracy = _extractAccuracyFromRawGps(exif)

      const dt = _coerceExifDate(exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || photo.capturedAt)
      if (dt) time = dt.getTime()

      if (lat !== null && lon !== null) {
        return { time, lat, lon, altitude, accuracy, dbg }
      }
    }
  } catch (err) {
    console.warn('Native EXIF extraction failed, trying JS fallback:', err)
  }

  try {
    const jsExif = await captureExif(file)
    if (jsExif.lat !== null) lat = jsExif.lat
    if (jsExif.lon !== null) lon = jsExif.lon
    if (jsExif.altitude !== null) altitude = jsExif.altitude
    if (jsExif.accuracy !== null) accuracy = jsExif.accuracy
    if (jsExif.time) time = jsExif.time
    dbg.jsFallback = true
  } catch (err) {
    console.warn('JS EXIF extraction fallback failed:', err)
  }

  return { time, lat, lon, altitude, accuracy, dbg }
}

function _shouldHydrateNativeMetadata(photo, file) {
  if (!isAndroidNativeApp()) return false
  if (!photo?.originalPath) return false
  if (photo.originalPath === photo.path && !_isHeicLike(file)) return false
  const rawGps = _extractLatLonFromRawGps(photo.exif)
  return rawGps.lat === null || rawGps.lon === null
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
  return /\.(heic|heif)$/i.test(file?.name || '') || /heic|heif/i.test(file?.type || '')
}

export async function captureExif(file) {
  const exifr = await _getExifr()
  let time = file.lastModified
  let lat = null
  let lon = null
  let altitude = null
  let accuracy = null
  let dbg = { fileName: file.name, fileSize: file.size, fileType: file.type, bufSize: 0, gpsResult: null, gpsError: null, exifError: null }
  const fullRead = _isHeicLike(file) ? { chunked: false } : {}

  const setGps = (res) => {
    const nextLat = _coerceExifNumber(res?.latitude)
    const nextLon = _coerceExifNumber(res?.longitude)
    if (isUsableCoordinate(nextLat, nextLon)) {
      lat = nextLat
      lon = nextLon
    }
    const nextAltitude = _extractAltitudeFromRawGps(res)
    if (nextAltitude !== null) altitude = nextAltitude
    const nextAccuracy = _extractAccuracyFromRawGps(res)
    if (nextAccuracy !== null) accuracy = nextAccuracy
  }

  let buf
  try {
    buf = await file.slice(0, 2 * 1024 * 1024).arrayBuffer()
    dbg.bufSize = buf.byteLength
  } catch (e) {
    dbg.bufError = String(e)
    return { time, lat, lon, altitude, dbg }
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
    setGps(gpsResult)
  } catch (e) {
    dbg.gpsBufferError = String(e)
  }

  if (lat === null) {
    try {
      const rawGps = await exifr.parse(buf, { pick: RAW_GPS_PICK, gps: true, tiff: true, reviveValues: false, translateValues: false })
      dbg.rawGpsBuffer = rawGps ? JSON.stringify(rawGps) : 'null'
      const extracted = _extractLatLonFromRawGps(rawGps)
      setGps({ ...rawGps, latitude: extracted.lat, longitude: extracted.lon })
    } catch (e) {
      dbg.rawGpsBufferError = String(e)
    }
  }

  return { time, lat, lon, altitude, accuracy, dbg }
}

export async function processFile(file, options = {}) {
  if (isAndroidNativeApp() && !!options.nativePhoto && file?.type === 'image/jpeg') {
    return { blob: file, aiBlob: file, meta: { aiCropRect: null, aiCropSourceW: null, aiCropSourceH: null } }
  }
  try {
    const { blob, aiBlob, metaSource } = await _prepareImportBlobs(file)
    const meta = await createImageCropMeta(metaSource || blob, { preseed: true })
    return { blob, aiBlob, meta }
  } catch (_) {}
  const meta = await createImageCropMeta(file, { preseed: true }).catch(() => ({ aiCropRect: null, aiCropSourceW: null, aiCropSourceH: null }))
  return { blob: file, aiBlob: file, meta }
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