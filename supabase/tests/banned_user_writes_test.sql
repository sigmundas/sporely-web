-- Regression coverage for 20261125233000_refuse_writes_from_banned_users.
-- Proves, for a banned signed-in user:
--   * INSERT and UPDATE on user-content tables are refused (42501, hint
--     sporely_account_suspended), also through a client RPC;
--   * DELETE still works, including the foreign-key SET NULL it causes on
--     another user's report;
--   * a tombstone update (deleted_at only) still works; a tombstone that also
--     changes another column does not;
--   * record_client_activity still records the activity columns on profiles;
--   * blocking another user still works;
-- and that a user who is not banned, a service-role/owner write and the same
-- user after an unban are unaffected. Also checks the trigger is on every
-- covered table.
--
-- Run after local migrations:
--   psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f supabase/tests/banned_user_writes_test.sql

BEGIN;

CREATE FUNCTION pg_temp.expect_suspended(stmt text, label text)
  RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
  hint text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, hint = PG_EXCEPTION_HINT;
    IF st = '42501' AND hint = 'sporely_account_suspended' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION '%: refused with [%] hint %, expected the suspension error', label, st, hint;
  END;
  RAISE EXCEPTION '%: a banned user''s write succeeded', label;
END
$$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_suspended(text, text) TO authenticated;

DO $$
DECLARE
  banned_id uuid := '00000000-0000-4000-8000-0000001125b1';
  normal_id uuid := '00000000-0000-4000-8000-0000001125b2';
  obs_banned  bigint := 881125233001;
  obs_banned2 bigint := 881125233002;
  obs_normal  bigint := 881125233003;
  img_banned  bigint := 881125233011;
  img_banned2 bigint := 881125233012;
  report_on_banned uuid;
  covered text[] := ARRAY[
    'calibrations', 'comments', 'follows', 'friendships',
    'observation_identifications', 'observation_images',
    'observation_reference_uses', 'observation_shares',
    'observation_spore_summaries', 'observations', 'profiles',
    'reference_curated_forks', 'reference_measurement_sets',
    'reference_taxon_treatments', 'reference_works', 'reports',
    'spore_annotations', 'spore_measurement_mosaic_tiles',
    'spore_measurement_mosaics', 'spore_measurements'];
  missing text[];
  n bigint;
  ts timestamptz;
BEGIN
  SELECT array_agg(t) INTO missing
  FROM unnest(covered) t
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid = ('public.' || t)::regclass
      AND tr.tgname = 'aab_refuse_banned_writer'
      AND tr.tgenabled = 'O');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'aab_refuse_banned_writer missing on %', missing;
  END IF;

  ---------------------------------------------------------------------------
  -- Fixtures (as postgres)
  ---------------------------------------------------------------------------
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (banned_id, 'authenticated', 'authenticated', 'buw-banned@example.test', '{}'::jsonb, now(), now()),
    (normal_id, 'authenticated', 'authenticated', 'buw-normal@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, is_banned, profile_completed_at)
  VALUES (banned_id, 'buw_banned', true, now()),
         (normal_id, 'buw_normal', false, now())
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    is_banned = EXCLUDED.is_banned,
    profile_completed_at = EXCLUDED.profile_completed_at;

  INSERT INTO public.observations (id, user_id, date, visibility, is_draft, notes)
  OVERRIDING SYSTEM VALUE
  VALUES (obs_banned,  banned_id, current_date, 'private', false, 'before'),
         (obs_banned2, banned_id, current_date, 'private', false, 'to delete'),
         (obs_normal,  normal_id, current_date, 'public',  false, 'before');

  INSERT INTO public.observation_images (id, observation_id, user_id, image_type, storage_path)
  OVERRIDING SYSTEM VALUE
  VALUES (img_banned,  obs_banned, banned_id, 'field', banned_id::text || '/a.webp'),
         (img_banned2, obs_banned, banned_id, 'field', banned_id::text || '/b.webp');

  -- Owner/service writes are not affected by the ban (auth.uid() is NULL).
  UPDATE public.observations SET notes = 'service edit' WHERE id = obs_banned;

  ---------------------------------------------------------------------------
  -- The banned user
  ---------------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', banned_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', banned_id::text, true);

  PERFORM pg_temp.expect_suspended(format(
    $q$INSERT INTO public.observations (user_id, date, visibility) VALUES (%L, current_date, 'private')$q$,
    banned_id), 'insert observation');
  PERFORM pg_temp.expect_suspended(format(
    $q$UPDATE public.observations SET notes = 'banned edit' WHERE id = %s$q$,
    obs_banned), 'update own observation');
  PERFORM pg_temp.expect_suspended(format(
    $q$INSERT INTO public.comments (observation_id, user_id, body) VALUES (%s, %L, 'hi')$q$,
    obs_normal, banned_id), 'insert comment');
  PERFORM pg_temp.expect_suspended(format(
    $q$INSERT INTO public.follows (user_id, target_type, target_id) VALUES (%L, 'user', %L)$q$,
    banned_id, normal_id), 'insert follow');
  PERFORM pg_temp.expect_suspended(format(
    $q$INSERT INTO public.reports (reporter_id, reported_user_id, reason) VALUES (%L, %L, 'spam')$q$,
    banned_id, normal_id), 'insert report');
  PERFORM pg_temp.expect_suspended(format(
    $q$UPDATE public.profiles SET bio = 'banned bio' WHERE id = %L$q$,
    banned_id), 'update profile');
  PERFORM pg_temp.expect_suspended(format(
    $q$SELECT public.set_observation_location(%s, 59.9, 10.7, NULL, NULL, 'manual', 'acquired')$q$,
    obs_banned), 'set_observation_location RPC');
  PERFORM pg_temp.expect_suspended(format(
    $q$UPDATE public.observation_images SET deleted_at = now(), image_type = 'microscope' WHERE id = %s$q$,
    img_banned2), 'tombstone plus another change');

  -- Allowed: tombstone only.
  UPDATE public.observation_images SET deleted_at = now() WHERE id = img_banned;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'banned user could not tombstone their own image';
  END IF;

  -- Allowed: activity ping.
  PERFORM public.record_client_activity('web_browser', '9.9.9');

  -- Allowed: blocking someone.
  INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES (banned_id, normal_id);

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT last_client_seen_at INTO ts FROM public.profiles WHERE id = banned_id;
  IF ts IS NULL THEN
    RAISE EXCEPTION 'record_client_activity did not update the banned user''s profile';
  END IF;
  IF (SELECT notes FROM public.observations WHERE id = obs_banned) <> 'service edit' THEN
    RAISE EXCEPTION 'a refused update changed the observation';
  END IF;

  -- A report by someone else on the observation the banned user will delete,
  -- so the DELETE triggers an ON DELETE SET NULL update on that report.
  INSERT INTO public.reports (reporter_id, reported_user_id, observation_id, reason)
  VALUES (normal_id, banned_id, obs_banned2, 'fixture')
  RETURNING id INTO report_on_banned;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', banned_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', banned_id::text, true);

  DELETE FROM public.observations WHERE id = obs_banned2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'banned user could not delete their own observation';
  END IF;

  RESET ROLE;
  IF (SELECT observation_id FROM public.reports WHERE id = report_on_banned) IS NOT NULL THEN
    RAISE EXCEPTION 'the delete did not cascade SET NULL to the report';
  END IF;

  ---------------------------------------------------------------------------
  -- A user who is not banned
  ---------------------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', normal_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', normal_id::text, true);

  UPDATE public.observations SET notes = 'normal edit' WHERE id = obs_normal;
  INSERT INTO public.comments (observation_id, user_id, body) VALUES (obs_normal, normal_id, 'ok');
  UPDATE public.profiles SET bio = 'normal bio' WHERE id = normal_id;

  ---------------------------------------------------------------------------
  -- After an unban the same user writes again
  ---------------------------------------------------------------------------
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  UPDATE public.profiles SET is_banned = false WHERE id = banned_id;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', banned_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', banned_id::text, true);

  UPDATE public.observations SET notes = 'after unban' WHERE id = obs_banned;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'an unbanned user still could not write';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'banned_user_writes_test passed';
END
$$;

ROLLBACK;
