-- A profile that has not finished setup has no public name.
--
-- handle_new_user() seeds username from the email local part and
-- display_name from the provider's full name. Until the owner completes
-- setup (profile_completed_at), nobody else may read those values through:
--
--   1. search_people_directory
--   2. public_profiles / read_public_profiles()
--   3. community_contributor_label (author label of public observations)
--   4. get_blocked_user_profiles (the caller's own block list)
--   5. private.shared_reference_contribution_envelope (contributor label)
--
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
  contribution_id uuid := '00000000-0000-4000-8000-00000000dd3f';
  row_count bigint;
  page_offset integer;
  page_rows bigint;
  own_username text;
  label text;
  blocked_row record;
  envelope jsonb;
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

  -- The migration re-creates five functions; none may gain or lose a client
  -- grant on the way.
  IF NOT has_function_privilege('anon', 'public.read_public_profiles()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.read_public_profiles()', 'EXECUTE')
     OR NOT has_table_privilege('anon', 'public.public_profiles', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.public_profiles', 'SELECT')
     OR NOT has_function_privilege('anon', 'public.search_people_directory(integer, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.search_people_directory(integer, integer, text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.community_contributor_label(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.community_contributor_label(uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_blocked_user_profiles()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a public profile function lost a client grant';
  END IF;
  IF has_function_privilege('anon', 'public.get_blocked_user_profiles()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon gained EXECUTE on get_blocked_user_profiles';
  END IF;
  IF has_function_privilege('anon', 'private.shared_reference_contribution_envelope(uuid, integer, integer, text, uuid, jsonb, jsonb, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.shared_reference_contribution_envelope(uuid, integer, integer, text, uuid, jsonb, jsonb, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a client role gained EXECUTE on the private contribution envelope';
  END IF;

  -- ── 5. Shared-reference contributor label (private; run as the owner) ──
  envelope := private.shared_reference_contribution_envelope(
    contribution_id, 1, 1, 'Amanita muscaria', unfinished_id,
    '{"short_label": "Doe 2020", "full_citation": "Doe, J. 2020. A title."}'::jsonb,
    '{"work": {"type": "book", "title": "A title", "year": 2020}}'::jsonb,
    now()
  );
  IF envelope->'contributor'->>'label' IS DISTINCT FROM 'Sporely user' THEN
    RAISE EXCEPTION 'an unfinished contributor was not labelled neutrally: %', envelope->'contributor';
  END IF;
  IF envelope::text LIKE '%zq.unfinished%' THEN
    RAISE EXCEPTION 'a shared-reference envelope carries an unfinished profile''s seeded username';
  END IF;

  envelope := private.shared_reference_contribution_envelope(
    contribution_id, 1, 1, 'Amanita muscaria', finished_id,
    '{"short_label": "Doe 2020", "full_citation": "Doe, J. 2020. A title."}'::jsonb,
    '{"work": {"type": "book", "title": "A title", "year": 2020}}'::jsonb,
    now()
  );
  IF envelope->'contributor'->>'label' IS DISTINCT FROM 'zq.finished.person' THEN
    RAISE EXCEPTION 'a finished contributor lost their username label: %', envelope->'contributor';
  END IF;

  -- ── Signed out ─────────────────────────────────────────────────────────
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- 2. public_profiles
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

  -- 1. People directory. The unqueried listing is paged to the end, so the
  --    check holds however many other profiles the database has.
  page_offset := 0;
  LOOP
    SELECT count(*), count(*) FILTER (WHERE user_id = unfinished_id)
    INTO page_rows, row_count
    FROM public.search_people_directory(100, page_offset, NULL);
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'anon people directory listed an unfinished profile';
    END IF;
    EXIT WHEN page_rows < 100;
    page_offset := page_offset + 100;
  END LOOP;

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

  -- 3. Author label by profile id.
  label := public.community_contributor_label(unfinished_id);
  IF label IS NOT NULL THEN
    RAISE EXCEPTION 'anon read an unfinished profile''s name through community_contributor_label: %', label;
  END IF;

  label := public.community_contributor_label(unfinished_id, 'Field notebook author');
  IF label IS DISTINCT FROM 'Field notebook author' THEN
    RAISE EXCEPTION 'unfinished profile label did not fall back to the observation author: %', label;
  END IF;

  label := public.community_contributor_label(finished_id, 'Field notebook author');
  IF label IS DISTINCT FROM 'Zq Finished Realname' THEN
    RAISE EXCEPTION 'a finished profile lost its author label: %', label;
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

  IF public.community_contributor_label(unfinished_id) IS NOT NULL THEN
    RAISE EXCEPTION 'a signed-in user read an unfinished profile''s name through community_contributor_label';
  END IF;

  -- 4. Blocking an account must not reveal its seeded names. Any signed-in
  --    user can block any id, so this is reachable without knowing the user.
  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (viewer_id, unfinished_id), (viewer_id, finished_id);

  SELECT * INTO blocked_row FROM public.get_blocked_user_profiles() WHERE blocked_id = unfinished_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the block on an unfinished account is missing from the block list, so it could not be removed';
  END IF;
  IF blocked_row.username IS NOT NULL OR blocked_row.display_name IS NOT NULL THEN
    RAISE EXCEPTION 'blocking an unfinished account revealed its seeded names: %, %',
      blocked_row.username, blocked_row.display_name;
  END IF;

  SELECT * INTO blocked_row FROM public.get_blocked_user_profiles() WHERE blocked_id = finished_id;
  IF blocked_row.username IS DISTINCT FROM 'zq.finished.person'
     OR blocked_row.display_name IS DISTINCT FROM 'Zq Finished Realname' THEN
    RAISE EXCEPTION 'the block list lost the names of a finished account';
  END IF;

  DELETE FROM public.user_blocks WHERE blocker_id = viewer_id;

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

  IF public.community_contributor_label(unfinished_id) IS DISTINCT FROM 'Zq Chosen' THEN
    RAISE EXCEPTION 'a finished profile has no author label';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'unfinished_profile_privacy_test passed';
END
$$;

ROLLBACK;
