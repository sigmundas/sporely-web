# Sporely Web — Technical Spec

## File Map (Core)
- `src/main.js`: Boot & Auth.
- `src/state.js`: Central State.
- `src/geo.js`: Location service/state, session lifecycle, location-state events.
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
- **AI Cache Visibility:** `observation_identifications_community_view` exposes cached AI result sets read-only for observations the viewer can already see. Owners still use `observation_identifications` for writes, reruns, and edits.
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

> Authoritative spec: [ARCHITECTURE.md → Auth State Machine](ARCHITECTURE.md#auth-state-machine) and [ARCHITECTURE.md → Sign-out semantics](ARCHITECTURE.md#sign-out-semantics). This section is the user-visible contract; the canonical client-side implementation lives in `src/auth-state.js`, `src/auth-classification.js`, `src/auth-session.js`, `src/auth-signout.js`, `src/capabilities.js`, and `src/reauth.js`.

- **Client:** `supabase.auth.getSession()` (with `autoRefreshToken: true` and `persistSession: true` — the supabase-js v2 defaults; the project does not override them) determines the initial app state. `onAuthStateChange` is the only event source; the direct callback is intentionally non-awaiting (see *Deferred event pipeline* below).
- **States:** the app is in exactly one of six `AUTH_STATE` values at any moment: `RESOLVING`, `UNAUTHENTICATED`, `AUTHENTICATED_INCOMPLETE` (signed in, profile not finished), `AUTHENTICATED_COMPLETE`, `AUTHENTICATED_CACHED`, `AUTHENTICATED_REAUTH_REQUIRED`. Only `AUTHENTICATED_COMPLETE` authorizes authenticated network operations — every other state is gated through `canPerformCloudMutation()` in `src/capabilities.js` so the same "Internet connection required" / "Sign in to reconnect" wording stays consistent across screens.
- **Reachability probe (B1):** a tiny anonymous GET to `https://<project>.supabase.co/auth/v1/health` with a 3 s timeout and `no-store` decides whether a non-session boot is offline (`AUTHENTICATED_CACHED`) or reachable-without-session (`AUTHENTICATED_REAUTH_REQUIRED`). The probe is never the authority for the *session* — only the *backend reachability*. See `src/auth-classification.js`.
- **"Session expired" copy is REAUTH-only.** The "Session expired" / "Sign in again" banner on Home, the equivalent in the Profile sheet, and the equivalent note in Finds are shown **only** when `AUTHENTICATED_REAUTH_REQUIRED` — i.e. the device previously completed an online resolution *and* the backend is reachable *and* the local session is unrecoverable. A user in plain-offline `AUTHENTICATED_CACHED` sees the Offline pill and the cached content; the sign-in CTA is never shown. A user in `AUTHENTICATED_COMPLETE` never sees any of this.
- **Refresh-side classification.** The classifier `isExplicitAuthRejection` in `src/auth-classification.js` deliberately *does not* match a bare `"JWT expired"` from the access token — access tokens are short-lived (default 1 h) and the supabase-js client refreshes them silently in the background. A bare access-token expiry is the normal "stay logged in" path, not a "session expired" event. The classifier matches refresh-side signals only: `invalid_grant`, `invalid refresh token`, `refresh_token_not_found`, `refresh_token_already_used`, `refresh token expired`, `user_not_found`, `session_not_found`. Treating a bare access-JWT expiry as an explicit reject would deny cached boot on every offline launch.
- **Deferred event pipeline.** supabase-js holds an internal auth lock while dispatching `onAuthStateChange`. Awaiting any Supabase API in the direct callback deadlocks that lock — `SIGNED_IN` never returns and every subsequent auth call hangs. The direct callback enqueues onto a single promise chain and returns immediately; the deferred handler runs the resolve / sign-out / cached-revalidation pipeline outside the lock. See `src/main.js` `enqueueAuthEvent` and the regression test `src/auth-deadlock.regression.test.js`.
- **Edge cases (email / OTP flows):** handles unconfirmed accounts, already-registered, and expired email OTPs natively by offering "Check inbox" + resend links. **This OTP expiry is unrelated to the JWT "session expired" state above** — email OTPs gate the *account*; the access/refresh JWTs gate the *session*. A user with an expired email OTP can still hold a valid session, and vice versa. The two surfaces never share copy.
- **Live reconnect.** When the app is in `AUTHENTICATED_CACHED` or `AUTHENTICATED_REAUTH_REQUIRED`, ten wake-up sources converge on a single deduped + throttled revalidation entry point: native `networkStatusChange` (false→true), native `App.resume` + `Network.getStatus()`, web `online` / `focus` / `visibilitychange:visible`, the 15 s cached watchdog (foregrounded CACHED only), the one-shot 5 s boot deferred re-probe, and the user-initiated Finds pull-to-refresh. See `src/main.js` `requestConnectivityRevalidation` and `src/native-network.js`.
- **Recovery.** Every "Sign in again" surface (Home banner, Profile sheet, Finds note) calls the single shared recovery seam `beginReauthentication()` (`src/reauth.js`). The injected handler authenticates without signing out first, so queued observations, drafts, and the trusted same-user snapshot survive a same-user reauth. A different-user sign-in takes the existing full account-transition privacy boundary unchanged.

## Camera Behaviors
- **Native (Android / CameraX):** Active only when running the installed Android app via Capacitor. Uses native CameraX capture paths, the best available lens when possible, and true original-resolution photos from the device. Retains EXIF orientation and GPS securely without canvas stripping. Supports legacy OEM HDR extensions and Android 14+ Ultra HDR (`JPEG_R`).
- **Web (`getUserMedia` / PWA):** Used in mobile browsers and installed PWAs. Streams video into HTML `<canvas>`, which is typically constrained by browser capture limits and yields lower image quality than native capture. Browsers strip EXIF/GPS from canvas blobs, so the app compensates with `navigator.geolocation` during capture. iOS WebKit is treated as a reduced-support path when it cannot reliably encode WebP from canvas, so the app intentionally uses a 6 MP JPEG policy there. The UI warns Android web users to install the native app when camera quality or metadata fidelity matters.

## Location Lookup
Sporely resolves place names through Nominatim first so it can reliably capture `country_code`, `country_name`, and the raw `display_name` for fallback use. That lookup drives the local suggestion list and keeps the full address string available when there are no shorter address parts to show.

For Norway and Denmark, the lookup flow adds a country-specific local source ahead of the Nominatim suggestions. Norway prefers Artsdatabanken when the returned point is close enough; Denmark prefers DAWA-style address labels. The UI keeps the first suggestion as the auto-fill value, exposes the full suggestion list on focus, and stores the resolved lookup alongside the observation or import session so the same place name can be reused for multi-photo observations.

## Location State
- `state.location.fix` is the latest current-device fix for location-aware UI such as the map and current-location status.
- `state.captureSessionLocation.fix` is the canonical live-capture observation coordinate for the current field session.
- `state.reviewContext.gps` is the canonical coordinate source for imported review.
- `LOCATION_STATE_CHANGED_EVENT` is the location-state update event that screens listen to for UI refreshes.
- Session tokens plus `sessionStartAt` protect against stale asynchronous callbacks, including late one-shot responses and late watch callbacks.
- Live-session fix selection prefers the first usable fix, then finite accuracy over missing accuracy, then lower accuracy, then newer timestamp on ties.
- Save-time review requests use a bounded fresh location request rather than an open-ended watch.
- Persistent opt-out is separate from session-only dismissal: disabled preference suppresses location until the user re-enables it in settings, while session-only dismissal only suppresses the warning for the current live observation.

## Map Current Location
The map shows the device's current location as a dedicated Leaflet pin with an accuracy ring. A locate button recenters the map to an approximate 2x2 km view around `state.location.fix`, and the pin updates whenever `LOCATION_STATE_CHANGED_EVENT` fires.

## Map Time Filter
The map scope now has a second row of buttons for `All`, `Past 24h`, `Past week`, and `Past month`. It filters observations by the observation `date` field on the server before rendering the pins, and `Past month` is the default selection.

## Capture & Import Flow
- **Capture:** `capturePhoto()` returns `{ blobPromise, gps, ts, aiCropRect }` for per-photo compatibility snapshots. Live observation coordinates are tracked separately in `state.captureSessionLocation.fix`, and `saveObservationBatch()` waits for all blob promises before enqueueing to IndexedDB.
- **Import:** Uses NativePhotoPicker (Android EXIF/GPS via temp files) or browser native picker. Sorts and groups images by capture time. Generates reduced AI blobs up front. Imported review keeps its own `state.reviewContext.gps`, and location metadata is separated from blobs.
- **Identification:** The `uncertain` field indicates low confidence, shown as "Uncertain ID" or prefixed with `?`.

## Artsorakel Proxy
- **Handling:** Proxies AI ID requests via `POST /artsorakel` to `https://ai.artsdatabanken.no`. Buffers full multipart payload to `ArrayBuffer` before upstream fetch to avoid silent partial-body errors.
