-- PostgREST treats SQLSTATE 40001 as a retryable serialization failure. A
-- stale reconciliation snapshot is an expected compare-and-set conflict, so
-- surface it immediately as HTTP 409 instead of allowing infrastructure-level
-- retries.
DO $migration$
DECLARE
  v_signature regprocedure :=
    'public.reconcile_profile_storage_usage(uuid,bigint,bigint,integer,bigint,integer,text,uuid,text,jsonb,jsonb,jsonb)'::regprocedure;
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  IF position('40001' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected reconciliation SQLSTATE 40001 was not found';
  END IF;
  EXECUTE replace(v_definition, '40001', 'PT409');
END;
$migration$;
