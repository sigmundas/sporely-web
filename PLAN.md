# Sporely-web Development Plan


## Camera Behavior Summary (Sporely Cam vs Web Cam)

**Sporely Cam (Native Android / CameraX)**
- **Availability:** Active only when running the installed Android app (via Capacitor).
- **Hardware & Quality:** Direct access to native CameraX APIs. Utilizes the best available lens (e.g., 1x lens) and captures at true, high-resolution original quality (e.g., 12 MP). Supports legacy OEM HDR extensions and modern Android 14+ Ultra HDR (JPEG_R format).
- **Metadata:** Natively preserves full EXIF orientation and accurate GPS location data seamlessly during capture.

**Web Cam (HTML5 `getUserMedia` / PWA)**
- **Availability:** Used when accessing `app.sporely.no` from a mobile browser (Safari/Chrome) or installed as a PWA.
- **Hardware & Quality:** Captures frames from a `<video>` stream painted to an HTML `<canvas>`. Output resolution is artificially constrained by browser WebRTC stream limits, typically resulting in lower image quality than native captures.
- **Metadata:** Mobile browsers aggressively strip EXIF data (like GPS coordinates) from browser-based captures to protect privacy.
- **UI Handling:** The app displays an `android-web-camera-warning-overlay` and `exif-warning-overlay` to advise Android web users of this limitation, recommending they install the native Sporely app for proper location handling and image quality.

## UI fixes
- Add a time based filter on the map page: A row of buttons, same as the Friends filter, with Past 24h, Past week, Past month.
- Add a legend drop-down to the map page. Selection: Genus (more will come). this will show a legend with colors, corresponding the the dots on the map.


## Location

- [ ] **Use a latest-request guard.** Track a request id plus rounded coordinates in the UI. If the user changes photos/coordinates before the lookup returns, ignore the stale result so an old place name cannot fill a new observation.

### Server-Side Lookup Flow
- [ ] **Nominatim first for country detection.** Query `https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json`, parse `display_name`, `address.country_code`, and `address.country`, and keep the full `display_name` as fallback/reference.
- [ ] **Build short Nominatim suggestions as separate entries.** Do not show the full local-to-regional chain as the normal Location text. Suggest `address.amenity || address.road` as one dropdown item, then `address.neighbourhood || address.suburb` as another item.
- [ ] **Norway branch:** if `country_code === "no"`, query `https://stedsnavn.artsdatabanken.no/v1/punkt?lat={lat}&lng={lon}&zoom=45`. Use `navn` first only when `dist <= 0.006`; otherwise discard it and fall back to Nominatim suggestions.
- [ ] **Denmark branch:** if `country_code === "dk"`, query `https://api.dataforsyningen.dk/adgangsadresser/reverse?x={lon}&y={lat}`. Put the best DAWA local label first, then the Nominatim local suggestions.
- [ ] **Other countries:** use Nominatim local suggestions first; use `display_name` only if no local address parts are available.
- [ ] **Deduplicate suggestions while preserving source priority.** Norway order is Artsdatabanken then Nominatim. Denmark order is DAWA then Nominatim.

### Web UI Behavior
- [ ] **Resolve once per observation/session.** For a multi-photo observation, reuse the resolved place name for attached photos unless coordinates differ meaningfully.
- [ ] **Auto-fill the first suggestion.** The Location field should receive the first suggestion when it is empty or still contains the previous auto-filled value.
- [ ] **Show all suggestions on field focus/click.** The dropdown should contain separate entries, not a comma-joined string.
- [ ] **Persist useful country metadata.** Store or carry `country_code`, `country_name`, and `nominatim_display_name` alongside the observation/import draft when available.
- [ ] **Drive regional UI from country.** Norway uses Artsobservasjoner-oriented fields, Sweden uses Artportalen-oriented fields, Denmark is pending Danmarks Svampeatlas, and other countries use iNaturalist/Sporely Cloud defaults. Hide regional biotope/substrate controls outside Norway and Sweden, while keeping them visible until country is known.

### Tests
- [ ] **Unit-test normalization fixtures.** Add fixtures for Norway, Denmark, Sweden, and a non-Nordic country. Assert suggestion order, deduplication, country parsing, and fallback behavior.
- [ ] **Test stale lookup handling.** Simulate two coordinate lookups resolving out of order and verify only the latest result updates the draft.

## Code Review & Refactoring
*Review this code with a strict refactor/audit mindset. Do not praise. Look for concrete problems only.*

### 2026-04-30 Camera Settings Review Findings
- [ ] Settings can show `Native Cam` selected while browser/PWA users are actually routed to `Sporely Cam`; make the settings UI show the effective camera mode or hide/disable native selection outside the Android app.
- [ ] Capture reset/default draft logic is duplicated across `capture.js` and `review.js`; centralize `defaultCaptureDraft()` and `resetCaptureSession()` near `state.js`.
- [ ] Remove dead `capture.importPhotos` i18n keys after removing the capture-screen gallery button.
- [x] Consolidate duplicated platform detection helpers (`_isNativeApp`, Android-native checks) into a shared platform helper.
- [ ] Remove or gate production camera debug logs in `capture.js`.

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
- [ ] **Profile/account parity QA** — Verify web Profile and desktop Profile & Cloud read/write the same Supabase `profiles` fields: `username`, `display_name`, `bio`, and `avatar_url`. Confirm desktop `profile_email` follows the Supabase auth email and is not treated as an independent account identifier while signed in.
- [ ] **Desktop account migration UX** — Design a safer migration path for users who want a new Sporely Cloud account without duplicating synced observations or losing valuable spore data. The desktop account lock should keep blocking accidental account switches until this exists.
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
- [ ] **Outlier Verification UI** — Link Plotly click events to the R2-hosted thumbnails for instant QC.

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
| Grid/card thumbnails | ✅ Real — primary `thumb_` variant generated at upload time, with legacy `small` + `medium` fallback support |
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
| User finds | ✅ Real — filtered Finds screen from a specific user profile |
| Spores filter | ✅ Real — toggle to show only observations with spore measurements |
| Map view | ✅ Real — Leaflet + OpenStreetMap |
| Offline queue | ✅ Real — IndexedDB queue, syncs on reconnect |
| Import review recovery after app suspension | ✅ Real — IndexedDB `pending_import` store |


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

# Phase 6: 12MP/2MP Conditional WebP/JPEG Pipeline
*Goal: Implement a reliable client-side compression pipeline for iOS and Android, keeping high-fidelity R2 storage without depending on Cloudflare Image Resizing.*

### 2026-05-05 Status
- ✅ JPEG/WebP upload now works on both iOS and Android.
- ✅ Web encoding uses WebP first (`image/webp`, quality 0.65) and falls back to JPEG (`image/jpeg`, quality 0.75), with R2 filenames matching the actual blob MIME type.
- ✅ The primary thumbnail variant is `thumb_{filename}` at 400px max edge, generated as WebP/JPEG according to browser support.
- ✅ Image resize/encode work runs in `src/image-worker.js` using `ImageBitmap` transfer and `OffscreenCanvas` where supported.
- ✅ Sync queue image bytes are persisted as `ArrayBuffer` values in IndexedDB, so retries can resume after app suspension or process death.
- ✅ `@capawesome/capacitor-background-task` is wired for Capacitor background attempts when the app becomes hidden.
- ✅ Web import/add-photo paths now accept `.avif`/`image/avif` for browser-decodable AVIF inputs, but the web app still does not encode AVIF.

## Step 1: Conditional Resize & Conversion (Web App)
Update image processing logic in `src/images.js` and `src/image-worker.js` to handle the user's resolution settings while protecting device memory:
- **Sequential Processing:** Process queued images one by one.
- **Resolution Logic:**
  - **If 2MP Mode:** Resize the image to a max edge of **1600px**.
  - **If 12MP Mode:** Do **not** resize unless the source image is **>13MP** (guard against extreme resolution bloat). If >13MP, downscale to a 4000px max edge (~12MP).
- **The "Double-Bake" Upload:** Every capture/import generates:
  1. `{id}.{webp|jpg}`: The 2MP or 12MP optimized file.
  2. `thumb_{id}.{webp|jpg}`: A 400px max-edge thumbnail for fast feed/card rendering.
- **Memory Management:** Explicitly clear the canvas after every photo:
  ```javascript
  canvas.width = 0; canvas.height = 0;
  URL.revokeObjectURL(img.src);
  ```

## Step 2: Native Camera Revert (Android)
- **Revert HDR Bloat:** In the native Capacitor plugin (`NativeCameraActivity.java`), set `ImageCapture.Builder` back to `CAPTURE_MODE_MINIMIZE_LATENCY`.
- **Native Capture Quality:** Set native `jpegQuality` to **75** so native captures use the fixed JPEG policy.

## Step 3: Desktop Sync Integration
- Ensure the desktop app pulls direct R2 keys for `.webp`, `.jpg`, `.jpeg`, and future `.avif` files instead of relying on Cloudflare CDN edge resize parameters.
- Keep desktop thumbnail naming aligned with web: the single `thumb_{filename}` variant.

## Fix issues: Image Pipeline Reset & Optimization**

### **1. Historical Context (The Problem)**
We attempted to move from raw JPEG uploads to a "Double-Bake" client-side optimization strategy (generating a Full-res and a 400px Thumbnail variant before upload). 
*   **The Intent:** Use AVIF to save space and R2 egress costs.
*   **The Failure:** Mobile browsers (especially iOS Safari) do not support **encoding** AVIF via `canvas.toBlob`. The system silently fell back to **PNG**, resulting in 30MB files that exceed Cloudflare’s 15MB upload limit.
*   **The Memory Issue:** Large 12MP blobs are disappearing from memory on iOS, causing "Object not found" errors in the sync queue because we stored temporary Blob URLs instead of persistent data.
*   **Current Resolution:** WebP/JPEG encoding is now the web/mobile production path. AVIF is allowed as an input/display format when the browser can decode it, but AVIF encoding is deferred to desktop/server-side contexts where encoder support is explicit.

### **2. Technical Specifications & Constraints**
*   **Storage:** Cloudflare R2 (CORS is already configured for `PUT`/`POST`).
*   **Client Hardware:** Samsung S25 (Android/Capacitor) and iPhone 13 (iOS/Web).
*   **Target:** 12MP resolution with modern compression.

### **3. The Multi-Threaded "ArrayBuffer" Directive**

#### **A. Move to Web Workers (Avoid UI Freezes)**
The main thread must remain responsive. Move all image resizing and encoding into a `worker.js`. Use `OffscreenCanvas` for the operations. 
*   Pass the captured photo to the worker as an `ImageBitmap` (Transferable) to keep memory usage low.

#### **B. Intelligent Encoding Fallback**
Do not force a file extension. The browser must decide the format, and the code must label it correctly:
1.  **Primary (Android + supported browsers):** Attempt `image/webp` at 0.65 quality.
2.  **Secondary (iOS/Legacy):** If WebP fails, use `image/jpeg` at 0.75 quality.
3.  **Filenaming:** The extension in the R2 path must match the actual blob type (e.g., `image_full.webp` or `image_full.jpg`). **Never use .png.**

#### **C. IndexedDB Resiliency (No more "Ghost" Objects)**
iOS Safari purges Blob URLs under memory pressure. 
1.  After encoding, convert the Blob to an **ArrayBuffer** (`await blob.arrayBuffer()`).
2.  Store the **raw bytes** (ArrayBuffer) in IndexedDB.
3.  The Sync Queue should pull the bytes from IndexedDB and reconstruct the Blob only at the moment of upload.

#### **D. Native Feature Gating**
*   **HDR Toggle:** The "Use HDR" setting is only valid for the **Native Android** (CameraX) app. 
*   **UI Fix:** Hide the HDR toggle in the web app/iOS view to avoid "placebo" settings that don't talk to hardware.

#### **E. Memory "Kill Switch"**
After processing each image in the sequential queue:
*   Set `canvas.width = 0` and `canvas.height = 0`.
*   Call `URL.revokeObjectURL()` on all temporary sources.

### **4. Files Needing Cleanup**
*   `images.js`: Update the `toBlob` logic and fallback checks.
*   `sync-queue.js`: Change Blob storage to ArrayBuffer storage.
*   `main.js`: Update the Settings UI to hide the HDR toggle on non-Android platforms.
*   `worker.js`: (New File) Create the off-thread processing logic.

---
