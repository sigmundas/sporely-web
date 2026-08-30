-- Stage 6l client/server citation-agent cardinality contract.

BEGIN;

DO $$
DECLARE
  agents_100 jsonb;
  agents_101 jsonb;
  agent_1024 jsonb;
  agent_1025 jsonb;
  astral_1024_units jsonb;
  astral_1026_units jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('family', 'Agent ' || n) ORDER BY n)
    INTO agents_100 FROM generate_series(1, 100) n;
  SELECT jsonb_agg(jsonb_build_object('family', 'Agent ' || n) ORDER BY n)
    INTO agents_101 FROM generate_series(1, 101) n;
  agent_1024 := jsonb_build_array(jsonb_build_object('family', repeat('x', 1024)));
  agent_1025 := jsonb_build_array(jsonb_build_object('family', repeat('x', 1025)));
  astral_1024_units := jsonb_build_array(jsonb_build_object('family', repeat('🍄', 512)));
  astral_1026_units := jsonb_build_array(jsonb_build_object('family', repeat('🍄', 513)));

  IF private.reference_curation_project_agents(agents_100) IS NULL
     OR private.reference_curated_public_agents_valid(agents_100) IS NOT TRUE THEN
    RAISE EXCEPTION '100 citation agents must remain valid';
  END IF;
  IF private.reference_curation_project_agents(agents_101) IS NOT NULL
     OR private.reference_curated_public_agents_valid(agents_101) IS NOT FALSE THEN
    RAISE EXCEPTION '101 citation agents exceeded the cross-client contract';
  END IF;
  IF private.reference_curation_project_agents(agent_1024) IS NULL
     OR private.reference_curated_public_agents_valid(agent_1024) IS NOT TRUE
     OR private.reference_curation_project_agents(agent_1025) IS NOT NULL
     OR private.reference_curated_public_agents_valid(agent_1025) IS NOT FALSE THEN
    RAISE EXCEPTION 'citation-agent text bounds differ from activated clients';
  END IF;
  IF private.reference_curation_project_agents(astral_1024_units) IS NULL
     OR private.reference_curated_public_agents_valid(astral_1024_units) IS NOT TRUE
     OR private.reference_curation_project_agents(astral_1026_units) IS NOT NULL
     OR private.reference_curated_public_agents_valid(astral_1026_units) IS NOT FALSE THEN
    RAISE EXCEPTION 'citation-agent UTF-16 bounds differ from landing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname IN (
       'reference_curated_works_authors_client_bound',
       'reference_curated_works_editors_client_bound',
       'reference_curation_candidates_authors_client_bound',
       'reference_curation_candidates_editors_client_bound',
       'reference_curated_works_authors_public_valid',
       'reference_curated_works_editors_public_valid'
     ) AND convalidated IS NOT TRUE
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_constraint
     WHERE conname IN (
       'reference_curated_works_authors_client_bound',
       'reference_curated_works_editors_client_bound',
       'reference_curation_candidates_authors_client_bound',
       'reference_curation_candidates_editors_client_bound',
       'reference_curated_works_authors_public_valid',
       'reference_curated_works_editors_public_valid'
     )
  ) <> 6 THEN
    RAISE EXCEPTION 'citation-agent bounds are not validated on stored evidence';
  END IF;
END
$$;

ROLLBACK;
