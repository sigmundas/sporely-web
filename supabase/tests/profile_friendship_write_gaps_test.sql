-- Validates 20261118120000_close_profile_and_friendship_write_gaps.sql.
--
-- Clients may update their own profile but never insert or delete one, and
-- may only send 'pending' friend requests that the addressee accepts.
--
-- Run after local migrations (rolls back its seed data):
--   supabase db query --local -f supabase/tests/profile_friendship_write_gaps_test.sql

BEGIN;

DO $$
DECLARE
  u_a uuid := '00000000-0000-4000-8000-00000000fa01';
  u_b uuid := '00000000-0000-4000-8000-00000000fa02';
  u_c uuid := '00000000-0000-4000-8000-00000000fa03';
  u_noprof uuid := '00000000-0000-4000-8000-00000000fa04';
  v_count integer;
  v_bool boolean;
  v_text text;
  v_req bigint;
  v_req2 bigint;
  v_failed boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (u_a, 'authenticated', 'authenticated', 'fw-a@example.test', '{}'::jsonb, now(), now()),
    (u_b, 'authenticated', 'authenticated', 'fw-b@example.test', '{}'::jsonb, now(), now()),
    (u_c, 'authenticated', 'authenticated', 'fw-c@example.test', '{}'::jsonb, now(), now()),
    (u_noprof, 'authenticated', 'authenticated', 'fw-d@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_admin, is_banned)
  VALUES
    (u_a, 'fw_a', 'A', false, false),
    (u_b, 'fw_b', 'B', false, false),
    (u_c, 'fw_c', 'C', false, false)
  -- Production's on_auth_user_created trigger may already have created these
  -- rows from the email, so reset every column the assertions read.
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    is_admin = false,
    is_banned = false;
  DELETE FROM public.profiles WHERE id = u_noprof;
  DELETE FROM public.friendships
   WHERE requester_id IN (u_a, u_b, u_c) OR addressee_id IN (u_a, u_b, u_c);

  -- ===== profiles, as A ======================================================
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', u_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', u_a::text, 'role', 'authenticated')::text, true);

  -- P1: deleting the own profile row is refused.
  v_failed := false;
  BEGIN
    DELETE FROM public.profiles WHERE id = u_a;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'P1: authenticated DELETE on profiles must be refused';
  END IF;

  -- P2: ordinary profile edits still work, and the privileged clamp holds.
  UPDATE public.profiles SET display_name = 'A edited', is_admin = true WHERE id = u_a;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'P2: owner profile update must still succeed (rows=%)', v_count;
  END IF;

  -- P3: another user's profile is neither visible nor updatable.
  UPDATE public.profiles SET display_name = 'hijack' WHERE id = u_b;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'P3: updating another profile must affect no rows (rows=%)', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.profiles WHERE id = u_b;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'P3: another user''s profile row must not be readable';
  END IF;
  RESET ROLE;

  SELECT is_admin, display_name INTO v_bool, v_text FROM public.profiles WHERE id = u_a;
  IF v_bool IS DISTINCT FROM false OR v_text IS DISTINCT FROM 'A edited' THEN
    RAISE EXCEPTION 'P2: expected is_admin=false, display_name=A edited; got %, %', v_bool, v_text;
  END IF;
  SELECT display_name INTO v_text FROM public.profiles WHERE id = u_b;
  IF v_text IS DISTINCT FROM 'B' THEN
    RAISE EXCEPTION 'P3: B''s profile changed to %', v_text;
  END IF;

  -- P4: a user without a profile row cannot create one (here with is_admin).
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', u_noprof::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', u_noprof::text, 'role', 'authenticated')::text, true);
  v_failed := false;
  BEGIN
    INSERT INTO public.profiles (id, username, is_admin) VALUES (u_noprof, 'fw_d', true);
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'P4: authenticated INSERT on profiles must be refused';
  END IF;
  SELECT count(*) INTO v_count FROM public.profiles WHERE id = u_noprof;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'P4: profile row must not have been created';
  END IF;

  -- ===== friendships, as A ===================================================
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', u_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', u_a::text, 'role', 'authenticated')::text, true);

  -- F1: a pending request is allowed (the app's only insert shape).
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (u_a, u_b, 'pending')
  RETURNING id INTO v_req;

  -- F2: inserting an already-accepted friendship is refused.
  v_failed := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES (u_a, u_c, 'accepted');
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F2: inserting status=accepted must be refused';
  END IF;

  -- F3: 'blocked' and self-requests are refused.
  v_failed := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES (u_a, u_c, 'blocked');
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F3: inserting status=blocked must be refused';
  END IF;
  v_failed := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status) VALUES (u_a, u_a, 'pending');
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F3: a self friendship request must be refused';
  END IF;

  -- F3b: an upsert cannot turn the pending request into an accepted one.
  v_failed := false;
  BEGIN
    INSERT INTO public.friendships (requester_id, addressee_id, status)
    VALUES (u_a, u_b, 'pending')
    ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  SELECT status INTO v_text FROM public.friendships WHERE id = v_req;
  IF v_text IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'F3b: upsert must not accept the request (status=%, refused=%)', v_text, v_failed;
  END IF;

  -- F4: the requester cannot accept their own request.
  UPDATE public.friendships SET status = 'accepted' WHERE id = v_req;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'F4: requester must not be able to accept (rows=%)', v_count;
  END IF;

  -- F5: the requester cannot retarget the request at someone else.
  v_failed := false;
  BEGIN
    UPDATE public.friendships SET addressee_id = u_c WHERE id = v_req;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F5: updating addressee_id must be refused';
  END IF;
  RESET ROLE;

  -- ===== friendships, as B (addressee) =======================================
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', u_b::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', u_b::text, 'role', 'authenticated')::text, true);

  -- F6: the addressee cannot swap the requester (would forge C -> B).
  v_failed := false;
  BEGIN
    UPDATE public.friendships SET requester_id = u_c, status = 'accepted' WHERE id = v_req;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F6: updating requester_id must be refused';
  END IF;

  -- F7: the addressee cannot set any status other than accepted.
  v_failed := false;
  BEGIN
    UPDATE public.friendships SET status = 'blocked' WHERE id = v_req;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F7: addressee setting status=blocked must be refused';
  END IF;

  -- F8: the addressee accepts (the app's accept call).
  UPDATE public.friendships SET status = 'accepted' WHERE id = v_req;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F8: addressee accept must succeed (rows=%)', v_count;
  END IF;

  -- F9: an accepted friendship cannot be flipped back by the client.
  UPDATE public.friendships SET status = 'pending' WHERE id = v_req;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'F9: accepted row must not be updatable (rows=%)', v_count;
  END IF;
  RESET ROLE;

  SELECT status INTO v_text FROM public.friendships WHERE id = v_req;
  IF v_text IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'F8: expected accepted, got %', v_text;
  END IF;
  IF NOT public.are_friends(u_a, u_b) OR public.are_friends(u_a, u_c) THEN
    RAISE EXCEPTION 'F8: are_friends must be true for A/B and false for A/C';
  END IF;

  -- F10: either party can still delete (decline / unfriend).
  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (u_c, u_a, 'pending') RETURNING id INTO v_req2;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', u_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', u_a::text, 'role', 'authenticated')::text, true);
  DELETE FROM public.friendships WHERE id IN (v_req, v_req2);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RESET ROLE;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'F10: a party must be able to delete both rows (rows=%)', v_count;
  END IF;

  -- F11: anon has no table access at all.
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
  v_failed := false;
  BEGIN
    PERFORM 1 FROM public.friendships LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'F11: anon SELECT on friendships must be refused';
  END IF;

  RAISE NOTICE 'profile_friendship_write_gaps_test: all assertions passed';
END
$$;

ROLLBACK;
