-- Regression coverage for 20261020120000_admin_sync_health_detail
-- (public.admin_sync_health_detail and the S2b changes to admin_sync_health).
-- Proves:
--   * shape: SECURITY DEFINER, search_path '', STABLE, owner postgres; the
--     private helpers are owned by postgres, pin search_path and are not
--     executable by anon, authenticated or service_role;
--   * effective EXECUTE: not anon, PUBLIC or service_role; authenticated yes;
--   * gate: no user, anon, a non-admin and a user without a profile fail;
--   * unknown key (and NULL) raises one fixed message that does not echo it;
--   * p_limit is clamped to 1..200 (0, NULL -> 50, 1000);
--   * for every key, the detail total equals the summary count, and every
--     summary count in the fixture is nonzero;
--   * microscope exclusion and the after-cutoff desktop/other split, with
--     their severities and detail keys;
--   * no email in any output; usernames are returned raw (no escaping);
--   * every call succeeds inside SET TRANSACTION READ ONLY.
--
-- Run after local migrations:
--   supabase test db supabase/tests/admin_sync_health_detail_test.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(80);

-- ---------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------

CREATE FUNCTION public._shd_try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END;
$$;
GRANT EXECUTE ON FUNCTION public._shd_try(text) TO anon, authenticated, service_role;

CREATE FUNCTION public._shd_err(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;
GRANT EXECUTE ON FUNCTION public._shd_err(text) TO authenticated;

CREATE FUNCTION public._shd_as(p_user uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_catalog.set_config('request.jwt.claims',
    CASE WHEN p_user IS NULL THEN '{}' ELSE
      pg_catalog.jsonb_build_object('sub', p_user::text, 'role', 'authenticated')::text END, true);
$$;

-- ---------------------------------------------------------------
-- Shape and privileges.
-- ---------------------------------------------------------------

SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.admin_sync_health_detail(text,integer)'::regprocedure),
  'admin_sync_health_detail is SECURITY DEFINER');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'public.admin_sync_health_detail(text,integer)'::regprocedure),
  ARRAY['search_path=""'], 'admin_sync_health_detail pins search_path to the empty string');
SELECT is((SELECT provolatile::text FROM pg_proc WHERE oid = 'public.admin_sync_health_detail(text,integer)'::regprocedure),
  's', 'admin_sync_health_detail is STABLE');
SELECT is((SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'public.admin_sync_health_detail(text,integer)'::regprocedure),
  'postgres', 'admin_sync_health_detail is owned by postgres');
SELECT ok(NOT has_function_privilege('anon', 'public.admin_sync_health_detail(text,integer)', 'EXECUTE'),
  'anon cannot execute admin_sync_health_detail');
SELECT ok(NOT has_function_privilege('public', 'public.admin_sync_health_detail(text,integer)', 'EXECUTE'),
  'PUBLIC cannot execute admin_sync_health_detail');
SELECT ok(NOT has_function_privilege('service_role', 'public.admin_sync_health_detail(text,integer)', 'EXECUTE'),
  'service_role cannot execute admin_sync_health_detail');
SELECT ok(has_function_privilege('authenticated', 'public.admin_sync_health_detail(text,integer)', 'EXECUTE'),
  'authenticated can execute admin_sync_health_detail');
SELECT ok(has_function_privilege('authenticated', 'public.admin_sync_health(text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.admin_sync_health(text)', 'EXECUTE')
          AND NOT has_function_privilege('service_role', 'public.admin_sync_health(text)', 'EXECUTE')
          AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.admin_sync_health(text)'::regprocedure),
  'admin_sync_health keeps its grants and SECURITY DEFINER');

SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private' AND p.proname LIKE 'sync\_health\_%'), 7, 'seven private sync_health helpers');
SELECT ok((SELECT bool_and(p.proowner::regrole::text = 'postgres' AND p.proconfig = ARRAY['search_path=""']
                           AND NOT p.prosecdef AND p.provolatile IN ('s', 'i'))
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private' AND p.proname LIKE 'sync\_health\_%'),
  'helpers: owner postgres, search_path pinned, SECURITY INVOKER, STABLE or IMMUTABLE');
SELECT ok((SELECT bool_and(NOT has_function_privilege(r, p.oid, 'EXECUTE'))
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
                  unnest(ARRAY['public', 'anon', 'authenticated', 'service_role']) r
            WHERE n.nspname = 'private' AND p.proname LIKE 'sync\_health\_%'),
  'helpers: no EXECUTE for PUBLIC, anon, authenticated or service_role');

-- ---------------------------------------------------------------
-- Users. u1's username carries markup to prove raw (unescaped) output.
-- ---------------------------------------------------------------

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-00000005b001', 'authenticated', 'authenticated', 'shd-admin@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005b002', 'authenticated', 'authenticated', 'shd-u1@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005b004', 'authenticated', 'authenticated', 'shd-plain@example.test', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000005b005', 'authenticated', 'authenticated', 'shd-noprofile@example.test', '{}', now(), now());
INSERT INTO public.profiles (id, username, display_name, is_admin, is_banned) VALUES
  ('00000000-0000-4000-8000-00000005b001', 'shd_admin', 'SHD admin', true, false),
  ('00000000-0000-4000-8000-00000005b002', '<b>Tom & "J''s"</b>', 'SHD u1', false, false),
  ('00000000-0000-4000-8000-00000005b004', 'shd_plain', 'SHD plain', false, false)
ON CONFLICT (id) DO UPDATE SET is_admin = EXCLUDED.is_admin, username = EXCLUDED.username;
DELETE FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000005b005';

-- ---------------------------------------------------------------
-- Gate and key validation.
-- ---------------------------------------------------------------

SELECT public._shd_as(NULL);
SELECT is(public._shd_try($$SELECT public.admin_sync_health_detail('write_block')$$), 'P0001',
  'a call with no authenticated user raises');

SET LOCAL ROLE anon;
SELECT is(public._shd_try($$SELECT public.admin_sync_health_detail('write_block')$$), '42501', 'anon is refused EXECUTE');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT is(public._shd_try($$SELECT public.admin_sync_health_detail('write_block')$$), '42501', 'service_role is refused EXECUTE');
RESET ROLE;

SELECT public._shd_as('00000000-0000-4000-8000-00000005b004');
SET LOCAL ROLE authenticated;
SELECT is(public._shd_try($$SELECT public.admin_sync_health_detail('write_block')$$), 'P0001', 'a non-admin is refused');
SELECT is(public._shd_err($$SELECT public.admin_sync_health_detail('<nope>')$$),
  'admin_sync_health_detail requires an admin profile', 'the gate runs before key validation');
RESET ROLE;

SELECT public._shd_as('00000000-0000-4000-8000-00000005b005');
SET LOCAL ROLE authenticated;
SELECT is(public._shd_try($$SELECT public.admin_sync_health_detail('write_block')$$), 'P0001',
  'a user without a profile is refused');
RESET ROLE;

SELECT public._shd_as('00000000-0000-4000-8000-00000005b001');
SET LOCAL ROLE authenticated;
SELECT is(public._shd_try($$SELECT public.admin_sync_health_detail('write_block')$$), 'ok', 'an admin can call it');
SELECT is(
  ARRAY[public._shd_err($$SELECT public.admin_sync_health_detail('<script>x</script>')$$),
        public._shd_err($$SELECT public.admin_sync_health_detail(NULL)$$),
        public._shd_err($$SELECT public.admin_sync_health_detail('')$$),
        public._shd_err($$SELECT public.admin_sync_health_detail('null_sync_key_after_cutoff.spore_measurements.other')$$),
        public._shd_err($$SELECT public.admin_sync_health_detail('WRITE_BLOCK')$$),
        public._shd_err($$SELECT public.admin_sync_health_detail('write_block; select 1')$$)],
  array_fill('admin_sync_health_detail: unknown key'::text, ARRAY[6]),
  'unknown, NULL, empty, unmeasurable, wrong-case and injected keys raise one fixed message');
RESET ROLE;

-- ---------------------------------------------------------------
-- Fixtures (no request identity, as in a migration).
-- ---------------------------------------------------------------

SELECT public._shd_as(NULL);

TRUNCATE public.observations, public.observation_images, public.spore_measurements,
  public.reference_client_devices, private.sync_client_write_block CASCADE;

DROP INDEX public.observation_images_user_sync_key_uidx;
DROP INDEX public.spore_measurements_user_sync_key_uidx;

INSERT INTO private.sync_client_write_block (client_version, reason) VALUES ('0.9.27', 'stop');

INSERT INTO public.reference_client_devices (user_id, device_id, client, app_version, reference_snapshot_versions, last_seen_at) VALUES
  ('00000000-0000-4000-8000-00000005b002', '00000000-0000-4000-8000-0000000e0001', 'desktop_app', '0.9.25', ARRAY[1], now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000005b002', '00000000-0000-4000-8000-0000000e0002', 'desktop_app', '0.9.30', ARRAY[1], now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000005b002', '00000000-0000-4000-8000-0000000e0003', 'desktop_app', '0.9.1', ARRAY[1], now() - interval '8 days');

CREATE TEMP TABLE fx (k text PRIMARY KEY, v bigint);

WITH o AS (
  INSERT INTO public.observations (user_id, date, desktop_id, sync_key, created_at) VALUES
    ('00000000-0000-4000-8000-00000005b002', '2026-10-14', 201, NULL, now()),               -- oA keyless, desktop, after cutoff
    ('00000000-0000-4000-8000-00000005b002', '2026-10-14', NULL, NULL, now()),              -- oB keyless, other, after cutoff
    ('00000000-0000-4000-8000-00000005b002', '2026-10-14', 203, gen_random_uuid(), now()),  -- oC keyed + desktop_id
    ('00000000-0000-4000-8000-00000005b002', '2026-01-01', 204, NULL, '2026-01-01')         -- oE keyless before cutoff
  RETURNING id, desktop_id, sync_key, created_at
)
INSERT INTO fx SELECT CASE WHEN desktop_id = 201 THEN 'oA' WHEN desktop_id IS NULL THEN 'oB'
                           WHEN desktop_id = 203 THEN 'oC' ELSE 'oE' END, id FROM o;

INSERT INTO public.observations (user_id, date, sync_key, created_at, taxon_identity_state,
  taxon_identity_source_system, taxon_identity_namespace, taxon_identity_external_id)
VALUES ('00000000-0000-4000-8000-00000005b002', '2026-10-16', gen_random_uuid(), now(), 'external_unresolved',
        'artsdatabanken', 'dyntaxa', '<i>99</i>');

-- Images on oC, all created now (after the cutoff).
INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path, original_filename,
  stored_bytes, desktop_id, sync_key)
SELECT (SELECT v FROM fx WHERE k = 'oC'), '00000000-0000-4000-8000-00000005b002', t.image_type, t.path, t.fname,
       t.bytes, t.did, t.key
  FROM (VALUES
    ('field', 'p/a.webp', 'a.jpg', NULL::bigint, 301, NULL::uuid),                              -- keyless, desktop
    ('field', 'p/b.webp', 'b.jpg', NULL, NULL, NULL),                                           -- keyless, other
    ('field', 'p/c.webp', 'c.jpg', NULL, 303, gen_random_uuid()),                               -- keyed + desktop_id
    ('field', ' ', 'd.jpg', 40, NULL, gen_random_uuid()),                                       -- bytes, blank path, field
    ('microscope', NULL, 'e.jpg', 50, NULL, gen_random_uuid()),                                 -- bytes, no path, microscope anchor
    ('field', 'p/s1.webp', NULL, NULL, NULL, '00000000-0000-4000-8000-0000005b4ed1'::uuid),     -- shared_key
    ('field', 'p/s2.webp', NULL, NULL, NULL, '00000000-0000-4000-8000-0000005b4ed1'::uuid),     -- shared_key
    ('field', 'p/t1.webp', 't.jpg', NULL, NULL, gen_random_uuid()),                             -- twin keyed
    ('field', 'p/t2.webp', 't.jpg', NULL, NULL, NULL)                                           -- twin keyless (also "other")
  ) AS t(image_type, path, fname, bytes, did, key);
WITH x AS (SELECT id FROM public.observation_images WHERE storage_path = 'p/c.webp')
INSERT INTO fx SELECT 'iC', id FROM x;
-- 205 more keyless "other" images on oB to exercise the 200 cap.
INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path)
SELECT (SELECT v FROM fx WHERE k = 'oB'), '00000000-0000-4000-8000-00000005b002', 'field', 'p/bulk' || g || '.webp'
  FROM generate_series(1, 205) g;

-- Measurements on iC: shared_key pair, twin pair, keyed + desktop_id.
INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, sync_key, desktop_id, measured_at) VALUES
  ((SELECT v FROM fx WHERE k = 'iC'), '00000000-0000-4000-8000-00000005b002', 1.0, 1.0, '00000000-0000-4000-8000-0000005b4ed2', NULL, now()),
  ((SELECT v FROM fx WHERE k = 'iC'), '00000000-0000-4000-8000-00000005b002', 2.0, 1.0, '00000000-0000-4000-8000-0000005b4ed2', NULL, now()),
  ((SELECT v FROM fx WHERE k = 'iC'), '00000000-0000-4000-8000-00000005b002', 5.0, 3.0, gen_random_uuid(), NULL, now()),
  ((SELECT v FROM fx WHERE k = 'iC'), '00000000-0000-4000-8000-00000005b002', 5.0, 3.0, NULL, NULL, now()),
  ((SELECT v FROM fx WHERE k = 'iC'), '00000000-0000-4000-8000-00000005b002', 7.0, 4.0, gen_random_uuid(), 77, now());

-- ---------------------------------------------------------------
-- Summary vs detail.
-- ---------------------------------------------------------------

SELECT public._shd_as('00000000-0000-4000-8000-00000005b001');
CREATE TEMP TABLE s AS SELECT public.admin_sync_health() AS j;

CREATE TEMP TABLE keymap (ord int, key text, summary bigint);
INSERT INTO keymap
SELECT ord, key, summary FROM s, LATERAL (VALUES
  (1, 'write_block', (j #>> '{write_block,count}')::bigint),
  (2, 'below_min_desktop', (j #>> '{desktop_versions,below_min,d7,devices}')::bigint),
  (3, 'null_sync_key_after_cutoff.observations.desktop', (j #>> '{sync_key,tables,0,null_sync_key_after_cutoff_desktop}')::bigint),
  (4, 'null_sync_key_after_cutoff.observations.other', (j #>> '{sync_key,tables,0,null_sync_key_after_cutoff_other}')::bigint),
  (5, 'null_sync_key_after_cutoff.observation_images.desktop', (j #>> '{sync_key,tables,1,null_sync_key_after_cutoff_desktop}')::bigint),
  (6, 'null_sync_key_after_cutoff.observation_images.other', (j #>> '{sync_key,tables,1,null_sync_key_after_cutoff_other}')::bigint),
  (7, 'keyed_with_desktop_id.observations', (j #>> '{sync_key,tables,0,keyed_with_desktop_id}')::bigint),
  (8, 'keyed_with_desktop_id.observation_images', (j #>> '{sync_key,tables,1,keyed_with_desktop_id}')::bigint),
  (9, 'keyed_with_desktop_id.spore_measurements', (j #>> '{sync_key,tables,2,keyed_with_desktop_id}')::bigint),
  (14, 'external_unresolved', (SELECT (e ->> 'count')::bigint FROM jsonb_array_elements(j #> '{taxonomy,by_state}') e
                               WHERE e ->> 'state' = 'external_unresolved')),
  (15, 'media_bytes_no_path', (j #>> '{media_metadata,live_with_bytes_no_path}')::bigint),
  (16, 'microscope_anchors_with_bytes', (j #>> '{media_metadata,microscope_anchors_with_bytes}')::bigint)
) v(ord, key, summary);
INSERT INTO keymap
SELECT 9 + row_number() OVER (ORDER BY t, r), 'duplicate_groups.' || t || '.' || r,
       coalesce((SELECT (e ->> 'count')::bigint FROM s, jsonb_array_elements(j #> '{sync_key,duplicate_groups,by_table_rule}') e
                  WHERE e ->> 'table' = t AND e ->> 'rule' = r), 0)
  FROM unnest(ARRAY['observation_images', 'spore_measurements']) t, unnest(ARRAY['keyed_keyless_twin', 'shared_key']) r;

GRANT SELECT ON keymap TO authenticated;
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE d AS
  SELECT k.ord, k.key, k.summary, public.admin_sync_health_detail(k.key, 200) AS j FROM keymap k;
RESET ROLE;

SELECT is((SELECT count(*)::int FROM keymap), 16, 'sixteen detail keys');
SELECT ok((SELECT bool_and(summary > 0) FROM keymap), 'every summary count is nonzero in the fixture (no vacuous match)');
SELECT is((d.j ->> 'total')::bigint, d.summary, 'detail total = summary count for ' || d.key) FROM d ORDER BY d.ord;
SELECT ok((SELECT bool_and((j ->> 'schema_version')::int = 1 AND j ->> 'key' = key
                           AND jsonb_array_length(j -> 'rows') = least((j ->> 'total')::int, 200)
                           AND (j ->> 'truncated')::boolean = ((j ->> 'total')::int > 200)) FROM d),
  'every detail carries schema_version 1, its key, and rows/truncated consistent with total');

-- ---------------------------------------------------------------
-- The S2b summary changes.
-- ---------------------------------------------------------------

SELECT is((SELECT (j -> 'media_metadata') - 'recorded_primary_bytes'::text FROM s),
  '{"live_with_bytes_no_path": 1, "microscope_anchors_with_bytes": 1}'::jsonb,
  'microscope anchor with bytes is excluded from live_with_bytes_no_path and counted separately');
SELECT is((SELECT j #>> '{sync_key,tables,1,null_sync_key_after_cutoff}' FROM s)::int,
  (SELECT (j #>> '{sync_key,tables,1,null_sync_key_after_cutoff_desktop}')::int
        + (j #>> '{sync_key,tables,1,null_sync_key_after_cutoff_other}')::int FROM s),
  'null_sync_key_after_cutoff is the sum of desktop and other');
SELECT is((SELECT ARRAY[(j #>> '{sync_key,tables,0,null_sync_key_after_cutoff_desktop}')::int,
                        (j #>> '{sync_key,tables,0,null_sync_key_after_cutoff_other}')::int] FROM s),
  ARRAY[1, 1], 'observations after cutoff: oA desktop, oB other (oE before the cutoff, external one keyed)');
SELECT is((SELECT ARRAY[(j #>> '{sync_key,tables,1,null_sync_key_after_cutoff_desktop}')::int,
                        (j #>> '{sync_key,tables,1,null_sync_key_after_cutoff_other}')::int] FROM s),
  ARRAY[1, 207], 'images after cutoff: one desktop; other = b, twin keyless, 205 bulk');
SELECT ok((SELECT j #> '{sync_key,tables,2}' @> '{"null_sync_key_after_cutoff": null, "null_sync_key_after_cutoff_desktop": null, "null_sync_key_after_cutoff_other": null}' FROM s),
  'spore_measurements after-cutoff fields stay null');

CREATE TEMP TABLE w AS SELECT e FROM s, jsonb_array_elements(j -> 'warnings') e;

SELECT is((SELECT e ->> 'severity' FROM w WHERE e ->> 'key' = 'null_sync_key_after_cutoff.observations.desktop'), 'watch',
  'after-cutoff desktop observation -> watch');
SELECT is((SELECT e ->> 'severity' FROM w WHERE e ->> 'key' = 'null_sync_key_after_cutoff.observation_images.desktop'), 'watch',
  'after-cutoff desktop image -> watch');
SELECT is((SELECT e ->> 'severity' FROM w WHERE e ->> 'key' = 'null_sync_key_after_cutoff.observations.other'), 'info',
  'after-cutoff other observation -> info');
SELECT is((SELECT e ->> 'severity' FROM w WHERE e ->> 'key' = 'null_sync_key_after_cutoff.observation_images.other'), 'info',
  'after-cutoff other image -> info');
SELECT ok(NOT EXISTS (SELECT 1 FROM w WHERE e ->> 'key' IN ('null_sync_key_after_cutoff.observations', 'null_sync_key_after_cutoff.observation_images')),
  'the unsplit after-cutoff warning keys are gone');
SELECT is((SELECT e ->> 'severity' FROM w WHERE e ->> 'key' = 'media_bytes_no_path'), 'watch',
  'a non-microscope image with bytes and no path still warns');
SELECT is((SELECT e ->> 'detail_key' FROM w WHERE e ->> 'key' = 'media_bytes_no_path'), 'media_bytes_no_path',
  'media warning carries its detail_key');
SELECT is((SELECT e ->> 'detail_key' FROM w WHERE e ->> 'key' = 'write_block_active'), 'write_block', 'write block detail_key');
SELECT is((SELECT e ->> 'detail_key' FROM w WHERE e ->> 'key' = 'desktop_below_min_d7'), 'below_min_desktop', 'below-min detail_key');
SELECT is((SELECT e ->> 'detail_key' FROM w WHERE e ->> 'key' = 'taxonomy_external_unresolved'), 'external_unresolved',
  'external_unresolved detail_key');
SELECT is((SELECT e -> 'detail_keys' FROM w WHERE e ->> 'key' = 'sync_key_shared_key'),
  '["duplicate_groups.observation_images.shared_key", "duplicate_groups.spore_measurements.shared_key"]'::jsonb,
  'shared_key warning lists one detail key per nonzero table');
SELECT is((SELECT e -> 'detail_keys' FROM w WHERE e ->> 'key' = 'sync_key_keyed_keyless_twin'),
  '["duplicate_groups.observation_images.keyed_keyless_twin", "duplicate_groups.spore_measurements.keyed_keyless_twin"]'::jsonb,
  'twin warning lists one detail key per nonzero table');
SELECT ok(NOT EXISTS (SELECT 1 FROM w WHERE e ->> 'key' IN ('legacy_keyless_rows', 'desktop_unparseable_d30') AND e ? 'detail_key'),
  'warnings without listable rows carry no detail_key');
SELECT ok((SELECT bool_and(k IN (SELECT key FROM keymap))
             FROM (SELECT e ->> 'detail_key' AS k FROM w WHERE e ? 'detail_key'
                   UNION ALL SELECT jsonb_array_elements_text(e -> 'detail_keys') FROM w WHERE e ? 'detail_keys'
                   UNION ALL SELECT x ->> 'detail_key' FROM s, jsonb_array_elements(j #> '{sync_key,duplicate_groups,by_table_rule}') x) z),
  'every detail_key in the summary is an accepted detail key');
SELECT ok((SELECT NOT (e ? 'detail_key') FROM s, jsonb_array_elements(public.admin_sync_health('0.9.31') -> 'warnings') e
            WHERE e ->> 'key' = 'desktop_below_min_d7'),
  'a non-default threshold gives the below-min warning no detail_key');

-- ---------------------------------------------------------------
-- Row content.
-- ---------------------------------------------------------------

SELECT is((SELECT (j #> '{rows,0}') - 'created_at'::text FROM d WHERE key = 'write_block'),
  '{"client_version": "0.9.27", "reason": "stop"}'::jsonb, 'write_block row fields');
SELECT is((SELECT (j #> '{rows,0}') - 'last_seen_at'::text FROM d WHERE key = 'below_min_desktop'),
  jsonb_build_object('device_id', '00000000-0000-4000-8000-0000000e0001', 'user_id', '00000000-0000-4000-8000-00000005b002',
                     'username', '<b>Tom & "J''s"</b>', 'client', 'desktop_app', 'app_version', '0.9.25'),
  'below_min_desktop lists only the d7 device below 0.9.26, with client and app_version');
SELECT is((SELECT (j #> '{rows,0}') - 'created_at'::text FROM d WHERE key = 'null_sync_key_after_cutoff.observations.desktop'),
  jsonb_build_object('id', (SELECT v FROM fx WHERE k = 'oA'), 'table', 'observations', 'observation_id', (SELECT v FROM fx WHERE k = 'oA'),
                     'user_id', '00000000-0000-4000-8000-00000005b002', 'username', '<b>Tom & "J''s"</b>'),
  'after-cutoff observation row fields');
SELECT is((SELECT j #>> '{rows,0,observation_id}' FROM d WHERE key = 'keyed_with_desktop_id.spore_measurements')::bigint,
  (SELECT v FROM fx WHERE k = 'oC'), 'measurement rows name the observation of their image');
SELECT ok((SELECT j #> '{rows,0}' ?& ARRAY['table', 'rule', 'observation_id', 'user_id', 'username', 'created_at', 'ids', 'ids_truncated']
             FROM d WHERE key = 'duplicate_groups.observation_images.shared_key'),
  'duplicate group rows carry table, rule, observation_id, user, created_at, ids, ids_truncated');
SELECT is((SELECT jsonb_array_length(j #> '{rows,0,ids}') FROM d WHERE key = 'duplicate_groups.spore_measurements.shared_key'), 2,
  'measurement shared_key group lists both ids');
SELECT is((SELECT (j #> '{rows,0}') - 'created_at'::text - 'id'::text - 'observation_id'::text FROM d WHERE key = 'external_unresolved'),
  '{"table": "observations", "user_id": "00000000-0000-4000-8000-00000005b002", "username": "<b>Tom & \"J''s\"</b>",
    "taxon_identity_external_id": "<i>99</i>", "taxon_identity_namespace": "dyntaxa"}'::jsonb,
  'external_unresolved row fields, raw text');
SELECT ok((SELECT bool_and(r ->> 'username' = '<b>Tom & "J''s"</b>')
             FROM d, jsonb_array_elements(j -> 'rows') r WHERE r ? 'user_id'),
  'usernames are returned raw (no HTML escaping) on every row');
SELECT ok((SELECT bool_and(j::text !~ '(example\.test|email)') FROM d), 'no email appears in any detail output');
SELECT ok((SELECT bool_and(NOT (r ? 'email')) FROM d, jsonb_array_elements(j -> 'rows') r), 'no row has an email field');

-- Ordering: newest first, then by id.
SELECT is(
  (SELECT array_agg((r ->> 'id')::bigint ORDER BY n) FROM d, jsonb_array_elements(j -> 'rows') WITH ORDINALITY x(r, n)
    WHERE key = 'null_sync_key_after_cutoff.observation_images.other'),
  (SELECT array_agg(id ORDER BY created_at DESC, id) FROM (
     SELECT i.id, i.created_at FROM public.observation_images i
      WHERE i.sync_key IS NULL AND i.desktop_id IS NULL ORDER BY i.created_at DESC, i.id LIMIT 200) t),
  'rows are ordered newest first, then by id ascending');

-- ---------------------------------------------------------------
-- Limit clamp.
-- ---------------------------------------------------------------

SET LOCAL ROLE authenticated;
CREATE TEMP TABLE lim AS
  SELECT l, public.admin_sync_health_detail('null_sync_key_after_cutoff.observation_images.other', l) AS j
    FROM unnest(ARRAY[0, -5, 1, 1000, NULL]) l;
RESET ROLE;

SELECT is((SELECT jsonb_array_length(j -> 'rows') FROM lim WHERE l = 0), 1, 'p_limit 0 is clamped to 1');
SELECT is((SELECT jsonb_array_length(j -> 'rows') FROM lim WHERE l = -5), 1, 'a negative p_limit is clamped to 1');
SELECT is((SELECT jsonb_array_length(j -> 'rows') FROM lim WHERE l = 1), 1, 'p_limit 1 returns one row');
SELECT is((SELECT jsonb_array_length(j -> 'rows') FROM lim WHERE l = 1000), 200, 'p_limit 1000 is clamped to 200');
SELECT is((SELECT jsonb_array_length(j -> 'rows') FROM lim WHERE l IS NULL), 50, 'a NULL p_limit means 50');
SELECT ok((SELECT bool_and((j ->> 'truncated')::boolean AND (j ->> 'total')::int = 207) FROM lim),
  'truncated is true and total stays 207 at every limit');
SET LOCAL ROLE authenticated;
SELECT is((public.admin_sync_health_detail('write_block') ->> 'truncated'), 'false', 'a total within the limit is not truncated');
RESET ROLE;

-- ---------------------------------------------------------------
-- Read-only: every key runs in a READ ONLY transaction.
-- ---------------------------------------------------------------

SET TRANSACTION READ ONLY;
SELECT is(current_setting('transaction_read_only'), 'on', 'the transaction is read only');
SET LOCAL ROLE authenticated;
SELECT ok((SELECT bool_and(public._shd_try(format('SELECT public.admin_sync_health_detail(%L)', key)) = 'ok') FROM keymap),
  'every detail key runs in a READ ONLY transaction');
SELECT is(public._shd_try('SELECT public.admin_sync_health()'), 'ok', 'admin_sync_health runs in a READ ONLY transaction');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
