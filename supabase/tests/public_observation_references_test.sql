-- Public observation-reference projection contract after Stage 2d
-- (20261001113007; shared by default). A frozen use snapshot is public for
-- every live use with a live source on a public, non-draft, spore-public
-- observation of an owner who is not banned, deleting or blocked with the
-- caller, whose set is not opted out and has no hidden contribution. Taxon
-- and registry membership do not matter; there is no consent and no content
-- proof (changed meaning: the Stage 2a content-proof cases 940000005,
-- 940000010 and 940000011 are now served). Output shape is unchanged
-- (landing: sporely-landing/src/lib/publicApi.ts, publicReferenceSnapshot.ts).
-- Run after local migrations with psql; the transaction is always rolled back.

BEGIN;

-- The automatic share (the deploy refresh's call), for the species-page row.
CREATE FUNCTION pg_temp.fixture_refresh(p_owner uuid, p_set uuid, p_taxon integer)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT private.reference_contribution_share_core('refresh',p_owner,p_set,p_taxon)
$$;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000c401';
  owner_b constant uuid := '00000000-0000-4000-8000-00000000c402';
  viewer constant uuid := '00000000-0000-4000-8000-00000000c403';
  banned_owner constant uuid := '00000000-0000-4000-8000-00000000c404';
  taxon constant integer := 2100000941;
  set_1 constant uuid := '33000000-0000-4000-8000-000000000001';
  set_2 constant uuid := '33000000-0000-4000-8000-000000000002';
  set_3 constant uuid := '33000000-0000-4000-8000-000000000003';
  set_4 constant uuid := '33000000-0000-4000-8000-000000000004';
  snapshot_1 jsonb;
  snapshot_2 jsonb;
  imported jsonb;
BEGIN
  INSERT INTO auth.users (id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_a,'authenticated','authenticated','public-ref-a@example.invalid','{}',now(),now()),
    (owner_b,'authenticated','authenticated','public-ref-b@example.invalid','{}',now(),now()),
    (viewer,'authenticated','authenticated','public-ref-viewer@example.invalid','{}',now(),now()),
    (banned_owner,'authenticated','authenticated','public-ref-banned@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (owner_a,'public_ref_a',false),(owner_b,'public_ref_b',false),
    (viewer,'public_ref_viewer',false),(banned_owner,'public_ref_banned',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (taxon,'Russula paludosa','species','include','in_cache','obs-ref-test'),
           -- Not a registry species (a genus): shares on observations only.
           (2100000949,'Russula','genus','include','in_cache','obs-ref-test');

  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,resolved_sporely_taxon_id,spore_data_visibility)
  OVERRIDING SYSTEM VALUE VALUES
    (940000001,owner_a,current_date,'public',false,taxon,'public'),
    (940000002,owner_a,current_date,'private',false,taxon,'public'),
    (940000003,owner_a,current_date,'public',true,taxon,'public'),
    (940000004,owner_a,current_date,'public',false,taxon,'public'),
    (940000005,owner_a,current_date,'public',false,taxon,'public'),
    (940000006,owner_b,current_date,'public',false,taxon,'public'),
    (940000007,banned_owner,current_date,'public',false,taxon,'public'),
    (940000008,owner_a,current_date,'friends',false,taxon,'public'),
    (940000009,owner_b,current_date,'public',false,taxon,'public'),
    (940000010,owner_a,current_date,'public',false,taxon,'public'),
    (940000011,owner_a,current_date,'public',false,taxon,'public'),
    (940000012,owner_a,current_date,'public',false,taxon,'private'),
    (940000013,owner_a,current_date,'public',false,taxon,'public'),
    (940000014,owner_a,current_date,'public',false,taxon,'public'),
    (940000015,owner_a,current_date,'public',false,taxon,'public'),
    (940000016,owner_a,current_date,'public',false,NULL,'public'),
    (940000017,owner_a,current_date,'public',false,2100000949,'public'),
    (940000018,owner_a,current_date,'public',false,taxon,'public');

  INSERT INTO public.reference_works(user_id,id,type,title,short_label,authors_json,year,revision) VALUES
    (owner_a,'11000000-0000-4000-8000-000000000001','book','Frozen source','Author 2026','[{"family":"Author"}]',2026,1),
    (owner_b,'11000000-0000-4000-8000-000000000001','book','Other owner source','Other 2026','[]',2026,1),
    (banned_owner,'11000000-0000-4000-8000-000000000001','book','Banned source','Banned 2026','[]',2026,1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,name_as_published,revision) VALUES
    (owner_a,'22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Russula paludosa',1),
    (owner_b,'22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Russula vesca',1),
    (banned_owner,'22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','Russula emetica',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,length_core_min,length_core_max,revision) VALUES
    (owner_a,set_1,'22000000-0000-4000-8000-000000000001','spore_size','range','8-10 µm',8,10,1),
    (owner_a,set_2,'22000000-0000-4000-8000-000000000001','spore_size','range','9-11 µm',9,11,1),
    (owner_a,set_3,'22000000-0000-4000-8000-000000000001','spore_size','range','7-8 µm',7,8,1),
    (owner_a,set_4,'22000000-0000-4000-8000-000000000001','spore_size','range','6-8 µm',6,8,1),
    (owner_b,set_1,'22000000-0000-4000-8000-000000000001','spore_size','range','7-9 µm',7,9,1),
    (banned_owner,set_1,'22000000-0000-4000-8000-000000000001','spore_size','range','9-11 µm',9,11,1);

  -- Frozen before a citation edit: same set revision, different citation.
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,note,reference_revision,snapshot_json
  ) VALUES (owner_a,'44000000-0000-4000-8000-000000000005',940000005,set_1,'compared','before citation edit',1,
            private.reference_canonical_snapshot(owner_a,set_1));
  UPDATE public.reference_works SET title='Frozen source, corrected',revision=2
   WHERE user_id=owner_a AND id='11000000-0000-4000-8000-000000000001';
  -- Frozen before a treatment edit: same set revision, different treatment.
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,note,reference_revision,snapshot_json
  ) VALUES (owner_a,'44000000-0000-4000-8000-000000000010',940000010,set_1,'compared','before treatment edit',1,
            private.reference_canonical_snapshot(owner_a,set_1));
  UPDATE public.reference_taxon_treatments SET name_as_published='Russula paludosa s.l.',revision=2
   WHERE user_id=owner_a AND id='22000000-0000-4000-8000-000000000001';

  snapshot_1 := private.reference_canonical_snapshot(owner_a,set_1);
  snapshot_2 := private.reference_canonical_snapshot(owner_a,set_2);
  -- A historical import is accepted as any valid snapshot at an old-enough
  -- revision; this one was never consented content.
  imported := jsonb_set(snapshot_1,'{measurements,length_core_min}','7.5');

  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,note,reference_revision,snapshot_json
  ) VALUES
    (owner_a,'44000000-0000-4000-8000-000000000001',940000001,set_1,'supports_identification','owner-only note',1,snapshot_1),
    (owner_a,'44000000-0000-4000-8000-000000000009',940000001,set_2,'compared','later reference',1,snapshot_2),
    (owner_a,'44000000-0000-4000-8000-000000000002',940000002,set_1,'compared','private observation',1,snapshot_1),
    (owner_a,'44000000-0000-4000-8000-000000000003',940000003,set_1,'compared','draft',1,snapshot_1),
    (owner_a,'44000000-0000-4000-8000-000000000004',940000004,set_1,'contradicts','malformed',1,snapshot_1||jsonb_build_object('private_extra','leak')),
    (owner_a,'44000000-0000-4000-8000-000000000014',940000014,set_1,'compared','raw point extra',1,
       jsonb_set(snapshot_1,'{raw_points}','[{"length":9,"source":"private plate note"}]')),
    (owner_a,'44000000-0000-4000-8000-000000000015',940000004,set_2,'compared','unsupported schema',1,jsonb_set(snapshot_2,'{schema_version}','2')),
    (owner_a,'44000000-0000-4000-8000-000000000011',940000011,set_1,'compared','historical import',1,imported),
    -- Same numbers, different spelling (8.00 vs 8): jsonb equality, not text.
    (owner_a,'44000000-0000-4000-8000-000000000016',940000015,set_1,'compared','numeric spelling',1,
       jsonb_set(snapshot_1,'{measurements,length_core_min}','8.00'::jsonb)),
    (owner_a,'44000000-0000-4000-8000-000000000012',940000012,set_1,'compared','spore data private',1,snapshot_1),
    (owner_a,'44000000-0000-4000-8000-000000000013',940000013,set_3,'compared','source later deleted',1,
       private.reference_canonical_snapshot(owner_a,set_3)),
    (owner_b,'44000000-0000-4000-8000-000000000006',940000006,set_1,'compared','other owner note',1,private.reference_canonical_snapshot(owner_b,set_1)),
    (banned_owner,'44000000-0000-4000-8000-000000000007',940000007,set_1,'compared','banned',1,private.reference_canonical_snapshot(banned_owner,set_1)),
    (owner_a,'44000000-0000-4000-8000-000000000008',940000008,set_1,'compared','friends',1,snapshot_1),
    -- Taxon-less and non-registry observations: observation page only.
    (owner_a,'44000000-0000-4000-8000-000000000017',940000016,set_2,'compared','taxon-less',1,snapshot_2),
    (owner_a,'44000000-0000-4000-8000-000000000018',940000017,set_2,'compared','non-registry',1,snapshot_2),
    -- Opted-out set.
    (owner_a,'44000000-0000-4000-8000-000000000019',940000018,set_4,'compared','opted out',1,
       private.reference_canonical_snapshot(owner_a,set_4));
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id) VALUES (owner_a,set_4);

  -- Served without any contribution (no consent, no species-page row).
  IF jsonb_array_length(public.get_public_observation_references(940000006))<>1
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions) THEN
    RAISE EXCEPTION 'observation reference needs a contribution, or a fixture write created one';
  END IF;

  IF (pg_temp.fixture_refresh(owner_a,set_1,taxon)->>'status') <> 'created'
     OR (pg_temp.fixture_refresh(owner_a,set_2,taxon)->>'status') <> 'created'
     OR (pg_temp.fixture_refresh(owner_a,set_3,taxon)->>'status') <> 'created'
     OR (pg_temp.fixture_refresh(owner_a,set_4,taxon)->>'status') <> 'opted_out'
     OR (pg_temp.fixture_refresh(owner_b,set_1,taxon)->>'status') <> 'created'
     OR (pg_temp.fixture_refresh(banned_owner,set_1,taxon)->>'status') <> 'created' THEN
    RAISE EXCEPTION 'fixture refreshes failed';
  END IF;
  UPDATE public.profiles SET is_banned=true WHERE id=banned_owner;

  -- Deleting the source withdraws its contribution, so its frozen evidence is
  -- no longer public either.
  UPDATE public.reference_measurement_sets SET deleted_at=now()
  WHERE user_id=owner_a AND id=set_3;

  INSERT INTO public.user_blocks(blocker_id,blocked_id) VALUES(viewer,owner_a);

  -- Composite ownership constraints reject cross-account attachment even for privileged writes.
  BEGIN
    INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
    VALUES(owner_b,gen_random_uuid(),940000001,set_1,'compared',1,snapshot_1);
    RAISE EXCEPTION 'cross-owner observation attachment unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

-- Anonymous reads. Blocks are caller-specific, so an anonymous caller still
-- sees owner A.
SET LOCAL ROLE anon;
DO $$
DECLARE result jsonb; rows_seen bigint; visible_ids bigint[];
BEGIN
  SELECT count(*), array_agg(observation_id ORDER BY observation_id) INTO rows_seen, visible_ids
  FROM public.search_public_observation_references(
    ARRAY[940000001,940000002,940000003,940000004,940000005,940000006,940000007,940000008,940000009,
          940000010,940000011,940000012,940000013,940000014]::bigint[]
  );
  IF rows_seen<>10 THEN RAISE EXCEPTION 'anon eligible observation row count was %, ids %',rows_seen,visible_ids; END IF;

  result:=public.get_public_observation_references(940000001);
  IF jsonb_array_length(result)<>2 THEN RAISE EXCEPTION 'frozen references missing: %',result; END IF;
  IF result->0 ? 'note' OR result->0 ? 'user_id' OR result->0 ? 'deleted_at' THEN
    RAISE EXCEPTION 'private use metadata leaked: %',result;
  END IF;
  IF result->0->>'use_id'<>'44000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'reference ordering is not deterministic: %',result;
  END IF;
  -- Landing's exact shape.
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(result->0) key)
     <> ARRAY['reference_revision','role','snapshot','use_id']
     OR result->0->>'role' <> 'supports_identification'
     OR (result->0->>'reference_revision')::integer <> 1
     OR result->0->'snapshot'->'reference_revision' <> result->0->'reference_revision'
     OR result->0->'snapshot'->>'reference_measurement_set_id' <> '33000000-0000-4000-8000-000000000001'
     OR result->0->'snapshot'->>'name_as_published' <> 'Russula paludosa s.l.' THEN
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
    RAISE EXCEPTION 'malformed or non-allowlisted snapshot did not fail closed: %',
      public.get_public_observation_references(940000004);
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(940000015))<>1 THEN
    RAISE EXCEPTION 'valid snapshot with a different number spelling was not served';
  END IF;
  -- Changed meaning (2d): without the content proof the use is served, but
  -- only the allowlisted raw-point keys are projected.
  IF public.get_public_observation_references(940000014)->0->'snapshot'->'raw_points'
       IS DISTINCT FROM '[{"length":9}]'::jsonb THEN
    RAISE EXCEPTION 'raw points with non-allowlisted keys were not projected to the allowlist: %',
      public.get_public_observation_references(940000014);
  END IF;
  -- Changed meaning (2d): the frozen version attached is served as is.
  IF jsonb_array_length(public.get_public_observation_references(940000005))<>1
     OR public.get_public_observation_references(940000005)->0->'snapshot'->>'full_citation' IS NULL
     OR jsonb_array_length(public.get_public_observation_references(940000010))<>1
     OR jsonb_array_length(public.get_public_observation_references(940000011))<>1
     OR (public.get_public_observation_references(940000011)->0->'snapshot'->'measurements'->>'length_core_min')::numeric <> 7.5 THEN
    RAISE EXCEPTION 'frozen pre-edit or imported snapshots were not served as attached';
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(940000016))<>1
     OR jsonb_array_length(public.get_public_observation_references(940000017))<>1 THEN
    RAISE EXCEPTION 'taxon-less or non-registry observation reference not served';
  END IF;
  IF public.get_public_observation_references(940000018)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'opted-out set served on the observation';
  END IF;
  IF public.get_public_observation_references(940000012)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'use on an observation with private spore data was served';
  END IF;
  IF public.get_public_observation_references(940000013)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'frozen snapshot of a deleted source was served';
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(940000006))<>1 THEN
    RAISE EXCEPTION 'reference of owner B missing';
  END IF;
  IF public.get_public_observation_references(940000009)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'eligible observation without references did not return empty array';
  END IF;
  SELECT count(*) INTO rows_seen FROM public.search_public_observation_references(
    ARRAY[940000001,940000001,940000009]::bigint[]);
  IF rows_seen<>2 THEN RAISE EXCEPTION 'duplicate observation ids were not deduplicated'; END IF;
END $$;
RESET ROLE;

-- The source deletion withdrew set 3's contribution.
DO $$ BEGIN
  IF (SELECT status FROM private.shared_reference_contributions
       WHERE owner_id='00000000-0000-4000-8000-00000000c401'
         AND source_measurement_set_id='33000000-0000-4000-8000-000000000003') <> 'withdrawn' THEN
    RAISE EXCEPTION 'source deletion did not withdraw';
  END IF;
END $$;

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
SET LOCAL request.jwt.claims='';

-- A hidden contribution of the set (even withdrawn), a deleting account and
-- an opt-out remove the exposure; share-again restores it. A system
-- withdrawal of the species-page row does not (changed meaning: in 2a it
-- did).
DO $$
DECLARE
  owner_b constant uuid := '00000000-0000-4000-8000-00000000c402';
  c_b uuid;
BEGIN
  SELECT id INTO c_b FROM private.shared_reference_contributions
   WHERE owner_id=owner_b AND source_measurement_set_id='33000000-0000-4000-8000-000000000001';
  UPDATE private.shared_reference_contributions SET hidden_at=now(),hidden_reason='privacy' WHERE id=c_b;
  IF public.get_public_observation_references(940000006)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'hidden contribution kept its observation reference public';
  END IF;
  UPDATE private.shared_reference_contributions SET hidden_at=NULL,hidden_reason=NULL WHERE id=c_b;
  INSERT INTO private.reference_account_deletions(user_id) VALUES (owner_b);
  IF public.get_public_observation_references(940000006)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'deleting account kept its observation reference public';
  END IF;
  DELETE FROM private.reference_account_deletions WHERE user_id=owner_b;
  IF jsonb_array_length(public.get_public_observation_references(940000006))<>1 THEN
    RAISE EXCEPTION 'restored fixture not served';
  END IF;
  PERFORM private.lock_shared_reference_key(owner_b,'33000000-0000-4000-8000-000000000001');
  PERFORM private.withdraw_shared_reference_contribution(c_b,'use_detached');
  IF jsonb_array_length(public.get_public_observation_references(940000006))<>1 THEN
    RAISE EXCEPTION 'a system withdrawal of the species-page row hid the observation reference';
  END IF;
  UPDATE private.shared_reference_contributions SET hidden_at=now(),hidden_reason='abuse' WHERE id=c_b;
  IF public.get_public_observation_references(940000006)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'hidden withdrawn contribution kept its observation reference public';
  END IF;
  UPDATE private.shared_reference_contributions SET hidden_at=NULL,hidden_reason=NULL WHERE id=c_b;
  -- (Each write is its own statement: a STABLE read in the same statement
  -- would see the snapshot from before the write.)
  IF private.stop_sharing_reference_set_for_owner(owner_b,'33000000-0000-4000-8000-000000000001') <> 'updated' THEN
    RAISE EXCEPTION 'stop sharing did not report updated';
  END IF;
  IF public.get_public_observation_references(940000006)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'stop sharing did not remove the observation reference';
  END IF;
  IF private.share_reference_set_again_for_owner(owner_b,'33000000-0000-4000-8000-000000000001') <> 'updated' THEN
    RAISE EXCEPTION 'share again did not report updated';
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(940000006))<>1 THEN
    RAISE EXCEPTION 'share again did not restore the observation reference';
  END IF;
END $$;

-- Deleted uses never project, even when the observation remains public.
UPDATE public.observation_reference_uses SET deleted_at=now()
WHERE user_id='00000000-0000-4000-8000-00000000c401'
  AND id='44000000-0000-4000-8000-000000000009';
SET LOCAL ROLE anon;
DO $$ BEGIN
  IF jsonb_array_length(public.get_public_observation_references(940000001))<>1 THEN
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
