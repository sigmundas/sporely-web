-- Regression coverage for 20261013210000_sync_key_identity (stage S1).
--
-- Ported from the g4-evidence identity-design prototype suites
-- (tests-identity.sql, tests-copied.sql, tests-ordering.sql). Proves:
--   * sync_key columns, per-user unique partial indexes and the guard's
--     shape (SECURITY INVOKER, pinned search_path, not client-executable);
--   * the zzz_ guards are the last BEFORE ROW trigger on each table, and a
--     test-only earlier-sorting trigger that writes desktop_id or sync_key
--     into NEW cannot get past them (U7);
--   * a retried insert is idempotent: 23505 naming the exact index, one row,
--     and fetch-by-key returns the first insert, also for tombstoned images;
--   * 23505 on the sync-key index is distinguishable from the old
--     desktop_id collision, from trg_01's foreign_key_violation and from a
--     real foreign-key 23503;
--   * rule 1 (no key change on UPDATE) for authenticated, service_role and
--     postgres; rule 2 (no key + desktop_id) for authenticated only;
--   * per-user uniqueness and RLS isolation (no cross-tenant oracle);
--   * the copied-database shapes, and that a NULL-key row cannot be claimed;
--   * no non-owner view exposes sync_key.
--
-- Run after local migrations:
--   supabase test db supabase/tests/sync_key_identity_test.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(97);

-- ---------------------------------------------------------------
-- Fixtures (as postgres). A and B are two synthetic users.
-- ---------------------------------------------------------------

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000051a1', 'authenticated', 'authenticated', 'sk-a@example.test', '{}'::jsonb, now(), now()),
  ('00000000-0000-4000-8000-0000000051b2', 'authenticated', 'authenticated', 'sk-b@example.test', '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name, is_banned)
VALUES
  ('00000000-0000-4000-8000-0000000051a1', 'sk_a', 'SK A', false),
  ('00000000-0000-4000-8000-0000000051b2', 'sk_b', 'SK B', false)
ON CONFLICT (id) DO UPDATE SET is_banned = false;

CREATE TEMP TABLE fx (k text PRIMARY KEY, v bigint);
GRANT SELECT, INSERT ON fx TO authenticated, service_role;

-- Run a statement and report 'OK:<rows>' or '<sqlstate>:<constraint name>'.
CREATE FUNCTION public._sk_test_outcome(p_sql text) RETURNS text
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE st text; con text; n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN 'OK:' || n;
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, con = CONSTRAINT_NAME;
  RETURN st || ':' || coalesce(con, '');
END $$;

-- Run a statement expected to fail and report '<sqlstate>:<hint>' and its
-- message, for the hint and wording checks.
CREATE FUNCTION public._sk_test_refusal(p_sql text, OUT state_hint text, OUT message text)
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE st text; h text;
BEGIN
  EXECUTE p_sql;
  state_hint := 'OK';
EXCEPTION WHEN others THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT, message = MESSAGE_TEXT;
  state_hint := st || ':' || coalesce(h, '');
END $$;

GRANT EXECUTE ON FUNCTION public._sk_test_outcome(text), public._sk_test_refusal(text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------
-- Schema shape.
-- ---------------------------------------------------------------

SELECT col_type_is('public', 'observations', 'sync_key', 'uuid', 'observations.sync_key is uuid');
SELECT col_type_is('public', 'observation_images', 'sync_key', 'uuid', 'observation_images.sync_key is uuid');
SELECT col_type_is('public', 'spore_measurements', 'sync_key', 'uuid', 'spore_measurements.sync_key is uuid');
SELECT col_is_null('public', 'observations', 'sync_key', 'observations.sync_key is nullable');
SELECT col_is_null('public', 'observation_images', 'sync_key', 'observation_images.sync_key is nullable');
SELECT col_is_null('public', 'spore_measurements', 'sync_key', 'spore_measurements.sync_key is nullable');
SELECT col_hasnt_default('public', 'observations', 'sync_key', 'observations.sync_key has no default');
SELECT col_hasnt_default('public', 'observation_images', 'sync_key', 'observation_images.sync_key has no default');
SELECT col_hasnt_default('public', 'spore_measurements', 'sync_key', 'spore_measurements.sync_key has no default');

SELECT is(
  (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'observations_user_sync_key_uidx'),
  'CREATE UNIQUE INDEX observations_user_sync_key_uidx ON public.observations USING btree (user_id, sync_key) WHERE (sync_key IS NOT NULL)',
  'observations_user_sync_key_uidx is unique on (user_id, sync_key) for non-NULL keys');
SELECT is(
  (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'observation_images_user_sync_key_uidx'),
  'CREATE UNIQUE INDEX observation_images_user_sync_key_uidx ON public.observation_images USING btree (user_id, sync_key) WHERE (sync_key IS NOT NULL)',
  'observation_images_user_sync_key_uidx is unique on (user_id, sync_key) for non-NULL keys');
SELECT is(
  (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'spore_measurements_user_sync_key_uidx'),
  'CREATE UNIQUE INDEX spore_measurements_user_sync_key_uidx ON public.spore_measurements USING btree (user_id, sync_key) WHERE (sync_key IS NOT NULL)',
  'spore_measurements_user_sync_key_uidx is unique on (user_id, sync_key) for non-NULL keys');

SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'public._sync_identity_guard()'::regprocedure),
  false, '_sync_identity_guard is SECURITY INVOKER (prosecdef = false)');
SELECT is(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public._sync_identity_guard()'::regprocedure),
  ARRAY['search_path=pg_catalog, public'], '_sync_identity_guard pins search_path');
SELECT ok(
  NOT has_function_privilege('anon', 'public._sync_identity_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._sync_identity_guard()', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = 'public._sync_identity_guard()'::regprocedure AND a.grantee = 0),
  '_sync_identity_guard is not executable by PUBLIC, anon or authenticated');

-- tgtype 23 = ROW | BEFORE | INSERT | UPDATE.
SELECT is(
  ARRAY(SELECT tgrelid::regclass::text || '.' || tgname FROM pg_trigger
         WHERE tgfoid = 'public._sync_identity_guard()'::regprocedure
           AND tgtype = 23 AND tgenabled = 'O' AND NOT tgisinternal
         ORDER BY 1),
  ARRAY['observation_images.zzz_sync_identity_guard_image',
        'observations.zzz_sync_identity_guard_obs',
        'spore_measurements.zzz_sync_identity_guard_measurement'],
  'one enabled BEFORE INSERT OR UPDATE row guard on each table');

-- The guard must be the last BEFORE ROW trigger, so it checks the final NEW.
CREATE TEMP VIEW last_before_row_trigger AS
SELECT t.rel, (SELECT tgname::text FROM pg_trigger
                WHERE tgrelid = t.rel::regclass AND NOT tgisinternal
                  AND tgtype & 1 = 1 AND tgtype & 2 = 2
                ORDER BY tgname COLLATE "C" DESC LIMIT 1) AS last_trigger
FROM (VALUES ('public.observations'), ('public.observation_images'), ('public.spore_measurements')) t(rel);

SELECT is(
  ARRAY(SELECT last_trigger FROM last_before_row_trigger ORDER BY rel),
  ARRAY['zzz_sync_identity_guard_image', 'zzz_sync_identity_guard_obs', 'zzz_sync_identity_guard_measurement'],
  'zzz_sync_identity_guard_* sorts last among BEFORE ROW triggers on each table');

SELECT is(
  (SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm') AND a.attname = 'sync_key' AND NOT a.attisdropped
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
  0, 'no view or materialized view exposes sync_key');
SELECT is(
  (SELECT count(*)::int FROM pg_proc
    WHERE prorettype IN ('public.observations'::regtype, 'public.observation_images'::regtype,
                         'public.spore_measurements'::regtype)),
  0, 'no function returns a whole observations/observation_images/spore_measurements row');

-- ---------------------------------------------------------------
-- As A (authenticated, RLS active).
-- ---------------------------------------------------------------

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000051a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000051a1', true);

SELECT lives_ok($$
  WITH o AS (
    INSERT INTO public.observations (user_id, date, notes, sync_key)
    VALUES (auth.uid(), '2026-06-01', 'first', '51000000-0000-4000-8000-0000000000a1')
    RETURNING id
  ) INSERT INTO fx SELECT 'obs_a', id FROM o
$$, 'A inserts a keyed observation');

SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observations (user_id, date, notes, sync_key)
  VALUES (auth.uid(), '2026-06-02', 'retry', '51000000-0000-4000-8000-0000000000a1')
$$), '23505:observations_user_sync_key_uidx',
  'retry of an acknowledged-lost insert is 23505 naming observations_user_sync_key_uidx');
SELECT is((SELECT count(*)::int FROM public.observations WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'),
  1, 'the retry left exactly one row for the key');
SELECT is(
  (SELECT date::text || '/' || notes FROM public.observations
    WHERE user_id = auth.uid() AND sync_key = '51000000-0000-4000-8000-0000000000a1'),
  '2026-06-01/first', 'fetch-by-key returns the first insert');

-- Legacy, keyless rows keep working before the cutover.
SELECT lives_ok($$
  WITH o AS (
    INSERT INTO public.observations (user_id, date, notes, desktop_id)
    VALUES (auth.uid(), '2026-06-03', 'legacy', 5122)
    RETURNING id
  ) INSERT INTO fx SELECT 'obs_legacy', id FROM o
$$, 'a keyless legacy row may still carry desktop_id');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observations (user_id, date, desktop_id) VALUES (auth.uid(), '2026-06-04', 5122)
$$), '23505:observations_desktop_id_user_unique',
  'the old desktop_id collision is 23505 on a different constraint than the sync-key index');
SELECT is(public._sk_test_outcome($$
  UPDATE public.observations SET notes = 'edited' WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$), 'OK:1', 'an ordinary edit of a keyed row is allowed');

-- Rule 1 on observations, as authenticated.
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = gen_random_uuid() WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (authenticated): value -> other value refused');
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = NULL WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (authenticated): value -> NULL refused');
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'obs_legacy')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (authenticated): NULL -> value refused, so an existing keyless row cannot be claimed');

-- Rule 2 on observations, as authenticated.
SELECT throws_ok($$
  INSERT INTO public.observations (user_id, date, sync_key, desktop_id)
  VALUES (auth.uid(), '2026-06-01', gen_random_uuid(), 5123)
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'rule 2 (authenticated): INSERT with sync_key and desktop_id refused');
SELECT throws_ok($$
  UPDATE public.observations SET desktop_id = 5124 WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'rule 2 (authenticated): old-client heal setting desktop_id on a keyed row refused');

-- Hints and wording.
SELECT is((public._sk_test_refusal($$
  UPDATE public.observations SET sync_key = NULL WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$)).state_hint, 'P0001:sporely_sync_identity_refused', 'rule 1 uses hint sporely_sync_identity_refused');
SELECT is((public._sk_test_refusal($$
  UPDATE public.observations SET desktop_id = 5124 WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$)).state_hint, 'P0001:sporely_sync_identity_refused',
  'rule 2 uses hint sporely_sync_identity_refused, not the brake''s sporely_upgrade_required');
-- Auth and transient hint words of the released desktops (v0.8.13 - v0.9.25).
SELECT is(
  (SELECT count(*)::int
     FROM (SELECT lower(r.message || ' ' || r.state_hint) AS txt
             FROM (VALUES
               ($$UPDATE public.observations SET sync_key = NULL WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'$$),
               ($$UPDATE public.observations SET desktop_id = 5124 WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'$$)
             ) s(stmt), LATERAL public._sk_test_refusal(s.stmt) r) e,
          unnest(ARRAY['jwt expired', 'invalid jwt', 'expired access token', 'access token expired',
                       'auth refresh failed', 'token expired', 'session expired', 'authentication failed',
                       'invalid_grant', 'not logged in', 'unauthorized', 'pgrst301', 'pgrst303', 'captcha_failed',
                       'bad gateway', 'connection aborted', 'connection refused', 'connection reset',
                       'could not connect to server', 'gateway timeout', 'postgrest unavailable', 'schema cache',
                       'service unavailable', 'temporarily unavailable', 'timed out', 'timeout']) w
    WHERE position(w IN e.txt) > 0),
  0, 'refusal messages and hints contain none of the desktops'' auth or transient hint words');
SELECT is((public._sk_test_refusal($$
  UPDATE public.observations SET desktop_id = 5124 WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'
$$)).message, 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'refusal message is fixed text and echoes no row values');

-- Images.
SELECT lives_ok($$
  WITH i AS (
    INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
    VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field',
            auth.uid()::text || '/reserved-random-key-1.webp', '52000000-0000-4000-8000-0000000000a1')
    RETURNING id
  ) INSERT INTO fx SELECT 'img_a', id FROM i
$$, 'keyed image insert passes the media key-ownership guards');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field',
          auth.uid()::text || '/another-key.webp', '52000000-0000-4000-8000-0000000000a1')
$$), '23505:observation_images_user_sync_key_uidx',
  'image retry with a new storage key is 23505 naming observation_images_user_sync_key_uidx');
SELECT is(
  (SELECT string_agg(storage_path, ',') FROM public.observation_images
    WHERE user_id = auth.uid() AND sync_key = '52000000-0000-4000-8000-0000000000a1'),
  '00000000-0000-4000-8000-0000000051a1/reserved-random-key-1.webp',
  'adopted image keeps the reserved storage key of the first insert (one row, one path)');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES (999999999, auth.uid(), 'field', auth.uid()::text || '/x.webp', gen_random_uuid())
$$), '23503:', 'image with a missing parent is trg_01 foreign_key_violation (no constraint), not 23505');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field',
          '00000000-0000-4000-8000-0000000051b2/steal.webp', gen_random_uuid())
$$), '42501:', 'keyed image with a storage_path outside the owner prefix is still refused (42501)');
SELECT lives_ok($$
  WITH i AS (
    INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path)
    VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field', auth.uid()::text || '/legacy.webp')
    RETURNING id
  ) INSERT INTO fx SELECT 'img_legacy', id FROM i
$$, 'keyless legacy image insert is allowed');
SELECT throws_ok($$
  UPDATE public.observation_images SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'img_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 on images (authenticated): value -> other value refused');
SELECT throws_ok($$
  UPDATE public.observation_images SET sync_key = NULL WHERE id = (SELECT v FROM fx WHERE k = 'img_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 on images (authenticated): value -> NULL refused');
SELECT throws_ok($$
  UPDATE public.observation_images SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'img_legacy')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 on images (authenticated): NULL -> value refused');
SELECT throws_ok($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key, desktop_id)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field', auth.uid()::text || '/d.webp', gen_random_uuid(), 5125)
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'rule 2 on images (authenticated): INSERT refused');
SELECT throws_ok($$
  UPDATE public.observation_images SET desktop_id = 5126 WHERE id = (SELECT v FROM fx WHERE k = 'img_a')
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'rule 2 on images (authenticated): heal onto a keyed image refused');

-- Measurements.
SELECT lives_ok($$
  WITH m AS (
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, sync_key)
    VALUES ((SELECT v FROM fx WHERE k = 'img_a'), auth.uid(), 10.5, '53000000-0000-4000-8000-0000000000a1')
    RETURNING id
  ) INSERT INTO fx SELECT 'meas_a', id FROM m
$$, 'keyed measurement insert on own image');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'img_a'), auth.uid(), 99.0, '53000000-0000-4000-8000-0000000000a1')
$$), '23505:spore_measurements_user_sync_key_uidx',
  'measurement retry is 23505 naming spore_measurements_user_sync_key_uidx');
SELECT is(
  (SELECT string_agg(length_um::text, ',') FROM public.spore_measurements
    WHERE user_id = auth.uid() AND sync_key = '53000000-0000-4000-8000-0000000000a1'),
  '10.5', 'measurement fetch-by-key returns the first insert only');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, sync_key)
  VALUES (999999999, auth.uid(), 1.0, gen_random_uuid())
$$), '42501:', 'measurement with a missing parent image is refused by RLS (42501), not 23505');
SELECT lives_ok($$
  WITH m AS (
    INSERT INTO public.spore_measurements (image_id, user_id, length_um)
    VALUES ((SELECT v FROM fx WHERE k = 'img_a'), auth.uid(), 2.0)
    RETURNING id
  ) INSERT INTO fx SELECT 'meas_legacy', id FROM m
$$, 'keyless legacy measurement insert is allowed');
SELECT throws_ok($$
  UPDATE public.spore_measurements SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'meas_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 on measurements (authenticated): value -> other value refused');
SELECT throws_ok($$
  UPDATE public.spore_measurements SET sync_key = NULL WHERE id = (SELECT v FROM fx WHERE k = 'meas_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 on measurements (authenticated): value -> NULL refused');
SELECT throws_ok($$
  UPDATE public.spore_measurements SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'meas_legacy')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 on measurements (authenticated): NULL -> value refused');
SELECT throws_ok($$
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, sync_key, desktop_id)
  VALUES ((SELECT v FROM fx WHERE k = 'img_a'), auth.uid(), 3.0, gen_random_uuid(), 5127)
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'rule 2 on measurements (authenticated): INSERT refused');
SELECT throws_ok($$
  UPDATE public.spore_measurements SET desktop_id = 5128 WHERE id = (SELECT v FROM fx WHERE k = 'meas_a')
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'rule 2 on measurements (authenticated): UPDATE refused');

-- Tombstones: a soft-deleted or purged image stays visible to its owner's
-- fetch-by-key, and a retried insert cannot resurrect it.
SELECT lives_ok($$
  WITH i AS (
    INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
    VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field',
            auth.uid()::text || '/tomb.webp', '52000000-0000-4000-8000-0000000000a2'),
           ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field',
            auth.uid()::text || '/purge.webp', '52000000-0000-4000-8000-0000000000a3')
    RETURNING id, sync_key
  ) INSERT INTO fx
    SELECT CASE WHEN sync_key = '52000000-0000-4000-8000-0000000000a2' THEN 'img_tomb' ELSE 'img_purge' END, id FROM i
$$, 'two more keyed images for the tombstone cases');
SELECT is(public._sk_test_outcome($$
  UPDATE public.observation_images SET deleted_at = now() WHERE id = (SELECT v FROM fx WHERE k = 'img_tomb')
$$), 'OK:1', 'owner soft-deletes a keyed image');
SELECT is(
  (SELECT (deleted_at IS NOT NULL)::text FROM public.observation_images
    WHERE user_id = auth.uid() AND sync_key = '52000000-0000-4000-8000-0000000000a2'),
  'true', 'fetch-by-key returns the soft-deleted image with deleted_at set');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field', auth.uid()::text || '/k.webp',
          '52000000-0000-4000-8000-0000000000a2')
$$), '23505:observation_images_user_sync_key_uidx', 'retried insert of a soft-deleted image is still 23505');

-- Copied database: the same unsynced row uploaded from a second copy after
-- the first copy's upload was edited elsewhere.
SELECT lives_ok($$
  INSERT INTO public.observations (user_id, date, notes, sync_key)
  VALUES (auth.uid(), '2026-08-01', 'v1', '54000000-0000-4000-8000-0000000000a1')
$$, 'copy 1 uploads an unsynced row (notes v1)');
SELECT is(public._sk_test_outcome($$
  UPDATE public.observations SET notes = 'v2' WHERE user_id = auth.uid() AND sync_key = '54000000-0000-4000-8000-0000000000a1'
$$), 'OK:1', 'another device edits the cloud row to v2');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observations (user_id, date, notes, sync_key)
  VALUES (auth.uid(), '2026-08-01', 'v1', '54000000-0000-4000-8000-0000000000a1')
$$), '23505:observations_user_sync_key_uidx', 'copy 2 uploading the same row gets 23505, never a second row');
SELECT is(
  (SELECT string_agg(notes, ',') FROM public.observations
    WHERE user_id = auth.uid() AND sync_key = '54000000-0000-4000-8000-0000000000a1'),
  'v2', 'copy 2 adopts the single cloud row, whose content (v2) differs from its local v1');
SELECT lives_ok($$
  INSERT INTO public.observations (user_id, date, notes, sync_key)
  VALUES (auth.uid(), '2026-08-02', 'copy1-new', gen_random_uuid()),
         (auth.uid(), '2026-08-02', 'copy2-new', gen_random_uuid())
$$, 'new rows made on both copies after copying carry distinct keys');
SELECT is(
  (SELECT count(*)::int FROM public.observations WHERE user_id = auth.uid() AND notes IN ('copy1-new', 'copy2-new')),
  2, 'the two copies'' new rows are two rows; neither overwrites the other');

-- ---------------------------------------------------------------
-- As B: same key values are independent, and A's rows are unreachable.
-- ---------------------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000051b2","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000051b2', true);

SELECT is((SELECT count(*)::int FROM public.observations WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'),
  0, 'B cannot see A''s row by A''s key');
SELECT lives_ok($$
  WITH o AS (
    INSERT INTO public.observations (user_id, date, notes, sync_key)
    VALUES (auth.uid(), '2026-07-01', 'b', '51000000-0000-4000-8000-0000000000a1')
    RETURNING id
  ) INSERT INTO fx SELECT 'obs_b', id FROM o
$$, 'the same key value for B is a separate row (per-user uniqueness, no cross-tenant 23505)');
SELECT is(
  (SELECT string_agg(date::text, ',') FROM public.observations WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'),
  '2026-07-01', 'B''s fetch-by-key returns only B''s row');
SELECT lives_ok($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_b'), auth.uid(), 'field', auth.uid()::text || '/b.webp',
          '52000000-0000-4000-8000-0000000000a1')
$$, 'B may reuse A''s image key value under B''s own observation');
SELECT is(public._sk_test_outcome($$
  UPDATE public.observations SET notes = 'B' WHERE user_id = '00000000-0000-4000-8000-0000000051a1'
$$), 'OK:0', 'B cannot update A''s rows');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field', auth.uid()::text || '/x.webp', gen_random_uuid())
$$), '42501:', 'B cannot attach a keyed image to A''s observation');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observations (user_id, date, sync_key)
  VALUES ('00000000-0000-4000-8000-0000000051a1', '2026-07-01', gen_random_uuid())
$$), '42501:', 'B cannot insert a keyed row claiming A as owner');

SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000051a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000051a1', true);
SELECT is(
  (SELECT string_agg(notes, ',') FROM public.observations WHERE sync_key = '51000000-0000-4000-8000-0000000000a1'),
  'edited', 'A''s fetch-by-key still returns only A''s own row');

-- ---------------------------------------------------------------
-- service_role: rule 1 applies, rule 2 does not.
-- ---------------------------------------------------------------

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;

SELECT throws_ok($$
  UPDATE public.observations SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (service_role): value -> other value refused');
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = NULL WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (service_role): value -> NULL refused');
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'obs_legacy')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (service_role): NULL -> value refused');
SELECT lives_ok($$
  WITH o AS (
    INSERT INTO public.observations (user_id, date, sync_key, desktop_id)
    VALUES ('00000000-0000-4000-8000-0000000051a1', '2026-09-01', gen_random_uuid(), 5130)
    RETURNING id
  ) INSERT INTO fx SELECT 'obs_trusted_sr', id FROM o
$$, 'rule 2 (service_role): INSERT with sync_key and desktop_id allowed');
SELECT lives_ok($$
  UPDATE public.observations SET desktop_id = 5131 WHERE id = (SELECT v FROM fx WHERE k = 'obs_trusted_sr')
$$, 'rule 2 (service_role): UPDATE of desktop_id on a keyed row allowed');

-- ---------------------------------------------------------------
-- postgres: rule 1 applies, rule 2 does not; real FK errors.
-- ---------------------------------------------------------------

RESET ROLE;

SELECT throws_ok($$
  UPDATE public.observations SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (postgres): value -> other value refused');
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = NULL WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (postgres): value -> NULL refused');
SELECT throws_ok($$
  UPDATE public.observations SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'obs_legacy')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (postgres): NULL -> value refused');
SELECT throws_ok($$
  UPDATE public.observation_images SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'img_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (postgres) on images refused');
SELECT throws_ok($$
  UPDATE public.spore_measurements SET sync_key = gen_random_uuid() WHERE id = (SELECT v FROM fx WHERE k = 'meas_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'rule 1 (postgres) on measurements refused');
SELECT is(
  (SELECT count(*)::int FROM public.observations
    WHERE user_id = '00000000-0000-4000-8000-0000000051a1' AND sync_key IS NULL),
  1, 'the keyless legacy row is still keyless after every claim attempt');
SELECT lives_ok($$
  INSERT INTO public.observations (user_id, date, sync_key, desktop_id)
  VALUES ('00000000-0000-4000-8000-0000000051a1', '2026-09-02', gen_random_uuid(), 5132)
$$, 'rule 2 (postgres): INSERT with sync_key and desktop_id allowed');
SELECT lives_ok($$
  UPDATE public.observation_images SET desktop_id = 5133 WHERE id = (SELECT v FROM fx WHERE k = 'img_purge')
$$, 'rule 2 (postgres): UPDATE of desktop_id on a keyed image allowed');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, sync_key)
  VALUES (999999999, '00000000-0000-4000-8000-0000000051a1', 1.0, gen_random_uuid())
$$), '23503:spore_measurements_image_id_fkey',
  'a real foreign-key violation is 23503 naming the FK, distinguishable from the sync-key 23505');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES (999999999, '00000000-0000-4000-8000-0000000051a1', 'field', '00000000-0000-4000-8000-0000000051a1/f.webp', gen_random_uuid())
$$), '23503:observation_images_observation_id_fkey',
  'a real image parent FK violation is 23503 naming observation_images_observation_id_fkey');

-- Server-side purge, then the owner's fetch-by-key still sees it.
SELECT lives_ok($$
  UPDATE public.observation_images SET purged_at = now(), deleted_at = now() WHERE id = (SELECT v FROM fx WHERE k = 'img_purge')
$$, 'server purges a keyed image');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000051a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000051a1', true);
SELECT is(
  (SELECT (purged_at IS NOT NULL)::text FROM public.observation_images
    WHERE user_id = auth.uid() AND sync_key = '52000000-0000-4000-8000-0000000000a3'),
  'true', 'fetch-by-key returns the purged image with purged_at set');
SELECT is(public._sk_test_outcome($$
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key)
  VALUES ((SELECT v FROM fx WHERE k = 'obs_a'), auth.uid(), 'field', auth.uid()::text || '/p.webp',
          '52000000-0000-4000-8000-0000000000a3')
$$), '23505:observation_images_user_sync_key_uidx', 'retried insert of a purged image is still 23505');

-- ---------------------------------------------------------------
-- Guard order (U7): a test-only BEFORE trigger that sorts before the
-- guard and writes desktop_id / sync_key into NEW cannot get past it.
-- ---------------------------------------------------------------

RESET ROLE;

CREATE FUNCTION public._sk_test_mutator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.notes = 'mutate-desktop-id' THEN NEW.desktop_id := 5177; END IF;
  IF NEW.notes = 'mutate-sync-key' THEN NEW.sync_key := gen_random_uuid(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_50_sk_test_mutator BEFORE INSERT OR UPDATE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public._sk_test_mutator();

SELECT is(
  (SELECT last_trigger FROM last_before_row_trigger WHERE rel = 'public.observations'),
  'zzz_sync_identity_guard_obs', 'the guard still sorts after the test mutator trigger');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000051a1","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000051a1', true);

SELECT throws_ok($$
  UPDATE public.observations SET notes = 'mutate-desktop-id' WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'an earlier trigger planting desktop_id on a keyed row is refused (rule 2 sees the final NEW)');
SELECT throws_ok($$
  UPDATE public.observations SET notes = 'mutate-sync-key' WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')
$$, 'P0001', 'Sporely sync key cannot be changed. Nothing was changed in the cloud.',
  'an earlier trigger rewriting sync_key is refused (rule 1 sees the final NEW)');
SELECT throws_ok($$
  INSERT INTO public.observations (user_id, date, notes, sync_key)
  VALUES (auth.uid(), '2026-09-03', 'mutate-desktop-id', gen_random_uuid())
$$, 'P0001', 'A record with a Sporely sync key cannot also carry a desktop link. Nothing was changed in the cloud.',
  'an earlier trigger planting desktop_id on a keyed INSERT is refused');
SELECT is(
  (SELECT coalesce(desktop_id::text, 'null') || '/' || sync_key::text FROM public.observations
    WHERE id = (SELECT v FROM fx WHERE k = 'obs_a')),
  'null/51000000-0000-4000-8000-0000000000a1', 'the keyed row is unchanged after the mutation attempts');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
