-- Regression coverage for get_blocked_user_profiles().
-- Verifies: blocker sees blocked users' identity via the RPC;
-- another authenticated user calling it gets no rows for someone else's blocks;
-- anon receives permission-denied (42501 — no EXECUTE grant);
-- no extra profile columns are leaked beyond the declared five.

BEGIN;

DO $$
DECLARE
  v_blocker_id  uuid := '00000000-0000-4000-8000-00000000dd01';
  v_blocked_id  uuid := '00000000-0000-4000-8000-00000000dd02';
  v_other_id    uuid := '00000000-0000-4000-8000-00000000dd03';
  v_banned_id   uuid := '00000000-0000-4000-8000-00000000dd04';
  row_count        bigint;
  got_username     text;
  got_display_name text;
  got_avatar_url   text;
  col_names        text[];
  anon_denied      boolean := false;
BEGIN
  -- ── Fixtures ───────────────────────────────────────────────────────────────
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (v_blocker_id, 'authenticated', 'authenticated', 'blocked-rpc-blocker@example.test', '{}'::jsonb, now(), now()),
    (v_blocked_id, 'authenticated', 'authenticated', 'blocked-rpc-blocked@example.test', '{}'::jsonb, now(), now()),
    (v_other_id,   'authenticated', 'authenticated', 'blocked-rpc-other@example.test',   '{}'::jsonb, now(), now()),
    (v_banned_id,  'authenticated', 'authenticated', 'blocked-rpc-banned@example.test',  '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (
    id, username, display_name, avatar_url, bio,
    cloud_plan, is_pro, is_admin, is_banned, billing_customer_id,
    storage_used_bytes, last_client, last_client_seen_at
  ) VALUES
    (v_blocker_id, 'rpc_blocker',   'Blocker User',   NULL,                           NULL, 'free', false, false, false, NULL, 0, NULL, NULL),
    (v_blocked_id, 'rpc_blocked',   'Blocked User',   'https://example.test/b.png',   NULL, 'free', false, false, false, NULL, 0, NULL, NULL),
    (v_other_id,   'rpc_other',     'Other User',     NULL,                           NULL, 'free', false, false, false, NULL, 0, NULL, NULL),
    (v_banned_id,  'rpc_banned',    'Banned Blocked', NULL,                           NULL, 'free', false, false, true,  NULL, 0, NULL, NULL)
  ON CONFLICT (id) DO UPDATE SET
    username         = EXCLUDED.username,
    display_name     = EXCLUDED.display_name,
    avatar_url       = EXCLUDED.avatar_url,
    is_banned        = EXCLUDED.is_banned;

  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES
    (v_blocker_id, v_blocked_id),
    (v_blocker_id, v_banned_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  -- ── Verify return columns (no leakage) ────────────────────────────────────
  -- The function must return exactly: blocked_id, username, display_name,
  -- avatar_url, created_at — no entitlement, billing, or moderation fields.
  -- For RETURNS TABLE functions, output columns live in proargnames where
  -- proargmodes = 't'.
  SELECT ARRAY(
    SELECT unnest(p.proargnames[i:i])
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
    generate_subscripts(p.proargmodes, 1) AS i
    WHERE n.nspname = 'public'
      AND p.proname = 'get_blocked_user_profiles'
      AND p.proargmodes[i] = 't'
    ORDER BY i
  ) INTO col_names;

  IF col_names IS DISTINCT FROM ARRAY['blocked_id', 'username', 'display_name', 'avatar_url', 'created_at']::text[] THEN
    RAISE EXCEPTION 'get_blocked_user_profiles returns unexpected columns: %', col_names;
  END IF;

  -- ── anon: no EXECUTE grant → permission denied (42501) ────────────────────
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  BEGIN
    PERFORM public.get_blocked_user_profiles();
  EXCEPTION WHEN insufficient_privilege THEN
    anon_denied := true;
  END;
  IF NOT anon_denied THEN
    RAISE EXCEPTION 'anon should receive permission denied on get_blocked_user_profiles, but it did not';
  END IF;

  -- ── other authenticated user: sees only their own blocks (none here) ───────
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_other_id::text, true);

  SELECT count(*) INTO row_count FROM public.get_blocked_user_profiles();
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'other user got % rows (should see none — has no blocks)', row_count;
  END IF;

  -- ── blocker: sees their two blocked users ─────────────────────────────────
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_blocker_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', v_blocker_id::text, true);

  SELECT count(*) INTO row_count FROM public.get_blocked_user_profiles();
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'blocker expected 2 blocked rows, got %', row_count;
  END IF;

  -- Verify identity fields for the non-banned blocked user
  SELECT r.username, r.display_name, r.avatar_url
  INTO got_username, got_display_name, got_avatar_url
  FROM public.get_blocked_user_profiles() r
  WHERE r.blocked_id = v_blocked_id;

  IF got_username IS DISTINCT FROM 'rpc_blocked' THEN
    RAISE EXCEPTION 'expected username rpc_blocked, got %', got_username;
  END IF;
  IF got_display_name IS DISTINCT FROM 'Blocked User' THEN
    RAISE EXCEPTION 'expected display_name "Blocked User", got %', got_display_name;
  END IF;
  IF got_avatar_url IS DISTINCT FROM 'https://example.test/b.png' THEN
    RAISE EXCEPTION 'expected avatar_url set, got %', got_avatar_url;
  END IF;

  -- Banned blocked user is also returned (blocker needs to recognise + unblock)
  SELECT count(*) INTO row_count
  FROM public.get_blocked_user_profiles() r
  WHERE r.blocked_id = v_banned_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'banned blocked user should appear in blocker''s list, got %', row_count;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'blocked_user_profiles_test passed';
END
$$;

ROLLBACK;
