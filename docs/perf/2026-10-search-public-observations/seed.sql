-- Synthetic fixtures for docs/perf/2026-10-search-public-observations.md.
-- LOCAL ISOLATED DATABASE ONLY (Stage 1b: project sporely-stage1b-f92d560).
-- No production data: every user, observation, image and measurement below is
-- generated. Run as postgres on a database whose observations table holds no
-- other rows:
--
--   docker exec -i supabase_db_sporely-stage1b-f92d560 psql -U postgres -X -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-search-public-observations/seed.sql
--
-- Optional psql variables: -v scale=1|2|4 (default 1), -v variant=base|skew
-- (default base). seed-2x.sql, seed-4x.sql and seed-1x-skew.sql re-seed at
-- another scale with the procedure installed here. cleanup.sql removes it all.
-- Synthetic users share the uuid prefix 00000000-0000-4000-8000-00005e0b....
--
-- 1x reproduces the production probe of 2026-10-13
-- (production-probe-2026-10-13.txt) as follows. No random(); every row is
-- placed by a fixed modular rule.
--   Exact targets (probe count(*)): 228 public non-draft observations, 133 of
--     them with a gated microscope image, 127 with public spore measurements,
--     988 metadata-parent images (microscope, storage_path NULL, any state),
--     8,982 spore measurements, observations per owner p50 2 / p95 146 /
--     max 146. The procedure recomputes all of them with the probe's own SQL
--     and raises if any differs.
--   Estimates (n_live_tup, rounded): 787 observations, 5,585 images.
--   Owners: 19 public owners with 146, 14, 12, 10, 9, 8, 7, 6, 5, 2 and nine
--     times 1 public observations (u01..u19; u19 is banned), 6 owners with
--     only non-public observations (u20..u25), and one profile (u30) that
--     only writes a foreign measurement.
--   2x and 4x replicate the whole 1x population (owners included) as new
--     synthetic owners, so every count doubles or quadruples and every share,
--     per-observation distribution and owner percentile is unchanged.
--   variant skew (sensitivity run only): same totals, but every 10th
--     spore-bearing observation gets weight 20 instead of 1 for both
--     metadata parents and measurements.
--
-- Roles of the 228 public observations (k = 1..228, owner by k in the order
-- above; k = 228 is the banned owner's):
--   S (127): spore-bearing. Public metadata parents (metadata_purpose
--     public_microscopy) carrying the owner's spore/manual measurements.
--     Every 3rd also has a byte-backed microscope image without measurements;
--     every 5th has 2 cystidia measurements on its first parent; every 10th
--     has an extra deleted public_microscopy parent with 5 measurements.
--   M (6): gated microscopy, no public spore measurements: 2 with
--     spore_data_visibility private (byte-backed image with 10 measurements
--     plus 2 public_microscopy parents with 10 each), 2 with only cystidia
--     measurements (10) on a byte-backed image, 2 with a byte-backed image
--     and no measurements.
--   N (95): no gated microscopy. Decoys by N ordinal n % 10:
--     1 deleted byte-backed microscope image (5 measurements),
--     2 purged byte-backed microscope image (5 measurements),
--     3 two owner_sync metadata parents (5 measurements each),
--     4 a public_microscopy parent whose only measurements (5) are a
--       foreign user's,
--     5 a deleted public_microscopy parent (10 measurements),
--     6 spore_data_visibility private with 2 public_microscopy parents
--       (5 measurements each),
--     others field images only. k = 228 (banned owner): 3 public_microscopy
--     parents with 20 measurements each.
--   559 non-public observations: i % 10 = 0 draft (visibility public,
--     is_draft), 1-2 friends, otherwise private; 447 spread over u01..u19 in
--     proportion to their public counts, 112 over u20..u25. Every 20th has
--     one public_microscopy parent with 10 measurements.
--   S receives the remaining parents and measurements: parents with weights
--   1 + (j*7) % 5 (minimum 1 each), measurements = parents + the rest with
--   weights 1 + (j*37) % 9, spread evenly over the observation's parents.
--   Field images fill the image estimate, spread evenly over all 787.

\set QUIET on
\if :{?scale}
\else
\set scale 1
\endif
\if :{?variant}
\else
\set variant base
\endif

BEGIN;

CREATE SCHEMA IF NOT EXISTS perf_spo;

CREATE TABLE IF NOT EXISTS perf_spo.obs (
  observation_id bigint PRIMARY KEY,
  replica int NOT NULL,
  ord int NOT NULL,
  kind text NOT NULL,
  role text NOT NULL,
  owner uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS perf_spo.seeded (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  scale int NOT NULL,
  variant text NOT NULL,
  seeded_at timestamptz NOT NULL
);

-- Measurement scenarios, read by bench.sql, plans.sql and function-calls.sql.
DROP TABLE IF EXISTS perf_spo.scenario;
CREATE TABLE perf_spo.scenario (
  sid int PRIMARY KEY,
  label text NOT NULL,
  p_limit int,
  p_offset int,
  p_genus text,
  p_species text,
  p_date_from date,
  p_date_to date,
  p_has_spores boolean,
  p_has_microscopy boolean,
  p_observer text
);
INSERT INTO perf_spo.scenario VALUES
  ( 1, 'default mic=true lim31 off0',     31,   0, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  ( 2, 'default mic=true lim31 off30',    31,  30, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  ( 3, 'default mic=true lim31 off60',    31,  60, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  ( 4, 'default mic=true lim31 off300',   31, 300, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  ( 5, 'spo=null mic=null off0',          31,   0, NULL, NULL, NULL, NULL, NULL, NULL,  NULL),
  ( 6, 'spo=null mic=null off30',         31,  30, NULL, NULL, NULL, NULL, NULL, NULL,  NULL),
  ( 7, 'spo=null mic=true off0',          31,   0, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  ( 8, 'spo=null mic=true off30',         31,  30, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  ( 9, 'spo=null mic=false off0',         31,   0, NULL, NULL, NULL, NULL, NULL, false, NULL),
  (10, 'spo=null mic=false off30',        31,  30, NULL, NULL, NULL, NULL, NULL, false, NULL),
  (11, 'spo=true mic=null off0',          31,   0, NULL, NULL, NULL, NULL, true,  NULL,  NULL),
  (12, 'spo=true mic=null off30',         31,  30, NULL, NULL, NULL, NULL, true,  NULL,  NULL),
  (13, 'spo=true mic=true off0',          31,   0, NULL, NULL, NULL, NULL, true,  true,  NULL),
  (14, 'spo=true mic=true off30',         31,  30, NULL, NULL, NULL, NULL, true,  true,  NULL),
  (15, 'spo=true mic=false off0',         31,   0, NULL, NULL, NULL, NULL, true,  false, NULL),
  (16, 'spo=true mic=false off30',        31,  30, NULL, NULL, NULL, NULL, true,  false, NULL),
  (17, 'spo=false mic=null off0',         31,   0, NULL, NULL, NULL, NULL, false, NULL,  NULL),
  (18, 'spo=false mic=null off30',        31,  30, NULL, NULL, NULL, NULL, false, NULL,  NULL),
  (19, 'spo=false mic=true off0',         31,   0, NULL, NULL, NULL, NULL, false, true,  NULL),
  (20, 'spo=false mic=true off30',        31,  30, NULL, NULL, NULL, NULL, false, true,  NULL),
  (21, 'spo=false mic=false off0',        31,   0, NULL, NULL, NULL, NULL, false, false, NULL),
  (22, 'spo=false mic=false off30',       31,  30, NULL, NULL, NULL, NULL, false, false, NULL),
  (23, 'genus mic=true off0',             31,   0, 'Spogenus03', NULL, NULL, NULL, NULL, true, NULL),
  (24, 'genus+species mic=true off0',     31,   0, 'Spogenus03', 'species2', NULL, NULL, NULL, true, NULL),
  (25, 'taxon miss (fallback = sid 1)',   31,   0, 'Spogen', NULL, NULL, NULL, NULL, true, NULL),
  (26, 'date range mic=true off0',        31,   0, NULL, NULL, date '2026-01-01', date '2026-06-30', NULL, true, NULL),
  (27, 'observer substring mic=true off0', 31,  0, NULL, NULL, NULL, NULL, NULL, true, 'Owner 02'),
  (28, 'table lim51 mic=true off0',       51,   0, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  (29, 'table lim51 mic=true off51',      51,  51, NULL, NULL, NULL, NULL, NULL, true,  NULL),
  (30, 'table lim51 mic=null off0',       51,   0, NULL, NULL, NULL, NULL, NULL, NULL,  NULL),
  (31, 'spo=null mic=null off300',        31, 300, NULL, NULL, NULL, NULL, NULL, NULL,  NULL),
  (32, 'spo=null mic=false off300',       31, 300, NULL, NULL, NULL, NULL, NULL, false, NULL);

-- The call expression for one scenario (named arguments, literals only).
CREATE OR REPLACE FUNCTION perf_spo.call_sql(p_sid int)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format(
    'public.search_public_observations(p_limit => %s, p_offset => %s, p_genus => %L, p_species => %L, '
    'p_date_from => %L, p_date_to => %L, p_has_spores => %L, p_has_microscopy => %L, p_observer => %L)',
    s.p_limit, s.p_offset, s.p_genus, s.p_species, s.p_date_from, s.p_date_to,
    s.p_has_spores, s.p_has_microscopy, s.p_observer)
  FROM perf_spo.scenario s WHERE s.sid = p_sid
$$;

CREATE OR REPLACE FUNCTION perf_spo.owner(p_replica int, p_u int)
RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-8000-00005e0b' || lpad((p_replica * 100 + p_u)::text, 4, '0'))::uuid
$$;

-- Largest-remainder style split of p_total over weights, at least p_min each;
-- leftover units go to the lowest indexes. Deterministic.
CREATE OR REPLACE FUNCTION perf_spo.alloc(p_total int, p_weights int[], p_min int)
RETURNS int[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n int := cardinality(p_weights);
  w bigint;
  rem int;
  used int := 0;
  share int;
  res int[] := '{}';
BEGIN
  IF p_total < n * p_min THEN
    RAISE EXCEPTION 'alloc: total % below % x minimum %', p_total, n, p_min;
  END IF;
  SELECT sum(x) INTO w FROM unnest(p_weights) x;
  rem := p_total - n * p_min;
  FOR i IN 1..n LOOP
    share := (rem::bigint * p_weights[i] / w)::int;
    res := res || (p_min + share);
    used := used + share;
  END LOOP;
  FOR i IN 1..(rem - used) LOOP
    res[i] := res[i] + 1;
  END LOOP;
  RETURN res;
END
$$;

CREATE OR REPLACE FUNCTION perf_spo.add_image(
  p_obs bigint, p_owner uuid, p_tag text, p_type text, p_with_bytes boolean,
  p_purpose text DEFAULT NULL, p_deleted boolean DEFAULT false, p_purged boolean DEFAULT false,
  p_captured timestamptz DEFAULT NULL, p_seed int DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  img bigint;
BEGIN
  INSERT INTO public.observation_images
    (observation_id, user_id, storage_path, image_type, metadata_purpose, deleted_at, purged_at, captured_at,
     contrast, mount_medium, stain, sample_type, sample_source)
  VALUES (p_obs, p_owner,
          CASE WHEN p_with_bytes THEN p_owner::text || '/spo-' || p_obs || '-' || p_tag || '.webp' END,
          p_type, p_purpose,
          CASE WHEN p_deleted THEN timestamptz '2026-09-01' END,
          CASE WHEN p_purged THEN timestamptz '2026-09-02' END,
          p_captured,
          CASE WHEN p_type = 'microscope' THEN (ARRAY['BF', 'DIC', 'Phase', 'not_set'])[1 + p_seed % 4] END,
          CASE WHEN p_type = 'microscope' THEN (ARRAY['Water', 'KOH', 'Melzer', 'Congo red'])[1 + (p_seed / 4) % 4] END,
          CASE WHEN p_type = 'microscope' AND p_seed % 5 = 0 THEN 'Congo red' END,
          CASE WHEN p_type = 'microscope' THEN (ARRAY['fresh', 'dried'])[1 + p_seed % 2] END,
          CASE WHEN p_type = 'microscope' THEN (ARRAY['spore_print', 'hymenium'])[1 + (p_seed / 2) % 2] END)
  RETURNING id INTO img;
  RETURN img;
END
$$;

CREATE OR REPLACE FUNCTION perf_spo.add_meas(p_img bigint, p_user uuid, p_n int, p_type text DEFAULT NULL, p_seed int DEFAULT 0)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  SELECT p_img, p_user,
         8 + ((p_seed * 7 + g * 13) % 60) / 10.0,
         5 + ((p_seed * 3 + g * 11) % 40) / 10.0,
         coalesce(p_type, CASE WHEN g % 3 = 0 THEN 'manual' ELSE 'spore' END)
  FROM generate_series(1, p_n) g
$$;

-- Removes every synthetic row (not the perf_spo schema).
CREATE OR REPLACE PROCEDURE perf_spo.clear()
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.spore_measurements WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0b%';
  DELETE FROM public.observation_images WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0b%';
  DELETE FROM public.observations WHERE user_id::text LIKE '00000000-0000-4000-8000-00005e0b%';
  DELETE FROM public.profiles WHERE id::text LIKE '00000000-0000-4000-8000-00005e0b%';
  DELETE FROM auth.users WHERE id::text LIKE '00000000-0000-4000-8000-00005e0b%';
  DELETE FROM perf_spo.obs;
  DELETE FROM perf_spo.seeded;
END
$$;

CREATE OR REPLACE PROCEDURE perf_spo.seed(p_scale int DEFAULT 1, p_variant text DEFAULT 'base')
LANGUAGE plpgsql AS $proc$
DECLARE
  c_public constant int[] := ARRAY[146, 14, 12, 10, 9, 8, 7, 6, 5, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  t_public constant int := 228;
  t_gated constant int := 133;
  t_spores constant int := 127;
  t_parents constant int := 988;
  t_meas constant int := 8982;
  t_obs constant int := 787;
  t_images constant int := 5585;
  banned_u constant int := 19;
  r int;
  u int;
  k int;
  i int;
  j int;
  q int;
  n_ns int;
  n_m int;
  n_n int;
  v_role text;
  v_kind text;
  v_owner uuid;
  owners uuid[];
  np_counts int[];
  obs bigint;
  img bigint;
  d date;
  lp text;
  s_ids bigint[];
  s_owner uuid[];
  s_date date[];
  w_p int[];
  w_m int[];
  p_alloc int[];
  m_extra int[];
  m_j int;
  parents_used int;
  meas_used int;
  images_used int;
  cyst int;
  field_total int;
  nf int;
  got record;
BEGIN
  IF p_scale NOT IN (1, 2, 4) THEN
    RAISE EXCEPTION 'scale must be 1, 2 or 4, got %', p_scale;
  END IF;
  IF p_variant NOT IN ('base', 'skew') THEN
    RAISE EXCEPTION 'variant must be base or skew, got %', p_variant;
  END IF;
  CALL perf_spo.clear();
  -- The exact targets are whole-database counts, as in the probe.
  IF EXISTS (SELECT 1 FROM public.observations)
     OR EXISTS (SELECT 1 FROM public.observation_images)
     OR EXISTS (SELECT 1 FROM public.spore_measurements) THEN
    RAISE EXCEPTION 'non-synthetic observations, images or measurements present: isolated empty database only';
  END IF;

  FOR r IN 0..p_scale - 1 LOOP
    -- Owners: u01..u25, u30 (foreign measurer). u19 is banned. u11..u18 have no
    -- display name, so the label falls back to the username.
    INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    SELECT perf_spo.owner(r, x), 'authenticated', 'authenticated',
           'spo-r' || r || '-u' || x || '@example.test', '{}'::jsonb, now(), now()
    FROM unnest(ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30]) x;
    INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
    SELECT perf_spo.owner(r, x), 'spo_r' || r || '_u' || lpad(x::text, 2, '0'),
           CASE WHEN x BETWEEN 11 AND 18 THEN NULL ELSE 'Spo Owner ' || lpad(x::text, 2, '0') || ' r' || r END,
           true, x = banned_u
    FROM unnest(ARRAY[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30]) x
    ON CONFLICT (id) DO UPDATE
      SET username = excluded.username, display_name = excluded.display_name,
          is_pro = true, is_banned = excluded.is_banned;

    -- Public non-draft observations, k = 1..228.
    owners := '{}';
    FOR u IN 1..19 LOOP
      FOR i IN 1..c_public[u] LOOP
        owners := owners || perf_spo.owner(r, u);
      END LOOP;
    END LOOP;
    n_ns := 0;
    FOR k IN 1..t_public LOOP
      IF k = t_public THEN
        v_role := 'N_banned';
      ELSIF floor(k * 127.0 / 227) <> floor((k - 1) * 127.0 / 227) THEN
        v_role := 'S';
      ELSE
        n_ns := n_ns + 1;
        IF n_ns % 16 = 8 THEN
          n_m := n_ns / 16 + 1;
          v_role := CASE WHEN n_m IN (1, 4) THEN 'M_spore_private'
                         WHEN n_m IN (2, 5) THEN 'M_cystidia'
                         ELSE 'M_none' END;
        ELSE
          n_n := n_ns - n_ns / 16 - CASE WHEN n_ns % 16 > 8 THEN 1 ELSE 0 END;
          v_role := CASE n_n % 10
                    WHEN 1 THEN 'N_deleted_micro'
                    WHEN 2 THEN 'N_purged_micro'
                    WHEN 3 THEN 'N_owner_sync'
                    WHEN 4 THEN 'N_foreign_meas'
                    WHEN 5 THEN 'N_deleted_parent'
                    WHEN 6 THEN 'N_spore_private_parents'
                    ELSE 'N_plain' END;
        END IF;
      END IF;
      v_owner := owners[k];
      d := date '2026-10-10' - (k * 53) % 700;
      lp := (ARRAY['exact', 'fuzzed', 'region', 'hidden'])[1 + k % 4];
      INSERT INTO public.observations
        (user_id, date, genus, species, common_name, author, visibility, is_draft, location_precision, location,
         spore_data_visibility, country_code, spore_statistics)
      VALUES (v_owner, d,
              'Spogenus' || lpad((1 + (k * 7) % 12)::text, 2, '0'), 'species' || (1 + (k * 11) % 9),
              CASE WHEN k % 3 = 0 THEN 'Synthetic common ' || k END,
              CASE WHEN k % 7 = 0 THEN 'Field author ' || k END,
              'public', false, lp, CASE WHEN lp = 'exact' THEN 'Synthetic place ' || k END,
              CASE WHEN v_role IN ('M_spore_private', 'N_spore_private_parents') THEN 'private' ELSE 'public' END,
              CASE WHEN k % 5 = 0 THEN 'SE' ELSE 'NO' END,
              CASE WHEN v_role = 'S' THEN jsonb_build_object('synthetic', true, 'k', k) END)
      RETURNING id INTO obs;
      INSERT INTO perf_spo.obs VALUES (obs, r, k, 'public', v_role, v_owner);
    END LOOP;

    -- Non-public and draft observations, i = 1..559 (ord 1001..1559).
    owners := '{}';
    np_counts := perf_spo.alloc(447, c_public, 0);
    FOR u IN 1..19 LOOP
      FOR i IN 1..np_counts[u] LOOP
        owners := owners || perf_spo.owner(r, u);
      END LOOP;
    END LOOP;
    np_counts := perf_spo.alloc(112, ARRAY[1, 1, 1, 1, 1, 1], 0);
    FOR u IN 1..6 LOOP
      FOR i IN 1..np_counts[u] LOOP
        owners := owners || perf_spo.owner(r, 19 + u);
      END LOOP;
    END LOOP;
    FOR i IN 1..(t_obs - t_public) LOOP
      v_kind := CASE WHEN i % 10 = 0 THEN 'draft' WHEN i % 10 IN (1, 2) THEN 'friends' ELSE 'private' END;
      INSERT INTO public.observations
        (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility, country_code)
      VALUES (owners[i], date '2026-10-10' - (i * 31) % 700,
              'Spogenus' || lpad((1 + (i * 5) % 12)::text, 2, '0'), 'species' || (1 + i % 9),
              CASE v_kind WHEN 'friends' THEN 'friends' WHEN 'private' THEN 'private' ELSE 'public' END,
              v_kind = 'draft', (ARRAY['exact', 'fuzzed', 'hidden'])[1 + i % 3], 'public', 'NO')
      RETURNING id INTO obs;
      INSERT INTO perf_spo.obs VALUES (obs, r, 1000 + i, v_kind, CASE WHEN i % 20 = 0 THEN 'NP_parent' ELSE 'NP_plain' END, owners[i]);
    END LOOP;

    -- Decoys and every non-S microscopy.
    FOR got IN SELECT * FROM perf_spo.obs WHERE replica = r AND role NOT IN ('S', 'N_plain', 'NP_plain') ORDER BY ord LOOP
      CASE got.role
        WHEN 'M_spore_private' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'm1', 'microscope', true, NULL, false, false, NULL, got.ord);
          PERFORM perf_spo.add_meas(img, got.owner, 10, NULL, got.ord);
          FOR q IN 1..2 LOOP
            img := perf_spo.add_image(got.observation_id, got.owner, 'p' || q, 'microscope', false, 'public_microscopy',
                                      false, false, timestamptz '2026-01-01' + make_interval(days => got.ord, mins => q), got.ord + q);
            PERFORM perf_spo.add_meas(img, got.owner, 10, NULL, got.ord + q);
          END LOOP;
        WHEN 'M_cystidia' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'm1', 'microscope', true, NULL, false, false, NULL, got.ord);
          PERFORM perf_spo.add_meas(img, got.owner, 10, 'cystidia', got.ord);
        WHEN 'M_none' THEN
          PERFORM perf_spo.add_image(got.observation_id, got.owner, 'm1', 'microscope', true, NULL, false, false, NULL, got.ord);
        WHEN 'N_deleted_micro' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'm1', 'microscope', true, NULL, true, false, NULL, got.ord);
          PERFORM perf_spo.add_meas(img, got.owner, 5, NULL, got.ord);
        WHEN 'N_purged_micro' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'm1', 'microscope', true, NULL, false, true, NULL, got.ord);
          PERFORM perf_spo.add_meas(img, got.owner, 5, NULL, got.ord);
        WHEN 'N_owner_sync' THEN
          FOR q IN 1..2 LOOP
            img := perf_spo.add_image(got.observation_id, got.owner, 'p' || q, 'microscope', false, 'owner_sync',
                                      false, false, timestamptz '2026-01-01' + make_interval(days => got.ord, mins => q), got.ord + q);
            PERFORM perf_spo.add_meas(img, got.owner, 5, NULL, got.ord + q);
          END LOOP;
        WHEN 'N_foreign_meas' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'p1', 'microscope', false, 'public_microscopy',
                                    false, false, timestamptz '2026-01-01' + make_interval(days => got.ord), got.ord);
          PERFORM perf_spo.add_meas(img, perf_spo.owner(r, 30), 5, NULL, got.ord);
        WHEN 'N_deleted_parent' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'p1', 'microscope', false, 'public_microscopy',
                                    true, false, timestamptz '2026-01-01' + make_interval(days => got.ord), got.ord);
          PERFORM perf_spo.add_meas(img, got.owner, 10, NULL, got.ord);
        WHEN 'N_spore_private_parents' THEN
          FOR q IN 1..2 LOOP
            img := perf_spo.add_image(got.observation_id, got.owner, 'p' || q, 'microscope', false, 'public_microscopy',
                                      false, false, timestamptz '2026-01-01' + make_interval(days => got.ord, mins => q), got.ord + q);
            PERFORM perf_spo.add_meas(img, got.owner, 5, NULL, got.ord + q);
          END LOOP;
        WHEN 'N_banned' THEN
          FOR q IN 1..3 LOOP
            img := perf_spo.add_image(got.observation_id, got.owner, 'p' || q, 'microscope', false, 'public_microscopy',
                                      false, false, timestamptz '2026-01-01' + make_interval(days => got.ord, mins => q), got.ord + q);
            PERFORM perf_spo.add_meas(img, got.owner, 20, NULL, got.ord + q);
          END LOOP;
        WHEN 'NP_parent' THEN
          img := perf_spo.add_image(got.observation_id, got.owner, 'p1', 'microscope', false, 'public_microscopy',
                                    false, false, timestamptz '2026-01-01' + make_interval(days => got.ord % 700), got.ord);
          PERFORM perf_spo.add_meas(img, got.owner, 10, NULL, got.ord);
      END CASE;
    END LOOP;

    -- S extras that are not part of the S allocation.
    SELECT array_agg(o.observation_id ORDER BY o.ord), array_agg(o.owner ORDER BY o.ord), array_agg(ob.date ORDER BY o.ord)
    INTO s_ids, s_owner, s_date
    FROM perf_spo.obs o JOIN public.observations ob ON ob.id = o.observation_id
    WHERE o.replica = r AND o.role = 'S';
    IF cardinality(s_ids) <> t_spores THEN
      RAISE EXCEPTION 'expected % S observations, got %', t_spores, cardinality(s_ids);
    END IF;
    cyst := 0;
    FOR j IN 1..t_spores LOOP
      IF j % 3 = 0 THEN
        PERFORM perf_spo.add_image(s_ids[j], s_owner[j], 'm1', 'microscope', true, NULL, false, false, NULL, j);
      END IF;
      IF j % 10 = 0 THEN
        img := perf_spo.add_image(s_ids[j], s_owner[j], 'pd', 'microscope', false, 'public_microscopy',
                                  true, false, s_date[j] + time '12:00', j);
        PERFORM perf_spo.add_meas(img, s_owner[j], 5, NULL, j);
      END IF;
      IF j % 5 = 0 THEN
        cyst := cyst + 2;
      END IF;
    END LOOP;

    SELECT count(*) FILTER (WHERE i.image_type = 'microscope' AND i.storage_path IS NULL), count(*)
    INTO parents_used, images_used
    FROM public.observation_images i JOIN perf_spo.obs o ON o.observation_id = i.observation_id
    WHERE o.replica = r;
    SELECT count(*) INTO meas_used
    FROM public.spore_measurements m
    JOIN public.observation_images i ON i.id = m.image_id
    JOIN perf_spo.obs o ON o.observation_id = i.observation_id
    WHERE o.replica = r;

    -- S allocation: the remaining parents and measurements.
    SELECT array_agg(CASE WHEN p_variant = 'skew' THEN CASE WHEN g % 10 = 0 THEN 20 ELSE 1 END ELSE 1 + (g * 7) % 5 END ORDER BY g),
           array_agg(CASE WHEN p_variant = 'skew' THEN CASE WHEN g % 10 = 0 THEN 20 ELSE 1 END ELSE 1 + (g * 37) % 9 END ORDER BY g)
    INTO w_p, w_m
    FROM generate_series(1, t_spores) g;
    p_alloc := perf_spo.alloc(t_parents - parents_used, w_p, 1);
    m_extra := perf_spo.alloc(t_meas - meas_used - cyst - (t_parents - parents_used), w_m, 0);
    FOR j IN 1..t_spores LOOP
      m_j := p_alloc[j] + m_extra[j];
      FOR q IN 1..p_alloc[j] LOOP
        img := perf_spo.add_image(s_ids[j], s_owner[j], 'p' || q, 'microscope', false, 'public_microscopy',
                                  false, false, s_date[j] + make_interval(hours => 9, mins => q), j + q);
        PERFORM perf_spo.add_meas(img, s_owner[j], m_j / p_alloc[j] + CASE WHEN q <= m_j % p_alloc[j] THEN 1 ELSE 0 END, NULL, j + q);
        IF q = 1 AND j % 5 = 0 THEN
          PERFORM perf_spo.add_meas(img, s_owner[j], 2, 'cystidia', j);
        END IF;
      END LOOP;
    END LOOP;

    -- Field images fill the image estimate.
    SELECT count(*) INTO images_used
    FROM public.observation_images i JOIN perf_spo.obs o ON o.observation_id = i.observation_id
    WHERE o.replica = r;
    field_total := t_images - images_used;
    IF field_total < 0 THEN
      RAISE EXCEPTION 'image estimate exceeded before field images: %', images_used;
    END IF;
    i := 0;
    FOR got IN SELECT * FROM perf_spo.obs WHERE replica = r ORDER BY ord LOOP
      i := i + 1;
      nf := field_total / t_obs + CASE WHEN i <= field_total % t_obs THEN 1 ELSE 0 END;
      FOR q IN 1..nf LOOP
        PERFORM perf_spo.add_image(got.observation_id, got.owner, 'f' || q, 'field', true);
      END LOOP;
    END LOOP;
  END LOOP;

  -- Verify with the probe's own definitions (whole database).
  WITH pub AS (
    SELECT o.id, o.user_id, o.spore_data_visibility
    FROM public.observations o
    WHERE o.visibility = 'public'::text
      AND NOT coalesce(o.is_draft, false)
  ),
  gated_image AS (
    SELECT i.id, i.observation_id
    FROM public.observation_images i
    WHERE i.deleted_at IS NULL
      AND i.purged_at IS NULL
      AND i.image_type = 'microscope'
      AND (i.storage_path IS NOT NULL OR public.metadata_microscope_parent_is_public(i.id))
  ),
  per_owner AS (
    SELECT count(*) AS n FROM pub WHERE user_id IS NOT NULL GROUP BY user_id
  )
  SELECT
    (SELECT count(*) FROM pub) AS public_observations,
    (SELECT count(*) FROM pub p WHERE EXISTS (SELECT 1 FROM gated_image g WHERE g.observation_id = p.id)) AS gated,
    (SELECT count(*) FROM pub p
      WHERE p.spore_data_visibility = 'public'::text
        AND EXISTS (
          SELECT 1 FROM gated_image g JOIN public.spore_measurements m ON m.image_id = g.id
          WHERE g.observation_id = p.id
            AND public.is_public_microscopy_measurement_type(m.measurement_type)
            AND m.length_um IS NOT NULL AND m.width_um IS NOT NULL)) AS spores,
    (SELECT count(*) FROM public.observation_images i WHERE i.image_type = 'microscope' AND i.storage_path IS NULL) AS parents,
    (SELECT count(*) FROM public.spore_measurements) AS meas,
    (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) FROM per_owner) AS p50,
    (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY n) FROM per_owner) AS p95,
    (SELECT max(n) FROM per_owner) AS pmax,
    (SELECT count(*) FROM public.observations) AS obs_total,
    (SELECT count(*) FROM public.observation_images) AS images_total
  INTO got;
  IF (got.public_observations, got.gated, got.spores, got.parents, got.meas, got.p50, got.p95, got.pmax, got.obs_total, got.images_total)
     IS DISTINCT FROM
     (t_public::bigint * p_scale, t_gated::bigint * p_scale, t_spores::bigint * p_scale, t_parents::bigint * p_scale,
      t_meas::bigint * p_scale, 2::bigint, 146::bigint, 146::bigint, t_obs::bigint * p_scale, t_images::bigint * p_scale) THEN
    RAISE EXCEPTION 'seed does not reproduce the targets at scale %: %', p_scale, got;
  END IF;
  INSERT INTO perf_spo.seeded VALUES (true, p_scale, p_variant, now());
END
$proc$;

CALL perf_spo.seed(:scale, :'variant');

COMMIT;

VACUUM public.observations, public.observation_images, public.spore_measurements, public.profiles;
ANALYZE public.observations, public.observation_images, public.spore_measurements, public.profiles;
