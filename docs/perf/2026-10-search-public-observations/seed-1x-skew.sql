-- Sensitivity run: re-seeds at 1x with the skewed parent/measurement
-- distribution (seed.sql must have been run once). LOCAL ISOLATED DATABASE ONLY.
BEGIN;
CALL perf_spo.seed(1, 'skew');
COMMIT;
VACUUM public.observations, public.observation_images, public.spore_measurements, public.profiles;
ANALYZE public.observations, public.observation_images, public.spore_measurements, public.profiles;
