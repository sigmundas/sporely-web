# Sporely-web Development Plan

## Bugs
- I can't delete observations from app.sporely.no. Deleting from the installed apk app works. Error: "Delete failed: failed to fetch"

## Upload Debug Log
*Goal: keep a running, dated log of cross-platform photo import, upload, queue, thumbnail, and Artsorakel behavior so regressions are easier to track.*

### 2026-04-18 — Current Working Notes

**Important deployment note**
- `app.sporely.no` auto-updates from GitHub pushes and usually shows the new Pages build within about 1 minute.
- The Cloudflare Worker at `upload.sporely.no` does **not** auto-deploy with repo pushes; worker changes still require manual deployment.
- This matters because several current symptoms look like: observation row inserted successfully, but media upload / image row / queue cleanup fails afterward.

**What was reported before this round**
- Initial live issue: installed web app on iPhone showed `Artsorakel: Load failed` immediately after tapping Identify on a newly taken photo.
- Initial live issue: installed web app / Android showed `Artsorakel unavailable right now` immediately for both imported photos and freshly taken photos.
- Initial live issue: iPhone import via web app sometimes did nothing after trying to import photos.
- Earlier Android local-network test: Artsorakel worked for imported photos, but saving produced two cards for the same observation and neither showed the expected image thumbnail.
- Earlier `app.sporely.no` test: iPhone photo capture could run Artsorakel, but saving still showed one queued observation plus one non-queued duplicate with no real image.
- Earlier `app.sporely.no` test: iPhone `Import photo from file` produced no visible result.

**Changes attempted in this round**
- Added client-side Artsorakel fallback from the authenticated worker proxy to the direct Artsdata endpoint, plus broader Safari/WebKit network-error detection in `src/artsorakel.js`, `src/screens/review.js`, `src/screens/find_detail.js`, and `src/screens/import_review.js`.
- Reworked browser file-input triggering to avoid fragile hidden-input programmatic picker behavior, especially for iPhone web apps.
- Restored Android home-screen import to go directly to the photo picker instead of showing the extra source-choice sheet.
- Added more aggressive Finds dedupe logic so queued observations and newly inserted cloud rows would not both render when they appear to be the same observation.
- Reintroduced worker-origin changes so browser/PWA requests from `app.sporely.no`, `sporely.no`, subdomains, and `Origin: null` are accepted by the upload worker.

**Results of those changes**
- iPhone web app import-from-file is now much better than before: photo import works, GPS from EXIF is present, and Artsorakel works.
- The queue / thumbnail / upload-completion problems remain unresolved across platforms.
- Android behavior is still inconsistent between APK and web app, suggesting at least one issue remains in the actual upload/sync path, not only in the picker UI.

### 2026-04-18 — Current Behavior Matrix

**Android APK**
- Camera capture:
  - Saving creates a `Queued for upload` card.
  - The observation appears stuck in the queue.
  - Going Home and back to Finds does not clear the queued state.
  - Thumbnail area is blank.
- Import from file:
  - `Converting 1 of 1...` takes a very long time.
  - This used to be much faster before the latest changes.
  - The same queue problem remains afterward.
  - Thumbnail area is blank.
  - Artsorakel works in both Android APK cases above.

**Android web app (`app.sporely.no`)**
- Same account as Android APK:
  - One queued upload is visible twice.
  - No photo is shown.
  - Species and location appear to have reached the database, but image upload/thumbnail did not complete cleanly.
- Photo capture:
  - Artsorakel says `unavailable right now`.
  - Save produces one queued card without a thumbnail and one normal card with a mushroom emoji.

**iPhone web app (`app.sporely.no`)**
- Photo capture:
  - Artsorakel works.
  - Saving takes a long time.
  - One queued-for-upload card appears.
  - No extra duplicate card is currently seen.
  - No photo thumbnail appears.
- Photo import from file:
  - Import works.
  - GPS from EXIF works.
  - Artsorakel works.
  - Observation never leaves the queue.
  - No thumbnail image appears in the card.

### 2026-04-18 — Current Hypotheses

**Likely failure point**
- The cloud observation row is probably being inserted before media upload and/or image-row creation finishes.
- That would explain the common pattern:
  - species / location reach the DB,
  - the queue item remains,
  - thumbnails never appear,
  - and a duplicate row can appear if Finds renders both the queued item and the partially-synced cloud row.

**Most likely code paths to inspect next**
- `src/sync-queue.js`
  - Observation insert succeeds.
  - One of these later steps may fail silently or repeatedly:
    - `uploadObservationImageVariants(...)`
    - `insertObservationImage(...)`
    - `syncObservationMediaKeys(...)`
    - queue deletion after successful sync
- `src/screens/finds.js`
  - UI dedupe may still not catch all queue-vs-cloud timing cases.
- Cloudflare Worker upload path
  - Live `app.sporely.no` behavior may still differ from local/browser tests if the worker was not redeployed after source changes.

### 2026-04-18 — Next Debugging Tasks

- Add explicit step-by-step logging around queue processing:
  - observation insert start/success/fail
  - image upload start/success/fail
  - `observation_images` insert start/success/fail
  - `observations.image_key/thumb_key` sync start/success/fail
  - queue deletion start/success/fail
- Verify whether queued observations are actually retrying in the background or are permanently blocked after the first failure.
- Confirm whether `app.sporely.no` has the latest worker deployed, not just the latest Pages frontend.
- Investigate why Android APK `Converting 1 of 1...` regressed and became slow again.
- Keep appending dated observations to this section after each real-device test round.

### 2026-04-18 — New Strategy Pass Applied

**New likely root cause found**
- The upload worker only advertised `Authorization, Content-Type, Cache-Control` in `Access-Control-Allow-Headers`.
- The web client was sending extra `X-Sporely-Upload-Mode`, `X-Sporely-Cloud-Plan`, and `X-Sporely-Upload-Origin` headers on image uploads.
- Those custom headers were **not** actually used by the worker upload handler.
- On mobile PWAs, that mismatch is a strong candidate for why observation rows could be created while image upload stayed stuck in the queue: the browser can block the upload at preflight time before the PUT fully succeeds.

**What was changed**
- `src/images.js`
  - Removed the unused `X-Sporely-*` upload headers from worker PUT requests.
  - This means the frontend should now exercise a less fragile upload path immediately after a normal repo push.
- `cloudflare/r2-upload-worker/src/index.js`
  - Also widened worker CORS `Access-Control-Allow-Headers` to include those `X-Sporely-*` headers anyway, so the worker is more tolerant if they are ever reintroduced later.
- `src/screens/import_review.js`
  - Changed imported-photo preprocessing to keep the original file for preview/upload when the browser can already decode it.
  - Only the reduced AI blob is generated eagerly now.
  - This should reduce the long `Converting 1 of 1...` delay on Android imports, because the app no longer re-encodes a full-resolution JPEG up front for every imported photo.

**Expected results from this strategy**
- Queue items should have a better chance of actually leaving the queue after image upload instead of getting stuck after only the observation row is inserted.
- Pending cards should be less likely to remain photo-less for uploads that were previously blocked before media storage completed.
- Android import should feel faster, especially for regular JPEG gallery files.

**Deployment/testing implication**
- A normal repo push is enough to test the client-side upload-header removal and import-speed optimization on `app.sporely.no`.
- The worker CORS hardening still requires a manual worker deploy to become live.
- So if the next test round improves but is not fully fixed, compare:
  - frontend-only deploy result
  - frontend + manual worker deploy result

**Current code-level stabilization already in place before this strategy**
- Queue sync is now retry-safe: a retried queue item reuses the previously inserted remote observation ID instead of creating duplicate cloud rows.
- Completed image indexes are persisted per queued item, so partial upload progress can resume instead of starting over from image 0 each time.
- Finds now prefers a local queued preview URL for pending observations, so queued cards should show a real local thumbnail instead of only a mushroom placeholder when the queued blob is available.

## Documentation and Landing Page (VitePress)
*Goal: Convert the existing `sporely-landing` static site into a VitePress project that directly serves the Markdown documentation from `sporely-py/docs` alongside the app feature highlights.*

### Status: Planning

**Tasks:**
- [ ] Initialize VitePress in `sporely-landing`
- [ ] Recreate current `index.html` highlights on the VitePress homepage
- [ ] Configure VitePress to source Markdown files from `../sporely-py/docs/`
- [ ] Update build and deployment scripts for `sporely.no` to use VitePress


## New Priority: AI Crop Workflow Shared Between Web, Supabase, and Desktop
*Goal: add a browser-native "AI crop" flow for Artsorakel that works for both camera captures and imported photos, while staying compatible with the existing `sporely-py` crop model.*

### Status: AI Crop Workflow — largely complete

**Completed:**
- [x] Shared crop data model (`ai_crop_x1/y1/x2/y2`, `ai_crop_source_w/h`) on `observation_images` — matches `sporely-py` schema
- [x] Supabase migration applied (`sporely-py/database/supabase_observation_images_ai_crop.sql`)
- [x] `src/image_crop.js` — reusable crop math, normalization, default rect, blob export
- [x] `src/ai-crop-editor.js` — full-screen pan/pinch-zoom crop editor (pan, pinch, reset, prev/next)
- [x] Import review editor — per-image AI crop in `import_review.js`, pre-seeded default on import
- [x] Camera review editor — crop editing wired in `review.js`
- [x] Artsorakel integration — `runArtsorakelForBlobs()` accepts `{blob, cropRect}`, crops client-side before AI request
- [x] Observation detail crop editor — clicking a gallery image on your own observation opens the crop editor; `updateObservationImageCrop` persists changes immediately; non-owners get photo viewer
- [x] `insertObservationImage` saves crop columns; `updateObservationImageCrop` updates them post-save
- [x] Sync queue handles crop metadata for background uploads

**Remaining:**
- [ ] **Cross-platform QA** — verify the same image’s crop survives web edit → desktop pull and desktop edit → cloud/web round-trip

## Active Tasks (TODO) - Infrastructure, Sync & R2 Migration
- [x] **Setup R2 Bucket** — `sporely-media` is configured in Cloudflare.
- [x] **Public Media Reads** — Web galleries now prefer `https://media.sporely.no` and fall back to signed legacy Supabase URLs when needed.
- [x] **Worker for Uploads Implemented** — Authenticated Worker code now exists in-repo for JWT-validated R2 uploads.
- [x] **Web Upload Path Prepared** — The web app can use the Worker for uploads when `VITE_MEDIA_UPLOAD_BASE_URL` is configured.
- [x] **Database Schema Update Authored** — `sporely-py/database/supabase_r2_media_migration.sql` adds `image_key` and `thumb_key` plus backfills from existing image rows.
- [x] **Domain Roles Clarified** — `media.sporely.no` is the public read domain for gallery/media delivery, while the Worker endpoint handles authenticated writes. A temporary `workers.dev` URL is acceptable until `upload.sporely.no` is routed.
- [x] **Deploy Worker for Uploads** — Worker is deployed with the R2 bucket bound and a live `upload.sporely.no` route.
- [x] **Run Live Schema Migration** — R2 migration SQL has been applied in Supabase.
- [x] **Run Unique Constraints SQL** — Unique-constraint SQL is already marked applied in the current cloud setup docs.
- [x] **Move Web Deletes to R2** — Worker DELETE route deployed; `deleteObservationMedia` uses Worker for R2 deletion.
- [x] **Offline queue** — Capture/import saves already enqueue observations and blobs in IndexedDB and retry background sync later.
- [ ] **Supabase Heartbeat** — Configure GitHub Action to ping DB every 4 days to prevent 1-week auto-pause.
- [x] **Bundle trimming** — Map screen is lazy-loaded so `leaflet` is no longer on the initial startup path.
- [x] **Friends feed** — Query `observations_friend_view`, paginate, and render list.

## Shared Sync Notes
- [x] **Desktop conflict noise reduced** — desktop sync now ignores order-only image changes and low-signal local media-signature churn when deciding whether web/cloud edits need review.
- [x] **Startup cloud scan reduced** — desktop sync now prefilters cloud observations using cached local links and a short timestamp grace window so same-sync server timestamp lag does not make every observation look newly changed on restart.
- [ ] **Optional server-side change summary** — a future Supabase RPC/view could return one per-observation “meaningful cloud change” summary and remove most remaining client-side deep comparison work.

## Phase 2: Web-Native Analysis & Community Data
*Goal: Replicate core analysis insights in a responsive browser environment.*

### A. Data Visualization (The Analysis Tab)
- [ ] **Responsive Plotting Engine** — Integrate **Plotly.js** for L × W scatter plots and Q-value histograms.
- [ ] **Device-Specific Layouts** — Use CSS breakpoints to toggle between Mobile (Field/Gallery) and Desktop (Analysis) views.
- [ ] **Sync with Measurements** — Fetch raw measurement data from Supabase to populate Plotly charts.

### C. Community Data Aggregation
- [ ] **Public Dataset Explorer** — Build search interface for public measurements using existing Supabase RPCs.
- [ ] **Taxon Summaries** — Display aggregated statistics (min/max/mean/n) from all public-facing data.
- [ ] **Privacy Validation** — Audit RLS policies to ensure only "public" measurements are visible in aggregates.

### D. Reference Sources & Taxonomic Stats
- [ ] **Reference Entry System** — UI for entering reference sources (min/max values, Parmasto-type stats) into metadata.
- [ ] **Literature Overlays** — Overlay reference bounding boxes on user plots for immediate ID comparison.

### E. Performance & QC Optimization (R2 & Free Tier Focus)
- [x] **Local Image Processing** — The web app already creates thumbnail variants locally before upload.
- [ ] **Outlier Verification UI** — Link Plotly click events to the R2-hosted thumbnails for instant QC.
- [x] **Zero-Egress Gallery** — Gallery reads now prefer Cloudflare R2 via `media.sporely.no`.

## Long-Term Goals (Phase 3)
- [ ] **In-Browser Measurement** — Replicate manual spore clicking and calibration using HTML5 Canvas.
- [ ] **Cross-Platform Math Consistency** — Investigate **Pyodide** (WebAssembly) to run Python/Numpy logic in-browser.
- [ ] **Import Flow Memory Architecture** — Refactor `import_review.js` and `import-store.js` to a streaming architecture. Currently, large imports (40+ photos) can exhaust mobile browser memory and crash the app because all full-resolution JPEGs are decoded and held in RAM simultaneously before being written to IndexedDB. The fix requires:
    - Streaming each processed blob directly to IndexedDB in `_processFile` and releasing it from RAM.
    - Keeping only lightweight metadata and downscaled `aiBlob` URLs in the active memory array (`sourceItems`).
    - Avoiding the massive memory spike caused by `Promise.all(files.map(f => f.arrayBuffer()))` in `import-store.js`.
    - *Note on Platforms (PWA vs APK):* This bottleneck is most severe for iPhone users running the app as a PWA (Safari), where per-tab memory limits are very strict (crashing often around 150-300MB). Android users on the native Capacitor APK have a higher WebView memory ceiling (often 500MB+ on modern devices like the S25) and benefit from native HEIC-to-JPEG conversion, but they will still eventually crash on huge imports until this streaming fix is implemented.

## Phase 4: Image Sync & Monetization
*Goal: Implement tiered storage, client-side compression, and a Pro subscription model.*

### 1. Image Processing & Compression (Client-Side)
- [ ] **Define Global Constants:**
    - Set `MAX_DIMENSION = 1200`
    - Set `JPEG_QUALITY = 0.6` 
    - Target file size: < 500KB per image.
- [ ] **Develop Browser Compression Utility:**
    - Create a JavaScript/TypeScript module using the **Canvas API**.
    - Implement a `processImage()` function to downscale and compress before upload.
- [ ] **Platform-Specific Logic:**
    - **Web/Free:** Force downscale to 1200px max width/height.
    - **Capacitor/Android:**
        - Check `is_pro` status via RevenueCat.
        - Allow "Original" upload if Pro.
        - Default to forced downscale for free users.
- [ ] **Metadata Preservation:**
    - Extract GPS and timestamp EXIF data *before* compression.
    - Re-inject or store metadata in the database to ensure "Digital Lab Notebook" integrity.

### 2. Storage Architecture & Guardrails
- [ ] **Tiered Cloudflare R2 Buckets:**
    - `sporely-public-2mp`: Optimized for community browsing and free tier.
    - `sporely-archive-pro`: Secure storage for full-resolution research data.
- [ ] **Server-Side Validation (Cloudflare Workers):**
    - Implement a "Gatekeeper" Worker to verify `Content-Length` headers.
    - Configure the worker to reject any upload to the public bucket exceeding 500KB.

### 3. Monetization & In-App Purchases (IAP)
- [ ] **RevenueCat Integration:**
    - Initialize RevenueCat SDK in the Capacitor wrapper (Android/iOS).
    - Configure the "Pro" Entitlement: `full_res_storage`.
    - *Note on Debug Settings:* The app includes a hidden debug toggle with "Server", "Free", and "Pro" options. "Server" is not a tier—it means "use the real plan fetched from the Supabase database." The "Free" and "Pro" options are local overrides for testing upload policies without changing the actual database row.
- [ ] **Subscription UI:**
    - Create a "Cloud Sync" settings page showing current storage usage.
    - Implement a Paywall UI comparing:
        - **Free:** 1200px images, community access.
        - **Pro:** Full-size original backups, high-res research export.
- [ ] **Backend Entitlement Sync:**
    - Set up a webhook listener to update the user's `is_pro` flag in the database when a purchase is confirmed.



### 5. Transparency & Open Source
- [ ] **UI Disclaimers:**
    - Add clear messaging: "Web uploads are limited to 1200px to keep hosting free. Use the mobile app for full-res backups."
- [ ] **Documentation:**
    - Update `README.md` to explain the division between the open-source client code and the paid cloud storage hosting.

## Ongoing Database & Operations Tasks
- Ensure `delete-account` Edge Function is deployed and functional.
- Validate RLS policies continuously as new features are added.

## User Testing & QA Checklist
*A list of manual checks to verify recently implemented features.*

### 1. AI Crop Workflow & Gallery Overlays
- **Importing:** Import a photo. Verify that a default AI crop is pre-seeded and that clicking the crop button allows you to pan/zoom.
- **Artsorakel:** Run Artsorakel on a cropped image and ensure it correctly analyzes the cropped region.
- **Detail Gallery Overlays:** Open one of your own observations in the Find Detail screen.
  - Verify that a square "AI crop" button appears in the bottom-left of field images (but not microscope images).
  - Verify that a "Trashcan" button appears in the top-right.
  - Click the "AI crop" button to ensure the full-screen crop editor opens.
  - Click the image itself (not the buttons) to ensure the fullscreen swipeable photo viewer opens.
  - Click the "Trashcan" button, verify the translated confirmation dialog appears ("Delete this image?"), and confirm it deletes the image from the gallery and cloud.
- **Cross-Platform:** Edit a crop on the web, then sync the Sporely desktop app to verify the crop metadata transfers correctly.

### 2. Friends Feed
- Navigate to the **Finds** screen and select the **Friends** tab.
- Verify that a list of your friends' observations appears.
- Verify that the feed is correctly sorted chronologically (newest first).

### 3. Memory & Import Limits (Device Testing)
- **Android APK (e.g., S25):** Import ~40 photos at once. Verify that the import succeeds without crashing and that the review thumbnails do not render as "broken image" icons (thanks to the recent `aiBlob` memory fix).
- **iOS PWA (Safari):** Be aware that importing more than 15-20 high-res photos at once may crash the tab due to strict WebKit memory limits. This is expected behavior until the Phase 3 streaming architecture is implemented.

### 4. Cloud Plan Debug UI
- Go to Settings and tap the app version number 5 times to reveal the debug menu.
- Verify the options are "Server", "Free", and "Pro".
- Ensure "Server" correctly fetches the real plan from the database rather than forcing a local override.
