-- Bans stop writes (work package B in
-- docs/plans/active/2026-11-25-security-scan-remaining-findings.md).
--
-- Until now a ban only hid the user's content; SUPABASE_DB.md claimed a
-- write-blocking trigger that did not exist. The upload worker already refuses
-- a banned user's media uploads.
--
-- private.refuse_banned_writer() is a BEFORE INSERT OR UPDATE row trigger on
-- every client-writable user-content table. It refuses the write when the
-- signed-in caller (auth.uid()) is banned or has no profile row (an account
-- that is part-way through deletion). Deliberately allowed:
--   * DELETE, so a banned user can still remove their data;
--   * an UPDATE that only tombstones a row: deleted_at goes from NULL to a
--     value, and only updated_at and row_version move with it, because web and
--     desktop delete images that way and the reference sync RPCs bump
--     row_version and updated_at on a tombstone;
--   * on profiles, an UPDATE that touches only the activity columns
--     record_client_activity maintains (passed as trigger arguments);
--   * writes with no auth.uid() (service role, admin tooling, migrations);
--   * writes issued by another trigger or a foreign-key action
--     (pg_trigger_depth() > 1), so a permitted DELETE can still cascade.
-- SECURITY DEFINER RPCs the banned user calls are refused: their writes reach
-- the trigger at depth 1 with the caller's auth.uid().
--
-- Not covered on purpose: user_blocks (blocking others protects them),
-- client_activity_daily and reference_client_devices (telemetry). The curation
-- and contribution-share RPCs already refuse banned users themselves. Storage
-- buckets (avatars) are outside this trigger.
--
-- Trigger order: trg_000_writer_not_banned sorts after trg_000_sync_brake, so
-- an obsolete desktop still gets its upgrade answer first, and before every
-- trigger that rewrites NEW (media guards, version bumps, updated_at), so it
-- compares what the client or RPC wrote. The only BEFORE triggers ahead of it
-- raise or skip.
--
-- The comments read policy from 20261125230000 also lets an author read their
-- own comments again, so a banned author can still delete them (Postgres
-- applies the SELECT policy to a filtered DELETE).

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

  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = caller AND p.is_banned IS NOT TRUE
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_row := pg_catalog.to_jsonb(OLD);
    new_row := pg_catalog.to_jsonb(NEW);
    ignored := COALESCE(TG_ARGV::text[], ARRAY[]::text[]);

    -- Only the columns named as trigger arguments change.
    IF (new_row - ignored) = (old_row - ignored) THEN
      RETURN NEW;
    END IF;

    -- A tombstone: deleted_at goes from NULL to a value; only updated_at and
    -- row_version may move with it.
    IF old_row ? 'deleted_at'
       AND old_row ->> 'deleted_at' IS NULL
       AND new_row ->> 'deleted_at' IS NOT NULL
       AND (new_row - ignored - ARRAY['deleted_at', 'updated_at', 'row_version'])
         = (old_row - ignored - ARRAY['deleted_at', 'updated_at', 'row_version']) THEN
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
  'BEFORE INSERT OR UPDATE guard: refuses writes by a banned auth.uid() or one '
  'without a profile. Allows DELETE, tombstone updates, updates that touch '
  'only the trigger arguments, service-role writes and nested trigger writes.';

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
    EXECUTE format(
      'CREATE TRIGGER trg_000_writer_not_banned BEFORE INSERT OR UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION private.refuse_banned_writer()', t);
  END LOOP;
END
$$;

CREATE TRIGGER trg_000_writer_not_banned
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION private.refuse_banned_writer('last_client', 'last_app_version', 'last_client_seen_at');

-- Comments: authors read their own comments, so they can delete them.
DROP POLICY IF EXISTS phase7_comments_read ON public.comments;

CREATE POLICY phase7_comments_read
  ON public.comments
  FOR SELECT
  TO authenticated
  USING (
    public.can_access_observation_comments(observation_id)
    AND NOT public.is_comment_hidden(id)
    AND (
      auth.uid() = user_id
      OR public.comment_author_is_visible(user_id)
    )
  );

COMMIT;
