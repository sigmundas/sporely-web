-- Stage 2b additive authorized-media projection regression test.
-- Run after local migrations with psql as postgres.

BEGIN;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-00000000b201';
  friend_id uuid := '00000000-0000-4000-8000-00000000b202';
  stranger_id uuid := '00000000-0000-4000-8000-00000000b203';
  obs_public bigint;
  obs_friends bigint;
  obs_private bigint;
  obs_restricted_mosaic bigint;
  img_public bigint;
  img_friends bigint;
  img_private bigint;
  mosaic_public bigint;
  mosaic_restricted bigint;
  old_version bigint;
  new_version bigint;
  old_url text;
  new_url text;
  row_count bigint;
  payload jsonb;
  rec record;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id, 'authenticated', 'authenticated', 'stage2b-owner@example.test', '{}'::jsonb, now(), now()),
    (friend_id, 'authenticated', 'authenticated', 'stage2b-friend@example.test', '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'stage2b-stranger@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES
    (owner_id, 'stage2b_owner', 'Stage2b Owner', true, false),
    (friend_id, 'stage2b_friend', 'Stage2b Friend', true, false),
    (stranger_id, 'stage2b_stranger', 'Stage2b Stranger', true, false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, friend_id, 'accepted')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-09', 'Amanita', 'muscaria', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs_public;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-09', 'Amanita', 'rubescens', 'friends', false, 'hidden', 'friends')
  RETURNING id INTO obs_friends;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-09', 'Amanita', 'virosa', 'private', false, 'hidden', 'private')
  RETURNING id INTO obs_private;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-08-09', 'Amanita', 'pantherina', 'public', false, 'hidden', 'private')
  RETURNING id INTO obs_restricted_mosaic;

  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, original_storage_path, image_type, sort_order, storage_exif_safe)
  VALUES
    (obs_public, owner_id, owner_id::text || '/public.webp', owner_id::text || '/public-original.heic', 'field', 0, true)
  RETURNING id INTO img_public;

  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, original_storage_path, image_type, sort_order, storage_exif_safe)
  VALUES
    (obs_friends, owner_id, owner_id::text || '/friends.webp', owner_id::text || '/friends-original.heic', 'field', 0, true)
  RETURNING id INTO img_friends;

  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, original_storage_path, image_type, sort_order, storage_exif_safe)
  VALUES
    (obs_private, owner_id, owner_id::text || '/private.webp', owner_id::text || '/private-original.heic', 'field', 0, true)
  RETURNING id INTO img_private;

  UPDATE public.observations
  SET image_key = owner_id::text || '/public.webp', thumb_key = owner_id::text || '/thumb_public.webp'
  WHERE id = obs_public;
  UPDATE public.observations
  SET image_key = owner_id::text || '/friends.webp', thumb_key = owner_id::text || '/thumb_friends.webp'
  WHERE id = obs_friends;

  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (obs_public, owner_id, owner_id::text || '/public-mosaic.webp', 256, 128, 128, 1)
  RETURNING id INTO mosaic_public;

  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (obs_restricted_mosaic, owner_id, owner_id::text || '/restricted-mosaic.webp', 256, 128, 128, 1)
  RETURNING id INTO mosaic_restricted;

  -- Structural compatibility: old fields remain, new fields are appended,
  -- and original_storage_path is still absent from the non-owner view.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='observation_images_community_view' AND column_name='storage_path')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='observation_images_community_view' AND column_name='full_media_url')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='observation_images_community_view' AND column_name='original_storage_path') THEN
    RAISE EXCEPTION 'Stage2b image-view compatibility/original exclusion contract failed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='observations_community_view' AND column_name='image_key')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='observations_community_view' AND column_name='image_id') THEN
    RAISE EXCEPTION 'Stage2b observation-view additive contract failed';
  END IF;
  IF pg_get_function_result('public.get_public_observation_images(bigint)'::regprocedure) ILIKE '%original%'
     OR pg_get_function_result('public.search_public_observation_images(bigint[])'::regprocedure) ILIKE '%original%' THEN
    RAISE EXCEPTION 'Public image RPC signature exposes an original field';
  END IF;

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT * INTO rec
  FROM public.observation_images_community_view
  WHERE id = img_public;
  IF rec.image_id IS DISTINCT FROM img_public
     OR rec.media_version IS NULL
     OR rec.full_media_url NOT LIKE 'https://upload.sporely.no/m/' || img_public::text || '/full?v=%'
     OR rec.thumb_media_url NOT LIKE 'https://upload.sporely.no/m/' || img_public::text || '/thumb?v=%'
     OR rec.storage_path IS NULL THEN
    RAISE EXCEPTION 'Public image authorized + legacy projection failed';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.observation_images_community_view
  WHERE id = img_private;
  IF row_count <> 0 THEN RAISE EXCEPTION 'Private image leaked to anon'; END IF;

  SELECT * INTO rec FROM public.get_public_observation_images(obs_public) LIMIT 1;
  IF rec."imageId" IS DISTINCT FROM img_public
     OR rec."mediaVersion" IS NULL
     OR rec."fullMediaUrl" NOT LIKE 'https://upload.sporely.no/m/' || img_public::text || '/full?v=%'
     OR rec."thumbMediaUrl" NOT LIKE 'https://upload.sporely.no/m/' || img_public::text || '/thumb?v=%'
     OR rec."thumbUrl" NOT LIKE 'https://media.sporely.no/%' THEN
    RAISE EXCEPTION 'Public image RPC additive contract failed';
  END IF;
  SELECT count(*) INTO row_count FROM public.get_public_observation_images(obs_private);
  IF row_count <> 0 THEN RAISE EXCEPTION 'Private image leaked through public image RPC'; END IF;

  SELECT "sporeMosaic" INTO payload FROM public.get_public_observation(obs_public);
  IF (payload->>'mosaicId')::bigint IS DISTINCT FROM mosaic_public
     OR payload->>'mosaicMediaUrl' NOT LIKE 'https://upload.sporely.no/mm/' || mosaic_public::text || '?v=%'
     OR payload->>'url' NOT LIKE 'https://media.sporely.no/%' THEN
    RAISE EXCEPTION 'Public mosaic additive + legacy contract failed: %', payload;
  END IF;
  IF payload::text LIKE '%/original%' THEN RAISE EXCEPTION 'Original URL leaked in public mosaic payload'; END IF;

  SELECT "sporeMosaic" INTO payload FROM public.get_public_observation(obs_restricted_mosaic);
  IF payload IS NOT NULL THEN RAISE EXCEPTION 'Restricted mosaic leaked to anon: %', payload; END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);

  SELECT count(*) INTO row_count
  FROM public.observations_friend_view
  WHERE id = obs_friends
    AND image_id = img_friends
    AND full_media_url LIKE 'https://upload.sporely.no/m/%/full?v=%'
    AND thumb_media_url LIKE 'https://upload.sporely.no/m/%/thumb?v=%';
  IF row_count <> 1 THEN RAISE EXCEPTION 'Friend authorized image identity missing'; END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  SELECT count(*) INTO row_count FROM public.observations_friend_view WHERE id = obs_friends;
  IF row_count <> 0 THEN RAISE EXCEPTION 'Friends-only media leaked to stranger'; END IF;

  RESET ROLE;
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '{}'::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT media_version, public.build_worker_media_url(id, 'full', media_version)
    INTO old_version, old_url FROM public.observation_images WHERE id = img_public;
  UPDATE public.observation_images SET storage_path = owner_id::text || '/public-v2.webp' WHERE id = img_public;
  SELECT "mediaVersion", "fullMediaUrl"
    INTO new_version, new_url FROM public.get_public_observation_images(obs_public) LIMIT 1;
  IF new_version <= old_version OR new_url = old_url OR new_url NOT LIKE '%?v=' || new_version::text THEN
    RAISE EXCEPTION 'Media version/URL did not change (% -> %, % -> %)', old_version, new_version, old_url, new_url;
  END IF;

  RESET ROLE;
END $$;

ROLLBACK;
