-- Account deletion ordering for intake state and personal reference graphs.

BEGIN;

DO $$
DECLARE
  owner_id constant uuid := '00000000-0000-4000-8000-000000006b21';
  blocked_owner constant uuid := '00000000-0000-4000-8000-000000006b22';
  curator constant uuid := '00000000-0000-4000-8000-000000006b23';
  source_work constant uuid := '61000000-0000-4000-8000-000000006b21';
  source_treatment constant uuid := '62000000-0000-4000-8000-000000006b21';
  source_set constant uuid := '63000000-0000-4000-8000-000000006b21';
  blocked_work constant uuid := '61000000-0000-4000-8000-000000006b22';
  blocked_treatment constant uuid := '62000000-0000-4000-8000-000000006b22';
  blocked_set constant uuid := '63000000-0000-4000-8000-000000006b22';
  curated_work constant uuid := '61000000-0000-4000-8000-000000006b23';
  curated_treatment constant uuid := '62000000-0000-4000-8000-000000006b23';
  curated_set constant uuid := '63000000-0000-4000-8000-000000006b23';
  result jsonb;
  v_submission_id uuid;
  v_blocked_submission_id uuid;
  v_report_id uuid;
  submission_version bigint;
  report_version bigint;
  deletion_event_count integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
    (owner_id, 'authenticated', 'authenticated', 'stage6b-delete@example.invalid', '{}', now(), now()),
    (blocked_owner, 'authenticated', 'authenticated', 'stage6b-delete-blocked@example.invalid', '{}', now(), now()),
    (curator, 'authenticated', 'authenticated', 'stage6b-delete-curator@example.invalid', '{}', now(), now());
  INSERT INTO public.profiles (id, username, is_banned) VALUES
    (owner_id, 'stage6b_delete', false),
    (blocked_owner, 'stage6b_delete_blocked', false),
    (curator, 'stage6b_delete_curator', false);

  INSERT INTO public.reference_works(user_id, id, type, title, short_label, revision) VALUES
    (owner_id, source_work, 'book', 'Deletion source', 'Delete 2026', 1),
    (blocked_owner, blocked_work, 'book', 'Blocked deletion source', 'Blocked 2026', 1);
  INSERT INTO public.reference_taxon_treatments
    (user_id, id, reference_work_id, name_as_published, revision) VALUES
    (owner_id, source_treatment, source_work, 'Delete species', 1),
    (blocked_owner, blocked_treatment, blocked_work, 'Blocked species', 1);
  INSERT INTO public.reference_measurement_sets
    (user_id, id, taxon_treatment_id, character, data_kind, raw_text, revision) VALUES
    (owner_id, source_set, source_treatment, 'spore_size', 'range', '8-10 µm', 1),
    (blocked_owner, blocked_set, blocked_treatment, 'spore_size', 'range', '7-9 µm', 1);

  INSERT INTO taxonomy_v3.registry_concept
    (sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release)
  VALUES (2100000062, 'Deletion report species', 'species', 'include', 'in_cache', 'stage6b-test');
  INSERT INTO private.curated_reference_works
    (id, type, title, short_label, revision, created_by, updated_by)
  VALUES (curated_work, 'book', 'Deletion report work', 'Deletion report', 1, curator, curator);
  INSERT INTO private.curated_reference_taxon_treatments
    (id, reference_work_id, name_as_published, revision, created_by, updated_by)
  VALUES (curated_treatment, curated_work, 'Deletion report species', 1, curator, curator);
  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, revision, created_by, updated_by)
  VALUES (curated_set, curated_treatment, 'spore_size', 'range', 1, curator, curator);
  INSERT INTO private.curated_reference_treatment_taxa
    (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision, created_by, updated_by)
  VALUES ('64000000-0000-4000-8000-000000006b23', curated_treatment, 2100000062,
    'Exact Stage 6b deletion test assignment', 1, curator, curator);
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    curated_set, 1, curated_treatment, curated_work, 1, 1, 1,
    1, '{"schema_version":1}', 1, '{"schema_version":1,"citation_key":null,"type":"other","authors":[],"editors":[],"title":"Fixture","short_citation":"Fixture","full_citation":"Fixture."}', repeat('c', 64), curator
  );
  INSERT INTO private.curated_reference_publication_taxa
    (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
  VALUES (curated_set, 1, 2100000062, 'Deletion report species');
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'published', latest_bundle_revision = 1,
         published_at = now(), status_changed_at = now(), row_version = row_version + 1
   WHERE id = curated_set;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled = true,
         reports_enabled = true,
         attestation_version = 'delete-test-v1',
         attestation_text = 'TEST ONLY: deletion-flow rights and consent wording.',
         submission_rate_window = interval '1 hour',
         submission_rate_limit = 20,
         report_rate_window = interval '1 hour',
         report_rate_limit = 20,
         unaccepted_submission_retention = interval '0 seconds',
         report_text_retention = interval '0 seconds'
   WHERE singleton;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role', 'authenticated')::text, true);
  result := public.submit_private_reference_for_curation(
    source_set, 1, 1, 1, 'delete-test-v1', true, true);
  v_submission_id := (result->'submission'->>'id')::uuid;
  IF result->>'status' <> 'created' OR v_submission_id IS NULL THEN
    RAISE EXCEPTION 'deletion fixture submission failed: %', result;
  END IF;
  result := public.report_curated_reference_set(
    curated_set, 1, 'copyright', 'Account-owned report text',
    '66000000-0000-4000-8000-000000006b21');
  v_report_id := (result->'report'->>'id')::uuid;
  IF result->>'status' <> 'created' OR v_report_id IS NULL THEN
    RAISE EXCEPTION 'deletion fixture report failed: %', result;
  END IF;
  INSERT INTO private.reference_curator_memberships(user_id, role, granted_by, reason)
  VALUES(owner_id, 'reference_reviewer', curator, 'Stage 6b deletion ordering test');

  PERFORM public.delete_reference_library_for_account(owner_id);

  IF NOT EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id = owner_id)
     OR EXISTS (SELECT 1 FROM private.reference_curator_memberships WHERE user_id = owner_id)
     OR EXISTS (SELECT 1 FROM public.reference_works WHERE user_id = owner_id)
     OR EXISTS (SELECT 1 FROM public.reference_taxon_treatments WHERE user_id = owner_id)
     OR EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE user_id = owner_id) THEN
    RAISE EXCEPTION 'account deletion ordering left authority or personal graph rows';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM private.reference_curation_submissions s
     WHERE s.id = v_submission_id AND s.contributor_id IS NULL
       AND s.source_measurement_set_id IS NULL AND s.status = 'withdrawn'
       AND s.withdrawal_code = 'account_deleted'
       AND s.contributor_deleted_at IS NOT NULL AND s.candidate_purge_after IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM private.reference_curation_submission_versions v
     WHERE v.submission_id = v_submission_id AND v.candidate_revision = 1
       AND v.content_hash ~ '^[0-9a-f]{64}$'
       AND v.candidate_json IS NULL AND v.candidate_purged_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'submission identity was not retained after due candidate payload purge';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM private.reference_curation_reports r
     WHERE r.id = v_report_id AND r.reporter_id IS NULL AND r.details IS NULL
       AND r.reporter_deleted_at IS NOT NULL AND r.redacted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'report attribution/text was not redacted by configured policy';
  END IF;
  IF EXISTS (SELECT 1 FROM private.reference_curation_events WHERE actor_user_id = owner_id) THEN
    RAISE EXCEPTION 'account deletion retained audit actor identity';
  END IF;
  IF (SELECT count(*) FROM private.reference_curation_events
       WHERE action = 'purge_candidate' AND target_id = v_submission_id) <> 1
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action = 'redact_report' AND target_id = v_report_id) <> 1 THEN
    RAISE EXCEPTION 'zero-retention erasure was not append-only audited';
  END IF;
  SELECT row_version INTO submission_version FROM private.reference_curation_submissions
   WHERE id = v_submission_id;
  SELECT row_version INTO report_version FROM private.reference_curation_reports WHERE id = v_report_id;
  SELECT count(*) INTO deletion_event_count FROM private.reference_curation_events
   WHERE action = 'withdraw' AND target_type = 'submission' AND target_id = v_submission_id;
  PERFORM public.delete_reference_library_for_account(owner_id);
  IF (SELECT row_version FROM private.reference_curation_submissions WHERE id = v_submission_id)
       <> submission_version
     OR (SELECT row_version FROM private.reference_curation_reports WHERE id = v_report_id)
       <> report_version
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action = 'withdraw' AND target_type = 'submission' AND target_id = v_submission_id)
       <> deletion_event_count
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action = 'purge_candidate' AND target_id = v_submission_id) <> 1
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action = 'redact_report' AND target_id = v_report_id) <> 1 THEN
    RAISE EXCEPTION 'account deletion retry was not idempotent';
  END IF;

  -- Missing operational retention policy must roll the whole deletion stage
  -- back rather than silently choosing a value.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', blocked_owner::text, 'role', 'authenticated')::text, true);
  result := public.submit_private_reference_for_curation(
    blocked_set, 1, 1, 1, 'delete-test-v1', true, true);
  v_blocked_submission_id := (result->'submission'->>'id')::uuid;
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'blocked-deletion fixture submission failed: %', result;
  END IF;
  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled = false, unaccepted_submission_retention = NULL
   WHERE singleton;
  BEGIN
    PERFORM public.delete_reference_library_for_account(blocked_owner);
    RAISE EXCEPTION 'account deletion ignored missing retention policy';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'reference curation submission retention policy is not configured' THEN
      RAISE;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id = blocked_owner)
     OR NOT EXISTS (SELECT 1 FROM public.reference_measurement_sets
                     WHERE user_id = blocked_owner AND id = blocked_set) THEN
    RAISE EXCEPTION 'failed account deletion did not roll back atomically';
  END IF;

  UPDATE private.reference_curation_intake_policy
     SET unaccepted_submission_retention = interval '1 day'
   WHERE singleton;
  PERFORM public.delete_reference_library_for_account(blocked_owner);
  IF (SELECT candidate_json FROM private.reference_curation_submission_versions
       WHERE submission_id = v_blocked_submission_id AND candidate_revision = 1) IS NULL THEN
    RAISE EXCEPTION 'positive retention interval purged candidate immediately';
  END IF;
  UPDATE private.reference_curation_submissions
     SET candidate_purge_after = pg_catalog.clock_timestamp() - interval '1 second',
         row_version = row_version + 1
   WHERE id = v_blocked_submission_id;
  PERFORM private.apply_reference_curation_retention();
  IF NOT EXISTS (
    SELECT 1 FROM private.reference_curation_submission_versions
     WHERE submission_id = v_blocked_submission_id AND candidate_revision = 1
       AND candidate_json IS NULL AND candidate_purged_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'expired positive retention did not purge candidate payload';
  END IF;
  IF (SELECT count(*) FROM private.reference_curation_events
       WHERE action = 'purge_candidate' AND target_id = v_blocked_submission_id) <> 1 THEN
    RAISE EXCEPTION 'positive-retention purge was not append-only audited';
  END IF;
END
$$;

ROLLBACK;
