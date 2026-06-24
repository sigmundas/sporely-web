-- Fix inspected legacy location flags after manual review.
--
-- Morchella deliciosa id 608 should remain hidden/fuzzed.
-- The other inspected legacy rows can use exact location and the legacy
-- location_public flag should agree with that.

UPDATE public.observations
SET
  location_precision = 'fuzzed',
  location_public = false
WHERE id = 608
  AND genus = 'Morchella'
  AND species = 'deliciosa';

UPDATE public.observations
SET
  location_precision = 'exact',
  location_public = true
WHERE id IN (
  583,
  243,
  99,
  35,
  34,
  33,
  32,
  31,
  30,
  29,
  28,
  27,
  26,
  24,
  20
);

NOTIFY pgrst, 'reload schema';