# Sporely Web — Technical Spec

## File Map (Core)
- `src/main.js`: Boot & Auth.
- `src/state.js`: Central State.
- `src/sync-queue.js`: IndexedDB Offline Queue (Durable Boundary).
- `src/images.js`: Client-side compression (public 20MP cloud policy with an internal `>21MP` / `>5300px` resize gate on normal WebP-capable runtimes, plus a reduced 6 MP JPEG path for iOS WebKit when WebP canvas export is unavailable, plus free/pro quality tiers) & R2 uploads.
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
- **Account Deletion:** Bypasses RLS via the `delete-account` Edge Function to fully remove user rows, canonical observation media via the R2 worker, Storage avatars, and any legacy leftovers.
- **Schema Migrations:** `observation_identifications` is an optional cache table, and its `observation_id` must be `bigint` to match `observations.id`. If a migration partially applies, repair `supabase_migrations.schema_migrations` and rerun `supabase db push` instead of changing the schema to fit the failed history entry.

## Desktop Sync & Deduplication
- **Cloud vs Local:** `sporely-web` writes to Supabase. `sporely-py` uses local SQLite and syncs to Supabase using REST APIs.
- **Deduplication:** Mobile inserts rows with `desktop_id = NULL`. Desktop pull assigns its local `id` to the cloud row's `desktop_id`. Future upserts rely on the `UNIQUE(desktop_id, user_id)` constraint.
- **Conflict Resolution:** Desktop stores a last-seen snapshot. If changes overlap, desktop pauses and asks the user to pick Cloud or Desktop, except for safe, non-colliding media-metadata auto-merges.

## Media Pipeline
- **Formats:** WebP when canvas export actually returns WebP, or JPEG fallback. Free full-image uploads use a 1.5 MB cap; Pro/full-res uses 5 MB. On iOS WebKit, the browser path intentionally falls back to a 6 MP JPEG policy before byte-cap attempts.
- **Structure:** `{user_id}/{obs_id}/{filename}` + `thumb_{filename}` (400px).
- **R2 Worker:** Proxies uploads; enforces ES256 JWT auth; updates storage quotas.
- **Preparation:** Uses `OffscreenCanvas` via `src/image-worker.js`. Enforces strict memory management (`canvas.width = 0`). Resizes to the current cloud-policy cap and applies the free/pro quality and byte-cap tiers.
- **Thumbnail:** A single 400px `thumb_{filename}` variant is generated.
- **Background Sync:** Managed by `src/sync-queue.js`. Data is written as `ArrayBuffer` in IndexedDB. Partial uploads are resolved using `sort_order`. Background tasks attempt to drain the queue when the app is minimized.
- **HEIC Fallback:** If the browser cannot natively decode an image into a Canvas (e.g., HEIC on web), the resize step gracefully fails and uploads the original file with `upload_mode: 'original'`.

## Auth Flow
- **Boot:** `supabase.auth.getSession()` determines initial app state. `onAuthStateChange` transitions between shell and auth overlay.
- **Edge cases:** Handles unconfirmed accounts, already registered, and expired OTPs natively by offering "Check inbox" + resend links.

## Camera Behaviors
- **Native (Android / CameraX):** Active only when running the installed Android app via Capacitor. Uses native CameraX capture paths, the best available lens when possible, and true original-resolution photos from the device. Retains EXIF orientation and GPS securely without canvas stripping. Supports legacy OEM HDR extensions and Android 14+ Ultra HDR (`JPEG_R`).
- **Web (`getUserMedia` / PWA):** Used in mobile browsers and installed PWAs. Streams video into HTML `<canvas>`, which is typically constrained by browser capture limits and yields lower image quality than native capture. Browsers strip EXIF/GPS from canvas blobs, so the app compensates with `navigator.geolocation` during capture. iOS WebKit is treated as a reduced-support path when it cannot reliably encode WebP from canvas, so the app intentionally uses a 6 MP JPEG policy there. The UI warns Android web users to install the native app when camera quality or metadata fidelity matters.

## Location Lookup
Sporely resolves place names through Nominatim first so it can reliably capture `country_code`, `country_name`, and the raw `display_name` for fallback use. That lookup drives the local suggestion list and keeps the full address string available when there are no shorter address parts to show.

For Norway and Denmark, the lookup flow adds a country-specific local source ahead of the Nominatim suggestions. Norway prefers Artsdatabanken when the returned point is close enough; Denmark prefers DAWA-style address labels. The UI keeps the first suggestion as the auto-fill value, exposes the full suggestion list on focus, and stores the resolved lookup alongside the observation or import session so the same place name can be reused for multi-photo observations.

## Map Current Location
The map shows the device's current GPS position as a dedicated Leaflet pin with an accuracy ring. A locate button recenters the map to an approximate 2x2 km view around `state.gps`, and the pin updates whenever `startGeo()` emits a GPS update.

## Map Time Filter
The map scope now has a second row of buttons for `All`, `Past 24h`, `Past week`, and `Past month`. It filters observations by the observation `date` field on the server before rendering the pins, and `Past month` is the default selection.

## Capture & Import Flow
- **Capture:** `capturePhoto()` returns `{ blobPromise, gps, ts, aiCropRect }`. `saveObservationBatch()` waits for all blob promises before enqueueing to IndexedDB.
- **Import:** Uses NativePhotoPicker (Android EXIF/GPS via temp files) or browser native picker. Sorts and groups images by capture time. Generates reduced AI blobs up front. Location metadata is separated from blobs.
- **Identification:** The `uncertain` field indicates low confidence, shown as "Uncertain ID" or prefixed with `?`.

## Artsorakel Proxy
- **Handling:** Proxies AI ID requests via `POST /artsorakel` to `https://ai.artsdatabanken.no`. Buffers full multipart payload to `ArrayBuffer` before upstream fetch to avoid silent partial-body errors.
