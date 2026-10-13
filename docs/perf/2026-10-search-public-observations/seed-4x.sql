-- Re-seeds at 4x (seed.sql must have been run once). LOCAL ISOLATED DATABASE ONLY.
BEGIN;
CALL perf_spo.seed(4, 'base');
COMMIT;
VACUUM public.observations, public.observation_images, public.spore_measurements, public.profiles;
ANALYZE public.observations, public.observation_images, public.spore_measurements, public.profiles;
