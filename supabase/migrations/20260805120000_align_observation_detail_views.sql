-- Align the two non-owner detail-load surfaces
--   * public.observations_community_view (public visibility only)
--   * public.observations_friend_view    (accepted-friend surface)
-- with the fields the app.sporely.no detail screen selects. The
-- authorization split between the two views is preserved verbatim:
-- community_view still requires `visibility='public'`, friend_view
-- still gates on `public.are_friends(auth.uid(), o.user_id)` and
-- `visibility IN ('friends','public')`. This migration only expands
-- the projection lists.
--
-- Motivation
-- ----------
-- The v0.6.19 web app's `loadDetailObservation()` in
-- src/screens/find_detail.js selects the following non-owner detail
-- contract from every read view it consults:
--   id, user_id, date, created_at, captured_at,
--   genus, species, common_name,
--   ai_selected_service, ai_selected_taxon_id,
--   ai_selected_scientific_name, ai_selected_probability,
--   ai_selected_at,
--   red_list_category, red_list_categories_json,
--   location, habitat, notes, uncertain,
--   gps_latitude, gps_longitude, visibility,
--   is_draft, location_precision
--
-- The prior view definitions (from
-- 20260803120000_lock_down_observation_sync_tables.sql) shipped a
-- narrower projection:
--
--   observations_community_view: had ai_selected_* but not
--       red_list_category / red_list_categories_json — the primary
--       bug reported against app.sporely.no v0.6.19.
--
--   observations_friend_view:    lacked ai_selected_* AND
--       red_list_category / red_list_categories_json. The frontend
--       fell back to this view for friends-only observations and
--       would receive PostgREST 42703 as soon as the detail read
--       ships. Fixing the community view alone would leave the
--       friend surface broken.
--
-- The observations base table has held both column groups since
--   20260711120000_add_observation_red_list_columns.sql   (red_list_*)
--   (ai_selected_* were added in an earlier baseline migration)
-- so both view CREATE OR REPLACEs can reference the columns
-- directly against `public.observations`.
--
-- CREATE OR REPLACE VIEW semantics
-- --------------------------------
-- PostgreSQL requires new columns to be appended at the end of the
-- projection list; pre-existing columns and their positions are
-- preserved verbatim from the 20260803120000 definitions. Bodies,
-- joins, WHERE clauses, and location-precision projections are
-- unchanged. `security_barrier` is preserved on both views. Owner
-- and grants are inherited; no GRANT / REVOKE / OWNER statements
-- are issued here. Not combined with the security_invoker refactor.
-- `observations_follow_view` is intentionally NOT modified: no
-- client selects the added columns from it today.
--
-- Idempotency: safe to replay. Notifies PostgREST to reload the
-- schema cache so the appended columns become selectable
-- immediately after deploy without waiting for the periodic
-- refresh.

BEGIN;

-- =============================================================
-- 1. observations_community_view — append red-list columns.
--    Authorization unchanged: public visibility only, no draft,
--    author not banned, caller/author not blocked.
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
  END AS spore_statistics,
  -- Appended in 20260805120000. CREATE OR REPLACE VIEW cannot
  -- renumber existing columns, so red-list is last.
  o.red_list_category,
  o.red_list_categories_json
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
WHERE COALESCE(o.visibility,'public') = 'public'
  AND NOT COALESCE(o.is_draft, false)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

-- =============================================================
-- 2. observations_friend_view — append AI-selection columns and
--    red-list columns.
--    Authorization unchanged: visibility IN ('friends','public'),
--    NOT draft, `public.are_friends(auth.uid(), o.user_id)`,
--    author not banned, caller/author not blocked.
--    Location-precision projection unchanged.
-- =============================================================
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
  o.is_draft, o.location_precision,
  -- Appended in 20260805120000. Order matches the append-order in
  -- observations_community_view for symmetry; CREATE OR REPLACE
  -- VIEW cannot renumber the previously-projected columns.
  o.ai_selected_service, o.ai_selected_taxon_id, o.ai_selected_scientific_name,
  o.ai_selected_probability, o.ai_selected_at,
  o.red_list_category,
  o.red_list_categories_json
FROM public.observations o
LEFT JOIN public.public_regions pr ON pr.id = o.region_id
WHERE COALESCE(o.visibility,'public') = ANY (ARRAY['friends','public'])
  AND NOT COALESCE(o.is_draft, false)
  AND public.are_friends(auth.uid(), o.user_id)
  AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned = true)
  AND NOT public.is_blocked_between(auth.uid(), o.user_id);

-- Ensure PostgREST picks up the added columns immediately so the
-- web app stops receiving 42703 on the detail select after deploy
-- without waiting for the periodic schema reload.
NOTIFY pgrst, 'reload schema';

COMMIT;
