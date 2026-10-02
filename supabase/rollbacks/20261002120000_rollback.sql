-- Rollback of supabase/migrations/20261002120000_reference_client_capability_minimum.sql
-- (Stage M, docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md).
-- NOT a migration: kept outside supabase/migrations so it never runs by
-- accident. Tested both ways by supabase/tests/reference_client_capability_rollback_test.sh.
--
-- One transaction. Drops the three restrictive SELECT policies (sets, uses,
-- curated forks), the feed and device RPCs, the predicates (schema
-- reference_rls) and helpers and public.reference_client_devices
-- (its rows are disposable capability reports, not user content), and
-- restores public.sync_reference_measurement_set(jsonb,bigint) and
-- public.sync_observation_reference_use(jsonb,bigint,text) verbatim from
-- 20260830193144 with their owner, REVOKEs and GRANTs. No reference row is
-- written by the forward migration, so none is restored.
-- After the rollback a caller passing p_client_capabilities or calling
-- list_reference_library_feed fails (undefined function); callers that omit
-- them are unaffected.
--
-- ONLY SAFE BEFORE ANY V2 CONTENT EXISTS (no enhanced set, no version-2
-- use snapshot, i.e. before Stage D/E enable writing). Afterwards the
-- restrictive policies are gone: a v0.9.22 desktop would again receive a
-- version-2 use and reject its WHOLE use feed, a successor of a withheld set
-- would fail its whole set feed, a fork of one would make its curated pull
-- error and skip all pushes, and non-capable writes could downgrade enhanced
-- sets. Check first (both must be 0):
--   SELECT count(*) FROM public.reference_measurement_sets
--    WHERE measurement_details_json IS NOT NULL OR q_core_min IS NOT NULL OR q_core_max IS NOT NULL;
--   SELECT count(*) FROM public.observation_reference_uses
--    WHERE snapshot_json->>'schema_version' IS DISTINCT FROM '1';
--
-- Promotion to a real migration (only if the forward migration was deployed
-- and must be undone): copy this file unchanged to
-- supabase/migrations/<new UTC timestamp>_rollback_reference_client_capability_minimum.sql,
-- run the rollback test against it, then deploy through the deploy tree.

BEGIN;

DROP POLICY reference_measurement_sets_v1_reader_select ON public.reference_measurement_sets;
DROP POLICY observation_reference_uses_v1_reader_select ON public.observation_reference_uses;
DROP POLICY reference_curated_forks_v1_reader_select ON public.reference_curated_forks;

DROP FUNCTION public.list_reference_library_feed(text,jsonb,timestamptz,uuid,integer);
DROP FUNCTION public.record_reference_client_capabilities(jsonb);
DROP FUNCTION public.sync_reference_measurement_set(jsonb,bigint,jsonb);
DROP FUNCTION public.sync_observation_reference_use(jsonb,bigint,text,jsonb);
DROP FUNCTION reference_rls.fork_withheld_from_v1_readers(uuid,uuid);
DROP FUNCTION reference_rls.caller_withheld_set_ids();
DROP FUNCTION reference_rls.use_withheld_from_v1_readers(uuid,uuid,jsonb);
DROP FUNCTION reference_rls.set_withheld_from_v1_readers(uuid,uuid);
DROP SCHEMA reference_rls;
DROP INDEX public.reference_measurement_sets_enhanced_live_idx;
DROP FUNCTION private.reference_creation_blocked_by_older_client(uuid,jsonb);
DROP FUNCTION private.reference_older_client_active(uuid,uuid);
DROP FUNCTION private.reference_record_client_device(uuid,jsonb);
DROP FUNCTION private.reference_client_device_id(jsonb);
DROP FUNCTION private.reference_client_snapshot_versions(jsonb);
DROP TABLE public.reference_client_devices;

-- Verbatim from 20260830193144_configure_shared_reference_production_policy.sql.
CREATE FUNCTION public.sync_reference_measurement_set(p_payload jsonb,p_expected_row_version bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  RETURN public.sync_reference_measurement_set_unthrottled(p_payload,p_expected_row_version);
END
$$;

CREATE FUNCTION public.sync_observation_reference_use(
  p_payload jsonb,p_expected_row_version bigint,p_snapshot_mode text DEFAULT 'current'
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  RETURN public.sync_observation_reference_use_unthrottled(
    p_payload,p_expected_row_version,p_snapshot_mode
  );
END
$$;

ALTER FUNCTION public.sync_reference_measurement_set(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) TO authenticated;

COMMIT;
