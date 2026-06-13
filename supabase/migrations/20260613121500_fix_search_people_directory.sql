DROP FUNCTION IF EXISTS public.search_people_directory(text, integer);
DROP FUNCTION IF EXISTS public.search_people_directory(integer, integer, text);

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

ALTER FUNCTION public.search_people_directory(integer, integer, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_people_directory(integer, integer, text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_people_directory(integer, integer, text) TO anon;
GRANT ALL ON FUNCTION public.search_people_directory(integer, integer, text) TO authenticated;
GRANT ALL ON FUNCTION public.search_people_directory(integer, integer, text) TO service_role;

NOTIFY pgrst, 'reload schema';
