# Sporely-web Development Plan

## Current Focus
Consolidating and finalizing cloud infrastructure elements.

## Active Tasks (TODO)
- [ ] **Run unique constraints SQL** in `MycoLog/database/supabase_unique_constraints.sql` to add `UNIQUE (desktop_id, user_id)` — needed for desktop sync upsert performance.
- [ ] **Offline queue** — wrap capture/import save failures in IndexedDB so photos aren't lost when the user is in the field without signal.
- [ ] **Capture session recovery** — decide whether camera batches should get the same resumable persistence that import sessions already have.
- [ ] **Bundle trimming** — lazy-load heavier import/map dependencies so the initial JS chunk stays small on mobile.
- [ ] **Friends feed** — query `observations_friend_view`, paginate, render like Finds list.
- [ ] **Server-side thumbnails** — consider replacing client-generated thumbnail uploads with Supabase Storage transformations if/when plan and caching tradeoffs make sense.

## Ongoing Database & Operations Tasks
- Ensure `delete-account` Edge Function is deployed and functional.
- Validate RLS policies continuously as new features are added.
