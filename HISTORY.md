# Sporely Web — History & Debugging Notes

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