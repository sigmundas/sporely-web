-- Stage 2a — private-media-delivery foundation.
--
-- Consolidated from four Stage 2a review iterations. This migration
-- carries only the settled final state of every schema, function,
-- trigger, and grant. It is safe to replay against any schema at or
-- after Stage 1 (20260803120000_lock_down_observation_sync_tables.sql).
--
-- Additions
-- ---------
--   observation_images         → media_version, canonical_bucket
--   observations               → media_version
--   spore_measurement_mosaics  → media_version, canonical_bucket
--   public._media_worker_config (protected single-row origin)
--   public._media_worker_base_url()
--   public._media_get_observation_user_id(bigint)   -- RLS-bypass helper
--   public.media_variant_is_supported(text)         -- {full,thumb,original}
--   public.build_worker_media_url(bigint,text,bigint)
--   public.media_authorize_delivery(bigint,text,uuid)
--   public.media_authorize_mosaic_delivery(bigint,uuid)
--   Server-owned-field guards (BEFORE + AFTER)  on observation_images
--   Server-owned-field guards (BEFORE + AFTER)  on observations
--   Key-ownership guard                          on observation_images
--   Version-bump triggers                        on all three tables + profiles
--
-- Trust boundary in triggers/guards: `auth.uid() IS NULL` distinguishes
-- migration + service_role callers (no JWT) from client callers.
-- Supabase's PostgREST pool always logs in as `postgres` and only SET
-- ROLEs to anon/authenticated after connection, so `session_user` /
-- `current_user` are not reliable trust discriminators. Anon writes to
-- observation_images are blocked by RLS before reaching any of these
-- triggers, so `auth.uid() IS NULL` is safe here as the trusted signal.
--
-- Deployment note
-- ---------------
-- Stage 2a is NOT fully dormant. Triggers alter write behaviour on the
-- guarded columns; the new /m/<image_id>/<variant>?v=<v> and
-- /mm/<mosaic_id>?v=<v> Worker routes become live public attack surfaces
-- once the Worker deploys. Deploy the migration first (this file), then
-- the Worker with MEDIA_STORAGE_MODE=legacy. Do NOT flip to `private`
-- until Stage 2c legacy backfill completes and Stage 2b consumers ship.
-- See docs/security/stage-2-media-authorization.md.

BEGIN;

-- =============================================================
-- 1. Schema additions.
-- =============================================================

ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS media_version    bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS canonical_bucket text   NOT NULL DEFAULT 'legacy';

ALTER TABLE public.observation_images
  DROP CONSTRAINT IF EXISTS observation_images_canonical_bucket_check;
ALTER TABLE public.observation_images
  ADD  CONSTRAINT observation_images_canonical_bucket_check
       CHECK (canonical_bucket IN ('legacy','private'));

ALTER TABLE public.observation_images
  DROP CONSTRAINT IF EXISTS observation_images_media_version_positive;
ALTER TABLE public.observation_images
  ADD  CONSTRAINT observation_images_media_version_positive
       CHECK (media_version >= 1);

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS media_version bigint NOT NULL DEFAULT 1;
ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_media_version_positive;
ALTER TABLE public.observations
  ADD  CONSTRAINT observations_media_version_positive
       CHECK (media_version >= 1);

ALTER TABLE public.spore_measurement_mosaics
  ADD COLUMN IF NOT EXISTS media_version    bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS canonical_bucket text   NOT NULL DEFAULT 'legacy';

ALTER TABLE public.spore_measurement_mosaics
  DROP CONSTRAINT IF EXISTS spore_measurement_mosaics_canonical_bucket_check;
ALTER TABLE public.spore_measurement_mosaics
  ADD  CONSTRAINT spore_measurement_mosaics_canonical_bucket_check
       CHECK (canonical_bucket IN ('legacy','private'));
ALTER TABLE public.spore_measurement_mosaics
  DROP CONSTRAINT IF EXISTS spore_measurement_mosaics_media_version_positive;
ALTER TABLE public.spore_measurement_mosaics
  ADD  CONSTRAINT spore_measurement_mosaics_media_version_positive
       CHECK (media_version >= 1);

COMMENT ON COLUMN public.observation_images.media_version IS
  'Monotonic version bumped whenever any state that affects the '
  'authorization decision changes. Used by the /m/ worker route as '
  'part of the cache key. Client roles cannot modify; nested-trigger '
  'contexts may only perform the exact +1 transition (enforced by '
  '_media_final_state_guard_image).';

COMMENT ON COLUMN public.observation_images.canonical_bucket IS
  'Which R2 bucket holds the canonical bytes for this row. `legacy` = '
  'the pre-Stage-2 `sporely-media` bucket. `private` = the Stage-2 '
  'private bucket bound to the worker as `PRIVATE_MEDIA_BUCKET`. Set '
  'by the worker after a successful private-mode upload; migrated '
  'legacy → private by the Stage 2c backfill script.';

COMMENT ON COLUMN public.observations.media_version IS
  'Monotonic version bumped on visibility/is_draft/user_id/is_banned '
  'change. Cascaded to child observation_images and mosaics.';

COMMENT ON COLUMN public.spore_measurement_mosaics.media_version IS
  'Monotonic version bumped on storage_key/canonical_bucket/'
  'observation_id change AND on parent observation visibility/is_draft/'
  'spore_data_visibility/user_id change. Used by the /mm/ worker route.';

-- =============================================================
-- 2. Protected worker-origin configuration.
--    Superuser-owned single-row table + SECURITY DEFINER helper.
--    Session GUC `app.settings.media_worker_base_url` is NOT read;
--    ordinary sessions cannot influence the emitted host.
-- =============================================================

CREATE TABLE IF NOT EXISTS public._media_worker_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  base_url  text    NOT NULL DEFAULT 'https://upload.sporely.no'
);

REVOKE ALL ON public._media_worker_config FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public._media_worker_config TO service_role;

INSERT INTO public._media_worker_config (singleton, base_url)
VALUES (true, 'https://upload.sporely.no')
ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public._media_worker_config ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public._media_worker_base_url()
  RETURNS text
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path='public,pg_catalog'
AS $$
  SELECT base_url FROM public._media_worker_config WHERE singleton = true LIMIT 1
$$;

REVOKE ALL ON FUNCTION public._media_worker_base_url() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._media_worker_base_url()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public._media_worker_base_url() IS
  'Hardcoded Worker origin resolver. Reads a superuser-owned config '
  'table via SECURITY DEFINER. Ordinary sessions cannot override the '
  'returned host.';

-- =============================================================
-- 3. Variant allowlist (imageer variant set).
--    Mosaic is NOT an image variant — see /mm/ + media_authorize_mosaic_delivery.
-- =============================================================

CREATE OR REPLACE FUNCTION public.media_variant_is_supported(p_variant text)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE
  SET search_path='pg_catalog'
AS $$
  SELECT p_variant IS NOT NULL AND p_variant IN ('full','thumb','original')
$$;

REVOKE ALL ON FUNCTION public.media_variant_is_supported(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.media_variant_is_supported(text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.media_variant_is_supported(text) IS
  'Canonical Stage 2 image-variant allowlist. Case-sensitive exact match. '
  'NULL, whitespace, mixed-case, and unknown inputs all yield false. '
  'Extending the set requires this function AND the Worker MEDIA_VARIANTS '
  'constant to change together.';

-- =============================================================
-- 4. RLS-bypass helper — used ONLY by the key-ownership trigger.
--    Not client-callable.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_get_observation_user_id(p_obs_id bigint)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path='public,pg_catalog'
AS $$
  SELECT user_id FROM public.observations WHERE id = p_obs_id
$$;

REVOKE ALL ON FUNCTION public._media_get_observation_user_id(bigint)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._media_get_observation_user_id(bigint) IS
  'RLS-bypass helper used solely by the key-ownership trigger to look '
  'up a parent observation''s owner when the caller is an authenticated '
  'user whose RLS would otherwise hide the row. Not client-callable.';

-- =============================================================
-- 5. URL builder (STABLE — reads _media_worker_config).
-- =============================================================

CREATE OR REPLACE FUNCTION public.build_worker_media_url(
  p_image_id bigint,
  p_variant text,
  p_media_version bigint
) RETURNS text
LANGUAGE plpgsql
STABLE PARALLEL SAFE
SET search_path='public,pg_catalog'
AS $$
DECLARE
  base_url text;
BEGIN
  IF p_image_id IS NULL OR p_image_id <= 0 THEN RETURN NULL; END IF;
  IF p_media_version IS NULL OR p_media_version < 1 THEN RETURN NULL; END IF;
  IF NOT public.media_variant_is_supported(p_variant) THEN RETURN NULL; END IF;

  base_url := regexp_replace(public._media_worker_base_url(), '/+$', '');
  IF base_url IS NULL OR base_url !~ '^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$' THEN
    RETURN NULL;
  END IF;

  RETURN base_url
      || '/m/' || p_image_id::text
      || '/' || p_variant
      || '?v=' || p_media_version::text;
END $$;

REVOKE ALL ON FUNCTION public.build_worker_media_url(bigint, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.build_worker_media_url(bigint, text, bigint)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.build_worker_media_url(bigint, text, bigint) IS
  'STABLE (reads _media_worker_config). Returns NULL for non-positive '
  'ids/versions or unsupported variants — surrounding views and RPCs '
  'must treat NULL as "no URL".';

-- =============================================================
-- 6. Server-owned field guards.
--
--    Two layers per table:
--      BEFORE — trg_00 — trust from `current_user IN (…)` (SECURITY
--        INVOKER; reflects SET ROLE). Reject client-role writes to
--        canonical_bucket / media_version on INSERT (must default) and
--        UPDATE.
--      AFTER  — trg_zz — trust from `auth.uid() IS NULL` (SECURITY
--        DEFINER; `session_user`/`current_user` unreliable inside SD).
--        Enforces the final committed transition — media_version delta
--        MUST be 0 or +1 for untrusted callers; canonical_bucket must
--        not change. Catches any rogue BEFORE trigger that mutates
--        NEW past the earlier check.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_guard_server_owned_fields_image()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
DECLARE
  is_trusted boolean := current_user IN ('postgres','service_role','supabase_admin');
  nested     boolean := pg_trigger_depth() > 1;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT is_trusted THEN
      IF NEW.canonical_bucket IS DISTINCT FROM 'legacy' THEN
        RAISE EXCEPTION
          'canonical_bucket is server-owned and must default to ''legacy'' on client insert (got %)',
          NEW.canonical_bucket USING ERRCODE='insufficient_privilege';
      END IF;
      IF NEW.media_version IS NOT NULL AND NEW.media_version <> 1 THEN
        RAISE EXCEPTION
          'media_version is server-owned and must default to 1 on client insert (got %)',
          NEW.media_version USING ERRCODE='insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.canonical_bucket IS DISTINCT FROM OLD.canonical_bucket THEN
    IF NOT is_trusted THEN
      RAISE EXCEPTION
        'canonical_bucket may be changed only by a trusted role (got %)',
        current_user USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  IF NEW.media_version IS DISTINCT FROM OLD.media_version THEN
    IF is_trusted THEN
      NULL;
    ELSIF nested THEN
      IF NEW.media_version IS NULL THEN
        RAISE EXCEPTION 'media_version cannot be set to NULL'
          USING ERRCODE='insufficient_privilege';
      END IF;
      IF OLD.media_version IS NULL OR NEW.media_version <> OLD.media_version + 1 THEN
        RAISE EXCEPTION
          'nested media_version transition must be exactly OLD+1 (was %, now %)',
          OLD.media_version, NEW.media_version
          USING ERRCODE='insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION
        'media_version is server-owned and cannot be modified by role %',
        current_user USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_media_guard_server_owned_image ON public.observation_images;
CREATE TRIGGER trg_00_media_guard_server_owned_image
  BEFORE INSERT OR UPDATE ON public.observation_images
  FOR EACH ROW
  EXECUTE FUNCTION public._media_guard_server_owned_fields_image();

CREATE OR REPLACE FUNCTION public._media_guard_server_owned_fields_obs()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
DECLARE
  is_trusted boolean := current_user IN ('postgres','service_role','supabase_admin');
  nested     boolean := pg_trigger_depth() > 1;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT is_trusted
       AND NEW.media_version IS NOT NULL
       AND NEW.media_version <> 1 THEN
      RAISE EXCEPTION
        'observations.media_version is server-owned and must default to 1 on client insert (got %)',
        NEW.media_version USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.media_version IS DISTINCT FROM OLD.media_version THEN
    IF is_trusted THEN
      NULL;
    ELSIF nested THEN
      IF NEW.media_version IS NULL THEN
        RAISE EXCEPTION 'observations.media_version cannot be set to NULL'
          USING ERRCODE='insufficient_privilege';
      END IF;
      IF OLD.media_version IS NULL OR NEW.media_version <> OLD.media_version + 1 THEN
        RAISE EXCEPTION
          'nested observations.media_version transition must be exactly OLD+1 (was %, now %)',
          OLD.media_version, NEW.media_version
          USING ERRCODE='insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION
        'observations.media_version is server-owned and cannot be modified by role %',
        current_user USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_media_guard_server_owned_obs ON public.observations;
CREATE TRIGGER trg_00_media_guard_server_owned_obs
  BEFORE INSERT OR UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public._media_guard_server_owned_fields_obs();

-- Final-state (AFTER) guards.
CREATE OR REPLACE FUNCTION public._media_final_state_guard_image()
  RETURNS TRIGGER LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path='public,pg_catalog'
AS $$
DECLARE
  is_trusted boolean := (auth.uid() IS NULL);
  delta bigint;
BEGIN
  IF is_trusted THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.media_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION
        'final-state guard: media_version must be 1 on client INSERT (got %)',
        NEW.media_version USING ERRCODE='insufficient_privilege';
    END IF;
    IF NEW.canonical_bucket IS DISTINCT FROM 'legacy' THEN
      RAISE EXCEPTION
        'final-state guard: canonical_bucket must be ''legacy'' on client INSERT (got %)',
        NEW.canonical_bucket USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.canonical_bucket IS DISTINCT FROM OLD.canonical_bucket THEN
    RAISE EXCEPTION
      'final-state guard: canonical_bucket transition rejected for client role'
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF NEW.media_version IS DISTINCT FROM OLD.media_version THEN
    delta := COALESCE(NEW.media_version, 0) - COALESCE(OLD.media_version, 0);
    IF delta <> 1 THEN
      RAISE EXCEPTION
        'final-state guard: only monotonic +1 media_version transitions allowed for client role (delta=%)',
        delta USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_zz_media_final_state_guard_image ON public.observation_images;
CREATE TRIGGER trg_zz_media_final_state_guard_image
  AFTER INSERT OR UPDATE ON public.observation_images
  FOR EACH ROW
  EXECUTE FUNCTION public._media_final_state_guard_image();

CREATE OR REPLACE FUNCTION public._media_final_state_guard_obs()
  RETURNS TRIGGER LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path='public,pg_catalog'
AS $$
DECLARE
  is_trusted boolean := (auth.uid() IS NULL);
  delta bigint;
BEGIN
  IF is_trusted THEN RETURN NULL; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.media_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION
        'final-state guard: observations.media_version must be 1 on client INSERT (got %)',
        NEW.media_version USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.media_version IS DISTINCT FROM OLD.media_version THEN
    delta := COALESCE(NEW.media_version, 0) - COALESCE(OLD.media_version, 0);
    IF delta <> 1 THEN
      RAISE EXCEPTION
        'final-state guard: only monotonic +1 observations.media_version transitions allowed for client role (delta=%)',
        delta USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_zz_media_final_state_guard_obs ON public.observations;
CREATE TRIGGER trg_zz_media_final_state_guard_obs
  AFTER INSERT OR UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public._media_final_state_guard_obs();

-- =============================================================
-- 7. Key-ownership guard (BEFORE).
--    SECURITY DEFINER so it can invoke the RLS-bypass helper without
--    granting EXECUTE to client roles. Trust boundary: auth.uid() IS NULL.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_guard_key_ownership_image()
  RETURNS TRIGGER LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path='public,pg_catalog'
AS $$
DECLARE
  is_trusted boolean := (auth.uid() IS NULL);
  caller_uid uuid    := auth.uid();
  parent_owner uuid;
  expected_prefix text;
BEGIN
  IF is_trusted THEN
    RETURN NEW;
  END IF;

  IF caller_uid IS NULL THEN
    RAISE EXCEPTION 'observation_images write requires an authenticated caller'
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF NEW.user_id IS DISTINCT FROM caller_uid THEN
    RAISE EXCEPTION
      'observation_images.user_id (%) must equal auth.uid() (%)',
      NEW.user_id, caller_uid
      USING ERRCODE='insufficient_privilege';
  END IF;

  parent_owner := public._media_get_observation_user_id(NEW.observation_id);
  IF parent_owner IS NULL THEN
    RAISE EXCEPTION 'observation_id % does not exist', NEW.observation_id
      USING ERRCODE='foreign_key_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM parent_owner THEN
    RAISE EXCEPTION
      'observation_images.user_id (%) must equal observations.user_id (%)',
      NEW.user_id, parent_owner
      USING ERRCODE='insufficient_privilege';
  END IF;

  expected_prefix := NEW.user_id::text || '/';

  IF NEW.storage_path IS NOT NULL AND NEW.storage_path <> ''
     AND NOT (NEW.storage_path LIKE expected_prefix || '%') THEN
    RAISE EXCEPTION
      'storage_path (%) must live under the row owner''s prefix (%)',
      NEW.storage_path, expected_prefix
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF NEW.original_storage_path IS NOT NULL AND NEW.original_storage_path <> ''
     AND NOT (NEW.original_storage_path LIKE expected_prefix || '%') THEN
    RAISE EXCEPTION
      'original_storage_path (%) must live under the row owner''s prefix (%)',
      NEW.original_storage_path, expected_prefix
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.observation_id IS DISTINCT FROM OLD.observation_id THEN
      RAISE EXCEPTION 'observation_images.observation_id is immutable'
        USING ERRCODE='insufficient_privilege';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'observation_images.user_id is immutable'
        USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_01_media_guard_key_ownership ON public.observation_images;
CREATE TRIGGER trg_01_media_guard_key_ownership
  BEFORE INSERT OR UPDATE ON public.observation_images
  FOR EACH ROW
  EXECUTE FUNCTION public._media_guard_key_ownership_image();

-- =============================================================
-- 8. Version-bump triggers.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_bump_own_version_on_obs()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     AND NEW.is_draft   IS NOT DISTINCT FROM OLD.is_draft
     AND NEW.user_id    IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  NEW.media_version := COALESCE(OLD.media_version, 0) + 1;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public._media_bump_child_images_on_obs()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     AND NEW.is_draft   IS NOT DISTINCT FROM OLD.is_draft
     AND NEW.user_id    IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 42));
  UPDATE public.observation_images
     SET media_version = media_version + 1
   WHERE observation_id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_observation_media_version_bump_own  ON public.observations;
DROP TRIGGER IF EXISTS trg_observation_media_version_cascade   ON public.observations;

CREATE TRIGGER trg_observation_media_version_bump_own
  BEFORE UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public._media_bump_own_version_on_obs();

CREATE TRIGGER trg_observation_media_version_cascade
  AFTER UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public._media_bump_child_images_on_obs();

CREATE OR REPLACE FUNCTION public._media_bump_on_image_change()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND NEW.deleted_at            IS NOT DISTINCT FROM OLD.deleted_at
     AND NEW.purged_at             IS NOT DISTINCT FROM OLD.purged_at
     AND NEW.storage_path          IS NOT DISTINCT FROM OLD.storage_path
     AND NEW.original_storage_path IS NOT DISTINCT FROM OLD.original_storage_path
     AND NEW.canonical_bucket      IS NOT DISTINCT FROM OLD.canonical_bucket THEN
    RETURN NEW;
  END IF;
  NEW.media_version := COALESCE(OLD.media_version, 0) + 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_observation_image_media_version_bump ON public.observation_images;
CREATE TRIGGER trg_observation_image_media_version_bump
  BEFORE UPDATE ON public.observation_images
  FOR EACH ROW
  EXECUTE FUNCTION public._media_bump_on_image_change();

CREATE OR REPLACE FUNCTION public._media_bump_on_profile_ban_change()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
BEGIN
  IF NEW.is_banned IS NOT DISTINCT FROM OLD.is_banned THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text, 43));
  UPDATE public.observations
     SET media_version = media_version + 1
   WHERE user_id = NEW.id;
  UPDATE public.observation_images
     SET media_version = media_version + 1
   WHERE user_id = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_profile_ban_media_version_bump ON public.profiles;
CREATE TRIGGER trg_profile_ban_media_version_bump
  AFTER UPDATE OF is_banned ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public._media_bump_on_profile_ban_change();

-- Mosaic version-bump: on storage_key / canonical_bucket / observation_id
-- change (BEFORE trigger on the mosaic row), OR on parent observation
-- visibility/is_draft/spore_data_visibility/user_id change (AFTER
-- trigger cascade from observations).
CREATE OR REPLACE FUNCTION public._media_bump_on_mosaic_change()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.storage_key      IS NOT DISTINCT FROM OLD.storage_key
     AND NEW.canonical_bucket IS NOT DISTINCT FROM OLD.canonical_bucket
     AND NEW.observation_id   IS NOT DISTINCT FROM OLD.observation_id THEN
    RETURN NEW;
  END IF;
  NEW.media_version := COALESCE(OLD.media_version, 0) + 1;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mosaic_media_version_bump ON public.spore_measurement_mosaics;
CREATE TRIGGER trg_mosaic_media_version_bump
  BEFORE UPDATE ON public.spore_measurement_mosaics
  FOR EACH ROW
  EXECUTE FUNCTION public._media_bump_on_mosaic_change();

CREATE OR REPLACE FUNCTION public._media_bump_mosaics_on_obs()
  RETURNS TRIGGER LANGUAGE plpgsql SET search_path='public,pg_catalog'
AS $$
BEGIN
  IF (TG_OP = 'UPDATE')
     AND NEW.visibility            IS NOT DISTINCT FROM OLD.visibility
     AND NEW.is_draft              IS NOT DISTINCT FROM OLD.is_draft
     AND NEW.spore_data_visibility IS NOT DISTINCT FROM OLD.spore_data_visibility
     AND NEW.user_id               IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NULL;
  END IF;
  UPDATE public.spore_measurement_mosaics
     SET media_version = media_version + 1
   WHERE observation_id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_observation_mosaic_cascade ON public.observations;
CREATE TRIGGER trg_observation_mosaic_cascade
  AFTER UPDATE ON public.observations
  FOR EACH ROW
  EXECUTE FUNCTION public._media_bump_mosaics_on_obs();

-- =============================================================
-- 9. media_authorize_delivery — variant-specific decision RPC.
--    Service-role only. Read-time integrity checks fail closed on
--    legacy or trusted-role-inserted malformed rows.
-- =============================================================

CREATE OR REPLACE FUNCTION public.media_authorize_delivery(
  p_image_id bigint,
  p_variant text,
  p_caller uuid
) RETURNS TABLE (
  allowed boolean,
  storage_path text,
  canonical_bucket text,
  media_version bigint,
  cache_class text,
  reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path='public,pg_catalog'
AS $$
DECLARE
  r RECORD;
  is_owner boolean;
  namespace_prefix text;
  chosen_key text;
BEGIN
  IF public.media_variant_is_supported(p_variant) IS DISTINCT FROM true THEN
    allowed := false; storage_path := NULL; canonical_bucket := NULL;
    media_version := NULL; cache_class := 'deny'; reason := 'unsupported_variant';
    RETURN NEXT; RETURN;
  END IF;

  IF p_image_id IS NULL OR p_image_id <= 0 THEN
    allowed := false; storage_path := NULL; canonical_bucket := NULL;
    media_version := NULL; cache_class := 'deny'; reason := 'invalid_image_id';
    RETURN NEXT; RETURN;
  END IF;

  SELECT
    oi.id, oi.observation_id,
    oi.user_id                    AS image_user_id,
    oi.storage_path,
    oi.original_storage_path,
    oi.canonical_bucket,
    oi.deleted_at,
    oi.purged_at,
    oi.media_version,
    o.user_id                     AS obs_user_id,
    o.visibility,
    COALESCE(o.spore_data_visibility, 'public') AS spore_data_visibility,
    o.is_draft,
    COALESCE(p.is_banned, false)  AS owner_banned
  INTO r
  FROM public.observation_images oi
  JOIN public.observations       o ON o.id = oi.observation_id
  LEFT JOIN public.profiles      p ON p.id = o.user_id
  WHERE oi.id = p_image_id;

  IF NOT FOUND THEN
    allowed := false; storage_path := NULL; canonical_bucket := NULL;
    media_version := NULL; cache_class := 'deny'; reason := 'not_found';
    RETURN NEXT; RETURN;
  END IF;

  media_version := r.media_version;
  canonical_bucket := r.canonical_bucket;

  -- Read-time integrity.
  IF r.canonical_bucket IS NULL OR r.canonical_bucket NOT IN ('legacy','private') THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'invalid_bucket';
    RETURN NEXT; RETURN;
  END IF;
  IF r.media_version IS NULL OR r.media_version < 1 THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'invalid_media_version';
    RETURN NEXT; RETURN;
  END IF;
  IF r.image_user_id IS DISTINCT FROM r.obs_user_id THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'owner_mismatch';
    RETURN NEXT; RETURN;
  END IF;

  IF r.deleted_at IS NOT NULL THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'deleted';
    RETURN NEXT; RETURN;
  END IF;
  IF r.purged_at IS NOT NULL THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'purged';
    RETURN NEXT; RETURN;
  END IF;

  is_owner := (p_caller IS NOT NULL AND r.obs_user_id = p_caller);
  namespace_prefix := r.image_user_id::text || '/';

  -- `original` — owner-only, no non-owner branch.
  IF p_variant = 'original' THEN
    chosen_key := r.original_storage_path;
    IF chosen_key IS NULL OR chosen_key = '' THEN
      allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'metadata_only';
      RETURN NEXT; RETURN;
    END IF;
    IF NOT (chosen_key LIKE namespace_prefix || '%') THEN
      allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'invalid_original_namespace';
      RETURN NEXT; RETURN;
    END IF;
    IF NOT is_owner THEN
      allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'original_owner_only';
      RETURN NEXT; RETURN;
    END IF;
    storage_path := chosen_key;
    allowed := true; cache_class := 'private-short'; reason := 'owner_original';
    RETURN NEXT; RETURN;
  END IF;

  -- full / thumb.
  chosen_key := r.storage_path;
  IF chosen_key IS NULL OR chosen_key = '' THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'metadata_only';
    RETURN NEXT; RETURN;
  END IF;
  IF NOT (chosen_key LIKE namespace_prefix || '%') THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'invalid_storage_namespace';
    RETURN NEXT; RETURN;
  END IF;

  IF is_owner THEN
    storage_path := chosen_key;
    allowed := true; cache_class := 'private-short'; reason := 'owner';
    RETURN NEXT; RETURN;
  END IF;

  IF r.owner_banned THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'owner_banned';
    RETURN NEXT; RETURN;
  END IF;
  IF COALESCE(r.is_draft, false) THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'draft';
    RETURN NEXT; RETURN;
  END IF;
  IF p_caller IS NOT NULL AND public.is_blocked_between(p_caller, r.obs_user_id) THEN
    allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'blocked';
    RETURN NEXT; RETURN;
  END IF;

  IF COALESCE(r.visibility, 'public') = 'public' THEN
    storage_path := chosen_key;
    allowed := true; cache_class := 'public'; reason := 'public';
    RETURN NEXT; RETURN;
  END IF;
  IF COALESCE(r.visibility, 'public') = 'friends'
     AND p_caller IS NOT NULL
     AND public.are_friends(p_caller, r.obs_user_id) THEN
    storage_path := chosen_key;
    allowed := true; cache_class := 'private-short'; reason := 'friend';
    RETURN NEXT; RETURN;
  END IF;

  allowed := false; storage_path := NULL; cache_class := 'deny'; reason := 'observation_denied';
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.media_authorize_delivery(bigint, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_authorize_delivery(bigint, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_authorize_delivery(bigint, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.media_authorize_delivery(bigint, text, uuid) IS
  'Variant-specific media authorization RPC. Called by the Cloudflare '
  'Worker on the /m/<image_id>/<variant>?v=<v> route via service_role. '
  '`original` is owner-only. Read-time integrity: owner_mismatch, '
  'invalid_storage_namespace, invalid_original_namespace, invalid_bucket, '
  'invalid_media_version.';

-- =============================================================
-- 10. media_authorize_mosaic_delivery — mosaic identity RPC.
--     Mosaic access requires BOTH observation visibility AND
--     spore_data_visibility permission.
-- =============================================================

CREATE OR REPLACE FUNCTION public.media_authorize_mosaic_delivery(
  p_mosaic_id bigint,
  p_caller uuid
) RETURNS TABLE (
  allowed boolean,
  storage_key text,
  canonical_bucket text,
  media_version bigint,
  cache_class text,
  reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path='public,pg_catalog'
AS $$
DECLARE
  r RECORD;
  is_owner boolean;
BEGIN
  IF p_mosaic_id IS NULL OR p_mosaic_id <= 0 THEN
    allowed := false; storage_key := NULL; canonical_bucket := NULL;
    media_version := NULL; cache_class := 'deny'; reason := 'invalid_mosaic_id';
    RETURN NEXT; RETURN;
  END IF;

  SELECT
    m.id, m.user_id AS mosaic_user_id, m.storage_key, m.canonical_bucket,
    m.media_version,
    o.user_id AS obs_user_id, o.visibility,
    COALESCE(o.spore_data_visibility,'public') AS spore_data_visibility,
    o.is_draft,
    COALESCE(p.is_banned, false) AS owner_banned
  INTO r
  FROM public.spore_measurement_mosaics m
  JOIN public.observations o ON o.id = m.observation_id
  LEFT JOIN public.profiles p ON p.id = o.user_id
  WHERE m.id = p_mosaic_id;

  IF NOT FOUND THEN
    allowed := false; storage_key := NULL; canonical_bucket := NULL;
    media_version := NULL; cache_class := 'deny'; reason := 'not_found';
    RETURN NEXT; RETURN;
  END IF;

  media_version := r.media_version;
  canonical_bucket := r.canonical_bucket;

  IF r.canonical_bucket IS NULL OR r.canonical_bucket NOT IN ('legacy','private') THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'invalid_bucket';
    RETURN NEXT; RETURN;
  END IF;
  IF r.media_version IS NULL OR r.media_version < 1 THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'invalid_media_version';
    RETURN NEXT; RETURN;
  END IF;
  IF r.mosaic_user_id IS DISTINCT FROM r.obs_user_id THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'owner_mismatch';
    RETURN NEXT; RETURN;
  END IF;
  IF r.storage_key IS NULL OR r.storage_key = '' THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'no_key';
    RETURN NEXT; RETURN;
  END IF;

  is_owner := (p_caller IS NOT NULL AND r.obs_user_id = p_caller);

  IF is_owner THEN
    storage_key := r.storage_key;
    allowed := true; cache_class := 'private-short'; reason := 'owner';
    RETURN NEXT; RETURN;
  END IF;

  IF r.owner_banned THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'owner_banned';
    RETURN NEXT; RETURN;
  END IF;
  IF COALESCE(r.is_draft, false) THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'draft';
    RETURN NEXT; RETURN;
  END IF;
  IF p_caller IS NOT NULL AND public.is_blocked_between(p_caller, r.obs_user_id) THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'blocked';
    RETURN NEXT; RETURN;
  END IF;

  DECLARE
    obs_ok boolean := false;
    spore_ok boolean := false;
  BEGIN
    IF COALESCE(r.visibility,'public') = 'public' THEN obs_ok := true;
    ELSIF COALESCE(r.visibility,'public') = 'friends'
          AND p_caller IS NOT NULL
          AND public.are_friends(p_caller, r.obs_user_id) THEN obs_ok := true;
    END IF;

    IF r.spore_data_visibility = 'public' THEN spore_ok := true;
    ELSIF r.spore_data_visibility = 'friends'
          AND p_caller IS NOT NULL
          AND public.are_friends(p_caller, r.obs_user_id) THEN spore_ok := true;
    END IF;

    IF NOT obs_ok THEN
      allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'observation_denied';
      RETURN NEXT; RETURN;
    END IF;
    IF NOT spore_ok THEN
      allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'spore_data_denied';
      RETURN NEXT; RETURN;
    END IF;
  END;

  storage_key := r.storage_key;
  IF COALESCE(r.visibility,'public') = 'public' THEN
    allowed := true; cache_class := 'public'; reason := 'public';
  ELSE
    allowed := true; cache_class := 'private-short'; reason := 'friend';
  END IF;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.media_authorize_mosaic_delivery(bigint, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_authorize_mosaic_delivery(bigint, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_authorize_mosaic_delivery(bigint, uuid)
  TO service_role;

COMMENT ON FUNCTION public.media_authorize_mosaic_delivery(bigint, uuid) IS
  'Mosaic-specific delivery authorization. Called by the Cloudflare '
  'Worker on the /mm/<mosaic_id>?v=<v> route via service_role. Access '
  'requires BOTH observation visibility AND spore_data_visibility '
  'permission. Read-time integrity checks match media_authorize_delivery.';

-- =============================================================
-- 11. Data-inventory queries (READ-ONLY — for the operator to run
--     against production BEFORE consumer cutover in Stage 2b).
--
--   SELECT count(*) AS owner_mismatch
--     FROM public.observation_images oi
--     JOIN public.observations o ON o.id = oi.observation_id
--    WHERE oi.user_id IS DISTINCT FROM o.user_id;
--
--   SELECT count(*) AS storage_bad_ns
--     FROM public.observation_images
--    WHERE storage_path IS NOT NULL AND storage_path <> ''
--      AND NOT (storage_path LIKE user_id::text || '/%');
--
--   SELECT count(*) AS original_bad_ns
--     FROM public.observation_images
--    WHERE original_storage_path IS NOT NULL AND original_storage_path <> ''
--      AND NOT (original_storage_path LIKE user_id::text || '/%');
--
--   SELECT count(*) AS mosaic_owner_mismatch
--     FROM public.spore_measurement_mosaics m
--     JOIN public.observations o ON o.id = m.observation_id
--    WHERE m.user_id IS DISTINCT FROM o.user_id;
--
-- Any non-zero result is a row that will be denied by the read-time
-- integrity checks in media_authorize_delivery /
-- media_authorize_mosaic_delivery. Remediate before consumer cutover.
-- =============================================================

COMMIT;
