-- Regression for the Taxonomy v3 Stage 1B unresolved-observation repair
-- (20260929120000). Raw-assert convention: BEGIN/ROLLBACK, RAISE EXCEPTION on
-- failure. Local fixtures only.
--
-- Fixture release `tax-2099.09.01-01` carries, as Stage 1A would emit:
--   * NorTaxa 53057 -> 620390 (owner-confirmed `ordinary` member, Crepidotus
--     cesatii) — must promote;
--   * NorTaxa 99990001 -> two concepts — deliberately ambiguous, unchanged.
-- It carries no bridge for 56227 (low-overlap, not approved), 58766 (awaits
-- Stage 2) or 56449 (temporary fixture), which must stay unchanged. A retired
-- release maps 56227, proving only the active release is consulted.

BEGIN;

DO $$
DECLARE
  v_owner constant uuid := '00000000-0000-4000-8000-00000001b001';
  v_other constant uuid := '00000000-0000-4000-8000-00000001b002';
  v_rel constant text := 'tax-2099.09.01-01';
  v_old constant text := 'tax-2099.08.01-01';
  v_ordinary constant bigint := 620390;
  v_amb_a constant bigint := 2199000001;
  v_amb_b constant bigint := 2199000002;
  v_low constant bigint := 620306;
  v_obs_ordinary constant bigint := 951000001;
  v_obs_other_owner constant bigint := 951000002;
  v_obs_low constant bigint := 951000003;
  v_obs_58766 constant bigint := 951000004;
  v_obs_56449 constant bigint := 951000005;
  v_obs_amb constant bigint := 951000006;
  v_obs_unbridged constant bigint := 951000007;
  v_obs_bound constant bigint := 951000008;
  v_obs_null constant bigint := 951000009;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (v_owner,'authenticated','authenticated','repair-owner@example.invalid','{}',now(),now()),
    (v_other,'authenticated','authenticated','repair-other@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (v_owner,'repair_owner',false),(v_other,'repair_other',false);

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
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) VALUES
    (v_ordinary,v_rel),(v_amb_a,v_rel),(v_amb_b,v_rel),(v_low,v_old);
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
    taxon_rank,canonical_source_system,canonical_external_id
  ) VALUES
    (v_rel,v_ordinary,'Crepidotus','cesatii','Crepidotus cesatii','species','col_xr','ZDXW'),
    (v_rel,v_amb_a,'Fixtura','alpha','Fixtura alpha','species','col_xr','AMB1'),
    (v_rel,v_amb_b,'Fixtura','beta','Fixtura beta','species','col_xr','AMB2'),
    (v_rel,v_low,'Craterellus','tubaeformis','Craterellus tubaeformis','species','col_xr','LOW1'),
    (v_old,v_low,'Craterellus','tubaeformis','Craterellus tubaeformis','species','col_xr','LOW1');
  INSERT INTO public.taxonomy_v2_external_ids(
    release_id,sporely_taxon_id,source_system,namespace,external_id,id_role,is_preferred
  ) VALUES
    (v_rel,v_ordinary,'nortaxa','nortaxa_taxon_id','53057','accepted',true),
    (v_rel,v_amb_a,'nortaxa','nortaxa_taxon_id','99990001','accepted',true),
    (v_rel,v_amb_b,'nortaxa','nortaxa_taxon_id','99990001','synonym',false),
    (v_old,v_low,'nortaxa','nortaxa_taxon_id','56227','accepted',true);

  -- The name columns deliberately disagree with the resolved concept, so a
  -- repair that read or rewrote names would be visible.
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,common_name,
    taxon_identity_state,taxon_identity_source_system,taxon_identity_namespace,
    taxon_identity_external_id,taxon_identity_raw_external_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (v_obs_ordinary,v_owner,current_date,'private',false,'Crepidotus','cesatii-snapshot','provider name',
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
    (v_obs_other_owner,v_other,current_date,'private',false,'Crepidotus','cesatii',NULL,
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
    (v_obs_low,v_owner,current_date,'private',false,'Craterellus','tubaeformis',NULL,
     'external_unresolved','nortaxa','nortaxa_taxon_id','56227','NBIC:56227'),
    (v_obs_58766,v_owner,current_date,'private',false,'Pholiotina','vexans',NULL,
     'external_unresolved','nortaxa','nortaxa_taxon_id','58766','NBIC:58766'),
    (v_obs_56449,v_owner,current_date,'private',false,'Gloeophyllum','odoratum',NULL,
     'external_unresolved','nortaxa','nortaxa_taxon_id','56449','NBIC:56449'),
    (v_obs_amb,v_owner,current_date,'private',false,'Fixtura','alpha',NULL,
     'external_unresolved','nortaxa','nortaxa_taxon_id','99990001','NBIC:99990001'),
    -- Unbridged artsorakel namespace: the repair must not invent the hop.
    (v_obs_unbridged,v_owner,current_date,'private',false,'Crepidotus','cesatii',NULL,
     'external_unresolved','artsorakel','nbic_scientific_name_id','53057','NBIC:53057'),
    (v_obs_null,v_owner,current_date,'private',false,'Crepidotus','cesatii',NULL,
     NULL,NULL,NULL,NULL,NULL);
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,selected_sporely_taxon_id,taxon_identity_state
  ) OVERRIDING SYSTEM VALUE VALUES
    (v_obs_bound,v_owner,current_date,'private',false,'Fixtura','beta',v_amb_b,'sporely_v2');

  -- Reference-use fixtures: 951000010 has a live use and no resolved taxon,
  -- so promotion would change its effective taxon without the owner-session
  -- shared-reference side effects -> blocked. 951000011 has a live use but is
  -- already resolved to the target -> the effective taxon is unchanged and it
  -- promotes.
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,resolved_sporely_taxon_id,
    taxon_identity_state,taxon_identity_source_system,taxon_identity_namespace,
    taxon_identity_external_id,taxon_identity_raw_external_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (951000010,v_owner,current_date,'private',false,'Crepidotus','cesatii',NULL,
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
    (951000011,v_owner,current_date,'private',false,'Crepidotus','cesatii',v_ordinary,
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057');
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (v_owner,'81000000-0000-4000-8000-00000001b001','article','[{"family":"Test"}]','Repair regression',2026,'Test 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (v_owner,'82000000-0000-4000-8000-00000001b001','81000000-0000-4000-8000-00000001b001','local-a','Crepidotus cesatii',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES (v_owner,'83000000-0000-4000-8000-00000001b001','82000000-0000-4000-8000-00000001b001',
            'spore_size','8-10 x 5-6 um','range',8,10,5,6,1);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
  ) VALUES
    (v_owner,'84000000-0000-4000-8000-00000001b001',951000010,'83000000-0000-4000-8000-00000001b001','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001b002',951000011,'83000000-0000-4000-8000-00000001b001','compared',1,'{}'::jsonb);

  -- Backdate updated_at (bypassing its trigger) so the repair's bump is
  -- observable inside this single transaction, where now() is constant.
  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = '2000-01-01T00:00:00Z'
   WHERE id BETWEEN 951000001 AND 951000011;
  ALTER TABLE public.observations ENABLE TRIGGER trg_observations_updated_at;
END
$$;

-- Privilege boundary, checked outside the fixture block for readability.
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF pg_catalog.has_function_privilege(v_role,'private.taxon_identity_repair_apply(text)','EXECUTE')
       OR pg_catalog.has_function_privilege(v_role,'private.taxon_identity_repair_dry_run()','EXECUTE')
       OR pg_catalog.has_function_privilege(v_role,'private._taxon_identity_repair_plan()','EXECUTE')
       OR pg_catalog.has_table_privilege(v_role,'private.taxon_identity_repair_runs','SELECT,INSERT,UPDATE,DELETE')
       OR pg_catalog.has_table_privilege(v_role,'private.taxon_identity_repair_items','SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'role % can reach the repair', v_role;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  v_dry jsonb;
  v_dry2 jsonb;
  v_applied jsonb;
  v_second jsonb;
  v_before jsonb;
  v_after jsonb;
  v_changed bigint[];
  v_planned bigint[];
  v_failed boolean;
  v_row record;
BEGIN
  -- Snapshot every fixture row (all columns) so "unchanged" is total.
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_before
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000011;

  -- ── Dry run is read-only ────────────────────────────────────────────────
  v_dry := private.taxon_identity_repair_dry_run();
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000011;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'dry run modified observations';
  END IF;
  IF EXISTS (SELECT 1 FROM private.taxon_identity_repair_runs) THEN
    RAISE EXCEPTION 'dry run wrote an audit run';
  END IF;
  IF v_dry->>'release_id' <> 'tax-2099.09.01-01'
     OR (v_dry->'outcome_counts'->>'promote')::int <> 3
     OR (v_dry->'outcome_counts'->>'ambiguous')::int <> 1
     OR (v_dry->'outcome_counts'->>'blocked_reference_use')::int <> 1
     OR (v_dry->'outcome_counts'->>'no_match')::int <> 4
     OR (v_dry->'outcome_counts'->>'error')::int <> 0
     OR (v_dry->>'candidate_count')::int <> 9 THEN
    RAISE EXCEPTION 'unexpected dry-run classification: %', v_dry;
  END IF;
  SELECT array_agg((p->>'observation_id')::bigint ORDER BY (p->>'observation_id')::bigint)
    INTO v_planned FROM jsonb_array_elements(v_dry->'promotions') p;
  IF v_planned IS DISTINCT FROM ARRAY[951000001,951000002,951000011]::bigint[] THEN
    RAISE EXCEPTION 'unexpected promotion set: %', v_planned;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_dry->'promotions') p
              WHERE (p->>'sporely_taxon_id')::bigint <> 620390) THEN
    RAISE EXCEPTION 'promotion to the wrong concept: %', v_dry->'promotions';
  END IF;

  -- Dry run is deterministic.
  v_dry2 := private.taxon_identity_repair_dry_run();
  IF v_dry2 IS DISTINCT FROM v_dry THEN
    RAISE EXCEPTION 'dry run is not deterministic';
  END IF;

  -- ── Apply refuses a missing or stale plan hash, changing nothing ───────
  v_failed := false;
  BEGIN
    PERFORM private.taxon_identity_repair_apply(NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'apply accepted a NULL plan hash'; END IF;

  v_failed := false;
  BEGIN
    PERFORM private.taxon_identity_repair_apply(repeat('0',64));
  EXCEPTION WHEN serialization_failure THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'apply accepted a stale plan hash'; END IF;
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000011;
  IF v_after IS DISTINCT FROM v_before
     OR EXISTS (SELECT 1 FROM private.taxon_identity_repair_runs) THEN
    RAISE EXCEPTION 'refused apply left changes behind';
  END IF;

  -- ── Apply with the dry run's hash ──────────────────────────────────────
  v_applied := private.taxon_identity_repair_apply(v_dry->>'plan_sha256');
  IF (v_applied - 'mode' - 'run_id' - 'promoted_count') IS DISTINCT FROM (v_dry - 'mode')
     OR (v_applied->>'promoted_count')::int <> 3 THEN
    RAISE EXCEPTION 'apply report differs from the dry run: % vs %', v_applied, v_dry;
  END IF;

  -- Exactly the planned rows changed, and only in the two identity columns
  -- plus the trigger-owned updated_at.
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000011;
  SELECT array_agg(k::bigint ORDER BY k::bigint) INTO v_changed
    FROM jsonb_object_keys(v_before) k
   WHERE v_before->k IS DISTINCT FROM v_after->k;
  IF v_changed IS DISTINCT FROM v_planned THEN
    RAISE EXCEPTION 'changed rows % differ from planned %', v_changed, v_planned;
  END IF;
  FOR v_row IN SELECT unnest(v_planned)::text AS k LOOP
    IF (v_after->v_row.k) - 'selected_sporely_taxon_id' - 'taxon_identity_state' - 'updated_at'
       IS DISTINCT FROM (v_before->v_row.k) - 'selected_sporely_taxon_id' - 'taxon_identity_state' - 'updated_at' THEN
      RAISE EXCEPTION 'promotion touched other columns on %: % -> %', v_row.k, v_before->v_row.k, v_after->v_row.k;
    END IF;
    IF (v_after->v_row.k->>'selected_sporely_taxon_id')::bigint <> 620390
       OR v_after->v_row.k->>'taxon_identity_state' <> 'sporely_v2'
       OR v_after->v_row.k->>'taxon_identity_raw_external_id' <> 'NBIC:53057'
       OR v_after->v_row.k->>'taxon_identity_external_id' <> '53057'
       OR v_after->v_row.k->>'taxon_identity_namespace' <> 'nortaxa_taxon_id' THEN
      RAISE EXCEPTION 'promoted row lost provenance: %', v_after->v_row.k;
    END IF;
    IF (v_after->v_row.k->>'updated_at')::timestamptz <= '2000-01-01T00:00:00Z' THEN
      RAISE EXCEPTION 'updated_at not bumped for %', v_row.k;
    END IF;
  END LOOP;
  IF v_after->'951000001'->>'species' <> 'cesatii-snapshot'
     OR v_after->'951000001'->>'common_name' <> 'provider name' THEN
    RAISE EXCEPTION 'name snapshot not preserved: %', v_after->'951000001';
  END IF;

  -- Audit: one run, one item per candidate, matching the report.
  IF (SELECT count(*) FROM private.taxon_identity_repair_runs) <> 1
     OR (SELECT count(*) FROM private.taxon_identity_repair_items) <> 9
     OR (SELECT count(*) FROM private.taxon_identity_repair_items WHERE outcome = 'promote') <> 3
     OR (SELECT outcome FROM private.taxon_identity_repair_items WHERE observation_id = 951000010) <> 'blocked_reference_use'
     OR (SELECT plan_sha256 FROM private.taxon_identity_repair_runs) <> v_dry->>'plan_sha256'
     OR (SELECT promoted_count FROM private.taxon_identity_repair_runs) <> 3 THEN
    RAISE EXCEPTION 'audit does not match the applied run';
  END IF;
  IF (SELECT outcome FROM private.taxon_identity_repair_items WHERE observation_id = 951000006) <> 'ambiguous'
     OR (SELECT match_count FROM private.taxon_identity_repair_items WHERE observation_id = 951000006) <> 2 THEN
    RAISE EXCEPTION 'ambiguous row not audited as ambiguous';
  END IF;

  -- ── Idempotent: a second run finds nothing and changes nothing ─────────
  v_dry2 := private.taxon_identity_repair_dry_run();
  IF (v_dry2->'outcome_counts'->>'promote')::int <> 0
     OR (v_dry2->>'candidate_count')::int <> 6 THEN
    RAISE EXCEPTION 'second dry run not empty: %', v_dry2;
  END IF;
  v_before := v_after;
  v_second := private.taxon_identity_repair_apply(v_dry2->>'plan_sha256');
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000011;
  IF v_after IS DISTINCT FROM v_before OR (v_second->>'promoted_count')::int <> 0 THEN
    RAISE EXCEPTION 'second apply changed something: %', v_second;
  END IF;

  -- Re-using the first run's hash is refused.
  v_failed := false;
  BEGIN
    PERFORM private.taxon_identity_repair_apply(v_dry->>'plan_sha256');
  EXCEPTION WHEN serialization_failure THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'apply re-used a consumed plan hash'; END IF;
END
$$;

-- ── A plan that changes between dry run and apply is refused ─────────────
DO $$
DECLARE
  v_dry jsonb;
  v_failed boolean := false;
BEGIN
  -- Stage-1A-style bridge for 56227 appears after the dry run.
  v_dry := private.taxon_identity_repair_dry_run();
  INSERT INTO public.taxonomy_v2_external_ids(
    release_id,sporely_taxon_id,source_system,namespace,external_id,id_role,is_preferred
  ) VALUES ('tax-2099.09.01-01',620306,'nortaxa','nortaxa_taxon_id','56227','accepted',true);
  BEGIN
    PERFORM private.taxon_identity_repair_apply(v_dry->>'plan_sha256');
  EXCEPTION WHEN serialization_failure THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'apply ignored a plan change'; END IF;
  IF (SELECT taxon_identity_state FROM public.observations WHERE id = 951000003) <> 'external_unresolved' THEN
    RAISE EXCEPTION 'refused apply promoted a row';
  END IF;
END
$$;

-- ── The repair source never reads name columns ───────────────────────────
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT string_agg(p.prosrc, E'\n') INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname LIKE '%taxon_identity_repair%';
  IF v_src ~* '\m(genus|species|common_name|ai_selected_\w*|scientific_name)\M' THEN
    RAISE EXCEPTION 'repair functions reference name columns';
  END IF;
END
$$;

ROLLBACK;
