import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE,
  PRIVACY_SLOT_LIMIT_USER_MESSAGE,
  PRIVACY_SLOT_LIMIT_SYNC_ERROR_CODE,
  buildQueueStatusUpdate,
  classifyQueueSyncError,
  classifySessionRefreshFailure,
  isImageTooLargeForPlanError,
  isPrivacySlotLimitError,
} from './sync-queue.js'
import { resolveMediaSources, UNDECODABLE_IMAGE_USER_MESSAGE } from './images.js'
import { indexOfAnchor, sliceAfterAnchor, sliceBetweenAnchors } from './anchor-slice.js'

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
  const refreshBlock = sliceBetweenAnchors(
    source,
    'async function _refreshFindsFeed()',
    'function _bindPullToRefresh()',
    './screens/finds.js',
  )
  assert.match(refreshBlock, /await loadFinds\(\)/)
  assert.match(refreshBlock, /void triggerSync\(\)\.catch/)
  assert.ok(
    indexOfAnchor(refreshBlock, 'await loadFinds()', './screens/finds.js (refresh block)')
      < indexOfAnchor(refreshBlock, 'void triggerSync().catch', './screens/finds.js (refresh block)'),
  )
})

test('sync queue reserves row before upload in the upload loop', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const reserveIndex = indexOfAnchor(source, 'await reserveObservationImage({', './sync-queue.js')
  const uploadIndex = indexOfAnchor(
    source,
    'await uploadPreparedObservationImageVariants(preparedImage, path, {',
    './sync-queue.js',
  )
  const syncKeysIndex = indexOfAnchor(
    source,
    'await syncObservationMediaKeys(obsId, path, { sortOrder: i })',
    './sync-queue.js',
    uploadIndex,
  )

  assert.ok(uploadIndex > reserveIndex, 'upload should come after reserve')
  assert.ok(syncKeysIndex > uploadIndex, 'syncObservationMediaKeys should come after upload')
})

test('sync queue reuses persisted reservedImageId', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  assert.match(source, /image\.reservedImageId/, 'should check image.reservedImageId before calling reserveObservationImage')
})

test('sync queue no insertObservationImage after upload in upload loop', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const uploadIndex = indexOfAnchor(
    source,
    'await uploadPreparedObservationImageVariants(preparedImage, path, {',
    './sync-queue.js',
  )
  // insertObservationImage should not appear after the upload call.
  // NOTE: 'await insertObservationImage(' is the FORBIDDEN substring here, not
  // a slice anchor. It is absent from sync-queue.js today, and that absence is
  // the invariant passing — the row is reserved before upload instead. The
  // function still exists and is exported from images.js, so reintroducing a
  // call here would fail this assertion. Do not mistake the absent literal for
  // a stale anchor: the anchor is the upload call below, which is checked.
  const afterUpload = source.slice(uploadIndex)
  assert.ok(!afterUpload.includes('await insertObservationImage('), 'insertObservationImage should not be called after upload')
})

test('sync queue repair path preserves resolved geography on observation inserts', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')

  assert.match(source, /\.\.\.normalizeObservationGeography\(observationPayload\)/)
})

test('sync queue keeps old records compatible and persists new taxonomy identity after insert', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const extractIndex = indexOfAnchor(source, 'takeQueuedTaxonomySelection(observationPayload)', './sync-queue.js')
  const insertIndex = indexOfAnchor(
    source,
    "supabase.from('observations').insert(repairedPayload)",
    './sync-queue.js',
  )
  const persistIndex = indexOfAnchor(
    source,
    'persistObservationTaxonomySelection(obsId, queuedTaxonomySelection)',
    './sync-queue.js',
  )

  assert.ok(insertIndex > extractIndex)
  assert.ok(persistIndex > insertIndex)
  assert.match(source, /if \(queuedTaxonomySelection\) \{/)
})

test('find_detail direct upload reserves row before upload', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  const reserveIndex = indexOfAnchor(source, 'await reserveObservationImage({', './screens/find_detail.js')
  const uploadIndex = indexOfAnchor(
    source,
    'await uploadPreparedObservationImageVariants(preparedImage, storagePath, {',
    './screens/find_detail.js',
  )
  assert.ok(uploadIndex > reserveIndex, 'upload should come after reserve in find_detail')
})

// --- Behavioral tests for upload failure compensation ---

test('find_detail: definite 4xx deletes R2 bytes via deleteObservationMedia before removing row', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // On definite 4xx, bytes must be cleaned before the DB row is deleted
  const deleteMediaIndex = indexOfAnchor(
    source,
    'await deleteObservationMedia([storagePath])',
    './screens/find_detail.js',
  )
  const deleteRowIndex = indexOfAnchor(
    source,
    "supabase.from('observation_images').delete().eq('id', reservedRow.id)",
    './screens/find_detail.js',
  )
  assert.ok(deleteRowIndex > deleteMediaIndex, 'DB row delete must come after byte cleanup')
})

test('find_detail: definite 4xx cleanup is inside the 4xx branch', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // Both cleanup calls must appear inside the 'Worker upload failed (4' branch
  const fourxxBranchStart = indexOfAnchor(source, "includes('Worker upload failed (4')", './screens/find_detail.js')
  const deleteMediaIndex = indexOfAnchor(
    source,
    'await deleteObservationMedia([storagePath])',
    './screens/find_detail.js',
    fourxxBranchStart,
  )
  assert.ok(deleteMediaIndex > fourxxBranchStart, 'byte cleanup must be in the definite-4xx branch')
})

test('find_detail: ambiguous failure invokes verifyWorkerObjectExists, not blind delete', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // Per-variant: code probes each affected path in a loop using verifyWorkerObjectExists(path).
  assert.ok(source.includes('verifyWorkerObjectExists(path)'),
    'find_detail must call verifyWorkerObjectExists on ambiguous failure')
  // Verify the ambiguous path does NOT unconditionally delete the row
  const elseIndex = indexOfAnchor(source, '} else {\n          // Ambiguous failure', './screens/find_detail.js')
  const verifyIndex = indexOfAnchor(source, 'verifyWorkerObjectExists(path)', './screens/find_detail.js', elseIndex)
  assert.ok(verifyIndex > elseIndex, 'verifyWorkerObjectExists must be in the ambiguous-failure else branch')
})

test('find_detail: full and thumb share the same storagePath (same image id via reservedRow)', () => {
  const source = fs.readFileSync(new URL('./screens/find_detail.js', import.meta.url), 'utf8')
  // The reservedRow.id is passed as imageId to uploadPreparedObservationImageVariants which
  // uploads both full and thumb with that id in the X-Sporely-Image-Id header.
  const reserveCallIndex = indexOfAnchor(source, 'await reserveObservationImage({', './screens/find_detail.js')
  const uploadCallIndex = indexOfAnchor(
    source,
    'await uploadPreparedObservationImageVariants(preparedImage, storagePath, {',
    './screens/find_detail.js',
  )
  const imageIdInUpload = indexOfAnchor(source, 'imageId: reservedRow.id', './screens/find_detail.js', uploadCallIndex)
  assert.ok(imageIdInUpload > uploadCallIndex, 'imageId: reservedRow.id must be passed to uploadPreparedObservationImageVariants')
  assert.ok(reserveCallIndex < uploadCallIndex, 'reservation precedes upload')
})

test('sync queue: definite 4xx cleans bytes via deleteObservationMedia then nulls reservedImageId', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const fourxxBranchIndex = indexOfAnchor(source, "includes('Worker upload failed (4')", './sync-queue.js')
  const deleteMediaIndex = indexOfAnchor(source, 'await deleteObservationMedia([path])', './sync-queue.js', fourxxBranchIndex)
  assert.ok(deleteMediaIndex > fourxxBranchIndex, 'deleteObservationMedia([path]) must be called on definite 4xx in sync-queue')
  const nullReserveIndex = indexOfAnchor(source, 'reservedImageId: null', './sync-queue.js', fourxxBranchIndex)
  assert.ok(nullReserveIndex > fourxxBranchIndex, 'reservedImageId must be nulled on definite 4xx so retry gets a fresh reservation')
})

test('sync queue: retry reuses persisted reservedImageId (no second reservation)', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  // Guard: the code checks reservedImageId before calling reserveObservationImage
  const guardIndex = indexOfAnchor(source, 'image.reservedImageId', './sync-queue.js')
  const reserveIndex = indexOfAnchor(source, 'await reserveObservationImage({', './sync-queue.js')
  // The guard must come before the reserve call
  assert.ok(guardIndex < reserveIndex, 'reservedImageId guard must precede reserveObservationImage call')
})

test('sync queue: reservation merge is Blob-safe for legacy imageBlobs entries', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  // Both reservation merges (persist id after reserve; null id on 4xx) must
  // guard against spreading a raw Blob (which yields {} and silently loses
  // the bytes for legacy queue entries).
  const persistWindow = sliceAfterAnchor(
    source,
    '// Persist so retry reuses the same row',
    800,
    './sync-queue.js',
  )
  assert.match(persistWindow, /isBlob\(entries\[i\]\)/, 'persist merge must isBlob-guard the existing slot')
  assert.match(persistWindow, /_serializeQueuedImageForStorage\(preparedImage\)/, 'persist merge must fall back to serialized preparedImage when slot is a Blob')

  const fourxxWindow = sliceAfterAnchor(source, "includes('Worker upload failed (4')", 1200, './sync-queue.js')
  assert.match(fourxxWindow, /isBlob\(entries\[i\]\)/, '4xx merge must isBlob-guard the existing slot')
})

test('sync queue: ambiguous (non-4xx) failure does not call deleteObservationMedia', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  // deleteObservationMedia must only appear inside the definite-4xx branch
  const fourxxStart = indexOfAnchor(source, "includes('Worker upload failed (4')", './sync-queue.js')
  const catchBlock = source.slice(fourxxStart)
  // The deleteObservationMedia call should be INSIDE the 4xx if block, before the closing brace
  // Verify it's not in an else/catch branch for ambiguous errors
  const catchLabel = './sync-queue.js (from the definite-4xx branch onwards)'
  const fourxxClose = indexOfAnchor(catchBlock, '\n          }\n          throw uploadErr', catchLabel)
  const deleteInBranch = indexOfAnchor(catchBlock, 'await deleteObservationMedia([path])', catchLabel)
  assert.ok(deleteInBranch < fourxxClose,
    'deleteObservationMedia must only be in the definite-4xx branch, not the ambiguous path')
})

test('classifySessionRefreshFailure labels a server-confirmed rejection as rejected, not transport', () => {
  assert.equal(
    classifySessionRefreshFailure(new Error('Invalid Refresh Token: Refresh Token Not Found')),
    'rejected',
  )
})

test('classifySessionRefreshFailure still labels a transport-shaped failure as transport', () => {
  assert.equal(classifySessionRefreshFailure(new Error('Failed to fetch')), 'transport')
  const serverError = new Error('Internal Server Error')
  serverError.status = 503
  assert.equal(classifySessionRefreshFailure(serverError), 'transport')
})

test('classifySessionRefreshFailure falls back to unknown for an unclassified error', () => {
  assert.equal(classifySessionRefreshFailure(new Error('something else entirely')), 'unknown')
})

test('sync queue: empty-queue check runs before the auth session refresh in _runSyncQueue', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const body = sliceBetweenAnchors(
    source,
    'async function _runSyncQueue()',
    '\nexport async function triggerSync()',
    './sync-queue.js',
  )

  const bodyLabel = './sync-queue.js (the _runSyncQueue body)'
  const readItemsIndex = indexOfAnchor(body, 'const items = await _readQueueItems()', bodyLabel)
  const emptyReturnIndex = indexOfAnchor(body, 'if (!items || !items.length) return', bodyLabel, readItemsIndex)
  const sessionFetchIndex = indexOfAnchor(body, 'await getSharedAuthSession({ refresh: true })', bodyLabel)

  assert.ok(emptyReturnIndex > readItemsIndex, 'empty-queue return must follow the queue read')
  assert.ok(sessionFetchIndex > emptyReturnIndex,
    'getSharedAuthSession must not run until after the queue is confirmed non-empty — a native resume with nothing queued must not touch Supabase auth')

  // The queue read/empty-check must not itself sit inside the try/catch that
  // wraps the session fetch, confirming it is unconditional and prior.
  // Clamp the lookback: the original intent is "the try block starts a
  // little before the session fetch", not "search from a negative offset".
  const tryIndex = indexOfAnchor(body, 'try {', bodyLabel, Math.max(0, sessionFetchIndex - 20))
  assert.ok(tryIndex > emptyReturnIndex, 'the queue-empty check must be outside and before the session-refresh try block')
})

test('sync queue: session-refresh catch block classifies the error instead of hardcoding (transport)', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const body = sliceBetweenAnchors(
    source,
    'async function _runSyncQueue()',
    '\nexport async function triggerSync()',
    './sync-queue.js',
  )

  const catchBlock = sliceAfterAnchor(body, '} catch (err) {', 400, './sync-queue.js (the _runSyncQueue body)')

  assert.match(catchBlock, /classifySessionRefreshFailure\(err\)/,
    'catch block must classify the error rather than assuming transport')
  assert.doesNotMatch(catchBlock, /skipped — session refresh failed \(transport\):/,
    'the (transport) suffix must no longer be hardcoded for every failure')
})
