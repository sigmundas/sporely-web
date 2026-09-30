-- Emergency production hotfix, applied directly to production on 2026-09-30
-- to repair 20260930181144. Recorded here after the fact; the SQL below is the
-- statement text from production's supabase_migrations.schema_migrations row
-- for this version.
--
-- Restores the caller-bound wrappers that 20260812140000 put in both detail
-- views (public.current_user_is_blocked_with / current_user_is_friend_with)
-- in place of the direct public.is_blocked_between / public.are_friends calls
-- that 20260930181144 reintroduced, and keeps its six taxonomy identity
-- columns. CREATE OR REPLACE VIEW keeps the existing owner and grants.
--
-- Side effect on view options: CREATE OR REPLACE VIEW replaces reloptions.
-- 20260812140000 rebuilt both views without a WITH clause, which cleared
-- security_barrier; this definition (like 20260930181144) sets it again, so
-- both views carry security_barrier = true from here on.


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
  media.image_id, media.media_version, media.full_media_url, media.thumb_media_url,
  o.selected_sporely_taxon_id,
  o.taxon_identity_state,
  o.taxon_identity_source_system,
  o.taxon_identity_namespace,
  o.taxon_identity_external_id,
  o.taxon_identity_raw_external_id
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
LEFT JOIN LATERAL public._stage2b_observation_primary_media(o.id, o.image_key) media ON true
WHERE COALESCE(o.visibility,'public') = 'public'
  AND NOT COALESCE(o.is_draft, false)
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = o.user_id AND p.is_banned = true
  )
  AND NOT public.current_user_is_blocked_with(o.user_id);

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
  media.image_id, media.media_version, media.full_media_url, media.thumb_media_url,
  o.selected_sporely_taxon_id,
  o.taxon_identity_state,
  o.taxon_identity_source_system,
  o.taxon_identity_namespace,
  o.taxon_identity_external_id,
  o.taxon_identity_raw_external_id
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
LEFT JOIN LATERAL public._stage2b_observation_primary_media(o.id, o.image_key) media ON true
WHERE COALESCE(o.visibility,'public') = ANY (ARRAY['friends','public'])
  AND NOT COALESCE(o.is_draft, false)
  AND public.current_user_is_friend_with(o.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = o.user_id AND p.is_banned = true
  )
  AND NOT public.current_user_is_blocked_with(o.user_id);

COMMENT ON VIEW public.observations_community_view IS
  'Transitional public observation projection. image_key/thumb_key remain temporarily; prefer authorized image identity fields.';
COMMENT ON VIEW public.observations_friend_view IS
  'Transitional friend observation projection. image_key/thumb_key remain temporarily; prefer authorized image identity fields.';

NOTIFY pgrst, 'reload schema';
