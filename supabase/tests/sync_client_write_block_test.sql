-- Regression coverage for 20261014120000_sync_client_write_block (desktop
-- write stop). Proves:
--   * the block table is owner-only (no grants to PUBLIC, anon,
--     authenticated or service_role; RLS on, no policies) and the migration
--     left it empty;
--   * the guard is SECURITY DEFINER with search_path '', not executable by
--     clients, and fires BEFORE INSERT/UPDATE/DELETE on all seven tables;
--   * a listed version sent with x-sporely-sync-identity is refused on
--     INSERT, UPDATE and DELETE of every covered table, for postgres,
--     authenticated and service_role, and inside set_observation_location
--     and a SECURITY DEFINER RPC;
--   * nothing else is refused: an empty table, an unlisted version, a
--     released desktop (python-requests, no identity header) whose version
--     string is listed, a request without the identity header, the web's
--     headers, and a SQL session with no request headers;
--   * the refusal is P0001 with hint sporely_upgrade_required and fixed text
--     without auth or transient words;
--   * after unblocking, the same writes go through.
--
-- Every write probe runs in a subtransaction that is rolled back, so each
-- header state sees the same fixtures, and reports the affected row count:
-- a probe that touched no row would prove nothing, because row triggers do
-- not fire for zero rows.
--
-- Run after local migrations:
--   supabase test db supabase/tests/sync_client_write_block_test.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(43);

-- ---------------------------------------------------------------
-- Migration left the table empty (checked before any test write).
-- ---------------------------------------------------------------

SELECT is((SELECT count(*)::int FROM private.sync_client_write_block), 0,
  'the migration inserted no rows into private.sync_client_write_block');

-- ---------------------------------------------------------------
-- Shape and privileges.
-- ---------------------------------------------------------------

SELECT has_table('private', 'sync_client_write_block', 'private.sync_client_write_block exists');
SELECT columns_are('private', 'sync_client_write_block', ARRAY['client_version', 'reason', 'created_at'],
  'block table has exactly client_version, reason, created_at');
SELECT col_is_pk('private', 'sync_client_write_block', 'client_version', 'client_version is the primary key');
SELECT col_type_is('private', 'sync_client_write_block', 'client_version', 'text', 'client_version is text');
SELECT col_not_null('private', 'sync_client_write_block', 'reason', 'reason is NOT NULL');
SELECT col_type_is('private', 'sync_client_write_block', 'created_at', 'timestamp with time zone', 'created_at is timestamptz');
SELECT col_not_null('private', 'sync_client_write_block', 'created_at', 'created_at is NOT NULL');
SELECT col_default_is('private', 'sync_client_write_block', 'created_at', 'now()', 'created_at defaults to now()');

SELECT is((SELECT relrowsecurity FROM pg_class WHERE oid = 'private.sync_client_write_block'::regclass),
  true, 'RLS is enabled on the block table');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = 'private.sync_client_write_block'::regclass),
  0, 'the block table has no policies');
SELECT is(
  (SELECT count(*)::int FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid = 'private.sync_client_write_block'::regclass AND a.grantee <> c.relowner),
  0, 'the block table grants no privilege to anyone but its owner (PUBLIC included)');
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r(role),
                  unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
     WHERE has_table_privilege(r.role, 'private.sync_client_write_block', p.priv)),
  'anon, authenticated and service_role hold no privilege on the block table');

SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'private.sync_client_write_block_guard()'::regprocedure),
  true, 'sync_client_write_block_guard is SECURITY DEFINER (prosecdef = true)');
SELECT is((SELECT proconfig FROM pg_proc WHERE oid = 'private.sync_client_write_block_guard()'::regprocedure),
  ARRAY['search_path=""'], 'sync_client_write_block_guard pins search_path to the empty string');
SELECT is(
  (SELECT p.proowner FROM pg_proc p WHERE p.oid = 'private.sync_client_write_block_guard()'::regprocedure),
  (SELECT c.relowner FROM pg_class c WHERE c.oid = 'private.sync_client_write_block'::regclass),
  'the guard and the block table have the same (migration) owner');
SELECT ok(
  NOT has_function_privilege('anon', 'private.sync_client_write_block_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.sync_client_write_block_guard()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'private.sync_client_write_block_guard()', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = 'private.sync_client_write_block_guard()'::regprocedure AND a.grantee = 0),
  'the guard is not executable by PUBLIC, anon, authenticated or service_role');

-- tgtype 31 = ROW | BEFORE | INSERT | DELETE | UPDATE.
SELECT is(
  ARRAY(SELECT tgrelid::regclass::text || '.' || tgname FROM pg_trigger
         WHERE tgfoid = 'private.sync_client_write_block_guard()'::regprocedure
           AND tgtype = 31 AND tgenabled = 'O' AND NOT tgisinternal
         ORDER BY 1),
  ARRAY['observation_images.aaa_sync_client_write_block',
        'observation_reference_uses.aaa_sync_client_write_block',
        'observation_spore_summaries.aaa_sync_client_write_block',
        'observations.aaa_sync_client_write_block',
        'spore_measurement_mosaic_tiles.aaa_sync_client_write_block',
        'spore_measurement_mosaics.aaa_sync_client_write_block',
        'spore_measurements.aaa_sync_client_write_block'],
  'one enabled BEFORE INSERT/UPDATE/DELETE row guard on each of the seven covered tables');
SELECT is(
  (SELECT count(*)::int FROM pg_trigger WHERE tgfoid = 'private.sync_client_write_block_guard()'::regprocedure),
  7, 'the guard is attached nowhere else');

-- The function body may read only the block table and request.headers.
SELECT ok(
  (SELECT prosrc FROM pg_proc WHERE oid = 'private.sync_client_write_block_guard()'::regprocedure)
    !~* '(current_user|session_user|current_role|\mINSERT\s+INTO\M|\mUPDATE\s+\S+\s+SET\M|\mDELETE\s+FROM\M)',
  'the guard does not consult current_user/session_user and writes nothing');

-- ---------------------------------------------------------------
-- Helpers.
-- ---------------------------------------------------------------

-- Run a write and roll it back. Reports 'OK:<rows>' or '<sqlstate>:<hint>'.
CREATE FUNCTION public._wb_test_try(p_sql text) RETURNS text
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE n bigint; st text; h text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'wb probe rollback' USING ERRCODE = 'ZWB01';
  EXCEPTION
    WHEN SQLSTATE 'ZWB01' THEN RETURN 'OK:' || n;
    WHEN others THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT;
      RETURN st || ':' || coalesce(h, '');
  END;
END $$;

CREATE FUNCTION public._wb_test_refusal(p_sql text, OUT state_hint text, OUT message text)
  LANGUAGE plpgsql SET search_path = pg_catalog, public
AS $$
DECLARE st text; h text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    state_hint := 'OK';
    RAISE EXCEPTION 'wb probe rollback' USING ERRCODE = 'ZWB01';
  EXCEPTION
    WHEN SQLSTATE 'ZWB01' THEN NULL;
    WHEN others THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT, message = MESSAGE_TEXT;
      state_hint := st || ':' || coalesce(h, '');
  END;
END $$;

GRANT EXECUTE ON FUNCTION public._wb_test_try(text), public._wb_test_refusal(text)
  TO authenticated, service_role;

-- A SECURITY DEFINER RPC owned by the migration owner that writes a row.
CREATE FUNCTION public._wb_test_definer_touch(p_observation_id bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.observations SET notes = 'definer touch' WHERE id = p_observation_id;
END $$;
GRANT EXECUTE ON FUNCTION public._wb_test_definer_touch(bigint) TO authenticated;

-- ---------------------------------------------------------------
-- Fixtures (as postgres, with no request headers: a plain SQL session
-- writes all seven tables, which the guard must allow).
-- ---------------------------------------------------------------

SELECT is(current_setting('request.headers', true), NULL, 'the fixture session carries no request headers');

CREATE TEMP TABLE fx (k text PRIMARY KEY, v text);
GRANT SELECT ON fx TO authenticated, service_role;

DO $$
DECLARE
  owner uuid := '00000000-0000-4000-8000-00000000eb01';
  obs bigint; obs2 bigint; obs_spare bigint; img bigint; meas bigint; meas2 bigint; mos bigint; summ bigint;
  set_1 uuid := '33000000-0000-4000-8000-00000000eb01';
  use_1 uuid := '44000000-0000-4000-8000-00000000eb01';
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (owner, 'authenticated', 'authenticated', 'wb-owner@example.test', '{}'::jsonb, now(), now());
  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES (owner, 'wb_owner', 'WB Owner', false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  INSERT INTO public.observations (user_id, date, notes) VALUES (owner, '2026-10-01', 'wb') RETURNING id INTO obs;
  INSERT INTO public.observations (user_id, date, notes) VALUES (owner, '2026-10-02', 'wb2') RETURNING id INTO obs2;
  INSERT INTO public.observations (user_id, date, notes) VALUES (owner, '2026-10-03', 'spare') RETURNING id INTO obs_spare;
  INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path)
  VALUES (obs, owner, 'field', owner::text || '/wb-image.webp') RETURNING id INTO img;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (img, owner, 10.0) RETURNING id INTO meas;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (img, owner, 11.0) RETURNING id INTO meas2;
  INSERT INTO public.spore_measurement_mosaics (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (obs, owner, owner::text || '/' || obs || '/spore_mosaic_v1_eb01.webp', 256, 128, 64, 1) RETURNING id INTO mos;
  INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px)
  VALUES (meas, mos, 0, 0, 64, 64);
  INSERT INTO public.observation_spore_summaries (observation_id, user_id, context_hash)
  VALUES (obs, owner, 'wb-h1') RETURNING id INTO summ;

  INSERT INTO public.reference_works (user_id, id, type, title, short_label, authors_json, year, revision)
  VALUES (owner, '11000000-0000-4000-8000-00000000eb01', 'book', 'WB source', 'WB 2026', '[]', 2026, 1);
  INSERT INTO public.reference_taxon_treatments (user_id, id, reference_work_id, name_as_published, revision)
  VALUES (owner, '22000000-0000-4000-8000-00000000eb01', '11000000-0000-4000-8000-00000000eb01', 'Russula wb', 1);
  INSERT INTO public.reference_measurement_sets (user_id, id, taxon_treatment_id, character, data_kind, raw_text,
                                                 length_core_min, length_core_max, revision)
  VALUES (owner, set_1, '22000000-0000-4000-8000-00000000eb01', 'spore_size', 'range', '8-10 µm', 8, 10, 1);
  INSERT INTO public.observation_reference_uses (user_id, id, observation_id, reference_measurement_set_id, role,
                                                 reference_revision, snapshot_json)
  VALUES (owner, use_1, obs, set_1, 'compared', 1, private.reference_canonical_snapshot(owner, set_1));

  INSERT INTO fx VALUES ('owner', owner::text), ('obs', obs::text), ('obs2', obs2::text), ('obs_spare', obs_spare::text),
    ('img', img::text), ('meas', meas::text), ('meas2', meas2::text), ('mos', mos::text), ('summ', summ::text),
    ('set_1', set_1::text), ('use_1', use_1::text),
    -- Computed once here: the probes insert it as a literal, so they need no
    -- privilege on private.* under any role.
    ('snapshot_1', private.reference_canonical_snapshot(owner, set_1)::text);
END $$;

SELECT is(
  ARRAY[(SELECT count(*)::int FROM public.observations WHERE user_id = (SELECT v::uuid FROM fx WHERE k = 'owner')),
        (SELECT count(*)::int FROM public.observation_images WHERE user_id = (SELECT v::uuid FROM fx WHERE k = 'owner')),
        (SELECT count(*)::int FROM public.spore_measurements WHERE user_id = (SELECT v::uuid FROM fx WHERE k = 'owner')),
        (SELECT count(*)::int FROM public.spore_measurement_mosaics WHERE user_id = (SELECT v::uuid FROM fx WHERE k = 'owner')),
        (SELECT count(*)::int FROM public.spore_measurement_mosaic_tiles WHERE measurement_id = (SELECT v::bigint FROM fx WHERE k = 'meas')),
        (SELECT count(*)::int FROM public.observation_spore_summaries WHERE user_id = (SELECT v::uuid FROM fx WHERE k = 'owner')),
        (SELECT count(*)::int FROM public.observation_reference_uses WHERE user_id = (SELECT v::uuid FROM fx WHERE k = 'owner'))],
  ARRAY[3, 1, 2, 1, 1, 1, 1],
  'a session with no request headers wrote rows into all seven covered tables');

-- INSERT, UPDATE and DELETE on every covered table. Each touches one row.
CREATE TEMP TABLE wb_matrix (ord int PRIMARY KEY, label text NOT NULL, stmt text NOT NULL);
INSERT INTO wb_matrix
SELECT row_number() OVER (), label, stmt FROM (
  SELECT f.* FROM (SELECT
    (SELECT v FROM fx WHERE k = 'owner') AS owner, (SELECT v FROM fx WHERE k = 'obs') AS obs,
    (SELECT v FROM fx WHERE k = 'obs2') AS obs2, (SELECT v FROM fx WHERE k = 'obs_spare') AS obs_spare,
    (SELECT v FROM fx WHERE k = 'img') AS img, (SELECT v FROM fx WHERE k = 'meas') AS meas,
    (SELECT v FROM fx WHERE k = 'meas2') AS meas2, (SELECT v FROM fx WHERE k = 'mos') AS mos,
    (SELECT v FROM fx WHERE k = 'summ') AS summ, (SELECT v FROM fx WHERE k = 'set_1') AS set_1,
    (SELECT v FROM fx WHERE k = 'use_1') AS use_1, (SELECT v FROM fx WHERE k = 'snapshot_1') AS snapshot_1) x,
  LATERAL (VALUES
    ('observations.insert', format($f$INSERT INTO public.observations (user_id, date) VALUES (%L, '2026-10-04')$f$, x.owner)),
    ('observations.update', format($f$UPDATE public.observations SET notes = 'probe' WHERE id = %s$f$, x.obs)),
    ('observations.delete', format($f$DELETE FROM public.observations WHERE id = %s$f$, x.obs_spare)),
    ('observation_images.insert', format($f$INSERT INTO public.observation_images (observation_id, user_id, image_type, storage_path) VALUES (%s, %L, 'field', %L)$f$,
                                         x.obs, x.owner, x.owner || '/wb-probe.webp')),
    ('observation_images.update', format($f$UPDATE public.observation_images SET notes = 'probe' WHERE id = %s$f$, x.img)),
    ('observation_images.delete', format($f$DELETE FROM public.observation_images WHERE id = %s$f$, x.img)),
    ('spore_measurements.insert', format($f$INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (%s, %L, 12.0)$f$, x.img, x.owner)),
    ('spore_measurements.update', format($f$UPDATE public.spore_measurements SET length_um = 10.5 WHERE id = %s$f$, x.meas)),
    ('spore_measurements.delete', format($f$DELETE FROM public.spore_measurements WHERE id = %s$f$, x.meas2)),
    ('spore_measurement_mosaics.insert', format($f$INSERT INTO public.spore_measurement_mosaics (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version) VALUES (%s, %L, %L, 256, 128, 64, 2)$f$,
                                                x.obs, x.owner, x.owner || '/' || x.obs || '/spore_mosaic_v2_eb01.webp')),
    ('spore_measurement_mosaics.update', format($f$UPDATE public.spore_measurement_mosaics SET common_crop_width_um = 1.5 WHERE id = %s$f$, x.mos)),
    ('spore_measurement_mosaics.delete', format($f$DELETE FROM public.spore_measurement_mosaics WHERE id = %s$f$, x.mos)),
    ('spore_measurement_mosaic_tiles.insert', format($f$INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px) VALUES (%s, %s, 64, 0, 64, 64)$f$, x.meas2, x.mos)),
    ('spore_measurement_mosaic_tiles.update', format($f$UPDATE public.spore_measurement_mosaic_tiles SET x_px = 1 WHERE measurement_id = %s$f$, x.meas)),
    ('spore_measurement_mosaic_tiles.delete', format($f$DELETE FROM public.spore_measurement_mosaic_tiles WHERE measurement_id = %s$f$, x.meas)),
    ('observation_spore_summaries.insert', format($f$INSERT INTO public.observation_spore_summaries (observation_id, user_id, context_hash) VALUES (%s, %L, 'wb-h2')$f$, x.obs, x.owner)),
    ('observation_spore_summaries.update', format($f$UPDATE public.observation_spore_summaries SET n_spores = 3 WHERE id = %s$f$, x.summ)),
    ('observation_spore_summaries.delete', format($f$DELETE FROM public.observation_spore_summaries WHERE id = %s$f$, x.summ)),
    ('observation_reference_uses.insert', format($f$INSERT INTO public.observation_reference_uses (user_id, id, observation_id, reference_measurement_set_id, role, reference_revision, snapshot_json) VALUES (%L, gen_random_uuid(), %s, %L, 'compared', 1, %L::jsonb)$f$,
                                                 x.owner, x.obs2, x.set_1, x.snapshot_1)),
    ('observation_reference_uses.update', format($f$UPDATE public.observation_reference_uses SET note = 'probe' WHERE user_id = %L AND id = %L$f$, x.owner, x.use_1)),
    ('observation_reference_uses.delete', format($f$DELETE FROM public.observation_reference_uses WHERE user_id = %L AND id = %L$f$, x.owner, x.use_1))
  ) f(label, stmt)
) m;
GRANT SELECT ON wb_matrix TO authenticated, service_role;

CREATE TEMP VIEW wb_run AS
SELECT ARRAY(SELECT label || '=' || public._wb_test_try(stmt) FROM wb_matrix ORDER BY ord) AS got;
CREATE TEMP VIEW wb_all_ok AS
SELECT ARRAY(SELECT label || '=OK:1' FROM wb_matrix ORDER BY ord) AS want;
CREATE TEMP VIEW wb_all_refused AS
SELECT ARRAY(SELECT label || '=P0001:sporely_upgrade_required' FROM wb_matrix ORDER BY ord) AS want;
GRANT SELECT ON wb_run, wb_all_ok, wb_all_refused TO authenticated, service_role;

SELECT is((SELECT count(*)::int FROM wb_matrix), 21, 'the probe matrix covers INSERT, UPDATE and DELETE on seven tables');

-- ---------------------------------------------------------------
-- Empty table (as the migration leaves it): nothing is blocked, the new
-- desktop included, whatever version it sends.
-- ---------------------------------------------------------------

SELECT set_config('request.headers',
  '{"x-sporely-sync-identity":"2","x-sporely-client-version":"9.9.9-wb-blocked","user-agent":"Sporely/9.9.9"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'empty table: every write with the identity header and the to-be-blocked version is allowed');
SELECT set_config('request.headers',
  '{"x-sporely-sync-identity":"2","x-sporely-client-version":"0.0.1-anything"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'empty table: every write with the identity header and another version is allowed');

-- ---------------------------------------------------------------
-- Block one version.
-- ---------------------------------------------------------------

SELECT set_config('request.headers', '', true);
INSERT INTO private.sync_client_write_block (client_version, reason)
VALUES ('9.9.9-wb-blocked', 'test: faulty build');

SELECT set_config('request.headers',
  '{"x-sporely-sync-identity":"2","x-sporely-client-version":"9.9.9-wb-blocked","user-agent":"Sporely/9.9.9"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_refused),
  'listed version with the identity header (postgres): INSERT, UPDATE and DELETE refused on every covered table');

SET LOCAL ROLE service_role;
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_refused),
  'listed version with the identity header (service_role): every covered write refused');
RESET ROLE;

-- As the owner through RLS, including the location RPC and a DEFINER RPC.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000eb01","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000eb01', true);

SELECT is(
  ARRAY[public._wb_test_try(format($f$UPDATE public.observations SET notes = 'probe' WHERE id = %s$f$, (SELECT v FROM fx WHERE k = 'obs'))),
        public._wb_test_try(format($f$UPDATE public.observation_images SET notes = 'probe' WHERE id = %s$f$, (SELECT v FROM fx WHERE k = 'img'))),
        public._wb_test_try(format($f$DELETE FROM public.spore_measurements WHERE id = %s$f$, (SELECT v FROM fx WHERE k = 'meas2'))),
        public._wb_test_try($f$INSERT INTO public.observations (user_id, date) VALUES (auth.uid(), '2026-10-05')$f$)],
  ARRAY['P0001:sporely_upgrade_required', 'P0001:sporely_upgrade_required',
        'P0001:sporely_upgrade_required', 'P0001:sporely_upgrade_required'],
  'listed version with the identity header (authenticated owner): writes refused');
SELECT is(
  public._wb_test_try(format($f$SELECT public.set_observation_location(%s, 59.91, 10.75, NULL, NULL, 'manual', 'acquired')$f$,
                             (SELECT v FROM fx WHERE k = 'obs'))),
  'P0001:sporely_upgrade_required',
  'a write made inside set_observation_location is refused');
SELECT is(
  public._wb_test_try(format($f$SELECT public._wb_test_definer_touch(%s)$f$, (SELECT v FROM fx WHERE k = 'obs'))),
  'P0001:sporely_upgrade_required',
  'a write made inside a SECURITY DEFINER RPC (running as its owner) is refused');

SELECT is(
  (public._wb_test_refusal(format($f$UPDATE public.observations SET notes = 'probe' WHERE id = %s$f$, (SELECT v FROM fx WHERE k = 'obs')))).message,
  'This version of Sporely Desktop is blocked from uploading. Install the latest version from sporely.no. Nothing was changed in the cloud.',
  'the refusal message is the fixed text and echoes no row values or version');
SELECT is(
  (SELECT count(*)::int
     FROM (SELECT lower(r.message || ' ' || r.state_hint) AS txt
             FROM wb_matrix m, LATERAL public._wb_test_refusal(m.stmt) r
            WHERE m.label LIKE 'observations.%' OR m.label LIKE 'observation_images.%'
               OR m.label LIKE 'spore_measurements.%') e,
          unnest(ARRAY['jwt expired', 'invalid jwt', 'jwt', 'token', 'expired access token', 'access token expired',
                       'auth refresh failed', 'token expired', 'session expired', 'authentication failed',
                       'invalid_grant', 'not logged in', 'unauthorized', 'pgrst301', 'pgrst303', 'captcha_failed',
                       'bad gateway', 'connection aborted', 'connection refused', 'connection reset',
                       'could not connect to server', 'gateway timeout', 'postgrest unavailable', 'schema cache',
                       'service unavailable', 'temporarily unavailable', 'unavailable', 'timed out', 'timeout']) w
    WHERE position(w IN e.txt) > 0),
  0, 'refusal message and hint contain no auth or transient word');

-- authenticated cannot read or change the block table.
SELECT throws_ok($$SELECT count(*) FROM private.sync_client_write_block$$, '42501', NULL,
  'authenticated cannot SELECT the block table');
SELECT throws_ok($$DELETE FROM private.sync_client_write_block$$, '42501', NULL,
  'authenticated cannot DELETE from the block table (cannot unblock itself)');
SELECT throws_ok($$SELECT private.sync_client_write_block_guard()$$, '42501', NULL,
  'authenticated cannot call the guard');

-- Headers that must never be blocked, still as the owner.
SELECT set_config('request.headers', '{"user-agent":"Mozilla/5.0","x-client-info":"supabase-js-web/2.0"}', true);
SELECT is(
  public._wb_test_try(format($f$SELECT public.set_observation_location(%s, 59.91, 10.75, NULL, NULL, 'manual', 'acquired')$f$,
                             (SELECT v FROM fx WHERE k = 'obs'))),
  'OK:1', 'web request (no identity header): set_observation_location write allowed');
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SET LOCAL ROLE service_role;
SELECT set_config('request.headers', '{"user-agent":"Deno/2.1"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'service_role request without the identity header (Edge Function shape): every write allowed');
SELECT throws_ok($$SELECT count(*) FROM private.sync_client_write_block$$, '42501', NULL,
  'service_role cannot SELECT the block table');
RESET ROLE;

SELECT set_config('request.headers',
  '{"user-agent":"python-requests/2.31.0","x-sporely-client-version":"9.9.9-wb-blocked"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'released desktop (python-requests, no identity header) is allowed even when its version string is listed');

SELECT set_config('request.headers',
  '{"x-sporely-sync-identity":"2","x-sporely-client-version":"9.9.10"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'identity header with an unlisted version is allowed');

SELECT set_config('request.headers', '{"x-sporely-sync-identity":"2"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'identity header without a version header is allowed');

SELECT set_config('request.headers', '', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'SQL session with no request headers is allowed while a version is listed');

-- ---------------------------------------------------------------
-- Unblock: the same build's pending writes go through.
-- ---------------------------------------------------------------

DELETE FROM private.sync_client_write_block WHERE client_version = '9.9.9-wb-blocked';
SELECT set_config('request.headers',
  '{"x-sporely-sync-identity":"2","x-sporely-client-version":"9.9.9-wb-blocked","user-agent":"Sporely/9.9.9"}', true);
SELECT is((SELECT got FROM wb_run), (SELECT want FROM wb_all_ok),
  'after unblocking, every write from the formerly blocked version is allowed');
SELECT set_config('request.headers', '', true);

SELECT * FROM finish();

ROLLBACK;
