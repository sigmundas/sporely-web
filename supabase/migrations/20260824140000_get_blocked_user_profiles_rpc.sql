-- get_blocked_user_profiles()
--
-- Returns profile identity fields for every user the caller has blocked.
-- Joins user_blocks (WHERE blocker_id = auth.uid()) directly to the profiles
-- table, bypassing the block filter in public_profiles / read_public_profiles.
-- This is intentional: the blocker must be able to see and recognise the
-- identity of users they blocked so they can choose to unblock them.
--
-- Only the four public identity fields are returned — no entitlement,
-- billing, moderation, storage, or activity columns.
--
-- Banned users: their identity IS returned in the blocker's own blocked list.
-- The blocker may not remember the username — suppressing it would make
-- unblocking impossible. The is_banned flag is intentionally NOT exposed.
--
-- Auth: SECURITY DEFINER (bypasses block filter). Anon cannot execute — no
-- EXECUTE grant. An authenticated JWT without a sub yields zero rows.
-- REVOKE ALL FROM PUBLIC; GRANT EXECUTE to authenticated and service_role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_blocked_user_profiles()
RETURNS TABLE (
  blocked_id   uuid,
  username     text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    ub.blocked_id,
    p.username,
    p.display_name,
    p.avatar_url,
    ub.created_at
  FROM public.user_blocks ub
  JOIN public.profiles p ON p.id = ub.blocked_id
  WHERE ub.blocker_id = auth.uid()
  ORDER BY ub.created_at DESC;
$$;

ALTER FUNCTION public.get_blocked_user_profiles() OWNER TO postgres;

COMMENT ON FUNCTION public.get_blocked_user_profiles() IS
  'Returns identity fields for all users blocked by the caller. '
  'Bypasses the public_profiles block filter intentionally so the blocker '
  'can recognise and unblock users. Banned users are included (identity only). '
  'Anon cannot execute (no EXECUTE grant); an authenticated JWT without a sub '
  'yields zero rows. '
  'Accepted residual disclosure: the blocker can see the current username, '
  'display_name, and avatar_url of blocked users even if those users are banned '
  'or have blocked them back — accepted so the blocker can recognise whom to unblock. '
  'Never exposes entitlement, billing, moderation, or activity columns.';

REVOKE ALL ON FUNCTION public.get_blocked_user_profiles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_blocked_user_profiles()
  TO authenticated, service_role;

COMMIT;
