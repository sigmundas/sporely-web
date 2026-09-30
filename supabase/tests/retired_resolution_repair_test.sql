-- Regression for the Taxonomy v3 retired-concept resolution repair
-- (20260930202803). Raw-assert convention: BEGIN/ROLLBACK, RAISE EXCEPTION on
-- failure. Local fixtures only.
--
-- Fixture: active release `tax-2099.09.30-01` carries all 19 survivors of the
-- pinned manifest. The registry holds every retired id, plus survivor 18893
-- ('Inocybe lacera', matching the release) and survivor 69545 (unused by any
-- link). W3 links:
--   962000001, 962000002 -> 624585 (survivor 89218, missing from registry)
--   962000003            -> 625083 (survivor 18893, already in registry)
--   962000004            -> 626910 (survivor 16099, missing from registry)
--   962000099 (orphan)   -> 626910 (its observation row no longer exists)
--   962000005            -> 18893 (a survivor; not a candidate)
--   962000007            -> 626184 (survivor 69545) with a valid non-retired
--                           selection 18893, which must stay untouched

BEGIN;

CREATE TEMP TABLE rr_state(k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

DO $$
DECLARE
  v_owner constant uuid := '00000000-0000-4000-8000-00000002c001';
  v_rel constant text := 'tax-2099.09.30-01';
  v_old constant text := 'tax-2099.09.26-02';
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (v_owner,'authenticated','authenticated','retired-repair@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (v_owner,'retired_repair',false);

  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
    exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
    whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
    authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
    dangling_parent_report,source_manifest
  ) VALUES
    (v_old,2,1,1,'test','test',repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),
     now(),'retired','{}','{}','{}',0,'{}','{}'),
    (v_rel,2,1,1,'test','test',repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64),
     now(),'active','{}','{}','{}',0,'{}','{}');

  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id)
  SELECT m.survivor_sporely_taxon_id, v_rel FROM private._retired_resolution_repair_manifest() m;
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
    taxon_rank,canonical_source_system,canonical_external_id
  )
  SELECT v_rel, m.survivor_sporely_taxon_id, 'Survivor', m.survivor_sporely_taxon_id::text,
         CASE m.survivor_sporely_taxon_id WHEN 18893 THEN 'Inocybe lacera'
              ELSE 'Survivor s' || m.survivor_sporely_taxon_id END,
         'species', 'col_xr', 'S' || m.survivor_sporely_taxon_id
    FROM private._retired_resolution_repair_manifest() m;

  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  )
  SELECT m.superseded_sporely_taxon_id, 'Retired r' || m.superseded_sporely_taxon_id, 'species',
         'include', 'in_cache', v_old
    FROM private._retired_resolution_repair_manifest() m;
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES
    (18893,'Inocybe lacera','species','not_evaluated','out_of_cache',v_old),
    (69545,'Survivor s69545','species','include','in_cache',v_old);

  INSERT INTO taxonomy_v3.identification_snapshot(observation_id, original_scientific_name)
  SELECT x::text, 'snapshot' FROM unnest(ARRAY[962000001,962000002,962000003,962000004,962000005,962000007,962000099]) x;
  INSERT INTO taxonomy_v3.resolution_link(
    observation_id,resolution_state,resolved_sporely_taxon_id,resolution_method,resolution_evidence
  ) VALUES
    ('962000001','resolved_exact',624585,'trusted_secondary_provider_mapping','[{"kind":"exact"}]'),
    ('962000002','resolved_exact',624585,'trusted_secondary_provider_mapping','[]'),
    ('962000003','resolved_exact',625083,'trusted_secondary_provider_mapping','[]'),
    ('962000004','resolved_exact',626910,'trusted_secondary_provider_mapping','[]'),
    ('962000005','resolved_exact',18893,'trusted_secondary_provider_mapping','[]'),
    ('962000007','resolved_exact',626184,'trusted_secondary_provider_mapping','[]'),
    ('962000099','resolved_exact',626910,'trusted_secondary_provider_mapping','[]');

  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,resolved_sporely_taxon_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (962000001,v_owner,current_date,'private',false,'Retired','a',624585),
    (962000002,v_owner,current_date,'private',false,'Retired','b',624585),
    (962000003,v_owner,current_date,'private',false,'Retired','c',625083),
    (962000004,v_owner,current_date,'private',false,'Retired','d',626910),
    (962000005,v_owner,current_date,'private',false,'Inocybe','lacera',18893),
    (962000006,v_owner,current_date,'private',false,'Other','e',NULL);
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,selected_sporely_taxon_id,resolved_sporely_taxon_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (962000007,v_owner,current_date,'private',false,'Retired','g',18893,626184);

  -- Reference fixtures used only inside refusal sub-blocks.
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (v_owner,'81000000-0000-4000-8000-00000002c001','article','[{"family":"Test"}]','Retired repair',2026,'Test 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (v_owner,'82000000-0000-4000-8000-00000002c001','81000000-0000-4000-8000-00000002c001','local-a','Retired a',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES
    (v_owner,'83000000-0000-4000-8000-00000002c00a','82000000-0000-4000-8000-00000002c001','spore_size','8-10 x 5-6 um','range',8,10,5,6,1);

  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = '2000-01-01T00:00:00Z'
   WHERE id BETWEEN 962000001 AND 962000007;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
END
$$;

-- Privilege boundary.
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF pg_catalog.has_function_privilege(v_role,'private.retired_resolution_repair_apply(text)','EXECUTE')
       OR pg_catalog.has_function_privilege(v_role,'private.retired_resolution_repair_dry_run()','EXECUTE')
       OR pg_catalog.has_function_privilege(v_role,'private._retired_resolution_repair_manifest()','EXECUTE')
       OR pg_catalog.has_table_privilege(v_role,'private.retired_resolution_repair_runs','SELECT')
       OR pg_catalog.has_table_privilege(v_role,'private.retired_resolution_repair_items','SELECT')
       OR pg_catalog.has_table_privilege(v_role,'private.retired_resolution_repair_registry_additions','SELECT') THEN
      RAISE EXCEPTION 'role % can reach the retired-concept repair', v_role;
    END IF;
  END LOOP;
END
$$;

-- Dry run: report and counts; read-only.
DO $$
DECLARE
  r jsonb := private.retired_resolution_repair_dry_run();
  v_pair jsonb;
BEGIN
  IF r->>'release_id' <> 'tax-2099.09.30-01'
     OR r->>'manifest_sha256' <> '2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49'
     OR r->>'plan_sha256' !~ '^[0-9a-f]{64}$'
     OR (r->>'link_count')::int <> 6 OR (r->>'observation_count')::int <> 5
     OR (r->>'orphan_link_count')::int <> 1
     OR r->'refusals' <> '[]'::jsonb
     OR jsonb_array_length(r->'per_pair') <> 19 THEN
    RAISE EXCEPTION 'dry run report wrong: %', r - 'items';
  END IF;
  IF r->'registry_additions' <> '[{"rank":"species","canonical_name":"Survivor s16099","sporely_taxon_id":16099},
                                  {"rank":"species","canonical_name":"Survivor s89218","sporely_taxon_id":89218}]'::jsonb THEN
    RAISE EXCEPTION 'registry additions wrong: %', r->'registry_additions';
  END IF;
  SELECT p INTO v_pair FROM jsonb_array_elements(r->'per_pair') p
   WHERE (p->>'superseded_sporely_taxon_id')::int = 626910;
  IF (v_pair->>'links')::int <> 2 OR (v_pair->>'observations')::int <> 1
     OR (v_pair->>'orphan_links')::int <> 1 OR NOT (v_pair->>'registry_addition')::boolean
     OR v_pair->>'supersession_id' <> 'taxonomy-v3-2-nortaxa-57981-superseded-by-col-3MZFS' THEN
    RAISE EXCEPTION 'per-pair 626910 wrong: %', v_pair;
  END IF;
  SELECT p INTO v_pair FROM jsonb_array_elements(r->'per_pair') p
   WHERE (p->>'superseded_sporely_taxon_id')::int = 625083;
  IF (v_pair->>'links')::int <> 1 OR (v_pair->>'registry_addition')::boolean THEN
    RAISE EXCEPTION 'per-pair 625083 wrong: %', v_pair;
  END IF;
  IF (SELECT count(*) FROM taxonomy_v3.resolution_link WHERE resolved_sporely_taxon_id IN (624585,625083,626910)) <> 5
     OR EXISTS (SELECT 1 FROM private.retired_resolution_repair_runs) THEN
    RAISE EXCEPTION 'dry run wrote';
  END IF;
  INSERT INTO rr_state VALUES ('plan', to_jsonb(r->>'plan_sha256'));
END
$$;

-- Hash mismatch and malformed hash refuse.
DO $$
BEGIN
  BEGIN
    PERFORM private.retired_resolution_repair_apply(repeat('0',64));
    RAISE EXCEPTION 'hash mismatch was not refused';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    PERFORM private.retired_resolution_repair_apply('abc');
    RAISE EXCEPTION 'malformed hash was not refused';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END
$$;

-- Each refusal condition refuses the whole run (the mutation and any write are
-- rolled back with the sub-block).
CREATE FUNCTION pg_temp.expect_refusal(p_label text, p_setup text, p_refusal text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_plan text;
BEGIN
  BEGIN
    EXECUTE p_setup;
    v_plan := private.retired_resolution_repair_dry_run()->>'plan_sha256';
    IF NOT (private.retired_resolution_repair_dry_run()->'refusals') @> jsonb_build_array(jsonb_build_object('refusal', p_refusal)) THEN
      RAISE EXCEPTION '%: dry run did not report %: %', p_label, p_refusal,
        private.retired_resolution_repair_dry_run()->'refusals';
    END IF;
    PERFORM private.retired_resolution_repair_apply(v_plan);
    RAISE EXCEPTION '%: apply was not refused', p_label USING ERRCODE = 'P0002';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE '%' || p_refusal || '%' THEN
      RAISE EXCEPTION '%: refused for the wrong reason: %', p_label, SQLERRM;
    END IF;
  END;
  IF (SELECT count(*) FROM taxonomy_v3.resolution_link WHERE resolved_sporely_taxon_id IN (624585,625083,626910)) <> 5
     OR EXISTS (SELECT 1 FROM private.retired_resolution_repair_runs)
     OR EXISTS (SELECT 1 FROM taxonomy_v3.registry_concept WHERE sporely_taxon_id IN (16099,89218)) THEN
    RAISE EXCEPTION '%: refusal left changes', p_label;
  END IF;
END
$f$;

SELECT pg_temp.expect_refusal('no active release',
  $s$UPDATE public.taxonomy_v2_releases SET status='retired' WHERE release_id='tax-2099.09.30-01'$s$,
  'active_release_count');
SELECT pg_temp.expect_refusal('survivor missing from release',
  $s$DELETE FROM public.taxonomy_v2_taxa WHERE release_id='tax-2099.09.30-01' AND sporely_taxon_id=69567$s$,
  'survivor_not_in_active_release');
SELECT pg_temp.expect_refusal('live reference use',
  $s$INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
     VALUES ('00000000-0000-4000-8000-00000002c001','84000000-0000-4000-8000-00000002c001',962000002,
             '83000000-0000-4000-8000-00000002c00a','compared',1,'{}'::jsonb)$s$,
  'live_observation_reference_uses');
SELECT pg_temp.expect_refusal('contribution on retired id',
  $s$INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
     VALUES ('00000000-0000-4000-8000-00000002c001','83000000-0000-4000-8000-00000002c00a',626800,'withdrawn',now())$s$,
  'shared_reference_contribution_on_retired_concept');
SELECT pg_temp.expect_refusal('observation disagrees with link',
  $s$UPDATE public.observations SET resolved_sporely_taxon_id=626910 WHERE id=962000001$s$,
  'link_observation_disagreement');
SELECT pg_temp.expect_refusal('observation on retired id without link',
  $s$UPDATE public.observations SET resolved_sporely_taxon_id=626800 WHERE id=962000006$s$,
  'link_observation_disagreement');
SELECT pg_temp.expect_refusal('observation selects retired id',
  $s$ALTER TABLE public.observations DROP CONSTRAINT IF EXISTS observations_selected_sporely_taxon_id_fkey;
     UPDATE public.observations SET selected_sporely_taxon_id=626800 WHERE id=962000006$s$,
  'observation_selects_retired_concept');
SELECT pg_temp.expect_refusal('registry conflict',
  $s$UPDATE taxonomy_v3.registry_concept SET canonical_name='Inocybe other' WHERE sporely_taxon_id=18893$s$,
  'registry_conflict');
SELECT pg_temp.expect_refusal('evidence not an array',
  $s$UPDATE taxonomy_v3.resolution_link SET resolution_evidence='{}' WHERE observation_id='962000003'$s$,
  'resolution_evidence_not_array');

-- Manifest tamper: a redefined literal that no longer hashes to the pin refuses.
DO $$
DECLARE
  v_def text := pg_get_functiondef('private._retired_resolution_repair_manifest()'::regprocedure);
BEGIN
  BEGIN
    EXECUTE replace(v_def, '[626910, 16099,', '[626910, 16098,');
    PERFORM private.retired_resolution_repair_dry_run();
    RAISE EXCEPTION 'tampered manifest was not refused' USING ERRCODE = 'P0002';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE '%not the pinned 9609542 ledger manifest%' THEN RAISE; END IF;
  END;
  BEGIN
    EXECUTE replace(v_def, 'superseded-by-col-3MZFS', 'superseded-by-col-3MZFX');
    PERFORM private.retired_resolution_repair_dry_run();
    RAISE EXCEPTION 'tampered supersession_id was not refused' USING ERRCODE = 'P0002';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE '%not the pinned 9609542 ledger manifest%' THEN RAISE; END IF;
  END;
  IF private.retired_resolution_repair_dry_run()->>'manifest_sha256' IS NULL THEN
    RAISE EXCEPTION 'manifest not restored';
  END IF;
END
$$;

-- Apply.
DO $$
DECLARE
  r jsonb := private.retired_resolution_repair_apply((SELECT v#>>'{}' FROM rr_state WHERE k='plan'));
  v_run bigint := (r->>'run_id')::bigint;
  v_ev jsonb;
BEGIN
  IF (r->>'link_count')::int <> 6 OR (r->>'observation_count')::int <> 5 OR r->>'plan_sha256' <> (SELECT v#>>'{}' FROM rr_state WHERE k='plan') THEN
    RAISE EXCEPTION 'apply report wrong: %', r;
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES ('962000001',89218),('962000002',89218),('962000003',18893),
                          ('962000004',16099),('962000099',16099),('962000005',18893),('962000007',69545)) x(o,t)
      LEFT JOIN taxonomy_v3.resolution_link l ON l.observation_id = x.o
     WHERE l.resolved_sporely_taxon_id IS DISTINCT FROM x.t
        OR l.resolution_state <> 'resolved_exact'
        OR l.resolution_method <> 'trusted_secondary_provider_mapping') THEN
    RAISE EXCEPTION 'links not moved correctly';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES (962000001,89218),(962000002,89218),(962000003,18893),
                          (962000004,16099),(962000005,18893),(962000007,69545)) x(o,t)
      LEFT JOIN public.observations ob ON ob.id = x.o
     WHERE ob.resolved_sporely_taxon_id IS DISTINCT FROM x.t
        OR ob.selected_sporely_taxon_id IS DISTINCT FROM (CASE WHEN x.o = 962000007 THEN 18893 END)
        OR ob.genus IS DISTINCT FROM (CASE WHEN x.o = 962000005 THEN 'Inocybe' ELSE 'Retired' END)) THEN
    RAISE EXCEPTION 'observations not moved correctly';
  END IF;
  -- updated_at bumped on the moved rows only (owner sync sees the change).
  IF (SELECT count(*) FROM public.observations WHERE id IN (962000001,962000002,962000003,962000004,962000007) AND updated_at > '2000-01-02') <> 5
     OR (SELECT count(*) FROM public.observations WHERE id IN (962000005,962000006) AND updated_at > '2000-01-02') <> 0 THEN
    RAISE EXCEPTION 'updated_at bump wrong';
  END IF;
  SELECT resolution_evidence INTO v_ev FROM taxonomy_v3.resolution_link WHERE observation_id='962000001';
  IF jsonb_array_length(v_ev) <> 2 OR v_ev->0 <> '{"kind":"exact"}'::jsonb
     OR v_ev->1 <> jsonb_build_object('kind','retired_concept_resolution_repair',
          'superseded_sporely_taxon_id',624585,'survivor_sporely_taxon_id',89218,
          'supersession_id','taxonomy-v3-2-nortaxa-52136-superseded-by-col-65ZG6',
          'ledger_commit','9609542',
          'manifest_sha256','2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49',
          'repair_run_id',v_run) THEN
    RAISE EXCEPTION 'evidence wrong: %', v_ev;
  END IF;
  IF (SELECT resolution_evidence FROM taxonomy_v3.resolution_link WHERE observation_id='962000005') <> '[]'::jsonb THEN
    RAISE EXCEPTION 'non-candidate link touched';
  END IF;
  -- Registry: exactly two added with the release's values; existing untouched.
  IF (SELECT jsonb_agg(to_jsonb(rc) ORDER BY sporely_taxon_id) FROM taxonomy_v3.registry_concept rc
       WHERE sporely_taxon_id IN (16099,89218,18893,69545)) <> '[
        {"sporely_taxon_id":16099,"canonical_name":"Survivor s16099","rank":"species","scope_state":"not_evaluated","cache_state":"out_of_cache","first_materialized_from_release":"tax-2099.09.30-01"},
        {"sporely_taxon_id":18893,"canonical_name":"Inocybe lacera","rank":"species","scope_state":"not_evaluated","cache_state":"out_of_cache","first_materialized_from_release":"tax-2099.09.26-02"},
        {"sporely_taxon_id":69545,"canonical_name":"Survivor s69545","rank":"species","scope_state":"include","cache_state":"in_cache","first_materialized_from_release":"tax-2099.09.26-02"},
        {"sporely_taxon_id":89218,"canonical_name":"Survivor s89218","rank":"species","scope_state":"not_evaluated","cache_state":"out_of_cache","first_materialized_from_release":"tax-2099.09.30-01"}]'::jsonb
     OR (SELECT count(*) FROM taxonomy_v3.registry_concept) <> 19 + 4 THEN
    RAISE EXCEPTION 'registry wrong';
  END IF;
  -- Audit.
  IF (SELECT count(*) FROM private.retired_resolution_repair_items WHERE run_id=v_run) <> 6
     OR (SELECT observation_updated FROM private.retired_resolution_repair_items
          WHERE run_id=v_run AND observation_id='962000099') IS DISTINCT FROM false
     OR (SELECT count(*) FROM private.retired_resolution_repair_items WHERE run_id=v_run AND observation_updated) <> 5
     OR (SELECT count(*) FROM private.retired_resolution_repair_registry_additions WHERE run_id=v_run) <> 2
     OR NOT EXISTS (SELECT 1 FROM private.retired_resolution_repair_runs
          WHERE run_id=v_run AND link_count=6 AND observation_count=5 AND orphan_link_count=1
            AND registry_added_count=2 AND release_id='tax-2099.09.30-01'
            AND manifest_sha256='2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49') THEN
    RAISE EXCEPTION 'audit wrong';
  END IF;
  -- The retiring-concept check's three counts are zero for these ids.
  IF EXISTS (SELECT 1 FROM public.observations o, private._retired_resolution_repair_manifest() m
              WHERE o.selected_sporely_taxon_id = m.superseded_sporely_taxon_id
                 OR o.resolved_sporely_taxon_id = m.superseded_sporely_taxon_id)
     OR EXISTS (SELECT 1 FROM taxonomy_v3.resolution_link l, private._retired_resolution_repair_manifest() m
              WHERE l.resolved_sporely_taxon_id = m.superseded_sporely_taxon_id) THEN
    RAISE EXCEPTION 'retired concepts still referenced';
  END IF;
END
$$;

-- Idempotence: a second dry run has nothing to do; its apply records an empty run.
DO $$
DECLARE
  r jsonb := private.retired_resolution_repair_dry_run();
  a jsonb;
BEGIN
  IF (r->>'link_count')::int <> 0 OR r->'registry_additions' <> '[]'::jsonb OR r->'refusals' <> '[]'::jsonb
     OR r->>'plan_sha256' = (SELECT v#>>'{}' FROM rr_state WHERE k='plan') THEN
    RAISE EXCEPTION 'second dry run not empty: %', r;
  END IF;
  BEGIN
    PERFORM private.retired_resolution_repair_apply((SELECT v#>>'{}' FROM rr_state WHERE k='plan'));
    RAISE EXCEPTION 'stale plan re-applied';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  a := private.retired_resolution_repair_apply(r->>'plan_sha256');
  IF (a->>'link_count')::int <> 0
     OR (SELECT count(*) FROM private.retired_resolution_repair_items WHERE run_id=(a->>'run_id')::bigint) <> 0
     OR (SELECT count(*) FROM taxonomy_v3.registry_concept) <> 23 THEN
    RAISE EXCEPTION 'empty apply was not a no-op: %', a;
  END IF;
END
$$;

ROLLBACK;
