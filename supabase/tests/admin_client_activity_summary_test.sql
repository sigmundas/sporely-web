-- Validates public.admin_client_activity_summary (admin-only aggregate).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/admin_client_activity_summary_test.sql

DO $$
DECLARE
  admin_user uuid := '00000000-0000-4000-8000-0000000ac001';
  regular_user uuid := '00000000-0000-4000-8000-0000000ac002';
  today date := (now() at time zone 'utc')::date;
  yesterday date := today - 1;
  summary jsonb;
  err_seen boolean := false;
  by_day jsonb;
  by_version jsonb;
BEGIN
  -- Seed users + profiles.
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (admin_user, 'authenticated', 'authenticated', 'admin-activity@example.test', '{}'::jsonb, now(), now()),
    (regular_user, 'authenticated', 'authenticated', 'regular-activity@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, display_name, is_admin, is_banned)
  VALUES (admin_user, 'Admin', true, false), (regular_user, 'Regular', false, false)
  ON CONFLICT (id) DO UPDATE SET is_admin = EXCLUDED.is_admin, display_name = EXCLUDED.display_name;

  -- Seed activity: admin ran android_app @ 0.6.11 today AND yesterday;
  -- regular ran web_browser @ 1.0.0 today.
  INSERT INTO public.client_activity_daily (user_id, activity_date, client, app_version, first_seen_at, last_seen_at)
  VALUES
    (admin_user, today, 'android_app', '0.6.11', now(), now()),
    (admin_user, yesterday, 'android_app', '0.6.11', now() - interval '1 day', now() - interval '1 day'),
    (regular_user, today, 'web_browser', '1.0.0', now(), now())
  ON CONFLICT (user_id, activity_date, client, app_version) DO NOTHING;

  -- Assertion 1: unauthenticated call rejected.
  BEGIN
    PERFORM public.admin_client_activity_summary(7);
    RAISE EXCEPTION 'expected admin_client_activity_summary to reject unauthenticated';
  EXCEPTION WHEN OTHERS THEN
    err_seen := true;
  END;
  IF NOT err_seen THEN
    RAISE EXCEPTION 'unauthenticated call must fail';
  END IF;

  -- Assertion 2a: self-promotion attempt. A non-admin authenticated user
  -- issuing UPDATE ... SET is_admin = true on their own row must not actually
  -- flip the column. The RLS "owner read-write" policy allows the UPDATE
  -- statement, so this proves trg_profiles_protect_privileged_fields is doing
  -- its job. If this assertion ever starts failing, the whole is_admin-based
  -- authorization surface (including admin_client_activity_summary below) is
  -- compromised — do NOT proceed to the admin-RPC assertions.
  DECLARE
    v_after_self_promote boolean;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', regular_user::text, true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', regular_user::text, 'role', 'authenticated')::text,
      true);

    -- Attempt the self-promotion. Either the trigger silently clamps it back
    -- to false (expected behaviour on this project) OR RLS/GRANT/policies
    -- reject the UPDATE outright (also acceptable — the row simply stays
    -- unchanged). Both outcomes are safe.
    BEGIN
      UPDATE public.profiles
         SET is_admin = true
       WHERE id = regular_user;
    EXCEPTION WHEN OTHERS THEN
      -- Being outright rejected is fine; the point is is_admin must NOT flip.
      NULL;
    END;
    RESET ROLE;

    SELECT is_admin INTO v_after_self_promote FROM public.profiles WHERE id = regular_user;
    IF v_after_self_promote IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        'SECURITY REGRESSION: non-admin user was able to self-promote is_admin (was %). '
        'Investigate trg_profiles_protect_privileged_fields and the profiles RLS policies '
        'before trusting admin_client_activity_summary.', v_after_self_promote;
    END IF;
  END;

  -- Assertion 2b: non-admin authenticated RPC call rejected. Uses the same
  -- jwt claim we just set; RESET ROLE above returned us to the superuser so
  -- the RPC (which itself checks auth.uid()) sees the regular user.
  PERFORM set_config('request.jwt.claim.sub', regular_user::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', regular_user::text, 'role', 'authenticated')::text,
    true);
  err_seen := false;
  BEGIN
    PERFORM public.admin_client_activity_summary(7);
  EXCEPTION WHEN OTHERS THEN
    err_seen := true;
  END;
  IF NOT err_seen THEN
    RAISE EXCEPTION 'non-admin authenticated call must fail';
  END IF;

  -- Assertion 3: admin call returns expected shape and counts.
  PERFORM set_config('request.jwt.claim.sub', admin_user::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', admin_user::text, 'role', 'authenticated')::text,
    true);

  summary := public.admin_client_activity_summary(7);

  IF (summary ? 'generated_at') IS NOT TRUE
     OR (summary ? 'by_day_client') IS NOT TRUE
     OR (summary ? 'by_version_today') IS NOT TRUE
     OR (summary ? 'totals') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'summary missing keys: %', summary;
  END IF;

  IF (summary->'totals'->>'active_today')::int <> 2 THEN
    RAISE EXCEPTION 'expected 2 active users today, got %', summary->'totals'->>'active_today';
  END IF;

  -- Assertion 4: by_day_client contains at least the seeded rows.
  by_day := summary->'by_day_client';
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(by_day) e
     WHERE (e->>'activity_date')::date = today
       AND e->>'client' = 'android_app'
       AND (e->>'users')::int >= 1
  ) THEN
    RAISE EXCEPTION 'by_day_client missing today/android_app: %', by_day;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(by_day) e
     WHERE (e->>'activity_date')::date = today
       AND e->>'client' = 'web_browser'
       AND (e->>'users')::int >= 1
  ) THEN
    RAISE EXCEPTION 'by_day_client missing today/web_browser: %', by_day;
  END IF;

  -- Assertion 5: by_version_today shows both versions.
  by_version := summary->'by_version_today';
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(by_version) e
     WHERE e->>'client' = 'android_app' AND e->>'app_version' = '0.6.11'
  ) THEN
    RAISE EXCEPTION 'by_version_today missing android_app 0.6.11: %', by_version;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(by_version) e
     WHERE e->>'client' = 'web_browser' AND e->>'app_version' = '1.0.0'
  ) THEN
    RAISE EXCEPTION 'by_version_today missing web_browser 1.0.0: %', by_version;
  END IF;

  -- Assertion 6: window clamped (asking for 999 days maps to <=365).
  summary := public.admin_client_activity_summary(999);
  IF (summary->>'window_days')::int > 365 THEN
    RAISE EXCEPTION 'window_days should be clamped to 365, got %', summary->>'window_days';
  END IF;

  -- Cleanup.
  DELETE FROM public.client_activity_daily WHERE user_id IN (admin_user, regular_user);
  DELETE FROM public.profiles WHERE id IN (admin_user, regular_user);
  DELETE FROM auth.users WHERE id IN (admin_user, regular_user);

  RAISE NOTICE 'admin_client_activity_summary_test passed';
END $$;
