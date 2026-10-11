-- pg_stat_statements for the PostgREST calls made by bench-http.mjs (reset
-- immediately before it). LOCAL ONLY.
SELECT CASE WHEN query ILIKE '%get_public_observation_spore_previews%' THEN 'batch'
            WHEN query ILIKE '%zz_today_get_public_observation%' THEN 'single today'
            ELSE 'single' END AS rpc,
       calls,
       round(total_exec_time::numeric, 1) AS total_exec_ms,
       round(mean_exec_time::numeric, 2) AS mean_exec_ms,
       round(max_exec_time::numeric, 2) AS max_exec_ms,
       shared_blks_hit,
       shared_blks_read,
       round(shared_blks_hit::numeric / calls, 1) AS hit_per_call
FROM pg_stat_statements
WHERE (query ILIKE '%get_public_observation%') AND query NOT ILIKE '%pg_stat_statements%'
ORDER BY 1;
