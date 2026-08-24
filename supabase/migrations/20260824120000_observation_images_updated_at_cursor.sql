-- Add a server-maintained change cursor (updated_at) to observation_images so
-- desktop clients can probe for changed images using a keyset query:
--   WHERE user_id = ? AND (updated_at > ts OR (updated_at = ts AND id > last_id))
--   ORDER BY updated_at, id
--
-- Design decisions
-- ----------------
-- 1. Column: updated_at timestamptz NOT NULL DEFAULT now().
-- 2. Backfill: uses historical server timestamps only (GREATEST of created_at,
--    deleted_at, purged_at; falls back to now() only if all three are NULL).
--    captured_at is client-supplied and is not used.
-- 3. Trigger: trg_05_observation_images_set_updated_at (BEFORE INSERT OR UPDATE)
--    forces NEW.updated_at := now() unconditionally for EVERY role, including
--    service_role/postgres. The historical backfill runs before the trigger is
--    created, so no role-based bypass exists after the migration completes.
--    Alphabetically between trg_01_ and trg_zz_; no dependency on guard
--    triggers; only mutates NEW — no DML, no recursion.
-- 4. Index: (user_id, updated_at, id) for the desktop keyset probe.

BEGIN;

-- =============================================================
-- 1. Add column (nullable first so backfill can populate it).
-- =============================================================

ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;

COMMENT ON COLUMN public.observation_images.updated_at IS
  'Server-maintained change cursor. Set to now() by trigger on EVERY INSERT or '
  'UPDATE, regardless of caller role — service-role/admin writes (purge '
  'finalization, ban cascades) advance it too. Historical values come only from '
  'the migration backfill, which ran before the trigger existed. Used by desktop '
  'clients for incremental pull via keyset: user_id=? AND updated_at>ts (or '
  'equal with id tiebreak), ORDER BY updated_at, id. Hard DELETEs leave no '
  'cursor trace; desktop covers those via the periodic full child safety scan.';

-- =============================================================
-- 2. Backfill using historical server timestamps only.
--    GREATEST() ignores NULLs; COALESCE catches the all-NULL edge.
-- =============================================================

-- The parent-touch trigger (trg_observation_images_touch_observation_updated_at)
-- is a row-level AFTER UPDATE trigger with no column list, so without disabling
-- it this backfill would stamp observations.updated_at = migration-now for every
-- observation that has images, forcing a fleet-wide observation re-pull. The
-- transaction already holds an exclusive lock from the ALTER TABLE, so a
-- temporary DISABLE is safe and unobservable to concurrent sessions.
ALTER TABLE public.observation_images
  DISABLE TRIGGER trg_observation_images_touch_observation_updated_at;

UPDATE public.observation_images
SET updated_at = COALESCE(
  GREATEST(created_at, deleted_at, purged_at),
  now()
)
WHERE updated_at IS NULL;

ALTER TABLE public.observation_images
  ENABLE TRIGGER trg_observation_images_touch_observation_updated_at;

-- =============================================================
-- 3. Enforce NOT NULL now that all rows have a value.
-- =============================================================

ALTER TABLE public.observation_images
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now();

-- =============================================================
-- 4. Trigger function: force updated_at := now() unconditionally
--    for every role on both INSERT and UPDATE.
--    NOT SECURITY DEFINER — runs as the invoking role.
--    Only mutates NEW; no DML; no recursion risk.
-- =============================================================

CREATE OR REPLACE FUNCTION public._observation_images_set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
AS $$
BEGIN
  -- Unconditional for every role: the cursor's correctness depends on the row
  -- changing, not on who changed it. Service-role/admin writes (purge
  -- finalization, ban cascades, repair tools) must advance the cursor too.
  -- The historical backfill runs BEFORE this trigger is created, so no
  -- role-based bypass is needed or provided.
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public._observation_images_set_updated_at() IS
  'BEFORE INSERT OR UPDATE trigger function. Forces updated_at := now() '
  'unconditionally for every role — no trusted-role exemption. Historical '
  'backfill values were written before this trigger was created. Mutates '
  'NEW only — no DML, no recursion.';

DROP TRIGGER IF EXISTS trg_05_observation_images_set_updated_at
  ON public.observation_images;

CREATE TRIGGER trg_05_observation_images_set_updated_at
  BEFORE INSERT OR UPDATE
  ON public.observation_images
  FOR EACH ROW
  EXECUTE FUNCTION public._observation_images_set_updated_at();

-- =============================================================
-- 5. Index for desktop keyset probe.
-- =============================================================

CREATE INDEX IF NOT EXISTS observation_images_user_updated_at_id_idx
  ON public.observation_images (user_id, updated_at, id);

COMMENT ON INDEX public.observation_images_user_updated_at_id_idx IS
  'Supports desktop incremental pull: user_id=? AND (updated_at > ts OR '
  '(updated_at = ts AND id > last_id)) ORDER BY updated_at, id. The existing '
  'single-column (user_id) index would scan all rows for a user; this covers '
  'both filter and sort in one index scan.';

COMMIT;
