-- Taxonomy-v2 closeout Stage 2 Part B — make the identity/state transition
-- coherent inside the guarded RPC.
--
-- 20260922120000 added `taxon_identity_state` plus
-- `observations_unresolved_identity_has_no_selection_check`, which forbids a
-- non-null `selected_sporely_taxon_id` while the state is
-- `external_unresolved`. That invariant is correct, but on its own it DEADLOCKS
-- the transition it is supposed to describe:
--
--   * `set_observation_selected_taxon_v2` updates only
--     `selected_sporely_taxon_id`;
--   * so once a row is `external_unresolved`, every later attempt to bind an
--     identity — a successful `resolve_taxon_external_id_v2` resolution, an
--     explicit native-picker selection, or a desktop-originated RPC write —
--     violates the constraint and fails.
--
-- Splitting the write between client and RPC cannot fix this: the constraint is
-- evaluated per statement, so the id and the state must move together. The RPC
-- is the only writer permitted to touch `selected_sporely_taxon_id` (enforced by
-- `_guard_selected_sporely_taxon_id_v2`), so it is the only place the paired
-- transition can live.
--
-- Behaviour added, on top of the 20260831152354 body which is otherwise
-- preserved verbatim (auth, ownership, active-release membership, and the
-- no-op-avoiding `IS DISTINCT FROM` guard):
--
--   * binding an identity (`p_sporely_taxon_id IS NOT NULL`) also sets
--     `taxon_identity_state = 'sporely_v2'`. Any preserved
--     `(source_system, namespace, external_id, raw_external_id)` is KEPT, so a
--     resolution stays auditable — only the state advances;
--   * clearing an identity (`p_sporely_taxon_id IS NULL`) leaves a preserved
--     external identifier alone and only retires a `sporely_v2` state. An
--     explicit clear must not destroy source evidence, and it must not
--     resurrect an `external_unresolved` claim either, so the state goes to
--     NULL ("no provenance recorded") rather than to `external_unresolved`.
--
-- This is additive to existing rows: a row with NULL provenance that binds an
-- identity simply gains `sporely_v2`.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_observation_selected_taxon_v2(
  p_observation_id bigint,
  p_sporely_taxon_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.observations o
    WHERE o.id = p_observation_id
      AND o.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'observation not found or caller does not own it'
      USING ERRCODE = '42501';
  END IF;

  IF p_sporely_taxon_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.taxonomy_v2_releases r
    JOIN public.taxonomy_v2_taxa t ON t.release_id = r.release_id
    WHERE r.status = 'active'
      AND t.sporely_taxon_id = p_sporely_taxon_id
  ) THEN
    RAISE EXCEPTION
      'sporely_taxon_id % is missing from the active taxonomy-v2 release',
      p_sporely_taxon_id
      USING ERRCODE = '22023';
  END IF;

  -- The id and the state move in ONE statement so
  -- `observations_unresolved_identity_has_no_selection_check` is never
  -- transiently violated.
  UPDATE public.observations
     SET selected_sporely_taxon_id = p_sporely_taxon_id,
         taxon_identity_state = CASE
           WHEN p_sporely_taxon_id IS NOT NULL THEN 'sporely_v2'
           -- Clearing: retire a bound state, but never overwrite a preserved
           -- external identifier's own state with something it did not earn.
           WHEN taxon_identity_state = 'sporely_v2' THEN NULL
           ELSE taxon_identity_state
         END
   WHERE id = p_observation_id
     AND user_id = auth.uid()
     AND (
       selected_sporely_taxon_id IS DISTINCT FROM p_sporely_taxon_id
       OR taxon_identity_state IS DISTINCT FROM CASE
            WHEN p_sporely_taxon_id IS NOT NULL THEN 'sporely_v2'
            WHEN taxon_identity_state = 'sporely_v2' THEN NULL
            ELSE taxon_identity_state
          END
     );
END
$$;

ALTER FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint) IS
  'Guarded owner-selected taxonomy identity writer. The ONLY permitted writer '
  'of public.observations.selected_sporely_taxon_id. Requires auth.uid(), '
  'enforces ownership, requires membership in the active taxonomy-v2 release, '
  'and (taxonomy-v2 closeout Stage 2) moves taxon_identity_state in the same '
  'statement so the unresolved -> resolved transition cannot violate '
  'observations_unresolved_identity_has_no_selection_check. Preserved external '
  '(source_system, namespace, external_id) evidence is retained across the '
  'transition so a resolution stays auditable.';

COMMIT;
