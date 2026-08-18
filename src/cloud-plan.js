import { supabase } from './supabase.js'
import {
  buildCloudUploadPolicy,
  normalizeCloudPlanProfile,
} from './cloud-media-policy.js'

export const CLOUD_UPLOAD_POLICY_CHANGED_EVENT = 'sporely-cloud-upload-policy-changed'
const IMAGE_RESOLUTION_MODE_KEY = 'sporely-image-resolution-mode'

// Stage B1: `_source` tags distinguish where a policy came from. Callers
// (main.js snapshot writer, offline boot) MUST check this so a network
// fallback never overwrites a valid persisted plan.
export const CLOUD_PLAN_SOURCE = Object.freeze({
  NETWORK: 'network',   // explicit successful policy fetch
  FALLBACK: 'fallback', // network failure — default policy, do NOT persist
  CACHED: 'cached',     // loaded from last-validated-account snapshot
})

function _isMissingColumnError(error, columnName) {
  const text = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  const column = String(columnName || '').toLowerCase()
  return !!column
    && text.includes(column)
    && (text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find'))
}

export { normalizeCloudPlanProfile } from './cloud-media-policy.js'

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
  const uploadPolicy = buildCloudUploadPolicy(normalized, { uploadMode: 'full' })
  return {
    ...uploadPolicy,
    imageResolutionMode,
  }
}

// Convenience: tag a policy object with its provenance. Non-enumerable so it
// does not leak into JSON.stringify (which would persist the tag into
// last-validated-account and confuse a later read).
function _tag(policy, source) {
  if (!policy || typeof policy !== 'object') return policy
  try {
    Object.defineProperty(policy, '_source', {
      value: source,
      enumerable: false,
      writable: true,
      configurable: true,
    })
  } catch { /* frozen — ignore */ }
  return policy
}

export function getCloudPlanSource(policy) {
  return policy?._source || null
}

// Reconstruct an effective upload policy from a cached cloud plan (whatever
// shape the plan had when it was last persisted). Tags the result as
// CACHED so downstream code can decide whether to trust it as authoritative.
export function reviveCachedCloudPlan(cachedPlan) {
  if (!cachedPlan || typeof cachedPlan !== 'object') return null
  const revived = getEffectiveCloudUploadPolicy(cachedPlan)
  return _tag(revived, CLOUD_PLAN_SOURCE.CACHED)
}

export async function fetchCloudPlanProfile(userId) {
  const uid = String(userId || '').trim()
  if (!uid) return _tag(getEffectiveCloudUploadPolicy(), CLOUD_PLAN_SOURCE.FALLBACK)

  let data
  let error
  try {
    const result = await supabase
      .from('profiles')
      .select('is_pro, cloud_plan, full_res_storage_enabled, storage_quota_bytes, total_storage_bytes, storage_used_bytes, image_count')
      .eq('id', uid)
      .single()
    data = result?.data
    error = result?.error
  } catch (thrown) {
    // Network-level failure — treat as FALLBACK so the caller does not
    // persist this over a good cached plan.
    console.warn('fetchCloudPlanProfile threw:', thrown)
    return _tag(getEffectiveCloudUploadPolicy(), CLOUD_PLAN_SOURCE.FALLBACK)
  }

  if (error) {
    const missingColumns = [
      'cloud_plan',
      'is_pro',
      'full_res_storage_enabled',
      'storage_quota_bytes',
      'total_storage_bytes',
      'storage_used_bytes',
      'image_count',
    ]
    if (missingColumns.some(column => _isMissingColumnError(error, column))) {
      // Missing-column path is a deployment/schema case, not a live-user
      // downgrade — safe to persist as the current known plan.
      return _tag(getEffectiveCloudUploadPolicy(), CLOUD_PLAN_SOURCE.NETWORK)
    }
    console.warn('fetchCloudPlanProfile failed:', error)
    return _tag(getEffectiveCloudUploadPolicy(), CLOUD_PLAN_SOURCE.FALLBACK)
  }

  return _tag(getEffectiveCloudUploadPolicy(data), CLOUD_PLAN_SOURCE.NETWORK)
}

// Stage B: single authoritative merge rule for "assigning a freshly fetched
// cloud plan onto state.cloudPlan / persisted snapshot". Callers must funnel
// every assignment through this helper so a network FALLBACK can never
// clobber a known-good CACHED / NETWORK plan.
//
//   NETWORK  → replaces every prior value.
//   CACHED   → authoritative offline; NEVER replaced by a FALLBACK.
//   FALLBACK → written ONLY when nothing better is currently known.
//
// Returns the plan that should be assigned (may equal `current` — in that
// case the caller should skip the assignment).
export function mergeCloudPlanForOfflineFallback(current, next) {
  if (!next) return current || null
  const nextSource = getCloudPlanSource(next) || null
  const currentSource = getCloudPlanSource(current) || null
  if (nextSource === CLOUD_PLAN_SOURCE.NETWORK) return next
  if (nextSource === CLOUD_PLAN_SOURCE.CACHED) {
    // A CACHED plan cannot upgrade a NETWORK plan; only accept if we do not
    // currently have a NETWORK-sourced plan.
    return currentSource === CLOUD_PLAN_SOURCE.NETWORK ? current : next
  }
  // FALLBACK: only accept if we have nothing better known.
  if (currentSource === CLOUD_PLAN_SOURCE.NETWORK || currentSource === CLOUD_PLAN_SOURCE.CACHED) {
    return current
  }
  return current || next
}

export function formatStorageBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`
  return `${(value / (1024 ** 3)).toFixed(1)} GB`
}
