# Sporely Web — Architecture

## What this is

> For Supabase schema, RLS rules, and Storage conventions see [SUPABASE_DB.md](SUPABASE_DB.md).

A mobile-first PWA companion to the Sporely desktop app (PySide6 / SQLite).
Field capture (GPS + photos) and cloud sync via Supabase + Cloudflare. Not a replacement
for the desktop — the desktop owns taxonomy, microscopy, and publishing to
Artsobservasjoner, Artportalen, iNaturalist, and Mushroom Observer.

The same codebase also ships as a Capacitor Android app. The Android wrapper is
primarily there for more reliable file import, especially native HEIC/EXIF/GPS
handling from the device photo library.

---

## Stack

| Layer | Choice |
|---|---|
| Build | Vite 6, vanilla JS (ES modules) — no framework |
| Native wrapper | Capacitor Android + `@capawesome/capacitor-file-picker` + `@capawesome/capacitor-background-task` + custom `NativePhotoPicker` plugin |
| Styling | Plain CSS custom properties, no preprocessor |
| Auth & DB | Supabase JS v2 (`@supabase/supabase-js`) |
| Media storage | Cloudflare R2 bucket `sporely-media` |
| Media upload | Cloudflare Worker at `upload.sporely.no` (JWT-authenticated PUT/DELETE) |
| Media serving | Public CDN at `https://media.sporely.no` |
| Account/storage foundation | Supabase profile plan flags + worker-enforced storage tally/quota |

Supabase Storage (`observation-images` bucket) is no longer used for new uploads.
All media now goes through the Cloudflare R2 pipeline.

---

## Testing & Auditing

| Layer | Choice |
|---|---|
| Static Analysis | ESLint (planned) for automating the 10-point code review checklist |
| Unit Testing | Vitest (planned) for testing core logic like sync queues, AI crop math, and deduplication |
| Database | Supabase local testing utilities / pgTAP (planned) for automated RLS policy auditing |
---

## File structure

```
sporely-web/
├── index.html              Full app shell + auth overlay HTML (no JS inline)
├── package.json
├── cloudflare/
│   └── r2-upload-worker/   Cloudflare Worker for authenticated R2 uploads
│       ├── src/index.js    Worker source — JWT verify, R2 put, CORS
│       └── wrangler.toml   Worker config — routes, vars, R2 binding
├── supabase/
│   ├── config.toml         Supabase local/deploy config for Edge Functions
│   ├── profile-storage-usage.sql Supabase profile storage/quota tally helper
│   └── functions/
│       └── delete-account/
│           └── index.ts    Self-service account deletion (service-role Edge Function)
├── vite.config.js
└── src/
    ├── main.js             Entry point — hash parsing, session check, boot
    ├── supabase.js         createClient (URL + publishable key)
    ├── state.js            Single shared mutable object (no reactivity layer)
    ├── router.js           navigate(screen) — swaps .active class, starts/stops camera
    ├── map-loader.js       Lazy loads the map screen so Leaflet stays off the startup path
    ├── toast.js            showToast(msg) — timed overlay message
    ├── geo.js              GPS watchPosition, writes into state.gps
    ├── cloud-plan.js       Cloud plan lookup + effective upload policy helpers
    ├── settings.js         Local Settings preferences: camera, image resolution, sync history
    ├── images.js           Worker-backed image preparation, uploads + thumbnail variants, media URL helpers
    ├── image-worker.js     Off-main-thread resize/encode worker using OffscreenCanvas
    ├── image_crop.js       Shared AI crop math + cropped blob export helpers
    ├── ai-crop-editor.js   Full-screen AI crop editor used by review/import flows
    ├── sync-queue.js       IndexedDB offline queue for captured observations + background-task sync drain
    ├── import-store.js     IndexedDB persistence for pending import sessions
    ├── style.css           All CSS (custom properties, no utility classes)
    └── screens/
        ├── auth.js         Login, signup, resend confirmation, hash error handling
        ├── home.js         Dashboard, recent finds from Supabase, sign-out
        ├── finds.js        Observation lists (Mine, Friends, Community, User) + Spores filter
        ├── capture.js      Camera (getUserMedia), shutter, batch capture
        ├── review.js       Review one captured observation batch, save to Supabase
        ├── import_review.js Import/group photos, native EXIF/GPS handling, save flow
        └── profile.js      Profile editing, avatar crop/upload, friends, delete-account action
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
**JWT algorithm:** ES256 (ECC P-256) — Supabase switched from HS256 to ES256.

All database requests go through the `supabase` client instance in `src/supabase.js`.
Raw `fetch` is no longer used for Supabase — everything goes through the SDK.

---

## Media pipeline (Cloudflare R2)

All media is stored in Cloudflare R2, not Supabase Storage.

### Upload worker (`upload.sporely.no`)

- **Route:** `PUT /upload/{user_id}/{obs_id}/{filename}`
- **Delete route:** `DELETE /upload/{user_id}/{obs_id}/{filename}`
- **Auth:** Supabase JWT sent as `Authorization: Bearer {token}`
- **JWT verification:** Worker fetches the JWKS from Supabase (`/auth/v1/.well-known/jwks.json`) and verifies the ES256 signature using Web Crypto. The JWKS is cached in-memory for 10 minutes.
- **Key rule:** Upload path must start with the JWT `sub` (user ID) — enforced by the worker.
- **Current client policy:** Free accounts upload reduced 2 MP images. Pro/full-res accounts can choose `Reduced (2MP)` or `Max (12MP)` in Settings. Max keeps near-12 MP originals when friendly to quality and only resizes images from 14 MP and up down to 12 MP.
- **HEIC Fallback (Web):** If the browser cannot natively decode an image into a Canvas (e.g., HEIC files in Chrome/Firefox without native conversion), the resize step gracefully fails and the app uploads the original, unmodified file with `upload_mode: 'original'`.
- **Storage tally/quota:** After successful R2 writes/deletes, the worker updates `profiles.total_storage_bytes`, compatibility `profiles.storage_used_bytes`, and original-image `profiles.image_count` through the Supabase RPC in `supabase/profile-storage-usage.sql`. Free-tier storage can be limited per profile via `storage_quota_bytes` or globally via worker `FREE_STORAGE_QUOTA_BYTES`.
- **Worker secret:** The worker needs Cloudflare secret `SUPABASE_SERVICE_ROLE_KEY` so backend-only profile tally updates can bypass RLS. This secret must never be committed or exposed to the frontend.
- **Source:** `cloudflare/r2-upload-worker/src/index.js`
- **Config:** `cloudflare/r2-upload-worker/wrangler.toml`

### CORS

Allowed origins are configured in `wrangler.toml` (`ALLOWED_ORIGINS`). The worker also
accepts any private network origin automatically (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`)
so LAN dev testing from a phone works without hardcoding IPs.

### Media serving (`media.sporely.no`)

R2 bucket `sporely-media` is exposed publicly via Cloudflare. All media URLs are
**relative keys** stored in the database — never full URLs. The key is prefixed with
`{user_id}/{obs_id}/` for path-based ownership.

### Client image preparation

`src/images.js` prepares web/mobile uploads before they are sent to R2.

- Image work is attempted off the main thread in `src/image-worker.js`.
- The worker receives an `ImageBitmap` as a transferable and uses `OffscreenCanvas`.
- Encoding tries WebP first (`image/webp`, quality 0.65) and falls back to JPEG (`image/jpeg`, quality 0.75). AVIF is not used because mobile browser AVIF encoding support is unreliable.
- Free/reduced mode limits images to about 2 MP with a 1600px max edge.
- Pro/max mode keeps near-12 MP images unless the source is above the large-image guard, then downsizes to about 4000px max edge.
- Downscaling uses progressive halving plus high-quality canvas smoothing to avoid aliasing-heavy thumbnails.

### Thumbnail variants

`src/images.js` generates and reads one thumbnail variant:
- `thumb_{filename}` — 400px max edge, WebP 70% or JPEG 65% fallback

### Offline queue and background sync

`src/sync-queue.js` is the durable upload boundary for new observations.

- Queue rows are written to IndexedDB before image processing begins.
- Image bytes are stored as `ArrayBuffer` values, not Blob URLs, so the queue survives browser memory pressure and process kills.
- After image preparation succeeds, prepared upload bytes and thumbnail bytes are written back into the same queue row so sync can resume without re-encoding.
- The queue records `remoteObservationId`, `completedImageIndexes`, `syncStage`, `syncImageIndex`, and `syncImageCount`.
- On resume, sync reconciles against Supabase `observation_images` by `sort_order`, so already-uploaded images are skipped.
- If the process dies after inserting the parent observation but before `remoteObservationId` is saved locally, the queue attempts to recover the cloud row by matching `user_id` and `captured_at`.

When the Capacitor app is backgrounded, `document.visibilitychange` requests a short-lived background task through `@capawesome/capacitor-background-task`. The task drains any active queue preparation/upload promise and then calls `triggerSync()`. This extends the chance that current work finishes when the app is minimized or the screen turns off, but it is still subject to Android/iOS background execution limits.


### Deploying the worker

**⚠️ Deploy after every worker change.** The worker is NOT automatically deployed when you
commit. If you add a new route or fix a bug in `src/index.js` and forget to run
`wrangler deploy`, the old version keeps running in production and the new code has no
effect. Symptom: routes that exist in source return 404 in production.

### Artsorakel proxy (`POST /artsorakel`)

The worker proxies AI species identification requests to `https://ai.artsdatabanken.no`.

- **Body forwarding:** Use `await request.arrayBuffer()` — do **not** pass `request.body`
  (the ReadableStream) directly to the upstream `fetch`. Streaming a multipart body through
  two fetch hops can produce a malformed request that the upstream silently accepts but
  returns only the "please update" stub prediction. Buffering the body first guarantees the
  full multipart payload is forwarded intact.
- **Response:** Buffer the upstream response with `await upstream.arrayBuffer()` before
  returning it. This avoids partial-body issues on slow upstream connections.


### ⚠️ Upload Request Gotchas

- **iOS Safari Fetch Hangs:** Never stream an IndexedDB-backed `Blob` directly into a `fetch()` body on iOS/WebKit. The web app must always convert it to an `ArrayBuffer` first (`await blob.arrayBuffer()`) before passing it to `fetch`, otherwise the upload may silently hang or send 0 bytes.
- **CORS Preflight on PUT:** Avoid adding custom non-standard headers (like `X-Sporely-Upload-Mode`) to the R2 upload `PUT` request. Custom headers force strict CORS preflight (`OPTIONS`) behavior on mobile PWAs, which can unexpectedly block uploads depending on network/cache conditions.

---

## Database schema (Supabase side)

Full SQL is in `sporely/database/` (the desktop app repo).
Key tables used by the web app:

### `observations`
Maps 1-to-1 with the desktop SQLite `observations` table.
Extra cloud-only columns:
- `user_id uuid` — FK to `auth.users` (set by RLS, never trusted from client)
- `desktop_id int` — local SQLite `id`, used for dedup on sync
- `is_draft bool` — WIP state; public draft observations appear in the live science feed/map but are not treated as featured/verified.
- `visibility text` — cloud sharing scope (`private` / `friends` / `public`). New web/mobile observations default to `public`.
- `location_precision text` — `exact` or `fuzzed`; community/follow views expose exact GPS unless the user explicitly chose `fuzzed`.
- `location_public bool` — legacy compatibility flag; new privacy behavior is driven by `visibility` and `location_precision`.
- `image_key text` — relative R2 key of the cover image
- `thumb_key text` — relative R2 key of the cover thumbnail

Privacy slots are enforced by Supabase: a free account uses one slot when `visibility != 'public' OR location_precision = 'fuzzed'`. The current free limit is 20; pro accounts are unlimited.

### `follows`
Stores the web social trail subscriptions used by the `Feed 🧭` tab:
- `user_id uuid`
- `target_type text` — `user`, `observation`, `species`, or `genus`
- `target_id text`

Desktop does not expose social follow controls; this is a web/mobile feature.

### `observation_images`
- `storage_path text` — relative R2 media key (e.g. `{user_id}/{obs_id}/0_ts.jpg`)
- `image_type` — `'field'` | `'microscope'`
- `image_key text` — same as `storage_path` (normalized)
- `thumb_key text` — relative key of the primary thumbnail variant
- `ai_crop_x1`, `ai_crop_y1`, `ai_crop_x2`, `ai_crop_y2` — normalized AI crop rectangle (`0..1`)
- `ai_crop_source_w`, `ai_crop_source_h` — source dimensions when the AI crop was set
- `upload_mode` — `reduced` or `full`
- `source_width`, `source_height` — original dimensions seen by the uploading client
- `stored_width`, `stored_height` — dimensions actually stored in cloud
- `stored_bytes` — size of the stored original blob in bytes

AI crop metadata is stored per image and only affects Artsorakel requests. Gallery rendering still uses the full stored image.
- Full microscope metadata columns present but only populated by desktop sync

### Moderation / UGC Compliance
- `user_blocks` — Enforces one-way user blocking for feed filtering (`blocker_id`, `blocked_id`).
- `reports` — Tracks user-reported objectionable content (`observation_id`, `comment_id`, `reason`).
- These tables, alongside `profiles.is_banned`, are required for Google Play Store User Generated Content (UGC) compliance. RLS and Views (e.g. `observations_community_view`) automatically filter out blocked or banned content.

### `profiles`
Auto-created by a Postgres trigger on `auth.users` insert.
Profile UI reads and writes `username`, `display_name`, `bio`, and `avatar_url`. The desktop **Profile & Cloud** page mirrors these same fields so the account identity is shared across web/mobile and desktop.
The subscription/storage foundation also now lives here:
- `cloud_plan` — `free` or `pro`; controls account status and full-res entitlement.
- `full_res_storage_enabled` — compatibility flag for manually granting full-res access.
- `storage_quota_bytes` — optional per-user storage cap; free plans can be limited here.
- `total_storage_bytes` / `storage_used_bytes` — worker-maintained byte tally. `storage_used_bytes` remains for compatibility.
- `image_count` — worker-maintained count of original uploaded images; thumbnail variants are not counted as images.
- `billing_status`, `billing_provider` — reserved for later billing sync

Avatar initials are derived on the client, and avatar rendering prefers the stored URL
with a signed-URL fallback if the direct image fetch fails.
The profile screen also exposes a self-service account deletion action, which calls the
`delete-account` Supabase Edge Function.
It now also shows an Account status block with image resolution, sync history, storage usage, and image count.

Desktop local databases bind to a single Supabase auth user via `linked_cloud_user_id`. If a user wants to move a desktop database to another Sporely Cloud account, they must explicitly reset/migrate the desktop cloud link; simply logging in with another account is blocked before credentials are saved. Deleting the web account does not by itself migrate a desktop database, and the migration flow must avoid both duplicate cloud rows and accidental loss of useful spore data.

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
Community and follow views expose exact coordinates by default for public observations.
Coordinates are rounded only when `location_precision = 'fuzzed'`; `location_public`
is retained as a legacy compatibility flag.

Note: Supabase Storage bucket `observation-images` still exists but is no longer used
for new uploads. Media access control is now handled by the R2 upload worker (JWT path
enforcement) and Cloudflare's public CDN for serving.

---

## Camera Behaviors (Native vs Web)

**Sporely Cam (Native Android / CameraX)**
- Activated when running inside the Capacitor Android app.
- Hooks directly into native CameraX APIs for full 12 MP captures, auto-selecting the 1x lens.
- Supports a dual-pipeline High Dynamic Range (HDR) capability. For Android 14+ devices (e.g. Samsung S25), it uses native Ultra HDR (`JPEG_R` output) capabilities. For older devices, it queries the CameraX `ExtensionsManager` for OEM vendor HDR extensions. When HDR is active, physical lens locks are cleared to allow the device's ISP to compute the HDR gain map across its logical lens array.
- Natively preserves full EXIF orientation and accurate GPS metadata securely without Canvas stripping.

**Web Cam (HTML5 `getUserMedia` / PWA)**
- Activated in mobile browsers (Safari/Chrome) or PWAs.
- Captures by painting a `<video>` stream to an HTML `<canvas>`, inherently limiting resolution to the browser's WebRTC stream (often ~2 MP).
- Mobile browsers aggressively strip EXIF/GPS from web captures for privacy. The app compensates by reading device geolocation via JS `navigator.geolocation` during capture.
- Android web users see warnings advising them to install the native app for better quality and metadata handling.

## Capture → save flow

```
capture.js: capturePhoto()
  ├─ demo mode (no camera)  → push { blob: null, emoji, gps, ts }
  └─ real camera            → canvas.toBlob wrapped in Promise → push { blobPromise, gps, ts, aiCropRect, aiCropSourceW/H }

review.js: saveObservationBatch()
  1. await Promise.all(capturedPhotos.map(p => p.blobPromise ?? p.blob))
  2. Enqueue parent observation and per-image crop metadata to IndexedDB (sync-queue.js)
  3. Clear capture state, refresh lists, navigate away from review

sync-queue.js: triggerSync() (background)
  1. Read pending observations from IndexedDB
  2. INSERT observations row via Supabase
  3. Load effective cloud upload policy from the signed-in user's profile
  4. For each photo: prepare reduced/full upload blob, PUT to upload.sporely.no (R2 worker), generate variants, INSERT observation_images row with upload metadata
  5. Remove from IndexedDB offline queue
```

## Import flow

```
import_review.js: openPhotoImportPicker()
  ├─ Capacitor Android → NativePhotoPicker plugin returns native EXIF/GPS and JPEG cache files for HEIC/HEIF
  ├─ Capacitor iOS → Capawesome FilePicker path
  └─ Browser / fallback → file input or showOpenFilePicker()

handleSelectedFiles()
  1. Read capture time + GPS from native metadata or exifr
  2. Sort files by capture time
  3. Group files taken within the configured time gap into one observation
  4. Keep browser-decodable originals for preview/upload and create only reduced JPEG AI copies up front
  5. Pre-seed per-image AI crop metadata and save pending import sessions to IndexedDB so review survives app suspension

Single group:
  save immediately → open observation detail editor

Multiple groups:
  show grouped import cards → user edits species/location/sharing/AI crop → save all
```

Android APK note: HEIC/HEIF import must go through the custom `NativePhotoPicker`
bridge, not directly through Capawesome `FilePicker.pickImages()`. The custom
plugin decodes HEIC/HEIF with Android bitmap APIs, writes a temporary JPEG in app
cache, and returns native EXIF/GPS metadata separately. The native bridge uses
`ACTION_OPEN_DOCUMENT`, not Android 13+ `MediaStore.ACTION_PICK_IMAGES`, because
Photo Picker URIs can expose redacted GPS metadata such as `0,0`. Before opening the
custom picker, JS still asks Capawesome FilePicker for `accessMediaLocation`,
because Android can redact photo GPS unless that runtime permission is granted
and the native plugin opens `MediaStore.setRequireOriginal(uri)`. Sending an
HEIC blob directly into the WebView can produce a blank review image because
Android WebView cannot reliably decode HEIC object URLs. When native EXIF is
returned, the JS import flow trusts it and skips the slower `exifr` fallback;
otherwise single HEIC imports can spend several seconds re-reading metadata
after native conversion. Android native JPEG imports also skip eager JS image
decoding during the "Converting" phase; preview uses the native/cache JPEG blob
directly, and AI crop metadata can remain unset until the user explicitly opens
crop/AI tools.

**Android PWA (Web) note:** Android Chrome strips EXIF metadata (including GPS) for privacy when a web app uses a standard `<input type="file" accept="image/*">` quick picker. To preserve GPS on imported JPEGs, the web app routes Android browser users to a specific file picker (`import-browse-input` with explicit file extensions) that bypasses the privacy scrub and preserves the original bytes and metadata.

Confirmed on Samsung S25 / Android APK: `ACTION_OPEN_DOCUMENT` preserves GPS for
the test HEIC (`20260419_092927.heic`: about `63.45209, 10.43705`, altitude
`90 m`). The UX tradeoff is that Android shows the document picker, often opening
on "Recent" photos; users may need to open the side menu and choose "Images" to
browse the full photo library. If this becomes too confusing, the product should
offer two Android import choices: a friendly/fast gallery picker that may lose
EXIF GPS, and a metadata-safe picker for geotagged imports.

Import location metadata is intentionally stored separately from the image blob:
`gpsLat`, `gpsLon`, `gpsAltitude`, and per-photo `photoGps` values travel with
the pending import session and review context. This is important because Canvas
conversion/resizing strips EXIF, and because Android HEIC conversion writes a new
temporary JPEG. The review screen should show both the reverse-geocoded Location
name and a separate Lat/Lon row with the actual coordinates so stale place-name
lookups are easy to spot. Treat `0,0` as missing GPS, never as a real location.
If a JPEG truly has no GPS EXIF tags (example: `20260418_154138.jpg`, which has
Samsung/time metadata but no parsable GPSLatitude/GPSLongitude), the app should
show no coordinates instead of falling back to stale or current-device GPS.

Identification confidence follows the desktop app: the cloud/local observation
field is `uncertain`, not a separate `needs_id` field. The web UI labels this as
"Uncertain ID", prefixes displayed names with `?` when set, and offers a Finds
filter for uncertain observations.

Known Android HEIC tradeoff: the fastest single-HEIC path can show the edit
screen quickly even when metadata is not already available from the native picker
result. The import flow splits visual import from metadata hydration:

1. Convert/decode enough to show the image and open the edit screen immediately.
2. Continue EXIF/GPS extraction in the background.
3. When GPS arrives, update the active review/session location fields and persist
   the pending import session.
4. If the user saves before hydration finishes, the save path waits for pending
   metadata before enqueueing the observation so EXIF GPS is not dropped.

Multi-file HEIC import has previously appeared fast while still preserving GPS,
so do not assume speed and GPS are mutually exclusive. Before changing this path,
add timing logs around native decode, native EXIF, JS `exifr`, and review render
so regressions are easy to locate.

---

## Desktop ↔ Cloud sync (desktop-side, Sporely)

Implemented in `sporely/utils/cloud_sync.py` using the Supabase REST API directly (`requests`).
Media uploads use `sporely/utils/r2_storage.py` — a minimal S3-compatible client using
SigV4 signing directly against the R2 S3 endpoint (bypasses the upload worker, uses
service-level R2 API credentials from `python.env`).

**Push (desktop → cloud):**
- Queries SQLite for `cloud_id IS NULL OR sync_status = 'dirty'`
- Upserts to Supabase (check-then-patch-or-post pattern)
- Writes `cloud_id` + `sync_status = 'synced'` back to SQLite
- Syncs selected clean desktop observation images plus one clean thumbnail per image. Online-publishing overlays, watermarks, measure plots, thumbnail galleries, and plates stay out of Sporely Cloud media.
- Pushes `observation_images.ai_crop_*` alongside the rest of each synced image row so web and desktop share the same AI crop geometry
- Uses a lightweight local media signature so unchanged images/media can be skipped on later syncs
- Media-signature comparison now ignores low-signal local-only churn such as file mtime drift, gallery layout state, order-only image changes, and older signature payloads that predate the shared AI crop fields
- Upload size is controlled by the desktop **Sync image size** setting (`Reduced (2 MP)` or `Full size`)
- Desktop now pushes the same upload metadata as web (`upload_mode`, source/stored dimensions, stored bytes), so future subscription logic can reason about already-uploaded media on both platforms

**Pull (cloud → desktop):**
- Fetches `observations WHERE desktop_id IS NULL` (created on mobile)
- Creates local SQLite rows via `ObservationDB.create_observation()`
- Writes `desktop_id` back to Supabase for future dedup
- Watermarked by `cloud_last_pull_at` in `app_settings.json`
- Pulls cloud-managed images into the local desktop observation and refreshes the local media baseline
- Hydrates local `images.ai_crop_*` fields from `public.observation_images` when cloud images already have AI crop metadata
- Uses a bulk-fetch `in.()` query for image metadata to prevent N+1 query performance bottlenecks during sync.
- Before deep comparison, desktop sync now prefilters cloud observations using one local lookup pass plus the cloud row `updated_at` versus local `synced_at`.
- A small grace window is applied to `updated_at > synced_at` checks so server-write timestamp skew from the same sync cycle does not cause every observation to be re-checked on next app launch.
- **EXIF restoration:** When downloading field images that have no EXIF (stripped by the web app's 2 MP Canvas conversion), the desktop re-injects observation GPS and date into the JPEG EXIF so "Set from current image" works in the Prepare Images dialog.
- **Local file preservation:** If the local copy of a field image is larger than the downloaded cloud version, the local full-res original is kept and only DB metadata is updated. This prevents the 2 MP cloud copy from overwriting full-resolution desktop-imported originals.

**Conflict rule:**
- Desktop sync stores a last-seen cloud snapshot for linked observations.
- If the same linked observation changed on both desktop and web since the last synced snapshot, the desktop skips automatic overwrite and reports a conflict.
- Conflict checking strictly compares only images designated for sync (e.g., skipping generated microscope plots or local plates) to prevent falsely flagging them as deleted by the cloud.
- Order-only image changes are treated as low-signal and no longer produce standalone cloud-conflict review items.
- `Keep desktop` still refreshes the cloud snapshot and sync markers, but it skips image re-upload work when no meaningful desktop media changes remain.
`private_comment` never leaves the desktop.

Triggered via Settings → Sporely Cloud Sync… in the desktop app.
