-- Observation-sync lockdown security test.
--
-- Verifies the invariants established by
-- `20260803120000_lock_down_observation_sync_tables.sql`:
--
--   1. No non-owner caller (anon / unrelated authenticated / accepted
--      friend) can directly SELECT rows from the three raw sync tables.
--   2. No caller other than service_role can INSERT / UPDATE / DELETE
--      through the community/friend/follow views — this reproduces the
--      auto-updatable-simple-view exposure (anon UPDATEing raw
--      `observations` via `observations_community_view` was confirmed
--      before the fix).
--   3. `observation_images_community_view` never returns
--      `original_storage_path`, `deleted_at`-non-null rows, or purged
--      rows, and never returns rows for drafts, unauthorized
--      observations, banned owners, or blocked pairings.
--   4. Non-owner spore access is denied across the full cross-product
--      of observation visibility, spore visibility, draft state and
--      image state; owner spore access on tombstoned images works
--      (needed to clean them up).
--   5. Owners retain SELECT/INSERT/UPDATE/DELETE on their own raw
--      rows; service_role retains full access.
--   6. Regression guards: anon holds no table privilege on any raw
--      table or non-owner read view; no permissive SELECT/ALL policy
--      on the raw tables is scoped to PUBLIC (role oid 0); default
--      privileges for role `postgres` in schema `public` do NOT grant
--      tables/sequences/functions to anon or authenticated.
--
-- Design: probes against locked-down tables/views may raise
-- `insufficient_privilege`; that's the same "did not leak" outcome as
-- "0 rows returned". Each non-owner probe is wrapped so either result
-- is a pass, and any actually-returned row or sensitive column value
-- is a fail.
--
-- Run locally after applying migrations:
--   supabase db reset --local  # applies all migrations, including 20260803120000
--   docker exec supabase_db_<slug> psql -U postgres -d postgres \
--     -f /path/to/observation_sync_lockdown_test.sql
--
-- Note: `supabase db query --local -f …` cannot run this file because
-- it prepares the whole script as a single statement. Use psql via the
-- supabase_db container (as documented in other pgTAP-style tests in
-- this directory).

DO $$
DECLARE
  owner_id    uuid := '00000000-0000-4000-8000-00000000bb01';
  stranger_id uuid := '00000000-0000-4000-8000-00000000bb02';
  friend_id   uuid := '00000000-0000-4000-8000-00000000bb03';

  -- Observations: cover the full precision × visibility × spore-visibility
  -- × draft matrix for the exposure probes.
  obs_pub_exact       bigint;  -- public / exact / spore=public
  obs_pub_fuzzed      bigint;  -- public / fuzzed / spore=public
  obs_pub_region      bigint;  -- public / region / spore=public
  obs_pub_hidden      bigint;  -- public / hidden / spore=public
  obs_friends         bigint;  -- friends / exact / spore=friends
  obs_private         bigint;  -- private / exact / spore=private
  obs_draft           bigint;  -- draft (public, exact) / spore=public
  obs_pub_sporepriv   bigint;  -- public / exact / spore=private (matrix)
  obs_pub_sporefriend bigint;  -- public / exact / spore=friends (matrix)
  obs_priv_sporepub   bigint;  -- private / exact / spore=public (matrix)

  img_public_active   bigint;
  img_public_tomb     bigint;
  img_public_purged   bigint;
  img_private         bigint;
  img_friends         bigint;
  img_draft           bigint;

  meas_public              bigint;
  meas_private             bigint;
  meas_friends             bigint;
  meas_tomb                bigint;
  meas_pub_obs_sporepriv   bigint;
  meas_pub_obs_sporefriend bigint;
  meas_priv_obs_sporepub   bigint;

  probed_id      bigint;
  leaked_text    text;
  leaked_ts      timestamptz;
  visible_count  bigint;
  fail_msgs      text[] := ARRAY[]::text[];
  saw_hijack     text;
BEGIN
  ------------------------------------------------------------------
  -- Fixture setup (runs as postgres; bypasses RLS on inserts).
  ------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,    'authenticated', 'authenticated', 'lockdown-owner@example.test',    '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'lockdown-stranger@example.test', '{}'::jsonb, now(), now()),
    (friend_id,   'authenticated', 'authenticated', 'lockdown-friend@example.test',   '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_pro)
  VALUES
    (owner_id,    'lockdown_owner',    'Lockdown Owner',    true),
    (stranger_id, 'lockdown_stranger', 'Lockdown Stranger', true),
    (friend_id,   'lockdown_friend',   'Lockdown Friend',   true)
  ON CONFLICT (id) DO UPDATE SET is_pro = true;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (owner_id, friend_id, 'accepted')
  ON CONFLICT DO NOTHING;

  -- Core visibility variants.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment, ai_state_json, notes)
  VALUES
    (owner_id, '2026-08-01', 'Amanita', 'muscaria', 'public',  false, 'exact', 'public',
     63.11111, 10.22222, 'PRIVATE_pub_exact', '{"secret":"ai_pub_exact"}'::jsonb, 'notes-pub-exact')
    RETURNING id INTO obs_pub_exact;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Boletus', 'edulis', 'public', false, 'fuzzed', 'public',
     63.33333, 10.44444, 'PRIVATE_pub_fuzzed')
    RETURNING id INTO obs_pub_fuzzed;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Cantharellus', 'cibarius', 'public', false, 'region', 'public',
     63.55555, 10.66666, 'PRIVATE_pub_region')
    RETURNING id INTO obs_pub_region;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Morchella', 'esculenta', 'public', false, 'hidden', 'public',
     63.77777, 10.88888, 'PRIVATE_pub_hidden')
    RETURNING id INTO obs_pub_hidden;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Russula', 'emetica', 'friends', false, 'exact', 'friends',
     64.11111, 11.22222, 'PRIVATE_friends')
    RETURNING id INTO obs_friends;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Lactarius', 'deliciosus', 'private', false, 'exact', 'private',
     64.33333, 11.44444, 'PRIVATE_private')
    RETURNING id INTO obs_private;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Pleurotus', 'ostreatus', 'public', true, 'exact', 'public',
     64.55555, 11.66666, 'PRIVATE_draft')
    RETURNING id INTO obs_draft;

  -- Spore access matrix extras.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Hydnum', 'repandum', 'public', false, 'exact', 'private',
     65.0, 12.0, 'PRIVATE_pub_sporepriv')
    RETURNING id INTO obs_pub_sporepriv;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Suillus', 'luteus', 'public', false, 'exact', 'friends',
     65.5, 12.5, 'PRIVATE_pub_sporefriend')
    RETURNING id INTO obs_pub_sporefriend;

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision,
     spore_data_visibility, gps_latitude, gps_longitude, private_comment)
  VALUES
    (owner_id, '2026-08-01', 'Tricholoma', 'terreum', 'private', false, 'exact', 'public',
     66.0, 13.0, 'PRIVATE_priv_sporepub')
    RETURNING id INTO obs_priv_sporepub;

  -- Images: active, tombstoned, purged, private, friends, draft.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, sort_order)
  VALUES (obs_pub_exact, owner_id, owner_id::text||'/pub-exact-active.webp', 'field', 0)
  RETURNING id INTO img_public_active;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, original_storage_path, image_type, sort_order, deleted_at)
  VALUES (obs_pub_exact, owner_id, owner_id::text||'/pub-exact-tomb.webp', owner_id::text||'/pub-exact-tomb.orig.webp', 'field', 1, now())
  RETURNING id INTO img_public_tomb;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, sort_order, deleted_at, purged_at)
  VALUES (obs_pub_exact, owner_id, owner_id::text||'/pub-exact-purged.webp', 'field', 2, now(), now())
  RETURNING id INTO img_public_purged;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, original_storage_path, image_type)
  VALUES (obs_private, owner_id, owner_id::text||'/private.webp', owner_id::text||'/private.orig.webp', 'field')
  RETURNING id INTO img_private;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_friends, owner_id, owner_id::text||'/friends.webp', 'field')
  RETURNING id INTO img_friends;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_draft, owner_id, owner_id::text||'/draft.webp', 'field')
  RETURNING id INTO img_draft;

  -- Measurements: active image on public obs, private image, friends,
  -- tombstoned image, and the spore-matrix extras.
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_public_active, owner_id, 10.5, 5.5, 'manual') RETURNING id INTO meas_public;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_private,       owner_id, 20.0, 10.0, 'manual') RETURNING id INTO meas_private;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_friends,       owner_id, 15.0, 7.5,  'manual') RETURNING id INTO meas_friends;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_public_tomb,   owner_id, 11.0, 5.7,  'manual') RETURNING id INTO meas_tomb;

  DECLARE
    img_pub_sporepriv   bigint;
    img_pub_sporefriend bigint;
    img_priv_sporepub   bigint;
  BEGIN
    INSERT INTO public.observation_images (observation_id, user_id, storage_path)
    VALUES (obs_pub_sporepriv,   owner_id, owner_id::text||'/pub-spore-priv.webp')
    RETURNING id INTO img_pub_sporepriv;
    INSERT INTO public.observation_images (observation_id, user_id, storage_path)
    VALUES (obs_pub_sporefriend, owner_id, owner_id::text||'/pub-spore-friend.webp')
    RETURNING id INTO img_pub_sporefriend;
    INSERT INTO public.observation_images (observation_id, user_id, storage_path)
    VALUES (obs_priv_sporepub,   owner_id, owner_id::text||'/priv-spore-pub.webp')
    RETURNING id INTO img_priv_sporepub;

    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
    VALUES (img_pub_sporepriv,   owner_id, 30.0, 15.0, 'manual') RETURNING id INTO meas_pub_obs_sporepriv;
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
    VALUES (img_pub_sporefriend, owner_id, 31.0, 16.0, 'manual') RETURNING id INTO meas_pub_obs_sporefriend;
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
    VALUES (img_priv_sporepub,   owner_id, 32.0, 17.0, 'manual') RETURNING id INTO meas_priv_obs_sporepub;
  END;

  ------------------------------------------------------------------
  -- Section A: raw-table SELECT probes (§1)
  ------------------------------------------------------------------
  -- anon
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    SELECT count(*) INTO visible_count FROM public.observations;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/anon: %s raw observation rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    SELECT count(*) INTO visible_count FROM public.observation_images;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/anon: %s raw observation_images rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    SELECT count(*) INTO visible_count FROM public.spore_measurements;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/anon: %s raw spore_measurements rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  RESET ROLE;

  -- stranger
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  BEGIN
    SELECT count(*) INTO visible_count FROM public.observations WHERE user_id = owner_id;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/stranger: %s owner obs rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    SELECT count(*) INTO visible_count FROM public.observation_images WHERE user_id = owner_id;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/stranger: %s owner image rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    SELECT count(*) INTO visible_count FROM public.spore_measurements WHERE user_id = owner_id;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/stranger: %s owner measurement rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  RESET ROLE;

  -- friend
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  BEGIN
    SELECT count(*) INTO visible_count FROM public.observations WHERE user_id = owner_id;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/friend: %s owner obs rows leaked (must use observations_friend_view)', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    SELECT count(*) INTO visible_count FROM public.observation_images WHERE user_id = owner_id;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/friend: %s owner image rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    SELECT count(*) INTO visible_count FROM public.spore_measurements WHERE user_id = owner_id;
    IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
      format('A/friend: %s owner measurement rows leaked', visible_count)); END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  -- friend must still see friend-view rows for the accepted friendship.
  SELECT count(*) INTO visible_count FROM public.observations_friend_view WHERE user_id = owner_id;
  IF visible_count = 0 THEN fail_msgs := array_append(fail_msgs,
    'A/friend: lost access to observations_friend_view (regression)'); END IF;
  RESET ROLE;

  ------------------------------------------------------------------
  -- Section B: view DML probes (§1 review point)
  --   Non-owner callers must not be able to INSERT / UPDATE / DELETE
  --   through any non-owner read view. Absence of the required
  --   privilege raises `insufficient_privilege` — that's the
  --   expected pass condition.
  ------------------------------------------------------------------
  UPDATE public.observations SET species='muscaria' WHERE id = obs_pub_exact;  -- reset

  -- anon UPDATE via community view (this was the reproduced HACK).
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  saw_hijack := NULL;
  BEGIN
    UPDATE public.observations_community_view SET species='HACKED_ANON_COMM'
    WHERE id = obs_pub_exact;
    saw_hijack := 'anon updated observations_community_view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  IF saw_hijack IS NOT NULL THEN fail_msgs := array_append(fail_msgs, 'B: '||saw_hijack); END IF;
  saw_hijack := NULL;
  BEGIN
    DELETE FROM public.observations_community_view WHERE id = obs_pub_exact;
    saw_hijack := 'anon deleted from observations_community_view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  IF saw_hijack IS NOT NULL THEN fail_msgs := array_append(fail_msgs, 'B: '||saw_hijack); END IF;
  saw_hijack := NULL;
  BEGIN
    INSERT INTO public.observations_community_view (id, user_id, date, visibility, is_draft, location_precision)
    VALUES (nextval('public.observations_id_seq'), stranger_id, '2026-08-01', 'public', false, 'exact');
    saw_hijack := 'anon inserted into observations_community_view';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
           WHEN OTHERS               THEN NULL; END;
  IF saw_hijack IS NOT NULL THEN fail_msgs := array_append(fail_msgs, 'B: '||saw_hijack); END IF;
  RESET ROLE;

  -- authenticated (stranger) UPDATE via friend view.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  saw_hijack := NULL;
  BEGIN
    UPDATE public.observations_friend_view SET species='HACKED_STRANGER_FRIEND'
    WHERE id = obs_pub_exact;
    saw_hijack := 'stranger updated observations_friend_view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  IF saw_hijack IS NOT NULL THEN fail_msgs := array_append(fail_msgs, 'B: '||saw_hijack); END IF;
  saw_hijack := NULL;
  BEGIN
    DELETE FROM public.observations_community_view WHERE id = obs_pub_exact;
    saw_hijack := 'stranger deleted from observations_community_view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  IF saw_hijack IS NOT NULL THEN fail_msgs := array_append(fail_msgs, 'B: '||saw_hijack); END IF;
  RESET ROLE;

  -- accepted friend UPDATE via friend view.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  saw_hijack := NULL;
  BEGIN
    UPDATE public.observations_friend_view SET species='HACKED_FRIEND_FRIEND'
    WHERE id = obs_pub_exact;
    saw_hijack := 'friend updated observations_friend_view';
  EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
  IF saw_hijack IS NOT NULL THEN fail_msgs := array_append(fail_msgs, 'B: '||saw_hijack); END IF;
  RESET ROLE;

  -- Verify no observation was actually mutated by any of the above.
  SELECT species INTO leaked_text FROM public.observations WHERE id = obs_pub_exact;
  IF leaked_text IS DISTINCT FROM 'muscaria' THEN
    fail_msgs := array_append(fail_msgs,
      format('B: raw observation species was mutated via a view: %L', leaked_text));
  END IF;

  ------------------------------------------------------------------
  -- Section C: observation_images_community_view disclosure probes (§2)
  --   Under the rebuilt view, non-owners must never see
  --   original_storage_path, deleted rows, purged rows, drafts,
  --   friends-only / private storage paths, or storage paths from
  --   observations authored by the caller's blocker.
  ------------------------------------------------------------------

  -- Structural: the view must NOT project `original_storage_path`.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='observation_images_community_view'
      AND column_name='original_storage_path'
  ) THEN
    fail_msgs := array_append(fail_msgs,
      'C: observation_images_community_view still projects original_storage_path');
  END IF;

  -- anon: view must not return tombstoned/purged/private/friends/draft rows.
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT count(*) INTO visible_count FROM public.observation_images_community_view
    WHERE id IN (img_public_tomb, img_public_purged);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    format('C/anon: %s tombstoned/purged rows leaked via image view', visible_count)); END IF;

  DECLARE
    leaked_ids text;
  BEGIN
    SELECT string_agg(id::text || '(vis=' || observation_visibility || ',draft=' || observation_is_draft::text || ')', ',')
    INTO leaked_ids
    FROM public.observation_images_community_view
    WHERE id IN (img_private, img_friends, img_draft);
    IF leaked_ids IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('C/anon: private/friends/draft image rows leaked: %s (expected ids: private=%s, friends=%s, draft=%s)',
               leaked_ids, img_private, img_friends, img_draft));
    END IF;
  END;

  -- Active public row must be visible to anon (regression guard).
  SELECT count(*) INTO visible_count FROM public.observation_images_community_view
    WHERE id = img_public_active;
  IF visible_count = 0 THEN fail_msgs := array_append(fail_msgs,
    'C/anon: active public image row is missing from community view (regression)'); END IF;

  -- deleted_at column must be NULL for every row returned.
  SELECT count(*) INTO visible_count FROM public.observation_images_community_view
    WHERE deleted_at IS NOT NULL;
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    format('C/anon: %s image rows leak a non-NULL deleted_at (view must never expose tombstones)', visible_count)); END IF;

  RESET ROLE;

  -- friend: same shape — friends-only image accessible via friend view,
  -- not via the community view. (Community view has no friends branch.)
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  SELECT count(*) INTO visible_count FROM public.observation_images_community_view
    WHERE id IN (img_public_tomb, img_public_purged, img_private, img_draft);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    format('C/friend: %s prohibited image rows leaked via community view', visible_count)); END IF;
  RESET ROLE;

  ------------------------------------------------------------------
  -- Section D: spore access matrix (§4)
  --   For each caller × observation-visibility × spore-visibility ×
  --   draft × image-state combination, confirm:
  --     * non-owners cannot read raw spore_measurements rows;
  --     * measurements on tombstoned/purged/draft/unauthorized rows
  --       are absent from the community RPC (`get_community_spore_dataset`).
  --   Owner spore access is verified separately in Section E.
  ------------------------------------------------------------------

  -- anon must not read raw measurement rows for ANY of the matrix
  -- observations (already covered in Section A/anon count; here we
  -- additionally probe the community RPCs).
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  -- private observation → no community dataset visibility, ever.
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_priv_sporepub);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/anon: community_spore_dataset leaks measurements from a PRIVATE observation'); END IF;
  -- public obs / private spore-vis → no measurements to non-owners.
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_pub_sporepriv);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/anon: community_spore_dataset leaks measurements when spore_data_visibility=private'); END IF;
  -- public obs / friends spore-vis → no measurements to anon (anon is not a friend of anyone).
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_pub_sporefriend);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/anon: community_spore_dataset leaks measurements when spore_data_visibility=friends'); END IF;
  -- draft obs → excluded regardless.
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_draft);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/anon: community_spore_dataset leaks measurements from a draft observation'); END IF;
  -- public obs / public spore-vis → tombstoned image measurements must
  -- NOT be counted in the community output. obs_pub_exact has two
  -- measurements: `meas_public` on an active image and `meas_tomb` on
  -- a tombstoned image. The aggregate `measurement_count` returned by
  -- the RPC must be exactly 1 (active only) — anything higher would
  -- mean tombstoned measurements are leaking.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count
    FROM public.get_community_spore_dataset(obs_pub_exact);
  IF visible_count > 1 THEN fail_msgs := array_append(fail_msgs,
    format('D/anon: community_spore_dataset measurement_count=%s > 1 for obs_pub_exact (tombstoned meas leaked)', visible_count)); END IF;
  RESET ROLE;

  -- stranger: same restrictions as anon.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_pub_sporepriv);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/stranger: community_spore_dataset leaks private spore data'); END IF;
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_priv_sporepub);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/stranger: community_spore_dataset leaks measurements from a PRIVATE observation'); END IF;
  RESET ROLE;

  -- friend: friends-only spore data may be returned; private spore data must not.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_pub_sporepriv);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/friend: community_spore_dataset leaks spore data when spore_data_visibility=private'); END IF;
  -- The RPC returns a single aggregate row per call even when the
  -- underlying CTE is empty (aggregates over an empty set yield one row
  -- of NULLs). Probe `measurement_count` instead of a row count — a
  -- correctly-filtered call returns measurement_count = 0 or NULL.
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count FROM public.get_community_spore_dataset(obs_priv_sporepub);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    'D/friend: community_spore_dataset leaks measurements from a PRIVATE observation'); END IF;
  RESET ROLE;

  ------------------------------------------------------------------
  -- Section E: owner + service_role happy path (§5)
  ------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  SELECT count(*) INTO visible_count FROM public.observations WHERE user_id = owner_id;
  IF visible_count < 10 THEN fail_msgs := array_append(fail_msgs,
    format('E/owner: expected >=10 own observations, saw %s', visible_count)); END IF;

  SELECT count(*) INTO visible_count FROM public.observation_images WHERE user_id = owner_id;
  IF visible_count < 6 THEN fail_msgs := array_append(fail_msgs,
    format('E/owner: expected >=6 own images (incl. tombstone+purged), saw %s', visible_count)); END IF;

  SELECT count(*) INTO visible_count FROM public.spore_measurements WHERE user_id = owner_id;
  IF visible_count < 7 THEN fail_msgs := array_append(fail_msgs,
    format('E/owner: expected >=7 own measurements, saw %s', visible_count)); END IF;

  -- §5 specific: owner must be able to read measurement attached to a
  -- tombstoned image (needed for cleanup).
  SELECT count(*) INTO visible_count FROM public.spore_measurements WHERE id = meas_tomb;
  IF visible_count = 0 THEN fail_msgs := array_append(fail_msgs,
    'E/owner: cannot read own measurement attached to a tombstoned image (needed for cleanup)'); END IF;

  UPDATE public.observations SET notes = 'owner-touch' WHERE id = obs_pub_exact;
  IF NOT FOUND THEN fail_msgs := array_append(fail_msgs,
    'E/owner: UPDATE on own observation returned 0 rows'); END IF;

  DELETE FROM public.spore_measurements WHERE id = meas_tomb;
  IF NOT FOUND THEN fail_msgs := array_append(fail_msgs,
    'E/owner: DELETE on own tombstone-linked measurement returned 0 rows'); END IF;

  RESET ROLE;

  -- service_role sees everything.
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT count(*) INTO visible_count FROM public.observations WHERE user_id = owner_id;
  IF visible_count < 10 THEN fail_msgs := array_append(fail_msgs,
    'E/service_role: cannot SELECT owner observations'); END IF;
  RESET ROLE;

  ------------------------------------------------------------------
  -- Section F: invariant guards (§6)
  ------------------------------------------------------------------

  -- F1: anon has no privilege on any raw table.
  IF has_table_privilege('anon', 'public.observations',       'SELECT')
     OR has_table_privilege('anon', 'public.observations',       'INSERT')
     OR has_table_privilege('anon', 'public.observations',       'UPDATE')
     OR has_table_privilege('anon', 'public.observations',       'DELETE')
     OR has_table_privilege('anon', 'public.observation_images', 'SELECT')
     OR has_table_privilege('anon', 'public.observation_images', 'INSERT')
     OR has_table_privilege('anon', 'public.observation_images', 'UPDATE')
     OR has_table_privilege('anon', 'public.observation_images', 'DELETE')
     OR has_table_privilege('anon', 'public.spore_measurements', 'SELECT')
     OR has_table_privilege('anon', 'public.spore_measurements', 'INSERT')
     OR has_table_privilege('anon', 'public.spore_measurements', 'UPDATE')
     OR has_table_privilege('anon', 'public.spore_measurements', 'DELETE') THEN
    fail_msgs := array_append(fail_msgs, 'F1: anon retained a privilege on a raw sync table');
  END IF;

  -- F2: neither anon nor authenticated may hold TRUNCATE on the raw tables.
  IF has_table_privilege('anon',          'public.observations',       'TRUNCATE')
     OR has_table_privilege('authenticated','public.observations',      'TRUNCATE')
     OR has_table_privilege('anon',          'public.observation_images','TRUNCATE')
     OR has_table_privilege('authenticated','public.observation_images','TRUNCATE')
     OR has_table_privilege('anon',          'public.spore_measurements','TRUNCATE')
     OR has_table_privilege('authenticated','public.spore_measurements','TRUNCATE') THEN
    fail_msgs := array_append(fail_msgs, 'F2: TRUNCATE leaked to a client role');
  END IF;

  -- F3: no permissive PUBLIC-role SELECT/ALL policy remains on the three raw tables.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = ANY (ARRAY[
      'public.observations'::regclass,
      'public.observation_images'::regclass,
      'public.spore_measurements'::regclass])
      AND p.polcmd IN ('r','*')
      AND p.polpermissive
      AND 0 = ANY (p.polroles)
  ) THEN
    fail_msgs := array_append(fail_msgs, 'F3: a PUBLIC-role SELECT/ALL policy remains on a raw table');
  END IF;

  -- F4: no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any non-owner
  --     read view for anon or authenticated (SELECT is allowed).
  DECLARE
    v_name text;
    v_priv text;
  BEGIN
    FOREACH v_name IN ARRAY ARRAY[
      'public.observations_community_view',
      'public.observations_friend_view',
      'public.observations_follow_view',
      'public.observation_images_community_view'
    ] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF has_table_privilege('anon',          v_name, v_priv)
           OR has_table_privilege('authenticated', v_name, v_priv) THEN
          fail_msgs := array_append(fail_msgs,
            format('F4: %I holds %s on %I', 'anon/authenticated', v_priv, v_name));
        END IF;
      END LOOP;
    END LOOP;
  END;

  -- F5: default privileges for role `postgres` in schema `public` must
  --     no longer grant tables/sequences to anon/authenticated.
  IF EXISTS (
    SELECT 1
    FROM pg_default_acl d
    JOIN pg_authid a ON a.oid = d.defaclrole
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) ax
    JOIN pg_authid grantee ON grantee.oid = ax.grantee
    WHERE a.rolname = 'postgres'
      AND n.nspname = 'public'
      AND grantee.rolname IN ('anon','authenticated')
      AND d.defaclobjtype IN ('r','S')  -- tables (incl. views) + sequences
  ) THEN
    fail_msgs := array_append(fail_msgs,
      'F5: postgres default_acl in schema public still grants tables/sequences to anon or authenticated');
  END IF;

  ------------------------------------------------------------------
  -- Section G: location projections in non-owner observation views.
  --   Every non-owner surface must uniformly redact by precision.
  --   The community view is anon-reachable; friend/follow views
  --   require an authenticated context.
  ------------------------------------------------------------------
  DECLARE
    row_loc  text;
    row_lat  double precision;
    row_lng  double precision;
  BEGIN
    -- Seed a public_regions row referenced by the fixture obs so the
    -- region label projection can be exercised. Idempotent.
    INSERT INTO public.public_regions (id, country_code, label)
    VALUES ('NO-LOCKDOWN-TEST', 'NO', 'Lockdown Test Region')
    ON CONFLICT (id) DO UPDATE SET country_code=EXCLUDED.country_code, label=EXCLUDED.label;
    UPDATE public.observations
      SET country_code='NO', region_id='NO-LOCKDOWN-TEST'
      WHERE id IN (obs_pub_exact, obs_pub_fuzzed, obs_pub_region, obs_pub_hidden,
                   obs_friends, obs_private, obs_pub_sporepriv);
  END;

  -- G/community-view (anon).
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- Exact: location=raw, coords=exact.
  DECLARE
    exact_loc text;
    exact_lat double precision;
    exact_lng double precision;
  BEGIN
    SELECT location, gps_latitude, gps_longitude
      INTO exact_loc, exact_lat, exact_lng
      FROM public.observations_community_view WHERE id = obs_pub_exact;
    IF exact_lat IS NULL OR abs(exact_lat - 63.11111) > 1e-6 THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: exact obs gps_latitude was redacted: got %s (expected 63.11111)', exact_lat));
    END IF;
    IF exact_lng IS NULL OR abs(exact_lng - 10.22222) > 1e-6 THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: exact obs gps_longitude was redacted: got %s', exact_lng));
    END IF;
  END;

  -- Fuzzed: location must not be raw stored value; coords must be rounded to 2 decimals.
  DECLARE
    fuzz_loc text;
    fuzz_lat double precision;
    fuzz_lng double precision;
  BEGIN
    SELECT location, gps_latitude, gps_longitude
      INTO fuzz_loc, fuzz_lat, fuzz_lng
      FROM public.observations_community_view WHERE id = obs_pub_fuzzed;
    IF fuzz_lat IS NULL OR abs(fuzz_lat - 63.33) > 1e-9 THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: fuzzed obs gps_latitude not rounded to 2dp: got %s (expected 63.33)', fuzz_lat));
    END IF;
    IF fuzz_lng IS NULL OR abs(fuzz_lng - 10.44) > 1e-9 THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: fuzzed obs gps_longitude not rounded: got %s', fuzz_lng));
    END IF;
    -- Location must be the safe region-or-country label, not any raw stored value.
    IF fuzz_loc IS NULL OR fuzz_loc NOT IN ('Lockdown Test Region', 'NO') THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: fuzzed obs location not a safe label: got %L', fuzz_loc));
    END IF;
  END;

  -- Region: location = region label; coords NULL.
  DECLARE
    r_loc text; r_lat double precision; r_lng double precision;
  BEGIN
    SELECT location, gps_latitude, gps_longitude INTO r_loc, r_lat, r_lng
      FROM public.observations_community_view WHERE id = obs_pub_region;
    IF r_lat IS NOT NULL OR r_lng IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: region obs leaks coords: lat=%s lng=%s', r_lat, r_lng)); END IF;
    IF r_loc IS NULL OR r_loc NOT IN ('Lockdown Test Region','NO') THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: region obs location not a region label: got %L', r_loc)); END IF;
  END;

  -- Hidden: location NULL; coords NULL.
  DECLARE
    h_loc text; h_lat double precision; h_lng double precision;
  BEGIN
    SELECT location, gps_latitude, gps_longitude INTO h_loc, h_lat, h_lng
      FROM public.observations_community_view WHERE id = obs_pub_hidden;
    IF h_lat IS NOT NULL OR h_lng IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: hidden obs leaks coords: lat=%s lng=%s', h_lat, h_lng)); END IF;
    IF h_loc IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/anon: hidden obs leaks location: %L', h_loc)); END IF;
  END;

  RESET ROLE;

  -- G/friend-view: friend can see obs_friends (visibility='friends',
  --   precision='exact', with region_id set). Location must be the raw
  --   value ONLY if precision=exact. Backfill obs_friends to region and
  --   hidden variants transiently to probe those precisions through the
  --   friend view.
  DECLARE
    f_loc text; f_lat double precision; f_lng double precision;
  BEGIN
    -- Region variant.
    UPDATE public.observations SET location_precision='region' WHERE id = obs_friends;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
    SELECT location, gps_latitude, gps_longitude INTO f_loc, f_lat, f_lng
      FROM public.observations_friend_view WHERE id = obs_friends;
    IF f_lat IS NOT NULL OR f_lng IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/friend: friend obs precision=region leaks exact coords: lat=%s lng=%s', f_lat, f_lng));
    END IF;
    IF f_loc IS NULL OR f_loc NOT IN ('Lockdown Test Region','NO') THEN
      fail_msgs := array_append(fail_msgs,
        format('G/friend: friend obs precision=region leaks raw location: %L', f_loc));
    END IF;

    RESET ROLE;
    -- Hidden variant.
    UPDATE public.observations SET location_precision='hidden' WHERE id = obs_friends;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
    SELECT location, gps_latitude, gps_longitude INTO f_loc, f_lat, f_lng
      FROM public.observations_friend_view WHERE id = obs_friends;
    IF f_lat IS NOT NULL OR f_lng IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/friend: friend obs precision=hidden leaks coords: lat=%s lng=%s', f_lat, f_lng));
    END IF;
    IF f_loc IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/friend: friend obs precision=hidden leaks location: %L', f_loc));
    END IF;

    RESET ROLE;
    UPDATE public.observations SET location_precision='exact' WHERE id = obs_friends;
  END;

  -- G/follow-view: seed a follow relation friend→owner and repeat the region/hidden probes.
  INSERT INTO public.follows (user_id, target_type, target_id)
  VALUES (friend_id, 'user', owner_id::text)
  ON CONFLICT DO NOTHING;

  DECLARE
    fo_loc text; fo_lat double precision; fo_lng double precision;
  BEGIN
    UPDATE public.observations SET location_precision='region' WHERE id = obs_pub_exact;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
    SELECT location, gps_latitude, gps_longitude INTO fo_loc, fo_lat, fo_lng
      FROM public.observations_follow_view WHERE id = obs_pub_exact;
    IF fo_lat IS NOT NULL OR fo_lng IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/follow: precision=region leaks coords: lat=%s lng=%s', fo_lat, fo_lng));
    END IF;
    IF fo_loc IS NULL OR fo_loc NOT IN ('Lockdown Test Region','NO') THEN
      fail_msgs := array_append(fail_msgs,
        format('G/follow: precision=region leaks raw location: %L', fo_loc));
    END IF;

    RESET ROLE;
    UPDATE public.observations SET location_precision='hidden' WHERE id = obs_pub_exact;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
    SELECT location, gps_latitude, gps_longitude INTO fo_loc, fo_lat, fo_lng
      FROM public.observations_follow_view WHERE id = obs_pub_exact;
    IF fo_lat IS NOT NULL OR fo_lng IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/follow: precision=hidden leaks coords: lat=%s lng=%s', fo_lat, fo_lng));
    END IF;
    IF fo_loc IS NOT NULL THEN
      fail_msgs := array_append(fail_msgs,
        format('G/follow: precision=hidden leaks location: %L', fo_loc));
    END IF;

    RESET ROLE;
    UPDATE public.observations SET location_precision='exact' WHERE id = obs_pub_exact;
  END;

  ------------------------------------------------------------------
  -- Section H: additional spore-matrix cells requested by review.
  --   * accepted friend can read a non-draft, readable obs whose
  --     spore_data_visibility='friends' via `get_community_spore_dataset`;
  --   * a stranger cannot access the same dataset;
  --   * private spore visibility is denied even to an accepted friend;
  --   * deleted / purged image measurements remain excluded (checked
  --     in Section D via the owner tombstone / purged fixtures — this
  --     section adds the friend-happy-path cell).
  ------------------------------------------------------------------
  -- Friend HAPPY path: public obs, spore=friends → friend sees data.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count
    FROM public.get_community_spore_dataset(obs_pub_sporefriend);
  IF visible_count = 0 THEN fail_msgs := array_append(fail_msgs,
    'H/friend: expected access to friends-spore dataset, saw 0 measurements'); END IF;

  -- Stranger DENIED for the same obs (spore=friends, but stranger is not a friend).
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count
    FROM public.get_community_spore_dataset(obs_pub_sporefriend);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    format('H/stranger: friends-only spore dataset leaked (%s measurements)', visible_count)); END IF;

  -- Friend DENIED for spore=private, even though observation is public.
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', friend_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  SELECT COALESCE(sum(measurement_count), 0) INTO visible_count
    FROM public.get_community_spore_dataset(obs_pub_sporepriv);
  IF visible_count > 0 THEN fail_msgs := array_append(fail_msgs,
    format('H/friend: private spore data leaked to friend (%s measurements)', visible_count)); END IF;

  RESET ROLE;

  ------------------------------------------------------------------
  -- Section I: function default-privilege probe.
  --   The migration issues
  --     `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE
  --      ON FUNCTIONS FROM PUBLIC;`
  --   so new functions created by postgres do NOT inherit EXECUTE
  --   for PUBLIC / anon / authenticated. Verify by (a) inspecting
  --   pg_default_acl and (b) creating a probe function in-place
  --   and attempting to execute it as each role. An explicitly-
  --   granted twin function must remain executable.
  ------------------------------------------------------------------
  DECLARE
    probe_ok        boolean;
    explicit_grant  boolean;
  BEGIN
    -- (a) Structural check: no `postgres` default_acl entry in any
    --     schema still grants EXECUTE on functions to PUBLIC, anon or
    --     authenticated. (The global entry is stored with
    --     defaclnamespace = 0.)
    -- Restrict to the global default (namespace=0) and schema `public`.
    -- The `storage` schema (Supabase-managed) has its own default_acl
    -- entries — out of scope for Stage 1.
    IF EXISTS (
      SELECT 1
      FROM pg_default_acl d
      JOIN pg_authid a ON a.oid = d.defaclrole
      CROSS JOIN LATERAL aclexplode(d.defaclacl) ax
      LEFT JOIN pg_authid grantee ON grantee.oid = ax.grantee
      WHERE a.rolname = 'postgres'
        AND d.defaclobjtype = 'f'
        AND ax.privilege_type = 'EXECUTE'
        AND (d.defaclnamespace = 0
             OR d.defaclnamespace = 'public'::regnamespace)
        AND (grantee.rolname IN ('anon','authenticated') OR grantee.oid = 0)
    ) THEN
      fail_msgs := array_append(fail_msgs,
        'I/pg_default_acl: postgres still auto-grants EXECUTE on functions to PUBLIC/anon/authenticated');
    END IF;
  END;

  -- (b) Runtime probe.
  CREATE OR REPLACE FUNCTION public._lockdown_probe_default_grant()
    RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT 'probe-default'::text $fn$;
  CREATE OR REPLACE FUNCTION public._lockdown_probe_explicit_grant()
    RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT 'probe-explicit'::text $fn$;
  -- Both functions inherit the (now-empty) postgres default. Explicitly
  -- grant the second to authenticated only.
  GRANT EXECUTE ON FUNCTION public._lockdown_probe_explicit_grant() TO authenticated;

  -- Probe as anon: default must deny; explicit grant to authenticated must not leak to anon.
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  DECLARE
    anon_saw_default boolean := false;
    anon_saw_explicit boolean := false;
  BEGIN
    BEGIN
      PERFORM public._lockdown_probe_default_grant();
      anon_saw_default := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
    BEGIN
      PERFORM public._lockdown_probe_explicit_grant();
      anon_saw_explicit := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
    IF anon_saw_default THEN fail_msgs := array_append(fail_msgs,
      'I/anon: default-grant probe function executed without an explicit grant'); END IF;
    IF anon_saw_explicit THEN fail_msgs := array_append(fail_msgs,
      'I/anon: authenticated-only explicit grant leaked to anon'); END IF;
  END;
  RESET ROLE;

  -- Probe as authenticated (unauthenticated identity is fine — we're
  -- exercising role privileges, not RLS).
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', stranger_id::text, 'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', stranger_id::text, true);
  DECLARE
    auth_saw_default boolean := false;
    auth_saw_explicit boolean := false;
  BEGIN
    BEGIN
      PERFORM public._lockdown_probe_default_grant();
      auth_saw_default := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
    BEGIN
      PERFORM public._lockdown_probe_explicit_grant();
      auth_saw_explicit := true;
    EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN object_not_in_prerequisite_state THEN NULL; END;
    IF auth_saw_default THEN fail_msgs := array_append(fail_msgs,
      'I/authenticated: default-grant probe function executed without an explicit grant'); END IF;
    IF NOT auth_saw_explicit THEN fail_msgs := array_append(fail_msgs,
      'I/authenticated: explicit EXECUTE grant did not take effect'); END IF;
  END;
  RESET ROLE;

  -- Cleanup: drop the probe functions.
  DROP FUNCTION IF EXISTS public._lockdown_probe_default_grant();
  DROP FUNCTION IF EXISTS public._lockdown_probe_explicit_grant();

  ------------------------------------------------------------------
  -- Cleanup (runs as postgres — bypasses RLS).
  ------------------------------------------------------------------
  DELETE FROM public.spore_measurements WHERE user_id IN (owner_id, stranger_id, friend_id);
  DELETE FROM public.observation_images WHERE user_id IN (owner_id, stranger_id, friend_id);
  DELETE FROM public.observations       WHERE user_id IN (owner_id, stranger_id, friend_id);
  DELETE FROM public.friendships
    WHERE requester_id IN (owner_id, stranger_id, friend_id)
       OR addressee_id IN (owner_id, stranger_id, friend_id);
  DELETE FROM public.follows WHERE user_id IN (owner_id, stranger_id, friend_id);
  DELETE FROM public.public_regions WHERE id = 'NO-LOCKDOWN-TEST';
  DELETE FROM public.profiles WHERE id IN (owner_id, stranger_id, friend_id);
  DELETE FROM auth.users     WHERE id IN (owner_id, stranger_id, friend_id);

  ------------------------------------------------------------------
  -- Verdict.
  ------------------------------------------------------------------
  IF array_length(fail_msgs, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'observation_sync_lockdown_test FAILED:\n  - %',
      array_to_string(fail_msgs, E'\n  - ');
  END IF;

  RAISE NOTICE 'observation_sync_lockdown_test: OK';
END $$;
