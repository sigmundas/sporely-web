-- Re-seeds at 1x, base distribution (seed.sql must have been run once).
-- LOCAL ISOLATED DATABASE ONLY.
BEGIN;
CALL perf_spo.seed(1, 'base');
COMMIT;
VACUUM public.observations, public.observation_images, public.spore_measurements, public.profiles;
ANALYZE public.observations, public.observation_images, public.spore_measurements, public.profiles;
