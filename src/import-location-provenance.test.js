// Stage 3 location provenance through import review: per-photo EXIF source,
// mixed-photo GPS selection, late hydration, restore, and the save-time skip.
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from './auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import { INGEST_METHOD } from './observation-shapes.js'
import { loadImportSessions, saveImportSessions } from './import-store.js'
import {
  _applyMetadataToSession,
  _buildImportObservationPayload,
  _buildImportSourceItem,
  _flattenSourceItemsFromSessions,
  _stampConfirmedImportSkips,
  __setImportSourceItemsForTests,
} from './screens/import_review.js'

const T0 = Date.parse('2026-10-12T09:00:00Z')

function item(label, ingestMethod, gps = null, extra = {}) {
  const processed = {
    blob: new Blob([`photo-${label}`], { type: 'image/jpeg' }),
    aiBlob: new Blob([`ai-${label}`], { type: 'image/jpeg' }),
    meta: { aiCropRect: null, aiCropSourceW: 100, aiCropSourceH: 100, aiCropIsCustom: false },
  }
  return _buildImportSourceItem(`id-${label}`, {
    captureTime: T0 + (extra.offset || 0),
    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,
    altitude: gps?.altitude ?? null,
    accuracy: gps?.accuracy ?? null,
    writtenGpsSource: extra.writtenGpsSource ?? null,
  }, processed, ingestMethod)
}

function pair(payload) {
  return [payload?.location_source ?? null, payload?.location_status ?? null]
}

test('per-photo EXIF source: original images are image_exif, Sporely Cam EXIF is the fix Sporely wrote', () => {
  assert.equal(item('a', INGEST_METHOD.NATIVE_PICKER).gpsSource, 'image_exif')
  assert.equal(item('b', INGEST_METHOD.WEB_FILE_PICKER).gpsSource, 'image_exif')
  assert.equal(item('c', INGEST_METHOD.SYSTEM_CAMERA).gpsSource, 'image_exif')
  assert.equal(item('d', INGEST_METHOD.SPORELY_CAMERA, null, { writtenGpsSource: 'device_gps' }).gpsSource, 'device_gps')
  assert.equal(item('e', INGEST_METHOD.SPORELY_CAMERA).gpsSource, 'unknown')
})

test('mixed photo GPS selection: the group takes the source of the photo whose coordinates it uses', () => {
  const [session] = __setImportSourceItemsForTests([
    item('no-gps', INGEST_METHOD.WEB_FILE_PICKER, null, { offset: 0 }),
    item('cam', INGEST_METHOD.SPORELY_CAMERA, { lat: 63.1, lon: 10.1, accuracy: 5 }, { offset: 1000, writtenGpsSource: 'device_gps' }),
    item('exif', INGEST_METHOD.NATIVE_PICKER, { lat: 63.2, lon: 10.2, accuracy: 3 }, { offset: 2000 }),
  ])
  assert.equal(session.gpsLat, 63.1)
  assert.equal(session.gpsSource, 'device_gps')
  assert.deepEqual(session.photoGps.map(gps => gps.source), ['image_exif', 'device_gps', 'image_exif'])
  const { obsPayload } = _buildImportObservationPayload(session, { userId: 'test-user' })
  assert.deepEqual(pair(obsPayload), ['device_gps', 'acquired'])
  assert.equal(obsPayload.gps_latitude, 63.1)

  const [exifFirst] = __setImportSourceItemsForTests([
    item('exif', INGEST_METHOD.NATIVE_PICKER, { lat: 59.9, lon: 10.7 }, { offset: 0 }),
    item('cam', INGEST_METHOD.SPORELY_CAMERA, { lat: 59.8, lon: 10.6 }, { offset: 1000, writtenGpsSource: 'device_gps' }),
  ])
  assert.deepEqual(pair(_buildImportObservationPayload(exifFirst, { userId: 'test-user' }).obsPayload), ['image_exif', 'acquired'])
})

test('missing EXIF: no coordinates means no provenance until the user confirms the skip', () => {
  const [session] = __setImportSourceItemsForTests([item('plain', INGEST_METHOD.WEB_FILE_PICKER)])
  const { obsPayload } = _buildImportObservationPayload(session, { userId: 'test-user' })
  assert.deepEqual(pair(obsPayload), [null, null])
  assert.equal('location_source' in obsPayload, false)

  const named = { ...obsPayload, location: 'Nordmarka' }
  const bare = { ...obsPayload }
  const withCoords = { ...obsPayload, gps_latitude: 1, gps_longitude: 2, location_source: 'image_exif', location_status: 'acquired' }
  _stampConfirmedImportSkips([{ obsPayload: bare }, { obsPayload: named }, { obsPayload: withCoords }])
  assert.deepEqual(pair(bare), ['none', 'skipped'])
  // A group with only a place name was not part of the "save without location" confirmation.
  assert.deepEqual(pair(named), [null, null])
  assert.deepEqual(pair(withCoords), ['image_exif', 'acquired'])
})

test('late EXIF hydration updates provenance only when its coordinates win the group location', () => {
  const [session] = __setImportSourceItemsForTests([
    item('cam', INGEST_METHOD.SPORELY_CAMERA, null, { offset: 0, writtenGpsSource: 'device_gps' }),
    item('exif', INGEST_METHOD.NATIVE_PICKER, null, { offset: 1000 }),
  ])
  assert.equal(session.gpsLat, null)
  assert.equal(session.gpsSource, null)

  assert.equal(_applyMetadataToSession(session, 1, { lat: 58.0, lon: 7.0, accuracy: 6 }), true)
  assert.equal(session.gpsLat, 58.0)
  assert.equal(session.gpsSource, 'image_exif')

  // A later hydration of another photo does not replace the selected location or its source.
  _applyMetadataToSession(session, 0, { lat: 58.5, lon: 7.5, accuracy: 2 })
  assert.equal(session.gpsLat, 58.0)
  assert.equal(session.gpsSource, 'image_exif')
  assert.equal(session.photoGps[0].source, 'device_gps')
  assert.deepEqual(pair(_buildImportObservationPayload(session, { userId: 'test-user' }).obsPayload), ['image_exif', 'acquired'])
})

test('reorder/remove/restore keeps each photo GPS source with its own photo', () => {
  const sessions = __setImportSourceItemsForTests([
    item('cam', INGEST_METHOD.SPORELY_CAMERA, { lat: 61, lon: 9 }, { offset: 0, writtenGpsSource: 'device_gps' }),
    item('exif', INGEST_METHOD.NATIVE_PICKER, { lat: 62, lon: 8 }, { offset: 1000 }),
  ])
  const restored = _flattenSourceItemsFromSessions(sessions).reverse()
  assert.deepEqual(restored.map(entry => [entry.id, entry.gpsSource]), [['id-exif', 'image_exif'], ['id-cam', 'device_gps']])
  const [regrouped] = __setImportSourceItemsForTests(restored.filter(entry => entry.id !== 'id-cam'))
  assert.equal(regrouped.gpsSource, 'image_exif')
  assert.equal(regrouped.gpsLat, 62)
})

// ── Persistence through import-store (IndexedDB structured clone) ──────────
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

test('import sessions persist the group and per-photo GPS source across restart; legacy restores as unknown', async () => {
  const restoreIdb = installIndexedDb()
  try {
    const [session] = __setImportSourceItemsForTests([
      item('cam', INGEST_METHOD.SPORELY_CAMERA, { lat: 61, lon: 9, accuracy: 4 }, { offset: 0, writtenGpsSource: 'device_gps' }),
    ])
    await saveImportSessions([session])
    const [loaded] = await loadImportSessions()
    assert.equal(loaded.gpsSource, 'device_gps')
    assert.deepEqual(loaded.photoGps[0], { lat: 61, lon: 9, altitude: null, accuracy: 4, source: 'device_gps' })
    assert.deepEqual(pair(_buildImportObservationPayload(loaded, { userId: 'test-user' }).obsPayload), ['device_gps', 'acquired'])

    await saveImportSessions([{
      id: 'legacy',
      ts: new Date(T0),
      files: [new Blob(['old'])],
      imageMeta: [{}],
      photoTimes: [T0],
      photoGps: [{ lat: 60, lon: 10, altitude: null }],
      gpsLat: 60,
      gpsLon: 10,
    }])
    const [legacy] = await loadImportSessions()
    assert.equal(legacy.gpsSource, null)
    assert.deepEqual(pair(_buildImportObservationPayload(legacy, { userId: 'test-user' }).obsPayload), ['unknown', 'acquired'])
  } finally {
    restoreIdb()
  }
})
