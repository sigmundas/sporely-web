-- Per-function call counts and times (pg_stat_xact_user_functions) for one
-- run of each case at 30 and at 60 ids, as anon. LOCAL ONLY; seed.sql first.
--   docker exec -i <db-container> psql -U postgres -X -At -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-batch-spore-preview/function-calls.sql
-- Each case runs in its own backend-local transaction that is rolled back;
-- counters are read before ROLLBACK and are cumulative within the session,
-- so every case runs in a fresh \connect.
\set QUIET on
SELECT (SELECT array_agg(observation_id ORDER BY ordinal)::text FROM perf_bsp.ids WHERE ordinal <= 30) AS ids30,
       (SELECT array_agg(observation_id ORDER BY ordinal)::text FROM perf_bsp.ids WHERE ordinal <= 60) AS ids60 \gset

\connect
BEGIN; SET LOCAL track_functions = 'all'; SET LOCAL ROLE anon;
SELECT count(*) AS a30_rows FROM public.get_public_observation_spore_previews(:'ids30'::bigint[]) \gset
RESET ROLE;
SELECT 'a30', :a30_rows, schemaname || '.' || funcname, calls, round(total_time::numeric, 1), round(self_time::numeric, 1)
FROM pg_stat_xact_user_functions ORDER BY total_time DESC;
ROLLBACK;

\connect
BEGIN; SET LOCAL track_functions = 'all'; SET LOCAL ROLE anon;
SELECT count(*) AS b30_rows FROM unnest(:'ids30'::bigint[]) i CROSS JOIN LATERAL public.get_public_observation(i) g \gset
RESET ROLE;
SELECT 'b30', :b30_rows, schemaname || '.' || funcname, calls, round(total_time::numeric, 1), round(self_time::numeric, 1)
FROM pg_stat_xact_user_functions ORDER BY total_time DESC;
ROLLBACK;

\connect
BEGIN; SET LOCAL track_functions = 'all'; SET LOCAL ROLE anon;
SELECT count(*) AS a60_rows FROM public.get_public_observation_spore_previews(:'ids60'::bigint[]) \gset
RESET ROLE;
SELECT 'a60', :a60_rows, schemaname || '.' || funcname, calls, round(total_time::numeric, 1), round(self_time::numeric, 1)
FROM pg_stat_xact_user_functions ORDER BY total_time DESC;
ROLLBACK;

\connect
BEGIN; SET LOCAL track_functions = 'all'; SET LOCAL ROLE anon;
SELECT count(*) AS b60_rows FROM unnest(:'ids60'::bigint[]) i CROSS JOIN LATERAL public.get_public_observation(i) g \gset
RESET ROLE;
SELECT 'b60', :b60_rows, schemaname || '.' || funcname, calls, round(total_time::numeric, 1), round(self_time::numeric, 1)
FROM pg_stat_xact_user_functions ORDER BY total_time DESC;
ROLLBACK;
