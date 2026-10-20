-- Validates public.admin_database_health() and its private helpers
-- (20261011190000_correct_admin_database_health.sql).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/admin_database_health_test.sql
--
-- The assess cases use synthetic measurements, so they do not depend on local
-- table sizes. The schema cases fail while any local table is unclassified:
-- classify a new table in private.admin_database_health_classify().

-- ---------------------------------------------------------------------------
-- 1. Classification rules, including tables that do not exist yet.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  k record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public', 'observations', false, 'user_data', 'observations'),
      ('public', 'observation_images', false, 'user_data', 'observations'),
      ('public', 'spore_measurement_mosaic_tiles', false, 'user_data', 'observations'),
      ('taxonomy_v3', 'identification_snapshot', false, 'user_data', 'observations'),
      ('taxonomy_v3', 'resolution_link', false, 'user_data', 'observations'),
      ('public', 'profiles', false, 'user_data', 'accounts_social'),
      ('public', 'reference_works', false, 'user_data', 'reference_library'),
      ('private', 'shared_reference_contributions', false, 'user_data', 'reference_library'),
      ('public', 'taxonomy_v2_taxa', true, 'taxonomy_reference', 'taxonomy_release_payload'),
      ('public', 'taxonomy_v2_external_ids', true, 'taxonomy_reference', 'taxonomy_release_payload'),
      ('public', 'taxonomy_v2_releases', true, 'taxonomy_reference', 'taxonomy_registry'),
      ('public', 'taxonomy_v2_import_runs', true, 'taxonomy_reference', 'taxonomy_registry'),
      ('public', 'taxonomy_v2_concepts', false, 'taxonomy_reference', 'taxonomy_registry'),
      ('public', 'taxa', false, 'taxonomy_reference', 'legacy_taxonomy'),
      ('public', 'taxa_vernacular', false, 'taxonomy_reference', 'legacy_taxonomy'),
      ('taxonomy_v3', 'registry_concept', false, 'taxonomy_reference', 'taxonomy_v3'),
      ('private', 'taxon_identity_repair_runs', false, 'taxonomy_reference', 'taxonomy_maintenance'),
      ('public', 'spatial_ref_sys', false, 'taxonomy_reference', 'other_reference'),
      ('auth', 'users', false, 'system_other', 'supabase_platform'),
      ('storage', 'objects', false, 'system_other', 'supabase_platform'),
      ('pg_catalog', 'pg_class', false, 'system_other', 'postgres_catalog'),
      ('public', 'client_activity_daily', false, 'system_other', 'app_operations'),
      ('private', 'sync_client_write_block', false, 'system_other', 'app_operations'),
      -- Future tables: taxonomy by pattern, never user data.
      ('public', 'taxonomy_v4_taxa', true, 'taxonomy_reference', 'taxonomy_release_payload'),
      ('public', 'taxonomy_v2_new_lookup', false, 'taxonomy_reference', 'taxonomy_registry'),
      ('public', 'taxonomy_observation_links', false, 'taxonomy_reference', 'taxonomy_registry'),
      ('taxonomy_v4', 'anything', false, 'taxonomy_reference', 'taxonomy_v4'),
      ('public', 'taxon_synonyms', false, 'taxonomy_reference', 'legacy_taxonomy'),
      ('public', 'brand_new_table', false, 'unclassified', 'unclassified'),
      ('public', 'observation_new_feature', false, 'unclassified', 'unclassified')
    ) AS t(schema_name, table_name, has_release_id, category, component)
  LOOP
    SELECT * INTO k FROM private.admin_database_health_classify(r.schema_name, r.table_name, r.has_release_id);
    IF k.category IS DISTINCT FROM r.category OR k.component IS DISTINCT FROM r.component THEN
      RAISE EXCEPTION 'classify(%.%, %) = %/%, expected %/%',
        r.schema_name, r.table_name, r.has_release_id, k.category, k.component, r.category, r.component;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS classification rules';
END $$;

-- ---------------------------------------------------------------------------
-- 1b. Statistics freshness gate. Never-analysed and modified tables cannot be
--     produced end to end here (stats reset needs superuser; change counters
--     only include committed transactions), so the decision is tested directly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (52917::bigint, true, 0::bigint, true),     -- analysed, unchanged
      (52917, false, 0, false),                   -- never analysed / stats reset
      (52917, NULL, 0, false),                    -- no stats entry
      (52917, true, 1, false),                    -- committed change since analyze
      (52917, true, NULL, false),                 -- no change counter
      (0, true, 0, false),                        -- no row estimate
      (NULL, true, 0, false)
    ) AS t(estimated_rows, analyzed, modified, expected)
  LOOP
    IF private.admin_database_health_statistics_usable(r.estimated_rows, r.analyzed, r.modified) IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION 'statistics_usable(%, %, %) expected %', r.estimated_rows, r.analyzed, r.modified, r.expected;
    END IF;
  END LOOP;
  ASSERT NOT has_function_privilege('authenticated', 'private.admin_database_health_statistics_usable(bigint, boolean, bigint)', 'EXECUTE'),
    'gate helper denied';
  RAISE NOTICE 'PASS statistics freshness gate';
END $$;

-- ---------------------------------------------------------------------------
-- 2. Current local schema: nothing unclassified, payload tables detected.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  m jsonb := private.admin_database_health_measure();
  h jsonb := private.admin_database_health_assess(m);
  v_expected text[];
  v_measured text[];
BEGIN
  IF jsonb_array_length(h->'categories'->'unclassified'->'tables') > 0 THEN
    RAISE EXCEPTION 'unclassified local tables: %', h->'categories'->'unclassified'->'tables';
  END IF;

  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO v_expected
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'taxonomy\_v2\_%'
    AND c.relname NOT IN ('taxonomy_v2_releases', 'taxonomy_v2_import_runs')
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'release_id' AND NOT a.attisdropped);
  SELECT array_agg(p->>'table' ORDER BY p->>'table') INTO v_measured
  FROM jsonb_array_elements(m->'taxonomy_payload') p;
  IF v_measured IS DISTINCT FROM v_expected OR cardinality(v_expected) < 6 THEN
    RAISE EXCEPTION 'payload tables measured % expected %', v_measured, v_expected;
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(h->'categories'->'user_data'->'tables') t
    WHERE t->>'table' ~ '^(taxonomy_|taxa)' OR t->>'schema' = 'taxonomy_v3' AND t->>'table' NOT IN ('identification_snapshot', 'resolution_link')
  ) THEN
    RAISE EXCEPTION 'taxonomy table counted as user data: %', h->'categories'->'user_data'->'tables';
  END IF;

  IF (m->>'cluster_bytes')::bigint < (m->>'database_bytes')::bigint THEN
    RAISE EXCEPTION 'cluster % smaller than database %', m->>'cluster_bytes', m->>'database_bytes';
  END IF;
  RAISE NOTICE 'PASS local schema classification (% payload tables)', cardinality(v_expected);
END $$;

-- ---------------------------------------------------------------------------
-- 2b. Payload measurement on seeded releases: exact-count fallback without
--     statistics, statistics with two resident releases, then one resident
--     release. The block is atomic and removes its seed rows on success.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r_old constant text := 'tax-1999.01.01-01';
  r_new constant text := 'tax-1999.02.01-01';
  m jsonb;
  h jsonb;
  t jsonb;
  v_taxa_bytes bigint;
  v_reltuples real;
  v_analyzed boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.taxonomy_v2_releases) THEN
    RAISE NOTICE 'SKIP seeded payload measurement: local database holds taxonomy releases';
    RETURN;
  END IF;

  INSERT INTO public.taxonomy_v2_releases (
    release_id, taxonomy_schema_version, export_schema_version, manifest_schema_version,
    exporter_version, scope_predicate_id, source_gz_sha256, source_sqlite_sha256,
    whole_export_sha256, manifest_sha256, generated_at, status, row_counts,
    authoritative_namespace_counts, legacy_source_counts, dangling_parent_count,
    dangling_parent_report, source_manifest
  )
  SELECT rid, 2, 1, 1, 'dbh-test', 'dbh-test', repeat('a', 64), repeat('b', 64),
         repeat(c, 64), repeat('d', 64), now(), st, '{}', '{}', '{}', 0, '{}', '{}'
  FROM (VALUES (r_old, 'retired', 'e'), (r_new, 'active', 'f')) v(rid, st, c);

  INSERT INTO public.taxonomy_v2_concepts (sporely_taxon_id, first_seen_release_id)
  SELECT 990000000 + g, r_old FROM generate_series(1, 300) g;
  INSERT INTO public.taxonomy_v2_taxa (release_id, sporely_taxon_id, canonical_source_system, canonical_external_id)
  SELECT r_old, 990000000 + g, 'dbh', g::text FROM generate_series(1, 300) g
  UNION ALL
  SELECT r_new, 990000000 + g, 'dbh', g::text FROM generate_series(1, 100) g;

  -- Without usable statistics (no row estimate, or never analysed) the
  -- rows are counted.
  SELECT reltuples INTO v_reltuples FROM pg_class WHERE oid = 'public.taxonomy_v2_taxa'::regclass;
  SELECT coalesce(last_analyze, last_autoanalyze) IS NOT NULL INTO v_analyzed
  FROM pg_stat_all_tables WHERE relid = 'public.taxonomy_v2_taxa'::regclass;
  m := private.admin_database_health_measure();
  SELECT p INTO t FROM jsonb_array_elements(m->'taxonomy_payload') p WHERE p->>'table' = 'taxonomy_v2_taxa';
  IF v_reltuples <= 0 OR NOT v_analyzed THEN
    ASSERT t->>'rows_basis' = 'counted', 'fallback basis ' || t::text;
  END IF;
  ASSERT (t->'rows_by_release'->>r_old)::bigint = 300 AND (t->'rows_by_release'->>r_new)::bigint = 100,
    'counted rows ' || t::text;

  -- Statistics path: shares from release_id frequencies.
  ANALYZE public.taxonomy_v2_taxa;
  PERFORM pg_stat_clear_snapshot();  -- stats views are cached per transaction
  m := private.admin_database_health_measure();
  SELECT p INTO t FROM jsonb_array_elements(m->'taxonomy_payload') p WHERE p->>'table' = 'taxonomy_v2_taxa';
  ASSERT t->>'rows_basis' = 'statistics', 'statistics basis ' || t::text;
  ASSERT (t->'rows_by_release'->>r_old)::bigint = 300 AND (t->'rows_by_release'->>r_new)::bigint = 100,
    'statistics rows ' || t::text;
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m->'taxonomy_payload') p
                     WHERE p->>'table' <> 'taxonomy_v2_taxa' AND p->'rows_by_release' <> '{}'::jsonb),
    'only taxa resident';

  h := private.admin_database_health_assess(m);
  v_taxa_bytes := pg_total_relation_size('public.taxonomy_v2_taxa');
  ASSERT (h->'taxonomy'->>'resident_release_count')::int = 2, 'two resident';
  ASSERT h->'taxonomy'->>'estimate_basis' = 'proportional_row_share', 'proportional';
  ASSERT h->'taxonomy'->>'payload_rows_basis' = 'estimated_from_statistics', 'rows basis ' || (h->'taxonomy'->>'payload_rows_basis');
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = round(v_taxa_bytes / 4.0)::bigint, 'active share';
  ASSERT (h->'taxonomy'->>'retained_non_active_estimated_bytes')::bigint = round(v_taxa_bytes * 3 / 4.0)::bigint, 'retained share';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(h->'warnings') w WHERE w->>'key' = 'retired_taxonomy_payload_resident'),
    'retained warning';

  -- The freshness gate's rejecting cases are covered by section 1b.

  -- Retired payload removed: one resident release, attributed in full.
  DELETE FROM public.taxonomy_v2_taxa WHERE release_id = r_old;
  ANALYZE public.taxonomy_v2_taxa;
  PERFORM pg_stat_clear_snapshot();  -- stats views are cached per transaction
  m := private.admin_database_health_measure();
  SELECT p INTO t FROM jsonb_array_elements(m->'taxonomy_payload') p WHERE p->>'table' = 'taxonomy_v2_taxa';
  ASSERT t->'rows_by_release' = jsonb_build_object(r_new, 100), 'single rows ' || t::text;
  h := private.admin_database_health_assess(m);
  ASSERT h->'taxonomy'->>'estimate_basis' = 'measured_single_release', 'single basis';
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = pg_total_relation_size('public.taxonomy_v2_taxa'),
    'single bytes';
  ASSERT (h->'taxonomy'->>'retained_non_active_estimated_bytes')::bigint = 0, 'nothing retained';

  DELETE FROM public.taxonomy_v2_taxa WHERE release_id IN (r_old, r_new);
  DELETE FROM public.taxonomy_v2_concepts WHERE sporely_taxon_id BETWEEN 990000001 AND 990000300;
  DELETE FROM public.taxonomy_v2_releases WHERE release_id IN (r_old, r_new);
  ANALYZE public.taxonomy_v2_taxa;
  RAISE NOTICE 'PASS seeded payload measurement';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Synthetic measurements.
-- ---------------------------------------------------------------------------
-- Base: relations shared by every case. Payload bytes vary per case.
CREATE OR REPLACE FUNCTION pg_temp._dbh(
  p_cluster bigint,
  p_releases jsonb,
  p_taxa_rows jsonb,
  p_names_rows jsonb,
  p_extra_relations jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'measured_at', '2026-10-11T18:00:00Z',
    'database_bytes', p_cluster - 10000000,
    'cluster_bytes', p_cluster,
    'databases', '[]'::jsonb,
    'observation_count', 100,
    'image_count', 400,
    'relations', jsonb_build_array(
      jsonb_build_object('schema', 'public', 'table', 'taxonomy_v2_taxa', 'bytes', 40000000, 'has_release_id', true),
      jsonb_build_object('schema', 'public', 'table', 'taxonomy_v2_scientific_names', 'bytes', 20000000, 'has_release_id', true),
      jsonb_build_object('schema', 'public', 'table', 'taxonomy_v2_concepts', 'bytes', 5000000, 'has_release_id', false),
      jsonb_build_object('schema', 'public', 'table', 'taxonomy_v2_releases', 'bytes', 100000, 'has_release_id', true),
      jsonb_build_object('schema', 'public', 'table', 'taxa', 'bytes', 50000000, 'has_release_id', false),
      jsonb_build_object('schema', 'public', 'table', 'spatial_ref_sys', 'bytes', 7000000, 'has_release_id', false),
      jsonb_build_object('schema', 'taxonomy_v3', 'table', 'registry_concept', 'bytes', 900000, 'has_release_id', false),
      jsonb_build_object('schema', 'taxonomy_v3', 'table', 'resolution_link', 'bytes', 1000000, 'has_release_id', false),
      jsonb_build_object('schema', 'public', 'table', 'observations', 'bytes', 2000000, 'has_release_id', false),
      jsonb_build_object('schema', 'public', 'table', 'observation_images', 'bytes', 3000000, 'has_release_id', false),
      jsonb_build_object('schema', 'public', 'table', 'profiles', 'bytes', 500000, 'has_release_id', false),
      jsonb_build_object('schema', 'auth', 'table', 'users', 'bytes', 300000, 'has_release_id', false)
    ) || p_extra_relations,
    'taxonomy_releases', p_releases,
    'taxonomy_import_runs_running', 0,
    'taxonomy_payload', jsonb_build_array(
      jsonb_build_object('table', 'taxonomy_v2_taxa', 'rows_by_release', p_taxa_rows),
      jsonb_build_object('table', 'taxonomy_v2_scientific_names', 'rows_by_release', p_names_rows)
    ),
    'storage_objects', jsonb_build_object('count', 5, 'bytes', 12345)
  );
$$;

DO $$
DECLARE
  h jsonb;
  v_sum bigint;
  v_keys text[];
BEGIN
  -- 3a. Two retained releases: one retired, one active. Payload bytes are
  --     split by row share: taxa 75/25, names 50/50.
  h := private.admin_database_health_assess(pg_temp._dbh(
    300000000,
    '[{"release_id":"tax-2026.09.30-01","status":"retired"},{"release_id":"tax-2026.10.07-01","status":"active"}]',
    '{"tax-2026.09.30-01":300,"tax-2026.10.07-01":100}',
    '{"tax-2026.09.30-01":50,"tax-2026.10.07-01":50}'
  ));
  ASSERT h->>'schema_version' = '2', 'schema_version';
  ASSERT h->'taxonomy'->>'estimate_basis' = 'proportional_row_share', 'basis: ' || (h->'taxonomy'->>'estimate_basis');
  ASSERT (h->'taxonomy'->>'resident_release_count')::int = 2, 'resident releases';
  ASSERT h->'taxonomy'->>'active_release_id' = 'tax-2026.10.07-01', 'active id';
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = 20000000,
    'active bytes ' || (h->'taxonomy'->>'active_release_estimated_bytes');
  ASSERT (h->'taxonomy'->>'retained_non_active_estimated_bytes')::bigint = 40000000, 'retained bytes';
  ASSERT (h->'taxonomy'->>'release_payload_bytes')::bigint = 60000000, 'payload bytes';
  ASSERT (h->'taxonomy'->'next_publication'->>'required_bytes')::bigint = 25000000, 'required bytes';
  ASSERT (h->'taxonomy'->'next_publication'->>'fits')::boolean, 'fits';
  ASSERT (h->'taxonomy'->'next_publication'->>'fits_below_critical')::boolean, 'fits below critical';
  ASSERT (h->'taxonomy'->'next_publication'->>'additional_releases_that_fit')::bigint = 8, 'additional releases';
  -- Taxonomy: 40M + 20M + 5M + 0.1M + 50M + 7M + 0.9M.
  ASSERT (h->'categories'->'taxonomy_reference'->>'bytes')::bigint = 123000000,
    'taxonomy bytes ' || (h->'categories'->'taxonomy_reference'->>'bytes');
  ASSERT (h->'reference_data'->>'bytes')::bigint = 123000000, 'legacy reference bytes';
  -- User data: observations 2M + images 3M + resolution_link 1M + profiles 0.5M.
  ASSERT (h->'categories'->'user_data'->>'bytes')::bigint = 6500000, 'user bytes';
  ASSERT (h->'observations'->>'observation_data_bytes')::bigint = 6000000, 'observation bytes';
  ASSERT (h->>'bytes_per_observation')::bigint = 60000, 'bytes per observation ' || (h->>'bytes_per_observation');
  ASSERT (h->'observations'->'capacity'->>'until_quota')::bigint = 3333, 'obs capacity';
  ASSERT (h->'observations'->'capacity'->>'after_next_publication')::bigint = 2916, 'obs capacity after publication';
  -- Categories sum to the cluster total (unattributed + other databases included).
  SELECT sum((value->>'bytes')::bigint) INTO v_sum FROM jsonb_each(h->'categories');
  ASSERT v_sum = 300000000, 'category sum ' || v_sum;
  ASSERT (h->>'total_database_bytes')::bigint = 300000000, 'legacy total is cluster';
  ASSERT (h->'database'->>'main_bytes')::bigint = 290000000, 'main bytes';
  ASSERT (h->'database'->>'other_databases_bytes')::bigint = 10000000, 'other databases';
  ASSERT (h->>'headroom_bytes')::bigint = 200000000, 'headroom';
  ASSERT (h->>'percent_used')::numeric = 60.0, 'percent used';
  SELECT array_agg(w->>'key' ORDER BY w->>'key') INTO v_keys FROM jsonb_array_elements(h->'warnings') w;
  ASSERT v_keys = ARRAY['database_capacity', 'retired_taxonomy_payload_resident'], 'warnings ' || v_keys::text;
  ASSERT h->>'status_key' = 'watch', 'status ' || (h->>'status_key');
  RAISE NOTICE 'PASS multiple retained releases';

  -- 3b. Only the active release is resident (production after cleanup).
  h := private.admin_database_health_assess(pg_temp._dbh(
    214279725,
    '[{"release_id":"tax-2026.09.30-01","status":"retired"},{"release_id":"tax-2026.10.07-01","status":"active"}]',
    '{"tax-2026.10.07-01":100}',
    '{"tax-2026.10.07-01":80}'
  ));
  ASSERT h->'taxonomy'->>'estimate_basis' = 'measured_single_release', 'single basis';
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = 60000000, 'single active bytes';
  ASSERT (h->'taxonomy'->>'retained_non_active_estimated_bytes')::bigint = 0, 'single retained';
  ASSERT (h->'taxonomy'->'next_publication'->>'required_bytes')::bigint = 75000000, 'single required';
  ASSERT (h->'taxonomy'->'next_publication'->>'cluster_after_bytes')::bigint = 289279725, 'single after';
  ASSERT (h->'taxonomy'->'next_publication'->>'fits')::boolean, 'single fits';
  ASSERT (h->'taxonomy'->'next_publication'->>'additional_releases_that_fit')::bigint = 3, 'single additional';
  ASSERT jsonb_array_length(h->'warnings') = 0, 'single warnings ' || (h->'warnings')::text;
  ASSERT h->>'status_key' = 'ok' AND h->>'status_label' = 'OK', 'single status';
  -- Retired header without payload rows is listed with zero resident bytes.
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(h->'taxonomy'->'releases') r
                 WHERE r->>'release_id' = 'tax-2026.09.30-01' AND (r->>'estimated_resident_bytes')::bigint = 0),
    'retired header listed';
  RAISE NOTICE 'PASS single active release';

  -- 3c. Publication would cross 90 % of quota: warning, not critical.
  h := private.admin_database_health_assess(pg_temp._dbh(
    380000000, '[{"release_id":"tax-2026.10.07-01","status":"active"}]',
    '{"tax-2026.10.07-01":100}', '{"tax-2026.10.07-01":80}'));
  ASSERT h->'capacity'->>'status_key' = 'warning', 'tight capacity';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(h->'warnings') w WHERE w->>'key' = 'taxonomy_publication_tight'), 'tight warning';
  ASSERT h->>'status_key' = 'warning', 'tight status';
  RAISE NOTICE 'PASS publication tight';

  -- 3d. Publication would exceed the quota while capacity alone is OK.
  h := private.admin_database_health_assess(pg_temp._dbh(
    200000000, '[{"release_id":"tax-2026.10.07-01","status":"active"}]',
    '{"tax-2026.10.07-01":100}', '{"tax-2026.10.07-01":80}',
    '[{"schema":"public","table":"taxonomy_v2_external_ids","bytes":200000000,"has_release_id":true}]'));
  -- external_ids has no row counts, so it adds bytes but no release share.
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = 60000000, 'unmeasured payload table ignored in share';
  h := private.admin_database_health_assess(
    jsonb_set(pg_temp._dbh(
      200000000, '[{"release_id":"tax-2026.10.07-01","status":"active"}]',
      '{"tax-2026.10.07-01":100}', '{"tax-2026.10.07-01":80}',
      '[{"schema":"public","table":"taxonomy_v2_external_ids","bytes":200000000,"has_release_id":true}]'),
      '{taxonomy_payload}',
      '[{"table":"taxonomy_v2_taxa","rows_by_release":{"tax-2026.10.07-01":100}},
        {"table":"taxonomy_v2_scientific_names","rows_by_release":{"tax-2026.10.07-01":80}},
        {"table":"taxonomy_v2_external_ids","rows_by_release":{"tax-2026.10.07-01":10}}]'));
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = 260000000, 'large active';
  ASSERT h->'capacity'->>'status_key' = 'ok', 'capacity ok';
  ASSERT NOT (h->'taxonomy'->'next_publication'->>'fits')::boolean, 'does not fit';
  ASSERT h->>'status_key' = 'critical', 'escalated status';
  ASSERT h->>'status_detail' LIKE 'A new full taxonomy release needs about%', 'detail ' || (h->>'status_detail');
  RAISE NOTICE 'PASS publication will not fit';

  -- 3e. Quota reached.
  h := private.admin_database_health_assess(pg_temp._dbh(
    500000000, '[{"release_id":"tax-2026.10.07-01","status":"active"}]',
    '{"tax-2026.10.07-01":100}', '{"tax-2026.10.07-01":80}'));
  ASSERT (h->>'free_limit_reached')::boolean AND h->>'status_detail' = 'Free read-only danger state', 'limit reached';
  ASSERT (h->>'headroom_bytes')::bigint = 0, 'no headroom';
  RAISE NOTICE 'PASS quota reached';

  -- 3f. No active release; loading release in progress.
  h := private.admin_database_health_assess(pg_temp._dbh(
    200000000, '[{"release_id":"tax-2026.10.20-01","status":"loading"}]',
    '{"tax-2026.10.20-01":100}', '{}'));
  ASSERT NOT (h->'taxonomy'->'next_publication'->>'available')::boolean, 'estimate unavailable';
  ASSERT (h->'taxonomy'->>'publication_in_progress')::boolean, 'in progress';
  ASSERT (h->'taxonomy'->>'retained_non_active_estimated_bytes')::bigint = 0, 'loading is not retained';
  ASSERT h->>'status_key' = 'ok', 'info warnings do not escalate';
  RAISE NOTICE 'PASS no active release';

  -- 3f2. Two releases marked active: the estimate and its basis id both use the larger.
  h := private.admin_database_health_assess(pg_temp._dbh(
    200000000,
    '[{"release_id":"tax-2026.10.07-01","status":"active"},{"release_id":"tax-2026.10.20-01","status":"active"}]',
    '{"tax-2026.10.07-01":300,"tax-2026.10.20-01":100}', '{"tax-2026.10.07-01":50,"tax-2026.10.20-01":50}'));
  ASSERT h->'taxonomy'->'next_publication'->>'basis_release_id' = 'tax-2026.10.07-01', 'largest active id';
  ASSERT (h->'taxonomy'->>'active_release_estimated_bytes')::bigint = 40000000, 'largest active bytes';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(h->'warnings') w WHERE w->>'key' = 'multiple_active_taxonomy_releases'),
    'multiple active warning';
  RAISE NOTICE 'PASS multiple active releases';

  -- 3g. Unclassified table: reported, never user data; cluster unmeasured.
  h := private.admin_database_health_assess(
    pg_temp._dbh(200000000, '[{"release_id":"tax-2026.10.07-01","status":"active"}]',
      '{"tax-2026.10.07-01":100}', '{"tax-2026.10.07-01":80}',
      '[{"schema":"public","table":"brand_new_table","bytes":2000000,"has_release_id":false}]')
    || '{"cluster_bytes":null}');
  ASSERT (h->'categories'->'unclassified'->>'bytes')::bigint = 2000000, 'unclassified bytes';
  ASSERT (h->'categories'->'user_data'->>'bytes')::bigint = 6500000, 'unclassified not user data';
  ASSERT (h->>'bytes_per_observation')::bigint = 60000, 'unclassified not per observation';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(h->'warnings') w
                 WHERE w->>'key' = 'unclassified_relations' AND w->>'severity' = 'watch'
                   AND w->'tables' = '["public.brand_new_table"]'), 'unclassified warning';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(h->'warnings') w WHERE w->>'key' = 'cluster_size_unmeasured'), 'cluster warning';
  ASSERT (h->>'total_database_bytes')::bigint = 190000000, 'falls back to main database';
  RAISE NOTICE 'PASS unclassified and unmeasured cluster';
END $$;

-- ---------------------------------------------------------------------------
-- 4. RPC wiring and privileges.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  h jsonb := public.admin_database_health();
BEGIN
  ASSERT h->>'schema_version' = '2', 'rpc schema_version';
  ASSERT (h->>'total_database_bytes')::bigint = (h->'database'->>'cluster_bytes')::bigint, 'rpc total is cluster';
  ASSERT h ? 'reference_data' AND h ? 'user_content_data' AND h ? 'estimated_remaining_observations', 'rpc legacy keys';
  ASSERT has_function_privilege('service_role', 'public.admin_database_health()', 'EXECUTE'), 'service_role execute';
  ASSERT NOT has_function_privilege('anon', 'public.admin_database_health()', 'EXECUTE'), 'anon denied';
  ASSERT NOT has_function_privilege('authenticated', 'public.admin_database_health()', 'EXECUTE'), 'authenticated denied';
  ASSERT NOT has_function_privilege('authenticated', 'private.admin_database_health_measure()', 'EXECUTE'), 'helper denied';
  ASSERT NOT has_function_privilege('service_role', 'private.admin_database_health_assess(jsonb)', 'EXECUTE'), 'helper denied to service_role';
  RAISE NOTICE 'PASS rpc wiring and privileges';
END $$;
