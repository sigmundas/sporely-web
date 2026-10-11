# Batch spore previews: database work and latency (local)

Plan: `docs/plans/active/2026-10-10-batch-spore-preview-rpc.md`, Stage 2.
Date: 2026-10-11. **Local database only, synthetic fixtures.** No production
connection was used and no production data was read.

Compared, for the same ids, as the `anon` role:

- **(a)** one `get_public_observation_spore_previews(ids)` call;
- **(b)** one `get_public_observation(id)` call per id, which is what the
  `sporely-landing` Cards view does today (`rpcCall`, `POST`, JSON body,
  `OBSERVATION_DETAIL_CONCURRENCY = 6`).

## Verdict

| Pass condition | Result |
|---|---|
| (a) does less total database work (time and buffers) than (b) | **Pass**, after the fix below: −36 to −37 % execution time and −20 % shared buffers at both 30 and 60 ids. |
| (a) wall-clock time is lower than (b) | **Pass under load, fail for one isolated visitor on localhost.** With 4 or 8 visitors at the same time, (a) is 2.2–4.3× faster. One visitor alone, with ~0 ms network RTT and 10 idle cores, gets (b) at concurrency 6 in about half the time of (a). See "Wall-clock". |
| (a) at 60 ids well under the 3 s anon statement timeout | **Pass:** 107–122 ms execution (3.6–4.1 % of 3 s); worst observed 242 ms wall-clock with 8 simultaneous visitors. |

**The Stage 1 function had a defect, and this stage fixed it.** As written in
Stage 1, the batch did *more* work than (b): 2.4× the buffers and 1.7× the
execution time. The planner pulled up the `authorized` LATERAL subquery and
re-evaluated both STABLE helpers once for every reference to
`authorized.points` and `authorized.spore_mosaic`. Points were built three
times and mosaics five times per observation. Stage 2 adds an `OFFSET 0`
optimization fence to that subquery in
`20261011120000_add_public_observation_spore_previews.sql`. That migration is
not yet applied anywhere but locally, since it is Stage 3's job. The fence does
not change any result, and the Stage 1 pgTAP suite and identity test pass with
it (see "Fix"). **It still changes the Stage 1 candidate, so its security
review verdict refers to the earlier SHA and should be renewed on this one.**

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

Sanity check, as anon: the batch at 60 ids returns 60 rows, 4,289 points and
60 mosaics. The 60 single calls return the same 4,289 points and 60 mosaics.
Over the 50 decoys, the batch returns only the 10 `spore_private` ones, each
with `points` and `spore_mosaic` NULL. That matches `get_public_observation`,
which returns the row but no spore data. The other 40 decoys are absent.

Environment: Apple M5, Docker with 10 CPUs. The local Supabase stack runs
PostgreSQL 17.6, PostgREST v14.4 with the default pool of 10, and Kong 2.8.1.
Settings: `shared_buffers=128MB`, `work_mem=4MB`, `jit=on`. Every run is fully
cached, so shared reads are 0 throughout.

## Commands

```bash
supabase db reset --local
supabase test db supabase/tests/public_observation_spore_previews_test.sql \
  supabase/tests/public_observation_spore_previews_eval_count_test.sql \
  supabase/tests/mosaic_storage_key_ownership_test.sql
bash supabase/tests/public_observation_spore_previews_identity_test.sh

DB=supabase_db_zkpjklzfwzefhjluvhfw
P=docs/perf/2026-10-batch-spore-preview
docker exec -i $DB psql -U postgres -v ON_ERROR_STOP=1 < $P/seed.sql
node $P/bench-db.mjs $DB 10
docker exec -i $DB psql -U postgres -X -At -v ON_ERROR_STOP=1 < $P/function-calls.sql
docker exec -i $DB psql -U postgres -X -v ON_ERROR_STOP=1 < $P/plans.sql

docker exec -i $DB psql -U postgres -At -c "select pg_stat_statements_reset() is not null"
IDS=$(docker exec -i $DB psql -U postgres -At -c "select json_agg(observation_id order by ordinal) from perf_bsp.ids")
eval "$(supabase status -o env | grep -E '^(API_URL|PUBLISHABLE_KEY)=')"
SUPABASE_URL=$API_URL SUPABASE_ANON_KEY=$PUBLISHABLE_KEY node $P/bench-http.mjs "$IDS" 15
docker exec -i $DB psql -U postgres < $P/statements.sql

docker exec -i $DB psql -U postgres -v ON_ERROR_STOP=1 < $P/cleanup.sql
```

## Database work: `EXPLAIN (ANALYZE, BUFFERS)`

These figures come from `bench-db.mjs`, with 10 repetitions. Each repetition
opens a fresh backend per case and runs the case twice. **Cold** is the first
run in that backend, when the function plan caches are empty. **Warm** is the
second, which is what a reused PostgREST pool connection sees. For (b), the
figures are the sum over the 30 or 60 single-call plans. The buffers on the
top-level Function Scan include all nested function calls; the
auto_explain output below confirms this, because the inner plan's 21,603
buffers equal the outer node's.

Medians, with the maximum in brackets:

| ids | case | run | planning ms | execution ms | shared hit | shared read |
|---|---|---|---|---|---|---|
| 30 | (a) batch | warm | 0.02 | **54.9** (60.0) | **10,852** | 0 |
| 30 | (b) 30 singles | warm | 0.19 | **87.3** (93.0) | **13,626** | 0 |
| 30 | (a) batch | cold | 0.02 | 59.3 (73.0) | 13,430 | 0 |
| 30 | (b) 30 singles | cold | 0.23 | 91.2 (99.9) | 16,194 | 0 |
| 60 | (a) batch | warm | 0.02 | **109.3** (121.5) | **21,603** | 0 |
| 60 | (b) 60 singles | warm | 0.38 | **170.5** (182.6) | **27,177** | 0 |
| 60 | (a) batch | cold | 0.02 | 113.0 (116.7) | 24,181 | 0 |
| 60 | (b) 60 singles | cold | 0.42 | 174.5 (184.5) | 29,745 | 0 |

At both sizes, warm, (a) uses **37 % less execution time and 20 % fewer
shared buffers** than (b), and its planning time is negligible. Buffer counts
are identical in every repetition.

### Why the buffer gain is only 20 %

Per-point work dominates both plans, and both paths do it identically,
because the batch reuses the same helpers:

- `public_observation_spore_points_raw` joins measurements, images and tiles.
- `public_observation_authorize_spore_points` unnests the points again, looks
  up each point's image by primary key for `media_version`, and calls
  `build_worker_media_url`.
- `build_worker_media_url` calls `_media_worker_base_url()`, a
  SECURITY DEFINER read of `_media_worker_config`, once per point.

In the 60-id batch, the per-observation `Result` node (the two point helpers
and the two mosaic helpers) accounts for 21,054 of 21,603 buffers. That is
about 4.9 buffers per point (5.0 for the whole call), against 6.3 for (b). The single calls also
pay for gates and fields the Cards view never reads: eligibility once per
call, `community_contributor_label`, `latest_image`, the measurement count,
`prepSummary`, and the region join. The batch drops those, and that accounts
for the whole buffer gain. Reducing the per-point cost itself would mean
changing the shared helpers, which `get_public_observation` also uses. That is
out of scope here.

### Per-function work (`function-calls.sql`)

`track_functions = 'all'` with `pg_stat_xact_user_functions`, one run per case
in a fresh backend. Times include the tracking overhead.

| | (a) 30 | (b) 30 | (a) 60 | (b) 60 |
|---|---|---|---|---|
| `build_worker_media_url` calls | 2,154 | 2,154 | 4,289 | 4,289 |
| `public_observation_spore_points_raw` calls | 30 | 30 | 60 | 60 |
| `public_observation_spore_points_raw` total ms | 22.0 | 22.4 | 35.8 | 43.6 |
| `public_observation_authorize_spore_points` calls / total ms | 30 / 28.6 | 30 / 29.1 | 60 / 53.8 | 60 / 57.5 |
| `build_worker_media_url` total ms | 10.8 | 10.5 | 20.9 | 21.0 |
| `public_observation_eligibility` calls | 1 | 30 | 1 | 60 |
| `_get_public_observation_stage2a` self ms | — | 26.6 | — | 51.7 |
| top-level total ms | 70.9 | 86.4 | 116.5 | 169.0 |

`build_worker_media_url` runs exactly once per point in both cases. It takes
about 11 ms per 2,154 points, including `_media_worker_base_url` and
`media_variant_is_supported`: significant, but it does not dominate. The two
point helpers together do dominate. They take about 51 of 71 ms in (a) at 30
ids, and the same in (b). The batch has one per-point cost of its own, the reduction of each point
to the 12 card keys (`SubPlan 1` below: 4,289 loops × 0.004 ms ≈ 17 ms at 60
ids). It is included in every (a) figure above.

A direct timing breakdown of (a) at 30 ids, as postgres with `\timing`, warm:
`points_raw` 18.0 ms, `authorize(points_raw)` 42.9 ms (so the authorize step
is about 25 ms), `build_worker_media_url` × 2,154 alone 9.6 ms, mosaic helpers
0.9 ms, and the whole batch 52.9 ms.

## Fix: subquery pull-up re-evaluated the helpers

Before the fence, on the same fixtures with the commit `4f7f254` function:

```
-- bench-db.mjs, 1 repetition (cold | warm: planning execution hit read rows)
1 30 a 1 | 0.03 153.50 34893 0 30 | 0.02 138.29 32381 0 30
1 30 b 30 | 0.21 89.00 15957 0 30 | 0.17 82.19 13389 0 30
1 60 a 1 | 0.02 283.94 67022 0 60 | 0.01 276.61 64510 0 60
1 60 b 60 | 0.39 170.28 29286 0 60 | 0.33 163.65 26718 0 60

-- pg_stat_xact_user_functions, (a) at 30 ids
private.public_observation_authorize_spore_points|90 calls
private.public_observation_spore_points_raw|90 calls
public.build_worker_media_url|6462 calls          (3 x 2154)
private.public_observation_authorize_spore_mosaic|150 calls   (5 x 30)
private.public_observation_spore_mosaic_raw|150 calls
public.media_authorize_mosaic_delivery|30 calls
```

`authorized.points` is referenced three times in the outer `SELECT`. The
`CASE` test, the `CASE` result and `jsonb_array_elements` each referenced it.
`authorized.spore_mosaic` is referenced five times. Because `authorized` was a
simple subquery of STABLE function calls, PostgreSQL pulled it up and
substituted the call expression at every reference. `OFFSET 0` keeps it a
separate plan node, which shows in the nested plan below as `Result` with
loops=60. Each helper then runs once per observation, and the call counts above
match (b). The query text and results are otherwise unchanged.

Verification after the fix, on a fresh `supabase db reset --local`:

- pgTAP: `public_observation_spore_previews_test.sql` and
  `mosaic_storage_key_ownership_test.sql` both pass, 99 tests in total.
- `public_observation_spore_previews_identity_test.sh`: byte-identical over 42
  visible rows, 3 of them with points and mosaic.
- `observation_spore_mosaic_rpc_test.sql`, a plain psql script: passes.
- A new regression test,
  `supabase/tests/public_observation_spore_previews_eval_count_test.sql`,
  checks with `pg_stat_xact_user_functions` that each helper runs once per
  observation and `build_worker_media_url` once per point. It passes, 6/6. It
  was also run against the unfenced `4f7f254` function, inside a rolled-back
  transaction, where it fails 5 of 6 tests. The unfenced function made 9, 9,
  15, 15 and 36 calls where 3, 3, 3, 3 and 12 are expected.

## Wall-clock through local PostgREST (`bench-http.mjs`)

The client is Node `fetch` going to Kong (`127.0.0.1:54321`), then PostgREST,
then Postgres. Each case runs 15 times after one unrecorded warm-up round, with
the case order rotated every round. Times are in ms.

| ids | case | requests | median | max | per-request median |
|---|---|---|---|---|---|
| 30 | (a) batch | 1 | **61.9** | 65.0 | 61.9 |
| 30 | (b) concurrency 6 | 30 | **29.3** | 33.9 | 5.1 |
| 30 | (b) concurrency 2 | 30 | 66.2 | 70.8 | 4.2 |
| 60 | (a) batch | 1 | **119.0** | 124.0 | 119.0 |
| 60 | (b) concurrency 6 | 60 | **56.3** | 61.3 | 5.0 |
| 60 | (b) concurrency 2 | 60 | 126.9 | 135.6 | 4.1 |

Load: V visitors open the Cards view at the same moment. The table shows each
visitor's own time.

| V | ids | (a) median / max | (b) concurrency 6 median / max | DB requests in flight at peak, (a) / (b) |
|---|---|---|---|---|
| 4 | 30 | **68.7** / 75.2 | 152.5 / 176.5 | 4 / 24 |
| 4 | 60 | **133.3** / 178.6 | 318.8 / 372.8 | 4 / 24 |
| 8 | 30 | **95.0** / 113.8 | 408.0 / 506.5 | 8 / 48 |
| 8 | 60 | **193.5** / 242.2 | 817.0 / 934.0 | 8 / 48 |

### Reading the wall-clock results

- **One isolated visitor on localhost: (b) at concurrency 6 is faster.** One
  call runs in one backend. (b) spreads 37 % *more* total work over 6 backends
  on 10 idle cores, with a local round trip close to 0 ms. This is the most
  favourable case for fan-out, and the pass condition "wall-clock lower" is not
  met for it locally.
- **Any real network RTT reverses it.** This is arithmetic from the measured
  figures, not a measurement. (b) at concurrency 6 needs ⌈30/6⌉ = 5 sequential
  waves of requests, or 10 at 60 ids; (a) needs one. The gap is 32.6 ms at 30
  ids and 62.7 ms at 60. The batch therefore wins once the round trip exceeds
  32.6 / 4 ≈ 8 ms at 30 ids, or 62.7 / 9 ≈ 7 ms at 60. That ignores TLS, the
  browser's per-origin connection limits and edge overhead, all of which add
  more cost per request in (b) than in (a).
- **Under concurrent load, (a) wins clearly, and this was measured.** With 4
  visitors, (a) is 2.2–2.4× faster; with 8, it is 4.2–4.3× faster. (b) puts 6
  requests in flight per visitor against PostgREST's pool of 10 connections and
  10 cores, so the requests queue. That is the regime in which production hit
  `57014` timeouts. Database execution of the slowest single call reached
  32 ms (`max_exec_ms` below). For one visitor alone, the slowest whole HTTP
  request was 11 ms.
- **Concurrency 2 against 6, for the incident doc.** At one visitor, the
  per-request median is flat: 4.2 ms at concurrency 2 against 5.1 ms at
  concurrency 6. Total time scales with the number of waves (66 ms against
  29 ms at 30 ids). So locally, with one visitor, the cost of (b) is the cost of
  each call, not contention. Contention appears only once several visitors
  overlap (the load table). This does not support changing
  `OBSERVATION_DETAIL_CONCURRENCY`, and it stays unchanged.

### RPC request counts and total query cost (`statements.sql`)

These are `pg_stat_statements` figures over the whole `bench-http.mjs` run,
reset immediately before it. PostgREST's normalized statement does not
separate 30-id from 60-id calls, so the figures below are normalized per
observation id requested. The run requested 196 batch calls at each size,
which is 17,640 ids, and 19,080 single calls.

| rpc | calls | ids served | total exec ms | exec ms per id | shared hit | shared hit per id | shared read |
|---|---|---|---|---|---|---|---|
| batch | 392 | 17,640 | 46,192 | **2.62** | 6,366,413 | **361** | 0 |
| single | 19,080 | 19,080 | 102,683 | **5.38** | 8,673,339 | **455** | 0 |

Per Cards-view load at 30 ids, the batch makes 1 request instead of 30. Over
this run, which includes the load scenarios, its database time per observation
is 2.62 ms against 5.38 ms, and its buffers per observation 361 against 455.
The time gap is wider here than in the EXPLAIN table because the single calls
were also slowed by contention under load.

## Distance from the 3-second anon statement timeout

At 60 ids, the maximum allowed:

- Execution is 107–122 ms warm and 111–117 ms cold over 10 repetitions, which
  is **3.6–4.1 % of 3 s**.
- Wall-clock is 115–124 ms for one visitor. The worst figure is 242 ms with 8
  simultaneous visitors, about 8 % of the budget.
- `pg_stat_statements` `max_exec_ms` for the batch over the whole run is
  227 ms.

Scaling: execution is about 25 µs per returned point, close to linear, since
2,154 points take about 55 ms and 4,289 points about 109 ms. At that rate,
3 s would take about 120,000 points in one call, or an average of about 2,000
points per observation across 60. By design, the function does not cap points
on the server. These fixtures average 70 points per observation. The
distribution in production was not measured, because there was no production
access. Cold disk reads (shared read = 0 here) would add time on a cold
production cache. Stage 3's `pg_stat_statements` baseline is where to confirm
the margin in production.

## Raw output

### `bench-db.mjs` (10 repetitions, after the fix)

```
raw: rep n case statements | cold planning execution hit read rows | warm planning execution hit read rows
1 30 a 1 | 0.03 73.01 13430 0 30 | 0.02 55.60 10852 0 30
1 30 b 30 | 0.25 99.87 16194 0 30 | 0.19 87.03 13626 0 30
1 60 a 1 | 0.02 114.73 24181 0 60 | 0.02 115.53 21603 0 60
1 60 b 60 | 0.38 172.97 29745 0 60 | 0.37 170.56 27177 0 60
2 30 b 30 | 0.23 92.65 16194 0 30 | 0.20 92.99 13626 0 30
2 30 a 1 | 0.02 58.34 13430 0 30 | 0.02 56.09 10852 0 30
2 60 b 60 | 0.41 172.60 29745 0 60 | 0.38 167.10 27177 0 60
2 60 a 1 | 0.02 112.72 24181 0 60 | 0.01 109.50 21603 0 60
3 30 a 1 | 0.03 59.36 13430 0 30 | 0.02 60.04 10852 0 30
3 30 b 30 | 0.23 89.83 16194 0 30 | 0.20 87.64 13626 0 30
3 60 a 1 | 0.02 114.77 24181 0 60 | 0.02 112.01 21603 0 60
3 60 b 60 | 0.43 179.17 29745 0 60 | 0.38 169.35 27177 0 60
4 30 b 30 | 0.23 88.19 16194 0 30 | 0.19 84.50 13626 0 30
4 30 a 1 | 0.02 59.28 13430 0 30 | 0.01 53.91 10852 0 30
4 60 b 60 | 0.41 174.15 29745 0 60 | 0.43 170.26 27177 0 60
4 60 a 1 | 0.02 113.37 24181 0 60 | 0.01 117.83 21603 0 60
5 30 a 1 | 0.02 62.80 13430 0 30 | 0.02 57.61 10852 0 30
5 30 b 30 | 0.24 97.46 16194 0 30 | 0.23 92.80 13626 0 30
5 60 a 1 | 0.02 116.68 24181 0 60 | 0.02 107.69 21603 0 60
5 60 b 60 | 0.43 184.50 29745 0 60 | 0.36 171.07 27177 0 60
6 30 b 30 | 0.23 98.92 16194 0 30 | 0.21 91.14 13626 0 30
6 30 a 1 | 0.02 59.97 13430 0 30 | 0.01 53.77 10852 0 30
6 60 b 60 | 0.38 172.72 29745 0 60 | 0.39 171.24 27177 0 60
6 60 a 1 | 0.02 112.28 24181 0 60 | 0.01 107.50 21603 0 60
7 30 a 1 | 0.02 58.11 13430 0 30 | 0.01 53.91 10852 0 30
7 30 b 30 | 0.22 88.20 16194 0 30 | 0.18 83.97 13626 0 30
7 60 a 1 | 0.02 112.60 24181 0 60 | 0.02 107.10 21603 0 60
7 60 b 60 | 0.43 183.08 29745 0 60 | 0.39 182.59 27177 0 60
8 30 b 30 | 0.22 93.06 16194 0 30 | 0.20 91.34 13626 0 30
8 30 a 1 | 0.02 63.46 13430 0 30 | 0.02 58.90 10852 0 30
8 60 b 60 | 0.43 182.83 29745 0 60 | 0.41 176.86 27177 0 60
8 60 a 1 | 0.02 112.68 24181 0 60 | 0.02 106.49 21603 0 60
9 30 a 1 | 0.02 57.71 13430 0 30 | 0.01 53.64 10852 0 30
9 30 b 30 | 0.22 89.67 16194 0 30 | 0.18 84.70 13626 0 30
9 60 a 1 | 0.02 111.35 24181 0 60 | 0.01 109.10 21603 0 60
9 60 b 60 | 0.38 170.46 29745 0 60 | 0.32 165.35 27177 0 60
10 30 b 30 | 0.20 88.26 16194 0 30 | 0.18 84.95 13626 0 30
10 30 a 1 | 0.02 58.32 13430 0 30 | 0.01 54.15 10852 0 30
10 60 b 60 | 0.46 174.86 29745 0 60 | 0.35 170.52 27177 0 60
10 60 a 1 | 0.02 114.82 24181 0 60 | 0.02 121.54 21603 0 60

summary (median / max over reps; times ms, buffers = 8 kB pages)
n case run   | planning med/max | execution med/max | shared hit med/max | shared read med/max | rows
30 a cold  | 0.02 / 0.03 | 59.32 / 73.01 | 13430.00 / 13430.00 | 0.00 / 0.00 | 30
30 a warm  | 0.02 / 0.02 | 54.88 / 60.04 | 10852.00 / 10852.00 | 0.00 / 0.00 | 30
30 b cold  | 0.23 / 0.25 | 91.24 / 99.87 | 16194.00 / 16194.00 | 0.00 / 0.00 | 30
30 b warm  | 0.19 / 0.23 | 87.34 / 92.99 | 13626.00 / 13626.00 | 0.00 / 0.00 | 30
60 a cold  | 0.02 / 0.02 | 113.04 / 116.68 | 24181.00 / 24181.00 | 0.00 / 0.00 | 60
60 a warm  | 0.02 / 0.02 | 109.30 / 121.54 | 21603.00 / 21603.00 | 0.00 / 0.00 | 60
60 b cold  | 0.42 / 0.46 | 174.51 / 184.50 | 29745.00 / 29745.00 | 0.00 / 0.00 | 60
60 b warm  | 0.38 / 0.43 | 170.54 / 182.59 | 27177.00 / 27177.00 | 0.00 / 0.00 | 60
```

### `function-calls.sql` (after the fix; label | rows | function | calls | total ms | self ms)

```
a30|30|public.get_public_observation_spore_previews|1|70.9|14.8
a30|30|private.public_observation_authorize_spore_points|30|28.6|17.8
a30|30|private.public_observation_spore_points_raw|30|22.0|22.0
a30|30|public.build_worker_media_url|2154|10.8|5.5
a30|30|public._media_worker_base_url|2184|3.4|3.4
a30|30|public.media_variant_is_supported|2154|2.0|2.0
a30|30|private.public_observation_eligibility|1|2.0|2.0
a30|30|public.media_authorize_mosaic_delivery|30|1.8|1.8
a30|30|private.public_observation_spore_mosaic_raw|30|0.8|0.8
a30|30|private.public_observation_authorize_spore_mosaic|30|0.8|0.5
a30|30|public.build_worker_mosaic_url|30|0.3|0.2
b30|30|public.get_public_observation|30|86.4|0.5
b30|30|public._get_public_observation_stage2a|30|55.1|26.6
b30|30|private.public_observation_authorize_spore_points|30|29.1|18.7
b30|30|private.public_observation_spore_points_raw|30|22.4|22.4
b30|30|public.build_worker_media_url|2154|10.5|5.4
b30|30|public._media_worker_base_url|2184|3.2|3.2
b30|30|private.public_observation_eligibility|30|3.1|3.1
b30|30|public.media_variant_is_supported|2154|2.0|2.0
b30|30|private.public_observation_authorize_spore_mosaic|30|1.7|1.5
b30|30|private.public_observation_spore_mosaic_raw|30|1.7|1.7
b30|30|public.community_contributor_label|30|1.4|1.4
b30|30|public.build_worker_mosaic_url|30|0.2|0.2
a60|60|public.get_public_observation_spore_previews|1|116.5|22.5
a60|60|private.public_observation_authorize_spore_points|60|53.8|32.9
a60|60|private.public_observation_spore_points_raw|60|35.8|35.8
a60|60|public.build_worker_media_url|4289|20.9|10.5
a60|60|public._media_worker_base_url|4349|6.4|6.4
a60|60|public.media_variant_is_supported|4289|4.2|4.2
a60|60|public.media_authorize_mosaic_delivery|60|1.9|1.9
a60|60|private.public_observation_authorize_spore_mosaic|60|0.9|0.5
a60|60|private.public_observation_spore_mosaic_raw|60|0.9|0.9
a60|60|private.public_observation_eligibility|1|0.7|0.7
a60|60|public.build_worker_mosaic_url|60|0.4|0.2
b60|60|public.get_public_observation|60|169.0|0.8
b60|60|public._get_public_observation_stage2a|60|107.4|51.7
b60|60|private.public_observation_authorize_spore_points|60|57.5|36.5
b60|60|private.public_observation_spore_points_raw|60|43.6|43.6
b60|60|public.build_worker_media_url|4289|21.0|10.7
b60|60|public._media_worker_base_url|4349|6.5|6.5
b60|60|private.public_observation_eligibility|60|6.2|6.2
b60|60|public.media_variant_is_supported|4289|4.0|4.0
b60|60|private.public_observation_authorize_spore_mosaic|60|3.3|2.8
b60|60|private.public_observation_spore_mosaic_raw|60|3.1|3.1
b60|60|public.community_contributor_label|60|2.7|2.7
b60|60|public.build_worker_mosaic_url|60|0.4|0.3
```

### `plans.sql` (after the fix)

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
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Function Scan on public.get_public_observation_spore_previews  (cost=0.25..10.25 rows=1000 width=72) (actual time=111.280..111.281 rows=60 loops=1)
   Output: observation_id, points, spore_mosaic
   Function Call: get_public_observation_spore_previews('{69,73,77,81,85,89,93,97,101,105,109,113,117,121,125,129,133,137,141,145,149,153,157,161,165,169,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,233,237,241,245,249,253,257,261,265,269,273,277,281,285,289,293,297,301,305}'::bigint[])
   Buffers: shared hit=21603
 Query Identifier: 1552546586357505981
 Planning Time: 0.005 ms
 Execution Time: 111.289 ms
(7 rows)

== (b) one single call (first id)
                                                                                                                                                                         QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Function Scan on public.get_public_observation  (cost=0.25..10.25 rows=1000 width=549) (actual time=3.121..3.121 rows=1 loops=1)
   Output: id, "speciesSlug", "speciesName", "speciesCommonName", "observerDisplayName", "observedOn", country, "regionId", "locationPrecision", "locationLabel", "hasMicroscopy", "sporeMeasurementCount", "sporeSummary", "sporePoints", "sporeMosaic", "contrastMethod", "mountReagent", "sampleType", "sampleSource", "prepSummary", "mapLat", "mapLon"
   Function Call: get_public_observation('69'::bigint)
   Buffers: shared hit=444
 Query Identifier: 7025787864066007552
 Planning Time: 0.019 ms
 Execution Time: 3.128 ms
(7 rows)

== (a) batch, 60 ids: nested RETURN QUERY plan (auto_explain)
LOG:  duration: 124.373 ms  plan:
Query Text: SELECT
    eligible.observation_id,
    CASE
      WHEN authorized.points IS NULL OR pg_catalog.jsonb_typeof(authorized.points) <> 'array'
        THEN authorized.points
      ELSE (
        SELECT coalesce(pg_catalog.jsonb_agg(
                 CASE
                   WHEN pg_catalog.jsonb_typeof(pt.value) = 'object' THEN (
                     SELECT coalesce(pg_catalog.jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
                     FROM pg_catalog.jsonb_each(pt.value) kv
                     WHERE kv.key = ANY (card_point_keys)
                   )
                   ELSE pt.value
                 END
                 ORDER BY pt.ordinality), '[]'::jsonb)
        FROM pg_catalog.jsonb_array_elements(authorized.points) WITH ORDINALITY pt(value, ordinality)
      )
    END,
    CASE
      WHEN delivery.allowed IS TRUE
           AND authorized.spore_mosaic->>'mosaicMediaUrl' IS NOT NULL
        THEN authorized.spore_mosaic - 'url'
      ELSE NULL::jsonb
    END
  FROM private.public_observation_eligibility(p_observation_ids) eligible
  CROSS JOIN LATERAL (
    SELECT
      private.public_observation_authorize_spore_points(
        CASE
          WHEN eligible.spore_data_public
            THEN private.public_observation_spore_points_raw(eligible.observation_id)
          ELSE NULL::jsonb
        END
      ) AS points,
      private.public_observation_authorize_spore_mosaic(
        eligible.observation_id,
        CASE
          WHEN eligible.spore_data_public
            THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id)
          ELSE NULL::jsonb
        END
      ) AS spore_mosaic
    -- Optimization fence: without it the planner pulls this subquery up and
    -- re-evaluates both STABLE helpers once per reference to authorized.*
    -- below (3x the point work, 5x the mosaic work per observation).
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
Sort  (cost=158672936.39..158675423.89 rows=995000 width=72) (actual time=124.301..124.303 rows=60 loops=1)
  Sort Key: eligible.observation_id
  Sort Method: quicksort  Memory: 1287kB
  Buffers: shared hit=21603
  ->  Nested Loop Left Join  (cost=0.55..158492185.81 rows=995000 width=72) (actual time=2.496..124.227 rows=60 loops=1)
        Join Filter: ((private.public_observation_authorize_spore_mosaic(eligible.observation_id, CASE WHEN eligible.spore_data_public THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id) ELSE NULL::jsonb END)) IS NOT NULL)
        Buffers: shared hit=21603
        ->  Nested Loop  (cost=0.25..1030.25 rows=1000 width=72) (actual time=2.091..98.178 rows=60 loops=1)
              Buffers: shared hit=21123
              ->  Function Scan on public_observation_eligibility eligible  (cost=0.25..10.25 rows=1000 width=25) (actual time=0.183..0.191 rows=60 loops=1)
                    Buffers: shared hit=69
              ->  Result  (cost=0.00..1.01 rows=1 width=64) (actual time=1.633..1.633 rows=1 loops=60)
                    Buffers: shared hit=21054
        ->  Memoize  (cost=0.30..10.30 rows=1000 width=1) (actual time=0.022..0.023 rows=1 loops=60)
              Cache Key: (private.public_observation_authorize_spore_mosaic(eligible.observation_id, CASE WHEN eligible.spore_data_public THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id) ELSE NULL::jsonb END))
              Cache Mode: binary
              Hits: 0  Misses: 60  Evictions: 0  Overflows: 0  Memory Usage: 32kB
              Buffers: shared hit=480
              ->  Function Scan on media_authorize_mosaic_delivery delivery  (cost=0.29..10.29 rows=1000 width=1) (actual time=0.021..0.021 rows=1 loops=60)
                    Buffers: shared hit=480
        SubPlan 2
          ->  Aggregate  (cost=159.25..159.26 rows=1 width=32) (actual time=0.409..0.409 rows=1 loops=60)
                ->  Function Scan on jsonb_array_elements pt  (cost=0.00..1.00 rows=100 width=40) (actual time=0.005..0.008 rows=71 loops=60)
                SubPlan 1
                  ->  Aggregate  (cost=1.56..1.57 rows=1 width=32) (actual time=0.004..0.004 rows=1 loops=4289)
                        ->  Function Scan on jsonb_each kv  (cost=0.03..1.53 rows=12 width=64) (actual time=0.001..0.002 rows=10 loops=4289)
                              Filter: (key = ANY ('{id,lengthUm,widthUm,cropUrl,mosaicX,mosaicY,mosaicW,mosaicH,contrastMethod,mountReagent,sampleType,sampleSource}'::text[]))
                              Rows Removed by Filter: 3
LOG:  duration: 124.799 ms  plan:
Query Text: SELECT count(*) FROM public.get_public_observation_spore_previews('{69,73,77,81,85,89,93,97,101,105,109,113,117,121,125,129,133,137,141,145,149,153,157,161,165,169,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,233,237,241,245,249,253,257,261,265,269,273,277,281,285,289,293,297,301,305}'::bigint[]);
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=124.795..124.796 rows=1 loops=1)
  Buffers: shared hit=21603
  ->  Function Scan on get_public_observation_spore_previews  (cost=0.25..10.25 rows=1000 width=0) (actual time=124.780..124.787 rows=60 loops=1)
        Buffers: shared hit=21603
 count
-------
    60
(1 row)

```

### `bench-http.mjs` (15 repetitions)

```
reps=15 (after 1 warm-up round); times in ms
case     | requests | total median | total max | per-request median | per-request max | raw totals
a  n=30 |        1 |         61.9 |      65.0 |               61.9 |            65.0 | 62.6 65.0 60.6 61.6 63.0 61.9 62.7 62.0 63.5 61.6 61.9 61.9 62.0 61.1 61.8
b6 n=30 |       30 |         29.3 |      33.9 |                5.1 |            11.4 | 28.9 29.3 33.9 29.1 30.9 29.5 28.4 28.1 27.6 29.3 30.0 26.1 26.6 30.9 30.1
b2 n=30 |       30 |         66.2 |      70.8 |                4.2 |            10.4 | 70.3 70.8 66.8 66.3 59.4 68.4 68.2 68.4 66.2 65.0 63.7 62.7 61.7 62.2 64.6
a  n=60 |        1 |        119.0 |     124.0 |              119.0 |           124.0 | 121.4 124.0 120.0 118.8 119.0 122.7 119.2 118.5 116.4 114.8 119.7 116.6 118.6 119.8 118.9
b6 n=60 |       60 |         56.3 |      61.3 |                5.0 |            11.8 | 56.3 60.8 56.3 54.6 55.6 50.6 58.4 56.5 58.1 51.6 51.7 58.6 56.3 51.7 61.3
b2 n=60 |       60 |        126.9 |     135.6 |                4.1 |            10.4 | 127.7 128.6 124.6 132.0 121.1 135.6 126.9 130.8 128.3 121.6 122.4 128.4 124.8 117.2 124.9

load: V simultaneous visitors, per-visitor wall-clock (ms)
V  case     | median | max   | concurrent DB requests at peak
4  a  n=30 |   68.7 |  75.2 | 4
4  b6 n=30 |  152.5 | 176.5 | 24
4  a  n=60 |  133.3 | 178.6 | 4
4  b6 n=60 |  318.8 | 372.8 | 24
8  a  n=30 |   95.0 | 113.8 | 8
8  b6 n=30 |  408.0 | 506.5 | 48
8  a  n=60 |  193.5 | 242.2 | 8
8  b6 n=60 |  817.0 | 934.0 | 48
```

### `statements.sql` (after `bench-http.mjs`)

```
  rpc   | calls | total_exec_ms | mean_exec_ms | max_exec_ms | shared_blks_hit | shared_blks_read | hit_per_call
--------+-------+---------------+--------------+-------------+-----------------+------------------+--------------
 batch  |   392 |       46192.1 |       117.84 |      227.49 |         6366413 |                0 |      16240.8
 single | 19080 |      102683.3 |         5.38 |       32.14 |         8673339 |                0 |        454.6
(2 rows)

```
