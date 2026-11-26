-- Owner status of top-level R2 media prefixes, for the admin-ops orphan
-- prefix sweep (action sweep_orphan_media_prefixes; plan
-- docs/plans/active/2026-10-20-media-key-retirement-and-cloud-copy-delete.md,
-- finding 9).
--
-- Every media key lives under '<user_id>/'. A prefix may be swept (all of its
-- objects deleted) only when its account is gone or being deleted:
--   * no profile row and no auth user: the account is fully deleted (the
--     account-deletion marker cascades with the auth user);
--   * no profile row, the auth user still exists, and the account-deletion
--     marker private.reference_account_deletions is set: a deletion run got
--     past delete_profile but never finished its media sweep.
-- A prefix whose account has a profile is live. One with an auth user but no
-- profile and no marker is not swept: the sweep reports it for review.
-- The rule lives here only; admin-ops acts on `sweepable`.
-- media_prefix_foreign_references (below) reports other owners' rows that
-- still point into such a prefix; admin-ops then leaves it for review.
--
-- Needs 20261126120000 (private.media_key_root, media_key_references).
-- Service role only. Read-only.

BEGIN;

CREATE FUNCTION public.media_prefix_owner_status(p_user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  has_profile boolean,
  has_auth_user boolean,
  deletion_marked boolean,
  sweepable boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(pg_catalog.cardinality(p_user_ids), 0) > 1000 THEN
    RAISE EXCEPTION 'media_prefix_owner_status takes at most 1000 ids'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT s.id,
         s.has_profile,
         s.has_auth_user,
         s.deletion_marked,
         (NOT s.has_profile AND (NOT s.has_auth_user OR s.deletion_marked))
    FROM (
      SELECT u.id,
             EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id) AS has_profile,
             EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id) AS has_auth_user,
             EXISTS (SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id = u.id) AS deletion_marked
        FROM (SELECT DISTINCT x AS id FROM pg_catalog.unnest(p_user_ids) AS x WHERE x IS NOT NULL) u
    ) s;
END
$$;

REVOKE ALL ON FUNCTION public.media_prefix_owner_status(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_prefix_owner_status(uuid[]) TO service_role;

COMMENT ON FUNCTION public.media_prefix_owner_status(uuid[]) IS
  'admin-ops orphan prefix sweep: per user id, whether a profile, an auth user and the '
  'account-deletion marker exist, and whether the <user_id>/ media prefix may be swept '
  '(no profile, and no auth user or the deletion marker set). Service role only.';

-- Rows of OTHER owners that still reference the key families of p_keys
-- (through private.media_key_references, 20261126120000, on the key-root
-- expression indexes). The media-key guard refuses new cross-owner keys, but
-- a legacy row or a data restore can still point into a deleted account's
-- prefix; the sweep then leaves that prefix for review instead of deleting
-- bytes a live user shows. Rows of p_user_id itself do not count: they are
-- the deleted account's own leftovers.
CREATE FUNCTION public.media_prefix_foreign_references(p_user_id uuid, p_keys text[])
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_roots text[];
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(pg_catalog.cardinality(p_keys), 0) > 1000 THEN
    RAISE EXCEPTION 'media_prefix_foreign_references takes at most 1000 keys'
      USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT private.media_key_root(k))
    INTO v_roots
    FROM pg_catalog.unnest(p_keys) AS k
   WHERE private.media_key_root(k) IS NOT NULL;
  IF v_roots IS NULL THEN
    RETURN 0;
  END IF;
  RETURN (SELECT pg_catalog.count(*) FROM private.media_key_references(v_roots) r
           WHERE r.owner_id IS DISTINCT FROM p_user_id);
END
$$;

REVOKE ALL ON FUNCTION public.media_prefix_foreign_references(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_prefix_foreign_references(uuid, text[]) TO service_role;

COMMENT ON FUNCTION public.media_prefix_foreign_references(uuid, text[]) IS
  'admin-ops orphan prefix sweep: number of rows of owners other than p_user_id that '
  'reference the key families of p_keys (at most 1000 keys). Service role only.';

NOTIFY pgrst, 'reload schema';

COMMIT;
