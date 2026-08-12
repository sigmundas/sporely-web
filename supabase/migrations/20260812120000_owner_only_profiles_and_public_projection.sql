-- Keep the mixed public/private `profiles` row owner-only for normal clients.
-- Public identity lookups use a deliberately narrow, read-only projection.

BEGIN;

DROP POLICY IF EXISTS "profiles public read" ON public.profiles;
DROP POLICY IF EXISTS "profiles: friends can read" ON public.profiles;
DROP POLICY IF EXISTS "profiles: owner read-write" ON public.profiles;

CREATE POLICY "profiles: owner read-write"
  ON public.profiles
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;

DROP VIEW IF EXISTS public.public_profiles;
DROP FUNCTION IF EXISTS public.read_public_profiles();

CREATE FUNCTION public.read_public_profiles()
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.bio
  FROM public.profiles p
  WHERE p.is_banned IS NOT TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_blocks ub
      WHERE (ub.blocker_id = auth.uid() AND ub.blocked_id = p.id)
         OR (ub.blocker_id = p.id AND ub.blocked_id = auth.uid())
    )
$$;

ALTER FUNCTION public.read_public_profiles() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_public_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_public_profiles() TO anon, authenticated, service_role;

CREATE VIEW public.public_profiles
  WITH (security_barrier = true, security_invoker = true) AS
SELECT
  p.id,
  p.username,
  p.display_name,
  p.avatar_url,
  p.bio
FROM public.read_public_profiles() p;

ALTER VIEW public.public_profiles OWNER TO postgres;

REVOKE ALL ON TABLE public.public_profiles FROM PUBLIC;
REVOKE ALL ON TABLE public.public_profiles FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.public_profiles TO anon, authenticated;
GRANT SELECT ON TABLE public.public_profiles TO service_role;

COMMENT ON VIEW public.public_profiles IS
  'Read-only public profile projection. Never add entitlement, billing, moderation, storage, activity, or onboarding fields.';

COMMENT ON FUNCTION public.read_public_profiles() IS
  'RLS-bypass helper for public_profiles. Returns only five public fields, excludes banned profiles, and enforces two-way blocks for authenticated users.';

-- Remove pre-Phase-7 permissive policies. PostgreSQL ORs permissive policies,
-- so these otherwise bypass the stricter visibility and block checks in the
-- phase7_comments_* policies.
DROP POLICY IF EXISTS "comments_delete" ON public.comments;
DROP POLICY IF EXISTS "comments_insert" ON public.comments;
DROP POLICY IF EXISTS "comments_select" ON public.comments;

-- Raw observations are owner-only. Evaluate commentability behind a boolean
-- helper so the comments policies can authorize visible non-owner observations
-- without exposing the underlying observation row.
CREATE OR REPLACE FUNCTION public.can_access_observation_comments(p_observation_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.observations o
    WHERE o.id = p_observation_id
      AND (
        o.user_id = auth.uid()
        OR (
          NOT coalesce(o.is_draft, false)
          AND public.can_read_observation(o.user_id, o.visibility)
        )
      )
  )
$$;

ALTER FUNCTION public.can_access_observation_comments(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_access_observation_comments(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_observation_comments(bigint) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_observation_comments(bigint) TO authenticated;

-- The moderation table is intentionally not client-readable. Keep that
-- boundary while allowing the authenticated comments SELECT policy to hide
-- moderated rows without raising a table-permission error.
CREATE OR REPLACE FUNCTION public.is_comment_hidden(p_comment_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.comment_moderation cm
    WHERE cm.comment_id = p_comment_id
      AND cm.hidden_at IS NOT NULL
  )
$$;

ALTER FUNCTION public.is_comment_hidden(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_comment_hidden(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_comment_hidden(bigint) FROM anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_comment_hidden(bigint) TO authenticated;

ALTER POLICY "phase7_comments_insert_visible" ON public.comments
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND public.can_access_observation_comments(observation_id)
  );

ALTER POLICY "phase7_comments_read" ON public.comments
  TO authenticated
  USING (
    public.can_access_observation_comments(observation_id)
    AND NOT public.is_comment_hidden(comments.id)
  );

COMMENT ON FUNCTION public.can_access_observation_comments(bigint) IS
  'Policy helper that checks observation comment access without exposing owner-only observation rows.';

COMMENT ON FUNCTION public.is_comment_hidden(bigint) IS
  'Policy helper that preserves comment moderation filtering without exposing comment_moderation rows to clients.';

NOTIFY pgrst, 'reload schema';

COMMIT;
