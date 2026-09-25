-- Parent-image ownership RLS for spore_measurements and spore_annotations.
--
-- Verifies 20260925160000_enforce_spore_child_image_ownership.sql: a
-- measurement or annotation may reference an image only when the caller
-- owns both the child row and the target image (image row and its parent
-- observation), on INSERT and on any UPDATE that changes image_id.
--
-- Denied writes must fail with SQLSTATE 42501 and the RLS message
-- "new row violates row-level security policy for table ...". Every
-- denied statement targets rows that exist and satisfy every FK/CHECK, so
-- the only thing that can reject it is the policy. Section 8 proves that
-- directly: with the pre-Stage-A WITH CHECK reinstated (inside a rolled
-- back subtransaction) the same statements succeed, and B's injected
-- measurement appears in A's public observation.
--
-- Run after local migrations:
--   docker exec -i supabase_db_<project> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/spore_child_image_ownership_rls_test.sql
--
-- Everything runs in one transaction that is rolled back.

\set ON_ERROR_STOP 1

BEGIN;

-- Act as an authenticated user (uid) or as anon (uid IS NULL).
CREATE FUNCTION pg_temp.act_as(uid uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF uid IS NULL THEN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
  ELSE
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
  END IF;
END;
$$;

-- Run stmt as uid; it must be rejected with 42501 and a message LIKE msg_like.
CREATE FUNCTION pg_temp.expect_denied(uid uuid, stmt text, msg_like text, label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  msg text;
BEGIN
  BEGIN
    PERFORM pg_temp.act_as(uid);
    EXECUTE stmt;
    RESET ROLE;
    RAISE EXCEPTION 'FAIL %: statement unexpectedly succeeded', label;
  EXCEPTION
    WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
      IF msg NOT LIKE msg_like THEN
        RAISE EXCEPTION 'FAIL %: denied for the wrong reason: %', label, msg;
      END IF;
  END;
  RESET ROLE;
END;
$$;

-- Run stmt as uid; it must succeed and affect exactly expected rows.
CREATE FUNCTION pg_temp.expect_rows(uid uuid, stmt text, expected int, label text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  rc int;
BEGIN
  PERFORM pg_temp.act_as(uid);
  EXECUTE stmt;
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc <> expected THEN
    RAISE EXCEPTION 'FAIL %: expected % row(s), got %', label, expected, rc;
  END IF;
END;
$$;

-- sporeMeasurementCount of an observation as seen by anon through the public RPC.
CREATE FUNCTION pg_temp.public_spore_count(obs bigint) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  PERFORM pg_temp.act_as(NULL);
  SELECT "sporeMeasurementCount" INTO n FROM public.get_public_observation(obs);
  RESET ROLE;
  RETURN n;
END;
$$;

DO $$
DECLARE
  user_a uuid := '00000000-0000-4000-8000-0000000a0a01';
  user_b uuid := '00000000-0000-4000-8000-0000000a0a02';
  rls_meas constant text := 'new row violates row-level security policy for table "spore_measurements"';
  rls_ann  constant text := 'new row violates row-level security policy for table "spore_annotations"';
  obs_a bigint;
  obs_b bigint;
  img_a bigint;          -- A's uploaded microscope image
  img_a2 bigint;         -- A's second uploaded microscope image
  img_a_owner_sync bigint;
  img_a_public_micro bigint;
  img_a_null_purpose bigint;
  img_b bigint;          -- B's uploaded microscope image
  img_b_owner_sync bigint;
  img_mixed bigint;      -- user_id = B but parent observation = A (fixture-only)
  meas_a bigint;
  meas_b bigint;
  ann_a bigint;
  ann_b bigint;
  public_before bigint;
  public_after bigint;
  n bigint;
  msg text;
BEGIN
  -- ── Fixture (postgres, bypasses RLS) ──────────────────────────────────────
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (user_a, 'authenticated', 'authenticated', 'stage-a-owner@example.test', '{"full_name":"Stage A Owner"}'::jsonb, now(), now()),
    (user_b, 'authenticated', 'authenticated', 'stage-a-other@example.test', '{"full_name":"Stage A Other"}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (user_a, 'stage_a_owner', 'Stage A Owner', false),
    (user_b, 'stage_a_other', 'Stage A Other', false)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (user_a, '2026-07-01', 'Stageatestus', 'ownerus', 'public', false, 'public', 'exact', 'NO')
  RETURNING id INTO obs_a;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (user_b, '2026-07-01', 'Stageatestus', 'otherus', 'public', false, 'public', 'exact', 'NO')
  RETURNING id INTO obs_b;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_a, user_a, user_a::text || '/stage-a-1.webp', 'microscope')
  RETURNING id INTO img_a;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_a, user_a, user_a::text || '/stage-a-2.webp', 'microscope')
  RETURNING id INTO img_a2;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_a, user_a, NULL, 'microscope', 'owner_sync')
  RETURNING id INTO img_a_owner_sync;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_a, user_a, NULL, 'microscope', 'public_microscopy')
  RETURNING id INTO img_a_public_micro;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_a, user_a, NULL, 'microscope', NULL)
  RETURNING id INTO img_a_null_purpose;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_b, user_b, user_b::text || '/stage-a-b.webp', 'microscope')
  RETURNING id INTO img_b;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_b, user_b, NULL, 'microscope', 'owner_sync')
  RETURNING id INTO img_b_owner_sync;

  -- Inconsistent parent that client RLS cannot create: image.user_id = B but
  -- its observation belongs to A. Proves the image's own user_id is not
  -- trusted on its own; the parent observation owner must match too.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs_a, user_b, user_b::text || '/stage-a-mixed.webp', 'microscope')
  RETURNING id INTO img_mixed;

  -- ── 1. Measurements: owners insert on their own images ────────────────────
  PERFORM pg_temp.expect_rows(user_a, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type) VALUES (%s, %L, 10.0, 5.0, ''manual'')',
    img_a, user_a), 1, 'M1 A inserts on image A');
  SELECT id INTO meas_a FROM public.spore_measurements WHERE image_id = img_a AND user_id = user_a;

  PERFORM pg_temp.expect_rows(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type) VALUES (%s, %L, 11.0, 5.5, ''manual'')',
    img_b, user_b), 1, 'M2 B inserts on image B');
  SELECT id INTO meas_b FROM public.spore_measurements WHERE image_id = img_b AND user_id = user_b;

  -- Metadata-only parents are fine for their owner, whatever the marker.
  PERFORM pg_temp.expect_rows(user_a, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 9.0, 4.0), (%s, %L, 9.1, 4.1), (%s, %L, 9.2, 4.2)',
    img_a_owner_sync, user_a, img_a_public_micro, user_a, img_a_null_purpose, user_a),
    3, 'M1b A inserts on own owner_sync / public_microscopy / NULL-purpose images');
  PERFORM pg_temp.expect_rows(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 9.3, 4.3)',
    img_b_owner_sync, user_b), 1, 'M2b B inserts on own owner_sync image');

  public_before := pg_temp.public_spore_count(obs_a);
  IF public_before IS NULL OR public_before < 1 THEN
    RAISE EXCEPTION 'FAIL P0: A''s public observation should expose A''s measurements, got %', public_before;
  END IF;

  -- ── 2. Measurements: cross-owner INSERT is denied ─────────────────────────
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_a, user_b), rls_meas, 'M3 B inserts own-user_id row on image A');

  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_a, user_a), rls_meas, 'M4 B spoofs user_id = A on image A');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_b, user_a), rls_meas, 'M4b B spoofs user_id = A on image B');

  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_a_owner_sync, user_b), rls_meas, 'M9 B inserts on A''s owner_sync image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_a_public_micro, user_b), rls_meas, 'M10 B inserts on A''s public_microscopy image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_a_null_purpose, user_b), rls_meas, 'M10b B inserts on A''s NULL-purpose metadata image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_mixed, user_b), rls_meas, 'M11 B inserts on B-user_id image inside A''s observation');

  -- ── 3. Measurements: re-parenting onto a foreign image is denied ──────────
  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a, meas_b),
    rls_meas, 'M5 B re-parents own measurement B-image -> A-image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a_owner_sync, meas_b),
    rls_meas, 'M5b B re-parents own measurement onto A''s owner_sync image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a_public_micro, meas_b),
    rls_meas, 'M5c B re-parents own measurement onto A''s public_microscopy image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_mixed, meas_b),
    rls_meas, 'M5d B re-parents own measurement onto B-user_id image inside A''s observation');
  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_measurements SET user_id = %L WHERE id = %s', user_a, meas_b),
    rls_meas, 'M5e B hands own measurement to A');

  -- B cannot touch A's rows at all (USING, unchanged): zero rows, no error.
  PERFORM pg_temp.expect_rows(user_b, format(
    'UPDATE public.spore_measurements SET length_um = 1.0 WHERE id = %s', meas_a), 0, 'M5f B updates A''s measurement');
  PERFORM pg_temp.expect_rows(user_b, format(
    'DELETE FROM public.spore_measurements WHERE id = %s', meas_a), 0, 'M5g B deletes A''s measurement');

  public_after := pg_temp.public_spore_count(obs_a);
  IF public_after IS DISTINCT FROM public_before THEN
    RAISE EXCEPTION 'FAIL P1: A''s public spore count changed after denied injections: % -> %', public_before, public_after;
  END IF;
  SELECT count(*) INTO n FROM public.spore_measurements m
  JOIN public.observation_images i ON i.id = m.image_id
  WHERE i.observation_id = obs_a AND m.user_id <> user_a;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL P2: % foreign measurement(s) attached to A''s observation', n;
  END IF;

  -- ── 4. Measurements: legitimate owner edits still work ────────────────────
  PERFORM pg_temp.expect_rows(user_a, format(
    'UPDATE public.spore_measurements SET length_um = 10.5, notes = ''edited'' WHERE id = %s', meas_a), 1, 'M6 A edits own measurement');
  PERFORM pg_temp.expect_rows(user_a, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a2, meas_a), 1, 'M6b A re-parents between own images');
  PERFORM pg_temp.expect_rows(user_a, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a_owner_sync, meas_a), 1, 'M6c A re-parents onto own owner_sync image');
  PERFORM pg_temp.expect_rows(user_a, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a, meas_a), 1, 'M6d A re-parents back');
  PERFORM pg_temp.expect_rows(user_a, format(
    'SELECT 1 FROM public.spore_measurements WHERE id = %s', meas_a), 1, 'M6e A reads own measurement');

  -- ── 4b. Upserts (INSERT ... ON CONFLICT DO UPDATE, as PostgREST issues) ───
  PERFORM pg_temp.expect_rows(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, desktop_id, length_um) VALUES (%s, %L, 9002, 8.0)',
    img_b, user_b), 1, 'U0 B inserts desktop-keyed measurement on image B');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, desktop_id, length_um) VALUES (%s, %L, 9001, 8.0) '
    'ON CONFLICT (desktop_id, user_id) WHERE desktop_id IS NOT NULL AND user_id IS NOT NULL '
    'DO UPDATE SET image_id = EXCLUDED.image_id', img_a, user_b),
    rls_meas, 'U1 B upserts a new row onto image A');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, desktop_id, length_um) VALUES (%s, %L, 9002, 8.0) '
    'ON CONFLICT (desktop_id, user_id) WHERE desktop_id IS NOT NULL AND user_id IS NOT NULL '
    'DO UPDATE SET image_id = EXCLUDED.image_id', img_a, user_b),
    rls_meas, 'U2 B upserts own conflicting row with proposed image A');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, desktop_id, length_um) VALUES (%s, %L, 9002, 8.0) '
    'ON CONFLICT (desktop_id, user_id) WHERE desktop_id IS NOT NULL AND user_id IS NOT NULL '
    'DO UPDATE SET image_id = %s', img_b, user_b, img_a),
    rls_meas, 'U3 B upserts own row on image B but DO UPDATE moves it to image A');
  PERFORM pg_temp.expect_rows(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, desktop_id, length_um) VALUES (%s, %L, 9002, 8.5) '
    'ON CONFLICT (desktop_id, user_id) WHERE desktop_id IS NOT NULL AND user_id IS NOT NULL '
    'DO UPDATE SET length_um = EXCLUDED.length_um, image_id = EXCLUDED.image_id', img_b_owner_sync, user_b),
    1, 'U4 B upserts own row onto own owner_sync image');

  -- ── 5. Anonymous cannot write ─────────────────────────────────────────────
  PERFORM pg_temp.expect_denied(NULL, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (%s, %L, 1.0)', img_a, user_a),
    'permission denied for table spore_measurements', 'M7 anon inserts measurement');
  PERFORM pg_temp.expect_denied(NULL, format(
    'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a, meas_b),
    'permission denied for table spore_measurements', 'M7b anon updates measurement');

  -- ── 6. Annotations: equivalent rules ─────────────────────────────────────
  PERFORM pg_temp.expect_rows(user_a, format(
    'INSERT INTO public.spore_annotations (image_id, measurement_id, user_id, spore_number) VALUES (%s, %s, %L, 1)',
    img_a, meas_a, user_a), 1, 'A1 A annotates image A');
  SELECT id INTO ann_a FROM public.spore_annotations WHERE image_id = img_a AND user_id = user_a;

  PERFORM pg_temp.expect_rows(user_b, format(
    'INSERT INTO public.spore_annotations (image_id, measurement_id, user_id, spore_number) VALUES (%s, %s, %L, 1)',
    img_b, meas_b, user_b), 1, 'A2 B annotates image B');
  SELECT id INTO ann_b FROM public.spore_annotations WHERE image_id = img_b AND user_id = user_b;

  PERFORM pg_temp.expect_rows(user_a, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 2), (%s, %L, 3), (%s, %L, 4)',
    img_a_owner_sync, user_a, img_a_public_micro, user_a, img_a_null_purpose, user_a),
    3, 'A1b A annotates own owner_sync / public_microscopy / NULL-purpose images');

  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_a, user_b),
    rls_ann, 'A3 B annotates image A');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_a, user_a),
    rls_ann, 'A4 B spoofs user_id = A on image A');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_a_owner_sync, user_b),
    rls_ann, 'A9 B annotates A''s owner_sync image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_a_public_micro, user_b),
    rls_ann, 'A10 B annotates A''s public_microscopy image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_mixed, user_b),
    rls_ann, 'A11 B annotates B-user_id image inside A''s observation');

  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_annotations SET image_id = %s WHERE id = %s', img_a, ann_b),
    rls_ann, 'A5 B re-parents own annotation B-image -> A-image');
  PERFORM pg_temp.expect_denied(user_b, format(
    'UPDATE public.spore_annotations SET image_id = %s WHERE id = %s', img_a_public_micro, ann_b),
    rls_ann, 'A5b B re-parents own annotation onto A''s public_microscopy image');
  PERFORM pg_temp.expect_rows(user_b, format(
    'UPDATE public.spore_annotations SET spore_number = 7 WHERE id = %s', ann_a), 0, 'A5c B updates A''s annotation');
  PERFORM pg_temp.expect_rows(user_b, format(
    'DELETE FROM public.spore_annotations WHERE id = %s', ann_a), 0, 'A5d B deletes A''s annotation');

  PERFORM pg_temp.expect_rows(user_a, format(
    'UPDATE public.spore_annotations SET spore_number = 5, image_id = %s WHERE id = %s', img_a2, ann_a), 1, 'A6 A edits and re-parents own annotation');

  -- anon still holds table grants on spore_annotations, but no policy
  -- applies to anon any more, so RLS default-deny is the gate: the same
  -- outcomes anon had before this migration.
  PERFORM pg_temp.expect_denied(NULL, format(
    'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_a, user_a),
    rls_ann, 'A7 anon inserts annotation');
  PERFORM pg_temp.expect_rows(NULL, format(
    'UPDATE public.spore_annotations SET image_id = %s WHERE id = %s', img_a, ann_b), 0, 'A7b anon updates annotation');
  -- USING is unchanged, so anon reads and deletes still see nothing rather than erroring.
  PERFORM pg_temp.expect_rows(NULL, 'SELECT 1 FROM public.spore_annotations', 0, 'A7c anon reads annotations');
  PERFORM pg_temp.expect_rows(NULL, format(
    'DELETE FROM public.spore_annotations WHERE id = %s', ann_b), 0, 'A7d anon deletes annotation');

  -- ── 7. Deletes keep their current behaviour ──────────────────────────────
  PERFORM pg_temp.expect_rows(user_a, format(
    'DELETE FROM public.spore_annotations WHERE id = %s', ann_a), 1, 'D1 A deletes own annotation');
  PERFORM pg_temp.expect_rows(user_b, format(
    'DELETE FROM public.spore_measurements WHERE image_id = %s AND user_id = %L AND desktop_id IS NULL', img_b_owner_sync, user_b),
    1, 'D2 B deletes own measurement');

  -- ── 8. Control: the pre-Stage-A policy admitted exactly these writes ─────
  -- Reinstate the old WITH CHECK inside a subtransaction, show the denied
  -- statements now succeed and that B's row reaches A's public observation,
  -- then roll the subtransaction back.
  BEGIN
    ALTER POLICY "spore_measurements_owner_insert" ON public.spore_measurements
      WITH CHECK (user_id = auth.uid());
    ALTER POLICY "spore_measurements_owner_update" ON public.spore_measurements
      WITH CHECK (user_id = auth.uid());
    ALTER POLICY "spore_annotations: owner full" ON public.spore_annotations
      WITH CHECK (auth.uid() = user_id);

    PERFORM pg_temp.expect_rows(user_b, format(
      'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
      img_a, user_b), 1, 'C3 old policy: B injects on image A');
    public_after := pg_temp.public_spore_count(obs_a);
    IF public_after IS DISTINCT FROM public_before + 1 THEN
      RAISE EXCEPTION 'FAIL C3p: expected injected row in A''s public observation (% -> %)', public_before, public_after;
    END IF;
    PERFORM pg_temp.expect_rows(user_b, format(
      'UPDATE public.spore_measurements SET image_id = %s WHERE id = %s', img_a_public_micro, meas_b),
      1, 'C5 old policy: B re-parents onto A''s public_microscopy image');
    PERFORM pg_temp.expect_rows(user_b, format(
      'INSERT INTO public.spore_measurements (image_id, user_id, length_um) VALUES (%s, %L, 99.0)',
      img_a_owner_sync, user_b), 1, 'C9 old policy: B injects on A''s owner_sync image');
    PERFORM pg_temp.expect_rows(user_b, format(
      'INSERT INTO public.spore_annotations (image_id, user_id, spore_number) VALUES (%s, %L, 9)', img_a, user_b),
      1, 'CA3 old policy: B annotates image A');
    PERFORM pg_temp.expect_rows(user_b, format(
      'UPDATE public.spore_annotations SET image_id = %s WHERE id = %s', img_a, ann_b),
      1, 'CA5 old policy: B re-parents own annotation onto image A');

    RAISE EXCEPTION USING ERRCODE = 'SA000', MESSAGE = 'control rollback';
  EXCEPTION
    WHEN SQLSTATE 'SA000' THEN
      NULL;
  END;

  -- The control rolled back: the new policy is back in force.
  PERFORM pg_temp.expect_denied(user_b, format(
    'INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um) VALUES (%s, %L, 99.0, 9.0)',
    img_a, user_b), rls_meas, 'M3r B injects on image A after control');
  IF pg_temp.public_spore_count(obs_a) IS DISTINCT FROM public_before THEN
    RAISE EXCEPTION 'FAIL P3: control subtransaction leaked into A''s public observation';
  END IF;

  RAISE NOTICE 'spore_child_image_ownership_rls_test: all assertions passed';
END;
$$;

ROLLBACK;
