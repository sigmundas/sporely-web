export const CLOUD_QUALITY_PROFILE_STANDARD = 'standard'
export const CLOUD_QUALITY_PROFILE_HIGH = 'high'

export const CLOUD_REDUCED_MAX_PIXELS = 2_000_000
export const CLOUD_FULL_MAX_PIXELS = 20_000_000
// Public messaging still says "20 MP", but the actual resize gate is a bit
// higher so borderline full-frame captures are left untouched.
export const CLOUD_FULL_RESIZE_MAX_PIXELS = 21_000_000
export const CLOUD_FULL_RESIZE_MAX_EDGE = 5300
export const CLOUD_THUMB_MAX_EDGE = 400

export const CLOUD_STANDARD_FULL_WEBP_QUALITY = 0.65
export const CLOUD_HIGH_FULL_WEBP_QUALITY = 0.80
export const CLOUD_THUMB_WEBP_QUALITY = 0.65
export const CLOUD_THUMB_JPEG_QUALITY = 0.75

export const CLOUD_STANDARD_FULL_BYTE_CAP = 1_500_000
export const CLOUD_HIGH_FULL_BYTE_CAP = 5_000_000
export const CLOUD_IOS_WEB_FULL_MAX_PIXELS = 6_000_000

export const IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE = 'Image too large for plan'

const CLOUD_STANDARD_FULL_WEBP_QUALITIES = [0.65, 0.55, 0.45, 0.35, 0.25]
const CLOUD_HIGH_FULL_WEBP_QUALITIES = [0.80, 0.70, 0.60, 0.50, 0.40]
const CLOUD_IOS_WEB_FULL_JPEG_QUALITIES = [0.65, 0.60, 0.55, 0.50, 0.45]
const FULL_IMAGE_FIT_BYTE_CAP_SCALES = [0.9, 0.8, 0.72, 0.64, 0.56, 0.5]
const IOS_WEB_REDUCED_JPEG_JUMP_MILD_QUALITY = 0.55
const IOS_WEB_REDUCED_JPEG_JUMP_AGGRESSIVE_QUALITY = 0.45
const IOS_WEB_REDUCED_JPEG_JUMP_MILD_RATIO = 1.25
const IOS_WEB_REDUCED_JPEG_JUMP_AGGRESSIVE_RATIO = 1.5

function _normalizeQuality(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function _normalizeMimeType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

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

export function scaleDimensionsToMaxPixels(width, height, maxPixels, maxEdge = null) {
  const sourceWidth = Math.max(1, Number(width) || 0)
  const sourceHeight = Math.max(1, Number(height) || 0)
  const pixels = sourceWidth * sourceHeight
  const cap = Math.max(1, Number(maxPixels) || 0)
  const longestEdge = Math.max(sourceWidth, sourceHeight)
  const parsedEdgeCap = Number(maxEdge)
  const edgeCap = Number.isFinite(parsedEdgeCap) && parsedEdgeCap > 0 ? Math.max(1, parsedEdgeCap) : null
  if (pixels <= cap && (edgeCap === null || longestEdge <= edgeCap)) {
    return {
      width: sourceWidth,
      height: sourceHeight,
      resized: false,
    }
  }

  const scales = []
  if (pixels > cap) scales.push(Math.sqrt(cap / pixels))
  if (edgeCap !== null && longestEdge > edgeCap) scales.push(edgeCap / longestEdge)
  const scale = scales.length ? Math.min(...scales) : 1
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
    resized: true,
  }
}

export function buildFullImageWebpQualityAttempts(qualityProfile) {
  return qualityProfile === CLOUD_QUALITY_PROFILE_HIGH
    ? [...CLOUD_HIGH_FULL_WEBP_QUALITIES]
    : [...CLOUD_STANDARD_FULL_WEBP_QUALITIES]
}

export function buildFullImageEncodeCandidates(qualityProfile, exportSupport = {}) {
  const qualities = buildFullImageWebpQualityAttempts(qualityProfile)
  const webpSupported = exportSupport?.webp !== false
  const jpegSupported = exportSupport?.jpeg !== false
  const iOSReduced = exportSupport?.iosWebReduced === true
  const candidates = []

  if (iOSReduced) {
    if (jpegSupported) {
      candidates.push(...CLOUD_IOS_WEB_FULL_JPEG_QUALITIES.map(quality => ({
        type: 'image/jpeg',
        quality,
      })))
    }
    return candidates
  }

  if (webpSupported) {
    candidates.push(...qualities.map(quality => ({
      type: 'image/webp',
      quality,
    })))
  }

  if (jpegSupported) {
    candidates.push(...qualities.map(quality => ({
      type: 'image/jpeg',
      quality,
    })))
  }

  return candidates
}

export function buildThumbnailEncodeCandidates(exportSupport = {}) {
  const candidates = []
  if (exportSupport?.webp !== false) {
    candidates.push({ type: 'image/webp', quality: CLOUD_THUMB_WEBP_QUALITY })
  }
  if (exportSupport?.jpeg !== false) {
    candidates.push({ type: 'image/jpeg', quality: CLOUD_THUMB_JPEG_QUALITY })
  }
  return candidates
}

export function looksLikeIosWebKitRuntime(runtime = {}) {
  const userAgent = String(runtime.userAgent || '').toLowerCase()
  const platform = String(runtime.platform || '').toLowerCase()
  const vendor = String(runtime.vendor || '').toLowerCase()
  const maxTouchPoints = Number(runtime.maxTouchPoints || 0)
  const hasIosTokens = /iphone|ipad|ipod/.test(userAgent) || /iphone|ipad|ipod/.test(platform)
  const looksWebKit = vendor.includes('apple') || userAgent.includes('applewebkit')
  return hasIosTokens && looksWebKit && maxTouchPoints >= 1
}

export function shouldUseIosWebReducedFullImagePath(runtime = {}, exportSupport = {}) {
  return looksLikeIosWebKitRuntime(runtime) && exportSupport?.webp === false
}

export function buildFullImagePreparationPolicy(uploadPolicy, runtime = {}, exportSupport = {}) {
  const policy = uploadPolicy || {}
  const iOSReduced = shouldUseIosWebReducedFullImagePath(runtime, exportSupport)
  const resizeMaxPixels = iOSReduced
    ? CLOUD_IOS_WEB_FULL_MAX_PIXELS
    : (policy.resizeMaxPixels || policy.resize_max_pixels || policy.maxPixels || 0)
  const resizeMaxEdge = iOSReduced
    ? null
    : (policy.resizeMaxEdge || policy.resize_max_edge || null)

  return {
    runtimePath: iOSReduced ? 'ios-web-reduced' : 'normal',
    resizeMaxPixels,
    resizeMaxEdge,
    targetMaxPixels: resizeMaxPixels,
    targetMaxEdge: resizeMaxEdge,
    candidates: buildFullImageEncodeCandidates(policy.qualityProfile, {
      ...exportSupport,
      iosWebReduced: iOSReduced,
    }),
    byteCap: Number(policy.fullImageByteCap) || null,
  }
}

export function getIosWebReducedJpegJumpQuality(overshootRatio) {
  const ratio = Number(overshootRatio)
  if (!Number.isFinite(ratio) || ratio < IOS_WEB_REDUCED_JPEG_JUMP_MILD_RATIO) return null
  return ratio >= IOS_WEB_REDUCED_JPEG_JUMP_AGGRESSIVE_RATIO
    ? IOS_WEB_REDUCED_JPEG_JUMP_AGGRESSIVE_QUALITY
    : IOS_WEB_REDUCED_JPEG_JUMP_MILD_QUALITY
}

export function getFullImageEncodeRetryJump({
  runtimePath = '',
  candidates = [],
  currentIndex = 0,
  rejectedBytes = null,
  byteCap = null,
} = {}) {
  if (runtimePath !== 'ios-web-reduced') return null
  if (!Array.isArray(candidates) || currentIndex !== 0) return null

  const currentCandidate = candidates[currentIndex]
  if (!currentCandidate || _normalizeMimeType(currentCandidate.type) !== 'image/jpeg') return null

  const cap = Number(byteCap)
  const bytes = Number(rejectedBytes)
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(bytes) || bytes <= cap) return null

  const overshootRatio = bytes / cap
  const targetQuality = getIosWebReducedJpegJumpQuality(overshootRatio)
  if (targetQuality === null) return null

  const nextIndex = candidates.findIndex((candidate, index) => {
    if (index <= currentIndex) return false
    if (_normalizeMimeType(candidate.type) !== 'image/jpeg') return false
    const quality = _normalizeQuality(candidate.quality)
    return quality !== null && quality <= targetQuality
  })
  if (nextIndex < 0) return null

  return {
    nextIndex,
    nextQuality: _normalizeQuality(candidates[nextIndex]?.quality),
    overshootRatio,
  }
}

export function buildFullImageFitByteCapAttempts(targetWidth, targetHeight, scales = FULL_IMAGE_FIT_BYTE_CAP_SCALES) {
  const width = Math.max(1, Number(targetWidth) || 0)
  const height = Math.max(1, Number(targetHeight) || 0)
  const attempts = []
  const seen = new Set()

  for (const scale of Array.isArray(scales) ? scales : FULL_IMAGE_FIT_BYTE_CAP_SCALES) {
    const fitWidth = Math.max(1, Math.floor(width * Number(scale)))
    const fitHeight = Math.max(1, Math.floor(height * Number(scale)))
    const key = `${fitWidth}x${fitHeight}`
    if (seen.has(key)) continue
    seen.add(key)
    attempts.push({
      width: fitWidth,
      height: fitHeight,
    })
  }

  return attempts
}

export function buildCloudUploadPolicy(profile, options = {}) {
  const normalized = profile?.qualityProfile
    ? profile
    : normalizeCloudPlanProfile(profile)
  const uploadMode = normalizeCloudUploadMode(options?.uploadMode || 'reduced')
  const qualityProfile = normalized.qualityProfile || CLOUD_QUALITY_PROFILE_STANDARD
  const resizeMaxPixels = uploadMode === 'full' ? CLOUD_FULL_RESIZE_MAX_PIXELS : CLOUD_REDUCED_MAX_PIXELS
  const resizeMaxEdge = uploadMode === 'full' ? CLOUD_FULL_RESIZE_MAX_EDGE : null

  return {
    ...normalized,
    uploadMode,
    imageResolutionMode: uploadMode === 'full' ? 'max' : 'reduced',
    maxPixels: uploadMode === 'full' ? CLOUD_FULL_MAX_PIXELS : CLOUD_REDUCED_MAX_PIXELS,
    resizeMaxPixels,
    resizeMaxEdge,
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
