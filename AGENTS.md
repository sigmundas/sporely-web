# Agent instructions

## Staged workflow

For a staged implementation pass, complete only the selected bounded stage and
update the canonical active plan's current-stage/handoff record before stopping,
including verification, commit or manual-test status, and deferred work. Final
review occurs in a fresh top-level sparring session; reports and subagent
summaries are claims until checked against repository state and evidence.

## Supabase migration safety

Supabase migration history is production state. Treat it as immutable unless the user
explicitly asks for migration-history repair.

### Never do these without explicit user approval

- Do not edit, rename, delete, or replace a migration that has already been applied remotely.
- Do not run `supabase migration repair`.
- Do not use Supabase MCP/API `apply_migration` for repo-tracked migrations.
- Do not execute production DDL directly with SQL when the change belongs in a migration.
- Do not invent a replacement timestamp for an existing applied migration.
- Do not regenerate or overwrite `supabase/schema.sql` unless the task explicitly requires it.
- Do not stage unrelated dirty migration/schema/test files.
- Do not run `supabase db push --include-all` or `supabase migration up --linked`
  from an ordinary checkout while `supabase/deploy-exceptions.json` lists a
  deferred migration. The CLI suggests `--include-all` when it refuses a plain
  push; following that suggestion applies the deferred migration.

### Intentional migration-order gap

`supabase/deploy-exceptions.json` lists migrations that are committed on
`main` but deliberately not applied to production. Today that is
`20260914090000_extend_reference_snapshots_to_version_2.sql`; see
`docs/deployments/2026-09-25-migration-order-exception.md`.

While that list is non-empty:

- `supabase migration list` from `main` shows the deferred version as
  local-only. That row is the documented gap, not a mismatch to repair. Any
  other disagreement still means STOP.
- A plain `supabase db push` from `main` refuses (the deferred file is older
  than the latest remote migration). Do not work around the refusal.
- Deploy production migrations only through
  `node scripts/supabase-deploy-tree.mjs` (steps 7–9 below).
- Never rename, retime, edit, or delete a deferred migration file. Its
  filename and SHA-256 are pinned in the registry.

### Required workflow for a new migration

1. Before changing migrations, run:

   `supabase migration list`

2. If local and remote history disagree anywhere before the new migration:
   STOP and report the mismatch. Do not repair it automatically. The only
   exception is a version listed in `supabase/deploy-exceptions.json`.

3. Create a new migration locally under `supabase/migrations/`.

4. Test locally first, normally with:

   `supabase db reset`

   and the relevant SQL/application tests.

5. Do not apply the migration remotely during development/audit.

6. Commit the local migration before deployment.

7. Before deploying, run:

   `supabase migration list`
   `supabase db push --dry-run`

   While `supabase/deploy-exceptions.json` lists a deferred migration, do this
   instead, from the user's terminal, with the exact approved versions:

   `node scripts/supabase-deploy-tree.mjs prepare --allow <version[,version]> --ref <committed ref>`
   `node <deploy tree>/scripts/supabase-deploy-tree.mjs check --tree <deploy tree>`

   `prepare` builds a temporary worktree of the committed ref without the
   deferred files and verifies the production link. `check` runs the read-only
   `migration list` and `db push --dry-run` there and refuses unless the
   pending set and the dry run are exactly the allowlist.

8. Only use:

   `supabase db push`

   to deploy a normal repo-tracked migration. While the gap exists, the user
   runs `supabase db push --linked` inside the deploy tree, and only after
   `check` passed. Agents never run the real push.

9. After pushing, run `supabase migration list` again and verify the local and
   remote migration versions match exactly. While the gap exists, run
   `post-verify --tree <deploy tree>` instead, then remove the deploy tree.

### If a migration mismatch appears

STOP.

Report:

- the mismatched Local and Remote versions
- the corresponding filenames
- whether either version is already applied remotely
- `git status`
- the tail of `supabase migration list`

Do not rename files, use `migration repair`, reapply SQL, or alter remote migration
history unless the user explicitly approves the specific recovery plan.

### Historical migrations

Once a migration version appears in the Remote column of `supabase migration list`,
consider that migration immutable.

Any correction to already-applied database behavior must normally be implemented as
a NEW compensating migration, not by changing the historical migration.

## Working-tree hygiene

This repository often contains concurrent uncommitted work.

- Inspect `git status` before staging.
- Stage only files belonging to the current task.
- Use `git add -p` for mixed files.
- Never bundle unrelated `supabase/schema.sql`, migrations, tests, docs, or UI changes.
- Do not add `deno.lock` unless the task specifically requires it.
