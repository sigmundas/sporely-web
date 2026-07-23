-- Validates public.record_client_activity and its upsert semantics.
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/client_activity_daily_test.sql
--
-- The fixture cleans up its rows before returning. If any assertion fails,
-- the DO block aborts and rolls back.
--
-- Note on desktop_app: this test writes 'desktop_app' by impersonating an
-- authenticated user and calling the RPC directly. In production the value
-- comes exclusively from the PySide6 desktop app (sporely-py), which must
-- wire its own call to record_client_activity — the sporely-web codebase
-- never emits 'desktop_app'.

DO $$
DECLARE
  user_a uuid := '00000000-0000-4000-8000-0000000ca001';
  user_b uuid := '00000000-0000-4000-8000-0000000ca002';
  today date := (now() at time zone 'utc')::date;
  yesterday date := today - 1;
  row_count int;
  first_ts timestamptz;
  last_ts timestamptz;
  profile_row record;
  isolation_error text;
  seen_by_b int;
BEGIN
  -- Seed auth users + profiles.
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (user_a, 'authenticated', 'authenticated', 'client-activity-a@example.test', '{}'::jsonb, now(), now()),
    (user_b, 'authenticated', 'authenticated', 'client-activity-b@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, display_name, is_banned)
  VALUES (user_a, 'User A', false), (user_b, 'User B', false)
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  -- Assertion 1: unauthenticated call raises.
  BEGIN
    PERFORM public.record_client_activity('web_browser', '1.0.0');
    RAISE EXCEPTION 'record_client_activity should require auth';
  EXCEPTION WHEN OTHERS THEN
    -- expected
    NULL;
  END;

  -- Impersonate user_a.
  PERFORM set_config('request.jwt.claim.sub', user_a::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', user_a::text, 'role', 'authenticated')::text,
    true);

  -- Assertion 2: invalid client rejected.
  BEGIN
    PERFORM public.record_client_activity('not_real', '1.0.0');
    RAISE EXCEPTION 'record_client_activity should reject unknown client bucket';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Assertion 3: first call inserts a row and sets profile fields.
  PERFORM public.record_client_activity('web_browser', '1.0.0');

  SELECT count(*) INTO row_count
    FROM public.client_activity_daily
   WHERE user_id = user_a AND activity_date = today;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'expected 1 activity row after first call, got %', row_count;
  END IF;

  SELECT first_seen_at, last_seen_at INTO first_ts, last_ts
    FROM public.client_activity_daily
   WHERE user_id = user_a AND activity_date = today AND client = 'web_browser' AND app_version = '1.0.0';
  IF first_ts IS NULL OR last_ts IS NULL OR first_ts <> last_ts THEN
    RAISE EXCEPTION 'first insert should have first_seen_at = last_seen_at, got % / %', first_ts, last_ts;
  END IF;

  SELECT last_client, last_app_version, last_client_seen_at INTO profile_row
    FROM public.profiles WHERE id = user_a;
  IF profile_row.last_client <> 'web_browser'
    OR profile_row.last_app_version <> '1.0.0'
    OR profile_row.last_client_seen_at IS NULL
  THEN
    RAISE EXCEPTION 'profiles.last_* not updated: %', profile_row;
  END IF;

  -- Assertion 4: same-day repeat with identical (client, version) upserts
  -- (no new row) and advances last_seen_at while keeping first_seen_at.
  -- The RPC uses clock_timestamp() (not now(), which is transaction-scoped),
  -- but pg_sleep guarantees the wall clock has moved even on a fast machine.
  PERFORM pg_sleep(0.01);
  PERFORM public.record_client_activity('web_browser', '1.0.0');

  SELECT count(*) INTO row_count
    FROM public.client_activity_daily
   WHERE user_id = user_a AND activity_date = today;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'expected still 1 activity row after repeat, got %', row_count;
  END IF;

  DECLARE
    new_first timestamptz;
    new_last timestamptz;
  BEGIN
    SELECT first_seen_at, last_seen_at INTO new_first, new_last
      FROM public.client_activity_daily
     WHERE user_id = user_a AND activity_date = today AND client = 'web_browser' AND app_version = '1.0.0';
    IF new_first <> first_ts THEN
      RAISE EXCEPTION 'first_seen_at must be preserved across upserts (was %, now %)', first_ts, new_first;
    END IF;
    IF new_last <= last_ts THEN
      RAISE EXCEPTION 'last_seen_at must advance across upserts (was %, now %)', last_ts, new_last;
    END IF;
  END;

  -- Assertion 5: same day, different client → separate row.
  PERFORM public.record_client_activity('web_pwa', '1.0.0');
  SELECT count(*) INTO row_count
    FROM public.client_activity_daily
   WHERE user_id = user_a AND activity_date = today;
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'expected 2 rows after adding second client, got %', row_count;
  END IF;

  -- Assertion 6: same day, version change → separate row.
  PERFORM public.record_client_activity('web_browser', '1.0.1');
  SELECT count(*) INTO row_count
    FROM public.client_activity_daily
   WHERE user_id = user_a AND activity_date = today;
  IF row_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 rows after version bump, got %', row_count;
  END IF;

  -- Assertion 7: profile now tracks the latest call.
  SELECT last_client, last_app_version INTO profile_row FROM public.profiles WHERE id = user_a;
  IF profile_row.last_client <> 'web_browser' OR profile_row.last_app_version <> '1.0.1' THEN
    RAISE EXCEPTION 'profile last_client/version should reflect newest call, got %', profile_row;
  END IF;

  -- Assertion 8: null / empty version stored as '' and profile.last_app_version stays NULL.
  PERFORM public.record_client_activity('desktop_app', NULL);
  IF NOT EXISTS (
    SELECT 1 FROM public.client_activity_daily
     WHERE user_id = user_a AND activity_date = today AND client = 'desktop_app' AND app_version = ''
  ) THEN
    RAISE EXCEPTION 'NULL app_version should upsert with empty string';
  END IF;
  SELECT last_app_version INTO profile_row.last_app_version FROM public.profiles WHERE id = user_a;
  IF profile_row.last_app_version IS NOT NULL THEN
    RAISE EXCEPTION 'profile.last_app_version should reset to NULL for empty version, got %', profile_row.last_app_version;
  END IF;

  -- Assertion 9: over-length version is truncated to 32 chars, not rejected.
  PERFORM public.record_client_activity('web_browser', repeat('x', 200));
  IF NOT EXISTS (
    SELECT 1 FROM public.client_activity_daily
     WHERE user_id = user_a AND activity_date = today
       AND client = 'web_browser'
       AND char_length(app_version) = 32
  ) THEN
    RAISE EXCEPTION 'over-length version should be truncated to 32 chars';
  END IF;

  -- Assertion 10: authenticated-user isolation. user_b writing must not touch
  -- user_a's rows, and user_b cannot SELECT user_a's rows.
  PERFORM set_config('request.jwt.claim.sub', user_b::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', user_b::text, 'role', 'authenticated')::text,
    true);
  PERFORM public.record_client_activity('android_app', '2.0.0');

  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT count(*) INTO seen_by_b
      FROM public.client_activity_daily WHERE user_id = user_a;
    IF seen_by_b <> 0 THEN
      RAISE EXCEPTION 'user_b saw % of user_a activity rows through RLS', seen_by_b;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    isolation_error := SQLERRM;
    RESET ROLE;
    RAISE;
  END;
  RESET ROLE;

  -- Cleanup.
  DELETE FROM public.client_activity_daily WHERE user_id IN (user_a, user_b);
  DELETE FROM public.profiles WHERE id IN (user_a, user_b);
  DELETE FROM auth.users WHERE id IN (user_a, user_b);

  RAISE NOTICE 'client_activity_daily_test passed';
END $$;
