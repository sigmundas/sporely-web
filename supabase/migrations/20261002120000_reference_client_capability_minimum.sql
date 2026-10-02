-- Stage M of docs/plans/active/2026-10-01-reference-measurement-content-v2-rollout.md:
-- server-side minimum-client capability for reference measurement content v2.
--
-- Evidence (sporely-py v0.9.22 / v0.9.24, see the plan "Stage M design"):
--   * desktops read the owner feeds with plain PostgREST table GETs
--     (reference_measurement_sets, observation_reference_uses); no feed RPC
--     exists, so a parameter cannot reach them. The only lever over an old
--     reader is row visibility.
--   * old feed staging validates every row and the whole graph; a
--     placeholder row fails the whole feed, an absent row is never treated as
--     a deletion (tombstones come only from rows with deleted_at).
-- Therefore:
--   1. Direct table reads are version-1-only: restrictive SELECT policies
--      withhold (omit) an enhanced live measurement set, every set whose
--      supersedes chain reaches one (the old graph validator rejects a
--      successor with a missing predecessor), every use whose snapshot is not
--      version 1, and every use of a withheld set.
--   2. Capable clients read through public.list_reference_library_feed with
--      p_client_capabilities; it returns withheld_count for a v1-only caller.
--   3. sync_reference_measurement_set / sync_observation_reference_use take a
--      trailing p_client_capabilities jsonb DEFAULT NULL (NULL = v1-only).
--      A v1-only write touching withheld/enhanced content is refused with
--      status requires_newer_client (never downgraded). A capable write that
--      creates new enhanced content is refused with older_client_active while
--      another device of the owner, active within 30 days, last reported a
--      v1-only capability (an undeclared legacy write counts as one).
-- A declared capability only restricts or selects a representation of the
-- caller's own rows; content validation is unchanged (_unthrottled).

-- Capability parsing ------------------------------------------------------------
-- NULL -> {1}. Otherwise an object; reference_snapshot_versions, when present,
-- is a non-empty integer array, subset of {1,2}, containing 1; device_id, when
-- present, a uuid; client/app_version short strings. Unknown keys tolerated.
CREATE FUNCTION private.reference_client_snapshot_versions(p_capabilities jsonb)
RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v jsonb; r integer[];
BEGIN
  IF p_capabilities IS NULL OR p_capabilities = 'null'::jsonb THEN RETURN ARRAY[1]; END IF;
  IF pg_catalog.jsonb_typeof(p_capabilities) <> 'object' THEN
    RAISE EXCEPTION 'p_client_capabilities must be an object' USING ERRCODE = '22023';
  END IF;
  v := p_capabilities->'reference_snapshot_versions';
  IF v IS NULL THEN RETURN ARRAY[1]; END IF;
  IF pg_catalog.jsonb_typeof(v) <> 'array' OR pg_catalog.jsonb_array_length(v) = 0
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v) e
                 WHERE e NOT IN ('1'::jsonb, '2'::jsonb)) THEN
    RAISE EXCEPTION 'reference_snapshot_versions must be a subset of [1,2]' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT e::text::integer ORDER BY e::text::integer) INTO r
    FROM pg_catalog.jsonb_array_elements(v) e;
  IF NOT (1 = ANY(r)) THEN
    RAISE EXCEPTION 'reference_snapshot_versions must contain 1' USING ERRCODE = '22023';
  END IF;
  RETURN r;
END
$$;

CREATE FUNCTION private.reference_client_device_id(p_capabilities jsonb)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
  IF p_capabilities IS NULL OR pg_catalog.jsonb_typeof(p_capabilities) <> 'object'
     OR p_capabilities->'device_id' IS NULL OR p_capabilities->'device_id' = 'null'::jsonb THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN (p_capabilities->>'device_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'device_id must be a uuid' USING ERRCODE = '22023';
  END;
END
$$;

-- Per-device capability record ----------------------------------------------------
-- Minimal: no telemetry beyond what the creation guard needs. The nil uuid
-- is the "undeclared legacy writer" pseudo-device (a sync write without
-- p_client_capabilities). Owner-readable only; written only by SECURITY
-- DEFINER functions below.
CREATE TABLE public.reference_client_devices (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  client text NOT NULL DEFAULT 'unknown' CHECK (char_length(client) <= 32),
  app_version text NOT NULL DEFAULT '' CHECK (char_length(app_version) <= 32),
  reference_snapshot_versions integer[] NOT NULL
    CHECK (reference_snapshot_versions <@ ARRAY[1,2] AND 1 = ANY(reference_snapshot_versions)),
  first_seen_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (user_id, device_id)
);
ALTER TABLE public.reference_client_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY reference_client_devices_owner_select ON public.reference_client_devices
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.reference_client_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reference_client_devices TO authenticated;
GRANT ALL ON public.reference_client_devices TO service_role;

-- Records the caller's device (declared) or the legacy pseudo-device
-- (undeclared write). Rows unseen for 90 days are pruned; at most 32 live
-- devices per owner (a further new device is simply not recorded).
CREATE FUNCTION private.reference_record_client_device(p_owner uuid, p_capabilities jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_device uuid := private.reference_client_device_id(p_capabilities);
  v_versions integer[] := private.reference_client_snapshot_versions(p_capabilities);
  v_client text; v_version text;
BEGIN
  IF p_owner IS NULL THEN RETURN; END IF;
  IF p_capabilities IS NULL THEN
    v_device := '00000000-0000-0000-0000-000000000000'; v_client := 'undeclared'; v_version := '';
  ELSIF v_device IS NULL OR v_device = '00000000-0000-0000-0000-000000000000' THEN
    RETURN;
  ELSE
    v_client := pg_catalog.left(coalesce(p_capabilities->>'client', 'unknown'), 32);
    v_version := pg_catalog.left(coalesce(p_capabilities->>'app_version', ''), 32);
  END IF;
  DELETE FROM public.reference_client_devices
   WHERE user_id = p_owner AND last_seen_at < pg_catalog.clock_timestamp() - interval '90 days';
  IF NOT EXISTS (SELECT 1 FROM public.reference_client_devices WHERE user_id = p_owner AND device_id = v_device)
     AND (SELECT count(*) FROM public.reference_client_devices WHERE user_id = p_owner) >= 32 THEN
    RETURN;
  END IF;
  INSERT INTO public.reference_client_devices AS d
    (user_id, device_id, client, app_version, reference_snapshot_versions)
  VALUES (p_owner, v_device, v_client, v_version, v_versions)
  ON CONFLICT (user_id, device_id) DO UPDATE
    SET client = excluded.client, app_version = excluded.app_version,
        reference_snapshot_versions = excluded.reference_snapshot_versions,
        last_seen_at = pg_catalog.clock_timestamp();
END
$$;

-- True while another device of the owner, seen within 30 days (strictly
-- newer than now - 30 days), last reported a v1-only capability.
CREATE FUNCTION private.reference_older_client_active(p_owner uuid, p_self uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reference_client_devices d
     WHERE d.user_id = p_owner
       AND d.device_id IS DISTINCT FROM p_self
       AND NOT (2 = ANY(d.reference_snapshot_versions))
       AND d.last_seen_at > pg_catalog.clock_timestamp() - interval '30 days')
$$;

-- Withholding predicates ----------------------------------------------------------
-- In public because the RLS policies run as the invoker (authenticated has no
-- USAGE on private). Both answer only for the caller's own rows.
CREATE FUNCTION public.reference_set_withheld_from_v1_readers(p_user_id uuid, p_set_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH RECURSIVE chain(id, depth) AS (
    SELECT p_set_id, 0 WHERE p_user_id = (SELECT auth.uid()) OR (SELECT auth.uid()) IS NULL
    UNION ALL
    SELECT m.supersedes_id, c.depth + 1
      FROM public.reference_measurement_sets m JOIN chain c ON m.user_id = p_user_id AND m.id = c.id
     WHERE m.supersedes_id IS NOT NULL AND c.depth < 1000
  )
  SELECT EXISTS (
    SELECT 1 FROM chain c JOIN public.reference_measurement_sets m ON m.user_id = p_user_id AND m.id = c.id
     WHERE m.deleted_at IS NULL
       AND (m.measurement_details_json IS NOT NULL OR m.q_core_min IS NOT NULL OR m.q_core_max IS NOT NULL))
$$;

CREATE FUNCTION public.reference_use_withheld_from_v1_readers(p_user_id uuid, p_set_id uuid, p_snapshot jsonb)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (p_user_id = (SELECT auth.uid()) OR (SELECT auth.uid()) IS NULL)
     AND ((p_snapshot->>'schema_version') IS DISTINCT FROM '1'
          OR public.reference_set_withheld_from_v1_readers(p_user_id, p_set_id))
$$;

ALTER FUNCTION private.reference_client_snapshot_versions(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_client_device_id(jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_record_client_device(uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION private.reference_older_client_active(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.reference_set_withheld_from_v1_readers(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.reference_use_withheld_from_v1_readers(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reference_client_snapshot_versions(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_client_device_id(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_record_client_device(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.reference_older_client_active(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reference_set_withheld_from_v1_readers(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reference_use_withheld_from_v1_readers(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reference_set_withheld_from_v1_readers(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reference_use_withheld_from_v1_readers(uuid,uuid,jsonb) TO authenticated;

-- Direct table reads are the legacy (v1-only) feed --------------------------------
CREATE POLICY reference_measurement_sets_v1_reader_select ON public.reference_measurement_sets
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.reference_set_withheld_from_v1_readers(user_id, id));
CREATE POLICY observation_reference_uses_v1_reader_select ON public.observation_reference_uses
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.reference_use_withheld_from_v1_readers(user_id, reference_measurement_set_id, snapshot_json));

-- Capability-aware owner feed ----------------------------------------------------
-- p_entity: 'measurement_set' | 'observation_use'. Keyset pagination in the
-- table-read order (updated_at, id). Envelope:
--   {status:'ok', entity, rows:[row...], withheld_count:int, next_cursor:{updated_at,id}|null}
-- withheld_count counts the owner's rows of that entity a v1-only reader does
-- not receive (0 for a caller accepting 2). Rows are the full table rows.
CREATE FUNCTION public.list_reference_library_feed(
  p_entity text,
  p_client_capabilities jsonb DEFAULT NULL,
  p_after_updated_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_v2 boolean := 2 = ANY(private.reference_client_snapshot_versions(p_client_capabilities));
  v_limit integer := coalesce(p_limit, 500);
  v_rows jsonb; v_withheld integer; v_last record; v_count integer;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  IF v_limit < 1 OR v_limit > 1000 THEN RAISE EXCEPTION 'p_limit must be 1..1000' USING ERRCODE = '22023'; END IF;
  IF (p_after_updated_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both updated_at and id' USING ERRCODE = '22023';
  END IF;
  IF p_entity = 'measurement_set' THEN
    SELECT count(*) FILTER (WHERE public.reference_set_withheld_from_v1_readers(m.user_id, m.id))
      INTO v_withheld FROM public.reference_measurement_sets m WHERE m.user_id = v_owner;
    WITH page AS (
      SELECT m.* FROM public.reference_measurement_sets m
       WHERE m.user_id = v_owner
         AND (p_after_id IS NULL OR (m.updated_at, m.id) > (p_after_updated_at, p_after_id))
         AND (v_v2 OR NOT public.reference_set_withheld_from_v1_readers(m.user_id, m.id))
       ORDER BY m.updated_at, m.id LIMIT v_limit)
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.updated_at, p.id), '[]'::jsonb), count(*)
      INTO v_rows, v_count FROM page p;
  ELSIF p_entity = 'observation_use' THEN
    SELECT count(*) FILTER (WHERE public.reference_use_withheld_from_v1_readers(u.user_id, u.reference_measurement_set_id, u.snapshot_json))
      INTO v_withheld FROM public.observation_reference_uses u WHERE u.user_id = v_owner;
    WITH page AS (
      SELECT u.* FROM public.observation_reference_uses u
       WHERE u.user_id = v_owner
         AND (p_after_id IS NULL OR (u.updated_at, u.id) > (p_after_updated_at, p_after_id))
         AND (v_v2 OR NOT public.reference_use_withheld_from_v1_readers(u.user_id, u.reference_measurement_set_id, u.snapshot_json))
       ORDER BY u.updated_at, u.id LIMIT v_limit)
    SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.updated_at, p.id), '[]'::jsonb), count(*)
      INTO v_rows, v_count FROM page p;
  ELSE
    RAISE EXCEPTION 'p_entity must be measurement_set or observation_use' USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok', 'entity', p_entity, 'rows', v_rows,
    'withheld_count', CASE WHEN v_v2 THEN 0 ELSE v_withheld END,
    'next_cursor', CASE WHEN v_count = v_limit THEN pg_catalog.jsonb_build_object(
        'updated_at', v_rows->(v_count - 1)->'updated_at', 'id', v_rows->(v_count - 1)->'id') END);
END
$$;
ALTER FUNCTION public.list_reference_library_feed(text,jsonb,timestamptz,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_reference_library_feed(text,jsonb,timestamptz,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_reference_library_feed(text,jsonb,timestamptz,uuid,integer) TO authenticated;

-- Explicit device report (e.g. at sign-in / startup). Envelope {status:'recorded'}.
CREATE FUNCTION public.record_reference_client_capabilities(p_client_capabilities jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  IF private.reference_client_device_id(p_client_capabilities) IS NULL THEN
    RAISE EXCEPTION 'device_id is required' USING ERRCODE = '22023';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  PERFORM private.reference_record_client_device(auth.uid(), p_client_capabilities);
  RETURN pg_catalog.jsonb_build_object('status', 'recorded');
END
$$;
ALTER FUNCTION public.record_reference_client_capabilities(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_reference_client_capabilities(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_reference_client_capabilities(jsonb) TO authenticated;

-- Write wrappers: DROP + CREATE with a trailing defaulted parameter, one
-- function per name (no PostgREST overload ambiguity). Owner, SECURITY
-- DEFINER, search_path, rate limit and resulting ACL (postgres, service_role,
-- authenticated) as in 20260830193144.
DROP FUNCTION public.sync_reference_measurement_set(jsonb,bigint);
CREATE FUNCTION public.sync_reference_measurement_set(
  p_payload jsonb, p_expected_row_version bigint, p_client_capabilities jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_retry_after integer; v_owner uuid := auth.uid(); v_versions integer[]; v_id uuid; v_supersedes uuid;
  v_current public.reference_measurement_sets%ROWTYPE; v_enhanced_next boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  v_versions := private.reference_client_snapshot_versions(p_client_capabilities);
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  -- Same advisory lock as the implementation (re-entrant), so the checks
  -- below see the state the write is applied to.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  PERFORM private.reference_record_client_device(v_owner, p_client_capabilities);
  BEGIN
    v_id := (p_payload->>'id')::uuid; v_supersedes := nullif(p_payload->>'supersedes_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN v_id := NULL; v_supersedes := NULL; END;
  IF v_id IS NOT NULL AND pg_catalog.jsonb_typeof(p_payload) = 'object' THEN
    SELECT * INTO v_current FROM public.reference_measurement_sets WHERE user_id=v_owner AND id=v_id;
    v_enhanced_next := coalesce(p_payload->'measurement_details_json','null'::jsonb) <> 'null'::jsonb
       OR coalesce(p_payload->'q_core_min','null'::jsonb) <> 'null'::jsonb
       OR coalesce(p_payload->'q_core_max','null'::jsonb) <> 'null'::jsonb;
    IF NOT (2 = ANY(v_versions)) THEN
      IF v_enhanced_next
         OR (FOUND AND (v_current.measurement_details_json IS NOT NULL OR v_current.q_core_min IS NOT NULL
                        OR v_current.q_core_max IS NOT NULL
                        OR public.reference_set_withheld_from_v1_readers(v_owner, v_id)))
         OR (v_supersedes IS NOT NULL AND public.reference_set_withheld_from_v1_readers(v_owner, v_supersedes))
      THEN RETURN private.reference_result('requires_newer_client'); END IF;
    ELSIF v_enhanced_next
      AND NOT (FOUND AND (v_current.measurement_details_json IS NOT NULL OR v_current.q_core_min IS NOT NULL OR v_current.q_core_max IS NOT NULL))
      AND private.reference_older_client_active(v_owner, private.reference_client_device_id(p_client_capabilities))
    THEN
      RETURN private.reference_result('older_client_active', CASE WHEN FOUND THEN pg_catalog.to_jsonb(v_current) END);
    END IF;
  END IF;
  RETURN public.sync_reference_measurement_set_unthrottled(p_payload,p_expected_row_version);
END
$$;

DROP FUNCTION public.sync_observation_reference_use(jsonb,bigint,text);
CREATE FUNCTION public.sync_observation_reference_use(
  p_payload jsonb,p_expected_row_version bigint,p_snapshot_mode text DEFAULT 'current',
  p_client_capabilities jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE
  v_retry_after integer; v_owner uuid := auth.uid(); v_versions integer[]; v_id uuid; v_set uuid;
  v_current public.observation_reference_uses%ROWTYPE; v_v2_next boolean;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  v_versions := private.reference_client_snapshot_versions(p_client_capabilities);
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,7301));
  PERFORM private.reference_record_client_device(v_owner, p_client_capabilities);
  BEGIN
    v_id := (p_payload->>'id')::uuid; v_set := (p_payload->>'reference_measurement_set_id')::uuid;
  EXCEPTION WHEN OTHERS THEN v_id := NULL; END;
  IF v_id IS NOT NULL AND pg_catalog.jsonb_typeof(p_payload) = 'object' THEN
    SELECT * INTO v_current FROM public.observation_reference_uses WHERE user_id=v_owner AND id=v_id;
    -- New version-2 content: a client-supplied v2 snapshot, or a use whose
    -- current snapshot would be built from an enhanced set.
    v_v2_next := ((p_payload->'snapshot_json'->>'schema_version') IS NOT NULL
                  AND (p_payload->'snapshot_json'->>'schema_version') <> '1')
      OR (v_set IS NOT NULL AND public.reference_set_withheld_from_v1_readers(v_owner, v_set));
    IF NOT (2 = ANY(v_versions)) THEN
      IF v_v2_next
         OR (FOUND AND public.reference_use_withheld_from_v1_readers(v_owner, v_current.reference_measurement_set_id, v_current.snapshot_json))
      THEN RETURN private.reference_result('requires_newer_client'); END IF;
    ELSIF v_v2_next AND NOT coalesce((p_payload->>'deleted')::boolean, false)
      AND NOT (FOUND AND public.reference_use_withheld_from_v1_readers(v_owner, v_current.reference_measurement_set_id, v_current.snapshot_json))
      AND private.reference_older_client_active(v_owner, private.reference_client_device_id(p_client_capabilities))
    THEN
      RETURN private.reference_result('older_client_active', CASE WHEN FOUND THEN pg_catalog.to_jsonb(v_current) END);
    END IF;
  END IF;
  RETURN public.sync_observation_reference_use_unthrottled(
    p_payload,p_expected_row_version,p_snapshot_mode
  );
END
$$;

ALTER FUNCTION public.sync_reference_measurement_set(jsonb,bigint,jsonb) OWNER TO postgres;
ALTER FUNCTION public.sync_observation_reference_use(jsonb,bigint,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text,jsonb) TO authenticated;
