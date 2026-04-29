# Sporely-web Development Plan

## Native Android Camera Capture Flow
- [x] Step 1: Install `@capgo/camera-preview` and verify Android Manifest permissions (`CAMERA`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`).
- [x] Step 2: Add platform routing logic to detect Android and apply transparent CSS to the WebView.
- [x] Step 3: Initialize Android native camera (`toBack: true`) and bind to the primary 1x wide-angle lens.
- [x] Step 4: Implement native capture using `withExifLocation: true` and `storeToFile: true`, followed by proper cleanup (`stop()`).

### Camera Flicker Troubleshooting (Android 15 Edge-to-Edge)
**Failed Attempts:**
- JS `setTimeout` DOM reflow (only repaints HTML, fails to fix native `SurfaceView` compositing).
- *Lifecycle Clue:* Flicker persists at the bottom of the screen upon initial start, but disappears completely if the device screen is turned off and back on while the camera is active. This indicates the native Android `SurfaceView` or Window compositor is out of sync with the navigation bar insets until a full `onPause`/`onResume` lifecycle event forces a correct layout recalculation.
- Programmatic background/foreground toggle (requires physical home button press by user).
- *XML Opt-Out:* Added `<item name="android:windowOptOutEdgeToEdgeEnforcement">true</item>` to `styles.xml` (ignored by Android 15 / Capacitor 6+).
- *EdgeToEdge Plugin:* Calling `EdgeToEdge.enable()` stabilized the layout but didn't cure the flicker below the crop frame.
- *Removed CSS box-shadow:* Didn't fix the surface tearing.
- *toBack: false (Render ON TOP):* Abandoned. While it killed the transparency flicker, manually syncing CSS coordinates with native hardware coordinates across different Android pixel densities caused the camera to shift down and spawn black borders.

### Moving Back to Full-Screen Camera (Android 15 Bug Fixes)
We are going back to a full-screen background camera (`toBack: true`) with our UI floating on top.
- Step 1: Fullscreen Camera Initialization (`toBack: true`, `window.screen` width/height, `aspectMode: 'cover'`)
- Step 2: Absolute App Transparency (`--ion-background-color`, `html`, `body`, `ion-app`, `ion-content` transparent)
- Step 3: Removed all camera crop guides and overlays temporarily to completely isolate the camera view and focus on resolving the flicker.
- Step 4: Fix Samsung Lens Selection (programmatic selection using `CameraPreview.getAvailableDevices()` to bypass software restrictions).
- Step 5: Initialization Race Condition (Added a 500ms delay before `CameraPreview.start()` so Android 15 edge-to-edge layout settles).
- Step 6: Native Android Window UI Flags (Replaced deprecated flags with modern `WindowCompat.setDecorFitsSystemWindows(getWindow(), false)` to prevent Capacitor layout loops).
- Step 7: Disabled Capacitor's margin engine (`adjustMarginsForEdgeToEdge: 'disable'`) and shifted UI positioning natively to CSS using `env(safe-area-inset-bottom, 20px)`. **Result: Failed.** Layout is still unstable/flickering at the bottom until the screen is cycled off and on.
- Step 8: Reverted the native edge-to-edge layout workarounds in `MainActivity.java`, `capacitor.config.json`, and `styles.xml` to return to standard Capacitor layout management.

### Standard WebRTC Camera Recovery (Samsung Torch Heuristic)
Now that we are back on the standard `navigator.mediaDevices.getUserMedia()` flow (Capgo native camera moved to `camera-fallback` branch), we need to fix the Samsung S25 issue where it defaults to the ultra-wide lens. Since OEM string labels like 'camera 0' are useless, we built a 'torch heuristic' initialization function.

- [x] Calls `navigator.mediaDevices.enumerateDevices()` and filters for all videoinput devices that are rear-facing.
- [x] Loops through these specific device IDs one by one, opening a temporary video stream for each.
- [x] Inspects the active video track using `track.getCapabilities().torch`.
- [x] Also probes `ImageCapture.getPhotoCapabilities().fillLightMode` for flash support when `torch` is not exposed.
- [x] Saves the deviceId if torch/flash capability is true.
- [x] Stops all temporary video tracks to free up hardware memory.
- [x] Starts main application camera feed using that specific deviceId in the `getUserMedia` constraints.
- [x] Removed Capgo native CameraPreview code from main branch.

#### 2026-04-29 Samsung S25 Findings
**What did not work**
- The WebRTC torch heuristic was implemented, but device testing still showed the ultra-wide camera. This likely means Samsung/Chrome WebView is exposing a logical rear camera where the selected `deviceId` does not map cleanly to the physical 1x sensor, or it does not expose torch/flash capability on the separate physical camera entries in a useful way.
- Relying on `deviceId: { exact }` alone is not enough on the S25. Even if we identify a rear/torch-capable logical camera, WebRTC may still choose the ultra-wide physical lens internally.
- The previous camera capture path was not still-photo capture. It grabbed the current WebRTC video frame with `canvas.drawImage(video, ...)`. On the S25 this produced a cropped video frame around `2400x3200`, then app code downscaled the long edge to `1920`, resulting in `1440x1920` output. That explains the observed 2.8 MP captures.
- Requesting `width: { ideal: 1920 }, height: { ideal: 1440 }` encourages a video-mode resolution, not full still capture. It cannot produce a true 12 MP photo by itself.
- Adding `advanced: [{ zoom: 1 }]` directly in initial `getUserMedia()` constraints is fragile because unsupported zoom constraints can cause startup rejection or be ignored.

**What may work**
- Use WebRTC only for preview and use `ImageCapture.takePhoto()` for the shutter. `takePhoto()` is the browser still-photo API and can return a larger JPEG than the live video frame when the WebView exposes still-photo capabilities.
- Ask `ImageCapture.getPhotoCapabilities()` for max `imageWidth` / `imageHeight`, then call `takePhoto({ imageWidth, imageHeight, fillLightMode: 'off' })`. This has been implemented as the first capture path, with video-frame canvas capture kept only as fallback.
- Remove the app-side 1920 long-edge resize from camera capture. Upload resizing should be handled later by the existing cloud upload policy, not at shutter time.
- Keep zoom application after stream startup via `track.applyConstraints()` and only if `track.getCapabilities().zoom` exposes a valid range. If WebRTC exposes a logical rear camera only, testing zoom values greater than 1 may force the logical camera from ultra-wide toward the 1x field of view, even when device IDs do not.
- If WebRTC still returns the ultra-wide lens and/or `ImageCapture.takePhoto()` still returns video-mode crops, the likely working solution is native Android CameraX/Camera2 for capture: enumerate physical cameras, choose the back camera with flash/torch and normal focal length, bind a Preview use case plus ImageCapture use case, and return the captured JPEG(s) to the WebView. This would also support multi-shot capture before returning to the app, but must avoid the previous native preview flicker path.

#### 2026-04-29 ImageCapture Results and Dual Camera Plan
**Latest hardware result**
- Current WebRTC implementation now captures high-resolution stills around 12 MP using `ImageCapture.takePhoto()`.
- The selected lens is still the ultra-wide lens on the Samsung S25.
- Preview and captured JPEG now show the same field of view, so the old mismatch between preview/video crop and output is gone.
- When imported into `sporely-py`, the captured image appears rotated -90 degrees. This suggests the JPEG has EXIF orientation that desktop import is not honoring, or native/WebView still capture is writing pixels/orientation differently than expected.
- GPS EXIF is missing from the captured JPEG. This may be acceptable because Sporely already stores capture GPS in the cloud/local observation DB, but we should either transfer coordinates from cloud DB to local DB during desktop sync/import or explicitly write GPS EXIF before upload/export.

**Product direction**
- Keep the current WebRTC `ImageCapture.takePhoto()` implementation as **Sporely Cam**. It is useful because it gives high-resolution 12 MP captures and works without the native flicker path, even though S25 lens selection is wrong.
- Add a third capture/import button in the web app: **Native Cam**. This button is Android-only and launches a native CameraX/Camera2 capture flow.
- Native Cam should use Android CameraX/Camera2 to select the back physical camera with flash/torch and normal/wide focal length, avoiding Samsung WebView's logical-camera ultra-wide selection.
- Native Cam should return one or more JPEGs plus metadata to the existing Sporely review/import pipeline, so multi-shot capture can be supported before returning to the web UI.
- Native Cam must normalize orientation before returning files, or write a correct EXIF orientation tag that both web and `sporely-py` honor.
- Native Cam should either write GPS EXIF using current app/device coordinates or return GPS metadata alongside the photo so the observation DB remains the source of truth.

**Implementation tasks**
- [x] Rename/label the existing WebRTC camera entry point as **Sporely Cam** in the UI where users choose capture/import.
- [x] Add **Native Cam** as a third Android-only button in the web app.
- [x] Add a `NativeCamera` Capacitor plugin and register it in `MainActivity`.
- [x] Add Android CameraX dependencies.
- [x] Build first native CameraX capture activity with Preview + ImageCapture, multi-shot queue, Done/Cancel controls, and a 1x/back-camera selector based on Camera2 characteristics.
- [x] Return captured cache-file paths and metadata to JS.
- [x] Reuse the existing import/review path to convert returned native files into `File`/Blob entries.
- [x] Initial Android device test: Native Cam launches, captures, returns photos to the app, and works as the new native capture path.
- [ ] Verify on Samsung S25: selected lens is 1x, capture is 12 MP, preview matches output, orientation is correct in `sporely-py`, and GPS strategy is documented.

## UI fixes
- Missing location data popup: Remove "when using the quick "Photos & videos" picker". Add the sentence: "(Or just use Sporely cam to capture location)"
- Group import review screen: Instead of Queue all, just use Add (Legg til
- Remove the New observation after.. /Photo import section in Settings (It is now in the group import page - make sure this setting is stored until next time)
- [x] Remove the F-stop and location info boxes from Capture screen. Add lens/zoom selection buttons reading from device hardware API and move the batch badge above the Done button.
- On the Finds tab: Species is not translated
- Finds tab, when 1 card per row is shown: Add an icon that indicates if there are spore measures for the observation. This could be like a small almond shaped brown icon, same row and just before the "sharing" icon (friends/public/private). 
- Add a time based filter on the map page: A row of buttons, same as the Friends filter, with Past 24h, Past week, Past month.
- Add a legend drop-down to the map page. Selection: Genus (more will come). this will show a legend with colors, corresponding the the dots on the map.
- The card with number of finds, number of species, and number of spores: Tapping finds: open screen with finds, filtered for that user (card could appear on home tab or people tab): Species filter off. Tapping species: same as for tapping finds, but with species filter on. Tapping spores: filter only finds for that user with spore measurements.

## Code Review & Refactoring
*Review this code with a strict refactor/audit mindset. Do not praise. Look for concrete problems only.*

For each issue you find, return:
- severity: low / medium / high
- category
- file(s)
- exact problem
- why it is a problem
- minimal fix
- whether fix is safe or risky

Check specifically for these categories:

1. Duplicate logic
- Repeated Vanilla JS DOM element creation, formatting, or parsing
- Repeated Supabase JS `.select()` or `.insert()` query boilerplate
- Repeated IndexedDB transaction and object store boilerplate
- Repeated EXIF parsing or Canvas resizing logic that should be centralized
- Duplicated deduplication logic (e.g., fuzzy matching) across different list views

2. Conflicting source of truth
- DOM state (e.g., `data-*` attributes, input values) drifting from `src/state.js`
- Local variables in `screens/*.js` shadowing global `state` properties
- IndexedDB offline queue state out of sync with actual Supabase cloud row state
- Cached Supabase auth session data drifting from the actual `onAuthStateChange` reality
- Inconsistent markers for uploaded vs. pending photos

3. Database consistency
- Supabase JS insert payloads missing fallback values or null handling
- Mismatches between IndexedDB object store payloads and actual Supabase DB schemas
- Relying on client-side JS to enforce rules that should be handled by Supabase RLS or the Cloudflare Worker
- Type inconsistencies across environments (e.g., string vs. integer for `desktop_id` or remote IDs)

4. State flow problems
- Modifying `state.js` directly without triggering DOM updates or `notify*()` signals
- Async races: UI rendering before Supabase fetch or IndexedDB read completes
- IndexedDB `readwrite` transactions auto-closing due to intermediate `await` calls (especially on iOS Safari)
- Screen navigation (`router.js`) failing to tear down previous screen's event listeners, intervals, or camera streams
- Background sync worker racing or clashing with active foreground UI states

5. UI consistency problems
- Same concept displayed with different labels (e.g., "Queued" vs "Pending")
- Hardcoded English strings used instead of the `t()` translation helper
- Vanilla JS DOM manipulation omitting standard CSS classes from `style.css`
- Inconsistent error toast messages for network failures vs database failures
- Missing empty states for lists (Finds, Comments, Friends)

6. Dead code / stale code
- Unused functions, constants, or leftover `console.log` statements
- Unused CSS custom properties in `style.css`
- Dead code paths from before the Cloudflare R2 storage migration (legacy Supabase storage logic)
- Leftover code from removed features (e.g., draft save/resume logic)

7. Overgrown files / bad boundaries
- `screens/*.js` files directly mixing heavy DOM construction, raw IndexedDB transactions, and Supabase queries
- Heavy image processing (Canvas rendering, EXIF extraction) blocking the main UI thread
- State files containing DOM presentation formatting
- `import_review.js` or `sync-queue.js` growing too large without module splitting

8. Naming problems
- Confusing or overlapping IDs (e.g., mixing up local offline `id`, `desktop_id`, and Supabase `id`)
- Misleading sync stages (`syncStage` vs `syncStatus` vs `status`)
- Function names that sound synchronous but return Promises
- Generic element IDs in Vanilla JS leading to `document.getElementById` collisions

9. Error handling / edge cases
- Unhandled iOS Safari memory / Blob streaming limits leading to silent crashes
- Assuming the network is online without a proper IndexedDB offline-queue fallback
- Assuming native Capacitor APIs (e.g., `NativePhotoPicker`) are always available when running as a PWA
- Silent failures in `Promise.all` during multi-photo batch imports or uploads
- Missing guard clauses when DOM elements are temporarily unmounted

10. Refactor opportunities worth doing now
- Move repeated Vanilla JS DOM creation into shared layout helpers
- Centralize IndexedDB read/write for specific entities (`import-store.js`, `sync-queue.js`)
- Isolate heavy image processing / AI crop math into pure, testable modules (`Vitest` ready)
- Align cloud AI crop data shapes directly with the canonical `sporely-py` desktop definitions

Important:
- Prefer specific findings over style opinions
- Ignore superficial formatting unless it hides a real problem
- Do not suggest huge rewrites unless necessary
- Flag places where behavior may drift across desktop/web/mobile versions
- Distinguish “must fix” from “cleanup”

### Existing Refactor & Audit Tasks
- [ ] **Optional server-side change summary** — a future Supabase RPC/view could return one per-observation “meaningful cloud change” summary and remove most remaining client-side deep comparison work.
- [ ] **Import Flow Memory Architecture** — Refactor `import_review.js` and `import-store.js` to a streaming architecture. Currently, large imports (40+ photos) can exhaust mobile browser memory and crash the app because all full-resolution JPEGs are decoded and held in RAM simultaneously before being written to IndexedDB. The fix requires:
    - Streaming each processed blob directly to IndexedDB in `_processFile` and releasing it from RAM.
    - Keeping only lightweight metadata and downscaled `aiBlob` URLs in the active memory array (`sourceItems`).
    - Avoiding the massive memory spike caused by `Promise.all(files.map(f => f.arrayBuffer()))` in `import-store.js`.
    - *Note on Platforms (PWA vs APK):* This bottleneck is most severe for iPhone users running the app as a PWA (Safari), where per-tab memory limits are very strict (crashing often around 150-300MB). Android users on the native Capacitor APK have a higher WebView memory ceiling (often 500MB+ on modern devices like the S25) and benefit from native HEIC-to-JPEG conversion, but they will still eventually crash on huge imports until this streaming fix is implemented.

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
 vcm
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

**Remaining:**
- [ ] **Cross-platform QA** — verify the same image’s crop survives web edit → desktop pull and desktop edit → cloud/web round-trip

## Active Tasks (TODO) - Automated Testing & Auditing
*Goal: Move from purely manual QA debug logs to an automated safety net for complex sync and state flows.*
- [ ] **Static Analysis** — Introduce ESLint and configure it to catch dead code, missing variables, and unused imports to automate the "10-point Code Review" checklist.
- [ ] **Unit Testing Framework** — Introduce `Vitest` to test pure-logic modules (`image_crop.js`, local media signature generation, and `_observationsLikelySame` deduplication logic).
- [ ] **Sync Queue Tests** — Write automated integration tests for `sync-queue.js` mocking IndexedDB and Cloudflare R2 worker uploads to simulate network drops and retry loops.
- [ ] **RLS Auditing** — Create automated SQL tests (e.g., using `pgTAP` or Supabase local utilities) to verify that blocked users, banned users, and private measurements are correctly filtered by RLS policies.

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

## Phase 4: Image Sync & Monetization
*Goal: Implement tiered storage, client-side compression, and a Pro subscription model.*

### 1. Image Processing & Compression (Client-Side)
- [ ] **Metadata Preservation:**
    - Extract GPS and timestamp EXIF data *before* compression.
    - Re-inject or store metadata in the database to ensure "Digital Lab Notebook" integrity.

### 2. Storage Architecture & Guardrails
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
- [ ] Create Android Keystore and configure release signing.
- [ ] Build App Bundle (`.aab`) and upload to Google Play Console.
- [ ] Prepare store listing, screenshots, and privacy policy.

### 5. Transparency & Open Source
- [ ] **UI Disclaimers:**
    - Add clear messaging around free 2 MP uploads, Pro 12 MP uploads, and account storage quota.

## Phase 5: UGC Moderation & Play Store Compliance
*Goal: Implement required User Generated Content (UGC) moderation features to satisfy Google Play Store policies before APK release.*

### Outstanding Tasks
- [ ] **Moderation Dashboard** — V1: Utilize Supabase Studio as the backend dashboard to routinely review the `reports` table, delete offending `observations`/`comments`, and ban bad actors. V2: Build an in-app `/admin` view gated by `is_admin = true`.

## Feature Status (What's real vs stubbed)

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
Not doing this: | Pro Subscription (RevenueCat) | 🟡 Groundwork in place — schema + upload metadata are live, but no billing/IAP flow yet |
| Hardware Sync (Macro-to-GPS) | ❌ Not started |

## Infrastructure Status

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
