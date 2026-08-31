-- Selected-taxon RPC must not issue value-identical UPDATEs.

BEGIN;

DO $$
DECLARE
  v_owner_id constant uuid := '00000000-0000-4000-8000-00000000cc01';
  v_taxon_id constant bigint := 2100000992;
  v_ctid tid;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES(v_owner_id,'authenticated','authenticated','taxon-noop@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned)
  VALUES(v_owner_id,'taxon_noop_owner',false);
  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,
    manifest_schema_version,exporter_version,scope_predicate_id,
    source_gz_sha256,source_sqlite_sha256,whole_export_sha256,manifest_sha256,
    generated_at,status,row_counts,authoritative_namespace_counts,
    legacy_source_counts,dangling_parent_count,dangling_parent_report,
    source_manifest
  ) VALUES(
    'tax-2099.01.01-01',2,1,1,'test','test',
    repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),
    now(),'active','{}','{}','{}',0,'{}','{}'
  );
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id)
  VALUES(v_taxon_id,'tax-2099.01.01-01');
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,
    canonical_scientific_name,taxon_rank,canonical_source_system,
    canonical_external_id
  ) VALUES(
    'tax-2099.01.01-01',v_taxon_id,'Russula','idempotens',
    'Russula idempotens','species','test','test-1'
  );
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES(940009992,v_owner_id,current_date,'private',false);

  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub',v_owner_id::text,'role','authenticated')::text,
    true
  );
  SET LOCAL ROLE authenticated;
  PERFORM public.set_observation_selected_taxon_v2(940009992,v_taxon_id);
  RESET ROLE;
  SELECT ctid INTO v_ctid FROM public.observations WHERE id=940009992;

  SET LOCAL ROLE authenticated;
  PERFORM public.set_observation_selected_taxon_v2(940009992,v_taxon_id);
  RESET ROLE;
  IF (SELECT ctid FROM public.observations WHERE id=940009992) IS DISTINCT FROM v_ctid THEN
    RAISE EXCEPTION 'value-identical selected taxon RPC rewrote the observation';
  END IF;
END
$$;

ROLLBACK;
