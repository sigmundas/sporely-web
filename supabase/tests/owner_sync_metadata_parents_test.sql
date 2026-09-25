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
--
-- Run after local migrations:
--   supabase db query --local -f supabase/tests/owner_sync_metadata_parents_test.sql
--
-- Wrapped in BEGIN/ROLLBACK (rather than manual DELETE cleanup) because
-- deleting the fixture auth.users rows cascades into an unrelated
-- anonymize-on-delete trigger (private.anonymize_shared_reference_
-- contributions_for_profile) that some roles lack grants for; rolling back
-- avoids depending on that trigger's grants entirely.

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
  rpc_row         record;
  n               bigint;
  upd_count       integer;
  pre_existing_qualifying_id bigint;
  pre_existing_cystidia_id   bigint;
BEGIN
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN visibility DROP NOT NULL';
  EXECUTE 'ALTER TABLE public.observations ALTER COLUMN location_precision DROP NOT NULL';

  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (owner_id, 'authenticated', 'authenticated', 'owner-sync-owner@example.test', '{}'::jsonb, now(), now()),
    (other_id, 'authenticated', 'authenticated', 'owner-sync-other@example.test', '{}'::jsonb, now(), now());

  INSERT INTO public.profiles (id, username, display_name, is_banned)
  VALUES
    (owner_id, 'owner_sync_owner', 'Owner Sync Owner', false),
    (other_id, 'owner_sync_other', 'Owner Sync Other', false)
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
  -- Backfill semantics: simulate two pre-existing (pre-migration-shaped)
  -- rows directly, bypassing the CHECK by inserting with metadata_purpose
  -- NULL (as any pre-migration row necessarily has), then re-run the exact
  -- backfill predicate and confirm the expected classification.
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

  UPDATE public.observation_images i
  SET metadata_purpose = 'public_microscopy'
  WHERE i.id IN (pre_existing_qualifying_id, pre_existing_cystidia_id)
    AND i.storage_path IS NULL
    AND i.image_type = 'microscope'
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.observations o
      WHERE o.id = i.observation_id AND o.spore_data_visibility = 'public'
    )
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
