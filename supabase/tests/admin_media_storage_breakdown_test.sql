-- Validates public.admin_media_storage_breakdown (service-role-only aggregate).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/admin_media_storage_breakdown_test.sql

DO $$
DECLARE
  user_a     uuid := '00000000-0000-4000-8000-0000000bd001';
  user_b     uuid := '00000000-0000-4000-8000-0000000bd002';
  obs_a      bigint;
  obs_b      bigint;

  -- cutoff_past  = 60 days ago (rows deleted before this are reclaimable)
  cutoff_past   timestamptz := now() - interval '60 days';
  -- cutoff_recent = 1 day ago (all recent deletes still in restore window)
  cutoff_recent timestamptz := now() - interval '1 day';

  row_a  record;
  row_b  record;
  row_a2 record;
BEGIN
  -- -----------------------------------------------------------------------
  -- Seed users + profiles
  -- -----------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (user_a, 'authenticated', 'authenticated', 'breakdown-a@example.test', '{}'::jsonb, now(), now()),
    (user_b, 'authenticated', 'authenticated', 'breakdown-b@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, display_name, is_admin, is_banned)
  VALUES
    (user_a, 'BreakdownA', false, false),
    (user_b, 'BreakdownB', false, false)
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  -- -----------------------------------------------------------------------
  -- Seed observations
  -- -----------------------------------------------------------------------
  INSERT INTO public.observations (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (user_a, now()::date, 'public', false, 'exact', 'public')
  RETURNING id INTO obs_a;

  INSERT INTO public.observations (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (user_b, now()::date, 'public', false, 'exact', 'public')
  RETURNING id INTO obs_b;

  -- -----------------------------------------------------------------------
  -- user_a rows
  --
  --  #  what                                 deleted_at         purged_at  stored_bytes  purge_error
  --  1  active byte-backed                   NULL               NULL       1000          NULL
  --  2  microscope anchor (no storage_path)  NULL               NULL       NULL          NULL
  --  3  deleted, inside window (5 days ago)  5d ago             NULL       2000          NULL
  --  4  deleted, expired (90 days ago)       90d ago            NULL       3000          NULL
  --  5  purge_error tombstone (non-blank)    95d ago            NULL       500           'timeout'
  --  6  blank purge_error (must NOT count)   95d ago            NULL       400           ''
  --  7  purged                               100d ago           95d ago    9999          NULL
  --  8  active, stored_bytes NULL (unknown)  NULL               NULL       NULL          NULL
  --  9  deleted, stored_bytes NULL (unknown) 5d ago             NULL       NULL          NULL
  -- -----------------------------------------------------------------------

  -- 1: active byte-backed
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/active1.webp', 1000, 'field', NULL, NULL, NULL);

  -- 2: metadata_only microscope anchor
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, NULL, NULL, 'microscope', NULL, NULL, NULL);

  -- 3: deleted, inside restore window (5 days ago > cutoff_past 60 days ago)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/del_window.webp', 2000, 'field', now() - interval '5 days', NULL, NULL);

  -- 4: deleted, expired / reclaimable (90 days ago <= cutoff_past 60 days ago)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/del_expired.webp', 3000, 'field', now() - interval '90 days', NULL, NULL);

  -- 5: purge_error tombstone (non-blank error)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/error.webp', 500, 'field', now() - interval '95 days', NULL, 'timeout');

  -- 6: blank purge_error — must NOT count as purge_error_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/blank_error.webp', 400, 'field', now() - interval '95 days', NULL, '');

  -- 7: purged row — bytes must NOT appear in retained/reclaimable
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/purged.webp', 9999, 'field', now() - interval '100 days', now() - interval '95 days', NULL);

  -- 8: active row with stored_bytes IS NULL (unknown size)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/unknown_size.webp', NULL, 'field', NULL, NULL, NULL);

  -- 9: deleted row with stored_bytes IS NULL (unknown size)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/del_unknown.webp', NULL, 'field', now() - interval '5 days', NULL, NULL);

  -- -----------------------------------------------------------------------
  -- user_b: one active row only (isolation)
  -- -----------------------------------------------------------------------
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_b, user_b, user_b::text || '/active1.webp', 5000, 'field', NULL, NULL, NULL);

  -- -----------------------------------------------------------------------
  -- Fetch both users at once (cutoff_past = 60 days ago)
  -- -----------------------------------------------------------------------
  SELECT * INTO row_a
    FROM public.admin_media_storage_breakdown(ARRAY[user_a, user_b], cutoff_past)
   WHERE user_id = user_a;

  SELECT * INTO row_b
    FROM public.admin_media_storage_breakdown(ARRAY[user_a, user_b], cutoff_past)
   WHERE user_id = user_b;

  -- -----------------------------------------------------------------------
  -- Test 1: active byte-backed row counted with bytes
  -- active_rows: rows 1 and 8 = 2
  -- active_recorded_primary_bytes: only row 1 = 1000 (row 8 has NULL bytes)
  -- -----------------------------------------------------------------------
  IF row_a.active_rows <> 2 THEN
    RAISE EXCEPTION 'Test 1 FAIL: active_rows expected 2, got %', row_a.active_rows;
  END IF;
  IF row_a.active_recorded_primary_bytes <> 1000 THEN
    RAISE EXCEPTION 'Test 1 FAIL: active_recorded_primary_bytes expected 1000, got %', row_a.active_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 2: metadata_only_anchor_rows — row 2 (microscope, no storage_path)
  --         must NOT appear in active_rows and must NOT contribute bytes
  -- -----------------------------------------------------------------------
  IF row_a.metadata_only_anchor_rows <> 1 THEN
    RAISE EXCEPTION 'Test 2 FAIL: metadata_only_anchor_rows expected 1, got %', row_a.metadata_only_anchor_rows;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 3: deleted inside restore window → restore_window_rows + bytes
  -- restore_window (deleted_at > cutoff_past=-60d): rows 3 and 9 = 2
  -- restore_window_recorded_primary_bytes: only row 3 = 2000 (row 9 has NULL)
  -- -----------------------------------------------------------------------
  IF row_a.restore_window_rows <> 2 THEN
    RAISE EXCEPTION 'Test 3 FAIL: restore_window_rows expected 2, got %', row_a.restore_window_rows;
  END IF;
  IF row_a.restore_window_recorded_primary_bytes <> 2000 THEN
    RAISE EXCEPTION 'Test 3 FAIL: restore_window_recorded_primary_bytes expected 2000, got %', row_a.restore_window_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 4: deleted expired (deleted_at <= cutoff_past) → reclaimable
  -- reclaimable: rows 4, 5, 6 = 3
  -- reclaimable_recorded_primary_bytes: 3000 + 500 + 400 = 3900
  -- -----------------------------------------------------------------------
  IF row_a.reclaimable_rows <> 3 THEN
    RAISE EXCEPTION 'Test 4 FAIL: reclaimable_rows expected 3, got %', row_a.reclaimable_rows;
  END IF;
  IF row_a.reclaimable_recorded_primary_bytes <> 3900 THEN
    RAISE EXCEPTION 'Test 4 FAIL: reclaimable_recorded_primary_bytes expected 3900, got %', row_a.reclaimable_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 5: purge_error_rows — only non-blank purge_error counts; '' does not
  -- -----------------------------------------------------------------------
  IF row_a.purge_error_rows <> 1 THEN
    RAISE EXCEPTION 'Test 5 FAIL: purge_error_rows expected 1 (blank excluded), got %', row_a.purge_error_rows;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 6: purged_rows, and purged bytes NOT in retained sums
  -- -----------------------------------------------------------------------
  IF row_a.purged_rows <> 1 THEN
    RAISE EXCEPTION 'Test 6 FAIL: purged_rows expected 1, got %', row_a.purged_rows;
  END IF;
  IF coalesce(row_a.deleted_retained_recorded_primary_bytes, 0) >= 9999 THEN
    RAISE EXCEPTION 'Test 6 FAIL: purged bytes (9999) must not appear in deleted_retained_recorded_primary_bytes, got %',
      row_a.deleted_retained_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 7: stored_bytes IS NULL → excluded from sums, counted in unknown-size
  -- active_unknown_primary_size_rows: row 8 = 1
  -- deleted_retained_unknown_primary_size_rows: row 9 = 1
  -- -----------------------------------------------------------------------
  IF row_a.active_unknown_primary_size_rows <> 1 THEN
    RAISE EXCEPTION 'Test 7 FAIL: active_unknown_primary_size_rows expected 1, got %', row_a.active_unknown_primary_size_rows;
  END IF;
  IF row_a.deleted_retained_unknown_primary_size_rows <> 1 THEN
    RAISE EXCEPTION 'Test 7 FAIL: deleted_retained_unknown_primary_size_rows expected 1, got %', row_a.deleted_retained_unknown_primary_size_rows;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 8: user isolation — user_b sees only its own row
  -- -----------------------------------------------------------------------
  IF row_b.active_rows <> 1 THEN
    RAISE EXCEPTION 'Test 8 FAIL: user_b active_rows expected 1, got %', row_b.active_rows;
  END IF;
  IF row_b.active_recorded_primary_bytes <> 5000 THEN
    RAISE EXCEPTION 'Test 8 FAIL: user_b active_recorded_primary_bytes expected 5000, got %', row_b.active_recorded_primary_bytes;
  END IF;
  IF row_b.deleted_retained_rows <> 0 THEN
    RAISE EXCEPTION 'Test 8 FAIL: user_b deleted_retained_rows expected 0, got %', row_b.deleted_retained_rows;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 9: moving p_restore_cutoff_at flips rows between reclaimable/window
  -- cutoff_recent (1 day ago): all seeded deletes are older than 1 day → all reclaimable
  -- -----------------------------------------------------------------------
  SELECT * INTO row_a2
    FROM public.admin_media_storage_breakdown(ARRAY[user_a], cutoff_recent)
   WHERE user_id = user_a;

  -- cutoff_recent = now() - 1 day.
  -- reclaimable: deleted_at <= cutoff_recent (i.e., deleted more than 1 day ago).
  -- All user_a deleted rows (3:5d, 4:90d, 5:95d, 6:95d, 9:5d) satisfy this → reclaimable=5.
  -- restore_window: deleted_at > cutoff_recent (deleted LESS than 1 day ago) → 0 rows.
  IF row_a2.reclaimable_rows <> 5 THEN
    RAISE EXCEPTION 'Test 9 FAIL: with cutoff_recent reclaimable_rows expected 5, got %', row_a2.reclaimable_rows;
  END IF;
  IF row_a2.restore_window_rows <> 0 THEN
    RAISE EXCEPTION 'Test 9 FAIL: with cutoff_recent restore_window_rows expected 0, got %', row_a2.restore_window_rows;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 10: permissions
  -- -----------------------------------------------------------------------
  IF NOT has_function_privilege('service_role',
       'public.admin_media_storage_breakdown(uuid[], timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Test 10 FAIL: service_role must have EXECUTE';
  END IF;
  IF has_function_privilege('anon',
       'public.admin_media_storage_breakdown(uuid[], timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Test 10 FAIL: anon must NOT have EXECUTE';
  END IF;
  IF has_function_privilege('authenticated',
       'public.admin_media_storage_breakdown(uuid[], timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Test 10 FAIL: authenticated must NOT have EXECUTE';
  END IF;

  -- -----------------------------------------------------------------------
  -- Cleanup
  -- -----------------------------------------------------------------------
  DELETE FROM public.observation_images WHERE user_id IN (user_a, user_b);
  DELETE FROM public.observations WHERE id IN (obs_a, obs_b);
  DELETE FROM public.profiles WHERE id IN (user_a, user_b);
  DELETE FROM auth.users WHERE id IN (user_a, user_b);

  RAISE NOTICE 'admin_media_storage_breakdown_test passed (10 assertions)';
END $$;
