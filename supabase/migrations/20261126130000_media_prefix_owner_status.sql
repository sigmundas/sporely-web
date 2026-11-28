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

-- Rows of OTHER owners whose media key mentions '<p_user_id>/' anywhere, in
-- any of the eight key columns private.media_key_references covers. The
-- media-key guard refuses new cross-owner keys, but a legacy row or a data
-- restore can still point into a deleted account's prefix, and the web
-- reader accepts alias forms (full media or Storage URLs, a 'sporely-media/'
-- or 'observation-images/' prefix, a leading slash) that the key-family
-- lookup does not match. A substring match on '<uid>/' (case-insensitive)
-- catches every such form. Any match leaves the whole prefix for review.
-- Rows of p_user_id itself do not count: they are the account's own leftovers.
-- Sequential scans of the key columns; the sweep calls it once per prefix.
CREATE FUNCTION public.media_prefix_foreign_references(p_user_id uuid)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_needle text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22023';
  END IF;
  v_needle := p_user_id::text || '/';
  RETURN (
    SELECT pg_catalog.count(*) FROM (
      SELECT i.user_id AS owner_id, i.storage_path AS key FROM public.observation_images i
      UNION ALL SELECT i.user_id, i.original_storage_path FROM public.observation_images i
      UNION ALL SELECT m.user_id, m.image_key FROM public.spore_measurements m
      UNION ALL SELECT m.user_id, m.thumb_key FROM public.spore_measurements m
      UNION ALL SELECT o.user_id, o.image_key FROM public.observations o
      UNION ALL SELECT o.user_id, o.thumb_key FROM public.observations o
      UNION ALL SELECT s.user_id, s.storage_key FROM public.spore_measurement_mosaics s
      UNION ALL SELECT c.user_id, c.image_storage_path FROM public.calibrations c
    ) r
    WHERE r.key IS NOT NULL
      AND r.owner_id IS DISTINCT FROM p_user_id
      AND pg_catalog.strpos(pg_catalog.lower(r.key), v_needle) > 0
  );
END
$$;

REVOKE ALL ON FUNCTION public.media_prefix_foreign_references(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_prefix_foreign_references(uuid) TO service_role;

COMMENT ON FUNCTION public.media_prefix_foreign_references(uuid) IS
  'admin-ops orphan prefix sweep: number of media key values of owners other than p_user_id '
  'that mention <p_user_id>/ anywhere (any alias form). Service role only.';

NOTIFY pgrst, 'reload schema';

COMMIT;
