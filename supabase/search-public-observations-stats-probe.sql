-- search_public_observations: aggregate statistics probe (read-only).
--
-- Plan: docs/plans/active/2026-10-13-search-public-observations-performance.md,
-- Stage 1a. Production use is limited to the one run the owner authorizes at
-- the Stage 1a gate; any further run needs its own owner approval.
--
-- Run as the database owner (postgres), with psql:
--
--   psql "<connection string>" -X -v ON_ERROR_STOP=1 \
--     -v main_sha256=<hex> \
--     -f supabase/search-public-observations-stats-probe.sql
--
-- -v main_sha256 is optional, and the production probe may run without it;
-- matches_main is then NULL. The reference hash is not part of Stage 1a: in
-- Stage 1b it is derived from an isolated local database built from
-- origin/main at f92d560 (not a stale local main), compared with the
-- functiondef_sha256 the production run printed, and a mismatch stops the
-- work.
--
-- One READ ONLY transaction ending in ROLLBACK. The only SET is SET LOCAL of
-- statement_timeout and search_path. No DDL, no write, no reset of any
-- statistics, no auto_explain.
--
-- It prints timestamps, settings, role names, table and index names, index
-- definitions, a hash and integers. It never prints query text, row ids,
-- user ids or any observation, image or measurement value, so no personal
-- data can leak. Per-owner counts appear only as a p50/p95/max distribution.
--
-- pg_stat_statements tagging and exclusions follow
-- supabase/batch-spore-preview-stats-probe.sql. Statements carrying the
-- marker /* spo_probe */ (this probe) or /* bsp_probe */ are left out, as is
-- anything that reads pg_stat_statements.
--
-- Output, in order (one result set per statement):
--   1. epoch (1 row): taken_at, stats_reset, dealloc, track, max_entries,
--      entries_now.
--   2. statements (1 row per executing role): role, entries, calls,
--      total_exec_ms, mean_exec_ms, max_exec_ms, stddev_exec_ms, rows,
--      shared_blks_hit, shared_blks_read, temp_blks_written.
--   3. counts (1 row): public_observations, with_gated_microscope_image,
--      with_public_spore_measurements, metadata_parent_images,
--      spore_measurements, obs_per_owner_p50, obs_per_owner_p95,
--      obs_per_owner_max.
--   4. tables (1 row per table): table_name, n_live_tup, n_dead_tup,
--      last_analyze, last_autoanalyze, last_vacuum, last_autovacuum.
--   5. indexes (1 row per index): table_name, index_name, indexdef,
--      idx_scan, size_bytes.
--   6. function (1 row per overload): function, functiondef_sha256,
--      main_sha256, matches_main.
--   7. write check (1 row): wrote_nothing.
--
-- Local validation, 2026-10-13, against the local Supabase CLI database only
-- (container supabase_db_zkpjklzfwzefhjluvhfw), with exactly:
--
--   docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -X \
--     -v ON_ERROR_STOP=1 < supabase/search-public-observations-stats-probe.sql
--
-- Result: BEGIN, SET, SET, the seven result sets, ROLLBACK, exit 0. The
-- transaction is READ ONLY, wrote_nothing = t (no transaction id assigned),
-- and only the columns listed above were printed. That database holds no
-- observations, so the counts are 0 and the per-owner distribution is NULL;
-- its one pg_stat_statements entry does not exercise the multi-entry pooling.
-- Its functiondef_sha256 is not a reference for main (see above). Sample
-- output, index definitions elided to keep the header short:
--
--   1. taken_at 2026-10-13 17:58:16.630872+00 | stats_reset
--      2026-10-12 10:59:18.426361+00 | dealloc 0 | track top |
--      max_entries 5000 | entries_now 78
--   2. postgres | entries 1 | calls 2 | total_exec_ms 350.5 |
--      mean_exec_ms 175.3 | max_exec_ms 181.2 | stddev_exec_ms 6.0 |
--      rows 0 | shared_blks_hit 44650 | shared_blks_read 25 |
--      temp_blks_written 0
--   3. public_observations 0 | with_gated_microscope_image 0 |
--      with_public_spore_measurements 0 | metadata_parent_images 0 |
--      spore_measurements 0 | obs_per_owner_p50/p95/max NULL
--   4. observation_images 0 live, 0 dead, last_autovacuum
--        2026-10-12 13:49:26.680692+00, others NULL
--      observations       0 live, 0 dead, last_autovacuum
--        2026-10-12 13:49:26.688877+00, others NULL
--      spore_measurements 0 live, 32 dead, all four NULL
--   5. 30 rows (8 observation_images, 15 observations, 7 spore_measurements),
--      e.g. observation_images | observation_images_observation_id_idx |
--      CREATE INDEX ... USING btree (observation_id) | idx_scan 450 |
--      size_bytes 16384
--   6. search_public_observations(integer,integer,text,text,text,text,date,
--      date,boolean,boolean,text,text,text,text,text) | functiondef_sha256
--      84db51be5bcfbcc63d72b6cfb5068cbe12bf18a989c879febf7ebf3bfa9e28c2 |
--      main_sha256 NULL | matches_main NULL
--   7. wrote_nothing t

\if :{?main_sha256}
\else
\set main_sha256 ''
\endif

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = extensions, public, pg_catalog;

-- 1. Counter epoch. Two snapshots bound a valid window only if stats_reset
-- and dealloc are identical in both (see the batch spore-preview probe).
SELECT /* spo_probe */
  now()                                              AS taken_at,
  i.stats_reset,
  i.dealloc,
  current_setting('pg_stat_statements.track')        AS track,
  current_setting('pg_stat_statements.max')          AS max_entries,
  (SELECT count(*) FROM pg_stat_statements)          AS entries_now
FROM pg_stat_statements_info i;

-- 2. One row per executing role, combining that role's entries exactly:
-- calls, totals, rows and blocks are summed; the mean is weighted by calls;
-- the maximum is the maximum; the standard deviation is pooled from the
-- per-entry (population) standard deviations:
--   N = sum(n_i), mu = sum(n_i * mu_i) / N,
--   variance = sum(n_i * (sigma_i^2 + mu_i^2)) / N - mu^2.
-- Per-entry standard deviations are never averaged. Arithmetic is numeric;
-- greatest(0, ...) only absorbs rounding below zero.
WITH tagged AS (
  SELECT /* spo_probe */
    r.rolname,
    s.calls::numeric                       AS n,
    s.total_exec_time::numeric             AS total_ms,
    s.mean_exec_time::numeric              AS mean_ms,
    s.stddev_exec_time::numeric            AS stddev_ms,
    s.max_exec_time::numeric               AS max_ms,
    s.rows,
    s.shared_blks_hit,
    s.shared_blks_read,
    s.temp_blks_written
  FROM pg_stat_statements s
  LEFT JOIN pg_roles r ON r.oid = s.userid
  WHERE s.query ~* '(^|[^a-z0-9_])search_public_observations"?\s*\('
    AND s.query NOT ILIKE '%pg_stat_statements%'
    AND s.query NOT LIKE '%bsp_probe%'
    AND s.query NOT LIKE '%spo_probe%'
),
per_role AS (
  SELECT
    coalesce(rolname, '(unknown)')                  AS role,
    count(*)                                        AS entries,
    sum(n)                                          AS n,
    sum(total_ms)                                   AS total_ms,
    sum(n * mean_ms)                                AS sum_n_mu,
    sum(n * (stddev_ms * stddev_ms + mean_ms * mean_ms)) AS sum_n_m2,
    max(max_ms)                                     AS max_ms,
    sum(rows)                                       AS rows,
    sum(shared_blks_hit)                            AS shared_blks_hit,
    sum(shared_blks_read)                           AS shared_blks_read,
    sum(temp_blks_written)                          AS temp_blks_written
  FROM tagged
  GROUP BY 1
)
SELECT
  role,
  entries,
  n::bigint                                                         AS calls,
  round(total_ms, 1)                                                AS total_exec_ms,
  round(sum_n_mu / nullif(n, 0), 1)                                 AS mean_exec_ms,
  round(max_ms, 1)                                                  AS max_exec_ms,
  round(sqrt(greatest(
    sum_n_m2 / nullif(n, 0) - (sum_n_mu / nullif(n, 0)) ^ 2,
    0
  )), 1)                                                            AS stddev_exec_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written
FROM per_role
ORDER BY role;

-- 3. Data shape. public_observations is visibility = 'public' and not a
-- draft; the two "with_" counts are subsets of it. The microscope image gate
-- and the spore-measurement predicate are the ones search_public_observations
-- applies with no context filter (hasMicroscopy and sporeMeasurementCount > 0).
-- Banned owners are not excluded here. metadata_parent_images counts every
-- microscope image row with storage_path IS NULL, deleted or not;
-- spore_measurements counts every row. Per-owner counts are over public
-- non-draft observations with a non-null owner.
WITH pub AS (
  SELECT /* spo_probe */ o.id, o.user_id, o.spore_data_visibility
  FROM public.observations o
  WHERE o.visibility = 'public'::text
    AND NOT coalesce(o.is_draft, false)
),
gated_image AS (
  SELECT i.id, i.observation_id
  FROM public.observation_images i
  WHERE i.deleted_at IS NULL
    AND i.purged_at IS NULL
    AND i.image_type = 'microscope'
    AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))
),
per_owner AS (
  SELECT count(*) AS n
  FROM pub
  WHERE user_id IS NOT NULL
  GROUP BY user_id
)
SELECT
  (SELECT count(*) FROM pub)                                        AS public_observations,
  (SELECT count(*)
     FROM pub p
    WHERE EXISTS (SELECT 1 FROM gated_image g WHERE g.observation_id = p.id))
                                                                    AS with_gated_microscope_image,
  (SELECT count(*)
     FROM pub p
    WHERE p.spore_data_visibility = 'public'::text
      AND EXISTS (
        SELECT 1
        FROM gated_image g
        JOIN public.spore_measurements m ON m.image_id = g.id
        WHERE g.observation_id = p.id
          AND public.is_public_microscopy_measurement_type(m.measurement_type)
          AND m.length_um IS NOT NULL
          AND m.width_um IS NOT NULL
      ))                                                            AS with_public_spore_measurements,
  (SELECT count(*)
     FROM public.observation_images i
    WHERE i.image_type = 'microscope'
      AND i.storage_path IS NULL)                                   AS metadata_parent_images,
  (SELECT count(*) FROM public.spore_measurements)                  AS spore_measurements,
  (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) FROM per_owner)
                                                                    AS obs_per_owner_p50,
  (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY n) FROM per_owner)
                                                                    AS obs_per_owner_p95,
  (SELECT max(n) FROM per_owner)                                    AS obs_per_owner_max;

-- 4. Table statistics.
SELECT /* spo_probe */
  t.relname          AS table_name,
  t.n_live_tup,
  t.n_dead_tup,
  t.last_analyze,
  t.last_autoanalyze,
  t.last_vacuum,
  t.last_autovacuum
FROM pg_stat_user_tables t
WHERE t.schemaname = 'public'
  AND t.relname IN ('observations', 'observation_images', 'spore_measurements')
ORDER BY t.relname;

-- 5. Index definitions, use and size.
SELECT /* spo_probe */
  x.relname                         AS table_name,
  x.indexrelname                    AS index_name,
  pg_get_indexdef(x.indexrelid)     AS indexdef,
  x.idx_scan,
  pg_relation_size(x.indexrelid)    AS size_bytes
FROM pg_stat_user_indexes x
WHERE x.schemaname = 'public'
  AND x.relname IN ('observations', 'observation_images', 'spore_measurements')
ORDER BY x.relname, x.indexrelname;

-- 6. Function definition hash, compared with main (see the header).
SELECT /* spo_probe */
  p.oid::regprocedure::text                                          AS function,
  encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS functiondef_sha256,
  nullif(:'main_sha256', '')                                         AS main_sha256,
  encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex')
    = nullif(:'main_sha256', '')                                     AS matches_main
FROM pg_proc p
JOIN pg_namespace ns ON ns.oid = p.pronamespace
WHERE ns.nspname = 'public'
  AND p.proname = 'search_public_observations'
ORDER BY 1;

-- 7. Write check: no transaction id is assigned unless something wrote.
SELECT /* spo_probe */ txid_current_if_assigned() IS NULL AS wrote_nothing;

ROLLBACK;
