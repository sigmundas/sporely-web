-- Shared-reference contribution contract after Stage 2d (20261001113007,
-- shared by default). A qualifying use of a registry species shares the
-- set automatically (basis 'automatic'), unless the set is opted out or a
-- contribution of it is hidden. Stop sharing sticks until Share again.
--
-- Changed meaning against Stage 2a/2b: section 1 (automatic paths now create),
-- section 5 (a restored qualifying use re-shares automatically, in a new
-- sharing period, instead of staying withdrawn until a re-grant), section 7
-- (refresh re-shares instead of answering consent_required), section 8/9
-- (stop/share again instead of re-grant). Consented rows are still seeded
-- through the grant mode of the private core where consent-only checks are
-- tested.

BEGIN;

CREATE FUNCTION pg_temp.claims(p_sub uuid, p_role text) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_role IS NULL THEN ''
         ELSE json_build_object('sub',p_sub::text,'role',p_role)::text END, true)
$$;

CREATE FUNCTION pg_temp.fixture_grant(p_owner uuid, p_set uuid, p_taxon integer, p_locale text DEFAULT 'en')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT w.revision AS w, t.revision AS t, m.revision AS m INTO r
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
   WHERE m.user_id=p_owner AND m.id=p_set;
  RETURN private.reference_contribution_share_core(
    'grant',p_owner,p_set,p_taxon,r.w,r.t,r.m,1,p_locale,'fixture');
END
$$;

CREATE FUNCTION pg_temp.last_event_id() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(id),0) FROM private.shared_reference_consent_events $$;

-- Asserts the row is withdrawn with a cleared consent record and that exactly
-- one event (the expected one) was written since p_after.
CREATE FUNCTION pg_temp.assert_withdrawn(p_label text, p_id uuid, p_event text, p_after bigint)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c private.shared_reference_contributions%ROWTYPE; v_events text[];
BEGIN
  SELECT * INTO c FROM private.shared_reference_contributions WHERE id=p_id;
  IF c.status <> 'withdrawn' OR c.withdrawn_at IS NULL OR c.consented_at IS NOT NULL
     OR c.share_basis IS NOT NULL OR c.shared_first_revision IS NOT NULL
     OR c.consent_version IS NOT NULL OR c.consent_locale IS NOT NULL OR c.consent_client IS NOT NULL
     OR c.consent_first_revision IS NOT NULL OR c.consent_scope IS NOT NULL THEN
    RAISE EXCEPTION '%: not withdrawn with a cleared consent record: %', p_label, to_jsonb(c);
  END IF;
  SELECT array_agg(e.event||':'||e.reason ORDER BY e.id) INTO v_events
    FROM private.shared_reference_consent_events e
   WHERE e.contribution_id=p_id AND e.id>p_after;
  IF v_events IS DISTINCT FROM ARRAY[p_event] THEN
    RAISE EXCEPTION '%: expected exactly event %, got %', p_label, p_event, v_events;
  END IF;
END
$$;

DO $$
DECLARE
  user_1 constant uuid := '00000000-0000-4000-8000-00000000c101';
  user_2 constant uuid := '00000000-0000-4000-8000-00000000c102';
  taxon_id constant integer := 2100000901;
  other_taxon_id constant integer := 2100000902;
  genus_taxon_id constant integer := 2100000903;
  set_1 constant uuid := '73000000-0000-4000-8000-000000000001';
  set_2 constant uuid := '73000000-0000-4000-8000-000000000002';
  use_1 constant uuid := '74000000-0000-4000-8000-000000000001';
  use_3 constant uuid := '74000000-0000-4000-8000-000000000003';
  contribution_1 uuid;
  contribution_2 uuid;
  first_envelope jsonb;
  result jsonb;
  v_after bigint;
  v_rev integer;
  v_case record;
  v_rev_before integer;
  v_events text[];
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
    (940000001,user_1,current_date,'public',false,taxon_id),
    (940000002,user_2,current_date,'public',false,taxon_id),
    (940000003,user_1,current_date,'public',false,taxon_id),
    (940000004,user_1,current_date,'private',false,taxon_id);

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
    (user_1,set_1,'72000000-0000-4000-8000-000000000001','spore_size','8–10 × 5–6 µm',
     'range',8,10,5,6,1),
    (user_2,set_2,'72000000-0000-4000-8000-000000000002','spore_size','9–11 × 9–12 µm',
     'range',9,11,9,12,1);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,
    reference_revision,snapshot_json
  ) VALUES
    (user_1,use_1,940000001,set_1,'compared',1,
     private.reference_canonical_snapshot(user_1,set_1)),
    (user_2,'74000000-0000-4000-8000-000000000002',940000002,set_2,'compared',1,
     private.reference_canonical_snapshot(user_2,set_2)),
    (user_1,use_3,940000003,set_1,'compared',1,
     private.reference_canonical_snapshot(user_1,set_1)),
    (user_1,'74000000-0000-4000-8000-000000000004',940000004,set_1,'compared',1,
     private.reference_canonical_snapshot(user_1,set_1));
  -- The fixture text replaces the shipped, inactive version-1 texts.
  DELETE FROM private.reference_share_consent_texts;
  INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope) VALUES
    (1,'en','fixture consent text',encode(sha256(convert_to('fixture consent text','UTF8')),'hex'),true,
     '{"snapshot_schema_versions":[1,2],"data_kinds":["raw_points","free_text","measurement_details"]}'),
    (1,'nb','fixture samtykke uten punkter',encode(sha256(convert_to('fixture samtykke uten punkter','UTF8')),'hex'),true,
     '{"snapshot_schema_versions":[1],"data_kinds":["free_text"]}');

  -- ── 1. Automatic paths create; the old RPC still creates nothing ──
  PERFORM pg_temp.claims(user_1,'authenticated');
  SET LOCAL ROLE authenticated;
  SELECT public.sync_observation_reference_use(
    pg_catalog.jsonb_build_object(
      'id',u.id,'observation_id',u.observation_id,
      'reference_measurement_set_id',u.reference_measurement_set_id,
      'role','supports_identification','note',NULL,'selected_at',u.selected_at,
      'reference_revision',u.reference_revision,'snapshot_json',u.snapshot_json
    ),u.row_version,'current'
  ) INTO result
  FROM public.observation_reference_uses u WHERE u.id=use_1;
  IF result->>'status' <> 'updated' THEN
    RAISE EXCEPTION 'owner use sync was not accepted: %', result;
  END IF;
  result := public.share_reference_contribution(set_1,taxon_id,1,1,1);
  IF result->>'status' <> 'consent_required' THEN
    RAISE EXCEPTION 'old share RPC did not return consent_required: %', result;
  END IF;
  RESET ROLE;
  UPDATE public.reference_measurement_sets SET revision=revision, row_version=row_version+1
   WHERE user_id=user_1 AND id=set_1;
  UPDATE public.reference_works SET revision=revision WHERE user_id=user_1;
  UPDATE public.observations SET resolved_sporely_taxon_id=other_taxon_id WHERE id=940000001;
  UPDATE public.observations SET resolved_sporely_taxon_id=taxon_id WHERE id=940000001;
  PERFORM pg_temp.claims(NULL,'service_role');
  UPDATE public.observations SET resolved_sporely_taxon_id=other_taxon_id WHERE id=940000002;
  UPDATE public.observations SET resolved_sporely_taxon_id=taxon_id WHERE id=940000002;
  -- Exactly one shared, automatic row per (owner, set) for the current
  -- taxon; the taxon round trips left the other-taxon rows withdrawn.
  IF (SELECT array_agg(c.owner_id::text||':'||c.share_basis ORDER BY c.owner_id)
        FROM private.shared_reference_contributions c
       WHERE c.status='shared' AND c.sporely_taxon_id=taxon_id
         AND c.consented_at IS NULL AND c.shared_first_revision IS NOT NULL)
       IS DISTINCT FROM ARRAY[user_1::text||':automatic', user_2::text||':automatic']
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions c
                 WHERE c.status='shared' AND c.sporely_taxon_id<>taxon_id)
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events e
                 WHERE e.event='shared_automatically'
                   AND (e.reason IS NOT NULL OR e.locale IS NOT NULL OR e.consent_version IS NOT NULL))
     OR NOT EXISTS (SELECT 1 FROM private.shared_reference_consent_events e WHERE e.event='shared_automatically')
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events e WHERE e.event='granted') THEN
    RAISE EXCEPTION 'automatic paths did not create exactly the automatic rows: %',
      (SELECT jsonb_agg(to_jsonb(c)) FROM private.shared_reference_contributions c);
  END IF;

  -- ── 2. An automatic contribution is public, without the raw account id ──
  PERFORM pg_temp.claims(NULL,NULL);
  SELECT id INTO contribution_1 FROM private.shared_reference_contributions
   WHERE owner_id=user_1 AND source_measurement_set_id=set_1 AND sporely_taxon_id=taxon_id;
  PERFORM pg_temp.claims(user_2,'authenticated');
  SET LOCAL ROLE authenticated;
  SELECT item INTO first_envelope
    FROM public.search_public_reference_contributions_v2(taxon_id,50,NULL,NULL) item
   WHERE item->>'contribution_id'=contribution_1::text;
  IF first_envelope->>'contribution_id' IS DISTINCT FROM contribution_1::text
     OR first_envelope->'contributor'->'id' <> 'null'::jsonb
     OR first_envelope->'contributor'->>'label' <> 'shared_one'
     OR first_envelope->'snapshot'->>'raw_text' <> '8–10 × 5–6 µm'
     OR first_envelope::text LIKE '%'||user_1::text||'%'
     OR first_envelope::text LIKE '%940000001%'
     OR first_envelope::text LIKE '%71000000-0000-4000-8000-000000000001%'
     OR first_envelope::text LIKE '%72000000-0000-4000-8000-000000000001%' THEN
    RAISE EXCEPTION 'public contribution attribution/privacy projection failed: %', first_envelope;
  END IF;
  -- The old RPC cannot touch another owner's row either.
  result := public.share_reference_contribution(set_1,taxon_id,1,1,1);
  IF result->>'status' <> 'consent_required' THEN
    RAISE EXCEPTION 'old RPC changed state for a non-owner: %', result;
  END IF;
  RESET ROLE;

  -- ── 3. Refresh adds revisions to a shared row ──
  PERFORM pg_temp.claims(user_1,'authenticated');
  UPDATE public.reference_measurement_sets
     SET raw_text='8–11 × 5–6 µm',length_core_max=11,revision=2,row_version=row_version+1
   WHERE user_id=user_1 AND id=set_1;
  SELECT current_revision INTO v_rev FROM private.shared_reference_contributions WHERE id=contribution_1;
  IF (SELECT item->'snapshot'->>'raw_text' FROM public.get_public_reference_contribution_v2(contribution_1,v_rev) item)
        <> '8–11 × 5–6 µm'
     OR (SELECT item FROM public.get_public_reference_contribution_v2(contribution_1,(first_envelope->>'revision')::integer) item)
        IS DISTINCT FROM first_envelope THEN
    RAISE EXCEPTION 'consented refresh did not publish a new revision or rewrote history';
  END IF;
  -- Oversized or unprojectable sources are not published and never block sync.
  UPDATE public.reference_works
     SET title=repeat('x',513),authors_json='[]',year=NULL,revision=2,row_version=row_version+1
   WHERE user_id=user_1 AND id='71000000-0000-4000-8000-000000000001';
  IF (SELECT current_revision FROM private.shared_reference_contributions WHERE id=contribution_1) <> v_rev THEN
    RAISE EXCEPTION 'oversized fallback label was published';
  END IF;
  UPDATE public.reference_works
     SET title='Independent interpretation one, repaired',authors_json='[{"family":"Smith"}]',
         year=1998,revision=3,row_version=row_version+1
   WHERE user_id=user_1 AND id='71000000-0000-4000-8000-000000000001';
  IF (SELECT current_revision FROM private.shared_reference_contributions WHERE id=contribution_1) <> v_rev + 1 THEN
    RAISE EXCEPTION 'valid source repair did not refresh the contribution';
  END IF;
  IF (SELECT count(*) FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id=contribution_1 AND r.envelope_json->'contributor'->'id' <> 'null'::jsonb) <> 0 THEN
    RAISE EXCEPTION 'a new revision carries a contributor id';
  END IF;

  -- ── 4. Another qualifying use keeps the row backed ──
  v_after := pg_temp.last_event_id();
  UPDATE public.observations SET is_draft=true WHERE id=940000003;
  UPDATE public.observations SET is_draft=false WHERE id=940000003;
  PERFORM pg_temp.claims(NULL,'service_role');
  UPDATE public.observation_reference_uses SET deleted_at=now() WHERE id=use_3;
  -- The private observation's use never backed it; detach it too so the
  -- reasons below are unambiguous.
  UPDATE public.observation_reference_uses SET deleted_at=now()
   WHERE id='74000000-0000-4000-8000-000000000004';
  IF (SELECT status FROM private.shared_reference_contributions WHERE id=contribution_1) <> 'shared'
     OR pg_temp.last_event_id() <> v_after THEN
    RAISE EXCEPTION 'a still-backed contribution was withdrawn';
  END IF;

  -- ── 5. Every loss of the qualifying use withdraws, for every caller ──
  -- Each case: act, assert withdrawn with one exact event, restore, then an
  -- owner source edit and use sync. Changed meaning (2d): the restored
  -- qualifying use re-shares automatically (one shared_automatically event)
  -- in a new sharing period, so revisions from before the withdrawal stay
  -- unserved.
  FOR v_case IN
    SELECT * FROM (VALUES
      (1,'draft flip','owner',
       'UPDATE public.observations SET is_draft=true WHERE id=940000001',
       'UPDATE public.observations SET is_draft=false WHERE id=940000001',
       'observation_not_public'),
      (2,'visibility to friends','owner',
       'UPDATE public.observations SET visibility=''friends'' WHERE id=940000001',
       'UPDATE public.observations SET visibility=''public'' WHERE id=940000001',
       'observation_not_public'),
      (3,'spore data private','owner',
       'UPDATE public.observations SET spore_data_visibility=''private'' WHERE id=940000001',
       'UPDATE public.observations SET spore_data_visibility=''public'' WHERE id=940000001',
       'observation_not_public'),
      (4,'moderation hide (service role)','service',
       'UPDATE public.observations SET visibility=''private'',spore_data_visibility=''private'' WHERE id=940000001',
       'UPDATE public.observations SET visibility=''public'',spore_data_visibility=''public'' WHERE id=940000001',
       'observation_not_public'),
      (5,'service-role detach','service',
       'UPDATE public.observation_reference_uses SET deleted_at=now() WHERE id=''74000000-0000-4000-8000-000000000001''',
       'UPDATE public.observation_reference_uses SET deleted_at=NULL WHERE id=''74000000-0000-4000-8000-000000000001''',
       'use_detached'),
      (6,'set deleted_at only, no user','none',
       'UPDATE public.reference_measurement_sets SET deleted_at=now() WHERE id=''73000000-0000-4000-8000-000000000001''',
       'UPDATE public.reference_measurement_sets SET deleted_at=NULL WHERE id=''73000000-0000-4000-8000-000000000001''',
       'source_deleted'),
      (7,'treatment deleted_at only, service role','service',
       'UPDATE public.reference_taxon_treatments SET deleted_at=now() WHERE id=''72000000-0000-4000-8000-000000000001''',
       'UPDATE public.reference_taxon_treatments SET deleted_at=NULL WHERE id=''72000000-0000-4000-8000-000000000001''',
       'source_deleted'),
      (8,'work deleted_at only, no user','none',
       'UPDATE public.reference_works SET deleted_at=now() WHERE id=''71000000-0000-4000-8000-000000000001''',
       'UPDATE public.reference_works SET deleted_at=NULL WHERE id=''71000000-0000-4000-8000-000000000001''',
       'source_deleted'),
      (9,'taxon change (service role)','service',
       'UPDATE public.observations SET resolved_sporely_taxon_id=2100000902 WHERE id=940000001',
       'UPDATE public.observations SET resolved_sporely_taxon_id=2100000901 WHERE id=940000001',
       'taxon_changed')
    ) AS c(n,label,caller,act,restore,reason)
    ORDER BY n
  LOOP
    -- The public read wrappers are rate limited; this loop reads a lot.
    DELETE FROM private.shared_reference_rate_buckets;
    PERFORM pg_temp.claims(
      CASE WHEN v_case.caller='owner' THEN user_1 END,
      CASE v_case.caller WHEN 'owner' THEN 'authenticated' WHEN 'service' THEN 'service_role' END);
    v_after := pg_temp.last_event_id();
    SELECT current_revision INTO v_rev_before FROM private.shared_reference_contributions WHERE id=contribution_1;
    EXECUTE v_case.act;
    PERFORM pg_temp.assert_withdrawn(v_case.label, contribution_1,
      'withdrawn_by_system:'||v_case.reason, v_after);
    EXECUTE v_case.restore;
    PERFORM pg_temp.claims(user_1,'authenticated');
    UPDATE public.reference_measurement_sets SET revision=revision+1,row_version=row_version+1
     WHERE user_id=user_1 AND id=set_1;
    UPDATE public.observation_reference_uses SET snapshot_json=snapshot_json WHERE id=use_1;
    PERFORM pg_temp.claims(NULL,NULL);
    SELECT current_revision INTO v_rev FROM private.shared_reference_contributions WHERE id=contribution_1;
    SELECT array_agg(e.event ORDER BY e.id) INTO v_events
      FROM private.shared_reference_consent_events e
     WHERE e.contribution_id=contribution_1 AND e.id>v_after;
    IF (SELECT status||':'||share_basis||':'||shared_first_revision
          FROM private.shared_reference_contributions WHERE id=contribution_1)
         IS DISTINCT FROM 'shared:automatic:'||(v_rev_before+1)
       OR v_events IS DISTINCT FROM ARRAY['withdrawn_by_system','shared_automatically']
       OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(contribution_1,v_rev_before))
       OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(contribution_1,1))
       OR NOT EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(contribution_1,v_rev))
       OR (SELECT (item->>'revision')::integer FROM public.search_public_reference_contributions_v2(
             taxon_id,50,NULL,NULL) item WHERE item->>'contribution_id'=contribution_1::text) <> v_rev THEN
      RAISE EXCEPTION '%: restore did not re-share in a new sharing period: % % % %',
        v_case.label, v_events, v_rev_before, v_rev,
        (SELECT to_jsonb(c) FROM private.shared_reference_contributions c WHERE id=contribution_1);
    END IF;
  END LOOP;

  DELETE FROM private.shared_reference_rate_buckets;
  -- ── 6. Hard-deleting the observation withdraws (cascaded use delete) ──
  PERFORM pg_temp.claims(NULL,NULL);
  SELECT id INTO contribution_2 FROM private.shared_reference_contributions
   WHERE owner_id=user_2 AND source_measurement_set_id=set_2 AND sporely_taxon_id=taxon_id AND status='shared';
  v_after := pg_temp.last_event_id();
  PERFORM pg_temp.claims(user_2,'authenticated');
  DELETE FROM public.observations WHERE id=940000002 AND user_id=user_2;
  PERFORM pg_temp.assert_withdrawn('observation delete', contribution_2,
    'withdrawn_by_system:use_detached', v_after);

  -- ── 7. Stop sharing sticks; consent-only checks bind consented rows only ──
  PERFORM pg_temp.claims(user_1,'authenticated');
  v_after := pg_temp.last_event_id();
  SET LOCAL ROLE authenticated;
  result := public.withdraw_reference_contribution(contribution_1);
  RESET ROLE;
  PERFORM pg_temp.assert_withdrawn('owner withdrawal', contribution_1,'withdrawn_by_owner:owner', v_after);
  -- The released per-contribution RPC stopped the whole set: an opt-out.
  IF NOT private.reference_set_opted_out(user_1,set_1) THEN
    RAISE EXCEPTION 'owner withdrawal did not record an opt-out for the set';
  END IF;
  -- Stickiness: owner source edit, use sync, visibility round trip and a
  -- direct refresh / grant all leave it withdrawn.
  v_after := pg_temp.last_event_id();
  UPDATE public.reference_measurement_sets SET revision=revision+1,row_version=row_version+1
   WHERE user_id=user_1 AND id=set_1;
  UPDATE public.observation_reference_uses SET snapshot_json=snapshot_json WHERE id=use_1;
  UPDATE public.observations SET is_draft=true WHERE id=940000001;
  UPDATE public.observations SET is_draft=false WHERE id=940000001;
  PERFORM pg_temp.claims(NULL,NULL);
  IF (private.share_reference_contribution_for_owner(user_1,set_1,taxon_id,1,1,1)->>'status') <> 'opted_out'
     OR (pg_temp.fixture_grant(user_1,set_1,taxon_id)->>'status') <> 'opted_out'
     OR (SELECT status FROM private.shared_reference_contributions WHERE id=contribution_1) <> 'withdrawn'
     OR pg_temp.last_event_id() <> v_after THEN
    RAISE EXCEPTION 'an opted-out set was re-shared';
  END IF;
  -- Share again re-shares at once.
  IF private.share_reference_set_again_for_owner(user_1,set_1) <> 'updated'
     OR (SELECT status||':'||share_basis FROM private.shared_reference_contributions WHERE id=contribution_1)
        <> 'shared:automatic' THEN
    RAISE EXCEPTION 'share again did not re-share';
  END IF;
  -- A consented row (grant on the automatic row) keeps the consent scope.
  result := pg_temp.fixture_grant(user_1,set_1,taxon_id,'nb');
  IF result->>'status' NOT IN ('updated','no_change')
     OR (SELECT share_basis FROM private.shared_reference_contributions WHERE id=contribution_1) <> 'consented'
     OR (SELECT consent_scope FROM private.shared_reference_contributions WHERE id=contribution_1)
        <> '{"snapshot_schema_versions":[1],"data_kinds":["free_text"]}'::jsonb THEN
    RAISE EXCEPTION 'narrow-scope fixture grant failed: %', result;
  END IF;
  v_after := pg_temp.last_event_id();
  PERFORM pg_temp.claims(user_1,'authenticated');
  UPDATE public.reference_measurement_sets
     SET raw_points_json='[{"length":8.2,"width":5.1,"q":1.61}]',revision=revision+1,row_version=row_version+1
   WHERE user_id=user_1 AND id=set_1;
  PERFORM pg_temp.assert_withdrawn('consent scope exceeded', contribution_1,
    'withdrawn_by_system:consent_scope_exceeded', v_after);
  -- A grant whose content exceeds the text's scope is refused and changes nothing.
  PERFORM pg_temp.claims(NULL,NULL);
  v_after := pg_temp.last_event_id();
  result := pg_temp.fixture_grant(user_1,set_1,taxon_id,'nb');
  IF result->>'status' <> 'consent_scope_exceeded'
     OR (SELECT status FROM private.shared_reference_contributions WHERE id=contribution_1) <> 'withdrawn'
     OR pg_temp.last_event_id() <> v_after THEN
    RAISE EXCEPTION 'grant beyond the consent text scope was not refused: %', result;
  END IF;
  -- Changed meaning (2d): refresh re-shares the system-withdrawn row as
  -- automatic (never consented), and an automatic row is never withdrawn as
  -- consent_scope_exceeded or consent_text_revoked.
  v_after := pg_temp.last_event_id();
  IF (private.share_reference_contribution_for_owner(user_1,set_1,taxon_id,1,1,1)->>'status') <> 'updated'
     OR (SELECT status||':'||share_basis FROM private.shared_reference_contributions WHERE id=contribution_1)
        <> 'shared:automatic'
     OR (SELECT consented_at FROM private.shared_reference_contributions WHERE id=contribution_1) IS NOT NULL
     OR (private.reference_contribution_share_core('refresh',user_1,set_1,other_taxon_id)->>'status') <> 'qualifying_use_required'
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions
                 WHERE sporely_taxon_id=other_taxon_id AND status='shared') THEN
    RAISE EXCEPTION 'refresh did not re-share as automatic, or created a row without a qualifying use';
  END IF;
  PERFORM private.revoke_reference_share_consent_text(1,'nb');
  PERFORM pg_temp.claims(user_1,'authenticated');
  UPDATE public.reference_measurement_sets
     SET raw_points_json='[{"length":8.3,"width":5.2,"q":1.6}]',revision=revision+1,row_version=row_version+1
   WHERE user_id=user_1 AND id=set_1;
  PERFORM pg_temp.claims(NULL,NULL);
  IF (SELECT status FROM private.shared_reference_contributions WHERE id=contribution_1) <> 'shared'
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events e
                 WHERE e.id>v_after AND e.reason IN ('consent_scope_exceeded','consent_text_revoked')) THEN
    RAISE EXCEPTION 'an automatic row was withdrawn by a consent-only check';
  END IF;
  -- Grant requires an active, unrevoked text version and a qualifying use.
  UPDATE private.reference_share_consent_texts SET active=false WHERE locale='en';
  IF (pg_temp.fixture_grant(user_1,set_1,taxon_id)->>'status') <> 'consent_text_unavailable' THEN
    RAISE EXCEPTION 'grant accepted an inactive consent text';
  END IF;
  UPDATE private.reference_share_consent_texts SET active=true WHERE locale='en';
  IF (pg_temp.fixture_grant(user_1,set_1,other_taxon_id)->>'status') <> 'qualifying_use_required' THEN
    RAISE EXCEPTION 'grant accepted a taxon without a qualifying use';
  END IF;

  -- ── 8. Owner withdrawal RPC and the unchanged tombstone stub ──
  UPDATE public.reference_measurement_sets SET raw_points_json=NULL,revision=revision+1,row_version=row_version+1
   WHERE user_id=user_1 AND id=set_1;
  result := private.share_reference_contribution_for_owner(user_1,set_1,taxon_id,1,1,1);
  SELECT current_revision INTO v_rev FROM private.shared_reference_contributions WHERE id=contribution_1;
  PERFORM pg_temp.claims(user_2,'authenticated');
  SET LOCAL ROLE authenticated;
  IF (public.withdraw_reference_contribution(contribution_1)->>'status') <> 'forbidden' THEN
    RAISE EXCEPTION 'a non-owner could withdraw';
  END IF;
  RESET ROLE;
  PERFORM pg_temp.claims(user_1,'authenticated');
  SET LOCAL ROLE authenticated;
  IF (public.withdraw_reference_contribution(contribution_1)->>'status') <> 'updated'
     OR (public.withdraw_reference_contribution(contribution_1)->>'status') <> 'no_change'
     OR EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(taxon_id,50,NULL,NULL))
     OR (SELECT array_agg(k ORDER BY k) FROM public.get_public_reference_contribution(contribution_1,v_rev) item,
           jsonb_object_keys(item) k) <> ARRAY['contribution_id','revision','status','withdrawn_at']
     OR (SELECT item->>'status' FROM public.get_public_reference_contribution(contribution_1,1) item) <> 'withdrawn'
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution(contribution_1,NULL)) THEN
    RAISE EXCEPTION 'owner withdrawal lifecycle or tombstone stub changed';
  END IF;
  IF (public.share_reference_contribution(set_1,taxon_id,1,1,1)->>'status') <> 'consent_required' THEN
    RAISE EXCEPTION 'old RPC re-shared a withdrawn row';
  END IF;
  RESET ROLE;

  DELETE FROM private.shared_reference_rate_buckets;
  -- ── 9. Moderation hide is honoured, also against automatic re-sharing ──
  PERFORM pg_temp.claims(NULL,NULL);
  IF private.share_reference_set_again_for_owner(user_1,set_1) <> 'updated' THEN
    RAISE EXCEPTION 'share again after the withdrawal RPC failed';
  END IF;
  PERFORM pg_temp.claims(NULL,'service_role');
  SET LOCAL ROLE service_role;
  result := public.moderate_shared_reference_contribution(contribution_1,'hide','privacy');
  RESET ROLE;
  IF result->>'status' <> 'updated'
     OR EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(taxon_id,50,NULL,NULL))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(contribution_1,NULL)) THEN
    RAISE EXCEPTION 'hidden contribution remained public';
  END IF;
  -- A hidden row withdrawn by the system is not re-shared while hidden, and
  -- hidden_at is kept.
  PERFORM private.withdraw_shared_reference_contribution(contribution_1,'use_detached');
  IF (private.share_reference_contribution_for_owner(user_1,set_1,taxon_id,1,1,1)->>'status') <> 'moderation_hidden'
     OR (SELECT status FROM private.shared_reference_contributions WHERE id=contribution_1) <> 'withdrawn'
     OR (SELECT hidden_at FROM private.shared_reference_contributions WHERE id=contribution_1) IS NULL THEN
    RAISE EXCEPTION 'a hidden contribution was re-shared';
  END IF;
  SET LOCAL ROLE service_role;
  result := public.moderate_shared_reference_contribution(contribution_1,'restore',NULL);
  RESET ROLE;
  result := private.share_reference_contribution_for_owner(user_1,set_1,taxon_id,1,1,1);
  IF NOT EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(taxon_id,50,NULL,NULL)) THEN
    RAISE EXCEPTION 'restore and refresh did not serve the contribution again: %', result;
  END IF;

  -- ── 10. CHECK invariants ──
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared');
    RAISE EXCEPTION 'a shared row without a share basis was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,withdrawn_at,consented_at,consent_version,consent_first_revision,consent_scope)
    VALUES (user_2,gen_random_uuid(),taxon_id,'withdrawn',now(),now(),1,1,
      '{"snapshot_schema_versions":[1],"data_kinds":[]}');
    RAISE EXCEPTION 'a withdrawn row keeping consent was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,consented_at,consent_version)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared',now(),1);
    RAISE EXCEPTION 'a partial consent record was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,consented_at,consent_version,consent_first_revision,consent_scope)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared',now(),1,1,
      '{"snapshot_schema_versions":[1],"data_kinds":[]}');
    RAISE EXCEPTION 'a consent record without consent_locale was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,withdrawn_at,consent_client)
    VALUES (user_2,gen_random_uuid(),taxon_id,'withdrawn',now(),'desktop');
    RAISE EXCEPTION 'a consent client without consent was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,consented_at,consent_version,consent_locale,consent_first_revision,consent_scope)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared',now(),1,'en',1,'{"data_kinds":["everything"]}');
    RAISE EXCEPTION 'an invalid consent scope was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.shared_reference_contributions SET status='withdrawn',withdrawn_at=now()
     WHERE id=contribution_1;
    RAISE EXCEPTION 'a withdrawal that bypasses the helper kept consent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,share_basis,shared_first_revision,consented_at,consent_version,consent_locale,consent_first_revision,consent_scope)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared','automatic',1,now(),1,'en',1,
      '{"snapshot_schema_versions":[1],"data_kinds":[]}');
    RAISE EXCEPTION 'an automatic row with a consent record was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,share_basis,shared_first_revision)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared','consented',1);
    RAISE EXCEPTION 'a consented row without a consent record was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,share_basis)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared','automatic');
    RAISE EXCEPTION 'a shared row without a sharing period was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,current_revision,share_basis,shared_first_revision)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared',1,'automatic',2);
    RAISE EXCEPTION 'a sharing period beyond the current revision was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,withdrawn_at,share_basis)
    VALUES (user_2,gen_random_uuid(),taxon_id,'withdrawn',now(),'automatic');
    RAISE EXCEPTION 'a withdrawn row keeping a share basis was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,
      status,share_basis,shared_first_revision)
    VALUES (user_2,gen_random_uuid(),taxon_id,'shared','manual',1);
    RAISE EXCEPTION 'an unknown share basis was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason)
    VALUES (contribution_1,'shared_automatically','owner');
    RAISE EXCEPTION 'a shared_automatically event with a reason was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.shared_reference_consent_events(contribution_id,event,consent_version)
    VALUES (contribution_1,'shared_automatically',1);
    RAISE EXCEPTION 'a shared_automatically event with a consent version was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.shared_reference_consent_events SET reason='owner';
    RAISE EXCEPTION 'consent events were updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM private.shared_reference_consent_events;
    RAISE EXCEPTION 'consent events were deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM private.withdraw_shared_reference_contribution(contribution_1,'because');
    RAISE EXCEPTION 'an unknown withdrawal reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  v_after := pg_temp.last_event_id();
  IF private.withdraw_shared_reference_contribution(contribution_2,'owner') IS NOT FALSE
     OR pg_temp.last_event_id() <> v_after THEN
    RAISE EXCEPTION 'withdrawing an already withdrawn row wrote an event';
  END IF;

  -- ── 11. Account deletion withdraws through the helper, anonymises and
  -- removes the owner's opt-outs (ON DELETE CASCADE) ──
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id)
  VALUES (user_1,gen_random_uuid());
  v_after := pg_temp.last_event_id();
  DELETE FROM public.profiles WHERE id=user_1;
  IF EXISTS (SELECT 1 FROM private.reference_share_opt_outs WHERE owner_id=user_1) THEN
    RAISE EXCEPTION 'account deletion left opt-outs behind';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM private.shared_reference_contributions c
        WHERE c.id=contribution_1 AND c.owner_id IS NULL AND c.source_measurement_set_id IS NULL
          AND c.status='withdrawn' AND c.consented_at IS NULL
     ) OR EXISTS (
       SELECT 1 FROM private.shared_reference_contribution_revisions r
        WHERE r.contribution_id=contribution_1
          AND (r.envelope_json->'contributor'->'id' <> 'null'::jsonb
               OR r.envelope_json->'contributor'->>'label' <> 'Deleted user')
     ) THEN
    RAISE EXCEPTION 'account deletion did not withdraw and anonymise';
  END IF;
  IF (SELECT array_agg(e.event||':'||e.reason) FROM private.shared_reference_consent_events e
       WHERE e.id > v_after) IS DISTINCT FROM ARRAY['withdrawn_by_system:account_deleted'] THEN
    RAISE EXCEPTION 'account deletion did not record exactly one account_deleted event';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='private' AND table_name='shared_reference_consent_events'
       AND column_name ~ 'owner|user'
  ) THEN
    RAISE EXCEPTION 'the consent event log holds an account id';
  END IF;
END
$$;

-- ── 12. Execution surface ──
DO $$
DECLARE
  v_role text;
  v_fn regprocedure;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role','public'] LOOP
    FOR v_fn IN
      SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='private' AND p.proname IN (
         'reference_contribution_share_core','share_reference_contribution_for_owner',
         'reference_set_has_qualifying_use','reference_qualifying_use_ids',
         'withdraw_shared_reference_contribution','withdraw_unqualified_contributions',
         'lock_shared_reference_key','reference_share_scope_valid',
         'reference_share_snapshot_scope','reference_share_scope_within',
         'withdraw_shared_references_for_observation','reject_shared_reference_consent_event_change',
         'shared_reference_contribution_envelope','refresh_shared_reference_for_use_row',
         'refresh_shared_reference_for_use','refresh_shared_references_for_measurement_set',
         'refresh_shared_references_for_parent','refresh_shared_references_for_observation_taxon',
         'anonymize_shared_reference_contributions_for_profile',
         '_taxon_identity_repair_reconcile_references',
         'withdraw_contribution_if_unpublishable',
         'share_reference_contribution_with_consent_unthrottled',
         'list_my_shared_reference_contributions_unthrottled',
         'get_reference_share_consent_text_unthrottled',
         'reference_consent_text_revoked','revoke_reference_share_consent_text',
         'reference_set_opted_out','reference_set_has_hidden_contribution',
         'observation_reference_use_is_served','reference_set_belongs_to',
         'stop_sharing_reference_set_for_owner','share_reference_set_again_for_owner',
         'stop_sharing_reference_set_unthrottled','share_reference_set_again_unthrottled',
         'list_my_reference_sharing_unthrottled')
    LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'role % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role,'public.share_reference_contribution_unthrottled(uuid,integer,integer,integer,integer)','EXECUTE')
       OR has_function_privilege(v_role,'public.withdraw_reference_contribution_unthrottled(uuid)','EXECUTE')
       OR has_function_privilege(v_role,'public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid)','EXECUTE')
       OR has_function_privilege(v_role,'public.get_public_reference_contribution_unthrottled(uuid,integer)','EXECUTE')
       OR has_table_privilege(v_role,'private.shared_reference_consent_events','SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(v_role,'private.reference_share_consent_texts','SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(v_role,'private.shared_reference_contributions','SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(v_role,'private.shared_reference_contribution_revisions','SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege(v_role,'private.reference_share_opt_outs','SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'role % reaches a private shared-reference object', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon','public.share_reference_contribution(uuid,integer,integer,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.search_public_reference_contributions(integer,integer,timestamptz,uuid)','EXECUTE')
     OR has_function_privilege('authenticated','public.moderate_shared_reference_contribution(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'shared contribution least-privilege grants are incorrect';
  END IF;
  -- 2b: exactly two public consent RPCs (grant, consent text) plus the
  -- owner list; authenticated only, never anon, service_role or PUBLIC.
  IF (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.proname)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND (p.proname ~ 'consent' OR p.proname ~ '^list_my_shared'))
     IS DISTINCT FROM ARRAY[
       'get_reference_share_consent_text(text)',
       'list_my_shared_reference_contributions()',
       'share_reference_contribution_with_consent(uuid,integer,integer,integer,integer,integer,text,text)'] THEN
    RAISE EXCEPTION '2b public consent surface changed';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','service_role','public'] LOOP
    IF has_function_privilege(v_role,'public.share_reference_contribution_with_consent(uuid,integer,integer,integer,integer,integer,text,text)','EXECUTE')
       OR has_function_privilege(v_role,'public.list_my_shared_reference_contributions()','EXECUTE')
       OR has_function_privilege(v_role,'public.get_reference_share_consent_text(text)','EXECUTE') THEN
      RAISE EXCEPTION 'role % can execute a 2b owner RPC', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated','public.share_reference_contribution_with_consent(uuid,integer,integer,integer,integer,integer,text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.list_my_shared_reference_contributions()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_reference_share_consent_text(text)','EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname,p.proname) IN (
          ('public','share_reference_contribution_with_consent'),
          ('public','list_my_shared_reference_contributions'),
          ('public','get_reference_share_consent_text'),
          ('private','share_reference_contribution_with_consent_unthrottled'),
          ('private','list_my_shared_reference_contributions_unthrottled'),
          ('private','get_reference_share_consent_text_unthrottled'))
          AND (pg_get_userbyid(p.proowner) <> 'postgres'
               OR NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false)
               OR (n.nspname='public') <> p.prosecdef)
     ) THEN
    RAISE EXCEPTION '2b owner RPCs: grants, owner, search_path or SECURITY DEFINER wrong';
  END IF;
  -- 2d: three set-keyed owner RPCs, authenticated only, definer wrappers
  -- with an empty search_path over postgres-owned bodies; the opt-out table
  -- has RLS on.
  FOREACH v_role IN ARRAY ARRAY['anon','service_role','public'] LOOP
    IF has_function_privilege(v_role,'public.stop_sharing_reference_set(uuid)','EXECUTE')
       OR has_function_privilege(v_role,'public.share_reference_set_again(uuid)','EXECUTE')
       OR has_function_privilege(v_role,'public.list_my_reference_sharing()','EXECUTE') THEN
      RAISE EXCEPTION 'role % can execute a 2d owner RPC', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated','public.stop_sharing_reference_set(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.share_reference_set_again(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.list_my_reference_sharing()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.withdraw_reference_contribution(uuid)','EXECUTE')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.reference_share_opt_outs'::regclass)
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='private.reference_share_opt_outs'::regclass)) <> 'postgres'
     OR EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname,p.proname) IN (
          ('public','stop_sharing_reference_set'),('public','share_reference_set_again'),
          ('public','list_my_reference_sharing'),
          ('private','stop_sharing_reference_set_unthrottled'),('private','share_reference_set_again_unthrottled'),
          ('private','list_my_reference_sharing_unthrottled'),('private','stop_sharing_reference_set_for_owner'),
          ('private','share_reference_set_again_for_owner'),('private','observation_reference_use_is_served'),
          ('private','reference_set_opted_out'),('private','reference_set_has_hidden_contribution'),
          ('private','reference_set_belongs_to'))
          AND (pg_get_userbyid(p.proowner) <> 'postgres'
               OR NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false)
               OR (n.nspname='public') <> p.prosecdef)
     ) THEN
    RAISE EXCEPTION '2d owner RPCs: grants, owner, search_path, SECURITY DEFINER or RLS wrong';
  END IF;
  -- The observation delete trigger is gone; the cascaded use delete covers it.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='observation_delete_shared_contribution_trg') THEN
    RAISE EXCEPTION 'redundant observation delete trigger still exists';
  END IF;
  -- New helpers: owned by postgres, empty search_path.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='private' AND p.proname IN (
         'reference_contribution_share_core','reference_set_has_qualifying_use',
         'reference_qualifying_use_ids','withdraw_shared_reference_contribution',
         'withdraw_unqualified_contributions','lock_shared_reference_key',
         'reference_share_scope_valid','reference_share_snapshot_scope',
         'reference_share_scope_within','withdraw_shared_references_for_observation',
         'reject_shared_reference_consent_event_change','withdraw_contribution_if_unpublishable')
       AND (pg_get_userbyid(p.proowner) <> 'postgres'
            OR NOT coalesce(p.proconfig @> ARRAY['search_path=""'],false))
  ) OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='private' AND p.proname IN (
         'reference_contribution_share_core','reference_set_has_qualifying_use',
         'reference_qualifying_use_ids','withdraw_shared_reference_contribution',
         'withdraw_unqualified_contributions','lock_shared_reference_key',
         'reference_share_scope_valid','reference_share_snapshot_scope',
         'reference_share_scope_within','withdraw_shared_references_for_observation',
         'reject_shared_reference_consent_event_change','withdraw_contribution_if_unpublishable')) <> 13 THEN
    RAISE EXCEPTION 'new private helpers are not owned by postgres with an empty search_path';
  END IF;
END
$$;

ROLLBACK;

-- Outside the fixture transaction: 2b ships consent text version 1 in en and
-- nb, INACTIVE (activation is a separate owner-approved step), and no shared
-- row without a share basis (2d: automatic rows have no consent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM private.reference_share_consent_texts WHERE active OR revoked)
     OR (SELECT array_agg(version||':'||locale ORDER BY locale) FROM private.reference_share_consent_texts)
        IS DISTINCT FROM ARRAY['1:en','1:nb']
     OR EXISTS (SELECT 1 FROM private.reference_share_consent_texts
                 WHERE scope <> '{"snapshot_schema_versions":[1],"data_kinds":["raw_points","free_text","measurement_details"]}'::jsonb
                    OR text_sha256 <> encode(sha256(convert_to(text,'UTF8')),'hex'))
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions
                 WHERE status='shared' AND share_basis IS NULL) THEN
    RAISE EXCEPTION '2b must ship exactly the inactive v1 en/nb texts and no unconsented share';
  END IF;
END
$$;
