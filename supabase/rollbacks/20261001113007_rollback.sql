-- Rollback of supabase/migrations/20261001113007_share_references_by_default.sql
-- (Stage 2d, docs/plans/active/2026-10-01-reference-sharing-default-on.md,
-- section "Rollback"). NOT a migration: kept outside supabase/migrations so
-- it never runs by accident. Tested end to end by
-- supabase/tests/shared_reference_rollback_test.sh.
--
-- One transaction, under the forward migration's table locks:
--   1. restores the fail-closed behaviour with share_basis-aware bodies:
--      * every refresh path is refresh-only again: the 6-argument entry point
--        private.share_reference_contribution_for_owner (used by every
--        trigger and Stage 1B) answers consent_required unless a shared,
--        consented row exists, checked under the profile and key locks;
--        share again only clears the opt-out and refreshes through it;
--      * the species-page read serves consented rows only;
--      * the observation read requires a consented, unhidden contribution
--        and the content proof again (the roles helper follows, as it reads
--        the same predicate);
--      * Stage 1B records consent_required again;
--   2. withdraws every automatic row with reason rollback.
-- Kept: columns, CHECKs, the opt-out table and every opt-out, the new owner
-- RPCs (stop keeps working; share again cannot share without consent).
-- No row stays shared without the opt-out check.
--
-- Promotion to a real migration (only if the forward migration was deployed
-- and must be undone): copy this file unchanged to
-- supabase/migrations/<new UTC timestamp>_rollback_reference_sharing_default_on.sql,
-- run supabase/tests/shared_reference_rollback_test.sh against it and the
-- fail-closed SQL tests of the 2c era (git show 7e5aac0:supabase/tests/...),
-- then deploy through the deploy tree like any migration. Never edit or
-- delete 20261001113007 itself once applied.

BEGIN;

LOCK TABLE public.observations,
           public.observation_reference_uses,
           public.reference_measurement_sets,
           public.reference_taxon_treatments,
           public.reference_works
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE private.reference_share_consent_texts,
           private.shared_reference_contributions,
           private.shared_reference_contribution_revisions,
           private.shared_reference_consent_events,
           private.reference_share_opt_outs
  IN ACCESS EXCLUSIVE MODE;

-- 1a. Refresh-only entry point (every trigger, Stage 1B).
CREATE OR REPLACE FUNCTION private.share_reference_contribution_for_owner(
  p_owner uuid,
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_owner IS NULL OR p_source_measurement_set_id IS NULL THEN
    RETURN private.reference_contribution_share_core(
      'refresh', p_owner, p_source_measurement_set_id, p_sporely_taxon_id
    );
  END IF;
  PERFORM 1 FROM public.profiles p WHERE p.id = p_owner FOR KEY SHARE;
  PERFORM private.lock_shared_reference_key(p_owner, p_source_measurement_set_id);
  IF NOT EXISTS (
    SELECT 1 FROM private.shared_reference_contributions c
     WHERE c.owner_id = p_owner
       AND c.source_measurement_set_id = p_source_measurement_set_id
       AND c.sporely_taxon_id = p_sporely_taxon_id
       AND c.status = 'shared' AND c.share_basis = 'consented'
  ) THEN
    RETURN private.shared_reference_contribution_result('consent_required');
  END IF;
  RETURN private.reference_contribution_share_core(
    'refresh', p_owner, p_source_measurement_set_id, p_sporely_taxon_id
  );
END
$$;

-- 1b. Share again: clears the opt-out; refreshes only consented rows.
CREATE OR REPLACE FUNCTION private.share_reference_set_again_for_owner(p_owner uuid, p_set uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
  v_taxon integer;
BEGIN
  PERFORM 1 FROM public.profiles p WHERE p.id = p_owner FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  PERFORM private.lock_shared_reference_key(p_owner, p_set);
  DELETE FROM private.reference_share_opt_outs o
   WHERE o.owner_id = p_owner AND o.source_measurement_set_id = p_set;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  FOR v_taxon IN
    SELECT c.sporely_taxon_id FROM private.shared_reference_contributions c
     WHERE c.owner_id = p_owner AND c.source_measurement_set_id = p_set
       AND c.status = 'shared' AND c.share_basis = 'consented'
     ORDER BY 1
  LOOP
    BEGIN
      PERFORM private.share_reference_contribution_for_owner(p_owner, p_set, v_taxon, NULL, NULL, NULL);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN CASE WHEN v_deleted > 0 THEN 'updated' ELSE 'no_change' END;
END
$$;

-- 1c. Species-page read: consented rows only.
CREATE OR REPLACE FUNCTION private.reference_contribution_is_served(
  p_contribution_id uuid,
  p_enforce_envelope_cap boolean DEFAULT true
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id = c.id AND r.revision = c.current_revision
      JOIN public.profiles p ON p.id = c.owner_id AND p.is_banned IS FALSE
     WHERE c.id = p_contribution_id
       AND c.status = 'shared' AND c.hidden_at IS NULL
       AND c.share_basis = 'consented'
       AND r.revision >= c.shared_first_revision
       AND NOT private.reference_set_opted_out(c.owner_id, c.source_measurement_set_id)
       AND NOT private.reference_set_has_hidden_contribution(c.owner_id, c.source_measurement_set_id)
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), c.owner_id) IS NOT TRUE)
       AND (p_enforce_envelope_cap IS FALSE
            OR pg_catalog.octet_length(r.envelope_json::text) <= 1048576)
  )
$$;

-- 1d. Observation read (and so the roles helper): fail closed again.
CREATE OR REPLACE FUNCTION private.observation_reference_use_is_served(p_use_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.observation_reference_uses u
      JOIN public.observations o
        ON o.user_id = u.user_id AND o.id = u.observation_id
      JOIN public.profiles p ON p.id = u.user_id AND p.is_banned IS FALSE
      JOIN public.reference_measurement_sets m
        ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
      JOIN public.reference_taxon_treatments t
        ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
      JOIN public.reference_works w
        ON w.user_id = t.user_id AND w.id = t.reference_work_id
     WHERE u.id = p_use_id
       AND u.deleted_at IS NULL
       AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
       AND o.visibility = 'public'
       AND o.is_draft IS FALSE
       AND o.spore_data_visibility = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.user_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), u.user_id) IS NOT TRUE)
       AND NOT private.reference_set_opted_out(u.user_id, u.reference_measurement_set_id)
       AND NOT private.reference_set_has_hidden_contribution(u.user_id, u.reference_measurement_set_id)
       AND private.public_reference_snapshot(
             u.snapshot_json, u.reference_measurement_set_id, u.reference_revision
           ) IS NOT NULL
       -- Fail closed (Stage 2a decision E): a consented, unhidden shared
       -- contribution for the observation's exact taxon, a qualifying use,
       -- and a frozen snapshot equal to a revision of its sharing period.
       AND EXISTS (
         SELECT 1
           FROM private.shared_reference_contributions c
           JOIN private.shared_reference_contribution_revisions r
             ON r.contribution_id = c.id AND r.revision >= c.shared_first_revision
          WHERE c.owner_id = u.user_id
            AND c.source_measurement_set_id = u.reference_measurement_set_id
            AND c.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
            AND c.status = 'shared' AND c.share_basis = 'consented' AND c.hidden_at IS NULL
            AND u.id IN (SELECT q.id FROM private.reference_qualifying_use_ids(
                  c.owner_id, c.source_measurement_set_id, c.sporely_taxon_id) AS q(id))
            AND (r.envelope_json->'snapshot')
                  - ARRAY['reference_work_id','reference_treatment_id',
                          'reference_measurement_set_id','reference_revision']
                = private.public_reference_snapshot(
                    u.snapshot_json, u.reference_measurement_set_id, u.reference_revision)
                  - ARRAY['reference_work_id','reference_treatment_id',
                          'reference_measurement_set_id','reference_revision']
       )
  )
$$;

-- 1e. Stage 1B records consent_required again.
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
  v_contribution_id uuid;
  v_result jsonb;
  v_status text;
  v_count integer := 0;
BEGIN
  SELECT o.id, o.user_id, o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id
    INTO v_obs
    FROM public.observations o
   WHERE o.id = p_observation_id;
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
    PERFORM private.lock_shared_reference_key(v_obs.user_id, v_set);

    IF v_old IS NULL THEN
      v_old_action := 'none';
    ELSIF private.reference_set_has_qualifying_use(v_obs.user_id, v_set, v_old::integer) THEN
      v_old_action := 'kept_by_other_use';
    ELSE
      SELECT c.id INTO v_contribution_id
        FROM private.shared_reference_contributions c
       WHERE c.owner_id = v_obs.user_id
         AND c.source_measurement_set_id = v_set
         AND c.sporely_taxon_id = v_old;
      IF NOT FOUND THEN
        v_old_action := 'none';
      ELSIF private.withdraw_shared_reference_contribution(v_contribution_id, 'taxon_changed') THEN
        v_old_action := 'withdrawn';
      ELSIF EXISTS (
        SELECT 1 FROM private.shared_reference_contributions c
         WHERE c.id = v_contribution_id AND c.status = 'shared'
      ) THEN
        RAISE EXCEPTION 'contribution for set % under old taxon % is still shared', v_set, v_old;
      ELSIF (
        SELECT e.event || ':' || e.reason
          FROM private.shared_reference_consent_events e
         WHERE e.contribution_id = v_contribution_id
           AND e.occurred_at >= pg_catalog.transaction_timestamp()
         ORDER BY e.id DESC LIMIT 1
      ) IS NOT DISTINCT FROM 'withdrawn_by_system:taxon_changed' THEN
        v_old_action := 'withdrawn';
      ELSE
        v_old_action := 'none';
      END IF;
    END IF;

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
    ELSIF NOT EXISTS (
      SELECT 1
        FROM public.reference_measurement_sets m
        JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
        JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
       WHERE m.user_id = v_obs.user_id AND m.id = v_set
         AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
    ) THEN
      v_new_action := 'source_deleted';
    ELSE
      v_result := private.share_reference_contribution_for_owner(
        v_obs.user_id, v_set, v_new::integer, NULL, NULL, NULL
      );
      v_status := v_result->>'status';
      IF v_status IN ('created', 'updated', 'no_change') THEN
        IF NOT EXISTS (
          SELECT 1 FROM private.shared_reference_contributions c
           WHERE c.owner_id = v_obs.user_id AND c.source_measurement_set_id = v_set
             AND c.sporely_taxon_id = v_new AND c.status = 'shared'
             AND c.share_basis IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'refresh for set % under taxon % reported % but is not shared',
            v_set, v_new, v_status;
        END IF;
        v_new_action := 'shared';
      ELSIF v_status IN ('consent_required', 'opted_out', 'consent_scope_exceeded',
                         'withdrawn_unqualified', 'consent_text_revoked',
                         'qualifying_use_required') THEN
        v_new_action := v_status;
      ELSIF v_status = 'source_not_found_or_stale' THEN
        v_new_action := 'source_deleted';
      ELSIF v_status = 'invalid_taxon' THEN
        v_new_action := CASE WHEN EXISTS (
          SELECT 1 FROM public.taxonomy_v2_taxa t
           WHERE t.release_id = private._taxon_identity_repair_active_release()
             AND t.sporely_taxon_id = v_new
             AND t.taxon_rank = 'species'
        ) THEN 'not_registry_species' ELSE 'not_species' END;
      ELSIF v_status IN ('account_unavailable', 'source_out_of_bounds', 'moderation_hidden') THEN
        v_new_action := 'not_shareable:' || v_status;
      ELSE
        RAISE EXCEPTION 'reference reconciliation for observation % set % failed: %',
          v_obs.id, v_set, coalesce(v_status, v_result::text);
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

ALTER FUNCTION private.share_reference_contribution_for_owner(uuid,uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION private.share_reference_set_again_for_owner(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_is_served(uuid,boolean) OWNER TO postgres;
ALTER FUNCTION private.observation_reference_use_is_served(uuid) OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.share_reference_contribution_for_owner(uuid,uuid,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.share_reference_set_again_for_owner(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_is_served(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.observation_reference_use_is_served(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Withdraw every automatic row (count-agnostic), with reason rollback.
DO $$
DECLARE
  v_row record;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT c.id, c.owner_id, c.source_measurement_set_id
      FROM private.shared_reference_contributions c
     WHERE c.status = 'shared' AND c.share_basis = 'automatic'
     ORDER BY c.owner_id, c.source_measurement_set_id, c.id
  LOOP
    PERFORM private.lock_shared_reference_key(v_row.owner_id, v_row.source_measurement_set_id);
    IF private.withdraw_shared_reference_contribution(v_row.id, 'rollback') THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions
              WHERE status = 'shared' AND share_basis IS DISTINCT FROM 'consented') THEN
    RAISE EXCEPTION 'rollback left a non-consented shared row';
  END IF;
  RAISE NOTICE 'reference sharing rollback: % automatic rows withdrawn', v_count;
END
$$;

COMMIT;
