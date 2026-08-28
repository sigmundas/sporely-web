-- Normalized owner-private reference library contract.
-- Run after local migrations:
--   supabase db query --local --file supabase/tests/reference_library_mutation_test.sql

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000a301';
  owner_b constant uuid := '00000000-0000-4000-8000-00000000b301';
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_a, 'authenticated', 'authenticated', 'reference-a@example.invalid', '{}'::jsonb, now(), now()),
    (owner_b, 'authenticated', 'authenticated', 'reference-b@example.invalid', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username)
  VALUES (owner_a, 'reference_owner_a'), (owner_b, 'reference_owner_b')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES
    (930000001, owner_a, current_date, 'private', false),
    (930000003, owner_a, current_date, 'private', false),
    (930000002, owner_b, current_date, 'private', false)
  ON CONFLICT (id) DO NOTHING;
END
$$;

-- Owner A creates a complete graph.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000a301","role":"authenticated"}';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.sync_reference_work(
    jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000001',
      'type', 'book',
      'title', 'Owner A work',
      'short_label', 'Author 2026',
      'authors_json', '[{"family":"Author"}]'::jsonb,
      'year', 2026,
      'revision', 3
    ),
    0
  );
  IF result->>'status' <> 'created'
     OR (result->'row'->>'row_version')::bigint <> 1
     OR (result->'row'->>'revision')::integer <> 3 THEN
    RAISE EXCEPTION 'work create contract failed: %', result;
  END IF;

  -- Exact retry is a no-op and does not bump row_version.
  result := public.sync_reference_work(
    jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000001',
      'type', 'book',
      'title', 'Owner A work',
      'short_label', 'Author 2026',
      'authors_json', '[{"family":"Author"}]'::jsonb,
      'year', 2026,
      'revision', 3
    ),
    0
  );
  IF result->>'status' <> 'no_change'
     OR (result->'row'->>'row_version')::bigint <> 1 THEN
    RAISE EXCEPTION 'work retry was not idempotent: %', result;
  END IF;

  result := public.sync_reference_work(
    jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000001',
      'type', 'book',
      'title', 'changed without domain revision',
      'short_label', 'Author 2026',
      'authors_json', '[{"family":"Author"}]'::jsonb,
      'year', 2026,
      'revision', 3
    ),
    1
  );
  IF result->>'status' <> 'invalid_revision'
     OR (result->'row'->>'row_version')::bigint <> 1 THEN
    RAISE EXCEPTION 'content update without domain revision was accepted: %', result;
  END IF;

  result := public.sync_reference_work(
    jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000001',
      'type', 'book',
      'title', 'Owner A work revised',
      'short_label', 'Author 2026',
      'authors_json', '[{"family":"Author"}]'::jsonb,
      'year', 2026,
      'revision', 5
    ),
    1
  );
  IF result->>'status' <> 'updated'
     OR (result->'row'->>'row_version')::bigint <> 2
     OR (result->'row'->>'revision')::integer <> 5 THEN
    RAISE EXCEPTION 'work CAS update failed: %', result;
  END IF;

  -- A retry after a lost success response is semantic no-op even though its
  -- original CAS token is now stale.
  result := public.sync_reference_work(
    jsonb_build_object('id','10000000-0000-4000-8000-000000000001','type','book',
      'title','Owner A work revised','short_label','Author 2026',
      'authors_json','[{"family":"Author"}]'::jsonb,'year',2026,'revision',5), 1);
  IF result->>'status'<>'no_change' OR (result->'row'->>'row_version')::bigint<>2 THEN
    RAISE EXCEPTION 'lost-response work retry was not idempotent: %',result;
  END IF;

  result := public.sync_reference_work(
    jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000001',
      'type', 'book',
      'title', 'stale overwrite',
      'short_label', 'Author 2026',
      'year', 2026,
      'revision', 6
    ),
    1
  );
  IF result->>'status' <> 'conflict'
     OR result->'row'->>'title' <> 'Owner A work revised' THEN
    RAISE EXCEPTION 'stale CAS did not fail closed: %', result;
  END IF;

  result := public.sync_reference_taxon_treatment(
    jsonb_build_object(
      'id', '20000000-0000-4000-8000-000000000001',
      'reference_work_id', '10000000-0000-4000-8000-000000000001',
      'taxon_id', '7',
      'name_as_published', 'Russula paludosa',
      'locator_text', 'p. 214',
      'revision', 1
    ),
    0
  );
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'treatment create failed: %', result;
  END IF;

  result := public.sync_reference_measurement_set(
    jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000001',
      'taxon_treatment_id', '20000000-0000-4000-8000-000000000001',
      'character', 'spore_size',
      'data_kind', 'range',
      'raw_text', '8-10 x 5-6 um',
      'length_core_min', 8,
      'length_core_max', 10,
      'width_core_min', 5,
      'width_core_max', 6,
      'revision', 1
    ),
    0
  );
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'measurement-set create failed: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000001',
      'observation_id', 930000001,
      'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
      'role', 'supports_identification',
      'reference_revision', 1,
      'snapshot_json', jsonb_build_object(
        'schema_version', 1,
        'reference_work_id', '10000000-0000-4000-8000-000000000001',
        'reference_treatment_id', '20000000-0000-4000-8000-000000000001',
        'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
        'reference_revision', 1,
        'short_label', 'Author 2026',
        'full_citation', 'Author (2026) Owner A work revised.',
        'work_type', 'book',
        'year', 2026,
        'doi', null,
        'isbn', null,
        'taxon_id', '7',
        'name_as_published', 'Russula paludosa',
        'locator_text', 'p. 214',
        'page_from', null,
        'page_to', null,
        'character', 'spore_size',
        'data_kind', 'range',
        'raw_text', '8-10 x 5-6 um',
        'measurements', jsonb_build_object(
          'length_min',null,'length_core_min',8,'length_core_max',10,'length_max',null,
          'width_min',null,'width_core_min',5,'width_core_max',6,'width_max',null,
          'q_min',null,'q_max',null,'q_mean',null,'length_mean',null,'width_mean',null,
          'sample_size',null,'specimen_count',null),
        'method', jsonb_build_object('mount_medium',null,'stain',null,'preparation',null,'measurement_method',null),
        'raw_points', null
      )
    ),
    0,
    'current'
  );
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'observation reference use create failed: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000001',
      'observation_id', 930000001,
      'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
      'role', 'supports_identification',
      'reference_revision', 1,
      'selected_at', result->'row'->>'selected_at',
      'snapshot_json', result->'row'->'snapshot_json'
    ),
    0,
    'current'
  );
  IF result->>'status' <> 'no_change'
     OR (result->'row'->>'row_version')::bigint <> 1 THEN
    RAISE EXCEPTION 'use create retry was not idempotent: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id','40000000-0000-4000-8000-000000000001','observation_id',930000001,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001',
      'role','supports_identification','reference_revision',1,
      'selected_at',result->'row'->>'selected_at',
      'snapshot_json',(result->'row'->'snapshot_json')||jsonb_build_object('private_note','must not pass')
    ),1,'current');
  IF result->>'status'<>'invalid_snapshot' THEN
    RAISE EXCEPTION 'non-canonical current snapshot was accepted: %',result;
  END IF;

  -- A live use blocks source tombstoning.
  result := public.sync_reference_measurement_set(
    jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000001',
      'taxon_treatment_id', '20000000-0000-4000-8000-000000000001',
      'character', 'spore_size',
      'data_kind', 'range',
      'raw_text', '8-10 x 5-6 um',
      'revision', 2,
      'deleted', true
    ),
    1
  );
  IF result->>'status' <> 'blocked' THEN
    RAISE EXCEPTION 'live use did not block set tombstone: %', result;
  END IF;

  -- Detach is a tombstone; retry is a no-op.
  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000001',
      'observation_id', 930000001,
      'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
      'role', 'supports_identification',
      'reference_revision', 1,
      'snapshot_json', '{}'::jsonb,
      'deleted', true
    ),
    1,
    'historical_import'
  );
  IF result->>'status' <> 'updated' OR (result->'row'->>'row_version')::bigint <> 2 THEN
    RAISE EXCEPTION 'use tombstone failed: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000001',
      'observation_id', 930000001,
      'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
      'role', 'supports_identification',
      'reference_revision', 1,
      'snapshot_json', '{}'::jsonb,
      'deleted', true
    ),
    2,
    'historical_import'
  );
  IF result->>'status' <> 'no_change' OR (result->'row'->>'row_version')::bigint <> 2 THEN
    RAISE EXCEPTION 'use tombstone retry bumped state: %', result;
  END IF;

  result := public.sync_reference_measurement_set(
    jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000001',
      'taxon_treatment_id', '20000000-0000-4000-8000-000000000001',
      'character', 'spore_size', 'data_kind', 'range',
      'raw_text', '8-10 x 5-6 um revised', 'revision', 2
    ),
    1
  );
  IF result->>'status' <> 'updated' THEN
    RAISE EXCEPTION 'measurement-set revision update failed: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000001','observation_id',930000001,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001',
      'role','supports_identification','reference_revision',1,
      'snapshot_json',(SELECT snapshot_json FROM public.observation_reference_uses
        WHERE id='40000000-0000-4000-8000-000000000001')),2,'current');
  IF result->>'status'<>'invalid_snapshot' THEN RAISE EXCEPTION 'stale snapshot restored after source edit: %',result; END IF;

  -- A stale frozen attachment cannot masquerade as current, but its first
  -- cloud upload is accepted explicitly as historical evidence.
  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000003',
      'observation_id', 930000003,
      'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
      'role', 'compared', 'reference_revision', 1,
      'snapshot_json', (SELECT snapshot_json FROM public.observation_reference_uses
        WHERE id='40000000-0000-4000-8000-000000000001')
    ), 0, 'current'
  );
  IF result->>'status' <> 'invalid_snapshot' THEN
    RAISE EXCEPTION 'stale snapshot was accepted as current: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000003','observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001','role','compared',
      'reference_revision',1,'snapshot_json',jsonb_set(
        (SELECT snapshot_json FROM public.observation_reference_uses WHERE id='40000000-0000-4000-8000-000000000001'),
        '{method,private_note}','"leak"'::jsonb)),0,'historical_import');
  IF result->>'status'<>'invalid_snapshot' THEN RAISE EXCEPTION 'nested historical snapshot extension was accepted: %',result; END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000003','observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001','role','compared',
      'reference_revision',3,'snapshot_json',jsonb_set(
        (SELECT snapshot_json FROM public.observation_reference_uses WHERE id='40000000-0000-4000-8000-000000000001'),
        '{reference_revision}','3'::jsonb)),0,'historical_import');
  IF result->>'status'<>'invalid_snapshot' THEN RAISE EXCEPTION 'future historical revision was accepted: %',result; END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object(
      'id', '40000000-0000-4000-8000-000000000003',
      'observation_id', 930000003,
      'reference_measurement_set_id', '30000000-0000-4000-8000-000000000001',
      'role', 'compared', 'reference_revision', 1,
      'snapshot_json', (SELECT snapshot_json FROM public.observation_reference_uses
        WHERE id='40000000-0000-4000-8000-000000000001')
    ), 0, 'historical_import'
  );
  IF result->>'status' <> 'created' OR (result->'row'->>'reference_revision')::integer <> 1 THEN
    RAISE EXCEPTION 'historical snapshot import failed: %', result;
  END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object('id',gen_random_uuid(),'observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001','role','compared',
      'reference_revision',1,'snapshot_json',result->'row'->'snapshot_json'),0,NULL);
  IF result->>'status'<>'invalid_payload' THEN RAISE EXCEPTION 'null snapshot mode bypassed validation: %',result; END IF;

  result := public.sync_observation_reference_use(
    jsonb_build_object('id',gen_random_uuid(),'observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001','role','compared',
      'reference_revision',1,'snapshot_json',jsonb_set(
        (SELECT snapshot_json FROM public.observation_reference_uses WHERE id='40000000-0000-4000-8000-000000000003'),
        '{reference_work_id}','null'::jsonb)),0,'historical_import');
  IF result->>'status'<>'invalid_snapshot' THEN RAISE EXCEPTION 'null snapshot identity bypassed validation: %',result; END IF;

  -- Existing historical evidence may be annotated without consulting the
  -- now-newer source, but historical_import cannot rewrite it.
  result := public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000003','observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001',
      'role','supports_identification','reference_revision',1,
      'selected_at',(SELECT selected_at FROM public.observation_reference_uses WHERE id='40000000-0000-4000-8000-000000000003'),
      'snapshot_json',(SELECT snapshot_json FROM public.observation_reference_uses WHERE id='40000000-0000-4000-8000-000000000003')),1,'current');
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'snapshot-preserving note/role update failed: %',result; END IF;
  result := public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000003','observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000001',
      'role','contradicts','reference_revision',1,
      'selected_at',result->'row'->>'selected_at','snapshot_json',result->'row'->'snapshot_json'),2,'historical_import');
  IF result->>'status'<>'invalid_snapshot_mode' THEN RAISE EXCEPTION 'historical import rewrote an existing attachment: %',result; END IF;
END
$$;

RESET ROLE;

-- The same UUID is valid in a different owner's private namespace.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000b301","role":"authenticated"}';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  result jsonb;
  visible_count integer;
BEGIN
  result := public.sync_reference_work(
    jsonb_build_object('id',gen_random_uuid(),'type','book','title','Null CAS','short_label','Null','revision',1),NULL);
  IF result->>'status'<>'invalid_payload' THEN RAISE EXCEPTION 'null create CAS token was accepted: %',result; END IF;

  result := public.sync_reference_work(
    jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000001',
      'type', 'article',
      'title', 'Owner B independent copy',
      'short_label', 'Other 2026',
      'revision', 1
    ),
    0
  );
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'owner-scoped UUID collision failed: %', result;
  END IF;

  SELECT count(*) INTO visible_count FROM public.reference_works;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'owner B saw % works instead of exactly its own', visible_count;
  END IF;

  BEGIN
    INSERT INTO public.reference_works
      (user_id, id, type, title, short_label, revision)
    VALUES
      ('00000000-0000-4000-8000-00000000b301', gen_random_uuid(), 'book', 'Direct write', 'Direct', 1);
    RAISE EXCEPTION 'authenticated direct insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Cross-owner parent binding fails closed.
  result := public.sync_reference_taxon_treatment(
    jsonb_build_object(
      'id', '20000000-0000-4000-8000-000000000002',
      'reference_work_id', '10000000-0000-4000-8000-000000000099',
      'name_as_published', 'Other species',
      'revision', 1
    ),
    0
  );
  IF result->>'status' <> 'invalid_parent' THEN
    RAISE EXCEPTION 'missing/cross-owner parent did not fail closed: %', result;
  END IF;
END
$$;

RESET ROLE;

-- Raw-table privilege and RLS regression checks.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'reference_works',
    'reference_taxon_treatments',
    'reference_measurement_sets',
    'observation_reference_uses'
  ] LOOP
    IF has_table_privilege('anon', 'public.' || table_name, 'SELECT') THEN
      RAISE EXCEPTION 'anon unexpectedly has SELECT on %', table_name;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || table_name, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || table_name, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || table_name, 'DELETE') THEN
      RAISE EXCEPTION 'authenticated unexpectedly has direct mutation on %', table_name;
    END IF;
  END LOOP;
END
$$;

-- Successor fork protection: first successor wins; a second live successor
-- receives a structured conflict rather than a raw unique violation.
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000a301","role":"authenticated"}';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  result jsonb;
  successor_snapshot jsonb;
BEGIN
  result := public.sync_reference_measurement_set(
    jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000002',
      'taxon_treatment_id', '20000000-0000-4000-8000-000000000001',
      'character', 'spore_size', 'data_kind', 'range', 'revision', 2,
      'supersedes_id', '30000000-0000-4000-8000-000000000001'
    ),
    0
  );
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'first successor create failed: %', result;
  END IF;

  result := public.sync_reference_measurement_set(
    jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000003',
      'taxon_treatment_id', '20000000-0000-4000-8000-000000000001',
      'character', 'spore_size', 'data_kind', 'range', 'revision', 2,
      'supersedes_id', '30000000-0000-4000-8000-000000000001'
    ),
    0
  );
  IF result->>'status' <> 'conflict' THEN
    RAISE EXCEPTION 'successor fork did not return conflict: %', result;
  END IF;

  result := public.sync_reference_measurement_set(
    jsonb_build_object('id','30000000-0000-4000-8000-000000000004',
      'taxon_treatment_id','20000000-0000-4000-8000-000000000001',
      'character','spore_size','data_kind','range','revision',1),0);
  IF result->>'status'<>'created' THEN RAISE EXCEPTION 'independent set create failed: %',result; END IF;

  successor_snapshot:=jsonb_build_object(
    'schema_version',1,'reference_work_id','10000000-0000-4000-8000-000000000001',
    'reference_treatment_id','20000000-0000-4000-8000-000000000001',
    'reference_measurement_set_id','30000000-0000-4000-8000-000000000004','reference_revision',1,
    'short_label','Author 2026','full_citation','Author (2026) Owner A work revised.',
    'work_type','book','year',2026,'doi',null,'isbn',null,'taxon_id','7',
    'name_as_published','Russula paludosa','locator_text','p. 214','page_from',null,'page_to',null,
    'character','spore_size','data_kind','range','raw_text',null,
    'measurements',jsonb_build_object('length_min',null,'length_core_min',null,'length_core_max',null,
      'length_max',null,'width_min',null,'width_core_min',null,'width_core_max',null,'width_max',null,
      'q_min',null,'q_max',null,'q_mean',null,'length_mean',null,'width_mean',null,'sample_size',null,'specimen_count',null),
    'method',jsonb_build_object('mount_medium',null,'stain',null,'preparation',null,'measurement_method',null),'raw_points',null);
  result:=public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000003','observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000004','role','supports_identification',
      'reference_revision',1,'snapshot_json',successor_snapshot),2,'current');
  IF result->>'status'<>'invalid_successor' THEN RAISE EXCEPTION 'arbitrary retarget was accepted: %',result; END IF;

  successor_snapshot:=jsonb_set(jsonb_set(successor_snapshot,
    '{reference_measurement_set_id}','"30000000-0000-4000-8000-000000000002"'::jsonb),
    '{reference_revision}','2'::jsonb);
  result:=public.sync_observation_reference_use(
    jsonb_build_object('id','40000000-0000-4000-8000-000000000003','observation_id',930000003,
      'reference_measurement_set_id','30000000-0000-4000-8000-000000000002','role','supports_identification',
      'reference_revision',2,'snapshot_json',successor_snapshot),2,'current');
  IF result->>'status'<>'updated' THEN RAISE EXCEPTION 'verified successor adoption failed: %',result; END IF;
END
$$;

RESET ROLE;

-- Account deletion atomically marks the account, removes the graph child-first,
-- and prevents recreation while the later deletion stages are still running.
SET LOCAL ROLE service_role;
SELECT public.delete_reference_library_for_account('00000000-0000-4000-8000-00000000b301');
RESET ROLE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.reference_works WHERE user_id='00000000-0000-4000-8000-00000000b301') THEN
    RAISE EXCEPTION 'account deletion left reference rows';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id='00000000-0000-4000-8000-00000000b301') THEN
    RAISE EXCEPTION 'account deletion marker missing';
  END IF;
END $$;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000b301","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ DECLARE result jsonb; BEGIN
  result:=public.sync_reference_work(jsonb_build_object('id',gen_random_uuid(),'type','book','title','late write','short_label','late','revision',1),0);
  IF result->>'status'<>'account_deleting' THEN RAISE EXCEPTION 'write raced account deletion: %',result; END IF;
END $$;
RESET ROLE;
ROLLBACK;
