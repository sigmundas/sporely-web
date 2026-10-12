# Owner-run database-health provenance check

In Supabase Dashboard SQL Editor, select project `zkpjklzfwzefhjluvhfw`, paste
and run `20261011190000_database_health_provenance.sql`. Return the single
labelled result table. Run as the normal administrative SQL Editor role.
No agent production SQL is required. The script uses a read-only transaction,
a 15-second timeout and ROLLBACK. It reads catalogs and migration history only;
it does not call the health RPC or access application rows.

Expected source: sporely-web commit `9b2287a`, migration SHA-256
`7186d77230fb5b5750acbf537a7dea8f52eb6891b842d9060007cf344be5af46`.
Expect PASS for all function, role and migration-row/name checks. Statement
availability is PASS or UNVERIFIED. The statement MD5 is INFO, not a match
assertion. Original SQL file byte identity is deliberately UNVERIFIED: stored
statement splitting, comments and formatting cannot reliably reconstruct the
input file. No deployment author or review acceptance is established by this
check. Preserve that provenance limitation even if catalog checks pass.

Canonical definition MD5 hashes compare complete pg_get_functiondef output
from PostgreSQL 17.6. Signatures are fully schema-qualified. Definition hashes
cover argument signatures/defaults, return type, SQL body and function settings;
owner, security mode, proconfig/search path and volatility are also compared
explicitly. Effective EXECUTE is tested for postgres, anon, authenticated and
service_role, including inherited grants. PUBLIC EXECUTE is checked separately.
These role checks concern the application roles named in the migration; they
are not a complete audit of every custom administrative role or schema USAGE.
A missing function/role yields FAIL. Catalog access failure stops the script;
do not reinterpret failure to run as a successful check.

Local validation (2026-10-12): exact migration applied only to a new isolated
`health_provenance_expected` PostgreSQL 17.6 database. Baseline function checks
all PASS. Deliberate anon EXECUTE grant, SECURITY INVOKER change and search-path
change produced FAIL. Reapplying exact local migration restored PASS. NULL
history statements produced UNVERIFIED. History used a synthetic local row,
not purported production statements. No production function bodies printed.

Scratch reproduction inputs/scripts/results:
`/Users/sigmundas/sporely-scratch/health-provenance/`
(`migration.sql`, `generate.py`, `test.py`, `baseline.txt`). These are local
validation artifacts, not production/deployment evidence.

Owner-returned production report (2026-10-12): 69 PASS, 1 informational stored-statement hash, and 1 explicitly UNVERIFIED original-file byte-identity check. All six deployed function definitions, signatures, owners, security settings, search paths and named-role effective permissions match commit `9b2287a`. History has one correctly named row and 22 nonempty statements; recorded statement MD5 is `0a66b768589c7b96b8275fe96388bfc2`. The returned catalog report establishes deployed function equivalence, not a deployment artifact fingerprint, author attribution or prior independent review. See `20261011190000_owner_results.csv`. This is owner-supplied production evidence; no agent production queries were run.

Reconciliation preserves migration version `20261011190000` and exact source bytes. Never reapply it. Batch deployment and Landing integration remain gated on the final candidate review, owner approval and the production deployment runbook.
