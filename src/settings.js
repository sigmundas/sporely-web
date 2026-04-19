const DEFAULT_VISIBILITY_KEY = 'sporely-default-visibility'
const SYNC_OVER_MOBILE_DATA_KEY = 'sporely-sync-over-mobile-data'
const LAST_SYNC_AT_KEY = 'sporely-last-sync-at'

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

export function getSyncOverMobileDataEnabled() {
  try {
    return localStorage.getItem(SYNC_OVER_MOBILE_DATA_KEY) !== '0'
  } catch (_) {
    return true
  }
}

export function setSyncOverMobileDataEnabled(enabled) {
  try {
    localStorage.setItem(SYNC_OVER_MOBILE_DATA_KEY, enabled ? '1' : '0')
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
  return getSyncOverMobileDataEnabled() || !isProbablyCellularConnection()
}

export function onConnectionTypeChange(callback) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (!connection?.addEventListener) return () => {}
  connection.addEventListener('change', callback)
  return () => connection.removeEventListener?.('change', callback)
}

