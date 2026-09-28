-- Taxonomy v3 Stage 1B — operator repair for historical `external_unresolved`
-- cloud observations.
--
-- An Artsorakel suggestion whose NorTaxa id had no published bridge was saved
-- as `taxon_identity_state = 'external_unresolved'`, preserving
-- `(source_system, namespace, external_id)` and the raw provider value. Once
-- reviewed bridges are active, those observations would only resolve when the
-- owner re-opened them. This migration adds an explicit, idempotent,
-- operator-only repair that re-resolves them server-side.
--
-- Rules (plan `docs/plans/active/2026-09-27-taxonomy-v3.md`, Stage 1B):
--
--   * Only rows in `external_unresolved` are considered.
--   * Each is resolved from its preserved tuple ONLY, through the same
--     `public.resolve_taxon_external_id_v2` the client calls, with the client's
--     rule (`resolveExternalTaxonomySelection`): exactly one distinct
--     `taxon_id` promotes; zero, several, or an error change nothing.
--   * Scientific-name text (`genus`, `species`, `common_name`, `ai_selected_*`)
--     is never read and never written. The raw provider id and the preserved
--     tuple are kept; only `selected_sporely_taxon_id` and the state move,
--     in one statement, exactly like `set_observation_selected_taxon_v2`.
--   * The tuple is used verbatim. No namespace bridge is applied here: the
--     client already stored the bridged tuple, and inventing a hop server-side
--     would be a second, unreviewed bridge.
--   * A promotion that would change the effective taxon
--     (`coalesce(selected, resolved)`) of an observation with live
--     `observation_reference_uses` is BLOCKED (`blocked_reference_use`) and
--     changes nothing. `private.refresh_shared_references_for_observation_taxon`
--     deliberately does no work without an owner session, so an operator write
--     would leave a public shared-reference contribution under the old taxon
--     and create none under the new one. Those rows are reported for owner-side
--     handling instead of being silently diverged.
--   * Dry run is read-only and returns a report plus `plan_sha256`. Apply
--     requires that hash, recomputes the plan under row locks, refuses if it
--     differs, changes exactly the planned rows, and records an audit run.
--
-- Nothing here is callable by clients: the functions are executable only by
-- their owner (`postgres`), i.e. an operator session. The UPDATE runs without
-- `auth.uid()`, which `_guard_selected_sporely_taxon_id_v2` permits for
-- `postgres` and the shared-reference rate limiter treats as trusted
-- server-side reconciliation. `observations.updated_at` is bumped by the
-- existing trigger, so the change reaches other devices as an ordinary
-- cloud-side identity change (docs/supabase-sync-contract.md).

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.taxon_identity_repair_runs (
  run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id text NOT NULL,
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  promoted_count integer NOT NULL CHECK (promoted_count >= 0),
  outcome_counts jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by name NOT NULL DEFAULT current_user
);

-- One row per candidate inspected by an apply run, so the audit shows what
-- was left alone and why, not only what changed.
CREATE TABLE private.taxon_identity_repair_items (
  run_id bigint NOT NULL REFERENCES private.taxon_identity_repair_runs(run_id),
  observation_id bigint NOT NULL,
  source_system text NOT NULL,
  namespace text NOT NULL,
  external_id text NOT NULL,
  raw_external_id text,
  outcome text NOT NULL CHECK (
    outcome IN ('promote', 'no_match', 'ambiguous', 'blocked_reference_use', 'error')
  ),
  match_count integer,
  sporely_taxon_id bigint,
  error_message text,
  PRIMARY KEY (run_id, observation_id),
  CHECK ((outcome = 'promote') = (sporely_taxon_id IS NOT NULL))
);

REVOKE ALL ON TABLE private.taxon_identity_repair_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.taxon_identity_repair_items FROM PUBLIC, anon, authenticated, service_role;

-- The plan: every `external_unresolved` observation, classified. Read-only.
CREATE FUNCTION private._taxon_identity_repair_plan()
RETURNS TABLE (
  observation_id bigint,
  source_system text,
  namespace text,
  external_id text,
  raw_external_id text,
  outcome text,
  match_count integer,
  sporely_taxon_id bigint,
  error_message text
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_obs record;
  v_count integer;
  v_taxon bigint;
BEGIN
  FOR v_obs IN
    SELECT o.id,
           o.user_id,
           o.resolved_sporely_taxon_id,
           o.taxon_identity_source_system,
           o.taxon_identity_namespace,
           o.taxon_identity_external_id,
           o.taxon_identity_raw_external_id
      FROM public.observations o
     WHERE o.taxon_identity_state = 'external_unresolved'
     ORDER BY o.id
  LOOP
    observation_id := v_obs.id;
    source_system := v_obs.taxon_identity_source_system;
    namespace := v_obs.taxon_identity_namespace;
    external_id := v_obs.taxon_identity_external_id;
    raw_external_id := v_obs.taxon_identity_raw_external_id;
    match_count := NULL;
    sporely_taxon_id := NULL;
    error_message := NULL;
    BEGIN
      SELECT count(DISTINCT r.taxon_id)::integer, min(r.taxon_id)
        INTO v_count, v_taxon
        FROM public.resolve_taxon_external_id_v2(
               v_obs.taxon_identity_source_system,
               v_obs.taxon_identity_namespace,
               v_obs.taxon_identity_external_id
             ) r
       WHERE r.taxon_id IS NOT NULL;
      match_count := v_count;
      IF v_count = 1 AND v_obs.resolved_sporely_taxon_id IS DISTINCT FROM v_taxon
         AND EXISTS (
           SELECT 1 FROM public.observation_reference_uses u
            WHERE u.user_id = v_obs.user_id
              AND u.observation_id = v_obs.id
              AND u.deleted_at IS NULL
         ) THEN
        -- selected_sporely_taxon_id is NULL for every candidate (CHECK), so
        -- the effective taxon changes exactly when resolved differs.
        outcome := 'blocked_reference_use';
      ELSIF v_count = 1 THEN
        outcome := 'promote';
        sporely_taxon_id := v_taxon;
      ELSIF v_count = 0 THEN
        outcome := 'no_match';
      ELSE
        outcome := 'ambiguous';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      outcome := 'error';
      error_message := SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END
$$;

-- Report for a plan held as a jsonb array ordered by observation_id.
-- `plan_sha256` covers the release and the exact promotion set; that is what
-- apply must reproduce. Non-promoting rows are reported but do not enter the
-- hash, so an unrelated new unresolved observation cannot invalidate a plan.
CREATE FUNCTION private._taxon_identity_repair_report(
  p_mode text,
  p_release_id text,
  p_plan jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  WITH rows AS (
    SELECT e, ord FROM pg_catalog.jsonb_array_elements(p_plan) WITH ORDINALITY AS t(e, ord)
  ),
  promotions AS (
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'observation_id', (e->>'observation_id')::bigint,
             'source_system', e->>'source_system',
             'namespace', e->>'namespace',
             'external_id', e->>'external_id',
             'raw_external_id', e->>'raw_external_id',
             'sporely_taxon_id', (e->>'sporely_taxon_id')::bigint
           ) ORDER BY (e->>'observation_id')::bigint), '[]'::jsonb) AS list
      FROM rows WHERE e->>'outcome' = 'promote'
  ),
  flagged AS (
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'observation_id', (e->>'observation_id')::bigint,
             'source_system', e->>'source_system',
             'namespace', e->>'namespace',
             'external_id', e->>'external_id',
             'outcome', e->>'outcome',
             'match_count', (e->>'match_count')::integer,
             'error_message', e->>'error_message'
           ) ORDER BY (e->>'observation_id')::bigint), '[]'::jsonb) AS list
      FROM rows WHERE e->>'outcome' IN ('ambiguous', 'blocked_reference_use', 'error')
  )
  SELECT pg_catalog.jsonb_build_object(
    'mode', p_mode,
    'release_id', p_release_id,
    'plan_sha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('release_id', p_release_id, 'promotions', promotions.list)::text,
      'UTF8')), 'hex'),
    'candidate_count', (SELECT count(*) FROM rows),
    'outcome_counts', pg_catalog.jsonb_build_object(
      'promote', (SELECT count(*) FROM rows WHERE e->>'outcome' = 'promote'),
      'no_match', (SELECT count(*) FROM rows WHERE e->>'outcome' = 'no_match'),
      'ambiguous', (SELECT count(*) FROM rows WHERE e->>'outcome' = 'ambiguous'),
      'blocked_reference_use', (SELECT count(*) FROM rows WHERE e->>'outcome' = 'blocked_reference_use'),
      'error', (SELECT count(*) FROM rows WHERE e->>'outcome' = 'error')
    ),
    'promotions', promotions.list,
    'flagged', flagged.list
  )
  FROM promotions, flagged;
$$;

CREATE FUNCTION private._taxon_identity_repair_active_release()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_release text;
BEGIN
  SELECT r.release_id INTO v_release
    FROM public.taxonomy_v2_releases r
   WHERE r.status = 'active';
  IF v_release IS NULL THEN
    RAISE EXCEPTION 'no active taxonomy-v2 release; nothing can resolve'
      USING ERRCODE = '55000';
  END IF;
  RETURN v_release;
END
$$;

-- Dry run: read-only. Returns what apply would change and its plan_sha256.
CREATE FUNCTION private.taxon_identity_repair_dry_run()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_release text := private._taxon_identity_repair_active_release();
  v_plan jsonb;
BEGIN
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.observation_id), '[]'::jsonb)
    INTO v_plan
    FROM private._taxon_identity_repair_plan() p;
  RETURN private._taxon_identity_repair_report('dry_run', v_release, v_plan);
END
$$;

-- Apply: changes exactly the promotion set a dry run reported, or nothing.
CREATE FUNCTION private.taxon_identity_repair_apply(p_expected_plan_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_release text;
  v_plan jsonb;
  v_report jsonb;
  v_planned integer;
  v_updated integer;
  v_run_id bigint;
BEGIN
  IF p_expected_plan_sha256 IS NULL OR p_expected_plan_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'apply requires the plan_sha256 of a dry run'
      USING ERRCODE = '22023';
  END IF;

  -- Hold the active release, its bridges, every candidate and the
  -- candidates' reference uses still for the rest of the transaction: no
  -- activation switch, bridge edit, owner edit or reference-use change can
  -- interleave between planning and the write. (A new use insert already
  -- waits on the candidate row lock through its foreign key.)
  PERFORM 1 FROM public.taxonomy_v2_releases r WHERE r.status = 'active' FOR SHARE;
  LOCK TABLE public.taxonomy_v2_external_ids IN SHARE MODE;
  v_release := private._taxon_identity_repair_active_release();
  PERFORM 1 FROM public.observations o
   WHERE o.taxon_identity_state = 'external_unresolved'
     FOR UPDATE;
  PERFORM 1 FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
   WHERE o.taxon_identity_state = 'external_unresolved'
     FOR SHARE OF u;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.observation_id), '[]'::jsonb)
    INTO v_plan
    FROM private._taxon_identity_repair_plan() p;
  v_report := private._taxon_identity_repair_report('apply', v_release, v_plan);

  IF v_report->>'plan_sha256' IS DISTINCT FROM p_expected_plan_sha256 THEN
    RAISE EXCEPTION 'plan changed since the dry run (expected %, now %); nothing applied',
      p_expected_plan_sha256, v_report->>'plan_sha256'
      USING ERRCODE = '40001';
  END IF;

  v_planned := (v_report->'outcome_counts'->>'promote')::integer;

  -- Same paired transition as set_observation_selected_taxon_v2. The WHERE
  -- clause re-asserts the planned tuple, so a row can only move from the
  -- exact state the plan inspected.
  UPDATE public.observations o
     SET selected_sporely_taxon_id = (p->>'sporely_taxon_id')::bigint,
         taxon_identity_state = 'sporely_v2'
    FROM pg_catalog.jsonb_array_elements(v_report->'promotions') p
   WHERE o.id = (p->>'observation_id')::bigint
     AND o.taxon_identity_state = 'external_unresolved'
     AND o.selected_sporely_taxon_id IS NULL
     AND o.taxon_identity_source_system = p->>'source_system'
     AND o.taxon_identity_namespace = p->>'namespace'
     AND o.taxon_identity_external_id = p->>'external_id';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> v_planned THEN
    RAISE EXCEPTION 'repair updated % rows but planned %; rolled back', v_updated, v_planned
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO private.taxon_identity_repair_runs(
    release_id, plan_sha256, candidate_count, promoted_count, outcome_counts
  ) VALUES (
    v_release, v_report->>'plan_sha256', (v_report->>'candidate_count')::integer,
    v_updated, v_report->'outcome_counts'
  ) RETURNING run_id INTO v_run_id;

  INSERT INTO private.taxon_identity_repair_items(
    run_id, observation_id, source_system, namespace, external_id, raw_external_id,
    outcome, match_count, sporely_taxon_id, error_message
  )
  SELECT v_run_id, (e->>'observation_id')::bigint, e->>'source_system', e->>'namespace',
         e->>'external_id', e->>'raw_external_id', e->>'outcome',
         (e->>'match_count')::integer, (e->>'sporely_taxon_id')::bigint, e->>'error_message'
    FROM pg_catalog.jsonb_array_elements(v_plan) e;

  RETURN v_report || pg_catalog.jsonb_build_object('run_id', v_run_id, 'promoted_count', v_updated);
END
$$;

ALTER FUNCTION private._taxon_identity_repair_plan() OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_report(text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION private._taxon_identity_repair_active_release() OWNER TO postgres;
ALTER FUNCTION private.taxon_identity_repair_dry_run() OWNER TO postgres;
ALTER FUNCTION private.taxon_identity_repair_apply(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION private._taxon_identity_repair_plan() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_report(text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._taxon_identity_repair_active_release() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.taxon_identity_repair_dry_run() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.taxon_identity_repair_apply(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.taxon_identity_repair_dry_run() IS
  'Taxonomy v3 Stage 1B. Read-only. Classifies every external_unresolved '
  'observation by resolving its preserved (source_system, namespace, '
  'external_id) through resolve_taxon_external_id_v2; exactly one distinct '
  'taxon_id promotes. Never reads name text. Returns a report and plan_sha256.';
COMMENT ON FUNCTION private.taxon_identity_repair_apply(text) IS
  'Taxonomy v3 Stage 1B. Operator-only. Recomputes the plan under row locks, '
  'refuses unless its plan_sha256 equals the dry run''s, promotes exactly the '
  'planned rows to sporely_v2 keeping the preserved tuple and raw id, and '
  'records private.taxon_identity_repair_runs/items. Idempotent: a second run '
  'finds nothing to promote.';

COMMIT;
