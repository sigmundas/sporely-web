-- Rollback of supabase/migrations/20261001213000_version_aware_public_reference_reads.sql
-- (Stage A, docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md).
-- NOT a migration: kept outside supabase/migrations so it never runs by
-- accident. Tested both ways by supabase/tests/reference_snapshot_version_rollback_test.sh.
--
-- One transaction. Restores the prior definitions verbatim:
--   * public.search_public_reference_contributions_v2 and
--     public.get_public_reference_contribution_v2 (20261001091940);
--   * public.search_public_observation_references (20261001113007) and
--     public.get_public_observation_references (20260828172243);
--   * private.reference_contribution_share_core and
--     private._taxon_identity_repair_reconcile_references (20261001113007);
--   * private.withdraw_shared_reference_contribution and the consent-event
--     reason CHECK (20261001113007), without snapshot_version_unsupported;
-- with their prior owners, REVOKEs and GRANTs, and drops the four helpers.
-- Refuses (55000) while any event carries reason snapshot_version_unsupported:
-- such a row was withdrawn by Stage A and must be decided on explicitly.
-- No data is written by the forward migration, so none is restored. A
-- caller passing p_accept_snapshot_versions fails after the rollback
-- (undefined function); every caller that omits it is unaffected.
--
-- Only safe while no automatic row of version 2 can exist (before Stage D):
-- the restored core shares version 2 automatically again.
--
-- Promotion to a real migration (only if the forward migration was deployed
-- and must be undone): copy this file unchanged to
-- supabase/migrations/<new UTC timestamp>_rollback_version_aware_public_reference_reads.sql,
-- run the rollback test against it, then deploy through the deploy tree.
-- Never edit or delete 20261001213000 itself once applied.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM private.shared_reference_consent_events
              WHERE reason = 'snapshot_version_unsupported') THEN
    RAISE EXCEPTION 'events with reason snapshot_version_unsupported exist; resolve them before rolling back'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE private.shared_reference_consent_events
  DROP CONSTRAINT shared_reference_consent_events_reason_check,
  ADD CONSTRAINT shared_reference_consent_events_reason_check
    CHECK (reason IS NULL OR reason IN (
      'owner','consent_missing','observation_not_public','use_detached',
      'source_deleted','taxon_changed','consent_scope_exceeded',
      'consent_text_revoked','account_deleted','rollback'
    ));

CREATE OR REPLACE FUNCTION private.withdraw_shared_reference_contribution(
  p_contribution_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_row private.shared_reference_contributions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN (
    'owner','consent_missing','observation_not_public','use_detached',
    'source_deleted','taxon_changed','consent_scope_exceeded',
    'consent_text_revoked','account_deleted','rollback'
  ) THEN
    RAISE EXCEPTION 'invalid shared reference withdrawal reason %', p_reason
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row
    FROM private.shared_reference_contributions c
   WHERE c.id = p_contribution_id
   FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'shared' THEN
    RETURN false;
  END IF;
  UPDATE private.shared_reference_contributions
     SET status = 'withdrawn',
         withdrawn_at = v_now,
         updated_at = v_now,
         share_basis = NULL,
         shared_first_revision = NULL,
         consented_at = NULL,
         consent_version = NULL,
         consent_locale = NULL,
         consent_client = NULL,
         consent_first_revision = NULL,
         consent_scope = NULL
   WHERE id = p_contribution_id;
  INSERT INTO private.shared_reference_consent_events(
    contribution_id, event, reason, consent_version, occurred_at
  ) VALUES (
    p_contribution_id,
    CASE WHEN p_reason = 'owner' THEN 'withdrawn_by_owner' ELSE 'withdrawn_by_system' END,
    p_reason, v_row.consent_version, v_now
  );
  RETURN true;
END
$$;

DROP FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid,integer[]);
DROP FUNCTION public.get_public_reference_contribution_v2(uuid,integer,integer[]);
DROP FUNCTION public.get_public_observation_references(bigint,integer[]);
DROP FUNCTION public.search_public_observation_references(bigint[],integer[]);

CREATE FUNCTION public.search_public_reference_contributions_v2(
  p_sporely_taxon_id integer,
  p_limit integer DEFAULT NULL,
  p_after_shared_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_policy private.shared_reference_production_policy%ROWTYPE;
  v_retry_after integer;
BEGIN
  SELECT * INTO STRICT v_policy
    FROM private.shared_reference_production_policy WHERE singleton;
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > v_policy.catalogue_max_page_size) THEN
    RAISE EXCEPTION 'limit must be between 1 and %',v_policy.catalogue_max_page_size
      USING ERRCODE='22023';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM private.search_public_reference_contributions_v2_unthrottled(
    p_sporely_taxon_id,coalesce(p_limit,v_policy.catalogue_default_page_size),
    p_after_shared_at,p_after_id
  );
END
$$;

CREATE FUNCTION public.get_public_reference_contribution_v2(
  p_contribution_id uuid,
  p_revision integer DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM private.get_public_reference_contribution_v2_unthrottled(
    p_contribution_id,p_revision
  );
END
$$;


CREATE FUNCTION public.search_public_observation_references(p_observation_ids bigint[])
RETURNS SETOF public.public_observation_references_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_observation_ids IS NULL OR pg_catalog.cardinality(p_observation_ids)=0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_observation_ids)>200 THEN
    RAISE EXCEPTION 'at most 200 observation ids may be requested'
      USING ERRCODE='22023';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT requested_id) FROM pg_catalog.unnest(p_observation_ids) requested_id)>100 THEN
    RAISE EXCEPTION 'at most 100 distinct observation ids may be requested'
      USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT DISTINCT requested_id AS id
    FROM pg_catalog.unnest(p_observation_ids) requested_id
    WHERE requested_id IS NOT NULL
  ), eligible AS (
    SELECT o.id, o.user_id
    FROM requested r
    JOIN public.observations o ON o.id=r.id
    WHERE o.visibility='public'::text
      AND NOT coalesce(o.is_draft,false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id=o.user_id AND p.is_banned=true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(),o.user_id) IS NOT TRUE
      )
  )
  SELECT e.id,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'use_id',u.id,
          'role',u.role,
          'reference_revision',u.reference_revision,
          'snapshot',sanitized.snapshot
        ) ORDER BY u.selected_at,u.id
      ) FILTER (
        WHERE u.id IS NOT NULL AND sanitized.snapshot IS NOT NULL AND served.ok
      ),
      '[]'::jsonb
    ) AS "references"
  FROM eligible e
  LEFT JOIN public.observation_reference_uses u
    ON u.observation_id=e.id AND u.user_id=e.user_id AND u.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT private.public_reference_snapshot(
      u.snapshot_json,u.reference_measurement_set_id,u.reference_revision
    ) AS snapshot
  ) sanitized ON u.id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT private.observation_reference_use_is_served(u.id) AS ok
  ) served ON u.id IS NOT NULL
  GROUP BY e.id
  ORDER BY e.id;
END
$$;


CREATE FUNCTION public.get_public_observation_references(p_observation_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT projected."references"
  FROM public.search_public_observation_references(ARRAY[p_observation_id]) projected
$$;

CREATE OR REPLACE FUNCTION private.reference_contribution_share_core(
  p_mode text,
  p_owner uuid,
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer DEFAULT NULL,
  p_expected_treatment_revision integer DEFAULT NULL,
  p_expected_measurement_set_revision integer DEFAULT NULL,
  p_consent_version integer DEFAULT NULL,
  p_locale text DEFAULT NULL,
  p_consent_client text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := p_owner;
  v_contribution private.shared_reference_contributions%ROWTYPE;
  v_found boolean;
  v_shared boolean;
  v_automatic_event boolean := false;
  v_text private.reference_share_consent_texts%ROWTYPE;
  v_src record;
  v_candidate jsonb;
  v_snapshot jsonb;
  v_envelope jsonb;
  v_hash text;
  v_revision integer;
  v_canonical_name text;
  v_scope jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_work public.reference_works%ROWTYPE;
  v_treatment public.reference_taxon_treatments%ROWTYPE;
  v_set public.reference_measurement_sets%ROWTYPE;
  v_authors jsonb;
  v_editors jsonb;
  v_raw_points jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('grant','refresh') THEN
    RAISE EXCEPTION 'invalid share mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_source_measurement_set_id IS NULL OR p_sporely_taxon_id IS NULL
     OR p_sporely_taxon_id <= 0 THEN
    RETURN private.shared_reference_contribution_result('invalid_payload');
  END IF;
  IF p_mode = 'grant' AND (
       p_expected_work_revision IS NULL OR p_expected_work_revision < 1
       OR p_expected_treatment_revision IS NULL OR p_expected_treatment_revision < 1
       OR p_expected_measurement_set_revision IS NULL OR p_expected_measurement_set_revision < 1
       OR p_consent_version IS NULL OR p_locale IS NULL
       OR (p_consent_client IS NOT NULL
           AND pg_catalog.char_length(p_consent_client) NOT BETWEEN 1 AND 128)
     ) THEN
    RETURN private.shared_reference_contribution_result('invalid_payload');
  END IF;

  -- The owner's profile row FOR KEY SHARE before the key lock, the order of
  -- the grant, the opt-out writes and a profile delete. This holds only for
  -- callers that enter the core without the key lock (the deploy refresh,
  -- share again, a direct call). The triggers and Stage 1B take the key lock
  -- before calling the core, so on those paths this row lock comes second
  -- and does not by itself rule out a wait cycle with a concurrent account
  -- deletion; it only makes the insert's foreign-key check wait-free.
  PERFORM 1 FROM public.profiles p WHERE p.id = v_owner FOR KEY SHARE;
  PERFORM private.lock_shared_reference_key(v_owner, p_source_measurement_set_id);

  IF EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = v_owner)
     OR NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id = v_owner AND p.is_banned IS FALSE
     ) THEN
    RETURN private.shared_reference_contribution_result('account_unavailable');
  END IF;
  SELECT c.canonical_name INTO v_canonical_name
    FROM taxonomy_v3.registry_concept c
   WHERE c.sporely_taxon_id = p_sporely_taxon_id
     AND c.rank = 'species'
     AND nullif(pg_catalog.btrim(c.canonical_name), '') IS NOT NULL
     AND pg_catalog.char_length(c.canonical_name) <= 1024;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('invalid_taxon');
  END IF;

  SELECT * INTO v_contribution
    FROM private.shared_reference_contributions c
   WHERE c.owner_id = v_owner
     AND c.source_measurement_set_id = p_source_measurement_set_id
     AND c.sporely_taxon_id = p_sporely_taxon_id
   FOR UPDATE;
  v_found := FOUND;
  v_shared := v_found AND v_contribution.status = 'shared';

  -- An opted-out set never shares. A shared row of an opted-out set cannot
  -- exist (stop withdraws under the key lock); withdraw it defensively.
  IF private.reference_set_opted_out(v_owner, p_source_measurement_set_id) THEN
    IF v_shared THEN
      PERFORM private.withdraw_shared_reference_contribution(v_contribution.id, 'owner');
    END IF;
    RETURN private.shared_reference_contribution_result('opted_out');
  END IF;
  -- Moderation is set-level: while any contribution of the set is hidden, a
  -- refresh neither creates, re-shares nor adds revisions (a shared sibling
  -- stays as it is and is not served: reference_contribution_is_served
  -- checks the set too). hidden_at is never cleared.
  IF p_mode = 'refresh'
     AND private.reference_set_has_hidden_contribution(v_owner, p_source_measurement_set_id) THEN
    RETURN private.shared_reference_contribution_result('moderation_hidden');
  END IF;
  IF p_mode = 'refresh' AND v_shared AND v_contribution.share_basis = 'consented'
     AND private.reference_consent_text_revoked(
       v_contribution.consent_version, v_contribution.consent_locale
     ) THEN
    PERFORM private.withdraw_shared_reference_contribution(v_contribution.id, 'consent_text_revoked');
    RETURN private.shared_reference_contribution_result('consent_text_revoked');
  END IF;

  IF p_mode = 'grant' THEN
    SELECT * INTO v_text
      FROM private.reference_share_consent_texts ct
     WHERE ct.version = p_consent_version AND ct.locale = p_locale
       AND ct.active AND NOT ct.revoked;
    IF NOT FOUND THEN
      RETURN private.shared_reference_contribution_result('consent_text_unavailable');
    END IF;
  END IF;

  SELECT m AS set_row, t AS treatment_row, w AS work_row,
         private.reference_canonical_snapshot(v_owner, p_source_measurement_set_id) AS snapshot
    INTO v_src
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t
      ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w
      ON w.user_id = t.user_id AND w.id = t.reference_work_id
   WHERE m.user_id = v_owner AND m.id = p_source_measurement_set_id
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL;
  IF NOT FOUND OR v_src.snapshot IS NULL THEN
    IF p_mode = 'refresh' AND v_shared THEN
      PERFORM private.withdraw_shared_reference_contribution(v_contribution.id, 'source_deleted');
    END IF;
    RETURN private.shared_reference_contribution_result('source_not_found_or_stale');
  END IF;
  v_set := v_src.set_row;
  v_treatment := v_src.treatment_row;
  v_work := v_src.work_row;
  v_snapshot := v_src.snapshot;
  IF (v_snapshot->>'reference_revision')::integer IS DISTINCT FROM v_set.revision THEN
    RAISE EXCEPTION 'shared reference source read was inconsistent' USING ERRCODE = '40001';
  END IF;

  IF p_mode = 'grant' AND (
       v_work.revision <> p_expected_work_revision
       OR v_treatment.revision <> p_expected_treatment_revision
       OR v_set.revision <> p_expected_measurement_set_revision
     ) THEN
    RETURN private.shared_reference_contribution_result('revision_mismatch');
  END IF;

  IF NOT private.reference_set_has_qualifying_use(
       v_owner, p_source_measurement_set_id, p_sporely_taxon_id
     ) THEN
    IF p_mode = 'refresh' AND v_shared THEN
      PERFORM private.withdraw_unqualified_contributions(v_owner, p_source_measurement_set_id);
      RETURN private.shared_reference_contribution_result('withdrawn_unqualified');
    END IF;
    RETURN private.shared_reference_contribution_result('qualifying_use_required');
  END IF;

  v_authors := private.reference_curation_project_agents(v_work.authors_json);
  v_editors := private.reference_curation_project_agents(v_work.editors_json);
  v_raw_points := private.shared_reference_project_raw_points(v_set.raw_points_json);
  IF v_authors IS NULL OR v_editors IS NULL
     OR pg_catalog.octet_length(v_snapshot::text) > 65536
     OR pg_catalog.char_length(v_snapshot->>'short_label') > 512
     OR (v_set.raw_points_json IS NOT NULL AND v_raw_points IS NULL)
     OR nullif(pg_catalog.btrim(v_work.title),'') IS NULL
     OR pg_catalog.char_length(v_work.title) > 2048
     OR pg_catalog.char_length(v_work.container_title) > 2048
     OR (v_work.year IS NOT NULL AND (v_work.year < 1 OR v_work.year > 9999))
     OR pg_catalog.char_length(v_work.edition) > 256
     OR pg_catalog.char_length(v_work.publisher) > 1024
     OR pg_catalog.char_length(v_work.place) > 1024
     OR pg_catalog.char_length(v_work.volume) > 128
     OR pg_catalog.char_length(v_work.issue) > 128
     OR pg_catalog.char_length(v_work.pages) > 256
     OR pg_catalog.char_length(v_work.doi) > 255
     OR (v_work.doi IS NOT NULL AND v_work.doi !~* '^10\.[0-9]{4,9}/[-._;()/:a-z0-9]+$')
     OR pg_catalog.char_length(v_work.isbn) > 64
     OR pg_catalog.char_length(v_work.url) > 2048
     OR (v_work.url IS NOT NULL AND v_work.url !~* '^https?://')
     OR pg_catalog.char_length(v_work.language) > 64
     OR pg_catalog.char_length(v_work.citation_override) > 8192
     OR pg_catalog.char_length(v_set.mount_medium) > 4096
     OR pg_catalog.char_length(v_set.stain) > 4096
     OR pg_catalog.char_length(v_set.preparation) > 4096
     OR pg_catalog.char_length(v_set.measurement_method) > 4096
     OR v_set.length_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_core_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_core_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_core_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_core_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.q_min::text IN ('NaN','Infinity','-Infinity')
     OR v_set.q_max::text IN ('NaN','Infinity','-Infinity')
     OR v_set.q_mean::text IN ('NaN','Infinity','-Infinity')
     OR v_set.length_mean::text IN ('NaN','Infinity','-Infinity')
     OR v_set.width_mean::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN private.shared_reference_contribution_result('source_out_of_bounds');
  END IF;
  v_snapshot := pg_catalog.jsonb_set(
    v_snapshot,'{raw_points}',coalesce(v_raw_points,'null'::jsonb),false
  );

  -- The consent scope binds only consented rows and grants.
  v_scope := private.reference_share_snapshot_scope(v_snapshot);
  IF p_mode = 'refresh' THEN
    IF v_shared AND v_contribution.share_basis = 'consented'
       AND NOT private.reference_share_scope_within(v_scope, v_contribution.consent_scope) THEN
      PERFORM private.withdraw_shared_reference_contribution(
        v_contribution.id, 'consent_scope_exceeded'
      );
      RETURN private.shared_reference_contribution_result('consent_scope_exceeded');
    END IF;
  ELSIF NOT private.reference_share_scope_within(v_scope, v_text.scope) THEN
    RETURN private.shared_reference_contribution_result('consent_scope_exceeded');
  END IF;

  v_candidate := pg_catalog.jsonb_build_object(
    'work', pg_catalog.jsonb_build_object(
      'type',v_work.type,'authors',v_authors,'editors',v_editors,
      'title',v_work.title,'container_title',v_work.container_title,
      'year',v_work.year,'edition',v_work.edition,'publisher',v_work.publisher,
      'place',v_work.place,'volume',v_work.volume,'issue',v_work.issue,
      'pages',v_work.pages,'doi',v_work.doi,'isbn',v_work.isbn,
      'url',v_work.url,'language',v_work.language,
      'short_label',v_snapshot->>'short_label',
      'citation_override',v_work.citation_override
    )
  );
  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'taxon_id', p_sporely_taxon_id,
      'candidate', v_candidate,
      'snapshot', v_snapshot
    )::text, 'UTF8'
  ), 'sha256'), 'hex');

  IF NOT v_found THEN
    IF p_mode = 'grant' THEN
      INSERT INTO private.shared_reference_contributions(
        owner_id, source_measurement_set_id, sporely_taxon_id,
        status, current_revision, shared_at, updated_at,
        share_basis, shared_first_revision,
        consented_at, consent_version, consent_locale, consent_client,
        consent_first_revision, consent_scope
      ) VALUES (
        v_owner, p_source_measurement_set_id, p_sporely_taxon_id,
        'shared', 1, v_now, v_now, 'consented', 1,
        v_now, v_text.version, v_text.locale, p_consent_client, 1, v_scope
      ) RETURNING * INTO v_contribution;
    ELSE
      INSERT INTO private.shared_reference_contributions(
        owner_id, source_measurement_set_id, sporely_taxon_id,
        status, current_revision, shared_at, updated_at,
        share_basis, shared_first_revision
      ) VALUES (
        v_owner, p_source_measurement_set_id, p_sporely_taxon_id,
        'shared', 1, v_now, v_now, 'automatic', 1
      ) RETURNING * INTO v_contribution;
      v_automatic_event := true;
    END IF;
    v_revision := 1;
  ELSIF v_shared THEN
    IF p_mode = 'grant' THEN
      -- Consent within the current sharing period: the period is unchanged;
      -- an automatic row becomes consented from its current revision.
      UPDATE private.shared_reference_contributions
         SET share_basis = 'consented',
             consented_at = v_now, consent_version = v_text.version,
             consent_locale = v_text.locale, consent_client = p_consent_client, consent_scope = v_scope,
             consent_first_revision = coalesce(consent_first_revision, current_revision),
             updated_at = v_now
       WHERE id = v_contribution.id
       RETURNING * INTO v_contribution;
    END IF;
    IF EXISTS (
      SELECT 1 FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = v_contribution.id
         AND r.revision = v_contribution.current_revision
         AND r.content_hash = v_hash
    ) THEN
      SELECT r.envelope_json INTO v_envelope
        FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = v_contribution.id
         AND r.revision = v_contribution.current_revision;
      IF p_mode = 'grant' THEN
        INSERT INTO private.shared_reference_consent_events(
          contribution_id, event, consent_version, locale, text_sha256, occurred_at
        ) VALUES (v_contribution.id, 'granted', v_text.version, v_text.locale, v_text.text_sha256, v_now);
      END IF;
      RETURN private.shared_reference_contribution_result('no_change', v_envelope);
    END IF;
    v_revision := v_contribution.current_revision + 1;
    UPDATE private.shared_reference_contributions
       SET current_revision = v_revision, shared_at = v_now, updated_at = v_now
     WHERE id = v_contribution.id
     RETURNING * INTO v_contribution;
  ELSE
    -- A withdrawn row starts a new sharing period at a new revision, so no
    -- revision from before the withdrawal is served again. hidden_at is
    -- never cleared (and a refresh never reaches here for a hidden set).
    v_revision := v_contribution.current_revision + 1;
    IF p_mode = 'grant' THEN
      UPDATE private.shared_reference_contributions
         SET status = 'shared', current_revision = v_revision,
             shared_at = v_now, updated_at = v_now, withdrawn_at = NULL,
             share_basis = 'consented', shared_first_revision = v_revision,
             consented_at = v_now, consent_version = v_text.version,
             consent_locale = v_text.locale, consent_client = p_consent_client,
             consent_first_revision = v_revision, consent_scope = v_scope
       WHERE id = v_contribution.id
       RETURNING * INTO v_contribution;
    ELSE
      UPDATE private.shared_reference_contributions
         SET status = 'shared', current_revision = v_revision,
             shared_at = v_now, updated_at = v_now, withdrawn_at = NULL,
             share_basis = 'automatic', shared_first_revision = v_revision
       WHERE id = v_contribution.id
       RETURNING * INTO v_contribution;
      v_automatic_event := true;
    END IF;
  END IF;

  v_envelope := private.shared_reference_contribution_envelope(
    v_contribution.id, v_revision, p_sporely_taxon_id, v_canonical_name,
    v_owner, v_snapshot, v_candidate, v_now
  );
  IF v_envelope IS NULL OR pg_catalog.octet_length(v_envelope::text) > 1048576 THEN
    RAISE EXCEPTION 'shared reference contribution could not be projected'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO private.shared_reference_contribution_revisions(
    contribution_id, revision, source_work_revision,
    source_treatment_revision, source_measurement_set_revision,
    content_hash, envelope_json, created_at
  ) VALUES (
    v_contribution.id, v_revision, v_work.revision,
    v_treatment.revision, v_set.revision,
    v_hash, v_envelope, v_now
  );
  IF p_mode = 'grant' THEN
    INSERT INTO private.shared_reference_consent_events(
      contribution_id, event, consent_version, locale, text_sha256, occurred_at
    ) VALUES (v_contribution.id, 'granted', v_text.version, v_text.locale, v_text.text_sha256, v_now);
  ELSIF v_automatic_event THEN
    INSERT INTO private.shared_reference_consent_events(contribution_id, event, occurred_at)
    VALUES (v_contribution.id, 'shared_automatically', v_now);
  END IF;
  RETURN private.shared_reference_contribution_result(
    CASE WHEN v_revision = 1 THEN 'created' ELSE 'updated' END, v_envelope
  );
END
$$;


CREATE OR REPLACE FUNCTION private._taxon_identity_repair_reconcile_references(
  p_run_id bigint,
  p_observation_id bigint
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_obs record;
  v_old bigint;
  v_new bigint;
  v_set uuid;
  v_old_action text;
  v_new_action text;
  v_contribution_id uuid;
  v_result jsonb;
  v_status text;
  v_count integer := 0;
BEGIN
  SELECT o.id, o.user_id, o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id
    INTO v_obs
    FROM public.observations o
   WHERE o.id = p_observation_id;
  v_old := v_obs.resolved_sporely_taxon_id;
  v_new := v_obs.selected_sporely_taxon_id;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'observation % was not promoted; cannot reconcile references', p_observation_id;
  END IF;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN 0;
  END IF;

  FOR v_set IN
    SELECT DISTINCT u.reference_measurement_set_id
      FROM public.observation_reference_uses u
     WHERE u.user_id = v_obs.user_id AND u.observation_id = v_obs.id
       AND u.deleted_at IS NULL
     ORDER BY u.reference_measurement_set_id
  LOOP
    PERFORM private.lock_shared_reference_key(v_obs.user_id, v_set);

    IF v_old IS NULL THEN
      v_old_action := 'none';
    ELSIF private.reference_set_has_qualifying_use(v_obs.user_id, v_set, v_old::integer) THEN
      v_old_action := 'kept_by_other_use';
    ELSE
      SELECT c.id INTO v_contribution_id
        FROM private.shared_reference_contributions c
       WHERE c.owner_id = v_obs.user_id
         AND c.source_measurement_set_id = v_set
         AND c.sporely_taxon_id = v_old;
      IF NOT FOUND THEN
        v_old_action := 'none';
      ELSIF private.withdraw_shared_reference_contribution(v_contribution_id, 'taxon_changed') THEN
        v_old_action := 'withdrawn';
      ELSIF EXISTS (
        SELECT 1 FROM private.shared_reference_contributions c
         WHERE c.id = v_contribution_id AND c.status = 'shared'
      ) THEN
        RAISE EXCEPTION 'contribution for set % under old taxon % is still shared', v_set, v_old;
      ELSIF (
        SELECT e.event || ':' || e.reason
          FROM private.shared_reference_consent_events e
         WHERE e.contribution_id = v_contribution_id
           AND e.occurred_at >= pg_catalog.transaction_timestamp()
         ORDER BY e.id DESC LIMIT 1
      ) IS NOT DISTINCT FROM 'withdrawn_by_system:taxon_changed' THEN
        v_old_action := 'withdrawn';
      ELSE
        v_old_action := 'none';
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM taxonomy_v3.registry_concept rc
       WHERE rc.sporely_taxon_id = v_new AND rc.rank = 'species'
    ) THEN
      v_new_action := CASE WHEN EXISTS (
        SELECT 1 FROM public.taxonomy_v2_taxa t
         WHERE t.release_id = private._taxon_identity_repair_active_release()
           AND t.sporely_taxon_id = v_new
           AND t.taxon_rank = 'species'
      ) THEN 'not_registry_species' ELSE 'not_species' END;
    ELSIF NOT EXISTS (
      SELECT 1
        FROM public.reference_measurement_sets m
        JOIN public.reference_taxon_treatments t ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
        JOIN public.reference_works w ON w.user_id = t.user_id AND w.id = t.reference_work_id
       WHERE m.user_id = v_obs.user_id AND m.id = v_set
         AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
    ) THEN
      v_new_action := 'source_deleted';
    ELSE
      v_result := private.share_reference_contribution_for_owner(
        v_obs.user_id, v_set, v_new::integer, NULL, NULL, NULL
      );
      v_status := v_result->>'status';
      IF v_status IN ('created', 'updated', 'no_change') THEN
        IF NOT EXISTS (
          SELECT 1 FROM private.shared_reference_contributions c
           WHERE c.owner_id = v_obs.user_id AND c.source_measurement_set_id = v_set
             AND c.sporely_taxon_id = v_new AND c.status = 'shared'
             AND c.share_basis IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'refresh for set % under taxon % reported % but is not shared',
            v_set, v_new, v_status;
        END IF;
        v_new_action := 'shared';
      ELSIF v_status IN ('opted_out', 'consent_scope_exceeded', 'withdrawn_unqualified',
                         'consent_text_revoked', 'qualifying_use_required') THEN
        v_new_action := v_status;
      ELSIF v_status = 'source_not_found_or_stale' THEN
        v_new_action := 'source_deleted';
      ELSIF v_status = 'invalid_taxon' THEN
        v_new_action := CASE WHEN EXISTS (
          SELECT 1 FROM public.taxonomy_v2_taxa t
           WHERE t.release_id = private._taxon_identity_repair_active_release()
             AND t.sporely_taxon_id = v_new
             AND t.taxon_rank = 'species'
        ) THEN 'not_registry_species' ELSE 'not_species' END;
      ELSIF v_status IN ('account_unavailable', 'source_out_of_bounds', 'moderation_hidden') THEN
        v_new_action := 'not_shareable:' || v_status;
      ELSE
        RAISE EXCEPTION 'reference reconciliation for observation % set % failed: %',
          v_obs.id, v_set, coalesce(v_status, v_result::text);
      END IF;
    END IF;

    INSERT INTO private.taxon_identity_repair_reference_actions(
      run_id, observation_id, reference_measurement_set_id,
      old_sporely_taxon_id, new_sporely_taxon_id, old_contribution, new_contribution
    ) VALUES (p_run_id, v_obs.id, v_set, v_old, v_new, v_old_action, v_new_action);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;

DROP FUNCTION private.reference_public_item_for_versions(jsonb,boolean);
DROP FUNCTION private.reference_public_snapshot_project_v1(jsonb);
DROP FUNCTION private.reference_accepts_snapshot_v2(integer[]);
DROP FUNCTION private.reference_automatic_share_scope();

ALTER FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution_v2(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.search_public_observation_references(bigint[]) OWNER TO postgres;
ALTER FUNCTION public.get_public_observation_references(bigint) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_reference_contribution(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.withdraw_shared_reference_contribution(uuid,text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution_v2(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_observation_references(bigint[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_observation_references(bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reference_contribution_v2(uuid,integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_observation_references(bigint[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_observation_references(bigint) TO anon, authenticated, service_role;

COMMIT;
