-- Desktop write stop: refuse row writes from a listed desktop build.
--
-- Design: docs/plans/active/2026-10-14-sync-key-identity.md, "Desktop write
-- stop". A practical way to stop writes from a faulty newly released desktop
-- build without a deploy and without touching any other client.
--
--   1. private.sync_client_write_block(client_version, reason, created_at):
--      owner-only. Privileges are revoked from PUBLIC, anon, authenticated
--      and service_role; RLS is on with no policies. The migration creates it
--      EMPTY and inserts nothing, so nothing is blocked until an operator
--      lists a version.
--   2. private.sync_client_write_block_guard(): BEFORE INSERT/UPDATE/DELETE
--      row trigger on the seven desktop-synced tables. SECURITY DEFINER so it
--      can read the owner-only table; search_path '' and fully qualified
--      names. It reads only that table and PostgREST's request.headers, never
--      current_user, and writes nothing.
--
-- The check keys only on request headers, never on the database role. A
-- request is refused only when it carries x-sporely-sync-identity AND its
-- x-sporely-client-version is listed. Web, Android, every released desktop
-- (none sends the identity header), Edge Functions, migrations and plain SQL
-- sessions are never affected. RPC writes are covered too: the request's
-- headers stay visible inside the function, whoever it runs as.
--
-- Refusal: P0001 (HTTP 400, never 42501/403), hint sporely_upgrade_required,
-- fixed text with no row values and no auth or transient words.
--
-- Limit: media-worker requests are not blocked; a blocked build can still
-- move media bytes but cannot write the rows that reference them.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

-- =============================================================
-- 1. Block table (empty).
-- =============================================================

CREATE TABLE private.sync_client_write_block (
  client_version text PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.sync_client_write_block ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.sync_client_write_block FROM PUBLIC;
REVOKE ALL ON TABLE private.sync_client_write_block FROM anon, authenticated, service_role;

COMMENT ON TABLE private.sync_client_write_block IS
  'Desktop write stop. A desktop request carrying x-sporely-sync-identity whose x-sporely-client-version is listed here cannot write synced rows. Owner-only; empty means nothing is blocked.';

-- =============================================================
-- 2. Guard.
-- =============================================================

CREATE FUNCTION private.sync_client_write_block_guard()
  RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  headers jsonb := NULLIF(pg_catalog.current_setting('request.headers', true), '')::jsonb;
BEGIN
  IF headers ? 'x-sporely-sync-identity'
     AND EXISTS (SELECT 1 FROM private.sync_client_write_block b
                  WHERE b.client_version = headers ->> 'x-sporely-client-version') THEN
    RAISE EXCEPTION 'This version of Sporely Desktop is blocked from uploading. Install the latest version from sporely.no. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_upgrade_required';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.sync_client_write_block_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_client_write_block_guard() FROM anon, authenticated, service_role;

-- =============================================================
-- 3. Triggers. The aaa_ prefix fires first among BEFORE row triggers, so a
--    blocked write is refused before any other trigger does work; it never
--    displaces the zzz_sync_identity_guard_* triggers from last place.
-- =============================================================

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.observation_images
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.spore_measurements
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.spore_measurement_mosaics
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.spore_measurement_mosaic_tiles
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.observation_spore_summaries
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

CREATE TRIGGER aaa_sync_client_write_block
  BEFORE INSERT OR UPDATE OR DELETE ON public.observation_reference_uses
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_write_block_guard();

COMMIT;
