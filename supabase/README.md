# Supabase Database

This folder is the authoritative home for the Sporely Supabase schema.

## Rules

- `migrations/` is authoritative. Every real Supabase change belongs here.
- `schema.sql` is a generated snapshot of the live schema, not the source of truth.
- If you change the schema in the Supabase dashboard or SQL editor, follow it with a migration or a `supabase db diff` update.
- Do not try to keep Postgres DDL identical to the desktop SQLite schema; the two databases intentionally diverge where the runtimes differ.

## AI identification tables

- `public.observation_identifications` stores cached AI service result sets for a given observation and user, and visible observations can be read by viewers.
- `public.observations.ai_selected_*` stores the single suggestion the user selected from a result set.
- The current AI-related migrations live in `migrations/20260516170001_add_observation_identifications.sql`, `migrations/20260517122000_add_observation_ai_selection.sql`, and `migrations/20260520123000_detail_ai_visibility.sql`.

## Account entitlement / privacy enforcement

- `public.profiles` contains both user-editable profile fields and server-owned entitlement/quota state.
- Server-owned fields include `cloud_plan`, `is_pro`, `full_res_storage_enabled`, `storage_quota_bytes`, `storage_used_bytes`, `billing_status`, `billing_provider`, `total_storage_bytes`, `image_count`, `is_admin`, and `is_banned`.
- Normal authenticated writes cannot change those server-owned fields; the `trg_profiles_protect_privileged_fields` trigger preserves them.
- Free accounts can keep at most 20 cloud observations that are private or fuzzed (`visibility != 'public' OR location_precision = 'fuzzed'`); the enforcement trigger takes a per-user lock so concurrent inserts cannot race past the cap.
- The R2 upload worker updates storage tallies through the service-role RPC `apply_profile_storage_delta`, which is not callable by normal authenticated users.

## Notes

- The `schema.sql` snapshot should be regenerated from the current Supabase state when migrations change.
- Keep ad hoc dashboard SQL out of source control unless it becomes a tracked migration.
- The Phase 1 Free/Pro integrity migration lives in `migrations/20260530121500_free_pro_entitlement_integrity.sql`.
