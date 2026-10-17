-- Ingestion and location provenance: readiness and stored-metadata probe
-- (read-only, aggregate-only).
--
-- Runbook: docs/deployments/2026-10-16-ingestion-location-provenance-rollout.md.
-- Migration: supabase/migrations/20261012105630_ingestion_location_provenance.sql.
--
-- Run as the database owner (postgres), with psql 10 or later:
--
--   psql "<connection string>" -X -v ON_ERROR_STOP=1 \
--     -v since='<ISO timestamp>' -v expect=applied \
--     -f supabase/ingestion-location-provenance-probe.sql
--
--   since   Required. Part B counts only rows created or updated at or after
--           it (the start of a G5 session, or the production apply time).
--   expect  Optional. 'applied' exits 3 unless every Part A readiness check
--           and every Part C access check holds. 'absent' exits 3 unless none
--           of the migration's objects exist while the Part A privacy checks
--           and the Part C access checks still hold (pre-apply check). Part C
--           needs at least one observation and one image row on the target.
--           Omit it to print only.
--
-- Test: supabase/tests/ingestion_location_provenance_probe_test.sh.
--
-- Output: booleans, integers, enum labels, migration versions and the names of
-- catalog objects. Never a row id, user id, coordinate, storage key or row
-- timestamp. One READ ONLY transaction that ends in ROLLBACK: it writes
-- nothing. It calls no public observation RPC, so it adds no calls to the
-- functions the batch-spore-preview statistics probe counts; it does add its
-- own statements (marked /* ilp_probe */) to pg_stat_statements, so on
-- production follow the runbook's B0/B1 rule before running it.

\set ON_ERROR_STOP on
\if :{?since}
\else
  \echo 'ilp_probe: pass -v since=<ISO timestamp>'
  DO $$ BEGIN RAISE EXCEPTION 'ilp_probe: since is required'; END $$;
\endif
\if :{?expect}
\else
  \set expect ''
\endif

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';

-- --- Part A: readiness --------------------------------------------------------
-- Catalog only. to_regprocedure keeps this runnable before the migration.

WITH
  rpc AS (
    SELECT pg_catalog.to_regprocedure('public.set_observation_location(bigint,double precision,double precision,real,real,text,text)')::oid AS oid
  ),
  trg_fn AS (
    SELECT pg_catalog.to_regprocedure('public._invalidate_changed_location_provenance()')::oid AS oid
  ),
  migration AS (
    SELECT /* ilp_probe */
      EXISTS (
        SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261012105630'
      ) AS recorded,
      (SELECT max(version) FROM supabase_migrations.schema_migrations) AS latest
  ),
  cols AS (
    SELECT
      count(*) AS present,
      count(*) FILTER (
        WHERE a.atttypid = 'pg_catalog.text'::pg_catalog.regtype AND NOT a.attnotnull
      ) AS nullable_text
    FROM pg_catalog.pg_attribute a
    WHERE NOT a.attisdropped
      AND (
        (a.attrelid = 'public.observation_images'::pg_catalog.regclass
          AND a.attname = 'ingest_method')
        OR (a.attrelid = 'public.observations'::pg_catalog.regclass
          AND a.attname IN ('location_source', 'location_status'))
      )
  ),
  checks AS (
    SELECT count(*) AS present, count(*) FILTER (WHERE c.convalidated) AS validated
    FROM pg_catalog.pg_constraint c
    WHERE c.contype = 'c'
      AND (
        (c.conrelid = 'public.observation_images'::pg_catalog.regclass
          AND c.conname = 'observation_images_ingest_method_check')
        OR (c.conrelid = 'public.observations'::pg_catalog.regclass
          AND c.conname = 'observations_location_provenance_check')
      )
  ),
  trg AS (
    -- tgtype 19 = ROW | BEFORE | UPDATE; 'O' = enabled in origin/local mode.
    SELECT
      count(*) AS present,
      count(*) FILTER (
        WHERE t.tgtype = 19 AND t.tgenabled = 'O' AND t.tgfoid = (SELECT oid FROM trg_fn)
      ) AS correct
    FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.observations'::pg_catalog.regclass
      AND t.tgname = 'trg_location_provenance_invalidate'
      AND NOT t.tgisinternal
  ),
  fns AS (
    SELECT f.kind, p.oid, p.prosecdef, p.proconfig, p.prorettype, p.proowner, p.proacl
    FROM (
      SELECT 'rpc' AS kind, oid FROM rpc
      UNION ALL
      SELECT 'trigger', oid FROM trg_fn
    ) f
    JOIN pg_catalog.pg_proc p ON p.oid = f.oid
  ),
  rpc_public AS (
    SELECT EXISTS (
      SELECT 1
      FROM fns,
        pg_catalog.aclexplode(coalesce(fns.proacl, pg_catalog.acldefault('f', fns.proowner))) a
      WHERE fns.kind = 'rpc' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) AS execute
  ),
  exposing_views AS (
    SELECT count(DISTINCT c.oid) AS n
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND a.attname IN ('ingest_method', 'location_source', 'location_status')
      AND NOT a.attisdropped
  ),
  exposing_functions AS (
    SELECT count(*) AS n
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%'
      AND p.oid IS DISTINCT FROM (SELECT oid FROM rpc)
      AND (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
      AND (p.prosrc ~ '(ingest_method|location_source|location_status)'
        OR pg_catalog.pg_get_function_result(p.oid) ~ '(ingest_method|location_source|location_status)'
        OR p.prorettype IN ('public.observations'::pg_catalog.regtype,
                            'public.observation_images'::pg_catalog.regtype))
  ),
  readiness AS (
    SELECT
      m.recorded AS migration_recorded,
      m.latest AS latest_version,
      (m.recorded::int + cols.present + checks.present + trg.present
        + (SELECT count(*) FROM fns))::int AS present_objects,
      cols.present = 3 AND cols.nullable_text = 3 AS columns_ok,
      checks.validated = 2 AS checks_validated,
      trg.correct = 1 AS invalidation_trigger_ok,
      coalesce(
        EXISTS (
          SELECT 1 FROM fns
          WHERE kind = 'trigger' AND NOT prosecdef AND proconfig = ARRAY['search_path=""']
        )
        AND NOT pg_catalog.has_function_privilege('anon', (SELECT oid FROM trg_fn), 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated', (SELECT oid FROM trg_fn), 'EXECUTE'),
        false
      ) AS trigger_fn_private,
      EXISTS (
        SELECT 1 FROM fns
        WHERE kind = 'rpc' AND NOT prosecdef AND proconfig = ARRAY['search_path=""']
          AND prorettype = 'pg_catalog.int8'::pg_catalog.regtype
      ) AS rpc_invoker_shape,
      coalesce(
        pg_catalog.has_function_privilege('authenticated', (SELECT oid FROM rpc), 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('anon', (SELECT oid FROM rpc), 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('service_role', (SELECT oid FROM rpc), 'EXECUTE')
        AND NOT rpc_public.execute,
        false
      ) AS rpc_grants_ok,
      (SELECT bool_and(c.relrowsecurity) FROM pg_catalog.pg_class c
        WHERE c.oid IN ('public.observations'::pg_catalog.regclass,
                        'public.observation_images'::pg_catalog.regclass)) AS rls_enabled,
      NOT pg_catalog.has_any_column_privilege('anon', 'public.observations', 'SELECT')
        AND NOT pg_catalog.has_any_column_privilege('anon', 'public.observation_images', 'SELECT')
        AS anon_no_base_read,
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename IN ('observations', 'observation_images')
          AND p.cmd IN ('SELECT', 'ALL')
          AND p.roles <> ARRAY['authenticated']::name[]
      ) AS base_read_policies_authenticated_only,
      exposing_views.n::int AS exposing_views,
      exposing_functions.n::int AS exposing_functions
    FROM migration m, cols, checks, trg, rpc_public, exposing_views, exposing_functions
  )
SELECT /* ilp_probe */
  r.*,
  r.present_objects = 9 AND r.migration_recorded AND r.columns_ok AND r.checks_validated
    AND r.invalidation_trigger_ok AND r.trigger_fn_private AND r.rpc_invoker_shape
    AND r.rpc_grants_ok AND r.rls_enabled AND r.anon_no_base_read
    AND r.base_read_policies_authenticated_only
    AND r.exposing_views = 0 AND r.exposing_functions = 0 AS ready_applied,
  r.present_objects = 0 AND r.rls_enabled AND r.anon_no_base_read
    AND r.base_read_policies_authenticated_only
    AND r.exposing_views = 0 AND r.exposing_functions = 0 AS ready_absent
FROM readiness r
\gset ilp_

\echo ''
\echo 'A. Readiness                                 applied   absent (pre-apply)'
\echo '   migration_recorded                    ' :ilp_migration_recorded '      t         f'
\echo '   latest_version                        ' :ilp_latest_version
\echo '   present_objects                       ' :ilp_present_objects '      9         0'
\echo '   columns_ok                            ' :ilp_columns_ok '      t         f'
\echo '   checks_validated                      ' :ilp_checks_validated '      t         f'
\echo '   invalidation_trigger_ok               ' :ilp_invalidation_trigger_ok '      t         f'
\echo '   trigger_fn_private                    ' :ilp_trigger_fn_private '      t         f'
\echo '   rpc_invoker_shape                     ' :ilp_rpc_invoker_shape '      t         f'
\echo '   rpc_grants_ok                         ' :ilp_rpc_grants_ok '      t         f'
\echo '   rls_enabled                           ' :ilp_rls_enabled '      t         t'
\echo '   anon_no_base_read                     ' :ilp_anon_no_base_read '      t         t'
\echo '   base_read_policies_authenticated_only ' :ilp_base_read_policies_authenticated_only '      t         t'
\echo '   exposing_views                        ' :ilp_exposing_views '      0         0'
\echo '   exposing_functions                    ' :ilp_exposing_functions '      0         0'
\echo '   ready_applied                         ' :ilp_ready_applied
\echo '   ready_absent                          ' :ilp_ready_absent

-- Names of any exposing view or function (catalog metadata). Expect no rows.
SELECT /* ilp_probe */ 'view' AS kind, n.nspname || '.' || c.relname AS object
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('v', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND a.attname IN ('ingest_method', 'location_source', 'location_status')
  AND NOT a.attisdropped
UNION
SELECT 'function',
  n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_%'
  AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure('public.set_observation_location(bigint,double precision,double precision,real,real,text,text)')::oid
  AND (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  AND (p.prosrc ~ '(ingest_method|location_source|location_status)'
    OR pg_catalog.pg_get_function_result(p.oid) ~ '(ingest_method|location_source|location_status)'
    OR p.prorettype IN ('public.observations'::pg_catalog.regtype,
                        'public.observation_images'::pg_catalog.regtype))
ORDER BY 1, 2;

-- --- Part B: stored metadata since :since (aggregate-only) --------------------
-- Needs the columns, so it is skipped before the migration.

SELECT (:'ilp_present_objects')::int > 0 AND :'ilp_columns_ok'::boolean AS ilp_has_columns \gset

\if :ilp_has_columns

-- B1. Images created in the window, by ingest method.
SELECT /* ilp_probe */
  coalesce(i.ingest_method, '(null)') AS ingest_method,
  count(*) FILTER (WHERE i.deleted_at IS NULL) AS live_images,
  count(*) FILTER (WHERE i.deleted_at IS NOT NULL) AS deleted_images
FROM public.observation_images i
WHERE i.created_at >= :'since'::timestamptz
GROUP BY 1
ORDER BY 1;

-- B2. Observations created or updated in the window, by stored location pair.
SELECT /* ilp_probe */
  coalesce(o.location_source, '(null)') AS location_source,
  coalesce(o.location_status, '(null)') AS location_status,
  (o.gps_latitude IS NOT NULL AND o.gps_longitude IS NOT NULL) AS has_coordinates,
  count(*) FILTER (WHERE o.created_at >= :'since'::timestamptz) AS created,
  count(*) AS created_or_updated
FROM public.observations o
WHERE o.created_at >= :'since'::timestamptz
   OR o.updated_at >= :'since'::timestamptz
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- B3. Batch and retry checks over live images created in the window.
--   duplicate_image_rows       groups of live rows sharing observation and
--                              storage key beyond the first. Expect 0.
--   possible_duplicate_obs     same owner, date and coordinates, created
--                              within 120 s of each other. Expect 0 unless a
--                              case deliberately created such a pair.
--   mixed_method_observations  observations whose live images carry two or
--                              more different non-NULL methods.
--   null_method_images         live images with no method (legacy or desktop
--                              clients; a provenance-aware web/Android image
--                              should not be here).
WITH win AS (
  SELECT i.observation_id, i.storage_path, i.ingest_method
  FROM public.observation_images i
  WHERE i.created_at >= :'since'::timestamptz AND i.deleted_at IS NULL
)
SELECT /* ilp_probe */
  (SELECT coalesce(sum(n - 1), 0)::int FROM (
     SELECT count(*) AS n FROM win
     WHERE storage_path IS NOT NULL
     GROUP BY observation_id, storage_path HAVING count(*) > 1) d) AS duplicate_image_rows,
  (SELECT count(*)::int FROM public.observations a
     JOIN public.observations b
       ON b.user_id = a.user_id AND b.id > a.id AND b.date = a.date
      AND b.gps_latitude IS NOT DISTINCT FROM a.gps_latitude
      AND b.gps_longitude IS NOT DISTINCT FROM a.gps_longitude
      AND abs(extract(epoch FROM b.created_at - a.created_at)) <= 120
     WHERE a.created_at >= :'since'::timestamptz
       AND b.created_at >= :'since'::timestamptz) AS possible_duplicate_obs,
  (SELECT count(*)::int FROM (
     SELECT observation_id FROM win WHERE ingest_method IS NOT NULL
     GROUP BY observation_id HAVING count(DISTINCT ingest_method) > 1) m) AS mixed_method_observations,
  (SELECT count(*)::int FROM win WHERE ingest_method IS NULL) AS null_method_images;

\else
\echo ''
\echo 'B. Skipped: the provenance columns are not present.'
\endif

-- --- Part C: non-owner and anonymous reads ------------------------------------
-- These results are part of both assertions. C1 is only meaningful when
-- observations and images exist; on a target without either, access_ok is
-- false and both assertions fail rather than pass vacuously.

SELECT /* ilp_probe */
  EXISTS (SELECT 1 FROM public.observations) AS observations_present,
  EXISTS (SELECT 1 FROM public.observation_images) AS images_present
\gset ilp_

-- C1 as an authenticated user that owns nothing (random sub): base-table rows
-- visible. Expect 0 | 0.
SELECT pg_catalog.set_config('request.jwt.claims',
         pg_catalog.jsonb_build_object('role', 'authenticated',
                                       'sub', gen_random_uuid())::text, true),
       pg_catalog.set_config('request.jwt.claim.sub', '', true) \gset ilp_unused_
SET LOCAL ROLE authenticated;
SELECT /* ilp_probe */
  (SELECT count(*) FROM public.observations)::int AS non_owner_observations_visible,
  (SELECT count(*) FROM public.observation_images)::int AS non_owner_images_visible
\gset ilp_
RESET ROLE;

-- C2 as anon (no claims): public community projections, up to 200 rows each.
-- Expect *_leaking = 0. *_sampled shows whether the check saw any rows; the
-- catalog check in Part A covers the view columns either way.
SELECT pg_catalog.set_config('request.jwt.claims', '{"role":"anon"}', true),
       pg_catalog.set_config('request.jwt.claim.sub', '', true) \gset ilp_unused_
SET LOCAL ROLE anon;
SELECT /* ilp_probe */
  count(*)::int AS observations_view_sampled,
  (count(*) FILTER (WHERE j ?| ARRAY['ingest_method', 'location_source', 'location_status']))::int
    AS observations_view_leaking
FROM (SELECT to_jsonb(v) AS j FROM public.observations_community_view v LIMIT 200) s
\gset ilp_
SELECT /* ilp_probe */
  count(*)::int AS images_view_sampled,
  (count(*) FILTER (WHERE j ?| ARRAY['ingest_method', 'location_source', 'location_status']))::int
    AS images_view_leaking
FROM (SELECT to_jsonb(v) AS j FROM public.observation_images_community_view v LIMIT 200) s
\gset ilp_
RESET ROLE;

-- A vacuous C1 (no observation or no image rows at all) does not count as a
-- pass: each base table needs a row for its non-owner check to mean anything.
SELECT
  :'ilp_observations_present'::boolean AND :'ilp_images_present'::boolean
    AND :ilp_non_owner_observations_visible = 0 AND :ilp_non_owner_images_visible = 0
    AND :ilp_observations_view_leaking = 0 AND :ilp_images_view_leaking = 0 AS ilp_access_ok,
  NOT (:'ilp_observations_present'::boolean AND :'ilp_images_present'::boolean)
    AS ilp_access_vacuous \gset

\echo ''
\echo 'C. Non-owner and anonymous reads             expect'
\echo '   observations_present                  ' :ilp_observations_present '      t (else C1 is vacuous)'
\echo '   images_present                        ' :ilp_images_present '      t (else C1 is vacuous)'
\echo '   non_owner_observations_visible        ' :ilp_non_owner_observations_visible '      0'
\echo '   non_owner_images_visible              ' :ilp_non_owner_images_visible '      0'
\echo '   observations_view_sampled             ' :ilp_observations_view_sampled
\echo '   observations_view_leaking             ' :ilp_observations_view_leaking '      0'
\echo '   images_view_sampled                   ' :ilp_images_view_sampled
\echo '   images_view_leaking                   ' :ilp_images_view_leaking '      0'
\echo '   access_ok                             ' :ilp_access_ok
\if :ilp_access_vacuous
\echo '   No observation or no image rows exist, so C1 proves nothing here; access_ok is f.'
\endif

ROLLBACK;

-- --- Optional assertion -------------------------------------------------------

SELECT :'expect' = 'applied' AS ilp_expect_applied,
       :'expect' = 'absent' AS ilp_expect_absent,
       :'expect' NOT IN ('', 'applied', 'absent') AS ilp_expect_invalid \gset

\if :ilp_expect_invalid
  DO $$ BEGIN RAISE EXCEPTION 'ilp_probe: expect must be applied or absent'; END $$;
\elif :ilp_expect_applied
  \if :ilp_ready_applied
    \if :ilp_access_ok
      \echo 'ilp_probe: READY (applied)'
    \else
      DO $$ BEGIN RAISE EXCEPTION 'ilp_probe: access check failed (see Part C)'; END $$;
    \endif
  \else
    DO $$ BEGIN RAISE EXCEPTION 'ilp_probe: readiness failed for expect=applied (see Part A)'; END $$;
  \endif
\elif :ilp_expect_absent
  \if :ilp_ready_absent
    \if :ilp_access_ok
      \echo 'ilp_probe: READY (absent, pre-apply)'
    \else
      DO $$ BEGIN RAISE EXCEPTION 'ilp_probe: access check failed (see Part C)'; END $$;
    \endif
  \else
    DO $$ BEGIN RAISE EXCEPTION 'ilp_probe: target is not in the expected pre-apply state (see Part A)'; END $$;
  \endif
\endif
