-- Regression coverage for 20261001195524_hide_observation_time_of_day_from_non_owners.
--
-- Product rule: an observation's date may be public, its time of day may not.
-- Proves that anon and a signed-in non-owner (who is also a friend and a
-- follower of the owner, so every shared view returns the row) cannot read a
-- time of day from any shared observation view or public observation RPC,
-- that the owner still reads full timestamps from the base tables, and that
-- the date and a stable same-date order are still available.

BEGIN;

DO $$
DECLARE
  owner_id  uuid := '00000000-0000-4000-8000-0000000071a1';
  viewer_id uuid := '00000000-0000-4000-8000-0000000071a2';
  obs_early bigint;
  obs_late  bigint;
  image_id  bigint;
  role_name text;
  view_name text;
  col_name  text;
  leaked    bigint;
  row_count bigint;
  got_date  date;
  got_ts    timestamptz;
  first_id  bigint;
  payload   text;
  secret_time constant text := '13:47';
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,  'authenticated', 'authenticated', 'time-privacy-owner@example.test',  '{}'::jsonb, now(), now()),
    (viewer_id, 'authenticated', 'authenticated', 'time-privacy-viewer@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_id,  'time_privacy_owner',  'Time Privacy Owner',  false),
    (viewer_id, 'time_privacy_viewer', 'Time Privacy Viewer', false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (viewer_id, owner_id, 'accepted');
  INSERT INTO public.follows (user_id, target_type, target_id)
  VALUES (viewer_id, 'user', owner_id::text);

  -- Two public observations on the same local date. The later upload has the
  -- higher id; that is the order a non-owner must still see within the date.
  INSERT INTO public.observations (
    user_id, date, captured_at, created_at, ai_selected_at,
    genus, species, visibility, is_draft
  )
  VALUES (
    owner_id, DATE '2026-09-15', TIMESTAMPTZ '2026-09-15 13:47:21+00',
    TIMESTAMPTZ '2026-09-15 13:47:30+00', TIMESTAMPTZ '2026-09-15 13:47:25+00',
    'Timeprivacia', 'testii', 'public', false
  )
  RETURNING id INTO obs_early;

  INSERT INTO public.observations (
    user_id, date, captured_at, created_at, ai_selected_at,
    genus, species, visibility, is_draft
  )
  VALUES (
    owner_id, DATE '2026-09-15', TIMESTAMPTZ '2026-09-15 13:47:50+00',
    TIMESTAMPTZ '2026-09-15 13:47:55+00', TIMESTAMPTZ '2026-09-15 13:47:52+00',
    'Timeprivacia', 'testii', 'public', false
  )
  RETURNING id INTO obs_late;

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, sort_order,
    captured_at, created_at
  )
  VALUES (
    obs_early, owner_id, owner_id::text || '/time-privacy.webp', 'field', 0,
    TIMESTAMPTZ '2026-09-15 13:47:21+00', TIMESTAMPTZ '2026-09-15 13:47:30+00'
  )
  RETURNING id INTO image_id;

  FOREACH role_name IN ARRAY ARRAY['anon', 'viewer', 'owner']
  LOOP
    IF role_name = 'anon' THEN
      SET LOCAL ROLE anon;
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
    ELSE
      SET LOCAL ROLE authenticated;
      PERFORM set_config('request.jwt.claims', json_build_object(
        'role', 'authenticated',
        'sub', CASE role_name WHEN 'owner' THEN owner_id ELSE viewer_id END
      )::text, true);
      PERFORM set_config('request.jwt.claim.sub',
        (CASE role_name WHEN 'owner' THEN owner_id ELSE viewer_id END)::text, true);
    END IF;

    -- 1) Every timestamp column of every shared view is NULL for these rows,
    --    for every caller (the views are shared, not owner-aware).
    FOREACH view_name IN ARRAY ARRAY[
      'observations_community_view',
      'observations_friend_view',
      'observations_follow_view',
      'observation_images_community_view'
    ]
    LOOP
      EXECUTE format(
        'SELECT count(*) FROM public.%I WHERE %s IN ($1, $2)',
        view_name,
        CASE WHEN view_name LIKE 'observation_images%' THEN 'observation_id' ELSE 'id' END
      ) INTO row_count USING obs_early, obs_late;

      -- anon and the owner are not a friend or follower of the owner; those
      -- two views legitimately return nothing to them.
      IF row_count = 0 AND NOT (role_name IN ('anon', 'owner')
          AND view_name IN ('observations_friend_view', 'observations_follow_view')) THEN
        RAISE EXCEPTION '% saw no rows in % (test setup broken)', role_name, view_name;
      END IF;

      FOR col_name IN
        SELECT a.attname
        FROM pg_attribute a
        WHERE a.attrelid = format('public.%I', view_name)::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid IN ('timestamptz'::regtype, 'timestamp'::regtype, 'time'::regtype, 'timetz'::regtype)
      LOOP
        EXECUTE format(
          'SELECT count(*) FROM public.%I WHERE %s IN ($1, $2) AND %I IS NOT NULL',
          view_name,
          CASE WHEN view_name LIKE 'observation_images%' THEN 'observation_id' ELSE 'id' END,
          col_name
        ) INTO leaked USING obs_early, obs_late;
        IF leaked <> 0 THEN
          RAISE EXCEPTION '% can read time-bearing %.% (% rows)', role_name, view_name, col_name, leaked;
        END IF;
      END LOOP;

      -- Belt and braces: no column of the row carries the time as text.
      EXECUTE format(
        'SELECT string_agg(to_jsonb(v)::text, '' '') FROM public.%I v WHERE %s IN ($1, $2)',
        view_name,
        CASE WHEN view_name LIKE 'observation_images%' THEN 'observation_id' ELSE 'id' END
      ) INTO payload USING obs_early, obs_late;
      IF position(secret_time IN coalesce(payload, '')) > 0 THEN
        RAISE EXCEPTION '% found time of day in % payload: %', role_name, view_name, payload;
      END IF;
    END LOOP;

    -- 2) The date is still served, unshifted, and same-date order is stable
    --    on (date desc, created_at desc, id desc) - the sporely-web feed order.
    SELECT v.date INTO got_date
    FROM public.observations_community_view v WHERE v.id = obs_early;
    IF got_date IS DISTINCT FROM DATE '2026-09-15' THEN
      RAISE EXCEPTION '% got date % from community view', role_name, got_date;
    END IF;

    SELECT v.id INTO first_id
    FROM public.observations_community_view v
    WHERE v.id IN (obs_early, obs_late)
    ORDER BY v.date DESC, v.created_at DESC, v.id DESC
    LIMIT 1;
    IF first_id IS DISTINCT FROM obs_late THEN
      RAISE EXCEPTION '% feed order put % first, expected later upload %', role_name, first_id, obs_late;
    END IF;

    -- 3) Public RPCs return the date only, never a time.
    SELECT string_agg(to_jsonb(r)::text, ' ') INTO payload
    FROM public.search_public_observations(p_genus => 'Timeprivacia') r;
    IF payload IS NULL OR position('2026-09-15' IN payload) = 0 THEN
      RAISE EXCEPTION '% search_public_observations lost the date: %', role_name, payload;
    END IF;
    IF position(secret_time IN payload) > 0 THEN
      RAISE EXCEPTION '% search_public_observations leaked time: %', role_name, payload;
    END IF;

    SELECT string_agg(to_jsonb(r)::text, ' ') INTO payload
    FROM public.get_public_map_points(p_genus => 'Timeprivacia') r;
    IF position(secret_time IN coalesce(payload, '')) > 0 THEN
      RAISE EXCEPTION '% get_public_map_points leaked time: %', role_name, payload;
    END IF;

    -- 4) Base tables: owner keeps full timestamps; nobody else reads them.
    --    anon has no SELECT privilege on the base tables at all.
    IF role_name = 'anon' THEN
      IF has_table_privilege('anon', 'public.observations', 'SELECT')
         OR has_table_privilege('anon', 'public.observation_images', 'SELECT') THEN
        RAISE EXCEPTION 'anon gained SELECT on a base observation table';
      END IF;
    ELSE
      SELECT count(*), max(o.captured_at) INTO row_count, got_ts
      FROM public.observations o WHERE o.id IN (obs_early, obs_late);
    END IF;
    IF role_name = 'owner' THEN
      IF row_count <> 2 OR got_ts IS DISTINCT FROM TIMESTAMPTZ '2026-09-15 13:47:50+00' THEN
        RAISE EXCEPTION 'owner lost full captured_at (rows %, max %)', row_count, got_ts;
      END IF;
      SELECT i.captured_at INTO got_ts FROM public.observation_images i WHERE i.id = image_id;
      IF got_ts IS DISTINCT FROM TIMESTAMPTZ '2026-09-15 13:47:21+00' THEN
        RAISE EXCEPTION 'owner lost full image captured_at: %', got_ts;
      END IF;
    ELSIF role_name = 'viewer' THEN
      IF row_count <> 0 THEN
        RAISE EXCEPTION 'non-owner read % base observation rows', row_count;
      END IF;
      SELECT count(*) INTO row_count FROM public.observation_images i WHERE i.id = image_id;
      IF row_count <> 0 THEN
        RAISE EXCEPTION 'non-owner read base observation_images row';
      END IF;
      IF public.get_observation_latest_microscope_captured_at(obs_early) IS NOT NULL THEN
        RAISE EXCEPTION 'non-owner read latest microscope captured_at';
      END IF;
    END IF;

    RESET ROLE;
  END LOOP;

  RAISE NOTICE 'observation_time_of_day_privacy_test passed';
END;
$$;

ROLLBACK;
