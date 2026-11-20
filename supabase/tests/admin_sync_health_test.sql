-- Regression coverage for 20261020100000_add_admin_sync_health, as replaced by
-- 20261020120000_admin_sync_health_detail (detail RPC: admin_sync_health_detail_test.sql).
-- (public.admin_sync_health, admin "Sync health" snapshot). Proves:
--   * shape: SECURITY DEFINER, search_path '', STABLE, owner postgres;
--   * effective EXECUTE: not anon, PUBLIC or service_role; authenticated yes;
--   * gate: no user, anon, a non-admin and a user without a profile all fail;
--     an unparseable p_min_desktop_version raises;
--   * with no data every count is 0 and no warning fires;
--   * desktop versions: 0.9.25 / 0.9.26 / 0.9.26.0 / 0.10 / garbage /
--     6-digit component / 32-char padded string, exact 7- and 30-day window
--     edges, aggregation over two users, other clients ignored;
--   * write_block reason cut to 200 characters;
--   * sync_key coverage with legacy keyless rows, trusted rows carrying both
--     sync_key and desktop_id, live/deleted/purged images, pathless anchors,
--     blank filenames, the cutoff edge, a duplicate group with >10 ids and
--     more than 50 groups;
--   * every warning fires with its severity, and none below its threshold;
--   * the call succeeds inside SET TRANSACTION READ ONLY.
--
-- Fixtures run as postgres (a trusted role, so rows may carry both sync_key
-- and desktop_id). The shared_key case needs the unique index gone, so the
-- test drops it; the whole file runs in one transaction that is rolled back.
--
-- Run after local migrations:
--   supabase test db supabase/tests/admin_sync_health_test.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(88);

-- ---------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------

CREATE FUNCTION public._sh_try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;
GRANT EXECUTE ON FUNCTION public._sh_try(text) TO anon, authenticated, service_role;

CREATE FUNCTION public._sh_as(p_user uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_catalog.set_config('request.jwt.claims',
    CASE WHEN p_user IS NULL THEN '{}' ELSE
      pg_catalog.jsonb_build_object('sub', p_user::text, 'role', 'authenticated')::text END, true);
$$;

-- ---------------------------------------------------------------
-- Shape and privileges.
-- ---------------------------------------------------------------

SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'public.admin_sync_health(text)'::regprocedure),
  true, 'admin_sync_health is SECURITY DEFINER');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.admin_sync_health(text)'::regprocedure),
  ARRAY['search_path=""'], 'admin_sync_health pins search_path to the empty string');
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'public.admin_sync_health(text)'::regprocedure),
  's', 'admin_sync_health is STABLE');
SELECT is((SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.admin_sync_health(text)'::regprocedure),
  'postgres', 'admin_sync_health is owned by postgres');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_sync_health(text)', 'EXECUTE'),
  'anon cannot execute admin_sync_health');
SELECT ok(NOT has_function_privilege('public', 'public.admin_sync_health(text)', 'EXECUTE'),
  'PUBLIC cannot execute admin_sync_health');
SELECT ok(NOT has_function_privilege('service_role', 'public.admin_sync_health(text)', 'EXECUTE'),
  'service_role cannot execute admin_sync_health');
SELECT ok(has_function_privilege('authenticated', 'public.admin_sync_health(text)', 'EXECUTE'),
  'authenticated can execute admin_sync_health');

-- ---------------------------------------------------------------
-- Users: admin, two data owners, a non-admin, a user without a profile.
-- ---------------------------------------------------------------

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-00000005a001', 'authenticated', 'authenticated', 'sh-admin@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005a002', 'authenticated', 'authenticated', 'sh-u1@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005a003', 'authenticated', 'authenticated', 'sh-u2@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005a004', 'authenticated', 'authenticated', 'sh-plain@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005a005', 'authenticated', 'authenticated', 'sh-noprofile@example.test', '{}', now(), now());
INSERT INTO public.profiles (id, display_name, is_admin, is_banned) VALUES
  ('00000000-0000-4000-8000-00000005a001', 'SH admin', true, false),
  ('00000000-0000-4000-8000-00000005a002', 'SH u1', false, false),
  ('00000000-0000-4000-8000-00000005a003', 'SH u2', false, false),
  ('00000000-0000-4000-8000-00000005a004', 'SH plain', false, false)
ON CONFLICT (id) DO UPDATE SET is_admin = EXCLUDED.is_admin;
DELETE FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000005a005';

-- ---------------------------------------------------------------
-- Gate.
-- ---------------------------------------------------------------

SELECT public._sh_as(NULL);
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), 'P0001',
  'a call with no authenticated user raises');

SET LOCAL ROLE anon;
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), '42501',
  'anon is refused EXECUTE');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), '42501',
  'service_role is refused EXECUTE');
RESET ROLE;

SELECT public._sh_as('00000000-0000-4000-8000-00000005a004');
SET LOCAL ROLE authenticated;
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), 'P0001',
  'a non-admin authenticated user is refused');
RESET ROLE;

SELECT public._sh_as('00000000-0000-4000-8000-00000005a005');
SET LOCAL ROLE authenticated;
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), 'P0001',
  'an authenticated user without a profile is refused');
RESET ROLE;

SELECT public._sh_as('00000000-0000-4000-8000-00000005a001');
SET LOCAL ROLE authenticated;
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), 'ok',
  'an admin (role authenticated) can call admin_sync_health');
RESET ROLE;

SELECT is(
  ARRAY[public._sh_try($$SELECT public.admin_sync_health('garbage')$$),
        public._sh_try($$SELECT public.admin_sync_health('1.2.3.4.5')$$),
        public._sh_try($$SELECT public.admin_sync_health('123456')$$),
        public._sh_try($$SELECT public.admin_sync_health('')$$),
        public._sh_try($$SELECT public.admin_sync_health(NULL)$$),
        public._sh_try($$SELECT public.admin_sync_health(repeat(' ', 30) || '0.9.26')$$)],
  ARRAY['P0001', 'P0001', 'P0001', 'P0001', 'P0001', 'P0001'],
  'unparseable p_min_desktop_version (garbage, 5 parts, 6 digits, empty, NULL, > 32 chars) raises');
SELECT is(public._sh_try($$SELECT public.admin_sync_health('  0.9.26  ')$$), 'ok',
  'a padded parameter within 32 characters is trimmed and accepted');

-- ---------------------------------------------------------------
-- Empty state: nothing fires.
-- ---------------------------------------------------------------

TRUNCATE public.observations, public.observation_images, public.spore_measurements,
  public.reference_client_devices, public.client_activity_daily,
  private.sync_client_write_block, private.taxon_identity_repair_runs,
  private.retired_resolution_repair_runs CASCADE;

CREATE TEMP TABLE empty_res AS SELECT public.admin_sync_health() AS j;

SELECT is((SELECT j -> 'warnings' FROM empty_res), '[]'::jsonb, 'no data: no warnings');
SELECT is((SELECT (j ->> 'schema_version')::int FROM empty_res), 1, 'schema_version is 1');
SELECT is((SELECT j ->> 'min_desktop_version' FROM empty_res), '0.9.26', 'default min_desktop_version is 0.9.26');
SELECT is((SELECT j -> 'write_block' FROM empty_res), '{"count": 0, "rows": []}'::jsonb, 'no data: empty write_block');
SELECT is((SELECT j #> '{sync_key,duplicate_groups}' FROM empty_res),
  '{"total": 0, "truncated": false, "rows": [], "by_table_rule": []}'::jsonb, 'no data: no duplicate groups');
SELECT is((SELECT j -> 'media_metadata' FROM empty_res),
  '{"live_with_bytes_no_path": 0, "microscope_anchors_with_bytes": 0, "recorded_primary_bytes": 0}'::jsonb, 'no data: media metadata zero');
SELECT is(
  (SELECT array_agg(k ORDER BY k) FROM empty_res, jsonb_object_keys(j) k),
  ARRAY['activity_by_version_d7', 'desktop_versions', 'generated_at', 'media_metadata', 'min_desktop_version',
        'schema_version', 'sync_key', 'taxonomy', 'warnings', 'write_block'],
  'top-level keys match the schema_version 1 contract');

-- ---------------------------------------------------------------
-- Fixtures: desktop devices (now() is fixed for the transaction).
--   u1: 0.9.25 (1d, below), 0.9.26 (exactly 7d, d7 edge, equal),
--       0.9.26.0 (8d, d30 only), 0.10 (exactly 30d, d30 edge, above),
--       garbage (2d, unparseable), android 0.1 (ignored),
--       0.9.25 at 30d + 1s (outside)
--   u2: 123456.1 (2d, unparseable), 32-char space-padded 0.9.1 (1d, below),
--       0.9.24 at 7d + 1s (d30 only, below)
-- ---------------------------------------------------------------

-- Fixtures are written with no request identity (as in a migration).
SELECT public._sh_as(NULL);

INSERT INTO public.reference_client_devices (user_id, device_id, client, app_version, reference_snapshot_versions, last_seen_at) VALUES
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0001', 'desktop_app', '0.9.25', ARRAY[1], now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0002', 'desktop_app', '0.9.26', ARRAY[1], now() - interval '7 days'),
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0003', 'desktop_app', '0.9.26.0', ARRAY[1], now() - interval '8 days'),
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0004', 'desktop_app', '0.10', ARRAY[1], now() - interval '30 days'),
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0005', 'desktop_app', 'garbage', ARRAY[1], now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0006', 'android_app', '0.1', ARRAY[1], now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000005a002', '00000000-0000-4000-8000-0000000d0007', 'desktop_app', '0.9.25', ARRAY[1], now() - interval '30 days 1 second'),
  ('00000000-0000-4000-8000-00000005a003', '00000000-0000-4000-8000-0000000d0008', 'desktop_app', '123456.1', ARRAY[1], now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000005a003', '00000000-0000-4000-8000-0000000d0009', 'desktop_app', repeat(' ', 27) || '0.9.1', ARRAY[1], now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000005a003', '00000000-0000-4000-8000-0000000d000a', 'desktop_app', '0.9.24', ARRAY[1], now() - interval '7 days 1 second');

-- client_activity_daily: two users on desktop 0.9.26 within 7 UTC days, one web row 7 days back (outside).
INSERT INTO public.client_activity_daily (user_id, activity_date, client, app_version) VALUES
  ('00000000-0000-4000-8000-00000005a002', (now() AT TIME ZONE 'utc')::date, 'desktop_app', '0.9.26'),
  ('00000000-0000-4000-8000-00000005a003', (now() AT TIME ZONE 'utc')::date - 6, 'desktop_app', '0.9.26'),
  ('00000000-0000-4000-8000-00000005a003', (now() AT TIME ZONE 'utc')::date - 7, 'web_browser', '1.0');

-- Write stop with a 250-character reason.
INSERT INTO private.sync_client_write_block (client_version, reason) VALUES ('0.9.27', repeat('r', 250));

-- ---------------------------------------------------------------
-- Fixtures: observations, images, measurements.
-- ---------------------------------------------------------------

DROP INDEX public.observation_images_user_sync_key_uidx;

CREATE TEMP TABLE fx (k text PRIMARY KEY, v bigint);

WITH o AS (
  INSERT INTO public.observations (user_id, date, desktop_id, sync_key, created_at) VALUES
    ('00000000-0000-4000-8000-00000005a002', '2026-01-01', 101, NULL, '2026-01-01'),               -- o1 legacy keyless
    ('00000000-0000-4000-8000-00000005a002', '2026-10-14', 102, gen_random_uuid(), now()),          -- o2 trusted: key + desktop_id
    ('00000000-0000-4000-8000-00000005a002', '2026-10-15', NULL, gen_random_uuid(), now())          -- o4 keyed
  RETURNING id, desktop_id
)
INSERT INTO fx SELECT CASE desktop_id WHEN 101 THEN 'o1' WHEN 102 THEN 'o2' ELSE 'o4' END, id FROM o;

INSERT INTO public.observations (user_id, date, created_at, taxon_identity_state,
  taxon_identity_source_system, taxon_identity_namespace, taxon_identity_external_id)
VALUES ('00000000-0000-4000-8000-00000005a003', '2026-10-16', now(), 'external_unresolved', 'artsdatabanken', 'dyntaxa', '1234');  -- o3 keyless after cutoff

-- Images on o1 (u1). All created before the cutoff unless noted.
WITH x AS (INSERT INTO public.observation_images
  (observation_id, user_id, image_type, storage_path, original_filename, stored_bytes, desktop_id, created_at)
  VALUES ((SELECT v FROM fx WHERE k = 'o1'), '00000000-0000-4000-8000-00000005a002', 'field', '00000000-0000-4000-8000-00000005a002/p/i1.webp', 'a.jpg', 100, 1, '2026-01-01')
  RETURNING id)
INSERT INTO fx SELECT 'i1', id FROM x;
WITH x AS (INSERT INTO public.observation_images
  (observation_id, user_id, image_type, storage_path, original_filename, desktop_id, sync_key, created_at)
  VALUES ((SELECT v FROM fx WHERE k = 'o1'), '00000000-0000-4000-8000-00000005a002', 'field', '00000000-0000-4000-8000-00000005a002/p/i2.webp', 'a.jpg', 2, gen_random_uuid(), '2026-01-01')
  RETURNING id)
INSERT INTO fx SELECT 'i2', id FROM x;

INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, original_filename, sync_key, deleted_at, purged_at, created_at)
SELECT (SELECT v FROM fx WHERE k = 'o1'), '00000000-0000-4000-8000-00000005a002', t.image_type, t.path, t.fname, t.key, t.deleted_at, t.purged_at, t.created_at
  FROM (VALUES
    ('microscope', '00000000-0000-4000-8000-00000005a002/p/i3.webp', 'b.jpg', gen_random_uuid(), now(), NULL::timestamptz, '2026-01-01'::timestamptz),  -- i3 keyed, deleted
    ('microscope', '00000000-0000-4000-8000-00000005a002/p/i4.webp', 'b.jpg', NULL::uuid, NULL, NULL, '2026-10-13 00:00:00+00'),                         -- i4 keyless, exactly at cutoff
    ('field', '00000000-0000-4000-8000-00000005a002/p/i5.webp', '  ', NULL, NULL, NULL, '2026-10-12 23:59:59.999999+00'),                                -- i5 keyless blank name, just before cutoff
    ('field', '00000000-0000-4000-8000-00000005a002/p/i6.webp', '  ', gen_random_uuid(), NULL, NULL, '2026-01-01'),                                      -- i6 keyed blank name
    ('microscope', NULL, 'anchor.jpg', NULL, NULL, NULL, '2026-01-01'),                                             -- i7 pathless anchor
    ('field', '00000000-0000-4000-8000-00000005a002/p/i9.webp', 'd.jpg', NULL, now(), now(), '2026-01-01'),                                              -- i9 keyless, purged
    ('field', '00000000-0000-4000-8000-00000005a002/p/i9b.webp', 'd.jpg', gen_random_uuid(), NULL, NULL, '2026-01-01')                                   -- i9b keyed twin of a purged row only
  ) AS t(image_type, path, fname, key, deleted_at, purged_at, created_at);

-- i8: keyed, bytes recorded but no path.
INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, original_filename, stored_bytes, sync_key, created_at)
VALUES ((SELECT v FROM fx WHERE k = 'o1'), '00000000-0000-4000-8000-00000005a002', 'microscope', NULL, 'e.jpg', 50, gen_random_uuid(), '2026-01-01');

-- On o4: one twin group with 1 keyed + 11 keyless rows (12 ids), and 50 more twin groups.
INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, original_filename, sync_key, created_at)
SELECT (SELECT v FROM fx WHERE k = 'o4'), '00000000-0000-4000-8000-00000005a002', 'field', '00000000-0000-4000-8000-00000005a002/p/c' || g || '.webp', 'c.jpg',
       CASE WHEN g = 1 THEN gen_random_uuid() END, '2026-01-01'
  FROM generate_series(1, 12) g;
INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, original_filename, sync_key, created_at)
SELECT (SELECT v FROM fx WHERE k = 'o4'), '00000000-0000-4000-8000-00000005a002', 'field', '00000000-0000-4000-8000-00000005a002/p/g' || g || '-' || s || '.webp',
       'g' || lpad(g::text, 2, '0') || '.jpg', CASE WHEN s = 1 THEN gen_random_uuid() END, '2026-01-01'
  FROM generate_series(1, 50) g, generate_series(1, 2) s;

-- On o2: two live images sharing one sync_key (needs the dropped index).
INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, sync_key, created_at)
SELECT (SELECT v FROM fx WHERE k = 'o2'), '00000000-0000-4000-8000-00000005a002', 'field', '00000000-0000-4000-8000-00000005a002/p/s' || g || '.webp',
       '00000000-0000-4000-8000-0000005a4ed1', '2026-01-01'
  FROM generate_series(1, 2) g;

-- Measurements on i1: m1 keyless + m2 keyed twin; m3 keyed with desktop_id.
INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, sync_key, desktop_id, measured_at) VALUES
  ((SELECT v FROM fx WHERE k = 'i1'), '00000000-0000-4000-8000-00000005a002', 10.0, 5.0, NULL, 11, '2026-01-01'),
  ((SELECT v FROM fx WHERE k = 'i1'), '00000000-0000-4000-8000-00000005a002', 10.0, 5.0, gen_random_uuid(), NULL, '2026-01-01'),
  ((SELECT v FROM fx WHERE k = 'i1'), '00000000-0000-4000-8000-00000005a002', 11.0, 6.0, gen_random_uuid(), 13, '2026-01-01');
-- On the deleted image i3: a keyless + keyed twin, keyed one with desktop_id.
-- Not live, so neither counted nor grouped. The keyless one is measured after
-- the cutoff and still raises nothing (measured_at is client-supplied).
INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, sync_key, desktop_id, measured_at)
SELECT i.id, i.user_id, 20.0, 9.0, k.key, k.did, now()
  FROM public.observation_images i,
       (VALUES (NULL::uuid, NULL::integer), (gen_random_uuid(), 21)) AS k(key, did)
 WHERE i.storage_path = '00000000-0000-4000-8000-00000005a002/p/i3.webp';

-- Repair runs: 6 taxon identity runs (5 listed), 1 retired-resolution run.
INSERT INTO private.taxon_identity_repair_runs (release_id, plan_sha256, candidate_count, promoted_count, outcome_counts, applied_at)
SELECT 'rel-' || g, repeat('a', 64), g, g - 1, '{"promoted": 1}'::jsonb, '2026-10-01'::timestamptz + g * interval '1 hour'
  FROM generate_series(1, 6) g;
INSERT INTO private.retired_resolution_repair_runs (release_id, manifest_sha256, plan_sha256, link_count, observation_count, orphan_link_count, registry_added_count)
VALUES ('rel-r', repeat('b', 64), repeat('c', 64), 4, 3, 1, 2);

SELECT public._sh_as('00000000-0000-4000-8000-00000005a001');
CREATE TEMP TABLE res AS SELECT public.admin_sync_health() AS j;
CREATE TEMP TABLE res_p AS SELECT p, public.admin_sync_health(p) AS j
  FROM unnest(ARRAY['0.9.25', '0.9.26.0', '0.10']) p;

-- ---------------------------------------------------------------
-- Write block.
-- ---------------------------------------------------------------

SELECT is((SELECT (j #>> '{write_block,count}')::int FROM res), 1, 'write_block.count = 1');
SELECT is((SELECT j #>> '{write_block,rows,0,client_version}' FROM res), '0.9.27', 'write_block row carries client_version');
SELECT is((SELECT length(j #>> '{write_block,rows,0,reason}') FROM res), 200, 'write_block reason is cut to 200 characters');
SELECT ok((SELECT j #> '{write_block,rows,0}' ? 'created_at' FROM res), 'write_block row carries created_at');

-- ---------------------------------------------------------------
-- Desktop versions.
-- ---------------------------------------------------------------

SELECT is((SELECT j #> '{desktop_versions,reporting,d7}' FROM res), '{"devices": 5, "users": 2}'::jsonb,
  'd7 reporting: 5 desktop devices (7-day edge included, android and 7d+1s excluded) over 2 users');
SELECT is((SELECT j #> '{desktop_versions,reporting,d30}' FROM res), '{"devices": 8, "users": 2}'::jsonb,
  'd30 reporting: 8 desktop devices (30-day edge included, 30d+1s excluded)');
SELECT is((SELECT j #> '{desktop_versions,below_min,d7}' FROM res), '{"devices": 2, "users": 2}'::jsonb,
  'below 0.9.26 in d7: 0.9.25 and the padded 0.9.1; 0.9.26 and garbage are not below');
SELECT is((SELECT j #> '{desktop_versions,below_min,d30}' FROM res), '{"devices": 3, "users": 2}'::jsonb,
  'below 0.9.26 in d30 adds 0.9.24; 0.9.26.0 and 0.10 are not below');
SELECT is((SELECT (j #>> '{desktop_versions,unparseable_d30}')::int FROM res), 2,
  'unparseable_d30 counts garbage and the 6-digit component');
SELECT is((SELECT j #>> '{desktop_versions,source}' FROM res), 'reference_client_devices', 'desktop source is named');
SELECT is((SELECT j #> '{desktop_versions,by_version_d7,total}' FROM res), '5'::jsonb, 'by_version_d7 total = 5 versions');
SELECT is((SELECT j #> '{desktop_versions,by_version_d7,truncated}' FROM res), 'false'::jsonb, 'by_version_d7 not truncated');
SELECT is((SELECT jsonb_array_length(j #> '{desktop_versions,by_version_d7,rows}') FROM res), 5, 'by_version_d7 lists 5 rows');
SELECT is((SELECT (j #>> '{desktop_versions,below_min,d7,devices}')::int FROM res_p WHERE p = '0.9.25'), 1,
  'min 0.9.25: only 0.9.1 is below (0.9.25 is equal)');
SELECT is((SELECT j -> 'desktop_versions' FROM res_p WHERE p = '0.9.26.0'), (SELECT j -> 'desktop_versions' FROM res),
  'min 0.9.26.0 equals min 0.9.26');
SELECT is((SELECT (j #>> '{desktop_versions,below_min,d7,devices}')::int FROM res_p WHERE p = '0.10'), 3,
  'min 0.10: 0.9.25, 0.9.26 and 0.9.1 are below (numeric, not lexical)');
SELECT is((SELECT j ->> 'min_desktop_version' FROM res_p WHERE p = '0.10'), '0.10', 'min_desktop_version echoes the parameter');

-- ---------------------------------------------------------------
-- client_activity_daily.
-- ---------------------------------------------------------------

SELECT is((SELECT j -> 'activity_by_version_d7' FROM res),
  '{"total": 1, "truncated": false, "rows": [{"client": "desktop_app", "app_version": "0.9.26", "users": 2}]}'::jsonb,
  'activity_by_version_d7 aggregates two users and excludes the row 7 days back');

-- ---------------------------------------------------------------
-- sync_key coverage.
--   images live: i1 i2 i4 i5 i6 i7 i8 i9b (8) + 12 + 100 + 2 = 122
--   keyed live: i2 i6 i8 i9b (4) + 1 + 50 + 2 = 57, keyless 65
-- ---------------------------------------------------------------

SELECT is((SELECT j #> '{sync_key,tables,0}' FROM res),
  '{"table": "observations", "live_rows": 4, "null_sync_key": 2, "null_sync_key_after_cutoff": 1, "null_sync_key_after_cutoff_desktop": 0, "null_sync_key_after_cutoff_other": 1, "keyed_with_desktop_id": 1}'::jsonb,
  'observations coverage');
SELECT is((SELECT j #> '{sync_key,tables,1}' FROM res),
  '{"table": "observation_images", "live_rows": 122, "null_sync_key": 65, "null_sync_key_after_cutoff": 1, "null_sync_key_after_cutoff_desktop": 0, "null_sync_key_after_cutoff_other": 1, "keyed_with_desktop_id": 1}'::jsonb,
  'observation_images coverage: deleted and purged rows excluded; cutoff edge counted, 1us before not');
SELECT is((SELECT j #> '{sync_key,tables,2}' FROM res),
  '{"table": "spore_measurements", "live_rows": 3, "null_sync_key": 1, "null_sync_key_after_cutoff": null, "null_sync_key_after_cutoff_desktop": null, "null_sync_key_after_cutoff_other": null, "keyed_with_desktop_id": 1}'::jsonb,
  'spore_measurements coverage: measurements on a deleted image excluded; after-cutoff is null (not measurable)');
SELECT is((SELECT j #> '{sync_key,duplicate_groups,by_table_rule}' FROM res),
  '[{"table": "observation_images", "rule": "keyed_keyless_twin", "count": 52, "detail_key": "duplicate_groups.observation_images.keyed_keyless_twin"},
    {"table": "observation_images", "rule": "shared_key", "count": 1, "detail_key": "duplicate_groups.observation_images.shared_key"},
    {"table": "spore_measurements", "rule": "keyed_keyless_twin", "count": 1, "detail_key": "duplicate_groups.spore_measurements.keyed_keyless_twin"}]'::jsonb,
  'by_table_rule counts the measurement twin although the truncated list omits it; deleted-image twin not counted');

-- Duplicate groups: 1 shared_key + 52 image twins + 1 measurement twin = 54.
SELECT is((SELECT (j #>> '{sync_key,duplicate_groups,total}')::int FROM res), 54, 'duplicate group total = 54');
SELECT is((SELECT j #> '{sync_key,duplicate_groups,truncated}' FROM res), 'true'::jsonb, 'duplicate groups truncated');
SELECT is((SELECT jsonb_array_length(j #> '{sync_key,duplicate_groups,rows}') FROM res), 50, 'duplicate group list capped at 50');
SELECT is((SELECT j #>> '{sync_key,duplicate_groups,rows,0,rule}' FROM res), 'shared_key', 'shared_key groups sort first');
SELECT is((SELECT j #> '{sync_key,duplicate_groups,rows,0,observation_id}' FROM res),
  (SELECT to_jsonb(v) FROM fx WHERE k = 'o2'), 'shared_key group names its observation');
SELECT is((SELECT jsonb_array_length(j #> '{sync_key,duplicate_groups,rows,0,ids}') FROM res), 2, 'shared_key group lists both ids');
SELECT ok((SELECT bool_and(e ? 'user_id' AND e ? 'ids' AND e ? 'ids_truncated' AND e ? 'table')
             FROM res, jsonb_array_elements(j #> '{sync_key,duplicate_groups,rows}') e),
  'every group row carries table, user_id, ids, ids_truncated');
SELECT is(
  (SELECT count(*)::int FROM res, jsonb_array_elements(j #> '{sync_key,duplicate_groups,rows}') e
    WHERE jsonb_array_length(e -> 'ids') = 10 AND (e ->> 'ids_truncated')::boolean),
  1, 'the 12-id twin group lists 10 ids and is marked ids_truncated');
SELECT is(
  (SELECT count(*)::int FROM res, jsonb_array_elements(j #> '{sync_key,duplicate_groups,rows}') e
    WHERE e ->> 'table' = 'spore_measurements'),
  0, 'deterministic order: the measurement twin sorts after the 52 image twins and is cut by the cap');

-- Rules (b) negatives, checked on the full set via a narrower parameter-free probe:
-- blank filenames (i5/i6), a twin whose keyless side is deleted (i3/i4 differ by key only on a deleted row),
-- and a twin whose keyless side is purged (i9/i9b) are not groups.
SELECT is(
  (SELECT count(*)::int FROM res, jsonb_array_elements(j #> '{sync_key,duplicate_groups,rows}') e,
          jsonb_array_elements_text(e -> 'ids') id
    WHERE id::bigint IN (SELECT i.id FROM public.observation_images i
                          WHERE i.observation_id = (SELECT v FROM fx WHERE k = 'o1')
                            AND i.original_filename IN ('  ', 'b.jpg', 'd.jpg', 'anchor.jpg', 'e.jpg'))),
  0, 'blank names, deleted and purged twins and anchors form no group');
SELECT is(
  (SELECT e -> 'ids' FROM res, jsonb_array_elements(j #> '{sync_key,duplicate_groups,rows}') e
    WHERE e ->> 'table' = 'observation_images' AND e -> 'ids' @> (SELECT to_jsonb(v) FROM fx WHERE k = 'i1')),
  (SELECT jsonb_build_array(min(v), max(v)) FROM fx WHERE k IN ('i1', 'i2')),
  'the live a.jpg keyed/keyless pair is a twin group');

-- ---------------------------------------------------------------
-- Media metadata, taxonomy.
-- ---------------------------------------------------------------

SELECT is((SELECT j -> 'media_metadata' FROM res),
  '{"live_with_bytes_no_path": 0, "microscope_anchors_with_bytes": 1, "recorded_primary_bytes": 150}'::jsonb,
  'media metadata: the pathless microscope image with bytes is an anchor (info), not a warning; anchor without bytes not counted');
SELECT is((SELECT j #> '{taxonomy,by_state}' FROM res),
  '[{"state": "external_unresolved", "count": 1}, {"state": "legacy_null", "count": 3}]'::jsonb,
  'taxonomy by_state maps NULL to legacy_null');
SELECT is((SELECT jsonb_array_length(j #> '{taxonomy,repair_runs,taxon_identity}') FROM res), 5, 'taxon identity runs capped at 5');
SELECT is((SELECT j #>> '{taxonomy,repair_runs,taxon_identity,0,release_id}' FROM res), 'rel-6', 'latest taxon identity run first');
SELECT is(
  (SELECT (j #> '{taxonomy,repair_runs,retired_resolution,0}') - 'run_id'::text - 'applied_at'::text FROM res),
  '{"release_id": "rel-r", "link_count": 4, "observation_count": 3, "orphan_link_count": 1, "registry_added_count": 2}'::jsonb,
  'retired resolution run fields');
SELECT ok((SELECT j #> '{taxonomy,repair_runs,taxon_identity,0}' ?& ARRAY['run_id', 'candidate_count', 'promoted_count', 'outcome_counts', 'applied_at'] FROM res),
  'taxon identity run fields');

-- ---------------------------------------------------------------
-- Privacy: no email, filename, notes or coordinates in the payload.
-- ---------------------------------------------------------------

SELECT ok((SELECT j::text !~ '(example\.test|a\.jpg|c\.jpg|p/i1\.webp|latitude|longitude|notes)' FROM res),
  'payload carries no email, filename, storage path, notes or coordinates');

-- ---------------------------------------------------------------
-- Warnings.
-- ---------------------------------------------------------------

CREATE TEMP TABLE w AS
  SELECT e ->> 'key' AS key, e ->> 'severity' AS severity, e ->> 'message' AS message
    FROM res, jsonb_array_elements(j -> 'warnings') e;

SELECT is((SELECT severity FROM w WHERE key = 'write_block_active'), 'warning', 'write block -> warning');
SELECT is((SELECT severity FROM w WHERE key = 'desktop_below_min_d7'), 'warning', 'below-min device in d7 -> warning');
SELECT is((SELECT severity FROM w WHERE key = 'sync_key_shared_key'), 'warning', 'shared_key group -> warning');
SELECT is((SELECT severity FROM w WHERE key = 'keyed_with_desktop_id.observations'), 'watch', 'keyed observation with desktop_id -> watch');
SELECT is((SELECT severity FROM w WHERE key = 'keyed_with_desktop_id.observation_images'), 'watch', 'keyed image with desktop_id -> watch');
SELECT is((SELECT severity FROM w WHERE key = 'keyed_with_desktop_id.spore_measurements'), 'watch', 'keyed measurement with desktop_id -> watch');
SELECT is((SELECT severity FROM w WHERE key = 'null_sync_key_after_cutoff.observations.other'), 'info', 'keyless observation after cutoff without desktop_id -> info');
SELECT is((SELECT severity FROM w WHERE key = 'null_sync_key_after_cutoff.observation_images.other'), 'info', 'keyless image at cutoff without desktop_id -> info');
SELECT ok(NOT EXISTS (SELECT 1 FROM w WHERE key LIKE 'null_sync_key_after_cutoff.spore_measurements%'),
  'no after-cutoff warning for measurements (all measured before the cutoff)');
SELECT is((SELECT severity FROM w WHERE key = 'sync_key_keyed_keyless_twin'), 'watch', 'twin group -> watch');
SELECT is((SELECT severity FROM w WHERE key = 'taxonomy_external_unresolved'), 'watch', 'external_unresolved -> watch');
SELECT ok(NOT EXISTS (SELECT 1 FROM w WHERE key = 'media_bytes_no_path'), 'a microscope anchor with bytes raises no media warning');
SELECT is((SELECT severity FROM w WHERE key = 'legacy_keyless_rows'), 'info', 'keyless legacy rows -> info');
SELECT is((SELECT severity FROM w WHERE key = 'desktop_unparseable_d30'), 'info', 'unparseable desktop version -> info');
SELECT is((SELECT count(*)::int FROM w), 12, 'exactly 12 warnings');
SELECT ok((SELECT bool_and(message IS NOT NULL AND message <> '') FROM w), 'every warning has a message');
SELECT ok((SELECT bool_and(severity IN ('info', 'watch', 'warning')) FROM w), 'severities are info, watch or warning');

-- Thresholds: remove each trigger and the warning goes away.
SELECT public._sh_as(NULL);
DELETE FROM private.sync_client_write_block;
DELETE FROM public.reference_client_devices WHERE app_version IN ('0.9.25', repeat(' ', 27) || '0.9.1');
UPDATE public.observation_images SET created_at = '2026-10-12 23:59:59.999999+00'
 WHERE created_at = '2026-10-13 00:00:00+00';
SELECT public._sh_as('00000000-0000-4000-8000-00000005a001');
CREATE TEMP TABLE res2 AS SELECT public.admin_sync_health() AS j;
CREATE TEMP TABLE w2 AS
  SELECT e ->> 'key' AS key FROM res2, jsonb_array_elements(j -> 'warnings') e;

SELECT ok(NOT EXISTS (SELECT 1 FROM w2 WHERE key = 'write_block_active'), 'no write block row -> no warning');
SELECT ok(NOT EXISTS (SELECT 1 FROM w2 WHERE key = 'desktop_below_min_d7'),
  'below-min devices only outside d7 (0.9.24 at 7d+1s) -> no warning');
SELECT is((SELECT (j #>> '{desktop_versions,below_min,d30,devices}')::int FROM res2), 1, 'the d30-only below-min device still counts in d30');
SELECT ok(NOT EXISTS (SELECT 1 FROM w2 WHERE key LIKE 'null_sync_key_after_cutoff.observation_images%'),
  'keyless images only before the cutoff -> no watch');
SELECT is((SELECT count(*)::int FROM w2), 9, '9 warnings remain');

-- ---------------------------------------------------------------
-- Read-only: the call succeeds in a READ ONLY transaction.
-- ---------------------------------------------------------------

SET TRANSACTION READ ONLY;
SELECT is(current_setting('transaction_read_only'), 'on', 'the transaction is read only');
SELECT is(public._sh_try('SELECT public.admin_sync_health()'), 'ok', 'admin_sync_health runs in a READ ONLY transaction');
SELECT is(public._sh_try($$INSERT INTO private.sync_client_write_block (client_version, reason) VALUES ('x', 'x')$$), '25006',
  'a write in the same transaction is refused (read-only mode is in force)');

SELECT * FROM finish();
ROLLBACK;
