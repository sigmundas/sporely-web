-- pgTAP: get_public_observation_spore_previews(bigint[]) reads points only
-- through the shared private.public_observation_spore_point_rows source, and
-- does each piece of work once.
-- Plan: docs/plans/active/2026-10-10-batch-spore-preview-rpc.md, Stage 2;
-- evidence in docs/perf/2026-10-batch-spore-preview.md.
--
-- Results stay correct when work is repeated (a pulled-up subquery re-running
-- the mosaic helpers per reference, or build_worker_media_url per point
-- instead of per image), so only call counts catch it.
--
--   supabase db reset --local
--   supabase test db supabase/tests/public_observation_spore_previews_eval_count_test.sql
-- Runs in one transaction and is rolled back.

BEGIN;

SELECT plan(9);

SET LOCAL track_functions = 'all';

CREATE TEMP TABLE spv_eval_obs (observation_id bigint) ON COMMIT DROP;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-0000000c5e01';
  obs bigint;
  img bigint;
  k int;
  n int;
BEGIN
  INSERT INTO public._media_worker_config (singleton, base_url)
  VALUES (true, 'https://upload.example.test')
  ON CONFLICT (singleton) DO UPDATE SET base_url = excluded.base_url;

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (owner_id, 'authenticated', 'authenticated', 'spv-eval@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES (owner_id, 'spv_eval', 'SPV Eval', true, false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  -- Three observations, each with two microscope images of two points.
  FOR k IN 1..3 LOOP
    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (owner_id, '2026-10-01', 'Evalgenus', 'species' || k, 'public', false, 'hidden', 'public')
    RETURNING id INTO obs;
    INSERT INTO spv_eval_obs VALUES (obs);
    FOR n IN 1..2 LOOP
      INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
      VALUES (obs, owner_id, owner_id::text || '/spv-eval-' || k || '-' || n || '.webp', 'microscope')
      RETURNING id INTO img;
      INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
      SELECT img, owner_id, 10 + g, 6, 'spore', owner_id::text || '/spv-eval-' || k || '-' || n || '-' || g || '.webp'
      FROM generate_series(1, 2) g;
    END LOOP;
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs, owner_id, owner_id::text || '/spv-eval-mosaic-' || k || '.webp', 200, 100, 100, 1);
  END LOOP;
END
$$;

CREATE TEMP TABLE spv_eval_result ON COMMIT DROP AS
SELECT * FROM public.get_public_observation_spore_previews(
  (SELECT array_agg(observation_id) FROM spv_eval_obs)
);

SELECT is(
  (SELECT count(*) FROM spv_eval_result WHERE jsonb_array_length(points) = 4 AND spore_mosaic ? 'mosaicMediaUrl'),
  3::bigint,
  'fixture: three rows with four points and an authorized mosaic each'
);

SELECT is(
  (SELECT calls FROM pg_stat_xact_user_functions
   WHERE schemaname = 'private' AND funcname = 'public_observation_spore_point_rows'),
  1::bigint,
  'the batch reads all points through one spore_point_rows call'
);
SELECT is(
  (SELECT coalesce(sum(calls), 0) FROM pg_stat_xact_user_functions
   WHERE schemaname = 'private'
     AND funcname IN ('public_observation_spore_points_raw', 'public_observation_authorize_spore_points')),
  0::numeric,
  'the batch does not build and rewrite full point arrays per observation'
);
SELECT is(
  (SELECT calls FROM pg_stat_xact_user_functions
   WHERE schemaname = 'private' AND funcname = 'public_observation_spore_mosaic_raw'),
  3::bigint,
  'spore_mosaic_raw runs once per observation'
);
SELECT is(
  (SELECT calls FROM pg_stat_xact_user_functions
   WHERE schemaname = 'private' AND funcname = 'public_observation_authorize_spore_mosaic'),
  3::bigint,
  'authorize_spore_mosaic runs once per observation'
);
SELECT is(
  (SELECT calls FROM pg_stat_xact_user_functions
   WHERE schemaname = 'public' AND funcname = 'media_authorize_mosaic_delivery'),
  3::bigint,
  'media_authorize_mosaic_delivery runs once per observation'
);
SELECT is(
  (SELECT calls FROM pg_stat_xact_user_functions
   WHERE schemaname = 'public' AND funcname = 'build_worker_media_url'),
  6::bigint,
  'build_worker_media_url runs once per image (6), not once per point (12)'
);

-- Structure: the point tables are read, for points, only by spore_point_rows.
-- Neither the batch nor spore_points_raw (get_public_observation's path) may
-- name them, so neither can apply gates of its own.
SELECT is(
  ARRAY(
    SELECT p.oid::regprocedure::text || ' names ' || t.name
    FROM pg_catalog.pg_proc p
    CROSS JOIN (VALUES ('observation_images'), ('spore_measurements'), ('spore_measurement_mosaic_tiles')) t(name)
    WHERE p.oid IN ('public.get_public_observation_spore_previews(bigint[])'::regprocedure,
                    'private.public_observation_spore_points_raw(bigint)'::regprocedure)
      AND p.prosrc LIKE '%' || t.name || '%'
    ORDER BY 1
  ),
  ARRAY[]::text[],
  'the batch and spore_points_raw read point rows only through spore_point_rows'
);
SELECT ok(
  (SELECT p.prosrc LIKE '%public.spore_measurements%'
      AND p.prosrc LIKE '%public.observation_images%'
      AND p.prosrc LIKE '%public.spore_measurement_mosaic_tiles%'
   FROM pg_catalog.pg_proc p
   WHERE p.oid = 'private.public_observation_spore_point_rows(bigint[])'::regprocedure),
  'spore_point_rows is the reader of the point tables'
);

SELECT * FROM finish();
ROLLBACK;
