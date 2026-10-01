-- Rollback of supabase/migrations/20261001195524_hide_observation_time_of_day_from_non_owners.sql.
-- NOT a migration: kept outside supabase/migrations so it never runs by
-- accident. Restores the previous view bodies, which expose captured_at,
-- created_at and ai_selected_at (and observation_images_community_view
-- created_at) with time of day to anon and every signed-in non-owner, i.e.
-- reintroduces the privacy defect. Use only if the forward migration breaks
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

COMMIT;
