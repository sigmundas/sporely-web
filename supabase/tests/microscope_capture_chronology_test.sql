-- Regression coverage for Stage 3 microscope capture chronology.
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/microscope_capture_chronology_test.sql

BEGIN;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-00000000ca31';
  stranger_id uuid := '00000000-0000-4000-8000-00000000ca32';
  obs_id bigint;
  image_a bigint;
  image_b bigint;
  image_c bigint;
  selected_image bigint;
  detail_row record;
  observation_capture timestamptz := '2024-09-15 08:30:00+00';
  function_name text;
  function_definition text;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id, 'authenticated', 'authenticated', 'chronology-owner@example.test', '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'chronology-stranger@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES
    (owner_id, 'chronology_owner', 'Chronology Owner'),
    (stranger_id, 'chronology_stranger', 'Chronology Stranger')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.observations (
    user_id, date, captured_at, genus, species, visibility, is_draft
  )
  VALUES (
    owner_id, '2024-09-15', observation_capture,
    'Amanita', 'chronologia', 'public', false
  )
  RETURNING id INTO obs_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, image_type, captured_at, created_at, contrast
  )
  VALUES (
    obs_id, owner_id, 'microscope', '2026-07-01 00:00:00+00',
    '2026-08-09 00:00:00+00', 'uploaded-later'
  )
  RETURNING id INTO image_a;

  INSERT INTO public.observation_images (
    observation_id, user_id, image_type, captured_at, created_at, contrast
  )
  VALUES (
    obs_id, owner_id, 'microscope', '2026-08-01 00:00:00+00',
    '2026-08-02 00:00:00+00', 'captured-later'
  )
  RETURNING id INTO image_b;

  SELECT i.id INTO selected_image
  FROM public.observation_images i
  WHERE i.observation_id = obs_id
    AND i.image_type = 'microscope'
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
  ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC
  LIMIT 1;

  IF selected_image IS DISTINCT FROM image_b THEN
    RAISE EXCEPTION 'Real capture chronology did not beat upload chronology';
  END IF;

  SELECT * INTO detail_row FROM public.get_public_observation(obs_id);
  IF detail_row."contrastMethod" IS DISTINCT FROM 'captured-later' THEN
    RAISE EXCEPTION 'Public observation representative microscope row used upload chronology';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  IF public.get_observation_latest_microscope_captured_at(obs_id)
      IS DISTINCT FROM '2026-08-01 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Owner aggregate did not return the newest real microscope capture';
  END IF;

  -- A very old image uploaded late must not become latest.
  UPDATE public.observation_images
  SET captured_at = '2024-01-01 00:00:00+00',
      created_at = '2026-08-10 00:00:00+00'
  WHERE id = image_a;
  SELECT * INTO detail_row FROM public.get_public_observation(obs_id);
  IF detail_row."contrastMethod" IS DISTINCT FROM 'captured-later' THEN
    RAISE EXCEPTION 'Late upload of an old microscope image became representative';
  END IF;

  -- A legacy NULL remains behind every real capture timestamp.
  UPDATE public.observation_images SET captured_at = NULL WHERE id = image_a;
  SELECT * INTO detail_row FROM public.get_public_observation(obs_id);
  IF detail_row."contrastMethod" IS DISTINCT FROM 'captured-later'
     OR public.get_observation_latest_microscope_captured_at(obs_id)
        IS DISTINCT FROM '2026-08-01 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Legacy NULL image displaced a real microscope capture';
  END IF;

  -- If all captures are unknown, upload time can select a representative but
  -- must never become the derived microscope timestamp.
  UPDATE public.observation_images SET captured_at = NULL WHERE id = image_b;
  SELECT * INTO detail_row FROM public.get_public_observation(obs_id);
  IF detail_row."contrastMethod" IS DISTINCT FROM 'uploaded-later'
     OR public.get_observation_latest_microscope_captured_at(obs_id) IS NOT NULL THEN
    RAISE EXCEPTION 'All-NULL legacy behavior fabricated or misordered capture time';
  END IF;

  -- Identical real captures use created_at, then id, deterministically.
  UPDATE public.observation_images
  SET captured_at = '2026-08-01 00:00:00+00',
      created_at = '2026-08-05 00:00:00+00'
  WHERE id IN (image_a, image_b);
  INSERT INTO public.observation_images (
    observation_id, user_id, image_type, captured_at, created_at, contrast
  )
  VALUES (
    obs_id, owner_id, 'microscope', '2026-08-01 00:00:00+00',
    '2026-08-05 00:00:00+00', 'id-tiebreak'
  )
  RETURNING id INTO image_c;
  SELECT * INTO detail_row FROM public.get_public_observation(obs_id);
  IF detail_row."contrastMethod" IS DISTINCT FROM 'id-tiebreak' THEN
    RAISE EXCEPTION 'Canonical microscope tie-break is not deterministic';
  END IF;

  -- Newer field images are irrelevant, and deleted/purged microscope images
  -- cannot bypass the existing visibility predicates.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, captured_at, created_at
  ) VALUES (
    obs_id, owner_id, owner_id::text || '/field.webp', 'field',
    '2030-01-01 00:00:00+00', '2030-01-01 00:00:00+00'
  );
  UPDATE public.observation_images SET deleted_at = now() WHERE id = image_c;
  UPDATE public.observation_images
  SET captured_at = '2029-01-01 00:00:00+00', deleted_at = now(), purged_at = now()
  WHERE id = image_a;
  IF public.get_observation_latest_microscope_captured_at(obs_id)
      IS DISTINCT FROM '2026-08-01 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Field, deleted, or purged image affected Last microscopy';
  END IF;

  IF (SELECT captured_at FROM public.observations WHERE id = obs_id)
      IS DISTINCT FROM observation_capture THEN
    RAISE EXCEPTION 'Microscope chronology changed the observation event timestamp';
  END IF;

  -- Exact working time remains owner-private.
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  IF public.get_observation_latest_microscope_captured_at(obs_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Owner-only microscope aggregate leaked to another user';
  END IF;
  IF has_function_privilege('anon', 'public.get_observation_latest_microscope_captured_at(bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous role can execute the owner microscope timestamp RPC';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'observation_images_community_view'
      AND column_name = 'captured_at'
  ) THEN
    RAISE EXCEPTION 'Exact image capture time leaked into the community view';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(coalesce(p.proargnames, ARRAY[]::text[])) AS arg_name
    WHERE n.nspname = 'public'
      AND p.proname = 'get_public_observation'
      AND regexp_replace(lower(arg_name), '[^a-z0-9]+', '', 'g')
          LIKE '%microscopecapturedat%'
  ) THEN
    RAISE EXCEPTION 'Exact microscope timestamp leaked into the public detail RPC';
  END IF;

  FOREACH function_name IN ARRAY ARRAY[
    '_get_public_observation_stage2a',
    'get_public_observation_facets',
    '_get_public_species_stage2a',
    'search_public_observations',
    '_search_public_species_stage2a'
  ]
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO function_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = function_name
    LIMIT 1;
    IF position(
      'ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC'
      IN function_definition
    ) = 0 THEN
      RAISE EXCEPTION '% does not use canonical microscope ordering', function_name;
    END IF;
  END LOOP;
END
$$;

ROLLBACK;
