-- Stage: batch-capable, owner-aware read contract for microscopy presentation data.
--
-- get_observation_microscopy_presentations(p_observation_ids bigint[])
--
-- Returns one row per AUTHORIZED observation in the input array.
-- Owners see their own observations regardless of visibility or draft state.
-- Non-owners see only non-draft, published observations that pass
-- can_read_observation (handles banned authors and block relationships).
-- Spore fields (count, summary, mosaic) are withheld (NULL) when
-- can_access_spore_data returns false; the observation row is still returned.
--
-- Input is deduped and hard-capped at 200 distinct ids; >200 raises an error.
-- spore_counts/latest_mosaic/best_summary are gated on spore_accessible_obs
-- so callers denied spore data never pay for those aggregates.
--
-- No raw storage_key is exposed. The mosaic URL is built via the Worker
-- helper build_worker_mosaic_url. Latest mosaic selected: version DESC, id DESC.
-- Spore measurement count covers only active (non-deleted, non-purged)
-- microscope images with accepted measurement types.
-- sporeSummary is projected via an explicit allowlist — no internal fields
-- (id, user_id, observation_id, context_hash, created_at, updated_at) leak.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_observation_microscopy_presentations(
  p_observation_ids bigint[]
)
RETURNS TABLE (
  "observationId"          bigint,
  "sporeMeasurementCount"  bigint,
  "sporeSummary"           jsonb,
  "sporeMosaic"            jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ids bigint[];
BEGIN
  -- Dedupe non-null ids, then enforce the 200-id hard cap with an explicit error.
  SELECT array_agg(DISTINCT v ORDER BY v)
    INTO v_ids
    FROM unnest(p_observation_ids) v
    WHERE v IS NOT NULL;

  IF coalesce(array_length(v_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION
      'get_observation_microscopy_presentations: too many observation ids (max 200)';
  END IF;

  RETURN QUERY
  WITH accessible_obs AS (
    -- Owners see their own observations unconditionally (draft, private, etc.).
    -- Non-owners see only non-draft observations that pass can_read_observation,
    -- which internally enforces banned-author and block-relationship checks.
    -- The belt-and-suspenders banned/blocked guards below are kept for
    -- consistency with other read RPCs in this codebase.
    SELECT o.id, o.user_id, o.spore_data_visibility
    FROM public.observations o
    WHERE o.id = ANY(v_ids)
      AND (
        o.user_id = auth.uid()
        OR (
          NOT COALESCE(o.is_draft, false)
          AND public.can_read_observation(o.user_id, o.visibility)
          AND NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = o.user_id AND p.is_banned = true
          )
          AND (
            auth.uid() IS NULL
            OR NOT public.is_blocked_between(auth.uid(), o.user_id)
          )
        )
      )
  ),
  spore_accessible_obs AS (
    -- Subset of accessible observations where the caller may also read spore data.
    -- Spore CTEs join here so denied callers never pay for those aggregates.
    SELECT ao.id, ao.user_id, ao.spore_data_visibility
    FROM accessible_obs ao
    WHERE ao.user_id = auth.uid()
       OR public.can_access_spore_data(ao.user_id, ao.spore_data_visibility)
  ),
  spore_counts AS (
    -- Count active, non-purged microscope measurements using the repo-standard
    -- accepted measurement-type filter. Only computed for spore-accessible obs.
    SELECT oi.observation_id, count(sm.id) AS cnt
    FROM public.spore_measurements sm
    JOIN public.observation_images oi ON oi.id = sm.image_id
    JOIN spore_accessible_obs sao ON sao.id = oi.observation_id
    WHERE oi.image_type = 'microscope'
      AND oi.deleted_at IS NULL
      AND oi.purged_at IS NULL
      AND (
        sm.measurement_type IS NULL
        OR sm.measurement_type = ''
        OR lower(sm.measurement_type) IN ('manual', 'spore', 'spores')
      )
    GROUP BY oi.observation_id
  ),
  latest_mosaic AS (
    -- One mosaic row per observation: latest by version DESC, id DESC.
    -- Only computed for spore-accessible observations.
    SELECT DISTINCT ON (m.observation_id)
      m.observation_id,
      m.id            AS mosaic_id,
      m.media_version,
      m.width_px,
      m.height_px,
      m.version,
      m.tile_width_px,
      m.tile_height_px,
      m.common_crop_width_um,
      m.common_crop_height_um
    FROM public.spore_measurement_mosaics m
    JOIN spore_accessible_obs sao ON sao.id = m.observation_id
    ORDER BY m.observation_id, m.version DESC, m.id DESC
  ),
  best_summary AS (
    -- One summary row per observation: most recently computed.
    -- Projected via an explicit allowlist — no id, user_id, observation_id,
    -- context_hash, created_at, or updated_at fields are included.
    -- Only computed for spore-accessible observations.
    SELECT DISTINCT ON (s.observation_id)
      s.observation_id,
      jsonb_build_object(
        'context_json',       s.context_json,
        'measurement_type',   s.measurement_type,
        'sample_type',        s.sample_type,
        'mount_reagent',      s.mount_reagent,
        'stain_reagent',      s.stain_reagent,
        'contrast_method',    s.contrast_method,
        'n_spores',           s.n_spores,
        'n_paired',           s.n_paired,
        'n_length',           s.n_length,
        'n_width',            s.n_width,
        'length_min_um',      s.length_min_um,
        'length_p05_um',      s.length_p05_um,
        'length_mean_um',     s.length_mean_um,
        'length_median_um',   s.length_median_um,
        'length_p95_um',      s.length_p95_um,
        'length_max_um',      s.length_max_um,
        'length_sd_um',       s.length_sd_um,
        'width_min_um',       s.width_min_um,
        'width_p05_um',       s.width_p05_um,
        'width_mean_um',      s.width_mean_um,
        'width_median_um',    s.width_median_um,
        'width_p95_um',       s.width_p95_um,
        'width_max_um',       s.width_max_um,
        'width_sd_um',        s.width_sd_um,
        'q_min',              s.q_min,
        'q_p05',              s.q_p05,
        'q_mean',             s.q_mean,
        'q_median',           s.q_median,
        'q_p95',              s.q_p95,
        'q_max',              s.q_max,
        'q_sd',               s.q_sd,
        'stats_version',      s.stats_version,
        'computed_at',        s.computed_at,
        'source_app',         s.source_app,
        'source_app_version', s.source_app_version
      ) AS summary_json
    FROM public.observation_spore_summaries s
    JOIN spore_accessible_obs sao ON sao.id = s.observation_id
    ORDER BY s.observation_id, s.computed_at DESC NULLS LAST, s.id DESC
  )
  SELECT
    ao.id AS "observationId",

    -- sporeMeasurementCount: 0 when spore-accessible with no measurements,
    -- NULL when spore data is denied (sao.id IS NULL).
    CASE
      WHEN sao.id IS NOT NULL THEN COALESCE(sc.cnt, 0)
      ELSE NULL
    END AS "sporeMeasurementCount",

    -- sporeSummary and sporeMosaic: already NULL when denied because the CTEs
    -- only produce rows for spore_accessible_obs.
    bs.summary_json AS "sporeSummary",

    CASE
      WHEN lm.mosaic_id IS NOT NULL
        THEN jsonb_build_object(
          'mosaicId',           lm.mosaic_id,
          'mosaicMediaVersion', lm.media_version,
          'mosaicMediaUrl',     public.build_worker_mosaic_url(lm.mosaic_id, lm.media_version),
          'width',              lm.width_px,
          'height',             lm.height_px,
          'version',            lm.version,
          'tileWidthPx',        lm.tile_width_px,
          'tileHeightPx',       lm.tile_height_px,
          'commonCropWidthUm',  lm.common_crop_width_um,
          'commonCropHeightUm', lm.common_crop_height_um
        )
      ELSE NULL
    END AS "sporeMosaic"

  FROM accessible_obs ao
  LEFT JOIN spore_accessible_obs sao ON sao.id = ao.id
  LEFT JOIN spore_counts sc ON sc.observation_id = ao.id
  LEFT JOIN latest_mosaic lm ON lm.observation_id = ao.id
  LEFT JOIN best_summary bs ON bs.observation_id = ao.id;
END $$;

REVOKE ALL ON FUNCTION public.get_observation_microscopy_presentations(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_observation_microscopy_presentations(bigint[])
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_observation_microscopy_presentations(bigint[]) IS
  'Batch read contract for mobile microscopy presentation data. '
  'Returns one row per authorized observation (up to 200 deduped ids; >200 raises). '
  'Owners see their own draft/private observations. '
  'Non-owners see only published, non-draft observations that pass can_read_observation. '
  'Spore fields are NULL when can_access_spore_data is false; those aggregates are never computed. '
  'Never exposes raw storage keys or internal summary fields.';

COMMIT;
