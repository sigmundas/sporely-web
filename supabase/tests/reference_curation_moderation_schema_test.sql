-- Stage 6c private moderation boundary, provenance, and grants contract.

BEGIN;

DO $$
DECLARE
  function_oid regprocedure;
  config_text text;
  function_text text;
  expected_column text;
BEGIN
  IF to_regclass('private.reference_curation_moderation_requests') IS NULL THEN
    RAISE EXCEPTION 'missing private.reference_curation_moderation_requests';
  END IF;
  IF to_regclass('private.reference_curation_moderation_collisions') IS NULL THEN
    RAISE EXCEPTION 'missing private.reference_curation_moderation_collisions';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
           WHERE c.oid = 'private.reference_curation_moderation_requests'::regclass) THEN
    RAISE EXCEPTION 'moderation request ledger does not have RLS enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies p
     WHERE p.schemaname = 'private'
       AND p.tablename = 'reference_curation_moderation_requests'
  ) THEN
    RAISE EXCEPTION 'moderation request ledger unexpectedly has a client policy';
  END IF;
  IF has_table_privilege('anon', 'private.reference_curation_moderation_requests', 'SELECT')
     OR has_table_privilege('authenticated', 'private.reference_curation_moderation_requests', 'SELECT')
     OR has_table_privilege('anon', 'private.reference_curation_moderation_requests', 'INSERT')
     OR has_table_privilege('authenticated', 'private.reference_curation_moderation_requests', 'INSERT') THEN
    RAISE EXCEPTION 'client role has direct moderation-ledger access';
  END IF;
  IF has_table_privilege('anon', 'private.reference_curation_moderation_collisions', 'SELECT')
     OR has_table_privilege('authenticated', 'private.reference_curation_moderation_collisions', 'SELECT') THEN
    RAISE EXCEPTION 'client role has direct moderation-collision access';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema='private'
                AND c.table_name='reference_curation_moderation_requests'
                AND c.column_name='actor_session_id') THEN
    RAISE EXCEPTION 'ephemeral auth session was persisted in moderation ledger';
  END IF;
  IF to_regprocedure('public.delete_reference_library_for_account_stage6b(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'internal account-deletion helper remained a public RPC';
  END IF;
  IF has_function_privilege(
       'service_role',
       'private.delete_reference_library_for_account_stage6b(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'service role can bypass the Stage 6c account-deletion wrapper';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid='private.reference_curator_memberships'::regclass
       AND t.tgname='reference_curator_memberships_serialize_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'membership mutation is not serialized with claim reassignment';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(
    'private.reference_curation_actor_authorized(uuid,uuid)'::regprocedure
  ) INTO function_text;
  IF pg_catalog.strpos(function_text, 'reference-curator-memberships')=0
     OR pg_catalog.strpos(function_text, 'reference-curator-memberships')>
        pg_catalog.strpos(function_text, 'FROM private.reference_curator_memberships') THEN
    RAISE EXCEPTION 'authorization does not acquire the membership lock before reading membership';
  END IF;

  FOREACH expected_column IN ARRAY ARRAY[
    'claimed_by', 'claimed_at', 'review_feedback',
    'accepted_candidate_revision', 'accepted_content_hash',
    'accepted_curated_work_id', 'accepted_curated_treatment_id',
    'accepted_curated_measurement_set_id', 'accepted_by', 'accepted_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'private'
         AND c.table_name = 'reference_curation_submissions'
         AND c.column_name = expected_column
    ) THEN
      RAISE EXCEPTION 'missing submission moderation column %', expected_column;
    END IF;
  END LOOP;

  function_oid := to_regprocedure(
    'public.mutate_reference_curation(uuid,uuid,uuid,text,uuid,bigint,integer,text,text,jsonb)'
  );
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'missing typed moderation mutation RPC';
  END IF;
  SELECT array_to_string(p.proconfig, ',') INTO config_text
    FROM pg_catalog.pg_proc p WHERE p.oid = function_oid;
  IF config_text IS DISTINCT FROM 'search_path=""'
     OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = function_oid) THEN
    RAISE EXCEPTION 'moderation mutation RPC is not hardened';
  END IF;
  IF NOT has_function_privilege('service_role', function_oid, 'EXECUTE')
     OR has_function_privilege('anon', function_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'moderation mutation RPC grants are not service-only';
  END IF;

  function_oid := to_regprocedure(
    'public.get_reference_curation_duplicate_warnings(uuid,uuid,uuid,integer,text)'
  );
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'missing duplicate-warning RPC';
  END IF;
  SELECT array_to_string(p.proconfig, ',') INTO config_text
    FROM pg_catalog.pg_proc p WHERE p.oid = function_oid;
  IF config_text IS DISTINCT FROM 'search_path=""'
     OR NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = function_oid)
     OR NOT has_function_privilege('service_role', function_oid, 'EXECUTE')
     OR has_function_privilege('anon', function_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'duplicate-warning RPC is not hardened service-only';
  END IF;
END
$$;

ROLLBACK;
