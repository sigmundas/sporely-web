-- Verifies that every entry in get_public_observation.sporePoints
-- carries per-image prep metadata (contrastMethod, mountReagent,
-- stainReagent, sampleType, sampleSource) matching the observation_image
-- row the measurement was attached to. Also checks that unset variants
-- are stripped from the JSON object (via jsonb_strip_nulls) so client
-- code never sees "Not_set" leaking through per-point fields.

DO $$
DECLARE
  sample_user_id uuid := '00000000-0000-4000-8000-00000000cf01';
  obs_id bigint;
  img_dic_hymenium bigint;
  img_bf_stipe    bigint;
  img_unset       bigint;
  detail_row     record;
  points         jsonb;
  point_by_image_dic     jsonb;
  point_by_image_bf      jsonb;
  point_by_image_unset   jsonb;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    sample_user_id, 'authenticated', 'authenticated',
    'point-prep-rpc@example.test',
    '{"full_name":"Point Prep Tester"}'::jsonb, now(), now()
  );

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES (sample_user_id, 'point_prep_rpc', 'Point Prep Tester', false)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft, spore_data_visibility,
    location_precision, country_code, spore_statistics
  )
  VALUES (
    sample_user_id, '2026-07-15', 'Pointprepus', 'multiimage',
    'public', false, 'public', 'hidden', 'NO',
    jsonb_build_object('n', 3)
  )
  RETURNING id INTO obs_id;

  -- Image A: DIC / KOH / Congo Red / Fresh / hymenium — one spore.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    obs_id, sample_user_id,
    concat(sample_user_id::text, '/pp-a.webp'),
    'microscope', 'DIC', 'KOH', 'Congo Red', 'Fresh', 'hymenium'
  )
  RETURNING id INTO img_dic_hymenium;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_dic_hymenium, sample_user_id, 12.0, 6.0, 'manual');

  -- Image B: BF / water / null stain / Dried / stipe — one spore.
  -- Null stain plus null contrast in one image would strip both keys.
  -- Keep contrast set here so we can verify the "some fields present,
  -- others stripped" path.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    obs_id, sample_user_id,
    concat(sample_user_id::text, '/pp-b.webp'),
    'microscope', 'BF', 'water', NULL, 'Dried', 'stipe'
  )
  RETURNING id INTO img_bf_stipe;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_bf_stipe, sample_user_id, 11.0, 5.5, 'manual');

  -- Image C: every prep field = Not_set. Every per-point prep key
  -- must be stripped from the point JSON.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    contrast, mount_medium, stain, sample_type, sample_source
  )
  VALUES (
    obs_id, sample_user_id,
    concat(sample_user_id::text, '/pp-c.webp'),
    'microscope', 'Not_set', 'Not_set', 'Not_set', 'Not_set', 'Not_set'
  )
  RETURNING id INTO img_unset;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_unset, sample_user_id, 10.5, 5.2, 'manual');

  SELECT * INTO detail_row FROM public.get_public_observation(obs_id);
  points := detail_row."sporePoints";

  IF points IS NULL OR jsonb_array_length(points) <> 3 THEN
    RAISE EXCEPTION 'expected 3 spore points, got %', points;
  END IF;

  point_by_image_dic := (
    SELECT p
    FROM jsonb_array_elements(points) p
    WHERE p->>'imageId' = img_dic_hymenium::text
  );
  point_by_image_bf := (
    SELECT p
    FROM jsonb_array_elements(points) p
    WHERE p->>'imageId' = img_bf_stipe::text
  );
  point_by_image_unset := (
    SELECT p
    FROM jsonb_array_elements(points) p
    WHERE p->>'imageId' = img_unset::text
  );

  -- Image A: full set of prep fields with canonical values.
  IF point_by_image_dic->>'contrastMethod' IS DISTINCT FROM 'DIC'
     OR point_by_image_dic->>'mountReagent' IS DISTINCT FROM 'KOH'
     OR point_by_image_dic->>'stainReagent' IS DISTINCT FROM 'Congo Red'
     OR point_by_image_dic->>'sampleType' IS DISTINCT FROM 'fresh'
     OR point_by_image_dic->>'sampleSource' IS DISTINCT FROM 'hymenium' THEN
    RAISE EXCEPTION 'image A point prep mismatch: %', point_by_image_dic;
  END IF;

  -- Image B: stain omitted (NULL) — the key must be absent, not "null".
  IF point_by_image_bf->>'contrastMethod' IS DISTINCT FROM 'BF'
     OR point_by_image_bf->>'mountReagent' IS DISTINCT FROM 'water'
     OR point_by_image_bf ? 'stainReagent'
     OR point_by_image_bf->>'sampleType' IS DISTINCT FROM 'dried'
     OR point_by_image_bf->>'sampleSource' IS DISTINCT FROM 'stipe' THEN
    RAISE EXCEPTION 'image B point prep mismatch: %', point_by_image_bf;
  END IF;

  -- Image C: every prep field is Not_set — all five keys must be
  -- stripped. Absence, not "Not_set" strings.
  IF point_by_image_unset ? 'contrastMethod'
     OR point_by_image_unset ? 'mountReagent'
     OR point_by_image_unset ? 'stainReagent'
     OR point_by_image_unset ? 'sampleType'
     OR point_by_image_unset ? 'sampleSource' THEN
    RAISE EXCEPTION 'image C point should have all prep keys stripped, got %',
      point_by_image_unset;
  END IF;

  -- Sanity: id / lengthUm / widthUm / imageId / observationId must
  -- still be present on every point (the stripping is per-field, not
  -- wholesale).
  IF point_by_image_unset->>'lengthUm' IS NULL
     OR point_by_image_unset->>'widthUm' IS NULL
     OR point_by_image_unset->>'imageId' IS NULL
     OR point_by_image_unset->>'observationId' IS NULL THEN
    RAISE EXCEPTION 'core spore point fields must remain: %', point_by_image_unset;
  END IF;

  DELETE FROM public.observations WHERE id = obs_id;
  DELETE FROM public.profiles WHERE id = sample_user_id;
  DELETE FROM auth.users WHERE id = sample_user_id;
END
$$;
