-- The one-time migration must not leave its privileged repair helper installed.

DO $$
BEGIN
  IF to_regprocedure(
    'private.backfill_historical_shared_reference_contributions()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'one-time historical backfill helper remains installed';
  END IF;
END
$$;

-- Stage 2d (changed meaning; was Stage 2a "creates nothing"): replaying the
-- backfill's semantics (every live exact-species use on the owner path,
-- through share_reference_contribution_for_owner) creates one 'automatic'
-- contribution for a public, non-draft, spore-public observation; with an
-- opt-out for the set it answers opted_out and creates nothing.
BEGIN;

DO $$
DECLARE
  v_owner constant uuid := '00000000-0000-4000-8000-00000000b201';
  v_taxon constant integer := 2100000951;
  v_set constant uuid := '73000000-0000-4000-8000-00000000b201';
  v_candidate record;
  v_statuses text[] := '{}';
  v_round integer;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,raw_user_meta_data,created_at,updated_at)
  VALUES (v_owner,'authenticated','authenticated','backfill-owner@example.invalid','{}',now(),now());
  INSERT INTO public.profiles(id,username,is_banned) VALUES (v_owner,'backfill_owner',false);
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,first_materialized_from_release
  ) VALUES (v_taxon,'Amanita backfillensis','species','include','in_cache','backfill-test');
  INSERT INTO public.observations(id,user_id,date,visibility,is_draft,resolved_sporely_taxon_id)
  OVERRIDING SYSTEM VALUE VALUES (940000201,v_owner,current_date,'public',false,v_taxon);
  INSERT INTO public.reference_works(user_id,id,type,authors_json,title,year,short_label,revision)
  VALUES (v_owner,'71000000-0000-4000-8000-00000000b201','article','[{"family":"Old"}]','Historical',1990,'Old 1990',1);
  INSERT INTO public.reference_taxon_treatments(user_id,id,reference_work_id,taxon_id,name_as_published,revision)
  VALUES (v_owner,'72000000-0000-4000-8000-00000000b201','71000000-0000-4000-8000-00000000b201','t','Amanita backfillensis',1);
  INSERT INTO public.reference_measurement_sets(user_id,id,taxon_treatment_id,character,data_kind,raw_text,revision)
  VALUES (v_owner,v_set,'72000000-0000-4000-8000-00000000b201','spore_size','range','8-10 µm',1);
  INSERT INTO public.observation_reference_uses(user_id,id,observation_id,reference_measurement_set_id,role,reference_revision,snapshot_json)
  VALUES (v_owner,'74000000-0000-4000-8000-00000000b201',940000201,v_set,'compared',1,
          private.reference_canonical_snapshot(v_owner,v_set));

  INSERT INTO private.reference_share_opt_outs(owner_id,source_measurement_set_id) VALUES (v_owner,v_set);
  FOR v_round IN 1..2 LOOP
  v_statuses := '{}';
  IF v_round = 2 THEN
    DELETE FROM private.reference_share_opt_outs WHERE owner_id=v_owner;
  END IF;
  FOR v_candidate IN
    SELECT DISTINCT u.user_id, u.reference_measurement_set_id, rc.sporely_taxon_id,
           w.revision AS w, t.revision AS t, m.revision AS m
      FROM public.observation_reference_uses u
      JOIN public.observations o ON o.user_id=u.user_id AND o.id=u.observation_id
      JOIN public.reference_measurement_sets m ON m.user_id=u.user_id AND m.id=u.reference_measurement_set_id AND m.deleted_at IS NULL
      JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id AND t.deleted_at IS NULL
      JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id AND w.deleted_at IS NULL
      JOIN taxonomy_v3.registry_concept rc
        ON rc.sporely_taxon_id=coalesce(o.selected_sporely_taxon_id,o.resolved_sporely_taxon_id) AND rc.rank='species'
     WHERE u.deleted_at IS NULL
  LOOP
    v_statuses := v_statuses || (private.share_reference_contribution_for_owner(
      v_candidate.user_id,v_candidate.reference_measurement_set_id,v_candidate.sporely_taxon_id,
      v_candidate.w,v_candidate.t,v_candidate.m)->>'status');
  END LOOP;
  IF v_round = 1 THEN
    IF v_statuses IS DISTINCT FROM ARRAY['opted_out'] THEN
      RAISE EXCEPTION 'opted-out replay did not answer opted_out: %', v_statuses;
    END IF;
    IF EXISTS (SELECT 1 FROM private.shared_reference_contributions c WHERE c.owner_id=v_owner) THEN
      RAISE EXCEPTION 'opted-out replay created a contribution';
    END IF;
  ELSE
    IF v_statuses IS DISTINCT FROM ARRAY['created'] THEN
      RAISE EXCEPTION 'backfill replay did not answer created: %', v_statuses;
    END IF;
    IF (SELECT count(*) FROM private.shared_reference_contributions c
         WHERE c.owner_id=v_owner AND c.status='shared' AND c.share_basis='automatic'
           AND c.consented_at IS NULL AND c.shared_first_revision=1) <> 1 THEN
      RAISE EXCEPTION 'backfill replay did not create one automatic contribution';
    END IF;
  END IF;
  END LOOP;
END
$$;

ROLLBACK;
