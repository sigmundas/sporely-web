-- Curated forks may be sourced from a shared reference contribution.
--
-- Since default reference sharing (20261001113007) the desktop catalogue
-- lists shared contributions (search/get_public_reference_contribution_v2),
-- and a copy pushes a fork whose source is that contribution: sporely-py
-- database/curated_reference_forks.py normalize_curated_bundle sends
-- contribution_id as curated_measurement_set_id, revision as
-- bundle_revision, and as source_envelope_json the served envelope without
-- the live relationship_roles. The previous definition accepted only legacy
-- curated publications, so every such push returned invalid_source.
--
-- Owner decision (a): the copier keeps the copy and its provenance even if
-- the contributor later stops sharing, moderation hides the contribution or
-- the contributor deletes their account.
--
-- Stored contribution envelope (owner option B): the served revision
-- envelope (envelope_json) with contributor and relationship_roles removed;
-- source_sha256 = sha256 of exactly the stored source_envelope_json text.
-- The client envelope is validated ignoring contributor and is never
-- stored; the client's sha256 must still match the client text.
-- Creation requires the contribution revision to be shared and served to the
-- caller at that moment, with the client envelope equal to the server's
-- revision envelope apart from contributor; an existing fork is never
-- re-validated (the idempotent no_change/conflict lookup precedes source
-- validation).
--
-- Old readers: released desktops (sporely-py v0.9.24) read forks with a
-- plain table GET and abort the whole curated pull on the first row their
-- frozen-envelope validator rejects (a contributor-less contribution
-- envelope), and since Stage M a failed curated pull skips every reference
-- push. A restrictive SELECT policy therefore hides contribution-kind forks
-- from direct table reads; capable clients read them through
-- list_reference_library_feed('curated_fork') (SECURITY DEFINER, owner
-- filter, unaffected). Omission is harmless to v0.9.24: its pull only
-- inserts/updates rows it receives and never deletes or pushes on absence.
--
-- Self-forks: the legacy path has no contributor concept and no self-fork
-- rule, so a caller may fork their own served contribution (same semantics).
-- Payload, owner, SECURITY DEFINER, search_path, grants and (absent) rate
-- limiting are unchanged. The legacy curated-publication path is unchanged
-- and is chosen whenever a publication exists at the identity.
--
-- Schema: reference_curated_forks gains source_kind. The source FK becomes
-- per-kind through two generated columns (NULL for the other kind, so MATCH
-- SIMPLE skips it): curated publications keep their RESTRICT FK to
-- publication taxa; contribution sources reference the immutable revision
-- row (revisions are never deleted; a contributor's account deletion only
-- nulls owner_id). RLS (owner select + Stage M restrictive v1 policy) and
-- grants are untouched.
-- Rollback: supabase/rollbacks/20261002150000_rollback.sql.
-- Snapshot schema_version must be 1 or 2 (parity with
-- private.reference_public_item_for_versions).

BEGIN;

ALTER TABLE public.reference_curated_forks
  ADD COLUMN source_kind text NOT NULL DEFAULT 'curated_publication'
    CHECK (source_kind IN ('curated_publication','shared_contribution')),
  ADD COLUMN curated_publication_set_id uuid GENERATED ALWAYS AS (
    CASE WHEN source_kind = 'curated_publication' THEN curated_measurement_set_id END
  ) STORED,
  ADD COLUMN shared_contribution_id uuid GENERATED ALWAYS AS (
    CASE WHEN source_kind = 'shared_contribution' THEN curated_measurement_set_id END
  ) STORED;

ALTER TABLE public.reference_curated_forks
  DROP CONSTRAINT reference_curated_forks_curated_measurement_set_id_bundle__fkey,
  ADD CONSTRAINT reference_curated_forks_publication_source_fkey
    FOREIGN KEY (curated_publication_set_id, bundle_revision, sporely_taxon_id)
    REFERENCES private.curated_reference_publication_taxa(
      curated_measurement_set_id, bundle_revision, sporely_taxon_id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT reference_curated_forks_contribution_source_fkey
    FOREIGN KEY (shared_contribution_id, bundle_revision)
    REFERENCES private.shared_reference_contribution_revisions(contribution_id, revision)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.sync_reference_curated_fork(
  p_payload jsonb,
  p_expected_row_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_curated_set_id uuid;
  v_bundle_revision integer;
  v_taxon_id integer;
  v_work_id uuid;
  v_treatment_id uuid;
  v_set_id uuid;
  v_source_sha256 text;
  v_source_envelope_text text;
  v_source_envelope jsonb;
  v_expected_envelope jsonb;
  v_source_status text;
  v_source_successor_id uuid;
  v_current_successor_id uuid;
  v_source_canonical_name text;
  v_current public.reference_curated_forks%ROWTYPE;
  v_source_kind text;
  v_contribution private.shared_reference_contributions%ROWTYPE;
  v_served_envelope jsonb;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0
     OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
     OR private.reference_payload_has_unknown_keys(p_payload, ARRAY[
       'curated_measurement_set_id','bundle_revision','sporely_taxon_id',
       'reference_work_id','taxon_treatment_id','reference_measurement_set_id',
       'source_sha256','source_envelope_json'
     ])
  THEN
    RETURN private.reference_result('invalid_payload');
  END IF;

  BEGIN
    v_curated_set_id := (p_payload->>'curated_measurement_set_id')::uuid;
    v_bundle_revision := (p_payload->>'bundle_revision')::integer;
    v_taxon_id := (p_payload->>'sporely_taxon_id')::integer;
    v_work_id := (p_payload->>'reference_work_id')::uuid;
    v_treatment_id := (p_payload->>'taxon_treatment_id')::uuid;
    v_set_id := (p_payload->>'reference_measurement_set_id')::uuid;
    v_source_sha256 := p_payload->>'source_sha256';
    v_source_envelope_text := p_payload->>'source_envelope_json';
  EXCEPTION WHEN OTHERS THEN
    RETURN private.reference_result('invalid_payload');
  END;
  IF v_bundle_revision < 1 OR v_taxon_id < 1
     OR v_source_sha256 IS NULL OR v_source_sha256 !~ '^[0-9a-f]{64}$'
     OR v_source_envelope_text IS NULL
     OR pg_catalog.octet_length(v_source_envelope_text) NOT BETWEEN 2 AND 1048576
  THEN
    RETURN private.reference_result('invalid_payload');
  END IF;
  IF pg_catalog.encode(extensions.digest(
       pg_catalog.convert_to(v_source_envelope_text,'UTF8'),'sha256'
     ),'hex') IS DISTINCT FROM v_source_sha256 THEN
    RETURN private.reference_result('invalid_source');
  END IF;
  BEGIN
    v_source_envelope := v_source_envelope_text::jsonb;
    IF pg_catalog.jsonb_typeof(v_source_envelope) <> 'object' THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    v_source_status := v_source_envelope->>'status';
    v_source_successor_id := nullif(v_source_envelope->>'superseded_by_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN private.reference_result('invalid_source');
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text, 7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id = v_owner) THEN
    RETURN private.reference_result('account_deleting');
  END IF;

  SELECT * INTO v_current
    FROM public.reference_curated_forks
   WHERE user_id = v_owner
     AND curated_measurement_set_id = v_curated_set_id
     AND bundle_revision = v_bundle_revision
   FOR UPDATE;
  IF FOUND AND v_current.source_kind = 'shared_contribution' THEN
    -- The stored envelope is the server-built form (no contributor), so a
    -- re-push compares the client envelope with contributor removed; the
    -- client text and sha256 are not what is stored.
    IF v_current.sporely_taxon_id = v_taxon_id
       AND v_current.reference_work_id = v_work_id
       AND v_current.taxon_treatment_id = v_treatment_id
       AND v_current.reference_measurement_set_id = v_set_id
       AND v_current.source_envelope_json::jsonb = (v_source_envelope - 'contributor')
    THEN
      RETURN private.reference_result('no_change', pg_catalog.to_jsonb(v_current));
    END IF;
    RETURN private.reference_result('conflict', pg_catalog.to_jsonb(v_current));
  END IF;
  IF FOUND THEN
    IF v_current.sporely_taxon_id = v_taxon_id
       AND v_current.reference_work_id = v_work_id
       AND v_current.taxon_treatment_id = v_treatment_id
       AND v_current.reference_measurement_set_id = v_set_id
       AND v_current.source_sha256 = v_source_sha256
       AND v_current.source_envelope_json = v_source_envelope_text
    THEN
      RETURN private.reference_result('no_change', pg_catalog.to_jsonb(v_current));
    END IF;
    RETURN private.reference_result('conflict', pg_catalog.to_jsonb(v_current));
  END IF;
  IF p_expected_row_version <> 0 THEN
    RETURN private.reference_result('conflict');
  END IF;

  -- Source kind: a legacy curated publication when one exists at this
  -- identity (that path is unchanged, only indented), otherwise a shared
  -- contribution revision. sporely-py normalize_curated_bundle sends the
  -- contribution_id as curated_measurement_set_id and its revision as
  -- bundle_revision.
  IF EXISTS (
    SELECT 1 FROM private.curated_reference_publications p
     WHERE p.curated_measurement_set_id = v_curated_set_id
       AND p.bundle_revision = v_bundle_revision
  ) THEN
    v_source_kind := 'curated_publication';
    SELECT pt.canonical_name
      INTO v_source_canonical_name
      FROM private.curated_reference_publications p
      JOIN private.curated_reference_publication_taxa pt
        ON pt.curated_measurement_set_id = p.curated_measurement_set_id
       AND pt.bundle_revision = p.bundle_revision
     WHERE p.curated_measurement_set_id = v_curated_set_id
       AND p.bundle_revision = v_bundle_revision
       AND pt.sporely_taxon_id = v_taxon_id;
    IF NOT FOUND THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    SELECT successor.id INTO v_current_successor_id
      FROM private.curated_reference_measurement_sets successor
     WHERE successor.supersedes_id = v_curated_set_id
       AND successor.catalogue_status IN ('published','deprecated')
       AND EXISTS (
         SELECT 1 FROM private.curated_reference_publications successor_publication
          WHERE successor_publication.curated_measurement_set_id = successor.id
            AND successor_publication.bundle_revision = successor.latest_bundle_revision
       )
     ORDER BY successor.id
     LIMIT 1;
    IF v_source_status NOT IN ('published','deprecated')
       OR (v_source_status = 'published' AND v_source_successor_id IS NOT NULL)
       OR (v_source_status = 'deprecated' AND NOT EXISTS (
         SELECT 1 FROM private.curated_reference_measurement_sets source_set
          WHERE source_set.id = v_curated_set_id AND source_set.deprecated_at IS NOT NULL
       ))
       OR (v_source_status = 'deprecated'
           AND v_source_successor_id IS DISTINCT FROM v_current_successor_id)
    THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    v_expected_envelope := private.reference_curated_public_envelope(
      v_curated_set_id,v_bundle_revision,v_source_status,v_source_successor_id
    );
    IF v_expected_envelope IS NULL THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    v_expected_envelope := v_expected_envelope || pg_catalog.jsonb_build_object(
      'sporely_taxon_id',v_taxon_id,
      'canonical_scientific_name',v_source_canonical_name
    );
    IF v_source_envelope IS DISTINCT FROM v_expected_envelope THEN
      RETURN private.reference_result('invalid_source');
    END IF;
  ELSE
    v_source_kind := 'shared_contribution';
    -- The client envelope is the served envelope without the live
    -- relationship_roles, with or without contributor (ignored, never
    -- stored). A version-1 projection (Stage A marker
    -- measurement_details_omitted) is lossy and never a frozen source.
    IF v_source_envelope ? 'measurement_details_omitted'
       OR v_source_envelope ? 'relationship_roles' THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    SELECT * INTO v_contribution
      FROM private.shared_reference_contributions c
     WHERE c.id = v_curated_set_id;
    -- Valid and served AT CREATION, exactly as
    -- get_public_reference_contribution_v2 would serve this revision to the
    -- caller: shared (not withdrawn), not hidden, owner not opted out,
    -- banned, deleting or blocked, revision within the current sharing
    -- period. A later stop-sharing or hide never invalidates an existing
    -- fork: the idempotent lookup above returns before this point.
    IF NOT FOUND
       OR v_contribution.status <> 'shared'
       OR v_contribution.sporely_taxon_id IS DISTINCT FROM v_taxon_id
       OR v_bundle_revision < v_contribution.shared_first_revision
       OR v_bundle_revision > v_contribution.current_revision
       OR NOT private.reference_contribution_is_served(v_curated_set_id, false)
    THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    SELECT r.envelope_json INTO v_served_envelope
      FROM private.shared_reference_contribution_revisions r
     WHERE r.contribution_id = v_curated_set_id
       AND r.revision = v_bundle_revision
       AND pg_catalog.octet_length(r.envelope_json::text) <= 1048576;
    IF v_served_envelope IS NULL
       OR (v_served_envelope->'snapshot'->'schema_version') IS NULL
       OR (v_served_envelope->'snapshot'->'schema_version') NOT IN ('1'::jsonb,'2'::jsonb)
       OR (v_source_envelope - 'contributor')
          IS DISTINCT FROM (v_served_envelope - 'contributor') THEN
      RETURN private.reference_result('invalid_source');
    END IF;
    -- Persisted provenance: the served revision envelope without
    -- contributor (and without relationship_roles, never in envelope_json).
    -- No contributor identity or label is stored, so contributor account
    -- deletion needs no rewrite of fork rows. source_sha256 is computed over
    -- the stored text, as the legacy path stores sha256(stored text).
    v_source_envelope_text := (v_served_envelope - 'contributor')::text;
    v_source_sha256 := pg_catalog.encode(extensions.digest(
      pg_catalog.convert_to(v_source_envelope_text,'UTF8'),'sha256'
    ),'hex');
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.reference_measurement_sets m
      JOIN public.reference_taxon_treatments t
        ON t.user_id = m.user_id AND t.id = m.taxon_treatment_id
      JOIN public.reference_works w
        ON w.user_id = t.user_id AND w.id = t.reference_work_id
     WHERE m.user_id = v_owner AND m.id = v_set_id
       AND m.taxon_treatment_id = v_treatment_id
       AND t.reference_work_id = v_work_id
       AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
  ) THEN
    RETURN private.reference_result('invalid_parent');
  END IF;

  BEGIN
    INSERT INTO public.reference_curated_forks(
      user_id,curated_measurement_set_id,bundle_revision,sporely_taxon_id,
      reference_work_id,taxon_treatment_id,reference_measurement_set_id,source_sha256
      ,source_envelope_json,source_kind
    ) VALUES (
      v_owner,v_curated_set_id,v_bundle_revision,v_taxon_id,
      v_work_id,v_treatment_id,v_set_id,v_source_sha256,v_source_envelope_text,v_source_kind
    ) RETURNING * INTO v_current;
  EXCEPTION
    WHEN unique_violation THEN RETURN private.reference_result('conflict');
    WHEN foreign_key_violation OR check_violation OR not_null_violation THEN
      RETURN private.reference_result('invalid_payload');
  END;
  RETURN private.reference_result('created', pg_catalog.to_jsonb(v_current));
END
$$;

ALTER FUNCTION public.sync_reference_curated_fork(jsonb,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_curated_fork(jsonb,bigint)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sync_reference_curated_fork(jsonb,bigint)
  TO authenticated;

-- Direct table reads (old desktops) see legacy publication forks only.
CREATE POLICY reference_curated_forks_contribution_reader_select
  ON public.reference_curated_forks
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (source_kind = 'curated_publication');

COMMIT;
