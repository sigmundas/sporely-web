-- Stage 2d, order step 3 (server) of
-- docs/plans/active/2026-10-01-reference-sharing-default-on.md:
-- references on public observations are shared by default.
--
--   * share basis: share_basis ('automatic' | 'consented') and
--     shared_first_revision (first revision of the current sharing period,
--     for both bases) replace "consented_at IS NOT NULL" as the meaning of
--     "shared"; the consent CHECKs are replaced accordingly;
--   * consent-only checks (consent_text_revoked, consent_scope_exceeded)
--     apply only to 'consented' rows;
--   * event type shared_automatically; withdrawal reason rollback;
--   * private.reference_share_opt_outs: per-(owner, set) "stop sharing",
--     honoured by the core, both public reads and the deploy refresh;
--   * the refresh core creates or re-shares a contribution automatically
--     (registry species, qualifying use, no opt-out, no hidden contribution
--     for the set; hidden_at is never cleared);
--   * the observation trigger refreshes the uses of an observation that
--     becomes public, non-draft and spore-public;
--   * Stage 1B maps created to shared and records opted_out;
--   * search_public_observation_references serves every live use of a
--     live source on a public, non-draft, spore-public observation whose set
--     is not opted out and has no hidden contribution (any taxon, no content
--     proof); the roles helper derives roles from exactly those uses;
--   * new owner RPCs stop_sharing_reference_set, share_reference_set_again,
--     list_my_reference_sharing; withdraw_reference_contribution becomes a
--     wrapper (contribution -> set -> stop) with its response contract kept;
--     list_my_shared_reference_contributions is kept unchanged;
--   * backfill of opt-outs for owner withdrawals, then the deploy refresh
--     (core called directly; count-agnostic).
--
-- Does not redefine the six functions the deferred 20260914090000 redefines.

BEGIN;

LOCK TABLE public.observations,
           public.observation_reference_uses,
           public.reference_measurement_sets,
           public.reference_taxon_treatments,
           public.reference_works
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE private.reference_share_consent_texts,
           private.shared_reference_contributions,
           private.shared_reference_contribution_revisions,
           private.shared_reference_consent_events
  IN ACCESS EXCLUSIVE MODE;

-- 1. Share basis and sharing period ----------------------------------------

ALTER TABLE private.shared_reference_contributions
  ADD COLUMN share_basis text CHECK (share_basis IS NULL OR share_basis IN ('automatic','consented')),
  ADD COLUMN shared_first_revision integer CHECK (shared_first_revision IS NULL OR shared_first_revision >= 1);

-- Count-agnostic: any consented shared row (production has none) keeps its
-- consent period as its sharing period.
UPDATE private.shared_reference_contributions
   SET share_basis = 'consented', shared_first_revision = consent_first_revision
 WHERE status = 'shared' AND consented_at IS NOT NULL;

ALTER TABLE private.shared_reference_contributions
  DROP CONSTRAINT shared_reference_contributions_shared_iff_consented,
  ADD CONSTRAINT shared_reference_contributions_shared_iff_basis
    CHECK (CASE WHEN status = 'shared'
                THEN share_basis IS NOT NULL AND shared_first_revision IS NOT NULL
                     AND (share_basis = 'consented') = (consented_at IS NOT NULL)
                ELSE share_basis IS NULL AND shared_first_revision IS NULL
                     AND consented_at IS NULL
           END),
  ADD CONSTRAINT shared_reference_contributions_shared_period_bound
    CHECK (shared_first_revision IS NULL OR shared_first_revision <= current_revision);

-- 2. Events -------------------------------------------------------------------

ALTER TABLE private.shared_reference_consent_events
  DROP CONSTRAINT shared_reference_consent_events_event_check,
  DROP CONSTRAINT shared_reference_consent_events_check,
  DROP CONSTRAINT shared_reference_consent_events_reason_check,
  ADD CONSTRAINT shared_reference_consent_events_event_check
    CHECK (event IN ('granted','withdrawn_by_owner','withdrawn_by_system','shared_automatically')),
  ADD CONSTRAINT shared_reference_consent_events_check
    CHECK ((event IN ('granted','shared_automatically')) = (reason IS NULL)),
  ADD CONSTRAINT shared_reference_consent_events_reason_check
    CHECK (reason IS NULL OR reason IN (
      'owner','consent_missing','observation_not_public','use_detached',
      'source_deleted','taxon_changed','consent_scope_exceeded',
      'consent_text_revoked','account_deleted','rollback'
    )),
  ADD CONSTRAINT shared_reference_consent_events_automatic_no_consent
    CHECK (event <> 'shared_automatically'
           OR (consent_version IS NULL AND locale IS NULL AND text_sha256 IS NULL));

-- 3. Opt-outs -------------------------------------------------------------------

CREATE TABLE private.reference_share_opt_outs (
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_measurement_set_id uuid NOT NULL,
  opted_out_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (owner_id, source_measurement_set_id)
);
ALTER TABLE private.reference_share_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.reference_share_opt_outs OWNER TO postgres;
REVOKE ALL ON TABLE private.reference_share_opt_outs FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.reference_set_opted_out(p_owner uuid, p_set uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.reference_share_opt_outs o
     WHERE o.owner_id = p_owner AND o.source_measurement_set_id = p_set
  )
$$;

-- True when any contribution of (owner, set), shared or withdrawn, is hidden
-- by moderation.
CREATE FUNCTION private.reference_set_has_hidden_contribution(p_owner uuid, p_set uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.shared_reference_contributions c
     WHERE c.owner_id = p_owner AND c.source_measurement_set_id = p_set
       AND c.hidden_at IS NOT NULL
  )
$$;

-- 4. Withdrawal helper: reason rollback; clears the share basis and period ----

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

-- 5. The core -------------------------------------------------------------------
--
-- refresh: adds revisions to a shared row (either basis), withdraws, or
-- creates / re-shares a row with basis 'automatic' when there is a
-- qualifying use of a registry species, no opt-out for the set and no
-- hidden contribution of the set. A refresh never clears hidden_at and never
-- produces 'consented'. grant: unchanged (inert while no text is active),
-- except that it records basis 'consented' and refuses an opted-out set.
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

  -- Lock order: the owner's profile row FOR KEY SHARE before the key lock,
  -- as the grant, the opt-out writes and a profile delete take them, so an
  -- automatic create cannot deadlock with an account deletion.
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

-- 6. Unpublishable check: any shared row; consent checks for consented only --

CREATE OR REPLACE FUNCTION private.withdraw_contribution_if_unpublishable(
  p_owner uuid,
  p_set uuid,
  p_taxon integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_contribution private.shared_reference_contributions%ROWTYPE;
  v_src record;
  v_snapshot jsonb;
  v_raw_points jsonb;
BEGIN
  SELECT * INTO v_contribution
    FROM private.shared_reference_contributions c
   WHERE c.owner_id = p_owner AND c.source_measurement_set_id = p_set
     AND c.sporely_taxon_id = p_taxon
     AND c.status = 'shared' AND c.share_basis IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_contribution.share_basis = 'consented'
     AND private.reference_consent_text_revoked(v_contribution.consent_version, v_contribution.consent_locale) THEN
    RETURN private.withdraw_shared_reference_contribution(v_contribution.id, 'consent_text_revoked');
  END IF;
  SELECT m.raw_points_json AS raw_points_json,
         private.reference_canonical_snapshot(p_owner, p_set) AS snapshot
    INTO v_src
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t
      ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w
      ON w.user_id = t.user_id AND w.id = t.reference_work_id
   WHERE m.user_id = p_owner AND m.id = p_set
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL;
  IF NOT FOUND OR v_src.snapshot IS NULL THEN
    RETURN private.withdraw_shared_reference_contribution(v_contribution.id, 'source_deleted');
  END IF;
  IF v_contribution.share_basis <> 'consented' THEN
    RETURN false;
  END IF;
  v_raw_points := private.shared_reference_project_raw_points(v_src.raw_points_json);
  IF v_src.raw_points_json IS NOT NULL AND v_raw_points IS NULL THEN
    RETURN false;
  END IF;
  v_snapshot := pg_catalog.jsonb_set(
    v_src.snapshot, '{raw_points}', coalesce(v_raw_points, 'null'::jsonb), false
  );
  IF NOT private.reference_share_scope_within(
       private.reference_share_snapshot_scope(v_snapshot), v_contribution.consent_scope
     ) THEN
    RETURN private.withdraw_shared_reference_contribution(
      v_contribution.id, 'consent_scope_exceeded'
    );
  END IF;
  RETURN false;
END
$$;

-- 7. Observation trigger: withdraw what no longer qualifies, then refresh the
-- uses of an observation that is now public, non-draft and spore-public.
-- The refresh (and so creation) keeps the owner/service-role gate of
-- refresh_shared_reference_for_use_row.
CREATE OR REPLACE FUNCTION private.withdraw_shared_references_for_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_use public.observation_reference_uses%ROWTYPE;
  v_qualifies boolean;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'withdraw_shared_references_for_observation handles UPDATE only';
  END IF;
  IF NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     AND NEW.spore_data_visibility IS NOT DISTINCT FROM OLD.spore_data_visibility
     AND NEW.is_draft IS NOT DISTINCT FROM OLD.is_draft THEN
    RETURN NEW;
  END IF;
  v_qualifies := NEW.visibility = 'public' AND NEW.is_draft IS FALSE
    AND NEW.spore_data_visibility IS NOT DISTINCT FROM 'public';
  -- One use per set (a live one first), in sorted set-id order.
  FOR v_use IN
    SELECT DISTINCT ON (u.reference_measurement_set_id) u.*
      FROM public.observation_reference_uses u
     WHERE u.user_id=NEW.user_id AND u.observation_id=NEW.id
     ORDER BY u.reference_measurement_set_id, (u.deleted_at IS NOT NULL), u.id
  LOOP
    PERFORM private.withdraw_unqualified_contributions(
      NEW.user_id, v_use.reference_measurement_set_id, 'observation_not_public'
    );
    IF v_qualifies AND v_use.deleted_at IS NULL THEN
      PERFORM private.refresh_shared_reference_for_use_row(v_use);
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- 8. Stage 1B: created maps to shared; opted_out is recorded; consent_required
-- is retired (the refresh core no longer returns it).
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

-- 9. Public reads ------------------------------------------------------------------

-- The one definition of a served observation reference use: live use; live
-- set, treatment and work; observation public, not a draft, spore data
-- public; owner not banned, not deleting, not blocked with the caller; set
-- not opted out; no hidden contribution of (owner, set); a valid public
-- snapshot. Taxon and registry membership do not matter.
CREATE FUNCTION private.observation_reference_use_is_served(p_use_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.observation_reference_uses u
      JOIN public.observations o
        ON o.user_id = u.user_id AND o.id = u.observation_id
      JOIN public.profiles p ON p.id = u.user_id AND p.is_banned IS FALSE
      JOIN public.reference_measurement_sets m
        ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
      JOIN public.reference_taxon_treatments t
        ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
      JOIN public.reference_works w
        ON w.user_id = t.user_id AND w.id = t.reference_work_id
     WHERE u.id = p_use_id
       AND u.deleted_at IS NULL
       AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
       AND o.visibility = 'public'
       AND o.is_draft IS FALSE
       AND o.spore_data_visibility = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.user_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), u.user_id) IS NOT TRUE)
       AND NOT private.reference_set_opted_out(u.user_id, u.reference_measurement_set_id)
       AND NOT private.reference_set_has_hidden_contribution(u.user_id, u.reference_measurement_set_id)
       AND private.public_reference_snapshot(
             u.snapshot_json, u.reference_measurement_set_id, u.reference_revision
           ) IS NOT NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.search_public_observation_references(p_observation_ids bigint[])
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

-- Roles: exactly the served uses of the contribution's (owner, set, taxon).
CREATE OR REPLACE FUNCTION private.reference_contribution_public_roles(p_contribution_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT pg_catalog.array_agg(DISTINCT u.role::text ORDER BY u.role::text)
      FROM private.shared_reference_contributions c
      JOIN public.observation_reference_uses u
        ON u.user_id = c.owner_id
       AND u.reference_measurement_set_id = c.source_measurement_set_id
       AND u.deleted_at IS NULL
      JOIN public.observations o ON o.id = u.observation_id AND o.user_id = u.user_id
     WHERE c.id = p_contribution_id
       AND c.status = 'shared'
       AND c.share_basis IS NOT NULL
       AND coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer = c.sporely_taxon_id
       AND private.observation_reference_use_is_served(u.id)
  ), '{}'::text[])
$$;

CREATE OR REPLACE FUNCTION private.reference_contribution_is_served(
  p_contribution_id uuid,
  p_enforce_envelope_cap boolean DEFAULT true
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id = c.id AND r.revision = c.current_revision
      JOIN public.profiles p ON p.id = c.owner_id AND p.is_banned IS FALSE
     WHERE c.id = p_contribution_id
       AND c.status = 'shared' AND c.hidden_at IS NULL
       AND c.share_basis IS NOT NULL
       AND r.revision >= c.shared_first_revision
       AND NOT private.reference_set_opted_out(c.owner_id, c.source_measurement_set_id)
       AND NOT private.reference_set_has_hidden_contribution(c.owner_id, c.source_measurement_set_id)
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), c.owner_id) IS NOT TRUE)
       AND (p_enforce_envelope_cap IS FALSE
            OR pg_catalog.octet_length(r.envelope_json::text) <= 1048576)
  )
$$;

CREATE OR REPLACE FUNCTION private.get_public_reference_contribution_v2_unthrottled(
  p_contribution_id uuid,
  p_revision integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_contribution private.shared_reference_contributions%ROWTYPE;
  v_revision integer;
BEGIN
  IF p_contribution_id IS NULL OR (p_revision IS NOT NULL AND p_revision < 1) THEN
    RAISE EXCEPTION 'valid contribution and revision are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_contribution FROM private.shared_reference_contributions c
   WHERE c.id = p_contribution_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_contribution.hidden_at IS NOT NULL
     OR (v_contribution.owner_id IS NOT NULL AND (NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id=v_contribution.owner_id AND p.is_banned IS FALSE
     ) OR EXISTS (
       SELECT 1 FROM private.reference_account_deletions d
        WHERE d.user_id=v_contribution.owner_id
     ) OR (auth.uid() IS NOT NULL
       AND public.is_blocked_between(auth.uid(),v_contribution.owner_id) IS TRUE))) THEN
    RETURN;
  END IF;
  v_revision := coalesce(p_revision, v_contribution.current_revision);
  IF v_contribution.status = 'withdrawn' THEN
    IF p_revision IS NULL OR NOT EXISTS (
      SELECT 1 FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = p_contribution_id AND r.revision = p_revision
    ) THEN RETURN; END IF;
    RETURN NEXT pg_catalog.jsonb_build_object(
      'contribution_id', v_contribution.id,
      'revision', v_revision,
      'status', 'withdrawn',
      'withdrawn_at', v_contribution.withdrawn_at
    );
    RETURN;
  END IF;
  IF NOT private.reference_contribution_is_served(p_contribution_id, false)
     OR v_revision < v_contribution.shared_first_revision THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.envelope_json || pg_catalog.jsonb_build_object(
           'relationship_roles',
           pg_catalog.to_jsonb(private.reference_contribution_public_roles(p_contribution_id)))
    FROM private.shared_reference_contribution_revisions r
   WHERE r.contribution_id = p_contribution_id AND r.revision = v_revision
     AND pg_catalog.octet_length(r.envelope_json::text) <= 1048576;
END
$$;

-- 10. Stop sharing / share again ------------------------------------------------
--
-- Lock order for every opt-out write: the owner's profile row FOR KEY SHARE,
-- then the (owner, set) key lock, as the grant does (20260930232633).

-- True when the set is the owner's: a library set, or a contribution or
-- opt-out of the owner for it.
CREATE FUNCTION private.reference_set_belongs_to(p_owner uuid, p_set uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_owner IS NOT NULL AND p_set IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.reference_measurement_sets m
             WHERE m.user_id = p_owner AND m.id = p_set)
    OR EXISTS (SELECT 1 FROM private.shared_reference_contributions c
                WHERE c.owner_id = p_owner AND c.source_measurement_set_id = p_set)
    OR private.reference_set_opted_out(p_owner, p_set)
  )
$$;

-- Returns 'updated', 'no_change' or 'not_found' (no profile).
CREATE FUNCTION private.stop_sharing_reference_set_for_owner(p_owner uuid, p_set uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_inserted integer;
  v_withdrawn integer := 0;
  v_row record;
BEGIN
  PERFORM 1 FROM public.profiles p WHERE p.id = p_owner FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  PERFORM private.lock_shared_reference_key(p_owner, p_set);
  INSERT INTO private.reference_share_opt_outs(owner_id, source_measurement_set_id)
  VALUES (p_owner, p_set)
  ON CONFLICT (owner_id, source_measurement_set_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  FOR v_row IN
    SELECT c.id FROM private.shared_reference_contributions c
     WHERE c.owner_id = p_owner AND c.source_measurement_set_id = p_set
       AND c.status = 'shared'
     ORDER BY c.sporely_taxon_id, c.id
  LOOP
    IF private.withdraw_shared_reference_contribution(v_row.id, 'owner') THEN
      v_withdrawn := v_withdrawn + 1;
    END IF;
  END LOOP;
  RETURN CASE WHEN v_inserted > 0 OR v_withdrawn > 0 THEN 'updated' ELSE 'no_change' END;
END
$$;

-- Deletes the opt-out and refreshes every taxon with a qualifying use now
-- (best-effort per taxon, as the triggers: a projection failure leaves that
-- taxon unshared). Returns 'updated', 'no_change' or 'not_found'.
CREATE FUNCTION private.share_reference_set_again_for_owner(p_owner uuid, p_set uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
  v_taxon integer;
BEGIN
  PERFORM 1 FROM public.profiles p WHERE p.id = p_owner FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  PERFORM private.lock_shared_reference_key(p_owner, p_set);
  DELETE FROM private.reference_share_opt_outs o
   WHERE o.owner_id = p_owner AND o.source_measurement_set_id = p_set;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  FOR v_taxon IN
    SELECT DISTINCT coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer
      FROM public.observation_reference_uses u
      JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
     WHERE u.user_id = p_owner AND u.reference_measurement_set_id = p_set
       AND u.deleted_at IS NULL
       AND coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id) IS NOT NULL
     ORDER BY 1
  LOOP
    IF private.reference_set_has_qualifying_use(p_owner, p_set, v_taxon) THEN
      BEGIN
        PERFORM private.reference_contribution_share_core('refresh', p_owner, p_set, v_taxon);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END LOOP;
  RETURN CASE WHEN v_deleted > 0 THEN 'updated' ELSE 'no_change' END;
END
$$;

CREATE FUNCTION private.stop_sharing_reference_set_unthrottled(p_source_measurement_set_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_status text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT private.reference_set_belongs_to(v_owner, p_source_measurement_set_id) THEN
    RETURN private.shared_reference_contribution_result('not_found');
  END IF;
  v_status := private.stop_sharing_reference_set_for_owner(v_owner, p_source_measurement_set_id);
  RETURN private.shared_reference_contribution_result(v_status);
END
$$;

CREATE FUNCTION private.share_reference_set_again_unthrottled(p_source_measurement_set_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_status text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT private.reference_set_belongs_to(v_owner, p_source_measurement_set_id) THEN
    RETURN private.shared_reference_contribution_result('not_found');
  END IF;
  v_status := private.share_reference_set_again_for_owner(v_owner, p_source_measurement_set_id);
  RETURN private.shared_reference_contribution_result(v_status);
END
$$;

CREATE FUNCTION public.stop_sharing_reference_set(p_source_measurement_set_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    RETURN private.shared_reference_rate_limited_result(v_retry_after);
  END IF;
  RETURN private.stop_sharing_reference_set_unthrottled(p_source_measurement_set_id);
END
$$;

CREATE FUNCTION public.share_reference_set_again(p_source_measurement_set_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    RETURN private.shared_reference_rate_limited_result(v_retry_after);
  END IF;
  RETURN private.share_reference_set_again_unthrottled(p_source_measurement_set_id);
END
$$;

-- The released per-contribution withdrawal: contribution -> its set -> stop.
-- Response contract unchanged: updated, no_change, forbidden, not_found (and
-- rate_limited from the public wrapper). One call stops the whole set.
CREATE OR REPLACE FUNCTION public.withdraw_reference_contribution_unthrottled(p_contribution_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_row private.shared_reference_contributions%ROWTYPE;
  v_status text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM private.shared_reference_contributions c
   WHERE c.id = p_contribution_id;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('not_found');
  END IF;
  IF v_row.owner_id IS DISTINCT FROM v_owner THEN
    RETURN private.shared_reference_contribution_result('forbidden');
  END IF;
  v_status := private.stop_sharing_reference_set_for_owner(v_owner, v_row.source_measurement_set_id);
  IF v_status NOT IN ('updated', 'no_change') THEN
    RETURN private.shared_reference_contribution_result('forbidden');
  END IF;
  RETURN private.shared_reference_contribution_result(v_status);
END
$$;

-- 11. Owner list, set-keyed -------------------------------------------------------

CREATE FUNCTION private.list_my_reference_sharing_unthrottled()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'sets', coalesce((
      WITH used AS (
        SELECT u.reference_measurement_set_id AS set_id,
               pg_catalog.count(DISTINCT u.observation_id) AS n
          FROM public.observation_reference_uses u
          JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
          JOIN public.reference_measurement_sets m
            ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
          JOIN public.reference_taxon_treatments t
            ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
          JOIN public.reference_works w
            ON w.user_id = t.user_id AND w.id = t.reference_work_id
         WHERE u.user_id = v_owner AND u.deleted_at IS NULL
           AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
           AND o.visibility = 'public' AND o.is_draft IS FALSE
           AND o.spore_data_visibility = 'public'
         GROUP BY u.reference_measurement_set_id
      ), opted AS (
        SELECT o.source_measurement_set_id AS set_id, o.opted_out_at
          FROM private.reference_share_opt_outs o
         WHERE o.owner_id = v_owner
      ), still_shared AS (
        -- Every set that still has a shared contribution, even without a
        -- qualifying use, so the owner can always stop what may be served.
        SELECT DISTINCT c.source_measurement_set_id AS set_id
          FROM private.shared_reference_contributions c
         WHERE c.owner_id = v_owner AND c.status = 'shared'
      ), keys AS (
        SELECT set_id FROM used UNION SELECT set_id FROM opted
        UNION SELECT set_id FROM still_shared
      ), rows AS (
        SELECT k.set_id,
               op.opted_out_at,
               coalesce(us.n, 0) AS n,
               private.reference_set_has_hidden_contribution(v_owner, k.set_id) AS hidden,
               src.short_label, src.raw_text
          FROM keys k
          LEFT JOIN used us ON us.set_id = k.set_id
          LEFT JOIN opted op ON op.set_id = k.set_id
          LEFT JOIN LATERAL (
            SELECT coalesce(nullif(pg_catalog.btrim(w.short_label), ''), pg_catalog.left(w.title, 200)) AS short_label,
                   pg_catalog.left(m.raw_text, 200) AS raw_text
              FROM public.reference_measurement_sets m
              JOIN public.reference_taxon_treatments t
                ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
              JOIN public.reference_works w
                ON w.user_id = t.user_id AND w.id = t.reference_work_id
             WHERE m.user_id = v_owner AND m.id = k.set_id
          ) src ON true
      )
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'source_measurement_set_id', r.set_id,
               'status', CASE WHEN r.hidden THEN 'hidden'
                              WHEN r.opted_out_at IS NOT NULL THEN 'stopped'
                              ELSE 'shared' END,
               'stopped_at', r.opted_out_at,
               'hidden_by_moderation', r.hidden,
               'public_observation_count', r.n,
               'species_page_contributions', coalesce((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'contribution_id', c.id,
                          'sporely_taxon_id', c.sporely_taxon_id,
                          'canonical_scientific_name', rc.canonical_name,
                          'current_revision', c.current_revision,
                          'shared_at', c.shared_at,
                          'hidden_at', c.hidden_at
                        ) ORDER BY c.sporely_taxon_id, c.id)
                   FROM private.shared_reference_contributions c
                   LEFT JOIN taxonomy_v3.registry_concept rc ON rc.sporely_taxon_id = c.sporely_taxon_id
                  WHERE c.owner_id = v_owner AND c.source_measurement_set_id = r.set_id
                    AND c.status = 'shared'
               ), '[]'::jsonb),
               'source_short_label', r.short_label,
               'source_raw_text', r.raw_text
             ) ORDER BY r.short_label NULLS LAST, r.set_id)
        FROM rows r
    ), '[]'::jsonb)
  );
END
$$;

CREATE FUNCTION public.list_my_reference_sharing()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    RETURN private.shared_reference_rate_limited_result(v_retry_after);
  END IF;
  RETURN private.list_my_reference_sharing_unthrottled();
END
$$;

-- 12. Ownership and execution surface ----------------------------------------------

ALTER FUNCTION private.reference_set_opted_out(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.reference_set_has_hidden_contribution(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_reference_contribution(uuid,text) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION private.withdraw_contribution_if_unpublishable(uuid,uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_references_for_observation() OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) OWNER TO postgres;
ALTER FUNCTION private.observation_reference_use_is_served(uuid) OWNER TO postgres;
ALTER FUNCTION public.search_public_observation_references(bigint[]) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_public_roles(uuid) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_is_served(uuid,boolean) OWNER TO postgres;
ALTER FUNCTION private.get_public_reference_contribution_v2_unthrottled(uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.reference_set_belongs_to(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.stop_sharing_reference_set_for_owner(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.share_reference_set_again_for_owner(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.stop_sharing_reference_set_unthrottled(uuid) OWNER TO postgres;
ALTER FUNCTION private.share_reference_set_again_unthrottled(uuid) OWNER TO postgres;
ALTER FUNCTION public.stop_sharing_reference_set(uuid) OWNER TO postgres;
ALTER FUNCTION public.share_reference_set_again(uuid) OWNER TO postgres;
ALTER FUNCTION public.withdraw_reference_contribution_unthrottled(uuid) OWNER TO postgres;
ALTER FUNCTION private.list_my_reference_sharing_unthrottled() OWNER TO postgres;
ALTER FUNCTION public.list_my_reference_sharing() OWNER TO postgres;

REVOKE ALL ON FUNCTION private.reference_set_opted_out(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_set_has_hidden_contribution(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_reference_contribution(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_contribution_if_unpublishable(uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_references_for_observation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.observation_reference_use_is_served(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_public_roles(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_is_served(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.get_public_reference_contribution_v2_unthrottled(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_set_belongs_to(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.stop_sharing_reference_set_for_owner(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.share_reference_set_again_for_owner(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.stop_sharing_reference_set_unthrottled(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.share_reference_set_again_unthrottled(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.withdraw_reference_contribution_unthrottled(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.list_my_reference_sharing_unthrottled() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.stop_sharing_reference_set(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.share_reference_set_again(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_my_reference_sharing() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stop_sharing_reference_set(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.share_reference_set_again(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_reference_sharing() TO authenticated;
-- search_public_observation_references keeps its grants (anon, authenticated,
-- service_role; not PUBLIC).
REVOKE ALL ON FUNCTION public.search_public_observation_references(bigint[]) FROM PUBLIC;

-- 13. Backfill: owner withdrawals become opt-outs --------------------------------
-- Every withdrawn contribution with no withdrawn_by_system event (pre-2a owner
-- withdrawals, and event-less pre-2a system withdrawals: errs toward less
-- exposure, including event-less Stage 1B repair withdrawals), or whose
-- latest withdrawal event is the owner's, gets an opt-out for its
-- (owner, set). Runs strictly before the deploy refresh.
INSERT INTO private.reference_share_opt_outs(owner_id, source_measurement_set_id, opted_out_at)
SELECT c.owner_id, c.source_measurement_set_id, pg_catalog.min(c.withdrawn_at)
  FROM private.shared_reference_contributions c
 WHERE c.status = 'withdrawn'
   AND c.owner_id IS NOT NULL
   AND (
     NOT EXISTS (
       SELECT 1 FROM private.shared_reference_consent_events e
        WHERE e.contribution_id = c.id AND e.event = 'withdrawn_by_system'
     )
     OR (
       SELECT e.event FROM private.shared_reference_consent_events e
        WHERE e.contribution_id = c.id
          AND e.event IN ('withdrawn_by_owner','withdrawn_by_system')
        ORDER BY e.id DESC LIMIT 1
     ) = 'withdrawn_by_owner'
   )
 GROUP BY c.owner_id, c.source_measurement_set_id
ON CONFLICT (owner_id, source_measurement_set_id) DO NOTHING;

-- 14. Deploy refresh: every currently qualifying (owner, set, taxon) through
-- the core directly (the trigger path's owner/service gate skips every row
-- here, where auth.uid() is NULL). Honours opt-outs and hides. Count-agnostic;
-- an error aborts the whole migration.
DO $$
DECLARE
  v_key record;
  v_created integer;
  v_reshared integer;
BEGIN
  FOR v_key IN
    SELECT DISTINCT u.user_id, u.reference_measurement_set_id AS set_id,
           coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer AS taxon_id
      FROM public.observation_reference_uses u
      JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
      JOIN taxonomy_v3.registry_concept rc
        ON rc.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
       AND rc.rank = 'species'
     WHERE u.deleted_at IS NULL
       AND o.visibility = 'public' AND o.is_draft IS FALSE
       AND o.spore_data_visibility = 'public'
     ORDER BY 1, 2, 3
  LOOP
    PERFORM private.reference_contribution_share_core(
      'refresh', v_key.user_id, v_key.set_id, v_key.taxon_id
    );
  END LOOP;
  SELECT pg_catalog.count(*) FILTER (WHERE c.current_revision = 1),
         pg_catalog.count(*) FILTER (WHERE c.current_revision > 1)
    INTO v_created, v_reshared
    FROM private.shared_reference_consent_events e
    JOIN private.shared_reference_contributions c ON c.id = e.contribution_id
   WHERE e.event = 'shared_automatically'
     AND e.occurred_at >= pg_catalog.transaction_timestamp();
  RAISE NOTICE 'reference sharing deploy refresh: % created, % re-shared', v_created, v_reshared;
END
$$;

COMMIT;
