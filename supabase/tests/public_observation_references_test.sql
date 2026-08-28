-- Frozen public observation-reference projection contract.
-- Run after local migrations with psql; the transaction is always rolled back.

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000c401';
  owner_b constant uuid := '00000000-0000-4000-8000-00000000c402';
  viewer constant uuid := '00000000-0000-4000-8000-00000000c403';
  banned_owner constant uuid := '00000000-0000-4000-8000-00000000c404';
  snapshot_a jsonb;
  snapshot_a_second jsonb;
BEGIN
  INSERT INTO auth.users (id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_a,'authenticated','authenticated','public-ref-a@example.invalid','{}',now(),now()),
    (owner_b,'authenticated','authenticated','public-ref-b@example.invalid','{}',now(),now()),
    (viewer,'authenticated','authenticated','public-ref-viewer@example.invalid','{}',now(),now()),
    (banned_owner,'authenticated','authenticated','public-ref-banned@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (owner_a,'public_ref_a',false),(owner_b,'public_ref_b',false),
    (viewer,'public_ref_viewer',false),(banned_owner,'public_ref_banned',true);

  INSERT INTO public.observations(id,user_id,date,visibility,is_draft) OVERRIDING SYSTEM VALUE VALUES
    (940000001,owner_a,current_date,'public',false),
    (940000002,owner_a,current_date,'private',false),
    (940000003,owner_a,current_date,'public',true),
    (940000004,owner_a,current_date,'public',false),
    (940000005,owner_a,current_date,'public',false),
    (940000006,owner_b,current_date,'public',false),
    (940000007,banned_owner,current_date,'public',false),
    (940000008,owner_a,current_date,'friends',false),
    (940000009,owner_b,current_date,'public',false);

  INSERT INTO public.reference_works(user_id,id,type,title,short_label,authors_json,year,revision) VALUES
    (owner_a,'11000000-0000-4000-8000-000000000001','book','Frozen source','Author 2026','[{"family":"Author"}]',2026,1),
    (owner_b,'11000000-0000-4000-8000-000000000001','book','Other owner source','Other 2026','[]',2026,1),
    (banned_owner,'11000000-0000-4000-8000-000000000001','book','Banned source','Banned 2026','[]',2026,1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,name_as_published,revision) VALUES
    (owner_a,'22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Russula paludosa',1),
    (owner_b,'22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Russula vesca',1),
    (banned_owner,'22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Russula emetica',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,length_core_min,length_core_max,revision) VALUES
    (owner_a,'33000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','spore_size','range','8-10 µm',8,10,1),
    (owner_a,'33000000-0000-4000-8000-000000000002','22000000-0000-4000-8000-000000000001','spore_size','range','9-11 µm',9,11,1),
    (owner_b,'33000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','spore_size','range','7-9 µm',7,9,1),
    (banned_owner,'33000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','spore_size','range','9-11 µm',9,11,1);

  snapshot_a := private.reference_canonical_snapshot(owner_a,'33000000-0000-4000-8000-000000000001');
  snapshot_a := jsonb_set(snapshot_a,'{raw_points}','[{"length":9,"source":"private plate note"}]');
  snapshot_a_second := private.reference_canonical_snapshot(owner_a,'33000000-0000-4000-8000-000000000002');

  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,note,reference_revision,snapshot_json
  ) VALUES
    (owner_a,'44000000-0000-4000-8000-000000000001',940000001,'33000000-0000-4000-8000-000000000001','supports_identification','owner-only note',1,snapshot_a),
    (owner_a,'44000000-0000-4000-8000-000000000009',940000001,'33000000-0000-4000-8000-000000000002','compared','later reference',1,snapshot_a_second),
    (owner_a,'44000000-0000-4000-8000-000000000002',940000002,'33000000-0000-4000-8000-000000000001','compared','private observation',1,snapshot_a),
    (owner_a,'44000000-0000-4000-8000-000000000003',940000003,'33000000-0000-4000-8000-000000000001','compared','draft',1,snapshot_a),
    (owner_a,'44000000-0000-4000-8000-000000000004',940000004,'33000000-0000-4000-8000-000000000001','contradicts','malformed',1,snapshot_a||jsonb_build_object('private_extra','leak')),
    (owner_a,'44000000-0000-4000-8000-000000000010',940000004,'33000000-0000-4000-8000-000000000002','compared','unsupported schema',1,jsonb_set(snapshot_a_second,'{schema_version}','2')),
    (owner_a,'44000000-0000-4000-8000-000000000005',940000005,'33000000-0000-4000-8000-000000000001','compared','source later deleted',1,snapshot_a),
    (owner_b,'44000000-0000-4000-8000-000000000006',940000006,'33000000-0000-4000-8000-000000000001','compared','other owner note',1,private.reference_canonical_snapshot(owner_b,'33000000-0000-4000-8000-000000000001')),
    (banned_owner,'44000000-0000-4000-8000-000000000007',940000007,'33000000-0000-4000-8000-000000000001','compared','banned',1,private.reference_canonical_snapshot(banned_owner,'33000000-0000-4000-8000-000000000001')),
    (owner_a,'44000000-0000-4000-8000-000000000008',940000008,'33000000-0000-4000-8000-000000000001','compared','friends',1,snapshot_a);

  -- Frozen evidence remains publishable after its mutable private source is tombstoned.
  UPDATE public.reference_measurement_sets SET deleted_at=now()
  WHERE user_id=owner_a AND id='33000000-0000-4000-8000-000000000001';

  INSERT INTO public.user_blocks(blocker_id,blocked_id) VALUES(viewer,owner_a);

  -- Composite ownership constraints reject cross-account attachment even for privileged writes.
  BEGIN
    INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
    VALUES(owner_b,gen_random_uuid(),940000001,'33000000-0000-4000-8000-000000000001','compared',1,snapshot_a);
    RAISE EXCEPTION 'cross-owner observation attachment unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Anonymous reads public/non-draft/non-banned observations. Blocks are caller-specific,
-- so an anonymous caller still sees owner A.
SET LOCAL ROLE anon;
DO $$
DECLARE result jsonb; rows_seen bigint; visible_ids bigint[];
BEGIN
  SELECT count(*) INTO rows_seen FROM public.search_public_observation_references(
    ARRAY[940000001,940000002,940000003,940000004,940000005,940000006,940000007,940000008,940000009]::bigint[]
  );
  SELECT array_agg(observation_id ORDER BY observation_id) INTO visible_ids
  FROM public.search_public_observation_references(
    ARRAY[940000001,940000002,940000003,940000004,940000005,940000006,940000007,940000008,940000009]::bigint[]
  );
  IF rows_seen<>5 THEN RAISE EXCEPTION 'anon eligible observation row count was %, ids %',rows_seen,visible_ids; END IF;

  result:=public.get_public_observation_references(940000001);
  IF jsonb_array_length(result)<>2 THEN RAISE EXCEPTION 'public frozen references missing: %',result; END IF;
  IF result->0 ? 'note' OR result->0 ? 'user_id' OR result->0 ? 'deleted_at' THEN
    RAISE EXCEPTION 'private use metadata leaked: %',result;
  END IF;
  IF result->0->'snapshot' ? 'private_extra'
     OR result->0->'snapshot'->'raw_points'->0 ? 'source' THEN
    RAISE EXCEPTION 'non-allowlisted snapshot data leaked: %',result;
  END IF;
  IF result->0->>'use_id'<>'44000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'reference ordering is not deterministic: %',result;
  END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(result->0) key)
     <> ARRAY['reference_revision','role','snapshot','use_id'] THEN
    RAISE EXCEPTION 'public use item shape changed: %',result->0;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(result->0->'snapshot'))<>22
     OR (SELECT count(*) FROM jsonb_object_keys(result->0->'snapshot'->'measurements'))<>15
     OR (SELECT count(*) FROM jsonb_object_keys(result->0->'snapshot'->'method'))<>4 THEN
    RAISE EXCEPTION 'public snapshot allowlist shape changed: %',result->0->'snapshot';
  END IF;

  IF public.get_public_observation_references(940000002) IS NOT NULL
     OR public.get_public_observation_references(940000003) IS NOT NULL
     OR public.get_public_observation_references(940000007) IS NOT NULL
     OR public.get_public_observation_references(940000008) IS NOT NULL THEN
    RAISE EXCEPTION 'private/draft/banned/friends observation leaked';
  END IF;
  IF public.get_public_observation_references(940000004)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'malformed snapshot did not fail closed';
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(940000005))<>1 THEN
    RAISE EXCEPTION 'frozen snapshot disappeared with tombstoned source';
  END IF;
  IF public.get_public_observation_references(940000009)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'eligible observation without references did not return empty array';
  END IF;
  SELECT count(*) INTO rows_seen FROM public.search_public_observation_references(
    ARRAY[940000001,940000001,940000009]::bigint[]);
  IF rows_seen<>2 THEN RAISE EXCEPTION 'duplicate observation ids were not deduplicated'; END IF;
END $$;
RESET ROLE;

-- The owner gets no private/draft exception through this public API.
SET LOCAL request.jwt.claims='{"sub":"00000000-0000-4000-8000-00000000c401","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF public.get_public_observation_references(940000002) IS NOT NULL
     OR public.get_public_observation_references(940000003) IS NOT NULL THEN
    RAISE EXCEPTION 'owner private/draft exception leaked through public API';
  END IF;
END $$;
RESET ROLE;

-- Authenticated blocks are symmetric and hide owner A, while unrelated public
-- observations remain visible.
SET LOCAL request.jwt.claims='{"sub":"00000000-0000-4000-8000-00000000c403","role":"authenticated"}';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.get_public_observation_references(940000001) IS NOT NULL THEN
    RAISE EXCEPTION 'blocked owner reference leaked';
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(940000006))<>1 THEN
    RAISE EXCEPTION 'unblocked public reference missing';
  END IF;
END $$;
RESET ROLE;

-- Deleted uses never project, even when the observation remains public.
UPDATE public.observation_reference_uses SET deleted_at=now()
WHERE user_id='00000000-0000-4000-8000-00000000c402'
  AND id='44000000-0000-4000-8000-000000000006';
SET LOCAL ROLE anon;
DO $$ BEGIN
  IF public.get_public_observation_references(940000006)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'tombstoned use leaked';
  END IF;
END $$;
RESET ROLE;

-- Input caps and grants are part of the public contract.
DO $$ BEGIN
  IF has_function_privilege('public','public.search_public_observation_references(bigint[])','EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC retained execute on batch reference projection';
  END IF;
  IF NOT has_function_privilege('anon','public.search_public_observation_references(bigint[])','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_public_observation_references(bigint)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.search_public_observation_references(bigint[])','EXECUTE') THEN
    RAISE EXCEPTION 'expected public projection grants are missing';
  END IF;
  IF has_table_privilege('anon','public.observation_reference_uses','SELECT')
     OR has_table_privilege('anon','public.reference_measurement_sets','SELECT') THEN
    RAISE EXCEPTION 'normalized private tables became anonymously readable';
  END IF;
  IF to_regprocedure('public.search_public_reference_values(text,text,integer)') IS NULL
     OR NOT has_function_privilege('anon','public.search_public_reference_values(text,text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'legacy public-reference search contract changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('search_public_observation_references','get_public_observation_references')
      AND (p.prosecdef IS NOT TRUE OR NOT (p.proconfig @> ARRAY['search_path=""']))
  ) THEN
    RAISE EXCEPTION 'public projection definer/search_path hardening changed';
  END IF;
END $$;

DO $$ BEGIN
  PERFORM public.search_public_observation_references(array_fill(940000001::bigint,ARRAY[201]));
  RAISE EXCEPTION 'oversized observation array unexpectedly accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;

DO $$ BEGIN
  PERFORM public.search_public_observation_references(
    ARRAY(SELECT generate_series(950000001::bigint,950000101::bigint)));
  RAISE EXCEPTION 'oversized distinct observation set unexpectedly accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;

ROLLBACK;
