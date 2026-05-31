# Sporely Web — History & Debugging Notes

## Purpose

`HISTORY.md` keeps completed implementation notes, debugging history, gotchas, and archived plans.

It should not be used as the current task plan. Current tasks belong in `PLAN.md`.

## Planning History

### 2026-05-30 — Android release distribution updated

- `PLAN.md` no longer tracks F-Droid distribution branches.
- The supported Android release path is GitHub Releases APK distribution, with Google Play still pending as the separate store release track.
- The signed Android artifact workflow is already in place in `.github/workflows/release-android.yml` and publishes the APK to GitHub Releases.

### 2026-05-19 — PLAN.md cleanup and recovered-file triage

- `PLAN.md` was recovered after an agent damaged it.
- The recovered file still mixed active tasks, dated debug logs, completed implementation notes, and long agent prompt material.
- Cleanup rule:
  - keep active tasks in `PLAN.md`
  - keep completed/debugging/history material here
  - move stable status tables to separate docs
  - delete obsolete prompt text unless it is intentionally archived
- The image pipeline refactor remains conservative because the app currently works.
- Phase 1 added:
  - `docs/image-pipeline-phase1.md`
  - opt-in image-pipeline debug logging
- The next intended image pipeline step is helper extraction only:
  - shared `isBlob`
  - neutral coordinate helper
  - default draft factory
  - simple image shape comments/JSDoc
- Explicitly not next:
  - no `image-intake.js`
  - no full intake rewrite
  - no streaming import architecture yet
  - no EXIF-worker migration yet

### 2026-05-19 — Image Pipeline Refactor Archive

- Moved the long image-pipeline refactor plan out of `PLAN.md` so the plan can stay focused on active backlog items.
- Scope stayed `sporely-web` only.
- Phase 1 completed as a documentation/debug-only pass: regression checklist, current-flow notes, and opt-in image-pipeline debug logging behind `sporely-debug-image-pipeline`.
- Phase 2 should stay small and low-risk: shared `isBlob`, neutral coordinate helper, default draft factory, and small shape comments or JSDoc.
- The refactor order remains: shared helpers first, canonical image shapes, remove duplicated import/review processing, source-of-truth cleanup, memory cleanup, then revisit IndexedDB streaming, `images.js` splitting, queue/database consistency, and worker metadata extraction.
- Deferred until later: streaming every processed image directly to IndexedDB, moving EXIF extraction into `image-worker.js`, and removing schema fallbacks too early.
- If memory or object URL issues surface, address cleanup before any intake rewrite.

### 2026-05-19 — Active Plan Cleanup

- `PLAN.md` now holds only the active backlog and links back here for archived planning context.


## Upload Request Gotchas
- **iOS Safari Fetch Hangs:** Never stream an IndexedDB-backed `Blob` directly into a `fetch()` body on iOS/WebKit. Convert it to an `ArrayBuffer` first (`await blob.arrayBuffer()`) before passing it to `fetch`, otherwise the upload may silently hang or send 0 bytes.
- **IndexedDB Transaction Auto-Close:** IndexedDB `readwrite` transactions will silently auto-close if the thread `await`s slow asynchronous work (like Canvas rendering or encoding) while the transaction is open. Always complete heavy async operations *before* opening the IndexedDB transaction.
- **OOM in Background Sync:** Heavy Canvas rendering must *never* happen in a background sync loop (`triggerSync()`). It will trigger silent Out-Of-Memory (OOM) crashes on mobile WebViews. Image processing must happen in the foreground during the initial save/enqueue phase.
- **Cross-Context Blob Checks:** Never use strict `instanceof Blob` checks across environments (e.g. Capacitor FilePicker vs IndexedDB). They often fail. Use duck-typing checks on the `size` and `type` properties.
- **CORS Preflight on PUT:** Avoid adding custom non-standard headers (like `X-Sporely-Upload-Mode`) to the R2 upload `PUT` request. Custom headers force strict CORS preflight (`OPTIONS`) behavior on mobile PWAs, which can unexpectedly block uploads depending on network/cache conditions.

## Deployment Gotchas
- **Worker Deployment:** The Cloudflare worker is NOT automatically deployed when committing. If you add a new route and forget to run `wrangler deploy`, the old version keeps running in production. Symptom: routes that exist in source return 404 in production.
- **Worker Secret:** The upload worker requires the Cloudflare secret `SUPABASE_SERVICE_ROLE_KEY` to update storage quotas by bypassing RLS. This must never be committed to source control or exposed to the frontend.

## Import Flow & Android Notes
- **Android HEIC/HEIF Import:** Must go through the custom `NativePhotoPicker` bridge, not directly through Capawesome `FilePicker.pickImages()`. The custom plugin decodes HEIC/HEIF with Android bitmap APIs, writes a temporary JPEG in app cache, and returns native EXIF/GPS metadata separately.
- **Photo Picker URIs:** The native bridge uses `ACTION_OPEN_DOCUMENT`, not Android 13+ `MediaStore.ACTION_PICK_IMAGES`, because Photo Picker URIs can expose redacted GPS metadata such as `0,0`. JS still asks Capawesome FilePicker for `accessMediaLocation` so Android can open `MediaStore.setRequireOriginal(uri)`.
- **WebView limitations:** Sending an HEIC blob directly into the WebView can produce a blank review image because Android WebView cannot reliably decode HEIC object URLs.
- **Web PWA EXIF Stripping:** Android Chrome strips EXIF metadata (including GPS) for privacy on standard `<input type="file" accept="image/*">`. To preserve GPS on imported JPEGs, the app routes Android browser users to a specific file picker (`import-browse-input` with explicit file extensions) that bypasses the privacy scrub.
- **Samsung S25 Verification:** Confirmed that `ACTION_OPEN_DOCUMENT` preserves GPS for test HEIC files. The UX tradeoff is that Android shows the document picker; users may need to choose "Images".
- **Missing GPS EXIF:** If a JPEG truly has no GPS EXIF tags, treat `0,0` as missing GPS, never as a real location. The app should show no coordinates instead of falling back to stale or current-device GPS.
- **HEIC Tradeoff (Fast visual, delayed metadata):** The fastest single-HEIC path splits visual import from metadata hydration: converts enough to show the image, extracts EXIF/GPS in the background, updates the UI when GPS arrives, and waits for metadata if the user saves early.


### 2026-04-18 — Current Working Notes

**Important deployment note**
- `app.sporely.no` auto-updates from GitHub pushes and usually shows the new Pages build within about 1 minute.
- The Cloudflare Worker at `upload.sporely.no` does **not** auto-deploy with repo pushes; worker changes still require manual deployment.
- This matters because several current symptoms look like: observation row inserted successfully, but media upload / image row / queue cleanup fails afterward.
 vcm
### 2026-05-16 — Supabase Migration Repair Note

- `20260516165528_add_observation_identifications.sql` was partially applied to the remote database, then failed when Supabase tried to insert the same version into `supabase_migrations.schema_migrations`.
- The fix is to repair the migration history, not to relax the schema: keep `observation_identifications.observation_id` as `bigint` so it matches `observations.id`.
- Recovery command sequence:
  - `supabase login --token ...`
  - `supabase migration repair --status applied 20260516165528`
  - `supabase db push`
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

### 2026-04-22 — HEIC, GPS, and Blob Validation Fixes

**What was reported**
- Image import from HEIC: no image, no GPS.
- Image import from JPG file: image imports, no GPS.
- From camera (demo mode): no image, no GPS.

**Root causes and fixes**
- **Fragile `instanceof Blob` checks:** Cross-context objects (like native files from Capacitor or IndexedDB records) often fail strict `instanceof Blob` checks on mobile WebViews and Safari. This caused valid images to be stripped silently from queues.
  - *Fix:* Replaced all strict checks with a robust `_isBlob` duck-type helper (checking for `size` and `type` properties) across `sync-queue.js`, `review.js`, `import_review.js`, `images.js`, and `artsorakel.js`.
- **HEIC Web Uploads Crashing:** Browsers cannot natively decode HEIC into an `<img>` tag to draw to a Canvas. The `_prepareUploadBlob` function was throwing an error, completely aborting the sync.
  - *Fix:* Wrapped the image decode in a `try/catch`. If decode fails, it gracefully falls back to uploading the raw original HEIC file with `upload_mode: 'original'`.
- **IndexedDB GPS Persistence:** Multi-photo import sessions persisted to IndexedDB but forgot to save `gpsLat`, `gpsLon`, `gpsAltitude`, and `gpsAccuracy`. Resuming an import session wiped the GPS.
  - *Fix:* Added the missing GPS fields to `import-store.js` serialization.
- **Demo Mode Camera:** The local web-only demo camera was pushing a `null` blob, which the new robust checks rightfully rejected, resulting in 0-image uploads.
  - *Fix:* Generated a real canvas blob with a mushroom emoji for demo mode captures.

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

### 2026-04-23 — Schema and CORS Blockers Fixed

**What was reported**
- Android web app stuck on "Finalizing upload..." and retrying.
- iPhone web app stuck on "Queued for upload".
- Upload works perfectly from the Android APK.
- Missing EXIF GPS on Samsung Android web app when importing JPEGs.

**Root causes and fixes**
- **Schema Mismatch:** The newly introduced `ai_crop_*`, `upload_mode`, and dimension tracking columns were missing from the production Supabase `observation_images` table, causing silent inserts to fail and trap queue items in endless retry loops.
- **Web CORS / Env Mismatch:** The web frontend `app.sporely.no` was missing `VITE_MEDIA_UPLOAD_BASE_URL` pointing to the proper Cloudflare Worker custom domain, causing silent preflight/fetch failures that never showed up in `wrangler tail`.
- **Android Web GPS Stripping:** Android Chrome strips EXIF metadata (including GPS) for privacy when a web app invokes the camera roll via standard `<input type="file" accept="image/*">`. Fixed by routing Android web user agents to use the specific `import-browse-input` (`accept=".jpg,.jpeg,..."`), which forces the file browser and preserves original metadata.
- **UI Fix:** Added "Close" and "Import" buttons to the camera capture overlay.
