-- Reported-statistics Stage 3D: observation-reference snapshot version 2
-- (sporely-py docs/reference-data/measurement-content-contract.md section 7).
--
-- Covers the version-keyed validator in both directions, the canonical
-- builder's emit rule, the public projection preserving the extension instead
-- of intersecting it away, that a legacy row's version-1 snapshot is
-- unchanged, and that an unaware client cannot freeze a version-1 projection
-- of an enhanced row as evidence. The transaction is always rolled back.
--
-- The owner graph is built through the public RPCs as `authenticated`. The
-- `private` builders and validators are revoked from that role, so they are
-- inspected as the schema owner in the middle phase, which hands the computed
-- snapshots to the final `authenticated` phase through a scratch table that
-- the rollback removes.
--
-- Run after local migrations, with psql (the CLI's `db query --file` cannot
-- execute a multi-statement script):
--   docker exec -i supabase_db_<ref> psql -v ON_ERROR_STOP=1 -U postgres \
--     -d postgres < supabase/tests/reference_snapshot_v2_test.sql

BEGIN;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000a3d1';
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (owner_a, 'authenticated', 'authenticated', 'reference-3d@example.invalid', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username) VALUES (owner_a, 'reference_owner_3d')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES (940003001, owner_a, current_date, 'private', false)
  ON CONFLICT (id) DO NOTHING;
END
$$;

CREATE TABLE public.stage3d_scratch (name text PRIMARY KEY, value jsonb NOT NULL);
GRANT SELECT ON public.stage3d_scratch TO authenticated;

SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-4000-8000-00000000a3d1","role":"authenticated"}';

-- Phase 1: build the owner graph through the public RPCs only.
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  work_id constant uuid := '14000000-0000-4000-8000-000000000001';
  treatment_id constant uuid := '24000000-0000-4000-8000-000000000001';
  legacy_id constant uuid := '34000000-0000-4000-8000-00000000d001';
  enhanced_id constant uuid := '34000000-0000-4000-8000-00000000d002';
  future_id constant uuid := '34000000-0000-4000-8000-00000000d003';
  result jsonb;
  details jsonb;
  future jsonb;
BEGIN
  result := public.sync_reference_work(jsonb_build_object(
    'id', work_id, 'type', 'book', 'title', 'Hebeloma source', 'short_label', 'Author 2026',
    'authors_json', '[{"family":"Author"}]'::jsonb, 'year', 2026, 'revision', 1), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'work create failed: %', result; END IF;
  result := public.sync_reference_taxon_treatment(jsonb_build_object(
    'id', treatment_id, 'reference_work_id', work_id, 'name_as_published', 'Hebeloma fixtura',
    'revision', 1), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'treatment create failed: %', result; END IF;

  details := jsonb_build_object(
    'schema_version', 1,
    'metrics', jsonb_build_object(
      'length', jsonb_build_object(
        'outer_range', jsonb_build_object('kind', 'reported_extremes'),
        'core_range', jsonb_build_object('kind', 'percentile_interval',
                                         'percentile_bounds', jsonb_build_array(5, 95)),
        'sd', jsonb_build_object('value', 0.696))));
  future := '{"schema_version": 7, "metrics": {"length": {"unknown_future_key": 1}}}'::jsonb;

  result := public.sync_reference_measurement_set(jsonb_build_object(
    'id', legacy_id, 'taxon_treatment_id', treatment_id, 'character', 'spore_size',
    'data_kind', 'range', 'raw_text', '8.5-12.5 x 4.5-5.5', 'length_min', 8.5,
    'length_max', 12.5, 'width_min', 4.5, 'width_max', 5.5, 'revision', 1,
    'measurement_details_json', NULL, 'q_core_min', NULL, 'q_core_max', NULL), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'legacy create failed: %', result; END IF;

  result := public.sync_reference_measurement_set(jsonb_build_object(
    'id', enhanced_id, 'taxon_treatment_id', treatment_id, 'character', 'spore_size',
    'data_kind', 'range', 'raw_text', '(6.9) 8.0-15.2 (16.1)', 'length_min', 6.9,
    'length_core_min', 8.0, 'length_core_max', 15.2, 'length_max', 16.1,
    'q_min', 1.17, 'q_max', 2.79, 'revision', 1,
    'measurement_details_json', details, 'q_core_min', 1.36, 'q_core_max', 2.19), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'enhanced create failed: %', result; END IF;

  -- Enhanced through an unsupported future details version, with no q_core pair.
  result := public.sync_reference_measurement_set(jsonb_build_object(
    'id', future_id, 'taxon_treatment_id', treatment_id, 'character', 'spore_size',
    'data_kind', 'range', 'raw_text', 'future', 'revision', 1,
    'measurement_details_json', future, 'q_core_min', NULL, 'q_core_max', NULL), 0);
  IF result->>'status' <> 'created' THEN RAISE EXCEPTION 'future create failed: %', result; END IF;
END
$$;

-- Phase 2: inspect the private builders and validators as the schema owner.
RESET ROLE;

DO $$
DECLARE
  owner_a constant uuid := '00000000-0000-4000-8000-00000000a3d1';
  work_id constant uuid := '14000000-0000-4000-8000-000000000001';
  treatment_id constant uuid := '24000000-0000-4000-8000-000000000001';
  legacy_id constant uuid := '34000000-0000-4000-8000-00000000d001';
  enhanced_id constant uuid := '34000000-0000-4000-8000-00000000d002';
  future_id constant uuid := '34000000-0000-4000-8000-00000000d003';
  details jsonb;
  future jsonb;
  legacy_snapshot jsonb;
  enhanced_snapshot jsonb;
  future_snapshot jsonb;
  downgraded jsonb;
  projected jsonb;
  oversized jsonb;
BEGIN
  details := jsonb_build_object(
    'schema_version', 1,
    'metrics', jsonb_build_object(
      'length', jsonb_build_object(
        'outer_range', jsonb_build_object('kind', 'reported_extremes'),
        'core_range', jsonb_build_object('kind', 'percentile_interval',
                                         'percentile_bounds', jsonb_build_array(5, 95)),
        'sd', jsonb_build_object('value', 0.696))));
  future := '{"schema_version": 7, "metrics": {"length": {"unknown_future_key": 1}}}'::jsonb;

  -- 1. The emit rule follows the row, not a setting.
  legacy_snapshot := private.reference_canonical_snapshot(owner_a, legacy_id);
  enhanced_snapshot := private.reference_canonical_snapshot(owner_a, enhanced_id);
  future_snapshot := private.reference_canonical_snapshot(owner_a, future_id);
  IF legacy_snapshot->>'schema_version' <> '1' THEN
    RAISE EXCEPTION 'legacy row must still emit version 1: %', legacy_snapshot;
  END IF;
  IF legacy_snapshot ? 'measurement_details'
     OR (legacy_snapshot->'measurements') ?| ARRAY['q_core_min','q_core_max'] THEN
    RAISE EXCEPTION 'legacy snapshot gained version-2 keys: %', legacy_snapshot;
  END IF;
  IF enhanced_snapshot->>'schema_version' <> '2'
     OR enhanced_snapshot->'measurement_details' <> details
     OR (enhanced_snapshot->'measurements'->>'q_core_min')::numeric <> 1.36
     OR (enhanced_snapshot->'measurements'->>'q_core_max')::numeric <> 2.19 THEN
    RAISE EXCEPTION 'enhanced row must emit version 2 with the extension: %', enhanced_snapshot;
  END IF;
  -- The details object sits outside the numeric-only measurements mapping.
  IF EXISTS (
    SELECT 1 FROM jsonb_each(enhanced_snapshot->'measurements') x
     WHERE jsonb_typeof(x.value) NOT IN ('number','null')
  ) THEN
    RAISE EXCEPTION 'measurements must stay numeric-or-null: %', enhanced_snapshot;
  END IF;
  -- A future details version travels unchanged and is never reinterpreted; a
  -- row enhanced only by its details still carries both q_core keys, as null.
  IF future_snapshot->>'schema_version' <> '2'
     OR future_snapshot->'measurement_details' <> future THEN
    RAISE EXCEPTION 'a future details version must survive unchanged: %', future_snapshot;
  END IF;
  IF NOT (future_snapshot->'measurements') ?& ARRAY['q_core_min','q_core_max']
     OR jsonb_typeof(future_snapshot->'measurements'->'q_core_min') <> 'null' THEN
    RAISE EXCEPTION 'a version-2 snapshot must always carry both q_core keys: %', future_snapshot;
  END IF;

  -- 2. The validator is version-keyed in both directions.
  IF private.reference_snapshot_valid(legacy_snapshot, work_id, treatment_id, legacy_id, 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'the canonical version-1 snapshot must validate';
  END IF;
  IF private.reference_snapshot_valid(enhanced_snapshot, work_id, treatment_id, enhanced_id, 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'the canonical version-2 snapshot must validate';
  END IF;
  IF private.reference_snapshot_valid(future_snapshot, work_id, treatment_id, future_id, 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'an opaque future details version must still validate';
  END IF;
  IF private.reference_snapshot_valid(
       legacy_snapshot || jsonb_build_object('measurement_details', 'null'::jsonb),
       work_id, treatment_id, legacy_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'a version-1 snapshot must not carry the version-2 key';
  END IF;
  IF private.reference_snapshot_valid(
       jsonb_set(legacy_snapshot, '{measurements,q_core_min}', '1.4'::jsonb),
       work_id, treatment_id, legacy_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'a version-1 snapshot must not carry version-2 measurement keys';
  END IF;
  IF private.reference_snapshot_valid(
       enhanced_snapshot - 'measurement_details', work_id, treatment_id, enhanced_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'a version-2 snapshot must carry measurement_details';
  END IF;
  IF private.reference_snapshot_valid(
       jsonb_set(enhanced_snapshot, '{measurements}',
                 (enhanced_snapshot->'measurements') - 'q_core_min'),
       work_id, treatment_id, enhanced_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'a version-2 snapshot must carry both q_core keys';
  END IF;
  IF private.reference_snapshot_valid(
       jsonb_set(enhanced_snapshot, '{schema_version}', '3'::jsonb),
       work_id, treatment_id, enhanced_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'an unsupported snapshot version must never validate';
  END IF;
  IF private.reference_snapshot_valid(
       jsonb_set(enhanced_snapshot, '{measurement_details}', '"text"'::jsonb),
       work_id, treatment_id, enhanced_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'measurement_details must be an object or null';
  END IF;
  IF private.reference_snapshot_valid(
       jsonb_set(enhanced_snapshot, '{measurement_details}',
                 '{"schema_version": 1, "metrics": {"length": {"sd": {"value": -1}}}}'::jsonb),
       work_id, treatment_id, enhanced_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'an invalid version-1 details object must be rejected';
  END IF;
  IF private.reference_snapshot_valid(
       jsonb_set(enhanced_snapshot, '{measurement_details}', 'null'::jsonb),
       work_id, treatment_id, enhanced_id, 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'a version-2 snapshot with a null details object is valid';
  END IF;
  oversized := jsonb_build_object('schema_version', 7, 'padding', repeat('x', 5000));
  IF private.reference_snapshot_valid(
       jsonb_set(enhanced_snapshot, '{measurement_details}', oversized),
       work_id, treatment_id, enhanced_id, 1) IS TRUE THEN
    RAISE EXCEPTION 'details beyond 4096 canonical bytes must be rejected';
  END IF;

  -- 3. The public projection preserves the extension and never invents one.
  projected := private.public_reference_snapshot(enhanced_snapshot, enhanced_id, 1);
  IF projected IS NULL
     OR projected->'measurement_details' <> details
     OR (projected->'measurements'->>'q_core_min')::numeric <> 1.36 THEN
    RAISE EXCEPTION 'the public projection dropped the extension: %', projected;
  END IF;
  IF projected <> enhanced_snapshot THEN
    RAISE EXCEPTION 'a canonical version-2 snapshot must round-trip the projection: %', projected;
  END IF;
  projected := private.public_reference_snapshot(legacy_snapshot, legacy_id, 1);
  IF projected IS NULL OR projected ? 'measurement_details'
     OR projected <> legacy_snapshot THEN
    RAISE EXCEPTION 'the version-1 projection must be unchanged: %', projected;
  END IF;

  -- A version-1 projection of an enhanced row is a well-formed version-1
  -- snapshot by construction, so only equality with the canonical snapshot
  -- can reject it as frozen evidence. Phase 3 proves that it does.
  downgraded := (enhanced_snapshot - 'measurement_details')
    || jsonb_build_object('schema_version', 1)
    || jsonb_build_object('measurements',
         (enhanced_snapshot->'measurements') - 'q_core_min' - 'q_core_max');
  IF private.reference_snapshot_valid(downgraded, work_id, treatment_id, enhanced_id, 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'the downgraded snapshot is a well-formed version 1 by construction';
  END IF;

  INSERT INTO public.stage3d_scratch(name, value) VALUES
    ('enhanced', enhanced_snapshot), ('downgraded', downgraded);
END
$$;

-- Phase 3: the attachment RPC as the owner role.
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  observation_id constant bigint := 940003001;
  enhanced_id constant uuid := '34000000-0000-4000-8000-00000000d002';
  use_id constant uuid := '44000000-0000-4000-8000-00000000d001';
  enhanced_snapshot jsonb;
  downgraded jsonb;
  result jsonb;
BEGIN
  SELECT value INTO enhanced_snapshot FROM public.stage3d_scratch WHERE name = 'enhanced';
  SELECT value INTO downgraded FROM public.stage3d_scratch WHERE name = 'downgraded';

  result := public.sync_observation_reference_use(jsonb_build_object(
    'id', use_id, 'observation_id', observation_id,
    'reference_measurement_set_id', enhanced_id,
    'role', 'compared', 'reference_revision', 1,
    'snapshot_json', downgraded), 0);
  IF result->>'status' <> 'invalid_snapshot' THEN
    RAISE EXCEPTION 'a version-1 projection of an enhanced row must not be frozen: %', result;
  END IF;

  result := public.sync_observation_reference_use(jsonb_build_object(
    'id', use_id, 'observation_id', observation_id,
    'reference_measurement_set_id', enhanced_id,
    'role', 'compared', 'reference_revision', 1,
    'snapshot_json', enhanced_snapshot), 0);
  IF result->>'status' <> 'created' THEN
    RAISE EXCEPTION 'the canonical version-2 snapshot must be attachable: %', result;
  END IF;
  IF (result->'row'->'snapshot_json')->>'schema_version' <> '2'
     OR (result->'row'->'snapshot_json')->'measurement_details' IS NULL THEN
    RAISE EXCEPTION 'the stored evidence must be the version-2 snapshot: %', result;
  END IF;

  RAISE NOTICE 'reference snapshot v2 checks passed';
END
$$;

ROLLBACK;
