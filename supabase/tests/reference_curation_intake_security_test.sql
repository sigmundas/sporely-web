-- Stage 6b caller-RPC and private-table security contract.

BEGIN;

DO $$
DECLARE
  table_name text;
  role_name text;
  function_signature text;
  function_oid regprocedure;
  config_text text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'reference_curation_intake_policy',
    'reference_curation_attestation_versions',
    'reference_curation_intake_attempts',
    'reference_curation_submissions',
    'reference_curation_submission_versions',
    'reference_curation_reports'
  ] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(role_name, 'private.' || table_name, 'SELECT')
         OR has_table_privilege(role_name, 'private.' || table_name, 'INSERT')
         OR has_table_privilege(role_name, 'private.' || table_name, 'UPDATE')
         OR has_table_privilege(role_name, 'private.' || table_name, 'DELETE')
         OR has_table_privilege(role_name, 'private.' || table_name, 'TRUNCATE') THEN
        RAISE EXCEPTION '% has direct access to private.%', role_name, table_name;
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class c
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
        ) acl
       WHERE c.oid = ('private.' || table_name)::regclass
         AND acl.grantee = 0
         AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ) THEN
      RAISE EXCEPTION 'PUBLIC has direct access to private.%', table_name;
    END IF;
  END LOOP;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.submit_private_reference_for_curation(uuid,integer,integer,integer,text,boolean,boolean)',
    'public.resubmit_private_reference_for_curation(uuid,bigint,integer,integer,integer,text,boolean,boolean)',
    'public.withdraw_private_reference_curation_submission(uuid,bigint,text)',
    'public.report_curated_reference_set(uuid,integer,text,text,uuid)'
  ] LOOP
    function_oid := to_regprocedure(function_signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'missing caller RPC %', function_signature;
    END IF;
    SELECT array_to_string(p.proconfig, ',') INTO config_text
      FROM pg_catalog.pg_proc p WHERE p.oid = function_oid;
    IF config_text IS DISTINCT FROM 'search_path=""' THEN
      RAISE EXCEPTION 'RPC % lacks empty search_path: %', function_signature, config_text;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = function_oid) THEN
      RAISE EXCEPTION 'RPC % is not SECURITY DEFINER', function_signature;
    END IF;
    IF NOT has_function_privilege('authenticated', function_oid, 'EXECUTE')
       OR has_function_privilege('anon', function_oid, 'EXECUTE')
       OR has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'RPC % grants are not authenticated-only', function_signature;
    END IF;
  END LOOP;

  IF has_table_privilege('service_role', 'private.reference_curation_submission_versions', 'UPDATE')
     OR has_table_privilege('service_role', 'private.reference_curation_submission_versions', 'DELETE')
     OR has_table_privilege('service_role', 'private.reference_curation_submission_versions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can mutate append-only candidate versions';
  END IF;
  IF has_table_privilege('service_role', 'private.reference_curation_attestation_versions', 'UPDATE')
     OR has_table_privilege('service_role', 'private.reference_curation_attestation_versions', 'DELETE')
     OR has_table_privilege('service_role', 'private.reference_curation_attestation_versions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role can rewrite attestation version history';
  END IF;
  IF NOT has_function_privilege(
       'service_role', 'private.apply_reference_curation_retention()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'private.apply_reference_curation_retention()', 'EXECUTE'
     )
     OR has_function_privilege(
       'anon', 'private.apply_reference_curation_retention()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'retention maintenance grant is not service-only';
  END IF;
END
$$;

SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE private.reference_curation_submission_versions
       SET candidate_revision = candidate_revision;
    RAISE EXCEPTION 'service_role updated append-only candidate versions';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

ROLLBACK;
