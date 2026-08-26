# Agent instructions

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

### Required workflow for a new migration

1. Before changing migrations, run:

   `supabase migration list`

2. If local and remote history disagree anywhere before the new migration:
   STOP and report the mismatch. Do not repair it automatically.

3. Create a new migration locally under `supabase/migrations/`.

4. Test locally first, normally with:

   `supabase db reset`

   and the relevant SQL/application tests.

5. Do not apply the migration remotely during development/audit.

6. Commit the local migration before deployment.

7. Before deploying, run:

   `supabase migration list`
   `supabase db push --dry-run`

8. Only use:

   `supabase db push`

   to deploy a normal repo-tracked migration.

9. After pushing, run `supabase migration list` again and verify the local and
   remote migration versions match exactly.

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