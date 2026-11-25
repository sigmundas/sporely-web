-- Keep unfinished profiles out of the public profile projections.
--
-- handle_new_user() seeds every new profile with username = the local part
-- of the sign-up email and display_name = the identity provider's full name
-- (20260614192617). Those values are a prefill for the profile setup screen;
-- the user has not seen or accepted them until the setup save sets
-- profile_completed_at (20260805130000).
--
-- Both public projections returned the seeded row anyway:
--
--   * search_people_directory(integer, integer, text) -- executable by anon
--   * read_public_profiles(), behind the public_profiles view -- selectable
--     by anon
--
-- so a signed-out caller could page through every account that had signed up
-- and never finished setup, and read its email local part and provider name.
--
-- A profile is now public only once its owner has completed setup. The owner
-- still reads their own row through the owner-only profiles table, so the
-- setup screen keeps its prefill. Nothing else about either function changes:
-- signature, return type, search_path, ownership and grants are untouched
-- (CREATE OR REPLACE preserves the ACL), and public_profiles keeps reading
-- read_public_profiles().
--
-- Effect on signed-in users: an account that has not finished setup no longer
-- resolves to a name in friend lists, friend requests, mention search or
-- author lookups, the same way a banned or blocked account already does not.

BEGIN;

CREATE OR REPLACE FUNCTION public.read_public_profiles()
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
    AND p.profile_completed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_blocks ub
      WHERE (ub.blocker_id = auth.uid() AND ub.blocked_id = p.id)
         OR (ub.blocker_id = p.id AND ub.blocked_id = auth.uid())
    )
$$;

CREATE OR REPLACE FUNCTION public.search_people_directory(
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0,
  p_query text DEFAULT NULL::text
)
RETURNS TABLE(
  user_id uuid,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  public_find_count bigint,
  public_species_count bigint,
  public_spore_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH normalized AS (
    SELECT
      nullif(btrim(coalesce(p_query, '')), '') AS q,
      greatest(1, least(coalesce(p_limit, 24), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off
  ),
  visible_profiles AS (
    SELECT
      p.id,
      p.username,
      p.display_name,
      p.bio,
      p.avatar_url
    FROM public.profiles p
    CROSS JOIN normalized n
    WHERE p.is_banned IS NOT TRUE
      AND p.profile_completed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks ub
        WHERE (ub.blocker_id = auth.uid() AND ub.blocked_id = p.id)
           OR (ub.blocker_id = p.id AND ub.blocked_id = auth.uid())
      )
      AND (
        n.q IS NULL
        OR coalesce(p.username, '') ILIKE '%' || n.q || '%'
        OR coalesce(p.display_name, '') ILIKE '%' || n.q || '%'
      )
  ),
  visible_profiles_with_stats AS (
    SELECT
      vp.id,
      vp.username,
      vp.display_name,
      vp.bio,
      vp.avatar_url,
      coalesce(s.public_find_count, 0) AS public_find_count,
      coalesce(s.public_species_count, 0) AS public_species_count,
      coalesce(s.public_spore_count, 0) AS public_spore_count
    FROM visible_profiles vp
    LEFT JOIN LATERAL public.get_person_stats(vp.id) s ON true
  )
  SELECT
    vps.id AS user_id,
    vps.username,
    vps.display_name,
    vps.bio,
    vps.avatar_url,
    vps.public_find_count,
    vps.public_species_count,
    vps.public_spore_count
  FROM visible_profiles_with_stats vps
  CROSS JOIN normalized n
  ORDER BY
    CASE
      WHEN n.q IS NULL THEN 0
      WHEN lower(coalesce(vps.username, '')) = lower(n.q) THEN 0
      WHEN lower(coalesce(vps.display_name, '')) = lower(n.q) THEN 1
      WHEN lower(coalesce(vps.username, '')) LIKE lower(n.q) || '%' THEN 2
      WHEN lower(coalesce(vps.display_name, '')) LIKE lower(n.q) || '%' THEN 3
      ELSE 4
    END,
    CASE WHEN n.q IS NULL THEN vps.public_find_count END DESC,
    CASE WHEN n.q IS NULL THEN coalesce(vps.display_name, vps.username, '') END ASC,
    CASE WHEN n.q IS NOT NULL THEN vps.public_find_count END DESC,
    coalesce(vps.display_name, vps.username, '') ASC,
    vps.id ASC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized);
$$;

COMMENT ON FUNCTION public.read_public_profiles() IS
  'Public profile rows: not banned, not in a block relationship with the caller, and profile setup completed. A trigger-seeded profile (email local part, provider name) is not public until its owner finishes setup.';

COMMENT ON FUNCTION public.search_people_directory(integer, integer, text) IS
  'People directory search over public profiles. Applies the same visibility rules as read_public_profiles(), including profile setup completed.';

NOTIFY pgrst, 'reload schema';

COMMIT;
