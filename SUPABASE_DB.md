# Sporely Web — Supabase / Postgres Database

## Overview
This document is the source of truth for the Supabase/Postgres side of Sporely Web:
- schema inventory (tables, views, functions/RPCs)
- ownership rules ("who can read/write")
- RLS behavior (descriptions only; **no policy SQL**)
- Storage bucket conventions (folder/path rules)
- operational checklist for maintaining the cloud DB

See also:
- `ARCHITECTURE.md` for product-level architecture
- `CLAUDE.md` for repo/agent usage conventions

---

## Supabase project
- Project URL: `https://zkpjklzfwzefhjluvhfw.supabase.co`
- Client access from the web app uses the **publishable anon key**.
- All client data access is enforced by **RLS** and Storage policies.

---

## Schema inventory

### Core application tables
- `observations`
  - Cloud counterpart of the desktop SQLite `observations`
  - Mobile writes: `user_id, date, gps_latitude, gps_longitude, source_type`
  - Additional cloud-only columns:
    - `user_id` (FK to `auth.users`, enforced by RLS)
    - `desktop_id` (desktop SQLite `id`, used for dedup and sync)
    - `location_public` (controls whether GPS is visible outside private mode)
    - `visibility` (text, default `'private'` — visibility scope: `'private'`, `'friends'`, `'public'`)
- `observation_images`
  - Metadata rows for images uploaded to Storage
  - Columns:
    - `storage_path` (path inside the Storage bucket)
    - `image_type` (`'field' | 'microscope'`)
    - `ai_crop_x1`, `ai_crop_y1`, `ai_crop_x2`, `ai_crop_y2` (normalized `0..1` AI crop rectangle)
    - `ai_crop_source_w`, `ai_crop_source_h` (source dimensions used when the crop was authored)
    - `upload_mode` (`'reduced' | 'full' | 'original'`)
    - `source_width`, `source_height`, `stored_width`, `stored_height`, `stored_bytes`
    - microscope metadata columns exist but are populated primarily by desktop sync
- `comments`
  - Community comments on observations
  - Columns: `observation_id` (bigint FK), `user_id` (uuid FK), `body` (text), `created_at`
  - Visibility enforced by RLS: same access rules as the parent observation

### Moderation / UGC Compliance
- `user_blocks`
  - Enforces one-way user blocking for feed filtering
  - Columns: `blocker_id` (uuid), `blocked_id` (uuid), `created_at`
- `reports`
  - Tracks user-reported objectionable content for admin review
  - Columns: `id`, `reporter_id` (uuid), `reported_user_id` (uuid), `observation_id` (nullable FK), `comment_id` (nullable FK), `reason` (text), `status` (enum: 'pending'/'reviewed'/'resolved'), `created_at`

### Profiles / social graph
- `profiles`
  - Auto-created by a Postgres trigger on `auth.users` insert
  - Columns: `username` (unique), `display_name`, `avatar_url`, `bio`, `is_admin` (bool), `is_banned` (bool)
  - `bio` is used by the web Profile editor and the People screen cards
  - Avatar initials derived from `username` or `email` on the client
- `friendships`
  - Bidirectional friendship rows with status gating: `pending` / `accepted` / `blocked`
  - Columns: `requester_id` (uuid), `addressee_id` (uuid), `status`
  - Used to compute friend visibility
- `observation_shares`
  - Grants access to specific users (including location access edge cases)

### Taxonomy / search
- `reference_values`
  - Readable by authenticated users (used for taxonomy/search support)
- `taxa` and `taxa_vernacular`
  - Populated with ~110k taxa + ~70k vernacular names
- `search_taxa` (RPC)
  - Deployed and used by the web app for autocomplete/search

### Community spore-data RPCs
- Public contributor / measurement aggregates should be exposed through `SECURITY DEFINER` RPCs, not by granting blanket public `SELECT` on `spore_measurements`
- Existing SQL draft:
  - `sporely-py/database/supabase_spore_community_schema.sql`
- People-directory RPC:
  - `sporely-py/database/supabase_people_directory.sql`
- Relevant functions in that SQL draft include:
  - `search_community_spore_datasets`
  - `get_community_spore_dataset`
  - `community_spore_taxon_summary`
- `search_people_directory(p_query text DEFAULT NULL, p_limit int DEFAULT 24)`
  - Used by the web People screen
  - Returns profile fields plus public `finds / species / spores` contributor counts
  - Default behavior: recently active public contributors
  - Search behavior: matches `username` / `display_name`, still returning public stats only

### Edge Functions
- `delete-account`
  - Authenticated self-service account deletion endpoint
  - Verifies the caller with the request JWT, then uses the service role to:
    - remove the user's Storage files from `observation-images` and `avatars`
    - delete friendships, comments, profile row, and owned observations/image rows
    - delete the underlying `auth.users` account
  - Required by the Profile screen's `Delete account` button

---

## Views
- `observations_friend_view`
  - Used by the web app to show observations that friends can see
  - GPS handling:
    - GPS coordinates are nulled out in the view when `location_public = false`
    - location access can be explicitly granted via `observation_shares`
  - Block filtering: Omits observations where the user is blocked by or has blocked the viewer.
  - Ban filtering: Omits observations where the author `is_banned = true`.
- `observations_community_view`
  - Exposes observations where `visibility = 'public'` to all authenticated users
  - Block filtering: Omits observations authored by users present in the viewer's `user_blocks` list.
  - Ban filtering: Omits observations where the author `is_banned = true`.

### User Finds Feed (Web App)
- When a user clicks a profile card on the People or Home tabs, the web app fetches both `observations` (to catch friend-visible posts) and `observations_community_view` (to catch all public posts) for that specific `user_id`.
- The results are merged and deduplicated on the client to ensure the viewer sees exactly what they are permitted to see.

---

## Storage inventory

### Buckets
- `observation-images`
  - Stores image binaries for observations
  - Cloud metadata for those images lives on `public.observation_images`, including the optional `ai_crop_*` fields
  - The web app uploads field capture images; desktop sync uploads microscope images when applicable
- `avatars`
  - Stores profile avatar images
  - Public bucket — avatars are readable without authentication
  - Upload path convention: `${uid}/avatar.jpg`

### Image path / folder convention
Upload paths follow:
- Observations: `${uid}/{obs_id}/{img_cloud_id}_${url_encoded_filename}`
- Avatars: `${uid}/avatar.jpg`

*Note: The filename segment of the storage path must be URL-encoded (e.g. `urllib.parse.quote`) prior to upload to prevent spaces or special characters from breaking the HTTP path parameters, which can falsely trigger 403 RLS unauthorized errors.*

Storage folder-prefix policies rely on the first folder segment matching `auth.uid()::text` via `storage.foldername(name)[1]`.

---

## Security model (RLS + Storage)

### RLS: who can read what
All tables have RLS enabled and default "owner-only" access unless overridden by explicit policies.

- `observations` — accepted friends can read; `visibility` controls observation visibility and comment access
- `observation_images` — follow the same ownership/sharing model as their parent observation
- `comments` — readable by the observation owner, plus anyone who can see the observation based on `visibility` and friendship status
- `profiles` — authenticated users must be able to read the public profile fields used by the web app (`username`, `display_name`, `avatar_url`, `bio`) for friend search, mentions, comments, and the People screen
- `reference_values` — all authenticated users
- `observation_shares` — scoped to the `shared_with_id` user
- `spore_measurements` — owner/friend access by default; public/community access should come from dedicated RPCs rather than direct table reads

**Note:** `private_comment` is never read by the web app and should remain desktop-only.

### RLS: who can write what (high level)
- Client writes are constrained to rows owned by the authenticated user (`user_id`)
- Images: allowed only when the Storage object path prefix matches the authenticated user UUID
- Banned Users: A Postgres trigger prevents `INSERT` and `UPDATE` on `observations`, `observation_images`, and `comments` if `profiles.is_banned = true`.
- Client code must never rely on setting `user_id` from the client as a trust boundary; RLS is the enforcement
- Account deletion is not performed directly from the client; it goes through the `delete-account`
  Edge Function because deleting `auth.users` requires elevated privileges

### Storage policy behavior (high level)
For `observation-images`:
- Upload/Delete: allowed only if the object's folder prefix matches `auth.uid()::text`
- Read: allowed when the requesting user has friend access to the underlying observation(s)

For `avatars`:
- Single `FOR ALL` policy (`avatars_owner`): all operations (SELECT, INSERT, UPDATE, DELETE) allowed only if the first path segment matches `auth.uid()::text`
- Read: public (no auth required — bucket is public)
- Note: separate INSERT + UPDATE policies are insufficient for upsert because Supabase internally does a SELECT to check existence; the unified `FOR ALL` policy is required

---

## Sync-related invariants (important)

### Desktop ↔ Mobile dedup
- `desktop_id` is the desktop SQLite row identifier
- Mobile creates cloud rows with `desktop_id = NULL` initially
- Desktop sync assigns `desktop_id` on pull so future syncs deduplicate properly
- Pulled cloud observations are imported directly into the local desktop database, including local image rows and thumbnails
- The system expects a uniqueness strategy around `(desktop_id, user_id)` to keep upserts reliable and fast

### Conflict rule
- Desktop sync stores a last-seen cloud snapshot for linked observations
- If the same linked observation changed on both desktop and web, automatic overwrite is skipped and the conflict is reported instead
- Desktop pull/import is seamless: there is no separate cloud inbox view in the desktop table

### What the mobile app uploads
- Field photos: inserted as `observations` + `observation_images`, uploaded to Storage under the user UUID folder convention
- AI crop metadata is stored on each `observation_images` row, not as a separate cropped asset
- Microscope photos: typically skipped by default in mobile capture; populated primarily by desktop sync

---

## Operational checklist (recommended)

1. **Run unique constraints SQL**
   - File: `sporely/database/supabase_unique_constraints.sql`
   - Purpose: add/ensure `UNIQUE (desktop_id, user_id)` (or equivalent)
   - Status: ✅ Applied
2. **Verify Storage bucket existence**
   - `observation-images` ✅ exists
   - `avatars` ✅ exists (public bucket, created 2026-04)
3. **Verify Storage policies**
   - `observation-images`: folder-prefix INSERT/DELETE + friend-access SELECT
   - `avatars`: single `avatars_owner` FOR ALL policy, folder-prefix = `auth.uid()::text` ✅
4. **Verify RLS enabled**
   - Ensure tables/views referenced by the web app still have RLS enabled
5. **Verify RPC availability**
  - Ensure `search_taxa` remains deployed and callable by the web app
  - Ensure `search_people_directory` is deployed if the web app exposes the People screen
6. **Verify Edge Function availability**
   - Ensure `delete-account` is deployed if the web app exposes the Profile → Delete account action
7. **Regression tests for sharing / visibility**
   - Owner can see own observations and images
   - Accepted friends can see what's intended
   - `location_public = false` friends see null GPS unless sharing explicitly grants access
   - `visibility = 'private'` observations do not appear in friend or community views
   - `visibility = 'public'` observations appear in `observations_community_view`

8. **Verify UGC Moderation**
   - `user_blocks` and `reports` tables exist and have RLS policies.
   - `observations_community_view` and `observations_friend_view` successfully filter out blocked content.
   - `profiles` correctly tracks `is_admin` and `is_banned`.

---

## Where the "real SQL" lives (for maintainers)
Do not copy policy SQL into this doc.
Instead, policy/DDL changes live in:
- `sporely/database/` (schema migrations / DDL artifacts)
- any standalone SQL files referenced in `sporely/database/` for constraints/RPCs

If you need exact definitions:
- update the appropriate SQL files under `sporely/database/`
- then (optionally) update this doc's descriptions/invariants accordingly
