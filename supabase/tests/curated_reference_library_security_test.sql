-- Curated catalogue tables are dormant and deny direct client access.

BEGIN;

DO $$
DECLARE
  table_name text;
  role_name text;
  is_rls boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'curated_reference_works',
    'curated_reference_taxon_treatments',
    'curated_reference_measurement_sets',
    'curated_reference_treatment_taxa',
    'curated_reference_publications',
    'curated_reference_publication_taxa',
    'reference_curator_memberships',
    'reference_curation_events'
  ] LOOP
    SELECT relrowsecurity INTO is_rls
      FROM pg_class WHERE oid = ('private.' || table_name)::regclass;
    IF is_rls IS NOT TRUE THEN
      RAISE EXCEPTION 'RLS is disabled on private.%', table_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'private' AND tablename = table_name) THEN
      RAISE EXCEPTION 'unexpected client policy on private.%', table_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(role_name, 'private.' || table_name, 'SELECT')
         OR has_table_privilege(role_name, 'private.' || table_name, 'INSERT')
         OR has_table_privilege(role_name, 'private.' || table_name, 'UPDATE')
         OR has_table_privilege(role_name, 'private.' || table_name, 'DELETE') THEN
        RAISE EXCEPTION '% has direct privilege on private.%', role_name, table_name;
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
       WHERE c.oid = ('private.' || table_name)::regclass
         AND acl.grantee = 0
         AND acl.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ) THEN
      RAISE EXCEPTION 'PUBLIC has direct privilege on private.%', table_name;
    END IF;
  END LOOP;

  IF has_schema_privilege('anon', 'private', 'USAGE')
     OR has_schema_privilege('authenticated', 'private', 'USAGE') THEN
    RAISE EXCEPTION 'client role has private schema usage';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
     WHERE n.nspname = 'private' AND acl.grantee = 0
       AND acl.privilege_type = 'USAGE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC has private schema usage';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE '%curated_reference%' OR p.proname LIKE 'reference_curation%')
       AND p.oid <> 'public.report_curated_reference_set(uuid,integer,text,text,uuid)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'Stage 6b exposed an unexpected curated RPC';
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'curated_reference_publications',
    'curated_reference_publication_taxa',
    'reference_curation_events'
  ] LOOP
    IF has_table_privilege('service_role', 'private.' || table_name, 'TRUNCATE')
       OR has_table_privilege('service_role', 'private.' || table_name, 'UPDATE')
       OR has_table_privilege('service_role', 'private.' || table_name, 'DELETE') THEN
      RAISE EXCEPTION 'service_role has destructive privilege on append-only private.%', table_name;
    END IF;
  END LOOP;
END
$$;

SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM private.curated_reference_works';
    RAISE EXCEPTION 'anon direct read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    EXECUTE $sql$INSERT INTO private.curated_reference_works
      (id, type, title, short_label, revision)
      VALUES ('61000000-0000-4000-8000-000000000101', 'book', 'Denied', 'Denied', 1)$sql$;
    RAISE EXCEPTION 'authenticated direct write unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

SET LOCAL ROLE service_role;
INSERT INTO private.curated_reference_works
  (id, type, title, short_label, revision)
VALUES ('61000000-0000-4000-8000-000000000102', 'book', 'Service work', 'Service', 1);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM private.curated_reference_works
    WHERE id = '61000000-0000-4000-8000-000000000102'
  ) THEN
    RAISE EXCEPTION 'service_role could not read its inserted curated row';
  END IF;
END
$$;
DO $$
BEGIN
  BEGIN
    TRUNCATE private.reference_curation_events;
    RAISE EXCEPTION 'service_role could truncate append-only events';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

ROLLBACK;
