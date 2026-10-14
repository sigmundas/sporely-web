# Batch spore-preview RPC for the public explorer's Cards view

Status: approved 2026-10-10; Stages 1–3 accepted 2026-10-11; migration
`20261012100000` applied to production 2026-10-12; Stage 3 human gate passed
(see "Stage 3 outcome" below).
Repository: `sporely-web`. Suggested branch: `feature/batch-spore-preview-rpc`
from `main`.
Consumer: `sporely-landing`, `docs/plans/explorer-cards-batch-preview.md`.
That plan must not start until Stage 3 below has passed.
Origin: companion plan A in
`sporely-landing/docs/plans/public-explorer-performance.md`.

## Why

On a cold load, the public explorer's Cards view calls `get_public_observation`
once per spore-bearing card: about 23–28 calls, 6 at a time. Cards use only the
spore points and `sporeMosaic` from those calls. Under that fan-out,
production returned `57014` statement timeouts. One bounded batch call should
replace it.

## Fixed decisions

- **Media policy is unchanged:** `/m/` and `/mm/` keep
  `Cache-Control: no-store` and revoke access on the next request. This plan
  does not touch the Worker. A Worker-side R2 cache behind authorization stays
  a possible later optimization, out of scope here.
- **No automatic deployment.** A person applies the migration to production
  (Stage 3).
- **No live production connection** for implementation or review (see
  `.sparring/PROJECT.md`). Work against migrations, `schema.sql` and a local
  `supabase db reset`.

### Owner decisions 2026-10-11

- **Prerequisite on `main`.** The mosaic storage-key ownership fix (`0af1e32`,
  migration `20261011100000_enforce_mosaic_storage_key_ownership.sql`) is on
  `main` and deployed to production. This branch takes it in with
  `git merge --no-ff main`; no rebase, amend or force-push. Nothing that
  migration owns may be edited, weakened or re-created:
  - mosaic id `GENERATED ALWAYS`;
  - the `trg_00`/`trg_01`/`trg_zz` mosaic guards;
  - `media_authorize_mosaic_delivery` and its `invalid_storage_namespace`
    check;
  - `supabase/tests/mosaic_storage_key_ownership_test.sql`.

  The batch migration keeps version `20261012100000`.
- **Fail-closed batch mosaic.** The batch RPC never exposes a raw mosaic
  storage URL or key: the legacy `spore_mosaic.url` is omitted, and the
  authorized Worker `mosaicMediaUrl` is used instead. A mosaic that is
  malformed or rejected by the delivery authorizer produces no usable
  reference, neither a raw key or url nor a `mosaicMediaUrl`. Rejection
  covers a non-positive id, a bad bucket, a namespace-invalid key, an owner
  mismatch, and a missing Worker config. This is proved with pgTAP fixtures
  inserted as a trusted role.
- **Existing API unchanged.** `get_public_observation` keeps its legacy `url`
  for now; removing it is a separate, reviewed follow-up. Its output stays
  byte-identical (identity test). Batch/single parity compares everything
  except `url`, and `SUPABASE_DB.md` documents the difference.
  *Amended by the owner on 2026-10-11, during Stage 2 (below).*
- **Point-order exception (owner decision 2026-10-11, Stage 2).**
  `get_public_observation`'s `sporePoints` are now ordered by image id, then
  measurement id, the same order the batch uses. This is an explicit
  exception to the unchanged-output requirement, limited to the order of
  `sporePoints`. The previous SQL order was unspecified and depended on the
  plan and on physical row placement. Output is therefore not universally
  byte-identical; the identity test proves it only where the old order was
  id order. Everything else stays: fields, values, signatures, grants, visibility
  gates and media behaviour (including the legacy `url`). The batch still
  omits the raw mosaic `url` and fails closed. Consequences, documented in
  `SUPABASE_DB.md`:
  - Landing Cards can show a different first 16 points for affected
    observations.
  - A single `get_public_observation` call costs 3–12 % more execution time
    and about 4 % more buffers locally.

  The order regression test (`public_observation_spore_previews_order_test.sql`,
  four plan shapes, rows moved by updates) stays.
  The owner's approval and a fresh `sporely-security-reviewer` APPROVE on
  `22f7b60` were the Stage 2 gate evidence. The documentation follow-up after
  acceptance gets its own security verdict on the final SHA.
- **Stage 2 must also:**
  - run case (b) at concurrency 2 as well as 6, per `sporely-landing`
    `docs/perf/2026-10-11-rpc-timeout-incident.md` §"Local only: whether
    concurrency matters";
  - report RPC request counts, total query cost, batch execution time and
    EXPLAIN plans;
  - state explicitly how close the 60-id batch gets to the anon role's 3 s
    statement timeout. Fewer requests is not a pass if the single batch is
    too slow.

  `OBSERVATION_DETAIL_CONCURRENCY` stays unchanged, and there are no
  production load tests.
- **Stage 3's runbook** must use the repository's deploy-tree path:
  `node scripts/supabase-deploy-tree.mjs prepare --allow 20261012100000 ...`,
  then check and post-verify. `supabase/deploy-exceptions.json` still lists
  the deferred `20260914090000`. No agent executes production migrations.

## Stage 1 — Batch preview function, contract and pgTAP tests

First read the sections above the stages in `docs/plans/active/2026-10-10-batch-spore-preview-rpc.md`. Their decisions and constraints apply to this stage.

1. **Contract.** Add a new anon-executable function. Name it in the contract,
   for example `get_public_observation_spore_previews(p_observation_ids bigint[])`.
   - **Input:** at most 60 ids. Reject more with a clear error. Null or empty
     input returns no rows. Duplicate ids are tolerated.
   - **Output:** one row per *eligible* observation, with `observation_id`, the
     minimal `points` and `spore_mosaic`. Ineligible and nonexistent ids are
     both simply absent, so they cannot be told apart.
   - **`points` fields:** exactly what the landing card path reads. Derive
     them from `sporely-landing/src/lib/publicApi.ts` (`normalizeSporePoints`
     `:473`, `normalizeSporeMosaic` `:518`), `ObservationCard.tsx` (point id,
     mosaic crop geometry, `cropUrl`) and `sporePointFilters.ts` (contrast,
     mount, sample type and source). Each value and the order of points must
     equal what `get_public_observation` returns for that observation.
   - **No server-side capping or filtering of points.** Client filtering and
     the 16-point selection stay on the client.
   - Record the contract in `SUPABASE_DB.md` (or the repo's public-API
     contract doc).
2. **Eligibility.** Reuse the eligibility predicate of
   `_get_public_observation_stage2a` rather than copying it. It covers:
   public; not draft or deleted; owner not banned; blocking; moderation;
   `spore_data_visibility`; image and measurement gates; and
   `metadata_microscope_parent_is_public`.
   - If reuse means extracting the predicate into a helper,
     `get_public_observation`'s output must stay byte-identical. Prove that
     with a test.
   - Media URLs come from the same `build_worker_media_url` path as today.
3. **Security shape.** Set `search_path=''` and qualify every name. Revoke
   execute from PUBLIC, then grant it to `anon` and `authenticated`. Use
   SECURITY DEFINER only if the existing public reads use it, with the same
   justification.
4. **pgTAP tests** under `supabase/tests/`, run with a local `supabase db reset`
   plus the test runner:
   - a visibility matrix: private, friends-only, draft, deleted, moderated,
     banned owner, blocked viewer (authenticated), each `spore_data_visibility`
     value, missing image or measurement gates, and a non-public microscope
     parent. Each yields no row, or no points, exactly as
     `get_public_observation` does;
   - parity: for eligible fixtures, `points` and `spore_mosaic` equal the
     corresponding parts of `get_public_observation`;
   - bounds: null, empty, duplicates, and 61 ids;
   - grants and `search_path`.
5. Write one new migration, using a timestamp after the latest one. Do not
   edit applied migrations, do not repair migration history, and do not use
   MCP `apply_migration`.

Human gate before READY: the person runs `sporely-security-reviewer` on the
candidate SHA and supplies its verdict as evidence. This stage touches a
public RPC and visibility gates.

## Stage 2 — Prove reduced database work and latency

First read the sections above the stages in `docs/plans/active/2026-10-10-batch-spore-preview-rpc.md`. Their decisions and constraints apply to this stage.

Local only. Seed the local database with synthetic public fixtures (no real
personal data): at least 30 spore-bearing observations with realistic point
counts, plus ineligible decoys.

For the 30 ids, compare:
- (a) one batch call;
- (b) the 30 single `get_public_observation` calls the Cards view makes today.

Report:
- `EXPLAIN (ANALYZE, BUFFERS)` for (a), and summed over (b): execution and
  planning time, and shared buffers hit and read;
- wall-clock time through local PostgREST: (a), and (b) at concurrency 6, over
  at least 10 repetitions (median and maximum);
- per-point work such as `build_worker_media_url`, if it dominates either
  plan;
- the same measurements at 60 ids.

Write the results to `docs/perf/2026-10-batch-spore-preview.md`, with the
exact commands and raw output.

Pass:
- (a) does less total database work (time and buffers) than (b), and its
  wall-clock time is lower;
- (a) at 60 ids stays well under the 3-second anonymous statement timeout;
- an explanation if a gain is small.

No threshold is fixed in advance. The reviewer judges whether the evidence
proves less work, not just fewer HTTP requests.

## Stage 3 — Production migration gate

First read the sections above the stages in `docs/plans/active/2026-10-10-batch-spore-preview-rpc.md`. Their decisions and constraints apply to this stage.

The agent prepares, without running it:
- a runbook: `supabase/batch-spore-preview-runbook.md`;
- probe SQL that returns only aggregate, non-personal results.

The runbook covers:
1. checking that local and remote `supabase migration list` agree, and stopping
   if they don't;
2. applying the migration via the repository's supported path;
3. confirming the function is live with anonymous calls: a known public
   spore-bearing observation returns its row, and a known non-public one
   returns none;
4. the rollback or compensating migration;
5. a baseline snapshot of aggregate `pg_stat_statements` figures for
   `get_public_observation` and the two media authorization functions, taken
   before the landing switch.

Human gate: a person performs steps 1–5 and records the evidence. Only then
may `sporely-landing`'s `explorer-cards-batch-preview` plan start. Nothing is
deployed automatically.


## Migration reconciliation handoff — 2026-10-12

Owner-returned production provenance report: 69 PASS, 1 INFO, 1 UNVERIFIED.
All six database-health function catalog definitions and security attributes
match `9b2287a`. Original deployment-file byte identity and deployment author
remain unverified. Evidence: `supabase/verification/20261011190000_owner_results.csv`.

Uncommitted candidate in `feature/migration-history-reconciliation`, based on
main `10ff4d2`: exact health migration/tests copied from `9b2287a`; unapplied
batch file renamed to `20261012100000`, byte-for-byte unchanged (SHA-256
`bd18677d8b0228b92f175a642fc8183af3647c9d8547035062b68eb6fe590956`).
Current deployment instructions and executable references updated. Historical
Sparring acceptance, completed plans and recorded performance/mosaic deployment
reports preserved. Deferred `20260914090000` registry and file untouched.

Clean local reset completed the full reconciled sequence. Final verification:
batch61/61, order11/11, evaluation9/9, mosaic security38/38; identity42 visible
rows PASS; health and three ordinary SQL assertion suites PASS; deployment
guard19/19 PASS. Initial12failures reproduced under wrong supabase_admin fixture
role, not documentedpostgres; old identity-order failure disappears after reset.
No migration/test logic changes required. Exact assertions, commands,
classification and immutable hashes: `supabase/verification/reconciliation-regression-report.md`.

Fresh independent specialist security review: APPROVE, no security findings.
Separate top-level sporely-security-reviewer/Sparring gate remains pending. Candidate not approved for merge;
no main push/merge, no production access. Original deployment-file byte identity
remains unverified despite accepted catalog equivalence. Historical Sparring
acceptance records and unrelated worktrees/files remain unchanged.

## Stage 3 outcome — recorded 2026-10-14

The authoritative record is the "Production deployment — 2026-10-12" section of
`supabase/batch-spore-preview-runbook.md` (commits `1d07d3c`…`d54eea0`). This
entry only summarises it; it adds no new production evidence.

- Agent Sparring run `2026-10-10-batch-spore-preview-r-22db4bec-0a07a15e`:
  Stages 1–3 accepted; Stage 3 candidate `4c21355` READY. The run is complete.
- The reconciliation candidate above was later merged as `a427a6f`, and that
  ref is what the owner deployed. Its "not approved for merge" line describes
  the state on 2026-10-12 before that merge.
- Migration `20261012100000` authorized and applied by the owner on
  2026-10-12. On 2026-10-13 `post-verify`, 3a and 3b re-runs passed; a further
  3b re-run on 2026-10-14 passed.
- Step 5 window B0 (2026-10-12 10:50:00 UTC) → B1 (2026-10-13 11:08:35 UTC):
  `stats_reset`, `dealloc` (0), `track` (top) and `max_entries` (5000)
  unchanged; `entries_now` 4779 → 4792. Verdict **valid**, resting on the
  owner's statement that no `pg_stat_statements_reset` (global or targeted)
  was run. A targeted reset of a low-call `get_public_observation` / `anon`
  entry cannot be excluded from counters alone.
- Window deltas used as the landing baseline:

  | Function / role | Δcalls | Δexec ms | Δblks hit | Δblks read |
  |---|---:|---:|---:|---:|
  | `get_public_observation` / anon | 68 | 12868.2 | 102642 | 17 |
  | `get_public_observation_spore_previews` / anon | 0 | 0 | 0 | 0 |
  | `media_authorize_delivery` / service_role | 1517 | 68098.5 | 257879 | 1 |
  | `media_authorize_mosaic_delivery` / service_role | 58 | 743.4 | 5744 | 0 |

  All other function/role counters were unchanged.

`sporely-landing`'s `explorer-cards-batch-preview` plan may start. Its own
gates still apply: Stage 1 re-checks the deployed function; the landing A0
snapshot must be taken after the latest 3b run (2026-10-14) and before the Cards
switch; Stage 2 needs the owner's screenshot comparison and a post-switch
aggregate window compared with B0→B1.
