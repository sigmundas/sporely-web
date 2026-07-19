-- Add per-point prep metadata to the sporePoints array returned by
-- get_public_observation, so the observation-page legend can group /
-- colour raw spore points by the source, contrast, mount, stain, or
-- specimen condition of the microscope image they came from.
--
-- The observation-level `prepSummary` (added in
-- 20260716120000_add_prep_summary_to_public_observation.sql) surfaces
-- the DISTINCT set of prep values seen across an observation's
-- measurement-contributing images. That's enough for the sidebar
-- table, but the spore-measurement plot needs to distinguish points
-- from different microscope sessions when the observation crosses
-- multiple prep conditions (e.g. measurements taken from both a spore
-- print and a hymenium, or under BF and DIC in the same session).
--
-- The five per-point fields — contrastMethod, mountReagent,
-- stainReagent, sampleType, sampleSource — carry the same values and
-- canonical form as the scalar observation-level fields on the RPC.
-- Not_set / unknown / unset variants are filtered here (server-side)
-- so the client never has to defend against them for legend copy.
-- Rows whose image has no known value for a field emit no key for it
-- via `jsonb_strip_nulls`, keeping the payload small when a lot of
-- images are unlabelled.

DROP FUNCTION IF EXISTS public.get_public_observation(bigint);

CREATE FUNCTION public.get_public_observation(
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
          THEN jsonb_build_object(
            'url',      concat('https://media.sporely.no/', latest_mosaic.storage_key),
            'width',    latest_mosaic.width_px,
            'height',   latest_mosaic.height_px,
            'tileSize', latest_mosaic.tile_size_px,
            'version',  latest_mosaic.version
          )
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
        sm.version
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
            -- from the object, keeping the payload small.
            'contrastMethod', CASE
                                WHEN nullif(btrim(coalesce(i.contrast, '')), '') IS NULL
                                     OR lower(btrim(i.contrast)) IN ('not_set', 'not set', 'unset', 'unknown')
                                  THEN NULL
                                ELSE btrim(i.contrast)
                              END,
            'mountReagent',   CASE
                                WHEN nullif(btrim(coalesce(i.mount_medium, '')), '') IS NULL
                                     OR lower(btrim(i.mount_medium)) IN ('not_set', 'not set', 'unset', 'unknown')
                                  THEN NULL
                                ELSE btrim(i.mount_medium)
                              END,
            'stainReagent',   CASE
                                WHEN nullif(btrim(coalesce(i.stain, '')), '') IS NULL
                                     OR lower(btrim(i.stain)) IN ('not_set', 'not set', 'unset', 'unknown')
                                  THEN NULL
                                ELSE btrim(i.stain)
                              END,
            'sampleType',     CASE
                                WHEN lower(btrim(coalesce(i.sample_type, ''))) IN ('fresh', 'dried')
                                  THEN lower(btrim(i.sample_type))
                                ELSE NULL
                              END,
            'sampleSource',   CASE
                                WHEN lower(btrim(coalesce(i.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
                                  THEN lower(btrim(i.sample_source))
                                ELSE NULL
                              END
          )
        )
        || CASE
             WHEN t.measurement_id IS NOT NULL
               THEN jsonb_build_object(
                 'mosaicX', t.x_px,
                 'mosaicY', t.y_px,
                 'mosaicW', t.w_px,
                 'mosaicH', t.h_px
               )
               || CASE
                    WHEN t.overlay_json IS NOT NULL
                      THEN jsonb_build_object('overlay', t.overlay_json)
                    ELSE '{}'::jsonb
                  END
             ELSE '{}'::jsonb
           END
        ORDER BY m.id
      ) AS spore_points
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      LEFT JOIN public.spore_measurement_mosaic_tiles t
        ON t.measurement_id = m.id
       AND t.mosaic_id = latest_mosaic.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR i.image_type = 'microscope'::text)
        AND m.length_um IS NOT NULL
        AND m.width_um IS NOT NULL
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

-- PostgREST caches the function signature; ping it so the new sporePoints
-- shape (per-point prep fields) is visible to the anon/authenticated
-- clients as soon as the migration lands, without waiting for the next
-- cache-refresh cycle.
NOTIFY pgrst, 'reload schema';
