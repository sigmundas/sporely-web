-- pgTAP: point order is the same for get_public_observation and
-- get_public_observation_spore_previews(bigint[]), and does not change with
-- the plan the planner picks.
-- Plan: docs/plans/active/2026-10-10-batch-spore-preview-rpc.md, Stage 2.
--
-- Both readers order points by point_ordinal from
-- private.public_observation_spore_point_rows (image id, measurement id).
-- The fixtures move rows so that physical (ctid) order differs from id
-- order. The same comparisons then run under four plan shapes: the default
-- (index nested loops), sequential scans only, hash joins only and merge
-- joins only.
--
--   supabase db reset --local
--   supabase test db supabase/tests/public_observation_spore_previews_order_test.sql
-- Runs in one transaction and is rolled back.

BEGIN;

SELECT plan(11);

CREATE TEMP TABLE spv_order_obs (observation_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE spv_order_seen (setting text, reader text, observation_id bigint, ids jsonb) ON COMMIT DROP;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-0000000c5f01';
  obs bigint;
  img bigint;
  k int;
  n int;
BEGIN
  INSERT INTO public._media_worker_config (singleton, base_url)
  VALUES (true, 'https://upload.example.test')
  ON CONFLICT (singleton) DO UPDATE SET base_url = excluded.base_url;

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (owner_id, 'authenticated', 'authenticated', 'spv-order@example.test', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES (owner_id, 'spv_order', 'SPV Order', true, false)
  ON CONFLICT (id) DO UPDATE SET is_banned = false;

  -- Four observations, each with three microscope images of six points.
  FOR k IN 1..4 LOOP
    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility)
    VALUES (owner_id, '2026-10-01', 'Ordergenus', 'species' || k, 'public', false, 'hidden', 'public')
    RETURNING id INTO obs;
    INSERT INTO spv_order_obs VALUES (obs);
    FOR n IN 1..3 LOOP
      INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, contrast)
      VALUES (obs, owner_id, owner_id::text || '/spv-order-' || k || '-' || n || '.webp', 'microscope', 'BF')
      RETURNING id INTO img;
      INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
      SELECT img, owner_id, 10 + g / 10.0, 6, 'spore', owner_id::text || '/spv-order-' || k || '-' || n || '-' || g || '.webp'
      FROM generate_series(1, 6) g;
    END LOOP;
  END LOOP;

  -- Move rows: the first image of each observation, and the first and third
  -- measurement of each image, get new heap positions after the others.
  UPDATE public.observation_images i
     SET contrast = 'DIC'
   WHERE i.id IN (
     SELECT min(i2.id) FROM public.observation_images i2
     WHERE i2.observation_id IN (SELECT observation_id FROM spv_order_obs)
     GROUP BY i2.observation_id
   );
  UPDATE public.spore_measurements m
     SET length_um = m.length_um + 0.01
   WHERE m.id IN (
     SELECT x.id FROM (
       SELECT m2.id, row_number() OVER (PARTITION BY m2.image_id ORDER BY m2.id) AS rn
       FROM public.spore_measurements m2
       JOIN public.observation_images i2 ON i2.id = m2.image_id
       WHERE i2.observation_id IN (SELECT observation_id FROM spv_order_obs)
     ) x
     WHERE x.rn IN (1, 3)
   );
END
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.spore_measurements a
    JOIN public.spore_measurements b ON b.image_id = a.image_id AND a.id < b.id AND a.ctid > b.ctid
    JOIN public.observation_images i ON i.id = a.image_id
    WHERE i.observation_id IN (SELECT observation_id FROM spv_order_obs)
  ) AND EXISTS (
    SELECT 1
    FROM public.observation_images a
    JOIN public.observation_images b ON b.observation_id = a.observation_id AND a.id < b.id AND a.ctid > b.ctid
    WHERE a.observation_id IN (SELECT observation_id FROM spv_order_obs)
  ),
  'fixture: ctid order differs from id order for images and measurements'
);

-- Record the point id order of both readers under one plan setting.
CREATE FUNCTION pg_temp.spv_record(p_setting text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO spv_order_seen
  SELECT p_setting, 'single', o.observation_id,
         (SELECT jsonb_agg(pt.value->'id' ORDER BY pt.ord)
          FROM public.get_public_observation(o.observation_id) g,
               jsonb_array_elements(g."sporePoints") WITH ORDINALITY pt(value, ord))
  FROM spv_order_obs o;

  INSERT INTO spv_order_seen
  SELECT p_setting, 'batch', b.observation_id,
         (SELECT jsonb_agg(pt.value->'id' ORDER BY pt.ord)
          FROM jsonb_array_elements(b.points) WITH ORDINALITY pt(value, ord))
  FROM public.get_public_observation_spore_previews(
    (SELECT array_agg(observation_id) FROM spv_order_obs)
  ) b;
END
$f$;

SELECT pg_temp.spv_record('default');

SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
SET LOCAL enable_indexonlyscan = off;
SELECT pg_temp.spv_record('seqscan');
RESET enable_indexscan;
RESET enable_bitmapscan;
RESET enable_indexonlyscan;

SET LOCAL enable_nestloop = off;
SET LOCAL enable_mergejoin = off;
SELECT pg_temp.spv_record('hashjoin');
RESET enable_nestloop;
RESET enable_mergejoin;

SET LOCAL enable_nestloop = off;
SET LOCAL enable_hashjoin = off;
SELECT pg_temp.spv_record('mergejoin');
RESET enable_nestloop;
RESET enable_hashjoin;

SELECT is(
  (SELECT count(*) FROM spv_order_seen WHERE jsonb_array_length(ids) = 18),
  32::bigint,
  'every reader, observation and plan setting returned all 18 points'
);

-- Batch equals single under each setting.
SELECT is(
  (SELECT count(*) FROM spv_order_seen s JOIN spv_order_seen b
     ON b.setting = s.setting AND b.observation_id = s.observation_id
    WHERE s.reader = 'single' AND b.reader = 'batch' AND s.setting = x.setting
      AND s.ids IS DISTINCT FROM b.ids),
  0::bigint,
  'batch point order equals get_public_observation under ' || x.setting
)
FROM (VALUES ('default'), ('seqscan'), ('hashjoin'), ('mergejoin')) x(setting);

-- Each reader's order is the same under every setting.
SELECT is(
  (SELECT count(*) FROM spv_order_seen s JOIN spv_order_seen d
     ON d.reader = s.reader AND d.observation_id = s.observation_id AND d.setting = 'default'
    WHERE s.reader = x.reader AND s.setting <> 'default' AND s.ids IS DISTINCT FROM d.ids),
  0::bigint,
  x.reader || ' point order does not depend on the plan'
)
FROM (VALUES ('single'), ('batch')) x(reader);

-- The order is id order (image id, then measurement id), which here is not
-- physical order.
SELECT is(
  (SELECT s.ids FROM spv_order_seen s
   WHERE s.reader = 'single' AND s.setting = 'default'
     AND s.observation_id = (SELECT min(observation_id) FROM spv_order_obs)),
  (SELECT jsonb_agg(to_jsonb(m.id::text) ORDER BY i.id, m.id)
   FROM public.spore_measurements m
   JOIN public.observation_images i ON i.id = m.image_id
   WHERE i.observation_id = (SELECT min(observation_id) FROM spv_order_obs)),
  'point order is image id, then measurement id'
);
SELECT isnt(
  (SELECT s.ids FROM spv_order_seen s
   WHERE s.reader = 'single' AND s.setting = 'default'
     AND s.observation_id = (SELECT min(observation_id) FROM spv_order_obs)),
  (SELECT jsonb_agg(to_jsonb(m.id::text) ORDER BY i.ctid, m.ctid)
   FROM public.spore_measurements m
   JOIN public.observation_images i ON i.id = m.image_id
   WHERE i.observation_id = (SELECT min(observation_id) FROM spv_order_obs)),
  'fixture: that order is not physical order, so the comparison above is not vacuous'
);

-- The settings did reach the point query: without the ORDER BY, the hash
-- plan would return another order. Checked on the same rows by running the
-- unordered aggregate under the hash setting.
SET LOCAL enable_nestloop = off;
SET LOCAL enable_mergejoin = off;
SELECT isnt(
  (SELECT jsonb_agg(to_jsonb(m.id::text))
   FROM public.spore_measurements m
   JOIN public.observation_images i ON i.id = m.image_id
   WHERE i.observation_id = (SELECT min(observation_id) FROM spv_order_obs)),
  (SELECT s.ids FROM spv_order_seen s
   WHERE s.reader = 'single' AND s.setting = 'default'
     AND s.observation_id = (SELECT min(observation_id) FROM spv_order_obs)),
  'fixture: an unordered aggregate under the hash setting returns a different order'
);
RESET enable_nestloop;
RESET enable_mergejoin;

SELECT * FROM finish();
ROLLBACK;
