-- Stage 6c curated-draft editing, taxon assignment, and exact duplicate warnings.

BEGIN;

DO $$
DECLARE
  owner_id constant uuid := '00000000-0000-4000-8000-000000006c21';
  reviewer_id constant uuid := '00000000-0000-4000-8000-000000006c22';
  reviewer_session_id constant uuid := '70000000-0000-4000-8000-000000006c22';
  source_work constant uuid := '61000000-0000-4000-8000-000000006c21';
  source_treatment constant uuid := '62000000-0000-4000-8000-000000006c21';
  source_set constant uuid := '63000000-0000-4000-8000-000000006c21';
  near_match_work constant uuid := '61000000-0000-4000-8000-000000006c29';
  taxon_assignment constant uuid := '64000000-0000-4000-8000-000000006c21';
  submission_id uuid;
  candidate_revision integer;
  candidate_hash text;
  curated_work uuid;
  curated_treatment uuid;
  curated_set uuid;
  request_id uuid;
  result jsonb;
  event_count integer;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_id,'authenticated','authenticated','stage6c-edit-owner@example.invalid','{}',now(),now()),
    (reviewer_id,'authenticated','authenticated','stage6c-edit-reviewer@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (owner_id,'stage6c_edit_owner',false),(reviewer_id,'stage6c_edit_reviewer',false);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal)
  VALUES(reviewer_session_id,reviewer_id,now(),now(),'aal1');
  INSERT INTO private.reference_curator_memberships(user_id,role,granted_by,reason)
  VALUES(reviewer_id,'reference_reviewer',reviewer_id,'Stage 6c edit test');
  INSERT INTO taxonomy_v3.registry_concept
    (sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release)
  VALUES(2100000063,'Russula exacta','species','include','in_cache','stage6c-test');

  INSERT INTO public.reference_works
    (user_id,id,type,authors_json,title,year,doi,isbn,short_label,revision)
  VALUES(owner_id,source_work,'article','[{"family":"Exact","given":"Ada"}]',
    'Exact bibliography',2026,'10.1000/STAGE6C-EXACT','978-1-4028-9462-6','Exact 2026',1);
  INSERT INTO public.reference_taxon_treatments
    (user_id,id,reference_work_id,name_as_published,locator_text,revision)
  VALUES(owner_id,source_treatment,source_work,'Russula exacta','p. 63',1);
  INSERT INTO public.reference_measurement_sets
    (user_id,id,taxon_treatment_id,character,data_kind,raw_text,
     length_core_min,length_core_max,width_core_min,width_core_max,revision)
  VALUES(owner_id,source_set,source_treatment,'spore_size','range','8-10 x 5-6 um',
    8,10,5,6,1);
  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled=true,attestation_version='stage6c-edit-v1',
         attestation_text='TEST ONLY Stage 6c edit consent.',
         submission_rate_window=interval '1 hour',submission_rate_limit=20,
         unaccepted_submission_retention=interval '0 seconds'
   WHERE singleton;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',owner_id::text,'role','authenticated')::text,true);
  result:=public.submit_private_reference_for_curation(
    source_set,1,1,1,'stage6c-edit-v1',true,true);
  submission_id:=(result->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission_id;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'claim',submission_id,1,
    candidate_revision,candidate_hash,NULL,'{}');
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'accept_to_draft',submission_id,2,
    candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'edit fixture acceptance failed: %',result; END IF;
  SELECT accepted_curated_work_id,accepted_curated_treatment_id,
         accepted_curated_measurement_set_id
    INTO curated_work,curated_treatment,curated_set
    FROM private.reference_curation_submissions WHERE id=submission_id;

  INSERT INTO private.curated_reference_works(
    id,type,authors_json,title,year,publisher,doi,short_label,revision,created_by,updated_by
  ) VALUES(
    near_match_work,'article','[{"family":"Exact","given":"Ada"}]',
    'Exact bibliography',2026,'Different publisher',
    'https://doi.org/10.1000/stage6c-exact','Near match',1,reviewer_id,reviewer_id
  );

  -- Exact identifiers and exact normalized bibliography are warnings only.
  result:=public.get_reference_curation_duplicate_warnings(
    reviewer_id,reviewer_session_id,submission_id,candidate_revision,candidate_hash);
  IF result->>'status'<>'ok'
     OR NOT jsonb_path_exists(result,'$.warnings[*] ? (@.kind == "exact_doi")')
     OR NOT jsonb_path_exists(result,'$.warnings[*] ? (@.kind == "normalized_isbn")')
     OR NOT jsonb_path_exists(result,'$.warnings[*] ? (@.kind == "exact_bibliography")') THEN
    RAISE EXCEPTION 'exact duplicate warnings missing: %',result;
  END IF;
  IF NOT EXISTS(
       SELECT 1 FROM pg_catalog.jsonb_array_elements(result->'warnings') warning
        WHERE warning->>'kind'='exact_doi'
          AND (warning->>'curated_work_id')::uuid=near_match_work
     ) OR EXISTS(
       SELECT 1 FROM pg_catalog.jsonb_array_elements(result->'warnings') warning
        WHERE warning->>'kind'='exact_bibliography'
          AND (warning->>'curated_work_id')::uuid=near_match_work
     ) THEN
    RAISE EXCEPTION 'normalized DOI or exact structured bibliography warning was imprecise: %',result;
  END IF;
  IF result::text LIKE '%'||owner_id::text||'%'
     OR result::text LIKE '%'||source_work::text||'%'
     OR result::text LIKE '%'||source_treatment::text||'%'
     OR result::text LIKE '%'||source_set::text||'%' THEN
    RAISE EXCEPTION 'duplicate warnings leaked private source identities: %',result;
  END IF;
  INSERT INTO private.curated_reference_works(
    id,type,title,doi,short_label,revision,created_by,updated_by
  )
  SELECT gen_random_uuid(),'article','Bounded warning '||series,
         'doi: 10.1000/stage6c-exact','Bounded '||series,1,reviewer_id,reviewer_id
    FROM generate_series(1,101) series;
  result:=public.get_reference_curation_duplicate_warnings(
    reviewer_id,reviewer_session_id,submission_id,candidate_revision,candidate_hash);
  IF result->>'status'<>'ok' OR jsonb_array_length(result->'warnings')<>100 THEN
    RAISE EXCEPTION 'duplicate warnings were not deterministically capped: %',result;
  END IF;

  request_id:=gen_random_uuid();
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'edit_draft',curated_work,1,
    NULL,NULL,'Correct exact bibliography.',
    '{"target_type":"work","patch":{"title":"Edited exact bibliography"}}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_works
                    WHERE id=curated_work AND title='Edited exact bibliography'
                      AND revision=2 AND row_version=2) THEN
    RAISE EXCEPTION 'work draft edit failed: %',result;
  END IF;
  SELECT count(*) INTO event_count FROM private.reference_curation_events
   WHERE action='edit_draft' AND target_id=curated_work;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'edit_draft',curated_work,1,
    NULL,NULL,'Correct exact bibliography.',
    '{"target_type":"work","patch":{"title":"Edited exact bibliography"}}');
  IF result->>'status'<>'no_change'
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action='edit_draft' AND target_id=curated_work)<>event_count THEN
    RAISE EXCEPTION 'draft edit retry was not exact/idempotent: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_work,2,
    NULL,NULL,'Confirm already-correct title.',
    '{"target_type":"work","patch":{"title":"Edited exact bibliography"}}');
  IF result->>'status'<>'no_change'
     OR (SELECT row_version FROM private.curated_reference_works WHERE id=curated_work)<>2 THEN
    RAISE EXCEPTION 'value-identical draft edit churned revision state: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'edit_draft',curated_work,2,
    NULL,NULL,'Different retry.',
    '{"target_type":"work","patch":{"title":"Different title"}}');
  IF result->>'status'<>'idempotency_conflict' THEN
    RAISE EXCEPTION 'draft edit request id was reused: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_work,1,
    NULL,NULL,'Stale edit.',
    '{"target_type":"work","patch":{"title":"Stale title"}}');
  IF result->>'status'<>'conflict' THEN RAISE EXCEPTION 'draft edit ignored stale CAS: %',result; END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_work,2,
    NULL,NULL,'Lifecycle fields are not editable here.',
    '{"target_type":"work","patch":{"catalogue_status":"published"}}');
  IF result->>'status'<>'invalid_payload' THEN
    RAISE EXCEPTION 'draft editor accepted an unknown/lifecycle key: %',result;
  END IF;

  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_treatment,1,
    NULL,NULL,'Correct locator.',
    '{"target_type":"treatment","patch":{"locator_text":"pp. 63-64"}}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments
                    WHERE id=curated_treatment AND locator_text='pp. 63-64'
                      AND revision=2 AND row_version=2) THEN
    RAISE EXCEPTION 'treatment draft edit failed: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_set,1,
    NULL,NULL,'Correct range.',
    '{"target_type":"measurement_set","patch":{"raw_text":"8.0-10.0 x 5.0-6.0 um"}}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=curated_set AND raw_text='8.0-10.0 x 5.0-6.0 um'
                      AND revision=2 AND row_version=2 AND catalogue_status='draft') THEN
    RAISE EXCEPTION 'measurement-set draft edit failed: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_set,2,
    NULL,NULL,'Add exact measured points.',
    '{"target_type":"measurement_set","patch":{"raw_points":[{"length":9.1,"width":5.4}]}}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=curated_set AND jsonb_array_length(raw_points_json)=1
                      AND row_version=3) THEN
    RAISE EXCEPTION 'measurement-set raw-point edit failed: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',curated_set,3,
    NULL,NULL,'Clear measured points.',
    '{"target_type":"measurement_set","patch":{"raw_points":null}}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=curated_set AND raw_points_json IS NULL AND row_version=4) THEN
    RAISE EXCEPTION 'measurement-set raw points did not clear to SQL NULL: %',result;
  END IF;

  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',taxon_assignment,0,
    NULL,NULL,'Exact species assignment.',
    jsonb_build_object('target_type','treatment_taxa','patch',jsonb_build_object(
      'taxon_treatment_id',curated_treatment,'sporely_taxon_id',2100000063,
      'assignment_reason','Exact accepted treatment name')));
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa
                    WHERE id=taxon_assignment AND taxon_treatment_id=curated_treatment
                      AND sporely_taxon_id=2100000063 AND revision=1 AND row_version=1) THEN
    RAISE EXCEPTION 'draft taxon assignment create failed: %',result;
  END IF;
  result:=public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'edit_draft',taxon_assignment,1,
    NULL,NULL,'Improve assignment evidence.',
    '{"target_type":"treatment_taxa","patch":{"assignment_reason":"Exact name and treatment context"}}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa
                    WHERE id=taxon_assignment AND assignment_reason='Exact name and treatment context'
                      AND revision=2 AND row_version=2) THEN
    RAISE EXCEPTION 'draft taxon assignment update failed: %',result;
  END IF;
END
$$;

ROLLBACK;
