-- Repeated timings and buffers for every scenario in perf_spo.scenario, as
-- anon. LOCAL ISOLATED DATABASE ONLY; seed.sql (or a seed-*.sql) first.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/bench.sql
--
-- Per scenario: 2 warm-up calls, then 20 measured calls of
--   EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT * FROM <call>
-- with the role switched to anon around each call. TIMING OFF keeps per-node
-- clocks out of the measurement; the function body itself is not
-- instrumented (auto_explain is off here). Execution time and buffers are the
-- top node's, which include all work done inside the SECURITY DEFINER
-- function, its helpers and the per-call planning of its body. Shared buffers
-- are warm, as in production (probe: 346 blocks read against 38.9 million
-- hit). anon's 3 s statement_timeout is a login-time role setting and does
-- not apply under SET ROLE, so slow calls finish and are measured.
\set QUIET on
\pset footer off
SELECT scale || 'x ' || variant AS seeded FROM perf_spo.seeded \gset
\echo '== bench at' :seeded

CREATE TEMP TABLE bench (sid int, rep int, exec_ms numeric, hit bigint, read bigint, rows bigint);

DO $bench$
DECLARE
  s record;
  q text;
  j json;
  rep int;
BEGIN
  FOR s IN SELECT sid FROM perf_spo.scenario ORDER BY sid LOOP
    q := 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT * FROM ' || perf_spo.call_sql(s.sid);
    FOR rep IN -1..20 LOOP
      PERFORM set_config('role', 'anon', true);
      EXECUTE q INTO j;
      PERFORM set_config('role', 'none', true);
      IF rep > 0 THEN
        INSERT INTO bench VALUES (
          s.sid, rep,
          (j -> 0 ->> 'Execution Time')::numeric,
          (j -> 0 -> 'Plan' ->> 'Shared Hit Blocks')::bigint,
          (j -> 0 -> 'Plan' ->> 'Shared Read Blocks')::bigint,
          (j -> 0 -> 'Plan' ->> 'Actual Rows')::bigint);
      END IF;
    END LOOP;
  END LOOP;
END
$bench$;

\echo '== per scenario (ms; buffers are 8 kB pages per call; margin = 3000 - max)'
SELECT b.sid, s.label, max(b.rows) AS rows,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY b.exec_ms))::numeric, 1) AS median_ms,
       round(percentile_disc(0.95) WITHIN GROUP (ORDER BY b.exec_ms), 1) AS p95_ms,
       round(max(b.exec_ms), 1) AS max_ms,
       round(3000 - max(b.exec_ms), 1) AS margin_ms,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY b.hit) AS hit_median,
       max(b.hit) AS hit_max,
       max(b.read) AS read_max
FROM bench b JOIN perf_spo.scenario s USING (sid)
GROUP BY b.sid, s.label
ORDER BY b.sid;
