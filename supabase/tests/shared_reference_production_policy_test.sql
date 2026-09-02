-- Production rate, pagination, and retention policy contract.

BEGIN;

DO $$
DECLARE
  v_owner_id constant uuid := '00000000-0000-4000-8000-00000000d101';
  taxon_id constant integer := 2100000911;
  item jsonb;
  i integer;
  cleanup jsonb;
  v_actor_hash text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM private.shared_reference_production_policy p
     WHERE p.singleton
       AND p.authenticated_requests_per_minute=60
       AND p.anonymous_requests_per_minute=30
       AND p.catalogue_default_page_size=25
       AND p.catalogue_max_page_size=100
       AND p.scientific_revision_retention='indefinite'
       AND p.operational_log_retention=interval '90 days'
       AND p.abuse_metadata_retention=interval '30 days'
       AND p.takedown_initial_review_business_days=5
  ) THEN
    RAISE EXCEPTION 'approved production policy values are not configured';
  END IF;

  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES (v_owner_id,'authenticated','authenticated','policy-owner@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,display_name,is_banned)
  VALUES (v_owner_id,'policy_owner','Policy Owner',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES
    (taxon_id,'Amanita policyensis','species','include','in_cache','policy-test'),
    (taxon_id+1,'Amanita policyaltera','species','include','in_cache','policy-test');
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,resolved_sporely_taxon_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (940000011,v_owner_id,current_date,'private',false,taxon_id),
    (940000012,v_owner_id,current_date,'private',false,taxon_id);

  INSERT INTO private.shared_reference_contributions(
    id,owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,shared_at
  )
  SELECT gen_random_uuid(),v_owner_id,gen_random_uuid(),taxon_id,'shared',1,
         now()-(n || ' seconds')::interval
    FROM generate_series(1,30) n;
  INSERT INTO private.shared_reference_contribution_revisions(
    contribution_id,revision,source_work_revision,source_treatment_revision,
    source_measurement_set_revision,content_hash,envelope_json
  )
  SELECT c.id,1,1,1,1,repeat('a',64),jsonb_build_object(
    'contribution_id',c.id,'revision',1,'status','shared','shared_at',c.shared_at
  )
    FROM private.shared_reference_contributions c WHERE c.owner_id=v_owner_id;

  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  PERFORM set_config('request.headers','{"x-sporely-session-id":"policy-anon-pages"}',true);
  v_actor_hash := private.shared_reference_rate_limit_actor();
  PERFORM set_config('request.headers','{"x-forwarded-for":"203.0.113.99","x-sporely-session-id":"rotated"}',true);
  IF private.shared_reference_rate_limit_actor() IS DISTINCT FROM v_actor_hash THEN
    RAISE EXCEPTION 'untrusted anonymous headers bypassed the shared fallback bucket';
  END IF;
  IF (SELECT count(*) FROM public.search_public_reference_contributions(taxon_id,NULL,NULL,NULL)) <> 25
     OR (SELECT count(*) FROM public.search_public_reference_contributions(taxon_id,100,NULL,NULL)) <> 30 THEN
    RAISE EXCEPTION 'catalogue default/max page policy was not applied';
  END IF;
  BEGIN
    PERFORM * FROM public.search_public_reference_contributions(taxon_id,101,NULL,NULL);
    RAISE EXCEPTION 'catalogue accepted a page above 100';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM set_config('request.headers','{"x-sporely-session-id":"policy-anon-limit"}',true);
  FOR i IN 1..30 LOOP
    PERFORM * FROM public.get_public_reference_contribution(gen_random_uuid(),NULL);
  END LOOP;
  PERFORM set_config('response.status','200',true);
  PERFORM * FROM public.get_public_reference_contribution(gen_random_uuid(),NULL);
  IF current_setting('response.status',true) <> '429'
     OR current_setting('response.headers',true)::jsonb->0->>'Retry-After' IS NULL THEN
    RAISE EXCEPTION 'anonymous request 31 was not throttled with Retry-After';
  END IF;

  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM set_config('response.status','200',true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_owner_id::text,'role','authenticated')::text,true);
  PERFORM set_config('request.headers','{}',true);
  FOR i IN 1..60 LOOP
    PERFORM * FROM public.get_public_reference_contribution(gen_random_uuid(),NULL);
  END LOOP;
  item := public.sync_reference_work('{}'::jsonb,0);
  IF current_setting('response.status',true) <> '429'
     OR item->>'status' <> 'rate_limited' THEN
    RAISE EXCEPTION 'authenticated source-sync request 61 was not throttled';
  END IF;

  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM set_config('response.status','200',true);
  FOR i IN 1..59 LOOP
    PERFORM * FROM public.get_public_reference_contribution(gen_random_uuid(),NULL);
  END LOOP;
  UPDATE public.observations SET resolved_sporely_taxon_id=taxon_id+1
   WHERE id IN (940000011,940000012) AND user_id=v_owner_id;
  UPDATE public.observations SET resolved_sporely_taxon_id=taxon_id
   WHERE id IN (940000011,940000012) AND user_id=v_owner_id;
  IF current_setting('response.status',true) <> '429'
     OR (SELECT count(*) FROM public.observations
          WHERE id IN (940000011,940000012) AND user_id=v_owner_id
            AND resolved_sporely_taxon_id=taxon_id+1) <> 2 THEN
    RAISE EXCEPTION 'direct multi-row taxon update was not atomically throttled';
  END IF;

  INSERT INTO private.shared_reference_rate_buckets(actor_hash,window_started_at,request_count)
  VALUES (repeat('b',64),now()-interval '31 days',1);
  INSERT INTO private.shared_reference_policy_events(event_type,contribution_id,reason,occurred_at)
  VALUES
    ('takedown_hidden',(SELECT id FROM private.shared_reference_contributions WHERE owner_id=v_owner_id LIMIT 1),'legal',now()-interval '91 days'),
    ('takedown_hidden',(SELECT id FROM private.shared_reference_contributions WHERE owner_id=v_owner_id LIMIT 1),'privacy',now()-interval '89 days');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SET LOCAL ROLE service_role;
  cleanup := private.apply_shared_reference_policy_retention();
  RESET ROLE;
  IF (cleanup->>'rate_limit_rows_deleted')::integer <> 1
     OR (cleanup->>'operational_log_rows_deleted')::integer <> 1
     OR EXISTS (SELECT 1 FROM private.shared_reference_rate_buckets WHERE actor_hash=repeat('b',64))
     OR (SELECT count(*) FROM private.shared_reference_policy_events) <> 1 THEN
    RAISE EXCEPTION 'policy retention cleanup did not apply 30/90-day windows: %',cleanup;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname='shared-reference-policy-retention'
       AND schedule='17 3 * * *'
       AND command='SELECT private.apply_shared_reference_policy_retention()'
  ) THEN
    RAISE EXCEPTION 'daily policy-retention maintenance is not scheduled';
  END IF;

  IF has_table_privilege('authenticated','private.shared_reference_rate_buckets','SELECT')
     OR has_function_privilege('authenticated','private.apply_shared_reference_policy_retention()','EXECUTE')
     OR NOT has_function_privilege('service_role','private.apply_shared_reference_policy_retention()','EXECUTE') THEN
    RAISE EXCEPTION 'policy storage or maintenance privileges are too broad';
  END IF;
END
$$;

ROLLBACK;
