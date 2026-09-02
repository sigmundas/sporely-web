-- Production policy for owner-authored shared reference contributions.

BEGIN;

CREATE TABLE private.shared_reference_production_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  authenticated_requests_per_minute integer NOT NULL CHECK (authenticated_requests_per_minute > 0),
  anonymous_requests_per_minute integer NOT NULL CHECK (anonymous_requests_per_minute > 0),
  catalogue_default_page_size integer NOT NULL CHECK (catalogue_default_page_size > 0),
  catalogue_max_page_size integer NOT NULL CHECK (
    catalogue_max_page_size >= catalogue_default_page_size
    AND catalogue_max_page_size <= 100
  ),
  scientific_revision_retention text NOT NULL CHECK (scientific_revision_retention = 'indefinite'),
  operational_log_retention interval NOT NULL CHECK (operational_log_retention > interval '0 seconds'),
  abuse_metadata_retention interval NOT NULL CHECK (abuse_metadata_retention > interval '0 seconds'),
  takedown_initial_review_business_days integer NOT NULL CHECK (takedown_initial_review_business_days > 0),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

INSERT INTO private.shared_reference_production_policy(
  singleton, authenticated_requests_per_minute, anonymous_requests_per_minute,
  catalogue_default_page_size, catalogue_max_page_size,
  scientific_revision_retention, operational_log_retention,
  abuse_metadata_retention, takedown_initial_review_business_days
) VALUES (
  true, 60, 30, 25, 100, 'indefinite', interval '90 days', interval '30 days', 5
);

CREATE TABLE private.shared_reference_rate_buckets (
  actor_hash text NOT NULL CHECK (actor_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (actor_hash, window_started_at)
);

CREATE INDEX shared_reference_rate_buckets_retention_idx
  ON private.shared_reference_rate_buckets(window_started_at);

CREATE TABLE private.shared_reference_policy_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('takedown_hidden','takedown_restored')),
  contribution_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR reason IN ('abuse','privacy','legal')),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX shared_reference_policy_events_retention_idx
  ON private.shared_reference_policy_events(occurred_at);

ALTER TABLE private.shared_reference_production_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.shared_reference_rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.shared_reference_policy_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION private.shared_reference_rate_limit_actor()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb := coalesce(
    nullif(pg_catalog.current_setting('request.headers',true),''),'{}'
  )::jsonb;
  v_identity text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_identity := 'user:' || auth.uid()::text;
  ELSE
    v_identity := 'public:' || coalesce(
      nullif(pg_catalog.left(v_headers->>'cf-connecting-ip',256),''),
      'unidentified'
    );
  END IF;
  RETURN pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_identity,'UTF8'),'sha256'),'hex'
  );
END
$$;

CREATE FUNCTION private.consume_shared_reference_request()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_policy private.shared_reference_production_policy%ROWTYPE;
  v_limit integer;
  v_actor_hash text;
  v_window timestamptz := pg_catalog.date_trunc('minute',pg_catalog.clock_timestamp());
  v_count integer;
BEGIN
  SELECT * INTO STRICT v_policy
    FROM private.shared_reference_production_policy WHERE singleton FOR SHARE;
  DELETE FROM private.shared_reference_rate_buckets
   WHERE window_started_at < pg_catalog.clock_timestamp()-v_policy.abuse_metadata_retention;
  v_limit := CASE WHEN auth.uid() IS NULL
    THEN v_policy.anonymous_requests_per_minute
    ELSE v_policy.authenticated_requests_per_minute END;
  v_actor_hash := private.shared_reference_rate_limit_actor();
  INSERT INTO private.shared_reference_rate_buckets(actor_hash,window_started_at,request_count)
  VALUES (v_actor_hash,v_window,1)
  ON CONFLICT (actor_hash,window_started_at) DO UPDATE
    SET request_count=private.shared_reference_rate_buckets.request_count+1
  RETURNING request_count INTO v_count;
  IF v_count > v_limit THEN
    RETURN greatest(
      1, pg_catalog.ceil(extract(epoch FROM
        (v_window + interval '1 minute' - pg_catalog.clock_timestamp())))::integer
    );
  END IF;
  RETURN 0;
END
$$;

CREATE FUNCTION private.apply_shared_reference_policy_retention()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_policy private.shared_reference_production_policy%ROWTYPE;
  v_rate_rows bigint;
  v_log_rows bigint;
BEGIN
  SELECT * INTO STRICT v_policy
    FROM private.shared_reference_production_policy WHERE singleton FOR SHARE;
  DELETE FROM private.shared_reference_rate_buckets
   WHERE window_started_at < pg_catalog.clock_timestamp()-v_policy.abuse_metadata_retention;
  GET DIAGNOSTICS v_rate_rows = ROW_COUNT;
  DELETE FROM private.shared_reference_policy_events
   WHERE occurred_at < pg_catalog.clock_timestamp()-v_policy.operational_log_retention;
  GET DIAGNOSTICS v_log_rows = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object(
    'rate_limit_rows_deleted',v_rate_rows,'operational_log_rows_deleted',v_log_rows
  );
END
$$;

CREATE FUNCTION private.log_shared_reference_takedown()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.hidden_at IS DISTINCT FROM OLD.hidden_at
     OR NEW.hidden_reason IS DISTINCT FROM OLD.hidden_reason THEN
    DELETE FROM private.shared_reference_policy_events e
     USING private.shared_reference_production_policy p
     WHERE p.singleton
       AND e.occurred_at < pg_catalog.clock_timestamp()-p.operational_log_retention;
    INSERT INTO private.shared_reference_policy_events(event_type,contribution_id,reason)
    VALUES (
      CASE WHEN NEW.hidden_at IS NULL THEN 'takedown_restored' ELSE 'takedown_hidden' END,
      NEW.id, NEW.hidden_reason
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shared_reference_takedown_log_trg
AFTER UPDATE OF hidden_at,hidden_reason ON private.shared_reference_contributions
FOR EACH ROW EXECUTE FUNCTION private.log_shared_reference_takedown();

ALTER FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid)
  RENAME TO search_public_reference_contributions_unthrottled;
ALTER FUNCTION public.get_public_reference_contribution(uuid,integer)
  RENAME TO get_public_reference_contribution_unthrottled;
ALTER FUNCTION public.share_reference_contribution(uuid,integer,integer,integer,integer)
  RENAME TO share_reference_contribution_unthrottled;
ALTER FUNCTION public.withdraw_reference_contribution(uuid)
  RENAME TO withdraw_reference_contribution_unthrottled;
ALTER FUNCTION public.sync_reference_work(jsonb,bigint)
  RENAME TO sync_reference_work_unthrottled;
ALTER FUNCTION public.sync_reference_taxon_treatment(jsonb,bigint)
  RENAME TO sync_reference_taxon_treatment_unthrottled;
ALTER FUNCTION public.sync_reference_measurement_set(jsonb,bigint)
  RENAME TO sync_reference_measurement_set_unthrottled;
ALTER FUNCTION public.sync_observation_reference_use(jsonb,bigint,text)
  RENAME TO sync_observation_reference_use_unthrottled;

REVOKE ALL ON FUNCTION public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution_unthrottled(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.share_reference_contribution_unthrottled(uuid,integer,integer,integer,integer)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.withdraw_reference_contribution_unthrottled(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sync_reference_work_unthrottled(jsonb,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sync_reference_taxon_treatment_unthrottled(jsonb,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sync_reference_measurement_set_unthrottled(jsonb,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sync_observation_reference_use_unthrottled(jsonb,bigint,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.shared_reference_rate_limited_result(p_retry_after integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.set_config('response.status','429',true);
  PERFORM pg_catalog.set_config(
    'response.headers',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'Retry-After',p_retry_after::text
    ))::text,true
  );
  RETURN pg_catalog.jsonb_build_object(
    'status','rate_limited','retry_after_seconds',p_retry_after
  );
END
$$;

CREATE FUNCTION private.guard_observation_taxon_shared_reference_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  -- Trusted server-side taxonomy reconciliation has no end-user request budget.
  IF auth.uid() IS NULL THEN
    PERFORM pg_catalog.set_config('sporely.reference_rate_limited','0',true);
    RETURN NULL;
  END IF;
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN
    PERFORM private.shared_reference_rate_limited_result(v_retry_after);
    PERFORM pg_catalog.set_config('sporely.reference_rate_limited','1',true);
  ELSE
    PERFORM pg_catalog.set_config('sporely.reference_rate_limited','0',true);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER observation_taxon_shared_reference_rate_trg
BEFORE UPDATE OF selected_sporely_taxon_id,resolved_sporely_taxon_id
ON public.observations
FOR EACH STATEMENT EXECUTE FUNCTION private.guard_observation_taxon_shared_reference_rate();

CREATE FUNCTION private.suppress_rate_limited_observation_taxon_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.current_setting('sporely.reference_rate_limited',true)='1' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER observation_taxon_shared_reference_rate_row_trg
BEFORE UPDATE OF selected_sporely_taxon_id,resolved_sporely_taxon_id
ON public.observations
FOR EACH ROW EXECUTE FUNCTION private.suppress_rate_limited_observation_taxon_update();

CREATE FUNCTION public.sync_reference_work(p_payload jsonb,p_expected_row_version bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  RETURN public.sync_reference_work_unthrottled(p_payload,p_expected_row_version);
END
$$;

CREATE FUNCTION public.sync_reference_taxon_treatment(p_payload jsonb,p_expected_row_version bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='42501'; END IF;
  v_retry_after:=private.consume_shared_reference_request();
  IF v_retry_after>0 THEN RETURN private.shared_reference_rate_limited_result(v_retry_after); END IF;
  RETURN public.sync_reference_taxon_treatment_unthrottled(p_payload,p_expected_row_version);
END
$$;

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

CREATE OR REPLACE FUNCTION public.search_public_reference_contributions_unthrottled(
  p_sporely_taxon_id integer,
  p_limit integer,
  p_after_shared_at timestamptz,
  p_after_id uuid
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_sporely_taxon_id IS NULL OR p_sporely_taxon_id <= 0 THEN
    RAISE EXCEPTION 'positive sporely_taxon_id is required' USING ERRCODE='22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;
  IF (p_after_shared_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'both cursor components are required' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT c.id,c.shared_at,r.envelope_json
      FROM private.shared_reference_contributions c
      JOIN private.shared_reference_contribution_revisions r
        ON r.contribution_id=c.id AND r.revision=c.current_revision
      JOIN public.profiles p ON p.id=c.owner_id AND p.is_banned IS FALSE
     WHERE c.sporely_taxon_id=p_sporely_taxon_id
       AND c.status='shared' AND c.hidden_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM private.reference_account_deletions d WHERE d.user_id=c.owner_id
       )
       AND (auth.uid() IS NULL OR public.is_blocked_between(auth.uid(),c.owner_id) IS NOT TRUE)
       AND (p_after_shared_at IS NULL OR c.shared_at < p_after_shared_at
         OR (c.shared_at=p_after_shared_at AND c.id > p_after_id))
     ORDER BY c.shared_at DESC,c.id ASC
     LIMIT p_limit
  ), bounded AS (
    SELECT candidates.*,
           pg_catalog.sum(pg_catalog.octet_length(envelope_json::text)) OVER (
             ORDER BY shared_at DESC,id ASC
           ) AS cumulative_bytes
      FROM candidates
  )
  SELECT envelope_json FROM bounded WHERE cumulative_bytes <= 1048576
   ORDER BY shared_at DESC,id ASC;
END
$$;

CREATE FUNCTION public.share_reference_contribution(
  p_source_measurement_set_id uuid,
  p_sporely_taxon_id integer,
  p_expected_work_revision integer,
  p_expected_treatment_revision integer,
  p_expected_measurement_set_revision integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN pg_catalog.jsonb_build_object(
      'status','rate_limited','retry_after_seconds',v_retry_after
    );
  END IF;
  RETURN public.share_reference_contribution_unthrottled(
    p_source_measurement_set_id,p_sporely_taxon_id,p_expected_work_revision,
    p_expected_treatment_revision,p_expected_measurement_set_revision
  );
END
$$;

CREATE FUNCTION public.withdraw_reference_contribution(p_contribution_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN pg_catalog.jsonb_build_object(
      'status','rate_limited','retry_after_seconds',v_retry_after
    );
  END IF;
  RETURN public.withdraw_reference_contribution_unthrottled(p_contribution_id);
END
$$;

CREATE FUNCTION public.search_public_reference_contributions(
  p_sporely_taxon_id integer,
  p_limit integer DEFAULT NULL,
  p_after_shared_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_policy private.shared_reference_production_policy%ROWTYPE;
  v_retry_after integer;
BEGIN
  SELECT * INTO STRICT v_policy
    FROM private.shared_reference_production_policy WHERE singleton;
  IF p_limit IS NOT NULL AND (p_limit < 1 OR p_limit > v_policy.catalogue_max_page_size) THEN
    RAISE EXCEPTION 'limit must be between 1 and %',v_policy.catalogue_max_page_size
      USING ERRCODE='22023';
  END IF;
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.search_public_reference_contributions_unthrottled(
    p_sporely_taxon_id,coalesce(p_limit,v_policy.catalogue_default_page_size),
    p_after_shared_at,p_after_id
  );
END
$$;

CREATE FUNCTION public.get_public_reference_contribution(
  p_contribution_id uuid,
  p_revision integer DEFAULT NULL
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_retry_after integer;
BEGIN
  v_retry_after := private.consume_shared_reference_request();
  IF v_retry_after > 0 THEN
    PERFORM pg_catalog.set_config('response.status','429',true);
    PERFORM pg_catalog.set_config(
      'response.headers',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'Retry-After',v_retry_after::text
      ))::text,true
    );
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.get_public_reference_contribution_unthrottled(
    p_contribution_id,p_revision
  );
END
$$;

ALTER FUNCTION private.shared_reference_rate_limit_actor() OWNER TO postgres;
ALTER FUNCTION private.consume_shared_reference_request() OWNER TO postgres;
ALTER FUNCTION private.shared_reference_rate_limited_result(integer) OWNER TO postgres;
ALTER FUNCTION private.guard_observation_taxon_shared_reference_rate() OWNER TO postgres;
ALTER FUNCTION private.suppress_rate_limited_observation_taxon_update() OWNER TO postgres;
ALTER FUNCTION private.apply_shared_reference_policy_retention() OWNER TO postgres;
ALTER FUNCTION private.log_shared_reference_takedown() OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions_unthrottled(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution_unthrottled(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.share_reference_contribution_unthrottled(uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.withdraw_reference_contribution_unthrottled(uuid) OWNER TO postgres;
ALTER FUNCTION public.share_reference_contribution(uuid,integer,integer,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.withdraw_reference_contribution(uuid) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_work_unthrottled(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_taxon_treatment_unthrottled(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_measurement_set_unthrottled(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_observation_reference_use_unthrottled(jsonb,bigint,text) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_work(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_taxon_treatment(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_reference_measurement_set(jsonb,bigint) OWNER TO postgres;
ALTER FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) OWNER TO postgres;
ALTER FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_public_reference_contribution(uuid,integer) OWNER TO postgres;

REVOKE ALL ON TABLE private.shared_reference_production_policy FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE private.shared_reference_rate_buckets FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON TABLE private.shared_reference_policy_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.shared_reference_rate_limit_actor() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.consume_shared_reference_request() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.shared_reference_rate_limited_result(integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.guard_observation_taxon_shared_reference_rate() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.suppress_rate_limited_observation_taxon_update() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION private.apply_shared_reference_policy_retention() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.log_shared_reference_takedown() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_reference_contribution(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.apply_shared_reference_policy_retention() TO service_role;
GRANT EXECUTE ON FUNCTION public.share_reference_contribution(uuid,integer,integer,integer,integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_reference_contribution(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reference_work(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reference_taxon_treatment(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_reference_measurement_set(jsonb,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_observation_reference_use(jsonb,bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_reference_contributions(integer,integer,timestamptz,uuid)
  TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_public_reference_contribution(uuid,integer)
  TO anon,authenticated,service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
SELECT cron.schedule(
  'shared-reference-policy-retention',
  '17 3 * * *',
  'SELECT private.apply_shared_reference_policy_retention()'
);

COMMIT;
