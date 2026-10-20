# Plan: "Delete cloud copy" keeps a metadata-only spore anchor (option b), revision 7

Repos:
- sporely-web: Stage 0a (database), 0b (Worker), 0c (header enforcement, later), and the admin-ops purge.
- sporely-py: Stages 1-3.

Planning only. Nothing implemented, committed or run against production.

## Changes since the Codex review (revision 2)
- Ordering corrected:
  - A global tombstone flush runs before the per-observation loop (sporely-py utils/cloud_sync.py:9925).
  - The anchors then run (image_push.py:828) and cancel tombstones by cloud id (anchors.py:480/540).
  - A second flush follows (image_push.py:851).
- The tombstone flush resolves and validates only. Conversion runs inside the anchor lifecycle as one resumable state machine.
- Cloud measurements count when deciding whether an image needs an anchor.
- Persistent retry marker, preflight re-dirty and fast-path veto.
- Server Stage 0 added. Re-promotion keys get a nonce.
- Device B adopts byte removal before storing a baseline.
- Measurement and cover keys are cleaned.
- Repair is a crash-safe CLI.
- UI rewording without a badge.
- Stage 1 stays uncommitted until the live canary.

## Changes since the second Codex review (revision 3)
1. Remote-only measurements:
   - S1.1 persists the release marker as soon as it establishes a cloud-only anchor need.
   - Pending releases are dispatched at the top of `_ensure_metadata_anchors_for_public_spore_observation`, before the private-observation gate (anchors.py:821) and the per-image predicate gates (anchors.py:350-373).
2. Lost RPC response plus recheck:
   - The marker records `rpc_attempted=true` before the RPC is sent.
   - After that, a recheck changes only byte intent. `set_image_cloud_selected` (image_policy.py:538) no longer cancels unconditionally.
   - The release is resolved by a remote re-read and finished before any promotion.
3. Keys referenced elsewhere or attached concurrently:
   - The release RPC refuses while any other canonical or derived reference exists.
   - Release and every attachment path take per-key advisory locks through one shared helper, in a deterministic order.
4. Variants and trusted writers:
   - The registry holds the complete key family: canonical, every derived variant, and the original.
   - The retirement check is a separate trigger that runs for every role. It does not sit behind the trusted-writer early return at sporely-web 20260804120000_media_authorization.sql:460-467.
5. Worker (reduced form, user-accepted):
   - Rejects released keys in every upload mode, including the legacy no-image-id mode (index.js:534-548).
   - Checks again before the final commit (index.js:704-707).
   - No lease. A late write that passed authorization before the release leaves an unreferenceable orphan.
   - A new admin released-key sweep (S0a.6) removes such orphans. The existing tombstone purge only covers deleted rows.
6. One persisted promotion nonce per re-upload. It is used for both the reduced-image key and the original key (`_build_original_storage_path`, cloud_sync.py:7892-7900), and reused across interrupted retries.
7. Byte-removal adoption also runs in the post-push snapshot callback (`_adopt_remote_image_edits_before_baseline`, image_push.py:574-606, reached from `_store_post_push_snapshot`, cloud_sync.py:4683). It also runs before any push-side promotion (image_push.py ~1268).
8. Client key cache:
   - On adoption or release, the `_cloud_image_storage_key_cache` entry (cloud_sync.py:6754-6763) is seeded with ''.
   - The server rejects released keys on measurement image_key/thumb_key and on observation covers. That also covers web writes (src/images.js:1678/1703, screens/find_detail.js:2432).
9. The obsolete brake is keyed on the header, not the version (20261015090000:27-40). Replaced by sync identity 3 with a three-step rollout (S0c).
- Architecture: option A chosen. One PostgreSQL transaction clears the row, sets the purpose, registers the key family, and clears this image's measurement keys and the observation's cover keys when they point into the family. The client lifecycle becomes: marker → RPC (resolved by re-read) → R2 delete → local state.
- Decisions recorded:
  - Stage 0 is mandatory and must be verified before any conversion.
  - Conversion runs on "Sync now" only. The Refresh hook is removed. Refresh may only adopt device-B exclusions and local state.
- New sections: attachment-path inventory, lock helper, two-session concurrency tests, admin purge changes, deployment and rollback order, separate acceptance evidence for 0a and 0b.

## Changes since the third Codex review (revision 4; design changes 1 and 2 approved by the user)
- Lock order (Codex 1):
  - All "deadlock-free" claims removed.
  - One canonical acquisition order (§L), used by every new path.
  - Known pre-existing inversions documented.
  - Bounded retry on 40P01 / 40001 / 55P03 in every RPC caller (desktop and admin).
  - `lock_timeout` set inside the RPCs.
- Irreversible purge claim (Codex 6):
  - Admin purge first atomically claims the tombstoned row AND retires its key family (one transaction, §L order). Only then may R2 deletion run (adminActions.ts ~1159).
  - Restore (20260717120000) and any attachment are refused afterwards by the same guard.
  - The sweep uses the same claim-then-delete pattern.
- Variant names: one exact, idempotent root and family rule (§K). A cross-language fixture test runs JS, Python and SQL over the same list. `originals/` keys are untouched.
- Foreign-owned measurements:
  - Only rows cleared in the same transaction are exempt: this image's measurements with `user_id` = image owner.
  - Any other reference raises `media_key_shared`, and the bytes stay.
  - The older RLS gap (20260925120000:110-116) is noted as out of scope.
- Registry privileges: the table lives in `private`. Explicit `REVOKE ALL` (including DELETE and TRUNCATE) from anon, authenticated and service_role overrides the baseline default grants (20260521120000:2511-2514). SELECT goes to service_role only. Sweep status changes only through a SECURITY DEFINER function. Tested.
- API boundary:
  - Helpers live in `private`.
  - Every REST-called function gets a `public` wrapper, with EXECUTE revoked from PUBLIC.
  - Only the release wrapper is granted to authenticated, with owner checks. All other wrappers are service_role only.
  - 0a and 0b acceptance includes real `/rest/v1/rpc` calls.
- Worker rollback target: a build that accepts identity 2 and 3 and keeps released-key rejection. Never roll back to the identity-2-only build (obsolete-desktop-guard.js:27) after Stage 1 has shipped. The sweep is repeatable, not one-shot.
- Worker second check: runs after quota accounting (index.js:676). Refusal reuses the byte-and-quota compensation (index.js:689-692), with a test that quota is restored.
- Concurrency tests: two-session psql with controlled pause points (a GUC-gated advisory barrier), the full case list, and expression indexes on `media_key_root(col)`.

## Changes since the fourth Codex review (revision 5; only the eight listed items)
1. §K root is now a true fixed point:
   - It strips any one supported prefix (`thumb_|small_|medium_|cards_|preview_`) repeatedly until the name is stable.
   - The family is expanded from both the root and the preserved stored filename.
   - New fixtures: `small_thumb_f`, `thumb_small_thumb_f`, Worker `thumb_thumb_f`, desktop `thumb_<variant>_<file>`.
   - JS, Python and SQL must agree.
2. Exact delete keys are persisted:
   - Each release and each claim stores its immutable `delete_keys text[]` in a retirement record, alongside the indexed roots.
   - Replay and sweep delete only from those stored keys, never from a recomputed family.
3. Function ACLs:
   - Default privileges grant EXECUTE on public functions to anon, authenticated and service_role (baseline 20260521120000:2501-2504).
   - Every new function and wrapper gets `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated, service_role`, then a GRANT to exactly the intended role.
   - A test asserts each new function's ACL equals the intended set.
4. Guard trigger spec made explicit:
   - SECURITY DEFINER, `SET search_path = ''`, schema-qualified names.
   - A fresh registry read after the key locks.
   - A global check, not scoped to the caller's rows.
   - Style follows `_media_guard_key_ownership_image` (media_authorization.sql:456).
5. The purge claim blocks restore on its own:
   - `purge_claimed_at` is a server-owned, immutable column.
   - The guard refuses clearing it, and refuses `deleted_at = NULL` while it is set, even when the paths are NULL (the restore policy permits NULL-path microscope rows, 20260717120000:30-33).
   - `finalize_observation_image_purge` (20260809130000:45ff) requires the claim to be set and the row to still be tombstoned.
6. Rollout:
   - The existing purge deletes preselected targets directly (adminActions.ts:1160). That race exists in production today, independent of this plan.
   - The purge action is disabled before 0a and re-enabled only after claim-aware admin-ops is deployed and verified.
   - The rollback entry is "disable purge".
7. Sweep vs. claimed tombstones: the reference refusal excludes only the matching, permanently claimed tombstone row of that retirement. Any other reference still refuses. A test covers recovery of an interrupted purge.
8. Concurrency barriers:
   - Barriers live in the test harness: explicit held row or advisory locks in a test session.
   - Test-only triggers live in a test-only schema installed only in local test databases.
   - No pause hooks in production functions. This settles Q-r4-2.

## Changes since the fifth Codex review (revision 6; only the five listed items)
1. **The claim GUC is a hint, not authorization.**
   - Any SQL caller can run `SET LOCAL` / `set_config`, including direct service-role SQL.
   - The guard allows the `purge_claimed_at` transition only with an exact link to a private 'purge' retirement record for that image (revision 7 replaced the `xmin` proof with `purge_retirement_id`, see below). The finalizer verifies that record too.
   - Tests cover forged flags, including through a test-only RPC that sets the GUC.
2. **Variant set extended:** V(n) now also includes `thumb_cards_<n>` and `thumb_preview_<n>`, for both the root and the stored filename. The desktop only produces thumb/small/medium (sporely-py cloud_sync.py:9050), so this is a cheap safeguard; deleting a missing key is harmless.
3. **Release and claim identities:**
   - The desktop generates a release UUID, persists it in the SQLite marker before the RPC, and passes it. The registry stores it under a UNIQUE constraint.
   - Replay resolves by UUID first and returns the stored `delete_keys`. It never retargets newly observed keys.
   - An unknown UUID on changed paths (for example another device's promotion, cloud_sync.py:8147/8191) gives `row_changed`. The desktop abandons that attempt, clears the marker and re-evaluates from scratch with a NEW UUID.
   - Purge claims work the same way with a claim UUID.
4. **Disabling the purge drains running executions:**
   - Step 0 is enforced in the backend: the disable check runs inside `purgeSingleTombstoneRow`, before any R2 call. The batch loop (adminActions.ts:193-195, then `deleteObjects` at :1160) otherwise never rechecks a flag.
   - Before 0a there must be evidence that no old invocation is still running: the admin action log shows no unfinished purge run, and the edge-function maximum runtime has elapsed since the flag was set.
   - A UI toggle alone is not enough.
5. **Cross-row attachment race tests and an isolation requirement:**
   - Every guarded table is tested: release or claim vs. an INSERT/UPDATE on a DIFFERENT row attaching the same key, in both orders. The tests assert the actual lock wait (the wait-observation pattern in shared_reference_consent_concurrency_test.sh ~L155) and the final reference and registry state. They include a foreign-owned measurement attaching through the documented ownership gap.
   - The new functions and the guard require READ COMMITTED, and reject any other level with an explicit error, because the post-lock fresh read relies on it.

## Changes since the sixth Codex review (revision 7; Codex verdict on revision 6: ACCEPT WITH CHANGES)
1. **Claim proof replaced.** The `xmin = txid_current()` same-transaction check is removed. It was unsound: `xmin` is 32-bit while `txid_current()` carries the epoch, and inserts inside savepoints or PL/pgSQL EXCEPTION blocks get a subtransaction xid. Instead, a server-owned, immutable `observation_images.purge_retirement_id` links the row to its 'purge' retirement (matching image, owner and reason). The claim function inserts the retirement and sets `purge_claimed_at` and `purge_retirement_id` in one SECURITY DEFINER body. The finalizer requires that link. New tests: a claim whose retirement insert runs inside an EXCEPTION block or savepoint still succeeds; a forged `purge_retirement_id` (wrong image, wrong owner, a 'release' record) is refused.
2. **Trigger firing coverage.** The guard is an unconditional `BEFORE INSERT OR UPDATE FOR EACH ROW` trigger, never `UPDATE OF <columns>`, and its `observation_images` coverage lists `purge_claimed_at` and `purge_retirement_id`. New tests: a claim-only PATCH that sets or clears `purge_claimed_at` (or `purge_retirement_id`) is refused for authenticated and service_role callers, and a following restore of a NULL-path microscope row is refused.

## Invariants
- Fresh worktree off sporely-py `main` (19af384), for example `git -C sporely-py worktree add ../sporely-worktrees/cloud-copy-spore-anchor -b fix/cloud-copy-delete-keeps-spore-anchor main`. The uncommitted taxon edits stay untouched. Use the absolute `.venv` python/pytest.
- Read first: `.claude/rules/cloud-sync.md`; contract L111-115, L720-770, L850-1000; architecture L150-160 and L305-311. In sporely-web, its AGENTS.md/CLAUDE.md.
- Never resurrect a soft-deleted row.
- Never upload bytes for an excluded image.
- No no-op writes.
- Pull-only mode makes zero cloud writes.
- `metadata_purpose` is intent, never authorization.
- `queue_image_tombstones_for_local_images` keeps `local_image_id` NULL.
- A retired key root is never reusable, and its registry row is never deleted.

## Architecture choice: A (one release transaction), unchanged from revision 3

| Criterion | A: one RPC transaction (chosen) | B: client steps |
|---|---|---|
| Intermediate cloud states | none visible | metadata-only row with dangling measurement/cover keys |
| Retry/marker | one idempotent step, resolvable by re-read | four steps, each with its own recovery |
| Ownership | explicit checks inside SECURITY DEFINER (`search_path=''`) | RLS per PATCH, scoped by the client |
| Optional columns | none (baseline :1097-1098, :1408-1409) | per-column probes |
| Locks | §L order, one observation, `lock_timeout` | no cross-step serialisation |
| Failure | all or nothing; 40P01/55P03 → caller retry (idempotent) | partial success at every boundary |

Client lifecycle: marker with `rpc_attempted` → RPC (or re-read) → R2 delete → local state.

## §L Canonical lock order (single definition; every new code path follows it)
1. **Observation row**: `SELECT … FROM observations WHERE id = $obs FOR NO KEY UPDATE` (the new paths change no key columns; NO KEY UPDATE conflicts with every UPDATE and with other NO KEY UPDATE locks, but not with FK KEY SHARE checks).
2. **Per-user cascade lock**: `pg_advisory_xact_lock(hashtextextended(user_id::text, 42))`. This is the lock the existing visibility cascade `_media_bump_child_images_on_obs` takes (media_authorization.sql:558-562).
   - The cascade runs as an AFTER trigger on observations, so its order is observation row → user lock 42 → image rows.
   - New paths take lock 42 AFTER the observation row, which matches the cascade.
   - Taking it before the observation row would create a cycle with the cascade, so that is forbidden.
3. **Image rows**, sorted by id: `SELECT … FROM observation_images WHERE id = ANY($ids) ORDER BY id FOR NO KEY UPDATE`.
4. **Measurement rows of those images**, sorted by id, `FOR NO KEY UPDATE` (release and claim: both clear the owner's measurement keys).
5. **Media-key advisory locks**: `private.lock_media_key_roots(roots)`. DISTINCT roots, ordered by `(hashtextextended(root, 7311), root)`, each with `pg_advisory_xact_lock(hashtextextended(root, 7311))`. Equal hashes simply re-acquire the same lock.

Guard trigger on single-row writes (`private.media_key_retirement_guard`, BEFORE INSERT/UPDATE):
- For an UPDATE, PostgreSQL has already locked the target tuple before BEFORE ROW triggers run (`ExecBRUpdateTriggers` / `GetTupleForTrigger`).
- For an INSERT, the new tuple is not yet visible to anyone.
- The trigger then takes only key locks, sorted (step 5). A single-row writer's sequence is therefore {its own row} → keys. That is a suffix-consistent subset of §L: an image write is step 3 → 5, a measurement write 4 → 5, a cover write 1 → 5.
- Remaining cycle: a writer that already holds a key lock and then, through a pre-existing trigger, locks a row earlier in §L.

Known pre-existing inversions (not changed by this plan):
- The child-touch trigger (20260719120000_touch_observation_updated_at_from_children.sql:20-29) updates the parent observation AFTER an image or measurement write. A plain image PATCH therefore goes image → (keys) → observation, while the release RPC goes observation → image → keys. That can deadlock: 40P01.
- The visibility cascade goes observation → user lock 42 → images. The release follows the same prefix.
- These inversions remain, so:
  - **Retry.** Every RPC caller retries on SQLSTATE 40P01 (deadlock_detected), 40001 (serialization_failure) and 55P03 (lock_not_available): at most 3 attempts, 100-400 ms random jitter. Callers are the desktop lifecycle and the admin claim and sweep.
  - Release and claim are idempotent (the replay branch), so a retry after an abort is always safe.
  - Ordinary desktop and web PATCHes get no new retry. They already treat a failed write as retryable on the next sync.
- **`lock_timeout`**: the release, claim and sweep functions declare `SET lock_timeout = '5s'` (and `statement_timeout = '15s'`), so a stuck lock fails fast with 55P03 and the caller retries.

## §K Key root and family rule (one definition)
- Normalise: trim whitespace, strip leading and trailing `/`.
- **Originals**: if any path segment equals `originals` (desktop `…/originals/<id>/<name>`, cloud_sync.py:7892-7900), root = family = {the key}. The filename is untouched.
- **Others**:
  - Split into `dir/file`.
  - `base` = the fixed point of "strip ONE leading prefix from `{thumb_, small_, medium_, cards_, preview_}`". Repeat until the name no longer starts with any of them. Examples:
    - `small_thumb_f` → `thumb_f` → `f`
    - `thumb_small_thumb_f` → `f`
    - `thumb_thumb_f` → `f`
  - Applying the rule to `base` again changes nothing, so root(root(k)) = root(k) by construction.
  - `root = dir || '/' || base`.
  - Variant set V(n) for a filename n = {`thumb_<n>`, `thumb_small_<n>`, `thumb_medium_<n>`, `thumb_cards_<n>`, `thumb_preview_<n>`, `small_<n>`, `medium_<n>`, `cards_<n>`, `preview_<n>`}. The desktop only produces thumb/small/medium (cloud_sync.py:9050); the cards/preview forms are a cheap safeguard, since deleting a missing key is harmless.
  - Family = {the stored key} ∪ {root} ∪ V(base) ∪ V(stored filename) ∪ {Worker `deriveThumbKey(stored key)`}, each under `dir`. Expanding from BOTH the root and the preserved stored filename covers variants that clients derived from a prefixed canonical name.
  - This covers the desktop's `media_variant_key` (r2_storage.py:263: `thumb_<f>`, `thumb_<v>_<f>`) and the Worker's `deriveThumbKey` (index.js:1911: strip one `thumb_|small_|medium_|cards_|preview_`, then add `thumb_`).
  - A canonical filename that itself begins with one of those prefixes shares a root with its stripped form. That is conservative: over-locking, or a `media_key_shared` refusal, never an unprotected key.
- `private.media_key_root(text)` and `private.media_key_family(text)` are IMMUTABLE, so they can back expression indexes.
- **Cross-language fixture test** (0a, run in CI). One JSON fixture list covering:
  - canonical keys and each variant form;
  - originals;
  - names starting with `small_`;
  - interleaved prefixes (`small_thumb_f`, `thumb_small_thumb_f`);
  - the Worker-derived `thumb_thumb_f`;
  - desktop `thumb_<variant>_<file>` for every variant.

  Requirements:
  - root and family must be identical across the JS, Python and SQL implementations;
  - root is a fixed point in all three.
  - Python `media_variant_key` and JS `deriveThumbKey`: every variant they produce satisfies `root(variant) = root(key)` and is in `family(key)` under SQL.
  - SQL root is idempotent.
  - The JS, Python and SQL results must be identical. The test reads the fixture from one file.

## Attachment-path inventory (every writer passes the guard)
Unchanged from revision 3:
- desktop: `set_image_storage_path`/reserve/release cloud_sync.py:8100-8191, `push_image_metadata`, `push_measurement` :8939-9013, cover :6709/:6727, mosaic and calibration
- web: sync-queue.js:1575, find_detail.js:5402 and :2432, images.js:1678/1703
- Worker (service role): canonical_bucket PATCH index.js:1916-1944
- admin-ops: purge metadata (adminActions.ts:1244)
- no SQL function assigns key columns.

Added: **the restore transition** (`deleted_at` non-NULL → NULL; owner policy 20260717120000) is an attachment of the row's existing keys. The guard checks `deleted_at` changes too, and refuses a restore when any of the row's key roots is retired or `purge_claimed_at` is set.

Choke point: an unconditional `BEFORE INSERT OR UPDATE ... FOR EACH ROW` trigger (never `UPDATE OF <columns>`, so a write touching only an unlisted column cannot bypass it) on `observation_images` (storage_path, original_storage_path, deleted_at, purge_claimed_at, purge_retirement_id), `spore_measurements` (image_key, thumb_key), `observations` (image_key, thumb_key), `spore_measurement_mosaics` (storage_key) and `calibrations` (image_storage_path). There is no role exemption. Never run `session_replication_role=replica` on these tables.

## Stage 0a (sporely-web database). Server change; deploying it needs explicit user approval
1. `private.media_key_root`, `private.media_key_family` (§K), `private.lock_media_key_roots` (§L.5).
2. Registry, two tables:
   - Retirement records: `private.media_key_retirements(id bigserial PRIMARY KEY, user_id uuid, image_id bigint, reason text CHECK IN ('release','purge'), operation_id uuid NOT NULL UNIQUE, delete_keys text[] NOT NULL, retired_at timestamptz DEFAULT now(), last_swept_at timestamptz)`.
     - `delete_keys` is the exact family computed once, at retirement time, from the stored keys.
     - It is immutable: no function updates it, and a trigger raises on any UPDATE of it.
   - Indexed roots: `private.retired_media_key_roots(user_id uuid, key_root text, retirement_id bigint REFERENCES private.media_key_retirements, PRIMARY KEY(user_id, key_root))`.
   - RLS enabled on both.
   - `REVOKE ALL ON private.media_key_retirements, private.retired_media_key_roots FROM PUBLIC, anon, authenticated, service_role`. This includes DELETE, TRUNCATE, INSERT, UPDATE, REFERENCES and TRIGGER, and overrides the baseline default grants (20260521120000:2511-2514; those apply to `public`, and the explicit REVOKE protects against any default privileges on `private`).
   - Then `GRANT SELECT … TO service_role`.
   - Writes happen only inside the SECURITY DEFINER functions below, owned by the migration owner.
3. Guard `private.media_key_retirement_guard()` on the five tables:
   - SECURITY DEFINER, `SET search_path = ''`, all names schema-qualified (`pg_catalog.`, `private.`, `public.`), in the style of `_media_guard_key_ownership_image` (media_authorization.sql:456). Owned by the migration owner, with EXECUTE revoked per item 7.
   - For each NEW non-NULL key that differs from OLD:
     - compute the root;
     - `private.lock_media_key_roots`;
     - then a FRESH read: a separate statement after the locks, READ COMMITTED, seeing committed retirements.
   - The read is `private.retired_media_key_roots` for that root, global across all users and rows, not limited to the caller's rows.
   - On `observation_images`:
     - `purge_claimed_at` is server-owned and immutable: any UPDATE that changes it from non-NULL is refused, and client INSERT/UPDATE may never set it. The claim core function may set a transaction-local GUC (`sporely.purge_claim`), but only as a hint for diagnostics; it is never authorization, because any SQL caller can set it.
     - The guard permits NULL → non-NULL `purge_claimed_at` only through an exact, immutable link: a new server-owned column `observation_images.purge_retirement_id` must reference a `private.media_key_retirements` row with `reason = 'purge'`, `image_id = NEW.id` and `user_id = NEW.user_id`. `purge_claimed_at` and `purge_retirement_id` are set together, once, by the SECURITY DEFINER claim function, which inserts the retirement and sets both columns in the same function body. No transaction-identity proof is used (no `xmin`/`txid_current()` comparison: `xmin` is a 32-bit xid that differs from the epoch-extended `txid_current()` and from the top-level xid inside savepoints and PL/pgSQL EXCEPTION blocks). Freshness is not needed, because a retirement is permanent. `purge_retirement_id` is immutable once set, like `purge_claimed_at`.
     - The claim function inserts that record first and only then updates the row.
     - Without the record the transition is refused, whatever the GUC says.
     - `deleted_at` non-NULL → NULL is refused while `purge_claimed_at` is set, regardless of paths (the restore policy allows NULL-path microscope rows, 20260717120000:30-33), and also when any of the row's key roots is retired.
   - A rejection raises P0001 with HINT `sporely_media_key_released` / `sporely_purge_claimed`.
   - Isolation requirement:
     - The guard and all new functions first check `current_setting('transaction_isolation') = 'read committed'`.
     - Otherwise they raise P0001, HINT `sporely_requires_read_committed`, because the fresh post-lock read is only correct under READ COMMITTED.
     - PostgREST and the Worker/admin REST paths use READ COMMITTED by default.
4. Release `private.release_observation_image_bytes_core(p_release_id uuid, p_image_id, p_expected_storage_path, p_expected_original, p_metadata_purpose)`:
   - Takes all §L locks up front: the observation (via the image's `observation_id`, read without a lock, then re-verified after locking), user lock 42, the image, the image's owner measurements, and the family key locks. Only then does it write.
   - Checks:
     - `auth.uid()` = image owner = observation owner.
     - Refusals:
       - `deleted`: `deleted_at` is set.
       - `not_microscope`.
       - `row_changed`: the paths differ from the expected values and this is not a replay.
       - `purpose_invalid`.
       - `media_key_shared`: ANY other reference to a family root on any of the five tables. The only exemption is the rows this transaction clears: measurements with `image_id = p_image_id AND user_id = owner`, and the owning observation's cover. Foreign-owned measurements on this image count as references. The older RLS gap that lets them exist (20260925120000:110-116; proposal `docs/proposals/spore-measurement-image-ownership-rls.md`) is a separate security issue, out of scope here.
   - Replay resolves by identity first:
     - If a record with `operation_id = p_release_id` exists (same user, image and reason), return its stored `delete_keys` with `replayed=true` and no writes, whatever the row looks like now.
     - A replay never retargets newly observed keys.
     - If the UUID is unknown and the row's paths differ from the expected values (for example another device's promotion, cloud_sync.py:8147/8191), refuse with `row_changed`.
   - Apply:
     - compute the family once from the stored keys;
     - insert the retirement record (exact `delete_keys`) and its roots;
     - NULL the paths and upload-meta columns; set the purpose;
     - clear the owner measurement keys and the owning cover keys that point into the family.
   - Return `{image_id, delete_keys[] (from the record), purpose, replayed}`.
5. Purge claim `private.claim_tombstoned_image_purge_core(p_claim_id uuid, p_image_id)` (design change 2):
   - Same §L order.
   - Requires `deleted_at` set, `purged_at` NULL, and the restore window passed (the same cutoff as admin-ops `getPurgeCutoffAt`).
   - `media_key_shared` if any other row (live or deleted) references a family root.
   - Inserts a 'purge' retirement record (exact `delete_keys`) and its roots. Sets `purge_claimed_at` and `purge_retirement_id` (new server-owned, immutable columns, item 3) on the row, in the same function body.
   - Replay resolves by `p_claim_id` first and returns the stored `delete_keys`. An unknown claim id on a row that is already claimed gives `already_claimed` with no new record. admin-ops then reads the existing record through the sweep path; it never computes new keys.
   - `finalize_observation_image_purge` (20260809130000:45ff) is replaced. It refuses unless `purge_claimed_at IS NOT NULL AND deleted_at IS NOT NULL` AND `purge_retirement_id` references a 'purge' retirement record with this image and owner. Then it marks the row purged as today. The tombstone keeps its paths, as today.
   - **Irreversible**: afterwards the guard refuses restoring the row and attaching any of its keys.
6. Sweep:
   - `private.claim_retired_key_sweep_core(p_limit)` returns batches of retirement records (all reasons) with their stored `delete_keys`, ordered by `last_swept_at NULLS FIRST`. It never recomputes a family.
   - `private.record_retired_key_sweep_core(p_retirement_ids)` sets `last_swept_at`.
   - Repeatable at any time: there is no one-shot flag, and admins run a full sweep after any period in which released-key rejection might have been off (a Worker rollback, see the rollback table).
   - Before deleting, the sweep re-checks references with the same lock order.
     - The only exemption is, for a 'purge' record, the matching tombstone row itself (`id = image_id`, `purge_claimed_at IS NOT NULL`, `deleted_at IS NOT NULL`), which keeps its paths permanently.
     - Every other reference (live or deleted, any table) is reported as a guard failure and skipped.
   - The same exemption lets the sweep recover an interrupted purge: the claim committed but R2 deletion or finalisation failed.
7. Function privileges.
   - Baseline default privileges grant EXECUTE on new public functions to anon, authenticated and service_role (20260521120000:2501-2504).
   - Every new function, the `private` helpers, core functions and guard as well as the `public` wrappers, is followed by `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role`, then a GRANT to exactly the intended role. Helpers, core functions and the guard get no grants; they run only as owner, inside SECURITY DEFINER callers or triggers.
   - Public wrappers are `SECURITY DEFINER`, `search_path=''`, and delegate to the core function:
   - `public.release_observation_image_bytes(p_release_id, ...)`: GRANT EXECUTE to authenticated (the owner check is in core).
   - `public.media_key_is_retired(p_user uuid, p_key text)`: Worker, service_role only.
   - `public.claim_tombstoned_image_purge(p_claim_id, p_image_id)`: admin-ops (one claim UUID per row attempt, kept in the action log), service_role only.
   - `public.claim_retired_key_sweep(p_limit)` and `public.record_retired_key_sweep(p_roots)`: admin-ops, service_role only.
8. Admin-ops changes (supabase/functions/admin-ops/adminActions.ts):
   - `purgeSingleTombstoneRow` (:1135) calls `claim_tombstoned_image_purge` (with the retry policy) and uses the RETURNED `delete_keys` for `r2Client.deleteObjects` (:1159). It no longer uses the client-side `buildTombstoneDeleteTargets`. Then `finalize_observation_image_purge` as today.
   - A claim refusal sets `purge_error` (`media_key_shared` / `not_eligible`) with no R2 call.
   - New action `sweep_retired_media_keys`: claim, delete, record, in batches, with the retry policy.
9. Indexes: expression btree indexes on `private.media_key_root(storage_path)`, `(original_storage_path)` for `observation_images`; `(image_key)`, `(thumb_key)` for `spore_measurements` and `observations`; `(storage_key)` for `spore_measurement_mosaics`; and `(image_storage_path)` for `calibrations`, each partial `WHERE col IS NOT NULL`. Reference checks query through the same expression, and the tests assert the plans with EXPLAIN.
10. Brake (20261015090000:27-40): accept identity '2' or '3'.
11. Acceptance evidence for 0a (a local `supabase db reset --local`):
    - SQL tests:
      - every refusal and the replay;
      - owner, foreign user and anon checks;
      - measurement and cover clearing limited to owner rows;
      - a foreign-owned measurement leads to `media_key_shared`;
      - every family form rejected on INSERT, UPDATE and restore, in all five tables, for authenticated AND service_role;
      - the promotion rollback is unaffected;
      - the brake accepts 2 and 3;
      - service_role cannot INSERT, UPDATE, DELETE or TRUNCATE the registry;
      - anon and authenticated cannot SELECT it;
      - an ACL test: for every new function, `proacl` from `pg_proc` equals exactly the intended set from item 7 (no implicit PUBLIC, anon or authenticated);
      - `purge_claimed_at` cannot be set or cleared by authenticated or service_role writes;
      - restore is refused while it is set, including for a NULL-path microscope row;
      - finalize is refused without the claim or after an un-tombstone attempt;
      - replay and sweep return exactly the stored `delete_keys`;
      - the sweep exempts only the matching claimed tombstone;
      - interrupted purge (claim committed, no finalize): sweep plus re-run finalize recover.
    - Real REST calls (curl against the local API with anon, authenticated and service keys): release, `media_key_is_retired`, claim and sweep are allowed or refused as granted.
    - `media_key_retirement_concurrency_test.sh`, extending the two-session pattern of `shared_reference_consent_concurrency_test.sh`.
      - Barriers live only in the harness. Production functions contain no pause hooks.
        - The inversion is created with explicit locks held open by a test session: `BEGIN; SELECT … FOR UPDATE` on the observation or image, or `pg_advisory_xact_lock` on a key root or on user lock 42. A third session releases them on cue.
        - A pause inside an ordinary write path (a plain PATCH, the child-touch trigger) uses a test-only trigger in a test-only schema (`test_barriers`), installed by the harness only into the local test database and dropped afterwards. It waits on a harness-held advisory lock before or after the parent/child update.
        - The migration never creates the schema. A probe asserts it is absent outside tests.
      - Cases, each run in both orders:
        1. release vs. PATCH of the same image's storage_path;
        2. release vs. the visibility cascade on the same observation;
        3. multi-row writes in opposite order (image → observation touch vs. release);
        4. release with a foreign-owned measurement referencing the key;
        5. purge claim vs. owner restore vs. a second claim;
        6. two pre-seeded rows sharing a key: both releases refused (`media_key_shared`), no registry row;
        7. lost-response retry: replay by the same UUID returns the stored keys, no writes, `updated_at` unchanged. A different UUID after a promotion gives `row_changed`;
        8. cross-row attachment, for EACH guarded table (`observation_images` storage_path, original_storage_path and restore; `spore_measurements` image_key, thumb_key; `observations` cover; `spore_measurement_mosaics.storage_key`; `calibrations.image_storage_path`): release or claim vs. an INSERT/UPDATE on a DIFFERENT row attaching a key from the same family, in both orders.
           - Assert the actual wait: the second session is observed blocked in `pg_stat_activity` (`wait_event_type='Lock'`, `wait_event='advisory'`) before the first commits, using the wait-observation pattern in shared_reference_consent_concurrency_test.sh ~L155.
           - Assert the final state: either the attach is refused (`sporely_media_key_released`) with registry rows present, or the release/claim is refused (`media_key_shared`) with no registry rows and the attach committed;
        9. a foreign-owned measurement attaching the key through the documented ownership gap (20260925120000:110-116), in both orders: the same two outcomes;
        10. forged claim: `set_config('sporely.purge_claim', …)` through a test-only RPC (in the test-only schema), then an UPDATE of `purge_claimed_at` and a finalize call. Both are refused without a valid `purge_retirement_id` link. Also: a forged link (wrong image, wrong owner, a 'release' record) is refused; a claim whose retirement insert runs inside a savepoint or EXCEPTION block succeeds; claim-only PATCHes that set or clear `purge_claimed_at`/`purge_retirement_id` are refused for authenticated and service_role, and a following NULL-path restore is refused;
        11. a non-READ-COMMITTED session (REPEATABLE READ / SERIALIZABLE) calling release, claim or a guarded write gets `sporely_requires_read_committed`.
      - Each case passes on either correct serialisation (the waiter sees the committed result) or a 40P01/55P03 that the harness's retry loop (3 attempts, jitter) resolves to the same final state. Any other error fails the case.
    - Cross-language §K fixture test.

## Stage 0b (sporely-web Worker). Deploying it needs explicit user approval
- `media_key_is_retired` is checked:
  - (1) after JWT verification and before any R2 write, in every upload mode: image-id, legacy no-image-id (index.js:534-548), the original and thumb variants, and mosaic;
  - (2) again after quota accounting (index.js:676) and before the final commit/promotion (:704-707).
- A refusal at (2) reuses the existing compensation: `rollbackWrittenBytesOnly` plus `applyStorageDelta(-delta, -imageDelta)`, as at :689-692. Then HTTP 409 with `X-Sporely-Error-Code: media_key_released`.
- RPC unavailable means fail closed (5xx, compensation runs).
- No lease (user-accepted): a write that commits before retirement leaves an orphan, which the sweep removes.
- `obsolete-desktop-guard.js` (SYNC_KEY_PROTOCOL at :27) accepts '2' and '3'.
- Acceptance evidence for 0b:
  - Worker unit tests: each mode is refused for a retired key; retirement between authorization and commit triggers the compensation with quota restored (assert the `applyStorageDelta` calls net to zero); identity 2 and 3 are accepted; RPC failure fails closed.
  - Real REST check of the Worker's RPC call against local Supabase, using the service key.

## Stage 0c (later; separate approval): identity-3 enforcement
Order:
1. Deploy 0a and 0b.
2. Ship Stage 1 (sends 3).
3. After the adoption decision: refuse identity-2 desktop writes that set non-NULL key columns, and calls to the release RPC (P0001, HINT `sporely_upgrade_required`), plus the Worker 426.

Old identity-2 clients already show the persistent upgrade banner: errors.py:196 → `CloudUploadRefusedError`, `UPGRADE_REQUIRED_MESSAGE` persisted through `cloud_upload_blocked_reason` (sync_client_identity.py:36-43), and the Worker 426 latch (r2_storage.py:688/911).

## Deployment and rollback order

| Step | Deploy | Allowed rollback | What a rollback leaves behind / never |
|---|---|---|---|
| 1 | 0a migration | Before the first retirement only: drop the wrappers, guard and functions. | After any release or purge claim: **never** drop the registry, the guard or `media_key_root`. Forward fixes only. |
| 2 | 0b Worker | Only to a build that accepts identity 2 and 3 AND keeps retired-key rejection. | **Never** go back to the identity-2-only build (obsolete-desktop-guard.js:27) after Stage 1 has shipped: it would brake current desktops. If rejection was ever off, run a full sweep afterwards. |
| 3 | sporely-py Stage 1 | A client that stops calling the release RPC. | Converted rows stay metadata-only. Client markers finish R2 deletion. |
| 0 | Disable the existing purge BEFORE 0a. **Backend-enforced:** a server-side flag (admin-ops env or a settings row) is read inside `purgeSingleTombstoneRow` before any R2 call, not only at batch start, because the loop at adminActions.ts:193-195 iterates preselected rows. Deploy that check, set the flag, then collect drain evidence: the admin action log shows no unfinished `purge_expired_tombstoned_images` run, and the edge-function maximum runtime has elapsed since the flag was set. A UI toggle alone is not enough. | Re-enable only after step 4 is deployed and verified. | The current purge deletes preselected targets directly (adminActions.ts:1160) without revalidation. That race exists in production today, independent of this plan. |
| 4 | Claim-aware admin-ops claim/sweep, then re-enable purge after verification | **Disable purge.** Never roll back to the previous admin-ops. | With purge disabled, tombstoned bytes simply stay. Claimed rows stay claimed (irreversible). |
| 5 | 0c enforcement | Drop the enforcement trigger and the Worker check. | Identity-2 writes resume, still constrained by the guard. |

Irreversible by design:
- a release (row → metadata-only, keys retired);
- a purge claim (row can never be restored, keys retired);
- registry rows.

Stage 1 must not be deployed before 0a and 0b are verified in production (Q-new-1).

## Stage 1 (sporely-py): prevention. Human-gated canary; stays UNCOMMITTED until the user approves
Unchanged from revision 3 except where noted:
- S1.0 capability gate. Conversion requires the release RPC and `metadata_purpose`. Q2 fallback otherwise. Probe error fails closed. Send identity 3.
- S1.1 tombstone flush resolves, validates and defers. It persists the marker on any anchor need, local or cloud-only.
- S1.2 lifecycle, dispatched before the anchor gates (anchors.py:786 top, before :821 and :350-373):
  1. `rpc_attempted` → RPC.
     - **New:** 40P01/40001/55P03 (PostgREST error `code`) are retried in place: 3 attempts, 100-400 ms jitter. After that, the observation stays dirty for the next Sync now.
     - Before the first call, generate `release_id` (UUID v4) and persist it in the marker together with `rpc_attempted=true`.
     - Lost response → call again with the SAME `release_id`. The server returns the stored `delete_keys`.
     - `row_changed` with the persisted id → abandon the attempt: clear the marker and re-evaluate the image from scratch in the next lifecycle entry, with a NEW `release_id`. The desktop never re-sends the old id against new keys.
     - `media_key_shared` → Q2 fallback.
     - `deleted` → drop the marker.
  2. R2 delete of `delete_keys` (404 = success; per-key progress).
  3. Local finalization (metadata-only state, key cache seeded with '', tombstone cleared, marker deleted last). A recheck after `rpc_attempted` changes only intent.
  - The desktop never computes delete keys itself. It uses the RPC's family, so §K stays single-sourced.
- S1.3 promotion nonce for both the reduced-image and original keys, persisted and reused.
- S1.4 retry scheduling on Sync now only: an ungated preflight re-dirty while the marker or protected tombstone exists, the fast-path veto routing to a prepare-free image push, and the dirty→synced block. Refresh ignores D. Markers survive restarts in SQLite.
- S1.5 cross-device adoption in the pull, in `_adopt_remote_image_edits_before_baseline`, and before push-side promotion. It seeds the key cache with ''.
- S1.6 docs.
- Tests: as in revision 3, plus:
  - a fake client raising 40P01 twice then succeeding gives one effect;
  - three failures give a dirty observation and no partial local state;
  - `delete_keys` taken from the RPC response, not computed locally;
  - restore of a claimed or retired row is refused (fake client mirrors the guard).

## Stage 2 (sporely-py): UI wording
Unchanged:
- Variant prompts in both `_on_gallery_delete_cloud_copies_requested` handlers. The removal happens on "Sync now". The text never says the data "has synced".
- DELETE_PENDING tooltip variant. No new badge.
- Localization rule applies. Commit after the user approves the wording.

## Stage 3 (sporely-py): explicit historical repair CLI
Unchanged scope:
- `--dry-run` / `--apply`, local DB only.
- Crash-safe order: marker → exclusion and ledger → restore source → guarded `clear_image_cloud_sync_state` → clear marker.
- Old measurements stay hidden. Old R2 files go to the admin purge, which now claims and retires the family before deleting.
- Note: once an old deleted row's keys are claimed by the purge, that row can never be restored. Stage 3 never restores rows anyway; it creates new ones.

## Review and landing (AGENTS.md L19-21; no Agent Sparring)
- 0a, 0b and the admin-ops change: commit after local verification. Each production deploy needs its own explicit approval, with its evidence: 0a SQL, REST and concurrency output; 0b Worker tests; afterwards, read-only production probes of functions, triggers, grants and indexes.
- Security review covers the SECURITY DEFINER functions, grants, guard, Worker and admin-ops.
- Stage 1: uncommitted until the user's canary passes after 0a and 0b are live. The canary list is as in revision 3, plus: restoring the converted image through the web is refused.
- After that: commit, push, sporely-reviewer plus sporely-security-reviewer.
- Stage 2 commits after the wording is approved. Stage 3 is committable on tests; `--apply` is the user's action.
- 0c is a later, separate approval.

## Risks
- Pre-existing lock inversions (the child-touch trigger) can still produce 40P01. Mitigated by retry plus idempotency, not eliminated.
- The conservative §K grouping can over-refuse unusual canonical names (`media_key_shared`). Those images keep their bytes.
- Expression indexes add write cost to five tables. Measure on the local DB, and check against `admin_database_health`.
- Foreign-owned measurements (the older RLS gap) can block releases until that separate fix lands.

## Recorded decisions
- Q1: explicit CLI repair.
- Q2: no capability → keep the bytes. Probe error → fail closed.
- Q3: orphaned measurements stay hidden.
- Q4: the admin purge handles old R2 files, with the claim.
- Q-new-1: Stage 0 is mandatory and must be verified first.
- Q-new-2: Sync now only.
- Q-new-3: identity 3 with ordered enforcement.
- Design change 1: canonical lock order plus bounded retries.
- Design change 2: an irreversible purge claim before any R2 delete.
- Stages 1 and 3 stay separate.

## Open questions
- Q-r3-1: the grace window and trigger for the sweep. Still open; it is now repeatable, so it could be a scheduled job plus a manual "full sweep".
- Q-r3-2: whether to surface `media_key_shared` in admin sync health.
- Q-r3-3: the adoption threshold for 0c.
- Q-r4-1: should the restore window cutoff used by the purge claim live in SQL (one source) instead of the admin-ops environment (`getPurgeCutoffAt`)? Recommended: pass it as a parameter, validated against a minimum in SQL.
- Q-r4-2: RESOLVED (revision 5). No hooks in production functions. Harness-held locks plus a test-only trigger schema in local test databases.

## Current stage / handoff (2026-10-20, Step 0 + Stage 0a implemented; not deployed)

Branch `feature/media-key-retirement` (base `origin/main` 292beb3). Nothing was applied
to production; no deploy, push to the database or function deploy happened.

Done:
- Step 0: `ADMIN_TOMBSTONE_PURGE_ENABLED` (fail closed: purge runs only when it is exactly
  `true`), checked at action start before the R2 preflight and per row in
  `purgeSingleTombstoneRow` before any R2 call or row write. Edge-function env is fixed per
  invocation, so the per-row check stops a run only through a fresh deploy/secret change;
  drain evidence (action log, max runtime) is still required before 0a.
- Stage 0a migration `supabase/migrations/20261020120000_media_key_retirement.sql`.
- Stage 0a item 8 (claim-aware admin-ops purge and `sweep_retired_media_keys`), behind the
  same flag. Deploy it only at rollout step 4.
- Tests: `supabase/tests/media_key_retirement_test.sql`,
  `media_key_family_fixture_test.sh` + `fixtures/media_key_family_fixture.json`,
  `js/media-key-fixture.test.js` (today's Worker `deriveThumbKey` against the fixture),
  `media_key_retirement_concurrency_test.sh`, `media_key_retirement_rest_test.sh`,
  admin-ops Deno tests.

Deviations from the plan text, found against the real code:
- Index expressions are evaluated as the writing role: `private.media_key_root` is
  self-contained (pg_catalog only) and granted EXECUTE to authenticated and service_role.
  No USAGE on schema `private` is granted. All other helpers have no grants.
- The guard trigger is `zzy_media_key_retirement_guard`, so the non-mutating
  `zzz_sync_identity_guard_*` stays last (sync_key_identity_test asserts that).
- The mosaics index is not partial (`storage_key` is NOT NULL; the planner cannot match the
  partial predicate).
- §K: a name made only of prefixes keeps its last prefix (strip while longer than the
  prefix); needed for root(member) = root(key). JS/Python must follow the fixture.
- Claim takes `p_restore_window_days` (default 30, refused below 30): Q-r4-1 recommended answer.
- Sweep record takes retirement ids (`record_retired_key_sweep(p_retirement_ids bigint[])`),
  not roots. guard_failed records are recorded too so the queue rotates.
- Isolation check: the guard checks READ COMMITTED only when it has work (a changed key,
  a restore or a claim-column change), not on every write.
- Release refuses a row with no stored keys as `row_changed`.
- `finalize_observation_image_purge` is now SECURITY DEFINER with an empty search_path
  (still service_role only).
- The authenticated foreign-measurement RLS gap is closed (20260925160000); foreign-owned
  measurements are seeded through the service role in the tests (superseded by review round 1 below).
- The admin_database_health classifier gets one rule for the two registry tables.

Open for review / next stages:
- Registry rows keep `user_id` after account deletion (no FK, never deleted): privacy review.
- Release does not change profile storage quota; byte accounting stays with the Worker delete.
- Stage 0b (Worker), Stage 1 (sporely-py) and the JS/Python §K implementations are pending;
  they must pass `supabase/tests/fixtures/media_key_family_fixture.json`.
- Security review (sporely-security-reviewer) of the SECURITY DEFINER functions, grants,
  guard and admin-ops before any deploy.

### Review round 1 (candidate 289fffa: NEEDS CHANGES), fixed in follow-up commits

- B1 cross-owner references: the guard now refuses, for EVERY role (round 3; no exemption)
  and before any key lock or registry read, a new or changed key that is not under the row owner's `<uid>/` prefix
  (HINT `sporely_media_key_foreign`, SQLSTATE 42501, same refusal whether or not the key is
  retired). Release, claim and sweep count every reference of the image or record owner, whatever
  its prefix, and ignore other owners' rows (`private.media_key_owner_references`, round 4). A planted foreign measurement or cover no
  longer blocks a release; it is left untouched. Plan cases 4/9 change accordingly: a foreign
  attach is refused outright and never waits.
- Sweep: `last_attempted_at` (set with clock_timestamp for every handed-out record) drives
  the order, so failing records rotate to the back. The sweep returns `image_exists` and
  `image_purged_at`; admin-ops skips finalize for a gone or purged row and records it as done.
- Claim: locks, exempts and clears the owner's measurements of the image and the owning
  cover exactly like the release, so measured tombstones are purgeable.
- `statement_timeout` removed (inert); `lock_timeout` kept. Guard and registry triggers are
  `ENABLE ALWAYS`. Keys with `.`/`..` segments, any `%` (round 4) or a backslash are refused for
  every role's new or changed keys (`sporely_media_key_invalid`); release and claim return
  `key_invalid` for a malformed stored key. **The Worker must apply the same rule in Stage 0b**
  (fixture field `valid`).
- Release/claim take `FOR NO KEY UPDATE` row locks (§L updated above).

### Deploy prechecks (read-only production queries the user runs before 0a)

1. Btree cap (2704 bytes): `max(octet_length(col))` for observation_images.storage_path,
   original_storage_path; spore_measurements.image_key, thumb_key; observations.image_key,
   thumb_key; spore_measurement_mosaics.storage_key; calibrations.image_storage_path.
2. **HARD GATE.** Keys outside their row owner's prefix: per column of the five tables,
   `count(*) WHERE col IS NOT NULL AND NOT starts_with(btrim(btrim(col), '/'), user_id::text || '/')`.
   0a may deploy only when every count is zero, or when each such row is listed and the user has
   accepted it. Such rows are never retired: release and claim return `key_foreign` and keep the
   bytes, and the sweep refuses records with keys outside their prefix. They also escape
   prefix-based account deletion (see the GDPR gaps below).
3. Tombstones that would still refuse a claim: tombstoned, unpurged images whose key roots are
   referenced by an owned row other than the image, the owner's measurements of it and its
   observation's cover (run after deploying the functions, or as the equivalent join).
4. The eight `CREATE INDEX` statements are not CONCURRENTLY: writes to the five tables block
   while they build inside the migration transaction. Check table sizes and pick a quiet window.

### Open items (need a user decision)

- Privacy erasure of registry rows after account deletion (rows keep `user_id`, never deleted).
  Not implemented.

### Review round 3 (user decisions of 2026-10-20)

Owner-prefix and malformed-key checks apply to EVERY role (option a), only to new or changed
keys. There is no exemption mechanism; no migration needed one. Nine existing test files that
wrote unprefixed or `../` keys were changed:
- Seven now use owner-prefixed fixture values: admin_sync_health, child_parent_updated_at_triggers,
  metadata_only_microscope_images, observation_microscopy_presentations,
  public_observation_rpc_validation (including the one expected URL), sample_source_public_rpc_validation,
  and public_observation_spore_previews (the `x/` thumb keys).
- Three tests exist to prove read-side defences against legacy malformed rows: media_authorization,
  mosaic_storage_key_ownership and public_observation_spore_previews. They now first assert that the
  guard refuses the malformed write, then plant the legacy row with only
  `zzy_media_key_retirement_guard` disabled (owner-only DDL inside the test transaction). Their
  read-side assertions are unchanged. mosaic_storage_key_ownership has one extra pgTAP assertion
  (plan 38 -> 39).

Account deletion erases all of the user's media and registry rows (GDPR storage limitation and
erasure):
- Order in supabase/functions/delete-account/plan.js:
  1. snapshot the image, mosaic and calibration keys;
  2. `delete_r2_prefix`: list and delete everything under `<uid>/` in every configured bucket
     through the S3 API (r2Prefix.ts);
  3. snapshot-based Worker deletes;
  4. the existing DB stages;
  5. `delete_r2_prefix_second_pass`;
  6. `verify_r2_prefix_empty`;
  7. `erase_media_retirements`;
  8. profile, then auth user.

  Any failure stops before the auth user is deleted. The prefix is derived only from a UUID-shaped
  uid, so it can never widen to a whole bucket.
- Erasure mechanism: `private.media_key_registry_erasable(uid)` is true only when the server-owned
  account-deletion marker `private.reference_account_deletions` exists and no row of the user
  remains in observations, observation_images, spore_measurements, spore_measurement_mosaics or
  calibrations.
  - Who writes the marker: only the service-role-only `delete_reference_library_for_account` stage
    writes it, and it cascades away with the auth user.
  - The DELETE exception sits in the immutability trigger itself: a data condition, not a GUC.
  - `public.erase_account_media_retirements` (service_role) refuses otherwise
    (`sporely_account_not_erasable`). TRUNCATE and every other DELETE stay refused.
- Why erasing is safe: no row can carry the deleted uid (FKs to profiles/auth.users). The guard
  refuses any new or changed key outside the writing row owner's prefix for every role, so nothing
  can attach a key under the erased prefix again (tested for authenticated, service_role and owner).
- Env and secrets for delete-account: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT`
  (required; without them the run fails closed at `delete_r2_prefix`), `R2_BUCKET_NAME` (default
  `sporely-media`) and `R2_PRIVATE_BUCKET_NAME` (REQUIRED, round 4: the private bucket name, or the
  literal `none` when the Worker binds no PRIVATE_MEDIA_BUCKET; unset or empty fails closed before
  any erasure). The token needs List, Read and Delete on both buckets. Edge-function secrets
  are project-wide, so admin-ops' values apply.

GDPR inventory: personal data that remains after a completed account deletion (not changed this round):
- `public.admin_action_log` (20260623170000_admin_moderation_actions.sql:1). `target_id`,
  `request_payload`, `before_snapshot` and `result_snapshot` keep user ids and storage keys for
  purge, sweep, ban, report and storage-recalculation actions (adminActions.ts:139/161/196/266;
  rows carry user_id, storage_path and delete_targets). There is no FK and no erasure.
- `private.reference_curation_events` (20260829141735_add_curated_reference_library.sql:194):
  `target_id` and other uuid columns without a cascade; `actor_user_id` is SET NULL via profiles.
- private.reference_curation_* (`target_id`, `reporter_id`, `claimed_by`, `accepted_by`) and
  curated_reference_* (`created_by`, `updated_by`): SET NULL where an FK exists. Columns without an FK
  keep the uuid; that needs an audit.
- Comments and moderation: `comment_moderation.hidden_by`, `reports.dismissed_by` and
  `resolved_by` (admin ids) keep admin uuids.
- Edge-function and Worker logs, R2 access logs: outside the database.
- Round 4 additions:
  - Supabase backups and PITR: deleted data stays in backups until they expire. **The retention
    policy must be stated** (plan tier, PITR window), plus whether a restore re-runs pending erasures.
  - `auth.audit_log_entries`: GoTrue keeps the account's login, logout and deletion events with
    the uid and email in the payload; Supabase-managed retention.
  - CDN and edge caches on media.sporely.no: public media may stay cached after R2 deletion. A
    cache purge of `<uid>/` on account deletion is needed (not implemented).
  - Postgres, PostgREST and auth logs (Supabase log retention) contain uids, IPs and request paths.
  - Email (auth mail) and CAPTCHA processors: provider-side records under their own retention.
  - Other users' copies: other users' `observation_reference_uses.snapshot_json` cannot reference
    the deleted user's sets. The FK is `(user_id, reference_measurement_set_id)` against the user's
    own sets (20260828143513_add_normalized_reference_library.sql:113-132). Shared default-on
    contributions are different: `private.shared_reference_contributions.envelope_json` keeps the
    measurement content the user wrote (owner_id ON DELETE SET NULL,
    20260830183210_add_shared_reference_contributions.sql:12/37), and other users' curated forks
    from them (20261002150000) copy it. That content is text the deleted user wrote (reference
    values, raw text and notes). It is anonymised, not erased: a user decision.
  - Legacy R2 objects outside `<uid>/` (keys counted by precheck 2) are NOT removed by prefix
    deletion; only the snapshot pass reaches the ones still referenced. Remediation: a separate,
    one-off cleanup that inventories R2 objects outside every `<uid>/` prefix and maps or deletes
    them. Out of scope here.
  - Desktop local caches (the SQLite database and image folders on the user's computers) are the
    user's own responsibility; the server cannot erase them. State this in the account-deletion UI
    and privacy text.

Round 4: account-deletion write fence. Once `private.reference_account_deletions` has a row for the
owner, the guard refuses every top-level INSERT and UPDATE of that owner's rows in the five tables,
for every role (HINT `sporely_account_deleting`). It checks this before any early return. Nested
trigger writes (pg_trigger_depth() > 1, such as the child-touch update during delete-account's own
deletes) carry no keys and pass. delete-account starts with `sign_out_everywhere`
(`admin.auth.admin.signOut(token, 'global')`). A retry after a partial failure needs a fresh sign-in;
the marker persists, so the rerun completes.

Stage 0b items:
- The Worker refuses uploads when the account-deletion marker exists, at both points where it
  checks retirement.
- A periodic admin-ops sweep deletes top-level R2 prefixes that have no matching auth user.

Residual risks and open items:
- A still-valid access token can upload through the Worker after `verify_r2_prefix_empty` and before
  the token expires. The 0b Worker fence and the orphan-prefix sweep above close it.
- Admin-log retention and erasure policy (the inventory above): user decision.
