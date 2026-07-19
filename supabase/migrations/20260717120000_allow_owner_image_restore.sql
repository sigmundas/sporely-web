-- Allow an owner to restore a soft-deleted image row. Desktop sync can retain
-- an active local image after a stale cloud tombstone; restoring the existing
-- row preserves its measurement foreign keys and avoids duplicate images.

DROP POLICY IF EXISTS "phase7_observation_images_update_own"
  ON public.observation_images;

CREATE POLICY "phase7_observation_images_update_own"
  ON public.observation_images
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND o.user_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND o.user_id = auth.uid()
    )
    AND (
      storage_path LIKE (auth.uid())::text || '/%'
      OR (
        storage_path IS NULL
        AND image_type = 'microscope'
      )
    )
  );

NOTIFY pgrst, 'reload schema';
