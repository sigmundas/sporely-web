-- Stage 6c claim/decision/CAS/idempotency/authorization contract.

BEGIN;

DO $$
DECLARE
  owner_id constant uuid := '00000000-0000-4000-8000-000000006c01';
  reviewer_id constant uuid := '00000000-0000-4000-8000-000000006c02';
  other_id constant uuid := '00000000-0000-4000-8000-000000006c03';
  admin_id constant uuid := '00000000-0000-4000-8000-000000006c04';
  reviewer_session_id constant uuid := '70000000-0000-4000-8000-000000006c02';
  refreshed_reviewer_session_id constant uuid := '70000000-0000-4000-8000-000000006c32';
  expired_reviewer_session_id constant uuid := '70000000-0000-4000-8000-000000006c12';
  other_session_id constant uuid := '70000000-0000-4000-8000-000000006c03';
  admin_session_id constant uuid := '70000000-0000-4000-8000-000000006c04';
  work_id constant uuid := '61000000-0000-4000-8000-000000006c01';
  treatment_id constant uuid := '62000000-0000-4000-8000-000000006c01';
  set_id constant uuid := '63000000-0000-4000-8000-000000006c01';
  submission_id uuid;
  candidate_revision integer;
  candidate_hash text;
  result jsonb;
  request_id uuid;
  event_count integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
    (owner_id, 'authenticated', 'authenticated', 'stage6c-owner@example.invalid', '{}', now(), now()),
    (reviewer_id, 'authenticated', 'authenticated', 'stage6c-reviewer@example.invalid', '{}', now(), now()),
    (other_id, 'authenticated', 'authenticated', 'stage6c-other@example.invalid',
      '{"reference_role":"reference_publisher"}', now(), now()),
    (admin_id, 'authenticated', 'authenticated', 'stage6c-admin@example.invalid', '{}', now(), now());
  INSERT INTO public.profiles(id, username, is_admin, is_banned) VALUES
    (owner_id, 'stage6c_owner', false, false),
    (reviewer_id, 'stage6c_reviewer', false, false),
    (other_id, 'stage6c_other', false, false),
    (admin_id, 'stage6c_admin', true, false);
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal) VALUES
    (reviewer_session_id,reviewer_id,now(),now(),'aal1'),
    (refreshed_reviewer_session_id,reviewer_id,now(),now(),'aal1'),
    (other_session_id,other_id,now(),now(),'aal1'),
    (admin_session_id,admin_id,now(),now(),'aal1');
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal,not_after)
  VALUES(expired_reviewer_session_id,reviewer_id,now()-interval '2 hours',now()-interval '2 hours',
    'aal1',now()-interval '1 hour');
  INSERT INTO private.reference_curator_memberships(user_id, role, granted_by, reason) VALUES
    (reviewer_id, 'reference_reviewer', admin_id, 'Stage 6c workflow test');

  INSERT INTO public.reference_works
    (user_id,id,type,authors_json,title,doi,isbn,short_label,revision)
  VALUES (owner_id,work_id,'article','[{"family":"Reviewer"}]','Exact candidate',
    '10.1000/stage6c','978-1-4028-9462-6','Reviewer 2026',1);
  INSERT INTO public.reference_taxon_treatments
    (user_id,id,reference_work_id,name_as_published,locator_text,revision)
  VALUES (owner_id,treatment_id,work_id,'Russula exacta','p. 6',1);
  INSERT INTO public.reference_measurement_sets
    (user_id,id,taxon_treatment_id,character,data_kind,raw_text,length_core_min,
     length_core_max,width_core_min,width_core_max,revision)
  VALUES (owner_id,set_id,treatment_id,'spore_size','range','8-10 × 5-6 µm',8,10,5,6,1);

  UPDATE private.reference_curation_intake_policy
     SET submissions_enabled=true, attestation_version='stage6c-v1',
         attestation_text='TEST ONLY Stage 6c rights and consent.',
         submission_rate_window=interval '1 hour', submission_rate_limit=50,
         unaccepted_submission_retention=interval '0 seconds'
   WHERE singleton;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',owner_id::text,'role','authenticated')::text,true);
  result := public.submit_private_reference_for_curation(set_id,1,1,1,'stage6c-v1',true,true);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'submission fixture failed: %',result; END IF;
  submission_id := (result->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash
    INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission_id;

  -- A token metadata role is irrelevant without current database authority.
  result := public.mutate_reference_curation(
    other_id,other_session_id,gen_random_uuid(),'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'stale JWT role authorized claim: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,other_session_id,gen_random_uuid(),'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'actor/session mismatch authorized claim: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,expired_reviewer_session_id,gen_random_uuid(),'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'expired session authorized claim: %',result; END IF;

  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    reviewer_id,refreshed_reviewer_session_id,request_id,'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'claim failed: %',result; END IF;
  IF NOT EXISTS (SELECT 1 FROM private.reference_curation_submissions s
                  WHERE s.id=submission_id AND s.status='in_review'
                    AND s.claimed_by=reviewer_id AND s.claimed_at IS NOT NULL
                    AND s.row_version=2) THEN
    RAISE EXCEPTION 'claim did not atomically update submission';
  END IF;
  SELECT count(*) INTO event_count FROM private.reference_curation_events
   WHERE action='claim' AND target_id=submission_id;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'no_change'
     OR (SELECT count(*) FROM private.reference_curation_events
          WHERE action='claim' AND target_id=submission_id) <> event_count THEN
    RAISE EXCEPTION 'claim retry was not exact/idempotent: %',result;
  END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'reject',submission_id,2,candidate_revision,candidate_hash,'wrong reuse','{}');
  IF result->>'status' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'request id was reused with another mutation: %',result;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM private.reference_curation_events e
     WHERE e.actor_user_id=reviewer_id AND e.action='reject'
       AND e.target_id=submission_id AND e.outcome='conflict'
       AND e.reason='idempotency_conflict'
  ) THEN
    RAISE EXCEPTION 'request id collision was not append-only audited';
  END IF;
  SELECT count(*) INTO event_count FROM private.reference_curation_events e
   WHERE e.actor_user_id=reviewer_id AND e.action='reject'
     AND e.target_id=submission_id AND e.outcome='conflict'
     AND e.reason='idempotency_conflict';
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'reject',submission_id,2,candidate_revision,candidate_hash,'wrong reuse','{}');
  IF result->>'status' <> 'idempotency_conflict'
     OR (SELECT count(*) FROM private.reference_curation_events e
          WHERE e.actor_user_id=reviewer_id AND e.action='reject'
            AND e.target_id=submission_id AND e.outcome='conflict'
            AND e.reason='idempotency_conflict')<>event_count THEN
    RAISE EXCEPTION 'identical request id collision retry amplified its audit event: %',result;
  END IF;

  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'request_changes',submission_id,999,
    candidate_revision,candidate_hash,'Clarify the measurement method.','{}');
  IF result->>'status' <> 'conflict' THEN RAISE EXCEPTION 'request changes ignored stale CAS: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'request_changes',submission_id,999,
    candidate_revision,candidate_hash,'Clarify the measurement method.','{}');
  IF result->>'status' <> 'conflict' THEN RAISE EXCEPTION 'conflict retry became success: %',result; END IF;
  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'request_changes',submission_id,2,
    candidate_revision+1,candidate_hash,'Clarify the measurement method.','{}');
  IF result->>'status' <> 'stale_candidate' THEN RAISE EXCEPTION 'decision ignored candidate revision: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'request_changes',submission_id,2,
    candidate_revision+1,candidate_hash,'Clarify the measurement method.','{}');
  IF result->>'status' <> 'stale_candidate' THEN RAISE EXCEPTION 'stale candidate retry became success: %',result; END IF;
  result := public.mutate_reference_curation(
    other_id,other_session_id,gen_random_uuid(),'request_changes',submission_id,2,
    candidate_revision,candidate_hash,'Not my claim.','{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'unprivileged actor decided claim: %',result; END IF;
  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,request_id,'request_changes',submission_id,2,
    candidate_revision,candidate_hash,'Another authorized reviewer must not decide.','{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'non-claimant curator decided claim: %',result; END IF;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,request_id,'request_changes',submission_id,2,
    candidate_revision,candidate_hash,'Another authorized reviewer must not decide.','{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'forbidden retry became success: %',result; END IF;
  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'request_changes',submission_id,2,
    candidate_revision,candidate_hash,repeat('x',4001),'{}');
  IF result->>'status' <> 'invalid_reason' THEN RAISE EXCEPTION 'oversized feedback was accepted: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'request_changes',submission_id,2,
    candidate_revision,candidate_hash,repeat('x',4001),'{}');
  IF result->>'status' <> 'invalid_reason' THEN RAISE EXCEPTION 'invalid reason retry became success: %',result; END IF;
  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'claim',submission_id,2,
    candidate_revision,candidate_hash,NULL,'{"unexpected":true}');
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'invalid payload was accepted: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'claim',submission_id,2,
    candidate_revision,candidate_hash,NULL,'{"unexpected":true}');
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'invalid payload retry became success: %',result; END IF;
  request_id := gen_random_uuid();
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'claim','90000000-0000-4000-8000-000000006c99',1,
    candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'not_found' THEN RAISE EXCEPTION 'missing submission was not rejected: %',result; END IF;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,request_id,'claim','90000000-0000-4000-8000-000000006c99',1,
    candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'not_found' THEN RAISE EXCEPTION 'not-found retry became success: %',result; END IF;

  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'request_changes',submission_id,2,
    candidate_revision,candidate_hash,'Clarify the measurement method.','{}');
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'request changes failed: %',result; END IF;
  IF NOT EXISTS (SELECT 1 FROM private.reference_curation_submissions s
                  WHERE s.id=submission_id AND s.status='changes_requested'
                    AND s.claimed_by IS NULL AND s.review_feedback='Clarify the measurement method.'
                    AND s.row_version=3) THEN
    RAISE EXCEPTION 'request changes state/feedback mismatch';
  END IF;

  UPDATE public.reference_measurement_sets
     SET raw_text='8.1-10.2 × 5-6 µm',revision=2
   WHERE user_id=owner_id AND id=set_id;
  result := public.resubmit_private_reference_for_curation(
    submission_id,3,1,1,2,'stage6c-v1',true,true);
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'owner resubmit failed after feedback: %',result; END IF;
  SELECT current_candidate_revision,current_content_hash
    INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission_id;
  IF EXISTS (SELECT 1 FROM private.reference_curation_submissions
              WHERE id=submission_id AND (claimed_by IS NOT NULL OR review_feedback IS NOT NULL)) THEN
    RAISE EXCEPTION 'resubmission did not clear claim/feedback';
  END IF;

  -- Current admin state grants reviewer powers, but a ban immediately revokes them.
  UPDATE public.profiles SET is_banned=true WHERE id=admin_id;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,gen_random_uuid(),'claim',submission_id,4,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'banned admin retained authority: %',result; END IF;

  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'claim',submission_id,4,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'reviewer could not reclaim resubmission: %',result; END IF;
  UPDATE public.profiles SET is_banned=false WHERE id=admin_id;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,gen_random_uuid(),'claim',submission_id,5,candidate_revision,candidate_hash,
    'Reviewer is still active.','{}');
  IF result->>'status' <> 'conflict' THEN RAISE EXCEPTION 'active reviewer claim was reassigned: %',result; END IF;
  UPDATE public.profiles SET is_banned=true WHERE id=reviewer_id;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,gen_random_uuid(),'claim',submission_id,5,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'invalid_reason' THEN RAISE EXCEPTION 'reassignment omitted its bounded reason: %',result; END IF;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,gen_random_uuid(),'claim',submission_id,5,candidate_revision,candidate_hash,
    'Prior reviewer is banned.','{}');
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'eligible claim reassignment failed: %',result; END IF;
  IF NOT EXISTS (SELECT 1 FROM private.reference_curation_events e
                  WHERE e.target_id=submission_id AND e.action='reassign_claim'
                    AND e.actor_user_id=admin_id) THEN
    RAISE EXCEPTION 'claim reassignment was not audited';
  END IF;
  UPDATE public.profiles SET is_admin=false WHERE id=admin_id;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,gen_random_uuid(),'reject',submission_id,6,candidate_revision,candidate_hash,'Exact candidate is unsupported.','{}');
  IF result->>'status' <> 'forbidden' THEN RAISE EXCEPTION 'stale admin authority was accepted: %',result; END IF;
  UPDATE public.profiles SET is_admin=true WHERE id=admin_id;
  result := public.mutate_reference_curation(
    admin_id,admin_session_id,gen_random_uuid(),'reject',submission_id,6,candidate_revision,candidate_hash,'Exact candidate is unsupported.','{}');
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'reasoned rejection failed: %',result; END IF;
  IF NOT EXISTS (SELECT 1 FROM private.reference_curation_submissions s
                  WHERE s.id=submission_id AND s.status='rejected' AND s.row_version=7
                    AND s.claimed_by IS NULL) THEN
    RAISE EXCEPTION 'rejection did not become terminal';
  END IF;

  -- A claim held by an account being deleted is released before its profile.
  UPDATE public.reference_measurement_sets SET raw_text='9-11 × 5-6 µm',revision=3
   WHERE user_id=owner_id AND id=set_id;
  result := public.submit_private_reference_for_curation(set_id,1,1,3,'stage6c-v1',true,true);
  submission_id := (result->'submission'->>'id')::uuid;
  SELECT current_candidate_revision,current_content_hash INTO candidate_revision,candidate_hash
    FROM private.reference_curation_submissions WHERE id=submission_id;
  UPDATE public.profiles SET is_banned=false WHERE id=reviewer_id;
  result := public.mutate_reference_curation(
    reviewer_id,reviewer_session_id,gen_random_uuid(),'claim',submission_id,1,candidate_revision,candidate_hash,NULL,'{}');
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'claim-release fixture failed: %',result; END IF;
  PERFORM public.delete_reference_library_for_account(reviewer_id);
  IF NOT EXISTS (SELECT 1 FROM private.reference_curation_submissions s
                  WHERE s.id=submission_id AND s.status='submitted'
                    AND s.claimed_by IS NULL AND s.claimed_at IS NULL AND s.row_version=3) THEN
    RAISE EXCEPTION 'delete-account did not release reviewer claim';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.reference_curation_events e
                  WHERE e.target_id=submission_id AND e.action='release_claim') THEN
    RAISE EXCEPTION 'delete-account claim release was not audited';
  END IF;
END
$$;

ROLLBACK;
