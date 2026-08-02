# Taxonomy-v3 additive migration staging runbook

This runbook covers local rehearsal and preparation for a separately
human-authorised installation window. It does not authorise production access.
Keep the deployment manifest, observation export, approved
drift file, raw export, pseudonym key, database passwords, and service-role
credentials outside Git.

## Preconditions

1. Review commit and migration SHA-256 values against the approved change.
2. Verify the deployment manifest header and sidecars directly. Keep the
   semantic-content SHA-256 distinct from the raw input-file SHA-256.
3. Re-run the production-side read-only drift gate. Require 367 `no_drift`,
   two exactly matched approvals, zero unapproved drift, and zero missing rows.
4. Confirm a backup/PITR restore point and a maintenance owner.
5. Confirm no taxonomy-v3 client dual-read or write-path cutover is enabled.

## Local rehearsal

From `sporely-web`, against the disposable local project only:

```bash
supabase db reset --local
TAXONOMY_V3_MIGRATION_INTEGRATION=1 node --test scripts/taxonomy-v3/migrations.test.mjs
W3A2_INTEGRATION=1 node --test scripts/taxonomy-v3/w3a2-corrections.test.mjs
```

The migration test expects 369 snapshots, 369 resolution rows, 311 resolved
links, 58 NULL links, and 194 registry concepts (39 `in_cache/include`, 155
`out_of_cache/not_evaluated`). The complete release-chain installer retains
145 external mappings. This is one more than the reconciliation-only W3-B
simulator's 144 because the frozen `tax-2026.08.02-02` supplement contains the
append-only `nortaxa:nortaxa_taxon_id:189757` anchor even though no final
resolved observation references it. Do not delete or silently filter that
accepted supplement mapping to force the reconciliation-only count.

## Human-authorised staging procedure

1. Check out the reviewed commit in a clean worktree and verify all three
   migration hashes.
2. Link the Supabase CLI to the staging project using the operator's normal
   credential process. Verify the project reference twice. Never use a
   production project reference in this procedure.
3. Inspect the pending migration list, then apply only the reviewed migration
   chain using the team's standard staging migration command. The expected
   order is:

   ```text
   20260802120000_add_taxonomy_v3_core.sql
   20260802121000_integrate_taxonomy_v3_observations.sql
   20260802122000_secure_taxonomy_v3.sql
   ```

4. As a trusted installer/database role, call
   `taxonomy_v3.install_release_chain(base_json, supplements_json,
   manifest_json)` once with the frozen order
   `tax-2026.08.01-01 -> tax-2026.08.02-02 -> tax-2026.08.03-02`.
   Apply the real-ID deployment manifest only from the operator's private
   workspace. Never paste it into a ticket or commit it.
5. Call `taxonomy_v3.link_observations_to_resolution()` as the trusted role.
6. Verify counts, release hashes, dependency edges, immutable snapshots,
   legacy-column fingerprints, role guards, and observation-aware RLS. Abort
   the window if any value differs from the reviewed local rehearsal or drift
   gate.

Useful read-only verification queries:

```sql
select release_id, artifact_kind from taxonomy_v3.release_installation order by installed_at;
select * from taxonomy_v3.supplement_installation;
select cache_state, scope_state, count(*) from taxonomy_v3.registry_concept group by 1, 2 order by 1, 2;
select resolution_state, count(*) from taxonomy_v3.resolution_link group by 1 order by 1;
select count(*) filter (where resolved_sporely_taxon_id is not null) as linked,
       count(*) filter (where resolved_sporely_taxon_id is null) as null_links
  from taxonomy_v3.resolution_link;
```

## Forward-fix and rollback posture

These migrations are additive and no client cutover is included. The preferred
response to a defect is a new forward-fix migration: revoke installer/linker
execution, correct the taxonomy-v3 object or policy, revalidate locally, and
then re-enable the trusted function. Published release/audit rows and immutable
snapshots must not be rewritten.

Before any future client cutover, the legacy observation fields remain the
authoritative read path. If canonical links must be neutralised, first revoke
the trusted functions and set only `resolved_sporely_taxon_id` to NULL under an
authorised maintenance transaction; clients continue using legacy fields.
Dropping the schema or column is a last-resort, separately reviewed rollback,
not an automatic migration down-step. After a future client cutover, coordinate
client fallback before changing canonical links.

## Final production payload preparation

The additive migrations may be installed while all taxonomy-v3 tables remain
empty and every `public.observations.resolved_sporely_taxon_id` remains NULL.
Prepare the final data transaction locally; the generator never opens a
database or network connection:

```bash
node scripts/taxonomy-v3/prepare-production-install.mjs \
  --base-release ../sporely-py/database/reference_data/generated/taxonomy_v2/global_macrofungi_tax-2026.08.01-01 \
  --supplement /tmp/w2ea2v2-supp-a \
  --supplement /tmp/w2ebv2-supp-a \
  --reconciliation /tmp/w3b-final/reconciliation-manifest.json \
  --deployment-manifest /tmp/w3b-deployment/deployment-manifest-drift-checked.jsonl \
  --approved-drift /tmp/w3b-deployment/approved-drift.json \
  --current-observations /tmp/w3b-deployment/current-observations.csv \
  --output /tmp/w3b-deployment/production-install.sql
```

The command refuses hash, release-order, bridge, duplicate-ID, drift, approval,
or count mismatches. It refuses output under the repository and creates the SQL
with mode `0600` without overwriting an existing file. The private output
contains real observation IDs and must never be committed, pasted into review,
or copied to a shared location.

The generated transaction performs its own database-side preflight, snapshots
all 12 legacy taxonomy fields, installs the release chain, verifies the frozen
counts, links exactly 311 observations, compares the legacy fingerprints, and
commits only if every assertion succeeds. Verify the printed output SHA-256
through the operator's independent handoff before execution.

The generator prints the exact containerised `psql` command. Its example uses
`/path/to/private/production-db.env`; the human operator must create that
untracked file with `DATABASE_URL`, independently verify project ref
`zkpjklzfwzefhjluvhfw`, and execute only during the authorised window. Codex
must not execute that command.
