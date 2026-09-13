import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { getVariantPath, imageExtensionForMimeType, buildObservationImageStoragePath } from './images.js'
import { classifyQueueSyncError } from './sync-queue.js'

const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
// Execute the production functions, replacing only external services/storage.
// Each pass gets a fresh runtime; only structured-cloned queue bytes survive.
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `Missing production function ${name}`)
  const end = source.indexOf('\n}', start) + 2
  assert.ok(end > start)
  return source.slice(start, end).replace(/^export /, '')
}
const functions = [
  '_normalizeQueueUserId', '_queueUserFromItem', '_isArrayBuffer', '_blobFromStoredBytes',
  '_blobToStoredBytes', '_normalizeQueuedImages', '_serializeQueuedImageForStorage',
  '_persistPreparedQueuedImage', '_queuedImageReservation', '_fetchRemoteObservationState',
  '_finalizeSyncedQueueItem', '_runSyncQueue',
].map(functionSource).join('\n')

function fixture({ count = 1, thumb = true, savedId = true, unprepared = false } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: 40 + i, sort_order: i, storage_path: `user/123/${i}.webp`,
  }))
  let queue = {
    id: 1, ts: 1, userId: 'user', remoteObservationId: 123,
    obsPayload: { user_id: 'user' },
    imageEntries: rows.map(row => ({
      ...(unprepared ? { blobBytes: new Uint8Array([1, 2, 3]).buffer, blobType: 'image/jpeg' }
        : { uploadBytes: new Uint8Array([1, 2, 3]).buffer, uploadType: 'image/webp' }),
      uploadMeta: { upload_mode: 'reduced', quality_profile: 'standard' },
      variantBytes: thumb && !unprepared ? { thumb: new Uint8Array([4, 5]).buffer } : null,
      variantTypes: { thumb: 'image/webp' },
      reservedImageId: savedId ? row.id : null,
    })),
  }
  const objects = new Set()
  const uploads = [], keyWrites = [], successes = [], checks = []
  let failUpload = false, failHead = false, omitThumb = false
  const noop = () => {}
  async function pass() {
    const context = vm.createContext({
      Blob, ArrayBuffer, Uint8Array, console: { info: noop, warn: noop, error: noop },
      isBlob: value => value instanceof Blob,
      getVariantPath, imageExtensionForMimeType, buildObservationImageStoragePath, classifyQueueSyncError,
      _cloudPlanCache: new Map(),
      canSyncOnCurrentConnection: () => true,
      canPerformCloudMutation: () => ({ allowed: true }),
      getSharedAuthSession: async () => ({ user: { id: 'user' } }),
      _readQueueItems: async () => queue ? [structuredClone(queue)] : [],
      _updateQueueItem: async (id, update) => {
        queue = structuredClone(update(structuredClone(queue)))
        return structuredClone(queue)
      },
      _deleteQueueItem: async () => {
        for (const row of rows) {
          assert.ok(objects.has(row.storage_path), 'must retain bytes until full exists')
          if (thumb) assert.ok(objects.has(getVariantPath(row.storage_path, 'thumb')))
        }
        queue = null
      },
      _setQueueSyncStatus: async (id, stage) => { queue.syncStage = stage },
      _isBlockedQueueItem: () => false,
      _queueKeyForUser: () => 'queue:user',
      _debugQueue: noop, startUploadForegroundService: noop, updateUploadForegroundService: noop,
      _persistQueuedObservationIdentifications: async () => {},
      takeQueuedTaxonomySelection: payload => ({ databasePayload: payload, selection: null }),
      fetchCloudPlanProfile: async () => ({ uploadMode: 'reduced', qualityProfile: 'standard' }),
      prepareImageVariants: async blob => ({ uploadBlob: blob, variants: thumb ? { thumb: new Blob(['thumb']) } : {}, uploadMeta: {} }),
      reserveObservationImage: async () => { assert.fail('existing reservation must be reused') },
      uploadPreparedObservationImageVariants: async (image, path, options) => {
        assert.ok(queue.imageEntries.every(entry => entry.uploadBytes || entry.blobBytes))
        uploads.push({ path, id: options.imageId })
        assert.equal(await image.uploadBlob.arrayBuffer().then(bytes => bytes.byteLength), 3)
        if (failUpload) throw new TypeError('Failed to fetch')
        objects.add(path)
        if (image.variants?.thumb && !omitThumb) objects.add(getVariantPath(path, 'thumb'))
      },
      verifyWorkerObjectExists: async path => {
        checks.push(path)
        if (failHead) throw new Error('Worker HEAD failed: 503')
        return objects.has(path)
      },
      syncObservationMediaKeys: async (id, path) => { keyWrites.push(path) },
      supabase: { from: table => ({
        select() { return this }, eq() { return this }, is() { return this },
        limit: async () => ({ data: [{ id: 123 }], error: null }),
        order: async () => { assert.equal(table, 'observation_images'); return { data: structuredClone(rows), error: null } },
      }) },
      notifyQueueChanged: noop, notifySyncSuccess: result => successes.push(result),
      _scheduleSyncRetry: noop,
    })
    vm.runInContext(functions, context)
    await context._runSyncQueue()
  }
  return {
    rows, objects, uploads, keyWrites, successes, checks, pass,
    get queue() { return queue },
    failUploads(value) { failUpload = value }, failHeads(value) { failHead = value },
    omitThumbnail(value) { omitThumb = value },
    markPresent(index, withThumb = thumb) {
      objects.add(rows[index].storage_path)
      if (withThumb) objects.add(getVariantPath(rows[index].storage_path, 'thumb'))
    },
  }
}

for (const savedId of [true, false]) {
  test(`reservation-only restart uploads and retains durable bytes on failure (saved ID: ${savedId})`, async () => {
    const f = fixture({ savedId })
    // Old clients may already have persisted the incorrect completion hint.
    f.queue.completedImageIndexes = [0, 99]
    f.failUploads(true)
    await f.pass()
    assert.deepEqual(f.uploads, [{ path: f.rows[0].storage_path, id: 40 }])
    assert.deepEqual([...new Uint8Array(f.queue.imageEntries[0].uploadBytes)], [1, 2, 3])
    assert.deepEqual([...new Uint8Array(f.queue.imageEntries[0].variantBytes.thumb)], [4, 5])
    assert.equal(f.queue.syncStage, 'retrying')
    assert.equal(f.keyWrites.length, 0)
    f.failUploads(false)
    await f.pass()
    assert.equal(f.queue, null)
    assert.equal(f.uploads.length, 2)
    assert.equal(f.rows.length, 1)
  })
}

test('full present / thumbnail absent is repaired on restart', async () => {
  const f = fixture()
  f.markPresent(0, false)
  await f.pass()
  assert.equal(f.uploads.length, 1)
  assert.ok(f.objects.has(getVariantPath(f.rows[0].storage_path, 'thumb')))
  assert.equal(f.queue, null)
})

test('full and thumbnail present reconcile stale queue without upload or duplicate rows', async () => {
  const f = fixture()
  f.markPresent(0)
  await f.pass()
  assert.equal(f.uploads.length, 0)
  assert.equal(f.rows.length, 1)
  assert.equal(f.queue, null)
  assert.equal(f.successes[0].reason, 'remote-reconcile')
})

test('multi-image restart skips verified image and uploads reserved-only image', async () => {
  const f = fixture({ count: 2 })
  f.markPresent(0)
  await f.pass()
  assert.deepEqual(f.uploads, [{ path: f.rows[1].storage_path, id: 41 }])
  assert.equal(f.queue, null)
  assert.equal(f.rows.length, 2)
})

test('prepared full-only image reconciles without requiring a historical thumbnail', async () => {
  const f = fixture({ thumb: false })
  f.markPresent(0)
  await f.pass()
  assert.equal(f.queue, null)
  assert.equal(f.uploads.length, 0)
  assert.ok(f.checks.every(path => !path.includes('thumb_')))
})

test('unknown legacy variants are prepared and re-uploaded before finalization', async () => {
  const f = fixture({ unprepared: true })
  f.markPresent(0, false)
  await f.pass()
  assert.equal(f.uploads.length, 1)
  assert.equal(f.queue, null)
})

test('ambiguous HEAD preserves queue bytes and resumes when connectivity returns', async () => {
  const f = fixture()
  f.markPresent(0)
  f.failHeads(true)
  await f.pass()
  assert.ok(f.queue.imageEntries[0].uploadBytes)
  assert.equal(f.queue.syncStage, 'retrying')
  assert.equal(f.keyWrites.length, 0)
  f.failHeads(false)
  await f.pass()
  assert.equal(f.queue, null)
})

test('final confirmation refuses deletion if upload returns but expected thumbnail is absent', async () => {
  const f = fixture()
  f.omitThumbnail(true)
  await f.pass()
  assert.ok(f.queue.imageEntries[0].uploadBytes)
  assert.equal(f.successes.length, 0)
  f.omitThumbnail(false)
  await f.pass()
  assert.equal(f.uploads.length, 2)
  assert.equal(f.queue, null)
})
