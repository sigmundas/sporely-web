# `search_public_observations` performance: page first, enrich after

Status: draft for owner review, 2026-10-13. Not started.
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
with the page. That is unverified on production data; Stage 1 measures it.

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
  - the microscopy, spore, context, sample and observer filters, with their
    current semantics. `p_observer` is an `ILIKE` substring match against
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
  - anything beyond the read-only aggregate probe in Stage 1 needs its own
    owner approval.
- **No indexes are decided in advance.** An index is added only if the
  Stage 1 evidence and a Stage 2 measurement show it is used and needed. Its
  write and storage cost must be recorded.
- **Security review.** The function is a public `SECURITY DEFINER` RPC, so
  the Stage 2 candidate needs a `sporely-security-reviewer` APPROVE on its
  exact SHA before acceptance, in addition to the normal review.
- **Repository deploy path only:** `scripts/supabase-deploy-tree.mjs`
  (`prepare`, `check`, `post-verify`). No direct DDL in the SQL editor, no
  MCP `apply_migration`, no `migration repair`.
- Stage 1 reuses the local perf harness in
  `docs/perf/2026-10-batch-spore-preview/` (`seed.sql`, `plans.sql`,
  `parity.sql`, `bench-db.mjs`, `cleanup.sql`) and its synthetic-data rules.

## Stage 1 — Evidence

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

No function or schema change. The output is
`docs/perf/2026-10-search-public-observations.md` plus a probe and a seed
script.

1. **Production aggregates.** The owner runs a read-only probe once. Prepare
   it as `supabase/search-public-observations-stats-probe.sql`: one
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

   The owner returns the output. The agent records it in the evidence doc.
   Running it does not authorize any further production step.
2. **Realistic local data.** Add `docs/perf/2026-10-search-public-observations/seed.sql`.
   - It is deterministic and synthetic, in the style of the batch harness.
     It is scaled to Step 1's counts and shares, rounded up so the data
     covers expected growth.
   - It includes ineligible decoys for every visibility gate, metadata
     parents (public and unpublished), and deleted or purged images.
   - It ends with `ANALYZE`, and has a matching `cleanup.sql`.

   Local database only. No production data is copied.
3. **Local plans.** Measure the current function on that data, locally and
   as `anon`.
   - Use local `auto_explain` (`log_analyze`, `log_buffers`,
     `log_nested_statements`) or the body's statement prepared under both
     `plan_cache_mode` settings, since a SQL function is planned
     generically.
   - Scenarios:
     - the default request: Microscopy on, `p_limit` 31, `p_offset` 0, 30,
       60 and 300;
     - Microscopy off;
     - spores on;
     - genus or species text, including the taxon-free fallback the landing
       sends;
     - a date range;
     - an observer substring;
     - Table's page size of 51.

   Record per-node time and buffers. Count the calls to
   `metadata_microscope_parent_is_public` and `community_contributor_label`.
   Show whether the cost scales with the total number of public observations
   or with the offset.
4. **Report.** In the evidence doc, cover:
   - where the time goes;
   - how cost grows with data size (run the seed at 1×, 2× and 4× the
     production counts);
   - which existing indexes are used or ignored;
   - how close each scenario is to `3s`;
   - whether the local plans plausibly match production, based on Step 1's
     statistics.

   Also list what only a production plan could settle.

Human gate: the owner reviews the evidence. Two decisions come before
Stage 2:
- whether a production plan capture is needed, which is a separate
  explicit approval for a session-local `LOAD 'auto_explain'` run by the
  owner and changes no settings;
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
3. **Indexes.** Add only the candidates the Stage 1 gate allowed. For each,
   show the plan uses it and record its size and write cost. Otherwise add
   none.
4. **Equivalence.**
   - Keep the old definition as a test-only reference function in the test
     transaction, never in production.
   - A pgTAP test (`supabase/tests/search_public_observations_two_phase_test.sql`)
     compares the old and new output row by row, order included. It runs
     over a fixture matrix covering every gate and filter, and over the
     Stage 1 seed. It uses every argument combination the landing sends,
     with offsets 0, 30, 60, past the end, negative, NULL, and limits 0, 1,
     31, 51, 100 and 1000.
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

Docs only. On the Stage 1 seed at 1×, 2× and 4× scale, compare the old and
new function for every Stage 1 scenario:
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

Pass: every scenario's p95 is far below `3s` at 4× scale, with a target set
from Stage 1's numbers and agreed at its gate. Cost no longer grows with the
total number of public observations for the default request.

## Stage 4 — Production migration gate

First read the sections above the stages in `docs/plans/active/2026-10-13-search-public-observations-performance.md`. Their decisions and constraints apply to this stage.

The agent prepares, without running it, `supabase/search-public-observations-runbook.md`.
Model it on `supabase/batch-spore-preview-runbook.md`:
- **Gate:** Stages 1–3 accepted, the security APPROVE, and the branch merged
  to `main`. The migration's hash is pinned.
- `supabase migration list` agreement, with the documented deferred
  migration.
- The deploy-tree `prepare` / `check` / push / `post-verify`.
- **Read-only live checks:**
  - catalog and grant parity;
  - an anonymous parity probe between the deployed function and a
    transaction-local copy of the old body for sampled pages, printing
    counts and mismatches only;
  - anonymous PostgREST calls for the default page 1 and page 2, recording
    status and counts.
- **Rollback.** A compensating migration that restores the previous
  definition and drops any added index, with its own local validation.
- **Statistics windows.** A bracketed `pg_stat_statements` window before the
  change and one after it, both for `search_public_observations`, under the
  same validity rules as the batch runbook §5. No resets. The windows are
  compared only when both are valid.

Human gate: a person with explicit owner approval runs the runbook and
commits the record. Nothing is deployed automatically.
