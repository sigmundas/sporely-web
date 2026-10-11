-- pgTAP: get_public_observation_spore_previews(bigint[]) evaluates each
-- per-observation helper exactly once.
-- Plan: docs/plans/active/2026-10-10-batch-spore-preview-rpc.md, Stage 2;
-- evidence in docs/perf/2026-10-batch-spore-preview.md.
--
-- Without the OFFSET 0 fence on the `authorized` subquery the planner pulls it
-- up and re-runs the point helpers 3x and the mosaic helpers 5x per
-- observation. Results stay correct, so only call counts catch it.
--
--   supabase db reset --local
--   supabase test db supabase/tests/public_observation_spore_previews_eval_count_test.sql
-- Runs in one transaction and is rolled back.

BEGIN;

SELECT plan(6);

SET LOCAL track_functions = 'all';

CREATE TEMP TABLE spv_eval_obs (observation_id bigint) ON COMMIT DROP;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-0000000c5e01';
  obs bigint;
  img bigint;
  k int;
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

  FOR k IN 1..3 LOOP
    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (owner_id, '2026-10-01', 'Evalgenus', 'species' || k, 'public', false, 'hidden', 'public')
    RETURNING id INTO obs;
    INSERT INTO spv_eval_obs VALUES (obs);
    INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
    VALUES (obs, owner_id, owner_id::text || '/spv-eval-' || k || '.webp', 'microscope')
    RETURNING id INTO img;
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
    SELECT img, owner_id, 10 + g, 6, 'spore', owner_id::text || '/spv-eval-' || k || '-' || g || '.webp'
    FROM generate_series(1, 4) g;
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
   WHERE schemaname = 'private' AND funcname = 'public_observation_spore_points_raw'),
  3::bigint,
  'spore_points_raw runs once per observation'
);
SELECT is(
  (SELECT calls FROM pg_stat_xact_user_functions
   WHERE schemaname = 'private' AND funcname = 'public_observation_authorize_spore_points'),
  3::bigint,
  'authorize_spore_points runs once per observation'
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
   WHERE schemaname = 'public' AND funcname = 'build_worker_media_url'),
  12::bigint,
  'build_worker_media_url runs once per point'
);

SELECT * FROM finish();
ROLLBACK;
