-- Stage 6c accept-to-draft atomicity, provenance, privacy, and retry contract.

BEGIN;

CREATE FUNCTION private.stage6c_test_reject_draft_set()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'stage6c injected draft failure' USING ERRCODE='23514';
END
$$;

DO $$
DECLARE
  owner_id constant uuid := '00000000-0000-4000-8000-000000006c11';
  reviewer_id constant uuid := '00000000-0000-4000-8000-000000006c12';
  reviewer_session_id constant uuid := '70000000-0000-4000-8000-000000006c12';
  work_id constant uuid := '61000000-0000-4000-8000-000000006c11';
  treatment_id constant uuid := '62000000-0000-4000-8000-000000006c11';
  set_id constant uuid := '63000000-0000-4000-8000-000000006c11';
  set_rollback constant uuid := '63000000-0000-4000-8000-000000006c12';
  set_link constant uuid := '63000000-0000-4000-8000-000000006c13';
  submission_id uuid;
  rollback_submission_id uuid;
  link_submission_id uuid;
  candidate_revision integer;
  candidate_hash text;
  accepted_work uuid;
  accepted_treatment uuid;
  accepted_set uuid;
  request_id uuid;
  result jsonb;
  work_count integer;
  treatment_count integer;
  set_count integer;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_id,'authenticated','authenticated','stage6c-accept-owner@example.invalid','{}',now(),now()),
    (reviewer_id,'authenticated','authenticated','stage6c-accept-reviewer@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (owner_id,'stage6c_accept_owner',false),(reviewer_id,'stage6c_accept_reviewer',false);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal)
  VALUES(reviewer_session_id,reviewer_id,now(),now(),'aal1');
  INSERT INTO private.reference_curator_memberships(user_id,role,granted_by,reason)
  VALUES(reviewer_id,'reference_reviewer',reviewer_id,'Stage 6c acceptance test');
  INSERT INTO public.reference_works
    (user_id,id,type,citation_key,authors_json,title,short_label,revision)
  VALUES(owner_id,work_id,'article','PRIVATE-KEY','[{"family":"Exact"}]',
    'Accepted source','Exact 2026',1);
  INSERT INTO public.reference_taxon_treatments
    (user_id,id,reference_work_id,taxon_id,name_as_published,treatment_notes,revision)
  VALUES(owner_id,treatment_id,work_id,'private-taxon','Russula exacta','PRIVATE NOTE',1);
  INSERT INTO public.reference_measurement_sets
    (user_id,id,taxon_treatment_id,character,data_kind,raw_text,notes,revision)
  VALUES
    (owner_id,set_id,treatment_id,'spore_size','range','8-10 × 5-6 µm','PRIVATE SET NOTE',1),
    (owner_id,set_rollback,treatment_id,'spore_size','range','7-9 × 4-5 µm','PRIVATE ROLLBACK NOTE',1),
    (owner_id,set_link,treatment_id,'spore_size','range','9-11 × 5-7 µm','PRIVATE LINK NOTE',1);
  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled=true,attestation_version='stage6c-accept-v1',
         attestation_text='TEST ONLY Stage 6c acceptance consent.',
         submission_rate_window=interval '1 hour',submission_rate_limit=20,
         unaccepted_submission_retention=interval '0 seconds'
   WHERE singleton;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',owner_id::text,'role','authenticated')::text,true);

  result:=public.submit_private_reference_for_curation(set_id,1,1,1,'stage6c-accept-v1',true,true);
  submission_id:=(result->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission_id;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'accept fixture claim failed: %',result; END IF;

  request_id:=gen_random_uuid();
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'accept_to_draft',submission_id,2,
    candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'accept-to-draft failed: %',result; END IF;
  SELECT accepted_curated_work_id,accepted_curated_treatment_id,
         accepted_curated_measurement_set_id
    INTO accepted_work,accepted_treatment,accepted_set
    FROM private.reference_curation_submissions WHERE id=submission_id;
  IF accepted_work IS NULL OR accepted_treatment IS NULL OR accepted_set IS NULL
     OR accepted_work=work_id OR accepted_treatment=treatment_id OR accepted_set=set_id THEN
    RAISE EXCEPTION 'acceptance did not create fresh curated identities';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM private.reference_curation_submissions s
     WHERE s.id=submission_id AND s.status='accepted' AND s.row_version=3
       AND s.claimed_by IS NULL AND s.accepted_candidate_revision=candidate_revision
       AND s.accepted_content_hash=candidate_hash AND s.accepted_by=reviewer_id
       AND s.accepted_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'accepted submission lacks exact immutable provenance'; END IF;
  BEGIN
    UPDATE private.reference_curation_submissions
       SET accepted_at=accepted_at+interval '1 second',row_version=row_version+1
     WHERE id=submission_id;
    RAISE EXCEPTION 'accepted provenance remained mutable';
  EXCEPTION WHEN SQLSTATE '25006' THEN
    NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM private.curated_reference_works w
    JOIN private.curated_reference_taxon_treatments t ON t.reference_work_id=w.id
    JOIN private.curated_reference_measurement_sets m ON m.taxon_treatment_id=t.id
    WHERE w.id=accepted_work AND t.id=accepted_treatment AND m.id=accepted_set
      AND w.title='Accepted source' AND w.citation_key IS NULL
      AND t.name_as_published='Russula exacta' AND t.treatment_notes IS NULL
      AND m.raw_text='8-10 × 5-6 µm' AND m.notes IS NULL
      AND w.revision=1 AND w.row_version=1
      AND t.revision=1 AND t.row_version=1
      AND m.revision=1 AND m.row_version=1 AND m.catalogue_status='draft'
  ) THEN RAISE EXCEPTION 'accepted draft was not an exact privacy-safe materialization'; END IF;
  IF EXISTS (SELECT 1 FROM private.curated_reference_publications
              WHERE curated_measurement_set_id=accepted_set)
     OR EXISTS (SELECT 1 FROM private.curated_reference_treatment_taxa
                 WHERE taxon_treatment_id=accepted_treatment) THEN
    RAISE EXCEPTION 'acceptance prematurely published or inferred a taxon assignment';
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'accept_to_draft',submission_id,2,
    candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status'<>'no_change'
     OR (SELECT accepted_curated_measurement_set_id
          FROM private.reference_curation_submissions WHERE id=submission_id)<>accepted_set THEN
    RAISE EXCEPTION 'acceptance retry did not preserve generated IDs: %',result;
  END IF;

  -- Explicit reuse is hierarchy-prefix-only, CAS-protected, and never inferred.
  result:=public.submit_private_reference_for_curation(set_link,1,1,1,'stage6c-accept-v1',true,true);
  link_submission_id:=(result->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=link_submission_id;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'claim',link_submission_id,1,
    candidate_revision,candidate_hash,NULL,'{}');
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'accept_to_draft',link_submission_id,2,
    candidate_revision,candidate_hash,'Reuse the exact reviewed work record.',
    jsonb_build_object('existing_curated_work_id',accepted_work,
                       'expected_curated_work_row_version',1));
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.reference_curation_submissions s
                    WHERE s.id=link_submission_id
                      AND s.accepted_curated_work_id=accepted_work
                      AND s.accepted_curated_treatment_id<>accepted_treatment
                      AND s.accepted_curated_measurement_set_id<>accepted_set) THEN
    RAISE EXCEPTION 'valid explicit work-prefix linkage failed or auto-linked descendants: %',result;
  END IF;

  -- A partial explicit hierarchy is invalid and never silently auto-links.
  result:=public.submit_private_reference_for_curation(set_rollback,1,1,1,'stage6c-accept-v1',true,true);
  rollback_submission_id:=(result->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=rollback_submission_id;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'claim',rollback_submission_id,1,
    candidate_revision,candidate_hash,NULL,'{}');
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'accept_to_draft',rollback_submission_id,2,
    candidate_revision,candidate_hash,'Attempt invalid non-prefix reuse.',
    jsonb_build_object('existing_curated_treatment_id',accepted_treatment,
                       'expected_curated_treatment_row_version',1));
  IF result->>'status'<>'invalid_payload' THEN
    RAISE EXCEPTION 'non-prefix explicit linkage was accepted: %',result;
  END IF;

  SELECT count(*) INTO work_count FROM private.curated_reference_works;
  SELECT count(*) INTO treatment_count FROM private.curated_reference_taxon_treatments;
  SELECT count(*) INTO set_count FROM private.curated_reference_measurement_sets;
  EXECUTE 'CREATE TRIGGER stage6c_injected_failure BEFORE INSERT ON private.curated_reference_measurement_sets '
       || 'FOR EACH ROW EXECUTE FUNCTION private.stage6c_test_reject_draft_set()';
  BEGIN
    result:=public.mutate_reference_curation(
      reviewer_id,reviewer_session_id,gen_random_uuid(),'accept_to_draft',rollback_submission_id,2,
      candidate_revision,candidate_hash,NULL,'{}');
    IF result->>'status' NOT IN ('failed','invalid_payload') THEN
      RAISE EXCEPTION 'injected accept failure returned success: %',result;
    END IF;
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  EXECUTE 'DROP TRIGGER stage6c_injected_failure ON private.curated_reference_measurement_sets';
  IF (SELECT count(*) FROM private.curated_reference_works)<>work_count
     OR (SELECT count(*) FROM private.curated_reference_taxon_treatments)<>treatment_count
     OR (SELECT count(*) FROM private.curated_reference_measurement_sets)<>set_count
     OR NOT EXISTS (SELECT 1 FROM private.reference_curation_submissions
                     WHERE id=rollback_submission_id AND status='in_review' AND row_version=2) THEN
    RAISE EXCEPTION 'failed acceptance left a partial draft or advanced workflow';
  END IF;

  PERFORM public.delete_reference_library_for_account(reviewer_id);
  DELETE FROM public.profiles WHERE id=reviewer_id;
  IF EXISTS(SELECT 1 FROM private.reference_curation_submissions WHERE accepted_by=reviewer_id)
     OR NOT EXISTS(SELECT 1 FROM private.reference_curation_submissions
                    WHERE id=submission_id AND status='accepted' AND accepted_by IS NULL
                      AND accepted_curated_measurement_set_id=accepted_set) THEN
    RAISE EXCEPTION 'reviewer deletion did not anonymize and preserve accepted provenance';
  END IF;
END
$$;

ROLLBACK;
