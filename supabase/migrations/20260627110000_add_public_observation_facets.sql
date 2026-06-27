-- Public explorer facet surface for anonymous browsing.
--
-- Returns safe dropdown options derived only from public observations that
-- pass the same visibility gates as search_public_observations.

CREATE OR REPLACE FUNCTION public.get_public_observation_facets()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      nullif(lower(btrim(coalesce(latest_image.sample_type, ''))), '') AS sample_type
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT
        i.contrast,
        i.mount_medium,
        i.sample_type
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_image ON true
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = o.user_id
          AND p.is_banned = true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
      )
  ),
  country_labels AS (
    SELECT *
    FROM (
      VALUES
        ('DE'::text, 'Germany'::text),
        ('FI'::text, 'Finland'::text),
        ('GB'::text, 'United Kingdom'::text),
        ('NO'::text, 'Norway'::text),
        ('SE'::text, 'Sweden'::text)
    ) AS c(country_code, label)
  ),
  genera AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.genus AS value,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.genus,
          'label', grouped.genus,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.genus,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.genus IS NOT NULL
        GROUP BY vo.genus
      ) grouped
    ) items
  ),
  species AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.species_name AS value,
        grouped.species_name AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.species_name,
          'label', grouped.species_name,
          'genus', grouped.genus,
          'species', grouped.species,
          'speciesName', grouped.species_name,
          'commonName', grouped.common_name,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.genus,
          vo.species,
          nullif(btrim(concat_ws(' ', vo.genus, vo.species)), '') AS species_name,
          min(vo.common_name) AS common_name,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.genus IS NOT NULL
          AND vo.species IS NOT NULL
        GROUP BY vo.genus, vo.species
      ) grouped
    ) items
  ),
  countries AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.country_code AS value,
        coalesce(cl.label, grouped.country_code) AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.country_code,
          'label', coalesce(cl.label, grouped.country_code),
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ),
  regions AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.region_id AS value,
        grouped.region_label AS label,
        grouped.region_country_code AS country_code,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.region_id,
          'label', grouped.region_label,
          'countryCode', grouped.region_country_code,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.region_id,
          coalesce(vo.region_label, vo.region_id) AS region_label,
          coalesce(vo.region_country_code, vo.country_code) AS region_country_code,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ),
  sample_types AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.sample_type AS value,
        CASE
          WHEN grouped.sample_type ~ '^[A-Z0-9]+$' THEN grouped.sample_type
          ELSE initcap(grouped.sample_type)
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.sample_type,
          'label', CASE
            WHEN grouped.sample_type ~ '^[A-Z0-9]+$' THEN grouped.sample_type
            ELSE initcap(grouped.sample_type)
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.sample_type,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.sample_type IS NOT NULL
        GROUP BY vo.sample_type
      ) grouped
    ) items
  ),
  contrast_methods AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.contrast_method AS value,
        CASE
          WHEN grouped.contrast_method ~ '^[A-Z0-9]+$' THEN grouped.contrast_method
          ELSE initcap(lower(grouped.contrast_method))
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.contrast_method,
          'label', CASE
            WHEN grouped.contrast_method ~ '^[A-Z0-9]+$' THEN grouped.contrast_method
            ELSE initcap(lower(grouped.contrast_method))
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.contrast_method,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.contrast_method IS NOT NULL
        GROUP BY vo.contrast_method
      ) grouped
    ) items
  ),
  mount_reagents AS (
    SELECT coalesce(
      jsonb_agg(item ORDER BY facet_count DESC, label ASC, value ASC),
      '[]'::jsonb
    ) AS items
    FROM (
      SELECT
        grouped.mount_reagent AS value,
        CASE
          WHEN grouped.mount_reagent ~ '^[A-Z0-9]+$' THEN grouped.mount_reagent
          ELSE initcap(lower(grouped.mount_reagent))
        END AS label,
        grouped.facet_count,
        jsonb_build_object(
          'value', grouped.mount_reagent,
          'label', CASE
            WHEN grouped.mount_reagent ~ '^[A-Z0-9]+$' THEN grouped.mount_reagent
            ELSE initcap(lower(grouped.mount_reagent))
          END,
          'count', grouped.facet_count
        ) AS item
      FROM (
        SELECT
          vo.mount_reagent,
          count(*)::bigint AS facet_count
        FROM visible_observations vo
        WHERE vo.mount_reagent IS NOT NULL
        GROUP BY vo.mount_reagent
      ) grouped
    ) items
  )
  SELECT jsonb_build_object(
    'genera', (SELECT items FROM genera),
    'species', (SELECT items FROM species),
    'countries', (SELECT items FROM countries),
    'regions', (SELECT items FROM regions),
    'sampleTypes', (SELECT items FROM sample_types),
    'contrastMethods', (SELECT items FROM contrast_methods),
    'mountReagents', (SELECT items FROM mount_reagents)
  )
$$;

ALTER FUNCTION public.get_public_observation_facets() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_observation_facets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_observation_facets() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_observation_facets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_observation_facets() TO service_role;

NOTIFY pgrst, 'reload schema';
