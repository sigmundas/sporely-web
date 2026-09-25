-- Durable SQL regression for set_observation_identification_v2 (Stage C
-- review round 2, item 4). Test-only: does not touch migrations or app code.
-- Follows the repo's existing raw-assert convention (supabase/tests/*_test.sql
-- wrapped in BEGIN/ROLLBACK, RAISE EXCEPTION on failure) — see
-- selected_taxon_noop_test.sql and shared_reference_contributions_test.sql.

BEGIN;

-- ── 1. Canonical A -> explicit NULL clear with replacement names ──────────
-- Also covers: identity/provenance columns after the clear, shared-reference
-- withdrawal, updated_at behaviour, and the canonical A->B positive control.

DO $$
DECLARE
  v_owner_id constant uuid := '00000000-0000-4000-8000-0000000ff001';
  v_other_id constant uuid := '00000000-0000-4000-8000-0000000ff002';
  v_taxon_a constant bigint := 2100001001;
  v_taxon_b constant bigint := 2100001002;
  v_obs_id constant bigint := 940010001;
  v_work_id constant uuid := '81000000-0000-4000-8000-000000000001';
  v_treatment_id constant uuid := '82000000-0000-4000-8000-000000000001';
  v_set_id constant uuid := '83000000-0000-4000-8000-000000000001';
  v_use_id constant uuid := '84000000-0000-4000-8000-000000000001';
  v_contribution_id uuid;
  v_row record;
  v_updated_at_before timestamptz;
  v_contribution_status text;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at) VALUES
    (v_owner_id,'authenticated','authenticated','idv2-owner@example.invalid','{}',now(),now()),
    (v_other_id,'authenticated','authenticated','idv2-other@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES
    (v_owner_id,'idv2_owner',false),
    (v_other_id,'idv2_other',false);

  INSERT INTO public.taxonomy_v2_releases(
    release_id,taxonomy_schema_version,export_schema_version,manifest_schema_version,
    exporter_version,scope_predicate_id,source_gz_sha256,source_sqlite_sha256,
    whole_export_sha256,manifest_sha256,generated_at,status,row_counts,
    authoritative_namespace_counts,legacy_source_counts,dangling_parent_count,
    dangling_parent_report,source_manifest
  ) VALUES (
    'tax-2099.02.01-01',2,1,1,'test','test',
    repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64),
    now(),'active','{}','{}','{}',0,'{}','{}'
  );
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id) VALUES
    (v_taxon_a,'tax-2099.02.01-01'),
    (v_taxon_b,'tax-2099.02.01-01');
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
    taxon_rank,canonical_source_system,canonical_external_id
  ) VALUES
    ('tax-2099.02.01-01',v_taxon_a,'Conocybe','rugosa','Conocybe rugosa','species','test','a-1'),
    ('tax-2099.02.01-01',v_taxon_b,'Amanita','muscaria','Amanita muscaria','species','test','b-1');
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES
    (v_taxon_a,'Conocybe rugosa','species','include','in_cache','tax-2099.02.01-01'),
    (v_taxon_b,'Amanita muscaria','species','include','in_cache','tax-2099.02.01-01');

  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,genus,species)
  OVERRIDING SYSTEM VALUE
  VALUES(v_obs_id,v_owner_id,current_date,'private',false,'Conocybe','rugosa');

  -- Picker selects A (the "canonical A" step).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_owner_id::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.set_observation_selected_taxon_v2(v_obs_id,v_taxon_a);
  RESET ROLE;

  SELECT selected_sporely_taxon_id,taxon_identity_state,genus,species,updated_at
    INTO v_row FROM public.observations WHERE id=v_obs_id;
  IF v_row.selected_sporely_taxon_id IS DISTINCT FROM v_taxon_a
     OR v_row.taxon_identity_state IS DISTINCT FROM 'sporely_v2' THEN
    RAISE EXCEPTION 'picker pick did not bind A: %', row_to_json(v_row);
  END IF;
  v_updated_at_before := v_row.updated_at;

  -- Seed a shared-reference contribution genuinely linked to this
  -- observation at A, so the withdrawal trigger has a real chain to walk
  -- (private.refresh_shared_references_for_observation_taxon only withdraws
  -- a contribution whose source_measurement_set_id matches an
  -- observation_reference_uses row for THIS observation at the OLD taxon).
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (v_owner_id,v_work_id,'article','[{"family":"Test"}]','Identification v2 regression',2026,'Test 2026',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (v_owner_id,v_treatment_id,v_work_id,'local-a','Conocybe rugosa',1);
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES (v_owner_id,v_set_id,v_treatment_id,'spore_size','8-10 x 5-6 um','range',8,10,5,6,1);
  -- Inserting the use (while the observation's identity is proven A, and A
  -- is a species-rank registry_concept) fires
  -- observation_reference_use_shared_contribution_trg ->
  -- private.share_reference_contribution_for_owner, which creates the
  -- shared_reference_contributions row itself — the real "share" path, not
  -- a hand-seeded row.
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json
  ) VALUES (v_owner_id,v_use_id,v_obs_id,v_set_id,'supports_identification',1,'{}'::jsonb);

  SELECT id,status INTO v_contribution_id,v_contribution_status
    FROM private.shared_reference_contributions
   WHERE owner_id=v_owner_id AND source_measurement_set_id=v_set_id AND sporely_taxon_id=v_taxon_a;
  IF v_contribution_id IS NULL THEN
    RAISE EXCEPTION 'seed failed: the use insert did not auto-share a contribution for A';
  END IF;
  IF v_contribution_status IS DISTINCT FROM 'shared' THEN
    RAISE EXCEPTION 'seed failed: auto-shared contribution is not shared (%)', v_contribution_status;
  END IF;

  -- The clear: A -> explicit NULL with replacement names, via the atomic RPC.
  SET LOCAL ROLE authenticated;
  PERFORM public.set_observation_identification_v2(
    v_obs_id, NULL, NULL, NULL, NULL, NULL, NULL,
    true, 'Funny', 'brown mushroom', NULL
  );
  RESET ROLE;

  SELECT selected_sporely_taxon_id,taxon_identity_state,taxon_identity_source_system,
         taxon_identity_namespace,taxon_identity_external_id,taxon_identity_raw_external_id,
         genus,species,updated_at
    INTO v_row FROM public.observations WHERE id=v_obs_id;

  IF v_row.selected_sporely_taxon_id IS NOT NULL THEN
    RAISE EXCEPTION 'clear did not null the identity: %', row_to_json(v_row);
  END IF;
  IF v_row.taxon_identity_state IS NOT NULL
     OR v_row.taxon_identity_source_system IS NOT NULL
     OR v_row.taxon_identity_namespace IS NOT NULL
     OR v_row.taxon_identity_external_id IS NOT NULL
     OR v_row.taxon_identity_raw_external_id IS NOT NULL THEN
    RAISE EXCEPTION 'clear left stray identity/provenance columns: %', row_to_json(v_row);
  END IF;
  IF v_row.genus IS DISTINCT FROM 'Funny' OR v_row.species IS DISTINCT FROM 'brown mushroom' THEN
    RAISE EXCEPTION 'clear did not write the replacement names: %', row_to_json(v_row);
  END IF;
  -- `public.set_updated_at()` stamps `now()`, which is frozen for the whole
  -- transaction — so within this single BEGIN/ROLLBACK test transaction two
  -- writes cannot be told apart by strict advancement. Assert the behaviour
  -- that IS observable here: the trigger still fired (updated_at stayed
  -- current, never NULL/stale) and never regressed.
  IF v_row.updated_at IS NULL OR v_row.updated_at < v_updated_at_before THEN
    RAISE EXCEPTION 'clear must not leave updated_at null or regressed: before=% after=%', v_updated_at_before, v_row.updated_at;
  END IF;

  -- Shared-reference withdrawal: the trigger must have flipped the
  -- contribution's status now that the observation's identity no longer
  -- names A.
  SELECT status INTO v_contribution_status
    FROM private.shared_reference_contributions WHERE id=v_contribution_id;
  IF v_contribution_status IS DISTINCT FROM 'withdrawn' THEN
    RAISE EXCEPTION 'shared-reference contribution was not withdrawn after the clear (status=%)', v_contribution_status;
  END IF;

  -- Non-owner denial (42501): a different authenticated user must not be
  -- able to call the RPC on this observation.
  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub',v_other_id::text,'role','authenticated')::text,true);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_observation_identification_v2(
      v_obs_id, v_taxon_a, 'sporely_v2', 'sporely', 'sporely_taxon_id', v_taxon_a::text, NULL,
      true, 'Hijack', 'attempt', NULL
    );
    RESET ROLE;
    RAISE EXCEPTION 'non-owner call must be denied but was not';
  EXCEPTION
    WHEN SQLSTATE '42501' THEN
      RESET ROLE;
      NULL; -- expected
  END;

  -- The rejected foreign call must not have touched the row.
  SELECT genus,species,selected_sporely_taxon_id INTO v_row
    FROM public.observations WHERE id=v_obs_id;
  IF v_row.genus IS DISTINCT FROM 'Funny' OR v_row.selected_sporely_taxon_id IS NOT NULL THEN
    RAISE EXCEPTION 'the rejected non-owner call mutated the row: %', row_to_json(v_row);
  END IF;

  -- Canonical A -> B positive control: the picker RPC still selects a NEW
  -- proven concept normally (never routed through a clear).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_owner_id::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  PERFORM public.set_observation_selected_taxon_v2(v_obs_id,v_taxon_b);
  RESET ROLE;
  SELECT selected_sporely_taxon_id,taxon_identity_state INTO v_row
    FROM public.observations WHERE id=v_obs_id;
  IF v_row.selected_sporely_taxon_id IS DISTINCT FROM v_taxon_b
     OR v_row.taxon_identity_state IS DISTINCT FROM 'sporely_v2' THEN
    RAISE EXCEPTION 'A->B control did not select B: %', row_to_json(v_row);
  END IF;

  RAISE NOTICE 'identification_v2 core regression: PASS';
END
$$;

-- ── 2. Rate-limit behaviour ─────────────────────────────────────────────────
-- A separate DO block/observation so the budget consumed above (from the
-- picker/clear/A->B calls) does not contaminate this specific measurement.

DO $$
DECLARE
  v_owner_id constant uuid := '00000000-0000-4000-8000-0000000ff003';
  v_taxon_a constant bigint := 2100001003;
  v_obs_id constant bigint := 940010002;
  v_row record;
  v_status_before_clear text;
  v_headers_before_clear text;
  v_updated_at_after_first timestamptz;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES (v_owner_id,'authenticated','authenticated','idv2-ratelimit@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (v_owner_id,'idv2_ratelimit',false);
  -- Reuse the active release the first DO block already created — only one
  -- taxonomy_v2_releases row may have status='active' at a time, and both
  -- DO blocks share this one transaction.
  INSERT INTO public.taxonomy_v2_concepts(sporely_taxon_id,first_seen_release_id)
  VALUES (v_taxon_a,'tax-2099.02.01-01');
  INSERT INTO public.taxonomy_v2_taxa(
    release_id,sporely_taxon_id,genus,specific_epithet,canonical_scientific_name,
    taxon_rank,canonical_source_system,canonical_external_id
  ) VALUES ('tax-2099.02.01-01',v_taxon_a,'Conocybe','rugosa','Conocybe rugosa','species','test','a-3');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,genus,species)
  OVERRIDING SYSTEM VALUE
  VALUES (v_obs_id,v_owner_id,current_date,'private',false,'Conocybe','rugosa');

  -- Force the limit to 1/minute for this transaction only (rolled back at
  -- the end — never a lasting change to the shared production policy row).
  UPDATE private.shared_reference_production_policy SET authenticated_requests_per_minute = 1;
  DELETE FROM private.shared_reference_rate_buckets;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub',v_owner_id::text,'role','authenticated')::text,true);
  SET LOCAL ROLE authenticated;
  -- Call 1: consumes the 1-request/minute budget; must succeed normally.
  PERFORM public.set_observation_selected_taxon_v2(v_obs_id,v_taxon_a);
  RESET ROLE;
  SELECT selected_sporely_taxon_id, updated_at INTO v_row FROM public.observations WHERE id=v_obs_id;
  IF v_row.selected_sporely_taxon_id IS DISTINCT FROM v_taxon_a THEN
    RAISE EXCEPTION 'rate-limit setup: call 1 should have succeeded, got %', row_to_json(v_row);
  END IF;
  v_updated_at_after_first := v_row.updated_at;

  -- Call 2 (the clear): must be rate-limited. The trigger cancels the row's
  -- own UPDATE (private.suppress_rate_limited_observation_taxon_update) and
  -- the statement-level guard sets response.status/response.headers, which
  -- the plain SQL call below can read directly via current_setting.
  SET LOCAL ROLE authenticated;
  PERFORM public.set_observation_identification_v2(
    v_obs_id, NULL, NULL, NULL, NULL, NULL, NULL, true, 'Funny', 'brown mushroom', NULL
  );
  RESET ROLE;

  v_status_before_clear := current_setting('response.status', true);
  v_headers_before_clear := current_setting('response.headers', true);
  IF v_status_before_clear IS DISTINCT FROM '429' THEN
    RAISE EXCEPTION 'expected response.status=429 during rate limiting, got %', v_status_before_clear;
  END IF;
  IF v_headers_before_clear IS NULL OR v_headers_before_clear NOT LIKE '%Retry-After%' THEN
    RAISE EXCEPTION 'expected a Retry-After response header, got %', v_headers_before_clear;
  END IF;

  -- The row itself must be UNCHANGED: the rate limiter suppressed the write.
  SELECT selected_sporely_taxon_id,genus,species,updated_at INTO v_row
    FROM public.observations WHERE id=v_obs_id;
  IF v_row.selected_sporely_taxon_id IS DISTINCT FROM v_taxon_a
     OR v_row.genus IS DISTINCT FROM 'Conocybe'
     OR v_row.species IS DISTINCT FROM 'rugosa'
     OR v_row.updated_at IS DISTINCT FROM v_updated_at_after_first THEN
    RAISE EXCEPTION 'rate-limited clear must not change the row at all, got %', row_to_json(v_row);
  END IF;

  RAISE NOTICE 'identification_v2 rate-limit regression: PASS (row unchanged, HTTP 429 signalled via response.status/headers)';
END
$$;

ROLLBACK;
