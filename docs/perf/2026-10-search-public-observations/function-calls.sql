-- Helper-function call counts and times (pg_stat_xact_user_functions) for one
-- call of every scenario in perf_spo.scenario, as anon. LOCAL ISOLATED
-- DATABASE ONLY; seed.sql (or a seed-*.sql) first, and counter-check.sql
-- validated beforehand.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -At -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/function-calls.sql
-- Each case runs in its own transaction, rolled back after the counters are
-- read. Unflushed counters are per backend, so every case starts with a fresh
-- \connect. Output columns: sid, rows returned, function, calls, total ms,
-- self ms. Only public-schema functions are listed; inlined functions
-- (is_public_microscopy_measurement_type, LANGUAGE sql IMMUTABLE, not
-- SECURITY DEFINER) do not appear.
\set QUIET on
CREATE OR REPLACE FUNCTION perf_spo.fcalls()
RETURNS TABLE (funcname name, calls bigint, total_ms numeric, self_ms numeric)
LANGUAGE sql STABLE AS $$
  SELECT f.funcname, f.calls, round(f.total_time::numeric, 1), round(f.self_time::numeric, 1)
  FROM pg_stat_xact_user_functions f
  WHERE f.schemaname = 'public'
  ORDER BY f.funcname
$$;

SELECT 'seeded', scale || 'x ' || variant FROM perf_spo.seeded;
-- Candidates (public, not draft, owner not banned; anon sees no blocks) and
-- the metadata-parent rows on them that pass the cheaper lateral quals.
SELECT 'candidates', count(*) FROM public.observations o
WHERE o.visibility = 'public' AND NOT coalesce(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned);
SELECT 'parents_reached_per_lateral', count(*) FROM public.observation_images i
JOIN public.observations o ON o.id = i.observation_id
WHERE o.visibility = 'public' AND NOT coalesce(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned)
  AND i.image_type = 'microscope' AND i.storage_path IS NULL AND i.deleted_at IS NULL AND i.purged_at IS NULL;

\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(1) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 1, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(2) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 2, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(3) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 3, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(4) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 4, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(5) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 5, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(6) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 6, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(7) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 7, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(8) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 8, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(9) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 9, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(10) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 10, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(11) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 11, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(12) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 12, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(13) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 13, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(14) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 14, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(15) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 15, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(16) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 16, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(17) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 17, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(18) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 18, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(19) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 19, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(20) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 20, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(21) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 21, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(22) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 22, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(23) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 23, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(24) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 24, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(25) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 25, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(26) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 26, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(27) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 27, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(28) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 28, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(29) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 29, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(30) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 30, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(31) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 31, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
\connect
BEGIN; SET LOCAL track_functions = 'all'; SELECT perf_spo.call_sql(32) AS call \gset
SET LOCAL ROLE anon; SELECT count(*) AS n FROM :call \gset
RESET ROLE; SELECT 32, :n, f.* FROM perf_spo.fcalls() f; ROLLBACK;
