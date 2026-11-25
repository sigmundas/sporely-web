import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SNAPSHOT_PAGE_SIZE,
  R2_DELETE_CONCURRENCY,
  SWEEP_MAX_CALLS,
  requireSuccess,
  runDeletionPlan,
  STAGES,
  observationMediaDeleteTargets,
  encodeObjectKey,
  normalizeStoragePath,
} from './plan.js'

const UID = '00000000-0000-4000-8000-000000000001'

// ── Structural: every stage matches the audited deletion order ────────

const EXPECTED_ORDER = [
  'sweep_preflight',
  'media_snapshot',
  'mosaic_media_snapshot',
  'delete_r2_media',
  'delete_legacy_storage',
  'scrub_mentions',
  'delete_client_activity',
  'delete_follows',
  'delete_reports',
  'delete_identifications',
  'delete_spore_summaries',
  'delete_mosaics',
  'delete_user_blocks',
  'delete_friendships',
  'delete_observation_shares',
  'delete_comments',
  'delete_spore_annotations',
  'delete_spore_measurements',
  'delete_reference_library_for_account',
  'delete_observation_images',
  'delete_observations',
  'delete_calibrations',
  'delete_profile',
  'sweep_r2_prefix',
  'delete_auth_user',
]

test('stage order matches the audited deletion plan', () => {
  assert.deepEqual(STAGES.map(s => s.name), EXPECTED_ORDER)
})

test('delete_auth_user is the LAST stage — earlier failure must leave the session intact', () => {
  assert.equal(STAGES[STAGES.length - 1].name, 'delete_auth_user')
})

test('media_snapshot precedes delete_observation_images so R2 keys can be captured', () => {
  const snapshotIdx = STAGES.findIndex(s => s.name === 'media_snapshot')
  const deleteImagesIdx = STAGES.findIndex(s => s.name === 'delete_observation_images')
  assert.ok(snapshotIdx >= 0 && deleteImagesIdx >= 0)
  assert.ok(snapshotIdx < deleteImagesIdx)
})

test('mosaic_media_snapshot precedes BOTH delete_r2_media AND delete_mosaics', () => {
  const snapshotIdx = STAGES.findIndex(s => s.name === 'mosaic_media_snapshot')
  const r2Idx = STAGES.findIndex(s => s.name === 'delete_r2_media')
  const mosaicsIdx = STAGES.findIndex(s => s.name === 'delete_mosaics')
  assert.ok(snapshotIdx >= 0 && r2Idx >= 0 && mosaicsIdx >= 0)
  assert.ok(snapshotIdx < r2Idx, 'must snapshot before we ask the worker to delete R2 keys')
  assert.ok(snapshotIdx < mosaicsIdx, 'must snapshot before the mosaic rows are gone')
})

test('reference-library RPC runs before observations and auth', () => {
  const references = STAGES.findIndex(s => s.name === 'delete_reference_library_for_account')
  const observations = STAGES.findIndex(s => s.name === 'delete_observations')
  const auth = STAGES.findIndex(s => s.name === 'delete_auth_user')
  assert.ok(references >= 0)
  assert.ok(references < observations && observations < auth)
})

// ── Structural: source-level guarantee that every DB call uses requireSuccess

test('STRUCTURAL: every ctx.admin.from(...).delete()/update()/select() await is wrapped in requireSuccess', () => {
  // Reads plan.js as text and enforces the invariant that no raw
  // `await ctx.admin.from(...)` slipped in without going through
  // requireSuccess. Prevents silently ignored { error } responses.
  const source = readFileSync(new URL('./plan.js', import.meta.url), 'utf8')
  // Find every `ctx.admin.from(` occurrence and check the enclosing token
  // BEFORE it. It must be either `requireSuccess(...,` (inside the call)
  // or be embedded inside a requireSuccess call.
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('ctx.admin.from(')) continue
    // Look back up to 3 lines for requireSuccess( on the same logical call.
    const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
    const isWrapped = /requireSuccess\s*\(/.test(window)
    assert.ok(
      isWrapped,
      `unwrapped ctx.admin.from(...) on line ${i + 1}: ${line.trim()}`,
    )
  }
})

test('STRUCTURAL: no bare .then() on ctx.admin queries (would swallow error)', () => {
  const source = readFileSync(new URL('./plan.js', import.meta.url), 'utf8')
  assert.equal(
    /ctx\.admin\.from[^;]*\.then\s*\(/.test(source),
    false,
    'ctx.admin queries must go through requireSuccess, not .then()',
  )
})

// ── Coverage: audited tables all appear ─────────────────────────────

const REQUIRED_TABLES = [
  'client_activity_daily',
  'follows',
  'reports',
  'observation_identifications',
  'observation_spore_summaries',
  'spore_measurement_mosaics',
  'user_blocks',
  'friendships',
  'observation_shares',
  'comments',
  'spore_annotations',
  'spore_measurements',
  'observation_images',
  'observations',
  'calibrations',
  'profiles',
]

test('every audited table is referenced by the plan (regression guard against schema drift)', () => {
  const source = readFileSync(new URL('./plan.js', import.meta.url), 'utf8')
  for (const table of REQUIRED_TABLES) {
    // Table name must appear either in a from('...') call or as the second
    // arg to the _simpleDelete factory. Escape dot in table names if any.
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`['"]${escaped}['"]`)
    assert.ok(pattern.test(source), `plan.js does not reference table ${table}`)
  }
})

// ── requireSuccess ──────────────────────────────────────────────────

test('requireSuccess returns data when error is null', async () => {
  const data = await requireSuccess('x', Promise.resolve({ data: [{ a: 1 }], error: null }))
  assert.deepEqual(data, [{ a: 1 }])
})

test('requireSuccess throws with the label when error is present', async () => {
  await assert.rejects(
    () => requireSuccess('label', Promise.resolve({ data: null, error: { message: 'boom' } })),
    /label: boom/,
  )
})

// ── Mock supabase client ────────────────────────────────────────────

// Rows without an id get their 1-based position, so plain fixtures can be
// served by keyset pagination.
function withIds(rows) {
  return rows.map((row, i) => (row && 'id' in row ? row : { id: i + 1, ...row }))
}

// Applies the PostgREST filters the plan uses (id > gt, order by id,
// offset range, limit) to `rows`, capped at `maxRows` (the server max_rows).
function serveRows(rows, filters, maxRows = Infinity) {
  let out = [...rows]
  for (const f of filters) {
    if (f.method === 'gt') out = out.filter(row => row[f.col] > f.val)
  }
  const order = filters.find(f => f.method === 'order')
  if (order) out.sort((a, b) => (a[order.col] - b[order.col]) * (order.opts?.ascending === false ? -1 : 1))
  const range = filters.find(f => f.method === 'range')
  if (range) out = out.slice(range.from, range.to + 1)
  const limit = filters.find(f => f.method === 'limit')
  if (limit) out = out.slice(0, limit.count)
  return out.slice(0, maxRows)
}

function fakeAdmin(overrides = {}) {
  const calls = []
  const _table = (table) => {
    let chain = { _table: table, _op: null, _filters: [] }
    const attach = (method, arg) => {
      chain._op = chain._op || method
      chain._filters.push({ method, arg })
      return builder
    }
    const settle = () => {
      calls.push({ table: chain._table, op: chain._op, filters: [...chain._filters] })
      const override = overrides.tableResponses?.[chain._table]?.[chain._op]
      if (override) {
        const result = override(chain)
        // Like PostgREST, a paged select returns only the rows its filters,
        // order and limit select (unless the override already pages itself).
        if (chain._op === 'select' && !override.paged && Array.isArray(result?.data)) {
          return Promise.resolve({ ...result, data: serveRows(withIds(result.data), chain._filters) })
        }
        return Promise.resolve(result)
      }
      return Promise.resolve({ data: [], error: null })
    }
    const builder = {
      select: (cols) => attach('select', cols),
      update: (patch) => attach('update', patch),
      delete: () => { chain._op = 'delete'; return builder },
      eq: (col, val) => { chain._filters.push({ method: 'eq', col, val }); return _thenable() },
      or: (expr) => { chain._filters.push({ method: 'or', expr }); return _thenable() },
      contains: (col, val) => { chain._filters.push({ method: 'contains', col, val }); return _thenable() },
      then: (res, rej) => settle().then(res, rej),
    }
    const _thenable = () => ({
      then: (res, rej) => settle().then(res, rej),
      eq: (col, val) => { chain._filters.push({ method: 'eq', col, val }); return _thenable() },
      or: (expr) => { chain._filters.push({ method: 'or', expr }); return _thenable() },
      gt: (col, val) => { chain._filters.push({ method: 'gt', col, val }); return _thenable() },
      order: (col, opts) => { chain._filters.push({ method: 'order', col, opts }); return _thenable() },
      range: (from, to) => { chain._filters.push({ method: 'range', from, to }); return _thenable() },
      limit: (count) => { chain._filters.push({ method: 'limit', count }); return _thenable() },
    })
    return builder
  }
  return {
    _calls: calls,
    from: _table,
    rpc: (name, params) => {
      calls.push({ table: '<rpc>', op: name, params })
      const override = overrides.rpcResponses?.[name]
      if (override) return Promise.resolve(override(params))
      return Promise.resolve({ data: null, error: null })
    },
    storage: overrides.storage || {
      from: () => ({
        list: async () => (overrides.storageListError ? { data: null, error: { message: overrides.storageListError } } : { data: [], error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
    auth: {
      admin: {
        deleteUser: async (uid) => {
          calls.push({ table: '<auth>', op: 'deleteUser', uid })
          if (overrides.deleteUserError) return { data: null, error: { message: overrides.deleteUserError } }
          return { data: null, error: null }
        },
      },
    },
  }
}

function fakeWorker(overrides = {}) {
  const deleted = []
  const sweeps = []
  const sweepResults = [...(overrides.sweepResults || [])]
  return {
    deleted,
    sweeps,
    async sweepAccountMedia() {
      sweeps.push(deleted.length)
      // The first call is sweep_preflight; a live profile answers 409.
      if (sweeps.length === 1 && !overrides.preflight) {
        return { ok: false, status: 409, detail: 'profile_exists' }
      }
      if (sweeps.length === 1) return overrides.preflight()
      if (overrides.sweepThrows) throw new Error(overrides.sweepThrows)
      return sweepResults.length ? sweepResults.shift() : { ok: true, status: 200, deleted: 0, done: true }
    },
    async deleteKey(key) {
      deleted.push(key)
      const status = overrides.statusByKey?.[key]
      if (status === 404) return { ok: true, status: 404 }
      if (typeof status === 'number' && status >= 400) return { ok: false, status, detail: `HTTP ${status}` }
      return { ok: true, status: 200 }
    },
  }
}

// ── End-to-end plan runs ────────────────────────────────────────────

test('runDeletionPlan: happy path completes every stage', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      observation_images: { select: () => ({ data: [{ storage_path: `${UID}/photo1.jpg` }], error: null }) },
    },
  })
  const worker = fakeWorker()
  const result = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(result.ok, true)
  assert.deepEqual(result.completed, EXPECTED_ORDER)
  // Snapshotted R2 keys were forwarded to the worker.
  assert.ok(worker.deleted.includes(`${UID}/photo1.jpg`))
  assert.ok(worker.deleted.includes(`${UID}/thumb_photo1.jpg`))
  // auth user delete ran last.
  const authIdx = admin._calls.findIndex(c => c.op === 'deleteUser')
  assert.equal(authIdx, admin._calls.length - 1)
})

test('runDeletionPlan: failure at any stage stops progress and leaves auth user intact', async () => {
  // Injecting a failure at delete_observations. Auth-user delete must NOT run.
  const admin = fakeAdmin({
    tableResponses: {
      observations: { delete: () => ({ data: null, error: { message: 'FK violation' } }) },
    },
  })
  const worker = fakeWorker()
  const result = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'delete_observations')
  assert.ok(result.error.includes('FK violation'))
  const authCall = admin._calls.find(c => c.op === 'deleteUser')
  assert.equal(authCall, undefined, 'auth user must NOT be deleted when an earlier stage failed')
})

test('runDeletionPlan: staged failure at every stage leaves auth user alive', async () => {
  // Sweeps every db-bearing stage and injects an error, ensuring none of
  // them accidentally proceed to delete_auth_user.
  const tableFailures = {
    delete_client_activity: 'client_activity_daily',
    delete_follows: 'follows',
    delete_reports: 'reports',
    delete_identifications: 'observation_identifications',
    delete_spore_summaries: 'observation_spore_summaries',
    delete_mosaics: 'spore_measurement_mosaics',
    delete_user_blocks: 'user_blocks',
    delete_friendships: 'friendships',
    delete_observation_shares: 'observation_shares',
    delete_comments: 'comments',
    delete_spore_annotations: 'spore_annotations',
    delete_spore_measurements: 'spore_measurements',
    delete_observation_images: 'observation_images',
    delete_observations: 'observations',
    delete_calibrations: 'calibrations',
    delete_profile: 'profiles',
  }
  for (const [stageName, table] of Object.entries(tableFailures)) {
    const admin = fakeAdmin({
      tableResponses: { [table]: { delete: () => ({ data: null, error: { message: 'induced' } }) } },
    })
    const worker = fakeWorker()
    const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
    assert.equal(r.ok, false, `${stageName} should fail`)
    assert.equal(r.stage, stageName, `${stageName} stage label should be reported`)
    const authCall = admin._calls.find(c => c.op === 'deleteUser')
    assert.equal(authCall, undefined, `${stageName}: auth.admin.deleteUser must NOT run after failure`)
  }
})

test('runDeletionPlan: reference-library RPC failure stops before observations and auth', async () => {
  const admin = fakeAdmin({
    rpcResponses: {
      delete_reference_library_for_account: () => ({ data: null, error: { message: 'reference delete failed' } }),
    },
  })
  const result = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'delete_reference_library_for_account')
  assert.match(result.error, /reference delete failed/)
  assert.equal(admin._calls.some(c => c.table === 'observations' && c.op === 'delete'), false)
  assert.equal(admin._calls.find(c => c.op === 'deleteUser'), undefined)
})

test('reference-library deletion calls the service-role RPC with the account uid', async () => {
  const admin = fakeAdmin()
  const result = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(result.ok, true)
  const calls = admin._calls.filter(
    c => c.table === '<rpc>' && c.op === 'delete_reference_library_for_account',
  )
  assert.deepEqual(calls.map(c => c.params), [{ p_user_id: UID }])
})

test('reference-library deletion is retry-safe at the plan boundary', async () => {
  const admin = fakeAdmin()
  const worker = fakeWorker()
  const first = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  const second = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(
    admin._calls.filter(c => c.table === '<rpc>' && c.op === 'delete_reference_library_for_account').length,
    2,
  )
})

test('runDeletionPlan: media_snapshot failure prevents downstream deletes', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      observation_images: { select: () => ({ data: null, error: { message: 'snapshot fail' } }) },
    },
  })
  const worker = fakeWorker()
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'media_snapshot')
  // Worker never invoked because snapshot never populated r2Keys.
  assert.equal(worker.deleted.length, 0)
})

test('runDeletionPlan: R2 404 is treated as idempotent success', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      observation_images: { select: () => ({ data: [{ storage_path: `${UID}/gone.jpg` }], error: null }) },
    },
  })
  const worker = fakeWorker({ statusByKey: { [`${UID}/gone.jpg`]: 404, [`${UID}/thumb_gone.jpg`]: 404 } })
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, true)
})

test('runDeletionPlan: R2 500 fails the stage and preserves the auth user', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      observation_images: { select: () => ({ data: [{ storage_path: `${UID}/x.jpg` }], error: null }) },
    },
  })
  const worker = fakeWorker({ statusByKey: { [`${UID}/x.jpg`]: 500 } })
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'delete_r2_media')
  assert.deepEqual(worker.deleted, [
    `${UID}/x.jpg`,
    `${UID}/thumb_x.jpg`,
    `${UID}/thumb_small_x.jpg`,
    `${UID}/thumb_medium_x.jpg`,
  ],
    'a failed key must not prevent remaining snapshotted identities from being attempted')
  assert.equal(admin._calls.find(c => c.op === 'deleteUser'), undefined)
})

// A worker whose deletes stay pending until the test settles them, so it can
// observe how many are in flight at once.
function gatedWorker(statusByKey = {}) {
  const pending = []
  const attempted = []
  let inFlight = 0
  let maxInFlight = 0
  return {
    attempted,
    pending,
    maxInFlight: () => maxInFlight,
    deleteKey(key) {
      attempted.push(key)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise(resolve => {
        pending.push(() => {
          inFlight -= 1
          const status = statusByKey[key] ?? 200
          if (status === 404) resolve({ ok: true, status })
          else if (status >= 400) resolve({ ok: false, status, detail: `HTTP ${status}` })
          else resolve({ ok: true, status })
        })
      })
    },
  }
}

// Settles pending deletes one microtask turn at a time until the stage ends.
async function drain(worker, done) {
  let finished = false
  done.then(() => { finished = true })
  while (!finished) {
    await new Promise(resolve => setImmediate(resolve))
    while (worker.pending.length) worker.pending.shift()()
  }
  return done
}

function stage(name) {
  return STAGES.find(s => s.name === name)
}

test('delete_r2_media never has more than R2_DELETE_CONCURRENCY deletes in flight', async () => {
  const keys = Array.from({ length: R2_DELETE_CONCURRENCY * 4 + 3 }, (_, i) => `${UID}/obs/${i}.webp`)
  const worker = gatedWorker()
  const done = stage('delete_r2_media').apply({ uid: UID, admin: fakeAdmin(), worker, r2Keys: new Set(keys) })
  // Before anything settles, exactly the limit has started.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(worker.attempted.length, R2_DELETE_CONCURRENCY)
  const result = await drain(worker, done)
  assert.deepEqual(result, { ok: true })
  assert.equal(worker.maxInFlight(), R2_DELETE_CONCURRENCY)
  assert.deepEqual([...worker.attempted].sort(), [...keys].sort(), 'every key is attempted exactly once')
})

test('delete_r2_media attempts every key and reports a failure from the middle', async () => {
  const keys = Array.from({ length: R2_DELETE_CONCURRENCY * 3 }, (_, i) => `${UID}/obs/${i}.webp`)
  const failingIndex = R2_DELETE_CONCURRENCY + 5
  const failing = keys[failingIndex]
  const worker = gatedWorker({ [failing]: 503, [keys[2]]: 404 })
  const done = stage('delete_r2_media').apply({ uid: UID, admin: fakeAdmin(), worker, r2Keys: new Set(keys) })
  const result = await drain(worker, done)
  assert.equal(result.ok, false)
  assert.match(result.error, new RegExp(`obs/${failingIndex}\\.webp: HTTP 503`))
  assert.equal(result.error.split('; ').length, 1, 'only the failed key is reported; 404 is success')
  assert.doesNotMatch(result.error, new RegExp(UID), 'the account id is masked')
  assert.deepEqual([...worker.attempted].sort(), [...keys].sort(), 'keys after the failure are still attempted')
})

test('delete_r2_media reports every failed key, in snapshot order', async () => {
  const keys = Array.from({ length: 40 }, (_, i) => `${UID}/obs/${i}.webp`)
  const worker = fakeWorker({ statusByKey: { [keys[3]]: 500, [keys[30]]: 502, [keys[17]]: 403 } })
  const result = await stage('delete_r2_media').apply({ uid: UID, admin: fakeAdmin(), worker, r2Keys: new Set(keys) })
  assert.equal(result.ok, false)
  assert.deepEqual(result.error.split('; ').map(e => e.match(/obs\/(\d+)\.webp/)[1]), ['3', '17', '30'])
  assert.equal(worker.deleted.length, keys.length)
})

test('delete_r2_media records a thrown worker error as a failure and keeps going', async () => {
  const keys = Array.from({ length: 20 }, (_, i) => `${UID}/obs/${i}.webp`)
  const attempted = []
  const worker = {
    async deleteKey(key) {
      attempted.push(key)
      if (key === keys[4]) throw new Error('socket hang up')
      return { ok: true, status: 200 }
    },
  }
  const result = await stage('delete_r2_media').apply({ uid: UID, admin: fakeAdmin(), worker, r2Keys: new Set(keys) })
  assert.equal(result.ok, false)
  assert.match(result.error, /obs\/4\.webp: socket hang up/)
  assert.equal(attempted.length, keys.length)
})

test('runDeletionPlan: delete_auth_user user_not_found is idempotent success', async () => {
  const admin = fakeAdmin({ deleteUserError: 'User not found' })
  const worker = fakeWorker()
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, true)
  assert.equal(r.completed[r.completed.length - 1], 'delete_auth_user')
})

test('runDeletionPlan: SECOND run after partial cleanup succeeds (idempotency)', async () => {
  // First run: fail at delete_observations.
  const admin1 = fakeAdmin({
    tableResponses: { observations: { delete: () => ({ data: null, error: { message: 'network flake' } }) } },
  })
  const r1 = await runDeletionPlan({ uid: UID, admin: admin1, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(r1.ok, false)

  // Second run: no failures. Every stage's `WHERE user_id = uid` matches
  // zero rows (already deleted) but succeeds. Auth user delete now runs.
  const admin2 = fakeAdmin()
  const r2 = await runDeletionPlan({ uid: UID, admin: admin2, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.completed, EXPECTED_ORDER)
})

// ── stage-specific behaviors ──────────────────────────────────────────

test('delete_follows queries BOTH user_id and target_id (polymorphic)', async () => {
  const admin = fakeAdmin()
  await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  const followsCalls = admin._calls.filter(c => c.table === 'follows' && c.op === 'delete')
  const cols = followsCalls.flatMap(c => c.filters.filter(f => f.method === 'eq').map(f => f.col))
  assert.ok(cols.includes('user_id'))
  assert.ok(cols.includes('target_id'))
})

test('delete_user_blocks queries BOTH blocker_id and blocked_id', async () => {
  const admin = fakeAdmin()
  await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  const cols = admin._calls
    .filter(c => c.table === 'user_blocks' && c.op === 'delete')
    .flatMap(c => c.filters.filter(f => f.method === 'eq').map(f => f.col))
  assert.ok(cols.includes('blocker_id'))
  assert.ok(cols.includes('blocked_id'))
})

test('delete_friendships uses an OR filter on requester_id/addressee_id', async () => {
  const admin = fakeAdmin()
  await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  const call = admin._calls.find(c => c.table === 'friendships' && c.op === 'delete')
  const orFilter = call.filters.find(f => f.method === 'or')
  assert.match(orFilter.expr, /requester_id\.eq/)
  assert.match(orFilter.expr, /addressee_id\.eq/)
})

test('delete_reports queries reporter_id AND reported_user_id', async () => {
  const admin = fakeAdmin()
  await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  const cols = admin._calls
    .filter(c => c.table === 'reports' && c.op === 'delete')
    .flatMap(c => c.filters.filter(f => f.method === 'eq').map(f => f.col))
  assert.ok(cols.includes('reporter_id'))
  assert.ok(cols.includes('reported_user_id'))
})

test('scrub_mentions is best-effort: failure does not abort the plan', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      comments: {
        update: () => ({ data: null, error: { message: 'update-not-permitted' } }),
      },
    },
  })
  const r = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  // Should still succeed overall.
  assert.equal(r.ok, true)
})

// ── helpers ──────────────────────────────────────────────────────────

test('observationMediaDeleteTargets returns original AND thumb keys from a normal path', () => {
  const targets = observationMediaDeleteTargets(`${UID}/2026/01/photo.jpg`)
  assert.deepEqual(targets.sort(), [
    `${UID}/2026/01/photo.jpg`,
    `${UID}/2026/01/thumb_photo.jpg`,
    `${UID}/2026/01/thumb_small_photo.jpg`,
    `${UID}/2026/01/thumb_medium_photo.jpg`,
  ].sort())
})

test('observationMediaDeleteTargets pairs a thumb_ path with its original', () => {
  const targets = observationMediaDeleteTargets(`${UID}/2026/thumb_photo.jpg`)
  assert.deepEqual(targets.sort(), [
    `${UID}/2026/photo.jpg`,
    `${UID}/2026/thumb_photo.jpg`,
    `${UID}/2026/thumb_small_photo.jpg`,
    `${UID}/2026/thumb_medium_photo.jpg`,
  ].sort())
})

test('observationMediaDeleteTargets handles empty and single-segment paths', () => {
  assert.deepEqual(observationMediaDeleteTargets(''), [])
  assert.deepEqual(observationMediaDeleteTargets('   '), [])
  assert.deepEqual(observationMediaDeleteTargets('/leading-slash.jpg'), [
    'leading-slash.jpg',
    'thumb_leading-slash.jpg',
    'thumb_small_leading-slash.jpg',
    'thumb_medium_leading-slash.jpg',
  ])
})

test('encodeObjectKey percent-encodes each segment individually', () => {
  assert.equal(encodeObjectKey('uid one/path with spaces/file name.jpg'), 'uid%20one/path%20with%20spaces/file%20name.jpg')
})

test('normalizeStoragePath trims and strips leading slashes', () => {
  assert.equal(normalizeStoragePath('  //a/b  '), 'a/b')
  assert.equal(normalizeStoragePath(null), '')
  assert.equal(normalizeStoragePath(undefined), '')
})

// ── original_storage_path is snapshotted verbatim (no manufactured thumb_)

test('media_snapshot: original_storage_path is added AS-IS (no thumb_ variant)', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      observation_images: {
        select: () => ({
          data: [{
            storage_path: `${UID}/o1/photo.jpg`,
            original_storage_path: `${UID}/o1/original/photo_full.jpg`,
          }],
          error: null,
        }),
      },
    },
  })
  const worker = fakeWorker()
  const r2Keys = new Set()
  await runDeletionPlan({ uid: UID, admin, worker, r2Keys })
  // storage_path variant has a paired thumb, by contract.
  assert.ok(r2Keys.has(`${UID}/o1/photo.jpg`))
  assert.ok(r2Keys.has(`${UID}/o1/thumb_photo.jpg`))
  // original_storage_path is standalone — verbatim, no thumb_ prefix.
  assert.ok(r2Keys.has(`${UID}/o1/original/photo_full.jpg`))
  assert.equal(r2Keys.has(`${UID}/o1/original/thumb_photo_full.jpg`), false,
    'must NOT manufacture a thumb companion for original_storage_path')
})

test('media_snapshot: original_storage_path missing/null is tolerated', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      observation_images: {
        select: () => ({
          data: [
            { storage_path: `${UID}/a/photo.jpg`, original_storage_path: null },
            { storage_path: `${UID}/b/photo.jpg` }, // key absent entirely
          ],
          error: null,
        }),
      },
    },
  })
  const worker = fakeWorker()
  const r2Keys = new Set()
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys })
  assert.equal(r.ok, true)
  assert.ok(r2Keys.has(`${UID}/a/photo.jpg`))
  assert.ok(r2Keys.has(`${UID}/b/photo.jpg`))
})

// ── mosaic_media_snapshot ──────────────────────────────────────────────

test('mosaic_media_snapshot: storage_key rows are collected before delete_mosaics', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      spore_measurement_mosaics: {
        select: () => ({
          data: [
            { storage_key: `${UID}/mosaics/m1.webp` },
            { storage_key: `${UID}/mosaics/m2.webp` },
          ],
          error: null,
        }),
      },
    },
  })
  const worker = fakeWorker()
  const r2Keys = new Set()
  await runDeletionPlan({ uid: UID, admin, worker, r2Keys })
  assert.ok(r2Keys.has(`${UID}/mosaics/m1.webp`))
  assert.ok(r2Keys.has(`${UID}/mosaics/m2.webp`))
  // Not manufactured with a thumb_ companion — mosaics have no thumb pair.
  assert.equal(r2Keys.has(`${UID}/mosaics/thumb_m1.webp`), false)
  // Both keys reached the worker before delete_mosaics ran.
  assert.ok(worker.deleted.includes(`${UID}/mosaics/m1.webp`))
  assert.ok(worker.deleted.includes(`${UID}/mosaics/m2.webp`))
})

test('mosaic_media_snapshot: select failure aborts the plan', async () => {
  const admin = fakeAdmin({
    tableResponses: {
      spore_measurement_mosaics: {
        select: () => ({ data: null, error: { message: 'perm denied' } }),
      },
    },
  })
  const worker = fakeWorker()
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'mosaic_media_snapshot')
  assert.equal(admin._calls.find(c => c.op === 'deleteUser'), undefined)
})

// ── scrub_mentions uses an RPC, not a blanket update ─────────────────

test('scrub_mentions: uses the scrub_user_mentions RPC with the deleted uid', async () => {
  const admin = fakeAdmin()
  await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  const rpc = admin._calls.find(c => c.table === '<rpc>' && c.op === 'scrub_user_mentions')
  assert.ok(rpc, 'scrub_user_mentions RPC must be called')
  assert.deepEqual(rpc.params, { p_user_id: UID })
})

test('scrub_mentions: DOES NOT issue a blanket UPDATE that would blank the mentions array', () => {
  const source = readFileSync(new URL('./plan.js', import.meta.url), 'utf8')
  // Guard against a regression that sets the whole array to null. The
  // scrub-mentions stage must go through an RPC (array_remove).
  const scrubBlock = source.match(/name:\s*'scrub_mentions'[\s\S]*?apply:[\s\S]*?}\s*,\s*}/)?.[0] || ''
  assert.ok(scrubBlock, 'could not locate scrub_mentions stage')
  assert.equal(
    /\.update\(\s*\{[^}]*mentioned_user_ids\s*:\s*null/.test(scrubBlock),
    false,
    'scrub_mentions must not blank mentioned_user_ids to null',
  )
  assert.match(scrubBlock, /rpc\(\s*['"]scrub_user_mentions['"]/, 'must go through the array-safe RPC')
})

test('scrub_mentions: multi-user mention arrays preserve co-mentioned uuids (via array_remove RPC)', () => {
  // Simulate what public.scrub_user_mentions(p_user_id) does server-side.
  // If the plan.js call ever regresses to a blanket update, the RPC would
  // no longer receive p_user_id and this simulated behaviour would diverge
  // from what plan.js requests. Structural test above covers the client
  // side; this one documents the server semantics we depend on.
  const arrayRemove = (arr, uuid) => arr.filter(x => x !== uuid)
  const before = [
    { id: 'c1', mentioned_user_ids: [UID, 'other-1', 'other-2'] },
    { id: 'c2', mentioned_user_ids: [UID] },
    { id: 'c3', mentioned_user_ids: ['other-3'] },
  ]
  const after = before.map(row => ({
    ...row,
    mentioned_user_ids: arrayRemove(row.mentioned_user_ids, UID),
  }))
  assert.deepEqual(after[0].mentioned_user_ids, ['other-1', 'other-2'], 'co-mentioned uuids must survive')
  assert.deepEqual(after[1].mentioned_user_ids, [], 'sole-mention row becomes empty')
  assert.deepEqual(after[2].mentioned_user_ids, ['other-3'], 'unrelated rows unchanged')
})

test('scrub_mentions: RPC failure does NOT abort the plan', async () => {
  const admin = fakeAdmin({
    rpcResponses: { scrub_user_mentions: () => ({ data: null, error: { message: 'rpc failed' } }) },
  })
  const r = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(r.ok, true)
})

// ── follows.target_id delete requires target_type='user' ─────────────

test('delete_follows.target_id: also filters by target_type=user (polymorphic guard)', async () => {
  const admin = fakeAdmin()
  await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  const followsCalls = admin._calls.filter(c => c.table === 'follows' && c.op === 'delete')
  // Two delete calls: one for user_id, one for (target_type + target_id).
  // Find the target_id call and confirm its filters include target_type.
  const targetCall = followsCalls.find(c =>
    c.filters.some(f => f.method === 'eq' && f.col === 'target_id'),
  )
  assert.ok(targetCall, 'follows.target_id delete must be issued')
  const targetTypeFilter = targetCall.filters.find(f => f.method === 'eq' && f.col === 'target_type')
  assert.ok(targetTypeFilter, "follows.target_id delete must also filter target_type='user'")
  assert.equal(targetTypeFilter.val, 'user')
})

test('STRUCTURAL: delete_follows source uses target_type + target_id together, never bare target_id', () => {
  const source = readFileSync(new URL('./plan.js', import.meta.url), 'utf8')
  const followsBlock = source.match(/name:\s*'delete_follows'[\s\S]*?}\s*,\s*}/)?.[0] || ''
  assert.ok(followsBlock, 'could not locate delete_follows stage')
  // Every .eq('target_id', ...) call must be preceded by .eq('target_type', 'user') on the same chain.
  const targetIdCalls = followsBlock.match(/\.eq\(\s*['"]target_type['"]\s*,\s*['"]user['"]\s*\)\s*\.eq\(\s*['"]target_id['"]/g) || []
  assert.ok(targetIdCalls.length > 0, 'delete_follows must chain .eq(target_type, user).eq(target_id, uid)')
  // And NO bare .from(follows)....eq('target_id') without target_type nearby.
  const bareTargetId = /\.eq\(\s*['"]target_id['"]/g
  const bareMatches = followsBlock.match(bareTargetId) || []
  assert.equal(bareMatches.length, targetIdCalls.length,
    'every follows.target_id filter must be preceded by target_type=user')
})

// ── Pagination ──────────────────────────────────────────────────────

// Serves `rows` (ids 1..n) the way PostgREST does, capped at `maxRows` (the
// server's max_rows). `pages` records the keyset cursor (`after`, the gt
// value or null) of each request. `onPage(pageIndex, rows)` runs after a page
// is served, so a test can change the table between page requests.
function pagedSelect(sourceRows, { maxRows = SNAPSHOT_PAGE_SIZE, onPage } = {}) {
  const rows = withIds(sourceRows)
  const pages = []
  const respond = chain => {
    const gt = chain._filters.find(f => f.method === 'gt')
    pages.push({ after: gt ? gt.val : null })
    const data = serveRows(rows, chain._filters, maxRows)
    onPage?.(pages.length - 1, rows)
    return { data, error: null }
  }
  respond.paged = true
  return { respond, pages, rows }
}

test('media_snapshot reads every observation image page, past the max_rows cap', async () => {
  const images = Array.from({ length: 2 * SNAPSHOT_PAGE_SIZE + 5 }, (_, i) => ({
    storage_path: `${UID}/obs/${i}.webp`,
    original_storage_path: i % 1000 === 7 ? `${UID}/obs/orig_${i}.heic` : null,
  }))
  const imagePages = pagedSelect(images)
  const admin = fakeAdmin({ tableResponses: { observation_images: { select: imagePages.respond } } })
  const worker = fakeWorker()
  const result = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(result.ok, true)
  const last = images.length - 1
  assert.ok(worker.deleted.includes(`${UID}/obs/${last}.webp`), 'last page image must be deleted')
  assert.ok(worker.deleted.includes(`${UID}/obs/thumb_${last}.webp`))
  assert.ok(worker.deleted.includes(`${UID}/obs/orig_1007.heic`), 'originals on later pages must be deleted')
  assert.deepEqual(imagePages.pages.map(p => p.after), [null, 1000, 2000, 2005])
  const selects = admin._calls.filter(c => c.table === 'observation_images' && c.op === 'select')
  for (const call of selects) {
    assert.ok(call.filters.some(f => f.method === 'select' && /\bid\b/.test(f.arg)), 'pages must select the id cursor')
    assert.ok(call.filters.some(f => f.method === 'order' && f.col === 'id' && f.opts?.ascending === true), 'pages must be ordered by id')
    assert.ok(call.filters.some(f => f.method === 'limit' && f.count === SNAPSHOT_PAGE_SIZE), 'pages must be limited')
    assert.equal(call.filters.some(f => f.method === 'range'), false, 'offset ranges skip rows deleted mid-scan')
  }
})

test('media_snapshot keeps paging when the server max_rows is below the page size', async () => {
  const images = Array.from({ length: 1200 }, (_, i) => ({ storage_path: `${UID}/obs/${i}.webp` }))
  const imagePages = pagedSelect(images, { maxRows: 500 })
  const admin = fakeAdmin({ tableResponses: { observation_images: { select: imagePages.respond } } })
  const worker = fakeWorker()
  const result = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(result.ok, true)
  assert.ok(worker.deleted.includes(`${UID}/obs/1199.webp`))
  assert.deepEqual(imagePages.pages.map(p => p.after), [null, 500, 1000, 1200])
})

test('media_snapshot still collects the last row when a row is deleted between pages', async () => {
  // One row past a full page. After the first page is served the user
  // deletes an image they already saw; an offset scan would then start
  // past the last row and miss it.
  const images = Array.from({ length: SNAPSHOT_PAGE_SIZE + 1 }, (_, i) => ({ storage_path: `${UID}/obs/${i}.webp` }))
  const imagePages = pagedSelect(images, {
    onPage: (page, rows) => { if (page === 0) rows.splice(0, 1) },
  })
  const admin = fakeAdmin({ tableResponses: { observation_images: { select: imagePages.respond } } })
  const r2Keys = new Set()
  const result = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys })
  assert.equal(result.ok, true)
  assert.ok(r2Keys.has(`${UID}/obs/${SNAPSHOT_PAGE_SIZE}.webp`), 'the row after the first page must be snapshotted')
})

test('mosaic_media_snapshot still collects the last row when a row is deleted between pages', async () => {
  const mosaics = Array.from({ length: SNAPSHOT_PAGE_SIZE + 1 }, (_, i) => ({ storage_key: `${UID}/m/${i}.webp` }))
  const mosaicPages = pagedSelect(mosaics, {
    onPage: (page, rows) => { if (page === 0) rows.splice(0, 1) },
  })
  const admin = fakeAdmin({ tableResponses: { spore_measurement_mosaics: { select: mosaicPages.respond } } })
  const r2Keys = new Set()
  const result = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys })
  assert.equal(result.ok, true)
  assert.ok(r2Keys.has(`${UID}/m/${SNAPSHOT_PAGE_SIZE}.webp`), 'the row after the first page must be snapshotted')
})

test('mosaic_media_snapshot reads every mosaic page', async () => {
  const mosaics = Array.from({ length: SNAPSHOT_PAGE_SIZE + 3 }, (_, i) => ({ storage_key: `${UID}/m/${i}.webp` }))
  const mosaicPages = pagedSelect(mosaics)
  const admin = fakeAdmin({ tableResponses: { spore_measurement_mosaics: { select: mosaicPages.respond } } })
  const worker = fakeWorker()
  const result = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(result.ok, true)
  assert.ok(worker.deleted.includes(`${UID}/m/${mosaics.length - 1}.webp`))
  assert.deepEqual(mosaicPages.pages.map(p => p.after), [null, SNAPSHOT_PAGE_SIZE, SNAPSHOT_PAGE_SIZE + 3])
})

test('delete_legacy_storage removes every file when a folder holds more than one listing page', async () => {
  // A Storage bucket that lists sorted by name and drops removed files from
  // later listings, like Supabase Storage.
  const buckets = {
    'observation-images': new Set([
      ...Array.from({ length: 2500 }, (_, i) => `${UID}/f${String(i).padStart(5, '0')}.jpg`),
      ...Array.from({ length: 3 }, (_, i) => `${UID}/sub/s${i}.jpg`),
    ]),
    avatars: new Set([`${UID}/avatar.jpg`]),
  }
  const storage = {
    from: bucket => ({
      list: async (path, { limit, offset }) => {
        const prefix = `${path}/`
        const entries = new Map()
        for (const key of buckets[bucket]) {
          if (!key.startsWith(prefix)) continue
          const rest = key.slice(prefix.length)
          const [head, ...tail] = rest.split('/')
          if (tail.length) entries.set(head, { name: head, id: null })
          else entries.set(head, { name: head, id: `id-${key}` })
        }
        const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
        return { data: sorted.slice(offset, offset + limit), error: null }
      },
      remove: async keys => {
        for (const key of keys) buckets[bucket].delete(key)
        return { data: null, error: null }
      },
    }),
  }
  const admin = fakeAdmin({ storage })
  const result = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(result.ok, true)
  assert.deepEqual([...buckets['observation-images']], [])
  assert.deepEqual([...buckets.avatars], [])
})

test('media_snapshot fails closed if the server ignores the keyset filter', async () => {
  // A select that always returns the same full page would otherwise loop forever.
  const fullPage = withIds(Array.from({ length: SNAPSHOT_PAGE_SIZE }, (_, i) => ({ storage_path: `${UID}/obs/${i}.webp` })))
  const respond = () => ({ data: fullPage, error: null })
  respond.paged = true
  const admin = fakeAdmin({ tableResponses: { observation_images: { select: respond } } })
  const result = await runDeletionPlan({ uid: UID, admin, worker: fakeWorker(), r2Keys: new Set() })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'media_snapshot')
  assert.match(result.error, /page limit/)
  assert.equal(admin._calls.some(c => c.op === 'deleteUser'), false)
})

// ── sweep_r2_prefix ─────────────────────────────────────────────────

test('sweep_r2_prefix runs after delete_profile and before delete_auth_user', () => {
  const profile = STAGES.findIndex(s => s.name === 'delete_profile')
  const sweep = STAGES.findIndex(s => s.name === 'sweep_r2_prefix')
  const auth = STAGES.findIndex(s => s.name === 'delete_auth_user')
  assert.ok(profile >= 0 && sweep >= 0 && auth >= 0)
  assert.ok(profile < sweep, 'the worker refuses to sweep while the profile exists')
  assert.ok(sweep < auth, 'a failed sweep must leave the auth user for a retry')
})

test('runDeletionPlan: sweep_r2_prefix repeats until the worker reports done', async () => {
  const admin = fakeAdmin()
  const worker = fakeWorker({
    sweepResults: [
      { ok: true, status: 200, deleted: 5000, done: false },
      { ok: true, status: 200, deleted: 12, done: true },
    ],
  })
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, true)
  assert.equal(worker.sweeps.length, 3, 'preflight plus two sweep calls')
  assert.ok(admin._calls.find(c => c.op === 'deleteUser'))
})

test('runDeletionPlan: a failed sweep stops before the auth user is deleted', async () => {
  for (const overrides of [
    { sweepResults: [{ ok: false, status: 409, detail: 'profile_exists' }] },
    { sweepResults: [{ ok: true, status: 200, deleted: 3, done: false }, { ok: false, status: 502, detail: 'media_sweep_failed' }] },
    { sweepThrows: 'network down' },
    { sweepResults: Array.from({ length: SWEEP_MAX_CALLS }, () => ({ ok: true, status: 200, deleted: 5000, done: false })) },
  ]) {
    const admin = fakeAdmin()
    const worker = fakeWorker(overrides)
    const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'sweep_r2_prefix')
    assert.ok(r.completed.includes('delete_profile'))
    assert.equal(admin._calls.find(c => c.op === 'deleteUser'), undefined)
  }
})

test('sweep_preflight runs first and stops the plan before any deletion when the sweep is not ready', async () => {
  assert.equal(STAGES[0].name, 'sweep_preflight')
  for (const preflight of [
    () => ({ ok: false, status: 404, detail: 'not_found' }),
    () => ({ ok: false, status: 503, detail: 'sweep_unavailable' }),
    () => ({ ok: false, status: 409, detail: 'something_else' }),
    () => ({ ok: false, detail: 'network down' }),
    () => { throw new Error('timeout') },
  ]) {
    const admin = fakeAdmin()
    const worker = fakeWorker({ preflight })
    const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'sweep_preflight')
    assert.deepEqual(r.completed, [])
    assert.equal(worker.deleted.length, 0)
    assert.deepEqual(admin._calls, [], 'no database call before the preflight passes')
  }
})

test('sweep_preflight accepts a real sweep on a retry after the profile is gone', async () => {
  const admin = fakeAdmin()
  const worker = fakeWorker({ preflight: () => ({ ok: true, status: 200, deleted: 7, done: true }) })
  const r = await runDeletionPlan({ uid: UID, admin, worker, r2Keys: new Set() })
  assert.equal(r.ok, true)
})

test('delete-account refuses every method but POST and OPTIONS before running the plan', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const methodGuard = source.indexOf("req.method !== 'POST'")
  assert.ok(methodGuard > 0)
  assert.ok(methodGuard < source.indexOf('auth.getUser()'))
  assert.ok(methodGuard < source.indexOf('runDeletionPlan({'))
})
