export const CLOUD_QUALITY_PROFILE_STANDARD = 'standard'
export const CLOUD_QUALITY_PROFILE_HIGH = 'high'

export const CLOUD_REDUCED_MAX_PIXELS = 2_000_000
export const CLOUD_FULL_MAX_PIXELS = 20_000_000
export const CLOUD_THUMB_MAX_EDGE = 400

export const CLOUD_STANDARD_FULL_WEBP_QUALITY = 0.65
export const CLOUD_HIGH_FULL_WEBP_QUALITY = 0.80
export const CLOUD_THUMB_WEBP_QUALITY = 0.65
export const CLOUD_THUMB_JPEG_QUALITY = 0.75

export const CLOUD_STANDARD_FULL_BYTE_CAP = 1_000_000
export const CLOUD_HIGH_FULL_BYTE_CAP = 5_000_000

export const IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE = 'Image too large for plan'

const CLOUD_STANDARD_FULL_WEBP_QUALITIES = [0.65, 0.55, 0.45, 0.35, 0.25]
const CLOUD_HIGH_FULL_WEBP_QUALITIES = [0.80, 0.70, 0.60, 0.50, 0.40]

function _parseNullableInt(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeCloudPlanProfile(profile) {
  const rawPlan = String(profile?.cloud_plan ?? profile?.cloudPlan ?? '').trim().toLowerCase()
  const hasProAccess = rawPlan === 'pro' || !!(profile?.is_pro ?? profile?.isPro)
  const cloudPlan = hasProAccess ? 'pro' : 'free'
  const qualityProfile = hasProAccess ? CLOUD_QUALITY_PROFILE_HIGH : CLOUD_QUALITY_PROFILE_STANDARD
  const fullResStorageEnabled = !!(profile?.full_res_storage_enabled ?? profile?.fullResStorageEnabled)

  return {
    cloudPlan,
    qualityProfile,
    hasProAccess,
    fullResStorageEnabled,
    storageQuotaBytes: _parseNullableInt(profile?.storage_quota_bytes ?? profile?.storageQuotaBytes),
    storageUsedBytes: Math.max(0, _parseNullableInt(
      profile?.total_storage_bytes
      ?? profile?.storage_used_bytes
      ?? profile?.storageUsedBytes
    ) ?? 0),
    imageCount: Math.max(0, _parseNullableInt(profile?.image_count ?? profile?.imageCount) ?? 0),
  }
}

export function normalizeCloudUploadMode(value) {
  return String(value || '').trim().toLowerCase() === 'full' ? 'full' : 'reduced'
}

export function scaleDimensionsToMaxPixels(width, height, maxPixels) {
  const sourceWidth = Math.max(1, Number(width) || 0)
  const sourceHeight = Math.max(1, Number(height) || 0)
  const pixels = sourceWidth * sourceHeight
  const cap = Math.max(1, Number(maxPixels) || 0)
  if (pixels <= cap) {
    return {
      width: sourceWidth,
      height: sourceHeight,
      resized: false,
    }
  }

  const scale = Math.sqrt(cap / pixels)
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    resized: true,
  }
}

export function buildFullImageWebpQualityAttempts(qualityProfile) {
  return qualityProfile === CLOUD_QUALITY_PROFILE_HIGH
    ? [...CLOUD_HIGH_FULL_WEBP_QUALITIES]
    : [...CLOUD_STANDARD_FULL_WEBP_QUALITIES]
}

export function buildCloudUploadPolicy(profile, options = {}) {
  const normalized = profile?.qualityProfile
    ? profile
    : normalizeCloudPlanProfile(profile)
  const uploadMode = normalizeCloudUploadMode(options?.uploadMode || 'reduced')
  const qualityProfile = normalized.qualityProfile || CLOUD_QUALITY_PROFILE_STANDARD

  return {
    ...normalized,
    uploadMode,
    imageResolutionMode: uploadMode === 'full' ? 'max' : 'reduced',
    maxPixels: uploadMode === 'full' ? CLOUD_FULL_MAX_PIXELS : CLOUD_REDUCED_MAX_PIXELS,
    fullImageWebpQuality: qualityProfile === CLOUD_QUALITY_PROFILE_HIGH
      ? CLOUD_HIGH_FULL_WEBP_QUALITY
      : CLOUD_STANDARD_FULL_WEBP_QUALITY,
    fullImageByteCap: qualityProfile === CLOUD_QUALITY_PROFILE_HIGH
      ? CLOUD_HIGH_FULL_BYTE_CAP
      : CLOUD_STANDARD_FULL_BYTE_CAP,
    fullImageWebpQualityAttempts: buildFullImageWebpQualityAttempts(qualityProfile),
    thumbnailMaxEdge: CLOUD_THUMB_MAX_EDGE,
    thumbnailWebpQuality: CLOUD_THUMB_WEBP_QUALITY,
    thumbnailJpegQuality: CLOUD_THUMB_JPEG_QUALITY,
  }
}
