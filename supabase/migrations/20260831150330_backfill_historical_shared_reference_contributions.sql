-- One-time, replay-safe repair for valid reference uses that predate the
-- trigger-driven shared-contribution workflow.  Eligibility is derived only
-- from exact stored identifiers and the authoritative taxonomy registry.

BEGIN;

CREATE FUNCTION private.backfill_historical_shared_reference_contributions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_candidate record;
  v_result jsonb;
  v_eligible integer := 0;
  v_created integer := 0;
  v_updated integer := 0;
  v_no_change integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR v_candidate IN
    SELECT DISTINCT ON (
      u.user_id,
      u.reference_measurement_set_id,
      exact_taxon.sporely_taxon_id
    )
      u.user_id AS owner_id,
      u.reference_measurement_set_id,
      exact_taxon.sporely_taxon_id,
      w.revision AS work_revision,
      t.revision AS treatment_revision,
      m.revision AS measurement_set_revision
    FROM public.observation_reference_uses u
    JOIN public.observations o
      ON o.user_id = u.user_id
     AND o.id = u.observation_id
    JOIN public.profiles p
      ON p.id = u.user_id
     AND p.is_banned IS FALSE
    JOIN public.reference_measurement_sets m
      ON m.user_id = u.user_id
     AND m.id = u.reference_measurement_set_id
     AND m.deleted_at IS NULL
    JOIN public.reference_taxon_treatments t
      ON t.user_id = m.user_id
     AND t.id = m.taxon_treatment_id
     AND t.deleted_at IS NULL
    JOIN public.reference_works w
      ON w.user_id = t.user_id
     AND w.id = t.reference_work_id
     AND w.deleted_at IS NULL
    JOIN taxonomy_v3.registry_concept exact_taxon
      ON exact_taxon.sporely_taxon_id = coalesce(
        o.selected_sporely_taxon_id,
        o.resolved_sporely_taxon_id
      )
     AND exact_taxon.rank = 'species'
    WHERE u.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM private.reference_account_deletions d
        WHERE d.user_id = u.user_id
      )
    ORDER BY
      u.user_id,
      u.reference_measurement_set_id,
      exact_taxon.sporely_taxon_id,
      u.id
  LOOP
    v_eligible := v_eligible + 1;
    v_result := private.share_reference_contribution_for_owner(
      v_candidate.owner_id,
      v_candidate.reference_measurement_set_id,
      v_candidate.sporely_taxon_id,
      v_candidate.work_revision,
      v_candidate.treatment_revision,
      v_candidate.measurement_set_revision
    );
    CASE v_result->>'status'
      WHEN 'created' THEN v_created := v_created + 1;
      WHEN 'updated' THEN v_updated := v_updated + 1;
      WHEN 'no_change' THEN v_no_change := v_no_change + 1;
      ELSE v_skipped := v_skipped + 1;
    END CASE;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object(
    'eligible', v_eligible,
    'created', v_created,
    'updated', v_updated,
    'no_change', v_no_change,
    'skipped', v_skipped
  );
END
$$;

ALTER FUNCTION private.backfill_historical_shared_reference_contributions()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.backfill_historical_shared_reference_contributions()
  FROM PUBLIC, anon, authenticated, service_role;

SELECT private.backfill_historical_shared_reference_contributions();

DROP FUNCTION private.backfill_historical_shared_reference_contributions();

COMMIT;
