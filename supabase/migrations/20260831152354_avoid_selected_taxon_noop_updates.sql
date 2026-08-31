-- Keep the guarded selected-taxon RPC idempotent at statement time. Client
-- preflight comparisons are useful but cannot prevent a concurrent device
-- from writing the same value between read and RPC execution.

BEGIN;

CREATE OR REPLACE FUNCTION public.set_observation_selected_taxon_v2(
  p_observation_id bigint,
  p_sporely_taxon_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.observations o
    WHERE o.id = p_observation_id
      AND o.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'observation not found or caller does not own it'
      USING ERRCODE = '42501';
  END IF;

  IF p_sporely_taxon_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.taxonomy_v2_releases r
    JOIN public.taxonomy_v2_taxa t ON t.release_id = r.release_id
    WHERE r.status = 'active'
      AND t.sporely_taxon_id = p_sporely_taxon_id
  ) THEN
    RAISE EXCEPTION
      'sporely_taxon_id % is missing from the active taxonomy-v2 release',
      p_sporely_taxon_id
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.observations
     SET selected_sporely_taxon_id = p_sporely_taxon_id
   WHERE id = p_observation_id
     AND user_id = auth.uid()
     AND selected_sporely_taxon_id IS DISTINCT FROM p_sporely_taxon_id;
END
$$;

ALTER FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_observation_selected_taxon_v2(bigint,bigint)
  TO authenticated, service_role;

COMMIT;
