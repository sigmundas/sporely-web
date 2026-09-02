-- Stage 6l cross-client contract: desktop and landing accept at most 100
-- citation agents. Keep intake and immutable public envelopes at that bound.

BEGIN;

ALTER TABLE private.curated_reference_works
  ADD CONSTRAINT reference_curated_works_authors_client_bound
    CHECK (pg_catalog.jsonb_array_length(authors_json) <= 100),
  ADD CONSTRAINT reference_curated_works_editors_client_bound
    CHECK (pg_catalog.jsonb_array_length(editors_json) <= 100);

ALTER TABLE private.reference_curation_submission_versions
  ADD CONSTRAINT reference_curation_candidates_authors_client_bound
    CHECK (pg_catalog.jsonb_array_length(candidate_json->'work'->'authors') <= 100),
  ADD CONSTRAINT reference_curation_candidates_editors_client_bound
    CHECK (pg_catalog.jsonb_array_length(candidate_json->'work'->'editors') <= 100);

CREATE FUNCTION private.reference_curated_utf16_length(p_value text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.sum(
    CASE WHEN pg_catalog.ascii(ch) > 65535 THEN 2 ELSE 1 END
  ), 0)::integer
    FROM pg_catalog.regexp_split_to_table(p_value, '') ch
$$;

CREATE OR REPLACE FUNCTION private.reference_curation_project_agents(p_agents jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_agent jsonb;
  v_projected jsonb := '[]'::jsonb;
  v_item jsonb;
  v_family text;
  v_given text;
  v_literal text;
BEGIN
  IF p_agents IS NULL OR pg_catalog.jsonb_typeof(p_agents) <> 'array'
     OR pg_catalog.jsonb_array_length(p_agents) > 100 THEN
    RETURN NULL;
  END IF;
  FOR v_agent IN SELECT value FROM pg_catalog.jsonb_array_elements(p_agents) LOOP
    v_item := '{}'::jsonb;
    IF pg_catalog.jsonb_typeof(v_agent) = 'string' THEN
      v_family := pg_catalog.btrim(v_agent #>> '{}');
      IF v_family <> '' THEN
        IF private.reference_curated_utf16_length(v_family) > 1024 THEN RETURN NULL; END IF;
        v_projected := v_projected || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('family', v_family)
        );
      END IF;
      CONTINUE;
    END IF;
    IF pg_catalog.jsonb_typeof(v_agent) <> 'object' THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(v_agent) f
       WHERE f.key = ANY(ARRAY['family', 'given', 'literal'])
         AND pg_catalog.jsonb_typeof(f.value) NOT IN ('string', 'null')
    ) THEN
      RETURN NULL;
    END IF;
    v_family := pg_catalog.btrim(coalesce(v_agent->>'family', ''));
    v_given := pg_catalog.btrim(coalesce(v_agent->>'given', ''));
    v_literal := pg_catalog.btrim(coalesce(v_agent->>'literal', ''));
    IF private.reference_curated_utf16_length(v_family) > 1024
       OR private.reference_curated_utf16_length(v_given) > 1024
       OR private.reference_curated_utf16_length(v_literal) > 1024 THEN
      RETURN NULL;
    END IF;
    IF v_family <> '' THEN v_item := v_item || pg_catalog.jsonb_build_object('family', v_family); END IF;
    IF v_given <> '' THEN v_item := v_item || pg_catalog.jsonb_build_object('given', v_given); END IF;
    IF v_literal <> '' THEN v_item := v_item || pg_catalog.jsonb_build_object('literal', v_literal); END IF;
    IF v_item <> '{}'::jsonb THEN
      v_projected := v_projected || pg_catalog.jsonb_build_array(v_item);
    END IF;
  END LOOP;
  RETURN v_projected;
END
$$;

CREATE OR REPLACE FUNCTION private.reference_curated_public_agents_valid(p_agents jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_typeof(p_agents) = 'array'
    AND pg_catalog.jsonb_array_length(p_agents) <= 100
    AND pg_catalog.octet_length(p_agents::text) <= 65536
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_agents) agent
       WHERE CASE pg_catalog.jsonb_typeof(agent)
         WHEN 'string' THEN
           nullif(pg_catalog.btrim(agent #>> '{}'), '') IS NULL
           OR private.reference_curated_utf16_length(agent #>> '{}') > 1024
         WHEN 'object' THEN
           EXISTS (
             SELECT 1 FROM pg_catalog.jsonb_object_keys(agent) key
              WHERE key <> ALL (ARRAY['family','given','literal'])
           )
           OR NOT EXISTS (
             SELECT 1 FROM pg_catalog.jsonb_each(agent) item
              WHERE item.key = ANY (ARRAY['family','given','literal'])
                AND pg_catalog.jsonb_typeof(item.value) = 'string'
                AND nullif(pg_catalog.btrim(item.value #>> '{}'), '') IS NOT NULL
           )
           OR EXISTS (
             SELECT 1 FROM pg_catalog.jsonb_each(agent) item
              WHERE pg_catalog.jsonb_typeof(item.value) NOT IN ('string','null')
           )
           OR EXISTS (
             SELECT 1 FROM pg_catalog.jsonb_each(agent) item
              WHERE pg_catalog.jsonb_typeof(item.value) = 'string'
                AND private.reference_curated_utf16_length(item.value #>> '{}') > 1024
           )
         ELSE true
       END
    )
$$;

ALTER TABLE private.curated_reference_works
  ADD CONSTRAINT reference_curated_works_authors_public_valid
    CHECK (private.reference_curated_public_agents_valid(authors_json)),
  ADD CONSTRAINT reference_curated_works_editors_public_valid
    CHECK (private.reference_curated_public_agents_valid(editors_json));

REVOKE ALL ON FUNCTION private.reference_curation_project_agents(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_public_agents_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_utf16_length(text)
  FROM PUBLIC, anon, authenticated, service_role;
-- The trusted maintenance role writes curated drafts directly; PostgreSQL
-- evaluates the validated CHECK through these two pure predicates.
GRANT EXECUTE ON FUNCTION private.reference_curated_public_agents_valid(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION private.reference_curated_utf16_length(text)
  TO service_role;

COMMIT;
