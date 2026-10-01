-- Rollback of supabase/migrations/20261001195524_hide_observation_time_of_day_from_non_owners.sql.
-- NOT a migration: kept outside supabase/migrations so it never runs by
-- accident. Restores the previous view bodies, which expose captured_at,
-- created_at and ai_selected_at (and observation_images_community_view
-- created_at, observation_identifications_community_view created_at and
-- updated_at) with time of day, and image storage keys / legacy key URLs
-- (which embed the upload epoch-ms) to anon and every signed-in non-owner,
-- i.e. reintroduces the privacy defect. Also restores
-- search_public_observation_images with its legacy URLs. Use only if the forward migration breaks
-- a client and the exposure has been accepted for that window.
--
-- Promotion to a real migration: copy this file unchanged to
-- supabase/migrations/<new UTC timestamp>_rollback_hide_observation_time_of_day.sql
-- and deploy through the normal deploy path. Never edit or delete 20261001195524
-- itself once applied.

BEGIN;

CREATE OR REPLACE VIEW public.observations_community_view WITH (security_barrier = true) AS
SELECT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    o.captured_at,
    o.created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'exact'::text) THEN o.location
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['fuzzed'::text, 'region'::text])) THEN COALESCE(pr.label, o.country_code)
            ELSE NULL::text
        END AS location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    o.image_key,
    o.thumb_key,
    o.is_draft,
    o.location_precision,
    o.ai_selected_service,
    o.ai_selected_taxon_id,
    o.ai_selected_scientific_name,
    o.ai_selected_probability,
    o.ai_selected_at,
        CASE
            WHEN (COALESCE(o.spore_data_visibility, 'public'::text) = 'public'::text) THEN o.spore_statistics
            ELSE NULL::jsonb
        END AS spore_statistics,
    o.red_list_category,
    o.red_list_categories_json,
    media.image_id,
    media.media_version,
    media.full_media_url,
    media.thumb_media_url,
    o.selected_sporely_taxon_id,
    o.taxon_identity_state,
    o.taxon_identity_source_system,
    o.taxon_identity_namespace,
    o.taxon_identity_external_id,
    o.taxon_identity_raw_external_id
   FROM ((observations o
     LEFT JOIN public_regions pr ON ((pr.id = o.region_id)))
     LEFT JOIN LATERAL _stage2b_observation_primary_media(o.id, o.image_key) media(image_id, media_version, full_media_url, thumb_media_url) ON (true))
  WHERE ((COALESCE(o.visibility, 'public'::text) = 'public'::text) AND (NOT COALESCE(o.is_draft, false)) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observations_follow_view AS
SELECT DISTINCT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    o.captured_at,
    o.created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'exact'::text) THEN o.location
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['fuzzed'::text, 'region'::text])) THEN COALESCE(pr.label, o.country_code)
            ELSE NULL::text
        END AS location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    o.image_key,
    o.thumb_key,
    o.is_draft,
    o.location_precision,
    media.image_id,
    media.media_version,
    media.full_media_url,
    media.thumb_media_url
   FROM (((observations o
     JOIN follows f ON (((f.user_id = auth.uid()) AND (((f.target_type = 'user'::text) AND (f.target_id = (o.user_id)::text)) OR ((f.target_type = 'observation'::text) AND (f.target_id = (o.id)::text)) OR ((f.target_type = 'genus'::text) AND (lower(f.target_id) = lower(COALESCE(o.genus, ''::text)))) OR ((f.target_type = 'species'::text) AND (lower(f.target_id) = lower(TRIM(BOTH FROM concat_ws(' '::text, o.genus, o.species)))))))))
     LEFT JOIN public_regions pr ON ((pr.id = o.region_id)))
     LEFT JOIN LATERAL _stage2b_observation_primary_media(o.id, o.image_key) media(image_id, media_version, full_media_url, thumb_media_url) ON (true))
  WHERE (can_read_observation(o.user_id, o.visibility) AND (NOT COALESCE(o.is_draft, false)) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observations_friend_view WITH (security_barrier = true) AS
SELECT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    o.captured_at,
    o.created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'exact'::text) THEN o.location
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['fuzzed'::text, 'region'::text])) THEN COALESCE(pr.label, o.country_code)
            ELSE NULL::text
        END AS location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    o.image_key,
    o.thumb_key,
    o.is_draft,
    o.location_precision,
    o.ai_selected_service,
    o.ai_selected_taxon_id,
    o.ai_selected_scientific_name,
    o.ai_selected_probability,
    o.ai_selected_at,
    o.red_list_category,
    o.red_list_categories_json,
    media.image_id,
    media.media_version,
    media.full_media_url,
    media.thumb_media_url,
    o.selected_sporely_taxon_id,
    o.taxon_identity_state,
    o.taxon_identity_source_system,
    o.taxon_identity_namespace,
    o.taxon_identity_external_id,
    o.taxon_identity_raw_external_id
   FROM ((observations o
     LEFT JOIN public_regions pr ON ((pr.id = o.region_id)))
     LEFT JOIN LATERAL _stage2b_observation_primary_media(o.id, o.image_key) media(image_id, media_version, full_media_url, thumb_media_url) ON (true))
  WHERE ((COALESCE(o.visibility, 'public'::text) = ANY (ARRAY['friends'::text, 'public'::text])) AND (NOT COALESCE(o.is_draft, false)) AND current_user_is_friend_with(o.user_id) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observation_images_community_view WITH (security_barrier = true) AS
SELECT oi.id,
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
    NULL::timestamp with time zone AS deleted_at,
    o.user_id AS observation_user_id,
    o.visibility AS observation_visibility,
    o.is_draft AS observation_is_draft,
    o.spore_data_visibility AS observation_spore_data_visibility,
    oi.id AS image_id,
    oi.media_version,
    build_worker_media_url(oi.id, 'full'::text, oi.media_version) AS full_media_url,
    build_worker_media_url(oi.id, 'thumb'::text, oi.media_version) AS thumb_media_url
   FROM (observation_images oi
     JOIN observations o ON ((o.id = oi.observation_id)))
  WHERE ((oi.deleted_at IS NULL) AND (oi.purged_at IS NULL) AND (oi.storage_path IS NOT NULL) AND (btrim(oi.storage_path) <> ''::text) AND (NOT COALESCE(o.is_draft, false)) AND can_read_observation(o.user_id, o.visibility) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observation_identifications_community_view WITH (security_barrier = true) AS
SELECT oi.id,
    oi.observation_id,
    oi.service,
    oi.status,
    safe_results.results,
    oi.top_scientific_name,
    oi.top_vernacular_name,
    oi.top_taxon_id,
    oi.top_probability,
    oi.top_species_url,
    oi.top_redlist_category,
    oi.top_redlist_status,
    oi.top_redlist_source,
    oi.created_at,
    oi.updated_at
   FROM ((observation_identifications oi
     JOIN observations o ON ((o.id = oi.observation_id)))
     CROSS JOIN LATERAL ( SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('rank', COALESCE((candidate.value -> 'rank'::text), to_jsonb((candidate.ordinality)::integer)), 'service', COALESCE((candidate.value -> 'service'::text), to_jsonb(oi.service)), 'taxon_id', COALESCE((candidate.value -> 'taxon_id'::text), (candidate.value -> 'taxonId'::text)), 'scientific_name', COALESCE((candidate.value -> 'scientific_name'::text), (candidate.value -> 'scientificName'::text)), 'vernacular_name', COALESCE((candidate.value -> 'vernacular_name'::text), (candidate.value -> 'vernacularName'::text)), 'probability', COALESCE((candidate.value -> 'probability'::text), (candidate.value -> 'score'::text)), 'species_url', COALESCE((candidate.value -> 'species_url'::text), (candidate.value -> 'speciesUrl'::text)), 'redlist_category', COALESCE((candidate.value -> 'redlist_category'::text), (candidate.value -> 'redlistCategory'::text)), 'redlist_status', COALESCE((candidate.value -> 'redlist_status'::text), (candidate.value -> 'redlistStatus'::text)), 'redlist_source', COALESCE((candidate.value -> 'redlist_source'::text), (candidate.value -> 'redlistSource'::text)), 'picture_url', COALESCE((candidate.value -> 'picture_url'::text), (candidate.value -> 'pictureUrl'::text), (candidate.value -> 'photo_url'::text), (candidate.value -> 'photoUrl'::text), (candidate.value -> 'image_url'::text), (candidate.value -> 'imageUrl'::text), (candidate.value -> 'thumbnail_url'::text), (candidate.value -> 'thumbnailUrl'::text)), 'external_ids', NULLIF(jsonb_strip_nulls(jsonb_build_object('gbif', ((candidate.value -> 'external_ids'::text) -> 'gbif'::text), 'inat', ((candidate.value -> 'external_ids'::text) -> 'inat'::text), 'nbic', ((candidate.value -> 'external_ids'::text) -> 'nbic'::text))), '{}'::jsonb))) ORDER BY candidate.ordinality), '[]'::jsonb) AS results
           FROM jsonb_array_elements(
                CASE
                    WHEN (jsonb_typeof(oi.results) = 'array'::text) THEN oi.results
                    ELSE '[]'::jsonb
                END) WITH ORDINALITY candidate(value, ordinality)) safe_results)
  WHERE (((o.user_id = auth.uid()) OR ((NOT COALESCE(o.is_draft, false)) AND can_read_observation(o.user_id, o.visibility))) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE FUNCTION public.search_public_observation_images(p_observation_ids bigint[] DEFAULT NULL::bigint[])
 RETURNS TABLE("observationId" bigint, "imageId" bigint, "sortOrder" integer, "imageType" text, width integer, height integer, "thumbUrl" text, "previewUrl" text, "fullUrl" text, "aiCropX1" double precision, "aiCropY1" double precision, "aiCropX2" double precision, "aiCropY2" double precision, "aiCropSourceW" integer, "aiCropSourceH" integer, "aiCropIsCustom" boolean, "scaleMicronsPerPixel" double precision, "mediaVersion" bigint, "fullMediaUrl" text, "thumbMediaUrl" text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

COMMIT;
