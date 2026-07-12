-- Structured per-observation spore statistics, keyed by measurement context.
--
-- One row per (observation_id, context_hash). "Context" is the combination of
-- measurement_type + preparation prep-fields (sample_type, mount_reagent,
-- stain_reagent, contrast_method). Observations with measurements taken under
-- different preparations get multiple rows so their L/W/Q means are never
-- silently mixed (e.g. dried KOH DIC vs fresh water brightfield).
--
-- The numeric summary columns are the source of truth for structured species-
-- level statistics. The legacy `observations.spore_statistics` jsonb field is
-- left untouched and remains the source for the human-readable literature
-- string; it is not parsed to fill this table.
--
-- IMPORTANT statistical rule (see sporely-py/docs/spore-statistics-species-
-- profiles.md): species-level canonical means MUST be unweighted arithmetic
-- means of the per-observation `*_mean_um` and `q_mean` values in this table.
-- Do NOT compute species means by weighting each row by `n_paired` or
-- `n_spores`; those are inclusion thresholds and quality signals, never
-- weights. `q_mean` is the arithmetic mean of individual length_i/width_i
-- ratios across paired measurements, not `length_mean_um / width_mean_um`.

CREATE TABLE IF NOT EXISTS public.observation_spore_summaries (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  observation_id          bigint NOT NULL REFERENCES public.observations(id) ON DELETE CASCADE,
  user_id                 uuid   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  context_hash            text   NOT NULL,
  context_json            jsonb  NOT NULL DEFAULT '{}'::jsonb,

  measurement_type        text   NOT NULL DEFAULT 'spore',

  sample_type             text,
  mount_reagent           text,
  stain_reagent           text,
  contrast_method         text,

  n_spores                integer NOT NULL DEFAULT 0,
  n_paired                integer NOT NULL DEFAULT 0,
  n_length                integer NOT NULL DEFAULT 0,
  n_width                 integer NOT NULL DEFAULT 0,

  length_min_um           double precision,
  length_p05_um           double precision,
  length_mean_um          double precision,
  length_median_um        double precision,
  length_p95_um           double precision,
  length_max_um           double precision,
  length_sd_um            double precision,

  width_min_um            double precision,
  width_p05_um            double precision,
  width_mean_um           double precision,
  width_median_um         double precision,
  width_p95_um            double precision,
  width_max_um            double precision,
  width_sd_um             double precision,

  q_min                   double precision,
  q_p05                   double precision,
  q_mean                  double precision,
  q_median                double precision,
  q_p95                   double precision,
  q_max                   double precision,
  q_sd                    double precision,

  stats_version           integer NOT NULL DEFAULT 1,
  computed_at             timestamp with time zone NOT NULL DEFAULT now(),
  source_app              text,
  source_app_version      text,

  created_at              timestamp with time zone NOT NULL DEFAULT now(),
  updated_at              timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT observation_spore_summaries_obs_context_uk
    UNIQUE (observation_id, context_hash),
  CONSTRAINT observation_spore_summaries_n_spores_chk       CHECK (n_spores  >= 0),
  CONSTRAINT observation_spore_summaries_n_paired_chk       CHECK (n_paired  >= 0),
  CONSTRAINT observation_spore_summaries_n_length_chk       CHECK (n_length  >= 0),
  CONSTRAINT observation_spore_summaries_n_width_chk        CHECK (n_width   >= 0),
  CONSTRAINT observation_spore_summaries_stats_version_chk  CHECK (stats_version >= 1),
  CONSTRAINT observation_spore_summaries_context_hash_nonempty_chk
    CHECK (btrim(context_hash) <> ''),
  CONSTRAINT observation_spore_summaries_context_json_object_chk
    CHECK (jsonb_typeof(context_json) = 'object')
);

COMMENT ON TABLE public.observation_spore_summaries IS
  'Structured per-observation spore statistics keyed by measurement context. '
  'Species-level canonical means MUST be unweighted arithmetic means of the '
  'per-observation *_mean_um / q_mean values; never weight by n_spores or n_paired.';

COMMENT ON COLUMN public.observation_spore_summaries.context_hash IS
  'sha256 hex of the normalized context JSON (measurement_type, sample_type, mount_reagent, stain_reagent, contrast_method) computed by the writer.';
COMMENT ON COLUMN public.observation_spore_summaries.context_json IS
  'Normalized context object used to derive context_hash. Exposed via RPCs for debugging and filtering.';
COMMENT ON COLUMN public.observation_spore_summaries.measurement_type IS
  'Kind of structure summarized (default ''spore''). Distinct from spore_measurements.measurement_type, which stores raw-measurement provenance (''manual''/''spore'').';
COMMENT ON COLUMN public.observation_spore_summaries.length_mean_um IS
  'Arithmetic mean of length_um values for this observation/context. Species profiles should average this value unweighted across observation summaries.';
COMMENT ON COLUMN public.observation_spore_summaries.width_mean_um IS
  'Arithmetic mean of width_um values for this observation/context. Species profiles should average this value unweighted across observation summaries.';
COMMENT ON COLUMN public.observation_spore_summaries.q_mean IS
  'Mean of individual length_i/width_i ratios across paired measurements. Do NOT derive from length_mean_um / width_mean_um.';
COMMENT ON COLUMN public.observation_spore_summaries.n_paired IS
  'Count of measurements with both length_um and width_um valid. Inclusion threshold for species profiles, never a weight.';
COMMENT ON COLUMN public.observation_spore_summaries.stats_version IS
  'Bump when the writer changes percentile convention, SD convention, or any semantic that would invalidate stored values without a row rewrite.';

-- Indexes matching the queries expected in Stage E RPCs (per-observation
-- lookup for species views), Stage D backfill (per-user replays), and
-- Stage C context-based analytics.
CREATE INDEX IF NOT EXISTS observation_spore_summaries_observation_idx
  ON public.observation_spore_summaries (observation_id);
CREATE INDEX IF NOT EXISTS observation_spore_summaries_user_idx
  ON public.observation_spore_summaries (user_id);
CREATE INDEX IF NOT EXISTS observation_spore_summaries_context_idx
  ON public.observation_spore_summaries (context_hash);
-- Combined-context index for Stage E RPC filters that fan out by preparation
-- (measurement_type + sample_type + mount_reagent + stain_reagent + contrast_method).
-- Column order follows the fixed key order used by the writer when serializing
-- the canonical context JSON, so partial-prefix filters (measurement_type,
-- measurement_type+sample_type, etc.) can also use this index.
CREATE INDEX IF NOT EXISTS observation_spore_summaries_measurement_context_idx
  ON public.observation_spore_summaries
     (measurement_type, sample_type, mount_reagent, stain_reagent, contrast_method);

-- RLS: owner-scoped writes. The second EXISTS() check prevents an
-- authenticated user from attaching a summary (with their own user_id) to
-- someone else's observation. Without it, Stage E public RPCs that join
-- through observations.spore_data_visibility would happily surface the
-- attacker-written row on the victim's public observation. Mirrors the
-- pattern established in 20260702100000_add_spore_measurement_mosaics.sql.
--
-- Public reads MUST go through the Stage E RPCs. Those RPCs re-gate on
-- can_access_spore_data(owner_id, spore_data_visibility) exactly like the
-- existing per-observation spore RPCs. No SELECT policy for anon/other
-- authenticated users is added here.
ALTER TABLE public.observation_spore_summaries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "observation_spore_summaries: owner full"
  ON public.observation_spore_summaries;
CREATE POLICY "observation_spore_summaries: owner full"
  ON public.observation_spore_summaries
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.observations o
      WHERE o.id = observation_spore_summaries.observation_id
        AND o.user_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.observations o
      WHERE o.id = observation_spore_summaries.observation_id
        AND o.user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.observation_spore_summaries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.observation_spore_summaries TO service_role;

-- Reuse the project's existing updated_at helper (public.set_updated_at,
-- defined in the baseline migration) so callers never have to remember to
-- touch updated_at manually. Same pattern as trg_observations_updated_at /
-- trg_friendships_updated_at / trg_profiles_updated_at.
CREATE OR REPLACE TRIGGER trg_observation_spore_summaries_updated_at
  BEFORE UPDATE ON public.observation_spore_summaries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Refresh PostgREST so sporely-py can start writing to this table (once the
-- Stage C/D writer ships) without waiting for the periodic schema-cache
-- reload.
NOTIFY pgrst, 'reload schema';
