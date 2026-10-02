-- Stage M of docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md
-- (20261002120000_reference_client_capability_minimum.sql):
--   A. legacy table reads (how every released desktop reads its feeds) omit
--      withheld rows: enhanced live sets, their successors, non-v1 uses and
--      uses of withheld sets; tombstones stay visible;
--   B. old-parser fixture: the rows a v0.9.22 / v0.9.24 desktop receives pass
--      its whole-feed staging and graph validation, and no withheld row is
--      presented as a deletion;
--   C. v1 data: the legacy table read equals the raw rows (no change);
--   D. list_reference_library_feed: undeclared/v1 vs [1,2], withheld_count,
--      pagination, argument validation;
--   E. non-capable writes touching withheld/enhanced content are refused
--      with requires_newer_client and change nothing; v1 writes still work;
--   F. creation guard incl. the 30-day window edges and the no-report case;
--   G. trust boundary: predicates answer only for the caller, device table
--      owner-only, grants, one function per name.
-- Every transaction is rolled back. To see which blocks fail on other
-- definitions run with -v ON_ERROR_STOP=0 -v ON_ERROR_ROLLBACK=on.

BEGIN;

CREATE FUNCTION pg_temp.claims(p_sub uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_sub IS NULL THEN '' ELSE json_build_object('sub',p_sub::text,'role','authenticated')::text END, true)
$$;

-- The exact v0.9.22 owner feed column lists (utils/cloud_sync.py) are
-- inlined below. No helper defined here is ever called while the role is
-- authenticated: on the local stack (pgaudit/plpgsql_check preloaded) calling
-- a function created in the session as authenticated crashes the backend
-- (signal 11), so results are captured under the role and checked after
-- RESET ROLE.
CREATE FUNCTION pg_temp.ids(p_rows jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(right(e->>'id',2), ',' ORDER BY right(e->>'id',2)), '')
    FROM jsonb_array_elements(p_rows) e
$$;

-- Fixture ------------------------------------------------------------------------
-- Sets (suffix): 01 v1 live; 02 enhanced live; 03 v1 successor of 02;
-- 04 enhanced tombstone; 05 v1 live. Uses (suffix): 11 on 01 (v1),
-- 12 on 02 (v2 snapshot), 15 on 05 (v1).
DO $$
DECLARE
  o constant uuid := '00000000-0000-4000-8000-0000000b3001';
  x constant uuid := '00000000-0000-4000-8000-0000000b3002';
  t constant integer := 2100000982;
  w constant uuid := '71000000-0000-4000-8000-0000000b3001';
  tr constant uuid := '72000000-0000-4000-8000-0000000b3001';
  qav jsonb := '{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}';
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (o,'authenticated','authenticated','stage-m@example.invalid','{}',now(),now()),
    (x,'authenticated','authenticated','stage-m-x@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (o,'stage_m_owner',false),(x,'stage_m_other',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (t,'Inocybe capabilis','species','include','in_cache','stage-m-test');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES
    (982000001,o,current_date,'private',false,'private',t),
    (982000002,o,current_date,'private',false,'private',t),
    (982000005,o,current_date,'private',false,'private',t),
    (982000006,o,current_date,'private',false,'private',t);
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (o,w,'article','[{"family":"Cap"}]','Capabilities',2026,'Cap 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (o,tr,w,'q','Inocybe capabilis',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,raw_text,length_core_min,length_core_max,
    measurement_details_json,supersedes_id,revision,deleted_at
  ) VALUES
    (o,'73000000-0000-4000-8000-0000000b3001',tr,'spore_size','range','8-10 um',8,10,NULL,NULL,1,NULL),
    (o,'73000000-0000-4000-8000-0000000b3002',tr,'spore_size','range','Sp. 7-9.5 um, Qav = 1.6-2',7,9.5,qav,NULL,1,NULL),
    (o,'73000000-0000-4000-8000-0000000b3004',tr,'spore_size','range','9-12 um',9,12,qav,NULL,1,now()),
    (o,'73000000-0000-4000-8000-0000000b3005',tr,'spore_size','range','10-12 um',10,12,NULL,NULL,1,NULL);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,raw_text,length_core_min,length_core_max,supersedes_id,revision
  ) VALUES (o,'73000000-0000-4000-8000-0000000b3003',tr,'spore_size','range','7-9 um',7,9,'73000000-0000-4000-8000-0000000b3002',1);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  SELECT o,('74000000-0000-4000-8000-0000000b30'||s)::uuid,982000000+n,('73000000-0000-4000-8000-0000000b300'||n)::uuid,
         'compared',1,private.reference_canonical_snapshot(o,('73000000-0000-4000-8000-0000000b300'||n)::uuid)
    FROM (VALUES (1,'11'),(2,'12'),(5,'15')) v(n,s);
  IF (SELECT snapshot_json->>'schema_version' FROM public.observation_reference_uses
       WHERE id='74000000-0000-4000-8000-0000000b3012') <> '2' THEN
    RAISE EXCEPTION 'fixture: use 12 must carry a version-2 snapshot (is 20260914090000 applied locally?)';
  END IF;
END
$$;

-- A. Legacy table reads omit withheld rows ---------------------------------------
DO $$
DECLARE v_sets text; v_uses text; j_sets jsonb; j_uses jsonb;
BEGIN
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000b3001');
  SET LOCAL ROLE authenticated;
  SELECT coalesce(jsonb_agg(q.r),'[]') INTO j_sets FROM (SELECT to_jsonb(x) AS r FROM (
    SELECT user_id,id,taxon_treatment_id,character,raw_text,data_kind,length_min,length_core_min,length_core_max,
           length_max,width_min,width_core_min,width_core_max,width_max,q_min,q_max,q_mean,length_mean,width_mean,
           sample_size,specimen_count,mount_medium,stain,preparation,measurement_method,notes,raw_points_json,
           supersedes_id,revision,row_version,created_at,updated_at,deleted_at
      FROM public.reference_measurement_sets ORDER BY updated_at,id) x) q;
  SELECT coalesce(jsonb_agg(q.r),'[]') INTO j_uses FROM (SELECT to_jsonb(x) AS r FROM (
    SELECT user_id,id,observation_id,reference_measurement_set_id,role,note,selected_at,reference_revision,
           snapshot_json,row_version,created_at,updated_at,deleted_at
      FROM public.observation_reference_uses ORDER BY updated_at,id) x) q;
  RESET ROLE;
  v_sets := pg_temp.ids(j_sets); v_uses := pg_temp.ids(j_uses);
  IF v_sets <> '01,04,05' THEN RAISE EXCEPTION 'A: legacy set feed is %, expected 01,04,05', v_sets; END IF;
  IF v_uses <> '11,15' THEN RAISE EXCEPTION 'A: legacy use feed is %, expected 11,15', v_uses; END IF;
END
$$;

-- B. Old-parser fixture (v0.9.22 stage_reference_library_feed / _validate_graph /
-- stage_observation_reference_use_feed; v0.9.24 identical except it accepts
-- snapshot version 2): the received feed is accepted as a whole, and no
-- withheld row arrives as a tombstone.
DO $$
DECLARE v_sets jsonb; v_uses jsonb; v_treatments jsonb; e jsonb;
BEGIN
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000b3001');
  SET LOCAL ROLE authenticated;
  SELECT coalesce(jsonb_agg(q.r),'[]') INTO v_sets FROM (SELECT to_jsonb(x) AS r FROM (
    SELECT user_id,id,taxon_treatment_id,character,raw_text,data_kind,length_min,length_core_min,length_core_max,
           length_max,width_min,width_core_min,width_core_max,width_max,q_min,q_max,q_mean,length_mean,width_mean,
           sample_size,specimen_count,mount_medium,stain,preparation,measurement_method,notes,raw_points_json,
           supersedes_id,revision,row_version,created_at,updated_at,deleted_at
      FROM public.reference_measurement_sets ORDER BY updated_at,id) x) q;
  SELECT coalesce(jsonb_agg(q.r),'[]') INTO v_uses FROM (SELECT to_jsonb(x) AS r FROM (
    SELECT user_id,id,observation_id,reference_measurement_set_id,role,note,selected_at,reference_revision,
           snapshot_json,row_version,created_at,updated_at,deleted_at
      FROM public.observation_reference_uses ORDER BY updated_at,id) x) q;
  SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') INTO v_treatments FROM public.reference_taxon_treatments t WHERE user_id=auth.uid();
  RESET ROLE;
  FOR e IN SELECT * FROM jsonb_array_elements(v_sets) LOOP
    IF e->>'id' IS NULL OR e->>'row_version' IS NULL OR e->>'updated_at' IS NULL OR e->>'created_at' IS NULL
       OR e->>'character' IS NULL OR e->>'data_kind' IS NULL THEN
      RAISE EXCEPTION 'B: set % is missing canonical fields (whole feed would fail)', e->>'id'; END IF;
    IF e->>'deleted_at' IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_treatments) t
        WHERE t->>'id'=e->>'taxon_treatment_id' AND t->>'deleted_at' IS NULL) THEN
      RAISE EXCEPTION 'B: live set % has no live treatment', e->>'id'; END IF;
    IF e->>'supersedes_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sets) p
        WHERE p->>'id'=e->>'supersedes_id') THEN
      RAISE EXCEPTION 'B: set % has an invalid predecessor (whole feed would fail)', e->>'id'; END IF;
  END LOOP;
  FOR e IN SELECT * FROM jsonb_array_elements(v_uses) LOOP
    IF e->'snapshot_json'->>'schema_version' <> '1' THEN
      RAISE EXCEPTION 'B: use % has snapshot version % (v0.9.22 rejects the whole use feed)', e->>'id', e->'snapshot_json'->>'schema_version'; END IF;
    IF e->'snapshot_json'->>'reference_measurement_set_id' <> e->>'reference_measurement_set_id' THEN
      RAISE EXCEPTION 'B: use % snapshot identity disagrees', e->>'id'; END IF;
    IF e->>'deleted_at' IS NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_sets) s
        WHERE s->>'id'=e->>'reference_measurement_set_id' AND s->>'deleted_at' IS NULL) THEN
      RAISE EXCEPTION 'B: live use % depends on an absent set (blocked forever)', e->>'id'; END IF;
  END LOOP;
  -- Withheld rows are absent, never delivered as tombstones (old reconcile
  -- deletes only rows carrying deleted_at), and the server rows are live.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_sets) s WHERE right(s->>'id',2) IN ('02','03'))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_uses) u WHERE right(u->>'id',2)='12') THEN
    RAISE EXCEPTION 'B: a withheld row was delivered'; END IF;
  IF (SELECT count(*) FROM public.reference_measurement_sets WHERE right(id::text,2) IN ('02','03')
        AND user_id='00000000-0000-4000-8000-0000000b3001' AND deleted_at IS NULL) <> 2 THEN
    RAISE EXCEPTION 'B: withheld sets must stay live'; END IF;
END
$$;

-- C. v1 data unchanged: for an owner with only v1 rows the legacy read equals
-- the raw rows exactly.
DO $$
DECLARE v_raw jsonb; v_rls jsonb;
BEGIN
  UPDATE public.reference_measurement_sets SET deleted_at=now() WHERE id='73000000-0000-4000-8000-0000000b3003';
  UPDATE public.observation_reference_uses SET deleted_at=now() WHERE id='74000000-0000-4000-8000-0000000b3012';
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000b3001');
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO v_raw FROM public.reference_measurement_sets m
   WHERE user_id='00000000-0000-4000-8000-0000000b3001' AND id IN ('73000000-0000-4000-8000-0000000b3001','73000000-0000-4000-8000-0000000b3005','73000000-0000-4000-8000-0000000b3004');
  SET LOCAL ROLE authenticated;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO v_rls FROM public.reference_measurement_sets m;
  RESET ROLE;
  IF v_raw IS DISTINCT FROM v_rls THEN RAISE EXCEPTION 'C: v1 rows differ under the legacy read'; END IF;
  SELECT jsonb_agg(to_jsonb(u) ORDER BY id) INTO v_raw FROM public.observation_reference_uses u
   WHERE user_id='00000000-0000-4000-8000-0000000b3001' AND id IN ('74000000-0000-4000-8000-0000000b3011','74000000-0000-4000-8000-0000000b3015');
  SET LOCAL ROLE authenticated;
  SELECT jsonb_agg(to_jsonb(u) ORDER BY id) INTO v_rls FROM public.observation_reference_uses u WHERE snapshot_json->>'schema_version'='1';
  RESET ROLE;
  IF v_raw IS DISTINCT FROM v_rls THEN RAISE EXCEPTION 'C: v1 uses differ under the legacy read'; END IF;
  RAISE EXCEPTION 'C ok (rolled back by savepoint)' USING ERRCODE='P0099';
EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
END
$$;

-- D. Capability-aware feed --------------------------------------------------------
DO $$
DECLARE r jsonb[] := '{}'; p1 jsonb; p2 jsonb; e text[] := '{}';
BEGIN
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000b3001');
  SET LOCAL ROLE authenticated;
  r := r || public.list_reference_library_feed('measurement_set');
  r := r || public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[1]}');
  r := r || public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[1,2]}');
  r := r || public.list_reference_library_feed('observation_use');
  r := r || public.list_reference_library_feed('observation_use','{"reference_snapshot_versions":[1,2]}');
  p1 := public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[1,2]}',NULL,NULL,3);
  p2 := public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[1,2]}',
          (p1->'next_cursor'->>'updated_at')::timestamptz,(p1->'next_cursor'->>'id')::uuid,3);
  BEGIN PERFORM public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[2]}');
    e := e || 'accepted [2]'::text; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[1,3]}');
    e := e || 'accepted [1,3]'::text; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.list_reference_library_feed('measurement_set','[1,2]');
    e := e || 'accepted non-object'::text; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.list_reference_library_feed('work');
    e := e || 'accepted entity work'::text; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  RESET ROLE;
  IF cardinality(e) > 0 THEN RAISE EXCEPTION 'D: validation %', e; END IF;
  IF pg_temp.ids(r[1]->'rows') <> '01,04,05' OR (r[1]->>'withheld_count')::int <> 2 OR r[1]->'next_cursor' <> 'null'::jsonb
     OR r[1]->>'status' <> 'ok' THEN RAISE EXCEPTION 'D: undeclared set feed %', r[1]; END IF;
  IF pg_temp.ids(r[2]->'rows') <> '01,04,05' OR (r[2]->>'withheld_count')::int <> 2 THEN RAISE EXCEPTION 'D: [1] set feed %', r[2]; END IF;
  IF pg_temp.ids(r[3]->'rows') <> '01,02,03,04,05' OR (r[3]->>'withheld_count')::int <> 0 THEN RAISE EXCEPTION 'D: [1,2] set feed %', r[3]; END IF;
  IF NOT ((r[3]->'rows'->0) ? 'measurement_details_json') THEN RAISE EXCEPTION 'D: rows must be full rows'; END IF;
  IF pg_temp.ids(r[4]->'rows') <> '11,15' OR (r[4]->>'withheld_count')::int <> 1 THEN RAISE EXCEPTION 'D: undeclared use feed %', r[4]; END IF;
  IF pg_temp.ids(r[5]->'rows') <> '11,12,15' OR (r[5]->>'withheld_count')::int <> 0 THEN RAISE EXCEPTION 'D: [1,2] use feed %', r[5]; END IF;
  IF jsonb_array_length(p1->'rows') <> 3 OR jsonb_array_length(p2->'rows') <> 2 OR p2->'next_cursor' <> 'null'::jsonb
     OR pg_temp.ids((p1->'rows') || (p2->'rows')) <> '01,02,03,04,05' THEN
    RAISE EXCEPTION 'D: pagination % / %', p1, p2; END IF;
  -- another account sees nothing of the owner's rows
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000b3002');
  SET LOCAL ROLE authenticated;
  p1 := public.list_reference_library_feed('measurement_set','{"reference_snapshot_versions":[1,2]}');
  RESET ROLE;
  IF jsonb_array_length(p1->'rows') <> 0 OR (p1->>'withheld_count')::int <> 0 THEN RAISE EXCEPTION 'D: cross-account %', p1; END IF;
END
$$;

-- E. Non-capable writes are refused, never downgraded ------------------------------
DO $$
DECLARE r jsonb; v_before jsonb; v_after jsonb;
  o constant uuid := '00000000-0000-4000-8000-0000000b3001';
  tr constant text := '72000000-0000-4000-8000-0000000b3001';
BEGIN
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO v_before FROM public.reference_measurement_sets m WHERE user_id=o;
  PERFORM pg_temp.claims(o);
  SET LOCAL ROLE authenticated;
  -- legacy-shaped edit of the enhanced set (v0.9.22 payload, no extension keys)
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3002',
         'taxon_treatment_id',tr,'raw_text','edited','revision',2),1);
  IF r->>'status' <> 'requires_newer_client' OR r->'row' <> 'null'::jsonb OR (SELECT array_agg(k) FROM jsonb_object_keys(r) k) <> ARRAY['row','status'] THEN
    RAISE EXCEPTION 'E1: legacy edit of enhanced set: %', r; END IF;
  -- v0.9.24-shaped edit (extension keys present as null: would downgrade)
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3002',
         'taxon_treatment_id',tr,'raw_text','edited','revision',2,'measurement_details_json',NULL,'q_core_min',NULL,'q_core_max',NULL),1);
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E2: downgrade edit: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3002',
         'taxon_treatment_id',tr,'deleted',true),1, '{"reference_snapshot_versions":[1]}');
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E3: delete of enhanced set: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3003',
         'taxon_treatment_id',tr,'raw_text','edited','revision',2),1);
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E4: edit of withheld successor: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3009',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','x','revision',1,
         'supersedes_id','73000000-0000-4000-8000-0000000b3002'),0);
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E5: successor of enhanced set: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3008',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','x','revision',1,
         'measurement_details_json','{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}'::jsonb,
         'q_core_min',NULL,'q_core_max',NULL),0);
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E6: v1 client creating enhanced: %', r; END IF;
  r := public.sync_observation_reference_use(jsonb_build_object('id','74000000-0000-4000-8000-0000000b3012',
         'observation_id',982000002,'reference_measurement_set_id','73000000-0000-4000-8000-0000000b3002',
         'role','compared','note','n','reference_revision',1),1);
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E7: edit of v2 use: %', r; END IF;
  r := public.sync_observation_reference_use(jsonb_build_object('id','74000000-0000-4000-8000-0000000b3019',
         'observation_id',982000006,'reference_measurement_set_id','73000000-0000-4000-8000-0000000b3002',
         'role','compared','reference_revision',1),0);
  IF r->>'status' <> 'requires_newer_client' THEN RAISE EXCEPTION 'E8: new use of enhanced set: %', r; END IF;
  -- ordinary v1 work still goes through (both payload shapes)
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3001',
         'taxon_treatment_id',tr,'raw_text','8-10.5 um','revision',2),1);
  IF r->>'status' <> 'updated' THEN RAISE EXCEPTION 'E9: v1 edit: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3005',
         'taxon_treatment_id',tr,'raw_text','10-12.5 um','revision',2,'measurement_details_json',NULL,'q_core_min',NULL,'q_core_max',NULL),1);
  IF r->>'status' <> 'updated' THEN RAISE EXCEPTION 'E10: v0.9.24 v1 edit: %', r; END IF;
  RESET ROLE;
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO v_after FROM public.reference_measurement_sets m
   WHERE user_id=o AND right(id::text,2) IN ('02','03','04');
  IF v_after IS DISTINCT FROM (SELECT jsonb_agg(e ORDER BY e->>'id') FROM jsonb_array_elements(v_before) e
                                WHERE right(e->>'id',2) IN ('02','03','04')) THEN
    RAISE EXCEPTION 'E: a refused write changed rows'; END IF;
  IF EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE right(id::text,2) IN ('08','09') AND user_id=o) THEN
    RAISE EXCEPTION 'E: a refused create wrote a row'; END IF;
END
$$;

-- F. Creation guard ---------------------------------------------------------------
DO $$
DECLARE r jsonb;
  o constant uuid := '00000000-0000-4000-8000-0000000b3001';
  tr constant text := '72000000-0000-4000-8000-0000000b3001';
  cap constant jsonb := '{"reference_snapshot_versions":[1,2],"device_id":"5e000000-0000-4000-8000-0000000b3001","client":"desktop_app","app_version":"0.9.30"}';
  qav constant jsonb := '{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}';
BEGIN
  DELETE FROM public.reference_client_devices WHERE user_id=o;
  PERFORM pg_temp.claims(o);
  -- F1 no device has reported: usable (capable creation allowed)
  SET LOCAL ROLE authenticated;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3021',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','Qav 1.6-2','revision',1,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),0,cap);
  RESET ROLE;
  IF r->>'status' <> 'created' THEN RAISE EXCEPTION 'F1: no reports yet: %', r; END IF;
  IF (SELECT reference_snapshot_versions FROM public.reference_client_devices
       WHERE user_id=o AND device_id='5e000000-0000-4000-8000-0000000b3001') <> ARRAY[1,2] THEN
    RAISE EXCEPTION 'F1: caller device not recorded'; END IF;
  -- F2 an undeclared (legacy) write records the legacy pseudo-device ...
  SET LOCAL ROLE authenticated;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3001',
         'taxon_treatment_id',tr,'raw_text','8-11 um','revision',3),1);
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.reference_client_devices WHERE user_id=o
                  AND device_id='00000000-0000-0000-0000-000000000000' AND reference_snapshot_versions=ARRAY[1]) THEN
    RAISE EXCEPTION 'F2: legacy writer not recorded'; END IF;
  -- ... which blocks new enhanced content, also via a use
  SET LOCAL ROLE authenticated;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3022',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','Qav 1.6-2','revision',1,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),0,cap);
  IF r->>'status' <> 'older_client_active' THEN RESET ROLE; RAISE EXCEPTION 'F2: guard on create: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3005',
         'taxon_treatment_id',tr,'raw_text','10-12 um','revision',2,'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),1,cap);
  IF r->>'status' <> 'older_client_active' THEN RESET ROLE; RAISE EXCEPTION 'F2: guard on upgrade: %', r; END IF;
  r := public.sync_observation_reference_use(jsonb_build_object('id','74000000-0000-4000-8000-0000000b3026',
         'observation_id',982000006,'reference_measurement_set_id','73000000-0000-4000-8000-0000000b3002',
         'role','compared','reference_revision',1),0,'current',cap);
  IF r->>'status' <> 'older_client_active' THEN RESET ROLE; RAISE EXCEPTION 'F2: guard on use: %', r; END IF;
  -- editing already-enhanced content is not new content: allowed
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3002',
         'taxon_treatment_id',tr,'raw_text','Sp. 7-9.5 um, Qav = 1.6-2.0','revision',2,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),1,cap);
  RESET ROLE;
  IF r->>'status' <> 'updated' THEN RAISE EXCEPTION 'F2: capable edit of enhanced set: %', r; END IF;
  -- F3 window edges: inside (30 days minus a minute) blocks, outside (30 days
  -- plus a second) does not.
  UPDATE public.reference_client_devices SET last_seen_at=clock_timestamp()-interval '30 days'+interval '1 minute'
   WHERE user_id=o AND device_id='00000000-0000-0000-0000-000000000000';
  SET LOCAL ROLE authenticated;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3022',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','Qav 1.6-2','revision',1,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),0,cap);
  RESET ROLE;
  IF r->>'status' <> 'older_client_active' THEN RAISE EXCEPTION 'F3: inside window: %', r; END IF;
  UPDATE public.reference_client_devices SET last_seen_at=clock_timestamp()-interval '30 days'-interval '1 second'
   WHERE user_id=o AND device_id='00000000-0000-0000-0000-000000000000';
  SET LOCAL ROLE authenticated;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3022',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','Qav 1.6-2','revision',1,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),0,cap);
  RESET ROLE;
  IF r->>'status' <> 'created' THEN RAISE EXCEPTION 'F3: outside window: %', r; END IF;
  -- F4 a declared v1-only device blocks; once it reports [1,2] it does not;
  -- the caller's own device never blocks itself.
  SET LOCAL ROLE authenticated;
  r := public.record_reference_client_capabilities('{"reference_snapshot_versions":[1],"device_id":"5e000000-0000-4000-8000-0000000b3002","client":"web_browser"}');
  IF r->>'status' <> 'recorded' THEN RESET ROLE; RAISE EXCEPTION 'F4: record: %', r; END IF;
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3023',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','Qav 1.6-2','revision',1,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),0,cap);
  IF r->>'status' <> 'older_client_active' THEN RESET ROLE; RAISE EXCEPTION 'F4: v1 device: %', r; END IF;
  PERFORM public.record_reference_client_capabilities('{"reference_snapshot_versions":[1,2],"device_id":"5e000000-0000-4000-8000-0000000b3002"}');
  r := public.sync_reference_measurement_set(jsonb_build_object('id','73000000-0000-4000-8000-0000000b3023',
         'taxon_treatment_id',tr,'character','spore_size','data_kind','range','raw_text','Qav 1.6-2','revision',1,
         'measurement_details_json',qav,'q_core_min',NULL,'q_core_max',NULL),0,
         '{"reference_snapshot_versions":[1,2],"device_id":"5e000000-0000-4000-8000-0000000b3002"}');
  RESET ROLE;
  IF r->>'status' <> 'created' THEN RAISE EXCEPTION 'F4: upgraded device: %', r; END IF;
END
$$;

-- G. Trust boundary and signatures -------------------------------------------------
DO $$
DECLARE v boolean; n integer;
BEGIN
  -- another account learns nothing about the owner's rows through the predicates
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000b3002');
  SET LOCAL ROLE authenticated;
  v := public.reference_set_withheld_from_v1_readers('00000000-0000-4000-8000-0000000b3001','73000000-0000-4000-8000-0000000b3002');
  IF v THEN RESET ROLE; RAISE EXCEPTION 'G: predicate answers for another account'; END IF;
  v := public.reference_use_withheld_from_v1_readers('00000000-0000-4000-8000-0000000b3001','73000000-0000-4000-8000-0000000b3002','{"schema_version":2}');
  IF v THEN RESET ROLE; RAISE EXCEPTION 'G: use predicate answers for another account'; END IF;
  SELECT count(*) INTO n FROM public.reference_client_devices;
  IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'G: device rows of another account visible'; END IF;
  BEGIN
    INSERT INTO public.reference_client_devices(user_id,device_id,reference_snapshot_versions)
    VALUES ('00000000-0000-4000-8000-0000000b3002',gen_random_uuid(),ARRAY[1,2]);
    RESET ROLE; RAISE EXCEPTION 'G: direct device insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  IF has_function_privilege('anon','public.list_reference_library_feed(text,jsonb,timestamptz,uuid,integer)','EXECUTE')
     OR has_function_privilege('anon','public.sync_reference_measurement_set(jsonb,bigint,jsonb)','EXECUTE')
     OR has_function_privilege('anon','public.reference_set_withheld_from_v1_readers(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon','public.record_reference_client_capabilities(jsonb)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.sync_observation_reference_use(jsonb,bigint,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'G: grants'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
        AND proname IN ('sync_reference_measurement_set','sync_observation_reference_use')) <> 2
     OR NOT (SELECT bool_and(prosecdef AND proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(proowner)='postgres')
               FROM pg_proc WHERE pronamespace='public'::regnamespace
                AND proname IN ('sync_reference_measurement_set','sync_observation_reference_use','list_reference_library_feed',
                                'record_reference_client_capabilities','reference_set_withheld_from_v1_readers',
                                'reference_use_withheld_from_v1_readers')) THEN
    RAISE EXCEPTION 'G: one function per name, SECURITY DEFINER, search_path, owner'; END IF;
END
$$;

ROLLBACK;
