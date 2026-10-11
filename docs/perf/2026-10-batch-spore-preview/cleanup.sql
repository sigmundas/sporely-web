-- Removes the synthetic fixtures created by seed.sql. LOCAL DATABASE ONLY.
BEGIN;
DELETE FROM public.spore_measurement_mosaic_tiles t
USING public.spore_measurement_mosaics sm
WHERE t.mosaic_id = sm.id AND sm.user_id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DELETE FROM public.spore_measurement_mosaics WHERE user_id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DELETE FROM public.spore_measurements WHERE user_id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DELETE FROM public.observation_images WHERE user_id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DELETE FROM public.observations WHERE user_id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DELETE FROM public.profiles WHERE id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DELETE FROM auth.users WHERE id::text LIKE '00000000-0000-4000-8000-00000bf5%';
DROP SCHEMA IF EXISTS perf_bsp CASCADE;
COMMIT;
