ALTER TABLE public.observation_identifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own observation identifications" ON public.observation_identifications;
DROP POLICY IF EXISTS "Users can read observation identifications for visible observations" ON public.observation_identifications;
DROP POLICY IF EXISTS observation_identifications_select_own ON public.observation_identifications;
DROP POLICY IF EXISTS observation_identifications_select_visible ON public.observation_identifications;

CREATE POLICY "Users can read observation identifications for visible observations"
  ON public.observation_identifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_identifications.observation_id
        AND public.can_read_observation(o.user_id, o.visibility)
    )
  );

CREATE OR REPLACE VIEW public.observations_community_view AS
SELECT
  id,
  user_id,
  desktop_id,
  date,
  captured_at,
  created_at,
  genus,
  species,
  common_name,
  author,
  location,
  habitat,
  notes,
  uncertain,
  location_public,
  visibility,
  CASE
    WHEN coalesce(location_precision, 'exact') = 'fuzzed' THEN round(gps_latitude::numeric, 2)::double precision
    ELSE gps_latitude
  END AS gps_latitude,
  CASE
    WHEN coalesce(location_precision, 'exact') = 'fuzzed' THEN round(gps_longitude::numeric, 2)::double precision
    ELSE gps_longitude
  END AS gps_longitude,
  source_type,
  spore_data_visibility,
  image_key,
  thumb_key,
  is_draft,
  location_precision,
  ai_selected_service,
  ai_selected_taxon_id,
  ai_selected_scientific_name,
  ai_selected_probability,
  ai_selected_at
FROM public.observations o
WHERE (
  coalesce(visibility, 'public') = 'public'
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = o.user_id
      AND p.is_banned = true
  )
  AND NOT public.is_blocked_between(auth.uid(), user_id)
);
