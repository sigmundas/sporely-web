-- Stage 6g exact-taxonomy public curated-reference reads.
--
-- The catalogue surface reads immutable publication bundles only. Operational
-- activation remains disabled until the anonymous rate policy is configured.

BEGIN;

CREATE FUNCTION private.public_species_taxon_identities(p_species_slugs text[])
RETURNS TABLE(species_slug text, taxon_identity jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH resolved_ids AS (
    SELECT DISTINCT
           nullif(pg_catalog.regexp_replace(
             pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(pg_catalog.concat_ws(
                 ' ', nullif(pg_catalog.btrim(coalesce(o.genus, '')), ''),
                 nullif(pg_catalog.btrim(coalesce(o.species, '')), '')
               ))), '[^a-z0-9]+', '-', 'g'
             ), '(^-|-$)', '', 'g'
           ), '') AS species_slug,
           o.resolved_sporely_taxon_id AS sporely_taxon_id
      FROM public.observations o
     WHERE o.resolved_sporely_taxon_id IS NOT NULL
       AND nullif(pg_catalog.regexp_replace(
             pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(pg_catalog.concat_ws(
                 ' ', nullif(pg_catalog.btrim(coalesce(o.genus, '')), ''),
                 nullif(pg_catalog.btrim(coalesce(o.species, '')), '')
               ))), '[^a-z0-9]+', '-', 'g'
             ), '(^-|-$)', '', 'g'
           ), '') = ANY (p_species_slugs)
       AND o.visibility = 'public'
       AND NOT coalesce(o.is_draft, false)
       AND NOT EXISTS (
         SELECT 1 FROM public.profiles profile
          WHERE profile.id = o.user_id AND profile.is_banned = true
       )
       AND (
         auth.uid() IS NULL
         OR public.is_blocked_between(auth.uid(), o.user_id) IS NOT TRUE
       )
  ), exact_identity AS (
    SELECT resolved_ids.species_slug,
           pg_catalog.min(resolved_ids.sporely_taxon_id) AS sporely_taxon_id
      FROM resolved_ids
     GROUP BY resolved_ids.species_slug
    HAVING pg_catalog.count(*) = 1
  )
  SELECT identity.species_slug,
         pg_catalog.jsonb_build_object(
    'sporelyTaxonId', concept.sporely_taxon_id,
    'canonicalScientificName', concept.canonical_name
  ) AS taxon_identity
    FROM exact_identity identity
    JOIN taxonomy_v3.registry_concept concept
      ON concept.sporely_taxon_id = identity.sporely_taxon_id
   WHERE concept.sporely_taxon_id > 0
     AND concept.rank = 'species'
     AND nullif(pg_catalog.btrim(concept.canonical_name), '') IS NOT NULL
     AND pg_catalog.char_length(concept.canonical_name) <= 1024
$$;

ALTER FUNCTION private.public_species_taxon_identities(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.public_species_taxon_identities(text[])
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.search_public_species(integer, integer, text, text)
  RENAME TO _search_public_species_stage6f;
REVOKE ALL ON FUNCTION public._search_public_species_stage6f(integer, integer, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.search_public_species(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_genus text DEFAULT NULL::text,
  p_query text DEFAULT NULL::text
)
RETURNS TABLE(
  "speciesSlug" text,
  genus text,
  species text,
  "speciesName" text,
  "commonName" text,
  "observationCount" bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount" bigint,
  "firstObservedOn" date,
  "lastObservedOn" date,
  countries jsonb,
  regions jsonb,
  "representativeThumbUrl" text,
  "representativeImageId" bigint,
  "representativeMediaVersion" bigint,
  "representativeThumbMediaUrl" text,
  "taxonIdentity" jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH legacy AS MATERIALIZED (
    SELECT * FROM public._search_public_species_stage6f(
      p_limit, p_offset, p_genus, p_query
    )
  ), identities AS MATERIALIZED (
    SELECT identity.*
      FROM private.public_species_taxon_identities(
        (SELECT pg_catalog.array_agg(legacy."speciesSlug") FROM legacy)
      ) identity
  )
  SELECT legacy.*, identities.taxon_identity AS "taxonIdentity"
    FROM legacy
    LEFT JOIN identities ON identities.species_slug = legacy."speciesSlug"
   ORDER BY legacy."observationCount" DESC,
            legacy."lastObservedOn" DESC,
            legacy."speciesName" ASC,
            legacy."speciesSlug" ASC
$$;

ALTER FUNCTION public.search_public_species(integer, integer, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_public_species(integer, integer, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_species(integer, integer, text, text)
  TO anon, authenticated, service_role;

ALTER FUNCTION public.get_public_species(text)
  RENAME TO _get_public_species_stage6f;
REVOKE ALL ON FUNCTION public._get_public_species_stage6f(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_public_species(p_species_slug text)
RETURNS TABLE(
  "speciesSlug" text,
  genus text,
  species text,
  "speciesName" text,
  "commonName" text,
  "observationCount" bigint,
  "microscopyObservationCount" bigint,
  "sporeMeasurementCount" bigint,
  "firstObservedOn" date,
  "lastObservedOn" date,
  countries jsonb,
  regions jsonb,
  "representativeThumbUrl" text,
  "recentObservationIds" bigint[],
  "representativeImageId" bigint,
  "representativeMediaVersion" bigint,
  "representativeThumbMediaUrl" text,
  "taxonIdentity" jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH legacy AS MATERIALIZED (
    SELECT * FROM public._get_public_species_stage6f(p_species_slug)
  ), identities AS MATERIALIZED (
    SELECT identity.*
      FROM private.public_species_taxon_identities(
        (SELECT pg_catalog.array_agg(legacy."speciesSlug") FROM legacy)
      ) identity
  )
  SELECT legacy.*, identities.taxon_identity AS "taxonIdentity"
    FROM legacy
    LEFT JOIN identities ON identities.species_slug = legacy."speciesSlug"
$$;

ALTER FUNCTION public.get_public_species(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_public_species(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_species(text)
  TO anon, authenticated, service_role;

CREATE FUNCTION private.reference_curated_public_agents_valid(p_agents jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_typeof(p_agents) = 'array'
    AND pg_catalog.octet_length(p_agents::text) <= 65536
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_agents) agent
       WHERE CASE pg_catalog.jsonb_typeof(agent)
         WHEN 'string' THEN nullif(pg_catalog.btrim(agent #>> '{}'), '') IS NULL
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
         ELSE true
       END
    )
$$;

CREATE FUNCTION private.reference_curated_public_citation(
  p_citation jsonb,
  p_citation_key text,
  p_csl jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_key text;
  v_value jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(p_citation) <> 'object'
     OR pg_catalog.octet_length(p_citation::text) > 65536
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_citation)) <> 20
     OR NOT (p_citation ?& ARRAY[
       'schema_version','citation_key','type','authors','editors','title',
       'container_title','year','edition','publisher','place','volume','issue',
       'pages','doi','isbn','url','language','short_citation','full_citation'
     ])
     OR p_citation->>'schema_version' <> '1'
     OR pg_catalog.jsonb_typeof(p_citation->'schema_version') <> 'number'
     OR p_citation->>'type' NOT IN ('book','article','chapter','website','dataset','other')
     OR private.reference_curated_public_agents_valid(p_citation->'authors') IS NOT TRUE
     OR private.reference_curated_public_agents_valid(p_citation->'editors') IS NOT TRUE
     OR pg_catalog.jsonb_typeof(p_citation->'title') <> 'string'
     OR nullif(pg_catalog.btrim(p_citation->>'title'), '') IS NULL
     OR pg_catalog.jsonb_typeof(p_citation->'short_citation') <> 'string'
     OR nullif(pg_catalog.btrim(p_citation->>'short_citation'), '') IS NULL
     OR pg_catalog.jsonb_typeof(p_citation->'full_citation') <> 'string'
     OR nullif(pg_catalog.btrim(p_citation->>'full_citation'), '') IS NULL
     OR pg_catalog.char_length(p_citation->>'title') > 2048
     OR pg_catalog.char_length(p_citation->>'short_citation') > 512
     OR pg_catalog.char_length(p_citation->>'full_citation') > 65536
     OR pg_catalog.jsonb_typeof(p_csl) <> 'object'
     OR p_csl->>'id' IS DISTINCT FROM p_citation_key THEN
    RETURN NULL;
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'citation_key','container_title','edition','publisher','place','volume',
    'issue','pages','doi','isbn','url','language'
  ] LOOP
    v_value := p_citation->v_key;
    IF pg_catalog.jsonb_typeof(v_value) NOT IN ('string','null')
       OR pg_catalog.char_length(coalesce(v_value #>> '{}', '')) > (CASE v_key
         WHEN 'citation_key' THEN 128
         WHEN 'container_title' THEN 2048
         WHEN 'edition' THEN 256
         WHEN 'publisher' THEN 1024
         WHEN 'place' THEN 1024
         WHEN 'volume' THEN 128
         WHEN 'issue' THEN 128
         WHEN 'pages' THEN 256
         WHEN 'doi' THEN 255
         WHEN 'isbn' THEN 64
         WHEN 'url' THEN 2048
         WHEN 'language' THEN 64
       END) THEN
      RETURN NULL;
    END IF;
  END LOOP;
  IF pg_catalog.jsonb_typeof(p_citation->'year') NOT IN ('number','null')
     OR (pg_catalog.jsonb_typeof(p_citation->'year') = 'number' AND (
       (p_citation->>'year') !~ '^[0-9]{1,4}$'
       OR (p_citation->>'year')::integer NOT BETWEEN 1 AND 9999
     )) THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.jsonb_typeof(p_citation->'url') = 'string'
     AND nullif(pg_catalog.btrim(p_citation->>'url'), '') IS NOT NULL
     AND p_citation->>'url' !~* '^https?://' THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version', p_citation->'schema_version',
    'citation_key', pg_catalog.to_jsonb(p_citation_key),
    'type', p_citation->'type',
    'authors', p_citation->'authors',
    'editors', p_citation->'editors',
    'title', p_citation->'title',
    'container_title', p_citation->'container_title',
    'year', p_citation->'year',
    'edition', p_citation->'edition',
    'publisher', p_citation->'publisher',
    'place', p_citation->'place',
    'volume', p_citation->'volume',
    'issue', p_citation->'issue',
    'pages', p_citation->'pages',
    'doi', coalesce(p_csl->'DOI', 'null'::jsonb),
    'isbn', p_citation->'isbn',
    'url', p_citation->'url',
    'language', p_citation->'language',
    'short_citation', p_citation->'short_citation',
    'full_citation', p_citation->'full_citation'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION private.reference_curated_public_envelope(
  p_curated_measurement_set_id uuid,
  p_bundle_revision integer,
  p_status text,
  p_superseded_by_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_publication private.curated_reference_publications%ROWTYPE;
  v_artifact private.curated_reference_citation_exports%ROWTYPE;
  v_expected jsonb;
  v_snapshot jsonb;
  v_citation jsonb;
  v_csl jsonb;
  v_source_hash text;
  v_plain_hash text;
  v_bibtex_hash text;
  v_csl_hash text;
  v_artifact_hash text;
BEGIN
  IF p_status NOT IN ('published','deprecated') THEN
    RETURN NULL;
  END IF;
  SELECT publication.* INTO v_publication
    FROM private.curated_reference_publications publication
   WHERE publication.curated_measurement_set_id = p_curated_measurement_set_id
     AND publication.bundle_revision = p_bundle_revision;
  SELECT artifact.* INTO v_artifact
    FROM private.curated_reference_citation_exports artifact
   WHERE artifact.curated_measurement_set_id = p_curated_measurement_set_id
     AND artifact.bundle_revision = p_bundle_revision;
  IF v_publication.curated_measurement_set_id IS NULL
     OR v_artifact.curated_measurement_set_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_publication.snapshot_schema_version <> 1
     OR private.reference_snapshot_valid(
       v_publication.snapshot_json,
       v_publication.curated_work_id,
       v_publication.curated_taxon_treatment_id,
       v_publication.curated_measurement_set_id,
       v_publication.bundle_revision
     ) IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  v_snapshot := private.public_reference_snapshot(
    v_publication.snapshot_json,
    v_publication.curated_measurement_set_id,
    v_publication.bundle_revision
  );
  IF v_snapshot IS NULL THEN RETURN NULL; END IF;

  v_expected := private.reference_curated_build_citation_exports(
    v_publication.citation_json, v_publication.curated_work_id
  );
  v_csl := (v_expected->>'csl_json')::jsonb;
  v_source_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'citation_schema_version', v_publication.citation_schema_version,
      'citation', v_publication.citation_json,
      'curated_work_id', v_publication.curated_work_id,
      'work_revision', v_publication.work_revision
    )::text, 'UTF8'
  ), 'sha256'), 'hex');
  v_plain_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_expected->>'plain_text', 'UTF8'), 'sha256'
  ), 'hex');
  v_bibtex_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_expected->>'bibtex', 'UTF8'), 'sha256'
  ), 'hex');
  v_csl_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(v_expected->>'csl_json', 'UTF8'), 'sha256'
  ), 'hex');
  v_artifact_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.octet_length(v_expected->>'citation_key')::text || ':'
      || (v_expected->>'citation_key')
      || pg_catalog.octet_length(v_expected->>'plain_text')::text || ':'
      || (v_expected->>'plain_text')
      || pg_catalog.octet_length(v_expected->>'bibtex')::text || ':'
      || (v_expected->>'bibtex')
      || pg_catalog.octet_length(v_expected->>'csl_json')::text || ':'
      || (v_expected->>'csl_json'), 'UTF8'
  ), 'sha256'), 'hex');

  IF v_artifact.export_schema_version <> 1
     OR v_artifact.source_work_id IS DISTINCT FROM v_publication.curated_work_id
     OR v_artifact.source_work_revision IS DISTINCT FROM v_publication.work_revision
     OR v_artifact.source_citation_schema_version
        IS DISTINCT FROM v_publication.citation_schema_version
     OR v_artifact.source_citation_hash IS DISTINCT FROM v_source_hash
     OR v_artifact.citation_key IS DISTINCT FROM v_expected->>'citation_key'
     OR v_artifact.plain_text IS DISTINCT FROM v_expected->>'plain_text'
     OR v_artifact.bibtex IS DISTINCT FROM v_expected->>'bibtex'
     OR v_artifact.csl_json IS DISTINCT FROM v_expected->>'csl_json'
     OR v_artifact.plain_text_sha256 IS DISTINCT FROM v_plain_hash
     OR v_artifact.bibtex_sha256 IS DISTINCT FROM v_bibtex_hash
     OR v_artifact.csl_json_sha256 IS DISTINCT FROM v_csl_hash
     OR v_artifact.artifact_hash IS DISTINCT FROM v_artifact_hash THEN
    RETURN NULL;
  END IF;
  v_citation := private.reference_curated_public_citation(
    v_publication.citation_json, v_artifact.citation_key, v_csl
  );
  IF v_citation IS NULL THEN RETURN NULL; END IF;

  RETURN pg_catalog.jsonb_build_object(
    'curated_measurement_set_id', v_publication.curated_measurement_set_id,
    'bundle_revision', v_publication.bundle_revision,
    'status', p_status,
    'superseded_by_id', p_superseded_by_id,
    'published_at', v_publication.published_at,
    'snapshot', v_snapshot,
    'citation', v_citation,
    'exports', pg_catalog.jsonb_build_object(
      'plain_text', v_artifact.plain_text,
      'bibtex', v_artifact.bibtex,
      'csl_json', v_csl
    )
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

ALTER FUNCTION private.reference_curated_public_agents_valid(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_curated_public_citation(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_curated_public_envelope(uuid,integer,text,uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reference_curated_public_agents_valid(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_public_citation(jsonb,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_curated_public_envelope(uuid,integer,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.search_public_curated_reference_sets(
  p_sporely_taxon_id integer,
  p_limit integer,
  p_after_published_at timestamptz,
  p_after_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_sporely_taxon_id IS NULL OR p_sporely_taxon_id <= 0 THEN
    RAISE EXCEPTION 'positive sporely_taxon_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'limit must be between 1 and 50' USING ERRCODE = '22023';
  END IF;
  IF (p_after_published_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor components are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM taxonomy_v3.registry_concept concept
     WHERE concept.sporely_taxon_id = p_sporely_taxon_id
       AND concept.rank = 'species'
       AND nullif(pg_catalog.btrim(concept.canonical_name), '') IS NOT NULL
       AND pg_catalog.char_length(concept.canonical_name) <= 1024
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT publication.curated_measurement_set_id,
           publication.bundle_revision,
           publication.published_at,
           publication_taxon.sporely_taxon_id,
           publication_taxon.canonical_name,
           measurement_set.catalogue_status,
           successor.id AS superseded_by_id
      FROM private.curated_reference_measurement_sets measurement_set
      JOIN private.curated_reference_publications publication
        ON publication.curated_measurement_set_id = measurement_set.id
       AND publication.bundle_revision = measurement_set.latest_bundle_revision
      JOIN private.curated_reference_publication_taxa publication_taxon
        ON publication_taxon.curated_measurement_set_id = publication.curated_measurement_set_id
       AND publication_taxon.bundle_revision = publication.bundle_revision
      LEFT JOIN LATERAL (
        SELECT candidate.id
          FROM private.curated_reference_measurement_sets candidate
         WHERE candidate.supersedes_id = measurement_set.id
           AND candidate.catalogue_status IN ('published','deprecated')
           AND EXISTS (
             SELECT 1 FROM private.curated_reference_publications successor_publication
              WHERE successor_publication.curated_measurement_set_id = candidate.id
                AND successor_publication.bundle_revision = candidate.latest_bundle_revision
           )
         ORDER BY candidate.id
         LIMIT 1
      ) successor ON true
     WHERE measurement_set.catalogue_status = 'published'
       AND publication_taxon.sporely_taxon_id = p_sporely_taxon_id
       AND NOT EXISTS (
         SELECT 1
           FROM private.curated_reference_publication_taxa assignment_bound
          WHERE assignment_bound.curated_measurement_set_id = publication.curated_measurement_set_id
            AND assignment_bound.bundle_revision = publication.bundle_revision
          ORDER BY assignment_bound.sporely_taxon_id
          OFFSET 100 LIMIT 1
       )
       AND (p_after_published_at IS NULL
         OR publication.published_at < p_after_published_at
         OR (publication.published_at = p_after_published_at
             AND publication.curated_measurement_set_id > p_after_id))
     ORDER BY publication.published_at DESC,
              publication.curated_measurement_set_id ASC
     LIMIT least(p_limit * 4, 100)
  ), projected AS MATERIALIZED (
    SELECT candidate.published_at,
           candidate.curated_measurement_set_id,
           private.reference_curated_public_envelope(
             candidate.curated_measurement_set_id,
             candidate.bundle_revision,
             candidate.catalogue_status,
             candidate.superseded_by_id
           ) || pg_catalog.jsonb_build_object(
             'sporely_taxon_id', candidate.sporely_taxon_id,
             'canonical_scientific_name', candidate.canonical_name
           ) AS item
      FROM candidates candidate
  ), bounded AS (
    SELECT projected.*,
           pg_catalog.sum(pg_catalog.octet_length(projected.item::text)) OVER (
             ORDER BY projected.published_at DESC,
                      projected.curated_measurement_set_id ASC
           ) AS cumulative_bytes
      FROM projected
     WHERE projected.item IS NOT NULL
  )
  SELECT bounded.item
    FROM bounded
   WHERE bounded.cumulative_bytes <= 1048576
   ORDER BY bounded.published_at DESC,
            bounded.curated_measurement_set_id ASC
   LIMIT p_limit;
END
$$;

CREATE FUNCTION public.get_public_curated_reference_set(
  p_curated_measurement_set_id uuid,
  p_bundle_revision integer DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_set private.curated_reference_measurement_sets%ROWTYPE;
  v_revision integer;
  v_successor_id uuid;
  v_item jsonb;
  v_response_bytes bigint;
BEGIN
  IF p_curated_measurement_set_id IS NULL
     OR (p_bundle_revision IS NOT NULL AND p_bundle_revision < 1) THEN
    RAISE EXCEPTION 'valid curated set and revision are required' USING ERRCODE = '22023';
  END IF;
  SELECT measurement_set.* INTO v_set
    FROM private.curated_reference_measurement_sets measurement_set
   WHERE measurement_set.id = p_curated_measurement_set_id;
  IF NOT FOUND OR v_set.catalogue_status = 'draft' THEN RETURN; END IF;
  SELECT successor.id INTO v_successor_id
    FROM private.curated_reference_measurement_sets successor
   WHERE successor.supersedes_id = v_set.id
     AND successor.catalogue_status IN ('published','deprecated')
     AND EXISTS (
       SELECT 1 FROM private.curated_reference_publications successor_publication
        WHERE successor_publication.curated_measurement_set_id = successor.id
          AND successor_publication.bundle_revision = successor.latest_bundle_revision
     )
   ORDER BY successor.id
   LIMIT 1;

  IF v_set.catalogue_status = 'withdrawn' THEN
    IF p_bundle_revision IS NULL OR NOT EXISTS (
      SELECT 1 FROM private.curated_reference_publications publication
       WHERE publication.curated_measurement_set_id = v_set.id
         AND publication.bundle_revision = p_bundle_revision
    ) THEN
      RETURN;
    END IF;
    RETURN NEXT pg_catalog.jsonb_build_object(
      'curated_measurement_set_id', v_set.id,
      'bundle_revision', p_bundle_revision,
      'status', 'withdrawn',
      'withdrawn_at', v_set.withdrawn_at,
      'superseded_by_id', v_successor_id
    );
    RETURN;
  END IF;

  v_revision := coalesce(p_bundle_revision, v_set.latest_bundle_revision);
  IF NOT EXISTS (
    SELECT 1 FROM private.curated_reference_publications publication
     WHERE publication.curated_measurement_set_id = v_set.id
       AND publication.bundle_revision = v_revision
  ) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM private.curated_reference_publication_taxa publication_taxon
     WHERE publication_taxon.curated_measurement_set_id = v_set.id
       AND publication_taxon.bundle_revision = v_revision
     ORDER BY publication_taxon.sporely_taxon_id
     OFFSET 100 LIMIT 1
  ) THEN
    RETURN;
  END IF;
  v_item := private.reference_curated_public_envelope(
    v_set.id, v_revision, v_set.catalogue_status, v_successor_id
  );
  IF v_item IS NULL THEN RETURN; END IF;
  SELECT coalesce(pg_catalog.sum(pg_catalog.octet_length((
           v_item || pg_catalog.jsonb_build_object(
             'sporely_taxon_id', publication_taxon.sporely_taxon_id,
             'canonical_scientific_name', publication_taxon.canonical_name
           )
         )::text)), 0)
    INTO v_response_bytes
    FROM private.curated_reference_publication_taxa publication_taxon
   WHERE publication_taxon.curated_measurement_set_id = v_set.id
     AND publication_taxon.bundle_revision = v_revision;
  IF v_response_bytes > 1048576 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT v_item || pg_catalog.jsonb_build_object(
           'sporely_taxon_id', publication_taxon.sporely_taxon_id,
           'canonical_scientific_name', publication_taxon.canonical_name
         )
    FROM private.curated_reference_publication_taxa publication_taxon
   WHERE publication_taxon.curated_measurement_set_id = v_set.id
     AND publication_taxon.bundle_revision = v_revision
   ORDER BY publication_taxon.sporely_taxon_id;
END
$$;

ALTER FUNCTION public.search_public_curated_reference_sets(integer,integer,timestamptz,uuid)
  OWNER TO postgres;
ALTER FUNCTION public.get_public_curated_reference_set(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_public_curated_reference_sets(integer,integer,timestamptz,uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_curated_reference_set(uuid,integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_curated_reference_sets(integer,integer,timestamptz,uuid)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_curated_reference_set(uuid,integer)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.search_public_curated_reference_sets(integer,integer,timestamptz,uuid)
  IS 'Exact taxonomy-v3 species lookup over current immutable published curated bundles. Candidate inspection is capped at 100 and output at 50 items/1 MiB; operational rate activation remains external.';
COMMENT ON FUNCTION public.get_public_curated_reference_set(uuid,integer)
  IS 'Reads one immutable curated publication revision with at most 100 exact assignments/1 MiB, or an explicit withdrawn status tombstone.';
COMMENT ON FUNCTION public.search_public_species(integer,integer,text,text)
  IS 'Existing species search with additive nullable exact taxonomy-v3 taxonIdentity.';
COMMENT ON FUNCTION public.get_public_species(text)
  IS 'Existing species detail with additive nullable exact taxonomy-v3 taxonIdentity.';

NOTIFY pgrst, 'reload schema';

COMMIT;
