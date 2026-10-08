# Stage 4B — taxonomy parent-reference validator

Verdict: **VALIDATOR_FIX_DEPLOYED_AND_VERIFIED**. The frozen taxonomy import must
not be retried in this stage.

The failed production import hit the 2-minute timeout in the same-release parent
check. An absent-release custom plan estimated one row and chose a nested-loop
anti join with a release-only inner scan. The failed session's actual nested plan
was not captured; diagnosis is supported by the read-only plans and fresh-release
local tests rather than claimed as a captured production plan.

Old query:

```sql
select count(*) into v_dangling
from public.taxonomy_v2_taxa t
where t.release_id = p_release_id
  and t.parent_sporely_taxon_id is not null
  and not exists (
    select 1 from public.taxonomy_v2_taxa p
    where p.release_id = t.release_id
      and p.sporely_taxon_id = t.parent_sporely_taxon_id
  );
```

New query is exactly the same, with `offset 0` after the inner predicates. A zero
offset removes no rows, including empty subqueries; `EXISTS` and its null/cross-
release behavior are unchanged. It prevents anti-join flattening and preserves a
correlated primary-key lookup on both release ID and parent taxon ID. A null
parent remains ignored. An out-of-scope parent remains counted and must match the
release's declared dangling-parent count; the validator does not require zero.

The suggested constant-release rewrite alone still produced the bad absent-
release plan. Constant-release plus OFFSET 0 also timed out in the complete
PL/pgSQL validator test, so the final change retains the original correlation.

## Change and deployment

Forward migration:
`supabase/migrations/20261007123912_fix_taxonomy_v2_parent_reference_plan.sql`.
It replaces only `public.taxonomy_v2_validate_release(text)`, retaining its body,
security definer, fixed search path, owner, ACL and OID. No taxonomy rows, indexes,
release metadata, grants or timeout settings change. Applied historical migrations
and `supabase/schema.sql` are untouched.

A future separately authorized deployment must commit this migration first, then
use `scripts/supabase-deploy-tree.mjs prepare --allow 20261007123912 --ref <commit>`,
`check`, approved `supabase db push --linked` inside that tree, and `post-verify`.
This honors the documented deferred snapshot-v2 migration; no `--include-all`,
migration repair or direct production DDL. After deployment, compare the function
body/security and active-release validation result/timing read-only. Do not retry
the taxonomy import as part of the validator deployment.

## Verification

- Focused integration: **2 passed, no skips**, independently rerun by reviewer
  (4.535 s). Full old/new JSON equality for valid/null/one/two/three dangling
  parents; cross-release-only parent rejection; matching ID in another release;
  empty/absent release behavior; owner/ACL/config/OID preservation. A 52,917-row
  fresh release is loaded after old-release statistics are collected, without
  analyzing the fresh release. Plans assert both-key inner index conditions.
- Whole exact frozen import, local Docker only: install candidate inside the
  transaction, run all original loading/count/validation/activation/search/
  protected-state checks, then ROLLBACK. **4.506 s**, 2-minute timeout unchanged.
  52,917 taxa / 59,884 vernaculars / 60,697 scientific names / 56,959 external IDs /
  2,600 red-list rows validate. Fixed parent lookup **41.346 ms**, 52,917 indexed
  probes, both key dimensions despite a fresh-release estimate of 74 rows. Full
  validator **230.157 ms**. Original frozen SQL file was never rewritten.
- Representative populated local release: old/final isolated parent query
  **2448.662 / 1903.105 ms**; complete old/final validator **1990.848 / 2046.996 ms**.
  Production read-only baseline parent/full-validator timings were
  **351 ms / 2.142 s**. These are environment-specific measurements, not a
  production timing promise.
- Node taxonomy suite: **52 passed / 23 optional integration skips / 0 failures**.
  Focused integration and full frozen rollback tests ran separately without skips.
- SQL activation, Dyntaxa, national-name, schema and search suites: **5 passed**.
- Security suite: **environment limitation**. It reproducibly crashes the local
  Postgres backend with signal 11 on the unchanged baseline and candidate. A
  direct denied anon activation call reproduces it without the migration. No
  security-suite code was modified or bypassed in reported results. Catalog/ACL
  checks pass; migration's owner/ACL preservation is regression-tested. Local
  advisor warnings are pre-existing, outside this function. Production was not
  probed with the crashing permission path.
- Independent implementation-session reviewer: no defects found; independently
  verified focused integration. This does not replace a fresh top-level stage
  review or authorize deployment.
- Syntax and diff checks pass.

At 2026-10-07 14:44:44 Europe/Oslo, production still has the sole active
`tax-2026.09.30-01`, 52,917 concepts, 13,760 vernaculars, no target release/run, and
the original validator (no OFFSET). No production function change or import retry.

Frozen descriptor `a86e35854fd4d01984d8b8fe121d8fc318e75a01876d243975847127462fd14e`
and exact SQL `cc9a1ddfc4c5f56fa553935b79fb40a2eda01588f0c6d2781e243cddda84852e`
remain unchanged; `verify_frozen` passes. No artifacts regenerated.

Operational plans/logs: sporely-py `database/taxonomy/evidence/taxonomy-v3/vernacular-production-publication-2026-10-07/stage4b-prepare/`
(committed copy of the former `~/sporely-scratch/vernacular-2026-10-07-stage4b/`).
Prior production plans: sporely-py `database/taxonomy/evidence/taxonomy-v3/vernacular-production-publication-2026-10-07/stage4-attempt1/timeout-investigation/`. Tests and
migration are prepared for review, not production-applied.


## Production deployment — 2026-10-07

Reviewed migration/tests/report checkpoint `3f574390b616357c9b51dc30ae5ecf46964af027`
pushed to `feature/taxonomy-validator-parent-reference`. No merge.

Production preflight at 15:14:41 Europe/Oslo verified the exact old function,
sole active release tax-2026.09.30-01, 52,917 concepts / 13,760 active vernaculars,
three release rows, no target release/import run, and no applied fix migration.
Baseline includes row-count/content fingerprints for every taxonomy-v2 table and
seven taxonomy-v3 registry/mapping/identity/audit tables, function owner/ACL/OID/
settings, indexes, validator JSON result and timeout.

Guarded deploy tree at the checkpoint commit omitted only documented deferred
migration 20260914090000. `check` verified history and a dry-run pending set of
exactly 20261007123912. `supabase db push --linked` prompted only for that migration,
applied it, and completed successfully. `post-verify` confirmed remote history
matches the deploy tree and the deferred migration remains absent.

At 15:15:45 Europe/Oslo, production read-back matches the reviewed function source
byte-for-byte. Only the validator body changed; its owner/ACL/OID/security/settings
are identical. `taxonomy_v2_validate_release('tax-2026.09.30-01')` returns exactly
the pre-deployment JSON: ok=true, errors=[], expected=actual counts. Production
parent-check EXPLAIN ANALYZE: **511.612 ms**, correlated primary-key index lookup
with BOTH release_id=t.release_id and sporely_taxon_id=t.parent_sporely_taxon_id;
no release-only inner join filter. Full validator: **2375.4 ms**. Both ran read-only.

Every recorded taxonomy-v2/taxonomy-v3 content fingerprint and row count is
unchanged; indexes and `statement_timeout=2min` unchanged. Sole active release and
all release-state metadata unchanged. No target taxonomy release or import run.
Frozen SQL/freeze SHA-256 values above are unchanged. No import or activation ran.

Operational evidence: sporely-py `database/taxonomy/evidence/taxonomy-v3/vernacular-production-publication-2026-10-07/stage4b-deploy/`
(committed copy of the former `~/sporely-scratch/vernacular-2026-10-07-stage4b-deploy/`)
(before.json, after.json, parent-plan.json, validator-timing.json, verdict.json,
read-only migration-list/dry-run/deploy-plan records). Temporary deploy tree removed
only after verification. Next separately authorized stage may retry the exact
frozen SQL; this stage stops at verified validator deployment.
