-- Per-node time and buffers for every scenario in perf_spo.scenario: the
-- function body, taken verbatim from the deployed definition
-- (pg_proc.prosrc, parameter names replaced by $1..$15), prepared and run
-- with EXPLAIN (ANALYZE, BUFFERS) under plan_cache_mode force_generic_plan,
-- then again under force_custom_plan.
-- LOCAL ISOLATED DATABASE ONLY; seed.sql (or a seed-*.sql) first.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/plans-prepared.sql
--
-- This is the per-node evidence for all 32 scenarios. Unlike auto_explain
-- with a duration threshold, it never drops a fast plan, and it does not log
-- the thousands of helper-call statements (their time is inside the nodes
-- that call them; their counts come from function-calls.sql).
--
-- Runs as postgres, the function's owner, which is the role a SECURITY
-- DEFINER body runs as; auth.uid() is NULL as for anon. search_path is set
-- to the function's own (public). The generic plan is what the SQL function
-- executes (plans.sql cross-checks its shape against the body plans
-- auto_explain logs for real calls); the custom plan shows what knowing the
-- argument values would change.
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

-- EXECUTE arguments for one scenario, in the function's parameter order.
CREATE OR REPLACE FUNCTION perf_spo.exec_args(p_sid int)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format('%s, %s, %L, %L, NULL, NULL, %L, %L, %L, %L, NULL, NULL, NULL, %L, NULL',
                s.p_limit, s.p_offset, s.p_genus, s.p_species, s.p_date_from, s.p_date_to,
                s.p_has_spores, s.p_has_microscopy, s.p_observer)
  FROM perf_spo.scenario s WHERE s.sid = p_sid
$$;

SELECT 'PREPARE spo_body(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text, text) AS '
       || perf_spo.body_sql() AS prep \gset
SET search_path = public;
:prep;

\echo '======== force_generic_plan (what the SQL function runs)'
SET plan_cache_mode = force_generic_plan;
SELECT q FROM perf_spo.scenario s
CROSS JOIN LATERAL (VALUES
  (1, format('SELECT %L AS scenario', 'generic sid ' || s.sid || ': ' || s.label)),
  (2, format('EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(%s)', perf_spo.exec_args(s.sid)))) v(o, q)
ORDER BY s.sid, v.o \gexec

\echo '======== force_custom_plan'
SET plan_cache_mode = force_custom_plan;
SELECT q FROM perf_spo.scenario s
CROSS JOIN LATERAL (VALUES
  (1, format('SELECT %L AS scenario', 'custom sid ' || s.sid || ': ' || s.label)),
  (2, format('EXPLAIN (ANALYZE, BUFFERS) EXECUTE spo_body(%s)', perf_spo.exec_args(s.sid)))) v(o, q)
ORDER BY s.sid, v.o \gexec

DEALLOCATE spo_body;
RESET plan_cache_mode;
RESET search_path;
