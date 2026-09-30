# Taxonomy v3: repair of resolutions on retired concepts

Migration `20260930202803_add_retired_concept_resolution_repair.sql` adds an
operator-only repair that moves W3 resolutions off the 19 concepts retired by
approved Stage 2 supersessions, so the `tax-2026.09.30-01` retiring-concept
check passes. Deploying the migration, the production dry run and the apply are
separate approvals (`supabase/taxonomy-v2-production-import-runbook.md`,
"Retired-concept resolution repair (before the import)").

## What it does

- Uses a pinned manifest of 19 `(superseded, survivor, supersession_id)`
  records from sporely-py `concept_supersessions.yml` at `9609542`
  (`approved_manifest.member.nortaxa_sporely_taxon_id -> col_sporely_taxon_id`).
  Every function refuses unless the literal hashes to `manifest_sha256`
  `2585d08a93b4f7ceff5a258e5f4362a1dbe8e68cf3ed925eca011f8a08021a49`
  (sorted `old,new\n` lines) and to the record hash that also covers the
  supersession ids.
- Every `taxonomy_v3.resolution_link` row resolved to a retired id is an item.
  Its `resolved_sporely_taxon_id` moves to the survivor, and one evidence
  object (`kind` `retired_concept_resolution_repair`, both ids,
  `supersession_id`, `ledger_commit`, `manifest_sha256`, `repair_run_id`) is
  appended to `resolution_evidence`. `resolution_state`, `resolution_method`,
  `resolution_release` and `manifest_semantic_sha256` are unchanged.
- The matching `observations.resolved_sporely_taxon_id` moves in the same
  transaction. A link whose observation row no longer exists is repaired on
  the link only and audited with `observation_updated = false`.
- Survivors missing from `taxonomy_v3.registry_concept` are inserted from the
  active release: `canonical_name` = `canonical_scientific_name`, `rank` =
  `taxon_rank`, `scope_state` `not_evaluated`, `cache_state` `out_of_cache`,
  `first_materialized_from_release` = the active release. Existing rows are
  never modified.
- No name column, selection or shared reference is touched.

Refusals (reported by the dry run; apply raises `55000` and changes nothing):
`active_release_count`, `survivor_not_in_active_release`,
`link_observation_disagreement`, `observation_selects_retired_concept`,
`live_observation_reference_uses`,
`shared_reference_contribution_on_retired_concept`,
`resolution_evidence_not_array`, `registry_conflict` (an existing survivor row
whose name or rank differs from the release).

## Procedure

As `postgres` in an operator `psql` session. No client role can execute the
functions or read the audit tables.

1. Dry run (read-only; wrap it in `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`
   in production):

   ```sql
   SELECT jsonb_pretty(private.retired_resolution_repair_dry_run() - 'items');
   ```

   Review `release_id`, `link_count`, `observation_count`,
   `orphan_link_count`, `per_pair`, `registry_additions` and `refusals` (must
   be `[]`). Keep `plan_sha256`: it covers the active release, the manifest
   hash, every item `(observation_id, superseded, survivor, observation
   present)` and the registry rows to add.

2. Apply:

   ```sql
   SELECT private.retired_resolution_repair_apply('<plan_sha256>');
   ```

   Apply locks the active release, the survivors' release and registry rows,
   the affected links and observations (FOR UPDATE, links first) and their
   reference uses, then recomputes the report. It raises `40001` if the hash
   differs or a row count differs from the plan, and verifies afterwards that
   no link or observation references a retired id.

3. Audit:

   ```sql
   SELECT * FROM private.retired_resolution_repair_runs ORDER BY run_id;
   SELECT * FROM private.retired_resolution_repair_items WHERE run_id = <run_id>;
   SELECT * FROM private.retired_resolution_repair_registry_additions WHERE run_id = <run_id>;
   ```

4. Idempotence: a fresh dry run reports `link_count` 0 and no registry
   additions. Then re-run `taxonomy-v3-tax-2026.09.30-01-retiring-concept-check.sql`.

## How the change reaches devices

The observations UPDATE bumps `updated_at` (`set_updated_at`), so owners'
devices pull the new `resolved_sporely_taxon_id` as an ordinary cloud-side
change, as with Stage 1B. `media_version` is not bumped; the shared-reference
triggers do nothing (no JWT, and no live use exists or apply refuses).

## Local verification

```bash
supabase db reset --local
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 < supabase/tests/retired_resolution_repair_test.sql
```
