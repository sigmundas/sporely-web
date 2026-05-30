CREATE OR REPLACE FUNCTION public.protect_profile_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Keep entitlement, quota, and moderation fields server-owned.
  IF current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  NEW.cloud_plan = OLD.cloud_plan;
  NEW.full_res_storage_enabled = OLD.full_res_storage_enabled;
  NEW.storage_quota_bytes = OLD.storage_quota_bytes;
  NEW.storage_used_bytes = OLD.storage_used_bytes;
  NEW.billing_status = OLD.billing_status;
  NEW.billing_provider = OLD.billing_provider;
  NEW.total_storage_bytes = OLD.total_storage_bytes;
  NEW.image_count = OLD.image_count;
  NEW.is_admin = OLD.is_admin;
  NEW.is_banned = OLD.is_banned;
  NEW.is_pro = OLD.is_pro;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.protect_profile_privileged_fields() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.enforce_non_public_observation_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  current_count integer;
BEGIN
  IF coalesce(NEW.visibility, 'public') = 'public'
     AND coalesce(NEW.location_precision, 'exact') = 'exact' THEN
    RETURN NEW;
  END IF;

  IF public.profile_has_pro_access(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  -- Serialize per user so concurrent inserts cannot both pass the 20-slot check.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 0));

  SELECT count(*)::integer
  INTO current_count
  FROM public.observations o
  WHERE o.user_id = NEW.user_id
    AND (
      coalesce(o.visibility, 'public') <> 'public'
      OR coalesce(o.location_precision, 'exact') = 'fuzzed'
    )
    AND (TG_OP = 'INSERT' OR o.id <> NEW.id);

  IF current_count >= 20 THEN
    RAISE EXCEPTION
      'Free Sporely accounts can keep up to 20 privacy slot observations. Publish or use exact public location to continue.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_profiles_protect_privileged_fields ON public.profiles;

CREATE TRIGGER trg_profiles_protect_privileged_fields
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.protect_profile_privileged_fields();

ALTER FUNCTION public.apply_profile_storage_delta(uuid, bigint, integer) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.apply_profile_storage_delta(uuid, bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_profile_storage_delta(uuid, bigint, integer) FROM anon;
REVOKE ALL ON FUNCTION public.apply_profile_storage_delta(uuid, bigint, integer) FROM authenticated;
GRANT ALL ON FUNCTION public.apply_profile_storage_delta(uuid, bigint, integer) TO service_role;
