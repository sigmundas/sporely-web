-- Public species distribution summary RPC.
--
-- Returns a single-row aggregate for a given species slug covering:
--   - Coverage metrics (observationCount, microscopyObservationCount,
--     sporeMeasurementCount, firstObservedOn, lastObservedOn)
--   - Preparation facets (sampleTypeFacets, mountReagentFacets,
--     contrastMethodFacets) from the LATEST microscope image per observation
--     across ALL species observations (unfiltered).
--   - Privacy-safe map points from FILTERED observations (up to 1000).
--   - Month distribution counts from FILTERED observations.
--
-- Visibility gates:
--   Only public, non-draft, non-banned-user observations are considered.
--   Blocked-user gate applied when the caller is authenticated.
--   Spore data only counted when spore_data_visibility = 'public'.
--
-- Preparation filters (p_sample_type, p_mount_reagent, p_contrast_method)
--   are applied via EXISTS subqueries so an observation qualifies when ANY of
--   its microscope images matches the requested prep type.
--
-- Returns 0 rows when p_species_slug is null/empty or no matching observations
-- exist.

CREATE OR REPLACE FUNCTION public.get_public_species_distribution_summary(
  p_species_slug    text,
  p_country         text    DEFAULT NULL,
  p_region_id       text    DEFAULT NULL,
  p_date_from       date    DEFAULT NULL,
  p_date_to         date    DEFAULT NULL,
  p_sample_type     text    DEFAULT NULL,
  p_mount_reagent   text    DEFAULT NULL,
  p_contrast_method text    DEFAULT NULL,
  p_has_microscopy  boolean DEFAULT NULL,
  p_has_spores      boolean DEFAULT NULL
)
RETURNS TABLE(
  "observationCount"           bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount"      bigint,
  "firstObservedOn"            date,
  "lastObservedOn"             date,
  "sampleTypeFacets"           jsonb,
  "mountReagentFacets"         jsonb,
  "contrastMethodFacets"       jsonb,
  "mapPoints"                  jsonb,
  "monthCounts"                jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH norm AS (
    SELECT
      -- Normalize species slug: lower, strip non-alnum to hyphens, strip
      -- leading/trailing hyphens. Same logic as all other species RPCs.
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p_species_slug, ''))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS slug,
      nullif(btrim(upper(coalesce(p_country,       ''))), '') AS country,
      nullif(btrim(coalesce(p_region_id,           '')),  '') AS region_id,
      p_date_from                                             AS date_from,
      p_date_to                                               AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type,     ''))), '') AS sample_type,
      nullif(btrim(lower(coalesce(p_mount_reagent,   ''))), '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method,
      p_has_microscopy                                        AS has_microscopy,
      p_has_spores                                            AS has_spores
  ),

  -- All public, non-draft, non-banned-user observations for this species.
  -- No geographic or preparation filters — this is the full set used for
  -- facets and to gate the whole RPC (returns 0 rows if empty).
  all_obs AS (
    SELECT
      o.id,
      o.date                                                    AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), ''))    AS country_code,
      nullif(btrim(coalesce(o.region_id,           '')), '')    AS region_id,
      coalesce(o.location_precision, 'hidden')                  AS location_precision,
      o.gps_latitude,
      o.gps_longitude,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
      AND n.slug IS NOT NULL
      -- Species slug match.
      AND nullif(
            regexp_replace(
              regexp_replace(
                lower(btrim(concat_ws(' ',
                  nullif(btrim(coalesce(o.genus,   '')), ''),
                  nullif(btrim(coalesce(o.species, '')), '')
                ))),
                '[^a-z0-9]+', '-', 'g'
              ),
              '(^-|-$)', '', 'g'
            ),
            ''
          ) = n.slug
  ),

  -- all_obs joined with their latest microscope image for facet computation.
  -- Facets are always from the unfiltered all_obs set.
  all_obs_with_latest_image AS (
    SELECT
      ao.id,
      nullif(lower(btrim(coalesce(latest_img.sample_type,  ''))), '') AS sample_type,
      nullif(lower(btrim(coalesce(latest_img.mount_medium, ''))), '') AS mount_reagent,
      latest_img.contrast                                              AS contrast_method
    FROM all_obs ao
    LEFT JOIN LATERAL (
      SELECT
        i.sample_type,
        i.mount_medium,
        i.contrast
      FROM public.observation_images i
      WHERE i.observation_id = ao.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_img ON true
  ),

  -- Filtered observations: apply all input parameters to all_obs.
  filtered_obs AS (
    SELECT
      ao.id,
      ao.observed_on,
      ao.location_precision,
      ao.gps_latitude,
      ao.gps_longitude,
      ao.spore_data_visibility
    FROM all_obs ao
    CROSS JOIN norm n
    -- Geographic and date filters.
    WHERE (n.country    IS NULL OR ao.country_code = n.country)
      AND (n.region_id  IS NULL OR ao.region_id    = n.region_id)
      AND (n.date_from  IS NULL OR ao.observed_on >= n.date_from)
      AND (n.date_to    IS NULL OR ao.observed_on <= n.date_to)
      -- Preparation filters via EXISTS (any matching image, not just latest).
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.sample_type, '')) = n.sample_type
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = ao.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND i3.image_type = 'microscope'
      ))
      -- p_has_spores = true: spore_data_visibility must be public AND have
      -- at least one qualifying spore measurement.
      AND (n.has_spores IS NOT TRUE OR (
        ao.spore_data_visibility = 'public'
        AND EXISTS (
          SELECT 1
          FROM public.observation_images i4
          JOIN public.spore_measurements m ON m.image_id = i4.id
          WHERE i4.observation_id = ao.id
            AND i4.deleted_at IS NULL AND i4.purged_at IS NULL
            AND i4.image_type = 'microscope'
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
        )
      ))
  ),

  -- Per-observation enriched filtered set: microscopy flag and spore count
  -- computed once for reuse in coverage metrics and map points.
  filtered_obs_enriched AS (
    SELECT
      fo.id,
      fo.observed_on,
      fo.location_precision,
      fo.gps_latitude,
      fo.gps_longitude,
      -- Microscopy presence: any non-deleted/purged microscope image.
      (EXISTS (
        SELECT 1 FROM public.observation_images i
        WHERE i.observation_id = fo.id
          AND i.deleted_at IS NULL AND i.purged_at IS NULL
          AND i.image_type = 'microscope'
      )) AS has_microscopy,
      -- Spore measurement count (public only).
      CASE
        WHEN fo.spore_data_visibility = 'public' THEN (
          SELECT count(m.id)::bigint
          FROM public.observation_images i
          JOIN public.spore_measurements m ON m.image_id = i.id
          WHERE i.observation_id = fo.id
            AND i.deleted_at IS NULL AND i.purged_at IS NULL
            AND i.image_type = 'microscope'
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
        )
        ELSE 0::bigint
      END AS spore_measurement_count
    FROM filtered_obs fo
  ),

  -- Coverage aggregate over all filtered enriched observations.
  coverage AS (
    SELECT
      count(foe.id)::bigint                                 AS observation_count,
      count(*) FILTER (WHERE foe.has_microscopy)::bigint    AS microscopy_observation_count,
      coalesce(sum(foe.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(foe.observed_on)                                  AS first_observed_on,
      max(foe.observed_on)                                  AS last_observed_on
    FROM filtered_obs_enriched foe
  ),

  -- sampleTypeFacets: from all_obs, latest image, lower-cased, non-null.
  sample_type_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', st_grp.sample_type, 'count', st_grp.cnt)
        ORDER BY st_grp.cnt DESC, st_grp.sample_type ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT awi.sample_type, count(*)::bigint AS cnt
      FROM all_obs_with_latest_image awi
      WHERE awi.sample_type IS NOT NULL
      GROUP BY awi.sample_type
    ) st_grp
  ),

  -- mountReagentFacets: from all_obs, latest image, lower-cased, non-null.
  mount_reagent_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', mr_grp.mount_reagent, 'count', mr_grp.cnt)
        ORDER BY mr_grp.cnt DESC, mr_grp.mount_reagent ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT awi.mount_reagent, count(*)::bigint AS cnt
      FROM all_obs_with_latest_image awi
      WHERE awi.mount_reagent IS NOT NULL
      GROUP BY awi.mount_reagent
    ) mr_grp
  ),

  -- contrastMethodFacets: from all_obs, latest image, non-null.
  contrast_method_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', cm_grp.contrast_method, 'count', cm_grp.cnt)
        ORDER BY cm_grp.cnt DESC, cm_grp.contrast_method ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT awi.contrast_method, count(*)::bigint AS cnt
      FROM all_obs_with_latest_image awi
      WHERE awi.contrast_method IS NOT NULL
      GROUP BY awi.contrast_method
    ) cm_grp
  ),

  -- mapPoints: privacy-safe coordinates from filtered_obs. LIMIT 1000.
  map_points AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'observationId',     pt.id,
          'mapLat',            pt.map_lat,
          'mapLon',            pt.map_lon,
          'locationPrecision', pt.location_precision,
          'observedOn',        pt.observed_on,
          'hasMicroscopy',     pt.has_microscopy
        )
        ORDER BY pt.observed_on DESC, pt.id DESC
      ),
      '[]'::jsonb
    ) AS points
    FROM (
      SELECT
        foe.id,
        foe.observed_on,
        foe.location_precision,
        foe.has_microscopy,
        CASE
          WHEN foe.location_precision = 'exact'  THEN foe.gps_latitude
          WHEN foe.location_precision = 'fuzzed' THEN round(foe.gps_latitude::numeric, 2)::double precision
          ELSE NULL::double precision
        END AS map_lat,
        CASE
          WHEN foe.location_precision = 'exact'  THEN foe.gps_longitude
          WHEN foe.location_precision = 'fuzzed' THEN round(foe.gps_longitude::numeric, 2)::double precision
          ELSE NULL::double precision
        END AS map_lon
      FROM filtered_obs_enriched foe
      WHERE foe.gps_latitude IS NOT NULL
      ORDER BY foe.observed_on DESC, foe.id DESC
      LIMIT 1000
    ) pt
  ),

  -- monthCounts: calendar month distribution from filtered_obs. Only months
  -- with count > 0.
  month_counts AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('month', mc.month, 'count', mc.cnt)
        ORDER BY mc.month ASC
      ),
      '[]'::jsonb
    ) AS counts
    FROM (
      SELECT
        EXTRACT(MONTH FROM foe.observed_on)::int AS month,
        count(*)::bigint                         AS cnt
      FROM filtered_obs_enriched foe
      GROUP BY EXTRACT(MONTH FROM foe.observed_on)::int
      HAVING count(*) > 0
    ) mc
  )

  SELECT
    c.observation_count           AS "observationCount",
    c.microscopy_observation_count AS "microscopyObservationCount",
    c.spore_measurement_count     AS "sporeMeasurementCount",
    c.first_observed_on           AS "firstObservedOn",
    c.last_observed_on            AS "lastObservedOn",
    (SELECT facets FROM sample_type_facets)    AS "sampleTypeFacets",
    (SELECT facets FROM mount_reagent_facets)  AS "mountReagentFacets",
    (SELECT facets FROM contrast_method_facets) AS "contrastMethodFacets",
    (SELECT points FROM map_points)            AS "mapPoints",
    (SELECT counts FROM month_counts)          AS "monthCounts"
  FROM coverage c
  -- Return 0 rows when slug is null/empty or no all_obs exist.
  WHERE EXISTS (SELECT 1 FROM all_obs)
$$;

ALTER FUNCTION public.get_public_species_distribution_summary(
  text, text, text, date, date, text, text, text, boolean, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_species_distribution_summary(
  text, text, text, date, date, text, text, text, boolean, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_species_distribution_summary(
  text, text, text, date, date, text, text, text, boolean, boolean
) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_species_distribution_summary(
  text, text, text, date, date, text, text, text, boolean, boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_species_distribution_summary(
  text, text, text, date, date, text, text, text, boolean, boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';
