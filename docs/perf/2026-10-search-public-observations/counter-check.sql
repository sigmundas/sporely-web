-- Validates the helper-call counter (pg_stat_xact_user_functions) on a small
-- fixture with known counts, before seed.sql. LOCAL ISOLATED DATABASE ONLY.
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/counter-check.sql
--
-- Fixture (uuid prefix 00000000-0000-4000-8000-00005e0c....), committed for
-- the run and deleted at the end:
--   owner A (display name 'Counter Owner A'), owner B (banned);
--   a1..a5 public observations of A, the only search candidates:
--     a1: 2 public_microscopy metadata parents, 4 owner measurements each;
--     a2: 1 owner_sync metadata parent, 4 owner measurements;
--     a3: 1 byte-backed microscope image, no measurements;
--     a4: 1 deleted public_microscopy parent, 4 owner measurements;
--     a5: 1 field image;
--   b1 public observation of banned B with 1 public_microscopy parent;
--   p1 private observation of A with 1 public_microscopy parent.
-- Known values: 5 candidates. 3 metadata-parent rows (a1 x2, a2 x1) pass
-- the cheaper lateral quals (image_type, deleted_at, purged_at) on
-- candidates; a4's is deleted, b1 and p1 are not candidates.
--
-- Each case runs in a fresh \connect, as function-calls.sql does. Case 0
-- calls the helpers directly a known number of times; the counter must
-- report exactly that. Cases 1-3 call the search as anon and report the
-- counts next to the known candidate and parent numbers; the nested plans
-- (auto_explain, VERBOSE) show which node evaluates each helper and how many
-- rows reach it.
\set QUIET on
\pset footer off

DO $fx$
BEGIN
  IF EXISTS (SELECT 1 FROM public.observations WHERE user_id::text NOT LIKE '00000000-0000-4000-8000-00005e0c%') THEN
    RAISE EXCEPTION 'counter-check runs on an empty database (before seed.sql)';
  END IF;
END
$fx$;

BEGIN;
DELETE FROM public.observations WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0c%';
DELETE FROM public.profiles WHERE id::text LIKE '00000000-0000-4000-8000-00005e0c%';
DELETE FROM auth.users WHERE id::text LIKE '00000000-0000-4000-8000-00005e0c%';
DROP SCHEMA IF EXISTS perf_spo_cc CASCADE;
CREATE SCHEMA perf_spo_cc;
CREATE TABLE perf_spo_cc.fixture (label text PRIMARY KEY, id bigint NOT NULL);

DO $fx$
DECLARE
  a uuid := '00000000-0000-4000-8000-00005e0c0001';
  b uuid := '00000000-0000-4000-8000-00005e0c0002';
  obs bigint;
  img bigint;
  n int;
  q int;
  lbl text;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (a, 'authenticated', 'authenticated', 'spo-counter-a@example.test', '{}'::jsonb, now(), now()),
         (b, 'authenticated', 'authenticated', 'spo-counter-b@example.test', '{}'::jsonb, now(), now());
  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  VALUES (a, 'spo_counter_a', 'Counter Owner A', true, false),
         (b, 'spo_counter_b', 'Counter Owner B', true, true)
  ON CONFLICT (id) DO UPDATE
    SET username = excluded.username, display_name = excluded.display_name, is_pro = true, is_banned = excluded.is_banned;

  FOR n IN 1..7 LOOP
    lbl := (ARRAY['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'p1'])[n];
    INSERT INTO public.observations (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility, country_code)
    VALUES (CASE WHEN lbl = 'b1' THEN b ELSE a END, date '2026-05-01' + n, 'Countergenus', 'species' || n,
            CASE WHEN lbl = 'p1' THEN 'private' ELSE 'public' END, false, 'hidden', 'public', 'NO')
    RETURNING id INTO obs;
    INSERT INTO perf_spo_cc.fixture VALUES (lbl, obs);

    FOR q IN 1..(CASE lbl WHEN 'a1' THEN 2 WHEN 'a3' THEN 0 WHEN 'a5' THEN 0 ELSE 1 END) LOOP
      INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose, deleted_at, captured_at)
      VALUES (obs, CASE WHEN lbl = 'b1' THEN b ELSE a END, NULL, 'microscope',
              CASE WHEN lbl = 'a2' THEN 'owner_sync' ELSE 'public_microscopy' END,
              CASE WHEN lbl = 'a4' THEN timestamptz '2026-09-01' END,
              timestamptz '2026-05-01' + make_interval(days => n, mins => q))
      RETURNING id INTO img;
      INSERT INTO perf_spo_cc.fixture VALUES (lbl || '-parent' || q, img);
      INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
      SELECT img, CASE WHEN lbl = 'b1' THEN b ELSE a END, 9 + g, 6, 'spore' FROM generate_series(1, 4) g;
    END LOOP;
    IF lbl = 'a3' THEN
      INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
      VALUES (obs, a, a::text || '/spo-counter-a3.webp', 'microscope');
    ELSIF lbl = 'a5' THEN
      INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
      VALUES (obs, a, a::text || '/spo-counter-a5.webp', 'field');
    END IF;
  END LOOP;
END
$fx$;
COMMIT;
ANALYZE public.observations, public.observation_images, public.spore_measurements, public.profiles;

\echo '== known values'
SELECT
  (SELECT count(*) FROM public.observations o
    WHERE o.visibility = 'public' AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned)) AS candidates,
  (SELECT count(*) FROM public.observation_images i
     JOIN public.observations o ON o.id = i.observation_id
    WHERE o.visibility = 'public' AND NOT coalesce(o.is_draft, false)
      AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = o.user_id AND p.is_banned)
      AND i.image_type = 'microscope' AND i.storage_path IS NULL
      AND i.deleted_at IS NULL AND i.purged_at IS NULL) AS parents_reached_per_lateral;

\echo '== helper attributes (prosecdef t = never inlined)'
SELECT p.proname, p.prosecdef, p.provolatile, l.lanname
FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('community_contributor_label', 'metadata_microscope_parent_is_public', 'is_public_microscopy_measurement_type')
ORDER BY proname;

\echo '== case 0: direct calls; expected community_contributor_label 5, metadata_microscope_parent_is_public 3'
\connect
BEGIN;
SET LOCAL track_functions = 'all';
SELECT count(public.community_contributor_label('00000000-0000-4000-8000-00005e0c0001'::uuid, NULL)) AS label_rows
FROM generate_series(1, 5);
SELECT count(*) FILTER (WHERE public.metadata_microscope_parent_is_public(f.id)) AS public_parents, count(*) AS parents
FROM perf_spo_cc.fixture f
WHERE f.label IN ('a1-parent1', 'a1-parent2', 'a2-parent1');
SELECT funcname, calls FROM pg_stat_xact_user_functions WHERE schemaname = 'public' ORDER BY funcname;
ROLLBACK;

\echo '== case 1: search, no filters, p_limit 100, as anon'
\connect
BEGIN;
SET LOCAL track_functions = 'all';
SET LOCAL ROLE anon;
SELECT count(*) AS rows, count(*) FILTER (WHERE "hasMicroscopy") AS with_microscopy,
       sum("sporeMeasurementCount") AS measurements
FROM public.search_public_observations(p_limit => 100);
RESET ROLE;
SELECT funcname, calls FROM pg_stat_xact_user_functions WHERE schemaname = 'public' ORDER BY funcname;
ROLLBACK;

\echo '== case 2: search, p_observer => Counter (label needed for every candidate), as anon'
\connect
BEGIN;
SET LOCAL track_functions = 'all';
SET LOCAL ROLE anon;
SELECT count(*) AS rows FROM public.search_public_observations(p_limit => 100, p_observer => 'Counter');
RESET ROLE;
SELECT funcname, calls FROM pg_stat_xact_user_functions WHERE schemaname = 'public' ORDER BY funcname;
ROLLBACK;

\echo '== case 3: search, p_has_microscopy => true, p_limit 2, as anon'
\connect
BEGIN;
SET LOCAL track_functions = 'all';
SET LOCAL ROLE anon;
SELECT count(*) AS rows FROM public.search_public_observations(p_limit => 2, p_has_microscopy => true);
RESET ROLE;
SELECT funcname, calls FROM pg_stat_xact_user_functions WHERE schemaname = 'public' ORDER BY funcname;
ROLLBACK;

\echo '== nested plans for case 1 and case 2 (auto_explain, VERBOSE, every statement)'
\connect
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_verbose = on;
SET auto_explain.log_nested_statements = on;
SET client_min_messages = log;
SET ROLE anon;
SELECT count(*) FROM public.search_public_observations(p_limit => 100);
SELECT count(*) FROM public.search_public_observations(p_limit => 100, p_observer => 'Counter');
RESET ROLE;
RESET client_min_messages;

\echo '== removing the fixture'
BEGIN;
DELETE FROM public.observations WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0c%';
DELETE FROM public.profiles WHERE id::text LIKE '00000000-0000-4000-8000-00005e0c%';
DELETE FROM auth.users WHERE id::text LIKE '00000000-0000-4000-8000-00005e0c%';
DROP SCHEMA perf_spo_cc CASCADE;
COMMIT;
SELECT count(*) AS observations_left FROM public.observations;
