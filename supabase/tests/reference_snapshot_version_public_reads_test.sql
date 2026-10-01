-- Stage A of docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md
-- (20261001213000_version_aware_public_reference_reads.sql):
--   A. the automatic share is bound to snapshot version 1: a version-2
--      candidate is not shared (new share, re-share of a withdrawn row, new
--      revision of an automatic row) and the core answers
--      snapshot_version_unsupported; triggers do not fail;
--   B. a consented grant of a version-2 set is unchanged (scope {1,2});
--   C. species-page reads: version 1 unchanged for every caller; version 2
--      projected to the exact version-1 shape and marked for a default
--      caller, returned as stored for a caller accepting 2; the projection
--      never moves a mean interval or the Q core pair into Q bounds, core or
--      mean;
--   D. observation reads: the same rules per item;
--   E. accepted-version argument validation;
--   F. Stage 1B records not_shareable:snapshot_version_unsupported.
-- Runs against a local database where the deferred 20260914090000 is
-- applied (supabase db reset), so the canonical snapshot emits version 2 for
-- an enhanced row. Every transaction is rolled back.
--
-- Each block is independent after the fixture; to show which blocks fail on
-- other definitions run with -v ON_ERROR_STOP=0 -v ON_ERROR_ROLLBACK=on.

BEGIN;

CREATE FUNCTION pg_temp.claims(p_sub uuid, p_role text) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_role IS NULL THEN ''
         ELSE json_build_object('sub',p_sub::text,'role',p_role)::text END, true)
$$;

CREATE FUNCTION pg_temp.state(p_set uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(c.status||':'||coalesce(c.share_basis,'-')||':'||c.current_revision, ','), 'none')
    FROM private.shared_reference_contributions c
   WHERE c.owner_id='00000000-0000-4000-8000-0000000a2001' AND c.source_measurement_set_id=p_set
$$;

CREATE FUNCTION pg_temp.cid(p_set uuid) RETURNS uuid
LANGUAGE sql AS $$
  SELECT c.id FROM private.shared_reference_contributions c
   WHERE c.owner_id='00000000-0000-4000-8000-0000000a2001' AND c.source_measurement_set_id=p_set
$$;

-- The exact version-1 key sets (reference_snapshot_valid, version 1).
CREATE FUNCTION pg_temp.v1_shape(p_snapshot jsonb) RETURNS boolean
LANGUAGE sql AS $$
  SELECT p_snapshot->'schema_version' = '1'::jsonb
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_snapshot) k)
         = (SELECT array_agg(k ORDER BY k) FROM unnest(ARRAY[
             'schema_version','reference_work_id','reference_treatment_id','reference_measurement_set_id',
             'reference_revision','short_label','full_citation','work_type','year','doi','isbn','taxon_id',
             'name_as_published','locator_text','page_from','page_to','character','data_kind','raw_text',
             'measurements','method','raw_points']) k)
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_snapshot->'measurements') k)
         = (SELECT array_agg(k ORDER BY k) FROM unnest(ARRAY[
             'length_min','length_core_min','length_core_max','length_max','width_min','width_core_min',
             'width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean',
             'sample_size','specimen_count']) k)
$$;

-- Fixture ------------------------------------------------------------------------
DO $$
DECLARE
  o constant uuid := '00000000-0000-4000-8000-0000000a2001';
  t constant integer := 2100000981;
  w constant uuid := '71000000-0000-4000-8000-0000000a2001';
  tr constant uuid := '72000000-0000-4000-8000-0000000a2001';
  -- Driving case: Sp. 7-9.5(-10.5) x 4-5.5 um, Qav = 1.6-2.
  qav jsonb := '{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}';
  pct jsonb := '{"schema_version":1,"metrics":{"length":{"outer_range":{"kind":"reported_extremes"},"core_range":{"kind":"percentile_interval","percentile_bounds":[5,95]},"sd":{"value":0.696}}}}';
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES (o,'authenticated','authenticated','stage-a@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (o,'stage_a_owner',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (t,'Inocybe qavensis','species','include','in_cache','stage-a-test');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES
    (981000001,o,current_date,'public',false,'public',t),
    (981000002,o,current_date,'public',false,'public',t),
    (981000003,o,current_date,'public',false,'public',t),
    (981000004,o,current_date,'public',false,'public',t),
    (981000005,o,current_date,'public',false,'public',t),
    (981000007,o,current_date,'public',false,'public',t);
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (o,w,'article','[{"family":"Qav"}]','Mean intervals',2026,'Qav 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (o,tr,w,'q','Inocybe qavensis',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,raw_text,
    length_min,length_core_min,length_core_max,length_max,width_core_min,width_core_max,
    q_min,q_max,q_mean,measurement_details_json,q_core_min,q_core_max,revision
  ) VALUES
    -- version 1 (legacy)
    (o,'73000000-0000-4000-8000-0000000a2001',tr,'spore_size','range','8-10 x 5-6 um',
     NULL,8,10,NULL,5,6,1.5,1.9,1.7,NULL,NULL,NULL,1),
    -- version 2, driving case
    (o,'73000000-0000-4000-8000-0000000a2002',tr,'spore_size','range','Sp. 7-9.5(-10.5) x 4-5.5 um, Qav = 1.6-2',
     NULL,7,9.5,10.5,4,5.5,NULL,NULL,NULL,qav,NULL,NULL,1),
    -- version 2, percentile core and Q core pair
    (o,'73000000-0000-4000-8000-0000000a2003',tr,'spore_size','range','(6.9) 8.0-15.2 (16.1)',
     6.9,8.0,15.2,16.1,NULL,NULL,1.17,2.79,NULL,pct,1.36,2.19,1),
    -- version 1 now, version 2 later (new revision of an automatic row)
    (o,'73000000-0000-4000-8000-0000000a2004',tr,'spore_size','range','9-11 um',
     NULL,9,11,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1),
    -- version 1 now, withdrawn, version 2 later (re-share)
    (o,'73000000-0000-4000-8000-0000000a2005',tr,'spore_size','range','10-12 um',
     NULL,10,12,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1),
    -- version 1 now, consented, version 2 later (consented revision 2)
    (o,'73000000-0000-4000-8000-0000000a2007',tr,'spore_size','range','11-13 um',
     NULL,11,13,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1);
  DELETE FROM private.reference_share_consent_texts;
  INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope)
  VALUES (1,'en','fixture consent text',encode(sha256(convert_to('fixture consent text','UTF8')),'hex'),true,
          '{"snapshot_schema_versions":[1,2],"data_kinds":["raw_points","free_text","measurement_details"]}');

  -- Owner session: every use insert refreshes (and so shares automatically).
  PERFORM pg_temp.claims(o,'authenticated');
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  SELECT o,gen_random_uuid(),981000000+n,('73000000-0000-4000-8000-0000000a200'||n)::uuid,'compared',1,
         private.reference_canonical_snapshot(o,('73000000-0000-4000-8000-0000000a200'||n)::uuid)
    FROM unnest(ARRAY[1,2,3,4,5,7]) n;
  PERFORM pg_temp.claims(NULL,NULL);
  IF private.reference_canonical_snapshot(o,'73000000-0000-4000-8000-0000000a2002')->>'schema_version' <> '2' THEN
    RAISE EXCEPTION 'fixture: the enhanced set must produce a version-2 snapshot (is 20260914090000 applied locally?)';
  END IF;
END
$$;

-- A1. The use-insert trigger shared v1 automatically and did not share v2.
DO $$
BEGIN
  IF pg_temp.state('73000000-0000-4000-8000-0000000a2001') <> 'shared:automatic:1' THEN
    RAISE EXCEPTION 'A1: version-1 set not shared automatically: %', pg_temp.state('73000000-0000-4000-8000-0000000a2001');
  END IF;
  IF pg_temp.state('73000000-0000-4000-8000-0000000a2002') <> 'none'
     OR pg_temp.state('73000000-0000-4000-8000-0000000a2003') <> 'none' THEN
    RAISE EXCEPTION 'A1: a version-2 set was shared automatically: % / %',
      pg_temp.state('73000000-0000-4000-8000-0000000a2002'), pg_temp.state('73000000-0000-4000-8000-0000000a2003');
  END IF;
END
$$;

-- A2. The core, called directly (deploy refresh, Share again), answers the
-- distinct status for a new version-2 share and writes nothing.
DO $$
DECLARE r jsonb;
BEGIN
  r := private.reference_contribution_share_core('refresh','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2002',2100000981);
  IF r IS DISTINCT FROM '{"status":"snapshot_version_unsupported","row":null}'::jsonb THEN
    RAISE EXCEPTION 'A2: new automatic v2 share answered %', r;
  END IF;
  IF pg_temp.state('73000000-0000-4000-8000-0000000a2002') <> 'none'
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events e
                  JOIN private.shared_reference_contributions c ON c.id=e.contribution_id
                 WHERE c.source_measurement_set_id='73000000-0000-4000-8000-0000000a2002') THEN
    RAISE EXCEPTION 'A2: the refused automatic share wrote a row or event';
  END IF;
END
$$;

-- A3. An automatic row whose source becomes version 2 gets no new revision:
-- the set trigger withdraws it (reason snapshot_version_unsupported, no
-- opt-out); the public reads serve nothing but the tombstone.
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000a2001','authenticated');
  UPDATE public.reference_measurement_sets
     SET measurement_details_json='{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}',
         revision=2
   WHERE id='73000000-0000-4000-8000-0000000a2004';
  PERFORM pg_temp.claims(NULL,NULL);
  r := private.reference_contribution_share_core('refresh','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2004',2100000981);
  IF r->>'status' IS DISTINCT FROM 'snapshot_version_unsupported'
     OR pg_temp.state('73000000-0000-4000-8000-0000000a2004') <> 'withdrawn:-:1'
     OR (SELECT e.event||':'||e.reason FROM private.shared_reference_consent_events e
          WHERE e.contribution_id=pg_temp.cid('73000000-0000-4000-8000-0000000a2004')
          ORDER BY e.id DESC LIMIT 1) IS DISTINCT FROM 'withdrawn_by_system:snapshot_version_unsupported'
     OR private.reference_set_opted_out('00000000-0000-4000-8000-0000000a2001','73000000-0000-4000-8000-0000000a2004')
     OR EXISTS (SELECT 1 FROM private.shared_reference_contribution_revisions rv
                 WHERE rv.contribution_id=pg_temp.cid('73000000-0000-4000-8000-0000000a2004')
                   AND rv.envelope_json->'snapshot'->>'schema_version' <> '1') THEN
    RAISE EXCEPTION 'A3: automatic row not withdrawn for version 2: % %', r, pg_temp.state('73000000-0000-4000-8000-0000000a2004');
  END IF;
  -- Tombstone only: not listed, no current envelope, revision 1 a stub.
  IF EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(2100000981,100,NULL,NULL,ARRAY[1,2]) e
              WHERE e->>'contribution_id' = pg_temp.cid('73000000-0000-4000-8000-0000000a2004')::text)
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(pg_temp.cid('73000000-0000-4000-8000-0000000a2004')))
     OR (SELECT array_agg(e->>'status') FROM public.get_public_reference_contribution_v2(pg_temp.cid('73000000-0000-4000-8000-0000000a2004'),1) e)
        IS DISTINCT FROM ARRAY['withdrawn']
     OR (SELECT array_agg(e->>'status') FROM public.get_public_reference_contribution_v2(pg_temp.cid('73000000-0000-4000-8000-0000000a2004'),1,ARRAY[1,2]) e)
        IS DISTINCT FROM ARRAY['withdrawn'] THEN
    RAISE EXCEPTION 'A3: the withdrawn row is still served';
  END IF;
END
$$;

-- A4. A withdrawn automatic row whose source became version 2 is not
-- re-shared.
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM private.withdraw_shared_reference_contribution(pg_temp.cid('73000000-0000-4000-8000-0000000a2005'),'use_detached');
  PERFORM pg_temp.claims('00000000-0000-4000-8000-0000000a2001','authenticated');
  UPDATE public.reference_measurement_sets
     SET q_core_min=1.3, q_core_max=1.8, revision=2
   WHERE id='73000000-0000-4000-8000-0000000a2005';
  PERFORM pg_temp.claims(NULL,NULL);
  r := private.reference_contribution_share_core('refresh','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2005',2100000981);
  IF r->>'status' IS DISTINCT FROM 'snapshot_version_unsupported'
     OR pg_temp.state('73000000-0000-4000-8000-0000000a2005') <> 'withdrawn:-:1' THEN
    RAISE EXCEPTION 'A4: withdrawn row re-shared with version 2: % %', r, pg_temp.state('73000000-0000-4000-8000-0000000a2005');
  END IF;
END
$$;

-- B. A consented grant within a {1,2} consent scope is unchanged: it shares
-- version 2 as stored.
DO $$
DECLARE r jsonb;
BEGIN
  r := private.reference_contribution_share_core('grant','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2002',2100000981,1,1,1,1,'en','stage-a-test');
  IF r->>'status' <> 'created' OR r->'row'->'snapshot'->>'schema_version' <> '2'
     OR pg_temp.state('73000000-0000-4000-8000-0000000a2002') <> 'shared:consented:1' THEN
    RAISE EXCEPTION 'B: grant of a version-2 set: %', r;
  END IF;
  r := private.reference_contribution_share_core('grant','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2003',2100000981,1,1,1,1,'en','stage-a-test');
  IF r->>'status' <> 'created' OR r->'row'->'snapshot'->>'schema_version' <> '2' THEN
    RAISE EXCEPTION 'B: grant of the percentile set: %', r;
  END IF;
  -- Consented row at version 1, revision 1. The core cannot move a
  -- consented row to version 2 within its consent (the consent scope is the
  -- granted snapshot's), so revision 2 at version 2 is a direct fixture.
  r := private.reference_contribution_share_core('grant','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2007',2100000981,1,1,1,1,'en','stage-a-test');
  IF r->>'status' <> 'no_change' OR pg_temp.state('73000000-0000-4000-8000-0000000a2007') <> 'shared:consented:1' THEN
    RAISE EXCEPTION 'B: grant of the version-1 set: % %', r, pg_temp.state('73000000-0000-4000-8000-0000000a2007');
  END IF;
  INSERT INTO private.shared_reference_contribution_revisions(
    contribution_id, revision, source_work_revision, source_treatment_revision,
    source_measurement_set_revision, content_hash, envelope_json, created_at)
  SELECT rv.contribution_id, 2, 1, 1, 2, repeat('e',64),
         jsonb_set(jsonb_set(rv.envelope_json, '{revision}', '2'), '{snapshot}',
           (rv.envelope_json->'snapshot') || jsonb_build_object(
             'schema_version', 2, 'reference_revision', 2,
             'measurements', (rv.envelope_json->'snapshot'->'measurements')
                             || '{"q_core_min":null,"q_core_max":null}'::jsonb,
             'measurement_details', '{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}'::jsonb)),
         now()
    FROM private.shared_reference_contribution_revisions rv
   WHERE rv.contribution_id = pg_temp.cid('73000000-0000-4000-8000-0000000a2007') AND rv.revision = 1;
  UPDATE private.shared_reference_contributions SET current_revision = 2
   WHERE id = pg_temp.cid('73000000-0000-4000-8000-0000000a2007');
  -- A consented refresh of an unchanged version-2 row is a no-op, not refused.
  r := private.reference_contribution_share_core('refresh','00000000-0000-4000-8000-0000000a2001',
         '73000000-0000-4000-8000-0000000a2002',2100000981);
  IF r->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'B: consented refresh of a version-2 row answered %', r;
  END IF;
END
$$;

-- C1. Species-page search, default caller: v1 byte-identical to the
-- unthrottled read; v2 projected to the exact v1 shape and marked.
DO $$
DECLARE
  v_stored jsonb[];
  v_default jsonb[];
  v_v1 uuid := pg_temp.cid('73000000-0000-4000-8000-0000000a2001');
  v_qav uuid := pg_temp.cid('73000000-0000-4000-8000-0000000a2002');
  v_pct uuid := pg_temp.cid('73000000-0000-4000-8000-0000000a2003');
  s jsonb; d jsonb; i integer;
BEGIN
  SELECT array_agg(e ORDER BY ord) INTO v_stored
    FROM private.search_public_reference_contributions_v2_unthrottled(2100000981,100,NULL,NULL) WITH ORDINALITY x(e,ord);
  SELECT array_agg(e ORDER BY ord) INTO v_default
    FROM public.search_public_reference_contributions_v2(2100000981,100) WITH ORDINALITY x(e,ord);
  IF cardinality(v_stored) <> 4 OR cardinality(v_default) <> 4 THEN
    RAISE EXCEPTION 'C1: expected 4 served contributions, got % / %', cardinality(v_stored), cardinality(v_default);
  END IF;
  FOR i IN 1..4 LOOP
    s := v_stored[i]; d := v_default[i];
    IF s->>'contribution_id' <> d->>'contribution_id' THEN
      RAISE EXCEPTION 'C1: order changed';
    END IF;
    IF s->'snapshot'->>'schema_version' = '1' THEN
      IF d::text <> s::text THEN
        RAISE EXCEPTION 'C1: a version-1 envelope changed for a default caller';
      END IF;
    ELSE
      IF d->'measurement_details_omitted' IS DISTINCT FROM 'true'::jsonb
         OR NOT pg_temp.v1_shape(d->'snapshot')
         OR (d - 'snapshot' - 'measurement_details_omitted') <> (s - 'snapshot') THEN
        RAISE EXCEPTION 'C1: version-2 envelope not projected and marked: %', d;
      END IF;
    END IF;
  END LOOP;
  -- Driving case: no Q bound, core or mean is invented from Qav 1.6-2.
  SELECT e INTO d FROM public.search_public_reference_contributions_v2(2100000981,100) e
   WHERE e->>'contribution_id' = v_qav::text;
  IF d->'snapshot'->'measurements'->'q_min' <> 'null' OR d->'snapshot'->'measurements'->'q_max' <> 'null'
     OR d->'snapshot'->'measurements'->'q_mean' <> 'null'
     OR (d->'snapshot'->'measurements') ?| ARRAY['q_core_min','q_core_max']
     OR d->'snapshot' ? 'measurement_details'
     OR d::text LIKE '%mean_interval%'
     OR (d->'snapshot'->'measurements'->>'length_core_min')::numeric <> 7
     OR (d->'snapshot'->'measurements'->>'length_max')::numeric <> 10.5 THEN
    RAISE EXCEPTION 'C1: driving case projected wrongly: %', d->'snapshot'->'measurements';
  END IF;
  -- Percentile set: Q bounds stay the stored extremes (never the core pair);
  -- the percentile length core pair is not presented as a range.
  SELECT e INTO d FROM public.search_public_reference_contributions_v2(2100000981,100) e
   WHERE e->>'contribution_id' = v_pct::text;
  IF (d->'snapshot'->'measurements'->>'q_min')::numeric <> 1.17
     OR (d->'snapshot'->'measurements'->>'q_max')::numeric <> 2.79
     OR d->'snapshot'->'measurements'->'q_mean' <> 'null'
     OR d->'snapshot'->'measurements'->'length_core_min' <> 'null'
     OR d->'snapshot'->'measurements'->'length_core_max' <> 'null'
     OR (d->'snapshot'->'measurements'->>'length_min')::numeric <> 6.9
     OR (d->'snapshot'->'measurements'->>'length_max')::numeric <> 16.1 THEN
    RAISE EXCEPTION 'C1: percentile set projected wrongly: %', d->'snapshot'->'measurements';
  END IF;
  -- Positional default caller (the landing call shape) agrees.
  IF (SELECT array_agg(e) FROM public.search_public_reference_contributions_v2(
        p_sporely_taxon_id => 2100000981, p_limit => 100, p_after_shared_at => NULL, p_after_id => NULL) e)
     IS DISTINCT FROM v_default THEN
    RAISE EXCEPTION 'C1: named-argument default call differs';
  END IF;
END
$$;

-- C2. Species-page search and get, caller accepting 2: as stored; v1 the
-- same for every caller.
DO $$
DECLARE
  v_stored jsonb[];
  v_opt jsonb[];
  v_one jsonb[];
  v_c uuid;
BEGIN
  SELECT array_agg(e ORDER BY ord) INTO v_stored
    FROM private.search_public_reference_contributions_v2_unthrottled(2100000981,100,NULL,NULL) WITH ORDINALITY x(e,ord);
  SELECT array_agg(e ORDER BY ord) INTO v_opt
    FROM public.search_public_reference_contributions_v2(2100000981,100,NULL,NULL,ARRAY[1,2]) WITH ORDINALITY x(e,ord);
  IF v_opt::text <> v_stored::text THEN
    RAISE EXCEPTION 'C2: opt-in search is not the stored envelopes';
  END IF;
  SELECT array_agg(e ORDER BY ord) INTO v_one
    FROM public.search_public_reference_contributions_v2(2100000981,100,p_accept_snapshot_versions=>'{1}') WITH ORDINALITY x(e,ord);
  IF v_one IS DISTINCT FROM (SELECT array_agg(e ORDER BY ord)
       FROM public.search_public_reference_contributions_v2(2100000981,100) WITH ORDINALITY x(e,ord)) THEN
    RAISE EXCEPTION 'C2: explicit {1} differs from the default';
  END IF;
  FOREACH v_c IN ARRAY ARRAY[pg_temp.cid('73000000-0000-4000-8000-0000000a2001'),
                             pg_temp.cid('73000000-0000-4000-8000-0000000a2002')] LOOP
    IF (SELECT array_agg(e)::text FROM public.get_public_reference_contribution_v2(v_c,NULL,ARRAY[1,2]) e)
       <> (SELECT array_agg(e)::text FROM private.get_public_reference_contribution_v2_unthrottled(v_c,NULL) e) THEN
      RAISE EXCEPTION 'C2: opt-in get is not the stored envelope';
    END IF;
  END LOOP;
  -- Default get: v1 identical, v2 marked.
  IF (SELECT array_agg(e)::text FROM public.get_public_reference_contribution_v2(pg_temp.cid('73000000-0000-4000-8000-0000000a2001')) e)
     <> (SELECT array_agg(e)::text FROM private.get_public_reference_contribution_v2_unthrottled(pg_temp.cid('73000000-0000-4000-8000-0000000a2001'),NULL) e) THEN
    RAISE EXCEPTION 'C2: default get changed a version-1 envelope';
  END IF;
  IF (SELECT count(*) FROM public.get_public_reference_contribution_v2(p_contribution_id=>pg_temp.cid('73000000-0000-4000-8000-0000000a2002'), p_revision=>1) e
       WHERE e->'measurement_details_omitted' = 'true'::jsonb AND pg_temp.v1_shape(e->'snapshot')) <> 1 THEN
    RAISE EXCEPTION 'C2: default get of a version-2 envelope is not projected and marked';
  END IF;
END
$$;

-- D. Observation reads, per item.
DO $$
DECLARE
  v_default jsonb;
  v_opt jsonb;
  v_item jsonb;
  n integer;
BEGIN
  -- version 1: identical for every caller
  IF public.get_public_observation_references(981000001)::text
       <> public.get_public_observation_references(981000001, ARRAY[1,2])::text
     OR jsonb_array_length(public.get_public_observation_references(981000001)) <> 1 THEN
    RAISE EXCEPTION 'D: version-1 observation read differs by caller';
  END IF;
  FOR n IN 2..3 LOOP
    v_default := public.get_public_observation_references(981000000+n);
    v_opt := (SELECT r."references" FROM public.search_public_observation_references(ARRAY[981000000+n::bigint], ARRAY[1,2]) r);
    IF jsonb_array_length(v_default) <> 1 OR jsonb_array_length(v_opt) <> 1 THEN
      RAISE EXCEPTION 'D: observation % reads % / % items', n, v_default, v_opt;
    END IF;
    v_item := v_default->0;
    IF v_item->'measurement_details_omitted' IS DISTINCT FROM 'true'::jsonb
       OR NOT pg_temp.v1_shape(v_item->'snapshot')
       OR v_item::text LIKE '%mean_interval%'
       OR (v_item->'snapshot'->'measurements') ?| ARRAY['q_core_min','q_core_max'] THEN
      RAISE EXCEPTION 'D: default observation item not projected and marked: %', v_item;
    END IF;
    IF v_opt->0->'snapshot'->>'schema_version' <> '2' OR v_opt->0 ? 'measurement_details_omitted'
       OR v_opt->0->'snapshot' <> private.public_reference_snapshot(
            (SELECT u.snapshot_json FROM public.observation_reference_uses u WHERE u.observation_id=981000000+n),
            ('73000000-0000-4000-8000-0000000a200'||n)::uuid, 1) THEN
      RAISE EXCEPTION 'D: opt-in observation item is not the stored version 2: %', v_opt;
    END IF;
  END LOOP;
  IF (SELECT r."references"->0->'snapshot'->'measurements' FROM public.search_public_observation_references(ARRAY[981000003::bigint]) r)
     ->>'q_min' <> '1.17' THEN
    RAISE EXCEPTION 'D: the Q core pair moved into q_min';
  END IF;
END
$$;

-- E. Accepted-version validation (NULL means the default).
DO $$
DECLARE
  v_bad integer[];
  v_txt text;
BEGIN
  FOREACH v_bad SLICE 1 IN ARRAY ARRAY[[2,2],[1,3],[0,1]] LOOP
    BEGIN
      PERFORM public.search_public_reference_contributions_v2(2100000981,10,NULL,NULL,v_bad);
      RAISE EXCEPTION 'E: accepted %', v_bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  FOREACH v_txt IN ARRAY ARRAY['{2}', '{}', '{1,NULL}'] LOOP
    v_bad := v_txt::integer[];
    BEGIN
      PERFORM public.get_public_observation_references(981000001, v_bad);
      RAISE EXCEPTION 'E: accepted %', v_bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
    BEGIN
      PERFORM public.get_public_reference_contribution_v2(pg_temp.cid('73000000-0000-4000-8000-0000000a2001'),NULL,v_bad);
      RAISE EXCEPTION 'E: accepted %', v_bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  IF (SELECT count(*) FROM public.search_public_reference_contributions_v2(2100000981,100,NULL,NULL,NULL) e
       WHERE e ? 'measurement_details_omitted') <> 3 THEN
    RAISE EXCEPTION 'E: NULL accepted versions is not the default';
  END IF;
  IF has_function_privilege('public','public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid,integer[])','EXECUTE')
     OR NOT has_function_privilege('anon','public.get_public_reference_contribution_v2(uuid,integer,integer[])','EXECUTE')
     OR has_function_privilege('anon','private.reference_public_item_for_versions(jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'E: execution surface changed';
  END IF;
END
$$;

-- G. get with an explicit older version-1 revision while the current
-- revision is version 2: the v1 revision is unchanged for both callers; the
-- current one is projected and marked only for the default caller.
DO $$
DECLARE
  v_c uuid := pg_temp.cid('73000000-0000-4000-8000-0000000a2007');
  v_old text := (SELECT array_agg(e)::text FROM private.get_public_reference_contribution_v2_unthrottled(v_c,1) e);
  v_cur text := (SELECT array_agg(e)::text FROM private.get_public_reference_contribution_v2_unthrottled(v_c,NULL) e);
BEGIN
  IF (SELECT array_agg(e->'snapshot'->>'schema_version') FROM private.get_public_reference_contribution_v2_unthrottled(v_c,1) e)
       IS DISTINCT FROM ARRAY['1'] THEN
    RAISE EXCEPTION 'G: fixture revision 1 is not version 1: %', v_old;
  END IF;
  IF (SELECT array_agg(e)::text FROM public.get_public_reference_contribution_v2(v_c,1) e) IS DISTINCT FROM v_old
     OR (SELECT array_agg(e)::text FROM public.get_public_reference_contribution_v2(v_c,1,ARRAY[1,2]) e) IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'G: an older version-1 revision changed for some caller';
  END IF;
  IF (SELECT array_agg(e)::text FROM public.get_public_reference_contribution_v2(v_c,NULL,ARRAY[1,2]) e) IS DISTINCT FROM v_cur
     OR (SELECT count(*) FROM public.get_public_reference_contribution_v2(v_c,2) e
          WHERE e->'measurement_details_omitted' = 'true'::jsonb AND pg_temp.v1_shape(e->'snapshot')
            AND (e->'snapshot'->>'reference_revision')::int = 2) <> 1 THEN
    RAISE EXCEPTION 'G: current version-2 revision not as stored (opt-in) / projected (default)';
  END IF;
END
$$;

-- F. Stage 1B: a promoted observation whose set is version 2 records the
-- distinct status and does not fail.
DO $$
DECLARE
  o constant uuid := '00000000-0000-4000-8000-0000000a2001';
  v_run bigint;
  v_action text;
BEGIN
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,data_kind,raw_text,length_core_min,length_core_max,
    measurement_details_json,revision
  ) VALUES (o,'73000000-0000-4000-8000-0000000a2006','72000000-0000-4000-8000-0000000a2001','spore_size','range','Qav 1.6-2',7,9.5,
     '{"schema_version":1,"metrics":{"q":{"mean_interval":{"lower":1.6,"upper":2,"kind":"reported_range"}}}}',1);
  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
    exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
    whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
    authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
    dangling_parent_report,source_manifest
  ) VALUES ('tax-2099.10.02-01',2,1,1,'test','test',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),
            now(),'retired','{}','{}','{}',0,'{}','{}');
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id)
  VALUES (2100000981,'tax-2099.10.02-01');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,selected_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES (981000006,o,current_date,'public',false,'public',2100000981);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  VALUES (o,gen_random_uuid(),981000006,'73000000-0000-4000-8000-0000000a2006','compared',1,
          private.reference_canonical_snapshot(o,'73000000-0000-4000-8000-0000000a2006'));
  INSERT INTO private.taxon_identity_repair_runs(release_id,plan_sha256,candidate_count,promoted_count,outcome_counts)
  VALUES ('tax-2099.10.02-01',repeat('1',64),1,1,'{}'::jsonb) RETURNING run_id INTO v_run;
  IF private._taxon_identity_repair_reconcile_references(v_run, 981000006) <> 1 THEN
    RAISE EXCEPTION 'F: expected one reference action';
  END IF;
  SELECT new_contribution INTO v_action FROM private.taxon_identity_repair_reference_actions WHERE run_id=v_run;
  IF v_action IS DISTINCT FROM 'not_shareable:snapshot_version_unsupported'
     OR pg_temp.state('73000000-0000-4000-8000-0000000a2006') <> 'none' THEN
    RAISE EXCEPTION 'F: Stage 1B recorded % (%)', v_action, pg_temp.state('73000000-0000-4000-8000-0000000a2006');
  END IF;
END
$$;

ROLLBACK;
