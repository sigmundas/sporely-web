// Stage B2a orchestration tests. Mirrors the cache-first Home startup
// decision matrix from main.js / screens/home.js as pure helpers (the real
// modules are DOM-heavy), while using the REAL home-cache module for every
// read/write so persistence semantics are exercised end-to-end. Any drift in
// the production orchestration should be reflected here; the structural
// tests in startup-invariants.test.js pin the production code to the same
// rules.

import test from 'node:test'
import assert from 'node:assert/strict'

import { readHomeCache, writeHomeCache } from './home-cache.js'
import { AUTH_STATE } from './auth-state.js'

function memBackend() {
  const map = new Map()
  return {
    map,
    async get(userId) { return map.get(userId) ?? null },
    async put(record) { map.set(record.userId, record) },
    async delete(userId) { map.delete(userId) },
    async clear() { map.clear() },
  }
}

const USER_A = 'user-aaaa'
const USER_B = 'user-bbbb'

function modelFor(label) {
  return {
    recentFinds: { items: [{ id: `${label}-obs`, common_name: label }], profiles: {} },
    stats: { observations: 1, species: 1, sporeMeasurements: 0 },
  }
}

// Mirrors main.js's COMPLETE-branch post-reveal task + home.js's
// refreshHomeSafe: cached render strictly precedes the single online
// refresh; fulfilled sections persist (merge-preserving failed ones);
// nothing persists when every section fails.
async function orchestrateOnlineBoot({ userId, backend, fetchSections, authState = AUTH_STATE.AUTHENTICATED_COMPLETE }) {
  const events = []
  let networkRefreshes = 0

  const cached = await readHomeCache(userId, { backend })
  if (cached) events.push({ type: 'render', source: 'cache', model: cached.model })

  // Exactly one online refresh.
  networkRefreshes += 1
  const settled = await Promise.allSettled(Object.values(fetchSections).map(fn => fn()))
  const keys = Object.keys(fetchSections)
  const freshSections = {}
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      freshSections[keys[i]] = res.value
      events.push({ type: 'render', source: 'network', section: keys[i] })
    } else if (!cached) {
      events.push({ type: 'render-error', section: keys[i] })
    } // cached content stays visible on failure — no render event
  })

  // Cache-write policy from _persistFreshHomeSections.
  let wrote = false
  if (Object.keys(freshSections).length && authState === AUTH_STATE.AUTHENTICATED_COMPLETE) {
    const existing = await readHomeCache(userId, { backend })
    wrote = await writeHomeCache(userId, { ...(existing?.model || {}), ...freshSections }, { backend })
  }

  return { events, networkRefreshes, wrote }
}

// Mirrors the cached/offline boot: local read only, zero network.
async function orchestrateOfflineBoot({ userId, backend }) {
  const events = []
  const cached = await readHomeCache(userId, { backend })
  if (cached) events.push({ type: 'render', source: 'cache', model: cached.model })
  else events.push({ type: 'render', source: 'offline-empty-state' })
  return { events, networkRefreshes: 0 }
}

test('online boot: cached model renders BEFORE fresh network data, exactly one refresh, fresh model overwrites cache', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('old'), { backend })

  const { events, networkRefreshes, wrote } = await orchestrateOnlineBoot({
    userId: USER_A,
    backend,
    fetchSections: {
      recentFinds: async () => modelFor('fresh').recentFinds,
      stats: async () => modelFor('fresh').stats,
    },
  })

  assert.equal(events[0].source, 'cache', 'cached render must precede network renders')
  assert.equal(events[0].model.recentFinds.items[0].common_name, 'old')
  assert.ok(events.slice(1).every(e => e.source === 'network'))
  assert.equal(networkRefreshes, 1)
  assert.equal(wrote, true)

  const after = await readHomeCache(USER_A, { backend })
  assert.equal(after.model.recentFinds.items[0].common_name, 'fresh')
})

test('online boot: a hung cache read forfeits the cached paint within the budget and the refresh proceeds', async () => {
  // Mirrors main.js's HOME_CACHE_ONLINE_BOOT_BUDGET_MS: past the budget the
  // read resolves null (see home-cache timeout contract) and the single
  // network refresh runs — a hung IndexedDB costs milliseconds, not seconds.
  const hungBackend = { get: () => new Promise(() => {}) }
  const started = Date.now()
  const cached = await readHomeCache(USER_A, { backend: hungBackend, timeoutMs: 25 })
  assert.equal(cached, null)
  assert.ok(Date.now() - started < 1000, 'budgeted read must not stall startup')

  const { events, networkRefreshes } = await orchestrateOnlineBoot({
    userId: USER_A,
    backend: memBackend(),
    fetchSections: { recentFinds: async () => modelFor('fresh').recentFinds },
  })
  assert.equal(networkRefreshes, 1)
  assert.ok(events.some(e => e.source === 'network'))
})

test('online boot: cache read failure/miss does not block the online refresh', async () => {
  const backend = memBackend() // empty — cache miss
  const { events, networkRefreshes } = await orchestrateOnlineBoot({
    userId: USER_A,
    backend,
    fetchSections: { recentFinds: async () => modelFor('fresh').recentFinds },
  })
  assert.equal(networkRefreshes, 1)
  assert.ok(events.some(e => e.source === 'network'))
})

test('online boot: total network failure preserves the old cached Home and keeps it visible', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('good'), { backend })

  const { events, wrote } = await orchestrateOnlineBoot({
    userId: USER_A,
    backend,
    fetchSections: {
      recentFinds: async () => { throw new Error('network down') },
      stats: async () => { throw new Error('network down') },
    },
  })

  assert.equal(wrote, false, 'a failed refresh must not write the cache')
  assert.ok(!events.some(e => e.type === 'render-error'), 'cached content beats error placeholders')
  const after = await readHomeCache(USER_A, { backend })
  assert.equal(after.model.recentFinds.items[0].common_name, 'good', 'temporary network failure must not destroy a good cache')
})

test('online boot: partially failed refresh persists successful sections and preserves cached values for failed ones', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('cachedv1'), { backend })

  const { wrote } = await orchestrateOnlineBoot({
    userId: USER_A,
    backend,
    fetchSections: {
      recentFinds: async () => { throw new Error('flaky') },
      stats: async () => ({ observations: 42, species: 9, sporeMeasurements: 1 }),
    },
  })

  assert.equal(wrote, true)
  const after = await readHomeCache(USER_A, { backend })
  assert.equal(after.model.stats.observations, 42, 'fresh section updates')
  assert.equal(after.model.recentFinds.items[0].common_name, 'cachedv1', 'failed section keeps last good value')
})

test('offline boot (AUTHENTICATED_CACHED): cached Home renders with zero network refreshes', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('offline'), { backend })
  const { events, networkRefreshes } = await orchestrateOfflineBoot({ userId: USER_A, backend })
  assert.equal(networkRefreshes, 0)
  assert.equal(events[0].source, 'cache')
})

test('offline boot without a cache: offline empty state, zero refreshes, never Login', async () => {
  const backend = memBackend()
  const { events, networkRefreshes } = await orchestrateOfflineBoot({ userId: USER_A, backend })
  assert.equal(networkRefreshes, 0)
  assert.equal(events[0].source, 'offline-empty-state')
})

test('repeated offline launches render the same cached Home', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('stable'), { backend })
  const first = await orchestrateOfflineBoot({ userId: USER_A, backend })
  const second = await orchestrateOfflineBoot({ userId: USER_A, backend })
  assert.deepEqual(first.events[0].model, second.events[0].model)
})

test('reauth-required: cached Home stays readable but no authenticated refresh persists until COMPLETE', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('cachedv1'), { backend })

  // Offline-style boot renders the cache (readable in REAUTH_REQUIRED)...
  const boot = await orchestrateOfflineBoot({ userId: USER_A, backend })
  assert.equal(boot.events[0].source, 'cache')

  // ...and even if a refresh were attempted while not COMPLETE, the write
  // gate refuses to overwrite the cache.
  const { wrote } = await orchestrateOnlineBoot({
    userId: USER_A,
    backend,
    authState: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED,
    fetchSections: { stats: async () => ({ observations: 99, species: 1, sporeMeasurements: 0 }) },
  })
  assert.equal(wrote, false)
  const after = await readHomeCache(USER_A, { backend })
  assert.equal(after.model.recentFinds.items[0].common_name, 'cachedv1')
})

test('reconnect: cached Home stays visible, transition to COMPLETE triggers one refresh that updates the cache', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('offline'), { backend })

  // Offline session first.
  const offline = await orchestrateOfflineBoot({ userId: USER_A, backend })
  assert.equal(offline.networkRefreshes, 0)

  // Reconnect → in-place revalidation: no re-render from cache (content is
  // already visible), exactly one refresh, cache rewritten.
  let refreshes = 0
  const refresh = async () => {
    refreshes += 1
    const existing = await readHomeCache(USER_A, { backend })
    await writeHomeCache(USER_A, { ...existing.model, ...modelFor('reconnected') }, { backend })
  }
  // Both the auth transition and a racing `online` listener funnel through
  // one guarded trigger (mirrors _cachedRevalidationInFlight +
  // _resolutionInFlight): the second call is a no-op.
  let inFlight = null
  const trigger = () => { inFlight = inFlight || refresh().finally(() => { inFlight = null }); return inFlight }
  await Promise.all([trigger(), trigger()])

  assert.equal(refreshes, 1, 'auth transition + connectivity listener must not double-refresh')
  const after = await readHomeCache(USER_A, { backend })
  assert.equal(after.model.recentFinds.items[0].common_name, 'reconnected')
})

test('account isolation: A\'s cache never renders for B; B without a cache gets the empty state', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, modelFor('a-private'), { backend })

  const bBoot = await orchestrateOfflineBoot({ userId: USER_B, backend })
  assert.equal(bBoot.events[0].source, 'offline-empty-state', 'B must never see A\'s cached Home')

  await writeHomeCache(USER_B, modelFor('b-own'), { backend })
  const bBoot2 = await orchestrateOfflineBoot({ userId: USER_B, backend })
  assert.equal(bBoot2.events[0].model.recentFinds.items[0].common_name, 'b-own')
  // A's record untouched throughout.
  const aRead = await readHomeCache(USER_A, { backend })
  assert.equal(aRead.model.recentFinds.items[0].common_name, 'a-private')
})

test('sync status is not part of the persisted model — queue state cannot be overridden by a stale cache', async () => {
  const backend = memBackend()
  // Even a hostile model claiming sync/queue state is dropped by the
  // section allowlist (only recentFinds/friendRequests/recentComments/stats
  // persist).
  await writeHomeCache(USER_A, { ...modelFor('x'), syncStatus: { pending: 0 }, queue: { pending: 0 } }, { backend })
  const read = await readHomeCache(USER_A, { backend })
  assert.equal(read.model.syncStatus, undefined)
  assert.equal(read.model.queue, undefined)
})
