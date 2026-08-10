-- Stage 3: use real microscope-image capture time for microscope chronology.
--
-- Keep upload time as the legacy/null and deterministic tie-break only. Exact
-- microscope working times remain private; the aggregate RPC below is owner-only.

DO $migration$
DECLARE
  function_oid regprocedure;
  function_definition text;
BEGIN
  FOREACH function_oid IN ARRAY ARRAY[
    'public._get_public_observation_stage2a(bigint)'::regprocedure,
    'public.get_public_observation_facets()'::regprocedure,
    'public._get_public_species_stage2a(text)'::regprocedure,
    'public.search_public_observations(integer,integer,text,text,text,text,date,date,boolean,boolean,text,text,text,text,text)'::regprocedure,
    'public._search_public_species_stage2a(integer,integer,text,text)'::regprocedure
  ]
  LOOP
    function_definition := pg_get_functiondef(function_oid::oid);

    IF position('ORDER BY i.created_at DESC NULLS LAST, i.id DESC' IN function_definition) > 0 THEN
      function_definition := replace(
        function_definition,
        'ORDER BY i.created_at DESC NULLS LAST, i.id DESC',
        'ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC'
      );
      EXECUTE function_definition;
    ELSIF position(
      'ORDER BY i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC'
      IN function_definition
    ) = 0 THEN
      RAISE EXCEPTION 'Expected microscope chronology ordering was not found in %', function_oid;
    END IF;
  END LOOP;

  function_oid := 'public.get_public_spore_comparison_set(text,text,text,text,date,date,text,text,text,text)'::regprocedure;
  function_definition := pg_get_functiondef(function_oid::oid);

  IF position('ORDER BY contrib.n DESC, i.created_at DESC NULLS LAST, i.id DESC' IN function_definition) > 0 THEN
    function_definition := replace(
      function_definition,
      'ORDER BY contrib.n DESC, i.created_at DESC NULLS LAST, i.id DESC',
      'ORDER BY contrib.n DESC, i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC'
    );
    EXECUTE function_definition;
  ELSIF position(
    'ORDER BY contrib.n DESC, i.captured_at DESC NULLS LAST, i.created_at DESC, i.id DESC'
    IN function_definition
  ) = 0 THEN
    RAISE EXCEPTION 'Expected representative spore-image ordering was not found in %', function_oid;
  END IF;
END
$migration$;

CREATE OR REPLACE FUNCTION public.get_observation_latest_microscope_captured_at(
  p_observation_id bigint
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT max(i.captured_at)
  FROM public.observations o
  JOIN public.observation_images i
    ON i.observation_id = o.id
  WHERE o.id = p_observation_id
    AND o.user_id = auth.uid()
    AND i.image_type = 'microscope'
    AND i.deleted_at IS NULL
    AND i.purged_at IS NULL
$$;

COMMENT ON FUNCTION public.get_observation_latest_microscope_captured_at(bigint) IS
  'Owner-only derived timestamp of the latest real capture time among active microscope images. Never falls back to upload time.';

REVOKE ALL ON FUNCTION public.get_observation_latest_microscope_captured_at(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_observation_latest_microscope_captured_at(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_observation_latest_microscope_captured_at(bigint) TO authenticated;
