-- Stage 6b private owner-intake schema contract.

BEGIN;

DO $$
DECLARE
  table_name text;
  is_rls boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'reference_curation_intake_policy',
    'reference_curation_attestation_versions',
    'reference_curation_intake_attempts',
    'reference_curation_submissions',
    'reference_curation_submission_versions',
    'reference_curation_reports'
  ] LOOP
    IF to_regclass('private.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'missing private.%', table_name;
    END IF;
    SELECT c.relrowsecurity INTO is_rls
      FROM pg_catalog.pg_class c
     WHERE c.oid = ('private.' || table_name)::regclass;
    IF is_rls IS NOT TRUE THEN
      RAISE EXCEPTION 'RLS disabled on private.%', table_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies p
       WHERE p.schemaname = 'private' AND p.tablename = table_name
    ) THEN
      RAISE EXCEPTION 'unexpected direct policy on private.%', table_name;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  policy private.reference_curation_intake_policy%ROWTYPE;
  index_name text;
BEGIN
  SELECT * INTO policy FROM private.reference_curation_intake_policy WHERE singleton;
  IF NOT FOUND OR policy.submissions_enabled OR policy.reports_enabled
     OR policy.attestation_version IS NOT NULL
     OR policy.submission_rate_limit IS NOT NULL
     OR policy.report_rate_limit IS NOT NULL
     OR policy.unaccepted_submission_retention IS NOT NULL
     OR policy.report_text_retention IS NOT NULL THEN
    RAISE EXCEPTION 'operational intake policy did not default to disabled/unconfigured';
  END IF;

  BEGIN
    UPDATE private.reference_curation_intake_policy SET submissions_enabled = true WHERE singleton;
    RAISE EXCEPTION 'submission intake enabled without policy values';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.reference_curation_intake_policy SET reports_enabled = true WHERE singleton;
    RAISE EXCEPTION 'report intake enabled without policy values';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  FOREACH index_name IN ARRAY ARRAY[
    'reference_curation_submissions_initial_idempotency_key',
    'reference_curation_submissions_one_active_source_key',
    'reference_curation_submissions_contributor_created_idx',
    'reference_curation_submission_versions_created_idx',
    'reference_curation_submissions_purge_due_idx',
    'reference_curation_intake_attempts_actor_action_idx',
    'reference_curation_reports_target_idx',
    'reference_curation_reports_reporter_created_idx',
    'reference_curation_reports_redaction_due_idx'
  ] LOOP
    IF to_regclass('private.' || index_name) IS NULL THEN
      RAISE EXCEPTION 'missing private index %', index_name;
    END IF;
  END LOOP;
END
$$;

ROLLBACK;
