-- Obsolete-desktop sync brake.
--
-- Stage: 2026-10-13-obsolete-desktop-sync-brake.
-- Runbook: docs/deployments/2026-10-13-obsolete-desktop-sync-brake-runbook.md
--
-- Purpose
-- -------
-- Every shipped Sporely desktop (v0.8.13 up to and including the current
-- release) resolves which cloud observation to write through the shared
-- `desktop_id` reverse link. Two installations on one account (two computers,
-- a reinstall or a copied database) number their local rows independently, so
-- one device can PATCH its new observation over another device's cloud row,
-- silently. Until a desktop that uses per-record sync keys ships, the server
-- refuses every write from these obsolete clients to the tables they can
-- corrupt this way. Refusing only `desktop_id` changes is not enough: the
-- location RPC carries no `desktop_id` and still overwrote another device's
-- row when column privileges were tried.
--
-- Who is braked
-- -------------
-- A row write is refused when ALL of these hold:
--   * it came through the Data API (PostgREST sets `request.headers`);
--   * the JWT role is `authenticated` or `anon`;
--   * the request has no `x-sporely-sync-identity: 2` header;
--   * the lower-cased User-Agent starts with `python-requests/`. Every shipped
--     desktop sends the python-requests default for its cloud traffic.
-- The trigger is a row trigger, so it also fires for writes made inside RPCs,
-- including SECURITY DEFINER ones: PostgREST's request settings stay set for
-- the whole transaction.
--
-- Not braked: service_role and the other server roles, direct database
-- sessions (migrations, cron, dashboard SQL), web and Android (browser and
-- WebView User-Agents), and a future desktop that sends
-- `x-sporely-sync-identity: 2`. Reads are not affected.
--
-- The User-Agent test holds back HONEST old clients. It is NOT an
-- authorization boundary: any caller can choose its User-Agent and headers.
-- Row-level security and the existing guards remain the authorization layer.
-- A non-desktop Python script that uses an end-user JWT with the default
-- User-Agent is braked too.
--
-- Refusal
-- -------
-- SQLSTATE P0001 with HINT `sporely_upgrade_required`; PostgREST returns HTTP
-- 400. The message avoids every authentication and transient-error hint word
-- in the shipped desktops' classifiers, so they record an ordinary per-row
-- failure: no sign-out, no token refresh, no retry loop, and local data stays
-- unsynced on the computer.
--
-- Pair with the media worker
-- --------------------------
-- The media worker refuses the same clients' media uploads and deletes
-- (`cloudflare/r2-upload-worker/src/obsolete-desktop-guard.js`). Deploy the
-- worker first: with only this migration, an old desktop deleting an
-- observation removes its media through the worker before this trigger
-- refuses the row delete.
--
-- Removal rule
-- ------------
-- This brake is removed ONLY by the future sync-key cutover migration, in the
-- same transaction that installs the permanent identity gate. It is never
-- removed as a rollback: dropping it reactivates unsafe desktop
-- synchronization for every obsolete client. If it misfires on a legitimate
-- client, the fix is a forward migration that narrows the identification
-- rule in private.sync_brake_guard(). There is deliberately no down
-- migration.
--
-- Braked tables (inventory of shipped-desktop writes: the stage notes)
-- --------------------------------------------------------------------
--   observations, observation_images, spore_measurements,
--   spore_measurement_mosaics, spore_measurement_mosaic_tiles
--     - written directly and resolved through the desktop_id reverse link,
--       or children attached to such a resolved parent.
--   observation_spore_summaries
--     - inserted, patched and deleted per resolved remote observation id.
--   observation_reference_uses
--     - attached to a client-supplied observation id through the
--       sync_observation_reference_use RPC.
-- Trigger order
-- -------------
-- Each trigger is named trg_000_sync_brake so that it sorts, and fires,
-- before the existing trg_* BEFORE triggers (trg_00_*, trg_01_*, ...). It does
-- NOT fire first on every table. PostgreSQL fires BEFORE row triggers in name
-- order (C collation), and on public.observations three earlier-sorting
-- triggers run before the brake:
--   * enforce_non_public_observation_limit_trigger (row);
--   * guard_selected_sporely_taxon_id_v2_trg (row);
--   * observation_taxon_shared_reference_rate_row_trg (row), which acts on the
--     verdict of the statement-level observation_taxon_shared_reference_rate_trg
--     (statement triggers fire before all row triggers, whatever their name).
-- Each of them can only raise or skip the row; none writes anything the
-- brake would have refused. When an obsolete desktop's taxon PATCH is
-- rate-limited, the row trigger skips the row, the brake never sees it and
-- the desktop gets HTTP 429 with Retry-After instead of the upgrade refusal.
-- Nothing is written in that case either. The pgTAP test and runbook check
-- 3c assert that exactly these three row triggers sort before the brake.

BEGIN;

CREATE OR REPLACE FUNCTION private.sync_brake_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text;
  v_ua      text;
BEGIN
  IF v_headers IS NULL THEN
    RETURN coalesce(NEW, OLD);              -- not an API request
  END IF;
  v_role := coalesce(v_claims ->> 'role', '');
  IF v_role NOT IN ('authenticated', 'anon') THEN
    RETURN coalesce(NEW, OLD);              -- service_role and server roles
  END IF;
  IF coalesce(v_headers ->> 'x-sporely-sync-identity', '') = '2' THEN
    RETURN coalesce(NEW, OLD);              -- sync-key desktop
  END IF;
  v_ua := lower(coalesce(v_headers ->> 'user-agent', ''));
  IF v_ua LIKE 'python-requests/%' THEN
    RAISE EXCEPTION 'Sporely Desktop must be updated before it can upload to Sporely Cloud. Install the latest version from sporely.no. Nothing was changed in the cloud.'
      USING ERRCODE = 'P0001', HINT = 'sporely_upgrade_required';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;

COMMENT ON FUNCTION private.sync_brake_guard() IS
  'Obsolete-desktop sync brake (20261013200000). Refuses row writes from shipped desktops (python-requests User-Agent, end-user JWT, no x-sporely-sync-identity: 2) with P0001 / sporely_upgrade_required. Not an authorization boundary. Removed only by the sync-key cutover migration, never as a rollback.';

REVOKE ALL ON FUNCTION private.sync_brake_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.sync_brake_guard() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.observations;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.observation_images;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.observation_images
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.spore_measurements;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.spore_measurements
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.spore_measurement_mosaics;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.spore_measurement_mosaics
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.spore_measurement_mosaic_tiles;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.spore_measurement_mosaic_tiles
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.observation_spore_summaries;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.observation_spore_summaries
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

DROP TRIGGER IF EXISTS trg_000_sync_brake ON public.observation_reference_uses;
CREATE TRIGGER trg_000_sync_brake BEFORE INSERT OR UPDATE OR DELETE ON public.observation_reference_uses
  FOR EACH ROW EXECUTE FUNCTION private.sync_brake_guard();

COMMIT;
