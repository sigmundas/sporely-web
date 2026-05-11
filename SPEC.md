# Sporely Web — Technical Spec

## File Map (Core)
- `src/main.js`: Boot & Auth.
- `src/state.js`: Central State.
- `src/sync-queue.js`: IndexedDB Offline Queue (Durable Boundary).
- `src/images.js`: Client-side compression (12MP/2MP) & R2 Uploads.
- `src/image-worker.js`: Off-thread Resize/Encode (OffscreenCanvas).

## Data Flow: Capture to Cloud
1. Capture/Import → `ArrayBuffer` saved to IndexedDB (Durable).
2. Foreground: `prepareImageVariants` (Canvas resize/WebP encode).
3. Background: `triggerSync` → Supabase INSERT → R2 PUT (ArrayBuffer).
4. Finalize: Confirmation check before deleting IDB record.

## Database & Security (RLS)
- **Auth Boundaries:** All client data access uses the publishable anon key. RLS enforces read/write limits (client must never rely on setting `user_id` as a trust boundary).
- **Visibility Model:** Controlled by `visibility` (`'public' | 'friends' | 'private'`), `location_precision` (`'exact' | 'fuzzed'`), and `is_draft`.
- **Privacy Slots:** A database trigger consumes 1 slot for free accounts if an observation is not fully transparent (`visibility != 'public'` or `location_precision = 'fuzzed'`).
- **Feed Views:** `observations_community_view` and `observations_friend_view` handle UGC compliance by implicitly filtering out content from blocked users (`user_blocks`) and banned authors (`profiles.is_banned = true`).
- **Account Deletion:** Bypasses RLS via the `delete-account` Edge Function to fully remove user rows, Storage avatars, and orchestrate underlying data deletion.

## Desktop Sync & Deduplication
- **Cloud vs Local:** `sporely-web` writes to Supabase. `sporely-py` uses local SQLite and syncs to Supabase using REST APIs.
- **Deduplication:** Mobile inserts rows with `desktop_id = NULL`. Desktop pull assigns its local `id` to the cloud row's `desktop_id`. Future upserts rely on the `UNIQUE(desktop_id, user_id)` constraint.
- **Conflict Resolution:** Desktop stores a last-seen snapshot. If changes overlap, desktop pauses and asks the user to pick Cloud or Desktop, except for safe, non-colliding media-metadata auto-merges.

## Media Pipeline
- **Formats:** WebP (0.65) or JPEG (0.75) fallback.
- **Structure:** `{user_id}/{obs_id}/{filename}` + `thumb_{filename}` (400px).
- **R2 Worker:** Proxies uploads; enforces ES256 JWT auth; updates storage quotas.
- **Preparation:** Uses `OffscreenCanvas` via `src/image-worker.js`. Enforces strict memory management (`canvas.width = 0`). Resizes to ~2MP for free accounts and ~12MP for Pro accounts.
- **Thumbnail:** A single 400px `thumb_{filename}` variant is generated.
- **Background Sync:** Managed by `src/sync-queue.js`. Data is written as `ArrayBuffer` in IndexedDB. Partial uploads are resolved using `sort_order`. Background tasks attempt to drain the queue when the app is minimized.
- **HEIC Fallback:** If the browser cannot natively decode an image into a Canvas (e.g., HEIC on web), the resize step gracefully fails and uploads the original file with `upload_mode: 'original'`.

## Auth Flow
- **Boot:** `supabase.auth.getSession()` determines initial app state. `onAuthStateChange` transitions between shell and auth overlay.
- **Edge cases:** Handles unconfirmed accounts, already registered, and expired OTPs natively by offering "Check inbox" + resend links.

## Camera Behaviors
- **Native (Android / CameraX):** Capacitor hook for 12MP captures. Retains EXIF/GPS securely without canvas stripping. Supports Android 14+ Ultra HDR (`JPEG_R`).
- **Web (`getUserMedia` / PWA):** Video stream mapped to HTML `<canvas>` (~2MP limit). Browsers strip EXIF/GPS from canvas blobs, so the app manually compensates via `navigator.geolocation` during capture.

## Capture & Import Flow
- **Capture:** `capturePhoto()` returns `{ blobPromise, gps, ts, aiCropRect }`. `saveObservationBatch()` waits for all blob promises before enqueueing to IndexedDB.
- **Import:** Uses NativePhotoPicker (Android EXIF/GPS via temp files) or browser native picker. Sorts and groups images by capture time. Generates reduced AI blobs up front. Location metadata is separated from blobs.
- **Identification:** The `uncertain` field indicates low confidence, shown as "Uncertain ID" or prefixed with `?`.

## Artsorakel Proxy
- **Handling:** Proxies AI ID requests via `POST /artsorakel` to `https://ai.artsdatabanken.no`. Buffers full multipart payload to `ArrayBuffer` before upstream fetch to avoid silent partial-body errors.