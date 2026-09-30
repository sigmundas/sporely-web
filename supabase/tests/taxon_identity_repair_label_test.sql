-- Regression for the Stage 1B reference-action label
-- (20260930213813_label_unanchored_species_in_identity_repair.sql).
-- Raw-assert convention: BEGIN/ROLLBACK, RAISE EXCEPTION on failure. Local
-- fixtures only.
--
-- private._taxon_identity_repair_reconcile_references records, for a promoted
-- observation whose new taxon is not a taxonomy-v3 registry species:
--   * 'not_registry_species' when the taxon is a species in the active release
--     (the 617026 / 55368 case);
--   * 'not_species' for a non-species in the active release, and for a species
--     that only a retired release carries.
-- In every case nothing is shared: eligibility is unchanged.

BEGIN;

DO $$
DECLARE
  v_owner constant uuid := '00000000-0000-4000-8000-00000001c001';
  v_rel constant text := 'tax-2099.10.01-01';
  v_old constant text := 'tax-2099.09.15-01';
  v_species constant bigint := 2199100001;   -- species, active release, not in registry
  v_genus constant bigint := 2199100002;     -- genus, active release, not in registry
  v_retired constant bigint := 2199100003;   -- species only in the retired release
  v_obs_species constant bigint := 961000001;
  v_obs_genus constant bigint := 961000002;
  v_obs_retired constant bigint := 961000003;
  v_run bigint;
  v_actions jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (v_owner,'authenticated','authenticated','label-owner@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (v_owner,'label_owner',false);

  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
    exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
    whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
    authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
    dangling_parent_report,source_manifest
  ) VALUES
    (v_old,2,1,1,'test','test',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),
     now(),'retired','{}','{}','{}',0,'{}','{}'),
    (v_rel,2,1,1,'test','test',repeat('e',64),repeat('f',64),repeat('9',64),repeat('0',64),
     now(),'active','{}','{}','{}',0,'{}','{}');
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) VALUES
    (v_species,v_rel),(v_genus,v_rel),(v_retired,v_old);
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
    taxon_rank,canonical_source_system,canonical_external_id
  ) VALUES
    (v_rel,v_species,'Labela','species','Labela species','species','col_xr','LBL1'),
    (v_rel,v_genus,'Labela','','Labela','genus','col_xr','LBL2'),
    (v_old,v_retired,'Labela','retirata','Labela retirata','species','col_xr','LBL3');

  -- Promoted state: selected set, resolved NULL (effective taxon moved from
  -- nothing to the new concept), each with one live reference use.
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,genus,species,selected_sporely_taxon_id,taxon_identity_state
  ) OVERRIDING SYSTEM VALUE VALUES
    (v_obs_species,v_owner,current_date,'private',false,'Labela','species',v_species,'sporely_v2'),
    (v_obs_genus,v_owner,current_date,'private',false,'Labela',NULL,v_genus,'sporely_v2'),
    (v_obs_retired,v_owner,current_date,'private',false,'Labela','retirata',v_retired,'sporely_v2');
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (v_owner,'81000000-0000-4000-8000-00000001c001','article','[{"family":"Test"}]','Label regression',2026,'Test 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (v_owner,'82000000-0000-4000-8000-00000001c001','81000000-0000-4000-8000-00000001c001','local-l','Labela species',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES
    (v_owner,'83000000-0000-4000-8000-00000001c00a','82000000-0000-4000-8000-00000001c001','spore_size','8-10 x 5-6 um','range',8,10,5,6,1),
    (v_owner,'83000000-0000-4000-8000-00000001c00b','82000000-0000-4000-8000-00000001c001','spore_size','9-11 x 5-6 um','range',9,11,5,6,1),
    (v_owner,'83000000-0000-4000-8000-00000001c00c','82000000-0000-4000-8000-00000001c001','spore_size','7-9 x 4-5 um','range',7,9,4,5,1);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
  ) VALUES
    (v_owner,'84000000-0000-4000-8000-00000001c001',v_obs_species,'83000000-0000-4000-8000-00000001c00a','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001c002',v_obs_genus,'83000000-0000-4000-8000-00000001c00b','compared',1,'{}'::jsonb),
    (v_owner,'84000000-0000-4000-8000-00000001c003',v_obs_retired,'83000000-0000-4000-8000-00000001c00c','compared',1,'{}'::jsonb);

  INSERT INTO private.taxon_identity_repair_runs(
    release_id,plan_sha256,candidate_count,promoted_count,outcome_counts
  ) VALUES (v_rel,repeat('1',64),3,3,'{}'::jsonb)
  RETURNING run_id INTO v_run;

  IF private._taxon_identity_repair_reconcile_references(v_run, v_obs_species) <> 1
     OR private._taxon_identity_repair_reconcile_references(v_run, v_obs_genus) <> 1
     OR private._taxon_identity_repair_reconcile_references(v_run, v_obs_retired) <> 1 THEN
    RAISE EXCEPTION 'expected one reference action per observation';
  END IF;

  SELECT jsonb_object_agg(observation_id::text, new_contribution) INTO v_actions
    FROM private.taxon_identity_repair_reference_actions WHERE run_id = v_run;
  IF v_actions IS DISTINCT FROM jsonb_build_object(
       v_obs_species::text, 'not_registry_species',
       v_obs_genus::text, 'not_species',
       v_obs_retired::text, 'not_species') THEN
    RAISE EXCEPTION 'unexpected reference-action labels: %', v_actions;
  END IF;

  IF EXISTS (SELECT 1 FROM private.taxon_identity_repair_reference_actions
              WHERE run_id = v_run AND old_contribution <> 'none') THEN
    RAISE EXCEPTION 'old contribution must be none when the observation had no effective taxon';
  END IF;

  -- Eligibility unchanged: no contribution and no registry row was created.
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions c WHERE c.owner_id = v_owner)
     OR EXISTS (SELECT 1 FROM taxonomy_v3.registry_concept rc
                 WHERE rc.sporely_taxon_id IN (v_species, v_genus, v_retired)) THEN
    RAISE EXCEPTION 'the label change must not share or anchor anything';
  END IF;

  RAISE NOTICE 'taxon_identity_repair_label test passed';
END
$$;

ROLLBACK;
