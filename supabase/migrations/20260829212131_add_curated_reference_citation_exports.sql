-- Dormant Stage 6f citation export artifacts.
--
-- Artifacts are generated only from each immutable publication's frozen
-- citation_json. No public read boundary or catalogue behavior is added here.

BEGIN;

CREATE FUNCTION private.reference_curated_export_clean_text(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_value text;
BEGIN
  v_value := pg_catalog.translate(
    coalesce(p_value, ''),
    U&'\202A\202B\202C\202D\202E\2066\2067\2068\2069',
    ''
  );
  v_value := pg_catalog.regexp_replace(v_value, '[[:cntrl:]]+', ' ', 'g');
  RETURN pg_catalog.btrim(
    pg_catalog.regexp_replace(v_value, '[[:space:]]+', ' ', 'g')
  );
END
$$;

CREATE FUNCTION private.reference_curated_export_normalize_doi(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN v_normalized ~ '^10\.[0-9]{4,9}/[-._;()/:a-z0-9]+$'
      THEN v_normalized
    ELSE NULL
  END
  FROM (
    SELECT NULLIF(pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(p_value, '')),
      '^(doi:[[:space:]]*|https?://(dx\.)?doi\.org/)',
      '',
      'i'
    ))), '') AS v_normalized
  ) normalized
$$;

CREATE FUNCTION private.reference_curated_export_bibtex_text(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_clean text := private.reference_curated_export_clean_text(p_value);
  v_result text := '';
  v_character text;
BEGIN
  FOR v_position IN 1..pg_catalog.char_length(v_clean) LOOP
    v_character := pg_catalog.substr(v_clean, v_position, 1);
    v_result := v_result || CASE v_character
      WHEN E'\\' THEN E'{\\char92}'
      WHEN '{' THEN E'{\\char123}'
      WHEN '}' THEN E'{\\char125}'
      WHEN '#' THEN E'\\#'
      WHEN '%' THEN E'\\%'
      WHEN '&' THEN E'\\&'
      WHEN '_' THEN E'\\_'
      WHEN '$' THEN E'\\$'
      WHEN '~' THEN E'{\\textasciitilde}'
      WHEN '^' THEN E'{\\textasciicircum}'
      ELSE v_character
    END;
  END LOOP;
  RETURN v_result;
END
$$;

CREATE FUNCTION private.reference_curated_export_bibtex_agents(p_agents jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_agent jsonb;
  v_label text;
  v_labels text[] := ARRAY[]::text[];
  v_family text;
  v_given text;
  v_literal text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_agents) <> 'array' THEN
    RETURN '';
  END IF;
  FOR v_agent IN
    SELECT item
      FROM pg_catalog.jsonb_array_elements(p_agents) WITH ORDINALITY a(item, ord)
     ORDER BY ord
  LOOP
    IF pg_catalog.jsonb_typeof(v_agent) = 'string' THEN
      v_literal := private.reference_curated_export_clean_text(v_agent #>> '{}');
      v_label := CASE WHEN v_literal = '' THEN NULL
        ELSE '{' || private.reference_curated_export_bibtex_text(v_literal) || '}' END;
    ELSIF pg_catalog.jsonb_typeof(v_agent) = 'object' THEN
      v_literal := private.reference_curated_export_clean_text(v_agent->>'literal');
      v_family := private.reference_curated_export_clean_text(v_agent->>'family');
      v_given := private.reference_curated_export_clean_text(v_agent->>'given');
      IF v_literal <> '' THEN
        v_label := '{' || private.reference_curated_export_bibtex_text(v_literal) || '}';
      ELSIF v_family <> '' AND v_given <> '' THEN
        v_label := private.reference_curated_export_bibtex_text(v_family)
          || ', ' || private.reference_curated_export_bibtex_text(v_given);
      ELSIF v_family <> '' THEN
        v_label := private.reference_curated_export_bibtex_text(v_family);
      ELSIF v_given <> '' THEN
        v_label := private.reference_curated_export_bibtex_text(v_given);
      ELSE
        v_label := NULL;
      END IF;
    ELSE
      v_label := NULL;
    END IF;
    IF v_label IS NOT NULL THEN
      v_labels := v_labels || v_label;
    END IF;
  END LOOP;
  RETURN pg_catalog.array_to_string(v_labels, ' and ');
END
$$;

CREATE FUNCTION private.reference_curated_export_csl_agents(p_agents jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_result jsonb := '[]'::jsonb;
  v_agent jsonb;
  v_projected jsonb;
  v_family text;
  v_given text;
  v_literal text;
BEGIN
  IF pg_catalog.jsonb_typeof(p_agents) <> 'array' THEN
    RETURN v_result;
  END IF;
  FOR v_agent IN
    SELECT item
      FROM pg_catalog.jsonb_array_elements(p_agents) WITH ORDINALITY a(item, ord)
     ORDER BY ord
  LOOP
    IF pg_catalog.jsonb_typeof(v_agent) = 'string' THEN
      v_literal := private.reference_curated_export_clean_text(v_agent #>> '{}');
      v_projected := CASE WHEN v_literal = '' THEN NULL
        ELSE pg_catalog.jsonb_build_object('literal', v_literal) END;
    ELSIF pg_catalog.jsonb_typeof(v_agent) = 'object' THEN
      v_literal := private.reference_curated_export_clean_text(v_agent->>'literal');
      v_family := private.reference_curated_export_clean_text(v_agent->>'family');
      v_given := private.reference_curated_export_clean_text(v_agent->>'given');
      IF v_literal <> '' THEN
        v_projected := pg_catalog.jsonb_build_object('literal', v_literal);
      ELSIF v_family <> '' OR v_given <> '' THEN
        v_projected := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'family', NULLIF(v_family, ''), 'given', NULLIF(v_given, '')
        ));
      ELSE
        v_projected := NULL;
      END IF;
    ELSE
      v_projected := NULL;
    END IF;
    IF v_projected IS NOT NULL THEN
      v_result := v_result || pg_catalog.jsonb_build_array(v_projected);
    END IF;
  END LOOP;
  RETURN v_result;
END
$$;

CREATE FUNCTION private.reference_curated_build_citation_exports(
  p_citation jsonb,
  p_curated_work_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_type text;
  v_title text;
  v_full_citation text;
  v_citation_key text;
  v_candidate_key text;
  v_doi text;
  v_raw_doi text;
  v_raw_doi_link text;
  v_bibtex_type text;
  v_csl_type text;
  v_bibtex text;
  v_csl jsonb;
  v_agents text;
  v_value text;
  v_year integer;
BEGIN
  IF p_curated_work_id IS NULL
     OR pg_catalog.jsonb_typeof(p_citation) <> 'object'
     OR p_citation->>'schema_version' <> '1'
     OR pg_catalog.jsonb_typeof(p_citation->'title') <> 'string'
     OR pg_catalog.jsonb_typeof(p_citation->'full_citation') <> 'string'
     OR pg_catalog.jsonb_typeof(p_citation->'authors') <> 'array'
     OR pg_catalog.jsonb_typeof(p_citation->'editors') <> 'array' THEN
    RAISE EXCEPTION 'unsupported curated citation payload'
      USING ERRCODE = '22023';
  END IF;
  v_type := p_citation->>'type';
  IF v_type NOT IN ('book', 'article', 'chapter', 'website', 'dataset', 'other') THEN
    RAISE EXCEPTION 'unsupported curated citation type'
      USING ERRCODE = '22023';
  END IF;
  v_title := private.reference_curated_export_clean_text(p_citation->>'title');
  v_full_citation := private.reference_curated_export_clean_text(
    p_citation->>'full_citation'
  );
  IF v_title = '' OR v_full_citation = '' THEN
    RAISE EXCEPTION 'curated citation title and full citation are required'
      USING ERRCODE = '22023';
  END IF;

  v_candidate_key := pg_catalog.btrim(p_citation->>'citation_key');
  IF v_candidate_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$'
     AND pg_catalog.lower(v_candidate_key) NOT LIKE 'sporely-auto-%' THEN
    v_citation_key := v_candidate_key;
  ELSE
    v_citation_key := 'sporely-auto-'
      || pg_catalog.replace(p_curated_work_id::text, '-', '');
  END IF;
  v_raw_doi := private.reference_curated_export_clean_text(p_citation->>'doi');
  v_doi := private.reference_curated_export_normalize_doi(v_raw_doi);
  IF v_raw_doi <> '' THEN
    v_raw_doi_link := 'https://doi.org/' || v_raw_doi;
    IF pg_catalog.right(v_full_citation, pg_catalog.char_length(v_raw_doi_link))
       = v_raw_doi_link THEN
      v_full_citation := private.reference_curated_export_clean_text(
        pg_catalog.concat_ws(
          ' ',
          NULLIF(pg_catalog.left(
            v_full_citation,
            pg_catalog.char_length(v_full_citation)
              - pg_catalog.char_length(v_raw_doi_link)
          ), ''),
          CASE WHEN v_doi IS NOT NULL THEN 'https://doi.org/' || v_doi END
        )
      );
    END IF;
  END IF;
  IF v_full_citation = '' THEN
    RAISE EXCEPTION 'curated citation plain text is required'
      USING ERRCODE = '22023';
  END IF;

  v_bibtex_type := CASE v_type
    WHEN 'book' THEN 'book'
    WHEN 'article' THEN 'article'
    WHEN 'chapter' THEN 'incollection'
    ELSE 'misc'
  END;
  v_csl_type := CASE v_type
    WHEN 'book' THEN 'book'
    WHEN 'article' THEN 'article-journal'
    WHEN 'chapter' THEN 'chapter'
    WHEN 'website' THEN 'webpage'
    WHEN 'dataset' THEN 'dataset'
    ELSE 'document'
  END;

  v_bibtex := '@' || v_bibtex_type || '{' || v_citation_key || E',\n';
  v_agents := private.reference_curated_export_bibtex_agents(p_citation->'authors');
  IF v_agents <> '' THEN
    v_bibtex := v_bibtex || '  author = {' || v_agents || E'},\n';
  END IF;
  v_agents := private.reference_curated_export_bibtex_agents(p_citation->'editors');
  IF v_agents <> '' THEN
    v_bibtex := v_bibtex || '  editor = {' || v_agents || E'},\n';
  END IF;
  v_bibtex := v_bibtex || '  title = {'
    || private.reference_curated_export_bibtex_text(v_title) || E'},\n';
  v_value := private.reference_curated_export_clean_text(p_citation->>'container_title');
  IF v_value <> '' THEN
    v_bibtex := v_bibtex || '  ' || CASE v_type
      WHEN 'article' THEN 'journal'
      WHEN 'chapter' THEN 'booktitle'
      ELSE 'howpublished' END || ' = {'
      || private.reference_curated_export_bibtex_text(v_value) || E'},\n';
  END IF;
  IF pg_catalog.jsonb_typeof(p_citation->'year') = 'number'
     AND (p_citation->>'year') ~ '^[0-9]{1,4}$' THEN
    v_year := (p_citation->>'year')::integer;
    IF v_year BETWEEN 1 AND 9999 THEN
      v_bibtex := v_bibtex || '  year = {' || v_year::text || E'},\n';
    ELSE
      v_year := NULL;
    END IF;
  END IF;
  FOR v_value IN SELECT field_name FROM (VALUES
    ('edition'), ('publisher'), ('volume'), ('pages'), ('isbn'), ('url'), ('language')
  ) fields(field_name)
  LOOP
    IF private.reference_curated_export_clean_text(p_citation->>v_value) <> '' THEN
      v_bibtex := v_bibtex || '  ' || v_value || ' = {'
        || private.reference_curated_export_bibtex_text(p_citation->>v_value)
        || E'},\n';
    END IF;
  END LOOP;
  v_value := private.reference_curated_export_clean_text(p_citation->>'place');
  IF v_value <> '' THEN
    v_bibtex := v_bibtex || '  address = {'
      || private.reference_curated_export_bibtex_text(v_value) || E'},\n';
  END IF;
  v_value := private.reference_curated_export_clean_text(p_citation->>'issue');
  IF v_value <> '' THEN
    v_bibtex := v_bibtex || '  number = {'
      || private.reference_curated_export_bibtex_text(v_value) || E'},\n';
  END IF;
  IF v_doi IS NOT NULL THEN
    v_bibtex := v_bibtex || '  doi = {'
      || private.reference_curated_export_bibtex_text(v_doi) || E'},\n';
  END IF;
  v_bibtex := v_bibtex || E'}\n';

  v_csl := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'id', v_citation_key,
    'type', v_csl_type,
    'author', CASE WHEN pg_catalog.jsonb_array_length(
      private.reference_curated_export_csl_agents(p_citation->'authors')
    ) > 0 THEN private.reference_curated_export_csl_agents(p_citation->'authors') END,
    'editor', CASE WHEN pg_catalog.jsonb_array_length(
      private.reference_curated_export_csl_agents(p_citation->'editors')
    ) > 0 THEN private.reference_curated_export_csl_agents(p_citation->'editors') END,
    'title', v_title,
    'container-title', NULLIF(private.reference_curated_export_clean_text(
      p_citation->>'container_title'), ''),
    'issued', CASE WHEN v_year IS NOT NULL THEN pg_catalog.jsonb_build_object(
      'date-parts', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(v_year))
    ) END,
    'edition', NULLIF(private.reference_curated_export_clean_text(p_citation->>'edition'), ''),
    'publisher', NULLIF(private.reference_curated_export_clean_text(p_citation->>'publisher'), ''),
    'publisher-place', NULLIF(private.reference_curated_export_clean_text(p_citation->>'place'), ''),
    'volume', NULLIF(private.reference_curated_export_clean_text(p_citation->>'volume'), ''),
    'issue', NULLIF(private.reference_curated_export_clean_text(p_citation->>'issue'), ''),
    'page', NULLIF(private.reference_curated_export_clean_text(p_citation->>'pages'), ''),
    'DOI', v_doi,
    'ISBN', NULLIF(private.reference_curated_export_clean_text(p_citation->>'isbn'), ''),
    'URL', NULLIF(private.reference_curated_export_clean_text(p_citation->>'url'), ''),
    'language', NULLIF(private.reference_curated_export_clean_text(p_citation->>'language'), '')
  ));

  RETURN pg_catalog.jsonb_build_object(
    'citation_key', v_citation_key,
    'plain_text', v_full_citation || E'\n',
    'bibtex', v_bibtex,
    'csl_json', v_csl::text || E'\n'
  );
END
$$;

CREATE TABLE private.curated_reference_citation_exports (
  curated_measurement_set_id uuid NOT NULL,
  bundle_revision integer NOT NULL CHECK (bundle_revision >= 1),
  export_schema_version integer NOT NULL DEFAULT 1 CHECK (export_schema_version = 1),
  source_work_id uuid NOT NULL,
  source_work_revision integer NOT NULL CHECK (source_work_revision >= 1),
  source_citation_schema_version integer NOT NULL CHECK (source_citation_schema_version = 1),
  source_citation_hash text NOT NULL CHECK (source_citation_hash ~ '^[0-9a-f]{64}$'),
  citation_key text NOT NULL CHECK (
    citation_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$'
  ),
  plain_text text NOT NULL CHECK (
    plain_text <> '' AND octet_length(plain_text) <= 65536
  ),
  bibtex text NOT NULL CHECK (
    bibtex <> '' AND octet_length(bibtex) <= 131072
  ),
  csl_json text NOT NULL CHECK (
    octet_length(csl_json) <= 131072
    AND pg_catalog.jsonb_typeof(csl_json::jsonb) = 'object'
  ),
  plain_text_sha256 text NOT NULL CHECK (plain_text_sha256 ~ '^[0-9a-f]{64}$'),
  bibtex_sha256 text NOT NULL CHECK (bibtex_sha256 ~ '^[0-9a-f]{64}$'),
  csl_json_sha256 text NOT NULL CHECK (csl_json_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (curated_measurement_set_id, bundle_revision),
  FOREIGN KEY (curated_measurement_set_id, bundle_revision)
    REFERENCES private.curated_reference_publications(
      curated_measurement_set_id, bundle_revision
    ) ON DELETE RESTRICT
);

CREATE INDEX curated_reference_citation_exports_work_idx
  ON private.curated_reference_citation_exports(
    source_work_id, source_work_revision, curated_measurement_set_id, bundle_revision
  );
CREATE INDEX curated_reference_citation_exports_source_hash_idx
  ON private.curated_reference_citation_exports(source_citation_hash);

CREATE FUNCTION private.reference_curated_materialize_citation_exports(
  p_curated_measurement_set_id uuid,
  p_bundle_revision integer
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_publication private.curated_reference_publications%ROWTYPE;
  v_exports jsonb;
  v_source_hash text;
  v_plain_hash text;
  v_bibtex_hash text;
  v_csl_hash text;
  v_artifact_hash text;
  v_existing private.curated_reference_citation_exports%ROWTYPE;
BEGIN
  SELECT p.* INTO v_publication
    FROM private.curated_reference_publications p
   WHERE p.curated_measurement_set_id = p_curated_measurement_set_id
     AND p.bundle_revision = p_bundle_revision
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown curated publication bundle'
      USING ERRCODE = '23503';
  END IF;
  v_exports := private.reference_curated_build_citation_exports(
    v_publication.citation_json, v_publication.curated_work_id
  );
  v_source_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'citation_schema_version', v_publication.citation_schema_version,
      'citation', v_publication.citation_json,
      'curated_work_id', v_publication.curated_work_id,
      'work_revision', v_publication.work_revision
    )::text, 'UTF8'
  ), 'sha256'), 'hex');
  v_plain_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_exports->>'plain_text', 'UTF8'), 'sha256'
  ), 'hex');
  v_bibtex_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_exports->>'bibtex', 'UTF8'), 'sha256'
  ), 'hex');
  v_csl_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_exports->>'csl_json', 'UTF8'), 'sha256'
  ), 'hex');
  v_artifact_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.octet_length(v_exports->>'citation_key')::text || ':'
      || (v_exports->>'citation_key')
      || pg_catalog.octet_length(v_exports->>'plain_text')::text || ':'
      || (v_exports->>'plain_text')
      || pg_catalog.octet_length(v_exports->>'bibtex')::text || ':'
      || (v_exports->>'bibtex')
      || pg_catalog.octet_length(v_exports->>'csl_json')::text || ':'
      || (v_exports->>'csl_json'),
    'UTF8'
  ), 'sha256'), 'hex');

  INSERT INTO private.curated_reference_citation_exports(
    curated_measurement_set_id, bundle_revision, export_schema_version,
    source_work_id, source_work_revision, source_citation_schema_version,
    source_citation_hash, citation_key, plain_text, bibtex, csl_json,
    plain_text_sha256, bibtex_sha256, csl_json_sha256, artifact_hash
  ) VALUES (
    v_publication.curated_measurement_set_id, v_publication.bundle_revision, 1,
    v_publication.curated_work_id, v_publication.work_revision,
    v_publication.citation_schema_version, v_source_hash,
    v_exports->>'citation_key', v_exports->>'plain_text', v_exports->>'bibtex',
    v_exports->>'csl_json', v_plain_hash, v_bibtex_hash, v_csl_hash, v_artifact_hash
  ) ON CONFLICT (curated_measurement_set_id, bundle_revision) DO NOTHING;

  SELECT e.* INTO v_existing
    FROM private.curated_reference_citation_exports e
   WHERE e.curated_measurement_set_id = v_publication.curated_measurement_set_id
     AND e.bundle_revision = v_publication.bundle_revision;
  IF v_existing.export_schema_version IS DISTINCT FROM 1
     OR v_existing.source_work_id IS DISTINCT FROM v_publication.curated_work_id
     OR v_existing.source_work_revision IS DISTINCT FROM v_publication.work_revision
     OR v_existing.source_citation_schema_version
        IS DISTINCT FROM v_publication.citation_schema_version
     OR v_existing.source_citation_hash IS DISTINCT FROM v_source_hash
     OR v_existing.citation_key IS DISTINCT FROM v_exports->>'citation_key'
     OR v_existing.plain_text IS DISTINCT FROM v_exports->>'plain_text'
     OR v_existing.bibtex IS DISTINCT FROM v_exports->>'bibtex'
     OR v_existing.csl_json IS DISTINCT FROM v_exports->>'csl_json'
     OR v_existing.plain_text_sha256 IS DISTINCT FROM v_plain_hash
     OR v_existing.bibtex_sha256 IS DISTINCT FROM v_bibtex_hash
     OR v_existing.csl_json_sha256 IS DISTINCT FROM v_csl_hash
     OR v_existing.artifact_hash IS DISTINCT FROM v_artifact_hash THEN
    RAISE EXCEPTION 'citation export replay disagrees with immutable publication'
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE FUNCTION private.reference_curated_materialize_citation_exports_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.reference_curated_materialize_citation_exports(
    NEW.curated_measurement_set_id, NEW.bundle_revision
  );
  RETURN NEW;
END
$$;

CREATE FUNCTION private.reference_curated_reject_citation_export_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'curated citation exports are append-only'
    USING ERRCODE = '25006';
END
$$;

CREATE TRIGGER curated_reference_publications_exports_trg
  AFTER INSERT ON private.curated_reference_publications
  FOR EACH ROW EXECUTE FUNCTION private.reference_curated_materialize_citation_exports_trigger();
CREATE TRIGGER curated_reference_citation_exports_immutable_trg
  BEFORE UPDATE OR DELETE ON private.curated_reference_citation_exports
  FOR EACH ROW EXECUTE FUNCTION private.reference_curated_reject_citation_export_change();
CREATE TRIGGER curated_reference_citation_exports_no_truncate_trg
  BEFORE TRUNCATE ON private.curated_reference_citation_exports
  FOR EACH STATEMENT EXECUTE FUNCTION private.reference_curated_reject_citation_export_change();

DO $$
DECLARE
  v_publication record;
BEGIN
  FOR v_publication IN
    SELECT p.curated_measurement_set_id, p.bundle_revision
      FROM private.curated_reference_publications p
     ORDER BY p.curated_measurement_set_id, p.bundle_revision
  LOOP
    PERFORM private.reference_curated_materialize_citation_exports(
      v_publication.curated_measurement_set_id, v_publication.bundle_revision
    );
  END LOOP;
END
$$;

ALTER TABLE private.curated_reference_citation_exports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.curated_reference_citation_exports
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON private.curated_reference_citation_exports TO service_role;

REVOKE ALL ON FUNCTION private.reference_curated_export_clean_text(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_export_normalize_doi(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_export_bibtex_text(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_export_bibtex_agents(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_export_csl_agents(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_build_citation_exports(jsonb, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_materialize_citation_exports(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_materialize_citation_exports_trigger()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_reject_citation_export_change()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
