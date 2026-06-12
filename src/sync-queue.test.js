import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE,
  PRIVACY_SLOT_LIMIT_USER_MESSAGE,
  PRIVACY_SLOT_LIMIT_SYNC_ERROR_CODE,
  buildQueueStatusUpdate,
  classifyQueueSyncError,
  isImageTooLargeForPlanError,
  isPrivacySlotLimitError,
} from './sync-queue.js'
import { resolveMediaSources } from './images.js'

test('isPrivacySlotLimitError matches the privacy-cap server payload', () => {
  assert.equal(
    isPrivacySlotLimitError({
      code: '23514',
      message: 'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.',
    }),
    true,
  )
  assert.equal(
    isPrivacySlotLimitError({
      error: {
        code: '23514',
        message: 'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.',
      },
    }),
    true,
  )
})

test('privacy slot errors are classified as blocked and non-retryable', () => {
  const classified = classifyQueueSyncError({
    code: '23514',
    message: 'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.',
  })

  assert.equal(classified.isBlocked, true)
  assert.equal(classified.isRetryable, false)
  assert.equal(classified.syncErrorCode, PRIVACY_SLOT_LIMIT_SYNC_ERROR_CODE)
  assert.equal(classified.blockedReason, PRIVACY_SLOT_LIMIT_USER_MESSAGE)
  assert.match(classified.syncErrorMessage, /20 privacy slot observations/i)
})

test('non-blocked queue stages clear stale blocked metadata', () => {
  const next = buildQueueStatusUpdate(
    {
      syncStage: 'blocked',
      syncErrorCode: PRIVACY_SLOT_LIMIT_SYNC_ERROR_CODE,
      syncBlockedReason: PRIVACY_SLOT_LIMIT_USER_MESSAGE,
      blockedReason: PRIVACY_SLOT_LIMIT_USER_MESSAGE,
      blockedAt: 123,
      blockedByUserId: 'user-1',
      blockedQueueUserId: 'user-1',
      syncImageIndex: 1,
      syncImageCount: 1,
    },
    'retrying',
    {
      syncErrorMessage: 'Retry after edit',
    },
  )

  assert.equal(next.syncStage, 'retrying')
  assert.equal(next.syncErrorMessage, 'Retry after edit')
  assert.equal(next.syncErrorCode, null)
  assert.equal(next.syncBlockedReason, null)
  assert.equal(next.blockedReason, null)
  assert.equal(next.blockedAt, null)
  assert.equal(next.blockedByUserId, null)
  assert.equal(next.blockedQueueUserId, null)
})

test('isPrivacySlotLimitError handles nested Supabase response text', () => {
  assert.equal(
    isPrivacySlotLimitError(
      'POST observations: {"code":"23514","message":"Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue."}',
    ),
    true,
  )
})

test('isPrivacySlotLimitError ignores unrelated check violations', () => {
  assert.equal(
    isPrivacySlotLimitError({
      code: '23514',
      message: 'Some other check constraint failed.',
    }),
    false,
  )
})

test('privacy slot blocked message is user-facing', () => {
  assert.match(PRIVACY_SLOT_LIMIT_USER_MESSAGE, /Free accounts can keep up to 20 private\/fuzzed observations/)
  assert.match(PRIVACY_SLOT_LIMIT_USER_MESSAGE, /Publish this observation or use exact public location to sync\./)
})

test('isImageTooLargeForPlanError matches the plan-size server payload', () => {
  assert.equal(
    isImageTooLargeForPlanError({
      code: 'image_too_large_for_plan',
      message: 'Image too large for plan',
    }),
    true,
  )
  assert.equal(
    isImageTooLargeForPlanError({
      code: '23514',
      message: 'Free Sporely accounts can keep up to 20 privacy slot observations.',
    }),
    false,
  )
  assert.match(IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE, /image is too large for your plan/i)
})

test('legacy thumbnail-style media keys normalize to the canonical thumb path', async () => {
  const [source] = await resolveMediaSources(
    ['8c471394-b274-4933-b830-59805820d93c/617/thumb_medium_0_1780071867059.webp'],
    { variant: 'medium' },
  )

  assert.equal(source.primaryUrl, 'https://media.sporely.no/8c471394-b274-4933-b830-59805820d93c/617/thumb_0_1780071867059.webp')
  assert.equal(source.fallbackUrl, 'https://media.sporely.no/8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp')
})

test('finds refresh renders local data before starting background sync', () => {
  const source = fs.readFileSync(new URL('./screens/finds.js', import.meta.url), 'utf8')
  const refreshStart = source.indexOf('async function _refreshFindsFeed()')
  const refreshEnd = source.indexOf('function _bindPullToRefresh()', refreshStart)

  assert.ok(refreshStart >= 0)
  assert.ok(refreshEnd > refreshStart)

  const refreshBlock = source.slice(refreshStart, refreshEnd)
  assert.match(refreshBlock, /await loadFinds\(\)/)
  assert.match(refreshBlock, /void triggerSync\(\)\.catch/)
  assert.ok(refreshBlock.indexOf('await loadFinds()') < refreshBlock.indexOf('void triggerSync().catch'))
})

test('sync queue writes observation image metadata only after the R2 uploads complete', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const uploadIndex = source.indexOf('await uploadPreparedObservationImageVariants(preparedImage, path, {')
  const insertIndex = source.indexOf('await insertObservationImage({', uploadIndex)
  const syncKeysIndex = source.indexOf('await syncObservationMediaKeys(obsId, path, { sortOrder: i })', insertIndex)

  assert.ok(uploadIndex >= 0)
  assert.ok(insertIndex > uploadIndex)
  assert.ok(syncKeysIndex > insertIndex)
})
