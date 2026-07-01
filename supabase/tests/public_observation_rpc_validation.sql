-- Manual validation fixture for the public explorer observation RPCs.
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/public_observation_rpc_validation.sql
--
-- The fixture cleans up its rows before returning. If an assertion fails, the
-- single DO statement aborts and rolls back its own changes.

DO $$
DECLARE
  visible_user_id uuid := '00000000-0000-4000-8000-000000000001';
  banned_user_id uuid := '00000000-0000-4000-8000-000000000002';
  public_exact_id bigint;
  private_id bigint;
  draft_id bigint;
  banned_id bigint;
  null_visibility_id bigint;
  null_spore_visibility_id bigint;
  hidden_location_id bigint;
  region_location_id bigint;
  null_precision_id bigint;
  fuzzed_id bigint;
  deleted_microscopy_id bigint;
  purged_microscopy_id bigint;
  public_image_id bigint;
  facets_public_id bigint;
  facets_image_id bigint;
  private_image_id bigint;
  draft_image_id bigint;
  null_spore_image_id bigint;
  deleted_image_id bigint;
  purged_image_id bigint;
  rpc_row record;
  facets jsonb;
  amanita_private_spore_id bigint;
  amanita_private_image_id bigint;
  amanita_se_id bigint;
  amanita_se_image_id bigint;
  spore_rpc record;
  amanita_koh_id bigint;
  amanita_koh_image_id bigint;
  comp_rpc record;
  mixed_prep_id bigint;
  mixed_fresh_image_id bigint;
  mixed_sp_image_id bigint;
  dist_rpc record;
  map_rpc record;
BEGIN
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility DROP NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision DROP NOT NULL';

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (visible_user_id, 'authenticated', 'authenticated', 'rpc-visible@example.test', '{"full_name":"Visible User"}'::jsonb, now(), now()),
    (banned_user_id, 'authenticated', 'authenticated', 'rpc-banned@example.test', '{"full_name":"Banned User"}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (visible_user_id, 'rpc_visible', 'Visible User', false),
    (banned_user_id, 'rpc_banned', 'Banned User', true)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  INSERT INTO public.public_regions (id, country_code, label, sort_order)
  VALUES ('rpc-test-region', 'NO', 'Test Region', 1);

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    common_name,
    visibility,
    is_draft,
    spore_data_visibility,
    spore_statistics,
    location_precision,
    location,
    country_code,
    region_id,
    gps_latitude,
    gps_longitude
  )
  VALUES (
    visible_user_id,
    '2026-06-01',
    'Amanita',
    'muscaria',
    'Fly agaric',
    'public',
    false,
    'public',
    jsonb_build_object(
      'n', 2,
      'length_min_um', 10.1,
      'length_max_um', 11.2,
      'width_min_um', 5.1,
      'width_max_um', 5.4,
      'q_min', 1.98,
      'q_max', 2.2,
      'q_mean', 2.09
    ),
    'exact',
    'Exact Test Site',
    'NO',
    'rpc-test-region',
    59.9273,
    10.7779
  )
  RETURNING id INTO public_exact_id;

  INSERT INTO public.observation_images (
    observation_id,
    user_id,
    storage_path,
    image_type,
    sort_order,
    source_width,
    source_height,
    stored_width,
    stored_height,
    contrast,
    mount_medium,
    sample_type
  )
  VALUES (
    public_exact_id,
    visible_user_id,
    'rpc/public-exact.webp',
    'microscope',
    0,
    4000,
    3000,
    800,
    600,
    'brightfield',
    'water',
    'Fresh'
  )
  RETURNING id INTO public_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES
    (public_image_id, visible_user_id, 10.1, 5.1, 'manual'),
    (public_image_id, visible_user_id, 11.2, 5.4, 'spore');

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    common_name,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    country_code,
    region_id
  )
  VALUES (
    visible_user_id,
    '2026-06-02',
    'Hiddenus',
    'occultus',
    'Hidden mushroom',
    'private',
    false,
    'public',
    'exact',
    'NO',
    'rpc-test-region'
  )
  RETURNING id INTO private_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (private_id, visible_user_id, 'rpc/private.webp', 'field')
  RETURNING id INTO private_image_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    common_name,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    country_code,
    region_id
  )
  VALUES (
    visible_user_id,
    '2026-06-03',
    'Hiddenus',
    'occultus',
    'Hidden mushroom',
    'public',
    true,
    'public',
    'exact',
    'NO',
    'rpc-test-region'
  )
  RETURNING id INTO draft_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (draft_id, visible_user_id, 'rpc/draft.webp', 'field')
  RETURNING id INTO draft_image_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    common_name,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    country_code,
    region_id
  )
  VALUES (
    banned_user_id,
    '2026-06-04',
    'Hiddenus',
    'occultus',
    'Hidden mushroom',
    'public',
    false,
    'public',
    'exact',
    'NO',
    'rpc-test-region'
  )
  RETURNING id INTO banned_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    common_name,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    country_code,
    region_id
  )
  VALUES (
    visible_user_id,
    '2026-06-05',
    'Hiddenus',
    'occultus',
    'Hidden mushroom',
    NULL,
    false,
    'public',
    'exact',
    'NO',
    'rpc-test-region'
  )
  RETURNING id INTO null_visibility_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    common_name,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    location,
    country_code,
    region_id
  )
  VALUES (
    visible_user_id,
    '2026-06-05',
    'Boletus',
    'edulis',
    'Porcini',
    'public',
    false,
    'public',
    'exact',
    'Porcini Site',
    'NO',
    'rpc-test-region'
  )
  RETURNING id INTO facets_public_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    visibility,
    is_draft,
    spore_data_visibility,
    spore_statistics,
    location_precision
  )
  VALUES (
    visible_user_id,
    '2026-06-06',
    'Nullspore',
    'counted',
    'public',
    false,
    NULL,
    jsonb_build_object(
      'n', 1,
      'length_min_um', 9.0,
      'length_max_um', 9.8,
      'width_min_um', 4.1,
      'width_max_um', 4.4
    ),
    'exact'
  )
  RETURNING id INTO null_spore_visibility_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (null_spore_visibility_id, visible_user_id, 'rpc/null-spore.webp', 'microscope')
  RETURNING id INTO null_spore_image_id;

  INSERT INTO public.observation_images (
    observation_id,
    user_id,
    storage_path,
    image_type,
    sort_order,
    source_width,
    source_height,
    stored_width,
    stored_height,
    contrast,
    mount_medium,
    sample_type
  )
  VALUES (
    facets_public_id,
    visible_user_id,
    'rpc/facets-public.webp',
    'microscope',
    0,
    2400,
    1800,
    1200,
    900,
    'DIC',
    'KOH',
    'DRIED'
  )
  RETURNING id INTO facets_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (null_spore_image_id, visible_user_id, 12.0, 6.0, 'manual');

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    country_code,
    region_id,
    gps_latitude,
    gps_longitude
  )
  VALUES (
    visible_user_id,
    '2026-06-07',
    'Fuzzed',
    'location',
    'public',
    false,
    'public',
    'fuzzed',
    'NO',
    'rpc-test-region',
    59.1234,
    10.5678
  )
  RETURNING id INTO fuzzed_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    location
  )
  VALUES (visible_user_id, '2026-06-08', 'Hidden', 'location', 'public', false, 'public', 'hidden', 'Private Hidden Site')
  RETURNING id INTO hidden_location_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision,
    location,
    country_code,
    region_id
  )
  VALUES (
    visible_user_id,
    '2026-06-08',
    'Region',
    'location',
    'public',
    false,
    'public',
    'region',
    'Raw Region Location',
    'NO',
    'rpc-test-region'
  )
  RETURNING id INTO region_location_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision, location)
  VALUES (visible_user_id, '2026-06-09', 'Nullprecision', 'hidden', 'public', false, 'public', NULL, 'Null Precision Site')
  RETURNING id INTO null_precision_id;

  INSERT INTO public.observations (
    user_id,
    date,
    genus,
    species,
    visibility,
    is_draft,
    spore_data_visibility,
    location_precision
  )
  VALUES (visible_user_id, '2026-06-09', 'Deleted', 'image', 'public', false, 'public', 'exact')
  RETURNING id INTO deleted_microscopy_id;

  INSERT INTO public.observation_images (
    observation_id,
    user_id,
    storage_path,
    image_type,
    deleted_at
  )
  VALUES (
    deleted_microscopy_id,
    visible_user_id,
    'rpc/deleted.webp',
    'microscope',
    now()
  )
  RETURNING id INTO deleted_image_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (visible_user_id, '2026-06-10', 'Purged', 'microscopy', 'public', false, 'public', 'exact')
  RETURNING id INTO purged_microscopy_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, purged_at)
  VALUES (purged_microscopy_id, visible_user_id, 'rpc/purged.webp', 'microscope', now())
  RETURNING id INTO purged_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (purged_image_id, visible_user_id, 9.0, 4.0, 'manual');

  -- Amanita muscaria, private spore visibility — counts in observationCount but excluded
  -- from spore aggregate and from the observations array.
  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code, region_id
  )
  VALUES (
    visible_user_id, '2026-06-15', 'Amanita', 'muscaria',
    'public', false, 'private', 'exact', 'NO', 'rpc-test-region'
  )
  RETURNING id INTO amanita_private_spore_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (amanita_private_spore_id, visible_user_id, 'rpc/amanita-priv.webp', 'microscope')
  RETURNING id INTO amanita_private_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (amanita_private_image_id, visible_user_id, 8.0, 4.0, 'manual');

  -- Amanita muscaria in Sweden, public spore data — second spore observation, distinct country.
  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code
  )
  VALUES (
    visible_user_id, '2026-06-20', 'Amanita', 'muscaria',
    'public', false, 'public', 'exact', 'SE'
  )
  RETURNING id INTO amanita_se_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (amanita_se_id, visible_user_id, 'rpc/amanita-se.webp', 'microscope')
  RETURNING id INTO amanita_se_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (amanita_se_image_id, visible_user_id, 9.0, 4.5, 'manual');

  -- Amanita muscaria in Norway, DIC/KOH/fresh — for get_public_spore_comparison_set tests.
  INSERT INTO public.observations (
    user_id, date, genus, species, common_name, visibility, is_draft, spore_data_visibility,
    location_precision, country_code, region_id
  )
  VALUES (
    visible_user_id, '2026-06-25', 'Amanita', 'muscaria', 'Fly agaric',
    'public', false, 'public', 'exact', 'NO', 'rpc-test-region'
  )
  RETURNING id INTO amanita_koh_id;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, contrast, mount_medium, sample_type
  )
  VALUES (
    amanita_koh_id, visible_user_id, 'rpc/amanita-koh.webp', 'microscope', 'DIC', 'KOH', 'fresh'
  )
  RETURNING id INTO amanita_koh_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (amanita_koh_image_id, visible_user_id, 12.0, 6.0, 'manual');

  -- Leucopholiota americana in Sweden: two microscopy images with different
  -- preparations (fresh + spore_print). Image B (spore_print) is inserted last
  -- so it has a higher id — the "latest image" heuristic would pick spore_print.
  -- This observation is in country SE with no region, so it does not interfere
  -- with existing Amanita Norway/region facet assertions.
  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code
  )
  VALUES (
    visible_user_id, '2026-06-27', 'Leucopholiota', 'americana',
    'public', false, 'public', 'exact', 'SE'
  )
  RETURNING id INTO mixed_prep_id;

  -- Image A: fresh preparation (inserted first → lower id).
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, sample_type
  )
  VALUES (
    mixed_prep_id, visible_user_id, 'rpc/mixed-fresh.webp', 'microscope', 'fresh'
  )
  RETURNING id INTO mixed_fresh_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES
    (mixed_fresh_image_id, visible_user_id, 10.0, 5.0, 'manual'),
    (mixed_fresh_image_id, visible_user_id, 11.0, 5.5, 'manual');

  -- Image B: spore_print preparation (inserted second → higher id, "latest").
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, sample_type
  )
  VALUES (
    mixed_prep_id, visible_user_id, 'rpc/mixed-sp.webp', 'microscope', 'spore_print'
  )
  RETURNING id INTO mixed_sp_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES
    (mixed_sp_image_id, visible_user_id, 12.0, 6.0, 'manual'),
    (mixed_sp_image_id, visible_user_id, 13.0, 6.5, 'manual'),
    (mixed_sp_image_id, visible_user_id, 14.0, 7.0, 'manual');

  IF NOT EXISTS (SELECT 1 FROM public.search_public_observations() WHERE id = public_exact_id) THEN
    RAISE EXCEPTION 'Expected public observation % to appear', public_exact_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.search_public_observations() WHERE id IN (private_id, draft_id, banned_id, null_visibility_id)) THEN
    RAISE EXCEPTION 'Private, draft, banned, or null-visibility observations leaked into public search';
  END IF;

  SELECT * INTO rpc_row FROM public.search_public_observations() WHERE id = public_exact_id;
  IF rpc_row."sporeSummary" IS DISTINCT FROM jsonb_build_object(
    'n', 2,
    'length_min_um', 10.1,
    'length_max_um', 11.2,
    'width_min_um', 5.1,
    'width_max_um', 5.4,
    'q_min', 1.98,
    'q_max', 2.2,
    'q_mean', 2.09
  ) THEN
    RAISE EXCEPTION 'Public search did not expose the observation spore summary';
  END IF;

  SELECT * INTO rpc_row FROM public.search_public_observations() WHERE id = null_spore_visibility_id;
  IF rpc_row."sporeSummary" IS NOT NULL THEN
    RAISE EXCEPTION 'Null spore_data_visibility leaked a private summary through search';
  END IF;

  IF (SELECT count(*) FROM public.get_public_observation_images(public_exact_id)) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected exactly one public image for observation %', public_exact_id;
  END IF;

  IF (SELECT count(*) FROM public.search_public_observation_images(ARRAY[public_exact_id, private_id, draft_id, deleted_microscopy_id, purged_microscopy_id])) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Public image search leaked private, draft, deleted, or purged images';
  END IF;

  IF EXISTS (SELECT 1 FROM public.get_public_observation_images(private_id))
     OR EXISTS (SELECT 1 FROM public.get_public_observation_images(draft_id))
     OR EXISTS (SELECT 1 FROM public.get_public_observation_images(deleted_microscopy_id))
     OR EXISTS (SELECT 1 FROM public.get_public_observation_images(purged_microscopy_id)) THEN
    RAISE EXCEPTION 'Private, draft, deleted, or purged observation images leaked into public read surface';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(public_exact_id);
  IF rpc_row.id IS DISTINCT FROM public_exact_id
     OR rpc_row."locationLabel" IS DISTINCT FROM 'Exact Test Site'
     OR rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2
     OR rpc_row."sporeSummary" IS DISTINCT FROM jsonb_build_object(
       'n', 2,
       'length_min_um', 10.1,
       'length_max_um', 11.2,
       'width_min_um', 5.1,
       'width_max_um', 5.4,
       'q_min', 1.98,
       'q_max', 2.2,
       'q_mean', 2.09
     )
     OR rpc_row."contrastMethod" IS DISTINCT FROM 'brightfield'
     OR rpc_row."mountReagent" IS DISTINCT FROM 'water'
     OR rpc_row."sampleType" IS DISTINCT FROM 'fresh' THEN
    RAISE EXCEPTION 'Public detail projection did not match expected safe fields';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation_images(public_exact_id) LIMIT 1;
  IF rpc_row."observationId" IS DISTINCT FROM public_exact_id
     OR rpc_row."imageId" IS DISTINCT FROM public_image_id
     OR rpc_row."sortOrder" IS DISTINCT FROM 0
     OR rpc_row."imageType" IS DISTINCT FROM 'microscope'
     OR rpc_row."width" IS DISTINCT FROM 800
     OR rpc_row."height" IS DISTINCT FROM 600
     OR rpc_row."thumbUrl" IS DISTINCT FROM 'https://media.sporely.no/rpc/thumb_public-exact.webp'
     OR rpc_row."previewUrl" IS DISTINCT FROM 'https://media.sporely.no/rpc/thumb_public-exact.webp' THEN
    RAISE EXCEPTION 'Public image projection did not match expected safe fields';
  END IF;

  IF to_jsonb(rpc_row) ? 'storage_path'
     OR to_jsonb(rpc_row) ? 'original_storage_path'
     OR to_jsonb(rpc_row) ? 'desktop_id'
     OR to_jsonb(rpc_row) ? 'source_width'
     OR to_jsonb(rpc_row) ? 'stored_width' THEN
    RAISE EXCEPTION 'Public image projection leaked raw storage or internal fields';
  END IF;

  SELECT public.get_public_observation_facets() INTO facets;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'genera', '[]'::jsonb)) AS g(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'Amanita'
      AND label = 'Amanita'
      AND "count" = 4
  ) THEN
    RAISE EXCEPTION 'Expected Amanita genus facet with count 4';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'genera', '[]'::jsonb)) AS g(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'Boletus'
      AND label = 'Boletus'
      AND "count" = 1
  ) THEN
    RAISE EXCEPTION 'Expected Boletus genus facet with count 1';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'species', '[]'::jsonb)) AS s(
      value text,
      label text,
      genus text,
      species text,
      "speciesName" text,
      "commonName" text,
      "count" bigint
    )
    WHERE value = 'Amanita muscaria'
      AND label = 'Amanita muscaria'
      AND genus = 'Amanita'
      AND species = 'muscaria'
      AND "speciesName" = 'Amanita muscaria'
      AND "commonName" = 'Fly agaric'
      AND "count" = 4
  ) THEN
    RAISE EXCEPTION 'Expected Amanita muscaria species facet with safe common name';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'species', '[]'::jsonb)) AS s(
      value text,
      label text,
      genus text,
      species text,
      "speciesName" text,
      "commonName" text,
      "count" bigint
    )
    WHERE value = 'Boletus edulis'
      AND label = 'Boletus edulis'
      AND genus = 'Boletus'
      AND species = 'edulis'
      AND "speciesName" = 'Boletus edulis'
      AND "commonName" = 'Porcini'
      AND "count" = 1
  ) THEN
    RAISE EXCEPTION 'Expected Boletus edulis species facet with safe common name';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'countries', '[]'::jsonb)) AS c(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'NO'
      AND label = 'Norway'
      AND "count" = 6
  ) THEN
    RAISE EXCEPTION 'Expected Norway country facet with count 6';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'regions', '[]'::jsonb)) AS r(
      value text,
      label text,
      "countryCode" text,
      "count" bigint
    )
    WHERE value = 'rpc-test-region'
      AND label = 'Test Region'
      AND "countryCode" = 'NO'
      AND "count" = 6
  ) THEN
    RAISE EXCEPTION 'Expected rpc-test-region facet with count 6';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'sampleTypes', '[]'::jsonb)) AS s(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'fresh'
      AND label = 'Fresh'
      AND "count" = 2
  ) THEN
    RAISE EXCEPTION 'Expected normalized fresh sampleType facet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'sampleTypes', '[]'::jsonb)) AS s(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'dried'
      AND label = 'Dried'
      AND "count" = 1
  ) THEN
    RAISE EXCEPTION 'Expected normalized dried sampleType facet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'contrastMethods', '[]'::jsonb)) AS c(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'brightfield'
      AND label = 'Brightfield'
      AND "count" = 1
  ) THEN
    RAISE EXCEPTION 'Expected brightfield contrast facet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'contrastMethods', '[]'::jsonb)) AS c(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'DIC'
      AND label = 'DIC'
      AND "count" = 2
  ) THEN
    RAISE EXCEPTION 'Expected DIC contrast facet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'mountReagents', '[]'::jsonb)) AS m(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'water'
      AND label = 'Water'
      AND "count" = 1
  ) THEN
    RAISE EXCEPTION 'Expected water mount facet';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(facets->'mountReagents', '[]'::jsonb)) AS m(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'KOH'
      AND label = 'KOH'
      AND "count" = 2
  ) THEN
    RAISE EXCEPTION 'Expected KOH mount facet';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(null_spore_visibility_id);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Null spore_data_visibility leaked a private spore count';
  END IF;
  IF rpc_row."sporeSummary" IS NOT NULL THEN
    RAISE EXCEPTION 'Null spore_data_visibility leaked a private spore summary';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(hidden_location_id);
  IF rpc_row."locationLabel" IS NOT NULL THEN
    RAISE EXCEPTION 'Hidden location returned a location label';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(region_location_id);
  IF rpc_row."locationLabel" IS DISTINCT FROM 'Test Region'
     OR rpc_row."locationLabel" = 'Raw Region Location' THEN
    RAISE EXCEPTION 'Region location did not return only the region-safe label';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(null_precision_id);
  IF rpc_row."locationPrecision" IS DISTINCT FROM 'hidden'
     OR rpc_row."locationLabel" IS NOT NULL THEN
    RAISE EXCEPTION 'Null location_precision did not default to hidden safely';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(purged_microscopy_id);
  IF rpc_row."hasMicroscopy" IS DISTINCT FROM false
     OR rpc_row."sporeMeasurementCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Purged microscopy contributed to public microscopy or spore signals';
  END IF;

  -- Map point: exact precision returns raw GPS coordinates.
  SELECT * INTO rpc_row FROM public.get_public_observation(public_exact_id);
  IF rpc_row."mapLat" IS DISTINCT FROM 59.9273
     OR rpc_row."mapLon" IS DISTINCT FROM 10.7779 THEN
    RAISE EXCEPTION 'Exact observation did not return raw GPS coordinates in mapLat/mapLon';
  END IF;

  -- Map point: fuzzed precision returns coordinates rounded to 2 decimal places.
  SELECT * INTO rpc_row FROM public.get_public_observation(fuzzed_id);
  IF rpc_row."mapLat" IS DISTINCT FROM round(59.1234::numeric, 2)::double precision
     OR rpc_row."mapLon" IS DISTINCT FROM round(10.5678::numeric, 2)::double precision THEN
    RAISE EXCEPTION 'Fuzzed observation did not return rounded coordinates in mapLat/mapLon (got % / %)',
      rpc_row."mapLat", rpc_row."mapLon";
  END IF;
  IF rpc_row."mapLat" IS NULL OR rpc_row."mapLon" IS NULL THEN
    RAISE EXCEPTION 'Fuzzed observation returned null mapLat/mapLon';
  END IF;

  -- Map point: hidden precision must return null coordinates.
  SELECT * INTO rpc_row FROM public.get_public_observation(hidden_location_id);
  IF rpc_row."mapLat" IS NOT NULL OR rpc_row."mapLon" IS NOT NULL THEN
    RAISE EXCEPTION 'Hidden-precision observation leaked coordinates through mapLat/mapLon';
  END IF;

  -- Map point: region precision must return null coordinates.
  SELECT * INTO rpc_row FROM public.get_public_observation(region_location_id);
  IF rpc_row."mapLat" IS NOT NULL OR rpc_row."mapLon" IS NOT NULL THEN
    RAISE EXCEPTION 'Region-precision observation leaked coordinates through mapLat/mapLon';
  END IF;

  -- Spore summary still works after RPC shape change.
  SELECT * INTO rpc_row FROM public.get_public_observation(public_exact_id);
  IF rpc_row."sporeSummary" IS DISTINCT FROM jsonb_build_object(
    'n', 2,
    'length_min_um', 10.1,
    'length_max_um', 11.2,
    'width_min_um', 5.1,
    'width_max_um', 5.4,
    'q_min', 1.98,
    'q_max', 2.2,
    'q_mean', 2.09
  ) THEN
    RAISE EXCEPTION 'Spore summary broken after RPC shape change';
  END IF;

  -- ── sporePoints regression tests (fix_public_observation_spore_point_q) ──────

  -- Public observation with public spore data returns sporePoints.
  SELECT * INTO rpc_row FROM public.get_public_observation(public_exact_id);

  IF rpc_row."sporePoints" IS NULL THEN
    RAISE EXCEPTION 'sporePoints: expected non-null for public observation with public spore data';
  END IF;

  -- Fixture has 2 measurements for public_exact_id.
  IF jsonb_array_length(rpc_row."sporePoints") IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'sporePoints: expected 2 points, got %', jsonb_array_length(rpc_row."sporePoints");
  END IF;

  -- Each point must contain all required keys.
  IF NOT (
    (rpc_row."sporePoints"->0) ? 'id'
    AND (rpc_row."sporePoints"->0) ? 'observationId'
    AND (rpc_row."sporePoints"->0) ? 'imageId'
    AND (rpc_row."sporePoints"->0) ? 'lengthUm'
    AND (rpc_row."sporePoints"->0) ? 'widthUm'
    AND (rpc_row."sporePoints"->0) ? 'q'
  ) THEN
    RAISE EXCEPTION 'sporePoints: point missing required keys (id, observationId, imageId, lengthUm, widthUm, q)';
  END IF;

  -- observationId must equal the observation.
  IF (rpc_row."sporePoints"->0)->>'observationId' IS DISTINCT FROM public_exact_id::text THEN
    RAISE EXCEPTION 'sporePoints: observationId mismatch, expected % got %',
      public_exact_id, (rpc_row."sporePoints"->0)->>'observationId';
  END IF;

  -- imageId must equal the microscope image inserted for public_exact_id.
  IF (rpc_row."sporePoints"->0)->>'imageId' IS DISTINCT FROM public_image_id::text THEN
    RAISE EXCEPTION 'sporePoints: imageId mismatch, expected % got %',
      public_image_id, (rpc_row."sporePoints"->0)->>'imageId';
  END IF;

  -- q = lengthUm / widthUm (rounded to 4 dp), and must be > 1 for normal spores.
  -- Fixture points: (10.1, 5.1) and (11.2, 5.4); both have length > width so q > 1.
  IF NOT (
    SELECT bool_and(
      abs(
        (pt->>'q')::double precision
        - round(((pt->>'lengthUm')::double precision / (pt->>'widthUm')::double precision)::numeric, 4)::double precision
      ) < 0.0002
      AND (pt->>'q')::double precision > 1
    )
    FROM jsonb_array_elements(rpc_row."sporePoints") pt
    WHERE (pt->>'widthUm')::double precision > 0
  ) THEN
    RAISE EXCEPTION 'sporePoints: q is not length/width (rounded to 4dp) or not > 1 for all points';
  END IF;

  -- Null spore_data_visibility must not expose sporePoints.
  SELECT * INTO rpc_row FROM public.get_public_observation(null_spore_visibility_id);
  IF rpc_row."sporePoints" IS NOT NULL THEN
    RAISE EXCEPTION 'sporePoints: null spore_data_visibility leaked sporePoints';
  END IF;

  -- Private spore_data_visibility must not expose sporePoints.
  SELECT * INTO rpc_row FROM public.get_public_observation(amanita_private_spore_id);
  IF rpc_row."sporePoints" IS NOT NULL THEN
    RAISE EXCEPTION 'sporePoints: private spore_data_visibility leaked sporePoints';
  END IF;

  -- Deleted microscope images must not contribute points.
  SELECT * INTO rpc_row FROM public.get_public_observation(deleted_microscopy_id);
  IF rpc_row."sporePoints" IS NOT NULL THEN
    RAISE EXCEPTION 'sporePoints: deleted microscope image contributed points';
  END IF;

  -- Purged microscope images must not contribute points.
  -- (purged_microscopy_id has a real measurement on its purged image)
  SELECT * INTO rpc_row FROM public.get_public_observation(purged_microscopy_id);
  IF rpc_row."sporePoints" IS NOT NULL THEN
    RAISE EXCEPTION 'sporePoints: purged microscope image contributed points';
  END IF;

  -- ─────────────────────────────────────────────────────────────────────────────

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species() s
    WHERE s."speciesSlug" = 'amanita-muscaria'
      AND s.genus = 'Amanita'
      AND s.species = 'muscaria'
      AND s."speciesName" = 'Amanita muscaria'
      AND s."commonName" = 'Fly agaric'
      AND s."observationCount" = 4
      AND s."microscopyObservationCount" = 4
      AND s."sporeMeasurementCount" = 4
      AND s."firstObservedOn" = DATE '2026-06-01'
      AND s."lastObservedOn" = DATE '2026-06-25'
      AND s."representativeThumbUrl" = 'https://media.sporely.no/rpc/thumb_amanita-koh.webp'
  ) THEN
    RAISE EXCEPTION 'Expected public species summary for Amanita muscaria';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species() s
    WHERE s."speciesSlug" = 'nullspore-counted'
      AND s."observationCount" = 1
      AND s."microscopyObservationCount" = 1
      AND s."sporeMeasurementCount" = 0
  ) THEN
    RAISE EXCEPTION 'Expected null spore visibility to suppress species spore counts';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species() s
    WHERE s."speciesSlug" = 'deleted-image'
      AND s."observationCount" = 1
      AND s."microscopyObservationCount" = 0
      AND s."representativeThumbUrl" IS NULL
  ) THEN
    RAISE EXCEPTION 'Expected deleted microscope images to be excluded from representative thumbnails';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species() s
    WHERE s."speciesSlug" = 'purged-microscopy'
      AND s."observationCount" = 1
      AND s."microscopyObservationCount" = 0
      AND s."representativeThumbUrl" IS NULL
  ) THEN
    RAISE EXCEPTION 'Expected purged microscope images to be excluded from representative thumbnails';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.search_public_species()
    WHERE "speciesSlug" = 'hiddenus-occultus'
  ) THEN
    RAISE EXCEPTION 'Hidden-only species leaked into public species search';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species() s
    CROSS JOIN LATERAL jsonb_to_recordset(coalesce(s.countries, '[]'::jsonb)) AS c(
      value text,
      label text,
      "count" bigint
    )
    WHERE s."speciesSlug" = 'amanita-muscaria'
      AND c.value = 'NO'
      AND c.label = 'Norway'
      AND c."count" = 3
  ) THEN
    RAISE EXCEPTION 'Expected Amanita muscaria country summary to include Norway with count 3';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species() s
    CROSS JOIN LATERAL jsonb_to_recordset(coalesce(s.regions, '[]'::jsonb)) AS r(
      value text,
      label text,
      "countryCode" text,
      "count" bigint
    )
    WHERE s."speciesSlug" = 'amanita-muscaria'
      AND r.value = 'rpc-test-region'
      AND r.label = 'Test Region'
      AND r."countryCode" = 'NO'
      AND r."count" = 3
  ) THEN
    RAISE EXCEPTION 'Expected Amanita muscaria region summary to include rpc-test-region with count 3';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_species('amanita-muscaria');
  -- observationCount now 3: public_exact_id + amanita_private_spore_id + amanita_se_id.
  -- sporeMeasurementCount now 5: 2 (public_exact_id) + 1 (amanita_private_spore_id) + 1 (amanita_se_id) + 1 (purged, but purged images are excluded) = actually:
  -- public_exact_id=2 (public), amanita_private_spore_id=1 (private → 0 counted), amanita_se_id=1 (public) = 3.
  IF rpc_row."speciesSlug" IS DISTINCT FROM 'amanita-muscaria'
     OR rpc_row."observationCount" IS DISTINCT FROM 4
     OR rpc_row."microscopyObservationCount" IS DISTINCT FROM 4
     OR rpc_row."sporeMeasurementCount" IS DISTINCT FROM 4
     OR rpc_row."firstObservedOn" IS DISTINCT FROM DATE '2026-06-01'
     OR rpc_row."lastObservedOn" IS DISTINCT FROM DATE '2026-06-25'
     OR rpc_row."representativeThumbUrl" IS DISTINCT FROM 'https://media.sporely.no/rpc/thumb_amanita-koh.webp' THEN
    RAISE EXCEPTION 'Public species detail projection did not match expected safe fields';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(rpc_row.countries, '[]'::jsonb)) AS c(
      value text,
      label text,
      "count" bigint
    )
    WHERE value = 'NO'
      AND label = 'Norway'
      AND "count" = 3
  ) THEN
    RAISE EXCEPTION 'Public species detail did not include the expected country summary';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(coalesce(rpc_row.regions, '[]'::jsonb)) AS r(
      value text,
      label text,
      "countryCode" text,
      "count" bigint
    )
    WHERE value = 'rpc-test-region'
      AND label = 'Test Region'
      AND "countryCode" = 'NO'
      AND "count" = 3
  ) THEN
    RAISE EXCEPTION 'Public species detail did not include the expected region summary';
  END IF;

  -- ── get_public_species_spore_summary ──────────────────────────────────────

  -- Unfiltered: all three Amanita muscaria observations (NO×2, SE×1).
  SELECT * INTO spore_rpc FROM public.get_public_species_spore_summary('amanita-muscaria');

  IF spore_rpc."speciesSlug" IS DISTINCT FROM 'amanita-muscaria' THEN
    RAISE EXCEPTION 'speciesSlug mismatch in spore summary';
  END IF;

  -- observationCount includes all 4 visible Amanita observations.
  IF spore_rpc."observationCount" IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Expected observationCount=4, got %', spore_rpc."observationCount";
  END IF;

  -- sporeObservationCount excludes the private-spore observation.
  IF spore_rpc."sporeObservationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Expected sporeObservationCount=3 (private excluded), got %', spore_rpc."sporeObservationCount";
  END IF;

  -- sporeMeasurementCount: 2 (public_exact_id) + 1 (amanita_se_id) + 1 (amanita_koh_id) = 4.
  IF spore_rpc."sporeMeasurementCount" IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Expected sporeMeasurementCount=4, got %', spore_rpc."sporeMeasurementCount";
  END IF;

  -- Aggregate min/max from raw measurements (amanita_private_spore excluded).
  IF (spore_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 9.0
     OR (spore_rpc."sporeSummary"->>'length_max_um')::double precision IS DISTINCT FROM 12.0 THEN
    RAISE EXCEPTION 'Expected length 9.0–12.0 µm from raw measurements, got %–%',
      spore_rpc."sporeSummary"->>'length_min_um',
      spore_rpc."sporeSummary"->>'length_max_um';
  END IF;

  IF (spore_rpc."sporeSummary"->>'width_min_um')::double precision IS DISTINCT FROM 4.5
     OR (spore_rpc."sporeSummary"->>'width_max_um')::double precision IS DISTINCT FROM 6.0 THEN
    RAISE EXCEPTION 'Expected width 4.5–6.0 µm, got %–%',
      spore_rpc."sporeSummary"->>'width_min_um',
      spore_rpc."sporeSummary"->>'width_max_um';
  END IF;

  -- n = 4 raw measurements (2 from NO public obs + 1 from SE + 1 from amanita_koh_id).
  IF (spore_rpc."sporeSummary"->>'n')::bigint IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Expected aggregate n=4, got %', spore_rpc."sporeSummary"->>'n';
  END IF;

  -- observations array: 3 entries (private-spore obs excluded).
  IF jsonb_array_length(spore_rpc."observations") IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Expected 3 observation rows, got %', jsonb_array_length(spore_rpc."observations");
  END IF;

  -- Private-spore observation must not appear in the observations array.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(spore_rpc."observations") AS obs
    WHERE (obs->>'observationId')::bigint = amanita_private_spore_id
  ) THEN
    RAISE EXCEPTION 'Private spore observation leaked into observations array';
  END IF;

  -- Each observation row must have lengthMeanUm.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(spore_rpc."observations") AS obs
    WHERE obs->>'lengthMeanUm' IS NULL
  ) THEN
    RAISE EXCEPTION 'observation row missing lengthMeanUm';
  END IF;

  -- Country filter NO: 3 observations (public_exact_id + amanita_private_spore_id + amanita_koh_id).
  SELECT * INTO spore_rpc FROM public.get_public_species_spore_summary('amanita-muscaria', 'NO');

  IF spore_rpc."observationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Expected observationCount=3 for NO, got %', spore_rpc."observationCount";
  END IF;

  -- public_exact_id and amanita_koh_id have public spore data in NO (private excluded).
  IF spore_rpc."sporeObservationCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Expected sporeObservationCount=2 for NO, got %', spore_rpc."sporeObservationCount";
  END IF;

  -- NO aggregate uses public_exact_id + amanita_koh_id: length 10.1–12.0.
  IF (spore_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 10.1
     OR (spore_rpc."sporeSummary"->>'length_max_um')::double precision IS DISTINCT FROM 12.0 THEN
    RAISE EXCEPTION 'Expected NO-filtered length 10.1–12.0 (private obs excluded), got %–%',
      spore_rpc."sporeSummary"->>'length_min_um',
      spore_rpc."sporeSummary"->>'length_max_um';
  END IF;

  -- Country filter SE: 1 observation (amanita_se_id, spore_data_visibility=public).
  SELECT * INTO spore_rpc FROM public.get_public_species_spore_summary('amanita-muscaria', 'SE');

  IF spore_rpc."observationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected observationCount=1 for SE, got %', spore_rpc."observationCount";
  END IF;
  IF spore_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected sporeObservationCount=1 for SE, got %', spore_rpc."sporeObservationCount";
  END IF;
  IF (spore_rpc."sporeSummary"->>'n')::bigint IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected n=1 for SE filter, got %', spore_rpc."sporeSummary"->>'n';
  END IF;
  IF (spore_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 9.0 THEN
    RAISE EXCEPTION 'Expected SE length_min=9.0, got %', spore_rpc."sporeSummary"->>'length_min_um';
  END IF;

  -- Region filter rpc-test-region: 3 obs (public_exact_id + amanita_private_spore_id + amanita_koh_id), 2 spore obs.
  SELECT * INTO spore_rpc FROM public.get_public_species_spore_summary('amanita-muscaria', NULL, 'rpc-test-region');

  IF spore_rpc."observationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Expected observationCount=3 for rpc-test-region, got %', spore_rpc."observationCount";
  END IF;
  IF spore_rpc."sporeObservationCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Expected sporeObservationCount=2 for rpc-test-region, got %', spore_rpc."sporeObservationCount";
  END IF;

  -- Date filter excludes public_exact_id (2026-06-01 < date_from 2026-06-02).
  SELECT * INTO spore_rpc FROM public.get_public_species_spore_summary(
    'amanita-muscaria', NULL, NULL, '2026-06-02'::date, NULL
  );

  IF spore_rpc."observationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Expected observationCount=3 after date_from filter, got %', spore_rpc."observationCount";
  END IF;
  IF spore_rpc."sporeObservationCount" IS DISTINCT FROM 2 THEN
    -- amanita_se_id (2026-06-20) + amanita_koh_id (2026-06-25) have public spores after date_from.
    RAISE EXCEPTION 'Expected sporeObservationCount=2 after date_from filter, got %', spore_rpc."sporeObservationCount";
  END IF;

  -- Non-existent species returns no rows.
  IF EXISTS (SELECT 1 FROM public.get_public_species_spore_summary('nonexistent-xyz-abc')) THEN
    RAISE EXCEPTION 'Expected no rows for nonexistent species';
  END IF;

  -- sporeSummary is NULL when all matching spore data is private.
  SELECT * INTO spore_rpc FROM public.get_public_species_spore_summary('amanita-muscaria', 'NO', 'rpc-test-region');
  -- NO + rpc-test-region: public_exact_id (public) + amanita_private_spore_id (private).
  -- public_exact_id is in rpc-test-region and has public spore data → sporeSummary not null.
  IF spore_rpc."sporeSummary" IS NULL THEN
    RAISE EXCEPTION 'Expected non-null sporeSummary for NO+rpc-test-region (public_exact_id has public spores)';
  END IF;

  -- ── get_public_spore_comparison_set ──────────────────────────────────────

  -- Test 1: Species comparison set, no extra filters.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria');

  IF comp_rpc."sourceType" IS DISTINCT FROM 'taxon_filter' THEN
    RAISE EXCEPTION 'Expected sourceType=taxon_filter, got %', comp_rpc."sourceType";
  END IF;

  IF comp_rpc."taxonRank" IS DISTINCT FROM 'species' THEN
    RAISE EXCEPTION 'Expected taxonRank=species, got %', comp_rpc."taxonRank";
  END IF;

  IF comp_rpc."observationCount" IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected observationCount=4, got %', comp_rpc."observationCount";
  END IF;

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected sporeObservationCount=3, got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected sporeMeasurementCount=4, got %', comp_rpc."sporeMeasurementCount";
  END IF;

  IF (comp_rpc."sporeSummary"->>'n')::bigint IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected sporeSummary.n=4, got %', comp_rpc."sporeSummary"->>'n';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 9.0 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected length_min_um=9.0, got %', comp_rpc."sporeSummary"->>'length_min_um';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_max_um')::double precision IS DISTINCT FROM 12.0 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected length_max_um=12.0, got %', comp_rpc."sporeSummary"->>'length_max_um';
  END IF;

  IF jsonb_array_length(comp_rpc."observations") IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test 1: Expected 3 observation rows, got %', jsonb_array_length(comp_rpc."observations");
  END IF;

  -- Test 2: Genus comparison set.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set(NULL, 'Amanita');

  IF comp_rpc."taxonRank" IS DISTINCT FROM 'genus' THEN
    RAISE EXCEPTION 'comp_rpc Test 2: Expected taxonRank=genus, got %', comp_rpc."taxonRank";
  END IF;

  IF comp_rpc."observationCount" IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'comp_rpc Test 2: Expected observationCount=4, got %', comp_rpc."observationCount";
  END IF;

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test 2: Expected sporeObservationCount=3, got %', comp_rpc."sporeObservationCount";
  END IF;

  -- Test 3: Country filter (NO).
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria', NULL, 'NO');

  IF comp_rpc."observationCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test 3: Expected observationCount=3 for NO, got %', comp_rpc."observationCount";
  END IF;

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'comp_rpc Test 3: Expected sporeObservationCount=2 for NO, got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test 3: Expected sporeMeasurementCount=3 for NO, got %', comp_rpc."sporeMeasurementCount";
  END IF;

  -- Test 4: Sample type filter (fresh).
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria', NULL, NULL, NULL, NULL, NULL, 'fresh');

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'comp_rpc Test 4: Expected sporeObservationCount=2 for sample_type=fresh, got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test 4: Expected sporeMeasurementCount=3 for sample_type=fresh, got %', comp_rpc."sporeMeasurementCount";
  END IF;

  -- Test 5: Mount reagent filter (KOH).
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria', NULL, NULL, NULL, NULL, NULL, NULL, 'KOH');

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test 5: Expected sporeObservationCount=1 for mount_reagent=KOH, got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test 5: Expected sporeMeasurementCount=1 for mount_reagent=KOH, got %', comp_rpc."sporeMeasurementCount";
  END IF;

  -- Test 6: Contrast method filter (DIC).
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'DIC');

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test 6: Expected sporeObservationCount=1 for contrast_method=DIC, got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test 6: Expected sporeMeasurementCount=1 for contrast_method=DIC, got %', comp_rpc."sporeMeasurementCount";
  END IF;

  -- Test 7: Private spore observation must not appear in observations array.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria');

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(comp_rpc."observations") AS obs
    WHERE (obs->>'observationId')::bigint = amanita_private_spore_id
  ) THEN
    RAISE EXCEPTION 'comp_rpc Test 7: Private spore observation leaked into observations array';
  END IF;

  -- Test 8: No GPS coordinates in observation rows.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(comp_rpc."observations") AS obs
    WHERE obs ? 'mapLat' OR obs ? 'mapLon'
  ) THEN
    RAISE EXCEPTION 'comp_rpc Test 8: GPS coordinates leaked into observations array';
  END IF;

  -- Test 9: Observation rows have required structure keys.
  IF NOT (
    (comp_rpc."observations"->0) ? 'observationId'
    AND (comp_rpc."observations"->0) ? 'sporeN'
    AND (comp_rpc."observations"->0) ? 'lengthMeanUm'
  ) THEN
    RAISE EXCEPTION 'comp_rpc Test 9: Observation row missing required keys (observationId, sporeN, lengthMeanUm)';
  END IF;

  -- Test 10: Aggregate sporeMeasurementCount matches sum of sporeN in observations array.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria');

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM (
    SELECT coalesce(sum((obs->>'sporeN')::bigint), 0)
    FROM jsonb_array_elements(comp_rpc."observations") AS obs
  ) THEN
    RAISE EXCEPTION 'comp_rpc Test 10: sporeMeasurementCount does not match sum of sporeN in observations array';
  END IF;

  -- Test 11: No rows returned when both slug and genus are null.
  IF EXISTS (SELECT 1 FROM public.get_public_spore_comparison_set()) THEN
    RAISE EXCEPTION 'comp_rpc Test 11: Expected no rows when both slug and genus are null';
  END IF;

  -- Test 12: Date range filter (date_from='2026-06-24', only amanita_koh_id qualifies).
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set('amanita-muscaria', NULL, NULL, NULL, '2026-06-24', NULL);

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test 12: Expected sporeObservationCount=1 for date_from=2026-06-24, got %', comp_rpc."sporeObservationCount";
  END IF;

  -- ── Leucopholiota americana mixed-prep tests ─────────────────────────────
  -- These tests verify that prep-level filters work correctly for an observation
  -- that has two microscope images with different sample_type values (fresh +
  -- spore_print). Image B (spore_print) has a higher id so the old "latest
  -- image" approach would have picked spore_print as the representative image.

  -- Test A: No prep filter — all 5 measurements (2 fresh + 3 spore_print) included.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set(NULL, 'Leucopholiota');

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected sporeObservationCount=1 for Leucopholiota (no filter), got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected sporeMeasurementCount=5 for Leucopholiota (no filter), got %', comp_rpc."sporeMeasurementCount";
  END IF;

  IF (comp_rpc."sporeSummary"->>'n')::bigint IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected sporeSummary.n=5 for Leucopholiota (no filter), got %', comp_rpc."sporeSummary"->>'n';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 10.0 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected length_min_um=10.0 for Leucopholiota (no filter), got %', comp_rpc."sporeSummary"->>'length_min_um';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_max_um')::double precision IS DISTINCT FROM 14.0 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected length_max_um=14.0 for Leucopholiota (no filter), got %', comp_rpc."sporeSummary"->>'length_max_um';
  END IF;

  IF jsonb_array_length(comp_rpc."observations") IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected 1 observation row for Leucopholiota (no filter), got %', jsonb_array_length(comp_rpc."observations");
  END IF;

  IF ((comp_rpc."observations"->0)->>'sporeN')::bigint IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'comp_rpc Test A: Expected sporeN=5 in observation row (no filter), got %', (comp_rpc."observations"->0)->>'sporeN';
  END IF;

  -- Test B: fresh filter — only 2 fresh measurements from Image A.
  -- Observation must still be selected because it HAS a fresh image.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set(NULL, 'Leucopholiota', NULL, NULL, NULL, NULL, 'fresh');

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected sporeObservationCount=1 for Leucopholiota (fresh filter), got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected sporeMeasurementCount=2 for Leucopholiota (fresh filter), got %', comp_rpc."sporeMeasurementCount";
  END IF;

  IF (comp_rpc."sporeSummary"->>'n')::bigint IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected sporeSummary.n=2 for Leucopholiota (fresh filter), got %', comp_rpc."sporeSummary"->>'n';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 10.0 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected length_min_um=10.0 for fresh filter, got %', comp_rpc."sporeSummary"->>'length_min_um';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_max_um')::double precision IS DISTINCT FROM 11.0 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected length_max_um=11.0 for fresh filter, got %', comp_rpc."sporeSummary"->>'length_max_um';
  END IF;

  IF ((comp_rpc."observations"->0)->>'sporeN')::bigint IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected sporeN=2 in observation row (fresh filter), got %', (comp_rpc."observations"->0)->>'sporeN';
  END IF;

  IF abs(((comp_rpc."observations"->0)->>'lengthMeanUm')::double precision - 10.5) >= 0.01 THEN
    RAISE EXCEPTION 'comp_rpc Test B: Expected lengthMeanUm≈10.5 for fresh filter, got %', (comp_rpc."observations"->0)->>'lengthMeanUm';
  END IF;

  -- Test C: spore_print filter — only 3 spore_print measurements from Image B.
  -- Observation must still be selected because it HAS a spore_print image.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set(NULL, 'Leucopholiota', NULL, NULL, NULL, NULL, 'spore_print');

  IF comp_rpc."sporeObservationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected sporeObservationCount=1 for Leucopholiota (spore_print filter), got %', comp_rpc."sporeObservationCount";
  END IF;

  IF comp_rpc."sporeMeasurementCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected sporeMeasurementCount=3 for Leucopholiota (spore_print filter), got %', comp_rpc."sporeMeasurementCount";
  END IF;

  IF (comp_rpc."sporeSummary"->>'n')::bigint IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected sporeSummary.n=3 for Leucopholiota (spore_print filter), got %', comp_rpc."sporeSummary"->>'n';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_min_um')::double precision IS DISTINCT FROM 12.0 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected length_min_um=12.0 for spore_print filter, got %', comp_rpc."sporeSummary"->>'length_min_um';
  END IF;

  IF (comp_rpc."sporeSummary"->>'length_max_um')::double precision IS DISTINCT FROM 14.0 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected length_max_um=14.0 for spore_print filter, got %', comp_rpc."sporeSummary"->>'length_max_um';
  END IF;

  IF ((comp_rpc."observations"->0)->>'sporeN')::bigint IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected sporeN=3 in observation row (spore_print filter), got %', (comp_rpc."observations"->0)->>'sporeN';
  END IF;

  IF abs(((comp_rpc."observations"->0)->>'lengthMeanUm')::double precision - 13.0) >= 0.01 THEN
    RAISE EXCEPTION 'comp_rpc Test C: Expected lengthMeanUm≈13.0 for spore_print filter, got %', (comp_rpc."observations"->0)->>'lengthMeanUm';
  END IF;

  -- Test E: Observation not selected for a prep filter it does not have.
  -- Leucopholiota americana has no 'dried' image, so zero observations expected.
  IF EXISTS (SELECT 1 FROM public.get_public_spore_comparison_set(NULL, 'Leucopholiota', NULL, NULL, NULL, NULL, 'dried')) THEN
    RAISE EXCEPTION 'comp_rpc Test E: Expected no rows for Leucopholiota with dried filter (no dried images exist)';
  END IF;

  -- Test F: sampleType in observation row is populated when the filter is active.
  SELECT * INTO comp_rpc FROM public.get_public_spore_comparison_set(NULL, 'Leucopholiota', NULL, NULL, NULL, NULL, 'fresh');

  IF (comp_rpc."observations"->0)->>'sampleType' IS DISTINCT FROM 'fresh' THEN
    RAISE EXCEPTION 'comp_rpc Test F: Expected sampleType=fresh in observation row, got %', (comp_rpc."observations"->0)->>'sampleType';
  END IF;

  -- ── get_public_species_distribution_summary ──────────────────────────────

  -- Test 1: Basic call for Amanita muscaria, no filters.
  -- Fixture state: 4 Amanita muscaria observations, all with microscopy.
  -- Public spore measurements: 2 (public_exact_id) + 1 (amanita_se_id) + 1 (amanita_koh_id) = 4.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary('amanita-muscaria');

  IF dist_rpc."observationCount" IS NULL OR dist_rpc."observationCount" < 4 THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected observationCount >= 4, got %', dist_rpc."observationCount";
  END IF;

  IF dist_rpc."microscopyObservationCount" < 4 THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected microscopyObservationCount >= 4, got %', dist_rpc."microscopyObservationCount";
  END IF;

  IF dist_rpc."sporeMeasurementCount" < 4 THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected sporeMeasurementCount >= 4, got %', dist_rpc."sporeMeasurementCount";
  END IF;

  IF dist_rpc."firstObservedOn" IS NULL THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected firstObservedOn to be non-null';
  END IF;

  IF dist_rpc."lastObservedOn" IS NULL THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected lastObservedOn to be non-null';
  END IF;

  IF jsonb_array_length(dist_rpc."monthCounts") < 1 THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected at least one month in monthCounts, got %', jsonb_array_length(dist_rpc."monthCounts");
  END IF;

  IF dist_rpc."sampleTypeFacets" IS NULL THEN
    RAISE EXCEPTION 'dist_rpc Test 1: Expected sampleTypeFacets to be non-null';
  END IF;

  -- Test 2: Country filter reduces count compared to unfiltered.
  -- amanita_se_id is in SE; unfiltered is 4.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary('amanita-muscaria', 'SE');

  IF dist_rpc."observationCount" < 1 THEN
    RAISE EXCEPTION 'dist_rpc Test 2: Expected observationCount >= 1 for SE, got %', dist_rpc."observationCount";
  END IF;

  IF dist_rpc."observationCount" >= (
    SELECT "observationCount"
    FROM public.get_public_species_distribution_summary('amanita-muscaria')
  ) THEN
    RAISE EXCEPTION 'dist_rpc Test 2: Expected SE-filtered count to be less than unfiltered count';
  END IF;

  -- Test 3: Sample type filter (fresh) uses EXISTS — public_exact_id has Fresh
  -- (stored as fresh after lower-case normalization) and amanita_koh_id has fresh.
  -- Both are public Amanita muscaria observations.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary(
    'amanita-muscaria', NULL, NULL, NULL, NULL, 'fresh'
  );

  IF dist_rpc."observationCount" < 2 THEN
    RAISE EXCEPTION 'dist_rpc Test 3: Expected observationCount >= 2 for sample_type=fresh, got %', dist_rpc."observationCount";
  END IF;

  -- Test 4: p_has_microscopy=true — all returned observations must have microscopy.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary(
    'amanita-muscaria', NULL, NULL, NULL, NULL, NULL, NULL, NULL, true
  );

  IF dist_rpc."observationCount" IS DISTINCT FROM dist_rpc."microscopyObservationCount" THEN
    RAISE EXCEPTION 'dist_rpc Test 4: Expected observationCount=microscopyObservationCount when has_microscopy=true, got % vs %',
      dist_rpc."observationCount", dist_rpc."microscopyObservationCount";
  END IF;

  -- Test 5: mapPoints returned for observations with GPS coordinates.
  -- public_exact_id has gps_latitude=59.9273.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary('amanita-muscaria');

  IF jsonb_array_length(dist_rpc."mapPoints") < 1 THEN
    RAISE EXCEPTION 'dist_rpc Test 5: Expected at least one map point (public_exact_id has GPS), got %',
      jsonb_array_length(dist_rpc."mapPoints");
  END IF;

  -- Each map point must have the required structure keys.
  IF NOT (
    (dist_rpc."mapPoints"->0) ? 'observationId'
    AND (dist_rpc."mapPoints"->0) ? 'locationPrecision'
    AND (dist_rpc."mapPoints"->0) ? 'observedOn'
  ) THEN
    RAISE EXCEPTION 'dist_rpc Test 5: Map point is missing required keys (observationId, locationPrecision, observedOn)';
  END IF;

  -- Test 6: public_exact_id has exact precision and GPS set — its map point must
  -- have a non-null mapLat.
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(dist_rpc."mapPoints") pt
    WHERE (pt->>'observationId')::bigint = public_exact_id
      AND (pt->>'mapLat') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'dist_rpc Test 6: Expected public_exact_id map point to have non-null mapLat';
  END IF;

  -- Privacy check: region/hidden-precision observations may appear in mapPoints
  -- only if they have a recorded GPS, but their coordinates must be null.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(dist_rpc."mapPoints") pt
    WHERE (pt->>'locationPrecision') NOT IN ('exact', 'fuzzed')
      AND (pt->>'mapLat') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'dist_rpc Test 6: region/hidden observation leaked non-null coordinates through mapPoints';
  END IF;

  -- Test 7: Month counts are within valid range 1–12.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary('amanita-muscaria');

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(dist_rpc."monthCounts") mc
    WHERE (mc->>'month')::int < 1 OR (mc->>'month')::int > 12
  ) THEN
    RAISE EXCEPTION 'dist_rpc Test 7: monthCounts contains a month value outside 1-12';
  END IF;

  -- Test 8: Facets are non-empty — brightfield is present from public_exact_id.
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(dist_rpc."contrastMethodFacets") f
    WHERE f->>'value' = 'brightfield'
  ) THEN
    RAISE EXCEPTION 'dist_rpc Test 8: Expected brightfield in contrastMethodFacets (from public_exact_id)';
  END IF;

  -- Test 9: Non-existent species returns no rows.
  IF EXISTS (SELECT 1 FROM public.get_public_species_distribution_summary('nonexistent-xyz-99')) THEN
    RAISE EXCEPTION 'dist_rpc Test 9: Expected no rows for nonexistent species';
  END IF;

  -- ── Mixed-preparation tests (leucopholiota-americana) ────────────────────────
  -- mixed_prep_id has two microscopy images:
  --   Image A (fresh): 2 measurements (L=10.0, 11.0)
  --   Image B (spore_print, inserted later → higher id = "latest"): 3 measurements (L=12.0, 13.0, 14.0)
  --
  -- These tests verify:
  --   A) facets include ALL prep values, not only the latest image
  --   B) sporeMeasurementCount is filtered at the image/measurement level

  -- Test MP-1: unfiltered — both sample type values appear in facets.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary('leucopholiota-americana');
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(dist_rpc."sampleTypeFacets") f
    WHERE f->>'value' = 'fresh'
  ) THEN
    RAISE EXCEPTION 'dist_rpc MP-1: sampleTypeFacets missing fresh (only latest-image was used)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(dist_rpc."sampleTypeFacets") f
    WHERE f->>'value' = 'spore_print'
  ) THEN
    RAISE EXCEPTION 'dist_rpc MP-1: sampleTypeFacets missing spore_print (only latest-image was used)';
  END IF;
  -- Unfiltered spore count = all 5 measurements
  IF dist_rpc."sporeMeasurementCount" IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION 'dist_rpc MP-1: Expected sporeMeasurementCount=5 unfiltered, got %', dist_rpc."sporeMeasurementCount";
  END IF;

  -- Test MP-2: fresh filter — only 2 fresh measurements, observation still selected.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary(
    'leucopholiota-americana', NULL, NULL, NULL, NULL, 'fresh'
  );
  IF dist_rpc."observationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'dist_rpc MP-2: Expected observationCount=1 for fresh filter, got %', dist_rpc."observationCount";
  END IF;
  IF dist_rpc."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'dist_rpc MP-2: Expected sporeMeasurementCount=2 for fresh filter (image-level), got %', dist_rpc."sporeMeasurementCount";
  END IF;

  -- Test MP-3: spore_print filter — only 3 spore_print measurements.
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary(
    'leucopholiota-americana', NULL, NULL, NULL, NULL, 'spore_print'
  );
  IF dist_rpc."observationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'dist_rpc MP-3: Expected observationCount=1 for spore_print filter, got %', dist_rpc."observationCount";
  END IF;
  IF dist_rpc."sporeMeasurementCount" IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'dist_rpc MP-3: Expected sporeMeasurementCount=3 for spore_print filter, got %', dist_rpc."sporeMeasurementCount";
  END IF;

  -- Test MP-4: fresh and spore_print counts differ (proves image-level split).
  -- Already verified by MP-2 (2) and MP-3 (3).

  -- Test MP-5: no-match prep filter returns zero-count row (slug exists, no obs match).
  SELECT * INTO dist_rpc FROM public.get_public_species_distribution_summary(
    'leucopholiota-americana', NULL, NULL, NULL, NULL, 'dried'
  );
  IF dist_rpc."observationCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'dist_rpc MP-5: Expected observationCount=0 for dried filter, got %', dist_rpc."observationCount";
  END IF;
  IF dist_rpc."sporeMeasurementCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'dist_rpc MP-5: Expected sporeMeasurementCount=0 for dried filter, got %', dist_rpc."sporeMeasurementCount";
  END IF;

  -- ── get_public_map_points ─────────────────────────────────────────────────

  -- Test MP1: Unfiltered call returns at least 1 row (public_exact_id has GPS).
  SELECT * INTO map_rpc FROM public.get_public_map_points() LIMIT 1;
  IF map_rpc."observationId" IS NULL THEN
    RAISE EXCEPTION 'get_public_map_points returned no rows unfiltered';
  END IF;

  -- Test MP2: Hidden/region observations do not expose coordinates.
  IF EXISTS (
    SELECT 1 FROM public.get_public_map_points()
    WHERE "observationId" IN (hidden_location_id, region_location_id)
      AND "mapLat" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Hidden/region observations leaked coordinates in map points';
  END IF;

  -- Test MP3: Exact GPS observation returns non-null mapLat.
  IF NOT EXISTS (
    SELECT 1 FROM public.get_public_map_points()
    WHERE "observationId" = public_exact_id AND "mapLat" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Exact observation missing mapLat in map points';
  END IF;

  -- Test MP4: Species slug filter works.
  IF NOT EXISTS (
    SELECT 1 FROM public.get_public_map_points(p_species_slug := 'amanita-muscaria')
    WHERE "observationId" = public_exact_id
  ) THEN
    RAISE EXCEPTION 'Species filter did not include Amanita muscaria observation';
  END IF;

  -- Test MP5: Private/draft/banned excluded (no rows for those ids).
  IF EXISTS (
    SELECT 1 FROM public.get_public_map_points()
    WHERE "observationId" IN (private_id, draft_id, banned_id)
  ) THEN
    RAISE EXCEPTION 'Private/draft/banned observations leaked into map points';
  END IF;

  -- Test MP6: Mixed-prep EXISTS semantics — fresh filter includes mixed_prep_id
  -- (which has a fresh image even though spore_print is the latest).
  IF NOT EXISTS (
    SELECT 1 FROM public.get_public_map_points(p_sample_type := 'fresh')
    WHERE "observationId" = mixed_prep_id
  ) THEN
    RAISE EXCEPTION 'Map points fresh filter did not include mixed-prep observation (EXISTS semantics broken)';
  END IF;

  -- Test MP7: spore_print filter also includes mixed_prep_id.
  IF NOT EXISTS (
    SELECT 1 FROM public.get_public_map_points(p_sample_type := 'spore_print')
    WHERE "observationId" = mixed_prep_id
  ) THEN
    RAISE EXCEPTION 'Map points spore_print filter did not include mixed-prep observation';
  END IF;

  -- Test MP8: Limit is respected.
  IF (SELECT count(*) FROM public.get_public_map_points(p_limit := 2)) > 2 THEN
    RAISE EXCEPTION 'get_public_map_points limit not respected';
  END IF;

  -- Test MP9: hasMicroscopy filter.
  IF NOT EXISTS (
    SELECT 1 FROM public.get_public_map_points(p_has_microscopy := true)
    WHERE "observationId" = public_exact_id AND "hasMicroscopy" = true
  ) THEN
    RAISE EXCEPTION 'hasMicroscopy filter returned no microscopy observations';
  END IF;

  -- Test MP10: search_public_observations EXISTS fix — mixed_prep_id with fresh filter.
  IF NOT EXISTS (
    SELECT 1 FROM public.search_public_observations(p_sample := 'fresh')
    WHERE id = mixed_prep_id
  ) THEN
    RAISE EXCEPTION 'search_public_observations fresh filter (EXISTS fix) did not include mixed-prep observation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.search_public_observations(p_sample := 'spore_print')
    WHERE id = mixed_prep_id
  ) THEN
    RAISE EXCEPTION 'search_public_observations spore_print filter (EXISTS fix) did not include mixed-prep observation';
  END IF;

  DELETE FROM auth.users
  WHERE id IN (visible_user_id, banned_user_id);

  DELETE FROM public.public_regions
  WHERE id = 'rpc-test-region';

  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility SET NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision SET NOT NULL';
END
$$;
