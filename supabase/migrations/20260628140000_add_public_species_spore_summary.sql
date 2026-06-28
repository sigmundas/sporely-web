-- Public species-level spore summary with optional geographic and date filters.
--
-- Returns one row per matched species + filter combination containing:
--   species metadata, filtered coverage metrics, aggregate spore statistics
--   computed from raw measurements, and per-observation rows for Parmasto-style
--   specimen variation.
--
-- Privacy rules:
--   - Only public, non-draft, non-banned-user observations.
--   - Blocked-user gate applied when a caller is authenticated.
--   - Spore data only when spore_data_visibility = 'public'.
--   - No GPS coordinates returned.

CREATE OR REPLACE FUNCTION public.get_public_species_spore_summary(
  p_species_slug text,
  p_country      text    DEFAULT NULL::text,
  p_region_id    text    DEFAULT NULL::text,
  p_date_from    date    DEFAULT NULL::date,
  p_date_to      date    DEFAULT NULL::date
)
RETURNS TABLE(
  "speciesSlug"             text,
  "speciesName"             text,
  "speciesCommonName"       text,
  "observationCount"        bigint,
  "microscopyObservationCount" bigint,
  "sporeObservationCount"   bigint,
  "sporeMeasurementCount"   bigint,
  "firstObservedOn"         date,
  "lastObservedOn"          date,
  countries                 jsonb,
  regions                   jsonb,
  "sporeSummary"            jsonb,
  "observations"            jsonb
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
      nullif(btrim(upper(coalesce(p_country, ''))),   '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),        '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to
  ),
  country_labels AS (
    SELECT *
    FROM (VALUES
      ('DE'::text, 'Germany'::text),
      ('FI'::text, 'Finland'::text),
      ('GB'::text, 'United Kingdom'::text),
      ('NO'::text, 'Norway'::text),
      ('SE'::text, 'Sweden'::text)
    ) AS c(code, label)
  ),
  -- All public, non-draft, non-banned observations matching the target species
  -- and the optional geographic / date filters.
  species_obs AS (
    SELECT
      o.id,
      nullif(btrim(concat_ws(' ',
        nullif(btrim(coalesce(o.genus,   '')), ''),
        nullif(btrim(coalesce(o.species, '')), '')
      )), '') AS species_name,
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
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location_text,
      o.spore_data_visibility,
      o.spore_statistics,
      (micro.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    CROSS JOIN norm n
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
      LIMIT 1
    ) micro ON true
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
      -- Species slug match (same normalisation as search_public_species).
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
      -- Optional filters.
      AND (n.country   IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from IS NULL OR o.date >= n.date_from)
      AND (n.date_to   IS NULL OR o.date <= n.date_to)
  ),
  -- Subset: observations with public spore data and ≥1 qualifying measurement.
  spore_eligible AS (
    SELECT
      so.id,
      so.observed_on,
      so.country_code,
      so.region_id,
      so.region_label,
      so.location_precision,
      so.location_text,
      so.spore_statistics,
      spore_counts.spore_n
    FROM species_obs so
    JOIN LATERAL (
      SELECT count(m.id)::bigint AS spore_n
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = so.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE so.spore_data_visibility = 'public'
  ),
  -- Flat raw measurements for aggregate statistics.
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND i.image_type = 'microscope'
    JOIN public.spore_measurements m ON m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  ),
  -- Aggregate length stats over all qualifying measurements.
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
  -- Aggregate width and Q stats over measurements that have a valid width.
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
  -- Per-observation means computed fresh from raw measurements (not from stored spore_statistics).
  obs_means AS (
    SELECT
      se.id            AS observation_id,
      se.observed_on,
      se.country_code,
      se.region_id,
      CASE
        WHEN se.location_precision = 'exact'  THEN se.location_text
        WHEN se.location_precision = 'fuzzed' THEN coalesce(se.region_label, se.country_code)
        WHEN se.location_precision = 'region' THEN se.region_label
        ELSE NULL
      END              AS location_label,
      se.spore_n,
      se.spore_statistics,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean
    FROM spore_eligible se
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
    ) obs_stats ON true
  )
  SELECT
    -- Species identity (from first matching observation).
    (SELECT species_slug  FROM species_obs LIMIT 1)  AS "speciesSlug",
    (SELECT species_name  FROM species_obs LIMIT 1)  AS "speciesName",
    (SELECT common_name   FROM species_obs LIMIT 1)  AS "speciesCommonName",
    -- Coverage.
    (SELECT count(*)::bigint  FROM species_obs)                          AS "observationCount",
    (SELECT count(*)::bigint  FROM species_obs WHERE has_microscopy)     AS "microscopyObservationCount",
    (SELECT count(*)::bigint  FROM spore_eligible)                       AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint       AS "sporeMeasurementCount",
    (SELECT min(observed_on) FROM species_obs)                           AS "firstObservedOn",
    (SELECT max(observed_on) FROM species_obs)                           AS "lastObservedOn",
    -- Countries facet.
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value', g.cc,
          'label', coalesce(cl.label, g.cc),
          'count', g.cnt
        )
        ORDER BY g.cnt DESC, g.cc ASC
      )
      FROM (
        SELECT country_code AS cc, count(*)::bigint AS cnt
        FROM species_obs
        WHERE country_code IS NOT NULL
        GROUP BY country_code
      ) g
      LEFT JOIN country_labels cl ON cl.code = g.cc
    ), '[]'::jsonb) AS countries,
    -- Regions facet.
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value',       g.rid,
          'label',       g.rlabel,
          'countryCode', g.rcc,
          'count',       g.cnt
        )
        ORDER BY g.cnt DESC, g.rid ASC
      )
      FROM (
        SELECT
          region_id AS rid,
          coalesce(region_label, region_id) AS rlabel,
          coalesce(region_country_code, country_code) AS rcc,
          count(*)::bigint AS cnt
        FROM species_obs
        WHERE region_id IS NOT NULL
        GROUP BY
          region_id,
          coalesce(region_label, region_id),
          coalesce(region_country_code, country_code)
      ) g
    ), '[]'::jsonb) AS regions,
    -- Aggregate spore summary (NULL when no public measurements).
    -- length_core_min/max are aliases for p05/p95 so the landing SporeSummary
    -- type picks them up via its firstFiniteNumber preference chain.
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
    -- Per-observation array ordered most-recent first.
    coalesce((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'observationId', om.observation_id,
          'observedOn',    om.observed_on,
          'country',       om.country_code,
          'regionId',      om.region_id,
          'locationLabel', om.location_label,
          'sporeN',        om.spore_n,
          'lengthMeanUm',  om.length_mean,
          'widthMeanUm',   om.width_mean,
          'qMean',         om.q_mean,
          'sporeSummary',  om.spore_statistics
        ))
        ORDER BY om.observed_on DESC, om.observation_id DESC
      )
      FROM obs_means om
    ), '[]'::jsonb) AS "observations"
  FROM (SELECT 1) AS _single
  WHERE EXISTS (SELECT 1 FROM species_obs)
$$;

ALTER FUNCTION public.get_public_species_spore_summary(text, text, text, date, date)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_species_spore_summary(text, text, text, date, date)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_species_spore_summary(text, text, text, date, date)
  TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_species_spore_summary(text, text, text, date, date)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_species_spore_summary(text, text, text, date, date)
  TO service_role;

NOTIFY pgrst, 'reload schema';
