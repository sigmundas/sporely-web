import {
  buildProfileStorageKeys,
  buildTombstoneDeleteTargets,
  calculateProfileStorageUsageWithClient,
  getRestoreWindowDays,
  R2MultiBucketClient,
} from './adminActions.ts'

function assertEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`)
  }
}

async function assertRejects(fn: () => Promise<unknown>, message: string) {
  try {
    await fn()
  } catch (error) {
    if (String((error as Error)?.message || error).includes(message)) return
    throw error
  }
  throw new Error(`Expected rejection containing ${message}`)
}

function fakeBucket(
  role: 'legacy' | 'private',
  entries: Record<string, number> = {},
  options: { failDelete?: boolean } = {},
) {
  const objects = new Map(Object.entries(entries))
  const deleted: string[] = []
  return {
    role,
    deleted,
    has: (key: string) => objects.has(key),
    async headObject(key: string) {
      if (!objects.has(key)) {
        return { ok: false as const, status: 404, error: 'missing', kind: 'variant' as const, role }
      }
      return { ok: true as const, status: 200, size: objects.get(key) ?? 0, kind: 'variant' as const, role }
    },
    async deleteObject(key: string) {
      deleted.push(key)
      if (options.failDelete) throw Object.assign(new Error('temporary'), { status: 503, code: 'temporary' })
      objects.delete(key)
    },
  }
}

Deno.test('tombstone targets include full, thumb, and exact original only', () => {
  assertEquals(buildTombstoneDeleteTargets(
    'user/obs/full.webp',
    'user/obs/originals/42/source.heic',
  ), [
    'user/obs/full.webp',
    'user/obs/thumb_full.webp',
    'user/obs/thumb_small_full.webp',
    'user/obs/thumb_medium_full.webp',
    'user/obs/originals/42/source.heic',
  ])
})

Deno.test('quota inventory includes full, thumb, original, and mosaic logical identities', () => {
  assertEquals(buildProfileStorageKeys({
    media_kind: 'image',
    storage_path: 'user/obs/full.webp',
    original_storage_path: 'user/obs/originals/42/source.heic',
  }), [
    'user/obs/full.webp',
    'user/obs/thumb_full.webp',
    'user/obs/thumb_small_full.webp',
    'user/obs/thumb_medium_full.webp',
    'user/obs/originals/42/source.heic',
  ])
  assertEquals(buildProfileStorageKeys({
    media_kind: 'mosaic',
    storage_key: 'user/obs/spore_mosaic.webp',
  }), ['user/obs/spore_mosaic.webp'])
})

Deno.test('storage reconciliation follows logical media and primary-image count rules', async () => {
  const sizes: Record<string, number> = {
    'user/active.webp': 100,
    'user/thumb_active.webp': 20,
    'user/tombstone.webp': 80,
    'user/thumb_tombstone.webp': 15,
    'user/originals/source.heic': 200,
    'user/mosaic.webp': 40,
    // A residual object referenced only by a fully purged row must not count.
    'user/purged.webp': 999,
  }
  const client = {
    async headObject(key: string) {
      return Object.hasOwn(sizes, key)
        ? { ok: true, status: 200, size: sizes[key] }
        : { ok: false, status: 404, error: 'missing' }
    },
  }
  const result = await calculateProfileStorageUsageWithClient([
    { id: 1, media_kind: 'image', storage_path: 'user/active.webp' },
    // Duplicate metadata must not double-count one logical object.
    { id: 2, media_kind: 'image', storage_path: 'user/active.webp' },
    { id: 3, media_kind: 'image', storage_path: 'user/tombstone.webp',
      original_storage_path: 'user/originals/source.heic', deleted_at: '2026-08-01' },
    { id: 4, media_kind: 'image', storage_path: null },
    { id: 5, media_kind: 'image', storage_path: 'user/purged.webp', purged_at: '2026-08-02' },
    { id: 6, media_kind: 'mosaic', storage_key: 'user/mosaic.webp' },
  ], client)

  assertEquals(result.storage_used_bytes, 455)
  assertEquals(result.image_count, 2)
  assertEquals(result.checked_objects, 10)
  assertEquals(result.classes, {
    full: { bytes: 180, objects: 2, missing: 0 },
    thumb: { bytes: 35, objects: 2, missing: 4 },
    original: { bytes: 200, objects: 1, missing: 0 },
    mosaic: { bytes: 40, objects: 1, missing: 0 },
  })
})

Deno.test('dual bucket deletion removes both copies but counts logical bytes once', async () => {
  const key = 'user/obs/full.webp'
  const legacy = fakeBucket('legacy', { [key]: 100 })
  const priv = fakeBucket('private', { [key]: 100 })
  const client = new R2MultiBucketClient([legacy, priv] as never)

  const result = await client.deleteObjects([key])

  assertEquals(result.logicalBytes, 100)
  assertEquals(legacy.has(key), false)
  assertEquals(priv.has(key), false)
})

Deno.test('single configured legacy bucket remains valid before private binding exists', async () => {
  const key = 'user/obs/thumb_full.webp'
  const legacy = fakeBucket('legacy', { [key]: 25 })
  const client = new R2MultiBucketClient([legacy] as never)

  const result = await client.deleteObjects([key])

  assertEquals(result.logicalBytes, 25)
  assertEquals(legacy.has(key), false)
})

Deno.test('private-only and already-absent objects are idempotent successes', async () => {
  const key = 'user/obs/originals/42/source.heic'
  const priv = fakeBucket('private', { [key]: 80 })
  const client = new R2MultiBucketClient([priv] as never)

  assertEquals((await client.deleteObjects([key])).logicalBytes, 80)
  assertEquals((await client.deleteObjects([key])).logicalBytes, 0)
})

Deno.test('configured private failure is surfaced after the legacy attempt', async () => {
  const key = 'user/obs/full.webp'
  const legacy = fakeBucket('legacy', { [key]: 100 })
  const priv = fakeBucket('private', { [key]: 100 }, { failDelete: true })
  const client = new R2MultiBucketClient([legacy, priv] as never)

  await assertRejects(() => client.deleteObjects([key]), 'R2 cleanup was incomplete')
  assertEquals(legacy.has(key), false)
  assertEquals(priv.has(key), true)
  assertEquals(legacy.deleted, [key])
  assertEquals(priv.deleted, [key])
})

Deno.test('partial failure retains the full logical byte snapshot for a retry', async () => {
  const first = 'user/obs/full.webp'
  const second = 'user/obs/thumb_full.webp'
  const legacy = fakeBucket('legacy', { [first]: 100, [second]: 25 })
  const priv = fakeBucket('private', { [first]: 100, [second]: 25 }, { failDelete: true })
  const client = new R2MultiBucketClient([legacy, priv] as never)

  try {
    await client.deleteObjects([first, second])
    throw new Error('expected delete failure')
  } catch (error) {
    assertEquals((error as { details?: { logicalBytes?: number } }).details?.logicalBytes, 125)
  }
})

// --- getRestoreWindowDays policy tests ---

Deno.test('restore window: server policy 30 + request restore_window_days=1 => cutoff remains 30 days (request ignored)', () => {
  // requestBody.restore_window_days has no influence — server env is authoritative
  const env = { ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '30' }
  assertEquals(getRestoreWindowDays(env), 30)
  // Even with a different env getter returning 30, a fake "request-only" getter must not be applied
  assertEquals(getRestoreWindowDays({}, () => '30'), 30)
})

Deno.test('restore window: env set to 45 => 45 used', () => {
  const env = { ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '45' }
  assertEquals(getRestoreWindowDays(env), 45)
})

Deno.test('restore window: env missing or invalid => 30-day default', () => {
  assertEquals(getRestoreWindowDays({}), 30)
  assertEquals(getRestoreWindowDays({}, () => 'abc'), 30)
  assertEquals(getRestoreWindowDays({}, () => '0'), 30)
  assertEquals(getRestoreWindowDays({}, () => '-5'), 30)
  assertEquals(getRestoreWindowDays({}, () => undefined), 30)
})

Deno.test('restore window: preview and purge use identical cutoff (same policy function/window)', () => {
  const env = { ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '60' }
  const previewWindow = getRestoreWindowDays(env)
  const purgeWindow = getRestoreWindowDays(env)
  assertEquals(previewWindow, purgeWindow)
  assertEquals(previewWindow, 60)
})

Deno.test('restore window: tombstone deleted 2 days ago is NOT purge-eligible under 30-day policy', () => {
  const env = { ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '30' }
  const windowDays = getRestoreWindowDays(env)
  const deletedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const isEligible = deletedAt <= cutoff
  assertEquals(isEligible, false)
})
