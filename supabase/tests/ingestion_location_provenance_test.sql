-- LOCAL ONLY. Run inside BEGIN / ROLLBACK after including the candidate migration.
-- Uses real authenticated roles, not JWT claims under postgres alone;
-- anonymous EXECUTE denial is verified through effective ACL (see below).
CREATE FUNCTION pg_temp.reject_provenance_fixture() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id = -107001 AND NEW.location_source = 'image_exif' THEN
    RAISE EXCEPTION 'Injected second-write failure' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-0000000ca701';
  other_id uuid := '00000000-0000-4000-8000-0000000ca702';
  obs_id bigint := -107001;
  img_id bigint := -107002;
  r public.observations%ROWTYPE;
  method text;
  failure text;
  assignment text;
  public_result jsonb;
  before_time timestamptz;
  before_version bigint;
  before_image_time timestamptz;
  before_tuple text;
  n bigint;
BEGIN
  INSERT INTO auth.users (id,aud,role,email,raw_user_meta_data,created_at,updated_at)
    VALUES (owner_id,'authenticated','authenticated','provenance-owner@example.test','{}',now(),now()),
           (other_id,'authenticated','authenticated','provenance-other@example.test','{}',now(),now());
  INSERT INTO public.profiles (id,display_name,is_banned)
    VALUES (owner_id,'Provenance Owner',false),(other_id,'Provenance Other',false)
    ON CONFLICT(id) DO UPDATE SET is_banned=false;
  INSERT INTO public.observations
    (id,user_id,date,genus,species,visibility,is_draft,spore_data_visibility,location_precision)
    OVERRIDING SYSTEM VALUE
    VALUES (obs_id,owner_id,'2026-10-12','Provenancetestus','fixture','public',false,'public','exact');
  INSERT INTO public.observation_images
    (id,observation_id,user_id,image_type,storage_path,sort_order)
    OVERRIDING SYSTEM VALUE
    VALUES (img_id,obs_id,owner_id,'field',owner_id::text || '/' || obs_id || '/test.webp',0);
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.location_source IS NOT NULL OR r.location_status IS NOT NULL
     OR (SELECT ingest_method IS NOT NULL FROM public.observation_images WHERE id=img_id) THEN
    RAISE EXCEPTION 'Legacy inserts must retain NULL provenance';
  END IF;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  FOREACH method IN ARRAY ARRAY['sporely_camera','system_camera','web_camera','native_picker','web_file_picker','unknown'] LOOP
    UPDATE public.observation_images SET ingest_method=method WHERE id=img_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Owner image update was filtered'; END IF;
  END LOOP;
  BEGIN
    UPDATE public.observation_images SET ingest_method='invented' WHERE id=img_id;
    RAISE EXCEPTION 'Invalid ingestion enum accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  FOREACH failure IN ARRAY ARRAY['disabled','denied','timeout','unavailable','skipped','unknown'] LOOP
    PERFORM public.set_observation_location(obs_id,NULL,NULL,NULL,NULL,'none',failure);
    SELECT * INTO r FROM public.observations WHERE id=obs_id;
    IF r.location_status IS DISTINCT FROM failure THEN RAISE EXCEPTION 'Absent location outcome lost: %',failure; END IF;
    UPDATE public.observations SET notes='continue without coordinates' WHERE id=obs_id;
    SELECT * INTO r FROM public.observations WHERE id=obs_id;
    IF r.location_status IS DISTINCT FROM failure THEN RAISE EXCEPTION 'Unrelated continuation overwrote %',failure; END IF;
  END LOOP;

  FOREACH method IN ARRAY ARRAY['device_gps','image_exif','manual','unknown'] LOOP
    PERFORM public.set_observation_location(obs_id,52,6,70,4,method,'acquired');
    SELECT * INTO r FROM public.observations WHERE id=obs_id;
    IF r.location_source IS DISTINCT FROM method OR r.location_status <> 'acquired' THEN
      RAISE EXCEPTION 'Aware attribution lost';
    END IF;
  END LOOP;

  -- Existing trigger cascades must not rewrite image media on location-only edits.
  SELECT updated_at,media_version INTO before_time,before_version FROM public.observations WHERE id=obs_id;
  SELECT ctid::text INTO before_tuple FROM public.observations WHERE id=obs_id;
  SELECT updated_at INTO before_image_time FROM public.observation_images WHERE id=img_id;
  PERFORM public.set_observation_location(obs_id,52,6,70,4,'unknown','acquired');
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.updated_at IS DISTINCT FROM before_time OR r.media_version IS DISTINCT FROM before_version
     OR (SELECT ctid::text IS DISTINCT FROM before_tuple FROM public.observations WHERE id=obs_id) THEN
    RAISE EXCEPTION 'Identical aware retry performed a write';
  END IF;
  PERFORM public.set_observation_location(obs_id,53,7,71,5,'unknown','acquired');
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.gps_latitude <> 53 OR r.location_source <> 'unknown' OR r.location_status <> 'acquired' THEN
    RAISE EXCEPTION 'Changed coordinates with identical enum pair lost attribution';
  END IF;
  IF r.media_version IS DISTINCT FROM before_version
     OR (SELECT updated_at IS DISTINCT FROM before_image_time FROM public.observation_images WHERE id=img_id) THEN
    RAISE EXCEPTION 'Location-only RPC changed media versions or child cursor';
  END IF;

  UPDATE public.observations SET notes='unrelated',gps_latitude=53,gps_longitude=7,gps_altitude=71,gps_accuracy=5 WHERE id=obs_id;
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.location_source <> 'unknown' OR r.location_status <> 'acquired' THEN RAISE EXCEPTION 'Unchanged resend invalidated attribution'; END IF;

  FOREACH assignment IN ARRAY ARRAY[
    'gps_latitude=54','gps_longitude=8','gps_altitude=72','gps_accuracy=6',
    'gps_latitude=NULL','gps_longitude=NULL','gps_altitude=NULL','gps_accuracy=NULL',
    'gps_latitude=NULL,gps_longitude=NULL,gps_altitude=NULL,gps_accuracy=NULL',
    'gps_latitude=54,location_source=''device_gps'',location_status=''acquired''',
    'gps_latitude=54,location_source=''manual'''
  ] LOOP
    PERFORM public.set_observation_location(obs_id,53,7,71,5,'device_gps','acquired');
    EXECUTE format('UPDATE public.observations SET %s WHERE id=$1',assignment) USING obs_id;
    SELECT * INTO r FROM public.observations WHERE id=obs_id;
    IF r.location_source IS NOT NULL OR r.location_status IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy change retained stale provenance: %',assignment;
    END IF;
  END LOOP;

  -- NULL -> non-NULL changes also invalidate.
  PERFORM public.set_observation_location(obs_id,NULL,NULL,NULL,NULL,'none','denied');
  UPDATE public.observations SET gps_latitude=53,gps_longitude=7 WHERE id=obs_id;
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.location_source IS NOT NULL OR r.location_status IS NOT NULL THEN RAISE EXCEPTION 'NULL to fix retained denied'; END IF;

  PERFORM public.set_observation_location(obs_id,53,7,71,5,'manual','acquired');
  BEGIN
    UPDATE public.observations SET location_status=NULL WHERE id=obs_id;
    RAISE EXCEPTION 'Partial provenance accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.observations SET location_source='invented' WHERE id=obs_id;
    RAISE EXCEPTION 'Invalid source accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.observations SET location_status='denied' WHERE id=obs_id;
    RAISE EXCEPTION 'Failure attached to valid coordinates';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.set_observation_location(obs_id,NULL,NULL,NULL,NULL,'manual','acquired');
    RAISE EXCEPTION 'Invalid aware pair accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.set_observation_location(obs_id,53,7,71,5,NULL,'acquired');
    RAISE EXCEPTION 'Missing aware provenance accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.set_observation_location(obs_id,91,7,71,5,'manual','acquired');
    RAISE EXCEPTION 'Out of range latitude accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.gps_latitude<>53 OR r.location_source<>'manual' OR r.location_status<>'acquired' THEN
    RAISE EXCEPTION 'Rejected RPC changed existing state';
  END IF;
  PERFORM public.set_observation_location(obs_id,NULL,NULL,NULL,NULL,'none','skipped');

  EXECUTE 'RESET ROLE';
  EXECUTE 'CREATE TRIGGER provenance_fixture_failure BEFORE UPDATE ON public.observations FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_provenance_fixture()';
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.set_observation_location(obs_id,54,8,72,6,'image_exif','acquired');
    RAISE EXCEPTION 'Injected second-write failure did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT * INTO r FROM public.observations WHERE id=obs_id;
  IF r.gps_latitude IS NOT NULL OR r.gps_longitude IS NOT NULL
     OR r.location_source <> 'none' OR r.location_status <> 'skipped' THEN
    RAISE EXCEPTION 'Second-write failure did not roll back coordinate write';
  END IF;
  EXECUTE 'RESET ROLE';
  EXECUTE 'DROP TRIGGER provenance_fixture_failure ON public.observations';
  -- Do not let schema expansion leak through any existing public view or RPC signature.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('v','m')
      AND a.attname IN ('ingest_method','location_source','location_status') AND NOT a.attisdropped
  ) THEN RAISE EXCEPTION 'Provenance exposed in public view'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND (p.proname LIKE 'get_public_%' OR p.proname LIKE 'search_public_%')
      AND (pg_catalog.pg_get_function_result(p.oid) ~ '(location_source|location_status|ingest_method)'
        OR p.prosrc ~ '(location_source|location_status|ingest_method)')
  ) THEN RAISE EXCEPTION 'Provenance exposed by public RPC definition'; END IF;

  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',other_id,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',other_id::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.observations WHERE id=obs_id;
  IF n<>0 THEN RAISE EXCEPTION 'Non-owner can read base observation'; END IF;
  SELECT count(*) INTO n FROM public.observation_images WHERE id=img_id;
  IF n<>0 THEN RAISE EXCEPTION 'Non-owner can read base image'; END IF;
  BEGIN
    PERFORM public.set_observation_location(obs_id,53,7,71,5,'manual','acquired');
    RAISE EXCEPTION 'Non-owner RPC write accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.set_observation_location(-999999,53,7,71,5,'manual','acquired');
    RAISE EXCEPTION 'Missing observation accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT to_jsonb(v) INTO public_result FROM public.observations_community_view v WHERE id=obs_id;
  IF public_result IS NULL OR public_result ?| ARRAY['location_source','location_status'] THEN
    RAISE EXCEPTION 'Community observation projection absent or leaks';
  END IF;
  SELECT to_jsonb(v) INTO public_result FROM public.observation_images_community_view v WHERE id=img_id;
  IF public_result IS NULL OR public_result ? 'ingest_method' THEN
    RAISE EXCEPTION 'Community image projection absent or leaks';
  END IF;
  SELECT to_jsonb(v) INTO public_result FROM public.get_public_observation(obs_id) v;
  IF public_result IS NULL OR public_result::text ~ '"(location_source|location_status|ingest_method)"' THEN
    RAISE EXCEPTION 'Public observation RPC absent or leaks';
  END IF;

  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'PASS: provenance enums, compatibility, legacy invalidation, aware updates/retries, privacy and owner RLS';
END;
$$;

-- Verify anonymous execution is denied through PostgreSQL's effective ACL.
-- The local 17.6 backend segfaults planning a denied function call in DO;
-- avoid repeatedly exercising that engine failure. No grants are weakened.
DO $$
BEGIN
  IF has_function_privilege('anon',
    'public.set_observation_location(bigint,double precision,double precision,real,real,text,text)',
    'EXECUTE') THEN RAISE EXCEPTION 'Anon can execute location write RPC'; END IF;
END;
$$;
SELECT set_config('request.jwt.claims','{}',true), set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_observation_location(-107001,53,7,71,5,'manual','acquired');
    RAISE EXCEPTION 'Claimless authenticated RPC accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;
