-- Stage 6g exact-taxon curated catalogue public reads.

BEGIN;

CREATE FUNCTION private.stage6g_test_publish_set(
  p_work_id uuid,
  p_treatment_id uuid,
  p_set_id uuid,
  p_title text,
  p_taxon_ids integer[],
  p_published_at timestamptz,
  p_bundle_count integer,
  p_final_status text,
  p_supersedes_id uuid,
  p_malformed_kind text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_bundle integer;
  v_taxon_id integer;
  v_snapshot jsonb;
  v_citation jsonb;
BEGIN
  INSERT INTO private.curated_reference_works(
    id,type,authors_json,title,year,doi,url,short_label,revision
  ) VALUES (
    p_work_id,'article','[{"family":"Public","given":"Ada"}]',p_title,
    2026,'10.1000/stage6g','HTTPS://example.invalid/stage6g','Public 2026',1
  );
  INSERT INTO private.curated_reference_taxon_treatments(
    id,reference_work_id,name_as_published,locator_text,treatment_notes,revision
  ) VALUES(
    p_treatment_id,p_work_id,'Russula publicata','p. 6g',
    'DO-NOT-LEAK-TREATMENT-NOTE',1
  );
  INSERT INTO private.curated_reference_measurement_sets(
    id,taxon_treatment_id,character,data_kind,raw_text,
    length_core_min,length_core_max,width_core_min,width_core_max,notes,
    supersedes_id,revision
  ) VALUES(
    p_set_id,p_treatment_id,'spore_size','range','(7–)8–10 × 5–6 µm',
    8,10,5,6,'DO-NOT-LEAK-MEASUREMENT-NOTE',p_supersedes_id,1
  );
  FOREACH v_taxon_id IN ARRAY p_taxon_ids LOOP
    INSERT INTO private.curated_reference_treatment_taxa(
      taxon_treatment_id,sporely_taxon_id,assignment_reason,revision
    ) VALUES(p_treatment_id,v_taxon_id,'Exact Stage 6g assignment',1);
  END LOOP;

  FOR v_bundle IN 1..p_bundle_count LOOP
    v_snapshot := private.reference_curated_snapshot(p_set_id,v_bundle);
    v_citation := private.reference_curated_citation(p_work_id);
    IF p_malformed_kind='snapshot' AND v_bundle=p_bundle_count THEN
      v_snapshot := v_snapshot || '{"private_note":"DO-NOT-LEAK-SNAPSHOT"}'::jsonb;
    ELSIF p_malformed_kind='citation' AND v_bundle=p_bundle_count THEN
      v_citation := v_citation || '{"moderation_reason":"DO-NOT-LEAK-CITATION"}'::jsonb;
    END IF;
    INSERT INTO private.curated_reference_publications(
      curated_measurement_set_id,bundle_revision,curated_taxon_treatment_id,
      curated_work_id,measurement_set_revision,treatment_revision,work_revision,
      snapshot_schema_version,snapshot_json,citation_schema_version,citation_json,
      content_hash,published_at
    ) VALUES(
      p_set_id,v_bundle,p_treatment_id,p_work_id,1,1,1,
      1,v_snapshot,1,v_citation,repeat(substr(md5(p_set_id::text||v_bundle::text),1,1),64),
      p_published_at
    );
    INSERT INTO private.curated_reference_publication_taxa(
      curated_measurement_set_id,bundle_revision,sporely_taxon_id,canonical_name
    )
    SELECT p_set_id,v_bundle,c.sporely_taxon_id,c.canonical_name
      FROM taxonomy_v3.registry_concept c
     WHERE c.sporely_taxon_id=ANY(p_taxon_ids)
     ORDER BY c.sporely_taxon_id;
  END LOOP;

  UPDATE private.curated_reference_measurement_sets
     SET catalogue_status='published',latest_bundle_revision=p_bundle_count,
         published_at=p_published_at,status_changed_at=p_published_at,
         row_version=row_version+1
   WHERE id=p_set_id;
  IF p_final_status='deprecated' THEN
    UPDATE private.curated_reference_measurement_sets
       SET catalogue_status='deprecated',deprecated_at=p_published_at+interval '1 hour',
           status_changed_at=p_published_at+interval '1 hour',row_version=row_version+1
     WHERE id=p_set_id;
  ELSIF p_final_status='withdrawn' THEN
    UPDATE private.curated_reference_measurement_sets
       SET catalogue_status='withdrawn',withdrawn_at=p_published_at+interval '1 hour',
           status_changed_at=p_published_at+interval '1 hour',row_version=row_version+1
     WHERE id=p_set_id;
  END IF;
END
$$;

DO $$
DECLARE
  taxon_a constant integer := 2100000081;
  taxon_b constant integer := 2100000082;
  taxon_changed_rank constant integer := 2100000083;
  set_a constant uuid := '68000000-0000-4000-8000-000000006701';
  set_b constant uuid := '68000000-0000-4000-8000-000000006702';
  set_successor constant uuid := '68000000-0000-4000-8000-000000006703';
  set_deprecated constant uuid := '68000000-0000-4000-8000-000000006704';
  set_bad_snapshot constant uuid := '68000000-0000-4000-8000-000000006705';
  set_withdrawn constant uuid := '68000000-0000-4000-8000-000000006706';
  set_rank_changed constant uuid := '68000000-0000-4000-8000-000000006707';
  set_bad_citation constant uuid := '68000000-0000-4000-8000-000000006708';
  set_bad_schema constant uuid := '68000000-0000-4000-8000-000000006709';
  set_oversized constant uuid := '68000000-0000-4000-8000-000000006710';
  draft_successor constant uuid := '68000000-0000-4000-8000-000000006711';
  set_recovery constant uuid := '68000000-0000-4000-8000-000000006712';
  page_one uuid[];
  page_two uuid[];
  recovery_page uuid[];
  exact_taxa integer[];
  item jsonb;
  artifact record;
  caught boolean;
BEGIN
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,
    first_materialized_from_release
  ) VALUES
    (taxon_a,'Russula publicata','species','include','in_cache','stage6g-test'),
    (taxon_b,'Russula secunda','species','include','in_cache','stage6g-test'),
    (taxon_changed_rank,'Russula historicalis','species','include','in_cache','stage6g-test');

  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006701',
    '67500000-0000-4000-8000-000000006701',set_a,
    'Alpha </script><script>alert("stage6g")</script> public set',
    ARRAY[taxon_a,taxon_b],timestamp with time zone '2026-08-29 12:00:00+00',
    2,'published',NULL,NULL
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006702',
    '67500000-0000-4000-8000-000000006702',set_b,'Beta public set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 12:00:00+00',
    1,'published',NULL,NULL
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006712',
    '67500000-0000-4000-8000-000000006712',set_recovery,'Older valid set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 07:30:00+00',
    1,'published',NULL,NULL
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006704',
    '67500000-0000-4000-8000-000000006704',set_deprecated,'Deprecated set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 10:00:00+00',
    1,'deprecated',NULL,NULL
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006703',
    '67500000-0000-4000-8000-000000006703',set_successor,'Successor set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 11:00:00+00',
    1,'published',set_deprecated,NULL
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006705',
    '67500000-0000-4000-8000-000000006705',set_bad_snapshot,'Malformed snapshot set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 09:00:00+00',
    1,'published',NULL,'snapshot'
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006708',
    '67500000-0000-4000-8000-000000006708',set_bad_citation,'Malformed citation set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 08:30:00+00',
    1,'published',NULL,'citation'
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006709',
    '67500000-0000-4000-8000-000000006709',set_bad_schema,'Bad schema set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 08:15:00+00',
    1,'published',NULL,NULL
  );
  SET CONSTRAINTS ALL IMMEDIATE;
  ALTER TABLE private.curated_reference_publications
    DISABLE TRIGGER curated_reference_publications_immutable_trg;
  ALTER TABLE private.curated_reference_citation_exports
    DISABLE TRIGGER curated_reference_citation_exports_immutable_trg;
  UPDATE private.curated_reference_publications
     SET citation_json=jsonb_set(citation_json,'{schema_version}','"1"'::jsonb)
   WHERE curated_measurement_set_id=set_bad_schema AND bundle_revision=1;
  ALTER TABLE private.curated_reference_publications
    ENABLE TRIGGER curated_reference_publications_immutable_trg;
  ALTER TABLE private.curated_reference_citation_exports
    ENABLE TRIGGER curated_reference_citation_exports_immutable_trg;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006706',
    '67500000-0000-4000-8000-000000006706',set_withdrawn,'Withdrawn set',
    ARRAY[taxon_a],timestamp with time zone '2026-08-29 08:00:00+00',
    1,'withdrawn',NULL,NULL
  );
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006707',
    '67500000-0000-4000-8000-000000006707',set_rank_changed,'Rank changed set',
    ARRAY[taxon_changed_rank],timestamp with time zone '2026-08-29 07:00:00+00',
    1,'published',NULL,NULL
  );
  INSERT INTO taxonomy_v3.registry_concept(
    sporely_taxon_id,canonical_name,rank,scope_state,cache_state,
    first_materialized_from_release
  )
  SELECT 2100000200+n,'Russula bound'||n,'species','include','in_cache','stage6g-test'
    FROM pg_catalog.generate_series(1,101) n;
  PERFORM private.stage6g_test_publish_set(
    '67000000-0000-4000-8000-000000006710',
    '67500000-0000-4000-8000-000000006710',set_oversized,'Assignment bound set',
    ARRAY(SELECT 2100000200+n FROM pg_catalog.generate_series(1,101) n),
    timestamp with time zone '2026-08-29 06:00:00+00',1,'published',NULL,NULL
  );

  INSERT INTO private.curated_reference_works(id,type,title,short_label,revision)
  VALUES('67000000-0000-4000-8000-000000006711','article','Private draft successor',
         'Private draft',1);
  INSERT INTO private.curated_reference_taxon_treatments(
    id,reference_work_id,name_as_published,revision
  ) VALUES(
    '67500000-0000-4000-8000-000000006711',
    '67000000-0000-4000-8000-000000006711','Russula private draft',1
  );
  INSERT INTO private.curated_reference_measurement_sets(
    id,taxon_treatment_id,character,data_kind,length_core_min,length_core_max,
    width_core_min,width_core_max,supersedes_id,revision
  ) VALUES(
    draft_successor,'67500000-0000-4000-8000-000000006711','spore_size','range',
    8,10,5,6,set_a,1
  );
  INSERT INTO private.curated_reference_treatment_taxa(
    taxon_treatment_id,sporely_taxon_id,assignment_reason,revision
  ) VALUES(
    '67500000-0000-4000-8000-000000006711',taxon_a,'Private draft assignment',1
  );
  SET CONSTRAINTS ALL IMMEDIATE;

  UPDATE taxonomy_v3.registry_concept
     SET rank='genus',canonical_name='Changed current registry name'
   WHERE sporely_taxon_id=taxon_changed_rank;

  SELECT pg_catalog.array_agg((entry->>'curated_measurement_set_id')::uuid)
    INTO page_one
    FROM public.search_public_curated_reference_sets(
      taxon_a,2,NULL,NULL
    ) entry;
  IF page_one <> ARRAY[set_a,set_b] THEN
    RAISE EXCEPTION 'first page/tie ordering mismatch: %',page_one;
  END IF;
  SELECT pg_catalog.array_agg((entry->>'curated_measurement_set_id')::uuid)
    INTO page_two
    FROM public.search_public_curated_reference_sets(
      taxon_a,1,timestamp with time zone '2026-08-29 12:00:00+00',set_b
    ) entry;
  IF page_two <> ARRAY[set_successor] THEN
    RAISE EXCEPTION 'cursor page mismatch or malformed/deprecated row leaked: %',page_two;
  END IF;
  SELECT pg_catalog.array_agg((entry->>'curated_measurement_set_id')::uuid)
    INTO recovery_page
    FROM public.search_public_curated_reference_sets(
      taxon_a,1,timestamp with time zone '2026-08-29 11:00:00+00',set_successor
    ) entry;
  IF recovery_page <> ARRAY[set_recovery] THEN
    RAISE EXCEPTION 'bounded malformed omission stranded older valid row: %',recovery_page;
  END IF;
  IF (SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
       WHERE (namespace.nspname,procedure.proname) IN (
         ('public','search_public_curated_reference_sets'),
         ('public','get_public_curated_reference_set'),
         ('private','public_species_taxon_identities'),
         ('private','reference_curated_public_envelope')
       )) <> 4 OR EXISTS (
    SELECT 1 FROM public.search_public_curated_reference_sets(
      taxon_changed_rank,50,NULL,NULL
    )
  ) OR EXISTS (
    SELECT 1 FROM public.search_public_curated_reference_sets(
      2147483000,50,NULL,NULL
    )
  ) THEN
    RAISE EXCEPTION 'ineligible/nonexistent taxonomy identity matched';
  END IF;

  SELECT entry INTO item
    FROM public.search_public_curated_reference_sets(taxon_b,50,NULL,NULL) entry;
  SELECT e.plain_text,e.bibtex,e.csl_json::jsonb
    INTO artifact
    FROM private.curated_reference_citation_exports e
   WHERE e.curated_measurement_set_id=set_a AND e.bundle_revision=2;
  IF item->>'curated_measurement_set_id' <> set_a::text
     OR (item->>'bundle_revision')::integer <> 2
     OR item->>'status' <> 'published'
     OR (item->>'sporely_taxon_id')::integer <> taxon_b
     OR item->>'canonical_scientific_name' <> 'Russula secunda'
     OR item->'citation'->>'title'
        <> 'Alpha </script><script>alert("stage6g")</script> public set'
     OR item->'exports'->>'plain_text' IS DISTINCT FROM artifact.plain_text
     OR item->'exports'->>'bibtex' IS DISTINCT FROM artifact.bibtex
     OR item->'exports'->'csl_json' IS DISTINCT FROM artifact.csl_json
     OR item->'citation'->>'citation_key'
        IS DISTINCT FROM item->'exports'->'csl_json'->>'id'
     OR item->'citation'->>'url' <> 'HTTPS://example.invalid/stage6g'
     OR item->>'superseded_by_id' IS NOT NULL
     OR (SELECT pg_catalog.array_agg(k ORDER BY k)
           FROM pg_catalog.jsonb_object_keys(item) k)
        <> ARRAY['bundle_revision','canonical_scientific_name','citation',
                 'curated_measurement_set_id','exports','published_at','snapshot',
                 'sporely_taxon_id','status','superseded_by_id'] THEN
    RAISE EXCEPTION 'exact-key public envelope mismatch: %',item;
  END IF;
  IF item::text LIKE '%DO-NOT-LEAK%'
     OR item ? 'source_work_id' OR item ? 'source_work_revision'
     OR item ? 'artifact_hash' OR item ? 'generated_at'
     OR item ? 'owner_id' OR item ? 'submitter_id'
     OR item ? 'moderation_reason' OR item ? 'row_version' THEN
    RAISE EXCEPTION 'private/provenance/moderation data leaked: %',item;
  END IF;

  SELECT pg_catalog.array_agg((entry->>'sporely_taxon_id')::integer)
    INTO exact_taxa
    FROM public.get_public_curated_reference_set(set_a,2) entry;
  IF exact_taxa <> ARRAY[taxon_a,taxon_b] THEN
    RAISE EXCEPTION 'multi-assignment exact read lost deterministic taxa: %',exact_taxa;
  END IF;
  IF (SELECT entry->>'bundle_revision'
        FROM public.get_public_curated_reference_set(set_a,NULL) entry LIMIT 1) <> '2'
     OR (SELECT entry->>'bundle_revision'
        FROM public.get_public_curated_reference_set(set_a,1) entry LIMIT 1) <> '1' THEN
    RAISE EXCEPTION 'explicit/latest exact revision behavior mismatch';
  END IF;

  SELECT entry INTO item
    FROM public.get_public_curated_reference_set(set_deprecated,1) entry;
  IF item->>'status'<>'deprecated'
     OR item->>'superseded_by_id'<>set_successor::text
     OR item->'snapshot' IS NULL OR item->'exports' IS NULL THEN
    RAISE EXCEPTION 'deprecated/superseded exact response mismatch: %',item;
  END IF;
  SELECT entry INTO item
    FROM public.get_public_curated_reference_set(set_withdrawn,1) entry;
  IF (SELECT pg_catalog.array_agg(k ORDER BY k)
        FROM pg_catalog.jsonb_object_keys(item) k)
       <> ARRAY['bundle_revision','curated_measurement_set_id','status',
                'superseded_by_id','withdrawn_at']
     OR item->>'status'<>'withdrawn'
     OR item::text LIKE '%Withdrawn set%' THEN
    RAISE EXCEPTION 'withdrawn response was not a status-only tombstone: %',item;
  END IF;
  IF EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_withdrawn,NULL))
     OR EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_withdrawn,2))
     OR EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(
       '68000000-0000-4000-8000-000000006799',1
     )) THEN
    RAISE EXCEPTION 'withdrawn latest/wrong revision/unknown exact read did not fail closed';
  END IF;
  IF EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_bad_snapshot,1))
     OR EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_bad_citation,1))
     OR EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_bad_schema,1))
     OR EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_oversized,1)) THEN
    RAISE EXCEPTION 'malformed immutable publication was exposed';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.search_public_curated_reference_sets(
      2100000201,50,NULL,NULL
    ) entry
     WHERE entry->>'curated_measurement_set_id'=set_oversized::text
  ) THEN
    RAISE EXCEPTION 'oversized assignment bundle was discoverable';
  END IF;
  SELECT entry INTO item
    FROM public.get_public_curated_reference_set(set_rank_changed,1) entry;
  IF item->>'canonical_scientific_name'<>'Russula historicalis' THEN
    RAISE EXCEPTION 'historical exact read followed mutable registry state: %',item;
  END IF;

  caught:=false;
  BEGIN
    PERFORM public.search_public_curated_reference_sets(taxon_a,0,NULL,NULL);
  EXCEPTION WHEN invalid_parameter_value THEN caught:=true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'zero limit was accepted'; END IF;
  caught:=false;
  BEGIN
    PERFORM public.search_public_curated_reference_sets(taxon_a,51,NULL,NULL);
  EXCEPTION WHEN invalid_parameter_value THEN caught:=true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'over-limit anonymous request was accepted'; END IF;
  caught:=false;
  BEGIN
    PERFORM public.search_public_curated_reference_sets(taxon_a,10,now(),NULL);
  EXCEPTION WHEN invalid_parameter_value THEN caught:=true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'half cursor was accepted'; END IF;
  caught:=false;
  BEGIN
    PERFORM public.search_public_curated_reference_sets(0,10,NULL,NULL);
  EXCEPTION WHEN invalid_parameter_value THEN caught:=true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'zero taxon identity was accepted'; END IF;

  ALTER TABLE private.curated_reference_citation_exports
    DISABLE TRIGGER curated_reference_citation_exports_immutable_trg;
  UPDATE private.curated_reference_citation_exports
     SET source_work_revision=source_work_revision+1
   WHERE curated_measurement_set_id=set_b AND bundle_revision=1;
  ALTER TABLE private.curated_reference_citation_exports
    ENABLE TRIGGER curated_reference_citation_exports_immutable_trg;
  IF EXISTS(SELECT 1 FROM public.get_public_curated_reference_set(set_b,1))
     OR EXISTS(
       SELECT 1 FROM public.search_public_curated_reference_sets(taxon_a,50,NULL,NULL) entry
        WHERE entry->>'curated_measurement_set_id'=set_b::text
     ) THEN
    RAISE EXCEPTION 'artifact version mismatch was exposed';
  END IF;

  IF has_table_privilege('anon','private.curated_reference_publications','SELECT')
     OR has_table_privilege('authenticated','private.curated_reference_citation_exports','SELECT')
     OR NOT has_function_privilege('anon',
       'public.search_public_curated_reference_sets(integer,integer,timestamp with time zone,uuid)',
       'EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.get_public_curated_reference_set(uuid,integer)','EXECUTE')
     OR has_function_privilege('anon',
       'private.reference_curated_public_envelope(uuid,integer,text,uuid)',
       'EXECUTE')
     OR has_function_privilege('anon',
       'private.public_species_taxon_identities(text[])','EXECUTE') THEN
    RAISE EXCEPTION 'public/private curated read grants are incorrect';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=procedure.pronamespace
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=procedure.proowner
     WHERE (namespace.nspname,procedure.proname) IN (
       ('public','search_public_curated_reference_sets'),
       ('public','get_public_curated_reference_set'),
       ('private','public_species_taxon_identities'),
       ('private','reference_curated_public_envelope')
     )
       AND (procedure.prosecdef IS NOT TRUE
         OR owner_role.rolname <> 'postgres'
         OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'public read boundary lacks definer/search-path hardening';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claims','{"role":"anon"}',true);
  SET LOCAL ROLE anon;
  IF (SELECT count(*) FROM public.search_public_curated_reference_sets(
       taxon_a,50,NULL,NULL
     )) <> 3 THEN
    RAISE EXCEPTION 'anonymous exact-taxon search did not enforce expected public set';
  END IF;
  caught:=false;
  BEGIN
    PERFORM public.search_public_curated_reference_sets(taxon_a,51,NULL,NULL);
  EXCEPTION WHEN invalid_parameter_value THEN caught:=true;
  END;
  IF NOT caught THEN RAISE EXCEPTION 'anonymous hard cap was bypassed'; END IF;
  IF (SELECT count(*) FROM public.get_public_curated_reference_set(set_a,2)) <> 2
     OR has_function_privilege('anon',
       'public._search_public_species_stage6f(integer,integer,text,text)','EXECUTE')
     OR has_function_privilege('anon',
       'public._get_public_species_stage6f(text)','EXECUTE') THEN
    RAISE EXCEPTION 'anonymous exact read or legacy wrapper isolation failed';
  END IF;
  IF has_function_privilege('authenticated',
       'public._search_public_species_stage6f(integer,integer,text,text)','EXECUTE')
     OR has_function_privilege('service_role',
       'public._search_public_species_stage6f(integer,integer,text,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public._get_public_species_stage6f(text)','EXECUTE')
     OR has_function_privilege('service_role',
       'public._get_public_species_stage6f(text)','EXECUTE') THEN
    RAISE EXCEPTION 'renamed legacy species implementation remained executable';
  END IF;
  RESET ROLE;

  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000006799","role":"authenticated"}',
    true
  );
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM public.get_public_curated_reference_set(set_a,2)) <> 2 THEN
    RAISE EXCEPTION 'authenticated exact read failed';
  END IF;
  RESET ROLE;
END
$$;

ROLLBACK;
