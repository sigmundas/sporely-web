-- Bans stop writes (work package B in
-- docs/plans/active/2026-11-25-security-scan-remaining-findings.md).
--
-- Until now a ban only hid the user's content; SUPABASE_DB.md claimed a
-- write-blocking trigger that did not exist. The upload worker already refuses
-- a banned user's media uploads.
--
-- private.refuse_banned_writer() is a BEFORE INSERT OR UPDATE row trigger on
-- every client-writable user-content table. It refuses the write when the
-- signed-in caller (auth.uid()) is banned. Deliberately allowed:
--   * DELETE, so a banned user can still remove their data;
--   * an UPDATE that only tombstones a row (deleted_at NULL -> set), because
--     web and desktop delete images and reference rows that way;
--   * an UPDATE that changes no column other than updated_at and the trigger's
--     arguments (profiles passes the activity columns record_client_activity
--     maintains);
--   * writes with no auth.uid() (service role, admin tooling, migrations);
--   * writes issued by another trigger or a foreign-key action
--     (pg_trigger_depth() > 1), so a permitted DELETE can still cascade.
-- SECURITY DEFINER RPCs the banned user calls are refused: their writes reach
-- the trigger at depth 1 with the caller's auth.uid().
--
-- Not covered on purpose: user_blocks (blocking others protects them) and
-- client_activity_daily (telemetry). The curation RPCs already refuse banned
-- users themselves.
--
-- The trigger is named aab_* so it runs right after aaa_sync_client_write_block
-- and before any trigger that rewrites NEW, so it compares what the client sent.

BEGIN;

CREATE OR REPLACE FUNCTION private.refuse_banned_writer()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  caller uuid := auth.uid();
  old_row jsonb;
  new_row jsonb;
  ignored text[];
BEGIN
  IF caller IS NULL OR pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = caller AND p.is_banned IS TRUE
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_row := pg_catalog.to_jsonb(OLD);
    new_row := pg_catalog.to_jsonb(NEW);
    ignored := ARRAY['updated_at'] || COALESCE(TG_ARGV::text[], ARRAY[]::text[]);

    -- Nothing the user can see changes.
    IF (new_row - ignored) = (old_row - ignored) THEN
      RETURN NEW;
    END IF;

    -- A tombstone: deleted_at goes from NULL to a value, nothing else moves.
    IF old_row ? 'deleted_at'
       AND old_row ->> 'deleted_at' IS NULL
       AND new_row ->> 'deleted_at' IS NOT NULL
       AND (new_row - ignored - 'deleted_at') = (old_row - ignored - 'deleted_at') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'This account is suspended. Nothing was changed.'
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'sporely_account_suspended';
END;
$$;

REVOKE ALL ON FUNCTION private.refuse_banned_writer() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION private.refuse_banned_writer() IS
  'BEFORE INSERT OR UPDATE guard: refuses writes by a banned auth.uid(). '
  'Allows DELETE, tombstone updates, updates that touch only updated_at and '
  'the trigger arguments, service-role writes and nested trigger writes.';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'calibrations',
    'comments',
    'follows',
    'friendships',
    'observation_identifications',
    'observation_images',
    'observation_reference_uses',
    'observation_shares',
    'observation_spore_summaries',
    'observations',
    'reference_curated_forks',
    'reference_measurement_sets',
    'reference_taxon_treatments',
    'reference_works',
    'reports',
    'spore_annotations',
    'spore_measurement_mosaic_tiles',
    'spore_measurement_mosaics',
    'spore_measurements'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS aab_refuse_banned_writer ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER aab_refuse_banned_writer BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION private.refuse_banned_writer()', t);
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS aab_refuse_banned_writer ON public.profiles;
CREATE TRIGGER aab_refuse_banned_writer
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION private.refuse_banned_writer('last_client', 'last_app_version', 'last_client_seen_at');

COMMIT;
