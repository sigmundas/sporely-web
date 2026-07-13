-- Manual validation fixture for public.get_public_observation_spore_summaries
-- (Stage E — public read contract for structured spore summaries).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/public_spore_summary_rpc_validation.sql
--
-- The fixture cleans up its rows before returning. If an assertion fails, the
-- single DO statement aborts and rolls back its own changes.

DO $$
DECLARE
  owner_user_id uuid   := '00000000-0000-4000-8000-000000000101';
  banned_user_id uuid  := '00000000-0000-4000-8000-000000000102';
  public_obs_id bigint;
  private_obs_id bigint;
  draft_obs_id bigint;
  friends_obs_id bigint;
  spore_private_obs_id bigint;
  banned_obs_id bigint;
  multi_context_obs_id bigint;
  cross_context_obs_id bigint;
  stain_obs_id bigint;
  taxon_move_obs_id bigint;
  taxon_move_summary_id bigint;
  taxon_move_summary_id_after bigint;
  taxon_move_hash text;
  taxon_move_computed_at timestamptz;

  ctx_null      jsonb := jsonb_build_object(
    'measurement_type', 'spore',
    'sample_type', NULL,
    'mount_reagent', NULL,
    'stain_reagent', NULL,
    'contrast_method', NULL
  );
  ctx_koh_dic   jsonb := jsonb_build_object(
    'measurement_type', 'spore',
    'sample_type', 'fresh',
    'mount_reagent', 'koh',
    'stain_reagent', NULL,
    'contrast_method', 'dic'
  );
  ctx_koh_bf    jsonb := jsonb_build_object(
    'measurement_type', 'spore',
    'sample_type', 'fresh',
    'mount_reagent', 'koh',
    'stain_reagent', NULL,
    'contrast_method', 'brightfield'
  );
  ctx_water_dic jsonb := jsonb_build_object(
    'measurement_type', 'spore',
    'sample_type', 'fresh',
    'mount_reagent', 'water',
    'stain_reagent', NULL,
    'contrast_method', 'dic'
  );
  ctx_melzer    jsonb := jsonb_build_object(
    'measurement_type', 'spore',
    'sample_type', 'dried',
    'mount_reagent', 'water',
    'stain_reagent', 'melzer',
    'contrast_method', 'brightfield'
  );
  ctx_water_bf  jsonb := jsonb_build_object(
    'measurement_type', 'spore',
    'sample_type', 'fresh',
    'mount_reagent', 'water',
    'stain_reagent', NULL,
    'contrast_method', 'brightfield'
  );

  hash_null     text := encode(sha256(convert_to(
    '{"measurement_type":"spore","sample_type":null,"mount_reagent":null,"stain_reagent":null,"contrast_method":null}',
    'utf8'
  )), 'hex');
  hash_koh_dic  text := encode(sha256(convert_to(
    '{"measurement_type":"spore","sample_type":"fresh","mount_reagent":"koh","stain_reagent":null,"contrast_method":"dic"}',
    'utf8'
  )), 'hex');
  hash_water_bf text := encode(sha256(convert_to(
    '{"measurement_type":"spore","sample_type":"fresh","mount_reagent":"water","stain_reagent":null,"contrast_method":"brightfield"}',
    'utf8'
  )), 'hex');
  hash_koh_bf   text := encode(sha256(convert_to(
    '{"measurement_type":"spore","sample_type":"fresh","mount_reagent":"koh","stain_reagent":null,"contrast_method":"brightfield"}',
    'utf8'
  )), 'hex');
  hash_water_dic text := encode(sha256(convert_to(
    '{"measurement_type":"spore","sample_type":"fresh","mount_reagent":"water","stain_reagent":null,"contrast_method":"dic"}',
    'utf8'
  )), 'hex');
  hash_melzer   text := encode(sha256(convert_to(
    '{"measurement_type":"spore","sample_type":"dried","mount_reagent":"water","stain_reagent":"melzer","contrast_method":"brightfield"}',
    'utf8'
  )), 'hex');

  row_count int;
BEGIN
  -- Fixtures need to tolerate the NOT NULL constraints on the observations
  -- table that other tests also relax. We restore them at the end.
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility DROP NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision DROP NOT NULL';

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_user_id,  'authenticated', 'authenticated', 'spore-summary-owner@example.test',  '{}'::jsonb, now(), now()),
    (banned_user_id, 'authenticated', 'authenticated', 'spore-summary-banned@example.test', '{}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_user_id,  'sspec_owner',  'Spore Summary Owner',  false),
    (banned_user_id, 'sspec_banned', 'Spore Summary Banned', true)
  ON CONFLICT (id) DO UPDATE
  SET username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      is_banned = EXCLUDED.is_banned;

  -- ── observations ────────────────────────────────────────────────────
  --
  -- Six visibility scenarios plus one multi-context observation. Every
  -- observation is authored by owner_user_id except the banned one.
  --
  -- The RPC is called from an anonymous session (auth.uid() IS NULL) via
  -- the test harness, so:
  --   * public + spore_data_visibility=public  → visible
  --   * private / friends                       → hidden
  --   * spore_data_visibility != public         → hidden even if obs is public
  --   * draft                                   → hidden
  --   * banned author                           → hidden
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-01', 'Amanita', 'muscaria', 'public',  'public',  false)
  RETURNING id INTO public_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-02', 'Amanita', 'muscaria', 'private', 'private', false)
  RETURNING id INTO private_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-03', 'Amanita', 'muscaria', 'public',  'public',  true)
  RETURNING id INTO draft_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-04', 'Amanita', 'muscaria', 'friends', 'friends', false)
  RETURNING id INTO friends_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-05', 'Amanita', 'muscaria', 'public',  'private', false)
  RETURNING id INTO spore_private_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (banned_user_id, '2026-06-06', 'Amanita', 'muscaria', 'public',  'public',  false)
  RETURNING id INTO banned_obs_id;

  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-07', 'Amanita', 'muscaria', 'public',  'public',  false)
  RETURNING id INTO multi_context_obs_id;

  -- Stage H fixture: observation with two contexts that would each match
  -- ONE of the active filters if we allowed cross-row matching. Any
  -- (p_mount_reagent, p_contrast_method) combination that pairs across
  -- rows must return zero rows.
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-08', 'Amanita', 'muscaria', 'public',  'public',  false)
  RETURNING id INTO cross_context_obs_id;

  -- Stage H fixture: observation whose only summary row has a stain
  -- reagent. Used to verify p_stain_reagent filtering even though the
  -- ExploreSporePanel UI does not expose a stain control yet.
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id,  '2026-06-09', 'Amanita', 'muscaria', 'public',  'public',  false)
  RETURNING id INTO stain_obs_id;

  -- Taxonomy-move fixture (T1..T5): an observation that starts as
  -- Boletus edulis and later has its taxonomy corrected to Boletus
  -- pinophilus without any change to its measurements or image
  -- preparation context. Verifies that the same
  -- observation_spore_summaries rows follow the observation to the new
  -- species without recomputation.
  INSERT INTO public.observations (user_id, date, genus, species, visibility, spore_data_visibility, is_draft)
  VALUES (owner_user_id, '2026-06-10', 'Boletus', 'edulis', 'public', 'public', false)
  RETURNING id INTO taxon_move_obs_id;

  -- ── summary rows ────────────────────────────────────────────────────
  --
  -- Values are deliberately non-null-mean and non-midpoint so we can pin
  -- that the RPC returned the row from observation_spore_summaries and
  -- not a legacy midpoint estimate.
  INSERT INTO public.observation_spore_summaries (
    observation_id, user_id, context_hash, context_json,
    measurement_type, sample_type, mount_reagent, stain_reagent, contrast_method,
    n_spores, n_paired, n_length, n_width,
    length_min_um, length_p05_um, length_mean_um, length_median_um, length_p95_um, length_max_um, length_sd_um,
    width_min_um,  width_p05_um,  width_mean_um,  width_median_um,  width_p95_um,  width_max_um,  width_sd_um,
    q_min,         q_p05,         q_mean,         q_median,         q_p95,         q_max,         q_sd,
    stats_version, computed_at, source_app, source_app_version
  ) VALUES
    (public_obs_id,        owner_user_id,  hash_null,     ctx_null,     'spore', NULL, NULL, NULL, NULL,
     3, 3, 3, 3,
     10.0, 10.2, 11.0, 11.0, 11.8, 12.0, 1.0,
     5.0,  5.1,  5.5,  5.5,  5.9,  6.0,  0.5,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6'),
    (private_obs_id,       owner_user_id,  hash_null,     ctx_null,     'spore', NULL, NULL, NULL, NULL,
     3, 3, 3, 3,
     20.0, 20.0, 20.0, 20.0, 20.0, 20.0, NULL,
     5.0,  5.0,  5.0,  5.0,  5.0,  5.0,  NULL,
     4.0,  4.0,  4.0,  4.0,  4.0,  4.0,  NULL,
     1, now(), 'sporely-py', '0.9.6'),
    (draft_obs_id,         owner_user_id,  hash_null,     ctx_null,     'spore', NULL, NULL, NULL, NULL,
     1, 1, 1, 1,
     9.0,  9.0,  9.0,  9.0,  9.0,  9.0,  NULL,
     4.0,  4.0,  4.0,  4.0,  4.0,  4.0,  NULL,
     2.25, 2.25, 2.25, 2.25, 2.25, 2.25, NULL,
     1, now(), 'sporely-py', '0.9.6'),
    (friends_obs_id,       owner_user_id,  hash_null,     ctx_null,     'spore', NULL, NULL, NULL, NULL,
     1, 1, 1, 1,
     8.0,  8.0,  8.0,  8.0,  8.0,  8.0,  NULL,
     4.0,  4.0,  4.0,  4.0,  4.0,  4.0,  NULL,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  NULL,
     1, now(), 'sporely-py', '0.9.6'),
    (spore_private_obs_id, owner_user_id,  hash_null,     ctx_null,     'spore', NULL, NULL, NULL, NULL,
     1, 1, 1, 1,
     7.0,  7.0,  7.0,  7.0,  7.0,  7.0,  NULL,
     4.0,  4.0,  4.0,  4.0,  4.0,  4.0,  NULL,
     1.75, 1.75, 1.75, 1.75, 1.75, 1.75, NULL,
     1, now(), 'sporely-py', '0.9.6'),
    (banned_obs_id,        banned_user_id, hash_null,     ctx_null,     'spore', NULL, NULL, NULL, NULL,
     1, 1, 1, 1,
     6.0,  6.0,  6.0,  6.0,  6.0,  6.0,  NULL,
     3.0,  3.0,  3.0,  3.0,  3.0,  3.0,  NULL,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  NULL,
     1, now(), 'sporely-py', '0.9.6'),
    (multi_context_obs_id, owner_user_id,  hash_koh_dic,  ctx_koh_dic,  'spore', 'fresh', 'koh',   NULL, 'dic',
     2, 2, 2, 2,
     10.0, 10.0, 10.5, 10.5, 11.0, 11.0, 0.5,
     5.0,  5.0,  5.25, 5.25, 5.5,  5.5,  0.25,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6'),
    (multi_context_obs_id, owner_user_id,  hash_water_bf, ctx_water_bf, 'spore', 'fresh', 'water', NULL, 'brightfield',
     2, 2, 2, 2,
     12.0, 12.0, 12.5, 12.5, 13.0, 13.0, 0.5,
     6.0,  6.0,  6.25, 6.25, 6.5,  6.5,  0.25,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6'),
    -- cross_context_obs_id: two rows deliberately arranged so a naive
    -- OR-of-filters implementation would still return one of them.
    (cross_context_obs_id, owner_user_id, hash_koh_bf,    ctx_koh_bf,    'spore', 'fresh', 'koh',   NULL, 'brightfield',
     2, 2, 2, 2,
     14.0, 14.0, 14.5, 14.5, 15.0, 15.0, 0.5,
     7.0,  7.0,  7.25, 7.25, 7.5,  7.5,  0.25,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6'),
    (cross_context_obs_id, owner_user_id, hash_water_dic, ctx_water_dic, 'spore', 'fresh', 'water', NULL, 'dic',
     2, 2, 2, 2,
     16.0, 16.0, 16.5, 16.5, 17.0, 17.0, 0.5,
     8.0,  8.0,  8.25, 8.25, 8.5,  8.5,  0.25,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6'),
    (stain_obs_id,         owner_user_id, hash_melzer,    ctx_melzer,    'spore', 'dried', 'water', 'melzer', 'brightfield',
     3, 3, 3, 3,
     18.0, 18.0, 18.5, 18.5, 19.0, 19.0, 0.5,
     9.0,  9.0,  9.25, 9.25, 9.5,  9.5,  0.25,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6'),
    -- Taxonomy-move fixture: null-context summary attached to
    -- taxon_move_obs_id. Uses the same context_hash as public_obs_id
    -- (both are null-context), which is fine because context_hash is
    -- unique WITHIN an observation, not across the table.
    (taxon_move_obs_id,     owner_user_id, hash_null,      ctx_null,      'spore', NULL, NULL, NULL, NULL,
     4, 4, 4, 4,
     13.0, 13.0, 13.5, 13.5, 14.0, 14.0, 0.5,
     6.0,  6.0,  6.5,  6.5,  7.0,  7.0,  0.5,
     2.0,  2.0,  2.0,  2.0,  2.0,  2.0,  0.0,
     1, now(), 'sporely-py', '0.9.6');

  -- ── Assertions ──────────────────────────────────────────────────────

  -- E1: empty input returns zero rows (never falls back to "everything").
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(ARRAY[]::bigint[]);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'E1: empty input returned % rows (expected 0)', row_count;
  END IF;

  -- E2: unknown id returns zero rows.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(ARRAY[-1::bigint, 99999999::bigint]);
  IF row_count <> 0 THEN
    RAISE EXCEPTION 'E2: unknown ids returned % rows (expected 0)', row_count;
  END IF;

  -- E3: public + spore_data_visibility=public returns the summary row,
  --     with mean_source = 'measured' and the exact measured means.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[public_obs_id])
    WHERE observation_id = public_obs_id
      AND mean_source = 'measured'
      AND length_mean_um = 11.0
      AND width_mean_um = 5.5
      AND q_mean = 2.0
      AND contributor_label IS NOT NULL
      AND stats_version = 1
      AND source_app = 'sporely-py'
  ) THEN
    RAISE EXCEPTION 'E3: public observation did not surface expected measured summary row';
  END IF;

  -- E4: draft is hidden even with spore_data_visibility=public.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[draft_obs_id])
  ) THEN
    RAISE EXCEPTION 'E4: draft observation leaked a summary row';
  END IF;

  -- E5: private observation is hidden.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[private_obs_id])
  ) THEN
    RAISE EXCEPTION 'E5: private observation leaked a summary row';
  END IF;

  -- E6: friends-only observation is hidden from anon.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[friends_obs_id])
  ) THEN
    RAISE EXCEPTION 'E6: friends-only observation leaked a summary row to anon';
  END IF;

  -- E7: public observation with spore_data_visibility='private' hides the
  --     spore summary even though the observation itself is public.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[spore_private_obs_id])
  ) THEN
    RAISE EXCEPTION 'E7: spore_data_visibility=private leaked a summary row';
  END IF;

  -- E8: banned author is hidden.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[banned_obs_id])
  ) THEN
    RAISE EXCEPTION 'E8: banned author leaked a summary row';
  END IF;

  -- E9: multiple contexts for one observation return multiple rows.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(ARRAY[multi_context_obs_id]);
  IF row_count <> 2 THEN
    RAISE EXCEPTION
      'E9: multi-context observation returned % rows (expected 2)',
      row_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[multi_context_obs_id])
    WHERE mount_reagent = 'koh' AND contrast_method = 'dic'
      AND length_mean_um = 10.5
  ) THEN
    RAISE EXCEPTION 'E9a: KOH/DIC row not returned or values incorrect';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[multi_context_obs_id])
    WHERE mount_reagent = 'water' AND contrast_method = 'brightfield'
      AND length_mean_um = 12.5
  ) THEN
    RAISE EXCEPTION 'E9b: water/brightfield row not returned or values incorrect';
  END IF;

  -- E10: mean_source is ALWAYS 'measured' — the RPC never invents a value.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[public_obs_id, multi_context_obs_id]
    )
    WHERE mean_source IS DISTINCT FROM 'measured'
  ) THEN
    RAISE EXCEPTION 'E10: mean_source is not always ''measured''';
  END IF;

  -- E11: no direct anonymous SELECT policy was added to
  --      observation_spore_summaries. Only the owner-full policy from
  --      Stage B exists; nothing named `*anon*` / `*public read*`.
  IF EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'observation_spore_summaries'
      AND (p.polname ILIKE '%anon%' OR p.polname ILIKE '%public read%')
  ) THEN
    RAISE EXCEPTION 'E11: unexpected anon / public read RLS policy present on observation_spore_summaries';
  END IF;

  -- E12: the RPC filters on p_observation_ids — passing an unrelated id
  --      should not surface the visible row.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[-1::bigint])
    WHERE observation_id = public_obs_id
  ) THEN
    RAISE EXCEPTION 'E12: RPC returned the visible row for an unrelated id array';
  END IF;

  -- ── Stage H context-filter assertions ───────────────────────────────

  -- H1: with no filter args (all NULL) the RPC returns every measured
  --     context for a multi-context observation.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(ARRAY[multi_context_obs_id]);
  IF row_count <> 2 THEN
    RAISE EXCEPTION
      'H1: no-filter call returned % rows for multi-context obs (expected 2)',
      row_count;
  END IF;

  -- H2: p_mount_reagent='koh' returns only KOH rows, water rows dropped.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(
      ARRAY[multi_context_obs_id],
      p_mount_reagent := 'koh'
    );
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'H2: mount=koh returned % rows (expected 1)', row_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[multi_context_obs_id],
      p_mount_reagent := 'koh'
    )
    WHERE mount_reagent = 'koh' AND contrast_method = 'dic'
  ) THEN
    RAISE EXCEPTION 'H2b: mount=koh returned the wrong row';
  END IF;

  -- H3: filter matching is case-insensitive and trims whitespace.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[multi_context_obs_id],
      p_mount_reagent := '  KOH  '
    )
    WHERE mount_reagent = 'koh'
  ) THEN
    RAISE EXCEPTION 'H3: filter did not normalize whitespace/case';
  END IF;

  -- H4: null / empty row context does not match an active filter.
  --     public_obs_id has a single null-context row; filtering by
  --     mount=koh must exclude it.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[public_obs_id],
      p_mount_reagent := 'koh'
    )
  ) THEN
    RAISE EXCEPTION 'H4: null-context row leaked past mount=koh filter';
  END IF;

  -- H5: multiple active context filters must match the SAME summary row.
  --     cross_context_obs_id has row A (koh+brightfield) and row B
  --     (water+dic). Asking for (koh, dic) must return 0 rows because
  --     no single row matches both.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(
      ARRAY[cross_context_obs_id],
      p_mount_reagent   := 'koh',
      p_contrast_method := 'dic'
    );
  IF row_count <> 0 THEN
    RAISE EXCEPTION
      'H5: cross-row filter satisfaction should have returned 0 rows, got %',
      row_count;
  END IF;

  -- H5b: paired same-row filters DO match. koh+brightfield exists.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(
      ARRAY[cross_context_obs_id],
      p_mount_reagent   := 'koh',
      p_contrast_method := 'brightfield'
    );
  IF row_count <> 1 THEN
    RAISE EXCEPTION
      'H5b: koh+brightfield same-row filter returned % rows (expected 1)',
      row_count;
  END IF;

  -- H6: p_stain_reagent filter works, even though ExploreSporePanel does
  --     not expose a stain control yet.
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[stain_obs_id],
      p_stain_reagent := 'MELZER'
    )
    WHERE stain_reagent = 'melzer'
  ) THEN
    RAISE EXCEPTION 'H6: p_stain_reagent did not return the Melzer row';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[stain_obs_id],
      p_stain_reagent := 'congo red'
    )
  ) THEN
    RAISE EXCEPTION 'H6b: stain filter matched a non-matching stain';
  END IF;

  -- H7: empty-string filter behaves like no filter.
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(
      ARRAY[multi_context_obs_id],
      p_mount_reagent := ''
    );
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'H7: empty-string filter changed row count (%)', row_count;
  END IF;
  SELECT count(*)
    INTO row_count
    FROM public.get_public_observation_spore_summaries(
      ARRAY[multi_context_obs_id],
      p_mount_reagent := '   '
    );
  IF row_count <> 2 THEN
    RAISE EXCEPTION 'H7b: whitespace-only filter changed row count (%)', row_count;
  END IF;

  -- H8: visibility gates are still applied when context filters are
  --     active. Draft/private/friends/spore-private/banned observations
  --     stay hidden even with a matching context filter.
  IF EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(
      ARRAY[draft_obs_id, private_obs_id, friends_obs_id, spore_private_obs_id, banned_obs_id],
      p_mount_reagent := 'koh',
      p_sample_type   := 'fresh'
    )
  ) THEN
    RAISE EXCEPTION 'H8: visibility gate leaked under active context filters';
  END IF;

  -- H9: no direct anon SELECT policy was added to
  --     observation_spore_summaries as part of Stage H. Re-run the
  --     Stage E policy assertion after all filter work.
  IF EXISTS (
    SELECT 1
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'observation_spore_summaries'
      AND (p.polname ILIKE '%anon%' OR p.polname ILIKE '%public read%')
  ) THEN
    RAISE EXCEPTION 'H9: Stage H unexpectedly introduced an anon/public read RLS policy';
  END IF;

  -- ── Taxonomy-move assertions ───────────────────────────────────────
  --
  -- Contract: when an observation's genus/species change but its
  -- measurements and image preparation context do not, the same
  -- observation_spore_summaries rows must follow the observation to
  -- the new species without recomputation. The species→observation
  -- resolution happens at read time via observations.genus/species —
  -- the summary table itself carries neither field.

  -- T1: schema-level proof — observation_spore_summaries has no
  --     genus/species/species_slug columns. Nothing to migrate when
  --     taxonomy changes.
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'observation_spore_summaries'
      AND column_name IN ('genus', 'species', 'species_slug', 'taxon_id')
  ) THEN
    RAISE EXCEPTION
      'T1: observation_spore_summaries unexpectedly carries a taxonomy column — a taxonomy change would require row rewrites';
  END IF;

  -- T2: baseline — the RPC surfaces the summary for the observation as
  --     Boletus edulis, and we capture its id + context_hash for later
  --     equality checks.
  SELECT id, context_hash, computed_at
    INTO taxon_move_summary_id, taxon_move_hash, taxon_move_computed_at
    FROM public.observation_spore_summaries
    WHERE observation_id = taxon_move_obs_id;
  IF taxon_move_summary_id IS NULL THEN
    RAISE EXCEPTION 'T2: taxonomy-move fixture missing its summary row';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[taxon_move_obs_id])
    WHERE observation_id = taxon_move_obs_id
      AND context_hash   = taxon_move_hash
  ) THEN
    RAISE EXCEPTION 'T2: RPC did not surface the taxonomy-move fixture pre-move';
  END IF;

  -- T3: baseline — search_public_observations under species=edulis
  --     includes the observation; under pinophilus does not.
  IF NOT EXISTS (
    SELECT 1 FROM public.search_public_observations(p_genus := 'Boletus', p_species := 'edulis')
    WHERE id = taxon_move_obs_id
  ) THEN
    RAISE EXCEPTION 'T3: search_public_observations missed the pre-move species';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.search_public_observations(p_genus := 'Boletus', p_species := 'pinophilus')
    WHERE id = taxon_move_obs_id
  ) THEN
    RAISE EXCEPTION 'T3: search_public_observations returned the observation under the wrong species pre-move';
  END IF;

  -- T4: simulate a taxonomy-only sync — update genus/species on the
  --     observation row, leaving observation_spore_summaries and every
  --     source (spore_measurements, observation_images) untouched. The
  --     summary row's id and context_hash must be unchanged.
  UPDATE public.observations
    SET genus = 'Boletus', species = 'pinophilus'
    WHERE id = taxon_move_obs_id;

  SELECT id INTO taxon_move_summary_id_after
    FROM public.observation_spore_summaries
    WHERE observation_id = taxon_move_obs_id;
  IF taxon_move_summary_id_after IS DISTINCT FROM taxon_move_summary_id THEN
    RAISE EXCEPTION
      'T4: observation_spore_summaries.id changed after taxonomy-only update (was %, now %)',
      taxon_move_summary_id, taxon_move_summary_id_after;
  END IF;
  IF (
    SELECT context_hash FROM public.observation_spore_summaries WHERE id = taxon_move_summary_id_after
  ) IS DISTINCT FROM taxon_move_hash THEN
    RAISE EXCEPTION 'T4: context_hash changed after taxonomy-only update';
  END IF;
  IF (
    SELECT computed_at FROM public.observation_spore_summaries WHERE id = taxon_move_summary_id_after
  ) IS DISTINCT FROM taxon_move_computed_at THEN
    RAISE EXCEPTION
      'T4: computed_at moved after taxonomy-only update — implies unnecessary recomputation';
  END IF;

  -- T5: post-move — the observation is now discoverable under the new
  --     species; the same summary row is returned by the RPC; the old
  --     species no longer includes the observation.
  IF NOT EXISTS (
    SELECT 1 FROM public.search_public_observations(p_genus := 'Boletus', p_species := 'pinophilus')
    WHERE id = taxon_move_obs_id
  ) THEN
    RAISE EXCEPTION 'T5: search_public_observations missed the post-move species (pinophilus)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.search_public_observations(p_genus := 'Boletus', p_species := 'edulis')
    WHERE id = taxon_move_obs_id
  ) THEN
    RAISE EXCEPTION
      'T5: observation still surfaces under the old species (edulis) after taxonomy update';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.get_public_observation_spore_summaries(ARRAY[taxon_move_obs_id])
    WHERE observation_id = taxon_move_obs_id
      AND context_hash   = taxon_move_hash
  ) THEN
    RAISE EXCEPTION
      'T5: post-move RPC lost the summary row (context_hash changed or observation excluded)';
  END IF;

  -- ── Cleanup ─────────────────────────────────────────────────────────
  DELETE FROM public.observation_spore_summaries
    WHERE observation_id IN (
      public_obs_id, private_obs_id, draft_obs_id, friends_obs_id,
      spore_private_obs_id, banned_obs_id, multi_context_obs_id,
      cross_context_obs_id, stain_obs_id, taxon_move_obs_id
    );
  DELETE FROM public.observations
    WHERE id IN (
      public_obs_id, private_obs_id, draft_obs_id, friends_obs_id,
      spore_private_obs_id, banned_obs_id, multi_context_obs_id,
      cross_context_obs_id, stain_obs_id, taxon_move_obs_id
    );
  DELETE FROM public.profiles
    WHERE id IN (owner_user_id, banned_user_id);
  DELETE FROM auth.users
    WHERE id IN (owner_user_id, banned_user_id);

  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility SET NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision SET NOT NULL';

  RAISE NOTICE 'public_spore_summary_rpc_validation: all E1..E12, H1..H9 and T1..T5 assertions passed';
END
$$;
