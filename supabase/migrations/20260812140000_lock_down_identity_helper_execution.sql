-- Restrict identity/entitlement helpers to their intended database callers.
-- Only non_public_observation_count remains a client RPC, and it is self-only.

BEGIN;

CREATE OR REPLACE FUNCTION public.non_public_observation_count(profile_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM profile_id THEN
    RAISE EXCEPTION 'non_public_observation_count may only be called for the current user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN (
    SELECT count(*)::integer
    FROM public.observations o
    WHERE o.user_id = profile_id
      AND NOT coalesce(o.is_draft, false)
      AND (
        coalesce(o.visibility, 'public') <> 'public'
        OR coalesce(o.location_precision, 'exact') IN ('fuzzed', 'region', 'hidden')
      )
  );
END
$$;

ALTER FUNCTION public.non_public_observation_count(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.non_public_observation_count(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.non_public_observation_count(uuid) TO authenticated;

-- profile_has_pro_access is invoked only from postgres-owned trigger paths.
ALTER FUNCTION public.profile_has_pro_access(uuid) SET search_path = '';
REVOKE ALL ON FUNCTION public.profile_has_pro_access(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The original two-user helpers are internal-only. SECURITY DEFINER callers
-- (including media authorization) execute them as postgres.
CREATE OR REPLACE FUNCTION public.are_friends(user_a uuid, user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT user_a IS NOT NULL
     AND user_b IS NOT NULL
     AND user_a <> user_b
     AND EXISTS (
       SELECT 1
       FROM public.friendships f
       WHERE f.status = 'accepted'
         AND (
           (f.requester_id = user_a AND f.addressee_id = user_b)
           OR (f.requester_id = user_b AND f.addressee_id = user_a)
         )
     );
$$;

CREATE OR REPLACE FUNCTION public.is_blocked_between(user_a uuid, user_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT user_a IS NOT NULL
     AND user_b IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.user_blocks ub
       WHERE (ub.blocker_id = user_a AND ub.blocked_id = user_b)
          OR (ub.blocker_id = user_b AND ub.blocked_id = user_a)
     );
$$;

ALTER FUNCTION public.are_friends(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.is_blocked_between(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.are_friends(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_blocked_between(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- PostgreSQL checks function EXECUTE as the querying role inside views. These
-- one-argument wrappers preserve existing community-view behavior without
-- exposing an arbitrary two-user relationship oracle.
CREATE OR REPLACE FUNCTION public.current_user_is_friend_with(other_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.are_friends(auth.uid(), other_user_id)
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_blocked_with(other_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.is_blocked_between(auth.uid(), other_user_id)
$$;

ALTER FUNCTION public.current_user_is_friend_with(uuid) OWNER TO postgres;
ALTER FUNCTION public.current_user_is_blocked_with(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.current_user_is_friend_with(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_is_blocked_with(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_is_friend_with(uuid)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_is_blocked_with(uuid)
  TO anon, authenticated, service_role;

-- Preserve the exact active view projections/options/grants and replace only
-- their direct calls to the now-internal two-user helpers.
DO $view_rewrite$
DECLARE
  view_name text;
  view_sql text;
  rewritten_sql text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY[
    'comments_community_view',
    'observation_identifications_community_view',
    'observation_images_community_view',
    'observations_community_view',
    'observations_follow_view',
    'observations_friend_view'
  ]
  LOOP
    SELECT pg_catalog.pg_get_viewdef(
      pg_catalog.to_regclass(format('public.%I', view_name)),
      true
    ) INTO view_sql;

    IF view_sql IS NULL THEN
      RAISE EXCEPTION 'required view public.% does not exist', view_name;
    END IF;

    rewritten_sql := replace(
      view_sql,
      'is_blocked_between(auth.uid(), ',
      'public.current_user_is_blocked_with('
    );
    rewritten_sql := replace(
      rewritten_sql,
      'are_friends(auth.uid(), ',
      'public.current_user_is_friend_with('
    );

    IF position('is_blocked_between(auth.uid(),' IN rewritten_sql) > 0
       OR position('are_friends(auth.uid(),' IN rewritten_sql) > 0 THEN
      RAISE EXCEPTION 'failed to replace relationship helper in public.%', view_name;
    END IF;

    EXECUTE format('CREATE OR REPLACE VIEW public.%I AS %s', view_name, rewritten_sql);
  END LOOP;
END
$view_rewrite$;

COMMENT ON FUNCTION public.non_public_observation_count(uuid) IS
  'Self-only authenticated RPC returning the current user privacy-slot observation count.';
COMMENT ON FUNCTION public.profile_has_pro_access(uuid) IS
  'Internal entitlement helper for postgres-owned trigger/function execution; not client-executable.';
COMMENT ON FUNCTION public.are_friends(uuid, uuid) IS
  'Internal two-user relationship helper for postgres-owned authorization paths; not client-executable.';
COMMENT ON FUNCTION public.is_blocked_between(uuid, uuid) IS
  'Internal two-user block helper for postgres-owned authorization paths; not client-executable.';
COMMENT ON FUNCTION public.current_user_is_friend_with(uuid) IS
  'Community-view helper restricted implicitly to auth.uid(); cannot query arbitrary user pairs.';
COMMENT ON FUNCTION public.current_user_is_blocked_with(uuid) IS
  'Community-view helper restricted implicitly to auth.uid(); cannot query arbitrary user pairs.';

NOTIFY pgrst, 'reload schema';

COMMIT;
