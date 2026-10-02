-- Stage A of docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md:
-- version-aware public reference reads and the automatic-share version gap.
--
--   1. Public reads take p_accept_snapshot_versions integer[] DEFAULT '{1}'
--      as a trailing argument (the old signature is dropped and recreated,
--      so there is exactly one function per name and existing named-argument
--      callers keep resolving):
--        * public.search_public_reference_contributions_v2
--        * public.get_public_reference_contribution_v2
--        * public.search_public_observation_references
--        * public.get_public_observation_references
--      A snapshot of version 1, or of version 2 for a caller that accepts 2,
--      is returned exactly as before. A version-2 snapshot for a caller that
--      does not accept 2 is projected to the exact version-1 shape (sporely-py
--      measurement-content contract section 7) and its item is stamped
--      measurement_details_omitted: true. Nothing else is invented: the
--      projection drops measurement_details and measurements.q_core_min /
--      q_core_max (never folded into q_min/q_max), keeps every scalar column
--      as stored (q_mean stays NULL for a mean interval, contract section 2
--      rule 4), and nulls a length/width core pair tagged percentile_interval
--      (never presented as an ordinary range). Any other snapshot version is
--      not served to that caller.
--      The private _unthrottled functions, the rate limit, the page policy,
--      the page byte cap (measured on stored envelopes, as before) and the
--      served predicates are unchanged.
--   2. private.reference_contribution_share_core: every automatic outcome
--      (new share, re-share, new revision of an automatic row) is bound by
--      private.reference_automatic_share_scope(), snapshot version 1 only
--      until Stage D. Out of scope the core answers
--      snapshot_version_unsupported, creating nothing and withdrawing a
--      shared automatic row with the new reason snapshot_version_unsupported
--      (no opt-out). Consented refresh and grant are
--      unchanged. Stage 1B records not_shareable:snapshot_version_unsupported;
--      the triggers, share-again and deploy refresh ignore the status.
--
-- Before Stage D (20260914090000 deferred) production can neither store nor
-- serve a version-2 snapshot, so this changes no production response.
-- Rollback: supabase/rollbacks/20261001213000_rollback.sql.

BEGIN;

-- 1. Helpers ----------------------------------------------------------------------

-- Validates a caller's accepted snapshot versions and answers whether 2 is
-- accepted. NULL means the default {1}. Otherwise a non-empty subset of
-- {1,2} that contains 1 (every reader understands version 1).
CREATE FUNCTION private.reference_accepts_snapshot_v2(p_accept integer[])
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_accept IS NULL THEN
    RETURN false;
  END IF;
  IF pg_catalog.cardinality(p_accept) NOT BETWEEN 1 AND 8
     OR pg_catalog.array_position(p_accept, NULL) IS NOT NULL
     OR NOT (p_accept OPERATOR(pg_catalog.<@) ARRAY[1,2])
     OR NOT (1 = ANY(p_accept)) THEN
    RAISE EXCEPTION 'accepted snapshot versions must be a subset of {1,2} containing 1'
      USING ERRCODE = '22023';
  END IF;
  RETURN 2 = ANY(p_accept);
END
$$;

-- The exact version-1 shape of a version-2 public snapshot.
CREATE FUNCTION private.reference_public_snapshot_project_v1(p_snapshot jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
      OR pg_catalog.jsonb_typeof(p_snapshot->'measurements') <> 'object' THEN NULL
    ELSE (p_snapshot - 'measurement_details') || pg_catalog.jsonb_build_object(
      'schema_version', 1,
      'measurements',
        ((p_snapshot->'measurements') - ARRAY['q_core_min','q_core_max'])
        || CASE WHEN p_snapshot #>> '{measurement_details,metrics,length,core_range,kind}'
                     = 'percentile_interval'
                THEN '{"length_core_min":null,"length_core_max":null}'::jsonb
                ELSE '{}'::jsonb END
        || CASE WHEN p_snapshot #>> '{measurement_details,metrics,width,core_range,kind}'
                     = 'percentile_interval'
                THEN '{"width_core_min":null,"width_core_max":null}'::jsonb
                ELSE '{}'::jsonb END
    )
  END
$$;

-- One public item (a contribution envelope or an observation reference item,
-- both carrying the snapshot under 'snapshot') for a caller. Version 1, and
-- version 2 for a caller accepting it, are returned unchanged; version 2
-- otherwise is projected and marked; anything else is NULL (not served).
-- An item without a snapshot (a withdrawn tombstone) is unchanged.
CREATE FUNCTION private.reference_public_item_for_versions(p_item jsonb, p_accept_v2 boolean)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_version jsonb;
  v_projected jsonb;
BEGIN
  IF p_item IS NULL OR NOT (p_item ? 'snapshot') THEN
    RETURN p_item;
  END IF;
  v_version := p_item->'snapshot'->'schema_version';
  IF v_version = '1'::jsonb OR (v_version = '2'::jsonb AND p_accept_v2 IS TRUE) THEN
    RETURN p_item;
  END IF;
  IF v_version = '2'::jsonb THEN
    v_projected := private.reference_public_snapshot_project_v1(p_item->'snapshot');
    IF v_projected IS NULL THEN
      RETURN NULL;
    END IF;
    RETURN p_item || pg_catalog.jsonb_build_object(
      'snapshot', v_projected,
      'measurement_details_omitted', true
    );
  END IF;
  RETURN NULL;
END
$$;

-- The scope every automatic share is bound by: snapshot version 1, any data
-- kind (raw points and free text are shared automatically today; measurement
-- details exist only in version 2). Stage D widens the versions.
CREATE FUNCTION private.reference_automatic_share_scope()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT '{"snapshot_schema_versions":[1],"data_kinds":["free_text","measurement_details","raw_points"]}'::jsonb
$$;

-- 1b. Withdrawal reason snapshot_version_unsupported (event CHECK and the
-- withdrawal helper; helper body otherwise identical to 20261001113007).

ALTER TABLE private.shared_reference_consent_events
  DROP CONSTRAINT shared_reference_consent_events_reason_check,
  ADD CONSTRAINT shared_reference_consent_events_reason_check
    CHECK (reason IS NULL OR reason IN (
      'owner','consent_missing','observation_not_public','use_detached',
      'source_deleted','taxon_changed','consent_scope_exceeded',
      'consent_text_revoked','account_deleted','rollback',
      'snapshot_version_unsupported'
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
    'consent_text_revoked','account_deleted','rollback',
    'snapshot_version_unsupported'
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

-- 2. Species-page reads --------------------------------------------------------------

DROP FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid);
DROP FUNCTION public.get_public_reference_contribution_v2(uuid,integer);

CREATE FUNCTION public.search_public_reference_contributions_v2(
  p_sporely_taxon_id integer,
  p_limit integer DEFAULT NULL,
  p_after_shared_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_accept_snapshot_versions integer[] DEFAULT '{1}'::integer[]
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
  v_accept_v2 boolean := private.reference_accepts_snapshot_v2(p_accept_snapshot_versions);
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
  RETURN QUERY
  SELECT p.item
    FROM private.search_public_reference_contributions_v2_unthrottled(
           p_sporely_taxon_id,coalesce(p_limit,v_policy.catalogue_default_page_size),
           p_after_shared_at,p_after_id
         ) WITH ORDINALITY AS e(envelope,ord)
   CROSS JOIN LATERAL (
     SELECT private.reference_public_item_for_versions(e.envelope, v_accept_v2) AS item
   ) p
   WHERE p.item IS NOT NULL
   ORDER BY e.ord;
END
$$;

CREATE FUNCTION public.get_public_reference_contribution_v2(
  p_contribution_id uuid,
  p_revision integer DEFAULT NULL,
  p_accept_snapshot_versions integer[] DEFAULT '{1}'::integer[]
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
  v_accept_v2 boolean := private.reference_accepts_snapshot_v2(p_accept_snapshot_versions);
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
  RETURN QUERY
  SELECT p.item
    FROM private.get_public_reference_contribution_v2_unthrottled(
           p_contribution_id,p_revision
         ) WITH ORDINALITY AS e(envelope,ord)
   CROSS JOIN LATERAL (
     SELECT private.reference_public_item_for_versions(e.envelope, v_accept_v2) AS item
   ) p
   WHERE p.item IS NOT NULL
   ORDER BY e.ord;
END
$$;

-- 3. Observation reads ----------------------------------------------------------------

DROP FUNCTION public.get_public_observation_references(bigint);
DROP FUNCTION public.search_public_observation_references(bigint[]);

CREATE FUNCTION public.search_public_observation_references(
  p_observation_ids bigint[],
  p_accept_snapshot_versions integer[] DEFAULT '{1}'::integer[]
)
RETURNS SETOF public.public_observation_references_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_accept_v2 boolean := private.reference_accepts_snapshot_v2(p_accept_snapshot_versions);
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
        projected.item ORDER BY u.selected_at,u.id
      ) FILTER (
        WHERE u.id IS NOT NULL AND sanitized.snapshot IS NOT NULL AND served.ok
          AND projected.item IS NOT NULL
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
  LEFT JOIN LATERAL (
    SELECT private.reference_public_item_for_versions(
      pg_catalog.jsonb_build_object(
        'use_id',u.id,
        'role',u.role,
        'reference_revision',u.reference_revision,
        'snapshot',sanitized.snapshot
      ), v_accept_v2
    ) AS item
  ) projected ON u.id IS NOT NULL AND sanitized.snapshot IS NOT NULL
  GROUP BY e.id
  ORDER BY e.id;
END
$$;


CREATE FUNCTION public.get_public_observation_references(
  p_observation_id bigint,
  p_accept_snapshot_versions integer[] DEFAULT '{1}'::integer[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT projected."references"
  FROM public.search_public_observation_references(
    ARRAY[p_observation_id], p_accept_snapshot_versions
  ) projected
$$;

-- 4. Automatic-share version gate in the core (body otherwise identical to
-- 20261001113007) ------------------------------------------------------------------

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

  -- The consent scope binds only consented rows and grants. Every automatic
  -- outcome (a new share, a re-share of a withdrawn row, a new revision of
  -- an automatic row) is bound by the automatic scope: snapshot version 1
  -- only, until Stage D widens it. Out of scope, nothing is written and an
  -- automatic row keeps its last revision.
  v_scope := private.reference_share_snapshot_scope(v_snapshot);
  IF p_mode = 'refresh' THEN
    IF v_shared AND v_contribution.share_basis = 'consented' THEN
      IF NOT private.reference_share_scope_within(v_scope, v_contribution.consent_scope) THEN
        PERFORM private.withdraw_shared_reference_contribution(
          v_contribution.id, 'consent_scope_exceeded'
        );
        RETURN private.shared_reference_contribution_result('consent_scope_exceeded');
      END IF;
    ELSIF NOT private.reference_share_scope_within(
            v_scope, private.reference_automatic_share_scope()
          ) THEN
      -- A shared automatic row is withdrawn (fail closed) rather than left
      -- serving a revision the source no longer matches. No opt-out is
      -- written, so a later in-scope refresh shares again.
      IF v_shared THEN
        PERFORM private.withdraw_shared_reference_contribution(
          v_contribution.id, 'snapshot_version_unsupported'
        );
      END IF;
      RETURN private.shared_reference_contribution_result('snapshot_version_unsupported');
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

-- 5. Stage 1B records the new status (body otherwise identical to 20261001113007) ----

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
      ELSIF v_status IN ('account_unavailable', 'source_out_of_bounds', 'moderation_hidden',
                         'snapshot_version_unsupported') THEN
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

-- 6. Ownership and execution surface (identical to the prior definitions) ---------

ALTER FUNCTION private.reference_accepts_snapshot_v2(integer[]) OWNER TO postgres;
ALTER FUNCTION private.reference_public_snapshot_project_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_public_item_for_versions(jsonb,boolean) OWNER TO postgres;
ALTER FUNCTION private.reference_automatic_share_scope() OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_reference_contribution(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid,integer[]) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution_v2(uuid,integer,integer[]) OWNER TO postgres;
ALTER FUNCTION public.search_public_observation_references(bigint[],integer[]) OWNER TO postgres;
ALTER FUNCTION public.get_public_observation_references(bigint,integer[]) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.reference_accepts_snapshot_v2(integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_public_snapshot_project_v1(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_public_item_for_versions(jsonb,boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_automatic_share_scope() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_reference_contribution(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid,integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution_v2(uuid,integer,integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_observation_references(bigint[],integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_observation_references(bigint,integer[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid,integer[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_reference_contribution_v2(uuid,integer,integer[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_observation_references(bigint[],integer[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_observation_references(bigint,integer[]) TO anon, authenticated, service_role;

COMMIT;
