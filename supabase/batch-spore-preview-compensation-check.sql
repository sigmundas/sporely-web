-- Batch spore-preview RPC: check after a compensating migration (read-only,
-- aggregate-only).
--
-- Runbook: supabase/batch-spore-preview-runbook.md, step 4 ("Validating a
-- compensation"). Run it locally against the compensated database first, then
-- in production after the compensating migration is deployed.
--
-- Run as the database owner (postgres), with psql. mode=pre checks the state
-- 20261011120000 left (run it before the compensation, for the comparison
-- figures); mode=r1 or mode=r2 checks the state after that option:
--
--   psql "<connection string>" -X -v ON_ERROR_STOP=1 -v mode=r1 -f supabase/batch-spore-preview-compensation-check.sql
--
-- Every assertion raises on failure, and psql then stops with a non-zero
-- exit. On success it prints booleans and integers only; observation ids are
-- chosen inside the transaction and never printed. One READ ONLY transaction,
-- ending in ROLLBACK.

\if :{?mode}
\else
  \echo 'set -v mode=pre, -v mode=r1 or -v mode=r2'
  \quit
\endif

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT /* bsp_probe */ pg_catalog.set_config('bsp_probe.mode', :'mode', true) IS NOT NULL AS mode_stored;

-- --- Part A: catalog ---------------------------------------------------------
-- pre: the batch function, the six helpers, and both public read functions
-- calling them, as 20261011120000 left them.
-- R1 drops only the batch function: the six private helpers stay, and both
-- public read functions still call them.
-- R2 drops the batch function and the six helpers, and restores both public
-- read functions to their 20260925120000 / 20261001195524 bodies, which
-- reference no private helper.
-- All modes: owner, SECURITY DEFINER, search_path and grants of the two public read
-- functions are those from before 20261011120000.

DO $$
DECLARE
  v_mode text := current_setting('bsp_probe.mode');
  -- pre and r1 keep the helpers and the calls to them; r2 removes both.
  v_expect_helpers int := CASE WHEN current_setting('bsp_probe.mode') = 'r2' THEN 0 ELSE 6 END;
  v_expect_users int := CASE WHEN current_setting('bsp_probe.mode') = 'r2' THEN 0 ELSE 2 END;
  v_helpers int;
  v_uses_helpers int;
  r record;
BEGIN
  IF v_mode NOT IN ('pre', 'r1', 'r2') THEN
    RAISE EXCEPTION 'mode must be pre, r1 or r2, got %', v_mode;
  END IF;

  IF (pg_catalog.to_regprocedure('public.get_public_observation_spore_previews(bigint[])') IS NOT NULL)
     <> (v_mode = 'pre') THEN
    RAISE EXCEPTION 'batch function presence is wrong for %', v_mode;
  END IF;

  SELECT count(*) INTO v_helpers
  FROM pg_catalog.pg_proc h
  JOIN pg_catalog.pg_namespace n ON n.oid = h.pronamespace
  WHERE n.nspname = 'private'
    AND h.proname IN ('public_observation_eligibility',
                      'public_observation_spore_point_rows',
                      'public_observation_spore_points_raw',
                      'public_observation_spore_mosaic_raw',
                      'public_observation_authorize_spore_points',
                      'public_observation_authorize_spore_mosaic');
  IF v_helpers <> v_expect_helpers THEN
    RAISE EXCEPTION '% private helpers present, expected % for %',
      v_helpers, v_expect_helpers, v_mode;
  END IF;

  IF v_mode <> 'r2' AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc h
    JOIN pg_catalog.pg_namespace n ON n.oid = h.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) x(role)
    WHERE n.nspname = 'private'
      AND h.proname LIKE 'public_observation\_%'
      AND pg_catalog.has_function_privilege(x.role, h.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'a private helper is executable by a client role';
  END IF;

  SELECT count(*) INTO v_uses_helpers
  FROM pg_catalog.pg_proc p
  WHERE p.oid IN ('public.get_public_observation(bigint)'::pg_catalog.regprocedure,
                  'public._get_public_observation_stage2a(bigint)'::pg_catalog.regprocedure)
    AND p.prosrc LIKE '%private.public_observation_%';
  IF v_uses_helpers <> v_expect_users THEN
    RAISE EXCEPTION '% public read functions reference the private helpers, expected % for %',
      v_uses_helpers, v_expect_users, v_mode;
  END IF;

  FOR r IN
    SELECT p.oid::pg_catalog.regprocedure::text AS fn,
           pg_catalog.pg_get_userbyid(p.proowner) AS owner,
           p.prosecdef, p.provolatile, p.proconfig,
           pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
           pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_x,
           EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x,
           p.proacl IS NULL AS default_acl
    FROM pg_catalog.pg_proc p
    WHERE p.oid IN ('public.get_public_observation(bigint)'::pg_catalog.regprocedure,
                    'public._get_public_observation_stage2a(bigint)'::pg_catalog.regprocedure)
  LOOP
    IF r.owner <> 'postgres' OR NOT r.prosecdef OR r.provolatile <> 's'
       OR r.proconfig IS DISTINCT FROM ARRAY['search_path=public']
       OR r.public_x OR r.default_acl THEN
      RAISE EXCEPTION '% lost its owner, SECURITY DEFINER, STABLE, search_path or ACL', r.fn;
    END IF;
    -- get_public_observation: anon, authenticated, service_role.
    -- _get_public_observation_stage2a: owner only.
    IF (r.fn LIKE 'get_public_observation(%' AND NOT (r.anon_x AND r.auth_x AND r.service_x))
       OR (r.fn LIKE '_get_public_observation_stage2a(%' AND (r.anon_x OR r.auth_x OR r.service_x)) THEN
      RAISE EXCEPTION '% has unexpected grants: anon %, authenticated %, service_role %',
        r.fn, r.anon_x, r.auth_x, r.service_x;
    END IF;
  END LOOP;
END $$;

SELECT /* bsp_probe */ true AS catalog_ok;

-- --- Part B: get_public_observation as anon --------------------------------------
-- The same samples as batch-spore-preview-live-probe.sql.

SELECT /* bsp_probe */ pg_catalog.set_config('bsp_probe.public_ids', coalesce((
  SELECT pg_catalog.array_agg(s.id)::text FROM (
    SELECT o.id
    FROM public.observations o
    WHERE o.visibility = 'public'
      AND NOT coalesce(o.is_draft, false)
      AND o.spore_data_visibility = 'public'
      AND EXISTS (
        SELECT 1
        FROM public.observation_images i
        JOIN public.spore_measurements m ON m.image_id = i.id
        WHERE i.observation_id = o.id
      )
    ORDER BY o.id DESC
    LIMIT 30
  ) s), '{}'), true) IS NOT NULL AS public_sample_stored;

SELECT /* bsp_probe */ pg_catalog.set_config('bsp_probe.nonpublic_ids', coalesce((
  SELECT pg_catalog.array_agg(s.id)::text FROM (
    SELECT o.id
    FROM public.observations o
    WHERE o.visibility IS DISTINCT FROM 'public' OR coalesce(o.is_draft, false)
    ORDER BY o.id DESC
    LIMIT 30
  ) s), '{}'), true) IS NOT NULL AS nonpublic_sample_stored;

SELECT /* bsp_probe */ pg_catalog.set_config('request.jwt.claims', '', true) IS NOT NULL AS claims_cleared;
SET LOCAL ROLE anon;

-- Expect: caller = anon, uid_is_null = t, public_sample > 0,
-- public_rows_with_points >= 1, nonpublic_sample > 0, nonpublic_rows = 0.
-- public_rows, public_mosaic_rows and public_mosaic_rows_with_url are for
-- comparison with the same columns from a run before the compensation
-- (get_public_observation keeps its legacy url under both options).
WITH ids AS (
  SELECT
    current_setting('bsp_probe.public_ids')::bigint[]    AS public_ids,
    current_setting('bsp_probe.nonpublic_ids')::bigint[] AS nonpublic_ids
),
pub AS (
  SELECT g.*
  FROM ids CROSS JOIN LATERAL unnest(ids.public_ids) i
  CROSS JOIN LATERAL public.get_public_observation(i) g
),
nonpub AS (
  SELECT g.id
  FROM ids CROSS JOIN LATERAL unnest(ids.nonpublic_ids) i
  CROSS JOIN LATERAL public.get_public_observation(i) g
)
SELECT /* bsp_probe */
  current_user                                                         AS caller,
  auth.uid() IS NULL                                                   AS uid_is_null,
  (SELECT cardinality(public_ids) FROM ids)                            AS public_sample,
  (SELECT count(*) FROM pub)                                           AS public_rows,
  (SELECT count(*) FROM pub WHERE jsonb_array_length(coalesce("sporePoints", '[]')) > 0) AS public_rows_with_points,
  (SELECT count(*) FROM pub WHERE "sporeMosaic" IS NOT NULL)           AS public_mosaic_rows,
  (SELECT count(*) FROM pub WHERE "sporeMosaic" ? 'url')               AS public_mosaic_rows_with_url,
  (SELECT cardinality(nonpublic_ids) FROM ids)                         AS nonpublic_sample,
  (SELECT count(*) FROM nonpub)                                        AS nonpublic_rows;

ROLLBACK;
