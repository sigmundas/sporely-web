-- 20261002150000_fork_from_shared_reference_contribution.sql:
-- public.sync_reference_curated_fork accepts a shared contribution revision as
-- the fork source (owner decision (a)).
--   A. creation: a served contribution revision with its exact stored
--      envelope is accepted (source_kind shared_contribution); idempotent
--      no_change / conflict.
--   B. rejected at creation: foreign target graph, projected envelope
--      (Stage A marker), envelope carrying live relationship_roles, stale /
--      altered envelope, wrong taxon, hidden, opted out, withdrawn, unknown.
--   C. after creation, stop sharing and moderation hide neither remove nor
--      invalidate the fork (re-push is no_change); new forks are refused.
--   D. self-fork of a served own contribution is accepted (legacy has no
--      self-fork rule).
-- The legacy curated-publication path is covered unchanged by
-- reference_curated_fork_provenance_test.sql.
-- Failures are collected (WARNING per failed check) and raised at the end, so
-- running this file against the previous definition lists every check that
-- the old definition fails. Everything is rolled back.

BEGIN;

CREATE FUNCTION pg_temp.as_user(p_sub uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('sub',p_sub::text,'role','authenticated')::text, true)
$$;

CREATE TABLE pg_temp.failures(label text);

CREATE FUNCTION pg_temp.check(p_ok boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE WARNING 'FAILED: %', p_label;
    INSERT INTO pg_temp.failures VALUES (p_label);
  END IF;
END
$$;

-- Payload as sporely-py builds it: contribution_id/revision as the curated
-- identity, sha256 over the exact envelope text.
CREATE FUNCTION pg_temp.payload(
  p_contribution uuid, p_revision integer, p_taxon integer,
  p_work uuid, p_treatment uuid, p_set uuid, p_envelope jsonb
) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'curated_measurement_set_id', p_contribution,
    'bundle_revision', p_revision,
    'sporely_taxon_id', p_taxon,
    'reference_work_id', p_work,
    'taxon_treatment_id', p_treatment,
    'reference_measurement_set_id', p_set,
    'source_sha256', encode(extensions.digest(convert_to(p_envelope::text,'UTF8'),'sha256'),'hex'),
    'source_envelope_json', p_envelope::text)
$$;

CREATE FUNCTION pg_temp.sync(p_user uuid, p_payload jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.as_user(p_user);
  r := public.sync_reference_curated_fork(p_payload, 0);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r->>'status';
END
$$;

DO $$
DECLARE
  a constant uuid := '00000000-0000-4000-8000-0000000f0a01';  -- contributor
  b constant uuid := '00000000-0000-4000-8000-0000000f0a02';  -- copier
  c constant uuid := '00000000-0000-4000-8000-0000000f0a03';  -- second copier
  t constant integer := 2100000881;
  t_other constant integer := 2100000882;
  wa constant uuid := '7a000000-0000-4000-8000-0000000f0001';
  tra constant uuid := '7b000000-0000-4000-8000-0000000f0001';
  wb constant uuid := '7a000000-0000-4000-8000-0000000f0002';
  trb constant uuid := '7b000000-0000-4000-8000-0000000f0002';
  wc constant uuid := '7a000000-0000-4000-8000-0000000f0003';
  trc constant uuid := '7b000000-0000-4000-8000-0000000f0003';
  -- A's shared sets: main, hidden, opted-out, withdrawn, self
  sa constant uuid := '7c000000-0000-4000-8000-0000000f0001';
  sh constant uuid := '7c000000-0000-4000-8000-0000000f0002';
  so constant uuid := '7c000000-0000-4000-8000-0000000f0003';
  sw constant uuid := '7c000000-0000-4000-8000-0000000f0004';
  ss constant uuid := '7c000000-0000-4000-8000-0000000f0005';
  -- copy targets
  sb1 constant uuid := '7d000000-0000-4000-8000-0000000f0001';
  sb2 constant uuid := '7d000000-0000-4000-8000-0000000f0002';
  sc1 constant uuid := '7d000000-0000-4000-8000-0000000f0003';
  sa_copy constant uuid := '7d000000-0000-4000-8000-0000000f0004';
  ca uuid; ch uuid; co uuid; cw uuid; cs uuid;
  ea jsonb; eh jsonb; eo jsonb; ew jsonb; es jsonb;
  v_status text;
  v_row public.reference_curated_forks%ROWTYPE;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (a,'authenticated','authenticated','fork-contrib-a@example.invalid','{}',now(),now()),
    (b,'authenticated','authenticated','fork-contrib-b@example.invalid','{}',now(),now()),
    (c,'authenticated','authenticated','fork-contrib-c@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (a,'fork_contrib_a',false),(b,'fork_contrib_b',false),(c,'fork_contrib_c',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (t,'Cortinarius copiatus','species','include','in_cache','fork-contrib-test'),
           (t_other,'Cortinarius alius','species','include','in_cache','fork-contrib-test');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES
    (975100001,a,current_date,'public',false,'public',t),
    (975100002,a,current_date,'public',false,'public',t),
    (975100003,a,current_date,'public',false,'public',t),
    (975100004,a,current_date,'public',false,'public',t),
    (975100005,a,current_date,'public',false,'public',t);
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision) VALUES
    (a,wa,'article','[{"family":"Contributor"}]','Shared source',2026,'Contributor 2026',1),
    (b,wb,'article','[{"family":"Contributor"}]','Shared source',2026,'Contributor 2026',1),
    (c,wc,'article','[{"family":"Contributor"}]','Shared source',2026,'Contributor 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision) VALUES
    (a,tra,wa,'d','Cortinarius copiatus',1),
    (b,trb,wb,'d','Cortinarius copiatus',1),
    (c,trc,wc,'d','Cortinarius copiatus',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  SELECT a,s,tra,'spore_size','range','8-10 um',1 FROM unnest(ARRAY[sa,sh,so,sw,ss,sa_copy]) s;
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision) VALUES
    (b,sb1,trb,'spore_size','range','8-10 um',1),
    (b,sb2,trb,'spore_size','range','8-10 um',1),
    (c,sc1,trc,'spore_size','range','8-10 um',1);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  SELECT a,gen_random_uuid(),x.obs,x.s,'compared',1,private.reference_canonical_snapshot(a,x.s)
    FROM (VALUES (975100001::bigint,sa),(975100002,sh),(975100003,so),(975100004,sw),(975100005,ss)) x(obs,s);
  PERFORM private.reference_contribution_share_core('refresh', a, s, t)
     FROM unnest(ARRAY[sa,sh,so,sw,ss]) s;
  SELECT id INTO ca FROM private.shared_reference_contributions WHERE owner_id=a AND source_measurement_set_id=sa;
  SELECT id INTO ch FROM private.shared_reference_contributions WHERE owner_id=a AND source_measurement_set_id=sh;
  SELECT id INTO co FROM private.shared_reference_contributions WHERE owner_id=a AND source_measurement_set_id=so;
  SELECT id INTO cw FROM private.shared_reference_contributions WHERE owner_id=a AND source_measurement_set_id=sw;
  SELECT id INTO cs FROM private.shared_reference_contributions WHERE owner_id=a AND source_measurement_set_id=ss;
  IF ca IS NULL OR ch IS NULL OR co IS NULL OR cw IS NULL OR cs IS NULL THEN
    RAISE EXCEPTION 'fixture: contributions were not shared';
  END IF;
  SELECT envelope_json INTO ea FROM private.shared_reference_contribution_revisions WHERE contribution_id=ca AND revision=1;
  SELECT envelope_json INTO eh FROM private.shared_reference_contribution_revisions WHERE contribution_id=ch AND revision=1;
  SELECT envelope_json INTO eo FROM private.shared_reference_contribution_revisions WHERE contribution_id=co AND revision=1;
  SELECT envelope_json INTO ew FROM private.shared_reference_contribution_revisions WHERE contribution_id=cw AND revision=1;
  SELECT envelope_json INTO es FROM private.shared_reference_contribution_revisions WHERE contribution_id=cs AND revision=1;
  -- The fixture envelope is exactly what get_public_reference_contribution_v2
  -- serves (minus the live roles), as the desktop stores it.
  PERFORM pg_temp.as_user(b);
  PERFORM pg_temp.check(
    (SELECT g - 'relationship_roles' FROM public.get_public_reference_contribution_v2(ca, 1) g) = ea,
    'fixture: served envelope minus roles equals the revision envelope');
  PERFORM set_config('request.jwt.claims', '', true);

  -- Hidden, opted-out (still status shared) and withdrawn sources.
  UPDATE private.shared_reference_contributions SET hidden_at=now(), hidden_reason='abuse' WHERE id=ch;
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id) VALUES (a,so);
  PERFORM private.withdraw_shared_reference_contribution(cw,'use_detached');

  -- B. rejected at creation -------------------------------------------------
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,1,t,wa,tra,sa_copy,ea)) = 'invalid_parent',
    'B: target graph owned by another user is invalid_parent');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,1,t,wc,trc,sc1,
      ea || '{"measurement_details_omitted":true}')) = 'invalid_source',
    'B: projected envelope (measurement_details_omitted) is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,1,t,wc,trc,sc1,
      ea || '{"relationship_roles":[]}')) = 'invalid_source',
    'B: envelope carrying live relationship_roles is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,1,t,wc,trc,sc1,
      ea || '{"shared_at":"2020-01-01T00:00:00+00:00"}')) = 'invalid_source',
    'B: stale/altered envelope is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,2,t,wc,trc,sc1,ea)) = 'invalid_source',
    'B: revision that does not exist is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,1,t_other,wc,trc,sc1,ea)) = 'invalid_source',
    'B: wrong taxon is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(gen_random_uuid(),1,t,wc,trc,sc1,ea)) = 'invalid_source',
    'B: unknown source is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ch,1,t,wc,trc,sc1,eh)) = 'invalid_source',
    'B: hidden contribution is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(co,1,t,wc,trc,sc1,eo)) = 'invalid_source',
    'B: opted-out contribution is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(cw,1,t,wc,trc,sc1,ew)) = 'invalid_source',
    'B: withdrawn contribution is invalid_source');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.reference_curated_forks WHERE user_id=c),
    'B: no fork row written for rejected sources');

  -- A. creation and idempotency ----------------------------------------------
  v_status := pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea));
  PERFORM pg_temp.check(v_status = 'created', 'A: served contribution fork is created (got '||coalesce(v_status,'null')||')');
  SELECT * INTO v_row FROM public.reference_curated_forks WHERE user_id=b AND curated_measurement_set_id=ca;
  PERFORM pg_temp.check(FOUND AND v_row.bundle_revision = 1 AND v_row.reference_measurement_set_id = sb1
      AND v_row.source_envelope_json::jsonb = ea
      AND (to_jsonb(v_row)->>'source_kind') = 'shared_contribution',
    'A: fork row stores the contribution source and source_kind');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'A: identical re-push is no_change');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb2,ea)) = 'conflict',
    'A: same source onto another target is conflict');
  -- C. stop sharing and hide after creation ----------------------------------
  PERFORM private.stop_sharing_reference_set_for_owner(a, sa);
  PERFORM pg_temp.check((SELECT status FROM private.shared_reference_contributions WHERE id=ca) = 'withdrawn',
    'C: fixture: stop sharing withdrew the contribution');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'C: after stop sharing the existing fork re-pushes as no_change');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ca,1,t,wc,trc,sc1,ea)) = 'invalid_source',
    'C: after stop sharing a new fork is invalid_source');
  UPDATE private.shared_reference_contributions SET hidden_at=now(), hidden_reason='privacy' WHERE id=ca;
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'C: after hide the existing fork re-pushes as no_change');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.reference_curated_forks
      WHERE user_id=b AND curated_measurement_set_id=ca AND source_envelope_json::jsonb = ea),
    'C: fork row and provenance survive stop sharing and hide');

  -- D. self-fork ----------------------------------------------------------------
  PERFORM pg_temp.check(pg_temp.sync(a, pg_temp.payload(cs,1,t,wa,tra,sa_copy,es)) = 'created',
    'D: self-fork of a served own contribution is created (legacy has no self-fork rule)');

END
$$;

-- RLS as the authenticated role (owner select + Stage M restrictive policy).
GRANT INSERT ON pg_temp.failures TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000f0a02","role":"authenticated"}', true);
INSERT INTO pg_temp.failures
SELECT 'A: owner reads the contribution fork through RLS'
 WHERE (SELECT count(*) FROM public.reference_curated_forks) <> 1;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000f0a01","role":"authenticated"}', true);
INSERT INTO pg_temp.failures
SELECT 'A: contributor cannot read the copier''s fork'
 WHERE (SELECT count(*) FROM public.reference_curated_forks
         WHERE user_id = '00000000-0000-4000-8000-0000000f0a02') <> 0;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.failures) THEN
    RAISE EXCEPTION 'reference_curated_fork_from_contribution_test: % check(s) failed: %',
      (SELECT count(*) FROM pg_temp.failures),
      (SELECT string_agg(label, '; ') FROM pg_temp.failures);
  END IF;
  RAISE NOTICE 'reference_curated_fork_from_contribution_test: all checks passed';
END
$$;

ROLLBACK;
