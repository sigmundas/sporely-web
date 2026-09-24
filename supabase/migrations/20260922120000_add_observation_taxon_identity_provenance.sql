-- Taxonomy-v2 closeout Stage 2 Part B — preserve a provider's external
-- taxonomy identifier on the observation.
--
-- An Artsorakel candidate carries a namespaced external identifier
-- (`NBIC:53482`), not a Sporely ID. The web client used to drop it unparsed,
-- so no resolution was ever attempted against `resolve_taxon_external_id_v2`
-- and the identity evidence was lost. Per
-- `database/taxonomy/docs/identity-contract.md` an external identifier is
-- authoritative only as the tuple `(source, namespace, external_id)`, and the
-- verbatim provider value must be retained — the numeric component alone is
-- meaningful only under an explicit, evidenced namespace bridge.
--
-- These columns are additive and nullable. They record what the client holds
-- and whether it resolved; they are NOT a second way to assert a Sporely
-- identity. `public.observations.selected_sporely_taxon_id` remains writable
-- only through `set_observation_selected_taxon_v2`, guarded by
-- `_guard_selected_sporely_taxon_id_v2`, and nothing here relaxes that.
--
-- Mirrors the desktop client's `observations.taxon_identity_*` columns so the
-- two clients describe identity provenance with one vocabulary.

BEGIN;

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS taxon_identity_state text,
  ADD COLUMN IF NOT EXISTS taxon_identity_source_system text,
  ADD COLUMN IF NOT EXISTS taxon_identity_namespace text,
  ADD COLUMN IF NOT EXISTS taxon_identity_external_id text,
  ADD COLUMN IF NOT EXISTS taxon_identity_raw_external_id text;

-- Only the two states the clients emit. A row predating this migration keeps
-- NULL, which means "no provenance recorded" and is distinct from
-- `external_unresolved` ("an identifier is held and has not resolved").
ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_taxon_identity_state_check;
ALTER TABLE public.observations
  ADD CONSTRAINT observations_taxon_identity_state_check
  CHECK (
    taxon_identity_state IS NULL
    OR taxon_identity_state IN ('sporely_v2', 'external_unresolved')
  );

-- An unresolved external identity must carry complete evidence: a partial
-- tuple cannot be offered to the resolver and is not auditable.
ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_taxon_identity_tuple_complete_check;
ALTER TABLE public.observations
  ADD CONSTRAINT observations_taxon_identity_tuple_complete_check
  CHECK (
    taxon_identity_state IS DISTINCT FROM 'external_unresolved'
    OR (
      nullif(btrim(taxon_identity_source_system), '') IS NOT NULL
      AND nullif(btrim(taxon_identity_namespace), '') IS NOT NULL
      AND nullif(btrim(taxon_identity_external_id), '') IS NOT NULL
    )
  );

-- An unresolved external identity may not coexist with a bound Sporely
-- concept: the whole point of the state is that nothing is bound. This is the
-- database-level expression of "do not copy the external integer into
-- sporely_taxon_id".
ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_unresolved_identity_has_no_selection_check;
ALTER TABLE public.observations
  ADD CONSTRAINT observations_unresolved_identity_has_no_selection_check
  CHECK (
    taxon_identity_state IS DISTINCT FROM 'external_unresolved'
    OR selected_sporely_taxon_id IS NULL
  );

COMMENT ON COLUMN public.observations.taxon_identity_state IS
  'Taxonomy-v2 Stage 2. NULL = no provenance recorded (pre-Stage-2 row). '
  '''sporely_v2'' = the identity in selected_sporely_taxon_id is proven. '
  '''external_unresolved'' = a namespaced provider identifier is preserved and '
  'has not resolved to a Sporely concept; the observation is still identified '
  'by its name columns and must NOT render as unidentified.';
COMMENT ON COLUMN public.observations.taxon_identity_source_system IS
  'Source system of the preserved external identifier, e.g. ''nortaxa''.';
COMMENT ON COLUMN public.observations.taxon_identity_namespace IS
  'Namespace of the preserved external identifier, e.g. ''nortaxa_taxon_id''. '
  'An identifier without a namespace is legacy/audit evidence only and may '
  'never be resolved to a Sporely ID.';
COMMENT ON COLUMN public.observations.taxon_identity_external_id IS
  'External identifier in the namespace above, as text.';
COMMENT ON COLUMN public.observations.taxon_identity_raw_external_id IS
  'The provider''s verbatim value, e.g. ''NBIC:53482''. Retained even after a '
  'declared namespace bridge, per identity-contract.md.';

COMMIT;
