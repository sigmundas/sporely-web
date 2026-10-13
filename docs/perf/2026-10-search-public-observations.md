# `search_public_observations`: Stage 1b local evidence

Plan: `docs/plans/active/2026-10-13-search-public-observations-performance.md`,
Stage 1b. Harness: `docs/perf/2026-10-search-public-observations/`.

**Status: measured on the isolated local database (2026-10-13).** Every
output is under `2026-10-search-public-observations/results/`. Section 8's
thresholds are proposals for the owner's decision at the Stage 1b gate.

**Summary.**
- The cost of the current function is proportional to the number of
  public candidates. It does not depend on the offset, the page size or the
  microscopy and spores filters.
- 95% of the shared buffers are in the two `LEFT JOIN LATERAL` subqueries.
  85% (22,040 of 25,933 at 1×) are in their two image scans, which call
  `metadata_microscope_parent_is_public` once for every metadata-parent
  image of every candidate, so twice per parent in all. That 85% covers both
  the scans' own index and heap reads and the helper's nested work; this run
  did not separate the two.
- From 1× to 4× the work grows 4.06× (26.0k → 105.5k buffers per call), and
  the local time grows from 25 ms to about 100 ms.
- The production aggregates and these local runs cover different request
  mixes, so they do not give a hardware multiplier. Production's 1× maximum
  (2,663 ms) is already close to 3 s. Whether its tail grows with data as the
  local work does is a hypothesis this stage cannot test (section 6).

## 1. Production probe output (input)

The single authorized production statistics collection: probe
`supabase/search-public-observations-stats-probe.sql` at `a4b9cb8`, run once by
the owner at 2026-10-13 18:22:46 UTC, ended in `ROLLBACK` with
`wrote_nothing = t`. The verbatim output is
`2026-10-search-public-observations/production-probe-2026-10-13.txt`; its
provenance and terminal-copy artifacts (two wrapped index rows, one lost space)
are in `production-probe-2026-10-13.md`. Values, with the wraps rejoined:

| `pg_stat_statements_info` | value |
| --- | --- |
| taken_at | 2026-10-13 18:22:46.606319+00 |
| stats_reset | 2026-06-17 13:38:01.755619+00 |
| dealloc | 0 |
| track / max entries / entries now | top / 5000 / 4793 |

| role | entries | calls | total ms | mean ms | max ms | stddev ms (pooled) | rows | shared hit | shared read | temp written |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| anon | 63 | 3,287 | 778,722.4 | 236.9 | 2,663.3 | 337.2 | 3,287 | 38,927,721 | 346 | 0 |
| postgres | 19 | 49 | 929.1 | 19.0 | 151.1 | 37.5 | 20 | 17,983 | 6 | 0 |

| count (exact, `count(*)`) | value |
| --- | --: |
| public non-draft observations | 228 |
| … with a microscope image passing the search's gate | 133 |
| … with public spore measurements | 127 |
| metadata-parent images (microscope, `storage_path IS NULL`, any state) | 988 |
| spore measurements (all rows) | 8,982 |
| public observations per owner: p50 / p95 / max | 2 / 146 / 146 |

| table | `n_live_tup` | `n_dead_tup` | last autoanalyze | last autovacuum |
| --- | --: | --: | --- | --- |
| observation_images | 5,585 | 1,126 | 2026-10-12 13:31:40 | 2026-09-25 10:12:39 |
| observations | 787 | 14 | 2026-10-12 11:30:33 | 2026-10-12 17:36:50 |
| spore_measurements | 8,982 | 0 | 2026-10-02 08:36:19 | 2026-10-10 15:34:30 |

| table | index | definition (abridged) | idx_scan | bytes |
| --- | --- | --- | --: | --: |
| observation_images | idx_observation_images_deleted_purged_at | (deleted_at, purged_at) | 1,605 | 106,496 |
| observation_images | idx_observation_images_observation_id | (observation_id) | 2,337,898 | 139,264 |
| observation_images | observation_images_desktop_id_user_unique | UNIQUE (desktop_id, user_id) | 12,577 | 434,176 |
| observation_images | observation_images_microscope_captured_at_idx | (observation_id, captured_at DESC) WHERE microscope AND captured_at IS NOT NULL | 0 | 196,608 |
| observation_images | observation_images_observation_id_idx | (observation_id) | 177 | 131,072 |
| observation_images | observation_images_pkey | UNIQUE (id) | 4,147,847 | 278,528 |
| observation_images | observation_images_user_id_idx | (user_id) | 5,745 | 139,264 |
| observation_images | observation_images_user_updated_at_id_idx | (user_id, updated_at, id) | 1,606 | 720,896 |
| observations | idx_observations_image_key | (image_key) | 0 | 122,880 |
| observations | idx_observations_is_draft | (is_draft) | 117 | 32,768 |
| observations | idx_observations_location_precision | (location_precision) | 61 | 32,768 |
| observations | idx_observations_public_country_code | (country_code) WHERE public, not draft | 0 | 16,384 |
| observations | idx_observations_public_region_id | (region_id) WHERE public, not draft | 0 | 16,384 |
| observations | idx_observations_species_spore_visibility | (genus, species, spore_data_visibility) | 374 | 57,344 |
| observations | idx_observations_spore_visibility | (spore_data_visibility) | 110 | 32,768 |
| observations | idx_observations_user_visibility | (user_id, visibility) | 82,944 | 40,960 |
| observations | idx_observations_visibility | (visibility) | 85 | 40,960 |
| observations | observations_date_idx | (date DESC) | 3,735 | 40,960 |
| observations | observations_desktop_id_user_unique | UNIQUE (desktop_id, user_id) | 1,860 | 65,536 |
| observations | observations_genus_species_idx | (genus, species) | 155 | 40,960 |
| observations | observations_pkey | UNIQUE (id) | 4,697,206 | 57,344 |
| observations | observations_user_id_id_key | UNIQUE (user_id, id) | 535,979 | 73,728 |
| observations | observations_user_id_idx | (user_id) | 10,007 | 40,960 |
| spore_measurements | idx_spore_measurements_desktop_user | UNIQUE (desktop_id, user_id) WHERE both NOT NULL | 115 | 475,136 |
| spore_measurements | idx_spore_measurements_image_type | (image_id, measurement_type) | 3,101,436 | 180,224 |
| spore_measurements | idx_spore_measurements_thumb_key | (thumb_key) | 0 | 270,336 |
| spore_measurements | idx_spore_measurements_user_id | (user_id) | 2,132 | 122,880 |
| spore_measurements | spore_measurements_image_id_idx | (image_id) | 7,218,851 | 139,264 |
| spore_measurements | spore_measurements_pkey | UNIQUE (id) | 97,186 | 253,952 |
| spore_measurements | spore_measurements_user_id_idx | (user_id) | 19 | 122,880 |

Function: `search_public_observations(integer,integer,text,text,text,text,date,date,boolean,boolean,text,text,text,text,text)`,
`functiondef_sha256 = 84db51be5bcfbcc63d72b6cfb5068cbe12bf18a989c879febf7ebf3bfa9e28c2`.
That equals the hash from an isolated `origin/main` `f92d560` build (plan,
"Recorded before Stage 1b"), so production runs the `20260925120000`
definition.

Derived from the probe, not measured locally:
- anon averages 11,843 shared buffers hit per call (38,927,721 / 3,287), about
  92 MB of buffer traffic per call, for a result of at most 100 rows. The
  three tables together are about 1.4 MB of indexes and a few MB of heap, so
  each call revisits the same pages thousands of times. That fits per-row
  helper and lateral work, not reading new data.
- postgres's 49 calls (mean 19.0 ms, 367 buffers per call) are much cheaper
  than anon's, but its rows/calls is 0.41, so they are mostly different
  requests (tests, empty results). They are not an owner-versus-anon
  comparison.
- `idx_observation_images_observation_id` (2.3 million scans) and
  `spore_measurements_image_id_idx` (7.2 million) are the hot lateral paths;
  `observation_images_microscope_captured_at_idx` has never been used.

## 2. Isolated database

Target: the Stage 1b isolated stack, project `sporely-stage1b-f92d560`,
container `supabase_db_sporely-stage1b-f92d560`, host port 56522.

Checked from Docker metadata (no SQL), 2026-10-13:
- own Compose project label `sporely-stage1b-f92d560` on all five containers;
- own network `supabase_network_sporely-stage1b-f92d560`;
- own data volume `supabase_db_sporely-stage1b-f92d560`, distinct from the
  shared stack's container `supabase_db_zkpjklzfwzefhjluvhfw` (port 54322);
- this worktree has no `supabase/.temp/project-ref`.

Checked with `isolation-check.sql` before any write
(`results/isolation-check.txt`): PostgreSQL 17.6; 128 applied migrations
(`20260521120000` … `20261012100000`) with `deferred_present = f`; 0
observations, images, measurements, profiles and users;
`search_public_observations` `functiondef_sha256 = 84db51be…a9e28c2`
(`prosecdef = t`, `search_path=public`), equal to production's;
`metadata_microscope_parent_is_public` and `community_contributor_label` both
`SECURITY DEFINER`; `auto_explain` in `shared_preload_libraries`.

After the run, `cleanup.sql` left 0 observations, images and measurements and
dropped the `perf_spo` schema (`results/cleanup.txt`).

## 3. Synthetic data (`seed.sql`)

Deterministic, synthetic, no `random()`, no production rows. The header of
`seed.sql` has the full rules; this section records what they imply. Every
per-observation figure below is an **assumption** derived from the probe's
totals, not a measurement.

**Exact targets.** The procedure re-runs the probe's own count query after
seeding and raises unless all of these equal the target times the scale:
228 public non-draft observations, 133 with gated microscopy, 127 with public
spore measurements, 988 metadata parents, 8,982 measurements, per-owner
p50 2 / p95 146 / max 146.

**Estimates.** 787 observations and 5,585 images (`n_live_tup`, rounded). The
seed makes them exact too, so 559 observations are non-public or drafts and
4,529 images are field images. `n_dead_tup` (1,126 images) is not reproduced:
the seed vacuums before `ANALYZE`.

**Owners.** 19 public-observation owners with 146, 14, 12, 10, 9, 8, 7, 6, 5,
2 and nine times 1 public observations; `percentile_disc` gives p50 2, p95 146,
max 146. The real number of owners is unknown (at most 19); this is one choice
consistent with the probe. The owner with 1 observation at k = 228 is banned.
The 559 non-public observations go 447 to the same 19 owners in proportion to
their public counts and 112 to six owners with no public observations. Eight
owners have no display name, so the contributor label falls back to the
username.

**The 228 public observations at 1×** (all replicated per scale):

| role | count | microscopy | measurements |
| --- | --: | --- | --- |
| S, spore-bearing | 127 | 885 public metadata parents in all (2–11 each, about 7.0 on average); 42 also have a byte-backed microscope image; 12 have an extra deleted parent | 8,032 public spore/manual (about 13–112 each, about 63 on average), plus 50 cystidia and 60 on the deleted parents |
| M, spore data private | 2 | byte-backed image + 2 public parents | 30 each |
| M, cystidia only | 2 | byte-backed image | 10 cystidia each |
| M, no measurements | 2 | byte-backed image | 0 |
| N, deleted byte-backed image | 10 | deleted image | 5 each |
| N, purged byte-backed image | 10 | purged image | 5 each |
| N, `owner_sync` parents | 10 | 2 parents | 10 each |
| N, foreign measurements only | 10 | 1 public parent | 5 by another user |
| N, deleted public parent | 9 | 1 deleted parent | 10 each |
| N, spore data private | 9 | 2 public parents | 10 each |
| N, banned owner | 1 | 3 public parents | 60 |
| N, field images only | 36 | none | 0 |

Every visibility gate has a decoy: non-public visibility and drafts (559),
banned owner, `spore_data_visibility` private (both with byte-backed images and
with parents only), deleted and purged images, unpublished parents
(`owner_sync`), parents whose only measurements are another user's, and
non-public measurement types (cystidia). The blocked-user gate is not
exercised: anon has no `auth.uid()`, so `is_blocked_between` is never called.
27 of the non-public observations have one public parent with 10 measurements
(not reachable by the search).

Implied per-observation figures (assumptions). The plan's examples were about
71 measurements per spore-bearing observation (8,982 / 127) and about 7.4
parents per gated-microscopy observation (988 / 133). The seed puts 900
measurements and 103 parents on decoys, and 50 cystidia measurements on S
observations, so the S observations get about 63 public measurements and
7.0 public parents each. About 5.8 field images per
observation.

Metadata-parent rows that pass the lateral subqueries' cheaper quals (not
deleted, not purged, microscope) on search candidates at 1×: 937. They are
S's 885 plus 52 on M and N candidates, where the helper returns false.
`function-calls.sql` prints this number for each seed.

**Scales.** `seed-2x.sql` and `seed-4x.sql` replicate the whole 1×
population, owners included, as new synthetic owners, so every count doubles
or quadruples and every share and percentile is unchanged.

**Sensitivity variant** (`seed-1x-skew.sql`, labelled as such wherever
reported). Same totals, but 12 of the 127 spore-bearing observations get
weight 20 for parents and measurements: about 43 parents and about 445
measurements each, against about 3 and 23 for the rest. It tests whether
per-observation concentration, rather than the number of public observations,
drives the cost.

## 4. Method and run order

All files ran as postgres through `psql` against the isolated container
only, via the owner's fixed wrapper (gate `stage1b-isolated-sql-access`). It
accepts only a committed, unmodified `.sql` file directly in
`docs/perf/2026-10-search-public-observations/`, checks the container's
project label, and runs
`docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X [-At] -v ON_ERROR_STOP=1 < <file>`:

```
<wrapper>/run-stage1b-sql.sh [-At] docs/perf/2026-10-search-public-observations/<file>.sql \
  > docs/perf/2026-10-search-public-observations/results/<file>-<scale>.txt 2>&1
```

The wrapper passes no `-v` variables, so the scale is chosen by file: `seed.sql`
(1×, installs the harness), then `seed-2x.sql`, `seed-4x.sql`,
`seed-1x-skew.sql`. `function-calls.sql` ran with `-At`.

1. `isolation-check.sql`: expect 128 migrations, `deferred_present f`,
   0 observations, hash `84db51be…a9e28c2`, `auto_explain` in
   `shared_preload_libraries`. Stop if any differs.
2. `counter-check.sql`, on the empty database. Case 0 must report exactly
   5 `community_contributor_label` and 3 `metadata_microscope_parent_is_public`
   calls. Cases 1–3 are read against 5 candidates and 3 reached parents per
   lateral, with the VERBOSE nested plans showing where each helper runs.
   Both helpers must show `prosecdef = t`. If a count cannot be matched to the
   plan, that helper's counts are reported as unavailable and the `EXPLAIN`
   row estimates are used instead, labelled as such.
3. For each of `seed.sql` (1×), `seed-2x.sql`, `seed-4x.sql` and
   `seed-1x-skew.sql`: run the seed, then `bench.sql`, `function-calls.sql`,
   `plans.sql` and `plans-prepared.sql`. Keep each output under
   `2026-10-search-public-observations/results/`.
4. `cleanup.sql`.

What each file measures:
- `bench.sql`: per scenario, 2 warm-up calls and 20 measured calls as anon;
  median, p95 (`percentile_disc`), maximum, margin under 3 s, shared buffers
  per call.
- `function-calls.sql`: helper calls per scenario, one fresh connection each.
- `plans-prepared.sql`: the per-node evidence. For all 32 scenarios, the body
  from `pg_proc.prosrc` is prepared and run with `EXPLAIN (ANALYZE, BUFFERS)`
  under `force_generic_plan` (what the SQL function runs) and
  `force_custom_plan`. There is no duration threshold, so no fast plan is
  dropped.
- `plans.sql`: a cross-check through `auto_explain` (nested statements, 5 ms
  threshold so the helper statements stay out) on 11 scenarios. It confirms
  that a real call's body plan has the generic plan's shape, and records which
  bodies ran too fast to be logged.

Scenarios (`perf_spo.scenario`, 32): the default request (Microscopy `true`,
`p_limit` 31) at offsets 0, 30, 60 and 300; every `p_has_spores` ×
`p_has_microscopy` combination in {NULL, true, false} at offsets 0 and 30;
genus, genus + species, and a genus with no exact match (the landing then
sends the taxon-free fallback, which is the default page 1); a date range; an
observer substring; Table's page size 51 at offsets 0 and 51, and with no
filters; and offset 300 with no filters and with Microscopy `false`.

Limits of the local method, stated in advance:
- Local timings are from a laptop Docker stack, not production hardware; the
  comparisons that matter are relative (scale, offset, filter, buffers, call
  counts).
- anon's 3 s timeout is not enforced under `SET ROLE`, so calls slower than
  3 s finish and are measured instead of failing.
- There is no concurrent load (Stage 3 covers that).

## 5. Results

Raw outputs (`results/`): `isolation-check.txt`, `counter-check.txt`, and for
each of `1x`, `2x`, `4x` and `1x-skew`: `seed-*.txt`, `bench-*.txt`,
`function-calls-*.txt`, `plans-prepared-*.txt`, `plans-*.txt`; `cleanup.txt`.
Every seed passed its own check that the probe's exact targets were reproduced
at its scale (the seed raises otherwise; its output has no error).

### 5.1 Helper-call counter (`counter-check.sql`, empty database)

Fixture: 5 candidates, 3 metadata-parent rows on candidates that pass the
laterals' cheaper quals.

| case | `community_contributor_label` | `metadata_microscope_parent_is_public` | expected |
| --- | --: | --: | --- |
| 0: direct calls, 5 label + 3 helper | 5 | 3 | 5 and 3, exact |
| 1: search, no filters, limit 100 (5 rows) | 5 | 6 | 5 (one per returned row) and 3 × 2 laterals |
| 2: search, `p_observer` set | 10 | 6 | one per candidate in the filter + one per output row |
| 3: search, Microscopy `true`, limit 2 | 2 | 6 | label only for returned rows; helper for every candidate |

The nested VERBOSE plan shows where each count comes from:
- `metadata_microscope_parent_is_public` appears in the filter of the image
  scan inside each of the two laterals: the latest-image lateral and the
  spore-count lateral. It is evaluated once per microscope image that passes
  `deleted_at IS NULL AND purged_at IS NULL AND image_type = 'microscope'`
  and has `storage_path IS NULL`, so 3 rows × 2 laterals = 6.
- `community_contributor_label` is in the `Result` node above the top `Sort`.
  The planner postpones it past the sort, so it runs once per row that
  reaches `LIMIT`, offset rows included. When `p_observer` is set it is also
  in the candidate join filter. There is no common-subexpression reuse, so it
  then runs twice for matching rows.

Both counts match the plan exactly, and both helpers are `SECURITY DEFINER`
(never inlined), so **both counts are available**. No `EXPLAIN` estimates are
substituted.

### 5.2 Timing and buffers per scenario (`bench.sql`, 20 measured calls as anon)

Full-scan scenarios are every scenario without a genus, date or observer
filter (sids 1–22 and 28–32). Their ranges:

| seed | candidates | median ms | p95 ms | max ms | shared hit / call | margin under 3 s (worst max) |
| --- | --: | --- | --- | --- | --- | --: |
| 1× | 227 | 24.1–27.0 | 24.5–41.4 | 24.6–77.3 | 25,959–26,186 | 2,922.7 ms |
| 2× | 454 | 47.0–54.2 | 48.0–81.7 | 48.3–120.3 | 52,287–52,949 | 2,879.7 ms |
| 4× | 908 | 94.3–104.0 | 96.4–161.3 | 98.8–173.0 | 105,380–106,291 | 2,827.0 ms |
| 1× skew (sensitivity) | 227 | 27.7–32.2 | 28.7–55.2 | 28.8–69.2 | 25,945–26,172 | 2,930.8 ms |

Default request (Microscopy `true`, `p_limit` 31) by offset:

| seed | off 0 med / p95 / max, buffers | off 30 | off 60 | off 300 |
| --- | --- | --- | --- | --- |
| 1× | 25.0 / 25.9 / 25.9, 25,990 | 24.5 / 25.6 / 26.5, 26,020 | 24.9 / 25.9 / 26.8, 26,050 | 25.2 / 25.6 / 25.8, 26,092 (0 rows) |
| 2× | 49.0 / 52.6 / 59.0, 52,349 | 49.0 / 53.4 / 53.7, 52,409 | 48.6 / 51.5 / 51.7, 52,469 | 54.2 / 73.8 / 77.7, 52,819 (0 rows) |
| 4× | 102.7 / 110.6 / 113.0, 105,466 | 104.0 / 161.3 / 173.0, 105,548 | 100.1 / 121.4 / 126.1, 105,631 | 100.1 / 105.6 / 171.0, 106,291 |

Filtered scenarios (median ms / p95 ms, buffers, rows):

| sid | scenario | 1× | 2× | 4× | 1× skew |
| --: | --- | --- | --- | --- | --- |
| 23 | genus, Microscopy `true` | 3.8 / 4.1, 2,112, 11 | 6.0 / 6.2, 4,181, 22 | 10.3 / 11.6, 8,338, 31 | 3.5 / 3.9, 1,409, 11 |
| 24 | genus + species | 2.6 / 2.7, 788, 4 | 3.5 / 3.6, 1,492, 8 | 4.8 / 5.4, 2,921, 16 | 2.5 / 2.8, 568, 4 |
| 25 | taxon miss (then sid 1 as fallback) | 1.6 / 1.7, 161, 0 | 1.8 / 2.0, 261, 0 | 2.2 / 2.5, 457, 0 | 1.6 / 1.6, 146, 0 |
| 26 | date range (2026-01-01..06-30) | 8.0 / 8.2, 6,889, 31 | 14.7 / 20.2, 13,816, 31 | 28.7 / 29.4, 27,726, 31 | 10.4 / 10.8, 7,881, 31 |
| 27 | observer substring | 4.4 / 4.4, 2,181, 8 | 7.4 / 7.8, 4,758, 16 | 13.3 / 14.2, 10,176, 31 | 3.8 / 4.0, 1,257, 8 |

The landing's taxon-free fallback costs sid 25 plus sid 1: 26.6 ms and 26,151
buffers at 1×, 104.9 ms and 105,923 at 4×. No read blocks were recorded
(`read_max` 0 everywhere): all data is in shared buffers, as in production
(346 reads against 38.9 million hits).

The occasional max far above p95 (77.3 ms at 1×, 173.0 ms at 4×) is local
scheduling noise on a laptop. The buffer counts are identical across all 20
calls of every scenario.

### 5.3 Helper calls (`function-calls.sql`, one call each, as anon)

| seed | candidates | parents reached per lateral | `metadata_microscope_parent_is_public` (every full-scan scenario) | per candidate | `community_contributor_label` |
| --- | --: | --: | --: | --: | --- |
| 1× | 227 | 937 | 1,874 | 8.26 | rows reaching `LIMIT`: 31 (off 0), 61 (off 30), 91 (off 60), 133 (off 300) |
| 2× | 454 | 1,874 | 3,748 | 8.26 | 31 (off 0), 266 (off 300) |
| 4× | 908 | 3,748 | 7,496 | 8.26 | 31 (off 0), 331 (off 300) |
| 1× skew | 227 | 937 | 1,874 | 8.26 | as 1× |

- The helper count is exactly 2 × parents reached, in every scenario without
  a genus, date or observer filter, whatever the microscopy and spores
  filter, offset or page size. With a filter on `observations` columns it
  falls with the matching candidates. For example, at 1× genus gives 138,
  genus + species 40, the date range 494 and the observer filter 130.
- The label count is 236, 472 and 943 for the observer substring at 1×, 2×
  and 4×: one per candidate (227, 454, 908) for the filter, plus one per row
  leaving the sort.
- In `track_functions` time, the helper accounts for 26–33 ms of a 35–44 ms
  call at 1× (about 75%). At 4× it is 109–155 ms of 142–197 ms. Function
  tracking itself adds overhead, so these totals are higher than `bench.sql`'s.

### 5.4 Plans (`plans-prepared.sql`, all 32 scenarios; `plans.sql`, cross-check)

Every scenario has the same plan shape at every scale, under both
`force_generic_plan` and `force_custom_plan`. The argument values reach the
body only through the `normalized` CTE, which is referenced several times
and is therefore materialized, so even a custom plan cannot see them. Both
modes estimate `rows=1` for the candidate set (actual 227 at 1×, 908 at 4×),
which is why every join is a nested loop.

Default request (sid 1), per node. Sources:
- **1× column:** the `auto_explain` body plan of a real anon call, in
  `results/plans-1x.txt` (the plan whose `Query Parameters` line has
  `$1 = '31', $2 = '0', $10 = 't'`). `custom sid 1` in
  `results/plans-prepared-1x.txt` has the same nodes and the same 25,933
  buffers (23.5 ms).
- **4× column:** `custom sid 1` in `results/plans-prepared-4x.txt`.

The `generic sid 1` plans are each file's first `EXECUTE` (planning
included). At 1× it took 55.1 ms and 25,958 buffers: same nodes, but cold
for the session. It is therefore not used as the per-node reference.

| node | 1× time / buffers (`auto_explain`, real call) | 4× time / buffers (prepared, custom) | share of buffers |
| --- | --- | --- | --: |
| candidates: Bitmap Heap Scan on `observations` via `idx_observations_visibility`, banned anti-join (Seq Scan on `profiles` per candidate), `observations_pkey` re-join | 0.8 ms / 1,013 | 7.0 ms / 5,863 (2,735 in the `profiles` scans) | 4–6% |
| latest-image lateral: Index Scan `observation_images_observation_id_idx` with the helper in its filter, top-N sort, loops = candidates | 10.6 ms / 11,020 | 43.1 ms / 44,024 | 42% |
| spore-count lateral: the same image scan and helper (11,020 / 44,024) plus `spore_measurements_image_id_idx` (2,849 / 11,416), loops = candidates | 12.8 ms / 13,869 | 54.0 ms / 55,440 | 53% |
| join filter (microscopy, spores), top-N sort on `(date DESC, id DESC)`, `Result` (label), `Limit` | 0.6 ms / 31 | 1.9 ms / 86 | <1% |
| total | 24.8 ms / 25,933 | 106.1 ms / 105,413 | |

- Each lateral's image scan costs 11.8 buffers per helper call at both
  scales (11,020 / 937 and 44,024 / 3,748). That figure includes the scan's
  own index and heap reads of `observation_images` (one index descent per
  candidate plus about 10 images per candidate) as well as the helper's
  nested reads. The split between them was not measured, so the 85% is the
  share of the helper-gated image scans, not of the helper alone.
- `plans.sql`: `auto_explain` logged the body plan for every full-scan
  scenario and for the date range (body 7.0 ms). The genus and observer
  bodies ran under its 5 ms threshold and were not logged, so their per-node
  evidence is in `plans-prepared-*.txt`.
- psql writes `\echo` labels to stdout and `LOG` lines to stderr, which are
  buffered separately, so the labels in `plans-*.txt` do not line up with the
  logs. Each logged body carries its own `Query Parameters` line, which
  identifies the scenario.

## 6. Report

**Where the time goes.** For every public candidate, before any filter,
sort or pagination, the function runs two laterals that each scan the
candidate's images and call `metadata_microscope_parent_is_public` once per
metadata parent. That is 8.26 helper calls per candidate on this seed.
Together the laterals hold 95% of the buffers and almost all of the time.
The candidate scan, the filters, the sort, the offset and the label are
under 6% together. The contributor label is cheap: the planner already
evaluates it only for rows that reach `LIMIT`.

**Phase attribution** of today's costs, for the plan's two groups:
- *Eligibility and pagination (phase 1):* the candidate scan and banned
  check (4–6%), the microscopy and spores decisions, and the sort, offset and
  `LIMIT` (<1%). Today the microscopy and spores decisions are taken from the
  laterals' results, so part of the laterals' cost is the eligibility work
  phase 1 must keep: one helper-gated `EXISTS` per candidate and filter.
- *Enrichment (phase 2):* the rest of both laterals (latest image,
  spore-measurement count), the contributor label, and the prep/stain and
  location fields. Today all of it runs for every candidate, not just for
  returned rows. That is the part the two-phase design bounds.

**Growth with data size.** Work is linear in candidates: about 115 shared
buffers per candidate (114.5 at 1×, 115.3 at 2×, 116.2 at 4×) and about
0.11 ms per candidate locally.
- From 1× to 4× the buffers grow 4.06× and the median time 4.1× (25.0 →
  102.7 ms for the default request).
- The offset barely matters. Offset 300 adds 102 buffers at 1× and 825 at
  4×, all from labels for skipped rows, and no measurable time.
- The microscopy and spores filters do not reduce the work either: `false`
  and `true` cost the same as `NULL`, because they are applied after both
  laterals.
- Only filters on `observations` columns (genus, species, date, observer)
  shrink the candidate set, and the cost falls in proportion.

**Sensitivity run (skewed parents and measurements, 1×).** It reaches the
same 937 parents, makes the same 1,874 helper calls and uses the same 26k
buffers. The median time rises from about 25 to about 29 ms, because 12
observations carry about 445 measurements each for the spore count. The cost
depends on the total number of parents on public candidates, not on how they
are spread. Measurement concentration adds a little time but no buffers in
the eligibility path.

**Indexes.**
- **Used:**
  - `idx_observations_visibility` (bitmap) for the candidate set;
  - `observations_pkey` for the re-join;
  - `observation_images_observation_id_idx` in both laterals. Production
    shows the duplicate `idx_observation_images_observation_id` taking those
    scans (2.3 million) instead; the two are interchangeable;
  - `spore_measurements_image_id_idx` for the count;
  - `public_regions_pkey` at 1× (a Seq Scan at 4×, with an empty table).
- **Ignored:**
  - `observations_date_idx`: the order is applied by a top-N sort after
    every candidate is enriched, so an ordered index scan cannot help;
  - `observation_images_microscope_captured_at_idx`: it is partial
    (`captured_at IS NOT NULL`), while the lateral sorts by
    `captured_at DESC NULLS LAST, created_at DESC, id DESC`. Production also
    shows 0 scans;
  - `observations_genus_species_idx` and
    `idx_observations_species_spore_visibility`: the genus and species
    predicates compare `lower(coalesce(nullif(btrim(...))))`, so they are
    filtered in the candidate join filter.

  There is no index on `profiles.is_banned`; the banned anti-join seq-scans
  `profiles` once per candidate (26 rows at 1×, 104 at 4× locally).

**Distance from 3 s, locally.** Every scenario is far below 3 s on this
machine: the worst maximum is 173.0 ms at 4× (margin 2,827 ms). Local margins
are not production margins, though; see the next paragraph.

**Do the local plans plausibly match production?** In kind, plausibly. In
magnitude, the aggregates cannot say.
- **Buffers.** Production anon averages 11,843 buffers per call. Locally a
  full-scan call at 1× uses 26,000, and filtered calls use 161–6,889.
  Production's mix includes species-page and genus calls and taxon misses,
  so a mean below the full-scan cost is consistent with this plan. It is
  also consistent with production having fewer parents per candidate than
  the seed assumes. The probe cannot tell these apart.
- **Speed.** A local full-scan call does about 1,040 buffers per ms
  (25,990 / 25.0). Production's anon mean works out to about 50
  (11,843 / 236.9). The two numbers describe different request mixes over
  different data, so their ratio (about 20×) is **descriptive only**. It is
  not a measured hardware or contention multiplier, and it does not convert
  a local time into a production time. Production's slow tail (2,663 ms
  maximum, standard deviation 337 ms) is about 11× its own mean.
- **Growth (hypothesis, not established).** Locally the work per call grows
  linearly with public candidates. If production's mean and tail grew the
  same way, the mean would be about 474 ms and the tail about 5.3 s at 2×.
  Nothing here shows that production's tail scales with work rather than
  with concurrency or contention. What is established: production's tail
  already reached 2,663 ms at 1×, and timeouts were recorded (two in the
  baseline, plus the 2026-10-13 page-2 failure).

## 7. What only a production plan could settle

Independent of the local results:
- The plan production actually chooses for the body with its real statistics,
  including 1,126 dead image tuples and its real, unknown per-observation
  distribution of parents and measurements.
- Whether production's 11,843 buffers per call come from the same nodes as
  the local plan's buffers.
- Production's helper call counts per request, which depend on that real
  distribution.
- The effect of concurrent Explorer traffic (page 1 and page 2 in parallel,
  facets) on the slow tail: the 2,663 ms maximum and the pooled standard
  deviation of 337 ms against a 236.9 ms mean.
- Any PostgreSQL version or settings difference between production and the
  local image (`work_mem`, `jit`, `random_page_cost`).
- How much time production spends per unit of work on a full-scan call,
  and whether its slow tail grows with work or with concurrency. The
  aggregates' descriptive ratio (about 50 buffers per ms in production
  against 1,040 locally) mixes different requests and cannot answer this.
- How the banned-owner checks behave with production's real number of
  `profiles` rows, which the probe did not count. Locally they are a Seq
  Scan of a 26–104-row table once per candidate (2,735 buffers at 4×), and
  the helper repeats the check once per call. With many more profiles the
  planner may choose differently, and the cost may grow.

## 8. Proposed Stage 3 thresholds

Proposals for the owner's decision at the Stage 1b gate. Every number is
local, on the Stage 1b seed, on an isolated stack.

**Scenario matrix for Stage 3.** It has 38 scenarios:
- the 32 in `perf_spo.scenario`;
- six more at offset 300 with `p_limit` 31, for the `(p_has_spores,
  p_has_microscopy)` pairs not yet covered there: (`true`, `NULL`),
  (`true`, `true`), (`true`, `false`), (`false`, `NULL`), (`false`, `true`)
  and (`false`, `false`). Sids 4, 31 and 32 already cover (`NULL`, `true`),
  (`NULL`, `NULL`) and (`NULL`, `false`).

That puts every `NULL`/`true`/`false` combination at offsets 0, 30 and 300.
Stage 3 adds the six rows as sids 33–38 and measures them for the old and
the new function. Each threshold applies to every scenario in the matrix at
the scales named, unless the line says otherwise. A scenario that returns 0
rows at a scale (for example Microscopy `true` at offset 300 at 1×) is a
**zero-result scenario** there.

**End-to-end measurement.** `bench.sql` unchanged:
- the real function call as anon, timed with
  `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`;
- 2 warm-up calls, then 20 measured calls;
- p95 = `percentile_disc(0.95)` over the 20 execution times, max = their
  maximum;
- buffers = the top node's shared hit + read, taking the maximum over the 20
  calls (on this seed they are identical across calls).

This gives the **overall** thresholds.

**Phase measurement (paired).**
- Stage 3 adds a phase bench that runs the candidate's body exactly as
  `plans-prepared.sql` does: taken from `pg_proc.prosrc`, prepared,
  `force_generic_plan` (what the SQL function runs), as postgres (the
  definer).
- Each scenario gets 2 warm-up and 20 measured
  `EXPLAIN (ANALYZE, BUFFERS, TIMING ON, FORMAT JSON) EXECUTE` samples.
  `TIMING ON` is required to time the CTE node.
- From each sample's single JSON plan:
  - `T` = `Execution Time`; `B` = the top node's shared hit + read.
  - `T1` and `B1` = the page-id CTE's own node (the `CTE <name>` subplan of
    the `MATERIALIZED` CTE): `Actual Total Time` × `Actual Loops` (1 for a
    materialized CTE), and its shared hit + read. Both are inclusive of
    everything beneath it, phase-1 helper calls included.
  - `T2 = T − T1` and `B2 = B − B1`, computed **within the same sample**.
- Phase p95 and max are `percentile_disc(0.95)` and the maximum over the 20
  per-sample values of `T1` (phase 1) and of `T2` (phase 2). Percentiles are
  never subtracted from each other, and phase numbers are never mixed with
  `bench.sql`'s uninstrumented times.
- The phase time thresholds below apply to these instrumented values. The
  phase bench also reports its instrumentation overhead per scenario, as its
  median `T` divided by `bench.sql`'s median.
- Phase helper calls:
  - **Phase 1.** Count them through a local, test-only wrapper that copies
    the page-id CTE's query text verbatim from the candidate body.
    - Make the wrapper `LANGUAGE sql STABLE SECURITY DEFINER`, owned by the
      candidate function's owner (postgres), with the same
      `SET search_path` and the same 15 parameters. It returns the page ids
      in order.
    - Grant execute to `anon` only inside the measuring transaction.
    - Call it as anon with `function-calls.sql`'s method: fresh
      `\connect`, `SET LOCAL track_functions = 'all'`, `SET LOCAL ROLE
      anon`, counters read from `pg_stat_xact_user_functions`, `ROLLBACK`.
      Leave `request.jwt.claims` unset, as for a PostgREST anon call, so
      `auth.uid()` is NULL.
    - Because the query then runs as the definer, the privileges match the
      real body. `metadata_microscope_parent_is_public` is executable only
      by `service_role` and the definer (its PUBLIC execute is revoked in
      `20260925120000`), and the tables are read under the definer's RLS
      position.
    - Do **not** run the page-id query directly as anon. anon cannot call
      the helper, and direct table access would go through anon's RLS
      policies instead.
    - Create the wrapper and its grant in the measuring transaction and roll
      them back, so no object or grant outlives the run. Production grants,
      RLS and functions are never touched; this is local only.
  - **Check before using it.** For every scenario, the wrapper must return
    the same ordered ids as the candidate, compared as an MD5 of the ordered
    id list. Its plan, from the same prepared-body method, must have the
    same node shape as the page-id CTE subplan inside the full candidate's
    plan. If either differs for a scenario, that scenario's phase-1 count is
    unavailable and is reported as such.
  - **Phase 2:** `function-calls.sql` on the full candidate, minus phase 1,
    for the same scenario.

  Counts are deterministic, so one run per scenario is enough.

**Zero-result scenarios.** The per-returned-row enrichment thresholds do not
apply to them. Instead, phase 2 must stay within p95 ≤ 1.0 ms and ≤ 100
buffers, with 0 calls to either helper.

**Enrichment growth (1× → 4×).** It is checked per scenario.
- If the scenario returns the same number of rows at 1× and 4× (full pages
  of 31 or 51), compare phase-2 p95 `T2` and `B2` directly.
- Otherwise compare the per-returned-row values (`T2` / rows and `B2` /
  rows).
- Zero-result scenarios use only the absolute limits above.

Today's references: 1× full scan 25.0 ms median, about 26,000 buffers,
8.26 helper calls per candidate. At 4×: 102.7 ms, about 105,500 buffers.

**Eligibility filtering and pagination (phase 1).** Phase 1 still scans the
candidates, so it may grow linearly, but it must not repeat today's
per-parent double helper evaluation.

| measure | 1× | 4× |
| --- | --- | --- |
| p95 time (`T1`, instrumented) | ≤ 7 ms | ≤ 22 ms |
| maximum time (`T1`, instrumented) | ≤ 14 ms | ≤ 44 ms |
| shared buffers per call, at most one of `p_has_microscopy` / `p_has_spores` non-NULL | ≤ 20 per candidate (≤ 4,540) | ≤ 20 per candidate (≤ 18,160) |
| shared buffers per call, both non-NULL | ≤ 35 per candidate (≤ 7,945) | ≤ 35 per candidate (≤ 31,780) |
| `metadata_microscope_parent_is_public` calls | ≤ 1.0 per candidate per non-NULL microscopy/spores filter; 0 when both are NULL | same |
| `community_contributor_label` calls | ≤ 1.0 per candidate when `p_observer` is set; 0 otherwise | same |
| growth 1× → 4× (buffers, and p95 time) | ≤ 4.5× | |

The offset may add only the rows it skips: at offset 300, phase-1 buffers
(`B1`) may exceed the offset-0 value of the same filters by at most 5%.

**Enrichment (phase 2), returned rows only.**

| measure | threshold (1× and 4×) |
| --- | --- |
| shared buffers (`B2`) | ≤ 120 per returned row (≤ 3,720 for 31 rows, ≤ 6,120 for 51) |
| time (`T2`, instrumented) | p95 ≤ 0.1 ms per returned row (≤ 3.1 ms for 31, ≤ 5.1 ms for 51); max ≤ 0.2 ms per returned row |
| `community_contributor_label` | exactly 1 per returned row. Today it is one per row reaching `LIMIT`: 61 at offset 30, 331 at offset 300 at 4× |
| `metadata_microscope_parent_is_public` | ≤ 2 × the metadata parents of the returned rows, and ≤ 24 per returned row |
| growth 1× → 4× at a fixed page size | ≤ 1.2× in buffers and in p95 time |

**Overall (end to end, `bench.sql`).**

| measure | 1× | 4× |
| --- | --- | --- |
| p95 time | ≤ 10 ms | ≤ 25 ms |
| maximum time | ≤ 20 ms | ≤ 50 ms |
| shared buffers per call (page 31; page 51 may add 120 per extra row) | ≤ 8,500 | ≤ 24,000 |

**Margin under 3 s, measured locally.** These are the actual local margins
at the threshold values:
- 1×: p95 ≤ 10 ms leaves 2,990 ms; max ≤ 20 ms leaves 2,980 ms.
- 4×: p95 ≤ 25 ms leaves 2,975 ms; max ≤ 50 ms leaves 2,950 ms.

Today's function, for comparison: worst 1× maximum 77.3 ms (2,922.7 ms
margin), worst 4× maximum 173.0 ms (2,827.0 ms).

In work, the 4× buffer limit (24,000) is below today's 1× cost (26,000): at
four times today's data the function would do less work than it does now
at 1×. That much is established locally.

**Production margin (hypothetical, not established).** Production's 1×
maximum (2,663 ms) is 103× the local 1× p95 of today's default request
(25.9 ms). This ratio compares different things: a production maximum over
a mixed workload, and a local p95 for one request. It is not a measured
conversion factor.
- If it held, a 1× p95 of 10 ms would correspond to a production maximum
  of about 1,030 ms (about 1,970 ms under 3 s).
- A 4× p95 of 25 ms would correspond to about 2,575 ms (about 425 ms under
  3 s).
- The ratio is anchored on the local p95, so it is not applied to the local
  maxima; that would count the production tail twice.

Whether production time scales with work at all is unverified (sections 6
and 7). A production plan capture, or the post-deploy `pg_stat_statements`
window in the Stage 4 runbook, would test it.

## 9. Optional production plan capture (prepared, not run)

`2026-10-search-public-observations/production-plan-capture.sql` is the
bounded capture the Stage 1b human gate may approve. It exists only to be
reviewed. Nothing runs it unless the owner gives that separate approval, and
then only the owner runs it. Its header states the allowed operation, the two
checks the owner makes (that postgres may `LOAD` and `SET LOCAL` the
`auto_explain` settings, and that the nested plans appear in the Supabase
Postgres logs for the session), the stop condition, and what to return. It
makes three calls: Microscopy `true` at offsets 0 and 30, and `false` at
offset 0. The default page 1 is the same request as the first, so the fourth
allowed call is not used. Each call returns a count, not rows.
