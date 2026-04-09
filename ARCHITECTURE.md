# Sporely Web — Architecture

## What this is

> For Supabase schema, RLS rules, and Storage conventions see [SUPABASE_DB.md](SUPABASE_DB.md).

A mobile-first PWA companion to the MycoLog desktop app (PySide6 / SQLite).
Field capture (GPS + photos) and cloud sync via Supabase. Not a replacement
for the desktop — the desktop owns taxonomy, microscopy, and publishing to
Artsobservasjoner / Artportalen.

The same codebase also ships as a Capacitor Android app. The Android wrapper is
primarily there for more reliable file import, especially native HEIC/EXIF/GPS
handling from the device photo library.

---

## Stack

| Layer | Choice |
|---|---|
| Build | Vite 6, vanilla JS (ES modules) — no framework |
| Native wrapper | Capacitor Android + `@capawesome/capacitor-file-picker` |
| Styling | Plain CSS custom properties, no preprocessor |
| Auth & DB | Supabase JS v2 (`@supabase/supabase-js`) |
| Storage | Supabase Storage buckets `observation-images` + `avatars` |

---

## File structure

```
sporely-web/
├── index.html              Full app shell + auth overlay HTML (no JS inline)
├── package.json
├── supabase/
│   ├── config.toml         Supabase local/deploy config for Edge Functions
│   └── functions/
│       └── delete-account/
│           └── index.ts    Self-service account deletion (service-role Edge Function)
├── vite.config.js
└── src/
    ├── main.js             Entry point — hash parsing, session check, boot
    ├── supabase.js         createClient (URL + publishable key)
    ├── state.js            Single shared mutable object (no reactivity layer)
    ├── router.js           navigate(screen) — swaps .active class, starts/stops camera
    ├── toast.js            showToast(msg) — timed overlay message
    ├── geo.js              GPS watchPosition, writes into state.gps
    ├── style.css           All CSS (custom properties, no utility classes)
    └── screens/
        ├── auth.js         Login, signup, resend confirmation, hash error handling
        ├── home.js         Dashboard, recent finds from Supabase, sign-out
        ├── finds.js        Full observation list from Supabase
        ├── capture.js      Camera (getUserMedia), shutter, batch capture
        ├── review.js       Review one captured observation batch, save to Supabase
        ├── import_review.js Import/group photos, native EXIF/GPS handling, save flow
        └── profile.js      Profile editing, avatar crop/upload, friends, delete-account action
    ├── images.js          Upload originals + thumbnail variants, signed-URL cache
    └── import-store.js    IndexedDB persistence for pending import sessions
```

---

## Auth flow

```
page load
  └─ handleUrlHashError()     read #error=... hash from Supabase redirects
       └─ clears hash, shows friendly message + resend link if otp_expired
  └─ supabase.auth.getSession()
       ├─ session exists  → bootApp(user)     show app shell
       └─ no session      → showAuthOverlay() show login/signup forms
                               └─ login/signup success → bootApp(user)

onAuthStateChange listener handles:
  SIGNED_IN  → bootApp if not already booted (tab resume, magic link)
  SIGNED_OUT → wipe state.user, show auth overlay
```

### Signup edge cases

| Supabase response | Cause | Handled as |
|---|---|---|
| No error, no session | Email confirmation required | "Check inbox" + resend link (green) |
| No error, no session, `data.user` is null | Address already registered (unconfirmed) | Same — resend link |
| Error: "already registered" | Address confirmed, just needs login | Switch to login form with message |
| Login error: "not confirmed" | Signed up but never clicked link | "Check inbox" + resend link |
| `#error_code=otp_expired` in URL hash | Confirmation link expired | Friendly message, signup form shown |

Resend uses `supabase.auth.resend({ type: 'signup', email })`.

---

## Supabase connection

**Project URL:** `https://zkpjklzfwzefhjluvhfw.supabase.co`
**Key type:** Publishable (anon) key — safe to expose in client code; RLS enforces access.

All requests go through the `supabase` client instance in `src/supabase.js`.
Raw `fetch` is no longer used anywhere — everything goes through the SDK.

---

## Database schema (Supabase side)

Full SQL is in `MycoLog/database/` (the desktop app repo).
Key tables used by the web app:

### `observations`
Maps 1-to-1 with the desktop SQLite `observations` table.
Extra cloud-only columns:
- `user_id uuid` — FK to `auth.users` (set by RLS, never trusted from client)
- `desktop_id int` — local SQLite `id`, used for dedup on sync
- `location_public bool` — hide GPS from friends if false
- `visibility text` — cloud sharing scope (`private` / `friends` / `public`)

Columns written on mobile capture (currently):
`user_id, date, gps_latitude, gps_longitude, source_type`

### `observation_images`
- `storage_path text` — path inside the `observation-images` Storage bucket
- `image_type` — `'field'` | `'microscope'`
- Full microscope metadata columns present but only populated by desktop sync

### `profiles`
Auto-created by a Postgres trigger on `auth.users` insert.
Profile UI reads `username`, `display_name`, and `avatar_url`.
Avatar initials are derived on the client, and avatar rendering prefers the stored URL
with a signed-URL fallback if the direct image fetch fails.
The profile screen also exposes a self-service account deletion action, which calls the
`delete-account` Supabase Edge Function.

### `friendships`
Bidirectional, status-gated (`pending` / `accepted` / `blocked`).
Used by `observations_friend_view` to filter what friends can see.

---

## Row Level Security (RLS)

All tables have RLS enabled. Default policy: **owner only**.

| Table | Who else can read |
|---|---|
| `observations` | Accepted friends (via `friendships` join) |
| `observation_images` | Accepted friends (via observation ownership) |
| `profiles` | Accepted friends |
| `reference_values` | All authenticated users |
| `observation_shares` | The specific `shared_with_id` user |

`private_comment` is never read by the web app.
GPS coordinates are nulled out in `observations_friend_view` when `location_public = false`,
unless an `observation_shares` row explicitly grants location access.

Storage bucket `observation-images` uses folder-prefix policies:
- Upload/delete: `auth.uid()::text = (storage.foldername(name))[1]`
- Read: same, plus friend-access join

Storage bucket `avatars` stores `${user_id}/avatar.jpg` for profile photos.
The bucket is public, but the client can fall back to a signed URL when the direct
avatar URL is unavailable or stale.

---

## Capture → save flow

```
capture.js: capturePhoto()
  ├─ demo mode (no camera)  → push { blob: null, emoji, gps, ts }
  └─ real camera            → canvas.toBlob wrapped in Promise → push { blobPromise, gps, ts }

review.js: saveObservationBatch()
  1. await Promise.all(capturedPhotos.map(p => p.blobPromise ?? p.blob))
  2. Enqueue parent observation and image Blobs to IndexedDB (`sync-queue.js`)
  3. Clear capture state, refresh lists, navigate away from review

sync-queue.js: triggerSync() (background)
  1. Read pending observations from IndexedDB
  2. INSERT observations row for the batch
  3. For each photo: upload original to storage, generate variants, INSERT observation_images row
  4. Remove from IndexedDB offline queue
```

## Import flow

```
import_review.js: openPhotoImportPicker()
  ├─ Capacitor Android → NativePhotoPicker plugin returns original URI + native EXIF/GPS
  └─ Browser / fallback → file input or showOpenFilePicker()

handleSelectedFiles()
  1. Read capture time + GPS from native metadata or exifr
  2. Sort files by capture time
  3. Group files taken within the configured time gap into one observation
  4. Convert review copies to JPEG sequentially to avoid mobile memory spikes
  5. Save pending import sessions to IndexedDB so review survives app suspension

Single group:
  save immediately → open observation detail editor

Multiple groups:
  show grouped import cards → user edits species/location/sharing → save all
```

---

## Desktop ↔ Cloud sync (desktop-side, MycoLog)

Implemented in `MycoLog/utils/cloud_sync.py` using the Supabase REST API directly (`requests`).

**Push (desktop → cloud):**
- Queries SQLite for `cloud_id IS NULL OR sync_status = 'dirty'`
- Upserts to Supabase (check-then-patch-or-post pattern)
- Writes `cloud_id` + `sync_status = 'synced'` back to SQLite
- Syncs the selected desktop images plus optional generated media (measure plot, thumbnail gallery, plate)
- Uses a lightweight local media signature so unchanged images/media can be skipped on later syncs
- Upload size is controlled by the desktop **Sync image size** setting (`Reduced (2 MP)` or `Full size`)

**Pull (cloud → desktop):**
- Fetches `observations WHERE desktop_id IS NULL` (created on mobile)
- Creates local SQLite rows via `ObservationDB.create_observation()`
- Writes `desktop_id` back to Supabase for future dedup
- Watermarked by `cloud_last_pull_at` in `app_settings.json`
- Pulls cloud-managed images into the local desktop observation and refreshes the local media baseline

**Conflict rule:** if the same linked observation changed on both desktop and web since the last synced snapshot, the desktop now skips the automatic overwrite and reports a conflict instead.
`private_comment` never leaves the desktop.

Triggered via Settings → Sporely Cloud Sync… in the desktop app.

---

## What's real vs stubbed

| Feature | Status |
|---|---|
| Email/password auth | ✅ Real |
| Confirmation email resend | ✅ Real |
| GPS capture | ✅ Real |
| Camera capture (mobile) | ✅ Real |
| Native Android gallery import with HEIC GPS | ✅ Real — custom Capacitor plugin + Filesystem read |
| Observation insert to Supabase | ✅ Real |
| Image upload to Supabase Storage | ✅ Real |
| Grid/card thumbnails | ✅ Real — `small` + `medium` variants generated at upload time |
| Profile avatar upload/crop | ✅ Real |
| Self-service account deletion | ✅ Real — via Supabase Edge Function `delete-account` |
| Finds list from Supabase | ✅ Real |
| Recent finds on home screen | ✅ Real |
| Desktop ↔ cloud sync | ✅ Real (desktop side) |
| Artsorakel (Artsdata AI species ID) | ✅ Real — direct browser→AI call, CORS open |
| Taxa autocomplete search | ✅ Real — 110k taxa in Supabase, RPC search_taxa |
| Camera permission denied overlay | ✅ Real — platform-specific instructions |
| Friends finds + thumbnails | ✅ Real — `observations_friend_view` + authenticated Storage SELECT |
| Community finds | ✅ Real — `observations_community_view` (visibility = public) |
| Map view | ✅ Real — Leaflet + OpenStreetMap |
| Friends feed | 🟡 Stubbed — toast only |
| Import review recovery after app suspension | ✅ Real — IndexedDB `pending_import` store |
| Capture draft save/resume | ❌ Removed — capture review is now direct cancel/save |
| Push notifications | ❌ Not started |
| Offline queue | ❌ Not started |

---

## Infrastructure status

| Item | Status |
|---|---|
| Supabase project | ✅ Live (`zkpjklzfwzefhjluvhfw`) |
| Email via Resend SMTP | ✅ Configured (`noreply@sporely.no`, domain verified) |
| `observation-images` Storage bucket | ✅ Created — SELECT: any authenticated user; INSERT/DELETE: owner only |
| `avatars` Storage bucket | ✅ Created, public read + owner-scoped writes |
| `taxa` + `taxa_vernacular` tables | ✅ Populated (110k taxa, 70k vernacular names) |
| `search_taxa` RPC | ✅ Deployed |
| `delete-account` Edge Function | ⚠️ In repo — must be deployed in Supabase before the UI button works |
| Unique constraints on observations | ⚠️ Not yet run — see `supabase_unique_constraints.sql` |

## Next steps

1. **Run unique constraints SQL** in `MycoLog/database/supabase_unique_constraints.sql`
   to add `UNIQUE (desktop_id, user_id)` — needed for desktop sync upsert performance.

2. **Offline queue** — wrap capture/import save failures in IndexedDB so photos aren't
   lost when the user is in the field without signal.

3. **Capture session recovery** — decide whether camera batches should get the same
   resumable persistence that import sessions already have.

4. **Bundle trimming** — lazy-load heavier import/map dependencies so the initial JS chunk stays small on mobile.

5. **Friends feed** — query `observations_friend_view`, paginate, render like Finds list.

6. **Server-side thumbnails** — consider replacing client-generated thumbnail uploads
   with Supabase Storage transformations if/when plan and caching tradeoffs make sense.
