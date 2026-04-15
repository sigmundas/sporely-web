# Sporely-web Development Plan

## Bugs
- I can't delete observations from app.sporely.no. Deleting from the installed apk app works. Error: "Delete failed: failed to fetch"

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
