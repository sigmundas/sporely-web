# Batch spore previews: database work and latency (local)

Plan: `docs/plans/completed/2026-10-10-batch-spore-preview-rpc.md`, Stage 2.
Date: 2026-10-11. **Local database only, synthetic fixtures.** No production
connection was used and no production data was read.

Compared, for the same ids, as the `anon` role:

- **(a)** one `get_public_observation_spore_previews(ids)` call;
- **(b)** one `get_public_observation(id)` call per id, which is what the
  `sporely-landing` Cards view does today (`rpcCall`, `POST`, JSON body,
  `OBSERVATION_DETAIL_CONCURRENCY = 6`).

(b) is measured twice:

- **(b)** with `20261012100000` applied, which is what production will have
  after Stage 3;
- **(b-today)** with the pre-migration definitions of `get_public_observation`
  and `_get_public_observation_stage2a`, restored from the applied
  migrations. That is what production runs now.

All figures below are for the current candidate's batch function. Earlier
candidates are summarized in "Design history". Their raw output is in this
file at `33f9865` and `5fa6240`.

## Verdict

| Pass condition | Result |
|---|---|
| (a) does less total database work (time and buffers) than (b) | **Pass.** Warm, at 30 ids: 15.0 ms and 6,453 buffers, against (b-today) 82.4 ms and 13,252 buffers (−82 % time, −51 % buffers) and (b) 84.8 ms and 13,792 buffers. At 60 ids: 28.8 ms and 12,833 buffers, against (b-today) 157.6 ms and 26,447 (−82 %, −51 %) and (b) 171.4 ms and 27,527. |
| (a) wall-clock time is lower than (b) | **Pass**, one visitor on localhost, 15 repetitions, (b) at concurrency 6. At 30 ids, (a) is 22.1 ms median / 26.1 ms max, against (b-today) 29.9 / 34.0 and (b) 31.9 / 41.8. At 60 ids, (a) is 41.2 / 46.6 ms, against (b-today) 56.3 / 70.4 and (b) 57.3 / 75.0. (a)'s maximum is below (b-today)'s median at both sizes. With 4 or 8 simultaneous visitors, (a) is 6.2–12.4× faster. |
| (a) at 60 ids well under the 3 s anon statement timeout | **Pass.** 28.8 ms median and 31.5 ms max warm execution, 32.9 ms median cold: about 1 % of 3 s. The highest batch execution over the whole HTTP run, including 8-visitor load, was 85.5 ms (2.9 %). |

## Design of the current candidate

**One shared point source.** `private.public_observation_spore_point_rows(bigint[])`
is the only function that reads `spore_measurements`, `observation_images`
and `spore_measurement_mosaic_tiles` for points. It holds:

- the joins and every point gate (image deleted/purged,
  `image_type`/`metadata_microscope_parent_is_public`, public measurement
  type);
- the per-point normalization;
- the point order, as `point_ordinal`.

`private.public_observation_spore_points_raw` aggregates its rows for
`get_public_observation`. The batch calls it once for all spore-public
eligible ids, and builds the card-key point objects directly. `cropUrl` is the
same `build_worker_media_url(image id, 'thumb', image media_version)` call that
`authorize_spore_points` makes for `get_public_observation`. It is computed
once per image, because its arguments depend only on the image.

Eligibility and the mosaic path are unchanged shared helpers, including the
`OFFSET 0` mosaic fence and the fail-closed `media_authorize_mosaic_delivery`
check.

**Point order.** Both readers aggregate `ORDER BY point_ordinal`, which is
`row_number() OVER (PARTITION BY observation ORDER BY image id, measurement id)`.
The order is defined once and does not depend on the plan. Before this
migration the point aggregate had no `ORDER BY`. The table below shows how its
order behaves on the 260 eligible fixtures (`order-vs-old.sh`):

| Old `get_public_observation`, compared with the new order | Observations whose point order differs |
|---|---|
| default plan (index nested loops), freshly inserted rows | **0** of 260 |
| hash-join plan (`enable_nestloop`/`enable_mergejoin` off) | **198** of 260 |
| after an `UPDATE` of an unindexed column of one point in each of 20 observations (0 of them HOT, so the rows moved pages) | 20 |
| after also an `UPDATE` of an indexed column (`thumb_key`) of one point in each of 20 more | 40 (cumulative) |

The old order is the plan's index-entry order. It equals id order for rows
that were never moved. It changes with the plan, and after any update that
moves a row; the new order changes in neither case.

**`get_public_observation`'s output is unchanged wherever its old order was
id order.** That is every row in the identity test, including after the
rows are physically moved with HOT updates. **It can differ for production
observations whose rows were moved by updates since insertion, or whose plan
was not index nested loops.** There, the old order was an accident of physical
layout. No `ORDER BY` can reproduce it: a HOT update leaves the index entry
pointing at the row's original slot, so not even current ctid order matches
it. This is the one place where "byte-identical" holds only for the usual case
(see "Decision for the owner" below).

**Owner decision, 2026-10-11: approved.** `get_public_observation`'s point
order becomes image id, then measurement id. This is an explicit exception
to the unchanged-output requirement, limited to the order of `sporePoints`.
Consequences:
- Landing Cards can show a different first 16 points for affected
  observations.
- A single call is 3–12 % slower locally (see "Database work").

The alternatives that were offered:

- keep the batch on the slow composed route, which failed the wall-clock
  condition;
- accept a batch order that can disagree with `get_public_observation` whenever
  their plans differ.

**Security:** the security-review verdict for the Stage 1 candidate
(`4f7f254`) does not cover this function body, nor the new
`spore_point_rows` helper. It must be renewed on this candidate.

## Design history

1. **Stage 1 (`4f7f254`).** The batch composed `spore_points_raw` and
   `authorize_spore_points`, then reduced each point to the card keys. A
   pulled-up subquery re-ran those helpers once per reference: points were
   built 3× and mosaics 5×, and `build_worker_media_url` ran 6,462 times for
   2,154 points. At 30 ids it took 138 ms against 82 ms warm, with 32,381
   against 13,389 buffers.
2. **`OFFSET 0` fence (`be77878`).** Work fell below (b): 55 ms against 87 ms
   warm, and 10,852 against 13,626 buffers. Wall-clock for one visitor still
   failed: 61.9 ms against 29.3 ms at 30 ids. Each point was built three times
   (raw, authorized, reduced), and `build_worker_media_url` ran once per point.
3. **Single pass with mirrored gates (`5f07eeb`).** 14 ms, and the
   wall-clock condition passed. But the batch repeated the point gates in its
   own query, and its point order came from its own plan. Review sent it back
   on both points.
4. **This candidate.** It has the shared `spore_point_rows` source and an
   explicit `point_ordinal`. It keeps the single pass and the per-image
   `cropUrl`. Its cost is within about 1 ms of (3): 15.0 against 14.0 ms at 30
   ids.

## Fixtures

`docs/perf/2026-10-batch-spore-preview/seed.sql` is deterministic, synthetic,
and has no real personal data. It holds:

- 260 eligible public spore-bearing observations. Each has 20–120 public spore
  points (mean 70) over 1–3 microscope images, 2 field images, 3 non-public
  `cystidia` measurements, and a mosaic whose latest version has tiles for up
  to 48 points. Half have two mosaic versions.
- 50 ineligible decoys with the same spore data: private, friends-only, draft,
  `spore_data_visibility = private`, and banned owner, 10 of each.
- 2,000 background public observations with no microscopy.
- Totals: 2,310 observations, 3,240 images, 22,609 measurements.

The request lists are every 4th eligible observation in id order. The first 30
carry **2,154** points and the first 60 carry **4,289**.

Environment: Apple M5, Docker with 10 CPUs. The local Supabase stack runs
PostgreSQL 17.6, PostgREST v14.4 with the default pool of 10, and Kong 2.8.1.
Settings: `shared_buffers=128MB`, `work_mem=4MB`, `jit=on`; JIT made no
measurable difference. Every run is fully cached, so shared reads are 0
throughout.

## Commands

```bash
supabase db reset --local
supabase test db supabase/tests/public_observation_spore_previews_test.sql \
  supabase/tests/public_observation_spore_previews_eval_count_test.sql \
  supabase/tests/public_observation_spore_previews_order_test.sql \
  supabase/tests/mosaic_storage_key_ownership_test.sql
bash supabase/tests/public_observation_spore_previews_identity_test.sh

DB=supabase_db_zkpjklzfwzefhjluvhfw
P=docs/perf/2026-10-batch-spore-preview
docker exec -i $DB psql -U postgres -v ON_ERROR_STOP=1 < $P/seed.sql
docker exec -i $DB psql -U postgres -X -At -v ON_ERROR_STOP=1 < $P/parity.sql
bash $P/order-vs-old.sh

node $P/bench-db.mjs $DB 10
bash $P/baseline-today.sh > /tmp/today.sql
BASELINE_SQL=/tmp/today.sql node $P/bench-db.mjs $DB 10
docker exec -i $DB psql -U postgres -X -At -v ON_ERROR_STOP=1 < $P/function-calls.sql
docker exec -i $DB psql -U postgres -X -v ON_ERROR_STOP=1 < $P/plans.sql

bash $P/baseline-today.sh --as-copies | docker exec -i $DB psql -U postgres -q -v ON_ERROR_STOP=1
docker exec -i $DB psql -U postgres -At -c "select pg_stat_statements_reset() is not null"
IDS=$(docker exec -i $DB psql -U postgres -At -c "select json_agg(observation_id order by ordinal) from perf_bsp.ids")
eval "$(supabase status -o env | grep -E '^(API_URL|PUBLISHABLE_KEY)=')"
SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$PUBLISHABLE_KEY TODAY_RPC=zz_today_get_public_observation \
  node $P/bench-http.mjs "$IDS" 15
docker exec -i $DB psql -U postgres < $P/statements.sql
docker exec -i $DB psql -U postgres -c "DROP FUNCTION public.zz_today_get_public_observation(bigint); DROP FUNCTION public.zz_today_stage2a(bigint); NOTIFY pgrst, 'reload schema';"

docker exec -i $DB psql -U postgres -v ON_ERROR_STOP=1 < $P/cleanup.sql
```

## Parity (`parity.sql`)

Every seeded observation went through the batch in chunks of up to 60 ids, as
anon: 260 eligible and 50 decoys. The result was compared with
`get_public_observation`, reduced to the card keys in its own point order, and
with its mosaic minus `url`:

```
rows batch/single|270|270|points|18209|mismatches|0
```

The 270 rows are the 260 eligible observations plus the 10
`spore_data_visibility = private` decoys. Those 10 have NULL `points` and
`spore_mosaic`, as `get_public_observation` returns the row without spore
data. The other 40 decoys are absent from both. Order parity under shuffled
physical order and four forced plan shapes is a pgTAP test; see "Tests".

## Database work: `EXPLAIN (ANALYZE, BUFFERS)` (`bench-db.mjs`)

There were 10 repetitions per configuration. Each repetition opens a fresh
backend per case and runs the case twice. **Cold** is the first run in that
backend, when the function plan caches are empty. **Warm** is the second, which
is what a reused PostgREST pool connection sees. For (b), the figures are the
sum over the 30 or 60 single-call plans. The buffers on the top-level Function
Scan include all nested function calls; the inner plan below has the same
12,833 buffers as the outer node.

Medians, with the maximum in brackets:

| ids | case | run | planning ms | execution ms | shared hit | shared read |
|---|---|---|---|---|---|---|
| 30 | (a) batch | warm | 0.01 | **15.0** (16.4) | **6,453** | 0 |
| 30 | (b-today) 30 singles | warm | 0.22 | **82.4** (88.9) | **13,252** | 0 |
| 30 | (b) 30 singles | warm | 0.18 | 84.8 (106.6) | 13,792 | 0 |
| 30 | (a) batch | cold | 0.03 | 18.9 (21.9) | 8,810 | 0 |
| 30 | (b-today) 30 singles | cold | 0.22 | 84.9 (93.7) | 14,493 | 0 |
| 30 | (b) 30 singles | cold | 0.22 | 94.7 (100.0) | 16,372 | 0 |
| 60 | (a) batch | warm | 0.01 | **28.8** (31.5) | **12,833** | 0 |
| 60 | (b-today) 60 singles | warm | 0.40 | **157.6** (192.6) | **26,447** | 0 |
| 60 | (b) 60 singles | warm | 0.37 | 171.4 (244.9) | 27,527 | 0 |
| 60 | (a) batch | cold | 0.02 | 32.9 (36.1) | 15,190 | 0 |
| 60 | (b-today) 60 singles | cold | 0.41 | 164.2 (185.3) | 27,688 | 0 |
| 60 | (b) 60 singles | cold | 0.41 | 181.5 (246.7) | 30,107 | 0 |

Buffer counts are identical in every repetition. With the migration applied,
(b) is 3–12 % slower than (b-today), because `get_public_observation` now
reads its points through `spore_point_rows` and sorts them by `point_ordinal`.

### Where the work is (per point)

The 60-id nested plan is below. `spore_point_rows` takes 8.4 ms and 11,743 of
the 12,833 buffers: the gated point join for 4,289 points, with most buffers
in the per-point tile index probes, which (b) also makes. Building the
4,289 card objects (`GroupAggregate`) takes about 16 ms. The per-image
`cropUrl` takes 120 `build_worker_media_url` calls, 1.2 ms. The mosaic helpers
and delivery authorization use about 900 buffers.

`build_worker_media_url` dominates neither path now. (a) makes 60 calls at
30 ids, 0.7 ms in total. (b) still makes one call per point, 2,154 calls and
10.8 ms, inside `authorize_spore_points`.

### Per-function work (`function-calls.sql`)

`track_functions = 'all'` with `pg_stat_xact_user_functions`, one run per case
in a fresh backend, migration applied. Times include the tracking overhead.

| | (a) 30 | (b) 30 | (a) 60 | (b) 60 |
|---|---|---|---|---|
| `public_observation_spore_point_rows` calls / ms | 1 / 8.7 | 30 / 9.5 | 1 / 9.3 | 60 / 18.0 |
| `public_observation_spore_points_raw` calls | 0 | 30 | 0 | 60 |
| `public_observation_authorize_spore_points` calls / ms | 0 | 30 / 29.5 | 0 | 60 / 56.6 |
| `build_worker_media_url` calls / ms | 60 / 0.7 | 2,154 / 10.8 | 120 / 0.8 | 4,289 / 20.8 |
| `public_observation_eligibility` calls | 1 | 30 | 1 | 60 |
| top-level total ms | 31.1 | 88.3 | 32.2 | 165.2 |

The (a) 30 total of 31.1 ms is a cold first run in its backend: function and
plan caches are empty. Its own work (self 16.5 ms) is the card-object
aggregation.

## Wall-clock through local PostgREST (`bench-http.mjs`)

The client is Node `fetch` going to Kong (`127.0.0.1:54321`), then PostgREST,
then Postgres. Each case runs 15 times after one unrecorded warm-up round, with
the case order rotated every round. Times are in ms. (b-today) calls a
temporary renamed copy of the pre-migration functions,
`zz_today_get_public_observation`, which was dropped afterwards.

| ids | case | requests | median | max | per-request median |
|---|---|---|---|---|---|
| 30 | (a) batch | 1 | **22.1** | **26.1** | 22.1 |
| 30 | (b-today) concurrency 6 | 30 | **29.9** | **34.0** | 5.3 |
| 30 | (b) concurrency 6 | 30 | 31.9 | 41.8 | 5.8 |
| 30 | (b-today) concurrency 2 | 30 | 65.4 | 70.1 | 4.2 |
| 30 | (b) concurrency 2 | 30 | 65.9 | 70.2 | 4.3 |
| 60 | (a) batch | 1 | **41.2** | **46.6** | 41.2 |
| 60 | (b-today) concurrency 6 | 60 | **56.3** | **70.4** | 5.3 |
| 60 | (b) concurrency 6 | 60 | 57.3 | 75.0 | 5.4 |
| 60 | (b-today) concurrency 2 | 60 | 127.5 | 183.8 | 4.1 |
| 60 | (b) concurrency 2 | 60 | 129.6 | 141.2 | 4.2 |

**Why the single-visitor gain is about 26 %.** Compared with (b-today) at
concurrency 6, (a) is 26 % faster at 30 ids and 27 % at 60, while doing 82 %
less database work. The work in (b) runs on six backends in parallel on idle
cores, with a round trip close to 0 ms, which favours (b). (a) runs on one
backend, and its HTTP time is its execution time (15 / 29 ms) plus about 7–12 ms
for PostgREST, Kong and serializing 2,154 or 4,289 points. Any real network
round trip would add about 5 sequential waves (30 ids) or 10 (60 ids) to (b),
against one to (a). That part is not measured here.

**Load:** V visitors open the Cards view at the same moment. The table shows
each visitor's own time. The last column is how many requests the clients allow
in flight at most. It is not a measured database concurrency, because
PostgREST's pool of 10 connections bounds that.

| V | ids | (a) median / max | (b-today) conc. 6 median / max | (b) conc. 6 median / max | client requests in flight at most, (a) / (b) |
|---|---|---|---|---|---|
| 4 | 30 | **25.2** / 33.3 | 163.6 / 193.4 | 161.1 / 186.8 | 4 / 24 |
| 4 | 60 | **51.4** / 102.4 | 318.3 / 362.0 | 326.6 / 372.7 | 4 / 24 |
| 8 | 30 | **38.6** / 86.0 | 444.9 / 1,014.1 | 443.6 / 673.1 | 8 / 48 |
| 8 | 60 | **72.6** / 108.7 | 900.5 / 1,084.0 | 887.7 / 1,096.6 | 8 / 48 |

**Concurrency 2 against 6, for `sporely-landing`'s incident doc.** For one
visitor, the per-request median is flat: 4.2 ms at concurrency 2 against
5.3 ms at concurrency 6 (b-today). Total time scales with the number of waves.
So locally, with one visitor, the cost of (b) is the cost of each call, not
contention. Contention appears once visitors overlap, as the load table shows.
This evidence does not support changing `OBSERVATION_DETAIL_CONCURRENCY`, and
it stays unchanged.

### RPC request counts and total query cost (`statements.sql`)

These are `pg_stat_statements` figures over the whole `bench-http.mjs` run,
including the load scenarios, reset immediately before it. The figures are
normalized per observation id requested, because PostgREST's normalized
statement does not separate 30-id from 60-id calls. The run requested 196 batch
calls at each size, which is 17,640 ids, and 19,080 calls of each single
variant.

| rpc | calls | ids served | total exec ms | exec ms per id | shared hit per id | shared read | max exec ms |
|---|---|---|---|---|---|---|---|
| batch | 392 | 17,640 | 14,969 | **0.85** | **215** | 0 | 85.5 |
| single today | 19,080 | 19,080 | 122,903 | **6.44** | **441** | 0 | 238.2 |
| single (migrated) | 19,080 | 19,080 | 122,917 | 6.44 | 460 | 0 | 111.2 |

Per Cards-view load, the batch makes 1 request instead of 30 or 60. Its
database time per observation is 0.85 ms against 6.44 ms, and its buffers per
observation 215 against 441.

## Distance from the 3-second anon statement timeout

At 60 ids, the maximum allowed:

- Execution is 28.8 ms median and 31.5 ms max warm, and 32.9 ms median and
  36.1 ms max cold. That is **about 1 % of 3 s**.
- Wall-clock is 41.2 ms median and 46.6 ms max for one visitor. The worst
  figure is 108.7 ms with 8 simultaneous visitors.
- The batch's highest `pg_stat_statements` execution over the whole run is
  85.5 ms.

Scaling: execution is about 6.7 µs per returned point, close to linear (about
15 ms for 2,154 points, about 29 ms for 4,289). At that rate, 3 s would take
about 450,000 points in one call, about 7,500 per observation across 60. By
design, the function does not cap points on the server. The fixtures average
70 points per observation. The production distribution was not measured,
because there was no production access. Cold disk reads would add time on a
cold production cache. Stage 3's `pg_stat_statements` baseline is where to
confirm the margin in production.

## Tests for this candidate

On a fresh `supabase db reset --local`:

- **pgTAP, 119 tests, all passing:**
  - `public_observation_spore_previews_test.sql` (61): the Stage 1 visibility
    matrix, parity, bounds, grants and shape. Its helper count is now six. Its
    shape test also covers the new helper: SECURITY DEFINER, empty
    `search_path`, and not executable by client roles.
  - `public_observation_spore_previews_eval_count_test.sql` (9): the batch
    reads points through one `spore_point_rows` call and never calls
    `spore_points_raw` or `authorize_spore_points`. The mosaic helpers and
    delivery authorization run once per observation, and
    `build_worker_media_url` once per image (6 for 12 points). Neither the
    batch nor `spore_points_raw` names a point table; `spore_point_rows`
    does.
  - `public_observation_spore_previews_order_test.sql` (11): physical order is
    shuffled with updates, and the fixture assertion checks ctid order then
    differs from id order. Both readers are compared under four plan shapes:
    default, sequential scans only, hash joins only and merge joins only.
    Batch order equals `get_public_observation` under each shape. Neither
    reader's order changes between shapes. The order is image id, then
    measurement id. A control shows that an unordered aggregate under the hash
    shape does return a different order, so the shapes reached the point
    query.
  - `mosaic_storage_key_ownership_test.sql` (38).
- **`public_observation_spore_previews_identity_test.sh`:**
  `get_public_observation` and `_get_public_observation_stage2a` are
  byte-identical before and after the migration, over 42 visible rows. This
  holds after the first image and first measurement of each observation are
  moved with HOT updates. A guard checks that their ctid order then differs
  from id order.
- **`observation_spore_mosaic_rpc_test.sql`**, a plain psql script: passes.

Mutation checks. Each mutation was applied with `CREATE OR REPLACE` inside a
rolled-back transaction, and the named test bodies were run against it:

| Mutation | Result |
|---|---|
| `spore_point_rows` ordered by ctid | order test, 2 failures |
| `spore_point_rows` drops `AND i.deleted_at IS NULL` | Stage 1 tests, 2 failures. Both readers share it, so this is a visibility failure, not a parity one. |
| `spore_point_rows` drops the metadata-parent gate | Stage 1 tests, 3 failures |
| the batch joins `observation_images` itself | eval-count structure test, 1 failure |
| the batch computes `cropUrl` per point (no `DISTINCT`) | eval-count, 2 failures |
| the batch, or `spore_points_raw`, without `ORDER BY point_ordinal` | **not caught.** `spore_point_rows` already emits rows in `point_ordinal` order through its window sort, so the consumers' `ORDER BY` is a second safeguard. The order is decided in `spore_point_rows`, and the first mutation shows changing it there is caught. |

## Raw output

### `parity.sql`

```
rows batch/single|270|270|points|18209|mismatches|0
```

### `order-vs-old.sh`

```
HOT updates among those 20|0
eligible observations|260
differs from new: old default plan|0
differs from new: old hash plan|198
differs from new: old after unindexed-column update|20
differs from new: old after indexed-column update|40
```

### `bench-db.mjs` (10 repetitions, migration applied)

```
raw: rep n case statements | cold planning execution hit read rows | warm planning execution hit read rows
1 30 a 1 | 0.08 21.94 8810 0 30 | 0.01 16.15 6453 0 30
1 30 b 30 | 0.23 96.99 16372 0 30 | 0.22 101.73 13792 0 30
1 60 a 1 | 0.03 35.58 15190 0 60 | 0.02 29.64 12833 0 60
1 60 b 60 | 0.43 189.71 30107 0 60 | 0.45 180.40 27527 0 60
2 30 b 30 | 0.22 90.64 16372 0 30 | 0.17 83.39 13792 0 30
2 30 a 1 | 0.03 18.87 8810 0 30 | 0.01 15.11 6453 0 30
2 60 b 60 | 0.42 182.21 30107 0 60 | 0.37 167.22 27527 0 60
2 60 a 1 | 0.02 32.88 15190 0 60 | 0.02 29.65 12833 0 60
3 30 a 1 | 0.03 18.98 8810 0 30 | 0.01 14.74 6453 0 30
3 30 b 30 | 0.22 92.91 16372 0 30 | 0.18 84.69 13792 0 30
3 60 a 1 | 0.02 33.06 15190 0 60 | 0.01 31.51 12833 0 60
3 60 b 60 | 0.54 246.73 30107 0 60 | 0.52 244.91 27527 0 60
4 30 b 30 | 0.25 99.18 16372 0 30 | 0.27 106.57 13792 0 30
4 30 a 1 | 0.03 21.28 8810 0 30 | 0.01 16.41 6453 0 30
4 60 b 60 | 0.45 192.63 30107 0 60 | 0.35 168.69 27527 0 60
4 60 a 1 | 0.02 32.93 15190 0 60 | 0.02 28.84 12833 0 60
5 30 a 1 | 0.03 18.57 8810 0 30 | 0.01 14.73 6453 0 30
5 30 b 30 | 0.21 90.08 16372 0 30 | 0.17 84.81 13792 0 30
5 60 a 1 | 0.02 33.26 15190 0 60 | 0.01 28.39 12833 0 60
5 60 b 60 | 0.37 172.54 30107 0 60 | 0.32 163.13 27527 0 60
6 30 b 30 | 0.20 89.02 16372 0 30 | 0.16 82.23 13792 0 30
6 30 a 1 | 0.02 18.25 8810 0 30 | 0.00 14.88 6453 0 30
6 60 b 60 | 0.38 169.87 30107 0 60 | 0.33 158.66 27527 0 60
6 60 a 1 | 0.02 31.85 15190 0 60 | 0.00 28.03 12833 0 60
7 30 a 1 | 0.03 19.11 8810 0 30 | 0.02 15.49 6453 0 30
7 30 b 30 | 0.23 96.53 16372 0 30 | 0.21 104.14 13792 0 30
7 60 a 1 | 0.03 36.08 15190 0 60 | 0.02 31.09 12833 0 60
7 60 b 60 | 0.40 180.82 30107 0 60 | 0.38 175.49 27527 0 60
8 30 b 30 | 0.25 99.96 16372 0 30 | 0.19 90.25 13792 0 30
8 30 a 1 | 0.02 18.54 8810 0 30 | 0.01 14.97 6453 0 30
8 60 b 60 | 0.39 176.72 30107 0 60 | 0.42 174.20 27527 0 60
8 60 a 1 | 0.02 32.50 15190 0 60 | 0.01 28.66 12833 0 60
9 30 a 1 | 0.02 18.39 8810 0 30 | 0.01 14.75 6453 0 30
9 30 b 30 | 0.22 88.63 16372 0 30 | 0.17 84.07 13792 0 30
9 60 a 1 | 0.02 31.86 15190 0 60 | 0.01 27.92 12833 0 60
9 60 b 60 | 0.35 169.04 30107 0 60 | 0.31 159.53 27527 0 60
10 30 b 30 | 0.23 97.15 16372 0 30 | 0.18 84.04 13792 0 30
10 30 a 1 | 0.04 19.25 8810 0 30 | 0.02 15.83 6453 0 30
10 60 b 60 | 0.45 197.99 30107 0 60 | 0.47 181.23 27527 0 60
10 60 a 1 | 0.02 32.66 15190 0 60 | 0.01 28.62 12833 0 60

summary (median / max over reps; times ms, buffers = 8 kB pages)
n case run   | planning med/max | execution med/max | shared hit med/max | shared read med/max | rows
30 a cold  | 0.03 / 0.08 | 18.93 / 21.94 | 8810.00 / 8810.00 | 0.00 / 0.00 | 30
30 a warm  | 0.01 / 0.02 | 15.04 / 16.41 | 6453.00 / 6453.00 | 0.00 / 0.00 | 30
30 b cold  | 0.22 / 0.25 | 94.72 / 99.96 | 16372.00 / 16372.00 | 0.00 / 0.00 | 30
30 b warm  | 0.18 / 0.27 | 84.75 / 106.57 | 13792.00 / 13792.00 | 0.00 / 0.00 | 30
60 a cold  | 0.02 / 0.03 | 32.90 / 36.08 | 15190.00 / 15190.00 | 0.00 / 0.00 | 60
60 a warm  | 0.01 / 0.02 | 28.75 / 31.51 | 12833.00 / 12833.00 | 0.00 / 0.00 | 60
60 b cold  | 0.41 / 0.54 | 181.51 / 246.73 | 30107.00 / 30107.00 | 0.00 / 0.00 | 60
60 b warm  | 0.37 / 0.52 | 171.44 / 244.91 | 27527.00 / 27527.00 | 0.00 / 0.00 | 60
```

### `BASELINE_SQL=… bench-db.mjs` (10 repetitions, pre-migration `get_public_observation`; use the (b) rows)

```
raw: rep n case statements | cold planning execution hit read rows | warm planning execution hit read rows
1 30 a 1 | 0.01 20.41 7889 0 30 | 0.01 15.61 6453 0 30
1 30 b 30 | 0.26 85.85 14493 0 30 | 0.28 82.23 13252 0 30
1 60 a 1 | 0.01 32.40 14269 0 60 | 0.01 47.50 12833 0 60
1 60 b 60 | 0.54 185.33 27688 0 60 | 0.48 164.91 26447 0 60
2 30 b 30 | 0.25 88.60 14493 0 30 | 0.22 83.40 13252 0 30
2 30 a 1 | 0.00 17.89 7889 0 30 | 0.01 15.91 6453 0 30
2 60 b 60 | 0.48 169.55 27688 0 60 | 0.41 160.45 26447 0 60
2 60 a 1 | 0.00 31.57 14269 0 60 | 0.01 29.23 12833 0 60
3 30 a 1 | 0.00 17.64 7889 0 30 | 0.01 14.87 6453 0 30
3 30 b 30 | 0.22 89.68 14493 0 30 | 0.24 86.52 13252 0 30
3 60 a 1 | 0.00 32.06 14269 0 60 | 0.01 28.88 12833 0 60
3 60 b 60 | 0.44 164.20 27688 0 60 | 0.39 156.73 26447 0 60
4 30 b 30 | 0.21 83.95 14493 0 30 | 0.21 80.20 13252 0 30
4 30 a 1 | 0.01 18.48 7889 0 30 | 0.01 15.19 6453 0 30
4 60 b 60 | 0.41 162.49 27688 0 60 | 0.41 156.76 26447 0 60
4 60 a 1 | 0.00 31.61 14269 0 60 | 0.02 29.88 12833 0 60
5 30 a 1 | 0.00 17.29 7889 0 30 | 0.01 14.88 6453 0 30
5 30 b 30 | 0.20 81.18 14493 0 30 | 0.28 84.79 13252 0 30
5 60 a 1 | 0.00 33.54 14269 0 60 | 0.02 30.52 12833 0 60
5 60 b 60 | 0.41 162.20 27688 0 60 | 0.38 158.37 26447 0 60
6 30 b 30 | 0.19 82.74 14493 0 30 | 0.20 79.84 13252 0 30
6 30 a 1 | 0.00 18.41 7889 0 30 | 0.02 15.07 6453 0 30
6 60 b 60 | 0.41 162.72 27688 0 60 | 0.67 192.63 26447 0 60
6 60 a 1 | 0.00 38.15 14269 0 60 | 0.02 33.05 12833 0 60
7 30 a 1 | 0.00 21.60 7889 0 30 | 0.02 16.86 6453 0 30
7 30 b 30 | 0.28 93.69 14493 0 30 | 0.31 88.94 13252 0 30
7 60 a 1 | 0.01 35.12 14269 0 60 | 0.03 31.95 12833 0 60
7 60 b 60 | 0.41 164.25 27688 0 60 | 0.38 155.74 26447 0 60
8 30 b 30 | 0.21 81.62 14493 0 30 | 0.21 81.64 13252 0 30
8 30 a 1 | 0.00 17.11 7889 0 30 | 0.01 14.89 6453 0 30
8 60 b 60 | 0.56 166.61 27688 0 60 | 0.51 172.88 26447 0 60
8 60 a 1 | 0.00 32.73 14269 0 60 | 0.02 29.04 12833 0 60
9 30 a 1 | 0.00 20.29 7889 0 30 | 0.01 14.89 6453 0 30
9 30 b 30 | 0.20 79.95 14493 0 30 | 0.19 78.26 13252 0 30
9 60 a 1 | 0.01 47.06 14269 0 60 | 0.03 29.48 12833 0 60
9 60 b 60 | 0.40 164.52 27688 0 60 | 0.37 153.14 26447 0 60
10 30 b 30 | 0.27 88.23 14493 0 30 | 0.22 82.66 13252 0 30
10 30 a 1 | 0.00 16.75 7889 0 30 | 0.01 14.65 6453 0 30
10 60 b 60 | 0.37 155.48 27688 0 60 | 0.37 154.18 26447 0 60
10 60 a 1 | 0.00 31.43 14269 0 60 | 0.01 29.26 12833 0 60

summary (median / max over reps; times ms, buffers = 8 kB pages)
n case run   | planning med/max | execution med/max | shared hit med/max | shared read med/max | rows
30 a cold  | 0.00 / 0.01 | 18.15 / 21.60 | 7889.00 / 7889.00 | 0.00 / 0.00 | 30
30 a warm  | 0.01 / 0.02 | 14.98 / 16.86 | 6453.00 / 6453.00 | 0.00 / 0.00 | 30
30 b cold  | 0.22 / 0.28 | 84.90 / 93.69 | 14493.00 / 14493.00 | 0.00 / 0.00 | 30
30 b warm  | 0.22 / 0.31 | 82.44 / 88.94 | 13252.00 / 13252.00 | 0.00 / 0.00 | 30
60 a cold  | 0.00 / 0.01 | 32.56 / 47.06 | 14269.00 / 14269.00 | 0.00 / 0.00 | 60
60 a warm  | 0.02 / 0.03 | 29.68 / 47.50 | 12833.00 / 12833.00 | 0.00 / 0.00 | 60
60 b cold  | 0.41 / 0.56 | 164.23 / 185.33 | 27688.00 / 27688.00 | 0.00 / 0.00 | 60
60 b warm  | 0.40 / 0.67 | 157.57 / 192.63 | 26447.00 / 26447.00 | 0.00 / 0.00 | 60
```

### `function-calls.sql` (label | rows | function | calls | total ms | self ms)

```
a30|30|public.get_public_observation_spore_previews|1|31.1|16.5
a30|30|private.public_observation_spore_point_rows|1|8.7|8.7
a30|30|public.media_authorize_mosaic_delivery|30|2.3|2.3
a30|30|private.public_observation_eligibility|1|1.4|1.4
a30|30|private.public_observation_authorize_spore_mosaic|30|0.8|0.4
a30|30|private.public_observation_spore_mosaic_raw|30|0.8|0.8
a30|30|public.build_worker_media_url|60|0.7|0.4
a30|30|public.build_worker_mosaic_url|30|0.4|0.3
a30|30|public._media_worker_base_url|90|0.3|0.3
a30|30|public.media_variant_is_supported|60|0.1|0.1
b30|30|public.get_public_observation|30|88.3|0.5
b30|30|public._get_public_observation_stage2a|30|56.7|26.4
b30|30|private.public_observation_authorize_spore_points|30|29.5|18.7
b30|30|private.public_observation_spore_points_raw|30|24.2|14.7
b30|30|public.build_worker_media_url|2154|10.8|5.5
b30|30|private.public_observation_spore_point_rows|30|9.5|9.5
b30|30|public._media_worker_base_url|2184|3.3|3.3
b30|30|private.public_observation_eligibility|30|3.1|3.1
b30|30|public.media_variant_is_supported|2154|2.1|2.1
b30|30|private.public_observation_spore_mosaic_raw|30|1.6|1.6
b30|30|private.public_observation_authorize_spore_mosaic|30|1.6|1.4
b30|30|public.community_contributor_label|30|1.4|1.4
b30|30|public.build_worker_mosaic_url|30|0.3|0.2
a60|60|public.get_public_observation_spore_previews|1|32.2|18.3
a60|60|private.public_observation_spore_point_rows|1|9.3|9.3
a60|60|public.media_authorize_mosaic_delivery|60|1.6|1.6
a60|60|private.public_observation_authorize_spore_mosaic|60|0.8|0.4
a60|60|public.build_worker_media_url|120|0.8|0.4
a60|60|private.public_observation_spore_mosaic_raw|60|0.7|0.7
a60|60|private.public_observation_eligibility|1|0.7|0.7
a60|60|public.build_worker_mosaic_url|60|0.4|0.2
a60|60|public._media_worker_base_url|180|0.4|0.4
a60|60|public.media_variant_is_supported|120|0.1|0.1
b60|60|public.get_public_observation|60|165.2|0.9
b60|60|public._get_public_observation_stage2a|60|104.8|48.0
b60|60|private.public_observation_authorize_spore_points|60|56.6|35.8
b60|60|private.public_observation_spore_points_raw|60|46.1|28.1
b60|60|public.build_worker_media_url|4289|20.8|10.5
b60|60|private.public_observation_spore_point_rows|60|18.0|18.0
b60|60|public._media_worker_base_url|4349|6.3|6.3
b60|60|private.public_observation_eligibility|60|5.3|5.3
b60|60|public.media_variant_is_supported|4289|4.1|4.1
b60|60|private.public_observation_authorize_spore_mosaic|60|2.9|2.5
b60|60|private.public_observation_spore_mosaic_raw|60|2.8|2.8
b60|60|public.community_contributor_label|60|2.5|2.5
b60|60|public.build_worker_mosaic_url|60|0.4|0.2
```

### `plans.sql`

```
 count
-------
    60
(1 row)

 count
-------
     1
(1 row)

== (a) batch, 60 ids
                                                                                                                                                      QUERY PLAN
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Function Scan on public.get_public_observation_spore_previews  (cost=0.25..10.25 rows=1000 width=72) (actual time=28.639..28.641 rows=60 loops=1)
   Output: observation_id, points, spore_mosaic
   Function Call: get_public_observation_spore_previews('{109,113,117,121,125,129,133,137,141,145,149,153,157,161,165,169,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,233,237,241,245,249,253,257,261,265,269,273,277,281,285,289,293,297,301,305,309,313,317,321,325,329,333,337,341,345}'::bigint[])
   Buffers: shared hit=12833
 Query Identifier: -611025839880920760
 Planning Time: 0.005 ms
 Execution Time: 28.650 ms
(7 rows)

== (b) one single call (first id)
                                                                                                                                                                         QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Function Scan on public.get_public_observation  (cost=0.25..10.25 rows=1000 width=549) (actual time=3.040..3.040 rows=1 loops=1)
   Output: id, "speciesSlug", "speciesName", "speciesCommonName", "observerDisplayName", "observedOn", country, "regionId", "locationPrecision", "locationLabel", "hasMicroscopy", "sporeMeasurementCount", "sporeSummary", "sporePoints", "sporeMosaic", "contrastMethod", "mountReagent", "sampleType", "sampleSource", "prepSummary", "mapLat", "mapLon"
   Function Call: get_public_observation('109'::bigint)
   Buffers: shared hit=450
 Query Identifier: 7025787864066007552
 Planning Time: 0.015 ms
 Execution Time: 3.046 ms
(7 rows)

== (a) batch, 60 ids: nested RETURN QUERY plan (auto_explain)
LOG:  duration: 29.147 ms  plan:
Query Text: WITH eligible AS MATERIALIZED (
    SELECT e.observation_id, e.user_id, e.spore_data_public
    FROM private.public_observation_eligibility(p_observation_ids) e
  ),
  point_rows AS MATERIALIZED (
    SELECT r.*
    FROM private.public_observation_spore_point_rows(
      ARRAY(SELECT e.observation_id FROM eligible e WHERE e.spore_data_public)
    ) r
  ),
  crop_urls AS MATERIALIZED (
    SELECT
      img.image_id,
      public.build_worker_media_url(img.image_id, 'thumb', img.image_media_version) AS crop_url
    FROM (SELECT DISTINCT r.image_id, r.image_media_version FROM point_rows r) img
  ),
  points AS (
    -- Only the fields read by normalizeSporePoints (id, lengthUm and widthUm
    -- decide whether a point is kept), ObservationCard (crop geometry,
    -- cropUrl) and sporePointFilters (prep context) leave the server.
    SELECT
      r.observation_id,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'id',             r.measurement_id::text,
            'lengthUm',       r.length_um,
            'widthUm',        r.width_um,
            'cropUrl',        CASE WHEN r.thumb_key IS NOT NULL THEN u.crop_url ELSE NULL END,
            'contrastMethod', r.contrast_method,
            'mountReagent',   r.mount_reagent,
            'sampleType',     r.sample_type,
            'sampleSource',   r.sample_source,
            'mosaicX',        r.mosaic_x,
            'mosaicY',        r.mosaic_y,
            'mosaicW',        r.mosaic_w,
            'mosaicH',        r.mosaic_h
          )
        )
        ORDER BY r.point_ordinal
      ) AS points
    FROM point_rows r
    JOIN crop_urls u
      ON u.image_id = r.image_id
    GROUP BY r.observation_id
  )
  SELECT
    eligible.observation_id,
    points.points,
    CASE
      WHEN delivery.allowed IS TRUE
           AND authorized.spore_mosaic->>'mosaicMediaUrl' IS NOT NULL
        THEN authorized.spore_mosaic - 'url'
      ELSE NULL::jsonb
    END
  FROM eligible
  LEFT JOIN points
    ON points.observation_id = eligible.observation_id
  CROSS JOIN LATERAL (
    SELECT
      private.public_observation_authorize_spore_mosaic(
        eligible.observation_id,
        CASE
          WHEN eligible.spore_data_public
            THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id)
          ELSE NULL::jsonb
        END
      ) AS spore_mosaic
    -- Optimization fence: without it the planner pulls this subquery up and
    -- re-evaluates the mosaic helpers once per reference to
    -- authorized.spore_mosaic below.
    OFFSET 0
  ) authorized
  LEFT JOIN LATERAL public.media_authorize_mosaic_delivery(
    CASE
      WHEN pg_catalog.jsonb_typeof(authorized.spore_mosaic->'mosaicId') = 'number'
        THEN (authorized.spore_mosaic->>'mosaicId')::bigint
    END,
    auth.uid()
  ) delivery ON authorized.spore_mosaic IS NOT NULL
  ORDER BY eligible.observation_id
Nested Loop Left Join  (cost=301.46..18364.22 rows=995000 width=72) (actual time=11.262..29.095 rows=60 loops=1)
  Join Filter: ((private.public_observation_authorize_spore_mosaic(eligible.observation_id, CASE WHEN eligible.spore_data_public THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id) ELSE NULL::jsonb END)) IS NOT NULL)
  Buffers: shared hit=12833
  CTE eligible
    ->  Function Scan on public_observation_eligibility e  (cost=0.25..10.25 rows=1000 width=25) (actual time=0.139..0.140 rows=60 loops=1)
          Buffers: shared hit=70
  CTE point_rows
    ->  Function Scan on public_observation_spore_point_rows r_1  (cost=20.25..30.25 rows=1000 width=296) (actual time=8.378..8.460 rows=4289 loops=1)
          Buffers: shared hit=11743
          InitPlan 2
            ->  CTE Scan on eligible e_1  (cost=0.00..20.00 rows=500 width=8) (actual time=0.000..0.002 rows=60 loops=1)
                  Filter: spore_data_public
  CTE crop_urls
    ->  Subquery Scan on img  (cost=25.00..77.00 rows=200 width=40) (actual time=0.558..1.204 rows=120 loops=1)
          Buffers: shared hit=120
          ->  HashAggregate  (cost=25.00..27.00 rows=200 width=16) (actual time=0.499..0.505 rows=120 loops=1)
                Group Key: r_2.image_id, r_2.image_media_version
                Batches: 1  Memory Usage: 40kB
                ->  CTE Scan on point_rows r_2  (cost=0.00..20.00 rows=1000 width=16) (actual time=0.000..0.289 rows=4289 loops=1)
  ->  Nested Loop  (cost=183.66..741.16 rows=1000 width=72) (actual time=11.218..28.139 rows=60 loops=1)
        Buffers: shared hit=12353
        ->  Merge Left Join  (cost=183.66..221.16 rows=1000 width=57) (actual time=11.050..26.874 rows=60 loops=1)
              Merge Cond: (eligible.observation_id = r.observation_id)
              Buffers: shared hit=11933
              ->  Sort  (cost=69.83..72.33 rows=1000 width=25) (actual time=0.146..0.148 rows=60 loops=1)
                    Sort Key: eligible.observation_id
                    Sort Method: quicksort  Memory: 27kB
                    Buffers: shared hit=70
                    ->  CTE Scan on eligible  (cost=0.00..20.00 rows=1000 width=25) (actual time=0.139..0.143 rows=60 loops=1)
                          Buffers: shared hit=70
              ->  GroupAggregate  (cost=113.83..133.83 rows=200 width=40) (actual time=10.903..26.688 rows=60 loops=1)
                    Group Key: r.observation_id
                    Buffers: shared hit=11863
                    ->  Sort  (cost=113.83..116.33 rows=1000 width=248) (actual time=10.630..10.714 rows=4289 loops=1)
                          Sort Key: r.observation_id, r.point_ordinal
                          Sort Method: quicksort  Memory: 1017kB
                          Buffers: shared hit=11863
                          ->  Hash Join  (cost=6.50..64.00 rows=1000 width=248) (actual time=9.610..10.093 rows=4289 loops=1)
                                Hash Cond: (r.image_id = u.image_id)
                                Buffers: shared hit=11863
                                ->  CTE Scan on point_rows r  (cost=0.00..20.00 rows=1000 width=224) (actual time=8.379..8.485 rows=4289 loops=1)
                                      Buffers: shared hit=11743
                                ->  Hash  (cost=4.00..4.00 rows=200 width=40) (actual time=1.228..1.228 rows=120 loops=1)
                                      Buckets: 1024  Batches: 1  Memory Usage: 19kB
                                      Buffers: shared hit=120
                                      ->  CTE Scan on crop_urls u  (cost=0.00..4.00 rows=200 width=40) (actual time=0.558..1.218 rows=120 loops=1)
                                            Buffers: shared hit=120
        ->  Result  (cost=0.00..0.51 rows=1 width=32) (actual time=0.021..0.021 rows=1 loops=60)
              Buffers: shared hit=420
  ->  Memoize  (cost=0.30..10.30 rows=1000 width=1) (actual time=0.015..0.015 rows=1 loops=60)
        Cache Key: (private.public_observation_authorize_spore_mosaic(eligible.observation_id, CASE WHEN eligible.spore_data_public THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id) ELSE NULL::jsonb END))
        Cache Mode: binary
        Hits: 0  Misses: 60  Evictions: 0  Overflows: 0  Memory Usage: 32kB
        Buffers: shared hit=480
        ->  Function Scan on media_authorize_mosaic_delivery delivery  (cost=0.29..10.29 rows=1000 width=1) (actual time=0.015..0.015 rows=1 loops=60)
              Buffers: shared hit=480
LOG:  duration: 29.613 ms  plan:
Query Text: SELECT count(*) FROM public.get_public_observation_spore_previews('{109,113,117,121,125,129,133,137,141,145,149,153,157,161,165,169,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,233,237,241,245,249,253,257,261,265,269,273,277,281,285,289,293,297,301,305,309,313,317,321,325,329,333,337,341,345}'::bigint[]);
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=29.611..29.611 rows=1 loops=1)
  Buffers: shared hit=12833
  ->  Function Scan on get_public_observation_spore_previews  (cost=0.25..10.25 rows=1000 width=0) (actual time=29.602..29.605 rows=60 loops=1)
        Buffers: shared hit=12833
 count
-------
    60
(1 row)

```

### `bench-http.mjs` (15 repetitions; b6t/b2t = b-today)

```
reps=15 (after 1 warm-up round); times in ms
case     | requests | total median | total max | per-request median | per-request max | raw totals
a  n=30 |        1 |         22.1 |      26.1 |               22.1 |            26.1 | 26.1 22.4 20.8 24.1 21.8 22.1 22.4 22.1 21.5 21.8 21.3 22.7 22.5 21.8 20.3
b6 n=30 |       30 |         31.9 |      41.8 |                5.8 |            14.1 | 31.2 30.1 41.8 29.5 31.9 37.4 36.4 30.0 30.2 30.0 32.8 30.1 37.5 39.3 33.8
b2 n=30 |       30 |         65.9 |      70.2 |                4.3 |             8.9 | 70.2 62.5 64.1 64.6 64.4 67.1 65.9 70.0 66.2 69.3 63.6 62.8 66.8 68.2 65.2
b6t n=30 |       30 |         29.9 |      34.0 |                5.3 |            11.5 | 29.0 28.1 29.8 34.0 30.4 32.7 28.9 29.9 30.5 27.5 33.8 31.1 28.4 31.9 29.7
b2t n=30 |       30 |         65.4 |      70.1 |                4.2 |             8.0 | 70.1 63.9 59.5 68.8 65.4 70.0 67.5 64.8 67.4 61.8 62.7 65.5 62.5 67.2 63.5
a  n=60 |        1 |         41.2 |      46.6 |               41.2 |            46.6 | 43.2 46.6 41.6 41.4 42.6 38.9 41.2 39.2 40.0 42.3 39.4 40.8 40.9 42.9 37.4
b6 n=60 |       60 |         57.3 |      75.0 |                5.4 |            11.7 | 56.9 55.8 54.9 65.1 58.3 54.0 71.0 60.1 54.3 54.8 61.3 64.4 56.4 75.0 57.3
b2 n=60 |       60 |        129.6 |     141.2 |                4.2 |             9.5 | 135.2 138.7 124.8 132.2 125.6 122.4 135.9 141.2 121.7 128.9 123.1 136.3 128.8 134.1 129.6
b6t n=60 |       60 |         56.3 |      70.4 |                5.3 |            11.2 | 54.3 52.4 56.0 70.4 51.9 54.4 57.7 56.3 56.9 58.8 61.6 61.4 55.8 56.7 55.9
b2t n=60 |       60 |        127.5 |     183.8 |                4.1 |            38.4 | 118.8 126.4 127.5 183.8 130.7 146.0 131.1 129.1 127.3 122.2 120.1 131.0 126.9 127.5 124.5

load: V simultaneous visitors, per-visitor wall-clock (ms)
V  case     | median | max   | client requests in flight at most (not a DB measurement)
4  a  n=30 |   25.2 |  33.3 | 4
4  b6 n=30 |  161.1 | 186.8 | 24
4  b6t n=30 |  163.6 | 193.4 | 24
4  a  n=60 |   51.4 | 102.4 | 4
4  b6 n=60 |  326.6 | 372.7 | 24
4  b6t n=60 |  318.3 | 362.0 | 24
8  a  n=30 |   38.6 |  86.0 | 8
8  b6 n=30 |  443.6 | 673.1 | 48
8  b6t n=30 |  444.9 | 1014.1 | 48
8  a  n=60 |   72.6 | 108.7 | 8
8  b6 n=60 |  887.7 | 1096.6 | 48
8  b6t n=60 |  900.5 | 1084.0 | 48
```

### `statements.sql` (after `bench-http.mjs`)

```
     rpc      | calls | total_exec_ms | mean_exec_ms | max_exec_ms | shared_blks_hit | shared_blks_read | hit_per_call
--------------+-------+---------------+--------------+-------------+-----------------+------------------+--------------
 batch        |   392 |       14968.6 |        38.19 |       85.51 |         3784148 |                0 |       9653.4
 single       | 19080 |      122916.9 |         6.44 |      111.20 |         8782894 |                0 |        460.3
 single today | 19080 |      122903.1 |         6.44 |      238.20 |         8416328 |                0 |        441.1
(3 rows)

```
