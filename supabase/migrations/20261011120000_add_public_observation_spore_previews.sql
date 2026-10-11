-- Batch spore previews for the public explorer's Cards view.
--
-- Plan: docs/plans/active/2026-10-10-batch-spore-preview-rpc.md (Stage 1).
--
-- The Cards view called get_public_observation once per spore-bearing card
-- and used only sporePoints and sporeMosaic. This migration adds
-- public.get_public_observation_spore_previews(bigint[]), which returns just
-- those two values for up to 60 observations in one call. Unlike
-- get_public_observation, its mosaic never carries the legacy raw-storage url
-- and fails closed unless media_authorize_mosaic_delivery (20261011100000)
-- allows it.
--
-- So that the batch function reuses the single-observation gates instead of
-- copying them, the pieces it needs are moved, unchanged, out of
-- public._get_public_observation_stage2a(bigint) and
-- public.get_public_observation(bigint) into private helpers:
--
--   private.public_observation_eligibility(bigint[])
--       the candidate_base predicate (public, not draft, owner not banned,
--       caller not blocked) plus the spore_data_visibility = 'public' gate;
--   private.public_observation_spore_point_rows(bigint[])
--       the point_agg rows: the point tables and joins, the gates (image
--       deleted/purged, image_type and metadata_microscope_parent_is_public,
--       public measurement type), the per-point normalization, and the point
--       order (point_ordinal, see the function);
--   private.public_observation_spore_points_raw(bigint)
--       the point_agg aggregate over those rows, ordered by point_ordinal;
--   private.public_observation_spore_mosaic_raw(bigint, uuid)
--       the latest_mosaic lookup and its legacy JSON object;
--   private.public_observation_authorize_spore_points(jsonb)
--       get_public_observation's cropUrl rewrite via build_worker_media_url;
--   private.public_observation_authorize_spore_mosaic(bigint, jsonb)
--       get_public_observation's mosaicId / mosaicMediaVersion /
--       mosaicMediaUrl (build_worker_mosaic_url) augmentation.
--
-- Expression text inside each helper is the text it replaces; only the
-- correlation c.id / legacy.id became a parameter, and the point aggregate's
-- implicit plan order became the explicit point_ordinal. Both public functions
-- keep their signatures, owner, grants, SECURITY DEFINER, search_path, fields,
-- media behaviour and legacy url. Their output is NOT universally
-- byte-identical: sporePoints is now ordered by image id, then measurement id
-- (owner-approved exception, 2026-10-11). Where the old plan order already
-- was id order the output is byte-identical (proved for the fixtures by
-- supabase/tests/public_observation_spore_previews_identity_test.sh); for
-- observations whose old order depended on the plan or on rows moved by
-- updates, the point order can change. See SUPABASE_DB.md.
--
-- The batch function calls the eligibility helper, spore_point_rows (once
-- for all ids) and the two mosaic helpers. It does not call spore_points_raw
-- or authorize_spore_points: it builds the card-key point objects from
-- spore_point_rows in one pass (see the comment above the batch function).
-- Neither reader touches the point tables directly.
--
-- Observations have no soft-delete or moderation column: a deleted
-- observation is a missing row, and owner moderation is profiles.is_banned.
-- Image soft deletion (deleted_at / purged_at) is gated inside the point
-- aggregate.

BEGIN;

-- --- private helpers ---------------------------------------------------------

CREATE FUNCTION private.public_observation_eligibility(p_observation_ids bigint[])
RETURNS TABLE(observation_id bigint, user_id uuid, spore_data_public boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    o.id,
    o.user_id,
    coalesce(o.spore_data_visibility = 'public'::text, false)
  FROM public.observations o
  WHERE o.id = ANY (p_observation_ids)
    AND o.visibility = 'public'::text
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
$function$;

CREATE FUNCTION private.public_observation_spore_point_rows(p_observation_ids bigint[])
RETURNS TABLE(
  observation_id bigint,
  point_ordinal bigint,
  measurement_id bigint,
  image_id bigint,
  image_media_version bigint,
  length_um double precision,
  width_um double precision,
  thumb_key text,
  contrast_method text,
  mount_reagent text,
  stain_reagent text,
  sample_type text,
  sample_source text,
  mosaic_x integer,
  mosaic_y integer,
  mosaic_w integer,
  mosaic_h integer,
  overlay_json jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    i.observation_id,
    -- The point order of an observation: by image id, then measurement id.
    -- Before 20261011120000 the point aggregate had no ORDER BY. Its index
    -- nested-loop plan returned images, then each image's measurements, in
    -- index-entry order, which is insertion (id) order unless a row was
    -- moved by a non-HOT update or placed into reused space; other plans
    -- returned other orders. The explicit order keeps the usual case and no
    -- longer depends on the plan or on physical row placement.
    row_number() OVER (PARTITION BY i.observation_id ORDER BY i.id, m.id),
    m.id,
    i.id,
    i.media_version,
    m.length_um,
    m.width_um,
    m.thumb_key,
    -- Per-point prep metadata. Same normalization as the scalar
    -- observation-level fields: unset variants collapse to NULL and
    -- jsonb_strip_nulls removes them from the point object.
    nullif(btrim(coalesce(i.contrast, '')), ''),
    nullif(btrim(coalesce(i.mount_medium, '')), ''),
    nullif(btrim(coalesce(i.stain, '')), ''),
    CASE
      WHEN lower(btrim(coalesce(i.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(i.sample_type))
      ELSE NULL::text
    END,
    CASE
      WHEN lower(btrim(coalesce(i.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
        THEN lower(btrim(i.sample_source))
      ELSE NULL::text
    END,
    t.x_px,
    t.y_px,
    t.w_px,
    t.h_px,
    t.overlay_json
  FROM public.spore_measurements m
  JOIN public.observation_images i
    ON i.id = m.image_id
  LEFT JOIN public.spore_measurement_mosaic_tiles t
    ON t.measurement_id = m.id
  WHERE i.observation_id = ANY (p_observation_ids)
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
    AND (i.image_type IS NULL OR (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))))
    AND (
      public.is_public_microscopy_measurement_type(m.measurement_type)
    )
$function$;

CREATE FUNCTION private.public_observation_spore_points_raw(p_observation_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT jsonb_agg(
    jsonb_strip_nulls(
      jsonb_build_object(
        'id',             r.measurement_id::text,
        'observationId',  p_observation_id::text,
        'imageId',        r.image_id::text,
        'lengthUm',       r.length_um,
        'widthUm',        r.width_um,
        'q',              round((r.length_um / nullif(r.width_um, 0))::numeric, 4)::double precision,
        'cropUrl',        CASE
                            WHEN r.thumb_key IS NOT NULL
                              THEN concat('https://media.sporely.no/', r.thumb_key)
                            ELSE NULL
                          END,
        'contrastMethod', r.contrast_method,
        'mountReagent',   r.mount_reagent,
        'stainReagent',   r.stain_reagent,
        'sampleType',     r.sample_type,
        'sampleSource',   r.sample_source,
        'mosaicX',        r.mosaic_x,
        'mosaicY',        r.mosaic_y,
        'mosaicW',        r.mosaic_w,
        'mosaicH',        r.mosaic_h,
        'overlay',        r.overlay_json
      )
    )
    ORDER BY r.point_ordinal
  ) AS spore_points
  FROM private.public_observation_spore_point_rows(ARRAY[p_observation_id]) r
$function$;

CREATE FUNCTION private.public_observation_spore_mosaic_raw(
  p_observation_id bigint,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'url',                concat('https://media.sporely.no/', latest_mosaic.storage_key),
    'width',              latest_mosaic.width_px,
    'height',             latest_mosaic.height_px,
    'tileSize',           latest_mosaic.tile_size_px,
    'version',            latest_mosaic.version,
    'tileWidthPx',        latest_mosaic.tile_width_px,
    'tileHeightPx',       latest_mosaic.tile_height_px,
    'commonCropWidthUm',  latest_mosaic.common_crop_width_um,
    'commonCropHeightUm', latest_mosaic.common_crop_height_um
  ))
  FROM (
    SELECT
      sm.id,
      sm.storage_key,
      sm.width_px,
      sm.height_px,
      sm.tile_size_px,
      sm.version,
      sm.tile_width_px,
      sm.tile_height_px,
      sm.common_crop_width_um,
      sm.common_crop_height_um
    FROM public.spore_measurement_mosaics sm
    WHERE sm.observation_id = p_observation_id
      AND sm.user_id = p_user_id
    ORDER BY sm.version DESC, sm.id DESC
    LIMIT 1
  ) latest_mosaic
$function$;

CREATE FUNCTION private.public_observation_authorize_spore_points(p_spore_points jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    CASE
      WHEN p_spore_points IS NULL OR jsonb_typeof(p_spore_points) <> 'array'
        THEN p_spore_points
      ELSE (
        SELECT coalesce(jsonb_agg(
                 CASE
                   WHEN pt.value ? 'cropUrl' THEN
                     (pt.value - 'cropUrl') || jsonb_strip_nulls(jsonb_build_object(
                       'cropUrl', public.build_worker_media_url(oi.id, 'thumb', oi.media_version)))
                   ELSE pt.value
                 END
                 ORDER BY pt.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements(p_spore_points) WITH ORDINALITY pt(value, ordinality)
        LEFT JOIN public.observation_images oi
          ON oi.id = CASE WHEN (pt.value->>'imageId') ~ '^[0-9]+$' THEN (pt.value->>'imageId')::bigint END
      )
    END
$function$;

CREATE FUNCTION private.public_observation_authorize_spore_mosaic(
  p_observation_id bigint,
  p_spore_mosaic jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    CASE
      WHEN p_spore_mosaic IS NULL OR mosaic.id IS NULL THEN p_spore_mosaic
      ELSE p_spore_mosaic || jsonb_build_object(
        'mosaicId', mosaic.id,
        'mosaicMediaVersion', mosaic.media_version,
        'mosaicMediaUrl', public.build_worker_mosaic_url(mosaic.id, mosaic.media_version)
      )
    END
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT sm.id, sm.media_version
    FROM public.spore_measurement_mosaics sm
    WHERE sm.observation_id = p_observation_id
    ORDER BY sm.version DESC, sm.id DESC
    LIMIT 1
  ) mosaic ON true
$function$;

ALTER FUNCTION private.public_observation_eligibility(bigint[]) OWNER TO postgres;
ALTER FUNCTION private.public_observation_spore_point_rows(bigint[]) OWNER TO postgres;
ALTER FUNCTION private.public_observation_spore_points_raw(bigint) OWNER TO postgres;
ALTER FUNCTION private.public_observation_spore_mosaic_raw(bigint, uuid) OWNER TO postgres;
ALTER FUNCTION private.public_observation_authorize_spore_points(jsonb) OWNER TO postgres;
ALTER FUNCTION private.public_observation_authorize_spore_mosaic(bigint, jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.public_observation_eligibility(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.public_observation_spore_point_rows(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.public_observation_spore_points_raw(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.public_observation_spore_mosaic_raw(bigint, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.public_observation_authorize_spore_points(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.public_observation_authorize_spore_mosaic(bigint, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- --- public._get_public_observation_stage2a(bigint)  [latest def: 20260925120000] ---
--
-- Unchanged except: candidate_base reads private.public_observation_eligibility
-- (and its spore_data_public flag replaces the four inline
-- spore_data_visibility = 'public' comparisons), and the latest_mosaic and
-- point_agg laterals moved into the two *_raw helpers above.

CREATE OR REPLACE FUNCTION public._get_public_observation_stage2a(
  p_observation_id bigint
)
RETURNS TABLE(
  id bigint,
  "speciesSlug" text,
  "speciesName" text,
  "speciesCommonName" text,
  "observerDisplayName" text,
  "observedOn" date,
  country text,
  "regionId" text,
  "locationPrecision" text,
  "locationLabel" text,
  "hasMicroscopy" boolean,
  "sporeMeasurementCount" bigint,
  "sporeSummary" jsonb,
  "sporePoints" jsonb,
  "sporeMosaic" jsonb,
  "contrastMethod" text,
  "mountReagent" text,
  "sampleType" text,
  "sampleSource" text,
  "prepSummary" jsonb,
  "mapLat" double precision,
  "mapLon" double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH candidate_base AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '') AS genus,
      nullif(btrim(coalesce(o.species, '')), '') AS species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.user_id,
      o.author,
      o.date AS observed_on,
      nullif(btrim(coalesce(o.country_code, '')), '') AS country,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      public.community_contributor_label(o.user_id, o.author) AS observer_display_name,
      eligible.spore_data_public
    FROM private.public_observation_eligibility(ARRAY[p_observation_id]) eligible
    JOIN public.observations o
      ON o.id = eligible.observation_id
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
  ),
  enriched AS (
    SELECT
      c.*,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      latest_image.sample_type AS sample_type,
      latest_image.sample_source AS sample_source,
      (latest_image.id IS NOT NULL) AS has_microscopy,
      CASE
        WHEN c.spore_data_public
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN c.spore_data_public
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary,
      CASE
        WHEN c.spore_data_public
          THEN private.public_observation_spore_points_raw(c.id)
        ELSE NULL::jsonb
      END AS spore_points,
      CASE
        WHEN c.spore_data_public
          THEN private.public_observation_spore_mosaic_raw(c.id, c.user_id)
        ELSE NULL::jsonb
      END AS spore_mosaic,
      prep_agg.prep_summary,
      CASE
        WHEN c.location_precision = 'exact'::text
          THEN o.gps_latitude
        WHEN c.location_precision = 'fuzzed'::text
          THEN round(o.gps_latitude::numeric, 2)::double precision
        ELSE NULL::double precision
      END AS map_lat,
      CASE
        WHEN c.location_precision = 'exact'::text
          THEN o.gps_longitude
        WHEN c.location_precision = 'fuzzed'::text
          THEN round(o.gps_longitude::numeric, 2)::double precision
        ELSE NULL::double precision
      END AS map_lon
    FROM candidate_base c
    JOIN public.observations o
      ON o.id = c.id
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (
          (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
          OR (
            i.image_type IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.spore_measurements m2
              WHERE m2.image_id = i.id
                AND (
                  public.is_public_microscopy_measurement_type(m2.measurement_type)
                )
            )
          )
        )
      ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC
      LIMIT 1
    ) latest_image ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS spore_measurement_count
      FROM public.observation_images i
      JOIN public.spore_measurements m
        ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))))
        AND (
          public.is_public_microscopy_measurement_type(m.measurement_type)
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
      WITH contributors AS (
        SELECT DISTINCT
          i.id AS image_id,
          nullif(btrim(coalesce(i.contrast, '')), '') AS contrast,
          nullif(btrim(coalesce(i.mount_medium, '')), '') AS mount_medium,
          nullif(btrim(coalesce(i.stain, '')), '') AS stain,
          nullif(btrim(coalesce(i.sample_type, '')), '') AS sample_type,
          nullif(btrim(coalesce(i.sample_source, '')), '') AS sample_source
        FROM public.observation_images i
        WHERE i.observation_id = c.id
          AND i.deleted_at IS NULL
          AND i.purged_at IS NULL
          AND (i.image_type IS NULL OR (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))))
          AND EXISTS (
            SELECT 1
            FROM public.spore_measurements m3
            WHERE m3.image_id = i.id
              AND (
                public.is_public_microscopy_measurement_type(m3.measurement_type)
              )
          )
      )
      SELECT jsonb_build_object(
        'contrasts',          coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT contrast AS v
            FROM contributors
            WHERE contrast IS NOT NULL
              AND lower(contrast) NOT IN ('not_set', 'not set', 'unset', 'unknown')
          ) s
        ), '[]'::jsonb),
        'mounts',             coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT mount_medium AS v
            FROM contributors
            WHERE mount_medium IS NOT NULL
              AND lower(mount_medium) NOT IN ('not_set', 'not set', 'unset', 'unknown')
          ) s
        ), '[]'::jsonb),
        'stains',             coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT stain AS v
            FROM contributors
            WHERE stain IS NOT NULL
              AND lower(stain) NOT IN ('not_set', 'not set', 'unset', 'unknown')
          ) s
        ), '[]'::jsonb),
        'specimenConditions', coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT lower(sample_type) AS v
            FROM contributors
            WHERE sample_type IS NOT NULL
              AND lower(sample_type) IN ('fresh', 'dried')
          ) s
        ), '[]'::jsonb),
        'sampleSources',      coalesce((
          SELECT jsonb_agg(v ORDER BY v)
          FROM (
            SELECT DISTINCT lower(sample_source) AS v
            FROM contributors
            WHERE sample_source IS NOT NULL
              AND lower(sample_source) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
          ) s
        ), '[]'::jsonb)
      ) AS prep_summary
    ) prep_agg ON true
  )
  SELECT
    e.id AS id,
    nullif(
      regexp_replace(
        regexp_replace(lower(btrim(concat_ws(' ', e.genus, e.species))), '[^a-z0-9]+', '-', 'g'),
        '(^-|-$)',
        '',
        'g'
      ),
      ''
    ) AS "speciesSlug",
    nullif(btrim(concat_ws(' ', e.genus, e.species)), '') AS "speciesName",
    e.common_name AS "speciesCommonName",
    e.observer_display_name AS "observerDisplayName",
    e.observed_on AS "observedOn",
    e.country AS country,
    e.region_id AS "regionId",
    e.location_precision AS "locationPrecision",
    CASE
      WHEN e.location_precision = 'exact'::text THEN e.location
      WHEN e.location_precision = 'fuzzed'::text THEN coalesce(e.region_label, e.country)
      WHEN e.location_precision = 'region'::text THEN e.region_label
      ELSE NULL::text
    END AS "locationLabel",
    e.has_microscopy AS "hasMicroscopy",
    e.spore_measurement_count AS "sporeMeasurementCount",
    e.spore_summary AS "sporeSummary",
    e.spore_points AS "sporePoints",
    e.spore_mosaic AS "sporeMosaic",
    e.contrast_method AS "contrastMethod",
    e.mount_reagent AS "mountReagent",
    CASE
      WHEN lower(btrim(coalesce(e.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(e.sample_type))
      ELSE NULL::text
    END AS "sampleType",
    CASE
      WHEN lower(btrim(coalesce(e.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
        THEN lower(btrim(e.sample_source))
      ELSE NULL::text
    END AS "sampleSource",
    e.prep_summary AS "prepSummary",
    e.map_lat AS "mapLat",
    e.map_lon AS "mapLon"
  FROM enriched e
  LIMIT 1
$function$;


-- --- public.get_public_observation(bigint)  [latest def: 20261001195524] ---
--
-- Unchanged except: the sporePoints and sporeMosaic expressions and the
-- mosaic lateral moved into the two private.*_authorize_* helpers above, and
-- sporePoints is now in point_ordinal order (owner-approved, 2026-10-11).

CREATE OR REPLACE FUNCTION public.get_public_observation(p_observation_id bigint)
 RETURNS TABLE(id bigint, "speciesSlug" text, "speciesName" text, "speciesCommonName" text, "observerDisplayName" text, "observedOn" date, country text, "regionId" text, "locationPrecision" text, "locationLabel" text, "hasMicroscopy" boolean, "sporeMeasurementCount" bigint, "sporeSummary" jsonb, "sporePoints" jsonb, "sporeMosaic" jsonb, "contrastMethod" text, "mountReagent" text, "sampleType" text, "sampleSource" text, "prepSummary" jsonb, "mapLat" double precision, "mapLon" double precision)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    legacy.id,
    legacy."speciesSlug",
    legacy."speciesName",
    legacy."speciesCommonName",
    legacy."observerDisplayName",
    legacy."observedOn",
    legacy.country,
    legacy."regionId",
    legacy."locationPrecision",
    legacy."locationLabel",
    legacy."hasMicroscopy",
    legacy."sporeMeasurementCount",
    legacy."sporeSummary",
    private.public_observation_authorize_spore_points(legacy."sporePoints") AS "sporePoints",
    private.public_observation_authorize_spore_mosaic(legacy.id, legacy."sporeMosaic") AS "sporeMosaic",
    legacy."contrastMethod",
    legacy."mountReagent",
    legacy."sampleType",
    legacy."sampleSource",
    legacy."prepSummary",
    legacy."mapLat",
    legacy."mapLon"
  FROM public._get_public_observation_stage2a(p_observation_id) legacy
$function$;

-- --- public.get_public_observation_spore_previews(bigint[])  [new] ---
--
-- Contract: SUPABASE_DB.md, "Public observation spore previews".
--
-- One row per eligible observation among p_observation_ids, in observation_id
-- order. Ineligible and nonexistent ids are both absent. NULL or empty input
-- returns no rows; duplicates collapse to one row; more than 60 elements
-- (counting duplicates and NULLs) raises 22023.
--
-- points: get_public_observation's sporePoints for that observation, in the
-- same order and with the same values, each point reduced to the keys the
-- landing Cards view reads. NULL when get_public_observation's is NULL.
-- spore_mosaic: get_public_observation's sporeMosaic without its legacy
-- `url` (concat('https://media.sporely.no/', storage_key), which bypasses the
-- Worker and names the owner's storage namespace). It is returned only when
-- public.media_authorize_mosaic_delivery (the Worker's /mm/ authorizer, with
-- its invalid id / bucket / media version / owner mismatch / no key /
-- invalid_storage_namespace checks) allows that mosaic for the caller AND
-- mosaicMediaUrl is non-NULL. Otherwise it is NULL: fail closed, with no raw
-- key or url and no Worker URL. get_public_observation keeps its fields and
-- its legacy url; only its point order became explicit.
--
-- Points come from private.public_observation_spore_point_rows, the same
-- source get_public_observation reads through public_observation_spore_points_raw:
-- one set of point tables, joins and gates, one normalization, and one point
-- order (point_ordinal), for both readers. The batch calls it once for all
-- spore-public eligible observations and builds the card-key objects
-- directly. cropUrl is get_public_observation's
-- build_worker_media_url(image id, 'thumb', image media_version), present
-- when the point has a thumb_key; its arguments depend only on the image, so
-- it is computed once per image. Composing points_raw with
-- authorize_spore_points and dropping keys built each point three times and
-- called build_worker_media_url per point, which made one batch call slower
-- than six parallel single calls (docs/perf/2026-10-batch-spore-preview.md).
--
-- SECURITY DEFINER for the same reason as get_public_observation: anon has no
-- SELECT on observations, observation_images or spore_measurements, and the
-- rows it may see are decided by the gates in the private helpers.

CREATE FUNCTION public.get_public_observation_spore_previews(p_observation_ids bigint[])
RETURNS TABLE(observation_id bigint, points jsonb, spore_mosaic jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF pg_catalog.cardinality(p_observation_ids) > 60 THEN
    RAISE EXCEPTION 'get_public_observation_spore_previews accepts at most 60 observation ids, got %',
      pg_catalog.cardinality(p_observation_ids)
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT e.observation_id, e.user_id, e.spore_data_public
    FROM private.public_observation_eligibility(p_observation_ids) e
  ),
  point_rows AS MATERIALIZED (
    SELECT r.*
    FROM private.public_observation_spore_point_rows(
      ARRAY(SELECT e.observation_id FROM eligible e WHERE e.spore_data_public)
    ) r
  ),
  crop_urls AS MATERIALIZED (
    SELECT
      img.image_id,
      public.build_worker_media_url(img.image_id, 'thumb', img.image_media_version) AS crop_url
    FROM (SELECT DISTINCT r.image_id, r.image_media_version FROM point_rows r) img
  ),
  points AS (
    -- Only the fields read by normalizeSporePoints (id, lengthUm and widthUm
    -- decide whether a point is kept), ObservationCard (crop geometry,
    -- cropUrl) and sporePointFilters (prep context) leave the server.
    SELECT
      r.observation_id,
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'id',             r.measurement_id::text,
            'lengthUm',       r.length_um,
            'widthUm',        r.width_um,
            'cropUrl',        CASE WHEN r.thumb_key IS NOT NULL THEN u.crop_url ELSE NULL END,
            'contrastMethod', r.contrast_method,
            'mountReagent',   r.mount_reagent,
            'sampleType',     r.sample_type,
            'sampleSource',   r.sample_source,
            'mosaicX',        r.mosaic_x,
            'mosaicY',        r.mosaic_y,
            'mosaicW',        r.mosaic_w,
            'mosaicH',        r.mosaic_h
          )
        )
        ORDER BY r.point_ordinal
      ) AS points
    FROM point_rows r
    JOIN crop_urls u
      ON u.image_id = r.image_id
    GROUP BY r.observation_id
  )
  SELECT
    eligible.observation_id,
    points.points,
    CASE
      WHEN delivery.allowed IS TRUE
           AND authorized.spore_mosaic->>'mosaicMediaUrl' IS NOT NULL
        THEN authorized.spore_mosaic - 'url'
      ELSE NULL::jsonb
    END
  FROM eligible
  LEFT JOIN points
    ON points.observation_id = eligible.observation_id
  CROSS JOIN LATERAL (
    SELECT
      private.public_observation_authorize_spore_mosaic(
        eligible.observation_id,
        CASE
          WHEN eligible.spore_data_public
            THEN private.public_observation_spore_mosaic_raw(eligible.observation_id, eligible.user_id)
          ELSE NULL::jsonb
        END
      ) AS spore_mosaic
    -- Optimization fence: without it the planner pulls this subquery up and
    -- re-evaluates the mosaic helpers once per reference to
    -- authorized.spore_mosaic below.
    OFFSET 0
  ) authorized
  LEFT JOIN LATERAL public.media_authorize_mosaic_delivery(
    CASE
      WHEN pg_catalog.jsonb_typeof(authorized.spore_mosaic->'mosaicId') = 'number'
        THEN (authorized.spore_mosaic->>'mosaicId')::bigint
    END,
    auth.uid()
  ) delivery ON authorized.spore_mosaic IS NOT NULL
  ORDER BY eligible.observation_id;
END
$function$;

ALTER FUNCTION public.get_public_observation_spore_previews(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_public_observation_spore_previews(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_observation_spore_previews(bigint[])
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_observation_spore_previews(bigint[]) IS
  'Public explorer Cards view: per eligible observation, the card-read subset of get_public_observation sporePoints, and its sporeMosaic without the legacy url, only when media_authorize_mosaic_delivery allows it (else NULL). At most 60 ids. Contract in SUPABASE_DB.md.';

COMMIT;
