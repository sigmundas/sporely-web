-- Preserve image capture chronology independently from cloud upload chronology.
--
-- observations.captured_at remains the specimen/observation event time, while
-- observation_images.created_at remains the cloud row creation time. Existing
-- image rows intentionally retain NULL here rather than receiving a fabricated
-- capture time derived from their upload time.

ALTER TABLE public.observation_images
  ADD COLUMN captured_at timestamp with time zone;

COMMENT ON COLUMN public.observation_images.captured_at IS
  'Actual date/time the source image was captured. Distinct from the observation event and cloud row creation timestamps.';

CREATE INDEX observation_images_microscope_captured_at_idx
  ON public.observation_images (observation_id, captured_at DESC)
  WHERE image_type = 'microscope' AND captured_at IS NOT NULL;
