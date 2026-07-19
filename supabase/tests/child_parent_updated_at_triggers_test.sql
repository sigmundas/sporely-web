-- Child-only cloud mutations must advance observations.updated_at so desktop
-- fast pull sees image and measurement changes.
--
-- The fixture runs as postgres, cleans up before/after, and raises on the first
-- failed assertion.

DO $$
DECLARE
  fixture_user constant uuid := '00000000-0000-0000-0000-00000000c019';
  old_timestamp constant timestamptz := '2000-01-01 00:00:00+00';
  parent_a bigint;
  parent_b bigint;
  image_a bigint;
  image_b bigint;
  measurement_a bigint;
  actual_timestamp timestamptz;
BEGIN
  DELETE FROM auth.users WHERE id = fixture_user;

  INSERT INTO auth.users (
    id, aud, role, email, raw_user_meta_data, created_at, updated_at
  ) VALUES (
    fixture_user,
    'authenticated',
    'authenticated',
    'child-parent-updated-at@example.invalid',
    '{}'::jsonb,
    now(),
    now()
  );
  INSERT INTO public.profiles (id, username)
  VALUES (fixture_user, 'child_parent_updated_at_test');

  INSERT INTO public.observations (
    user_id, date, visibility, location_precision, updated_at
  ) VALUES (
    fixture_user, current_date, 'public', 'exact', old_timestamp
  ) RETURNING id INTO parent_a;
  INSERT INTO public.observations (
    user_id, date, visibility, location_precision, updated_at
  ) VALUES (
    fixture_user, current_date, 'public', 'exact', old_timestamp
  ) RETURNING id INTO parent_b;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, notes
  ) VALUES (
    parent_a, fixture_user, 'trigger-test/image-a.jpg', 'field', 'insert'
  ) RETURNING id INTO image_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_a;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'image insert did not touch parent updated_at';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_a;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observation_images SET notes = 'metadata update' WHERE id = image_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_a;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'image metadata update did not touch parent updated_at';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_a;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observation_images SET deleted_at = now() WHERE id = image_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_a;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'image soft delete did not touch parent updated_at';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id IN (parent_a, parent_b);
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observation_images
  SET observation_id = parent_b, deleted_at = NULL
  WHERE id = image_a;
  IF EXISTS (
    SELECT 1 FROM public.observations
    WHERE id IN (parent_a, parent_b) AND updated_at <= old_timestamp
  ) THEN
    RAISE EXCEPTION 'moving image did not touch both old and new parents';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_b;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  DELETE FROM public.observation_images WHERE id = image_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_b;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'image hard delete did not touch parent updated_at';
  END IF;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, notes
  ) VALUES (
    parent_a, fixture_user, 'trigger-test/measurement-a.jpg', 'field', 'measurement parent A'
  ) RETURNING id INTO image_a;
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, notes
  ) VALUES (
    parent_b, fixture_user, 'trigger-test/measurement-b.jpg', 'field', 'measurement parent B'
  ) RETURNING id INTO image_b;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_a;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  INSERT INTO public.spore_measurements (
    image_id, user_id, length_um, width_um, notes
  ) VALUES (
    image_a, fixture_user, 10.0, 5.0, 'insert'
  ) RETURNING id INTO measurement_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_a;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'measurement insert did not touch parent updated_at';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_a;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.spore_measurements SET length_um = 11.0 WHERE id = measurement_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_a;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'measurement update did not touch parent updated_at';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id IN (parent_a, parent_b);
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.spore_measurements SET image_id = image_b WHERE id = measurement_a;
  IF EXISTS (
    SELECT 1 FROM public.observations
    WHERE id IN (parent_a, parent_b) AND updated_at <= old_timestamp
  ) THEN
    RAISE EXCEPTION 'moving measurement did not touch both old and new parents';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_b;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  DELETE FROM public.spore_measurements WHERE id = measurement_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_b;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'measurement delete did not touch parent updated_at';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_timestamp WHERE id = parent_a;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET notes = 'direct parent update' WHERE id = parent_a;
  SELECT updated_at INTO actual_timestamp FROM public.observations WHERE id = parent_a;
  IF actual_timestamp <= old_timestamp THEN
    RAISE EXCEPTION 'direct parent update trigger no longer advances updated_at';
  END IF;

  DELETE FROM auth.users WHERE id = fixture_user;
  RAISE NOTICE 'child_parent_updated_at_triggers_test: all assertions passed';
EXCEPTION
  WHEN OTHERS THEN
    DELETE FROM auth.users WHERE id = fixture_user;
    RAISE;
END;
$$;

