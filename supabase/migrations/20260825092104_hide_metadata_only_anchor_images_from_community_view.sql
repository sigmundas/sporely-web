-- Hide metadata-only microscope anchor rows from the community image view.
--
-- Desktop sync keeps a cloud row with storage_path = NULL for gallery-
-- unchecked microscope images that anchor public spore-measurement FKs
-- (migration 20260706100000_add_metadata_only_microscope_images.sql).
-- The public RPC search_public_observation_images already excludes such
-- rows, but observation_images_community_view did not — so clients that
-- read the view (mobile app galleries) rendered them as empty
-- placeholders. Align the view's predicate with the RPC.
--
-- This is a strictly narrowing change: rows without bytes are removed
-- from a read projection. No grants change.

DROP VIEW IF EXISTS public.observation_images_community_view;
CREATE VIEW public.observation_images_community_view
  WITH (security_barrier = true) AS
SELECT
  oi.id,
  oi.observation_id,
  oi.user_id,
  oi.storage_path,
  oi.sort_order,
  oi.image_type,
  oi.micro_category,
  oi.objective_name,
  oi.scale_microns_per_pixel,
  oi.mount_medium,
  oi.stain,
  oi.sample_type,
  oi.contrast,
  oi.ai_crop_x1,
  oi.ai_crop_y1,
  oi.ai_crop_x2,
  oi.ai_crop_y2,
  oi.ai_crop_source_w,
  oi.ai_crop_source_h,
  oi.ai_crop_is_custom,
  oi.crop_mode,
  oi.scale_bar_x1,
  oi.scale_bar_y1,
  oi.scale_bar_x2,
  oi.scale_bar_y2,
  oi.source_width,
  oi.source_height,
  oi.stored_width,
  oi.stored_height,
  oi.created_at,
  oi.calibration_uuid,
  NULL::timestamptz AS deleted_at,
  o.user_id AS observation_user_id,
  o.visibility AS observation_visibility,
  o.is_draft AS observation_is_draft,
  o.spore_data_visibility AS observation_spore_data_visibility,
  oi.id AS image_id,
  oi.media_version,
  public.build_worker_media_url(oi.id, 'full', oi.media_version) AS full_media_url,
  public.build_worker_media_url(oi.id, 'thumb', oi.media_version) AS thumb_media_url
FROM public.observation_images oi
JOIN public.observations o ON o.id = oi.observation_id
WHERE oi.deleted_at IS NULL
  AND oi.purged_at IS NULL
  AND oi.storage_path IS NOT NULL
  AND btrim(oi.storage_path) <> ''
  AND NOT COALESCE(o.is_draft, false)
  AND public.can_read_observation(o.user_id, o.visibility)
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = o.user_id AND p.is_banned = true
  )
  AND NOT public.current_user_is_blocked_with(o.user_id);

ALTER VIEW public.observation_images_community_view OWNER TO postgres;
REVOKE ALL ON TABLE public.observation_images_community_view FROM anon, authenticated;
GRANT SELECT ON public.observation_images_community_view TO anon, authenticated;
GRANT ALL ON public.observation_images_community_view TO service_role;

COMMENT ON VIEW public.observation_images_community_view IS
  'Community-safe projection of observation_images. Excludes deleted, purged, and metadata-only (storage_path IS NULL) anchor rows; draft, banned-owner, and blocked-pair rows are filtered. Media URLs are authorized worker projections.';

NOTIFY pgrst, 'reload schema';
