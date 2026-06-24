-- Fix Draft leakage in observations_community_view and normalize inspected
-- legacy location_public/location_precision mismatches.
--
-- Product rules:
-- - Draft overrides visibility. A public draft is not public yet.
-- - location_precision is the current location-sharing control.
-- - location_public is legacy compatibility and should agree with exact/fuzzed intent.

CREATE OR REPLACE VIEW public.observations_community_view AS
 SELECT
    o.id,
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
      WHEN COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text
        THEN round(o.gps_latitude::numeric, 2)::double precision
      ELSE o.gps_latitude
    END AS gps_latitude,
    CASE
      WHEN COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text
        THEN round(o.gps_longitude::numeric, 2)::double precision
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
      WHEN COALESCE(o.spore_data_visibility, 'public'::text) = 'public'::text
        THEN o.spore_statistics
      ELSE NULL::jsonb
    END AS spore_statistics
   FROM public.observations o
  WHERE NOT COALESCE(o.is_draft, false)
    AND COALESCE(o.visibility, 'public'::text) = 'public'::text
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

-- Keep the Morchella location fuzzed.
UPDATE public.observations
SET
  location_precision = 'fuzzed',
  location_public = false
WHERE id = 608
  AND genus = 'Morchella'
  AND species = 'deliciosa';

-- The remaining inspected legacy rows can be exact/public-location rows.
UPDATE public.observations
SET
  location_precision = 'exact',
  location_public = true
WHERE id IN (
  583,
  243,
  99,
  35,
  34,
  33,
  32,
  31,
  30,
  29,
  28,
  27,
  26,
  24,
  20
);

NOTIFY pgrst, 'reload schema';