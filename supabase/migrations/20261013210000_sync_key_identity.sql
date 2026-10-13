-- Immutable per-user sync keys and the sync identity guard (stage S1).
--
-- Design: g4-evidence PROPOSAL-desktop-id-identity.md §4 "Server (step 1,
-- additive)" with Revisions 3.1-5; U7 decision in
-- identity-design/VERIFY-identity-rules.md.
--
-- Additive only:
--   1. sync_key uuid NULL on observations, observation_images and
--      spore_measurements. No default and no backfill: existing cloud rows
--      keep NULL, so no device can later claim them by key.
--   2. Unique partial indexes on (user_id, sync_key) WHERE sync_key IS NOT
--      NULL. Uniqueness is per user, so a duplicate key is never a
--      cross-tenant oracle. A retried insert gets 23505 naming the index,
--      which the client matches by constraint name (the old
--      *_desktop_id_user_unique collision is also 23505).
--   3. public._sync_identity_guard() (BEFORE INSERT OR UPDATE, INVOKER):
--        rule 1 (all roles)  : an UPDATE may not change sync_key;
--        rule 2 (non-trusted): a row may not carry both sync_key and
--                              desktop_id, on INSERT or UPDATE.
--      Trust is judged by current_user, which is only meaningful because the
--      function is SECURITY INVOKER (a DEFINER guard would see its owner).
--      Errors are P0001 (HTTP 400) with fixed text and the hint
--      sporely_sync_identity_refused; no row values are echoed.
--   4. Triggers zzz_sync_identity_guard_{obs,image,measurement}: the zzz_
--      prefix sorts last among BEFORE triggers, so the guard checks the final
--      NEW after any other BEFORE trigger has run (U7).
--
-- RLS policies are unchanged; the owner policies cover the new column. No
-- non-owner view selects sync_key (they list columns explicitly), and none
-- is rebuilt here: removing desktop_id from them belongs to the cutover.

BEGIN;

-- =============================================================
-- 1. Columns.
-- =============================================================

ALTER TABLE public.observations ADD COLUMN sync_key uuid;
ALTER TABLE public.observation_images ADD COLUMN sync_key uuid;
ALTER TABLE public.spore_measurements ADD COLUMN sync_key uuid;

COMMENT ON COLUMN public.observations.sync_key IS
  'Client-minted per-record sync identity. Set only at INSERT, immutable afterwards; unique per user. NULL for rows created before sync keys.';
COMMENT ON COLUMN public.observation_images.sync_key IS
  'Client-minted per-record sync identity. Set only at INSERT, immutable afterwards; unique per user. NULL for rows created before sync keys.';
COMMENT ON COLUMN public.spore_measurements.sync_key IS
  'Client-minted per-record sync identity. Set only at INSERT, immutable afterwards; unique per user. NULL for rows created before sync keys.';

-- =============================================================
-- 2. Per-user uniqueness.
-- =============================================================

CREATE UNIQUE INDEX observations_user_sync_key_uidx
  ON public.observations (user_id, sync_key) WHERE sync_key IS NOT NULL;
CREATE UNIQUE INDEX observation_images_user_sync_key_uidx
  ON public.observation_images (user_id, sync_key) WHERE sync_key IS NOT NULL;
CREATE UNIQUE INDEX spore_measurements_user_sync_key_uidx
  ON public.spore_measurements (user_id, sync_key) WHERE sync_key IS NOT NULL;

-- =============================================================
-- 3. Guard.
-- =============================================================

CREATE FUNCTION public._sync_identity_guard()
  RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  is_trusted boolean := current_user IN ('postgres', 'service_role', 'supabase_admin');
BEGIN
  -- Rule 1 (all roles): keys are written once, at INSERT. A row that was
  -- linked without a key can never be given one later.
  IF TG_OP = 'UPDATE' AND NEW.sync_key IS DISTINCT FROM OLD.sync_key THEN
    RAISE EXCEPTION 'Sporely sync key cannot be changed. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_sync_identity_refused';
  END IF;

  -- Rule 2 (non-trusted callers): a keyed row never carries a desktop_id
  -- reverse link, so an old client cannot plant one on it.
  IF NOT is_trusted AND NEW.sync_key IS NOT NULL AND NEW.desktop_id IS NOT NULL THEN
    RAISE EXCEPTION 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_sync_identity_refused';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._sync_identity_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._sync_identity_guard() FROM anon, authenticated;

-- =============================================================
-- 4. Triggers. Names sort last among BEFORE triggers on each table.
-- =============================================================

CREATE TRIGGER zzz_sync_identity_guard_obs
  BEFORE INSERT OR UPDATE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public._sync_identity_guard();

CREATE TRIGGER zzz_sync_identity_guard_image
  BEFORE INSERT OR UPDATE ON public.observation_images
  FOR EACH ROW EXECUTE FUNCTION public._sync_identity_guard();

CREATE TRIGGER zzz_sync_identity_guard_measurement
  BEFORE INSERT OR UPDATE ON public.spore_measurements
  FOR EACH ROW EXECUTE FUNCTION public._sync_identity_guard();

COMMIT;
