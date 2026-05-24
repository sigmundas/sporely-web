ALTER TABLE public.calibrations
  ADD COLUMN IF NOT EXISTS calibration_uuid uuid;

UPDATE public.calibrations
SET calibration_uuid = gen_random_uuid()
WHERE calibration_uuid IS NULL;

ALTER TABLE public.calibrations
  ALTER COLUMN calibration_uuid SET DEFAULT gen_random_uuid();

ALTER TABLE public.calibrations
  ALTER COLUMN calibration_uuid SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'calibrations_user_calibration_uuid_key'
      AND conrelid = 'public.calibrations'::regclass
  ) THEN
    ALTER TABLE public.calibrations
      ADD CONSTRAINT calibrations_user_calibration_uuid_key UNIQUE (user_id, calibration_uuid);
  END IF;
END $$;
