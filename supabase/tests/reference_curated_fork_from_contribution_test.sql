-- 20261002150000_fork_from_shared_reference_contribution.sql:
-- public.sync_reference_curated_fork accepts a shared contribution revision as
-- the fork source (owner decisions (a) and (B)).
--   A. creation: a served revision is accepted with or without contributor in
--      the client envelope; the stored envelope is the revision envelope
--      without contributor (no label anywhere in the row) and source_sha256
--      is sha256 of the stored text; idempotent no_change / conflict; an
--      older revision of the current sharing period is accepted; a version-2
--      snapshot envelope is accepted; the feed returns the new columns.
--   B. rejected at creation: foreign target graph, projected envelope
--      (Stage A marker), live relationship_roles, altered envelope, unknown
--      revision, wrong taxon, unknown source, hidden, opted out, withdrawn,
--      revision before the current sharing period, snapshot version 3.
--   C. stop sharing, moderation hide and contributor account deletion
--      neither remove nor invalidate the fork (re-push no_change, row and
--      provenance unchanged and label-free); new forks are refused.
--   D. self-fork of a served own contribution is accepted (legacy has no
--      self-fork rule).
--   M. Stage M: a fork bound to an enhanced (withheld) target set is hidden
--      from a non-capable reader and counted in withheld_count.
-- The legacy curated-publication path is covered unchanged by
-- reference_curated_fork_provenance_test.sql.
-- Failures are collected (WARNING per failed check) and raised at the end, so
-- running this file against a previous definition lists every check it
-- fails. Everything is rolled back. Never SET ROLE inside a DO block.

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
-- identity, sha256 over the exact client envelope text.
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

CREATE FUNCTION pg_temp.envelope(p_contribution uuid, p_revision integer) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT envelope_json FROM private.shared_reference_contribution_revisions
   WHERE contribution_id = p_contribution AND revision = p_revision
$$;

CREATE FUNCTION pg_temp.contribution(p_owner uuid, p_set uuid) RETURNS uuid
LANGUAGE sql AS $$
  SELECT id FROM private.shared_reference_contributions
   WHERE owner_id = p_owner AND source_measurement_set_id = p_set
$$;

-- A stored fork row is label-free and its sha256 covers the stored text.
CREATE FUNCTION pg_temp.row_ok(p_user uuid, p_contribution uuid, p_revision integer, p_expected jsonb)
RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reference_curated_forks f
     WHERE f.user_id = p_user AND f.curated_measurement_set_id = p_contribution
       AND f.bundle_revision = p_revision
       AND pg_catalog.to_jsonb(f)->>'source_kind' = 'shared_contribution'
       AND f.source_envelope_json::jsonb = p_expected
       AND NOT (f.source_envelope_json::jsonb ? 'contributor')
       AND NOT (f.source_envelope_json::jsonb ? 'relationship_roles')
       AND strpos(pg_catalog.to_jsonb(f)::text, 'fork_contrib_a') = 0
       AND f.source_sha256 = encode(extensions.digest(convert_to(f.source_envelope_json,'UTF8'),'sha256'),'hex'))
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
  -- A's shared sets: main, hidden, opted-out, withdrawn/re-shared, self,
  -- revised, version-2, version-3
  sa constant uuid := '7c000000-0000-4000-8000-0000000f0001';
  sh constant uuid := '7c000000-0000-4000-8000-0000000f0002';
  so constant uuid := '7c000000-0000-4000-8000-0000000f0003';
  sw constant uuid := '7c000000-0000-4000-8000-0000000f0004';
  ss constant uuid := '7c000000-0000-4000-8000-0000000f0005';
  sr constant uuid := '7c000000-0000-4000-8000-0000000f0006';
  sv constant uuid := '7c000000-0000-4000-8000-0000000f0007';
  sx constant uuid := '7c000000-0000-4000-8000-0000000f0008';
  -- copy targets (B: sb1..sb5, C: sc1..sc2, A: sa_copy)
  sb1 constant uuid := '7d000000-0000-4000-8000-0000000f0001';
  sb2 constant uuid := '7d000000-0000-4000-8000-0000000f0002';
  sb3 constant uuid := '7d000000-0000-4000-8000-0000000f0005';
  sb4 constant uuid := '7d000000-0000-4000-8000-0000000f0006';
  sb5 constant uuid := '7d000000-0000-4000-8000-0000000f0007';
  sc1 constant uuid := '7d000000-0000-4000-8000-0000000f0003';
  sc2 constant uuid := '7d000000-0000-4000-8000-0000000f0008';
  sa_copy constant uuid := '7d000000-0000-4000-8000-0000000f0004';
  ca uuid; ch uuid; co uuid; cw uuid; cs uuid; cr uuid; cv uuid; cx uuid;
  ea jsonb; ev jsonb;
  v_status text;
  v_before jsonb;
  v_feed jsonb;
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
  OVERRIDING SYSTEM VALUE
  SELECT 975100000 + g, a, current_date, 'public', false, 'public', t FROM generate_series(1,8) g;
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision) VALUES
    (a,wa,'article','[{"family":"Contributor"}]','Shared source',2026,'Contributor 2026',1),
    (b,wb,'article','[{"family":"Contributor"}]','Shared source',2026,'Contributor 2026',1),
    (c,wc,'article','[{"family":"Contributor"}]','Shared source',2026,'Contributor 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision) VALUES
    (a,tra,wa,'d','Cortinarius copiatus',1),
    (b,trb,wb,'d','Cortinarius copiatus',1),
    (c,trc,wc,'d','Cortinarius copiatus',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  SELECT a,s,tra,'spore_size','range','8-10 um',1 FROM unnest(ARRAY[sa,sh,so,sw,ss,sr,sv,sx,sa_copy]) s;
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  SELECT b,s,trb,'spore_size','range','8-10 um',1 FROM unnest(ARRAY[sb1,sb2,sb3,sb4,sb5]) s;
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  SELECT c,s,trc,'spore_size','range','8-10 um',1 FROM unnest(ARRAY[sc1,sc2]) s;
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  SELECT a,gen_random_uuid(),975100000 + x.n,x.s,'compared',1,private.reference_canonical_snapshot(a,x.s)
    FROM unnest(ARRAY[sa,sh,so,sw,ss,sr,sv,sx]) WITH ORDINALITY x(s,n);
  PERFORM private.reference_contribution_share_core('refresh', a, s, t)
     FROM unnest(ARRAY[sa,sh,so,sw,ss,sr,sv,sx]) s;
  ca := pg_temp.contribution(a,sa); ch := pg_temp.contribution(a,sh);
  co := pg_temp.contribution(a,so); cw := pg_temp.contribution(a,sw);
  cs := pg_temp.contribution(a,ss); cr := pg_temp.contribution(a,sr);
  cv := pg_temp.contribution(a,sv); cx := pg_temp.contribution(a,sx);
  IF ca IS NULL OR ch IS NULL OR co IS NULL OR cw IS NULL OR cs IS NULL
     OR cr IS NULL OR cv IS NULL OR cx IS NULL THEN
    RAISE EXCEPTION 'fixture: contributions were not shared';
  END IF;
  ea := pg_temp.envelope(ca,1);
  PERFORM pg_temp.check(ea->'contributor'->>'label' = 'fork_contrib_a',
    'fixture: the served envelope carries the contributor label');
  PERFORM pg_temp.as_user(b);
  PERFORM pg_temp.check(
    (SELECT g - 'relationship_roles' FROM public.get_public_reference_contribution_v2(ca, 1) g) = ea,
    'fixture: served envelope minus roles equals the revision envelope');
  PERFORM set_config('request.jwt.claims', '', true);

  -- Hidden, opted-out (still status shared), withdrawn-then-re-shared.
  UPDATE private.shared_reference_contributions SET hidden_at=now(), hidden_reason='abuse' WHERE id=ch;
  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id) VALUES (a,so);
  PERFORM private.withdraw_shared_reference_contribution(cw,'use_detached');
  -- Revised: a content change shares revision 2 in the same period.
  UPDATE public.reference_measurement_sets SET raw_text='9-11 um', revision=2 WHERE user_id=a AND id=sr;
  PERFORM private.reference_contribution_share_core('refresh', a, sr, t);
  PERFORM pg_temp.check((SELECT current_revision = 2 AND shared_first_revision = 1
      FROM private.shared_reference_contributions WHERE id=cr),
    'fixture: revised contribution is at revision 2 in the first sharing period');
  -- Version-2 and version-3 snapshots (written directly: the v2 writers are
  -- behind the deferred migration).
  UPDATE private.shared_reference_contribution_revisions
     SET envelope_json = jsonb_set(jsonb_set(envelope_json,'{snapshot,schema_version}','2'),
                                   '{snapshot,measurement_details}','{"metrics":{}}')
   WHERE contribution_id=cv AND revision=1;
  UPDATE private.shared_reference_contribution_revisions
     SET envelope_json = jsonb_set(envelope_json,'{snapshot,schema_version}','3')
   WHERE contribution_id=cx AND revision=1;
  ev := pg_temp.envelope(cv,1);

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
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(ch,1,t,wc,trc,sc1,pg_temp.envelope(ch,1))) = 'invalid_source',
    'B: hidden contribution is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(co,1,t,wc,trc,sc1,pg_temp.envelope(co,1))) = 'invalid_source',
    'B: opted-out contribution is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(cw,1,t,wc,trc,sc1,pg_temp.envelope(cw,1))) = 'invalid_source',
    'B: withdrawn contribution is invalid_source');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(cx,1,t,wc,trc,sc1,pg_temp.envelope(cx,1))) = 'invalid_source',
    'B: snapshot schema_version 3 is invalid_source');
  -- Re-share the withdrawn row: revision 2 opens a new sharing period.
  PERFORM private.reference_contribution_share_core('refresh', a, sw, t);
  PERFORM pg_temp.check((SELECT status = 'shared' AND shared_first_revision = 2
      FROM private.shared_reference_contributions WHERE id=cw),
    'fixture: re-shared contribution starts its period at revision 2');
  PERFORM pg_temp.check(pg_temp.sync(c, pg_temp.payload(cw,1,t,wc,trc,sc1,pg_temp.envelope(cw,1))) = 'invalid_source',
    'B: revision before the current sharing period is invalid_source');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.reference_curated_forks WHERE user_id=c),
    'B: no fork row written for rejected sources');

  -- A. creation and idempotency ----------------------------------------------
  v_status := pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea));
  PERFORM pg_temp.check(v_status = 'created', 'A: served contribution fork (with contributor) is created (got '||coalesce(v_status,'null')||')');
  PERFORM pg_temp.check(pg_temp.row_ok(b, ca, 1, ea - 'contributor'),
    'A: stored envelope = revision envelope minus contributor, label-free, sha256 over stored text');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'A: identical re-push (with contributor) is no_change');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea - 'contributor')) = 'no_change',
    'A: re-push of the stored form (without contributor) is no_change');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb2,ea)) = 'conflict',
    'A: same source onto another target is conflict');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,
      ea || '{"shared_at":"2020-01-01T00:00:00+00:00"}')) = 'conflict',
    'A: re-push with a different envelope is conflict');
  v_status := pg_temp.sync(c, pg_temp.payload(ca,1,t,wc,trc,sc2,ea - 'contributor'));
  PERFORM pg_temp.check(v_status = 'created',
    'A: client envelope without contributor is created (got '||coalesce(v_status,'null')||')');
  PERFORM pg_temp.check(pg_temp.row_ok(c, ca, 1, ea - 'contributor'),
    'A: fork from a contributor-less client envelope stores the same form');
  v_status := pg_temp.sync(b, pg_temp.payload(cr,1,t,wb,trb,sb3,pg_temp.envelope(cr,1)));
  PERFORM pg_temp.check(v_status = 'created',
    'A: older revision within the current sharing period is created (got '||coalesce(v_status,'null')||')');
  v_status := pg_temp.sync(b, pg_temp.payload(cw,2,t,wb,trb,sb4,pg_temp.envelope(cw,2)));
  PERFORM pg_temp.check(v_status = 'created',
    'A: first revision of the re-shared period is created (got '||coalesce(v_status,'null')||')');
  v_status := pg_temp.sync(b, pg_temp.payload(cv,1,t,wb,trb,sb5,ev));
  PERFORM pg_temp.check(v_status = 'created',
    'A: version-2 snapshot envelope is created (got '||coalesce(v_status,'null')||')');
  PERFORM pg_temp.check(pg_temp.row_ok(b, cv, 1, ev - 'contributor'),
    'A: version-2 fork stores the version-2 envelope minus contributor');
  PERFORM pg_temp.as_user(b);
  v_feed := public.list_reference_library_feed('curated_fork', '{"reference_snapshot_versions":[1,2]}');
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.check(jsonb_array_length(v_feed->'rows') = 4
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_feed->'rows') r
                       WHERE NOT (r ? 'source_kind' AND r ? 'shared_contribution_id'
                                  AND r ? 'curated_publication_set_id')
                          OR r->>'source_kind' <> 'shared_contribution'
                          OR r->>'shared_contribution_id' <> r->>'curated_measurement_set_id'
                          OR r->'curated_publication_set_id' <> 'null'::jsonb),
    'A: list_reference_library_feed(curated_fork) returns the new columns');

  -- M. Stage M: enhance B's version-2 target set; a v1-only reader is not
  -- given that fork (RLS checked as the authenticated role after this block).
  UPDATE public.reference_measurement_sets SET q_core_min=1.1, q_core_max=1.4
   WHERE user_id=b AND id=sb5;
  PERFORM pg_temp.as_user(b);
  v_feed := public.list_reference_library_feed('curated_fork', NULL);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.check((v_feed->>'withheld_count')::integer = 1
      AND jsonb_array_length(v_feed->'rows') = 3,
    'M: v1-only feed withholds the fork of an enhanced set');

  -- C. stop sharing, hide, contributor account deletion ------------------------
  v_before := (SELECT to_jsonb(f) FROM public.reference_curated_forks f WHERE user_id=b AND curated_measurement_set_id=ca);
  PERFORM private.stop_sharing_reference_set_for_owner(a, sa);
  PERFORM pg_temp.check((SELECT status FROM private.shared_reference_contributions WHERE id=ca) = 'withdrawn',
    'C: fixture: stop sharing withdrew the contribution');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'C: after stop sharing the existing fork re-pushes as no_change');
  PERFORM pg_temp.check(pg_temp.sync(a, pg_temp.payload(ca,1,t,wa,tra,sa_copy,ea)) = 'invalid_source',
    'C: after stop sharing a new fork is invalid_source');
  UPDATE private.shared_reference_contributions SET hidden_at=now(), hidden_reason='privacy' WHERE id=ca;
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'C: after hide the existing fork re-pushes as no_change');

  -- D. self-fork (before A's account is deleted) -------------------------------
  PERFORM pg_temp.check(pg_temp.sync(a, pg_temp.payload(cs,1,t,wa,tra,sa_copy,pg_temp.envelope(cs,1))) = 'created',
    'D: self-fork of a served own contribution is created (legacy has no self-fork rule)');

  DELETE FROM public.profiles WHERE id=a;
  PERFORM pg_temp.check(pg_temp.envelope(ca,1)->'contributor'->>'label' = 'Deleted user',
    'C: fixture: account deletion anonymized the revision envelope');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,ea)) = 'no_change',
    'C: after contributor deletion the old client envelope re-pushes as no_change');
  PERFORM pg_temp.check(pg_temp.sync(b, pg_temp.payload(ca,1,t,wb,trb,sb1,pg_temp.envelope(ca,1))) = 'no_change',
    'C: after contributor deletion the anonymized envelope re-pushes as no_change');
  PERFORM pg_temp.check(
    (SELECT to_jsonb(f) FROM public.reference_curated_forks f WHERE user_id=b AND curated_measurement_set_id=ca) = v_before,
    'C: fork row unchanged by stop sharing, hide and contributor deletion');
  PERFORM pg_temp.check(pg_temp.row_ok(b, ca, 1, ea - 'contributor') AND pg_temp.row_ok(c, ca, 1, ea - 'contributor'),
    'C: forks stay valid and label-free after contributor deletion');
END
$$;

-- RLS as the authenticated role (owner select + Stage M restrictive policy).
GRANT INSERT ON pg_temp.failures TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000f0a02","role":"authenticated"}', true) \g /dev/null
INSERT INTO pg_temp.failures
SELECT 'A/M: owner reads 3 contribution forks through RLS; the enhanced one is withheld'
 WHERE (SELECT count(*) FROM public.reference_curated_forks) <> 3
    OR EXISTS (SELECT 1 FROM public.reference_curated_forks
                WHERE reference_measurement_set_id = '7d000000-0000-4000-8000-0000000f0007');
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000f0a03","role":"authenticated"}', true) \g /dev/null
INSERT INTO pg_temp.failures
SELECT 'A: another user cannot read the copier''s forks'
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
