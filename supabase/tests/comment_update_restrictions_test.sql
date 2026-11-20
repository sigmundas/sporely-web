-- Validates 20261119130000_restrict_comment_updates.sql.
--
-- Authors may edit the body of their own comment on an observation they can
-- access, and nothing else: no moving it to another observation (readable or
-- not), no backdating, no rewriting mentions or ownership.
--
-- Run after local migrations (rolls back its seed data):
--   supabase db query --local -f supabase/tests/comment_update_restrictions_test.sql

BEGIN;

DO $$
DECLARE
  author_id uuid := '00000000-0000-4000-8000-00000000ce01';
  private_owner_id uuid := '00000000-0000-4000-8000-00000000ce02';
  other_id uuid := '00000000-0000-4000-8000-00000000ce03';
  public_obs bigint := 880000000101;
  other_public_obs bigint := 880000000104;
  private_obs bigint := 880000000102;
  revoked_obs bigint := 880000000103;
  comment_id bigint := 880000000101;
  revoked_comment_id bigint := 880000000103;
  v_count integer;
  v_text text;
  v_denied boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (author_id, 'authenticated', 'authenticated', 'cu-author@example.test', '{}'::jsonb, now(), now()),
    (private_owner_id, 'authenticated', 'authenticated', 'cu-private@example.test', '{}'::jsonb, now(), now()),
    (other_id, 'authenticated', 'authenticated', 'cu-other@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, is_banned)
  VALUES
    (author_id, 'cu_author', false),
    (private_owner_id, 'cu_private_owner', false),
    (other_id, 'cu_other', false)
  ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, is_banned = false, is_admin = false;

  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES
    (public_obs, private_owner_id, current_date, 'public', false),
    (private_obs, private_owner_id, current_date, 'private', false),
    (revoked_obs, private_owner_id, current_date, 'public', false),
    (other_public_obs, private_owner_id, current_date, 'public', false)
  ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, date = EXCLUDED.date,
    visibility = EXCLUDED.visibility, is_draft = EXCLUDED.is_draft;

  INSERT INTO public.comments (id, observation_id, user_id, body)
  VALUES
    (comment_id, public_obs, author_id, 'Original body'),
    (revoked_comment_id, revoked_obs, author_id, 'On a later-private observation')
  ON CONFLICT (id) DO UPDATE SET observation_id = EXCLUDED.observation_id,
    user_id = EXCLUDED.user_id, body = EXCLUDED.body;

  -- The owner later makes this observation private: the author loses access.
  UPDATE public.observations SET visibility = 'private' WHERE id = revoked_obs;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', author_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', author_id::text, true);

  -- U1: the author can still edit the body of an accessible comment.
  UPDATE public.comments SET body = 'Edited body' WHERE id = comment_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN RAISE EXCEPTION 'U1: author body edit must update 1 row, got %', v_count; END IF;

  -- U2..U6: every other column is refused outright.
  v_denied := false;
  BEGIN
    UPDATE public.comments SET observation_id = private_obs WHERE id = comment_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'U2: author moved a comment onto a private observation'; END IF;

  v_denied := false;
  BEGIN
    UPDATE public.comments SET observation_id = other_public_obs WHERE id = comment_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'U2b: author moved a comment to another readable thread'; END IF;

  v_denied := false;
  BEGIN
    UPDATE public.comments SET created_at = now() - interval '5 years' WHERE id = comment_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'U3: author backdated a comment'; END IF;

  v_denied := false;
  BEGIN
    UPDATE public.comments SET mentioned_user_ids = ARRAY[other_id] WHERE id = comment_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'U4: author rewrote mentions after posting'; END IF;

  v_denied := false;
  BEGIN
    UPDATE public.comments SET user_id = other_id WHERE id = comment_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'U5: author reassigned a comment'; END IF;

  v_denied := false;
  BEGIN
    UPDATE public.comments SET id = comment_id + 1 WHERE id = comment_id;
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'U6: author changed a comment id'; END IF;

  -- U7: no edits on an observation the author can no longer access.
  UPDATE public.comments SET body = 'Edited after access lost' WHERE id = revoked_comment_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RAISE EXCEPTION 'U7: author edited a comment on an inaccessible observation'; END IF;

  -- U8: another user cannot edit the author's comment.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', other_id::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  UPDATE public.comments SET body = 'Hijacked' WHERE id = comment_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 0 THEN RAISE EXCEPTION 'U8: another user edited the comment'; END IF;

  RESET ROLE;
  SELECT body INTO v_text FROM public.comments WHERE id = comment_id;
  IF v_text IS DISTINCT FROM 'Edited body' THEN RAISE EXCEPTION 'U9: unexpected final body %', v_text; END IF;
  SELECT body INTO v_text FROM public.comments WHERE id = revoked_comment_id;
  IF v_text IS DISTINCT FROM 'On a later-private observation' THEN RAISE EXCEPTION 'U10: unexpected body %', v_text; END IF;

  RAISE NOTICE 'comment_update_restrictions_test: all checks passed';
END
$$;

ROLLBACK;
