-- Finalize a tombstoned image purge and its logical quota release exactly
-- once. Physical migration copies are deliberately not represented here:
-- callers pass one logical byte count for full/thumb/original identities.

ALTER TABLE public.observation_images
  ADD COLUMN IF NOT EXISTS purge_accounting_bytes bigint
  CHECK (purge_accounting_bytes IS NULL OR purge_accounting_bytes >= 0);

CREATE OR REPLACE FUNCTION public.finalize_observation_image_purge(
  p_image_id bigint,
  p_purged_at timestamptz,
  p_storage_bytes bigint
)
RETURNS TABLE(
  image_id bigint,
  purged_at timestamptz,
  accounted_storage_bytes bigint,
  quota_changed boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_image public.observation_images%ROWTYPE;
  v_bytes bigint;
BEGIN
  SELECT *
    INTO v_image
    FROM public.observation_images oi
   WHERE oi.id = p_image_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'observation image % not found', p_image_id;
  END IF;

  v_bytes := greatest(
    0,
    coalesce(p_storage_bytes, 0),
    coalesce(v_image.purge_accounting_bytes, 0),
    coalesce(v_image.stored_bytes, 0)
  );

  IF v_image.purged_at IS NULL THEN
    UPDATE public.observation_images oi
       SET purged_at = coalesce(p_purged_at, now()),
           purge_attempted_at = coalesce(p_purged_at, now()),
           purge_error = NULL,
           purge_accounting_bytes = v_bytes
     WHERE oi.id = p_image_id;

    PERFORM public.apply_profile_storage_delta(v_image.user_id, -v_bytes, -1);

    RETURN QUERY
      SELECT p_image_id, coalesce(p_purged_at, now()), v_bytes, true;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT p_image_id, v_image.purged_at, coalesce(v_image.purge_accounting_bytes, v_bytes), false;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_observation_image_purge(bigint, timestamptz, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_observation_image_purge(bigint, timestamptz, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_observation_image_purge(bigint, timestamptz, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_observation_image_purge(bigint, timestamptz, bigint) TO service_role;

-- Raw Worker deletes (hard observation/account cleanup and replacement) need
-- the same retry guarantee even after physical bytes have disappeared. The
-- prepare call snapshots one logical object's bytes before R2 mutation; the
-- finalize call releases them once after every configured bucket succeeds.
CREATE TABLE IF NOT EXISTS public.media_object_deletion_accounting (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  image_count integer NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  PRIMARY KEY (user_id, storage_key)
);

ALTER TABLE public.media_object_deletion_accounting ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.media_object_deletion_accounting FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.media_object_deletion_accounting TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_media_object_deletion(
  p_user_id uuid,
  p_storage_key text,
  p_storage_bytes bigint,
  p_image_count integer
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  INSERT INTO public.media_object_deletion_accounting (
    user_id, storage_key, storage_bytes, image_count
  )
  VALUES (
    p_user_id,
    trim(p_storage_key),
    greatest(0, coalesce(p_storage_bytes, 0)),
    greatest(0, coalesce(p_image_count, 0))
  )
  ON CONFLICT (user_id, storage_key) DO UPDATE
     SET storage_bytes = CASE
           WHEN media_object_deletion_accounting.finalized_at IS NOT NULL
                AND (EXCLUDED.storage_bytes > 0 OR EXCLUDED.image_count > 0)
             THEN EXCLUDED.storage_bytes
           ELSE greatest(media_object_deletion_accounting.storage_bytes, EXCLUDED.storage_bytes)
         END,
         image_count = CASE
           WHEN media_object_deletion_accounting.finalized_at IS NOT NULL
                AND (EXCLUDED.storage_bytes > 0 OR EXCLUDED.image_count > 0)
             THEN EXCLUDED.image_count
           ELSE greatest(media_object_deletion_accounting.image_count, EXCLUDED.image_count)
         END,
         prepared_at = CASE
           WHEN media_object_deletion_accounting.finalized_at IS NOT NULL
                AND (EXCLUDED.storage_bytes > 0 OR EXCLUDED.image_count > 0)
             THEN now()
           ELSE media_object_deletion_accounting.prepared_at
         END,
         finalized_at = CASE
           WHEN media_object_deletion_accounting.finalized_at IS NOT NULL
                AND (EXCLUDED.storage_bytes > 0 OR EXCLUDED.image_count > 0)
             THEN NULL
           ELSE media_object_deletion_accounting.finalized_at
         END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_media_object_deletion(
  p_user_id uuid,
  p_storage_key text
)
RETURNS TABLE(
  total_storage_bytes bigint,
  storage_used_bytes bigint,
  image_count integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_accounting public.media_object_deletion_accounting%ROWTYPE;
BEGIN
  SELECT *
    INTO v_accounting
    FROM public.media_object_deletion_accounting a
   WHERE a.user_id = p_user_id
     AND a.storage_key = trim(p_storage_key)
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media deletion accounting record not prepared';
  END IF;

  IF v_accounting.finalized_at IS NULL THEN
    RETURN QUERY
      SELECT delta.total_storage_bytes, delta.storage_used_bytes, delta.image_count
        FROM public.apply_profile_storage_delta(
          p_user_id,
          -v_accounting.storage_bytes,
          -v_accounting.image_count
        ) AS delta;

    UPDATE public.media_object_deletion_accounting a
       SET finalized_at = now()
     WHERE a.user_id = p_user_id
       AND a.storage_key = trim(p_storage_key);
    RETURN;
  END IF;

  RETURN QUERY
    SELECT p.total_storage_bytes, p.storage_used_bytes, p.image_count
      FROM public.profiles p
     WHERE p.id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_media_object_deletion(uuid, text, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_media_object_deletion(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_media_object_deletion(uuid, text, bigint, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_media_object_deletion(uuid, text) TO service_role;
