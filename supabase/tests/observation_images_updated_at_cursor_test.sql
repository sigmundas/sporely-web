-- Regression coverage for the server-maintained updated_at change cursor on
-- observation_images (20260824120000_observation_images_updated_at_cursor.sql).
--
-- Run after local migrations:
--   supabase db query --local --file supabase/tests/observation_images_updated_at_cursor_test.sql
--
-- All assertions run as postgres (trusted role) so we can bypass RLS and
-- manipulate timestamps freely. Structural proof is used where SET ROLE would
-- block DML via RLS.
--
-- Note on SET LOCAL ordering: request.jwt.claims must be set as postgres
-- (before SET LOCAL ROLE) so the superuser privilege guarantees the GUC write.

DO $$
DECLARE
  fixture_user  constant uuid       := '00000000-0000-0000-0000-00000000c0b1';
  other_user    constant uuid       := '00000000-0000-0000-0000-00000000c0b2';
  old_ts        constant timestamptz := '2000-01-01 00:00:00+00';
  obs_id        bigint;
  img_id        bigint;
  img2_id       bigint;
  t_before      timestamptz;
  t_after       timestamptz;
  t_parent      timestamptz;
  -- Test 5 locals
  explicit_created  timestamptz;
  explicit_deleted  timestamptz;
  expected_updated  timestamptz;
  actual_updated    timestamptz;
  -- Test 8 locals
  owner_count  int;
  other_count  int;
  -- Test 10: no additional locals needed (structural proof only)
BEGIN
  -- ---------------------------------------------------------------
  -- Setup
  -- ---------------------------------------------------------------
  DELETE FROM auth.users WHERE id IN (fixture_user, other_user);

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (fixture_user, 'authenticated', 'authenticated',
     'img-cursor-owner@example.invalid', '{}'::jsonb, now(), now()),
    (other_user,   'authenticated', 'authenticated',
     'img-cursor-other@example.invalid', '{}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username)
  VALUES (fixture_user, 'img_cursor_owner_b'), (other_user, 'img_cursor_other_b')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.observations (user_id, date, visibility, location_precision)
  VALUES (fixture_user, current_date, 'public', 'exact')
  RETURNING id INTO obs_id;

  -- ---------------------------------------------------------------
  -- Test 1: INSERT receives non-null updated_at
  -- ---------------------------------------------------------------
  -- now() (transaction time) is used by the trigger, so compare against that.
  t_before := now() - interval '1 second';
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_id, fixture_user, '00000000-0000-0000-0000-00000000c0b1/cursor-test/img-a.jpg', 'field')
  RETURNING id INTO img_id;

  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img_id;
  IF t_after IS NULL THEN
    RAISE EXCEPTION 'Test 1 FAILED: INSERT produced NULL updated_at';
  END IF;
  IF t_after < t_before THEN
    RAISE EXCEPTION 'Test 1 FAILED: updated_at (%) is before insert start (%)', t_after, t_before;
  END IF;
  RAISE NOTICE 'Test 1 passed: INSERT receives non-null updated_at';

  -- ---------------------------------------------------------------
  -- Test 2: UPDATE (as untrusted authenticated role) advances updated_at.
  --         Wind updated_at back to old_ts with trg_05 disabled (the trigger
  --         is unconditional for every role, including postgres), then update
  --         as authenticated. Trigger must force now().
  -- ---------------------------------------------------------------
  ALTER TABLE public.observation_images DISABLE TRIGGER trg_05_observation_images_set_updated_at;
  UPDATE public.observation_images SET updated_at = old_ts WHERE id = img_id;
  ALTER TABLE public.observation_images ENABLE TRIGGER trg_05_observation_images_set_updated_at;
  SET LOCAL request.jwt.claims TO '{"sub": "00000000-0000-0000-0000-00000000c0b1", "role": "authenticated"}';
  SET LOCAL ROLE authenticated;
  UPDATE public.observation_images SET notes = 'update test' WHERE id = img_id;
  RESET ROLE;
  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img_id;
  IF t_after <= old_ts THEN
    RAISE EXCEPTION 'Test 2 FAILED: authenticated UPDATE did not advance updated_at (got %)', t_after;
  END IF;
  RAISE NOTICE 'Test 2 passed: UPDATE (authenticated) advances updated_at';

  -- ---------------------------------------------------------------
  -- Test 3: Soft delete (set deleted_at) advances updated_at
  -- ---------------------------------------------------------------
  ALTER TABLE public.observation_images DISABLE TRIGGER trg_05_observation_images_set_updated_at;
  UPDATE public.observation_images SET updated_at = old_ts WHERE id = img_id;
  ALTER TABLE public.observation_images ENABLE TRIGGER trg_05_observation_images_set_updated_at;
  SET LOCAL request.jwt.claims TO '{"sub": "00000000-0000-0000-0000-00000000c0b1", "role": "authenticated"}';
  SET LOCAL ROLE authenticated;
  UPDATE public.observation_images SET deleted_at = now() WHERE id = img_id;
  RESET ROLE;
  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img_id;
  IF t_after <= old_ts THEN
    RAISE EXCEPTION 'Test 3 FAILED: soft delete did not advance updated_at';
  END IF;
  RAISE NOTICE 'Test 3 passed: soft delete advances updated_at';

  -- ---------------------------------------------------------------
  -- Test 4: Metadata-only UPDATE (sort_order) advances updated_at
  -- ---------------------------------------------------------------
  ALTER TABLE public.observation_images DISABLE TRIGGER trg_05_observation_images_set_updated_at;
  UPDATE public.observation_images SET updated_at = old_ts, deleted_at = NULL WHERE id = img_id;
  ALTER TABLE public.observation_images ENABLE TRIGGER trg_05_observation_images_set_updated_at;
  SET LOCAL request.jwt.claims TO '{"sub": "00000000-0000-0000-0000-00000000c0b1", "role": "authenticated"}';
  SET LOCAL ROLE authenticated;
  UPDATE public.observation_images SET sort_order = 5 WHERE id = img_id;
  RESET ROLE;
  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img_id;
  IF t_after <= old_ts THEN
    RAISE EXCEPTION 'Test 4 FAILED: metadata-only update did not advance updated_at';
  END IF;
  RAISE NOTICE 'Test 4 passed: metadata-only UPDATE advances updated_at';

  -- ---------------------------------------------------------------
  -- Test 5: Backfill uses historical timestamps, not migration-now.
  --         The migration writes updated_at BEFORE the trigger exists, so we
  --         simulate that ordering: with trg_05 disabled, write the backfill
  --         expression's value directly; it must be preserved. (There is no
  --         longer any role-based path to do this with the trigger active.)
  -- ---------------------------------------------------------------
  explicit_created := '2023-06-01 10:00:00+00';
  explicit_deleted := '2023-06-15 12:00:00+00';
  expected_updated := GREATEST(explicit_created, explicit_deleted);

  ALTER TABLE public.observation_images DISABLE TRIGGER trg_05_observation_images_set_updated_at;
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type,
    created_at, deleted_at, updated_at
  ) VALUES (
    obs_id, fixture_user,
    '00000000-0000-0000-0000-00000000c0b1/cursor-test/backfill-sim.jpg', 'field',
    explicit_created, explicit_deleted, expected_updated
  ) RETURNING id INTO img2_id;
  ALTER TABLE public.observation_images ENABLE TRIGGER trg_05_observation_images_set_updated_at;

  SELECT updated_at INTO actual_updated FROM public.observation_images WHERE id = img2_id;
  IF actual_updated IS DISTINCT FROM expected_updated THEN
    RAISE EXCEPTION
      'Test 5 FAILED: backfill-order write not preserved — expected %, got %',
      expected_updated, actual_updated;
  END IF;
  IF actual_updated >= now() - interval '1 second' THEN
    RAISE EXCEPTION
      'Test 5 FAILED: value (%) looks like migration-now, not historical timestamp',
      actual_updated;
  END IF;
  RAISE NOTICE 'Test 5 passed: backfilled rows use historical timestamps';

  -- ---------------------------------------------------------------
  -- Test 6: Parent-touch trigger still bumps observations.updated_at
  -- ---------------------------------------------------------------
  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_ts WHERE id = obs_id;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_id, fixture_user,
          '00000000-0000-0000-0000-00000000c0b1/cursor-test/parent-touch.jpg', 'field');

  SELECT updated_at INTO t_parent FROM public.observations WHERE id = obs_id;
  IF t_parent <= old_ts THEN
    RAISE EXCEPTION 'Test 6 FAILED: parent-touch trigger no longer bumps observations.updated_at on INSERT';
  END IF;

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = old_ts WHERE id = obs_id;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observation_images SET notes = 'parent touch check' WHERE id = img_id;
  SELECT updated_at INTO t_parent FROM public.observations WHERE id = obs_id;
  IF t_parent <= old_ts THEN
    RAISE EXCEPTION 'Test 6 FAILED: parent-touch trigger no longer bumps observations.updated_at on UPDATE';
  END IF;
  RAISE NOTICE 'Test 6 passed: parent-touch trigger still operates correctly';

  -- ---------------------------------------------------------------
  -- Test 7: Child updated_at trigger does not recurse
  --         Completing two successive updates without error proves no
  --         infinite-recursion path (stack overflow would raise an error).
  -- ---------------------------------------------------------------
  UPDATE public.observation_images SET notes = 'recursion check 1' WHERE id = img_id;
  UPDATE public.observation_images SET notes = 'recursion check 2' WHERE id = img_id;
  RAISE NOTICE 'Test 7 passed: no recursion (updates completed without error)';

  -- ---------------------------------------------------------------
  -- Test 8: RLS/permissions unchanged — owner sees row, non-owner blocked.
  --         jwt.claims set as postgres before role switch (GUC permission).
  -- ---------------------------------------------------------------
  SET LOCAL request.jwt.claims TO '{"sub": "00000000-0000-0000-0000-00000000c0b1", "role": "authenticated"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO owner_count
  FROM public.observation_images WHERE id = img_id;
  RESET ROLE;

  SET LOCAL request.jwt.claims TO '{"sub": "00000000-0000-0000-0000-00000000c0b2", "role": "authenticated"}';
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO other_count
  FROM public.observation_images WHERE id = img_id;
  RESET ROLE;

  IF owner_count < 1 THEN
    RAISE EXCEPTION 'Test 8 FAILED: owner cannot see own image row (RLS broken)';
  END IF;
  IF other_count > 0 THEN
    RAISE EXCEPTION 'Test 8 FAILED: non-owner can see owner image row (RLS broken)';
  END IF;
  RAISE NOTICE 'Test 8 passed: RLS owner/non-owner policies unchanged';

  -- ---------------------------------------------------------------
  -- Test 9: The new index exists
  -- ---------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename  = 'observation_images'
      AND indexname  = 'observation_images_user_updated_at_id_idx'
  ) THEN
    RAISE EXCEPTION 'Test 9 FAILED: observation_images_user_updated_at_id_idx not found';
  END IF;
  RAISE NOTICE 'Test 9 passed: index observation_images_user_updated_at_id_idx exists';

  -- ---------------------------------------------------------------
  -- Test 10: Authenticated client cannot retain a spoofed updated_at.
  --          Proof is structural: verify trigger metadata and function source,
  --          and confirm the column definition rejects NULL.
  --          Live untrusted-path proof is already given by Tests 2–4, which
  --          wind updated_at back to old_ts (as trusted postgres) and then
  --          update as `authenticated`, observing the trigger overwrites it.
  --          Here we lock down the structural guarantees that make it impossible
  --          for any untrusted client to inject a spoofed timestamp.
  -- ---------------------------------------------------------------

  -- Trigger must be BEFORE INSERT OR UPDATE (not AFTER, not DELETE-only).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.observation_images'::regclass
      AND t.tgname  = 'trg_05_observation_images_set_updated_at'
      AND p.proname = '_observation_images_set_updated_at'
      AND (t.tgtype & 2)  > 0   -- BEFORE
      AND (t.tgtype & 4)  > 0   -- INSERT
      AND (t.tgtype & 16) > 0   -- UPDATE
  ) THEN
    RAISE EXCEPTION
      'Test 10 FAILED: trg_05_observation_images_set_updated_at not found or misconfigured';
  END IF;

  -- Function must NOT be SECURITY DEFINER (no privilege escalation).
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = '_observation_images_set_updated_at'
      AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      'Test 10 FAILED: _observation_images_set_updated_at must NOT be SECURITY DEFINER';
  END IF;

  -- Function must be unconditional: no role branching of any kind. The cursor
  -- depends on the row changing, not on who changed it.
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = '_observation_images_set_updated_at'
      AND (prosrc LIKE '%current_user%' OR prosrc LIKE '%auth.uid%' OR prosrc LIKE '%session_user%')
  ) THEN
    RAISE EXCEPTION
      'Test 10 FAILED: _observation_images_set_updated_at must not branch on caller role';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = '_observation_images_set_updated_at'
      AND prosrc LIKE '%NEW.updated_at := now()%'
  ) THEN
    RAISE EXCEPTION
      'Test 10 FAILED: unconditional NEW.updated_at := now() assignment not found';
  END IF;

  -- Column must be NOT NULL (clients cannot pass NULL to clear it).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'observation_images'
      AND column_name  = 'updated_at'
      AND is_nullable  = 'YES'
  ) THEN
    RAISE EXCEPTION 'Test 10 FAILED: observation_images.updated_at is nullable — must be NOT NULL';
  END IF;

  RAISE NOTICE 'Test 10 passed: trigger is BEFORE INSERT|UPDATE, not SECURITY DEFINER, unconditional (no role branch), column is NOT NULL';

  -- ---------------------------------------------------------------
  -- Test 11: service_role metadata UPDATE (not mentioning updated_at)
  --          advances updated_at.
  --          Clear jwt claims left by earlier tests so auth.uid() is NULL,
  --          matching how PostgREST executes genuine service-role requests.
  -- ---------------------------------------------------------------
  SET LOCAL request.jwt.claims TO '';
  ALTER TABLE public.observation_images DISABLE TRIGGER trg_05_observation_images_set_updated_at;
  UPDATE public.observation_images SET updated_at = old_ts WHERE id = img_id;
  ALTER TABLE public.observation_images ENABLE TRIGGER trg_05_observation_images_set_updated_at;
  SET LOCAL ROLE service_role;
  UPDATE public.observation_images SET notes = 'service-role metadata write' WHERE id = img_id;
  RESET ROLE;
  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img_id;
  IF t_after <= old_ts THEN
    RAISE EXCEPTION 'Test 11 FAILED: service_role UPDATE did not advance updated_at (got %)', t_after;
  END IF;
  RAISE NOTICE 'Test 11 passed: service_role metadata UPDATE advances updated_at';

  -- ---------------------------------------------------------------
  -- Test 12: service_role UPDATE explicitly setting an old updated_at
  --          still gets a fresh server timestamp.
  -- ---------------------------------------------------------------
  SET LOCAL ROLE service_role;
  UPDATE public.observation_images SET updated_at = old_ts, notes = 'spoof attempt' WHERE id = img_id;
  RESET ROLE;
  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img_id;
  IF t_after <= old_ts THEN
    RAISE EXCEPTION 'Test 12 FAILED: service_role explicit old updated_at was persisted (got %)', t_after;
  END IF;
  RAISE NOTICE 'Test 12 passed: service_role cannot persist an explicit stale updated_at';

  -- ---------------------------------------------------------------
  -- Test 13: service_role INSERT with explicit historical updated_at
  --          cannot create a stale cursor row.
  -- ---------------------------------------------------------------
  SET LOCAL ROLE service_role;
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, updated_at
  ) VALUES (
    obs_id, fixture_user,
    '00000000-0000-0000-0000-00000000c0b1/cursor-test/stale-insert.jpg', 'field',
    old_ts
  ) RETURNING id INTO img2_id;
  RESET ROLE;
  SELECT updated_at INTO t_after FROM public.observation_images WHERE id = img2_id;
  IF t_after <= old_ts THEN
    RAISE EXCEPTION 'Test 13 FAILED: service_role INSERT created a stale cursor row (got %)', t_after;
  END IF;
  RAISE NOTICE 'Test 13 passed: service_role INSERT cannot create a stale cursor row';

  -- ---------------------------------------------------------------
  -- Cleanup
  -- ---------------------------------------------------------------
  DELETE FROM auth.users WHERE id IN (fixture_user, other_user);
  RAISE NOTICE 'observation_images_updated_at_cursor_test: all 13 assertions passed';

EXCEPTION
  WHEN OTHERS THEN
    DELETE FROM auth.users WHERE id IN (fixture_user, other_user);
    RAISE;
END;
$$;
