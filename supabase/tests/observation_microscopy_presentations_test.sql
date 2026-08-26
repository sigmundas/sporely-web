-- Validation fixture for public.get_observation_microscopy_presentations
-- (batch-capable, owner-aware microscopy presentation read contract).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/observation_microscopy_presentations_test.sql
--
-- Assertions cover:
--   M1:  owner reads own draft / private observation
--   M2:  public observation visible to anonymous caller
--   M3:  authenticated non-owner reads public observation
--   M4:  accepted friend reads friends-only observation
--   M5:  spore data withheld (NULL) when can_access_spore_data returns false (anon)
--   M6:  blocked user cannot read observation
--   M7:  banned author's observation is hidden
--   M8:  latest mosaic selected by version DESC, id DESC tiebreak
--   M9:  sporeMosaic contains no storageKey; sporeSummary exposes only allowlisted fields
--   M10: empty input returns zero rows
--   M11: unknown ids return zero rows
--   M12: private / draft / friends-only observations hidden from anon / non-owner
--   M13: observation with zero active microscope measurements returns sporeMeasurementCount = 0
--   M14: authenticated non-owner reading public obs with spore_data_visibility=private gets NULL spore fields
--   M15: calling with 201 distinct ids raises an explicit error
--   M16: 201 raw elements deduplicating to 1 distinct id succeeds (no raise)

BEGIN;

DO $$
DECLARE
  owner_id        uuid := '00000000-0000-4000-8000-000000000201';
  friend_id       uuid := '00000000-0000-4000-8000-000000000202';
  outsider_id     uuid := '00000000-0000-4000-8000-000000000203';
  banned_id       uuid := '00000000-0000-4000-8000-000000000204';
  blocker_id      uuid := '00000000-0000-4000-8000-000000000205';

  public_obs_id        bigint;
  draft_obs_id         bigint;
  private_obs_id       bigint;
  friends_obs_id       bigint;
  spore_private_obs_id bigint;
  banned_obs_id        bigint;
  mosaic_obs_id        bigint;
  blocked_obs_id       bigint;
  zero_meas_obs_id     bigint;

  mosaic_id_v1   bigint;
  mosaic_id_v2   bigint;
  mosaic_id_v2b  bigint;

  image_id         bigint;
  field_image_id   bigint;
  purged_image_id  bigint;

  row_count   int;
  mosaic_json jsonb;
  summary_json jsonb;
BEGIN
  -- Relax NOT NULL constraints that test fixtures trigger (restored by ROLLBACK).
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility DROP NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision DROP NOT NULL';

  -- ── Auth users ───────────────────────────────────────────────────────
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,    'authenticated', 'authenticated', 'mcp-owner@example.test',    '{}'::jsonb, now(), now()),
    (friend_id,   'authenticated', 'authenticated', 'mcp-friend@example.test',   '{}'::jsonb, now(), now()),
    (outsider_id, 'authenticated', 'authenticated', 'mcp-outsider@example.test', '{}'::jsonb, now(), now()),
    (banned_id,   'authenticated', 'authenticated', 'mcp-banned@example.test',   '{}'::jsonb, now(), now()),
    (blocker_id,  'authenticated', 'authenticated', 'mcp-blocker@example.test',  '{}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_id,    'mcp_owner',    'MCP Owner',    false),
    (friend_id,   'mcp_friend',   'MCP Friend',   false),
    (outsider_id, 'mcp_outsider', 'MCP Outsider', false),
    (banned_id,   'mcp_banned',   'MCP Banned',   true),
    (blocker_id,  'mcp_blocker',  'MCP Blocker',  false)
  ON CONFLICT (id) DO UPDATE
    SET username     = EXCLUDED.username,
        display_name = EXCLUDED.display_name,
        is_banned    = EXCLUDED.is_banned;

  -- ── Friendship (owner ↔ friend, accepted) ────────────────────────────
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, friend_id, 'accepted');

  -- ── Block (blocker_id blocks owner_id) ──────────────────────────────
  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (blocker_id, owner_id);

  -- ── Observations ─────────────────────────────────────────────────────
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-01', 'Russula', 'emetica', 'public',  'public',  false)
  RETURNING id INTO public_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-02', 'Russula', 'emetica', 'public',  'public',  true)
  RETURNING id INTO draft_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-03', 'Russula', 'emetica', 'private', 'private', false)
  RETURNING id INTO private_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-04', 'Russula', 'emetica', 'friends', 'friends', false)
  RETURNING id INTO friends_obs_id;

  -- Public observation but spore data is private.
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-05', 'Russula', 'emetica', 'public',  'private', false)
  RETURNING id INTO spore_private_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (banned_id, '2026-07-06', 'Russula', 'emetica', 'public', 'public',  false)
  RETURNING id INTO banned_obs_id;

  -- Observation used to test mosaic version ordering.
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-07', 'Russula', 'emetica', 'public',  'public',  false)
  RETURNING id INTO mosaic_obs_id;

  -- Observation owned by owner, used to test block exclusion.
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-08', 'Russula', 'emetica', 'public',  'public',  false)
  RETURNING id INTO blocked_obs_id;

  -- Observation with no active microscope measurements (M13).
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_id, '2026-07-09', 'Russula', 'emetica', 'public',  'public',  false)
  RETURNING id INTO zero_meas_obs_id;

  -- ── Microscope image + spore measurements ───────────────────────────
  -- Three active microscope measurements (types: 'spore', 'manual', NULL).
  INSERT INTO public.observation_images
    (observation_id, user_id, image_type, sort_order, storage_path, canonical_bucket)
  VALUES (public_obs_id, owner_id, 'microscope', 1, 'private/test-micro.jpg', 'private')
  RETURNING id INTO image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES
    (image_id, owner_id, 10.0, 5.0, 'spore'),
    (image_id, owner_id, 12.0, 6.0, 'manual'),
    (image_id, owner_id,  9.0, 4.5, NULL);

  -- One field image measurement — must NOT count.
  INSERT INTO public.observation_images
    (observation_id, user_id, image_type, sort_order, storage_path, canonical_bucket)
  VALUES (public_obs_id, owner_id, 'field', 2, 'private/field.jpg', 'private')
  RETURNING id INTO field_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (field_image_id, owner_id, 8.0, 4.0, 'spore');

  -- One purged microscope image measurement — must NOT count.
  INSERT INTO public.observation_images
    (observation_id, user_id, image_type, sort_order, storage_path, canonical_bucket, purged_at)
  VALUES (public_obs_id, owner_id, 'microscope', 3, 'private/purged.jpg', 'private', now())
  RETURNING id INTO purged_image_id;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (purged_image_id, owner_id, 7.0, 3.5, 'spore');

  -- ── Spore summary ────────────────────────────────────────────────────
  INSERT INTO public.observation_spore_summaries (
    observation_id, user_id, context_hash, context_json,
    measurement_type, n_spores, n_paired, n_length, n_width,
    length_min_um, length_p05_um, length_mean_um, length_median_um,
    length_p95_um, length_max_um, length_sd_um,
    width_min_um,  width_p05_um,  width_mean_um,  width_median_um,
    width_p95_um,  width_max_um,  width_sd_um,
    q_min, q_p05, q_mean, q_median, q_p95, q_max, q_sd,
    stats_version, computed_at, source_app, source_app_version
  ) VALUES (
    public_obs_id, owner_id,
    'testhash_mcp01', '{"measurement_type":"spore"}'::jsonb,
    'spore', 3, 3, 3, 3,
    9.0, 9.0, 10.33, 10.0, 12.0, 12.0, 1.5,
    4.5, 4.5,  5.17,  5.0,  6.0,  6.0, 0.75,
    2.0, 2.0,  2.0,   2.0,  2.0,  2.0, 0.0,
    1, now(), 'sporely-py', '0.9.9'
  );

  -- ── Mosaics for version ordering test ───────────────────────────────
  -- Three mosaics: version=1, version=2, version=3 (highest version wins).
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
     tile_width_px, tile_height_px, common_crop_width_um, common_crop_height_um,
     media_version, canonical_bucket)
  VALUES (mosaic_obs_id, owner_id, 'private/mosaic-v1.jpg', 800, 400, 64, 1, 64, 64, 10.0, 8.0, 1, 'private')
  RETURNING id INTO mosaic_id_v1;

  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
     tile_width_px, tile_height_px, common_crop_width_um, common_crop_height_um,
     media_version, canonical_bucket)
  VALUES (mosaic_obs_id, owner_id, 'private/mosaic-v2.jpg', 1200, 600, 64, 2, 64, 64, 10.0, 8.0, 2, 'private')
  RETURNING id INTO mosaic_id_v2;

  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
     tile_width_px, tile_height_px, common_crop_width_um, common_crop_height_um,
     media_version, canonical_bucket)
  VALUES (mosaic_obs_id, owner_id, 'private/mosaic-v2b.jpg', 1600, 800, 64, 3, 64, 64, 10.0, 8.0, 3, 'private')
  RETURNING id INTO mosaic_id_v2b;

  IF mosaic_id_v2b <= mosaic_id_v2 THEN
    RAISE EXCEPTION 'Fixture error: mosaic_id_v2b (%) must be > mosaic_id_v2 (%)', mosaic_id_v2b, mosaic_id_v2;
  END IF;

  -- ════════════════════════════════════════════════════════════════════
  -- Assertions (default session: auth.uid() IS NULL — anon)
  -- ════════════════════════════════════════════════════════════════════

  -- M10: empty input returns zero rows.
  SELECT count(*) INTO row_count
  FROM public.get_observation_microscopy_presentations(ARRAY[]::bigint[]);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'M10: empty input returned % rows (expected 0)', row_count;
  END IF;

  -- M11: unknown ids return zero rows.
  SELECT count(*) INTO row_count
  FROM public.get_observation_microscopy_presentations(ARRAY[-1::bigint, 99999999::bigint]);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'M11: unknown ids returned % rows (expected 0)', row_count;
  END IF;

  -- M2: public observation visible to anon with correct active microscope count.
  -- Only the 3 active microscope measurements count (not field image, not purged image).
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[public_obs_id])
    WHERE "observationId" = public_obs_id
      AND "sporeMeasurementCount" = 3
      AND "sporeSummary" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'M2: public observation not visible to anon, or spore count/summary wrong';
  END IF;

  -- M5: public observation with spore_data_visibility=private → row returned but spore fields NULL.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[spore_private_obs_id])
    WHERE "observationId" = spore_private_obs_id
      AND "sporeMeasurementCount" IS NULL
      AND "sporeSummary" IS NULL
      AND "sporeMosaic" IS NULL
  ) THEN
    RAISE EXCEPTION 'M5: spore fields not withheld from anon for spore_data_visibility=private';
  END IF;

  -- M7: banned author's observation is hidden.
  IF EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[banned_obs_id])
  ) THEN
    RAISE EXCEPTION 'M7: banned author observation leaked to anon';
  END IF;

  -- M12: draft, private, friends-only observations hidden from anon.
  IF EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(
      ARRAY[draft_obs_id, private_obs_id, friends_obs_id]
    )
  ) THEN
    RAISE EXCEPTION 'M12: draft/private/friends observation leaked to anon';
  END IF;

  -- M13: observation with zero active microscope measurements returns sporeMeasurementCount = 0 (not NULL).
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[zero_meas_obs_id])
    WHERE "observationId" = zero_meas_obs_id
      AND "sporeMeasurementCount" = 0
  ) THEN
    RAISE EXCEPTION 'M13: observation with no measurements did not return sporeMeasurementCount = 0';
  END IF;

  -- M8: latest mosaic selected by version DESC.
  -- mosaic_id_v2b has version=3 — it must win over mosaic_id_v2 (version=2) and mosaic_id_v1 (version=1).
  -- (The unique constraint on (observation_id, version) prevents duplicate versions, so id tiebreaking
  -- cannot be tested within a single observation; version DESC ordering is the effective selection rule.)
  SELECT "sporeMosaic" INTO mosaic_json
  FROM public.get_observation_microscopy_presentations(ARRAY[mosaic_obs_id])
  WHERE "observationId" = mosaic_obs_id;

  IF mosaic_json IS NULL THEN
    RAISE EXCEPTION 'M8: no sporeMosaic returned for mosaic_obs_id';
  END IF;

  IF (mosaic_json->>'mosaicId')::bigint IS DISTINCT FROM mosaic_id_v2b THEN
    RAISE EXCEPTION
      'M8: wrong mosaic selected. Expected id=% (version=3, highest), got mosaicId=%',
      mosaic_id_v2b, mosaic_json->>'mosaicId';
  END IF;

  IF (mosaic_json->>'version')::int <> 3 THEN
    RAISE EXCEPTION 'M8b: mosaic version should be 3, got %', mosaic_json->>'version';
  END IF;

  IF (mosaic_json->>'mosaicMediaUrl') IS NULL THEN
    RAISE EXCEPTION 'M8c: mosaicMediaUrl is NULL (build_worker_mosaic_url returned NULL — check worker URL config)';
  END IF;

  -- M9: sporeMosaic must not contain storageKey.
  IF mosaic_json ? 'storageKey' THEN
    RAISE EXCEPTION 'M9: sporeMosaic contains raw storageKey field';
  END IF;

  -- M9b: sporeSummary allowlist — must contain expected stat fields,
  --      must NOT contain internal fields (user_id, context_hash, id, observation_id)
  --      or audit timestamps (created_at, updated_at).
  SELECT "sporeSummary" INTO summary_json
  FROM public.get_observation_microscopy_presentations(ARRAY[public_obs_id])
  WHERE "observationId" = public_obs_id;

  IF summary_json IS NULL THEN
    RAISE EXCEPTION 'M9b pre: sporeSummary is NULL for public observation';
  END IF;

  -- Internal fields must be absent.
  IF summary_json ? 'user_id' OR summary_json ? 'id' OR summary_json ? 'observation_id'
      OR summary_json ? 'context_hash' THEN
    RAISE EXCEPTION 'M9b: sporeSummary contains an internal field (user_id/id/observation_id/context_hash)';
  END IF;

  -- Audit timestamps must be absent.
  IF summary_json ? 'created_at' OR summary_json ? 'updated_at' THEN
    RAISE EXCEPTION 'M9b: sporeSummary contains audit timestamp (created_at or updated_at)';
  END IF;

  -- Expected allowlisted fields must be present.
  IF NOT (summary_json ? 'n_spores' AND summary_json ? 'length_mean_um'
          AND summary_json ? 'width_mean_um' AND summary_json ? 'computed_at'
          AND summary_json ? 'source_app' AND summary_json ? 'measurement_type') THEN
    RAISE EXCEPTION 'M9b: sporeSummary is missing expected allowlisted stat fields';
  END IF;

  -- ── Authenticated owner assertions ───────────────────────────────────
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || owner_id::text || '","role":"authenticated"}', true);

  -- M1: owner reads own draft observation.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[draft_obs_id])
    WHERE "observationId" = draft_obs_id
  ) THEN
    RAISE EXCEPTION 'M1: owner cannot read own draft observation';
  END IF;

  -- M1b: owner reads own private observation.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[private_obs_id])
    WHERE "observationId" = private_obs_id
  ) THEN
    RAISE EXCEPTION 'M1b: owner cannot read own private observation';
  END IF;

  -- M1c: owner sees their own spore data even when spore_data_visibility=private.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[spore_private_obs_id])
    WHERE "observationId" = spore_private_obs_id
      AND "sporeMeasurementCount" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'M1c: owner cannot see their own private spore data';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);

  -- ── Authenticated non-owner assertions ───────────────────────────────
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || outsider_id::text || '","role":"authenticated"}', true);

  -- M3: non-owner sees public observation with spore data (spore_data_visibility=public).
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[public_obs_id])
    WHERE "observationId" = public_obs_id
      AND "sporeMeasurementCount" = 3
  ) THEN
    RAISE EXCEPTION 'M3: authenticated non-owner cannot read public observation';
  END IF;

  -- M3b: non-owner cannot see draft or private observations.
  IF EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(
      ARRAY[private_obs_id, draft_obs_id]
    )
  ) THEN
    RAISE EXCEPTION 'M3b: non-owner can see draft or private observation';
  END IF;

  -- M14: authenticated non-owner reading public observation with spore_data_visibility=private
  --      gets NULL spore fields (row is still returned, spore data is withheld).
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[spore_private_obs_id])
    WHERE "observationId" = spore_private_obs_id
      AND "sporeMeasurementCount" IS NULL
      AND "sporeSummary" IS NULL
      AND "sporeMosaic" IS NULL
  ) THEN
    RAISE EXCEPTION 'M14: authenticated non-owner did not receive NULL spore fields for spore_data_visibility=private';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);

  -- ── Friend assertions ────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || friend_id::text || '","role":"authenticated"}', true);

  -- M4: accepted friend reads friends-only observation.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[friends_obs_id])
    WHERE "observationId" = friends_obs_id
  ) THEN
    RAISE EXCEPTION 'M4: accepted friend cannot read friends-only observation';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);

  -- M4b: outsider (non-friend) cannot read friends-only.
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || outsider_id::text || '","role":"authenticated"}', true);

  IF EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[friends_obs_id])
  ) THEN
    RAISE EXCEPTION 'M4b: non-friend outsider can read friends-only observation';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);

  -- ── Block assertion ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || blocker_id::text || '","role":"authenticated"}', true);

  -- M6: user who blocked owner cannot read owner's public observation.
  IF EXISTS (
    SELECT 1
    FROM public.get_observation_microscopy_presentations(ARRAY[blocked_obs_id])
  ) THEN
    RAISE EXCEPTION 'M6: blocker can read observation of blocked user';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);

  -- ── Input guard assertions ───────────────────────────────────────────

  -- M15: calling with 201 distinct ids raises an explicit error.
  BEGIN
    PERFORM public.get_observation_microscopy_presentations(
      ARRAY(SELECT generate_series(1, 201)::bigint)
    );
    RAISE EXCEPTION 'M15: expected exception for 201 distinct ids but none was raised';
  EXCEPTION
    WHEN OTHERS THEN
      IF sqlerrm NOT LIKE '%too many observation ids%' THEN
        RAISE EXCEPTION 'M15: wrong exception message: %', sqlerrm;
      END IF;
  END;

  -- M16: 201 raw elements that reduce to 1 distinct id must NOT raise
  --      and must return zero rows (id -1 does not exist).
  SELECT count(*) INTO row_count
  FROM public.get_observation_microscopy_presentations(
    ARRAY(SELECT (-1)::bigint FROM generate_series(1, 201))
  );
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'M16: 201-duplicate call returned unexpected rows: %', row_count;
  END IF;

  RAISE NOTICE 'observation_microscopy_presentations_test: all M1–M16 assertions passed';
END
$$;

ROLLBACK;
