-- Stage 1: private, client-reported provenance. No historical inference.
-- Existing owner RLS and explicit public projections remain authoritative.
ALTER TABLE public.observation_images
  ADD COLUMN ingest_method text,
  ADD CONSTRAINT observation_images_ingest_method_check CHECK (
    ingest_method IS NULL OR ingest_method IN (
      'sporely_camera', 'system_camera', 'web_camera',
      'native_picker', 'web_file_picker', 'unknown'
    )
  );

ALTER TABLE public.observations
  ADD COLUMN location_source text,
  ADD COLUMN location_status text,
  ADD CONSTRAINT observations_location_provenance_check CHECK (
    (location_source IS NULL AND location_status IS NULL)
    OR (
      location_source IS NOT NULL AND location_status IS NOT NULL
      AND (
        (
          location_source IN ('device_gps', 'image_exif', 'manual', 'unknown')
          AND location_status = 'acquired'
          AND gps_latitude IS NOT NULL AND gps_longitude IS NOT NULL
          AND gps_latitude BETWEEN -90 AND 90
          AND gps_longitude BETWEEN -180 AND 180
        )
        OR (
          location_source IN ('none', 'unknown')
          AND location_status IN ('disabled', 'denied', 'timeout', 'skipped', 'unavailable', 'unknown')
          AND gps_latitude IS NULL AND gps_longitude IS NULL
          AND gps_altitude IS NULL AND gps_accuracy IS NULL
        )
      )
    )
  );

COMMENT ON COLUMN public.observation_images.ingest_method IS
  'Private client-reported Sporely entry point, not photographing-device identity; NULL for legacy/unsupported clients.';
COMMENT ON COLUMN public.observations.location_source IS
  'Private origin of current coordinates. Legacy coordinate changes invalidate both provenance fields; use set_observation_location for attributed changes.';
COMMENT ON COLUMN public.observations.location_status IS
  'Private selected-location outcome. Continue-without-location preserves meaningful GPS failures; skipped applies only without such an outcome or on deliberate clearing.';

CREATE FUNCTION public._invalidate_changed_location_provenance()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  IF ROW(NEW.gps_latitude, NEW.gps_longitude, NEW.gps_altitude, NEW.gps_accuracy)
     IS DISTINCT FROM
     ROW(OLD.gps_latitude, OLD.gps_longitude, OLD.gps_altitude, OLD.gps_accuracy) THEN
    -- Comparing provenance values cannot tell an omitted field from an
    -- explicitly resent identical enum. Ordinary coordinate changes always
    -- invalidate; the aware RPC reattaches its complete pair atomically.
    NEW.location_source := NULL;
    NEW.location_status := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._invalidate_changed_location_provenance() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_location_provenance_invalidate
BEFORE UPDATE ON public.observations
FOR EACH ROW EXECUTE FUNCTION public._invalidate_changed_location_provenance();

CREATE FUNCTION public.set_observation_location(
  p_observation_id bigint,
  p_gps_latitude double precision,
  p_gps_longitude double precision,
  p_gps_altitude real,
  p_gps_accuracy real,
  p_location_source text,
  p_location_status text
)
RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  current_row public.observations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_location_source IS NULL OR p_location_status IS NULL THEN
    RAISE EXCEPTION 'Complete location provenance required' USING ERRCODE = '23514';
  END IF;
  -- Validate even when a concurrent/idempotent retry would be a no-op.
  IF NOT (
    (
      p_location_source IN ('device_gps', 'image_exif', 'manual', 'unknown')
      AND p_location_status = 'acquired'
      AND p_gps_latitude IS NOT NULL AND p_gps_longitude IS NOT NULL
      AND p_gps_latitude BETWEEN -90 AND 90
      AND p_gps_longitude BETWEEN -180 AND 180
    ) OR (
      p_location_source IN ('none', 'unknown')
      AND p_location_status IN ('disabled', 'denied', 'timeout', 'skipped', 'unavailable', 'unknown')
      AND p_gps_latitude IS NULL AND p_gps_longitude IS NULL
      AND p_gps_altitude IS NULL AND p_gps_accuracy IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'Invalid location/provenance combination' USING ERRCODE = '23514';
  END IF;

  -- Explicit owner predicate plus existing RLS; serialize the two writes.
  SELECT * INTO current_row FROM public.observations
    WHERE id = p_observation_id AND user_id = auth.uid()
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observation not available to owner' USING ERRCODE = '42501';
  END IF;

  IF ROW(current_row.gps_latitude, current_row.gps_longitude,
         current_row.gps_altitude, current_row.gps_accuracy)
     IS DISTINCT FROM
     ROW(p_gps_latitude, p_gps_longitude, p_gps_altitude, p_gps_accuracy) THEN
    UPDATE public.observations
      SET gps_latitude = p_gps_latitude, gps_longitude = p_gps_longitude,
          gps_altitude = p_gps_altitude, gps_accuracy = p_gps_accuracy
      WHERE id = p_observation_id AND user_id = auth.uid();
    current_row.location_source := NULL;
    current_row.location_status := NULL;
  END IF;

  IF ROW(current_row.location_source, current_row.location_status)
     IS DISTINCT FROM ROW(p_location_source, p_location_status) THEN
    UPDATE public.observations
      SET location_source = p_location_source, location_status = p_location_status
      WHERE id = p_observation_id AND user_id = auth.uid();
  END IF;
  RETURN p_observation_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_observation_location(bigint, double precision, double precision, real, real, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_observation_location(bigint, double precision, double precision, real, real, text, text)
  TO authenticated;
COMMENT ON FUNCTION public.set_observation_location(bigint, double precision, double precision, real, real, text, text) IS
  'Owner/RLS-enforced atomic location assignment. All arguments required. Same-value retries make no writes; no client bypass flag. Public read projections omit provenance.';
