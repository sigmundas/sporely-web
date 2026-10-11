-- Synthetic fixtures for docs/perf/2026-10-batch-spore-preview.md.
-- LOCAL DATABASE ONLY. No real personal data: every user, observation, image,
-- measurement and mosaic below is generated. Run as postgres:
--
--   docker exec -i supabase_db_<project> psql -U postgres -v ON_ERROR_STOP=1 \
--     < docs/perf/2026-10-batch-spore-preview/seed.sql
--
-- Remove with cleanup.sql. All synthetic users share the uuid prefix
-- 00000000-0000-4000-8000-00000bf5....
--
-- Shape (deterministic, no random()):
--   260 eligible public spore-bearing observations, 20-120 spore points each
--       (mean ~70) over 1-3 microscope images, plus 2 field images, a few
--       non-public measurement types (cystidia), and a spore mosaic whose
--       latest version has tiles for up to 48 points. Half have two mosaic
--       versions.
--   50 ineligible decoys with the same spore data: private, friends-only,
--       draft, spore_data_visibility = private, and banned owner (10 each).
--   2000 background public observations with one field image and no
--       microscopy.
--   perf_bsp.ids records the 30-id and 60-id request lists: every 4th
--   eligible observation, in id order, so the requested ids are spread out.

BEGIN;

CREATE SCHEMA IF NOT EXISTS perf_bsp;
DROP TABLE IF EXISTS perf_bsp.obs;
CREATE TABLE perf_bsp.obs (k int PRIMARY KEY, kind text NOT NULL, observation_id bigint NOT NULL, points int NOT NULL);

DO $seed$
DECLARE
  owners uuid[] := ARRAY(
    SELECT ('00000000-0000-4000-8000-00000bf5' || lpad(g::text, 4, '0'))::uuid
    FROM generate_series(1, 12) g
  );
  banned uuid := '00000000-0000-4000-8000-00000bf59999';
  contrasts text[] := ARRAY['BF', 'DIC', 'Phase', 'not_set'];
  mounts text[] := ARRAY['Water', 'KOH', 'Melzer', 'Congo red'];
  k int;
  kind text;
  owner uuid;
  obs bigint;
  img bigint;
  mosaic bigint;
  n_points int;
  n_images int;
  per_image int;
  img_no int;
  vis text;
  spore_vis text;
  draft boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  SELECT u, 'authenticated', 'authenticated', 'perf-' || right(u::text, 4) || '@example.test', '{}'::jsonb, now(), now()
  FROM unnest(owners || banned) u;

  INSERT INTO public.profiles (id, username, display_name, is_pro, is_banned)
  SELECT u, 'perf_' || right(u::text, 4), 'Perf ' || right(u::text, 4), true, u = banned
  FROM unnest(owners || banned) u
  ON CONFLICT (id) DO UPDATE SET is_banned = excluded.is_banned, is_pro = true;

  FOR k IN 1..310 LOOP
    kind := CASE
      WHEN k <= 260 THEN 'eligible'
      WHEN k <= 270 THEN 'private'
      WHEN k <= 280 THEN 'friends'
      WHEN k <= 290 THEN 'draft'
      WHEN k <= 300 THEN 'spore_private'
      ELSE 'banned_owner'
    END;
    owner := CASE WHEN kind = 'banned_owner' THEN banned ELSE owners[1 + k % 12] END;
    vis := CASE kind WHEN 'private' THEN 'private' WHEN 'friends' THEN 'friends' ELSE 'public' END;
    spore_vis := CASE WHEN kind = 'spore_private' THEN 'private' ELSE 'public' END;
    draft := kind = 'draft';
    n_points := 20 + (k * 37) % 101;
    n_images := 1 + k % 3;

    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility, country_code)
    VALUES (owner, date '2026-01-01' + k, 'Perfgenus', 'species' || k, vis, draft, 'hidden', spore_vis, 'NO')
    RETURNING id INTO obs;
    INSERT INTO perf_bsp.obs VALUES (k, kind, obs, n_points);

    -- Two field images, no measurements.
    INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
    SELECT obs, owner, owner::text || '/perf-' || k || '-field-' || g || '.webp', 'field'
    FROM generate_series(1, 2) g;

    per_image := ceil(n_points::numeric / n_images);
    FOR img_no IN 1..n_images LOOP
      INSERT INTO public.observation_images
        (observation_id, user_id, storage_path, image_type, contrast, mount_medium, stain, sample_type, sample_source, captured_at)
      VALUES (obs, owner, owner::text || '/perf-' || k || '-micro-' || img_no || '.webp', 'microscope',
              contrasts[1 + (k + img_no) % 4], mounts[1 + (k * img_no) % 4],
              CASE WHEN img_no = 2 THEN 'Congo red' END,
              CASE WHEN k % 2 = 0 THEN 'fresh' ELSE 'dried' END,
              CASE WHEN img_no = 1 THEN 'spore_print' ELSE 'hymenium' END,
              timestamptz '2026-01-01' + make_interval(days => k, mins => img_no))
      RETURNING id INTO img;

      INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
      SELECT img, owner,
             8 + ((k * 7 + g * 13) % 60) / 10.0,
             5 + ((k * 3 + g * 11) % 40) / 10.0,
             CASE WHEN g % 3 = 0 THEN 'manual' ELSE 'spore' END,
             owner::text || '/perf-' || k || '-' || img_no || '-' || g || '.webp'
      FROM generate_series(1, least(per_image, n_points - (img_no - 1) * per_image)) g;
    END LOOP;

    -- A few non-public measurement types the gates must filter out.
    INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type, thumb_key)
    SELECT img, owner, 40 + g, 10, 'cystidia', owner::text || '/perf-' || k || '-cyst-' || g || '.webp'
    FROM generate_series(1, 3) g;

    IF k % 2 = 0 THEN
      INSERT INTO public.spore_measurement_mosaics
        (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version)
      VALUES (obs, owner, owner::text || '/perf-' || k || '-mosaic-v1.webp', 800, 600, 100, 1);
    END IF;
    INSERT INTO public.spore_measurement_mosaics
      (observation_id, user_id, storage_key, width_px, height_px, tile_size_px, version,
       tile_width_px, tile_height_px, common_crop_width_um, common_crop_height_um)
    VALUES (obs, owner, owner::text || '/perf-' || k || '-mosaic-v2.webp', 800, 600, 100, 2, 100, 100, 20.5, 20.5)
    RETURNING id INTO mosaic;

    INSERT INTO public.spore_measurement_mosaic_tiles (measurement_id, mosaic_id, x_px, y_px, w_px, h_px, overlay_json)
    SELECT m.id, mosaic, ((rn - 1) % 8) * 100, ((rn - 1) / 8) * 100, 100, 100,
           CASE WHEN rn % 4 = 0 THEN '{"line":[[10,20],[80,70]]}'::jsonb END
    FROM (
      SELECT m.id, row_number() OVER (ORDER BY m.id) AS rn
      FROM public.spore_measurements m
      JOIN public.observation_images i ON i.id = m.image_id
      WHERE i.observation_id = obs AND m.measurement_type <> 'cystidia'
    ) m
    WHERE rn <= 48;
  END LOOP;

  -- Background observations without microscopy.
  FOR k IN 1..2000 LOOP
    owner := owners[1 + k % 12];
    INSERT INTO public.observations
      (user_id, date, genus, species, visibility, is_draft, location_precision, spore_data_visibility, country_code)
    VALUES (owner, date '2025-01-01' + (k % 365), 'Bggenus', 'species' || k, 'public', false, 'hidden', 'public', 'NO')
    RETURNING id INTO obs;
    INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type)
    VALUES (obs, owner, owner::text || '/perf-bg-' || k || '.webp', 'field');
  END LOOP;
END
$seed$;

-- Request lists: every 4th eligible observation in id order.
CREATE VIEW perf_bsp.ids AS
SELECT observation_id, points, row_number() OVER (ORDER BY observation_id) AS ordinal
FROM perf_bsp.obs
WHERE kind = 'eligible' AND k % 4 = 0;

COMMIT;

ANALYZE public.observations, public.observation_images, public.spore_measurements,
        public.spore_measurement_mosaics, public.spore_measurement_mosaic_tiles, public.profiles;
