-- OPTIONAL PRODUCTION PLAN CAPTURE. PREPARED IN STAGE 1B; NOT RUN BY ANY AGENT.
--
-- Authorization: only the owner runs this, and only after a separate,
-- explicit owner approval at the Stage 1b human gate ("whether a production
-- plan capture is needed"). Nothing in Stage 1b authorizes it. Agents never
-- connect to production.
--
-- Allowed operation (plan, Stage 1b human gate), and nothing else:
--   one owner session, one transaction: LOAD 'auto_explain'; SET LOCAL of
--   auto_explain.log_min_duration = 0, log_analyze, log_buffers,
--   log_nested_statements and log_format = text; SET LOCAL ROLE anon;
--   SET LOCAL statement_timeout = '15s'; at most four calls; ROLLBACK.
--   No ALTER SYSTEM, ALTER ROLE, ALTER DATABASE, extension or configuration
--   change. The SET LOCAL values end with the transaction.
--
-- Calls (three; the "default page 1" is the same request as call 1, so the
-- fourth allowed call is not used): p_has_microscopy true at offsets 0 and 30,
-- and false at offset 0, all with p_limit 31. Each call returns one count,
-- never rows, so no observation data reaches the terminal.
--
-- Checks the owner makes (stop condition: if either fails, record the capture
-- as unavailable and try nothing else without a new approval):
--   1. LOAD 'auto_explain' and the SET LOCAL auto_explain.* lines succeed for
--      the postgres role. If any is refused ("permission denied", "must be
--      superuser", unrecognized parameter), stop: the transaction is rolled
--      back by the error.
--   2. The nested plans appear in the Supabase Postgres logs for this session
--      (Dashboard > Logs > Postgres, filtered on the capture's time window).
--      With log_nested_statements, each call should log the function body
--      ("Query Text: ... WITH normalized AS ...") and many short helper
--      statements. If no body plan appears, stop.
--
-- Output to return: for each call, the logged body plan text only (node
-- types, timings, buffers, row counts and loops). The parameter values are
-- only the limit, offset and booleans. Remove everything else (other
-- sessions' log lines, connection details, any identifier) before returning
-- it. Helper-statement plans need not be returned; their number per call is
-- useful if easy to count.
--
-- Run (owner, production connection string supplied outside this file):
--   psql "<owner production connection>" -X -v ON_ERROR_STOP=1 \
--     -f docs/perf/2026-10-search-public-observations/production-plan-capture.sql
BEGIN;
LOAD 'auto_explain';
SET LOCAL auto_explain.log_min_duration = 0;
SET LOCAL auto_explain.log_analyze = on;
SET LOCAL auto_explain.log_buffers = on;
SET LOCAL auto_explain.log_nested_statements = on;
SET LOCAL auto_explain.log_format = text;
SET LOCAL statement_timeout = '15s';
SET LOCAL ROLE anon;
SELECT count(*) AS capture_1_mic_true_off0
FROM public.search_public_observations(p_limit => 31, p_offset => 0, p_has_microscopy => true);
SELECT count(*) AS capture_2_mic_true_off30
FROM public.search_public_observations(p_limit => 31, p_offset => 30, p_has_microscopy => true);
SELECT count(*) AS capture_3_mic_false_off0
FROM public.search_public_observations(p_limit => 31, p_offset => 0, p_has_microscopy => false);
ROLLBACK;
