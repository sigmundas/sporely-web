-- Reported-statistics Stage 3C: measurement-content extension contract on the
-- owner-private normalized reference library (sporely-py
-- docs/reference-data/measurement-content-contract.md section 9, section 12
-- cases 16 and 17). The transaction is always rolled back.
-- Run after local migrations:
--   supabase db query --local --file supabase/tests/reference_measurement_content_extension_test.sql

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000a3c1';
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (owner_a, 'authenticated', 'authenticated', 'reference-3c@example.invalid', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username) VALUES (owner_a, 'reference_owner_3c')
  ON CONFLICT (id) DO NOTHING;
END
$$;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000a3c1","role":"authenticated"}';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  work_id constant uuid := '13000000-0000-4000-8000-000000000001';
  treatment_id constant uuid := '23000000-0000-4000-8000-000000000001';
  legacy_id constant uuid := '33000000-0000-4000-8000-00000000c001';
  enhanced_id constant uuid := '33000000-0000-4000-8000-00000000c002';
  successor_id constant uuid := '33000000-0000-4000-8000-00000000c003';
  successor_2_id constant uuid := '33000000-0000-4000-8000-00000000c004';
  twin_id constant uuid := '33000000-0000-4000-8000-00000000c005';
  future_id constant uuid := '33000000-0000-4000-8000-00000000c006';
  partial_id constant uuid := '33000000-0000-4000-8000-00000000c007';
  invalid_id constant uuid := '33000000-0000-4000-8000-00000000c008';
  extension_keys constant text[] := ARRAY['measurement_details_json','q_core_min','q_core_max'];
  result jsonb;
  stored jsonb;
  details jsonb;
  future jsonb;
  base jsonb;
  enhanced jsonb;
  candidate jsonb;
  snapshot_enhanced jsonb;
  snapshot_twin jsonb;
  bad_details jsonb;
  rejections jsonb[];
  case_index integer;
BEGIN
  result := public.sync_reference_work(jsonb_build_object(
    'id', work_id, 'type', 'book', 'title', 'Hebeloma source', 'short_label', 'Author 2026',
    'authors_json', '[{"family":"Author"}]'::jsonb, 'year', 2026, 'revision', 1), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'work create failed: %', result; END IF;
  result := public.sync_reference_taxon_treatment(jsonb_build_object(
    'id', treatment_id, 'reference_work_id', work_id, 'name_as_published', 'Hebeloma fixtura',
    'revision', 1), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'treatment create failed: %', result; END IF;

  -- The plan's Hebeloma table as a version-1 details object (fixture
  -- tests/fixtures/reference_statistics/row_enhanced.json in sporely-py).
  details := '{"schema_version":1,"metrics":{
    "length":{"outer_range":{"kind":"reported_extremes"},
              "core_range":{"kind":"percentile_interval","percentile_bounds":[5,95]},
              "mean_interval":{"lower":8.9,"upper":13.7,"kind":"reported_range"},
              "median":{"lower":9.0,"upper":13.9,"kind":"reported_range"},
              "sd":{"value":0.696}},
    "width":{"outer_range":{"kind":"reported_extremes"},
             "core_range":{"kind":"percentile_interval","percentile_bounds":[5,95]},
             "mean_interval":{"lower":5.6,"upper":7.5,"kind":"reported_range"},
             "median":{"lower":5.6,"upper":7.5,"kind":"reported_range"},
             "sd":{"value":0.323}},
    "q":{"outer_range":{"kind":"reported_extremes"},
         "core_range":{"kind":"percentile_interval","percentile_bounds":[5,95]},
         "mean_interval":{"lower":1.51,"upper":1.96,"kind":"reported_range"},
         "median":{"lower":1.5,"upper":1.95,"kind":"reported_range"},
         "sd":{"value":0.097}}}}'::jsonb;
  -- The ordinary columns every desktop writer sends (raw_points_json is
  -- omitted on create, exactly as the desktop adapter does today).
  base := jsonb_build_object(
    'taxon_treatment_id', treatment_id, 'character', 'spore_size', 'data_kind', 'range',
    'raw_text', 'Hebeloma table',
    'length_min', 6.9, 'length_core_min', 8.0, 'length_core_max', 15.2, 'length_max', 16.1,
    'width_min', 4.1, 'width_core_min', 5.1, 'width_core_max', 8.2, 'width_max', 8.9,
    'q_min', 1.17, 'q_max', 2.79, 'q_mean', null, 'length_mean', null, 'width_mean', null,
    'sample_size', null, 'specimen_count', null, 'mount_medium', null, 'stain', null,
    'preparation', null, 'measurement_method', null, 'notes', null, 'supersedes_id', null,
    'revision', 1);
  enhanced := base || jsonb_build_object(
    'measurement_details_json', details, 'q_core_min', 1.36, 'q_core_max', 2.19);

  -- 1. An unaware create without a predecessor is still accepted (legacy row),
  --    and the authoritative row acknowledges the contract with all three keys.
  result := public.sync_reference_measurement_set(base || jsonb_build_object('id', legacy_id), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'legacy create failed: %', result; END IF;
  IF NOT (result->'row' ?& extension_keys)
     OR jsonb_typeof(result->'row'->'measurement_details_json') <> 'null'
     OR jsonb_typeof(result->'row'->'q_core_min') <> 'null' THEN
    RAISE EXCEPTION 'legacy row does not carry NULL extension keys: %', result->'row';
  END IF;

  -- 2. Partial acknowledgement is rejected before anything else, with and
  --    without a destination row (section 12 case 17).
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', partial_id, 'q_core_min', 1.36, 'q_core_max', 2.19), 0);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'partial create accepted: %', result; END IF;
  IF EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE id = partial_id) THEN
    RAISE EXCEPTION 'partial create wrote a row';
  END IF;
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', legacy_id, 'measurement_details_json', details, 'revision', 2), 1);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'partial update accepted: %', result; END IF;
  SELECT to_jsonb(m) INTO stored FROM public.reference_measurement_sets m WHERE m.id = legacy_id;
  IF (stored->>'row_version')::bigint <> 1 OR stored->'measurement_details_json' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'partial update changed the row: %', stored;
  END IF;

  -- 3. An aware create stores the extension exactly; the exact retry is a no-op.
  result := public.sync_reference_measurement_set(enhanced || jsonb_build_object('id', enhanced_id), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'enhanced create failed: %', result; END IF;
  IF result->'row'->'measurement_details_json' <> details
     OR (result->'row'->>'q_core_min')::double precision <> 1.36
     OR (result->'row'->>'q_core_max')::double precision <> 2.19 THEN
    RAISE EXCEPTION 'enhanced row was not stored as sent: %', result->'row';
  END IF;
  result := public.sync_reference_measurement_set(enhanced || jsonb_build_object('id', enhanced_id), 0);
  IF result->>'status' <> 'no_change' THEN RAISE EXCEPTION 'aware exact retry was not a no-op: %', result; END IF;

  -- 4. Unaware requests against the enhanced row (section 9 items 3 and 5).
  --    An exact unaware retry keeps no_change.
  result := public.sync_reference_measurement_set(base || jsonb_build_object('id', enhanced_id), 1);
  IF result->>'status' <> 'no_change' THEN RAISE EXCEPTION 'unaware exact retry was not a no-op: %', result; END IF;
  --    An unaware content mutation is rejected and nothing is written.
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', enhanced_id, 'length_max', 17.0, 'revision', 2), 1);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'unaware content mutation accepted: %', result; END IF;
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', enhanced_id, 'notes', 'private note', 'revision', 2), 1);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'unaware notes mutation accepted: %', result; END IF;
  SELECT to_jsonb(m) INTO stored FROM public.reference_measurement_sets m WHERE m.id = enhanced_id;
  IF (stored->>'row_version')::bigint <> 1 OR (stored->>'length_max')::double precision <> 16.1
     OR stored->'measurement_details_json' <> details THEN
    RAISE EXCEPTION 'rejected unaware mutation changed the row: %', stored;
  END IF;
  --    The unaware tombstone and an unaware restore are lifecycle operations.
  --    (The parent id accompanies the tombstone as in reference_library_mutation_test;
  --    the RPC's pre-existing parent check precedes every content rule.)
  result := public.sync_reference_measurement_set(
    jsonb_build_object('id', enhanced_id, 'taxon_treatment_id', treatment_id, 'deleted', true), 1);
  IF result->>'status' <> 'updated' OR result->'row'->>'deleted_at' IS NULL
     OR result->'row'->'measurement_details_json' <> details THEN
    RAISE EXCEPTION 'unaware tombstone of enhanced row failed: %', result;
  END IF;
  result := public.sync_reference_measurement_set(base || jsonb_build_object('id', enhanced_id, 'deleted', false), 2);
  IF result->>'status' <> 'updated' OR result->'row'->>'deleted_at' IS NOT NULL
     OR result->'row'->'measurement_details_json' <> details
     OR (result->'row'->>'q_core_min')::double precision <> 1.36 THEN
    RAISE EXCEPTION 'unaware restore of enhanced row failed or stripped content: %', result;
  END IF;
  --    A lifecycle request cannot smuggle content past the guard.
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', enhanced_id, 'length_max', 17.0, 'revision', 2, 'deleted', true), 3);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'tombstone with content change bypassed the guard: %', result; END IF;

  -- 5. Successor creation (section 9 item 4).
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', successor_id, 'supersedes_id', enhanced_id, 'revision', 2), 0);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'unaware successor of enhanced predecessor accepted: %', result; END IF;
  IF EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE id = successor_id) THEN
    RAISE EXCEPTION 'rejected successor wrote a row';
  END IF;
  result := public.sync_reference_measurement_set(
    enhanced || jsonb_build_object('id', successor_id, 'supersedes_id', enhanced_id, 'revision', 2), 0);
  IF result->>'status' <> 'created' OR result->'row'->'measurement_details_json' <> details THEN
    RAISE EXCEPTION 'aware successor of enhanced predecessor failed: %', result;
  END IF;
  --    An unaware successor of a legacy predecessor is still accepted.
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', successor_2_id, 'supersedes_id', legacy_id, 'revision', 2), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'unaware successor of legacy predecessor failed: %', result; END IF;

  -- 6. Explicit JSON null clears (section 9 item 6); the row is legacy again
  --    and an unaware content mutation is accepted afterwards.
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', enhanced_id, 'revision', 2,
      'measurement_details_json', null, 'q_core_min', null, 'q_core_max', null), 3);
  IF result->>'status' <> 'updated' OR jsonb_typeof(result->'row'->'measurement_details_json') <> 'null'
     OR jsonb_typeof(result->'row'->'q_core_min') <> 'null' OR jsonb_typeof(result->'row'->'q_core_max') <> 'null' THEN
    RAISE EXCEPTION 'explicit null did not clear the extension: %', result;
  END IF;
  SELECT to_jsonb(m) INTO stored FROM public.reference_measurement_sets m WHERE m.id = enhanced_id;
  IF stored->'measurement_details_json' <> 'null'::jsonb OR stored->'q_core_min' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'cleared extension is not SQL NULL: %', stored;
  END IF;
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', enhanced_id, 'length_max', 17.0, 'revision', 3), 4);
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'unaware mutation of a cleared row was rejected: %', result; END IF;
  --    Re-enhance through an aware update (all keys, bumped revision).
  result := public.sync_reference_measurement_set(
    enhanced || jsonb_build_object('id', enhanced_id, 'revision', 4), 5);
  IF result->>'status' <> 'updated' OR result->'row'->'measurement_details_json' <> details THEN
    RAISE EXCEPTION 'aware re-enhancement failed: %', result;
  END IF;

  -- 7. A future details version survives opaquely (authoritative mode).
  future := '{"schema_version":2,"metrics":{"length":{"core_range":{"kind":"percentile_interval","percentile_bounds":[5,95]},"population":{"kind":"specimen_means","n":12}}},"provenance":{"basis":"verbatim"}}'::jsonb;
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', future_id, 'measurement_details_json', future, 'q_core_min', null, 'q_core_max', null), 0);
  IF result->>'status' <> 'created' OR result->'row'->'measurement_details_json' <> future THEN
    RAISE EXCEPTION 'future-version details were not stored opaquely: %', result;
  END IF;

  -- 8. Row-level validation rejections on create (section 9 item 7). Each
  --    candidate is the complete enhanced row with one rule broken.
  rejections := ARRAY[
    -- rule 4: mean interval with a scalar mean
    enhanced || jsonb_build_object('length_mean', 11.0),
    -- rule 2: core descriptor without its core pair
    enhanced || jsonb_build_object('width_core_min', null),
    -- rule 3: extremes do not enclose the core pair
    enhanced || jsonb_build_object('length_min', 8.5),
    -- ordered pairs, positivity and finiteness apply to every numeric column
    enhanced || jsonb_build_object('q_core_min', 2.5),
    enhanced || jsonb_build_object('q_core_min', -1.36),
    enhanced || jsonb_build_object('q_core_min', 'NaN'),
    base || jsonb_build_object('length_min', 10.0, 'length_max', 9.0,
      'measurement_details_json', null, 'q_core_min', null, 'q_core_max', null),
    -- schema_version must be an integer number
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{schema_version}', '"1"')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{schema_version}', '1.5')),
    -- structure: unknown top-level key, unknown metric, unknown metric key,
    -- empty metric object, wrong descriptor enum, bounds on a non-percentile
    -- kind, inverted percentile bounds, negative sd, boolean as number,
    -- median mixing scalar and interval keys, array instead of object
    enhanced || jsonb_build_object('measurement_details_json', details || '{"notes":"x"}'::jsonb),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,volume}', '{"sd":{"value":1}}')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,basis}', '"x"')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length}', '{}')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,outer_range,kind}', '"typical_range"')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,outer_range}', '{"kind":"reported_extremes","percentile_bounds":[5,95]}')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,core_range,percentile_bounds}', '[95,5]')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,sd,value}', '-0.1')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,sd,value}', 'true')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,median}', '{"value":9.5,"lower":9.0,"upper":13.9,"kind":"reported_range"}')),
    enhanced || jsonb_build_object('measurement_details_json', jsonb_set(details, '{metrics,length,mean_interval}', '{"lower":13.7,"upper":8.9,"kind":"reported_range"}')),
    enhanced || jsonb_build_object('measurement_details_json', '[1,2]'::jsonb),
    -- size: a future-version object above the 4096-byte canonical limit
    enhanced || jsonb_build_object('measurement_details_json',
      jsonb_build_object('schema_version', 2, 'blob', repeat('x', 4200)))
  ];
  case_index := 0;
  FOREACH candidate IN ARRAY rejections LOOP
    case_index := case_index + 1;
    result := public.sync_reference_measurement_set(candidate || jsonb_build_object('id', invalid_id), 0);
    IF result->>'status' <> 'invalid_payload' THEN
      RAISE EXCEPTION 'validation case % was accepted: % (payload %)', case_index, result, candidate;
    END IF;
    IF EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE id = invalid_id) THEN
      RAISE EXCEPTION 'validation case % wrote a row', case_index;
    END IF;
  END LOOP;
  --    The same rules apply to an update of the complete candidate row.
  result := public.sync_reference_measurement_set(
    enhanced || jsonb_build_object('id', enhanced_id, 'length_mean', 11.0, 'revision', 5), 6);
  IF result->>'status' <> 'invalid_payload' THEN RAISE EXCEPTION 'invalid aware update accepted: %', result; END IF;
  SELECT to_jsonb(m) INTO stored FROM public.reference_measurement_sets m WHERE m.id = enhanced_id;
  IF (stored->>'row_version')::bigint <> 6 OR stored->'length_mean' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'rejected aware update changed the row: %', stored;
  END IF;
  --    Clearing the interval first, then setting the scalar mean, is valid.
  result := public.sync_reference_measurement_set(
    enhanced || jsonb_build_object('id', enhanced_id, 'length_mean', 11.0, 'revision', 5,
      'measurement_details_json', details #- '{metrics,length,mean_interval}'), 6);
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'valid aware update rejected: %', result; END IF;
  result := public.sync_reference_measurement_set(
    enhanced || jsonb_build_object('id', enhanced_id, 'revision', 6), 7);
  IF result->>'status' <> 'updated' THEN RAISE EXCEPTION 'restoring the fixture content failed: %', result; END IF;

  -- 9. A legacy twin of the enhanced row (same ordinary columns) for the
  --    snapshot comparison below.
  result := public.sync_reference_measurement_set(
    base || jsonb_build_object('id', twin_id, 'revision', 6), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'twin create failed: %', result; END IF;
END
$$;

RESET ROLE;

-- Existing version-1 snapshot builders are unaffected by rows that carry the
-- extension: the canonical snapshot of the enhanced row equals the snapshot of
-- its legacy twin, stays schema_version 1, exposes no extension key and
-- validates as before. The private validators stay unreachable for end users.
DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000a3c1';
  work_id constant uuid := '13000000-0000-4000-8000-000000000001';
  treatment_id constant uuid := '23000000-0000-4000-8000-000000000001';
  enhanced_id constant uuid := '33000000-0000-4000-8000-00000000c002';
  twin_id constant uuid := '33000000-0000-4000-8000-00000000c005';
  snapshot_enhanced jsonb;
  snapshot_twin jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.reference_measurement_sets
                 WHERE user_id = owner_a AND id = enhanced_id AND measurement_details_json IS NOT NULL) THEN
    RAISE EXCEPTION 'enhanced fixture row is missing';
  END IF;
  snapshot_enhanced := private.reference_canonical_snapshot(owner_a, enhanced_id);
  snapshot_twin := private.reference_canonical_snapshot(owner_a, twin_id);
  IF snapshot_enhanced IS NULL OR (snapshot_enhanced->>'schema_version') <> '1'
     OR snapshot_enhanced ? 'measurement_details'
     OR snapshot_enhanced->'measurements' ? 'q_core_min'
     OR (snapshot_enhanced - 'reference_measurement_set_id') IS DISTINCT FROM (snapshot_twin - 'reference_measurement_set_id') THEN
    RAISE EXCEPTION 'v1 canonical snapshot changed for an enhanced row: % vs %', snapshot_enhanced, snapshot_twin;
  END IF;
  IF NOT private.reference_snapshot_valid(snapshot_enhanced, work_id, treatment_id, enhanced_id, 6) THEN
    RAISE EXCEPTION 'v1 snapshot of an enhanced row no longer validates: %', snapshot_enhanced;
  END IF;
  IF has_function_privilege('authenticated',
       'private.reference_measurement_content_valid(public.reference_measurement_sets)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.reference_measurement_details_valid(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'validator functions are executable by end-user roles';
  END IF;
END
$$;

-- The table CHECK is only defence in depth: a raw privileged write of a
-- non-object details value is refused even when the RPC is bypassed.
DO $$
BEGIN
  BEGIN
    UPDATE public.reference_measurement_sets SET measurement_details_json = '[1]'::jsonb
    WHERE id = '33000000-0000-4000-8000-00000000c002';
    RAISE EXCEPTION 'details shape CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$$;

ROLLBACK;
