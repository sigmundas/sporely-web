/clear# Agent instructions

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

## Git policy

These rules apply to this repository and override conflicting shared Sporely
workflow defaults (including the parent's Claude commit/push policy). Explicit
user instructions take precedence over repository defaults. A generated stage
prompt does not by itself authorize overriding a repository Git restriction.

Agents may create branches, commit, push, merge, and delete branches as needed
to complete the task.

Use normal Git workflows and keep history understandable.

Do not:
- force-push unless the user explicitly asks for it;
- rewrite published history unnecessarily;
- push secrets or credentials;
- merge obviously unrelated work;
- deploy, publish a release, or modify production systems unless the task
  explicitly includes that.

For staged/agent-sparring work:
- commit and push completed stage work;
- merge when the stage or plan calls for it;
- leave a clear handoff describing what changed, what was tested, and any
  unresolved issues.

This permission does not weaken the rules elsewhere in this file. Only work
whose verification has actually passed may be committed; work whose
verification needs the user (interactive behavior, live Supabase writes, RLS,
cross-client sync, judgment about how output reads) stays uncommitted until the
user confirms. It also grants nothing under **Supabase migration safety**:
pushing a commit is not approval to run `supabase db push`, `migration repair`,
or any other remote migration action, and **Working-tree hygiene** still governs
what may be staged.
