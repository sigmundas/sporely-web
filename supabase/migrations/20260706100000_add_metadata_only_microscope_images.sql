-- Metadata-only microscope image rows.
--
-- Sporely's public spore browser does not need the raw microscope frame;
-- it only needs spore measurements plus the public mosaic WebP. The desktop
-- app keeps microscope frame uploads off by default because a 20 MP frame
-- usually contains only a handful of useful spores. However, public spore
-- measurements need a remote observation_images row as an anchor for
-- spore_measurements.image_id (and for mosaic-tile → measurement → image
-- ownership checks).
--
-- This migration allows observation_images.storage_path to be NULL, but only
-- when image_type = 'microscope'. Metadata-only rows are hidden from public
-- image galleries and species representative thumbnails so that no public
-- surface concatenates NULL into a media.sporely.no URL.

ALTER TABLE public.observation_images
  ALTER COLUMN storage_path DROP NOT NULL;

-- Only microscope rows may omit storage_path. Field/gallery images and any
-- rows without an image_type still require a real storage path so we cannot
-- accidentally publish or link to an empty URL.
ALTER TABLE public.observation_images
  DROP CONSTRAINT IF EXISTS observation_images_storage_path_required_unless_microscope;

-- `IS NOT DISTINCT FROM` (not `=`) so NULL image_type is treated as
-- "not microscope" and thus rejected when storage_path is also NULL. A plain
-- equality comparison against NULL would evaluate to NULL, which CHECK
-- constraints permit, letting untyped metadata-only rows slip in.
ALTER TABLE public.observation_images
  ADD CONSTRAINT observation_images_storage_path_required_unless_microscope
  CHECK (
    storage_path IS NOT NULL
    OR image_type IS NOT DISTINCT FROM 'microscope'
  );

-- The baseline "observation_images: owner full" policy was FOR ALL with only
-- `auth.uid() = user_id` in USING/WITH CHECK — no observation ownership check.
-- Because permissive RLS policies OR together, that broad grant silently
-- weakened the stricter phase7 INSERT policy: a signed-in user could insert
-- an observation_images row against another user's observation as long as
-- they set user_id = self. We drop the broad policy and replace it with
-- action-specific policies that enforce observation ownership on writes.
-- Owner SELECT is already covered by `observation_images: owner select
-- including deleted` and by `observation_images friend read` (owner branch),
-- so dropping the FOR ALL policy does not narrow read access.
DROP POLICY IF EXISTS "observation_images: owner full"
  ON public.observation_images;

-- Owner INSERT: allow either an owner-scoped storage_path or a NULL
-- storage_path for a microscope metadata row. Ownership of both the image
-- row (user_id = auth.uid()) and the linked observation is required.
DROP POLICY IF EXISTS "phase7_observation_images_insert_own"
  ON public.observation_images;

CREATE POLICY "phase7_observation_images_insert_own"
  ON public.observation_images
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND o.user_id = auth.uid()
    )
    AND (
      storage_path LIKE (auth.uid())::text || '/%'
      OR (
        storage_path IS NULL
        AND image_type = 'microscope'
      )
    )
  );

-- Owner UPDATE: USING pins the OLD row to the caller (image row owner AND
-- linked observation owner AND not tombstoned). WITH CHECK pins the NEW row
-- so an update cannot move the row to another user's observation or relax
-- the storage_path rule. The rule mirrors INSERT: real path must be
-- owner-prefixed, or storage_path may be NULL only for microscope rows.
DROP POLICY IF EXISTS "phase7_observation_images_update_own"
  ON public.observation_images;

CREATE POLICY "phase7_observation_images_update_own"
  ON public.observation_images
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND o.user_id = auth.uid()
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND o.user_id = auth.uid()
    )
    AND (
      storage_path LIKE (auth.uid())::text || '/%'
      OR (
        storage_path IS NULL
        AND image_type = 'microscope'
      )
    )
  );

-- Owner DELETE: require both image row ownership and linked observation
-- ownership. Tombstoned rows remain undeletable through this policy (the
-- baseline tombstone migration already restricted DELETE to non-tombstoned
-- rows so the soft-delete audit trail is preserved).
DROP POLICY IF EXISTS "phase7_observation_images_delete_own"
  ON public.observation_images;

CREATE POLICY "phase7_observation_images_delete_own"
  ON public.observation_images
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND deleted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.observations o
      WHERE o.id = observation_images.observation_id
        AND o.user_id = auth.uid()
    )
  );

-- Public observation image gallery: skip metadata-only rows so we never
-- concatenate NULL into a media.sporely.no URL.
CREATE OR REPLACE FUNCTION public.search_public_observation_images(
  p_observation_ids bigint[] DEFAULT NULL::bigint[]
)
RETURNS TABLE(
  "observationId" bigint,
  "imageId" bigint,
  "sortOrder" integer,
  "imageType" text,
  "width" integer,
  "height" integer,
  "thumbUrl" text,
  "previewUrl" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH visible_observations AS (
    SELECT
      o.id,
      o.user_id
    FROM public.observations o
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
      AND o.id = ANY (coalesce(p_observation_ids, '{}'::bigint[]))
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
  visible_images AS (
    SELECT
      o.id AS observation_id,
      i.id AS image_id,
      i.sort_order,
      i.image_type,
      coalesce(i.stored_width, i.source_width) AS width,
      coalesce(i.stored_height, i.source_height) AS height,
      nullif(
        regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
        btrim(i.storage_path, '/')
      ) AS storage_dir,
      regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
      i.created_at
    FROM visible_observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
    WHERE i.deleted_at IS NULL
      AND i.purged_at IS NULL
      AND i.storage_path IS NOT NULL
  ),
  prepared AS (
    SELECT
      vi.observation_id,
      vi.image_id,
      vi.sort_order,
      vi.image_type,
      vi.width,
      vi.height,
      vi.created_at,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        'thumb_',
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS thumb_path
    FROM visible_images vi
  )
  SELECT
    p.observation_id AS "observationId",
    p.image_id AS "imageId",
    p.sort_order AS "sortOrder",
    p.image_type AS "imageType",
    p.width AS "width",
    p.height AS "height",
    concat('https://media.sporely.no/', p.thumb_path) AS "thumbUrl",
    concat('https://media.sporely.no/', p.thumb_path) AS "previewUrl"
  FROM prepared p
  ORDER BY p.observation_id, p.sort_order NULLS LAST, p.created_at DESC NULLS LAST, p.image_id DESC
$$;

ALTER FUNCTION public.search_public_observation_images(bigint[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_public_observation_images(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO anon;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_observation_images(bigint[]) TO service_role;

-- Public species browsing: representative thumbnails must never come from a
-- metadata-only row. Both the list (search_public_species) and the detail
-- (get_public_species) select their representative image from active,
-- non-purged, non-deleted rows with a real storage_path.
CREATE OR REPLACE FUNCTION public.search_public_species(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_genus text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text
)
RETURNS TABLE(
  "speciesSlug" text,
  genus text,
  species text,
  "speciesName" text,
  "commonName" text,
  "observationCount" bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount" bigint,
  "firstObservedOn" date,
  "lastObservedOn" date,
  countries jsonb,
  regions jsonb,
  "representativeThumbUrl" text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH normalized AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 50), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off,
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(coalesce(p_query, '')), '') AS query
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
  visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), ''))), '') AS species_name,
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), '')))),
            '[^a-z0-9]+',
            '-',
            'g'
          ),
          '(^-|-$)',
          '',
          'g'
        ),
        ''
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      (latest_microscope_image.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_microscope_image ON true
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
  species_groups AS (
    SELECT
      vo.species_slug,
      vo.genus,
      vo.species,
      vo.species_name,
      min(vo.common_name) AS common_name,
      count(*)::bigint AS observation_count,
      count(*) FILTER (WHERE vo.has_microscopy)::bigint AS microscopy_observation_count,
      coalesce(sum(vo.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(vo.observed_on) AS first_observed_on,
      max(vo.observed_on) AS last_observed_on
    FROM visible_observations vo
    WHERE vo.species_slug IS NOT NULL
    GROUP BY vo.species_slug, vo.genus, vo.species, vo.species_name
  ),
  filtered_species AS (
    SELECT sg.*
    FROM species_groups sg
    CROSS JOIN normalized n
    WHERE (n.genus IS NULL OR lower(coalesce(sg.genus, '')) = lower(n.genus))
      AND (
        n.query IS NULL
        OR coalesce(sg.species_name, '') ILIKE '%' || n.query || '%'
        OR coalesce(sg.common_name, '') ILIKE '%' || n.query || '%'
        OR coalesce(sg.genus, '') ILIKE '%' || n.query || '%'
        OR coalesce(sg.species, '') ILIKE '%' || n.query || '%'
        OR lower(coalesce(sg.species_slug, '')) ILIKE '%' || lower(n.query) || '%'
      )
  )
  SELECT
    fs.species_slug AS "speciesSlug",
    fs.genus AS genus,
    fs.species AS species,
    fs.species_name AS "speciesName",
    fs.common_name AS "commonName",
    fs.observation_count AS "observationCount",
    fs.microscopy_observation_count AS "microscopyObservationCount",
    fs.spore_measurement_count AS "sporeMeasurementCount",
    fs.first_observed_on AS "firstObservedOn",
    fs.last_observed_on AS "lastObservedOn",
    coalesce(countries.items, '[]'::jsonb) AS countries,
    coalesce(regions.items, '[]'::jsonb) AS regions,
    rep.representative_thumb_url AS "representativeThumbUrl"
  FROM filtered_species fs
  LEFT JOIN LATERAL (
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
        WHERE vo.species_slug = fs.species_slug
          AND vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ) countries ON true
  LEFT JOIN LATERAL (
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
        WHERE vo.species_slug = fs.species_slug
          AND vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ) regions ON true
  LEFT JOIN LATERAL (
    SELECT concat(
      'https://media.sporely.no/',
      concat(
        CASE WHEN rep.storage_dir IS NULL THEN '' ELSE rep.storage_dir || '/' END,
        'thumb_',
        regexp_replace(rep.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      )
    ) AS representative_thumb_url
    FROM (
      SELECT
        nullif(
          regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
          btrim(i.storage_path, '/')
        ) AS storage_dir,
        regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
        vo.observed_on,
        i.sort_order,
        i.created_at,
        i.id
      FROM visible_observations vo
      JOIN public.observation_images i
        ON i.observation_id = vo.id
      WHERE vo.species_slug = fs.species_slug
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.storage_path IS NOT NULL
    ) rep
    ORDER BY rep.observed_on DESC, rep.sort_order NULLS LAST, rep.created_at DESC NULLS LAST, rep.id DESC
    LIMIT 1
  ) rep ON true
  ORDER BY fs.observation_count DESC, fs.last_observed_on DESC, fs.species_name ASC, fs.species_slug ASC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$$;

ALTER FUNCTION public.search_public_species(
  integer,
  integer,
  text,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.search_public_species(
  integer,
  integer,
  text,
  text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_species(
  integer,
  integer,
  text,
  text
) TO anon;
GRANT EXECUTE ON FUNCTION public.search_public_species(
  integer,
  integer,
  text,
  text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_species(
  integer,
  integer,
  text,
  text
) TO service_role;

CREATE OR REPLACE FUNCTION public.get_public_species(
  p_species_slug text
)
RETURNS TABLE(
  "speciesSlug" text,
  genus text,
  species text,
  "speciesName" text,
  "commonName" text,
  "observationCount" bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount" bigint,
  "firstObservedOn" date,
  "lastObservedOn" date,
  countries jsonb,
  regions jsonb,
  "representativeThumbUrl" text,
  "recentObservationIds" bigint[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH normalized AS (
    SELECT nullif(
      regexp_replace(
        lower(btrim(coalesce(p_species_slug, ''))),
        '[^a-z0-9]+',
        '-',
        'g'
      ),
      ''
    ) AS species_slug
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
  visible_observations AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), ''))), '') AS species_name,
      nullif(
        regexp_replace(
          regexp_replace(
            lower(btrim(concat_ws(' ', nullif(btrim(coalesce(o.genus, '')), ''), nullif(btrim(coalesce(o.species, '')), '')))),
            '[^a-z0-9]+',
            '-',
            'g'
          ),
          '(^-|-$)',
          '',
          'g'
        ),
        ''
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      (latest_microscope_image.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.image_type = 'microscope'::text
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest_microscope_image ON true
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
  species_groups AS (
    SELECT
      vo.species_slug,
      vo.genus,
      vo.species,
      vo.species_name,
      min(vo.common_name) AS common_name,
      count(*)::bigint AS observation_count,
      count(*) FILTER (WHERE vo.has_microscopy)::bigint AS microscopy_observation_count,
      coalesce(sum(vo.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(vo.observed_on) AS first_observed_on,
      max(vo.observed_on) AS last_observed_on
    FROM visible_observations vo
    WHERE vo.species_slug IS NOT NULL
    GROUP BY vo.species_slug, vo.genus, vo.species, vo.species_name
  ),
  target_species AS (
    SELECT sg.*
    FROM species_groups sg
    JOIN normalized n
      ON n.species_slug = sg.species_slug
  )
  SELECT
    ts.species_slug AS "speciesSlug",
    ts.genus AS genus,
    ts.species AS species,
    ts.species_name AS "speciesName",
    ts.common_name AS "commonName",
    ts.observation_count AS "observationCount",
    ts.microscopy_observation_count AS "microscopyObservationCount",
    ts.spore_measurement_count AS "sporeMeasurementCount",
    ts.first_observed_on AS "firstObservedOn",
    ts.last_observed_on AS "lastObservedOn",
    coalesce(countries.items, '[]'::jsonb) AS countries,
    coalesce(regions.items, '[]'::jsonb) AS regions,
    rep.representative_thumb_url AS "representativeThumbUrl",
    recent.recent_observation_ids AS "recentObservationIds"
  FROM target_species ts
  LEFT JOIN LATERAL (
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
        WHERE vo.species_slug = ts.species_slug
          AND vo.country_code IS NOT NULL
        GROUP BY vo.country_code
      ) grouped
      LEFT JOIN country_labels cl
        ON cl.country_code = grouped.country_code
    ) items
  ) countries ON true
  LEFT JOIN LATERAL (
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
        WHERE vo.species_slug = ts.species_slug
          AND vo.region_id IS NOT NULL
        GROUP BY
          vo.region_id,
          coalesce(vo.region_label, vo.region_id),
          coalesce(vo.region_country_code, vo.country_code)
      ) grouped
    ) items
  ) regions ON true
  LEFT JOIN LATERAL (
    SELECT concat(
      'https://media.sporely.no/',
      concat(
        CASE WHEN rep.storage_dir IS NULL THEN '' ELSE rep.storage_dir || '/' END,
        'thumb_',
        regexp_replace(rep.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      )
    ) AS representative_thumb_url
    FROM (
      SELECT
        nullif(
          regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''),
          btrim(i.storage_path, '/')
        ) AS storage_dir,
        regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
        vo.observed_on,
        i.sort_order,
        i.created_at,
        i.id
      FROM visible_observations vo
      JOIN public.observation_images i
        ON i.observation_id = vo.id
      WHERE vo.species_slug = ts.species_slug
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND i.storage_path IS NOT NULL
    ) rep
    ORDER BY rep.observed_on DESC, rep.sort_order NULLS LAST, rep.created_at DESC NULLS LAST, rep.id DESC
    LIMIT 1
  ) rep ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(
      array_agg(x.id ORDER BY x.observed_on DESC, x.id DESC),
      '{}'::bigint[]
    ) AS recent_observation_ids
    FROM (
      SELECT vo.id, vo.observed_on
      FROM visible_observations vo
      WHERE vo.species_slug = ts.species_slug
      ORDER BY vo.observed_on DESC, vo.id DESC
      LIMIT 5
    ) x
  ) recent ON true
$$;

ALTER FUNCTION public.get_public_species(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_public_species(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_species(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_species(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_species(text) TO service_role;

NOTIFY pgrst, 'reload schema';
