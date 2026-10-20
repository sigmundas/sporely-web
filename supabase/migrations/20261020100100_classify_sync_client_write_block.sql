-- Classify private.sync_client_write_block (20261014120000) in the database
-- health report. It was created after 20261011190000 and matched no rule, so
-- admin_database_health reported it as unclassified. It is an operator
-- control table: system_other / app_operations.
--
-- Plan: sporely-admin docs/plans/2026-10-20-sync-health-monitoring.md, S1.
-- The function body is 20261011190000's verbatim, plus one rule; signature,
-- volatility, search_path, owner and grants are unchanged.

CREATE OR REPLACE FUNCTION private.admin_database_health_classify(
  p_schema text,
  p_table text,
  p_has_release_id boolean DEFAULT false
)
RETURNS TABLE (category text, component text)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT x[1], x[2]
  FROM (
    SELECT CASE
      -- 1. One row per observation; grows with observations, not releases.
      WHEN p_schema = 'taxonomy_v3' AND p_table IN ('identification_snapshot', 'resolution_link')
        THEN ARRAY['user_data', 'observations']

      -- 2. Taxonomy, matched by pattern.
      WHEN p_schema ~ '^taxonomy_v[0-9]+$'
        THEN ARRAY['taxonomy_reference', p_schema]
      WHEN p_schema = 'public' AND p_table ~ '^taxonomy_' AND p_has_release_id
           AND p_table !~ '_(releases|import_runs)$'
        THEN ARRAY['taxonomy_reference', 'taxonomy_release_payload']
      WHEN p_schema = 'public' AND p_table ~ '^taxonomy_'
        THEN ARRAY['taxonomy_reference', 'taxonomy_registry']
      WHEN p_schema = 'public' AND (p_table ~ '^taxa(_|$)' OR p_table ~ '^taxon_')
        THEN ARRAY['taxonomy_reference', 'legacy_taxonomy']
      WHEN p_schema = 'private' AND p_table ~ '^(taxon_identity_repair|retired_resolution_repair)_'
        THEN ARRAY['taxonomy_reference', 'taxonomy_maintenance']

      -- 3. Other reference datasets, platform and operations.
      WHEN p_schema = 'public' AND p_table IN ('spatial_ref_sys', 'public_regions')
        THEN ARRAY['taxonomy_reference', 'other_reference']
      WHEN p_schema IN ('pg_catalog', 'information_schema')
        THEN ARRAY['system_other', 'postgres_catalog']
      WHEN p_schema ~ '^pg_(toast_)?temp_'
        THEN ARRAY['system_other', 'temporary']
      WHEN p_schema IN (
        'auth', 'storage', 'realtime', '_realtime', 'vault', 'cron', 'net',
        'supabase_migrations', 'supabase_functions', 'extensions', 'graphql',
        'graphql_public', 'pgsodium', 'pgsodium_masks', 'pgbouncer', '_analytics',
        'pgmq', 'supabase_admin'
      )
        THEN ARRAY['system_other', 'supabase_platform']
      WHEN p_schema = 'public' AND p_table IN (
        'admin_action_log', 'client_activity_daily',
        'media_object_deletion_accounting', '_media_worker_config'
      )
        THEN ARRAY['system_other', 'app_operations']
      WHEN p_schema = 'private' AND p_table = 'sync_client_write_block'
        THEN ARRAY['system_other', 'app_operations']

      -- 4. User data, by explicit allowlist.
      WHEN p_schema = 'public' AND p_table IN (
        'observations', 'observation_images', 'observation_identifications',
        'observation_shares', 'observation_spore_summaries',
        'observation_reference_uses', 'spore_measurements', 'spore_annotations',
        'spore_measurement_mosaics', 'spore_measurement_mosaic_tiles'
      )
        THEN ARRAY['user_data', 'observations']
      WHEN p_schema = 'public' AND p_table IN (
        'profiles', 'calibrations', 'comments', 'comment_moderation', 'follows',
        'friendships', 'user_blocks', 'reports'
      )
        THEN ARRAY['user_data', 'accounts_social']
      WHEN (p_schema = 'public' AND p_table IN (
             'reference_values', 'reference_works', 'reference_measurement_sets',
             'reference_taxon_treatments', 'reference_curated_forks',
             'reference_client_devices'
           ))
        OR (p_schema = 'private' AND p_table ~ '^(curated_reference|reference|shared_reference)_')
        THEN ARRAY['user_data', 'reference_library']

      -- 5. Never silently folded into user data.
      ELSE ARRAY['unclassified', 'unclassified']
    END AS x
  ) c;
$$;

ALTER FUNCTION private.admin_database_health_classify(text, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_database_health_classify(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
