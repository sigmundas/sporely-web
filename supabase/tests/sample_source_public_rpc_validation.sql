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
  dist_row record;
  facets jsonb;
  result_count integer;
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

  SELECT * INTO detail_row
  FROM public.get_public_observation(metadata_obs_id);

  IF detail_row."sampleType" IS DISTINCT FROM 'fresh'
     OR detail_row."sampleSource" IS DISTINCT FROM 'context'
     OR detail_row."mountReagent" IS DISTINCT FROM 'water'
     OR detail_row."contrastMethod" IS DISTINCT FROM 'DIC' THEN
    RAISE EXCEPTION 'metadata-only detail prep output mismatch: sampleType %, sampleSource %, mount %, contrast %',
      detail_row."sampleType", detail_row."sampleSource", detail_row."mountReagent", detail_row."contrastMethod";
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

  SELECT count(*) INTO result_count
  FROM public.search_public_observations(
    p_genus := 'Sourcesplitus',
    p_country := 'NO',
    p_sample_source := 'context'
  );
  IF result_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'composed search sample_source filter returned % rows', result_count;
  END IF;

  SELECT count(*) INTO result_count
  FROM public.search_public_observations(p_sample_source := 'spore_print')
  WHERE id = legacy_obs_id AND "sampleType" IS NULL AND "sampleSource" = 'spore_print';
  IF result_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'legacy sample_type print was not normalized as source in search';
  END IF;

  SELECT count(*) INTO result_count
  FROM public.search_public_observations(p_sample := 'spore_print');
  IF result_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'spore_print leaked into specimen-condition filtering';
  END IF;

  SELECT count(*) INTO result_count
  FROM public.get_public_map_points(p_genus := 'Sourcesplitus', p_sample_source := 'context')
  WHERE "observationId" = metadata_obs_id;
  IF result_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'map sample_source filter returned % expected rows', result_count;
  END IF;

  SELECT * INTO dist_row
  FROM public.get_public_species_distribution_summary(
    p_species_slug := 'sourcesplitus-metadataanchor',
    p_sample_source := 'context'
  );
  IF dist_row."observationCount" IS DISTINCT FROM 1
     OR coalesce((dist_row."sampleSourceFacets"->0)->>'value', '') IS DISTINCT FROM 'context' THEN
    RAISE EXCEPTION 'distribution sample_source output mismatch: count %, facets %',
      dist_row."observationCount", dist_row."sampleSourceFacets";
  END IF;

  SELECT * INTO comp_row
  FROM public.get_public_spore_comparison_set(
    p_genus := 'Sourcesplitus',
    p_sample_source := 'context'
  );

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

  facets := public.get_public_observation_facets();
  IF NOT (facets->'sampleSources' @> '[{"value":"context","label":"Context","count":1}]'::jsonb)
     OR NOT (facets->'sampleSources' @> '[{"value":"spore_print","label":"Spore print","count":1}]'::jsonb) THEN
    RAISE EXCEPTION 'sampleSources facets missing canonical/legacy values: %', facets->'sampleSources';
  END IF;
  IF facets->'sampleTypes' @> '[{"value":"spore_print"}]'::jsonb
     OR facets->'sampleTypes' @> '[{"value":"spore print"}]'::jsonb
     OR facets->'sampleTypes' @> '[{"value":"not_set"}]'::jsonb
     OR facets->'sampleSources' @> '[{"value":"not_set"}]'::jsonb THEN
    RAISE EXCEPTION 'invalid public prep facet leaked: types %, sources %',
      facets->'sampleTypes', facets->'sampleSources';
  END IF;

  DELETE FROM public.observations
  WHERE id IN (metadata_obs_id, legacy_obs_id);

  DELETE FROM public.profiles
  WHERE id = sample_user_id;

  DELETE FROM auth.users
  WHERE id = sample_user_id;
END
$$;
