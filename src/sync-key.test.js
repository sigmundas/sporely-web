import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SYNC_KEY_INDEXES,
  ensureSyncKey,
  fetchOwnRowBySyncKey,
  isSyncKey,
  isSyncKeyConflict,
  mintSyncKey,
  syncRowDifferences,
} from './sync-key.js'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('mintSyncKey uses crypto.randomUUID when available', () => {
  const key = mintSyncKey({ randomUUID: () => '1B4E28BA-2FA1-41D2-883F-0016D3CCA427', getRandomValues: () => assert.fail('not needed') })
  assert.equal(key, '1b4e28ba-2fa1-41d2-883f-0016d3cca427')
})

test('mintSyncKey falls back to crypto.getRandomValues and yields a v4 uuid', () => {
  let calls = 0
  const key = mintSyncKey({
    getRandomValues(bytes) {
      calls++
      assert.equal(bytes.length, 16)
      bytes.fill(0xff)
      return bytes
    },
  })
  assert.equal(calls, 1)
  assert.match(key, V4)
  assert.equal(key, 'ffffffff-ffff-4fff-bfff-ffffffffffff')
  // Real fallback randomness: distinct keys.
  const real = { getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes) }
  const a = mintSyncKey(real)
  const b = mintSyncKey(real)
  assert.match(a, V4)
  assert.notEqual(a, b)
})

test('mintSyncKey refuses without a secure random source (never Math.random)', () => {
  assert.throws(() => mintSyncKey({}), /No secure random source/)
  assert.throws(() => mintSyncKey(null), /No secure random source/)
})

test('ensureSyncKey keeps an existing key and mints only when absent', () => {
  const existing = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
  assert.equal(ensureSyncKey(existing, {}), existing)
  assert.ok(isSyncKey(ensureSyncKey(null)))
  assert.ok(isSyncKey(ensureSyncKey('not-a-key')))
})

const named = table => ({
  code: '23505',
  message: `duplicate key value violates unique constraint "${SYNC_KEY_INDEXES[table]}"`,
  details: 'Key (user_id, sync_key)=(…) already exists.',
})

test('only a 23505 naming the table\'s own sync-key index means adopt', () => {
  assert.equal(isSyncKeyConflict(named('observations'), 'observations'), true)
  assert.equal(isSyncKeyConflict(named('observation_images'), 'observation_images'), true)
  // Another table's index, the legacy desktop_id constraint, 23503, 42501, 4xx.
  assert.equal(isSyncKeyConflict(named('observation_images'), 'observations'), false)
  assert.equal(isSyncKeyConflict(named('observations'), 'observation_images'), false)
  assert.equal(isSyncKeyConflict({ code: '23505', message: 'duplicate key value violates unique constraint "observations_desktop_id_user_id_key"' }, 'observations'), false)
  assert.equal(isSyncKeyConflict({ code: '23505', message: 'duplicate key value violates unique constraint "observations_pkey"' }, 'observations'), false)
  assert.equal(isSyncKeyConflict({ code: '23503', message: 'insert or update on table "observation_images" violates foreign key constraint' }, 'observation_images'), false)
  assert.equal(isSyncKeyConflict({ code: '42501', message: 'new row violates row-level security policy' }, 'observations'), false)
  assert.equal(isSyncKeyConflict({ code: 'PGRST204', message: 'observations_user_sync_key_uidx' }, 'observations'), false)
  assert.equal(isSyncKeyConflict(null, 'observations'), false)
  // A longer identifier that merely contains the index name is not it.
  assert.equal(isSyncKeyConflict({ code: '23505', message: 'constraint "x_observations_user_sync_key_uidx"' }, 'observations'), false)
})

test('syncRowDifferences tolerates storage round-trips but flags real edits', () => {
  const sent = {
    user_id: 'u1', sync_key: 'k', notes: 'cap', uncertain: false, gps_accuracy: 4.123456789,
    captured_at: '2026-10-16T10:00:00.000Z', date: '2026-10-16', missing_column: 'x', skipped: undefined,
  }
  // PostgREST returns a real column as the shortest float4 representation.
  const float4Text = value => Number(Math.fround(value).toPrecision(9))
  const stored = {
    id: 9, user_id: 'u1', sync_key: 'k', notes: 'cap', uncertain: false, gps_accuracy: float4Text(4.123456789),
    captured_at: '2026-10-16T10:00:00+00:00', date: '2026-10-16', updated_at: 'later', skipped: 'server value',
  }
  const opts = { table: 'observations' }
  assert.deepEqual(syncRowDifferences(sent, stored, opts), [])
  assert.deepEqual(syncRowDifferences({ ...sent, notes: 'edited elsewhere' }, stored, opts), ['notes'])
  assert.deepEqual(syncRowDifferences(sent, { ...stored, uncertain: true }, opts), ['uncertain'])
  assert.deepEqual(syncRowDifferences(sent, { ...stored, gps_accuracy: 4.1235 }, opts), ['gps_accuracy'])
  assert.deepEqual(syncRowDifferences({ ...sent, notes: null }, stored, opts), ['notes'])
  assert.deepEqual(syncRowDifferences(sent, stored, { ...opts, ignore: ['notes'] }), [])
  // float4 tolerance applies only to the table's real columns.
  assert.deepEqual(syncRowDifferences(sent, stored), ['gps_accuracy'])
})

test('syncRowDifferences keeps double-precision coordinates and integers exact', () => {
  const opts = { table: 'observations' }
  // ~5.6 m apart: a real edit, never a storage round-trip.
  assert.deepEqual(syncRowDifferences({ gps_latitude: 60 }, { gps_latitude: 60.00005 }, opts), ['gps_latitude'])
  assert.deepEqual(syncRowDifferences({ gps_longitude: 10.1234567 }, { gps_longitude: 10.1234568 }, opts), ['gps_longitude'])
  assert.deepEqual(syncRowDifferences({ gps_latitude: 59.123456789012 }, { gps_latitude: 59.123456789012 }, opts), [])
  assert.deepEqual(syncRowDifferences({ sort_order: 1 }, { sort_order: 2 }, { table: 'observation_images' }), ['sort_order'])
  assert.deepEqual(syncRowDifferences({ stored_bytes: 1000000 }, { stored_bytes: 1000001 }, { table: 'observation_images' }), ['stored_bytes'])
  assert.deepEqual(syncRowDifferences({ ai_crop_x1: 0.1 }, { ai_crop_x1: 0.1000001 }, { table: 'observation_images' }), ['ai_crop_x1'])
})

test('syncRowDifferences accepts the server\'s extra_float_digits=0 output', () => {
  // Supabase's postgresql.conf sets extra_float_digits = 0, so PostgREST
  // returns double precision with 15 and real with 6 significant digits.
  // Values from Stage 8b run w2b-1b-lost-obs (EXIF coordinates).
  const opts = { table: 'observations' }
  const sent = { gps_latitude: 62.34566944444445, gps_longitude: 8.765430555555556, gps_altitude: 123.4567, gps_accuracy: 4.123456789 }
  const stored = { gps_latitude: 62.3456694444444, gps_longitude: 8.76543055555556, gps_altitude: 123.457, gps_accuracy: 4.12346 }
  assert.deepEqual(syncRowDifferences(sent, stored, opts), [])
  assert.deepEqual(syncRowDifferences({ ai_crop_x1: 0.2150000000000001 }, { ai_crop_x1: 0.215 }, { table: 'observation_images' }), [])
  // A difference the server can show is still a difference.
  assert.deepEqual(syncRowDifferences(sent, { ...stored, gps_latitude: 62.3456694444445 }, opts), ['gps_latitude'])
  assert.deepEqual(syncRowDifferences(sent, { ...stored, gps_altitude: 123.458 }, opts), ['gps_altitude'])
  assert.deepEqual(syncRowDifferences(sent, { ...stored, gps_accuracy: 4.12345 }, opts), ['gps_accuracy'])
})

test('fetchOwnRowBySyncKey filters by owner in the query and again on the result', async () => {
  const key = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
  const filters = []
  const client = rows => ({
    from: table => {
      assert.equal(table, 'observations')
      const builder = {
        select: () => builder,
        eq: (column, value) => { filters.push([column, value]); return builder },
        limit: async () => ({ data: rows, error: null }),
      }
      return builder
    },
  })
  const own = { id: 1, user_id: 'u1', sync_key: key }
  assert.deepEqual(await fetchOwnRowBySyncKey(client([own]), 'observations', { userId: 'u1', syncKey: key }), own)
  assert.deepEqual(filters, [['user_id', 'u1'], ['sync_key', key]])
  // Another tenant's row with the same key is never adopted.
  await assert.rejects(
    fetchOwnRowBySyncKey(client([{ id: 2, user_id: 'u2', sync_key: key }]), 'observations', { userId: 'u1', syncKey: key }),
    /Could not read back/,
  )
  await assert.rejects(fetchOwnRowBySyncKey(client([]), 'observations', { userId: 'u1', syncKey: 'bad' }), /without an owner/)
})
