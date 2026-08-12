-- Regression coverage for the explicit, sanitized public AI-identification
-- projection.

BEGIN;

DO $$
DECLARE
  owner_id uuid := '00000000-0000-4000-8000-00000000cf61';
  observation_id bigint := 880000000061;
  identification_id bigint := 880000000061;
  projected_columns text[];
  public_results jsonb;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (
    owner_id,
    'authenticated',
    'authenticated',
    'identification-public-owner@example.test',
    '{}'::jsonb,
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.profiles (id, username, is_banned)
  VALUES (owner_id, 'identification_public_owner', false)
  ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    is_banned = EXCLUDED.is_banned;

  INSERT INTO public.observations (id, user_id, date, visibility, is_draft)
  OVERRIDING SYSTEM VALUE
  VALUES (observation_id, owner_id, current_date, 'public', false)
  ON CONFLICT (id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    date = EXCLUDED.date,
    visibility = EXCLUDED.visibility,
    is_draft = EXCLUDED.is_draft;

  INSERT INTO public.observation_identifications (
    id,
    observation_id,
    user_id,
    service,
    source,
    status,
    image_fingerprint,
    crop_fingerprint,
    request_fingerprint,
    language,
    model_version,
    results,
    top_scientific_name,
    top_vernacular_name,
    top_taxon_id,
    top_probability,
    error_message
  ) VALUES (
    identification_id,
    observation_id,
    owner_id,
    'artsorakel',
    'ai',
    'success',
    'private-image-fingerprint',
    'private-crop-fingerprint',
    'private-request-fingerprint',
    'nb',
    'internal-model-version',
    jsonb_build_array(jsonb_build_object(
      'rank', 1,
      'service', 'artsorakel',
      'scientific_name', 'Amanita muscaria',
      'vernacular_name', 'Fly agaric',
      'probability', 0.97,
      'debug_trace', 'private-debug-data',
      'raw', jsonb_build_object('provider_token', 'private-provider-data'),
      'external_ids', jsonb_build_object(
        'gbif', '123',
        'private_provider_id', 'private-external-id'
      )
    )),
    'Amanita muscaria',
    'Fly agaric',
    'NBIC:123',
    0.97,
    'private provider error detail'
  )
  ON CONFLICT (id) DO UPDATE SET
    results = EXCLUDED.results,
    image_fingerprint = EXCLUDED.image_fingerprint,
    crop_fingerprint = EXCLUDED.crop_fingerprint,
    request_fingerprint = EXCLUDED.request_fingerprint,
    language = EXCLUDED.language,
    model_version = EXCLUDED.model_version,
    error_message = EXCLUDED.error_message;

  SELECT array_agg(c.column_name::text ORDER BY c.ordinal_position)
  INTO projected_columns
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'observation_identifications_community_view';

  IF projected_columns IS DISTINCT FROM ARRAY[
    'id',
    'observation_id',
    'service',
    'status',
    'results',
    'top_scientific_name',
    'top_vernacular_name',
    'top_taxon_id',
    'top_probability',
    'top_species_url',
    'top_redlist_category',
    'top_redlist_status',
    'top_redlist_source',
    'created_at',
    'updated_at'
  ]::text[] THEN
    RAISE EXCEPTION 'unexpected public identification columns: %', projected_columns;
  END IF;

  SET LOCAL ROLE anon;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  SELECT results INTO public_results
  FROM public.observation_identifications_community_view
  WHERE id = identification_id;

  IF public_results->0->>'scientific_name' IS DISTINCT FROM 'Amanita muscaria'
     OR public_results->0->>'probability' IS DISTINCT FROM '0.97'
     OR public_results->0->'external_ids'->>'gbif' IS DISTINCT FROM '123' THEN
    RAISE EXCEPTION 'public identification display fields were not preserved: %', public_results;
  END IF;

  IF public_results->0 ? 'debug_trace'
     OR public_results->0 ? 'raw'
     OR public_results->0->'external_ids' ? 'private_provider_id' THEN
    RAISE EXCEPTION 'internal provider/debug data leaked through results: %', public_results;
  END IF;

  RESET ROLE;
  RAISE NOTICE 'identification_community_projection_test passed';
END
$$;

ROLLBACK;
