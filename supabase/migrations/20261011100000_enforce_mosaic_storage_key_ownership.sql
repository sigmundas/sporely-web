-- Enforce spore-mosaic storage-key ownership.
--
-- Plan: docs/plans/active/2026-10-11-mosaic-storage-key-ownership.md
--
-- Before this migration a client could INSERT/UPDATE a mosaic row on its own
-- public observation whose storage_key pointed into another user's R2
-- namespace (and pick id / canonical_bucket / media_version freely);
-- media_authorize_mosaic_delivery then returned that key to the Worker.
--
-- This migration mirrors the observation_images path
-- (20260804120000_media_authorization.sql §6/§7/§9):
--   1. spore_measurement_mosaics.id becomes GENERATED ALWAYS; the identity
--      sequence is advanced past every id already claimed.
--   2. Write-time guards:
--        trg_00_media_guard_server_owned_mosaic   (BEFORE, INVOKER)
--        trg_01_media_guard_key_ownership_mosaic  (BEFORE, SECURITY DEFINER)
--        trg_zz_media_final_state_guard_mosaic    (AFTER,  SECURITY DEFINER)
--      They sort before trg_mosaic_media_version_bump.
--   3. Read-time: media_authorize_mosaic_delivery denies keys outside
--      `<mosaic user_id>/` (reason `invalid_storage_namespace`) BEFORE the
--      owner branch, for every row including trusted-role-written ones.
--
-- No data is changed. Existing malformed rows are denied at read time.

BEGIN;

-- =============================================================
-- 1. Identity: GENERATED ALWAYS + sequence advance.
--    The ALTER takes ACCESS EXCLUSIVE, so max(id) cannot move under the
--    setval below.
-- =============================================================

ALTER TABLE public.spore_measurement_mosaics ALTER COLUMN id SET GENERATED ALWAYS;

DO $$
DECLARE
  seq_name  text := pg_get_serial_sequence('public.spore_measurement_mosaics', 'id');
  max_id    bigint;
  last_val  bigint;
  called    boolean;
BEGIN
  SELECT max(id) INTO max_id FROM public.spore_measurement_mosaics;
  EXECUTE format('SELECT last_value, is_called FROM %s', seq_name)
    INTO last_val, called;
  IF max_id IS NOT NULL OR called THEN
    PERFORM setval(seq_name::regclass, GREATEST(COALESCE(max_id, last_val), last_val), true);
  END IF;
END $$;

-- =============================================================
-- 2a. Server-owned fields guard (BEFORE, SECURITY INVOKER).
--     Trust from current_user, as _media_guard_server_owned_fields_image.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_guard_server_owned_fields_mosaic()
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
          'spore_measurement_mosaics.canonical_bucket is server-owned and must default to ''legacy'' on client insert (got %)',
          NEW.canonical_bucket USING ERRCODE='insufficient_privilege';
      END IF;
      IF NEW.media_version IS NOT NULL AND NEW.media_version <> 1 THEN
        RAISE EXCEPTION
          'spore_measurement_mosaics.media_version is server-owned and must default to 1 on client insert (got %)',
          NEW.media_version USING ERRCODE='insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.canonical_bucket IS DISTINCT FROM OLD.canonical_bucket THEN
    IF NOT is_trusted THEN
      RAISE EXCEPTION
        'spore_measurement_mosaics.canonical_bucket may be changed only by a trusted role (got %)',
        current_user USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  IF NEW.media_version IS DISTINCT FROM OLD.media_version THEN
    IF is_trusted THEN
      NULL;
    ELSIF nested THEN
      IF NEW.media_version IS NULL THEN
        RAISE EXCEPTION 'spore_measurement_mosaics.media_version cannot be set to NULL'
          USING ERRCODE='insufficient_privilege';
      END IF;
      IF OLD.media_version IS NULL OR NEW.media_version <> OLD.media_version + 1 THEN
        RAISE EXCEPTION
          'nested spore_measurement_mosaics.media_version transition must be exactly OLD+1 (was %, now %)',
          OLD.media_version, NEW.media_version
          USING ERRCODE='insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION
        'spore_measurement_mosaics.media_version is server-owned and cannot be modified by role %',
        current_user USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_media_guard_server_owned_mosaic ON public.spore_measurement_mosaics;
CREATE TRIGGER trg_00_media_guard_server_owned_mosaic
  BEFORE INSERT OR UPDATE ON public.spore_measurement_mosaics
  FOR EACH ROW
  EXECUTE FUNCTION public._media_guard_server_owned_fields_mosaic();

-- =============================================================
-- 2b. Key-ownership guard (BEFORE, SECURITY DEFINER).
--     Trust boundary: auth.uid() IS NULL (service-role Worker PATCH,
--     migrations, operators). The key is validated on INSERT and only when
--     it changes on UPDATE, so an existing malformed row cannot make the
--     owner's observation updates fail through the version cascade.
--     Segment rules match the Worker's normalizeObjectKey.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_guard_key_ownership_mosaic()
  RETURNS TRIGGER LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path='public,pg_catalog'
AS $$
DECLARE
  caller_uid uuid := auth.uid();
  parent_owner uuid;
  expected_prefix text;
BEGIN
  IF caller_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM caller_uid THEN
    RAISE EXCEPTION
      'spore_measurement_mosaics.user_id (%) must equal auth.uid() (%)',
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
      'spore_measurement_mosaics.user_id (%) must equal observations.user_id (%)',
      NEW.user_id, parent_owner
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.storage_key IS DISTINCT FROM OLD.storage_key THEN
    expected_prefix := NEW.user_id::text || '/';
    IF NEW.storage_key IS NULL
       OR NOT starts_with(NEW.storage_key, expected_prefix)
       OR NEW.storage_key ~ '(^|/)\.{1,2}(/|$)'
       OR strpos(NEW.storage_key, '//') > 0
       OR right(NEW.storage_key, 1) = '/'
       OR strpos(NEW.storage_key, chr(92)) > 0
       OR NEW.storage_key ~ '[\x01-\x1f]' THEN
      RAISE EXCEPTION
        'spore_measurement_mosaics.storage_key must be a normalized key under the row owner''s prefix (%)',
        expected_prefix
        USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_01_media_guard_key_ownership_mosaic ON public.spore_measurement_mosaics;
CREATE TRIGGER trg_01_media_guard_key_ownership_mosaic
  BEFORE INSERT OR UPDATE ON public.spore_measurement_mosaics
  FOR EACH ROW
  EXECUTE FUNCTION public._media_guard_key_ownership_mosaic();

-- =============================================================
-- 2c. Final-state guard (AFTER, SECURITY DEFINER).
--     Catches any later BEFORE trigger that mutates NEW past 2a.
-- =============================================================

CREATE OR REPLACE FUNCTION public._media_final_state_guard_mosaic()
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
        'final-state guard: spore_measurement_mosaics.media_version must be 1 on client INSERT (got %)',
        NEW.media_version USING ERRCODE='insufficient_privilege';
    END IF;
    IF NEW.canonical_bucket IS DISTINCT FROM 'legacy' THEN
      RAISE EXCEPTION
        'final-state guard: spore_measurement_mosaics.canonical_bucket must be ''legacy'' on client INSERT (got %)',
        NEW.canonical_bucket USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.canonical_bucket IS DISTINCT FROM OLD.canonical_bucket THEN
    RAISE EXCEPTION
      'final-state guard: spore_measurement_mosaics.canonical_bucket transition rejected for client role'
      USING ERRCODE='insufficient_privilege';
  END IF;

  IF NEW.media_version IS DISTINCT FROM OLD.media_version THEN
    delta := COALESCE(NEW.media_version, 0) - COALESCE(OLD.media_version, 0);
    IF delta <> 1 THEN
      RAISE EXCEPTION
        'final-state guard: only monotonic +1 spore_measurement_mosaics.media_version transitions allowed for client role (delta=%)',
        delta USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_zz_media_final_state_guard_mosaic ON public.spore_measurement_mosaics;
CREATE TRIGGER trg_zz_media_final_state_guard_mosaic
  AFTER INSERT OR UPDATE ON public.spore_measurement_mosaics
  FOR EACH ROW
  EXECUTE FUNCTION public._media_final_state_guard_mosaic();

REVOKE ALL ON FUNCTION public._media_guard_server_owned_fields_mosaic() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._media_guard_server_owned_fields_mosaic() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public._media_guard_key_ownership_mosaic() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._media_guard_key_ownership_mosaic() FROM anon, authenticated;
REVOKE ALL ON FUNCTION public._media_final_state_guard_mosaic() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._media_final_state_guard_mosaic() FROM anon, authenticated;

-- =============================================================
-- 3. media_authorize_mosaic_delivery — adds invalid_storage_namespace.
--    Same signature and RETURNS TABLE as 20260804120000 §10. The
--    namespace check sits after no_key and BEFORE the owner branch: the
--    attacker owns the malformed row, so an owner-first check would
--    still hand them the foreign key.
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
  IF NOT starts_with(r.storage_key, r.mosaic_user_id::text || '/')
     OR r.storage_key ~ '(^|/)\.{1,2}(/|$)'
     OR strpos(r.storage_key, '//') > 0
     OR right(r.storage_key, 1) = '/'
     OR strpos(r.storage_key, chr(92)) > 0
     OR r.storage_key ~ '[\x01-\x1f]' THEN
    allowed := false; storage_key := NULL; cache_class := 'deny'; reason := 'invalid_storage_namespace';
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
  'permission. Read-time integrity: owner_mismatch, no_key, '
  'invalid_storage_namespace (key not a normalized path under '
  '<mosaic user_id>/; checked before the owner branch), invalid_bucket, '
  'invalid_media_version.';

COMMIT;
