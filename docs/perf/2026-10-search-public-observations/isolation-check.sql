-- Read-only checks of the isolated Stage 1b database, run before seed.sql.
-- LOCAL ONLY: the isolated stack built from origin/main f92d560 without the
-- deferred 20260914090000 (project sporely-stage1b-f92d560, port 56522).
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/isolation-check.sql
-- Expected: 128 migrations, deferred_present f, observations 0, and the
-- production functiondef hash 84db51be...a9e28c2.
BEGIN READ ONLY;
SELECT current_setting('server_version') AS server_version,
       inet_server_port() AS container_port,
       current_setting('shared_preload_libraries') AS preload;
SELECT count(*) AS migrations,
       min(version) AS first_version,
       max(version) AS last_version,
       bool_or(version = '20260914090000') AS deferred_present
FROM supabase_migrations.schema_migrations;
SELECT (SELECT count(*) FROM public.observations) AS observations,
       (SELECT count(*) FROM public.observation_images) AS images,
       (SELECT count(*) FROM public.spore_measurements) AS measurements,
       (SELECT count(*) FROM public.profiles) AS profiles,
       (SELECT count(*) FROM auth.users) AS users;
SELECT p.proname, p.prosecdef, p.provolatile, l.lanname AS lang, p.proconfig,
       encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS functiondef_sha256
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('search_public_observations', 'metadata_microscope_parent_is_public',
                    'community_contributor_label', 'is_public_microscopy_measurement_type',
                    'is_blocked_between', 'public_normalized_sample_source',
                    'public_normalized_specimen_condition')
ORDER BY p.proname;
ROLLBACK;
