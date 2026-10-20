-- Regression coverage for 20261020120000_media_key_retirement.sql (Stage 0a of
-- docs/plans/active/2026-10-20-media-key-retirement-and-cloud-copy-delete.md).
--
-- Proves, in one rolled-back transaction:
--   * ACLs: every new function's proacl is exactly the intended set; the
--     registry is SELECT-only for service_role and invisible to anon and
--     authenticated; service_role cannot INSERT/UPDATE/DELETE/TRUNCATE it and
--     even the owner cannot UPDATE delete_keys, DELETE or TRUNCATE;
--   * the guard is SECURITY DEFINER with an empty search_path and fires as an
--     unconditional BEFORE INSERT OR UPDATE row trigger (after every trigger
--     but the non-mutating zzz_sync_identity_guard_*) on the five
--     tables; the test_barriers schema is absent;
--   * release: every refusal, owner/foreign/anon/service checks, the apply
--     (paths, upload meta, purpose, owner measurement and cover clearing,
--     foreign rows untouched), replay by UUID (stored keys, no writes),
--     row_changed for a new UUID, operation_conflict, media_key_shared for a
--     second image, a foreign-owned measurement and another observation's
--     cover;
--   * every family form of a released key is refused on INSERT and UPDATE in
--     all five tables, for authenticated AND service_role (and the owner role);
--   * promotion to a new key and its rollback are unaffected;
--   * the brake accepts sync identity 2 and 3 and still refuses 1;
--   * purge claim: eligibility, window, grants, replay, already_claimed,
--     media_key_shared, restore refused (also a NULL-path microscope row, and
--     for every role), claim-only PATCHes refused, forged links refused
--     (GUC, wrong image, wrong owner, a 'release' record), a claim inside a
--     savepoint and inside an EXCEPTION block succeeds;
--   * finalize refused without a claim, works once with it;
--   * sweep: stored delete_keys exactly, exemption limited to the matching
--     claimed tombstone, any other reference reported, record + ordering,
--     interrupted purge recovered by sweep plus finalize;
--   * media_key_is_retired;
--   * reference checks use the expression indexes (EXPLAIN).
-- Isolation refusals and the two-session races live in
-- media_key_retirement_concurrency_test.sh.
--
--   supabase db reset --local
--   docker exec -i <db container> psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/tests/media_key_retirement_test.sql
--
-- Synthetic users only.

BEGIN;

CREATE TEMP TABLE fx (k text PRIMARY KEY, v text) ON COMMIT DROP;
GRANT ALL ON fx TO PUBLIC;

CREATE FUNCTION pg_temp.fx(p text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM fx WHERE k = p $$;
CREATE FUNCTION pg_temp.fxi(p text) RETURNS bigint LANGUAGE sql AS $$ SELECT v::bigint FROM fx WHERE k = p $$;

CREATE FUNCTION pg_temp.eq(p_actual anyelement, p_expected anyelement, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'FAIL %: got %, expected %', p_label, p_actual, p_expected;
  END IF;
END $$;

-- Run p_sql as p_role (with PostgREST-style claims); returns 'ok:<first value>'
-- or 'ERR:<sqlstate>:<hint or message>'.
CREATE FUNCTION pg_temp.run(p_role text, p_uid uuid, p_sql text, p_headers jsonb DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
  v_state text;
  v_hint text;
  v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE p_role
    WHEN 'authenticated' THEN json_build_object('sub', p_uid, 'role', 'authenticated')::text
    WHEN 'service_role' THEN '{"role":"service_role"}'
    WHEN 'anon' THEN '{"role":"anon"}'
    ELSE '' END, true);
  PERFORM set_config('request.headers', coalesce(p_headers::text, ''), true);
  IF p_role <> 'postgres' THEN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
  END IF;
  BEGIN
    EXECUTE p_sql INTO v_out;
    v_out := 'ok:' || coalesce(v_out, '');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    v_out := 'ERR:' || v_state || ':' || coalesce(nullif(v_hint, ''), v_msg);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.headers', '', true);
  RETURN v_out;
END $$;

CREATE FUNCTION pg_temp.status(p_out text) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN p_out LIKE 'ok:{%' THEN (substr(p_out, 4)::jsonb ->> 'status') ELSE p_out END
$$;

-- ---------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------
INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at) VALUES
  ('00000000-0000-4000-8000-0000006b0a01', 'authenticated', 'authenticated', 'mkr-a@example.invalid', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000006b0a02', 'authenticated', 'authenticated', 'mkr-b@example.invalid', '{}', now(), now());
INSERT INTO public.profiles (id, username, is_banned) VALUES
  ('00000000-0000-4000-8000-0000006b0a01', 'mkr_a', false),
  ('00000000-0000-4000-8000-0000006b0a02', 'mkr_b', false);
INSERT INTO fx VALUES ('A', '00000000-0000-4000-8000-0000006b0a01'), ('B', '00000000-0000-4000-8000-0000006b0a02');

-- seed(tag, owner, storage_path, original, image_type, deleted_days_ago)
CREATE FUNCTION pg_temp.seed(p_tag text, p_owner text, p_path text, p_original text DEFAULT NULL,
                             p_type text DEFAULT 'microscope', p_deleted_days int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid := pg_temp.fx(p_owner)::uuid;
  v_obs bigint;
  v_img bigint;
BEGIN
  INSERT INTO public.observations (user_id, date, visibility, is_draft, spore_data_visibility, notes)
  VALUES (v_owner, current_date, 'public', false, 'public', 'mkr ' || p_tag) RETURNING id INTO v_obs;
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, original_storage_path, image_type,
                                         upload_mode, source_width, source_height, stored_width, stored_height, stored_bytes)
  VALUES (v_obs, v_owner, p_path, p_original, p_type, 'reduced', 100, 80, 50, 40, 1234) RETURNING id INTO v_img;
  IF p_deleted_days IS NOT NULL THEN
    UPDATE public.observation_images SET deleted_at = now() - make_interval(days => p_deleted_days) WHERE id = v_img;
  END IF;
  INSERT INTO fx VALUES (p_tag || '.obs', v_obs::text), (p_tag || '.img', v_img::text);
END $$;

-- ---------------------------------------------------------------
-- 1. Function ACLs and properties.
-- ---------------------------------------------------------------
CREATE FUNCTION pg_temp.exec_grantees(p_fn regprocedure) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(g, ',' ORDER BY g COLLATE "C"), '')
    FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a,
         LATERAL (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g) n
   WHERE p.oid = p_fn AND a.privilege_type = 'EXECUTE'
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('private.media_key_normalize(text)', 'postgres'),
    ('private.media_key_strip_variant_prefixes(text)', 'postgres'),
    ('private.media_key_root(text)', 'authenticated,postgres,service_role'),
    ('private.media_key_family(text)', 'postgres'),
    ('private.lock_media_key_roots(text[])', 'postgres'),
    ('private.media_key_require_read_committed()', 'postgres'),
    ('private.media_key_registry_immutable()', 'postgres'),
    ('private.media_key_references(text[])', 'postgres'),
    ('private.media_key_owned_references(text[])', 'postgres'),
    ('private.media_key_is_valid(text)', 'postgres'),
    ('private.media_key_retirement_guard()', 'postgres'),
    ('private.media_key_retirement_replay(uuid,uuid,bigint,text)', 'postgres'),
    ('private.release_observation_image_bytes_core(uuid,bigint,text,text,text)', 'postgres'),
    ('private.claim_tombstoned_image_purge_core(uuid,bigint,integer)', 'postgres'),
    ('private.claim_retired_key_sweep_core(integer)', 'postgres'),
    ('private.record_retired_key_sweep_core(bigint[])', 'postgres'),
    ('private.media_key_is_retired_core(uuid,text)', 'postgres'),
    ('public.release_observation_image_bytes(uuid,bigint,text,text,text)', 'authenticated,postgres'),
    ('public.media_key_is_retired(uuid,text)', 'postgres,service_role'),
    ('public.claim_tombstoned_image_purge(uuid,bigint,integer)', 'postgres,service_role'),
    ('public.claim_retired_key_sweep(integer)', 'postgres,service_role'),
    ('public.record_retired_key_sweep(bigint[])', 'postgres,service_role'),
    ('public.finalize_observation_image_purge(bigint,timestamptz,bigint)', 'postgres,service_role')
  ) AS t(fn, expected) LOOP
    PERFORM pg_temp.eq(pg_temp.exec_grantees(r.fn::regprocedure), r.expected, 'EXECUTE grantees of ' || r.fn);
  END LOOP;

  FOR r IN SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig FROM pg_proc p
            WHERE p.oid IN ('private.media_key_retirement_guard()'::regprocedure,
                            'private.release_observation_image_bytes_core(uuid,bigint,text,text,text)'::regprocedure,
                            'private.claim_tombstoned_image_purge_core(uuid,bigint,integer)'::regprocedure,
                            'public.release_observation_image_bytes(uuid,bigint,text,text,text)'::regprocedure,
                            'public.finalize_observation_image_purge(bigint,timestamptz,bigint)'::regprocedure) LOOP
    PERFORM pg_temp.eq(r.prosecdef, true, r.fn || ' is SECURITY DEFINER');
    PERFORM pg_temp.eq('search_path=""'::text = ANY (r.proconfig), true, r.fn || ' has an empty search_path');
  END LOOP;
  PERFORM pg_temp.eq('lock_timeout=5s'::text = ANY ((SELECT proconfig FROM pg_proc WHERE oid = 'private.release_observation_image_bytes_core(uuid,bigint,text,text,text)'::regprocedure)::text[]), true, 'release lock_timeout');
  PERFORM pg_temp.eq('lock_timeout=5s'::text = ANY ((SELECT proconfig FROM pg_proc WHERE oid = 'private.claim_tombstoned_image_purge_core(uuid,bigint,integer)'::regprocedure)::text[]), true, 'claim lock_timeout');
  PERFORM pg_temp.eq((SELECT provolatile FROM pg_proc WHERE oid = 'private.media_key_root(text)'::regprocedure), 'i'::"char", 'root IMMUTABLE');
  PERFORM pg_temp.eq((SELECT provolatile FROM pg_proc WHERE oid = 'private.media_key_family(text)'::regprocedure), 'i'::"char", 'family IMMUTABLE');

  -- Unconditional BEFORE INSERT OR UPDATE row triggers, sorting last.
  FOR r IN SELECT t.tbl, (SELECT pg_get_triggerdef(tg.oid) FROM pg_trigger tg
                            WHERE tg.tgrelid = ('public.' || t.tbl)::regclass AND tg.tgname = 'zzy_media_key_retirement_guard') AS def,
                         (SELECT max(tg.tgname COLLATE "C") FROM pg_trigger tg
                            WHERE tg.tgrelid = ('public.' || t.tbl)::regclass AND NOT tg.tgisinternal
                              AND (tg.tgtype & 2) <> 0 AND (tg.tgtype & 1) <> 0) AS last_before_row
             FROM (VALUES ('observation_images'), ('spore_measurements'), ('observations'),
                          ('spore_measurement_mosaics'), ('calibrations')) AS t(tbl) LOOP
    PERFORM pg_temp.eq(r.def, format('CREATE TRIGGER zzy_media_key_retirement_guard BEFORE INSERT OR UPDATE ON public.%s FOR EACH ROW EXECUTE FUNCTION private.media_key_retirement_guard()', r.tbl), 'guard trigger on ' || r.tbl);
    -- Only the (non-mutating) zzz_sync_identity_guard_* may sort after it.
    PERFORM pg_temp.eq(r.last_before_row IN ('zzy_media_key_retirement_guard', 'zzz_sync_identity_guard_image',
                                             'zzz_sync_identity_guard_measurement', 'zzz_sync_identity_guard_obs'), true,
                       'guard sorts after every mutating BEFORE row trigger on ' || r.tbl || ' (last: ' || r.last_before_row || ')');
    PERFORM pg_temp.eq((SELECT count(*) FROM pg_trigger tg WHERE tg.tgrelid = ('public.' || r.tbl)::regclass AND NOT tg.tgisinternal
                          AND (tg.tgtype & 2) <> 0 AND (tg.tgtype & 1) <> 0
                          AND tg.tgname COLLATE "C" > 'zzy_media_key_retirement_guard'
                          AND tg.tgname NOT LIKE 'zzz\_sync\_identity\_guard\_%'), 0::bigint, 'nothing else after the guard on ' || r.tbl);
  END LOOP;

  PERFORM pg_temp.eq((SELECT count(*) FROM pg_namespace WHERE nspname = 'test_barriers'), 0::bigint, 'test_barriers schema absent');
  PERFORM pg_temp.eq((SELECT string_agg(DISTINCT tgenabled::text, ',') FROM pg_trigger
                       WHERE tgname IN ('zzy_media_key_retirement_guard', 'media_key_retirements_immutable', 'media_key_retirements_no_truncate',
                                        'retired_media_key_roots_immutable', 'retired_media_key_roots_no_truncate')), 'A', 'guard and registry triggers ENABLE ALWAYS');
  PERFORM pg_temp.eq((SELECT count(*) FROM pg_trigger WHERE tgname = 'zzy_media_key_retirement_guard'), 5::bigint, 'five guard triggers');
END $$;

-- ---------------------------------------------------------------
-- 2. Registry privileges and immutability.
-- ---------------------------------------------------------------
DO $$
DECLARE
  r record;
  p text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('private.media_key_retirements'), ('private.retired_media_key_roots')) t(tbl) LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      PERFORM pg_temp.eq(has_table_privilege('anon', r.tbl, p), false, 'anon ' || p || ' ' || r.tbl);
      PERFORM pg_temp.eq(has_table_privilege('authenticated', r.tbl, p), false, 'authenticated ' || p || ' ' || r.tbl);
      PERFORM pg_temp.eq(has_table_privilege('service_role', r.tbl, p), p = 'SELECT', 'service_role ' || p || ' ' || r.tbl);
    END LOOP;
    PERFORM pg_temp.eq((SELECT relrowsecurity FROM pg_class WHERE oid = r.tbl::regclass), true, 'RLS on ' || r.tbl);
  END LOOP;
  PERFORM pg_temp.eq(has_sequence_privilege('service_role', 'private.media_key_retirements_id_seq', 'USAGE'), false, 'service_role sequence');
END $$;

-- ---------------------------------------------------------------
-- 3. Release.
-- ---------------------------------------------------------------
DO $$
DECLARE
  a text := pg_temp.fx('A');
  b text := pg_temp.fx('B');
  k text;
  orig text;
  v_img bigint;
  v_obs bigint;
  v_out text;
  v_res jsonb;
  v_m1 bigint;
  v_m2 bigint;
  v_mb bigint;
  v_expected text[];
  v_updated timestamptz;
  v_uuid uuid := '6b0a0000-0000-4000-8000-000000000001';
BEGIN
  k := a || '/r1/small_photo.webp';
  orig := a || '/originals/r1/photo.jpg';
  PERFORM pg_temp.seed('rel', 'A', k, orig);
  v_img := pg_temp.fxi('rel.img'); v_obs := pg_temp.fxi('rel.obs');
  UPDATE public.observations SET image_key = a || '/r1/photo.webp', thumb_key = a || '/r1/thumb_small_photo.webp' WHERE id = v_obs;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, image_key, thumb_key)
  VALUES (v_img, a::uuid, 10, a || '/r1/medium_photo.webp', a || '/r1/measure_crop.webp') RETURNING id INTO v_m1;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, image_key)
  VALUES (v_img, a::uuid, 11, a || '/r1/measure_other.webp') RETURNING id INTO v_m2;

  -- Grants: anon and service_role cannot call; B sees not_found.
  v_out := pg_temp.run('anon', NULL, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'owner_sync')$q$, v_uuid, v_img, k, orig));
  PERFORM pg_temp.eq(v_out LIKE 'ERR:42501:%', true, 'anon release refused: ' || v_out);
  v_out := pg_temp.run('service_role', NULL, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'owner_sync')$q$, v_uuid, v_img, k, orig));
  PERFORM pg_temp.eq(v_out LIKE 'ERR:42501:%', true, 'service_role release refused: ' || v_out);
  v_out := pg_temp.run('authenticated', b::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'owner_sync')$q$, v_uuid, v_img, k, orig));
  PERFORM pg_temp.eq(pg_temp.status(v_out), 'not_found', 'foreign user release');

  -- Refusals.
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'owner_sync')$q$, v_uuid, v_img, k || 'x', orig))), 'row_changed', 'row_changed');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'bogus')$q$, v_uuid, v_img, k, orig))), 'purpose_invalid', 'purpose_invalid');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, NULL)$q$, v_uuid, v_img, k, orig))), 'purpose_invalid', 'purpose NULL');
  PERFORM pg_temp.seed('relfield', 'A', a || '/rf/field.webp', NULL, 'field');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(gen_random_uuid(), %s, %L, NULL, 'owner_sync')$q$, pg_temp.fxi('relfield.img'), a || '/rf/field.webp'))), 'not_microscope', 'not_microscope');
  PERFORM pg_temp.seed('reldel', 'A', a || '/rd/del.webp', NULL, 'microscope', 1);
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(gen_random_uuid(), %s, %L, NULL, 'owner_sync')$q$, pg_temp.fxi('reldel.img'), a || '/rd/del.webp'))), 'deleted', 'deleted');
  PERFORM pg_temp.eq((SELECT count(*) FROM private.media_key_retirements WHERE user_id = pg_temp.fx('A')::uuid), 0::bigint, 'no record after refusals');

  -- Cross-owner references. A new one from an end user is refused with one
  -- error whether or not the key is retired (no oracle). One planted behind
  -- the guard's back (as a pre-guard row would be) does not block the release.
  PERFORM pg_temp.seed('relcover', 'B', b || '/c/other.webp');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', b::uuid, format($q$UPDATE public.observations SET thumb_key = %L WHERE id = %s$q$, a || '/r1/thumb_photo.webp', pg_temp.fxi('relcover.obs'))), 'ERR:42501:sporely_media_key_foreign', 'foreign cover refused');
  ALTER TABLE public.spore_measurements DISABLE TRIGGER zzy_media_key_retirement_guard;
  ALTER TABLE public.observations DISABLE TRIGGER zzy_media_key_retirement_guard;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, image_key)
  VALUES (v_img, b::uuid, 9, a || '/r1/thumb_photo.webp') RETURNING id INTO v_mb;
  UPDATE public.observations SET thumb_key = a || '/r1/thumb_photo.webp' WHERE id = pg_temp.fxi('relcover.obs');
  ALTER TABLE public.spore_measurements ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
  ALTER TABLE public.observations ENABLE ALWAYS TRIGGER zzy_media_key_retirement_guard;
  INSERT INTO fx VALUES ('rel.foreign_meas', v_mb::text);

  -- Apply.
  v_out := pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'public_microscopy')$q$, v_uuid, v_img, k, orig));
  v_res := substr(v_out, 4)::jsonb;
  PERFORM pg_temp.eq(v_res ->> 'status', 'released', 'release status ' || v_out);
  PERFORM pg_temp.eq((v_res ->> 'replayed')::boolean, false, 'not replayed');
  v_expected := ARRAY(SELECT DISTINCT x COLLATE "C" FROM unnest(private.media_key_family(k) || private.media_key_family(orig)) x ORDER BY 1);
  PERFORM pg_temp.eq(ARRAY(SELECT jsonb_array_elements_text(v_res -> 'delete_keys')), v_expected, 'delete_keys = family(storage) ∪ family(original)');
  PERFORM pg_temp.eq((SELECT delete_keys FROM private.media_key_retirements WHERE operation_id = v_uuid), v_expected, 'stored delete_keys');
  PERFORM pg_temp.eq(orig = ANY (v_expected) AND (a || '/r1/thumb_photo.webp') = ANY (v_expected) AND k = ANY (v_expected), true, 'family contents');
  PERFORM pg_temp.eq((SELECT array_agg(key_root ORDER BY key_root COLLATE "C") FROM private.retired_media_key_roots WHERE user_id = pg_temp.fx('A')::uuid), ARRAY[a || '/originals/r1/photo.jpg', a || '/r1/photo.webp'], 'retired roots');
  PERFORM pg_temp.eq((SELECT row(storage_path, original_storage_path, upload_mode, source_width, stored_bytes, metadata_purpose)::text
                        FROM public.observation_images WHERE id = v_img), row(NULL::text, NULL::text, NULL::text, NULL::int, NULL::bigint, 'public_microscopy'::text)::text, 'image cleared');
  PERFORM pg_temp.eq((SELECT row(image_key, thumb_key)::text FROM public.spore_measurements WHERE id = v_m1), row(NULL::text, a || '/r1/measure_crop.webp')::text, 'owner measurement family key cleared, other kept');
  PERFORM pg_temp.eq((SELECT image_key FROM public.spore_measurements WHERE id = v_m2), a || '/r1/measure_other.webp', 'unrelated measurement untouched');
  PERFORM pg_temp.eq((SELECT image_key FROM public.spore_measurements WHERE id = v_mb), a || '/r1/thumb_photo.webp', 'foreign planted measurement did not block and is untouched');
  PERFORM pg_temp.eq((SELECT thumb_key FROM public.observations WHERE id = pg_temp.fxi('relcover.obs')), a || '/r1/thumb_photo.webp', 'foreign planted cover did not block and is untouched');
  PERFORM pg_temp.eq((SELECT row(image_key, thumb_key)::text FROM public.observations WHERE id = v_obs), row(NULL::text, NULL::text)::text, 'cover cleared');

  -- Replay by the same UUID: stored keys, no writes.
  v_updated := (SELECT updated_at FROM public.observation_images WHERE id = v_img);
  v_out := pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'public_microscopy')$q$, v_uuid, v_img, k, orig));
  v_res := substr(v_out, 4)::jsonb;
  PERFORM pg_temp.eq(v_res ->> 'status', 'released', 'replay status');
  PERFORM pg_temp.eq((v_res ->> 'replayed')::boolean, true, 'replayed');
  PERFORM pg_temp.eq(ARRAY(SELECT jsonb_array_elements_text(v_res -> 'delete_keys')), v_expected, 'replay keys');
  PERFORM pg_temp.eq((SELECT updated_at FROM public.observation_images WHERE id = v_img), v_updated, 'replay wrote nothing');
  PERFORM pg_temp.eq((SELECT count(*) FROM private.media_key_retirements WHERE user_id = pg_temp.fx('A')::uuid), 1::bigint, 'one record');
  -- New UUID after the release: the paths moved on.
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(gen_random_uuid(), %s, %L, %L, 'owner_sync')$q$, v_img, k, orig))), 'row_changed', 'new UUID -> row_changed');
  -- Same UUID for another image: conflict; another user replaying: conflict.
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, NULL, 'owner_sync')$q$, v_uuid, pg_temp.fxi('relfield.img'), a || '/rf/field.webp'))), 'operation_conflict', 'UUID reuse on another image');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', b::uuid, format($q$SELECT public.release_observation_image_bytes(%L, %s, %L, %L, 'owner_sync')$q$, v_uuid, v_img, k, orig))), 'operation_conflict', 'UUID replay by another user');

  -- Promotion to a new key, and its rollback, are unaffected.
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format($q$UPDATE public.observation_images SET storage_path = %L WHERE id = %s RETURNING storage_path$q$, a || '/r1/photo_n0nce.webp', v_img)), 'ok:' || a || '/r1/photo_n0nce.webp', 'promotion to a new key');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format($q$UPDATE public.observation_images SET storage_path = NULL WHERE id = %s RETURNING 'rolled back'$q$, v_img)), 'ok:rolled back', 'promotion rollback');

  INSERT INTO fx VALUES ('rel.key', k), ('rel.orig', orig);
END $$;

-- Two pre-seeded rows sharing a key: both releases refused, no registry row.
DO $$
DECLARE
  a text := pg_temp.fx('A');
  k text := pg_temp.fx('A') || '/s1/shared.webp';
  v_before bigint := (SELECT count(*) FROM private.media_key_retirements WHERE user_id = pg_temp.fx('A')::uuid);
BEGIN
  PERFORM pg_temp.seed('sh1', 'A', k);
  PERFORM pg_temp.seed('sh2', 'A', pg_temp.fx('A') || '/s1/thumb_shared.webp');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(gen_random_uuid(), %s, %L, NULL, 'owner_sync')$q$, pg_temp.fxi('sh1.img'), k))), 'media_key_shared', 'shared 1');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('authenticated', a::uuid, format($q$SELECT public.release_observation_image_bytes(gen_random_uuid(), %s, %L, NULL, 'owner_sync')$q$, pg_temp.fxi('sh2.img'), a || '/s1/thumb_shared.webp'))), 'media_key_shared', 'shared 2');
  PERFORM pg_temp.eq((SELECT count(*) FROM private.media_key_retirements WHERE user_id = pg_temp.fx('A')::uuid), v_before, 'no record for shared');
END $$;

-- ---------------------------------------------------------------
-- 4. Every family form is refused on INSERT and UPDATE in all five tables,
--    for authenticated, service_role and the owner role.
-- ---------------------------------------------------------------
DO $$
DECLARE
  a text := pg_temp.fx('A');
  v_obs bigint;
  v_img bigint;
  v_meas bigint;
  v_mosaic bigint;
  v_cal bigint;
  v_role text;
  v_form text;
  v_sql text;
  v_out text;
  n int := 0;
BEGIN
  PERFORM pg_temp.seed('att', 'A', a || '/att/live.webp');
  v_obs := pg_temp.fxi('att.obs'); v_img := pg_temp.fxi('att.img');
  INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (v_img, a::uuid, 1) RETURNING id INTO v_meas;
  INSERT INTO public.spore_measurement_mosaics (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (v_obs, a::uuid, a || '/att/spore_mosaic_v1_00.webp', 1, 1, 1, 1) RETURNING id INTO v_mosaic;
  INSERT INTO public.calibrations (user_id, objective_key, calibration_date, microns_per_pixel)
  VALUES (a::uuid, 'mkr', current_date, 1) RETURNING id INTO v_cal;

  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role', 'postgres'] LOOP
    FOR v_form IN
      SELECT f FROM unnest(private.media_key_family(pg_temp.fx('rel.key')) || private.media_key_family(pg_temp.fx('rel.orig'))
                           || ARRAY[' /' || pg_temp.fx('rel.key') || '/ ']) f
    LOOP
      FOREACH v_sql IN ARRAY ARRAY[
        format($q$INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type) VALUES (%s, %L, %L, 'microscope')$q$, v_obs, a, v_form),
        format($q$INSERT INTO public.observation_images (observation_id, user_id, original_storage_path, image_type) VALUES (%s, %L, %L, 'microscope')$q$, v_obs, a, v_form),
        format($q$UPDATE public.observation_images SET storage_path = %L WHERE id = %s$q$, v_form, v_img),
        format($q$UPDATE public.observation_images SET original_storage_path = %L WHERE id = %s$q$, v_form, v_img),
        format($q$INSERT INTO public.spore_measurements (image_id, user_id, length_um, image_key) VALUES (%s, %L, 1, %L)$q$, v_img, a, v_form),
        format($q$INSERT INTO public.spore_measurements (image_id, user_id, length_um, thumb_key) VALUES (%s, %L, 1, %L)$q$, v_img, a, v_form),
        format($q$UPDATE public.spore_measurements SET image_key = %L WHERE id = %s$q$, v_form, v_meas),
        format($q$UPDATE public.spore_measurements SET thumb_key = %L WHERE id = %s$q$, v_form, v_meas),
        format($q$INSERT INTO public.observations (user_id, date, visibility, is_draft, image_key) VALUES (%L, current_date, 'public', false, %L)$q$, a, v_form),
        format($q$INSERT INTO public.observations (user_id, date, visibility, is_draft, thumb_key) VALUES (%L, current_date, 'public', false, %L)$q$, a, v_form),
        format($q$UPDATE public.observations SET image_key = %L WHERE id = %s$q$, v_form, v_obs),
        format($q$UPDATE public.observations SET thumb_key = %L WHERE id = %s$q$, v_form, v_obs),
        format($q$INSERT INTO public.spore_measurement_mosaics (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version) VALUES (%s, %L, %L, 1, 1, 1, 2)$q$, v_obs, a, v_form),
        format($q$UPDATE public.spore_measurement_mosaics SET storage_key = %L WHERE id = %s$q$, v_form, v_mosaic),
        format($q$INSERT INTO public.calibrations (user_id, objective_key, calibration_date, microns_per_pixel, image_storage_path) VALUES (%L, 'mkr2', current_date, 1, %L)$q$, a, v_form),
        format($q$UPDATE public.calibrations SET image_storage_path = %L WHERE id = %s$q$, v_form, v_cal)
      ] LOOP
        -- Keys with surrounding whitespace/slashes would trip the older
        -- ownership guards first for authenticated; they still must not pass.
        v_out := pg_temp.run(v_role, a::uuid, v_sql);
        IF v_form NOT LIKE ' %' THEN
          PERFORM pg_temp.eq(v_out, 'ERR:P0001:sporely_media_key_released', v_role || ': ' || v_sql);
        ELSE
          PERFORM pg_temp.eq(v_out LIKE 'ERR:%', true, v_role || ' (padded): ' || v_sql);
        END IF;
        n := n + 1;
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM pg_temp.eq(n > 900, true, 'attachment matrix size ' || n);
  -- A different key still attaches.
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format($q$UPDATE public.observations SET image_key = %L WHERE id = %s RETURNING 'ok'$q$, a || '/att/other.webp', v_obs)), 'ok:ok', 'unrelated key attaches');
END $$;

-- ---------------------------------------------------------------
-- 5. Brake accepts identity 2 and 3.
-- ---------------------------------------------------------------
DO $$
DECLARE
  a text := pg_temp.fx('A');
  v_sql text := format($q$UPDATE public.observations SET notes = 'brake' WHERE id = %s RETURNING 'ok'$q$, pg_temp.fxi('att.obs'));
BEGIN
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, v_sql, '{"user-agent":"python-requests/2.32","x-sporely-sync-identity":"2"}'), 'ok:ok', 'brake identity 2');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, v_sql, '{"user-agent":"python-requests/2.32","x-sporely-sync-identity":"3"}'), 'ok:ok', 'brake identity 3');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, v_sql, '{"user-agent":"python-requests/2.32","x-sporely-sync-identity":"1"}'), 'ERR:P0001:sporely_upgrade_required', 'brake identity 1');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, v_sql, '{"user-agent":"python-requests/2.32"}'), 'ERR:P0001:sporely_upgrade_required', 'brake no identity');
END $$;

-- ---------------------------------------------------------------
-- 5b. Cross-owner attachment refused on every column for B (authenticated),
--     identically for a retired and a live key of A
--     (no retirement oracle); malformed keys refused.
-- ---------------------------------------------------------------
DO $$
DECLARE
  a text := pg_temp.fx('A');
  b text := pg_temp.fx('B');
  v_obs bigint := pg_temp.fxi('relcover.obs');
  v_img bigint := pg_temp.fxi('relcover.img');
  v_meas bigint;
  v_mosaic bigint;
  v_cal bigint;
  v_role text;
  v_sql text;
  v_retired text;
  v_live text;
  v_bad text;
BEGIN
  INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (v_img, b::uuid, 1) RETURNING id INTO v_meas;
  INSERT INTO public.spore_measurement_mosaics (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (v_obs, b::uuid, b || '/c/spore_mosaic_v1_00.webp', 1, 1, 1, 1) RETURNING id INTO v_mosaic;
  INSERT INTO public.calibrations (user_id, objective_key, calibration_date, microns_per_pixel)
  VALUES (b::uuid, 'mkrb', current_date, 1) RETURNING id INTO v_cal;
  FOREACH v_role IN ARRAY ARRAY['authenticated'] LOOP
    FOREACH v_sql IN ARRAY ARRAY[
      format('UPDATE public.observation_images SET storage_path = %%L WHERE id = %s', v_img),
      format('UPDATE public.observation_images SET original_storage_path = %%L WHERE id = %s', v_img),
      format('UPDATE public.spore_measurements SET image_key = %%L WHERE id = %s', v_meas),
      format('UPDATE public.spore_measurements SET thumb_key = %%L WHERE id = %s', v_meas),
      format('UPDATE public.observations SET image_key = %%L WHERE id = %s', v_obs),
      format('UPDATE public.observations SET thumb_key = %%L WHERE id = %s', v_obs),
      format('UPDATE public.spore_measurement_mosaics SET storage_key = %%L WHERE id = %s', v_mosaic),
      format('UPDATE public.calibrations SET image_storage_path = %%L WHERE id = %s', v_cal)
    ] LOOP
      v_retired := pg_temp.run(v_role, b::uuid, format(v_sql, pg_temp.fx('rel.key')));
      v_live := pg_temp.run(v_role, b::uuid, format(v_sql, a || '/att/live.webp'));
      PERFORM pg_temp.eq(v_retired LIKE 'ERR:42501:%', true, v_role || ' foreign retired key: ' || v_sql || ' -> ' || v_retired);
      PERFORM pg_temp.eq(regexp_replace(v_retired, '\([^)]*\)', '()', 'g'), regexp_replace(v_live, '\([^)]*\)', '()', 'g'), v_role || ' same refusal for retired and live foreign key: ' || v_sql);
      PERFORM pg_temp.eq(v_retired NOT LIKE '%released%', true, v_role || ' no retirement hint: ' || v_sql);
      IF v_sql NOT LIKE '%observation_images%' AND v_sql NOT LIKE '%mosaics%' THEN
        PERFORM pg_temp.eq(v_retired, 'ERR:42501:sporely_media_key_foreign', v_role || ' guard refusal: ' || v_sql);
      END IF;
    END LOOP;
  END LOOP;
  -- Malformed keys (own prefix) are refused.
  FOREACH v_bad IN ARRAY ARRAY[a || '/x/../f.webp', a || '/./f.webp', a || '/x/%2Ff.webp', a || '/x/%5cf.webp', a || E'/x/a\\b.webp'] LOOP
    PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format('UPDATE public.observations SET image_key = %L WHERE id = %s', v_bad, pg_temp.fxi('att.obs'))), 'ERR:P0001:sporely_media_key_invalid', 'invalid key ' || v_bad);
    PERFORM pg_temp.eq(private.media_key_is_valid(v_bad), false, 'is_valid ' || v_bad);
  END LOOP;
END $$;

-- ---------------------------------------------------------------
-- 6. Purge claim, restore and finalize.
-- ---------------------------------------------------------------
DO $$
DECLARE
  a text := pg_temp.fx('A');
  b text := pg_temp.fx('B');
  k text := pg_temp.fx('A') || '/p1/tomb.webp';
  v_img bigint;
  v_out text;
  v_res jsonb;
  v_claim uuid := '6b0a0000-0000-4000-8000-0000000000c1';
  v_ret bigint;
  v_role text;
  v_sql text;
BEGIN
  PERFORM pg_temp.seed('pg', 'A', k, NULL, 'microscope', 40);
  v_img := pg_temp.fxi('pg.img');
  PERFORM pg_temp.seed('pglive', 'A', a || '/p1/live.webp');
  PERFORM pg_temp.seed('pgrecent', 'A', a || '/p1/recent.webp', NULL, 'microscope', 2);

  -- Grants.
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s)', v_img)) LIKE 'ERR:42501:%', true, 'authenticated claim refused');
  PERFORM pg_temp.eq(pg_temp.run('anon', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s)', v_img)) LIKE 'ERR:42501:%', true, 'anon claim refused');
  -- Eligibility.
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s)', pg_temp.fxi('pglive.img')))), 'not_eligible', 'live row');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s)', pg_temp.fxi('pgrecent.img')))), 'not_eligible', 'inside restore window');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s, 10)', v_img))), 'window_invalid', 'window below 30');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s, 60)', v_img))), 'not_eligible', 'window 60 not passed');

  -- Finalize without a claim.
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('SELECT quota_changed FROM public.finalize_observation_image_purge(%s, now(), 10)', v_img)), 'ERR:P0001:sporely_purge_not_claimed', 'finalize without claim');

  -- Forged claims: GUC, no record, wrong image, wrong owner, a 'release' record.
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role', 'postgres'] LOOP
    v_sql := format($q$SELECT set_config('sporely.purge_claim', gen_random_uuid()::text, true); UPDATE public.observation_images SET purge_claimed_at = now() WHERE id = %s$q$, v_img);
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, v_sql), 'ERR:P0001:sporely_purge_claimed', v_role || ' forged claim with GUC');
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, format('UPDATE public.observation_images SET purge_claimed_at = now(), purge_retirement_id = (SELECT max(id) FROM private.media_key_retirements) WHERE id = %s', v_img)) LIKE 'ERR:%', true, v_role || ' forged link to a release record');
  END LOOP;
  INSERT INTO private.media_key_retirements (user_id, image_id, reason, operation_id, delete_keys)
  VALUES (b::uuid, v_img, 'purge', gen_random_uuid(), ARRAY[k]) RETURNING id INTO v_ret;
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('UPDATE public.observation_images SET purge_claimed_at = now(), purge_retirement_id = %s WHERE id = %s', v_ret, v_img)), 'ERR:P0001:sporely_purge_claimed', 'forged link: wrong owner');
  INSERT INTO private.media_key_retirements (user_id, image_id, reason, operation_id, delete_keys)
  VALUES (a::uuid, pg_temp.fxi('pglive.img'), 'purge', gen_random_uuid(), ARRAY[k]) RETURNING id INTO v_ret;
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('UPDATE public.observation_images SET purge_claimed_at = now(), purge_retirement_id = %s WHERE id = %s', v_ret, v_img)), 'ERR:P0001:sporely_purge_claimed', 'forged link: wrong image');
  INSERT INTO private.media_key_retirements (user_id, image_id, reason, operation_id, delete_keys)
  VALUES (a::uuid, v_img, 'release', gen_random_uuid(), ARRAY[k]) RETURNING id INTO v_ret;
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('UPDATE public.observation_images SET purge_claimed_at = now(), purge_retirement_id = %s WHERE id = %s', v_ret, v_img)), 'ERR:P0001:sporely_purge_claimed', 'forged link: release record');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('INSERT INTO public.observation_images (observation_id, user_id, image_type, purge_claimed_at) VALUES (%s, %L, %L, now())', pg_temp.fxi('pg.obs'), a, 'microscope')), 'ERR:P0001:sporely_purge_claimed', 'INSERT with purge_claimed_at');
  PERFORM pg_temp.eq((SELECT purge_claimed_at FROM public.observation_images WHERE id = v_img), NULL::timestamptz, 'still unclaimed');

  -- Claim (pg_temp.run executes it inside a subtransaction), replay, already_claimed.
  v_out := pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(%L, %s)', v_claim, v_img));
  v_res := substr(v_out, 4)::jsonb;
  PERFORM pg_temp.eq(v_res ->> 'status', 'claimed', 'claim ' || v_out);
  PERFORM pg_temp.eq(ARRAY(SELECT jsonb_array_elements_text(v_res -> 'delete_keys')), private.media_key_family(k), 'claim delete_keys');
  PERFORM pg_temp.eq((SELECT purge_retirement_id FROM public.observation_images WHERE id = v_img), (v_res ->> 'retirement_id')::bigint, 'purge_retirement_id linked');
  PERFORM pg_temp.eq((SELECT purge_claimed_at IS NOT NULL FROM public.observation_images WHERE id = v_img), true, 'purge_claimed_at set');
  v_res := substr(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(%L, %s)', v_claim, v_img)), 4)::jsonb;
  PERFORM pg_temp.eq((v_res ->> 'replayed')::boolean, true, 'claim replay');
  PERFORM pg_temp.eq(ARRAY(SELECT jsonb_array_elements_text(v_res -> 'delete_keys')), private.media_key_family(k), 'claim replay keys');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s)', v_img))), 'already_claimed', 'second claim');

  -- Restore and claim-only PATCHes are refused for every role.
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role', 'postgres'] LOOP
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, format('UPDATE public.observation_images SET deleted_at = NULL WHERE id = %s', v_img)), 'ERR:P0001:sporely_purge_claimed', v_role || ' restore of claimed row');
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, format('UPDATE public.observation_images SET purge_claimed_at = NULL WHERE id = %s', v_img)), 'ERR:P0001:sporely_purge_claimed', v_role || ' clear purge_claimed_at');
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, format('UPDATE public.observation_images SET purge_claimed_at = now() - interval ''1 day'' WHERE id = %s', v_img)), 'ERR:P0001:sporely_purge_claimed', v_role || ' change purge_claimed_at');
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, format('UPDATE public.observation_images SET purge_retirement_id = NULL WHERE id = %s', v_img)), 'ERR:P0001:sporely_purge_claimed', v_role || ' clear purge_retirement_id');
    PERFORM pg_temp.eq(pg_temp.run(v_role, a::uuid, format('UPDATE public.observation_images SET purge_claimed_at = NULL, purge_retirement_id = NULL, deleted_at = NULL WHERE id = %s', v_img)), 'ERR:P0001:sporely_purge_claimed', v_role || ' clear and restore');
  END LOOP;
  -- The claimed key cannot be attached anywhere.
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format($q$UPDATE public.observations SET image_key = %L WHERE id = %s$q$, a || '/p1/thumb_tomb.webp', pg_temp.fxi('pglive.obs'))), 'ERR:P0001:sporely_media_key_released', 'claimed key attach');
  -- Ordinary admin metadata writes on the claimed row still work.
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format($q$UPDATE public.observation_images SET purge_attempted_at = now(), purge_error = NULL WHERE id = %s RETURNING 'ok'$q$, v_img)), 'ok:ok', 'purge metadata update on claimed row');

  INSERT INTO fx VALUES ('pg.claim', v_claim::text), ('pg.key', k);
END $$;

-- A claim whose retirement insert runs inside an EXCEPTION block succeeds,
-- and a NULL-path microscope tombstone, once claimed, cannot be restored.
DO $$
DECLARE
  a text := pg_temp.fx('A');
  v_res jsonb;
BEGIN
  PERFORM pg_temp.seed('pgnull', 'A', NULL, NULL, 'microscope', 40);
  BEGIN
    v_res := private.claim_tombstoned_image_purge_core(gen_random_uuid(), pg_temp.fxi('pgnull.img'));
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;
  PERFORM pg_temp.eq(v_res ->> 'status', 'claimed', 'claim inside EXCEPTION block');
  PERFORM pg_temp.eq(jsonb_array_length(v_res -> 'delete_keys'), 0, 'NULL-path claim has no keys');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format('UPDATE public.observation_images SET deleted_at = NULL WHERE id = %s', pg_temp.fxi('pgnull.img'))), 'ERR:P0001:sporely_purge_claimed', 'NULL-path restore refused');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format('UPDATE public.observation_images SET purge_claimed_at = NULL WHERE id = %s', pg_temp.fxi('pgnull.img'))), 'ERR:P0001:sporely_purge_claimed', 'NULL-path claim-only PATCH refused');
END $$;

-- Claim inside an explicit SQL savepoint, released.
SAVEPOINT mkr_claim;
SELECT pg_temp.seed('pgsp', 'A', pg_temp.fx('A') || '/sp/tomb.webp', NULL, 'microscope', 40);
SELECT pg_temp.eq(private.claim_tombstoned_image_purge_core(gen_random_uuid(), pg_temp.fxi('pgsp.img')) ->> 'status', 'claimed', 'claim inside savepoint');
RELEASE SAVEPOINT mkr_claim;
SELECT pg_temp.eq((SELECT purge_claimed_at IS NOT NULL FROM public.observation_images WHERE id = pg_temp.fxi('pgsp.img')), true, 'savepoint claim kept');

-- A measured tombstone (the desktop copies the image key into its
-- measurements) and its cover are cleared by the claim and do not block it.
DO $$
DECLARE
  a text := pg_temp.fx('A');
  k text := pg_temp.fx('A') || '/pm/meas.webp';
  v_m bigint;
  v_res jsonb;
BEGIN
  PERFORM pg_temp.seed('pgm', 'A', k, NULL, 'microscope', 40);
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, image_key, thumb_key)
  VALUES (pg_temp.fxi('pgm.img'), a::uuid, 3, k, a || '/pm/thumb_meas.webp') RETURNING id INTO v_m;
  UPDATE public.observations SET image_key = k, thumb_key = a || '/pm/thumb_meas.webp' WHERE id = pg_temp.fxi('pgm.obs');
  v_res := private.claim_tombstoned_image_purge_core(gen_random_uuid(), pg_temp.fxi('pgm.img'));
  PERFORM pg_temp.eq(v_res ->> 'status', 'claimed', 'measured tombstone claims');
  PERFORM pg_temp.eq((SELECT row(image_key, thumb_key)::text FROM public.spore_measurements WHERE id = v_m), row(NULL::text, NULL::text)::text, 'claim cleared measurement keys');
  PERFORM pg_temp.eq((SELECT row(image_key, thumb_key)::text FROM public.observations WHERE id = pg_temp.fxi('pgm.obs')), row(NULL::text, NULL::text)::text, 'claim cleared cover');
END $$;

-- media_key_shared on a claim: a live row shares the tombstone's key.
DO $$
DECLARE
  a text := pg_temp.fx('A');
BEGIN
  PERFORM pg_temp.seed('pgsh', 'A', a || '/psh/x.webp', NULL, 'microscope', 40);
  PERFORM pg_temp.seed('pgsh2', 'A', a || '/psh/thumb_x.webp');
  PERFORM pg_temp.eq(pg_temp.status(pg_temp.run('service_role', NULL, format('SELECT public.claim_tombstoned_image_purge(gen_random_uuid(), %s)', pg_temp.fxi('pgsh.img')))), 'media_key_shared', 'claim shared');
  -- A restore of an unclaimed tombstone whose keys are not retired still works.
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format($q$UPDATE public.observation_images SET deleted_at = NULL WHERE id = %s RETURNING 'restored'$q$, pg_temp.fxi('pgsh.img'))), 'ok:restored', 'ordinary restore');
END $$;

-- ---------------------------------------------------------------
-- 7. Sweep, interrupted purge, finalize, media_key_is_retired.
-- ---------------------------------------------------------------
DO $$
DECLARE
  a text := pg_temp.fx('A');
  v_img bigint := pg_temp.fxi('pg.img');
  r record;
  v_ids bigint[];
  v_seen int := 0;
BEGIN
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, 'SELECT count(*) FROM public.claim_retired_key_sweep(10)') LIKE 'ERR:42501:%', true, 'authenticated sweep refused');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, 'SELECT public.record_retired_key_sweep(ARRAY[1]::bigint[])') LIKE 'ERR:42501:%', true, 'authenticated record refused');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format('SELECT public.media_key_is_retired(%L, %L)', a, pg_temp.fx('rel.key'))) LIKE 'ERR:42501:%', true, 'authenticated is_retired refused');
  PERFORM pg_temp.eq(pg_temp.run('anon', NULL, 'SELECT count(*) FROM private.media_key_retirements') LIKE 'ERR:42501:%', true, 'anon cannot read registry');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, 'SELECT count(*) FROM private.retired_media_key_roots') LIKE 'ERR:42501:%', true, 'authenticated cannot read roots');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, 'SELECT count(*) > 0 FROM private.media_key_retirements'), 'ok:true', 'service_role reads registry');
  -- Registry writes.
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, $q$INSERT INTO private.media_key_retirements (user_id, image_id, reason, operation_id, delete_keys) VALUES (gen_random_uuid(), 1, 'release', gen_random_uuid(), '{}')$q$) LIKE 'ERR:42501:%', true, 'service_role INSERT');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, 'UPDATE private.media_key_retirements SET last_swept_at = now()') LIKE 'ERR:42501:%', true, 'service_role UPDATE');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, 'DELETE FROM private.media_key_retirements') LIKE 'ERR:42501:%', true, 'service_role DELETE');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, 'TRUNCATE private.media_key_retirements CASCADE') LIKE 'ERR:42501:%', true, 'service_role TRUNCATE');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, 'DELETE FROM private.retired_media_key_roots') LIKE 'ERR:42501:%', true, 'service_role DELETE roots');
  PERFORM pg_temp.eq(pg_temp.run('postgres', NULL, $q$UPDATE private.media_key_retirements SET delete_keys = '{}'$q$), 'ERR:P0001:sporely_media_key_registry_immutable', 'owner UPDATE delete_keys');
  PERFORM pg_temp.eq(pg_temp.run('postgres', NULL, 'DELETE FROM private.media_key_retirements'), 'ERR:P0001:sporely_media_key_registry_immutable', 'owner DELETE');
  PERFORM pg_temp.eq(pg_temp.run('postgres', NULL, 'DELETE FROM private.retired_media_key_roots'), 'ERR:P0001:sporely_media_key_registry_immutable', 'owner DELETE roots');
  PERFORM pg_temp.eq(pg_temp.run('postgres', NULL, $q$UPDATE private.retired_media_key_roots SET key_root = 'x'$q$), 'ERR:P0001:sporely_media_key_registry_immutable', 'owner UPDATE roots');
  PERFORM pg_temp.eq(pg_temp.run('postgres', NULL, 'TRUNCATE private.retired_media_key_roots'), 'ERR:P0001:sporely_media_key_registry_immutable', 'owner TRUNCATE roots');

  -- media_key_is_retired.
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('SELECT public.media_key_is_retired(%L, %L)', a, a || '/r1/thumb_medium_photo.webp')), 'ok:true', 'variant is retired');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('SELECT public.media_key_is_retired(%L, %L)', a, a || '/r1/other.webp')), 'ok:false', 'other key not retired');
  PERFORM pg_temp.eq(pg_temp.run('service_role', NULL, format('SELECT public.media_key_is_retired(%L, NULL)', a)), 'ok:false', 'NULL key');

  -- Interrupted purge: claim committed, no R2 delete, no finalize. The sweep
  -- returns the stored keys, exempting only the matching claimed tombstone.
  FOR r IN SELECT * FROM public.claim_retired_key_sweep(500) LOOP
    PERFORM pg_temp.eq(r.delete_keys, (SELECT delete_keys FROM private.media_key_retirements WHERE id = r.retirement_id), 'sweep returns stored keys');
    IF r.image_id = v_img AND r.reason = 'purge' AND r.user_id = a::uuid THEN
      PERFORM pg_temp.eq(r.status, 'ok', 'claimed tombstone exempt in sweep');
      v_seen := v_seen + 1;
    END IF;
    v_ids := v_ids || r.retirement_id;
  END LOOP;
  PERFORM pg_temp.eq(v_seen, 1, 'sweep saw the interrupted purge');
  PERFORM pg_temp.eq(public.record_retired_key_sweep(v_ids), cardinality(v_ids), 'record count');
  PERFORM pg_temp.eq((SELECT count(*) FROM private.media_key_retirements WHERE last_swept_at IS NULL AND user_id = pg_temp.fx('A')::uuid), 0::bigint, 'all swept');
  PERFORM pg_temp.eq((SELECT q.quota_changed FROM public.finalize_observation_image_purge(v_img, now(), 10) q), true, 'finalize after interrupted purge');
  PERFORM pg_temp.eq((SELECT q.quota_changed FROM public.finalize_observation_image_purge(v_img, now(), 10) q), false, 'finalize idempotent');
  PERFORM pg_temp.eq((SELECT storage_path FROM public.observation_images WHERE id = v_img), pg_temp.fx('pg.key'), 'tombstone keeps its paths');
  PERFORM pg_temp.eq(pg_temp.run('authenticated', a::uuid, format('UPDATE public.observation_images SET deleted_at = NULL WHERE id = %s', v_img)), 'ERR:P0001:sporely_purge_claimed', 'purged row never restored');

  -- Any other reference is reported: plant one behind the guard's back
  -- (owner-only, rolled back), as a Worker write before retirement would.
  ALTER TABLE public.observations DISABLE TRIGGER zzy_media_key_retirement_guard;
  UPDATE public.observations SET thumb_key = a || '/p1/thumb_tomb.webp' WHERE id = pg_temp.fxi('pglive.obs');
  ALTER TABLE public.observations ENABLE TRIGGER zzy_media_key_retirement_guard;
  -- The deleted (not claimed) copy of a released key is reported as well.
  ALTER TABLE public.observation_images DISABLE TRIGGER zzy_media_key_retirement_guard;
  UPDATE public.observation_images SET storage_path = pg_temp.fx('rel.key') WHERE id = pg_temp.fxi('reldel.img');
  ALTER TABLE public.observation_images ENABLE TRIGGER zzy_media_key_retirement_guard;
  v_seen := 0;
  FOR r IN SELECT * FROM public.claim_retired_key_sweep(500) LOOP
    IF r.image_id = v_img AND r.reason = 'purge' AND r.user_id = a::uuid THEN
      PERFORM pg_temp.eq(r.status, 'guard_failed', 'other reference to a purge family');
      PERFORM pg_temp.eq(r.blocking_references, jsonb_build_array(jsonb_build_object('table', 'observations', 'id', pg_temp.fxi('pglive.obs'), 'column', 'thumb_key')), 'blocking reference reported');
      v_seen := v_seen + 1;
    ELSIF r.reason = 'release' AND r.image_id = pg_temp.fxi('rel.img') THEN
      PERFORM pg_temp.eq(r.status, 'guard_failed', 'tombstone copy of a released key');
      v_seen := v_seen + 1;
    END IF;
  END LOOP;
  PERFORM pg_temp.eq(v_seen, 2, 'guard failures reported');
END $$;

-- Sweep reports a gone or purged image row, and rotates records so a batch
-- that always fails cannot starve newer ones.
DO $$
DECLARE
  r record;
  v_gone bigint;
  v_first bigint[];
  v_second bigint[];
BEGIN
  PERFORM pg_temp.seed('swg', 'A', pg_temp.fx('A') || '/swg/x.webp', NULL, 'microscope', 40);
  PERFORM private.claim_tombstoned_image_purge_core(gen_random_uuid(), pg_temp.fxi('swg.img'));
  v_gone := pg_temp.fxi('swg.img');
  DELETE FROM public.observations WHERE id = pg_temp.fxi('swg.obs');  -- cascades to the image row
  PERFORM pg_temp.eq((SELECT count(*) FROM public.observation_images WHERE id = v_gone), 0::bigint, 'image row gone');
  FOR r IN SELECT * FROM public.claim_retired_key_sweep(500) LOOP
    IF r.image_id = v_gone THEN
      PERFORM pg_temp.eq(r.image_exists, false, 'gone row reported');
    ELSIF r.image_id = pg_temp.fxi('pg.img') THEN
      PERFORM pg_temp.eq(r.image_exists AND r.image_purged_at IS NOT NULL, true, 'purged row reported');
    END IF;
  END LOOP;
  -- Starvation: without recording anything, successive batches advance.
  v_first := ARRAY(SELECT retirement_id FROM public.claim_retired_key_sweep(2));
  v_second := ARRAY(SELECT retirement_id FROM public.claim_retired_key_sweep(2));
  PERFORM pg_temp.eq(v_first && v_second, false, 'unrecorded records rotate to the back');
END $$;

-- ---------------------------------------------------------------
-- 8. Reference checks use the expression indexes.
-- ---------------------------------------------------------------
SET LOCAL enable_seqscan = off;
DO $$
DECLARE
  r record;
  v_plan text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('observation_images', 'storage_path', 'observation_images_storage_path_key_root_idx'),
    ('observation_images', 'original_storage_path', 'observation_images_original_storage_path_key_root_idx'),
    ('spore_measurements', 'image_key', 'spore_measurements_image_key_key_root_idx'),
    ('spore_measurements', 'thumb_key', 'spore_measurements_thumb_key_key_root_idx'),
    ('observations', 'image_key', 'observations_image_key_key_root_idx'),
    ('observations', 'thumb_key', 'observations_thumb_key_key_root_idx'),
    ('spore_measurement_mosaics', 'storage_key', 'spore_measurement_mosaics_storage_key_key_root_idx'),
    ('calibrations', 'image_storage_path', 'calibrations_image_storage_path_key_root_idx')
  ) AS t(tbl, col, idx) LOOP
    FOR v_plan IN EXECUTE format('EXPLAIN SELECT 1 FROM public.%I t WHERE t.%I IS NOT NULL AND private.media_key_root(t.%I) = ANY (ARRAY[''u/x.webp''])', r.tbl, r.col, r.col) LOOP
      EXIT WHEN v_plan LIKE '%' || r.idx || '%';
    END LOOP;
    PERFORM pg_temp.eq(v_plan LIKE '%' || r.idx || '%', true, 'plan uses ' || r.idx);
  END LOOP;
  FOR v_plan IN EXECUTE 'EXPLAIN SELECT 1 FROM private.retired_media_key_roots r WHERE r.key_root = ANY (ARRAY[''u/x.webp''])' LOOP
    EXIT WHEN v_plan LIKE '%retired_media_key_roots_key_root_idx%';
  END LOOP;
  PERFORM pg_temp.eq(v_plan LIKE '%retired_media_key_roots_key_root_idx%', true, 'guard read uses key_root index');
END $$;

SELECT 'PASS: media_key_retirement_test';

ROLLBACK;
