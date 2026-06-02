ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS calibration_uuid uuid;
