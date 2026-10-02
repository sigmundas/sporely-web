-- Operator maintenance: clear the stale v1-only device-capability records of
-- ONE account so the Stage M creation guard stops blocking new reference v2
-- content after all of that account's desktops were upgraded.
-- (Stage M, docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md,
-- "Operator procedure"; migration 20261002120000_reference_client_capability_minimum.sql.)
--
-- What it does: in one transaction, deletes the account's rows in
-- public.reference_client_devices whose reference_snapshot_versions lack 2
-- (the undeclared-writer pseudo-device, nil device_id, and any declared
-- v1-only device), then prints how many rows it removed and what remains for
-- that account. Nothing else is touched: no reference data, no policy,
-- function or guard. Idempotent: a second run deletes 0 and succeeds.
-- It does not disable future protection: the next sync write of a desktop
-- that does not declare [1,2] records itself again and the guard blocks new
-- v2 creation again for 30 days.
--
-- Preconditions: the operator has confirmed with the account owner that ALL
-- of the account's desktops run a release that declares
-- reference_snapshot_versions [1,2] (otherwise the old desktop simply
-- re-registers on its next write; nothing is lost, but nothing is gained).
--
-- Production execution requires explicit owner approval for that account
-- in the current conversation/ticket (AGENTS.md "Production writes by agents").
--
-- Usage:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v user_id=<account uuid> \
--     -f supabase/reference-client-devices-clear-stale.sql
-- Refuses (and changes nothing) when user_id is unset, not a uuid, or nil.

\set ON_ERROR_STOP 1
\if :{?user_id}
\else
  DO $$ BEGIN RAISE EXCEPTION 'refused: pass -v user_id=<account uuid>' USING ERRCODE = '22023'; END $$;
\endif

BEGIN;

SELECT pg_catalog.set_config('reference_maintenance.user_id', :'user_id', true) AS user_id;

DO $$
DECLARE v_user uuid;
BEGIN
  BEGIN
    v_user := pg_catalog.current_setting('reference_maintenance.user_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'refused: user_id is not a uuid' USING ERRCODE = '22023';
  END;
  IF v_user IS NULL OR v_user = '00000000-0000-0000-0000-000000000000' THEN
    RAISE EXCEPTION 'refused: user_id must be a real account id' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'refused: no such account' USING ERRCODE = '22023';
  END IF;
END
$$;

WITH removed AS (
  DELETE FROM public.reference_client_devices
   WHERE user_id = pg_catalog.current_setting('reference_maintenance.user_id')::uuid
     AND NOT (2 = ANY(reference_snapshot_versions))
  RETURNING 1
)
SELECT 'removed' AS section, count(*) AS rows FROM removed;

SELECT 'remaining' AS section, device_id, client, app_version,
       reference_snapshot_versions, last_seen_at
  FROM public.reference_client_devices
 WHERE user_id = pg_catalog.current_setting('reference_maintenance.user_id')::uuid
 ORDER BY last_seen_at DESC;

COMMIT;
