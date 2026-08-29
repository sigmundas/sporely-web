-- Stage 6d publisher-only materialization, immutable provenance, and lifecycle.

BEGIN;

CREATE FUNCTION private.stage6d_test_accept(
  p_owner uuid, p_reviewer uuid, p_session uuid, p_source_set uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE
  r jsonb; submission uuid; candidate_revision integer; candidate_hash text;
  work_id uuid; treatment_id uuid; set_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',p_owner::text,'role','authenticated')::text,true);
  r:=public.submit_private_reference_for_curation(
    p_source_set,1,1,1,'stage6d-v1',true,true);
  IF r->>'status'<>'created' THEN RAISE EXCEPTION 'submission fixture failed: %',r; END IF;
  submission:=(r->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash
    INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission;
  r:=public.mutate_reference_curation(
    p_reviewer,p_session,gen_random_uuid(),'claim',submission,1,
    candidate_revision,candidate_hash,NULL,'{}');
  IF r->>'status'<>'updated' THEN RAISE EXCEPTION 'claim fixture failed: %',r; END IF;
  r:=public.mutate_reference_curation(
    p_reviewer,p_session,gen_random_uuid(),'accept_to_draft',submission,2,
    candidate_revision,candidate_hash,NULL,'{}');
  IF r->>'status'<>'updated' THEN RAISE EXCEPTION 'accept fixture failed: %',r; END IF;
  SELECT accepted_curated_work_id,accepted_curated_treatment_id,
         accepted_curated_measurement_set_id
    INTO work_id,treatment_id,set_id
    FROM private.reference_curation_submissions WHERE id=submission;
  RETURN jsonb_build_object('submission_id',submission,'work_id',work_id,
    'treatment_id',treatment_id,'set_id',set_id);
END
$$;

CREATE FUNCTION private.stage6d_test_reject_publication_taxon()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'Stage 6d injected publication-taxon failure' USING ERRCODE='23514';
END
$$;

DO $$
DECLARE
  owner_id constant uuid := '00000000-0000-4000-8000-000000006d01';
  reviewer_id constant uuid := '00000000-0000-4000-8000-000000006d02';
  publisher_id constant uuid := '00000000-0000-4000-8000-000000006d03';
  admin_id constant uuid := '00000000-0000-4000-8000-000000006d04';
  reviewer_session constant uuid := '70000000-0000-4000-8000-000000006d02';
  publisher_session constant uuid := '70000000-0000-4000-8000-000000006d03';
  admin_session constant uuid := '70000000-0000-4000-8000-000000006d04';
  expired_session constant uuid := '70000000-0000-4000-8000-000000006d13';
  taxon_id constant integer := 2100000064;
  source_work_1 constant uuid := '61000000-0000-4000-8000-000000006d01';
  source_work_2 constant uuid := '61000000-0000-4000-8000-000000006d02';
  source_work_3 constant uuid := '61000000-0000-4000-8000-000000006d03';
  source_work_4 constant uuid := '61000000-0000-4000-8000-000000006d04';
  source_treatment_1 constant uuid := '62000000-0000-4000-8000-000000006d01';
  source_treatment_2 constant uuid := '62000000-0000-4000-8000-000000006d02';
  source_treatment_3 constant uuid := '62000000-0000-4000-8000-000000006d03';
  source_treatment_4 constant uuid := '62000000-0000-4000-8000-000000006d04';
  source_set_1 constant uuid := '63000000-0000-4000-8000-000000006d01';
  source_set_2 constant uuid := '63000000-0000-4000-8000-000000006d02';
  source_set_3 constant uuid := '63000000-0000-4000-8000-000000006d03';
  source_set_4 constant uuid := '63000000-0000-4000-8000-000000006d04';
  assignment_1 constant uuid := '64000000-0000-4000-8000-000000006d01';
  assignment_2 constant uuid := '64000000-0000-4000-8000-000000006d02';
  assignment_3 constant uuid := '64000000-0000-4000-8000-000000006d03';
  assignment_4 constant uuid := '64000000-0000-4000-8000-000000006d04';
  graph_1 jsonb; graph_2 jsonb; graph_3 jsonb; graph_4 jsonb;
  work_1 uuid; treatment_1 uuid; treatment_2 uuid; treatment_3 uuid; treatment_4 uuid;
  set_1 uuid; set_2 uuid; set_3 uuid; set_4 uuid;
  result jsonb; payload jsonb; request_id uuid;
  owner_snapshot jsonb;
  frozen_snapshot jsonb; frozen_citation jsonb; frozen_hash text;
  publication_count bigint; event_count bigint;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_id,'authenticated','authenticated','stage6d-owner@example.invalid','{}',now(),now()),
    (reviewer_id,'authenticated','authenticated','stage6d-reviewer@example.invalid','{}',now(),now()),
    (publisher_id,'authenticated','authenticated','stage6d-publisher@example.invalid',
      '{"reference_role":"reference_publisher"}',now(),now()),
    (admin_id,'authenticated','authenticated','stage6d-admin@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_admin,is_banned) VALUES
    (owner_id,'stage6d_owner',false,false),(reviewer_id,'stage6d_reviewer',false,false),
    (publisher_id,'stage6d_publisher',false,false),(admin_id,'stage6d_admin',true,false);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal) VALUES
    (reviewer_session,reviewer_id,now(),now(),'aal1'),
    (publisher_session,publisher_id,now(),now(),'aal1'),
    (admin_session,admin_id,now(),now(),'aal1');
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal,not_after)
  VALUES(expired_session,publisher_id,now()-interval '2 hours',now()-interval '2 hours',
    'aal1',now()-interval '1 hour');
  INSERT INTO private.reference_curator_memberships(user_id,role,granted_by,reason) VALUES
    (reviewer_id,'reference_reviewer',publisher_id,'Stage 6d reviewer fixture'),
    (publisher_id,'reference_publisher',publisher_id,'Stage 6d publisher fixture');
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES(taxon_id,'Russula publicationis','species','include','in_cache','stage6d-test');
  INSERT INTO public.reference_works(
    user_id,id,type,citation_key,authors_json,title,year,doi,short_label,revision
  ) VALUES
    (owner_id,source_work_1,'article','stage6d-key','[{"family":"Publisher","given":"Ada"}]',
      'Exact publication ancestor',2026,'10.1000/stage6d-1','Publisher 2026a',1),
    (owner_id,source_work_2,'article',NULL,'[{"family":"Publisher","given":"Ada"}]',
      'Exact successor ancestor',2027,'10.1000/stage6d-2','Publisher 2027',1),
    (owner_id,source_work_3,'book',NULL,'[{"family":"Lifecycle","given":"Bea"}]',
      'Status-only evidence',2026,NULL,'Lifecycle 2026',1),
    (owner_id,source_work_4,'article',NULL,'[{"family":"Rollback","given":"Cy"}]',
      'Atomic publication',2026,'10.1000/stage6d-4','Rollback 2026',1);
  INSERT INTO public.reference_taxon_treatments(
    user_id,id,reference_work_id,name_as_published,locator_text,revision
  ) VALUES
    (owner_id,source_treatment_1,source_work_1,'Russula publicationis','p. 10',1),
    (owner_id,source_treatment_2,source_work_2,'Russula publicationis','p. 11',1),
    (owner_id,source_treatment_3,source_work_3,'Russula publicationis','p. 12',1),
    (owner_id,source_treatment_4,source_work_4,'Russula publicationis','p. 13',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,raw_text,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES
    (owner_id,source_set_1,source_treatment_1,'spore_size','range','8-10 x 5-6 um',8,10,5,6,1),
    (owner_id,source_set_2,source_treatment_2,'spore_size','range','8.5-10.5 x 5-6 um',8.5,10.5,5,6,1),
    (owner_id,source_set_3,source_treatment_3,'spore_size','range','7-9 x 4-5 um',7,9,4,5,1),
    (owner_id,source_set_4,source_treatment_4,'spore_size','range','9-11 x 6-7 um',9,11,6,7,1);
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft)
    OVERRIDING SYSTEM VALUE
  VALUES(960000064,owner_id,current_date,'public',false);
  owner_snapshot:=private.reference_canonical_snapshot(owner_id,source_set_3);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,note,
    reference_revision,snapshot_json
  ) VALUES(
    owner_id,'65000000-0000-4000-8000-000000006d03',960000064,source_set_3,
    'compared','Frozen before catalogue lifecycle',1,owner_snapshot
  );
  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled=true,attestation_version='stage6d-v1',
         attestation_text='TEST ONLY Stage 6d rights and consent.',
         submission_rate_window=interval '1 hour',submission_rate_limit=20,
         unaccepted_submission_retention=interval '0 seconds' WHERE singleton;

  graph_1:=private.stage6d_test_accept(owner_id,reviewer_id,reviewer_session,source_set_1);
  graph_2:=private.stage6d_test_accept(owner_id,reviewer_id,reviewer_session,source_set_2);
  graph_3:=private.stage6d_test_accept(owner_id,reviewer_id,reviewer_session,source_set_3);
  graph_4:=private.stage6d_test_accept(owner_id,reviewer_id,reviewer_session,source_set_4);
  work_1:=(graph_1->>'work_id')::uuid;
  treatment_1:=(graph_1->>'treatment_id')::uuid; set_1:=(graph_1->>'set_id')::uuid;
  treatment_2:=(graph_2->>'treatment_id')::uuid; set_2:=(graph_2->>'set_id')::uuid;
  treatment_3:=(graph_3->>'treatment_id')::uuid; set_3:=(graph_3->>'set_id')::uuid;
  treatment_4:=(graph_4->>'treatment_id')::uuid; set_4:=(graph_4->>'set_id')::uuid;

  result:=public.mutate_reference_curation(reviewer_id,reviewer_session,gen_random_uuid(),
    'edit_draft',assignment_1,0,NULL,NULL,'Exact species assignment.',
    jsonb_build_object('target_type','treatment_taxa','patch',jsonb_build_object(
      'taxon_treatment_id',treatment_1,'sporely_taxon_id',taxon_id,
      'assignment_reason','Exact reviewed treatment name')));
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'assignment 1 failed: %',result; END IF;
  result:=public.mutate_reference_curation(reviewer_id,reviewer_session,gen_random_uuid(),
    'edit_draft',assignment_2,0,NULL,NULL,'Exact species assignment.',
    jsonb_build_object('target_type','treatment_taxa','patch',jsonb_build_object(
      'taxon_treatment_id',treatment_2,'sporely_taxon_id',taxon_id,
      'assignment_reason','Exact reviewed treatment name')));
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'assignment 2 failed: %',result; END IF;
  result:=public.mutate_reference_curation(reviewer_id,reviewer_session,gen_random_uuid(),
    'edit_draft',assignment_3,0,NULL,NULL,'Exact species assignment.',
    jsonb_build_object('target_type','treatment_taxa','patch',jsonb_build_object(
      'taxon_treatment_id',treatment_3,'sporely_taxon_id',taxon_id,
      'assignment_reason','Exact reviewed treatment name')));
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'assignment 3 failed: %',result; END IF;
  result:=public.mutate_reference_curation(reviewer_id,reviewer_session,gen_random_uuid(),
    'edit_draft',assignment_4,0,NULL,NULL,'Exact species assignment.',
    jsonb_build_object('target_type','treatment_taxa','patch',jsonb_build_object(
      'taxon_treatment_id',treatment_4,'sporely_taxon_id',taxon_id,
      'assignment_reason','Exact reviewed treatment name')));
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'assignment 4 failed: %',result; END IF;

  -- Authorization is live DB state, never token metadata.
  payload:=jsonb_build_object('expected_work_row_version',1,
    'expected_treatment_row_version',1,'expected_taxon_assignments',
    jsonb_build_array(jsonb_build_object('id',assignment_1,'row_version',1)));
  result:=public.mutate_reference_curation_lifecycle(reviewer_id,reviewer_session,
    gen_random_uuid(),'publish',set_1,1,'Reviewer must not publish.',payload);
  IF result->>'status'<>'forbidden' THEN RAISE EXCEPTION 'reviewer published: %',result; END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,expired_session,
    gen_random_uuid(),'publish',set_1,1,'Expired session must fail.',payload);
  IF result->>'status'<>'forbidden' THEN RAISE EXCEPTION 'expired session published: %',result; END IF;
  UPDATE public.profiles SET is_banned=true WHERE id=publisher_id;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,1,'Banned publisher must fail.',payload);
  IF result->>'status'<>'forbidden' THEN RAISE EXCEPTION 'banned publisher published: %',result; END IF;
  UPDATE public.profiles SET is_banned=false WHERE id=publisher_id;
  DELETE FROM private.reference_curator_memberships WHERE user_id=publisher_id;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,1,'Stale role must fail.',payload);
  IF result->>'status'<>'forbidden' THEN RAISE EXCEPTION 'stale role published: %',result; END IF;
  INSERT INTO private.reference_curator_memberships(user_id,role,granted_by,reason)
  VALUES(publisher_id,'reference_publisher',publisher_id,'Restore Stage 6d fixture');

  -- Every accepted draft ancestor and assignment is protected by exact CAS.
  UPDATE private.curated_reference_works SET title='Reviewed exact publication ancestor',
    revision=revision+1,row_version=row_version+1,updated_by=reviewer_id WHERE id=work_1;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,1,'Reject stale ancestor CAS.',payload);
  IF result->>'status'<>'stale_graph' THEN RAISE EXCEPTION 'stale ancestor published: %',result; END IF;
  payload:=jsonb_set(payload,'{expected_work_row_version}','2'::jsonb);
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,1,'Reject stale assignments.',
    jsonb_set(payload,'{expected_taxon_assignments}',
      jsonb_build_array(jsonb_build_object('id',assignment_1,'row_version',99))));
  IF result->>'status'<>'stale_graph' THEN RAISE EXCEPTION 'stale assignment published: %',result; END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,99,'Reject stale set CAS.',payload);
  IF result->>'status'<>'conflict' THEN RAISE EXCEPTION 'stale set CAS published: %',result; END IF;

  request_id:=gen_random_uuid();
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    request_id,'publish',set_1,1,'Publish exact reviewed graph.',payload);
  IF result->>'status'<>'updated' OR (result->>'bundle_revision')::integer<>1 THEN
    RAISE EXCEPTION 'publication failed: %',result;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM private.curated_reference_publications p
    JOIN private.reference_curation_submissions s
      ON s.accepted_curated_measurement_set_id=p.curated_measurement_set_id
     AND s.accepted_curated_treatment_id=p.curated_taxon_treatment_id
     AND s.accepted_curated_work_id=p.curated_work_id
    WHERE p.curated_measurement_set_id=set_1 AND p.bundle_revision=1
      AND p.measurement_set_revision=1 AND p.treatment_revision=1 AND p.work_revision=2
      AND p.published_by=publisher_id
      AND p.snapshot_json->>'reference_measurement_set_id'=set_1::text
      AND p.snapshot_json->>'reference_treatment_id'=treatment_1::text
      AND p.snapshot_json->>'reference_work_id'=work_1::text
      AND p.snapshot_json->>'reference_revision'='1'
      AND p.citation_json->>'title'='Reviewed exact publication ancestor'
      AND p.citation_json ? 'citation_key'
      AND p.citation_json->'citation_key'='null'::jsonb
      AND p.content_hash~'^[0-9a-f]{64}$')
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_publication_taxa
                    WHERE curated_measurement_set_id=set_1 AND bundle_revision=1
                      AND sporely_taxon_id=taxon_id AND canonical_name='Russula publicationis')
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_1 AND catalogue_status='published'
                      AND latest_bundle_revision=1 AND row_version=2 AND revision=1) THEN
    RAISE EXCEPTION 'publication did not atomically materialize exact provenance/taxa';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.reference_curation_events
                 WHERE action='publish' AND target_type='publication' AND target_id=set_1
                   AND bundle_revision=1 AND outcome='succeeded'
                   AND reason='Publish exact reviewed graph.'
                   AND metadata_json->>'work_revision'='2'
                   AND metadata_json->>'treatment_revision'='1'
                   AND metadata_json->>'measurement_set_revision'='1'
                   AND after_content_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'publication audit lacks exact graph provenance';
  END IF;
  SELECT snapshot_json,citation_json,content_hash
    INTO frozen_snapshot,frozen_citation,frozen_hash
    FROM private.curated_reference_publications
   WHERE curated_measurement_set_id=set_1 AND bundle_revision=1;
  SELECT count(*) INTO publication_count FROM private.curated_reference_publications
   WHERE curated_measurement_set_id=set_1;
  SELECT count(*) INTO event_count FROM private.reference_curation_events
   WHERE action='publish' AND target_id=set_1 AND outcome='succeeded';
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    request_id,'publish',set_1,1,'Publish exact reviewed graph.',payload);
  IF result->>'status'<>'no_change'
     OR (SELECT count(*) FROM private.curated_reference_publications
          WHERE curated_measurement_set_id=set_1)<>publication_count
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action='publish' AND target_id=set_1 AND outcome='succeeded')<>event_count THEN
    RAISE EXCEPTION 'publication retry was not idempotent: %',result;
  END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,2,'Republish must be rejected.',payload);
  IF result->>'status'<>'invalid_state' THEN RAISE EXCEPTION 'republish succeeded: %',result; END IF;
  BEGIN
    UPDATE private.curated_reference_publications SET citation_json='{"schema_version":1}'
     WHERE curated_measurement_set_id=set_1 AND bundle_revision=1;
    RAISE EXCEPTION 'publication remained mutable';
  EXCEPTION WHEN SQLSTATE '25006' THEN NULL; END;
  BEGIN
    DELETE FROM private.curated_reference_publication_taxa
     WHERE curated_measurement_set_id=set_1 AND bundle_revision=1;
    RAISE EXCEPTION 'publication taxa remained mutable';
  EXCEPTION WHEN SQLSTATE '25006' THEN NULL; END;

  -- A successor is a separate accepted draft and atomically deprecates its predecessor.
  payload:=jsonb_build_object('expected_work_row_version',1,
    'expected_treatment_row_version',1,'expected_taxon_assignments',
    jsonb_build_array(jsonb_build_object('id',assignment_2,'row_version',1)),
    'predecessor_id',gen_random_uuid(),'expected_predecessor_row_version',2);
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'supersede',set_2,1,'Reject missing predecessor.',payload);
  IF result->>'status'<>'invalid_successor' THEN RAISE EXCEPTION 'missing predecessor accepted: %',result; END IF;
  payload:=jsonb_set(payload,'{predecessor_id}',to_jsonb(set_1));
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'supersede',set_2,1,'Supersede with exact graph.',payload);
  IF result->>'status'<>'updated' OR (result->>'predecessor_id')::uuid<>set_1 THEN
    RAISE EXCEPTION 'valid supersession failed: %',result;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                 WHERE id=set_2 AND catalogue_status='published' AND supersedes_id=set_1
                   AND latest_bundle_revision=1 AND row_version=2)
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_1 AND catalogue_status='deprecated'
                      AND row_version=3 AND deprecated_at IS NOT NULL)
     OR NOT EXISTS(SELECT 1 FROM private.reference_curation_events
                    WHERE action='supersede' AND target_id=set_1 AND outcome='succeeded'
                      AND metadata_json->>'successor_id'=set_2::text
                      AND before_content_hash=frozen_hash AND after_content_hash=frozen_hash)
     OR NOT EXISTS(SELECT 1 FROM private.reference_curation_events
                    WHERE action='supersede' AND target_type='publication' AND target_id=set_2
                      AND outcome='succeeded' AND before_content_hash IS NULL
                      AND after_content_hash=(SELECT content_hash
                        FROM private.curated_reference_publications
                        WHERE curated_measurement_set_id=set_2 AND bundle_revision=1))
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_publications
                    WHERE curated_measurement_set_id=set_1 AND bundle_revision=1
                      AND snapshot_json=frozen_snapshot AND citation_json=frozen_citation
                      AND content_hash=frozen_hash) THEN
    RAISE EXCEPTION 'supersession did not preserve/deprecate/audit atomically';
  END IF;

  -- Restoration cannot create two live ends of a supersession lineage.
  payload:=jsonb_build_object('expected_work_row_version',2,
    'expected_treatment_row_version',1,'expected_taxon_assignments',
    jsonb_build_array(jsonb_build_object('id',assignment_1,'row_version',1)));
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,3,'Reject live predecessor restoration.',payload);
  IF result->>'status'<>'invalid_state' THEN
    RAISE EXCEPTION 'predecessor restored beside live successor: %',result;
  END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'withdraw',set_2,2,'Temporarily withdraw successor.','{}');
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'successor withdrawal failed: %',result; END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_1,3,'Restore predecessor while successor is withdrawn.',payload);
  IF result->>'status'<>'updated' OR (result->>'bundle_revision')::integer<>2 THEN
    RAISE EXCEPTION 'safe predecessor restoration failed: %',result;
  END IF;
  payload:=jsonb_build_object('expected_work_row_version',1,
    'expected_treatment_row_version',1,'expected_taxon_assignments',
    jsonb_build_array(jsonb_build_object('id',assignment_2,'row_version',1)),
    'predecessor_id',set_1,'expected_predecessor_row_version',4);
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_2,3,'Reject stale predecessor restoration.',
    jsonb_set(payload,'{expected_predecessor_row_version}','3'::jsonb));
  IF result->>'status'<>'conflict' THEN
    RAISE EXCEPTION 'stale predecessor restoration CAS accepted: %',result;
  END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_2,3,'Restore successor and reapply lineage.',payload);
  IF result->>'status'<>'updated' OR (result->>'bundle_revision')::integer<>2
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_1 AND catalogue_status='deprecated' AND row_version=5)
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_2 AND catalogue_status='published' AND row_version=4)
     OR NOT EXISTS(SELECT 1 FROM private.reference_curation_events
                    WHERE action='publish' AND target_id=set_1 AND outcome='succeeded'
                      AND reason='Restore successor and reapply lineage.'
                      AND metadata_json->>'transition'='restored_successor'
                      AND metadata_json->>'successor_id'=set_2::text
                      AND before_content_hash=(SELECT content_hash
                        FROM private.curated_reference_publications
                        WHERE curated_measurement_set_id=set_1 AND bundle_revision=2)
                      AND after_content_hash=before_content_hash)
     OR NOT EXISTS(SELECT 1 FROM private.reference_curation_events
                    WHERE action='publish' AND target_type='publication' AND target_id=set_2
                      AND bundle_revision=2 AND outcome='succeeded'
                      AND before_content_hash=(SELECT content_hash
                        FROM private.curated_reference_publications
                        WHERE curated_measurement_set_id=set_2 AND bundle_revision=1)
                      AND after_content_hash=(SELECT content_hash
                        FROM private.curated_reference_publications
                        WHERE curated_measurement_set_id=set_2 AND bundle_revision=2)) THEN
    RAISE EXCEPTION 'successor restoration did not reapply predecessor transition: %',result;
  END IF;

  -- Deprecation needs no successor; withdrawal changes status only and preserves evidence.
  payload:=jsonb_build_object('expected_work_row_version',1,
    'expected_treatment_row_version',1,'expected_taxon_assignments',
    jsonb_build_array(jsonb_build_object('id',assignment_3,'row_version',1)));
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_3,1,'Publish lifecycle fixture.',payload);
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'lifecycle publish failed: %',result; END IF;
  SELECT snapshot_json,citation_json,content_hash
    INTO frozen_snapshot,frozen_citation,frozen_hash
    FROM private.curated_reference_publications
   WHERE curated_measurement_set_id=set_3 AND bundle_revision=1;
  result:=public.mutate_reference_curation_lifecycle(admin_id,admin_session,
    gen_random_uuid(),'deprecate',set_3,2,'No longer recommended.','{}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_3 AND catalogue_status='deprecated' AND supersedes_id IS NULL
                      AND row_version=3 AND revision=1) THEN
    RAISE EXCEPTION 'deprecation without successor failed: %',result;
  END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'withdraw',set_3,3,'Withdraw availability; retain evidence.','{}');
  IF result->>'status'<>'updated'
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_3 AND catalogue_status='withdrawn' AND row_version=4
                      AND revision=1 AND latest_bundle_revision=1
                      AND published_at IS NOT NULL AND deprecated_at IS NOT NULL
                      AND withdrawn_at IS NOT NULL)
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_publications
                    WHERE curated_measurement_set_id=set_3 AND bundle_revision=1
                      AND snapshot_json=frozen_snapshot AND citation_json=frozen_citation
                      AND content_hash=frozen_hash)
     OR NOT EXISTS(SELECT 1 FROM public.observation_reference_uses
                    WHERE user_id=owner_id
                      AND id='65000000-0000-4000-8000-000000006d03'
                      AND snapshot_json=owner_snapshot) THEN
    RAISE EXCEPTION 'status-only withdrawal rewrote historical evidence: %',result;
  END IF;
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_3,4,'Restore after a fresh publisher review.',payload);
  IF result->>'status'<>'updated' OR (result->>'bundle_revision')::integer<>2
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_3 AND catalogue_status='published' AND row_version=5
                      AND revision=1 AND latest_bundle_revision=2
                      AND deprecated_at IS NULL AND withdrawn_at IS NULL)
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_publications
                    WHERE curated_measurement_set_id=set_3 AND bundle_revision=1
                      AND snapshot_json=frozen_snapshot AND citation_json=frozen_citation
                      AND content_hash=frozen_hash)
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_publications
                    WHERE curated_measurement_set_id=set_3 AND bundle_revision=2
                      AND snapshot_json->>'reference_revision'='2') THEN
    RAISE EXCEPTION 'reviewed restoration did not append bundle revision two: %',result;
  END IF;

  -- An injected partial failure rolls back bundle, copied taxa, lifecycle, and success audit.
  payload:=jsonb_build_object('expected_work_row_version',1,
    'expected_treatment_row_version',1,'expected_taxon_assignments',
    jsonb_build_array(jsonb_build_object('id',assignment_4,'row_version',1)));
  EXECUTE 'CREATE TRIGGER stage6d_injected_taxon_failure BEFORE INSERT '
       || 'ON private.curated_reference_publication_taxa FOR EACH ROW '
       || 'EXECUTE FUNCTION private.stage6d_test_reject_publication_taxon()';
  result:=public.mutate_reference_curation_lifecycle(publisher_id,publisher_session,
    gen_random_uuid(),'publish',set_4,1,'Injected atomic rollback.',payload);
  EXECUTE 'DROP TRIGGER stage6d_injected_taxon_failure '
       || 'ON private.curated_reference_publication_taxa';
  IF result->>'status' NOT IN ('invalid_state','failed')
     OR EXISTS(SELECT 1 FROM private.curated_reference_publications
                WHERE curated_measurement_set_id=set_4)
     OR EXISTS(SELECT 1 FROM private.curated_reference_publication_taxa
                WHERE curated_measurement_set_id=set_4)
     OR NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets
                    WHERE id=set_4 AND catalogue_status='draft' AND row_version=1
                      AND latest_bundle_revision IS NULL)
     OR EXISTS(SELECT 1 FROM private.reference_curation_events
                WHERE action='publish' AND target_id=set_4 AND outcome='succeeded') THEN
    RAISE EXCEPTION 'partial publication failure was not rolled back: %',result;
  END IF;

  IF has_function_privilege('authenticated',
       'public.mutate_reference_curation_lifecycle(uuid,uuid,uuid,text,uuid,bigint,text,jsonb)',
       'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.mutate_reference_curation_lifecycle(uuid,uuid,uuid,text,uuid,bigint,text,jsonb)',
       'EXECUTE') THEN RAISE EXCEPTION 'lifecycle RPC grants are not service-bound'; END IF;
END
$$;

ROLLBACK;
