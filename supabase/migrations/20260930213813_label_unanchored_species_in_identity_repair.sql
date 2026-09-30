-- Taxonomy v3 Stage 1B follow-up: truthful label for unanchored species.
--
-- The 2026-09-30 Stage 1B apply recorded `new_contribution = 'not_species'`
-- for promotions to 617026 (Conocybe vexans) and 55368 (Psilocybe
-- semilanceata). Both are rank species in the active release; they are not
-- species rows in taxonomy_v3.registry_concept, which sharing requires. The
-- label claimed the wrong reason.
--
-- This re-creates private._taxon_identity_repair_reconcile_references with
-- one change: when the new taxon is not a registry species, it records
-- 'not_registry_species' if the taxon is a species in the active release,
-- and 'not_species' otherwise. Share eligibility, exposure and every other
-- branch are unchanged (plan
-- docs/plans/active/2026-09-30-reference-share-eligibility.md, Stage 1;
-- owner decision 1: no widening). Rows already recorded stay as they are.

BEGIN;

CREATE OR REPLACE FUNCTION private._taxon_identity_repair_reconcile_references(
  p_run_id bigint,
  p_observation_id bigint
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_obs record;
  v_old bigint;
  v_new bigint;
  v_set uuid;
  v_old_action text;
  v_new_action text;
  v_revisions record;
  v_result jsonb;
  v_status text;
  v_count integer := 0;
BEGIN
  SELECT o.id, o.user_id, o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id
    INTO v_obs
    FROM public.observations o
   WHERE o.id = p_observation_id;
  -- Every candidate had selected_sporely_taxon_id NULL (CHECK), so the
  -- effective taxon before the UPDATE was resolved_sporely_taxon_id.
  v_old := v_obs.resolved_sporely_taxon_id;
  v_new := v_obs.selected_sporely_taxon_id;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'observation % was not promoted; cannot reconcile references', p_observation_id;
  END IF;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN 0;
  END IF;

  FOR v_set IN
    SELECT DISTINCT u.reference_measurement_set_id
      FROM public.observation_reference_uses u
     WHERE u.user_id = v_obs.user_id AND u.observation_id = v_obs.id
       AND u.deleted_at IS NULL
     ORDER BY u.reference_measurement_set_id
  LOOP
    -- Old taxon: withdraw unless another live use still carries it.
    IF v_old IS NULL THEN
      v_old_action := 'none';
    ELSIF EXISTS (
      SELECT 1
        FROM public.observation_reference_uses other_use
        JOIN public.observations other_obs
          ON other_obs.user_id = other_use.user_id AND other_obs.id = other_use.observation_id
       WHERE other_use.user_id = v_obs.user_id
         AND other_use.reference_measurement_set_id = v_set
         AND other_use.deleted_at IS NULL
         AND coalesce(other_obs.selected_sporely_taxon_id, other_obs.resolved_sporely_taxon_id) = v_old
    ) THEN
      v_old_action := 'kept_by_other_use';
    ELSE
      UPDATE private.shared_reference_contributions c
         SET status = 'withdrawn',
             withdrawn_at = coalesce(c.withdrawn_at, pg_catalog.clock_timestamp()),
             updated_at = pg_catalog.clock_timestamp()
       WHERE c.owner_id = v_obs.user_id
         AND c.source_measurement_set_id = v_set
         AND c.sporely_taxon_id = v_old
         AND c.status = 'shared';
      IF EXISTS (
        SELECT 1 FROM private.shared_reference_contributions c
         WHERE c.owner_id = v_obs.user_id AND c.source_measurement_set_id = v_set
           AND c.sporely_taxon_id = v_old AND c.status = 'shared'
      ) THEN
        RAISE EXCEPTION 'contribution for set % under old taxon % is still shared', v_set, v_old;
      END IF;
      v_old_action := CASE WHEN EXISTS (
        SELECT 1 FROM private.shared_reference_contributions c
         WHERE c.owner_id = v_obs.user_id AND c.source_measurement_set_id = v_set
           AND c.sporely_taxon_id = v_old
      ) THEN 'withdrawn' ELSE 'none' END;
    END IF;

    -- New taxon: share when it is a species concept in the taxonomy-v3
    -- registry and the source is live, the same eligibility the owner path
    -- applies. A species of the active release that has no registry species
    -- row is recorded as not_registry_species: it is a species, just not a
    -- shareable anchor. Everything else stays not_species. Label only; which
    -- taxa can share is unchanged.
    IF NOT EXISTS (
      SELECT 1 FROM taxonomy_v3.registry_concept rc
       WHERE rc.sporely_taxon_id = v_new AND rc.rank = 'species'
    ) THEN
      v_new_action := CASE WHEN EXISTS (
        SELECT 1 FROM public.taxonomy_v2_taxa t
         WHERE t.release_id = private._taxon_identity_repair_active_release()
           AND t.sporely_taxon_id = v_new
           AND t.taxon_rank = 'species'
      ) THEN 'not_registry_species' ELSE 'not_species' END;
    ELSE
      SELECT w.revision AS work_revision, t.revision AS treatment_revision, m.revision AS set_revision
        INTO v_revisions
        FROM public.reference_measurement_sets m
        JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
        JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
       WHERE m.user_id = v_obs.user_id AND m.id = v_set
         AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL;
      IF NOT FOUND THEN
        v_new_action := 'source_deleted';
      ELSE
        v_result := private.share_reference_contribution_for_owner(
          v_obs.user_id, v_set, v_new::integer,
          v_revisions.work_revision, v_revisions.treatment_revision, v_revisions.set_revision
        );
        v_status := v_result->>'status';
        IF v_status IN ('created', 'updated', 'no_change') THEN
          IF NOT EXISTS (
            SELECT 1 FROM private.shared_reference_contributions c
             WHERE c.owner_id = v_obs.user_id AND c.source_measurement_set_id = v_set
               AND c.sporely_taxon_id = v_new AND c.status = 'shared'
          ) THEN
            RAISE EXCEPTION 'share for set % under taxon % reported % but is not shared',
              v_set, v_new, v_status;
          END IF;
          v_new_action := 'shared';
        ELSIF v_status IN ('account_unavailable', 'source_out_of_bounds') THEN
          -- Not shareable on the owner path either; recorded, not an error.
          v_new_action := 'not_shareable:' || v_status;
        ELSE
          RAISE EXCEPTION 'reference reconciliation for observation % set % failed: %',
            v_obs.id, v_set, coalesce(v_status, v_result::text);
        END IF;
      END IF;
    END IF;

    INSERT INTO private.taxon_identity_repair_reference_actions(
      run_id, observation_id, reference_measurement_set_id,
      old_sporely_taxon_id, new_sporely_taxon_id, old_contribution, new_contribution
    ) VALUES (p_run_id, v_obs.id, v_set, v_old, v_new, v_old_action, v_new_action);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;

ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
