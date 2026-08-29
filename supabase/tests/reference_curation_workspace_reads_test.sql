-- Stage 6e service-only curator workspace read projections.

BEGIN;

DO $$
DECLARE
  owner_id constant uuid := '00000000-0000-4000-8000-000000006e01';
  reviewer_id constant uuid := '00000000-0000-4000-8000-000000006e02';
  publisher_id constant uuid := '00000000-0000-4000-8000-000000006e03';
  admin_id constant uuid := '00000000-0000-4000-8000-000000006e04';
  outsider_id constant uuid := '00000000-0000-4000-8000-000000006e05';
  reviewer_session constant uuid := '70000000-0000-4000-8000-000000006e02';
  publisher_session constant uuid := '70000000-0000-4000-8000-000000006e03';
  admin_session constant uuid := '70000000-0000-4000-8000-000000006e04';
  outsider_session constant uuid := '70000000-0000-4000-8000-000000006e05';
  source_work constant uuid := '61000000-0000-4000-8000-000000006e01';
  source_treatment constant uuid := '62000000-0000-4000-8000-000000006e01';
  source_set constant uuid := '63000000-0000-4000-8000-000000006e01';
  source_set_2 constant uuid := '63000000-0000-4000-8000-000000006e02';
  taxon_id constant integer := 2100000065;
  result jsonb;
  submission_id uuid;
  second_submission_id uuid;
  first_queue_id uuid;
  second_queue_id uuid;
  candidate_revision integer;
  candidate_hash text;
  curated_work uuid;
  curated_treatment uuid;
  curated_set uuid;
  assignment_id uuid := '64000000-0000-4000-8000-000000006e01';
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_id,'authenticated','authenticated','stage6e-owner@example.invalid','{}',now(),now()),
    (reviewer_id,'authenticated','authenticated','stage6e-reviewer@example.invalid','{}',now(),now()),
    (publisher_id,'authenticated','authenticated','stage6e-publisher@example.invalid','{}',now(),now()),
    (admin_id,'authenticated','authenticated','stage6e-admin@example.invalid','{}',now(),now()),
    (outsider_id,'authenticated','authenticated','stage6e-outsider@example.invalid',
      '{"reference_role":"reference_publisher"}',now(),now());
  INSERT INTO public.profiles(id,username,is_admin,is_banned) VALUES
    (owner_id,'stage6e_owner',false,false),(reviewer_id,'stage6e_reviewer',false,false),
    (publisher_id,'stage6e_publisher',false,false),(admin_id,'stage6e_admin',true,false),
    (outsider_id,'stage6e_outsider',false,false);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal) VALUES
    (reviewer_session,reviewer_id,now(),now(),'aal1'),
    (publisher_session,publisher_id,now(),now(),'aal1'),
    (admin_session,admin_id,now(),now(),'aal1'),
    (outsider_session,outsider_id,now(),now(),'aal1');
  INSERT INTO private.reference_curator_memberships(user_id,role,granted_by,reason) VALUES
    (reviewer_id,'reference_reviewer',admin_id,'Stage 6e reviewer fixture'),
    (publisher_id,'reference_publisher',admin_id,'Stage 6e publisher fixture');

  result := public.get_reference_curation_capabilities(reviewer_id,reviewer_session);
  IF result #>> '{capabilities,role}' <> 'reference_reviewer'
     OR (result #>> '{capabilities,can_review}')::boolean IS NOT TRUE
     OR (result #>> '{capabilities,can_publish}')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'reviewer capabilities incorrect: %', result;
  END IF;
  result := public.get_reference_curation_capabilities(publisher_id,publisher_session);
  IF result #>> '{capabilities,role}' <> 'reference_publisher'
     OR (result #>> '{capabilities,can_publish}')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'publisher capabilities incorrect: %', result;
  END IF;
  result := public.get_reference_curation_capabilities(admin_id,admin_session);
  IF result #>> '{capabilities,role}' <> 'admin'
     OR (result #>> '{capabilities,can_review}')::boolean IS NOT TRUE
     OR (result #>> '{capabilities,can_publish}')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'admin capabilities incorrect: %', result;
  END IF;
  IF public.get_reference_curation_capabilities(outsider_id,outsider_session)->>'status' <> 'forbidden'
     OR public.get_reference_curation_capabilities(reviewer_id,outsider_session)->>'status' <> 'forbidden' THEN
    RAISE EXCEPTION 'untrusted role metadata or actor/session mismatch authorized reads';
  END IF;

  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES(taxon_id,'Russula workspace','species','include','in_cache','stage6e-test');
  INSERT INTO public.reference_works(
    user_id,id,type,authors_json,title,year,short_label,revision
  ) VALUES(owner_id,source_work,'article','[{"family":"Hostile <script>"}]',
    'Workspace & <script>alert(1)</script>',2026,'Hostile 2026',1);
  INSERT INTO public.reference_taxon_treatments(
    user_id,id,reference_work_id,name_as_published,locator_text,revision
  ) VALUES(owner_id,source_treatment,source_work,'Russula <b>workspace</b>','p. 6',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,raw_text,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES
    (owner_id,source_set,source_treatment,'spore_size','range',
      '8–10 × 5–6 µm <img onerror=alert(1)>',8,10,5,6,1),
    (owner_id,source_set_2,source_treatment,'spore_size','range',
      '9–11 × 6–7 µm',9,11,6,7,1);
  INSERT INTO private.reference_curation_attestation_versions(
    attestation_version,attestation_text
  ) VALUES('stage6e-v1','TEST ONLY Stage 6e rights and consent.');
  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled=true,attestation_version='stage6e-v1',
         attestation_text='TEST ONLY Stage 6e rights and consent.',
         submission_rate_window=interval '1 hour',submission_rate_limit=10,
         unaccepted_submission_retention=interval '0 seconds'
   WHERE singleton;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',owner_id::text,'role','authenticated')::text,true);
  result := public.submit_private_reference_for_curation(
    source_set,1,1,1,'stage6e-v1',true,true
  );
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'submission fixture failed: %',result; END IF;
  submission_id := (result #>> '{submission,id}')::uuid;
  SELECT current_candidate_revision,current_content_hash
    INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission_id;

  result := public.submit_private_reference_for_curation(
    source_set_2,1,1,1,'stage6e-v1',true,true
  );
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'second fixture failed: %',result; END IF;
  second_submission_id := (result #>> '{submission,id}')::uuid;
  first_queue_id := least(submission_id, second_submission_id);
  second_queue_id := greatest(submission_id, second_submission_id);

  result := public.list_reference_curation_queue(
    reviewer_id,reviewer_session,'submitted',1,NULL,NULL
  );
  IF result->>'status' <> 'ok'
     OR pg_catalog.jsonb_array_length(result->'items') <> 1
     OR result #>> '{items,0,id}' <> first_queue_id::text
     OR result->'next_cursor' = 'null'::jsonb
     OR result #> '{items,0}' ?| ARRAY['contributor_id','source_measurement_set_id','attestation_version'] THEN
    RAISE EXCEPTION 'queue projection was incomplete or leaked private intake fields: %',result;
  END IF;
  IF (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(result->'items'->0) k)
       IS DISTINCT FROM ARRAY[
         'accepted_curated_measurement_set_id','claimed_at','claimed_by','created_at',
         'current_candidate_revision','current_content_hash','feedback_text','id','row_version',
         'status','updated_at'
       ]::text[] THEN
    RAISE EXCEPTION 'queue projection key set changed: %',result->'items'->0;
  END IF;
  result := public.list_reference_curation_queue(
    reviewer_id,reviewer_session,'submitted',1,
    (result #>> '{next_cursor,created_at}')::timestamptz,
    (result #>> '{next_cursor,id}')::uuid
  );
  IF result #>> '{items,0,id}' <> second_queue_id::text OR result->'next_cursor' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'queue cursor was not deterministic: %',result;
  END IF;
  IF public.list_reference_curation_queue(
       reviewer_id,reviewer_session,NULL,51,NULL,NULL
     )->>'status' <> 'invalid_request' THEN
    RAISE EXCEPTION 'queue accepted an out-of-bounds limit';
  END IF;
  IF public.get_reference_curation_detail(
       reviewer_id,reviewer_session,'ffffffff-ffff-4fff-8fff-ffffffffffff'
     )->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'missing detail did not fail closed';
  END IF;
  result := public.get_reference_curation_detail(reviewer_id,reviewer_session,submission_id);
  IF result->>'status' <> 'ok' OR result #> '{detail,candidate}' IS NULL
     OR result #>> '{detail,candidate,work,title}' <> 'Workspace & <script>alert(1)</script>'
     OR result #> '{detail,accepted_graph}' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'submitted detail projection incorrect: %',result;
  END IF;

  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session,gen_random_uuid(),'claim',submission_id,1,
    candidate_revision,candidate_hash,NULL,'{}'
  );
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'claim fixture failed: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session,gen_random_uuid(),'accept_to_draft',submission_id,2,
    candidate_revision,candidate_hash,NULL,'{}'
  );
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'accept fixture failed: %',result; END IF;
  SELECT accepted_curated_work_id,accepted_curated_treatment_id,accepted_curated_measurement_set_id
    INTO curated_work,curated_treatment,curated_set
    FROM private.reference_curation_submissions WHERE id=submission_id;
  INSERT INTO private.curated_reference_treatment_taxa(
    id,taxon_treatment_id,sporely_taxon_id,assignment_reason,revision,created_by,updated_by
  ) VALUES(assignment_id,curated_treatment,taxon_id,'Exact Stage 6e assignment',1,reviewer_id,reviewer_id);

  result := public.get_reference_curation_detail(publisher_id,publisher_session,submission_id);
  IF result->>'status' <> 'ok'
     OR result #>> '{detail,accepted_graph,work,id}' <> curated_work::text
     OR result #>> '{detail,accepted_graph,treatment,id}' <> curated_treatment::text
     OR result #>> '{detail,accepted_graph,measurement_set,id}' <> curated_set::text
     OR result #>> '{detail,accepted_graph,measurement_set,catalogue_status}' <> 'draft'
     OR result #>> '{detail,accepted_graph,taxon_assignments,0,id}' <> assignment_id::text
     OR result #>> '{detail,accepted_graph,taxon_assignments,0,canonical_name}' <> 'Russula workspace' THEN
    RAISE EXCEPTION 'accepted graph detail was not exact: %',result;
  END IF;
  IF result #> '{detail,accepted_graph}' ?| ARRAY['created_by','updated_by','published_by']
     OR result ?| ARRAY['contributor_id','events','attestation_version'] THEN
    RAISE EXCEPTION 'detail leaked private actor/audit fields: %',result;
  END IF;

  UPDATE public.profiles SET is_banned=true WHERE id=reviewer_id;
  IF public.get_reference_curation_detail(reviewer_id,reviewer_session,submission_id)->>'status' <> 'forbidden' THEN
    RAISE EXCEPTION 'banned reviewer retained workspace reads';
  END IF;
  UPDATE public.profiles SET is_banned=false WHERE id=reviewer_id;
  DELETE FROM private.reference_curator_memberships WHERE user_id=reviewer_id;
  IF public.get_reference_curation_capabilities(reviewer_id,reviewer_session)->>'status' <> 'forbidden' THEN
    RAISE EXCEPTION 'stale reviewer role retained workspace reads';
  END IF;
END
$$;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.get_reference_curation_capabilities(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.get_reference_curation_capabilities(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.list_reference_curation_queue(uuid,uuid,text,integer,timestamptz,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.list_reference_curation_queue(uuid,uuid,text,integer,timestamptz,uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.get_reference_curation_detail(uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public.get_reference_curation_detail(uuid,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'curator workspace reads leaked to a direct client role';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.get_reference_curation_capabilities(uuid,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.list_reference_curation_queue(uuid,uuid,text,integer,timestamptz,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.get_reference_curation_detail(uuid,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'service-role workspace reads missing';
  END IF;
END
$$;

ROLLBACK;
