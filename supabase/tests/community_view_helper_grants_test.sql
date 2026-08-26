-- Regression coverage for the 2026-08 can_read_observation grant hardening.
-- Proves:
--   * can_read_observation is no longer granted to PUBLIC, still granted to
--     anon/authenticated/service_role, and has search_path=''.
--   * The helper returns correct answers for owner, anon+public, anon+friends,
--     authenticated non-friend, accepted friend, banned owner, and bidirectional
--     block cases.
--   * The community views still return the expected rows for the intended
--     callers, so nothing regressed for anon or authenticated flows.
--   * The Stage 2b media URL still resolves through the views.
--   * The landing shared-post path (anon SELECT on comments_community_view)
--     still functions.

BEGIN;

DO $$
DECLARE
  owner_id     uuid := '00000000-0000-4000-8000-0000000cf001';
  friend_id    uuid := '00000000-0000-4000-8000-0000000cf002';
  stranger_id  uuid := '00000000-0000-4000-8000-0000000cf003';
  banned_id    uuid := '00000000-0000-4000-8000-0000000cf004';
  blocker_user uuid := '00000000-0000-4000-8000-0000000cf005';
  obs_public   bigint;
  obs_friends  bigint;
  obs_banned   bigint;
  img_public   bigint;
  cmt_public   bigint;
  row_count    bigint;
  view_url     text;
BEGIN
  --------------------------------------------------------------------
  -- 1. EXECUTE-privilege catalog assertions for can_read_observation.
  --------------------------------------------------------------------
  IF has_function_privilege(
       'public',
       'public.can_read_observation(uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'PUBLIC still holds EXECUTE on can_read_observation';
  END IF;
  IF NOT has_function_privilege(
       'anon', 'public.can_read_observation(uuid,text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated', 'public.can_read_observation(uuid,text)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.can_read_observation(uuid,text)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'can_read_observation lost an intended explicit grant';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='can_read_observation'
      AND 'search_path=""' = ANY(p.proconfig)
  ) THEN
    RAISE EXCEPTION 'can_read_observation search_path was not tightened to empty';
  END IF;

  --------------------------------------------------------------------
  -- 2. Fixtures.
  --------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,     'authenticated', 'authenticated', 'cf-owner@example.test',    '{}'::jsonb, now(), now()),
    (friend_id,    'authenticated', 'authenticated', 'cf-friend@example.test',   '{}'::jsonb, now(), now()),
    (stranger_id,  'authenticated', 'authenticated', 'cf-stranger@example.test', '{}'::jsonb, now(), now()),
    (banned_id,    'authenticated', 'authenticated', 'cf-banned@example.test',   '{}'::jsonb, now(), now()),
    (blocker_user, 'authenticated', 'authenticated', 'cf-blocker@example.test',  '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, is_pro, is_banned)
  VALUES
    (owner_id,     'cf_owner',    true, false),
    (friend_id,    'cf_friend',   true, false),
    (stranger_id,  'cf_stranger', true, false),
    (banned_id,    'cf_banned',   true, true),
    (blocker_user, 'cf_blocker',  true, false)
  ON CONFLICT (id) DO UPDATE SET
    is_banned = EXCLUDED.is_banned;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, friend_id, 'accepted')
  ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = EXCLUDED.status;

  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (blocker_user, stranger_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, current_date, 'Amanita', 'muscaria', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs_public;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, current_date, 'Amanita', 'rubescens', 'friends', false, 'hidden', 'friends')
  RETURNING id INTO obs_friends;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (banned_id, current_date, 'Amanita', 'phalloides', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs_banned;

  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, original_storage_path, image_type, sort_order, storage_exif_safe)
  VALUES (obs_public, owner_id, owner_id::text || '/cf-public.webp',
          owner_id::text || '/cf-public-original.heic', 'field', 0, true)
  RETURNING id INTO img_public;

  UPDATE public.observations
     SET image_key = owner_id::text || '/cf-public.webp',
         thumb_key = owner_id::text || '/cf-thumb-public.webp'
   WHERE id = obs_public;

  INSERT INTO public.comments (observation_id, user_id, body)
  VALUES (obs_public, owner_id, 'landing shared-post fixture comment')
  RETURNING id INTO cmt_public;

  --------------------------------------------------------------------
  -- 3. Anon path: can_read_observation semantics + community view reads.
  --------------------------------------------------------------------
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  IF NOT public.can_read_observation(owner_id, 'public') THEN
    RAISE EXCEPTION 'anon lost read on a public observation';
  END IF;
  IF public.can_read_observation(owner_id, 'friends') THEN
    RAISE EXCEPTION 'anon incorrectly granted read on a friends-only observation';
  END IF;
  IF public.can_read_observation(banned_id, 'public') THEN
    RAISE EXCEPTION 'anon read a banned owner''s public observation';
  END IF;

  -- Landing shared-post: anon read of comments_community_view still works.
  SELECT count(*) INTO row_count
    FROM public.comments_community_view
   WHERE id = cmt_public;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'landing shared-post anon read of comments_community_view broke';
  END IF;

  -- Stage 2b media URL still resolves through the view.
  SELECT full_media_url INTO view_url
    FROM public.observation_images_community_view
   WHERE id = img_public;
  IF view_url IS NULL
     OR view_url NOT LIKE 'https://upload.sporely.no/m/' || img_public::text || '/full?v=%' THEN
    RAISE EXCEPTION
      'observation_images_community_view lost its Stage 2b URL: %', view_url;
  END IF;

  -- Banned owner filtered out of observations_community_view.
  SELECT count(*) INTO row_count
    FROM public.observations_community_view
   WHERE id = obs_banned;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'banned owner leaked through observations_community_view';
  END IF;

  --------------------------------------------------------------------
  -- 4. Authenticated non-friend path.
  --------------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);

  IF NOT public.can_read_observation(owner_id, 'public') THEN
    RAISE EXCEPTION 'authenticated non-friend lost read on public observation';
  END IF;
  IF public.can_read_observation(owner_id, 'friends') THEN
    RAISE EXCEPTION 'authenticated non-friend incorrectly granted friends-only read';
  END IF;

  SELECT count(*) INTO row_count
    FROM public.observations_community_view
   WHERE id = obs_public;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'authenticated non-friend lost view read';
  END IF;

  SELECT full_media_url INTO view_url
    FROM public.observation_images_community_view
   WHERE id = img_public;
  IF view_url IS NULL
     OR view_url NOT LIKE 'https://upload.sporely.no/m/' || img_public::text || '/full?v=%' THEN
    RAISE EXCEPTION
      'authenticated non-friend lost Stage 2b media URL through the view: %', view_url;
  END IF;

  --------------------------------------------------------------------
  -- 5. Accepted-friend path.
  --------------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);

  IF NOT public.can_read_observation(owner_id, 'friends') THEN
    RAISE EXCEPTION 'accepted friend lost read on friends-only observation';
  END IF;

  SELECT count(*) INTO row_count
    FROM public.observations_friend_view
   WHERE id = obs_friends;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'accepted friend lost observations_friend_view read';
  END IF;

  --------------------------------------------------------------------
  -- 6. Bidirectional block.
  --------------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  IF public.can_read_observation(blocker_user, 'public') THEN
    RAISE EXCEPTION 'blocked stranger read the blocker''s public observation';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', blocker_user::text, 'role','authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', blocker_user::text, true);
  IF public.can_read_observation(stranger_id, 'public') THEN
    RAISE EXCEPTION 'blocker read the blocked stranger''s public observation';
  END IF;

  --------------------------------------------------------------------
  -- 7. Owner self-authorization.
  --------------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  IF NOT public.can_read_observation(owner_id, 'private') THEN
    RAISE EXCEPTION 'owner lost self-read authorization';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'community_view_helper_grants_test passed';
END
$$;

ROLLBACK;
