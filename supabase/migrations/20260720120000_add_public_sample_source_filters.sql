-- First-class server-side Sample source filtering and facets.
CREATE OR REPLACE FUNCTION public.public_normalized_specimen_condition(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE WHEN lower(btrim(coalesce(value, ''))) IN ('fresh', 'dried') THEN lower(btrim(value)) END $$;
CREATE OR REPLACE FUNCTION public.public_normalized_sample_source(source_value text, legacy_type text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE WHEN lower(btrim(coalesce(source_value, ''))) IN ('spore_print','hymenium','stipe','pileus','context','other') THEN lower(btrim(source_value)) WHEN nullif(btrim(source_value), '') IS NULL AND lower(btrim(coalesce(legacy_type, ''))) IN ('spore_print','spore print','print') THEN 'spore_print' END $$;
DROP FUNCTION IF EXISTS public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text);
DROP FUNCTION IF EXISTS public.get_public_map_points(text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer);
DROP FUNCTION IF EXISTS public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text);
DROP FUNCTION IF EXISTS public.get_public_species_distribution_summary(text, text, text, date, date, text, text, text, boolean, boolean);
CREATE OR REPLACE FUNCTION "public"."get_public_map_points"("p_species_slug" "text" DEFAULT NULL::"text", "p_genus" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_has_spores" boolean DEFAULT NULL::boolean, "p_limit" integer DEFAULT 3000, "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("observationId" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationLabel" "text", "mapLat" double precision, "mapLon" double precision, "locationPrecision" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
      -- Species slug: double regexp_replace same as all other species RPCs.
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
      nullif(btrim(lower(coalesce(p_genus,  ''))),          '') AS genus,
      nullif(btrim(coalesce(p_search, '')),                  '') AS search,
      nullif(btrim(upper(coalesce(p_country, ''))),          '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),               '') AS region_id,
      p_date_from                                               AS date_from,
      p_date_to                                                 AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type,     ''))),  '') AS sample_type,
      nullif(btrim(lower(coalesce(p_sample_source,   ''))),  '') AS sample_source,
      nullif(btrim(lower(coalesce(p_mount_reagent,   ''))),  '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))),  '') AS contrast_method,
      p_has_microscopy                                          AS has_microscopy,
      p_has_spores                                              AS has_spores,
      greatest(1, least(coalesce(p_limit, 3000), 5000))        AS lim
  ),

  candidate AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus,        '')), '') AS genus,
      nullif(btrim(coalesce(o.species,      '')), '') AS species,
      nullif(btrim(coalesce(o.common_name,  '')), '') AS common_name,
      o.date                                          AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country,
      nullif(btrim(coalesce(o.region_id,    '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden')        AS location_precision,
      nullif(btrim(coalesce(o.location,     '')), '') AS location,
      nullif(btrim(coalesce(r.label,        '')), '') AS region_label,
      o.gps_latitude,
      o.gps_longitude,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    LEFT JOIN public.public_regions r ON r.id = o.region_id
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
      -- Taxon filter: species slug wins, then genus, then free-text search.
      -- If all three are null, no taxon restriction (return all public observations).
      AND (
        n.slug IS NULL AND n.genus IS NULL AND n.search IS NULL
        OR (
          n.slug IS NOT NULL
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
        )
        OR (
          n.slug IS NULL AND n.genus IS NOT NULL
          AND lower(coalesce(o.genus, '')) = n.genus
        )
        OR (
          n.slug IS NULL AND n.genus IS NULL AND n.search IS NOT NULL
          AND (
            lower(coalesce(o.genus,    '')) ILIKE '%' || n.search || '%'
            OR lower(coalesce(o.species, '')) ILIKE '%' || n.search || '%'
          )
        )
      )
      -- Geo / date filters.
      AND (n.country   IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from IS NULL OR o.date >= n.date_from)
      AND (n.date_to   IS NULL OR o.date <= n.date_to)
      -- Prep filters via EXISTS: observation qualifies when ANY matching-prep
      -- microscope image exists, not just the latest one.
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND public.public_normalized_specimen_condition(i2.sample_type) = n.sample_type
      ))
      AND (n.sample_source IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = o.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND i3.image_type = 'microscope'
      ))
      -- p_has_spores = true: spore_data_visibility must be public AND have
      -- at least one qualifying spore measurement.
      AND (n.has_spores IS NOT TRUE OR (
        o.spore_data_visibility = 'public'
        AND EXISTS (
          SELECT 1
          FROM public.observation_images i4
          JOIN public.spore_measurements m ON m.image_id = i4.id
          WHERE i4.observation_id = o.id
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
  )

  SELECT
    c.id AS "observationId",
    -- speciesSlug: double regexp_replace same as search_public_observations.
    nullif(
      regexp_replace(
        regexp_replace(
          lower(btrim(concat_ws(' ', c.genus, c.species))),
          '[^a-z0-9]+', '-', 'g'
        ),
        '(^-|-$)', '', 'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', c.genus, c.species)), '') AS "speciesName",
    c.common_name AS "speciesCommonName",
    c.observed_on AS "observedOn",
    c.country     AS country,
    c.region_id   AS "regionId",
    -- locationLabel: privacy-safe same as existing RPCs.
    CASE c.location_precision
      WHEN 'exact'  THEN c.location
      WHEN 'fuzzed' THEN coalesce(c.region_label, c.country)
      WHEN 'region' THEN c.region_label
      ELSE NULL
    END AS "locationLabel",
    -- Privacy-safe coordinates.
    CASE c.location_precision
      WHEN 'exact'  THEN c.gps_latitude
      WHEN 'fuzzed' THEN round(c.gps_latitude::numeric, 2)::double precision
      ELSE NULL
    END AS "mapLat",
    CASE c.location_precision
      WHEN 'exact'  THEN c.gps_longitude
      WHEN 'fuzzed' THEN round(c.gps_longitude::numeric, 2)::double precision
      ELSE NULL
    END AS "mapLon",
    c.location_precision AS "locationPrecision",
    -- hasMicroscopy: observation's overall flag, regardless of prep filter.
    (EXISTS (
      SELECT 1 FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
    )) AS "hasMicroscopy",
    -- sporeMeasurementCount: public measurements only.
    CASE WHEN c.spore_data_visibility = 'public' THEN (
      SELECT count(m.id)::bigint
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) ELSE 0 END AS "sporeMeasurementCount"
  FROM candidate c
  CROSS JOIN norm n
  ORDER BY c.observed_on DESC, c.id DESC
  LIMIT (SELECT lim FROM norm)
$_$;
CREATE OR REPLACE FUNCTION "public"."get_public_observation_facets"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      public.public_normalized_specimen_condition(latest_image.sample_type) AS sample_type,
      public.public_normalized_sample_source(latest_image.sample_source, latest_image.sample_type) AS sample_source
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_image ON true
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
  country_labels AS (
    SELECT *
    FROM (
      VALUES
        ('DE'::text, 'Germany'::text),
        ('FI'::text, 'Finland'::text),
        ('GB'::text, 'United Kingdom'::text),
        ('NO'::text, 'Norway'::text),
        ('SE'::text, 'Sweden'::text)
    ) AS c(country_code, label)
  ),
  genera AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.genus AS value,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.genus,
          'label', grouped.genus,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.genus,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.genus IS NOT NULL
        GROUP BY vo.genus
      ) grouped
    ) items
  ),
  species AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.species_name AS value,
        grouped.species_name AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.species_name,
          'label', grouped.species_name,
          'genus', grouped.genus,
          'species', grouped.species,
          'speciesName', grouped.species_name,
          'commonName', grouped.common_name,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.genus,
          vo.species,
          nullif(btrim(concat_ws(' ', vo.genus, vo.species)), '') AS species_name,
          min(vo.common_name) AS common_name,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.genus IS NOT NULL
          AND vo.species IS NOT NULL
        GROUP BY vo.genus, vo.species
      ) grouped
    ) items
  ),
  countries AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.country_code AS value,
        coalesce(cl.label, grouped.country_code) AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.country_code,
          'label', coalesce(cl.label, grouped.country_code),
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ),
  regions AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.region_id AS value,
        grouped.region_label AS label,
        grouped.region_country_code AS country_code,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.region_id,
          'label', grouped.region_label,
          'countryCode', grouped.region_country_code,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.region_id,
          coalesce(vo.region_label, vo.region_id) AS region_label,
          coalesce(vo.region_country_code, vo.country_code) AS region_country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ),
  sample_types AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.sample_type AS value,
        CASE
          WHEN grouped.sample_type ~ '^[A-Z0-9]+$' THEN grouped.sample_type
          ELSE initcap(grouped.sample_type)
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.sample_type,
          'label', CASE
            WHEN grouped.sample_type ~ '^[A-Z0-9]+$' THEN grouped.sample_type
            ELSE initcap(grouped.sample_type)
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.sample_type,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.sample_type IS NOT NULL
        GROUP BY vo.sample_type
      ) grouped
    ) items
  ),
  sample_sources AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'value', grouped.sample_source,
      'label', CASE grouped.sample_source WHEN 'spore_print' THEN 'Spore print' ELSE initcap(grouped.sample_source) END,
      'count', grouped.facet_count
    ) ORDER BY grouped.facet_count DESC, grouped.sample_source), '[]'::jsonb) AS items
    FROM (
      SELECT vo.sample_source, count(*)::bigint AS facet_count
      FROM visible_observations vo WHERE vo.sample_source IS NOT NULL
      GROUP BY vo.sample_source
    ) grouped
  ),
  contrast_methods AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.contrast_method AS value,
        CASE
          WHEN grouped.contrast_method ~ '^[A-Z0-9]+$' THEN grouped.contrast_method
          ELSE initcap(lower(grouped.contrast_method))
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.contrast_method,
          'label', CASE
            WHEN grouped.contrast_method ~ '^[A-Z0-9]+$' THEN grouped.contrast_method
            ELSE initcap(lower(grouped.contrast_method))
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.contrast_method,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.contrast_method IS NOT NULL
        GROUP BY vo.contrast_method
      ) grouped
    ) items
  ),
  mount_reagents AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.mount_reagent AS value,
        CASE
          WHEN grouped.mount_reagent ~ '^[A-Z0-9]+$' THEN grouped.mount_reagent
          ELSE initcap(lower(grouped.mount_reagent))
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.mount_reagent,
          'label', CASE
            WHEN grouped.mount_reagent ~ '^[A-Z0-9]+$' THEN grouped.mount_reagent
            ELSE initcap(lower(grouped.mount_reagent))
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.mount_reagent,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.mount_reagent IS NOT NULL
        GROUP BY vo.mount_reagent
      ) grouped
    ) items
  )
  SELECT jsonb_build_object(
    'genera', (SELECT items FROM genera),
    'species', (SELECT items FROM species),
    'countries', (SELECT items FROM countries),
    'regions', (SELECT items FROM regions),
    'sampleTypes', (SELECT items FROM sample_types),
    'sampleSources', (SELECT items FROM sample_sources),
    'contrastMethods', (SELECT items FROM contrast_methods),
    'mountReagents', (SELECT items FROM mount_reagents)
  )
$_$;
CREATE OR REPLACE FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_has_spores" boolean DEFAULT NULL::boolean, "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" "date", "lastObservedOn" "date", "sampleTypeFacets" "jsonb", "sampleSourceFacets" "jsonb", "mountReagentFacets" "jsonb", "contrastMethodFacets" "jsonb", "mapPoints" "jsonb", "monthCounts" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
      nullif(btrim(lower(coalesce(p_sample_source, ''))), '') AS sample_source,
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
          AND public.public_normalized_specimen_condition(i2.sample_type) = n.sample_type
      ))
      AND (n.sample_source IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
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
            AND (n.sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = n.sample_type)
            AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
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
        nullif(public.public_normalized_specimen_condition(i.sample_type), '') AS sv,
        count(DISTINCT ao.id)::bigint                          AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
      WHERE nullif(public.public_normalized_specimen_condition(i.sample_type), '') IS NOT NULL
      GROUP BY nullif(public.public_normalized_specimen_condition(i.sample_type), '')
    ) st
  ),

  sample_source_facets AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('value', ss.sv, 'count', ss.cnt)
      ORDER BY ss.cnt DESC, ss.sv), '[]'::jsonb) AS facets
    FROM (
      SELECT public.public_normalized_sample_source(i.sample_source, i.sample_type) AS sv,
             count(DISTINCT ao.id)::bigint AS cnt
      FROM all_obs ao JOIN public.observation_images i ON i.observation_id = ao.id
       AND i.deleted_at IS NULL AND i.purged_at IS NULL AND i.image_type = 'microscope'
      WHERE public.public_normalized_sample_source(i.sample_source, i.sample_type) IS NOT NULL
      GROUP BY public.public_normalized_sample_source(i.sample_source, i.sample_type)
    ) ss
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
    (SELECT facets FROM sample_source_facets)   AS "sampleSourceFacets",
    (SELECT facets FROM mount_reagent_facets)   AS "mountReagentFacets",
    (SELECT facets FROM contrast_method_facets) AS "contrastMethodFacets",
    (SELECT points FROM map_points)             AS "mapPoints",
    (SELECT counts FROM month_counts)           AS "monthCounts"
  FROM coverage c
  WHERE EXISTS (SELECT 1 FROM all_obs)
$_$;
CREATE OR REPLACE FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text" DEFAULT NULL::"text", "p_genus" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("sourceType" "text", "taxonRank" "text", "speciesSlug" "text", "genus" "text", "label" "text", "filters" "jsonb", "observationCount" bigint, "sporeObservationCount" bigint, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "observations" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(upper(coalesce(p_country, ''))),    '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),         '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type, ''))),     '') AS sample_type,
      nullif(btrim(lower(coalesce(p_sample_source, ''))), '') AS sample_source,
      nullif(btrim(lower(coalesce(p_mount_reagent, ''))),   '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method
  ),
  taxon AS (
    SELECT
      CASE
        WHEN n.slug IS NOT NULL THEN 'species'
        WHEN n.genus IS NOT NULL THEN 'genus'
        ELSE NULL
      END AS rank,
      n.slug  AS species_slug,
      n.genus AS genus_filter
    FROM norm n
  ),
  taxon_obs AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '')    AS obs_genus,
      nullif(btrim(coalesce(o.species, '')), '')  AS obs_species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS obs_common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden')     AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '')  AS location_text,
      nullif(btrim(coalesce(r.label, '')), '')     AS region_label,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    CROSS JOIN taxon t
    LEFT JOIN public.public_regions r ON r.id = o.region_id
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
      AND (
        CASE t.rank
          WHEN 'species' THEN
            nullif(
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
            ) = t.species_slug
          WHEN 'genus' THEN
            lower(coalesce(o.genus, '')) = lower(t.genus_filter)
          ELSE false
        END
      )
      AND (n.country    IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id  IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from  IS NULL OR o.date >= n.date_from)
      AND (n.date_to    IS NULL OR o.date <= n.date_to)
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND public.public_normalized_specimen_condition(i2.sample_type) = n.sample_type
      ))
      AND (n.sample_source IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(btrim(coalesce(i2.mount_medium, ''))) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(btrim(coalesce(i2.contrast, ''))) = n.contrast_method
      ))
  ),
  spore_eligible AS (
    SELECT
      to_id.id,
      to_id.observed_on,
      to_id.obs_genus,
      to_id.obs_species,
      to_id.obs_common_name,
      to_id.country_code,
      to_id.region_id,
      to_id.location_precision,
      to_id.location_text,
      to_id.region_label,
      spore_counts.spore_n,
      n.sample_type     AS filter_sample_type,
      n.sample_source   AS filter_sample_source,
      n.mount_reagent   AS filter_mount_reagent,
      n.contrast_method AS filter_contrast_method
    FROM taxon_obs to_id
    CROSS JOIN norm n
    JOIN LATERAL (
      SELECT count(m.id)::bigint AS spore_n
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = to_id.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (n.sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = n.sample_type)
        AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
        AND (n.mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = n.mount_reagent)
        AND (n.contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = n.contrast_method)
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE to_id.spore_data_visibility = 'public'
  ),
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND i.image_type = 'microscope'
      AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
      AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
      AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
      AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    JOIN public.spore_measurements m ON m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  ),
  agg_len AS (
    SELECT
      count(*)::bigint                                                            AS n,
      min(length_um)                                                              AS len_min,
      max(length_um)                                                              AS len_max,
      avg(length_um)                                                              AS len_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p95
    FROM raw_meas
  ),
  agg_wq AS (
    SELECT
      min(width_um)                                                               AS wid_min,
      max(width_um)                                                               AS wid_max,
      avg(width_um)                                                               AS wid_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p95,
      min(length_um / nullif(width_um, 0))                                        AS q_min,
      max(length_um / nullif(width_um, 0))                                        AS q_max,
      avg(length_um / nullif(width_um, 0))                                        AS q_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p95
    FROM raw_meas
    WHERE width_um IS NOT NULL AND width_um > 0
  ),
  obs_means AS (
    SELECT
      se.id               AS observation_id,
      se.observed_on,
      se.obs_genus,
      se.obs_species,
      se.obs_common_name,
      se.country_code,
      se.region_id,
      CASE
        WHEN se.location_precision = 'exact'  THEN se.location_text
        WHEN se.location_precision = 'fuzzed' THEN coalesce(se.region_label, se.country_code)
        WHEN se.location_precision = 'region' THEN se.region_label
        ELSE NULL
      END                 AS location_label,
      se.spore_n,
      se.filter_sample_type,
      se.filter_sample_source,
      se.filter_mount_reagent,
      se.filter_contrast_method,
      rep_img.sample_type    AS rep_sample_type,
      rep_img.sample_source  AS rep_sample_source,
      rep_img.mount_medium   AS rep_mount_reagent,
      rep_img.contrast       AS rep_contrast_method,
      rep_img.stain          AS rep_stain_reagent,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean,
      obs_agg.obs_spore_summary,
      -- Per-observation prep summary. Mirrors the `prep_agg` shape
      -- emitted by get_public_observation so both endpoints agree on
      -- what an observation's full prep set contains. Scoped to
      -- microscope images with at least one spore-typed measurement,
      -- with the same active prep filters applied.
      obs_prep_summary.prep_summary
    FROM spore_eligible se
    LEFT JOIN LATERAL (
      SELECT
        i.sample_type,
        i.sample_source,
        i.mount_medium,
        i.contrast,
        i.stain
      FROM public.observation_images i
      JOIN LATERAL (
        SELECT count(*)::bigint AS n
        FROM public.spore_measurements m
        WHERE m.image_id = i.id
          AND m.length_um IS NOT NULL
          AND m.width_um  IS NOT NULL
          AND m.width_um > 0
          AND (
            m.measurement_type IS NULL
            OR m.measurement_type = ''
            OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
          )
      ) contrib ON contrib.n > 0
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
        AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
      ORDER BY contrib.n DESC, i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) rep_img ON true
    JOIN LATERAL (
      SELECT
        avg(m.length_um) AS length_mean,
        avg(m.width_um)  FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS width_mean,
        avg(m.length_um / nullif(m.width_um, 0))
                         FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS q_mean
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
        AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_stats ON true
    JOIN LATERAL (
      SELECT
        jsonb_strip_nulls(jsonb_build_object(
          'n',               count(m.id)::bigint,
          'length_min_um',   min(m.length_um),
          'length_max_um',   max(m.length_um),
          'length_mean_um',  avg(m.length_um),
          'width_min_um',    min(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'width_max_um',    max(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'width_mean_um',   avg(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_min',           min(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_max',           max(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_mean',          avg(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0)
        )) AS obs_spore_summary
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
        AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_agg ON true
    LEFT JOIN LATERAL (
      -- Dedupe to one row per contributing image, then aggregate
      -- distinct values per dimension. Membership, not weight, is
      -- what the summary conveys: a mount used on eight images
      -- must not outweigh one used on one image.
      WITH contributors AS (
        SELECT DISTINCT
          i.id AS image_id,
          nullif(btrim(coalesce(i.contrast, '')), '')      AS contrast,
          nullif(btrim(coalesce(i.mount_medium, '')), '')  AS mount_medium,
          nullif(btrim(coalesce(i.stain, '')), '')         AS stain,
          nullif(btrim(coalesce(i.sample_type, '')), '')   AS sample_type,
          nullif(btrim(coalesce(i.sample_source, '')), '') AS sample_source
        FROM public.observation_images i
        WHERE i.observation_id = se.id
          AND i.deleted_at IS NULL
          AND i.purged_at  IS NULL
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
          AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
          AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
          AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
          AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
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
    ) obs_prep_summary ON true
  ),
  first_obs AS (
    SELECT obs_genus, obs_species, obs_common_name
    FROM taxon_obs
    LIMIT 1
  )
  SELECT
    'taxon_filter'::text AS "sourceType",
    (SELECT rank FROM taxon) AS "taxonRank",
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (
        SELECT nullif(
          regexp_replace(
            regexp_replace(
              lower(btrim(concat_ws(' ',
                nullif(btrim(coalesce(fo.obs_genus,   '')), ''),
                nullif(btrim(coalesce(fo.obs_species, '')), '')
              ))),
              '[^a-z0-9]+', '-', 'g'
            ),
            '(^-|-$)', '', 'g'
          ),
          ''
        )
        FROM first_obs fo
      )
      ELSE NULL
    END AS "speciesSlug",
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (SELECT nullif(btrim(coalesce(fo.obs_genus, '')), '') FROM first_obs fo)
      WHEN 'genus'   THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS genus,
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (
        SELECT nullif(btrim(concat_ws(' ',
          nullif(btrim(coalesce(fo.obs_genus,   '')), ''),
          nullif(btrim(coalesce(fo.obs_species, '')), '')
        )), '')
        FROM first_obs fo
      )
      WHEN 'genus' THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS label,
    jsonb_strip_nulls(jsonb_build_object(
      'country',         (SELECT country    FROM norm),
      'regionId',        (SELECT region_id  FROM norm),
      'dateFrom',        (SELECT date_from  FROM norm),
      'dateTo',          (SELECT date_to    FROM norm),
      'sampleType',      (SELECT sample_type     FROM norm),
      'mountReagent',    (SELECT mount_reagent   FROM norm),
      'contrastMethod',  (SELECT contrast_method FROM norm)
    ))                   AS filters,
    (SELECT count(*)::bigint FROM taxon_obs)           AS "observationCount",
    (SELECT count(*)::bigint FROM spore_eligible)      AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint AS "sporeMeasurementCount",
    CASE WHEN (SELECT n FROM agg_len) > 0 THEN
      jsonb_strip_nulls(jsonb_build_object(
        'n',                  (SELECT n        FROM agg_len),
        'length_min_um',      (SELECT len_min  FROM agg_len),
        'length_max_um',      (SELECT len_max  FROM agg_len),
        'length_p05_um',      (SELECT len_p05  FROM agg_len),
        'length_p95_um',      (SELECT len_p95  FROM agg_len),
        'length_core_min_um', (SELECT len_p05  FROM agg_len),
        'length_core_max_um', (SELECT len_p95  FROM agg_len),
        'length_mean_um',     (SELECT len_mean FROM agg_len),
        'width_min_um',       (SELECT wid_min  FROM agg_wq),
        'width_max_um',       (SELECT wid_max  FROM agg_wq),
        'width_p05_um',       (SELECT wid_p05  FROM agg_wq),
        'width_p95_um',       (SELECT wid_p95  FROM agg_wq),
        'width_core_min_um',  (SELECT wid_p05  FROM agg_wq),
        'width_core_max_um',  (SELECT wid_p95  FROM agg_wq),
        'width_mean_um',      (SELECT wid_mean FROM agg_wq),
        'q_min',              (SELECT q_min    FROM agg_wq),
        'q_max',              (SELECT q_max    FROM agg_wq),
        'q_p05',              (SELECT q_p05    FROM agg_wq),
        'q_p95',              (SELECT q_p95    FROM agg_wq),
        'q_core_min',         (SELECT q_p05    FROM agg_wq),
        'q_core_max',         (SELECT q_p95    FROM agg_wq),
        'q_mean',             (SELECT q_mean   FROM agg_wq)
      ))
    ELSE NULL END AS "sporeSummary",
    coalesce((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'observationId',      om.observation_id,
          'observedOn',         om.observed_on,
          'speciesSlug',        nullif(
                                  regexp_replace(
                                    regexp_replace(
                                      lower(btrim(concat_ws(' ',
                                        nullif(btrim(coalesce(om.obs_genus,   '')), ''),
                                        nullif(btrim(coalesce(om.obs_species, '')), '')
                                      ))),
                                      '[^a-z0-9]+', '-', 'g'
                                    ),
                                    '(^-|-$)', '', 'g'
                                  ),
                                  ''
                                ),
          'speciesName',        nullif(btrim(concat_ws(' ',
                                  nullif(btrim(coalesce(om.obs_genus,   '')), ''),
                                  nullif(btrim(coalesce(om.obs_species, '')), '')
                                )), ''),
          'speciesCommonName',  om.obs_common_name,
          'country',            om.country_code,
          'regionId',           om.region_id,
          'locationLabel',      om.location_label,
          'sampleType',         CASE
                                  WHEN lower(btrim(coalesce(coalesce(om.rep_sample_type, om.filter_sample_type), ''))) IN ('fresh', 'dried')
                                    THEN lower(btrim(coalesce(om.rep_sample_type, om.filter_sample_type)))
                                  ELSE NULL::text
                                END,
          'sampleSource',       public.public_normalized_sample_source(
                                  om.rep_sample_source,
                                  om.rep_sample_type
                                ),
          'mountReagent',       coalesce(om.rep_mount_reagent,   om.filter_mount_reagent),
          'contrastMethod',     coalesce(om.rep_contrast_method, om.filter_contrast_method),
          'stainReagent',       nullif(btrim(coalesce(om.rep_stain_reagent, '')), ''),
          'sporeN',             om.spore_n,
          'lengthMeanUm',       om.length_mean,
          'widthMeanUm',        om.width_mean,
          'qMean',              om.q_mean,
          'sporeSummary',       om.obs_spore_summary,
          -- Aggregate prep values across all contributing microscope
          -- images so the caller can distinguish a mixed-prep
          -- observation from a single-prep one. jsonb_strip_nulls does
          -- not remove empty arrays, so `prepSummary` is always present
          -- with the five keys (each an empty array when nothing
          -- contributed).
          'prepSummary',        om.prep_summary
        ))
        ORDER BY om.observed_on DESC, om.observation_id DESC
      )
      FROM obs_means om
    ), '[]'::jsonb) AS "observations"
  FROM (SELECT 1) AS _single
  WHERE (SELECT rank FROM taxon) IS NOT NULL
    AND EXISTS (SELECT 1 FROM taxon_obs)
$_$;
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
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
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
    AND (n.contrast IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND lower(btrim(coalesce(i2.contrast, ''))) = lower(btrim(n.contrast))
    ))
    AND (n.mount IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND lower(btrim(coalesce(i2.mount_medium, ''))) = lower(btrim(n.mount))
    ))
    AND (n.sample IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND public.public_normalized_specimen_condition(i2.sample_type) = lower(btrim(n.sample))
    ))
    AND (n.sample_source IS NULL OR EXISTS (
      SELECT 1 FROM public.observation_images i2
      WHERE i2.observation_id = e.id
        AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
        AND i2.image_type = 'microscope'
        AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
    ))
  ORDER BY e.observed_on DESC, e.id DESC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$_$;

GRANT EXECUTE ON FUNCTION public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_map_points(text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_species_distribution_summary(text, text, text, date, date, text, text, text, boolean, boolean, text) TO anon, authenticated, service_role;
