const DEFAULT_VISIBILITY_KEY = 'sporely-default-visibility'
const USE_SYSTEM_CAMERA_KEY = 'sporely-use-system-camera'
const LAST_SYNC_AT_KEY = 'sporely-last-sync-at'
const ARTSORAKEL_MAX_EDGE_KEY = 'sporely-artsorakel-max-edge'
const PHOTO_GAP_MINUTES_KEY = 'sporely-photo-gap'
const DEFAULT_ARTSORAKEL_MAX_EDGE = 500
export const NATIVE_CAMERA_JPEG_QUALITY = 75

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
    return DEFAULT_ARTSORAKEL_MAX_EDGE
  }
}

export function setArtsorakelMaxEdge(value) {
  try {
    localStorage.setItem(ARTSORAKEL_MAX_EDGE_KEY, String(normalizeArtsorakelMaxEdge(value)))
  } catch (_) {}
}

export function normalizePhotoGapMinutes(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(120, parsed))
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
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'private' || normalized === 'public' ? normalized : 'friends'
}

export function getDefaultVisibility() {
  try {
    return normalizeVisibility(localStorage.getItem(DEFAULT_VISIBILITY_KEY))
  } catch (_) {
    return 'friends'
  }
}

export function setDefaultVisibility(value) {
  try {
    localStorage.setItem(DEFAULT_VISIBILITY_KEY, normalizeVisibility(value))
  } catch (_) {}
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
