import { supabase } from './supabase.js'

export const FREE_CLOUD_MAX_PIXELS = 2_000_000
const DEBUG_OVERRIDE_KEY = 'sporely_debug_cloud_plan'

function _parseNullableInt(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function _canUseLocalStorage() {
  try {
    return typeof localStorage !== 'undefined'
  } catch (_) {
    return false
  }
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
  const fullResStorageEnabled = !!profile?.full_res_storage_enabled
  return {
    cloudPlan,
    fullResStorageEnabled,
    storageQuotaBytes: _parseNullableInt(profile?.storage_quota_bytes),
    storageUsedBytes: Math.max(0, _parseNullableInt(profile?.storage_used_bytes) ?? 0),
  }
}

export function normalizeCloudPlanOverride(value) {
  const raw = String(value || '').trim().toLowerCase()
  return raw === 'free' || raw === 'pro' ? raw : 'server'
}

export function getStoredCloudPlanOverride() {
  if (!_canUseLocalStorage()) return 'server'
  return normalizeCloudPlanOverride(localStorage.getItem(DEBUG_OVERRIDE_KEY))
}

export function setStoredCloudPlanOverride(value) {
  if (!_canUseLocalStorage()) return
  const normalized = normalizeCloudPlanOverride(value)
  if (normalized === 'server') {
    localStorage.removeItem(DEBUG_OVERRIDE_KEY)
    return
  }
  localStorage.setItem(DEBUG_OVERRIDE_KEY, normalized)
}

export function getEffectiveCloudUploadPolicy(profile) {
  const override = getStoredCloudPlanOverride()
  const normalized = normalizeCloudPlanProfile(profile)
  const effective = override === 'free'
    ? { ...normalized, cloudPlan: 'free', fullResStorageEnabled: false }
    : override === 'pro'
      ? { ...normalized, cloudPlan: 'pro', fullResStorageEnabled: true }
      : normalized
  const planSource = override === 'server' ? 'server' : 'debug_override'
  const uploadMode = effective.fullResStorageEnabled ? 'full' : 'reduced'
  return {
    ...effective,
    uploadMode,
    maxPixels: uploadMode === 'full' ? 0 : FREE_CLOUD_MAX_PIXELS,
    planSource,
    debugOverride: override,
  }
}

export async function fetchCloudPlanProfile(userId) {
  const uid = String(userId || '').trim()
  if (!uid) return getEffectiveCloudUploadPolicy()

  const { data, error } = await supabase
    .from('profiles')
    .select('cloud_plan, full_res_storage_enabled, storage_quota_bytes, storage_used_bytes')
    .eq('id', uid)
    .single()

  if (error) {
    const missingColumns = [
      'cloud_plan',
      'full_res_storage_enabled',
      'storage_quota_bytes',
      'storage_used_bytes',
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
