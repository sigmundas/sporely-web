# `search_public_observations` performance: page first, enrich after

Status: draft, amended after owner review on 2026-10-13. The owner approved
preparing and reviewing this revision only. Not approved to run:
- no stage may start;
- there is no production access, statistics collection or profiling without
  the explicit gates below.
Repository: `sporely-web`. Suggested branch:
`feature/search-public-observations-performance` from `main`.
Bug report: `sporely-landing`
`docs/perf/2026-10-13-explorer-page2-search-timeout.md`, on branch
`docs/explorer-page2-search-timeout` (`196c271`).

This plan is independent of `sporely-landing`'s explorer-cold-load
integration and of the batch spore-preview plans, for planning,
implementation and deployment alike. It changes no landing code.

## Why

On 2026-10-13 at about 13:36 UTC, the public Explorer's Cards page 2 failed
with Microscopy on. `search_public_observations` returned HTTP 500 after
`57014` (the anon role's `statement_timeout` is `3s`). The 2026-10 baseline in
`sporely-landing` (`docs/perf/baseline-2026-10.md`) had already recorded two
search timeouts and a maximum of 2,663 ms.

The latest definition is in
`supabase/migrations/20260925120000_owner_sync_metadata_parents.sql:752-974`.
It is a `LANGUAGE sql STABLE SECURITY DEFINER` function. For every public
candidate it computes:
- two `LEFT JOIN LATERAL` subqueries: the latest microscope image, and the
  spore-measurement count (`:844-896`);
- per-row `metadata_microscope_parent_is_public` and
  `community_contributor_label` calls.

Only after all that does it apply the microscopy and spore filters, sort by
`(observed_on DESC, id DESC)` and apply `LIMIT/OFFSET` (`:936-973`). The
expensive work therefore likely scales with every public observation, not
with the page. That is unverified on production data; Stage 1b measures it.

The batch spore-preview RPC does not change this query.

## Fixed decisions

- **Behaviour is preserved exactly.**
  - the function's name, signature, argument defaults, `RETURNS TABLE`
    shape, column names, types and values;
  - `SECURITY DEFINER`, `SET search_path`, owner and grants;
  - every public/private visibility gate the function applies today:
    - `visibility = 'public'` and not a draft;
    - no banned owner;
    - `spore_data_visibility` for spore data;
    - images not deleted or purged;
    - metadata-parent publication (`metadata_microscope_parent_is_public`);
    - public measurement types (`is_public_microscopy_measurement_type`);
  - the microscopy and spores filters, with all three values meaning what
    they mean today:
    - `NULL`: no filter;
    - `true`: only observations with public microscopy, or with spore
      measurements (`spore_measurement_count > 0`);
    - `false`: only observations **without** them.

    Phase 1 must mirror both the `true` and `false` cases exactly. `false`
    needs a `NOT EXISTS` that is the exact negation of the `true`
    predicate.
  - the context, sample and observer filters, with their current
    semantics. `p_observer` is an `ILIKE` substring match against
    `community_contributor_label`, so phase 1 must compute that label for
    candidates whenever `p_observer` is set;
  - ordering `(observed_on DESC, id DESC)`, the `p_limit` clamp `1..100`,
    `p_offset ≥ 0`, and page contents for every offset.

  Any intended difference needs an explicit owner decision recorded in this
  plan.
- **No production changes without explicit owner approval.** Specifically:
  - agents never connect to production;
  - nobody enables `auto_explain`, alters database or role settings, runs
    load tests, or changes production SQL;
  - anything beyond the one read-only aggregate probe run at the Stage 1a gate needs its own
    owner approval.
- **No indexes are decided in advance.** An index is added only if the
  Stage 1b evidence and a Stage 2 measurement show it is used and needed. Its
  write and storage cost must be recorded.
- **Security review.** The function is a public `SECURITY DEFINER` RPC, so
  the Stage 2 candidate needs a `sporely-security-reviewer` APPROVE on its
  exact SHA before acceptance, in addition to the normal review.
- **Repository deploy path only:** `scripts/supabase-deploy-tree.mjs`
  (`prepare`, `check`, `post-verify`). No direct DDL in the SQL editor, no
  MCP `apply_migration`, no `migration repair`.
- Stage 1b reuses the local perf harness in
  `docs/perf/2026-10-batch-spore-preview/` (`seed.sql`, `plans.sql`,
  `parity.sql`, `bench-db.mjs`, `cleanup.sql`) and its synthetic-data rules.

## Stage 1a — Prepare the production statistics probe

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

No production access, function or schema change. Output: the probe file.

1. **Probe.** Prepare `supabase/search-public-observations-stats-probe.sql`:
   one
   `READ ONLY` transaction, `SET LOCAL statement_timeout = '15s'`, ending in
   `ROLLBACK`. It prints aggregates only: no ids, query text or personal
   data. It reads:
   - `pg_stat_statements` for `search_public_observations` per role: calls,
     total, mean, max and stddev time, rows, `shared_blks_hit`/`read` and
     `temp_blks_written`, plus the `pg_stat_statements_info` epoch row. Use
     the same tagging and exclusions as
     `supabase/batch-spore-preview-stats-probe.sql`. It never resets
     anything.
   - Counts, each as one integer:
     - public non-draft observations;
     - those with a microscope image that passes the search's gate;
     - those with spore measurements;
     - microscope images with `storage_path IS NULL` (metadata parents);
     - all spore measurements;
     - observations per owner, as a p50/p95/max distribution only.
   - `pg_stat_user_tables` for `observations`, `observation_images` and
     `spore_measurements`: `n_live_tup`, `n_dead_tup`, last (auto)analyze
     and last (auto)vacuum.
   - Index definitions and `pg_stat_user_indexes` (`idx_scan`, size) for
     those tables.
   - A SHA-256 of `pg_get_functiondef` for `search_public_observations`,
     compared with the function as defined at `main`.

2. **Local validation.** Run the probe against the local database only.
   Show that it:
   - completes inside the transaction and ends in `ROLLBACK`;
   - writes nothing;
   - prints only the aggregate columns listed above.

   Record the output columns and a sample local run in the probe's header
   comment.

Pass: the probe is reviewed, validated locally, and contains no `SET`
beyond `SET LOCAL statement_timeout` and `search_path`. It contains no
DDL, no write, no reset and no `auto_explain`.

Human gate (production statistics collection):
- The owner decides whether and when to run the probe once against
  production, as a read-only aggregate collection, and returns its output.
- This gate is the only authorization for that one run. Every further
  production statistics collection or profiling needs its own explicit
  owner approval.
- Stage 1b does not start until the output is returned.

## Stage 1b — Local evidence

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

Inputs: the production probe output the owner returned at the Stage 1a gate,
committed by the agent as the first section of
`docs/perf/2026-10-search-public-observations.md`. No production access.
The output is that evidence doc plus a seed script.

1. **Realistic local data.** Add `docs/perf/2026-10-search-public-observations/seed.sql`.
   - It is deterministic and synthetic, in the style of the batch harness.
     It is scaled to the probe output's counts and shares, rounded up so the data
     covers expected growth.
   - It includes ineligible decoys for every visibility gate, metadata
     parents (public and unpublished), and deleted or purged images.
   - It ends with `ANALYZE`, and has a matching `cleanup.sql`.

   Local database only. No production data is copied.
2. **Local plans.** Measure the current function on that data, locally and
   as `anon`.
   - Use local `auto_explain` (`log_analyze`, `log_buffers`,
     `log_nested_statements`) or the body's statement prepared under both
     `plan_cache_mode` settings, since a SQL function is planned
     generically.
   - Scenarios:
     - the default request: Microscopy `true`, `p_limit` 31, `p_offset` 0,
       30, 60 and 300;
     - every combination of `p_has_microscopy` and `p_has_spores` in
       {`NULL`, `true`, `false`}, at offsets 0 and 30;
     - genus or species text, including the taxon-free fallback the landing
       sends;
     - a date range;
     - an observer substring;
     - Table's page size of 51.

   Record per-node time and buffers. Show whether the cost scales with the
   total number of public observations or with the offset.

   **Count helper calls** to `metadata_microscope_parent_is_public` and
   `community_contributor_label`:
   - Both are `LANGUAGE sql STABLE SECURITY DEFINER` (migrations
     `20260925120000` and `20260521120000`). PostgreSQL never inlines a
     `SECURITY DEFINER` function, so each call is a real function call.
   - Count them as `docs/perf/2026-10-batch-spore-preview/function-calls.sql`
     does: a fresh `\connect` per case, `SET LOCAL track_functions = 'all'`,
     the call as `anon`, then read `pg_stat_xact_user_functions` before
     `ROLLBACK`. Local database only.
   - **Check the counter first.** On a small fixture with a known number of
     candidates, the count for `community_contributor_label` must equal that
     number, and the count for `metadata_microscope_parent_is_public` must
     equal the number of metadata-parent rows the plan reaches. If either
     differs, or any measured helper is not `SECURITY DEFINER` and could be
     inlined, report that helper's count as unavailable. Use the `EXPLAIN`
     row estimates for it instead, labelled as such.
3. **Report.** In the evidence doc, cover:
   - where the time goes;
   - how cost grows with data size (run the seed at 1×, 2× and 4× the
     production counts);
   - which existing indexes are used or ignored;
   - how close each scenario is to `3s`;
   - whether the local plans plausibly match production, based on the probe's
     statistics.

   Also list what only a production plan could settle.

4. **Proposed thresholds.** From the measurements, propose measurable
   pass thresholds for Stage 3. They must be checkable numbers, for
   example:
   - p95 and maximum execution time per scenario at 1× and 4× scale;
   - shared buffers per call;
   - an upper bound on how much the default request's cost may grow from
     1× to 4× (cost bounded by the page, not by the total);
   - helper-function calls per call.

   Each threshold leaves a stated margin under the anon `3s` timeout.

Human gate: the owner reviews the evidence. Three decisions come before
Stage 2:
- the Stage 3 pass thresholds, fixed as numbers and recorded in this plan's
  notes. Stage 3 cannot pass without them;
- whether a production plan capture is needed. It is a separate, explicit
  owner approval, run by the owner, and it is bounded as follows:
  - **Allowed operation.** One owner session, inside one transaction:
    - `LOAD 'auto_explain'`;
    - `SET LOCAL` of `auto_explain.log_min_duration = 0`,
      `log_analyze = on`, `log_buffers = on`,
      `log_nested_statements = on` and `log_format = text`, plus
      `SET LOCAL ROLE anon` and `SET LOCAL statement_timeout = '15s'`;
    - at most four calls (`p_has_microscopy` `true` at offsets 0 and 30,
      and `false` at offset 0, plus the default page 1 if it differs);
    - then `ROLLBACK`.

    No `ALTER SYSTEM`, `ALTER ROLE`, `ALTER DATABASE`, extension change or
    configuration change. Session-scoped `SET LOCAL` values end with the
    transaction.
  - **Requires.** The `postgres` role may `LOAD` the module, and the
    resulting plans are readable from the Supabase Postgres logs for that
    session. The capture prepared in Stage 1b states both checks in its
    instructions.
  - **Output.** The plan text of the nested statements for each call:
    node types, timings, buffers and row counts. Parameter values are only
    limit, offset and booleans. The owner removes anything else before
    returning it.
  - **Stop condition.** If `LOAD` is refused, or the nested plans don't
    appear in the logs, the capture is recorded as unavailable. Nothing else
    is tried without a new approval.
  - If the owner chooses a capture, Stage 2 does not start until the owner
    has returned its output.
  - Stage 2's first step then adds it to the evidence doc, and records any
    change it makes to the Stage 1b conclusions, before any query design.
- which index candidates, if any, Stage 2 may evaluate.

## Stage 2 — Two-phase query candidate

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

One new migration, `CREATE OR REPLACE FUNCTION` with the same signature.
Nothing is deployed.

1. **Phase 1, the page ids.** Select the ids of the eligible observations:
   - Apply the cheap visibility gates and the filters.
   - For microscopy and spores, use `EXISTS` predicates that mirror the
     current lateral eligibility exactly: image type, deleted or purged
     state, and `storage_path IS NOT NULL OR
     metadata_microscope_parent_is_public(id)` for microscopy; the visible
     measurement types for spores.
   - Order by `(observed_on DESC, id DESC)`, apply the clamped
     `LIMIT/OFFSET`, and fence it (`MATERIALIZED` CTE or `OFFSET 0`) so the
     enrichment cannot be pushed below it.
2. **Phase 2, enrichment.** For those at most 100 ids only, compute the
   latest image, the spore statistics and summary, the observer label and
   the prep/stain fields. Output order equals phase 1's order.
3. **Indexes.** Add only the candidates the Stage 1b gate allowed. For each,
   show the plan uses it and record its size and write cost. Otherwise add
   none.
4. **Equivalence.**
   - Keep the old definition as a test-only reference function in the test
     transaction, never in production.
   - A pgTAP test (`supabase/tests/search_public_observations_two_phase_test.sql`)
     compares the old and new output row by row, order included. It runs
     over a fixture matrix covering every gate and filter, and over the
     Stage 1b seed. It uses every argument combination the landing sends, and
     every combination of `p_has_microscopy` and `p_has_spores` in {`NULL`,
     `true`, `false`}. It covers offsets 0, 30, 60, past the end, negative
     and `NULL`, and limits 0, 1, 31, 51, 100 and 1000.
   - For each fixture, the `true` and `false` results for a filter
     partition the `NULL` result: disjoint, and their union equals it.
   - The existing `public_observation_rpc_validation.sql`,
     `sample_source_public_rpc_validation.sql`,
     `observation_time_of_day_privacy_test.sql`,
     `owner_sync_metadata_parents_test.sql` and
     `microscope_capture_chronology_test.sql` pass unchanged.
5. **Grants and attributes.**
   - Catalog assertions that `SECURITY DEFINER`, `search_path`, owner,
     `anon`/`authenticated` execute and no `PUBLIC` execute are unchanged.
   - Assertions that no new helper is executable by client roles.
6. **`SUPABASE_DB.md`.** Describe the two phases, and state that the
   contract is unchanged.

Pass: equivalence over every case, all named suites green, catalog
assertions green, and local `supabase db reset` clean. A
`sporely-security-reviewer` APPROVE on the candidate SHA, then the normal
review.

## Stage 3 — Measure the candidate

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

Docs only. On the Stage 1b seed at 1×, 2× and 4× scale, compare the old and
new function for every Stage 1b scenario:
- time (median and p95 over repeated runs);
- buffers;
- helper-function call counts.

Also measure the cost with page 1's concurrent load present, using the batch
harness's `bench-db.mjs` style with bounded local concurrency. Record:
- the margin under `3s` at each scale;
- whether the cost is now bounded by the page rather than the total number
  of public observations;
- each added index's write and storage cost.

Output: an appended section in `docs/perf/2026-10-search-public-observations.md`.

Pass: every threshold fixed at the Stage 1b gate is met, for every scenario
(all `true`/`false`/`NULL` filter combinations included) at the scales the
gate named. A missed threshold fails the stage.

Changing thresholds:
- A failed Stage 3 is never accepted afterwards.
- The owner may revise thresholds only as a recorded plan decision, with
  the reason, before a fresh Stage 3 run.
- That fresh run measures again against the revised numbers and goes
  through review and acceptance as normal.
- A revision cannot change the result of a run that has already finished.

## Stage 4 — Production migration gate

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

The agent prepares, without running it, `supabase/search-public-observations-runbook.md`.
Model it on `supabase/batch-spore-preview-runbook.md`:
- **Gate:** Stages 1–3 accepted, the security APPROVE, and the branch merged
  to `main`. The migration's hash is pinned.
- `supabase migration list` agreement, with the documented deferred
  migration.
- The deploy-tree `prepare` / `check` / push / `post-verify`.
- **Read-only live checks.** These create, alter and write nothing in
  production. Old/new equivalence is proved locally in Stage 2, never in
  production.
  - **Catalog.** In a `READ ONLY` transaction:
    - the function's SHA-256 (`pg_get_functiondef`) equals the migration's
      expected hash;
    - `prosecdef`, `proconfig` (`search_path`), owner and `proacl` are as
      before;
    - any added index exists and is valid.
  - **Output stability.** One read-only, aggregate-only probe, run twice:
    immediately before the push, and immediately after `post-verify`.
    - In a `READ ONLY` transaction with `SET LOCAL ROLE anon`, it calls the
      deployed `search_public_observations` for a fixed, bounded list of
      argument shapes. The list includes every `p_has_microscopy` ×
      `p_has_spores` combination at offsets 0 and 30, and the default
      page 1 and page 2. The calls run one at a time, about 20 in total;
      this is not a load test.
    - For each shape it prints only the row count, an MD5 of the ordered id
      list (a hash, never the ids), the `hasMicroscopy` true/false counts
      and the sum of `sporeMeasurementCount`.
    - **Input fingerprint.** It also prints a fingerprint of every input
      the function reads. For `observations`, `observation_images`,
      `spore_measurements`, and the profile and moderation rows the gates
      and the contributor label read, it prints the row count and an MD5
      of `id || ':' || xmin`, ordered by `id`. Any insert, update or
      delete changes it, with no statistics-collector lag. It prints
      hashes only.
    - **Decision**, before against after:
      - Inputs and outputs identical: pass.
      - Inputs identical, outputs different: the new function changed
        results. STOP and roll back.
      - Inputs different: the old/new comparison is **inconclusive**,
        whatever the outputs show. A later pair cannot settle it, because
        after the push both runs use the new function. The runbook then
        relies on the invariant checks below, and passes only if they all
        hold and the owner records the decision. Otherwise, roll back.
  - **Invariant checks.** These run after the push, in the same read-only,
    aggregate-only form, and need no old function. They print counts of
    violations, never ids:
    - for each filter, the `true` and `false` results partition the `NULL`
      result;
    - page 1 followed by page 2 equals the first 2 × page-size rows at
      offset 0;
    - ordering is strictly `(observedOn DESC, id DESC)`;
    - every returned row passes the visibility gates when re-checked
      directly against the tables;
    - `hasMicroscopy` and `sporeMeasurementCount` agree with the filter
      that was used.
  - **PostgREST.** Anonymous calls for the default page 1 and page 2, and
    for `p_has_microscopy` `true` and `false`. Record only HTTP status and
    row counts.
- **Rollback.** A compensating migration that restores the previous
  definition and drops any added index, with its own local validation.
- **Statistics windows.** A bracketed `pg_stat_statements` window before the
  change and one after it, both for `search_public_observations`, under the
  same validity rules as the batch runbook §5. No resets. The windows are
  compared only when both are valid.

Pass (preparation; the agent does all of this locally):
- The runbook covers every item above, in order. Every command is copied
  exactly, with placeholders only for connection strings and SHAs fixed at
  merge time.
- **Probes validated locally:** the catalog, output-stability and invariant
  probes, run on a local database before and after a local apply of the
  migration.
  - Each ends in `ROLLBACK`, writes nothing and prints aggregates only.
  - The output-stability probe reports "identical" for the equivalent
    function.
  - A deliberately altered local copy of the function (a mutation test,
    local only) makes it report "inputs identical, outputs different".
  - A local write between the two runs makes it report "inconclusive".
  - The invariant probe reports zero violations for the candidate, and
    detects a mutation that breaks ordering.
- **Hashes pinned:** the migration file's SHA-256, and the expected
  `pg_get_functiondef` SHA-256 from a local `supabase db reset`, recorded
  in the runbook.
- **Compensation validated locally:** apply, compensate, then show that the
  function's `pg_get_functiondef` hash equals the pre-migration hash, that
  every added index is gone, and that the Stage 2 suites pass.
- The runbook is reviewed through the normal stage review.

Human gate: a person with explicit owner approval runs the runbook and
commits the record. Nothing is deployed automatically.
