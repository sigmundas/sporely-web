-- Batch spore-preview RPC: post-apply live probe (read-only, aggregate-only).
--
-- Runbook: supabase/batch-spore-preview-runbook.md, step 3a.
-- Migration: supabase/migrations/20261011120000_add_public_observation_spore_previews.sql.
--
-- Run as the database owner (postgres), with psql, after the migration is
-- applied:
--
--   psql "<connection string>" -X -v ON_ERROR_STOP=1 -f supabase/batch-spore-preview-live-probe.sql
--
-- It prints booleans and integers only. Observation ids are chosen inside the
-- transaction and are never printed. The whole file is one READ ONLY
-- transaction that ends in ROLLBACK, so it changes nothing.
--
-- Part B runs the calls as the anon role with no JWT claims, which is what an
-- anonymous PostgREST request does. It makes up to 30 get_public_observation
-- calls and one batch call, about as much as one cold Cards load. Each
-- statement carries the marker /* bsp_probe */ so that
-- supabase/batch-spore-preview-stats-probe.sql can leave it out.

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

-- --- Part A: catalog shape ---------------------------------------------------
-- Expect one row: t | t | t | t | t | f | f | f

SELECT /* bsp_probe */
  p.prosecdef                                                     AS security_definer,
  p.proconfig = ARRAY['search_path=""']                           AS empty_search_path,
  pg_catalog.pg_get_function_result(p.oid)
    = 'TABLE(observation_id bigint, points jsonb, spore_mosaic jsonb)' AS result_shape,
  pg_catalog.has_function_privilege('anon',
    'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE') AS anon_execute,
  pg_catalog.has_function_privilege('authenticated',
    'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE') AS authenticated_execute,
  pg_catalog.has_function_privilege('service_role',
    'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE') AS service_role_execute,
  -- no PUBLIC entry in the ACL (acldefault would grant EXECUTE to PUBLIC)
  EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0
  )                                                               AS public_execute,
  -- none of the six private helpers is executable by anon or authenticated
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc h
    JOIN pg_catalog.pg_namespace n ON n.oid = h.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) r(role)
    WHERE n.nspname = 'private'
      AND h.proname IN ('public_observation_eligibility',
                        'public_observation_spore_point_rows',
                        'public_observation_spore_points_raw',
                        'public_observation_spore_mosaic_raw',
                        'public_observation_authorize_spore_points',
                        'public_observation_authorize_spore_mosaic')
      AND pg_catalog.has_function_privilege(r.role, h.oid, 'EXECUTE')
  )                                                               AS helper_executable_by_client
FROM pg_catalog.pg_proc p
WHERE p.oid = 'public.get_public_observation_spore_previews(bigint[])'::pg_catalog.regprocedure;

-- Expect: 6 (all private helpers present)
SELECT /* bsp_probe */ count(*) AS private_helpers
FROM pg_catalog.pg_proc h
JOIN pg_catalog.pg_namespace n ON n.oid = h.pronamespace
WHERE n.nspname = 'private'
  AND h.proname IN ('public_observation_eligibility',
                    'public_observation_spore_point_rows',
                    'public_observation_spore_points_raw',
                    'public_observation_spore_mosaic_raw',
                    'public_observation_authorize_spore_points',
                    'public_observation_authorize_spore_mosaic');

-- --- Part B: anonymous calls ---------------------------------------------------
-- Samples, chosen as the owner and kept in transaction-local settings. Each
-- statement prints only whether a sample was stored.
--
-- public sample: the 30 most recent observations that are public, not draft,
--   spore_data_visibility = 'public', and have at least one spore measurement.
--   Other gates (banned owner, image and measurement gates) are deliberately
--   left to the functions; the parity check below covers them.
-- non-public sample: the 30 most recent observations that are not public or
--   are drafts.

SELECT /* bsp_probe */ pg_catalog.set_config('bsp_probe.public_ids', coalesce((
  SELECT pg_catalog.array_agg(s.id)::text FROM (
    SELECT o.id
    FROM public.observations o
    WHERE o.visibility = 'public'
      AND NOT coalesce(o.is_draft, false)
      AND o.spore_data_visibility = 'public'
      AND EXISTS (
        SELECT 1
        FROM public.observation_images i
        JOIN public.spore_measurements m ON m.image_id = i.id
        WHERE i.observation_id = o.id
      )
    ORDER BY o.id DESC
    LIMIT 30
  ) s), '{}'), true) IS NOT NULL AS public_sample_stored;

SELECT /* bsp_probe */ pg_catalog.set_config('bsp_probe.nonpublic_ids', coalesce((
  SELECT pg_catalog.array_agg(s.id)::text FROM (
    SELECT o.id
    FROM public.observations o
    WHERE o.visibility IS DISTINCT FROM 'public' OR coalesce(o.is_draft, false)
    ORDER BY o.id DESC
    LIMIT 30
  ) s), '{}'), true) IS NOT NULL AS nonpublic_sample_stored;

-- Anonymous caller: no JWT claims, so auth.uid() is NULL.
SELECT /* bsp_probe */ pg_catalog.set_config('request.jwt.claims', '', true) IS NOT NULL AS claims_cleared;
SET LOCAL ROLE anon;

-- Expect:
--   caller = anon, uid_is_null = t
--   public_sample > 0 (else pick a different window; see the runbook)
--   public_batch_rows = public_single_rows
--   public_batch_rows_with_points >= 1
--   public_mismatches = 0
--   batch_mosaics_with_url = 0
--   nonpublic_sample > 0, nonpublic_single_rows = 0, nonpublic_batch_rows = 0
WITH ids AS (
  SELECT
    current_setting('bsp_probe.public_ids')::bigint[]    AS public_ids,
    current_setting('bsp_probe.nonpublic_ids')::bigint[] AS nonpublic_ids
),
batch AS (
  SELECT b.*
  FROM ids CROSS JOIN LATERAL public.get_public_observation_spore_previews(ids.public_ids) b
),
-- get_public_observation reduced to the card keys (points) and minus url
-- (mosaic): the batch contract in SUPABASE_DB.md.
single AS (
  SELECT g.id AS observation_id,
         CASE WHEN g."sporePoints" IS NULL THEN NULL ELSE (
           SELECT coalesce(jsonb_agg((
             SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
             FROM jsonb_each(pt.value) kv
             WHERE kv.key IN ('id', 'lengthUm', 'widthUm', 'cropUrl', 'mosaicX', 'mosaicY', 'mosaicW', 'mosaicH',
                              'contrastMethod', 'mountReagent', 'sampleType', 'sampleSource')
           ) ORDER BY pt.ord), '[]'::jsonb)
           FROM jsonb_array_elements(g."sporePoints") WITH ORDINALITY pt(value, ord)) END AS points,
         g."sporeMosaic" - 'url' AS spore_mosaic
  FROM ids
  CROSS JOIN LATERAL unnest(ids.public_ids) i
  CROSS JOIN LATERAL public.get_public_observation(i) g
),
nonpublic_batch AS (
  SELECT b.observation_id
  FROM ids CROSS JOIN LATERAL public.get_public_observation_spore_previews(ids.nonpublic_ids) b
),
nonpublic_single AS (
  SELECT g.id
  FROM ids
  CROSS JOIN LATERAL unnest(ids.nonpublic_ids) i
  CROSS JOIN LATERAL public.get_public_observation(i) g
)
SELECT /* bsp_probe */
  current_user                                                    AS caller,
  auth.uid() IS NULL                                              AS uid_is_null,
  (SELECT cardinality(public_ids) FROM ids)                       AS public_sample,
  (SELECT count(*) FROM single)                                   AS public_single_rows,
  (SELECT count(*) FROM batch)                                    AS public_batch_rows,
  (SELECT count(*) FROM batch WHERE points IS NOT NULL)           AS public_batch_rows_with_points,
  (SELECT coalesce(sum(jsonb_array_length(points)), 0) FROM batch) AS public_batch_points,
  (SELECT count(*) FROM batch WHERE spore_mosaic IS NOT NULL)     AS public_batch_mosaics,
  (SELECT count(*) FROM batch WHERE spore_mosaic ? 'url')         AS batch_mosaics_with_url,
  (SELECT count(*) FROM batch b FULL JOIN single s USING (observation_id)
    WHERE b.observation_id IS NULL OR s.observation_id IS NULL
       OR b.points IS DISTINCT FROM s.points
       OR (b.spore_mosaic IS NOT NULL AND b.spore_mosaic IS DISTINCT FROM s.spore_mosaic)) AS public_mismatches,
  (SELECT count(*) FROM batch b JOIN single s USING (observation_id)
    WHERE b.spore_mosaic IS NULL AND s.spore_mosaic IS NOT NULL)  AS mosaics_withheld,
  (SELECT cardinality(nonpublic_ids) FROM ids)                    AS nonpublic_sample,
  (SELECT count(*) FROM nonpublic_single)                         AS nonpublic_single_rows,
  (SELECT count(*) FROM nonpublic_batch)                          AS nonpublic_batch_rows;

ROLLBACK;
