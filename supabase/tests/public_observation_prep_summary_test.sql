-- Validation for the prepSummary JSON aggregate returned by
-- public.get_public_observation.
--
-- Covers:
--   * Multi-image aggregation returns the DISTINCT union of values.
--   * Not_set / not set / unknown values are filtered out.
--   * Metadata-only microscope anchors (storage_path IS NULL) contribute
--     just like image-backed rows if they carry measurements.
--   * Field images and microscope images without measurements are NOT
--     counted, even when they carry mount/contrast/etc. values.
--   * Empty results emit empty arrays, not NULLs (so the JSON shape is
--     stable regardless of how many contributors an observation has).
--   * The obs 631-shape fixture reproduces the acceptance target:
--     Fresh / Hymenium / KOH / DIC / Stain unknown → stains: [].
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/public_observation_prep_summary_test.sql

DO $$
DECLARE
  sample_user_id uuid := '00000000-0000-4000-8000-00000000c631';
  multi_obs_id bigint;
  meta_obs_id bigint;
  empty_obs_id bigint;
  metadata_image_id bigint;
  measurement_image_id bigint;
  field_image_id bigint;
  no_measure_image_id bigint;
  detail jsonb;
  arr jsonb;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    sample_user_id,
    'authenticated',
    'authenticated',
    'prep-summary-rpc@example.test',
    '{"full_name":"Prep Summary Tester"}'::jsonb,
    now(),
    now()
  );

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES (sample_user_id, 'prep_summary_rpc', 'Prep Summary Tester', false)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  -- Fixture 1: obs with three measurement-contributing microscope images
  -- covering DIFFERENT prep values on each row plus one row that includes
  -- Not_set values that must be filtered out. This is where the aggregate
  -- gets exercised: distinct union, sorted, no unset variants.
  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code, spore_statistics
  )
  VALUES (
    sample_user_id, '2026-07-14', 'Prepmulti', 'multi',
    'public', false, 'public', 'hidden', 'NO',
    jsonb_build_object('n', 3)
  )
  RETURNING id INTO multi_obs_id;

  -- Contributor A: DIC / KOH / Congo Red / Fresh / Hymenium
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    multi_obs_id, sample_user_id,
    concat(sample_user_id::text, '/prep-a.webp'),
    'microscope', 'DIC', 'KOH', 'Congo Red', 'Fresh', 'hymenium'
  )
  RETURNING id INTO measurement_image_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (measurement_image_id, sample_user_id, 12.0, 6.0, 'manual');

  -- Contributor B: BF / Water / Congo Red / Fresh / spore_print
  -- Adds a distinct contrast, mount, and sampleSource to the union.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    multi_obs_id, sample_user_id,
    concat(sample_user_id::text, '/prep-b.webp'),
    'microscope', 'BF', 'water', 'Congo Red', 'Fresh', 'spore_print'
  )
  RETURNING id INTO measurement_image_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (measurement_image_id, sample_user_id, 11.0, 5.5, 'manual');

  -- Contributor C: Not_set on every prep field. Must contribute nothing
  -- to the summary — every "Not_set" value must be filtered out.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    multi_obs_id, sample_user_id,
    concat(sample_user_id::text, '/prep-c.webp'),
    'microscope', 'Not_set', 'Not_set', 'Not_set', 'Not_set', 'Not_set'
  )
  RETURNING id INTO measurement_image_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (measurement_image_id, sample_user_id, 10.0, 5.0, 'manual');

  -- Non-contributor: FIELD image with all values populated. Must NOT
  -- appear in the summary — the field is not measurement-contributing.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    multi_obs_id, sample_user_id,
    concat(sample_user_id::text, '/prep-field.webp'),
    'field', 'phase', 'Melzer', 'Cotton Blue', 'Dried', 'stipe'
  )
  RETURNING id INTO field_image_id;

  -- Non-contributor: microscope image with prep values but NO measurements.
  -- Must NOT appear — measurement attachment is the qualifying condition.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    multi_obs_id, sample_user_id,
    concat(sample_user_id::text, '/prep-no-measure.webp'),
    'microscope', 'phase', 'Melzer', 'Cotton Blue', 'Dried', 'stipe'
  )
  RETURNING id INTO no_measure_image_id;

  -- Verify multi-image aggregation
  SELECT to_jsonb(r) INTO detail
  FROM public.get_public_observation(multi_obs_id) r;

  IF detail IS NULL THEN
    RAISE EXCEPTION 'multi-image obs did not return any row from get_public_observation';
  END IF;

  arr := detail->'prepSummary'->'contrasts';
  IF arr IS NULL OR arr <> jsonb_build_array('BF', 'DIC') THEN
    RAISE EXCEPTION 'multi-image contrasts mismatch: %', arr;
  END IF;

  arr := detail->'prepSummary'->'mounts';
  IF arr IS NULL OR arr <> jsonb_build_array('KOH', 'water') THEN
    RAISE EXCEPTION 'multi-image mounts mismatch: %', arr;
  END IF;

  arr := detail->'prepSummary'->'stains';
  IF arr IS NULL OR arr <> jsonb_build_array('Congo Red') THEN
    RAISE EXCEPTION 'multi-image stains mismatch: %', arr;
  END IF;

  arr := detail->'prepSummary'->'specimenConditions';
  IF arr IS NULL OR arr <> jsonb_build_array('fresh') THEN
    RAISE EXCEPTION 'multi-image specimenConditions mismatch: %', arr;
  END IF;

  arr := detail->'prepSummary'->'sampleSources';
  IF arr IS NULL OR arr <> jsonb_build_array('hymenium', 'spore_print') THEN
    RAISE EXCEPTION 'multi-image sampleSources mismatch: %', arr;
  END IF;

  -- Fixture 2: metadata-only microscope anchor (storage_path IS NULL)
  -- that carries the obs 631-shape values. It must contribute exactly
  -- as an image-backed row would.
  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code, spore_statistics
  )
  VALUES (
    sample_user_id, '2026-07-14', 'Panaeolina', 'foenisecii-fixture',
    'public', false, 'public', 'hidden', 'NO',
    jsonb_build_object('n', 1)
  )
  RETURNING id INTO meta_obs_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    meta_obs_id, sample_user_id, NULL, 'microscope',
    'DIC', 'KOH', 'Not_set', 'Fresh', 'hymenium'
  )
  RETURNING id INTO metadata_image_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (metadata_image_id, sample_user_id, 12.5, 6.2, 'manual');

  SELECT to_jsonb(r) INTO detail
  FROM public.get_public_observation(meta_obs_id) r;

  IF detail IS NULL THEN
    RAISE EXCEPTION 'metadata-only anchor obs returned no row';
  END IF;

  IF detail->'prepSummary'->'contrasts' <> jsonb_build_array('DIC') THEN
    RAISE EXCEPTION 'obs631-shape contrasts mismatch: %', detail->'prepSummary'->'contrasts';
  END IF;
  IF detail->'prepSummary'->'mounts' <> jsonb_build_array('KOH') THEN
    RAISE EXCEPTION 'obs631-shape mounts mismatch: %', detail->'prepSummary'->'mounts';
  END IF;
  -- stain was 'Not_set' → must be filtered out to an empty array
  IF detail->'prepSummary'->'stains' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'obs631-shape stains should be empty array (Not_set filtered), got %',
      detail->'prepSummary'->'stains';
  END IF;
  IF detail->'prepSummary'->'specimenConditions' <> jsonb_build_array('fresh') THEN
    RAISE EXCEPTION 'obs631-shape specimenConditions mismatch: %', detail->'prepSummary'->'specimenConditions';
  END IF;
  IF detail->'prepSummary'->'sampleSources' <> jsonb_build_array('hymenium') THEN
    RAISE EXCEPTION 'obs631-shape sampleSources mismatch: %', detail->'prepSummary'->'sampleSources';
  END IF;

  -- Fixture 3: obs with a field image only (no measurement-contributing
  -- microscope rows). prepSummary must contain all-empty arrays and
  -- MUST NOT be NULL — the frontend expects a stable object shape.
  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code
  )
  VALUES (
    sample_user_id, '2026-07-14', 'Prepempty', 'field-only',
    'public', false, 'public', 'hidden', 'NO'
  )
  RETURNING id INTO empty_obs_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    empty_obs_id, sample_user_id,
    concat(sample_user_id::text, '/empty-field.webp'),
    'field', 'DIC', 'KOH', 'Congo Red', 'Fresh', 'hymenium'
  );

  SELECT to_jsonb(r) INTO detail
  FROM public.get_public_observation(empty_obs_id) r;

  IF detail IS NULL THEN
    RAISE EXCEPTION 'field-only obs returned no row';
  END IF;

  IF detail->'prepSummary' IS NULL THEN
    RAISE EXCEPTION 'prepSummary must be an object even when no contributors';
  END IF;

  FOR arr IN
    SELECT jsonb_build_array('contrasts')
    UNION ALL SELECT jsonb_build_array('mounts')
    UNION ALL SELECT jsonb_build_array('stains')
    UNION ALL SELECT jsonb_build_array('specimenConditions')
    UNION ALL SELECT jsonb_build_array('sampleSources')
  LOOP
    IF (detail->'prepSummary'->>((arr->>0)))::text IS NULL THEN
      RAISE EXCEPTION 'prepSummary.% missing on field-only obs', arr->>0;
    END IF;
    IF detail->'prepSummary'->(arr->>0) <> '[]'::jsonb THEN
      RAISE EXCEPTION 'prepSummary.% should be empty on field-only obs, got %',
        arr->>0, detail->'prepSummary'->(arr->>0);
    END IF;
  END LOOP;

  DELETE FROM public.observations
  WHERE id IN (multi_obs_id, meta_obs_id, empty_obs_id);

  DELETE FROM public.profiles
  WHERE id = sample_user_id;

  DELETE FROM auth.users
  WHERE id = sample_user_id;
END
$$;
