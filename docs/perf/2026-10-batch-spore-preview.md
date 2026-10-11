# Batch spore previews: database work and latency (local)

Plan: `docs/plans/active/2026-10-10-batch-spore-preview-rpc.md`, Stage 2.
Date: 2026-10-11. **Local database only, synthetic fixtures.** No production
connection was used and no production data was read.

Compared, for the same ids, as the `anon` role:

- **(a)** one `get_public_observation_spore_previews(ids)` call;
- **(b)** one `get_public_observation(id)` call per id, which is what the
  `sporely-landing` Cards view does today (`rpcCall`, `POST`, JSON body,
  `OBSERVATION_DETAIL_CONCURRENCY = 6`).

All figures below are for the current batch function (single-pass points,
see "Changes made in this stage"). Earlier rounds are summarized in that
section.

## Verdict

| Pass condition | Result |
|---|---|
| (a) does less total database work (time and buffers) than (b) | **Pass.** Warm, at 30 ids: 14.0 against 92.4 ms execution (−85 %) and 6,644 against 13,747 shared buffers (−52 %). At 60 ids: 28.3 against 183.4 ms (−85 %) and 13,136 against 27,278 buffers (−52 %). |
| (a) wall-clock time is lower than (b) | **Pass, one visitor, localhost, 15 repetitions.** At 30 ids: 21.5 ms median / 28.9 ms max, against 31.3 / 38.5 ms for (b) at concurrency 6. At 60 ids: 40.1 / 42.9 ms against 59.2 / 67.5 ms. With 4 or 8 simultaneous visitors, (a) is 6.6–13.6× faster. |
| (a) at 60 ids well under the 3 s anon statement timeout | **Pass.** 28.3 ms median and 41.3 ms max execution warm (0.9–1.4 % of 3 s). The highest batch execution in the whole HTTP run, including the 8-visitor load, was 189 ms (6 % of 3 s). |

## Changes made in this stage

Two candidates for the batch function were measured before this one. Their
raw output is in this file at `33f9865`.

1. **Stage 1 candidate (`4f7f254`), pulled-up subquery.** It did more work
   than (b): at 30 ids, 138 against 82 ms warm execution and 32,381 against
   13,389 buffers. The planner pulled up the `authorized` LATERAL subquery and
   re-ran its STABLE helpers once per reference to `authorized.points` and
   `authorized.spore_mosaic`. That built points 3× and mosaics 5× per
   observation, and called `build_worker_media_url` 6,462 times for 2,154
   points.
2. **`OFFSET 0` fence (`be77878`).** The fence brought work below (b): 55 ms
   against 87 ms warm and 10,852 against 13,626 buffers. But one call is serial
   on one backend, while (b) spreads its work over six. Wall-clock for one
   visitor was 61.9 ms against 29.3 ms at 30 ids, and 119.0 ms against 56.3 ms
   at 60 ids, so the pass condition failed.
3. **Single-pass points (this candidate).** Profiling the fenced version at 30
   ids, warm, with `\timing`:
   - `spore_points_raw`: 18 ms;
   - the `authorize_spore_points` rewrite: about 25 ms, of which
     `build_worker_media_url` × 2,154 was about 10 ms;
   - the batch's per-point reduction to card keys (`jsonb_each`, then
     `jsonb_object_agg`): about 9 ms.

   Each point's JSON was built three times: raw, authorized, then reduced.
   `build_worker_media_url` was called once per point. Its arguments
   (`image id`, `'thumb'`, `image media_version`) depend only on the image,
   though.

   The batch now builds the card-key point objects directly in one pass. It
   uses the same tables, joins, `WHERE` gate lines and per-point expressions as
   `private.public_observation_spore_points_raw`. It computes `cropUrl` once
   per image, with the same `build_worker_media_url` call, inside a fenced
   per-image subquery. Eligibility and the mosaic still come from the shared
   private helpers. The mosaic path, its `OFFSET 0` fence and its fail-closed
   `media_authorize_mosaic_delivery` check are unchanged.
   `get_public_observation` is unchanged.

   An earlier draft fenced the per-image subquery with its gates outside. That
   would have scanned every image in the table, because quals are not pushed
   down past `OFFSET`. The gates are inside the subquery, and the nested plan
   below shows an index scan on `observation_images_observation_id_idx`.

   Prototypes at 30 ids, warm: the single pass with `json` aggregation took
   12–14 ms, and with `jsonb` aggregation 12–13 ms. `jsonb` was kept, because
   it uses the same float8 → jsonb conversion as `get_public_observation`. A
   `json` text round-trip matched it on 200,000 random doubles under
   `extra_float_digits` 1, 3 and −15, but it is not the same code path.

**Trade-off: point gates are now mirrored, not shared.** A gate added to
`spore_points_raw` must also be added to the batch. Three things guard this:

- `supabase/tests/public_observation_spore_previews_eval_count_test.sql`
  fails if any `WHERE` gate line of `spore_points_raw` is missing, verbatim,
  from the batch.
- The Stage 1 parity tests compare values and point order with
  `get_public_observation` across the visibility matrix.
- `SUPABASE_DB.md` and the migration header state the rule.

**Point order.** `spore_points_raw`'s `jsonb_agg` has no `ORDER BY`, so the
order `get_public_observation` returns follows its plan. The batch uses the
same plan shape per observation, as the nested plan below shows: an index scan
of images by `observation_id`, then of measurements by `image_id`, then of
tiles. Parity, order included, is tested in pgTAP and was checked over every
fixture here (see "Parity").

**The security-review verdict for the Stage 1 candidate (`4f7f254`) does not
cover this function body.** It must be renewed on this candidate.

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
Settings: `shared_buffers=128MB`, `work_mem=4MB`, `jit=on`. JIT made no
difference to the batch: 55.0 ms with it on against 54.6 ms with it off, on
the fenced version. Every run is fully cached, so shared reads are 0
throughout.

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
docker exec -i $DB psql -U postgres -X -At -v ON_ERROR_STOP=1 < $P/parity.sql
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
data. The other 40 decoys are absent from both.

## Database work: `EXPLAIN (ANALYZE, BUFFERS)` (`bench-db.mjs`)

There were 10 repetitions. Each repetition opens a fresh backend per case and
runs the case twice. **Cold** is the first run in that backend, when the
function plan caches are empty. **Warm** is the second, which is what a reused
PostgREST pool connection sees. For (b), the figures are the sum over the 30 or
60 single-call plans.

The buffers on the top-level Function Scan include all nested function calls.
The auto_explain output below confirms it: the inner plan accounts for 13,117
of the outer node's 13,136 buffers.

Medians, with the maximum in brackets:

| ids | case | run | planning ms | execution ms | shared hit | shared read |
|---|---|---|---|---|---|---|
| 30 | (a) batch | warm | 0.01 | **14.0** (19.9) | **6,644** | 0 |
| 30 | (b) 30 singles | warm | 0.20 | **92.4** (138.1) | **13,747** | 0 |
| 30 | (a) batch | cold | 0.02 | 17.8 (35.2) | 8,940 | 0 |
| 30 | (b) 30 singles | cold | 0.23 | 97.9 (134.5) | 16,315 | 0 |
| 60 | (a) batch | warm | 0.02 | **28.3** (41.3) | **13,136** | 0 |
| 60 | (b) 60 singles | warm | 0.41 | **183.4** (285.7) | **27,278** | 0 |
| 60 | (a) batch | cold | 0.02 | 31.6 (47.0) | 15,432 | 0 |
| 60 | (b) 60 singles | cold | 0.43 | 184.5 (242.6) | 29,846 | 0 |

Buffer counts are identical in every repetition. The (b) maxima are higher
than in the earlier rounds, because the host was busier during this run. The
(b) medians are within 8 % of those rounds.

### Where the remaining work is (per point)

In the 60-id nested plan below, 11,238 of the batch's 13,117 inner buffers are
the 4,289 per-point index probes into `spore_measurement_mosaic_tiles`, about
2.6 buffers each. (b) makes the same probes. The rest is small:

- 60 image scans, 180 buffers;
- 120 measurement scans, 450 buffers;
- the mosaic helpers, 420 buffers;
- mosaic delivery authorization, about 577 buffers.

The probes now dominate the batch's buffers, but they are one cheap index
lookup per point. A different plan shape would risk changing point order
relative to `get_public_observation`, so the plan was left as it is.

`build_worker_media_url` no longer dominates either path in the batch: it runs
60 times at 30 ids, about 0.6 ms in total. In (b) it still runs once per
point, 2,154 times at 30 ids and about 11 ms in total, inside
`authorize_spore_points`.

### Per-function work (`function-calls.sql`)

`track_functions = 'all'` with `pg_stat_xact_user_functions`, one run per case
in a fresh backend. Times include the tracking overhead.

| | (a) 30 | (b) 30 | (a) 60 | (b) 60 |
|---|---|---|---|---|
| `build_worker_media_url` calls / total ms | 60 / 0.6 | 2,154 / 10.8 | 120 / 0.9 | 4,289 / 21.6 |
| `public_observation_spore_points_raw` calls | 0 | 30 | 0 | 60 |
| `public_observation_authorize_spore_points` calls | 0 | 30 | 0 | 60 |
| `public_observation_spore_mosaic_raw` calls | 30 | 30 | 60 | 60 |
| `media_authorize_mosaic_delivery` calls | 30 | — | 60 | — |
| `public_observation_eligibility` calls | 1 | 30 | 1 | 60 |
| top-level total ms | 18.1 | 83.3 | 32.0 | 165.8 |

The batch function's own time (self 14.4 ms at 30 ids, 27.2 ms at 60) is the
single-pass point query.

## Wall-clock through local PostgREST (`bench-http.mjs`)

The client is Node `fetch` going to Kong (`127.0.0.1:54321`), then PostgREST,
then Postgres. Each case runs 15 times after one unrecorded warm-up round, with
the case order rotated every round. Times are in ms.

| ids | case | requests | median | max | per-request median |
|---|---|---|---|---|---|
| 30 | (a) batch | 1 | **21.5** | **28.9** | 21.5 |
| 30 | (b) concurrency 6 | 30 | **31.3** | **38.5** | 5.5 |
| 30 | (b) concurrency 2 | 30 | 64.0 | 82.4 | 4.3 |
| 60 | (a) batch | 1 | **40.1** | **42.9** | 40.1 |
| 60 | (b) concurrency 6 | 60 | **59.2** | **67.5** | 5.3 |
| 60 | (b) concurrency 2 | 60 | 128.1 | 155.6 | 4.2 |

For one visitor, (a)'s median is 31 % below (b) at concurrency 6 at 30 ids,
and 32 % below at 60 ids. (a)'s maximum is below (b)'s median at both sizes.
(a)'s HTTP time exceeds its database execution (14 / 28 ms) by about 7–12 ms.
That is PostgREST and Kong overhead plus serializing about 2,154 or 4,289
points into the response.

The setup still favours (b): the round trip is close to 0 ms and the 10 cores
are idle, so (b)'s six parallel calls cost almost nothing beyond their
database time. Any real network round trip adds about 5 waves (30 ids) or 10
waves (60 ids) of latency to (b) and one to (a). That part is not measured
here.

**Load:** V visitors open the Cards view at the same moment. The table shows
each visitor's own time. The last column is how many requests the clients
allow in flight at most. It is not a measured database concurrency, because
PostgREST's pool of 10 connections bounds that.

| V | ids | (a) median / max | (b) concurrency 6 median / max | client requests in flight at most, (a) / (b) |
|---|---|---|---|---|
| 4 | 30 | **24.9** / 36.4 | 164.1 / 223.1 | 4 / 24 |
| 4 | 60 | **47.0** / 92.2 | 325.6 / 388.3 | 4 / 24 |
| 8 | 30 | **34.2** / 207.5 | 428.9 / 503.6 | 8 / 48 |
| 8 | 60 | **66.4** / 95.8 | 901.9 / 1,223.3 | 8 / 48 |

The 207.5 ms maximum for (a) with 8 visitors at 30 ids is one outlier among
120 visitor runs; the median is 34.2 ms.

**Concurrency 2 against 6, for `sporely-landing`'s incident doc.** For one
visitor, the per-request median is flat: 4.3 ms at concurrency 2 against
5.5 ms at concurrency 6. (b)'s total time scales with the number of waves. So
locally, with one visitor, the cost of (b) is the cost of each call, not
contention. Contention appears once visitors overlap, as the load table
shows: (b) puts up to 6 requests per visitor against a pool of 10. This
evidence does not support changing `OBSERVATION_DETAIL_CONCURRENCY`, and it
stays unchanged.

### RPC request counts and total query cost (`statements.sql`)

These are `pg_stat_statements` figures over the whole `bench-http.mjs` run,
including the load scenarios, reset immediately before it. PostgREST's
normalized statement does not separate 30-id from 60-id calls, so the figures
below are normalized per observation id requested. The run requested 196 batch
calls at each size, which is 17,640 ids, and 19,080 single calls.

| rpc | calls | ids served | total exec ms | exec ms per id | shared hit | shared hit per id | shared read |
|---|---|---|---|---|---|---|---|
| batch | 392 | 17,640 | 14,500 | **0.82** | 3,826,623 | **217** | 0 |
| single | 19,080 | 19,080 | 119,360 | **6.26** | 8,563,001 | **449** | 0 |

Per Cards-view load, the batch makes 1 request instead of 30 or 60. Its
database time per observation is 0.82 ms against 6.26 ms, and its buffers per
observation 217 against 449.

## Distance from the 3-second anon statement timeout

At 60 ids, the maximum allowed:

- Execution is 28.3 ms median and 41.3 ms max warm, and 31.6 ms median and
  47.0 ms max cold, over 10 repetitions. That is **0.9–1.6 % of 3 s**.
- Wall-clock is 40.1 ms median and 42.9 ms max for one visitor. The worst
  figure is 95.8 ms with 8 simultaneous visitors.
- `pg_stat_statements` `max_exec_ms` for the batch over the whole run,
  including the load scenarios, is 189 ms (6 % of 3 s).

Scaling: execution is about 6.6 µs per returned point, close to linear (about
14 ms for 2,154 points, about 28 ms for 4,289). At that rate, 3 s would take
roughly 450,000 points in one call, about 7,500 per observation across 60. By
design, the function does not cap points on the server. The fixtures average
70 points per observation. The distribution in production was not measured,
because there was no production access. Cold disk reads (shared read = 0 here)
would add time on a cold production cache. Stage 3's `pg_stat_statements`
baseline is where to confirm the margin in production.

## Tests for this candidate

On a fresh `supabase db reset --local`:

- pgTAP passes, 107 tests: `public_observation_spore_previews_test.sql`
  (Stage 1, unchanged: visibility matrix, parity, bounds, grants),
  `public_observation_spore_previews_eval_count_test.sql` (8) and
  `mosaic_storage_key_ownership_test.sql`.
- `public_observation_spore_previews_identity_test.sh`: `get_public_observation`
  is byte-identical over 42 visible rows.
- `observation_spore_mosaic_rpc_test.sql`, a plain psql script: passes.

Mutation checks. Each mutation was applied with `CREATE OR REPLACE` inside a
rolled-back transaction, and the named test bodies were run against it:

| Mutation of the batch function | Caught by |
|---|---|
| drop `AND i.deleted_at IS NULL` | Stage 1 parity tests (9 failures), and the eval-count gate-line test |
| `ORDER BY m.id DESC` in the point aggregate | Stage 1 parity tests (7 failures) |
| `ORDER BY m.id` in the point aggregate (control) | nothing fails, as expected |
| remove the per-image `OFFSET 0` | eval-count: `build_worker_media_url` once per image |
| `cropUrl` without the `thumb_key` condition | Stage 1 parity tests (7 failures) |
| unfenced `4f7f254` function (previous round) | eval-count, 5 of 6 tests in that version of the test |

## Raw output

### `parity.sql`

```
rows batch/single|270|270|points|18209|mismatches|0
```

### `bench-db.mjs` (10 repetitions)

```
raw: rep n case statements | cold planning execution hit read rows | warm planning execution hit read rows
1 30 a 1 | 0.03 27.50 8940 0 30 | 0.01 17.07 6644 0 30
1 30 b 30 | 0.23 95.29 16315 0 30 | 0.21 92.14 13747 0 30
1 60 a 1 | 0.02 31.56 15432 0 60 | 0.01 27.65 13136 0 60
1 60 b 60 | 0.39 180.02 29846 0 60 | 0.51 242.21 27278 0 60
2 30 b 30 | 0.29 123.96 16315 0 30 | 0.26 138.05 13747 0 30
2 30 a 1 | 0.05 33.11 8940 0 30 | 0.02 19.93 6644 0 30
2 60 b 60 | 0.54 242.57 29846 0 60 | 0.68 285.74 27278 0 60
2 60 a 1 | 0.02 34.80 15432 0 60 | 0.02 28.51 13136 0 60
3 30 a 1 | 0.02 17.92 8940 0 30 | 0.01 13.84 6644 0 30
3 30 b 30 | 0.22 90.65 16315 0 30 | 0.19 85.21 13747 0 30
3 60 a 1 | 0.02 29.97 15432 0 60 | 0.01 27.04 13136 0 60
3 60 b 60 | 0.40 181.11 29846 0 60 | 0.37 171.98 27278 0 60
4 30 b 30 | 0.29 98.11 16310 0 30 | 0.24 90.62 13747 0 30
4 30 a 1 | 0.02 17.61 8940 0 30 | 0.01 13.78 6644 0 30
4 60 b 60 | 0.36 171.34 29846 0 60 | 0.42 177.94 27278 0 60
4 60 a 1 | 0.02 30.04 15432 0 60 | 0.02 27.53 13136 0 60
5 30 a 1 | 0.02 16.55 8940 0 30 | 0.01 13.79 6644 0 30
5 30 b 30 | 0.22 101.18 16315 0 30 | 0.18 87.02 13747 0 30
5 60 a 1 | 0.02 30.95 15432 0 60 | 0.01 27.04 13136 0 60
5 60 b 60 | 0.44 191.51 29846 0 60 | 0.44 184.25 27278 0 60
6 30 b 30 | 0.21 90.95 16315 0 30 | 0.18 87.44 13747 0 30
6 30 a 1 | 0.02 16.63 8940 0 30 | 0.00 13.74 6644 0 30
6 60 b 60 | 0.40 178.35 29846 0 60 | 0.36 175.18 27278 0 60
6 60 a 1 | 0.02 30.00 15432 0 60 | 0.01 28.85 13136 0 60
7 30 a 1 | 0.03 35.17 8940 0 30 | 0.05 18.28 6644 0 30
7 30 b 30 | 0.36 134.48 16315 0 30 | 0.26 94.47 13747 0 30
7 60 a 1 | 0.02 33.40 15432 0 60 | 0.02 30.35 13136 0 60
7 60 b 60 | 0.43 200.87 29846 0 60 | 0.46 192.17 27278 0 60
8 30 b 30 | 0.21 96.51 16315 0 30 | 0.19 92.60 13747 0 30
8 30 a 1 | 0.02 17.38 8940 0 30 | 0.01 14.16 6644 0 30
8 60 b 60 | 0.52 185.23 29846 0 60 | 0.41 182.47 27278 0 60
8 60 a 1 | 0.03 47.00 15432 0 60 | 0.03 41.32 13136 0 60
9 30 a 1 | 0.03 18.55 8940 0 30 | 0.02 14.63 6644 0 30
9 30 b 30 | 0.23 97.70 16315 0 30 | 0.34 111.24 13747 0 30
9 60 a 1 | 0.02 34.53 15432 0 60 | 0.02 30.68 13136 0 60
9 60 b 60 | 0.42 186.41 29846 0 60 | 0.41 194.06 27278 0 60
10 30 b 30 | 0.28 101.80 16315 0 30 | 0.20 93.60 13747 0 30
10 30 a 1 | 0.02 17.07 8940 0 30 | 0.01 13.79 6644 0 30
10 60 b 60 | 0.43 183.69 29846 0 60 | 0.35 170.16 27278 0 60
10 60 a 1 | 0.02 31.68 15432 0 60 | 0.01 28.13 13136 0 60

summary (median / max over reps; times ms, buffers = 8 kB pages)
n case run   | planning med/max | execution med/max | shared hit med/max | shared read med/max | rows
30 a cold  | 0.02 / 0.05 | 17.77 / 35.17 | 8940.00 / 8940.00 | 0.00 / 0.00 | 30
30 a warm  | 0.01 / 0.05 | 14.00 / 19.93 | 6644.00 / 6644.00 | 0.00 / 0.00 | 30
30 b cold  | 0.23 / 0.36 | 97.91 / 134.48 | 16315.00 / 16315.00 | 0.00 / 0.00 | 30
30 b warm  | 0.20 / 0.34 | 92.37 / 138.05 | 13747.00 / 13747.00 | 0.00 / 0.00 | 30
60 a cold  | 0.02 / 0.03 | 31.62 / 47.00 | 15432.00 / 15432.00 | 0.00 / 0.00 | 60
60 a warm  | 0.02 / 0.03 | 28.32 / 41.32 | 13136.00 / 13136.00 | 0.00 / 0.00 | 60
60 b cold  | 0.43 / 0.54 | 184.46 / 242.57 | 29846.00 / 29846.00 | 0.00 / 0.00 | 60
60 b warm  | 0.41 / 0.68 | 183.36 / 285.74 | 27278.00 / 27278.00 | 0.00 / 0.00 | 60
```

### `function-calls.sql` (label | rows | function | calls | total ms | self ms)

```
a30|30|public.get_public_observation_spore_previews|1|18.1|14.4
a30|30|public.media_authorize_mosaic_delivery|30|1.5|1.5
a30|30|public.build_worker_media_url|60|0.6|0.4
a30|30|private.public_observation_authorize_spore_mosaic|30|0.5|0.3
a30|30|private.public_observation_eligibility|1|0.5|0.5
a30|30|private.public_observation_spore_mosaic_raw|30|0.5|0.5
a30|30|public._media_worker_base_url|90|0.3|0.3
a30|30|public.build_worker_mosaic_url|30|0.3|0.2
a30|30|public.media_variant_is_supported|60|0.1|0.1
b30|30|public.get_public_observation|30|83.3|0.4
b30|30|public._get_public_observation_stage2a|30|52.2|24.8
b30|30|private.public_observation_authorize_spore_points|30|29.1|18.3
b30|30|private.public_observation_spore_points_raw|30|21.5|21.5
b30|30|public.build_worker_media_url|2154|10.8|5.4
b30|30|public._media_worker_base_url|2184|3.3|3.3
b30|30|private.public_observation_eligibility|30|3.1|3.1
b30|30|public.media_variant_is_supported|2154|2.2|2.2
b30|30|private.public_observation_spore_mosaic_raw|30|1.5|1.5
b30|30|private.public_observation_authorize_spore_mosaic|30|1.5|1.3
b30|30|public.community_contributor_label|30|1.3|1.3
b30|30|public.build_worker_mosaic_url|30|0.2|0.1
a60|60|public.get_public_observation_spore_previews|1|32.0|27.2
a60|60|public.media_authorize_mosaic_delivery|60|1.8|1.8
a60|60|public.build_worker_media_url|120|0.9|0.5
a60|60|private.public_observation_authorize_spore_mosaic|60|0.8|0.4
a60|60|private.public_observation_spore_mosaic_raw|60|0.7|0.7
a60|60|private.public_observation_eligibility|1|0.6|0.6
a60|60|public._media_worker_base_url|180|0.4|0.4
a60|60|public.build_worker_mosaic_url|60|0.4|0.2
a60|60|public.media_variant_is_supported|120|0.2|0.2
b60|60|public.get_public_observation|60|165.8|0.7
b60|60|public._get_public_observation_stage2a|60|103.2|48.5
b60|60|private.public_observation_authorize_spore_points|60|58.7|37.1
b60|60|private.public_observation_spore_points_raw|60|43.3|43.3
b60|60|public.build_worker_media_url|4289|21.6|10.7
b60|60|public._media_worker_base_url|4349|6.7|6.7
b60|60|private.public_observation_eligibility|60|5.7|5.7
b60|60|public.media_variant_is_supported|4289|4.4|4.4
b60|60|private.public_observation_authorize_spore_mosaic|60|3.2|2.8
b60|60|private.public_observation_spore_mosaic_raw|60|3.1|3.1
b60|60|public.community_contributor_label|60|2.6|2.6
b60|60|public.build_worker_mosaic_url|60|0.4|0.3
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
 Function Scan on public.get_public_observation_spore_previews  (cost=0.25..10.25 rows=1000 width=72) (actual time=49.800..49.801 rows=60 loops=1)
   Output: observation_id, points, spore_mosaic
   Function Call: get_public_observation_spore_previews('{172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,260,264,268,272,276,280,284,288,292,296,300,304,308,312,316,320,324,328,332,336,340,344,348,352,356,360,364,368,372,376,380,384,388,392,396,400,404,408}'::bigint[])
   Buffers: shared hit=13136
 Query Identifier: 1552546586357505981
 Planning Time: 0.004 ms
 Execution Time: 49.846 ms
(7 rows)

== (b) one single call (first id)
                                                                                                                                                                         QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Function Scan on public.get_public_observation  (cost=0.25..10.25 rows=1000 width=549) (actual time=3.298..3.299 rows=1 loops=1)
   Output: id, "speciesSlug", "speciesName", "speciesCommonName", "observerDisplayName", "observedOn", country, "regionId", "locationPrecision", "locationLabel", "hasMicroscopy", "sporeMeasurementCount", "sporeSummary", "sporePoints", "sporeMosaic", "contrastMethod", "mountReagent", "sampleType", "sampleSource", "prepSummary", "mapLat", "mapLon"
   Function Call: get_public_observation('172'::bigint)
   Buffers: shared hit=447
 Query Identifier: 7025787864066007552
 Planning Time: 0.023 ms
 Execution Time: 3.306 ms
(7 rows)

== (a) batch, 60 ids: nested RETURN QUERY plan (auto_explain)
 count
-------
    60
(1 row)

LOG:  duration: 29.354 ms  plan:
Query Text: SELECT
    eligible.observation_id,
    pts.points,
    CASE
      WHEN delivery.allowed IS TRUE
           AND authorized.spore_mosaic->>'mosaicMediaUrl' IS NOT NULL
        THEN authorized.spore_mosaic - 'url'
      ELSE NULL::jsonb
    END
  FROM private.public_observation_eligibility(p_observation_ids) eligible
  LEFT JOIN LATERAL (
    -- Only the fields read by normalizeSporePoints (id, lengthUm and widthUm
    -- decide whether a point is kept), ObservationCard (crop geometry,
    -- cropUrl) and sporePointFilters (prep context) leave the server.
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'id',             m.id::text,
          'lengthUm',       m.length_um,
          'widthUm',        m.width_um,
          'cropUrl',        CASE WHEN m.thumb_key IS NOT NULL THEN i.crop_url ELSE NULL END,
          'contrastMethod', nullif(btrim(coalesce(i.contrast, '')), ''),
          'mountReagent',   nullif(btrim(coalesce(i.mount_medium, '')), ''),
          'sampleType',     CASE
                              WHEN lower(btrim(coalesce(i.sample_type, ''))) IN ('fresh', 'dried')
                                THEN lower(btrim(i.sample_type))
                              ELSE NULL::text
                            END,
          'sampleSource',   CASE
                              WHEN lower(btrim(coalesce(i.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
                                THEN lower(btrim(i.sample_source))
                              ELSE NULL::text
                            END,
          'mosaicX',        t.x_px,
          'mosaicY',        t.y_px,
          'mosaicW',        t.w_px,
          'mosaicH',        t.h_px
        )
      )
    ) AS points
    FROM public.spore_measurements m
    JOIN (
      SELECT
        i.*,
        public.build_worker_media_url(i.id, 'thumb', i.media_version) AS crop_url
      FROM public.observation_images i
      WHERE eligible.spore_data_public
        AND i.observation_id = eligible.observation_id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))))
      -- Fence: evaluate crop_url once per image, not once per joined point.
      -- The image gates must stay inside it, because quals are not pushed
      -- down past OFFSET.
      OFFSET 0
    ) i
      ON i.id = m.image_id
    LEFT JOIN public.spore_measurement_mosaic_tiles t
      ON t.measurement_id = m.id
    WHERE (
        public.is_public_microscopy_measurement_type(m.measurement_type)
      )
  ) pts ON true
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
Sort  (cost=219094.42..221581.92 rows=995000 width=72) (actual time=29.240..29.243 rows=60 loops=1)
  Sort Key: eligible.observation_id
  Sort Method: quicksort  Memory: 1287kB
  Buffers: shared hit=13117
  ->  Nested Loop Left Join  (cost=20.84..38343.84 rows=995000 width=72) (actual time=0.869..29.098 rows=60 loops=1)
        Join Filter: ((private.public_observation_authorize_spore_mosaic(eligible.observation_id, CASE WHEN eligible.spore_data_public THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id) ELSE NULL::jsonb END)) IS NOT NULL)
        Buffers: shared hit=13117
        ->  Nested Loop  (cost=20.54..20838.28 rows=1000 width=72) (actual time=0.816..27.878 rows=60 loops=1)
              Buffers: shared hit=12540
              ->  Nested Loop Left Join  (cost=20.54..20318.28 rows=1000 width=57) (actual time=0.682..26.353 rows=60 loops=1)
                    Buffers: shared hit=12120
                    ->  Function Scan on public_observation_eligibility eligible  (cost=0.25..10.25 rows=1000 width=25) (actual time=0.228..0.231 rows=60 loops=1)
                          Buffers: shared hit=132
                    ->  Aggregate  (cost=20.29..20.30 rows=1 width=32) (actual time=0.435..0.435 rows=1 loops=60)
                          Buffers: shared hit=11988
                          ->  Nested Loop Left Join  (cost=0.85..20.23 rows=1 width=154) (actual time=0.015..0.087 rows=71 loops=60)
                                Buffers: shared hit=11988
                                ->  Nested Loop  (cost=0.57..18.23 rows=1 width=138) (actual time=0.013..0.053 rows=71 loops=60)
                                      Buffers: shared hit=750
                                      ->  Result  (cost=0.28..8.80 rows=1 width=742) (actual time=0.010..0.018 rows=2 loops=60)
                                            One-Time Filter: eligible.spore_data_public
                                            Buffers: shared hit=300
                                            ->  Index Scan using observation_images_observation_id_idx on observation_images i  (cost=0.28..8.55 rows=1 width=43) (actual time=0.001..0.002 rows=2 loops=60)
                                                  Index Cond: (observation_id = eligible.observation_id)
                                                  Filter: ((deleted_at IS NULL) AND (purged_at IS NULL) AND ((image_type IS NULL) OR ((image_type = 'microscope'::text) AND ((storage_path IS NOT NULL) OR public.metadata_microscope_parent_is_public(id)))))
                                                  Rows Removed by Filter: 2
                                                  Buffers: shared hit=180
                                      ->  Index Scan using spore_measurements_image_id_idx on spore_measurements m  (cost=0.29..9.41 rows=1 width=87) (actual time=0.002..0.015 rows=36 loops=120)
                                            Index Cond: (image_id = i.id)
                                            Filter: ((measurement_type IS NULL) OR (btrim(measurement_type) = ''::text) OR (lower(btrim(measurement_type)) = ANY ('{manual,spore,spores}'::text[])))
                                            Rows Removed by Filter: 2
                                            Buffers: shared hit=450
                                ->  Index Scan using spore_measurement_mosaic_tiles_pkey on spore_measurement_mosaic_tiles t  (cost=0.29..2.00 rows=1 width=24) (actual time=0.000..0.000 rows=1 loops=4289)
                                      Index Cond: (measurement_id = m.id)
                                      Buffers: shared hit=11238
              ->  Result  (cost=0.00..0.51 rows=1 width=32) (actual time=0.025..0.025 rows=1 loops=60)
                    Buffers: shared hit=420
        ->  Memoize  (cost=0.30..10.30 rows=1000 width=1) (actual time=0.019..0.019 rows=1 loops=60)
              Cache Key: (private.public_observation_authorize_spore_mosaic(eligible.observation_id, CASE WHEN eligible.spore_data_public THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id) ELSE NULL::jsonb END))
              Cache Mode: binary
              Hits: 0  Misses: 60  Evictions: 0  Overflows: 0  Memory Usage: 32kB
              Buffers: shared hit=577
              ->  Function Scan on media_authorize_mosaic_delivery delivery  (cost=0.29..10.29 rows=1000 width=1) (actual time=0.019..0.019 rows=1 loops=60)
                    Buffers: shared hit=577
LOG:  duration: 29.969 ms  plan:
Query Text: SELECT count(*) FROM public.get_public_observation_spore_previews('{172,176,180,184,188,192,196,200,204,208,212,216,220,224,228,232,236,240,244,248,252,256,260,264,268,272,276,280,284,288,292,296,300,304,308,312,316,320,324,328,332,336,340,344,348,352,356,360,364,368,372,376,380,384,388,392,396,400,404,408}'::bigint[]);
Aggregate  (cost=12.75..12.76 rows=1 width=8) (actual time=29.966..29.966 rows=1 loops=1)
  Buffers: shared hit=13145
  ->  Function Scan on get_public_observation_spore_previews  (cost=0.25..10.25 rows=1000 width=0) (actual time=29.959..29.961 rows=60 loops=1)
        Buffers: shared hit=13145
```

### `bench-http.mjs` (15 repetitions)

```
reps=15 (after 1 warm-up round); times in ms
case     | requests | total median | total max | per-request median | per-request max | raw totals
a  n=30 |        1 |         21.5 |      28.9 |               21.5 |            28.9 | 28.9 21.5 21.4 21.6 20.4 21.8 20.0 21.4 22.0 20.6 22.2 23.7 20.3 22.2 19.9
b6 n=30 |       30 |         31.3 |      38.5 |                5.5 |            13.1 | 31.2 33.5 30.5 31.3 27.9 30.4 28.8 38.5 32.6 30.3 31.3 36.2 31.4 29.6 31.8
b2 n=30 |       30 |         64.0 |      82.4 |                4.3 |             8.1 | 61.8 68.2 63.2 66.2 62.0 64.0 60.1 71.1 69.5 65.4 63.6 70.6 62.8 63.4 82.4
a  n=60 |        1 |         40.1 |      42.9 |               40.1 |            42.9 | 41.2 42.2 40.2 37.9 39.0 42.0 40.1 40.0 42.9 39.3 41.6 39.8 36.0 37.7 42.2
b6 n=60 |       60 |         59.2 |      67.5 |                5.3 |            14.4 | 62.2 59.2 57.6 55.2 53.7 53.7 52.9 67.5 66.2 60.0 56.6 65.0 60.1 58.5 59.5
b2 n=60 |       60 |        128.1 |     155.6 |                4.2 |             8.5 | 130.2 126.8 127.6 133.0 120.7 128.1 124.9 137.5 130.0 124.0 125.8 129.2 155.6 125.3 132.5

load: V simultaneous visitors, per-visitor wall-clock (ms)
V  case     | median | max   | client requests in flight at most (not a DB measurement)
4  a  n=30 |   24.9 |  36.4 | 4
4  b6 n=30 |  164.1 | 223.1 | 24
4  a  n=60 |   47.0 |  92.2 | 4
4  b6 n=60 |  325.6 | 388.3 | 24
8  a  n=30 |   34.2 | 207.5 | 8
8  b6 n=30 |  428.9 | 503.6 | 48
8  a  n=60 |   66.4 |  95.8 | 8
8  b6 n=60 |  901.9 | 1223.3 | 48
```

### `statements.sql` (after `bench-http.mjs`)

```
  rpc   | calls | total_exec_ms | mean_exec_ms | max_exec_ms | shared_blks_hit | shared_blks_read | hit_per_call
--------+-------+---------------+--------------+-------------+-----------------+------------------+--------------
 batch  |   392 |       14500.4 |        36.99 |      188.66 |         3826623 |                0 |       9761.8
 single | 19080 |      119360.0 |         6.26 |       87.54 |         8563001 |                0 |        448.8
(2 rows)

```
