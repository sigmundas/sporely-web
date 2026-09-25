
## Execution plan

| Stage | Goal | Blocks |
|---|---|---|
| **A0** | Make production migration deployment safe while `20260914090000` is deferred | A |
| **A** | Close cross-owner measurement/annotation RLS hole | Production security |
| **B** | Persist cloud-only fields locally instead of reverting them next sync | Desktop quality/reliability |
| **C** | Manual rename must explicitly clear stale cloud taxonomy identity | **Desktop release** |
| **D** | Release candidate: version bump + focused cross-device acceptance | Desktop release |
| **E** | Measurement deletion/tombstones | Post-release integrity |
| **F** | Small debt/hardening: capture time, list columns, no-op dirtying, TRUNCATE review, test isolation | None |
| **G** | Public generic microscopy/cystidia | Future feature |
| **H** | Snapshot-v2 rollout | Future rollout |

The important discipline is **separate commits and reviews for A, B and C**. B and C can later share one release acceptance run, but they should not be implemented as one blob. The audit specifically found the cloud-only rebase bug to be fully reproducible and the rename/identity problem to be newly dangerous because main now propagates cloud identities to other desktops. :chatgpt-content-reference{index="2"}

I would also keep measurement deletion out of this release. It is real and ugly, but it is pre-existing behavior rather than something this release introduces. :chatgpt-content-reference{index="3"}

## Stage status

| Stage | Status | Candidate |
|---|---|---|
| **A0** | Merged to web `main` (`55e84c6`) | web `feature/migration-deploy-gap-guard` @ `c4bff80` (base `8822961`); py `docs/closeout-917-environment` @ `61dac67` (base `934bf14`) |
| **A** | **CLOSED** 2026-09-25 — deployed to production, read-only checks passed, merged to web `main` (`8a5c474`) | web `feature/measurement-image-ownership-rls` @ `db0dc6d` (base `c4bff80`) |
| **B** | **Review approved** 2026-09-25 — awaiting merge decision | py `feature/sync-persist-remote-only-fields` @ `53f94b2` (base `934bf14`) |
| C–H | Not started | — |

## Stage A — findings and record (2026-09-25)

- Migration `20260925160000_enforce_spore_child_image_ownership.sql` ALTERs the WITH CHECK of `spore_measurements_owner_insert`, `spore_measurements_owner_update` and `"spore_annotations: owner full"` to require `EXISTS (observation_images i JOIN observations o … i.user_id = auth.uid() AND o.user_id = auth.uid())`, and scopes the annotation policy `TO authenticated` (was PUBLIC; keeps anon's prior default-deny outcomes). USING/SELECT/DELETE unchanged. No data or function changes.
- Test `supabase/tests/spore_child_image_ownership_rls_test.sql`: passes post-fix, fails at M3 pre-fix; includes a rolled-back control proving the old policy let B's row reach A's `get_public_observation`.
- Full isolated replay (111 migrations) + 62 SQL files: identical to baseline except the new test. Pre-existing in both: 5 files segfault the local `supabase/postgres:17.6.1.106` backend when anon calls a function lacking EXECUTE; `public_observation_point_prep_test.sql` assertion fails.
- SECURITY DEFINER audit: no function/view/rule writes either table; only trigger (`touch_observation_updated_at_from_measurement`) is AFTER-row, bumps `updated_at`. No bypass.
- Deferred follow-ups: `spore_annotations.measurement_id` may reference another user's measurement (no readers; low); anon TRUNCATE on `spore_annotations`/`spore_measurement_mosaic_tiles` (Stage F); public-RPC `m.user_id = i.user_id` defence in depth; `docs/proposals/spore-measurement-image-ownership-rls.md` status still says "proposal".
- Deploy: `prepare --allow 20260925160000 --ref db0dc6d` then `check` → "dry run pushes exactly: 20260925160000"; user pushed; `post-verify` → "Remote matches the deploy tree exactly; deferred migrations are still absent". Deploy tree removed.
- Production read-only verification (2026-09-25), all pass:
  - `20260925160000` recorded once; latest remote; `20260914090000` absent.
  - Recorded statements: BEGIN, 3× ALTER POLICY, COMMIT — no DML, no function DDL.
  - Policy md5 (roles|cmd|permissive|qual|with_check) for all 5 policies on both tables identical to the reviewed replay; annotation policy `{authenticated}`.
  - `spore_measurements` 7757 (= pre-deploy audit), cross-owner 0; `spore_annotations` 0 rows, cross-owner 0; image/observation owner mismatch 0.
  - 218 non-extension `public`/`private` functions: 212 byte-identical to reviewed source; the 6 differing are exactly the `private.*` functions redefined by deferred `20260914090000`.
  - Anon PostgREST `get_public_observation`: obs 1008 → 200, 207 measurements/points (raw 207); obs 986 → 200, 112 (raw 112).
- Merged `feature/migration-deploy-gap-guard` (`55e84c6`) and `feature/measurement-image-ownership-rls` (`8a5c474`) into web `main`, pushed; helper tests 15/15 on merged main.

## Stage A0 — findings and record (2026-09-25)

**Done**

- [x] Gap registry `supabase/deploy-exceptions.json`: production ref `zkpjklzfwzefhjluvhfw`, deferred `20260914090000_extend_reference_snapshots_to_version_2.sql` pinned by filename and SHA-256 `01972eb6…af94c`. The migration file is unchanged.
- [x] Helper `scripts/supabase-deploy-tree.mjs`:
  - `prepare --allow <versions> --ref <commit>` builds a detached worktree without the deferred file and verifies the production link.
  - `check` runs the read-only `migration list` and `db push --dry-run`, and requires the pending set and the dry-run set to equal the allowlist exactly.
  - `post-verify` confirms the push landed and the gap is intact.
  - It never runs the real push.
- [x] `AGENTS.md` and `docs/deployments/2026-09-25-migration-order-exception.md` document the gap and the procedure.
- [x] Tests `scripts/supabase-deploy-tree.test.mjs`: 15 pass. Also end-to-end with the real CLI 2.98.2 against a throwaway Postgres, plus a local-only `prepare` smoke test on the real repo.
- [x] Closeout record clarified (sporely-py `stage4-audit-and-regression-record.md`): the accepted 917 round trip ran on the isolated local harness, so the image-7305 `owner_sync` parent is not expected in production yet.

**Findings**

- A plain `supabase db push` from main already fails closed on the gap, and so does `migration up`: "Found local migration files to be inserted before the last migration on remote database". The danger is the CLI's own suggestion to rerun with `--include-all`. That would apply `20260914090000` together with any new migration (proven on the throwaway database).
- Remaining bypasses the repo cannot block:
  - running `--include-all` from main;
  - `migration up --linked --include-all`;
  - `db push --db-url …` from main with `--include-all`;
  - applying SQL via MCP/psql, or editing the deploy tree after `check`.
- These are covered by `AGENTS.md` rules and the pinned hash, not by tooling.

**How Stage A uses it**

1. Commit the RLS migration on its branch.
2. After review, run `prepare --allow <A version> --ref <reviewed SHA>` then `check` from your terminal.
3. You run `supabase db push --linked` in the tree.
4. Run `post-verify`, then Stage A's read-only verification queries.

## Stage B — findings and record (2026-09-25)

**What went in**

- **Root cause confirmed:** Push reconciliation kept a remote-only field value in the outgoing payload but never wrote it to the local row; post-push snapshot recorded cloud value as baseline. Later unrelated edit re-pushed stale local value over cloud. Also: fields in `_remote_observation_extra_values` (inaturalist_id, author, spore_statistics, etc.) were not kept in payload.
- **Fix:** After conflict preflight passes, `push_all` adopts ordinary remote-only fields through `_apply_remote_observation_fields` before cloud write, builds payload from adopted local row. Identity adoption unchanged.
- **Tests:** `test_cloud_sync_remote_only_adoption.py` (9 tests, 5 fail pre-fix). Suite: 33 failed/54 errors/4309 passed (same as main).
- **Reviews:** Correctness and sync-focused both approved; no production defects found.
- **Code:** `utils/cloud_sync.py` (~20090–20110 adoption block), sync contract updated, new test file, identity test harness fix (folder path).

**Invariant:** After successful sync, `local == cloud == baseline` for every accepted remote-only field.
