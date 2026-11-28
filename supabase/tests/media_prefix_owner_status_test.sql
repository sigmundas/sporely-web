-- Regression coverage for 20261126130000_media_prefix_owner_status.sql.
-- Proves the orphan-prefix rule of public.media_prefix_owner_status:
--   * a profile means live, also while the deletion marker is set;
--   * no profile and no auth user (fully deleted) is sweepable;
--   * no profile, an auth user and the deletion marker (abandoned run) is
--     sweepable;
--   * no profile, an auth user and no marker is not sweepable (review);
--   * NULLs and duplicates are ignored, more than 1000 ids are refused;
--   * only service_role may call it (SECURITY DEFINER, empty search_path);
--   * media_prefix_foreign_references counts other owners' key values that
--     mention '<uid>/' in any form (alias forms included), not the prefix
--     owner's own rows.
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
  ('00000000-0000-4000-8000-0000007e0a02', 'mpo_deleting')
ON CONFLICT (id) DO NOTHING;
-- Some installs create a profile per auth user; remove the ones this test
-- wants without a profile.
DELETE FROM public.profiles WHERE id IN ('00000000-0000-4000-8000-0000007e0a03', '00000000-0000-4000-8000-0000007e0a04');
-- Media rows (content rows need a profile, so only live accounts own any).
-- 01 owns one under its own prefix, and legacy rows pointing into fully
-- deleted 05's and 06's prefixes, planted behind the media-key guard as
-- pre-guard rows would be; 06's in alias forms the web reader accepts (a
-- media URL with the id in upper case, a bucket-prefixed key).
WITH o AS (
  INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility, notes)
  VALUES ('00000000-0000-4000-8000-0000007e0a01', current_date, 'private', false, 'private', 'mpo own') RETURNING id
)
INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, upload_mode,
                                       source_width, source_height, stored_width, stored_height, stored_bytes)
SELECT o.id, '00000000-0000-4000-8000-0000007e0a01', '00000000-0000-4000-8000-0000007e0a01/a/photo.webp',
       'microscope', 'reduced', 100, 80, 50, 40, 10 FROM o;
ALTER TABLE public.observation_images DISABLE TRIGGER zzy_media_key_retirement_guard;
ALTER TABLE public.observations DISABLE TRIGGER zzy_media_key_retirement_guard;
WITH o AS (
  INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility, notes, image_key, thumb_key)
  VALUES ('00000000-0000-4000-8000-0000007e0a01', current_date, 'private', false, 'private', 'mpo foreign',
          'https://media.sporely.no/00000000-0000-4000-8000-0000007E0A06/a.webp',
          'sporely-media/00000000-0000-4000-8000-0000007e0a06/thumb_a.webp') RETURNING id
)
INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, upload_mode,
                                       source_width, source_height, stored_width, stored_height, stored_bytes)
SELECT o.id, '00000000-0000-4000-8000-0000007e0a01', '00000000-0000-4000-8000-0000007e0a05/g/small_photo.webp',
       'microscope', 'reduced', 100, 80, 50, 40, 10 FROM o;
ALTER TABLE public.observation_images ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
ALTER TABLE public.observations ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;

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

-- Foreign references.
SELECT pg_temp.eq(public.media_prefix_foreign_references('00000000-0000-4000-8000-0000007e0a05'), 1::bigint,
  'a live owner''s legacy row into a deleted prefix');
SELECT pg_temp.eq(public.media_prefix_foreign_references('00000000-0000-4000-8000-0000007e0a06'), 2::bigint,
  'alias forms: an upper-case media URL and a bucket-prefixed key');
SELECT pg_temp.eq(public.media_prefix_foreign_references('00000000-0000-4000-8000-0000007e0a01'), 0::bigint,
  'the prefix owner''s own rows do not count');
SELECT pg_temp.eq(public.media_prefix_foreign_references('00000000-0000-4000-8000-0000007e0a07'), 0::bigint, 'an unreferenced prefix');
DO $$
BEGIN
  PERFORM public.media_prefix_foreign_references(NULL);
  RAISE EXCEPTION 'FAIL NULL owner accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  NULL;
END $$;
SELECT pg_temp.eq(
  (SELECT string_agg(r, ',' ORDER BY r) FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r
    WHERE has_function_privilege(r, 'public.media_prefix_foreign_references(uuid)', 'EXECUTE')),
  'service_role', 'foreign references: only service_role may execute');
SELECT pg_temp.eq(
  (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = 'public.media_prefix_foreign_references(uuid)'::regprocedure),
  true, 'foreign references: SECURITY DEFINER with an empty search_path');

SELECT 'PASS: media_prefix_owner_status_test';

ROLLBACK;
