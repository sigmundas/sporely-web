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
import { resolveMediaSources, UNDECODABLE_IMAGE_USER_MESSAGE } from './images.js'

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

test('undecodable image errors are classified as blocked and non-retryable', () => {
  const classified = classifyQueueSyncError({
    code: 'image_undecodable',
    message: UNDECODABLE_IMAGE_USER_MESSAGE,
  })

  assert.equal(classified.syncErrorCode, 'image_undecodable')
  assert.equal(classified.blockedReason, UNDECODABLE_IMAGE_USER_MESSAGE)
  assert.equal(classified.syncErrorMessage, UNDECODABLE_IMAGE_USER_MESSAGE)
  assert.equal(classified.isBlocked, true)
  assert.equal(classified.isRetryable, false)
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

test('sync queue reserves row before upload in the upload loop', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const reserveIndex = source.indexOf('await reserveObservationImage({')
  const uploadIndex = source.indexOf('await uploadPreparedObservationImageVariants(preparedImage, path, {')
  const syncKeysIndex = source.indexOf('await syncObservationMediaKeys(obsId, path, { sortOrder: i })', uploadIndex)

  assert.ok(reserveIndex >= 0, 'reserveObservationImage should be called in upload loop')
  assert.ok(uploadIndex > reserveIndex, 'upload should come after reserve')
  assert.ok(syncKeysIndex > uploadIndex, 'syncObservationMediaKeys should come after upload')
})

test('sync queue reuses persisted reservedImageId', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  assert.match(source, /image\.reservedImageId/, 'should check image.reservedImageId before calling reserveObservationImage')
})

test('sync queue no insertObservationImage after upload in upload loop', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const uploadIndex = source.indexOf('await uploadPreparedObservationImageVariants(preparedImage, path, {')
  assert.ok(uploadIndex >= 0)
  // insertObservationImage should not appear after the upload call
  const afterUpload = source.slice(uploadIndex)
  assert.ok(!afterUpload.includes('await insertObservationImage('), 'insertObservationImage should not be called after upload')
})

test('sync queue repair path preserves resolved geography on observation inserts', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')

  assert.match(source, /\.\.\.normalizeObservationGeography\(observationPayload\)/)
})

test('sync queue keeps old records compatible and persists new taxonomy identity after insert', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const extractIndex = source.indexOf('takeQueuedTaxonomySelection(observationPayload)')
  const insertIndex = source.indexOf("supabase.from('observations').insert(repairedPayload)")
  const persistIndex = source.indexOf('persistObservationTaxonomySelection(obsId, queuedTaxonomySelection)')

  assert.ok(extractIndex > 0)
  assert.ok(insertIndex > extractIndex)
  assert.ok(persistIndex > insertIndex)
  assert.match(source, /if \(queuedTaxonomySelection\) \{/)
})

test('find_detail direct upload reserves row before upload', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  const reserveIndex = source.indexOf('await reserveObservationImage({')
  const uploadIndex = source.indexOf('await uploadPreparedObservationImageVariants(preparedImage, storagePath, {')
  assert.ok(reserveIndex >= 0, 'reserveObservationImage should be called in find_detail direct upload')
  assert.ok(uploadIndex > reserveIndex, 'upload should come after reserve in find_detail')
})

// --- Behavioral tests for upload failure compensation ---

test('find_detail: definite 4xx deletes R2 bytes via deleteObservationMedia before removing row', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // On definite 4xx, bytes must be cleaned before the DB row is deleted
  const deleteMediaIndex = source.indexOf('await deleteObservationMedia([storagePath])')
  const deleteRowIndex = source.indexOf("supabase.from('observation_images').delete().eq('id', reservedRow.id)")
  assert.ok(deleteMediaIndex >= 0, 'deleteObservationMedia([storagePath]) must be called on definite 4xx')
  assert.ok(deleteRowIndex > deleteMediaIndex, 'DB row delete must come after byte cleanup')
})

test('find_detail: definite 4xx cleanup is inside the 4xx branch', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // Both cleanup calls must appear inside the 'Worker upload failed (4' branch
  const fourxxBranchStart = source.indexOf("includes('Worker upload failed (4')")
  const deleteMediaIndex = source.indexOf('await deleteObservationMedia([storagePath])', fourxxBranchStart)
  assert.ok(fourxxBranchStart >= 0 && deleteMediaIndex >= 0 && deleteMediaIndex > fourxxBranchStart,
    'byte cleanup must be in the definite-4xx branch')
})

test('find_detail: ambiguous failure invokes verifyWorkerObjectExists, not blind delete', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // Per-variant: code probes each affected path in a loop using verifyWorkerObjectExists(path).
  assert.ok(source.includes('verifyWorkerObjectExists(path)'),
    'find_detail must call verifyWorkerObjectExists on ambiguous failure')
  // Verify the ambiguous path does NOT unconditionally delete the row
  const elseIndex = source.indexOf('} else {\n          // Ambiguous failure')
  const verifyIndex = source.indexOf('verifyWorkerObjectExists(path)', elseIndex)
  assert.ok(verifyIndex > elseIndex, 'verifyWorkerObjectExists must be in the ambiguous-failure else branch')
})

test('find_detail: full and thumb share the same storagePath (same image id via reservedRow)', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // The reservedRow.id is passed as imageId to uploadPreparedObservationImageVariants which
  // uploads both full and thumb with that id in the X-Sporely-Image-Id header.
  const reserveCallIndex = source.indexOf('await reserveObservationImage({')
  const uploadCallIndex = source.indexOf('await uploadPreparedObservationImageVariants(preparedImage, storagePath, {')
  const imageIdInUpload = source.indexOf('imageId: reservedRow.id', uploadCallIndex)
  assert.ok(imageIdInUpload > uploadCallIndex, 'imageId: reservedRow.id must be passed to uploadPreparedObservationImageVariants')
  assert.ok(reserveCallIndex < uploadCallIndex, 'reservation precedes upload')
})

test('sync queue: definite 4xx cleans bytes via deleteObservationMedia then nulls reservedImageId', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const fourxxBranchIndex = source.indexOf("includes('Worker upload failed (4')")
  assert.ok(fourxxBranchIndex >= 0, 'sync-queue must have a definite-4xx branch after upload')
  const deleteMediaIndex = source.indexOf('await deleteObservationMedia([path])', fourxxBranchIndex)
  assert.ok(deleteMediaIndex > fourxxBranchIndex, 'deleteObservationMedia([path]) must be called on definite 4xx in sync-queue')
  const nullReserveIndex = source.indexOf('reservedImageId: null', fourxxBranchIndex)
  assert.ok(nullReserveIndex > fourxxBranchIndex, 'reservedImageId must be nulled on definite 4xx so retry gets a fresh reservation')
})

test('sync queue: retry reuses persisted reservedImageId (no second reservation)', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  // Guard: the code checks reservedImageId before calling reserveObservationImage
  const guardIndex = source.indexOf('image.reservedImageId')
  const reserveIndex = source.indexOf('await reserveObservationImage({')
  assert.ok(guardIndex >= 0 && reserveIndex > 0, 'code must guard reserveObservationImage with existing reservedImageId check')
  // The guard must come before the reserve call
  assert.ok(guardIndex < reserveIndex, 'reservedImageId guard must precede reserveObservationImage call')
})

test('sync queue: reservation merge is Blob-safe for legacy imageBlobs entries', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  // Both reservation merges (persist id after reserve; null id on 4xx) must
  // guard against spreading a raw Blob (which yields {} and silently loses
  // the bytes for legacy queue entries).
  const persistMerge = source.indexOf('// Persist so retry reuses the same row')
  assert.ok(persistMerge >= 0, 'persist-reservation merge must exist')
  const persistWindow = source.slice(persistMerge, persistMerge + 800)
  assert.match(persistWindow, /isBlob\(entries\[i\]\)/, 'persist merge must isBlob-guard the existing slot')
  assert.match(persistWindow, /_serializeQueuedImageForStorage\(preparedImage\)/, 'persist merge must fall back to serialized preparedImage when slot is a Blob')

  const fourxxIdx = source.indexOf("includes('Worker upload failed (4')")
  const fourxxWindow = source.slice(fourxxIdx, fourxxIdx + 1200)
  assert.match(fourxxWindow, /isBlob\(entries\[i\]\)/, '4xx merge must isBlob-guard the existing slot')
})

test('sync queue: ambiguous (non-4xx) failure does not call deleteObservationMedia', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  // deleteObservationMedia must only appear inside the definite-4xx branch
  const catchBlock = source.slice(source.indexOf("includes('Worker upload failed (4')"))
  // The deleteObservationMedia call should be INSIDE the 4xx if block, before the closing brace
  // Verify it's not in an else/catch branch for ambiguous errors
  const fourxxClose = catchBlock.indexOf('\n          }\n          throw uploadErr')
  const deleteInBranch = catchBlock.indexOf('await deleteObservationMedia([path])')
  assert.ok(deleteInBranch >= 0 && deleteInBranch < fourxxClose,
    'deleteObservationMedia must only be in the definite-4xx branch, not the ambiguous path')
})
