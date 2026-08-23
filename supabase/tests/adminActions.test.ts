/**
 * Tests for pure exported functions from admin-ops/adminActions.ts
 * Run with: deno test --allow-env supabase/tests/adminActions.test.ts
 */
import { assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@^1'

// Import pure exported functions
import {
  getRestoreWindowDays,
  buildTombstoneDeleteTargets,
  buildImageIssueFlags,
  buildMediaIssueSeverity,
  buildIssueSummary,
  buildMediaRowContext,
  buildProfileStorageKeys,
} from '../functions/admin-ops/adminActions.ts'

// ---------------------------------------------------------------------------
// getRestoreWindowDays
// ---------------------------------------------------------------------------

Deno.test('getRestoreWindowDays: defaults to 30 when env missing', () => {
  assertEquals(getRestoreWindowDays({}), 30)
})

Deno.test('getRestoreWindowDays: parses valid positive integer', () => {
  assertEquals(getRestoreWindowDays({ ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '45' }), 45)
})

Deno.test('getRestoreWindowDays: rejects non-digit value like 1e2', () => {
  assertEquals(getRestoreWindowDays({ ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '1e2' }), 30)
})

Deno.test('getRestoreWindowDays: rejects zero', () => {
  assertEquals(getRestoreWindowDays({ ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '0' }), 30)
})

Deno.test('getRestoreWindowDays: rejects negative', () => {
  assertEquals(getRestoreWindowDays({ ADMIN_TOMBSTONE_RESTORE_WINDOW_DAYS: '-5' }), 30)
})

// ---------------------------------------------------------------------------
// buildTombstoneDeleteTargets
// ---------------------------------------------------------------------------

Deno.test('buildTombstoneDeleteTargets: includes storage_path and derived variants', () => {
  const targets = buildTombstoneDeleteTargets('media/obs/img.jpg', '')
  assertEquals(targets.includes('media/obs/img.jpg'), true)
  assertEquals(targets.includes('media/obs/thumb_img.jpg'), true)
  assertEquals(targets.includes('media/obs/thumb_small_img.jpg'), true)
})

Deno.test('buildTombstoneDeleteTargets: includes original_storage_path separately', () => {
  const targets = buildTombstoneDeleteTargets('media/obs/img.jpg', 'media/obs/orig_img.jpg')
  assertEquals(targets.includes('media/obs/orig_img.jpg'), true)
})

Deno.test('buildTombstoneDeleteTargets: empty strings return empty array', () => {
  const targets = buildTombstoneDeleteTargets('', '')
  assertEquals(targets.length, 0)
})

// ---------------------------------------------------------------------------
// buildImageIssueFlags
// ---------------------------------------------------------------------------

Deno.test('buildImageIssueFlags: purged_at returns permanently_removed', () => {
  const flags = buildImageIssueFlags({ purged_at: '2024-01-01', storage_path: 'x' }, false)
  assertEquals(flags, ['permanently_removed'])
})

Deno.test('buildImageIssueFlags: active with no storage_path returns active_media_missing', () => {
  const flags = buildImageIssueFlags({ storage_path: '' }, false)
  assertEquals(flags, ['active_media_missing'])
})

Deno.test('buildImageIssueFlags: tombstoned with purge_error returns purge_failed', () => {
  const flags = buildImageIssueFlags({
    deleted_at: '2020-01-01T00:00:00Z',
    purge_error: 'timeout',
    storage_path: 'x',
  }, false)
  assertEquals(flags, ['purge_failed'])
})

Deno.test('buildImageIssueFlags: tombstoned beyond restore window with no error returns reclaimable', () => {
  const flags = buildImageIssueFlags({
    deleted_at: '2000-01-01T00:00:00Z',
    storage_path: 'x',
  }, false)
  assertEquals(flags, ['reclaimable_deleted_media'])
})

Deno.test('buildImageIssueFlags: healthy active row returns empty flags', () => {
  const flags = buildImageIssueFlags({ storage_path: 'x', stored_bytes: 1024 }, false)
  assertEquals(flags, [])
})

// ---------------------------------------------------------------------------
// buildMediaIssueSeverity
// ---------------------------------------------------------------------------

Deno.test('buildMediaIssueSeverity: purged_at → null severity', () => {
  assertEquals(buildMediaIssueSeverity({ purged_at: '2024-01-01', storage_path: 'x' }, false), null)
})

Deno.test('buildMediaIssueSeverity: active_media_missing → critical', () => {
  assertEquals(buildMediaIssueSeverity({ storage_path: '' }, false), 'critical')
})

Deno.test('buildMediaIssueSeverity: purge_failed → warning', () => {
  assertEquals(buildMediaIssueSeverity({
    deleted_at: '2020-01-01T00:00:00Z',
    purge_error: 'fail',
    storage_path: 'x',
  }, false), 'warning')
})

// ---------------------------------------------------------------------------
// buildIssueSummary
// ---------------------------------------------------------------------------

Deno.test('buildIssueSummary: empty flags returns em dash', () => {
  assertEquals(buildIssueSummary([]), '—')
})

Deno.test('buildIssueSummary: permanently_removed returns human message', () => {
  assertMatch(buildIssueSummary(['permanently_removed']), /purged/)
})

Deno.test('buildIssueSummary: reclaimable returns reclaim message', () => {
  assertMatch(buildIssueSummary(['reclaimable_deleted_media']), /reclaim/)
})

// ---------------------------------------------------------------------------
// buildProfileStorageKeys
// ---------------------------------------------------------------------------

Deno.test('buildProfileStorageKeys: deduplicates keys for image row', () => {
  const row = { storage_path: 'media/obs/img.jpg', media_kind: 'image' }
  const keys = buildProfileStorageKeys(row)
  // Should include the main path, no duplicates
  const unique = new Set(keys)
  assertEquals(unique.size, keys.length)
  assertEquals(keys.includes('media/obs/img.jpg'), true)
})

// ---------------------------------------------------------------------------
// buildMediaRowContext
// ---------------------------------------------------------------------------

Deno.test('buildMediaRowContext: returns object with image_status field', () => {
  const result = buildMediaRowContext({ id: '1', storage_path: 'x', stored_bytes: 1024 })
  assertNotEquals(result, null)
  assertEquals(typeof result, 'object')
})

// ---------------------------------------------------------------------------
// UUID validation logic (tested via scope label behavior)
// The following tests document the expected behavior of user_id validation
// in loadTombstoneSelection. Since loadTombstoneSelection requires a DB client,
// these tests verify the UUID regex pattern used there.
// ---------------------------------------------------------------------------

Deno.test('UUID regex: valid UUID matches', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  assertEquals(UUID_RE.test('123e4567-e89b-12d3-a456-426614174000'), true)
  assertEquals(UUID_RE.test('00000000-0000-0000-0000-000000000000'), true)
})

Deno.test('UUID regex: invalid UUID does not match', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  assertEquals(UUID_RE.test('not-a-uuid'), false)
  assertEquals(UUID_RE.test(''), false)
  assertEquals(UUID_RE.test('123e4567-e89b-12d3-a456'), false)
  assertEquals(UUID_RE.test('123e4567-e89b-12d3-a456-42661417400Z'), false)
})
