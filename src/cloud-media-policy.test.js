import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLOUD_FULL_MAX_PIXELS,
  CLOUD_FULL_RESIZE_MAX_EDGE,
  CLOUD_FULL_RESIZE_MAX_PIXELS,
  CLOUD_IOS_WEB_FULL_MAX_PIXELS,
  CLOUD_HIGH_FULL_BYTE_CAP,
  CLOUD_HIGH_FULL_WEBP_QUALITY,
  CLOUD_QUALITY_PROFILE_HIGH,
  CLOUD_QUALITY_PROFILE_STANDARD,
  CLOUD_STANDARD_FULL_BYTE_CAP,
  CLOUD_STANDARD_FULL_WEBP_QUALITY,
  buildFullImageEncodeCandidates,
  buildFullImageFitByteCapAttempts,
  buildFullImagePreparationPolicy,
  buildCloudUploadPolicy,
  getFullImageEncodeRetryJump,
  buildFullImageWebpQualityAttempts,
  buildThumbnailEncodeCandidates,
  looksLikeIosWebKitRuntime,
  normalizeCloudPlanProfile,
  scaleDimensionsToMaxPixels,
} from './cloud-media-policy.js'
import { getEffectiveCloudUploadPolicy } from './cloud-plan.js'

test('normalizeCloudPlanProfile resolves free and pro plans', () => {
  assert.deepEqual(
    normalizeCloudPlanProfile({ cloud_plan: 'free' }),
    {
      cloudPlan: 'free',
      qualityProfile: CLOUD_QUALITY_PROFILE_STANDARD,
      hasProAccess: false,
      fullResStorageEnabled: false,
      storageQuotaBytes: null,
      storageUsedBytes: 0,
      imageCount: 0,
    },
  )
  assert.equal(
    normalizeCloudPlanProfile({ cloud_plan: 'pro', is_pro: true }).qualityProfile,
    CLOUD_QUALITY_PROFILE_HIGH,
  )
})

test('buildCloudUploadPolicy uses the requested Free/Pro quality and caps', () => {
  const freePolicy = buildCloudUploadPolicy(normalizeCloudPlanProfile({ cloud_plan: 'free' }), { uploadMode: 'full' })
  const proPolicy = buildCloudUploadPolicy(normalizeCloudPlanProfile({ cloud_plan: 'pro', is_pro: true }), { uploadMode: 'full' })

  assert.equal(freePolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(freePolicy.resizeMaxPixels, CLOUD_FULL_RESIZE_MAX_PIXELS)
  assert.equal(freePolicy.resizeMaxEdge, CLOUD_FULL_RESIZE_MAX_EDGE)
  assert.equal(freePolicy.fullImageWebpQuality, CLOUD_STANDARD_FULL_WEBP_QUALITY)
  assert.equal(freePolicy.fullImageByteCap, CLOUD_STANDARD_FULL_BYTE_CAP)
  assert.equal(proPolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(proPolicy.resizeMaxPixels, CLOUD_FULL_RESIZE_MAX_PIXELS)
  assert.equal(proPolicy.resizeMaxEdge, CLOUD_FULL_RESIZE_MAX_EDGE)
  assert.equal(proPolicy.fullImageWebpQuality, CLOUD_HIGH_FULL_WEBP_QUALITY)
  assert.equal(proPolicy.fullImageByteCap, CLOUD_HIGH_FULL_BYTE_CAP)
})

test('getEffectiveCloudUploadPolicy keeps the official clients on full 20MP uploads', () => {
  const freePolicy = getEffectiveCloudUploadPolicy({ cloud_plan: 'free' })
  const proPolicy = getEffectiveCloudUploadPolicy({ cloud_plan: 'pro', is_pro: true })

  assert.equal(freePolicy.uploadMode, 'full')
  assert.equal(freePolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(freePolicy.resizeMaxPixels, CLOUD_FULL_RESIZE_MAX_PIXELS)
  assert.equal(freePolicy.resizeMaxEdge, CLOUD_FULL_RESIZE_MAX_EDGE)
  assert.equal(freePolicy.fullImageByteCap, CLOUD_STANDARD_FULL_BYTE_CAP)
  assert.equal(proPolicy.uploadMode, 'full')
  assert.equal(proPolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(proPolicy.resizeMaxPixels, CLOUD_FULL_RESIZE_MAX_PIXELS)
  assert.equal(proPolicy.resizeMaxEdge, CLOUD_FULL_RESIZE_MAX_EDGE)
  assert.equal(proPolicy.fullImageByteCap, CLOUD_HIGH_FULL_BYTE_CAP)
})

test('buildFullImageWebpQualityAttempts returns a small descending retry set', () => {
  assert.deepEqual(buildFullImageWebpQualityAttempts(CLOUD_QUALITY_PROFILE_STANDARD), [0.65, 0.55, 0.45, 0.35, 0.25])
  assert.deepEqual(buildFullImageWebpQualityAttempts(CLOUD_QUALITY_PROFILE_HIGH), [0.80, 0.70, 0.60, 0.50, 0.40])
})

test('buildFullImageEncodeCandidates skips unsupported WebP and keeps all JPEG qualities', () => {
  assert.deepEqual(
    buildFullImageEncodeCandidates(CLOUD_QUALITY_PROFILE_STANDARD, { webp: false, jpeg: true }),
    [
      { type: 'image/jpeg', quality: 0.65 },
      { type: 'image/jpeg', quality: 0.55 },
      { type: 'image/jpeg', quality: 0.45 },
      { type: 'image/jpeg', quality: 0.35 },
      { type: 'image/jpeg', quality: 0.25 },
    ],
  )
  assert.deepEqual(
    buildThumbnailEncodeCandidates({ webp: false, jpeg: true }),
    [
      { type: 'image/jpeg', quality: 0.75 },
    ],
  )
})

test('buildFullImageEncodeCandidates keeps normal WebP-first order when both formats are available', () => {
  assert.deepEqual(
    buildFullImageEncodeCandidates(CLOUD_QUALITY_PROFILE_STANDARD, { webp: true, jpeg: true }),
    [
      { type: 'image/webp', quality: 0.65 },
      { type: 'image/webp', quality: 0.55 },
      { type: 'image/webp', quality: 0.45 },
      { type: 'image/webp', quality: 0.35 },
      { type: 'image/webp', quality: 0.25 },
      { type: 'image/jpeg', quality: 0.65 },
      { type: 'image/jpeg', quality: 0.55 },
      { type: 'image/jpeg', quality: 0.45 },
      { type: 'image/jpeg', quality: 0.35 },
      { type: 'image/jpeg', quality: 0.25 },
    ],
  )
})

test('buildFullImagePreparationPolicy uses the normal gate when WebP works', () => {
  const plan = buildFullImagePreparationPolicy(
    buildCloudUploadPolicy(normalizeCloudPlanProfile({ cloud_plan: 'free' }), { uploadMode: 'full' }),
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', vendor: 'Google Inc.', platform: 'Win32', maxTouchPoints: 0 },
    { webp: true, jpeg: true },
  )

  assert.equal(plan.runtimePath, 'normal')
  assert.equal(plan.targetMaxPixels, CLOUD_FULL_RESIZE_MAX_PIXELS)
  assert.equal(plan.targetMaxEdge, CLOUD_FULL_RESIZE_MAX_EDGE)
  assert.equal(plan.byteCap, CLOUD_STANDARD_FULL_BYTE_CAP)
  assert.deepEqual(plan.candidates.slice(0, 2), [
    { type: 'image/webp', quality: 0.65 },
    { type: 'image/webp', quality: 0.55 },
  ])
})

test('buildFullImagePreparationPolicy uses the iOS reduced JPEG path when WebP is unavailable', () => {
  const plan = buildFullImagePreparationPolicy(
    buildCloudUploadPolicy(normalizeCloudPlanProfile({ cloud_plan: 'free' }), { uploadMode: 'full' }),
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', vendor: 'Apple Computer, Inc.', platform: 'iPhone', maxTouchPoints: 5 },
    { webp: false, jpeg: true },
  )

  assert.equal(plan.runtimePath, 'ios-web-reduced')
  assert.equal(plan.targetMaxPixels, CLOUD_IOS_WEB_FULL_MAX_PIXELS)
  assert.equal(plan.targetMaxEdge, null)
  assert.deepEqual(plan.candidates, [
    { type: 'image/jpeg', quality: 0.65 },
    { type: 'image/jpeg', quality: 0.60 },
    { type: 'image/jpeg', quality: 0.55 },
    { type: 'image/jpeg', quality: 0.50 },
    { type: 'image/jpeg', quality: 0.45 },
  ])
})

test('getFullImageEncodeRetryJump skips directly on large iOS reduced overshoots', () => {
  const candidates = buildFullImageEncodeCandidates(
    CLOUD_QUALITY_PROFILE_STANDARD,
    { webp: false, jpeg: true, iosWebReduced: true },
  )

  const aggressiveJump = getFullImageEncodeRetryJump({
    runtimePath: 'ios-web-reduced',
    candidates,
    currentIndex: 0,
    rejectedBytes: 2_300_000,
    byteCap: 1_500_000,
  })

  assert.deepEqual(aggressiveJump, {
    nextIndex: 4,
    nextQuality: 0.45,
    overshootRatio: 2_300_000 / 1_500_000,
  })
})

test('getFullImageEncodeRetryJump uses a milder jump for moderate iOS reduced overshoots', () => {
  const candidates = buildFullImageEncodeCandidates(
    CLOUD_QUALITY_PROFILE_STANDARD,
    { webp: false, jpeg: true, iosWebReduced: true },
  )

  const mildJump = getFullImageEncodeRetryJump({
    runtimePath: 'ios-web-reduced',
    candidates,
    currentIndex: 0,
    rejectedBytes: 1_830_000,
    byteCap: 1_500_000,
  })

  assert.deepEqual(mildJump, {
    nextIndex: 2,
    nextQuality: 0.55,
    overshootRatio: 1_830_000 / 1_500_000,
  })
})

test('looksLikeIosWebKitRuntime only matches iOS WebKit runtimes', () => {
  assert.equal(
    looksLikeIosWebKitRuntime({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      vendor: 'Apple Computer, Inc.',
      platform: 'iPhone',
      maxTouchPoints: 5,
    }),
    true,
  )
  assert.equal(
    looksLikeIosWebKitRuntime({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      vendor: 'Google Inc.',
      platform: 'Win32',
      maxTouchPoints: 0,
    }),
    false,
  )
})

test('buildFullImageFitByteCapAttempts returns bounded step-down sizes', () => {
  assert.deepEqual(
    buildFullImageFitByteCapAttempts(4000, 3000),
    [
      { width: 3600, height: 2700 },
      { width: 3200, height: 2400 },
      { width: 2880, height: 2160 },
      { width: 2560, height: 1920 },
      { width: 2240, height: 1680 },
      { width: 2000, height: 1500 },
    ],
  )
})

test('scaleDimensionsToMaxPixels leaves sub-threshold full images unchanged', () => {
  const scaled = scaleDimensionsToMaxPixels(5184, 3888, CLOUD_FULL_RESIZE_MAX_PIXELS, CLOUD_FULL_RESIZE_MAX_EDGE)

  assert.equal(scaled.resized, false)
  assert.equal(scaled.width, 5184)
  assert.equal(scaled.height, 3888)
})

test('scaleDimensionsToMaxPixels shrinks images that exceed the edge cap', () => {
  const scaled = scaleDimensionsToMaxPixels(6000, 4000, CLOUD_FULL_RESIZE_MAX_PIXELS, CLOUD_FULL_RESIZE_MAX_EDGE)

  assert.equal(scaled.resized, true)
  assert.equal(Math.max(scaled.width, scaled.height), CLOUD_FULL_RESIZE_MAX_EDGE)
  assert.ok((scaled.width * scaled.height) <= CLOUD_FULL_RESIZE_MAX_PIXELS)
})

test('scaleDimensionsToMaxPixels shrinks images that exceed the pixel cap', () => {
  const scaled = scaleDimensionsToMaxPixels(5600, 5600, CLOUD_FULL_RESIZE_MAX_PIXELS, CLOUD_FULL_RESIZE_MAX_EDGE)

  assert.equal(scaled.resized, true)
  assert.ok((scaled.width * scaled.height) <= CLOUD_FULL_RESIZE_MAX_PIXELS)
  assert.ok(Math.max(scaled.width, scaled.height) <= CLOUD_FULL_RESIZE_MAX_EDGE)
})
