-- Hide observation time of day from every non-owner read.
--
-- Product rule: the date of an observation may be public, its time of day
-- may not. The shared read views are granted to anon AND authenticated and
-- serve every viewer the same projection, so any signed-in non-owner was able
-- to read captured_at / created_at / ai_selected_at (and the image upload
-- created_at) with full time of day.
--
-- observation_identifications_community_view is handled the same way but is
-- owner-aware (see its section at the end).
--
-- Image storage keys embed the upload epoch-ms (<user>/<obs>/<sort>_<ms>.<ext>;
-- desktop keys may embed the capture time). storage_path / image_key /
-- thumb_key are now returned only to the observation owner, and the legacy
-- key-derived URLs of search_public_observation_images are NULL. Existing
-- objects keep their keys (not re-keyed); new web keys use a random suffix.
--
-- Fix: the four shared observation views keep their exact column list, names and types,
-- but the time-bearing timestamptz columns are now always NULL. The date is
-- still served by observations.date (a DATE column, the local observation
-- date chosen by the client, so no UTC truncation and no timezone shift).
--
-- Owners keep full timestamps through the base tables (observations,
-- observation_images), whose owner-only RLS (phase7_*_read) is unchanged and
-- which every owner path in sporely-web already reads first.
--
-- Ordering: clients that ORDER BY created_at on these views now tie on NULL
-- and fall through to their next key (sporely-web finds feed: date desc,
-- created_at desc, id desc -> effectively date desc, id desc). Observation ids
-- are allocated in insert order, so same-date rows keep upload order without
-- exposing any time. The public RPCs (search_public_observations,
-- get_public_map_points, species/spore RPCs) already return only DATE values
-- and use timestamps only inside ORDER BY; they are untouched.
--
-- CREATE OR REPLACE VIEW keeps grants, comments and dependent objects. The
-- bodies below are the current definitions with only the listed columns
-- replaced. Rollback: supabase/rollbacks/20261001195524_rollback.sql.

BEGIN;

CREATE OR REPLACE VIEW public.observations_community_view WITH (security_barrier = true) AS
SELECT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    NULL::timestamp with time zone AS captured_at,
    NULL::timestamp with time zone AS created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'exact'::text) THEN o.location
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['fuzzed'::text, 'region'::text])) THEN COALESCE(pr.label, o.country_code)
            ELSE NULL::text
        END AS location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    CASE WHEN o.user_id = auth.uid() THEN o.image_key END AS image_key,
    CASE WHEN o.user_id = auth.uid() THEN o.thumb_key END AS thumb_key,
    o.is_draft,
    o.location_precision,
    o.ai_selected_service,
    o.ai_selected_taxon_id,
    o.ai_selected_scientific_name,
    o.ai_selected_probability,
    NULL::timestamp with time zone AS ai_selected_at,
        CASE
            WHEN (COALESCE(o.spore_data_visibility, 'public'::text) = 'public'::text) THEN o.spore_statistics
            ELSE NULL::jsonb
        END AS spore_statistics,
    o.red_list_category,
    o.red_list_categories_json,
    media.image_id,
    media.media_version,
    media.full_media_url,
    media.thumb_media_url,
    o.selected_sporely_taxon_id,
    o.taxon_identity_state,
    o.taxon_identity_source_system,
    o.taxon_identity_namespace,
    o.taxon_identity_external_id,
    o.taxon_identity_raw_external_id
   FROM ((observations o
     LEFT JOIN public_regions pr ON ((pr.id = o.region_id)))
     LEFT JOIN LATERAL _stage2b_observation_primary_media(o.id, o.image_key) media(image_id, media_version, full_media_url, thumb_media_url) ON (true))
  WHERE ((COALESCE(o.visibility, 'public'::text) = 'public'::text) AND (NOT COALESCE(o.is_draft, false)) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observations_follow_view AS
SELECT DISTINCT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    NULL::timestamp with time zone AS captured_at,
    NULL::timestamp with time zone AS created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'exact'::text) THEN o.location
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['fuzzed'::text, 'region'::text])) THEN COALESCE(pr.label, o.country_code)
            ELSE NULL::text
        END AS location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    CASE WHEN o.user_id = auth.uid() THEN o.image_key END AS image_key,
    CASE WHEN o.user_id = auth.uid() THEN o.thumb_key END AS thumb_key,
    o.is_draft,
    o.location_precision,
    media.image_id,
    media.media_version,
    media.full_media_url,
    media.thumb_media_url
   FROM (((observations o
     JOIN follows f ON (((f.user_id = auth.uid()) AND (((f.target_type = 'user'::text) AND (f.target_id = (o.user_id)::text)) OR ((f.target_type = 'observation'::text) AND (f.target_id = (o.id)::text)) OR ((f.target_type = 'genus'::text) AND (lower(f.target_id) = lower(COALESCE(o.genus, ''::text)))) OR ((f.target_type = 'species'::text) AND (lower(f.target_id) = lower(TRIM(BOTH FROM concat_ws(' '::text, o.genus, o.species)))))))))
     LEFT JOIN public_regions pr ON ((pr.id = o.region_id)))
     LEFT JOIN LATERAL _stage2b_observation_primary_media(o.id, o.image_key) media(image_id, media_version, full_media_url, thumb_media_url) ON (true))
  WHERE (can_read_observation(o.user_id, o.visibility) AND (NOT COALESCE(o.is_draft, false)) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observations_friend_view WITH (security_barrier = true) AS
SELECT o.id,
    o.user_id,
    o.desktop_id,
    o.date,
    NULL::timestamp with time zone AS captured_at,
    NULL::timestamp with time zone AS created_at,
    o.genus,
    o.species,
    o.common_name,
    o.author,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'exact'::text) THEN o.location
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['fuzzed'::text, 'region'::text])) THEN COALESCE(pr.label, o.country_code)
            ELSE NULL::text
        END AS location,
    o.habitat,
    o.notes,
    o.uncertain,
    o.location_public,
    o.visibility,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_latitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_latitude
        END AS gps_latitude,
        CASE
            WHEN (COALESCE(o.location_precision, 'exact'::text) = 'fuzzed'::text) THEN (round((o.gps_longitude)::numeric, 2))::double precision
            WHEN (COALESCE(o.location_precision, 'exact'::text) = ANY (ARRAY['region'::text, 'hidden'::text])) THEN NULL::double precision
            ELSE o.gps_longitude
        END AS gps_longitude,
    o.source_type,
    o.spore_data_visibility,
    CASE WHEN o.user_id = auth.uid() THEN o.image_key END AS image_key,
    CASE WHEN o.user_id = auth.uid() THEN o.thumb_key END AS thumb_key,
    o.is_draft,
    o.location_precision,
    o.ai_selected_service,
    o.ai_selected_taxon_id,
    o.ai_selected_scientific_name,
    o.ai_selected_probability,
    NULL::timestamp with time zone AS ai_selected_at,
    o.red_list_category,
    o.red_list_categories_json,
    media.image_id,
    media.media_version,
    media.full_media_url,
    media.thumb_media_url,
    o.selected_sporely_taxon_id,
    o.taxon_identity_state,
    o.taxon_identity_source_system,
    o.taxon_identity_namespace,
    o.taxon_identity_external_id,
    o.taxon_identity_raw_external_id
   FROM ((observations o
     LEFT JOIN public_regions pr ON ((pr.id = o.region_id)))
     LEFT JOIN LATERAL _stage2b_observation_primary_media(o.id, o.image_key) media(image_id, media_version, full_media_url, thumb_media_url) ON (true))
  WHERE ((COALESCE(o.visibility, 'public'::text) = ANY (ARRAY['friends'::text, 'public'::text])) AND (NOT COALESCE(o.is_draft, false)) AND current_user_is_friend_with(o.user_id) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

CREATE OR REPLACE VIEW public.observation_images_community_view WITH (security_barrier = true) AS
SELECT oi.id,
    oi.observation_id,
    oi.user_id,
    CASE WHEN o.user_id = auth.uid() THEN oi.storage_path END AS storage_path,
    oi.sort_order,
    oi.image_type,
    oi.micro_category,
    oi.objective_name,
    oi.scale_microns_per_pixel,
    oi.mount_medium,
    oi.stain,
    oi.sample_type,
    oi.contrast,
    oi.ai_crop_x1,
    oi.ai_crop_y1,
    oi.ai_crop_x2,
    oi.ai_crop_y2,
    oi.ai_crop_source_w,
    oi.ai_crop_source_h,
    oi.ai_crop_is_custom,
    oi.crop_mode,
    oi.scale_bar_x1,
    oi.scale_bar_y1,
    oi.scale_bar_x2,
    oi.scale_bar_y2,
    oi.source_width,
    oi.source_height,
    oi.stored_width,
    oi.stored_height,
    NULL::timestamp with time zone AS created_at,
    oi.calibration_uuid,
    NULL::timestamp with time zone AS deleted_at,
    o.user_id AS observation_user_id,
    o.visibility AS observation_visibility,
    o.is_draft AS observation_is_draft,
    o.spore_data_visibility AS observation_spore_data_visibility,
    oi.id AS image_id,
    oi.media_version,
    build_worker_media_url(oi.id, 'full'::text, oi.media_version) AS full_media_url,
    build_worker_media_url(oi.id, 'thumb'::text, oi.media_version) AS thumb_media_url
   FROM (observation_images oi
     JOIN observations o ON ((o.id = oi.observation_id)))
  WHERE ((oi.deleted_at IS NULL) AND (oi.purged_at IS NULL) AND (oi.storage_path IS NOT NULL) AND (btrim(oi.storage_path) <> ''::text) AND (NOT COALESCE(o.is_draft, false)) AND can_read_observation(o.user_id, o.visibility) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

-- observation_identifications_community_view: AI identification runs right
-- after capture, so created_at/updated_at reveal the time of day like
-- ai_selected_at. This view already has an owner branch and is the only
-- identification read sporely-web uses, so the owner keeps the real values
-- here; everyone else gets NULL.
CREATE OR REPLACE VIEW public.observation_identifications_community_view WITH (security_barrier = true) AS
SELECT oi.id,
    oi.observation_id,
    oi.service,
    oi.status,
    safe_results.results,
    oi.top_scientific_name,
    oi.top_vernacular_name,
    oi.top_taxon_id,
    oi.top_probability,
    oi.top_species_url,
    oi.top_redlist_category,
    oi.top_redlist_status,
    oi.top_redlist_source,
    CASE WHEN o.user_id = auth.uid() THEN oi.created_at END AS created_at,
    CASE WHEN o.user_id = auth.uid() THEN oi.updated_at END AS updated_at
   FROM ((observation_identifications oi
     JOIN observations o ON ((o.id = oi.observation_id)))
     CROSS JOIN LATERAL ( SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('rank', COALESCE((candidate.value -> 'rank'::text), to_jsonb((candidate.ordinality)::integer)), 'service', COALESCE((candidate.value -> 'service'::text), to_jsonb(oi.service)), 'taxon_id', COALESCE((candidate.value -> 'taxon_id'::text), (candidate.value -> 'taxonId'::text)), 'scientific_name', COALESCE((candidate.value -> 'scientific_name'::text), (candidate.value -> 'scientificName'::text)), 'vernacular_name', COALESCE((candidate.value -> 'vernacular_name'::text), (candidate.value -> 'vernacularName'::text)), 'probability', COALESCE((candidate.value -> 'probability'::text), (candidate.value -> 'score'::text)), 'species_url', COALESCE((candidate.value -> 'species_url'::text), (candidate.value -> 'speciesUrl'::text)), 'redlist_category', COALESCE((candidate.value -> 'redlist_category'::text), (candidate.value -> 'redlistCategory'::text)), 'redlist_status', COALESCE((candidate.value -> 'redlist_status'::text), (candidate.value -> 'redlistStatus'::text)), 'redlist_source', COALESCE((candidate.value -> 'redlist_source'::text), (candidate.value -> 'redlistSource'::text)), 'picture_url', COALESCE((candidate.value -> 'picture_url'::text), (candidate.value -> 'pictureUrl'::text), (candidate.value -> 'photo_url'::text), (candidate.value -> 'photoUrl'::text), (candidate.value -> 'image_url'::text), (candidate.value -> 'imageUrl'::text), (candidate.value -> 'thumbnail_url'::text), (candidate.value -> 'thumbnailUrl'::text)), 'external_ids', NULLIF(jsonb_strip_nulls(jsonb_build_object('gbif', ((candidate.value -> 'external_ids'::text) -> 'gbif'::text), 'inat', ((candidate.value -> 'external_ids'::text) -> 'inat'::text), 'nbic', ((candidate.value -> 'external_ids'::text) -> 'nbic'::text))), '{}'::jsonb))) ORDER BY candidate.ordinality), '[]'::jsonb) AS results
           FROM jsonb_array_elements(
                CASE
                    WHEN (jsonb_typeof(oi.results) = 'array'::text) THEN oi.results
                    ELSE '[]'::jsonb
                END) WITH ORDINALITY candidate(value, ordinality)) safe_results)
  WHERE (((o.user_id = auth.uid()) OR ((NOT COALESCE(o.is_draft, false)) AND can_read_observation(o.user_id, o.visibility))) AND (NOT (EXISTS ( SELECT 1
           FROM profiles p
          WHERE ((p.id = o.user_id) AND (p.is_banned = true))))) AND (NOT current_user_is_blocked_with(o.user_id)));

-- search_public_observation_images (anon RPC): the legacy thumbUrl /
-- previewUrl / fullUrl were media.sporely.no/<storage key>, and keys embed
-- the upload epoch-ms. They are now NULL; clients use the worker URLs
-- thumbMediaUrl / fullMediaUrl (/m/<image_id>/<variant>?v=<n>, no key).
-- Column list and types are unchanged.
CREATE OR REPLACE FUNCTION public.search_public_observation_images(p_observation_ids bigint[] DEFAULT NULL::bigint[])
 RETURNS TABLE("observationId" bigint, "imageId" bigint, "sortOrder" integer, "imageType" text, width integer, height integer, "thumbUrl" text, "previewUrl" text, "fullUrl" text, "aiCropX1" double precision, "aiCropY1" double precision, "aiCropX2" double precision, "aiCropY2" double precision, "aiCropSourceW" integer, "aiCropSourceH" integer, "aiCropIsCustom" boolean, "scaleMicronsPerPixel" double precision, "mediaVersion" bigint, "fullMediaUrl" text, "thumbMediaUrl" text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH visible_images AS (
    SELECT
      o.id AS observation_id,
      i.id AS image_id,
      i.sort_order,
      i.image_type,
      coalesce(i.stored_width, i.source_width) AS width,
      coalesce(i.stored_height, i.source_height) AS height,
      nullif(regexp_replace(btrim(i.storage_path, '/'), '/[^/]+$', '', ''), btrim(i.storage_path, '/')) AS storage_dir,
      regexp_replace(btrim(i.storage_path, '/'), '^.*/', '') AS file_name,
      i.ai_crop_x1, i.ai_crop_y1, i.ai_crop_x2, i.ai_crop_y2,
      i.ai_crop_source_w, i.ai_crop_source_h,
      coalesce(i.ai_crop_is_custom, false) AS ai_crop_is_custom,
      coalesce(i.storage_exif_safe, false) AS storage_exif_safe,
      i.scale_microns_per_pixel,
      i.media_version,
      i.created_at
    FROM public.observations o
    JOIN public.observation_images i ON i.observation_id = o.id
    WHERE o.visibility = 'public'
      AND NOT coalesce(o.is_draft, false)
      AND o.id = ANY (coalesce(p_observation_ids, '{}'::bigint[]))
      AND i.deleted_at IS NULL
      AND i.purged_at IS NULL
      AND i.storage_path IS NOT NULL
      AND btrim(i.storage_path) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = o.user_id AND p.is_banned = true
      )
      AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE)
  ), prepared AS (
    SELECT
      vi.*,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        'thumb_', regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS thumb_path,
      concat(
        CASE WHEN vi.storage_dir IS NULL THEN '' ELSE vi.storage_dir || '/' END,
        regexp_replace(vi.file_name, '^(?:thumb_|medium_|small_|cards_)+', '', 'i')
      ) AS full_path
    FROM visible_images vi
  )
  SELECT
    p.observation_id AS "observationId",
    p.image_id AS "imageId",
    p.sort_order AS "sortOrder",
    p.image_type AS "imageType",
    p.width AS "width",
    p.height AS "height",
    NULL::text AS "thumbUrl",
    NULL::text AS "previewUrl",
    NULL::text AS "fullUrl",
    p.ai_crop_x1 AS "aiCropX1",
    p.ai_crop_y1 AS "aiCropY1",
    p.ai_crop_x2 AS "aiCropX2",
    p.ai_crop_y2 AS "aiCropY2",
    p.ai_crop_source_w AS "aiCropSourceW",
    p.ai_crop_source_h AS "aiCropSourceH",
    p.ai_crop_is_custom AS "aiCropIsCustom",
    p.scale_microns_per_pixel AS "scaleMicronsPerPixel",
    p.media_version AS "mediaVersion",
    public.build_worker_media_url(p.image_id, 'full', p.media_version) AS "fullMediaUrl",
    public.build_worker_media_url(p.image_id, 'thumb', p.media_version) AS "thumbMediaUrl"
  FROM prepared p
  ORDER BY p.observation_id, p.sort_order NULLS LAST, p.created_at DESC NULLS LAST, p.image_id DESC
$function$;

-- Public species RPCs passed legacy.* through, including
-- representativeThumbUrl = media.sporely.no/<storage key> (key embeds upload
-- time). It is now NULL; representativeThumbMediaUrl (worker URL) remains.
-- get_public_observation sporePoints[].cropUrl was
-- media.sporely.no/<spore_measurements.thumb_key>, the microscope image thumb
-- key. It is now the worker thumb URL of the point's imageId, NULL when that
-- image is gone. Return types unchanged.
CREATE OR REPLACE FUNCTION public.get_public_species(p_species_slug text)
 RETURNS TABLE("speciesSlug" text, genus text, species text, "speciesName" text, "commonName" text, "observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" date, "lastObservedOn" date, countries jsonb, regions jsonb, "representativeThumbUrl" text, "recentObservationIds" bigint[], "representativeImageId" bigint, "representativeMediaVersion" bigint, "representativeThumbMediaUrl" text, "taxonIdentity" jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH legacy AS MATERIALIZED (
    SELECT * FROM public._get_public_species_stage6f(p_species_slug)
  ), identities AS MATERIALIZED (
    SELECT identity.*
      FROM private.public_species_taxon_identities(
        (SELECT pg_catalog.array_agg(legacy."speciesSlug") FROM legacy)
      ) identity
  )
  SELECT legacy."speciesSlug",
         legacy.genus,
         legacy.species,
         legacy."speciesName",
         legacy."commonName",
         legacy."observationCount",
         legacy."microscopyObservationCount",
         legacy."sporeMeasurementCount",
         legacy."firstObservedOn",
         legacy."lastObservedOn",
         legacy.countries,
         legacy.regions,
         NULL::text AS "representativeThumbUrl",
         legacy."recentObservationIds",
         legacy."representativeImageId",
         legacy."representativeMediaVersion",
         legacy."representativeThumbMediaUrl",
         identities.taxon_identity AS "taxonIdentity"
    FROM legacy
    LEFT JOIN identities ON identities.species_slug = legacy."speciesSlug"
$function$;

CREATE OR REPLACE FUNCTION public.search_public_species(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_genus text DEFAULT NULL::text, p_query text DEFAULT NULL::text)
 RETURNS TABLE("speciesSlug" text, genus text, species text, "speciesName" text, "commonName" text, "observationCount" bigint, "microscopyObservationCount" bigint, "sporeMeasurementCount" bigint, "firstObservedOn" date, "lastObservedOn" date, countries jsonb, regions jsonb, "representativeThumbUrl" text, "representativeImageId" bigint, "representativeMediaVersion" bigint, "representativeThumbMediaUrl" text, "taxonIdentity" jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH legacy AS MATERIALIZED (
    SELECT * FROM public._search_public_species_stage6f(
      p_limit, p_offset, p_genus, p_query
    )
  ), identities AS MATERIALIZED (
    SELECT identity.*
      FROM private.public_species_taxon_identities(
        (SELECT pg_catalog.array_agg(legacy."speciesSlug") FROM legacy)
      ) identity
  )
  SELECT legacy."speciesSlug",
         legacy.genus,
         legacy.species,
         legacy."speciesName",
         legacy."commonName",
         legacy."observationCount",
         legacy."microscopyObservationCount",
         legacy."sporeMeasurementCount",
         legacy."firstObservedOn",
         legacy."lastObservedOn",
         legacy.countries,
         legacy.regions,
         NULL::text AS "representativeThumbUrl",
         legacy."representativeImageId",
         legacy."representativeMediaVersion",
         legacy."representativeThumbMediaUrl",
         identities.taxon_identity AS "taxonIdentity"
    FROM legacy
    LEFT JOIN identities ON identities.species_slug = legacy."speciesSlug"
   ORDER BY legacy."observationCount" DESC,
            legacy."lastObservedOn" DESC,
            legacy."speciesName" ASC,
            legacy."speciesSlug" ASC
$function$;

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
    CASE
      WHEN legacy."sporePoints" IS NULL OR jsonb_typeof(legacy."sporePoints") <> 'array'
        THEN legacy."sporePoints"
      ELSE (
        SELECT coalesce(jsonb_agg(
                 CASE
                   WHEN pt.value ? 'cropUrl' THEN
                     (pt.value - 'cropUrl') || jsonb_strip_nulls(jsonb_build_object(
                       'cropUrl', public.build_worker_media_url(oi.id, 'thumb', oi.media_version)))
                   ELSE pt.value
                 END
                 ORDER BY pt.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements(legacy."sporePoints") WITH ORDINALITY pt(value, ordinality)
        LEFT JOIN public.observation_images oi
          ON oi.id = CASE WHEN (pt.value->>'imageId') ~ '^[0-9]+$' THEN (pt.value->>'imageId')::bigint END
      )
    END AS "sporePoints",
    CASE
      WHEN legacy."sporeMosaic" IS NULL OR mosaic.id IS NULL THEN legacy."sporeMosaic"
      ELSE legacy."sporeMosaic" || jsonb_build_object(
        'mosaicId', mosaic.id,
        'mosaicMediaVersion', mosaic.media_version,
        'mosaicMediaUrl', public.build_worker_mosaic_url(mosaic.id, mosaic.media_version)
      )
    END AS "sporeMosaic",
    legacy."contrastMethod",
    legacy."mountReagent",
    legacy."sampleType",
    legacy."sampleSource",
    legacy."prepSummary",
    legacy."mapLat",
    legacy."mapLon"
  FROM public._get_public_observation_stage2a(p_observation_id) legacy
  LEFT JOIN LATERAL (
    SELECT sm.id, sm.media_version
    FROM public.spore_measurement_mosaics sm
    WHERE sm.observation_id = legacy.id
    ORDER BY sm.version DESC, sm.id DESC
    LIMIT 1
  ) mosaic ON true
$function$;

COMMIT;
