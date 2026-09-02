-- Dormant owner submission and curated-reference report intake.
--
-- All operational policy values are deliberately unset and both intake paths
-- are disabled. This migration adds no public reads, curator mutations, Edge
-- Functions, or production activation.

BEGIN;

CREATE TABLE private.reference_curation_intake_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  submissions_enabled boolean NOT NULL DEFAULT false,
  reports_enabled boolean NOT NULL DEFAULT false,
  attestation_version text CHECK (
    attestation_version IS NULL OR (
      btrim(attestation_version) <> '' AND char_length(attestation_version) <= 128
    )
  ),
  attestation_text text CHECK (
    attestation_text IS NULL OR (
      btrim(attestation_text) <> '' AND char_length(attestation_text) <= 8192
    )
  ),
  attestation_content_hash text GENERATED ALWAYS AS (
    CASE WHEN attestation_text IS NULL THEN NULL
      ELSE pg_catalog.encode(extensions.digest(attestation_text, 'sha256'), 'hex')
    END
  ) STORED,
  submission_rate_window interval CHECK (
    submission_rate_window IS NULL OR submission_rate_window > interval '0 seconds'
  ),
  submission_rate_limit integer CHECK (
    submission_rate_limit IS NULL OR submission_rate_limit > 0
  ),
  report_rate_window interval CHECK (
    report_rate_window IS NULL OR report_rate_window > interval '0 seconds'
  ),
  report_rate_limit integer CHECK (
    report_rate_limit IS NULL OR report_rate_limit > 0
  ),
  unaccepted_submission_retention interval CHECK (
    unaccepted_submission_retention IS NULL OR unaccepted_submission_retention >= interval '0 seconds'
  ),
  report_text_retention interval CHECK (
    report_text_retention IS NULL OR report_text_retention >= interval '0 seconds'
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((attestation_version IS NULL) = (attestation_text IS NULL)),
  CHECK (
    NOT submissions_enabled OR (
      attestation_version IS NOT NULL
      AND attestation_text IS NOT NULL
      AND submission_rate_window IS NOT NULL
      AND submission_rate_limit IS NOT NULL
      AND unaccepted_submission_retention IS NOT NULL
    )
  ),
  CHECK (
    NOT reports_enabled OR (
      report_rate_window IS NOT NULL
      AND report_rate_limit IS NOT NULL
      AND report_text_retention IS NOT NULL
    )
  )
);

INSERT INTO private.reference_curation_intake_policy(singleton) VALUES (true);

CREATE TABLE private.reference_curation_attestation_versions (
  attestation_version text PRIMARY KEY CHECK (
    btrim(attestation_version) <> '' AND char_length(attestation_version) <= 128
  ),
  attestation_text text NOT NULL CHECK (
    btrim(attestation_text) <> '' AND char_length(attestation_text) <= 8192
  ),
  attestation_content_hash text GENERATED ALWAYS AS (
    pg_catalog.encode(extensions.digest(attestation_text, 'sha256'), 'hex')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attestation_version, attestation_content_hash)
);

ALTER TABLE private.reference_curation_intake_policy
  ADD CONSTRAINT reference_curation_policy_attestation_fkey
  FOREIGN KEY (attestation_version, attestation_content_hash)
  REFERENCES private.reference_curation_attestation_versions(
    attestation_version, attestation_content_hash
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE private.reference_curation_intake_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('submission', 'report')),
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.reference_curation_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contributor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  source_measurement_set_id uuid,
  initial_work_revision integer NOT NULL CHECK (initial_work_revision >= 1),
  initial_treatment_revision integer NOT NULL CHECK (initial_treatment_revision >= 1),
  initial_measurement_set_revision integer NOT NULL CHECK (initial_measurement_set_revision >= 1),
  initial_content_hash text NOT NULL CHECK (initial_content_hash ~ '^[0-9a-f]{64}$'),
  initial_attestation_version text NOT NULL CHECK (
    btrim(initial_attestation_version) <> '' AND char_length(initial_attestation_version) <= 128
  ),
  status text NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'in_review', 'changes_requested', 'rejected', 'accepted', 'withdrawn')
  ),
  current_candidate_revision integer NOT NULL CHECK (current_candidate_revision >= 1),
  current_content_hash text NOT NULL CHECK (current_content_hash ~ '^[0-9a-f]{64}$'),
  current_attestation_version text NOT NULL CHECK (
    btrim(current_attestation_version) <> '' AND char_length(current_attestation_version) <= 128
  ),
  prior_submission_id uuid REFERENCES private.reference_curation_submissions(id) ON DELETE RESTRICT,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  withdrawal_code text CHECK (withdrawal_code IN (
    'submitted_in_error', 'source_needs_revision', 'rights_uncertain',
    'other', 'account_deleted'
  )),
  withdrawn_at timestamptz,
  contributor_deleted_at timestamptz,
  candidate_purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, current_candidate_revision),
  FOREIGN KEY (contributor_id, source_measurement_set_id)
    REFERENCES public.reference_measurement_sets(user_id, id) ON DELETE SET NULL,
  CHECK ((contributor_id IS NULL) = (source_measurement_set_id IS NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK (prior_submission_id IS NULL OR prior_submission_id <> id)
);

CREATE TABLE private.reference_curation_submission_versions (
  submission_id uuid NOT NULL REFERENCES private.reference_curation_submissions(id) ON DELETE RESTRICT,
  candidate_revision integer NOT NULL CHECK (candidate_revision >= 1),
  candidate_schema_version integer NOT NULL CHECK (candidate_schema_version = 1),
  candidate_json jsonb CHECK (
    candidate_json IS NULL OR (
    jsonb_typeof(candidate_json) = 'object'
    AND octet_length(candidate_json::text) <= 65536
    AND candidate_json->>'schema_version' = '1'
    AND candidate_json ?& ARRAY['schema_version', 'work', 'treatment', 'measurement_set']
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json, ARRAY['schema_version', 'work', 'treatment', 'measurement_set']
    )
    AND jsonb_typeof(candidate_json->'work') = 'object'
    AND jsonb_typeof(candidate_json->'treatment') = 'object'
    AND jsonb_typeof(candidate_json->'measurement_set') = 'object'
    AND (candidate_json->'work') ?& ARRAY[
      'type', 'authors', 'editors', 'title', 'container_title', 'year',
      'edition', 'publisher', 'place', 'volume', 'issue', 'pages', 'doi',
      'isbn', 'url', 'language', 'short_label', 'citation_override'
    ]
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json->'work', ARRAY[
        'type', 'authors', 'editors', 'title', 'container_title', 'year',
        'edition', 'publisher', 'place', 'volume', 'issue', 'pages', 'doi',
        'isbn', 'url', 'language', 'short_label', 'citation_override'
      ]
    )
    AND (candidate_json->'treatment') ?&
      ARRAY['name_as_published', 'page_from', 'page_to', 'locator_text']
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json->'treatment',
      ARRAY['name_as_published', 'page_from', 'page_to', 'locator_text']
    )
    AND (candidate_json->'measurement_set') ?& ARRAY[
      'character', 'raw_text', 'data_kind', 'length_min',
      'length_core_min', 'length_core_max', 'length_max', 'width_min',
      'width_core_min', 'width_core_max', 'width_max', 'q_min', 'q_max',
      'q_mean', 'length_mean', 'width_mean', 'sample_size',
      'specimen_count', 'mount_medium', 'stain', 'preparation',
      'measurement_method', 'raw_points'
    ]
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json->'measurement_set', ARRAY[
        'character', 'raw_text', 'data_kind', 'length_min',
        'length_core_min', 'length_core_max', 'length_max', 'width_min',
        'width_core_min', 'width_core_max', 'width_max', 'q_min', 'q_max',
        'q_mean', 'length_mean', 'width_mean', 'sample_size',
        'specimen_count', 'mount_medium', 'stain', 'preparation',
        'measurement_method', 'raw_points'
      ]
    )
    )
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_work_revision integer NOT NULL CHECK (source_work_revision >= 1),
  source_treatment_revision integer NOT NULL CHECK (source_treatment_revision >= 1),
  source_measurement_set_revision integer NOT NULL CHECK (source_measurement_set_revision >= 1),
  expected_submission_row_version bigint,
  attestation_version text NOT NULL CHECK (
    btrim(attestation_version) <> '' AND char_length(attestation_version) <= 128
  ),
  attestation_content_hash text NOT NULL CHECK (attestation_content_hash ~ '^[0-9a-f]{64}$'),
  rights_confirmed boolean NOT NULL CHECK (rights_confirmed),
  curation_consent_confirmed boolean NOT NULL CHECK (curation_consent_confirmed),
  attested_at timestamptz NOT NULL DEFAULT now(),
  candidate_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, candidate_revision),
  FOREIGN KEY (attestation_version, attestation_content_hash)
    REFERENCES private.reference_curation_attestation_versions(
      attestation_version, attestation_content_hash
    ) ON DELETE RESTRICT,
  CHECK (
    (candidate_revision = 1 AND expected_submission_row_version IS NULL)
    OR (candidate_revision > 1 AND expected_submission_row_version >= 1)
  ),
  CHECK ((candidate_json IS NULL) = (candidate_purged_at IS NOT NULL))
);

ALTER TABLE private.reference_curation_submissions
  ADD CONSTRAINT reference_curation_submissions_current_version_fkey
  FOREIGN KEY (id, current_candidate_revision)
  REFERENCES private.reference_curation_submission_versions(submission_id, candidate_revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE private.reference_curation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  idempotency_key uuid NOT NULL,
  curated_measurement_set_id uuid NOT NULL,
  bundle_revision integer NOT NULL CHECK (bundle_revision >= 1),
  reason_code text NOT NULL CHECK (
    reason_code IN ('copyright', 'citation_error', 'taxon_assignment', 'measurement_error', 'duplicate', 'other')
  ),
  details text CHECK (details IS NULL OR char_length(details) <= 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  reporter_deleted_at timestamptz,
  text_redact_after timestamptz,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (curated_measurement_set_id, bundle_revision)
    REFERENCES private.curated_reference_publications(curated_measurement_set_id, bundle_revision)
    ON DELETE RESTRICT,
  UNIQUE (reporter_id, idempotency_key),
  CHECK (reason_code <> 'other' OR nullif(btrim(details), '') IS NOT NULL),
  CHECK (redacted_at IS NULL OR details IS NULL)
);

CREATE UNIQUE INDEX reference_curation_submissions_initial_idempotency_key
  ON private.reference_curation_submissions (
    contributor_id, source_measurement_set_id,
    initial_work_revision, initial_treatment_revision,
    initial_measurement_set_revision, initial_content_hash,
    initial_attestation_version
  )
  WHERE contributor_id IS NOT NULL AND source_measurement_set_id IS NOT NULL;
CREATE UNIQUE INDEX reference_curation_submissions_one_active_source_key
  ON private.reference_curation_submissions (contributor_id, source_measurement_set_id)
  WHERE contributor_id IS NOT NULL
    AND source_measurement_set_id IS NOT NULL
    AND status IN ('submitted', 'in_review', 'changes_requested');
CREATE INDEX reference_curation_submissions_contributor_created_idx
  ON private.reference_curation_submissions (contributor_id, created_at DESC, id)
  WHERE contributor_id IS NOT NULL;
CREATE INDEX reference_curation_submissions_source_idx
  ON private.reference_curation_submissions (contributor_id, source_measurement_set_id, created_at DESC)
  WHERE contributor_id IS NOT NULL AND source_measurement_set_id IS NOT NULL;
CREATE INDEX reference_curation_submissions_prior_idx
  ON private.reference_curation_submissions (prior_submission_id)
  WHERE prior_submission_id IS NOT NULL;
CREATE INDEX reference_curation_submission_versions_created_idx
  ON private.reference_curation_submission_versions (created_at DESC, submission_id, candidate_revision);
CREATE INDEX reference_curation_submissions_purge_due_idx
  ON private.reference_curation_submissions (candidate_purge_after, id)
  WHERE contributor_id IS NULL AND candidate_purge_after IS NOT NULL;
CREATE INDEX reference_curation_reports_target_idx
  ON private.reference_curation_reports (curated_measurement_set_id, bundle_revision, status, created_at DESC, id);
CREATE INDEX reference_curation_reports_reporter_created_idx
  ON private.reference_curation_reports (reporter_id, created_at DESC, id)
  WHERE reporter_id IS NOT NULL;
CREATE INDEX reference_curation_reports_redaction_due_idx
  ON private.reference_curation_reports (text_redact_after, id)
  WHERE reporter_id IS NULL AND details IS NOT NULL AND text_redact_after IS NOT NULL;
CREATE INDEX reference_curation_intake_attempts_actor_action_idx
  ON private.reference_curation_intake_attempts (actor_user_id, action, attempted_at DESC, id);

ALTER TABLE private.reference_curation_events
  DROP CONSTRAINT reference_curation_events_action_check;
ALTER TABLE private.reference_curation_events
  ADD CONSTRAINT reference_curation_events_action_check CHECK (action IN (
    'claim', 'request_changes', 'resubmit', 'reject', 'accept', 'edit_draft',
    'publish', 'deprecate', 'supersede', 'withdraw', 'role_change',
    'submit', 'report', 'resolve_report', 'purge_candidate', 'redact_report'
  ));

CREATE FUNCTION private.reference_curation_policy_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton THEN
    RAISE EXCEPTION 'reference curation policy identity is immutable'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.attestation_text IS DISTINCT FROM OLD.attestation_text
     AND NEW.attestation_version IS NOT DISTINCT FROM OLD.attestation_version THEN
    RAISE EXCEPTION 'attestation wording changes require a new version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attestation_version IS NOT NULL THEN
    INSERT INTO private.reference_curation_attestation_versions(
      attestation_version, attestation_text
    ) VALUES (NEW.attestation_version, NEW.attestation_text)
    ON CONFLICT (attestation_version) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1
        FROM private.reference_curation_attestation_versions a
       WHERE a.attestation_version = NEW.attestation_version
         AND a.attestation_content_hash = pg_catalog.encode(
           extensions.digest(NEW.attestation_text, 'sha256'), 'hex'
         )
    ) THEN
      RAISE EXCEPTION 'attestation version is already bound to different wording'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION private.reference_curation_submission_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'submitted'
       OR NEW.row_version <> 1
       OR NEW.current_candidate_revision <> 1
       OR NEW.current_content_hash IS DISTINCT FROM NEW.initial_content_hash
       OR NEW.current_attestation_version IS DISTINCT FROM NEW.initial_attestation_version
       OR NEW.withdrawal_code IS NOT NULL
       OR NEW.withdrawn_at IS NOT NULL
       OR NEW.contributor_deleted_at IS NOT NULL
       OR NEW.candidate_purge_after IS NOT NULL THEN
      RAISE EXCEPTION 'a reference submission must begin at candidate revision one'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.initial_work_revision IS DISTINCT FROM OLD.initial_work_revision
     OR NEW.initial_treatment_revision IS DISTINCT FROM OLD.initial_treatment_revision
     OR NEW.initial_measurement_set_revision IS DISTINCT FROM OLD.initial_measurement_set_revision
     OR NEW.initial_content_hash IS DISTINCT FROM OLD.initial_content_hash
     OR NEW.initial_attestation_version IS DISTINCT FROM OLD.initial_attestation_version
     OR NEW.prior_submission_id IS DISTINCT FROM OLD.prior_submission_id THEN
    RAISE EXCEPTION 'submission identity and initial evidence are immutable'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.contributor_id IS DISTINCT FROM OLD.contributor_id AND NEW.contributor_id IS NOT NULL THEN
    RAISE EXCEPTION 'submission contributor attribution may only be anonymized'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.source_measurement_set_id IS DISTINCT FROM OLD.source_measurement_set_id
     AND NEW.source_measurement_set_id IS NOT NULL THEN
    RAISE EXCEPTION 'submission source pointer may only be removed'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'submission mutation must increment row_version exactly once'
      USING ERRCODE = '40001';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'submitted' AND NEW.status IN ('in_review', 'withdrawn'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('changes_requested', 'rejected', 'accepted', 'withdrawn'))
    OR (OLD.status = 'changes_requested' AND NEW.status IN ('submitted', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'invalid reference submission lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.current_candidate_revision IS DISTINCT FROM OLD.current_candidate_revision
     OR NEW.current_content_hash IS DISTINCT FROM OLD.current_content_hash
     OR NEW.current_attestation_version IS DISTINCT FROM OLD.current_attestation_version THEN
    IF OLD.status <> 'changes_requested'
       OR NEW.status <> 'submitted'
       OR NEW.current_candidate_revision <> OLD.current_candidate_revision + 1 THEN
      RAISE EXCEPTION 'candidate head may advance only on append-only resubmission'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION private.reference_curation_report_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open'
       OR NEW.row_version <> 1
       OR NEW.reporter_deleted_at IS NOT NULL
       OR NEW.text_redact_after IS NOT NULL
       OR NEW.redacted_at IS NOT NULL THEN
      RAISE EXCEPTION 'a reference report must begin open at row version one'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.curated_measurement_set_id IS DISTINCT FROM OLD.curated_measurement_set_id
     OR NEW.bundle_revision IS DISTINCT FROM OLD.bundle_revision
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code THEN
    RAISE EXCEPTION 'report identity is immutable'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.reporter_id IS DISTINCT FROM OLD.reporter_id AND NEW.reporter_id IS NOT NULL THEN
    RAISE EXCEPTION 'reporter attribution may only be anonymized'
      USING ERRCODE = '25006';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'report mutation must increment row_version exactly once'
      USING ERRCODE = '40001';
  END IF;
  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'open' AND NEW.status IN ('resolved', 'dismissed'))
  ) THEN
    RAISE EXCEPTION 'invalid reference report lifecycle transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.details IS DISTINCT FROM OLD.details
     AND NOT (
       NEW.details IS NULL
       AND (
         (OLD.reporter_id IS NOT NULL AND NEW.reporter_id IS NULL)
         OR (
           OLD.reporter_id IS NULL AND NEW.reporter_id IS NULL
           AND OLD.text_redact_after IS NOT NULL
           AND OLD.text_redact_after <= pg_catalog.clock_timestamp()
         )
       )
     ) THEN
    RAISE EXCEPTION 'report text is immutable except account-deletion redaction'
      USING ERRCODE = '25006';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$$;

CREATE FUNCTION private.reference_curation_next_candidate_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_previous integer;
BEGIN
  IF NEW.candidate_json IS NULL
     OR NEW.content_hash IS DISTINCT FROM pg_catalog.encode(
       extensions.digest(NEW.candidate_json::text, 'sha256'), 'hex'
     ) THEN
    RAISE EXCEPTION 'candidate content hash does not match immutable payload'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM private.reference_curation_submissions s
   WHERE s.id = NEW.submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown reference curation submission'
      USING ERRCODE = '23503';
  END IF;
  SELECT COALESCE(max(v.candidate_revision), 0) INTO v_previous
    FROM private.reference_curation_submission_versions v
   WHERE v.submission_id = NEW.submission_id;
  IF NEW.candidate_revision <> v_previous + 1 THEN
    RAISE EXCEPTION 'candidate revision must advance exactly once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION private.reference_curation_submission_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_submission private.reference_curation_submissions%ROWTYPE;
  v_initial private.reference_curation_submission_versions%ROWTYPE;
  v_current private.reference_curation_submission_versions%ROWTYPE;
  v_max_revision integer;
  v_submission_id uuid := coalesce(
    pg_catalog.to_jsonb(NEW)->>'id',
    pg_catalog.to_jsonb(NEW)->>'submission_id'
  )::uuid;
BEGIN
  SELECT * INTO v_submission
    FROM private.reference_curation_submissions s WHERE s.id = v_submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission consistency check lost its parent'
      USING ERRCODE = '23503';
  END IF;
  SELECT * INTO v_initial
    FROM private.reference_curation_submission_versions v
   WHERE v.submission_id = v_submission_id AND v.candidate_revision = 1;
  SELECT * INTO v_current
    FROM private.reference_curation_submission_versions v
   WHERE v.submission_id = v_submission_id
     AND v.candidate_revision = v_submission.current_candidate_revision;
  SELECT max(v.candidate_revision) INTO v_max_revision
    FROM private.reference_curation_submission_versions v
   WHERE v.submission_id = v_submission_id;
  IF v_initial.submission_id IS NULL OR v_current.submission_id IS NULL
     OR v_max_revision IS DISTINCT FROM v_submission.current_candidate_revision
     OR v_initial.source_work_revision IS DISTINCT FROM v_submission.initial_work_revision
     OR v_initial.source_treatment_revision IS DISTINCT FROM v_submission.initial_treatment_revision
     OR v_initial.source_measurement_set_revision IS DISTINCT FROM v_submission.initial_measurement_set_revision
     OR v_initial.content_hash IS DISTINCT FROM v_submission.initial_content_hash
     OR v_initial.attestation_version IS DISTINCT FROM v_submission.initial_attestation_version
     OR v_current.content_hash IS DISTINCT FROM v_submission.current_content_hash
     OR v_current.attestation_version IS DISTINCT FROM v_submission.current_attestation_version THEN
    RAISE EXCEPTION 'submission head and immutable candidate evidence disagree'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION private.reference_curation_version_retention_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.candidate_json IS NOT NULL
     AND NEW.candidate_json IS NULL
     AND OLD.candidate_purged_at IS NULL
     AND NEW.candidate_purged_at IS NOT NULL
     AND (pg_catalog.to_jsonb(NEW) - ARRAY['candidate_json', 'candidate_purged_at'])
         = (pg_catalog.to_jsonb(OLD) - ARRAY['candidate_json', 'candidate_purged_at'])
     AND EXISTS (
       SELECT 1 FROM private.reference_curation_submissions s
        WHERE s.id = OLD.submission_id
          AND s.contributor_id IS NULL
          AND s.status <> 'accepted'
          AND s.candidate_purge_after IS NOT NULL
          AND s.candidate_purge_after <= pg_catalog.clock_timestamp()
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reference curation candidate versions are append-only'
    USING ERRCODE = '25006';
END
$$;

CREATE FUNCTION private.reference_curation_project_agents(p_agents jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_agent jsonb;
  v_projected jsonb := '[]'::jsonb;
  v_item jsonb;
  v_family text;
  v_given text;
  v_literal text;
BEGIN
  IF p_agents IS NULL OR pg_catalog.jsonb_typeof(p_agents) <> 'array'
     OR pg_catalog.jsonb_array_length(p_agents) > 256 THEN
    RETURN NULL;
  END IF;
  FOR v_agent IN SELECT value FROM pg_catalog.jsonb_array_elements(p_agents) LOOP
    v_item := '{}'::jsonb;
    IF pg_catalog.jsonb_typeof(v_agent) = 'string' THEN
      v_family := pg_catalog.btrim(v_agent #>> '{}');
      IF v_family <> '' THEN
        IF pg_catalog.char_length(v_family) > 1024 THEN RETURN NULL; END IF;
        v_projected := v_projected || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('family', v_family)
        );
      END IF;
      CONTINUE;
    END IF;
    IF pg_catalog.jsonb_typeof(v_agent) <> 'object' THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(v_agent) f
       WHERE f.key = ANY(ARRAY['family', 'given', 'literal'])
         AND pg_catalog.jsonb_typeof(f.value) NOT IN ('string', 'null')
    ) THEN
      RETURN NULL;
    END IF;
    v_family := pg_catalog.btrim(coalesce(v_agent->>'family', ''));
    v_given := pg_catalog.btrim(coalesce(v_agent->>'given', ''));
    v_literal := pg_catalog.btrim(coalesce(v_agent->>'literal', ''));
    IF pg_catalog.char_length(v_family) > 1024
       OR pg_catalog.char_length(v_given) > 1024
       OR pg_catalog.char_length(v_literal) > 1024 THEN
      RETURN NULL;
    END IF;
    IF v_family <> '' THEN v_item := v_item || pg_catalog.jsonb_build_object('family', v_family); END IF;
    IF v_given <> '' THEN v_item := v_item || pg_catalog.jsonb_build_object('given', v_given); END IF;
    IF v_literal <> '' THEN v_item := v_item || pg_catalog.jsonb_build_object('literal', v_literal); END IF;
    IF v_item <> '{}'::jsonb THEN
      v_projected := v_projected || pg_catalog.jsonb_build_array(v_item);
    END IF;
  END LOOP;
  RETURN v_projected;
END
$$;

CREATE FUNCTION private.reference_curation_agents_valid(p_agents jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_agents IS NOT NULL
    AND private.reference_curation_project_agents(p_agents) IS NOT NULL
    AND p_agents = private.reference_curation_project_agents(p_agents)
$$;

CREATE FUNCTION private.reference_curation_project_raw_points(p_points jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_point jsonb;
  v_projected jsonb := '[]'::jsonb;
  v_item jsonb;
  v_length jsonb;
  v_width jsonb;
BEGIN
  IF p_points IS NULL OR pg_catalog.jsonb_typeof(p_points) = 'null' THEN
    RETURN p_points;
  END IF;
  IF pg_catalog.jsonb_typeof(p_points) <> 'array'
     OR pg_catalog.jsonb_array_length(p_points) > 10000 THEN
    RETURN NULL;
  END IF;
  FOR v_point IN SELECT value FROM pg_catalog.jsonb_array_elements(p_points) LOOP
    IF pg_catalog.jsonb_typeof(v_point) = 'number' THEN
      v_projected := v_projected || pg_catalog.jsonb_build_array(v_point);
      CONTINUE;
    END IF;
    IF pg_catalog.jsonb_typeof(v_point) <> 'object' THEN RETURN NULL; END IF;
    v_length := CASE
      WHEN pg_catalog.jsonb_typeof(v_point->'length') = 'number' THEN v_point->'length'
      WHEN pg_catalog.jsonb_typeof(v_point->'l') = 'number' THEN v_point->'l'
      ELSE NULL
    END;
    v_width := CASE
      WHEN pg_catalog.jsonb_typeof(v_point->'width') = 'number' THEN v_point->'width'
      WHEN pg_catalog.jsonb_typeof(v_point->'w') = 'number' THEN v_point->'w'
      ELSE NULL
    END;
    IF v_length IS NULL AND v_width IS NULL THEN RETURN NULL; END IF;
    v_item := '{}'::jsonb;
    IF v_length IS NOT NULL THEN
      v_item := v_item || pg_catalog.jsonb_build_object('length', v_length);
    END IF;
    IF v_width IS NOT NULL THEN
      v_item := v_item || pg_catalog.jsonb_build_object('width', v_width);
    END IF;
    v_projected := v_projected || pg_catalog.jsonb_build_array(v_item);
  END LOOP;
  RETURN v_projected;
END
$$;

CREATE FUNCTION private.reference_curation_raw_points_valid(p_points jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_points IS NULL
    OR pg_catalog.jsonb_typeof(p_points) = 'null'
    OR (
      private.reference_curation_project_raw_points(p_points) IS NOT NULL
      AND p_points = private.reference_curation_project_raw_points(p_points)
    )
$$;

ALTER TABLE private.reference_curation_submission_versions
  ADD CONSTRAINT reference_curation_candidate_nested_values_check CHECK (
    candidate_json IS NULL OR (
      candidate_json->'work'->>'type' IN ('book', 'article', 'chapter', 'website', 'dataset', 'other')
      AND private.reference_curation_agents_valid(candidate_json->'work'->'authors')
      AND private.reference_curation_agents_valid(candidate_json->'work'->'editors')
      AND nullif(btrim(candidate_json->'work'->>'title'), '') IS NOT NULL
      AND nullif(btrim(candidate_json->'work'->>'short_label'), '') IS NOT NULL
      AND (
        jsonb_typeof(candidate_json->'work'->'year') = 'null'
        OR (
          jsonb_typeof(candidate_json->'work'->'year') = 'number'
          AND (candidate_json->'work'->>'year')::numeric
              = trunc((candidate_json->'work'->>'year')::numeric)
          AND (candidate_json->'work'->>'year')::integer BETWEEN 1 AND 9999
        )
      )
      AND (
        jsonb_typeof(candidate_json->'work'->'doi') = 'null'
        OR nullif(btrim(candidate_json->'work'->>'doi'), '') IS NOT NULL
      )
      AND (
        jsonb_typeof(candidate_json->'work'->'isbn') = 'null'
        OR nullif(btrim(candidate_json->'work'->>'isbn'), '') IS NOT NULL
      )
      AND nullif(btrim(candidate_json->'treatment'->>'name_as_published'), '') IS NOT NULL
      AND candidate_json->'measurement_set'->>'character' = 'spore_size'
      AND candidate_json->'measurement_set'->>'data_kind'
          IN ('range', 'summary', 'raw_points', 'parmasto')
      AND private.reference_curation_raw_points_valid(
        candidate_json->'measurement_set'->'raw_points'
      )
    )
  );

CREATE FUNCTION private.reference_curation_consume_attempt(
  p_actor uuid,
  p_action text,
  p_window interval,
  p_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_window IS NULL OR p_window <= interval '0 seconds'
     OR p_limit IS NULL OR p_limit <= 0
     OR p_action NOT IN ('submission', 'report') THEN
    RETURN false;
  END IF;
  DELETE FROM private.reference_curation_intake_attempts a
   WHERE a.actor_user_id = p_actor
     AND a.action = p_action
     AND a.attempted_at < pg_catalog.clock_timestamp() - p_window;
  IF (SELECT count(*) FROM private.reference_curation_intake_attempts a
       WHERE a.actor_user_id = p_actor
         AND a.action = p_action
         AND a.attempted_at >= pg_catalog.clock_timestamp() - p_window) >= p_limit THEN
    RETURN false;
  END IF;
  INSERT INTO private.reference_curation_intake_attempts(actor_user_id, action)
  VALUES (p_actor, p_action);
  RETURN true;
END
$$;

CREATE FUNCTION private.apply_reference_curation_retention()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reference_curation_retention', 7301)
  );
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, outcome, reason,
    before_content_hash, after_content_hash
  )
  SELECT NULL, 'purge_candidate', 'submission', s.id, 'succeeded',
         'retention_expired', s.current_content_hash, s.current_content_hash
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id IS NULL
     AND s.status <> 'accepted'
     AND s.candidate_purge_after IS NOT NULL
     AND s.candidate_purge_after <= v_now
     AND EXISTS (
       SELECT 1 FROM private.reference_curation_submission_versions v
        WHERE v.submission_id = s.id AND v.candidate_json IS NOT NULL
     );
  UPDATE private.reference_curation_submission_versions v
     SET candidate_json = NULL, candidate_purged_at = v_now
    FROM private.reference_curation_submissions s
   WHERE s.id = v.submission_id
     AND s.contributor_id IS NULL
     AND s.status <> 'accepted'
     AND s.candidate_purge_after IS NOT NULL
     AND s.candidate_purge_after <= v_now
     AND v.candidate_json IS NOT NULL;
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, outcome, reason
  )
  SELECT NULL, 'redact_report', 'report', r.id, 'succeeded', 'retention_expired'
    FROM private.reference_curation_reports r
   WHERE r.reporter_id IS NULL
     AND r.details IS NOT NULL
     AND r.text_redact_after IS NOT NULL
     AND r.text_redact_after <= v_now;
  UPDATE private.reference_curation_reports r
     SET details = NULL, redacted_at = v_now, row_version = r.row_version + 1
   WHERE r.reporter_id IS NULL
     AND r.details IS NOT NULL
     AND r.text_redact_after IS NOT NULL
     AND r.text_redact_after <= v_now;
END
$$;

CREATE TRIGGER reference_curation_policy_guard_trg
  BEFORE UPDATE ON private.reference_curation_intake_policy
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_policy_guard();
CREATE TRIGGER reference_curation_attestation_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON private.reference_curation_attestation_versions
  FOR EACH ROW EXECUTE FUNCTION private.curated_reject_all_changes();
CREATE TRIGGER reference_curation_submissions_guard_trg
  BEFORE INSERT OR UPDATE ON private.reference_curation_submissions
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_submission_guard();
CREATE TRIGGER reference_curation_submission_versions_revision_trg
  BEFORE INSERT ON private.reference_curation_submission_versions
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_next_candidate_revision();
CREATE TRIGGER reference_curation_submission_versions_immutable_trg
  BEFORE UPDATE OR DELETE ON private.reference_curation_submission_versions
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_version_retention_guard();
CREATE TRIGGER reference_curation_reports_guard_trg
  BEFORE INSERT OR UPDATE ON private.reference_curation_reports
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_report_guard();
CREATE CONSTRAINT TRIGGER reference_curation_submissions_consistency_trg
  AFTER INSERT OR UPDATE ON private.reference_curation_submissions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_submission_consistency();
CREATE CONSTRAINT TRIGGER reference_curation_versions_consistency_trg
  AFTER INSERT ON private.reference_curation_submission_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.reference_curation_submission_consistency();

CREATE FUNCTION private.reference_curation_result(p_status text, p_kind text, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT CASE p_kind
    WHEN 'submission' THEN pg_catalog.jsonb_build_object(
      'status', p_status,
      'submission', (
        SELECT pg_catalog.jsonb_build_object(
          'id', s.id,
          'status', s.status,
          'candidate_revision', s.current_candidate_revision,
          'content_hash', s.current_content_hash,
          'attestation_version', s.current_attestation_version,
          'row_version', s.row_version,
          'created_at', s.created_at,
          'updated_at', s.updated_at
        )
        FROM private.reference_curation_submissions s WHERE s.id = p_id
      )
    )
    WHEN 'report' THEN pg_catalog.jsonb_build_object(
      'status', p_status,
      'report', (
        SELECT pg_catalog.jsonb_build_object(
          'id', r.id,
          'status', r.status,
          'row_version', r.row_version,
          'created_at', r.created_at
        )
        FROM private.reference_curation_reports r WHERE r.id = p_id
      )
    )
    ELSE pg_catalog.jsonb_build_object('status', p_status)
  END
$$;

CREATE FUNCTION private.reference_curation_capture_candidate(
  p_owner uuid,
  p_source_measurement_set_id uuid,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_work public.reference_works%ROWTYPE;
  v_treatment public.reference_taxon_treatments%ROWTYPE;
  v_set public.reference_measurement_sets%ROWTYPE;
  v_candidate jsonb;
  v_authors jsonb;
  v_editors jsonb;
  v_raw_points jsonb;
BEGIN
  SELECT * INTO v_set
    FROM public.reference_measurement_sets m
   WHERE m.user_id = p_owner
     AND m.id = p_source_measurement_set_id
     AND m.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_not_found_or_stale');
  END IF;
  SELECT * INTO v_treatment
    FROM public.reference_taxon_treatments t
   WHERE t.user_id = p_owner
     AND t.id = v_set.taxon_treatment_id
     AND t.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_not_found_or_stale');
  END IF;
  SELECT * INTO v_work
    FROM public.reference_works w
   WHERE w.user_id = p_owner
     AND w.id = v_treatment.reference_work_id
     AND w.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND
     OR v_work.revision IS DISTINCT FROM p_expected_work_revision
     OR v_treatment.revision IS DISTINCT FROM p_expected_treatment_revision
     OR v_set.revision IS DISTINCT FROM p_expected_measurement_set_revision THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_not_found_or_stale');
  END IF;

  v_authors := private.reference_curation_project_agents(v_work.authors_json);
  v_editors := private.reference_curation_project_agents(v_work.editors_json);
  v_raw_points := private.reference_curation_project_raw_points(v_set.raw_points_json);

  IF char_length(v_work.title) > 2048
     OR btrim(v_work.title) = ''
     OR char_length(v_work.short_label) > 512
     OR btrim(v_work.short_label) = ''
     OR char_length(v_work.container_title) > 2048
     OR (v_work.year IS NOT NULL AND (v_work.year < 1 OR v_work.year > 9999))
     OR char_length(v_work.edition) > 256
     OR char_length(v_work.publisher) > 1024
     OR char_length(v_work.place) > 1024
     OR char_length(v_work.volume) > 128
     OR char_length(v_work.issue) > 128
     OR char_length(v_work.pages) > 256
     OR char_length(v_work.doi) > 255
     OR (v_work.doi IS NOT NULL AND btrim(v_work.doi) = '')
     OR char_length(v_work.isbn) > 64
     OR (v_work.isbn IS NOT NULL AND btrim(v_work.isbn) = '')
     OR char_length(v_work.url) > 2048
     OR (v_work.url IS NOT NULL AND v_work.url !~* '^https?://')
     OR char_length(v_work.language) > 64
     OR char_length(v_work.citation_override) > 8192
     OR pg_catalog.octet_length(v_work.authors_json::text) > 65536
     OR pg_catalog.octet_length(v_work.editors_json::text) > 65536
     OR v_authors IS NULL
     OR v_editors IS NULL
     OR char_length(v_treatment.name_as_published) > 1024
     OR char_length(v_treatment.locator_text) > 1024
     OR char_length(v_set.raw_text) > 8192
     OR char_length(v_set.mount_medium) > 1024
     OR char_length(v_set.stain) > 1024
     OR char_length(v_set.preparation) > 2048
     OR char_length(v_set.measurement_method) > 2048
     OR pg_catalog.octet_length(v_set.raw_points_json::text) > 65536
     OR (v_set.raw_points_json IS NOT NULL AND v_raw_points IS NULL)
     OR v_set.length_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_core_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_core_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_core_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_core_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.q_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.q_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.q_mean::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_mean::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_mean::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_out_of_bounds');
  END IF;

  v_candidate := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'work', pg_catalog.jsonb_build_object(
      'type', v_work.type,
      'authors', v_authors,
      'editors', v_editors,
      'title', v_work.title,
      'container_title', v_work.container_title,
      'year', v_work.year,
      'edition', v_work.edition,
      'publisher', v_work.publisher,
      'place', v_work.place,
      'volume', v_work.volume,
      'issue', v_work.issue,
      'pages', v_work.pages,
      'doi', v_work.doi,
      'isbn', v_work.isbn,
      'url', v_work.url,
      'language', v_work.language,
      'short_label', v_work.short_label,
      'citation_override', v_work.citation_override
    ),
    'treatment', pg_catalog.jsonb_build_object(
      'name_as_published', v_treatment.name_as_published,
      'page_from', v_treatment.page_from,
      'page_to', v_treatment.page_to,
      'locator_text', v_treatment.locator_text
    ),
    'measurement_set', pg_catalog.jsonb_build_object(
      'character', v_set.character,
      'raw_text', v_set.raw_text,
      'data_kind', v_set.data_kind,
      'length_min', v_set.length_min,
      'length_core_min', v_set.length_core_min,
      'length_core_max', v_set.length_core_max,
      'length_max', v_set.length_max,
      'width_min', v_set.width_min,
      'width_core_min', v_set.width_core_min,
      'width_core_max', v_set.width_core_max,
      'width_max', v_set.width_max,
      'q_min', v_set.q_min,
      'q_max', v_set.q_max,
      'q_mean', v_set.q_mean,
      'length_mean', v_set.length_mean,
      'width_mean', v_set.width_mean,
      'sample_size', v_set.sample_size,
      'specimen_count', v_set.specimen_count,
      'mount_medium', v_set.mount_medium,
      'stain', v_set.stain,
      'preparation', v_set.preparation,
      'measurement_method', v_set.measurement_method,
      'raw_points', v_raw_points
    )
  );
  IF pg_catalog.octet_length(v_candidate::text) > 65536 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_out_of_bounds');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'ok', 'candidate', v_candidate);
END
$$;

CREATE FUNCTION public.submit_private_reference_for_curation(
  p_source_measurement_set_id uuid,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer,
  p_attestation_version text,
  p_rights_confirmed boolean,
  p_curation_consent_confirmed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_policy private.reference_curation_intake_policy%ROWTYPE;
  v_capture jsonb;
  v_candidate jsonb;
  v_hash text;
  v_submission_id uuid;
  v_prior_id uuid;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = v_owner) THEN
    RETURN private.reference_curation_result('account_deleting', NULL, NULL);
  END IF;
  PERFORM 1 FROM public.profiles p
   WHERE p.id = v_owner AND p.is_banned IS FALSE FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('account_unavailable', NULL, NULL);
  END IF;

  -- A lost-response retry is recognized from the immutable source revision
  -- tuple before current policy or source state can reject it. The Stage 3
  -- mutation contract makes that revision tuple the server-read graph
  -- identity; the stored candidate supplies its content hash.
  SELECT s.id INTO v_submission_id
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id = v_owner
     AND s.source_measurement_set_id = p_source_measurement_set_id
     AND s.initial_work_revision = p_expected_work_revision
     AND s.initial_treatment_revision = p_expected_treatment_revision
     AND s.initial_measurement_set_revision = p_expected_measurement_set_revision
     AND s.initial_attestation_version = p_attestation_version
   ORDER BY s.created_at DESC, s.id DESC
   LIMIT 1;
  IF FOUND THEN
    RETURN private.reference_curation_result('no_change', 'submission', v_submission_id);
  END IF;

  SELECT * INTO v_policy FROM private.reference_curation_intake_policy p
   WHERE p.singleton FOR SHARE;
  IF NOT FOUND OR NOT v_policy.submissions_enabled THEN
    RETURN private.reference_curation_result('intake_disabled', NULL, NULL);
  END IF;
  IF v_policy.attestation_version IS NULL OR v_policy.attestation_text IS NULL
     OR v_policy.submission_rate_window IS NULL OR v_policy.submission_rate_limit IS NULL
     OR v_policy.unaccepted_submission_retention IS NULL THEN
    RETURN private.reference_curation_result('policy_not_configured', NULL, NULL);
  END IF;
  IF NOT private.reference_curation_consume_attempt(
    v_owner, 'submission', v_policy.submission_rate_window, v_policy.submission_rate_limit
  ) THEN
    RETURN private.reference_curation_result('rate_limited', NULL, NULL);
  END IF;
  IF p_attestation_version IS DISTINCT FROM v_policy.attestation_version
     OR p_rights_confirmed IS NOT TRUE
     OR p_curation_consent_confirmed IS NOT TRUE THEN
    RETURN private.reference_curation_result('attestation_required', NULL, NULL);
  END IF;

  v_capture := private.reference_curation_capture_candidate(
    v_owner, p_source_measurement_set_id, p_expected_work_revision,
    p_expected_treatment_revision, p_expected_measurement_set_revision
  );
  IF v_capture->>'status' <> 'ok' THEN
    RETURN private.reference_curation_result(v_capture->>'status', NULL, NULL);
  END IF;
  v_candidate := v_capture->'candidate';
  v_hash := pg_catalog.encode(extensions.digest(v_candidate::text, 'sha256'), 'hex');

  SELECT s.id INTO v_submission_id
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id = v_owner
     AND s.source_measurement_set_id = p_source_measurement_set_id
     AND s.status IN ('rejected', 'withdrawn')
     AND s.current_content_hash = v_hash
     AND s.current_attestation_version = p_attestation_version
   ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
  IF FOUND THEN
    RETURN private.reference_curation_result('no_change', 'submission', v_submission_id);
  END IF;
  SELECT s.id INTO v_submission_id
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id = v_owner
     AND s.source_measurement_set_id = p_source_measurement_set_id
     AND s.status = 'accepted'
   ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
  IF FOUND THEN
    RETURN private.reference_curation_result('already_accepted', 'submission', v_submission_id);
  END IF;
  SELECT s.id INTO v_submission_id
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id = v_owner
     AND s.source_measurement_set_id = p_source_measurement_set_id
     AND s.status IN ('submitted', 'in_review', 'changes_requested')
   LIMIT 1;
  IF FOUND THEN
    RETURN private.reference_curation_result('active_submission_exists', 'submission', v_submission_id);
  END IF;
  SELECT s.id INTO v_prior_id
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id = v_owner
     AND s.source_measurement_set_id = p_source_measurement_set_id
     AND s.status IN ('rejected', 'withdrawn')
   ORDER BY s.created_at DESC, s.id DESC LIMIT 1;
  v_submission_id := gen_random_uuid();
  INSERT INTO private.reference_curation_submissions (
    id, contributor_id, source_measurement_set_id,
    initial_work_revision, initial_treatment_revision, initial_measurement_set_revision,
    initial_content_hash, initial_attestation_version, status,
    current_candidate_revision, current_content_hash, current_attestation_version,
    prior_submission_id
  ) VALUES (
    v_submission_id, v_owner, p_source_measurement_set_id,
    p_expected_work_revision, p_expected_treatment_revision, p_expected_measurement_set_revision,
    v_hash, p_attestation_version, 'submitted', 1, v_hash, p_attestation_version,
    v_prior_id
  );
  INSERT INTO private.reference_curation_submission_versions (
    submission_id, candidate_revision, candidate_schema_version, candidate_json,
    content_hash, source_work_revision, source_treatment_revision,
    source_measurement_set_revision, attestation_version, attestation_content_hash,
    rights_confirmed, curation_consent_confirmed
  ) VALUES (
    v_submission_id, 1, 1, v_candidate, v_hash,
    p_expected_work_revision, p_expected_treatment_revision,
    p_expected_measurement_set_revision, p_attestation_version,
    v_policy.attestation_content_hash, true, true
  );
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, outcome, reason, after_content_hash
  ) VALUES (v_owner, 'submit', 'submission', v_submission_id, 'succeeded',
    'owner_submission', v_hash);
  RETURN private.reference_curation_result('created', 'submission', v_submission_id);
END
$$;

CREATE FUNCTION public.resubmit_private_reference_for_curation(
  p_submission_id uuid,
  p_expected_row_version bigint,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer,
  p_attestation_version text,
  p_rights_confirmed boolean,
  p_curation_consent_confirmed boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_policy private.reference_curation_intake_policy%ROWTYPE;
  v_submission private.reference_curation_submissions%ROWTYPE;
  v_current_version private.reference_curation_submission_versions%ROWTYPE;
  v_capture jsonb;
  v_candidate jsonb;
  v_hash text;
  v_next_revision integer;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RETURN private.reference_curation_result('invalid_payload', NULL, NULL);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = v_owner) THEN
    RETURN private.reference_curation_result('account_deleting', NULL, NULL);
  END IF;
  PERFORM 1 FROM public.profiles p
   WHERE p.id = v_owner AND p.is_banned IS FALSE FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('account_unavailable', NULL, NULL);
  END IF;
  SELECT * INTO v_submission
    FROM private.reference_curation_submissions s
   WHERE s.id = p_submission_id AND s.contributor_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('not_found', NULL, NULL);
  END IF;
  SELECT * INTO v_current_version
    FROM private.reference_curation_submission_versions v
   WHERE v.submission_id = v_submission.id
     AND v.candidate_revision = v_submission.current_candidate_revision;
  IF v_submission.current_candidate_revision > 1
     AND v_current_version.expected_submission_row_version = p_expected_row_version
     AND v_current_version.source_work_revision = p_expected_work_revision
     AND v_current_version.source_treatment_revision = p_expected_treatment_revision
     AND v_current_version.source_measurement_set_revision = p_expected_measurement_set_revision
     AND v_current_version.attestation_version = p_attestation_version THEN
    RETURN private.reference_curation_result('no_change', 'submission', v_submission.id);
  END IF;

  SELECT * INTO v_policy FROM private.reference_curation_intake_policy p
   WHERE p.singleton FOR SHARE;
  IF NOT FOUND OR NOT v_policy.submissions_enabled THEN
    RETURN private.reference_curation_result('intake_disabled', NULL, NULL);
  END IF;
  IF NOT private.reference_curation_consume_attempt(
    v_owner, 'submission', v_policy.submission_rate_window, v_policy.submission_rate_limit
  ) THEN
    RETURN private.reference_curation_result('rate_limited', NULL, NULL);
  END IF;
  IF p_attestation_version IS DISTINCT FROM v_policy.attestation_version
     OR p_rights_confirmed IS NOT TRUE
     OR p_curation_consent_confirmed IS NOT TRUE THEN
    RETURN private.reference_curation_result('attestation_required', NULL, NULL);
  END IF;
  v_capture := private.reference_curation_capture_candidate(
    v_owner, v_submission.source_measurement_set_id, p_expected_work_revision,
    p_expected_treatment_revision, p_expected_measurement_set_revision
  );
  IF v_capture->>'status' <> 'ok' THEN
    RETURN private.reference_curation_result(v_capture->>'status', NULL, NULL);
  END IF;
  v_candidate := v_capture->'candidate';
  v_hash := pg_catalog.encode(extensions.digest(v_candidate::text, 'sha256'), 'hex');
  IF p_expected_row_version <> v_submission.row_version THEN
    RETURN private.reference_curation_result('conflict', 'submission', v_submission.id);
  END IF;
  IF v_submission.status <> 'changes_requested' THEN
    RETURN private.reference_curation_result('invalid_state', 'submission', v_submission.id);
  END IF;
  IF v_submission.current_content_hash = v_hash
     AND v_submission.current_attestation_version = p_attestation_version THEN
    RETURN private.reference_curation_result('unchanged_candidate', 'submission', v_submission.id);
  END IF;
  v_next_revision := v_submission.current_candidate_revision + 1;
  INSERT INTO private.reference_curation_submission_versions (
    submission_id, candidate_revision, candidate_schema_version, candidate_json,
    content_hash, source_work_revision, source_treatment_revision,
    source_measurement_set_revision, expected_submission_row_version,
    attestation_version, attestation_content_hash,
    rights_confirmed, curation_consent_confirmed
  ) VALUES (
    v_submission.id, v_next_revision, 1, v_candidate, v_hash,
    p_expected_work_revision, p_expected_treatment_revision,
    p_expected_measurement_set_revision, p_expected_row_version, p_attestation_version,
    v_policy.attestation_content_hash, true, true
  );
  UPDATE private.reference_curation_submissions
     SET status = 'submitted', current_candidate_revision = v_next_revision,
         current_content_hash = v_hash, current_attestation_version = p_attestation_version,
         row_version = row_version + 1
   WHERE id = v_submission.id AND row_version = p_expected_row_version;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('conflict', 'submission', v_submission.id);
  END IF;
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, outcome,
    reason, before_content_hash, after_content_hash
  ) VALUES (v_owner, 'resubmit', 'submission', v_submission.id, 'succeeded',
    'owner_resubmission', v_submission.current_content_hash, v_hash);
  RETURN private.reference_curation_result('updated', 'submission', v_submission.id);
END
$$;

CREATE FUNCTION public.withdraw_private_reference_curation_submission(
  p_submission_id uuid,
  p_expected_row_version bigint,
  p_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_submission private.reference_curation_submissions%ROWTYPE;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 1
     OR p_reason_code IS NULL OR p_reason_code NOT IN (
       'submitted_in_error', 'source_needs_revision', 'rights_uncertain', 'other'
     ) THEN
    RETURN private.reference_curation_result('invalid_payload', NULL, NULL);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = v_owner) THEN
    RETURN private.reference_curation_result('account_deleting', NULL, NULL);
  END IF;
  PERFORM 1 FROM public.profiles p
   WHERE p.id = v_owner AND p.is_banned IS FALSE FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('account_unavailable', NULL, NULL);
  END IF;
  SELECT * INTO v_submission FROM private.reference_curation_submissions s
   WHERE s.id = p_submission_id AND s.contributor_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('not_found', NULL, NULL);
  END IF;
  IF v_submission.status = 'withdrawn' THEN
    IF p_expected_row_version = v_submission.row_version - 1
       AND p_reason_code = v_submission.withdrawal_code THEN
      RETURN private.reference_curation_result('no_change', 'submission', v_submission.id);
    ELSIF p_expected_row_version = v_submission.row_version - 1 THEN
      RETURN private.reference_curation_result('idempotency_conflict', 'submission', v_submission.id);
    END IF;
    RETURN private.reference_curation_result('conflict', 'submission', v_submission.id);
  END IF;
  IF p_expected_row_version <> v_submission.row_version THEN
    RETURN private.reference_curation_result('conflict', 'submission', v_submission.id);
  END IF;
  IF v_submission.status NOT IN ('submitted', 'in_review', 'changes_requested') THEN
    RETURN private.reference_curation_result('invalid_state', 'submission', v_submission.id);
  END IF;
  UPDATE private.reference_curation_submissions
     SET status = 'withdrawn', withdrawal_code = p_reason_code,
         withdrawn_at = pg_catalog.clock_timestamp(), row_version = row_version + 1
   WHERE id = v_submission.id AND row_version = p_expected_row_version;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('conflict', 'submission', v_submission.id);
  END IF;
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, outcome, reason,
    before_content_hash, after_content_hash
  ) VALUES (v_owner, 'withdraw', 'submission', v_submission.id, 'succeeded',
    p_reason_code, v_submission.current_content_hash, v_submission.current_content_hash);
  RETURN private.reference_curation_result('updated', 'submission', v_submission.id);
END
$$;

CREATE FUNCTION public.report_curated_reference_set(
  p_curated_measurement_set_id uuid,
  p_bundle_revision integer,
  p_reason_code text,
  p_details text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reporter uuid := auth.uid();
  v_policy private.reference_curation_intake_policy%ROWTYPE;
  v_existing private.reference_curation_reports%ROWTYPE;
  v_report_id uuid;
BEGIN
  IF v_reporter IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR p_bundle_revision IS NULL OR p_bundle_revision < 1
     OR p_reason_code IS NULL
     OR p_reason_code NOT IN ('copyright', 'citation_error', 'taxon_assignment', 'measurement_error', 'duplicate', 'other')
     OR char_length(p_details) > 4000
     OR (p_reason_code = 'other' AND nullif(btrim(p_details), '') IS NULL) THEN
    RETURN private.reference_curation_result('invalid_payload', NULL, NULL);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_reporter::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = v_reporter) THEN
    RETURN private.reference_curation_result('account_deleting', NULL, NULL);
  END IF;
  PERFORM 1 FROM public.profiles p
   WHERE p.id = v_reporter AND p.is_banned IS FALSE FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.reference_curation_result('account_unavailable', NULL, NULL);
  END IF;
  SELECT * INTO v_existing FROM private.reference_curation_reports r
   WHERE r.reporter_id = v_reporter AND r.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.curated_measurement_set_id IS DISTINCT FROM p_curated_measurement_set_id
       OR v_existing.bundle_revision IS DISTINCT FROM p_bundle_revision
       OR v_existing.reason_code IS DISTINCT FROM p_reason_code
       OR v_existing.details IS DISTINCT FROM p_details THEN
      RETURN private.reference_curation_result('idempotency_conflict', 'report', v_existing.id);
    END IF;
    RETURN private.reference_curation_result('no_change', 'report', v_existing.id);
  END IF;
  SELECT * INTO v_policy FROM private.reference_curation_intake_policy p
   WHERE p.singleton FOR SHARE;
  IF NOT FOUND OR NOT v_policy.reports_enabled THEN
    RETURN private.reference_curation_result('intake_disabled', NULL, NULL);
  END IF;
  IF NOT private.reference_curation_consume_attempt(
    v_reporter, 'report', v_policy.report_rate_window, v_policy.report_rate_limit
  ) THEN
    RETURN private.reference_curation_result('rate_limited', NULL, NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM private.curated_reference_publications p
      JOIN private.curated_reference_measurement_sets s
        ON s.id = p.curated_measurement_set_id
     WHERE p.curated_measurement_set_id = p_curated_measurement_set_id
       AND p.bundle_revision = p_bundle_revision
       AND s.catalogue_status IN ('published', 'deprecated')
     FOR SHARE OF s
  ) THEN
    RETURN private.reference_curation_result('target_not_reportable', NULL, NULL);
  END IF;
  v_report_id := gen_random_uuid();
  INSERT INTO private.reference_curation_reports (
    id, reporter_id, idempotency_key, curated_measurement_set_id,
    bundle_revision, reason_code, details
  ) VALUES (
    v_report_id, v_reporter, p_idempotency_key, p_curated_measurement_set_id,
    p_bundle_revision, p_reason_code, p_details
  );
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, bundle_revision,
    outcome, reason
  ) VALUES (v_reporter, 'report', 'report', v_report_id, p_bundle_revision,
    'succeeded', p_reason_code);
  RETURN private.reference_curation_result('created', 'report', v_report_id);
END
$$;

CREATE OR REPLACE FUNCTION public.delete_reference_library_for_account(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_submission_retention interval;
  v_report_retention interval;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 7301));
  INSERT INTO private.reference_account_deletions(user_id)
  VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;

  SELECT p.unaccepted_submission_retention, p.report_text_retention
    INTO v_submission_retention, v_report_retention
    FROM private.reference_curation_intake_policy p WHERE p.singleton FOR SHARE;
  IF EXISTS (
       SELECT 1 FROM private.reference_curation_submissions s
        WHERE s.contributor_id = p_user_id AND s.status <> 'accepted'
     ) AND v_submission_retention IS NULL THEN
    RAISE EXCEPTION 'reference curation submission retention policy is not configured';
  END IF;
  IF EXISTS (
       SELECT 1 FROM private.reference_curation_reports r
        WHERE r.reporter_id = p_user_id AND r.details IS NOT NULL
     ) AND v_report_retention IS NULL THEN
    RAISE EXCEPTION 'reference curation report retention policy is not configured';
  END IF;

  DELETE FROM private.reference_curator_memberships WHERE user_id = p_user_id;
  INSERT INTO private.reference_curation_events (
    actor_user_id, action, target_type, target_id, outcome, reason,
    before_content_hash, after_content_hash
  )
  SELECT p_user_id, 'withdraw', 'submission', s.id, 'succeeded',
         'account_deleted', s.current_content_hash, s.current_content_hash
    FROM private.reference_curation_submissions s
   WHERE s.contributor_id = p_user_id
     AND s.status IN ('submitted', 'in_review', 'changes_requested');
  UPDATE private.reference_curation_submissions s
     SET status = CASE WHEN s.status IN ('submitted', 'in_review', 'changes_requested')
                       THEN 'withdrawn' ELSE s.status END,
         withdrawal_code = CASE WHEN s.status IN ('submitted', 'in_review', 'changes_requested')
                                THEN 'account_deleted' ELSE s.withdrawal_code END,
         withdrawn_at = CASE WHEN s.status IN ('submitted', 'in_review', 'changes_requested')
                             THEN v_now ELSE s.withdrawn_at END,
         contributor_deleted_at = v_now,
         candidate_purge_after = CASE WHEN s.status <> 'accepted'
                                      THEN v_now + v_submission_retention
                                      ELSE s.candidate_purge_after END,
         contributor_id = NULL,
         source_measurement_set_id = NULL,
         row_version = s.row_version + 1
   WHERE s.contributor_id = p_user_id;
  UPDATE private.reference_curation_reports r
     SET reporter_id = NULL,
         reporter_deleted_at = v_now,
         text_redact_after = CASE WHEN r.details IS NOT NULL THEN v_now + v_report_retention END,
         row_version = r.row_version + 1
   WHERE r.reporter_id = p_user_id;
  UPDATE private.reference_curation_events e
     SET actor_user_id = NULL
   WHERE e.actor_user_id = p_user_id;
  DELETE FROM private.reference_curation_intake_attempts a
   WHERE a.actor_user_id = p_user_id;
  PERFORM private.apply_reference_curation_retention();

  DELETE FROM public.observation_reference_uses WHERE user_id = p_user_id;
  DELETE FROM public.reference_measurement_sets WHERE user_id = p_user_id;
  DELETE FROM public.reference_taxon_treatments WHERE user_id = p_user_id;
  DELETE FROM public.reference_works WHERE user_id = p_user_id;
END
$$;

ALTER TABLE private.reference_curation_intake_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curation_attestation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curation_intake_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curation_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curation_submission_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_curation_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON private.reference_curation_intake_policy FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curation_attestation_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curation_intake_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curation_submissions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curation_submission_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON private.reference_curation_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON private.reference_curation_intake_policy TO service_role;
GRANT SELECT, INSERT ON private.reference_curation_attestation_versions TO service_role;
GRANT SELECT ON private.reference_curation_intake_attempts TO service_role;
GRANT SELECT, INSERT, UPDATE ON private.reference_curation_submissions TO service_role;
GRANT SELECT, INSERT ON private.reference_curation_submission_versions TO service_role;
GRANT SELECT, INSERT, UPDATE ON private.reference_curation_reports TO service_role;

ALTER FUNCTION public.submit_private_reference_for_curation(uuid, integer, integer, integer, text, boolean, boolean) OWNER TO postgres;
ALTER FUNCTION public.resubmit_private_reference_for_curation(uuid, bigint, integer, integer, integer, text, boolean, boolean) OWNER TO postgres;
ALTER FUNCTION public.withdraw_private_reference_curation_submission(uuid, bigint, text) OWNER TO postgres;
ALTER FUNCTION public.report_curated_reference_set(uuid, integer, text, text, uuid) OWNER TO postgres;
ALTER FUNCTION public.delete_reference_library_for_account(uuid) OWNER TO postgres;
ALTER FUNCTION private.apply_reference_curation_retention() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.submit_private_reference_for_curation(uuid, integer, integer, integer, text, boolean, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.resubmit_private_reference_for_curation(uuid, bigint, integer, integer, integer, text, boolean, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.withdraw_private_reference_curation_submission(uuid, bigint, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.report_curated_reference_set(uuid, integer, text, text, uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.delete_reference_library_for_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_private_reference_for_curation(uuid, integer, integer, integer, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resubmit_private_reference_for_curation(uuid, bigint, integer, integer, integer, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_private_reference_curation_submission(uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_curated_reference_set(uuid, integer, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_reference_library_for_account(uuid) TO service_role;
REVOKE ALL ON FUNCTION private.apply_reference_curation_retention() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.apply_reference_curation_retention() TO service_role;

REVOKE ALL ON FUNCTION private.reference_curation_policy_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_submission_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_report_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_next_candidate_revision() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_submission_consistency() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_version_retention_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_agents_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_project_agents(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_raw_points_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_project_raw_points(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_consume_attempt(uuid, text, interval, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_result(text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curation_capture_candidate(uuid, uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
