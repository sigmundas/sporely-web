-- Regression for the Taxonomy v3 Stage 1B unresolved-observation repair
-- (20260930193000). Raw-assert convention: BEGIN/ROLLBACK, RAISE EXCEPTION on
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

  -- Shared-reference fixtures. 2099000003 is the old (W3-resolved) species.
  -- Shares are seeded through the grant mode (the use inserts run without a
  -- session, so the automatic paths do not run), the carrying observations
  -- are public (decision B). Since Stage 2d (20261001113007) the repair
  -- creates an automatic share for the new taxon (changed meaning: was
  -- consent_required, nothing created).
  --   951000010: resolved 2099000003, use of set A, a consented share under
  --              2099000003 -> promotion withdraws it; an automatic share is
  --              created under 620390 ('shared').
  --   951000011: resolved 620390 already, use of set B -> effective taxon is
  --              unchanged; promotes with no reference action.
  --   951000013: resolved 2099000003, use of set C; 951000012 (not a
  --              candidate) also uses set C under 2099000003 -> the old share
  --              is kept. 951000014 (not a candidate) already carries set C
  --              under 620390 with a consented share -> refreshed, 'shared'.
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES
    (v_ordinary,'Crepidotus cesatii','species','include','in_cache',v_rel),
    (2099000003,'Fixtura gamma','species','include','in_cache',v_rel);
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,resolved_sporely_taxon_id,
    taxon_identity_state,taxon_identity_source_system,taxon_identity_namespace,
    taxon_identity_external_id,taxon_identity_raw_external_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (951000010,v_owner,current_date,'public',false,'Crepidotus','cesatii',2099000003,
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
    (951000011,v_owner,current_date,'public',false,'Crepidotus','cesatii',v_ordinary,
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
    (951000012,v_owner,current_date,'public',false,'Fixtura','gamma',2099000003,
     NULL,NULL,NULL,NULL,NULL),
    (951000013,v_owner,current_date,'public',false,'Crepidotus','cesatii',2099000003,
     'external_unresolved','nortaxa','nortaxa_taxon_id','53057','NBIC:53057'),
    (951000014,v_owner,current_date,'public',false,'Crepidotus','cesatii',v_ordinary,
     NULL,NULL,NULL,NULL,NULL);
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (v_owner,'81000000-0000-4000-8000-00000001b001','article','[{"family":"Test"}]','Repair regression',2026,'Test 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (v_owner,'82000000-0000-4000-8000-00000001b001','81000000-0000-4000-8000-00000001b001','local-a','Crepidotus cesatii',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES
    (v_owner,'83000000-0000-4000-8000-00000001b00a','82000000-0000-4000-8000-00000001b001','spore_size','8-10 x 5-6 um','range',8,10,5,6,1),
    (v_owner,'83000000-0000-4000-8000-00000001b00b','82000000-0000-4000-8000-00000001b001','spore_size','9-11 x 5-6 um','range',9,11,5,6,1),
    (v_owner,'83000000-0000-4000-8000-00000001b00c','82000000-0000-4000-8000-00000001b001','spore_size','7-9 x 4-5 um','range',7,9,4,5,1);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
  ) VALUES
    (v_owner,'84000000-0000-4000-8000-00000001b001',951000010,'83000000-0000-4000-8000-00000001b00a','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001b002',951000011,'83000000-0000-4000-8000-00000001b00b','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001b003',951000012,'83000000-0000-4000-8000-00000001b00c','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001b004',951000013,'83000000-0000-4000-8000-00000001b00c','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001b005',951000014,'83000000-0000-4000-8000-00000001b00c','compared',1,'{}'::jsonb);
  -- The use inserts share nothing; consented shares are seeded through the
  -- (unexposed) grant mode, as the 2b consent RPC will.
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions c WHERE c.owner_id=v_owner) THEN
    RAISE EXCEPTION 'seed: a use insert shared without consent';
  END IF;
  -- The fixture text replaces the shipped, inactive version-1 texts.
  DELETE FROM private.reference_share_consent_texts;
  INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope)
  VALUES (1,'en','fixture consent text',encode(sha256(convert_to('fixture consent text','UTF8')),'hex'),true,
          '{"snapshot_schema_versions":[1,2],"data_kinds":["raw_points","free_text","measurement_details"]}');
  IF (private.reference_contribution_share_core('grant',v_owner,'83000000-0000-4000-8000-00000001b00a',2099000003,1,1,1,1,'en',NULL)->>'status') <> 'created'
     OR (private.reference_contribution_share_core('grant',v_owner,'83000000-0000-4000-8000-00000001b00c',2099000003,1,1,1,1,'en',NULL)->>'status') <> 'created'
     OR (private.reference_contribution_share_core('grant',v_owner,'83000000-0000-4000-8000-00000001b00c',v_ordinary::integer,1,1,1,1,'en',NULL)->>'status') <> 'created' THEN
    RAISE EXCEPTION 'seed: could not grant the fixture contributions';
  END IF;
  IF (SELECT count(*) FROM private.shared_reference_contributions c
       WHERE c.owner_id=v_owner AND c.sporely_taxon_id=2099000003 AND c.status='shared') <> 2
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions c
       WHERE c.owner_id=v_owner AND c.sporely_taxon_id=v_ordinary
         AND c.source_measurement_set_id = '83000000-0000-4000-8000-00000001b00a') THEN
    RAISE EXCEPTION 'seed: unexpected contribution pre-state';
  END IF;

  -- Backdate updated_at (bypassing its trigger) so the repair's bump is
  -- observable inside this single transaction, where now() is constant.
  ALTER TABLE public.observations DISABLE TRIGGER trg_observations_updated_at;
  UPDATE public.observations SET updated_at = '2000-01-01T00:00:00Z'
   WHERE id BETWEEN 951000001 AND 951000013;
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

-- ── Reconciliation failure rolls the whole apply back ────────────────────
-- Each probe swaps the share helper for a failing stub inside a
-- subtransaction, runs dry run + apply, checks nothing moved, then aborts the
-- subtransaction (SQLSTATE P0R01) to restore the real helper.
DO $$
DECLARE
  v_stub text;
  v_dry jsonb;
  v_obs_before jsonb;
  v_contrib_before jsonb;
  v_failed boolean;
BEGIN
  FOREACH v_stub IN ARRAY ARRAY[
    'RAISE EXCEPTION ''stub share failure'';',
    -- refresh never creates, so 'created' is an unexpected status and raises.
    'RETURN pg_catalog.jsonb_build_object(''status'',''created'');'
  ] LOOP
    BEGIN
      EXECUTE format($f$
        CREATE OR REPLACE FUNCTION private.share_reference_contribution_for_owner(
          p_owner uuid, p_source_measurement_set_id uuid, p_sporely_taxon_id integer,
          p_expected_work_revision integer, p_expected_treatment_revision integer,
          p_expected_measurement_set_revision integer
        ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $b$
        BEGIN %s END $b$;$f$, v_stub);
      SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_obs_before
        FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000013;
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) INTO v_contrib_before
        FROM private.shared_reference_contributions c;
      v_dry := private.taxon_identity_repair_dry_run();
      v_failed := false;
      BEGIN
        PERFORM private.taxon_identity_repair_apply(v_dry->>'plan_sha256');
      EXCEPTION WHEN OTHERS THEN
        v_failed := true;
      END;
      IF NOT v_failed THEN
        RAISE EXCEPTION 'apply succeeded despite a failing reconciliation (%)', v_stub;
      END IF;
      IF (SELECT jsonb_object_agg(o.id, to_jsonb(o)) FROM public.observations o
           WHERE o.id BETWEEN 951000001 AND 951000013) IS DISTINCT FROM v_obs_before
         OR (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM private.shared_reference_contributions c)
           IS DISTINCT FROM v_contrib_before
         OR EXISTS (SELECT 1 FROM private.taxon_identity_repair_runs)
         OR EXISTS (SELECT 1 FROM private.taxon_identity_repair_reference_actions) THEN
        RAISE EXCEPTION 'failed apply left changes behind (%)', v_stub;
      END IF;
      RAISE EXCEPTION 'probe done' USING ERRCODE = 'P0R01';
    EXCEPTION WHEN SQLSTATE 'P0R01' THEN
      NULL;
    END;
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
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000013;

  -- ── Dry run is read-only ────────────────────────────────────────────────
  v_dry := private.taxon_identity_repair_dry_run();
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000013;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'dry run modified observations';
  END IF;
  IF EXISTS (SELECT 1 FROM private.taxon_identity_repair_runs) THEN
    RAISE EXCEPTION 'dry run wrote an audit run';
  END IF;
  IF v_dry->>'release_id' <> 'tax-2099.09.01-01'
     OR (v_dry->'outcome_counts'->>'promote')::int <> 5
     OR (v_dry->'outcome_counts'->>'ambiguous')::int <> 1
     OR (v_dry->'outcome_counts'->>'no_match')::int <> 4
     OR (v_dry->'outcome_counts'->>'error')::int <> 0
     OR (v_dry->>'candidate_count')::int <> 10 THEN
    RAISE EXCEPTION 'unexpected dry-run classification: %', v_dry;
  END IF;
  SELECT array_agg((p->>'observation_id')::bigint ORDER BY (p->>'observation_id')::bigint)
    INTO v_planned FROM jsonb_array_elements(v_dry->'promotions') p;
  IF v_planned IS DISTINCT FROM ARRAY[951000001,951000002,951000010,951000011,951000013]::bigint[] THEN
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
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000013;
  IF v_after IS DISTINCT FROM v_before
     OR EXISTS (SELECT 1 FROM private.taxon_identity_repair_runs) THEN
    RAISE EXCEPTION 'refused apply left changes behind';
  END IF;

  -- ── Apply with the dry run's hash ──────────────────────────────────────
  v_applied := private.taxon_identity_repair_apply(v_dry->>'plan_sha256');
  IF (v_applied - 'mode' - 'run_id' - 'promoted_count' - 'reference_action_count')
       IS DISTINCT FROM (v_dry - 'mode')
     OR (v_applied->>'promoted_count')::int <> 5
     OR (v_applied->>'reference_action_count')::int <> 2 THEN
    RAISE EXCEPTION 'apply report differs from the dry run: % vs %', v_applied, v_dry;
  END IF;

  -- Exactly the planned rows changed, and only in the two identity columns
  -- plus the trigger-owned updated_at.
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000013;
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
     OR (SELECT count(*) FROM private.taxon_identity_repair_items) <> 10
     OR (SELECT count(*) FROM private.taxon_identity_repair_items WHERE outcome = 'promote') <> 5
     OR (SELECT plan_sha256 FROM private.taxon_identity_repair_runs) <> v_dry->>'plan_sha256'
     OR (SELECT promoted_count FROM private.taxon_identity_repair_runs) <> 5 THEN
    RAISE EXCEPTION 'audit does not match the applied run';
  END IF;
  IF (SELECT outcome FROM private.taxon_identity_repair_items WHERE observation_id = 951000006) <> 'ambiguous'
     OR (SELECT match_count FROM private.taxon_identity_repair_items WHERE observation_id = 951000006) <> 2 THEN
    RAISE EXCEPTION 'ambiguous row not audited as ambiguous';
  END IF;

  -- Shared references followed the new identity: withdrawn where no
  -- qualifying use is left, kept where one is, refreshed where shared, and
  -- created (automatic) for the new taxon.
  IF (SELECT status FROM private.shared_reference_contributions
       WHERE source_measurement_set_id='83000000-0000-4000-8000-00000001b00a' AND sporely_taxon_id=2099000003) <> 'withdrawn'
     OR (SELECT status||':'||share_basis FROM private.shared_reference_contributions
       WHERE source_measurement_set_id='83000000-0000-4000-8000-00000001b00a' AND sporely_taxon_id=620390)
       IS DISTINCT FROM 'shared:automatic'
     OR (SELECT status FROM private.shared_reference_contributions
       WHERE source_measurement_set_id='83000000-0000-4000-8000-00000001b00c' AND sporely_taxon_id=2099000003) <> 'shared'
     OR (SELECT status FROM private.shared_reference_contributions
       WHERE source_measurement_set_id='83000000-0000-4000-8000-00000001b00c' AND sporely_taxon_id=620390) IS DISTINCT FROM 'shared'
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions
       WHERE source_measurement_set_id='83000000-0000-4000-8000-00000001b00b' AND status='withdrawn') THEN
    RAISE EXCEPTION 'shared references not reconciled: %',
      (SELECT jsonb_agg(jsonb_build_object('set',source_measurement_set_id,'taxon',sporely_taxon_id,'status',status))
         FROM private.shared_reference_contributions WHERE owner_id='00000000-0000-4000-8000-00000001b001');
  END IF;
  IF (SELECT array_agg(e.event||':'||e.reason ORDER BY e.id)
        FROM private.shared_reference_consent_events e
        JOIN private.shared_reference_contributions c ON c.id=e.contribution_id
       WHERE c.source_measurement_set_id='83000000-0000-4000-8000-00000001b00a'
         AND c.sporely_taxon_id=2099000003 AND e.event<>'granted')
     IS DISTINCT FROM ARRAY['withdrawn_by_system:taxon_changed'] THEN
    RAISE EXCEPTION 'old-taxon withdrawal did not record exactly one taxon_changed event';
  END IF;
  IF (SELECT count(*) FROM private.taxon_identity_repair_reference_actions) <> 2
     OR NOT EXISTS (SELECT 1 FROM private.taxon_identity_repair_reference_actions
       WHERE observation_id=951000010 AND reference_measurement_set_id='83000000-0000-4000-8000-00000001b00a'
         AND old_sporely_taxon_id=2099000003 AND new_sporely_taxon_id=620390
         AND old_contribution='withdrawn' AND new_contribution='shared')
     OR NOT EXISTS (SELECT 1 FROM private.taxon_identity_repair_reference_actions
       WHERE observation_id=951000013 AND reference_measurement_set_id='83000000-0000-4000-8000-00000001b00c'
         AND old_contribution='kept_by_other_use' AND new_contribution='shared') THEN
    RAISE EXCEPTION 'reference actions not audited: %',
      (SELECT jsonb_agg(to_jsonb(a)) FROM private.taxon_identity_repair_reference_actions a);
  END IF;

  -- ── Idempotent: a second run finds nothing and changes nothing ─────────
  v_dry2 := private.taxon_identity_repair_dry_run();
  IF (v_dry2->'outcome_counts'->>'promote')::int <> 0
     OR (v_dry2->>'candidate_count')::int <> 5 THEN
    RAISE EXCEPTION 'second dry run not empty: %', v_dry2;
  END IF;
  v_before := v_after;
  v_second := private.taxon_identity_repair_apply(v_dry2->>'plan_sha256');
  SELECT jsonb_object_agg(o.id, to_jsonb(o)) INTO v_after
    FROM public.observations o WHERE o.id BETWEEN 951000001 AND 951000013;
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
  -- `rank = 'species'` is a registry rank literal, not a name column, so the
  -- species column is matched only as a qualified reference.
  IF v_src ~* '\m(genus|common_name|ai_selected_\w*|scientific_name|species_guess)\M'
     OR v_src ~* '\.species\M' THEN
    RAISE EXCEPTION 'repair functions reference name columns';
  END IF;
END
$$;

ROLLBACK;
