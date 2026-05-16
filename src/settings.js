import { VISIBILITY_PUBLIC, normalizeVisibility as normalizeUiVisibility } from './visibility.js'

const DEFAULT_VISIBILITY_KEY = 'sporely-default-visibility'
const DEFAULT_ID_SERVICE_KEY = 'sporely-default-id-service'
const PHOTO_ID_MODE_KEY = 'sporely-photo-id-mode'
const USE_SYSTEM_CAMERA_KEY = 'sporely-use-system-camera'
const LAST_SYNC_AT_KEY = 'sporely-last-sync-at'
const ARTSORAKEL_MAX_EDGE_KEY = 'sporely-artsorakel-max-edge'
const PHOTO_GAP_MINUTES_KEY = 'sporely-photo-gap'
const DEFAULT_ARTSORAKEL_MAX_EDGE = 500
export const ID_SERVICE_ARTSORAKEL = 'artsorakel'
export const ID_SERVICE_INATURALIST = 'inat'
export const PHOTO_ID_MODE_AUTO = 'auto'
export const PHOTO_ID_MODE_ARTSORAKEL = 'artsorakel'
export const PHOTO_ID_MODE_INATURALIST = 'inat'
export const PHOTO_ID_MODE_BOTH = 'both'
export const NATIVE_CAMERA_JPEG_QUALITY = 75

const NORDIC_COUNTRY_CODES = new Set(['no', 'se', 'dk', 'fi', 'is', 'fo', 'gl', 'ax'])
const COUNTRY_NAME_TO_CODE = new Map([
  ['norway', 'no'],
  ['norge', 'no'],
  ['sweden', 'se'],
  ['sverige', 'se'],
  ['denmark', 'dk'],
  ['danmark', 'dk'],
  ['finland', 'fi'],
  ['iceland', 'is'],
  ['island', 'is'],
  ['faroe islands', 'fo'],
  ['færøerne', 'fo'],
  ['faeroe islands', 'fo'],
  ['greenland', 'gl'],
  ['gronland', 'gl'],
  ['grønland', 'gl'],
  ['aland', 'ax'],
  ['aaland', 'ax'],
  ['åland', 'ax'],
])
const LOCALE_HINTS = new Set(['nb', 'no', 'nn', 'sv', 'da'])

function _normalizeHintText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function _normalizeLocaleHint(value) {
  const normalized = _normalizeHintText(value)
  if (!normalized) return ''
  return normalized.split(/[_-]/, 1)[0]
}

function _normalizeCountryCodeHint(value) {
  const normalized = _normalizeHintText(value)
  if (!normalized) return ''
  if (NORDIC_COUNTRY_CODES.has(normalized)) return normalized
  return COUNTRY_NAME_TO_CODE.get(normalized) || ''
}

function _isNordicCountryCode(value) {
  return NORDIC_COUNTRY_CODES.has(_normalizeCountryCodeHint(value))
}

export function normalizeArtsorakelMaxEdge(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed)
    ? Math.max(100, Math.min(4000, parsed))
    : DEFAULT_ARTSORAKEL_MAX_EDGE
}

export function getArtsorakelMaxEdge() {
  try {
    return normalizeArtsorakelMaxEdge(localStorage.getItem(ARTSORAKEL_MAX_EDGE_KEY))
  } catch (_) {
    return typeof window === 'undefined' ? 1024 : DEFAULT_ARTSORAKEL_MAX_EDGE
  }
}

export function setArtsorakelMaxEdge(value) {
  try {
    localStorage.setItem(ARTSORAKEL_MAX_EDGE_KEY, String(normalizeArtsorakelMaxEdge(value)))
  } catch (_) {}
}

export function normalizePhotoGapMinutes(value) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed)
    ? Math.max(10 / 60, Math.min(120, parsed))
    : 1
}

export function getPhotoGapMinutes() {
  try {
    return normalizePhotoGapMinutes(localStorage.getItem(PHOTO_GAP_MINUTES_KEY))
  } catch (_) {
    return 1
  }
}

export function setPhotoGapMinutes(value) {
  const normalized = normalizePhotoGapMinutes(value)
  try {
    localStorage.setItem(PHOTO_GAP_MINUTES_KEY, String(normalized))
  } catch (_) {}
  return normalized
}

export function normalizeVisibility(value) {
  return normalizeUiVisibility(value, VISIBILITY_PUBLIC)
}

export function getDefaultVisibility() {
  return VISIBILITY_PUBLIC
}

export function setDefaultVisibility(value) {
  try {
    localStorage.setItem(DEFAULT_VISIBILITY_KEY, normalizeVisibility(value))
  } catch (_) {}
}

export function normalizeIdentifyService(value) {
  return String(value || '').trim() === ID_SERVICE_INATURALIST
    ? ID_SERVICE_INATURALIST
    : ID_SERVICE_ARTSORAKEL
}

export function normalizePhotoIdMode(value) {
  const normalized = _normalizeHintText(value)
  if (normalized === PHOTO_ID_MODE_AUTO) return PHOTO_ID_MODE_AUTO
  if (normalized === PHOTO_ID_MODE_ARTSORAKEL) return PHOTO_ID_MODE_ARTSORAKEL
  if (normalized === PHOTO_ID_MODE_INATURALIST || normalized === 'inaturalist') return PHOTO_ID_MODE_INATURALIST
  if (normalized === PHOTO_ID_MODE_BOTH) return PHOTO_ID_MODE_BOTH
  if (normalized === ID_SERVICE_ARTSORAKEL) return PHOTO_ID_MODE_ARTSORAKEL
  if (normalized === ID_SERVICE_INATURALIST) return PHOTO_ID_MODE_INATURALIST
  return PHOTO_ID_MODE_AUTO
}

export function getPhotoIdMode() {
  try {
    const stored = localStorage.getItem(PHOTO_ID_MODE_KEY)
    if (stored != null) return normalizePhotoIdMode(stored)

    const legacyService = localStorage.getItem(DEFAULT_ID_SERVICE_KEY)
    if (legacyService != null) {
      const migrated = normalizePhotoIdMode(legacyService)
      localStorage.setItem(PHOTO_ID_MODE_KEY, migrated)
      return migrated
    }
  } catch (_) {}
  return PHOTO_ID_MODE_AUTO
}

export function setPhotoIdMode(value) {
  const normalized = normalizePhotoIdMode(value)
  try {
    localStorage.setItem(PHOTO_ID_MODE_KEY, normalized)
  } catch (_) {}
  return normalized
}

function _resolvePrimaryPhotoIdService({
  mode = PHOTO_ID_MODE_AUTO,
  countryCode = '',
  countryName = '',
  locale = '',
  inaturalistAvailable = false,
} = {}) {
  const normalizedMode = normalizePhotoIdMode(mode)
  const normalizedCountry = _normalizeCountryCodeHint(countryCode || countryName)
  const localeHint = _normalizeLocaleHint(locale)
  const nordicHint = _isNordicCountryCode(normalizedCountry)
    || (!normalizedCountry && LOCALE_HINTS.has(localeHint))

  if (normalizedMode === PHOTO_ID_MODE_ARTSORAKEL) return ID_SERVICE_ARTSORAKEL
  if (normalizedMode === PHOTO_ID_MODE_INATURALIST) return ID_SERVICE_INATURALIST
  if (normalizedMode === PHOTO_ID_MODE_BOTH) {
    return nordicHint || !inaturalistAvailable ? ID_SERVICE_ARTSORAKEL : ID_SERVICE_INATURALIST
  }

  if (nordicHint) return ID_SERVICE_ARTSORAKEL
  return inaturalistAvailable ? ID_SERVICE_INATURALIST : ID_SERVICE_ARTSORAKEL
}

export function resolvePhotoIdServices({
  mode,
  countryCode,
  countryName,
  lat,
  lon,
  locale,
  inaturalistAvailable,
  comparisonRequested = false,
} = {}) {
  const normalizedMode = normalizePhotoIdMode(mode)
  const inatAvailable = !!inaturalistAvailable
  const primary = _resolvePrimaryPhotoIdService({
    mode: normalizedMode,
    countryCode,
    countryName,
    locale,
    inaturalistAvailable: inatAvailable,
  })
  const other = primary === ID_SERVICE_ARTSORAKEL ? ID_SERVICE_INATURALIST : ID_SERVICE_ARTSORAKEL
  const available = {
    [ID_SERVICE_ARTSORAKEL]: true,
    [ID_SERVICE_INATURALIST]: inatAvailable,
  }
  const disabledReason = {
    [ID_SERVICE_ARTSORAKEL]: null,
    [ID_SERVICE_INATURALIST]: inatAvailable ? null : 'login_required',
  }

  let run = [primary]
  if (normalizedMode === PHOTO_ID_MODE_BOTH) {
    run = inatAvailable
      ? [primary, other]
      : [ID_SERVICE_ARTSORAKEL]
  } else if (comparisonRequested && available[other]) {
    run = [primary, other]
  }

  if (normalizedMode === PHOTO_ID_MODE_INATURALIST && !inatAvailable) {
    run = []
  }

  return {
    mode: normalizedMode,
    primary,
    run,
    available,
    disabledReason,
    countryCode: _normalizeCountryCodeHint(countryCode || countryName) || null,
    locale: _normalizeLocaleHint(locale) || '',
    lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
    lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
  }
}

export function getDefaultIdService() {
  return resolvePhotoIdServices({ mode: getPhotoIdMode() }).primary
}

export function setDefaultIdService(value) {
  const normalized = normalizeIdentifyService(value)
  try {
    localStorage.setItem(DEFAULT_ID_SERVICE_KEY, normalized)
  } catch (_) {}
  setPhotoIdMode(normalized)
}

export function getUseSystemCamera() {
  try {
    return localStorage.getItem(USE_SYSTEM_CAMERA_KEY) === '1'
  } catch (_) {
    return false
  }
}

export function setUseSystemCamera(enabled) {
  try {
    localStorage.setItem(USE_SYSTEM_CAMERA_KEY, enabled ? '1' : '0')
  } catch (_) {}
}

export function getLastSyncAt() {
  try {
    const value = localStorage.getItem(LAST_SYNC_AT_KEY)
    const date = value ? new Date(value) : null
    return date && !Number.isNaN(date.getTime()) ? date : null
  } catch (_) {
    return null
  }
}

export function setLastSyncAt(value = new Date()) {
  try {
    const date = value instanceof Date ? value : new Date(value)
    if (!Number.isNaN(date.getTime())) {
      localStorage.setItem(LAST_SYNC_AT_KEY, date.toISOString())
    }
  } catch (_) {}
}

export function isProbablyCellularConnection() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  const type = String(connection?.type || '').toLowerCase()
  if (type === 'cellular') return true
  if (type && type !== 'unknown' && type !== 'none') return false

  const effectiveType = String(connection?.effectiveType || '').toLowerCase()
  return effectiveType === 'slow-2g' || effectiveType === '2g'
}

export function canSyncOnCurrentConnection() {
  return true // Always sync, removed mobile data toggle constraint
}

export function onConnectionTypeChange(callback) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (!connection?.addEventListener) return () => {}
  connection.addEventListener('change', callback)
  return () => connection.removeEventListener?.('change', callback)
}
