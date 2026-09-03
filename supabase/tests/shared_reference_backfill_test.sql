-- The one-time migration must not leave its privileged repair helper installed.

DO $$
BEGIN
  IF to_regprocedure(
    'private.backfill_historical_shared_reference_contributions()'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'one-time historical backfill helper remains installed';
  END IF;
END
$$;
