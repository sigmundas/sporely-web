-- Stage 2c candidate 1 (20261001091940_add_reference_contribution_relationship_roles.sql):
-- the "is served" check, public relationship roles, the _v2 reads, today's
-- restricted reads, the execution surface and the consent text v1 edit.
-- Stage 2d (20261001113007): roles come from exactly the uses
-- search_public_observation_references serves for the contribution's
-- (owner, set, taxon); the content proof is gone, so a use whose frozen
-- snapshot matches no shared revision now counts (changed meaning: 940000308
-- contributes 'compared'). The is-served check uses the share basis and
-- sharing period instead of consent.
-- Run after local migrations with psql; every transaction is rolled back.

BEGIN;

CREATE FUNCTION pg_temp.claims(p_sub uuid, p_role text) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_role IS NULL THEN ''
         ELSE json_build_object('sub',p_sub::text,'role',p_role)::text END, true)
$$;

CREATE FUNCTION pg_temp.fixture_grant(p_owner uuid, p_set uuid, p_taxon integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT w.revision AS w, t.revision AS t, m.revision AS m INTO r
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
   WHERE m.user_id=p_owner AND m.id=p_set;
  RETURN private.reference_contribution_share_core(
    'grant',p_owner,p_set,p_taxon,r.w,r.t,r.m,1,'en','fixture');
END
$$;

-- The roles the observation-reference read serves for (owner's) observations.
CREATE FUNCTION pg_temp.served_observation_roles(p_ids bigint[]) RETURNS text[]
LANGUAGE sql AS $$
  SELECT coalesce(array_agg(DISTINCT x->>'role' ORDER BY x->>'role'), '{}')
    FROM public.search_public_observation_references(p_ids) o,
         jsonb_array_elements(o."references") x
$$;

-- relationship_roles of the contribution in both _v2 reads; both must agree
-- with the helper.
CREATE FUNCTION pg_temp.v2_roles(p_id uuid, p_taxon integer) RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE v_search jsonb; v_get jsonb; v_helper text[];
BEGIN
  DELETE FROM private.shared_reference_rate_buckets;
  SELECT i INTO v_search FROM public.search_public_reference_contributions_v2(p_taxon,100,NULL,NULL) i
   WHERE i->>'contribution_id'=p_id::text;
  SELECT i INTO v_get FROM public.get_public_reference_contribution_v2(p_id,NULL) i;
  v_helper := private.reference_contribution_public_roles(p_id);
  IF v_search->'relationship_roles' IS DISTINCT FROM to_jsonb(v_helper)
     OR v_get->'relationship_roles' IS DISTINCT FROM to_jsonb(v_helper) THEN
    RAISE EXCEPTION 'v2 roles disagree with the helper: search % get % helper %',
      v_search->'relationship_roles', v_get->'relationship_roles', v_helper;
  END IF;
  RETURN v_helper;
END
$$;

-- ── A. Roles: only uses the observation-reference read serves contribute ──
DO $$
DECLARE
  owner_1 constant uuid := '00000000-0000-4000-8000-00000000e301';
  viewer constant uuid := '00000000-0000-4000-8000-00000000e302';
  t constant integer := 2100000981;
  t_other constant integer := 2100000982;
  w constant uuid := '71000000-0000-4000-8000-00000000e301';
  tr constant uuid := '72000000-0000-4000-8000-00000000e301';
  s constant uuid := '73000000-0000-4000-8000-00000000e301';
  -- The observations of the contribution's taxon (940000307 is another
  -- taxon: served on its observation page, but not this contribution's role).
  obs constant bigint[] := ARRAY[940000301,940000302,940000303,940000304,940000305,940000306,940000308]::bigint[];
  v_snap jsonb;
  v_id uuid;
  v_roles text[];
  r jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_1,'authenticated','authenticated','roles-owner@example.invalid','{}',now(),now()),
    (viewer,'authenticated','authenticated','roles-viewer@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,display_name,is_banned) VALUES
    (owner_1,'roles_owner','Roles Owner',false),(viewer,'roles_viewer','Roles Viewer',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (t,'Amanita rolesiana','species','include','in_cache','roles-test'),
           (t_other,'Amanita altera','species','include','in_cache','roles-test');
  DELETE FROM private.reference_share_consent_texts;
  INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope) VALUES
    (1,'en','fixture consent text',encode(sha256(convert_to('fixture consent text','UTF8')),'hex'),true,
     '{"snapshot_schema_versions":[1,2],"data_kinds":["raw_points","free_text","measurement_details"]}');
  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (940000301,owner_1,current_date,'public',false,'public',t),     -- contradicts, served
    (940000302,owner_1,current_date,'public',false,'public',t),     -- supports, served
    (940000303,owner_1,current_date,'private',false,'public',t),    -- compared, private
    (940000304,owner_1,current_date,'public',true,'public',t),      -- compared, draft
    (940000305,owner_1,current_date,'public',false,'private',t),    -- compared, private spore data
    (940000306,owner_1,current_date,'public',false,'public',t),     -- compared, deleted use
    (940000307,owner_1,current_date,'public',false,'public',t_other), -- compared, other taxon
    (940000308,owner_1,current_date,'public',false,'public',t);     -- compared, matches no shared revision
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (owner_1,w,'article','[{"family":"Roles"}]','Roles of a reference',2001,'Roles 2001',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (owner_1,tr,w,'local-r','Amanita rolesiana',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES (owner_1,s,tr,'spore_size','8-10 x 5-6 um','range',8,10,5,6,1);
  v_snap := private.reference_canonical_snapshot(owner_1,s);
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json,deleted_at
  ) VALUES
    (owner_1,'74000000-0000-4000-8000-00000000e301',940000301,s,'contradicts',1,v_snap,NULL),
    (owner_1,'74000000-0000-4000-8000-00000000e303',940000303,s,'compared',1,v_snap,NULL),
    (owner_1,'74000000-0000-4000-8000-00000000e304',940000304,s,'compared',1,v_snap,NULL),
    (owner_1,'74000000-0000-4000-8000-00000000e305',940000305,s,'compared',1,v_snap,NULL),
    (owner_1,'74000000-0000-4000-8000-00000000e306',940000306,s,'compared',1,v_snap,now()),
    (owner_1,'74000000-0000-4000-8000-00000000e307',940000307,s,'compared',1,v_snap,NULL);

  PERFORM pg_temp.claims(NULL,NULL);
  r := pg_temp.fixture_grant(owner_1,s,t);
  IF r->>'status' <> 'created' THEN RAISE EXCEPTION 'fixture grant failed: %', r; END IF;
  v_id := (r->'row'->>'contribution_id')::uuid;

  -- Only the contradicting use is visible; private, draft, private-spore,
  -- deleted and other-taxon uses contribute nothing.
  PERFORM pg_temp.claims(viewer,'authenticated');
  v_roles := pg_temp.v2_roles(v_id,t);
  IF v_roles IS DISTINCT FROM ARRAY['contradicts']
     OR pg_temp.served_observation_roles(obs) IS DISTINCT FROM v_roles THEN
    RAISE EXCEPTION 'roles (contradicts only) wrong: % / %', v_roles, pg_temp.served_observation_roles(obs);
  END IF;
  PERFORM pg_temp.claims(NULL,'anon');
  IF pg_temp.v2_roles(v_id,t) IS DISTINCT FROM ARRAY['contradicts'] THEN
    RAISE EXCEPTION 'anon roles differ';
  END IF;

  -- A second served use: all roles, sorted, live (no new revision, scope unchanged).
  PERFORM pg_temp.claims(owner_1,'authenticated');
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
  ) VALUES (owner_1,'74000000-0000-4000-8000-00000000e302',940000302,s,'supports_identification',1,v_snap);
  -- A use whose frozen snapshot matches no shared revision (served since 2d).
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
  ) VALUES (owner_1,'74000000-0000-4000-8000-00000000e308',940000308,s,'compared',1,
            jsonb_set(v_snap,'{raw_text}','"9-12 x 5-6 um"'));
  PERFORM pg_temp.claims(viewer,'authenticated');
  v_roles := pg_temp.v2_roles(v_id,t);
  IF v_roles IS DISTINCT FROM ARRAY['compared','contradicts','supports_identification']
     OR pg_temp.served_observation_roles(obs) IS DISTINCT FROM v_roles
     OR (SELECT current_revision FROM private.shared_reference_contributions WHERE id=v_id) <> 1 THEN
    RAISE EXCEPTION 'roles (two served uses) wrong: % / %', v_roles, pg_temp.served_observation_roles(obs);
  END IF;

  -- A role change is live.
  PERFORM pg_temp.claims(owner_1,'authenticated');
  UPDATE public.observation_reference_uses SET role='compared'
   WHERE id='74000000-0000-4000-8000-00000000e301';
  PERFORM pg_temp.claims(viewer,'authenticated');
  IF pg_temp.v2_roles(v_id,t) IS DISTINCT FROM ARRAY['compared','supports_identification'] THEN
    RAISE EXCEPTION 'role change not reflected live';
  END IF;

  -- The other-taxon observation is served on its own page but not counted.
  IF pg_temp.served_observation_roles(ARRAY[940000307]::bigint[]) IS DISTINCT FROM ARRAY['compared'] THEN
    RAISE EXCEPTION 'other-taxon observation reference not served';
  END IF;

  -- Only an observation of another taxon is left: still shared (the stale
  -- row stays until a refresh), roles [].
  PERFORM pg_temp.claims(owner_1,'authenticated');
  UPDATE public.observation_reference_uses SET deleted_at=now()
   WHERE id IN ('74000000-0000-4000-8000-00000000e301','74000000-0000-4000-8000-00000000e302',
                '74000000-0000-4000-8000-00000000e308');
  -- (Deleting the last same-taxon use withdraws; keep the row shared to test
  -- the empty-roles case.)
  PERFORM pg_temp.claims(NULL,NULL);
  IF (SELECT status FROM private.shared_reference_contributions WHERE id=v_id) <> 'withdrawn' THEN
    RAISE EXCEPTION 'losing the last qualifying use did not withdraw';
  END IF;
  ALTER TABLE private.shared_reference_contributions DISABLE TRIGGER USER;
  UPDATE private.shared_reference_contributions
     SET status='shared',withdrawn_at=NULL,share_basis='automatic',shared_first_revision=1
   WHERE id=v_id;
  ALTER TABLE private.shared_reference_contributions ENABLE TRIGGER USER;
  PERFORM pg_temp.claims(viewer,'authenticated');
  IF (SELECT status FROM private.shared_reference_contributions WHERE id=v_id) <> 'shared'
     OR NOT private.reference_contribution_is_served(v_id)
     OR pg_temp.v2_roles(v_id,t) IS DISTINCT FROM '{}'::text[]
     OR pg_temp.served_observation_roles(obs) IS DISTINCT FROM '{}'::text[] THEN
    RAISE EXCEPTION 'served contribution without a visible use did not return []';
  END IF;
  DELETE FROM private.shared_reference_rate_buckets;
  IF (SELECT i->'relationship_roles' FROM public.search_public_reference_contributions_v2(t,10,NULL,NULL) i)
       IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'relationship_roles is not the empty array';
  END IF;

  -- Roles and the observation read agree under an opt-out and a hide.
  UPDATE public.observation_reference_uses SET deleted_at=NULL
   WHERE id='74000000-0000-4000-8000-00000000e302';
  IF private.reference_contribution_public_roles(v_id) IS DISTINCT FROM ARRAY['supports_identification'] THEN
    RAISE EXCEPTION 'restored use not counted';
  END IF;
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id) VALUES (owner_1,s);
  IF private.reference_contribution_public_roles(v_id) IS DISTINCT FROM '{}'::text[]
     OR pg_temp.served_observation_roles(obs || 940000307::bigint) IS DISTINCT FROM '{}'::text[] THEN
    RAISE EXCEPTION 'an opted-out set has roles or observation references';
  END IF;
  DELETE FROM private.reference_share_opt_outs WHERE owner_id=owner_1;
  -- Unserved contributions have no roles.
  UPDATE private.shared_reference_contributions SET hidden_at=now(),hidden_reason='abuse' WHERE id=v_id;
  IF private.reference_contribution_public_roles(v_id) IS DISTINCT FROM '{}'::text[]
     OR pg_temp.served_observation_roles(obs || 940000307::bigint) IS DISTINCT FROM '{}'::text[]
     OR private.reference_contribution_public_roles(gen_random_uuid()) IS DISTINCT FROM '{}'::text[] THEN
    RAISE EXCEPTION 'a hidden or unknown contribution has roles, or its set is still on observations';
  END IF;
END
$$;

ROLLBACK;

-- ── B. Served-check agreement, unchanged get rules, restricted reads ──
BEGIN;

CREATE FUNCTION pg_temp.claims(p_sub uuid, p_role text) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_role IS NULL THEN ''
         ELSE json_build_object('sub',p_sub::text,'role',p_role)::text END, true)
$$;

CREATE FUNCTION pg_temp.seed(p_owner uuid, p_taxon integer, p_revisions integer, p_first integer,
                             p_age integer, p_pad integer DEFAULT 0) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO private.shared_reference_contributions(
    id,owner_id,source_measurement_set_id,sporely_taxon_id,status,current_revision,shared_at,
    share_basis,shared_first_revision,
    consented_at,consent_version,consent_locale,consent_first_revision,consent_scope)
  VALUES (v_id,p_owner,CASE WHEN p_owner IS NOT NULL THEN gen_random_uuid() END,p_taxon,'shared',
          p_revisions,now()-(p_age||' seconds')::interval,'consented',p_first,now(),1,'en',p_first,
          '{"snapshot_schema_versions":[1],"data_kinds":[]}');
  INSERT INTO private.shared_reference_contribution_revisions(
    contribution_id,revision,source_work_revision,source_treatment_revision,
    source_measurement_set_revision,content_hash,envelope_json)
  SELECT v_id,n,1,1,n,repeat('a',64),
         jsonb_build_object('contribution_id',v_id,'revision',n,'status','shared',
                            'pad',repeat('x',CASE WHEN n=p_revisions THEN p_pad ELSE 0 END))
    FROM generate_series(1,p_revisions) n;
  RETURN v_id;
END
$$;

CREATE FUNCTION pg_temp.agree(p_label text, p_id uuid, p_taxon integer, p_expect boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_served boolean; v_search boolean; v_get boolean;
BEGIN
  DELETE FROM private.shared_reference_rate_buckets;
  v_served := private.reference_contribution_is_served(p_id);
  v_search := EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(p_taxon,100,NULL,NULL) i
                       WHERE i->>'contribution_id'=p_id::text);
  v_get := EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(p_id,NULL) i
                    WHERE i->>'status'='shared');
  IF v_served IS DISTINCT FROM p_expect OR v_search IS DISTINCT FROM p_expect
     OR v_get IS DISTINCT FROM p_expect THEN
    RAISE EXCEPTION '%: served % search % get %, expected %', p_label, v_served, v_search, v_get, p_expect;
  END IF;
END
$$;

DO $$
DECLARE
  o_ok constant uuid := '00000000-0000-4000-8000-00000000e311';
  o_banned constant uuid := '00000000-0000-4000-8000-00000000e312';
  o_deleted constant uuid := '00000000-0000-4000-8000-00000000e313';
  o_blocked constant uuid := '00000000-0000-4000-8000-00000000e314';
  viewer constant uuid := '00000000-0000-4000-8000-00000000e315';
  t constant integer := 2100000983;
  t_big constant integer := 2100000984;
  t_page constant integer := 2100000985;
  v_ok uuid; v_hidden uuid; v_withdrawn uuid; v_null uuid; v_banned uuid; v_deleted uuid;
  v_blocked uuid; v_pre uuid; v_missing uuid; v_big uuid; v_hist uuid; v_hist_big uuid; v_tomb uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_opted uuid;
  v_env jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  SELECT u,'authenticated','authenticated','served-'||right(u::text,3)||'@example.invalid','{}',now(),now()
    FROM unnest(ARRAY[o_ok,o_banned,o_deleted,o_blocked,viewer]) u;
  INSERT INTO public.profiles(id,username,display_name,is_banned) VALUES
    (o_ok,'served_ok','Ok',false),(o_banned,'served_banned','Banned',true),
    (o_deleted,'served_deleted','Deleted',false),(o_blocked,'served_blocked','Blocked',false),
    (viewer,'served_viewer','Viewer',false);
  INSERT INTO private.reference_account_deletions(user_id) VALUES (o_deleted);
  INSERT INTO public.user_blocks(blocker_id,blocked_id) VALUES (viewer,o_blocked);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (t,'Amanita servata','species','include','in_cache','served-test'),
           (t_big,'Amanita magna','species','include','in_cache','served-test'),
           (t_page,'Amanita paginata','species','include','in_cache','served-test');
  ALTER TABLE private.shared_reference_contributions
    DROP CONSTRAINT shared_reference_contributions_consent_period_bound,
    DROP CONSTRAINT shared_reference_contributions_shared_period_bound;
  -- The reads cap envelopes independently of this CHECK (defence in depth).
  ALTER TABLE private.shared_reference_contribution_revisions
    DROP CONSTRAINT shared_reference_contribution_revisions_envelope_json_check;

  v_ok := pg_temp.seed(o_ok,t,1,1,10);
  v_hidden := pg_temp.seed(o_ok,t,1,1,11);
  UPDATE private.shared_reference_contributions SET hidden_at=now(),hidden_reason='legal' WHERE id=v_hidden;
  v_withdrawn := pg_temp.seed(o_ok,t,1,1,12);
  UPDATE private.shared_reference_contributions
     SET status='withdrawn',withdrawn_at=now(),consented_at=NULL,consent_version=NULL,consent_locale=NULL,
         consent_first_revision=NULL,consent_scope=NULL,share_basis=NULL,shared_first_revision=NULL
   WHERE id=v_withdrawn;
  v_null := pg_temp.seed(NULL,t,1,1,13);
  v_banned := pg_temp.seed(o_banned,t,1,1,14);
  v_deleted := pg_temp.seed(o_deleted,t,1,1,15);
  v_blocked := pg_temp.seed(o_blocked,t,1,1,16);
  v_pre := pg_temp.seed(o_ok,t,1,2,17);          -- current revision before the consent period
  -- An opted-out set is not served on the species page (2d).
  v_opted := pg_temp.seed(o_ok,t,1,1,20);
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id)
  SELECT o_ok, source_measurement_set_id FROM private.shared_reference_contributions WHERE id=v_opted;
  v_missing := pg_temp.seed(o_ok,t,1,1,18);
  UPDATE private.shared_reference_contributions SET current_revision=2 WHERE id=v_missing;
  v_big := pg_temp.seed(o_ok,t_big,1,1,19,1048577);

  PERFORM pg_temp.claims(viewer,'authenticated');
  PERFORM pg_temp.agree('served',v_ok,t,true);
  PERFORM pg_temp.agree('hidden',v_hidden,t,false);
  PERFORM pg_temp.agree('withdrawn',v_withdrawn,t,false);
  PERFORM pg_temp.agree('owner NULL',v_null,t,false);
  PERFORM pg_temp.agree('banned',v_banned,t,false);
  PERFORM pg_temp.agree('account deletion',v_deleted,t,false);
  PERFORM pg_temp.agree('blocked',v_blocked,t,false);
  PERFORM pg_temp.agree('current revision before the sharing period',v_pre,t,false);
  PERFORM pg_temp.agree('opted out',v_opted,t,false);
  PERFORM pg_temp.agree('missing current revision',v_missing,t,false);
  PERFORM pg_temp.agree('oversize envelope',v_big,t_big,false);
  IF NOT private.reference_contribution_is_served(v_big,false) THEN
    RAISE EXCEPTION 'the uncapped served check rejected the oversize row';
  END IF;
  PERFORM pg_temp.claims(NULL,'anon');
  PERFORM pg_temp.agree('blocked, anon',v_blocked,t,true);
  PERFORM pg_temp.claims(viewer,'authenticated');

  -- Search keeps its cap across the whole page: an oversize row ends the page.
  v_p1 := pg_temp.seed(o_ok,t_page,1,1,1,600000);
  v_p2 := pg_temp.seed(o_ok,t_page,1,1,2,600000);
  v_p3 := pg_temp.seed(o_ok,t_page,1,1,3);
  DELETE FROM private.shared_reference_rate_buckets;
  IF (SELECT array_agg(i->>'contribution_id') FROM public.search_public_reference_contributions_v2(t_page,100,NULL,NULL) i)
       IS DISTINCT FROM ARRAY[v_p1::text]
     OR NOT private.reference_contribution_is_served(v_p3) THEN
    RAISE EXCEPTION 'search page cap changed';
  END IF;
  v_big := pg_temp.seed(o_ok,t_big,1,1,30);
  IF EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(t_big,100,NULL,NULL)) THEN
    RAISE EXCEPTION 'an oversize newest row did not end the page';
  END IF;

  -- v2 rows: today's envelope plus relationship_roles, nothing else; filters,
  -- order and cursor as today.
  DELETE FROM private.shared_reference_rate_buckets;
  SELECT envelope_json INTO v_env FROM private.shared_reference_contribution_revisions WHERE contribution_id=v_ok;
  IF (SELECT i FROM public.search_public_reference_contributions_v2(t,100,NULL,NULL) i
       WHERE i->>'contribution_id'=v_ok::text) IS DISTINCT FROM v_env || '{"relationship_roles":[]}'
     OR (SELECT i FROM public.get_public_reference_contribution_v2(v_ok,1) i)
          IS DISTINCT FROM v_env || '{"relationship_roles":[]}'
     OR (SELECT array_agg(i->>'contribution_id') FROM public.search_public_reference_contributions_v2(t,100,NULL,NULL) i)
          IS DISTINCT FROM ARRAY[v_ok::text]
     OR EXISTS (SELECT 1 FROM public.search_public_reference_contributions_v2(
          t,100,(SELECT shared_at FROM private.shared_reference_contributions WHERE id=v_ok),v_ok)) THEN
    RAISE EXCEPTION 'v2 envelope, filter or cursor wrong';
  END IF;
  BEGIN
    PERFORM * FROM public.search_public_reference_contributions_v2(t,101,NULL,NULL);
    RAISE EXCEPTION 'v2 search accepted a page above 100';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.search_public_reference_contributions_v2(t,10,now(),NULL);
    RAISE EXCEPTION 'v2 search accepted half a cursor';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- get_v2: in-period history and the tombstone stub exactly as today.
  v_hist := pg_temp.seed(o_ok,t,3,2,40);
  v_hist_big := pg_temp.seed(o_ok,t,3,2,41);
  UPDATE private.shared_reference_contribution_revisions
     SET envelope_json=envelope_json||jsonb_build_object('pad',repeat('x',1048577))
   WHERE contribution_id=v_hist_big AND revision=2;
  DELETE FROM private.shared_reference_rate_buckets;
  IF EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(v_hist,1))
     OR (SELECT i FROM public.get_public_reference_contribution_v2(v_hist,2) i) IS DISTINCT FROM
        (SELECT envelope_json||'{"relationship_roles":[]}' FROM private.shared_reference_contribution_revisions
          WHERE contribution_id=v_hist AND revision=2)
     OR (SELECT i->>'revision' FROM public.get_public_reference_contribution_v2(v_hist,NULL) i) <> '3'
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(v_hist,4))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(v_hist_big,2))
     OR (SELECT i->>'revision' FROM public.get_public_reference_contribution_v2(v_hist_big,3) i) <> '3' THEN
    RAISE EXCEPTION 'get_v2 revision rules changed';
  END IF;
  v_tomb := pg_temp.seed(o_ok,t,2,1,42);
  UPDATE private.shared_reference_contributions
     SET status='withdrawn',withdrawn_at=now(),consented_at=NULL,consent_version=NULL,consent_locale=NULL,
         consent_first_revision=NULL,consent_scope=NULL,share_basis=NULL,shared_first_revision=NULL,
         owner_id=NULL,source_measurement_set_id=NULL
   WHERE id=v_tomb;
  IF (SELECT i FROM public.get_public_reference_contribution_v2(v_tomb,1) i) IS DISTINCT FROM
        (SELECT i FROM public.get_public_reference_contribution(v_tomb,1) i)
     OR (SELECT array_agg(k ORDER BY k) FROM public.get_public_reference_contribution_v2(v_tomb,2) i,
           jsonb_object_keys(i) k) IS DISTINCT FROM ARRAY['contribution_id','revision','status','withdrawn_at']
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(v_tomb,NULL))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(v_tomb,3)) THEN
    RAISE EXCEPTION 'get_v2 tombstone stub changed';
  END IF;
  UPDATE private.shared_reference_contributions SET hidden_at=now(),hidden_reason='abuse' WHERE id=v_tomb;
  IF EXISTS (SELECT 1 FROM public.get_public_reference_contribution_v2(v_tomb,1))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution(v_tomb,1)) THEN
    RAISE EXCEPTION 'a hidden tombstone was served';
  END IF;

  -- Restricted reads: no shared row, envelope or revision; tombstones only.
  DELETE FROM private.shared_reference_rate_buckets;
  IF EXISTS (SELECT 1 FROM public.search_public_reference_contributions(t,100,NULL,NULL))
     OR EXISTS (SELECT 1 FROM public.search_public_reference_contributions(t_page,NULL,NULL,NULL))
     OR EXISTS (SELECT 1 FROM public.search_public_reference_contributions_unthrottled(t,100,NULL,NULL))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution(v_ok,NULL))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution(v_ok,1))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution(v_hist,2))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution(v_hist,3))
     OR EXISTS (SELECT 1 FROM public.get_public_reference_contribution_unthrottled(v_hist,NULL)) THEN
    RAISE EXCEPTION 'a restricted read served a shared row';
  END IF;
  BEGIN
    PERFORM * FROM public.search_public_reference_contributions(t,101,NULL,NULL);
    RAISE EXCEPTION 'restricted search accepted a page above 100';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.search_public_reference_contributions_unthrottled(0,10,NULL,NULL);
    RAISE EXCEPTION 'restricted search accepted a bad taxon';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$$;

-- Rate limit: anon may call both _v2 reads; request 31 is throttled.
DO $$
DECLARE i integer;
BEGIN
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  PERFORM set_config('request.headers','{"x-sporely-session-id":"roles-anon"}',true);
  PERFORM set_config('response.status','200',true);
  SET LOCAL ROLE anon;
  FOR i IN 1..15 LOOP
    PERFORM * FROM public.get_public_reference_contribution_v2(gen_random_uuid(),NULL);
    PERFORM * FROM public.search_public_reference_contributions_v2(2100000983,NULL,NULL,NULL);
  END LOOP;
  IF current_setting('response.status',true) = '429' THEN
    RAISE EXCEPTION 'v2 reads throttled within the anonymous limit';
  END IF;
  PERFORM * FROM public.search_public_reference_contributions_v2(2100000983,NULL,NULL,NULL);
  RESET ROLE;
  IF current_setting('response.status',true) <> '429'
     OR current_setting('response.headers',true)::jsonb->0->>'Retry-After' IS NULL THEN
    RAISE EXCEPTION 'v2 anonymous request 31 was not throttled';
  END IF;
  PERFORM set_config('response.status','200',true);
  SET LOCAL ROLE anon;
  PERFORM * FROM public.get_public_reference_contribution_v2(gen_random_uuid(),NULL);
  RESET ROLE;
  IF current_setting('response.status',true) <> '429' THEN
    RAISE EXCEPTION 'v2 get was not throttled';
  END IF;
END
$$;

ROLLBACK;

-- ── C. Execution surface ──
DO $$
DECLARE v_role text; v_fn text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role','public'] LOOP
    FOREACH v_fn IN ARRAY ARRAY[
      'private.reference_contribution_is_served(uuid,boolean)',
      'private.reference_contribution_public_roles(uuid)',
      'private.search_public_reference_contributions_v2_unthrottled(integer,integer,timestamptz,uuid)',
      'private.get_public_reference_contribution_v2_unthrottled(uuid,integer)',
      'public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid)',
      'public.get_public_reference_contribution_unthrottled(uuid,integer)',
      'private.list_my_shared_reference_contributions_unthrottled()'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'role % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF NOT has_function_privilege(v_role,'public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid)','EXECUTE')
       OR NOT has_function_privilege(v_role,'public.get_public_reference_contribution_v2(uuid,integer)','EXECUTE') THEN
      RAISE EXCEPTION 'role % cannot execute a v2 read', v_role;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['service_role','public'] LOOP
    IF has_function_privilege(v_role,'public.search_public_reference_contributions_v2(integer,integer,timestamptz,uuid)','EXECUTE')
       OR has_function_privilege(v_role,'public.get_public_reference_contribution_v2(uuid,integer)','EXECUTE') THEN
      RAISE EXCEPTION 'role % can execute a v2 read', v_role;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE (n.nspname,p.proname) IN (
         ('private','reference_contribution_is_served'),('private','reference_contribution_public_roles'),
         ('private','search_public_reference_contributions_v2_unthrottled'),
         ('private','get_public_reference_contribution_v2_unthrottled'),
         ('public','search_public_reference_contributions_v2'),('public','get_public_reference_contribution_v2'))
         AND pg_get_userbyid(p.proowner)='postgres'
         AND coalesce(p.proconfig @> ARRAY['search_path=""'],false)
         AND p.prosecdef = (n.nspname='public')
         AND (n.nspname='private' OR p.provolatile='v')) <> 6 THEN
    RAISE EXCEPTION 'new functions: owner, search_path, SECURITY DEFINER or volatility wrong';
  END IF;
END
$$;

-- ── D. The consent text v1 edit ──
-- The shipped result: anchor paragraph followed by the added paragraph, once;
-- hash matches; scope unchanged; still inactive.
DO $$
BEGIN
  IF (SELECT count(*) FROM private.reference_share_consent_texts
       WHERE version=1 AND NOT active AND NOT revoked
         AND text_sha256=encode(sha256(convert_to(text,'UTF8')),'hex')
         AND scope='{"snapshot_schema_versions":[1],"data_kinds":["raw_points","free_text","measurement_details"]}'::jsonb
         AND ((locale='en' AND text LIKE '%(compared, supports or contradicts the identification).'||E'\n\n'||
               'Wherever your shared reference is listed publicly, it is marked with how you use it on your public observations of this species (compared, supports or contradicts the identification). The label combines all of them and updates when you change how you use the reference.'||E'\n\nLater edits:%')
           OR (locale='nb' AND text LIKE '%(sammenlignet, støtter eller motsier bestemmelsen).'||E'\n\n'||
               'Overalt der den delte referansen din er oppført offentlig, er den merket med hvordan du bruker den på de offentlige observasjonene dine av denne arten (sammenlignet, støtter eller motsier bestemmelsen). Merkingen samler alle bruksmåtene og oppdateres når du endrer hvordan du bruker referansen.'||E'\n\nSenere endringer:%'))) <> 2 THEN
    RAISE EXCEPTION 'consent text v1 was not edited as specified';
  END IF;
END
$$;

-- The migration step, verbatim, as a function, run on the pre-edit texts.
BEGIN;

CREATE FUNCTION pg_temp.edit_step() RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_anchor_en constant text := 'The reference also appears on your public observations that use it, with how you used it (compared, supports or contradicts the identification).';
  v_added_en constant text := 'Wherever your shared reference is listed publicly, it is marked with how you use it on your public observations of this species (compared, supports or contradicts the identification). The label combines all of them and updates when you change how you use the reference.';
  v_anchor_nb constant text := 'Referansen vises også på de offentlige observasjonene dine som bruker den, med hvordan du brukte den (sammenlignet, støtter eller motsier bestemmelsen).';
  v_added_nb constant text := 'Overalt der den delte referansen din er oppført offentlig, er den merket med hvordan du bruker den på de offentlige observasjonene dine av denne arten (sammenlignet, støtter eller motsier bestemmelsen). Merkingen samler alle bruksmåtene og oppdateres når du endrer hvordan du bruker referansen.';
  v_count integer;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM private.reference_share_consent_texts
       WHERE version = 1 AND locale IN ('en', 'nb') AND NOT active AND NOT revoked) <> 2 THEN
    RAISE EXCEPTION 'consent text v1 must be inactive and unrevoked in en and nb'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions WHERE consent_version = 1)
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events WHERE consent_version = 1) THEN
    RAISE EXCEPTION 'consent text v1 is referenced by a contribution or consent event'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM private.reference_share_consent_texts ct
     WHERE ct.version = 1
       AND ((ct.locale = 'en' AND (pg_catalog.strpos(ct.text, v_anchor_en) = 0
                                   OR pg_catalog.strpos(ct.text, v_added_en) > 0))
         OR (ct.locale = 'nb' AND (pg_catalog.strpos(ct.text, v_anchor_nb) = 0
                                   OR pg_catalog.strpos(ct.text, v_added_nb) > 0)))
  ) THEN
    RAISE EXCEPTION 'consent text v1 is not the shipped wording' USING ERRCODE = '55000';
  END IF;
  WITH edited AS (
    SELECT ct.version, ct.locale,
           CASE ct.locale
             WHEN 'en' THEN pg_catalog.replace(ct.text, v_anchor_en, v_anchor_en || E'\n\n' || v_added_en)
             ELSE pg_catalog.replace(ct.text, v_anchor_nb, v_anchor_nb || E'\n\n' || v_added_nb)
           END AS body
      FROM private.reference_share_consent_texts ct
     WHERE ct.version = 1 AND ct.locale IN ('en', 'nb')
  )
  UPDATE private.reference_share_consent_texts ct
     SET text = e.body,
         text_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(e.body, 'UTF8')), 'hex')
    FROM edited e
   WHERE ct.version = e.version AND ct.locale = e.locale
     AND NOT ct.active AND NOT ct.revoked;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'consent text v1 edit changed % rows, expected 2', v_count
      USING ERRCODE = '55000';
  END IF;
END
$fn$;

CREATE FUNCTION pg_temp.expect_abort(p_label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_before jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(ct) ORDER BY locale) INTO v_before FROM private.reference_share_consent_texts ct;
  BEGIN
    PERFORM pg_temp.edit_step();
    RAISE EXCEPTION '%: the text edit did not abort', p_label;
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  IF (SELECT jsonb_agg(to_jsonb(ct) ORDER BY locale) FROM private.reference_share_consent_texts ct)
       IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION '%: an aborted edit changed a text', p_label;
  END IF;
END
$$;

DO $$
DECLARE
  v_shipped jsonb;
  v_owner constant uuid := '00000000-0000-4000-8000-00000000e321';
  v_id uuid;
BEGIN
  SELECT jsonb_agg(to_jsonb(ct) ORDER BY locale) INTO v_shipped FROM private.reference_share_consent_texts ct;
  -- Back to the 2b wording (20260930232633).
  UPDATE private.reference_share_consent_texts ct
     SET text=x.body, text_sha256=encode(sha256(convert_to(x.body,'UTF8')),'hex')
    FROM (SELECT locale, replace(text, E'\n\n'||CASE locale
           WHEN 'en' THEN 'Wherever your shared reference is listed publicly, it is marked with how you use it on your public observations of this species (compared, supports or contradicts the identification). The label combines all of them and updates when you change how you use the reference.'
           ELSE 'Overalt der den delte referansen din er oppført offentlig, er den merket med hvordan du bruker den på de offentlige observasjonene dine av denne arten (sammenlignet, støtter eller motsier bestemmelsen). Merkingen samler alle bruksmåtene og oppdateres når du endrer hvordan du bruker referansen.'
         END, '') AS body FROM private.reference_share_consent_texts) x
   WHERE x.locale=ct.locale;

  UPDATE private.reference_share_consent_texts SET active=true WHERE locale='en';
  PERFORM pg_temp.expect_abort('active en');
  UPDATE private.reference_share_consent_texts SET active=false WHERE locale='en';
  UPDATE private.reference_share_consent_texts SET revoked=true WHERE locale='nb';
  PERFORM pg_temp.expect_abort('revoked nb');
  UPDATE private.reference_share_consent_texts SET revoked=false WHERE locale='nb';

  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES (v_owner,'authenticated','authenticated','text-edit@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,display_name,is_banned) VALUES (v_owner,'text_edit','Text',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (2100000986,'Amanita textualis','species','include','in_cache','text-test');
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,
    share_basis,shared_first_revision,consented_at,consent_version,consent_locale,consent_first_revision,consent_scope)
  VALUES (v_owner,gen_random_uuid(),2100000986,'shared','consented',1,now(),1,'nb',1,'{"snapshot_schema_versions":[1],"data_kinds":[]}')
  RETURNING id INTO v_id;
  PERFORM pg_temp.expect_abort('referenced by a contribution');
  UPDATE private.shared_reference_contributions
     SET status='withdrawn',withdrawn_at=now(),consented_at=NULL,consent_version=NULL,consent_locale=NULL,
         consent_first_revision=NULL,consent_scope=NULL,share_basis=NULL,shared_first_revision=NULL WHERE id=v_id;
  INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason,consent_version)
  VALUES (v_id,'withdrawn_by_system','use_detached',1);
  PERFORM pg_temp.expect_abort('referenced by an event');
  -- Events are append-only: a fresh contribution set for the success case.
  ALTER TABLE private.shared_reference_consent_events DISABLE TRIGGER shared_reference_consent_events_append_only_trg;
  DELETE FROM private.shared_reference_consent_events WHERE contribution_id=v_id;
  ALTER TABLE private.shared_reference_consent_events ENABLE TRIGGER shared_reference_consent_events_append_only_trg;

  -- A version-2 reference does not block the v1 edit.
  INSERT INTO private.shared_reference_consent_events(contribution_id,event,reason,consent_version)
  VALUES (v_id,'withdrawn_by_system','use_detached',2);
  PERFORM pg_temp.edit_step();
  IF (SELECT jsonb_agg(to_jsonb(ct) ORDER BY locale) FROM private.reference_share_consent_texts ct)
       IS DISTINCT FROM v_shipped THEN
    RAISE EXCEPTION 'the text edit did not produce the shipped texts';
  END IF;
  -- A second run aborts and changes nothing.
  PERFORM pg_temp.expect_abort('already edited');
END
$$;

ROLLBACK;
