-- Restrict client comment updates to editing the body of an accessible comment.
--
-- phase7_comments_update_own checked only authorship, and authenticated held
-- UPDATE on every column. Moving a comment onto an observation the author
-- cannot read was already refused (Postgres applies the comments SELECT policy
-- to the updated row), but an author could still:
--   * move their comment to a different thread they can read (observation_id),
--   * backdate it (created_at),
--   * rewrite whom it mentions after posting (mentioned_user_ids).
--
-- No client updates comments today (web, Android and desktop only insert and
-- delete), so this keeps a body-only edit path and closes the rest:
--   * authenticated may UPDATE only the body column;
--   * the update policy states the observation-access check explicitly, the
--     same as the insert policy, instead of relying on the SELECT policy
--     being applied to updated rows. The policy keeps its name so existing
--     policy-inventory tests still hold.
-- Service-role and SECURITY DEFINER paths (scrub_user_mentions, admin
-- moderation) are unaffected.

BEGIN;

REVOKE UPDATE ON TABLE public.comments FROM authenticated;
GRANT UPDATE (body) ON TABLE public.comments TO authenticated;

DROP POLICY IF EXISTS "phase7_comments_update_own" ON public.comments;
CREATE POLICY "phase7_comments_update_own" ON public.comments
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND public.can_access_observation_comments(observation_id))
  WITH CHECK (auth.uid() = user_id AND public.can_access_observation_comments(observation_id));

COMMIT;
