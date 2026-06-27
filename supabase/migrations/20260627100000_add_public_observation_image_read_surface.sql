-- Public-safe observation image read surface for anonymous public browsing.
--
-- Exposes only safe image metadata and public CDN URLs for public, non-draft
-- observations. Deleted or purged images are excluded. The public media model
-- currently uses a single thumbnail derivative for both card and preview use
-- cases, so previewUrl intentionally aliases thumbUrl.

CREATE OR REPLACE FUNCTION public.search_public_observation_images(
  p_observation_ids bigint[] DEFAULT NULL::bigint[]
)
RETURNS TABLE(
  "observationId" bigint,
  "imageId" bigint,
  "sortOrder" integer,
  "imageType" text,
  "width" integer,
  "height" integer,
  "thumbUrl" text,
  "previewUrl" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH visible_observations AS (
    SELECT
      o.id,
      o.user_id
    FROM public.observations o
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND o.id = ANY (coalesce(p_observation_ids, '{}'::bigint[]))
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  visible_images AS (
    SELECT
      o.id AS observation_id,
      i.id AS image_id,
      i.sort_order,
      i.image_type,
      coalesce(i.stored_width, i.source_width) AS width,
      coalesce(i.stored_height, i.source_height) AS height,
      nullif(
        regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
        btrim(i.storage_path, '/')
      ) AS storage_dir,
      regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
      i.created_at
    FROM visible_observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
    WHERE i.deleted_at IS NULL
      AND i.purged_at IS NULL
  ),
  prepared AS (
    SELECT
      vi.observation_id,
      vi.image_id,
      vi.sort_order,
      vi.image_type,
      vi.width,
      vi.height,
      vi.created_at,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        'thumb_',
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS thumb_path
    FROM visible_images vi
  )
  SELECT
    p.observation_id AS "observationId",
    p.image_id AS "imageId",
    p.sort_order AS "sortOrder",
    p.image_type AS "imageType",
    p.width AS "width",
    p.height AS "height",
    concat('https://media.sporely.no/', p.thumb_path) AS "thumbUrl",
    concat('https://media.sporely.no/', p.thumb_path) AS "previewUrl"
  FROM prepared p
  ORDER BY p.observation_id, p.sort_order NULLS LAST, p.created_at DESC NULLS LAST, p.image_id DESC
$$;

ALTER FUNCTION public.search_public_observation_images(bigint[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_public_observation_images(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO anon;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO service_role;

CREATE OR REPLACE FUNCTION public.get_public_observation_images(
  p_observation_id bigint
)
RETURNS TABLE(
  "observationId" bigint,
  "imageId" bigint,
  "sortOrder" integer,
  "imageType" text,
  "width" integer,
  "height" integer,
  "thumbUrl" text,
  "previewUrl" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT *
  FROM public.search_public_observation_images(ARRAY[p_observation_id])
$$;

ALTER FUNCTION public.get_public_observation_images(bigint) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_observation_images(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_observation_images(bigint) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_observation_images(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_observation_images(bigint) TO service_role;

NOTIFY pgrst, 'reload schema';
