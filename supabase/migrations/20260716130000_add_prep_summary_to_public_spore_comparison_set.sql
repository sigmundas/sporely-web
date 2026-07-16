-- Expose the same per-observation `prepSummary` aggregate on
-- get_public_spore_comparison_set that get_public_observation already
-- emits, so the species-page mean scatter can distinguish observations
-- with one prep value from observations with multiple prep values.
--
-- Bug fixed:
--   The RPC's per-observation JSON only exposed scalar `sampleType /
--   mountReagent / contrastMethod / stainReagent` fields derived from a
--   single representative microscope image. An observation whose
--   measurements were split across images with different contrast /
--   mount / stain / condition / source values collapsed down to whatever
--   the rep image happened to carry. The species-page "Colour by …"
--   legend therefore claimed the observation had "Only one value" for a
--   dimension where the observation-detail table shows multiple.
--
-- Fix:
--   Add an `obs_prep_summary` LATERAL join per observation using the
--   same contributor rule as get_public_observation's `prep_agg`:
--     - Microscope images (image_type = 'microscope', or legacy NULL)
--     - with at least one attached spore-typed measurement
--     - measurement_type IS NULL / '' / manual / spore / spores
--   Emit distinct non-empty, non-"not_set" values per dimension as
--   sorted JSON arrays under `prepSummary`. Scalar `sampleType /
--   mountReagent / contrastMethod / stainReagent` remain populated
--   for backward compatibility.
--
-- The active prep filters (sample_type / mount_reagent / contrast_method)
-- still scope the contributors, matching the existing per-observation
-- aggregation elsewhere in this RPC. If no filter is active the summary
-- reflects every contributing microscope image on the observation.

CREATE OR REPLACE FUNCTION public.get_public_spore_comparison_set(
  p_species_slug    text DEFAULT NULL,
  p_genus           text DEFAULT NULL,
  p_country         text DEFAULT NULL,
  p_region_id       text DEFAULT NULL,
  p_date_from       date DEFAULT NULL,
  p_date_to         date DEFAULT NULL,
  p_sample_type     text DEFAULT NULL,
  p_mount_reagent   text DEFAULT NULL,
  p_contrast_method text DEFAULT NULL
)
RETURNS TABLE(
  "sourceType"             text,
  "taxonRank"              text,
  "speciesSlug"            text,
  genus                    text,
  label                    text,
  filters                  jsonb,
  "observationCount"       bigint,
  "sporeObservationCount"  bigint,
  "sporeMeasurementCount"  bigint,
  "sporeSummary"           jsonb,
  "observations"           jsonb
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
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(upper(coalesce(p_country, ''))),    '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),         '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type, ''))),     '') AS sample_type,
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
          AND lower(btrim(coalesce(i2.sample_type, ''))) = n.sample_type
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
        AND (n.sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = n.sample_type)
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
      AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
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
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
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
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
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
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
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
          AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
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
          'sampleSource',       CASE
                                  WHEN lower(btrim(coalesce(om.rep_sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
                                    THEN lower(btrim(om.rep_sample_source))
                                  ELSE NULL::text
                                END,
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
$$;

ALTER FUNCTION public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text)
  TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_spore_comparison_set(text, text, text, text, date, date, text, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
