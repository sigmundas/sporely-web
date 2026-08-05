-- Lock down non-owner access to the three observation-sync tables and to
-- every non-owner read surface layered on top of them:
--   * public.observations
--   * public.observation_images
--   * public.spore_measurements
--   * public.observations_community_view
--   * public.observations_friend_view
--   * public.observations_follow_view
--   * public.observation_images_community_view  (rebuilt community-safe)
-- plus default-privilege hygiene on the `public` schema.
--
-- Motivation (pre-fix state observed against replayed migrations through
-- 20260802130000)
-- ----------------------------------------------------------------------
--   1. anon and authenticated held GRANT ALL on every raw table (SELECT/
--      INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER).
--   2. A permissive SELECT policy scoped to role `{}` (PUBLIC — every role
--      including anon) gated only on `NOT is_draft AND
--      can_read_observation(user_id, visibility)`. `can_read_observation`
--      returns TRUE for anon on any public non-banned non-blocked row, so
--      `anon` could `SELECT * FROM public.observations …` and retrieve
--      raw exact GPS, private_comment, ai_state_json, notes and every
--      other raw column. Same shape on observation_images and
--      spore_measurements.
--   3. `observations_community_view` and `observations_friend_view` are
--      auto-updatable simple views and held GRANT ALL (incl. INSERT /
--      UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER) to anon and
--      authenticated. Because the views are owned by `postgres` and have
--      no `security_invoker`, DML through them ran with owner rights and
--      bypassed RLS on the base tables. This was reproduced: as `anon`
--      a single `UPDATE public.observations_community_view SET species =
--      'HACKED_BY_ANON' …` mutated the raw row.
--   4. `observation_images_community_view` mixed owner-private and
--      community-safe projections: it returned `original_storage_path`,
--      `deleted_at`, and rows for soft-deleted (`deleted_at IS NOT NULL`)
--      and purged (`purged_at IS NOT NULL`) images to every non-owner
--      who could `can_read_observation` — leaking storage paths for
--      tombstoned uploads and internal upload metadata.
--   5. `pg_default_acl` for role `postgres` in schema `public` grants
--      `ALL` on future tables and sequences to `anon` and `authenticated`,
--      meaning any migration that creates a new object silently
--      republishes the exposure fixed above.
--
-- Behavioural contract after this migration
-- -----------------------------------------
--   * anon holds no privileges on any of the three raw tables, on their
--     identity sequences, or on any of the four non-owner read views.
--   * authenticated holds exactly SELECT/INSERT/UPDATE/DELETE on each raw
--     table — no TRUNCATE/REFERENCES/TRIGGER — and holds only SELECT on
--     each non-owner read view.
--   * Every remaining RLS policy on the three raw tables is scoped to
--     role `authenticated` and gates on `auth.uid() = user_id`
--     (owner-only). No permissive PUBLIC-role policy remains.
--   * `observation_images_community_view` is rebuilt as a strict
--     community-safe projection: no original path, no tombstoned rows,
--     no purged rows, no owner branch. Owners read tombstones and
--     originals directly from `public.observation_images` under RLS.
--   * The four non-owner read views carry `security_barrier = true` to
--     prevent leaky WHERE-clause predicates from bypassing the view's
--     own filter.
--   * Default privileges for role `postgres` in `public` no longer grant
--     tables/sequences/functions to `anon` or `authenticated`. Future
--     migrations must GRANT explicitly.
--   * service_role continues to hold ALL on every raw table + view; its
--     `bypassrls` attribute makes RLS a no-op for admin-ops / delete-
--     account edge functions and for the R2 upload worker.
--
-- Idempotency
-- -----------
-- Every policy is DROPped with `IF EXISTS` before recreation; view
-- definitions use `CREATE OR REPLACE`. Grants are last-writer-wins.
-- Safe to replay against any schema state at or after 20260802130000.
--
-- Deployment order
-- ----------------
-- Deployable independently of application releases. See the companion
-- `src/images.js` patch: `fetchObservationImageRows` now merges rows
-- from the owner-only raw table with the community-safe view so
-- mixed-ownership queries (e.g. the comments-panel obs enrichment on
-- `home.js`) continue to return the caller's own images alongside
-- community-visible peers. The patch is backwards-compatible with the
-- pre-lockdown schema: it can ship before, with, or after the migration.

BEGIN;

-- =============================================================
-- 1. observations
-- =============================================================

DROP POLICY IF EXISTS "observations: friends read public" ON public.observations;
DROP POLICY IF EXISTS "observations: owner full"          ON public.observations;

DROP POLICY IF EXISTS "phase7_observations_read" ON public.observations;
CREATE POLICY "phase7_observations_read"
  ON public.observations
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- =============================================================
-- 2. observation_images
-- =============================================================

DROP POLICY IF EXISTS "observation_images: friends read"                ON public.observation_images;
DROP POLICY IF EXISTS "observation_images friend read"                  ON public.observation_images;
DROP POLICY IF EXISTS "observation_images: owner select including deleted"
                                                                        ON public.observation_images;

DROP POLICY IF EXISTS "phase7_observation_images_read" ON public.observation_images;
CREATE POLICY "phase7_observation_images_read"
  ON public.observation_images
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- =============================================================
-- 3. spore_measurements
--    Owner SELECT is unconditional (auth.uid() = user_id); it must
--    not be coupled to observation_images.deleted_at IS NULL, so
--    the owner retains the ability to read and clean up
--    measurements attached to a tombstoned image.
-- =============================================================

DROP POLICY IF EXISTS "spore_measurements: friends read"          ON public.spore_measurements;
DROP POLICY IF EXISTS "spore_measurements: owner full"            ON public.spore_measurements;
DROP POLICY IF EXISTS "Users can view their own measurements"     ON public.spore_measurements;
DROP POLICY IF EXISTS "Users can insert their own measurements"   ON public.spore_measurements;
DROP POLICY IF EXISTS "Users can update their own measurements"   ON public.spore_measurements;
DROP POLICY IF EXISTS "Users can delete their own measurements"   ON public.spore_measurements;

DROP POLICY IF EXISTS "spore_measurements_owner_read"    ON public.spore_measurements;
DROP POLICY IF EXISTS "spore_measurements_owner_insert"  ON public.spore_measurements;
DROP POLICY IF EXISTS "spore_measurements_owner_update"  ON public.spore_measurements;
DROP POLICY IF EXISTS "spore_measurements_owner_delete"  ON public.spore_measurements;

CREATE POLICY "spore_measurements_owner_read"
  ON public.spore_measurements
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "spore_measurements_owner_insert"
  ON public.spore_measurements
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "spore_measurements_owner_update"
  ON public.spore_measurements
  FOR UPDATE
  TO authenticated
  USING       (user_id = auth.uid())
  WITH CHECK  (user_id = auth.uid());

CREATE POLICY "spore_measurements_owner_delete"
  ON public.spore_measurements
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- =============================================================
-- 4. Raw-table privileges.
-- =============================================================

REVOKE ALL ON TABLE public.observations         FROM anon;
REVOKE ALL ON TABLE public.observation_images   FROM anon;
REVOKE ALL ON TABLE public.spore_measurements   FROM anon;

REVOKE ALL ON TABLE public.observations         FROM authenticated;
REVOKE ALL ON TABLE public.observation_images   FROM authenticated;
REVOKE ALL ON TABLE public.spore_measurements   FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.observations       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.observation_images TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spore_measurements TO authenticated;

-- service_role continues to hold ALL from the baseline grant.

-- =============================================================
-- 5. Identity sequences.
-- =============================================================

REVOKE ALL ON SEQUENCE public.observations_id_seq         FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.observation_images_id_seq   FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.spore_measurements_id_seq   FROM anon, authenticated;

-- =============================================================
-- 6. Non-owner read views: revoke DML + admin privileges, keep
--    only SELECT for anon/authenticated; enable security_barrier
--    so leaky WHERE predicates cannot bypass the view's filter.
-- =============================================================

REVOKE ALL ON TABLE public.observations_community_view       FROM anon, authenticated;
REVOKE ALL ON TABLE public.observations_friend_view          FROM anon, authenticated;
REVOKE ALL ON TABLE public.observations_follow_view          FROM anon, authenticated;
REVOKE ALL ON TABLE public.observation_images_community_view FROM anon, authenticated;

GRANT SELECT ON public.observations_community_view       TO anon, authenticated;
GRANT SELECT ON public.observations_friend_view          TO anon, authenticated;
GRANT SELECT ON public.observations_follow_view          TO anon, authenticated;
GRANT SELECT ON public.observation_images_community_view TO anon, authenticated;

ALTER VIEW public.observations_community_view       SET (security_barrier = true);
ALTER VIEW public.observations_friend_view          SET (security_barrier = true);
ALTER VIEW public.observations_follow_view          SET (security_barrier = true);
-- observation_images_community_view: security_barrier is set inline
-- when it is rebuilt below.

-- =============================================================
-- 6b. Rebuild the three non-owner observation views with a
--     unified location model that covers all four precision
--     levels (`exact`, `fuzzed`, `region`, `hidden`). Prior:
--       * community_view already NULLed gps for region/hidden
--         but still projected raw `location` text — every
--         non-owner surface leaks the raw address / free-text.
--       * friend_view and follow_view only special-cased
--         `fuzzed`; region and hidden fell through to raw
--         gps_latitude / gps_longitude AND raw `location`.
--
--     Post-fix invariants on every non-owner observation
--     surface:
--       * exact  → location = o.location; coords exact.
--       * fuzzed → location = safe region-or-country label;
--                  coords rounded to 2 decimals.
--       * region → location = public_regions.label (fall back
--                  to country_code); coords NULL.
--       * hidden → location NULL; coords NULL.
--
--     Column names, types and order are unchanged, so
--     CREATE OR REPLACE VIEW does not require a DROP.
-- =============================================================

CREATE OR REPLACE VIEW public.observations_community_view
  WITH (security_barrier = true) AS
SELECT
  o.id, o.user_id, o.desktop_id, o.date, o.captured_at, o.created_at,
  o.genus, o.species, o.common_name, o.author,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'exact'  THEN o.location
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN COALESCE(pr.label, o.country_code)
    WHEN COALESCE(o.location_precision,'exact') = 'region' THEN COALESCE(pr.label, o.country_code)
    ELSE NULL
  END AS location,
  o.habitat, o.notes, o.uncertain, o.location_public, o.visibility,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_latitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_latitude
  END AS gps_latitude,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_longitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_longitude
  END AS gps_longitude,
  o.source_type, o.spore_data_visibility, o.image_key, o.thumb_key,
  o.is_draft, o.location_precision,
  o.ai_selected_service, o.ai_selected_taxon_id, o.ai_selected_scientific_name,
  o.ai_selected_probability, o.ai_selected_at,
  CASE
    WHEN COALESCE(o.spore_data_visibility,'public') = 'public' THEN o.spore_statistics
    ELSE NULL::jsonb
  END AS spore_statistics
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
WHERE COALESCE(o.visibility,'public') = 'public'
  AND NOT COALESCE(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observations_friend_view
  WITH (security_barrier = true) AS
SELECT
  o.id, o.user_id, o.desktop_id, o.date, o.captured_at, o.created_at,
  o.genus, o.species, o.common_name, o.author,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'exact'  THEN o.location
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN COALESCE(pr.label, o.country_code)
    WHEN COALESCE(o.location_precision,'exact') = 'region' THEN COALESCE(pr.label, o.country_code)
    ELSE NULL
  END AS location,
  o.habitat, o.notes, o.uncertain, o.location_public, o.visibility,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_latitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_latitude
  END AS gps_latitude,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_longitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_longitude
  END AS gps_longitude,
  o.source_type, o.spore_data_visibility, o.image_key, o.thumb_key,
  o.is_draft, o.location_precision
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
WHERE COALESCE(o.visibility,'public') = ANY (ARRAY['friends','public'])
  AND NOT COALESCE(o.is_draft, false)
  AND public.are_friends(auth.uid(), o.user_id)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

CREATE OR REPLACE VIEW public.observations_follow_view
  WITH (security_barrier = true) AS
SELECT DISTINCT
  o.id, o.user_id, o.desktop_id, o.date, o.captured_at, o.created_at,
  o.genus, o.species, o.common_name, o.author,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'exact'  THEN o.location
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN COALESCE(pr.label, o.country_code)
    WHEN COALESCE(o.location_precision,'exact') = 'region' THEN COALESCE(pr.label, o.country_code)
    ELSE NULL
  END AS location,
  o.habitat, o.notes, o.uncertain, o.location_public, o.visibility,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_latitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_latitude
  END AS gps_latitude,
  CASE
    WHEN COALESCE(o.location_precision,'exact') = 'fuzzed' THEN round(o.gps_longitude::numeric, 2)::double precision
    WHEN COALESCE(o.location_precision,'exact') IN ('region','hidden') THEN NULL::double precision
    ELSE o.gps_longitude
  END AS gps_longitude,
  o.source_type, o.spore_data_visibility, o.image_key, o.thumb_key,
  o.is_draft, o.location_precision
FROM public.observations o
JOIN public.follows f ON f.user_id = auth.uid()
  AND ( (f.target_type = 'user'        AND f.target_id = o.user_id::text)
     OR (f.target_type = 'observation' AND f.target_id = o.id::text)
     OR (f.target_type = 'genus'       AND lower(f.target_id) = lower(COALESCE(o.genus,'')))
     OR (f.target_type = 'species'     AND lower(f.target_id) = lower(TRIM(BOTH FROM concat_ws(' ', o.genus, o.species)))) )
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
WHERE public.can_read_observation(o.user_id, o.visibility)
  AND NOT COALESCE(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

-- =============================================================
-- 7. Rebuild observation_images_community_view as a strict
--    community-safe projection.
--
--    Excluded from the projection compared to the previous
--    definition:
--      * original_storage_path  — raw uploaded key
--      * original_filename      — may embed owner PII
--      * notes                  — owner-editorial free text
--      * measure_color          — owner UI setting
--      * gps_source             — internal marker
--      * desktop_id             — internal id
--      * upload_mode            — internal
--      * stored_bytes           — internal storage metric
--      * resample_scale_factor  — internal
--
--    Excluded from the row set:
--      * soft-deleted rows (oi.deleted_at IS NOT NULL)
--      * purged rows       (oi.purged_at  IS NOT NULL)
--      * drafts            (o.is_draft)
--      * unauthorized observations (can_read_observation false)
--      * banned owners
--      * blocked pairings
--      * the previous owner branch (o.user_id = auth.uid()) —
--        owners read tombstones and originals via the raw table.
--
--    `deleted_at` is retained as a literal NULL column so existing
--    consumers that filter `.is('deleted_at', null)` continue to
--    compile; the value is always NULL by construction.
-- =============================================================

-- CREATE OR REPLACE cannot drop columns from an existing view definition,
-- so drop and recreate. No object depends on this view (the SECURITY
-- DEFINER public-read RPCs read the base tables directly).
DROP VIEW IF EXISTS public.observation_images_community_view;

CREATE VIEW public.observation_images_community_view
  WITH (security_barrier = true) AS
SELECT
  oi.id,
  oi.observation_id,
  oi.user_id,
  oi.storage_path,
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
  oi.created_at,
  oi.calibration_uuid,
  NULL::timestamptz                 AS deleted_at,
  o.user_id                         AS observation_user_id,
  o.visibility                      AS observation_visibility,
  o.is_draft                        AS observation_is_draft,
  o.spore_data_visibility           AS observation_spore_data_visibility
FROM public.observation_images oi
JOIN public.observations o ON o.id = oi.observation_id
WHERE oi.deleted_at IS NULL
  AND oi.purged_at  IS NULL
  AND NOT COALESCE(o.is_draft, false)
  AND public.can_read_observation(o.user_id, o.visibility)
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = o.user_id AND p.is_banned = true
  )
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

ALTER VIEW public.observation_images_community_view OWNER TO postgres;

REVOKE ALL ON TABLE public.observation_images_community_view FROM anon, authenticated;
GRANT SELECT ON public.observation_images_community_view TO anon, authenticated;
GRANT ALL    ON public.observation_images_community_view TO service_role;

-- =============================================================
-- 8. Default privileges: stop role `postgres` from auto-granting
--    ALL on future tables/sequences/functions in schema `public`
--    to anon and authenticated. Future migrations must GRANT
--    explicitly.
-- =============================================================

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- PostgreSQL grants EXECUTE on newly-created functions to role PUBLIC
-- by default. That grant is CLUSTER-wide and cannot be removed by a
-- schema-scoped ALTER DEFAULT PRIVILEGES statement. Issue the
-- non-schema-scoped variant so future functions created by role
-- `postgres` require an explicit GRANT to be callable by PUBLIC / anon
-- / authenticated. Existing RPC EXECUTE grants (concrete GRANT
-- statements in earlier migrations) are unaffected — this only
-- changes the default applied to future function objects.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- `supabase_admin` (bootstrap role) also carries broad default_acl
-- entries in schema `public`. `ALTER DEFAULT PRIVILEGES FOR ROLE
-- supabase_admin` requires membership in that role, which the
-- migration runner (`postgres`) does not possess in this
-- environment. Migrations run as `postgres`; the postgres-role
-- default is what governs new objects they create. The
-- supabase_admin default is out of scope for Stage 1 and is
-- documented for follow-up.

-- =============================================================
-- 9. Community spore RPCs — enforce the Stage 1 invariant that
--    non-owner spore access must satisfy BOTH the applicable
--    observation-visibility rule (`can_read_observation`) AND
--    spore_data_visibility, AND must exclude measurements on
--    deleted / purged images.
--
--    Pre-fix, three RPCs violated this: they gated only on
--    `NOT is_draft AND can_access_spore_data(...)`, so a caller
--    could read spore data attached to a PRIVATE observation as
--    long as its spore_data_visibility was 'public' — a leak of
--    spore geometry from otherwise-hidden observations. Two of
--    the three RPCs also failed to exclude measurements on
--    soft-deleted or purged images.
--
--    The bodies below are copied verbatim from the current
--    definitions with the missing predicates added:
--      * `AND public.can_read_observation(o.user_id, o.visibility)`
--        in the WHERE clause;
--      * `AND i.deleted_at IS NULL AND i.purged_at IS NULL`
--        on the observation_images join.
--    Return signatures are unchanged; CREATE OR REPLACE
--    suffices.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_community_spore_dataset(p_observation_id bigint)
 RETURNS TABLE(dataset_type text, observation_id bigint, genus text, species text, common_name text, contributor_label text, observed_on date, measurement_count bigint, image_count bigint, mount_media text[], stains text[], sample_types text[], contrasts text[], objectives text[], scale_min double precision, scale_max double precision, qc_flags jsonb, length_min double precision, length_p05 double precision, length_p50 double precision, length_p95 double precision, length_max double precision, length_avg double precision, width_min double precision, width_p05 double precision, width_p50 double precision, width_p95 double precision, width_max double precision, width_avg double precision, q_min double precision, q_p50 double precision, q_max double precision, q_avg double precision, measurements_json jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH filtered AS (
    SELECT
      o.id AS observation_id, o.user_id, o.genus, o.species, o.common_name, o.date, o.author,
      i.id AS image_id, i.mount_medium, i.stain, i.sample_type, i.contrast, i.objective_name,
      i.scale_microns_per_pixel,
      m.id AS measurement_id, m.length_um, m.width_um,
      m.p1_x, m.p1_y, m.p2_x, m.p2_y, m.p3_x, m.p3_y, m.p4_x, m.p4_y, m.measured_at
    FROM public.observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
     AND i.deleted_at IS NULL
     AND i.purged_at  IS NULL
    JOIN public.spore_measurements m ON m.image_id = i.id
    WHERE o.id = p_observation_id
      AND NOT coalesce(o.is_draft, false)
      AND public.can_read_observation(o.user_id, o.visibility)
      AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
      AND m.length_um IS NOT NULL AND m.width_um IS NOT NULL
      AND (m.measurement_type IS NULL OR m.measurement_type = ''
           OR lower(m.measurement_type) IN ('manual','spore','spores'))
  )
  SELECT
    'observation'::text AS dataset_type,
    max(f.observation_id) AS observation_id,
    max(f.genus) AS genus, max(f.species) AS species, max(f.common_name) AS common_name,
    public.community_contributor_label((array_agg(f.user_id))[1], max(f.author)) AS contributor_label,
    max(f.date) AS observed_on,
    count(f.measurement_id) AS measurement_count,
    count(distinct f.image_id) AS image_count,
    array_remove(array_agg(distinct nullif(f.mount_medium, '')), NULL) AS mount_media,
    array_remove(array_agg(distinct nullif(f.stain, '')), NULL) AS stains,
    array_remove(array_agg(distinct nullif(f.sample_type, '')), NULL) AS sample_types,
    array_remove(array_agg(distinct nullif(f.contrast, '')), NULL) AS contrasts,
    array_remove(array_agg(distinct nullif(f.objective_name, '')), NULL) AS objectives,
    min(f.scale_microns_per_pixel) AS scale_min, max(f.scale_microns_per_pixel) AS scale_max,
    jsonb_build_object(
      'has_mount',           bool_or(nullif(f.mount_medium, '') IS NOT NULL),
      'has_stain',           bool_or(nullif(f.stain, '') IS NOT NULL),
      'has_sample_type',     bool_or(nullif(f.sample_type, '') IS NOT NULL),
      'has_contrast',        bool_or(nullif(f.contrast, '') IS NOT NULL),
      'has_objective',       bool_or(nullif(f.objective_name, '') IS NOT NULL),
      'has_scale',           bool_or(f.scale_microns_per_pixel IS NOT NULL),
      'has_point_geometry',  bool_or(f.p1_x IS NOT NULL OR f.p1_y IS NOT NULL OR f.p2_x IS NOT NULL OR f.p2_y IS NOT NULL),
      'measurement_count',   count(f.measurement_id)
    ) AS qc_flags,
    min(f.length_um) AS length_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p95,
    max(f.length_um) AS length_max, avg(f.length_um) AS length_avg,
    min(f.width_um) AS width_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p95,
    max(f.width_um) AS width_max, avg(f.width_um) AS width_avg,
    min(f.length_um / nullif(f.width_um, 0)) AS q_min,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY (f.length_um / nullif(f.width_um, 0)))::double precision AS q_p50,
    max(f.length_um / nullif(f.width_um, 0)) AS q_max,
    avg(f.length_um / nullif(f.width_um, 0)) AS q_avg,
    jsonb_agg(
      jsonb_build_object(
        'measurement_id', f.measurement_id, 'image_id', f.image_id,
        'length_um', f.length_um, 'width_um', f.width_um,
        'p1_x', f.p1_x, 'p1_y', f.p1_y, 'p2_x', f.p2_x, 'p2_y', f.p2_y,
        'p3_x', f.p3_x, 'p3_y', f.p3_y, 'p4_x', f.p4_x, 'p4_y', f.p4_y,
        'measured_at', f.measured_at
      )
      ORDER BY f.measured_at, f.measurement_id
    ) AS measurements_json
  FROM filtered f
$function$;

CREATE OR REPLACE FUNCTION public.community_spore_taxon_summary(p_genus text, p_species text)
 RETURNS TABLE(dataset_count bigint, measurement_count bigint, length_min double precision, length_p05 double precision, length_p50 double precision, length_p95 double precision, length_max double precision, length_avg double precision, width_min double precision, width_p05 double precision, width_p50 double precision, width_p95 double precision, width_max double precision, width_avg double precision, q_min double precision, q_p50 double precision, q_max double precision, q_avg double precision)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH public_points AS (
    SELECT
      o.id AS observation_id, m.length_um, m.width_um,
      (m.length_um / nullif(m.width_um, 0)) AS q_value
    FROM public.observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
     AND i.deleted_at IS NULL
     AND i.purged_at  IS NULL
    JOIN public.spore_measurements m ON m.image_id = i.id
    WHERE lower(coalesce(o.genus, '')) = lower(trim(coalesce(p_genus, '')))
      AND (trim(coalesce(p_species, '')) = '' OR lower(coalesce(o.species, '')) = lower(trim(p_species)))
      AND NOT coalesce(o.is_draft, false)
      AND public.can_read_observation(o.user_id, o.visibility)
      AND o.spore_data_visibility = 'public'
      AND m.length_um IS NOT NULL AND m.width_um IS NOT NULL AND m.width_um <> 0
      AND (m.measurement_type IS NULL OR m.measurement_type = ''
           OR lower(m.measurement_type) IN ('manual','spore','spores'))
  )
  SELECT
    count(distinct observation_id) AS dataset_count,
    count(*) AS measurement_count,
    min(length_um) AS length_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY length_um)::double precision AS length_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY length_um)::double precision AS length_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY length_um)::double precision AS length_p95,
    max(length_um) AS length_max, avg(length_um) AS length_avg,
    min(width_um) AS width_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY width_um)::double precision AS width_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY width_um)::double precision AS width_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY width_um)::double precision AS width_p95,
    max(width_um) AS width_max, avg(width_um) AS width_avg,
    min(q_value) AS q_min,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY q_value)::double precision AS q_p50,
    max(q_value) AS q_max, avg(q_value) AS q_avg
  FROM public_points
$function$;

CREATE OR REPLACE FUNCTION public.search_community_spore_datasets(p_genus text, p_species text, p_limit integer DEFAULT 50)
 RETURNS TABLE(dataset_type text, observation_id bigint, genus text, species text, contributor_label text, observed_on date, measurement_count bigint, image_count bigint, length_min double precision, length_p05 double precision, length_p50 double precision, length_p95 double precision, length_max double precision, width_min double precision, width_p05 double precision, width_p50 double precision, width_p95 double precision, width_max double precision, q_min double precision, q_p50 double precision, q_max double precision, qc_flags jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH filtered AS (
    SELECT
      o.id AS observation_id, o.user_id, o.genus, o.species, o.date, o.author,
      i.id AS image_id, i.mount_medium, i.stain, i.sample_type, i.contrast, i.objective_name,
      i.scale_microns_per_pixel,
      m.id AS measurement_id, m.length_um, m.width_um,
      m.p1_x, m.p1_y, m.p2_x, m.p2_y, m.p3_x, m.p3_y, m.p4_x, m.p4_y
    FROM public.observations o
    JOIN public.observation_images i
      ON i.observation_id = o.id
     AND i.deleted_at IS NULL
     AND i.purged_at  IS NULL
    JOIN public.spore_measurements m ON m.image_id = i.id
    WHERE lower(coalesce(o.genus, '')) = lower(trim(coalesce(p_genus, '')))
      AND (trim(coalesce(p_species, '')) = '' OR lower(coalesce(o.species, '')) = lower(trim(p_species)))
      AND NOT coalesce(o.is_draft, false)
      AND public.can_read_observation(o.user_id, o.visibility)
      AND public.can_access_spore_data(o.user_id, o.spore_data_visibility)
      AND m.length_um IS NOT NULL AND m.width_um IS NOT NULL
      AND (m.measurement_type IS NULL OR m.measurement_type = ''
           OR lower(m.measurement_type) IN ('manual','spore','spores'))
  )
  SELECT
    'observation'::text AS dataset_type,
    f.observation_id,
    max(f.genus) AS genus, max(f.species) AS species,
    public.community_contributor_label((array_agg(f.user_id))[1], max(f.author)) AS contributor_label,
    max(f.date) AS observed_on,
    count(f.measurement_id) AS measurement_count,
    count(distinct f.image_id) AS image_count,
    min(f.length_um) AS length_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.length_um)::double precision AS length_p95,
    max(f.length_um) AS length_max,
    min(f.width_um) AS width_min,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p05,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY f.width_um)::double precision AS width_p95,
    max(f.width_um) AS width_max,
    min(f.length_um / nullif(f.width_um, 0)) AS q_min,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY (f.length_um / nullif(f.width_um, 0)))::double precision AS q_p50,
    max(f.length_um / nullif(f.width_um, 0)) AS q_max,
    jsonb_build_object(
      'has_mount',           bool_or(nullif(f.mount_medium, '') IS NOT NULL),
      'has_stain',           bool_or(nullif(f.stain, '') IS NOT NULL),
      'has_sample_type',     bool_or(nullif(f.sample_type, '') IS NOT NULL),
      'has_contrast',        bool_or(nullif(f.contrast, '') IS NOT NULL),
      'has_objective',       bool_or(nullif(f.objective_name, '') IS NOT NULL),
      'has_scale',           bool_or(f.scale_microns_per_pixel IS NOT NULL),
      'has_point_geometry',  bool_or(f.p1_x IS NOT NULL OR f.p1_y IS NOT NULL OR f.p2_x IS NOT NULL OR f.p2_y IS NOT NULL),
      'measurement_count',   count(f.measurement_id)
    ) AS qc_flags
  FROM filtered f
  GROUP BY f.observation_id
  ORDER BY count(f.measurement_id) DESC, max(f.date) DESC, f.observation_id DESC
  LIMIT greatest(coalesce(p_limit, 50), 1)
$function$;

-- =============================================================
-- 10. Documentation.
-- =============================================================

COMMENT ON TABLE public.observations IS
  'Owner-only direct table access. Non-owner reads MUST go through '
  '`observations_community_view`, `observations_friend_view`, '
  '`observations_follow_view`, or the SECURITY DEFINER public-read '
  'RPCs. Locked down by 20260803120000_lock_down_observation_sync_tables.';

COMMENT ON TABLE public.observation_images IS
  'Owner-only direct table access — including tombstones (deleted_at) '
  'and originals. Non-owner reads MUST go through '
  '`observation_images_community_view` (community-safe projection, no '
  'originals, no tombstones, no purged rows) or the SECURITY DEFINER '
  'RPCs. Locked down by 20260803120000_lock_down_observation_sync_tables.';

COMMENT ON TABLE public.spore_measurements IS
  'Owner-only direct table access. Non-owner reads MUST go through '
  'SECURITY DEFINER RPCs (`get_community_spore_dataset`, '
  '`community_spore_taxon_summary`, `search_community_spore_datasets`, '
  '`get_public_spore_comparison_set`, `get_public_observation_spore_summaries`). '
  'Locked down by 20260803120000_lock_down_observation_sync_tables.';

COMMENT ON VIEW public.observation_images_community_view IS
  'Community-safe projection over `observation_images`. Excludes '
  'original_storage_path, notes, and other owner-private / internal '
  'columns. Excludes deleted, purged, draft, unauthorized, banned, '
  'and blocked rows. Owners read tombstones and originals via the '
  'raw table under RLS.';

COMMIT;
