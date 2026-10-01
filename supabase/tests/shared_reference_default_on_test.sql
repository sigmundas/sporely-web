-- Stage 2d (20261001113007_share_references_by_default.sql): references on
-- public observations are shared by default.
--   A. opt-outs as the migration's backfill writes them (the backfill
--      itself is tested through the migration by
--      shared_reference_backfill_migration_test.sh);
--   B. the deploy refresh (migration step 14, verbatim), count-agnostic,
--      honouring opt-outs and hides, idempotent;
--   C. every trigger creates; the observation trigger refreshes an
--      observation that becomes public; opt-out stickiness across triggers;
--   D. stop_sharing_reference_set / share_reference_set_again /
--      withdraw_reference_contribution surface and responses;
--   E. list_my_reference_sharing;
--   F. rollback step 2 (withdraw every automatic row with reason rollback).
-- Every transaction is rolled back.

BEGIN;

CREATE FUNCTION pg_temp.claims(p_sub uuid, p_role text) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_role IS NULL THEN ''
         ELSE json_build_object('sub',p_sub::text,'role',p_role)::text END, true)
$$;

-- Migration step 14, verbatim (as a function).
CREATE FUNCTION pg_temp.deploy_refresh() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_key record;
  v_created integer;
  v_reshared integer;
BEGIN
  FOR v_key IN
    SELECT DISTINCT u.user_id, u.reference_measurement_set_id AS set_id,
           coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)::integer AS taxon_id
      FROM public.observation_reference_uses u
      JOIN public.observations o ON o.user_id = u.user_id AND o.id = u.observation_id
      JOIN taxonomy_v3.registry_concept rc
        ON rc.sporely_taxon_id = coalesce(o.selected_sporely_taxon_id, o.resolved_sporely_taxon_id)
       AND rc.rank = 'species'
     WHERE u.deleted_at IS NULL
       AND o.visibility = 'public' AND o.is_draft IS FALSE
       AND o.spore_data_visibility = 'public'
     ORDER BY 1, 2, 3
  LOOP
    PERFORM private.reference_contribution_share_core(
      'refresh', v_key.user_id, v_key.set_id, v_key.taxon_id
    );
  END LOOP;
  SELECT pg_catalog.count(*) FILTER (WHERE c.current_revision = 1),
         pg_catalog.count(*) FILTER (WHERE c.current_revision > 1)
    INTO v_created, v_reshared
    FROM private.shared_reference_consent_events e
    JOIN private.shared_reference_contributions c ON c.id = e.contribution_id
   WHERE e.event = 'shared_automatically'
     AND e.occurred_at >= pg_catalog.transaction_timestamp();
  RAISE NOTICE 'reference sharing deploy refresh: % created, % re-shared', v_created, v_reshared;
END
$$;

CREATE FUNCTION pg_temp.state(p_owner uuid, p_set uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT coalesce(string_agg(c.status||':'||coalesce(c.share_basis,'-'), ',' ORDER BY c.sporely_taxon_id), 'none')
    FROM private.shared_reference_contributions c
   WHERE c.owner_id=p_owner AND c.source_measurement_set_id=p_set
$$;

DO $$
DECLARE
  o1 constant uuid := '00000000-0000-4000-8000-0000000d0001';
  o2 constant uuid := '00000000-0000-4000-8000-0000000d0002';
  t constant integer := 2100000991;
  t2 constant integer := 2100000992;
  w1 constant uuid := '71000000-0000-4000-8000-0000000d0001';
  tr1 constant uuid := '72000000-0000-4000-8000-0000000d0001';
  w2 constant uuid := '71000000-0000-4000-8000-0000000d0002';
  tr2 constant uuid := '72000000-0000-4000-8000-0000000d0002';
  -- o1's sets
  s_owner_pre2a constant uuid := '73000000-0000-4000-8000-0000000d0001';
  s_system constant uuid := '73000000-0000-4000-8000-0000000d0002';
  s_repair constant uuid := '73000000-0000-4000-8000-0000000d0003';
  s_owner_2a constant uuid := '73000000-0000-4000-8000-0000000d0004';
  s_new constant uuid := '73000000-0000-4000-8000-0000000d0005';
  s_hidden constant uuid := '73000000-0000-4000-8000-0000000d0006';
  s_private constant uuid := '73000000-0000-4000-8000-0000000d0007';
  s_b constant uuid := '73000000-0000-4000-8000-0000000d0008';
  v_id uuid;
  v_hidden_id uuid;
  v_run bigint;
  v_n integer;
  v_before jsonb;
  r jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (o1,'authenticated','authenticated','default-on-1@example.invalid','{}',now(),now()),
    (o2,'authenticated','authenticated','default-on-2@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (o1,'default_on_1',false),(o2,'default_on_2',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (t,'Amanita defaulta','species','include','in_cache','default-on-test'),
           (t2,'Amanita secunda','species','include','in_cache','default-on-test');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES
    (970000001,o1,current_date,'public',false,'public',t),
    (970000002,o1,current_date,'public',false,'public',t),
    (970000003,o1,current_date,'public',false,'public',t),
    (970000004,o1,current_date,'public',false,'public',t),
    (970000005,o1,current_date,'public',false,'public',t),
    (970000006,o1,current_date,'public',false,'public',t),
    (970000007,o1,current_date,'private',false,'private',t),
    (970000008,o2,current_date,'public',false,'public',t);
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (o1,w1,'article','[{"family":"Default"}]','Default on',2026,'Default 2026',1),
         (o2,w2,'article','[{"family":"Other"}]','Other',2026,'Other 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (o1,tr1,w1,'d','Amanita defaulta',1),(o2,tr2,w2,'d','Amanita defaulta',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  SELECT o1,s,tr1,'spore_size','range','8-10 um',1
    FROM unnest(ARRAY[s_owner_pre2a,s_system,s_repair,s_owner_2a,s_new,s_hidden,s_private]) s;
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  VALUES (o2,s_b,tr2,'spore_size','range','9-11 um',1);
  -- Written without a session: no automatic path runs.
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  SELECT x.o,gen_random_uuid(),x.obs,x.s,'compared',1,private.reference_canonical_snapshot(x.o,x.s)
    FROM (VALUES (o1,970000001::bigint,s_owner_pre2a),(o1,970000002,s_system),(o1,970000003,s_repair),
                 (o1,970000004,s_owner_2a),(o1,970000005,s_new),(o1,970000006,s_hidden),
                 (o1,970000007,s_private),(o2,970000008,s_b)) x(o,obs,s);
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions) THEN
    RAISE EXCEPTION 'fixture writes without a session created a contribution';
  END IF;

  -- Pre-deploy states. Withdrawn rows are inserted directly, as the
  -- historical paths left them.
  -- pre-2a owner withdrawal: no event at all.
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,withdrawn_at)
  VALUES (o1,s_owner_pre2a,t,'withdrawn',1,now()-interval '30 days');
  -- system withdrawal with its event (consent_missing).
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,withdrawn_at)
  VALUES (o1,s_system,t,'withdrawn',1,now()-interval '2 days') RETURNING id INTO v_id;
  INSERT INTO private.shared_reference_contribution_revisions(contribution_id,revision,source_work_revision,
    source_treatment_revision,source_measurement_set_revision,content_hash,envelope_json)
  VALUES (v_id,1,1,1,1,repeat('a',64),'{"status":"shared","revision":1}');
  INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason)
  VALUES (v_id,'withdrawn_by_system','consent_missing');
  -- event-less Stage 1B repair withdrawal: opted out too (no exclusion).
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,withdrawn_at)
  VALUES (o1,s_repair,t2,'withdrawn',1,now()-interval '20 days');
  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
    exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
    whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
    authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
    dangling_parent_report,source_manifest
  ) VALUES ('tax-2099.11.01-01',2,1,1,'test','test',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),
     now(),'retired','{}','{}','{}',0,'{}','{}');
  INSERT INTO private.taxon_identity_repair_runs(release_id,plan_sha256,candidate_count,promoted_count,outcome_counts)
  VALUES ('tax-2099.11.01-01',repeat('1',64),1,1,'{}') RETURNING run_id INTO v_run;
  INSERT INTO private.taxon_identity_repair_reference_actions(
    run_id,observation_id,reference_measurement_set_id,old_sporely_taxon_id,new_sporely_taxon_id,
    old_contribution,new_contribution)
  VALUES (v_run,970000003,s_repair,t2,t,'withdrawn','shared');
  -- 2a/2b owner withdrawal (withdrawn_by_owner event).
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,withdrawn_at)
  VALUES (o1,s_owner_2a,t,'withdrawn',1,now()-interval '1 day') RETURNING id INTO v_id;
  INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason)
  VALUES (v_id,'withdrawn_by_owner','owner');
  -- hidden, system-withdrawn.
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,withdrawn_at,hidden_at,hidden_reason)
  VALUES (o1,s_hidden,t,'withdrawn',1,now(),now(),'abuse') RETURNING id INTO v_hidden_id;
  INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason)
  VALUES (v_hidden_id,'withdrawn_by_system','consent_missing');
  -- anonymised (deleted account) rows are never touched.
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,withdrawn_at)
  VALUES (NULL,NULL,t,'withdrawn',1,now());

  -- ── A. Opt-outs as the backfill writes them (pre-2a owner, event-less
  -- repair, latest-owner withdrawals) ──
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id,opted_out_at)
  VALUES (o1,s_owner_pre2a,now()-interval '30 days'),(o1,s_repair,now()-interval '20 days'),
         (o1,s_owner_2a,now()-interval '1 day');

  -- ── B. Deploy refresh ──
  PERFORM pg_temp.deploy_refresh();
  IF pg_temp.state(o1,s_owner_pre2a) <> 'withdrawn:-'
     OR pg_temp.state(o1,s_owner_2a) <> 'withdrawn:-'
     OR pg_temp.state(o1,s_system) <> 'shared:automatic'
     OR pg_temp.state(o1,s_repair) <> 'withdrawn:-'
     OR pg_temp.state(o1,s_new) <> 'shared:automatic'
     OR pg_temp.state(o1,s_hidden) <> 'withdrawn:-'
     OR pg_temp.state(o1,s_private) <> 'none'
     OR pg_temp.state(o2,s_b) <> 'shared:automatic'
     OR (SELECT hidden_at FROM private.shared_reference_contributions WHERE id=v_hidden_id) IS NULL THEN
    RAISE EXCEPTION 'deploy refresh: wrong states % % % % % % % %',
      pg_temp.state(o1,s_owner_pre2a), pg_temp.state(o1,s_owner_2a), pg_temp.state(o1,s_system),
      pg_temp.state(o1,s_repair), pg_temp.state(o1,s_new), pg_temp.state(o1,s_hidden),
      pg_temp.state(o1,s_private), pg_temp.state(o2,s_b);
  END IF;
  -- The re-shared row starts a new period at revision 2; revision 1 stays unserved.
  SELECT id INTO v_id FROM private.shared_reference_contributions WHERE source_measurement_set_id=s_system;
  IF (SELECT current_revision||':'||shared_first_revision FROM private.shared_reference_contributions WHERE id=v_id) <> '2:2'
     OR EXISTS (SELECT 1 FROM private.get_public_reference_contribution_v2_unthrottled(v_id,1))
     OR NOT EXISTS (SELECT 1 FROM private.get_public_reference_contribution_v2_unthrottled(v_id,2)) THEN
    RAISE EXCEPTION 'deploy re-share did not start a new sharing period';
  END IF;
  IF (SELECT count(*) FROM private.shared_reference_consent_events WHERE event='shared_automatically') <> 3 THEN
    RAISE EXCEPTION 'deploy refresh did not log one shared_automatically per share';
  END IF;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) INTO v_before FROM private.shared_reference_contributions c;
  v_n := (SELECT count(*) FROM private.shared_reference_consent_events);
  PERFORM pg_temp.deploy_refresh();
  IF (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM private.shared_reference_contributions c) IS DISTINCT FROM v_before
     OR (SELECT count(*) FROM private.shared_reference_consent_events) <> v_n THEN
    RAISE EXCEPTION 'a second deploy refresh changed something';
  END IF;

  -- ── C. Triggers create; opt-outs stick ──
  -- Publishing an observation (owner session) creates.
  PERFORM pg_temp.claims(o1,'authenticated');
  UPDATE public.observations SET visibility='public' WHERE id=970000007;
  IF pg_temp.state(o1,s_private) <> 'none' THEN
    RAISE EXCEPTION 'an observation with private spore data shared';
  END IF;
  UPDATE public.observations SET spore_data_visibility='public' WHERE id=970000007;
  IF pg_temp.state(o1,s_private) <> 'shared:automatic' THEN
    RAISE EXCEPTION 'spore data private -> public did not create: %', pg_temp.state(o1,s_private);
  END IF;
  UPDATE public.observations SET is_draft=true WHERE id=970000007;
  IF pg_temp.state(o1,s_private) <> 'withdrawn:-' THEN
    RAISE EXCEPTION 'draft did not withdraw';
  END IF;
  UPDATE public.observations SET is_draft=false WHERE id=970000007;
  IF pg_temp.state(o1,s_private) <> 'shared:automatic' THEN
    RAISE EXCEPTION 'publishing again did not re-share';
  END IF;
  -- Without the owner or service role (e.g. another session), the
  -- observation trigger withdraws but does not create.
  PERFORM pg_temp.claims(NULL,NULL);
  UPDATE public.observations SET visibility='friends' WHERE id=970000007;
  UPDATE public.observations SET visibility='public' WHERE id=970000007;
  IF pg_temp.state(o1,s_private) <> 'withdrawn:-' THEN
    RAISE EXCEPTION 'a sessionless publish created: %', pg_temp.state(o1,s_private);
  END IF;
  -- The use trigger creates (owner use sync).
  PERFORM pg_temp.claims(o1,'authenticated');
  UPDATE public.observation_reference_uses SET snapshot_json=snapshot_json WHERE observation_id=970000007;
  IF pg_temp.state(o1,s_private) <> 'shared:automatic' THEN
    RAISE EXCEPTION 'the use trigger did not create';
  END IF;
  -- The taxon trigger creates under the new taxon (service role).
  PERFORM pg_temp.claims(NULL,'service_role');
  UPDATE public.observations SET resolved_sporely_taxon_id=t2 WHERE id=970000007;
  IF pg_temp.state(o1,s_private) <> 'withdrawn:-,shared:automatic' THEN
    RAISE EXCEPTION 'the taxon trigger did not move the share: %', pg_temp.state(o1,s_private);
  END IF;
  -- The source triggers create: a measurement-set edit and a work edit by
  -- the owner re-share a system-withdrawn set.
  SELECT id INTO v_id FROM private.shared_reference_contributions WHERE source_measurement_set_id=s_new;
  PERFORM private.withdraw_shared_reference_contribution(v_id,'use_detached');
  PERFORM pg_temp.claims(o1,'authenticated');
  UPDATE public.reference_measurement_sets SET raw_text='8-10 um',revision=revision+1,row_version=row_version+1
   WHERE user_id=o1 AND id=s_new;
  IF pg_temp.state(o1,s_new) <> 'shared:automatic' THEN
    RAISE EXCEPTION 'the measurement-set trigger did not re-share';
  END IF;
  PERFORM private.withdraw_shared_reference_contribution(v_id,'use_detached');
  UPDATE public.reference_taxon_treatments SET revision=revision+1,row_version=row_version+1
   WHERE user_id=o1 AND id=tr1;
  IF pg_temp.state(o1,s_new) <> 'shared:automatic' THEN
    RAISE EXCEPTION 'the treatment trigger did not re-share';
  END IF;
  -- Opted-out sets stay withdrawn through every trigger.
  PERFORM pg_temp.claims(o1,'authenticated');
  UPDATE public.observation_reference_uses SET snapshot_json=snapshot_json WHERE observation_id=970000001;
  UPDATE public.reference_measurement_sets SET raw_text='8-10.5 um',revision=revision+1,row_version=row_version+1
   WHERE user_id=o1 AND id=s_owner_pre2a;
  UPDATE public.reference_works SET title='Default on, rev',revision=revision+1,row_version=row_version+1
   WHERE user_id=o1 AND id=w1;
  UPDATE public.observations SET is_draft=true WHERE id=970000001;
  UPDATE public.observations SET is_draft=false WHERE id=970000001;
  UPDATE public.observations SET resolved_sporely_taxon_id=t2 WHERE id=970000001;
  UPDATE public.observations SET resolved_sporely_taxon_id=t WHERE id=970000001;
  PERFORM pg_temp.claims(NULL,NULL);
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions
              WHERE source_measurement_set_id IN (s_owner_pre2a,s_owner_2a) AND status='shared')
     OR jsonb_array_length(public.get_public_observation_references(970000001)) <> 0 THEN
    RAISE EXCEPTION 'an opted-out set was shared by a trigger';
  END IF;
  IF jsonb_array_length(public.get_public_observation_references(970000005)) <> 1 THEN
    RAISE EXCEPTION 'a served set is missing from its observation';
  END IF;

  -- ── D. Owner RPCs ──
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM pg_temp.claims(o2,'authenticated');
  SET LOCAL ROLE authenticated;
  -- A foreign set and an unknown set get the same response; nothing changes.
  IF public.stop_sharing_reference_set(s_new) IS DISTINCT FROM public.stop_sharing_reference_set(gen_random_uuid())
     OR public.stop_sharing_reference_set(s_new)->>'status' <> 'not_found'
     OR public.share_reference_set_again(s_owner_2a) IS DISTINCT FROM public.share_reference_set_again(gen_random_uuid())
     OR public.share_reference_set_again(s_owner_2a)->>'status' <> 'not_found'
     OR public.stop_sharing_reference_set(NULL)->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'foreign/unknown set responses differ or are not not_found';
  END IF;
  -- The released per-contribution RPC: foreign -> forbidden, unknown -> not_found.
  IF public.withdraw_reference_contribution(v_id)->>'status' <> 'forbidden'
     OR public.withdraw_reference_contribution(gen_random_uuid())->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'withdrawal RPC contract changed';
  END IF;
  RESET ROLE;
  IF private.reference_set_opted_out(o1,s_new) OR private.reference_set_opted_out(o1,s_owner_2a) IS NOT TRUE
     OR pg_temp.state(o1,s_new) <> 'shared:automatic' THEN
    RAISE EXCEPTION 'a foreign call changed state';
  END IF;
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM pg_temp.claims(o1,'authenticated');
  SET LOCAL ROLE authenticated;
  r := public.stop_sharing_reference_set(s_new);
  IF r->>'status' <> 'updated' OR public.stop_sharing_reference_set(s_new)->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'stop sharing responses wrong: %', r;
  END IF;
  RESET ROLE;
  IF pg_temp.state(o1,s_new) <> 'withdrawn:-'
     OR (SELECT e.event||':'||e.reason FROM private.shared_reference_consent_events e
           JOIN private.shared_reference_contributions c ON c.id=e.contribution_id
          WHERE c.source_measurement_set_id=s_new ORDER BY e.id DESC LIMIT 1) <> 'withdrawn_by_owner:owner'
     OR public.get_public_observation_references(970000005) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'stop sharing did not withdraw the set on both surfaces';
  END IF;
  SET LOCAL ROLE authenticated;
  -- A set with no contribution can be stopped too (taxon-less sets).
  IF public.stop_sharing_reference_set(s_owner_pre2a)->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'stopping an already stopped set changed something';
  END IF;
  r := public.share_reference_set_again(s_new);
  IF r->>'status' <> 'updated' OR public.share_reference_set_again(s_new)->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'share again responses wrong: %', r;
  END IF;
  RESET ROLE;
  IF pg_temp.state(o1,s_new) <> 'shared:automatic'
     OR jsonb_array_length(public.get_public_observation_references(970000005)) <> 1 THEN
    RAISE EXCEPTION 'share again did not re-share on both surfaces';
  END IF;
  -- Share again on a hidden set clears the opt-out but never the hide.
  SET LOCAL ROLE authenticated;
  r := public.stop_sharing_reference_set(s_hidden);
  r := public.share_reference_set_again(s_hidden);
  RESET ROLE;
  IF pg_temp.state(o1,s_hidden) <> 'withdrawn:-'
     OR (SELECT hidden_at FROM private.shared_reference_contributions WHERE id=v_hidden_id) IS NULL
     OR public.get_public_observation_references(970000006) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'share again bypassed moderation';
  END IF;
  -- The released RPC stops the whole set.
  SELECT id INTO v_id FROM private.shared_reference_contributions
   WHERE source_measurement_set_id=s_private AND status='shared';
  SET LOCAL ROLE authenticated;
  IF public.withdraw_reference_contribution(v_id)->>'status' <> 'updated'
     OR public.withdraw_reference_contribution(v_id)->>'status' <> 'no_change' THEN
    RAISE EXCEPTION 'withdrawal RPC responses wrong';
  END IF;
  RESET ROLE;
  IF NOT private.reference_set_opted_out(o1,s_private) OR pg_temp.state(o1,s_private) <> 'withdrawn:-,withdrawn:-' THEN
    RAISE EXCEPTION 'withdrawal RPC did not stop the set';
  END IF;

  -- ── D2. Moderation is set-level: hiding the contribution under one taxon
  -- hides a shared sibling under another taxon on the species page, in
  -- roles and on observations; a refresh does not touch the sibling ──
  PERFORM pg_temp.claims(NULL,'service_role');
  UPDATE public.observations SET resolved_sporely_taxon_id=t2 WHERE id=970000005;
  UPDATE public.observations SET resolved_sporely_taxon_id=t WHERE id=970000005;
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES (970000009,o1,current_date,'public',false,'public',t2);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  VALUES (o1,gen_random_uuid(),970000009,s_new,'contradicts',1,private.reference_canonical_snapshot(o1,s_new));
  PERFORM pg_temp.claims(NULL,NULL);
  IF pg_temp.state(o1,s_new) <> 'shared:automatic,shared:automatic' THEN
    RAISE EXCEPTION 'sibling fixture: %', pg_temp.state(o1,s_new);
  END IF;
  SELECT id INTO v_id FROM private.shared_reference_contributions WHERE source_measurement_set_id=s_new AND sporely_taxon_id=t;
  IF NOT private.reference_contribution_is_served(v_id)
     OR private.reference_contribution_public_roles(v_id) IS DISTINCT FROM ARRAY['compared'] THEN
    RAISE EXCEPTION 'sibling A not served before the hide';
  END IF;
  UPDATE private.shared_reference_contributions SET hidden_at=now(),hidden_reason='abuse'
   WHERE source_measurement_set_id=s_new AND sporely_taxon_id=t2;
  v_n := (SELECT current_revision FROM private.shared_reference_contributions WHERE id=v_id);
  IF private.reference_contribution_is_served(v_id)
     OR EXISTS (SELECT 1 FROM private.search_public_reference_contributions_v2_unthrottled(t,100,NULL,NULL) i
                 WHERE i->>'contribution_id'=v_id::text)
     OR EXISTS (SELECT 1 FROM private.get_public_reference_contribution_v2_unthrottled(v_id,NULL))
     OR private.reference_contribution_public_roles(v_id) IS DISTINCT FROM '{}'::text[]
     OR public.get_public_observation_references(970000005) <> '[]'::jsonb
     OR public.get_public_observation_references(970000009) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'a sibling of a hidden contribution is still served';
  END IF;
  IF (private.reference_contribution_share_core('refresh',o1,s_new,t)->>'status') <> 'moderation_hidden'
     OR (SELECT current_revision FROM private.shared_reference_contributions WHERE id=v_id) <> v_n THEN
    RAISE EXCEPTION 'a refresh touched the sibling of a hidden contribution';
  END IF;
  UPDATE private.shared_reference_contributions SET hidden_at=NULL,hidden_reason=NULL
   WHERE source_measurement_set_id=s_new AND sporely_taxon_id=t2;
  IF NOT private.reference_contribution_is_served(v_id) THEN
    RAISE EXCEPTION 'restore did not serve the sibling again';
  END IF;
  -- The owner list includes a still-shared set without a qualifying use.
  UPDATE public.observations SET visibility='private' WHERE id IN (970000005,970000009);
  -- (the trigger withdrew; put one row back to simulate a stale share)
  UPDATE private.shared_reference_contributions
     SET status='shared',withdrawn_at=NULL,share_basis='automatic',
         shared_first_revision=current_revision
   WHERE id=v_id;
  PERFORM pg_temp.claims(o1,'authenticated');

  -- ── E. list_my_reference_sharing ──
  DELETE FROM private.shared_reference_rate_buckets;
  SET LOCAL ROLE authenticated;
  r := public.list_my_reference_sharing();
  RESET ROLE;
  IF r->>'status' <> 'ok'
     OR (SELECT array_agg(x->>'source_measurement_set_id'||':'||(x->>'status') ORDER BY x->>'source_measurement_set_id')
           FROM jsonb_array_elements(r->'sets') x)
        IS DISTINCT FROM ARRAY[s_owner_pre2a||':stopped', s_system||':shared', s_repair||':stopped',
                               s_owner_2a||':stopped', s_new||':shared', s_hidden||':hidden',
                               s_private||':stopped']
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r->'sets') x
                 WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k)
                       <> ARRAY['hidden_by_moderation','public_observation_count','source_measurement_set_id',
                                'source_raw_text','source_short_label','species_page_contributions',
                                'status','stopped_at'])
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'sets') x
                     WHERE x->>'source_measurement_set_id'=s_new::text
                       AND (x->>'public_observation_count')::integer=0
                       AND x->'stopped_at'='null'::jsonb
                       AND x->>'source_short_label'='Default 2026' AND x->>'source_raw_text'='8-10 um'
                       AND jsonb_array_length(x->'species_page_contributions')=1
                       AND x->'species_page_contributions'->0->>'canonical_scientific_name'='Amanita defaulta')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'sets') x
                     WHERE x->>'source_measurement_set_id'=s_owner_pre2a::text
                       AND x->>'stopped_at' IS NOT NULL
                       AND x->'species_page_contributions'='[]'::jsonb)
     OR r::text LIKE '%'||o1::text||'%'
     OR r::text LIKE '%'||s_b::text||'%' THEN
    RAISE EXCEPTION 'owner set list wrong: %', r;
  END IF;
  PERFORM pg_temp.claims(NULL,NULL);
  BEGIN
    PERFORM public.list_my_reference_sharing();
    RAISE EXCEPTION 'set list served without a session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.stop_sharing_reference_set(s_new);
    RAISE EXCEPTION 'stop sharing without a session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ── F. Rollback step 2: every automatic row withdrawn with reason rollback ──
  v_n := (SELECT count(*) FROM private.shared_reference_contributions WHERE share_basis='automatic');
  IF v_n < 3 THEN RAISE EXCEPTION 'rollback fixture has too few automatic rows'; END IF;
  PERFORM private.lock_shared_reference_key(c.owner_id, c.source_measurement_set_id),
          private.withdraw_shared_reference_contribution(c.id, 'rollback')
     FROM private.shared_reference_contributions c
    WHERE c.status = 'shared' AND c.share_basis = 'automatic'
    ORDER BY c.owner_id, c.source_measurement_set_id, c.id;
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions WHERE share_basis='automatic')
     OR (SELECT count(*) FROM private.shared_reference_consent_events
          WHERE event='withdrawn_by_system' AND reason='rollback') <> v_n
     OR (SELECT count(*) FROM private.reference_share_opt_outs) <> 4 THEN
    RAISE EXCEPTION 'rollback step 2 did not withdraw exactly the automatic rows, keeping opt-outs';
  END IF;
END
$$;

ROLLBACK;
