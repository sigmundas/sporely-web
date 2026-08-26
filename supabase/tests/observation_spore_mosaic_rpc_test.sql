-- Regression coverage for get_observation_spore_mosaic(bigint).
--
-- This historical dedicated RPC selects by updated_at DESC. That intentionally
-- differs from get_observation_microscopy_presentations(bigint[]), which selects
-- by version DESC, id DESC. This test records the existing behavior; it does not
-- endorse or change the ordering contract.

BEGIN;

DO $$
DECLARE
  owner_id             uuid := '00000000-0000-4000-8000-00000000e001';
  viewer_id            uuid := '00000000-0000-4000-8000-00000000e002';
  public_observation_id  bigint;
  private_observation_id bigint;
  public_version_2_id    bigint;
  public_latest_id       bigint;
  private_mosaic_id      bigint;
  result_mosaic_id       bigint;
  result_url             text;
  result_width           integer;
  result_height          integer;
  result_tile_width      integer;
  result_tile_height     integer;
  row_count              bigint;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,  'authenticated', 'authenticated', 'mosaic-rpc-owner@example.test',  '{}'::jsonb, now(), now()),
    (viewer_id, 'authenticated', 'authenticated', 'mosaic-rpc-viewer@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_id,  'mosaic_rpc_owner',  'Mosaic RPC Owner',  false),
    (viewer_id, 'mosaic_rpc_viewer', 'Mosaic RPC Viewer', false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  INSERT INTO public.observations (
    user_id, date, visibility, is_draft, spore_data_visibility
  )
  VALUES (owner_id, current_date, 'public', false, 'public')
  RETURNING id INTO public_observation_id;

  INSERT INTO public.observations (
    user_id, date, visibility, is_draft, spore_data_visibility
  )
  VALUES (owner_id, current_date, 'private', false, 'private')
  RETURNING id INTO private_observation_id;

  -- Higher version, but older updated_at: the dedicated RPC must not select it.
  INSERT INTO public.spore_measurement_mosaics (
    observation_id, user_id, storage_key, width_px, height_px, tile_size_px,
    version, updated_at, tile_width_px, tile_height_px, media_version
  )
  VALUES (
    public_observation_id, owner_id, owner_id::text || '/mosaic-version-2.webp',
    200, 100, 64, 2, '2026-08-25 10:00:00+00', 50, 40, 2
  )
  RETURNING id INTO public_version_2_id;

  -- Lower version, but later updated_at: this is the expected winner.
  INSERT INTO public.spore_measurement_mosaics (
    observation_id, user_id, storage_key, width_px, height_px, tile_size_px,
    version, updated_at, tile_width_px, tile_height_px, media_version
  )
  VALUES (
    public_observation_id, owner_id, owner_id::text || '/mosaic-version-1-latest.webp',
    320, 160, 64, 1, '2026-08-25 11:00:00+00', 80, 60, 7
  )
  RETURNING id INTO public_latest_id;

  INSERT INTO public.spore_measurement_mosaics (
    observation_id, user_id, storage_key, width_px, height_px, tile_size_px,
    version, updated_at, tile_width_px, tile_height_px, media_version
  )
  VALUES (
    private_observation_id, owner_id, owner_id::text || '/private-mosaic.webp',
    400, 200, 64, 1, '2026-08-25 12:00:00+00', 100, 80, 3
  )
  RETURNING id INTO private_mosaic_id;

  -- Owner access succeeds even for a private observation and private spore data.
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  SELECT count(*), max("mosaicId")
  INTO row_count, result_mosaic_id
  FROM public.get_observation_spore_mosaic(private_observation_id);
  IF row_count <> 1 OR result_mosaic_id IS DISTINCT FROM private_mosaic_id THEN
    RAISE EXCEPTION 'owner did not receive private mosaic: rows=% id=%', row_count, result_mosaic_id;
  END IF;

  -- An authenticated non-owner can read the public observation/public spore mosaic.
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', viewer_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);

  SELECT "mosaicId", url, "widthPx", "heightPx", "tileWidthPx", "tileHeightPx"
  INTO result_mosaic_id, result_url, result_width, result_height, result_tile_width, result_tile_height
  FROM public.get_observation_spore_mosaic(public_observation_id);

  IF result_mosaic_id IS DISTINCT FROM public_latest_id THEN
    RAISE EXCEPTION
      'updated_at ordering mismatch: expected later-updated id %, got % (higher-version id was %)',
      public_latest_id, result_mosaic_id, public_version_2_id;
  END IF;
  IF result_width <> 320 OR result_height <> 160
     OR result_tile_width <> 80 OR result_tile_height <> 60 THEN
    RAISE EXCEPTION 'dedicated mosaic dimensions mismatch';
  END IF;
  IF result_url IS NULL
     OR result_url !~ ('^https?://.+/mm/' || public_latest_id::text || '\?v=7$') THEN
    RAISE EXCEPTION 'worker mosaic URL has unexpected shape: %', result_url;
  END IF;

  -- The same non-owner must receive no row for the private observation.
  SELECT count(*) INTO row_count
  FROM public.get_observation_spore_mosaic(private_observation_id);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'private observation mosaic leaked to non-owner: % rows', row_count;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'observation_spore_mosaic_rpc_test passed';
END
$$;

ROLLBACK;
