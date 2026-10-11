-- pgTAP: public.get_public_observation_spore_previews(bigint[]).
-- Plan: docs/plans/active/2026-10-10-batch-spore-preview-rpc.md, Stage 1.
--
-- Run after a local reset with the Supabase pgTAP runner:
--   supabase db reset --local
--   supabase test db supabase/tests/public_observation_spore_previews_test.sql
-- Everything runs in one transaction and is rolled back.
--
-- The block between the @fixtures markers is also replayed by
-- public_observation_spore_previews_identity_test.sh; keep it self-contained.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- @fixtures-begin
CREATE TEMP TABLE spv_fixture (
  label text PRIMARY KEY,
  observation_id bigint NOT NULL
) ON COMMIT DROP;

CREATE TEMP TABLE spv_viewer (
  label text PRIMARY KEY,
  user_id uuid
) ON COMMIT DROP;

DO $fixtures$
DECLARE
  owner_id   uuid := '00000000-0000-4000-8000-0000000c5a01';
  stranger_id uuid := '00000000-0000-4000-8000-0000000c5a02';
  blocker_id uuid := '00000000-0000-4000-8000-0000000c5a03';
  banned_id  uuid := '00000000-0000-4000-8000-0000000c5a04';
  obs bigint;
  img_a bigint;
  img_b bigint;
  img_meta bigint;
  img_gone bigint;
  m1 bigint;
  m2 bigint;
  mosaic_old bigint;
  mosaic_new bigint;
  label text;
BEGIN
  -- A deterministic worker base URL so build_worker_media_url and
  -- build_worker_mosaic_url return values rather than NULL.
  INSERT INTO public._media_worker_config (singleton, base_url)
  VALUES (true, 'https://upload.example.test')
  ON CONFLICT (singleton) DO UPDATE SET base_url = excluded.base_url;

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id,    'authenticated', 'authenticated', 'spv-owner@example.test',    '{}'::jsonb, now(), now()),
    (stranger_id, 'authenticated', 'authenticated', 'spv-stranger@example.test', '{}'::jsonb, now(), now()),
    (blocker_id,  'authenticated', 'authenticated', 'spv-blocker@example.test',  '{}'::jsonb, now(), now()),
    (banned_id,   'authenticated', 'authenticated', 'spv-banned@example.test',   '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES
    (owner_id,    'spv_owner',    'SPV Owner',    true, false),
    (stranger_id, 'spv_stranger', 'SPV Stranger', true, false),
    (blocker_id,  'spv_blocker',  'SPV Blocker',  true, false),
    (banned_id,   'spv_banned',   'SPV Banned',   true, false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES (blocker_id, owner_id);

  INSERT INTO spv_viewer (label, user_id) VALUES
    ('anon', NULL), ('stranger', stranger_id), ('blocker', blocker_id), ('owner', owner_id);

  -- full: two public spore-bearing images, a soft-deleted and a purged image,
  -- a non-spore measurement type, and two mosaic versions.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-01', 'Amanita', 'muscaria', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('full', obs);

  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, image_type, contrast, mount_medium, stain, sample_type, sample_source)
  VALUES (obs, owner_id, owner_id::text || '/spv-a.webp', NULL, ' BF ', 'Water', 'Congo red', ' Fresh ', 'Spore_Print')
  RETURNING id INTO img_a;
  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, image_type, contrast, mount_medium, sample_type, sample_source)
  VALUES (obs, owner_id, owner_id::text || '/spv-b.webp', 'microscope', 'not_set', '', 'soaked', 'gill')
  RETURNING id INTO img_b;
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, deleted_at)
  VALUES (obs, owner_id, owner_id::text || '/spv-deleted.webp', 'microscope', now())
  RETURNING id INTO img_gone;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_gone, owner_id, 99, 9, 'spore', owner_id::text || '/deleted-thumb.webp');
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, purged_at)
  VALUES (obs, owner_id, owner_id::text || '/spv-purged.webp', 'microscope', now())
  RETURNING id INTO img_gone;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_gone, owner_id, 98, 8, 'spore');

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_a, owner_id, 10.5, 7.25, 'manual', owner_id::text || '/m1.webp')
  RETURNING id INTO m1;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_a, owner_id, 11, 0, NULL, owner_id::text || '/m2.webp')
  RETURNING id INTO m2;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_a, owner_id, 9.75, NULL, ' Spores ');
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_b, owner_id, 12, 8, '');
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_b, owner_id, 40, 10, 'cystidia', owner_id::text || '/cyst.webp');

  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (obs, owner_id, owner_id::text || '/mosaic-v1.webp', 100, 100, 50, 1)
  RETURNING id INTO mosaic_old;
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
     tile_width_px, tile_height_px, common_crop_width_um, common_crop_height_um)
  VALUES (obs, owner_id, owner_id::text || '/mosaic-v2.webp', 400, 200, 100, 2, 100, 100, 20.5, 20.5)
  RETURNING id INTO mosaic_new;
  INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px, overlay_json)
  VALUES
    (m1, mosaic_new, 0, 0, 100, 100, '{"style":"a","line":[[1,2],[3,4]]}'::jsonb),
    (m2, mosaic_new, 100, 0, 100, 100, NULL);

  -- metadata_parent_public: storage-less microscope parent that is itself
  -- public microscopy, so its points count.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-02', 'Russula', 'emetica', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('metadata_parent_public', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose, contrast)
  VALUES (obs, owner_id, NULL, 'microscope', 'public_microscopy', 'DIC')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_meta, owner_id, 8, 6, 'spore');

  -- metadata_parent_private: storage-less microscope parent that is not a
  -- public-microscopy parent, so its points are excluded.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-03', 'Russula', 'nobilis', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('metadata_parent_private', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs, owner_id, NULL, 'microscope', 'owner_sync')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_meta, owner_id, 8, 6, 'spore');

  -- no_images / field_image_only / no_measurements: image and measurement gates.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'edulis', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('no_images', obs);

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'pinophilus', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('field_image_only', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs, owner_id, owner_id::text || '/field.webp', 'field')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_meta, owner_id, 8, 6, 'spore');

  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'reticulatus', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('no_measurements', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs, owner_id, owner_id::text || '/micro-empty.webp', 'microscope');

  -- mosaic_no_points: a mosaic but no public spore measurement (only a
  -- non-spore measurement type), so sporePoints is NULL and sporeMosaic is not.
  INSERT INTO public.observations
    (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
  VALUES (owner_id, '2026-10-04', 'Boletus', 'aereus', 'public', false, 'hidden', 'public')
  RETURNING id INTO obs;
  INSERT INTO spv_fixture VALUES ('mosaic_no_points', obs);
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
  VALUES (obs, owner_id, owner_id::text || '/micro-cystidia.webp', 'microscope')
  RETURNING id INTO img_meta;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
  VALUES (img_meta, owner_id, 50, 12, 'cystidia', owner_id::text || '/cyst2.webp');
  INSERT INTO public.spore_measurement_mosaics
    (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
  VALUES (obs, owner_id, owner_id::text || '/mosaic-no-points.webp', 64, 64, 32, 1);

  -- Observation-level gates and spore_data_visibility values. Each of these
  -- gets one public spore-bearing image so a leaked point would show.
  FOREACH label IN ARRAY ARRAY[
    'private', 'friends', 'draft', 'banned_owner', 'deleted',
    'spore_friends', 'spore_private', 'spore_null'
  ]
  LOOP
    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (
      CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END,
      '2026-10-05', 'Cortinarius', label,
      CASE label WHEN 'private' THEN 'private' WHEN 'friends' THEN 'friends' ELSE 'public' END,
      label = 'draft',
      'hidden',
      CASE label WHEN 'spore_friends' THEN 'friends' WHEN 'spore_private' THEN 'private'
                 WHEN 'spore_null' THEN NULL ELSE 'public' END
    )
    RETURNING id INTO obs;
    INSERT INTO spv_fixture VALUES (label, obs);
    INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
    VALUES (obs, CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END,
            CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END::text || '/' || label || '.webp',
            'microscope')
    RETURNING id INTO img_meta;
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
    VALUES (img_meta, CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END, 8, 6, 'spore', 'x/' || label);
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
    VALUES (obs, CASE WHEN label = 'banned_owner' THEN banned_id ELSE owner_id END, 'mosaic/' || label, 10, 10, 10, 1);
  END LOOP;

  UPDATE public.profiles SET is_banned = true WHERE id = banned_id;
  DELETE FROM public.observations
   WHERE id = (SELECT observation_id FROM spv_fixture fx WHERE fx.label = 'deleted');
END
$fixtures$;
-- @fixtures-end

-- ── Expected outcome per fixture, independent of get_public_observation ─────
-- want_row: a row for every viewer except the blocked one.
CREATE TEMP TABLE spv_expect (
  label text PRIMARY KEY,
  want_row boolean NOT NULL,
  want_points boolean NOT NULL,
  want_mosaic boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO spv_expect (label, want_row, want_points, want_mosaic)
SELECT label,
       label NOT IN ('private', 'friends', 'draft', 'banned_owner', 'deleted'),
       label IN ('full', 'metadata_parent_public'),
       label IN ('full', 'mosaic_no_points')
  FROM spv_fixture;

CREATE FUNCTION pg_temp.spv_as(p_viewer text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  uid uuid := (SELECT user_id FROM spv_viewer WHERE label = p_viewer);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN uid IS NULL THEN jsonb_build_object('role', 'anon')
         ELSE jsonb_build_object('sub', uid::text, 'role', 'authenticated') END::text,
    true);
END
$$;

-- get_public_observation per fixture, its points reduced to the card keys.
CREATE TEMP VIEW spv_single AS
SELECT f.label,
       g.id AS observation_id,
       CASE WHEN g."sporePoints" IS NULL THEN NULL ELSE (
         SELECT coalesce(jsonb_agg((
                  SELECT coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
                    FROM jsonb_each(pt.value) kv
                   WHERE kv.key = ANY (ARRAY[
                     'id', 'lengthUm', 'widthUm', 'cropUrl',
                     'mosaicX', 'mosaicY', 'mosaicW', 'mosaicH',
                     'contrastMethod', 'mountReagent', 'sampleType', 'sampleSource'])
                ) ORDER BY pt.ord), '[]'::jsonb)
           FROM jsonb_array_elements(g."sporePoints") WITH ORDINALITY pt(value, ord)
       ) END AS points,
       g."sporeMosaic" AS spore_mosaic
  FROM spv_fixture f
 CROSS JOIN LATERAL public.get_public_observation(f.observation_id) g;

-- One batch call over every fixture id.
CREATE TEMP VIEW spv_batch AS
SELECT f.label, b.observation_id, b.points, b.spore_mosaic
  FROM public.get_public_observation_spore_previews(
         (SELECT array_agg(observation_id ORDER BY observation_id) FROM spv_fixture)) b
  JOIN spv_fixture f ON f.observation_id = b.observation_id;

-- One batch call per fixture id.
CREATE TEMP VIEW spv_batch_each AS
SELECT f.label, b.observation_id, b.points, b.spore_mosaic
  FROM spv_fixture f
 CROSS JOIN LATERAL public.get_public_observation_spore_previews(ARRAY[f.observation_id]) b;

SELECT plan(47);

-- ── Visibility matrix and parity, per viewer ─────────────────────────────────
SELECT pg_temp.spv_as('anon');
SELECT results_eq('SELECT label FROM spv_batch ORDER BY label',
  'SELECT label FROM spv_expect WHERE want_row ORDER BY label',
  'anon: rows exactly for the eligible fixtures');
SELECT results_eq('SELECT label FROM spv_batch ORDER BY label',
  'SELECT label FROM spv_single ORDER BY label',
  'anon: rows exactly where get_public_observation returns one');
SELECT results_eq('SELECT label, points IS NOT NULL, spore_mosaic IS NOT NULL FROM spv_batch ORDER BY label',
  'SELECT label, want_points, want_mosaic FROM spv_expect WHERE want_row ORDER BY label',
  'anon: points and mosaic present exactly where expected');
SELECT is_empty($$SELECT label FROM spv_batch b FULL JOIN spv_single s USING (label)
   WHERE b.observation_id IS DISTINCT FROM s.observation_id
      OR b.points IS DISTINCT FROM s.points OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic$$,
  'anon: batch points and mosaic equal get_public_observation');
SELECT is_empty($$SELECT label FROM spv_batch_each b FULL JOIN spv_single s USING (label)
   WHERE b.observation_id IS DISTINCT FROM s.observation_id
      OR b.points IS DISTINCT FROM s.points OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic$$,
  'anon: single-id batch calls equal get_public_observation');

SELECT pg_temp.spv_as('stranger');
SELECT results_eq('SELECT label FROM spv_batch ORDER BY label',
  'SELECT label FROM spv_expect WHERE want_row ORDER BY label',
  'stranger: rows exactly for the eligible fixtures');
SELECT results_eq('SELECT label FROM spv_batch ORDER BY label',
  'SELECT label FROM spv_single ORDER BY label',
  'stranger: rows exactly where get_public_observation returns one');
SELECT results_eq('SELECT label, points IS NOT NULL, spore_mosaic IS NOT NULL FROM spv_batch ORDER BY label',
  'SELECT label, want_points, want_mosaic FROM spv_expect WHERE want_row ORDER BY label',
  'stranger: points and mosaic present exactly where expected');
SELECT is_empty($$SELECT label FROM spv_batch b FULL JOIN spv_single s USING (label)
   WHERE b.observation_id IS DISTINCT FROM s.observation_id
      OR b.points IS DISTINCT FROM s.points OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic$$,
  'stranger: batch points and mosaic equal get_public_observation');
SELECT is_empty($$SELECT label FROM spv_batch_each b FULL JOIN spv_single s USING (label)
   WHERE b.observation_id IS DISTINCT FROM s.observation_id
      OR b.points IS DISTINCT FROM s.points OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic$$,
  'stranger: single-id batch calls equal get_public_observation');

SELECT pg_temp.spv_as('owner');
SELECT results_eq('SELECT label FROM spv_batch ORDER BY label',
  'SELECT label FROM spv_expect WHERE want_row ORDER BY label',
  'owner: rows exactly for the eligible fixtures (no owner bypass)');
SELECT results_eq('SELECT label FROM spv_batch ORDER BY label',
  'SELECT label FROM spv_single ORDER BY label',
  'owner: rows exactly where get_public_observation returns one');
SELECT results_eq('SELECT label, points IS NOT NULL, spore_mosaic IS NOT NULL FROM spv_batch ORDER BY label',
  'SELECT label, want_points, want_mosaic FROM spv_expect WHERE want_row ORDER BY label',
  'owner: points and mosaic present exactly where expected');
SELECT is_empty($$SELECT label FROM spv_batch b FULL JOIN spv_single s USING (label)
   WHERE b.observation_id IS DISTINCT FROM s.observation_id
      OR b.points IS DISTINCT FROM s.points OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic$$,
  'owner: batch points and mosaic equal get_public_observation');
SELECT is_empty($$SELECT label FROM spv_batch_each b FULL JOIN spv_single s USING (label)
   WHERE b.observation_id IS DISTINCT FROM s.observation_id
      OR b.points IS DISTINCT FROM s.points OR b.spore_mosaic IS DISTINCT FROM s.spore_mosaic$$,
  'owner: single-id batch calls equal get_public_observation');

SELECT pg_temp.spv_as('blocker');
SELECT is_empty('SELECT label FROM spv_batch',
  'blocked viewer: no rows for the blocked owner''s observations');
SELECT is_empty('SELECT label FROM spv_single',
  'blocked viewer: get_public_observation also returns no rows');
SELECT is_empty('SELECT label FROM spv_batch_each',
  'blocked viewer: no rows from single-id batch calls');

-- ── Concrete values for the full and mosaic_no_points fixtures (anon) ───────
SELECT pg_temp.spv_as('anon');
SELECT is((SELECT jsonb_array_length(points) FROM spv_batch WHERE label = 'full'), 4,
  'full: four public spore points (cystidia, deleted and purged images excluded)');
SELECT is_empty($$SELECT k FROM spv_batch b, jsonb_array_elements(b.points) pt, jsonb_object_keys(pt.value) k
   WHERE b.label = 'full' AND k <> ALL (ARRAY[
     'id', 'lengthUm', 'widthUm', 'cropUrl', 'mosaicX', 'mosaicY', 'mosaicW', 'mosaicH',
     'contrastMethod', 'mountReagent', 'sampleType', 'sampleSource'])$$,
  'full: points carry only card keys');
SELECT is_empty($$SELECT 1 FROM spv_batch b, jsonb_array_elements(b.points) pt
   WHERE b.label = 'full' AND (pt.value->>'lengthUm')::numeric IN (99, 98, 40)$$,
  'full: no point from a deleted or purged image or a non-spore type');
SELECT ok(EXISTS (
    SELECT 1 FROM spv_batch b, jsonb_array_elements(b.points) pt
     WHERE b.label = 'full'
       AND pt.value->>'lengthUm' = '10.5'
       AND pt.value->>'widthUm' = '7.25'
       AND pt.value->>'cropUrl' ~ '^https://upload\.example\.test/m/[0-9]+/thumb\?v=[0-9]+$'
       AND pt.value->>'contrastMethod' = 'BF'
       AND pt.value->>'mountReagent' = 'Water'
       AND pt.value->>'sampleType' = 'fresh'
       AND pt.value->>'sampleSource' = 'spore_print'
       AND (pt.value->>'mosaicX')::int = 0
       AND (pt.value->>'mosaicW')::int = 100),
  'full: card fields of the first measurement, cropUrl from build_worker_media_url');
SELECT is_empty($$SELECT 1 FROM spv_batch b, jsonb_array_elements(b.points) pt
   WHERE b.label = 'full' AND pt.value->>'lengthUm' = '12'
     AND (pt.value->>'contrastMethod' IS DISTINCT FROM 'not_set'
          OR pt.value ?| ARRAY['mountReagent', 'sampleType', 'sampleSource', 'cropUrl'])$$,
  'full: microscope-image point normalized as get_public_observation does');
SELECT ok((SELECT spore_mosaic->>'version' = '2'
                  AND spore_mosaic->>'mosaicMediaUrl' ~ '^https://upload\.example\.test/'
             FROM spv_batch WHERE label = 'full'),
  'full: latest mosaic with its worker mosaic URL');
SELECT ok((SELECT points IS NULL AND spore_mosaic->>'mosaicMediaUrl' IS NOT NULL
             FROM spv_batch WHERE label = 'mosaic_no_points'),
  'mosaic_no_points: points NULL while spore_mosaic is returned');

-- ── Bounds ───────────────────────────────────────────────────────────────────
SELECT is_empty('SELECT * FROM public.get_public_observation_spore_previews(NULL)',
  'bounds: NULL input returns no rows');
SELECT is_empty($$SELECT * FROM public.get_public_observation_spore_previews('{}'::bigint[])$$,
  'bounds: empty input returns no rows');
SELECT is((SELECT count(*) FROM public.get_public_observation_spore_previews(
             ARRAY[f.observation_id, f.observation_id, NULL, f.observation_id])),
          1::bigint, 'bounds: duplicate and NULL elements collapse to one row')
  FROM spv_fixture f WHERE f.label = 'full';
SELECT is((SELECT count(*) FROM public.get_public_observation_spore_previews(
             array_fill(f.observation_id, ARRAY[59]) || ARRAY[-1::bigint])),
          1::bigint, 'bounds: 60 elements are accepted')
  FROM spv_fixture f WHERE f.label = 'full';
SELECT throws_ok(
  format('SELECT * FROM public.get_public_observation_spore_previews(array_fill(%s::bigint, ARRAY[61]))',
         (SELECT observation_id FROM spv_fixture WHERE label = 'full')),
  '22023', 'get_public_observation_spore_previews accepts at most 60 observation ids, got 61',
  'bounds: 61 ids are rejected with a clear error');
SELECT throws_ok(
  'SELECT * FROM public.get_public_observation_spore_previews(array_fill(NULL::bigint, ARRAY[61]))',
  '22023', NULL, 'bounds: 61 NULL elements are rejected');
SELECT throws_ok(
  format('SELECT * FROM public.get_public_observation_spore_previews(array_fill(%s::bigint, ARRAY[8, 8]))',
         (SELECT observation_id FROM spv_fixture WHERE label = 'full')),
  '22023', NULL, 'bounds: a 64-element 2-D array is rejected');
SELECT is_empty($$SELECT 1 FROM (
    SELECT observation_id, lag(observation_id) OVER () AS prev
      FROM public.get_public_observation_spore_previews(
             (SELECT array_agg(observation_id ORDER BY observation_id DESC) FROM spv_fixture))
  ) s WHERE s.prev >= s.observation_id$$,
  'bounds: rows come back in observation_id order');

-- ── Grants, owner, SECURITY DEFINER and search_path ──────────────────────────
SELECT ok(has_function_privilege('anon', 'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE'),
  'grants: anon can execute');
SELECT ok(has_function_privilege('authenticated', 'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE'),
  'grants: authenticated can execute');
SELECT ok(NOT has_function_privilege('service_role', 'public.get_public_observation_spore_previews(bigint[])', 'EXECUTE'),
  'grants: service_role is not granted');
SELECT is_empty($$SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.get_public_observation_spore_previews(bigint[])'::regprocedure
     AND a.grantee = 0$$,
  'grants: PUBLIC holds no privilege');
SELECT is_definer('public', 'get_public_observation_spore_previews', ARRAY['bigint[]'],
  'shape: SECURITY DEFINER');
SELECT volatility_is('public', 'get_public_observation_spore_previews', ARRAY['bigint[]'], 'stable',
  'shape: STABLE');
SELECT function_owner_is('public', 'get_public_observation_spore_previews', ARRAY['bigint[]'], 'postgres',
  'shape: owned by postgres');
SELECT is((SELECT proconfig FROM pg_proc
            WHERE oid = 'public.get_public_observation_spore_previews(bigint[])'::regprocedure),
          ARRAY['search_path=""'], 'shape: search_path is empty');
SELECT is((SELECT count(*) FROM pg_proc
            WHERE pronamespace = 'private'::regnamespace AND proname LIKE 'public_observation_%'),
          5::bigint, 'shape: five private public_observation_* helpers');
SELECT is_empty($$SELECT p.oid::regprocedure FROM pg_proc p
   WHERE p.pronamespace = 'private'::regnamespace AND p.proname LIKE 'public_observation_%'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE')
          OR NOT p.prosecdef
          OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""'])$$,
  'shape: private helpers are definer, search_path empty, not executable by client roles');

-- ── Through the client roles, as PostgREST calls it ──────────────────────────
-- Viewer switches here are inline DO blocks: calling a pg_temp function while
-- SET ROLE anon crashes the local Postgres backend (signal 11), independent
-- of this feature.
GRANT SELECT ON spv_fixture TO anon, authenticated;
GRANT SELECT ON spv_viewer TO anon, authenticated;
SET LOCAL ROLE anon;
DO $as$
DECLARE uid uuid := (SELECT user_id FROM spv_viewer WHERE label = 'anon');
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN uid IS NULL THEN jsonb_build_object('role', 'anon')
         ELSE jsonb_build_object('sub', uid::text, 'role', 'authenticated') END::text, true);
END
$as$;
SELECT is((SELECT count(*) FROM spv_fixture f,
                 public.get_public_observation_spore_previews(ARRAY[f.observation_id]) b
            WHERE f.label = 'full'),
          1::bigint, 'roles: anon executes the function');
SELECT throws_ok(
  'SELECT * FROM private.public_observation_eligibility(ARRAY[1::bigint])',
  '42501', NULL, 'roles: anon cannot call a private helper');
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $as$
DECLARE uid uuid := (SELECT user_id FROM spv_viewer WHERE label = 'stranger');
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN uid IS NULL THEN jsonb_build_object('role', 'anon')
         ELSE jsonb_build_object('sub', uid::text, 'role', 'authenticated') END::text, true);
END
$as$;
SELECT is((SELECT count(*) FROM spv_fixture f,
                 public.get_public_observation_spore_previews(ARRAY[f.observation_id]) b
            WHERE f.label = 'full'),
          1::bigint, 'roles: authenticated stranger executes the function');
DO $as$
DECLARE uid uuid := (SELECT user_id FROM spv_viewer WHERE label = 'blocker');
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  PERFORM set_config('request.jwt.claims',
    CASE WHEN uid IS NULL THEN jsonb_build_object('role', 'anon')
         ELSE jsonb_build_object('sub', uid::text, 'role', 'authenticated') END::text, true);
END
$as$;
SELECT is((SELECT count(*) FROM spv_fixture f,
                 public.get_public_observation_spore_previews(ARRAY[f.observation_id]) b
            WHERE f.label = 'full'),
          0::bigint, 'roles: authenticated blocked viewer gets no row');
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
