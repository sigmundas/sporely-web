# Supabase Database

This folder is the authoritative home for the Sporely Supabase schema.

## Rules

- `migrations/` is authoritative. Every real Supabase change belongs here.
- `schema.sql` is a generated snapshot of the live schema, not the source of truth.
- If you change the schema in the Supabase dashboard or SQL editor, follow it with a migration or a `supabase db diff` update.
- Do not try to keep Postgres DDL identical to the desktop SQLite schema; the two databases intentionally diverge where the runtimes differ.

## AI identification tables

- `public.observation_identifications` stores cached AI service result sets for a given observation and user.
- `public.observations.ai_selected_*` stores the single suggestion the user selected from a result set.
- The current AI-related migrations live in `migrations/20260516170001_add_observation_identifications.sql` and `migrations/20260517122000_add_observation_ai_selection.sql`.

## Notes

- The `schema.sql` snapshot should be regenerated from the current Supabase state when migrations change.
- Keep ad hoc dashboard SQL out of source control unless it becomes a tracked migration.

