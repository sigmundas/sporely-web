-- Taxonomy-v2 closeout Stage 2 Part B — make the coupled identification change
-- atomic in the DATABASE rather than compensated in the client.
--
-- An observation's identification is three things that must agree:
--
--   * `selected_sporely_taxon_id`  — the bound Sporely concept;
--   * `taxon_identity_*`           — how that binding was established, or the
--                                    preserved external identifier if it was not;
--   * `genus` / `species` / `common_name` — the accepted name.
--
-- Until now the client wrote them in separate statements: the guarded RPC, then
-- a provenance UPDATE, then a name UPDATE. Every boundary between those writes
-- is a place the row can end up describing one taxon by name and another by
-- identity, and no client-side sequencing fixes that:
--
--   * ordering identity first leaves a bound concept with the old name when the
--     name write fails;
--   * ordering the name first leaves the new name beside the old concept when
--     the guarded RPC rejects the selection;
--   * compensating after a failure is not a transaction — the compensating
--     write can fail too, and then the split is simply unreported.
--
-- This function writes all of them in ONE statement, inside one function
-- invocation, so a failure at any point rolls the whole identification back and
-- the CHECK constraints are evaluated once against the final row. No client
-- ordering or compensation is required, and none is correct without this.
--
-- It does NOT cover the rest of an observation save (location, notes, GPS,
-- `ai_selected_*` provider history …). Those are genuinely independent of
-- identity and stay an ordinary UPDATE; `ai_selected_*` in particular is
-- suggestion history, which the plan requires be kept distinct from an accepted
-- identification.
--
-- Guards mirror `set_observation_selected_taxon_v2` exactly: authentication,
-- ownership, and membership of a non-null `p_sporely_taxon_id` in the active
-- taxonomy-v2 release. `_guard_selected_sporely_taxon_id_v2` gates on
-- `current_user`, so this SECURITY DEFINER function owned by `postgres` is
-- permitted to write the identity column; the guard continues to block every
-- ordinary client write.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_observation_identification_v2(
  p_observation_id bigint,
  p_sporely_taxon_id bigint,
  p_identity_state text,
  p_source_system text,
  p_namespace text,
  p_external_id text,
  p_raw_external_id text,
  p_write_name boolean,
  p_genus text,
  p_species text,
  p_common_name text
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

  -- An unresolved external identity may not carry a bound concept. Rejecting
  -- here rather than relying on the CHECK gives the caller a clear message.
  IF p_identity_state = 'external_unresolved' AND p_sporely_taxon_id IS NOT NULL THEN
    RAISE EXCEPTION
      'an external_unresolved identity cannot carry a selected_sporely_taxon_id'
      USING ERRCODE = '22023';
  END IF;

  -- ONE statement. Identity, provenance and the accepted name move together or
  -- not at all. `p_write_name = false` leaves the existing name untouched, for
  -- the case where a provider candidate was rejected as unusable and is being
  -- recorded only as history.
  UPDATE public.observations
     SET selected_sporely_taxon_id = p_sporely_taxon_id,
         taxon_identity_state = p_identity_state,
         taxon_identity_source_system = p_source_system,
         taxon_identity_namespace = p_namespace,
         taxon_identity_external_id = p_external_id,
         taxon_identity_raw_external_id = p_raw_external_id,
         genus = CASE WHEN p_write_name THEN p_genus ELSE genus END,
         species = CASE WHEN p_write_name THEN p_species ELSE species END,
         common_name = CASE WHEN p_write_name THEN p_common_name ELSE common_name END
   WHERE id = p_observation_id
     AND user_id = auth.uid();
END
$$;

ALTER FUNCTION public.set_observation_identification_v2(
  bigint, bigint, text, text, text, text, text, boolean, text, text, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_observation_identification_v2(
  bigint, bigint, text, text, text, text, text, boolean, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_observation_identification_v2(
  bigint, bigint, text, text, text, text, text, boolean, text, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_observation_identification_v2(
  bigint, bigint, text, text, text, text, text, boolean, text, text, text
) IS
  'Taxonomy-v2 closeout Stage 2. Writes an observation''s bound concept, its '
  'identity provenance and its accepted name in ONE statement, so the three '
  'cannot end up describing different taxa. Same guards as '
  'set_observation_selected_taxon_v2 (auth, ownership, active-release '
  'membership). Does not touch ai_selected_* provider history, which is '
  'suggestion history rather than an accepted identification.';

COMMIT;
