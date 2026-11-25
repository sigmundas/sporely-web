-- Regression coverage for 20261125230000_close_block_and_comment_privacy_gaps.
-- Proves:
--   * a blocked user cannot read the block row naming them; the blocker can,
--     and the block still filters both directions;
--   * a direct comments read applies the same author filters as
--     comments_community_view (banned author, block either way), on one
--     friends-only thread, for a viewer and for the observation owner;
--   * friend requests and acceptances are refused across a block or a ban;
--   * an image or mosaic insert under someone else's observation and under a
--     missing one fail the same way, without naming the owner;
--   * observations_follow_view and comments_community_view are security_barrier;
--   * comments and user_blocks INSERT take only client columns, and anon has
--     no privileges on either table.
--
-- Run after local migrations:
--   psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f supabase/tests/block_and_comment_privacy_test.sql

BEGIN;

DO $$
DECLARE
  owner_id   uuid := '00000000-0000-4000-8000-0000001125a1';  -- O: owns both threads
  viewer_id  uuid := '00000000-0000-4000-8000-0000001125a2';  -- V: O's friend
  blocked_uid uuid := '00000000-0000-4000-8000-0000001125a3';  -- X: V blocked X
  blocker_uid uuid := '00000000-0000-4000-8000-0000001125a4';  -- Y: Y blocked V
  banned_id  uuid := '00000000-0000-4000-8000-0000001125a5';  -- Z: banned
  normal_id  uuid := '00000000-0000-4000-8000-0000001125a6';  -- N: control author
  obs_public  bigint := 881125230001;
  obs_friends bigint := 881125230002;
  obs_missing bigint := 881125239999;
  c_normal_fr  bigint := 881125230011;
  c_blocked_fr bigint := 881125230012;
  c_blocker_fr bigint := 881125230013;
  c_banned_fr  bigint := 881125230014;
  c_blocked_pub bigint := 881125230015;
  pending_from_blocker bigint;
  request_id bigint;
  row_count bigint;
  ids bigint[];
  refused boolean;
  state_missing text;
  state_foreign text;
  msg_missing text;
  msg_foreign text;
BEGIN
  ---------------------------------------------------------------------------
  -- Fixtures (as postgres)
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,   'authenticated', 'authenticated', 'bcp-owner@example.test',   '{}'::jsonb, now(), now()),
    (viewer_id,  'authenticated', 'authenticated', 'bcp-viewer@example.test',  '{}'::jsonb, now(), now()),
    (blocked_uid, 'authenticated', 'authenticated', 'bcp-blocked@example.test', '{}'::jsonb, now(), now()),
    (blocker_uid, 'authenticated', 'authenticated', 'bcp-blocker@example.test', '{}'::jsonb, now(), now()),
    (banned_id,  'authenticated', 'authenticated', 'bcp-banned@example.test',  '{}'::jsonb, now(), now()),
    (normal_id,  'authenticated', 'authenticated', 'bcp-normal@example.test',  '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, is_banned, profile_completed_at)
  VALUES
    (owner_id,   'bcp_owner',   false, now()),
    (viewer_id,  'bcp_viewer',  false, now()),
    (blocked_uid, 'bcp_blocked', false, now()),
    (blocker_uid, 'bcp_blocker', false, now()),
    (banned_id,  'bcp_banned',  true,  now()),
    (normal_id,  'bcp_normal',  false, now())
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    is_banned = EXCLUDED.is_banned,
    profile_completed_at = EXCLUDED.profile_completed_at;

  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES
    (obs_public,  owner_id, current_date, 'public',  false),
    (obs_friends, owner_id, current_date, 'friends', false);

  -- Everyone except the owner is the owner's friend, so every author can
  -- reach the friends-only thread.
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES
    (owner_id, viewer_id,  'accepted'),
    (owner_id, blocked_uid, 'accepted'),
    (owner_id, blocker_uid, 'accepted'),
    (owner_id, banned_id,  'accepted'),
    (owner_id, normal_id,  'accepted');

  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (viewer_id, blocked_uid),
         (blocker_uid, viewer_id);

  INSERT INTO public.comments (id, observation_id, user_id, body)
  VALUES
    (c_normal_fr,   obs_friends, normal_id,  'normal author, friends thread'),
    (c_blocked_fr,  obs_friends, blocked_uid, 'author the viewer blocked, friends thread'),
    (c_blocker_fr,  obs_friends, blocker_uid, 'author who blocked the viewer, friends thread'),
    (c_banned_fr,   obs_friends, banned_id,  'banned author, friends thread'),
    (c_blocked_pub, obs_public,  blocked_uid, 'author the viewer blocked, public thread');

  -- A request the blocked side sent before the block; accepting must fail.
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (blocker_uid, viewer_id, 'pending')
  RETURNING id INTO pending_from_blocker;

  ---------------------------------------------------------------------------
  -- 5. Catalog: views and grants
  ---------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.observations_follow_view'::regclass
      AND 'security_barrier=true' = ANY (reloptions)
  ) THEN
    RAISE EXCEPTION 'observations_follow_view is not security_barrier';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.comments_community_view'::regclass
      AND 'security_barrier=true' = ANY (reloptions)
  ) THEN
    RAISE EXCEPTION 'comments_community_view is not security_barrier';
  END IF;

  IF has_table_privilege('anon', 'public.comments', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.user_blocks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'anon still holds a privilege on comments or user_blocks';
  END IF;
  IF has_column_privilege('authenticated', 'public.comments', 'id', 'INSERT')
     OR has_column_privilege('authenticated', 'public.comments', 'created_at', 'INSERT')
     OR has_column_privilege('authenticated', 'public.user_blocks', 'created_at', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_blocks', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.comments', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated can still choose server columns or holds a needless privilege';
  END IF;
  IF has_function_privilege('anon', 'public.comment_author_is_visible(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.can_befriend(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute a new RLS helper';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. user_blocks: the blocked side cannot read the row naming them
  ---------------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', blocked_uid::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', blocked_uid::text, true);

  SELECT count(*) INTO row_count FROM public.user_blocks;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'blocked user read % block row(s) naming them', row_count;
  END IF;
  IF NOT public.current_user_is_blocked_with(viewer_id) THEN
    RAISE EXCEPTION 'the block no longer filters from the blocked side';
  END IF;

  -- 3. A blocked user cannot send a friend request to the blocker.
  refused := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status)
    VALUES (blocked_uid, viewer_id, 'pending');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'blocked user sent a friend request to the blocker';
  END IF;

  -- 6. Client-chosen server columns are refused.
  refused := false;
  BEGIN
    INSERT INTO public.user_blocks (blocker_id, blocked_id, created_at)
    VALUES (blocked_uid, normal_id, now() - interval '1 year');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'user_blocks accepted a client-chosen created_at';
  END IF;

  -- 4. Rejected media inserts do not name the parent's owner.
  BEGIN
    INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path)
    VALUES (obs_missing, blocked_uid, 'field', blocked_uid::text || '/x.webp');
    RAISE EXCEPTION 'image insert under a missing observation succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_missing = RETURNED_SQLSTATE, msg_missing = MESSAGE_TEXT;
  END;
  BEGIN
    INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path)
    VALUES (obs_friends, blocked_uid, 'field', blocked_uid::text || '/x.webp');
    RAISE EXCEPTION 'image insert under another user''s observation succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_foreign = RETURNED_SQLSTATE, msg_foreign = MESSAGE_TEXT;
  END;
  IF state_missing <> '42501' OR state_foreign <> '42501'
     OR replace(msg_missing, obs_missing::text, '#') <> replace(msg_foreign, obs_friends::text, '#')
     OR strpos(msg_foreign, owner_id::text) > 0 THEN
    RAISE EXCEPTION 'image parent errors differ or name the owner: [%] % / [%] %',
      state_missing, msg_missing, state_foreign, msg_foreign;
  END IF;

  BEGIN
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs_missing, blocked_uid, blocked_uid::text || '/m.webp', 256, 128, 128, 1);
    RAISE EXCEPTION 'mosaic insert under a missing observation succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_missing = RETURNED_SQLSTATE, msg_missing = MESSAGE_TEXT;
  END;
  BEGIN
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs_friends, blocked_uid, blocked_uid::text || '/m.webp', 256, 128, 128, 1);
    RAISE EXCEPTION 'mosaic insert under another user''s observation succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_foreign = RETURNED_SQLSTATE, msg_foreign = MESSAGE_TEXT;
  END;
  IF state_missing <> '42501' OR state_foreign <> '42501'
     OR replace(msg_missing, obs_missing::text, '#') <> replace(msg_foreign, obs_friends::text, '#')
     OR strpos(msg_foreign, owner_id::text) > 0 THEN
    RAISE EXCEPTION 'mosaic parent errors differ or name the owner: [%] % / [%] %',
      state_missing, msg_missing, state_foreign, msg_foreign;
  END IF;

  ---------------------------------------------------------------------------
  -- The viewer: blocked X, was blocked by Y
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', viewer_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);

  SELECT count(*) INTO row_count FROM public.user_blocks;
  IF row_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.user_blocks WHERE blocker_id = viewer_id AND blocked_id = blocked_uid
  ) THEN
    RAISE EXCEPTION 'blocker should read exactly their own block row, got %', row_count;
  END IF;
  IF NOT public.current_user_is_blocked_with(blocker_uid) THEN
    RAISE EXCEPTION 'a block against the viewer no longer filters from the viewer''s side';
  END IF;

  -- 2. Both read paths return the same comments on the friends-only thread.
  SELECT array_agg(id ORDER BY id) INTO ids
  FROM public.comments WHERE observation_id IN (obs_friends, obs_public);
  IF ids IS DISTINCT FROM ARRAY[c_normal_fr] THEN
    RAISE EXCEPTION 'direct comments read returned %, expected only the control comment', ids;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO ids
  FROM public.comments_community_view WHERE observation_id IN (obs_friends, obs_public);
  IF ids IS DISTINCT FROM ARRAY[c_normal_fr] THEN
    RAISE EXCEPTION 'comments_community_view returned %, expected only the control comment', ids;
  END IF;

  -- 3. The viewer cannot request X (blocked) or accept Y's old request.
  refused := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status)
    VALUES (viewer_id, blocked_uid, 'pending');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'blocker sent a friend request to the user they blocked';
  END IF;

  refused := false;
  BEGIN
    UPDATE public.friendships SET status = 'accepted' WHERE id = pending_from_blocker;
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'viewer accepted a request from a user who blocked them';
  END IF;

  -- Control: a request without block or ban goes through and can be accepted.
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (viewer_id, normal_id, 'pending')
  RETURNING id INTO request_id;

  -- 6. Comments: id and created_at are server-chosen.
  refused := false;
  BEGIN
    INSERT INTO public.comments (id, observation_id, user_id, body)
    VALUES (881125230099, obs_public, viewer_id, 'chosen id');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'comments accepted a client-chosen id';
  END IF;

  refused := false;
  BEGIN
    INSERT INTO public.comments (observation_id, user_id, body, created_at)
    VALUES (obs_public, viewer_id, 'backdated', now() - interval '1 year');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'comments accepted a client-chosen created_at';
  END IF;

  INSERT INTO public.comments (observation_id, user_id, body, mentioned_user_ids)
  VALUES (obs_public, viewer_id, 'client columns only', ARRAY[owner_id]);

  ---------------------------------------------------------------------------
  -- The control author accepts; a banned user cannot be befriended
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', normal_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', normal_id::text, true);

  UPDATE public.friendships SET status = 'accepted' WHERE id = request_id;
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'an unblocked, unbanned request could not be accepted';
  END IF;

  refused := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status)
    VALUES (normal_id, banned_id, 'pending');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'friend request to a banned user was accepted';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', banned_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', banned_id::text, true);

  refused := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status)
    VALUES (banned_id, normal_id, 'pending');
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'banned user sent a friend request';
  END IF;

  ---------------------------------------------------------------------------
  -- The owner: no block with anyone; only the banned author is hidden
  ---------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  SELECT array_agg(id ORDER BY id) INTO ids
  FROM public.comments WHERE observation_id = obs_friends;
  IF ids IS DISTINCT FROM ARRAY[c_normal_fr, c_blocked_fr, c_blocker_fr] THEN
    RAISE EXCEPTION 'owner direct read returned %, expected all but the banned author', ids;
  END IF;
  SELECT array_agg(id ORDER BY id) INTO ids
  FROM public.comments_community_view WHERE observation_id = obs_friends;
  IF ids IS DISTINCT FROM ARRAY[c_normal_fr, c_blocked_fr, c_blocker_fr] THEN
    RAISE EXCEPTION 'owner view read returned %, expected all but the banned author', ids;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'block_and_comment_privacy_test passed';
END
$$;

ROLLBACK;
