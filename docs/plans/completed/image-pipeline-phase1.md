# Image Pipeline Phase 1 Checklist

This checklist documents the current behavior before any refactor work changes it.

## Manual Regression Checklist

- Capture one photo in the browser capture flow.
- Capture one photo in the Android native capture flow.
- Import one JPEG from browser file picker.
- Import one HEIC file from native Android import.
- Import a mixed batch and confirm grouping still follows capture time.
- Reopen the app after import and confirm pending sessions restore from IndexedDB.
- Remove one imported photo and confirm the preview list and stored session stay in sync.
- Save a review batch and confirm the observation queues successfully.
- Confirm the upload queue drains and images appear in the observation detail gallery.
- Confirm thumbnails still render in feeds and observation cards.
- Confirm AI crop metadata survives import, review, and queue save.
- Confirm object URLs do not leak after canceling import or navigating away.

## Current Flow Notes

- Capture starts in `src/screens/capture.js`.
- Native Android capture and native photo import are handled by the Capacitor bridge in `android/app/src/main/java/com/sporelab/sporely/`.
- Import review reads EXIF, groups files, and builds sessions in `src/screens/import_review.js`.
- Pending import sessions are stored in IndexedDB by `src/import-store.js`.
- Review converts captured photos into an observation payload in `src/screens/review.js`.
- Queueing and upload preparation happen in `src/sync-queue.js`.
- Resize, thumbnail generation, and media upload/download helpers live in `src/images.js`.
- The Cloudflare worker at `cloudflare/r2-upload-worker/src/index.js` handles direct upload, download, and delete requests for media.

## Debug Flag

Set `sporely-debug-image-pipeline=true` in `localStorage` or `sessionStorage` to enable opt-in logging across the current image flow.
