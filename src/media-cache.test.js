// Stage B — media-cache storage tests. IndexedDB is replaced with an
// in-memory backend so the tests run under `node --test`. The schema/
// keying/LRU/eviction logic under test is identical to the production
// path.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEDIA_CACHE_MAX_ENTRY_BYTES,
  MEDIA_CACHE_MAX_TOTAL_BYTES,
  MEDIA_CACHE_SCHEMA_VERSION,
  MEDIA_KIND,
  MEDIA_PRIVACY_SCOPE,
  buildMediaCacheKey,
  clearAllCachedMedia,
  clearMediaCacheForUser,
  deleteCachedMedia,
  normalizeMediaVariant,
  readCachedMedia,
  summarizeCachedMediaForTests,
  writeCachedMedia,
} from './media-cache.js'

// Minimal Blob polyfill for Node <22 environments (node 22+ has global Blob;
// tests rely on it). We still provide a small ducked shape so tests can
// simulate "not-an-image" and "oversized" payloads without materializing
// large buffers.
function fakeBlob(size, type = 'image/webp') {
  return {
    size,
    type,
    async arrayBuffer() { return new ArrayBuffer(size) },
  }
}

function memBackend() {
  const map = new Map()
  return {
    map,
    async get(cacheKey) { return map.get(cacheKey) ?? null },
    async put(record) { map.set(record.cacheKey, record) },
    async delete(cacheKey) { map.delete(cacheKey) },
    async getAll() { return [...map.values()] },
    async clear() { map.clear() },
  }
}

const USER_A = 'user-aaaa'
const USER_B = 'user-bbbb'

const publicIdentity = (userId = USER_A, mediaKey = 'obs-1/img.jpg') => ({
  userId,
  mediaKind: MEDIA_KIND.OBSERVATION_THUMB,
  privacyScope: MEDIA_PRIVACY_SCOPE.PUBLIC,
  mediaKey,
  variant: 'thumb',
})

const protectedIdentity = (userId = USER_A, mediaKey = 'obs-1/img.jpg') => ({
  userId,
  mediaKind: MEDIA_KIND.OBSERVATION_THUMB,
  privacyScope: MEDIA_PRIVACY_SCOPE.PROTECTED,
  mediaKey,
  variant: 'thumb',
})

const avatarIdentity = (userId = USER_A) => ({
  userId,
  mediaKind: MEDIA_KIND.AVATAR,
  privacyScope: MEDIA_PRIVACY_SCOPE.SELF,
  mediaKey: `self:${userId}`,
  variant: 'original',
})

test('normalizeMediaVariant maps small/medium/cards/thumb to canonical thumb', () => {
  assert.equal(normalizeMediaVariant('small', MEDIA_KIND.OBSERVATION_THUMB), 'thumb')
  assert.equal(normalizeMediaVariant('medium', MEDIA_KIND.OBSERVATION_THUMB), 'thumb')
  assert.equal(normalizeMediaVariant('cards', MEDIA_KIND.OBSERVATION_THUMB), 'thumb')
  assert.equal(normalizeMediaVariant('thumb', MEDIA_KIND.OBSERVATION_THUMB), 'thumb')
  // Avatar always canonicalizes to 'original' regardless of caller value.
  assert.equal(normalizeMediaVariant('anything', MEDIA_KIND.AVATAR), 'original')
})

test('cache key composition never encodes signed URLs or tokens', () => {
  const key = buildMediaCacheKey(publicIdentity(USER_A, 'obs/1.jpg'))
  assert.ok(key.startsWith('v1|user-aaaa|observation-thumb|public|obs/1.jpg|thumb'))
  assert.equal(key.includes('token'), false)
  assert.equal(key.includes('http'), false)
})

test('write/read roundtrip returns the persisted blob with normalized variant', async () => {
  const backend = memBackend()
  const blob = fakeBlob(1024)
  const t0 = 1_000_000
  const ok = await writeCachedMedia(publicIdentity(), blob, { backend, now: () => t0 })
  assert.equal(ok, true)

  const read = await readCachedMedia(publicIdentity(), { backend, now: () => t0 + 5_000 })
  assert.ok(read)
  assert.equal(read.userId, USER_A)
  assert.equal(read.privacyScope, 'public')
  assert.equal(read.variant, 'thumb')
  assert.equal(read.contentType, 'image/webp')
  assert.equal(read.sizeBytes, 1024)
  assert.equal(read.lastAccessedAt, t0 + 5_000)
  assert.equal(read.blob.size, 1024)
})

test('missing / empty userId reads and writes fail closed', async () => {
  const backend = memBackend()
  const blob = fakeBlob(1024)
  assert.equal(await writeCachedMedia({ ...publicIdentity(), userId: '' }, blob, { backend }), false)
  assert.equal(await writeCachedMedia({ ...publicIdentity(), userId: null }, blob, { backend }), false)
  assert.equal(await readCachedMedia({ ...publicIdentity(), userId: '' }, { backend }), null)
  assert.equal(await readCachedMedia({ ...publicIdentity(), userId: null }, { backend }), null)
})

test('malformed record shapes return null', async () => {
  const backend = memBackend()
  const key = buildMediaCacheKey(publicIdentity())
  for (const bad of [
    null,
    'string',
    { version: MEDIA_CACHE_SCHEMA_VERSION }, // missing everything
    { version: MEDIA_CACHE_SCHEMA_VERSION, cacheKey: key, userId: USER_A },
    { version: MEDIA_CACHE_SCHEMA_VERSION, cacheKey: key, userId: USER_A, mediaKind: 'observation-thumb', privacyScope: 'public', mediaKey: 'obs-1/img.jpg', variant: 'thumb', blob: null },
  ]) {
    backend.map.set(key, bad)
    assert.equal(await readCachedMedia(publicIdentity(), { backend }), null)
  }
})

test('schema mismatch fails soft as a cache miss', async () => {
  const backend = memBackend()
  const key = buildMediaCacheKey(publicIdentity())
  backend.map.set(key, {
    version: MEDIA_CACHE_SCHEMA_VERSION + 999,
    cacheKey: key,
    userId: USER_A,
    mediaKind: 'observation-thumb',
    privacyScope: 'public',
    mediaKey: 'obs-1/img.jpg',
    variant: 'thumb',
    blob: fakeBlob(1),
  })
  assert.equal(await readCachedMedia(publicIdentity(), { backend }), null)
})

test('cross-user record refuses to render for the wrong user', async () => {
  const backend = memBackend()
  await writeCachedMedia(publicIdentity(USER_A), fakeBlob(1024), { backend })
  // Rebuild the record under A's cache key but with an alien userId (simulate
  // a tampered record). The read must refuse.
  const keyA = buildMediaCacheKey(publicIdentity(USER_A))
  const stored = backend.map.get(keyA)
  backend.map.set(keyA, { ...stored, userId: USER_B })
  assert.equal(await readCachedMedia(publicIdentity(USER_A), { backend }), null)
})

test('public and protected scopes never alias', async () => {
  const backend = memBackend()
  await writeCachedMedia(publicIdentity(), fakeBlob(1024, 'image/jpeg'), { backend })
  // Protected read for the SAME observation key must miss until it is
  // written separately.
  assert.equal(await readCachedMedia(protectedIdentity(), { backend }), null)
  await writeCachedMedia(protectedIdentity(), fakeBlob(2048, 'image/webp'), { backend })
  const pubRead = await readCachedMedia(publicIdentity(), { backend })
  const prvRead = await readCachedMedia(protectedIdentity(), { backend })
  assert.ok(pubRead)
  assert.ok(prvRead)
  assert.notEqual(pubRead.sizeBytes, prvRead.sizeBytes)
})

test('non-image blob is refused (contentType guard)', async () => {
  const backend = memBackend()
  const ok = await writeCachedMedia(publicIdentity(), fakeBlob(2048, 'application/json'), { backend })
  assert.equal(ok, false)
  assert.equal(backend.map.size, 0)
})

test('oversized blob (>MEDIA_CACHE_MAX_ENTRY_BYTES) is refused', async () => {
  const backend = memBackend()
  const ok = await writeCachedMedia(publicIdentity(), fakeBlob(MEDIA_CACHE_MAX_ENTRY_BYTES + 1), { backend })
  assert.equal(ok, false)
})

test('readCachedMedia updates lastAccessedAt (LRU touch)', async () => {
  const backend = memBackend()
  const t0 = 1_000_000
  await writeCachedMedia(publicIdentity(), fakeBlob(2048), { backend, now: () => t0 })
  const stored = backend.map.get(buildMediaCacheKey(publicIdentity()))
  assert.equal(stored.lastAccessedAt, t0)
  await readCachedMedia(publicIdentity(), { backend, now: () => t0 + 12_345 })
  const after = backend.map.get(buildMediaCacheKey(publicIdentity()))
  assert.equal(after.lastAccessedAt, t0 + 12_345)
})

test('write evicts oldest entries when total cap would be exceeded', async () => {
  const backend = memBackend()
  const maxTotalBytes = 20_000
  const maxEntryBytes = 10_000
  // Fill with three 8_000-byte entries, spaced in time so LRU order is
  // deterministic.
  const identities = [
    publicIdentity(USER_A, 'obs-1/img.jpg'),
    publicIdentity(USER_A, 'obs-2/img.jpg'),
    publicIdentity(USER_A, 'obs-3/img.jpg'),
  ]
  await writeCachedMedia(identities[0], fakeBlob(8_000), { backend, now: () => 1000, maxTotalBytes, maxEntryBytes })
  await writeCachedMedia(identities[1], fakeBlob(8_000), { backend, now: () => 2000, maxTotalBytes, maxEntryBytes })
  // The third write should push the projected total (24_000) over the cap
  // (20_000) and evict the oldest (obs-1).
  await writeCachedMedia(identities[2], fakeBlob(8_000), { backend, now: () => 3000, maxTotalBytes, maxEntryBytes })
  const summary = await summarizeCachedMediaForTests({ backend })
  const remainingKeys = summary.map(r => r.mediaKey).sort()
  assert.deepEqual(remainingKeys, ['obs-2/img.jpg', 'obs-3/img.jpg'])
})

test('QuotaExceededError triggers evict-and-retry once', async () => {
  const inMemory = memBackend()
  let quotaHit = false
  const backend = {
    async get(k) { return inMemory.get(k) },
    async put(r) {
      if (!quotaHit) {
        quotaHit = true
        const err = new Error('quota exceeded')
        err.name = 'QuotaExceededError'
        throw err
      }
      return inMemory.put(r)
    },
    async delete(k) { return inMemory.delete(k) },
    async getAll() { return inMemory.getAll() },
    async clear() { return inMemory.clear() },
  }
  // Pre-populate one older record so eviction has something to evict.
  await inMemory.put({
    version: 1, cacheKey: buildMediaCacheKey(publicIdentity(USER_A, 'obs-old/img.jpg')),
    userId: USER_A, mediaKind: 'observation-thumb', privacyScope: 'public',
    mediaKey: 'obs-old/img.jpg', variant: 'thumb', contentType: 'image/webp',
    sizeBytes: 1024, createdAt: 1, updatedAt: 1, lastAccessedAt: 1, blob: fakeBlob(1024),
  })
  const ok = await writeCachedMedia(publicIdentity(), fakeBlob(1024), { backend })
  assert.equal(ok, true)
  // The old entry should have been evicted during retry.
  const summary = await summarizeCachedMediaForTests({ backend: inMemory })
  assert.equal(summary.some(r => r.mediaKey === 'obs-old/img.jpg'), false)
  assert.equal(summary.some(r => r.mediaKey === 'obs-1/img.jpg'), true)
})

test('storage exception during read is swallowed (returns null)', async () => {
  const backend = {
    async get() { throw new Error('idb boom') },
    async put() { throw new Error('idb boom') },
    async delete() { throw new Error('idb boom') },
    async getAll() { throw new Error('idb boom') },
    async clear() { throw new Error('idb boom') },
  }
  assert.equal(await readCachedMedia(publicIdentity(), { backend }), null)
  assert.equal(await writeCachedMedia(publicIdentity(), fakeBlob(1024), { backend }), false)
})

test('clearMediaCacheForUser removes only that user\'s records', async () => {
  const backend = memBackend()
  await writeCachedMedia(publicIdentity(USER_A, 'a/1.jpg'), fakeBlob(1024), { backend })
  await writeCachedMedia(publicIdentity(USER_A, 'a/2.jpg'), fakeBlob(1024), { backend })
  await writeCachedMedia(publicIdentity(USER_B, 'b/1.jpg'), fakeBlob(1024), { backend })
  assert.equal(backend.map.size, 3)
  await clearMediaCacheForUser(USER_A, { backend })
  const remaining = await summarizeCachedMediaForTests({ backend })
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].userId, USER_B)
})

test('clearAllCachedMedia empties the store', async () => {
  const backend = memBackend()
  await writeCachedMedia(publicIdentity(USER_A), fakeBlob(1024), { backend })
  await writeCachedMedia(publicIdentity(USER_B), fakeBlob(1024), { backend })
  assert.equal(backend.map.size, 2)
  await clearAllCachedMedia({ backend })
  assert.equal(backend.map.size, 0)
})

test('deleteCachedMedia removes a single identity', async () => {
  const backend = memBackend()
  await writeCachedMedia(publicIdentity(USER_A, 'a/1.jpg'), fakeBlob(1024), { backend })
  await writeCachedMedia(publicIdentity(USER_A, 'a/2.jpg'), fakeBlob(1024), { backend })
  await deleteCachedMedia(publicIdentity(USER_A, 'a/1.jpg'), { backend })
  const remaining = await summarizeCachedMediaForTests({ backend })
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].mediaKey, 'a/2.jpg')
})

test('avatar identity always uses scope "self" and cacheKey "self:<uid>"', async () => {
  const key = buildMediaCacheKey(avatarIdentity(USER_A))
  assert.ok(key.includes('|self|self:user-aaaa|'))
  const backend = memBackend()
  await writeCachedMedia(avatarIdentity(USER_A), fakeBlob(3096, 'image/jpeg'), { backend })
  const read = await readCachedMedia(avatarIdentity(USER_A), { backend })
  assert.ok(read)
  assert.equal(read.privacyScope, 'self')
  assert.equal(read.mediaKind, 'avatar')
})

test('MEDIA_CACHE_MAX_TOTAL_BYTES defaults to 64 MiB / entry cap 5 MiB', () => {
  assert.equal(MEDIA_CACHE_MAX_TOTAL_BYTES, 64 * 1024 * 1024)
  assert.equal(MEDIA_CACHE_MAX_ENTRY_BYTES, 5 * 1024 * 1024)
})
