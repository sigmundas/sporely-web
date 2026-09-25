# Production migration-order exception — 2026-09-25

**Status:** approved by the owner on 2026-09-25. This is a deliberate,
documented exception to timestamp-ordered migration history.

## What is deployed

These four reviewed migrations go to production now, in timestamp order:

| Migration | Reviewed at | SHA-256 |
|---|---|---|
| `20260922120000_add_observation_taxon_identity_provenance.sql` | sporely-web `a0a5a4b` | `127aefe4cb5ccf1f719e9992ed288cbdd3b84799cd5f3415d998176741e1700c` |
| `20260922130000_selected_taxon_rpc_owns_identity_state.sql` | sporely-web `a0a5a4b` | `9cd372aa355071a3af3c03928927c9faf020ad119097e818a1234bdd5de8f4a8` |
| `20260922140000_atomic_observation_identification.sql` | sporely-web `a0a5a4b` | `cf51e3b7d5c5754496168dda5873fef416ee34e777c7220e4637d9af93dd0487` |
| `20260925120000_owner_sync_metadata_parents.sql` | sporely-web `94c7f2f` | `c123c611624c0b59c3c4e45786c62d17c16ff82b22d34cca72eadba8d56979ae` |

## What is deliberately deferred

`20260914090000_extend_reference_snapshots_to_version_2.sql` (on `origin/main`
since merge `f45a19d`) is **not** deployed, although it is older than the four
above. It is not modified or renamed.

Reason: its own documented rollout precondition is unmet.

- Released desktop readers do not accept snapshot v2 yet. The latest desktop
  release, v0.9.22 (2026-08-30), still rejects anything but
  `schema_version == 1` (`database/reference_use_sync_reconciliation.py`,
  `utils/archive/portable_import.py`). The reader support is on sporely-py
  `origin/main` but unreleased (contract
  `docs/reference-data/measurement-content-contract.md` §7, reader rollout
  step 1).
- The public shared-contribution envelope version decision is unresolved
  (see the migration's own header: `share_reference_contribution` could
  otherwise publish a v2 snapshot through anon readers).

The deferred migration touches no object that the four deployed migrations
touch, and they touch none of its objects, so applying it later out of order
is semantically safe.

## Deploying other migrations while 20260914090000 is deferred

The gap is recorded in `supabase/deploy-exceptions.json` (production project
ref, deferred filename and its SHA-256). From `main`, a plain
`supabase db push` refuses with "Found local migration files to be inserted
before the last migration on remote database" and suggests `--include-all`.
That suggestion would apply `20260914090000`. Do not follow it.

Every later migration (Stage A's RLS migration first) is deployed from a
temporary worktree of a committed ref that omits only the deferred files,
using `scripts/supabase-deploy-tree.mjs`:

1. `node scripts/supabase-deploy-tree.mjs prepare --allow <version> --ref <committed ref>`
   creates a detached worktree of that commit and verifies the deferred file
   is present, unrenamed, and unchanged before removing it there. It refuses
   an allowlisted deferred version, a version with no file, or a Supabase
   link other than the production ref. It copies the link metadata from your
   checkout's `supabase/.temp/`.
2. `node <tree>/scripts/supabase-deploy-tree.mjs check --tree <tree>` runs
   `supabase migration list --linked` and `supabase db push --linked --dry-run`
   in the tree. Both are read-only. It refuses unless:
   - the tree is linked to the production project and is exactly its commit
     minus the deferred files;
   - no remote-only migration exists;
   - the pending set and the dry-run set both equal the allowlist exactly;
   - the deferred version appears in neither.
   Outputs you captured yourself can be passed with `--list-file` and
   `--dry-run-file`.
3. Only after `check` passes, you run `supabase db push --linked` in the tree,
   and confirm the CLI prompt lists exactly the allowlist. The helper never
   runs this.
4. `node <tree>/scripts/supabase-deploy-tree.mjs post-verify --tree <tree>`
   requires local and remote to match exactly, with the deferred version
   still absent. Then run the stage's own read-only verification and remove
   the tree with the printed `git worktree remove` command.

## Deploying 20260914090000 later

After both of its rollout gates are satisfied (released desktop readers accept
snapshot v2, and the shared-envelope version decision is made and
implemented), deploy it with:

```
supabase db push --include-all
```

`--include-all` is required because production will already contain the newer
`20260922*` and `20260925120000` migrations; without it the CLI refuses to
insert an older migration before the last applied one. Before running it:

1. `supabase migration list` — confirm `20260914090000` is the only local
   migration missing on remote.
2. `supabase db push --include-all --dry-run` — confirm it lists exactly
   `20260914090000`.
3. Run `supabase/tests/reference_snapshot_v2_test.sql` and
   `supabase/tests/reference_measurement_content_extension_test.sql` against a
   local replay of production history.

That rollout is its own reviewed change: it removes the entry from
`supabase/deploy-exceptions.json` in the same commit, which returns ordinary
migrations to the plain `AGENTS.md` workflow. `scripts/supabase-deploy-tree.mjs`
deliberately refuses to allowlist a deferred version.

## Evidence

- Full replay of production history (105 migrations up to `20260913120000`)
  plus the pending migrations, in throwaway containers: all apply; every
  `supabase/tests` file matches or improves on the `origin/main` baseline.
- Independent security review (no blocking issues) of the owner-sync migration
  at `94c7f2f`; the identity migrations were verified with the web candidate
  `a0a5a4b`.
- No application code is deployed with this migration change.
