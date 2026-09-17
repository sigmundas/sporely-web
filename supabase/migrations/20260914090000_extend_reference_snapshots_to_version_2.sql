-- Reported-statistics Stage 3D: observation-reference snapshot version 2.
--
-- Contract: sporely-py docs/reference-data/measurement-content-contract.md
-- section 7 (rollout steps 2 and 3). Version 2 is version 1 with
-- schema_version 2, q_core_min/q_core_max inside the numeric-only
-- measurements mapping (17 keys) and one new top-level measurement_details
-- key holding the decoded details object or null. The whole snapshot stays
-- within 65536 bytes and the details object within 4096 bytes of its compact
-- canonical encoding, measured with private.reference_jsonb_compact_text from
-- migration 20260913120000.
--
-- Deploy order. 20260913120000 is already applied in production; this
-- migration is the only pending one in the pair.
--
-- The invariant to protect is that no version-2 snapshot may reach a desktop
-- that cannot read one. That is governed by when the first *enhanced row*
-- appears, not by when this migration is applied, so this migration may be
-- applied before any desktop release:
--
--   * reference_canonical_snapshot emits version 2 only for an enhanced row
--     (measurement_details_json, q_core_min or q_core_max non-NULL).
--   * An enhanced row can only be written through
--     public.sync_reference_measurement_set_unthrottled, which requires all
--     three extension keys to be present; `authenticated` holds only SELECT on
--     public.reference_measurement_sets, and no edge function or web client
--     writes those columns.
--   * A payload carrying none of the three keys leaves them NULL, so every
--     client released before the Stage 3C adapter can only create legacy rows.
--
-- Therefore, until a desktop release carries the Stage 3C writer and the
-- activation gates open, no enhanced row exists, this migration emits no
-- version-2 snapshot, and every existing snapshot, attachment and curated
-- publication keeps its exact version-1 representation. The real gate on
-- version-2 emission is the minimum-supported-reader-version gate in
-- sporely-py (references/measurement_content_gates.py), which ships closed.
--
-- The converse ordering was a hard constraint and is already satisfied:
-- 20260913120000 had to be applied *before* any desktop release carrying the
-- Stage 3C adapter, because that adapter sends all three keys on every
-- measurement-set payload and a pre-migration server rejects each one through
-- the unknown-keys allowlist. It is applied, and no such desktop has shipped.
--
-- Scope note: private.curated_reference_measurement_sets has no extension
-- columns and private.reference_curated_snapshot names its columns
-- explicitly, so the curation pipeline still publishes version-1 bundles.
-- The CHECK and the public curated reader are relaxed here so that storing a
-- version-2 bundle is a schema decision rather than a constraint rewrite, but
-- carrying enhanced content through curated storage is separate work.

BEGIN;

-- Bound the details schema_version to the set the server knows, {1}.
--
-- 20260913120000 accepted any other integer version opaquely and returned
-- true without inspecting the object. That is deliberately corrected here,
-- in the same migration that first exposes the object, because this migration
-- makes private.public_reference_snapshot preserve measurement_details and
-- forward it verbatim to the reader RPCs granted to anon. Leaving the opaque
-- branch in place would publish arbitrary client-supplied JSON, bounded only
-- by the 4096-byte size limit. Contract section 9 item 7: "The server accepts
-- only schema_version values it knows (1 at first deployment)".
--
-- Opaque acceptance of a future version remains a desktop-side rule (contract
-- section 3, UnsupportedMeasurementDetails), where the object has already come
-- from a trusted server. It is not a server rule. A later version is enabled
-- by extending the set below together with that version's structural rules.
--
-- The body is otherwise byte-identical to 20260913120000, which stays applied
-- and unedited; only the version branch changes. This also makes the
-- corresponding non-1 branch of private.reference_measurement_content_valid
-- unreachable, so that function needs no replacement: it consults
-- reference_measurement_details_valid first and now fails there.
CREATE OR REPLACE FUNCTION private.reference_measurement_details_valid(p_details jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_version jsonb; v_metrics jsonb; v_body jsonb; v_metric text; v_median jsonb;
BEGIN
  IF p_details IS NULL THEN RETURN true; END IF;
  IF pg_catalog.jsonb_typeof(p_details) <> 'object' THEN RETURN false; END IF;
  v_version := p_details->'schema_version';
  IF v_version IS NULL OR pg_catalog.jsonb_typeof(v_version) <> 'number'
     OR (v_version#>>'{}')::numeric <> pg_catalog.trunc((v_version#>>'{}')::numeric) THEN
    RETURN false;
  END IF;
  -- Supported details schema versions: {1}. Compared as numeric so that a
  -- version outside integer range is rejected rather than raising on cast.
  IF (v_version#>>'{}')::numeric <> 1 THEN RETURN false; END IF;
  IF NOT (p_details ?& ARRAY['schema_version','metrics'])
     OR private.reference_payload_has_unknown_keys(p_details, ARRAY['schema_version','metrics']) THEN
    RETURN false;
  END IF;
  v_metrics := p_details->'metrics';
  IF pg_catalog.jsonb_typeof(v_metrics) <> 'object' OR v_metrics = '{}'::jsonb
     OR private.reference_payload_has_unknown_keys(v_metrics, ARRAY['length','width','q']) THEN
    RETURN false;
  END IF;
  FOR v_metric, v_body IN SELECT e.key, e.value FROM pg_catalog.jsonb_each(v_metrics) e LOOP
    IF pg_catalog.jsonb_typeof(v_body) <> 'object' OR v_body = '{}'::jsonb
       OR private.reference_payload_has_unknown_keys(
            v_body, ARRAY['outer_range','core_range','mean_interval','median','sd']) THEN
      RETURN false;
    END IF;
    IF (v_body ? 'outer_range')
       AND NOT private.reference_range_descriptor_valid(v_body->'outer_range', ARRAY['reported_extremes']) THEN
      RETURN false;
    END IF;
    IF (v_body ? 'core_range')
       AND NOT private.reference_range_descriptor_valid(
             v_body->'core_range',
             ARRAY['unspecified','typical_range','reported_range','percentile_interval']) THEN
      RETURN false;
    END IF;
    IF (v_body ? 'mean_interval')
       AND NOT private.reference_interval_statistic_valid(v_body->'mean_interval') THEN
      RETURN false;
    END IF;
    IF v_body ? 'median' THEN
      v_median := v_body->'median';
      IF NOT (private.reference_scalar_statistic_valid(v_median, true)
              OR private.reference_interval_statistic_valid(v_median)) THEN
        RETURN false;
      END IF;
    END IF;
    IF (v_body ? 'sd') AND NOT private.reference_scalar_statistic_valid(v_body->'sd', false) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- Version-keyed exact key sets. A snapshot is validated at exactly one shape;
-- an unknown version fails rather than being read as version 1, and a
-- version-1 snapshot may not carry the version-2 keys.
CREATE OR REPLACE FUNCTION private.reference_snapshot_valid(
  p_snapshot jsonb,
  p_work_id uuid,
  p_treatment_id uuid,
  p_set_id uuid,
  p_reference_revision integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_snapshot IS NOT NULL
    AND pg_catalog.jsonb_typeof(p_snapshot) = 'object'
    AND pg_catalog.octet_length(p_snapshot::text) <= 65536
    AND p_snapshot->>'schema_version' IN ('1','2')
    AND p_snapshot->>'reference_work_id' = p_work_id::text
    AND p_snapshot->>'reference_treatment_id' = p_treatment_id::text
    AND p_snapshot->>'reference_measurement_set_id' = p_set_id::text
    AND p_snapshot->>'reference_revision' = p_reference_revision::text
    AND NOT private.reference_payload_has_unknown_keys(p_snapshot, shape.top_keys)
    AND p_snapshot ?& shape.top_keys
    AND pg_catalog.jsonb_typeof(p_snapshot->'measurements') = 'object'
    AND pg_catalog.jsonb_typeof(p_snapshot->'method') = 'object'
    AND NOT private.reference_payload_has_unknown_keys(p_snapshot->'measurements', shape.measurement_keys)
    AND (p_snapshot->'measurements') ?& shape.measurement_keys
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot->'measurements') x WHERE pg_catalog.jsonb_typeof(x.value) NOT IN ('number','null'))
    AND NOT private.reference_payload_has_unknown_keys(p_snapshot->'method', ARRAY['mount_medium','stain','preparation','measurement_method'])
    AND (p_snapshot->'method') ?& ARRAY['mount_medium','stain','preparation','measurement_method']
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot->'method') x WHERE pg_catalog.jsonb_typeof(x.value) NOT IN ('string','null'))
    AND pg_catalog.jsonb_typeof(p_snapshot->'raw_points') IN ('array','null')
    AND pg_catalog.jsonb_typeof(p_snapshot->'schema_version') = 'number'
    AND pg_catalog.jsonb_typeof(p_snapshot->'reference_revision') = 'number'
    AND pg_catalog.jsonb_typeof(p_snapshot->'short_label') = 'string'
    AND pg_catalog.jsonb_typeof(p_snapshot->'full_citation') = 'string'
    AND btrim(p_snapshot->>'short_label') <> ''
    AND btrim(p_snapshot->>'full_citation') <> ''
    AND p_snapshot->>'work_type' IN ('book','article','chapter','website','dataset','other')
    AND nullif(btrim(p_snapshot->>'name_as_published'),'') IS NOT NULL
    AND p_snapshot->>'character' = 'spore_size'
    AND p_snapshot->>'data_kind' IN ('range','summary','raw_points','parmasto')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot) x
      WHERE x.key=ANY(ARRAY['reference_work_id','reference_treatment_id','reference_measurement_set_id','work_type','doi','isbn','taxon_id','name_as_published','locator_text','character','data_kind','raw_text'])
        AND pg_catalog.jsonb_typeof(x.value) NOT IN ('string','null')
    )
    AND CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'raw_points')='null' THEN true
      ELSE pg_catalog.jsonb_array_length(p_snapshot->'raw_points')>0 END
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot) x
      WHERE x.key=ANY(ARRAY['year','page_from','page_to'])
        AND (pg_catalog.jsonb_typeof(x.value) NOT IN ('number','null') OR
          (pg_catalog.jsonb_typeof(x.value)='number' AND (x.value#>>'{}')::numeric<>pg_catalog.trunc((x.value#>>'{}')::numeric)))
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot->'measurements') x
      WHERE x.key=ANY(ARRAY['sample_size','specimen_count']) AND pg_catalog.jsonb_typeof(x.value)='number'
        AND (x.value#>>'{}')::numeric<>pg_catalog.trunc((x.value#>>'{}')::numeric)
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'raw_points')='array' THEN p_snapshot->'raw_points' ELSE '[]'::jsonb END) point
      WHERE pg_catalog.jsonb_typeof(point) NOT IN ('number','boolean','object')
         OR (pg_catalog.jsonb_typeof(point)='object' AND (
           NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(point) v
             WHERE v.key=ANY(ARRAY['length','width','l','w']) AND pg_catalog.jsonb_typeof(v.value) IN ('number','boolean'))))
    )
    -- Version 2 only: the details object is object-or-null, structurally valid
    -- for its own schema_version, and within the 4096-byte canonical limit.
    AND CASE WHEN p_snapshot->>'schema_version' <> '2' THEN true ELSE
      pg_catalog.jsonb_typeof(p_snapshot->'measurement_details') IN ('object','null')
      AND CASE WHEN pg_catalog.jsonb_typeof(p_snapshot->'measurement_details') = 'null' THEN true ELSE
        private.reference_measurement_details_valid(p_snapshot->'measurement_details')
        AND pg_catalog.octet_length(
          private.reference_jsonb_compact_text(p_snapshot->'measurement_details')
        ) <= 4096
      END
    END
  FROM (
    SELECT
      CASE WHEN p_snapshot->>'schema_version' = '2' THEN ARRAY[
      'schema_version','reference_work_id','reference_treatment_id','reference_measurement_set_id',
      'reference_revision','short_label','full_citation','work_type','year','doi','isbn','taxon_id',
      'name_as_published','locator_text','page_from','page_to','character','data_kind','raw_text',
      'measurements','method','raw_points','measurement_details'
      ] ELSE ARRAY[
      'schema_version','reference_work_id','reference_treatment_id','reference_measurement_set_id',
      'reference_revision','short_label','full_citation','work_type','year','doi','isbn','taxon_id',
      'name_as_published','locator_text','page_from','page_to','character','data_kind','raw_text',
      'measurements','method','raw_points'
      ] END AS top_keys,
      CASE WHEN p_snapshot->>'schema_version' = '2' THEN ARRAY[
      'length_min','length_core_min','length_core_max','length_max','width_min','width_core_min',
      'width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean','sample_size','specimen_count','q_core_min','q_core_max'
      ] ELSE ARRAY[
      'length_min','length_core_min','length_core_max','length_max','width_min','width_core_min',
      'width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean','sample_size','specimen_count'
      ] END AS measurement_keys
  ) AS shape
$$;

-- The canonical snapshot follows the row: version 1 for a legacy-only row,
-- byte-identical to what it produced before, and version 2 for an enhanced
-- one. Composing with || keeps the version-1 object literally unchanged.
CREATE OR REPLACE FUNCTION private.reference_canonical_snapshot(p_user_id uuid, p_set_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'schema_version',
      CASE WHEN m.measurement_details_json IS NOT NULL OR m.q_core_min IS NOT NULL OR m.q_core_max IS NOT NULL
        THEN 2 ELSE 1 END,
    'reference_work_id',w.id,'reference_measurement_set_id',m.id,
    'reference_treatment_id',t.id,'reference_revision',m.revision,'short_label',
      coalesce(nullif(btrim(w.short_label),''),nullif(concat_ws(' ',nullif(private.reference_agent_list(w.authors_json,false),''),w.year::text),''),btrim(w.title)),
    'full_citation',private.reference_full_citation(w),'work_type',w.type,'year',w.year,'doi',w.doi,
    'isbn',w.isbn,'taxon_id',t.taxon_id,'name_as_published',t.name_as_published,
    'locator_text',t.locator_text,'page_from',t.page_from,'page_to',t.page_to,'character',m.character,
    'data_kind',m.data_kind,'raw_text',m.raw_text,
    'measurements',pg_catalog.jsonb_build_object(
      'length_min',m.length_min,'length_core_min',m.length_core_min,'length_core_max',m.length_core_max,
      'length_max',m.length_max,'width_min',m.width_min,'width_core_min',m.width_core_min,
      'width_core_max',m.width_core_max,'width_max',m.width_max,'q_min',m.q_min,'q_max',m.q_max,
      'q_mean',m.q_mean,'length_mean',m.length_mean,'width_mean',m.width_mean,
      'sample_size',m.sample_size,'specimen_count',m.specimen_count)
      || CASE WHEN m.measurement_details_json IS NOT NULL OR m.q_core_min IS NOT NULL OR m.q_core_max IS NOT NULL
        THEN pg_catalog.jsonb_build_object('q_core_min',m.q_core_min,'q_core_max',m.q_core_max)
        ELSE '{}'::jsonb END,
    'method',pg_catalog.jsonb_build_object('mount_medium',m.mount_medium,'stain',m.stain,
      'preparation',m.preparation,'measurement_method',m.measurement_method),
    'raw_points',m.raw_points_json)
    || CASE WHEN m.measurement_details_json IS NOT NULL OR m.q_core_min IS NOT NULL OR m.q_core_max IS NOT NULL
      THEN pg_catalog.jsonb_build_object('measurement_details',m.measurement_details_json)
      ELSE '{}'::jsonb END
  FROM public.reference_measurement_sets m
  JOIN public.reference_taxon_treatments t ON t.user_id=m.user_id AND t.id=m.taxon_treatment_id
  JOIN public.reference_works w ON w.user_id=t.user_id AND w.id=t.reference_work_id
  WHERE m.user_id=p_user_id AND m.id=p_set_id AND m.deleted_at IS NULL AND t.deleted_at IS NULL AND w.deleted_at IS NULL
$$;

-- The public projection rebuilds measurements from an explicit key list, so
-- without this change it would drop the version-2 extension on the way out.
-- It now preserves it, and still emits exactly the version-1 object for a
-- version-1 snapshot.
CREATE OR REPLACE FUNCTION private.public_reference_snapshot(
  p_snapshot jsonb,
  p_measurement_set_id uuid,
  p_reference_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_work_id uuid;
  v_treatment_id uuid;
  v_raw_points jsonb;
  v_enhanced boolean;
BEGIN
  BEGIN
    v_work_id := (p_snapshot->>'reference_work_id')::uuid;
    v_treatment_id := (p_snapshot->>'reference_treatment_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  IF private.reference_snapshot_valid(
    p_snapshot,
    v_work_id,
    v_treatment_id,
    p_measurement_set_id,
    p_reference_revision
  ) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  v_enhanced := p_snapshot->>'schema_version' = '2';

  IF pg_catalog.jsonb_typeof(p_snapshot->'raw_points') = 'array' THEN
    SELECT pg_catalog.jsonb_agg(
      CASE
        WHEN pg_catalog.jsonb_typeof(point.value) IN ('number','boolean')
          THEN point.value
        ELSE
          (CASE WHEN point.value ? 'length' AND pg_catalog.jsonb_typeof(point.value->'length') IN ('number','boolean') THEN pg_catalog.jsonb_build_object('length',point.value->'length') ELSE '{}'::jsonb END) ||
          (CASE WHEN point.value ? 'width' AND pg_catalog.jsonb_typeof(point.value->'width') IN ('number','boolean') THEN pg_catalog.jsonb_build_object('width',point.value->'width') ELSE '{}'::jsonb END) ||
          (CASE WHEN point.value ? 'l' AND pg_catalog.jsonb_typeof(point.value->'l') IN ('number','boolean') THEN pg_catalog.jsonb_build_object('l',point.value->'l') ELSE '{}'::jsonb END) ||
          (CASE WHEN point.value ? 'w' AND pg_catalog.jsonb_typeof(point.value->'w') IN ('number','boolean') THEN pg_catalog.jsonb_build_object('w',point.value->'w') ELSE '{}'::jsonb END) ||
          (CASE WHEN point.value ? 'q' AND pg_catalog.jsonb_typeof(point.value->'q') IN ('number','boolean') THEN pg_catalog.jsonb_build_object('q',point.value->'q') ELSE '{}'::jsonb END)
      END
      ORDER BY point.ordinality
    ) INTO v_raw_points
    FROM pg_catalog.jsonb_array_elements(p_snapshot->'raw_points') WITH ORDINALITY AS point(value,ordinality);
  ELSE
    v_raw_points := NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schema_version',p_snapshot->'schema_version',
    'reference_work_id',p_snapshot->'reference_work_id',
    'reference_treatment_id',p_snapshot->'reference_treatment_id',
    'reference_measurement_set_id',p_snapshot->'reference_measurement_set_id',
    'reference_revision',p_snapshot->'reference_revision',
    'short_label',p_snapshot->'short_label',
    'full_citation',p_snapshot->'full_citation',
    'work_type',p_snapshot->'work_type',
    'year',p_snapshot->'year',
    'doi',p_snapshot->'doi',
    'isbn',p_snapshot->'isbn',
    'taxon_id',p_snapshot->'taxon_id',
    'name_as_published',p_snapshot->'name_as_published',
    'locator_text',p_snapshot->'locator_text',
    'page_from',p_snapshot->'page_from',
    'page_to',p_snapshot->'page_to',
    'character',p_snapshot->'character',
    'data_kind',p_snapshot->'data_kind',
    'raw_text',p_snapshot->'raw_text',
    'measurements',pg_catalog.jsonb_build_object(
      'length_min',p_snapshot->'measurements'->'length_min',
      'length_core_min',p_snapshot->'measurements'->'length_core_min',
      'length_core_max',p_snapshot->'measurements'->'length_core_max',
      'length_max',p_snapshot->'measurements'->'length_max',
      'width_min',p_snapshot->'measurements'->'width_min',
      'width_core_min',p_snapshot->'measurements'->'width_core_min',
      'width_core_max',p_snapshot->'measurements'->'width_core_max',
      'width_max',p_snapshot->'measurements'->'width_max',
      'q_min',p_snapshot->'measurements'->'q_min',
      'q_max',p_snapshot->'measurements'->'q_max',
      'q_mean',p_snapshot->'measurements'->'q_mean',
      'length_mean',p_snapshot->'measurements'->'length_mean',
      'width_mean',p_snapshot->'measurements'->'width_mean',
      'sample_size',p_snapshot->'measurements'->'sample_size',
      'specimen_count',p_snapshot->'measurements'->'specimen_count'
    ) || CASE WHEN v_enhanced THEN pg_catalog.jsonb_build_object(
      'q_core_min',p_snapshot->'measurements'->'q_core_min',
      'q_core_max',p_snapshot->'measurements'->'q_core_max'
    ) ELSE '{}'::jsonb END,
    'method',pg_catalog.jsonb_build_object(
      'mount_medium',p_snapshot->'method'->'mount_medium',
      'stain',p_snapshot->'method'->'stain',
      'preparation',p_snapshot->'method'->'preparation',
      'measurement_method',p_snapshot->'method'->'measurement_method'
    ),
    'raw_points',v_raw_points
  ) || CASE WHEN v_enhanced THEN pg_catalog.jsonb_build_object(
    'measurement_details',p_snapshot->'measurement_details'
  ) ELSE '{}'::jsonb END;
END
$$;

-- Curated publications may record a version-2 bundle. Existing rows are all
-- version 1 and satisfy the relaxed constraint, so this validates without a
-- rewrite of stored data.
ALTER TABLE private.curated_reference_publications
  DROP CONSTRAINT curated_reference_publications_snapshot_schema_version_check;
ALTER TABLE private.curated_reference_publications
  ADD CONSTRAINT curated_reference_publications_snapshot_schema_version_check
  CHECK (snapshot_schema_version IN (1, 2));

-- Curation intake: the candidate carries the three extension fields, all or
-- none. They are not required, because candidates captured before this
-- migration legitimately lack them; the capture function below is the only
-- writer and always emits all three, so a partially acknowledging candidate
-- can only come from a damaged payload and is rejected (contract section 8).
ALTER TABLE private.reference_curation_submission_versions
  DROP CONSTRAINT reference_curation_submission_versions_candidate_json_check;
ALTER TABLE private.reference_curation_submission_versions
  ADD CONSTRAINT reference_curation_submission_versions_candidate_json_check
  CHECK (
    candidate_json IS NULL OR (
    pg_catalog.jsonb_typeof(candidate_json) = 'object'
    AND pg_catalog.octet_length(candidate_json::text) <= 65536
    AND candidate_json->>'schema_version' = '1'
    AND candidate_json ?& ARRAY['schema_version', 'work', 'treatment', 'measurement_set']
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json, ARRAY['schema_version', 'work', 'treatment', 'measurement_set']
    )
    AND pg_catalog.jsonb_typeof(candidate_json->'work') = 'object'
    AND pg_catalog.jsonb_typeof(candidate_json->'treatment') = 'object'
    AND pg_catalog.jsonb_typeof(candidate_json->'measurement_set') = 'object'
    AND (candidate_json->'work') ?& ARRAY[
      'type', 'authors', 'editors', 'title', 'container_title', 'year',
      'edition', 'publisher', 'place', 'volume', 'issue', 'pages', 'doi',
      'isbn', 'url', 'language', 'short_label', 'citation_override'
    ]
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json->'work', ARRAY[
        'type', 'authors', 'editors', 'title', 'container_title', 'year',
        'edition', 'publisher', 'place', 'volume', 'issue', 'pages', 'doi',
        'isbn', 'url', 'language', 'short_label', 'citation_override'
      ]
    )
    AND (candidate_json->'treatment') ?&
      ARRAY['name_as_published', 'page_from', 'page_to', 'locator_text']
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json->'treatment',
      ARRAY['name_as_published', 'page_from', 'page_to', 'locator_text']
    )
    AND (candidate_json->'measurement_set') ?& ARRAY[
      'character', 'raw_text', 'data_kind', 'length_min',
      'length_core_min', 'length_core_max', 'length_max', 'width_min',
      'width_core_min', 'width_core_max', 'width_max', 'q_min', 'q_max',
      'q_mean', 'length_mean', 'width_mean', 'sample_size',
      'specimen_count', 'mount_medium', 'stain', 'preparation',
      'measurement_method', 'raw_points'
    ]
    AND NOT private.reference_payload_has_unknown_keys(
      candidate_json->'measurement_set', ARRAY[
        'character', 'raw_text', 'data_kind', 'length_min',
        'length_core_min', 'length_core_max', 'length_max', 'width_min',
        'width_core_min', 'width_core_max', 'width_max', 'q_min', 'q_max',
        'q_mean', 'length_mean', 'width_mean', 'sample_size',
        'specimen_count', 'mount_medium', 'stain', 'preparation',
        'measurement_method', 'raw_points',
        'measurement_details_json', 'q_core_min', 'q_core_max'
      ]
    )
    AND (
      (candidate_json->'measurement_set')
        ?& ARRAY['measurement_details_json', 'q_core_min', 'q_core_max']
      OR NOT (candidate_json->'measurement_set')
        ?| ARRAY['measurement_details_json', 'q_core_min', 'q_core_max']
    )
    AND (
      pg_catalog.jsonb_typeof(candidate_json->'measurement_set'->'measurement_details_json')
        IS DISTINCT FROM 'object'
      OR private.reference_measurement_details_valid(
        candidate_json->'measurement_set'->'measurement_details_json'
      )
    )
    )
  );

-- Relaxed version guard only; body copied verbatim from
-- 20260829220943_add_public_curated_reference_reads.sql.
CREATE OR REPLACE FUNCTION private.reference_curated_public_envelope(
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

  IF v_publication.snapshot_schema_version NOT IN (1, 2)
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

-- Three added keys only; body copied verbatim from
-- 20260829145939_add_reference_curation_intake.sql.
CREATE OR REPLACE FUNCTION private.reference_curation_capture_candidate(
  p_owner uuid,
  p_source_measurement_set_id uuid,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_work public.reference_works%ROWTYPE;
  v_treatment public.reference_taxon_treatments%ROWTYPE;
  v_set public.reference_measurement_sets%ROWTYPE;
  v_candidate jsonb;
  v_authors jsonb;
  v_editors jsonb;
  v_raw_points jsonb;
BEGIN
  SELECT * INTO v_set
    FROM public.reference_measurement_sets m
   WHERE m.user_id = p_owner
     AND m.id = p_source_measurement_set_id
     AND m.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_not_found_or_stale');
  END IF;
  SELECT * INTO v_treatment
    FROM public.reference_taxon_treatments t
   WHERE t.user_id = p_owner
     AND t.id = v_set.taxon_treatment_id
     AND t.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_not_found_or_stale');
  END IF;
  SELECT * INTO v_work
    FROM public.reference_works w
   WHERE w.user_id = p_owner
     AND w.id = v_treatment.reference_work_id
     AND w.deleted_at IS NULL
   FOR SHARE;
  IF NOT FOUND
     OR v_work.revision IS DISTINCT FROM p_expected_work_revision
     OR v_treatment.revision IS DISTINCT FROM p_expected_treatment_revision
     OR v_set.revision IS DISTINCT FROM p_expected_measurement_set_revision THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_not_found_or_stale');
  END IF;

  v_authors := private.reference_curation_project_agents(v_work.authors_json);
  v_editors := private.reference_curation_project_agents(v_work.editors_json);
  v_raw_points := private.reference_curation_project_raw_points(v_set.raw_points_json);

  IF char_length(v_work.title) > 2048
     OR btrim(v_work.title) = ''
     OR char_length(v_work.short_label) > 512
     OR btrim(v_work.short_label) = ''
     OR char_length(v_work.container_title) > 2048
     OR (v_work.year IS NOT NULL AND (v_work.year < 1 OR v_work.year > 9999))
     OR char_length(v_work.edition) > 256
     OR char_length(v_work.publisher) > 1024
     OR char_length(v_work.place) > 1024
     OR char_length(v_work.volume) > 128
     OR char_length(v_work.issue) > 128
     OR char_length(v_work.pages) > 256
     OR char_length(v_work.doi) > 255
     OR (v_work.doi IS NOT NULL AND btrim(v_work.doi) = '')
     OR char_length(v_work.isbn) > 64
     OR (v_work.isbn IS NOT NULL AND btrim(v_work.isbn) = '')
     OR char_length(v_work.url) > 2048
     OR (v_work.url IS NOT NULL AND v_work.url !~* '^https?://')
     OR char_length(v_work.language) > 64
     OR char_length(v_work.citation_override) > 8192
     OR pg_catalog.octet_length(v_work.authors_json::text) > 65536
     OR pg_catalog.octet_length(v_work.editors_json::text) > 65536
     OR v_authors IS NULL
     OR v_editors IS NULL
     OR char_length(v_treatment.name_as_published) > 1024
     OR char_length(v_treatment.locator_text) > 1024
     OR char_length(v_set.raw_text) > 8192
     OR char_length(v_set.mount_medium) > 1024
     OR char_length(v_set.stain) > 1024
     OR char_length(v_set.preparation) > 2048
     OR char_length(v_set.measurement_method) > 2048
     OR pg_catalog.octet_length(v_set.raw_points_json::text) > 65536
     OR (v_set.raw_points_json IS NOT NULL AND v_raw_points IS NULL)
     OR v_set.length_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_core_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_core_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_core_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_core_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.q_min::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.q_max::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.q_mean::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.length_mean::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_set.width_mean::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_out_of_bounds');
  END IF;

  v_candidate := pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'work', pg_catalog.jsonb_build_object(
      'type', v_work.type,
      'authors', v_authors,
      'editors', v_editors,
      'title', v_work.title,
      'container_title', v_work.container_title,
      'year', v_work.year,
      'edition', v_work.edition,
      'publisher', v_work.publisher,
      'place', v_work.place,
      'volume', v_work.volume,
      'issue', v_work.issue,
      'pages', v_work.pages,
      'doi', v_work.doi,
      'isbn', v_work.isbn,
      'url', v_work.url,
      'language', v_work.language,
      'short_label', v_work.short_label,
      'citation_override', v_work.citation_override
    ),
    'treatment', pg_catalog.jsonb_build_object(
      'name_as_published', v_treatment.name_as_published,
      'page_from', v_treatment.page_from,
      'page_to', v_treatment.page_to,
      'locator_text', v_treatment.locator_text
    ),
    'measurement_set', pg_catalog.jsonb_build_object(
      'character', v_set.character,
      'raw_text', v_set.raw_text,
      'data_kind', v_set.data_kind,
      'length_min', v_set.length_min,
      'length_core_min', v_set.length_core_min,
      'length_core_max', v_set.length_core_max,
      'length_max', v_set.length_max,
      'width_min', v_set.width_min,
      'width_core_min', v_set.width_core_min,
      'width_core_max', v_set.width_core_max,
      'width_max', v_set.width_max,
      'q_min', v_set.q_min,
      'q_max', v_set.q_max,
      'q_mean', v_set.q_mean,
      'length_mean', v_set.length_mean,
      'width_mean', v_set.width_mean,
      'sample_size', v_set.sample_size,
      'specimen_count', v_set.specimen_count,
      'mount_medium', v_set.mount_medium,
      'stain', v_set.stain,
      'preparation', v_set.preparation,
      'measurement_method', v_set.measurement_method,
      'raw_points', v_raw_points,
      -- Always all three, never a subset: key presence is what
      -- acknowledges the contract (contract section 8).
      'measurement_details_json', v_set.measurement_details_json,
      'q_core_min', v_set.q_core_min,
      'q_core_max', v_set.q_core_max
    )
  );
  IF pg_catalog.octet_length(v_candidate::text) > 65536 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'source_out_of_bounds');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'ok', 'candidate', v_candidate);
END
$$;

COMMIT;
