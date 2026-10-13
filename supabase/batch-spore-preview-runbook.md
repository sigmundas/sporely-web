# Runbook — batch spore-preview RPC (production)

Plan: `docs/plans/active/2026-10-10-batch-spore-preview-rpc.md` (Stage 3).
Migration: `supabase/migrations/20261012100000_add_public_observation_spore_previews.sql`.
Probe SQL:
- `supabase/batch-spore-preview-live-probe.sql` (step 3a);
- `supabase/batch-spore-preview-stats-probe.sql` (step 5);
- `supabase/batch-spore-preview-compensation-check.sql` (step 4, only if a
  compensation is needed).

**Only a person runs this.** A person with explicit owner authorization
performs every step and records the evidence. No agent runs any of it or
connects to production. An agent may see only the aggregate results this
runbook marks as recordable. Nothing here is deployed automatically.

Status: **applied to production 2026-10-12; record incomplete.** See
"Production deployment — 2026-10-12" at the end. The `sporely-landing` gate
below has not passed.

**Gate for `sporely-landing`.** Its `docs/plans/explorer-cards-batch-preview.md`
must not start until steps 0–5 have passed and the record from "Record" is
committed.

## What changes in production

- New: `public.get_public_observation_spore_previews(bigint[])`, which returns
  `(observation_id bigint, points jsonb, spore_mosaic jsonb)`.
  - `STABLE SECURITY DEFINER` with `search_path=''`, owned by `postgres`.
  - Execute is granted to `anon` and `authenticated` only.
  - It takes at most 60 ids; more raises SQLSTATE `22023`.
  - The contract is in `SUPABASE_DB.md`.
- Six new functions in the `private` schema, which no client role can execute:
  - `public_observation_eligibility(bigint[])`;
  - `public_observation_spore_point_rows(bigint[])`;
  - `public_observation_spore_points_raw(bigint)`;
  - `public_observation_spore_mosaic_raw(bigint, uuid)`;
  - `public_observation_authorize_spore_points(jsonb)`;
  - `public_observation_authorize_spore_mosaic(bigint, jsonb)`.
- `public._get_public_observation_stage2a(bigint)` and
  `public.get_public_observation(bigint)` are replaced (`CREATE OR REPLACE`).
  - Their signatures, owner, grants, `SECURITY DEFINER` and `search_path` stay
    the same.
  - Their fields, values, visibility gates and media behaviour (including
    the legacy mosaic `url`) stay the same.
  - **Owner-approved exception:** `sporePoints` order becomes image id,
    then measurement id. Observations whose previous, unspecified order
    differed now return their points reordered, and a Landing card may show
    a different first 16 points. Output is byte-identical only where the old
    order already was id order (see
    `supabase/tests/public_observation_spore_previews_identity_test.sh` and
    `SUPABASE_DB.md`).
  - A single `get_public_observation` call is modestly more expensive:
    3–12 % more execution time locally. The step 5 baseline and the
    post-switch comparison should be read with this in mind.
  - They now read the private helpers instead of inline subqueries.
- No table, row, index, policy or trigger changes. No Worker deploy and no
  client release. Nothing calls the new function until `sporely-landing`
  switches its Cards view.
- The migration is a single `BEGIN … COMMIT`.

## Data-handling rules for whoever runs this

- Production holds personal data. Only these results may go into this
  repository or to an agent:
  - the booleans and integers from steps 3a and 3b;
  - the timestamps, settings, role names and integers from step 5;
  - pass/fail and the error code from step 1.
- The probe files print no observation id, user id, key or query text. Do not
  change them to print any.
- In step 3b the operator picks two observation ids. Do not record them,
  including the public one.
- Never put the service-role key or a database password in a prompt or a
  commit. The anon (publishable) key in step 3b is public, but keep it out of
  agent sessions anyway.

## 0. Gate before starting

All of the following must be true. Otherwise stop.

- Stages 1 and 2 of the plan are accepted, including the
  `sporely-security-reviewer` verdict on the Stage 1 candidate SHA, and the
  branch's final SHA has its own `sporely-security-reviewer` APPROVE.
- The branch is merged to `main`, and `<merged main SHA>` is pushed. The
  migration file at that SHA is byte-identical to the migration as
  security-reviewed in its final form, at `cf68f4a`. The engine-accepted
  Stage 2/3 candidates (`22f7b60`, `4c21355`) carry the same SQL but older
  comments, so do not diff against them:

      git fetch origin
      git merge-base --is-ancestor <merged main SHA> origin/main
      git show cf68f4ad68772b4580c63d7a0a48bd97665cf26b:supabase/migrations/20261011120000_add_public_observation_spore_previews.sql | shasum -a 256
      git show <merged main SHA>:supabase/migrations/20261012100000_add_public_observation_spore_previews.sql | shasum -a 256

  Both hashes must equal `bd18677d8b0228b92f175a642fc8183af3647c9d8547035062b68eb6fe590956`.
  The ancestor command must exit 0.
- `supabase/deploy-exceptions.json` at `<merged main SHA>` still lists only
  the deferred `20260914090000`.
- The owner has explicitly authorized this production deployment in the
  current session.

## 1. Pre-checks (read-only)

Run this from an ordinary checkout of `<merged main SHA>` that is linked to
production. `supabase/.temp/project-ref` must read `zkpjklzfwzefhjluvhfw`.

    supabase migration list

Expected:

- Local and Remote match for every version, with exactly two exceptions:
  - `20260914090000` is local-only. This is the documented deferred migration
    (`supabase/deploy-exceptions.json`,
    `docs/deployments/2026-09-25-migration-order-exception.md`). It is not a
    mismatch and must not be repaired.
  - `20261012100000` is local-only. This is the migration being deployed.
- The latest Remote version is `20261011190000`, the already-deployed database-health migration. Its catalog equivalence to `9b2287a` is owner-verified in `supabase/verification/20261011190000_owner_results.csv`; original deployment-file byte identity remains unverified. It must match Local and must never be reapplied. The mosaic `20261011100000` must also match.

STOP if anything else differs, or if Remote has a version later than
`20261011190000`. Report:
- the mismatched versions and their filenames;
- `git status`;
- the tail of the list.

Do not run `supabase migration repair`, rename files or use `--include-all`. A
plain `supabase db push` refuses here because of the deferred migration. That
refusal is expected; do not work around it.

The unapplied batch migration was renamed from `20261011120000` to
`20261012100000` with SQL bytes unchanged, to follow the already-applied health
migration. Neither column may contain the old batch version. A later Remote
version or any unexpected mismatch means STOP; do not apply out of order.

## 2. Apply (deploy tree)

Only after steps 0 and 1 pass. The helper never pushes; the person does.

    node scripts/supabase-deploy-tree.mjs prepare --allow 20261012100000 --ref <merged main SHA>

`prepare` creates a temporary worktree of that commit without the deferred
`20260914090000` file. It copies the Supabase link and refuses unless the link
points at `zkpjklzfwzefhjluvhfw`. It prints the tree path. Then run:

    node <deploy tree>/scripts/supabase-deploy-tree.mjs check --tree <deploy tree>

`check` runs the read-only `supabase migration list` and
`supabase db push --dry-run` in the tree. It refuses unless the pending set and
the dry run are exactly `20261012100000`. Do not continue unless it prints
`All checks passed`.

    cd <deploy tree>
    supabase db push --linked

Answer `y` only if the CLI prompt lists exactly
`20261012100000_add_public_observation_spore_previews.sql`. If the push fails,
nothing is applied, because the migration is one transaction. Stop and report
the error. Do not retry with other flags.

    node <deploy tree>/scripts/supabase-deploy-tree.mjs post-verify --tree <deploy tree>

`post-verify` confirms that Remote matches the tree and that the deferred
migration is still absent. Run steps 3 and 5, then remove the tree with the
exact command `post-verify` prints:

    git -C <main checkout> worktree remove --force <deploy tree>

Never use `--include-all`, `supabase migration up --linked` from an ordinary
checkout, `supabase migration repair`, MCP `apply_migration`, or direct DDL in
the SQL editor.

## 3. Confirm the function is live (read-only)

### 3a. Catalog and anonymous parity (SQL, aggregate-only)

As the database owner, with `psql` (not the dashboard SQL editor, which may not
run `SET LOCAL ROLE` and multiple statements the same way):

    psql "<connection string>" -X -v ON_ERROR_STOP=1 -f supabase/batch-spore-preview-live-probe.sql

The file runs in one `READ ONLY` transaction that ends in `ROLLBACK`.
- Part A checks the function's catalog shape and grants.
- Part B picks two samples as the owner and keeps them in transaction-local
  settings, so no id is printed:
  - the 30 newest public, spore-public observations with spore measurements;
  - the 30 newest non-public or draft observations.
- It then switches to `anon`, with no JWT claims, and calls both
  `get_public_observation` and the batch function on each sample.
- That is about one cold Cards load of database work (30 single calls and one
  batch).

Expected:

| Output | Expected |
|---|---|
| `security_definer`, `empty_search_path`, `result_shape` | `t`, `t`, `t` |
| `anon_execute`, `authenticated_execute` | `t`, `t` |
| `service_role_execute`, `public_execute`, `helper_executable_by_client` | `f`, `f`, `f` |
| `private_helpers` | `6` |
| `caller`, `uid_is_null` | `anon`, `t` |
| `public_sample` | `> 0` |
| `public_batch_rows` | equals `public_single_rows` |
| `public_batch_rows_with_points` | `≥ 1`. **A known public spore-bearing observation returns its row.** |
| `public_mismatches` | `0`: points equal `get_public_observation`'s card keys, and every returned mosaic equals its `sporeMosaic` minus `url` |
| `batch_mosaics_with_url` | `0` |
| `mosaics_withheld` | `0` (see below) |
| `nonpublic_sample` | `> 0` |
| `nonpublic_single_rows`, `nonpublic_batch_rows` | `0`, `0`. **Non-public observations return no row.** |

How to read deviations:

- **`public_single_rows` below `public_sample`** is normal. The sample does not
  apply every gate (for example banned owners, or image and measurement-type
  gates), and both functions drop those rows. Locally, 10 banned-owner decoys
  in a 30-id sample gave 20 and 20.
- **`public_mismatches > 0`, `batch_mosaics_with_url > 0` or
  `nonpublic_batch_rows > 0`.** STOP. Do not hand the gate to
  `sporely-landing`. Go to step 4.
- **`mosaics_withheld > 0`.** The batch returned no mosaic where
  `get_public_observation` returned one. The batch fails closed by design when
  `media_authorize_mosaic_delivery` denies a mosaic or no Worker URL can be
  built. Production's 2026-10-11 probe found no namespace-invalid mosaic, so
  check the Worker media configuration that `build_worker_mosaic_url` reads.
  This is not a privacy failure, but Cards would lose those atlases. The owner
  decides before passing the gate.
- **`public_sample = 0` or `nonpublic_sample = 0`.** The probe proved nothing.
  Record that, and rely on 3b for that side.

### 3b. Anonymous calls over PostgREST (operator-chosen ids)

This is the path `sporely-landing` uses: the public REST endpoint with only the
anon key.

The operator picks two ids:
- `PUBLIC_ID`: an observation visible on the public explorer with spore
  measurements shown;
- `NONPUBLIC_ID`: an observation known not to be public, for example one of
  the operator's own private observations.

Do not record either id. The output is HTTP statuses and counts only.

```bash
SUPABASE_URL=https://zkpjklzfwzefhjluvhfw.supabase.co
SUPABASE_ANON_KEY='<anon or publishable key>'   # public key; still keep it out of agent sessions
PUBLIC_ID=<id>
NONPUBLIC_ID=<id>

BSP_OUT=$(mktemp)
bsp_call() {
  curl -sS -o "$BSP_OUT" -w '%{http_code}' \
    "$SUPABASE_URL/rest/v1/rpc/get_public_observation_spore_previews" \
    -H "apikey: $SUPABASE_ANON_KEY" -H 'Content-Type: application/json' \
    -d "$1"
}
echo "H1 status=$(bsp_call "{\"p_observation_ids\":[$PUBLIC_ID]}") $(jq -c '{rows: length, with_points: map(select(.points != null)) | length, points: (map(.points // [] | length) | add // 0), mosaic: map(select(.spore_mosaic != null)) | length, mosaic_url: map(select(.spore_mosaic | type == "object" and has("url"))) | length}' "$BSP_OUT")"
echo "H2 status=$(bsp_call "{\"p_observation_ids\":[$NONPUBLIC_ID]}") $(jq -c '{rows: length}' "$BSP_OUT")"
echo "H3 status=$(bsp_call '{"p_observation_ids":[]}') $(jq -c '{rows: length}' "$BSP_OUT")"
echo "H4 status=$(bsp_call '{"p_observation_ids":null}') $(jq -c '{rows: length}' "$BSP_OUT")"
echo "H5 status=$(bsp_call "{\"p_observation_ids\":[$(seq 1 61 | paste -sd, -)]}") $(jq -c '{code}' "$BSP_OUT")"
rm -f "$BSP_OUT"
```

The response body for the public id is public data, but it goes only to a
temporary file and is deleted.

Expected:

| Call | Expected |
|---|---|
| H1 known public, spore-bearing | `status=200`, `rows: 1`, `with_points: 1`, `points` > 0, `mosaic_url: 0` (`mosaic` is 1 if the observation has a spore mosaic) |
| H2 known non-public | `status=200`, `rows: 0` |
| H3 empty array | `status=200`, `rows: 0` |
| H4 null | `status=200`, `rows: 0` |
| H5 61 ids | `status=400`, `code: "22023"` |

H5 builds the id list with `seq 1 61 | paste -sd, -`, because the macOS
`seq -s,` adds a trailing comma, which PostgREST rejects as `PGRST102`.

If every call returns `404` with `PGRST202`, PostgREST has not reloaded its
schema cache. Supabase normally reloads after DDL. Wait a minute and retry.
If it persists, the person runs `NOTIFY pgrst, 'reload schema';` as the owner
and retries.

Any other deviation: STOP. Do not pass the gate; go to step 4.

## 4. Rollback / compensation

Never edit, rename or delete `20261012100000`, never run
`supabase migration repair`, and never run reverse DDL directly in the SQL
editor. Every correction is a **new** migration:
- versioned later than every Remote version;
- validated locally as described in "Validating a compensation" below;
- deployed through the step 2 deploy-tree path with `--allow <new version>`.

### Order relative to `sporely-landing`

- **Before landing switches Cards to the batch function:** nothing calls it.
  Either option below can ship on its own.
- **After the switch:** first redeploy the previous landing build through the
  normal Cloudflare flow, so that Cards uses `get_public_observation` again.
  Only then apply the database compensation. The landing plan has no fallback
  ("no mock fallback"), so dropping the function while it is in use breaks
  Cards spore previews.

### Option R1 — withdraw the batch function (default)

Use R1 when the batch function is wrong or exposes too much, but
`get_public_observation` is fine. R1 leaves `get_public_observation` as
`20261012100000` made it: same fields, values, gates and media behaviour,
with the owner-approved point order (image id, then measurement id). The
identity test shows its output equals the pre-migration output only where the
old order already was id order. Compensating migration body:

```sql
BEGIN;
DROP FUNCTION public.get_public_observation_spore_previews(bigint[]);
COMMIT;
```

This removes the only new client-callable surface. The private helpers stay:
`get_public_observation` and `_get_public_observation_stage2a` depend on them,
and no client role can execute them.

A fix-forward, with a corrected batch function in a new migration, is the
alternative when the defect is narrow. It needs the same review as Stage 1,
including `sporely-security-reviewer`.

### Option R2 — full revert

Use R2 only if `get_public_observation` or `_get_public_observation_stage2a`
itself misbehaves after the apply, despite the identity test. The
compensating migration does the following, in this order and in one
transaction:

1. `CREATE OR REPLACE FUNCTION public._get_public_observation_stage2a(bigint)`
   with the body from
   `supabase/migrations/20260925120000_owner_sync_metadata_parents.sql:386-737`,
   copied verbatim.
2. `CREATE OR REPLACE FUNCTION public.get_public_observation(bigint)` with the
   body from
   `supabase/migrations/20261001195524_hide_observation_time_of_day_from_non_owners.sql:460-520`,
   copied verbatim.
3. `DROP FUNCTION public.get_public_observation_spore_previews(bigint[]);`
4. Drop the six private helpers. Steps 1–2 remove the dependency on them, and
   `DROP FUNCTION` does not track SQL-body references, so drop them
   explicitly:

   ```sql
   DROP FUNCTION private.public_observation_authorize_spore_mosaic(bigint, jsonb);
   DROP FUNCTION private.public_observation_authorize_spore_points(jsonb);
   DROP FUNCTION private.public_observation_spore_mosaic_raw(bigint, uuid);
   DROP FUNCTION private.public_observation_spore_points_raw(bigint);
   DROP FUNCTION private.public_observation_spore_point_rows(bigint[]);
   DROP FUNCTION private.public_observation_eligibility(bigint[]);
   ```

`CREATE OR REPLACE` keeps the existing owner and grants, and neither earlier
migration sets grants for these two functions. Steps 1–2 are exactly what
`supabase/tests/public_observation_spore_previews_identity_test.sh` applies
inside its rolled-back transaction. Run **before** R2, on the deployed state,
it shows that R2 changes no `get_public_observation` output for observations
whose points are in id order. It does not cover the rest: R2 removes the
explicit point order, so observations whose plan or row placement gives a
different order go back to that unspecified, plan-dependent order. That is
the owner-approved exception reversed, not a regression R2 introduces. Once
R2 is applied, the test compares the old bodies with themselves and proves
nothing.

R2 touches a public read surface and its visibility gates. It needs owner
approval and its own `sporely-security-reviewer` pass.

### Validating a compensation

Both options drop `get_public_observation_spore_previews`. The three batch
test files call it throughout, so after either option they **must** fail with
`function public.get_public_observation_spore_previews(bigint[]) does not
exist`. That failure is expected; any other failure is a regression.

**Locally, before committing the compensating migration:**

1. **R2 only, first: the output-identity proof, on the deployed state.**
   Check out the branch *without* the compensating migration, then run
   `supabase db reset --local` and
   `bash supabase/tests/public_observation_spore_previews_identity_test.sh`.
   It must print its pass line. Skip this step for R1.
2. **Apply the compensation.** Check out the branch that *holds* the
   compensating migration, and run `supabase db reset --local` again. Every
   later step runs on this compensated state. If step 1 ran, it left the
   database uncompensated, so this second reset is mandatory.

   Seed nothing until step 3 has finished; only step 4 seeds. The identity
   test in step 3 refuses to run
   on a database that has been seeded and then cleaned
   (`shuffle did not make ctid order differ from id order`).

   To confirm you are on the compensated state before going on, run
   `select to_regprocedure('public.get_public_observation_spore_previews(bigint[])')`.
   It must return NULL.
3. Run each SQL test that touches the public observation read surface, one
   file at a time. That is every file under `supabase/tests/` that names
   `get_public_observation` or `_get_public_observation_stage2a`. Do not rely
   on a whole-suite `supabase test db` run. Locally it lost its server
   connection partway through, and it reports the plain-SQL `NOTICE` tests as
   "No subtests run".

   The local evidence below used this per file:
   - `psql -U postgres -X -v ON_ERROR_STOP=1 < <file>`;
   - with `CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions`
     beforehand;
   - pass = exit 0 and no TAP `not ok` line.
   - **must pass:**
     - `metadata_only_microscope_images_test.sql`;
     - `microscope_capture_chronology_test.sql`;
     - `observation_time_of_day_privacy_test.sql`;
     - `owner_sync_metadata_parents_test.sql`;
     - `public_observation_prep_summary_test.sql`;
     - `public_observation_rpc_validation.sql`;
     - `sample_source_public_rpc_validation.sql`;
     - `spore_child_image_ownership_rls_test.sql`;
     - `stage2b_authorized_media_projections_test.sql`;
     - the identity test (`.sh`; for R1 it proves `get_public_observation`
       still matches its pre-`20261012100000` output for its fixtures, whose
       old order is id order; it does not cover the approved point-order
       exception; for R2 it is trivial);
   - **must fail with "does not exist" for the batch function, and nothing
     else:**
     - `public_observation_spore_previews_test.sql`;
     - `public_observation_spore_previews_order_test.sql`;
     - `public_observation_spore_previews_eval_count_test.sql`;
   - **already failing before this plan, not evidence either way:**
     `public_observation_point_prep_test.sql` ("image C point should have all
     prep keys stripped"). It fails identically on the deployed state, after
     R1 and after R2 (whose bodies are `main`'s before this plan).
4. Run the compensation check with the option applied:

       psql "<local db url>" -X -v ON_ERROR_STOP=1 -v mode=r1 -f supabase/batch-spore-preview-compensation-check.sql

   (`mode=r2` for R2.) Part A raises unless:
   - the batch function is gone;
   - the six helpers are present (R1) or absent (R2);
   - both public read functions reference the helpers (R1) or do not (R2);
   - both keep owner `postgres`, `SECURITY DEFINER`, `STABLE`,
     `search_path=public` and an explicit ACL with no PUBLIC entry;
   - `get_public_observation` is executable by `anon`, `authenticated` and
     `service_role`, and `_get_public_observation_stage2a` by none of them;
   - (R1) no helper is executable by a client role.

   Part B calls `get_public_observation` as `anon` and prints counts. To give
   it data locally, load `docs/perf/2026-10-batch-spore-preview/seed.sql`
   after step 3, and remove it with `cleanup.sql` afterwards. Run this step on
   the same compensated database as step 3, with no reset in between.

**In production:**

1. Before the compensation is deployed, run the same file with `mode=pre`.
   It asserts the deployed state and records the Part B counts.
2. Deploy the compensating migration through step 2.
3. Run it again with `mode=r1` or `mode=r2`. Part A must pass. In Part B,
   expect `caller = anon`, `uid_is_null = t`, `public_rows_with_points ≥ 1` and
   `nonpublic_rows = 0`. Every count should equal the `mode=pre` run, unless
   observations changed in between.
4. Record both runs' outputs; they are booleans and integers only.

Local evidence for this runbook (2026-10-11, synthetic fixtures, fresh reset
per state):
- Sequence for each state: a fresh `supabase db reset --local` of this
  branch, then R1 or R2 applied with `psql` to the local database, standing in
  for the compensating migration, then steps 3 and 4.
- R1 and R2 each applied cleanly.
- The read-surface test set gave exactly the results listed in step 3.
- The check passed for `pre`, `r1` and `r2`. Each wrong mode raised: for
  example `mode=r2` on R1 raised "6 private helpers present, expected 0".
- Part B printed `anon|t|30|20|20|20|20|30|0` in all three states.

## 5. Baseline `pg_stat_statements` window (read-only, aggregate-only)

    psql "<connection string>" -X -v ON_ERROR_STOP=1 -f supabase/batch-spore-preview-stats-probe.sql

It does not reset statistics. **Do not run `pg_stat_statements_reset()`**, in
any form, at any point in this runbook or the landing comparison.

### Output

- **Epoch row:** `taken_at`, `stats_reset`, `dealloc`, `track`,
  `max_entries`, `entries_now`.
- **One row per function and executing role:** `entries`, `calls`,
  `total_exec_ms`, `mean_exec_ms`, `max_exec_ms`, `rows`, `shared_blks_hit`
  and `shared_blks_read`. It covers four functions:
  - `get_public_observation`;
  - `media_authorize_delivery`;
  - `media_authorize_mosaic_delivery`;
  - `get_public_observation_spore_previews`.
- **Expected roles:**
  - `anon` and `authenticated` for the explorer's calls;
  - `service_role` (the Worker) for the two media functions, which only
    `service_role` may execute.
- **Expected for the batch function before the switch:** only the few step 3b
  calls, as `anon`. Statements from step 3a are excluded by their
  `/* bsp_probe */` marker.

### Why a single snapshot is not a baseline

The figures are cumulative since each entry was created, not since any
point the operator chooses. An entry can be evicted when the table is full and
later re-created. It then starts from zero, while the global `stats_reset`
stays the same. Comparing a snapshot taken after the switch with one taken
before it therefore mixes different, unknown measurement periods. That holds
for totals, for per-call means, and especially for `max_exec_ms`, which is
the maximum since the entry was created. Such a comparison cannot show the
effect of the switch.

### Baseline procedure: one bracketed window before the switch

1. After step 3, take snapshot **B0**.
2. Wait a fixed window. Use at least 24 hours, so it covers a daily traffic
   cycle, and keep the explorer's normal traffic: no load test. Take
   snapshot **B1**. The landing switch must not happen before B1.
3. The window B0→B1 is **valid** only if all of the following hold:
   - `stats_reset` is identical in B0 and B1;
   - `dealloc` is identical in B0 and B1. Any rise means that at least one
     entry was evicted somewhere in the window. It might have been one of
     these functions' entries, and the probe cannot tell which;
   - for every function and role row present in both snapshots, `calls`,
     `total_exec_ms`, `shared_blks_hit` and `shared_blks_read` did not
     decrease;
   - nobody ran `pg_stat_statements_reset` during the window. The operator
     confirms this; a targeted reset of one entry changes neither
     `stats_reset` nor `dealloc`.
4. For a valid window, record per function and role the deltas Δcalls,
   Δtotal_exec_ms, Δshared_blks_hit and Δshared_blks_read, plus the
   window's mean, Δtotal_exec_ms / Δcalls. A row that exists only in B1 counts
   from zero.
5. If the window is **invalid**, record it as *inconclusive*, with the failing
   condition, and do not use its figures. Take a new window from a fresh B0.
   To make eviction less likely:
   - use a shorter window, no shorter than one full day of explorer traffic;
   - or ask the owner to raise `pg_stat_statements.max`. That is a separate
     configuration change, which this runbook does not authorize.

   Do not combine figures from different windows.

`sporely-landing`'s Stage 2 human gate measures a window after the switch the
same way (A0→A1, same length, same validity rules) and compares its deltas
with B0→B1. If either window is invalid, the comparison is inconclusive and
is repeated. A cumulative figure is never evidence of a change.

### Caveats to record with the numbers

- `max_exec_ms` is the maximum since the entry was created, not within the
  window. Record it from B1 as context, but it is not window evidence.
- Statements cancelled with `57014` are not recorded. The true tail is longer
  than any figure here.
- With `track = top`, `media_authorize_mosaic_delivery` calls made **inside**
  the batch function are not counted. After the switch, its row reflects only
  the Worker's `/mm/` requests.
- Traffic differs between windows. Compare per-call means and the ratio of
  `get_public_observation` calls to `media_authorize_delivery` calls, not raw
  call totals alone.

## Record

Append a dated "Production deployment" section to this file in a new commit.
Include:
- the operator, UTC times, `<merged main SHA>` and the accepted candidate SHA;
- step 0 pass/fail for both git commands;
- the step 1 outcome;
- the `check` and `post-verify` outcomes;
- every step 3a output value;
- the H1–H5 statuses and counts;
- the step 5 B0 and B1 epoch rows and tables, the window's validity verdict
  (with the failing condition if inconclusive) and, if valid, its deltas.

Include no ids, keys or query text.

Then change `Status:` above to "executed <date>". That committed record is
the evidence that `sporely-landing`'s `explorer-cards-batch-preview` gate has
passed.

## Production deployment — 2026-10-12

Recorded 2026-10-13 from the owner's step 5 output and from the `check`
files the deploy helper left in the local deploy tree. No agent connected to
production. An entry marked **not recorded** has no evidence in the
repository; only the operator can supply it.

### Run

- Operator: **not recorded**.
- Deployed ref: `a427a6f436df6d944c9234f56e4fe46bd0b11e53`. The helper's
  `sporely-deploy-plan.json` in the deploy tree records it as `sha` and
  `ref`, with `allow` `20261012100000`, `deferred` `20260914090000` and
  project `zkpjklzfwzefhjluvhfw`. The operator confirms this was the
  `<merged main SHA>`.
- Accepted candidate SHAs: Stage 3 preparation `4c21355` (Agent Sparring
  READY). The migration's final security-reviewed form is `cf68f4a`.
- UTC times: `check` files written 2026-10-12 09:53. B0 at 10:50:00 already
  shows the migration's statements (see "Step 5"), so the push happened
  between those times. The exact push time is **not recorded**.

### Step 0

Reproduced by an agent on 2026-10-13 against `origin/main` `59c8ffb`. This is
not the operator's own run, which is **not recorded**:

- `git merge-base --is-ancestor a427a6f origin/main`: exit 0.
- Both migration hashes:
  `bd18677d8b0228b92f175a642fc8183af3647c9d8547035062b68eb6fe590956`.
- `supabase/deploy-exceptions.json` at `a427a6f` lists only `20260914090000`.
- Owner authorization for the deployment: **not recorded**.

### Steps 1 and 2

- Step 1 (`supabase migration list` from an ordinary checkout): **not
  recorded**.
- `check`: its saved `supabase migration list` shows one mismatch,
  `20261012100000` local-only, with latest Remote `20261011190000`. The
  deferred `20260914090000` is absent from the tree, as `prepare` intends.
  Its saved dry run would push exactly
  `20261012100000_add_public_observation_spore_previews.sql`. Whether it
  printed `All checks passed` is **not recorded**.
- `supabase db push --linked` outcome: **not recorded**. B0 shows that the
  migration ran (see "Step 5").
- `post-verify` on 2026-10-12: **not recorded**.
- `post-verify` re-run by the operator on 2026-10-13 (time not recorded),
  against the saved deploy tree of `a427a6f`: passed. It printed "Remote
  matches the deploy tree exactly; deferred migrations are still absent."
  So on 2026-10-13, Remote held every tree version, including
  `20261012100000`, held no version outside the tree, and did not hold
  `20260914090000`.
- Deploy tree removed on 2026-10-13, after the `post-verify` re-run, with the
  command it printed. The operator reported this, and the agent confirmed
  that the worktree is gone from `git worktree list` and from disk.

### Step 3

- 3a on 2026-10-12: **not recorded**.
- 3a re-run by the operator on 2026-10-13 (time not recorded) with
  `batch-spore-preview-live-probe.sql`, unchanged since `a427a6f`. It
  **passed**: every value matches the expected table, and the transaction
  ended in `ROLLBACK`. It ran after B1, so its statements are outside the
  B0→B1 window, and its `bsp_probe` marker keeps them out of the stats probe.

  | Output | Value |
  |---|---|
  | `security_definer`, `empty_search_path`, `result_shape` | `t`, `t`, `t` |
  | `anon_execute`, `authenticated_execute` | `t`, `t` |
  | `service_role_execute`, `public_execute`, `helper_executable_by_client` | `f`, `f`, `f` |
  | `private_helpers` | 6 |
  | `public_sample_stored`, `nonpublic_sample_stored`, `claims_cleared` | `t`, `t`, `t` |
  | `caller`, `uid_is_null` | `anon`, `t` |
  | `public_sample` | 30 |
  | `public_single_rows`, `public_batch_rows` | 30, 30 |
  | `public_batch_rows_with_points` | 30 |
  | `public_batch_points` | 1346 |
  | `public_batch_mosaics` | 30 |
  | `batch_mosaics_with_url` | 0 |
  | `public_mismatches` | 0 |
  | `mosaics_withheld` | 0 |
  | `nonpublic_sample` | 30 |
  | `nonpublic_single_rows`, `nonpublic_batch_rows` | 0, 0 |
- 3b, H1–H5 statuses and counts: **not recorded**.

### Step 5 — window B0→B1

Epoch rows:

| | `taken_at` (UTC) | `stats_reset` (UTC) | `dealloc` | `track` | `max_entries` | `entries_now` |
|---|---|---|---|---|---|---|
| B0 | 2026-10-12 10:50:00.081066 | 2026-06-17 13:38:01.755619 | 0 | top | 5000 | 4779 |
| B1 | 2026-10-13 11:08:35.166926 | 2026-06-17 13:38:01.755619 | 0 | top | 5000 | 4792 |

Window length: 24 h 18 min 35 s.

B0 table:

| fn | role | entries | calls | total_exec_ms | mean_exec_ms | max_exec_ms | rows | shared_blks_hit | shared_blks_read |
|---|---|---|---|---|---|---|---|---|---|
| get_public_observation | anon | 13 | 16293 | 2880311.5 | 176.8 | 2966.7 | 16291 | 19397937 | 246 |
| get_public_observation | authenticated | 2 | 6 | 458.6 | 76.4 | 128.4 | 6 | 5416 | 0 |
| get_public_observation | postgres | 42 | 107 | 2851.7 | 26.7 | 296.1 | 75 | 70696 | 7 |
| get_public_observation_spore_previews | anon | 1 | 5 | 625.6 | 125.1 | 504.2 | 5 | 7267 | 0 |
| get_public_observation_spore_previews | postgres | 5 | 5 | 24.0 | 4.8 | 8.5 | 0 | 128 | 3 |
| media_authorize_delivery | postgres | 5 | 5 | 1.3 | 0.3 | 0.9 | 0 | 85 | 0 |
| media_authorize_delivery | service_role | 1 | 39969 | 948704.3 | 23.7 | 2796.5 | 39969 | 3228989 | 5 |
| media_authorize_mosaic_delivery | postgres | 10 | 13 | 1211.1 | 93.2 | 1102.9 | 2 | 14590 | 0 |
| media_authorize_mosaic_delivery | service_role | 1 | 11718 | 264878.0 | 22.6 | 3439.1 | 11718 | 328534 | 0 |

B1 table:

| fn | role | entries | calls | total_exec_ms | mean_exec_ms | max_exec_ms | rows | shared_blks_hit | shared_blks_read |
|---|---|---|---|---|---|---|---|---|---|
| get_public_observation | anon | 13 | 16361 | 2893179.7 | 176.8 | 2966.7 | 16359 | 19500579 | 263 |
| get_public_observation | authenticated | 2 | 6 | 458.6 | 76.4 | 128.4 | 6 | 5416 | 0 |
| get_public_observation | postgres | 42 | 107 | 2851.7 | 26.7 | 296.1 | 75 | 70696 | 7 |
| get_public_observation_spore_previews | anon | 1 | 5 | 625.6 | 125.1 | 504.2 | 5 | 7267 | 0 |
| get_public_observation_spore_previews | postgres | 5 | 5 | 24.0 | 4.8 | 8.5 | 0 | 128 | 3 |
| media_authorize_delivery | postgres | 5 | 5 | 1.3 | 0.3 | 0.9 | 0 | 85 | 0 |
| media_authorize_delivery | service_role | 1 | 41486 | 1016802.8 | 24.5 | 2796.5 | 41486 | 3486868 | 6 |
| media_authorize_mosaic_delivery | postgres | 10 | 13 | 1211.1 | 93.2 | 1102.9 | 2 | 14590 | 0 |
| media_authorize_mosaic_delivery | service_role | 1 | 11776 | 265621.4 | 22.6 | 3439.1 | 11776 | 334278 | 0 |

Validity conditions (§5, step 3):

| Condition | Result |
|---|---|
| `stats_reset` identical | Pass: 2026-06-17 13:38:01.755619 in both. |
| `dealloc` identical | Pass: 0 in both. |
| No decrease in `calls`, `total_exec_ms`, `shared_blks_hit`, `shared_blks_read` for rows in both snapshots | Pass: the same nine rows are in both, with the same `entries`, and no counter decreased. |
| No `pg_stat_statements_reset` during the window | **Pending owner confirmation.** A targeted reset changes neither `stats_reset` nor `dealloc`, so the snapshots cannot show it. |

Procedure conditions (§5, steps 1–2), also for the operator:
- B0 was taken after step 3. 3a and 3b are not recorded, so this cannot be
  checked.
- The window had normal explorer traffic and no load test: **pending owner
  confirmation**.
- The landing switch did not happen before B1: **pending owner
  confirmation**. It is consistent with the batch function's anon Δcalls of 0.

Verdict: **not yet valid; pending owner confirmation** that no reset ran.
Until then, these deltas are not evidence.

Deltas (B1 − B0). The window mean is Δtotal_exec_ms / Δcalls. Each
`total_exec_ms` is rounded to 0.1 ms, so each Δtotal_exec_ms is exact to
±0.1 ms.

| fn | role | Δcalls | Δtotal_exec_ms | window mean ms | Δshared_blks_hit | Δshared_blks_read | Δrows |
|---|---|---|---|---|---|---|---|
| get_public_observation | anon | 68 | 12868.2 | 189.2 | 102642 | 17 | 68 |
| get_public_observation | authenticated | 0 | 0.0 | — | 0 | 0 | 0 |
| get_public_observation | postgres | 0 | 0.0 | — | 0 | 0 | 0 |
| get_public_observation_spore_previews | anon | 0 | 0.0 | — | 0 | 0 | 0 |
| get_public_observation_spore_previews | postgres | 0 | 0.0 | — | 0 | 0 | 0 |
| media_authorize_delivery | postgres | 0 | 0.0 | — | 0 | 0 | 0 |
| media_authorize_delivery | service_role | 1517 | 68098.5 | 44.9 | 257879 | 1 | 1517 |
| media_authorize_mosaic_delivery | postgres | 0 | 0.0 | — | 0 | 0 | 0 |
| media_authorize_mosaic_delivery | service_role | 58 | 743.4 | 12.8 | 5744 | 0 | 58 |

Derived, for the A0→A1 comparison:
- `get_public_observation` Δcalls (all roles) to `media_authorize_delivery`
  Δcalls: 68 : 1517, about 0.045.
- Shared buffers hit per call: `get_public_observation` anon about 1509;
  `media_authorize_delivery` about 170; `media_authorize_mosaic_delivery`
  about 99.

Caveats:
- `max_exec_ms` is from B1 and is not window evidence:
  `get_public_observation` anon 2966.7, `media_authorize_delivery`
  2796.5, `media_authorize_mosaic_delivery` 3439.1. None of these changed in
  the window.
- Calls cancelled with `57014`, or ending in any other error, are not
  recorded. The true tail is longer.
- 68 `get_public_observation` calls in 24 h is a small sample. Its window
  mean, 189.2 ms, is noisier than the media functions' means.
- The batch function's `postgres` row (5 entries, 5 calls, 0 rows) matches the
  migration's five statements that name it (`CREATE`, `ALTER … OWNER`,
  `REVOKE`, `GRANT`, `COMMENT`). That is consistent with the push, not proof
  of it. The `anon` row (1 entry, 5 calls) predates B0. Errored statements are
  not counted, so H5's expected `22023` would not appear. Five calls is more
  than the four successful H1–H4 calls, which is unexplained until 3b is
  recorded. Neither row is window evidence.

### Before the `sporely-landing` gate passes

1. The operator supplies or confirms the entries marked **not recorded**,
   and the owner confirms the pending window conditions.
2. If no reset ran, the window verdict becomes **valid**. Otherwise it is
   **inconclusive**, and a new B0→B1 is taken.
3. Change `Status:` above to "executed 2026-10-12", in a new commit.
