import test from 'node:test'
import assert from 'node:assert/strict'

import { clearReviewDraft, loadReviewDraft, saveReviewDraft, updateReviewDraftFields } from './review-draft-store.js'

// Like real IndexedDB, put() replaces the record with the same keyPath id —
// the draft store relies on this (a single 'current' draft record).
function createIndexedDbStub() {
  const records = new Map()

  return {
    records,
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: {
            contains() {
              return true
            },
          },
          createObjectStore() {},
          transaction() {
            let completed = false
            const finish = () => {
              if (completed) return
              completed = true
              queueMicrotask(() => tx.oncomplete?.())
            }
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              objectStore() {
                return {
                  clear() {
                    records.clear()
                    finish()
                  },
                  put(record) {
                    records.set(record.id, structuredClone(record))
                    finish()
                  },
                  getAll() {
                    const req = {}
                    queueMicrotask(() => {
                      req.result = [...records.values()].map(record => structuredClone(record))
                      req.onsuccess?.({ target: req })
                      finish()
                    })
                    return req
                  },
                }
              },
            }
            return tx
          },
          close() {},
        }
        request.onsuccess?.({ target: request })
      })
      return request
    },
  }
}

function _withIndexedDbStub(fn) {
  return async () => {
    const previousIndexedDb = globalThis.indexedDB
    const stub = createIndexedDbStub()
    globalThis.indexedDB = { open: stub.open }
    try {
      await fn(stub)
    } finally {
      globalThis.indexedDB = previousIndexedDb
    }
  }
}

function _makeDraft(overrides = {}) {
  return {
    photos: [
      {
        blob: new Blob(['photo-1'], { type: 'image/webp' }),
        aiBlob: new Blob(['ai-1'], { type: 'image/jpeg' }),
        blobPromise: null,
        gps: { lat: 60.1, lon: 10.2, accuracy: 8, altitude: 120, timestamp: 1784700000000 },
        ts: new Date(1784700000000),
        emoji: '📸',
        taxon: { genus: 'Amanita', specificEpithet: 'muscaria' },
        aiCropRect: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
        aiCropSourceW: 800,
        aiCropSourceH: 600,
        aiCropIsCustom: true,
      },
      {
        blob: null,
        blobPromise: Promise.resolve(new Blob(['photo-2'], { type: 'image/png' })),
        gps: null,
        ts: new Date(1784700005000),
        emoji: '📸',
        taxon: null,
        aiCropRect: null,
        aiCropSourceW: null,
        aiCropSourceH: null,
        aiCropIsCustom: false,
      },
    ],
    sessionStartAt: new Date(1784699990000),
    captureWindowEndAt: 1784700095000,
    sessionFix: { lat: 60.1, lon: 10.2, accuracy: 5, altitude: 118, timestamp: 1784700001000 },
    captureDraft: { habitat: 'spruce forest', notes: 'under moss', uncertain: true, visibility: 'private', is_draft: true, location_precision: 'exact' },
    locationName: 'Nordmarka',
    ...overrides,
  }
}

test('review draft round-trips photos, blobs (incl. pending blobPromise), and session state', _withIndexedDbStub(async () => {
  await saveReviewDraft(_makeDraft())
  const restored = await loadReviewDraft()

  assert.ok(restored)
  assert.equal(restored.photos.length, 2)
  assert.equal(restored.photos[0].blob.type, 'image/webp')
  assert.equal(restored.photos[0].aiBlob.type, 'image/jpeg')
  assert.equal(restored.photos[1].blob.type, 'image/png')
  assert.equal(restored.photos[1].aiBlob.type, 'image/png')
  assert.equal(restored.photos[0].gps.lat, 60.1)
  assert.equal(restored.photos[0].taxon.genus, 'Amanita')
  assert.equal(restored.photos[0].aiCropIsCustom, true)
  assert.deepEqual(restored.photos[0].aiCropRect, { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 })
  assert.equal(restored.photos[1].gps, null)
  assert.equal(restored.photos[1].ts.getTime(), 1784700005000)
  assert.equal(restored.sessionStartAt, 1784699990000)
  assert.equal(restored.captureWindowEndAt, 1784700095000)
  assert.equal(restored.sessionFix.accuracy, 5)
  assert.equal(restored.captureDraft.habitat, 'spruce forest')
  assert.equal(restored.locationName, 'Nordmarka')
}))

test('a second save replaces the draft instead of accumulating records', _withIndexedDbStub(async stub => {
  await saveReviewDraft(_makeDraft())
  await saveReviewDraft(_makeDraft({ locationName: 'Second save' }))

  assert.equal(stub.records.size, 1)
  const restored = await loadReviewDraft()
  assert.equal(restored.locationName, 'Second save')
}))

test('updateReviewDraftFields merges fields without touching photos', _withIndexedDbStub(async () => {
  await saveReviewDraft(_makeDraft())
  await updateReviewDraftFields({
    captureDraft: { habitat: 'pine ridge', notes: '', uncertain: false, visibility: 'public', is_draft: false, location_precision: 'fuzzed' },
    locationName: 'Updated place',
  })

  const restored = await loadReviewDraft()
  assert.equal(restored.captureDraft.habitat, 'pine ridge')
  assert.equal(restored.captureDraft.location_precision, 'fuzzed')
  assert.equal(restored.locationName, 'Updated place')
  assert.equal(restored.photos.length, 2)
  assert.equal(restored.photos[0].blob.type, 'image/webp')
}))

test('updateReviewDraftFields is a no-op when no draft exists', _withIndexedDbStub(async stub => {
  await updateReviewDraftFields({ locationName: 'ghost' })
  assert.equal(stub.records.size, 0)
}))

test('clearReviewDraft removes the stored draft', _withIndexedDbStub(async () => {
  await saveReviewDraft(_makeDraft())
  await clearReviewDraft()
  assert.equal(await loadReviewDraft(), null)
}))

test('a draft with an unknown schema version is discarded on load', _withIndexedDbStub(async stub => {
  await saveReviewDraft(_makeDraft())
  const record = stub.records.get('current')
  record.schemaVersion = 999
  stub.records.set('current', record)

  assert.equal(await loadReviewDraft(), null)
  assert.equal(stub.records.size, 0)
}))

test('a draft with no photos is never persisted', _withIndexedDbStub(async stub => {
  await saveReviewDraft(_makeDraft({ photos: [] }))
  assert.equal(stub.records.size, 0)
}))

test('store failures degrade gracefully instead of throwing', async () => {
  const previousIndexedDb = globalThis.indexedDB
  const previousWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  globalThis.indexedDB = {
    open() {
      throw new Error('quota exceeded')
    },
  }
  try {
    await saveReviewDraft(_makeDraft())
    assert.equal(await loadReviewDraft(), null)
    await clearReviewDraft()
    assert.equal(warnings.length >= 2, true)
  } finally {
    console.warn = previousWarn
    globalThis.indexedDB = previousIndexedDb
  }
})
