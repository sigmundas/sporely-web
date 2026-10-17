/**
 * Ingestion provenance Stage 2 — required mixed-source regression.
 *
 * Uniquely identifiable photos A, B, C and D come from different entry points.
 * B is rejected, the survivors are sorted by capture time (the existing import
 * order) and grouped into observations by the existing photo-gap rule. Every
 * surviving photo's blob identity must stay paired with its own ingest_method
 * through payload construction, persisted-session recovery and queue
 * serialization. B is placed both first and in the interior of the capture
 * order so that indexing metadata against a pre-filter array is caught.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { AUTH_STATE, setAuthState } from './auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import { INGEST_METHOD, normalizeIngestMethod } from './observation-shapes.js'
import { loadImportSessions, saveImportSessions } from './import-store.js'
import { isSyncKey } from './sync-key.js'
import {
  _buildImportObservationPayload,
  _buildImportSourceItem,
  _flattenSourceItemsFromSessions,
  _sortByCaptureTime,
  __removeImportSourceItemsForTests,
  __setImportSourceItemsForTests,
} from './screens/import_review.js'

// ── Production queue (de)serialization, executed from source ────────────────
const queueSource = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
function functionSource(name) {
  const start = queueSource.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `Missing production function ${name}`)
  return queueSource.slice(start, queueSource.indexOf('\n}', start) + 2)
}
const queueContext = vm.createContext({
  Blob, ArrayBuffer, Uint8Array,
  isBlob: value => value instanceof Blob,
  normalizeIngestMethod,
  isSyncKey,
})
vm.runInContext([
  '_isArrayBuffer', '_blobFromStoredBytes', '_blobToStoredBytes',
  '_normalizeQueuedImages', '_serializeQueuedImageForStorage',
].map(functionSource).join('\n'), queueContext)

/** enqueue → IndexedDB (structured clone) → restart → normalize for upload. */
async function roundTripThroughQueue(imageEntries) {
  const queued = queueContext._normalizeQueuedImages(imageEntries)
  const stored = []
  for (const image of queued) stored.push(await queueContext._serializeQueuedImageForStorage(image))
  return queueContext._normalizeQueuedImages(structuredClone(stored))
}

// ── Minimal single-store IndexedDB for import-store.js ──────────────────────
function installIndexedDb() {
  const records = new Map()
  const previous = globalThis.indexedDB
  globalThis.indexedDB = {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            const tx = { oncomplete: null, onerror: null, onabort: null, error: null }
            const done = () => queueMicrotask(() => tx.oncomplete?.())
            tx.objectStore = () => ({
              clear() { records.clear(); done() },
              put(record) { records.set(record.id, structuredClone(record)); done() },
              getAll() {
                const req = {}
                queueMicrotask(() => {
                  req.result = [...records.values()].map(record => structuredClone(record))
                  req.onsuccess?.({ target: req })
                })
                return req
              },
            })
            return tx
          },
        }
        request.onsuccess?.({ target: request })
      })
      return request
    },
  }
  return () => { globalThis.indexedDB = previous }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const T0 = Date.parse('2026-10-12T09:00:00Z')
const MINUTE = 60_000

/**
 * Mixed-source photos A–D in *selection* order (not capture order), each with
 * valid, uniquely identifiable bytes. Capture times put A, B, C within one
 * photo-gap group and D in a later group. B sits first (early) or between
 * other photos (interior) in both the selection and the capture order.
 */
function selection(rejectedPosition) {
  const photo = (label, method, captureTime) => {
    const processed = {
      blob: new Blob([`photo-${label}`], { type: 'image/jpeg' }),
      aiBlob: new Blob([`ai-${label}`], { type: 'image/jpeg' }),
      meta: { aiCropRect: null, aiCropSourceW: 100, aiCropSourceH: 100, aiCropIsCustom: false },
    }
    // Production item construction; ids follow selection order here.
    return _buildImportSourceItem(`sel-${label}`, { captureTime }, processed, method)
  }
  const A = photo('A', INGEST_METHOD.WEB_CAMERA, T0)
  const C = photo('C', INGEST_METHOD.WEB_FILE_PICKER, T0 + 20_000)
  const D = photo('D', INGEST_METHOD.SYSTEM_CAMERA, T0 + 5 * MINUTE)
  if (rejectedPosition === 'early') {
    return [photo('B', INGEST_METHOD.NATIVE_PICKER, T0 - 10_000), D, C, A]
  }
  return [D, C, photo('B', INGEST_METHOD.NATIVE_PICKER, T0 + 10_000), A]
}

const EXPECTED = {
  'photo-A': INGEST_METHOD.WEB_CAMERA,
  'photo-C': INGEST_METHOD.WEB_FILE_PICKER,
  'photo-D': INGEST_METHOD.SYSTEM_CAMERA,
}

async function pairs(imageEntries) {
  return Promise.all(imageEntries.map(async entry => [await entry.blob.text(), entry.ingestMethod]))
}

function payloadsFor(sessions) {
  return sessions.map(session => _buildImportObservationPayload(session, { userId: 'test-user' }).imageEntries)
}

async function assertSurvivorsPaired(groups, stage) {
  const observed = await Promise.all(groups.map(pairs))
  assert.deepEqual(observed, [
    [['photo-A', EXPECTED['photo-A']], ['photo-C', EXPECTED['photo-C']]],
    [['photo-D', EXPECTED['photo-D']]],
  ], `${stage}: survivors must be sorted, grouped and keep their own method`)
}

/** Payload → persisted-session recovery → queue serialization, all asserted. */
async function assertPairedThroughPipeline(sessions, survivors) {
  assert.equal(sessions.length, 2)

  // 1. Payload construction. Identity is the very same blob object.
  const livePayloads = payloadsFor(sessions)
  await assertSurvivorsPaired(livePayloads, 'payload')
  const byLabel = new Map(await Promise.all(survivors.map(async item => [await item.blob.text(), item])))
  for (const entry of livePayloads.flat()) {
    const item = byLabel.get(await entry.blob.text())
    assert.equal(entry.blob, item.blob, 'payload keeps the original blob object')
    assert.equal(entry.ingestMethod, item.meta.ingestMethod)
  }

  // 2. Persisted-session recovery (app killed mid-review, restored and
  //    regrouped from the restored source items).
  await saveImportSessions(sessions)
  const loaded = await loadImportSessions()
  assert.equal(loaded.length, 2)
  const restored = __setImportSourceItemsForTests(_flattenSourceItemsFromSessions(loaded))
  const restoredPayloads = payloadsFor(restored)
  await assertSurvivorsPaired(restoredPayloads, 'restored session')

  // 3. Queue serialization and restart, per observation.
  const queued = []
  for (const entries of restoredPayloads) {
    queued.push(await roundTripThroughQueue(entries))
  }
  await assertSurvivorsPaired(queued, 'queue')
}

for (const rejectedPosition of ['early', 'interior']) {
  test(`mixed-source A–D: B rejected (${rejectedPosition}) before sorting keeps blob/method pairs end to end`, async () => {
    const restoreIdb = installIndexedDb()
    try {
      const selected = selection(rejectedPosition)
      const bIndex = selected.findIndex(item => item.meta.ingestMethod === INGEST_METHOD.NATIVE_PICKER)
      assert.equal(bIndex, rejectedPosition === 'early' ? 0 : 2, 'fixture places B as intended')

      // Reject B first, then reorder the survivors with the production
      // capture-time sort; their order must actually change.
      const survivors = selected.filter((_, index) => index !== bIndex)
      const selectionOrder = survivors.map(item => item.id)
      _sortByCaptureTime(survivors)
      assert.deepEqual(survivors.map(item => item.id), ['sel-A', 'sel-C', 'sel-D'])
      assert.notDeepEqual(selectionOrder, survivors.map(item => item.id))

      // Production photo-gap grouping into observations.
      const sessions = __setImportSourceItemsForTests(survivors)
      assert.deepEqual(sessions.map(session => session.sourceItemIds), [['sel-A', 'sel-C'], ['sel-D']])

      await assertPairedThroughPipeline(sessions, survivors)
    } finally {
      __setImportSourceItemsForTests([])
      restoreIdb()
    }
  })

  test(`mixed-source A–D: B removed (${rejectedPosition}) after grouping keeps blob/method pairs end to end`, async () => {
    const restoreIdb = installIndexedDb()
    try {
      const items = _sortByCaptureTime(selection(rejectedPosition))
      const b = items.find(item => item.meta.ingestMethod === INGEST_METHOD.NATIVE_PICKER)
      assert.equal(items.indexOf(b), rejectedPosition === 'early' ? 0 : 1)

      // B first shares an observation with A and C, then the strip-delete
      // control removes it and the survivors are regrouped.
      const initial = __setImportSourceItemsForTests(items)
      assert.equal(initial[0].files.length, 3)
      const sessions = __removeImportSourceItemsForTests([b.id])
      assert.equal(sessions[0].files.length, 2)

      await assertPairedThroughPipeline(sessions, items.filter(item => item !== b))
    } finally {
      __setImportSourceItemsForTests([])
      restoreIdb()
    }
  })
}

test('payload builder pairs metadata with its own blob when early/interior slots are not blobs', async () => {
  // A restored session can contain an unusable slot; filtering it must not
  // shift the next photo's metadata.
  const session = {
    id: 'gaps',
    ts: new Date(T0),
    files: [
      null,
      new Blob(['photo-A']),
      undefined,
      new Blob(['photo-C']),
    ],
    imageMeta: [
      { ingestMethod: INGEST_METHOD.NATIVE_PICKER, aiCropSourceW: 1 },
      { ingestMethod: INGEST_METHOD.WEB_CAMERA, aiCropSourceW: 2 },
      { ingestMethod: INGEST_METHOD.SPORELY_CAMERA, aiCropSourceW: 3 },
      { ingestMethod: INGEST_METHOD.WEB_FILE_PICKER, aiCropSourceW: 4 },
    ],
  }
  const { imageEntries } = _buildImportObservationPayload(session, { userId: 'test-user' })
  assert.deepEqual(await pairs(imageEntries), [
    ['photo-A', INGEST_METHOD.WEB_CAMERA],
    ['photo-C', INGEST_METHOD.WEB_FILE_PICKER],
  ])
  assert.deepEqual(imageEntries.map(entry => entry.aiCropSourceW), [2, 4])
})

test('restored pre-provenance import sessions keep a NULL ingest method', async () => {
  const restoreIdb = installIndexedDb()
  try {
    const legacy = {
      id: 'legacy',
      ts: new Date(T0),
      files: [new Blob(['photo-old'])],
      imageMeta: [{ aiCropRect: null, aiCropSourceW: null, aiCropSourceH: null, aiCropIsCustom: false }],
      photoTimes: [T0],
      photoGps: [{ lat: null, lon: null, altitude: null }],
    }
    await saveImportSessions([legacy])
    const [loaded] = await loadImportSessions()
    assert.equal(loaded.imageMeta[0].ingestMethod, null)
    const { imageEntries } = _buildImportObservationPayload(loaded, { userId: 'test-user' })
    assert.equal(imageEntries[0].ingestMethod, null)
  } finally {
    restoreIdb()
  }
})

// ── Entry-point assignment ──────────────────────────────────────────────────
// The method is fixed by the branch that actually opened the camera/picker.
// Real camera and picker hardware cannot run here (manual gate G2), so each
// entry point's branch-ordered assignments are pinned against the source.
// The Sporely-vs-system camera split is also exercised behaviourally in
// import_review.native-camera.test.js.
function functionBody(relativePath, name) {
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const start = text.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `Missing ${name} in ${relativePath}`)
  return text.slice(start, text.indexOf('\n}\n', start))
}

const ENTRY_POINTS = [
  ['./screens/capture.js', 'capturePhoto', ['UNKNOWN', 'WEB_CAMERA']], // demo frame, then live stream
  ['./screens/review.js', '_openCameraForReview', ['SPORELY_CAMERA']], // web branch → capture.js
  ['./screens/review.js', '_openPickerForReview', ['NATIVE_PICKER', 'WEB_FILE_PICKER']],
  ['./screens/find_detail.js', '_openCameraForDetail', ['SYSTEM_CAMERA', 'SPORELY_CAMERA']], // web branch keeps per-photo methods
  ['./screens/find_detail.js', '_openPickerForDetail', ['NATIVE_PICKER', 'WEB_FILE_PICKER']],
  ['./screens/import_review.js', 'openNativeCamera', ['SYSTEM_CAMERA', 'SPORELY_CAMERA']],
  ['./screens/import_review.js', '_handleNativePhotoResult', ['NATIVE_PICKER']],
  ['./screens/import_review.js', 'openFileImportPicker', ['WEB_FILE_PICKER']], // native branch → _handleNativePhotoResult
  ['./screens/import_review.js', 'handleFileSelect', ['WEB_FILE_PICKER']],
  ['./screens/import_review.js', '_openFileImportForSession', ['WEB_FILE_PICKER']],
  ['./screens/import_review.js', '_openCameraForSession', ['SYSTEM_CAMERA', 'SPORELY_CAMERA', 'UNKNOWN']], // `capture` input is unclassifiable
  ['./screens/import_review.js', '_openPickerForSession', ['NATIVE_PICKER', 'WEB_FILE_PICKER']],
]

for (const [file, name, expected] of ENTRY_POINTS) {
  test(`${name} assigns ${expected.join(', ')} from its own branches`, () => {
    const body = functionBody(file, name)
    const assigned = [...body.matchAll(/INGEST_METHOD\.([A-Z_]+)/g)].map(match => match[1])
    assert.deepEqual(assigned, expected)
    // Debug labels and settings are never provenance.
    assert.doesNotMatch(body, /ingestMethod\s*[:=]\s*[^,\n]*(captureSource|getUseSystemCamera)/)
  })
}

test('find-detail web capture pairs each photo method with its own file', () => {
  const body = functionBody('./screens/find_detail.js', '_openCameraForDetail')
  const loop = body.slice(body.indexOf('setCaptureCompleteHandler'))
  // The method is pushed in the same iteration as the file, after the skip.
  assert.ok(loop.indexOf('if (!blob) continue') < loop.indexOf('files.push('))
  assert.ok(loop.indexOf('files.push(') < loop.indexOf('ingestMethods.push(photo?.ingestMethod'))
  assert.match(loop, /_addPhotosToObservation\(files, ingestMethods\)/)
})
