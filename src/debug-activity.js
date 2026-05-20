const DASHBOARD_FLAG_KEY = 'sporely-debug-dashboard'
const DEBUG_NAMESPACE_KEY = '__sporelyAiDebug'
const DEFAULT_LIMIT = 20

export function isDebugDashboardEnabled() {
  try {
    return globalThis.localStorage?.getItem(DASHBOARD_FLAG_KEY) === 'true'
  } catch (_) {
    return false
  }
}

function _isLegacyDebugScreenEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-artsorakel') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.sessionStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-inat-oauth') === 'true'
      || globalThis.sessionStorage?.getItem('sporely-debug-inat-oauth') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-inaturalist') === 'true'
  } catch (_) {
    return false
  }
}

export function isDebugScreenEnabled() {
  return isDebugDashboardEnabled() || _isLegacyDebugScreenEnabled()
}

export function shouldCaptureDebugPreviewUrls() {
  return isDebugScreenEnabled()
}

export function revokeDebugObjectUrl(url) {
  const value = String(url || '').trim()
  if (!value.startsWith('blob:')) return
  try {
    globalThis.URL?.revokeObjectURL?.(value)
  } catch (_) {}
}

export function ensureDebugNamespace() {
  if (!globalThis[DEBUG_NAMESPACE_KEY] || typeof globalThis[DEBUG_NAMESPACE_KEY] !== 'object') {
    globalThis[DEBUG_NAMESPACE_KEY] = {}
  }
  const ns = globalThis[DEBUG_NAMESPACE_KEY]
  for (const key of ['inat', 'artsorakel', 'images', 'jsonResponses']) {
    if (!Array.isArray(ns[key])) ns[key] = []
  }
  return ns
}

export function clearDebugNamespace() {
  const ns = ensureDebugNamespace()
  for (const key of ['inat', 'artsorakel', 'images', 'jsonResponses']) {
    if (!Array.isArray(ns[key])) continue
    for (const entry of ns[key]) {
      revokeDebugObjectUrl(entry?.imageSrc || entry?.debugPreviewUrl || entry?.previewUrl || entry?.sourceUrl || '')
      revokeDebugObjectUrl(entry?.images?.[0]?.objectUrl || entry?.images?.[0]?.debugPreviewUrl || '')
      revokeDebugObjectUrl(entry?.details?.imageSrc || entry?.details?.debugPreviewUrl || '')
    }
    ns[key].length = 0
  }
  return ns
}

function _trimStore(store, limit = DEFAULT_LIMIT) {
  if (!Array.isArray(store)) return
  while (store.length > limit) {
    const removed = store.shift()
    revokeDebugObjectUrl(removed?.imageSrc || removed?.debugPreviewUrl || removed?.previewUrl || removed?.sourceUrl || '')
    revokeDebugObjectUrl(removed?.images?.[0]?.objectUrl || removed?.images?.[0]?.debugPreviewUrl || '')
    revokeDebugObjectUrl(removed?.details?.imageSrc || removed?.details?.debugPreviewUrl || '')
  }
}

function _pushLatest(store, entry, limit = DEFAULT_LIMIT) {
  if (!Array.isArray(store)) return null
  store.unshift(entry)
  _trimStore(store, limit)
  return entry
}

export function recordDebugImageEvent(message, details = {}) {
  if (!isDebugScreenEnabled()) return null
  const ns = ensureDebugNamespace()
  return _pushLatest(ns.images, {
    timestamp: new Date().toISOString(),
    message: String(message || ''),
    details,
  })
}

export function recordDebugJsonResponse(entry = {}) {
  if (!isDebugScreenEnabled()) return null
  const ns = ensureDebugNamespace()
  return _pushLatest(ns.jsonResponses, {
    timestamp: new Date().toISOString(),
    ...entry,
  })
}
