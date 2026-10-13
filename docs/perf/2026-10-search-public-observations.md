# `search_public_observations`: Stage 1b local evidence

Plan: `docs/plans/active/2026-10-13-search-public-observations-performance.md`,
Stage 1b. Harness: `docs/perf/2026-10-search-public-observations/`.

**Status: harness prepared, local measurements not yet run.** The stage agent
could not run any SQL file against the isolated database: in its session,
every `docker exec -i supabase_db_sporely-stage1b-f92d560 psql … < docs/perf/2026-10-search-public-observations/*.sql`
command, including the exact allow-listed form, was refused as needing
approval. No SQL in this directory has been executed yet. Sections 5–8 are
placeholders until the run in section 4 is done.

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

**Not yet checked (needs SQL):** 128 applied migrations, `20260914090000`
absent, an empty `observations` table, the function hash, and that
`auto_explain` is preloaded. `isolation-check.sql` prints all of them; it is
the first file to run.

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

All files run as postgres through `psql` against the isolated container only:

```
docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
  < docs/perf/2026-10-search-public-observations/<file>.sql
```

(`function-calls.sql` reads best with `-At`.)

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
- `plans.sql`: per-node time and buffers of the body as it really runs
  (`auto_explain`, nested statements), for 11 representative scenarios.
- `plans-prepared.sql`: the body from `pg_proc.prosrc`, prepared and run under
  `force_generic_plan` and `force_custom_plan`.

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

Not yet run.

## 6. Report

Not yet written. To cover, from section 5: where the time goes; growth from 1×
to 2× to 4× and with offset; indexes used and ignored; distance from 3 s per
scenario; whether the local plans plausibly match production (compare local
buffers per call and the anon mean of 236.9 ms and 11,843 buffers against the
1× results); and the sensitivity run.

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

## 8. Proposed Stage 3 thresholds

Not yet proposed: every number needs the section 5 measurements. The
structure the plan requires:
- **Eligibility filtering and pagination (phase 1):** p95 and maximum per
  scenario at 1× and 4× and at offsets 0, 30 and 300; shared buffers per call;
  `metadata_microscope_parent_is_public` calls per candidate; allowed growth
  from 1× to 4×.
- **Enrichment (phase 2):** cost per returned row; `community_contributor_label`
  (and any enrichment-time `metadata_microscope_parent_is_public`) calls per
  returned row; near-zero growth from 1× to 4× at a fixed page size.
- **Overall:** end-to-end p95 and maximum per scenario, each with a stated
  margin under 3 s.

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
