-- Rollback of supabase/migrations/20261002150000_fork_from_shared_reference_contribution.sql.
-- NOT a migration: kept outside supabase/migrations so it never runs by
-- accident. Tested by
-- supabase/tests/reference_curated_fork_from_contribution_rollback_test.sh
-- (section R: R1 restored state + legacy test, R2 contribution test fails,
-- R3 refusal; every step in a rolled-back transaction).
--
-- Restores public.sync_reference_curated_fork(jsonb,bigint) verbatim from
-- 20260830120000 (owner, REVOKE, GRANT), the single source FK to
-- private.curated_reference_publication_taxa, and drops source_kind and the
-- two generated source columns.
--
-- REFUSES while any contribution-sourced fork exists: the restored FK cannot
-- hold for it, and deleting it would silently drop a user's provenance
-- (owner decision (a): a copier keeps it). Deciding what happens to those
-- rows is a separate, explicit operator decision. Check first:
--   SELECT count(*) FROM public.reference_curated_forks
--    WHERE source_kind = 'shared_contribution';
-- After the rollback, desktop pushes of contribution-sourced forks return
-- invalid_source again (the pre-fix behaviour).
--
-- Promotion to a real migration (only if the forward migration was deployed
-- and must be undone): copy this file unchanged to
-- supabase/migrations/<new UTC timestamp>_rollback_fork_from_shared_reference_contribution.sql,
-- and deploy through the deploy tree.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reference_curated_forks
              WHERE source_kind = 'shared_contribution') THEN
    RAISE EXCEPTION 'rollback refused: contribution-sourced curated forks exist'
      USING ERRCODE = '55000';
  END IF;
END
$$;

DROP FUNCTION public.sync_reference_curated_fork(jsonb,bigint);

ALTER TABLE public.reference_curated_forks
  DROP CONSTRAINT reference_curated_forks_contribution_source_fkey,
  DROP CONSTRAINT reference_curated_forks_publication_source_fkey,
  ADD CONSTRAINT reference_curated_forks_curated_measurement_set_id_bundle__fkey
    FOREIGN KEY (curated_measurement_set_id, bundle_revision, sporely_taxon_id)
    REFERENCES private.curated_reference_publication_taxa(
      curated_measurement_set_id, bundle_revision, sporely_taxon_id
    ) ON DELETE RESTRICT;

ALTER TABLE public.reference_curated_forks
  DROP COLUMN shared_contribution_id,
  DROP COLUMN curated_publication_set_id,
  DROP COLUMN source_kind;

CREATE FUNCTION public.sync_reference_curated_fork(
  p_payload jsonb,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_curated_set_id uuid;
  v_bundle_revision integer;
  v_taxon_id integer;
  v_work_id uuid;
  v_treatment_id uuid;
  v_set_id uuid;
  v_source_sha256 text;
  v_source_envelope_text text;
  v_source_envelope jsonb;
  v_expected_envelope jsonb;
  v_source_status text;
  v_source_successor_id uuid;
  v_current_successor_id uuid;
  v_source_canonical_name text;
  v_current public.reference_curated_forks%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
     OR private.reference_payload_has_unknown_keys(p_payload, ARRAY[
       'curated_measurement_set_id','bundle_revision','sporely_taxon_id',
       'reference_work_id','taxon_treatment_id','reference_measurement_set_id',
       'source_sha256','source_envelope_json'
     ])
  THEN
    RETURN private.reference_result('invalid_payload');
  END IF;

  BEGIN
    v_curated_set_id := (p_payload->>'curated_measurement_set_id')::uuid;
    v_bundle_revision := (p_payload->>'bundle_revision')::integer;
    v_taxon_id := (p_payload->>'sporely_taxon_id')::integer;
    v_work_id := (p_payload->>'reference_work_id')::uuid;
    v_treatment_id := (p_payload->>'taxon_treatment_id')::uuid;
    v_set_id := (p_payload->>'reference_measurement_set_id')::uuid;
    v_source_sha256 := p_payload->>'source_sha256';
    v_source_envelope_text := p_payload->>'source_envelope_json';
  EXCEPTION WHEN OTHERS THEN
    RETURN private.reference_result('invalid_payload');
  END;
  IF v_bundle_revision < 1 OR v_taxon_id < 1
     OR v_source_sha256 IS NULL OR v_source_sha256 !~ '^[0-9a-f]{64}$'
     OR v_source_envelope_text IS NULL
     OR pg_catalog.octet_length(v_source_envelope_text) NOT BETWEEN 2 AND 1048576
  THEN
    RETURN private.reference_result('invalid_payload');
  END IF;
  IF pg_catalog.encode(extensions.digest(
       pg_catalog.convert_to(v_source_envelope_text,'UTF8'),'sha256'
     ),'hex') IS DISTINCT FROM v_source_sha256 THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  BEGIN
    v_source_envelope := v_source_envelope_text::jsonb;
    IF pg_catalog.jsonb_typeof(v_source_envelope) <> 'object' THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    v_source_status := v_source_envelope->>'status';
    v_source_successor_id := nullif(v_source_envelope->>'superseded_by_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN private.reference_result('invalid_source');
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id = v_owner) THEN
    RETURN private.reference_result('account_deleting');
  END IF;

  SELECT * INTO v_current
    FROM public.reference_curated_forks
   WHERE user_id = v_owner
     AND curated_measurement_set_id = v_curated_set_id
     AND bundle_revision = v_bundle_revision
   FOR UPDATE;
  IF FOUND THEN
    IF v_current.sporely_taxon_id = v_taxon_id
       AND v_current.reference_work_id = v_work_id
       AND v_current.taxon_treatment_id = v_treatment_id
       AND v_current.reference_measurement_set_id = v_set_id
       AND v_current.source_sha256 = v_source_sha256
       AND v_current.source_envelope_json = v_source_envelope_text
    THEN
      RETURN private.reference_result('no_change', pg_catalog.to_jsonb(v_current));
    END IF;
    RETURN private.reference_result('conflict', pg_catalog.to_jsonb(v_current));
  END IF;
  IF p_expected_row_version <> 0 THEN
    RETURN private.reference_result('conflict');
  END IF;

  SELECT pt.canonical_name
    INTO v_source_canonical_name
    FROM private.curated_reference_publications p
    JOIN private.curated_reference_publication_taxa pt
      ON pt.curated_measurement_set_id = p.curated_measurement_set_id
     AND pt.bundle_revision = p.bundle_revision
   WHERE p.curated_measurement_set_id = v_curated_set_id
     AND p.bundle_revision = v_bundle_revision
     AND pt.sporely_taxon_id = v_taxon_id;
  IF NOT FOUND THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  SELECT successor.id INTO v_current_successor_id
    FROM private.curated_reference_measurement_sets successor
   WHERE successor.supersedes_id = v_curated_set_id
     AND successor.catalogue_status IN ('published','deprecated')
     AND EXISTS (
       SELECT 1 FROM private.curated_reference_publications successor_publication
        WHERE successor_publication.curated_measurement_set_id = successor.id
          AND successor_publication.bundle_revision = successor.latest_bundle_revision
     )
   ORDER BY successor.id
   LIMIT 1;
  IF v_source_status NOT IN ('published','deprecated')
     OR (v_source_status = 'published' AND v_source_successor_id IS NOT NULL)
     OR (v_source_status = 'deprecated' AND NOT EXISTS (
       SELECT 1 FROM private.curated_reference_measurement_sets source_set
        WHERE source_set.id = v_curated_set_id AND source_set.deprecated_at IS NOT NULL
     ))
     OR (v_source_status = 'deprecated'
         AND v_source_successor_id IS DISTINCT FROM v_current_successor_id)
  THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  v_expected_envelope := private.reference_curated_public_envelope(
    v_curated_set_id,v_bundle_revision,v_source_status,v_source_successor_id
  );
  IF v_expected_envelope IS NULL THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  v_expected_envelope := v_expected_envelope || pg_catalog.jsonb_build_object(
    'sporely_taxon_id',v_taxon_id,
    'canonical_scientific_name',v_source_canonical_name
  );
  IF v_source_envelope IS DISTINCT FROM v_expected_envelope THEN
    RETURN private.reference_result('invalid_source');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.reference_measurement_sets m
      JOIN public.reference_taxon_treatments t
        ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
      JOIN public.reference_works w
        ON w.user_id = t.user_id AND w.id = t.reference_work_id
     WHERE m.user_id = v_owner AND m.id = v_set_id
       AND m.taxon_treatment_id = v_treatment_id
       AND t.reference_work_id = v_work_id
       AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
  ) THEN
    RETURN private.reference_result('invalid_parent');
  END IF;

  BEGIN
    INSERT INTO public.reference_curated_forks(
      user_id,curated_measurement_set_id,bundle_revision,sporely_taxon_id,
      reference_work_id,taxon_treatment_id,reference_measurement_set_id,source_sha256
      ,source_envelope_json
    ) VALUES (
      v_owner,v_curated_set_id,v_bundle_revision,v_taxon_id,
      v_work_id,v_treatment_id,v_set_id,v_source_sha256,v_source_envelope_text
    ) RETURNING * INTO v_current;
  EXCEPTION
    WHEN unique_violation THEN RETURN private.reference_result('conflict');
    WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
      RETURN private.reference_result('invalid_payload');
  END;
  RETURN private.reference_result('created', pg_catalog.to_jsonb(v_current));
END
$$;

ALTER FUNCTION public.sync_reference_curated_fork(jsonb,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_curated_fork(jsonb,bigint)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sync_reference_curated_fork(jsonb,bigint)
  TO authenticated;

COMMIT;
