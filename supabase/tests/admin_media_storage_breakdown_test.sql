-- Validates public.admin_media_storage_breakdown (service-role-only aggregate).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/admin_media_storage_breakdown_test.sql

DO $$
DECLARE
  user_a     uuid := '00000000-0000-4000-8000-0000000bd001';
  user_b     uuid := '00000000-0000-4000-8000-0000000bd002';
  user_empty uuid := '00000000-0000-4000-8000-0000000bd003';
  user_c     uuid := '00000000-0000-4000-8000-0000000bd004';
  obs_a      bigint;
  obs_b      bigint;
  obs_c      bigint;

  -- cutoff_past  = 60 days ago (rows deleted before this are reclaimable)
  cutoff_past   timestamptz := now() - interval '60 days';
  -- cutoff_recent = 1 day ago (all seeded deletes are older → all reclaimable)
  cutoff_recent timestamptz := now() - interval '1 day';

  row_a   record;
  row_b   record;
  row_a2  record;
  row_dup record;
  row_empty record;
  row_c   record;
BEGIN
  -- -----------------------------------------------------------------------
  -- Seed users + profiles
  -- -----------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (user_a,     'authenticated', 'authenticated', 'breakdown-a@example.test',     '{}'::jsonb, now(), now()),
    (user_b,     'authenticated', 'authenticated', 'breakdown-b@example.test',     '{}'::jsonb, now(), now()),
    (user_empty, 'authenticated', 'authenticated', 'breakdown-empty@example.test', '{}'::jsonb, now(), now()),
    (user_c,     'authenticated', 'authenticated', 'breakdown-c@example.test',     '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, display_name, is_admin, is_banned)
  VALUES
    (user_a,     'BreakdownA',     false, false),
    (user_b,     'BreakdownB',     false, false),
    (user_empty, 'BreakdownEmpty', false, false),
    (user_c,     'BreakdownC',     false, false)
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

  INSERT INTO public.observations (user_id, date, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (user_c, now()::date, 'public', false, 'exact', 'public')
  RETURNING id INTO obs_c;

  -- -----------------------------------------------------------------------
  -- user_a rows
  --
  --  #   what                                     deleted_at     purged_at  stored_bytes  purge_error  storage_path
  --  1   active byte-backed                       NULL           NULL       1000          NULL         present
  --  2   microscope anchor (NULL storage_path)    NULL           NULL       NULL          NULL         NULL
  --  2b  microscope anchor (BLANK storage_path)   NULL           NULL       NULL          NULL         ''
  --  3   deleted, inside window (5 days ago)      5d ago         NULL       2000          NULL         present
  --  4   deleted, expired (90 days ago)           90d ago        NULL       3000          NULL         present
  --  5   purge_error tombstone (non-blank)        95d ago        NULL       500           'timeout'    present
  --  6   blank purge_error (must NOT count)       95d ago        NULL       400           ''           present
  --  7   purged                                   100d ago       95d ago    9999          NULL         present
  --  8   active, stored_bytes NULL (unknown)      NULL           NULL       NULL          NULL         present
  --  9   deleted, stored_bytes NULL (unknown)     5d ago         NULL       NULL          NULL         present
  -- -----------------------------------------------------------------------

  -- 1: active byte-backed
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, user_a::text || '/active1.webp', 1000, 'field', NULL, NULL, NULL);

  -- 2: metadata_only microscope anchor (storage_path IS NULL)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, NULL, NULL, 'microscope', NULL, NULL, NULL);

  -- 2b: metadata_only microscope anchor (storage_path = '' — blank string, must also land in anchor bucket)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_a, user_a, '', NULL, 'microscope', NULL, NULL, NULL);

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
  -- user_c rows — targeted regression cases for blank/lifecycle semantics
  --
  --  C1   whitespace-only storage_path, active, not microscope           → not active_rows, not anchor
  --  C2   whitespace-only storage_path, active, microscope               → metadata_only_anchor
  --  C3   whitespace-only storage_path, active, image_type=NULL           → NOT anchor (coalesce guard)
  --  C4   nonblank path, deleted 95d ago, purge_error='   ' (whitespace) → NOT purge_error_rows
  --  C5   nonblank path, active, purge_error='real'                      → NOT purge_error_rows (active row)
  --  C6   nonblank path, deleted 95d ago, purge_error='real'             → IS purge_error_rows
  --  C7   blank path, purged, microscope                                 → NOT metadata_only_anchor
  --  C8   NULL path, deleted 5d ago, stored_bytes NULL                   → NOT deleted_retained_unknown
  --  C9   whitespace path, deleted 5d ago, stored_bytes NULL             → NOT deleted_retained_unknown
  --  C10  nonblank path, deleted 5d ago, stored_bytes NULL               → IS deleted_retained_unknown
  --  C11  NULL path, deleted 95d ago, stored_bytes=500                   → NOT byte sums
  --  C12  whitespace path, deleted 5d ago, stored_bytes=600              → NOT byte sums
  -- -----------------------------------------------------------------------

  -- C1: whitespace-only path, active, non-microscope → treated as blank, not active_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, '   ', 100, 'field', NULL, NULL, NULL);

  -- C2: whitespace-only path, active, microscope → metadata_only_anchor
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, '   ', NULL, 'microscope', NULL, NULL, NULL);

  -- C3: whitespace-only path, active, image_type=NULL → NOT metadata_only_anchor
  --     Validates coalesce(image_type,'') guard: NULL type must not accidentally match 'microscope'.
  --     (DB check constraint enforces 'field'|'microscope' only, so uppercased variants cannot be stored.)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, '   ', NULL, NULL, NULL, NULL, NULL);

  -- C4: nonblank path, deleted 95d ago, whitespace-only purge_error → NOT purge_error_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, user_c::text || '/c4.webp', 100, 'field', now() - interval '95 days', NULL, '   ');

  -- C5: nonblank path, active (deleted_at NULL), non-blank purge_error → NOT purge_error_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, user_c::text || '/c5.webp', 200, 'field', NULL, NULL, 'real');

  -- C6: nonblank path, deleted 95d ago, non-blank purge_error → IS purge_error_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, user_c::text || '/c6.webp', 300, 'field', now() - interval '95 days', NULL, 'real');

  -- C7: blank path, purged, microscope → NOT metadata_only_anchor (purged_at IS NOT NULL)
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, '', NULL, 'microscope', now() - interval '50 days', now() - interval '45 days', NULL);

  -- C8: NULL path, deleted 5d ago, stored_bytes NULL → NOT deleted_retained_unknown_primary_size_rows
  --     (Must use image_type='microscope': DB constraint requires storage_path IS NOT NULL OR image_type='microscope')
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, NULL, NULL, 'microscope', now() - interval '5 days', NULL, NULL);

  -- C9: whitespace path, deleted 5d ago, stored_bytes NULL → NOT deleted_retained_unknown_primary_size_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, '   ', NULL, 'field', now() - interval '5 days', NULL, NULL);

  -- C10: nonblank path, deleted 5d ago, stored_bytes NULL → IS deleted_retained_unknown_primary_size_rows
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, user_c::text || '/c10.webp', NULL, 'field', now() - interval '5 days', NULL, NULL);

  -- C11: NULL path, deleted 95d ago, stored_bytes=500 → contributes 0 to all byte sums
  --     (Must use image_type='microscope': DB constraint requires storage_path IS NOT NULL OR image_type='microscope')
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, NULL, 500, 'microscope', now() - interval '95 days', NULL, NULL);

  -- C12: whitespace path, deleted 5d ago, stored_bytes=600 → contributes 0 to all byte sums
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, stored_bytes, image_type, deleted_at, purged_at, purge_error)
  VALUES (obs_c, user_c, '   ', 600, 'field', now() - interval '5 days', NULL, NULL);

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
  -- active_rows: rows 1 and 8 = 2 (row 2/2b are anchors, not active)
  -- active_recorded_primary_bytes: only row 1 = 1000 (row 8 has NULL bytes)
  -- -----------------------------------------------------------------------
  IF row_a.active_rows <> 2 THEN
    RAISE EXCEPTION 'Test 1 FAIL: active_rows expected 2, got %', row_a.active_rows;
  END IF;
  IF row_a.active_recorded_primary_bytes <> 1000 THEN
    RAISE EXCEPTION 'Test 1 FAIL: active_recorded_primary_bytes expected 1000, got %', row_a.active_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 2: metadata_only_anchor_rows
  -- row 2 (NULL storage_path, microscope) + row 2b ('' storage_path, microscope) = 2
  -- must NOT appear in active_rows, no bytes contributed
  -- -----------------------------------------------------------------------
  IF row_a.metadata_only_anchor_rows <> 2 THEN
    RAISE EXCEPTION 'Test 2 FAIL: metadata_only_anchor_rows expected 2 (NULL + blank storage_path), got %', row_a.metadata_only_anchor_rows;
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
  -- Test 6: purged_rows and exact deleted_retained counts / bytes
  -- purged_rows = 1 (row 7)
  -- deleted_retained_rows = rows 3+4+5+6+9 = 5 (purged row 7 excluded)
  -- deleted_retained_recorded_primary_bytes = 2000+3000+500+400 = 5900
  --   (row 9 has NULL bytes so excluded from sum; row 7 purged so excluded)
  -- -----------------------------------------------------------------------
  IF row_a.purged_rows <> 1 THEN
    RAISE EXCEPTION 'Test 6 FAIL: purged_rows expected 1, got %', row_a.purged_rows;
  END IF;
  IF row_a.deleted_retained_rows <> 5 THEN
    RAISE EXCEPTION 'Test 6 FAIL: deleted_retained_rows expected 5, got %', row_a.deleted_retained_rows;
  END IF;
  IF row_a.deleted_retained_recorded_primary_bytes <> 5900 THEN
    RAISE EXCEPTION 'Test 6 FAIL: deleted_retained_recorded_primary_bytes expected 5900, got %',
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
  -- Test 8: user isolation — user_b sees only its own 1 active row
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
  -- cutoff_recent = now() - 1 day.
  -- All user_a deleted rows (5d, 90d, 95d, 95d, 5d) have deleted_at older than 1 day
  -- → all <= cutoff_recent → reclaimable=5, restore_window=0.
  -- -----------------------------------------------------------------------
  SELECT * INTO row_a2
    FROM public.admin_media_storage_breakdown(ARRAY[user_a], cutoff_recent)
   WHERE user_id = user_a;

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
  -- Test 11: partition invariant — user_a's 4 non-deleted/non-purged rows split
  --          exactly into byte-backed active rows (2) and metadata-only anchors (2);
  --          no row is double-counted or dropped between the two categories
  -- -----------------------------------------------------------------------
  IF row_a.active_rows + row_a.metadata_only_anchor_rows <> 4 THEN
    RAISE EXCEPTION 'Test 11 FAIL: active_rows + metadata_only_anchor_rows expected 4, got % + %', row_a.active_rows, row_a.metadata_only_anchor_rows;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 12: duplicate UUID in p_user_ids → single row, non-inflated counts
  -- -----------------------------------------------------------------------
  SELECT * INTO row_dup
    FROM public.admin_media_storage_breakdown(ARRAY[user_b, user_b, user_b], cutoff_past)
   WHERE user_id = user_b;

  IF (SELECT count(*) FROM public.admin_media_storage_breakdown(ARRAY[user_b, user_b], cutoff_past)) <> 1 THEN
    RAISE EXCEPTION 'Test 12 FAIL: duplicate UUID in p_user_ids must return exactly 1 row';
  END IF;
  IF row_dup.active_rows <> 1 THEN
    RAISE EXCEPTION 'Test 12 FAIL: duplicate UUID must not inflate counts, active_rows=%', row_dup.active_rows;
  END IF;
  IF row_dup.active_recorded_primary_bytes <> 5000 THEN
    RAISE EXCEPTION 'Test 12 FAIL: duplicate UUID must not inflate bytes, active_recorded_primary_bytes=%', row_dup.active_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Test 13: zero-image user → one row returned with zero counts / NULL sums
  -- -----------------------------------------------------------------------
  SELECT * INTO row_empty
    FROM public.admin_media_storage_breakdown(ARRAY[user_a, user_empty], cutoff_past)
   WHERE user_id = user_empty;

  IF row_empty IS NULL THEN
    RAISE EXCEPTION 'Test 13 FAIL: zero-image user must return a row';
  END IF;
  IF row_empty.active_rows <> 0 THEN
    RAISE EXCEPTION 'Test 13 FAIL: zero-image user active_rows expected 0, got %', row_empty.active_rows;
  END IF;
  IF row_empty.metadata_only_anchor_rows <> 0 THEN
    RAISE EXCEPTION 'Test 13 FAIL: zero-image user metadata_only_anchor_rows expected 0, got %', row_empty.metadata_only_anchor_rows;
  END IF;
  IF row_empty.active_recorded_primary_bytes IS NOT NULL THEN
    RAISE EXCEPTION 'Test 13 FAIL: zero-image user active_recorded_primary_bytes expected NULL, got %', row_empty.active_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- user_c assertions: blank/lifecycle hardening cases
  -- Expected for user_c with cutoff_past (60 days ago):
  --   active_rows                                = 1  (C5 only — C1 has blank path)
  --   metadata_only_anchor_rows                  = 1  (C2 only; C3 has null image_type → coalesce→'' ≠ 'microscope'; C7 purged)
  --   deleted_retained_rows                      = 7  (C4,C6,C8,C9,C10,C11,C12; C7 purged)
  --   reclaimable_rows                           = 3  (C4,C6,C11 — all 95d ago)
  --   restore_window_rows                        = 4  (C8,C9,C10,C12 — all 5d ago)
  --   purge_error_rows                           = 1  (C6 only; C4 has whitespace error; C5 is active)
  --   purged_rows                                = 1  (C7)
  --   active_rows                                = 1  (C5; C1 has blank path so excluded)
  --   active_recorded_primary_bytes              = 200 (C5)
  --   deleted_retained_recorded_primary_bytes    = 400 (C4:100 + C6:300; C8/C9/C10 null bytes; C11/C12 blank path)
  --   reclaimable_recorded_primary_bytes         = 400 (C4:100 + C6:300; C11 has null path excluded)
  --   restore_window_recorded_primary_bytes      = NULL (C8/C9/C10 null bytes; C12 blank path — all excluded, SUM over zero rows is NULL)
  --   active_unknown_primary_size_rows           = 0   (C1 has blank path so excluded)
  --   deleted_retained_unknown_primary_size_rows = 1   (C10 only; C8 null path; C9 blank path)
  -- -----------------------------------------------------------------------
  SELECT * INTO row_c
    FROM public.admin_media_storage_breakdown(ARRAY[user_c], cutoff_past)
   WHERE user_id = user_c;

  -- Case 1: storage_path='   ' treated as blank (C1 must NOT be in active_rows)
  -- Case 5: active row with real purge_error (C5) NOT in purge_error_rows
  -- (together: active_rows = 1 because only C5 has nonblank path + active)
  IF row_c.active_rows <> 1 THEN
    RAISE EXCEPTION 'Blank-path case 1/5 FAIL: active_rows expected 1 (whitespace path excluded, C5 counted), got %', row_c.active_rows;
  END IF;

  -- Case 1: C1 has stored_bytes=100 but blank path → contributes 0 to active_recorded_primary_bytes
  -- Case 13 (normal): C5 active with 200 bytes
  IF row_c.active_recorded_primary_bytes <> 200 THEN
    RAISE EXCEPTION 'Case 1/13 FAIL: active_recorded_primary_bytes expected 200, got %', row_c.active_recorded_primary_bytes;
  END IF;

  -- Case 2: microscope + whitespace path is metadata-only anchor (C2 counted)
  -- Case 3: NULL image_type is NOT recognized as microscope (coalesce→''≠'microscope'; C3 not counted)
  --         (DB check constraint enforces 'field'|'microscope' only, so ' Microscope ' cannot be stored;
  --          the coalesce guard is validated here via NULL image_type instead.)
  -- Case 7: purged microscope row NOT a metadata-only anchor (C7 excluded; purged_at IS NOT NULL)
  IF row_c.metadata_only_anchor_rows <> 1 THEN
    RAISE EXCEPTION 'Cases 2/3/7 FAIL: metadata_only_anchor_rows expected 1 (C2 only), got %', row_c.metadata_only_anchor_rows;
  END IF;

  -- Case 4: whitespace-only purge_error NOT counted (C4 excluded)
  -- Case 5: active row with real purge_error NOT counted (C5 excluded — deleted_at IS NULL)
  -- Case 6: deleted/unpurged with real purge_error IS counted (C6)
  IF row_c.purge_error_rows <> 1 THEN
    RAISE EXCEPTION 'Cases 4/5/6 FAIL: purge_error_rows expected 1 (C6 only), got %', row_c.purge_error_rows;
  END IF;

  -- Case 7: purged microscope row not anchor — also check purged_rows
  IF row_c.purged_rows <> 1 THEN
    RAISE EXCEPTION 'Case 7 FAIL: purged_rows expected 1 (C7), got %', row_c.purged_rows;
  END IF;

  -- deleted_retained_rows: pure lifecycle count, no path filter
  -- C4,C6,C8,C9,C10,C11,C12 = 7 (C7 has purged_at IS NOT NULL so excluded)
  IF row_c.deleted_retained_rows <> 7 THEN
    RAISE EXCEPTION 'Case 6 FAIL: deleted_retained_rows expected 7, got %', row_c.deleted_retained_rows;
  END IF;

  -- reclaimable_rows: pure lifecycle, C4+C6+C11 (all 95d ago <= 60d cutoff) = 3
  IF row_c.reclaimable_rows <> 3 THEN
    RAISE EXCEPTION 'Case 6 FAIL: reclaimable_rows expected 3, got %', row_c.reclaimable_rows;
  END IF;

  -- restore_window_rows: pure lifecycle, C8+C9+C10+C12 (all 5d ago > 60d cutoff) = 4
  IF row_c.restore_window_rows <> 4 THEN
    RAISE EXCEPTION 'Case 6 FAIL: restore_window_rows expected 4, got %', row_c.restore_window_rows;
  END IF;

  -- Case 8: deleted row with NULL path + NULL stored_bytes NOT counted as unknown
  -- Case 9: deleted row with whitespace path + NULL stored_bytes NOT counted as unknown
  -- Case 10: deleted row with real path + NULL stored_bytes IS counted
  IF row_c.deleted_retained_unknown_primary_size_rows <> 1 THEN
    RAISE EXCEPTION 'Cases 8/9/10 FAIL: deleted_retained_unknown_primary_size_rows expected 1 (C10 only), got %', row_c.deleted_retained_unknown_primary_size_rows;
  END IF;

  -- Case 1: C1 active with blank path + stored_bytes → not counted in active_unknown
  IF row_c.active_unknown_primary_size_rows <> 0 THEN
    RAISE EXCEPTION 'Case 1 FAIL: active_unknown_primary_size_rows expected 0 (C1 blank path excluded), got %', row_c.active_unknown_primary_size_rows;
  END IF;

  -- Case 11: deleted row with NULL path + stored_bytes contributes 0 to deleted_retained_recorded_primary_bytes
  -- Case 12: whitespace path row contributes 0 to byte sums
  -- Case 13: normal byte-backed rows (C4:100 + C6:300 = 400)
  IF row_c.deleted_retained_recorded_primary_bytes <> 400 THEN
    RAISE EXCEPTION 'Cases 11/12/13 FAIL: deleted_retained_recorded_primary_bytes expected 400, got %', row_c.deleted_retained_recorded_primary_bytes;
  END IF;

  -- Case 11/12: reclaimable byte sums also exclude null/blank path rows
  -- C4 (95d, nonblank, 100) + C6 (95d, nonblank, 300) = 400; C11 (95d, NULL path) excluded
  IF row_c.reclaimable_recorded_primary_bytes <> 400 THEN
    RAISE EXCEPTION 'Cases 11/12 FAIL: reclaimable_recorded_primary_bytes expected 400, got %', row_c.reclaimable_recorded_primary_bytes;
  END IF;

  -- Case 12: restore-window byte sum: C8/C9/C10 null bytes, C12 blank path → all excluded → NULL
  IF row_c.restore_window_recorded_primary_bytes IS NOT NULL THEN
    RAISE EXCEPTION 'Case 12 FAIL: restore_window_recorded_primary_bytes expected NULL (all excluded), got %', row_c.restore_window_recorded_primary_bytes;
  END IF;

  -- -----------------------------------------------------------------------
  -- Cleanup
  -- -----------------------------------------------------------------------
  DELETE FROM public.observation_images WHERE user_id IN (user_a, user_b, user_c);
  DELETE FROM public.observations WHERE id IN (obs_a, obs_b, obs_c);
  DELETE FROM public.profiles WHERE id IN (user_a, user_b, user_empty, user_c);
  DELETE FROM auth.users WHERE id IN (user_a, user_b, user_empty, user_c);

  RAISE NOTICE 'admin_media_storage_breakdown_test passed (42 assertions)';
END $$;
