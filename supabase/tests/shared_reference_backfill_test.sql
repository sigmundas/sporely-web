-- Replay-safe historical shared-contribution backfill contract.

BEGIN;

DO $$
DECLARE
  v_owner_id constant uuid := '00000000-0000-4000-8000-00000000cb01';
  taxon_id constant integer := 2100000991;
  first_result jsonb;
  replay_result jsonb;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES(v_owner_id,'authenticated','authenticated','backfill@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned)
  VALUES(v_owner_id,'backfill_owner',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,
    first_materialized_from_release
  ) VALUES(taxon_id,'Russula backfillensis','species','include','in_cache','backfill-test');

  INSERT INTO public.observations(
    id,user_id,date,visibility,is_draft,resolved_sporely_taxon_id
  ) OVERRIDING SYSTEM VALUE VALUES
    (940009901,v_owner_id,current_date,'public',false,taxon_id),
    (940009902,v_owner_id,current_date,'public',false,NULL);
  INSERT INTO public.reference_works(
    user_id,id,type,authors_json,title,short_label,year,revision
  ) VALUES(
    v_owner_id,'71000000-0000-4000-8000-000000009901','book',
    '[{"family":"Backfill"}]','Historical exact source','Backfill 2026',2026,1
  );
  INSERT INTO public.reference_taxon_treatments(
    user_id,id,reference_work_id,taxon_id,name_as_published,revision
  ) VALUES(
    v_owner_id,'72000000-0000-4000-8000-000000009901',
    '71000000-0000-4000-8000-000000009901','authoritative-local-id',
    'Russula backfillensis',1
  );
  INSERT INTO public.reference_measurement_sets(
    user_id,id,taxon_treatment_id,character,raw_text,data_kind,
    length_core_min,length_core_max,width_core_min,width_core_max,revision
  ) VALUES(
    v_owner_id,'73000000-0000-4000-8000-000000009901',
    '72000000-0000-4000-8000-000000009901','spore_size','8–10 × 5–6 µm',
    'range',8,10,5,6,1
  );
  INSERT INTO public.observation_reference_uses(
    user_id,id,observation_id,reference_measurement_set_id,role,
    reference_revision,snapshot_json
  ) VALUES
    (v_owner_id,'74000000-0000-4000-8000-000000009901',940009901,
     '73000000-0000-4000-8000-000000009901','compared',1,
     private.reference_canonical_snapshot(v_owner_id,'73000000-0000-4000-8000-000000009901')),
    (v_owner_id,'74000000-0000-4000-8000-000000009902',940009902,
     '73000000-0000-4000-8000-000000009901','supports_identification',1,
     private.reference_canonical_snapshot(v_owner_id,'73000000-0000-4000-8000-000000009901'));

  -- Inserts above run without an authenticated owner claim, reproducing rows
  -- that existed before the owner-triggered sharing workflow.
  IF EXISTS (
    SELECT 1 FROM private.shared_reference_contributions c
    WHERE c.owner_id = v_owner_id
  ) THEN
    RAISE EXCEPTION 'fixture unexpectedly triggered sharing before backfill';
  END IF;

  first_result := private.backfill_historical_shared_reference_contributions();
  IF first_result->>'eligible' <> '1'
     OR first_result->>'created' <> '1'
     OR (SELECT count(*) FROM private.shared_reference_contributions c
         WHERE c.owner_id=v_owner_id AND c.sporely_taxon_id=taxon_id) <> 1 THEN
    RAISE EXCEPTION 'exact species-level historical use was not backfilled: %', first_result;
  END IF;

  replay_result := private.backfill_historical_shared_reference_contributions();
  IF replay_result->>'eligible' <> '1'
     OR replay_result->>'no_change' <> '1'
     OR (SELECT count(*) FROM private.shared_reference_contribution_revisions r
         JOIN private.shared_reference_contributions c ON c.id=r.contribution_id
         WHERE c.owner_id=v_owner_id) <> 1 THEN
    RAISE EXCEPTION 'backfill replay was not idempotent: %', replay_result;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.shared_reference_contributions c
    WHERE c.owner_id=v_owner_id AND c.sporely_taxon_id IS DISTINCT FROM taxon_id
  ) THEN
    RAISE EXCEPTION 'unresolved historical use was assigned inferred taxonomy';
  END IF;
END
$$;

ROLLBACK;
