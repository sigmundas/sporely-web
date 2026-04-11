# Sporely-web Development Plan

## Current Focus
Migrating media storage to Cloudflare R2 and consolidating cloud infrastructure.

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
- [ ] **Bundle trimming** — Lazy-load heavier import/map dependencies for small mobile JS chunks.
- [ ] **Friends feed** — Query `observations_friend_view`, paginate, and render list.

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

## Ongoing Database & Operations Tasks
- Ensure `delete-account` Edge Function is deployed and functional.
- Validate RLS policies continuously as new features are added.
