CREATE OR REPLACE VIEW public.observations_community_view AS
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
    o.location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
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
            WHEN COALESCE(o.spore_data_visibility, 'public'::text) = 'public'::text THEN o.spore_statistics
            ELSE NULL::jsonb
        END AS spore_statistics
   FROM public.observations o
  WHERE (COALESCE(o.visibility, 'public'::text) = 'public'::text)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observation_images_community_view AS
 SELECT oi.*,
    o.user_id AS observation_user_id,
    o.visibility AS observation_visibility,
    o.is_draft AS observation_is_draft,
    o.spore_data_visibility AS observation_spore_data_visibility
   FROM public.observation_images oi
   JOIN public.observations o ON o.id = oi.observation_id
  WHERE public.can_read_observation(o.user_id, o.visibility)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

ALTER VIEW public.observations_community_view OWNER TO postgres;
ALTER VIEW public.observation_images_community_view OWNER TO postgres;

REVOKE ALL ON TABLE public.observation_images_community_view FROM PUBLIC;
GRANT ALL ON TABLE public.observation_images_community_view TO anon;
GRANT ALL ON TABLE public.observation_images_community_view TO authenticated;
GRANT ALL ON TABLE public.observation_images_community_view TO service_role;

NOTIFY pgrst, 'reload schema';

