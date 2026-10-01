-- Stage 2b (server) of docs/plans/active/2026-09-30-reference-sharing-consent.md:
-- explicit opt-in for shared reference data.
--
-- Adds, on top of Stage 2a (20260930224506):
--   * public.share_reference_contribution_with_consent: the only public entry
--     point to the grant mode of private.reference_contribution_share_core;
--   * public.list_my_shared_reference_contributions (owner-only);
--   * public.get_reference_share_consent_text(locale);
--   * consent text version 1 in en and nb, inserted INACTIVE. Activation is a
--     separate, owner-approved step; until then every grant is refused with
--     consent_text_unavailable.
-- All three RPCs are rate limited through private.consume_shared_reference_request
-- (the 20260830193144 wrapper pattern) and granted to authenticated only.
--
-- It also fixes the Stage 2a review lows:
--   * the grant records consent_scope from the granted snapshot (never wider
--     than what was shown), so a later revision adding a data kind or a new
--     snapshot schema version withdraws with consent_scope_exceeded;
--   * refresh_shared_reference_for_use_row decides the source_deleted and
--     consent_scope_exceeded withdrawals outside its error-swallowing block;
--     only adding a revision stays best-effort;
--   * grant vs account deletion lock order: the grant takes the owner's
--     profile row (FOR KEY SHARE) before the key advisory lock, the same order
--     as a profile delete (row lock, then the anonymise trigger's key locks);
--   * withdrawal reasons: a detach, a use delete and an observation delete are
--     use_detached; taxon_changed only comes from the taxon trigger; Stage 1B
--     records old_contribution = 'withdrawn' only when this repair
--     transaction actually withdrew the row;
--   * the observation AFTER DELETE trigger is dropped: the cascaded use delete
--     fires the use trigger, which withdraws (tested).
--
-- Does not redefine the six functions the deferred 20260914090000 redefines.

BEGIN;

-- Public tables first, then the private ones, in the order application
-- paths reach them (a write to a public table fires the trigger that then
-- touches the contribution tables). Triggers on the public tables are
-- replaced or dropped below; block their writes (not reads) so no write runs
-- half on the old and half on the new definitions.
LOCK TABLE public.observations,
           public.observation_reference_uses,
           public.reference_measurement_sets,
           public.reference_taxon_treatments,
           public.reference_works
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE private.shared_reference_contributions,
           private.shared_reference_contribution_revisions
  IN ACCESS EXCLUSIVE MODE;

-- Consent locale (M1): the (version, locale) of the text a row was consented
-- under, so revoking one text withdraws exactly its rows. No row is
-- consented before 2b, so nothing to backfill.
ALTER TABLE private.shared_reference_contributions
  ADD COLUMN consent_locale text CHECK (
    consent_locale IS NULL OR consent_locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
  );
ALTER TABLE private.shared_reference_contributions
  DROP CONSTRAINT shared_reference_contributions_consent_all_or_none,
  ADD CONSTRAINT shared_reference_contributions_consent_all_or_none
    CHECK (
      (consented_at IS NULL AND consent_version IS NULL AND consent_locale IS NULL
        AND consent_first_revision IS NULL AND consent_scope IS NULL)
      OR (consented_at IS NOT NULL AND consent_version IS NOT NULL AND consent_locale IS NOT NULL
        AND consent_first_revision IS NOT NULL AND consent_scope IS NOT NULL)
    );

-- The withdrawal helper (2a) now also clears consent_locale.
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
    'consent_text_revoked','account_deleted'
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

-- True when the row's consent text (version, locale) is revoked or gone.
CREATE FUNCTION private.reference_consent_text_revoked(p_version integer, p_locale text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM private.reference_share_consent_texts ct
     WHERE ct.version = p_version AND ct.locale = p_locale AND NOT ct.revoked
  )
$$;

-- 1. The core: identical to 2a except that grant records consent_scope from
-- the final snapshot (checked to lie within the text's scope) instead of the
-- whole text scope, and consent_locale; refresh withdraws a row whose text
-- was revoked (consent_text_revoked).
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
  IF p_mode = 'refresh'
     AND (NOT v_found OR v_contribution.status <> 'shared'
          OR v_contribution.consented_at IS NULL) THEN
    RETURN private.shared_reference_contribution_result('consent_required');
  END IF;
  IF p_mode = 'refresh' AND private.reference_consent_text_revoked(
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

  -- One read, without row locks: the rows, the revisions recorded below, the
  -- bounds and the canonical snapshot all come from this statement.
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
    IF p_mode = 'refresh' THEN
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
    IF p_mode = 'refresh' THEN
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

  -- The scope check runs on the final snapshot (raw points projected).
  v_scope := private.reference_share_snapshot_scope(v_snapshot);
  IF p_mode = 'refresh' THEN
    IF NOT private.reference_share_scope_within(v_scope, v_contribution.consent_scope) THEN
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
    -- grant only (refresh returned consent_required above).
    INSERT INTO private.shared_reference_contributions(
      owner_id, source_measurement_set_id, sporely_taxon_id,
      status, current_revision, shared_at, updated_at,
      consented_at, consent_version, consent_locale, consent_client,
      consent_first_revision, consent_scope
    ) VALUES (
      v_owner, p_source_measurement_set_id, p_sporely_taxon_id,
      'shared', 1, v_now, v_now,
      v_now, v_text.version, v_text.locale, p_consent_client, 1, v_scope
    ) RETURNING * INTO v_contribution;
    v_revision := 1;
  ELSIF v_contribution.status = 'shared' THEN
    IF p_mode = 'grant' THEN
      -- Renewed consent within the current period: the period (and so
      -- consent_first_revision) is unchanged.
      UPDATE private.shared_reference_contributions
         SET consented_at = v_now, consent_version = v_text.version,
             consent_locale = v_text.locale, consent_client = p_consent_client, consent_scope = v_scope,
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
    -- grant on a withdrawn row: a new consent period starting at a new
    -- revision, so no revision from before the withdrawal is served again.
    -- hidden_at is never cleared.
    v_revision := v_contribution.current_revision + 1;
    UPDATE private.shared_reference_contributions
       SET status = 'shared', current_revision = v_revision,
           shared_at = v_now, updated_at = v_now, withdrawn_at = NULL,
           consented_at = v_now, consent_version = v_text.version,
           consent_locale = v_text.locale, consent_client = p_consent_client,
           consent_first_revision = v_revision, consent_scope = v_scope
     WHERE id = v_contribution.id
     RETURNING * INTO v_contribution;
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
  END IF;
  RETURN private.shared_reference_contribution_result(
    CASE WHEN v_revision = 1 THEN 'created' ELSE 'updated' END, v_envelope
  );
END
$$;

-- 2. Withdrawal helpers ---------------------------------------------------

-- Withdraws every shared row of (owner, set) with no qualifying use left.
-- Reason, in order: source_deleted when the set, treatment or work is gone;
-- else the caller's cause (use_detached, taxon_changed, observation_not_public)
-- when it knows what just happened; else observation_not_public when a live
-- use of this taxon remains on a non-qualifying observation; else
-- use_detached.
CREATE FUNCTION private.withdraw_unqualified_contributions(
  p_owner uuid,
  p_set uuid,
  p_cause text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_row record;
  v_reason text;
  v_count integer := 0;
BEGIN
  IF p_cause IS NOT NULL
     AND p_cause NOT IN ('use_detached','taxon_changed','observation_not_public') THEN
    RAISE EXCEPTION 'invalid withdrawal cause %', p_cause USING ERRCODE = '22023';
  END IF;
  IF p_owner IS NULL OR p_set IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM private.lock_shared_reference_key(p_owner, p_set);
  FOR v_row IN
    SELECT c.id, c.sporely_taxon_id
      FROM private.shared_reference_contributions c
     WHERE c.owner_id = p_owner
       AND c.source_measurement_set_id = p_set
       AND c.status = 'shared'
     ORDER BY c.sporely_taxon_id, c.id
  LOOP
    IF private.reference_set_has_qualifying_use(p_owner, p_set, v_row.sporely_taxon_id) THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.reference_measurement_sets m
        JOIN public.reference_taxon_treatments t
          ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
        JOIN public.reference_works w
          ON w.user_id = t.user_id AND w.id = t.reference_work_id
       WHERE m.user_id = p_owner AND m.id = p_set
         AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
    ) THEN
      v_reason := 'source_deleted';
    ELSIF p_cause IS NOT NULL THEN
      v_reason := p_cause;
    ELSIF EXISTS (
      SELECT 1
        FROM public.observation_reference_uses u
        JOIN public.observations o
          ON o.user_id = u.user_id AND o.id = u.observation_id
       WHERE u.user_id = p_owner AND u.reference_measurement_set_id = p_set
         AND u.deleted_at IS NULL
         AND coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
             = v_row.sporely_taxon_id
    ) THEN
      v_reason := 'observation_not_public';
    ELSE
      v_reason := 'use_detached';
    END IF;
    IF private.withdraw_shared_reference_contribution(v_row.id, v_reason) THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;

-- The 2a two-argument form stays for its existing callers (the core's
-- withdrawn_unqualified path), deriving the reason.
CREATE OR REPLACE FUNCTION private.withdraw_unqualified_contributions(p_owner uuid, p_set uuid)
RETURNS integer
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT private.withdraw_unqualified_contributions(p_owner, p_set, NULL::text)
$$;

-- The withdrawal decisions of a refresh, taken outside any error-swallowing
-- block: withdraws a consented shared row whose live source can no longer be
-- read into a snapshot (source_deleted), whose consent text was revoked
-- (consent_text_revoked), or whose next snapshot would fall outside its
-- consent_scope (consent_scope_exceeded). Caller holds the key
-- lock. Returns true when it withdrew.
CREATE FUNCTION private.withdraw_contribution_if_unpublishable(
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
     AND c.status = 'shared' AND c.consented_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF private.reference_consent_text_revoked(v_contribution.consent_version, v_contribution.consent_locale) THEN
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
  v_raw_points := private.shared_reference_project_raw_points(v_src.raw_points_json);
  IF v_src.raw_points_json IS NOT NULL AND v_raw_points IS NULL THEN
    -- Unprojectable: the core publishes nothing (source_out_of_bounds).
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

-- 3. Automatic paths --------------------------------------------------------

CREATE OR REPLACE FUNCTION private.refresh_shared_reference_for_use_row(
  p_use public.observation_reference_uses
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_taxon_id integer;
BEGIN
  PERFORM private.lock_shared_reference_key(p_use.user_id, p_use.reference_measurement_set_id);
  IF p_use.deleted_at IS NULL
     AND ((auth.uid() IS NOT NULL AND auth.uid() = p_use.user_id)
          OR auth.role() = 'service_role') THEN
    SELECT coalesce(o.selected_sporely_taxon_id,o.resolved_sporely_taxon_id)::integer
      INTO v_taxon_id FROM public.observations o
     WHERE o.user_id=p_use.user_id AND o.id=p_use.observation_id;
    IF v_taxon_id IS NOT NULL
       AND NOT private.withdraw_contribution_if_unpublishable(
         p_use.user_id, p_use.reference_measurement_set_id, v_taxon_id
       ) THEN
      BEGIN
        PERFORM private.share_reference_contribution_for_owner(
          p_use.user_id,p_use.reference_measurement_set_id,v_taxon_id,NULL,NULL,NULL
        );
      EXCEPTION WHEN OTHERS THEN
        -- Only adding a revision is best-effort; a failure keeps the last
        -- consented revision and never rolls back the owner's sync. The
        -- withdrawal decisions ran above and run below, outside this block.
        NULL;
      END;
    END IF;
  END IF;
  PERFORM private.withdraw_unqualified_contributions(
    p_use.user_id, p_use.reference_measurement_set_id,
    CASE WHEN p_use.deleted_at IS NOT NULL THEN 'use_detached' END
  );
END
$$;

CREATE OR REPLACE FUNCTION private.refresh_shared_reference_for_use()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_set uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;
  FOR v_set IN
    SELECT DISTINCT s.id
      FROM (VALUES
        (CASE WHEN TG_OP <> 'DELETE' THEN NEW.reference_measurement_set_id END),
        (CASE WHEN TG_OP <> 'INSERT' THEN OLD.reference_measurement_set_id END)
      ) AS s(id)
     WHERE s.id IS NOT NULL
     ORDER BY s.id
  LOOP
    IF TG_OP <> 'DELETE' AND NEW.reference_measurement_set_id = v_set THEN
      PERFORM private.refresh_shared_reference_for_use_row(NEW);
    ELSE
      -- A deleted use (including an observation delete's cascade) or a use
      -- moved off this set.
      PERFORM private.withdraw_unqualified_contributions(v_user_id, v_set, 'use_detached');
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;

CREATE OR REPLACE FUNCTION private.refresh_shared_references_for_observation_taxon()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_taxon_id integer := coalesce(
    OLD.selected_sporely_taxon_id, OLD.resolved_sporely_taxon_id
  )::integer;
  v_new_taxon_id integer := coalesce(
    NEW.selected_sporely_taxon_id, NEW.resolved_sporely_taxon_id
  )::integer;
  v_use public.observation_reference_uses%ROWTYPE;
BEGIN
  IF v_old_taxon_id IS NOT DISTINCT FROM v_new_taxon_id THEN
    RETURN NEW;
  END IF;
  FOR v_use IN
    SELECT DISTINCT ON (u.reference_measurement_set_id) u.*
      FROM public.observation_reference_uses u
     WHERE u.user_id=NEW.user_id AND u.observation_id=NEW.id
       AND u.deleted_at IS NULL
     ORDER BY u.reference_measurement_set_id,u.id
  LOOP
    PERFORM private.lock_shared_reference_key(NEW.user_id, v_use.reference_measurement_set_id);
    PERFORM private.withdraw_unqualified_contributions(
      NEW.user_id, v_use.reference_measurement_set_id, 'taxon_changed'
    );
    IF v_new_taxon_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM taxonomy_v3.registry_concept c
       WHERE c.sporely_taxon_id=v_new_taxon_id AND c.rank='species'
    ) THEN
      PERFORM private.refresh_shared_reference_for_use_row(v_use);
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- Visibility, spore-data visibility and draft changes. Observation deletion
-- is covered by the cascaded use delete (use trigger), so its trigger goes.
CREATE OR REPLACE FUNCTION private.withdraw_shared_references_for_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_set uuid;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'withdraw_shared_references_for_observation handles UPDATE only';
  END IF;
  IF NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     AND NEW.spore_data_visibility IS NOT DISTINCT FROM OLD.spore_data_visibility
     AND NEW.is_draft IS NOT DISTINCT FROM OLD.is_draft THEN
    RETURN NEW;
  END IF;
  FOR v_set IN
    SELECT DISTINCT u.reference_measurement_set_id
      FROM public.observation_reference_uses u
     WHERE u.user_id=NEW.user_id AND u.observation_id=NEW.id
     ORDER BY u.reference_measurement_set_id
  LOOP
    PERFORM private.withdraw_unqualified_contributions(
      NEW.user_id, v_set, 'observation_not_public'
    );
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER observation_delete_shared_contribution_trg ON public.observations;

-- Stage 1B: old_contribution = 'withdrawn' only when this repair transaction
-- withdrew the row: the helper here, or the promotion UPDATE's own taxon
-- trigger (which runs first, with reason taxon_changed). A row withdrawn
-- earlier for another reason is 'none'.
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
      IF v_status IN ('updated', 'no_change') THEN
        IF NOT EXISTS (
          SELECT 1 FROM private.shared_reference_contributions c
           WHERE c.owner_id = v_obs.user_id AND c.source_measurement_set_id = v_set
             AND c.sporely_taxon_id = v_new AND c.status = 'shared'
             AND c.consented_at IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'refresh for set % under taxon % reported % but is not shared',
            v_set, v_new, v_status;
        END IF;
        v_new_action := 'shared';
      ELSIF v_status IN ('consent_required', 'consent_scope_exceeded', 'withdrawn_unqualified',
                         'consent_text_revoked') THEN
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
      ELSIF v_status IN ('account_unavailable', 'source_out_of_bounds') THEN
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

-- 4. Owner RPCs ---------------------------------------------------------------

-- Grant: the owner's explicit opt-in for one (set, taxon). Every check of
-- the plan runs in the core under the key lock: an active, unrevoked text for
-- (version, locale); the displayed work/treatment/set revisions (else
-- revision_mismatch); a registry species; a qualifying use (decision B); the
-- account not banned or deleting; the snapshot within the text's scope.
-- hidden_at is never touched. A withdrawn row starts a new consent period.
CREATE FUNCTION private.share_reference_contribution_with_consent_unthrottled(
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer,
  p_consent_version integer,
  p_locale text,
  p_consent_client text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  -- Lock order: the profile row before the key advisory lock, as a profile
  -- delete does (row lock, then the anonymise trigger's key locks). Without
  -- this, a grant holding the key lock would wait on the profile row in its
  -- INSERT's foreign-key check while the delete waits on the key lock.
  PERFORM 1 FROM public.profiles p WHERE p.id = v_owner FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('account_unavailable');
  END IF;
  -- The text row, also before the key lock: a concurrent revocation holds it
  -- (then takes key locks), so a grant either waits and then sees it
  -- revoked, or holds it and the revocation's scan sees the new row.
  PERFORM 1 FROM private.reference_share_consent_texts ct
   WHERE ct.version = p_consent_version AND ct.locale = p_locale
     AND ct.active AND NOT ct.revoked
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN private.shared_reference_contribution_result('consent_text_unavailable');
  END IF;
  RETURN private.reference_contribution_share_core(
    'grant', v_owner, p_source_measurement_set_id, p_sporely_taxon_id,
    p_expected_work_revision, p_expected_treatment_revision,
    p_expected_measurement_set_revision, p_consent_version, p_locale,
    p_consent_client
  );
END
$$;

CREATE FUNCTION public.share_reference_contribution_with_consent(
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer,
  p_consent_version integer,
  p_locale text,
  p_consent_client text DEFAULT NULL
)
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
  RETURN private.share_reference_contribution_with_consent_unthrottled(
    p_source_measurement_set_id, p_sporely_taxon_id, p_expected_work_revision,
    p_expected_treatment_revision, p_expected_measurement_set_revision,
    p_consent_version, p_locale, p_consent_client
  );
END
$$;

-- The caller's own contributions only; no other account's data.
CREATE FUNCTION private.list_my_shared_reference_contributions_unthrottled()
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
    'contributions', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'contribution_id', c.id,
               'status', c.status,
               'sporely_taxon_id', c.sporely_taxon_id,
               'canonical_scientific_name', rc.canonical_name,
               'current_revision', c.current_revision,
               'shared_at', c.shared_at,
               'withdrawn_at', c.withdrawn_at,
               'hidden_at', c.hidden_at,
               'withdrawal_reason', CASE WHEN c.status = 'withdrawn' THEN (
                 SELECT e.reason FROM private.shared_reference_consent_events e
                  WHERE e.contribution_id = c.id AND e.event <> 'granted'
                  ORDER BY e.id DESC LIMIT 1) END,
               -- The owner's own source labels, so several sets for one
               -- species can be told apart.
               'source_short_label', src.short_label,
               'source_raw_text', src.raw_text
             ) ORDER BY c.shared_at DESC, c.id)
        FROM private.shared_reference_contributions c
        LEFT JOIN taxonomy_v3.registry_concept rc ON rc.sporely_taxon_id = c.sporely_taxon_id
        LEFT JOIN LATERAL (
          SELECT coalesce(nullif(pg_catalog.btrim(w.short_label), ''), pg_catalog.left(w.title, 200)) AS short_label,
                 pg_catalog.left(m.raw_text, 200) AS raw_text
            FROM public.reference_measurement_sets m
            JOIN public.reference_taxon_treatments t
              ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
            JOIN public.reference_works w
              ON w.user_id = t.user_id AND w.id = t.reference_work_id
           WHERE m.user_id = v_owner AND m.id = c.source_measurement_set_id
        ) src ON true
       WHERE c.owner_id = v_owner
    ), '[]'::jsonb)
  );
END
$$;

CREATE FUNCTION public.list_my_shared_reference_contributions()
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
  RETURN private.list_my_shared_reference_contributions_unthrottled();
END
$$;

CREATE FUNCTION private.get_reference_share_consent_text_unthrottled(p_locale text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce((
    SELECT pg_catalog.jsonb_build_object(
             'status', 'ok',
             'version', ct.version,
             'locale', ct.locale,
             'text', ct.text,
             'text_sha256', ct.text_sha256,
             'scope', ct.scope
           )
      FROM private.reference_share_consent_texts ct
     WHERE ct.locale = p_locale AND ct.active AND NOT ct.revoked
  ), pg_catalog.jsonb_build_object('status', 'not_found'))
$$;

CREATE FUNCTION public.get_reference_share_consent_text(p_locale text)
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
  RETURN private.get_reference_share_consent_text_unthrottled(p_locale);
END
$$;

-- Operator step (postgres only): revoke one consent text version and
-- withdraw every row consented under it, through the withdrawal helper,
-- with consent_text_revoked. Idempotent. Takes the text row first, then the
-- key locks in sorted (owner, set) order, as a grant does.
CREATE FUNCTION private.revoke_reference_share_consent_text(p_version integer, p_locale text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_row record;
  v_count integer := 0;
BEGIN
  UPDATE private.reference_share_consent_texts
     SET revoked = true, active = false
   WHERE version = p_version AND locale = p_locale;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no consent text version % for locale %', p_version, p_locale
      USING ERRCODE = '22023';
  END IF;
  FOR v_row IN
    SELECT c.id, c.owner_id, c.source_measurement_set_id
      FROM private.shared_reference_contributions c
     WHERE c.status = 'shared'
       AND c.consent_version = p_version AND c.consent_locale = p_locale
     ORDER BY c.owner_id, c.source_measurement_set_id, c.id
  LOOP
    PERFORM private.lock_shared_reference_key(v_row.owner_id, v_row.source_measurement_set_id);
    IF EXISTS (
      SELECT 1 FROM private.shared_reference_contributions c
       WHERE c.id = v_row.id AND c.status = 'shared'
         AND c.consent_version = p_version AND c.consent_locale = p_locale
    ) AND private.withdraw_shared_reference_contribution(v_row.id, 'consent_text_revoked') THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END
$$;

-- 5. Consent text version 1 (en, nb), INACTIVE until the owner approves the
-- wording. The scope is the current snapshot schema (version 1) and every
-- data kind the text discloses.
INSERT INTO private.reference_share_consent_texts(version, locale, text, text_sha256, active, revoked, scope)
SELECT 1, v.locale, v.body,
       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v.body, 'UTF8')), 'hex'),
       false, false,
       '{"snapshot_schema_versions":[1],"data_kinds":["raw_points","free_text","measurement_details"]}'::jsonb
  FROM (VALUES
    ('en', $en$Share this reference publicly

If you share, anyone can see and download the following, without signing in:
- your public name on Sporely (your username, or "Sporely user"), shown as the contributor;
- the species it is shared for, which shows publicly, under your name, that you identified this species;
- the full citation: authors, editors, title, year, publisher, journal and pages, DOI, ISBN and link, and the citation exports (plain text, BibTeX, CSL-JSON);
- the name as published and the other citation fields, which are always public in a shared reference;
- the measurements: the text, ranges and averages, method details, and every individual measured point.

The reference also appears on your public observations that use it, with how you used it (compared, supports or contradicts the identification).

Later edits: while you share, a changed version is published automatically only while it contains the same kinds of data as the version you shared. For example, if the version you shared had no measured points or no measurement details, adding them later stops sharing, and you are asked again. Earlier versions published while you share stay publicly available by version number until you stop.

Sharing needs at least one of your public observations of this species that uses this reference. Sharing stops when none is left: when the observation is made private, friends-only or a draft, its spore data is made private, it is deleted, its species is changed, or the reference is removed from it; or when the reference set, treatment or work is deleted.

You can stop sharing at any time. Stopping removes the reference from public view in Sporely, including from your observations. It cannot undo:
- copies other users have already made; these are their own reference sets, which they may keep and share under their own name;
- anything others have already downloaded, saved or cited;
- the earlier versions Sporely keeps privately as a record.

By sharing, you confirm that you have the right to share this citation and these measurements publicly.$en$),
    ('nb', $nb$Del denne referansen offentlig

Hvis du deler, kan hvem som helst se og laste ned følgende, uten å logge inn:
- det offentlige navnet ditt i Sporely (brukernavnet ditt, eller «Sporely-bruker»), vist som bidragsyter;
- arten den deles for, som viser offentlig, under ditt navn, at du har bestemt denne arten;
- hele kildehenvisningen: forfattere, redaktører, tittel, år, forlag, tidsskrift og sider, DOI, ISBN og lenke, og eksportene av henvisningen (ren tekst, BibTeX, CSL-JSON);
- navnet slik det er publisert og de andre feltene i kildehenvisningen, som alltid er offentlige i en delt referanse;
- målingene: teksten, intervaller og gjennomsnitt, metodedetaljer og hvert enkelt målepunkt.

Referansen vises også på de offentlige observasjonene dine som bruker den, med hvordan du brukte den (sammenlignet, støtter eller motsier bestemmelsen).

Senere endringer: mens du deler, publiseres en endret versjon automatisk bare så lenge den inneholder de samme typene data som versjonen du delte. Hvis for eksempel versjonen du delte ikke hadde målepunkter eller måledetaljer, og du legger dem til senere, stopper delingen, og du blir spurt på nytt. Tidligere versjoner som er publisert mens du deler, forblir offentlig tilgjengelige etter versjonsnummer til du slutter å dele.

Deling krever minst én av dine offentlige observasjoner av denne arten som bruker denne referansen. Delingen stopper når ingen er igjen: når observasjonen blir privat, kun for venner eller et utkast, sporedataene blir private, den slettes, arten endres, eller referansen fjernes fra den; eller når referansesettet, behandlingen eller verket slettes.

Du kan når som helst slutte å dele. Da fjernes referansen fra offentlig visning i Sporely, også fra observasjonene dine. Det kan ikke gjøre om:
- kopier andre brukere allerede har laget; disse er deres egne referansesett, som de kan beholde og dele under sitt eget navn;
- det andre allerede har lastet ned, lagret eller sitert;
- tidligere versjoner Sporely beholder privat som dokumentasjon.

Ved å dele bekrefter du at du har rett til å dele denne kildehenvisningen og disse målingene offentlig.$nb$)
  ) AS v(locale, body);

-- 6. Ownership and execution surface --------------------------------------

ALTER FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION private.withdraw_unqualified_contributions(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_reference_contribution(uuid,text) OWNER TO postgres;
ALTER FUNCTION private.reference_consent_text_revoked(integer,text) OWNER TO postgres;
ALTER FUNCTION private.revoke_reference_share_consent_text(integer,text) OWNER TO postgres;
ALTER FUNCTION private.withdraw_unqualified_contributions(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.withdraw_contribution_if_unpublishable(uuid,uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_reference_for_use_row(public.observation_reference_uses) OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_reference_for_use() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_observation_taxon() OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_references_for_observation() OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) OWNER TO postgres;
ALTER FUNCTION private.share_reference_contribution_with_consent_unthrottled(uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION public.share_reference_contribution_with_consent(uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION private.list_my_shared_reference_contributions_unthrottled() OWNER TO postgres;
ALTER FUNCTION public.list_my_shared_reference_contributions() OWNER TO postgres;
ALTER FUNCTION private.get_reference_share_consent_text_unthrottled(text) OWNER TO postgres;
ALTER FUNCTION public.get_reference_share_consent_text(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_unqualified_contributions(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_reference_contribution(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_consent_text_revoked(integer,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.revoke_reference_share_consent_text(integer,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_unqualified_contributions(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_contribution_if_unpublishable(uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_reference_for_use_row(public.observation_reference_uses) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_reference_for_use() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_observation_taxon() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_references_for_observation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.share_reference_contribution_with_consent_unthrottled(uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.list_my_shared_reference_contributions_unthrottled() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.get_reference_share_consent_text_unthrottled(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.share_reference_contribution_with_consent(uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_my_shared_reference_contributions() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_reference_share_consent_text(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.share_reference_contribution_with_consent(uuid,integer,integer,integer,integer,integer,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_shared_reference_contributions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reference_share_consent_text(text) TO authenticated;

COMMIT;
