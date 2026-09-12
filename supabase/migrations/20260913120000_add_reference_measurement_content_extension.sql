-- Reported-statistics Stage 3C: measurement-content extension on the
-- owner-private normalized reference library.
--
-- Contract: sporely-py docs/reference-data/measurement-content-contract.md
-- (sections 1, 2 and 9). Three nullable columns, no default, no backfill and
-- no destructive down step. Row-level validation of the complete candidate
-- row and a request-key-presence guard live in the authoritative mutation
-- implementation public.sync_reference_measurement_set_unthrottled (the
-- public name is the rate-limit wrapper from 20260830193144).
--
-- Unchanged on purpose (Stage 3D): curated snapshot CHECKs,
-- private.reference_snapshot_valid and private.reference_canonical_snapshot.
-- Every existing v1 snapshot and contribution builder names its columns
-- explicitly, so rows carrying the new columns project exactly as before.

ALTER TABLE public.reference_measurement_sets
  ADD COLUMN measurement_details_json jsonb,
  ADD COLUMN q_core_min double precision,
  ADD COLUMN q_core_max double precision;

-- Defence in depth only: object-or-NULL and a loose textual size bound. The
-- exact 4096-byte limit is measured on the compact canonical encoding by the
-- validator below (jsonb::text inserts separator spaces).
ALTER TABLE public.reference_measurement_sets
  ADD CONSTRAINT reference_measurement_sets_details_shape_check CHECK (
    measurement_details_json IS NULL
    OR (pg_catalog.jsonb_typeof(measurement_details_json) = 'object'
        AND pg_catalog.octet_length(measurement_details_json::text) <= 8192)
  );

-- Compact serialization with byte-ordered keys: the same shape as the desktop
-- codec (json.dumps(sort_keys=True, separators=(",", ":"))) for ASCII content,
-- which is all a version-1 details object can contain.
CREATE FUNCTION private.reference_jsonb_compact_text(p_value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_text text;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  CASE pg_catalog.jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT pg_catalog.string_agg(
               pg_catalog.to_jsonb(e.key)::text || ':' || private.reference_jsonb_compact_text(e.value),
               ',' ORDER BY e.key COLLATE "C")
        INTO v_text
        FROM pg_catalog.jsonb_each(p_value) e;
      RETURN '{' || coalesce(v_text, '') || '}';
    WHEN 'array' THEN
      SELECT pg_catalog.string_agg(private.reference_jsonb_compact_text(e.value), ',' ORDER BY e.ordinality)
        INTO v_text
        FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY e(value, ordinality);
      RETURN '[' || coalesce(v_text, '') || ']';
    ELSE
      RETURN p_value::text;
  END CASE;
END $$;

CREATE FUNCTION private.reference_positive_finite(p_value double precision)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_value IS NULL
      OR (p_value <> 'NaN'::double precision
          AND p_value <> 'Infinity'::double precision
          AND p_value > 0)
$$;

CREATE FUNCTION private.reference_pair_ordered(p_lo double precision, p_hi double precision)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_lo IS NULL OR p_hi IS NULL OR p_lo <= p_hi
$$;

-- JSON number (booleans are not numbers), strictly positive or non-negative.
CREATE FUNCTION private.reference_json_number_valid(p_value jsonb, p_positive boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_value IS NOT NULL
     AND pg_catalog.jsonb_typeof(p_value) = 'number'
     AND CASE WHEN p_positive THEN (p_value#>>'{}')::numeric > 0
              ELSE (p_value#>>'{}')::numeric >= 0 END
$$;

-- {"kind": K} or, for percentile_interval only,
-- {"kind": "percentile_interval", "percentile_bounds": [lo, hi]} with
-- 0 <= lo < hi <= 100 (contract section 1).
CREATE FUNCTION private.reference_range_descriptor_valid(p_value jsonb, p_kinds text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_kind text; v_bounds jsonb; v_lo numeric; v_hi numeric;
BEGIN
  IF p_value IS NULL OR pg_catalog.jsonb_typeof(p_value) <> 'object'
     OR NOT (p_value ? 'kind')
     OR private.reference_payload_has_unknown_keys(p_value, ARRAY['kind','percentile_bounds'])
     OR pg_catalog.jsonb_typeof(p_value->'kind') <> 'string' THEN
    RETURN false;
  END IF;
  v_kind := p_value->>'kind';
  IF NOT (v_kind = ANY (p_kinds)) THEN RETURN false; END IF;
  IF v_kind <> 'percentile_interval' THEN
    RETURN NOT (p_value ? 'percentile_bounds');
  END IF;
  v_bounds := p_value->'percentile_bounds';
  IF v_bounds IS NULL OR pg_catalog.jsonb_typeof(v_bounds) <> 'array'
     OR pg_catalog.jsonb_array_length(v_bounds) <> 2
     OR pg_catalog.jsonb_typeof(v_bounds->0) <> 'number'
     OR pg_catalog.jsonb_typeof(v_bounds->1) <> 'number' THEN
    RETURN false;
  END IF;
  v_lo := (v_bounds->0#>>'{}')::numeric;
  v_hi := (v_bounds->1#>>'{}')::numeric;
  RETURN v_lo >= 0 AND v_lo < v_hi AND v_hi <= 100;
END $$;

-- {"lower": x, "upper": y, "kind": K}, positive endpoints, lower <= upper
-- (equal endpoints stay an interval), K in reported_range / typical_range.
CREATE FUNCTION private.reference_interval_statistic_valid(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_value IS NOT NULL
     AND pg_catalog.jsonb_typeof(p_value) = 'object'
     AND (p_value ?& ARRAY['lower','upper','kind'])
     AND NOT private.reference_payload_has_unknown_keys(p_value, ARRAY['lower','upper','kind'])
     AND pg_catalog.jsonb_typeof(p_value->'kind') = 'string'
     AND (p_value->>'kind') IN ('reported_range','typical_range')
     AND private.reference_json_number_valid(p_value->'lower', true)
     AND private.reference_json_number_valid(p_value->'upper', true)
     AND (p_value->'lower'#>>'{}')::numeric <= (p_value->'upper'#>>'{}')::numeric
$$;

-- {"value": v}; positive for medians, non-negative for standard deviations.
CREATE FUNCTION private.reference_scalar_statistic_valid(p_value jsonb, p_positive boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT p_value IS NOT NULL
     AND pg_catalog.jsonb_typeof(p_value) = 'object'
     AND (p_value ? 'value')
     AND NOT private.reference_payload_has_unknown_keys(p_value, ARRAY['value'])
     AND private.reference_json_number_valid(p_value->'value', p_positive)
$$;

-- Structure and enum rules of a details object (contract section 1).
-- schema_version 1 is validated in full; any other integer version is accepted
-- opaquely (the desktop's authoritative validation mode), bounded only by the
-- size limit applied in reference_measurement_content_valid.
CREATE FUNCTION private.reference_measurement_details_valid(p_details jsonb)
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
  IF (v_version#>>'{}')::numeric <> 1 THEN RETURN true; END IF;
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

-- Row-level validation of the complete candidate row (contract section 2),
-- equivalent to the desktop validate_measurement_content(mode="authoritative"):
-- finite positive dimension/Q values and ordered pairs on every row, then the
-- details structure, the 4096-byte canonical size, and the descriptor/column
-- consistency rules for schema_version 1.
CREATE FUNCTION private.reference_measurement_content_valid(p_row public.reference_measurement_sets)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_metric text; v_body jsonb;
  v_outer_lo double precision; v_outer_hi double precision;
  v_core_lo double precision; v_core_hi double precision; v_mean double precision;
BEGIN
  IF NOT (private.reference_positive_finite(p_row.length_min)
      AND private.reference_positive_finite(p_row.length_core_min)
      AND private.reference_positive_finite(p_row.length_core_max)
      AND private.reference_positive_finite(p_row.length_max)
      AND private.reference_positive_finite(p_row.width_min)
      AND private.reference_positive_finite(p_row.width_core_min)
      AND private.reference_positive_finite(p_row.width_core_max)
      AND private.reference_positive_finite(p_row.width_max)
      AND private.reference_positive_finite(p_row.q_min)
      AND private.reference_positive_finite(p_row.q_core_min)
      AND private.reference_positive_finite(p_row.q_core_max)
      AND private.reference_positive_finite(p_row.q_max)
      AND private.reference_positive_finite(p_row.q_mean)
      AND private.reference_positive_finite(p_row.length_mean)
      AND private.reference_positive_finite(p_row.width_mean)) THEN
    RETURN false;
  END IF;
  IF NOT (private.reference_pair_ordered(p_row.length_min, p_row.length_max)
      AND private.reference_pair_ordered(p_row.length_core_min, p_row.length_core_max)
      AND private.reference_pair_ordered(p_row.width_min, p_row.width_max)
      AND private.reference_pair_ordered(p_row.width_core_min, p_row.width_core_max)
      AND private.reference_pair_ordered(p_row.q_min, p_row.q_max)
      AND private.reference_pair_ordered(p_row.q_core_min, p_row.q_core_max)) THEN
    RETURN false;
  END IF;
  IF p_row.measurement_details_json IS NULL THEN RETURN true; END IF;
  IF NOT private.reference_measurement_details_valid(p_row.measurement_details_json) THEN
    RETURN false;
  END IF;
  IF pg_catalog.octet_length(private.reference_jsonb_compact_text(p_row.measurement_details_json)) > 4096 THEN
    RETURN false;
  END IF;
  IF (p_row.measurement_details_json->'schema_version'#>>'{}')::numeric <> 1 THEN
    RETURN true;
  END IF;
  FOR v_metric, v_body IN
    SELECT e.key, e.value FROM pg_catalog.jsonb_each(p_row.measurement_details_json->'metrics') e
  LOOP
    CASE v_metric
      WHEN 'length' THEN
        v_outer_lo := p_row.length_min; v_outer_hi := p_row.length_max;
        v_core_lo := p_row.length_core_min; v_core_hi := p_row.length_core_max;
        v_mean := p_row.length_mean;
      WHEN 'width' THEN
        v_outer_lo := p_row.width_min; v_outer_hi := p_row.width_max;
        v_core_lo := p_row.width_core_min; v_core_hi := p_row.width_core_max;
        v_mean := p_row.width_mean;
      WHEN 'q' THEN
        v_outer_lo := p_row.q_min; v_outer_hi := p_row.q_max;
        v_core_lo := p_row.q_core_min; v_core_hi := p_row.q_core_max;
        v_mean := p_row.q_mean;
      ELSE RETURN false;
    END CASE;
    -- Rule 1: an outer descriptor needs its complete (already ordered) pair.
    IF (v_body ? 'outer_range') AND (v_outer_lo IS NULL OR v_outer_hi IS NULL) THEN RETURN false; END IF;
    -- Rule 2: a core descriptor needs its complete pair.
    IF (v_body ? 'core_range') AND (v_core_lo IS NULL OR v_core_hi IS NULL) THEN RETURN false; END IF;
    -- Rule 3: explicit extremes enclose the core pair.
    IF (v_body ? 'outer_range') AND (v_body ? 'core_range')
       AND (v_outer_lo > v_core_lo OR v_core_hi > v_outer_hi) THEN RETURN false; END IF;
    -- Rule 4: a mean interval excludes the scalar mean.
    IF (v_body ? 'mean_interval') AND v_mean IS NOT NULL THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION private.reference_jsonb_compact_text(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_positive_finite(double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_pair_ordered(double precision, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_json_number_valid(jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_range_descriptor_valid(jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_interval_statistic_valid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_scalar_statistic_valid(jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_measurement_details_valid(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reference_measurement_content_valid(public.reference_measurement_sets) FROM PUBLIC, anon, authenticated;

-- Authoritative mutation implementation. Body of 20260828143513 plus:
--   * allowlist carries the three extension keys;
--   * partial acknowledgement (some but not all extension keys) is
--     invalid_payload before any other check (contract section 9 item 9);
--   * creation of a successor of an enhanced predecessor requires all three
--     keys (item 4);
--   * on an existing enhanced row, a request that omits the keys and changes
--     anything but deleted_at is invalid_payload (item 3); exact retries keep
--     no_change and delete/restore keep working (item 5);
--   * every content change is validated row-level before it is written
--     (item 7); lifecycle-only requests are not re-validated so an old row
--     can still be deleted or restored;
--   * JSON null clears: jsonb_populate_record maps it to SQL NULL for the
--     new jsonb column and both doubles on create and update (item 6).
-- Ownership, CAS, revision and successor rules are unchanged.
CREATE OR REPLACE FUNCTION public.sync_reference_measurement_set_unthrottled(p_payload jsonb, p_expected_row_version bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid:=auth.uid(); v_id uuid; v_parent uuid; v_supersedes uuid;
  v_current public.reference_measurement_sets%ROWTYPE; v_next public.reference_measurement_sets%ROWTYPE;
  v_deleted boolean;
  v_extension_keys constant text[]:=ARRAY['measurement_details_json','q_core_min','q_core_max'];
  v_lifecycle_keys constant text[]:=ARRAY['revision','row_version','created_at','updated_at','deleted_at'];
  v_present integer; v_ack boolean; v_content_changed boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  IF p_expected_row_version IS NULL OR p_expected_row_version < 0 THEN RETURN private.reference_result('invalid_payload'); END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' OR
     private.reference_payload_has_unknown_keys(p_payload,ARRAY['id','taxon_treatment_id','character','raw_text','data_kind','length_min','length_core_min','length_core_max','length_max','width_min','width_core_min','width_core_max','width_max','q_min','q_max','q_mean','length_mean','width_mean','sample_size','specimen_count','mount_medium','stain','preparation','measurement_method','notes','raw_points_json','supersedes_id','revision','deleted','measurement_details_json','q_core_min','q_core_max'])
  THEN RETURN private.reference_result('invalid_payload'); END IF;
  SELECT count(*) INTO v_present FROM pg_catalog.unnest(v_extension_keys) AS k WHERE p_payload ? k;
  IF v_present NOT IN (0, pg_catalog.array_length(v_extension_keys,1)) THEN RETURN private.reference_result('invalid_payload'); END IF;
  v_ack:=v_present>0;
  BEGIN
    v_id:=(p_payload->>'id')::uuid; v_parent:=(p_payload->>'taxon_treatment_id')::uuid;
    v_supersedes:=nullif(p_payload->>'supersedes_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  IF EXISTS (SELECT 1 FROM private.reference_account_deletions WHERE user_id=v_owner) THEN RETURN private.reference_result('account_deleting'); END IF;
  SELECT * INTO v_current FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  IF FOUND AND v_current.deleted_at IS NOT NULL AND coalesce((p_payload->>'deleted')::boolean,false) THEN
    RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reference_taxon_treatments WHERE user_id=v_owner AND id=v_parent AND deleted_at IS NULL) THEN RETURN private.reference_result('invalid_parent'); END IF;
  IF v_supersedes IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_supersedes AND deleted_at IS NULL) THEN RETURN private.reference_result('invalid_parent'); END IF;
  IF v_supersedes=v_id OR (v_supersedes IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT v_supersedes UNION ALL
      SELECT m.supersedes_id FROM public.reference_measurement_sets m JOIN ancestors a ON m.user_id=v_owner AND m.id=a.id WHERE m.supersedes_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=v_id
  )) THEN RETURN private.reference_result('invalid_successor'); END IF;
  SELECT * INTO v_current FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_row_version<>0 THEN RETURN private.reference_result('conflict'); END IF;
    IF v_supersedes IS NOT NULL AND NOT v_ack AND EXISTS (
      SELECT 1 FROM public.reference_measurement_sets p WHERE p.user_id=v_owner AND p.id=v_supersedes
        AND (p.measurement_details_json IS NOT NULL OR p.q_core_min IS NOT NULL OR p.q_core_max IS NOT NULL)
    ) THEN RETURN private.reference_result('invalid_payload'); END IF;
    BEGIN
      v_next:=pg_catalog.jsonb_populate_record(NULL::public.reference_measurement_sets,p_payload-ARRAY['deleted']);
    EXCEPTION WHEN OTHERS THEN RETURN private.reference_result('invalid_payload'); END;
    IF NOT private.reference_measurement_content_valid(v_next) THEN RETURN private.reference_result('invalid_payload'); END IF;
    BEGIN
      INSERT INTO public.reference_measurement_sets(
        user_id,id,taxon_treatment_id,character,raw_text,data_kind,length_min,length_core_min,length_core_max,length_max,
        width_min,width_core_min,width_core_max,width_max,q_min,q_max,q_mean,length_mean,width_mean,sample_size,
        specimen_count,mount_medium,stain,preparation,measurement_method,notes,raw_points_json,supersedes_id,revision,deleted_at,
        measurement_details_json,q_core_min,q_core_max
      ) VALUES (
        v_owner,v_id,v_parent,p_payload->>'character',p_payload->>'raw_text',p_payload->>'data_kind',
        (p_payload->>'length_min')::double precision,(p_payload->>'length_core_min')::double precision,(p_payload->>'length_core_max')::double precision,(p_payload->>'length_max')::double precision,
        (p_payload->>'width_min')::double precision,(p_payload->>'width_core_min')::double precision,(p_payload->>'width_core_max')::double precision,(p_payload->>'width_max')::double precision,
        (p_payload->>'q_min')::double precision,(p_payload->>'q_max')::double precision,(p_payload->>'q_mean')::double precision,
        (p_payload->>'length_mean')::double precision,(p_payload->>'width_mean')::double precision,(p_payload->>'sample_size')::integer,
        (p_payload->>'specimen_count')::integer,p_payload->>'mount_medium',p_payload->>'stain',p_payload->>'preparation',
        p_payload->>'measurement_method',p_payload->>'notes',p_payload->'raw_points_json',v_supersedes,
        coalesce((p_payload->>'revision')::integer,1),CASE WHEN coalesce((p_payload->>'deleted')::boolean,false) THEN pg_catalog.clock_timestamp() END,
        -- JSON null and an omitted key both arrive here as SQL NULL.
        v_next.measurement_details_json,v_next.q_core_min,v_next.q_core_max
      ) RETURNING * INTO v_current;
      RETURN private.reference_result('created',pg_catalog.to_jsonb(v_current));
    EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict');
      WHEN foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation THEN RETURN private.reference_result('invalid_payload');
    END;
  END IF;
  v_next:=pg_catalog.jsonb_populate_record(v_current,p_payload-ARRAY['deleted']);
  v_next.user_id:=v_owner; v_next.id:=v_id; v_next.created_at:=v_current.created_at;
  v_next.row_version:=v_current.row_version; v_next.updated_at:=v_current.updated_at;
  v_deleted:=coalesce((p_payload->>'deleted')::boolean,v_current.deleted_at IS NOT NULL);
  v_next.deleted_at:=CASE WHEN v_deleted THEN coalesce(v_current.deleted_at,pg_catalog.clock_timestamp()) ELSE NULL END;
  v_content_changed:=(pg_catalog.to_jsonb(v_next)-v_lifecycle_keys) IS DISTINCT FROM (pg_catalog.to_jsonb(v_current)-v_lifecycle_keys);
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_content_changed AND NOT v_ack
     AND (v_current.measurement_details_json IS NOT NULL OR v_current.q_core_min IS NOT NULL OR v_current.q_core_max IS NOT NULL)
  THEN RETURN private.reference_result('invalid_payload',pg_catalog.to_jsonb(v_current)); END IF;
  IF p_expected_row_version<>v_current.row_version THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision<v_current.revision THEN RETURN private.reference_result('invalid_revision',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.revision=v_current.revision AND v_content_changed
  THEN RETURN private.reference_result('invalid_revision',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_next.taxon_treatment_id<>v_current.taxon_treatment_id THEN RETURN private.reference_result('invalid_parent',pg_catalog.to_jsonb(v_current)); END IF;
  IF pg_catalog.to_jsonb(v_next)=pg_catalog.to_jsonb(v_current) THEN RETURN private.reference_result('no_change',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_current.deleted_at IS NULL AND v_next.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.observation_reference_uses u WHERE u.user_id=v_owner AND u.reference_measurement_set_id=v_id AND u.deleted_at IS NULL
  ) THEN RETURN private.reference_result('blocked',pg_catalog.to_jsonb(v_current)); END IF;
  IF v_content_changed AND NOT private.reference_measurement_content_valid(v_next)
  THEN RETURN private.reference_result('invalid_payload',pg_catalog.to_jsonb(v_current)); END IF;
  BEGIN
    UPDATE public.reference_measurement_sets SET character=v_next.character,raw_text=v_next.raw_text,data_kind=v_next.data_kind,
      length_min=v_next.length_min,length_core_min=v_next.length_core_min,length_core_max=v_next.length_core_max,length_max=v_next.length_max,
      width_min=v_next.width_min,width_core_min=v_next.width_core_min,width_core_max=v_next.width_core_max,width_max=v_next.width_max,
      q_min=v_next.q_min,q_max=v_next.q_max,q_mean=v_next.q_mean,length_mean=v_next.length_mean,width_mean=v_next.width_mean,
      sample_size=v_next.sample_size,specimen_count=v_next.specimen_count,mount_medium=v_next.mount_medium,stain=v_next.stain,
      preparation=v_next.preparation,measurement_method=v_next.measurement_method,notes=v_next.notes,raw_points_json=v_next.raw_points_json,
      supersedes_id=v_next.supersedes_id,revision=v_next.revision,row_version=row_version+1,
      updated_at=pg_catalog.clock_timestamp(),deleted_at=v_next.deleted_at,
      measurement_details_json=v_next.measurement_details_json,q_core_min=v_next.q_core_min,q_core_max=v_next.q_core_max
    WHERE user_id=v_owner AND id=v_id AND row_version=p_expected_row_version RETURNING * INTO v_current;
  EXCEPTION WHEN unique_violation THEN RETURN private.reference_result('conflict',pg_catalog.to_jsonb(v_current)); END;
  IF NOT FOUND THEN RETURN private.reference_result('conflict'); END IF;
  RETURN private.reference_result('updated',pg_catalog.to_jsonb(v_current));
END
$$;

ALTER FUNCTION public.sync_reference_measurement_set_unthrottled(jsonb,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_measurement_set_unthrottled(jsonb,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
