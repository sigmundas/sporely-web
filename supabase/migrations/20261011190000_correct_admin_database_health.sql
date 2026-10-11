-- Correct public.admin_database_health() reporting.
--
-- The 20260623153000 version classified only taxa, taxa_vernacular and
-- spatial_ref_sys as reference data, so taxonomy v2/v3 storage was counted as
-- user content and inflated bytes_per_observation. It also measured only the
-- application database, not the cluster total the Free quota is planned
-- against.
--
-- The RPC is now split into three private functions:
--
--   admin_database_health_classify(schema, table, has_release_id)
--     Pure classification. Rule order is deliberate:
--       1. per-observation taxonomy_v3 tables (they scale with observations),
--       2. taxonomy by naming pattern, so a new taxonomy table can never be
--          counted as user data,
--       3. other reference datasets, platform schemas and app operations,
--       4. user data by explicit allowlist,
--       5. everything else is 'unclassified' and raises a dashboard warning.
--     A new table therefore needs an explicit decision here; the
--     admin_database_health_test.sql suite fails while any local table is
--     unclassified.
--
--   admin_database_health_measure()
--     Read-only measurement: relation sizes for every schema, database and
--     cluster sizes, counts, and taxonomy v2 payload rows per release.
--
--   admin_database_health_assess(measurements jsonb)
--     Pure derivation of categories, quota headroom, per-release estimates,
--     next-publication capacity, observation capacity and warnings. Tested
--     with synthetic measurements.
--
-- Quota: Supabase's unit for the Free 500 MB database limit is unresolved
-- (its dashboard shows MiB labelled MB). Following the taxonomy-retention
-- runbook, plan against a conservative 500,000,000 bytes applied to the sum
-- of all cluster databases.
--
-- Legacy payload keys are kept so the deployed admin UI keeps working;
-- total_database_bytes now carries the quota-relevant cluster total.

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

CREATE OR REPLACE FUNCTION private.admin_database_health_measure()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_relations jsonb;
  v_databases jsonb;
  v_cluster_bytes bigint;
  v_payload jsonb := '[]'::jsonb;
  v_rows jsonb;
  v_table record;
  v_storage jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'schema', r.schema_name,
           'table', r.table_name,
           'bytes', r.bytes,
           'has_release_id', r.has_release_id
         )), '[]'::jsonb)
  INTO v_relations
  FROM (
    SELECT
      n.nspname::text AS schema_name,
      c.relname::text AS table_name,
      coalesce(pg_total_relation_size(c.oid), 0)::bigint AS bytes,
      EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'release_id'
          AND a.attnum > 0 AND NOT a.attisdropped
      ) AS has_release_id
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm', 'p')
      AND NOT c.relisshared  -- shared catalogs are outside pg_database_size()
  ) r;

  -- Other databases (template0/1) count towards the conservative quota.
  -- If any size is unreadable, report the cluster total as unmeasured.
  BEGIN
    SELECT
      jsonb_agg(jsonb_build_object('name', d.datname, 'bytes', pg_database_size(d.datname)) ORDER BY d.datname),
      sum(pg_database_size(d.datname))::bigint
    INTO v_databases, v_cluster_bytes
    FROM pg_database d;
  EXCEPTION WHEN insufficient_privilege THEN
    v_databases := NULL;
    v_cluster_bytes := NULL;
  END;

  FOR v_table IN
    SELECT c.relname::text AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL private.admin_database_health_classify(n.nspname, c.relname, true) k
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND k.component = 'taxonomy_release_payload'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'release_id'
          AND a.attnum > 0 AND NOT a.attisdropped
      )
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'SELECT coalesce(jsonb_object_agg(release_id, n), ''{}''::jsonb)
         FROM (SELECT release_id::text AS release_id, count(*) AS n
                 FROM public.%I GROUP BY release_id) s',
      v_table.table_name
    ) INTO v_rows;
    v_payload := v_payload || jsonb_build_array(
      jsonb_build_object('table', v_table.table_name, 'rows_by_release', v_rows)
    );
  END LOOP;

  -- Supabase Storage objects are files under a separate quota; only their
  -- metadata rows live in the database.
  BEGIN
    SELECT jsonb_build_object(
             'count', count(*),
             'bytes', coalesce(sum(nullif(o.metadata->>'size', '')::bigint), 0)
           )
    INTO v_storage
    FROM storage.objects o;
  EXCEPTION WHEN insufficient_privilege OR undefined_table OR invalid_text_representation THEN
    v_storage := NULL;
  END;

  RETURN jsonb_build_object(
    'measured_at', now(),
    'database_bytes', pg_database_size(current_database()),
    'cluster_bytes', v_cluster_bytes,
    'databases', v_databases,
    'relations', v_relations,
    'observation_count', (SELECT count(*) FROM public.observations),
    'image_count', (SELECT count(*) FROM public.observation_images),
    'taxonomy_releases', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('release_id', r.release_id, 'status', r.status)
                                ORDER BY r.release_id), '[]'::jsonb)
      FROM public.taxonomy_v2_releases r
    ),
    'taxonomy_import_runs_running', (
      SELECT count(*) FROM public.taxonomy_v2_import_runs WHERE status = 'running'
    ),
    'taxonomy_payload', v_payload,
    'storage_objects', v_storage
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_database_health_assess(p_m jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  -- Conservative decimal interpretation of the Free 500 MB database quota.
  c_quota constant bigint := coalesce((p_m->>'quota_bytes')::bigint, 500000000);
  -- A freshly imported release is less compact than a VACUUM FULL'd one;
  -- matches the replacement allowance in the taxonomy-retention runbook.
  c_publication_margin constant numeric := 0.25;
  c_watch constant bigint := c_quota / 2;           -- 50 %
  c_warning constant bigint := (c_quota * 7) / 10;  -- 70 %
  c_critical constant bigint := (c_quota * 9) / 10; -- 90 %

  v_db bigint := coalesce((p_m->>'database_bytes')::bigint, 0);
  v_cluster_measured boolean := (p_m->>'cluster_bytes') IS NOT NULL;
  v_cluster bigint := coalesce((p_m->>'cluster_bytes')::bigint, (p_m->>'database_bytes')::bigint, 0);
  v_obs_count bigint := (p_m->>'observation_count')::bigint;
  v_image_count bigint := (p_m->>'image_count')::bigint;

  v_rel jsonb;
  v_rel_total bigint;
  v_unattributed bigint;
  v_other_db bigint;
  v_categories jsonb;

  v_releases jsonb;
  v_payload_releases integer;
  v_payload_bytes bigint;
  v_active_count integer;
  v_active_id text;
  v_active_bytes bigint;
  v_retained_bytes bigint;
  v_retained_ids jsonb;
  v_in_progress boolean;
  v_required bigint;
  v_next jsonb;

  v_obs_bytes bigint;
  v_avg bigint;
  v_headroom bigint;

  v_capacity_key text;
  v_status_key text;
  v_status_detail text;
  v_warnings jsonb := '[]'::jsonb;
  v_unclassified jsonb;
  v_unclassified_bytes bigint;
BEGIN
  -- Classified relations, largest first.
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'schema', r->>'schema',
             'table', r->>'table',
             'bytes', (r->>'bytes')::bigint,
             'pretty_size', private.admin_database_health_mib((r->>'bytes')::bigint),
             'category', k.category,
             'component', k.component
           )
           ORDER BY (r->>'bytes')::bigint DESC, r->>'schema', r->>'table'
         ), '[]'::jsonb),
         coalesce(sum((r->>'bytes')::bigint), 0)
  INTO v_rel, v_rel_total
  FROM jsonb_array_elements(coalesce(p_m->'relations', '[]'::jsonb)) r
  CROSS JOIN LATERAL private.admin_database_health_classify(
    r->>'schema', r->>'table', coalesce((r->>'has_release_id')::boolean, false)
  ) k;

  -- Database files not attributable to a relation, and the other cluster
  -- databases, are system overhead so the categories sum to the cluster total.
  v_unattributed := greatest(v_db - v_rel_total, 0);
  v_other_db := CASE WHEN v_cluster_measured THEN greatest(v_cluster - v_db, 0) ELSE 0 END;

  WITH parts AS (
    SELECT x->>'category' AS category, x->>'component' AS component,
           (x->>'bytes')::bigint AS bytes, x AS rel
    FROM jsonb_array_elements(v_rel) x
    UNION ALL SELECT 'system_other', 'unattributed', v_unattributed, NULL WHERE v_unattributed > 0
    UNION ALL SELECT 'system_other', 'other_databases', v_other_db, NULL WHERE v_other_db > 0
  ),
  components AS (
    SELECT category, component, sum(bytes)::bigint AS bytes, count(rel)::integer AS table_count
    FROM parts GROUP BY category, component
  ),
  cats AS (
    SELECT k AS category FROM unnest(ARRAY['user_data', 'taxonomy_reference', 'system_other', 'unclassified']) k
  )
  SELECT jsonb_object_agg(cats.category, jsonb_build_object(
           'bytes', coalesce((SELECT sum(bytes) FROM components c WHERE c.category = cats.category), 0)::bigint,
           'components', coalesce((
             SELECT jsonb_agg(jsonb_build_object('component', c.component, 'bytes', c.bytes, 'table_count', c.table_count)
                              ORDER BY c.bytes DESC, c.component)
             FROM components c WHERE c.category = cats.category), '[]'::jsonb),
           'tables', coalesce((
             SELECT jsonb_agg(p.rel ORDER BY p.bytes DESC, p.rel->>'schema', p.rel->>'table')
             FROM parts p WHERE p.category = cats.category AND p.rel IS NOT NULL), '[]'::jsonb)
         ))
  INTO v_categories
  FROM cats;

  -- Per-release taxonomy payload. Bytes are attributed to releases by row
  -- share within each payload table. With one resident release that is the
  -- measured size; with several it is a proportional estimate.
  WITH payload AS (
    SELECT p->>'table' AS table_name,
           coalesce((SELECT (x->>'bytes')::bigint FROM jsonb_array_elements(v_rel) x
                     WHERE x->>'schema' = 'public' AND x->>'table' = p->>'table'), 0) AS bytes,
           coalesce(p->'rows_by_release', '{}'::jsonb) AS rows_by_release
    FROM jsonb_array_elements(coalesce(p_m->'taxonomy_payload', '[]'::jsonb)) p
  ),
  totals AS (
    SELECT table_name, bytes, rows_by_release,
           (SELECT coalesce(sum(value::bigint), 0) FROM jsonb_each_text(rows_by_release)) AS total_rows
    FROM payload
  ),
  shares AS (
    SELECT e.key AS release_id, e.value::bigint AS rows,
           CASE WHEN t.total_rows > 0 THEN t.bytes::numeric * e.value::bigint / t.total_rows ELSE 0 END AS bytes
    FROM totals t CROSS JOIN LATERAL jsonb_each_text(t.rows_by_release) e
  ),
  per_release AS (
    SELECT release_id, sum(rows)::bigint AS rows, round(sum(bytes))::bigint AS bytes
    FROM shares GROUP BY release_id
  ),
  headers AS (
    SELECT h->>'release_id' AS release_id, h->>'status' AS status
    FROM jsonb_array_elements(coalesce(p_m->'taxonomy_releases', '[]'::jsonb)) h
  ),
  combined AS (
    SELECT coalesce(h.release_id, pr.release_id) AS release_id,
           coalesce(h.status, 'unknown') AS status,
           coalesce(pr.rows, 0) AS rows,
           coalesce(pr.bytes, 0) AS bytes
    FROM headers h FULL JOIN per_release pr ON pr.release_id = h.release_id
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'release_id', release_id, 'status', status,
      'payload_rows', rows, 'estimated_resident_bytes', bytes
    ) ORDER BY release_id), '[]'::jsonb),
    count(*) FILTER (WHERE rows > 0),
    count(*) FILTER (WHERE status = 'active'),
    max(release_id) FILTER (WHERE status = 'active'),
    max(bytes) FILTER (WHERE status = 'active'),
    coalesce(sum(bytes) FILTER (WHERE status IN ('retired', 'failed', 'unknown') AND rows > 0), 0),
    coalesce(jsonb_agg(release_id ORDER BY release_id) FILTER (WHERE status IN ('retired', 'failed', 'unknown') AND rows > 0), '[]'::jsonb),
    bool_or(status IN ('loading', 'ready'))
  INTO v_releases, v_payload_releases, v_active_count, v_active_id, v_active_bytes,
       v_retained_bytes, v_retained_ids, v_in_progress
  FROM combined;

  SELECT coalesce(sum((x->>'bytes')::bigint), 0) INTO v_payload_bytes
  FROM jsonb_array_elements(v_rel) x WHERE x->>'component' = 'taxonomy_release_payload';

  v_in_progress := coalesce(v_in_progress, false)
    OR coalesce((p_m->>'taxonomy_import_runs_running')::bigint, 0) > 0;
  v_headroom := greatest(c_quota - v_cluster, 0);

  IF coalesce(v_active_bytes, 0) > 0 THEN
    v_required := ceil(v_active_bytes * (1 + c_publication_margin))::bigint;
    v_next := jsonb_build_object(
      'available', true,
      'basis_release_id', v_active_id,
      'estimated_release_bytes', v_active_bytes,
      'margin_ratio', c_publication_margin,
      'required_bytes', v_required,
      'cluster_after_bytes', v_cluster + v_required,
      'headroom_after_bytes', c_quota - v_cluster - v_required,
      'fits', v_cluster + v_required <= c_quota,
      'fits_below_critical', v_cluster + v_required < c_critical,
      'additional_releases_that_fit', floor(v_headroom::numeric / v_required)::bigint
    );
  ELSE
    v_required := NULL;
    v_next := jsonb_build_object('available', false, 'reason', 'No active taxonomy release payload is resident.');
  END IF;

  -- Observation data average. Includes fixed table and index overhead, so it
  -- is an upper bound on marginal growth, not a measured growth rate.
  SELECT coalesce(sum((c->>'bytes')::bigint), 0) INTO v_obs_bytes
  FROM jsonb_array_elements(v_categories->'user_data'->'components') c
  WHERE c->>'component' = 'observations';
  v_avg := CASE WHEN v_obs_count > 0 AND v_obs_bytes > 0 THEN round(v_obs_bytes::numeric / v_obs_count)::bigint END;

  v_capacity_key := CASE
    WHEN v_cluster >= c_critical THEN 'critical'
    WHEN v_cluster >= c_warning THEN 'warning'
    WHEN v_cluster >= c_watch THEN 'watch'
    ELSE 'ok'
  END;

  -- Warnings, most specific first.
  IF v_cluster >= c_quota THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'database_quota_reached', 'severity', 'critical',
      'message', 'Database size has reached the Free 500 MB quota; the project may become read-only.'));
  ELSIF v_capacity_key <> 'ok' THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'database_capacity', 'severity', v_capacity_key,
      'message', format('Database size is %s%% of the Free 500 MB quota.', round(v_cluster * 100.0 / c_quota, 1))));
  END IF;

  IF v_required IS NOT NULL AND v_cluster + v_required > c_quota THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'taxonomy_publication_will_not_fit', 'severity', 'critical',
      'message', format('A new full taxonomy release needs about %s but only %s remains under the quota.',
                        private.admin_database_health_mib(v_required), private.admin_database_health_mib(v_headroom))));
  ELSIF v_required IS NOT NULL AND v_cluster + v_required >= c_critical THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'taxonomy_publication_tight', 'severity', 'warning',
      'message', format('A new full taxonomy release (about %s) would take the database above 90%% of the quota.',
                        private.admin_database_health_mib(v_required))));
  ELSIF v_required IS NULL THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'taxonomy_publication_estimate_unavailable', 'severity', 'info',
      'message', 'No active taxonomy release payload is resident, so publication capacity cannot be estimated.'));
  END IF;

  IF v_active_count > 1 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'multiple_active_taxonomy_releases', 'severity', 'warning',
      'message', format('%s taxonomy releases are marked active; the publication estimate uses the largest.', v_active_count)));
  END IF;

  IF v_retained_bytes > 0 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'retired_taxonomy_payload_resident', 'severity', 'watch',
      'message', format('Payload rows for %s non-active taxonomy release(s) are still stored (estimated %s). Reclaiming it needs the retention cleanup and table rebuild.',
                        jsonb_array_length(v_retained_ids), private.admin_database_health_mib(v_retained_bytes))));
  END IF;

  IF v_in_progress THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'taxonomy_publication_in_progress', 'severity', 'info',
      'message', 'A taxonomy release is loading or awaiting activation; temporary growth is expected.'));
  END IF;

  SELECT coalesce(jsonb_agg(x->>'schema' || '.' || (x->>'table') ORDER BY (x->>'bytes')::bigint DESC), '[]'::jsonb),
         coalesce(sum((x->>'bytes')::bigint), 0)
  INTO v_unclassified, v_unclassified_bytes
  FROM jsonb_array_elements(v_rel) x WHERE x->>'category' = 'unclassified';

  IF jsonb_array_length(v_unclassified) > 0 THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'unclassified_relations',
      'severity', CASE WHEN v_unclassified_bytes >= 1048576 THEN 'watch' ELSE 'info' END,
      'message', format('%s table(s) (%s) are not classified; add them to private.admin_database_health_classify().',
                        jsonb_array_length(v_unclassified), private.admin_database_health_mib(v_unclassified_bytes)),
      'tables', v_unclassified));
  END IF;

  IF NOT v_cluster_measured THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('key', 'cluster_size_unmeasured', 'severity', 'watch',
      'message', 'Other cluster databases could not be measured; capacity uses the main database only.'));
  END IF;

  -- Overall status is the most severe of capacity and warnings ('info' never escalates).
  SELECT s.key INTO v_status_key
  FROM (
    SELECT v_capacity_key AS key
    UNION ALL
    SELECT w->>'severity' FROM jsonb_array_elements(v_warnings) w WHERE w->>'severity' <> 'info'
  ) s
  ORDER BY array_position(ARRAY['ok', 'watch', 'warning', 'critical'], s.key) DESC
  LIMIT 1;

  v_status_detail := CASE
    WHEN v_cluster >= c_quota THEN 'Free read-only danger state'
    WHEN v_status_key = v_capacity_key THEN CASE v_capacity_key
      WHEN 'critical' THEN 'Critical before Free read-only limit'
      WHEN 'warning' THEN 'Warning before Free read-only limit'
      WHEN 'watch' THEN 'Upgrade watch threshold'
      ELSE 'Healthy Free-tier headroom'
    END
    ELSE (
      SELECT w->>'message' FROM jsonb_array_elements(v_warnings) w
      WHERE w->>'severity' = v_status_key LIMIT 1
    )
  END;

  RETURN jsonb_build_object(
    'schema_version', 2,
    'refreshed_at', p_m->'measured_at',

    -- Legacy keys (20260623153000 payload shape).
    'total_database_bytes', v_cluster,
    'total_database_pretty', private.admin_database_health_mib(v_cluster),
    'free_limit_bytes', c_quota,
    'free_limit_pretty', '500 MB',
    'percent_used', round(v_cluster * 100.0 / c_quota, 1),
    'status_key', v_status_key,
    'status_label', CASE v_status_key WHEN 'ok' THEN 'OK' ELSE initcap(v_status_key) END,
    'status_detail', v_status_detail,
    'free_limit_reached', v_cluster >= c_quota,
    'headroom_bytes', v_headroom,
    'headroom_pretty', private.admin_database_health_mib(v_headroom),
    'reference_data', jsonb_build_object(
      'bytes', v_categories->'taxonomy_reference'->'bytes',
      'pretty_size', private.admin_database_health_mib((v_categories->'taxonomy_reference'->>'bytes')::bigint),
      'tables', v_categories->'taxonomy_reference'->'tables'
    ),
    'user_content_data', jsonb_build_object(
      'bytes', v_categories->'user_data'->'bytes',
      'pretty_size', private.admin_database_health_mib((v_categories->'user_data'->>'bytes')::bigint),
      'tables', v_categories->'user_data'->'tables'
    ),
    'top_relations', coalesce((SELECT jsonb_agg(x) FROM (SELECT x FROM jsonb_array_elements(v_rel) x LIMIT 20) t), '[]'::jsonb),
    'observation_count', v_obs_count,
    'image_count', v_image_count,
    'bytes_per_observation', v_avg,
    'estimated_remaining_observations', jsonb_build_object(
      'to_250_mb', CASE WHEN v_avg > 0 THEN floor(greatest(250000000 - v_cluster, 0)::numeric / v_avg)::bigint END,
      'to_350_mb', CASE WHEN v_avg > 0 THEN floor(greatest(350000000 - v_cluster, 0)::numeric / v_avg)::bigint END,
      'to_500_mb', CASE WHEN v_avg > 0 THEN floor(greatest(c_quota - v_cluster, 0)::numeric / v_avg)::bigint END
    ),

    -- Corrected model.
    'quota', jsonb_build_object(
      'bytes', c_quota,
      'applies_to', 'cluster_database_bytes',
      'basis', 'Conservative decimal reading of the Free 500 MB database limit (500 MiB would be 524288000 bytes), applied to all cluster databases.',
      'thresholds', jsonb_build_object('watch', c_watch, 'warning', c_warning, 'critical', c_critical, 'limit', c_quota)
    ),
    'database', jsonb_build_object(
      'main_bytes', v_db,
      'cluster_bytes', v_cluster,
      'cluster_measured', v_cluster_measured,
      'other_databases_bytes', v_other_db,
      'databases', coalesce(p_m->'databases', '[]'::jsonb)
    ),
    'capacity', jsonb_build_object(
      'status_key', v_capacity_key,
      'headroom_bytes', v_headroom,
      'percent_used', round(v_cluster * 100.0 / c_quota, 1)
    ),
    'categories', v_categories,
    'taxonomy', jsonb_build_object(
      'bytes', v_categories->'taxonomy_reference'->'bytes',
      'release_payload_bytes', v_payload_bytes,
      'active_release_id', v_active_id,
      'active_release_estimated_bytes', v_active_bytes,
      'resident_release_count', v_payload_releases,
      'estimate_basis', CASE WHEN v_payload_releases > 1 THEN 'proportional_row_share' ELSE 'measured_single_release' END,
      'retained_non_active_estimated_bytes', v_retained_bytes,
      'retained_non_active_release_ids', v_retained_ids,
      'publication_in_progress', v_in_progress,
      'releases', v_releases,
      'next_publication', v_next
    ),
    'observations', jsonb_build_object(
      'count', v_obs_count,
      'image_count', v_image_count,
      'observation_data_bytes', v_obs_bytes,
      'average_bytes_per_observation', v_avg,
      'average_basis', 'Average over observation-linked tables, including fixed table and index overhead. An upper bound on marginal growth, not a measured rate.',
      'capacity', jsonb_build_object(
        'until_quota', CASE WHEN v_avg > 0 THEN floor(v_headroom::numeric / v_avg)::bigint END,
        'after_next_publication', CASE WHEN v_avg > 0 AND v_required IS NOT NULL
          THEN floor(greatest(c_quota - v_cluster - v_required, 0)::numeric / v_avg)::bigint END
      )
    ),
    'measured_growth', jsonb_build_object(
      'available', false,
      'reason', 'No database-size history is recorded; growth over time cannot be measured yet.'
    ),
    'not_included', jsonb_build_object(
      'note', 'Database size excludes WAL, provisioned disk and Supabase Storage files; see the Supabase usage dashboard for those.',
      'storage_objects', p_m->'storage_objects'
    ),
    'warnings', v_warnings
  );
END;
$$;

-- Sizes in MiB with an explicit unit (pg_size_pretty labels MiB as "MB").
CREATE OR REPLACE FUNCTION private.admin_database_health_mib(p_bytes bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT CASE WHEN p_bytes IS NULL THEN NULL
              ELSE to_char(round(p_bytes / 1048576.0, 2), 'FM999999990.00') || ' MiB' END;
$$;

CREATE OR REPLACE FUNCTION public.admin_database_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
  SELECT private.admin_database_health_assess(private.admin_database_health_measure());
$$;

ALTER FUNCTION private.admin_database_health_classify(text, text, boolean) OWNER TO postgres;
ALTER FUNCTION private.admin_database_health_measure() OWNER TO postgres;
ALTER FUNCTION private.admin_database_health_assess(jsonb) OWNER TO postgres;
ALTER FUNCTION private.admin_database_health_mib(bigint) OWNER TO postgres;
ALTER FUNCTION public.admin_database_health() OWNER TO postgres;

REVOKE ALL ON FUNCTION private.admin_database_health_classify(text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.admin_database_health_measure() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.admin_database_health_assess(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.admin_database_health_mib(bigint) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_database_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_database_health() FROM anon;
REVOKE ALL ON FUNCTION public.admin_database_health() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_database_health() TO service_role;

NOTIFY pgrst, 'reload schema';
