-- Stage 2b (server): the explicit opt-in RPCs of
-- 20260930232633_add_reference_sharing_consent_grant.sql.
--
-- Uses the shipped version-1 consent texts, activated inside this rolled-back
-- transaction (they ship inactive).

BEGIN;

CREATE FUNCTION pg_temp.as_user(p_sub uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_sub IS NULL THEN '' ELSE json_build_object('sub',p_sub::text,'role','authenticated')::text END, true)
$$;

-- Calls the public grant RPC as p_owner with the set's current revisions
-- unless given.
CREATE FUNCTION pg_temp.grant_as(
  p_owner uuid, p_set uuid, p_taxon integer, p_locale text DEFAULT 'en',
  p_version integer DEFAULT 1, p_set_revision integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; v jsonb;
BEGIN
  SELECT w.revision AS w, t.revision AS t, m.revision AS m INTO r
    FROM public.reference_measurement_sets m
    JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
    JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
   WHERE m.id=p_set;
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM pg_temp.as_user(p_owner);
  SET LOCAL ROLE authenticated;
  v := public.share_reference_contribution_with_consent(
    p_set,p_taxon,coalesce(r.w,1),coalesce(r.t,1),coalesce(p_set_revision,r.m,1),
    p_version,p_locale,'test-client');
  RESET ROLE;
  RETURN v;
END
$$;

CREATE FUNCTION pg_temp.list_as(p_owner uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM pg_temp.as_user(p_owner);
  SET LOCAL ROLE authenticated;
  v := public.list_my_shared_reference_contributions();
  RESET ROLE;
  RETURN v;
END
$$;

CREATE FUNCTION pg_temp.public_revisions(p_id uuid) RETURNS integer[] LANGUAGE plpgsql AS $$
DECLARE v integer[]; i integer;
BEGIN
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM pg_temp.as_user(NULL);
  FOR i IN 1..12 LOOP
    IF EXISTS (SELECT 1 FROM public.get_public_reference_contribution(p_id,i) item
                WHERE item->>'status'='shared') THEN
      v := v || i;
    END IF;
  END LOOP;
  RETURN v;
END
$$;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000f201';
  owner_b constant uuid := '00000000-0000-4000-8000-00000000f202';
  t_species constant integer := 2100000951;
  t_other constant integer := 2100000952;
  t_genus constant integer := 2100000953;
  t_unregistered constant bigint := 2100000954;  -- species in taxonomy v2, not in the registry (617026/55368-like)
  v_rel constant text := 'tax-2099.10.02-01';
  w constant uuid := '71000000-0000-4000-8000-00000000f201';
  tr constant uuid := '72000000-0000-4000-8000-00000000f201';
  s_pub constant uuid := '73000000-0000-4000-8000-00000000f201';
  s_priv constant uuid := '73000000-0000-4000-8000-00000000f202';
  s_friends constant uuid := '73000000-0000-4000-8000-00000000f203';
  s_draft constant uuid := '73000000-0000-4000-8000-00000000f204';
  s_spore constant uuid := '73000000-0000-4000-8000-00000000f205';
  s_unreg constant uuid := '73000000-0000-4000-8000-00000000f206';
  s_multi constant uuid := '73000000-0000-4000-8000-00000000f207';
  s_b constant uuid := '73000000-0000-4000-8000-00000000f208';
  v_text private.reference_share_consent_texts%ROWTYPE;
  r jsonb;
  c private.shared_reference_contributions%ROWTYPE;
  v_id uuid;
  v_multi_id uuid;
  v_events bigint;
  v_rev integer;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (owner_a,'authenticated','authenticated','grant-a@example.invalid','{}',now(),now()),
    (owner_b,'authenticated','authenticated','grant-b@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (owner_a,'grant_a',false),(owner_b,'grant_b',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES
    (t_species,'Amanita consentiens','species','include','in_cache','grant-test'),
    (t_other,'Amanita altera','species','include','in_cache','grant-test'),
    (t_genus,'Amanita','genus','include','in_cache','grant-test');
  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
    exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
    whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
    authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
    dangling_parent_report,source_manifest
  ) VALUES (v_rel,2,1,1,'test','test',repeat('a',64),repeat('b',64),repeat('c',64),repeat('d',64),
     now(),'retired','{}','{}','{}',0,'{}','{}');
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) VALUES (t_unregistered,v_rel);
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
    taxon_rank,canonical_source_system,canonical_external_id
  ) VALUES (v_rel,t_unregistered,'Conocybe','privata','Conocybe privata','species','col_xr','GRT1');

  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES
    (962000001,owner_a,current_date,'public',false,'public',t_species),
    (962000002,owner_a,current_date,'private',false,'public',t_species),
    (962000003,owner_a,current_date,'friends',false,'public',t_species),
    (962000004,owner_a,current_date,'public',true,'public',t_species),
    (962000005,owner_a,current_date,'public',false,'private',t_species),
    (962000007,owner_a,current_date,'public',false,'public',t_species),
    (962000008,owner_a,current_date,'public',false,'public',t_other),
    (962000009,owner_b,current_date,'public',false,'public',t_species);
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,selected_sporely_taxon_id,taxon_identity_state)
  OVERRIDING SYSTEM VALUE VALUES
    (962000006,owner_a,current_date,'public',false,'public',t_unregistered,'sporely_v2');
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (owner_a,w,'article','[{"family":"Consent"}]','Grant test',2026,'Consent 2026',1),
         (owner_b,'71000000-0000-4000-8000-00000000f202','article','[{"family":"Other"}]','Other',2026,'Other 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (owner_a,tr,w,'g','Amanita consentiens',1),
         (owner_b,'72000000-0000-4000-8000-00000000f202','71000000-0000-4000-8000-00000000f202','g','Amanita consentiens',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  SELECT owner_a,s,tr,'spore_size','range','8-10 um',1
    FROM unnest(ARRAY[s_pub,s_priv,s_friends,s_draft,s_spore,s_unreg,s_multi]) s;
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  VALUES (owner_b,s_b,'72000000-0000-4000-8000-00000000f202','spore_size','range','9-11 um',1);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  SELECT u.owner,gen_random_uuid(),u.obs,u.s,'compared',1,private.reference_canonical_snapshot(u.owner,u.s)
    FROM (VALUES (owner_a,962000001::bigint,s_pub),(owner_a,962000002,s_priv),(owner_a,962000003,s_friends),
                 (owner_a,962000004,s_draft),(owner_a,962000005,s_spore),(owner_a,962000006,s_unreg),
                 (owner_a,962000007,s_multi),(owner_a,962000008,s_multi),(owner_b,962000009,s_b))
         AS u(owner,obs,s);

  -- ── 1. Shipped texts are inactive: nothing can be granted ──
  r := pg_temp.grant_as(owner_a,s_pub,t_species);
  IF r->>'status' <> 'consent_text_unavailable'
     OR EXISTS (SELECT 1 FROM private.shared_reference_contributions)
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events) THEN
    RAISE EXCEPTION 'grant with the inactive shipped text was not refused: %', r;
  END IF;
  PERFORM pg_temp.as_user(owner_a);
  SET LOCAL ROLE authenticated;
  IF public.get_reference_share_consent_text('en')->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'an inactive consent text was served';
  END IF;
  RESET ROLE;

  UPDATE private.reference_share_consent_texts SET active=true WHERE version=1 AND locale='en';
  SELECT * INTO v_text FROM private.reference_share_consent_texts WHERE version=1 AND locale='en';

  -- ── 2. The consent text RPC ──
  DELETE FROM private.shared_reference_rate_buckets;
  PERFORM pg_temp.as_user(owner_a);
  SET LOCAL ROLE authenticated;
  r := public.get_reference_share_consent_text('en');
  IF r->>'status' <> 'ok' OR (r->>'version')::integer <> 1 OR r->>'locale' <> 'en'
     OR r->>'text' <> v_text.text OR r->>'text_sha256' <> v_text.text_sha256
     OR r->'scope' <> v_text.scope
     OR public.get_reference_share_consent_text('nb')->>'status' <> 'not_found'
     OR public.get_reference_share_consent_text('de')->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'consent text RPC wrong: %', r;
  END IF;
  RESET ROLE;
  PERFORM pg_temp.as_user(NULL);
  BEGIN
    PERFORM public.get_reference_share_consent_text('en');
    RAISE EXCEPTION 'consent text served without a session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ── 3. Refusals change nothing ──
  IF pg_temp.grant_as(owner_a,s_pub,t_species,'nb')->>'status' <> 'consent_text_unavailable'
     OR pg_temp.grant_as(owner_a,s_pub,t_species,'de')->>'status' <> 'consent_text_unavailable'
     OR pg_temp.grant_as(owner_a,s_pub,t_species,'en',2)->>'status' <> 'consent_text_unavailable'
     OR pg_temp.grant_as(owner_a,s_pub,t_species,'en',1,2)->>'status' <> 'revision_mismatch'
     OR pg_temp.grant_as(owner_a,s_priv,t_species)->>'status' <> 'qualifying_use_required'
     OR pg_temp.grant_as(owner_a,s_friends,t_species)->>'status' <> 'qualifying_use_required'
     OR pg_temp.grant_as(owner_a,s_draft,t_species)->>'status' <> 'qualifying_use_required'
     OR pg_temp.grant_as(owner_a,s_spore,t_species)->>'status' <> 'qualifying_use_required'
     OR pg_temp.grant_as(owner_a,s_pub,t_other)->>'status' <> 'qualifying_use_required'
     OR pg_temp.grant_as(owner_a,s_unreg,t_unregistered::integer)->>'status' <> 'invalid_taxon'
     OR pg_temp.grant_as(owner_a,s_pub,t_genus)->>'status' <> 'invalid_taxon'
     -- Another account's set: the owner is always the caller, so B cannot
     -- share A's set.
     OR pg_temp.grant_as(owner_b,s_pub,t_species)->>'status' <> 'source_not_found_or_stale' THEN
    RAISE EXCEPTION 'a grant refusal returned the wrong status';
  END IF;
  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions)
     OR EXISTS (SELECT 1 FROM private.shared_reference_consent_events) THEN
    RAISE EXCEPTION 'a refused grant changed state';
  END IF;
  PERFORM pg_temp.as_user(NULL);
  BEGIN
    PERFORM public.share_reference_contribution_with_consent(s_pub,t_species,1,1,1,1,'en');
    RAISE EXCEPTION 'grant accepted without a session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ── 4. A grant: consent recorded from the snapshot, public, own event ──
  r := pg_temp.grant_as(owner_a,s_pub,t_species);
  v_id := (r->'row'->>'contribution_id')::uuid;
  SELECT * INTO c FROM private.shared_reference_contributions WHERE id=v_id;
  IF r->>'status' <> 'created' OR c.status <> 'shared' OR c.owner_id <> owner_a
     OR c.consent_version <> 1 OR c.consent_first_revision <> 1 OR c.current_revision <> 1
     OR c.consent_client <> 'test-client' OR c.consented_at IS NULL
     OR c.consent_scope <> private.reference_share_snapshot_scope(r->'row'->'snapshot')
     OR c.consent_scope = v_text.scope
     OR NOT private.reference_share_scope_within(c.consent_scope, v_text.scope) THEN
    RAISE EXCEPTION 'grant did not record the consent from the snapshot: % %', r, to_jsonb(c);
  END IF;
  IF (SELECT array_agg(e.event||':'||e.consent_version||':'||e.locale||':'||e.text_sha256)
        FROM private.shared_reference_consent_events e WHERE e.contribution_id=v_id)
     IS DISTINCT FROM ARRAY['granted:1:en:'||v_text.text_sha256] THEN
    RAISE EXCEPTION 'grant event missing locale or text hash';
  END IF;
  IF pg_temp.public_revisions(v_id) IS DISTINCT FROM ARRAY[1] THEN
    RAISE EXCEPTION 'granted revision is not public';
  END IF;
  -- Granting again unchanged renews consent within the period.
  r := pg_temp.grant_as(owner_a,s_pub,t_species);
  IF r->>'status' <> 'no_change'
     OR (SELECT consent_first_revision FROM private.shared_reference_contributions WHERE id=v_id) <> 1 THEN
    RAISE EXCEPTION 'renewed grant changed the consent period: %', r;
  END IF;

  -- ── 5. A revision beyond the granted scope withdraws ──
  -- The grant covered a snapshot without raw points; adding them exceeds it.
  PERFORM pg_temp.as_user(owner_a);
  v_events := (SELECT max(id) FROM private.shared_reference_consent_events);
  UPDATE public.reference_measurement_sets
     SET raw_points_json='[{"length":8.2,"width":5.1,"q":1.61}]',revision=revision+1,row_version=row_version+1
   WHERE user_id=owner_a AND id=s_pub;
  SELECT * INTO c FROM private.shared_reference_contributions WHERE id=v_id;
  IF c.status <> 'withdrawn' OR c.current_revision <> 1
     OR (SELECT array_agg(e.event||':'||e.reason) FROM private.shared_reference_consent_events e
          WHERE e.id>v_events) IS DISTINCT FROM ARRAY['withdrawn_by_system:consent_scope_exceeded']
     OR pg_temp.public_revisions(v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'out-of-scope revision was not withdrawn: %', to_jsonb(c);
  END IF;

  -- ── 6. Re-grant starts a new consent period; older revisions stay unserved ──
  r := pg_temp.grant_as(owner_a,s_pub,t_species);
  SELECT * INTO c FROM private.shared_reference_contributions WHERE id=v_id;
  IF r->>'status' <> 'updated' OR c.status <> 'shared' OR c.current_revision <> 2
     OR c.consent_first_revision <> 2
     OR NOT (c.consent_scope->'data_kinds') @> '["raw_points"]'
     OR pg_temp.public_revisions(v_id) IS DISTINCT FROM ARRAY[2] THEN
    RAISE EXCEPTION 're-grant did not start a new consent period: % %', r, to_jsonb(c);
  END IF;

  -- ── 7. hidden_at is never cleared by a grant ──
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SET LOCAL ROLE service_role;
  r := public.moderate_shared_reference_contribution(v_id,'hide','privacy');
  RESET ROLE;
  PERFORM pg_temp.as_user(owner_a);
  SET LOCAL ROLE authenticated;
  r := public.withdraw_reference_contribution(v_id);
  RESET ROLE;
  r := pg_temp.grant_as(owner_a,s_pub,t_species);
  SELECT * INTO c FROM private.shared_reference_contributions WHERE id=v_id;
  IF r->>'status' <> 'updated' OR c.status <> 'shared' OR c.hidden_at IS NULL
     OR c.hidden_reason <> 'privacy' OR pg_temp.public_revisions(v_id) IS NOT NULL THEN
    RAISE EXCEPTION 'grant cleared hidden_at or exposed a hidden row: %', to_jsonb(c);
  END IF;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SET LOCAL ROLE service_role;
  r := public.moderate_shared_reference_contribution(v_id,'restore',NULL);
  RESET ROLE;

  -- ── 8. Banned and deleting accounts cannot grant ──
  UPDATE public.profiles SET is_banned=true WHERE id=owner_a;
  IF pg_temp.grant_as(owner_a,s_multi,t_species)->>'status' <> 'account_unavailable' THEN
    RAISE EXCEPTION 'a banned account could grant';
  END IF;
  UPDATE public.profiles SET is_banned=false WHERE id=owner_a;
  INSERT INTO private.reference_account_deletions(user_id) VALUES (owner_b);
  IF pg_temp.grant_as(owner_b,s_b,t_species)->>'status' <> 'account_unavailable' THEN
    RAISE EXCEPTION 'a deleting account could grant';
  END IF;
  DELETE FROM private.reference_account_deletions WHERE user_id=owner_b;

  -- ── 9. A revoked text version cannot be granted ──
  UPDATE private.reference_share_consent_texts SET active=false, revoked=true WHERE version=1 AND locale='en';
  IF pg_temp.grant_as(owner_a,s_multi,t_species)->>'status' <> 'consent_text_unavailable' THEN
    RAISE EXCEPTION 'a revoked text could be granted';
  END IF;
  UPDATE private.reference_share_consent_texts SET active=true, revoked=false WHERE version=1 AND locale='en';

  -- ── 10. Withdrawal reasons: losing the last use is use_detached, even when
  -- other uses of the set remain on other taxa; an observation delete too ──
  r := pg_temp.grant_as(owner_a,s_multi,t_species);
  v_multi_id := (r->'row'->>'contribution_id')::uuid;
  IF r->>'status' <> 'created' THEN
    RAISE EXCEPTION 'multi-use grant failed: %', r;
  END IF;
  v_events := (SELECT max(id) FROM private.shared_reference_consent_events);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  UPDATE public.observation_reference_uses SET deleted_at=now()
   WHERE user_id=owner_a AND observation_id=962000007;
  IF (SELECT array_agg(e.event||':'||e.reason) FROM private.shared_reference_consent_events e
       WHERE e.id>v_events) IS DISTINCT FROM ARRAY['withdrawn_by_system:use_detached'] THEN
    RAISE EXCEPTION 'last-use detach not labelled use_detached: %',
      (SELECT array_agg(e.reason) FROM private.shared_reference_consent_events e WHERE e.id>v_events);
  END IF;
  UPDATE public.observation_reference_uses SET deleted_at=NULL
   WHERE user_id=owner_a AND observation_id=962000007;
  r := pg_temp.grant_as(owner_a,s_multi,t_species);
  v_events := (SELECT max(id) FROM private.shared_reference_consent_events);
  PERFORM pg_temp.as_user(owner_a);
  DELETE FROM public.observations WHERE id=962000007 AND user_id=owner_a;
  IF (SELECT array_agg(e.event||':'||e.reason) FROM private.shared_reference_consent_events e
       WHERE e.id>v_events) IS DISTINCT FROM ARRAY['withdrawn_by_system:use_detached']
     OR (SELECT status FROM private.shared_reference_contributions WHERE id=v_multi_id) <> 'withdrawn' THEN
    RAISE EXCEPTION 'observation delete did not withdraw as use_detached';
  END IF;

  -- ── 11. The scope decision is not swallowed: when the withdrawal itself
  -- fails, the edit aborts instead of leaving the share public ──
  CREATE FUNCTION pg_temp.fail_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN RAISE EXCEPTION 'injected withdrawal failure' USING ERRCODE='P0001'; END $f$;
  CREATE TRIGGER inject_withdrawal_failure BEFORE UPDATE ON private.shared_reference_contributions
    FOR EACH ROW WHEN (NEW.status='withdrawn') EXECUTE FUNCTION pg_temp.fail_withdrawal();
  r := pg_temp.grant_as(owner_b,s_b,t_species);
  IF r->>'status' <> 'created' THEN
    RAISE EXCEPTION 'owner B grant failed: %', r;
  END IF;
  PERFORM pg_temp.as_user(owner_b);
  BEGIN
    UPDATE public.reference_measurement_sets
       SET raw_points_json='[{"length":9.2,"width":5.1,"q":1.8}]',revision=revision+1,row_version=row_version+1
     WHERE user_id=owner_b AND id=s_b;
    RAISE EXCEPTION 'an out-of-scope edit succeeded although its withdrawal failed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'injected withdrawal failure' THEN RAISE; END IF;
  END;
  IF (SELECT status||':'||current_revision FROM private.shared_reference_contributions
       WHERE owner_id=owner_b) <> 'shared:1'
     OR (SELECT revision FROM public.reference_measurement_sets WHERE id=s_b) <> 1 THEN
    RAISE EXCEPTION 'failed withdrawal left partial state';
  END IF;
  DROP TRIGGER inject_withdrawal_failure ON private.shared_reference_contributions;

  -- ── 12. The owner list ──
  r := pg_temp.list_as(owner_a);
  IF r->>'status' <> 'ok'
     OR jsonb_array_length(r->'contributions') <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r->'contributions') x
                 WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k)
                       <> ARRAY['canonical_scientific_name','contribution_id','current_revision',
                                'hidden_at','shared_at','source_raw_text','source_short_label',
                                'sporely_taxon_id','status','withdrawal_reason','withdrawn_at'])
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'contributions') x
                     WHERE x->>'contribution_id'=v_id::text AND x->>'status'='shared'
                       AND x->>'canonical_scientific_name'='Amanita consentiens'
                       AND (x->>'sporely_taxon_id')::integer=t_species
                       AND (x->>'current_revision')::integer=3 AND x->'withdrawn_at'='null'::jsonb)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'contributions') x
                     WHERE x->>'contribution_id'=v_multi_id::text AND x->>'status'='withdrawn'
                       AND x->>'withdrawn_at' IS NOT NULL AND x->>'withdrawal_reason'='use_detached'
                       AND x->>'source_short_label'='Consent 2026' AND x->>'source_raw_text'='8-10 um')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(r->'contributions') x
                 WHERE x->>'status'='shared' AND (x->'withdrawal_reason' <> 'null'::jsonb
                                                  OR x->'hidden_at' <> 'null'::jsonb))
     OR r::text LIKE '%'||owner_a::text||'%'
     OR r::text LIKE '%'||s_pub::text||'%' THEN
    RAISE EXCEPTION 'owner list wrong: %', r;
  END IF;
  -- B sees only B's row, never A's.
  r := pg_temp.list_as(owner_b);
  IF r->>'status' <> 'ok' OR jsonb_array_length(r->'contributions') <> 1
     OR r->'contributions'->0->>'contribution_id' <>
        (SELECT id::text FROM private.shared_reference_contributions WHERE owner_id=owner_b) THEN
    RAISE EXCEPTION 'list leaked another account''s rows: %', r;
  END IF;
  PERFORM pg_temp.as_user(NULL);
  BEGIN
    PERFORM public.list_my_shared_reference_contributions();
    RAISE EXCEPTION 'list served without a session';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A hidden row shows hidden_at to its owner.
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SET LOCAL ROLE service_role;
  r := public.moderate_shared_reference_contribution(v_id,'hide','abuse');
  RESET ROLE;
  IF (SELECT x->>'hidden_at' FROM jsonb_array_elements(pg_temp.list_as(owner_a)->'contributions') x
       WHERE x->>'contribution_id'=v_id::text) IS NULL THEN
    RAISE EXCEPTION 'list does not show hidden_at';
  END IF;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SET LOCAL ROLE service_role;
  r := public.moderate_shared_reference_contribution(v_id,'restore',NULL);
  RESET ROLE;

  -- ── 13. Consent-text revocation (operator step) ──
  UPDATE private.reference_share_consent_texts SET active=true WHERE version=1 AND locale='nb';
  -- A row consented under nb: s_multi still has a public use of t_other.
  r := pg_temp.grant_as(owner_a,s_multi,t_other,'nb');
  IF r->>'status' <> 'created'
     OR (SELECT consent_locale FROM private.shared_reference_contributions
          WHERE source_measurement_set_id=s_multi AND sporely_taxon_id=t_other) <> 'nb'
     OR (SELECT consent_locale FROM private.shared_reference_contributions WHERE id=v_id) <> 'en' THEN
    RAISE EXCEPTION 'consent_locale not recorded: %', r;
  END IF;
  v_events := (SELECT max(id) FROM private.shared_reference_consent_events);
  PERFORM pg_temp.as_user(NULL);
  IF private.revoke_reference_share_consent_text(1,'en') <> 2 THEN
    RAISE EXCEPTION 'revocation did not withdraw exactly the two en rows';
  END IF;
  IF (SELECT array_agg(e.event||':'||e.reason ORDER BY e.id) FROM private.shared_reference_consent_events e
       WHERE e.id>v_events)
     IS DISTINCT FROM ARRAY['withdrawn_by_system:consent_text_revoked','withdrawn_by_system:consent_text_revoked']
     OR (SELECT status FROM private.shared_reference_contributions WHERE id=v_id) <> 'withdrawn'
     OR (SELECT status FROM private.shared_reference_contributions WHERE owner_id=owner_b) <> 'withdrawn'
     OR (SELECT status FROM private.shared_reference_contributions
          WHERE source_measurement_set_id=s_multi AND sporely_taxon_id=t_other) <> 'shared'
     OR NOT (SELECT revoked AND NOT active FROM private.reference_share_consent_texts WHERE version=1 AND locale='en') THEN
    RAISE EXCEPTION 'revocation touched the wrong rows';
  END IF;
  v_events := (SELECT max(id) FROM private.shared_reference_consent_events);
  IF private.revoke_reference_share_consent_text(1,'en') <> 0
     OR (SELECT max(id) FROM private.shared_reference_consent_events) <> v_events THEN
    RAISE EXCEPTION 'revocation is not idempotent';
  END IF;
  IF pg_temp.grant_as(owner_a,s_pub,t_species)->>'status' <> 'consent_text_unavailable' THEN
    RAISE EXCEPTION 'a revoked text could be granted after revocation';
  END IF;
  -- A text revoked without the operator step: the next refresh withdraws.
  UPDATE private.reference_share_consent_texts SET revoked=true, active=false WHERE version=1 AND locale='nb';
  PERFORM pg_temp.as_user(owner_a);
  UPDATE public.reference_measurement_sets SET raw_text='8-10.5 um',revision=revision+1,row_version=row_version+1
   WHERE user_id=owner_a AND id=s_multi;
  IF (SELECT array_agg(e.event||':'||e.reason) FROM private.shared_reference_consent_events e WHERE e.id>v_events)
     IS DISTINCT FROM ARRAY['withdrawn_by_system:consent_text_revoked'] THEN
    RAISE EXCEPTION 'refresh under a revoked text did not withdraw';
  END IF;
  IF (private.reference_contribution_share_core('refresh',owner_a,s_multi,t_other)->>'status') <> 'consent_required' THEN
    RAISE EXCEPTION 'refresh re-shared a revoked row';
  END IF;

  -- ── 14. Stage 1B labels each observation by its own contribution ──
  -- P1's contribution was withdrawn earlier (owner); P2's is withdrawn by
  -- the promotion's own taxon trigger. Both in this transaction: only P2 is
  -- 'withdrawn'.
  INSERT INTO private.reference_share_consent_texts(version,locale,text,text_sha256,active,scope)
  VALUES (2,'en','fixture v2',encode(sha256(convert_to('fixture v2','UTF8')),'hex'),true,
          '{"snapshot_schema_versions":[1],"data_kinds":["raw_points","free_text","measurement_details"]}');
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) VALUES (t_other,v_rel);
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,spore_data_visibility,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES
    (962000011,owner_a,current_date,'public',false,'public',t_species),
    (962000012,owner_a,current_date,'public',false,'public',t_species);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  VALUES (owner_a,'73000000-0000-4000-8000-00000000f211',tr,'spore_size','range','7-9 um',1),
         (owner_a,'73000000-0000-4000-8000-00000000f212',tr,'spore_size','range','7-9 um',1);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  VALUES (owner_a,gen_random_uuid(),962000011,'73000000-0000-4000-8000-00000000f211','compared',1,
          private.reference_canonical_snapshot(owner_a,'73000000-0000-4000-8000-00000000f211')),
         (owner_a,gen_random_uuid(),962000012,'73000000-0000-4000-8000-00000000f212','compared',1,
          private.reference_canonical_snapshot(owner_a,'73000000-0000-4000-8000-00000000f212'));
  IF pg_temp.grant_as(owner_a,'73000000-0000-4000-8000-00000000f211',t_species,'en',2)->>'status' <> 'created'
     OR pg_temp.grant_as(owner_a,'73000000-0000-4000-8000-00000000f212',t_species,'en',2)->>'status' <> 'created' THEN
    RAISE EXCEPTION '1B fixture grants failed';
  END IF;
  v_id := (SELECT id FROM private.shared_reference_contributions
             WHERE source_measurement_set_id='73000000-0000-4000-8000-00000000f211');
  PERFORM pg_temp.as_user(owner_a);
  SET LOCAL ROLE authenticated;
  r := public.withdraw_reference_contribution(v_id);
  RESET ROLE;
  PERFORM pg_temp.as_user(NULL);
  UPDATE public.observations SET selected_sporely_taxon_id=t_other, taxon_identity_state='sporely_v2'
   WHERE id IN (962000011,962000012);
  INSERT INTO private.taxon_identity_repair_runs(release_id,plan_sha256,candidate_count,promoted_count,outcome_counts)
  VALUES (v_rel,repeat('e',64),2,2,'{}') RETURNING run_id INTO v_rev;
  PERFORM private._taxon_identity_repair_reconcile_references(v_rev,962000011);
  PERFORM private._taxon_identity_repair_reconcile_references(v_rev,962000012);
  IF (SELECT array_agg(a.observation_id||':'||a.old_contribution ORDER BY a.observation_id)
        FROM private.taxon_identity_repair_reference_actions a WHERE a.run_id=v_rev)
     IS DISTINCT FROM ARRAY['962000011:none','962000012:withdrawn'] THEN
    RAISE EXCEPTION '1B labels not tied to the observation''s own contribution: %',
      (SELECT array_agg(a.observation_id||':'||a.old_contribution) FROM private.taxon_identity_repair_reference_actions a WHERE a.run_id=v_rev);
  END IF;
END
$$;

ROLLBACK;
