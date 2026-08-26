-- Regression coverage for reports and user_blocks RLS policies.
--
-- Policies under test (from 20260521120000_baseline_live_public_schema.sql):
--   "Users can create reports"         ON public.reports    FOR INSERT WITH CHECK (auth.uid() = reporter_id)
--   "Users can insert their own blocks" ON public.user_blocks FOR INSERT WITH CHECK (auth.uid() = blocker_id)
--   "Users can view their own blocks"   ON public.user_blocks FOR SELECT  USING (auth.uid() = blocker_id OR auth.uid() = blocked_id)
--   "Users can delete their own blocks" ON public.user_blocks FOR DELETE  USING (auth.uid() = blocker_id)
-- No SELECT policy exists on public.reports for non-admin roles; authenticated
-- users therefore read 0 rows from their own reports.
--
-- Fixture UUID/bigint range: 00000000-0000-4000-8000-00000000de** / 890000000***
-- chosen to avoid collision with comments_rls_test (cd** / 880000000***).

BEGIN;

DO $$
DECLARE
  user_a_id uuid := '00000000-0000-4000-8000-00000000de01';
  user_b_id uuid := '00000000-0000-4000-8000-00000000de02';
  user_c_id uuid := '00000000-0000-4000-8000-00000000de03';
  observation_id bigint := 890000000001;
  row_count bigint;
  insert_denied boolean;
BEGIN

  -- Auth users
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (user_a_id, 'authenticated', 'authenticated', 'mod-user-a@example.test', '{}'::jsonb, now(), now()),
    (user_b_id, 'authenticated', 'authenticated', 'mod-user-b@example.test', '{}'::jsonb, now(), now()),
    (user_c_id, 'authenticated', 'authenticated', 'mod-user-c@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  -- Profiles (required by observations FK and user_blocks FK chains)
  INSERT INTO public.profiles (id, username, is_banned)
  VALUES
    (user_a_id, 'mod_user_a', false),
    (user_b_id, 'mod_user_b', false),
    (user_c_id, 'mod_user_c', false)
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    is_banned = EXCLUDED.is_banned;

  -- Observation owned by user_b (used as the reported observation)
  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES (observation_id, user_b_id, current_date, 'public', false)
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    date = EXCLUDED.date,
    visibility = EXCLUDED.visibility,
    is_draft = EXCLUDED.is_draft;

  -- ----------------------------------------------------------------
  -- Act as user_a
  -- ----------------------------------------------------------------
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', user_a_id::text, true);

  -- 1. user_a inserts a report with reporter_id = user_a → allowed
  INSERT INTO public.reports (reporter_id, reported_user_id, observation_id, reason)
  VALUES (user_a_id, user_b_id, observation_id, 'spam');

  -- 2. user_a inserts a report with reporter_id = user_b (spoofed) → denied
  insert_denied := false;
  BEGIN
    INSERT INTO public.reports (reporter_id, reported_user_id, observation_id, reason)
    VALUES (user_b_id, user_a_id, observation_id, 'spoofed reporter');
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'user_a inserted a report with a forged reporter_id for user_b';
  END IF;

  -- 3. No SELECT policy on reports → user_a reads 0 rows from public.reports
  SELECT count(*) INTO row_count
  FROM public.reports
  WHERE reporter_id = user_a_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'user_a unexpectedly read their own report rows (no SELECT policy expected)';
  END IF;

  -- 4. user_a inserts a user_blocks row with blocker_id = user_a → allowed
  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES (user_a_id, user_b_id);

  -- 5. user_a inserts a user_blocks row with blocker_id = user_b (spoofed) → denied
  insert_denied := false;
  BEGIN
    INSERT INTO public.user_blocks (blocker_id, blocked_id)
    VALUES (user_b_id, user_c_id);
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'user_a inserted a user_blocks row with a forged blocker_id for user_b';
  END IF;

  -- 6. user_a SELECT on user_blocks: sees the block user_a created
  SELECT count(*) INTO row_count
  FROM public.user_blocks
  WHERE blocker_id = user_a_id AND blocked_id = user_b_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'user_a could not read the user_blocks row they created';
  END IF;

  -- ----------------------------------------------------------------
  -- Act as user_c (unrelated to the user_a→user_b block)
  -- ----------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', user_c_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', user_c_id::text, true);

  -- 7. user_c SELECT on user_blocks: sees 0 rows (not a party to user_a→user_b)
  SELECT count(*) INTO row_count
  FROM public.user_blocks
  WHERE blocker_id = user_a_id AND blocked_id = user_b_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'user_c read a user_blocks row they are not a party to';
  END IF;

  -- 8. user_c DELETE of user_a's block → silently affects 0 rows
  --    (RLS DELETE denial filters rows rather than raising).
  DELETE FROM public.user_blocks
  WHERE blocker_id = user_a_id AND blocked_id = user_b_id;
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'user_c deleted a user_blocks row they do not own';
  END IF;

  -- ----------------------------------------------------------------
  -- Back to user_a: verify the block survived, then delete it
  -- ----------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', user_a_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', user_a_id::text, true);

  -- 9. The block still exists after user_c's denied delete
  SELECT count(*) INTO row_count
  FROM public.user_blocks
  WHERE blocker_id = user_a_id AND blocked_id = user_b_id;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'user_a block row disappeared after a foreign delete attempt';
  END IF;

  -- 10. user_a deletes their own block → allowed
  DELETE FROM public.user_blocks
  WHERE blocker_id = user_a_id AND blocked_id = user_b_id;
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'user_a could not delete their own user_blocks row';
  END IF;

  -- ----------------------------------------------------------------
  -- Anon role: insert into reports and user_blocks denied
  -- ----------------------------------------------------------------
  RESET ROLE;
  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- 11. anon insert into reports → denied
  insert_denied := false;
  BEGIN
    INSERT INTO public.reports (reporter_id, reported_user_id, observation_id, reason)
    VALUES (user_a_id, user_b_id, observation_id, 'anon attempt');
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'anon inserted a report row';
  END IF;

  -- 12. anon insert into user_blocks → denied
  insert_denied := false;
  BEGIN
    INSERT INTO public.user_blocks (blocker_id, blocked_id)
    VALUES (user_a_id, user_c_id);
  EXCEPTION WHEN insufficient_privilege THEN
    insert_denied := true;
  END;
  IF NOT insert_denied THEN
    RAISE EXCEPTION 'anon inserted a user_blocks row';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'moderation_writes_rls_test passed';
END
$$;

ROLLBACK;
