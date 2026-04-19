import { supabase } from './supabase.js'

export const FREE_CLOUD_MAX_PIXELS = 2_000_000
export const PRO_CLOUD_MAX_PIXELS = 12_000_000
export const PRO_CLOUD_RESIZE_THRESHOLD_PIXELS = 14_000_000
export const CLOUD_UPLOAD_POLICY_CHANGED_EVENT = 'sporely-cloud-upload-policy-changed'
const IMAGE_RESOLUTION_MODE_KEY = 'sporely-image-resolution-mode'

function _parseNullableInt(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function _isMissingColumnError(error, columnName) {
  const text = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  const column = String(columnName || '').toLowerCase()
  return !!column
    && text.includes(column)
    && (text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find'))
}

export function normalizeCloudPlanProfile(profile) {
  const rawPlan = String(profile?.cloud_plan || '').trim().toLowerCase()
  const cloudPlan = rawPlan === 'pro' ? 'pro' : 'free'
  const fullResStorageEnabled = cloudPlan === 'pro' || !!profile?.full_res_storage_enabled
  return {
    cloudPlan,
    fullResStorageEnabled,
    storageQuotaBytes: _parseNullableInt(profile?.storage_quota_bytes),
    storageUsedBytes: Math.max(0, _parseNullableInt(profile?.total_storage_bytes ?? profile?.storage_used_bytes) ?? 0),
    imageCount: Math.max(0, _parseNullableInt(profile?.image_count) ?? 0),
  }
}

export function normalizeImageResolutionMode(value) {
  return String(value || '').trim().toLowerCase() === 'reduced' ? 'reduced' : 'max'
}

export function getStoredImageResolutionMode() {
  try {
    return normalizeImageResolutionMode(localStorage.getItem(IMAGE_RESOLUTION_MODE_KEY))
  } catch (_) {
    return 'max'
  }
}

export function setStoredImageResolutionMode(value) {
  try {
    localStorage.setItem(IMAGE_RESOLUTION_MODE_KEY, normalizeImageResolutionMode(value))
  } catch (_) {}
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(CLOUD_UPLOAD_POLICY_CHANGED_EVENT))
  }
}

export function getEffectiveCloudUploadPolicy(profile) {
  const normalized = normalizeCloudPlanProfile(profile)
  const imageResolutionMode = getStoredImageResolutionMode()
  const canUseMaxResolution = normalized.cloudPlan === 'pro' || normalized.fullResStorageEnabled
  const uploadMode = canUseMaxResolution && imageResolutionMode === 'max' ? 'full' : 'reduced'
  const maxPixels = uploadMode === 'full' ? PRO_CLOUD_MAX_PIXELS : FREE_CLOUD_MAX_PIXELS
  return {
    ...normalized,
    imageResolutionMode: uploadMode === 'full' ? 'max' : 'reduced',
    uploadMode,
    maxPixels,
    resizeThresholdPixels: uploadMode === 'full' ? PRO_CLOUD_RESIZE_THRESHOLD_PIXELS : maxPixels,
  }
}

export async function fetchCloudPlanProfile(userId) {
  const uid = String(userId || '').trim()
  if (!uid) return getEffectiveCloudUploadPolicy()

  const { data, error } = await supabase
    .from('profiles')
    .select('cloud_plan, full_res_storage_enabled, storage_quota_bytes, total_storage_bytes, storage_used_bytes, image_count')
    .eq('id', uid)
    .single()

  if (error) {
    const missingColumns = [
      'cloud_plan',
      'full_res_storage_enabled',
      'storage_quota_bytes',
      'total_storage_bytes',
      'storage_used_bytes',
      'image_count',
    ]
    if (missingColumns.some(column => _isMissingColumnError(error, column))) {
      return getEffectiveCloudUploadPolicy()
    }
    console.warn('fetchCloudPlanProfile failed:', error)
    return getEffectiveCloudUploadPolicy()
  }

  return getEffectiveCloudUploadPolicy(data)
}

export function formatStorageBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`
  return `${(value / (1024 ** 3)).toFixed(1)} GB`
}
