-- Dormant curated reference catalogue schema contract.
-- Run after local migrations with psql or `supabase db query --local --file`.

BEGIN;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'curated_reference_works',
    'curated_reference_taxon_treatments',
    'curated_reference_measurement_sets',
    'curated_reference_treatment_taxa',
    'curated_reference_publications',
    'curated_reference_publication_taxa',
    'reference_curator_memberships',
    'reference_curation_events'
  ] LOOP
    IF to_regclass('private.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'missing private.%', table_name;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  curator_id constant uuid := '00000000-0000-4000-8000-000000006a01';
  banned_id constant uuid := '00000000-0000-4000-8000-000000006a09';
  valid_taxon constant integer := 2100000001;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (curator_id, 'authenticated', 'authenticated', 'stage6a-schema@example.invalid', '{}'::jsonb, now(), now()),
    (banned_id, 'authenticated', 'authenticated', 'stage6a-banned@example.invalid', '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.profiles (id, username, is_banned)
  VALUES (curator_id, 'stage6a_schema', false), (banned_id, 'stage6a_banned', true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO taxonomy_v3.registry_concept
    (sporely_taxon_id, canonical_name, rank, scope_state, cache_state, first_materialized_from_release)
  VALUES
    (valid_taxon, 'Schema species', 'species', 'include', 'in_cache', 'stage6a-test'),
    (0, 'Zero species', 'species', 'include', 'in_cache', 'stage6a-test'),
    (-2100000001, 'Negative species', 'species', 'include', 'in_cache', 'stage6a-test'),
    (2100000002, 'Schema genus', 'genus', 'include', 'in_cache', 'stage6a-test'),
    (2100000003, '', 'species', 'include', 'in_cache', 'stage6a-test'),
    (2100000004, 'Other species', 'species', 'include', 'in_cache', 'stage6a-test'),
    (2100000005, 'Null-rank species', NULL, 'include', 'in_cache', 'stage6a-test')
  ON CONFLICT (sporely_taxon_id) DO UPDATE SET
    canonical_name = EXCLUDED.canonical_name,
    rank = EXCLUDED.rank;

  INSERT INTO private.curated_reference_works (
    id, type, citation_key, authors_json, title, short_label, revision,
    created_by, updated_by
  ) VALUES (
    '61000000-0000-4000-8000-000000000001', 'book', 'Schema2026',
    '[{"family":"Schema"}]'::jsonb, 'Schema work', 'Schema 2026', 1,
    curator_id, curator_id
  );
  INSERT INTO private.curated_reference_taxon_treatments (
    id, reference_work_id, name_as_published, revision, created_by, updated_by
  ) VALUES (
    '62000000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000001', 'Schema species', 1,
    curator_id, curator_id
  );
  INSERT INTO private.curated_reference_measurement_sets (
    id, taxon_treatment_id, character, data_kind, raw_text,
    length_core_min, length_core_max, width_core_min, width_core_max,
    revision, created_by, updated_by
  ) VALUES (
    '63000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001', 'spore_size', 'range',
    '8-10 x 5-6 µm', 8, 10, 5, 6, 1, curator_id, curator_id
  );

  INSERT INTO private.curated_reference_treatment_taxa (
    id, taxon_treatment_id, sporely_taxon_id, assignment_reason,
    revision, created_by, updated_by
  ) VALUES (
    '64000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001', valid_taxon,
    'Exact curator assignment', 1, curator_id, curator_id
  );

  IF (SELECT row_version FROM private.curated_reference_works
      WHERE id = '61000000-0000-4000-8000-000000000001') <> 1
     OR (SELECT row_version FROM private.curated_reference_taxon_treatments
         WHERE id = '62000000-0000-4000-8000-000000000001') <> 1
     OR (SELECT row_version FROM private.curated_reference_measurement_sets
         WHERE id = '63000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'CAS row_version defaults are not 1';
  END IF;

  BEGIN
    INSERT INTO private.reference_curator_memberships (user_id, role, granted_by, reason)
    VALUES (banned_id, 'reference_reviewer', curator_id, 'invalid');
    RAISE EXCEPTION 'banned curator membership was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.reference_curator_memberships (user_id, role, granted_by, reason)
    VALUES (curator_id, 'reference_reviewer', banned_id, 'invalid');
    RAISE EXCEPTION 'membership granted by a banned account was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO private.reference_curator_memberships (user_id, role, granted_by, reason)
    VALUES (curator_id, 'reference_admin', NULL, 'invalid');
    RAISE EXCEPTION 'unknown curator role was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_treatment_taxa
      (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
    VALUES ('64000000-0000-4000-8000-000000000002',
      '62000000-0000-4000-8000-000000000001', 0, 'invalid', 1);
    RAISE EXCEPTION 'zero taxon ID was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_treatment_taxa
      (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
    VALUES ('64000000-0000-4000-8000-000000000003',
      '62000000-0000-4000-8000-000000000001', -2100000001, 'invalid', 1);
    RAISE EXCEPTION 'negative taxon ID was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_treatment_taxa
      (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
    VALUES ('64000000-0000-4000-8000-000000000004',
      '62000000-0000-4000-8000-000000000001', 2100000002, 'invalid', 1);
    RAISE EXCEPTION 'non-species taxon was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_treatment_taxa
      (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
    VALUES ('64000000-0000-4000-8000-000000000005',
      '62000000-0000-4000-8000-000000000001', 2100000003, 'invalid', 1);
    RAISE EXCEPTION 'blank-name species taxon was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_treatment_taxa
      (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
    VALUES ('64000000-0000-4000-8000-000000000006',
      '62000000-0000-4000-8000-000000000001', 2099999999, 'invalid', 1);
    RAISE EXCEPTION 'missing taxonomy-v3 concept was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_treatment_taxa
      (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
    VALUES ('64000000-0000-4000-8000-000000000007',
      '62000000-0000-4000-8000-000000000001', 2100000005, 'invalid', 1);
    RAISE EXCEPTION 'null-rank taxon was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_works
      (id, type, title, short_label, revision)
    VALUES ('61000000-0000-4000-8000-000000000002', 'book', repeat('x', 2049), 'Too long', 1);
    RAISE EXCEPTION 'oversized work title was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_works
      (id, type, authors_json, title, short_label, revision)
    VALUES ('61000000-0000-4000-8000-000000000003', 'book', '{}'::jsonb, 'Bad authors', 'Bad', 1);
    RAISE EXCEPTION 'non-array authors_json was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO private.curated_reference_measurement_sets (
      id, taxon_treatment_id, character, data_kind, revision, catalogue_status
    ) VALUES (
      '63000000-0000-4000-8000-000000000002',
      '62000000-0000-4000-8000-000000000001', 'spore_size', 'range', 1,
      'published'
    );
    RAISE EXCEPTION 'published status without a bundle was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, revision)
  VALUES
    ('63000000-0000-4000-8000-000000000010', '62000000-0000-4000-8000-000000000001', 'spore_size', 'range', 1),
    ('63000000-0000-4000-8000-000000000011', '62000000-0000-4000-8000-000000000001', 'spore_size', 'range', 1),
    ('63000000-0000-4000-8000-000000000012', '62000000-0000-4000-8000-000000000001', 'spore_size', 'range', 1);

  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET notes = 'mutation without CAS increment'
     WHERE id = '63000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'mutable head update without row_version increment was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    UPDATE private.curated_reference_works
       SET title = 'Changed without semantic revision', row_version = row_version + 1
     WHERE id = '61000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'work content changed without semantic revision';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_taxon_treatments
       SET name_as_published = 'Changed without semantic revision', row_version = row_version + 1
     WHERE id = '62000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'treatment content changed without semantic revision';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET notes = 'Changed without semantic revision', row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'measurement-set content changed without semantic revision';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_treatment_taxa
       SET assignment_reason = 'Changed without semantic revision', row_version = row_version + 1
     WHERE id = '64000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'taxon assignment changed without semantic revision';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE private.curated_reference_works
     SET title = 'Changed with semantic revision', revision = revision + 1,
         row_version = row_version + 1
   WHERE id = '61000000-0000-4000-8000-000000000001';
  BEGIN
    UPDATE private.curated_reference_works
       SET created_at = created_at - interval '1 day', row_version = row_version + 1
     WHERE id = '61000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'work creation time was rewritten';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_works
       SET created_by = banned_id, row_version = row_version + 1
     WHERE id = '61000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'work creation actor was rewritten';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET id = '63000000-0000-4000-8000-000000000099', row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'curated entity UUID was rewritten';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;
  INSERT INTO private.reference_curator_memberships
    (user_id, role, granted_by, reason)
  VALUES (curator_id, 'reference_reviewer', curator_id, 'Identity immutability test');
  BEGIN
    UPDATE private.reference_curator_memberships
       SET user_id = banned_id, row_version = row_version + 1
     WHERE user_id = curator_id;
    RAISE EXCEPTION 'membership identity was retargeted';
  EXCEPTION WHEN read_only_sql_transaction THEN NULL;
  END;

  UPDATE private.curated_reference_measurement_sets
     SET supersedes_id = '63000000-0000-4000-8000-000000000010',
         row_version = row_version + 1
   WHERE id = '63000000-0000-4000-8000-000000000011';
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET supersedes_id = id, row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'self-supersession was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET supersedes_id = '63000000-0000-4000-8000-000000000011',
           row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000010';
    RAISE EXCEPTION 'supersession cycle was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET supersedes_id = '63000000-0000-4000-8000-000000000010',
           row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'second live successor was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO private.curated_reference_taxon_treatments
    (id, reference_work_id, name_as_published, revision)
  VALUES ('62000000-0000-4000-8000-000000000020',
    '61000000-0000-4000-8000-000000000001', 'Other species', 1);
  INSERT INTO private.curated_reference_treatment_taxa
    (id, taxon_treatment_id, sporely_taxon_id, assignment_reason, revision)
  VALUES ('64000000-0000-4000-8000-000000000020',
    '62000000-0000-4000-8000-000000000020', 2100000004,
    'Exact other assignment', 1);
  INSERT INTO private.curated_reference_measurement_sets
    (id, taxon_treatment_id, character, data_kind, revision)
  VALUES
    ('63000000-0000-4000-8000-000000000020', '62000000-0000-4000-8000-000000000001', 'spore_size', 'range', 1),
    ('63000000-0000-4000-8000-000000000021', '62000000-0000-4000-8000-000000000020', 'spore_size', 'range', 1);
  BEGIN
    UPDATE private.curated_reference_measurement_sets
       SET supersedes_id = '63000000-0000-4000-8000-000000000020',
           row_version = row_version + 1
     WHERE id = '63000000-0000-4000-8000-000000000021';
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'supersession across disjoint taxon assignments was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SET CONSTRAINTS ALL DEFERRED;

  BEGIN
    INSERT INTO private.curated_reference_measurement_sets (
      id, taxon_treatment_id, character, data_kind, catalogue_status,
      latest_bundle_revision, published_at, revision
    ) VALUES (
      '63000000-0000-4000-8000-000000000022',
      '62000000-0000-4000-8000-000000000001', 'spore_size', 'range',
      'published', 1, now(), 1
    );
    INSERT INTO private.curated_reference_publications (
      curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
      curated_work_id, measurement_set_revision, treatment_revision, work_revision,
      snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
      content_hash
    ) VALUES (
      '63000000-0000-4000-8000-000000000022', 1,
      '62000000-0000-4000-8000-000000000001',
      '61000000-0000-4000-8000-000000000001', 1, 1, 2,
      1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1,"citation_key":null,"type":"other","authors":[],"editors":[],"title":"Fixture","short_citation":"Fixture","full_citation":"Fixture."}'::jsonb,
      repeat('f', 64)
    );
    INSERT INTO private.curated_reference_publication_taxa
      (curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name)
    VALUES ('63000000-0000-4000-8000-000000000022', 1, valid_taxon, 'Schema species');
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'measurement set bypassed lifecycle by inserting as published';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SET CONSTRAINTS ALL DEFERRED;
END
$$;

DO $$
DECLARE
  index_name text;
BEGIN
  FOREACH index_name IN ARRAY ARRAY[
    'curated_reference_works_citation_key_key',
    'curated_reference_taxon_treatments_work_idx',
    'curated_reference_measurement_sets_treatment_idx',
    'curated_reference_measurement_sets_catalogue_idx',
    'curated_reference_measurement_sets_latest_publication_idx',
    'curated_reference_measurement_sets_one_live_successor_key',
    'curated_reference_treatment_taxa_lookup_idx',
    'curated_reference_publications_published_idx',
    'curated_reference_publications_content_hash_idx',
    'curated_reference_publications_set_treatment_idx',
    'curated_reference_publication_taxa_lookup_idx',
    'reference_curator_memberships_role_idx',
    'reference_curation_events_target_idx'
  ] LOOP
    IF to_regclass('private.' || index_name) IS NULL THEN
      RAISE EXCEPTION 'missing private index %', index_name;
    END IF;
  END LOOP;
END
$$;

ROLLBACK;
