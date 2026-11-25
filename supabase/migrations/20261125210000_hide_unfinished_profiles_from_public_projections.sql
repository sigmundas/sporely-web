-- A profile's seeded identity is not public until its owner finishes setup.
--
-- handle_new_user() seeds every new profile with username = the local part
-- of the sign-up email and display_name = the identity provider's full name
-- (20260614192617). Those values are a prefill for the profile setup screen;
-- the user has not seen or accepted them until the setup save sets
-- profile_completed_at (20260805130000).
--
-- Five functions returned the seeded values to someone other than the owner:
--
--   1. search_people_directory(integer, integer, text) -- executable by anon;
--      listed every unfinished account.
--   2. read_public_profiles(), behind the public_profiles view -- selectable
--      by anon; same listing.
--   3. community_contributor_label(uuid, text) -- executable by anon; returned
--      display_name / username for any profile id, and labels public
--      observations (observer name, and the name filter of
--      search_public_observations).
--   4. get_blocked_user_profiles() -- a signed-in user can block any id
--      (user_blocks only checks blocker_id) and then read its names.
--   5. private.shared_reference_contribution_envelope(...) -- writes the
--      username into the contributor label of a publicly shared reference.
--      Sharing is on by default (20261001113007), so an account that only
--      ever used the desktop app would publish its email local part.
--
-- Each now treats an unfinished profile as having no public name:
--
--   1, 2  the row is not returned;
--   3     the label falls back to fallback_author, as it does for a missing
--         profile;
--   4     the block row is still returned (so it can be unblocked) with NULL
--         username and display_name;
--   5     new revisions carry the neutral label 'Sporely user'. Envelopes
--         already stored are immutable and are served as stored, so this
--         migration refuses to apply if an unfinished account already owns
--         a shared-reference contribution (see the guard below).
--
-- The owner still reads their own row through the owner-only profiles table,
-- so the setup screen keeps its prefill. Signatures, return types,
-- search_path, ownership and grants are untouched (CREATE OR REPLACE
-- preserves the ACL), and public_profiles keeps reading
-- read_public_profiles().
--
-- Effect on signed-in users: an account that has not finished setup no longer
-- resolves to a name in friend lists, friend requests, mention search or
-- author lookups, the same way a banned or blocked account already does not.

BEGIN;

-- Rollout guard for path 5. A stored contribution envelope keeps the label it
-- was written with and the public readers return it unchanged, so changing
-- the envelope function cannot retract a seeded username that is already
-- published. Fail here, before anything changes, rather than report the
-- path closed while such a label is still being served.
DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count
  FROM private.shared_reference_contributions c
  JOIN public.profiles p ON p.id = c.owner_id
  WHERE p.profile_completed_at IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      '% shared-reference contribution(s) belong to an account that has not finished profile setup; their stored envelopes may carry a seeded username. Resolve those before applying 20261125210000.',
      v_count;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.read_public_profiles()
RETURNS TABLE (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  bio text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.bio
  FROM public.profiles p
  WHERE p.is_banned IS NOT TRUE
    AND p.profile_completed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_blocks ub
      WHERE (ub.blocker_id = auth.uid() AND ub.blocked_id = p.id)
         OR (ub.blocker_id = p.id AND ub.blocked_id = auth.uid())
    )
$$;

CREATE OR REPLACE FUNCTION public.search_people_directory(
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0,
  p_query text DEFAULT NULL::text
)
RETURNS TABLE(
  user_id uuid,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  public_find_count bigint,
  public_species_count bigint,
  public_spore_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH normalized AS (
    SELECT
      nullif(btrim(coalesce(p_query, '')), '') AS q,
      greatest(1, least(coalesce(p_limit, 24), 100)) AS lim,
      greatest(coalesce(p_offset, 0), 0) AS off
  ),
  visible_profiles AS (
    SELECT
      p.id,
      p.username,
      p.display_name,
      p.bio,
      p.avatar_url
    FROM public.profiles p
    CROSS JOIN normalized n
    WHERE p.is_banned IS NOT TRUE
      AND p.profile_completed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks ub
        WHERE (ub.blocker_id = auth.uid() AND ub.blocked_id = p.id)
           OR (ub.blocker_id = p.id AND ub.blocked_id = auth.uid())
      )
      AND (
        n.q IS NULL
        OR coalesce(p.username, '') ILIKE '%' || n.q || '%'
        OR coalesce(p.display_name, '') ILIKE '%' || n.q || '%'
      )
  ),
  visible_profiles_with_stats AS (
    SELECT
      vp.id,
      vp.username,
      vp.display_name,
      vp.bio,
      vp.avatar_url,
      coalesce(s.public_find_count, 0) AS public_find_count,
      coalesce(s.public_species_count, 0) AS public_species_count,
      coalesce(s.public_spore_count, 0) AS public_spore_count
    FROM visible_profiles vp
    LEFT JOIN LATERAL public.get_person_stats(vp.id) s ON true
  )
  SELECT
    vps.id AS user_id,
    vps.username,
    vps.display_name,
    vps.bio,
    vps.avatar_url,
    vps.public_find_count,
    vps.public_species_count,
    vps.public_spore_count
  FROM visible_profiles_with_stats vps
  CROSS JOIN normalized n
  ORDER BY
    CASE
      WHEN n.q IS NULL THEN 0
      WHEN lower(coalesce(vps.username, '')) = lower(n.q) THEN 0
      WHEN lower(coalesce(vps.display_name, '')) = lower(n.q) THEN 1
      WHEN lower(coalesce(vps.username, '')) LIKE lower(n.q) || '%' THEN 2
      WHEN lower(coalesce(vps.display_name, '')) LIKE lower(n.q) || '%' THEN 3
      ELSE 4
    END,
    CASE WHEN n.q IS NULL THEN vps.public_find_count END DESC,
    CASE WHEN n.q IS NULL THEN coalesce(vps.display_name, vps.username, '') END ASC,
    CASE WHEN n.q IS NOT NULL THEN vps.public_find_count END DESC,
    coalesce(vps.display_name, vps.username, '') ASC,
    vps.id ASC
  LIMIT (SELECT lim FROM normalized)
  OFFSET (SELECT off FROM normalized);
$$;

-- 3. Author label. An unfinished profile contributes no name, so the label
--    falls back to fallback_author exactly as it does when no profile exists.
CREATE OR REPLACE FUNCTION public.community_contributor_label(
  profile_id uuid,
  fallback_author text DEFAULT NULL::text
)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT nullif(
    coalesce(
      CASE WHEN p.profile_completed_at IS NOT NULL THEN nullif(p.display_name, '') END,
      CASE WHEN p.profile_completed_at IS NOT NULL THEN nullif(p.username, '') END,
      nullif(fallback_author, '')
    ),
    ''
  )
  FROM public.profiles p
  WHERE p.id = profile_id
  UNION ALL
  SELECT nullif(fallback_author, '')
  WHERE NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = profile_id
  )
  LIMIT 1
$$;

-- 4. The caller's own block list. The row stays, so the block can be
--    recognised by date and removed; an unfinished profile has no name.
CREATE OR REPLACE FUNCTION public.get_blocked_user_profiles()
RETURNS TABLE (
  blocked_id   uuid,
  username     text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    ub.blocked_id,
    CASE WHEN p.profile_completed_at IS NOT NULL THEN p.username END,
    CASE WHEN p.profile_completed_at IS NOT NULL THEN p.display_name END,
    p.avatar_url,
    ub.created_at
  FROM public.user_blocks ub
  JOIN public.profiles p ON p.id = ub.blocked_id
  WHERE ub.blocker_id = auth.uid()
  ORDER BY ub.created_at DESC;
$$;

-- 5. Contributor label of a shared reference. Body is the reviewed
--    20260930224506 definition with one added branch: an unfinished profile
--    is labelled 'Sporely user'.
CREATE OR REPLACE FUNCTION private.shared_reference_contribution_envelope(
  p_contribution_id uuid,
  p_revision integer,
  p_taxon_id integer,
  p_canonical_name text,
  p_owner_id uuid,
  p_snapshot jsonb,
  p_candidate jsonb,
  p_shared_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_work jsonb := p_candidate->'work';
  v_citation jsonb;
  v_exports jsonb;
  v_label text;
  v_citation_key text := 'sporely-contribution-' || pg_catalog.replace(p_contribution_id::text, '-', '');
BEGIN
  IF p_contribution_id IS NULL OR p_revision < 1 OR p_taxon_id < 1
     OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
     OR pg_catalog.jsonb_typeof(v_work) <> 'object' THEN
    RETURN NULL;
  END IF;
  SELECT CASE
           WHEN p.profile_completed_at IS NULL THEN 'Sporely user'
           WHEN nullif(pg_catalog.btrim(p.username), '') IS NULL THEN 'Sporely user'
           WHEN p.username LIKE '%@%' THEN 'Sporely user'
           ELSE p.username
         END
    INTO v_label
    FROM public.profiles p
   WHERE p.id=p_owner_id;
  p_snapshot := p_snapshot || pg_catalog.jsonb_build_object(
    'reference_work_id', extensions.uuid_generate_v5(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
      p_contribution_id::text || ':work'
    ),
    'reference_treatment_id', extensions.uuid_generate_v5(
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
      p_contribution_id::text || ':treatment'
    ),
    'reference_measurement_set_id', p_contribution_id,
    'reference_revision', p_revision
  );
  v_citation := v_work || pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'citation_key', v_citation_key,
    'short_citation', p_snapshot->'short_label',
    'full_citation', p_snapshot->'full_citation'
  );
  v_exports := private.reference_curated_build_citation_exports(
    v_citation, p_contribution_id
  );
  RETURN pg_catalog.jsonb_build_object(
    'contribution_id', p_contribution_id,
    'revision', p_revision,
    'status', 'shared',
    'shared_at', p_shared_at,
    'sporely_taxon_id', p_taxon_id,
    'canonical_scientific_name', p_canonical_name,
    'contributor', pg_catalog.jsonb_build_object(
      'id', NULL,
      'label', coalesce(nullif(pg_catalog.btrim(v_label), ''), 'Sporely user')
    ),
    'snapshot', p_snapshot,
    'citation', v_citation,
    'exports', pg_catalog.jsonb_build_object(
      'plain_text', v_exports->>'plain_text',
      'bibtex', v_exports->>'bibtex',
      'csl_json', (v_exports->>'csl_json')::jsonb
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.read_public_profiles() IS
  'Public profile rows: not banned, not in a block relationship with the caller, and profile setup completed. A trigger-seeded profile (email local part, provider name) is not public until its owner finishes setup.';

COMMENT ON FUNCTION public.search_people_directory(integer, integer, text) IS
  'People directory search over public profiles. Applies the same visibility rules as read_public_profiles(), including profile setup completed.';

NOTIFY pgrst, 'reload schema';

COMMIT;
