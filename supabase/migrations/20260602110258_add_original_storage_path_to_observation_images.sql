ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS original_storage_path text;
