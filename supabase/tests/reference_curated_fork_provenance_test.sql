-- Stage 6k dormant owner-private curated-fork provenance.

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-000000006b01';
  owner_b constant uuid := '00000000-0000-4000-8000-000000006b02';
  taxon_id constant integer := 2100000611;
  curated_work constant uuid := '6b000000-0000-4000-8000-000000000001';
  curated_treatment constant uuid := '6b000000-0000-4000-8000-000000000002';
  curated_set constant uuid := '6b000000-0000-4000-8000-000000000003';
  snapshot jsonb;
  citation jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_a,'authenticated','authenticated','fork-a@example.invalid','{}',now(),now()),
    (owner_b,'authenticated','authenticated','fork-b@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username) VALUES
    (owner_a,'fork_owner_a'),(owner_b,'fork_owner_b');
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES(taxon_id,'Russula forkensis','species','include','in_cache','stage6k-test');

  INSERT INTO private.curated_reference_works(
    id,type,authors_json,title,short_label,revision
  ) VALUES(curated_work,'article','[]','Curated source','Source 2026',1);
  INSERT INTO private.curated_reference_taxon_treatments(
    id,reference_work_id,name_as_published,revision
  ) VALUES(curated_treatment,curated_work,'Russula forkensis',1);
  INSERT INTO private.curated_reference_measurement_sets(
    id,taxon_treatment_id,character,data_kind,raw_text,revision
  ) VALUES(curated_set,curated_treatment,'spore_size','range','8–10 × 5–6 µm',1);
  INSERT INTO private.curated_reference_treatment_taxa(
    taxon_treatment_id,sporely_taxon_id,assignment_reason,revision
  ) VALUES(curated_treatment,taxon_id,'Exact Stage 6k fixture',1);
  snapshot := private.reference_curated_snapshot(curated_set,1);
  citation := private.reference_curated_citation(curated_work);
  INSERT INTO private.curated_reference_publications(
    curated_measurement_set_id,bundle_revision,curated_taxon_treatment_id,
    curated_work_id,measurement_set_revision,treatment_revision,work_revision,
    snapshot_schema_version,snapshot_json,citation_schema_version,citation_json,
    content_hash
  ) VALUES(curated_set,1,curated_treatment,curated_work,1,1,1,
    1,snapshot,1,citation,repeat('a',64));
  INSERT INTO private.curated_reference_publication_taxa(
    curated_measurement_set_id,bundle_revision,sporely_taxon_id,canonical_name
  ) VALUES(curated_set,1,taxon_id,'Russula forkensis');
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status='published',latest_bundle_revision=1,published_at=now(),
         status_changed_at=now(),row_version=2
   WHERE id=curated_set;
  PERFORM private.reference_curated_materialize_citation_exports(curated_set,1);
  PERFORM pg_catalog.set_config(
    'stage6k.source_envelope',
    (private.reference_curated_public_envelope(curated_set,1,'published',NULL)
      || jsonb_build_object(
        'sporely_taxon_id',taxon_id,
        'canonical_scientific_name','Russula forkensis'
      ))::text,
    false
  );

  INSERT INTO public.reference_works(
    user_id,id,type,title,short_label,revision
  ) VALUES
    (owner_a,'6b100000-0000-4000-8000-000000000001','article','Private A','A',1),
    (owner_b,'6b200000-0000-4000-8000-000000000001','article','Private B','B',1);
  INSERT INTO public.reference_taxon_treatments(
    user_id,id,reference_work_id,name_as_published,revision
  ) VALUES
    (owner_a,'6b100000-0000-4000-8000-000000000002','6b100000-0000-4000-8000-000000000001','Russula forkensis',1),
    (owner_b,'6b200000-0000-4000-8000-000000000002','6b200000-0000-4000-8000-000000000001','Russula forkensis',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,revision
  ) VALUES
    (owner_a,'6b100000-0000-4000-8000-000000000003','6b100000-0000-4000-8000-000000000002','spore_size','range',1),
    (owner_b,'6b200000-0000-4000-8000-000000000003','6b200000-0000-4000-8000-000000000002','spore_size','range',1);
END
$$;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000006b01","role":"authenticated"}';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  payload jsonb := jsonb_build_object(
    'curated_measurement_set_id','6b000000-0000-4000-8000-000000000003',
    'bundle_revision',1,'sporely_taxon_id',2100000611,
    'reference_work_id','6b100000-0000-4000-8000-000000000001',
    'taxon_treatment_id','6b100000-0000-4000-8000-000000000002',
    'reference_measurement_set_id','6b100000-0000-4000-8000-000000000003',
    'source_envelope_json',current_setting('stage6k.source_envelope'),
    -- This fingerprints the exact envelope bytes, not the publication's
    -- internal content_hash (which is deliberately repeat('a',64) above).
    'source_sha256',encode(digest(convert_to(
      current_setting('stage6k.source_envelope'),'UTF8'),'sha256'),'hex'));
  result jsonb;
  denied boolean := false;
BEGIN
  result := public.sync_reference_curated_fork(payload,0);
  IF result->>'status'<>'created' OR (result->'row'->>'row_version')::integer<>1
     OR result->'row'->>'id' IS NULL
     OR result->'row'->>'source_envelope_json' IS DISTINCT FROM current_setting('stage6k.source_envelope') THEN
    RAISE EXCEPTION 'valid fork provenance was not created: %',result;
  END IF;
  result := public.sync_reference_curated_fork(payload,0);
  IF result->>'status'<>'no_change' THEN
    RAISE EXCEPTION 'same-revision retry was not idempotent: %',result;
  END IF;
  result := public.sync_reference_curated_fork(payload||jsonb_build_object(
    'source_envelope_json',current_setting('stage6k.source_envelope')||' ',
    'source_sha256',encode(digest(convert_to(
      current_setting('stage6k.source_envelope')||' ','UTF8'),'sha256'),'hex')),1);
  IF result->>'status'<>'conflict' THEN
    RAISE EXCEPTION 'immutable provenance mutation did not conflict: %',result;
  END IF;
  result := public.sync_reference_curated_fork(payload||jsonb_build_object(
    'source_sha256',repeat('c',64)),0);
  IF result->>'status'<>'invalid_source' THEN
    RAISE EXCEPTION 'envelope digest mismatch did not fail closed: %',result;
  END IF;
  result := public.sync_reference_curated_fork(payload||jsonb_build_object(
    'source_envelope_json',repeat('x',1048577),
    'source_sha256',repeat('c',64)),0);
  IF result->>'status'<>'invalid_payload' THEN
    RAISE EXCEPTION 'oversized envelope was accepted: %',result;
  END IF;
  result := public.sync_reference_curated_fork(
    payload || jsonb_build_object(
      'bundle_revision',2,
      'reference_measurement_set_id','6b200000-0000-4000-8000-000000000003'
    ),0);
  IF result->>'status'<>'invalid_source' THEN
    RAISE EXCEPTION 'unknown curated revision did not fail closed: %',result;
  END IF;
  BEGIN
    INSERT INTO public.reference_curated_forks(
      user_id,curated_measurement_set_id,bundle_revision,sporely_taxon_id,
      reference_work_id,taxon_treatment_id,reference_measurement_set_id,source_sha256,
      source_envelope_json
    ) VALUES(
      auth.uid(),'6b000000-0000-4000-8000-000000000003',2,2100000611,
      '6b100000-0000-4000-8000-000000000001','6b100000-0000-4000-8000-000000000002',
      '6b100000-0000-4000-8000-000000000003',repeat('a',64),
      current_setting('stage6k.source_envelope'));
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated direct insert was allowed'; END IF;
  IF (SELECT count(*) FROM public.reference_curated_forks)<>1 THEN
    RAISE EXCEPTION 'owner read did not return exactly its own provenance';
  END IF;
END
$$;

RESET ROLE;
UPDATE private.curated_reference_measurement_sets
   SET catalogue_status='withdrawn',withdrawn_at=now(),status_changed_at=now(),row_version=row_version+1
 WHERE id='6b000000-0000-4000-8000-000000000003';
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000006b02","role":"authenticated"}';
SET LOCAL ROLE authenticated;

DO $$
DECLARE result jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM public.reference_curated_forks) THEN
    RAISE EXCEPTION 'cross-account provenance leaked through owner read';
  END IF;
  result := public.sync_reference_curated_fork(jsonb_build_object(
    'curated_measurement_set_id','6b000000-0000-4000-8000-000000000003',
    'bundle_revision',1,'sporely_taxon_id',2100000611,
    'reference_work_id','6b100000-0000-4000-8000-000000000001',
    'taxon_treatment_id','6b100000-0000-4000-8000-000000000002',
    'reference_measurement_set_id','6b100000-0000-4000-8000-000000000003',
    'source_envelope_json',current_setting('stage6k.source_envelope'),
    'source_sha256',encode(digest(convert_to(
      current_setting('stage6k.source_envelope'),'UTF8'),'sha256'),'hex')),0);
  IF result->>'status'<>'invalid_parent' THEN
    RAISE EXCEPTION 'cross-account personal graph was accepted: %',result;
  END IF;
  result := public.sync_reference_curated_fork(jsonb_build_object(
    'curated_measurement_set_id','6b000000-0000-4000-8000-000000000003',
    'bundle_revision',1,'sporely_taxon_id',2100000611,
    'reference_work_id','6b200000-0000-4000-8000-000000000001',
    'taxon_treatment_id','6b200000-0000-4000-8000-000000000002',
    'reference_measurement_set_id','6b200000-0000-4000-8000-000000000003',
    'source_envelope_json',(current_setting('stage6k.source_envelope')::jsonb
      || '{"private_note":"forged"}'::jsonb)::text,
    'source_sha256',encode(digest(convert_to(
      (current_setting('stage6k.source_envelope')::jsonb
        || '{"private_note":"forged"}'::jsonb)::text,'UTF8'),'sha256'),'hex')),0);
  IF result->>'status'<>'invalid_source' THEN
    RAISE EXCEPTION 'non-canonical envelope was accepted: %',result;
  END IF;
  result := public.sync_reference_curated_fork(jsonb_build_object(
    'curated_measurement_set_id','6b000000-0000-4000-8000-000000000003',
    'bundle_revision',1,'sporely_taxon_id',2100000611,
    'reference_work_id','6b200000-0000-4000-8000-000000000001',
    'taxon_treatment_id','6b200000-0000-4000-8000-000000000002',
    'reference_measurement_set_id','6b200000-0000-4000-8000-000000000003',
    'source_envelope_json',current_setting('stage6k.source_envelope'),
    'source_sha256',encode(digest(convert_to(
      current_setting('stage6k.source_envelope'),'UTF8'),'sha256'),'hex')),0);
  IF result->>'status'<>'created' THEN
    RAISE EXCEPTION 'frozen envelope did not restore after withdrawal: %',result;
  END IF;
END
$$;

RESET ROLE;

DELETE FROM public.reference_measurement_sets
 WHERE user_id='00000000-0000-4000-8000-000000006b02'::uuid
   AND id='6b200000-0000-4000-8000-000000000003'::uuid;
DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.reference_curated_forks
     WHERE user_id='00000000-0000-4000-8000-000000006b02'::uuid
  ) THEN RAISE EXCEPTION 'private graph deletion retained fork provenance'; END IF;
END
$$;

DO $$
BEGIN
  IF has_table_privilege('anon','public.reference_curated_forks','SELECT')
     OR has_table_privilege('authenticated','public.reference_curated_forks','INSERT')
     OR has_table_privilege('service_role','public.reference_curated_forks','SELECT')
     OR has_function_privilege('anon','public.sync_reference_curated_fork(jsonb,bigint)','EXECUTE')
     OR has_function_privilege('service_role','public.sync_reference_curated_fork(jsonb,bigint)','EXECUTE')
  THEN RAISE EXCEPTION 'fork provenance grants are broader than intended'; END IF;
  IF NOT has_table_privilege('authenticated','public.reference_curated_forks','SELECT')
     OR NOT has_function_privilege('authenticated','public.sync_reference_curated_fork(jsonb,bigint)','EXECUTE')
  THEN RAISE EXCEPTION 'owner fork provenance grants are missing'; END IF;
END
$$;

SELECT public.delete_reference_library_for_account(
  '00000000-0000-4000-8000-000000006b01'::uuid
);
DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.reference_curated_forks
     WHERE user_id='00000000-0000-4000-8000-000000006b01'::uuid
  ) THEN RAISE EXCEPTION 'account deletion retained fork provenance'; END IF;
  IF EXISTS(
    SELECT 1 FROM public.reference_works
     WHERE user_id='00000000-0000-4000-8000-000000006b01'::uuid
  ) THEN RAISE EXCEPTION 'account deletion was blocked by fork provenance'; END IF;
END
$$;

ROLLBACK;
