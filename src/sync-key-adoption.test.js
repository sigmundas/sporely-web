// Stage 8 (sync-key identity): web/Android key creation and adoption.
//
// A fake cloud enforces the per-owner sync_key indexes and answers with the
// real constraint names. The real images.js inserts and the real queue
// processor run against it; only storage, auth and media are replaced.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { supabase } from './supabase.js'
import {
  buildObservationImageRowPayload, buildObservationImageStoragePath, getVariantPath, imageExtensionForMimeType,
  insertObservationImage, normalizeMediaKey, reserveObservationImage, syncObservationMediaKeys,
} from './images.js'
import { classifyQueueSyncError, _fieldsWrittenAfterInsert, _withQueuedSyncKeys } from './sync-queue.js'
import { normalizeIngestMethod } from './observation-shapes.js'
import * as syncKeyModule from './sync-key.js'
import {
  EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY, TAXONOMY_IDENTITY_CAPABILITY, TAXON_IDENTITY_COLUMNS, isProvenSporelySelection, persistObservationIdentification,
  persistObservationTaxonomySelection, resolveExternalTaxonomySelection, takeQueuedTaxonomySelection,
  taxonIdentityPatchForSelection,
} from './taxonomy-v2.js'
import { toCloudVisibility } from './visibility.js'
import { normalizeObservationGeography } from './observation-geography.js'
import { sanitizeQueuedLocationProvenance } from './location-provenance.js'

const { SYNC_KEY_INDEXES, isSyncKey } = syncKeyModule
const USER = 'user-1'

function fakeCloud() {
  const tables = { observations: [], observation_images: [] }
  const calls = []
  const injections = []
  let nextId = 100
  // inject(fn): fn(op) may return { error } to answer instead of the server,
  // or { lose: true } to apply the write and then lose the response.
  const inject = fn => injections.push(fn)
  // timestamptz filters compare instants, as Postgres does.
  const same = (a, b) => String(a) === String(b)
    || (/T\d\d:/.test(String(a)) && /T\d\d:/.test(String(b)) && Date.parse(a) === Date.parse(b))
  const matches = (row, filters) => filters.every(([column, value]) => (value === null ? row[column] == null : same(row[column], value)))
  function from(table) {
    const q = { table, filters: [], op: 'select', payload: null, limit: null }
    function run() {
      const op = { ...q, payload: q.payload && structuredClone(q.payload) }
      calls.push(op)
      for (const fn of injections) {
        const result = fn(op)
        if (result?.error) return { data: null, error: result.error }
        if (result?.lose) { apply(); return { data: null, error: { message: 'TypeError: Failed to fetch' } } }
      }
      return apply()
    }
    function apply() {
      const rows = tables[table] || (tables[table] = [])
      if (q.op === 'insert') {
        const payload = q.payload
        if (payload.sync_key && rows.some(row => row.user_id === payload.user_id && row.sync_key === payload.sync_key)) {
          return {
            data: null,
            error: {
              code: '23505',
              message: `duplicate key value violates unique constraint "${SYNC_KEY_INDEXES[table]}"`,
              details: 'Key (user_id, sync_key)=(…) already exists.',
            },
          }
        }
        const row = { id: nextId++, deleted_at: null, ...structuredClone(payload) }
        rows.push(row)
        return { data: structuredClone(row), error: null }
      }
      if (q.op === 'update') {
        for (const row of rows.filter(candidate => matches(candidate, q.filters))) Object.assign(row, structuredClone(q.payload))
        return { data: null, error: null }
      }
      if (q.op === 'delete') {
        for (const row of rows.filter(candidate => matches(candidate, q.filters))) rows.splice(rows.indexOf(row), 1)
        return { data: null, error: null }
      }
      const found = rows.filter(row => matches(row, q.filters)).map(row => structuredClone(row))
      return { data: q.single ? found[0] || null : found.slice(0, q.limit ?? found.length), error: null }
    }
    const builder = {
      insert(payload) { q.op = 'insert'; q.payload = payload; return builder },
      update(payload) { q.op = 'update'; q.payload = payload; return builder },
      delete() { q.op = 'delete'; return builder },
      select() { return builder },
      eq(column, value) { q.filters.push([column, value]); return builder },
      is(column, value) { q.filters.push([column, value]); return builder },
      order() { return builder },
      limit(count) { q.limit = count; return builder },
      single() { q.single = true; return Promise.resolve(run()) },
      maybeSingle() { q.single = true; return Promise.resolve(run()) },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
      catch() { return Promise.resolve(run()) },
    }
    return builder
  }
  // RPCs are mutations too; the identification writer is applied to the row.
  async function rpc(name, params) {
    const op = { op: 'rpc', table: name, payload: structuredClone(params), filters: [] }
    calls.push(op)
    let lose = false
    for (const fn of injections) {
      const result = fn(op)
      if (result?.error) return { data: null, error: result.error }
      if (result?.lose) lose = true
    }
    if (lose) {
      applyRpc(name, params)
      return { data: null, error: { message: 'TypeError: Failed to fetch' } }
    }
    applyRpc(name, params)
    return { data: null, error: null }
  }
  function applyRpc(name, params) {
    if (name === 'set_observation_identification_v2') {
      const row = tables.observations.find(candidate => String(candidate.id) === String(params.p_observation_id))
      if (row) {
        Object.assign(row, {
          selected_sporely_taxon_id: params.p_sporely_taxon_id,
          taxon_identity_state: params.p_identity_state,
          taxon_identity_source_system: params.p_source_system,
          taxon_identity_namespace: params.p_namespace,
          taxon_identity_external_id: params.p_external_id,
          taxon_identity_raw_external_id: params.p_raw_external_id,
        })
      }
    }
    return { data: null, error: null }
  }
  const isMutation = call => call.op === 'update' || call.op === 'delete' || call.op === 'rpc'
  return {
    tables, calls, inject, from, rpc,
    inserts: table => calls.filter(call => call.op === 'insert' && call.table === table),
    rpcs: name => calls.filter(call => call.op === 'rpc' && call.table === name),
    patches: () => calls.filter(isMutation),
    // Every write other than an insert must be the real media-key writer's
    // PATCH of this item's own observation (the normal upload step).
    assertOnlyOwnMediaKeyPatches(obsId) {
      for (const call of calls.filter(isMutation)) {
        assert.equal(call.op, 'update', 'no delete')
        assert.equal(call.table, 'observations', 'no image row is ever PATCHed')
        assertConditionalCoverFill(call, obsId)
      }
    },
  }
}

// A queue cover write sets both keys in one UPDATE, only where both are NULL.
function assertConditionalCoverFill(call, obsId = null) {
  assert.equal(call.op, 'update')
  assert.equal(call.table, 'observations')
  assert.deepEqual(Object.keys(call.payload).sort(), ['image_key', 'thumb_key'])
  assert.deepEqual(call.filters, [['id', obsId ?? call.filters[0][1]], ['image_key', null], ['thumb_key', null]])
}

async function withCloud(cloud, fn) {
  const original = { from: supabase.from, rpc: supabase.rpc }
  supabase.from = cloud.from
  supabase.rpc = cloud.rpc
  try { return await fn() } finally { Object.assign(supabase, original) }
}

const missingColumn = column => ({ code: 'PGRST204', message: `Could not find the '${column}' column of 'observation_images' in the schema cache` })

// ── images.js ───────────────────────────────────────────────────────────────

test('reserveObservationImage: every fallback payload keeps the same sync_key', async () => {
  const cloud = fakeCloud()
  const key = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
  let call = 0
  cloud.inject(op => {
    if (op.op !== 'insert') return null
    call++
    if (call === 1) return { error: missingColumn('ingest_method') }
    if (call === 2) return { error: missingColumn('ai_crop_is_custom') }
    return null
  })
  const row = await withCloud(cloud, () => reserveObservationImage({
    observation_id: 7, user_id: USER, sync_key: key, storage_path: `${USER}/7/a.webp`, ingestMethod: 'web_camera',
  }))
  const inserts = cloud.inserts('observation_images')
  assert.equal(inserts.length, 3)
  assert.deepEqual(inserts.map(insert => insert.payload.sync_key), [key, key, key])
  assert.equal('ingest_method' in inserts[1].payload, false)
  assert.equal('ai_crop_is_custom' in inserts[2].payload, false)
  assert.equal(row.sync_key, key)
  assert.equal('desktop_id' in inserts[0].payload, false)
})

test('reserveObservationImage mints a key for a direct upload that has none', async () => {
  const cloud = fakeCloud()
  await withCloud(cloud, () => reserveObservationImage({ observation_id: 7, user_id: USER, storage_path: `${USER}/7/a.webp` }))
  assert.ok(isSyncKey(cloud.inserts('observation_images')[0].payload.sync_key))
})

test('insertObservationImage: base, crop-only and upload-meta fallbacks all keep sync_key', async () => {
  const cloud = fakeCloud()
  const key = '2b4e28ba-2fa1-41d2-883f-0016d3cca427'
  let call = 0
  cloud.inject(op => {
    if (op.op !== 'insert') return null
    call++
    if (call === 1) return { error: missingColumn('upload_mode') }
    if (call === 2) return { error: missingColumn('ai_crop_x1') }
    return null
  })
  await withCloud(cloud, () => insertObservationImage({ observation_id: 7, user_id: USER, sync_key: key, storage_path: `${USER}/7/a.webp` }))
  const inserts = cloud.inserts('observation_images')
  assert.equal(inserts.length, 3)
  assert.deepEqual(inserts.map(insert => insert.payload.sync_key), [key, key, key])
  assert.equal('ai_crop_x1' in inserts[2].payload, false, 'last attempt is the base payload')
})

test('reserveObservationImage adopts a landed reservation and returns its reserved storage_path', async () => {
  const cloud = fakeCloud()
  const key = '3b4e28ba-2fa1-41d2-883f-0016d3cca427'
  const image = { observation_id: 7, user_id: USER, sync_key: key, image_type: 'field', sort_order: 0 }
  cloud.inject(op => (op.op === 'insert' && cloud.inserts('observation_images').length === 1 ? { lose: true } : null))
  await withCloud(cloud, async () => {
    await assert.rejects(reserveObservationImage({ ...image, storage_path: `${USER}/7/first.webp` }), error => /Failed to fetch/.test(error.message))
    const adopted = await reserveObservationImage({ ...image, storage_path: `${USER}/7/second.webp` })
    assert.equal(adopted.storage_path, `${USER}/7/first.webp`)
  })
  assert.equal(cloud.tables.observation_images.length, 1)
  assert.equal(cloud.patches().length, 0)
})

for (const [label, mutate, reason] of [
  ['differing content', row => { row.sort_order = 3 }, 'content'],
  ['another parent', row => { row.observation_id = 8 }, 'parent'],
  ['a tombstone', row => { row.deleted_at = '2026-10-16T00:00:00Z' }, 'deleted'],
]) {
  test(`reserveObservationImage fails visibly without PATCH when the adopted row has ${label}`, async () => {
    const cloud = fakeCloud()
    const key = '4b4e28ba-2fa1-41d2-883f-0016d3cca427'
    const image = { observation_id: 7, user_id: USER, sync_key: key, storage_path: `${USER}/7/a.webp`, sort_order: 0 }
    await withCloud(cloud, async () => {
      await reserveObservationImage(image)
      mutate(cloud.tables.observation_images[0])
      await assert.rejects(reserveObservationImage(image), error => error.code === 'sync_identity_conflict' && error.reason === reason)
    })
    assert.equal(cloud.patches().length, 0)
    assert.equal(cloud.tables.observation_images.length, 1)
  })
}

test('reserveObservationImage: other 23505, 23503 and 4xx answers are plain errors, never adoption', async () => {
  for (const error of [
    { code: '23505', message: 'duplicate key value violates unique constraint "observation_images_desktop_id_user_id_key"' },
    { code: '23503', message: 'insert or update on table "observation_images" violates foreign key constraint' },
    { code: '42501', message: 'new row violates row-level security policy' },
    { code: 'PGRST116', message: 'bad request', status: 400 },
  ]) {
    const cloud = fakeCloud()
    cloud.inject(op => (op.op === 'insert' ? { error } : null))
    await withCloud(cloud, async () => {
      await assert.rejects(
        reserveObservationImage({ observation_id: 7, user_id: USER, storage_path: `${USER}/7/a.webp` }),
        thrown => thrown === error,
      )
    })
    assert.equal(cloud.calls.filter(call => call.op === 'select').length, 0, `${error.code} must not look up a row to adopt`)
  }
})

// ── queue: keys on load ─────────────────────────────────────────────────────

test('items queued before keys gain stable keys on load; keyed items are untouched', () => {
  const legacy = {
    id: 1, syncInsertAttemptedAt: 5, obsPayload: { user_id: USER },
    imageEntries: [{ uploadBytes: null }, { uploadBytes: null }],
  }
  const keyed = _withQueuedSyncKeys(legacy)
  assert.ok(isSyncKey(keyed.obsPayload.sync_key))
  assert.ok(keyed.imageEntries.every(entry => isSyncKey(entry.syncKey) && entry.legacyRecoveryPending === true))
  assert.notEqual(keyed.imageEntries[0].syncKey, keyed.imageEntries[1].syncKey)
  assert.equal(keyed.legacyRecoveryPending, true, 'attempted before keys: one-time legacy lookup')
  // A second load keeps every key and returns the same object (no write).
  assert.equal(_withQueuedSyncKeys(keyed), keyed)
  // Never attempted / already linked items get keys but no legacy lookup.
  assert.equal(_withQueuedSyncKeys({ ...legacy, syncInsertAttemptedAt: null }).legacyRecoveryPending, undefined)
  assert.equal(_withQueuedSyncKeys({ ...legacy, remoteObservationId: 9 }).legacyRecoveryPending, undefined)
  // Raw Blob entries (oldest queue shape) keep their bytes.
  const blob = new Blob(['x'])
  const fromBlob = _withQueuedSyncKeys({ id: 2, obsPayload: { user_id: USER }, imageBlobs: [blob] })
  assert.equal(fromBlob.imageBlobs[0].blob, blob)
  assert.ok(isSyncKey(fromBlob.imageBlobs[0].syncKey))
})

test('enqueue mints the observation and image keys inside the queued item', () => {
  const source = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function _enqueueObservation(')
  const chunk = source.slice(start, source.indexOf('\n}', start))
  assert.match(chunk, /obsPayload: \{ \.\.\.obsPayload, sync_key: ensureSyncKey\(obsPayload\?\.sync_key\) \}/)
  assert.match(chunk, /syncKey: ensureSyncKey\(entry\.syncKey\)/)
  assert.ok(chunk.indexOf('ensureSyncKey') < chunk.indexOf('store.add(queueItem)'))
})

// ── queue: the real processor against the fake cloud ────────────────────────

const queueSource = fs.readFileSync(new URL('./sync-queue.js', import.meta.url), 'utf8')
function functionSource(name) {
  const start = queueSource.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `Missing production function ${name}`)
  // A closing brace alone on its line ends the function (`} = {}) {` does not).
  return queueSource.slice(start, queueSource.indexOf('\n}\n', start) + 2).replace(/^export /, '')
}
const processor = [
  '_normalizeQueueUserId', '_queueUserFromItem', '_isArrayBuffer', '_blobFromStoredBytes', '_blobToStoredBytes',
  '_normalizeQueuedImages', '_serializeQueuedImageForStorage', '_persistPreparedQueuedImage', '_queuedImageReservation',
  '_fetchRemoteObservationState', '_finalizeSyncedQueueItem', '_runSyncQueue', '_needsQueuedSyncKeys',
  '_withQueuedSyncKeys', '_ensureQueuedSyncKeys', 'shouldAttemptRemoteRecovery', 'pickRecoveredRemoteObservationId',
  '_findRemoteObservationForQueueItem', '_adoptObservationBySyncKey', '_retryObservationInsertWithoutProvenance',
  'buildQueueStatusUpdate', '_markQueueItemBlocked', '_verifyMissingQueuedReservation', '_fieldsWrittenAfterInsert',
  '_persistQueuedTaxonomyIdentity', '_selectionHasExternalProvenance', '_persistQueuedObservationIdentifications',
  '_identityColumnsForSelection', '_identityStateForSelection', '_coverIsOwnFirstImage', '_reconcileObservationIdentity',
  '_resolveTaxonomyWriteTarget',
].map(functionSource).join('\n')

function queueHarness(cloud, item, overrides = {}) {
  let queue = structuredClone(item)
  const objects = new Set()
  const uploads = []
  const successes = []
  let failUploads = false
  const noop = () => {}
  async function pass() {
    const context = vm.createContext({
      Blob, ArrayBuffer, Uint8Array, crypto, Date, Number, String, Object, Array, Set, Map, Error, Promise,
      console: { info: noop, warn: noop, error: noop, debug: noop },
      ...syncKeyModule, toCloudVisibility, normalizeObservationGeography, sanitizeQueuedLocationProvenance,
      isMissingLocationProvenanceError: () => false, withoutLocationProvenance: payload => payload,
      isBlob: value => value instanceof Blob, normalizeIngestMethod,
      getVariantPath, imageExtensionForMimeType, buildObservationImageStoragePath, classifyQueueSyncError,
      BLOCKED_QUEUE_STAGE: 'blocked', _cloudPlanCache: new Map(),
      canSyncOnCurrentConnection: () => true,
      canPerformCloudMutation: () => ({ allowed: true }),
      getSharedAuthSession: async () => ({ user: { id: USER } }),
      _readQueueItems: async () => (queue ? [structuredClone(queue)] : []),
      _updateQueueItem: async (id, update) => {
        if (!queue) return null
        queue = structuredClone(update(structuredClone(queue)))
        return structuredClone(queue)
      },
      _deleteQueueItem: async () => { queue = null },
      _setQueueSyncStatus: async (id, stage, extras = {}) => { if (queue) Object.assign(queue, { syncStage: stage, ...extras }) },
      _isBlockedQueueItem: value => value?.syncStage === 'blocked',
      _queueKeyForUser: () => 'queue:user',
      _debugQueue: noop, _warnBlockedQueueItemOnce: noop,
      startUploadForegroundService: noop, updateUploadForegroundService: noop,
      // The real taxonomy extraction and identification writer (its RPC goes
      // to the fake cloud and is recorded); AI runs are recorded as writes.
      takeQueuedTaxonomySelection, isProvenSporelySelection, persistObservationIdentification,
      persistObservationTaxonomySelection, resolveExternalTaxonomySelection, taxonIdentityPatchForSelection,
      normalizeMediaKey,
      _isDebugQueueEnabled: () => false,
      saveIdentificationRun: async run => { cloud.calls.push({ op: 'rpc', table: 'saveIdentificationRun', payload: structuredClone(run), filters: [] }) },
      fetchCloudPlanProfile: async () => ({ uploadMode: 'reduced', qualityProfile: 'standard' }),
      prepareImageVariants: async blob => ({ uploadBlob: blob, variants: {}, uploadMeta: { upload_mode: 'reduced', quality_profile: 'standard' } }),
      reserveObservationImage, // the real one, against the fake cloud
      deleteObservationMedia: async () => {},
      uploadPreparedObservationImageVariants: async (image, path, options) => {
        if (failUploads) throw new TypeError('Failed to fetch')
        uploads.push({ path, id: options.imageId })
        overrides.duringUpload?.()
        objects.add(path)
      },
      verifyWorkerObjectExists: async path => objects.has(path),
      syncObservationMediaKeys, // the real writer: its PATCHes are recorded
      buildObservationImageRowPayload,
      supabase,
      notifyQueueChanged: noop, notifySyncSuccess: result => successes.push(result),
      _scheduleSyncRetry: noop,
      ...(overrides.context || {}),
    })
    vm.runInContext(processor, context)
    await withCloud(cloud, () => context._runSyncQueue())
  }
  return { pass, uploads, successes, get queue() { return queue }, failUploads(value) { failUploads = value } }
}

const OBS_KEY = '5b4e28ba-2fa1-41d2-883f-0016d3cca427'
const IMG_KEY = '6b4e28ba-2fa1-41d2-883f-0016d3cca427'
function queuedItem(extra = {}) {
  return {
    id: 1, ts: 1, userId: USER, queueUserId: USER,
    obsPayload: { user_id: USER, sync_key: OBS_KEY, date: '2026-10-16', captured_at: '2026-10-16T10:00:00.000Z', notes: 'cap', visibility: 'public' },
    imageEntries: [{
      uploadBytes: new Uint8Array([1, 2, 3]).buffer, uploadType: 'image/webp',
      uploadMeta: { upload_mode: 'reduced', quality_profile: 'standard' }, syncKey: IMG_KEY,
    }],
    ...extra,
  }
}

test('queue: a lost observation insert response is retried with the same key and adopted', async () => {
  const cloud = fakeCloud()
  cloud.inject(op => (op.op === 'insert' && op.table === 'observations' && cloud.inserts('observations').length === 1 ? { lose: true } : null))
  const h = queueHarness(cloud, queuedItem())
  await h.pass()
  assert.equal(h.queue.syncStage, 'retrying')
  assert.equal(cloud.tables.observations.length, 1, 'the first POST landed')
  await h.pass()
  assert.equal(h.queue, null, 'finalized')
  const inserts = cloud.inserts('observations')
  assert.deepEqual(inserts.map(insert => insert.payload.sync_key), [OBS_KEY, OBS_KEY])
  assert.ok(inserts.every(insert => !('desktop_id' in insert.payload)))
  assert.equal(cloud.tables.observations.length, 1, 'no duplicate')
  assert.equal(cloud.tables.observation_images.length, 1)
  assert.equal(cloud.tables.observation_images[0].observation_id, cloud.tables.observations[0].id)
  assert.equal(cloud.tables.observation_images[0].sync_key, IMG_KEY)
  // The adopted row's fields are untouched; the only write after the insert
  // is the normal cover-image step on this item's own observation.
  assert.equal(cloud.tables.observations[0].notes, 'cap')
  assert.ok(cloud.patches().length >= 1, 'the real media-key writer ran')
  cloud.assertOnlyOwnMediaKeyPatches(cloud.tables.observations[0].id)
})

test('queue: a lost image reservation response is adopted and uploads to the reserved key', async () => {
  const cloud = fakeCloud()
  cloud.inject(op => (op.op === 'insert' && op.table === 'observation_images' && cloud.inserts('observation_images').length === 1 ? { lose: true } : null))
  const h = queueHarness(cloud, queuedItem())
  await h.pass()
  assert.equal(h.queue.syncStage, 'retrying')
  assert.equal(h.uploads.length, 0)
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.tables.observation_images.length, 1, 'one image row')
  assert.deepEqual(cloud.inserts('observation_images').map(insert => insert.payload.sync_key), [IMG_KEY, IMG_KEY])
  assert.deepEqual(h.uploads, [{ path: cloud.tables.observation_images[0].storage_path, id: cloud.tables.observation_images[0].id }])
  cloud.assertOnlyOwnMediaKeyPatches(cloud.tables.observations[0].id)
})

test('queue: an adopted observation that differs fails visibly, without PATCH, and keeps the item', async () => {
  const cloud = fakeCloud()
  cloud.inject(op => (op.op === 'insert' && op.table === 'observations' && cloud.inserts('observations').length === 1 ? { lose: true } : null))
  const h = queueHarness(cloud, queuedItem())
  await h.pass()
  cloud.tables.observations[0].notes = 'edited on another device'
  await h.pass()
  assert.equal(h.queue.syncStage, 'blocked')
  assert.equal(h.queue.syncErrorCode, 'sync_identity_conflict')
  assert.equal(h.queue.remoteObservationId, undefined, 'not linked')
  assert.equal(cloud.patches().length, 0)
  assert.equal(cloud.tables.observations.length, 1)
  assert.equal(cloud.tables.observations[0].notes, 'edited on another device')
  assert.equal(cloud.tables.observation_images.length, 0)
})

test('queue: other 23505, 23503 and 4xx answers stay plain retryable errors', async () => {
  for (const error of [
    { code: '23505', message: 'duplicate key value violates unique constraint "observations_desktop_id_user_id_key"' },
    { code: '23503', message: 'insert or update on table "observations" violates foreign key constraint' },
    { code: '22P02', message: 'invalid input syntax', status: 400 },
  ]) {
    const cloud = fakeCloud()
    cloud.inject(op => (op.op === 'insert' ? { error } : null))
    const h = queueHarness(cloud, queuedItem())
    await h.pass()
    assert.equal(h.queue.syncStage, 'retrying', error.code)
    assert.equal(h.queue.remoteObservationId, undefined)
    assert.equal(cloud.calls.some(call => call.filters.some(([column]) => column === 'sync_key')), false, `${error.code} is not adoption`)
  }
})

const legacyObservation = (extra = {}) => ({
  id: 42, user_id: USER, sync_key: null, date: '2026-10-16', captured_at: '2026-10-16T10:00:00+00:00', notes: 'cap', visibility: 'public',
  image_key: null, thumb_key: null, selected_sporely_taxon_id: null, ...extra,
})
function legacyItem(extraPayload = {}) {
  const legacy = queuedItem({ syncInsertAttemptedAt: 5 })
  delete legacy.obsPayload.sync_key
  delete legacy.imageEntries[0].syncKey
  Object.assign(legacy.obsPayload, extraPayload)
  return legacy
}
const SELECTION = { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '167' }

test('queue: a pre-key item links its equal keyless row and never writes it, across a retry', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(legacyObservation())
  const before = structuredClone(cloud.tables.observations[0])
  const h = queueHarness(cloud, legacyItem())
  h.failUploads(true)
  await h.pass()
  assert.equal(h.queue.remoteObservationId, 42)
  assert.equal(h.queue.remoteObservationRecovery, 'legacy', 'the disposition is persisted with the link')
  h.failUploads(false)
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.inserts('observations').length, 0, 'linked, not re-inserted')
  assert.equal(cloud.tables.observation_images[0].observation_id, 42, 'only a child row is added')
  assert.deepEqual(cloud.patches(), [], 'no PATCH, RPC or delete of any kind')
  assert.deepEqual(cloud.tables.observations[0], before, 'the matched observation is unchanged, cover included')
})

test('queue: a pre-key item never links a keyless row whose cover was set; its cover stays unchanged', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(legacyObservation({ image_key: `${USER}/42/cover.webp`, thumb_key: `${USER}/42/thumb_cover.webp` }))
  const before = structuredClone(cloud.tables.observations[0])
  const h = queueHarness(cloud, legacyItem())
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.tables.observations.length, 2, 'a new keyed row instead')
  assert.deepEqual(cloud.tables.observations[0], before, 'the existing cover values are untouched')
  cloud.assertOnlyOwnMediaKeyPatches(cloud.tables.observations[1].id)
})

test('queue: a pre-key item with a taxonomy identity to write is not linked; the RPC targets only its new row', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(legacyObservation())
  const before = structuredClone(cloud.tables.observations[0])
  const h = queueHarness(cloud, legacyItem({ taxonomySelection: SELECTION }))
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.tables.observations.length, 2)
  assert.deepEqual(cloud.tables.observations[0], before)
  const rpcs = cloud.rpcs('set_observation_identification_v2')
  assert.equal(rpcs.length, 1)
  assert.equal(rpcs[0].payload.p_observation_id, cloud.tables.observations[1].id)
})

test('queue: a pre-key item with AI identification runs is not linked', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(legacyObservation())
  const run = { service: 'artsorakel', requestFingerprint: 'f', status: 'success', results: [] }
  const h = queueHarness(cloud, legacyItem({ aiIdentificationRuns: [run] }))
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.tables.observations.length, 2)
  const writes = cloud.rpcs('saveIdentificationRun')
  assert.deepEqual(writes.map(write => write.payload.observationId), [cloud.tables.observations[1].id])
})

test('fields written after the INSERT cover the cover keys and every taxonomy identity column', () => {
  const row = Object.fromEntries(['image_key', 'thumb_key', 'selected_sporely_taxon_id', ...TAXON_IDENTITY_COLUMNS].map(field => [field, 'x']))
  assert.deepEqual(_fieldsWrittenAfterInsert(row).sort(), Object.keys(row).sort())
  assert.deepEqual(_fieldsWrittenAfterInsert({ image_key: null, thumb_key: '', notes: 'n' }), [])
})

// Lose the keyed INSERT's response, change the landed row, then retry.
async function adoptAfterEdit(edit, payloadExtra = {}) {
  const cloud = fakeCloud()
  cloud.inject(op => (op.op === 'insert' && op.table === 'observations' && cloud.inserts('observations').length === 1 ? { lose: true } : null))
  const item = queuedItem()
  Object.assign(item.obsPayload, payloadExtra)
  const h = queueHarness(cloud, item)
  await h.pass()
  edit(cloud.tables.observations[0])
  const before = structuredClone(cloud.tables.observations[0])
  await h.pass()
  return { cloud, h, before }
}

test('queue: keyed adoption fails visibly, with no RPC or PATCH, when the taxonomy was changed elsewhere', async () => {
  const { cloud, h, before } = await adoptAfterEdit(row => {
    Object.assign(row, { selected_sporely_taxon_id: '999', taxon_identity_state: 'sporely_v2' })
  }, { taxonomySelection: SELECTION })
  assert.equal(h.queue.syncStage, 'blocked')
  assert.equal(h.queue.syncErrorCode, 'sync_identity_conflict')
  assert.deepEqual(cloud.patches(), [], 'the real identification writer never ran')
  assert.deepEqual(cloud.tables.observations[0], before)
})

test('queue: keyed adoption fails visibly when a cover was set elsewhere', async () => {
  const { cloud, h, before } = await adoptAfterEdit(row => { row.image_key = 'x/cover.webp'; row.thumb_key = 'x/thumb_cover.webp' })
  assert.equal(h.queue.syncStage, 'blocked')
  assert.deepEqual(cloud.patches(), [])
  assert.deepEqual(cloud.tables.observations[0], before)
})

test('queue: keyed adoption of an untouched row resumes its own identity write once', async () => {
  const { cloud, h } = await adoptAfterEdit(() => {}, { taxonomySelection: SELECTION })
  assert.equal(h.queue, null)
  const rpcs = cloud.rpcs('set_observation_identification_v2')
  assert.equal(rpcs.length, 1)
  assert.equal(rpcs[0].payload.p_observation_id, cloud.tables.observations[0].id)
  assert.equal(rpcs[0].payload.p_sporely_taxon_id, '167')
  assert.equal(cloud.tables.observations.length, 1)
})

const identityOf = row => ({
  selected_sporely_taxon_id: row.selected_sporely_taxon_id,
  taxon_identity_state: row.taxon_identity_state,
  taxon_identity_external_id: row.taxon_identity_external_id,
})
const OTHER_IDENTITY = {
  selected_sporely_taxon_id: '999', taxon_identity_state: 'sporely_v2', taxon_identity_source_system: 'sporely',
  taxon_identity_namespace: 'sporely_taxon_id', taxon_identity_external_id: '999', taxon_identity_raw_external_id: null,
}

test('queue: an identity written once is never rewritten; a later edit elsewhere survives a failed upload and retry', async () => {
  // The sparring probe: lose the INSERT response, adopt on retry and write
  // 167, fail the media upload, change the identity elsewhere, retry.
  const cloud = fakeCloud()
  cloud.inject(op => (op.op === 'insert' && op.table === 'observations' && cloud.inserts('observations').length === 1 ? { lose: true } : null))
  const item = queuedItem()
  item.obsPayload.taxonomySelection = SELECTION
  const h = queueHarness(cloud, item)
  await h.pass()
  h.failUploads(true)
  await h.pass()
  assert.equal(cloud.rpcs('set_observation_identification_v2').length, 1, 'own identity written once')
  assert.equal(h.queue.taxonomyIdentityDone, true, 'the completed step is persisted')
  Object.assign(cloud.tables.observations[0], OTHER_IDENTITY)
  const mutationsBefore = cloud.patches().length
  h.failUploads(false)
  await h.pass()
  assert.equal(h.queue, null, 'pending media work still completes')
  assert.equal(cloud.rpcs('set_observation_identification_v2').length, 1, 'no second identity RPC')
  assert.deepEqual(identityOf(cloud.tables.observations[0]), identityOf(OTHER_IDENTITY), "the other client's edit survives")
  // The retry's only observation write fills the still-empty cover of its own row.
  for (const call of cloud.patches().slice(mutationsBefore)) assertConditionalCoverFill(call)
})

test('queue: a pending identity write re-reads the row and fails visibly when it was edited elsewhere', async () => {
  const cloud = fakeCloud()
  let rpcFails = true
  cloud.inject(op => (op.op === 'rpc' && rpcFails ? { error: { code: '57014', message: 'canceling statement' } } : null))
  const item = queuedItem()
  item.obsPayload.taxonomySelection = SELECTION
  const h = queueHarness(cloud, item)
  await h.pass()
  assert.equal(h.queue.syncStage, 'retrying', 'the identity RPC failed')
  assert.notEqual(h.queue.taxonomyIdentityDone, true)
  Object.assign(cloud.tables.observations[0], OTHER_IDENTITY)
  rpcFails = false
  const rpcsBefore = cloud.rpcs('set_observation_identification_v2').length
  await h.pass()
  assert.equal(h.queue.syncStage, 'blocked')
  assert.equal(h.queue.syncErrorCode, 'sync_identity_conflict')
  assert.equal(cloud.rpcs('set_observation_identification_v2').length, rpcsBefore, 'no identity RPC')
  assert.deepEqual(identityOf(cloud.tables.observations[0]), identityOf(OTHER_IDENTITY))
})

test('queue: an unchanged copy of a completed item adopts its equal populated rows without any write', async () => {
  const cloud = fakeCloud()
  const item = queuedItem()
  item.obsPayload.taxonomySelection = SELECTION
  const first = queueHarness(cloud, item)
  await first.pass()
  assert.equal(first.queue, null)
  const obs = cloud.tables.observations[0]
  assert.equal(String(obs.selected_sporely_taxon_id), '167')
  assert.ok(obs.image_key, 'the first item set its cover')
  const before = structuredClone(cloud.tables)
  const mutationsBefore = cloud.patches().length
  // The same queued item again (same observation and image keys, same identity).
  const copy = queueHarness(cloud, item)
  await copy.pass()
  assert.equal(copy.queue, null, 'adopted and finalized, not blocked')
  assert.equal(cloud.patches().length, mutationsBefore, 'no PATCH, RPC or delete')
  assert.deepEqual(cloud.tables, before, 'no row created or changed')
  assert.deepEqual(copy.uploads.map(upload => upload.path), [cloud.tables.observation_images[0].storage_path], 'bytes go to the adopted reserved key')
})

test('queue: keyed adoption fails visibly when the populated cover is not this item\'s own first image', async () => {
  const cloud = fakeCloud()
  const item = queuedItem()
  const first = queueHarness(cloud, item)
  await first.pass()
  Object.assign(cloud.tables.observations[0], { image_key: `${USER}/x/other.webp`, thumb_key: `${USER}/x/thumb_other.webp` })
  const before = structuredClone(cloud.tables.observations[0])
  const mutationsBefore = cloud.patches().length
  const copy = queueHarness(cloud, item)
  await copy.pass()
  assert.equal(copy.queue.syncStage, 'blocked')
  assert.equal(cloud.patches().length, mutationsBefore)
  assert.deepEqual(cloud.tables.observations[0], before)
})

test('queue: a pre-key item whose keyless match differs inserts a new keyed row instead', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push({
    id: 42, user_id: USER, sync_key: null, date: '2026-10-16', captured_at: '2026-10-16T10:00:00+00:00', notes: 'another device', visibility: 'public',
  })
  const legacy = queuedItem({ syncInsertAttemptedAt: 5 })
  delete legacy.obsPayload.sync_key
  const h = queueHarness(cloud, legacy)
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.tables.observations.length, 2)
  assert.equal(cloud.tables.observations[0].notes, 'another device', 'the matched row is never written')
  assert.ok(isSyncKey(cloud.tables.observations[1].sync_key))
  assert.equal(cloud.tables.observations[0].image_key, undefined, 'the matched row is not given our media')
  cloud.assertOnlyOwnMediaKeyPatches(cloud.tables.observations[1].id)
})

// ── queue: saved and pre-key image reservations (sparring findings 1 and 2) ──

const LINKED_OBS = 42
function linkedObservation() {
  return { id: LINKED_OBS, user_id: USER, sync_key: OBS_KEY, date: '2026-10-16', notes: 'cap', visibility: 'public' }
}
function imageRow(extra = {}) {
  return {
    id: 70, observation_id: LINKED_OBS, user_id: USER, sync_key: null, storage_path: `${USER}/${LINKED_OBS}/legacy.webp`,
    image_type: 'field', sort_order: 0, ai_crop_x1: null, ai_crop_y1: null, ai_crop_x2: null, ai_crop_y2: null,
    ai_crop_source_w: null, ai_crop_source_h: null, ai_crop_is_custom: false, upload_mode: 'reduced',
    source_width: null, source_height: null, stored_width: null, stored_height: null, stored_bytes: null,
    storage_exif_safe: false, deleted_at: null, ...extra,
  }
}
// An item linked before keys existed, whose image key is minted on load.
function preKeyImageItem(entryExtra = {}) {
  const item = queuedItem({ remoteObservationId: LINKED_OBS })
  delete item.imageEntries[0].syncKey
  Object.assign(item.imageEntries[0], entryExtra)
  return item
}
const legacyPath = `${USER}/${LINKED_OBS}/legacy.webp`

test('queue: a pre-key image reuses its own equal keyless row at its position', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(linkedObservation())
  cloud.tables.observation_images.push(imageRow())
  const h = queueHarness(cloud, preKeyImageItem())
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.inserts('observation_images').length, 0)
  assert.deepEqual(h.uploads, [{ path: legacyPath, id: 70 }])
  cloud.assertOnlyOwnMediaKeyPatches(LINKED_OBS)
})

for (const [label, rows] of [
  ['differing crop metadata', [imageRow({ ai_crop_x1: 0.25, ai_crop_x2: 0.75 })]],
  ['ambiguous keyless rows', [imageRow(), imageRow({ id: 71, storage_path: `${USER}/${LINKED_OBS}/other.webp` })]],
]) {
  test(`queue: a pre-key image with ${label} leaves the existing row and media alone`, async () => {
    const cloud = fakeCloud()
    cloud.tables.observations.push(linkedObservation())
    cloud.tables.observation_images.push(...rows)
    const before = structuredClone(cloud.tables.observation_images)
    const h = queueHarness(cloud, preKeyImageItem())
    await h.pass()
    assert.equal(h.queue, null)
    const inserted = cloud.inserts('observation_images')
    assert.equal(inserted.length, 1, 'a fresh keyed row')
    assert.ok(isSyncKey(inserted[0].payload.sync_key))
    const fresh = cloud.tables.observation_images.find(row => row.sync_key === inserted[0].payload.sync_key)
    assert.deepEqual(h.uploads, [{ path: fresh.storage_path, id: fresh.id }])
    assert.ok(h.uploads.every(upload => !before.some(row => row.storage_path === upload.path)), 'no bytes written to an existing key')
    assert.deepEqual(cloud.tables.observation_images.filter(row => row.id !== fresh.id), before, 'existing rows unchanged')
    cloud.assertOnlyOwnMediaKeyPatches(LINKED_OBS)
  })
}

test('queue: a saved reservation that was tombstoned fails visibly without uploading or writing', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(linkedObservation())
  cloud.tables.observation_images.push(imageRow({ sync_key: IMG_KEY, deleted_at: '2026-10-16T12:00:00Z' }))
  const item = queuedItem({ remoteObservationId: LINKED_OBS })
  item.imageEntries[0].reservedImageId = 70
  const h = queueHarness(cloud, item)
  await h.pass()
  assert.equal(h.queue.syncStage, 'blocked')
  assert.equal(h.queue.syncErrorCode, 'sync_identity_conflict')
  assert.deepEqual(h.uploads, [])
  assert.equal(cloud.inserts('observation_images').length, 0)
  assert.equal(cloud.patches().length, 0, 'no observation media reference rewritten')
})

test('queue: a saved reservation under another observation fails visibly without uploading', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(linkedObservation())
  cloud.tables.observation_images.push(imageRow({ sync_key: IMG_KEY, observation_id: 99 }))
  const item = queuedItem({ remoteObservationId: LINKED_OBS })
  item.imageEntries[0].reservedImageId = 70
  const h = queueHarness(cloud, item)
  await h.pass()
  assert.equal(h.queue.syncStage, 'blocked')
  assert.deepEqual(h.uploads, [])
  assert.equal(cloud.patches().length, 0)
})

test('queue: a saved reservation that no longer exists is reserved again with the same key', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(linkedObservation())
  const item = queuedItem({ remoteObservationId: LINKED_OBS })
  item.imageEntries[0].reservedImageId = 70
  const h = queueHarness(cloud, item)
  await h.pass()
  assert.equal(h.queue, null)
  const inserted = cloud.inserts('observation_images')
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].payload.sync_key, IMG_KEY)
  const row = cloud.tables.observation_images[0]
  assert.deepEqual(h.uploads, [{ path: row.storage_path, id: row.id }])
  assert.notEqual(row.id, 70)
})

test('queue: a saved reservation whose sort_order changed keeps its reserved path', async () => {
  const cloud = fakeCloud()
  cloud.tables.observations.push(linkedObservation())
  cloud.tables.observation_images.push(imageRow({ sync_key: IMG_KEY, sort_order: 3 }))
  const item = queuedItem({ remoteObservationId: LINKED_OBS })
  item.imageEntries[0].reservedImageId = 70
  const h = queueHarness(cloud, item)
  await h.pass()
  assert.equal(h.queue, null)
  assert.equal(cloud.inserts('observation_images').length, 0)
  assert.deepEqual(h.uploads, [{ path: legacyPath, id: 70 }])
})

// ── queue: cover fills decided by the UPDATE; resolved identity recovery ─────

test('queue: a cover set elsewhere during the upload is never replaced', async () => {
  const cloud = fakeCloud()
  const other = { image_key: `${USER}/x/other.webp`, thumb_key: `${USER}/x/thumb_other.webp` }
  const h = queueHarness(cloud, queuedItem(), {
    // Another client sets the cover after this pass read the row.
    duringUpload: () => Object.assign(cloud.tables.observations[0], other),
  })
  await h.pass()
  assert.equal(h.queue, null, 'the upload itself still completes')
  assert.equal(cloud.tables.observations[0].image_key, other.image_key)
  assert.equal(cloud.tables.observations[0].thumb_key, other.thumb_key)
  for (const call of cloud.patches()) assertConditionalCoverFill(call, cloud.tables.observations[0].id)
})

test('queue: a partially populated cover is left exactly as it is', async () => {
  for (const partial of [{ image_key: `${USER}/x/only.webp`, thumb_key: null }, { image_key: null, thumb_key: `${USER}/x/thumb_only.webp` }]) {
    const cloud = fakeCloud()
    cloud.tables.observations.push({ ...linkedObservation(), ...partial })
    const h = queueHarness(cloud, queuedItem({ remoteObservationId: LINKED_OBS }))
    await h.pass()
    assert.equal(h.queue, null)
    assert.equal(cloud.tables.observations[0].image_key, partial.image_key)
    assert.equal(cloud.tables.observations[0].thumb_key, partial.thumb_key)
    for (const call of cloud.patches()) assertConditionalCoverFill(call, LINKED_OBS)
  }
})

test('queue: an empty cover is still filled with this item\'s own first image', async () => {
  const cloud = fakeCloud()
  const h = queueHarness(cloud, queuedItem())
  await h.pass()
  const image = cloud.tables.observation_images[0]
  assert.equal(cloud.tables.observations[0].image_key, normalizeMediaKey(image.storage_path))
  assert.equal(cloud.tables.observations[0].thumb_key, getVariantPath(normalizeMediaKey(image.storage_path), 'thumb'))
})

test('queue: a resolved identity whose write landed but whose response was lost is recognised on restart', async () => {
  // An external selection that the resolver turns into a Sporely id: the
  // cloud then holds the RESOLVED identity, not the queued unresolved one.
  const unresolved = {
    capability: EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: null, sourceSystem: 'nbic', namespace: 'nortaxa_taxon_id',
    externalId: '53482', rawExternalId: 'NBIC:53482', scientificName: 'Amanita muscaria', taxonRank: null,
  }
  const resolved = { ...unresolved, capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821', resolvedFromExternalId: true }
  const resolutions = []
  const context = {
    // First attempt resolves; later attempts find no mapping (unresolved).
    resolveExternalTaxonomySelection: async selection => { resolutions.push(selection); return resolutions.length === 1 ? resolved : selection },
  }
  const cloud = fakeCloud()
  let lost = false
  cloud.inject(op => (op.op === 'rpc' && op.table === 'set_observation_identification_v2' && !lost ? (lost = true, { lose: true }) : null))
  const item = queuedItem()
  item.obsPayload.taxonomySelection = unresolved
  const h = queueHarness(cloud, item, { context })
  await h.pass()
  assert.equal(h.queue.syncStage, 'retrying', 'the RPC response was lost')
  assert.equal(String(cloud.tables.observations[0].selected_sporely_taxon_id), '7821', 'the server write landed')
  assert.notEqual(h.queue.taxonomyIdentityDone, true)
  assert.deepEqual(h.queue.taxonomyWriteTargets.map(target => target.sporelyTaxonId), ['7821'], 'the exact target was saved before the RPC')
  await h.pass()
  assert.equal(h.queue, null, 'restart recognises its own write and completes')
  assert.equal(cloud.rpcs('set_observation_identification_v2').length, 1, 'no duplicate identity write')
  // The restart resolves again (read-only) and the resolver now answers
  // differently; the earlier saved target still identifies the landed write.
  assert.equal(resolutions.length, 2)
  assert.equal(String(cloud.tables.observations[0].selected_sporely_taxon_id), '7821')
})

test('queue: an identity edit made elsewhere while resolution is pending survives; no RPC, item blocked', async () => {
  // The sparring probe: lose the observation INSERT response, adopt on the
  // retry, and let another client select 999 while resolution is pending.
  const unresolved = {
    capability: EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: null, sourceSystem: 'nbic', namespace: 'nortaxa_taxon_id',
    externalId: '53482', rawExternalId: 'NBIC:53482', scientificName: 'Amanita muscaria', taxonRank: null,
  }
  const resolved = { ...unresolved, capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821', resolvedFromExternalId: true }
  const cloud = fakeCloud()
  cloud.inject(op => (op.op === 'insert' && op.table === 'observations' && cloud.inserts('observations').length === 1 ? { lose: true } : null))
  const context = {
    resolveExternalTaxonomySelection: async () => {
      Object.assign(cloud.tables.observations[0], OTHER_IDENTITY)
      return resolved
    },
  }
  const item = queuedItem()
  item.obsPayload.taxonomySelection = unresolved
  const h = queueHarness(cloud, item, { context })
  await h.pass()
  assert.equal(h.queue.syncStage, 'retrying', 'the INSERT response was lost')
  await h.pass()
  assert.equal(h.queue.syncStage, 'blocked')
  assert.equal(h.queue.syncErrorCode, 'sync_identity_conflict')
  assert.equal(cloud.rpcs('set_observation_identification_v2').length, 0, 'no identity RPC')
  assert.deepEqual(identityOf(cloud.tables.observations[0]), identityOf(OTHER_IDENTITY), "the other client's edit survives")
})
