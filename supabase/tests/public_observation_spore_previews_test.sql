-- public.get_public_observation_spore_previews(bigint[]) regression test.
-- Plan: docs/plans/active/2026-10-10-batch-spore-preview-rpc.md, Stage 1.
--
-- Run after a local reset with psql as postgres:
--   supabase db reset --local
--   docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/public_observation_spore_previews_test.sql
-- Everything runs in one transaction and is rolled back. A failed assertion
-- raises, so ON_ERROR_STOP makes psql exit non-zero.
--
-- The block between the @fixtures markers is also replayed by
-- public_observation_spore_previews_identity_test.sh; keep it self-contained.

BEGIN;

-- @fixtures-begin
CREATE TEMP TABLE spv_fixture (
  label text PRIMARY KEY,
  observation_id bigint NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE spv_viewer (
  label text PRIMARY KEY,
  user_id uuid
) ON COMMIT DROP;

DO $fixtures$
DECLARE
  owner_id   uuid := '00000000-0000-4000-8000-0000000c5a01';
  stranger_id uuid := '00000000-0000-4000-8000-0000000c5a02';
  blocker_id uuid := '00000000-0000-4000-8000-0000000c5a03';
  banned_id  uuid := '00000000-0000-4000-8000-0000000c5a04';
  obs bigint;
  img_a bigint;
  img_b bigint;
  img_meta bigint;
  img_gone bigint;
  m1 bigint;
  m2 bigint;
  mosaic_old bigint;
  mosaic_new bigint;
  label text;
BEGIN
  -- A deterministic worker base URL so build_worker_media_url and
  -- build_worker_mosaic_url return values rather than NULL.
  INSERT INTO public._media_worker_config (singleton, base_url)
  VALUES (true, 'https://upload.example.test')
  ON CONFLICT (singleton) DO UPDATE SET base_url = excluded.base_url;

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,    'authenticated', 'authenticated', 'spv-owner@example.test',    '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'spv-stranger@example.test', '{}'::jsonb, now(), now()),
    (blocker_id,  'authenticated', 'authenticated', 'spv-blocker@example.test',  '{}'::jsonb, now(), now()),
    (banned_id,   'authenticated', 'authenticated', 'spv-banned@example.test',   '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES
    (owner_id,    'spv_owner',    'SPV Owner',    true, false),
    (stranger_id, 'spv_stranger', 'SPV Stranger', true, false),
    (blocker_id,  'spv_blocker',  'SPV Blocker',  true, false),
    (banned_id,   'spv_banned',   'SPV Banned',   true, false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES (blocker_id, owner_id);

  INSERT INTO spv_viewer (label, user_id) VALUES
    ('anon', NULL), ('stranger', stranger_id), ('blocker', blocker_id), ('owner', owner_id);

  -- full: two public spore-bearing images, a soft-deleted and a purged image,
  -- a non-spore measurement type, and two mosaic versions.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-01', 'Amanita', 'muscaria', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('full', obs);

  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, image_type, contrast, mount_medium, stain, sample_type, sample_source)
  VALUES (obs, owner_id, owner_id::text || '/spv-a.webp', NULL, ' BF ', 'Water', 'Congo red', ' Fresh ', 'Spore_Print')
  RETURNING id INTO img_a;
  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, image_type, contrast, mount_medium, sample_type, sample_source)
  VALUES (obs, owner_id, owner_id::text || '/spv-b.webp', 'microscope', 'not_set', '', 'soaked', 'gill')
  RETURNING id INTO img_b;
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, deleted_at)
  VALUES (obs, owner_id, owner_id::text || '/spv-deleted.webp', 'microscope', now())
  RETURNING id INTO img_gone;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_gone, owner_id, 99, 9, 'spore', owner_id::text || '/deleted-thumb.webp');
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, purged_at)
  VALUES (obs, owner_id, owner_id::text || '/spv-purged.webp', 'microscope', now())
  RETURNING id INTO img_gone;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_gone, owner_id, 98, 8, 'spore');

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_a, owner_id, 10.5, 7.25, 'manual', owner_id::text || '/m1.webp')
  RETURNING id INTO m1;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_a, owner_id, 11, 0, NULL, owner_id::text || '/m2.webp')
  RETURNING id INTO m2;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_a, owner_id, 9.75, NULL, ' Spores ');
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_b, owner_id, 12, 8, '');
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_b, owner_id, 40, 10, 'cystidia', owner_id::text || '/cyst.webp');

  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (obs, owner_id, owner_id::text || '/mosaic-v1.webp', 100, 100, 50, 1)
  RETURNING id INTO mosaic_old;
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
     tile_width_px, tile_height_px, common_crop_width_um, common_crop_height_um)
  VALUES (obs, owner_id, owner_id::text || '/mosaic-v2.webp', 400, 200, 100, 2, 100, 100, 20.5, 20.5)
  RETURNING id INTO mosaic_new;
  INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px, overlay_json)
  VALUES
    (m1, mosaic_new, 0, 0, 100, 100, '{"style":"a","line":[[1,2],[3,4]]}'::jsonb),
    (m2, mosaic_new, 100, 0, 100, 100, NULL);

  -- metadata_parent_public: storage-less microscope parent that is itself
  -- public microscopy, so its points count.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-02', 'Russula', 'emetica', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('metadata_parent_public', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose, contrast)
  VALUES (obs, owner_id, NULL, 'microscope', 'public_microscopy', 'DIC')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_meta, owner_id, 8, 6, 'spore');

  -- metadata_parent_private: storage-less microscope parent that is not a
  -- public-microscopy parent, so its points are excluded.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-03', 'Russula', 'nobilis', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('metadata_parent_private', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs, owner_id, NULL, 'microscope', 'owner_sync')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_meta, owner_id, 8, 6, 'spore');

  -- no_images / field_image_only / no_measurements: image and measurement gates.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'edulis', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('no_images', obs);

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'pinophilus', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('field_image_only', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs, owner_id, owner_id::text || '/field.webp', 'field')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_meta, owner_id, 8, 6, 'spore');

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'reticulatus', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('no_measurements', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs, owner_id, owner_id::text || '/micro-empty.webp', 'microscope');

  -- Observation-level gates and spore_data_visibility values. Each of these
  -- gets one public spore-bearing image so a leaked point would show.
  FOREACH label IN ARRAY ARRAY[
    'private', 'friends', 'draft', 'banned_owner', 'deleted',
    'spore_friends', 'spore_private', 'spore_null'
  ]
  LOOP
    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (
      CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END,
      '2026-10-05', 'Cortinarius', label,
      CASE label WHEN 'private' THEN 'private' WHEN 'friends' THEN 'friends' ELSE 'public' END,
      label = 'draft',
      'hidden',
      CASE label WHEN 'spore_friends' THEN 'friends' WHEN 'spore_private' THEN 'private'
                 WHEN 'spore_null' THEN NULL ELSE 'public' END
    )
    RETURNING id INTO obs;
    INSERT INTO spv_fixture VALUES (label, obs);
    INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
    VALUES (obs, CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END,
            CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END::text || '/' || label || '.webp',
            'microscope')
    RETURNING id INTO img_meta;
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
    VALUES (img_meta, CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END, 8, 6, 'spore', 'x/' || label);
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs, CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END, 'mosaic/' || label, 10, 10, 10, 1);
  END LOOP;

  UPDATE public.profiles SET is_banned = true WHERE id = banned_id;
  DELETE FROM public.observations
   WHERE id = (SELECT observation_id FROM spv_fixture fx WHERE fx.label = 'deleted');
END
$fixtures$;
-- @fixtures-end

DO $test$
DECLARE
  card_keys CONSTANT text[] := ARRAY[
    'id', 'lengthUm', 'widthUm', 'cropUrl',
    'mosaicX', 'mosaicY', 'mosaicW', 'mosaicH',
    'contrastMethod', 'mountReagent', 'sampleType', 'sampleSource'
  ];
  all_ids bigint[];
  v record;
  f record;
  batch record;
  single record;
  expected_points jsonb;
  n bigint;
  payload jsonb;
  mosaic jsonb;
  full_id bigint;
  err_state text;
  err_message text;
BEGIN
  SELECT array_agg(observation_id ORDER BY label) INTO all_ids FROM spv_fixture;
  full_id := (SELECT observation_id FROM spv_fixture WHERE label = 'full');

  -- ── Visibility matrix: expected outcome per fixture and viewer ────────────
  -- row: does the batch return a row? points: are points/mosaic non-null?
  FOR v IN SELECT * FROM spv_viewer LOOP
    PERFORM set_config('request.jwt.claim.sub', coalesce(v.user_id::text, ''), true);
    PERFORM set_config('request.jwt.claims',
      CASE WHEN v.user_id IS NULL THEN jsonb_build_object('role', 'anon')
           ELSE jsonb_build_object('sub', v.user_id::text, 'role', 'authenticated') END::text,
      true);

    FOR f IN
      SELECT fx.label, fx.observation_id,
             CASE
               WHEN fx.label IN ('private', 'friends', 'draft', 'banned_owner', 'deleted') THEN false
               WHEN v.label = 'blocker' THEN false
               ELSE true
             END AS want_row,
             fx.label IN ('full', 'metadata_parent_public') AS want_points,
             fx.label IN ('full') AS want_mosaic
        FROM spv_fixture fx
    LOOP
      SELECT count(*) INTO n
        FROM public.get_public_observation_spore_previews(ARRAY[f.observation_id]);
      IF n <> (CASE WHEN f.want_row THEN 1 ELSE 0 END) THEN
        RAISE EXCEPTION 'matrix: % as %: expected % rows, got %', f.label, v.label, f.want_row::int, n;
      END IF;

      SELECT * INTO batch FROM public.get_public_observation_spore_previews(ARRAY[f.observation_id]);
      SELECT * INTO single FROM public.get_public_observation(f.observation_id);

      -- Row presence agrees with get_public_observation.
      IF (batch.observation_id IS NULL) <> (single.id IS NULL) THEN
        RAISE EXCEPTION 'parity: % as %: batch row % but get_public_observation row %',
          f.label, v.label, batch.observation_id IS NOT NULL, single.id IS NOT NULL;
      END IF;
      CONTINUE WHEN NOT f.want_row;

      IF (batch.points IS NOT NULL) <> f.want_points THEN
        RAISE EXCEPTION 'matrix: % as %: points expected %, got %', f.label, v.label, f.want_points, batch.points;
      END IF;
      IF (batch.spore_mosaic IS NOT NULL) <> f.want_mosaic THEN
        RAISE EXCEPTION 'matrix: % as %: mosaic expected %, got %', f.label, v.label, f.want_mosaic, batch.spore_mosaic;
      END IF;

      -- Parity: mosaic equal; points equal get_public_observation's points
      -- reduced to the card keys, element for element and in order.
      IF batch.spore_mosaic IS DISTINCT FROM single."sporeMosaic" THEN
        RAISE EXCEPTION 'parity: % as %: mosaic % <> %', f.label, v.label, batch.spore_mosaic, single."sporeMosaic";
      END IF;
      SELECT CASE WHEN single."sporePoints" IS NULL THEN NULL ELSE coalesce(jsonb_agg((
               SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
                 FROM jsonb_each(pt.value) kv WHERE kv.key = ANY (card_keys)
             ) ORDER BY pt.ord), '[]'::jsonb) END
        INTO expected_points
        FROM jsonb_array_elements(coalesce(single."sporePoints", '[]'::jsonb)) WITH ORDINALITY pt(value, ord);
      IF batch.points IS DISTINCT FROM expected_points THEN
        RAISE EXCEPTION 'parity: % as %: points % <> %', f.label, v.label, batch.points, expected_points;
      END IF;
    END LOOP;
  END LOOP;

  -- ── Concrete values for the full fixture (anon) ───────────────────────────
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT points, spore_mosaic INTO payload, mosaic
    FROM public.get_public_observation_spore_previews(ARRAY[full_id]);

  -- 4 public spore points: m1, m2, the ' Spores ' one and the '' one on the
  -- microscope image. Excluded: cystidia, deleted image, purged image.
  IF jsonb_array_length(payload) <> 4 THEN
    RAISE EXCEPTION 'full: expected 4 points, got %', payload;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(payload) pt, jsonb_object_keys(pt.value) k
     WHERE k <> ALL (card_keys)
  ) THEN
    RAISE EXCEPTION 'full: a point carries a non-card key: %', payload;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(payload) pt WHERE (pt.value->>'lengthUm')::numeric IN (99, 98, 40)) THEN
    RAISE EXCEPTION 'full: a gated point leaked: %', payload;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(payload) pt
     WHERE pt.value->>'lengthUm' = '10.5'
       AND pt.value->>'cropUrl' ~ '^https://upload\.example\.test/m/[0-9]+/thumb\?v=[0-9]+$'
       AND pt.value->>'contrastMethod' = 'BF'
       AND pt.value->>'mountReagent' = 'Water'
       AND pt.value->>'sampleType' = 'fresh'
       AND pt.value->>'sampleSource' = 'spore_print'
       AND (pt.value->>'mosaicW')::int = 100
       AND pt.value ? 'mosaicX'
  ) THEN
    RAISE EXCEPTION 'full: card fields of m1 are wrong: %', payload;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(payload) pt
     WHERE pt.value->>'lengthUm' = '12'
       AND (pt.value ? 'contrastMethod' AND pt.value->>'contrastMethod' <> 'not_set'
            OR pt.value ? 'mountReagent' OR pt.value ? 'sampleType' OR pt.value ? 'sampleSource'
            OR pt.value ? 'cropUrl')
  ) THEN
    RAISE EXCEPTION 'full: normalization of the microscope-image point differs: %', payload;
  END IF;
  IF mosaic->>'version' <> '2' OR NOT mosaic ? 'mosaicMediaUrl'
     OR mosaic->>'mosaicMediaUrl' !~ '^https://upload\.example\.test/' THEN
    RAISE EXCEPTION 'full: mosaic is not the latest authorized one: %', mosaic;
  END IF;

  -- ── Bounds ────────────────────────────────────────────────────────────────
  IF (SELECT count(*) FROM public.get_public_observation_spore_previews(NULL)) <> 0 THEN
    RAISE EXCEPTION 'bounds: NULL input returned rows';
  END IF;
  IF (SELECT count(*) FROM public.get_public_observation_spore_previews('{}'::bigint[])) <> 0 THEN
    RAISE EXCEPTION 'bounds: empty input returned rows';
  END IF;
  IF (SELECT count(*) FROM public.get_public_observation_spore_previews(ARRAY[full_id, full_id, NULL, full_id])) <> 1 THEN
    RAISE EXCEPTION 'bounds: duplicates were not collapsed to one row';
  END IF;
  IF (SELECT count(*) FROM public.get_public_observation_spore_previews(
        array_fill(full_id, ARRAY[59]) || ARRAY[-1::bigint])) <> 1 THEN
    RAISE EXCEPTION 'bounds: 60 ids should be accepted';
  END IF;
  SELECT count(*) INTO n FROM public.get_public_observation_spore_previews(all_ids);
  IF n <> (SELECT count(*) FROM spv_fixture
            WHERE label NOT IN ('private', 'friends', 'draft', 'banned_owner', 'deleted')) THEN
    RAISE EXCEPTION 'bounds: whole-fixture batch returned % rows', n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT observation_id, lag(observation_id) OVER () AS prev
        FROM public.get_public_observation_spore_previews(all_ids)
    ) s WHERE s.prev >= s.observation_id
  ) THEN
    RAISE EXCEPTION 'bounds: rows are not in observation_id order';
  END IF;

  BEGIN
    PERFORM public.get_public_observation_spore_previews(array_fill(full_id, ARRAY[61]));
    RAISE EXCEPTION 'bounds: 61 ids were accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS err_message = MESSAGE_TEXT;
    IF err_message NOT LIKE '%at most 60 observation ids, got 61%' THEN
      RAISE EXCEPTION 'bounds: unexpected 61-id error: %', err_message;
    END IF;
  END;
  BEGIN
    PERFORM public.get_public_observation_spore_previews(array_fill(NULL::bigint, ARRAY[61]));
    RAISE EXCEPTION 'bounds: 61 NULL elements were accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.get_public_observation_spore_previews(array_fill(full_id, ARRAY[8, 8]));
    RAISE EXCEPTION 'bounds: a 64-element 2-D array was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- ── Grants, owner, SECURITY DEFINER and search_path ───────────────────────
  IF NOT has_function_privilege('anon', 'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants: anon and authenticated must be able to execute';
  END IF;
  IF has_function_privilege('service_role', 'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'grants: service_role was not granted execute by this contract';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = 'public.get_public_observation_spore_previews(bigint[])'::regprocedure
       AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'grants: PUBLIC holds a privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.get_public_observation_spore_previews(bigint[])'::regprocedure
       AND p.prosecdef
       AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=""']
       AND pg_get_userbyid(p.proowner) = 'postgres'
  ) THEN
    RAISE EXCEPTION 'shape: expected STABLE SECURITY DEFINER, owner postgres, search_path=""';
  END IF;

  FOR f IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig
      FROM pg_proc p
     WHERE p.pronamespace = 'private'::regnamespace
       AND p.proname IN ('public_observation_eligibility', 'public_observation_spore_points_raw',
                         'public_observation_spore_mosaic_raw', 'public_observation_authorize_spore_points',
                         'public_observation_authorize_spore_mosaic')
  LOOP
    IF has_function_privilege('anon', f.fn, 'EXECUTE')
       OR has_function_privilege('authenticated', f.fn, 'EXECUTE')
       OR has_function_privilege('service_role', f.fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'grants: % is executable by a client role', f.fn;
    END IF;
    IF NOT f.prosecdef OR f.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
      RAISE EXCEPTION 'shape: % must be SECURITY DEFINER with search_path=""', f.fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'private'::regnamespace
         AND p.proname LIKE 'public_observation_%') <> 5 THEN
    RAISE EXCEPTION 'shape: expected exactly five private public_observation_* helpers';
  END IF;
END
$test$;

-- ── Called through the client roles (EXECUTE path as PostgREST uses it) ────
DO $roles$
DECLARE
  full_id bigint := (SELECT observation_id FROM spv_fixture WHERE label = 'full');
  stranger uuid := (SELECT user_id FROM spv_viewer WHERE label = 'stranger');
  blocker uuid := (SELECT user_id FROM spv_viewer WHERE label = 'blocker');
  n bigint;
BEGIN
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT count(*) INTO n FROM public.get_public_observation_spore_previews(ARRAY[full_id]);
  IF n <> 1 THEN RAISE EXCEPTION 'roles: anon got % rows', n; END IF;
  BEGIN
    PERFORM private.public_observation_eligibility(ARRAY[full_id]);
    RAISE EXCEPTION 'roles: anon can call a private helper';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', stranger::text, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n FROM public.get_public_observation_spore_previews(ARRAY[full_id]);
  IF n <> 1 THEN RAISE EXCEPTION 'roles: stranger got % rows', n; END IF;

  PERFORM set_config('request.jwt.claim.sub', blocker::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', blocker::text, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n FROM public.get_public_observation_spore_previews(ARRAY[full_id]);
  IF n <> 0 THEN RAISE EXCEPTION 'roles: blocked viewer got % rows', n; END IF;
  RESET ROLE;
END
$roles$;

SELECT 'public_observation_spore_previews_test: ok' AS result;

ROLLBACK;
