-- Focused validation for observation_images.sample_source and public RPC output.
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/sample_source_public_rpc_validation.sql

DO $$
DECLARE
  sample_user_id uuid := '00000000-0000-4000-8000-00000000a151';
  metadata_obs_id bigint;
  metadata_image_id bigint;
  legacy_obs_id bigint;
  legacy_image_id bigint;
  detail_row record;
  search_row record;
  comp_row record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'observation_images'
      AND column_name = 'sample_source'
      AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'observation_images.sample_source text column is missing';
  END IF;

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    sample_user_id,
    'authenticated',
    'authenticated',
    'sample-source-rpc@example.test',
    '{"full_name":"Sample Source Tester"}'::jsonb,
    now(),
    now()
  );

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES (sample_user_id, 'sample_source_rpc', 'Sample Source Tester', false)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code, spore_statistics
  )
  VALUES (
    sample_user_id, '2026-07-01', 'Sourcesplitus', 'metadataanchor',
    'public', false, 'public', 'hidden', 'NO',
    jsonb_build_object('n', 1, 'length_min_um', 8.5, 'length_max_um', 8.5)
  )
  RETURNING id INTO metadata_obs_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    sample_type, sample_source, mount_medium, contrast, stain
  )
  VALUES (
    metadata_obs_id, sample_user_id, NULL, 'microscope',
    'fresh', 'context', 'water', 'DIC', 'Congo Red'
  )
  RETURNING id INTO metadata_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (metadata_image_id, sample_user_id, 8.5, 4.2, 'manual');

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code
  )
  VALUES (
    sample_user_id, '2026-07-02', 'Legacyprintus', 'sampletype',
    'public', false, 'public', 'hidden', 'NO'
  )
  RETURNING id INTO legacy_obs_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    sample_type, sample_source, mount_medium, contrast
  )
  VALUES (
    legacy_obs_id, sample_user_id, 'sample-source/legacy.webp', 'microscope',
    'Spore print', NULL, 'water', 'brightfield'
  )
  RETURNING id INTO legacy_image_id;

  -- Same conservative rule as the migration: only rows with null/empty source
  -- and normalized legacy sample_type print values are moved.
  UPDATE public.observation_images
  SET
    sample_source = 'spore_print',
    sample_type = NULL
  WHERE nullif(btrim(sample_source), '') IS NULL
    AND lower(btrim(coalesce(sample_type, ''))) IN ('spore_print', 'spore print', 'print')
    AND id = legacy_image_id;

  IF (SELECT sample_type FROM public.observation_images WHERE id = legacy_image_id) IS NOT NULL
     OR (SELECT sample_source FROM public.observation_images WHERE id = legacy_image_id) IS DISTINCT FROM 'spore_print' THEN
    RAISE EXCEPTION 'legacy spore_print sample_type was not backfilled to sample_source';
  END IF;

  SELECT * INTO detail_row
  FROM public.get_public_observation(metadata_obs_id);

  IF detail_row."sampleType" IS DISTINCT FROM 'fresh'
     OR detail_row."sampleSource" IS DISTINCT FROM 'context'
     OR detail_row."mountReagent" IS DISTINCT FROM 'water'
     OR detail_row."contrastMethod" IS DISTINCT FROM 'DIC' THEN
    RAISE EXCEPTION 'metadata-only detail prep output mismatch: sampleType %, sampleSource %, mount %, contrast %',
      detail_row."sampleType", detail_row."sampleSource", detail_row."mountReagent", detail_row."contrastMethod";
  END IF;

  SELECT * INTO detail_row
  FROM public.get_public_observation(legacy_obs_id);

  IF detail_row."sampleType" IS NOT NULL
     OR detail_row."sampleSource" IS DISTINCT FROM 'spore_print' THEN
    RAISE EXCEPTION 'legacy detail output leaked sampleType or missed sampleSource: sampleType %, sampleSource %',
      detail_row."sampleType", detail_row."sampleSource";
  END IF;

  SELECT * INTO search_row
  FROM public.search_public_observations(p_genus := 'Sourcesplitus')
  WHERE id = metadata_obs_id;

  IF search_row."sampleType" IS DISTINCT FROM 'fresh'
     OR search_row."sampleSource" IS DISTINCT FROM 'context'
     OR search_row."stainReagent" IS DISTINCT FROM 'Congo Red' THEN
    RAISE EXCEPTION 'search output mismatch: sampleType %, sampleSource %, stain %',
      search_row."sampleType", search_row."sampleSource", search_row."stainReagent";
  END IF;

  SELECT * INTO comp_row
  FROM public.get_public_spore_comparison_set(NULL, 'Sourcesplitus');

  IF comp_row."observations" IS NULL
     OR jsonb_array_length(comp_row."observations") IS DISTINCT FROM 1
     OR (comp_row."observations"->0)->>'sampleType' IS DISTINCT FROM 'fresh'
     OR (comp_row."observations"->0)->>'sampleSource' IS DISTINCT FROM 'context'
     OR (comp_row."observations"->0)->>'mountReagent' IS DISTINCT FROM 'water'
     OR (comp_row."observations"->0)->>'contrastMethod' IS DISTINCT FROM 'DIC'
     OR (comp_row."observations"->0)->>'stainReagent' IS DISTINCT FROM 'Congo Red' THEN
    RAISE EXCEPTION 'comparison output did not expose expected prep/source metadata: %',
      comp_row."observations";
  END IF;

  DELETE FROM public.observations
  WHERE id IN (metadata_obs_id, legacy_obs_id);

  DELETE FROM public.profiles
  WHERE id = sample_user_id;

  DELETE FROM auth.users
  WHERE id = sample_user_id;
END
$$;
