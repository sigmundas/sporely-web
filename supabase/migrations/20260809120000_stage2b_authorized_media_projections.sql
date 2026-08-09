-- Stage 2b: additive authorized-media identities on non-owner read surfaces.
--
-- Transitional contract: legacy keys and media.sporely.no URLs remain in
-- place for shipped clients. New clients should prefer the ID + version
-- Worker URLs appended by this migration. No owner/sync table contract is
-- changed and no original-media URL is projected.

BEGIN;

CREATE OR REPLACE FUNCTION public.build_worker_mosaic_url(
  p_mosaic_id bigint,
  p_media_version bigint
) RETURNS text
LANGUAGE plpgsql
STABLE PARALLEL SAFE
SET search_path='public,pg_catalog'
AS $$
DECLARE
  base_url text;
BEGIN
  IF p_mosaic_id IS NULL OR p_mosaic_id <= 0 THEN RETURN NULL; END IF;
  IF p_media_version IS NULL OR p_media_version < 1 THEN RETURN NULL; END IF;
  base_url := regexp_replace(public._media_worker_base_url(), '/+$', '');
  IF base_url IS NULL OR base_url !~ '^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$' THEN
    RETURN NULL;
  END IF;
  RETURN base_url || '/mm/' || p_mosaic_id::text || '?v=' || p_media_version::text;
END $$;

REVOKE ALL ON FUNCTION public.build_worker_mosaic_url(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.build_worker_mosaic_url(bigint, bigint)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.build_worker_mosaic_url(bigint, bigint) IS
  'Builds an authorized /mm/<mosaic-id>?v=<media-version> URL from the protected Worker origin.';

CREATE OR REPLACE FUNCTION public._stage2b_observation_primary_media(
  p_observation_id bigint,
  p_legacy_image_key text DEFAULT NULL
) RETURNS TABLE(
  image_id bigint,
  media_version bigint,
  full_media_url text,
  thumb_media_url text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public,pg_catalog'
AS $$
  SELECT
    i.id,
    i.media_version,
    public.build_worker_media_url(i.id, 'full', i.media_version),
    public.build_worker_media_url(i.id, 'thumb', i.media_version)
  FROM public.observations o
  JOIN public.observation_images i ON i.observation_id = o.id
  WHERE o.id = p_observation_id
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
    AND i.storage_path IS NOT NULL
    AND btrim(i.storage_path) <> ''
    AND NOT COALESCE(o.is_draft, false)
    AND public.can_read_observation(o.user_id, o.visibility)
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = o.user_id AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id)
  ORDER BY
    (i.storage_path = p_legacy_image_key) DESC,
    i.sort_order NULLS LAST,
    i.created_at DESC NULLS LAST,
    i.id DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public._stage2b_observation_primary_media(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._stage2b_observation_primary_media(bigint, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public._stage2b_observation_primary_media(bigint, text) IS
  'Authorization-gated representative image identity for transitional non-owner projections. Returns no raw key and no original URL.';

-- Community image rows retain storage_path for current clients. The new
-- fields are appended, and original_storage_path remains excluded.
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
  AND NOT COALESCE(o.is_draft, false)
  AND public.can_read_observation(o.user_id, o.visibility)
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = o.user_id AND p.is_banned = true
  )
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

ALTER VIEW public.observation_images_community_view OWNER TO postgres;
REVOKE ALL ON TABLE public.observation_images_community_view FROM anon, authenticated;
GRANT SELECT ON public.observation_images_community_view TO anon, authenticated;
GRANT ALL ON public.observation_images_community_view TO service_role;

-- Observation list/detail projections retain image_key/thumb_key and append
-- the active representative image identity selected by the same ordering
-- used by current galleries.
CREATE OR REPLACE VIEW public.observations_community_view
  WITH (security_barrier = true) AS
SELECT
  o.id, o.user_id, o.desktop_id, o.date, o.captured_at, o.created_at,
  o.genus, o.species, o.common_name, o.author,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'exact' THEN o.location
    WHEN COALESCE(o.location_precision,'exact') IN ('fuzzed','region') THEN COALESCE(pr.label, o.country_code)
    ELSE NULL
  END AS location,
  o.habitat, o.notes, o.uncertain, o.location_public, o.visibility,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_latitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_latitude
  END AS gps_latitude,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_longitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_longitude
  END AS gps_longitude,
  o.source_type, o.spore_data_visibility, o.image_key, o.thumb_key,
  o.is_draft, o.location_precision,
  o.ai_selected_service, o.ai_selected_taxon_id, o.ai_selected_scientific_name,
  o.ai_selected_probability, o.ai_selected_at,
  CASE WHEN COALESCE(o.spore_data_visibility,'public') = 'public'
    THEN o.spore_statistics ELSE NULL::jsonb END AS spore_statistics,
  o.red_list_category, o.red_list_categories_json,
  media.image_id, media.media_version, media.full_media_url, media.thumb_media_url
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
LEFT JOIN LATERAL public._stage2b_observation_primary_media(o.id, o.image_key) media ON true
WHERE COALESCE(o.visibility,'public') = 'public'
  AND NOT COALESCE(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observations_friend_view
  WITH (security_barrier = true) AS
SELECT
  o.id, o.user_id, o.desktop_id, o.date, o.captured_at, o.created_at,
  o.genus, o.species, o.common_name, o.author,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'exact' THEN o.location
    WHEN COALESCE(o.location_precision,'exact') IN ('fuzzed','region') THEN COALESCE(pr.label, o.country_code)
    ELSE NULL
  END AS location,
  o.habitat, o.notes, o.uncertain, o.location_public, o.visibility,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_latitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_latitude
  END AS gps_latitude,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_longitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_longitude
  END AS gps_longitude,
  o.source_type, o.spore_data_visibility, o.image_key, o.thumb_key,
  o.is_draft, o.location_precision,
  o.ai_selected_service, o.ai_selected_taxon_id, o.ai_selected_scientific_name,
  o.ai_selected_probability, o.ai_selected_at,
  o.red_list_category, o.red_list_categories_json,
  media.image_id, media.media_version, media.full_media_url, media.thumb_media_url
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
LEFT JOIN LATERAL public._stage2b_observation_primary_media(o.id, o.image_key) media ON true
WHERE COALESCE(o.visibility,'public') = ANY (ARRAY['friends','public'])
  AND NOT COALESCE(o.is_draft, false)
  AND public.are_friends(auth.uid(), o.user_id)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observations_follow_view
  WITH (security_barrier = true) AS
SELECT DISTINCT
  o.id, o.user_id, o.desktop_id, o.date, o.captured_at, o.created_at,
  o.genus, o.species, o.common_name, o.author,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'exact' THEN o.location
    WHEN COALESCE(o.location_precision,'exact') IN ('fuzzed','region') THEN COALESCE(pr.label, o.country_code)
    ELSE NULL
  END AS location,
  o.habitat, o.notes, o.uncertain, o.location_public, o.visibility,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_latitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_latitude
  END AS gps_latitude,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_longitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_longitude
  END AS gps_longitude,
  o.source_type, o.spore_data_visibility, o.image_key, o.thumb_key,
  o.is_draft, o.location_precision,
  media.image_id, media.media_version, media.full_media_url, media.thumb_media_url
FROM public.observations o
JOIN public.follows f ON f.user_id = auth.uid()
  AND ((f.target_type = 'user' AND f.target_id = o.user_id::text)
    OR (f.target_type = 'observation' AND f.target_id = o.id::text)
    OR (f.target_type = 'genus' AND lower(f.target_id) = lower(COALESCE(o.genus,'')))
    OR (f.target_type = 'species' AND lower(f.target_id) = lower(TRIM(BOTH FROM concat_ws(' ', o.genus, o.species)))))
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
LEFT JOIN LATERAL public._stage2b_observation_primary_media(o.id, o.image_key) media ON true
WHERE public.can_read_observation(o.user_id, o.visibility)
  AND NOT COALESCE(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

-- Public gallery RPCs preserve every existing camelCase field and append
-- mediaVersion/fullMediaUrl/thumbMediaUrl. The legacy CDN fields remain.
DROP FUNCTION IF EXISTS public.get_public_observation_images(bigint);
DROP FUNCTION IF EXISTS public.search_public_observation_images(bigint[]);

CREATE FUNCTION public.search_public_observation_images(
  p_observation_ids bigint[] DEFAULT NULL::bigint[]
)
RETURNS TABLE(
  "observationId" bigint,
  "imageId" bigint,
  "sortOrder" integer,
  "imageType" text,
  "width" integer,
  "height" integer,
  "thumbUrl" text,
  "previewUrl" text,
  "fullUrl" text,
  "aiCropX1" double precision,
  "aiCropY1" double precision,
  "aiCropX2" double precision,
  "aiCropY2" double precision,
  "aiCropSourceW" integer,
  "aiCropSourceH" integer,
  "aiCropIsCustom" boolean,
  "scaleMicronsPerPixel" double precision,
  "mediaVersion" bigint,
  "fullMediaUrl" text,
  "thumbMediaUrl" text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public'
AS $$
  WITH visible_images AS (
    SELECT
      o.id AS observation_id,
      i.id AS image_id,
      i.sort_order,
      i.image_type,
      coalesce(i.stored_width, i.source_width) AS width,
      coalesce(i.stored_height, i.source_height) AS height,
      nullif(regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''), btrim(i.storage_path, '/')) AS storage_dir,
      regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
      i.ai_crop_x1, i.ai_crop_y1, i.ai_crop_x2, i.ai_crop_y2,
      i.ai_crop_source_w, i.ai_crop_source_h,
      coalesce(i.ai_crop_is_custom, false) AS ai_crop_is_custom,
      coalesce(i.storage_exif_safe, false) AS storage_exif_safe,
      i.scale_microns_per_pixel,
      i.media_version,
      i.created_at
    FROM public.observations o
    JOIN public.observation_images i ON i.observation_id = o.id
    WHERE o.visibility = 'public'
      AND NOT coalesce(o.is_draft, false)
      AND o.id = ANY (coalesce(p_observation_ids, '{}'::bigint[]))
      AND i.deleted_at IS NULL
      AND i.purged_at IS NULL
      AND i.storage_path IS NOT NULL
      AND btrim(i.storage_path) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE)
  ), prepared AS (
    SELECT
      vi.*,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        'thumb_', regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS thumb_path,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS full_path
    FROM visible_images vi
  )
  SELECT
    p.observation_id AS "observationId",
    p.image_id AS "imageId",
    p.sort_order AS "sortOrder",
    p.image_type AS "imageType",
    p.width AS "width",
    p.height AS "height",
    concat('https://media.sporely.no/', p.thumb_path) AS "thumbUrl",
    concat('https://media.sporely.no/', p.thumb_path) AS "previewUrl",
    CASE WHEN p.storage_exif_safe
      THEN concat('https://media.sporely.no/', p.full_path) ELSE NULL END AS "fullUrl",
    p.ai_crop_x1 AS "aiCropX1",
    p.ai_crop_y1 AS "aiCropY1",
    p.ai_crop_x2 AS "aiCropX2",
    p.ai_crop_y2 AS "aiCropY2",
    p.ai_crop_source_w AS "aiCropSourceW",
    p.ai_crop_source_h AS "aiCropSourceH",
    p.ai_crop_is_custom AS "aiCropIsCustom",
    p.scale_microns_per_pixel AS "scaleMicronsPerPixel",
    p.media_version AS "mediaVersion",
    public.build_worker_media_url(p.image_id, 'full', p.media_version) AS "fullMediaUrl",
    public.build_worker_media_url(p.image_id, 'thumb', p.media_version) AS "thumbMediaUrl"
  FROM prepared p
  ORDER BY p.observation_id, p.sort_order NULLS LAST, p.created_at DESC NULLS LAST, p.image_id DESC
$$;

ALTER FUNCTION public.search_public_observation_images(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_public_observation_images(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[])
  TO anon, authenticated, service_role;

CREATE FUNCTION public.get_public_observation_images(p_observation_id bigint)
RETURNS TABLE(
  "observationId" bigint,
  "imageId" bigint,
  "sortOrder" integer,
  "imageType" text,
  "width" integer,
  "height" integer,
  "thumbUrl" text,
  "previewUrl" text,
  "fullUrl" text,
  "aiCropX1" double precision,
  "aiCropY1" double precision,
  "aiCropX2" double precision,
  "aiCropY2" double precision,
  "aiCropSourceW" integer,
  "aiCropSourceH" integer,
  "aiCropIsCustom" boolean,
  "scaleMicronsPerPixel" double precision,
  "mediaVersion" bigint,
  "fullMediaUrl" text,
  "thumbMediaUrl" text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public'
AS $$
  SELECT * FROM public.search_public_observation_images(ARRAY[p_observation_id])
$$;

ALTER FUNCTION public.get_public_observation_images(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_public_observation_images(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_observation_images(bigint)
  TO anon, authenticated, service_role;

-- Preserve the deployed public-observation implementation and wrap its
-- jsonb mosaic object with Stage 2 identity fields. This avoids duplicating
-- unrelated spore/preparation logic while retaining the exact row shape.
ALTER FUNCTION public.get_public_observation(bigint)
  RENAME TO _get_public_observation_stage2a;
REVOKE ALL ON FUNCTION public._get_public_observation_stage2a(bigint)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_public_observation(p_observation_id bigint)
RETURNS TABLE(
  id bigint,
  "speciesSlug" text,
  "speciesName" text,
  "speciesCommonName" text,
  "observerDisplayName" text,
  "observedOn" date,
  country text,
  "regionId" text,
  "locationPrecision" text,
  "locationLabel" text,
  "hasMicroscopy" boolean,
  "sporeMeasurementCount" bigint,
  "sporeSummary" jsonb,
  "sporePoints" jsonb,
  "sporeMosaic" jsonb,
  "contrastMethod" text,
  "mountReagent" text,
  "sampleType" text,
  "sampleSource" text,
  "prepSummary" jsonb,
  "mapLat" double precision,
  "mapLon" double precision
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public'
AS $$
  SELECT
    legacy.id,
    legacy."speciesSlug",
    legacy."speciesName",
    legacy."speciesCommonName",
    legacy."observerDisplayName",
    legacy."observedOn",
    legacy.country,
    legacy."regionId",
    legacy."locationPrecision",
    legacy."locationLabel",
    legacy."hasMicroscopy",
    legacy."sporeMeasurementCount",
    legacy."sporeSummary",
    legacy."sporePoints",
    CASE
      WHEN legacy."sporeMosaic" IS NULL OR mosaic.id IS NULL THEN legacy."sporeMosaic"
      ELSE legacy."sporeMosaic" || jsonb_build_object(
        'mosaicId', mosaic.id,
        'mosaicMediaVersion', mosaic.media_version,
        'mosaicMediaUrl', public.build_worker_mosaic_url(mosaic.id, mosaic.media_version)
      )
    END AS "sporeMosaic",
    legacy."contrastMethod",
    legacy."mountReagent",
    legacy."sampleType",
    legacy."sampleSource",
    legacy."prepSummary",
    legacy."mapLat",
    legacy."mapLon"
  FROM public._get_public_observation_stage2a(p_observation_id) legacy
  LEFT JOIN LATERAL (
    SELECT sm.id, sm.media_version
    FROM public.spore_measurement_mosaics sm
    WHERE sm.observation_id = legacy.id
    ORDER BY sm.version DESC, sm.id DESC
    LIMIT 1
  ) mosaic ON true
$$;

ALTER FUNCTION public.get_public_observation(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_public_observation(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_observation(bigint)
  TO anon, authenticated, service_role;

-- Public species RPCs keep representativeThumbUrl and append the identity
-- behind that representative. The helper repeats their public visibility,
-- draft, moderation, and block gates.
CREATE OR REPLACE FUNCTION public._stage2b_species_representative_media(p_species_slug text)
RETURNS TABLE(
  image_id bigint,
  media_version bigint,
  thumb_media_url text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public,pg_catalog'
AS $$
  SELECT
    i.id,
    i.media_version,
    public.build_worker_media_url(i.id, 'thumb', i.media_version)
  FROM public.observations o
  JOIN public.observation_images i ON i.observation_id = o.id
  WHERE o.visibility = 'public'
    AND NOT COALESCE(o.is_draft, false)
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
    AND i.storage_path IS NOT NULL
    AND btrim(i.storage_path) <> ''
    AND nullif(
      regexp_replace(
        regexp_replace(lower(btrim(concat_ws(' ', o.genus, o.species))), '[^a-z0-9]+', '-', 'g'),
        '(^-|-$)', '', 'g'
      ), ''
    ) = p_species_slug
    AND NOT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = o.user_id AND p.is_banned = true
    )
    AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE)
  ORDER BY o.date DESC, i.sort_order NULLS LAST, i.created_at DESC NULLS LAST, i.id DESC
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public._stage2b_species_representative_media(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._stage2b_species_representative_media(text)
  TO anon, authenticated, service_role;

ALTER FUNCTION public.search_public_species(integer, integer, text, text)
  RENAME TO _search_public_species_stage2a;
REVOKE ALL ON FUNCTION public._search_public_species_stage2a(integer, integer, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.search_public_species(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_genus text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text
)
RETURNS TABLE(
  "speciesSlug" text,
  genus text,
  species text,
  "speciesName" text,
  "commonName" text,
  "observationCount" bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount" bigint,
  "firstObservedOn" date,
  "lastObservedOn" date,
  countries jsonb,
  regions jsonb,
  "representativeThumbUrl" text,
  "representativeImageId" bigint,
  "representativeMediaVersion" bigint,
  "representativeThumbMediaUrl" text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public'
AS $$
  SELECT
    legacy.*,
    media.image_id AS "representativeImageId",
    media.media_version AS "representativeMediaVersion",
    media.thumb_media_url AS "representativeThumbMediaUrl"
  FROM public._search_public_species_stage2a(p_limit, p_offset, p_genus, p_query) legacy
  LEFT JOIN LATERAL public._stage2b_species_representative_media(legacy."speciesSlug") media ON true
$$;

ALTER FUNCTION public.search_public_species(integer, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_public_species(integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_species(integer, integer, text, text)
  TO anon, authenticated, service_role;

ALTER FUNCTION public.get_public_species(text)
  RENAME TO _get_public_species_stage2a;
REVOKE ALL ON FUNCTION public._get_public_species_stage2a(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_public_species(p_species_slug text)
RETURNS TABLE(
  "speciesSlug" text,
  genus text,
  species text,
  "speciesName" text,
  "commonName" text,
  "observationCount" bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount" bigint,
  "firstObservedOn" date,
  "lastObservedOn" date,
  countries jsonb,
  regions jsonb,
  "representativeThumbUrl" text,
  "recentObservationIds" bigint[],
  "representativeImageId" bigint,
  "representativeMediaVersion" bigint,
  "representativeThumbMediaUrl" text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path='public'
AS $$
  SELECT
    legacy.*,
    media.image_id AS "representativeImageId",
    media.media_version AS "representativeMediaVersion",
    media.thumb_media_url AS "representativeThumbMediaUrl"
  FROM public._get_public_species_stage2a(p_species_slug) legacy
  LEFT JOIN LATERAL public._stage2b_species_representative_media(legacy."speciesSlug") media ON true
$$;

ALTER FUNCTION public.get_public_species(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_public_species(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_species(text)
  TO anon, authenticated, service_role;

COMMENT ON VIEW public.observation_images_community_view IS
  'Transitional non-owner image projection. storage_path remains for shipped clients; prefer image_id/media_version/full_media_url/thumb_media_url. Never exposes originals.';
COMMENT ON VIEW public.observations_community_view IS
  'Transitional public observation projection. image_key/thumb_key remain temporarily; prefer authorized image identity fields.';
COMMENT ON VIEW public.observations_friend_view IS
  'Transitional friend observation projection. image_key/thumb_key remain temporarily; prefer authorized image identity fields.';
COMMENT ON VIEW public.observations_follow_view IS
  'Transitional follow projection. image_key/thumb_key remain temporarily; prefer authorized image identity fields.';

NOTIFY pgrst, 'reload schema';
COMMIT;
