-- Authenticated curated-publication report intake contract.

BEGIN;

DO $$
DECLARE
  reporter_a constant uuid := '00000000-0000-4000-8000-000000006b11';
  reporter_b constant uuid := '00000000-0000-4000-8000-000000006b12';
  curator constant uuid := '00000000-0000-4000-8000-000000006b13';
  work_id constant uuid := '61000000-0000-4000-8000-000000006b11';
  treatment_id constant uuid := '62000000-0000-4000-8000-000000006b11';
  set_id constant uuid := '63000000-0000-4000-8000-000000006b11';
  draft_set_id constant uuid := '63000000-0000-4000-8000-000000006b12';
  report_key constant uuid := '66000000-0000-4000-8000-000000006b11';
  result jsonb;
  report_id uuid;
  event_count integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
    (reporter_a, 'authenticated', 'authenticated', 'stage6b-reporter-a@example.invalid', '{}', now(), now()),
    (reporter_b, 'authenticated', 'authenticated', 'stage6b-reporter-b@example.invalid', '{}', now(), now()),
    (curator, 'authenticated', 'authenticated', 'stage6b-curator@example.invalid', '{}', now(), now());
  INSERT INTO public.profiles (id, username, is_banned) VALUES
    (reporter_a, 'stage6b_reporter_a', false),
    (reporter_b, 'stage6b_reporter_b', false),
    (curator, 'stage6b_curator', false);

  INSERT INTO taxonomy_v3.registry_concept
    (sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release)
  VALUES (2100000061, 'Reportable species', 'species', 'include', 'in_cache', 'stage6b-test');
  INSERT INTO private.curated_reference_works
    (id, type, citation_key, title, short_label, revision, created_by, updated_by)
  VALUES (work_id, 'article', 'Reportable2026', 'Reportable work', 'Reportable 2026', 1,
    curator, curator);
  INSERT INTO private.curated_reference_taxon_treatments
    (id, reference_work_id, name_as_published, revision, created_by, updated_by)
  VALUES (treatment_id, work_id, 'Reportable species', 1, curator, curator);
  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, raw_text, revision, created_by, updated_by)
  VALUES
    (set_id, treatment_id, 'spore_size', 'range', '8-10 µm', 1, curator, curator),
    (draft_set_id, treatment_id, 'spore_size', 'range', '9-11 µm', 1, curator, curator);
  INSERT INTO private.curated_reference_treatment_taxa
    (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision, created_by, updated_by)
  VALUES ('64000000-0000-4000-8000-000000006b11', treatment_id, 2100000061,
    'Exact Stage 6b test assignment', 1, curator, curator);
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    set_id, 1, treatment_id, work_id, 1, 1, 1,
    1, '{"schema_version":1}', 1, '{"schema_version":1,"citation_key":null,"type":"other","authors":[],"editors":[],"title":"Fixture","short_citation":"Fixture","full_citation":"Fixture."}', repeat('b', 64), curator
  );
  INSERT INTO private.curated_reference_publication_taxa
    (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
  VALUES (set_id, 1, 2100000061, 'Reportable species');
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'published', latest_bundle_revision = 1,
         published_at = now(), status_changed_at = now(), row_version = row_version + 1
   WHERE id = set_id;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', reporter_a::text, 'role', 'authenticated')::text, true);
  result := public.report_curated_reference_set(set_id, 1, 'citation_error', 'Page is wrong', report_key);
  IF result->>'status' <> 'intake_disabled' THEN
    RAISE EXCEPTION 'dormant report intake did not fail closed: %', result;
  END IF;

  UPDATE private.reference_curation_intake_policy
     SET reports_enabled = true,
         report_rate_window = interval '1 hour',
         report_rate_limit = 2,
         report_text_retention = interval '0 seconds'
   WHERE singleton;

  result := public.report_curated_reference_set(set_id, 1, 'other', NULL, gen_random_uuid());
  IF result->>'status' <> 'invalid_payload' THEN
    RAISE EXCEPTION 'blank other report was accepted: %', result;
  END IF;
  result := public.report_curated_reference_set(set_id, 1, 'unknown', 'x', gen_random_uuid());
  IF result->>'status' <> 'invalid_payload' THEN
    RAISE EXCEPTION 'unknown report reason was accepted: %', result;
  END IF;
  result := public.report_curated_reference_set(set_id, 1, 'other', repeat('x', 4001), gen_random_uuid());
  IF result->>'status' <> 'invalid_payload' THEN
    RAISE EXCEPTION 'oversized report was accepted: %', result;
  END IF;
  result := public.report_curated_reference_set(draft_set_id, 1, 'duplicate', NULL, gen_random_uuid());
  IF result->>'status' <> 'target_not_reportable' THEN
    RAISE EXCEPTION 'draft/non-public target was reportable: %', result;
  END IF;

  result := public.report_curated_reference_set(set_id, 1, 'citation_error', 'Page is wrong', report_key);
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'valid report failed: %', result;
  END IF;
  report_id := (result->'report'->>'id')::uuid;
  IF (SELECT catalogue_status FROM private.curated_reference_measurement_sets WHERE id = set_id)
       <> 'published' THEN
    RAISE EXCEPTION 'report intake hid catalogue content automatically';
  END IF;
  SELECT count(*) INTO event_count FROM private.reference_curation_events
   WHERE action = 'report' AND target_type = 'report' AND target_id = report_id;

  UPDATE private.reference_curation_intake_policy SET reports_enabled = false WHERE singleton;
  result := public.report_curated_reference_set(set_id, 1, 'citation_error', 'Page is wrong', report_key);
  IF result->>'status' <> 'no_change'
     OR (result->'report'->>'id')::uuid <> report_id
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action = 'report' AND target_type = 'report' AND target_id = report_id) <> event_count THEN
    RAISE EXCEPTION 'exact report retry was not a no-op: %', result;
  END IF;
  result := public.report_curated_reference_set(set_id, 1, 'citation_error', 'Different', report_key);
  IF result->>'status' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'reused report key with different payload was accepted: %', result;
  END IF;
  UPDATE private.reference_curation_intake_policy SET reports_enabled = true WHERE singleton;
  result := public.report_curated_reference_set(set_id, 1, 'duplicate', NULL, gen_random_uuid());
  IF result->>'status' <> 'rate_limited' THEN
    RAISE EXCEPTION 'new report bypassed rate limit: %', result;
  END IF;

  UPDATE public.profiles SET is_banned = true WHERE id = reporter_b;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', reporter_b::text, 'role', 'authenticated')::text, true);
  result := public.report_curated_reference_set(set_id, 1, 'duplicate', NULL, gen_random_uuid());
  IF result->>'status' <> 'account_unavailable' THEN
    RAISE EXCEPTION 'banned reporter reached intake: %', result;
  END IF;
  UPDATE public.profiles SET is_banned = false WHERE id = reporter_b;
  INSERT INTO private.reference_account_deletions(user_id) VALUES(reporter_b);
  result := public.report_curated_reference_set(set_id, 1, 'duplicate', NULL, gen_random_uuid());
  IF result->>'status' <> 'account_deleting' THEN
    RAISE EXCEPTION 'deletion marker did not block report intake: %', result;
  END IF;

  BEGIN
    INSERT INTO private.reference_curation_reports (
      reporter_id, idempotency_key, curated_measurement_set_id,
      bundle_revision, reason_code, status, row_version
    ) VALUES (
      reporter_a, gen_random_uuid(), set_id, 1, 'duplicate', 'resolved', 1
    );
    RAISE EXCEPTION 'service path inserted a report outside its initial lifecycle state';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;

ROLLBACK;
