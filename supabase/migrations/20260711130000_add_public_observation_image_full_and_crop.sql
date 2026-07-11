-- Expose the original (full-size) image URL and AI crop metadata on the
-- public observation image RPCs. The landing site uses this to display a
-- lightbox with full-size images and to render the observation preview
-- constrained to the AI crop region.
--
-- Both functions gain new output columns, which changes their return
-- type. CREATE OR REPLACE FUNCTION cannot alter an existing function's
-- return type, so drop the wrapper first (it depends on the underlying
-- search function) and then the search function before recreating both.

DROP FUNCTION IF EXISTS public.get_public_observation_images(bigint);
DROP FUNCTION IF EXISTS public.search_public_observation_images(bigint[]);

ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS storage_exif_safe boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.observation_images.storage_exif_safe IS
  'True only when observation_images.storage_path is known to be public-safe / EXIF-GPS stripped. Public fullUrl exposure must be gated on this.';

-- Conservative backfill: only rows that already carry the stored upload
-- dimensions/byte count from the safe re-encode path are marked true.
-- Unknown or legacy rows remain false.
UPDATE public.observation_images
SET storage_exif_safe = true
WHERE storage_path IS NOT NULL
  AND stored_width IS NOT NULL
  AND stored_height IS NOT NULL
  AND stored_bytes IS NOT NULL
  AND upload_mode IS NOT NULL;

CREATE FUNCTION public.search_public_observation_images(
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
  "previewUrl" text,
  "fullUrl" text,
  "aiCropX1" double precision,
  "aiCropY1" double precision,
  "aiCropX2" double precision,
  "aiCropY2" double precision,
  "aiCropSourceW" integer,
  "aiCropSourceH" integer,
  "aiCropIsCustom" boolean
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
      i.ai_crop_x1,
      i.ai_crop_y1,
      i.ai_crop_x2,
      i.ai_crop_y2,
      i.ai_crop_source_w,
      i.ai_crop_source_h,
      coalesce(i.ai_crop_is_custom, false) AS ai_crop_is_custom,
      coalesce(i.storage_exif_safe, false) AS storage_exif_safe,
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
      vi.ai_crop_x1,
      vi.ai_crop_y1,
      vi.ai_crop_x2,
      vi.ai_crop_y2,
      vi.ai_crop_source_w,
      vi.ai_crop_source_h,
      vi.ai_crop_is_custom,
      vi.storage_exif_safe,
      vi.created_at,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        'thumb_',
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS thumb_path,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS full_path
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
    concat('https://media.sporely.no/', p.thumb_path) AS "previewUrl",
    CASE
      WHEN p.storage_exif_safe
        THEN concat('https://media.sporely.no/', p.full_path)
      ELSE NULL
    END AS "fullUrl",
    p.ai_crop_x1 AS "aiCropX1",
    p.ai_crop_y1 AS "aiCropY1",
    p.ai_crop_x2 AS "aiCropX2",
    p.ai_crop_y2 AS "aiCropY2",
    p.ai_crop_source_w AS "aiCropSourceW",
    p.ai_crop_source_h AS "aiCropSourceH",
    p.ai_crop_is_custom AS "aiCropIsCustom"
  FROM prepared p
  ORDER BY p.observation_id, p.sort_order NULLS LAST, p.created_at DESC NULLS LAST, p.image_id DESC
$$;

ALTER FUNCTION public.search_public_observation_images(bigint[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_public_observation_images(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO anon;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO service_role;

CREATE FUNCTION public.get_public_observation_images(
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
  "previewUrl" text,
  "fullUrl" text,
  "aiCropX1" double precision,
  "aiCropY1" double precision,
  "aiCropX2" double precision,
  "aiCropY2" double precision,
  "aiCropSourceW" integer,
  "aiCropSourceH" integer,
  "aiCropIsCustom" boolean
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
