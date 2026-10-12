-- OWNER-RUN ONLY: select production project zkpjklzfwzefhjluvhfw in Dashboard.
-- Expected migration: commit 9b2287a; SHA-256
-- 7186d77230fb5b5750acbf537a7dea8f52eb6891b842d9060007cf344be5af46
-- Expected catalogs obtained by applying those exact bytes to isolated PostgreSQL 17.6.
-- Does not invoke the health RPC or read user tables. No function bodies are printed.
-- Catalog definition hashes are canonical PostgreSQL output, NOT original-file SHA-256.
-- History statement hash is informational: CLI statement splitting/comments/formatting
-- prevent a reliable raw-file byte comparison. Matching catalogs proves current
-- deployed definitions/settings, not who deployed them or original input bytes.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = pg_catalog;
WITH expected(signature, definition_hash, owner_name, definer, config_json, result_type, volatility) AS (VALUES
('private.admin_database_health_assess(jsonb)','adc725a37de82ab57943336ea19912fc','postgres',false,'["search_path=pg_catalog"]','jsonb','s'),
('private.admin_database_health_classify(text, text, boolean)','ea72c8b7333a0ada32941e39da76acc2','postgres',false,'["search_path=pg_catalog"]','TABLE(category text, component text)','i'),
('private.admin_database_health_measure()','fccf19fbc6c109339d921bdca30e73a1','postgres',false,'["search_path=pg_catalog"]','jsonb','s'),
('private.admin_database_health_mib(bigint)','777f58efd20ba92dda0a595f04e4e9a9','postgres',false,'["search_path=pg_catalog"]','text','i'),
('private.admin_database_health_statistics_usable(bigint, boolean, bigint)','f03c9b6a68bb9e4089a11998e6a2280f','postgres',false,'["search_path=pg_catalog"]','boolean','i'),
('public.admin_database_health()','9d1a16d09a9db4a214f57239f9d6b40d','postgres',true,'["search_path=pg_catalog"]','jsonb','s')
), actual AS (
 SELECT e.*,p.oid,p.proowner,p.prosecdef,p.proconfig,p.provolatile,
   md5(pg_get_functiondef(p.oid)) actual_hash,
   pg_get_function_result(p.oid) actual_result
 FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
), function_checks AS (
 SELECT signature||' / '||v.name check_name,v.expected,v.actual,
 CASE WHEN oid IS NULL THEN 'FAIL' WHEN v.expected IS NOT DISTINCT FROM v.actual THEN 'PASS' ELSE 'FAIL' END status
 FROM actual a CROSS JOIN LATERAL (VALUES
 ('definition_md5',definition_hash,actual_hash),
 ('owner',owner_name,pg_get_userbyid(proowner)),
 ('security_definer',definer::text,prosecdef::text),
 ('search_path_and_config',config_json,replace(coalesce(to_json(proconfig)::text,'null'),', ',',')),
 ('return_signature',result_type,actual_result),
 ('volatility',volatility,provolatile::text)
 ) v(name,expected,actual)
), role_checks AS (
 SELECT signature||' / effective_EXECUTE_'||r.role_name check_name,
 CASE WHEN r.role_name='postgres' OR (signature='public.admin_database_health()' AND r.role_name='service_role') THEN 'true' ELSE 'false' END expected,
 CASE WHEN oid IS NULL OR to_regrole(r.role_name) IS NULL THEN NULL
 ELSE has_function_privilege(r.role_name,oid,'EXECUTE')::text END actual
 FROM actual CROSS JOIN (VALUES ('postgres'),('anon'),('authenticated'),('service_role')) r(role_name)
), public_checks AS (
 SELECT signature||' / PUBLIC_EXECUTE' check_name,'false' expected,
 CASE WHEN oid IS NULL THEN NULL ELSE EXISTS (
 SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=a.oid),acldefault('f',proowner))) acl
 WHERE grantee=0 AND privilege_type='EXECUTE')::text END actual FROM actual a
), history AS (
 SELECT version,name,statements FROM supabase_migrations.schema_migrations WHERE version='20261011190000'
), report AS (
 SELECT * FROM function_checks
 UNION ALL SELECT check_name,expected,actual,CASE WHEN expected IS NOT DISTINCT FROM actual THEN 'PASS' ELSE 'FAIL' END FROM role_checks
 UNION ALL SELECT check_name,expected,actual,CASE WHEN expected IS NOT DISTINCT FROM actual THEN 'PASS' ELSE 'FAIL' END FROM public_checks
 UNION ALL SELECT 'migration_history / row_count','1',count(*)::text,CASE WHEN count(*)=1 THEN 'PASS' ELSE 'FAIL' END FROM history
 UNION ALL SELECT 'migration_history / name','correct_admin_database_health',max(name),CASE WHEN count(*)=1 AND max(name)='correct_admin_database_health' THEN 'PASS' ELSE 'FAIL' END FROM history
 UNION ALL SELECT 'migration_history / statements_present','nonempty original statement array',
 coalesce(max(cardinality(statements))::text,'unavailable'),CASE WHEN count(*)=1 AND max(cardinality(statements))>0 THEN 'PASS' ELSE 'UNVERIFIED' END FROM history
 UNION ALL SELECT 'migration_history / recorded_statements_md5','informational only',
 max(md5(array_to_string(statements,E'\n'))),'INFO' FROM history
 UNION ALL SELECT 'provenance / original_file_byte_identity','requires deployment artifact fingerprint',
 'Catalog match and statement availability do not establish original migration byte identity','UNVERIFIED'
)
SELECT 'DATABASE-HEALTH PROVENANCE 9b2287a' AS report,check_name,expected,actual,status
FROM report ORDER BY check_name;
ROLLBACK;
