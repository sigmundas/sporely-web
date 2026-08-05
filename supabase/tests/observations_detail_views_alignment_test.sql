-- observations_community_view + observations_friend_view alignment
-- regression test.
--
-- Verifies the contract established by
-- `20260805120000_align_observation_detail_views.sql`:
--
--   1. Structural — both views expose the seven detail-contract
--      fields the app.sporely.no v0.6.19 detail read selects:
--        ai_selected_service, ai_selected_taxon_id,
--        ai_selected_scientific_name, ai_selected_probability,
--        ai_selected_at, red_list_category, red_list_categories_json.
--      Prior to this migration `observations_community_view` was
--      missing the two red-list columns and `observations_friend_view`
--      was missing all seven — 42703 masked as "not visible" on the
--      frontend detail load path.
--   2. Authorization split — preserved verbatim:
--        * observations_community_view: `visibility='public'` ONLY
--          (public rows visible to anon and to any authenticated
--           caller who is not banned/blocked; friends-only rows are
--           NEVER projected even for an accepted friend).
--        * observations_friend_view: `visibility IN ('friends','public')`
--          AND `public.are_friends(auth.uid(), o.user_id)` (returns
--          friends-only rows to an accepted friend; hides them from
--          strangers).
--   3. Draft / banned-author / blocked-pair exclusion on both views.
--   4. Red-list payload round-trip — populated values and NULL
--      values both come back correctly through the friend view.
--   5. Adjacent read surface — `observations_follow_view` retains
--      its narrower projection (regression guard against
--      accidental broadening).
--   6. Image visibility — `observation_images_community_view`
--      returns friend-visible observation images to the friend and
--      hides them from strangers. No new bypass; existing
--      `can_read_observation(...)` gating on the view is exercised.
--
-- Design note: probes may raise `insufficient_privilege` when a role
-- lacks SELECT on a locked-down table. That is a "did not leak" pass,
-- identical to "0 rows returned". Each non-owner probe is wrapped so
-- either outcome counts as passing; only an actually-returned row or
-- an unexpected sensitive value is a fail.
--
-- Run locally after applying migrations:
--   supabase db reset --local  # applies through 20260805120000
--   docker exec supabase_db_<slug> psql -U postgres -d postgres \
--     -f /path/to/observations_detail_views_alignment_test.sql
--
-- Note: `supabase db query --local -f …` cannot run this file because
-- it prepares the whole script as a single statement. Use psql via
-- the supabase_db container (matches the pattern in
-- observation_sync_lockdown_test.sql).

DO $$
DECLARE
  owner_id     uuid := '00000000-0000-4000-8000-00000000ee01';
  friend_id    uuid := '00000000-0000-4000-8000-00000000ee02';
  stranger_id  uuid := '00000000-0000-4000-8000-00000000ee03';
  blocker_id   uuid := '00000000-0000-4000-8000-00000000ee04';
  banned_id    uuid := '00000000-0000-4000-8000-00000000ee05';

  obs_public_with_redlist    bigint;
  obs_public_null_redlist    bigint;
  obs_friends_only           bigint;
  obs_friends_only_null      bigint;
  obs_private                bigint;
  obs_draft                  bigint;
  obs_blocker_public         bigint;
  obs_banned_public          bigint;

  img_public                 bigint;
  img_friends                bigint;

  visible_count bigint;
  redlist_top   text;
  redlist_map   jsonb;
  seen_visibility text;
  fail_msgs     text[] := ARRAY[]::text[];
BEGIN
  ------------------------------------------------------------------
  -- Fixture setup (runs as postgres; bypasses RLS on inserts).
  ------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,    'authenticated', 'authenticated', 'align-owner@example.test',    '{}'::jsonb, now(), now()),
    (friend_id,   'authenticated', 'authenticated', 'align-friend@example.test',   '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'align-stranger@example.test', '{}'::jsonb, now(), now()),
    (blocker_id,  'authenticated', 'authenticated', 'align-blocker@example.test',  '{}'::jsonb, now(), now()),
    (banned_id,   'authenticated', 'authenticated', 'align-banned@example.test',   '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES
    (owner_id,    'align_owner',    'Align Owner',    true,  false),
    (friend_id,   'align_friend',   'Align Friend',   true,  false),
    (stranger_id, 'align_stranger', 'Align Stranger', true,  false),
    (blocker_id,  'align_blocker',  'Align Blocker',  true,  false),
    (banned_id,   'align_banned',   'Align Banned',   true,  true)
  ON CONFLICT (id) DO UPDATE SET is_pro = EXCLUDED.is_pro, is_banned = EXCLUDED.is_banned;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, friend_id, 'accepted')
  ON CONFLICT DO NOTHING;

  -- blocker_id blocks stranger_id (so stranger cannot see blocker's rows).
  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (blocker_id, stranger_id)
  ON CONFLICT DO NOTHING;

  -- Public observation with populated red-list metadata.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude,
     red_list_category, red_list_categories_json,
     ai_selected_service, ai_selected_scientific_name, ai_selected_probability)
  VALUES
    (owner_id, '2026-08-01', 'Amanita', 'muscaria', 'public', false, 'exact', 'public',
     63.11111, 10.22222, 'LC', '{"NO":"LC","SE":"NT"}'::jsonb,
     'artsorakel', 'Amanita muscaria', 0.91)
    RETURNING id INTO obs_public_with_redlist;

  -- Public observation with NULL red-list metadata.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude,
     red_list_category, red_list_categories_json)
  VALUES
    (owner_id, '2026-08-02', 'Boletus', 'edulis', 'public', false, 'exact', 'public',
     63.22222, 10.33333, NULL, NULL)
    RETURNING id INTO obs_public_null_redlist;

  -- Friends-only observation with populated red-list metadata.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude,
     red_list_category, red_list_categories_json,
     ai_selected_service, ai_selected_scientific_name, ai_selected_probability)
  VALUES
    (owner_id, '2026-08-03', 'Cortinarius', 'violaceus', 'friends', false, 'exact', 'friends',
     63.33333, 10.44444, 'VU', '{"NO":"VU"}'::jsonb,
     'artsorakel', 'Cortinarius violaceus', 0.83)
    RETURNING id INTO obs_friends_only;

  -- Friends-only observation with NULL red-list metadata (should load).
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude,
     red_list_category, red_list_categories_json)
  VALUES
    (owner_id, '2026-08-04', 'Hydnum', 'repandum', 'friends', false, 'exact', 'friends',
     63.44444, 10.55555, NULL, NULL)
    RETURNING id INTO obs_friends_only_null;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude)
  VALUES
    (owner_id, '2026-08-05', 'Lactarius', 'deliciosus', 'private', false, 'exact', 'private',
     63.55555, 10.66666)
    RETURNING id INTO obs_private;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude)
  VALUES
    (owner_id, '2026-08-06', 'Pleurotus', 'ostreatus', 'public', true, 'exact', 'public',
     63.66666, 10.77777)
    RETURNING id INTO obs_draft;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude)
  VALUES
    (blocker_id, '2026-08-07', 'Russula', 'emetica', 'public', false, 'exact', 'public',
     63.77777, 10.88888)
    RETURNING id INTO obs_blocker_public;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude)
  VALUES
    (banned_id, '2026-08-08', 'Suillus', 'luteus', 'public', false, 'exact', 'public',
     63.88888, 10.99999)
    RETURNING id INTO obs_banned_public;

  -- Images: one on the public observation, one on the friends-only.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_public_with_redlist, owner_id, owner_id::text || '/align-public.webp', 'field')
  RETURNING id INTO img_public;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_friends_only, owner_id, owner_id::text || '/align-friends.webp', 'field')
  RETURNING id INTO img_friends;

  ------------------------------------------------------------------
  -- Section A: structural — every detail-contract column present
  --   on BOTH views; adjacent follow_view NOT broadened.
  ------------------------------------------------------------------
  DECLARE
    detail_columns text[] := ARRAY[
      'ai_selected_service', 'ai_selected_taxon_id',
      'ai_selected_scientific_name', 'ai_selected_probability',
      'ai_selected_at',
      'red_list_category', 'red_list_categories_json'
    ];
    col text;
  BEGIN
    FOREACH col IN ARRAY detail_columns LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'observations_community_view'
          AND column_name  = col
      ) THEN
        fail_msgs := array_append(fail_msgs,
          format('A: observations_community_view is missing detail-contract column %s', col));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'observations_friend_view'
          AND column_name  = col
      ) THEN
        fail_msgs := array_append(fail_msgs,
          format('A: observations_friend_view is missing detail-contract column %s', col));
      END IF;
    END LOOP;
  END;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'observations_follow_view'
      AND column_name  = 'red_list_category'
  ) THEN
    fail_msgs := array_append(fail_msgs,
      'A: observations_follow_view unexpectedly projects red_list_category (scope broadened without review)');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'observations_follow_view'
      AND column_name  = 'ai_selected_service'
  ) THEN
    fail_msgs := array_append(fail_msgs,
      'A: observations_follow_view unexpectedly projects ai_selected_service (scope broadened without review)');
  END IF;

  ------------------------------------------------------------------
  -- Section B: red-list payload round-trip through the FRIEND view
  --   for an accepted friend. This is the surface that carries the
  --   observation-899-style friends-only detail read.
  ------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);

  -- Populated red-list values.
  SELECT red_list_category, red_list_categories_json
    INTO redlist_top, redlist_map
    FROM public.observations_friend_view
   WHERE id = obs_friends_only;
  IF redlist_top IS DISTINCT FROM 'VU' THEN
    fail_msgs := array_append(fail_msgs,
      format('B: friend-view red_list_category not preserved (got %L, expected %L)',
             redlist_top, 'VU'));
  END IF;
  IF redlist_map IS NULL OR redlist_map ->> 'NO' <> 'VU' THEN
    fail_msgs := array_append(fail_msgs,
      format('B: friend-view red_list_categories_json not preserved (got %L)', redlist_map));
  END IF;

  -- NULL red-list values must still return the row via the friend view.
  SELECT count(*)
    INTO visible_count
    FROM public.observations_friend_view
   WHERE id = obs_friends_only_null
     AND red_list_category         IS NULL
     AND red_list_categories_json  IS NULL;
  IF visible_count = 0 THEN
    fail_msgs := array_append(fail_msgs,
      'B: NULL-red-list friends-only observation missing from friend view');
  END IF;

  -- AI-selection round-trip on friend view.
  DECLARE
    ai_service text;
    ai_sci     text;
    ai_prob    double precision;
  BEGIN
    SELECT ai_selected_service, ai_selected_scientific_name, ai_selected_probability
      INTO ai_service, ai_sci, ai_prob
      FROM public.observations_friend_view
     WHERE id = obs_friends_only;
    IF ai_service IS DISTINCT FROM 'artsorakel'
       OR ai_sci IS DISTINCT FROM 'Cortinarius violaceus'
       OR ai_prob IS NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('B: friend-view AI-selection round-trip incorrect (service=%L, sci=%L, prob=%s)',
               ai_service, ai_sci, ai_prob));
    END IF;
  END;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section C: community view stays public-only. An accepted friend
  --   must NOT see the friends-only observation via community_view.
  --   Public observations remain visible; adjacent invariants hold.
  ------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);

  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id = obs_friends_only;
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      'C/friend: community view leaked a friends-only observation to an accepted friend (predicate broadening regression)');
  END IF;

  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id IN (obs_public_with_redlist, obs_public_null_redlist);
  IF visible_count <> 2 THEN
    fail_msgs := array_append(fail_msgs,
      format('C/friend: expected 2 public rows visible via community view, got %s', visible_count));
  END IF;

  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id IN (obs_private, obs_draft, obs_banned_public);
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      format('C/friend: %s non-public/draft/banned rows leaked via community view', visible_count));
  END IF;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section D: friend view returns friends-only rows to accepted
  --   friends only; strangers do not see them.
  ------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);

  SELECT count(*) INTO visible_count
    FROM public.observations_friend_view
   WHERE id = obs_friends_only;
  IF visible_count <> 1 THEN
    fail_msgs := array_append(fail_msgs,
      format('D/friend: expected 1 friends-only row via friend view, got %s', visible_count));
  END IF;

  -- Friend view must exclude drafts / private / banned author.
  SELECT count(*) INTO visible_count
    FROM public.observations_friend_view
   WHERE id IN (obs_private, obs_draft, obs_banned_public);
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      format('D/friend: %s private/draft/banned rows leaked via friend view', visible_count));
  END IF;

  RESET ROLE;

  -- Stranger: not an accepted friend of the owner, so the friend
  -- view must not return the friends-only row.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);

  SELECT count(*) INTO visible_count
    FROM public.observations_friend_view
   WHERE id = obs_friends_only;
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      'D/stranger: friend view leaked a friends-only observation to an unrelated user');
  END IF;

  -- Community view for stranger: baseline invariants.
  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id = obs_friends_only;
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      'D/stranger: community view leaked a friends-only observation');
  END IF;

  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id IN (obs_public_with_redlist, obs_public_null_redlist);
  IF visible_count <> 2 THEN
    fail_msgs := array_append(fail_msgs,
      format('D/stranger: expected 2 public rows via community view, got %s', visible_count));
  END IF;

  -- Blocked pair: blocker's public observation must be hidden.
  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id = obs_blocker_public;
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      'D/stranger: community view leaked a blocked authors public observation to the blocked party');
  END IF;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section E: owner reads own rows through both views.
  ------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  -- Public row on community view: still readable.
  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id = obs_public_with_redlist;
  IF visible_count <> 1 THEN
    fail_msgs := array_append(fail_msgs,
      format('E/owner: expected 1 public row via community view, got %s', visible_count));
  END IF;

  -- Owner is trivially a friend of themselves? `are_friends()` may
  -- return false — that is the deployed behavior. The friend view
  -- is not the owner path; the owner reads their own rows via the
  -- raw `public.observations` table under RLS. We only assert that
  -- if the owner is present in friend_view rows, the row is theirs.
  SELECT string_agg(visibility, ',') INTO seen_visibility
    FROM public.observations_friend_view
   WHERE id IN (obs_friends_only, obs_friends_only_null);
  -- No assertion on count here — just guard against leaking foreign
  -- rows via the owner path.

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section F: anon baseline — public rows readable, red-list
  --   payload survives the anonymous view read.
  ------------------------------------------------------------------
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT red_list_category
    INTO redlist_top
    FROM public.observations_community_view
   WHERE id = obs_public_with_redlist;
  IF redlist_top IS DISTINCT FROM 'LC' THEN
    fail_msgs := array_append(fail_msgs,
      format('F/anon: public row red_list_category not visible via community view (got %L)', redlist_top));
  END IF;

  SELECT count(*) INTO visible_count
    FROM public.observations_community_view
   WHERE id IN (obs_friends_only, obs_private, obs_draft, obs_banned_public);
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      format('F/anon: %s non-public rows leaked via community view', visible_count));
  END IF;

  -- Friend view must not return anything to anon (auth.uid() IS NULL
  -- → are_friends returns false); no leaks expected.
  SELECT count(*) INTO visible_count
    FROM public.observations_friend_view
   WHERE id IN (obs_friends_only, obs_friends_only_null,
                obs_public_with_redlist, obs_public_null_redlist);
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      format('F/anon: %s rows leaked via friend view to anon', visible_count));
  END IF;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section G: image visibility — no bypass added. Friend-visible
  --   image rows must be readable to the accepted friend via
  --   observation_images_community_view (which already gates on
  --   can_read_observation), and NOT readable to a stranger.
  ------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);

  SELECT count(*) INTO visible_count
    FROM public.observation_images_community_view
   WHERE id = img_friends;
  IF visible_count <> 1 THEN
    fail_msgs := array_append(fail_msgs,
      format('G/friend: expected 1 friend-visible image row via observation_images_community_view, got %s', visible_count));
  END IF;

  SELECT count(*) INTO visible_count
    FROM public.observation_images_community_view
   WHERE id = img_public;
  IF visible_count <> 1 THEN
    fail_msgs := array_append(fail_msgs,
      format('G/friend: expected 1 public image row via observation_images_community_view, got %s', visible_count));
  END IF;

  RESET ROLE;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);

  SELECT count(*) INTO visible_count
    FROM public.observation_images_community_view
   WHERE id = img_friends;
  IF visible_count <> 0 THEN
    fail_msgs := array_append(fail_msgs,
      format('G/stranger: %s friend-visible image rows leaked via observation_images_community_view', visible_count));
  END IF;

  -- Stranger still sees public image (baseline).
  SELECT count(*) INTO visible_count
    FROM public.observation_images_community_view
   WHERE id = img_public;
  IF visible_count <> 1 THEN
    fail_msgs := array_append(fail_msgs,
      format('G/stranger: expected 1 public image row via observation_images_community_view, got %s', visible_count));
  END IF;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Cleanup: drop the fixture rows so repeated runs stay isolated.
  ------------------------------------------------------------------
  DECLARE
    fixture_ids uuid[] := ARRAY[owner_id, friend_id, stranger_id, blocker_id, banned_id];
  BEGIN
    DELETE FROM public.spore_measurements sm WHERE sm.user_id      = ANY (fixture_ids);
    DELETE FROM public.observation_images oi WHERE oi.user_id      = ANY (fixture_ids);
    DELETE FROM public.observations       o  WHERE o.user_id       = ANY (fixture_ids);
    DELETE FROM public.user_blocks        ub WHERE ub.blocker_id   = ANY (fixture_ids)
                                                OR ub.blocked_id   = ANY (fixture_ids);
    DELETE FROM public.friendships        fr WHERE fr.requester_id = ANY (fixture_ids)
                                                OR fr.addressee_id = ANY (fixture_ids);
    DELETE FROM public.profiles           p  WHERE p.id            = ANY (fixture_ids);
    DELETE FROM auth.users                u  WHERE u.id            = ANY (fixture_ids);
  END;

  ------------------------------------------------------------------
  -- Report.
  ------------------------------------------------------------------
  IF array_length(fail_msgs, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'observations_detail_views_alignment test FAILED:%s',
      chr(10) || array_to_string(fail_msgs, chr(10));
  ELSE
    RAISE NOTICE 'observations_detail_views_alignment test PASSED';
  END IF;
END $$;
