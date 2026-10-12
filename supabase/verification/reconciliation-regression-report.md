# Reconciliation regression evidence — 2026-10-12

Production provenance is owner-accepted: six health functions match `9b2287a`.
Original deployment-file byte identity remains UNVERIFIED. No agent production
queries or writes were performed.

## Failure reproduction and classification

The initial primary-suite command used the wrong fixture setup role:

```sh
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1' < supabase/tests/public_observation_spore_previews_test.sql
```

After a complete clean reset, this command reproduces all 12 failures below.
Each is a fixture/harness role issue, not a version issue, health interaction,
or demonstrated RPC regression. `protect_profile_privileged_fields()` in
`20260603120000` permits moderation-field changes only for `postgres` and
`service_role`. The fixture's `UPDATE profiles SET is_banned=true` is silently
reverted for `supabase_admin`. The documented postgres runner passes.

| Test | Exact assertion | Actual vs expected |
|---|---|---|
| 1 | anon: rows exactly for the eligible fixtures | first have `(banned_owner)`, want `(field_image_only)` |
| 3 | anon: points and mosaic present exactly where expected | first have `(banned_owner,t,t)`, want `(field_image_only,f,f)` |
| 6 | stranger: rows exactly for the eligible fixtures | first have `(banned_owner)`, want `(field_image_only)` |
| 8 | stranger: points and mosaic present exactly where expected | first have `(banned_owner,t,t)`, want `(field_image_only,f,f)` |
| 11 | owner: rows exactly for the eligible fixtures (no owner bypass) | first have `(banned_owner)`, want `(field_image_only)` |
| 13 | owner: points and mosaic present exactly where expected | first have `(banned_owner,t,t)`, want `(field_image_only,f,f)` |
| 16 | blocked viewer: no rows for the blocked owner's observations | unexpected `(banned_owner)` |
| 17 | blocked viewer: get_public_observation also returns no rows | unexpected `(banned_owner)` |
| 18 | blocked viewer: no rows from single-id batch calls | unexpected `(banned_owner)` |
| 19 | viewer blocked by the owner: no rows for the owner's observations | unexpected `(banned_owner)` |
| 20 | viewer blocked by the owner: get_public_observation also returns no rows | unexpected `(banned_owner)` |
| 21 | viewer blocked by the owner: no rows from single-id batch calls | unexpected `(banned_owner)` |

Other initial errors:

- Re-running the batch SQL on an already-migrated local database using the
  same admin psql command with the migration as input: `ERROR: function
  "public_observation_eligibility" already exists with same argument types`.
  Migration invocation issue: CREATE FUNCTION migration is not idempotent.
  Clean reset applies it once successfully. Never reapply it.
- Direct admin psql input of `public_observation_spore_previews_order_test.sql`:
  `ERROR: function plan(integer) does not exist; LINE 1: SELECT plan(11);`
  Harness issue: pgTAP runner/extensions search path was missing.
- `bash supabase/tests/public_observation_spore_previews_identity_test.sh` on
  the old reused database: `ERROR: output changed: get_public_observation as
  owner for observation 2377`, `CONTEXT: PL/pgSQL function inline_code_block
  line 16 at RAISE`. Difference was point order: new measurement IDs
  `[22753,22754,22755,22756]`, old `[22756,22753,22754,22755]`.
  This is the already-approved explicit-order exception, exposed by the old
  database's physical/query-plan state. Clean reset passes all 42 visible rows.
  No new RPC behavior or SQL fix is justified by this failure.
- Passing three DO/assertion suites to `supabase test db` produced
  `No subtests run` / `Parse errors: No plan found in TAP output`.
  Harness issue: these suites are ordinary psql tests, not pgTAP tests.

No migration or test logic was changed to suppress these failures. Use each
suite's documented runner and postgres fixture role.

## Clean replay and final verification

All commands ran from the reconciliation worktree, locally only:

```sh
supabase db reset --local --yes
supabase test db --local supabase/tests/public_observation_spore_previews_test.sql supabase/tests/public_observation_spore_previews_order_test.sql supabase/tests/public_observation_spore_previews_eval_count_test.sql supabase/tests/mosaic_storage_key_ownership_test.sql
bash supabase/tests/public_observation_spore_previews_identity_test.sh
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -X -v ON_ERROR_STOP=1 < supabase/tests/admin_database_health_test.sql
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -X -v ON_ERROR_STOP=1 < supabase/tests/spore_child_image_ownership_rls_test.sql
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -X -v ON_ERROR_STOP=1 < supabase/tests/observation_spore_mosaic_rpc_test.sql
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -X -v ON_ERROR_STOP=1 < supabase/tests/stage2b_authorized_media_projections_test.sql
node --test scripts/supabase-deploy-tree.test.mjs
```

Reset applied the complete local migration sequence, including health190000
before batch20261012100000. The intentionally deferred migration is exercised
locally, but remains excluded from any production deploy tree by its unchanged
registry. Local reset's printed branch "main" is Supabase local branch metadata;
Git candidate remains `feature/migration-history-reconciliation`.

Results: primary batch61/61, order11/11, evaluation9/9, mosaic ownership38/38
(total119); identity42 visible rows (3 with points/mosaic); health all assertions;
three ordinary SQL suites all assertions/exit0; deploy guard19/19. PASS.
Raw local logs: `/Users/sigmundas/sporely-scratch/reconciliation-tests/`.

## Immutable SQL and deployment ordering

Health SHA-256: `7186d77230fb5b5750acbf537a7dea8f52eb6891b842d9060007cf344be5af46`,
byte-identical to `9b2287a`. Batch SHA-256:
`bd18677d8b0228b92f175a642fc8183af3647c9d8547035062b68eb6fe590956`,
byte-identical to main's old-version file and reviewed `cf68f4a` file.
Deferred file and registry unchanged.

Before rename no migration with20261012100000 existed in this repository's
main/health/batch refs. Owner-supplied production history lists no such version;
no fresh production check is claimed. Clean local replay now records that
version as expected. Owner deployment precheck must freshly require matching
health190000, batch20261012100000 local-only, deferred20260914090000 local-only,
and no old batch120000 or unexpected version. The runbook's sole --allow is
20261012100000; already-deployed health is never allowlisted/reapplied.
Historical acceptance evidence and completed deployment reports and measured performance data
retain their original timestamps. Current executable references use the new
version; runbook's historical git-show comparison deliberately uses the old path.


## Fresh independent specialist security review

2026-10-12, read-only `security_reviewer` subagent reviewing the complete working
tree against main10ff4d2: APPROVE; no exploitable or correctness-relevant security
findings. Traced batch eligibility/block/ban/spore-public gates and fail-closed
mosaic authorization; private helpers denied to client roles; empty search path;
public batch callable only by anon/authenticated. Health remains service-role-only
with pg_catalog search path. Runbook exact hashes, already-applied190000,
sole121000 allowlist and deferred exception verified. One stale future-production
reference in the current performance doc was corrected; measurements unchanged.

This is an independent specialist subagent review, not the separate top-level
`sporely-security-reviewer`/Agent Sparring acceptance gate required by the
production runbook. That gate and owner final candidate approval remain pending.
Candidate remains uncommitted; no main merge/push or production operation.
