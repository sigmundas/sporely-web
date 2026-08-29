-- Published bundles, copied taxon assignments, and audit events are append-only.

BEGIN;

DO $$
DECLARE
  actor_id constant uuid := '00000000-0000-4000-8000-000000006a02';
  taxon_id constant integer := 2100000010;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (actor_id, 'authenticated', 'authenticated', 'stage6a-immutable@example.invalid', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username)
  VALUES (actor_id, 'stage6a_immutable') ON CONFLICT (id) DO NOTHING;
  INSERT INTO taxonomy_v3.registry_concept
    (sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release)
  VALUES
    (taxon_id, 'Immutable species', 'species', 'include', 'in_cache', 'stage6a-test'),
    (2100000011, 'Null-rank immutable species', NULL, 'include', 'in_cache', 'stage6a-test')
  ON CONFLICT (sporely_taxon_id) DO NOTHING;

  INSERT INTO private.curated_reference_works
    (id, type, citation_key, title, short_label, revision, created_by, updated_by)
  VALUES ('61000000-0000-4000-8000-000000000201', 'article', 'Immutable2026',
    'Immutable work', 'Immutable 2026', 2, actor_id, actor_id);
  INSERT INTO private.curated_reference_taxon_treatments
    (id, reference_work_id, name_as_published, revision, created_by, updated_by)
  VALUES ('62000000-0000-4000-8000-000000000201',
    '61000000-0000-4000-8000-000000000201', 'Immutable species', 3, actor_id, actor_id);
  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, raw_text, revision, created_by, updated_by)
  VALUES ('63000000-0000-4000-8000-000000000201',
    '62000000-0000-4000-8000-000000000201', 'spore_size', 'range', '7-9 x 4-5 µm', 4,
    actor_id, actor_id);
  INSERT INTO private.curated_reference_treatment_taxa
    (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision, created_by, updated_by)
  VALUES ('64000000-0000-4000-8000-000000000201',
    '62000000-0000-4000-8000-000000000201', taxon_id, 'Exact assignment', 1,
    actor_id, actor_id);
  BEGIN
    INSERT INTO private.curated_reference_publications (
      curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
      curated_work_id, measurement_set_revision, treatment_revision, work_revision,
      snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
      content_hash, published_by
    ) VALUES (
      '63000000-0000-4000-8000-000000000201', 1,
      '62000000-0000-4000-8000-000000000201',
      '61000000-0000-4000-8000-000000000201', 4, 3, 1,
      1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
      repeat('9', 64), actor_id
    );
    RAISE EXCEPTION 'publication accepted stale graph revisions';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    '63000000-0000-4000-8000-000000000201', 1,
    '62000000-0000-4000-8000-000000000201',
    '61000000-0000-4000-8000-000000000201', 4, 3, 2,
    1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
    repeat('a', 64), actor_id
  );
  INSERT INTO private.curated_reference_publication_taxa
    (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
  VALUES ('63000000-0000-4000-8000-000000000201', 1, taxon_id, 'Immutable species');
  BEGIN
    INSERT INTO private.curated_reference_publication_taxa
      (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
    VALUES ('63000000-0000-4000-8000-000000000201', 1, 2100000011,
      'Null-rank immutable species');
    RAISE EXCEPTION 'publication accepted a null-rank taxon';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'published', latest_bundle_revision = 1,
         published_at = now(), status_changed_at = now(),
         row_version = row_version + 1
   WHERE id = '63000000-0000-4000-8000-000000000201';
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET catalogue_status = 'draft', latest_bundle_revision = NULL,
           published_at = NULL, row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'published catalogue head reverted to draft';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO private.reference_curation_events
    (id, actor_user_id, action, target_type, target_id, bundle_revision,
     outcome, reason, before_content_hash, after_content_hash)
  VALUES ('65000000-0000-4000-8000-000000000201', actor_id, 'publish',
    'publication', '63000000-0000-4000-8000-000000000201', 1,
    'succeeded', 'Publication test', NULL, repeat('a', 64));

  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  BEGIN
    INSERT INTO private.curated_reference_publication_taxa
      (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
    VALUES ('63000000-0000-4000-8000-000000000201', 1, taxon_id,
      'Immutable species');
    RAISE EXCEPTION 'published bundle accepted a later taxon insertion';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_publications (
      curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
      curated_work_id, measurement_set_revision, treatment_revision, work_revision,
      snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
      content_hash, published_by
    ) VALUES (
      '63000000-0000-4000-8000-000000000201', 3,
      '62000000-0000-4000-8000-000000000201',
      '61000000-0000-4000-8000-000000000201', 4, 3, 2,
      1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
      repeat('d', 64), actor_id
    );
    RAISE EXCEPTION 'out-of-order publication revision was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'withdrawn', withdrawn_at = now(),
         status_changed_at = now(), row_version = row_version + 1
   WHERE id = '63000000-0000-4000-8000-000000000201';
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    '63000000-0000-4000-8000-000000000201', 2,
    '62000000-0000-4000-8000-000000000201',
    '61000000-0000-4000-8000-000000000201', 4, 3, 2,
    1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
    repeat('a', 64), actor_id
  );
  INSERT INTO private.curated_reference_publication_taxa
    (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
  VALUES ('63000000-0000-4000-8000-000000000201', 2, taxon_id, 'Immutable species');
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'published', latest_bundle_revision = 2,
         published_at = now(), withdrawn_at = NULL, status_changed_at = now(),
         row_version = row_version + 1
   WHERE id = '63000000-0000-4000-8000-000000000201';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, revision)
  VALUES ('63000000-0000-4000-8000-000000000202',
    '62000000-0000-4000-8000-000000000201', 'spore_size', 'range', 1);
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    '63000000-0000-4000-8000-000000000202', 1,
    '62000000-0000-4000-8000-000000000201',
    '61000000-0000-4000-8000-000000000201', 1, 3, 2,
    1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
    repeat('c', 64), actor_id
  );
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'publication committed without advancing catalogue lifecycle';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, revision)
  VALUES ('63000000-0000-4000-8000-000000000203',
    '62000000-0000-4000-8000-000000000201', 'spore_size', 'range', 1);
  INSERT INTO private.curated_reference_publications (
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash, published_by
  ) VALUES (
    '63000000-0000-4000-8000-000000000203', 1,
    '62000000-0000-4000-8000-000000000201',
    '61000000-0000-4000-8000-000000000201', 1, 3, 2,
    1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
    repeat('e', 64), actor_id
  );
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'published', latest_bundle_revision = 1,
         published_at = now(), status_changed_at = now(), row_version = row_version + 1
   WHERE id = '63000000-0000-4000-8000-000000000203';
  BEGIN
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'publication without copied taxon assignments was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SET CONSTRAINTS ALL DEFERRED;

  BEGIN
    UPDATE private.curated_reference_publications
       SET citation_json = '{"schema_version":1,"changed":true}'::jsonb
     WHERE curated_measurement_set_id = '63000000-0000-4000-8000-000000000201'
       AND bundle_revision = 1;
    RAISE EXCEPTION 'publication update was accepted';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    DELETE FROM private.curated_reference_publications
     WHERE curated_measurement_set_id = '63000000-0000-4000-8000-000000000201'
       AND bundle_revision = 1;
    RAISE EXCEPTION 'publication delete was accepted';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_publication_taxa SET canonical_name = 'Changed'
     WHERE curated_measurement_set_id = '63000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'publication taxon update was accepted';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    DELETE FROM private.reference_curation_events
     WHERE id = '65000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'event delete was accepted';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    UPDATE private.reference_curation_events SET reason = 'rewritten'
     WHERE id = '65000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'event update was accepted';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    DELETE FROM private.curated_reference_works
     WHERE id = '61000000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'published parent delete was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

ROLLBACK;
