-- Regression coverage for 20261011100000_enforce_mosaic_storage_key_ownership.
--
-- Plan: docs/plans/active/2026-10-11-mosaic-storage-key-ownership.md (Stage 1).
--
-- Attacker A owns a public observation with public spore data and tries to
-- point a spore_measurement_mosaics row at victim V's R2 namespace (and to
-- claim id / canonical_bucket / media_version). Proves:
--   * client INSERT/UPDATE paths reject every such row (write-time guards);
--   * legitimate sporely-py, replacement, Worker (service_role) and
--     visibility-cascade writes still succeed, including on an observation
--     that holds a trusted-inserted malformed row;
--   * media_authorize_mosaic_delivery denies a trusted-inserted malformed
--     row with `invalid_storage_namespace` for every caller, owner first;
--   * get_observation_spore_mosaic returns no row for it;
--   * EXECUTE grants on the authorize RPC and the guard functions.
--
-- Run after local migrations:
--   supabase test db supabase/tests/mosaic_storage_key_ownership_test.sql
--
-- Grants are checked with has_function_privilege only: a denied runtime call
-- after SET ROLE segfaults the local Postgres backend (see
-- docs/deployments/2026-10-07-taxonomy-validator-parent-reference.md).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(39);

-- ---------------------------------------------------------------
-- Fixtures (as postgres).
--   A = attacker / owner, V = victim, S = stranger, F = A's friend.
-- ---------------------------------------------------------------

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-00000000d0a1', 'authenticated', 'authenticated', 'msk-a@example.test', '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-00000000d0b2', 'authenticated', 'authenticated', 'msk-v@example.test', '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-00000000d0c3', 'authenticated', 'authenticated', 'msk-s@example.test', '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-00000000d0d4', 'authenticated', 'authenticated', 'msk-f@example.test', '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name, is_banned)
VALUES
  ('00000000-0000-4000-8000-00000000d0a1', 'msk_a', 'MSK A', false),
  ('00000000-0000-4000-8000-00000000d0b2', 'msk_v', 'MSK V', false),
  ('00000000-0000-4000-8000-00000000d0c3', 'msk_s', 'MSK S', false),
  ('00000000-0000-4000-8000-00000000d0d4', 'msk_f', 'MSK F', false)
ON CONFLICT (id) DO UPDATE SET is_banned = false;

INSERT INTO public.friendships (requester_id, addressee_id, status)
VALUES ('00000000-0000-4000-8000-00000000d0a1', '00000000-0000-4000-8000-00000000d0d4', 'accepted')
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE fx (k text PRIMARY KEY, v bigint);
GRANT SELECT ON fx TO anon, authenticated, service_role;

WITH o AS (
  INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility)
  VALUES ('00000000-0000-4000-8000-00000000d0a1', current_date, 'public', false, 'public')
  RETURNING id
) INSERT INTO fx SELECT 'obs_a', id FROM o;

-- A second public observation that will hold only a trusted-inserted
-- malformed row (read-time + cascade cases).
WITH o AS (
  INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility)
  VALUES ('00000000-0000-4000-8000-00000000d0a1', current_date, 'public', false, 'public')
  RETURNING id
) INSERT INTO fx SELECT 'obs_bad', id FROM o;

-- Trusted (postgres, no sub) insert of the malformed row: user_id equals the
-- observation owner A, key under V's prefix. Since 20261020120000 the
-- media-key guard refuses it for every role (asserted next), so the legacy
-- row is planted with that one trigger disabled; the read-time check must
-- still deny it.
SELECT throws_ok(
  $$INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES ((SELECT v FROM fx WHERE k = 'obs_bad'), '00000000-0000-4000-8000-00000000d0a1',
            '00000000-0000-4000-8000-00000000d0b2/victim-obs/spore_mosaic_v1_deadbeef.webp', 256, 128, 64, 1)$$,
  '42501', NULL, 'media-key guard refuses a trusted foreign-prefix mosaic key');
ALTER TABLE public.spore_measurement_mosaics DISABLE TRIGGER zzy_media_key_retirement_guard;
WITH m AS (
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_bad'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0b2/victim-obs/spore_mosaic_v1_deadbeef.webp',
          256, 128, 64, 1)
  RETURNING id
) INSERT INTO fx SELECT 'mosaic_bad', id FROM m;
ALTER TABLE public.spore_measurement_mosaics ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;

SELECT is(
  (SELECT attidentity::text FROM pg_attribute
    WHERE attrelid = 'public.spore_measurement_mosaics'::regclass AND attname = 'id'),
  'a', 'spore_measurement_mosaics.id is GENERATED ALWAYS');

-- ---------------------------------------------------------------
-- Client INSERT rejections (as A).
-- ---------------------------------------------------------------

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d0a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000d0a1', true);

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0b2/obs/spore_mosaic_v1_aa.webp', 256, 128, 64, 1)
$$, '42501', NULL, 'INSERT with a key under the victim''s prefix is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (id, observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (-5, (SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1/obs/spore_mosaic_v1_aa.webp', 256, 128, 64, 1)
$$, '428C9', NULL, 'INSERT with an explicit negative id is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (id, observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (2000000000, (SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1/obs/spore_mosaic_v1_aa.webp', 256, 128, 64, 1)
$$, '428C9', NULL, 'INSERT with an explicit id ahead of the sequence is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version, canonical_bucket)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1/obs/spore_mosaic_v1_aa.webp', 256, 128, 64, 1, 'private')
$$, '42501', NULL, 'INSERT with canonical_bucket=private is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version, media_version)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1/obs/spore_mosaic_v1_aa.webp', 256, 128, 64, 1, 7)
$$, '42501', NULL, 'INSERT with media_version=7 is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (id, observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
     canonical_bucket, media_version)
  VALUES (-5, (SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0b2/obs/spore_mosaic_v1_aa.webp', 256, 128, 64, 1,
          'private', 7)
$$, '428C9', NULL, 'INSERT with the full incident combination is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1/../00000000-0000-4000-8000-00000000d0b2/x',
          256, 128, 64, 1)
$$, '42501', NULL, 'INSERT with an <A>/../<V>/x traversal key is rejected');

SELECT throws_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1//obs/x.webp', 256, 128, 64, 1)
$$, '42501', NULL, 'INSERT with an empty key segment is rejected');

-- ---------------------------------------------------------------
-- Legitimate sporely-py-shaped insert (as A).
-- ---------------------------------------------------------------

SELECT lives_ok($$
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), '00000000-0000-4000-8000-00000000d0a1',
          '00000000-0000-4000-8000-00000000d0a1/' || (SELECT v FROM fx WHERE k = 'obs_a')
            || '/spore_mosaic_v1_0123456789abcdef.webp',
          256, 128, 64, 1)
$$, 'sporely-py-shaped INSERT succeeds');

RESET ROLE;
INSERT INTO fx
SELECT 'mosaic_a', id FROM public.spore_measurement_mosaics
 WHERE observation_id = (SELECT v FROM fx WHERE k = 'obs_a');

SELECT ok((SELECT v FROM fx WHERE k = 'mosaic_a') > 0, 'legitimate insert received a positive id');
SELECT results_eq(
  $$SELECT media_version, canonical_bucket FROM public.spore_measurement_mosaics
     WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')$$,
  $$VALUES (1::bigint, 'legacy'::text)$$,
  'legitimate insert has media_version 1 and bucket legacy');

-- ---------------------------------------------------------------
-- Client UPDATE of A's own row (as A).
-- ---------------------------------------------------------------

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d0a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000d0a1', true);

SELECT throws_ok($$
  UPDATE public.spore_measurement_mosaics
     SET storage_key = '00000000-0000-4000-8000-00000000d0b2/obs/spore_mosaic_v1_bb.webp'
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, '42501', NULL, 'UPDATE moving the key to the victim''s prefix is rejected');

SELECT throws_ok($$
  UPDATE public.spore_measurement_mosaics
     SET canonical_bucket = 'private'
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, '42501', NULL, 'client UPDATE of canonical_bucket is rejected');

SELECT throws_ok($$
  UPDATE public.spore_measurement_mosaics
     SET media_version = 99
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, '42501', NULL, 'client UPDATE of media_version is rejected');

SELECT throws_ok($$
  UPDATE public.spore_measurement_mosaics
     SET id = 2000000001
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, '428C9', NULL, 'client UPDATE of id is rejected');

-- Replacement key under <A>/<obs>/ bumps media_version by exactly one.
SELECT lives_ok($$
  UPDATE public.spore_measurement_mosaics
     SET storage_key = '00000000-0000-4000-8000-00000000d0a1/' || (SELECT v FROM fx WHERE k = 'obs_a')
                       || '/spore_mosaic_v1_fedcba9876543210.webp',
         updated_at = clock_timestamp()
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, 'replacement key under <A>/<obs>/ succeeds');

SELECT is(
  (SELECT media_version FROM public.spore_measurement_mosaics
    WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')),
  2::bigint, 'replacement key bumps media_version to exactly 2');

-- An identical sporely-py PATCH (same key, new updated_at) does not bump.
SELECT lives_ok($$
  UPDATE public.spore_measurement_mosaics
     SET storage_key = storage_key, width_px = width_px, updated_at = clock_timestamp()
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, 'identical update with updated_at succeeds');

SELECT is(
  (SELECT media_version FROM public.spore_measurement_mosaics
    WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')),
  2::bigint, 'identical update leaves media_version unchanged');

-- ---------------------------------------------------------------
-- Worker path: service_role (no sub) marks the bucket private.
-- ---------------------------------------------------------------

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT lives_ok($$
  UPDATE public.spore_measurement_mosaics
     SET canonical_bucket = 'private'
   WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')
$$, 'service_role canonical_bucket=private update (Worker path) succeeds');

SELECT results_eq(
  $$SELECT media_version, canonical_bucket FROM public.spore_measurement_mosaics
     WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')$$,
  $$VALUES (3::bigint, 'private'::text)$$,
  'Worker bucket change bumps media_version and stores private');

-- ---------------------------------------------------------------
-- Owner visibility change cascades +1 to every mosaic, including the
-- trusted-inserted malformed row (its key is unchanged, so the key guard
-- must not block the owner's observation update).
-- ---------------------------------------------------------------

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d0a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000d0a1', true);

SELECT lives_ok($$
  UPDATE public.observations SET visibility = 'friends'
   WHERE id IN ((SELECT v FROM fx WHERE k = 'obs_a'), (SELECT v FROM fx WHERE k = 'obs_bad'))
$$, 'owner visibility change succeeds on observations holding a malformed mosaic');

RESET ROLE;

SELECT is(
  (SELECT media_version FROM public.spore_measurement_mosaics
    WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_a')),
  4::bigint, 'visibility cascade bumps the legitimate mosaic by exactly one');
SELECT is(
  (SELECT media_version FROM public.spore_measurement_mosaics
    WHERE id = (SELECT v FROM fx WHERE k = 'mosaic_bad')),
  2::bigint, 'visibility cascade bumps the malformed mosaic by exactly one');

-- Restore public visibility for the read-time cases (postgres; cascade bumps
-- again, harmless).
UPDATE public.observations SET visibility = 'public'
 WHERE id IN ((SELECT v FROM fx WHERE k = 'obs_a'), (SELECT v FROM fx WHERE k = 'obs_bad'));

-- ---------------------------------------------------------------
-- Read time: the malformed row is denied for owner, anon, stranger, friend.
-- ---------------------------------------------------------------

SELECT results_eq(
  $$SELECT allowed, storage_key, reason
      FROM public.media_authorize_mosaic_delivery(
        (SELECT v FROM fx WHERE k = 'mosaic_bad'), '00000000-0000-4000-8000-00000000d0a1')$$,
  $$VALUES (false, NULL::text, 'invalid_storage_namespace'::text)$$,
  'malformed mosaic denied to its owner A');
SELECT results_eq(
  $$SELECT allowed, storage_key, reason
      FROM public.media_authorize_mosaic_delivery((SELECT v FROM fx WHERE k = 'mosaic_bad'), NULL)$$,
  $$VALUES (false, NULL::text, 'invalid_storage_namespace'::text)$$,
  'malformed mosaic denied to anon');
SELECT results_eq(
  $$SELECT allowed, storage_key, reason
      FROM public.media_authorize_mosaic_delivery(
        (SELECT v FROM fx WHERE k = 'mosaic_bad'), '00000000-0000-4000-8000-00000000d0c3')$$,
  $$VALUES (false, NULL::text, 'invalid_storage_namespace'::text)$$,
  'malformed mosaic denied to a stranger');
SELECT results_eq(
  $$SELECT allowed, storage_key, reason
      FROM public.media_authorize_mosaic_delivery(
        (SELECT v FROM fx WHERE k = 'mosaic_bad'), '00000000-0000-4000-8000-00000000d0d4')$$,
  $$VALUES (false, NULL::text, 'invalid_storage_namespace'::text)$$,
  'malformed mosaic denied to A''s friend');

-- Control: the legitimate mosaic is still served (public).
SELECT results_eq(
  $$SELECT allowed, reason
      FROM public.media_authorize_mosaic_delivery((SELECT v FROM fx WHERE k = 'mosaic_a'), NULL)$$,
  $$VALUES (true, 'public'::text)$$,
  'legitimate mosaic remains authorized for anon');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d0a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000d0a1', true);
SELECT is_empty(
  $$SELECT 1 FROM public.get_observation_spore_mosaic((SELECT v FROM fx WHERE k = 'obs_bad'))$$,
  'get_observation_spore_mosaic returns no row for the malformed mosaic (owner)');

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d0c3","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000d0c3', true);
SELECT is_empty(
  $$SELECT 1 FROM public.get_observation_spore_mosaic((SELECT v FROM fx WHERE k = 'obs_bad'))$$,
  'get_observation_spore_mosaic returns no row for the malformed mosaic (stranger)');
RESET ROLE;

-- ---------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------

SELECT ok(NOT has_function_privilege('anon',
  'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE'),
  'anon cannot execute media_authorize_mosaic_delivery');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE'),
  'authenticated cannot execute media_authorize_mosaic_delivery');
SELECT ok(has_function_privilege('service_role',
  'public.media_authorize_mosaic_delivery(bigint, uuid)', 'EXECUTE'),
  'service_role can execute media_authorize_mosaic_delivery');

SELECT ok(NOT has_function_privilege('anon',
  'public._media_guard_server_owned_fields_mosaic()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
  'public._media_guard_server_owned_fields_mosaic()', 'EXECUTE'),
  'server-owned-fields guard is not executable by anon/authenticated');
SELECT ok(NOT has_function_privilege('anon',
  'public._media_guard_key_ownership_mosaic()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
  'public._media_guard_key_ownership_mosaic()', 'EXECUTE'),
  'key-ownership guard is not executable by anon/authenticated');
SELECT ok(NOT has_function_privilege('anon',
  'public._media_final_state_guard_mosaic()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
  'public._media_final_state_guard_mosaic()', 'EXECUTE'),
  'final-state guard is not executable by anon/authenticated');

SELECT * FROM finish();

ROLLBACK;
