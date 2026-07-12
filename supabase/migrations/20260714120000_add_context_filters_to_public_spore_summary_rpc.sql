-- Extend public.get_public_observation_spore_summaries with optional
-- preparation-context filters (Stage H).
--
-- Callers can now narrow the returned summary rows by their normalized
-- context fields (sample_type, mount_reagent, stain_reagent,
-- contrast_method). Semantics:
--
--   * NULL or empty filter -> no restriction on that field.
--   * Filter is trimmed and lower-cased before comparison. Row values are
--     trimmed and lower-cased the same way.
--   * A NULL / empty row value does NOT match an active non-empty filter
--     (i.e. filters are exclusive when the row has no stored context).
--   * Every non-empty filter must match the SAME summary row — different
--     filters cannot be satisfied by different context rows on the same
--     observation.
--
-- Visibility semantics are unchanged from the Stage E migration
-- (20260713120000_add_public_spore_summary_rpc.sql):
--   * NOT is_draft
--   * can_read_observation(user_id, visibility)
--   * can_access_spore_data(user_id, spore_data_visibility)
-- The RLS policy on public.observation_spore_summaries stays owner-only;
-- no direct anon SELECT is granted here.
--
-- Signature change: the argument list is different from the Stage E
-- function, so DROP + CREATE OR REPLACE is required. The old
-- single-argument variant is removed to avoid PostgREST ambiguity when
-- callers omit the new arguments.

DROP FUNCTION IF EXISTS public.get_public_observation_spore_summaries(bigint[]);

CREATE OR REPLACE FUNCTION public.get_public_observation_spore_summaries(
  p_observation_ids  bigint[],
  p_sample_type      text DEFAULT NULL,
  p_mount_reagent    text DEFAULT NULL,
  p_stain_reagent    text DEFAULT NULL,
  p_contrast_method  text DEFAULT NULL
)
RETURNS TABLE(
  observation_id       bigint,
  contributor_label    text,
  context_hash         text,
  context_json         jsonb,
  measurement_type     text,
  sample_type          text,
  mount_reagent        text,
  stain_reagent        text,
  contrast_method      text,
  n_spores             integer,
  n_paired             integer,
  n_length             integer,
  n_width              integer,
  length_min_um        double precision,
  length_p05_um        double precision,
  length_mean_um       double precision,
  length_median_um     double precision,
  length_p95_um        double precision,
  length_max_um        double precision,
  length_sd_um         double precision,
  width_min_um         double precision,
  width_p05_um         double precision,
  width_mean_um        double precision,
  width_median_um      double precision,
  width_p95_um         double precision,
  width_max_um         double precision,
  width_sd_um          double precision,
  q_min                double precision,
  q_p05                double precision,
  q_mean               double precision,
  q_median             double precision,
  q_p95                double precision,
  q_max                double precision,
  q_sd                 double precision,
  stats_version        integer,
  computed_at          timestamp with time zone,
  source_app           text,
  source_app_version   text,
  mean_source          text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- Normalize each filter once: NULL / whitespace-only / empty becomes
  -- NULL, otherwise trimmed + lower-cased. Rows compare the same way.
  WITH filters AS (
    SELECT
      NULLIF(lower(btrim(coalesce(p_sample_type,     ''))), '') AS sample_type,
      NULLIF(lower(btrim(coalesce(p_mount_reagent,   ''))), '') AS mount_reagent,
      NULLIF(lower(btrim(coalesce(p_stain_reagent,   ''))), '') AS stain_reagent,
      NULLIF(lower(btrim(coalesce(p_contrast_method, ''))), '') AS contrast_method
  )
  SELECT
    s.observation_id,
    public.community_contributor_label(o.user_id, o.author) AS contributor_label,
    s.context_hash,
    s.context_json,
    s.measurement_type,
    s.sample_type,
    s.mount_reagent,
    s.stain_reagent,
    s.contrast_method,
    s.n_spores,
    s.n_paired,
    s.n_length,
    s.n_width,
    s.length_min_um,
    s.length_p05_um,
    s.length_mean_um,
    s.length_median_um,
    s.length_p95_um,
    s.length_max_um,
    s.length_sd_um,
    s.width_min_um,
    s.width_p05_um,
    s.width_mean_um,
    s.width_median_um,
    s.width_p95_um,
    s.width_max_um,
    s.width_sd_um,
    s.q_min,
    s.q_p05,
    s.q_mean,
    s.q_median,
    s.q_p95,
    s.q_max,
    s.q_sd,
    s.stats_version,
    s.computed_at,
    s.source_app,
    s.source_app_version,
    'measured'::text AS mean_source
  FROM public.observation_spore_summaries s
  JOIN public.observations o
    ON o.id = s.observation_id
  CROSS JOIN filters f
  WHERE s.observation_id = ANY(coalesce(p_observation_ids, ARRAY[]::bigint[]))
    AND NOT coalesce(o.is_draft, false)
    AND public.can_read_observation(o.user_id, o.visibility)
    AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
    AND (
      f.sample_type IS NULL
      OR lower(btrim(coalesce(s.sample_type, ''))) = f.sample_type
    )
    AND (
      f.mount_reagent IS NULL
      OR lower(btrim(coalesce(s.mount_reagent, ''))) = f.mount_reagent
    )
    AND (
      f.stain_reagent IS NULL
      OR lower(btrim(coalesce(s.stain_reagent, ''))) = f.stain_reagent
    )
    AND (
      f.contrast_method IS NULL
      OR lower(btrim(coalesce(s.contrast_method, ''))) = f.contrast_method
    );
$$;

ALTER FUNCTION public.get_public_observation_spore_summaries(bigint[], text, text, text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_observation_spore_summaries(bigint[], text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_summaries(bigint[], text, text, text, text)
  TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_summaries(bigint[], text, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_summaries(bigint[], text, text, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
