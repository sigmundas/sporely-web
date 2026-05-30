import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLOUD_FULL_MAX_PIXELS,
  CLOUD_HIGH_FULL_BYTE_CAP,
  CLOUD_HIGH_FULL_WEBP_QUALITY,
  CLOUD_QUALITY_PROFILE_HIGH,
  CLOUD_QUALITY_PROFILE_STANDARD,
  CLOUD_STANDARD_FULL_BYTE_CAP,
  CLOUD_STANDARD_FULL_WEBP_QUALITY,
  buildCloudUploadPolicy,
  buildFullImageWebpQualityAttempts,
  normalizeCloudPlanProfile,
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
  assert.equal(freePolicy.fullImageWebpQuality, CLOUD_STANDARD_FULL_WEBP_QUALITY)
  assert.equal(freePolicy.fullImageByteCap, CLOUD_STANDARD_FULL_BYTE_CAP)
  assert.equal(proPolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(proPolicy.fullImageWebpQuality, CLOUD_HIGH_FULL_WEBP_QUALITY)
  assert.equal(proPolicy.fullImageByteCap, CLOUD_HIGH_FULL_BYTE_CAP)
})

test('getEffectiveCloudUploadPolicy keeps the official clients on full 20MP uploads', () => {
  const freePolicy = getEffectiveCloudUploadPolicy({ cloud_plan: 'free' })
  const proPolicy = getEffectiveCloudUploadPolicy({ cloud_plan: 'pro', is_pro: true })

  assert.equal(freePolicy.uploadMode, 'full')
  assert.equal(freePolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(freePolicy.fullImageByteCap, CLOUD_STANDARD_FULL_BYTE_CAP)
  assert.equal(proPolicy.uploadMode, 'full')
  assert.equal(proPolicy.maxPixels, CLOUD_FULL_MAX_PIXELS)
  assert.equal(proPolicy.fullImageByteCap, CLOUD_HIGH_FULL_BYTE_CAP)
})

test('buildFullImageWebpQualityAttempts returns a small descending retry set', () => {
  assert.deepEqual(buildFullImageWebpQualityAttempts(CLOUD_QUALITY_PROFILE_STANDARD), [0.65, 0.55, 0.45, 0.35, 0.25])
  assert.deepEqual(buildFullImageWebpQualityAttempts(CLOUD_QUALITY_PROFILE_HIGH), [0.80, 0.70, 0.60, 0.50, 0.40])
})
