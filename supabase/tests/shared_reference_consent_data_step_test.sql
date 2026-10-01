-- Stage 2a data step (decision A), migration
-- 20260930224506_fail_closed_reference_sharing_consent.sql step 3. The
-- statement below is the migration's statement verbatim. After the
-- migration no unconsented shared row can exist (CHECK), so the fixture
-- drops the consent CHECKs inside this rolled-back transaction to recreate
-- the pre-migration state. Since Stage 2d (20261001113007) the CHECK is
-- shared_iff_basis (a shared row needs a share basis), so that is the one
-- dropped and restored here; an unconsented shared row is one without a
-- basis.

BEGIN;

DO $$
DECLARE
  v_owner constant uuid := '00000000-0000-4000-8000-00000000d201';
  v_taxon constant integer := 2100000961;
  v_unconsented uuid[];
  v_consented uuid;
  v_withdrawn uuid;
  v_before jsonb;
  v_events bigint;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES (v_owner,'authenticated','authenticated','data-step@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (v_owner,'data_step',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (v_taxon,'Amanita datastepensis','species','include','in_cache','data-step-test');

  ALTER TABLE private.shared_reference_contributions
    DROP CONSTRAINT shared_reference_contributions_shared_iff_basis;

  -- Two pre-2a shares (as in production), one consented row and one
  -- withdrawn row.
  WITH ins AS (
    INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status)
    SELECT v_owner,gen_random_uuid(),v_taxon,'shared' FROM generate_series(1,2)
    RETURNING id
  ) SELECT array_agg(id ORDER BY id) INTO v_unconsented FROM ins;
  INSERT INTO private.shared_reference_contribution_revisions(
    contribution_id,revision,source_work_revision,source_treatment_revision,
    source_measurement_set_revision,content_hash,envelope_json)
  SELECT id,1,1,1,1,repeat('a',64),jsonb_build_object('contribution_id',id,'revision',1,'status','shared')
    FROM unnest(v_unconsented) id;
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,
    share_basis,shared_first_revision,
    consented_at,consent_version,consent_locale,consent_first_revision,consent_scope)
  VALUES (v_owner,gen_random_uuid(),v_taxon,'shared','consented',1,now(),1,'en',1,'{"snapshot_schema_versions":[1],"data_kinds":[]}')
  RETURNING id INTO v_consented;
  INSERT INTO private.shared_reference_contributions(owner_id,source_measurement_set_id,sporely_taxon_id,status,withdrawn_at)
  VALUES (v_owner,gen_random_uuid(),v_taxon,'withdrawn',now()-interval '1 day')
  RETURNING id INTO v_withdrawn;

  -- Reads never serve an unconsented shared row, even without the CHECK.
  IF EXISTS (SELECT 1 FROM private.search_public_reference_contributions_v2_unthrottled(v_taxon,100,NULL,NULL) item
              WHERE (item->>'contribution_id')::uuid = ANY(v_unconsented))
     OR EXISTS (SELECT 1 FROM private.get_public_reference_contribution_v2_unthrottled(v_unconsented[1],1))
     OR EXISTS (SELECT 1 FROM private.get_public_reference_contribution_v2_unthrottled(v_unconsented[1],NULL)) THEN
    RAISE EXCEPTION 'an unconsented shared row was served';
  END IF;

  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) INTO v_before
    FROM private.shared_reference_contributions c WHERE c.id IN (v_consented, v_withdrawn);
  SELECT count(*) INTO v_events FROM private.shared_reference_consent_events;

  -- Migration step 3, verbatim.
  PERFORM private.withdraw_shared_reference_contribution(c.id, 'consent_missing')
    FROM private.shared_reference_contributions c
   WHERE c.status = 'shared' AND c.consented_at IS NULL
   ORDER BY c.owner_id, c.source_measurement_set_id, c.sporely_taxon_id, c.id;

  IF EXISTS (SELECT 1 FROM private.shared_reference_contributions c
              WHERE c.id = ANY(v_unconsented) AND (c.status <> 'withdrawn' OR c.withdrawn_at IS NULL))
     OR (SELECT count(*) FROM private.shared_reference_consent_events e
          WHERE e.contribution_id = ANY(v_unconsented)
            AND e.event='withdrawn_by_system' AND e.reason='consent_missing' AND e.consent_version IS NULL) <> 2
     OR (SELECT count(*) FROM private.shared_reference_consent_events) <> v_events + 2
     OR (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM private.shared_reference_contributions c
          WHERE c.id IN (v_consented, v_withdrawn)) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'data step did not withdraw exactly the unconsented shared rows';
  END IF;
  -- The withdrawal publishes nothing: no revision was added.
  IF (SELECT count(*) FROM private.shared_reference_contribution_revisions r
       WHERE r.contribution_id = ANY(v_unconsented)) <> 2 THEN
    RAISE EXCEPTION 'data step wrote revisions';
  END IF;

  -- A second run changes nothing.
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) INTO v_before FROM private.shared_reference_contributions c;
  SELECT count(*) INTO v_events FROM private.shared_reference_consent_events;
  PERFORM private.withdraw_shared_reference_contribution(c.id, 'consent_missing')
    FROM private.shared_reference_contributions c
   WHERE c.status = 'shared' AND c.consented_at IS NULL
   ORDER BY c.owner_id, c.source_measurement_set_id, c.sporely_taxon_id, c.id;
  IF (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM private.shared_reference_contributions c)
       IS DISTINCT FROM v_before
     OR (SELECT count(*) FROM private.shared_reference_consent_events) <> v_events THEN
    RAISE EXCEPTION 'a second data-step run changed something';
  END IF;

  -- The CHECK is restorable over the result, as the migration's step 4 needs.
  ALTER TABLE private.shared_reference_contributions
    ADD CONSTRAINT shared_reference_contributions_shared_iff_basis
    CHECK (CASE WHEN status = 'shared'
                THEN share_basis IS NOT NULL AND shared_first_revision IS NOT NULL
                     AND (share_basis = 'consented') = (consented_at IS NOT NULL)
                ELSE share_basis IS NULL AND shared_first_revision IS NULL
                     AND consented_at IS NULL
           END);
END
$$;

ROLLBACK;
