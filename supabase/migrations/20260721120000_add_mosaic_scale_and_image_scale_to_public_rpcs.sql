-- Expose scale/geometry needed to render scale-bar overlays on the
-- public site.
--
-- Two related contract additions:
--
-- 1) spore_measurement_mosaics gains four nullable columns carrying the
--    common-crop µm dims and per-tile pixel dims that the desktop
--    pipeline already computes. Old rows stay NULL until the desktop
--    re-syncs them; the RPC surface treats absence as "no scale bar",
--    not a hard failure. The four values are:
--
--      * tile_width_px, tile_height_px   — actual per-tile atlas pixel
--        dims. Tiles are rectangular in general (common-crop model);
--        the existing tile_size_px column is a legacy square-cell
--        integer and MUST NOT be read as tile w/h.
--      * common_crop_width_um, common_crop_height_um — physical size
--        of a single tile's oriented crop, uniform across the atlas.
--        Landing derives µm-per-source-pixel as
--        common_crop_width_um / tile_width_px.
--
-- 2) search_public_observation_images / get_public_observation_images
--    now emit scaleMicronsPerPixel (source-image µm per pixel).
--    observation_images.scale_microns_per_pixel is already synced
--    from the desktop app; only the RPC surface needs to expose it.
--    Field images typically NULL; microscope images typically set.
--
-- 3) get_public_observation's sporeMosaic jsonb sub-object gains
--    tileWidthPx / tileHeightPx / commonCropWidthUm / commonCropHeightUm.
--    RETURNS TABLE is unchanged (sporeMosaic stays jsonb), so
--    CREATE OR REPLACE FUNCTION suffices here — no drop needed.
--
-- The image RPCs DO change RETURN TABLE (new column), so both must be
-- dropped in wrapper-then-search order and recreated. Search body is
-- copied verbatim from 20260714130000, adding one column.

-- ── 1. spore_measurement_mosaics columns ─────────────────────────────

ALTER TABLE public.spore_measurement_mosaics
  ADD COLUMN IF NOT EXISTS tile_width_px integer,
  ADD COLUMN IF NOT EXISTS tile_height_px integer,
  ADD COLUMN IF NOT EXISTS common_crop_width_um double precision,
  ADD COLUMN IF NOT EXISTS common_crop_height_um double precision;

COMMENT ON COLUMN public.spore_measurement_mosaics.tile_width_px IS
  'Per-tile atlas pixel width. Tiles are rectangular under the common-crop model; tile_size_px is a legacy square-cell integer and must not be read as tile w/h.';
COMMENT ON COLUMN public.spore_measurement_mosaics.tile_height_px IS
  'Per-tile atlas pixel height. Tiles are rectangular under the common-crop model.';
COMMENT ON COLUMN public.spore_measurement_mosaics.common_crop_width_um IS
  'Physical width in µm of a single tile''s oriented crop. Uniform across the atlas — landing derives µm per source pixel as common_crop_width_um / tile_width_px.';
COMMENT ON COLUMN public.spore_measurement_mosaics.common_crop_height_um IS
  'Physical height in µm of a single tile''s oriented crop. Uniform across the atlas.';

-- ── 2. Image RPCs — search + wrapper ─────────────────────────────────

DROP FUNCTION IF EXISTS public.get_public_observation_images(bigint);
DROP FUNCTION IF EXISTS public.search_public_observation_images(bigint[]);

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
  "aiCropIsCustom" boolean,
  "scaleMicronsPerPixel" double precision
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
      i.scale_microns_per_pixel,
      i.created_at
    FROM visible_observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
    WHERE i.deleted_at IS NULL
      AND i.purged_at IS NULL
      -- Metadata-only microscope anchors have no downloadable bytes and
      -- must not appear in the public gallery. Preserved verbatim from
      -- migration 20260714130000.
      AND i.storage_path IS NOT NULL
      AND btrim(i.storage_path) <> ''
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
      vi.scale_microns_per_pixel,
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
    p.ai_crop_is_custom AS "aiCropIsCustom",
    p.scale_microns_per_pixel AS "scaleMicronsPerPixel"
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
  "aiCropIsCustom" boolean,
  "scaleMicronsPerPixel" double precision
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

-- ── 3. get_public_observation — sporeMosaic sub-object extension ─────
-- RETURNS TABLE is unchanged (sporeMosaic stays jsonb); reproducing the
-- full body preserves the current behaviour from 20260716140000 and
-- adds four new keys plus four new columns to the latest_mosaic CTE.

CREATE OR REPLACE FUNCTION public.get_public_observation(
  p_observation_id bigint
)
RETURNS TABLE(
  id bigint,
  "speciesSlug" text,
  "speciesName" text,
  "speciesCommonName" text,
  "observerDisplayName" text,
  "observedOn" date,
  country text,
  "regionId" text,
  "locationPrecision" text,
  "locationLabel" text,
  "hasMicroscopy" boolean,
  "sporeMeasurementCount" bigint,
  "sporeSummary" jsonb,
  "sporePoints" jsonb,
  "sporeMosaic" jsonb,
  "contrastMethod" text,
  "mountReagent" text,
  "sampleType" text,
  "sampleSource" text,
  "prepSummary" jsonb,
  "mapLat" double precision,
  "mapLon" double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH candidate_base AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.user_id,
      o.author,
      o.date AS observed_on,
      nullif(btrim(coalesce(o.country_code, '')), '') AS country,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      public.community_contributor_label(o.user_id, o.author) AS observer_display_name
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    WHERE o.id = p_observation_id
      AND o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
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
  enriched AS (
    SELECT
      c.*,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      latest_image.sample_type AS sample_type,
      latest_image.sample_source AS sample_source,
      (latest_image.id IS NOT NULL) AS has_microscopy,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN point_agg.spore_points
        ELSE NULL::jsonb
      END AS spore_points,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
             AND latest_mosaic.id IS NOT NULL
          THEN jsonb_strip_nulls(jsonb_build_object(
            'url',                concat('https://media.sporely.no/', latest_mosaic.storage_key),
            'width',              latest_mosaic.width_px,
            'height',             latest_mosaic.height_px,
            'tileSize',           latest_mosaic.tile_size_px,
            'version',            latest_mosaic.version,
            'tileWidthPx',        latest_mosaic.tile_width_px,
            'tileHeightPx',       latest_mosaic.tile_height_px,
            'commonCropWidthUm',  latest_mosaic.common_crop_width_um,
            'commonCropHeightUm', latest_mosaic.common_crop_height_um
          ))
        ELSE NULL::jsonb
      END AS spore_mosaic,
      prep_agg.prep_summary,
      CASE
        WHEN c.location_precision = 'exact'::text
          THEN o.gps_latitude
        WHEN c.location_precision = 'fuzzed'::text
          THEN round(o.gps_latitude::numeric, 2)::double precision
        ELSE NULL::double precision
      END AS map_lat,
      CASE
        WHEN c.location_precision = 'exact'::text
          THEN o.gps_longitude
        WHEN c.location_precision = 'fuzzed'::text
          THEN round(o.gps_longitude::numeric, 2)::double precision
        ELSE NULL::double precision
      END AS map_lon
    FROM candidate_base c
    JOIN public.observations o
      ON o.id = c.id
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (
          i.image_type = 'microscope'::text
          OR (
            i.image_type IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.spore_measurements m2
              WHERE m2.image_id = i.id
                AND (
                  m2.measurement_type IS NULL
                  OR m2.measurement_type = ''
                  OR lower(m2.measurement_type) IN ('manual', 'spore', 'spores')
                )
            )
          )
        )
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_image ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR i.image_type = 'microscope'::text)
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        sm.id,
        sm.storage_key,
        sm.width_px,
        sm.height_px,
        sm.tile_size_px,
        sm.version,
        sm.tile_width_px,
        sm.tile_height_px,
        sm.common_crop_width_um,
        sm.common_crop_height_um
      FROM public.spore_measurement_mosaics sm
      WHERE sm.observation_id = c.id
        AND sm.user_id = c.user_id
      ORDER BY sm.version DESC, sm.id DESC
      LIMIT 1
    ) latest_mosaic ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'id',             m.id::text,
            'observationId',  c.id::text,
            'imageId',        i.id::text,
            'lengthUm',       m.length_um,
            'widthUm',        m.width_um,
            'q',              round((m.length_um / nullif(m.width_um, 0))::numeric, 4)::double precision,
            'cropUrl',        CASE
                                WHEN m.thumb_key IS NOT NULL
                                  THEN concat('https://media.sporely.no/', m.thumb_key)
                                ELSE NULL
                              END,
            -- Per-point prep metadata. Same normalization as the scalar
            -- observation-level fields (see the SELECT list below): unset
            -- variants collapse to NULL and jsonb_strip_nulls removes them
            -- from the object before it lands in the aggregate.
            'contrastMethod', nullif(btrim(coalesce(i.contrast, '')), ''),
            'mountReagent',   nullif(btrim(coalesce(i.mount_medium, '')), ''),
            'stainReagent',   nullif(btrim(coalesce(i.stain, '')), ''),
            'sampleType',     CASE
                                WHEN lower(btrim(coalesce(i.sample_type, ''))) IN ('fresh', 'dried')
                                  THEN lower(btrim(i.sample_type))
                                ELSE NULL::text
                              END,
            'sampleSource',   CASE
                                WHEN lower(btrim(coalesce(i.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
                                  THEN lower(btrim(i.sample_source))
                                ELSE NULL::text
                              END,
            'mosaicX',        t.x_px,
            'mosaicY',        t.y_px,
            'mosaicW',        t.w_px,
            'mosaicH',        t.h_px,
            'overlay',        t.overlay_json
          )
        )
      ) AS spore_points
      FROM public.spore_measurements m
      JOIN public.observation_images i
        ON i.id = m.image_id
      LEFT JOIN public.spore_measurement_mosaic_tiles t
        ON t.measurement_id = m.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR i.image_type = 'microscope'::text)
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) point_agg ON true
    LEFT JOIN LATERAL (
      WITH contributors AS (
        SELECT DISTINCT
          i.id AS image_id,
          nullif(btrim(coalesce(i.contrast, '')), '') AS contrast,
          nullif(btrim(coalesce(i.mount_medium, '')), '') AS mount_medium,
          nullif(btrim(coalesce(i.stain, '')), '') AS stain,
          nullif(btrim(coalesce(i.sample_type, '')), '') AS sample_type,
          nullif(btrim(coalesce(i.sample_source, '')), '') AS sample_source
        FROM public.observation_images i
        WHERE i.observation_id = c.id
          AND i.deleted_at IS NULL
          AND i.purged_at IS NULL
          AND (i.image_type IS NULL OR i.image_type = 'microscope'::text)
          AND EXISTS (
            SELECT 1
            FROM public.spore_measurements m3
            WHERE m3.image_id = i.id
              AND (
                m3.measurement_type IS NULL
                OR m3.measurement_type = ''
                OR lower(m3.measurement_type) IN ('manual', 'spore', 'spores')
              )
          )
      )
      SELECT jsonb_build_object(
        'contrasts',          coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT contrast AS v
            FROM contributors
            WHERE contrast IS NOT NULL
              AND lower(contrast) NOT IN ('not_set', 'not set', 'unset', 'unknown')
          ) s
        ), '[]'::jsonb),
        'mounts',             coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT mount_medium AS v
            FROM contributors
            WHERE mount_medium IS NOT NULL
              AND lower(mount_medium) NOT IN ('not_set', 'not set', 'unset', 'unknown')
          ) s
        ), '[]'::jsonb),
        'stains',             coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT stain AS v
            FROM contributors
            WHERE stain IS NOT NULL
              AND lower(stain) NOT IN ('not_set', 'not set', 'unset', 'unknown')
          ) s
        ), '[]'::jsonb),
        'specimenConditions', coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT lower(sample_type) AS v
            FROM contributors
            WHERE sample_type IS NOT NULL
              AND lower(sample_type) IN ('fresh', 'dried')
          ) s
        ), '[]'::jsonb),
        'sampleSources',      coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT lower(sample_source) AS v
            FROM contributors
            WHERE sample_source IS NOT NULL
              AND lower(sample_source) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
          ) s
        ), '[]'::jsonb)
      ) AS prep_summary
    ) prep_agg ON true
  )
  SELECT
    e.id AS id,
    nullif(
      regexp_replace(
        regexp_replace(lower(btrim(concat_ws(' ', e.genus, e.species))), '[^a-z0-9]+', '-', 'g'),
        '(^-|-$)',
        '',
        'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', e.genus, e.species)), '') AS "speciesName",
    e.common_name AS "speciesCommonName",
    e.observer_display_name AS "observerDisplayName",
    e.observed_on AS "observedOn",
    e.country AS country,
    e.region_id AS "regionId",
    e.location_precision AS "locationPrecision",
    CASE
      WHEN e.location_precision = 'exact'::text THEN e.location
      WHEN e.location_precision = 'fuzzed'::text THEN coalesce(e.region_label, e.country)
      WHEN e.location_precision = 'region'::text THEN e.region_label
      ELSE NULL::text
    END AS "locationLabel",
    e.has_microscopy AS "hasMicroscopy",
    e.spore_measurement_count AS "sporeMeasurementCount",
    e.spore_summary AS "sporeSummary",
    e.spore_points AS "sporePoints",
    e.spore_mosaic AS "sporeMosaic",
    e.contrast_method AS "contrastMethod",
    e.mount_reagent AS "mountReagent",
    CASE
      WHEN lower(btrim(coalesce(e.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(e.sample_type))
      ELSE NULL::text
    END AS "sampleType",
    CASE
      WHEN lower(btrim(coalesce(e.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
        THEN lower(btrim(e.sample_source))
      ELSE NULL::text
    END AS "sampleSource",
    e.prep_summary AS "prepSummary",
    e.map_lat AS "mapLat",
    e.map_lon AS "mapLon"
  FROM enriched e
  LIMIT 1
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_observation(bigint) TO anon, authenticated;

-- PostgREST caches signatures; refresh so the new image RPC column and
-- new sporeMosaic sub-keys are visible to anon/authenticated clients
-- without waiting for the next cache-refresh cycle.
NOTIFY pgrst, 'reload schema';
