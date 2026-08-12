-- Regression coverage for execution privileges and self-authorization on
-- non_public_observation_count, profile_has_pro_access, are_friends, and
-- is_blocked_between.

BEGIN;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-00000000ce41';
  other_id uuid := '00000000-0000-4000-8000-00000000ce42';
  stranger_id uuid := '00000000-0000-4000-8000-00000000ce43';
  owner_count integer;
  call_denied boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id, 'authenticated', 'authenticated', 'helper-owner@example.test', '{}'::jsonb, now(), now()),
    (other_id, 'authenticated', 'authenticated', 'helper-other@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, cloud_plan, is_pro, is_banned)
  VALUES
    (owner_id, 'helper_owner', 'free', false, false),
    (other_id, 'helper_other', 'pro', true, false)
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    cloud_plan = EXCLUDED.cloud_plan,
    is_pro = EXCLUDED.is_pro,
    is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (
    id, user_id, date, visibility, location_precision, is_draft
  )
  OVERRIDING SYSTEM VALUE
  VALUES
    (880000000041, owner_id, current_date, 'private', 'exact', false),
    (880000000042, owner_id, current_date, 'public', 'fuzzed', false),
    (880000000043, owner_id, current_date, 'private', 'exact', true),
    (880000000044, owner_id, current_date, 'public', 'exact', false),
    (880000000045, other_id, current_date, 'private', 'exact', false)
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    date = EXCLUDED.date,
    visibility = EXCLUDED.visibility,
    location_precision = EXCLUDED.location_precision,
    is_draft = EXCLUDED.is_draft;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, other_id, 'accepted')
  ON CONFLICT (requester_id, addressee_id) DO UPDATE SET
    status = EXCLUDED.status;

  IF has_function_privilege('anon', 'public.non_public_observation_count(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.profile_has_pro_access(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.are_friends(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.is_blocked_between(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon retains execution on a restricted helper';
  END IF;

  IF NOT has_function_privilege(
    'authenticated', 'public.non_public_observation_count(uuid)', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated self-count execution grant is missing';
  END IF;

  IF has_function_privilege('authenticated', 'public.profile_has_pro_access(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.are_friends(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.is_blocked_between(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated retains direct execution on an internal helper';
  END IF;

  IF has_function_privilege('service_role', 'public.non_public_observation_count(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.profile_has_pro_access(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.are_friends(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.is_blocked_between(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role retains unnecessary direct helper execution';
  END IF;

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  call_denied := false;
  BEGIN
    PERFORM public.non_public_observation_count(owner_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'anon called non_public_observation_count';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.profile_has_pro_access(owner_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'anon directly called profile_has_pro_access';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.are_friends(owner_id, other_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'anon directly called are_friends';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.is_blocked_between(owner_id, other_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'anon directly called is_blocked_between';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  SELECT public.non_public_observation_count(owner_id) INTO owner_count;
  IF owner_count <> 2 THEN
    RAISE EXCEPTION 'owner privacy-slot count expected 2, got %', owner_count;
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.non_public_observation_count(other_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'authenticated user retrieved another user privacy-slot count';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.profile_has_pro_access(owner_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'authenticated user directly called profile_has_pro_access';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.are_friends(owner_id, other_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'authenticated user directly called are_friends';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.is_blocked_between(owner_id, other_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'authenticated user directly called is_blocked_between';
  END IF;

  IF NOT public.current_user_is_friend_with(other_id) THEN
    RAISE EXCEPTION 'current-user friendship view helper stopped working';
  END IF;
  IF public.current_user_is_blocked_with(other_id) THEN
    RAISE EXCEPTION 'unexpected block before block fixture creation';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.are_friends(other_id, stranger_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'authenticated user queried a cross-user friendship';
  END IF;

  call_denied := false;
  BEGIN
    PERFORM public.is_blocked_between(other_id, stranger_id);
  EXCEPTION WHEN insufficient_privilege THEN
    call_denied := true;
  END;
  IF NOT call_denied THEN
    RAISE EXCEPTION 'authenticated user queried a cross-user block';
  END IF;

  -- can_read_observation is a postgres-owned authorization path. It must keep
  -- using are_friends and is_blocked_between after their client grants vanish.
  IF NOT public.can_read_observation(other_id, 'friends') THEN
    RAISE EXCEPTION 'internal friendship authorization stopped working';
  END IF;

  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (owner_id, other_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  IF public.can_read_observation(other_id, 'friends') THEN
    RAISE EXCEPTION 'internal bidirectional block authorization stopped working';
  END IF;
  IF NOT public.current_user_is_blocked_with(other_id) THEN
    RAISE EXCEPTION 'current-user block view helper stopped working';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', other_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);

  -- This owner insert fires the postgres-owned privacy-limit trigger, proving
  -- its internal profile_has_pro_access call still works without client EXECUTE.
  INSERT INTO public.observations (
    user_id, date, visibility, location_precision, is_draft
  ) VALUES (
    other_id, current_date, 'private', 'exact', false
  );

  SELECT public.non_public_observation_count(other_id) INTO owner_count;
  IF owner_count <> 2 THEN
    RAISE EXCEPTION 'second owner privacy-slot count expected 2, got %', owner_count;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'identity_helper_execution_test passed';
END
$$;

ROLLBACK;
