-- Regression coverage for the Phase 7 comments policies after removal of the
-- legacy permissive comments_* policies.

BEGIN;

DO $$
DECLARE
  visible_owner_id uuid := '00000000-0000-4000-8000-00000000cd31';
  private_owner_id uuid := '00000000-0000-4000-8000-00000000cd32';
  blocked_owner_id uuid := '00000000-0000-4000-8000-00000000cd33';
  banned_owner_id uuid := '00000000-0000-4000-8000-00000000cd34';
  viewer_id uuid := '00000000-0000-4000-8000-00000000cd35';
  friend_owner_id uuid := '00000000-0000-4000-8000-00000000cd36';
  visible_observation_id bigint := 880000000031;
  private_observation_id bigint := 880000000032;
  blocked_observation_id bigint := 880000000033;
  banned_observation_id bigint := 880000000034;
  friend_observation_id bigint := 880000000036;
  visible_comment_id bigint := 880000000031;
  private_comment_id bigint := 880000000032;
  blocked_comment_id bigint := 880000000033;
  banned_comment_id bigint := 880000000034;
  hidden_comment_id bigint := 880000000035;
  friend_comment_id bigint := 880000000036;
  inserted_comment_id bigint;
  inserted_friend_comment_id bigint;
  row_count bigint;
  insert_denied boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (visible_owner_id, 'authenticated', 'authenticated', 'comment-visible-owner@example.test', '{}'::jsonb, now(), now()),
    (private_owner_id, 'authenticated', 'authenticated', 'comment-private-owner@example.test', '{}'::jsonb, now(), now()),
    (blocked_owner_id, 'authenticated', 'authenticated', 'comment-blocked-owner@example.test', '{}'::jsonb, now(), now()),
    (banned_owner_id, 'authenticated', 'authenticated', 'comment-banned-owner@example.test', '{}'::jsonb, now(), now()),
    (viewer_id, 'authenticated', 'authenticated', 'comment-viewer@example.test', '{}'::jsonb, now(), now()),
    (friend_owner_id, 'authenticated', 'authenticated', 'comment-friend-owner@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, is_banned)
  VALUES
    (visible_owner_id, 'comment_visible_owner', false),
    (private_owner_id, 'comment_private_owner', false),
    (blocked_owner_id, 'comment_blocked_owner', false),
    (banned_owner_id, 'comment_banned_owner', true),
    (viewer_id, 'comment_viewer', false),
    (friend_owner_id, 'comment_friend_owner', false)
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES
    (visible_observation_id, visible_owner_id, current_date, 'public', false),
    (private_observation_id, private_owner_id, current_date, 'private', false),
    (blocked_observation_id, blocked_owner_id, current_date, 'public', false),
    (banned_observation_id, banned_owner_id, current_date, 'public', false),
    (friend_observation_id, friend_owner_id, current_date, 'friends', false)
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    date = EXCLUDED.date,
    visibility = EXCLUDED.visibility,
    is_draft = EXCLUDED.is_draft;

  INSERT INTO public.comments (id, observation_id, user_id, body)
  VALUES
    (visible_comment_id, visible_observation_id, visible_owner_id, 'Visible comment'),
    (private_comment_id, private_observation_id, private_owner_id, 'Private comment'),
    (blocked_comment_id, blocked_observation_id, blocked_owner_id, 'Blocked comment'),
    (banned_comment_id, banned_observation_id, banned_owner_id, 'Banned comment'),
    (hidden_comment_id, visible_observation_id, visible_owner_id, 'Hidden comment'),
    (friend_comment_id, friend_observation_id, friend_owner_id, 'Friend comment')
  ON CONFLICT (id) DO UPDATE SET
    observation_id = EXCLUDED.observation_id,
    user_id = EXCLUDED.user_id,
    body = EXCLUDED.body;

  INSERT INTO public.comment_moderation (comment_id, hidden_at, hidden_reason)
  VALUES (hidden_comment_id, now(), 'comments RLS regression fixture')
  ON CONFLICT (comment_id) DO UPDATE SET
    hidden_at = EXCLUDED.hidden_at,
    hidden_reason = EXCLUDED.hidden_reason;

  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (viewer_id, blocked_owner_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (viewer_id, friend_owner_id, 'accepted')
  ON CONFLICT (requester_id, addressee_id) DO UPDATE SET
    status = EXCLUDED.status;

  SELECT count(*) INTO row_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'comments'
    AND policyname IN ('comments_delete', 'comments_insert', 'comments_select');
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'legacy permissive comments policies remain active';
  END IF;

  SELECT count(*) INTO row_count
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'comments'
    AND policyname IN (
      'phase7_comments_delete_own',
      'phase7_comments_insert_visible',
      'phase7_comments_read',
      'phase7_comments_update_own'
    );
  IF row_count <> 4 THEN
    RAISE EXCEPTION 'expected all four Phase 7 comments policies, got %', row_count;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', viewer_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);

  INSERT INTO public.comments (observation_id, user_id, body)
  VALUES (visible_observation_id, viewer_id, 'Allowed viewer comment')
  RETURNING id INTO inserted_comment_id;

  INSERT INTO public.comments (observation_id, user_id, body)
  VALUES (friend_observation_id, viewer_id, 'Allowed friend comment')
  RETURNING id INTO inserted_friend_comment_id;

  insert_denied := false;
  BEGIN
    INSERT INTO public.comments (observation_id, user_id, body)
    VALUES (private_observation_id, viewer_id, 'Must be denied');
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'viewer commented on an inaccessible private observation';
  END IF;

  insert_denied := false;
  BEGIN
    INSERT INTO public.comments (observation_id, user_id, body)
    VALUES (blocked_observation_id, viewer_id, 'Must be denied');
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'viewer commented across an observation-owner block';
  END IF;

  insert_denied := false;
  BEGIN
    INSERT INTO public.comments (observation_id, user_id, body)
    VALUES (banned_observation_id, viewer_id, 'Must be denied');
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'viewer commented on a banned owner observation';
  END IF;

  -- Forged user_id: viewer (authenticated as viewer_id) attempts to insert a
  -- comment on the accessible public observation but supplies visible_owner_id
  -- as the acting user. The auth.uid() = user_id half of
  -- phase7_comments_insert_visible must deny this.
  insert_denied := false;
  BEGIN
    INSERT INTO public.comments (observation_id, user_id, body)
    VALUES (visible_observation_id, visible_owner_id, 'Must be denied: forged user_id');
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'viewer inserted a comment with a forged user_id for another user';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.comments
  WHERE id IN (private_comment_id, blocked_comment_id, banned_comment_id, hidden_comment_id);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'viewer directly read inaccessible or moderated comments';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.comments_community_view
  WHERE id IN (private_comment_id, blocked_comment_id, banned_comment_id, hidden_comment_id);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'viewer read inaccessible or moderated comments through the client view';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.comments
  WHERE id IN (visible_comment_id, inserted_comment_id);
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'viewer could not read comments for an accessible public observation';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.comments
  WHERE id IN (friend_comment_id, inserted_friend_comment_id);
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'accepted friend could not comment on and read a friends-only observation';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', private_owner_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', private_owner_id::text, true);

  INSERT INTO public.comments (observation_id, user_id, body)
  VALUES (private_observation_id, private_owner_id, 'Allowed owner comment')
  RETURNING id INTO inserted_comment_id;

  SELECT count(*) INTO row_count
  FROM public.comments
  WHERE id IN (private_comment_id, inserted_comment_id);
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'owner could not comment on and read their own private observation';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT count(*) INTO row_count
  FROM public.comments
  WHERE id = visible_comment_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon directly read comments through authenticated-only RLS';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.comments_community_view
  WHERE id = visible_comment_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'anon could not read a public comment through the public client view';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.comments_community_view
  WHERE id = friend_comment_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon read a friends-only comment through the public client view';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'comments_rls_test passed';
END
$$;

ROLLBACK;
