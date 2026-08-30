-- Cross-user shared-reference contribution contract.

BEGIN;

DO $$
DECLARE
  user_1 constant uuid := '00000000-0000-4000-8000-00000000c101';
  user_2 constant uuid := '00000000-0000-4000-8000-00000000c102';
  taxon_id constant integer := 2100000901;
  other_taxon_id constant integer := 2100000902;
  genus_taxon_id constant integer := 2100000903;
  contribution_1 uuid;
  contribution_2 uuid;
  first_envelope jsonb;
  result jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (user_1,'authenticated','authenticated','shared-one@example.invalid','{}',now(),now()),
    (user_2,'authenticated','authenticated','shared-two@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,display_name,is_banned) VALUES
    (user_1,'shared_one','User 1',false),
    (user_2,'shared_two','User 2',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,
    first_materialized_from_release
  ) VALUES
    (taxon_id,'Amanita muscaria','species','include','in_cache','shared-test'),
    (other_taxon_id,'Amanita testata','species','include','in_cache','shared-test'),
    (genus_taxon_id,'Amanita','genus','include','in_cache','shared-test');
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,resolved_sporely_taxon_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (940000001,user_1,current_date,'private',false,taxon_id),
    (940000002,user_2,current_date,'private',false,taxon_id);

  INSERT INTO public.reference_works(
    user_id,id,type,authors_json,title,year,doi,short_label,revision
  ) VALUES
    (user_1,'71000000-0000-4000-8000-000000000001','article',
     '[{"family":"Smith"}]','Independent interpretation one',1998,
     '10.1000/same-doi','',1),
    (user_2,'71000000-0000-4000-8000-000000000002','article',
     '[{"family":"Smith"}]','Independent interpretation two',1998,
     '10.1000/same-doi','Smith 1998',1);
  INSERT INTO public.reference_taxon_treatments(
    user_id,id,reference_work_id,taxon_id,name_as_published,revision
  ) VALUES
    (user_1,'72000000-0000-4000-8000-000000000001',
     '71000000-0000-4000-8000-000000000001','local-a','Amanita muscaria',1),
    (user_2,'72000000-0000-4000-8000-000000000002',
     '71000000-0000-4000-8000-000000000002','local-b','Amanita muscaria',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES
    (user_1,'73000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001','spore_size','8–10 × 5–6 µm',
     'range',8,10,5,6,1),
    (user_2,'73000000-0000-4000-8000-000000000002',
     '72000000-0000-4000-8000-000000000002','spore_size','9–11 × 9–12 µm',
     'range',9,11,9,12,1);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,
    reference_revision,snapshot_json
  ) VALUES
    (user_1,'74000000-0000-4000-8000-000000000001',940000001,
     '73000000-0000-4000-8000-000000000001','compared',1,
     private.reference_canonical_snapshot(user_1,'73000000-0000-4000-8000-000000000001')),
    (user_2,'74000000-0000-4000-8000-000000000002',940000002,
     '73000000-0000-4000-8000-000000000002','compared',1,
     private.reference_canonical_snapshot(user_2,'73000000-0000-4000-8000-000000000002'));

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_1::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  SELECT public.sync_observation_reference_use(
    pg_catalog.jsonb_build_object(
      'id',u.id,'observation_id',u.observation_id,
      'reference_measurement_set_id',u.reference_measurement_set_id,
      'role','supports_identification','note',NULL,'selected_at',u.selected_at,
      'reference_revision',u.reference_revision,'snapshot_json',u.snapshot_json
    ),u.row_version,'current'
  ) INTO result
  FROM public.observation_reference_uses u
  WHERE u.id='74000000-0000-4000-8000-000000000001';
  IF result->>'status' <> 'updated' THEN
    RAISE EXCEPTION 'user 1 synced use was not accepted: %', result;
  END IF;
  SELECT item->>'contribution_id',item INTO contribution_1,first_envelope
    FROM public.search_public_reference_contributions(taxon_id,50,NULL,NULL) item;
  IF contribution_1 IS NULL THEN
    RAISE EXCEPTION 'synced exact-taxon use did not become discoverable';
  END IF;

  -- A mismatched exact taxon is not inferred from names or citation metadata.
  result := public.share_reference_contribution(
    '73000000-0000-4000-8000-000000000001',other_taxon_id,1,1,1
  );
  IF result->>'status' <> 'exact_taxon_use_required' THEN
    RAISE EXCEPTION 'unassociated taxon was shared: %', result;
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_2::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM public.search_public_reference_contributions(
       taxon_id,50,NULL,NULL)) <> 1 THEN
    RAISE EXCEPTION 'user 2 could not discover user 1 contribution';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.search_public_reference_contributions(taxon_id,50,NULL,NULL) item
     WHERE item->'contributor'->>'label' <> 'shared_one'
       OR item->'snapshot'->>'raw_text' <> '8–10 × 5–6 µm'
       OR item::text LIKE '%940000001%'
       OR item::text LIKE '%71000000-0000-4000-8000-000000000001%'
       OR item::text LIKE '%72000000-0000-4000-8000-000000000001%'
  ) THEN
    RAISE EXCEPTION 'public contribution attribution/evidence/privacy projection failed';
  END IF;
  result := public.share_reference_contribution(
    '73000000-0000-4000-8000-000000000001',taxon_id,1,1,1
  );
  IF result->>'status' <> 'exact_taxon_use_required' THEN
    RAISE EXCEPTION 'user 2 could mutate user 1 contribution: %', result;
  END IF;

  -- User 2's independent copy has the same DOI but remains a separate record.
  result := public.share_reference_contribution(
    '73000000-0000-4000-8000-000000000002',taxon_id,1,1,1
  );
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'user 2 fork was not independently shared: %', result;
  END IF;
  contribution_2 := (result->'row'->>'contribution_id')::uuid;
  IF contribution_2 = contribution_1
     OR (SELECT count(*) FROM public.search_public_reference_contributions(
          taxon_id,50,NULL,NULL)) <> 2 THEN
    RAISE EXCEPTION 'matching DOI merged independent contributions';
  END IF;
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','service_role')::text,true);
  UPDATE public.observations
     SET resolved_sporely_taxon_id=other_taxon_id
   WHERE id=940000002 AND user_id=user_2;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_2::text,'role','authenticated')::text,true);
  IF EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(taxon_id,50,NULL,NULL) item
        WHERE item->>'contribution_id'=contribution_2::text
     ) OR NOT EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(other_taxon_id,50,NULL,NULL) item
        WHERE item->'contributor'->>'id'=user_2::text
     ) THEN
    RAISE EXCEPTION 'observation taxon change did not move exact-taxon discovery';
  END IF;
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','service_role')::text,true);
  UPDATE public.observations
     SET resolved_sporely_taxon_id=genus_taxon_id
   WHERE id=940000002 AND user_id=user_2;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_2::text,'role','authenticated')::text,true);
  IF EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(other_taxon_id,50,NULL,NULL)
     ) OR EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(genus_taxon_id,50,NULL,NULL)
     ) THEN
    RAISE EXCEPTION 'non-species taxon remained shared or created a contribution';
  END IF;

  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','service_role')::text,true);
  result := public.moderate_shared_reference_contribution(
    contribution_1,'hide','privacy'
  );
  IF result->>'status' <> 'updated' THEN
    RAISE EXCEPTION 'privacy moderation did not hide contribution: %', result;
  END IF;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_1::text,'role','authenticated')::text,true);
  result := public.withdraw_reference_contribution(contribution_1);
  IF result->>'status' <> 'updated' THEN
    RAISE EXCEPTION 'owner withdrawal overrode moderation: %', result;
  END IF;
  result := public.share_reference_contribution(
    '73000000-0000-4000-8000-000000000001',taxon_id,1,1,1
  );
  IF result->>'status' <> 'updated' THEN
    RAISE EXCEPTION 'hidden contribution update failed: %', result;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(taxon_id,50,NULL,NULL) item
        WHERE item->>'contribution_id'=contribution_1::text
     ) OR EXISTS (
       SELECT 1 FROM public.get_public_reference_contribution(contribution_1,1)
     ) THEN
    RAISE EXCEPTION 'moderated contribution remained publicly readable';
  END IF;
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','service_role')::text,true);
  result := public.moderate_shared_reference_contribution(contribution_1,'restore',NULL);
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_1::text,'role','authenticated')::text,true);
  IF result->>'status' <> 'updated' OR NOT EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(taxon_id,50,NULL,NULL) item
        WHERE item->>'contribution_id'=contribution_1::text
     ) THEN
    RAISE EXCEPTION 'moderation restore did not restore contribution visibility';
  END IF;

  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims',
    json_build_object('role','service_role')::text,true);
  UPDATE public.observations
     SET resolved_sporely_taxon_id=taxon_id
   WHERE id=940000002 AND user_id=user_2;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_2::text,'role','authenticated')::text,true);
  DELETE FROM public.observations WHERE id=940000002 AND user_id=user_2;
  IF EXISTS (
       SELECT 1 FROM public.search_public_reference_contributions(taxon_id,50,NULL,NULL) item
        WHERE item->>'contribution_id'=contribution_2::text
     ) THEN
    RAISE EXCEPTION 'hard-deleted last use left contribution discoverable';
  END IF;

  RESET ROLE;
  UPDATE public.reference_measurement_sets
     SET raw_text='8–11 × 5–6 µm',length_core_max=11,revision=2,row_version=row_version+1
   WHERE user_id=user_1 AND id='73000000-0000-4000-8000-000000000001';
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_1::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  result := public.share_reference_contribution(
    '73000000-0000-4000-8000-000000000001',taxon_id,1,1,2
  );
  IF result->>'status' <> 'updated' OR (result->'row'->>'revision')::integer <> 3 THEN
    RAISE EXCEPTION 'edited contribution did not create a new revision: %', result;
  END IF;
  IF (SELECT item FROM public.get_public_reference_contribution(contribution_1,1) item)
       IS DISTINCT FROM first_envelope THEN
    RAISE EXCEPTION 'historical contribution revision was rewritten';
  END IF;
  RESET ROLE;
  UPDATE public.reference_works
     SET title=repeat('x',513),authors_json='[]',year=NULL,
         revision=2,row_version=row_version+1
   WHERE user_id=user_1 AND id='71000000-0000-4000-8000-000000000001';
  IF (SELECT current_revision FROM private.shared_reference_contributions
       WHERE id=contribution_1) <> 3 THEN
    RAISE EXCEPTION 'oversized fallback label was published or blocked owner sync';
  END IF;
  UPDATE public.reference_works
     SET title='Independent interpretation one, repaired',authors_json='[{"family":"Smith"}]',
         year=1998,revision=3,row_version=row_version+1
   WHERE user_id=user_1 AND id='71000000-0000-4000-8000-000000000001';
  IF (SELECT current_revision FROM private.shared_reference_contributions
       WHERE id=contribution_1) <> 4 THEN
    RAISE EXCEPTION 'valid source repair did not refresh contribution';
  END IF;
  UPDATE public.reference_measurement_sets
     SET raw_points_json='[{"length":8.2,"width":5.1,"q":1.61}]',
         revision=3,row_version=row_version+1
   WHERE user_id=user_1 AND id='73000000-0000-4000-8000-000000000001';
  IF (SELECT current_revision FROM private.shared_reference_contributions
       WHERE id=contribution_1) <> 5
     OR NOT EXISTS (
       SELECT 1 FROM public.get_public_reference_contribution(contribution_1,5) item
        WHERE item->'snapshot'->'raw_points'->0->>'q'='1.61'
     ) THEN
    RAISE EXCEPTION 'valid raw-point q value was not preserved';
  END IF;
  UPDATE public.reference_measurement_sets
     SET raw_points_json=(
       SELECT pg_catalog.jsonb_agg(1) FROM pg_catalog.generate_series(1,10001)
     ),revision=4,row_version=row_version+1
   WHERE user_id=user_1 AND id='73000000-0000-4000-8000-000000000001';
  IF (SELECT current_revision FROM private.shared_reference_contributions
       WHERE id=contribution_1) <> 5 THEN
    RAISE EXCEPTION 'oversized raw-point source was published or blocked owner sync';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',user_1::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  result := public.withdraw_reference_contribution(contribution_1);
  IF result->>'status' <> 'updated'
     OR EXISTS (SELECT 1 FROM public.search_public_reference_contributions(
          taxon_id,50,NULL,NULL) item WHERE item->>'contribution_id'=contribution_1::text)
     OR (SELECT item->>'status' FROM public.get_public_reference_contribution(
          contribution_1,1) item) <> 'withdrawn' THEN
    RAISE EXCEPTION 'withdrawal lifecycle did not preserve a historical tombstone';
  END IF;
  RESET ROLE;

  IF has_table_privilege('authenticated','private.shared_reference_contributions','UPDATE')
     OR has_table_privilege('authenticated','private.shared_reference_contribution_revisions','SELECT')
     OR has_function_privilege('anon',
          'public.share_reference_contribution(uuid,integer,integer,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated',
          'public.search_public_reference_contributions(integer,integer,timestamptz,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
          'public.moderate_shared_reference_contribution(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'shared contribution least-privilege grants are incorrect';
  END IF;

  PERFORM public.delete_reference_library_for_account(user_2);
  DELETE FROM public.profiles WHERE id=user_2;
  IF NOT EXISTS (
       SELECT 1 FROM private.shared_reference_contributions c
        WHERE c.id=contribution_2 AND c.owner_id IS NULL
          AND c.source_measurement_set_id IS NULL AND c.status='withdrawn'
     ) OR NOT EXISTS (
       SELECT 1 FROM private.shared_reference_contribution_revisions r
        WHERE r.contribution_id=contribution_2
          AND r.envelope_json->'contributor'->'id'='null'::jsonb
          AND r.envelope_json->'contributor'->>'label'='Deleted user'
  ) THEN
    RAISE EXCEPTION 'account deletion did not retain anonymized contribution history';
  END IF;
  PERFORM public.delete_reference_library_for_account(user_1);
  DELETE FROM public.profiles WHERE id=user_1;
  IF (SELECT count(*) FROM private.shared_reference_contributions c
       WHERE c.owner_id IS NULL AND c.sporely_taxon_id=taxon_id) < 2 THEN
    RAISE EXCEPTION 'same-taxon histories collided during multi-account deletion';
  END IF;
END
$$;

ROLLBACK;
