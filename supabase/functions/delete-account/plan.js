// Pure deletion plan for the delete-account edge function. Kept separate
// from index.ts so it can be unit-tested from Node without a Deno runtime
// or a running Supabase instance.
//
// Every DB stage is expressed as { name, apply(ctx) } so the test runner
// can inspect the plan structure and inject failures at each stage.
//
// STAGE ORDER (children before parents; R2 objects before DB rows; auth
// user last):
//
//   0. sweep_preflight           — ask the worker's sweep route before
//                                   anything is deleted; it must answer
//                                   409 profile_exists (or sweep, on a
//                                   retry). Stops a deletion that could
//                                   not finish its last media step.
//   1. media_snapshot            — record R2 media keys BEFORE any DB row
//                                   is deleted. Reads BOTH
//                                   observation_images.storage_path (which
//                                   has a paired thumb_ variant by contract)
//                                   AND observation_images.original_storage_path
//                                   (owner-only original, standalone — NO
//                                   thumb companion manufactured).
//   2. mosaic_media_snapshot     — record spore_measurement_mosaics.storage_key
//                                   R2 keys BEFORE their DB rows are deleted.
//                                   Mosaics have no separate thumb variant.
//   3. delete_r2_media           — delete each snapshotted R2 media object
//                                   (observation + mosaic keys), at most
//                                   R2_DELETE_CONCURRENCY at once. 404 = success.
//                                   The upload worker attempts both the
//                                   legacy public bucket AND the private
//                                   bucket for each key.
//   4. delete_legacy_storage     — legacy Supabase Storage folders
//                                   (observation-images/${uid}, avatars/${uid}).
//   5. scrub_mentions            — remove ONLY the deleted uid from
//                                   comments.mentioned_user_ids of OTHER
//                                   users' comments. Uses an SQL-safe RPC
//                                   so co-mentioned uuids in the same row
//                                   are preserved.
//   6. delete_client_activity    — client_activity_daily.
//   7. delete_follows            — follows.user_id + follows.target_id (only
//                                   when target_type='user' — target_id is
//                                   polymorphic text).
//   8. delete_reports            — reports.reporter_id + reported_user_id.
//   9. delete_identifications    — observation_identifications.user_id.
//  10. delete_spore_summaries    — observation_spore_summaries.user_id.
//  11. delete_mosaics            — spore_measurement_mosaics.user_id
//                                   (R2 objects already gone at step 3).
//  12. delete_user_blocks        — blocker_id + blocked_id.
//  13. delete_friendships        — requester_id + addressee_id.
//  14. delete_observation_shares — owner_id + shared_with_id.
//  15. delete_comments           — comments.user_id.
//  16. delete_spore_annotations  — spore_annotations.user_id.
//  17. delete_spore_measurements — spore_measurements.user_id.
//  18. delete_reference_library_for_account — atomically mark reference
//                                   mutations closed and delete the owner's
//                                   normalized reference graph through the
//                                   service-role-only RPC of the same name.
//  19. delete_observation_images — observation_images.user_id
//                                   (R2 objects already gone at step 3).
//  20. delete_observations       — observations.user_id.
//  21. delete_calibrations       — calibrations.user_id.
//  22. delete_profile            — profiles.id.
//  23. sweep_r2_prefix           — the worker deletes every object left
//                                   under `<uid>/` in every bucket. Runs
//                                   only once the profile is gone (the
//                                   worker checks), after which uploads
//                                   are refused.
//  24. delete_auth_user          — admin.auth.admin.deleteUser(uid). LAST so
//                                   a failure in any earlier stage leaves
//                                   the auth session intact for retry.
//
// IDEMPOTENCY: ordinary DB stages use `WHERE user_id = uid` (or matching
// column). The reference-library RPC is itself retry-safe: it preserves the
// deletion marker and a repeated child-first delete matches zero rows. R2
// worker DELETE with 404 must be treated as success. auth.admin deleteUser
// with "user_not_found" is treated as success.

/**
 * @typedef {{ data: any, error: { message: string, code?: string } | null }} StructuredResult
 * @typedef {{ ok: boolean, status?: number, detail?: string }} MediaWorkerResult
 * @typedef {{
 *   uid: string,
 *   admin: any,
 *   worker: {
 *     deleteKey: (key: string) => Promise<MediaWorkerResult>,
 *     sweepAccountMedia: () => Promise<MediaWorkerResult & { deleted?: number, done?: boolean }>,
 *   },
 *   r2Keys: Set<string>,
 * }} DeletionContext
 * @typedef {{ ok: true } | { ok: false, error: string }} StageResult
 * @typedef {{ name: string, apply: (ctx: DeletionContext) => Promise<StageResult> }} Stage
 */

// ── requireSuccess helper ────────────────────────────────────────────

/**
 * Awaits a Supabase-style `{ data, error }` promise and throws with the
 * stage label if `error` is present. This is the only way to touch the
 * database — no `.delete()` result may be silently ignored.
 * @param {string} label
 * @param {Promise<StructuredResult>} op
 * @returns {Promise<any>}
 */
export async function requireSuccess(label, op) {
  const result = await op
  if (result?.error) {
    throw new Error(`${label}: ${result.error.message || 'unknown error'}`)
  }
  return result?.data ?? null
}

// Rows per page for the media snapshots (PostgREST's default max_rows).
export const SNAPSHOT_PAGE_SIZE = 1000
// Fail closed instead of looping forever if a server ever ignores the
// keyset filter and keeps returning the same page.
export const SNAPSHOT_MAX_PAGES = 1000

function assertSnapshotPageLimit(label, pages) {
  if (pages >= SNAPSHOT_MAX_PAGES) {
    throw new Error(`${label}: snapshot exceeded the page limit`)
  }
}

// Worker DELETE calls in flight at once in delete_r2_media. An account with
// thousands of images has tens of thousands of R2 keys (each image has up to
// four variants); serial calls would run far past the Edge Function time
// limit. Bounded so the upload Worker and R2 are not flooded.
export const R2_DELETE_CONCURRENCY = 16

// Worker sweep calls in sweep_r2_prefix. Each call deletes up to 5,000
// objects, so this covers far more than any account holds; an account
// beyond it fails the stage and the user's retry continues the sweep.
export const SWEEP_MAX_CALLS = 40

/**
 * Calls `fn` for every item with at most `limit` calls in flight. Resolves
 * once every call has settled; `fn` must not throw.
 * @template T
 * @param {Iterable<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} fn
 */
export async function forEachWithConcurrency(items, limit, fn) {
  const list = [...items]
  let next = 0
  const runner = async () => {
    while (next < list.length) {
      const index = next++
      await fn(list[index], index)
    }
  }
  const runners = Math.max(1, Math.min(limit, list.length))
  await Promise.all(Array.from({ length: runners }, runner))
}

// Keyset pagination on the bigint primary key: each page starts after the
// last id seen, so a row the user deletes between page requests cannot
// shift later rows past the scan the way an offset range would.
function keysetPage(query, lastId) {
  return (lastId === null ? query : query.gt('id', lastId))
    .order('id', { ascending: true })
    .limit(SNAPSHOT_PAGE_SIZE)
}

function lastRowId(label, rows) {
  const id = rows[rows.length - 1]?.id
  if (id === null || id === undefined) {
    throw new Error(`${label}: snapshot row without an id`)
  }
  return id
}

// ── stages ────────────────────────────────────────────────────────────

/** @type {readonly Stage[]} */
export const STAGES = Object.freeze([
  {
    // Nothing is deleted unless the worker can finish the job: a worker
    // without the sweep route (404), without its profile lookup (503), or
    // unreachable would otherwise fail sweep_r2_prefix only after the
    // profile is gone, leaving an account that can neither upload nor
    // finish setup. A live account gets 409 profile_exists; a retry after
    // delete_profile gets a real (harmless) sweep.
    name: 'sweep_preflight',
    apply: async ctx => {
      let outcome
      try {
        outcome = await ctx.worker.sweepAccountMedia()
      } catch (err) {
        outcome = { ok: false, detail: err?.message }
      }
      if (outcome?.ok) return { ok: true }
      if (outcome?.status === 409 && outcome?.detail === 'profile_exists') return { ok: true }
      return {
        ok: false,
        error: `media sweep not ready: ${outcome?.detail || outcome?.status || 'unknown'}`,
      }
    },
  },
  {
    name: 'media_snapshot',
    apply: async ctx => {
      try {
        // Read BOTH storage_path (paired with thumb_ by contract) and
        // original_storage_path (owner-only original — standalone).
        // Paged: PostgREST caps an unpaged select at its max_rows, which
        // would silently leave every image past the cap in R2.
        let lastId = null
        for (let pages = 0; ; pages++) {
          assertSnapshotPageLimit('media snapshot', pages)
          const rows = await requireSuccess(
            'select observation_images.storage_path,original_storage_path',
            keysetPage(ctx.admin.from('observation_images')
              .select('id, storage_path, original_storage_path')
              .eq('user_id', ctx.uid), lastId),
          ) || []
          for (const row of rows) {
            // storage_path is the public/derivable variant; add its thumb pair.
            for (const key of observationMediaDeleteTargets(row.storage_path)) {
              if (key) ctx.r2Keys.add(key)
            }
            // original_storage_path is a STANDALONE object — do NOT
            // manufacture a thumb_ companion. Add the exact key as-is.
            const original = normalizeStoragePath(row.original_storage_path)
            if (original) ctx.r2Keys.add(original)
          }
          // Stop on an empty page rather than a short one, so a server
          // max_rows below SNAPSHOT_PAGE_SIZE cannot end the scan early.
          if (!rows.length) break
          lastId = lastRowId('media snapshot', rows)
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    name: 'mosaic_media_snapshot',
    apply: async ctx => {
      try {
        // spore_measurement_mosaics.storage_key is a standalone R2 object
        // with no paired thumb — snapshot each key BEFORE the row is
        // deleted so we can remove the R2 object at delete_r2_media.
        let lastId = null
        for (let pages = 0; ; pages++) {
          assertSnapshotPageLimit('mosaic media snapshot', pages)
          const rows = await requireSuccess(
            'select spore_measurement_mosaics.storage_key',
            keysetPage(ctx.admin.from('spore_measurement_mosaics')
              .select('id, storage_key')
              .eq('user_id', ctx.uid), lastId),
          ) || []
          for (const row of rows) {
            const key = normalizeStoragePath(row.storage_key)
            if (key) ctx.r2Keys.add(key)
          }
          if (!rows.length) break
          lastId = lastRowId('mosaic media snapshot', rows)
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    name: 'delete_r2_media',
    apply: async ctx => {
      // Every key is attempted, even after a failure; failures are reported
      // in snapshot order once all deletes have settled.
      /** @type {(string | undefined)[]} */
      const failures = []
      await forEachWithConcurrency(ctx.r2Keys, R2_DELETE_CONCURRENCY, async (key, index) => {
        let outcome
        try {
          outcome = await ctx.worker.deleteKey(key)
        } catch (err) {
          outcome = { ok: false, detail: err?.message }
        }
        // 404 is idempotent success.
        if (outcome.ok || outcome.status === 404) return
        failures[index] = `r2 delete failed for ${maskKey(key)}: ${outcome.detail || outcome.status || 'unknown'}`
      })
      const errors = failures.filter(Boolean)
      if (errors.length) return { ok: false, error: errors.join('; ') }
      return { ok: true }
    },
  },
  {
    name: 'delete_legacy_storage',
    apply: async ctx => {
      try {
        await deleteFolderContents(ctx.admin, 'observation-images', ctx.uid)
        await deleteFolderContents(ctx.admin, 'avatars', ctx.uid)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    name: 'scrub_mentions',
    apply: async ctx => {
      // Remove ONLY the deleted uid from mentioned_user_ids arrays owned
      // by other users. Uses the `scrub_user_mentions(p_user_id uuid)` RPC
      // (see migration) which runs
      //     UPDATE public.comments
      //        SET mentioned_user_ids = array_remove(mentioned_user_ids, p_user_id)
      //      WHERE p_user_id = ANY(mentioned_user_ids);
      // so co-mentioned uuids in the same comment are preserved.
      //
      // Best-effort: a stale uuid in another user's mentions array does
      // not block account deletion. We still surface the outcome via log.
      try {
        await requireSuccess(
          'rpc scrub_user_mentions',
          ctx.admin.rpc('scrub_user_mentions', { p_user_id: ctx.uid }),
        )
      } catch (err) {
        console.warn('[delete-account] scrub_mentions non-fatal:', err.message)
      }
      return { ok: true }
    },
  },
  _simpleDelete('delete_client_activity', 'client_activity_daily', 'user_id'),
  {
    name: 'delete_follows',
    apply: async ctx => {
      try {
        await requireSuccess(
          'delete follows.user_id',
          ctx.admin.from('follows').delete().eq('user_id', ctx.uid),
        )
        // target_id is text (polymorphic: user id / observation id / species
        // key / genus key). Restrict target_id deletion to rows whose
        // target_type='user' so we do NOT accidentally delete unrelated
        // follows on an observation/species/genus whose primary key happens
        // to equal this uuid as text.
        await requireSuccess(
          'delete follows.target_id (target_type=user)',
          ctx.admin.from('follows').delete().eq('target_type', 'user').eq('target_id', ctx.uid),
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    name: 'delete_reports',
    apply: async ctx => {
      try {
        await requireSuccess('delete reports.reporter_id', ctx.admin.from('reports').delete().eq('reporter_id', ctx.uid))
        await requireSuccess('delete reports.reported_user_id', ctx.admin.from('reports').delete().eq('reported_user_id', ctx.uid))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  _simpleDelete('delete_identifications', 'observation_identifications', 'user_id'),
  _simpleDelete('delete_spore_summaries', 'observation_spore_summaries', 'user_id'),
  _simpleDelete('delete_mosaics', 'spore_measurement_mosaics', 'user_id'),
  {
    name: 'delete_user_blocks',
    apply: async ctx => {
      try {
        await requireSuccess('delete user_blocks.blocker_id', ctx.admin.from('user_blocks').delete().eq('blocker_id', ctx.uid))
        await requireSuccess('delete user_blocks.blocked_id', ctx.admin.from('user_blocks').delete().eq('blocked_id', ctx.uid))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    name: 'delete_friendships',
    apply: async ctx => {
      try {
        await requireSuccess(
          'delete friendships',
          ctx.admin.from('friendships').delete().or(`requester_id.eq.${ctx.uid},addressee_id.eq.${ctx.uid}`),
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    name: 'delete_observation_shares',
    apply: async ctx => {
      try {
        await requireSuccess(
          'delete observation_shares',
          ctx.admin.from('observation_shares').delete().or(`owner_id.eq.${ctx.uid},shared_with_id.eq.${ctx.uid}`),
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  _simpleDelete('delete_comments', 'comments', 'user_id'),
  _simpleDelete('delete_spore_annotations', 'spore_annotations', 'user_id'),
  _simpleDelete('delete_spore_measurements', 'spore_measurements', 'user_id'),
  {
    name: 'delete_reference_library_for_account',
    apply: async ctx => {
      try {
        // This service-role-only RPC takes the same per-owner advisory lock
        // as the mutation RPCs, persists an account-deletion marker, and
        // removes the complete normalized graph in one transaction. The
        // marker prevents a still-authenticated client from recreating rows
        // between this stage and delete_auth_user.
        await requireSuccess(
          'rpc delete_reference_library_for_account',
          ctx.admin.rpc('delete_reference_library_for_account', { p_user_id: ctx.uid }),
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  _simpleDelete('delete_observation_images', 'observation_images', 'user_id'),
  _simpleDelete('delete_observations', 'observations', 'user_id'),
  _simpleDelete('delete_calibrations', 'calibrations', 'user_id'),
  {
    name: 'delete_profile',
    apply: async ctx => {
      try {
        await requireSuccess(
          'delete profile',
          ctx.admin.from('profiles').delete().eq('id', ctx.uid),
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  },
  {
    // Deletes every R2 object left under the user's own key prefix: legacy
    // uploads that never had an image row, uploads that landed after
    // media_snapshot, abandoned temp keys. The worker runs this only once
    // the profile row is gone, and refuses uploads without one, so nothing
    // can land behind it. Each call is bounded; repeat until `done`.
    name: 'sweep_r2_prefix',
    apply: async ctx => {
      let deleted = 0
      for (let calls = 0; calls < SWEEP_MAX_CALLS; calls++) {
        let outcome
        try {
          outcome = await ctx.worker.sweepAccountMedia()
        } catch (err) {
          outcome = { ok: false, detail: err?.message }
        }
        if (!outcome?.ok) {
          return {
            ok: false,
            error: `r2 prefix sweep failed: ${outcome?.detail || outcome?.status || 'unknown'}`,
          }
        }
        deleted += Number(outcome.deleted || 0)
        if (outcome.done) {
          if (deleted) console.info('[delete-account] prefix sweep removed unlisted objects', { count: deleted })
          return { ok: true }
        }
      }
      return { ok: false, error: 'r2 prefix sweep did not finish; retry the deletion' }
    },
  },
  {
    name: 'delete_auth_user',
    apply: async ctx => {
      const result = await ctx.admin.auth.admin.deleteUser(ctx.uid)
      if (result?.error) {
        const msg = String(result.error.message || '').toLowerCase()
        if (msg.includes('not found') || msg.includes('user_not_found')) return { ok: true }
        return { ok: false, error: `delete auth user: ${result.error.message}` }
      }
      return { ok: true }
    },
  },
])

// Convenience factory for the common "delete FROM {table} WHERE {column} = uid" shape.
function _simpleDelete(name, table, column) {
  return {
    name,
    apply: async ctx => {
      try {
        await requireSuccess(
          `delete ${table}.${column}`,
          ctx.admin.from(table).delete().eq(column, ctx.uid),
        )
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    },
  }
}

// ── driver ────────────────────────────────────────────────────────────

/**
 * Runs the plan and returns the outcome. The runner never throws — every
 * stage captures its own errors so callers can return a structured,
 * non-sensitive response to the client.
 * @param {DeletionContext} ctx
 * @returns {Promise<{ok: boolean, stage?: string, error?: string, completed: string[]}>}
 */
export async function runDeletionPlan(ctx) {
  const completed = []
  for (const stage of STAGES) {
    const outcome = await stage.apply(ctx)
    if (!outcome.ok) {
      return { ok: false, stage: stage.name, error: outcome.error, completed }
    }
    completed.push(stage.name)
  }
  return { ok: true, completed }
}

// ── helpers ───────────────────────────────────────────────────────────

export function observationMediaDeleteTargets(storagePath) {
  const normalizedPath = normalizeStoragePath(storagePath)
  if (!normalizedPath) return []
  const segments = normalizedPath.split('/').filter(Boolean)
  const fileName = segments.pop() || ''
  if (!fileName) return [normalizedPath]
  const dir = segments.join('/')
  const originalName = fileName.startsWith('thumb_') ? fileName.slice('thumb_'.length) : fileName
  const baseName = originalName.replace(/^(?:small_|medium_)+/i, '')
  return [...new Set([
    joinStoragePath(dir, baseName),
    joinStoragePath(dir, `thumb_${baseName}`),
    joinStoragePath(dir, `thumb_small_${baseName}`),
    joinStoragePath(dir, `thumb_medium_${baseName}`),
  ])]
}

export function joinStoragePath(dir, fileName) {
  return dir ? `${dir}/${fileName}` : fileName
}

export function normalizeStoragePath(storagePath) {
  return String(storagePath ?? '').trim().replace(/^\/+/, '')
}

export function encodeObjectKey(storagePath) {
  return normalizeStoragePath(storagePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

// Removes the leading uid segment before returning a key inside a
// client-facing error surface. Prevents leaking the account identifier
// to end users; the server log still has the full stage label.
function maskKey(key) {
  const parts = normalizeStoragePath(key).split('/')
  if (parts.length <= 1) return '***'
  return `***/${parts.slice(1).join('/').replace(/[^/.a-zA-Z0-9_-]/g, '*')}`
}

async function deleteFolderContents(admin, bucket, uid) {
  const folders = [{ path: uid, prefix: uid }]
  while (folders.length) {
    const current = folders.pop()
    let offset = 0
    while (true) {
      const listResult = await admin.storage.from(bucket).list(current.path, { limit: 1000, offset })
      if (listResult?.error) {
        throw new Error(`list ${bucket}: ${listResult.error.message}`)
      }
      const data = listResult?.data || []
      if (!data.length) break
      const files = []
      for (const item of data) {
        if (!item.name) continue
        const itemPath = `${current.prefix}/${item.name}`
        if (item.id) files.push(itemPath)
        else folders.push({ path: itemPath, prefix: itemPath })
      }
      if (files.length) {
        const removeResult = await admin.storage.from(bucket).remove(files)
        if (removeResult?.error) {
          throw new Error(`remove ${bucket}: ${removeResult.error.message}`)
        }
      }
      if (data.length < 1000) break
      // Removed files drop out of the next listing, so only the entries
      // still present (sub-folders, nameless items) move the offset.
      // Advancing by data.length would skip a page of files.
      offset += data.length - files.length
    }
  }
}
