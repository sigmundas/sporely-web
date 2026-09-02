-- Dormant Stage 6c reviewer workflow.  The public functions are service-role
-- boundaries for the reference-curation Edge function; no catalogue read or
-- publication behavior is exposed here.

BEGIN;

ALTER TABLE private.reference_curation_submissions
  ADD COLUMN claimed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN review_feedback text CHECK (
    review_feedback IS NULL OR (btrim(review_feedback) <> '' AND char_length(review_feedback) <= 4000)
  ),
  ADD COLUMN accepted_candidate_revision integer CHECK (accepted_candidate_revision >= 1),
  ADD COLUMN accepted_content_hash text CHECK (
    accepted_content_hash IS NULL OR accepted_content_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN accepted_curated_work_id uuid REFERENCES private.curated_reference_works(id) ON DELETE RESTRICT,
  ADD COLUMN accepted_curated_treatment_id uuid REFERENCES private.curated_reference_taxon_treatments(id) ON DELETE RESTRICT,
  ADD COLUMN accepted_curated_measurement_set_id uuid REFERENCES private.curated_reference_measurement_sets(id) ON DELETE RESTRICT,
  ADD COLUMN accepted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN accepted_at timestamptz,
  ADD CONSTRAINT reference_curation_submissions_moderation_state_check CHECK (
    ((status = 'in_review') = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL))
    AND (status = 'in_review' OR (claimed_by IS NULL AND claimed_at IS NULL))
    AND (
      status = 'accepted'
      OR (accepted_candidate_revision IS NULL AND accepted_content_hash IS NULL
          AND accepted_curated_work_id IS NULL AND accepted_curated_treatment_id IS NULL
          AND accepted_curated_measurement_set_id IS NULL AND accepted_by IS NULL
          AND accepted_at IS NULL)
    )
    AND (
      status <> 'accepted'
      OR (accepted_candidate_revision IS NOT NULL AND accepted_content_hash IS NOT NULL
          AND accepted_curated_work_id IS NOT NULL AND accepted_curated_treatment_id IS NOT NULL
          AND accepted_curated_measurement_set_id IS NOT NULL AND accepted_at IS NOT NULL)
    )
  );
ALTER TABLE private.reference_curation_submission_versions
  ADD CONSTRAINT reference_curation_submission_versions_acceptance_key
  UNIQUE(submission_id,candidate_revision,content_hash);
ALTER TABLE private.reference_curation_submissions
  ADD CONSTRAINT reference_curation_submissions_accepted_candidate_fkey
    FOREIGN KEY(id,accepted_candidate_revision,accepted_content_hash)
    REFERENCES private.reference_curation_submission_versions(
      submission_id,candidate_revision,content_hash
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT reference_curation_submissions_accepted_treatment_work_fkey
    FOREIGN KEY(accepted_curated_treatment_id,accepted_curated_work_id)
    REFERENCES private.curated_reference_taxon_treatments(id,reference_work_id) ON DELETE RESTRICT,
  ADD CONSTRAINT reference_curation_submissions_accepted_set_treatment_fkey
    FOREIGN KEY(accepted_curated_measurement_set_id,accepted_curated_treatment_id)
    REFERENCES private.curated_reference_measurement_sets(id,taxon_treatment_id) ON DELETE RESTRICT;

CREATE INDEX reference_curation_submissions_claimed_by_idx
  ON private.reference_curation_submissions(claimed_by, status, claimed_at)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX reference_curation_submissions_accepted_set_idx
  ON private.reference_curation_submissions(accepted_curated_measurement_set_id)
  WHERE accepted_curated_measurement_set_id IS NOT NULL;

CREATE TABLE private.reference_curation_moderation_requests (
  request_id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'claim', 'request_changes', 'reject', 'accept_to_draft', 'edit_draft'
  )),
  target_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL CHECK (
    jsonb_typeof(result_json) = 'object' AND octet_length(result_json::text) <= 65536
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reference_curation_moderation_requests_actor_idx
  ON private.reference_curation_moderation_requests(actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;
ALTER TABLE private.reference_curation_moderation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.reference_curation_moderation_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON private.reference_curation_moderation_requests TO service_role;

CREATE TABLE private.reference_curation_moderation_collisions (
  request_id uuid NOT NULL REFERENCES private.reference_curation_moderation_requests(request_id)
    ON DELETE RESTRICT,
  attempted_hash text NOT NULL CHECK (attempted_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'claim', 'request_changes', 'reject', 'accept_to_draft', 'edit_draft'
  )),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,attempted_hash)
);
ALTER TABLE private.reference_curation_moderation_collisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.reference_curation_moderation_collisions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON private.reference_curation_moderation_collisions TO service_role;

ALTER TABLE private.reference_curation_events
  DROP CONSTRAINT reference_curation_events_action_check;
ALTER TABLE private.reference_curation_events
  ADD CONSTRAINT reference_curation_events_action_check CHECK (action IN (
    'claim', 'reassign_claim', 'release_claim', 'request_changes', 'resubmit',
    'reject', 'accept', 'edit_draft', 'publish', 'deprecate', 'supersede',
    'withdraw', 'role_change', 'submit', 'report', 'resolve_report',
    'purge_candidate', 'redact_report'
  ));
ALTER TABLE private.reference_curation_events
  DROP CONSTRAINT reference_curation_events_target_type_check;
ALTER TABLE private.reference_curation_events
  ADD CONSTRAINT reference_curation_events_target_type_check CHECK (target_type IN (
    'submission', 'curated_work', 'curated_treatment',
    'curated_measurement_set', 'curated_treatment_taxon', 'publication',
    'membership', 'report'
  ));

CREATE FUNCTION private.reference_curation_moderation_request_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
     AND to_jsonb(NEW)-'actor_user_id'=to_jsonb(OLD)-'actor_user_id' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reference curation moderation requests are append-only'
    USING ERRCODE = '25006';
END
$$;
CREATE TRIGGER reference_curation_moderation_requests_immutable_trg
  BEFORE UPDATE OR DELETE ON private.reference_curation_moderation_requests
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_moderation_request_guard();
CREATE TRIGGER reference_curation_moderation_collisions_immutable_trg
  BEFORE UPDATE OR DELETE ON private.reference_curation_moderation_collisions
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_moderation_request_guard();

CREATE FUNCTION private.reference_curator_membership_serialize()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reference-curator-memberships',7303)
  );
  RETURN NULL;
END
$$;
CREATE TRIGGER reference_curator_memberships_serialize_trg
  BEFORE INSERT OR UPDATE OR DELETE ON private.reference_curator_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION private.reference_curator_membership_serialize();

CREATE FUNCTION private.reference_curation_actor_authorized(
  p_actor_user_id uuid, p_actor_session_id uuid
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_is_admin boolean;
  v_role text;
BEGIN
  IF p_actor_user_id IS NULL OR p_actor_session_id IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_user_id::text,7301));
  IF EXISTS(SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id=p_actor_user_id) THEN
    RETURN false;
  END IF;
  SELECT p.is_admin INTO v_is_admin FROM public.profiles p
   WHERE p.id=p_actor_user_id AND NOT p.is_banned FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM auth.sessions s
   WHERE s.id=p_actor_session_id AND s.user_id=p_actor_user_id
     AND (s.not_after IS NULL OR s.not_after>pg_catalog.clock_timestamp()) FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_is_admin THEN RETURN true; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reference-curator-memberships',7303)
  );
  SELECT m.role INTO v_role FROM private.reference_curator_memberships m
   WHERE m.user_id=p_actor_user_id FOR SHARE;
  RETURN FOUND AND v_role IN ('reference_reviewer','reference_publisher');
END
$$;

CREATE FUNCTION private.reference_curation_moderation_finish(
  p_request_id uuid, p_actor_user_id uuid, p_actor_session_id uuid,
  p_action text, p_target_id uuid, p_request_hash text, p_result jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.reference_curation_moderation_requests(
    request_id,actor_user_id,action,target_id,request_hash,result_json
  ) VALUES (
    p_request_id,p_actor_user_id,p_action,p_target_id,p_request_hash,p_result
  );
  IF p_result->>'status' NOT IN ('updated','no_change','not_found')
     AND private.reference_curation_actor_authorized(p_actor_user_id,p_actor_session_id) THEN
    INSERT INTO private.reference_curation_events(
      actor_user_id,action,target_type,target_id,outcome,reason,metadata_json
    ) VALUES(
      p_actor_user_id,
      CASE WHEN p_action='accept_to_draft' THEN 'accept' ELSE p_action END,
      CASE WHEN p_action<>'edit_draft' THEN 'submission'
        WHEN EXISTS(SELECT 1 FROM private.curated_reference_works w WHERE w.id=p_target_id)
          THEN 'curated_work'
        WHEN EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments t WHERE t.id=p_target_id)
          THEN 'curated_treatment'
        WHEN EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa tt WHERE tt.id=p_target_id)
          THEN 'curated_treatment_taxon'
        ELSE 'curated_measurement_set' END,
      p_target_id,
      CASE WHEN p_result->>'status' IN ('conflict','stale_candidate','idempotency_conflict')
           THEN 'conflict' ELSE 'denied' END,
      p_result->>'status','{}'::jsonb
    );
  END IF;
  RETURN p_result;
END
$$;

CREATE OR REPLACE FUNCTION private.reference_curation_submission_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted' OR NEW.row_version <> 1
       OR NEW.current_candidate_revision <> 1
       OR NEW.current_content_hash IS DISTINCT FROM NEW.initial_content_hash
       OR NEW.current_attestation_version IS DISTINCT FROM NEW.initial_attestation_version
       OR NEW.withdrawal_code IS NOT NULL OR NEW.withdrawn_at IS NOT NULL
       OR NEW.contributor_deleted_at IS NOT NULL OR NEW.candidate_purge_after IS NOT NULL
       OR NEW.claimed_by IS NOT NULL OR NEW.claimed_at IS NOT NULL
       OR NEW.accepted_candidate_revision IS NOT NULL OR NEW.accepted_content_hash IS NOT NULL
       OR NEW.accepted_curated_work_id IS NOT NULL OR NEW.accepted_curated_treatment_id IS NOT NULL
       OR NEW.accepted_curated_measurement_set_id IS NOT NULL OR NEW.accepted_by IS NOT NULL
       OR NEW.accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reference submission must begin at candidate revision one'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.initial_work_revision IS DISTINCT FROM OLD.initial_work_revision
     OR NEW.initial_treatment_revision IS DISTINCT FROM OLD.initial_treatment_revision
     OR NEW.initial_measurement_set_revision IS DISTINCT FROM OLD.initial_measurement_set_revision
     OR NEW.initial_content_hash IS DISTINCT FROM OLD.initial_content_hash
     OR NEW.initial_attestation_version IS DISTINCT FROM OLD.initial_attestation_version
     OR NEW.prior_submission_id IS DISTINCT FROM OLD.prior_submission_id THEN
    RAISE EXCEPTION 'submission identity and initial evidence are immutable' USING ERRCODE='25006';
  END IF;
  IF NEW.contributor_id IS DISTINCT FROM OLD.contributor_id AND NEW.contributor_id IS NOT NULL THEN
    RAISE EXCEPTION 'submission contributor attribution may only be anonymized' USING ERRCODE='25006';
  END IF;
  IF NEW.source_measurement_set_id IS DISTINCT FROM OLD.source_measurement_set_id
     AND NEW.source_measurement_set_id IS NOT NULL THEN
    RAISE EXCEPTION 'submission source pointer may only be removed' USING ERRCODE='25006';
  END IF;
  IF OLD.status='accepted' AND (
       NEW.accepted_candidate_revision IS DISTINCT FROM OLD.accepted_candidate_revision
       OR NEW.accepted_content_hash IS DISTINCT FROM OLD.accepted_content_hash
       OR NEW.accepted_curated_work_id IS DISTINCT FROM OLD.accepted_curated_work_id
       OR NEW.accepted_curated_treatment_id IS DISTINCT FROM OLD.accepted_curated_treatment_id
       OR NEW.accepted_curated_measurement_set_id IS DISTINCT FROM OLD.accepted_curated_measurement_set_id
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR (NEW.accepted_by IS DISTINCT FROM OLD.accepted_by AND NEW.accepted_by IS NOT NULL)
     ) THEN
    RAISE EXCEPTION 'accepted candidate and catalogue provenance are immutable' USING ERRCODE='25006';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'submission mutation must increment row_version exactly once' USING ERRCODE='40001';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status='submitted' AND NEW.status IN ('in_review','withdrawn'))
    OR (OLD.status='in_review' AND NEW.status IN ('submitted','changes_requested','rejected','accepted','withdrawn'))
    OR (OLD.status='changes_requested' AND NEW.status IN ('submitted','withdrawn'))
  ) THEN
    RAISE EXCEPTION 'invalid reference submission lifecycle transition: % -> %',OLD.status,NEW.status
      USING ERRCODE='23514';
  END IF;
  IF NEW.current_candidate_revision IS DISTINCT FROM OLD.current_candidate_revision
     OR NEW.current_content_hash IS DISTINCT FROM OLD.current_content_hash
     OR NEW.current_attestation_version IS DISTINCT FROM OLD.current_attestation_version THEN
    IF OLD.status<>'changes_requested' OR NEW.status<>'submitted'
       OR NEW.current_candidate_revision<>OLD.current_candidate_revision+1 THEN
      RAISE EXCEPTION 'candidate head may advance only on append-only resubmission' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status<>'in_review' THEN
    NEW.claimed_by:=NULL;
    NEW.claimed_at:=NULL;
  END IF;
  IF OLD.status='changes_requested' AND NEW.status='submitted' THEN
    NEW.review_feedback:=NULL;
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION public.mutate_reference_curation(
  p_actor_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_action text,
  p_target_id uuid,
  p_expected_row_version bigint,
  p_candidate_revision integer DEFAULT NULL,
  p_candidate_content_hash text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_hash text;
  v_existing private.reference_curation_moderation_requests%ROWTYPE;
  v_submission private.reference_curation_submissions%ROWTYPE;
  v_candidate jsonb;
  v_work jsonb;
  v_treatment jsonb;
  v_set jsonb;
  v_patch jsonb;
  v_target_type text;
  v_result jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_work_id uuid;
  v_treatment_id uuid;
  v_set_id uuid;
  v_work_version bigint;
  v_treatment_version bigint;
  v_set_version bigint;
  v_old_claim_authorized boolean;
  v_collision_rows bigint;
BEGIN
  IF p_request_id IS NULL OR p_actor_user_id IS NULL OR p_actor_session_id IS NULL
     OR p_target_id IS NULL OR p_expected_row_version IS NULL
     OR p_action NOT IN ('claim','request_changes','reject','accept_to_draft','edit_draft')
     OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' THEN
    RETURN pg_catalog.jsonb_build_object('status','invalid_request');
  END IF;
  v_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.jsonb_build_object(
      'actor',p_actor_user_id,'action',p_action,
      'target',p_target_id,'expected_row_version',p_expected_row_version,
      'candidate_revision',p_candidate_revision,'candidate_content_hash',p_candidate_content_hash,
      'reason',p_reason,'payload',p_payload
    )::text,'sha256'),'hex');
  IF NOT private.reference_curation_actor_authorized(p_actor_user_id,p_actor_session_id) THEN
    RETURN pg_catalog.jsonb_build_object('status','forbidden');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,7302));
  SELECT * INTO v_existing FROM private.reference_curation_moderation_requests
   WHERE request_id=p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash=v_hash THEN
      IF v_existing.result_json->>'status' IN ('created','updated') THEN
        RETURN v_existing.result_json || pg_catalog.jsonb_build_object('status','no_change');
      END IF;
      RETURN v_existing.result_json;
    END IF;
    INSERT INTO private.reference_curation_moderation_collisions(
      request_id,attempted_hash,actor_user_id,action,target_id
    ) VALUES(p_request_id,v_hash,p_actor_user_id,p_action,p_target_id)
    ON CONFLICT(request_id,attempted_hash) DO NOTHING;
    GET DIAGNOSTICS v_collision_rows=ROW_COUNT;
    IF v_collision_rows>0 THEN
      INSERT INTO private.reference_curation_events(
        actor_user_id,action,target_type,target_id,outcome,reason,metadata_json
      ) VALUES(
        p_actor_user_id,
        CASE WHEN p_action='accept_to_draft' THEN 'accept' ELSE p_action END,
        CASE WHEN p_action<>'edit_draft' THEN 'submission'
          WHEN EXISTS(SELECT 1 FROM private.curated_reference_works w WHERE w.id=p_target_id)
            THEN 'curated_work'
          WHEN EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments t WHERE t.id=p_target_id)
            THEN 'curated_treatment'
          WHEN EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa tt WHERE tt.id=p_target_id)
            THEN 'curated_treatment_taxon'
          ELSE 'curated_measurement_set' END,
        p_target_id,'conflict','idempotency_conflict','{}'::jsonb
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status','idempotency_conflict');
  END IF;
  IF p_reason IS NOT NULL AND pg_catalog.char_length(p_reason)>4000 THEN
    RETURN private.reference_curation_moderation_finish(
      p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
      pg_catalog.jsonb_build_object('status','invalid_reason'));
  END IF;

  IF p_action IN ('claim','request_changes','reject','accept_to_draft') THEN
    SELECT * INTO v_submission FROM private.reference_curation_submissions
     WHERE id=p_target_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN private.reference_curation_moderation_finish(
        p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
        pg_catalog.jsonb_build_object('status','not_found'));
    END IF;
    IF v_submission.current_candidate_revision IS DISTINCT FROM p_candidate_revision
       OR v_submission.current_content_hash IS DISTINCT FROM p_candidate_content_hash THEN
      RETURN private.reference_curation_moderation_finish(
        p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
        pg_catalog.jsonb_build_object('status','stale_candidate'));
    END IF;
    IF v_submission.row_version<>p_expected_row_version THEN
      RETURN private.reference_curation_moderation_finish(
        p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
        pg_catalog.jsonb_build_object('status','conflict','row_version',v_submission.row_version));
    END IF;
  END IF;

  IF p_action='claim' THEN
    IF p_payload<>'{}'::jsonb THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
    ELSIF v_submission.status='submitted' THEN
      UPDATE private.reference_curation_submissions SET
        status='in_review',claimed_by=p_actor_user_id,claimed_at=v_now,
        review_feedback=NULL,row_version=row_version+1
       WHERE id=p_target_id;
      INSERT INTO private.reference_curation_events(
        actor_user_id,action,target_type,target_id,outcome,reason,
        before_content_hash,after_content_hash
      ) VALUES(p_actor_user_id,'claim','submission',p_target_id,'succeeded',p_reason,
        p_candidate_content_hash,p_candidate_content_hash);
      v_result:=pg_catalog.jsonb_build_object('status','updated','submission_id',p_target_id);
    ELSIF v_submission.status='in_review' AND v_submission.claimed_by=p_actor_user_id THEN
      v_result:=pg_catalog.jsonb_build_object('status','no_change','submission_id',p_target_id);
    ELSIF v_submission.status='in_review' AND v_submission.claimed_by IS NULL THEN
      UPDATE private.reference_curation_submissions SET
        claimed_by=p_actor_user_id,claimed_at=v_now,review_feedback=NULL,
        row_version=row_version+1
       WHERE id=p_target_id;
      INSERT INTO private.reference_curation_events(
        actor_user_id,action,target_type,target_id,outcome,reason,
        before_content_hash,after_content_hash
      ) VALUES(p_actor_user_id,'claim','submission',p_target_id,'succeeded',p_reason,
        p_candidate_content_hash,p_candidate_content_hash);
      v_result:=pg_catalog.jsonb_build_object('status','updated','submission_id',p_target_id);
    ELSIF v_submission.status='in_review' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('reference-curator-memberships',7303)
      );
      SELECT NOT p.is_banned AND p.is_admin INTO v_old_claim_authorized
        FROM public.profiles p WHERE p.id=v_submission.claimed_by FOR SHARE;
      IF NOT coalesce(v_old_claim_authorized,false) THEN
        PERFORM 1 FROM private.reference_curator_memberships m
         WHERE m.user_id=v_submission.claimed_by
           AND m.role IN ('reference_reviewer','reference_publisher') FOR SHARE;
        v_old_claim_authorized:=FOUND AND EXISTS(
          SELECT 1 FROM public.profiles p
           WHERE p.id=v_submission.claimed_by AND NOT p.is_banned
        );
      END IF;
      IF v_old_claim_authorized THEN
        v_result:=pg_catalog.jsonb_build_object('status','conflict');
      ELSIF nullif(pg_catalog.btrim(p_reason),'') IS NULL OR pg_catalog.char_length(p_reason)>4000 THEN
        v_result:=pg_catalog.jsonb_build_object('status','invalid_reason');
      ELSE
        UPDATE private.reference_curation_submissions SET
          claimed_by=p_actor_user_id,claimed_at=v_now,row_version=row_version+1
         WHERE id=p_target_id;
        INSERT INTO private.reference_curation_events(
          actor_user_id,action,target_type,target_id,outcome,reason,
          before_content_hash,after_content_hash,metadata_json
        ) VALUES(p_actor_user_id,'reassign_claim','submission',p_target_id,'succeeded',p_reason,
          p_candidate_content_hash,p_candidate_content_hash,
          pg_catalog.jsonb_build_object('replacement_row_version',v_submission.row_version+1));
        v_result:=pg_catalog.jsonb_build_object('status','updated','submission_id',p_target_id);
      END IF;
    ELSE
      v_result:=pg_catalog.jsonb_build_object('status','invalid_state');
    END IF;

  ELSIF p_action IN ('request_changes','reject') THEN
    IF v_submission.status<>'in_review' OR v_submission.claimed_by<>p_actor_user_id THEN
      v_result:=pg_catalog.jsonb_build_object('status','forbidden');
    ELSIF nullif(pg_catalog.btrim(p_reason),'') IS NULL OR pg_catalog.char_length(p_reason)>4000 THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_reason');
    ELSIF p_payload<>'{}'::jsonb THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
    ELSE
      UPDATE private.reference_curation_submissions SET
        status=CASE WHEN p_action='request_changes' THEN 'changes_requested' ELSE 'rejected' END,
        claimed_by=NULL,claimed_at=NULL,review_feedback=p_reason,row_version=row_version+1
       WHERE id=p_target_id;
      INSERT INTO private.reference_curation_events(
        actor_user_id,action,target_type,target_id,outcome,reason,
        before_content_hash,after_content_hash
      ) VALUES(p_actor_user_id,p_action,'submission',p_target_id,'succeeded',p_reason,
        p_candidate_content_hash,p_candidate_content_hash);
      v_result:=pg_catalog.jsonb_build_object('status','updated','submission_id',p_target_id);
    END IF;

  ELSIF p_action='accept_to_draft' THEN
    IF v_submission.status<>'in_review' OR v_submission.claimed_by<>p_actor_user_id THEN
      v_result:=pg_catalog.jsonb_build_object('status','forbidden');
    ELSIF (p_payload ? 'existing_curated_work_id'
           OR p_payload ? 'existing_curated_treatment_id'
           OR p_payload ? 'existing_curated_measurement_set_id')
          AND nullif(pg_catalog.btrim(p_reason),'') IS NULL THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_reason');
    ELSIF private.reference_payload_has_unknown_keys(p_payload,ARRAY[
      'existing_curated_work_id','expected_curated_work_row_version',
      'existing_curated_treatment_id','expected_curated_treatment_row_version',
      'existing_curated_measurement_set_id','expected_curated_measurement_set_row_version'
    ]) THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
    ELSIF (p_payload ? 'existing_curated_treatment_id') AND NOT (p_payload ? 'existing_curated_work_id')
       OR (p_payload ? 'existing_curated_measurement_set_id') AND NOT (p_payload ? 'existing_curated_treatment_id')
       OR (p_payload ? 'existing_curated_work_id') AND NOT (p_payload ? 'expected_curated_work_row_version')
       OR (p_payload ? 'existing_curated_treatment_id') AND NOT (p_payload ? 'expected_curated_treatment_row_version')
       OR (p_payload ? 'existing_curated_measurement_set_id') AND NOT (p_payload ? 'expected_curated_measurement_set_row_version') THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
    ELSE
      SELECT sv.candidate_json INTO v_candidate
        FROM private.reference_curation_submission_versions sv
       WHERE sv.submission_id=p_target_id AND sv.candidate_revision=p_candidate_revision
         AND sv.content_hash=p_candidate_content_hash FOR SHARE;
      IF v_candidate IS NULL THEN
        v_result:=pg_catalog.jsonb_build_object('status','candidate_unavailable');
      ELSE
        v_work:=v_candidate->'work'; v_treatment:=v_candidate->'treatment'; v_set:=v_candidate->'measurement_set';
        IF p_payload ? 'existing_curated_work_id' THEN
          BEGIN
            v_work_id:=(p_payload->>'existing_curated_work_id')::uuid;
            v_work_version:=(p_payload->>'expected_curated_work_row_version')::bigint;
          EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_work_id:=NULL;
          END;
          IF v_work_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM private.curated_reference_works w WHERE w.id=v_work_id
              AND w.row_version=v_work_version
              AND NOT EXISTS(
                SELECT 1 FROM private.curated_reference_taxon_treatments t
                JOIN private.curated_reference_measurement_sets m ON m.taxon_treatment_id=t.id
                 WHERE t.reference_work_id=w.id AND m.catalogue_status<>'draft'
              ) FOR UPDATE
          ) THEN
            v_result:=pg_catalog.jsonb_build_object('status','conflict');
          END IF;
        ELSE
          v_work_id:=gen_random_uuid();
        END IF;
        IF v_result IS NULL AND p_payload ? 'existing_curated_treatment_id' THEN
          BEGIN
            v_treatment_id:=(p_payload->>'existing_curated_treatment_id')::uuid;
            v_treatment_version:=(p_payload->>'expected_curated_treatment_row_version')::bigint;
          EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_treatment_id:=NULL;
          END;
          IF v_treatment_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM private.curated_reference_taxon_treatments t
             WHERE t.id=v_treatment_id AND t.reference_work_id=v_work_id
               AND t.row_version=v_treatment_version
               AND NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
                               WHERE m.taxon_treatment_id=t.id AND m.catalogue_status<>'draft')
             FOR UPDATE
          ) THEN v_result:=pg_catalog.jsonb_build_object('status','conflict'); END IF;
        ELSE
          v_treatment_id:=gen_random_uuid();
        END IF;
        IF v_result IS NULL AND p_payload ? 'existing_curated_measurement_set_id' THEN
          BEGIN
            v_set_id:=(p_payload->>'existing_curated_measurement_set_id')::uuid;
            v_set_version:=(p_payload->>'expected_curated_measurement_set_row_version')::bigint;
          EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            v_set_id:=NULL;
          END;
          IF v_set_id IS NULL OR NOT EXISTS(
            SELECT 1 FROM private.curated_reference_measurement_sets m
             WHERE m.id=v_set_id AND m.taxon_treatment_id=v_treatment_id
               AND m.row_version=v_set_version AND m.catalogue_status='draft' FOR UPDATE
          ) THEN v_result:=pg_catalog.jsonb_build_object('status','conflict'); END IF;
        ELSE
          v_set_id:=gen_random_uuid();
        END IF;
        IF v_result IS NULL THEN
          IF NOT (p_payload ? 'existing_curated_work_id') THEN
            INSERT INTO private.curated_reference_works(
              id,type,authors_json,editors_json,title,container_title,year,edition,publisher,
              place,volume,issue,pages,doi,isbn,url,language,short_label,citation_override,
              revision,created_by,updated_by
            ) VALUES(
              v_work_id,v_work->>'type',v_work->'authors',v_work->'editors',v_work->>'title',
              v_work->>'container_title',(v_work->>'year')::integer,v_work->>'edition',
              v_work->>'publisher',v_work->>'place',v_work->>'volume',v_work->>'issue',
              v_work->>'pages',v_work->>'doi',v_work->>'isbn',v_work->>'url',v_work->>'language',
              v_work->>'short_label',v_work->>'citation_override',1,p_actor_user_id,p_actor_user_id
            );
          END IF;
          IF NOT (p_payload ? 'existing_curated_treatment_id') THEN
            INSERT INTO private.curated_reference_taxon_treatments(
              id,reference_work_id,name_as_published,page_from,page_to,locator_text,revision,created_by,updated_by
            ) VALUES(v_treatment_id,v_work_id,v_treatment->>'name_as_published',
              (v_treatment->>'page_from')::integer,(v_treatment->>'page_to')::integer,
              v_treatment->>'locator_text',1,p_actor_user_id,p_actor_user_id);
          END IF;
          IF NOT (p_payload ? 'existing_curated_measurement_set_id') THEN
            INSERT INTO private.curated_reference_measurement_sets(
              id,taxon_treatment_id,character,raw_text,data_kind,length_min,length_core_min,
              length_core_max,length_max,width_min,width_core_min,width_core_max,width_max,
              q_min,q_max,q_mean,length_mean,width_mean,sample_size,specimen_count,mount_medium,
              stain,preparation,measurement_method,raw_points_json,revision,created_by,updated_by
            ) VALUES(v_set_id,v_treatment_id,v_set->>'character',v_set->>'raw_text',v_set->>'data_kind',
              (v_set->>'length_min')::double precision,(v_set->>'length_core_min')::double precision,
              (v_set->>'length_core_max')::double precision,(v_set->>'length_max')::double precision,
              (v_set->>'width_min')::double precision,(v_set->>'width_core_min')::double precision,
              (v_set->>'width_core_max')::double precision,(v_set->>'width_max')::double precision,
              (v_set->>'q_min')::double precision,(v_set->>'q_max')::double precision,
              (v_set->>'q_mean')::double precision,(v_set->>'length_mean')::double precision,
              (v_set->>'width_mean')::double precision,(v_set->>'sample_size')::integer,
              (v_set->>'specimen_count')::integer,v_set->>'mount_medium',v_set->>'stain',
              v_set->>'preparation',v_set->>'measurement_method',
              NULLIF(v_set->'raw_points','null'::jsonb),1,
              p_actor_user_id,p_actor_user_id);
          END IF;
          UPDATE private.reference_curation_submissions SET
            status='accepted',claimed_by=NULL,claimed_at=NULL,
            accepted_candidate_revision=p_candidate_revision,
            accepted_content_hash=p_candidate_content_hash,
            accepted_curated_work_id=v_work_id,accepted_curated_treatment_id=v_treatment_id,
            accepted_curated_measurement_set_id=v_set_id,accepted_by=p_actor_user_id,
            accepted_at=v_now,row_version=row_version+1
           WHERE id=p_target_id;
          INSERT INTO private.reference_curation_events(
            actor_user_id,action,target_type,target_id,outcome,reason,
            before_content_hash,after_content_hash,metadata_json
          ) VALUES(p_actor_user_id,'accept','submission',p_target_id,'succeeded',p_reason,
            p_candidate_content_hash,p_candidate_content_hash,
            pg_catalog.jsonb_build_object('candidate_revision',p_candidate_revision,
              'curated_work_id',v_work_id,'curated_treatment_id',v_treatment_id,
              'curated_measurement_set_id',v_set_id));
          v_result:=pg_catalog.jsonb_build_object('status','updated','submission_id',p_target_id,
            'curated_work_id',v_work_id,'curated_treatment_id',v_treatment_id,
            'curated_measurement_set_id',v_set_id);
        END IF;
      END IF;
    END IF;

  ELSE
    v_target_type:=p_payload->>'target_type';
    v_patch:=p_payload->'patch';
    IF private.reference_payload_has_unknown_keys(p_payload,ARRAY['target_type','patch'])
       OR v_target_type NOT IN ('work','treatment','measurement_set','treatment_taxa')
       OR pg_catalog.jsonb_typeof(v_patch)<>'object' OR v_patch='{}'::jsonb
       OR nullif(pg_catalog.btrim(p_reason),'') IS NULL THEN
      v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
    ELSIF v_target_type='work' THEN
      IF private.reference_payload_has_unknown_keys(v_patch,ARRAY[
        'type','authors','editors','title','container_title','year','edition','publisher','place',
        'volume','issue','pages','doi','isbn','url','language','short_label','citation_override'
      ]) OR (v_patch?'authors' AND NOT private.reference_curation_agents_valid(v_patch->'authors'))
         OR (v_patch?'editors' AND NOT private.reference_curation_agents_valid(v_patch->'editors')) THEN
        v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
      ELSIF NOT EXISTS(SELECT 1 FROM private.curated_reference_works w WHERE w.id=p_target_id
                        AND w.row_version=p_expected_row_version
                        AND NOT EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments t
                          JOIN private.curated_reference_measurement_sets m ON m.taxon_treatment_id=t.id
                          WHERE t.reference_work_id=w.id AND m.catalogue_status<>'draft') FOR UPDATE) THEN
        v_result:=pg_catalog.jsonb_build_object('status','conflict');
      ELSIF EXISTS(SELECT 1 FROM private.curated_reference_works w WHERE w.id=p_target_id AND
        v_patch <@ pg_catalog.jsonb_build_object(
          'type',w.type,'authors',w.authors_json,'editors',w.editors_json,'title',w.title,
          'container_title',w.container_title,'year',w.year,'edition',w.edition,
          'publisher',w.publisher,'place',w.place,'volume',w.volume,'issue',w.issue,
          'pages',w.pages,'doi',w.doi,'isbn',w.isbn,'url',w.url,'language',w.language,
          'short_label',w.short_label,'citation_override',w.citation_override)) THEN
        v_result:=pg_catalog.jsonb_build_object('status','no_change','target_id',p_target_id);
      ELSE
        UPDATE private.curated_reference_works w SET
          type=CASE WHEN v_patch?'type' THEN v_patch->>'type' ELSE w.type END,
          authors_json=CASE WHEN v_patch?'authors' THEN v_patch->'authors' ELSE w.authors_json END,
          editors_json=CASE WHEN v_patch?'editors' THEN v_patch->'editors' ELSE w.editors_json END,
          title=CASE WHEN v_patch?'title' THEN v_patch->>'title' ELSE w.title END,
          container_title=CASE WHEN v_patch?'container_title' THEN v_patch->>'container_title' ELSE w.container_title END,
          year=CASE WHEN v_patch?'year' THEN (v_patch->>'year')::integer ELSE w.year END,
          edition=CASE WHEN v_patch?'edition' THEN v_patch->>'edition' ELSE w.edition END,
          publisher=CASE WHEN v_patch?'publisher' THEN v_patch->>'publisher' ELSE w.publisher END,
          place=CASE WHEN v_patch?'place' THEN v_patch->>'place' ELSE w.place END,
          volume=CASE WHEN v_patch?'volume' THEN v_patch->>'volume' ELSE w.volume END,
          issue=CASE WHEN v_patch?'issue' THEN v_patch->>'issue' ELSE w.issue END,
          pages=CASE WHEN v_patch?'pages' THEN v_patch->>'pages' ELSE w.pages END,
          doi=CASE WHEN v_patch?'doi' THEN v_patch->>'doi' ELSE w.doi END,
          isbn=CASE WHEN v_patch?'isbn' THEN v_patch->>'isbn' ELSE w.isbn END,
          url=CASE WHEN v_patch?'url' THEN v_patch->>'url' ELSE w.url END,
          language=CASE WHEN v_patch?'language' THEN v_patch->>'language' ELSE w.language END,
          short_label=CASE WHEN v_patch?'short_label' THEN v_patch->>'short_label' ELSE w.short_label END,
          citation_override=CASE WHEN v_patch?'citation_override' THEN v_patch->>'citation_override' ELSE w.citation_override END,
          revision=w.revision+1,row_version=w.row_version+1,updated_by=p_actor_user_id WHERE w.id=p_target_id;
        v_result:=pg_catalog.jsonb_build_object('status','updated','target_id',p_target_id);
      END IF;
    ELSIF v_target_type='treatment' THEN
      IF private.reference_payload_has_unknown_keys(v_patch,ARRAY[
        'name_as_published','page_from','page_to','locator_text','treatment_notes'
      ]) THEN v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
      ELSIF NOT EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments t
                        WHERE t.id=p_target_id AND t.row_version=p_expected_row_version
                          AND NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
                           WHERE m.taxon_treatment_id=t.id AND m.catalogue_status<>'draft') FOR UPDATE) THEN
        v_result:=pg_catalog.jsonb_build_object('status','conflict');
      ELSIF EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments t
        WHERE t.id=p_target_id AND v_patch <@ pg_catalog.jsonb_build_object(
          'name_as_published',t.name_as_published,'page_from',t.page_from,'page_to',t.page_to,
          'locator_text',t.locator_text,'treatment_notes',t.treatment_notes)) THEN
        v_result:=pg_catalog.jsonb_build_object('status','no_change','target_id',p_target_id);
      ELSE
        UPDATE private.curated_reference_taxon_treatments t SET
          name_as_published=CASE WHEN v_patch?'name_as_published' THEN v_patch->>'name_as_published' ELSE t.name_as_published END,
          page_from=CASE WHEN v_patch?'page_from' THEN (v_patch->>'page_from')::integer ELSE t.page_from END,
          page_to=CASE WHEN v_patch?'page_to' THEN (v_patch->>'page_to')::integer ELSE t.page_to END,
          locator_text=CASE WHEN v_patch?'locator_text' THEN v_patch->>'locator_text' ELSE t.locator_text END,
          treatment_notes=CASE WHEN v_patch?'treatment_notes' THEN v_patch->>'treatment_notes' ELSE t.treatment_notes END,
          revision=t.revision+1,row_version=t.row_version+1,updated_by=p_actor_user_id WHERE t.id=p_target_id;
        v_result:=pg_catalog.jsonb_build_object('status','updated','target_id',p_target_id);
      END IF;
    ELSIF v_target_type='measurement_set' THEN
      IF private.reference_payload_has_unknown_keys(v_patch,ARRAY[
        'character','raw_text','data_kind','length_min','length_core_min','length_core_max','length_max',
        'width_min','width_core_min','width_core_max','width_max','q_min','q_max','q_mean','length_mean',
        'width_mean','sample_size','specimen_count','mount_medium','stain','preparation','measurement_method',
        'notes','raw_points'
      ]) OR (v_patch?'raw_points'
             AND NOT private.reference_curation_raw_points_valid(v_patch->'raw_points')) THEN
        v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
      ELSIF NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
                        WHERE m.id=p_target_id AND m.row_version=p_expected_row_version
                          AND m.catalogue_status='draft' FOR UPDATE) THEN
        v_result:=pg_catalog.jsonb_build_object('status','conflict');
      ELSIF EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
        WHERE m.id=p_target_id AND v_patch <@ pg_catalog.jsonb_build_object(
          'character',m.character,'raw_text',m.raw_text,'data_kind',m.data_kind,
          'length_min',m.length_min,'length_core_min',m.length_core_min,
          'length_core_max',m.length_core_max,'length_max',m.length_max,
          'width_min',m.width_min,'width_core_min',m.width_core_min,
          'width_core_max',m.width_core_max,'width_max',m.width_max,
          'q_min',m.q_min,'q_max',m.q_max,'q_mean',m.q_mean,
          'length_mean',m.length_mean,'width_mean',m.width_mean,
          'sample_size',m.sample_size,'specimen_count',m.specimen_count,
          'mount_medium',m.mount_medium,'stain',m.stain,'preparation',m.preparation,
          'measurement_method',m.measurement_method,'notes',m.notes,'raw_points',m.raw_points_json)) THEN
        v_result:=pg_catalog.jsonb_build_object('status','no_change','target_id',p_target_id);
      ELSE
        UPDATE private.curated_reference_measurement_sets m SET
          character=CASE WHEN v_patch?'character' THEN v_patch->>'character' ELSE m.character END,
          raw_text=CASE WHEN v_patch?'raw_text' THEN v_patch->>'raw_text' ELSE m.raw_text END,
          data_kind=CASE WHEN v_patch?'data_kind' THEN v_patch->>'data_kind' ELSE m.data_kind END,
          length_min=CASE WHEN v_patch?'length_min' THEN (v_patch->>'length_min')::double precision ELSE m.length_min END,
          length_core_min=CASE WHEN v_patch?'length_core_min' THEN (v_patch->>'length_core_min')::double precision ELSE m.length_core_min END,
          length_core_max=CASE WHEN v_patch?'length_core_max' THEN (v_patch->>'length_core_max')::double precision ELSE m.length_core_max END,
          length_max=CASE WHEN v_patch?'length_max' THEN (v_patch->>'length_max')::double precision ELSE m.length_max END,
          width_min=CASE WHEN v_patch?'width_min' THEN (v_patch->>'width_min')::double precision ELSE m.width_min END,
          width_core_min=CASE WHEN v_patch?'width_core_min' THEN (v_patch->>'width_core_min')::double precision ELSE m.width_core_min END,
          width_core_max=CASE WHEN v_patch?'width_core_max' THEN (v_patch->>'width_core_max')::double precision ELSE m.width_core_max END,
          width_max=CASE WHEN v_patch?'width_max' THEN (v_patch->>'width_max')::double precision ELSE m.width_max END,
          q_min=CASE WHEN v_patch?'q_min' THEN (v_patch->>'q_min')::double precision ELSE m.q_min END,
          q_max=CASE WHEN v_patch?'q_max' THEN (v_patch->>'q_max')::double precision ELSE m.q_max END,
          q_mean=CASE WHEN v_patch?'q_mean' THEN (v_patch->>'q_mean')::double precision ELSE m.q_mean END,
          length_mean=CASE WHEN v_patch?'length_mean' THEN (v_patch->>'length_mean')::double precision ELSE m.length_mean END,
          width_mean=CASE WHEN v_patch?'width_mean' THEN (v_patch->>'width_mean')::double precision ELSE m.width_mean END,
          sample_size=CASE WHEN v_patch?'sample_size' THEN (v_patch->>'sample_size')::integer ELSE m.sample_size END,
          specimen_count=CASE WHEN v_patch?'specimen_count' THEN (v_patch->>'specimen_count')::integer ELSE m.specimen_count END,
          mount_medium=CASE WHEN v_patch?'mount_medium' THEN v_patch->>'mount_medium' ELSE m.mount_medium END,
          stain=CASE WHEN v_patch?'stain' THEN v_patch->>'stain' ELSE m.stain END,
          preparation=CASE WHEN v_patch?'preparation' THEN v_patch->>'preparation' ELSE m.preparation END,
          measurement_method=CASE WHEN v_patch?'measurement_method' THEN v_patch->>'measurement_method' ELSE m.measurement_method END,
          notes=CASE WHEN v_patch?'notes' THEN v_patch->>'notes' ELSE m.notes END,
          raw_points_json=CASE WHEN v_patch?'raw_points'
            THEN NULLIF(v_patch->'raw_points','null'::jsonb) ELSE m.raw_points_json END,
          revision=m.revision+1,row_version=m.row_version+1,updated_by=p_actor_user_id WHERE m.id=p_target_id;
        v_result:=pg_catalog.jsonb_build_object('status','updated','target_id',p_target_id);
      END IF;
    ELSE
      IF private.reference_payload_has_unknown_keys(v_patch,ARRAY[
        'taxon_treatment_id','sporely_taxon_id','assignment_reason'
      ]) THEN v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
      ELSIF p_expected_row_version=0 THEN
        IF NOT (v_patch ?& ARRAY['taxon_treatment_id','sporely_taxon_id','assignment_reason'])
           OR NOT EXISTS(SELECT 1 FROM private.curated_reference_taxon_treatments t
              WHERE t.id=(v_patch->>'taxon_treatment_id')::uuid
                AND EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
                  WHERE m.taxon_treatment_id=t.id AND m.catalogue_status='draft')
                AND NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
                  WHERE m.taxon_treatment_id=t.id AND m.catalogue_status<>'draft')) THEN
          v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
        ELSIF EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa WHERE id=p_target_id) THEN
          v_result:=pg_catalog.jsonb_build_object('status','conflict');
        ELSE
          INSERT INTO private.curated_reference_treatment_taxa(
            id,taxon_treatment_id,sporely_taxon_id,assignment_reason,revision,created_by,updated_by
          ) VALUES(p_target_id,(v_patch->>'taxon_treatment_id')::uuid,
            (v_patch->>'sporely_taxon_id')::integer,v_patch->>'assignment_reason',1,
            p_actor_user_id,p_actor_user_id);
          v_result:=pg_catalog.jsonb_build_object('status','updated','target_id',p_target_id);
        END IF;
      ELSIF NOT EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa tt
                        JOIN private.curated_reference_taxon_treatments t ON t.id=tt.taxon_treatment_id
                        WHERE tt.id=p_target_id AND tt.row_version=p_expected_row_version
                          AND NOT EXISTS(SELECT 1 FROM private.curated_reference_measurement_sets m
                           WHERE m.taxon_treatment_id=t.id AND m.catalogue_status<>'draft') FOR UPDATE OF tt) THEN
        v_result:=pg_catalog.jsonb_build_object('status','conflict');
      ELSIF v_patch ? 'taxon_treatment_id' THEN
        v_result:=pg_catalog.jsonb_build_object('status','invalid_payload');
      ELSIF EXISTS(SELECT 1 FROM private.curated_reference_treatment_taxa tt
        WHERE tt.id=p_target_id AND v_patch <@ pg_catalog.jsonb_build_object(
          'sporely_taxon_id',tt.sporely_taxon_id,'assignment_reason',tt.assignment_reason)) THEN
        v_result:=pg_catalog.jsonb_build_object('status','no_change','target_id',p_target_id);
      ELSE
        UPDATE private.curated_reference_treatment_taxa tt SET
          sporely_taxon_id=CASE WHEN v_patch?'sporely_taxon_id' THEN (v_patch->>'sporely_taxon_id')::integer ELSE tt.sporely_taxon_id END,
          assignment_reason=CASE WHEN v_patch?'assignment_reason' THEN v_patch->>'assignment_reason' ELSE tt.assignment_reason END,
          revision=tt.revision+1,row_version=tt.row_version+1,updated_by=p_actor_user_id
         WHERE tt.id=p_target_id;
        v_result:=pg_catalog.jsonb_build_object('status','updated','target_id',p_target_id);
      END IF;
    END IF;
    IF v_result->>'status'='updated' THEN
      INSERT INTO private.reference_curation_events(
        actor_user_id,action,target_type,target_id,outcome,reason,metadata_json
      ) VALUES(p_actor_user_id,'edit_draft',
        CASE v_target_type WHEN 'work' THEN 'curated_work'
          WHEN 'treatment' THEN 'curated_treatment'
          WHEN 'measurement_set' THEN 'curated_measurement_set'
          ELSE 'curated_treatment_taxon' END,
        p_target_id,'succeeded',p_reason,
        pg_catalog.jsonb_build_object('row_version',p_expected_row_version+1));
    END IF;
  END IF;

  RETURN private.reference_curation_moderation_finish(
    p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,v_result);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN private.reference_curation_moderation_finish(
    p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
    pg_catalog.jsonb_build_object('status','invalid_payload'));
WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN private.reference_curation_moderation_finish(
    p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
    pg_catalog.jsonb_build_object('status','invalid_payload'));
WHEN unique_violation THEN
  RETURN private.reference_curation_moderation_finish(
    p_request_id,p_actor_user_id,p_actor_session_id,p_action,p_target_id,v_hash,
    pg_catalog.jsonb_build_object('status','conflict'));
END
$$;

CREATE FUNCTION private.reference_curation_normalize_doi(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT NULLIF(pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
    coalesce(p_value,''),
    '^(doi:[[:space:]]*|https?://(dx\.)?doi\.org/)',
    '',
    'i'
  ))),'')
$$;

CREATE FUNCTION public.get_reference_curation_duplicate_warnings(
  p_actor_user_id uuid,
  p_actor_session_id uuid,
  p_submission_id uuid,
  p_candidate_revision integer,
  p_candidate_content_hash text
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_candidate jsonb;
  v_work jsonb;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  IF NOT private.reference_curation_actor_authorized(p_actor_user_id,p_actor_session_id) THEN
    RETURN pg_catalog.jsonb_build_object('status','forbidden');
  END IF;
  SELECT sv.candidate_json INTO v_candidate
    FROM private.reference_curation_submissions s
    JOIN private.reference_curation_submission_versions sv
      ON sv.submission_id=s.id AND sv.candidate_revision=p_candidate_revision
   WHERE s.id=p_submission_id AND s.current_candidate_revision=p_candidate_revision
     AND s.current_content_hash=p_candidate_content_hash
     AND sv.content_hash=p_candidate_content_hash;
  IF v_candidate IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status','stale_candidate');
  END IF;
  v_work:=v_candidate->'work';
  SELECT coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object('kind',warning.kind,'curated_work_id',warning.curated_work_id)
           ORDER BY warning.kind,warning.curated_work_id
         ),'[]'::jsonb)
    INTO v_warnings
    FROM (
      SELECT candidate.kind,candidate.curated_work_id
        FROM (
          SELECT 'exact_doi'::text AS kind,w.id AS curated_work_id
            FROM private.curated_reference_works w
           WHERE private.reference_curation_normalize_doi(v_work->>'doi') IS NOT NULL
             AND private.reference_curation_normalize_doi(w.doi)=
                 private.reference_curation_normalize_doi(v_work->>'doi')
          UNION ALL
          SELECT 'normalized_isbn'::text,w.id
            FROM private.curated_reference_works w
           WHERE nullif(pg_catalog.regexp_replace(
                   pg_catalog.upper(coalesce(v_work->>'isbn','')),'[^0-9X]','','g'
                 ),'') IS NOT NULL
             AND pg_catalog.regexp_replace(pg_catalog.upper(w.isbn),'[^0-9X]','','g')=
                 pg_catalog.regexp_replace(pg_catalog.upper(v_work->>'isbn'),'[^0-9X]','','g')
          UNION ALL
          SELECT 'exact_bibliography'::text,w.id
            FROM private.curated_reference_works w
           WHERE pg_catalog.jsonb_build_object(
             'type',w.type,'authors',w.authors_json,'editors',w.editors_json,'title',w.title,
             'container_title',w.container_title,'year',w.year,'edition',w.edition,
             'publisher',w.publisher,'place',w.place,'volume',w.volume,'issue',w.issue,
             'pages',w.pages,'doi',w.doi,'isbn',w.isbn,'url',w.url,'language',w.language,
             'short_label',w.short_label,'citation_override',w.citation_override
           )=v_work
        ) candidate
       ORDER BY candidate.kind,candidate.curated_work_id
       LIMIT 100
    ) warning;
  RETURN pg_catalog.jsonb_build_object('status','ok','warnings',v_warnings);
END
$$;

-- Preserve the Stage 6b deletion body behind a wrapper which first releases
-- moderation claims. The same per-account advisory lock is re-entrant.
ALTER FUNCTION public.delete_reference_library_for_account(uuid)
  RENAME TO delete_reference_library_for_account_stage6b;
ALTER FUNCTION public.delete_reference_library_for_account_stage6b(uuid)
  SET SCHEMA private;

CREATE FUNCTION public.delete_reference_library_for_account(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_submission record;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text,7301));
  UPDATE private.reference_curation_submissions SET
    accepted_by=NULL,row_version=row_version+1
   WHERE accepted_by=p_user_id;
  FOR v_submission IN
    SELECT s.id,s.current_content_hash
      FROM private.reference_curation_submissions s
     WHERE s.claimed_by=p_user_id AND s.status='in_review'
     FOR UPDATE
  LOOP
    INSERT INTO private.reference_curation_events(
      actor_user_id,action,target_type,target_id,outcome,reason,
      before_content_hash,after_content_hash
    ) VALUES(p_user_id,'release_claim','submission',v_submission.id,'succeeded',
      'curator_account_deleted',v_submission.current_content_hash,v_submission.current_content_hash);
    UPDATE private.reference_curation_submissions SET
      status='submitted',claimed_by=NULL,claimed_at=NULL,row_version=row_version+1
     WHERE id=v_submission.id;
  END LOOP;
  PERFORM private.delete_reference_library_for_account_stage6b(p_user_id);
END
$$;

ALTER FUNCTION public.mutate_reference_curation(uuid,uuid,uuid,text,uuid,bigint,integer,text,text,jsonb)
  OWNER TO postgres;
ALTER FUNCTION public.get_reference_curation_duplicate_warnings(uuid,uuid,uuid,integer,text)
  OWNER TO postgres;
ALTER FUNCTION public.delete_reference_library_for_account(uuid) OWNER TO postgres;
ALTER FUNCTION private.delete_reference_library_for_account_stage6b(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.mutate_reference_curation(uuid,uuid,uuid,text,uuid,bigint,integer,text,text,jsonb)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_reference_curation_duplicate_warnings(uuid,uuid,uuid,integer,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.delete_reference_library_for_account(uuid)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.delete_reference_library_for_account_stage6b(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mutate_reference_curation(uuid,uuid,uuid,text,uuid,bigint,integer,text,text,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_reference_curation_duplicate_warnings(uuid,uuid,uuid,integer,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_reference_library_for_account(uuid) TO service_role;
REVOKE ALL ON FUNCTION private.reference_curation_actor_authorized(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.reference_curation_moderation_finish(uuid,uuid,uuid,text,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.reference_curation_moderation_request_guard()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.reference_curator_membership_serialize()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.reference_curation_normalize_doi(text)
  FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
