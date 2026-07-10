-- Expose real per-observation preparation values on
-- get_public_spore_comparison_set, and add stainReagent to the public
-- surface (both this RPC and search_public_observations).
--
-- Bug fixed:
--   Prior to this migration the per-observation rows returned by
--   get_public_spore_comparison_set carried sampleType, mountReagent
--   and contrastMethod straight from the *filter* parameters. When
--   the caller queried without those filters, every observation in
--   the result received NULL for those fields — which meant the
--   species page's "Colour by …" legend could only ever expose
--   Country and Month.
--
-- Additions:
--   * A new representative-image LATERAL join in obs_means resolves
--     the dominant *measurement-contributing* microscope image per
--     observation — only images whose qualifying spore measurements
--     entered the observation's mean are eligible. Ties are broken
--     by contribution count first, then by newest image. This is a
--     stricter policy than "newest microscope image": an image that
--     exists but produced no measurements can never speak for the
--     observation's prep metadata.
--   * A qualifying spore measurement is one that could actually be
--     placed on the L×W scatter:
--       m.length_um IS NOT NULL
--       AND m.width_um IS NOT NULL
--       AND m.width_um > 0
--       AND measurement_type IN ('manual', 'spore', 'spores') OR is null/empty.
--     This is stricter than obs_stats' length_mean aggregation (which
--     accepts length-only measurements) — deliberately: an image that
--     only produced length-only spores contributes to length summaries
--     but nothing that can be plotted on the L×W scatter, so it
--     shouldn't get to speak for the observation's prep metadata.
--     The width > 0 clause matches the FILTER used by obs_stats' width
--     and Q aggregates.
--   * The per-observation jsonb emits sampleType / mountReagent /
--     contrastMethod / stainReagent from that dominant image, falling
--     back to the active filter values only if no L×W-qualifying
--     image survived. spore_eligible.spore_n > 0 only guarantees at
--     least one length-only measurement, so a length-only observation
--     can still make it into spore_eligible (contributing to summary
--     aggregates) but produces no rep_img row for the L×W scatter and
--     receives NULL / filter-fallback prep metadata.
--   * search_public_observations gains a `stainReagent` column, using
--     the same "latest microscope image" heuristic already established
--     for contrast / mount / sample. That RPC's per-observation stats
--     are not measurement-derived so the newest-image proxy is still
--     appropriate there — it just widens what search callers can see.
--
-- Migration is additive — search_public_observations' RETURNS TABLE
-- gains a single `stainReagent text` column at the tail;
-- get_public_spore_comparison_set's signature is unchanged (the new
-- fields flow through the JSONB observations array).
--
-- Follow-up (deliberately deferred, not a blocker):
--   search_public_observations' outer EXISTS clauses evaluate each
--   prep filter independently, so an observation can qualify under
--   (p_sample := 'fresh', p_mount := 'KOH') when 'fresh' matches one
--   image and 'KOH' matches a different image. latest_image now
--   requires all active filters to hit the SAME image, so in that
--   case it returns NULL and the row exposes hasMicroscopy=false
--   with null prep values. That is more honest than the old
--   "newest of any image" projection, but the user-facing filter
--   semantics arguably should require one image to satisfy all
--   active prep filters simultaneously — i.e. tighten the outer
--   EXISTS clauses into a single EXISTS with the full filter set
--   on one i2 row. Track separately.

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
      -- Normalize species slug same way as search_public_species / get_public_species_spore_summary.
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
      -- Genus is used only when species slug is absent.
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(upper(coalesce(p_country, ''))),    '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),         '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type, ''))),     '') AS sample_type,
      nullif(btrim(lower(coalesce(p_mount_reagent, ''))),   '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method
  ),
  -- Taxon rank determination: species_slug wins over genus.
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
  -- All public, non-draft, non-banned observations matching the taxon filter
  -- and the optional geographic / date / microscopy image filters.
  --
  -- Prep filters (sample_type, mount_reagent, contrast_method) are applied via
  -- EXISTS subqueries so an observation qualifies when ANY of its microscope
  -- images matches the requested prep, not just the latest one.
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
      -- Taxon filter: species slug wins over genus.
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
      -- Optional geographic / date filters.
      AND (n.country    IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id  IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from  IS NULL OR o.date >= n.date_from)
      AND (n.date_to    IS NULL OR o.date <= n.date_to)
      -- Optional microscopy image prep filters: observation qualifies when it has
      -- at least one matching-prep microscope image (any image, not just latest).
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
  -- Subset: observations with public spore data and ≥1 qualifying raw measurement
  -- from images that match the active prep filters.
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
        -- Prep filters: only count measurements from matching-prep images.
        AND (n.sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = n.sample_type)
        AND (n.mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = n.mount_reagent)
        AND (n.contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = n.contrast_method)
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE to_id.spore_data_visibility = 'public'
  ),
  -- Flat raw measurements for aggregate statistics, scoped to matching-prep images.
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND i.image_type = 'microscope'
      -- Prep filters carried from spore_eligible: only aggregate measurements
      -- from images that match the active prep filter values.
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
  -- Per-observation means computed fresh from raw measurements, scoped to
  -- matching-prep images. Also picks a representative microscope image
  -- so the output carries the observation's *actual* prep values, not
  -- the query filter values.
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
      -- Representative microscope image: the image that contributed
      -- the MOST L×W-plottable spore measurements to this observation.
      -- Ties broken by newest → highest id. Only images whose spores
      -- match the L×W-plottable filter (length_um non-null AND
      -- width_um > 0 AND manual-style measurement_type) are eligible.
      -- This is stricter than obs_stats' length_mean aggregation —
      -- see header comment — because the legend needs to describe the
      -- data that produced the plotted point, not the length summary.
      rep_img.sample_type    AS rep_sample_type,
      rep_img.mount_medium   AS rep_mount_reagent,
      rep_img.contrast       AS rep_contrast_method,
      rep_img.stain          AS rep_stain_reagent,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean,
      -- Per-observation aggregate for sporeSummary field
      obs_agg.obs_spore_summary
    FROM spore_eligible se
    LEFT JOIN LATERAL (
      SELECT
        i.sample_type,
        i.mount_medium,
        i.contrast,
        i.stain
      FROM public.observation_images i
      -- Require the image to have contributed at least one qualifying
      -- spore measurement to this observation. `contrib.n` doubles as
      -- the ranking weight below.
      JOIN LATERAL (
        SELECT count(*)::bigint AS n
        FROM public.spore_measurements m
        WHERE m.image_id = i.id
          AND m.length_um IS NOT NULL
          AND m.width_um  IS NOT NULL
          -- width > 0 matches the FILTER clause obs_stats uses for its
          -- width/Q aggregates and rules out zero-width degenerates
          -- that couldn't be plotted anyway.
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
        -- Prep filters: per-observation stats scoped to matching-prep images.
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
        -- Prep filters: per-observation aggregate scoped to matching-prep images.
        AND (se.filter_sample_type     IS NULL OR lower(btrim(coalesce(i.sample_type,  ''))) = se.filter_sample_type)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_agg ON true
  ),
  -- First matching observation row for species-level identity extraction.
  first_obs AS (
    SELECT obs_genus, obs_species, obs_common_name
    FROM taxon_obs
    LIMIT 1
  )
  SELECT
    'taxon_filter'::text AS "sourceType",
    (SELECT rank FROM taxon) AS "taxonRank",
    -- speciesSlug: only populated for species-level queries.
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
    -- genus: the genus from observation (species-level) or the filter genus (genus-level).
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (SELECT nullif(btrim(coalesce(fo.obs_genus, '')), '') FROM first_obs fo)
      WHEN 'genus'   THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS genus,
    -- label: species name (genus + species) or genus name.
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
    -- Non-null filter params as jsonb.
    jsonb_strip_nulls(jsonb_build_object(
      'country',         (SELECT country    FROM norm),
      'regionId',        (SELECT region_id  FROM norm),
      'dateFrom',        (SELECT date_from  FROM norm),
      'dateTo',          (SELECT date_to    FROM norm),
      'sampleType',      (SELECT sample_type     FROM norm),
      'mountReagent',    (SELECT mount_reagent   FROM norm),
      'contrastMethod',  (SELECT contrast_method FROM norm)
    ))                   AS filters,
    -- Coverage.
    (SELECT count(*)::bigint FROM taxon_obs)           AS "observationCount",
    (SELECT count(*)::bigint FROM spore_eligible)      AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint AS "sporeMeasurementCount",
    -- Aggregate spore summary (NULL when no public measurements).
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
          -- Emit the observation's real prep values from the
          -- representative microscope image. rep_img requires both
          -- length_um AND width_um non-null (see rep_img LATERAL
          -- above) so it can be NULL for a length-only observation
          -- that still passed spore_eligible's length-only filter.
          -- Fall back to the active filter values in that case; if
          -- the query was itself unfiltered the field is left NULL
          -- and jsonb_strip_nulls removes it — clients then see the
          -- prep dimension as "Unknown" for that observation.
          'sampleType',         coalesce(om.rep_sample_type,     om.filter_sample_type),
          'mountReagent',       coalesce(om.rep_mount_reagent,   om.filter_mount_reagent),
          'contrastMethod',     coalesce(om.rep_contrast_method, om.filter_contrast_method),
          'stainReagent',       nullif(btrim(coalesce(om.rep_stain_reagent, '')), ''),
          'sporeN',             om.spore_n,
          'lengthMeanUm',       om.length_mean,
          'widthMeanUm',        om.width_mean,
          'qMean',              om.q_mean,
          'sporeSummary',       om.obs_spore_summary
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


-- ── search_public_observations: add stainReagent to per-observation output ──
--
-- The previous version exposed contrastMethod / mountReagent / sampleType
-- via the "latest microscope image" heuristic. Stain lives on the same
-- column and is populated at capture time — we just weren't emitting
-- it. RETURNS TABLE is gaining a column, so we DROP + CREATE (PG will
-- reject a CREATE OR REPLACE that changes the return shape).
DROP FUNCTION IF EXISTS public.search_public_observations(
  integer, integer, text, text, text, text, date, date,
  boolean, boolean, text, text, text, text
);

CREATE FUNCTION public.search_public_observations(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_genus text DEFAULT NULL::text,
  p_species text DEFAULT NULL::text,
  p_country text DEFAULT NULL::text,
  p_region text DEFAULT NULL::text,
  p_date_from date DEFAULT NULL::date,
  p_date_to date DEFAULT NULL::date,
  p_has_spores boolean DEFAULT NULL::boolean,
  p_has_microscopy boolean DEFAULT NULL::boolean,
  p_contrast text DEFAULT NULL::text,
  p_mount text DEFAULT NULL::text,
  p_sample text DEFAULT NULL::text,
  p_observer text DEFAULT NULL::text
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
  "contrastMethod" text,
  "mountReagent" text,
  "sampleType" text,
  "stainReagent" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    -- Make the active prep filters visible to the LATERALs below so
    -- latest_image can prefer a matching-prep image over the newest
    -- non-matching one. Without this a query like
    --   search_public_observations(p_sample := 'fresh')
    -- could still return sampleType = 'dried' when the newest
    -- microscope image happens to be a dried spore print.
    CROSS JOIN normalized n
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.stain
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (n.contrast IS NULL OR lower(btrim(coalesce(i.contrast, '')))     = lower(btrim(n.contrast)))
        AND (n.mount    IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = lower(btrim(n.mount)))
        AND (n.sample   IS NULL OR lower(btrim(coalesce(i.sample_type, '')))  = lower(btrim(n.sample)))
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
    nullif(lower(btrim(coalesce(e.sample_type, ''))), '') AS "sampleType",
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
        AND lower(btrim(coalesce(i2.sample_type, ''))) = lower(btrim(n.sample))
    ))
  ORDER BY e.observed_on DESC, e.id DESC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$$;

ALTER FUNCTION public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_observations(integer, integer, text, text, text, text, date, date, boolean, boolean, text, text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
