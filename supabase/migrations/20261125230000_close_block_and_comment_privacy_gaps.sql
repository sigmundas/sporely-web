-- Close the blocking and comment privacy gaps found by the 2026-11-25 security
-- scan (work package A in
-- docs/plans/active/2026-11-25-security-scan-remaining-findings.md).
--
-- 1. user_blocks: only the blocker reads a block row. The blocked side keeps
--    being filtered through the SECURITY DEFINER helpers is_blocked_between /
--    current_user_is_blocked_with and the people RPCs, none of which need the
--    caller to see the row.
-- 2. comments: the base-table SELECT policy now applies the same author
--    filters as comments_community_view (author not banned, no block in either
--    direction), so a direct table read returns no more than the view.
-- 3. friendships: a request or an acceptance needs no block between the two
--    users and neither of them banned.
-- 4. Media key-ownership triggers: a parent observation that is missing and one
--    owned by someone else now give the same error and SQLSTATE (42501), and the
--    message no longer names the parent's owner.
-- 5. observations_follow_view gets back security_barrier (20261001195524
--    re-created it without the WITH clause); comments_community_view gets it
--    for the first time, like the other non-owner read views.
-- 6. comments INSERT is limited to the columns the clients send, so id and
--    created_at are always server-chosen.

BEGIN;

-- 1. user_blocks ---------------------------------------------------------------

DROP POLICY IF EXISTS "Users can view their own blocks" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can insert their own blocks" ON public.user_blocks;
DROP POLICY IF EXISTS "Users can delete their own blocks" ON public.user_blocks;

CREATE POLICY "Users can view their own blocks"
  ON public.user_blocks
  FOR SELECT
  TO authenticated
  USING (auth.uid() = blocker_id);

CREATE POLICY "Users can insert their own blocks"
  ON public.user_blocks
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = blocker_id);

CREATE POLICY "Users can delete their own blocks"
  ON public.user_blocks
  FOR DELETE
  TO authenticated
  USING (auth.uid() = blocker_id);

-- anon never had a working path (every policy needs auth.uid()); there is no
-- UPDATE policy, so UPDATE was already refused.
REVOKE ALL ON TABLE public.user_blocks FROM anon;
REVOKE ALL ON TABLE public.user_blocks FROM authenticated;
GRANT SELECT, DELETE ON TABLE public.user_blocks TO authenticated;
GRANT INSERT (blocker_id, blocked_id) ON TABLE public.user_blocks TO authenticated;

-- 2. comments read policy ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.comment_author_is_visible(p_author_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT p_author_id IS NOT NULL
     AND NOT public.current_user_is_blocked_with(p_author_id)
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.id = p_author_id
         AND p.is_banned = true
     )
$$;

REVOKE ALL ON FUNCTION public.comment_author_is_visible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.comment_author_is_visible(uuid) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.comment_author_is_visible(uuid) TO authenticated;

COMMENT ON FUNCTION public.comment_author_is_visible(uuid) IS
  'RLS helper for phase7_comments_read: the comment author is not banned and '
  'there is no block between the author and the caller. Matches the author '
  'filters in comments_community_view.';

DROP POLICY IF EXISTS phase7_comments_read ON public.comments;

CREATE POLICY phase7_comments_read
  ON public.comments
  FOR SELECT
  TO authenticated
  USING (
    public.can_access_observation_comments(observation_id)
    AND NOT public.is_comment_hidden(id)
    AND public.comment_author_is_visible(user_id)
  );

-- 3. friendships ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.can_befriend(p_other_user_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
     AND p_other_user_id IS NOT NULL
     AND NOT public.is_blocked_between(auth.uid(), p_other_user_id)
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles p
       WHERE p.id IN (auth.uid(), p_other_user_id)
         AND p.is_banned = true
     )
$$;

REVOKE ALL ON FUNCTION public.can_befriend(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_befriend(uuid) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_befriend(uuid) TO authenticated;

COMMENT ON FUNCTION public.can_befriend(uuid) IS
  'RLS helper for the friendships INSERT and accept policies: no block between '
  'the caller and the other user, and neither of them is banned.';

DROP POLICY IF EXISTS "friendships: requester can insert pending" ON public.friendships;
DROP POLICY IF EXISTS "friendships: addressee can accept" ON public.friendships;

CREATE POLICY "friendships: requester can insert pending"
  ON public.friendships
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = requester_id
    AND requester_id <> addressee_id
    AND status = 'pending'
    AND public.can_befriend(addressee_id)
  );

CREATE POLICY "friendships: addressee can accept"
  ON public.friendships
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = addressee_id AND status = 'pending')
  WITH CHECK (
    auth.uid() = addressee_id
    AND status = 'accepted'
    AND public.can_befriend(requester_id)
  );

-- 4. Media key-ownership triggers ------------------------------------------------
-- Bodies are unchanged from 20260804120000 / 20261011100000 except for the
-- merged parent check and search_path. The old value 'public,pg_catalog' was a
-- single (non-existent) schema name, so '' resolves exactly the same names:
-- every non-catalog reference is schema-qualified.

CREATE OR REPLACE FUNCTION public._media_guard_key_ownership_image()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  is_trusted boolean := (auth.uid() IS NULL);
  caller_uid uuid    := auth.uid();
  parent_owner uuid;
  expected_prefix text;
BEGIN
  IF is_trusted THEN
    RETURN NEW;
  END IF;

  IF caller_uid IS NULL THEN
    RAISE EXCEPTION 'observation_images write requires an authenticated caller'
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF NEW.user_id IS DISTINCT FROM caller_uid THEN
    RAISE EXCEPTION
      'observation_images.user_id (%) must equal auth.uid() (%)',
      NEW.user_id, caller_uid
      USING ERRCODE='insufficient_privilege';
  END IF;

  -- Missing and someone else's parent give one answer, so the error says
  -- nothing about observations the caller cannot read.
  parent_owner := public._media_get_observation_user_id(NEW.observation_id);
  IF parent_owner IS NULL OR parent_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION
      'observation_id % is not an observation of the caller',
      NEW.observation_id
      USING ERRCODE='insufficient_privilege';
  END IF;

  expected_prefix := NEW.user_id::text || '/';

  IF NEW.storage_path IS NOT NULL AND NEW.storage_path <> ''
     AND NOT (NEW.storage_path LIKE expected_prefix || '%') THEN
    RAISE EXCEPTION
      'storage_path (%) must live under the row owner''s prefix (%)',
      NEW.storage_path, expected_prefix
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF NEW.original_storage_path IS NOT NULL AND NEW.original_storage_path <> ''
     AND NOT (NEW.original_storage_path LIKE expected_prefix || '%') THEN
    RAISE EXCEPTION
      'original_storage_path (%) must live under the row owner''s prefix (%)',
      NEW.original_storage_path, expected_prefix
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.observation_id IS DISTINCT FROM OLD.observation_id THEN
      RAISE EXCEPTION 'observation_images.observation_id is immutable'
        USING ERRCODE='insufficient_privilege';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'observation_images.user_id is immutable'
        USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public._media_guard_key_ownership_mosaic()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  caller_uid uuid := auth.uid();
  parent_owner uuid;
  expected_prefix text;
BEGIN
  IF caller_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM caller_uid THEN
    RAISE EXCEPTION
      'spore_measurement_mosaics.user_id (%) must equal auth.uid() (%)',
      NEW.user_id, caller_uid
      USING ERRCODE='insufficient_privilege';
  END IF;

  parent_owner := public._media_get_observation_user_id(NEW.observation_id);
  IF parent_owner IS NULL OR parent_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION
      'observation_id % is not an observation of the caller',
      NEW.observation_id
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.storage_key IS DISTINCT FROM OLD.storage_key THEN
    expected_prefix := NEW.user_id::text || '/';
    IF NEW.storage_key IS NULL
       OR NOT starts_with(NEW.storage_key, expected_prefix)
       OR NEW.storage_key ~ '(^|/)\.{1,2}(/|$)'
       OR strpos(NEW.storage_key, '//') > 0
       OR right(NEW.storage_key, 1) = '/'
       OR strpos(NEW.storage_key, chr(92)) > 0
       OR NEW.storage_key ~ '[\x01-\x1f]' THEN
      RAISE EXCEPTION
        'spore_measurement_mosaics.storage_key must be a normalized key under the row owner''s prefix (%)',
        expected_prefix
        USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- 5. View security_barrier ------------------------------------------------------

ALTER VIEW public.observations_follow_view SET (security_barrier = true);
ALTER VIEW public.comments_community_view SET (security_barrier = true);

-- 6. comments INSERT columns -----------------------------------------------------
-- UPDATE is already limited to (body) by 20261119130000. anon never had a
-- working path: every comments policy is TO authenticated, and anon reads go
-- through comments_community_view, which runs as its owner.

REVOKE ALL ON TABLE public.comments FROM anon;
REVOKE ALL ON TABLE public.comments FROM authenticated;
GRANT SELECT, DELETE ON TABLE public.comments TO authenticated;
GRANT INSERT (observation_id, user_id, body, mentioned_user_ids) ON TABLE public.comments TO authenticated;
GRANT UPDATE (body) ON TABLE public.comments TO authenticated;

COMMIT;
