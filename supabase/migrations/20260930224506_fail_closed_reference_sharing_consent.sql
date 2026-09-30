-- Stage 2a of docs/plans/active/2026-09-30-reference-sharing-consent.md:
-- shared reference data fails closed.
--
-- After this migration nothing becomes public without a consented
-- contribution, and old clients keep syncing:
--   * contributions carry a consent record (columns + bidirectional CHECKs),
--     an append-only consent event log and a consent-text table (no active
--     text yet, so nothing can be granted);
--   * a private grant/refresh core replaces the auto-sharing core; every
--     automatic path (use, source, taxon, observation triggers, Stage 1B)
--     calls it in refresh mode, which only adds revisions to an already
--     consented shared row, or withdraws;
--   * grant mode exists in the core but is not exposed (no new public RPC);
--     the old share RPC returns consent_required and changes nothing;
--   * every withdrawal goes through private.withdraw_shared_reference_contribution;
--   * public reads serve only consented rows and revisions >=
--     consent_first_revision; observation references are gated on a
--     consented contribution with a per-use content proof;
--   * new revisions carry contributor.id = NULL;
--   * the existing unconsented shared rows are withdrawn (count-agnostic).
--
-- Locking: every grant/refresh/withdraw path takes one transaction advisory
-- lock per (owner_id, source_measurement_set_id), in sorted set-id order when
-- a path covers several sets, and decides by re-reading uses and
-- observations under READ COMMITTED after it, without FOR SHARE and without
-- row-locking source rows.
--
-- This migration deliberately does not redefine the functions that the
-- deferred, hash-pinned 20260914090000 redefines
-- (reference_measurement_details_valid, reference_snapshot_valid,
-- reference_canonical_snapshot, public_reference_snapshot,
-- reference_curated_public_envelope, reference_curation_capture_candidate).
-- It only calls them.

BEGIN;

-- 1. Lock the contribution tables for the whole migration.
LOCK TABLE private.shared_reference_contributions,
           private.shared_reference_contribution_revisions
  IN ACCESS EXCLUSIVE MODE;

-- Consent scope helpers --------------------------------------------------

-- A scope is {"snapshot_schema_versions": [int...], "data_kinds": [text...]}
-- with data kinds drawn from raw_points, free_text, measurement_details.
CREATE FUNCTION private.reference_share_scope_valid(p_scope jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    pg_catalog.jsonb_typeof(p_scope) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(p_scope) k
       WHERE k NOT IN ('snapshot_schema_versions','data_kinds')
    )
    AND pg_catalog.jsonb_typeof(p_scope->'snapshot_schema_versions') = 'array'
    AND pg_catalog.jsonb_array_length(p_scope->'snapshot_schema_versions') >= 1
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_scope->'snapshot_schema_versions') v
       WHERE pg_catalog.jsonb_typeof(v) <> 'number'
          OR v::text !~ '^[1-9][0-9]{0,3}$'
    )
    AND pg_catalog.jsonb_typeof(p_scope->'data_kinds') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(p_scope->'data_kinds') d
       WHERE pg_catalog.jsonb_typeof(d) <> 'string'
          OR d #>> '{}' NOT IN ('raw_points','free_text','measurement_details')
    ),
    false
  )
$$;

-- The scope a concrete (final, projected) snapshot needs.
CREATE FUNCTION private.reference_share_snapshot_scope(p_snapshot jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'snapshot_schema_versions', pg_catalog.jsonb_build_array(p_snapshot->'schema_version'),
    'data_kinds', coalesce((
      SELECT pg_catalog.jsonb_agg(kind ORDER BY kind)
        FROM (
          SELECT 'raw_points'::text AS kind
           WHERE pg_catalog.jsonb_typeof(p_snapshot->'raw_points') = 'array'
          UNION ALL
          SELECT 'free_text'
           WHERE EXISTS (
             SELECT 1
               FROM pg_catalog.unnest(ARRAY[
                 p_snapshot->>'raw_text',
                 p_snapshot->>'locator_text',
                 p_snapshot->'method'->>'mount_medium',
                 p_snapshot->'method'->>'stain',
                 p_snapshot->'method'->>'preparation',
                 p_snapshot->'method'->>'measurement_method'
               ]) AS field
              WHERE nullif(pg_catalog.btrim(field), '') IS NOT NULL
           )
          UNION ALL
          SELECT 'measurement_details'
           WHERE p_snapshot ? 'measurement_details'
             AND pg_catalog.jsonb_typeof(p_snapshot->'measurement_details') <> 'null'
        ) kinds
    ), '[]'::jsonb)
  )
$$;

-- True when every schema version and data kind of p_inner is in p_outer.
CREATE FUNCTION private.reference_share_scope_within(p_inner jsonb, p_outer jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(
    private.reference_share_scope_valid(p_inner)
    AND private.reference_share_scope_valid(p_outer)
    AND (p_outer->'snapshot_schema_versions') @> (p_inner->'snapshot_schema_versions')
    AND (p_outer->'data_kinds') @> (p_inner->'data_kinds'),
    false
  )
$$;

-- Consent record -----------------------------------------------------------

ALTER TABLE private.shared_reference_contributions
  ADD COLUMN consented_at timestamptz,
  ADD COLUMN consent_version integer CHECK (consent_version IS NULL OR consent_version >= 1),
  ADD COLUMN consent_client text CHECK (
    consent_client IS NULL OR pg_catalog.char_length(consent_client) BETWEEN 1 AND 128
  ),
  ADD COLUMN consent_first_revision integer CHECK (
    consent_first_revision IS NULL OR consent_first_revision >= 1
  ),
  ADD COLUMN consent_scope jsonb CHECK (
    consent_scope IS NULL OR private.reference_share_scope_valid(consent_scope)
  );

CREATE TABLE private.reference_share_consent_texts (
  version integer NOT NULL CHECK (version >= 1),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  text text NOT NULL CHECK (pg_catalog.char_length(text) BETWEEN 1 AND 20000),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT false,
  revoked boolean NOT NULL DEFAULT false,
  scope jsonb NOT NULL CHECK (private.reference_share_scope_valid(scope)),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (version, locale),
  CHECK (text_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(text, 'UTF8')), 'hex')),
  CHECK (NOT (active AND revoked))
);

CREATE UNIQUE INDEX reference_share_consent_texts_one_active_per_locale
  ON private.reference_share_consent_texts(locale) WHERE active;

-- Append-only and holds no owner id, so account deletion leaves nothing here
-- to scrub.
CREATE TABLE private.shared_reference_consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contribution_id uuid NOT NULL
    REFERENCES private.shared_reference_contributions(id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event IN ('granted','withdrawn_by_owner','withdrawn_by_system')),
  reason text CHECK (reason IS NULL OR reason IN (
    'owner','consent_missing','observation_not_public','use_detached',
    'source_deleted','taxon_changed','consent_scope_exceeded',
    'consent_text_revoked','account_deleted'
  )),
  consent_version integer CHECK (consent_version IS NULL OR consent_version >= 1),
  locale text,
  text_sha256 text CHECK (text_sha256 IS NULL OR text_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((event = 'granted') = (reason IS NULL)),
  CHECK ((event = 'granted') = (locale IS NOT NULL AND text_sha256 IS NOT NULL)),
  CHECK (event <> 'granted' OR consent_version IS NOT NULL),
  CHECK ((event = 'withdrawn_by_owner') = (reason IS NOT DISTINCT FROM 'owner'))
);

CREATE INDEX shared_reference_consent_events_contribution_idx
  ON private.shared_reference_consent_events(contribution_id, id);

ALTER TABLE private.reference_share_consent_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.shared_reference_consent_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION private.reject_shared_reference_consent_event_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'shared reference consent events are append-only'
    USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER shared_reference_consent_events_append_only_trg
BEFORE UPDATE OR DELETE ON private.shared_reference_consent_events
FOR EACH ROW EXECUTE FUNCTION private.reject_shared_reference_consent_event_change();

CREATE TRIGGER shared_reference_consent_events_no_truncate_trg
BEFORE TRUNCATE ON private.shared_reference_consent_events
FOR EACH STATEMENT EXECUTE FUNCTION private.reject_shared_reference_consent_event_change();

-- Locking, predicate and withdrawal helpers --------------------------------

-- The one advisory lock key: (owner_id, source_measurement_set_id).
CREATE FUNCTION private.lock_shared_reference_key(p_owner uuid, p_set uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'shared-reference:' || p_owner::text || ':' || p_set::text, 7302
    )
  )
$$;

-- The live uses of (owner, set) that qualify for the exact taxon: the use is
-- live, the set, treatment and work are live, and the observation is public,
-- not a draft, has public spore data and carries the exact effective taxon.
-- The single definition of "qualifying use" (decision B).
CREATE FUNCTION private.reference_qualifying_use_ids(
  p_owner uuid,
  p_set uuid,
  p_taxon integer
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT u.id
    FROM public.observation_reference_uses u
    JOIN public.observations o
      ON o.user_id = u.user_id AND o.id = u.observation_id
    JOIN public.reference_measurement_sets m
      ON m.user_id = u.user_id AND m.id = u.reference_measurement_set_id
    JOIN public.reference_taxon_treatments t
      ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
    JOIN public.reference_works w
      ON w.user_id = t.user_id AND w.id = t.reference_work_id
   WHERE u.user_id = p_owner
     AND u.reference_measurement_set_id = p_set
     AND u.deleted_at IS NULL
     AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
     AND o.visibility = 'public'
     AND o.is_draft IS FALSE
     AND o.spore_data_visibility = 'public'
     AND coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id) = p_taxon
$$;

CREATE FUNCTION private.reference_set_has_qualifying_use(
  p_owner uuid,
  p_set uuid,
  p_taxon integer
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.reference_qualifying_use_ids(p_owner, p_set, p_taxon)
  )
$$;

-- The only statement that sets status = 'withdrawn'. Clears the consent
-- record, sets withdrawn_at and writes exactly one event. Does nothing (and
-- writes no event) when the row is not shared. Callers hold the key lock.
CREATE FUNCTION private.withdraw_shared_reference_contribution(
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

-- Withdraws every shared row of (owner, set) that has no qualifying use left.
-- Takes the key lock itself, then re-reads under READ COMMITTED. The reason
-- is derived from what is left, independent of who made the change.
CREATE FUNCTION private.withdraw_unqualified_contributions(p_owner uuid, p_set uuid)
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
    ELSIF EXISTS (
      SELECT 1
        FROM public.observation_reference_uses u
       WHERE u.user_id = p_owner AND u.reference_measurement_set_id = p_set
         AND u.deleted_at IS NULL
    ) THEN
      v_reason := 'taxon_changed';
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

-- Envelope: contributor.id is NULL in every new revision (decision F).
CREATE OR REPLACE FUNCTION private.shared_reference_contribution_envelope(
  p_contribution_id uuid,
  p_revision integer,
  p_taxon_id integer,
  p_canonical_name text,
  p_owner_id uuid,
  p_snapshot jsonb,
  p_candidate jsonb,
  p_shared_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_work jsonb := p_candidate->'work';
  v_citation jsonb;
  v_exports jsonb;
  v_label text;
  v_citation_key text := 'sporely-contribution-' || pg_catalog.replace(p_contribution_id::text, '-', '');
BEGIN
  IF p_contribution_id IS NULL OR p_revision < 1 OR p_taxon_id < 1
     OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
     OR pg_catalog.jsonb_typeof(v_work) <> 'object' THEN
    RETURN NULL;
  END IF;
  SELECT CASE
           WHEN nullif(pg_catalog.btrim(p.username), '') IS NULL THEN 'Sporely user'
           WHEN p.username LIKE '%@%' THEN 'Sporely user'
           ELSE p.username
         END
    INTO v_label
    FROM public.profiles p
   WHERE p.id=p_owner_id;
  p_snapshot := p_snapshot || pg_catalog.jsonb_build_object(
    'reference_work_id', extensions.uuid_generate_v5(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
      p_contribution_id::text || ':work'
    ),
    'reference_treatment_id', extensions.uuid_generate_v5(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
      p_contribution_id::text || ':treatment'
    ),
    'reference_measurement_set_id', p_contribution_id,
    'reference_revision', p_revision
  );
  v_citation := v_work || pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'citation_key', v_citation_key,
    'short_citation', p_snapshot->'short_label',
    'full_citation', p_snapshot->'full_citation'
  );
  v_exports := private.reference_curated_build_citation_exports(
    v_citation, p_contribution_id
  );
  RETURN pg_catalog.jsonb_build_object(
    'contribution_id', p_contribution_id,
    'revision', p_revision,
    'status', 'shared',
    'shared_at', p_shared_at,
    'sporely_taxon_id', p_taxon_id,
    'canonical_scientific_name', p_canonical_name,
    'contributor', pg_catalog.jsonb_build_object(
      'id', NULL,
      'label', coalesce(nullif(pg_catalog.btrim(v_label), ''), 'Sporely user')
    ),
    'snapshot', p_snapshot,
    'citation', v_citation,
    'exports', pg_catalog.jsonb_build_object(
      'plain_text', v_exports->>'plain_text',
      'bibtex', v_exports->>'bibtex',
      'csl_json', (v_exports->>'csl_json')::jsonb
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

-- 2. The grant/refresh core -------------------------------------------------
--
-- p_mode = 'refresh': never creates a row, never sets consent, never moves a
-- withdrawn row back to shared. It ignores the caller's revisions, reads the
-- current source after taking the key lock, and either adds a revision to a
-- consented shared row (within its consent_scope) or withdraws it.
-- p_mode = 'grant': the only mode that creates a row, records consent or
-- re-shares a withdrawn row (new consent period). Not exposed in 2a: no role
-- but the owner (postgres) can execute this function.
CREATE FUNCTION private.reference_contribution_share_core(
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
      consented_at, consent_version, consent_client,
      consent_first_revision, consent_scope
    ) VALUES (
      v_owner, p_source_measurement_set_id, p_sporely_taxon_id,
      'shared', 1, v_now, v_now,
      v_now, v_text.version, p_consent_client, 1, v_text.scope
    ) RETURNING * INTO v_contribution;
    v_revision := 1;
  ELSIF v_contribution.status = 'shared' THEN
    IF p_mode = 'grant' THEN
      -- Renewed consent within the current period: the period (and so
      -- consent_first_revision) is unchanged.
      UPDATE private.shared_reference_contributions
         SET consented_at = v_now, consent_version = v_text.version,
             consent_client = p_consent_client, consent_scope = v_text.scope,
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
           consent_client = p_consent_client,
           consent_first_revision = v_revision, consent_scope = v_text.scope
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

-- The existing 6-argument entry point stays, as a refresh-only wrapper, so
-- every existing caller keeps its signature. The expected revisions are
-- ignored: refresh reads the current revisions after the key lock.
CREATE OR REPLACE FUNCTION private.share_reference_contribution_for_owner(
  p_owner uuid,
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.reference_contribution_share_core(
    'refresh', p_owner, p_source_measurement_set_id, p_sporely_taxon_id
  );
END
$$;

-- The old explicit RPC no longer shares: consent is recorded only by the
-- (2b) consent RPC.
CREATE OR REPLACE FUNCTION public.share_reference_contribution_unthrottled(
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN private.shared_reference_contribution_result('consent_required');
END
$$;

-- Owner withdrawal: read owner and set unlocked, check ownership, take the
-- key lock, then lock the row and check again.
CREATE OR REPLACE FUNCTION public.withdraw_reference_contribution_unthrottled(p_contribution_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_row private.shared_reference_contributions%ROWTYPE;
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
  PERFORM private.lock_shared_reference_key(v_row.owner_id, v_row.source_measurement_set_id);
  SELECT * INTO v_row FROM private.shared_reference_contributions c
   WHERE c.id = p_contribution_id FOR UPDATE;
  IF NOT FOUND OR v_row.owner_id IS DISTINCT FROM v_owner THEN
    RETURN private.shared_reference_contribution_result('forbidden');
  END IF;
  IF v_row.status = 'withdrawn' THEN
    RETURN private.shared_reference_contribution_result('no_change');
  END IF;
  PERFORM private.withdraw_shared_reference_contribution(p_contribution_id, 'owner');
  RETURN private.shared_reference_contribution_result('updated');
END
$$;

-- Account deletion: withdraw through the helper (system event), then
-- anonymise as before.
CREATE OR REPLACE FUNCTION private.anonymize_shared_reference_contributions_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT c.id, c.source_measurement_set_id
      FROM private.shared_reference_contributions c
     WHERE c.owner_id = OLD.id AND c.status = 'shared'
     ORDER BY c.source_measurement_set_id, c.id
  LOOP
    PERFORM private.lock_shared_reference_key(OLD.id, v_row.source_measurement_set_id);
    PERFORM private.withdraw_shared_reference_contribution(v_row.id, 'account_deleted');
  END LOOP;
  UPDATE private.shared_reference_contribution_revisions r
     SET envelope_json = pg_catalog.jsonb_set(
       pg_catalog.jsonb_set(
         r.envelope_json, '{contributor,id}', 'null'::jsonb, false
       ),
       '{contributor,label}', pg_catalog.to_jsonb('Deleted user'::text), false
     )
    FROM private.shared_reference_contributions c
   WHERE c.id=r.contribution_id AND c.owner_id=OLD.id;
  UPDATE private.shared_reference_contributions
     SET owner_id=NULL, source_measurement_set_id=NULL,
         hidden_at=NULL, hidden_reason=NULL,
         updated_at=pg_catalog.clock_timestamp()
   WHERE owner_id=OLD.id;
  RETURN OLD;
END
$$;

-- Public contribution reads: consented rows and consent-period revisions only.
CREATE OR REPLACE FUNCTION public.search_public_reference_contributions_unthrottled(
  p_sporely_taxon_id integer,
  p_limit integer,
  p_after_shared_at timestamptz,
  p_after_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_sporely_taxon_id IS NULL OR p_sporely_taxon_id <= 0 THEN
    RAISE EXCEPTION 'positive sporely_taxon_id is required' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;
  IF (p_after_shared_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor components are required' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT c.id,c.shared_at,r.envelope_json
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id=c.id AND r.revision=c.current_revision
      JOIN public.profiles p ON p.id=c.owner_id AND p.is_banned IS FALSE
     WHERE c.sporely_taxon_id=p_sporely_taxon_id
       AND c.status='shared' AND c.hidden_at IS NULL
       AND c.consented_at IS NOT NULL
       AND r.revision >= c.consent_first_revision
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id=c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(),c.owner_id) IS NOT TRUE)
       AND (p_after_shared_at IS NULL OR c.shared_at < p_after_shared_at
         OR (c.shared_at=p_after_shared_at AND c.id > p_after_id))
     ORDER BY c.shared_at DESC,c.id ASC
     LIMIT p_limit
  ), bounded AS (
    SELECT candidates.*,
           pg_catalog.sum(pg_catalog.octet_length(envelope_json::text)) OVER (
             ORDER BY shared_at DESC,id ASC
           ) AS cumulative_bytes
      FROM candidates
  )
  SELECT envelope_json FROM bounded WHERE cumulative_bytes <= 1048576
   ORDER BY shared_at DESC,id ASC;
END
$$;

CREATE OR REPLACE FUNCTION public.get_public_reference_contribution_unthrottled(
  p_contribution_id uuid,
  p_revision integer DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
    -- Unchanged tombstone stub; it carries no account data.
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
  -- A shared row serves only consented revisions of its current period; a
  -- pre-consent revision is answered like an unknown one.
  IF v_contribution.consented_at IS NULL
     OR v_revision < v_contribution.consent_first_revision THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.envelope_json
    FROM private.shared_reference_contribution_revisions r
    JOIN public.profiles p ON p.id = v_contribution.owner_id AND p.is_banned IS FALSE
   WHERE r.contribution_id = p_contribution_id AND r.revision = v_revision
     AND NOT EXISTS (
       SELECT 1 FROM private.reference_account_deletions d
        WHERE d.user_id = v_contribution.owner_id
     )
     AND (auth.uid() IS NULL
       OR public.is_blocked_between(auth.uid(), v_contribution.owner_id) IS NOT TRUE)
     AND pg_catalog.octet_length(r.envelope_json::text) <= 1048576;
END
$$;

-- Observation references (decision E): a use is served only when it itself
-- qualifies, its owner has a consented, unhidden shared contribution for
-- (owner, set, the observation's exact taxon), the owner is not banned,
-- deleting or blocked with the caller, and its publicly projected frozen
-- snapshot equals the snapshot of some consented revision once the four
-- identity keys the envelope rewrites are stripped from both sides.
-- Output shape is unchanged.
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
    SELECT o.id, o.user_id,
           coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer AS taxon_id
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
        WHERE u.id IS NOT NULL AND sanitized.snapshot IS NOT NULL
          AND consented.ok IS TRUE
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
    SELECT true AS ok
      FROM private.shared_reference_contributions c
      JOIN public.profiles p ON p.id=c.owner_id AND p.is_banned IS FALSE
     WHERE c.owner_id=u.user_id
       AND c.source_measurement_set_id=u.reference_measurement_set_id
       AND c.sporely_taxon_id=e.taxon_id
       AND c.status='shared'
       AND c.consented_at IS NOT NULL
       AND c.hidden_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id=c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(),c.owner_id) IS NOT TRUE)
       AND u.id IN (
         SELECT q.id FROM private.reference_qualifying_use_ids(
           c.owner_id, c.source_measurement_set_id, c.sporely_taxon_id
         ) AS q(id)
       )
       AND EXISTS (
         SELECT 1 FROM private.shared_reference_contribution_revisions r
          WHERE r.contribution_id=c.id
            AND r.revision >= c.consent_first_revision
            AND (r.envelope_json->'snapshot')
                  - ARRAY['reference_work_id','reference_treatment_id',
                          'reference_measurement_set_id','reference_revision']
                = sanitized.snapshot
                  - ARRAY['reference_work_id','reference_treatment_id',
                          'reference_measurement_set_id','reference_revision']
       )
     LIMIT 1
  ) consented ON u.id IS NOT NULL AND sanitized.snapshot IS NOT NULL
  GROUP BY e.id
  ORDER BY e.id;
END
$$;

-- Automatic paths ------------------------------------------------------------

-- Per use: best-effort publish (refresh only) for the owner or service role,
-- then the withdrawal decision outside the error-swallowing block, for every
-- caller.
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
    IF v_taxon_id IS NOT NULL THEN
      BEGIN
        PERFORM private.share_reference_contribution_for_owner(
          p_use.user_id,p_use.reference_measurement_set_id,v_taxon_id,NULL,NULL,NULL
        );
      EXCEPTION WHEN OTHERS THEN
        -- Only adding a revision is best-effort; a failure keeps the last
        -- consented revision and never rolls back the owner's sync.
        NULL;
      END;
    END IF;
  END IF;
  PERFORM private.withdraw_unqualified_contributions(
    p_use.user_id, p_use.reference_measurement_set_id
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
      PERFORM private.withdraw_unqualified_contributions(v_user_id, v_set);
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
$$;

-- Source edits and deletions. Publish (refresh) stays owner-only as before;
-- the withdrawal decision runs for every caller, with no early return before
-- it.
CREATE OR REPLACE FUNCTION private.refresh_shared_references_for_measurement_set()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_use public.observation_reference_uses%ROWTYPE;
BEGIN
  PERFORM private.lock_shared_reference_key(NEW.user_id, NEW.id);
  IF NEW.deleted_at IS NULL AND auth.uid() IS NOT NULL AND auth.uid() = NEW.user_id THEN
    FOR v_use IN
      SELECT u.* FROM public.observation_reference_uses u
       WHERE u.user_id=NEW.user_id
         AND u.reference_measurement_set_id=NEW.id
         AND u.deleted_at IS NULL
       ORDER BY u.id
    LOOP
      PERFORM private.refresh_shared_reference_for_use_row(v_use);
    END LOOP;
  END IF;
  PERFORM private.withdraw_unqualified_contributions(NEW.user_id, NEW.id);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION private.refresh_shared_references_for_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_set uuid;
  v_use public.observation_reference_uses%ROWTYPE;
  v_publish boolean := NEW.deleted_at IS NULL
    AND auth.uid() IS NOT NULL AND auth.uid() = NEW.user_id;
BEGIN
  -- Every set under this treatment or work, in sorted set-id order.
  FOR v_set IN
    SELECT m.id
      FROM public.reference_measurement_sets m
      JOIN public.reference_taxon_treatments t
        ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
     WHERE m.user_id=NEW.user_id
       AND (
         (TG_TABLE_NAME='reference_taxon_treatments' AND t.id=NEW.id)
         OR (TG_TABLE_NAME='reference_works' AND t.reference_work_id=NEW.id)
       )
     ORDER BY m.id
  LOOP
    PERFORM private.lock_shared_reference_key(NEW.user_id, v_set);
    IF v_publish THEN
      FOR v_use IN
        SELECT u.* FROM public.observation_reference_uses u
         WHERE u.user_id=NEW.user_id AND u.reference_measurement_set_id=v_set
           AND u.deleted_at IS NULL
         ORDER BY u.id
      LOOP
        PERFORM private.refresh_shared_reference_for_use_row(v_use);
      END LOOP;
    END IF;
    PERFORM private.withdraw_unqualified_contributions(NEW.user_id, v_set);
  END LOOP;
  RETURN NEW;
END
$$;

-- Taxon change: withdraw what no longer qualifies (every caller), then
-- refresh (never create) under the new taxon for the owner or service role.
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
      NEW.user_id, v_use.reference_measurement_set_id
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

-- New: visibility, spore-data visibility, draft and deletion of an
-- observation withdraw the contributions it alone backed, for every caller
-- (including the service-role moderation hide).
CREATE FUNCTION private.withdraw_shared_references_for_observation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_set uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The uses are already gone (ON DELETE CASCADE), so re-check every
    -- shared contribution of the owner.
    FOR v_set IN
      SELECT DISTINCT c.source_measurement_set_id
        FROM private.shared_reference_contributions c
       WHERE c.owner_id=OLD.user_id AND c.status='shared'
       ORDER BY c.source_measurement_set_id
    LOOP
      PERFORM private.withdraw_unqualified_contributions(OLD.user_id, v_set);
    END LOOP;
    RETURN OLD;
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
    PERFORM private.withdraw_unqualified_contributions(NEW.user_id, v_set);
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER observation_visibility_shared_contribution_trg
AFTER UPDATE OF is_draft, visibility, spore_data_visibility ON public.observations
FOR EACH ROW EXECUTE FUNCTION private.withdraw_shared_references_for_observation();

CREATE TRIGGER observation_delete_shared_contribution_trg
AFTER DELETE ON public.observations
FOR EACH ROW EXECUTE FUNCTION private.withdraw_shared_references_for_observation();

-- Source triggers now also fire on a deleted_at-only update.
DROP TRIGGER reference_measurement_set_shared_contribution_trg ON public.reference_measurement_sets;
DROP TRIGGER reference_treatment_shared_contribution_trg ON public.reference_taxon_treatments;
DROP TRIGGER reference_work_shared_contribution_trg ON public.reference_works;

CREATE TRIGGER reference_measurement_set_shared_contribution_trg
AFTER UPDATE OF revision, deleted_at ON public.reference_measurement_sets
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_measurement_set();

CREATE TRIGGER reference_treatment_shared_contribution_trg
AFTER UPDATE OF revision, deleted_at ON public.reference_taxon_treatments
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_parent();

CREATE TRIGGER reference_work_shared_contribution_trg
AFTER UPDATE OF revision, deleted_at ON public.reference_works
FOR EACH ROW EXECUTE FUNCTION private.refresh_shared_references_for_parent();

-- Stage 1B reconcile: refresh only; records consent_required and the other
-- refresh statuses instead of raising; the old-taxon branch uses the
-- qualifying-use predicate and the withdrawal helper.
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
  -- Every candidate had selected_sporely_taxon_id NULL (CHECK), so the
  -- effective taxon before the UPDATE was resolved_sporely_taxon_id.
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

    -- Old taxon: withdraw unless another qualifying use still carries it.
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
      IF FOUND THEN
        PERFORM private.withdraw_shared_reference_contribution(v_contribution_id, 'taxon_changed');
        IF EXISTS (
          SELECT 1 FROM private.shared_reference_contributions c
           WHERE c.id = v_contribution_id AND c.status = 'shared'
        ) THEN
          RAISE EXCEPTION 'contribution for set % under old taxon % is still shared', v_set, v_old;
        END IF;
        v_old_action := 'withdrawn';
      ELSE
        v_old_action := 'none';
      END IF;
    END IF;

    -- New taxon: refresh (never create) when it is a registry species and
    -- the source is live. Labels for non-registry taxa are unchanged.
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
      ELSIF v_status IN ('consent_required', 'consent_scope_exceeded', 'withdrawn_unqualified') THEN
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
        -- Not shareable on the owner path either; recorded, not an error.
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

-- 3. Data step (decision A): withdraw every shared row without consent,
-- through the withdrawal helper. Count-agnostic; the production preflight
-- asserts the expected count before the push. Publishes nothing.
SELECT private.withdraw_shared_reference_contribution(c.id, 'consent_missing')
  FROM private.shared_reference_contributions c
 WHERE c.status = 'shared' AND c.consented_at IS NULL
 ORDER BY c.owner_id, c.source_measurement_set_id, c.sporely_taxon_id, c.id;

-- 4. The consent invariants.
ALTER TABLE private.shared_reference_contributions
  ADD CONSTRAINT shared_reference_contributions_shared_iff_consented
    CHECK ((status = 'shared') = (consented_at IS NOT NULL)),
  ADD CONSTRAINT shared_reference_contributions_consent_all_or_none
    CHECK (
      (consented_at IS NULL AND consent_version IS NULL
        AND consent_first_revision IS NULL AND consent_scope IS NULL)
      OR (consented_at IS NOT NULL AND consent_version IS NOT NULL
        AND consent_first_revision IS NOT NULL AND consent_scope IS NOT NULL)
    ),
  ADD CONSTRAINT shared_reference_contributions_consent_client_needs_consent
    CHECK (consent_client IS NULL OR consented_at IS NOT NULL),
  ADD CONSTRAINT shared_reference_contributions_consent_period_bound
    CHECK (consent_first_revision IS NULL OR consent_first_revision <= current_revision);

-- Ownership and execution surface ------------------------------------------

ALTER TABLE private.reference_share_consent_texts OWNER TO postgres;
ALTER TABLE private.shared_reference_consent_events OWNER TO postgres;
REVOKE ALL ON TABLE private.reference_share_consent_texts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.shared_reference_consent_events FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION private.reference_share_scope_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_share_snapshot_scope(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_share_scope_within(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION private.reject_shared_reference_consent_event_change() OWNER TO postgres;
ALTER FUNCTION private.lock_shared_reference_key(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.reference_qualifying_use_ids(uuid,uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.reference_set_has_qualifying_use(uuid,uuid,integer) OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_reference_contribution(uuid,text) OWNER TO postgres;
ALTER FUNCTION private.withdraw_unqualified_contributions(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) OWNER TO postgres;
ALTER FUNCTION private.withdraw_shared_references_for_observation() OWNER TO postgres;
ALTER FUNCTION private.shared_reference_contribution_envelope(uuid,integer,integer,text,uuid,jsonb,jsonb,timestamptz) OWNER TO postgres;
ALTER FUNCTION private.share_reference_contribution_for_owner(uuid,uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.share_reference_contribution_unthrottled(uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.withdraw_reference_contribution_unthrottled(uuid) OWNER TO postgres;
ALTER FUNCTION private.anonymize_shared_reference_contributions_for_profile() OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution_unthrottled(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.search_public_observation_references(bigint[]) OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_reference_for_use_row(public.observation_reference_uses) OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_reference_for_use() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_measurement_set() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_parent() OWNER TO postgres;
ALTER FUNCTION private.refresh_shared_references_for_observation_taxon() OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_reconcile_references(bigint, bigint) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.reference_share_scope_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_share_snapshot_scope(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_share_scope_within(jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reject_shared_reference_consent_event_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.lock_shared_reference_key(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_qualifying_use_ids(uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_set_has_qualifying_use(uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_reference_contribution(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_unqualified_contributions(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_contribution_share_core(text,uuid,uuid,integer,integer,integer,integer,integer,text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.withdraw_shared_references_for_observation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.shared_reference_contribution_envelope(uuid,integer,integer,text,uuid,jsonb,jsonb,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.share_reference_contribution_for_owner(uuid,uuid,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.share_reference_contribution_unthrottled(uuid,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.withdraw_reference_contribution_unthrottled(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.anonymize_shared_reference_contributions_for_profile() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution_unthrottled(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_reference_for_use_row(public.observation_reference_uses) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_reference_for_use() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_measurement_set() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_parent() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.refresh_shared_references_for_observation_taxon() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_reconcile_references(bigint, bigint) FROM PUBLIC, anon, authenticated, service_role;

-- search_public_observation_references keeps its existing grants (CREATE OR
-- REPLACE preserves them): anon, authenticated, service_role; not PUBLIC.
REVOKE ALL ON FUNCTION public.search_public_observation_references(bigint[]) FROM PUBLIC;

COMMIT;
