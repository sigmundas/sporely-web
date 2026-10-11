-- Batch spore-preview RPC: aggregate pg_stat_statements snapshot (read-only).
--
-- Runbook: supabase/batch-spore-preview-runbook.md, step 5. Run it at both
-- ends of a measurement window (B0 and B1 before the landing switch; A0 and
-- A1 after it, for sporely-landing's explorer-cards-batch-preview Stage 2).
-- Only deltas within a valid window are evidence; a single cumulative
-- snapshot is not (see the runbook).
--
-- Run as the database owner (postgres), with psql:
--
--   psql "<connection string>" -X -v ON_ERROR_STOP=1 -f supabase/batch-spore-preview-stats-probe.sql
--
-- It prints timestamps, settings, role names and integers. It never prints
-- query text, so no literal from a recorded statement (an observation id, a
-- user id) can leak. It does not reset pg_stat_statements; never reset it as
-- part of this runbook, because the landing comparison needs the same
-- counters.
--
-- Statements from supabase/batch-spore-preview-live-probe.sql carry the
-- marker /* bsp_probe */ and are left out.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = extensions, public, pg_catalog;

-- Counter epoch. Two snapshots bound a valid window only if stats_reset and
-- dealloc are identical in both: any dealloc rise means some entry was
-- evicted, possibly one counted below, and an evicted entry restarts from
-- zero without changing stats_reset. Such a window is inconclusive, for
-- totals and means alike.
SELECT
  now()                                              AS taken_at,
  i.stats_reset,
  i.dealloc,
  current_setting('pg_stat_statements.track')        AS track,
  current_setting('pg_stat_statements.max')          AS max_entries,
  (SELECT count(*) FROM pg_stat_statements)          AS entries_now
FROM pg_stat_statements_info i;

-- One row per function and executing role. With track = top only top-level
-- statements are counted: the Worker's /m/ and /mm/ RPCs and the explorer's
-- PostgREST calls are top-level, but media_authorize_mosaic_delivery calls
-- made inside the batch function are not.
WITH tagged AS (
  SELECT
    CASE
      WHEN s.query ~* 'get_public_observation_spore_previews"?\s*\(' THEN 'get_public_observation_spore_previews'
      WHEN s.query ~* '(^|[^a-z0-9_])get_public_observation"?\s*\(' THEN 'get_public_observation'
      WHEN s.query ~* 'media_authorize_mosaic_delivery"?\s*\(' THEN 'media_authorize_mosaic_delivery'
      WHEN s.query ~* 'media_authorize_delivery"?\s*\(' THEN 'media_authorize_delivery'
    END AS fn,
    r.rolname,
    s.calls,
    s.total_exec_time,
    s.max_exec_time,
    s.rows,
    s.shared_blks_hit,
    s.shared_blks_read
  FROM pg_stat_statements s
  LEFT JOIN pg_roles r ON r.oid = s.userid
  WHERE s.query NOT ILIKE '%pg_stat_statements%'
    AND s.query NOT LIKE '%bsp_probe%'
)
SELECT
  fn,
  coalesce(rolname, '(unknown)')                                       AS role,
  count(*)                                                             AS entries,
  sum(calls)                                                           AS calls,
  round(sum(total_exec_time)::numeric, 1)                              AS total_exec_ms,
  round((sum(total_exec_time) / nullif(sum(calls), 0))::numeric, 1)    AS mean_exec_ms,
  round(max(max_exec_time)::numeric, 1)                                AS max_exec_ms,
  sum(rows)                                                            AS rows,
  sum(shared_blks_hit)                                                 AS shared_blks_hit,
  sum(shared_blks_read)                                                AS shared_blks_read
FROM tagged
WHERE fn IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2;

ROLLBACK;
