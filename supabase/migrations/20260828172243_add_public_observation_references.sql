-- Additive public projection for frozen observation-reference evidence.
-- The normalized library remains owner-private; this API reads only live
-- observation attachments and never joins mutable library rows.

BEGIN;

CREATE FUNCTION private.public_reference_snapshot(
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
    ),
    'method',pg_catalog.jsonb_build_object(
      'mount_medium',p_snapshot->'method'->'mount_medium',
      'stain',p_snapshot->'method'->'stain',
      'preparation',p_snapshot->'method'->'preparation',
      'measurement_method',p_snapshot->'method'->'measurement_method'
    ),
    'raw_points',v_raw_points
  );
END
$$;

ALTER FUNCTION private.public_reference_snapshot(jsonb,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.public_reference_snapshot(jsonb,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TYPE public.public_observation_references_result AS (
  observation_id bigint,
  "references" jsonb
);
REVOKE ALL ON TYPE public.public_observation_references_result FROM PUBLIC;
GRANT USAGE ON TYPE public.public_observation_references_result
  TO anon, authenticated, service_role;

CREATE FUNCTION public.search_public_observation_references(p_observation_ids bigint[])
RETURNS SETOF public.public_observation_references_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_observation_ids IS NULL OR pg_catalog.cardinality(p_observation_ids)=0 THEN
    RETURN;
  END IF;
  IF pg_catalog.cardinality(p_observation_ids)>200 THEN
    RAISE EXCEPTION 'at most 200 observation ids may be requested'
      USING ERRCODE='22023';
  END IF;
  IF (SELECT pg_catalog.count(DISTINCT requested_id) FROM pg_catalog.unnest(p_observation_ids) requested_id)>100 THEN
    RAISE EXCEPTION 'at most 100 distinct observation ids may be requested'
      USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT DISTINCT requested_id AS id
    FROM pg_catalog.unnest(p_observation_ids) requested_id
    WHERE requested_id IS NOT NULL
  ), eligible AS (
    SELECT o.id
    FROM requested r
    JOIN public.observations o ON o.id=r.id
    WHERE o.visibility='public'::text
      AND NOT coalesce(o.is_draft,false)
      AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id=o.user_id AND p.is_banned=true
      )
      AND (
        auth.uid() IS NULL
        OR public.is_blocked_between(auth.uid(),o.user_id) IS NOT TRUE
      )
  )
  SELECT e.id,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'use_id',u.id,
          'role',u.role,
          'reference_revision',u.reference_revision,
          'snapshot',sanitized.snapshot
        ) ORDER BY u.selected_at,u.id
      ) FILTER (WHERE u.id IS NOT NULL AND sanitized.snapshot IS NOT NULL),
      '[]'::jsonb
    ) AS "references"
  FROM eligible e
  LEFT JOIN public.observation_reference_uses u
    ON u.observation_id=e.id AND u.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT private.public_reference_snapshot(
      u.snapshot_json,u.reference_measurement_set_id,u.reference_revision
    ) AS snapshot
  ) sanitized ON u.id IS NOT NULL
  GROUP BY e.id
  ORDER BY e.id;
END
$$;

CREATE FUNCTION public.get_public_observation_references(p_observation_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT projected."references"
  FROM public.search_public_observation_references(ARRAY[p_observation_id]) projected
$$;

ALTER FUNCTION public.search_public_observation_references(bigint[]) OWNER TO postgres;
ALTER FUNCTION public.get_public_observation_references(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.search_public_observation_references(bigint[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_public_observation_references(bigint)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_public_observation_references(bigint[])
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_observation_references(bigint)
  TO anon, authenticated, service_role;

COMMIT;
