-- Public RPC for structured observation-level spore summary rows.
--
-- Reads from public.observation_spore_summaries (created by the Stage B
-- migration 20260712120000_add_observation_spore_summaries.sql). The RLS
-- policy on that table only grants owner-full access — this RPC uses
-- SECURITY DEFINER to serve public consumers, and re-gates every returned
-- row through the same visibility helpers as the existing public spore
-- RPCs:
--
--   * can_read_observation(owner_id, visibility)  — owner / friends / public
--     visibility for the observation itself, plus banned-profile and
--     blocked-user exclusions.
--   * can_access_spore_data(owner_id, spore_data_visibility) — owner /
--     friends / public visibility specifically for the spore data.
--   * NOT is_draft — drafts never expose spore data.
--
-- Returned rows always carry `mean_source = 'measured'` because the source
-- table only stores real per-observation means. Legacy midpoint estimates
-- from observations.spore_statistics are NOT parsed here — legacy text
-- fallbacks belong in the Stage F landing compatibility layer, not on this
-- RPC's contract.
--
-- Anonymous callers get exactly the same rows as an unauthenticated
-- session hitting can_read_observation / can_access_spore_data — i.e.
-- `visibility = 'public'` AND `spore_data_visibility = 'public'`.
--
-- No direct SELECT policy on public.observation_spore_summaries is added:
-- public access is exclusively through this RPC.

CREATE OR REPLACE FUNCTION public.get_public_observation_spore_summaries(
  p_observation_ids bigint[]
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
  WHERE s.observation_id = ANY(coalesce(p_observation_ids, ARRAY[]::bigint[]))
    AND NOT coalesce(o.is_draft, false)
    AND public.can_read_observation(o.user_id, o.visibility)
    AND public.can_access_spore_data(o.user_id, o.spore_data_visibility);
$$;

ALTER FUNCTION public.get_public_observation_spore_summaries(bigint[])
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_observation_spore_summaries(bigint[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_summaries(bigint[])
  TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_summaries(bigint[])
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_summaries(bigint[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
