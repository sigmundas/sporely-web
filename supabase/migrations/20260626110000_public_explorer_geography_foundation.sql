-- Forward public explorer geography foundation for remote projects where the
-- historical 20260624124000 migration timestamp is already applied.
--
-- Adds structured geography fields, a normalized region lookup table, public
-- region read access, and expands location precision to the four
-- public-explorer states.
-- Legacy exact rows with location_public = false are normalized to hidden.
-- Existing fuzzed rows intentionally stay fuzzed for compatibility so current
-- public previews keep their shape.

CREATE TABLE IF NOT EXISTS public.public_regions (
  id text PRIMARY KEY,
  country_code text NOT NULL,
  label text NOT NULL,
  sort_order integer,
  map_x numeric,
  map_y numeric,
  CONSTRAINT public_regions_country_code_check CHECK (country_code ~ '^[A-Z]{2}$')
);

ALTER TABLE public.public_regions OWNER TO postgres;

COMMENT ON TABLE public.public_regions IS 'Normalized region lookup rows for public explorer filters and schematic map layout.';
COMMENT ON COLUMN public.public_regions.map_x IS 'Schematic map coordinate, not GPS.';
COMMENT ON COLUMN public.public_regions.map_y IS 'Schematic map coordinate, not GPS.';

ALTER TABLE public.public_regions
  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_regions: public read" ON public.public_regions;

CREATE POLICY "public_regions: public read" ON public.public_regions
  FOR SELECT
  TO anon, authenticated
  USING (true);

GRANT SELECT ON TABLE public.public_regions TO anon;
GRANT SELECT ON TABLE public.public_regions TO authenticated;
GRANT ALL ON TABLE public.public_regions TO service_role;

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS region_id text;

ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_location_precision_check;

ALTER TABLE public.observations
  ADD CONSTRAINT observations_location_precision_check
  CHECK (location_precision = ANY (ARRAY['exact'::text, 'fuzzed'::text, 'region'::text, 'hidden'::text]));

ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_country_code_check;

ALTER TABLE public.observations
  ADD CONSTRAINT observations_country_code_check
  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

UPDATE public.observations
SET location_precision = 'hidden'
WHERE location_public = false
  AND coalesce(location_precision, 'exact') = 'exact';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'observations_region_id_fkey'
      AND conrelid = 'public.observations'::regclass
  ) THEN
    ALTER TABLE public.observations
      ADD CONSTRAINT observations_region_id_fkey
      FOREIGN KEY (region_id) REFERENCES public.public_regions(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_observations_public_country_code
  ON public.observations USING btree (country_code)
  WHERE country_code IS NOT NULL
    AND COALESCE(visibility, 'public') = 'public'
    AND NOT COALESCE(is_draft, false);

CREATE INDEX IF NOT EXISTS idx_observations_public_region_id
  ON public.observations USING btree (region_id)
  WHERE region_id IS NOT NULL
    AND COALESCE(visibility, 'public') = 'public'
    AND NOT COALESCE(is_draft, false);

CREATE OR REPLACE FUNCTION public.enforce_non_public_observation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_count integer;
BEGIN
  IF coalesce(NEW.is_draft, false) THEN
    RETURN NEW;
  END IF;

  IF coalesce(NEW.visibility, 'public') = 'public'
     AND coalesce(NEW.location_precision, 'exact') = 'exact' THEN
    RETURN NEW;
  END IF;

  IF public.profile_has_pro_access(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));

  SELECT count(*)::integer
  INTO current_count
  FROM public.observations o
  WHERE o.user_id = NEW.user_id
    AND NOT coalesce(o.is_draft, false)
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') IN ('fuzzed', 'region', 'hidden')
    )
    AND (TG_OP = 'INSERT' OR o.id <> NEW.id);

  IF current_count >= 20 THEN
    RAISE EXCEPTION
      'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

ALTER FUNCTION public.enforce_non_public_observation_limit() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.non_public_observation_count(profile_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT count(*)::integer
  FROM public.observations o
  WHERE o.user_id = profile_id
    AND NOT coalesce(o.is_draft, false)
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') IN ('fuzzed', 'region', 'hidden')
    )
$$;

ALTER FUNCTION public.non_public_observation_count(uuid) OWNER TO postgres;

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
      WHEN COALESCE(o.location_precision, 'exact'::text) IN ('region'::text, 'hidden'::text)
        THEN NULL::double precision
      ELSE o.gps_latitude
    END AS gps_latitude,
    CASE
      WHEN COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text
        THEN round(o.gps_longitude::numeric, 2)::double precision
      WHEN COALESCE(o.location_precision, 'exact'::text) IN ('region'::text, 'hidden'::text)
        THEN NULL::double precision
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
  WHERE COALESCE(o.visibility, 'public'::text) = 'public'::text
    AND NOT COALESCE(o.is_draft, false)
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = o.user_id
        AND p.is_banned = true
    )
    AND NOT public.is_blocked_between(auth.uid(), o.user_id);

ALTER VIEW public.observations_community_view OWNER TO postgres;

NOTIFY pgrst, 'reload schema';
