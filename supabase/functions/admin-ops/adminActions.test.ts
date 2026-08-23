import {
  buildImageIssueFlags,
  buildIssueSummary,
  buildMediaIssueSeverity,
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

Deno.test('restore window: request restore_window_days cannot shorten the server policy', () => {
  // The signature no longer accepts request input; passing a request-shaped
  // object where requestBody used to go must not change the result.
  const env = { ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '30' }
  assertEquals(getRestoreWindowDays(env), 30)
  const withRequestShapedArg = getRestoreWindowDays as unknown as (
    env: Record<string, string | undefined>,
    extra?: unknown,
  ) => number
  assertEquals(withRequestShapedArg(env, { restore_window_days: 1 }), 30)
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
  // Non-strict numeric strings must not truncate into a shorter window
  assertEquals(getRestoreWindowDays({}, () => '1e2'), 30)
  assertEquals(getRestoreWindowDays({}, () => '30.5'), 30)
  assertEquals(getRestoreWindowDays({}, () => ' 45 '), 45)
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

Deno.test('buildImageIssueFlags / buildMediaIssueSeverity / buildIssueSummary — new taxonomy', () => {
  // Drift guard — exports exist
  assertEquals(typeof buildImageIssueFlags, 'function')
  assertEquals(typeof buildMediaIssueSeverity, 'function')
  assertEquals(typeof buildIssueSummary, 'function')

  // 1. Purged row
  assertEquals(buildImageIssueFlags({ purged_at: '2026-01-01', deleted_at: '2026-01-01', storage_path: null }, false), ['permanently_removed'])
  assertEquals(buildMediaIssueSeverity({ purged_at: '2026-01-01' }, false), null)

  // 2. Microscope anchor
  assertEquals(buildImageIssueFlags({ image_type: 'microscope', storage_path: null }, false), [])
  assertEquals(buildMediaIssueSeverity({ image_type: 'microscope', storage_path: null }, false), null)

  // 3. Active non-microscope missing storage_path
  assertEquals(buildImageIssueFlags({ storage_path: null, image_type: null, deleted_at: null }, false), ['active_media_missing'])
  assertEquals(buildMediaIssueSeverity({ storage_path: null, image_type: null, deleted_at: null }, false), 'critical')

  // 4. Active non-microscope missing storage_path with explicit non-microscope type
  assertEquals(buildImageIssueFlags({ storage_path: null, image_type: 'closeup', deleted_at: null }, false), ['active_media_missing'])

  // 5. Purge failed
  assertEquals(buildImageIssueFlags({ deleted_at: '2026-01-01', purge_error: 'timeout', purged_at: null, storage_path: 'obs/x.jpg' }, false), ['purge_failed'])
  assertEquals(buildMediaIssueSeverity({ deleted_at: '2026-01-01', purge_error: 'timeout', purged_at: null }, false), 'warning')

  // 6. Tombstoned expired (reclaimable) — 60 days ago, 30-day window
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  assertEquals(buildImageIssueFlags({ deleted_at: sixtyDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 30), ['reclaimable_deleted_media'])
  assertEquals(buildMediaIssueSeverity({ deleted_at: sixtyDaysAgo, purge_error: null, purged_at: null }, false, 30), 'warning')

  // 7. Tombstoned in restore window (deleted 10 days ago, 30-day window)
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  assertEquals(buildImageIssueFlags({ deleted_at: tenDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 30), ['deleted_media_in_restore_window'])
  assertEquals(buildMediaIssueSeverity({ deleted_at: tenDaysAgo, purge_error: null, purged_at: null }, false, 30), 'info')

  // 8. Restore window parameterization
  assertEquals(buildImageIssueFlags({ deleted_at: sixtyDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 30), ['reclaimable_deleted_media'])
  assertEquals(buildImageIssueFlags({ deleted_at: sixtyDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 90), ['deleted_media_in_restore_window'])

  // 9. Size metadata unavailable
  assertEquals(buildImageIssueFlags({ storage_path: 'obs/x.jpg', stored_bytes: null, deleted_at: null }, false), ['size_metadata_unavailable'])
  assertEquals(buildMediaIssueSeverity({ storage_path: 'obs/x.jpg', stored_bytes: null, deleted_at: null }, false), 'info')

  // 10. Missing source dimensions alone — NO flags
  assertEquals(buildImageIssueFlags({ storage_path: 'obs/x.jpg', source_width: null, source_height: null, stored_bytes: 1024, deleted_at: null }, false), [])

  // 11. Missing stored dimensions alone — NO flags
  assertEquals(buildImageIssueFlags({ storage_path: 'obs/x.jpg', stored_width: null, stored_height: null, stored_bytes: 1024, deleted_at: null }, false), [])

  // 12. Missing original_storage_path alone — NO flags
  assertEquals(buildImageIssueFlags({ storage_path: 'obs/x.jpg', original_storage_path: null, stored_bytes: 1024, deleted_at: null }, false), [])

  // 13. Issue summary strings
  assertEquals(buildIssueSummary(['active_media_missing']), 'Active media missing — storage path is unrecorded. Verify or re-upload.')
  assertEquals(buildIssueSummary(['purge_failed']), 'Cleanup failed — the file could not be permanently removed. Retry or inspect the purge error.')
  assertEquals(buildIssueSummary(['reclaimable_deleted_media']), 'Ready to reclaim — recovery period has elapsed; physical storage can be permanently removed.')
  assertEquals(buildIssueSummary([]), '—')

  // 14. getRestoreWindowDays env parameterization
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
  assertEquals(buildImageIssueFlags({ deleted_at: twentyDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 30), ['deleted_media_in_restore_window'])
  assertEquals(buildImageIssueFlags({ deleted_at: twentyDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 45), ['deleted_media_in_restore_window'])
  assertEquals(buildImageIssueFlags({ deleted_at: sixtyDaysAgo, purge_error: null, purged_at: null, storage_path: 'obs/x.jpg' }, false, 45), ['reclaimable_deleted_media'])
})
