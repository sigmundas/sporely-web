CREATE OR REPLACE FUNCTION public.reconcile_profile_storage_usage(
  p_user_id uuid,
  p_expected_total_storage_bytes bigint,
  p_expected_storage_used_bytes bigint,
  p_expected_image_count integer,
  p_storage_used_bytes bigint,
  p_image_count integer,
  p_reason text,
  p_admin_user_id uuid,
  p_admin_email text,
  p_request_payload jsonb,
  p_before_snapshot jsonb,
  p_recalculated jsonb
)
RETURNS TABLE(
  action_log_id bigint,
  total_storage_bytes bigint,
  storage_used_bytes bigint,
  image_count integer
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_profile public.profiles%ROWTYPE;
  v_log_id bigint;
BEGIN
  IF p_storage_used_bytes < 0 OR p_image_count < 0 THEN
    RAISE EXCEPTION 'Reconciled storage values must be non-negative';
  END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Reconciliation reason is required';
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found: %', p_user_id USING ERRCODE = 'P0002';
  END IF;

  IF coalesce(v_profile.total_storage_bytes, 0) <> p_expected_total_storage_bytes
     OR coalesce(v_profile.storage_used_bytes, 0) <> p_expected_storage_used_bytes
     OR coalesce(v_profile.image_count, 0) <> p_expected_image_count THEN
    RAISE EXCEPTION 'Profile accounting changed during reconciliation'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.profiles
  SET total_storage_bytes = p_storage_used_bytes,
      storage_used_bytes = p_storage_used_bytes,
      image_count = p_image_count
  WHERE id = p_user_id;

  INSERT INTO public.admin_action_log (
    admin_user_id,
    admin_email,
    action,
    target_type,
    target_id,
    reason,
    request_payload,
    before_snapshot,
    result_snapshot
  ) VALUES (
    p_admin_user_id,
    p_admin_email,
    'reconcile_profile_storage_usage',
    'profile',
    p_user_id::text,
    p_reason,
    coalesce(p_request_payload, '{}'::jsonb),
    coalesce(p_before_snapshot, '{}'::jsonb),
    jsonb_build_object(
      'profile_id', p_user_id,
      'recalculated', coalesce(p_recalculated, '{}'::jsonb),
      'profile', jsonb_build_object(
        'id', p_user_id,
        'total_storage_bytes', p_storage_used_bytes,
        'storage_used_bytes', p_storage_used_bytes,
        'image_count', p_image_count
      )
    )
  ) RETURNING id INTO v_log_id;

  RETURN QUERY SELECT
    v_log_id,
    p_storage_used_bytes,
    p_storage_used_bytes,
    p_image_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_profile_storage_usage(
  uuid, bigint, bigint, integer, bigint, integer, text, uuid, text, jsonb, jsonb, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_profile_storage_usage(
  uuid, bigint, bigint, integer, bigint, integer, text, uuid, text, jsonb, jsonb, jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_profile_storage_usage(
  uuid, bigint, bigint, integer, bigint, integer, text, uuid, text, jsonb, jsonb, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_profile_storage_usage(
  uuid, bigint, bigint, integer, bigint, integer, text, uuid, text, jsonb, jsonb, jsonb
) TO service_role;
