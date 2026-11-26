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
--
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

NOTIFY pgrst, 'reload schema';

COMMIT;
