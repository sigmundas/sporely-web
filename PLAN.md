# Sporely-web Development Plan

## Bugs
- I can't delete observations from app.sporely.no. Deleting from the installed apk app works. Error: "Delete failed: failed to fetch"
- Android HEIC import location regression was traced to metadata/display handling, not only conversion:
  EXIF GPS must be extracted before Canvas/native conversion, altitude must travel with the import
  session, and reverse-geocode results need a latest-request guard so an old place name cannot fill
  the Location field for a new photo.
- Follow-up: Android Photo Picker URIs can return redacted GPS as `0,0`. The APK import bridge now
  uses `ACTION_OPEN_DOCUMENT` and rejects `0,0` coordinates instead of reverse-geocoding them.
- Device test confirmed HEIC GPS works again in the Android APK. Tradeoff: Android now shows the
  document picker, often starting in "Recent"; users may need the side menu → Images for the full
  library. Consider adding a future two-choice import UI: "Gallery" for friendlier browsing and
  "Metadata-safe import" for geotagged originals.
- Test JPG `20260418_154138.jpg` has Samsung/time EXIF but no GPS tags according to `exifr`; no
  app fix is expected for that file unless we intentionally fall back to current device location.
- Web "ID Needed" was aligned with the desktop model: it is now "Uncertain ID", backed by the
  existing `uncertain` flag, displayed with a `?` prefix, and filterable from Finds.

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

### 2026-04-18 — Agent Code Analysis & Proposed Fixes

**1. Reliable UI Deduplication (`src/screens/finds.js`) - ✅ FIXED**
**Problem:** The UI dedupe logic (`_observationsLikelySame`) attempts to fuzzy-match queued vs. synced observations by comparing timestamps, locations, and notes. It currently ignores `_remoteObservationId`. If Supabase alters any field slightly (e.g., truncating timestamps or floating point changes on GPS), the fuzzy match fails, causing the UI to display a duplicate (one queued, one cloud).
**Solution Applied:** Added a direct check to the top of `_observationsLikelySame` that bypasses fuzzy matching if `queuedObs._remoteObservationId` matches `syncedObs.id`.

**2. Heavy Image Processing Crashing the Background Sync (`src/images.js`) - ✅ FIXED**
**Problem:** `triggerSync()` loops over queued images and calls `uploadObservationImageVariants()`. This function invokes `_prepareUploadBlob()`, which loads the original high-res image from IndexedDB into an HTMLCanvas, resizes it, and encodes it to a new JPEG blob. Doing heavy Canvas rendering in a background sync loop—especially on mobile WebViews or iOS Safari PWAs—is very likely to cause an Out-Of-Memory (OOM) silent crash or be killed by the OS. When it crashes, the item stays in the queue and `triggerSync()` will repeatedly crash on it.
**Solution Applied:** Refactored `uploadObservationImageVariants` in `src/images.js` into `prepareImageVariants` and `uploadPreparedObservationImageVariants`. Updated `src/sync-queue.js` to run `prepareImageVariants` inside `enqueueObservation`, keeping heavy canvas workloads in the foreground where they belong. The background worker now only handles network requests, preventing OOM loops.

**3. iOS Safari IndexedDB Blob Fetch Bug (`src/images.js`) - ✅ FIXED**
**Problem:** `_uploadViaWorker` directly passes the `Blob` from IndexedDB to the `fetch` body. iOS WebKit has known issues where streaming Blobs directly from IndexedDB to `fetch` can silently hang or send 0 bytes.
**Solution Applied:** Converted the `Blob` to an `ArrayBuffer` via `await blob.arrayBuffer()` before passing it into the `fetch` body inside `_uploadViaWorker`.

**4. Slow "Converting 1 of 1..." on Android Import**
**Problem:** As per previous logs, imported-photo preprocessing was changed to keep the original file for upload and only generate the AI blob eagerly. However, because the main `uploadBlob` is now generated later (in the sync loop), the app is potentially decoding the full 12MP+ JPEG multiple times. If "Converting" is slow, the eager AI blob generation might still be blocking the main thread synchronously. 

### 2026-04-18 — Versioned Change Log With Actual Code

#### v0.2.14 — Changes already present when this pass started

**A. Dedup queued row vs cloud row by real remote observation id**
- File: `src/screens/finds.js`
- Actual code:
```js
function _observationsLikelySame(queuedObs, syncedObs) {
  if (!queuedObs || !syncedObs) return false
  if (queuedObs._remoteObservationId && String(queuedObs._remoteObservationId) === String(syncedObs.id)) return true
  ...
}
```
- Why this matters:
  - Once the queued item has a real `remoteObservationId`, the UI can stop relying only on fuzzy timestamp/location matching.
  - This avoids the loop where one local queued card and one cloud row both show up for the same observation.

**B. Move heavy image preparation out of background sync and into enqueue time**
- File: `src/sync-queue.js`
- Actual code:
```js
const prepared = await prepareImageVariants(image.blob, uploadPolicy)
preparedImages.push({
  ...image,
  uploadBlob: prepared.uploadBlob,
  uploadMeta: prepared.uploadMeta,
  variants: prepared.variants,
})
...
store.add({
  obsPayload,
  imageEntries: preparedImages,
  userId: obsPayload.user_id,
  ts: Date.now()
})
```
- Why this matters:
  - The heavy Canvas resize/encode work happens while the user is actively saving, not later in a fragile background sync loop.
  - The queued payload now already contains `uploadBlob`, `uploadMeta`, and thumbnail variants, so retries are lighter.

**C. Avoid iOS/WebKit blob-streaming fetch hangs by sending an ArrayBuffer**
- File: `src/images.js`
- Actual code:
```js
const arrayBuffer = await blob.arrayBuffer()

const response = await fetch(`${MEDIA_UPLOAD_BASE_URL}/upload/${_encodeObjectKey(normalizedPath)}`, {
  method: 'PUT',
  headers,
  body: arrayBuffer,
})
```
- Why this matters:
  - Directly streaming an IndexedDB-backed `Blob` into `fetch()` is a known weak point on iOS/WebKit.
  - Converting to `ArrayBuffer` makes the upload request body more deterministic across Safari/PWA/WebView.

**D. Remove custom upload headers from worker PUT requests**
- File: `src/images.js`
- Actual code:
```js
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': blob?.type || 'image/jpeg',
  'Cache-Control': 'public, max-age=31536000, immutable',
}
```
- Previous headers removed:
```js
X-Sporely-Upload-Mode
X-Sporely-Cloud-Plan
X-Sporely-Upload-Origin
```
- Why this matters:
  - Those headers were not used by the worker upload handler, but they could still force stricter CORS preflight behavior on mobile PWAs.

#### v0.2.15 — Remote Reconcile + Upload Complete Feedback

**What was added**

**1. Remote reconciliation before deciding a queue item is still pending**
- File: `src/sync-queue.js`
- Actual code:
```js
const remoteState = await _fetchRemoteObservationState(obsId)
remoteState.completedIndexes.forEach(index => completedImageIndexes.add(index))
if (completedImageIndexes.size >= queuedImages.length) {
  await _finalizeSyncedQueueItem(item, obsId, queuedImages, 'remote-reconcile')
  continue
}
```
- Why this matters:
  - If the local queue state is stale but Supabase already has the observation and its image rows, the app now heals itself instead of leaving the card stuck forever.
  - This directly targets the “cloud row exists, queue card still visible” symptom.

**2. Explicit remote confirmation before deleting the local queue item**
- File: `src/sync-queue.js`
- Actual code:
```js
async function _finalizeSyncedQueueItem(item, obsId, queuedImages, reason = 'local') {
  const expectedImageCount = queuedImages.length
  const remoteState = await _fetchRemoteObservationState(obsId)
  const confirmed = remoteState.observationExists
    && remoteState.completedIndexes.length >= expectedImageCount

  if (!confirmed) {
    throw new Error(`Sync confirmation incomplete for observation ${obsId}`)
  }

  await _deleteQueueItem(item.id)
  notifyQueueChanged()
  notifySyncSuccess({
    observationId: obsId,
    imageCount: expectedImageCount,
    reason,
  })
}
```
- Why this matters:
  - The queue now disappears only after the observation row exists and enough `observation_images` rows exist remotely.
  - This is the first pass that gives a hard “complete” boundary instead of assuming success from local progress alone.

**3. Stage tracking inside the queue item itself**
- File: `src/sync-queue.js`
- Actual code:
```js
await _setQueueSyncStatus(item.id, 'saving-observation', {
  syncImageCount: queuedImages.length,
})
...
await _setQueueSyncStatus(item.id, 'uploading-image', {
  syncImageIndex: i + 1,
  syncImageCount: queuedImages.length,
})
...
await _setQueueSyncStatus(item.id, 'retrying', {
  syncErrorMessage: String(err?.message || err || 'Upload failed'),
})
```
- Why this matters:
  - The queue item now carries concrete state like `saving-observation`, `uploading-image`, `finalizing`, and `retrying`.
  - This is exposed back to the Finds screen instead of every pending item just saying `Queued for upload`.

**4. User-visible status text in Finds**
- File: `src/screens/finds.js`
- Actual code:
```js
function _pendingStatusText(obs) {
  switch (obs._syncStage) {
    case 'saving-observation':
    case 'reconciling':
    case 'finalizing':
      return t('finds.pendingFinalizing')
    case 'uploading-image':
      return total > 0
        ? t('finds.pendingUploading', { current: Math.min(current, total), total })
        : t('finds.pendingUpload')
    case 'retrying':
      return t('finds.pendingRetrying')
    default:
      return t('finds.pendingUpload')
  }
}
```
- Why this matters:
  - Instead of a static pending label, the card can now tell you whether it is uploading image `1/3`, finalizing, or retrying.

**5. Global “upload complete” feedback**
- File: `src/main.js`
- Actual code:
```js
window.addEventListener(SYNC_SUCCESS_EVENT, event => {
  const imageCount = Number(event?.detail?.imageCount || 0)
  showToast(t('review.uploadedComplete', { count: imageCount }))

  if (state.currentScreen === 'finds') void loadFinds()
  if (state.currentScreen === 'home') void refreshHome()
})
```
- Why this matters:
  - The app now gives an explicit success toast only after the queue item has been remotely confirmed and removed.
  - It also refreshes Finds/Home immediately so the UI has a chance to pick up the finished state.

**Tests to run on `v0.2.15`**

1. Android web app, take photo:
   - Tap save.
   - Confirm the queued card shows a real stage label like `Uploading photo 1 of 1…` or `Finalizing upload…`, not just `Queued for upload`.
   - Wait without leaving Finds.
   - Confirm the queued card disappears on its own.
   - Confirm you get the success toast after it disappears.
   - Confirm the resulting cloud observation shows a thumbnail, not a mushroom emoji.

2. Android web app, import from library:
   - Save one imported photo.
   - Confirm the card shows stage text and eventually disappears.
   - Confirm the cloud observation includes the image.

3. iPhone web app, take photo:
   - Save one observation.
   - Stay on Finds.
   - Confirm the queued card eventually disappears and the success toast appears.
   - Confirm the cloud observation has the image.

4. Cross-device verification:
   - Upload from Android.
   - Open the same account on iPhone.
   - Confirm only one observation exists and it has a real image.

5. Failure-state verification:
   - If a queue card still gets stuck, note the exact text shown on the card:
     - `Uploading photo X of Y…`
     - `Finalizing upload…`
     - `Retrying upload…`
   - That text now tells us which stage is failing, which should prevent the next debugging pass from looping blindly.

#### v0.2.16 — Post-device-test hotfix: IndexedDB transaction lifetime

**User-reported results on `app.sporely.no` before this hotfix**
- Android web app, import from file:
  - Save failed immediately.
  - The review screen stayed open instead of navigating away.
  - The toast text ran off-screen, but the visible fragment included:
  - `"ervation: Failed to execute 'add' on 'IDBObjectStore': The trans"`
- Android web app, take photo:
  - Same error and same behavior.
- iPhone web app:
  - Same error and same behavior.

**Root cause found**
- File: `src/sync-queue.js`
- The queue code opened an IndexedDB write transaction too early:
```js
const db = await openDB()
const tx = db.transaction(STORE_NAME, 'readwrite')
const store = tx.objectStore(STORE_NAME)

let uploadPolicy = _cloudPlanCache.get(obsPayload.user_id)
if (!uploadPolicy) {
  uploadPolicy = await fetchCloudPlanProfile(obsPayload.user_id)
}

for (const image of queuedImages) {
  const prepared = await prepareImageVariants(image.blob, uploadPolicy)
  ...
}

store.add({ ... })
```
- Why this broke:
  - IndexedDB transactions are short-lived.
  - On Android Chrome and iOS Safari/WebKit, a readwrite transaction can auto-close while the code is awaiting async work.
  - By the time `store.add(...)` ran, the transaction was already inactive, which matches the mobile error you saw.

**Fix applied**
- File: `src/sync-queue.js`
- Actual code now:
```js
const queuedImages = _normalizeQueuedImages(imageEntries)
...
for (const image of queuedImages) {
  const prepared = await prepareImageVariants(image.blob, uploadPolicy)
  ...
}

const db = await openDB()
const queueItem = {
  obsPayload,
  imageEntries: preparedImages,
  userId: obsPayload.user_id,
  ts: Date.now(),
}

return new Promise((resolve, reject) => {
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  const req = store.add(queueItem)

  req.onerror = () => reject(req.error || tx.error)
  tx.oncomplete = () => {
    notifyQueueChanged()
    triggerSync()
    resolve()
  }
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error || new Error('Queue write aborted'))
})
```
- Why this should help:
  - All slow async work now happens before the IndexedDB write transaction is opened.
  - The transaction is used only for the actual `store.add(...)`, which is what mobile IndexedDB wants.

**Secondary UI fix**
- File: `src/style.css`
- Actual code now:
```css
#toast {
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: min(calc(100vw - 24px), 420px);
  box-sizing: border-box;
  text-align: center;
}
```
- Why this matters:
  - If another mobile-only error happens, the full message should now wrap instead of disappearing off the right edge.

**Tests to run after this hotfix**

1. Android web app, import one photo:
   - Tap save.
   - Confirm the review screen leaves successfully and opens Finds.
   - Confirm you see either `Uploading photo 1 of 1…` or `Finalizing upload…`, not the IndexedDB error.

2. Android web app, take one photo:
   - Tap save.
   - Confirm the same thing: no `IDBObjectStore.add` error, and the observation enters the queue normally.

3. iPhone web app, import one photo:
   - Tap save.
   - Confirm there is no `IDBObjectStore.add` error and the observation enters the queue.

4. iPhone web app, take one photo:
   - Tap save.
   - Confirm there is no `IDBObjectStore.add` error and the observation enters the queue.

5. If the save now succeeds but the observation still gets stuck later:
   - Report the exact pending text shown in Finds.
   - Examples:
     - `Uploading photo 1 of 1…`
     - `Finalizing upload…`
     - `Retrying upload…`
   - That will tell the next pass whether the remaining problem is queue write, upload, DB row insert, or final reconciliation.

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
- [x] **Profile storage tally + quota guardrails** — Worker updates `profiles.total_storage_bytes`, compatibility `storage_used_bytes`, and `image_count` after R2 upload/delete. Free-tier quota can be set per profile with `storage_quota_bytes` or globally with `FREE_STORAGE_QUOTA_BYTES`.
- [x] **Offline queue** — Capture/import saves already enqueue observations and blobs in IndexedDB and retry background sync later.
- [x] **Supabase Heartbeat** — GitHub Action pings Supabase every 4 days through `scripts/supabase-heartbeat.mjs` to prevent 1-week auto-pause.
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
- [x] **Free-tier reduced uploads:** Free accounts upload at 2 MP.
- [x] **Pro image-resolution setting:** Pro/full-res accounts can choose `Reduced (2MP)` or `Max (12MP)` in Settings.
- [x] **Friendly 12 MP cap:** Max mode keeps near-12 MP images as-is and only resizes from 14 MP and above down to 12 MP.
- [ ] **Metadata Preservation:**
    - Extract GPS and timestamp EXIF data *before* compression.
    - Re-inject or store metadata in the database to ensure "Digital Lab Notebook" integrity.

### 2. Storage Architecture & Guardrails
- [x] **Single R2 bucket with authenticated Worker:** `sporely-media` stores originals and generated thumbnails; `upload.sporely.no` enforces user-owned key prefixes.
- [x] **Server-side storage tally:** The Worker increments/decrements `profiles.total_storage_bytes`, compatibility `storage_used_bytes`, and `image_count` using `supabase/profile-storage-usage.sql`.
- [x] **Free-tier quota guardrail:** The Worker rejects free-tier uploads that exceed `profiles.storage_quota_bytes` or global `FREE_STORAGE_QUOTA_BYTES`.
- [ ] **Backfill historical usage:** Add an admin script to scan existing R2 objects and reconcile `total_storage_bytes` / `image_count` for users with pre-tally uploads.

### 3. Monetization & In-App Purchases (IAP)
- [ ] **RevenueCat Integration:**
    - Initialize RevenueCat SDK in the Capacitor wrapper (Android/iOS).
    - Configure the "Pro" entitlement and sync it into `profiles.cloud_plan = 'pro'` or `full_res_storage_enabled = true`.
- [ ] **Subscription UI:**
    - Account status now shows image resolution, sync history, storage usage, and image count.
    - Implement a Paywall UI comparing:
        - **Free:** 2 MP images, community access, quota-limited cloud storage.
        - **Pro:** selectable 2 MP or 12 MP backups, higher storage quota, high-res research export.
- [ ] **Backend Entitlement Sync:**
    - Set up a webhook listener to update the user's `cloud_plan` / `full_res_storage_enabled` fields when a purchase is confirmed.


### 4. App Distribution (Google Play Store)
*Goal: Release the native Android Capacitor wrapper to the Google Play Store.*
- [x] Configure standard package name (`com.sporelab.sporely`) in Capacitor and Android project.
- [ ] Create Android Keystore and configure release signing.
- [ ] Build App Bundle (`.aab`) and upload to Google Play Console.
- [ ] Prepare store listing, screenshots, and privacy policy.


### 5. Transparency & Open Source
- [ ] **UI Disclaimers:**
    - Add clear messaging around free 2 MP uploads, Pro 12 MP uploads, and account storage quota.
- [x] **Documentation:**
    - Update `README.md` to explain the division between the open-source client code and the paid cloud storage hosting.

## Phase 5: UGC Moderation & Play Store Compliance
*Goal: Implement required User Generated Content (UGC) moderation features to satisfy Google Play Store policies before APK release.*

### 1. Terms of Service & EULA
- [x] **Legal Document** — Write a EULA/Terms of Service explicitly defining objectionable content (no hate speech, illegal content, etc.).
- [x] **Publish** — Host the EULA on `sporely.no` (via VitePress/landing page).
- [x] **In-App Link** — Add an "Accept Terms" checkbox on the signup screen and a link to the EULA in App Settings / Profile.

### 2. User Blocking
- [x] **Schema Update** — Create a `user_blocks` table (`blocker_id`, `blocked_id`, `created_at`).
- [x] **View Filtering** — Update `observations_community_view` and `observations_friend_view` to omit records where the author is blocked by the current user (or vice versa). Apply same filtering to comment RPCs/queries.
- [x] **UI Implementation** — Add a "Block User" action to the `Profile` and `Find Detail` screens (e.g., via an overflow menu on observations and comments).
- [x] **Local Hiding** — Instantly remove the blocked user's content from the local UI (`state.finds` / comments) upon successful block.

### 3. Content Reporting
- [x] **Schema Update** — Create a `reports` table (`id`, `reporter_id`, `reported_user_id`, `observation_id`, `comment_id`, `reason`, `status`, `created_at`).
- [x] **UI Implementation** — Add a "Report" action to every public observation (Find Detail screen) and comment.
- [x] **Report Dialog** — Implement a UI dialog to choose a report reason (e.g., "Spam", "Inappropriate", "Offensive").
- [x] **Optimistic Hiding** — Once reported, immediately hide the reported content locally so the reporter no longer has to see it.

### 4. Admin Moderation
- [x] **Schema Update** — Add `is_banned` and `is_admin` boolean flags to `profiles`.
- [x] **Backend Enforcement** — Ensure database triggers and the Cloudflare R2 Worker block upload/write actions for users where `profiles.is_banned = true`.
- [x] **Content Hiding** — Update `observations_community_view` and `observations_friend_view` to hide past posts from banned users.
- [ ] **Moderation Dashboard** — V1: Utilize Supabase Studio as the backend dashboard to routinely review the `reports` table, delete offending `observations`/`comments`, and ban bad actors. V2: Build an in-app `/admin` view gated by `is_admin = true`.

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

### 4. Account Status, Storage, and Pro Upload QA
- Verify free accounts show `2MP`, storage usage, image count, and sync history in Profile → Account status.
- Verify Pro/full-res accounts show the Settings image-resolution selector with `Reduced (2MP)` and `Max (12MP)`.
- Upload and delete a test observation, then confirm `profiles.total_storage_bytes`, `storage_used_bytes`, and `image_count` move in the expected direction.
- Set a small `storage_quota_bytes` on a free test profile and confirm uploads over the quota are rejected by the worker.

### 5. UGC Moderation & Play Store Compliance
- **Terms of Service:** On the Auth screen, confirm the "Accept Terms" checkbox blocks sign-up if unchecked. Confirm the ToS link works there and in the Profile screen's Danger Zone.
- **User Blocking:** 
  - Find a public observation by another user and click "Block user".
  - Verify a success toast appears and that you are returned to the previous screen.
  - Verify that the blocked user's observations and comments no longer appear in your Home, Finds, or Comment lists.
- **Content Reporting:**
  - Find an observation by another user, click "Report post", enter a reason, and verify the success toast.
  - Find a comment by another user, click "Report", enter a reason, and verify the success toast.
  - Log into Supabase Studio and verify that both reports appear in the `reports` table.
- **Ban Enforcement (Write & Upload):**
  - In Supabase Studio, manually set `is_banned = true` on a test user's profile.
  - Log in as the test user. Try to save a new observation with an image. Verify the Cloudflare worker rejects the upload and/or the database trigger rejects the save. Try to leave a comment and verify the database trigger rejects it.
- **Ban Enforcement (Read/Hide):**
  - Log in as a normal user. Verify that all past observations from the banned test user are completely hidden from the Community and Friends feeds.
