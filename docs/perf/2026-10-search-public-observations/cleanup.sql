-- Removes the synthetic fixtures and the perf_spo schema created by seed.sql.
-- LOCAL ISOLATED DATABASE ONLY.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/cleanup.sql
BEGIN;
DELETE FROM public.spore_measurements WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0b%';
DELETE FROM public.observation_images WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0b%';
DELETE FROM public.observations WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0b%';
DELETE FROM public.profiles WHERE id::text LIKE '00000000-0000-4000-8000-00005e0b%';
DELETE FROM auth.users WHERE id::text LIKE '00000000-0000-4000-8000-00005e0b%';
DROP SCHEMA IF EXISTS perf_spo CASCADE;
COMMIT;
SELECT (SELECT count(*) FROM public.observations) AS observations_left,
       (SELECT count(*) FROM public.observation_images) AS images_left,
       (SELECT count(*) FROM public.spore_measurements) AS measurements_left;
