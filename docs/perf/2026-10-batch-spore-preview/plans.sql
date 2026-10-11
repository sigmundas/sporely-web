-- Text plans for one warm run of each case, as anon. LOCAL ONLY; seed.sql first.
--   docker exec -i <db-container> psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-batch-spore-preview/plans.sql
-- Top-level EXPLAIN shows only the Function Scan (SECURITY DEFINER functions
-- are never inlined); auto_explain with nested statements shows the inner
-- RETURN QUERY of the batch function (auto_explain is preloaded locally). Statements under 20 ms (the per-
-- observation helper calls) are not logged.
\set QUIET on
SELECT (SELECT array_agg(observation_id ORDER BY ordinal)::text FROM perf_bsp.ids WHERE ordinal <= 60) AS ids60,
       (SELECT observation_id FROM perf_bsp.ids WHERE ordinal = 1) AS id1 \gset
SET ROLE anon;
-- warm the backend's plan caches
SELECT count(*) FROM public.get_public_observation_spore_previews(:'ids60'::bigint[]);
SELECT count(*) FROM public.get_public_observation(:id1);
\echo '== (a) batch, 60 ids'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT * FROM public.get_public_observation_spore_previews(:'ids60'::bigint[]);
\echo '== (b) one single call (first id)'
EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT * FROM public.get_public_observation(:id1);
RESET ROLE;
\echo '== (a) batch, 60 ids: nested RETURN QUERY plan (auto_explain)'
SET auto_explain.log_min_duration = '20ms';
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_nested_statements = on;
SET client_min_messages = log;
SET ROLE anon;
SELECT count(*) FROM public.get_public_observation_spore_previews(:'ids60'::bigint[]);
