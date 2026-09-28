# Taxonomy v3: repair of historical `external_unresolved` observations

Migration `20260929120000_add_unresolved_observation_identity_repair.sql`
adds an operator-only repair (plan `docs/plans/active/2026-09-27-taxonomy-v3.md`,
Stage 1B). This runbook describes how to use it. **Running it against production
needs its own explicit go-ahead** under the plan's "Production steps after
Stage 6W". Deploying the migration and running the repair are separate
approvals.

## What it does

- Considers only observations with `taxon_identity_state = 'external_unresolved'`.
- Resolves each from its preserved `(taxon_identity_source_system,
  taxon_identity_namespace, taxon_identity_external_id)`, used verbatim, through
  `public.resolve_taxon_external_id_v2`, the same resolver the client calls.
- Exactly one distinct `taxon_id` gives `promote`. Zero gives `no_match`, more
  than one gives `ambiguous`, and a resolver exception gives `error`. Only
  `promote` rows change.
- A promotion sets `selected_sporely_taxon_id` and `taxon_identity_state =
  'sporely_v2'` in one statement. The preserved tuple, the raw provider id and
  every name column (`genus`, `species`, `common_name`, `ai_selected_*`) are
  left untouched. The repair never reads name text.
- Shared references follow the new identity in the same transaction. When a
  promotion changes an observation's effective taxon and the observation has
  live reference uses, apply withdraws the owner's public contribution under
  the old taxon (unless another live use still carries it) and shares under the
  new species, as the owner path does. An exception or unexpected share result
  rolls back the whole run, identity writes included. `account_unavailable`
  and `source_out_of_bounds` are recorded, not errors, because the owner path
  cannot share those either. Every action is recorded in
  `private.taxon_identity_repair_reference_actions`.

## Procedure

Run as `postgres` in an operator `psql` session. No client role (`anon`,
`authenticated`, `service_role`) can execute these functions or read the
audit tables.

1. Dry run. This is read-only and writes nothing, not even an audit row:

   ```sql
   SELECT private.taxon_identity_repair_dry_run();
   ```

   Review `release_id`, `candidate_count`, `outcome_counts`, `promotions` and
   `flagged` (ambiguous and errored rows). Keep `plan_sha256`. It hashes the
   active release plus the exact promotion set (observation id, tuple, target
   concept).

2. Apply with that hash:

   ```sql
   SELECT private.taxon_identity_repair_apply('<plan_sha256 from step 1>');
   ```

   Apply locks the active release row and every `external_unresolved` row, then
   recomputes the plan. It raises `40001` and changes nothing if the hash
   differs, for example because a bridge, the active release or an owner's
   identification changed in the meantime. In that case run step 1 again. If
   the number of updated rows is not exactly the planned count, it also raises
   and rolls back. On success it returns the dry-run report plus `run_id` and
   `promoted_count`.

3. Post-run audit: `private.taxon_identity_repair_runs` (one row per apply) and
   `private.taxon_identity_repair_items` (one row per inspected candidate, with
   its outcome and match count) and
   `private.taxon_identity_repair_reference_actions` (one row per changed
   shared-reference contribution set).

4. Idempotence check: a fresh dry run must report `promote = 0`.

While apply runs, owners' saves of `external_unresolved` observations wait on
the row locks. The apply is one short transaction, so run it at a quiet time.

## How the change reaches devices

See `docs/supabase-sync-contract.md`, item 28, "Operator repair of historical
unresolved identities". In short: `updated_at` is bumped. Desktop adopts the
new identity as a cloud-only change. If the owner edited the identification
locally, desktop reports a conflict and applies nothing. An unresolved local
identity is never pushed over it.

## Local verification

```bash
supabase db reset --local
docker exec -i supabase_db_zkpjklzfwzefhjluvhfw psql -U postgres -v ON_ERROR_STOP=1 -q \
  < supabase/tests/taxon_identity_repair_test.sql
```
