-- Scope public microscopy-context filters to valid public spore measurements.
-- A source microscope image is a metadata anchor for a measured spore and does
-- not need downloadable bytes.  All active context dimensions must match the
-- same measurement-bearing source image.
--
-- This predicate is deliberately spore-specific.  A future schema for
-- cystidia, basidia, and other measured structures must add an independent
-- measurement_subject/structure_type dimension; measurement_type is not an
-- anatomical-structure classifier.

CREATE OR REPLACE FUNCTION "public"."search_public_observations"("p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0, "p_genus" "text" DEFAULT NULL::"text", "p_species" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_has_spores" boolean DEFAULT NULL::boolean, "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_contrast" "text" DEFAULT NULL::"text", "p_mount" "text" DEFAULT NULL::"text", "p_sample" "text" DEFAULT NULL::"text", "p_observer" "text" DEFAULT NULL::"text", "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("id" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observerDisplayName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationPrecision" "text", "locationLabel" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "contrastMethod" "text", "mountReagent" "text", "sampleType" "text", "sampleSource" "text", "stainReagent" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH normalized AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 50), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off,
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(coalesce(p_species, '')), '') AS species,
      nullif(btrim(coalesce(p_country, '')), '') AS country,
      nullif(btrim(coalesce(p_region, '')), '') AS region,
      p_date_from AS date_from,
      p_date_to AS date_to,
      p_has_spores AS has_spores,
      p_has_microscopy AS has_microscopy,
      nullif(btrim(coalesce(p_contrast, '')), '') AS contrast,
      nullif(btrim(coalesce(p_mount, '')), '') AS mount,
      nullif(btrim(coalesce(p_sample, '')), '') AS sample,
      nullif(btrim(lower(coalesce(p_sample_source, ''))), '') AS sample_source,
      nullif(btrim(coalesce(p_observer, '')), '') AS observer
  ),
  candidate_base AS (
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
    WHERE o.visibility = 'public'::text
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
  candidate AS (
    SELECT cb.*
    FROM candidate_base cb
    CROSS JOIN normalized n
    WHERE (n.genus IS NULL OR lower(coalesce(cb.genus, '')) = lower(n.genus))
      AND (n.species IS NULL OR lower(coalesce(cb.species, '')) = lower(n.species))
      AND (n.country IS NULL OR lower(coalesce(cb.country, '')) = lower(n.country))
      AND (n.region IS NULL OR cb.region_id = n.region)
      AND (n.date_from IS NULL OR cb.observed_on >= n.date_from)
      AND (n.date_to IS NULL OR cb.observed_on <= n.date_to)
      AND (
        n.observer IS NULL
        OR coalesce(cb.observer_display_name, '') ILIKE '%' || n.observer || '%'
      )
  ),
  enriched AS (
    SELECT
      c.*,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      latest_image.sample_type AS sample_type,
      latest_image.sample_source AS sample_source,
      latest_image.stain AS stain_reagent,
      (latest_image.id IS NOT NULL) AS has_microscopy,
      o.spore_data_visibility,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary
    FROM candidate c
    JOIN public.observations o
      ON o.id = c.id
    CROSS JOIN normalized n
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source,
        i.stain
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (n.contrast IS NULL OR lower(btrim(coalesce(i.contrast, '')))     = lower(btrim(n.contrast)))
        AND (n.mount    IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = lower(btrim(n.mount)))
        AND (n.sample   IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = lower(btrim(n.sample)))
        AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
        AND (
          (
            n.contrast IS NULL
            AND n.mount IS NULL
            AND n.sample IS NULL
            AND n.sample_source IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.spore_measurements m
            WHERE m.image_id = i.id
              AND m.length_um IS NOT NULL
              AND m.width_um IS NOT NULL
              AND (
                m.measurement_type IS NULL
                OR btrim(m.measurement_type) = ''
                OR lower(btrim(m.measurement_type)) IN ('manual', 'spore', 'spores')
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
        AND i.image_type = 'microscope'::text
        AND (
          m.measurement_type IS NULL
          OR btrim(m.measurement_type) = ''
          OR lower(btrim(m.measurement_type)) IN ('manual', 'spore', 'spores')
        )
        AND m.length_um IS NOT NULL
        AND m.width_um IS NOT NULL
    ) spore_stats ON true
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
    e.contrast_method AS "contrastMethod",
    e.mount_reagent AS "mountReagent",
    CASE
      WHEN lower(btrim(coalesce(e.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(e.sample_type))
      ELSE NULL::text
    END AS "sampleType",
    public.public_normalized_sample_source(e.sample_source, e.sample_type) AS "sampleSource",
    nullif(btrim(coalesce(e.stain_reagent, '')), '') AS "stainReagent"
  FROM enriched e
  CROSS JOIN normalized n
  WHERE (n.has_microscopy IS NULL OR e.has_microscopy = n.has_microscopy)
    AND (
      n.has_spores IS NULL
      OR (e.spore_measurement_count > 0) = n.has_spores
    )
    AND (
      (
        n.contrast IS NULL
        AND n.mount IS NULL
        AND n.sample IS NULL
        AND n.sample_source IS NULL
      )
      OR (
        e.spore_data_visibility = 'public'::text
        AND EXISTS (
          SELECT 1
          FROM public.spore_measurements m
          JOIN public.observation_images i
            ON i.id = m.image_id
          WHERE i.observation_id = e.id
            AND i.deleted_at IS NULL
            AND i.purged_at IS NULL
            AND i.image_type = 'microscope'::text
            AND (n.contrast IS NULL OR lower(btrim(coalesce(i.contrast, ''))) = lower(btrim(n.contrast)))
            AND (n.mount IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = lower(btrim(n.mount)))
            AND (n.sample IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = lower(btrim(n.sample)))
            AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
            AND (
              m.measurement_type IS NULL
              OR btrim(m.measurement_type) = ''
              OR lower(btrim(m.measurement_type)) IN ('manual', 'spore', 'spores')
            )
            AND m.length_um IS NOT NULL
            AND m.width_um IS NOT NULL
        )
      )
    )
  ORDER BY e.observed_on DESC, e.id DESC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$_$;
