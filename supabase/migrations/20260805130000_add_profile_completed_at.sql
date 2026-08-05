-- Explicit onboarding state for the Profile setup gate.
--
-- Runtime code determines "profile complete" from `profile_completed_at`
-- alone. `handle_new_user()` inserts rows with `profile_completed_at = null`,
-- so trigger-seeded profiles remain incomplete and are routed through the
-- setup screen on first sign-in. The Profile setup save writes both the
-- editable fields and `profile_completed_at` together in one update.
--
-- Ordinary profile edits after onboarding do NOT touch `profile_completed_at`
-- (the client only sets it during the setup transition), so completeness is
-- persistent once achieved.

alter table public.profiles
  add column if not exists profile_completed_at timestamptz;

-- ── One-time backfill for existing established users ──────────────────────
-- We can't ask users to re-onboard. A profile is treated as established when
-- historical evidence points to real user activity:
--
--   1) `updated_at` differs from `created_at` by more than one second — the
--      `set_updated_at` trigger only bumps `updated_at` on real UPDATE
--      statements, never on the initial INSERT by `handle_new_user()`; OR
--   2) `avatar_url` is not null — the trigger never sets avatar, so any value
--      here is evidence of a user-driven upload.
--
-- Both are proxies with known limits:
--   - A user whose profile was inserted, then updated within a second by a
--     script (unlikely in practice) could be false-positive established;
--   - A user who saved the exact same field values could be missed if the
--     trigger no-ops the update (Supabase does still fire the trigger on any
--     UPDATE statement, so this is unlikely in practice).
--
-- These are acceptable trade-offs for a one-shot backfill. Runtime code does
-- NOT use these heuristics — only this migration does.
update public.profiles
set profile_completed_at = coalesce(updated_at, created_at, now())
where profile_completed_at is null
  and username is not null
  and btrim(username) <> ''
  and display_name is not null
  and btrim(display_name) <> ''
  and (
    (
      updated_at is not null
      and created_at is not null
      and (updated_at - created_at) > interval '1 second'
    )
    or (avatar_url is not null and btrim(avatar_url) <> '')
  );

notify pgrst, 'reload schema';
