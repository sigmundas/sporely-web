-- A profile that has not finished setup is not public.
--
-- handle_new_user() seeds username from the email local part and
-- display_name from the provider's full name. Until the owner completes
-- setup (profile_completed_at), neither public projection may return the
-- row: public_profiles / read_public_profiles() and search_people_directory.
-- Covers 20261125210000_hide_unfinished_profiles_from_public_projections.sql.
--
-- The unfinished fixture carries exactly what handle_new_user() seeds for a
-- Google sign-up. The auth.users trigger that calls it is not part of the
-- repo migrations, so the row is written here whether or not the trigger ran.

BEGIN;

DO $$
DECLARE
  unfinished_id uuid := '00000000-0000-4000-8000-00000000dd31';
  finished_id uuid := '00000000-0000-4000-8000-00000000dd32';
  viewer_id uuid := '00000000-0000-4000-8000-00000000dd33';
  row_count bigint;
  own_username text;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (unfinished_id, 'authenticated', 'authenticated', 'zq.unfinished.person@example.test',
     '{"full_name": "Zq Unfinished Realname"}'::jsonb, now(), now()),
    (finished_id, 'authenticated', 'authenticated', 'zq.finished.person@example.test',
     '{"full_name": "Zq Finished Realname"}'::jsonb, now(), now()),
    (viewer_id, 'authenticated', 'authenticated', 'zq.viewer.person@example.test',
     '{}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, profile_completed_at)
  VALUES
    (unfinished_id, 'zq.unfinished.person', 'Zq Unfinished Realname', NULL),
    (finished_id, 'zq.finished.person', 'Zq Finished Realname', now()),
    (viewer_id, 'zq.viewer.person', 'Zq Viewer', now())
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    profile_completed_at = EXCLUDED.profile_completed_at;

  IF NOT has_function_privilege('anon', 'public.read_public_profiles()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.search_people_directory(integer, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.search_people_directory(integer, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'public profile projections lost a client EXECUTE grant';
  END IF;

  -- ── Signed out ─────────────────────────────────────────────────────────
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT count(*) INTO row_count FROM public.public_profiles WHERE id = unfinished_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon read an unfinished profile through public_profiles';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.public_profiles
  WHERE username ILIKE '%zq.unfinished%' OR display_name ILIKE '%Unfinished Realname%';
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon matched an unfinished profile by its seeded email local part or provider name';
  END IF;

  SELECT count(*) INTO row_count FROM public.public_profiles WHERE id = finished_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'anon lost a finished profile from public_profiles';
  END IF;

  -- Listing (no query), search by email local part, search by provider name.
  -- The seeded names start with "zq" so the page is not crowded out.
  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, NULL)
  WHERE user_id = unfinished_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon people directory listed an unfinished profile';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, 'zq.unfinished');
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon people directory matched an unfinished profile by email local part';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, 'Unfinished Realname');
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon people directory matched an unfinished profile by provider name';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, 'zq.finished')
  WHERE user_id = finished_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'anon people directory lost a finished profile';
  END IF;

  -- ── Another signed-in user ─────────────────────────────────────────────
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', viewer_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);

  SELECT count(*) INTO row_count FROM public.public_profiles WHERE id = unfinished_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'a signed-in user read an unfinished profile through public_profiles';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, 'zq.')
  WHERE user_id = unfinished_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'a signed-in user found an unfinished profile in the people directory';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, 'zq.')
  WHERE user_id = finished_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'a signed-in user lost a finished profile from the people directory';
  END IF;

  -- ── The owner of the unfinished profile ────────────────────────────────
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', unfinished_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', unfinished_id::text, true);

  -- The setup screen prefill still works: the owner reads their own row.
  SELECT username INTO own_username FROM public.profiles WHERE id = unfinished_id;
  IF own_username IS DISTINCT FROM 'zq.unfinished.person' THEN
    RAISE EXCEPTION 'owner could not read their own unfinished profile row';
  END IF;

  -- Finishing setup, as the owner, is what publishes the profile.
  UPDATE public.profiles
  SET username = 'zq_chosen_name',
      display_name = 'Zq Chosen',
      profile_completed_at = now()
  WHERE id = unfinished_id;

  RESET ROLE;
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT count(*) INTO row_count
  FROM public.public_profiles
  WHERE id = unfinished_id AND username = 'zq_chosen_name';
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'a profile did not become public after its owner finished setup';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.search_people_directory(100, 0, 'zq_chosen')
  WHERE user_id = unfinished_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'a finished profile is missing from the people directory';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'unfinished_profile_privacy_test passed';
END
$$;

ROLLBACK;
