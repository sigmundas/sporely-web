-- Regression coverage for owner-sync metadata-only microscope parents
-- (observation_images rows with storage_path NULL, image_type 'microscope',
-- that exist only to sync owner-private child measurements between the
-- owner's devices).
--
-- Proves:
--   * metadata_purpose 'owner_sync' or NULL never authorizes public
--     exposure of a storage_path-NULL image, regardless of what child
--     measurements it has (fail closed).
--   * metadata_purpose 'public_microscopy' ALONE is never sufficient: it
--     requires an independently-verified qualifying public child
--     measurement, and requires the owning observation to be public,
--     non-draft and spore_data_visibility = 'public'.
--   * A byte-backed image (storage_path NOT NULL) behaves identically
--     regardless of metadata_purpose (the marker is irrelevant to it).
--   * The backfill correctly classifies pre-existing rows.
--   * is_public_microscopy_measurement_type's truth table.
--   * Non-owner cannot write metadata_purpose on someone else's row (RLS).
--   * A byte-backed FIELD image (image_type <> 'microscope') never triggers
--     hasMicroscopy / prep fields / the map-points microscopy filter /
--     microscopy counts, even though it has bytes (regression coverage for
--     the "OR'd instead of AND'd" bug in the first pass at this migration).
--   * get_observation_microscopy_presentations: the image owner sees their
--     own microscopy counts on a PRIVATE observation via a metadata-only
--     parent; a non-owner reader never sees an owner_sync metadata-only
--     parent's measurements, even on an observation they can otherwise read;
--     a non-owner reader DOES see a public_microscopy metadata-only parent's
--     measurements, but only when a verified qualifying child measurement
--     exists (the marker alone is insufficient for a non-owner reader too).
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/owner_sync_metadata_parents_test.sql
--
-- This file is plain DO-block / RAISE EXCEPTION assertions run inside a
-- transaction, not pgTAP (no plan(), no pgtap.* functions, no TAP output).
-- A failing assertion aborts the whole DO block with a Postgres exception;
-- there is no per-assertion pass/fail report.
--
-- Wrapped in BEGIN/ROLLBACK (rather than manual DELETE cleanup) because
-- deleting the fixture auth.users rows cascades into an unrelated
-- anonymize-on-delete trigger (private.anonymize_shared_reference_
-- contributions_for_profile) that some roles lack grants for; rolling back
-- avoids depending on that trigger's grants entirely.
--
-- Backfill-test caveat: this file runs AFTER all migrations (including this
-- one) are already applied, so migration 20260925120000's one-time backfill
-- UPDATE has already run before any fixture row in this file exists — there
-- is no way, from a single post-migration SQL file, to seed a row and then
-- have that specific migration's UPDATE run over it. The backfill section
-- below therefore re-executes a copy of the migration's current backfill
-- predicate against freshly-inserted rows shaped like pre-existing legacy
-- data, which is a hand-copied reimplementation and can drift from the
-- migration if one is edited without the other. The authoritative check —
-- seeding qualifying rows against the schema BEFORE migration 20260925120000
-- and confirming its actual UPDATE marks them correctly — was performed out
-- of band in a throwaway Postgres replay when this backfill predicate was
-- last changed; it is not part of this automated file.

BEGIN;

DO $$
DECLARE
  owner_id        uuid := '00000000-0000-4000-8000-00000000a001';
  other_id        uuid := '00000000-0000-4000-8000-00000000a002';
  obs_public      bigint;   -- public, non-draft, spore_data_visibility public
  obs_private     bigint;   -- visibility 'private'
  obs_draft       bigint;   -- is_draft = true
  obs_hidden_spore bigint;  -- public but spore_data_visibility private
  img_owner_sync  bigint;
  img_null_marker bigint;
  img_marker_only bigint;   -- 'public_microscopy' but only cheilocystidia
  img_marker_qual bigint;   -- 'public_microscopy' with a qualifying 'spore' measurement
  img_private_obs bigint;
  img_draft_obs   bigint;
  img_hidden_spore bigint;
  img_byte_backed bigint;
  obs_field_only  bigint;   -- public; ONLY a byte-backed FIELD image (regression for the OR/AND bug)
  img_field_only  bigint;
  img_owner_sync_qualifying bigint;  -- owner_sync marker + a QUALIFYING 'spore' measurement, on obs_public
  friend_id       uuid := '00000000-0000-4000-8000-00000000a003';
  rpc_row         record;
  n               bigint;
  upd_count       integer;
  row_count       integer;
  pre_existing_qualifying_id bigint;
  pre_existing_cystidia_id   bigint;
  pre_existing_hidden_spore_qualifying_id bigint;
BEGIN
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility DROP NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision DROP NOT NULL';

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id, 'authenticated', 'authenticated', 'owner-sync-owner@example.test', '{}'::jsonb, now(), now()),
    (other_id, 'authenticated', 'authenticated', 'owner-sync-other@example.test', '{}'::jsonb, now(), now()),
    (friend_id, 'authenticated', 'authenticated', 'owner-sync-friend@example.test', '{}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_id, 'owner_sync_owner', 'Owner Sync Owner', false),
    (other_id, 'owner_sync_other', 'Owner Sync Other', false),
    (friend_id, 'owner_sync_friend', 'Owner Sync Friend', false)
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    is_banned = false;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    owner_id, '2026-09-01', 'Ownersynctestus', 'observation917', 'public', false,
    'public', 'exact', 'NO'
  )
  RETURNING id INTO obs_public;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    owner_id, '2026-09-01', 'Ownersynctestus', 'privateobs', 'private', false,
    'public', 'exact', 'NO'
  )
  RETURNING id INTO obs_private;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    owner_id, '2026-09-01', 'Ownersynctestus', 'draftobs', 'public', true,
    'public', 'exact', 'NO'
  )
  RETURNING id INTO obs_draft;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    owner_id, '2026-09-01', 'Ownersynctestus', 'hiddenspore', 'public', false,
    'private', 'exact', 'NO'
  )
  RETURNING id INTO obs_hidden_spore;

  INSERT INTO public.observations (
    user_id, date, genus, species, visibility, is_draft,
    spore_data_visibility, location_precision, country_code
  )
  VALUES (
    owner_id, '2026-09-01', 'Ownersynctestus', 'fieldonly', 'public', false,
    'public', 'exact', 'NO'
  )
  RETURNING id INTO obs_field_only;

  --------------------------------------------------------------------------
  -- obs_field_only: ONLY a byte-backed FIELD image (image_type = 'field',
  -- NOT 'microscope'). Direct regression fixture for the bug where the
  -- first pass at this migration replaced `image_type = 'microscope'` with
  -- `(storage_path IS NOT NULL OR metadata_microscope_parent_is_public(id))`
  -- instead of ANDing it in: any byte-backed image of ANY type, including a
  -- field photo, would then satisfy the eligibility test.
  --------------------------------------------------------------------------

  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, metadata_purpose,
    sort_order, source_width, source_height, stored_width, stored_height,
    mount_medium, sample_type, contrast
  )
  VALUES (
    obs_field_only, owner_id, owner_id::text || '/field-only.webp', 'field', NULL,
    0, 4000, 3000, 800, 600, 'koh', 'fresh', 'brightfield'
  )
  RETURNING id INTO img_field_only;

  --------------------------------------------------------------------------
  -- Fixture images on obs_public: the "observation-917" shape — a metadata-
  -- only microscope parent with ONLY cheilocystidia measurements, in every
  -- marker state.
  --------------------------------------------------------------------------

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', 'owner_sync')
  RETURNING id INTO img_owner_sync;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', NULL)
  RETURNING id INTO img_null_marker;

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', 'public_microscopy')
  RETURNING id INTO img_marker_only;

  -- Only cheilocystidia measurements on each of the three rows above.
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES
    (img_owner_sync, owner_id, 8.0, 3.0, 'cheilocystidia'),
    (img_owner_sync, owner_id, 8.5, 3.1, 'cheilocystidia'),
    (img_owner_sync, owner_id, 9.0, 3.2, 'cheilocystidia'),
    (img_null_marker, owner_id, 8.0, 3.0, 'cheilocystidia'),
    (img_null_marker, owner_id, 8.5, 3.1, 'cheilocystidia'),
    (img_null_marker, owner_id, 9.0, 3.2, 'cheilocystidia'),
    (img_marker_only, owner_id, 8.0, 3.0, 'cheilocystidia'),
    (img_marker_only, owner_id, 8.5, 3.1, 'cheilocystidia'),
    (img_marker_only, owner_id, 9.0, 3.2, 'cheilocystidia');

  -- A separate metadata-only parent, marked 'public_microscopy', WITH a
  -- qualifying public spore measurement (type 'spore').
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', 'public_microscopy')
  RETURNING id INTO img_marker_qual;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_marker_qual, owner_id, 7.0, 4.0, 'spore');

  -- Same marker + qualifying measurement shape, but on private / draft /
  -- hidden-spore observations.
  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_private, owner_id, NULL, 'microscope', 'public_microscopy')
  RETURNING id INTO img_private_obs;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_private_obs, owner_id, 7.0, 4.0, 'spore');

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_draft, owner_id, NULL, 'microscope', 'public_microscopy')
  RETURNING id INTO img_draft_obs;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_draft_obs, owner_id, 7.0, 4.0, 'spore');

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_hidden_spore, owner_id, NULL, 'microscope', 'public_microscopy')
  RETURNING id INTO img_hidden_spore;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_hidden_spore, owner_id, 7.0, 4.0, 'spore');

  -- Byte-backed row on obs_public, marker set to 'public_microscopy' (must
  -- be ignored: ordinary image-visibility rules apply, unaffected by the
  -- marker either way).
  INSERT INTO public.observation_images (
    observation_id, user_id, storage_path, image_type, metadata_purpose,
    sort_order, source_width, source_height, stored_width, stored_height,
    contrast, mount_medium, sample_type
  )
  VALUES (
    obs_public, owner_id, owner_id::text || '/byte-backed.webp', 'microscope', 'public_microscopy',
    0, 4000, 3000, 800, 600, 'brightfield', 'water', 'fresh'
  )
  RETURNING id INTO img_byte_backed;

  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_byte_backed, owner_id, 7.0, 4.0, 'spore');

  --------------------------------------------------------------------------
  -- metadata_microscope_parent_is_public(): direct assertions.
  --------------------------------------------------------------------------

  IF public.metadata_microscope_parent_is_public(img_owner_sync) THEN
    RAISE EXCEPTION 'T1: owner_sync marker must never authorize public exposure';
  END IF;

  IF public.metadata_microscope_parent_is_public(img_null_marker) THEN
    RAISE EXCEPTION 'T2: NULL marker must fail closed';
  END IF;

  IF public.metadata_microscope_parent_is_public(img_marker_only) THEN
    RAISE EXCEPTION 'T3: public_microscopy marker alone (cheilocystidia only, no qualifying measurement) must not be sufficient';
  END IF;

  IF NOT public.metadata_microscope_parent_is_public(img_marker_qual) THEN
    RAISE EXCEPTION 'T4: public_microscopy marker WITH a qualifying spore measurement on a public observation must be public';
  END IF;

  IF public.metadata_microscope_parent_is_public(img_private_obs) THEN
    RAISE EXCEPTION 'T5: marker + qualifying measurement on a PRIVATE observation must not be public';
  END IF;

  IF public.metadata_microscope_parent_is_public(img_draft_obs) THEN
    RAISE EXCEPTION 'T6: marker + qualifying measurement on a DRAFT observation must not be public';
  END IF;

  IF public.metadata_microscope_parent_is_public(img_hidden_spore) THEN
    RAISE EXCEPTION 'T7: marker + qualifying measurement with spore_data_visibility private must not be public';
  END IF;

  --------------------------------------------------------------------------
  -- get_public_observation(obs_public): hasMicroscopy / sporeMeasurementCount
  -- / sporePoints must reflect ONLY img_marker_qual and img_byte_backed.
  -- img_owner_sync / img_null_marker / img_marker_only must contribute
  -- nothing.
  --------------------------------------------------------------------------

  SELECT * INTO rpc_row FROM public.get_public_observation(obs_public);
  IF rpc_row.id IS DISTINCT FROM obs_public THEN
    RAISE EXCEPTION 'T8: get_public_observation did not return obs_public';
  END IF;
  IF rpc_row."hasMicroscopy" IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T9: hasMicroscopy expected true (byte-backed + qualifying metadata row present), got %', rpc_row."hasMicroscopy";
  END IF;
  -- Two qualifying spore-typed measurements total: one on img_marker_qual,
  -- one on img_byte_backed. The nine cheilocystidia measurements across the
  -- three non-qualifying rows must not be counted.
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'T10: sporeMeasurementCount expected 2 (qualifying rows only), got %', rpc_row."sporeMeasurementCount";
  END IF;
  IF rpc_row."sporePoints" IS NULL OR jsonb_array_length(rpc_row."sporePoints") IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'T11: sporePoints expected 2 points, got %', rpc_row."sporePoints";
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(rpc_row."sporePoints") pt
    WHERE (pt->>'imageId')::bigint IN (img_owner_sync, img_null_marker, img_marker_only)
  ) THEN
    RAISE EXCEPTION 'T12: a non-qualifying metadata-only row leaked into sporePoints';
  END IF;

  --------------------------------------------------------------------------
  -- search_public_observations: hasMicroscopy / sporeMeasurementCount for
  -- obs_public must match, and prep-context filters (mount/contrast/sample)
  -- must not be satisfiable by a non-qualifying metadata-only row alone.
  --------------------------------------------------------------------------

  SELECT * INTO rpc_row
  FROM public.search_public_observations(p_limit := 50, p_offset := 0)
  WHERE id = obs_public;
  IF rpc_row.id IS DISTINCT FROM obs_public THEN
    RAISE EXCEPTION 'T13: search_public_observations did not return obs_public';
  END IF;
  IF rpc_row."hasMicroscopy" IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'T14: search_public_observations hasMicroscopy expected true, got %', rpc_row."hasMicroscopy";
  END IF;
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'T15: search_public_observations sporeMeasurementCount expected 2, got %', rpc_row."sporeMeasurementCount";
  END IF;

  -- obs_private / obs_draft must not appear at all (obs_hidden_spore is a
  -- legitimately public, non-draft observation — it appears in listings,
  -- just with no spore data exposed; that gating is unrelated to this
  -- fix and is asserted separately via metadata_microscope_parent_is_public
  -- above).
  IF EXISTS (
    SELECT 1 FROM public.search_public_observations(p_limit := 50, p_offset := 0)
    WHERE id IN (obs_private, obs_draft)
  ) THEN
    RAISE EXCEPTION 'T16: a private/draft observation leaked into search_public_observations';
  END IF;

  --------------------------------------------------------------------------
  -- get_observation_microscopy_presentations: sporeMeasurementCount must
  -- not count the cheilocystidia-only metadata rows.
  --------------------------------------------------------------------------

  SELECT * INTO rpc_row
  FROM public.get_observation_microscopy_presentations(ARRAY[obs_public]);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'T17: get_observation_microscopy_presentations sporeMeasurementCount expected 2, got %', rpc_row."sporeMeasurementCount";
  END IF;

  --------------------------------------------------------------------------
  -- Byte-backed row: marker is irrelevant. Confirm it behaves exactly as an
  -- ordinary byte-backed microscope row would (it already counted above via
  -- hasMicroscopy/sporeMeasurementCount/sporePoints). Flip its marker to
  -- 'owner_sync' and to NULL and re-check nothing changes.
  --------------------------------------------------------------------------

  UPDATE public.observation_images SET metadata_purpose = 'owner_sync' WHERE id = img_byte_backed;
  SELECT * INTO rpc_row FROM public.get_public_observation(obs_public);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'T18: byte-backed row sporeMeasurementCount changed when metadata_purpose flipped to owner_sync (got %)', rpc_row."sporeMeasurementCount";
  END IF;

  UPDATE public.observation_images SET metadata_purpose = NULL WHERE id = img_byte_backed;
  SELECT * INTO rpc_row FROM public.get_public_observation(obs_public);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'T19: byte-backed row sporeMeasurementCount changed when metadata_purpose flipped to NULL (got %)', rpc_row."sporeMeasurementCount";
  END IF;

  --------------------------------------------------------------------------
  -- obs_field_only: byte-backed FIELD image only. hasMicroscopy, prep
  -- fields, the map-points microscopy filter, and microscopy counts must
  -- all behave as if no microscope image exists at all.
  --------------------------------------------------------------------------

  SELECT * INTO rpc_row FROM public.get_public_observation(obs_field_only);
  IF rpc_row.id IS DISTINCT FROM obs_field_only THEN
    RAISE EXCEPTION 'T19B: get_public_observation did not return obs_field_only';
  END IF;
  IF rpc_row."hasMicroscopy" IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T19C: hasMicroscopy expected false for a field-image-only observation, got %', rpc_row."hasMicroscopy";
  END IF;
  IF rpc_row."mountReagent" IS NOT NULL THEN
    RAISE EXCEPTION 'T19D: mountReagent leaked from a field (non-microscope) image, got %', rpc_row."mountReagent";
  END IF;
  IF rpc_row."sampleType" IS NOT NULL THEN
    RAISE EXCEPTION 'T19E: sampleType leaked from a field (non-microscope) image, got %', rpc_row."sampleType";
  END IF;
  IF rpc_row."contrastMethod" IS NOT NULL THEN
    RAISE EXCEPTION 'T19F: contrastMethod leaked from a field (non-microscope) image, got %', rpc_row."contrastMethod";
  END IF;
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'T19G: sporeMeasurementCount expected 0 for a field-image-only observation, got %', rpc_row."sporeMeasurementCount";
  END IF;

  -- get_public_map_points: p_has_microscopy := true must exclude it; the
  -- unfiltered row must report hasMicroscopy = false.
  IF EXISTS (
    SELECT 1 FROM public.get_public_map_points(p_has_microscopy := true)
    WHERE "observationId" = obs_field_only
  ) THEN
    RAISE EXCEPTION 'T19H: obs_field_only leaked into get_public_map_points(p_has_microscopy := true)';
  END IF;

  SELECT * INTO rpc_row FROM public.get_public_map_points() WHERE "observationId" = obs_field_only;
  IF rpc_row."observationId" IS DISTINCT FROM obs_field_only THEN
    RAISE EXCEPTION 'T19I: get_public_map_points did not return obs_field_only';
  END IF;
  IF rpc_row."hasMicroscopy" IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'T19J: get_public_map_points hasMicroscopy expected false for obs_field_only, got %', rpc_row."hasMicroscopy";
  END IF;

  -- get_public_species: microscopyObservationCount must not count
  -- obs_field_only, even though observationCount does.
  SELECT * INTO rpc_row FROM public.get_public_species('ownersynctestus-fieldonly');
  IF rpc_row."observationCount" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'T19K: get_public_species observationCount expected 1, got %', rpc_row."observationCount";
  END IF;
  IF rpc_row."microscopyObservationCount" IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'T19L: get_public_species microscopyObservationCount expected 0 for a field-image-only observation, got %', rpc_row."microscopyObservationCount";
  END IF;

  --------------------------------------------------------------------------
  -- get_observation_microscopy_presentations: owner vs. non-owner readers.
  --
  -- img_owner_sync_qualifying: metadata_purpose = 'owner_sync' but WITH a
  -- qualifying 'spore' measurement, added on obs_public (already public).
  -- Its qualifying measurement must count for the OWNER but never for a
  -- non-owner, proving the marker (not just the measurement type) gates
  -- non-owner visibility.
  --------------------------------------------------------------------------

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', 'owner_sync')
  RETURNING id INTO img_owner_sync_qualifying;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (img_owner_sync_qualifying, owner_id, 7.2, 3.8, 'spore');

  -- Owner, reading their own PRIVATE observation (obs_private, which
  -- already has img_private_obs: public_microscopy marker + qualifying
  -- 'spore' measurement): must see the count via the owner-override branch
  -- of metadata_microscope_parent_is_visible_to_reader, even though
  -- obs_private is not publicly readable at all.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', owner_id::text, 'role', 'authenticated')::text,
    true);

  SELECT * INTO rpc_row FROM public.get_observation_microscopy_presentations(ARRAY[obs_private]);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 1 THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', NULL, true);
    PERFORM set_config('request.jwt.claim.sub', NULL, true);
    RAISE EXCEPTION 'T33: owner expected sporeMeasurementCount 1 on their own private observation via a metadata-only parent, got %', rpc_row."sporeMeasurementCount";
  END IF;

  -- Owner, reading obs_public: must see ALL qualifying measurements,
  -- including the owner_sync-marked one (2 pre-existing + 1 owner_sync = 3).
  SELECT * INTO rpc_row FROM public.get_observation_microscopy_presentations(ARRAY[obs_public]);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 3 THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', NULL, true);
    PERFORM set_config('request.jwt.claim.sub', NULL, true);
    RAISE EXCEPTION 'T34: owner expected sporeMeasurementCount 3 on obs_public (including their own owner_sync row), got %', rpc_row."sporeMeasurementCount";
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('request.jwt.claim.sub', NULL, true);

  -- Non-owner (other_id), reading obs_private: not a friend, not the owner,
  -- and the observation is not publicly readable, so no row is returned at
  -- all — the owner_sync metadata parent must not leak even its presence.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', other_id::text, 'role', 'authenticated')::text,
    true);

  SELECT count(*) INTO row_count FROM public.get_observation_microscopy_presentations(ARRAY[obs_private]);
  IF row_count IS DISTINCT FROM 0 THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', NULL, true);
    PERFORM set_config('request.jwt.claim.sub', NULL, true);
    RAISE EXCEPTION 'T35: non-owner unexpectedly received a row for a private observation they cannot read (got % rows)', row_count;
  END IF;

  -- Non-owner (other_id), reading obs_public (publicly readable, so a row
  -- IS returned): must NEVER see the owner_sync row's measurement, even
  -- though the observation itself is otherwise readable. Expect exactly the
  -- 2 pre-existing qualifying measurements (img_marker_qual, img_byte_backed).
  SELECT * INTO rpc_row FROM public.get_observation_microscopy_presentations(ARRAY[obs_public]);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', NULL, true);
    PERFORM set_config('request.jwt.claim.sub', NULL, true);
    RAISE EXCEPTION 'T36: non-owner sporeMeasurementCount expected 2 (owner_sync row must never count for a non-owner), got %', rpc_row."sporeMeasurementCount";
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('request.jwt.claim.sub', NULL, true);

  -- Friend (friend_id, also a non-owner authorized reader): sees the
  -- public_microscopy + qualifying-measurement row (img_marker_qual), and
  -- the same exclusion of the owner_sync row applies — the marker alone
  -- (img_marker_only, cheilocystidia-only) still contributes nothing.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', friend_id::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', friend_id::text, 'role', 'authenticated')::text,
    true);

  SELECT * INTO rpc_row FROM public.get_observation_microscopy_presentations(ARRAY[obs_public]);
  IF rpc_row."sporeMeasurementCount" IS DISTINCT FROM 2 THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', NULL, true);
    PERFORM set_config('request.jwt.claim.sub', NULL, true);
    RAISE EXCEPTION 'T37: friend (non-owner) sporeMeasurementCount expected 2 (marker-only and owner_sync rows must not count), got %', rpc_row."sporeMeasurementCount";
  END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claims', NULL, true);
  PERFORM set_config('request.jwt.claim.sub', NULL, true);

  --------------------------------------------------------------------------
  -- is_public_microscopy_measurement_type: truth table.
  --------------------------------------------------------------------------

  IF NOT public.is_public_microscopy_measurement_type(NULL) THEN
    RAISE EXCEPTION 'T20: NULL measurement_type expected true';
  END IF;
  IF NOT public.is_public_microscopy_measurement_type('') THEN
    RAISE EXCEPTION 'T21: empty-string measurement_type expected true';
  END IF;
  IF NOT public.is_public_microscopy_measurement_type('manual') THEN
    RAISE EXCEPTION 'T22: manual expected true';
  END IF;
  IF NOT public.is_public_microscopy_measurement_type('spore') THEN
    RAISE EXCEPTION 'T23: spore expected true';
  END IF;
  IF NOT public.is_public_microscopy_measurement_type('spores') THEN
    RAISE EXCEPTION 'T24: spores expected true';
  END IF;
  IF NOT public.is_public_microscopy_measurement_type('SPORE') THEN
    RAISE EXCEPTION 'T25: SPORE (uppercase) expected true';
  END IF;
  IF public.is_public_microscopy_measurement_type('cheilocystidia') THEN
    RAISE EXCEPTION 'T26: cheilocystidia expected false';
  END IF;
  IF public.is_public_microscopy_measurement_type('cystidia') THEN
    RAISE EXCEPTION 'T27: cystidia expected false';
  END IF;
  IF public.is_public_microscopy_measurement_type('garbage-value-xyz') THEN
    RAISE EXCEPTION 'T28: random garbage string expected false';
  END IF;

  --------------------------------------------------------------------------
  -- Backfill semantics: simulate three pre-existing (pre-migration-shaped)
  -- rows directly, bypassing the CHECK by inserting with metadata_purpose
  -- NULL (as any pre-migration row necessarily has), then re-run a copy of
  -- the migration's CURRENT backfill predicate (see the file header for why
  -- this is a hand-copied reimplementation rather than a true seed-before-
  -- migration replay) and confirm the expected classification.
  --
  -- pre_existing_hidden_spore_qualifying_id is on obs_hidden_spore
  -- (spore_data_visibility = 'private'). This is the fix (finding 3)
  -- regression case: the OLD backfill predicate additionally required
  -- `o.spore_data_visibility = 'public'`, so this row would have been left
  -- NULL forever despite having genuinely qualifying child data. The fixed
  -- predicate drops that condition, so this row IS backfilled — but
  -- metadata_microscope_parent_is_public() must still independently deny it
  -- at read time, since spore_data_visibility is not public. The marker
  -- alone never authorizes exposure.
  --------------------------------------------------------------------------

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', NULL)
  RETURNING id INTO pre_existing_qualifying_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (pre_existing_qualifying_id, owner_id, 7.5, 3.5, 'manual');

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_public, owner_id, NULL, 'microscope', NULL)
  RETURNING id INTO pre_existing_cystidia_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (pre_existing_cystidia_id, owner_id, 7.5, 3.5, 'cheilocystidia');

  INSERT INTO public.observation_images (observation_id, user_id, storage_path, image_type, metadata_purpose)
  VALUES (obs_hidden_spore, owner_id, NULL, 'microscope', NULL)
  RETURNING id INTO pre_existing_hidden_spore_qualifying_id;
  INSERT INTO public.spore_measurements (image_id, user_id, length_um, width_um, measurement_type)
  VALUES (pre_existing_hidden_spore_qualifying_id, owner_id, 7.5, 3.5, 'manual');

  -- This predicate must be kept byte-for-byte in sync with the UPDATE in
  -- 20260925120000_owner_sync_metadata_parents.sql.
  UPDATE public.observation_images i
  SET metadata_purpose = 'public_microscopy'
  WHERE i.id IN (
      pre_existing_qualifying_id,
      pre_existing_cystidia_id,
      pre_existing_hidden_spore_qualifying_id
    )
    AND i.storage_path IS NULL
    AND i.image_type = 'microscope'
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.spore_measurements m
      WHERE m.image_id = i.id
        AND m.length_um IS NOT NULL
        AND m.width_um IS NOT NULL
        AND public.is_public_microscopy_measurement_type(m.measurement_type)
    );

  IF (SELECT metadata_purpose FROM public.observation_images WHERE id = pre_existing_qualifying_id) IS DISTINCT FROM 'public_microscopy' THEN
    RAISE EXCEPTION 'T29: backfill should have marked the qualifying pre-existing row public_microscopy';
  END IF;
  IF (SELECT metadata_purpose FROM public.observation_images WHERE id = pre_existing_cystidia_id) IS DISTINCT FROM NULL THEN
    RAISE EXCEPTION 'T30: backfill should have left the cheilocystidia-only pre-existing row NULL';
  END IF;
  IF (SELECT metadata_purpose FROM public.observation_images WHERE id = pre_existing_hidden_spore_qualifying_id) IS DISTINCT FROM 'public_microscopy' THEN
    RAISE EXCEPTION 'T30B: backfill should mark a qualifying row on a non-public-spore-visibility observation too (visibility is a read-time check, not a backfill-eligibility check)';
  END IF;
  IF public.metadata_microscope_parent_is_public(pre_existing_hidden_spore_qualifying_id) THEN
    RAISE EXCEPTION 'T30C: metadata_microscope_parent_is_public must still deny a public_microscopy-marked row whose observation has spore_data_visibility <> public';
  END IF;

  --------------------------------------------------------------------------
  -- RLS: a non-owner cannot set/update metadata_purpose on someone else's
  -- observation_images row.
  --------------------------------------------------------------------------

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', other_id::text, 'role', 'authenticated')::text,
    true);

  UPDATE public.observation_images
  SET metadata_purpose = 'public_microscopy'
  WHERE id = img_owner_sync;
  GET DIAGNOSTICS upd_count = ROW_COUNT;
  IF upd_count IS DISTINCT FROM 0 THEN
    RESET ROLE;
    RAISE EXCEPTION 'T31: non-owner update of metadata_purpose affected % rows (expected 0)', upd_count;
  END IF;

  BEGIN
    INSERT INTO public.observation_images (
      observation_id, user_id, storage_path, image_type, metadata_purpose
    )
    VALUES (obs_public, other_id, NULL, 'microscope', 'public_microscopy');
    RESET ROLE;
    RAISE EXCEPTION 'T32: non-owner unexpectedly inserted a metadata_purpose row into another user''s observation';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  RESET ROLE;

  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility SET NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision SET NOT NULL';

  RAISE NOTICE 'owner_sync_metadata_parents_test passed';
END
$$;

ROLLBACK;
