ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS billing_customer_id text,
  ADD COLUMN IF NOT EXISTS billing_payment_id text,
  ADD COLUMN IF NOT EXISTS billing_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS billing_updated_at timestamptz;

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
  NEW.billing_customer_id = OLD.billing_customer_id;
  NEW.billing_payment_id = OLD.billing_payment_id;
  NEW.billing_checkout_session_id = OLD.billing_checkout_session_id;
  NEW.billing_updated_at = OLD.billing_updated_at;
  NEW.total_storage_bytes = OLD.total_storage_bytes;
  NEW.image_count = OLD.image_count;
  NEW.is_admin = OLD.is_admin;
  NEW.is_banned = OLD.is_banned;
  NEW.is_pro = OLD.is_pro;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.protect_profile_privileged_fields() OWNER TO postgres;
