-- Per-node plans of the function body as it really runs, as anon, through
-- local auto_explain (log_analyze, log_buffers, log_nested_statements).
-- LOCAL ISOLATED DATABASE ONLY; seed.sql (or a seed-*.sql) first.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/plans.sql
--
-- The top-level EXPLAIN shows only a Function Scan: a SECURITY DEFINER SQL
-- function is never inlined. Its body is planned on every call without the
-- argument values (a generic plan). auto_explain logs that nested plan.
--
-- This file is a cross-check, not the per-node evidence: it confirms, for 11
-- representative scenarios, that the body plan of a real call has the same
-- shape as the force_generic_plan plan in plans-prepared.sql, which covers
-- all 32 scenarios without a duration threshold. Here, statements under 5 ms
-- are not logged so that the thousands of per-row helper statements stay
-- out; a body that itself runs under 5 ms is then missing too, and the
-- results record which ones were.
\set QUIET on
\pset footer off
SELECT scale || 'x ' || variant AS seeded FROM perf_spo.seeded \gset
\echo '== plans at' :seeded

SELECT perf_spo.call_sql(1) AS c1, perf_spo.call_sql(2) AS c2, perf_spo.call_sql(4) AS c4,
       perf_spo.call_sql(5) AS c5, perf_spo.call_sql(9) AS c9, perf_spo.call_sql(13) AS c13,
       perf_spo.call_sql(21) AS c21, perf_spo.call_sql(23) AS c23, perf_spo.call_sql(26) AS c26,
       perf_spo.call_sql(27) AS c27, perf_spo.call_sql(28) AS c28 \gset

\echo '== top level, sid 1 (default page 1)'
SET ROLE anon;
SELECT count(*) FROM :c1;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM :c1;
RESET ROLE;

SET auto_explain.log_min_duration = '5ms';
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_timing = on;
SET auto_explain.log_nested_statements = on;
SET auto_explain.log_format = 'text';
SET client_min_messages = log;
SET ROLE anon;
\echo '== sid 1: default mic=true lim31 off0'
SELECT count(*) FROM :c1;
\echo '== sid 2: default mic=true lim31 off30'
SELECT count(*) FROM :c2;
\echo '== sid 4: default mic=true lim31 off300'
SELECT count(*) FROM :c4;
\echo '== sid 5: no filters off0'
SELECT count(*) FROM :c5;
\echo '== sid 9: mic=false off0'
SELECT count(*) FROM :c9;
\echo '== sid 13: spo=true mic=true off0'
SELECT count(*) FROM :c13;
\echo '== sid 21: spo=false mic=false off0'
SELECT count(*) FROM :c21;
\echo '== sid 23: genus mic=true'
SELECT count(*) FROM :c23;
\echo '== sid 26: date range mic=true'
SELECT count(*) FROM :c26;
\echo '== sid 27: observer substring mic=true'
SELECT count(*) FROM :c27;
\echo '== sid 28: table lim51 mic=true off0'
SELECT count(*) FROM :c28;
RESET ROLE;
RESET client_min_messages;
