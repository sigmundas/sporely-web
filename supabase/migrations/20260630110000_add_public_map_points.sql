-- Public map points RPC.
--
-- Returns a flat list of privacy-safe map coordinates for public observations,
-- suitable for rendering a global map view. Supports all standard filters.
--
-- Prep filters (sample_type, mount_reagent, contrast_method) use EXISTS
-- semantics: an observation qualifies when ANY of its microscope images matches
-- the requested prep type, not just the latest one.
--
-- Coordinates are privacy-gated identically to get_public_observation:
--   exact  → raw GPS
--   fuzzed → rounded to 2 decimal places
--   hidden/region → NULL
--
-- Results are capped at min(p_limit, 5000), default 3000. The caller detects
-- capping by comparing results.length === limit.

CREATE OR REPLACE FUNCTION public.get_public_map_points(
  p_species_slug    text    DEFAULT NULL,
  p_genus           text    DEFAULT NULL,
  p_search          text    DEFAULT NULL,
  p_country         text    DEFAULT NULL,
  p_region_id       text    DEFAULT NULL,
  p_date_from       date    DEFAULT NULL,
  p_date_to         date    DEFAULT NULL,
  p_sample_type     text    DEFAULT NULL,
  p_mount_reagent   text    DEFAULT NULL,
  p_contrast_method text    DEFAULT NULL,
  p_has_microscopy  boolean DEFAULT NULL,
  p_has_spores      boolean DEFAULT NULL,
  p_limit           integer DEFAULT 3000
)
RETURNS TABLE(
  "observationId"         bigint,
  "speciesSlug"           text,
  "speciesName"           text,
  "speciesCommonName"     text,
  "observedOn"            date,
  country                 text,
  "regionId"              text,
  "locationLabel"         text,
  "mapLat"                double precision,
  "mapLon"                double precision,
  "locationPrecision"     text,
  "hasMicroscopy"         boolean,
  "sporeMeasurementCount" bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH norm AS (
    SELECT
      -- Species slug: double regexp_replace same as all other species RPCs.
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(coalesce(p_species_slug, ''))),
            '[^a-z0-9]+', '-', 'g'
          ),
          '(^-|-$)', '', 'g'
        ),
        ''
      ) AS slug,
      nullif(btrim(lower(coalesce(p_genus,  ''))),          '') AS genus,
      nullif(btrim(coalesce(p_search, '')),                  '') AS search,
      nullif(btrim(upper(coalesce(p_country, ''))),          '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),               '') AS region_id,
      p_date_from                                               AS date_from,
      p_date_to                                                 AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type,     ''))),  '') AS sample_type,
      nullif(btrim(lower(coalesce(p_mount_reagent,   ''))),  '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))),  '') AS contrast_method,
      p_has_microscopy                                          AS has_microscopy,
      p_has_spores                                              AS has_spores,
      greatest(1, least(coalesce(p_limit, 3000), 5000))        AS lim
  ),

  candidate AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus,        '')), '') AS genus,
      nullif(btrim(coalesce(o.species,      '')), '') AS species,
      nullif(btrim(coalesce(o.common_name,  '')), '') AS common_name,
      o.date                                          AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country,
      nullif(btrim(coalesce(o.region_id,    '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden')        AS location_precision,
      nullif(btrim(coalesce(o.location,     '')), '') AS location,
      nullif(btrim(coalesce(r.label,        '')), '') AS region_label,
      o.gps_latitude,
      o.gps_longitude,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    LEFT JOIN public.public_regions r ON r.id = o.region_id
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
      -- Taxon filter: species slug wins, then genus, then free-text search.
      -- If all three are null, no taxon restriction (return all public observations).
      AND (
        n.slug IS NULL AND n.genus IS NULL AND n.search IS NULL
        OR (
          n.slug IS NOT NULL
          AND nullif(
                regexp_replace(
                  regexp_replace(
                    lower(btrim(concat_ws(' ',
                      nullif(btrim(coalesce(o.genus,   '')), ''),
                      nullif(btrim(coalesce(o.species, '')), '')
                    ))),
                    '[^a-z0-9]+', '-', 'g'
                  ),
                  '(^-|-$)', '', 'g'
                ),
                ''
              ) = n.slug
        )
        OR (
          n.slug IS NULL AND n.genus IS NOT NULL
          AND lower(coalesce(o.genus, '')) = n.genus
        )
        OR (
          n.slug IS NULL AND n.genus IS NULL AND n.search IS NOT NULL
          AND (
            lower(coalesce(o.genus,    '')) ILIKE '%' || n.search || '%'
            OR lower(coalesce(o.species, '')) ILIKE '%' || n.search || '%'
          )
        )
      )
      -- Geo / date filters.
      AND (n.country   IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from IS NULL OR o.date >= n.date_from)
      AND (n.date_to   IS NULL OR o.date <= n.date_to)
      -- Prep filters via EXISTS: observation qualifies when ANY matching-prep
      -- microscope image exists, not just the latest one.
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.sample_type, '')) = n.sample_type
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND i2.image_type = 'microscope'
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = o.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND i3.image_type = 'microscope'
      ))
      -- p_has_spores = true: spore_data_visibility must be public AND have
      -- at least one qualifying spore measurement.
      AND (n.has_spores IS NOT TRUE OR (
        o.spore_data_visibility = 'public'
        AND EXISTS (
          SELECT 1
          FROM public.observation_images i4
          JOIN public.spore_measurements m ON m.image_id = i4.id
          WHERE i4.observation_id = o.id
            AND i4.deleted_at IS NULL AND i4.purged_at IS NULL
            AND i4.image_type = 'microscope'
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
        )
      ))
  )

  SELECT
    c.id AS "observationId",
    -- speciesSlug: double regexp_replace same as search_public_observations.
    nullif(
      regexp_replace(
        regexp_replace(
          lower(btrim(concat_ws(' ', c.genus, c.species))),
          '[^a-z0-9]+', '-', 'g'
        ),
        '(^-|-$)', '', 'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', c.genus, c.species)), '') AS "speciesName",
    c.common_name AS "speciesCommonName",
    c.observed_on AS "observedOn",
    c.country     AS country,
    c.region_id   AS "regionId",
    -- locationLabel: privacy-safe same as existing RPCs.
    CASE c.location_precision
      WHEN 'exact'  THEN c.location
      WHEN 'fuzzed' THEN coalesce(c.region_label, c.country)
      WHEN 'region' THEN c.region_label
      ELSE NULL
    END AS "locationLabel",
    -- Privacy-safe coordinates.
    CASE c.location_precision
      WHEN 'exact'  THEN c.gps_latitude
      WHEN 'fuzzed' THEN round(c.gps_latitude::numeric, 2)::double precision
      ELSE NULL
    END AS "mapLat",
    CASE c.location_precision
      WHEN 'exact'  THEN c.gps_longitude
      WHEN 'fuzzed' THEN round(c.gps_longitude::numeric, 2)::double precision
      ELSE NULL
    END AS "mapLon",
    c.location_precision AS "locationPrecision",
    -- hasMicroscopy: observation's overall flag, regardless of prep filter.
    (EXISTS (
      SELECT 1 FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
    )) AS "hasMicroscopy",
    -- sporeMeasurementCount: public measurements only.
    CASE WHEN c.spore_data_visibility = 'public' THEN (
      SELECT count(m.id)::bigint
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND i.image_type = 'microscope'
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) ELSE 0 END AS "sporeMeasurementCount"
  FROM candidate c
  CROSS JOIN norm n
  ORDER BY c.observed_on DESC, c.id DESC
  LIMIT (SELECT lim FROM norm)
$$;

ALTER FUNCTION public.get_public_map_points(
  text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_map_points(
  text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_map_points(
  text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer
) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_map_points(
  text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_map_points(
  text, text, text, text, text, date, date, text, text, text, boolean, boolean, integer
) TO service_role;

NOTIFY pgrst, 'reload schema';
