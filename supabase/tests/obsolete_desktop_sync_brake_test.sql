-- Regression coverage for 20261013200000_obsolete_desktop_sync_brake.
--
-- Stage: 2026-10-13-obsolete-desktop-sync-brake.
--
-- Each case sets request.headers, request.jwt.claims and the role the way
-- PostgREST does, runs one statement and records its outcome. Proves:
--   * INSERT/UPDATE/DELETE on every braked table from a shipped desktop
--     (python-requests User-Agent, end-user JWT) fails with P0001 and HINT
--     sporely_upgrade_required, including for the anon role and for a
--     non-2 sync-identity header;
--   * the same writes succeed from a browser, an Android WebView, a desktop
--     sending x-sporely-sync-identity: 2, service_role, a request without a
--     User-Agent, and a session without request headers (migration/cron);
--   * writes made inside RPCs are refused: set_observation_location (when
--     the database has it) and the SECURITY DEFINER
--     sync_observation_reference_use;
--   * reads are unaffected;
--   * the guard is SECURITY INVOKER with an empty search_path, not executable
--     by client roles, and fires before every other BEFORE row trigger;
--   * the message and hint contain none of the authentication or transient
--     hint words used by shipped desktops (v0.8.13 .. ee6f2af).
-- observation_reference_uses is client-writable only through its RPC, so its
-- brake is proven through that RPC (section 3).
--
-- Run after local migrations:
--   supabase test db supabase/tests/obsolete_desktop_sync_brake_test.sql
--
-- Synthetic users only.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(174);

-- ---------------------------------------------------------------
-- Helpers (as postgres).
-- ---------------------------------------------------------------

CREATE TEMP TABLE fx (k text PRIMARY KEY, v text NOT NULL);
GRANT SELECT ON fx TO anon, authenticated, service_role;

CREATE FUNCTION pg_temp.fx(p_key text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT v FROM fx WHERE k = p_key $$;

-- Run p_sql in one request context and return 'ok:<row count>' or
-- '<sqlstate>:<hint>'. The message of the last error is kept in the
-- brake_test.last_message setting.
CREATE FUNCTION pg_temp.brake_try(p_ctx text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  v_owner   constant text := '00000000-0000-4000-8000-0000000b4a01';
  v_python  constant text := 'python-requests/2.32.3';
  v_browser constant text := 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
  v_webview constant text := 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36';
  v_user    constant jsonb := jsonb_build_object('sub', '00000000-0000-4000-8000-0000000b4a01', 'role', 'authenticated');
  v_role    text;
  v_claims  jsonb;
  v_headers jsonb;
  v_rows    bigint;
  v_state   text;
  v_hint    text;
  v_message text;
  v_result  text;
BEGIN
  CASE p_ctx
    WHEN 'old_desktop' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('user-agent', v_python, 'accept', '*/*');
    WHEN 'old_desktop_mixed_case' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('user-agent', 'Python-Requests/2.28.1');
    WHEN 'old_desktop_anon_claims' THEN
      v_role := NULL; v_claims := jsonb_build_object('role', 'anon');
      v_headers := jsonb_build_object('user-agent', v_python);
    WHEN 'old_desktop_sync_identity_1' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('user-agent', v_python, 'x-sporely-sync-identity', '1');
    WHEN 'browser' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('user-agent', v_browser);
    WHEN 'webview' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('user-agent', v_webview);
    WHEN 'sync_identity_2' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('user-agent', v_python, 'x-sporely-sync-identity', '2');
    WHEN 'no_user_agent' THEN
      v_role := 'authenticated'; v_claims := v_user;
      v_headers := jsonb_build_object('accept', '*/*');
    WHEN 'service_role' THEN
      v_role := 'service_role'; v_claims := jsonb_build_object('role', 'service_role');
      v_headers := jsonb_build_object('user-agent', v_python);
    WHEN 'no_headers' THEN
      v_role := NULL; v_claims := NULL; v_headers := NULL;
    ELSE
      RAISE EXCEPTION 'unknown test context %', p_ctx;
  END CASE;

  PERFORM set_config('request.headers', coalesce(v_headers::text, ''), true);
  PERFORM set_config('request.jwt.claims', coalesce(v_claims::text, ''), true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(v_claims ->> 'sub', ''), true);
  PERFORM set_config('request.jwt.claim.role', coalesce(v_claims ->> 'role', ''), true);
  IF v_role IS NOT NULL THEN
    EXECUTE format('SET LOCAL ROLE %I', v_role);
  END IF;

  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_result := 'ok:' || v_rows;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                            v_hint = PG_EXCEPTION_HINT,
                            v_message = MESSAGE_TEXT;
    v_result := v_state || ':' || coalesce(v_hint, '');
    PERFORM set_config('brake_test.last_message', coalesce(v_message, ''), true);
  END;

  RESET ROLE;
  PERFORM set_config('request.headers', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  RETURN v_result;
END
$fn$;

-- One observation with an image, two measurements, a mosaic with one tile,
-- a spore summary and a reference use, all owned by the test user.
-- Keys: <tag>.obs, <tag>.img, <tag>.img2 (leaf image), <tag>.meas, <tag>.meas2, <tag>.mosaic,
-- <tag>.summary, <tag>.use.
CREATE FUNCTION pg_temp.make_fixture(p_tag text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_owner constant uuid := '00000000-0000-4000-8000-0000000b4a01';
  v_set   constant uuid := '0b4a0000-0000-4000-8000-000000000003';
  v_obs bigint; v_img bigint; v_img2 bigint; v_meas bigint; v_meas2 bigint; v_mosaic bigint;
  v_summary bigint; v_use uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility, notes)
  VALUES (v_owner, current_date, 'public', false, 'public', 'brake fixture ' || p_tag)
  RETURNING id INTO v_obs;
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, notes)
  VALUES (v_obs, v_owner, v_owner || '/' || v_obs || '/brake_' || p_tag || '.webp', 'microscope', 'fixture')
  RETURNING id INTO v_img;
  -- A second image with no measurements: deleting it reaches only the
  -- observation_images trigger, not a cascade into a braked child table.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, notes)
  VALUES (v_obs, v_owner, v_owner || '/' || v_obs || '/brake_' || p_tag || '_leaf.webp', 'field', 'fixture leaf')
  RETURNING id INTO v_img2;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, notes)
  VALUES (v_img, v_owner, 10.0, 5.0, 'fixture') RETURNING id INTO v_meas;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, notes)
  VALUES (v_img, v_owner, 11.0, 6.0, 'fixture') RETURNING id INTO v_meas2;
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (v_obs, v_owner, v_owner || '/' || v_obs || '/spore_mosaic_v1_0123456789abcdef.webp', 256, 128, 64, 1)
  RETURNING id INTO v_mosaic;
  INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px)
  VALUES (v_meas, v_mosaic, 0, 0, 64, 64);
  INSERT INTO public.observation_spore_summaries (observation_id, user_id, context_hash, n_spores)
  VALUES (v_obs, v_owner, 'fixture-' || p_tag, 2) RETURNING id INTO v_summary;
  INSERT INTO public.observation_reference_uses
    (user_id, id, observation_id, reference_measurement_set_id, role, reference_revision, snapshot_json)
  VALUES (v_owner, v_use, v_obs, v_set, 'compared', 1, private.reference_canonical_snapshot(v_owner, v_set));

  INSERT INTO fx VALUES
    (p_tag || '.obs', v_obs::text), (p_tag || '.img', v_img::text), (p_tag || '.img2', v_img2::text),
    (p_tag || '.meas', v_meas::text), (p_tag || '.meas2', v_meas2::text),
    (p_tag || '.mosaic', v_mosaic::text), (p_tag || '.summary', v_summary::text),
    (p_tag || '.use', v_use::text);
END
$fn$;

-- The write matrix for one context: 21 statements over the seven braked
-- tables. Inserts first, then updates, then deletes child-first. Returns the
-- outcome of each statement, labelled.
CREATE FUNCTION pg_temp.write_matrix(p_ctx text, p_tag text)
RETURNS TABLE (label text, outcome text)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_owner constant text := '00000000-0000-4000-8000-0000000b4a01';
  v_obs text := pg_temp.fx(p_tag || '.obs');
  v_img text := pg_temp.fx(p_tag || '.img');
  v_meas text := pg_temp.fx(p_tag || '.meas');
  v_meas2 text := pg_temp.fx(p_tag || '.meas2');
  v_mosaic text := pg_temp.fx(p_tag || '.mosaic');
  v_summary text := pg_temp.fx(p_tag || '.summary');
  v_use text := pg_temp.fx(p_tag || '.use');
  v_step record;
BEGIN
  FOR v_step IN
    SELECT * FROM (VALUES
      (1, 'observations INSERT', format(
        $$INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility, notes)
          VALUES (%L, current_date, 'public', false, 'public', 'inserted')$$, v_owner)),
      (2, 'observation_images INSERT', format(
        $$INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, notes)
          VALUES (%s, %L, %L, 'microscope', 'inserted')$$, v_obs, v_owner, v_owner || '/' || v_obs || '/brake_inserted.webp')),
      (3, 'spore_measurements INSERT', format(
        $$INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, notes)
          VALUES (%s, %L, 12.0, 7.0, 'inserted')$$, v_img, v_owner)),
      (4, 'spore_measurement_mosaics INSERT', format(
        $$INSERT INTO public.spore_measurement_mosaics
            (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
          VALUES (%s, %L, %L, 256, 128, 64, 2)$$, v_obs, v_owner, v_owner || '/' || v_obs || '/spore_mosaic_v1_fedcba9876543210.webp')),
      (5, 'spore_measurement_mosaic_tiles INSERT', format(
        $$INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px)
          VALUES (%s, %s, 64, 0, 64, 64)$$, v_meas2, v_mosaic)),
      (6, 'observation_spore_summaries INSERT', format(
        $$INSERT INTO public.observation_spore_summaries (observation_id, user_id, context_hash, n_spores)
          VALUES (%s, %L, 'inserted', 1)$$, v_obs, v_owner)),
      (7, 'observation_reference_uses INSERT', format(
        $$INSERT INTO public.observation_reference_uses
            (user_id, id, observation_id, reference_measurement_set_id, role, reference_revision, snapshot_json)
          VALUES (%L, gen_random_uuid(), %s, %L, 'compared', 1, %L::jsonb)$$,
        v_owner, v_obs, '0b4a0000-0000-4000-8000-000000000004', pg_temp.fx('snapshot2'))),
      (8, 'observations UPDATE', format(
        $$UPDATE public.observations SET notes = 'updated' WHERE id = %s$$, v_obs)),
      (9, 'observation_images UPDATE', format(
        $$UPDATE public.observation_images SET notes = 'updated' WHERE id = %s$$, v_img)),
      (10, 'spore_measurements UPDATE', format(
        $$UPDATE public.spore_measurements SET notes = 'updated' WHERE id = %s$$, v_meas)),
      (11, 'spore_measurement_mosaics UPDATE', format(
        $$UPDATE public.spore_measurement_mosaics SET version = 3 WHERE id = %s$$, v_mosaic)),
      (12, 'spore_measurement_mosaic_tiles UPDATE', format(
        $$UPDATE public.spore_measurement_mosaic_tiles SET w_px = 32 WHERE measurement_id = %s$$, v_meas)),
      (13, 'observation_spore_summaries UPDATE', format(
        $$UPDATE public.observation_spore_summaries SET n_spores = 3 WHERE id = %s$$, v_summary)),
      (14, 'observation_reference_uses UPDATE', format(
        $$UPDATE public.observation_reference_uses SET note = 'updated' WHERE id = %L$$, v_use)),
      (15, 'observation_reference_uses DELETE', format(
        $$DELETE FROM public.observation_reference_uses WHERE id = %L$$, v_use)),
      (16, 'spore_measurement_mosaic_tiles DELETE', format(
        $$DELETE FROM public.spore_measurement_mosaic_tiles WHERE measurement_id = %s$$, v_meas)),
      (17, 'spore_measurement_mosaics DELETE', format(
        $$DELETE FROM public.spore_measurement_mosaics WHERE id = %s$$, v_mosaic)),
      (18, 'observation_spore_summaries DELETE', format(
        $$DELETE FROM public.observation_spore_summaries WHERE id = %s$$, v_summary)),
      (19, 'spore_measurements DELETE', format(
        $$DELETE FROM public.spore_measurements WHERE id = %s$$, v_meas)),
      (20, 'observation_images DELETE', format(
        $$DELETE FROM public.observation_images WHERE id = %s$$, pg_temp.fx(p_tag || '.img2'))),
      (21, 'observations DELETE', format(
        $$DELETE FROM public.observations WHERE id = %s$$, v_obs))
    ) AS s (n, label, sql)
    ORDER BY n
  LOOP
    label := v_step.label;
    outcome := pg_temp.brake_try(p_ctx, v_step.sql);
    RETURN NEXT;
  END LOOP;
END
$fn$;

-- ---------------------------------------------------------------
-- Fixtures (as postgres, no request context).
-- ---------------------------------------------------------------

INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000b4a01', 'authenticated', 'authenticated',
        'brake-owner@example.test', '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name, is_banned)
VALUES ('00000000-0000-4000-8000-0000000b4a01', 'brake_owner', 'Brake Owner', false)
ON CONFLICT (id) DO UPDATE SET is_banned = false;

-- The reference RPCs read the rate-limit policy singleton; a schema-only
-- database has none. Values as in 20260830193144.
INSERT INTO private.shared_reference_production_policy (
  singleton, authenticated_requests_per_minute, anonymous_requests_per_minute,
  catalogue_default_page_size, catalogue_max_page_size,
  scientific_revision_retention, operational_log_retention,
  abuse_metadata_retention, takedown_initial_review_business_days)
SELECT true, 60, 30, 25, 100, 'indefinite', interval '90 days', interval '30 days', 5
 WHERE NOT EXISTS (SELECT 1 FROM private.shared_reference_production_policy);

INSERT INTO public.reference_works (user_id, id, type, title, short_label, authors_json, year, revision)
VALUES ('00000000-0000-4000-8000-0000000b4a01', '0b4a0000-0000-4000-8000-000000000001',
        'book', 'Brake source', 'Brake 2026', '[{"family":"Brake"}]', 2026, 1);
INSERT INTO public.reference_taxon_treatments (user_id, id, reference_work_id, name_as_published, revision)
VALUES ('00000000-0000-4000-8000-0000000b4a01', '0b4a0000-0000-4000-8000-000000000002',
        '0b4a0000-0000-4000-8000-000000000001', 'Russula paludosa', 1);
INSERT INTO public.reference_measurement_sets
  (user_id, id, taxon_treatment_id, character, data_kind, raw_text, length_core_min, length_core_max, revision)
VALUES ('00000000-0000-4000-8000-0000000b4a01', '0b4a0000-0000-4000-8000-000000000003',
        '0b4a0000-0000-4000-8000-000000000002', 'spore_size', 'range', '8-10 µm', 8, 10, 1),
       ('00000000-0000-4000-8000-0000000b4a01', '0b4a0000-0000-4000-8000-000000000004',
        '0b4a0000-0000-4000-8000-000000000002', 'spore_size', 'range', '9-11 µm', 9, 11, 1);

-- Computed as postgres: calling a function the role may not execute after
-- SET ROLE crashes the local Postgres backend, so request contexts only
-- ever receive this literal.
INSERT INTO fx VALUES
  ('snapshot', private.reference_canonical_snapshot(
     '00000000-0000-4000-8000-0000000b4a01', '0b4a0000-0000-4000-8000-000000000003')::text),
  ('snapshot2', private.reference_canonical_snapshot(
     '00000000-0000-4000-8000-0000000b4a01', '0b4a0000-0000-4000-8000-000000000004')::text);

SELECT pg_temp.make_fixture('old');
SELECT pg_temp.make_fixture('browser');
SELECT pg_temp.make_fixture('webview');
SELECT pg_temp.make_fixture('sync2');
SELECT pg_temp.make_fixture('service');
SELECT pg_temp.make_fixture('direct');

CREATE TEMP TABLE row_counts AS
SELECT 'observations' AS t, count(*) AS n FROM public.observations WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'
UNION ALL SELECT 'observation_images', count(*) FROM public.observation_images WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'
UNION ALL SELECT 'spore_measurements', count(*) FROM public.spore_measurements WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'
UNION ALL SELECT 'spore_measurement_mosaics', count(*) FROM public.spore_measurement_mosaics WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'
UNION ALL SELECT 'spore_measurement_mosaic_tiles', count(*) FROM public.spore_measurement_mosaic_tiles
  WHERE mosaic_id IN (SELECT id FROM public.spore_measurement_mosaics WHERE user_id = '00000000-0000-4000-8000-0000000b4a01')
UNION ALL SELECT 'observation_spore_summaries', count(*) FROM public.observation_spore_summaries WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'
UNION ALL SELECT 'observation_reference_uses', count(*) FROM public.observation_reference_uses WHERE user_id = '00000000-0000-4000-8000-0000000b4a01';

-- ---------------------------------------------------------------
-- 1. Guard function and trigger shape.
-- ---------------------------------------------------------------

SELECT is(
  (SELECT prosecdef FROM pg_proc WHERE oid = 'private.sync_brake_guard()'::regprocedure),
  false, 'sync_brake_guard is SECURITY INVOKER (prosecdef = false)');

SELECT ok(
  (SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'private.sync_brake_guard()'::regprocedure),
  'sync_brake_guard pins an empty search_path');

SELECT ok(
  NOT has_function_privilege('anon', 'private.sync_brake_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.sync_brake_guard()', 'EXECUTE'),
  'sync_brake_guard is not executable by anon or authenticated');

SELECT results_eq(
  $$SELECT c.relname::text COLLATE "default", t.tgtype::integer, t.tgenabled::text COLLATE "default"
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgname = 'trg_000_sync_brake'
       AND t.tgfoid = 'private.sync_brake_guard()'::regprocedure
     ORDER BY 1$$,
  $$VALUES ('observation_images', 31, 'O'), ('observation_reference_uses', 31, 'O'),
           ('observation_spore_summaries', 31, 'O'), ('observations', 31, 'O'),
           ('spore_measurement_mosaic_tiles', 31, 'O'), ('spore_measurement_mosaics', 31, 'O'),
           ('spore_measurements', 31, 'O')$$,
  'trg_000_sync_brake is an enabled BEFORE INSERT OR UPDATE OR DELETE row trigger on exactly the seven braked tables');

-- BEFORE row triggers fire in name order. Only these three sort before the
-- brake; each can only raise or (rate-limit suppression) skip the row, so
-- neither path writes anything. A new early trigger must be reviewed here.
SELECT results_eq(
  $$SELECT c.relname::text COLLATE "default", t.tgname::text COLLATE "default"
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND (t.tgtype & 3) = 3
       AND (t.tgname COLLATE "C") < 'trg_000_sync_brake'
       AND c.oid IN (SELECT tgrelid FROM pg_trigger WHERE tgname = 'trg_000_sync_brake')
     ORDER BY 1, 2$$,
  $$VALUES ('observations', 'enforce_non_public_observation_limit_trigger'),
           ('observations', 'guard_selected_sporely_taxon_id_v2_trg'),
           ('observations', 'observation_taxon_shared_reference_rate_row_trg')$$,
  'only the three known raise-or-skip BEFORE row triggers fire before trg_000_sync_brake');

-- ---------------------------------------------------------------
-- 2. Shipped desktop: every write on every braked table is refused.
-- ---------------------------------------------------------------

-- observation_reference_uses has no client table grants (writes go through
-- the sync_observation_reference_use RPC, section 3), so direct client DML on
-- it is denied by the privilege check (42501) before any trigger runs.
SELECT is(
  CASE WHEN label LIKE 'observation_reference_uses %' THEN split_part(outcome, ':', 1) ELSE outcome END,
  CASE WHEN label LIKE 'observation_reference_uses %' THEN '42501' ELSE 'P0001:sporely_upgrade_required' END,
  'old desktop: ' || label || ' is refused')
  FROM pg_temp.write_matrix('old_desktop', 'old');

SELECT is(current_setting('brake_test.last_message'),
  'Sporely Desktop must be updated before it can upload to Sporely Cloud. Install the latest version from sporely.no. Nothing was changed in the cloud.',
  'refusal carries the upgrade message');

-- Lists extracted from _CLOUD_AUTH_ERROR_HINTS and
-- _SUPABASE_TRANSIENT_ERROR_HINTS at v0.8.13, v0.9.1, v0.9.11, v0.9.15,
-- v0.9.18, v0.9.19, v0.9.25 and ee6f2af (union).
SELECT is_empty(
  $$SELECT w FROM unnest(ARRAY[
      'jwt expired', 'invalid jwt', 'expired access token', 'access token expired',
      'auth refresh failed', 'token expired', 'session expired', 'authentication failed',
      'invalid_grant', 'not logged in', 'unauthorized', 'pgrst301', 'pgrst303', 'captcha_failed',
      'bad gateway', 'connection aborted', 'connection refused', 'connection reset',
      'could not connect to server', 'gateway timeout', 'postgrest unavailable', 'schema cache',
      'service unavailable', 'temporarily unavailable', 'timed out', 'timeout'
    ]) AS w
    WHERE position(w IN lower(current_setting('brake_test.last_message') || ' sporely_upgrade_required')) > 0$$,
  'message and hint contain no shipped auth or transient hint word');

SELECT results_eq(
  $$SELECT t, n FROM row_counts ORDER BY t$$,
  $$SELECT * FROM (VALUES
      ('observation_images', (SELECT count(*) FROM public.observation_images WHERE user_id = '00000000-0000-4000-8000-0000000b4a01')),
      ('observation_reference_uses', (SELECT count(*) FROM public.observation_reference_uses WHERE user_id = '00000000-0000-4000-8000-0000000b4a01')),
      ('observation_spore_summaries', (SELECT count(*) FROM public.observation_spore_summaries WHERE user_id = '00000000-0000-4000-8000-0000000b4a01')),
      ('observations', (SELECT count(*) FROM public.observations WHERE user_id = '00000000-0000-4000-8000-0000000b4a01')),
      ('spore_measurement_mosaic_tiles', (SELECT count(*) FROM public.spore_measurement_mosaic_tiles
         WHERE mosaic_id IN (SELECT id FROM public.spore_measurement_mosaics WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'))),
      ('spore_measurement_mosaics', (SELECT count(*) FROM public.spore_measurement_mosaics WHERE user_id = '00000000-0000-4000-8000-0000000b4a01')),
      ('spore_measurements', (SELECT count(*) FROM public.spore_measurements WHERE user_id = '00000000-0000-4000-8000-0000000b4a01'))
    ) AS v (t, n) ORDER BY t$$,
  'refused writes left every row count unchanged');

SELECT is(
  (SELECT notes FROM public.observations WHERE id = pg_temp.fx('old.obs')::bigint),
  'brake fixture old', 'refused UPDATE left the observation unchanged');

SELECT is(
  (SELECT n_spores FROM public.observation_spore_summaries WHERE id = pg_temp.fx('old.summary')::bigint),
  2, 'refused UPDATE left the spore summary unchanged');

-- observation_images and spore_measurements writes also touch the parent
-- observation (AFTER trigger), so the matrix above would still see P0001 from
-- the observations brake if their own trigger were missing. Disable the
-- observations brake for this block (inside the test transaction, rolled
-- back) to prove each table's own trigger refuses.
ALTER TABLE public.observations DISABLE TRIGGER trg_000_sync_brake;

SELECT is(pg_temp.brake_try('old_desktop', format(
    $$INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, notes)
      VALUES (%s, '00000000-0000-4000-8000-0000000b4a01', %L, 'field', 'isolated')$$,
    pg_temp.fx('old.obs'), '00000000-0000-4000-8000-0000000b4a01/' || pg_temp.fx('old.obs') || '/isolated.webp')),
  'P0001:sporely_upgrade_required', 'isolated: observation_images INSERT is refused by its own trigger');
SELECT is(pg_temp.brake_try('old_desktop', format(
    $$UPDATE public.observation_images SET notes = 'isolated' WHERE id = %s$$, pg_temp.fx('old.img'))),
  'P0001:sporely_upgrade_required', 'isolated: observation_images UPDATE is refused by its own trigger');
SELECT is(pg_temp.brake_try('old_desktop', format(
    $$DELETE FROM public.observation_images WHERE id = %s$$, pg_temp.fx('old.img2'))),
  'P0001:sporely_upgrade_required', 'isolated: observation_images DELETE is refused by its own trigger');
SELECT is(pg_temp.brake_try('old_desktop', format(
    $$INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, notes)
      VALUES (%s, '00000000-0000-4000-8000-0000000b4a01', 9.0, 4.0, 'isolated')$$, pg_temp.fx('old.img'))),
  'P0001:sporely_upgrade_required', 'isolated: spore_measurements INSERT is refused by its own trigger');
SELECT is(pg_temp.brake_try('old_desktop', format(
    $$UPDATE public.spore_measurements SET notes = 'isolated' WHERE id = %s$$, pg_temp.fx('old.meas'))),
  'P0001:sporely_upgrade_required', 'isolated: spore_measurements UPDATE is refused by its own trigger');
SELECT is(pg_temp.brake_try('old_desktop', format(
    $$DELETE FROM public.spore_measurements WHERE id = %s$$, pg_temp.fx('old.meas2'))),
  'P0001:sporely_upgrade_required', 'isolated: spore_measurements DELETE is refused by its own trigger');

ALTER TABLE public.observations ENABLE TRIGGER trg_000_sync_brake;

-- Identification variants: case, anon, and a sync-identity value other than 2.
SELECT is(
  pg_temp.brake_try('old_desktop_mixed_case',
    format($$UPDATE public.observations SET notes = 'x' WHERE id = %s$$, pg_temp.fx('old.obs'))),
  'P0001:sporely_upgrade_required', 'User-Agent match is case-insensitive');

SELECT is(
  pg_temp.brake_try('old_desktop_sync_identity_1',
    format($$UPDATE public.observations SET notes = 'x' WHERE id = %s$$, pg_temp.fx('old.obs'))),
  'P0001:sporely_upgrade_required', 'x-sporely-sync-identity other than 2 is still refused');

-- A real anon request cannot reach these rows (the RLS policies read
-- observations, which anon may not select). The guard keys on the JWT role,
-- so this case keeps the session role privileged and sets anon claims.
SELECT is(
  pg_temp.brake_try('old_desktop_anon_claims',
    format($$INSERT INTO public.observation_spore_summaries (observation_id, user_id, context_hash, n_spores)
             VALUES (%s, '00000000-0000-4000-8000-0000000b4a01', 'anon', 1)$$, pg_temp.fx('old.obs'))),
  'P0001:sporely_upgrade_required', 'anon JWT role with the old User-Agent is refused');

SELECT is(
  pg_temp.brake_try('old_desktop',
    $$INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px)
      VALUES (-1, -1, 0, 0, 1, 1)$$),
  'P0001:sporely_upgrade_required', 'the brake fires before RLS and constraint checks');

-- ---------------------------------------------------------------
-- 3. Writes inside RPCs are refused for the shipped desktop.
-- ---------------------------------------------------------------

-- set_observation_location exists only where the ingestion-location work is
-- applied; on main it is absent and this case is skipped.
SELECT CASE WHEN to_regprocedure(
    'public.set_observation_location(bigint, double precision, double precision, real, real, text, text)') IS NULL
  THEN skip('public.set_observation_location does not exist in this database', 2)
  ELSE collect_tap(
    is(pg_temp.brake_try('old_desktop',
         format($$SELECT public.set_observation_location(%s, 63.1234, 10.5678, NULL, NULL, 'image_exif', 'acquired')$$,
                pg_temp.fx('old.obs'))),
       'P0001:sporely_upgrade_required', 'set_observation_location from the old desktop is refused'),
    is(pg_temp.brake_try('browser',
         format($$SELECT public.set_observation_location(%s, 63.1234, 10.5678, NULL, NULL, 'image_exif', 'acquired')$$,
                pg_temp.fx('browser.obs'))),
       'ok:1', 'set_observation_location from a browser succeeds'))
  END;

SELECT is(
  (SELECT gps_latitude FROM public.observations WHERE id = pg_temp.fx('old.obs')::bigint),
  NULL::double precision, 'refused location RPC left the victim location unchanged');

-- A SECURITY DEFINER function runs as its owner (postgres here, which
-- bypasses RLS), yet PostgREST's request settings stay set, so the brake
-- still refuses. Created in this transaction and rolled back with it.
CREATE FUNCTION public.brake_test_definer_set_notes(p_id bigint, p_notes text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  UPDATE public.observations SET notes = p_notes WHERE id = p_id;
  RETURN p_id;
END
$fn$;
GRANT EXECUTE ON FUNCTION public.brake_test_definer_set_notes(bigint, text) TO authenticated;

SELECT is(
  pg_temp.brake_try('old_desktop',
    format($$SELECT public.brake_test_definer_set_notes(%s, 'definer')$$, pg_temp.fx('old.obs'))),
  'P0001:sporely_upgrade_required', 'a write inside a SECURITY DEFINER function from the old desktop is refused');

SELECT is(
  pg_temp.brake_try('browser',
    format($$SELECT public.brake_test_definer_set_notes(%s, 'definer')$$, pg_temp.fx('browser.obs'))),
  'ok:1', 'a write inside a SECURITY DEFINER function from a browser succeeds');

-- observation_reference_uses is client-writable only through RPCs. These
-- test-only SECURITY DEFINER writers reach its trigger the way
-- sync_observation_reference_use does, without changing production grants
-- and without needing reference_rls. Each returns the affected row count.
CREATE FUNCTION public.brake_test_definer_use_insert(p_obs bigint, p_snapshot jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_rows bigint;
BEGIN
  INSERT INTO public.observation_reference_uses
    (user_id, id, observation_id, reference_measurement_set_id, role, reference_revision, snapshot_json)
  VALUES ('00000000-0000-4000-8000-0000000b4a01', gen_random_uuid(), p_obs,
          '0b4a0000-0000-4000-8000-000000000004', 'compared', 1, p_snapshot);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$fn$;
CREATE FUNCTION public.brake_test_definer_use_update(p_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_rows bigint;
BEGIN
  UPDATE public.observation_reference_uses SET note = 'definer' WHERE id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$fn$;
CREATE FUNCTION public.brake_test_definer_use_delete(p_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_rows bigint;
BEGIN
  DELETE FROM public.observation_reference_uses WHERE id = p_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$fn$;
GRANT EXECUTE ON FUNCTION public.brake_test_definer_use_insert(bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.brake_test_definer_use_update(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.brake_test_definer_use_delete(uuid) TO authenticated;

-- Old desktop: all three refused. 'ok:1' would require exactly one row
-- written, so an allowed write cannot pass as a refusal or vice versa.
SELECT is(
  pg_temp.brake_try('old_desktop', format(
    $$SELECT 1 WHERE public.brake_test_definer_use_insert(%s, %L::jsonb) = 1$$,
    pg_temp.fx('old.obs'), pg_temp.fx('snapshot2'))),
  'P0001:sporely_upgrade_required', 'old desktop: observation_reference_uses INSERT inside a definer is refused');
SELECT is(
  pg_temp.brake_try('old_desktop', format(
    $$SELECT 1 WHERE public.brake_test_definer_use_update(%L) = 1$$, pg_temp.fx('old.use'))),
  'P0001:sporely_upgrade_required', 'old desktop: observation_reference_uses UPDATE inside a definer is refused');
SELECT is(
  pg_temp.brake_try('old_desktop', format(
    $$SELECT 1 WHERE public.brake_test_definer_use_delete(%L) = 1$$, pg_temp.fx('old.use'))),
  'P0001:sporely_upgrade_required', 'old desktop: observation_reference_uses DELETE inside a definer is refused');
SELECT results_eq(
  format($$SELECT note, (SELECT count(*) FROM public.observation_reference_uses WHERE observation_id = %s)
             FROM public.observation_reference_uses WHERE id = %L$$,
         pg_temp.fx('old.obs'), pg_temp.fx('old.use')),
  $$VALUES (NULL::text, 1::bigint)$$,
  'refused definer writes left the old desktop''s reference uses unchanged');

-- Allowed contexts: the same three writes succeed, one row each.
SELECT is(
  pg_temp.brake_try(ctx, format(
    $$SELECT 1 WHERE public.brake_test_definer_use_insert(%s, %L::jsonb) = 1$$,
    pg_temp.fx(tag || '.obs'), pg_temp.fx('snapshot2'))),
  'ok:1', ctx || ': observation_reference_uses INSERT inside a definer succeeds')
  FROM (VALUES ('browser', 'browser'), ('sync_identity_2', 'sync2')) AS c (ctx, tag);
SELECT is(
  pg_temp.brake_try(ctx, format(
    $$SELECT 1 WHERE public.brake_test_definer_use_update(%L) = 1$$, pg_temp.fx(tag || '.use'))),
  'ok:1', ctx || ': observation_reference_uses UPDATE inside a definer succeeds')
  FROM (VALUES ('browser', 'browser'), ('sync_identity_2', 'sync2')) AS c (ctx, tag);
SELECT is(
  pg_temp.brake_try(ctx, format(
    $$SELECT 1 WHERE public.brake_test_definer_use_delete(%L) = 1$$, pg_temp.fx(tag || '.use'))),
  'ok:1', ctx || ': observation_reference_uses DELETE inside a definer succeeds')
  FROM (VALUES ('browser', 'browser'), ('sync_identity_2', 'sync2')) AS c (ctx, tag);

SELECT is(
  (SELECT prosecdef FROM pg_proc
    WHERE oid = 'public.sync_observation_reference_use(jsonb, bigint, text, jsonb)'::regprocedure),
  true, 'sync_observation_reference_use is SECURITY DEFINER');

-- The reference RPCs need the reference_rls schema. Schema-only snapshots
-- restored without supabase_admin can lack it; skip cleanly there.
SELECT CASE WHEN to_regnamespace('reference_rls') IS NULL
  THEN skip('reference_rls schema is missing in this database', 1)
  ELSE is(
    pg_temp.brake_try('old_desktop', format(
      $$SELECT public.sync_observation_reference_use(
          jsonb_build_object('id', gen_random_uuid(), 'observation_id', %s,
                             'reference_measurement_set_id', '0b4a0000-0000-4000-8000-000000000003',
                             'role', 'compared', 'reference_revision', 1, 'snapshot_json', %L::jsonb),
          0, 'current', NULL)$$, pg_temp.fx('old.obs'), pg_temp.fx('snapshot'))),
    'P0001:sporely_upgrade_required',
    'SECURITY DEFINER sync_observation_reference_use create from the old desktop is refused')
  END;

SELECT CASE WHEN to_regnamespace('reference_rls') IS NULL
  THEN skip('reference_rls schema is missing in this database', 1)
  ELSE is(
    pg_temp.brake_try('old_desktop', format(
      $$SELECT public.sync_observation_reference_use(
          jsonb_build_object('id', %L, 'deleted', true), 1, 'current', NULL)$$, pg_temp.fx('old.use'))),
    'P0001:sporely_upgrade_required',
    'SECURITY DEFINER sync_observation_reference_use detach from the old desktop is refused')
  END;

SELECT is(
  (SELECT deleted_at FROM public.observation_reference_uses WHERE id = pg_temp.fx('old.use')::uuid),
  NULL::timestamptz, 'the old desktop''s reference use stays attached');

-- The same RPC path works from a browser.
SELECT CASE WHEN to_regnamespace('reference_rls') IS NULL
  THEN skip('reference_rls schema is missing in this database', 1)
  ELSE is(
    pg_temp.brake_try('browser', format(
      $$SELECT 1 WHERE public.sync_observation_reference_use(
          jsonb_build_object('id', gen_random_uuid(), 'observation_id', %s,
                             'reference_measurement_set_id', '0b4a0000-0000-4000-8000-000000000004',
                             'role', 'compared', 'reference_revision', 1, 'snapshot_json', %L::jsonb),
          0, 'current', NULL) ->> 'status' = 'created'$$, pg_temp.fx('webview.obs'), pg_temp.fx('snapshot2'))),
    'ok:1', 'sync_observation_reference_use create from a browser succeeds')
  END;

-- ---------------------------------------------------------------
-- 4. Reads are unaffected for the shipped desktop.
-- ---------------------------------------------------------------

SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.observations WHERE id = %s$$, pg_temp.fx('old.obs'))),
  'ok:1', 'old desktop can read observations');
SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.observation_images WHERE observation_id = %s$$, pg_temp.fx('old.obs'))),
  'ok:2', 'old desktop can read observation_images');
SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.spore_measurements WHERE image_id = %s$$, pg_temp.fx('old.img'))),
  'ok:2', 'old desktop can read spore_measurements');
SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.spore_measurement_mosaics WHERE observation_id = %s$$, pg_temp.fx('old.obs'))),
  'ok:1', 'old desktop can read spore_measurement_mosaics');
SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.spore_measurement_mosaic_tiles WHERE mosaic_id = %s$$, pg_temp.fx('old.mosaic'))),
  'ok:1', 'old desktop can read spore_measurement_mosaic_tiles');
SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.observation_spore_summaries WHERE observation_id = %s$$, pg_temp.fx('old.obs'))),
  'ok:1', 'old desktop can read observation_spore_summaries');
SELECT is(pg_temp.brake_try('old_desktop',
  format($$SELECT 1 FROM public.observation_reference_uses WHERE observation_id = %s$$, pg_temp.fx('old.obs'))),
  'ok:1', 'old desktop can read observation_reference_uses');

-- ---------------------------------------------------------------
-- 5. Clients that are not braked: every write succeeds (authenticated
--    direct DML on observation_reference_uses is denied by privileges as in
--    section 2; service_role and direct sessions may write it).
-- ---------------------------------------------------------------

SELECT is(
  CASE WHEN label LIKE 'observation_reference_uses %' THEN split_part(outcome, ':', 1) ELSE outcome END,
  CASE WHEN label LIKE 'observation_reference_uses %' THEN '42501' ELSE 'ok:1' END,
  'browser: ' || label)
  FROM pg_temp.write_matrix('browser', 'browser');

SELECT is(
  CASE WHEN label LIKE 'observation_reference_uses %' THEN split_part(outcome, ':', 1) ELSE outcome END,
  CASE WHEN label LIKE 'observation_reference_uses %' THEN '42501' ELSE 'ok:1' END,
  'Android WebView: ' || label)
  FROM pg_temp.write_matrix('webview', 'webview');

SELECT is(
  CASE WHEN label LIKE 'observation_reference_uses %' THEN split_part(outcome, ':', 1) ELSE outcome END,
  CASE WHEN label LIKE 'observation_reference_uses %' THEN '42501' ELSE 'ok:1' END,
  'x-sporely-sync-identity 2: ' || label)
  FROM pg_temp.write_matrix('sync_identity_2', 'sync2');

SELECT is(outcome, 'ok:1', 'service_role with the old User-Agent: ' || label)
  FROM pg_temp.write_matrix('service_role', 'service');

SELECT is(outcome, 'ok:1', 'no request headers (migration/cron): ' || label)
  FROM pg_temp.write_matrix('no_headers', 'direct');

SELECT is(
  pg_temp.brake_try('no_user_agent',
    format($$UPDATE public.observations SET notes = 'no ua' WHERE id = %s$$, pg_temp.fx('old.obs'))),
  'ok:1', 'an API request without a User-Agent is not braked');

SELECT * FROM finish();

ROLLBACK;
