-- Owner submission, immutable candidate, resubmission, and withdrawal contract.

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-000000006b01';
  owner_b constant uuid := '00000000-0000-4000-8000-000000006b02';
  work_a constant uuid := '61000000-0000-4000-8000-000000006b01';
  treatment_a constant uuid := '62000000-0000-4000-8000-000000006b01';
  set_a constant uuid := '63000000-0000-4000-8000-000000006b01';
  work_b constant uuid := '61000000-0000-4000-8000-000000006b02';
  treatment_b constant uuid := '62000000-0000-4000-8000-000000006b02';
  set_b constant uuid := '63000000-0000-4000-8000-000000006b02';
  work_b2 constant uuid := '61000000-0000-4000-8000-000000006b03';
  treatment_b2 constant uuid := '62000000-0000-4000-8000-000000006b03';
  set_b2 constant uuid := '63000000-0000-4000-8000-000000006b03';
  result jsonb;
  v_submission_id uuid;
  v_second_submission_id uuid;
  candidate jsonb;
  original_candidate jsonb;
  event_count integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
    (owner_a, 'authenticated', 'authenticated', 'stage6b-owner-a@example.invalid', '{}', now(), now()),
    (owner_b, 'authenticated', 'authenticated', 'stage6b-owner-b@example.invalid', '{}', now(), now());
  INSERT INTO public.profiles (id, username, is_banned) VALUES
    (owner_a, 'stage6b_owner_a', false),
    (owner_b, 'stage6b_owner_b', false);

  INSERT INTO public.reference_works (
    user_id, id, type, citation_key, authors_json, title, year, short_label,
    citation_override, revision
  ) VALUES
    (owner_a, work_a, 'article', 'PRIVATE-CITATION-KEY',
     '[{"family":"Ångström","given":"Ada","private_note":"PRIVATE-AUTHOR-NOTE"}]', 'Original public title', 2026,
     'Ångström 2026', 'Allowed curated citation text', 1),
    (owner_b, work_b, 'book', 'OWNER-B-SECRET', '[]', 'Owner B work', 2025,
     'Owner B 2025', NULL, 1),
    (owner_b, work_b2, 'book', 'OWNER-B-SECOND', '[]', 'Owner B second work', 2024,
     'Owner B second', NULL, 1);
  INSERT INTO public.reference_taxon_treatments (
    user_id, id, reference_work_id, taxon_id, name_as_published,
    locator_text, treatment_notes, revision
  ) VALUES
    (owner_a, treatment_a, work_a, 'private-taxon-key', 'Russula testata',
     'p. 42', 'PRIVATE TREATMENT NOTE', 1),
    (owner_b, treatment_b, work_b, 'private-owner-b-taxon', 'Russula aliena',
     NULL, 'OWNER B NOTE', 1),
    (owner_b, treatment_b2, work_b2, NULL, 'Russula secunda', NULL, NULL, 1);
  INSERT INTO public.reference_measurement_sets (
    user_id, id, taxon_treatment_id, character, raw_text, data_kind,
    length_core_min, length_core_max, notes, raw_points_json, revision
  ) VALUES
    (owner_a, set_a, treatment_a, 'spore_size', '8-10 × 5-6 µm', 'range',
     8, 10, 'PRIVATE SET NOTE', '[{"length":9,"width":5.5,"private_note":"PRIVATE-POINT-NOTE"}]', 1),
    (owner_b, set_b, treatment_b, 'spore_size', '7-9 × 4-5 µm', 'range',
     7, 9, 'OWNER B SET NOTE', NULL, 1),
    (owner_b, set_b2, treatment_b2, 'spore_size', '6-8 × 3-4 µm', 'range',
     6, 8, NULL, NULL, 1);

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_a::text, 'role', 'authenticated')::text, true);

  result := public.submit_private_reference_for_curation(set_a, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'intake_disabled' THEN
    RAISE EXCEPTION 'dormant intake did not fail closed: %', result;
  END IF;

  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled = true,
         attestation_version = 'test-v1',
         attestation_text = 'TEST ONLY: contributor confirms rights and curation consent.',
         submission_rate_window = interval '1 hour',
         submission_rate_limit = 20,
         unaccepted_submission_retention = interval '0 seconds'
   WHERE singleton;

  result := public.submit_private_reference_for_curation(set_a, 1, 1, 1, 'wrong', true, true);
  IF result->>'status' <> 'attestation_required' THEN
    RAISE EXCEPTION 'wrong attestation was accepted: %', result;
  END IF;
  result := public.submit_private_reference_for_curation(set_a, 1, 1, 1, 'test-v1', false, true);
  IF result->>'status' <> 'attestation_required' THEN
    RAISE EXCEPTION 'missing rights consent was accepted: %', result;
  END IF;
  result := public.submit_private_reference_for_curation(set_a, 2, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'source_not_found_or_stale' THEN
    RAISE EXCEPTION 'stale source revisions were accepted: %', result;
  END IF;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'source_not_found_or_stale' THEN
    RAISE EXCEPTION 'cross-owner source was visible: %', result;
  END IF;

  result := public.submit_private_reference_for_curation(set_a, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'initial submission failed: %', result;
  END IF;
  v_submission_id := (result->'submission'->>'id')::uuid;
  SELECT candidate_json INTO candidate
    FROM private.reference_curation_submission_versions
   WHERE submission_id = v_submission_id AND candidate_revision = 1;
  original_candidate := candidate;
  IF candidate IS NULL
     OR candidate->'work'->>'title' <> 'Original public title'
     OR candidate->'treatment'->>'name_as_published' <> 'Russula testata'
     OR candidate->'measurement_set'->>'raw_text' <> '8-10 × 5-6 µm'
     OR candidate::text LIKE '%PRIVATE-%'
     OR candidate::text LIKE '%' || work_a::text || '%'
     OR candidate::text LIKE '%' || treatment_a::text || '%'
     OR candidate::text LIKE '%' || set_a::text || '%'
     OR candidate->'work' ? 'citation_key'
     OR candidate->'treatment' ? 'taxon_id'
     OR candidate->'treatment' ? 'treatment_notes'
     OR candidate->'measurement_set' ? 'notes' THEN
    RAISE EXCEPTION 'candidate allowlist leaked private/source identity fields: %', candidate;
  END IF;
  IF (SELECT attestation_content_hash FROM private.reference_curation_submission_versions
       WHERE submission_id = v_submission_id AND candidate_revision = 1)
     IS DISTINCT FROM (SELECT attestation_content_hash
                         FROM private.reference_curation_intake_policy WHERE singleton) THEN
    RAISE EXCEPTION 'attestation wording hash was not captured';
  END IF;

  -- A lost response remains idempotent even after policy is disabled and the
  -- mutable source graph has moved on.
  UPDATE private.reference_curation_intake_policy SET submissions_enabled = false WHERE singleton;
  UPDATE public.reference_works SET citation_key = 'LATER-PRIVATE-KEY'
   WHERE user_id = owner_a AND id = work_a;
  result := public.submit_private_reference_for_curation(set_a, 1, 1, 1, 'test-v1', false, false);
  IF result->>'status' <> 'no_change'
     OR (result->'submission'->>'id')::uuid <> v_submission_id THEN
    RAISE EXCEPTION 'exact initial retry was not stable: %', result;
  END IF;
  SELECT candidate_json INTO candidate
    FROM private.reference_curation_submission_versions
   WHERE submission_id = v_submission_id AND candidate_revision = 1;
  IF candidate IS DISTINCT FROM original_candidate THEN
    RAISE EXCEPTION 'personal edit rewrote immutable candidate evidence';
  END IF;
  UPDATE private.reference_curation_intake_policy SET submissions_enabled = true WHERE singleton;

  -- Simulate Stage 6c review transitions solely to exercise the Stage 6b
  -- append-only owner response contract.
  UPDATE private.reference_curation_submissions
     SET status = 'in_review', row_version = row_version + 1
   WHERE id = v_submission_id;
  UPDATE private.reference_curation_submissions
     SET status = 'changes_requested', row_version = row_version + 1
   WHERE id = v_submission_id;

  result := public.resubmit_private_reference_for_curation(
    v_submission_id, 999, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'conflict' THEN
    RAISE EXCEPTION 'unchanged first resubmission bypassed CAS: %', result;
  END IF;
  result := public.resubmit_private_reference_for_curation(
    v_submission_id, 3, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'unchanged_candidate' THEN
    RAISE EXCEPTION 'unchanged first resubmission was misclassified: %', result;
  END IF;
  UPDATE public.reference_works SET title = 'Later public edit', revision = 2
   WHERE user_id = owner_a AND id = work_a;
  UPDATE public.reference_measurement_sets
     SET raw_text = '8.5-10.5 × 5-6 µm', revision = 2
   WHERE user_id = owner_a AND id = set_a;

  result := public.resubmit_private_reference_for_curation(
    v_submission_id, 3, 2, 1, 2, 'test-v1', true, true);
  IF result->>'status' <> 'updated'
     OR (result->'submission'->>'candidate_revision')::integer <> 2
     OR (result->'submission'->>'row_version')::bigint <> 4 THEN
    RAISE EXCEPTION 'append-only resubmission failed: %', result;
  END IF;
  IF (SELECT count(*) FROM private.reference_curation_submission_versions
       WHERE submission_id = v_submission_id) <> 2
     OR (SELECT candidate_json FROM private.reference_curation_submission_versions
          WHERE submission_id = v_submission_id AND candidate_revision = 1)
        IS DISTINCT FROM original_candidate THEN
    RAISE EXCEPTION 'resubmission replaced rather than appended candidate evidence';
  END IF;
  result := public.resubmit_private_reference_for_curation(
    v_submission_id, 999, 2, 1, 2, 'test-v1', true, true);
  IF result->>'status' <> 'conflict' THEN
    RAISE EXCEPTION 'resubmission retry ignored the original CAS token: %', result;
  END IF;

  UPDATE private.reference_curation_intake_policy SET submissions_enabled = false WHERE singleton;
  result := public.resubmit_private_reference_for_curation(
    v_submission_id, 3, 2, 1, 2, 'test-v1', false, false);
  IF result->>'status' <> 'no_change'
     OR (result->'submission'->>'row_version')::bigint <> 4 THEN
    RAISE EXCEPTION 'exact resubmission retry was not stable: %', result;
  END IF;
  UPDATE private.reference_curation_intake_policy SET submissions_enabled = true WHERE singleton;

  result := public.withdraw_private_reference_curation_submission(
    v_submission_id, 4, 'free-form private reason');
  IF result->>'status' <> 'invalid_payload' THEN
    RAISE EXCEPTION 'unbounded withdrawal reason was accepted: %', result;
  END IF;
  result := public.withdraw_private_reference_curation_submission(
    v_submission_id, 3, 'source_needs_revision');
  IF result->>'status' <> 'conflict' THEN
    RAISE EXCEPTION 'withdrawal ignored stale CAS: %', result;
  END IF;
  result := public.withdraw_private_reference_curation_submission(
    v_submission_id, 4, 'source_needs_revision');
  IF result->>'status' <> 'updated' OR result->'submission'->>'status' <> 'withdrawn' THEN
    RAISE EXCEPTION 'withdrawal failed: %', result;
  END IF;
  IF (SELECT withdrawal_code FROM private.reference_curation_submissions
       WHERE id = v_submission_id) <> 'source_needs_revision'
     OR (SELECT reason FROM private.reference_curation_events
          WHERE target_type = 'submission' AND target_id = v_submission_id
            AND action = 'withdraw' ORDER BY created_at DESC, id DESC LIMIT 1)
        <> 'source_needs_revision' THEN
    RAISE EXCEPTION 'bounded withdrawal reason was not captured';
  END IF;
  SELECT count(*) INTO event_count FROM private.reference_curation_events
   WHERE target_type = 'submission' AND target_id = v_submission_id AND action = 'withdraw';
  result := public.withdraw_private_reference_curation_submission(
    v_submission_id, 4, 'source_needs_revision');
  IF result->>'status' <> 'no_change'
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE target_type = 'submission' AND target_id = v_submission_id AND action = 'withdraw') <> event_count THEN
    RAISE EXCEPTION 'withdrawal retry was not an exact no-op: %', result;
  END IF;
  result := public.withdraw_private_reference_curation_submission(
    v_submission_id, 4, 'rights_uncertain');
  IF result->>'status' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'withdrawal retry accepted a different reason: %', result;
  END IF;
  result := public.withdraw_private_reference_curation_submission(
    v_submission_id, 999, 'source_needs_revision');
  IF result->>'status' <> 'conflict' THEN
    RAISE EXCEPTION 'withdrawal retry accepted a different CAS token: %', result;
  END IF;

  -- Identical terminal content is returned, while changed content starts a
  -- new linked submission rather than reopening the old row.
  result := public.submit_private_reference_for_curation(set_a, 2, 1, 2, 'test-v1', true, true);
  IF result->>'status' <> 'no_change'
     OR (result->'submission'->>'id')::uuid <> v_submission_id THEN
    RAISE EXCEPTION 'identical terminal candidate was reopened: %', result;
  END IF;
  UPDATE public.reference_measurement_sets
     SET raw_text = '9-11 × 5-6 µm', revision = 3
   WHERE user_id = owner_a AND id = set_a;
  result := public.submit_private_reference_for_curation(set_a, 2, 1, 3, 'test-v1', true, true);
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'changed terminal candidate did not create a new submission: %', result;
  END IF;
  v_second_submission_id := (result->'submission'->>'id')::uuid;
  IF (SELECT prior_submission_id FROM private.reference_curation_submissions
       WHERE id = v_second_submission_id) IS DISTINCT FROM v_submission_id THEN
    RAISE EXCEPTION 'new submission did not link its terminal predecessor';
  END IF;

  BEGIN
    UPDATE private.reference_curation_submission_versions
       SET candidate_json = candidate_json || '{"forged":true}'::jsonb
     WHERE submission_id = v_submission_id AND candidate_revision = 1;
    RAISE EXCEPTION 'candidate version update succeeded';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    DELETE FROM private.reference_curation_submission_versions
     WHERE submission_id = v_submission_id AND candidate_revision = 1;
    RAISE EXCEPTION 'candidate version delete succeeded';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_b::text, 'role', 'authenticated')::text, true);
  UPDATE private.reference_curation_intake_policy SET submission_rate_limit = 4 WHERE singleton;
  UPDATE public.reference_works
     SET authors_json = '["Owner B",{"given":"Given only","private_note":"DROP ME"}]'
   WHERE user_id = owner_b AND id = work_b;
  UPDATE public.reference_measurement_sets
     SET raw_points_json = '[8.1,{"l":8.2,"w":4.4,"private_note":"DROP ME"},{"width":4.5}]'
   WHERE user_id = owner_b AND id = set_b;
  UPDATE public.reference_measurement_sets SET raw_points_json = '["not-a-point"]'
   WHERE user_id = owner_b AND id = set_b;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'source_out_of_bounds' THEN
    RAISE EXCEPTION 'malformed raw-point element did not fail closed: %', result;
  END IF;
  UPDATE public.reference_measurement_sets
     SET raw_points_json = '[8.1,{"l":8.2,"w":4.4,"private_note":"DROP ME"},{"width":4.5}]'
   WHERE user_id = owner_b AND id = set_b;
  UPDATE public.reference_works SET year = 0 WHERE user_id = owner_b AND id = work_b;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'source_out_of_bounds' THEN
    RAISE EXCEPTION 'curation-invalid year entered a candidate: %', result;
  END IF;
  UPDATE public.reference_works SET year = 2025 WHERE user_id = owner_b AND id = work_b;
  UPDATE public.reference_works SET title = repeat('x', 2049)
   WHERE user_id = owner_b AND id = work_b;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'source_out_of_bounds' THEN
    RAISE EXCEPTION 'oversized source graph was accepted: %', result;
  END IF;
  UPDATE public.reference_works SET title = 'Owner B work'
   WHERE user_id = owner_b AND id = work_b;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'rate-limit fixture submission failed: %', result;
  END IF;
  SELECT candidate_json INTO candidate
    FROM private.reference_curation_submission_versions
   WHERE submission_id = (result->'submission'->>'id')::uuid AND candidate_revision = 1;
  IF candidate::text LIKE '%private_note%'
     OR candidate->'work'->'authors' <> '[{"family":"Owner B"},{"given":"Given only"}]'::jsonb
     OR candidate->'measurement_set'->'raw_points'
        <> '[8.1,{"length":8.2,"width":4.4},{"width":4.5}]'::jsonb THEN
    RAISE EXCEPTION 'legacy-compatible nested data was not safely canonicalized: %', candidate;
  END IF;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'exact retry was counted against the rate limit: %', result;
  END IF;
  result := public.submit_private_reference_for_curation(set_b2, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'rate_limited' THEN
    RAISE EXCEPTION 'new submission bypassed the account rate limit: %', result;
  END IF;

  UPDATE public.profiles SET is_banned = true WHERE id = owner_b;
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'account_unavailable' THEN
    RAISE EXCEPTION 'banned owner reached intake: %', result;
  END IF;
  UPDATE public.profiles SET is_banned = false WHERE id = owner_b;
  INSERT INTO private.reference_account_deletions(user_id) VALUES(owner_b);
  result := public.submit_private_reference_for_curation(set_b, 1, 1, 1, 'test-v1', true, true);
  IF result->>'status' <> 'account_deleting' THEN
    RAISE EXCEPTION 'deletion marker did not block intake: %', result;
  END IF;

  BEGIN
    INSERT INTO private.reference_curation_submissions (
      contributor_id, source_measurement_set_id,
      initial_work_revision, initial_treatment_revision, initial_measurement_set_revision,
      initial_content_hash, initial_attestation_version, status,
      current_candidate_revision, current_content_hash, current_attestation_version
    ) VALUES (
      owner_a, set_a, 2, 1, 3, repeat('a', 64), 'test-v1', 'accepted',
      1, repeat('a', 64), 'test-v1'
    );
    RAISE EXCEPTION 'service path inserted a submission in a terminal state';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.reference_curation_submission_versions (
      submission_id, candidate_revision, candidate_schema_version, candidate_json,
      content_hash, source_work_revision, source_treatment_revision,
      source_measurement_set_revision, expected_submission_row_version,
      attestation_version, attestation_content_hash,
      rights_confirmed, curation_consent_confirmed
    ) SELECT v_submission_id, 3, 1, candidate_json, repeat('f', 64),
             2, 1, 3, 4, attestation_version, attestation_content_hash, true, true
        FROM private.reference_curation_submission_versions
       WHERE submission_id = v_submission_id AND candidate_revision = 2;
    RAISE EXCEPTION 'service path inserted a candidate with a forged content hash';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE private.reference_curation_intake_policy
     SET attestation_version = 'test-v2',
         attestation_text = 'TEST ONLY: revised contributor rights wording.'
   WHERE singleton;
  BEGIN
    UPDATE private.reference_curation_intake_policy
       SET attestation_version = 'test-v1',
           attestation_text = 'TEST ONLY: incompatible reuse of version one.'
     WHERE singleton;
    RAISE EXCEPTION 'attestation version was rebound to different wording';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;

-- Exercise the actual PostgREST caller role, not only the definer's domain
-- behavior under the test owner. This also proves authenticated callers need
-- no direct private-schema privilege.
SET LOCAL request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000006b01","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
DECLARE result jsonb;
BEGIN
  result := public.submit_private_reference_for_curation(
    '63000000-0000-4000-8000-000000006b01', 2, 1, 3, 'test-v1', true, true
  );
  IF result->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'authenticated caller could not execute hardened intake RPC: %', result;
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;
