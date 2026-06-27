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
  purged_microscopy_id bigint;
  image_id bigint;
  rpc_row record;
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
    location_precision,
    location,
    country_code
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
    'exact',
    'Exact Test Site',
    'NO'
  )
  RETURNING id INTO public_exact_id;

  INSERT INTO public.observation_images (
    observation_id,
    user_id,
    storage_path,
    image_type,
    contrast,
    mount_medium,
    sample_type
  )
  VALUES (
    public_exact_id,
    visible_user_id,
    'rpc/public-exact.webp',
    'microscope',
    'brightfield',
    'water',
    'Fresh'
  )
  RETURNING id INTO image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES
    (image_id, visible_user_id, 10.1, 5.1, 'manual'),
    (image_id, visible_user_id, 11.2, 5.4, 'spore');

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (visible_user_id, '2026-06-02', 'Private', 'hidden', 'private', false, 'public', 'exact')
  RETURNING id INTO private_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (visible_user_id, '2026-06-03', 'Draft', 'hidden', 'public', true, 'public', 'exact')
  RETURNING id INTO draft_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (banned_user_id, '2026-06-04', 'Banned', 'hidden', 'public', false, 'public', 'exact')
  RETURNING id INTO banned_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (visible_user_id, '2026-06-05', 'Nullvis', 'hidden', NULL, false, 'public', 'exact')
  RETURNING id INTO null_visibility_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (visible_user_id, '2026-06-06', 'Nullspore', 'counted', 'public', false, NULL, 'exact')
  RETURNING id INTO null_spore_visibility_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (null_spore_visibility_id, visible_user_id, 'rpc/null-spore.webp', 'microscope')
  RETURNING id INTO image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (image_id, visible_user_id, 12.0, 6.0, 'manual');

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
  VALUES (visible_user_id, '2026-06-07', 'Hidden', 'location', 'public', false, 'public', 'hidden', 'Private Hidden Site')
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

  INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, spore_data_visibility, location_precision)
  VALUES (visible_user_id, '2026-06-10', 'Purged', 'microscopy', 'public', false, 'public', 'exact')
  RETURNING id INTO purged_microscopy_id;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, purged_at)
  VALUES (purged_microscopy_id, visible_user_id, 'rpc/purged.webp', 'microscope', now())
  RETURNING id INTO image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (image_id, visible_user_id, 9.0, 4.0, 'manual');

  IF NOT EXISTS (SELECT 1 FROM public.search_public_observations() WHERE id = public_exact_id) THEN
    RAISE EXCEPTION 'Expected public observation % to appear', public_exact_id;
  END IF;

  IF EXISTS (SELECT 1 FROM public.search_public_observations() WHERE id IN (private_id, draft_id, banned_id, null_visibility_id)) THEN
    RAISE EXCEPTION 'Private, draft, banned, or null-visibility observations leaked into public search';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(public_exact_id);
  IF rpc_row.id IS DISTINCT FROM public_exact_id
     OR rpc_row."locationLabel" IS DISTINCT FROM 'Exact Test Site'
     OR rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2
     OR rpc_row."contrastMethod" IS DISTINCT FROM 'brightfield'
     OR rpc_row."mountReagent" IS DISTINCT FROM 'water'
     OR rpc_row."sampleType" IS DISTINCT FROM 'fresh' THEN
    RAISE EXCEPTION 'Public detail projection did not match expected safe fields';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_observation(null_spore_visibility_id);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Null spore_data_visibility leaked a private spore count';
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

  DELETE FROM auth.users
  WHERE id IN (visible_user_id, banned_user_id);

  DELETE FROM public.public_regions
  WHERE id = 'rpc-test-region';

  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility SET NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision SET NOT NULL';
END
$$;
