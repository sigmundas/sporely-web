-- Regression coverage for 20261126130000_media_prefix_owner_status.sql.
-- Proves the orphan-prefix rule of public.media_prefix_owner_status:
--   * a profile means live, also while the deletion marker is set;
--   * no profile and no auth user (fully deleted) is sweepable;
--   * no profile, an auth user and the deletion marker (abandoned run) is
--     sweepable;
--   * no profile, an auth user and no marker is not sweepable (review);
--   * NULLs and duplicates are ignored, more than 1000 ids are refused;
--   * only service_role may call it (SECURITY DEFINER, empty search_path).
-- Run: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/media_prefix_owner_status_test.sql

BEGIN;

CREATE FUNCTION pg_temp.eq(p_actual anyelement, p_expected anyelement, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'FAIL %: got %, expected %', p_label, p_actual, p_expected;
  END IF;
END $$;

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000007e0a01', 'authenticated', 'authenticated', 'mpo-live@example.invalid', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000007e0a02', 'authenticated', 'authenticated', 'mpo-deleting@example.invalid', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000007e0a03', 'authenticated', 'authenticated', 'mpo-abandoned@example.invalid', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000007e0a04', 'authenticated', 'authenticated', 'mpo-noprofile@example.invalid', '{}', now(), now());
INSERT INTO public.profiles (id, username) VALUES
  ('00000000-0000-4000-8000-0000007e0a01', 'mpo_live'),
  ('00000000-0000-4000-8000-0000007e0a02', 'mpo_deleting');
-- Some installs create a profile per auth user; remove the ones this test
-- wants without a profile.
DELETE FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000007e0a03', '00000000-0000-4000-8000-0000007e0a04');
INSERT INTO private.reference_account_deletions (user_id) VALUES
  ('00000000-0000-4000-8000-0000007e0a02'),
  ('00000000-0000-4000-8000-0000007e0a03');

SELECT pg_temp.eq(
  (SELECT string_agg(format('%s:%s%s%s%s', right(user_id::text, 2), has_profile::int, has_auth_user::int, deletion_marked::int, sweepable::int), ',' ORDER BY user_id)
     FROM public.media_prefix_owner_status(ARRAY[
       '00000000-0000-4000-8000-0000007e0a01',
       '00000000-0000-4000-8000-0000007e0a02',
       '00000000-0000-4000-8000-0000007e0a03',
       '00000000-0000-4000-8000-0000007e0a04',
       '00000000-0000-4000-8000-0000007e0a05',
       '00000000-0000-4000-8000-0000007e0a05',
       NULL]::uuid[])),
  '01:1100,02:1110,03:0111,04:0100,05:0001',
  'owner status: live, live while deleting, abandoned run, no profile without marker, fully deleted');

SELECT pg_temp.eq((SELECT count(*) FROM public.media_prefix_owner_status(NULL)), 0::bigint, 'NULL array');

DO $$
BEGIN
  PERFORM public.media_prefix_owner_status((SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 1001)));
  RAISE EXCEPTION 'FAIL more than 1000 ids accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  NULL;
END $$;
SELECT pg_temp.eq((SELECT count(*) FROM public.media_prefix_owner_status((SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 1000)))), 1000::bigint, '1000 ids accepted');

-- Privileges.
SELECT pg_temp.eq(
  (SELECT string_agg(r, ',' ORDER BY r) FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
    WHERE has_function_privilege(r, 'public.media_prefix_owner_status(uuid[])', 'EXECUTE')),
  'service_role', 'only service_role may execute');
SELECT pg_temp.eq(has_function_privilege('public', 'public.media_prefix_owner_status(uuid[])', 'EXECUTE'), false, 'PUBLIC may not execute');
SELECT pg_temp.eq(
  (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = 'public.media_prefix_owner_status(uuid[])'::regprocedure),
  true, 'SECURITY DEFINER with an empty search_path');

DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.media_prefix_owner_status(ARRAY['00000000-0000-4000-8000-0000007e0a01'::uuid]);
    RAISE EXCEPTION 'FAIL authenticated could call media_prefix_owner_status';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END $$;

SELECT 'PASS: media_prefix_owner_status_test';

ROLLBACK;
