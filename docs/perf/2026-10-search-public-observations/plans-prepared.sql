-- The function body, taken verbatim from the deployed definition
-- (pg_proc.prosrc, parameter names replaced by $1..$15), prepared and run
-- under plan_cache_mode force_generic_plan and force_custom_plan.
-- LOCAL ISOLATED DATABASE ONLY; seed.sql (or a seed-*.sql) first.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/plans-prepared.sql
--
-- Runs as postgres, the function's owner, which is the role a SECURITY
-- DEFINER body runs as; auth.uid() is NULL as for anon. search_path is set
-- to the function's own (public). The generic plan is what the SQL function
-- executes; the custom plan shows what knowing the argument values would
-- change.
\set QUIET on
\pset footer off
SELECT scale || 'x ' || variant AS seeded FROM perf_spo.seeded \gset
\echo '== prepared body at' :seeded

CREATE OR REPLACE FUNCTION perf_spo.body_sql()
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  src text;
  names text[];
BEGIN
  SELECT p.prosrc, p.proargnames INTO src, names
  FROM pg_proc p
  WHERE p.oid = 'public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text, text)'::regprocedure;
  FOR n IN 1..15 LOOP
    src := regexp_replace(src, '\m' || names[n] || '\M', '$' || n, 'g');
  END LOOP;
  RETURN src;
END
$$;

SELECT 'PREPARE spo_body(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text, text) AS '
       || perf_spo.body_sql() AS prep \gset
SET search_path = public;
:prep;

\echo '== force_generic_plan: mic=true lim31 off0'
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, NULL);
\echo '== force_custom_plan: mic=true lim31 off0'
SET plan_cache_mode = force_custom_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, NULL);

\echo '== force_generic_plan: mic=true lim31 off300'
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 300, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, NULL);
\echo '== force_custom_plan: mic=true lim31 off300'
SET plan_cache_mode = force_custom_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 300, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, NULL, NULL);

\echo '== force_generic_plan: mic=false lim31 off0'
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL);
\echo '== force_custom_plan: mic=false lim31 off0'
SET plan_cache_mode = force_custom_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL, NULL, NULL);

\echo '== force_generic_plan: observer substring, mic=true'
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(31, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true, NULL, NULL, NULL, 'Owner 02', NULL);

DEALLOCATE spo_body;
RESET plan_cache_mode;
RESET search_path;
