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
| Native wrapper | Capacitor Android + `@capawesome/capacitor-file-picker` |
| Styling | Plain CSS custom properties, no preprocessor |
| Auth & DB | Supabase JS v2 (`@supabase/supabase-js`) |
| Media storage | Cloudflare R2 bucket `sporely-media` |
| Media upload | Cloudflare Worker at `upload.sporely.no` (JWT-authenticated PUT/DELETE) |
| Media serving | Public CDN at `https://media.sporely.no` |
| Account/storage foundation | Supabase profile plan flags + worker-enforced storage tally/quota |

Supabase Storage (`observation-images` bucket) is no longer used for new uploads.
All media now goes through the Cloudflare R2 pipeline.

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
    ├── settings.js         Local Settings preferences: visibility, sync data policy, sync history
    ├── images.js           Upload originals + thumbnail variants, media URL helpers
    ├── image_crop.js       Shared AI crop math + cropped blob export helpers
    ├── ai-crop-editor.js   Full-screen AI crop editor used by review/import flows
    ├── sync-queue.js       IndexedDB offline queue for captured observations
    ├── import-store.js     IndexedDB persistence for pending import sessions
    ├── style.css           All CSS (custom properties, no utility classes)
    └── screens/
        ├── auth.js         Login, signup, resend confirmation, hash error handling
        ├── home.js         Dashboard, recent finds from Supabase, sign-out
        ├── finds.js        Full observation list from Supabase
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

### Thumbnail variants

`src/images.js` generates two variants at upload time:
- `thumb_small_{filename}` — 240px, JPEG 82%
- `thumb_medium_{filename}` — 720px, JPEG 82%

### ⚠️ Known issue: EXIF stripped during free-tier 2 MP conversion

Free-tier uploads resize images to approximately 2 MP via the Canvas API before uploading to R2.
**Canvas `toBlob()` strips all EXIF** — GPS coordinates, `DateTimeOriginal`, camera model, etc. are
lost in the stored R2 file.

**Desktop workaround (implemented):** When the desktop pulls a cloud field image, it checks
whether the image has no EXIF datetime/GPS; if the observation has GPS or date stored in the local
database, it injects that metadata back into the downloaded JPEG using PIL. This restores the
"Set from current image" button functionality in the Prepare Images dialog for cloud-synced images.
See `_inject_obs_exif_into_field_image()` and `_backfill_missing_exif_on_cloud_images()` in
`sporely/utils/cloud_sync.py`.

**Permanent fix needed in the web app:** In `src/images.js` or `src/screens/import_review.js`,
extract GPS + capture time from native EXIF *before* the Canvas resize step (e.g. using `exifr`),
then either:
- Re-inject the EXIF bytes into the JPEG blob before upload (using `piexifjs` or equivalent), or
- Write GPS and `captured_at` into the `observation_images` row explicitly so desktop sync can
  restore it.

See also `sporely-web PLAN.md` → Phase 4 → Metadata Preservation.

For the original upload path, the web app now records how the stored cloud image was prepared:
- `upload_mode` — `reduced` or `full`
- `source_width`, `source_height`
- `stored_width`, `stored_height`
- `stored_bytes`

Desktop cloud sync prepares and pushes the same metadata so both clients describe cloud media the same way.

Both stored under the same directory as the original, e.g.:
```
{user_id}/{obs_id}/0_1234567890.jpg          ← original
{user_id}/{obs_id}/thumb_small_0_1234567890.jpg
{user_id}/{obs_id}/thumb_medium_0_1234567890.jpg
```

### Environment variables

Frontend (`.env.local` / `.env.example`):
```
VITE_MEDIA_BASE_URL=https://media.sporely.no
VITE_MEDIA_UPLOAD_BASE_URL=https://upload.sporely.no
```

Worker (`wrangler.toml` `[vars]`):
```
SUPABASE_URL=https://zkpjklzfwzefhjluvhfw.supabase.co
SUPABASE_JWT_AUDIENCE=authenticated
MEDIA_PUBLIC_BASE_URL=https://media.sporely.no
ALLOWED_ORIGINS=https://app.sporely.no,https://localhost:5173,http://localhost:5173,...
MAX_UPLOAD_BYTES=15728640
FREE_STORAGE_QUOTA_BYTES=0
```

Worker secrets:
```sh
SUPABASE_SERVICE_ROLE_KEY=<Supabase secret key, stored with wrangler secret put>
```

### Deploying the worker

```sh
cd cloudflare/r2-upload-worker
npx wrangler deploy
```

Before deploying storage/quota tracking, run `supabase/profile-storage-usage.sql` in the
Supabase SQL Editor and set the Cloudflare Worker secret with:

```sh
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Custom domain `upload.sporely.no` is registered automatically via the `[[routes]]` block
in `wrangler.toml` — no manual DNS entry needed as long as `sporely.no` is proxied through Cloudflare.

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

### R2 CORS (`media.sporely.no`)

The R2 bucket `sporely-media` has a CORS policy that allows `GET`/`HEAD`/`PUT`/`POST`
from all origins (`*`). This is required because:
- `find_detail.js` fetches images from the CDN via `fetch(img.src)` to pass blobs to the
  Artsorakel AI. Without `Access-Control-Allow-Origin: *`, the browser blocks these fetches
  and artsorakel silently gets zero blobs → "no suggestions".
- Dev server and LAN testing use different origins than `app.sporely.no`.

To inspect or update the CORS policy:
```sh
# View current rules
npx wrangler r2 bucket cors list sporely-media

# Update (format must match the Cloudflare R2 CORS API schema)
npx wrangler r2 bucket cors set sporely-media --file cors.json --force
```

The correct JSON schema for the `--file` argument:
```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["*"],
        "methods": ["GET", "HEAD", "PUT", "POST"],
        "headers": ["*"]
      },
      "exposeHeaders": [],
      "maxAgeSeconds": 86400
    }
  ]
}
```

### Known gotcha: Web Crypto ECDSA signature format

Web Crypto's `subtle.verify` for ECDSA expects **raw IEEE P1363 format** (r||s concatenated).
JOSE JWTs already use this format. Do **not** convert the signature to DER before passing
to `subtle.verify` — that will cause every valid token to fail with "JWT signature
verification failed".

---

## Database schema (Supabase side)

Full SQL is in `sporely/database/` (the desktop app repo).
Key tables used by the web app:

### `observations`
Maps 1-to-1 with the desktop SQLite `observations` table.
Extra cloud-only columns:
- `user_id uuid` — FK to `auth.users` (set by RLS, never trusted from client)
- `desktop_id int` — local SQLite `id`, used for dedup on sync
- `location_public bool` — hide GPS from friends if false
- `visibility text` — cloud sharing scope (`private` / `friends` / `public`)
- `image_key text` — relative R2 key of the cover image
- `thumb_key text` — relative R2 key of the cover thumbnail (small variant)

### `observation_images`
- `storage_path text` — relative R2 media key (e.g. `{user_id}/{obs_id}/0_ts.jpg`)
- `image_type` — `'field'` | `'microscope'`
- `image_key text` — same as `storage_path` (normalized)
- `thumb_key text` — relative key of the small thumbnail variant
- `ai_crop_x1`, `ai_crop_y1`, `ai_crop_x2`, `ai_crop_y2` — normalized AI crop rectangle (`0..1`)
- `ai_crop_source_w`, `ai_crop_source_h` — source dimensions when the AI crop was set
- `upload_mode` — `reduced` or `full`
- `source_width`, `source_height` — original dimensions seen by the uploading client
- `stored_width`, `stored_height` — dimensions actually stored in cloud
- `stored_bytes` — size of the stored original blob in bytes

AI crop metadata is stored per image and only affects Artsorakel requests. Gallery rendering still uses the full stored image.
- Full microscope metadata columns present but only populated by desktop sync

### `profiles`
Auto-created by a Postgres trigger on `auth.users` insert.
Profile UI reads `username`, `display_name`, and `avatar_url`.
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

Note: Supabase Storage bucket `observation-images` still exists but is no longer used
for new uploads. Media access control is now handled by the R2 upload worker (JWT path
enforcement) and Cloudflare's public CDN for serving.

---

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
  ├─ Capacitor Android → NativePhotoPicker plugin returns original URI + native EXIF/GPS
  └─ Browser / fallback → file input or showOpenFilePicker()

handleSelectedFiles()
  1. Read capture time + GPS from native metadata or exifr
  2. Sort files by capture time
  3. Group files taken within the configured time gap into one observation
  4. Convert review copies to JPEG sequentially to avoid mobile memory spikes
  5. Pre-seed per-image AI crop metadata and save pending import sessions to IndexedDB so review survives app suspension

Single group:
  save immediately → open observation detail editor

Multiple groups:
  show grouped import cards → user edits species/location/sharing/AI crop → save all
```

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
- Syncs the selected desktop images plus optional generated media (measure plot, thumbnail gallery, plate)
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
| Image upload to Cloudflare R2 | ✅ Real — via `upload.sporely.no` worker |
| Grid/card thumbnails | ✅ Real — `small` + `medium` variants generated at upload time |
| Profile avatar upload/crop | ✅ Real |
| Self-service account deletion | ✅ Real — via Supabase Edge Function `delete-account` |
| Finds list from Supabase | ✅ Real |
| Recent finds on home screen | ✅ Real |
| Desktop ↔ cloud sync | ✅ Real (desktop side) |
| Artsorakel (Artsdata AI species ID) | ✅ Real — proxied through the Cloudflare Worker when `VITE_MEDIA_UPLOAD_BASE_URL`/`VITE_ARTSORAKEL_BASE_URL` is configured, with direct-call fallback otherwise |
| Taxa autocomplete search | ✅ Real — Supabase RPC for taxon inputs; map autocomplete uses currently loaded observations for faster local filtering |
| Camera permission denied overlay | ✅ Real — platform-specific instructions |
| Friends finds + thumbnails | ✅ Real — `observations_friend_view` + R2 public CDN |
| Community finds | ✅ Real — `observations_community_view` (visibility = public) |
| Map view | ✅ Real — Leaflet + OpenStreetMap |
| Offline queue | ✅ Real — IndexedDB queue, syncs on reconnect |
| Import review recovery after app suspension | ✅ Real — IndexedDB `pending_import` store |
| Friends feed | 🟡 Stubbed — toast only |
| Capture draft save/resume | ❌ Removed — capture review is now direct cancel/save |
| Push notifications | ❌ Not started |
| Pro Subscription (RevenueCat) | 🟡 Groundwork in place — schema + upload metadata are live, but no billing/IAP flow yet |
| Hardware Sync (Macro-to-GPS) | ❌ Not started |

---

## Infrastructure status

| Item | Status |
|---|---|
| Supabase project | ✅ Live (`zkpjklzfwzefhjluvhfw`) |
| Supabase JWT algorithm | ✅ ES256 (ECC P-256) — asymmetric, JWKS-based |
| Email via Resend SMTP | ✅ Configured (`noreply@sporely.no`, domain verified) |
| Cloudflare R2 bucket `sporely-media` | ✅ Live |
| Cloudflare Worker `upload.sporely.no` | ✅ Live — custom domain via `[[routes]]` in wrangler.toml |
| Cloudflare CDN `media.sporely.no` | ✅ Live — public R2 bucket serving, CORS `*` configured |
| Subscription bootstrap SQL | ✅ Applied — profile plan flags + upload metadata columns are live |
| `avatars` Storage bucket (Supabase) | ✅ Created, public read + owner-scoped writes |
| `taxa` + `taxa_vernacular` tables | ✅ Populated (110k taxa, 70k vernacular names) |
| `search_taxa` RPC | ✅ Deployed |
| `delete-account` Edge Function | ⚠️ In repo — must be deployed in Supabase before the UI button works |
| Unique constraints on observations | ⚠️ Not yet run — see `supabase_unique_constraints.sql` |
