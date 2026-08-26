-- Visibility-gated spore-mosaic identity for detail screens.
--
-- spore_measurement_mosaics is owner-only under RLS, but the mosaic
-- image itself is deliverable to any viewer the observation's
-- visibility rules allow (the media worker already authorizes delivery
-- via media_authorize_mosaic_delivery). This RPC lets clients discover
-- the mosaic URL for an observation without widening table RLS: it
-- reuses the exact delivery-authorization gates and returns only the
-- worker URL and display dimensions — never the raw storage key.

CREATE OR REPLACE FUNCTION public.get_observation_spore_mosaic(p_observation_id bigint)
RETURNS TABLE(
  "mosaicId" bigint,
  url text,
  "widthPx" integer,
  "heightPx" integer,
  "tileWidthPx" integer,
  "tileHeightPx" integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    m.id AS "mosaicId",
    public.build_worker_mosaic_url(m.id, m.media_version) AS url,
    m.width_px AS "widthPx",
    m.height_px AS "heightPx",
    m.tile_width_px AS "tileWidthPx",
    m.tile_height_px AS "tileHeightPx"
  FROM public.spore_measurement_mosaics m
  JOIN LATERAL public.media_authorize_mosaic_delivery(m.id, auth.uid()) a ON true
  WHERE m.observation_id = p_observation_id
    AND a.allowed
    AND public.build_worker_mosaic_url(m.id, m.media_version) IS NOT NULL
  ORDER BY m.updated_at DESC
  LIMIT 1
$$;

ALTER FUNCTION public.get_observation_spore_mosaic(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_observation_spore_mosaic(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_observation_spore_mosaic(bigint) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_observation_spore_mosaic(bigint) IS
  'Returns the worker delivery URL and dimensions for an observation''s spore mosaic, gated by the same authorization as media delivery (media_authorize_mosaic_delivery). Never exposes storage keys.';

NOTIFY pgrst, 'reload schema';
