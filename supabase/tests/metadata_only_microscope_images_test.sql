-- Fixture and assertions for metadata-only microscope image rows.
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/metadata_only_microscope_images_test.sql
--
-- The fixture cleans up its rows before returning. If an assertion fails, the
-- single DO statement aborts and rolls back its own changes.

DO $$
DECLARE
  owner_user_id uuid := '00000000-0000-4000-8000-00000000aa01';
  other_user_id uuid := '00000000-0000-4000-8000-00000000aa02';
  obs_id bigint;
  other_obs_id bigint;
  real_image_id bigint;
  meta_image_id bigint;
  real_measurement_id bigint;
  meta_measurement_id bigint;
  mosaic_id bigint;
  rpc_row record;
  img_row record;
  pt_count int;
  meta_pt_count int;
  real_pt_count int;
  rls_error text;
  test_species_slug text := 'metadatatestus-onlyanchorus';
BEGIN
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility DROP NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision DROP NOT NULL';

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_user_id, 'authenticated', 'authenticated', 'meta-owner@example.test', '{"full_name":"Meta Owner"}'::jsonb, now(), now()),
    (other_user_id, 'authenticated', 'authenticated', 'meta-other@example.test', '{"full_name":"Other User"}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_user_id, 'meta_owner', 'Meta Owner', false),
    (other_user_id, 'meta_other', 'Other User', false)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (
    user_id, date, genus, species, common_name, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    owner_user_id, '2026-07-01', 'Metadatatestus', 'onlyanchorus', 'Metadata Test',
    'public', false, 'public', 'exact', 'NO'
  )
  RETURNING id INTO obs_id;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    other_user_id, '2026-07-01', 'Metaowner', 'other', 'public', false,
    'public', 'exact', 'NO'
  )
  RETURNING id INTO other_obs_id;

  -- Real storage row: mimics an actually-uploaded microscope image.
  -- scale_microns_per_pixel is set here so we can assert it flows
  -- through the public image RPCs (Stage 2A landing scale-bar plumbing).
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    sort_order, source_width, source_height, stored_width, stored_height,
    contrast, mount_medium, sample_type,
    scale_microns_per_pixel
  )
  VALUES (
    obs_id, owner_user_id, owner_user_id::text || '/meta-real.webp', 'microscope',
    0, 4000, 3000, 800, 600,
    'brightfield', 'water', 'fresh',
    0.25
  )
  RETURNING id INTO real_image_id;

  -- Metadata-only microscope row: no storage_path.
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type
  )
  VALUES (obs_id, owner_user_id, NULL, 'microscope')
  RETURNING id INTO meta_image_id;

  -- Field image without calibration — represents the common case for
  -- non-microscope photos. Used to assert the public image RPCs return
  -- scaleMicronsPerPixel = NULL cleanly (rather than 0 or absent).
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    sort_order, source_width, source_height, stored_width, stored_height
  )
  VALUES (
    obs_id, owner_user_id, owner_user_id::text || '/meta-field.webp', 'field',
    1, 2000, 1500, 800, 600
  );

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (real_image_id, owner_user_id, 10.0, 5.0, 'manual')
  RETURNING id INTO real_measurement_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (meta_image_id, owner_user_id, 12.0, 6.0, 'manual')
  RETURNING id INTO meta_measurement_id;

  -- Public mosaic covering both measurements.
  INSERT INTO public.spore_measurement_mosaics (
    observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version
  )
  VALUES (obs_id, owner_user_id, 'mosaic/meta-test-v1.webp', 256, 128, 128, 1)
  RETURNING id INTO mosaic_id;

  INSERT INTO public.spore_measurement_mosaic_tiles (
    measurement_id, mosaic_id, x_px, y_px, w_px, h_px, overlay_json
  )
  VALUES
    (real_measurement_id, mosaic_id, 0, 0, 128, 128, NULL),
    (meta_measurement_id, mosaic_id, 128, 0, 128, 128, NULL);

  -- ── CHECK constraint on non-microscope rows with NULL storage_path ──────────

  BEGIN
    INSERT INTO public.observation_images (
      observation_id, user_id, storage_path, image_type
    )
    VALUES (obs_id, owner_user_id, NULL, 'field');
    RAISE EXCEPTION 'CHECK constraint: expected NULL storage_path for image_type=field to be rejected';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO public.observation_images (
      observation_id, user_id, storage_path, image_type
    )
    VALUES (obs_id, owner_user_id, NULL, NULL);
    RAISE EXCEPTION 'CHECK constraint: expected NULL storage_path with NULL image_type to be rejected';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  -- Sanity: non-null storage_path still accepted for microscope.
  IF (SELECT count(*)
      FROM public.observation_images
      WHERE observation_id = obs_id
        AND image_type = 'microscope') IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Expected 2 microscope rows for observation %', obs_id;
  END IF;

  -- ── search_public_observation_images: skip NULL storage_path ────────────────
  -- Two visible rows now: the real microscope image AND the field image
  -- fixture (added for scaleMicronsPerPixel = NULL coverage). The
  -- metadata-only microscope row (NULL storage_path) must still be
  -- filtered out — asserted by the imageId NOT-IN check below.

  IF (SELECT count(*) FROM public.search_public_observation_images(ARRAY[obs_id])) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'search_public_observation_images should return two rows (real microscope + field); got %',
      (SELECT count(*) FROM public.search_public_observation_images(ARRAY[obs_id]));
  END IF;

  SELECT * INTO img_row
  FROM public.search_public_observation_images(ARRAY[obs_id])
  WHERE "imageId" = real_image_id
  LIMIT 1;
  IF img_row."imageId" IS DISTINCT FROM real_image_id THEN
    RAISE EXCEPTION 'search_public_observation_images did not surface the real microscope row (got imageId=%)',
      img_row."imageId";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.search_public_observation_images(ARRAY[obs_id])
    WHERE "imageId" = meta_image_id
  ) THEN
    RAISE EXCEPTION 'Metadata-only microscope image leaked into search_public_observation_images';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.search_public_observation_images(ARRAY[obs_id])
    WHERE "thumbUrl" ILIKE '%null%' OR "previewUrl" ILIKE '%null%'
  ) THEN
    RAISE EXCEPTION 'Public image URL contained a null segment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_images(obs_id)
    WHERE "imageId" = meta_image_id
  ) THEN
    RAISE EXCEPTION 'Metadata-only microscope image leaked into get_public_observation_images';
  END IF;

  -- scaleMicronsPerPixel flows through both image RPCs for the real
  -- storage row. Fixture sets 0.25 on real_image_id; NULL on the
  -- metadata-only row (which shouldn't appear here anyway).
  SELECT * INTO img_row
  FROM public.search_public_observation_images(ARRAY[obs_id])
  WHERE "imageId" = real_image_id
  LIMIT 1;
  IF img_row."imageId" IS DISTINCT FROM real_image_id THEN
    RAISE EXCEPTION 'search_public_observation_images did not return the real-storage row';
  END IF;
  IF img_row."scaleMicronsPerPixel" IS DISTINCT FROM 0.25::double precision THEN
    RAISE EXCEPTION 'search_public_observation_images: expected scaleMicronsPerPixel=0.25, got %',
      img_row."scaleMicronsPerPixel";
  END IF;

  SELECT * INTO img_row
  FROM public.get_public_observation_images(obs_id)
  WHERE "imageId" = real_image_id
  LIMIT 1;
  IF img_row."scaleMicronsPerPixel" IS DISTINCT FROM 0.25::double precision THEN
    RAISE EXCEPTION 'get_public_observation_images: expected scaleMicronsPerPixel=0.25, got %',
      img_row."scaleMicronsPerPixel";
  END IF;

  -- Field / uncalibrated row: RPC must return the row (it has a
  -- storage_path so it is a legitimate public image) with
  -- scaleMicronsPerPixel = NULL, not 0 or missing.
  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_observation_images(ARRAY[obs_id])
    WHERE "imageType" = 'field' AND "scaleMicronsPerPixel" IS NULL
  ) THEN
    RAISE EXCEPTION 'search_public_observation_images: field image with no calibration should return scaleMicronsPerPixel NULL';
  END IF;

  -- ── search_public_species: representativeThumbUrl must not use NULL row ─────

  IF EXISTS (
    SELECT 1
    FROM public.search_public_species(p_query := 'Metadatatestus')
    WHERE "speciesSlug" = test_species_slug
      AND ("representativeThumbUrl" IS NULL
           OR "representativeThumbUrl" ILIKE '%null%')
  ) THEN
    RAISE EXCEPTION 'search_public_species representativeThumbUrl leaked null path for species %', test_species_slug;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.search_public_species(p_query := 'Metadatatestus')
    WHERE "speciesSlug" = test_species_slug
      AND "representativeThumbUrl" =
        'https://media.sporely.no/' || owner_user_id::text || '/thumb_meta-real.webp'
  ) THEN
    RAISE EXCEPTION 'search_public_species representativeThumbUrl did not point to the real-storage image';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.get_public_species(test_species_slug)
    WHERE "representativeThumbUrl" IS NULL
       OR "representativeThumbUrl" ILIKE '%null%'
  ) THEN
    RAISE EXCEPTION 'get_public_species representativeThumbUrl leaked null path';
  END IF;

  -- ── get_public_observation: sporePoints must include metadata-only anchor ──

  SELECT * INTO rpc_row FROM public.get_public_observation(obs_id);
  IF rpc_row.id IS DISTINCT FROM obs_id THEN
    RAISE EXCEPTION 'get_public_observation did not return the metadata test observation';
  END IF;

  IF rpc_row."sporePoints" IS NULL THEN
    RAISE EXCEPTION 'get_public_observation sporePoints is null for the metadata test observation';
  END IF;

  pt_count := jsonb_array_length(rpc_row."sporePoints");
  IF pt_count IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'get_public_observation sporePoints expected 2 points, got %', pt_count;
  END IF;

  -- Points from real-storage image are present.
  SELECT count(*) INTO real_pt_count
  FROM jsonb_array_elements(rpc_row."sporePoints") pt
  WHERE (pt->>'imageId')::bigint = real_image_id;
  IF real_pt_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected 1 sporePoint from real-storage image, got %', real_pt_count;
  END IF;

  -- Points from metadata-only image are present.
  SELECT count(*) INTO meta_pt_count
  FROM jsonb_array_elements(rpc_row."sporePoints") pt
  WHERE (pt->>'imageId')::bigint = meta_image_id;
  IF meta_pt_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected 1 sporePoint from metadata-only microscope image, got %', meta_pt_count;
  END IF;

  -- sporeMeasurementCount includes metadata-only anchor.
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'sporeMeasurementCount expected 2 (incl. metadata-only), got %',
      rpc_row."sporeMeasurementCount";
  END IF;

  IF rpc_row."hasMicroscopy" IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'hasMicroscopy expected true, got %', rpc_row."hasMicroscopy";
  END IF;

  -- Mosaic still exposes the tile that anchors the metadata-only measurement.
  IF rpc_row."sporeMosaic" IS NULL THEN
    RAISE EXCEPTION 'sporeMosaic missing for the metadata test observation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(rpc_row."sporePoints") pt
    WHERE (pt->>'imageId')::bigint = meta_image_id
      AND pt ? 'mosaicX'
      AND pt ? 'mosaicY'
      AND pt ? 'mosaicW'
      AND pt ? 'mosaicH'
  ) THEN
    RAISE EXCEPTION 'metadata-only sporePoint missing mosaic tile coordinates';
  END IF;

  -- No sporePoint may leak a null-containing URL.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(rpc_row."sporePoints") pt
    WHERE coalesce(pt->>'cropUrl', '') ILIKE '%media.sporely.no/null%'
  ) THEN
    RAISE EXCEPTION 'sporePoints cropUrl contained a null segment';
  END IF;

  -- Insert an image row on the OTHER user's observation as a fixture for the
  -- non-owner update/delete tests below (done via superuser before we switch
  -- roles). This row is genuinely owned by other_user.
  DECLARE
    other_owner_image_id bigint;
  BEGIN
    INSERT INTO public.observation_images (
      observation_id, user_id, storage_path, image_type
    )
    VALUES (
      other_obs_id, other_user_id,
      other_user_id::text || '/other-real.webp', 'microscope'
    )
    RETURNING id INTO other_owner_image_id;

    -- ── RLS as owner_user_id ────────────────────────────────────────────────
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', owner_user_id::text, true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', owner_user_id::text, 'role', 'authenticated')::text,
      true);

    -- (1) Owner can insert metadata-only microscope row into own observation.
    INSERT INTO public.observation_images (
      observation_id, user_id, storage_path, image_type
    )
    VALUES (obs_id, owner_user_id, NULL, 'microscope');
    -- (2) Owner cannot insert metadata-only microscope row into ANOTHER user's
    --     observation while setting user_id = self. RLS must reject.
    BEGIN
      INSERT INTO public.observation_images (
        observation_id, user_id, storage_path, image_type
      )
      VALUES (other_obs_id, owner_user_id, NULL, 'microscope');
      RESET ROLE;
      RAISE EXCEPTION 'RLS T2: owner unexpectedly inserted metadata row into another user''s observation';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    -- (3) Owner cannot insert real-storage image row into another user's
    --     observation while setting user_id = self.
    BEGIN
      INSERT INTO public.observation_images (
        observation_id, user_id, storage_path, image_type
      )
      VALUES (
        other_obs_id, owner_user_id,
        owner_user_id::text || '/should-not-happen.webp', 'microscope'
      );
      RESET ROLE;
      RAISE EXCEPTION 'RLS T3: owner unexpectedly inserted real-storage row into another user''s observation';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;

    -- Owner still cannot insert NULL-storage non-microscope row. RLS WITH
    -- CHECK now fires before the table CHECK constraint (RLS is evaluated
    -- first), so accept either failure class.
    BEGIN
      INSERT INTO public.observation_images (
        observation_id, user_id, storage_path, image_type
      )
      VALUES (obs_id, owner_user_id, NULL, 'field');
      RESET ROLE;
      RAISE EXCEPTION 'RLS/CHECK: owner unexpectedly inserted NULL-storage non-microscope row';
    EXCEPTION
      WHEN check_violation THEN NULL;
      WHEN insufficient_privilege THEN NULL;
    END;
    -- (4) Owner cannot update their own image row to point at another user's
    --     observation. RLS WITH CHECK must reject.
    BEGIN
      UPDATE public.observation_images
      SET observation_id = other_obs_id
      WHERE id = real_image_id;
      RESET ROLE;
      RAISE EXCEPTION 'RLS T4: owner unexpectedly moved image row to another user''s observation';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    -- (5) Owner cannot update storage_path to another user's prefix.
    BEGIN
      UPDATE public.observation_images
      SET storage_path = other_user_id::text || '/spoof.webp'
      WHERE id = real_image_id;
      RESET ROLE;
      RAISE EXCEPTION 'RLS T5: owner unexpectedly updated storage_path to another user''s prefix';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;
    -- (6) is deferred to the next block — we need a field-type fixture row
    -- inserted as superuser first, so we reset role and continue below.
    RESET ROLE;
  END;

  DECLARE
    field_row_id bigint;
    upd_count integer;
  BEGIN
    INSERT INTO public.observation_images (
      observation_id, user_id, storage_path, image_type
    )
    VALUES (
      obs_id, owner_user_id,
      owner_user_id::text || '/owner-field.webp', 'field'
    )
    RETURNING id INTO field_row_id;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', owner_user_id::text, true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', owner_user_id::text, 'role', 'authenticated')::text,
      true);
    -- (6) Owner cannot NULL-out storage_path on a non-microscope row.
    BEGIN
      UPDATE public.observation_images
      SET storage_path = NULL
      WHERE id = field_row_id;
      RESET ROLE;
      RAISE EXCEPTION 'RLS/CHECK T6: owner unexpectedly nulled storage_path on non-microscope row';
    EXCEPTION
      WHEN insufficient_privilege THEN NULL;
      WHEN check_violation THEN NULL;
    END;
    -- (7) Owner CAN update allowed metadata fields on their own microscope
    --     metadata-only row (contrast/mount_medium/notes). storage_path is
    --     left NULL.
    UPDATE public.observation_images
    SET contrast = 'DIC',
        mount_medium = 'KOH',
        notes = 'metadata-only edit'
    WHERE id = meta_image_id;

    GET DIAGNOSTICS upd_count = ROW_COUNT;
    IF upd_count IS DISTINCT FROM 1 THEN
      RESET ROLE;
      RAISE EXCEPTION 'RLS T7: owner metadata edit affected % rows (expected 1)', upd_count;
    END IF;

    RESET ROLE;

    IF NOT EXISTS (
      SELECT 1 FROM public.observation_images
      WHERE id = meta_image_id
        AND contrast = 'DIC'
        AND mount_medium = 'KOH'
        AND notes = 'metadata-only edit'
        AND storage_path IS NULL
    ) THEN
      RAISE EXCEPTION 'RLS T7: metadata edit did not persist on metadata-only row';
    END IF;
    -- (9) Non-owner cannot update another user's image row.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', other_user_id::text, true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', other_user_id::text, 'role', 'authenticated')::text,
      true);

    UPDATE public.observation_images
    SET notes = 'hostile edit'
    WHERE id = real_image_id;

    GET DIAGNOSTICS upd_count = ROW_COUNT;
    IF upd_count IS DISTINCT FROM 0 THEN
      RESET ROLE;
      RAISE EXCEPTION 'RLS T9-update: non-owner update affected % rows (expected 0)', upd_count;
    END IF;
    -- (9) Non-owner cannot delete another user's image row.
    DELETE FROM public.observation_images
    WHERE id = real_image_id;

    GET DIAGNOSTICS upd_count = ROW_COUNT;
    IF upd_count IS DISTINCT FROM 0 THEN
      RESET ROLE;
      RAISE EXCEPTION 'RLS T9-delete: non-owner delete affected % rows (expected 0)', upd_count;
    END IF;
    -- (2b) Non-owner cannot insert into someone else's observation while
    --      spoofing the owner's user_id. This was already the strict case.
    BEGIN
      INSERT INTO public.observation_images (
        observation_id, user_id, storage_path, image_type
      )
      VALUES (obs_id, owner_user_id, NULL, 'microscope');
      RESET ROLE;
      RAISE EXCEPTION 'RLS T2b: non-owner unexpectedly inserted metadata row spoofing owner user_id';
    EXCEPTION
      WHEN insufficient_privilege THEN
        NULL;
    END;

    RESET ROLE;
    -- (8) Owner can delete their own field-type image row (own image + own
    --     observation), verifying DELETE still works for owners.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', owner_user_id::text, true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', owner_user_id::text, 'role', 'authenticated')::text,
      true);

    DELETE FROM public.observation_images WHERE id = field_row_id;
    GET DIAGNOSTICS upd_count = ROW_COUNT;
    IF upd_count IS DISTINCT FROM 1 THEN
      RESET ROLE;
      RAISE EXCEPTION 'RLS T8: owner delete of own row affected % rows (expected 1)', upd_count;
    END IF;

    RESET ROLE;
  END;

  -- Cleanup.
  DELETE FROM public.observation_images WHERE observation_id IN (obs_id, other_obs_id);
  DELETE FROM public.observations WHERE id IN (obs_id, other_obs_id);
  DELETE FROM auth.users WHERE id IN (owner_user_id, other_user_id);

  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility SET NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision SET NOT NULL';
END
$$;
