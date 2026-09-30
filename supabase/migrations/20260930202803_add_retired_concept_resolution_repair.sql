-- Taxonomy v3 — operator repair of W3 resolutions that point at concepts
-- retired by approved Stage 2 supersessions, before tax-2026.09.30-01 imports.
--
-- The pre-import check `supabase/taxonomy-v3-tax-2026.09.30-01-retiring-concept-check.sql`
-- found production references to 19 retiring concepts: 37
-- `taxonomy_v3.resolution_link` rows (one whose observation no longer exists)
-- and the 36 `public.observations.resolved_sporely_taxon_id` values copied
-- from them by `taxonomy_v3.link_observations_to_resolution()`. The owner
-- approved "repair then import", adding missing survivors to the registry
-- "from the release".
--
-- Manifest: the 19 (superseded -> survivor) pairs, taken from sporely-py
-- `database/taxonomy/policies/concept_supersessions.yml` at ledger commit
-- 9609542 (file SHA-256
-- 04a77c05c694c97b599aae63c5852d7d2ba411a440c42cfa5104cc78a2e47033), field
-- `approved_manifest.member.nortaxa_sporely_taxon_id -> col_sporely_taxon_id`,
-- every record `review_status = approved`.
--   * Pair fingerprint (manifest_sha256): SHA-256 of the sorted lines
--     `superseded,survivor\n` =
--     2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49
--   * Record fingerprint: SHA-256 of the sorted lines
--     `superseded,survivor,supersession_id\n` =
--     2f9de3f5eb469ac7da1a98c5b149d5df11c0f6660ca79f19bc0460a2b0303c01
-- Every function refuses if the embedded literal does not hash to both.
--
-- Rules:
--   * `resolution_link` is authoritative; observations follow it in the same
--     transaction, exactly as `link_observations_to_resolution()` would:
--     `resolved_sporely_taxon_id` follows the link whatever the observation's
--     (non-retired) `selected_sporely_taxon_id` is; the selection is untouched.
--   * Only `resolved_sporely_taxon_id` moves. `resolution_state`,
--     `resolution_method`, `resolution_release` and `manifest_semantic_sha256`
--     are kept: the original mapping method is still how the observation was
--     resolved, and `resolution_method` has no CHECK constraint or convention
--     that names a repair. The repair is recorded by appending one evidence
--     object to the `resolution_evidence` array.
--   * Survivors missing from `taxonomy_v3.registry_concept` are added from the
--     active taxonomy-v2 release (canonical_scientific_name, taxon_rank,
--     scope_state 'not_evaluated', cache_state 'out_of_cache'). Existing
--     registry rows are never modified.
--   * The whole run refuses, changing nothing, unless: exactly one release is
--     active; every survivor is in that release's taxa; no affected
--     observation has a live `observation_reference_uses` row; no
--     `private.shared_reference_contributions` row carries a retired id; no
--     observation selects a retired id; links and observations agree; each
--     existing survivor registry row matches the release's name and rank.
--   * Dry run is read-only and returns a report plus `plan_sha256`. Apply
--     requires that hash, recomputes the plan under row locks, refuses if it
--     differs, changes exactly the planned rows, and records an audit run.
--
-- Triggers on the observations UPDATE (as for Stage 1B): `set_updated_at`
-- bumps `updated_at`, so the change reaches owner devices as an ordinary
-- cloud-side identity change; the W3 guard permits `postgres`; the
-- shared-reference rate triggers treat a no-JWT session as trusted; the
-- shared-contribution AFTER trigger has no live use to act on (refused
-- otherwise); media triggers do not bump `media_version` (visibility,
-- is_draft and user_id are unchanged). `resolution_link` has no triggers.
--
-- Executable only by the owner (`postgres`), i.e. an operator session.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.retired_resolution_repair_runs (
  run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  release_id text NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  link_count integer NOT NULL CHECK (link_count >= 0),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  orphan_link_count integer NOT NULL CHECK (orphan_link_count >= 0),
  registry_added_count integer NOT NULL CHECK (registry_added_count >= 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by name NOT NULL DEFAULT current_user
);

-- One row per repaired resolution_link; observation_updated is false for an
-- orphan link (its observation row no longer exists).
CREATE TABLE private.retired_resolution_repair_items (
  run_id bigint NOT NULL REFERENCES private.retired_resolution_repair_runs(run_id),
  observation_id text NOT NULL,
  superseded_sporely_taxon_id integer NOT NULL,
  survivor_sporely_taxon_id integer NOT NULL,
  supersession_id text NOT NULL,
  observation_updated boolean NOT NULL,
  PRIMARY KEY (run_id, observation_id)
);

CREATE TABLE private.retired_resolution_repair_registry_additions (
  run_id bigint NOT NULL REFERENCES private.retired_resolution_repair_runs(run_id),
  sporely_taxon_id integer NOT NULL,
  canonical_name text NOT NULL,
  rank text NOT NULL,
  first_materialized_from_release text NOT NULL,
  PRIMARY KEY (run_id, sporely_taxon_id)
);

REVOKE ALL ON TABLE private.retired_resolution_repair_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.retired_resolution_repair_items FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.retired_resolution_repair_registry_additions FROM PUBLIC, anon, authenticated, service_role;

-- The pinned manifest. Raises unless the literal hashes to both fingerprints.
CREATE FUNCTION private._retired_resolution_repair_manifest()
RETURNS TABLE (
  superseded_sporely_taxon_id integer,
  survivor_sporely_taxon_id integer,
  supersession_id text
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_pairs constant jsonb := '[
    [624585, 89218, "taxonomy-v3-2-nortaxa-52136-superseded-by-col-65ZG6"],
    [624663, 40726, "taxonomy-v3-2-nortaxa-52340-superseded-by-col-4C969"],
    [624852, 618316, "taxonomy-v3-2-nortaxa-52666-superseded-by-col-YKL6"],
    [625083, 18893, "taxonomy-v3-2-nortaxa-53185-superseded-by-col-3PR66"],
    [625199, 7607, "taxonomy-v3-2-nortaxa-53442-superseded-by-col-39Z3T"],
    [625313, 34480, "taxonomy-v3-2-nortaxa-53799-superseded-by-col-44T6F"],
    [625822, 93860, "taxonomy-v3-2-nortaxa-55143-superseded-by-col-6BY6D"],
    [625847, 146432, "taxonomy-v3-2-nortaxa-55206-superseded-by-col-B86C"],
    [626145, 160491, "taxonomy-v3-2-nortaxa-55943-superseded-by-col-MCH9"],
    [626159, 23371, "taxonomy-v3-2-nortaxa-55999-superseded-by-col-3STFC"],
    [626184, 69545, "taxonomy-v3-2-nortaxa-56069-superseded-by-col-53F32"],
    [626192, 69567, "taxonomy-v3-2-nortaxa-56078-superseded-by-col-53F4V"],
    [626243, 168873, "taxonomy-v3-2-nortaxa-56210-superseded-by-col-QMKY"],
    [626461, 614315, "taxonomy-v3-2-nortaxa-56820-superseded-by-col-W5TS"],
    [626469, 98451, "taxonomy-v3-2-nortaxa-56833-superseded-by-col-6JCCY"],
    [626524, 159510, "taxonomy-v3-2-nortaxa-56934-superseded-by-col-LY73"],
    [626627, 98530, "taxonomy-v3-2-nortaxa-57217-superseded-by-col-6JCQK"],
    [626800, 104029, "taxonomy-v3-2-nortaxa-57632-superseded-by-col-6NT25"],
    [626910, 16099, "taxonomy-v3-2-nortaxa-57981-superseded-by-col-3MZFS"]
  ]';
  v_count integer;
  v_distinct integer;
  v_pair_sha text;
  v_record_sha text;
BEGIN
  SELECT count(*)::integer,
         count(DISTINCT (e->>0))::integer,
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.string_agg((e->>0) || ',' || (e->>1) || pg_catalog.chr(10), ''
             ORDER BY (e->>0)::integer), 'UTF8')), 'hex'),
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           pg_catalog.string_agg((e->>0) || ',' || (e->>1) || ',' || (e->>2) || pg_catalog.chr(10), ''
             ORDER BY (e->>0)::integer), 'UTF8')), 'hex')
    INTO v_count, v_distinct, v_pair_sha, v_record_sha
    FROM pg_catalog.jsonb_array_elements(v_pairs) e;
  IF v_count <> 19 OR v_distinct <> 19
     OR v_pair_sha IS DISTINCT FROM '2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49'
     OR v_record_sha IS DISTINCT FROM '2f9de3f5eb469ac7da1a98c5b149d5df11c0f6660ca79f19bc0460a2b0303c01' THEN
    RAISE EXCEPTION 'retired-concept manifest is not the pinned 9609542 ledger manifest (% pairs, %, %)',
      v_count, v_pair_sha, v_record_sha
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT (e->>0)::integer, (e->>1)::integer, e->>2
      FROM pg_catalog.jsonb_array_elements(v_pairs) e
     ORDER BY (e->>0)::integer;
END
$$;

CREATE FUNCTION private._retired_resolution_repair_manifest_sha256()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT '2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49'::text $$;

-- The whole report for the current state. Read-only. Refusals are reported,
-- not raised, so the operator sees every blocker at once; apply raises on any.
CREATE FUNCTION private._retired_resolution_repair_report(p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_manifest jsonb;
  v_manifest_sha text := private._retired_resolution_repair_manifest_sha256();
  v_active_count integer;
  v_release text;
  v_items jsonb;
  v_registry jsonb;
  v_per_pair jsonb;
  v_refusals jsonb := '[]'::jsonb;
  v_n bigint;
  v_list jsonb;
BEGIN
  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.superseded_sporely_taxon_id)
    INTO v_manifest
    FROM private._retired_resolution_repair_manifest() m;

  SELECT count(*)::integer, min(r.release_id)
    INTO v_active_count, v_release
    FROM public.taxonomy_v2_releases r
   WHERE r.status = 'active';
  IF v_active_count <> 1 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'active_release_count', 'count', v_active_count);
    v_release := NULL;
  END IF;

  -- Planned items: every link resolved to a retired id.
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'observation_id', l.observation_id,
           'superseded_sporely_taxon_id', m.superseded_sporely_taxon_id,
           'survivor_sporely_taxon_id', m.survivor_sporely_taxon_id,
           'supersession_id', m.supersession_id,
           'observation_present', o.id IS NOT NULL
         ) ORDER BY l.observation_id), '[]'::jsonb)
    INTO v_items
    FROM taxonomy_v3.resolution_link l
    JOIN private._retired_resolution_repair_manifest() m
      ON m.superseded_sporely_taxon_id = l.resolved_sporely_taxon_id
    LEFT JOIN public.observations o ON o.id::text = l.observation_id;

  -- Survivors absent from the active release.
  SELECT coalesce(pg_catalog.jsonb_agg(m.survivor_sporely_taxon_id ORDER BY m.survivor_sporely_taxon_id), '[]'::jsonb)
    INTO v_list
    FROM private._retired_resolution_repair_manifest() m
   WHERE NOT EXISTS (
     SELECT 1 FROM public.taxonomy_v2_taxa t
      WHERE t.release_id = v_release AND t.sporely_taxon_id = m.survivor_sporely_taxon_id
        AND coalesce(pg_catalog.btrim(t.canonical_scientific_name), '') <> ''
        AND coalesce(pg_catalog.btrim(t.taxon_rank), '') <> '');
  IF pg_catalog.jsonb_array_length(v_list) > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'survivor_not_in_active_release', 'survivor_sporely_taxon_ids', v_list);
  END IF;

  -- Link/observation disagreement, either direction.
  SELECT count(*) INTO v_n
    FROM taxonomy_v3.resolution_link l
    JOIN public.observations o ON o.id::text = l.observation_id
   WHERE (l.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
          OR o.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m))
     AND o.resolved_sporely_taxon_id IS DISTINCT FROM l.resolved_sporely_taxon_id;
  SELECT v_n + count(*) INTO v_n
    FROM public.observations o
   WHERE o.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
     AND NOT EXISTS (SELECT 1 FROM taxonomy_v3.resolution_link l WHERE l.observation_id = o.id::text);
  IF v_n > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'link_observation_disagreement', 'count', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM public.observations o
   WHERE o.selected_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m);
  IF v_n > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'observation_selects_retired_concept', 'count', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
   WHERE u.deleted_at IS NULL
     AND o.id::text IN (SELECT i->>'observation_id' FROM pg_catalog.jsonb_array_elements(v_items) i);
  IF v_n > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'live_observation_reference_uses', 'count', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM private.shared_reference_contributions c
   WHERE c.sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m);
  IF v_n > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'shared_reference_contribution_on_retired_concept', 'count', v_n);
  END IF;

  SELECT count(*) INTO v_n
    FROM taxonomy_v3.resolution_link l
   WHERE l.observation_id IN (SELECT i->>'observation_id' FROM pg_catalog.jsonb_array_elements(v_items) i)
     AND pg_catalog.jsonb_typeof(l.resolution_evidence) <> 'array';
  IF v_n > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'resolution_evidence_not_array', 'count', v_n);
  END IF;

  -- Registry: survivors the plan needs, compared with the active release.
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'sporely_taxon_id', s.survivor,
           'canonical_name', t.canonical_scientific_name,
           'rank', t.taxon_rank
         ) ORDER BY s.survivor) FILTER (WHERE rc.sporely_taxon_id IS NULL), '[]'::jsonb),
         coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'sporely_taxon_id', s.survivor,
           'registry_canonical_name', rc.canonical_name, 'registry_rank', rc.rank,
           'release_canonical_name', t.canonical_scientific_name, 'release_rank', t.taxon_rank
         ) ORDER BY s.survivor) FILTER (WHERE rc.sporely_taxon_id IS NOT NULL
             AND (rc.canonical_name IS DISTINCT FROM t.canonical_scientific_name
                  OR rc.rank IS DISTINCT FROM t.taxon_rank)), '[]'::jsonb)
    INTO v_registry, v_list
    FROM (SELECT DISTINCT (i->>'survivor_sporely_taxon_id')::integer AS survivor
            FROM pg_catalog.jsonb_array_elements(v_items) i) s
    LEFT JOIN public.taxonomy_v2_taxa t
      ON t.release_id = v_release AND t.sporely_taxon_id = s.survivor
    LEFT JOIN taxonomy_v3.registry_concept rc ON rc.sporely_taxon_id = s.survivor;
  IF v_release IS NULL THEN
    v_registry := '[]'::jsonb;
  END IF;
  IF pg_catalog.jsonb_array_length(v_list) > 0 THEN
    v_refusals := v_refusals || pg_catalog.jsonb_build_object(
      'refusal', 'registry_conflict', 'rows', v_list);
  END IF;

  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'superseded_sporely_taxon_id', m->'superseded_sporely_taxon_id',
           'survivor_sporely_taxon_id', m->'survivor_sporely_taxon_id',
           'supersession_id', m->'supersession_id',
           'links', (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_items) i
                      WHERE i->'superseded_sporely_taxon_id' = m->'superseded_sporely_taxon_id'),
           'observations', (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_items) i
                      WHERE i->'superseded_sporely_taxon_id' = m->'superseded_sporely_taxon_id'
                        AND (i->>'observation_present')::boolean),
           'orphan_links', (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_items) i
                      WHERE i->'superseded_sporely_taxon_id' = m->'superseded_sporely_taxon_id'
                        AND NOT (i->>'observation_present')::boolean),
           'registry_addition', EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_registry) r
                      WHERE r->'sporely_taxon_id' = m->'survivor_sporely_taxon_id')
         ) ORDER BY (m->>'superseded_sporely_taxon_id')::integer)
    INTO v_per_pair
    FROM pg_catalog.jsonb_array_elements(v_manifest) m;

  RETURN pg_catalog.jsonb_build_object(
    'mode', p_mode,
    'release_id', v_release,
    'manifest_sha256', v_manifest_sha,
    'ledger_commit', '9609542',
    'plan_sha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'release_id', v_release,
        'manifest_sha256', v_manifest_sha,
        'items', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'observation_id', i->'observation_id',
                    'superseded_sporely_taxon_id', i->'superseded_sporely_taxon_id',
                    'survivor_sporely_taxon_id', i->'survivor_sporely_taxon_id',
                    'observation_present', i->'observation_present'
                  ) ORDER BY i->>'observation_id'), '[]'::jsonb)
                    FROM pg_catalog.jsonb_array_elements(v_items) i),
        'registry_additions', v_registry
      )::text, 'UTF8')), 'hex'),
    'link_count', pg_catalog.jsonb_array_length(v_items),
    'observation_count', (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_items) i
                           WHERE (i->>'observation_present')::boolean),
    'orphan_link_count', (SELECT count(*) FROM pg_catalog.jsonb_array_elements(v_items) i
                           WHERE NOT (i->>'observation_present')::boolean),
    'registry_additions', v_registry,
    'per_pair', v_per_pair,
    'refusals', v_refusals,
    'items', v_items
  );
END
$$;

-- Dry run: read-only.
CREATE FUNCTION private.retired_resolution_repair_dry_run()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$ SELECT private._retired_resolution_repair_report('dry_run') $$;

-- Apply: changes exactly what a refusal-free dry run reported, or nothing.
CREATE FUNCTION private.retired_resolution_repair_apply(p_plan_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_report jsonb;
  v_release text;
  v_run_id bigint;
  v_n integer;
  v_expected integer;
BEGIN
  IF p_plan_sha256 IS NULL OR p_plan_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'apply requires the plan_sha256 of a dry run'
      USING ERRCODE = '22023';
  END IF;

  -- Lock order, as Stage 1B: the active release, then the rows the plan reads
  -- and writes, the authoritative link before the observation that mirrors it,
  -- then the observations' reference uses. Holding the observations FOR
  -- UPDATE also makes any new reference use wait (its foreign key takes FOR
  -- KEY SHARE on the observation row), so the no-live-use refusal cannot be
  -- raced. A deadlock (40P01) aborts the apply, which changes nothing.
  PERFORM 1 FROM public.taxonomy_v2_releases r WHERE r.status = 'active' FOR SHARE;
  PERFORM 1 FROM public.taxonomy_v2_taxa t
   WHERE t.release_id IN (SELECT r.release_id FROM public.taxonomy_v2_releases r WHERE r.status = 'active')
     AND t.sporely_taxon_id IN (SELECT m.survivor_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
     FOR SHARE;
  PERFORM 1 FROM taxonomy_v3.registry_concept rc
   WHERE rc.sporely_taxon_id IN (SELECT m.survivor_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
     FOR SHARE;
  PERFORM 1 FROM taxonomy_v3.resolution_link l
   WHERE l.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
     FOR UPDATE;
  PERFORM 1 FROM public.observations o
   WHERE o.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
      OR o.selected_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
      OR o.id::text IN (
           SELECT l.observation_id FROM taxonomy_v3.resolution_link l
            WHERE l.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m))
     FOR UPDATE;
  PERFORM 1 FROM public.observation_reference_uses u
    JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
   WHERE o.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
     FOR SHARE OF u;

  v_report := private._retired_resolution_repair_report('apply');
  v_release := v_report->>'release_id';

  IF pg_catalog.jsonb_array_length(v_report->'refusals') > 0 THEN
    RAISE EXCEPTION 'retired-concept repair refused; nothing applied: %', v_report->'refusals'
      USING ERRCODE = '55000';
  END IF;
  IF v_report->>'plan_sha256' IS DISTINCT FROM p_plan_sha256 THEN
    RAISE EXCEPTION 'plan changed since the dry run (expected %, now %); nothing applied',
      p_plan_sha256, v_report->>'plan_sha256'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO private.retired_resolution_repair_runs(
    release_id, manifest_sha256, plan_sha256, link_count, observation_count,
    orphan_link_count, registry_added_count
  ) VALUES (
    v_release, v_report->>'manifest_sha256', v_report->>'plan_sha256',
    (v_report->>'link_count')::integer, (v_report->>'observation_count')::integer,
    (v_report->>'orphan_link_count')::integer,
    pg_catalog.jsonb_array_length(v_report->'registry_additions')
  ) RETURNING run_id INTO v_run_id;

  -- Plain INSERT: a concurrently added row for the same id raises rather than
  -- being silently accepted or overwritten.
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release
  )
  SELECT (r->>'sporely_taxon_id')::integer, r->>'canonical_name', r->>'rank',
         'not_evaluated', 'out_of_cache', v_release
    FROM pg_catalog.jsonb_array_elements(v_report->'registry_additions') r;
  INSERT INTO private.retired_resolution_repair_registry_additions(
    run_id, sporely_taxon_id, canonical_name, rank, first_materialized_from_release
  )
  SELECT v_run_id, (r->>'sporely_taxon_id')::integer, r->>'canonical_name', r->>'rank', v_release
    FROM pg_catalog.jsonb_array_elements(v_report->'registry_additions') r;

  UPDATE taxonomy_v3.resolution_link l
     SET resolved_sporely_taxon_id = (i->>'survivor_sporely_taxon_id')::integer,
         resolution_evidence = l.resolution_evidence || pg_catalog.jsonb_build_array(
           pg_catalog.jsonb_build_object(
             'kind', 'retired_concept_resolution_repair',
             'superseded_sporely_taxon_id', (i->>'superseded_sporely_taxon_id')::integer,
             'survivor_sporely_taxon_id', (i->>'survivor_sporely_taxon_id')::integer,
             'supersession_id', i->>'supersession_id',
             'ledger_commit', '9609542',
             'manifest_sha256', v_report->>'manifest_sha256',
             'repair_run_id', v_run_id))
    FROM pg_catalog.jsonb_array_elements(v_report->'items') i
   WHERE l.observation_id = i->>'observation_id'
     AND l.resolved_sporely_taxon_id = (i->>'superseded_sporely_taxon_id')::integer;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_expected := (v_report->>'link_count')::integer;
  IF v_n <> v_expected THEN
    RAISE EXCEPTION 'repair updated % links but planned %; rolled back', v_n, v_expected
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.observations o
     SET resolved_sporely_taxon_id = (i->>'survivor_sporely_taxon_id')::integer
    FROM pg_catalog.jsonb_array_elements(v_report->'items') i
   WHERE (i->>'observation_present')::boolean
     AND o.id::text = i->>'observation_id'
     AND o.resolved_sporely_taxon_id = (i->>'superseded_sporely_taxon_id')::integer;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_expected := (v_report->>'observation_count')::integer;
  IF v_n <> v_expected THEN
    RAISE EXCEPTION 'repair updated % observations but planned %; rolled back', v_n, v_expected
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO private.retired_resolution_repair_items(
    run_id, observation_id, superseded_sporely_taxon_id, survivor_sporely_taxon_id,
    supersession_id, observation_updated
  )
  SELECT v_run_id, i->>'observation_id', (i->>'superseded_sporely_taxon_id')::integer,
         (i->>'survivor_sporely_taxon_id')::integer, i->>'supersession_id',
         (i->>'observation_present')::boolean
    FROM pg_catalog.jsonb_array_elements(v_report->'items') i;

  -- Postcondition: the retiring-concept check's three counts are zero.
  IF EXISTS (SELECT 1 FROM taxonomy_v3.resolution_link l
              WHERE l.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m))
     OR EXISTS (SELECT 1 FROM public.observations o
              WHERE o.resolved_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)
                 OR o.selected_sporely_taxon_id IN (SELECT m.superseded_sporely_taxon_id FROM private._retired_resolution_repair_manifest() m)) THEN
    RAISE EXCEPTION 'retired concepts still referenced after repair; rolled back'
      USING ERRCODE = '40001';
  END IF;

  RETURN (v_report - 'items') || pg_catalog.jsonb_build_object('run_id', v_run_id);
END
$$;

ALTER FUNCTION private._retired_resolution_repair_manifest() OWNER TO postgres;
ALTER FUNCTION private._retired_resolution_repair_manifest_sha256() OWNER TO postgres;
ALTER FUNCTION private._retired_resolution_repair_report(text) OWNER TO postgres;
ALTER FUNCTION private.retired_resolution_repair_dry_run() OWNER TO postgres;
ALTER FUNCTION private.retired_resolution_repair_apply(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION private._retired_resolution_repair_manifest() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._retired_resolution_repair_manifest_sha256() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private._retired_resolution_repair_report(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.retired_resolution_repair_dry_run() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.retired_resolution_repair_apply(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.retired_resolution_repair_dry_run() IS
  'Taxonomy v3 retired-concept resolution repair. Read-only. Reports every '
  'taxonomy_v3.resolution_link resolved to a concept retired by the pinned '
  '9609542 supersession manifest, the survivor registry rows to add from the '
  'active release, every refusal, and plan_sha256.';
COMMENT ON FUNCTION private.retired_resolution_repair_apply(text) IS
  'Taxonomy v3 retired-concept resolution repair. Operator-only. Recomputes the '
  'plan under row locks, refuses on any refusal or a plan_sha256 mismatch, adds '
  'missing survivor registry rows, moves resolution_link and then '
  'observations.resolved_sporely_taxon_id to the survivor with an evidence '
  'entry, and records private.retired_resolution_repair_runs/items/'
  'registry_additions. Idempotent: a second run finds nothing to repair.';

COMMIT;
