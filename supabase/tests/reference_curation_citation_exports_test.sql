-- Stage 6f deterministic citation exports derived from immutable publications.

BEGIN;

DO $$
DECLARE
  work_id constant uuid := '66000000-0000-4000-8000-000000006f01';
  treatment_id constant uuid := '66000000-0000-4000-8000-000000006f02';
  set_id constant uuid := '66000000-0000-4000-8000-000000006f03';
  taxon_id constant integer := 2100000066;
  citation_v1 jsonb;
  citation_v2 jsonb;
  exports jsonb;
  fallback_exports jsonb;
  invalid_doi_exports jsonb;
  before_artifact jsonb;
  after_artifact jsonb;
  old_hash text;
BEGIN
  citation_v1 := jsonb_build_object(
    'schema_version', 1,
    'citation_key', 'Koskela2026',
    'type', 'article',
    'authors', jsonb_build_array(
      jsonb_build_object('family', 'O''Neil', 'given', 'Zoë'),
      jsonb_build_object('literal', E'Fungi and Friends {R&D}\n<script>')
    ),
    'editors', '[]'::jsonb,
    'title', E'Ångström & 100%_{x} \\ guide\n<script>alert(1)</script>',
    'container_title', 'Mycologia',
    'year', 2026,
    'edition', NULL,
    'publisher', NULL,
    'place', NULL,
    'volume', '118',
    'issue', '2',
    'pages', '1--9',
    'doi', ' HTTPS://DOI.ORG/10.1000/Sporely-1 ',
    'isbn', NULL,
    'url', 'https://example.invalid/?q=<script>',
    'language', 'nb-NO',
    'short_citation', 'O''Neil 2026',
    'full_citation', E'O''Neil Z. (2026). Ångström & fungi.\nhttps://doi.org/HTTPS://DOI.ORG/10.1000/Sporely-1'
  );

  SELECT private.reference_curated_build_citation_exports(citation_v1, work_id)
    INTO exports;
  IF exports->>'citation_key' <> 'Koskela2026'
     OR exports->>'plain_text' <> E'O''Neil Z. (2026). Ångström & fungi. https://doi.org/10.1000/sporely-1\n'
     OR pg_catalog.strpos(exports->>'bibtex', E'@article{Koskela2026,\n') <> 1
     OR pg_catalog.strpos(exports->>'bibtex', E'  author = {O''Neil, Zoë and {Fungi and Friends {\\char123}R\\&D{\\char125} <script>}},\n') = 0
     OR pg_catalog.strpos(exports->>'bibtex', E'  title = {Ångström \\& 100\\%\\_{\\char123}x{\\char125} {\\char92} guide <script>alert(1)</script>},\n') = 0
     OR pg_catalog.strpos(exports->>'bibtex', E'  doi = {10.1000/sporely-1},\n') = 0
     OR right(exports->>'bibtex', 2) <> E'}\n'
     OR (exports->>'csl_json')::jsonb->>'id' <> 'Koskela2026'
     OR (exports->>'csl_json')::jsonb->>'type' <> 'article-journal'
     OR (exports->>'csl_json')::jsonb->>'DOI' <> '10.1000/sporely-1'
     OR (exports->>'csl_json')::jsonb->'author'->0->>'given' <> 'Zoë'
     OR (exports->>'csl_json')::jsonb->'author'->1->>'literal'
        <> 'Fungi and Friends {R&D} <script>'
     OR right(exports->>'csl_json', 1) <> E'\n' THEN
    RAISE EXCEPTION 'deterministic Unicode/escaping export mismatch: %', exports;
  END IF;

  SELECT private.reference_curated_build_citation_exports(
    citation_v1 || jsonb_build_object('citation_key', E'bad},\n@entry'), work_id
  ) INTO fallback_exports;
  IF fallback_exports->>'citation_key'
       <> 'sporely-auto-66000000000040008000000000006f01' THEN
    RAISE EXCEPTION 'unsafe key did not use stable reserved fallback: %', fallback_exports;
  END IF;
  IF (private.reference_curated_build_citation_exports(
        citation_v1 || '{"citation_key":null}'::jsonb, work_id
      )->>'citation_key') <> fallback_exports->>'citation_key'
     OR (private.reference_curated_build_citation_exports(
        citation_v1 || '{"citation_key":"sporely-auto-reserved"}'::jsonb, work_id
      )->>'citation_key') <> fallback_exports->>'citation_key' THEN
    RAISE EXCEPTION 'null/reserved citation keys did not use the stable fallback';
  END IF;
  SELECT private.reference_curated_build_citation_exports(
    citation_v1 || jsonb_build_object(
      'doi', 'doi: not a doi',
      'full_citation', 'Bad DOI. https://doi.org/doi: not a doi'
    ), work_id
  ) INTO invalid_doi_exports;
  IF (invalid_doi_exports->>'csl_json')::jsonb ? 'DOI'
     OR pg_catalog.strpos(invalid_doi_exports->>'bibtex', '  doi = {') > 0
     OR invalid_doi_exports->>'plain_text' <> E'Bad DOI.\n'
     OR pg_catalog.strpos(invalid_doi_exports->>'plain_text', 'doi.org') > 0 THEN
    RAISE EXCEPTION 'invalid DOI was not omitted fail-closed from structured exports';
  END IF;
  IF private.reference_curated_build_citation_exports(
       citation_v1 || jsonb_build_object(
         'doi', 'doi: not a doi',
         'full_citation',
           'Historical https://doi.org/doi: not a doi override; keep verbatim.'
       ), work_id
     )->>'plain_text'
       <> E'Historical https://doi.org/doi: not a doi override; keep verbatim.\n' THEN
    RAISE EXCEPTION 'internal manual citation override text was rewritten';
  END IF;
  BEGIN
    PERFORM private.reference_curated_build_citation_exports(
      citation_v1 || jsonb_build_object(
        'doi', 'doi: not a doi',
        'full_citation', 'https://doi.org/doi: not a doi'
      ), work_id
    );
    RAISE EXCEPTION 'empty plain-text artifact was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('book', 'book', '@book{'),
        ('article', 'article-journal', '@article{'),
        ('chapter', 'chapter', '@incollection{'),
        ('website', 'webpage', '@misc{'),
        ('dataset', 'dataset', '@misc{'),
        ('other', 'document', '@misc{')
      ) expected(source_type, csl_type, bibtex_prefix)
      CROSS JOIN LATERAL (
        SELECT private.reference_curated_build_citation_exports(
          citation_v1 || jsonb_build_object('type', expected.source_type), work_id
        ) AS value
      ) built
     WHERE (built.value->>'csl_json')::jsonb->>'type' <> expected.csl_type
        OR pg_catalog.strpos(built.value->>'bibtex', expected.bibtex_prefix) <> 1
  ) THEN
    RAISE EXCEPTION 'citation type mapping is not deterministic';
  END IF;

  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id, canonical_name, rank, scope_state, cache_state,
    first_materialized_from_release
  ) VALUES (
    taxon_id, 'Russula exportensis', 'species', 'include', 'in_cache', 'stage6f-test'
  );
  INSERT INTO private.curated_reference_works(
    id, type, citation_key, authors_json, title, container_title, year, volume,
    issue, pages, doi, url, language, short_label, revision
  ) VALUES (
    work_id, 'article', 'Koskela2026', citation_v1->'authors', citation_v1->>'title',
    'Mycologia', 2026, '118', '2', '1--9', citation_v1->>'doi',
    citation_v1->>'url', 'nb-NO', 'O''Neil 2026', 1
  );
  INSERT INTO private.curated_reference_taxon_treatments(
    id, reference_work_id, name_as_published, revision
  ) VALUES (treatment_id, work_id, 'Russula exportensis', 1);
  INSERT INTO private.curated_reference_measurement_sets(
    id, taxon_treatment_id, character, data_kind, length_core_min,
    length_core_max, width_core_min, width_core_max, revision
  ) VALUES (set_id, treatment_id, 'spore_size', 'range', 7, 9, 5, 6, 1);
  INSERT INTO private.curated_reference_treatment_taxa(
    taxon_treatment_id, sporely_taxon_id, assignment_reason, revision
  ) VALUES (treatment_id, taxon_id, 'Stage 6f exact species fixture', 1);

  INSERT INTO private.curated_reference_publications(
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash
  ) VALUES (
    set_id, 1, treatment_id, work_id, 1, 1, 1,
    1, '{"schema_version":1}'::jsonb, 1, citation_v1, repeat('a', 64)
  );
  INSERT INTO private.curated_reference_publication_taxa(
    curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name
  ) VALUES (set_id, 1, taxon_id, 'Russula exportensis');
  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status = 'published', latest_bundle_revision = 1,
         published_at = now(), status_changed_at = now(), row_version = 2
   WHERE id = set_id;
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  SELECT to_jsonb(e), e.artifact_hash
    INTO before_artifact, old_hash
    FROM private.curated_reference_citation_exports e
   WHERE e.curated_measurement_set_id = set_id AND e.bundle_revision = 1;
  IF before_artifact IS NULL
     OR before_artifact->>'source_work_id' <> work_id::text
     OR (before_artifact->>'source_work_revision')::integer <> 1
     OR before_artifact->>'citation_key' <> 'Koskela2026'
     OR before_artifact->>'plain_text_sha256' !~ '^[0-9a-f]{64}$'
     OR before_artifact->>'bibtex_sha256' !~ '^[0-9a-f]{64}$'
     OR before_artifact->>'csl_json_sha256' !~ '^[0-9a-f]{64}$'
     OR old_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'publication artifact/provenance missing: %', before_artifact;
  END IF;

  PERFORM private.reference_curated_materialize_citation_exports(set_id, 1);
  PERFORM private.reference_curated_materialize_citation_exports(set_id, 1);
  SELECT to_jsonb(e) INTO after_artifact
    FROM private.curated_reference_citation_exports e
   WHERE e.curated_measurement_set_id = set_id AND e.bundle_revision = 1;
  IF after_artifact IS DISTINCT FROM before_artifact
     OR (SELECT count(*) FROM private.curated_reference_citation_exports
          WHERE curated_measurement_set_id = set_id AND bundle_revision = 1) <> 1 THEN
    RAISE EXCEPTION 'replay was not byte-stable/idempotent';
  END IF;

  UPDATE private.curated_reference_works
     SET title = 'Later mutable head', revision = 2, row_version = 2
   WHERE id = work_id;
  PERFORM private.reference_curated_materialize_citation_exports(set_id, 1);
  IF (SELECT artifact_hash FROM private.curated_reference_citation_exports
       WHERE curated_measurement_set_id = set_id AND bundle_revision = 1)
       IS DISTINCT FROM old_hash THEN
    RAISE EXCEPTION 'mutable work head rewrote historical export';
  END IF;

  citation_v2 := citation_v1 || jsonb_build_object(
    'title', 'Later mutable head',
    'full_citation', 'O''Neil Z. (2026). Later mutable head.'
  );
  INSERT INTO private.curated_reference_publications(
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash
  ) VALUES (
    set_id, 2, treatment_id, work_id, 1, 1, 2,
    1, '{"schema_version":1}'::jsonb, 1, citation_v2, repeat('b', 64)
  );
  INSERT INTO private.curated_reference_publication_taxa(
    curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name
  ) VALUES (set_id, 2, taxon_id, 'Russula exportensis');
  UPDATE private.curated_reference_measurement_sets
     SET latest_bundle_revision = 2, status_changed_at = now(), row_version = 3
   WHERE id = set_id;
  SET CONSTRAINTS ALL IMMEDIATE;

  IF (SELECT count(*) FROM private.curated_reference_citation_exports
       WHERE curated_measurement_set_id = set_id) <> 2
     OR (SELECT citation_key FROM private.curated_reference_citation_exports
          WHERE curated_measurement_set_id = set_id AND bundle_revision = 2)
        <> 'Koskela2026'
     OR (SELECT artifact_hash FROM private.curated_reference_citation_exports
          WHERE curated_measurement_set_id = set_id AND bundle_revision = 2) = old_hash
     OR (SELECT artifact_hash FROM private.curated_reference_citation_exports
          WHERE curated_measurement_set_id = set_id AND bundle_revision = 1) <> old_hash THEN
    RAISE EXCEPTION 'later source revision did not append a distinct stable-key artifact';
  END IF;

  -- Simulate a pre-Stage-6f publication, then exercise the migration's private
  -- backfill/replay path without reading the mutable work head.
  SET CONSTRAINTS ALL DEFERRED;
  EXECUTE 'ALTER TABLE private.curated_reference_publications DISABLE TRIGGER curated_reference_publications_exports_trg';
  INSERT INTO private.curated_reference_publications(
    curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
    curated_work_id, measurement_set_revision, treatment_revision, work_revision,
    snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
    content_hash
  ) VALUES (
    set_id, 3, treatment_id, work_id, 1, 1, 2,
    1, '{"schema_version":1}'::jsonb, 1, citation_v2, repeat('c', 64)
  );
  INSERT INTO private.curated_reference_publication_taxa(
    curated_measurement_set_id, bundle_revision, sporely_taxon_id, canonical_name
  ) VALUES (set_id, 3, taxon_id, 'Russula exportensis');
  UPDATE private.curated_reference_measurement_sets
     SET latest_bundle_revision = 3, status_changed_at = now(), row_version = 4
   WHERE id = set_id;
  PERFORM private.reference_curated_materialize_citation_exports(set_id, 3);
  PERFORM private.reference_curated_materialize_citation_exports(set_id, 3);
  SET CONSTRAINTS ALL IMMEDIATE;
  EXECUTE 'ALTER TABLE private.curated_reference_publications ENABLE TRIGGER curated_reference_publications_exports_trg';
  IF (SELECT count(*) FROM private.curated_reference_citation_exports
       WHERE curated_measurement_set_id = set_id AND bundle_revision = 3) <> 1 THEN
    RAISE EXCEPTION 'backfill/replay did not create exactly one artifact';
  END IF;

  BEGIN
    INSERT INTO private.curated_reference_publications(
      curated_measurement_set_id, bundle_revision, curated_taxon_treatment_id,
      curated_work_id, measurement_set_revision, treatment_revision, work_revision,
      snapshot_schema_version, snapshot_json, citation_schema_version, citation_json,
      content_hash
    ) VALUES (
      set_id, 4, treatment_id, work_id, 1, 1, 2,
      1, '{"schema_version":1}'::jsonb, 1, '{"schema_version":1}'::jsonb,
      repeat('d', 64)
    );
    RAISE EXCEPTION 'malformed publication unexpectedly produced an artifact';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM private.curated_reference_publications
     WHERE curated_measurement_set_id = set_id AND bundle_revision = 4
  ) OR EXISTS (
    SELECT 1 FROM private.curated_reference_citation_exports
     WHERE curated_measurement_set_id = set_id AND bundle_revision = 4
  ) THEN
    RAISE EXCEPTION 'malformed publication/artifact did not roll back atomically';
  END IF;

  BEGIN
    UPDATE private.curated_reference_citation_exports SET plain_text = 'tampered';
    RAISE EXCEPTION 'citation export update unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '25006' THEN NULL;
  END;
  BEGIN
    DELETE FROM private.curated_reference_citation_exports
     WHERE curated_measurement_set_id = set_id;
    RAISE EXCEPTION 'citation export delete unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '25006' THEN NULL;
  END;

  IF has_table_privilege('anon', 'private.curated_reference_citation_exports', 'SELECT')
     OR has_table_privilege('authenticated', 'private.curated_reference_citation_exports', 'SELECT')
     OR has_table_privilege('service_role', 'private.curated_reference_citation_exports', 'INSERT')
     OR has_table_privilege('service_role', 'private.curated_reference_citation_exports', 'UPDATE')
     OR has_table_privilege('service_role', 'private.curated_reference_citation_exports', 'DELETE')
     OR has_table_privilege('service_role', 'private.curated_reference_citation_exports', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'private.curated_reference_citation_exports', 'SELECT') THEN
    RAISE EXCEPTION 'citation export grants are not deny-by-default/read-only service';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'private'
      AND c.relname = 'curated_reference_citation_exports'
      AND c.relrowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '%citation_export%'
  ) THEN
    RAISE EXCEPTION 'citation export storage is not private/RLS-only';
  END IF;
  IF has_function_privilege(
       'service_role',
       'private.reference_curated_materialize_citation_exports(uuid,integer)',
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'private.reference_curated_build_citation_exports(jsonb,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'private citation export helpers remain directly executable';
  END IF;
END
$$;

ROLLBACK;
