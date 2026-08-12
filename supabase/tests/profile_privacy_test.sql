-- Regression coverage for the owner-only profiles table and the narrow
-- public_profiles projection introduced by
-- 20260812120000_owner_only_profiles_and_public_projection.sql, including
-- its banned-profile and bidirectional-block visibility rules.

BEGIN;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-00000000cc21';
  other_id uuid := '00000000-0000-4000-8000-00000000cc22';
  blocked_by_viewer_id uuid := '00000000-0000-4000-8000-00000000cc23';
  blocks_viewer_id uuid := '00000000-0000-4000-8000-00000000cc24';
  banned_id uuid := '00000000-0000-4000-8000-00000000cc25';
  row_count bigint;
  owner_billing_customer_id text;
  projected_username text;
  projected_columns text[];
  projection_options text[];
  direct_read_denied boolean := false;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id, 'authenticated', 'authenticated', 'profile-owner@example.test', '{}'::jsonb, now(), now()),
    (other_id, 'authenticated', 'authenticated', 'profile-other@example.test', '{}'::jsonb, now(), now()),
    (blocked_by_viewer_id, 'authenticated', 'authenticated', 'profile-blocked-by-viewer@example.test', '{}'::jsonb, now(), now()),
    (blocks_viewer_id, 'authenticated', 'authenticated', 'profile-blocks-viewer@example.test', '{}'::jsonb, now(), now()),
    (banned_id, 'authenticated', 'authenticated', 'profile-banned@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (
    id, username, display_name, avatar_url, bio,
    cloud_plan, is_pro, is_admin, is_banned, billing_customer_id,
    storage_used_bytes, last_client, last_client_seen_at
  ) VALUES
    (
      owner_id, 'profile_owner', 'Profile Owner', 'https://example.test/owner.png', 'Owner bio',
      'pro', true, true, false, 'cus_private_owner',
      12345, 'desktop_app', now()
    ),
    (
      other_id, 'profile_other', 'Profile Other', 'https://example.test/other.png', 'Other bio',
      'free', false, false, false, 'cus_private_other',
      67890, 'web_browser', now()
    ),
    (
      blocked_by_viewer_id, 'profile_blocked', 'Blocked By Viewer', NULL, NULL,
      'free', false, false, false, NULL,
      0, NULL, NULL
    ),
    (
      blocks_viewer_id, 'profile_blocker', 'Blocks Viewer', NULL, NULL,
      'free', false, false, false, NULL,
      0, NULL, NULL
    ),
    (
      banned_id, 'profile_banned', 'Banned Profile', NULL, NULL,
      'free', false, false, true, NULL,
      0, NULL, NULL
    )
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    avatar_url = EXCLUDED.avatar_url,
    bio = EXCLUDED.bio,
    cloud_plan = EXCLUDED.cloud_plan,
    is_pro = EXCLUDED.is_pro,
    is_admin = EXCLUDED.is_admin,
    is_banned = EXCLUDED.is_banned,
    billing_customer_id = EXCLUDED.billing_customer_id,
    storage_used_bytes = EXCLUDED.storage_used_bytes,
    last_client = EXCLUDED.last_client,
    last_client_seen_at = EXCLUDED.last_client_seen_at;

  INSERT INTO public.user_blocks (blocker_id, blocked_id)
  VALUES
    (other_id, blocked_by_viewer_id),
    (blocks_viewer_id, other_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  SELECT array_agg(c.column_name::text ORDER BY c.ordinal_position)
  INTO projected_columns
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'public_profiles';

  IF projected_columns IS DISTINCT FROM ARRAY[
    'id', 'username', 'display_name', 'avatar_url', 'bio'
  ]::text[] THEN
    RAISE EXCEPTION 'public_profiles exposes unexpected columns: %', projected_columns;
  END IF;

  SELECT c.reloptions INTO projection_options
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'public_profiles';
  IF NOT ('security_invoker=true' = ANY (projection_options))
     OR NOT ('security_barrier=true' = ANY (projection_options)) THEN
    RAISE EXCEPTION 'public_profiles is missing invoker/barrier protection: %', projection_options;
  END IF;

  IF has_table_privilege('anon', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'anon retains direct SELECT on public.profiles';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated owner SELECT grant is missing on public.profiles';
  END IF;
  IF NOT has_table_privilege('anon', 'public.public_profiles', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.public_profiles', 'SELECT') THEN
    RAISE EXCEPTION 'public profile projection SELECT grant is missing';
  END IF;
  IF has_table_privilege('anon', 'public.public_profiles', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.public_profiles', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'client role has write privileges on public.public_profiles';
  END IF;

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  BEGIN
    PERFORM 1 FROM public.profiles LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    direct_read_denied := true;
  END;
  IF NOT direct_read_denied THEN
    RAISE EXCEPTION 'anon direct profiles read did not fail closed';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.public_profiles
  WHERE id IN (owner_id, other_id, blocked_by_viewer_id, blocks_viewer_id);
  IF row_count <> 4 THEN
    RAISE EXCEPTION 'anon public_profiles expected all 4 unbanned fixtures, got %', row_count;
  END IF;

  SELECT count(*) INTO row_count
  FROM public.public_profiles
  WHERE id = banned_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'anon retrieved a banned public profile';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', other_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);

  SELECT count(*) INTO row_count
  FROM public.profiles
  WHERE id = owner_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'other authenticated user read the owner profiles row';
  END IF;

  SELECT billing_customer_id INTO owner_billing_customer_id
  FROM public.profiles
  WHERE id = other_id;
  IF owner_billing_customer_id IS DISTINCT FROM 'cus_private_other' THEN
    RAISE EXCEPTION 'authenticated user could not read their own full profiles row';
  END IF;

  SELECT username INTO projected_username
  FROM public.public_profiles
  WHERE id = owner_id;
  IF projected_username IS DISTINCT FROM 'profile_owner' THEN
    RAISE EXCEPTION 'other authenticated user could not read safe owner projection';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.public_profiles
  WHERE id IN (blocked_by_viewer_id, blocks_viewer_id);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'authenticated user retrieved a profile across a two-way block';
  END IF;

  SELECT count(*) INTO row_count
  FROM public.public_profiles
  WHERE id = banned_id;
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'authenticated user retrieved a banned public profile';
  END IF;

  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', owner_id::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);

  SELECT billing_customer_id INTO owner_billing_customer_id
  FROM public.profiles
  WHERE id = owner_id;
  IF owner_billing_customer_id IS DISTINCT FROM 'cus_private_owner' THEN
    RAISE EXCEPTION 'owner could not read their own full profiles row';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'profile_privacy_test passed';
END
$$;

ROLLBACK;
