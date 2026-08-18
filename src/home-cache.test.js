// Stage B2a: unit tests for the user-scoped Home read-model cache. The
// IndexedDB backend is swapped for an in-memory one (the tests run in plain
// Node); the schema/validation/namespacing logic under test is identical.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HOME_CACHE_SCHEMA_VERSION,
  clearAllHomeCaches,
  clearHomeCache,
  readHomeCache,
  writeHomeCache,
} from './home-cache.js'

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

function failingBackend(message = 'idb unavailable') {
  return {
    async get() { throw new Error(message) },
    async put() { throw new Error(message) },
    async delete() { throw new Error(message) },
    async clear() { throw new Error(message) },
  }
}

const USER_A = 'user-aaaa'
const USER_B = 'user-bbbb'

function sampleModel() {
  return {
    recentFinds: {
      items: [{ id: 'obs-1', user_id: USER_A, common_name: 'Fly agaric', _owner: 'mine', image: { key: 'k/obs-1.jpg', primaryUrl: 'https://media.example/k/obs-1_medium.jpg', fallbackUrl: null } }],
      profiles: {},
    },
    friendRequests: { pending: [], accepted: [], profiles: {} },
    recentComments: { items: [], authors: {}, observations: {}, images: {} },
    stats: { observations: 12, species: 5, sporeMeasurements: 3 },
  }
}

test('write/read roundtrip returns the persisted model with age metadata', async () => {
  const backend = memBackend()
  const t0 = 1_000_000
  const ok = await writeHomeCache(USER_A, sampleModel(), { backend, now: () => t0 })
  assert.equal(ok, true)

  const read = await readHomeCache(USER_A, { backend, now: () => t0 + 5_000 })
  assert.ok(read)
  assert.equal(read.userId, USER_A)
  assert.equal(read.updatedAt, t0)
  assert.equal(read.ageMs, 5_000)
  assert.equal(read.model.stats.observations, 12)
  assert.equal(read.model.recentFinds.items[0].image.primaryUrl, 'https://media.example/k/obs-1_medium.jpg')
})

test('cache is keyed by userId: A cannot read B and vice versa', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, sampleModel(), { backend })
  assert.equal(await readHomeCache(USER_B, { backend }), null)

  // Even a corrupted record whose stored userId differs from its key fails closed.
  backend.map.set(USER_B, { version: HOME_CACHE_SCHEMA_VERSION, userId: USER_A, updatedAt: 1, model: { stats: {} } })
  assert.equal(await readHomeCache(USER_B, { backend }), null)
})

test('missing / empty userId reads and writes fail closed — no "last cache" fallback exists', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, sampleModel(), { backend })
  assert.equal(await readHomeCache('', { backend }), null)
  assert.equal(await readHomeCache(null, { backend }), null)
  assert.equal(await writeHomeCache('', sampleModel(), { backend }), false)
  assert.equal(await writeHomeCache(null, sampleModel(), { backend }), false)
})

test('malformed records fail closed', async () => {
  const backend = memBackend()
  for (const bad of [
    'not-an-object',
    { version: HOME_CACHE_SCHEMA_VERSION, userId: USER_A, updatedAt: 1 }, // no model
    { version: HOME_CACHE_SCHEMA_VERSION, userId: USER_A, updatedAt: 1, model: 'string' },
    { version: HOME_CACHE_SCHEMA_VERSION, userId: USER_A, updatedAt: 1, model: [1, 2] },
  ]) {
    backend.map.set(USER_A, bad)
    assert.equal(await readHomeCache(USER_A, { backend }), null)
  }
})

test('schema-version mismatch fails closed (no migration attempt)', async () => {
  const backend = memBackend()
  backend.map.set(USER_A, { version: HOME_CACHE_SCHEMA_VERSION + 1, userId: USER_A, updatedAt: 1, model: { stats: {} } })
  assert.equal(await readHomeCache(USER_A, { backend }), null)
  backend.map.set(USER_A, { userId: USER_A, updatedAt: 1, model: { stats: {} } })
  assert.equal(await readHomeCache(USER_A, { backend }), null)
})

test('storage failures never throw: read null, write/clear false', async () => {
  const backend = failingBackend()
  assert.equal(await readHomeCache(USER_A, { backend }), null)
  assert.equal(await writeHomeCache(USER_A, sampleModel(), { backend }), false)
  assert.equal(await clearHomeCache(USER_A, { backend }), false)
  assert.equal(await clearAllHomeCaches({ backend }), false)
})

test('a hung backend read resolves null after the timeout instead of blocking boot', async () => {
  const backend = {
    get: () => new Promise(() => {}), // never resolves
  }
  const read = await readHomeCache(USER_A, { backend, timeoutMs: 20 })
  assert.equal(read, null)
})

test('stale caches remain readable — age is metadata, not a TTL', async () => {
  const backend = memBackend()
  const twoWeeksAgo = Date.now() - 14 * 24 * 3600 * 1000
  await writeHomeCache(USER_A, sampleModel(), { backend, now: () => twoWeeksAgo })
  const read = await readHomeCache(USER_A, { backend })
  assert.ok(read, 'two-week-old cache must still render offline')
  assert.ok(read.ageMs > 13 * 24 * 3600 * 1000)
})

test('clearHomeCache removes only that user; clearAllHomeCaches removes everything', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, sampleModel(), { backend })
  await writeHomeCache(USER_B, sampleModel(), { backend })

  assert.equal(await clearHomeCache(USER_A, { backend }), true)
  assert.equal(await readHomeCache(USER_A, { backend }), null)
  assert.ok(await readHomeCache(USER_B, { backend }), 'B\'s cache must survive A\'s clear')

  assert.equal(await clearAllHomeCaches({ backend }), true)
  assert.equal(await readHomeCache(USER_B, { backend }), null)
})

test('account-delete cleanup: clearing by userId leaves no readable record', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, sampleModel(), { backend })
  await clearHomeCache(USER_A, { backend })
  assert.equal(backend.map.has(USER_A), false)
})

test('write sanitization: signed URLs, protectedUrl and token-named keys never persist', async () => {
  const backend = memBackend()
  const model = sampleModel()
  model.recentFinds.items[0].image = {
    key: 'k/obs-1.jpg',
    primaryUrl: 'https://storage.example/object/sign/avatars/x.jpg?token=abc123',
    fallbackUrl: 'https://media.example/ok.jpg',
    protectedUrl: 'https://worker.example/protected/k/obs-1.jpg',
  }
  model.recentFinds.profiles = {
    'friend-1': { id: 'friend-1', username: 'amanita', avatar_url: 'https://storage.example/storage/v1/object/sign/avatars/friend-1/avatar.jpg?token=zzz' },
  }
  model.stats.access_token = 'leak-me'
  model.stats.refresh_token = 'leak-me-too'

  await writeHomeCache(USER_A, model, { backend })
  const persisted = backend.map.get(USER_A)
  const raw = JSON.stringify(persisted)
  assert.ok(!raw.includes('token=abc123'))
  assert.ok(!raw.includes('token=zzz'))
  assert.ok(!raw.includes('protectedUrl'))
  assert.ok(!raw.includes('leak-me'))
  // Non-signed values survive; signed strings are nulled, keys dropped.
  const img = persisted.model.recentFinds.items[0].image
  assert.equal(img.primaryUrl, null)
  assert.equal(img.fallbackUrl, 'https://media.example/ok.jpg')
  assert.equal(img.key, 'k/obs-1.jpg')
  assert.equal(persisted.model.recentFinds.profiles['friend-1'].avatar_url, null)
})

test('write drops unknown top-level sections and refuses empty/invalid models', async () => {
  const backend = memBackend()
  const model = sampleModel()
  model.domNode = { nodeType: 1 }
  model.someFutureSection = { big: 'blob' }
  await writeHomeCache(USER_A, model, { backend })
  const persisted = backend.map.get(USER_A)
  assert.equal(persisted.model.domNode, undefined)
  assert.equal(persisted.model.someFutureSection, undefined)

  assert.equal(await writeHomeCache(USER_A, null, { backend }), false)
  assert.equal(await writeHomeCache(USER_A, 'string', { backend }), false)
  assert.equal(await writeHomeCache(USER_A, { onlyUnknown: 1 }, { backend }), false)
})

test('a failed write leaves the previous good record intact', async () => {
  const backend = memBackend()
  await writeHomeCache(USER_A, sampleModel(), { backend })
  const ok = await writeHomeCache(USER_A, { onlyUnknown: true }, { backend })
  assert.equal(ok, false)
  const read = await readHomeCache(USER_A, { backend })
  assert.equal(read.model.stats.observations, 12)
})
