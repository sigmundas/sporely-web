-- Regression coverage for image capture-time schema semantics.
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/observation_image_captured_at_test.sql

BEGIN;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-00000000ca01';
  obs_id bigint;
  image_without_capture_id bigint;
  image_with_capture_id bigint;
  observation_capture timestamptz := '2024-09-15 08:30:00+00';
  image_capture timestamptz := '2026-07-12 19:45:00+02';
  stored_image_capture timestamptz;
  stored_image_created timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'observation_images'
      AND column_name = 'captured_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION
      'observation_images.captured_at must be nullable timestamptz without a default';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'observation_images'
      AND indexname = 'observation_images_microscope_captured_at_idx'
      AND indexdef LIKE '%(observation_id, captured_at DESC)%'
      AND indexdef LIKE '%image_type = ''microscope''%'
  ) THEN
    RAISE EXCEPTION 'Expected microscope capture chronology index is missing';
  END IF;

  INSERT INTO auth.users (
    id, aud, role, email, raw_user_meta_data, created_at, updated_at
  )
  VALUES (
    owner_id, 'authenticated', 'authenticated',
    'image-captured-at@example.test', '{}'::jsonb, now(), now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES (owner_id, 'image_capture_test', 'Image Capture Test')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.observations (user_id, date, captured_at)
  VALUES (owner_id, '2024-09-15', observation_capture)
  RETURNING id INTO obs_id;

  -- Legacy and older clients may continue omitting image captured_at.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type
  )
  VALUES (obs_id, owner_id, NULL, 'microscope')
  RETURNING id INTO image_without_capture_id;

  IF (SELECT captured_at FROM public.observation_images
      WHERE id = image_without_capture_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Omitted image captured_at must remain NULL';
  END IF;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, captured_at
  )
  VALUES (obs_id, owner_id, NULL, 'microscope', image_capture)
  RETURNING id, captured_at, created_at
  INTO image_with_capture_id, stored_image_capture, stored_image_created;

  IF stored_image_capture IS DISTINCT FROM image_capture THEN
    RAISE EXCEPTION 'Explicit image captured_at did not round-trip';
  END IF;

  IF stored_image_created IS NULL OR stored_image_created = stored_image_capture THEN
    RAISE EXCEPTION
      'Image created_at must remain an independent cloud row creation timestamp';
  END IF;

  IF (SELECT captured_at FROM public.observations WHERE id = obs_id)
      IS DISTINCT FROM observation_capture THEN
    RAISE EXCEPTION
      'Inserting image capture timestamps changed observations.captured_at';
  END IF;
END
$$;

ROLLBACK;
