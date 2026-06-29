-- Fix semantic bugs in get_public_species_distribution_summary.
--
-- Bug 1 — Facets used only the latest microscopy image per observation.
--   An observation with both 'fresh' and 'spore_print' images would only
--   contribute to the facet bucket for whichever image was latest.
--   Fix: derive facets from ALL microscopy images; count DISTINCT observations
--   per prep value so each observation is counted once per value.
--
-- Bug 2 — sporeMeasurementCount counted ALL measurements from matching
--   observations, not only those linked to prep-matching images.
--   When filtering by p_sample_type='fresh', measurements from the same
--   observation's spore_print images were included.
--   Fix: add CROSS JOIN norm n to filtered_obs_enriched and apply the
--   same image-level prep conditions to the spore count subquery.
--
-- Map/month counts remain at observation-level via the EXISTS filter (an
-- observation appears if it has ANY matching-prep image). This is documented
-- and intentional: the workspace counts observations that used a preparation,
-- not individual measurement sessions.

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
  -- No geographic or preparation filters — full set for facets and the
  -- existence gate (returns 0 rows when empty).
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

  -- Filtered observations: apply all input parameters to all_obs.
  -- Preparation filters use EXISTS so an observation qualifies when ANY
  -- of its microscope images matches (observation-level granularity for
  -- map/month counts).
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
      -- p_has_spores = true: public spore_data_visibility + at least one qualifying measurement.
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

  -- Per-observation enriched filtered set: microscopy flag and prep-filtered
  -- spore count.
  --
  -- FIX (Bug 2): CROSS JOIN norm n brings prep filter values into scope.
  -- The spore_measurement_count subquery now applies the same image-level prep
  -- conditions so only measurements from matching-preparation images are
  -- counted.  Map/month counts still use observation-level EXISTS (above).
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
      -- Spore measurement count (public only, prep-filtered).
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
            -- Image-level prep filters (same conditions as filtered_obs EXISTS).
            AND (n.sample_type     IS NULL OR lower(coalesce(i.sample_type,  '')) = n.sample_type)
            AND (n.mount_reagent   IS NULL OR lower(coalesce(i.mount_medium, '')) = n.mount_reagent)
            AND (n.contrast_method IS NULL OR lower(coalesce(i.contrast,     '')) = n.contrast_method)
        )
        ELSE 0::bigint
      END AS spore_measurement_count
    FROM filtered_obs fo
    CROSS JOIN norm n   -- needed to reference n.sample_type etc. inside subquery
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

  -- sampleTypeFacets: FIX (Bug 1): join ALL microscopy images (not latest only).
  -- Count DISTINCT observation IDs per prep value so an observation with two
  -- fresh images is counted once.  Matches the EXISTS filter used for selection.
  sample_type_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', st.sv, 'count', st.cnt)
        ORDER BY st.cnt DESC, st.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(lower(btrim(coalesce(i.sample_type, ''))), '') AS sv,
        count(DISTINCT ao.id)::bigint                          AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(lower(btrim(coalesce(i.sample_type, ''))), '') IS NOT NULL
      GROUP BY nullif(lower(btrim(coalesce(i.sample_type, ''))), '')
    ) st
  ),

  -- mountReagentFacets: same fix — all microscopy images, distinct obs per value.
  mount_reagent_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', mr.sv, 'count', mr.cnt)
        ORDER BY mr.cnt DESC, mr.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(lower(btrim(coalesce(i.mount_medium, ''))), '') AS sv,
        count(DISTINCT ao.id)::bigint                           AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(lower(btrim(coalesce(i.mount_medium, ''))), '') IS NOT NULL
      GROUP BY nullif(lower(btrim(coalesce(i.mount_medium, ''))), '')
    ) mr
  ),

  -- contrastMethodFacets: same fix.  Note: contrast values are NOT lowercased
  -- in the facet output (DIC/BF etc. are conventionally uppercase), but are
  -- lowercased in the filter norm for case-insensitive matching.
  contrast_method_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', cm.sv, 'count', cm.cnt)
        ORDER BY cm.cnt DESC, cm.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(btrim(coalesce(i.contrast, '')), '') AS sv,
        count(DISTINCT ao.id)::bigint               AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(btrim(coalesce(i.contrast, '')), '') IS NOT NULL
      GROUP BY nullif(btrim(coalesce(i.contrast, '')), '')
    ) cm
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

  -- monthCounts: calendar month distribution from filtered_obs.
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
    c.observation_count            AS "observationCount",
    c.microscopy_observation_count AS "microscopyObservationCount",
    c.spore_measurement_count      AS "sporeMeasurementCount",
    c.first_observed_on            AS "firstObservedOn",
    c.last_observed_on             AS "lastObservedOn",
    (SELECT facets FROM sample_type_facets)     AS "sampleTypeFacets",
    (SELECT facets FROM mount_reagent_facets)   AS "mountReagentFacets",
    (SELECT facets FROM contrast_method_facets) AS "contrastMethodFacets",
    (SELECT points FROM map_points)             AS "mapPoints",
    (SELECT counts FROM month_counts)           AS "monthCounts"
  FROM coverage c
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
