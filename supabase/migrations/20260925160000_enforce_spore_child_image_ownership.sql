-- Enforce parent-image ownership on spore_measurements and spore_annotations.
--
-- Invariant
-- ---------
-- A measurement or annotation may reference an image only when the
-- authenticated caller owns both the child row and the target image.
-- This holds when the row is created and whenever its image_id changes.
--
-- Pre-fix state (verified at runtime)
-- -----------------------------------
-- The write policies checked only the child's own user_id:
--   spore_measurements_owner_insert   WITH CHECK (user_id = auth.uid())
--   spore_measurements_owner_update   USING / WITH CHECK (user_id = auth.uid())
--   "spore_annotations: owner full"   FOR ALL, USING / WITH CHECK (auth.uid() = user_id)
-- An authenticated user could therefore insert a row carrying their own
-- user_id but another user's image_id, or re-parent their own row onto
-- another user's image, and so inject spore data into that user's public
-- observation (the public spore RPCs join measurements by image).
--
-- Ownership source
-- ----------------
-- observation_images write policies already require that the image's
-- user_id and its parent observation's user_id are both the caller. The
-- new check requires both as well, so it is established from the
-- database's own image -> observation rows and never from the
-- client-supplied child user_id alone. The sub-select runs under the
-- caller's RLS (owner-only SELECT on both parent tables), which is
-- consistent with the predicate. metadata_purpose (owner_sync,
-- public_microscopy or NULL) is deliberately not consulted: no marker
-- weakens the ownership boundary.
--
-- Scope
-- -----
-- Only the WITH CHECK expressions change, plus the annotation policy's
-- role (see below); policy names, commands and USING expressions are
-- unchanged. USING already limits UPDATE and
-- DELETE to the caller's own rows, so WITH CHECK (the new row) is the
-- only place the target image can be constrained. DELETE and SELECT are
-- untouched, so owners can still read and delete their rows, including
-- rows on tombstoned images. Deleted/purged state of the target image is
-- not part of this invariant. No data changes: the production audit
-- found no cross-owner rows in either table.

BEGIN;

ALTER POLICY "spore_measurements_owner_insert"
  ON public.spore_measurements
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.observation_images i
      JOIN public.observations o ON o.id = i.observation_id
      WHERE i.id = spore_measurements.image_id
        AND i.user_id = auth.uid()
        AND o.user_id = auth.uid()
    )
  );

ALTER POLICY "spore_measurements_owner_update"
  ON public.spore_measurements
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.observation_images i
      JOIN public.observations o ON o.id = i.observation_id
      WHERE i.id = spore_measurements.image_id
        AND i.user_id = auth.uid()
        AND o.user_id = auth.uid()
    )
  );

-- TO authenticated: this policy was scoped to PUBLIC. anon has no SELECT on
-- observation_images, so leaving it PUBLIC would turn anon's RLS denials
-- into permission errors from the new sub-select (and make anon UPDATE
-- raise instead of matching no rows). With no policy applying to anon,
-- RLS default-deny gives anon exactly its previous outcomes. The
-- spore_measurements policies are already TO authenticated.
ALTER POLICY "spore_annotations: owner full"
  ON public.spore_annotations
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.observation_images i
      JOIN public.observations o ON o.id = i.observation_id
      WHERE i.id = spore_annotations.image_id
        AND i.user_id = auth.uid()
        AND o.user_id = auth.uid()
    )
  );

COMMIT;
