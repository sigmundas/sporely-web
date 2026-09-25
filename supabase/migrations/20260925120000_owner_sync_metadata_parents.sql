-- Owner-sync metadata-only microscope parents: fix public-RPC leaks.
--
-- Motivation
-- ----------
-- A desktop client creates "owner-sync" metadata-only microscope parents:
-- observation_images rows with storage_path NULL and image_type
-- 'microscope' that exist only so owner-private child measurements (e.g.
-- future cheilocystidia) sync between the owner's devices. Raw tables are
-- owner-only under RLS (20260803120000_lock_down_observation_sync_tables.sql),
-- but every public/anon SECURITY DEFINER RPC that surfaces microscopy
-- presence, counts, or prep facets selected eligible images with the bare
-- predicate `image_type = 'microscope'`, with no storage_path check. Such a
-- row would leak its existence (hasMicroscopy / microscopyObservationCount)
-- and its mount_medium/stain/sample_type/sample_source/contrast metadata,
-- and could inflate public prep-filter facets, even though it has no bytes
-- and its child measurements are not spore data at all.
--
-- Fix
-- ---
-- 1. New nullable column observation_images.metadata_purpose, CHECK'd to
--    'owner_sync' | 'public_microscopy' | NULL. NULL/'owner_sync' never
--    authorize public exposure of a storage_path-NULL row. 'public_microscopy'
--    is necessary but NOT sufficient: the marker alone must never authorize
--    exposure, so every read site re-verifies public child data server-side
--    via metadata_microscope_parent_is_public(). storage_path-NOT-NULL rows
--    are completely unaffected by the marker; their existing visibility
--    rules are unchanged.
-- 2. public.is_public_microscopy_measurement_type(text): the single
--    server-side definition of which spore_measurements.measurement_type
--    values are publishable as public microscopy content. Currently true
--    for NULL, '' and lower() IN ('manual','spore','spores') — the set every
--    RPC already treated as public today. Cystidia and other structures are
--    added later by changing only this function.
-- 3. public.metadata_microscope_parent_is_public(bigint): SECURITY DEFINER
--    helper. Returns true only when the image row is marked
--    'public_microscopy' AND its observation is publicly readable using the
--    exact same predicate the existing latest_image / hasMicroscopy code
--    paths already require (visibility = 'public', not draft, owner not
--    banned, not blocked, AND spore_data_visibility = 'public' — the same
--    gate every one of these RPCs already applies before it will surface
--    any spore-derived content for a storage_path-NULL row) AND a qualifying
--    spore_measurements row exists (length_um and width_um both present,
--    is_public_microscopy_measurement_type() true) AND the image itself is
--    not deleted/purged.
-- 4. Every leaking site is patched to require
--      (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
--    in place of the bare `i.image_type = 'microscope'` eligibility test,
--    alias-adjusted per site. All other conditions at each site are
--    unchanged. Byte-backed rows (storage_path IS NOT NULL) take the first
--    disjunct and are completely unaffected — their behavior is provably
--    identical to before this migration.
-- 5. Several of the functions below carry a name most SQL clients never see:
--    `get_public_observation`, `search_public_species`, and `get_public_species`
--    were each renamed (in 20260809120000_stage2b_authorized_media_projections.sql)
--    to internal `_..._stage2a` implementations behind thin identity-enriching
--    wrappers of the original public name (`_get_public_observation_stage2a`,
--    `_search_public_species_stage2a`, `_get_public_species_stage2a`); the
--    image_type predicate lives only in those internal functions, which is
--    what this migration redefines. Their bodies are reproduced here from
--    their last literal CREATE OR REPLACE, with the microscope-capture
--    chronology ORDER BY patch that
--    20260810130000_use_microscope_capture_chronology.sql applied dynamically
--    via pg_get_functiondef/EXECUTE (rather than a literal CREATE OR REPLACE)
--    re-applied verbatim so this migration's CREATE OR REPLACE does not
--    regress that ordering fix.
-- 6. Backfill (same migration, per policy: the new column's presence is the
--    desktop client's server-readiness signal, so schema + all RPC fixes
--    must ship together): existing storage_path-NULL, image_type
--    'microscope', non-deleted/purged rows are marked 'public_microscopy'
--    whenever they already have qualifying spore data on them (a
--    spore_measurements row with length_um and width_um both present,
--    is_public_microscopy_measurement_type() true). The backfill
--    deliberately does NOT also require observation.visibility = 'public' /
--    not-draft / not-banned / not-blocked / spore_data_visibility =
--    'public': those are per-request conditions re-evaluated by
--    metadata_microscope_parent_is_public() (and, for
--    get_observation_microscopy_presentations, by
--    metadata_microscope_parent_is_visible_to_reader()) at read time
--    regardless of the marker, so under-restricting the backfill labeling by
--    the observation's current/possibly-draft visibility is not a security
--    exposure — it only risks a label that read-time re-verification will
--    still correctly deny for a non-public/non-owner reader. Marking the row
--    only requires that the row's own qualifying child measurement already
--    exists, so a genuinely qualifying parent belonging to a currently
--    non-public or draft observation is not left NULL forever. All other
--    legacy rows (including any cheilocystidia-only anchors) are left with
--    metadata_purpose = NULL.
-- 7. public.metadata_microscope_parent_is_visible_to_reader(bigint): a
--    second, reader-scoped SECURITY DEFINER helper used only by
--    get_observation_microscopy_presentations, which (unlike every other
--    RPC here) also serves the image owner and other authorized-but-not-
--    owner readers on non-public observations. A metadata-only parent is
--    visible to the current reader when they own the image, or — for a
--    non-owner already authorized by that RPC's own upstream
--    can_read_observation/can_access_spore_data checks — when
--    metadata_purpose = 'public_microscopy' AND a qualifying child
--    measurement exists. An owner_sync row is never visible under the
--    non-owner branch, so friends/other authorized-but-non-owner readers
--    never see it. metadata_microscope_parent_is_public itself is
--    unchanged and stays strictly public-only for every other RPC.
-- 8. No RLS change: public.observation_images INSERT/UPDATE policies
--    (phase7_observation_images_insert_own /
--    phase7_observation_images_update_own, most recently redefined in
--    20260706100000 / 20260717120000) already gate every column, including
--    this new one, on `user_id = auth.uid()` plus observation ownership.
--    RLS is row-level, not column-level, and the base GRANT to
--    `authenticated` has no column list, so a non-owner has no path to set
--    or update metadata_purpose on someone else's row.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New column + CHECK constraint.
-- ---------------------------------------------------------------------------

ALTER TABLE public.observation_images
  ADD COLUMN metadata_purpose text;

ALTER TABLE public.observation_images
  ADD CONSTRAINT observation_images_metadata_purpose_check
  CHECK (metadata_purpose IS NULL OR metadata_purpose IN ('owner_sync', 'public_microscopy'));

COMMENT ON COLUMN public.observation_images.metadata_purpose IS
  'Purpose of a storage_path-NULL metadata-only microscope parent row. '
  'owner_sync: private, exists only to sync owner-private child measurements '
  'between the owner''s devices; never public. public_microscopy: eligible '
  'for public microscopy exposure ONLY if the server independently verifies '
  'public child spore data via metadata_microscope_parent_is_public() — the '
  'marker alone never authorizes exposure. NULL: fail closed, treated as '
  'not public. Irrelevant for rows with storage_path NOT NULL, whose '
  'ordinary image-visibility rules are unaffected.';

-- ---------------------------------------------------------------------------
-- 2. Single server-side definition of publishable microscopy measurement
--    types. Currently the set every public RPC already treats as public
--    spore data. Cystidia and other structures are added later by changing
--    only this function.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_public_microscopy_measurement_type(p_measurement_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT p_measurement_type IS NULL
    OR btrim(p_measurement_type) = ''
    OR lower(btrim(p_measurement_type)) IN ('manual', 'spore', 'spores')
$$;

ALTER FUNCTION public.is_public_microscopy_measurement_type(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_public_microscopy_measurement_type(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_public_microscopy_measurement_type(text)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Server-side verification helper. The marker alone is never sufficient:
--    this independently re-derives public eligibility on every call.
--
--    "Publicly readable, spore data included" reuses exactly the predicate
--    candidate_base / visible_observations already apply in
--    _get_public_observation_stage2a / search_public_observations /
--    _search_public_species_stage2a / _get_public_species_stage2a before
--    they will surface ANY spore-derived content for a storage_path-NULL
--    microscope row: visibility = 'public', not draft, owner not banned,
--    not blocked, AND spore_data_visibility = 'public' (the same gate that
--    already wraps sporeMeasurementCount / sporeSummary / sporePoints /
--    sporeMosaic / spore-derived prep facets at every one of those sites).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.metadata_microscope_parent_is_public(p_image_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.observation_images i
    JOIN public.observations o
      ON o.id = i.observation_id
    WHERE i.id = p_image_id
      AND i.deleted_at IS NULL
      AND i.purged_at IS NULL
      AND i.metadata_purpose = 'public_microscopy'
      AND o.visibility = 'public'
      AND NOT coalesce(o.is_draft, false)
      AND o.spore_data_visibility = 'public'
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
      AND EXISTS (
        SELECT 1
        FROM public.spore_measurements m
        WHERE m.image_id = i.id
          AND m.length_um IS NOT NULL
          AND m.width_um IS NOT NULL
          AND public.is_public_microscopy_measurement_type(m.measurement_type)
      )
  )
$$;

ALTER FUNCTION public.metadata_microscope_parent_is_public(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.metadata_microscope_parent_is_public(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.metadata_microscope_parent_is_public(bigint)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.metadata_microscope_parent_is_public(bigint) IS
  'Independently verifies that a storage_path-NULL microscope parent row is '
  'eligible for public microscopy exposure: metadata_purpose = '
  '''public_microscopy'' is necessary but never sufficient on its own. Also '
  'requires the owning observation to be publicly readable with public spore '
  'data (visibility=public, not draft, owner not banned, not blocked, '
  'spore_data_visibility=public) and a qualifying spore_measurements row '
  '(length_um and width_um present, is_public_microscopy_measurement_type() '
  'true) on the image, which itself must not be deleted or purged.';

-- ---------------------------------------------------------------------------
-- 3b. Reader-scoped variant for get_observation_microscopy_presentations,
--    which (unlike every other RPC this migration patches) also serves the
--    image owner and other authorized-but-not-owner readers (friends) on
--    non-public observations, via its own can_read_observation /
--    can_access_spore_data checks upstream of this helper. This helper must
--    NOT be substituted for metadata_microscope_parent_is_public above,
--    which stays strictly public-only for every other RPC.
--
--    A storage_path-NULL metadata parent is visible to the calling reader
--    when EITHER:
--      (a) the caller is the image's owner (auth.uid() = i.user_id) — an
--          owner_sync row must remain visible to its own owner, on their
--          own private observation, regardless of metadata_purpose; OR
--      (b) metadata_purpose = 'public_microscopy' AND a qualifying
--          spore_measurements row exists — for a non-owner reader who was
--          already authorized to read this observation's spore data by the
--          caller's own upstream checks. The marker alone is still never
--          sufficient: a non-owner reader additionally requires the
--          verified qualifying child measurement, exactly as
--          metadata_microscope_parent_is_public requires for the public
--          case.
--
--    This helper deliberately does NOT re-derive observation-level
--    visibility/spore-data-visibility itself: the caller (this RPC) has
--    already restricted its query to observations the current reader may
--    access, via spore_accessible_obs. An owner_sync row (metadata_purpose
--    IS NULL or 'owner_sync') is NEVER visible under branch (b), so a
--    friend/authorized-but-non-owner reader never sees it, only the owner
--    does (branch a).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.metadata_microscope_parent_is_visible_to_reader(p_image_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.observation_images i
    WHERE i.id = p_image_id
      AND i.deleted_at IS NULL
      AND i.purged_at IS NULL
      AND (
        (auth.uid() IS NOT NULL AND auth.uid() = i.user_id)
        OR (
          i.metadata_purpose = 'public_microscopy'
          AND EXISTS (
            SELECT 1
            FROM public.spore_measurements m
            WHERE m.image_id = i.id
              AND m.length_um IS NOT NULL
              AND m.width_um IS NOT NULL
              AND public.is_public_microscopy_measurement_type(m.measurement_type)
          )
        )
      )
  )
$$;

ALTER FUNCTION public.metadata_microscope_parent_is_visible_to_reader(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.metadata_microscope_parent_is_visible_to_reader(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.metadata_microscope_parent_is_visible_to_reader(bigint)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.metadata_microscope_parent_is_visible_to_reader(bigint) IS
  'Reader-scoped variant of metadata_microscope_parent_is_public, used only '
  'by get_observation_microscopy_presentations. A storage_path-NULL '
  'microscope parent is visible to the CURRENT caller when they own the '
  'image, or (for a non-owner already authorized by the caller''s own '
  'upstream checks) when metadata_purpose = ''public_microscopy'' AND a '
  'qualifying spore_measurements row exists. Owner_sync rows are never '
  'visible under the non-owner branch. Unlike '
  'metadata_microscope_parent_is_public, this does not itself re-derive '
  'observation-level public visibility, since the caller already restricts '
  'to observations the reader may access.';

-- ---------------------------------------------------------------------------
-- 4. Backfill. See migration header for the exact backfill predicate and
--    the reasoning for not also requiring observation-level public
--    visibility at backfill time.
-- ---------------------------------------------------------------------------

UPDATE public.observation_images i
SET metadata_purpose = 'public_microscopy'
WHERE i.storage_path IS NULL
  AND i.image_type = 'microscope'
  AND i.deleted_at IS NULL
  AND i.purged_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.spore_measurements m
    WHERE m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND m.width_um IS NOT NULL
      AND public.is_public_microscopy_measurement_type(m.measurement_type)
  );

-- ---------------------------------------------------------------------------
-- 5. Patched RPCs. Each CREATE OR REPLACE below reproduces the function's
--    current live body (its last literal definition, with the dynamic
--    ORDER BY chronology patch from 20260810130000 re-applied where that
--    patch touched it) with ONLY the leaking bare `image_type = 'microscope'`
--    eligibility test replaced per-alias by
--    `(alias.image_type = 'microscope' AND (alias.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(alias.id)))`
--    — i.e. the new parent-eligibility clause is ANDed in alongside the
--    original type check, never substituted for it. Wherever the original
--    predicate at a site was already a disjunction/negation (e.g.
--    `alias.image_type IS NULL OR ...`), that shape is preserved and only
--    the `image_type = 'microscope'` branch gets the clause ANDed in. No
--    other condition at any site is changed. The single exception is
--    get_observation_microscopy_presentations near the end of this
--    migration, which uses the separate reader-scoped
--    metadata_microscope_parent_is_visible_to_reader() helper in place of
--    metadata_microscope_parent_is_public() (see comment 7 above) because it
--    also serves the image owner and other authorized non-owner readers on
--    non-public observations.
-- ---------------------------------------------------------------------------

-- --- public._get_public_observation_stage2a(bigint)  [was public.get_public_observation(bigint); renamed by 20260809120000] ---

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
      public.community_contributor_label(o.user_id, o.author) AS observer_display_name
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    WHERE o.id = p_observation_id
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
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN point_agg.spore_points
        ELSE NULL::jsonb
      END AS spore_points,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
             AND latest_mosaic.id IS NOT NULL
          THEN jsonb_strip_nulls(jsonb_build_object(
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
                  m2.measurement_type IS NULL
                  OR m2.measurement_type = ''
                  OR lower(m2.measurement_type) IN ('manual', 'spore', 'spores')
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
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_stats ON true
    LEFT JOIN LATERAL (
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
      WHERE sm.observation_id = c.id
        AND sm.user_id = c.user_id
      ORDER BY sm.version DESC, sm.id DESC
      LIMIT 1
    ) latest_mosaic ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'id',             m.id::text,
            'observationId',  c.id::text,
            'imageId',        i.id::text,
            'lengthUm',       m.length_um,
            'widthUm',        m.width_um,
            'q',              round((m.length_um / nullif(m.width_um, 0))::numeric, 4)::double precision,
            'cropUrl',        CASE
                                WHEN m.thumb_key IS NOT NULL
                                  THEN concat('https://media.sporely.no/', m.thumb_key)
                                ELSE NULL
                              END,
            -- Per-point prep metadata. Same normalization as the scalar
            -- observation-level fields (see the SELECT list below): unset
            -- variants collapse to NULL and jsonb_strip_nulls removes them
            -- from the object before it lands in the aggregate.
            'contrastMethod', nullif(btrim(coalesce(i.contrast, '')), ''),
            'mountReagent',   nullif(btrim(coalesce(i.mount_medium, '')), ''),
            'stainReagent',   nullif(btrim(coalesce(i.stain, '')), ''),
            'sampleType',     CASE
                                WHEN lower(btrim(coalesce(i.sample_type, ''))) IN ('fresh', 'dried')
                                  THEN lower(btrim(i.sample_type))
                                ELSE NULL::text
                              END,
            'sampleSource',   CASE
                                WHEN lower(btrim(coalesce(i.sample_source, ''))) IN ('spore_print', 'hymenium', 'stipe', 'pileus', 'context', 'other')
                                  THEN lower(btrim(i.sample_source))
                                ELSE NULL::text
                              END,
            'mosaicX',        t.x_px,
            'mosaicY',        t.y_px,
            'mosaicW',        t.w_px,
            'mosaicH',        t.h_px,
            'overlay',        t.overlay_json
          )
        )
      ) AS spore_points
      FROM public.spore_measurements m
      JOIN public.observation_images i
        ON i.id = m.image_id
      LEFT JOIN public.spore_measurement_mosaic_tiles t
        ON t.measurement_id = m.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type IS NULL OR (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))))
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) point_agg ON true
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
                m3.measurement_type IS NULL
                OR m3.measurement_type = ''
                OR lower(m3.measurement_type) IN ('manual', 'spore', 'spores')
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


-- --- public.search_public_observations(...)  [latest literal def: 20260804130000] ---

-- Scope public microscopy-context filters to valid public spore measurements.
-- A source microscope image is a metadata anchor for a measured spore and does
-- not need downloadable bytes.  All active context dimensions must match the
-- same measurement-bearing source image.
--
-- This predicate is deliberately spore-specific.  A future schema for
-- cystidia, basidia, and other measured structures must add an independent
-- measurement_subject/structure_type dimension; measurement_type is not an
-- anatomical-structure classifier.

CREATE OR REPLACE FUNCTION "public"."search_public_observations"("p_limit" integer DEFAULT 50, "p_offset" integer DEFAULT 0, "p_genus" "text" DEFAULT NULL::"text", "p_species" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_has_spores" boolean DEFAULT NULL::boolean, "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_contrast" "text" DEFAULT NULL::"text", "p_mount" "text" DEFAULT NULL::"text", "p_sample" "text" DEFAULT NULL::"text", "p_observer" "text" DEFAULT NULL::"text", "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("id" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observerDisplayName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationPrecision" "text", "locationLabel" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "contrastMethod" "text", "mountReagent" "text", "sampleType" "text", "sampleSource" "text", "stainReagent" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH normalized AS (
    SELECT
      greatest(1, least(coalesce(p_limit, 50), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off,
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(coalesce(p_species, '')), '') AS species,
      nullif(btrim(coalesce(p_country, '')), '') AS country,
      nullif(btrim(coalesce(p_region, '')), '') AS region,
      p_date_from AS date_from,
      p_date_to AS date_to,
      p_has_spores AS has_spores,
      p_has_microscopy AS has_microscopy,
      nullif(btrim(coalesce(p_contrast, '')), '') AS contrast,
      nullif(btrim(coalesce(p_mount, '')), '') AS mount,
      nullif(btrim(coalesce(p_sample, '')), '') AS sample,
      nullif(btrim(lower(coalesce(p_sample_source, ''))), '') AS sample_source,
      nullif(btrim(coalesce(p_observer, '')), '') AS observer
  ),
  candidate_base AS (
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
      public.community_contributor_label(o.user_id, o.author) AS observer_display_name
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
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
  candidate AS (
    SELECT cb.*
    FROM candidate_base cb
    CROSS JOIN normalized n
    WHERE (n.genus IS NULL OR lower(coalesce(cb.genus, '')) = lower(n.genus))
      AND (n.species IS NULL OR lower(coalesce(cb.species, '')) = lower(n.species))
      AND (n.country IS NULL OR lower(coalesce(cb.country, '')) = lower(n.country))
      AND (n.region IS NULL OR cb.region_id = n.region)
      AND (n.date_from IS NULL OR cb.observed_on >= n.date_from)
      AND (n.date_to IS NULL OR cb.observed_on <= n.date_to)
      AND (
        n.observer IS NULL
        OR coalesce(cb.observer_display_name, '') ILIKE '%' || n.observer || '%'
      )
  ),
  enriched AS (
    SELECT
      c.*,
      latest_image.contrast AS contrast_method,
      latest_image.mount_medium AS mount_reagent,
      latest_image.sample_type AS sample_type,
      latest_image.sample_source AS sample_source,
      latest_image.stain AS stain_reagent,
      (latest_image.id IS NOT NULL) AS has_microscopy,
      o.spore_data_visibility,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN coalesce(spore_stats.spore_measurement_count, 0::bigint)
        ELSE 0::bigint
      END AS spore_measurement_count,
      CASE
        WHEN o.spore_data_visibility = 'public'::text
          THEN o.spore_statistics
        ELSE NULL::jsonb
      END AS spore_summary
    FROM candidate c
    JOIN public.observations o
      ON o.id = c.id
    CROSS JOIN normalized n
    LEFT JOIN LATERAL (
      SELECT
        i.id,
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source,
        i.stain
      FROM public.observation_images i
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND (n.contrast IS NULL OR lower(btrim(coalesce(i.contrast, '')))     = lower(btrim(n.contrast)))
        AND (n.mount    IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = lower(btrim(n.mount)))
        AND (n.sample   IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = lower(btrim(n.sample)))
        AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
        AND (
          (
            n.contrast IS NULL
            AND n.mount IS NULL
            AND n.sample IS NULL
            AND n.sample_source IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM public.spore_measurements m
            WHERE m.image_id = i.id
              AND m.length_um IS NOT NULL
              AND m.width_um IS NOT NULL
              AND (
                m.measurement_type IS NULL
                OR btrim(m.measurement_type) = ''
                OR lower(btrim(m.measurement_type)) IN ('manual', 'spore', 'spores')
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
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND (
          m.measurement_type IS NULL
          OR btrim(m.measurement_type) = ''
          OR lower(btrim(m.measurement_type)) IN ('manual', 'spore', 'spores')
        )
        AND m.length_um IS NOT NULL
        AND m.width_um IS NOT NULL
    ) spore_stats ON true
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
    e.contrast_method AS "contrastMethod",
    e.mount_reagent AS "mountReagent",
    CASE
      WHEN lower(btrim(coalesce(e.sample_type, ''))) IN ('fresh', 'dried')
        THEN lower(btrim(e.sample_type))
      ELSE NULL::text
    END AS "sampleType",
    public.public_normalized_sample_source(e.sample_source, e.sample_type) AS "sampleSource",
    nullif(btrim(coalesce(e.stain_reagent, '')), '') AS "stainReagent"
  FROM enriched e
  CROSS JOIN normalized n
  WHERE (n.has_microscopy IS NULL OR e.has_microscopy = n.has_microscopy)
    AND (
      n.has_spores IS NULL
      OR (e.spore_measurement_count > 0) = n.has_spores
    )
    AND (
      (
        n.contrast IS NULL
        AND n.mount IS NULL
        AND n.sample IS NULL
        AND n.sample_source IS NULL
      )
      OR (
        e.spore_data_visibility = 'public'::text
        AND EXISTS (
          SELECT 1
          FROM public.spore_measurements m
          JOIN public.observation_images i
            ON i.id = m.image_id
          WHERE i.observation_id = e.id
            AND i.deleted_at IS NULL
            AND i.purged_at IS NULL
            AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
            AND (n.contrast IS NULL OR lower(btrim(coalesce(i.contrast, ''))) = lower(btrim(n.contrast)))
            AND (n.mount IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = lower(btrim(n.mount)))
            AND (n.sample IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = lower(btrim(n.sample)))
            AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
            AND (
              m.measurement_type IS NULL
              OR btrim(m.measurement_type) = ''
              OR lower(btrim(m.measurement_type)) IN ('manual', 'spore', 'spores')
            )
            AND m.length_um IS NOT NULL
            AND m.width_um IS NOT NULL
        )
      )
    )
  ORDER BY e.observed_on DESC, e.id DESC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized)
$_$;


-- --- public._search_public_species_stage2a(...)  [was public.search_public_species(...); renamed by 20260809120000] ---

CREATE OR REPLACE FUNCTION public._search_public_species_stage2a(
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
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
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
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC
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


-- --- public._get_public_species_stage2a(text)  [was public.get_public_species(text); renamed by 20260809120000] ---

CREATE OR REPLACE FUNCTION public._get_public_species_stage2a(
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
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
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
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC
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


-- --- public.get_public_species_spore_summary(...)  [latest literal def: 20260628140000] ---

CREATE OR REPLACE FUNCTION public.get_public_species_spore_summary(
  p_species_slug text,
  p_country      text    DEFAULT NULL::text,
  p_region_id    text    DEFAULT NULL::text,
  p_date_from    date    DEFAULT NULL::date,
  p_date_to      date    DEFAULT NULL::date
)
RETURNS TABLE(
  "speciesSlug"             text,
  "speciesName"             text,
  "speciesCommonName"       text,
  "observationCount"        bigint,
  "microscopyObservationCount" bigint,
  "sporeObservationCount"   bigint,
  "sporeMeasurementCount"   bigint,
  "firstObservedOn"         date,
  "lastObservedOn"          date,
  countries                 jsonb,
  regions                   jsonb,
  "sporeSummary"            jsonb,
  "observations"            jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH norm AS (
    SELECT
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
      nullif(btrim(upper(coalesce(p_country, ''))),   '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),        '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to
  ),
  country_labels AS (
    SELECT *
    FROM (VALUES
      ('DE'::text, 'Germany'::text),
      ('FI'::text, 'Finland'::text),
      ('GB'::text, 'United Kingdom'::text),
      ('NO'::text, 'Norway'::text),
      ('SE'::text, 'Sweden'::text)
    ) AS c(code, label)
  ),
  -- All public, non-draft, non-banned observations matching the target species
  -- and the optional geographic / date filters.
  species_obs AS (
    SELECT
      o.id,
      nullif(btrim(concat_ws(' ',
        nullif(btrim(coalesce(o.genus,   '')), ''),
        nullif(btrim(coalesce(o.species, '')), '')
      )), '') AS species_name,
      nullif(
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
      ) AS species_slug,
      nullif(btrim(coalesce(o.common_name, '')), '') AS common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      nullif(btrim(coalesce(r.label, '')), '') AS region_label,
      upper(nullif(btrim(coalesce(r.country_code, '')), '')) AS region_country_code,
      coalesce(o.location_precision, 'hidden') AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '') AS location_text,
      o.spore_data_visibility,
      o.spore_statistics,
      (micro.id IS NOT NULL) AS has_microscopy
    FROM public.observations o
    CROSS JOIN norm n
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT i.id
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      LIMIT 1
    ) micro ON true
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
      -- Species slug match (same normalisation as search_public_species).
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
      -- Optional filters.
      AND (n.country   IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from IS NULL OR o.date >= n.date_from)
      AND (n.date_to   IS NULL OR o.date <= n.date_to)
  ),
  -- Subset: observations with public spore data and ≥1 qualifying measurement.
  spore_eligible AS (
    SELECT
      so.id,
      so.observed_on,
      so.country_code,
      so.region_id,
      so.region_label,
      so.location_precision,
      so.location_text,
      so.spore_statistics,
      spore_counts.spore_n
    FROM species_obs so
    JOIN LATERAL (
      SELECT count(m.id)::bigint AS spore_n
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = so.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE so.spore_data_visibility = 'public'
  ),
  -- Flat raw measurements for aggregate statistics.
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
    JOIN public.spore_measurements m ON m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  ),
  -- Aggregate length stats over all qualifying measurements.
  agg_len AS (
    SELECT
      count(*)::bigint                                                            AS n,
      min(length_um)                                                              AS len_min,
      max(length_um)                                                              AS len_max,
      avg(length_um)                                                              AS len_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p95
    FROM raw_meas
  ),
  -- Aggregate width and Q stats over measurements that have a valid width.
  agg_wq AS (
    SELECT
      min(width_um)                                                               AS wid_min,
      max(width_um)                                                               AS wid_max,
      avg(width_um)                                                               AS wid_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p95,
      min(length_um / nullif(width_um, 0))                                        AS q_min,
      max(length_um / nullif(width_um, 0))                                        AS q_max,
      avg(length_um / nullif(width_um, 0))                                        AS q_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p95
    FROM raw_meas
    WHERE width_um IS NOT NULL AND width_um > 0
  ),
  -- Per-observation means computed fresh from raw measurements (not from stored spore_statistics).
  obs_means AS (
    SELECT
      se.id            AS observation_id,
      se.observed_on,
      se.country_code,
      se.region_id,
      CASE
        WHEN se.location_precision = 'exact'  THEN se.location_text
        WHEN se.location_precision = 'fuzzed' THEN coalesce(se.region_label, se.country_code)
        WHEN se.location_precision = 'region' THEN se.region_label
        ELSE NULL
      END              AS location_label,
      se.spore_n,
      se.spore_statistics,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean
    FROM spore_eligible se
    JOIN LATERAL (
      SELECT
        avg(m.length_um) AS length_mean,
        avg(m.width_um)  FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS width_mean,
        avg(m.length_um / nullif(m.width_um, 0))
                         FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS q_mean
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
    ) obs_stats ON true
  )
  SELECT
    -- Species identity (from first matching observation).
    (SELECT species_slug  FROM species_obs LIMIT 1)  AS "speciesSlug",
    (SELECT species_name  FROM species_obs LIMIT 1)  AS "speciesName",
    (SELECT common_name   FROM species_obs LIMIT 1)  AS "speciesCommonName",
    -- Coverage.
    (SELECT count(*)::bigint  FROM species_obs)                          AS "observationCount",
    (SELECT count(*)::bigint  FROM species_obs WHERE has_microscopy)     AS "microscopyObservationCount",
    (SELECT count(*)::bigint  FROM spore_eligible)                       AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint       AS "sporeMeasurementCount",
    (SELECT min(observed_on) FROM species_obs)                           AS "firstObservedOn",
    (SELECT max(observed_on) FROM species_obs)                           AS "lastObservedOn",
    -- Countries facet.
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value', g.cc,
          'label', coalesce(cl.label, g.cc),
          'count', g.cnt
        )
        ORDER BY g.cnt DESC, g.cc ASC
      )
      FROM (
        SELECT country_code AS cc, count(*)::bigint AS cnt
        FROM species_obs
        WHERE country_code IS NOT NULL
        GROUP BY country_code
      ) g
      LEFT JOIN country_labels cl ON cl.code = g.cc
    ), '[]'::jsonb) AS countries,
    -- Regions facet.
    coalesce((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value',       g.rid,
          'label',       g.rlabel,
          'countryCode', g.rcc,
          'count',       g.cnt
        )
        ORDER BY g.cnt DESC, g.rid ASC
      )
      FROM (
        SELECT
          region_id AS rid,
          coalesce(region_label, region_id) AS rlabel,
          coalesce(region_country_code, country_code) AS rcc,
          count(*)::bigint AS cnt
        FROM species_obs
        WHERE region_id IS NOT NULL
        GROUP BY
          region_id,
          coalesce(region_label, region_id),
          coalesce(region_country_code, country_code)
      ) g
    ), '[]'::jsonb) AS regions,
    -- Aggregate spore summary (NULL when no public measurements).
    -- length_core_min/max are aliases for p05/p95 so the landing SporeSummary
    -- type picks them up via its firstFiniteNumber preference chain.
    CASE WHEN (SELECT n FROM agg_len) > 0 THEN
      jsonb_strip_nulls(jsonb_build_object(
        'n',                  (SELECT n        FROM agg_len),
        'length_min_um',      (SELECT len_min  FROM agg_len),
        'length_max_um',      (SELECT len_max  FROM agg_len),
        'length_p05_um',      (SELECT len_p05  FROM agg_len),
        'length_p95_um',      (SELECT len_p95  FROM agg_len),
        'length_core_min_um', (SELECT len_p05  FROM agg_len),
        'length_core_max_um', (SELECT len_p95  FROM agg_len),
        'length_mean_um',     (SELECT len_mean FROM agg_len),
        'width_min_um',       (SELECT wid_min  FROM agg_wq),
        'width_max_um',       (SELECT wid_max  FROM agg_wq),
        'width_p05_um',       (SELECT wid_p05  FROM agg_wq),
        'width_p95_um',       (SELECT wid_p95  FROM agg_wq),
        'width_core_min_um',  (SELECT wid_p05  FROM agg_wq),
        'width_core_max_um',  (SELECT wid_p95  FROM agg_wq),
        'width_mean_um',      (SELECT wid_mean FROM agg_wq),
        'q_min',              (SELECT q_min    FROM agg_wq),
        'q_max',              (SELECT q_max    FROM agg_wq),
        'q_p05',              (SELECT q_p05    FROM agg_wq),
        'q_p95',              (SELECT q_p95    FROM agg_wq),
        'q_core_min',         (SELECT q_p05    FROM agg_wq),
        'q_core_max',         (SELECT q_p95    FROM agg_wq),
        'q_mean',             (SELECT q_mean   FROM agg_wq)
      ))
    ELSE NULL END AS "sporeSummary",
    -- Per-observation array ordered most-recent first.
    coalesce((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'observationId', om.observation_id,
          'observedOn',    om.observed_on,
          'country',       om.country_code,
          'regionId',      om.region_id,
          'locationLabel', om.location_label,
          'sporeN',        om.spore_n,
          'lengthMeanUm',  om.length_mean,
          'widthMeanUm',   om.width_mean,
          'qMean',         om.q_mean,
          'sporeSummary',  om.spore_statistics
        ))
        ORDER BY om.observed_on DESC, om.observation_id DESC
      )
      FROM obs_means om
    ), '[]'::jsonb) AS "observations"
  FROM (SELECT 1) AS _single
  WHERE EXISTS (SELECT 1 FROM species_obs)
$$;


-- --- public.get_public_map_points(...)  [latest literal def: 20260720120000] ---

CREATE OR REPLACE FUNCTION "public"."get_public_map_points"("p_species_slug" "text" DEFAULT NULL::"text", "p_genus" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_has_spores" boolean DEFAULT NULL::boolean, "p_limit" integer DEFAULT 3000, "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("observationId" bigint, "speciesSlug" "text", "speciesName" "text", "speciesCommonName" "text", "observedOn" "date", "country" "text", "regionId" "text", "locationLabel" "text", "mapLat" double precision, "mapLon" double precision, "locationPrecision" "text", "hasMicroscopy" boolean, "sporeMeasurementCount" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
      nullif(btrim(lower(coalesce(p_sample_source,   ''))),  '') AS sample_source,
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
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND public.public_normalized_specimen_condition(i2.sample_type) = n.sample_type
      ))
      AND (n.sample_source IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = o.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND (i3.image_type = 'microscope' AND (i3.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i3.id)))
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
            AND (i4.image_type = 'microscope' AND (i4.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i4.id)))
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
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
    )) AS "hasMicroscopy",
    -- sporeMeasurementCount: public measurements only.
    CASE WHEN c.spore_data_visibility = 'public' THEN (
      SELECT count(m.id)::bigint
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = c.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
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
$_$;


-- --- public.get_public_observation_facets()  [latest literal def: 20260720120000] ---

CREATE OR REPLACE FUNCTION "public"."get_public_observation_facets"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
      public.public_normalized_specimen_condition(latest_image.sample_type) AS sample_type,
      public.public_normalized_sample_source(latest_image.sample_source, latest_image.sample_type) AS sample_source
    FROM public.observations o
    LEFT JOIN public.public_regions r
      ON r.id = o.region_id
    LEFT JOIN LATERAL (
      SELECT
        i.contrast,
        i.mount_medium,
        i.sample_type,
        i.sample_source
      FROM public.observation_images i
      WHERE i.observation_id = o.id
        AND i.deleted_at IS NULL
        AND i.purged_at IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC
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
  sample_sources AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'value', grouped.sample_source,
      'label', CASE grouped.sample_source WHEN 'spore_print' THEN 'Spore print' ELSE initcap(grouped.sample_source) END,
      'count', grouped.facet_count
    ) ORDER BY grouped.facet_count DESC, grouped.sample_source), '[]'::jsonb) AS items
    FROM (
      SELECT vo.sample_source, count(*)::bigint AS facet_count
      FROM visible_observations vo WHERE vo.sample_source IS NOT NULL
      GROUP BY vo.sample_source
    ) grouped
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
    'sampleSources', (SELECT items FROM sample_sources),
    'contrastMethods', (SELECT items FROM contrast_methods),
    'mountReagents', (SELECT items FROM mount_reagents)
  )
$_$;


-- --- public.get_public_species_distribution_summary(...)  [latest literal def: 20260720120000] ---

CREATE OR REPLACE FUNCTION "public"."get_public_species_distribution_summary"("p_species_slug" "text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_has_microscopy" boolean DEFAULT NULL::boolean, "p_has_spores" boolean DEFAULT NULL::boolean, "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" "date", "lastObservedOn" "date", "sampleTypeFacets" "jsonb", "sampleSourceFacets" "jsonb", "mountReagentFacets" "jsonb", "contrastMethodFacets" "jsonb", "mapPoints" "jsonb", "monthCounts" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
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
      nullif(btrim(upper(coalesce(p_country,       ''))), '') AS country,
      nullif(btrim(coalesce(p_region_id,           '')),  '') AS region_id,
      p_date_from                                             AS date_from,
      p_date_to                                               AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type,     ''))), '') AS sample_type,
      nullif(btrim(lower(coalesce(p_sample_source, ''))), '') AS sample_source,
      nullif(btrim(lower(coalesce(p_mount_reagent,   ''))), '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method,
      p_has_microscopy                                        AS has_microscopy,
      p_has_spores                                            AS has_spores
  ),

  -- All public, non-draft, non-banned-user observations for this species.
  -- No geographic or preparation filters — full set for facets and the
  -- existence gate (returns 0 rows when empty).
  all_obs AS (
    SELECT
      o.id,
      o.date                                                    AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), ''))    AS country_code,
      nullif(btrim(coalesce(o.region_id,           '')), '')    AS region_id,
      coalesce(o.location_precision, 'hidden')                  AS location_precision,
      o.gps_latitude,
      o.gps_longitude,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
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
      AND n.slug IS NOT NULL
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
  ),

  -- Filtered observations: apply all input parameters to all_obs.
  -- Preparation filters use EXISTS so an observation qualifies when ANY
  -- of its microscope images matches (observation-level granularity for
  -- map/month counts).
  filtered_obs AS (
    SELECT
      ao.id,
      ao.observed_on,
      ao.location_precision,
      ao.gps_latitude,
      ao.gps_longitude,
      ao.spore_data_visibility
    FROM all_obs ao
    CROSS JOIN norm n
    WHERE (n.country    IS NULL OR ao.country_code = n.country)
      AND (n.region_id  IS NULL OR ao.region_id    = n.region_id)
      AND (n.date_from  IS NULL OR ao.observed_on >= n.date_from)
      AND (n.date_to    IS NULL OR ao.observed_on <= n.date_to)
      -- Preparation filters via EXISTS (any matching image, not just latest).
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND public.public_normalized_specimen_condition(i2.sample_type) = n.sample_type
      ))
      AND (n.sample_source IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND lower(coalesce(i2.mount_medium, '')) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = ao.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND lower(coalesce(i2.contrast, '')) = n.contrast_method
      ))
      -- p_has_microscopy = true: must have at least one non-deleted/purged microscope image.
      AND (n.has_microscopy IS NOT TRUE OR EXISTS (
        SELECT 1 FROM public.observation_images i3
        WHERE i3.observation_id = ao.id
          AND i3.deleted_at IS NULL AND i3.purged_at IS NULL
          AND (i3.image_type = 'microscope' AND (i3.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i3.id)))
      ))
      -- p_has_spores = true: public spore_data_visibility + at least one qualifying measurement.
      AND (n.has_spores IS NOT TRUE OR (
        ao.spore_data_visibility = 'public'
        AND EXISTS (
          SELECT 1
          FROM public.observation_images i4
          JOIN public.spore_measurements m ON m.image_id = i4.id
          WHERE i4.observation_id = ao.id
            AND i4.deleted_at IS NULL AND i4.purged_at IS NULL
            AND (i4.image_type = 'microscope' AND (i4.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i4.id)))
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
        )
      ))
  ),

  -- Per-observation enriched filtered set: microscopy flag and prep-filtered
  -- spore count.
  --
  -- FIX (Bug 2): CROSS JOIN norm n brings prep filter values into scope.
  -- The spore_measurement_count subquery now applies the same image-level prep
  -- conditions so only measurements from matching-preparation images are
  -- counted.  Map/month counts still use observation-level EXISTS (above).
  filtered_obs_enriched AS (
    SELECT
      fo.id,
      fo.observed_on,
      fo.location_precision,
      fo.gps_latitude,
      fo.gps_longitude,
      -- Microscopy presence: any non-deleted/purged microscope image.
      (EXISTS (
        SELECT 1 FROM public.observation_images i
        WHERE i.observation_id = fo.id
          AND i.deleted_at IS NULL AND i.purged_at IS NULL
          AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      )) AS has_microscopy,
      -- Spore measurement count (public only, prep-filtered).
      CASE
        WHEN fo.spore_data_visibility = 'public' THEN (
          SELECT count(m.id)::bigint
          FROM public.observation_images i
          JOIN public.spore_measurements m ON m.image_id = i.id
          WHERE i.observation_id = fo.id
            AND i.deleted_at IS NULL AND i.purged_at IS NULL
            AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
            AND m.length_um IS NOT NULL
            AND (
              m.measurement_type IS NULL
              OR m.measurement_type = ''
              OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
            )
            -- Image-level prep filters (same conditions as filtered_obs EXISTS).
            AND (n.sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = n.sample_type)
            AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
            AND (n.mount_reagent   IS NULL OR lower(coalesce(i.mount_medium, '')) = n.mount_reagent)
            AND (n.contrast_method IS NULL OR lower(coalesce(i.contrast,     '')) = n.contrast_method)
        )
        ELSE 0::bigint
      END AS spore_measurement_count
    FROM filtered_obs fo
    CROSS JOIN norm n   -- needed to reference n.sample_type etc. inside subquery
  ),

  -- Coverage aggregate over all filtered enriched observations.
  coverage AS (
    SELECT
      count(foe.id)::bigint                                 AS observation_count,
      count(*) FILTER (WHERE foe.has_microscopy)::bigint    AS microscopy_observation_count,
      coalesce(sum(foe.spore_measurement_count), 0)::bigint AS spore_measurement_count,
      min(foe.observed_on)                                  AS first_observed_on,
      max(foe.observed_on)                                  AS last_observed_on
    FROM filtered_obs_enriched foe
  ),

  -- sampleTypeFacets: FIX (Bug 1): join ALL microscopy images (not latest only).
  -- Count DISTINCT observation IDs per prep value so an observation with two
  -- fresh images is counted once.  Matches the EXISTS filter used for selection.
  sample_type_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', st.sv, 'count', st.cnt)
        ORDER BY st.cnt DESC, st.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(public.public_normalized_specimen_condition(i.sample_type), '') AS sv,
        count(DISTINCT ao.id)::bigint                          AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      WHERE nullif(public.public_normalized_specimen_condition(i.sample_type), '') IS NOT NULL
      GROUP BY nullif(public.public_normalized_specimen_condition(i.sample_type), '')
    ) st
  ),

  sample_source_facets AS (
    SELECT coalesce(jsonb_agg(jsonb_build_object('value', ss.sv, 'count', ss.cnt)
      ORDER BY ss.cnt DESC, ss.sv), '[]'::jsonb) AS facets
    FROM (
      SELECT public.public_normalized_sample_source(i.sample_source, i.sample_type) AS sv,
             count(DISTINCT ao.id)::bigint AS cnt
      FROM all_obs ao JOIN public.observation_images i ON i.observation_id = ao.id
       AND i.deleted_at IS NULL AND i.purged_at IS NULL AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      WHERE public.public_normalized_sample_source(i.sample_source, i.sample_type) IS NOT NULL
      GROUP BY public.public_normalized_sample_source(i.sample_source, i.sample_type)
    ) ss
  ),

  -- mountReagentFacets: same fix — all microscopy images, distinct obs per value.
  mount_reagent_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', mr.sv, 'count', mr.cnt)
        ORDER BY mr.cnt DESC, mr.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(lower(btrim(coalesce(i.mount_medium, ''))), '') AS sv,
        count(DISTINCT ao.id)::bigint                           AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      WHERE nullif(lower(btrim(coalesce(i.mount_medium, ''))), '') IS NOT NULL
      GROUP BY nullif(lower(btrim(coalesce(i.mount_medium, ''))), '')
    ) mr
  ),

  -- contrastMethodFacets: same fix.  Note: contrast values are NOT lowercased
  -- in the facet output (DIC/BF etc. are conventionally uppercase), but are
  -- lowercased in the filter norm for case-insensitive matching.
  contrast_method_facets AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('value', cm.sv, 'count', cm.cnt)
        ORDER BY cm.cnt DESC, cm.sv ASC
      ),
      '[]'::jsonb
    ) AS facets
    FROM (
      SELECT
        nullif(btrim(coalesce(i.contrast, '')), '') AS sv,
        count(DISTINCT ao.id)::bigint               AS cnt
      FROM all_obs ao
      JOIN public.observation_images i ON i.observation_id = ao.id
        AND i.deleted_at IS NULL AND i.purged_at IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      WHERE nullif(btrim(coalesce(i.contrast, '')), '') IS NOT NULL
      GROUP BY nullif(btrim(coalesce(i.contrast, '')), '')
    ) cm
  ),

  -- mapPoints: privacy-safe coordinates from filtered_obs. LIMIT 1000.
  map_points AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'observationId',     pt.id,
          'mapLat',            pt.map_lat,
          'mapLon',            pt.map_lon,
          'locationPrecision', pt.location_precision,
          'observedOn',        pt.observed_on,
          'hasMicroscopy',     pt.has_microscopy
        )
        ORDER BY pt.observed_on DESC, pt.id DESC
      ),
      '[]'::jsonb
    ) AS points
    FROM (
      SELECT
        foe.id,
        foe.observed_on,
        foe.location_precision,
        foe.has_microscopy,
        CASE
          WHEN foe.location_precision = 'exact'  THEN foe.gps_latitude
          WHEN foe.location_precision = 'fuzzed' THEN round(foe.gps_latitude::numeric, 2)::double precision
          ELSE NULL::double precision
        END AS map_lat,
        CASE
          WHEN foe.location_precision = 'exact'  THEN foe.gps_longitude
          WHEN foe.location_precision = 'fuzzed' THEN round(foe.gps_longitude::numeric, 2)::double precision
          ELSE NULL::double precision
        END AS map_lon
      FROM filtered_obs_enriched foe
      WHERE foe.gps_latitude IS NOT NULL
      ORDER BY foe.observed_on DESC, foe.id DESC
      LIMIT 1000
    ) pt
  ),

  -- monthCounts: calendar month distribution from filtered_obs.
  month_counts AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object('month', mc.month, 'count', mc.cnt)
        ORDER BY mc.month ASC
      ),
      '[]'::jsonb
    ) AS counts
    FROM (
      SELECT
        EXTRACT(MONTH FROM foe.observed_on)::int AS month,
        count(*)::bigint                         AS cnt
      FROM filtered_obs_enriched foe
      GROUP BY EXTRACT(MONTH FROM foe.observed_on)::int
      HAVING count(*) > 0
    ) mc
  )

  SELECT
    c.observation_count            AS "observationCount",
    c.microscopy_observation_count AS "microscopyObservationCount",
    c.spore_measurement_count      AS "sporeMeasurementCount",
    c.first_observed_on            AS "firstObservedOn",
    c.last_observed_on             AS "lastObservedOn",
    (SELECT facets FROM sample_type_facets)     AS "sampleTypeFacets",
    (SELECT facets FROM sample_source_facets)   AS "sampleSourceFacets",
    (SELECT facets FROM mount_reagent_facets)   AS "mountReagentFacets",
    (SELECT facets FROM contrast_method_facets) AS "contrastMethodFacets",
    (SELECT points FROM map_points)             AS "mapPoints",
    (SELECT counts FROM month_counts)           AS "monthCounts"
  FROM coverage c
  WHERE EXISTS (SELECT 1 FROM all_obs)
$_$;


-- --- public.get_public_spore_comparison_set(...)  [latest literal def: 20260720120000] ---

CREATE OR REPLACE FUNCTION "public"."get_public_spore_comparison_set"("p_species_slug" "text" DEFAULT NULL::"text", "p_genus" "text" DEFAULT NULL::"text", "p_country" "text" DEFAULT NULL::"text", "p_region_id" "text" DEFAULT NULL::"text", "p_date_from" "date" DEFAULT NULL::"date", "p_date_to" "date" DEFAULT NULL::"date", "p_sample_type" "text" DEFAULT NULL::"text", "p_mount_reagent" "text" DEFAULT NULL::"text", "p_contrast_method" "text" DEFAULT NULL::"text", "p_sample_source" "text" DEFAULT NULL::"text") RETURNS TABLE("sourceType" "text", "taxonRank" "text", "speciesSlug" "text", "genus" "text", "label" "text", "filters" "jsonb", "observationCount" bigint, "sporeObservationCount" bigint, "sporeMeasurementCount" bigint, "sporeSummary" "jsonb", "observations" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  WITH norm AS (
    SELECT
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
      nullif(btrim(coalesce(p_genus, '')), '') AS genus,
      nullif(btrim(upper(coalesce(p_country, ''))),    '') AS country,
      nullif(btrim(coalesce(p_region_id, '')),         '') AS region_id,
      p_date_from AS date_from,
      p_date_to   AS date_to,
      nullif(btrim(lower(coalesce(p_sample_type, ''))),     '') AS sample_type,
      nullif(btrim(lower(coalesce(p_sample_source, ''))), '') AS sample_source,
      nullif(btrim(lower(coalesce(p_mount_reagent, ''))),   '') AS mount_reagent,
      nullif(btrim(lower(coalesce(p_contrast_method, ''))), '') AS contrast_method
  ),
  taxon AS (
    SELECT
      CASE
        WHEN n.slug IS NOT NULL THEN 'species'
        WHEN n.genus IS NOT NULL THEN 'genus'
        ELSE NULL
      END AS rank,
      n.slug  AS species_slug,
      n.genus AS genus_filter
    FROM norm n
  ),
  taxon_obs AS (
    SELECT
      o.id,
      nullif(btrim(coalesce(o.genus, '')), '')    AS obs_genus,
      nullif(btrim(coalesce(o.species, '')), '')  AS obs_species,
      nullif(btrim(coalesce(o.common_name, '')), '') AS obs_common_name,
      o.date AS observed_on,
      upper(nullif(btrim(coalesce(o.country_code, '')), '')) AS country_code,
      nullif(btrim(coalesce(o.region_id, '')), '') AS region_id,
      coalesce(o.location_precision, 'hidden')     AS location_precision,
      nullif(btrim(coalesce(o.location, '')), '')  AS location_text,
      nullif(btrim(coalesce(r.label, '')), '')     AS region_label,
      o.spore_data_visibility
    FROM public.observations o
    CROSS JOIN norm n
    CROSS JOIN taxon t
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
      AND (
        CASE t.rank
          WHEN 'species' THEN
            nullif(
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
            ) = t.species_slug
          WHEN 'genus' THEN
            lower(coalesce(o.genus, '')) = lower(t.genus_filter)
          ELSE false
        END
      )
      AND (n.country    IS NULL OR upper(nullif(btrim(coalesce(o.country_code, '')), '')) = n.country)
      AND (n.region_id  IS NULL OR nullif(btrim(coalesce(o.region_id, '')), '') = n.region_id)
      AND (n.date_from  IS NULL OR o.date >= n.date_from)
      AND (n.date_to    IS NULL OR o.date <= n.date_to)
      AND (n.sample_type IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND public.public_normalized_specimen_condition(i2.sample_type) = n.sample_type
      ))
      AND (n.sample_source IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND public.public_normalized_sample_source(i2.sample_source, i2.sample_type) = n.sample_source
      ))
      AND (n.mount_reagent IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND lower(btrim(coalesce(i2.mount_medium, ''))) = n.mount_reagent
      ))
      AND (n.contrast_method IS NULL OR EXISTS (
        SELECT 1 FROM public.observation_images i2
        WHERE i2.observation_id = o.id
          AND i2.deleted_at IS NULL AND i2.purged_at IS NULL
          AND (i2.image_type = 'microscope' AND (i2.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i2.id)))
          AND lower(btrim(coalesce(i2.contrast, ''))) = n.contrast_method
      ))
  ),
  spore_eligible AS (
    SELECT
      to_id.id,
      to_id.observed_on,
      to_id.obs_genus,
      to_id.obs_species,
      to_id.obs_common_name,
      to_id.country_code,
      to_id.region_id,
      to_id.location_precision,
      to_id.location_text,
      to_id.region_label,
      spore_counts.spore_n,
      n.sample_type     AS filter_sample_type,
      n.sample_source   AS filter_sample_source,
      n.mount_reagent   AS filter_mount_reagent,
      n.contrast_method AS filter_contrast_method
    FROM taxon_obs to_id
    CROSS JOIN norm n
    JOIN LATERAL (
      SELECT count(m.id)::bigint AS spore_n
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = to_id.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (n.sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = n.sample_type)
        AND (n.sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = n.sample_source)
        AND (n.mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = n.mount_reagent)
        AND (n.contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = n.contrast_method)
    ) spore_counts ON spore_counts.spore_n > 0
    WHERE to_id.spore_data_visibility = 'public'
  ),
  raw_meas AS (
    SELECT m.length_um, m.width_um
    FROM spore_eligible se
    JOIN public.observation_images i
      ON i.observation_id = se.id
      AND i.deleted_at IS NULL
      AND i.purged_at  IS NULL
      AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
      AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
      AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
      AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
      AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    JOIN public.spore_measurements m ON m.image_id = i.id
      AND m.length_um IS NOT NULL
      AND (
        m.measurement_type IS NULL
        OR m.measurement_type = ''
        OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
      )
  ),
  agg_len AS (
    SELECT
      count(*)::bigint                                                            AS n,
      min(length_um)                                                              AS len_min,
      max(length_um)                                                              AS len_max,
      avg(length_um)                                                              AS len_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision  AS len_p95
    FROM raw_meas
  ),
  agg_wq AS (
    SELECT
      min(width_um)                                                               AS wid_min,
      max(width_um)                                                               AS wid_max,
      avg(width_um)                                                               AS wid_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision   AS wid_p95,
      min(length_um / nullif(width_um, 0))                                        AS q_min,
      max(length_um / nullif(width_um, 0))                                        AS q_max,
      avg(length_um / nullif(width_um, 0))                                        AS q_mean,
      percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p05,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um / nullif(width_um, 0))::double precision AS q_p95
    FROM raw_meas
    WHERE width_um IS NOT NULL AND width_um > 0
  ),
  obs_means AS (
    SELECT
      se.id               AS observation_id,
      se.observed_on,
      se.obs_genus,
      se.obs_species,
      se.obs_common_name,
      se.country_code,
      se.region_id,
      CASE
        WHEN se.location_precision = 'exact'  THEN se.location_text
        WHEN se.location_precision = 'fuzzed' THEN coalesce(se.region_label, se.country_code)
        WHEN se.location_precision = 'region' THEN se.region_label
        ELSE NULL
      END                 AS location_label,
      se.spore_n,
      se.filter_sample_type,
      se.filter_sample_source,
      se.filter_mount_reagent,
      se.filter_contrast_method,
      rep_img.sample_type    AS rep_sample_type,
      rep_img.sample_source  AS rep_sample_source,
      rep_img.mount_medium   AS rep_mount_reagent,
      rep_img.contrast       AS rep_contrast_method,
      rep_img.stain          AS rep_stain_reagent,
      obs_stats.length_mean,
      obs_stats.width_mean,
      obs_stats.q_mean,
      obs_agg.obs_spore_summary,
      -- Per-observation prep summary. Mirrors the `prep_agg` shape
      -- emitted by get_public_observation so both endpoints agree on
      -- what an observation's full prep set contains. Scoped to
      -- microscope images with at least one spore-typed measurement,
      -- with the same active prep filters applied.
      obs_prep_summary.prep_summary
    FROM spore_eligible se
    LEFT JOIN LATERAL (
      SELECT
        i.sample_type,
        i.sample_source,
        i.mount_medium,
        i.contrast,
        i.stain
      FROM public.observation_images i
      JOIN LATERAL (
        SELECT count(*)::bigint AS n
        FROM public.spore_measurements m
        WHERE m.image_id = i.id
          AND m.length_um IS NOT NULL
          AND m.width_um  IS NOT NULL
          AND m.width_um > 0
          AND (
            m.measurement_type IS NULL
            OR m.measurement_type = ''
            OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
          )
      ) contrib ON contrib.n > 0
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
        AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
      ORDER BY contrib.n DESC, i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC
      LIMIT 1
    ) rep_img ON true
    JOIN LATERAL (
      SELECT
        avg(m.length_um) AS length_mean,
        avg(m.width_um)  FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS width_mean,
        avg(m.length_um / nullif(m.width_um, 0))
                         FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0) AS q_mean
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
        AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_stats ON true
    JOIN LATERAL (
      SELECT
        jsonb_strip_nulls(jsonb_build_object(
          'n',               count(m.id)::bigint,
          'length_min_um',   min(m.length_um),
          'length_max_um',   max(m.length_um),
          'length_mean_um',  avg(m.length_um),
          'width_min_um',    min(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'width_max_um',    max(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'width_mean_um',   avg(m.width_um) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_min',           min(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_max',           max(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0),
          'q_mean',          avg(m.length_um / nullif(m.width_um, 0)) FILTER (WHERE m.width_um IS NOT NULL AND m.width_um > 0)
        )) AS obs_spore_summary
      FROM public.observation_images i
      JOIN public.spore_measurements m ON m.image_id = i.id
      WHERE i.observation_id = se.id
        AND i.deleted_at IS NULL
        AND i.purged_at  IS NULL
        AND (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id)))
        AND m.length_um IS NOT NULL
        AND (
          m.measurement_type IS NULL
          OR m.measurement_type = ''
          OR lower(m.measurement_type) IN ('manual', 'spore', 'spores')
        )
        AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
        AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
        AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
        AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
    ) obs_agg ON true
    LEFT JOIN LATERAL (
      -- Dedupe to one row per contributing image, then aggregate
      -- distinct values per dimension. Membership, not weight, is
      -- what the summary conveys: a mount used on eight images
      -- must not outweigh one used on one image.
      WITH contributors AS (
        SELECT DISTINCT
          i.id AS image_id,
          nullif(btrim(coalesce(i.contrast, '')), '')      AS contrast,
          nullif(btrim(coalesce(i.mount_medium, '')), '')  AS mount_medium,
          nullif(btrim(coalesce(i.stain, '')), '')         AS stain,
          nullif(btrim(coalesce(i.sample_type, '')), '')   AS sample_type,
          nullif(btrim(coalesce(i.sample_source, '')), '') AS sample_source
        FROM public.observation_images i
        WHERE i.observation_id = se.id
          AND i.deleted_at IS NULL
          AND i.purged_at  IS NULL
          AND (i.image_type IS NULL OR (i.image_type = 'microscope' AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))))
          AND EXISTS (
            SELECT 1
            FROM public.spore_measurements m3
            WHERE m3.image_id = i.id
              AND (
                m3.measurement_type IS NULL
                OR m3.measurement_type = ''
                OR lower(m3.measurement_type) IN ('manual', 'spore', 'spores')
              )
          )
          AND (se.filter_sample_type IS NULL OR public.public_normalized_specimen_condition(i.sample_type) = se.filter_sample_type)
          AND (se.filter_sample_source IS NULL OR public.public_normalized_sample_source(i.sample_source, i.sample_type) = se.filter_sample_source)
          AND (se.filter_mount_reagent   IS NULL OR lower(btrim(coalesce(i.mount_medium, ''))) = se.filter_mount_reagent)
          AND (se.filter_contrast_method IS NULL OR lower(btrim(coalesce(i.contrast,     ''))) = se.filter_contrast_method)
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
    ) obs_prep_summary ON true
  ),
  first_obs AS (
    SELECT obs_genus, obs_species, obs_common_name
    FROM taxon_obs
    LIMIT 1
  )
  SELECT
    'taxon_filter'::text AS "sourceType",
    (SELECT rank FROM taxon) AS "taxonRank",
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (
        SELECT nullif(
          regexp_replace(
            regexp_replace(
              lower(btrim(concat_ws(' ',
                nullif(btrim(coalesce(fo.obs_genus,   '')), ''),
                nullif(btrim(coalesce(fo.obs_species, '')), '')
              ))),
              '[^a-z0-9]+', '-', 'g'
            ),
            '(^-|-$)', '', 'g'
          ),
          ''
        )
        FROM first_obs fo
      )
      ELSE NULL
    END AS "speciesSlug",
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (SELECT nullif(btrim(coalesce(fo.obs_genus, '')), '') FROM first_obs fo)
      WHEN 'genus'   THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS genus,
    CASE (SELECT rank FROM taxon)
      WHEN 'species' THEN (
        SELECT nullif(btrim(concat_ws(' ',
          nullif(btrim(coalesce(fo.obs_genus,   '')), ''),
          nullif(btrim(coalesce(fo.obs_species, '')), '')
        )), '')
        FROM first_obs fo
      )
      WHEN 'genus' THEN (SELECT genus_filter FROM taxon)
      ELSE NULL
    END AS label,
    jsonb_strip_nulls(jsonb_build_object(
      'country',         (SELECT country    FROM norm),
      'regionId',        (SELECT region_id  FROM norm),
      'dateFrom',        (SELECT date_from  FROM norm),
      'dateTo',          (SELECT date_to    FROM norm),
      'sampleType',      (SELECT sample_type     FROM norm),
      'mountReagent',    (SELECT mount_reagent   FROM norm),
      'contrastMethod',  (SELECT contrast_method FROM norm)
    ))                   AS filters,
    (SELECT count(*)::bigint FROM taxon_obs)           AS "observationCount",
    (SELECT count(*)::bigint FROM spore_eligible)      AS "sporeObservationCount",
    coalesce((SELECT sum(spore_n) FROM spore_eligible), 0)::bigint AS "sporeMeasurementCount",
    CASE WHEN (SELECT n FROM agg_len) > 0 THEN
      jsonb_strip_nulls(jsonb_build_object(
        'n',                  (SELECT n        FROM agg_len),
        'length_min_um',      (SELECT len_min  FROM agg_len),
        'length_max_um',      (SELECT len_max  FROM agg_len),
        'length_p05_um',      (SELECT len_p05  FROM agg_len),
        'length_p95_um',      (SELECT len_p95  FROM agg_len),
        'length_core_min_um', (SELECT len_p05  FROM agg_len),
        'length_core_max_um', (SELECT len_p95  FROM agg_len),
        'length_mean_um',     (SELECT len_mean FROM agg_len),
        'width_min_um',       (SELECT wid_min  FROM agg_wq),
        'width_max_um',       (SELECT wid_max  FROM agg_wq),
        'width_p05_um',       (SELECT wid_p05  FROM agg_wq),
        'width_p95_um',       (SELECT wid_p95  FROM agg_wq),
        'width_core_min_um',  (SELECT wid_p05  FROM agg_wq),
        'width_core_max_um',  (SELECT wid_p95  FROM agg_wq),
        'width_mean_um',      (SELECT wid_mean FROM agg_wq),
        'q_min',              (SELECT q_min    FROM agg_wq),
        'q_max',              (SELECT q_max    FROM agg_wq),
        'q_p05',              (SELECT q_p05    FROM agg_wq),
        'q_p95',              (SELECT q_p95    FROM agg_wq),
        'q_core_min',         (SELECT q_p05    FROM agg_wq),
        'q_core_max',         (SELECT q_p95    FROM agg_wq),
        'q_mean',             (SELECT q_mean   FROM agg_wq)
      ))
    ELSE NULL END AS "sporeSummary",
    coalesce((
      SELECT jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'observationId',      om.observation_id,
          'observedOn',         om.observed_on,
          'speciesSlug',        nullif(
                                  regexp_replace(
                                    regexp_replace(
                                      lower(btrim(concat_ws(' ',
                                        nullif(btrim(coalesce(om.obs_genus,   '')), ''),
                                        nullif(btrim(coalesce(om.obs_species, '')), '')
                                      ))),
                                      '[^a-z0-9]+', '-', 'g'
                                    ),
                                    '(^-|-$)', '', 'g'
                                  ),
                                  ''
                                ),
          'speciesName',        nullif(btrim(concat_ws(' ',
                                  nullif(btrim(coalesce(om.obs_genus,   '')), ''),
                                  nullif(btrim(coalesce(om.obs_species, '')), '')
                                )), ''),
          'speciesCommonName',  om.obs_common_name,
          'country',            om.country_code,
          'regionId',           om.region_id,
          'locationLabel',      om.location_label,
          'sampleType',         CASE
                                  WHEN lower(btrim(coalesce(coalesce(om.rep_sample_type, om.filter_sample_type), ''))) IN ('fresh', 'dried')
                                    THEN lower(btrim(coalesce(om.rep_sample_type, om.filter_sample_type)))
                                  ELSE NULL::text
                                END,
          'sampleSource',       public.public_normalized_sample_source(
                                  om.rep_sample_source,
                                  om.rep_sample_type
                                ),
          'mountReagent',       coalesce(om.rep_mount_reagent,   om.filter_mount_reagent),
          'contrastMethod',     coalesce(om.rep_contrast_method, om.filter_contrast_method),
          'stainReagent',       nullif(btrim(coalesce(om.rep_stain_reagent, '')), ''),
          'sporeN',             om.spore_n,
          'lengthMeanUm',       om.length_mean,
          'widthMeanUm',        om.width_mean,
          'qMean',              om.q_mean,
          'sporeSummary',       om.obs_spore_summary,
          -- Aggregate prep values across all contributing microscope
          -- images so the caller can distinguish a mixed-prep
          -- observation from a single-prep one. jsonb_strip_nulls does
          -- not remove empty arrays, so `prepSummary` is always present
          -- with the five keys (each an empty array when nothing
          -- contributed).
          'prepSummary',        om.prep_summary
        ))
        ORDER BY om.observed_on DESC, om.observation_id DESC
      )
      FROM obs_means om
    ), '[]'::jsonb) AS "observations"
  FROM (SELECT 1) AS _single
  WHERE (SELECT rank FROM taxon) IS NOT NULL
    AND EXISTS (SELECT 1 FROM taxon_obs)
$_$;


-- --- public.get_observation_microscopy_presentations(bigint[])  [latest literal def: 20260824130000] ---
-- NOTE: unlike every other function in this migration, the spore_counts CTE
-- below uses metadata_microscope_parent_is_visible_to_reader(), not
-- metadata_microscope_parent_is_public() — see comment 7 in the migration
-- header. This RPC also serves the image owner and other authorized
-- non-owner readers on non-public observations via its own upstream
-- accessible_obs/spore_accessible_obs checks.

CREATE OR REPLACE FUNCTION public.get_observation_microscopy_presentations(
  p_observation_ids bigint[]
)
RETURNS TABLE (
  "observationId"          bigint,
  "sporeMeasurementCount"  bigint,
  "sporeSummary"           jsonb,
  "sporeMosaic"            jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ids bigint[];
BEGIN
  -- Dedupe non-null ids, then enforce the 200-id hard cap with an explicit error.
  SELECT array_agg(DISTINCT v ORDER BY v)
    INTO v_ids
    FROM unnest(p_observation_ids) v
    WHERE v IS NOT NULL;

  IF coalesce(array_length(v_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION
      'get_observation_microscopy_presentations: too many observation ids (max 200)';
  END IF;

  RETURN QUERY
  WITH accessible_obs AS (
    -- Owners see their own observations unconditionally (draft, private, etc.).
    -- Non-owners see only non-draft observations that pass can_read_observation,
    -- which internally enforces banned-author and block-relationship checks.
    -- The belt-and-suspenders banned/blocked guards below are kept for
    -- consistency with other read RPCs in this codebase.
    SELECT o.id, o.user_id, o.spore_data_visibility
    FROM public.observations o
    WHERE o.id = ANY(v_ids)
      AND (
        o.user_id = auth.uid()
        OR (
          NOT COALESCE(o.is_draft, false)
          AND public.can_read_observation(o.user_id, o.visibility)
          AND NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = o.user_id AND p.is_banned = true
          )
          AND (
            auth.uid() IS NULL
            OR NOT public.is_blocked_between(auth.uid(), o.user_id)
          )
        )
      )
  ),
  spore_accessible_obs AS (
    -- Subset of accessible observations where the caller may also read spore data.
    -- Spore CTEs join here so denied callers never pay for those aggregates.
    SELECT ao.id, ao.user_id, ao.spore_data_visibility
    FROM accessible_obs ao
    WHERE ao.user_id = auth.uid()
       OR public.can_access_spore_data(ao.user_id, ao.spore_data_visibility)
  ),
  spore_counts AS (
    -- Count active, non-purged microscope measurements using the repo-standard
    -- accepted measurement-type filter. Only computed for spore-accessible obs.
    SELECT oi.observation_id, count(sm.id) AS cnt
    FROM public.spore_measurements sm
    JOIN public.observation_images oi ON oi.id = sm.image_id
    JOIN spore_accessible_obs sao ON sao.id = oi.observation_id
    WHERE oi.image_type = 'microscope'
      AND (oi.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_visible_to_reader(oi.id))
      AND oi.deleted_at IS NULL
      AND oi.purged_at IS NULL
      AND (
        sm.measurement_type IS NULL
        OR sm.measurement_type = ''
        OR lower(sm.measurement_type) IN ('manual', 'spore', 'spores')
      )
    GROUP BY oi.observation_id
  ),
  latest_mosaic AS (
    -- One mosaic row per observation: latest by version DESC, id DESC.
    -- Only computed for spore-accessible observations.
    SELECT DISTINCT ON (m.observation_id)
      m.observation_id,
      m.id            AS mosaic_id,
      m.media_version,
      m.width_px,
      m.height_px,
      m.version,
      m.tile_width_px,
      m.tile_height_px,
      m.common_crop_width_um,
      m.common_crop_height_um
    FROM public.spore_measurement_mosaics m
    JOIN spore_accessible_obs sao ON sao.id = m.observation_id
    ORDER BY m.observation_id, m.version DESC, m.id DESC
  ),
  best_summary AS (
    -- One summary row per observation: most recently computed.
    -- Projected via an explicit allowlist — no id, user_id, observation_id,
    -- context_hash, created_at, or updated_at fields are included.
    -- Only computed for spore-accessible observations.
    SELECT DISTINCT ON (s.observation_id)
      s.observation_id,
      jsonb_build_object(
        'context_json',       s.context_json,
        'measurement_type',   s.measurement_type,
        'sample_type',        s.sample_type,
        'mount_reagent',      s.mount_reagent,
        'stain_reagent',      s.stain_reagent,
        'contrast_method',    s.contrast_method,
        'n_spores',           s.n_spores,
        'n_paired',           s.n_paired,
        'n_length',           s.n_length,
        'n_width',            s.n_width,
        'length_min_um',      s.length_min_um,
        'length_p05_um',      s.length_p05_um,
        'length_mean_um',     s.length_mean_um,
        'length_median_um',   s.length_median_um,
        'length_p95_um',      s.length_p95_um,
        'length_max_um',      s.length_max_um,
        'length_sd_um',       s.length_sd_um,
        'width_min_um',       s.width_min_um,
        'width_p05_um',       s.width_p05_um,
        'width_mean_um',      s.width_mean_um,
        'width_median_um',    s.width_median_um,
        'width_p95_um',       s.width_p95_um,
        'width_max_um',       s.width_max_um,
        'width_sd_um',        s.width_sd_um,
        'q_min',              s.q_min,
        'q_p05',              s.q_p05,
        'q_mean',             s.q_mean,
        'q_median',           s.q_median,
        'q_p95',              s.q_p95,
        'q_max',              s.q_max,
        'q_sd',               s.q_sd,
        'stats_version',      s.stats_version,
        'computed_at',        s.computed_at,
        'source_app',         s.source_app,
        'source_app_version', s.source_app_version
      ) AS summary_json
    FROM public.observation_spore_summaries s
    JOIN spore_accessible_obs sao ON sao.id = s.observation_id
    ORDER BY s.observation_id, s.computed_at DESC NULLS LAST, s.id DESC
  )
  SELECT
    ao.id AS "observationId",

    -- sporeMeasurementCount: 0 when spore-accessible with no measurements,
    -- NULL when spore data is denied (sao.id IS NULL).
    CASE
      WHEN sao.id IS NOT NULL THEN COALESCE(sc.cnt, 0)
      ELSE NULL
    END AS "sporeMeasurementCount",

    -- sporeSummary and sporeMosaic: already NULL when denied because the CTEs
    -- only produce rows for spore_accessible_obs.
    bs.summary_json AS "sporeSummary",

    CASE
      WHEN lm.mosaic_id IS NOT NULL
        THEN jsonb_build_object(
          'mosaicId',           lm.mosaic_id,
          'mosaicMediaVersion', lm.media_version,
          'mosaicMediaUrl',     public.build_worker_mosaic_url(lm.mosaic_id, lm.media_version),
          'width',              lm.width_px,
          'height',             lm.height_px,
          'version',            lm.version,
          'tileWidthPx',        lm.tile_width_px,
          'tileHeightPx',       lm.tile_height_px,
          'commonCropWidthUm',  lm.common_crop_width_um,
          'commonCropHeightUm', lm.common_crop_height_um
        )
      ELSE NULL
    END AS "sporeMosaic"

  FROM accessible_obs ao
  LEFT JOIN spore_accessible_obs sao ON sao.id = ao.id
  LEFT JOIN spore_counts sc ON sc.observation_id = ao.id
  LEFT JOIN latest_mosaic lm ON lm.observation_id = ao.id
  LEFT JOIN best_summary bs ON bs.observation_id = ao.id;
END $$;


NOTIFY pgrst, 'reload schema';

COMMIT;
