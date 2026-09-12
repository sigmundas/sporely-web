# Sporely Cam capture storage lifecycle (Android)

Status: implemented on `feature/native-camera-originals-lifecycle`; device QA pending.

## Problem

`NativeCameraActivity` writes every capture to private app cache:

```text
getCacheDir()/native-camera/sporely-native-<timestamp>_<id>.jpg
```

Those files were never removed after a successful Save, so they accumulated
indefinitely (~200 MB in a week on one device). They are temporary working
storage for review / AI ID / Save, not an image archive.

## Lifecycle now implemented

```text
native camera JPEG (cache/native-camera)
    ↓
review / AI ID                      photo.nativeSourcePath carries the cache path
    ↓                               (also persisted in the review draft)
user presses Save
    ↓
enqueueObservation() succeeds       sync queue now durably owns the image bytes
    ↓
if "Save originals to phone" ON:    NativeCamera.exportCaptureToGallery({ path })
    copy original JPEG → MediaStore Pictures/Sporely (bytes + EXIF/GPS intact)
    ↓
NativeCamera.deleteCapture({ path })   private cache source deleted
```

Key files:

| Concern | Where |
| --- | --- |
| Setting (`getSaveOriginalsToPhone` / `setSaveOriginalsToPhone`, default OFF) | `src/settings.js` |
| Settings UI (Android only, Camera section) | `index.html`, `src/main.js` `initSettings()` / `_syncSettingsUI()` |
| Path classification, post-enqueue finalize, startup prune wrapper | `src/native-capture-storage.js` |
| Source path attached to review photos | `src/screens/import_review.js` `_handleNativePhotoResultAsLive`, `src/screens/review.js` `_addFilesToReview` |
| Post-enqueue hook | `src/screens/review.js` `saveObservationBatch` → `_finalizeReviewNativeCaptures` |
| Draft persistence of the source path | `src/review-draft-store.js` |
| Native guarded file ops + MediaStore export + prune | `android/.../NativeCaptureStorage.java` |
| Plugin methods `exportCaptureToGallery`, `deleteCapture`, `pruneStaleCaptures` | `android/.../NativeCameraPlugin.java` |

## Guarantees

- **Durability ordering.** Nothing touches a native source before
  `enqueueObservation()` resolves. If it throws, the sources stay and the review
  session is preserved (existing behaviour).
- **Gallery export is secondary.** Export failure never fails or rolls back the
  save. The user sees `review.originalNotSavedToPhone` as a toast, and the cache
  source is still deleted so a failed optional copy cannot recreate cache growth.
- **Only Sporely-owned files.** Both JS and Java accept only
  `…/native-camera/sporely-native-<digits>_<id>.jpg`. Java additionally requires
  the canonical path to live inside `cacheDir/native-camera`. System-camera temp
  files (`cache/system_cam_*.jpg`), photo-picker originals and anything else are
  refused.
- **No shutter-time gallery writes.** Discarded/cancelled photos never reach the
  gallery. Cancellation still deletes the session's captures immediately in
  `NativeCameraActivity.finishCanceled()` (unchanged).
- **MediaStore only.** Export uses `MediaStore.Images` with `RELATIVE_PATH`
  `Pictures/Sporely` and `IS_PENDING`; on Android 9 or older the method rejects
  with `UNSUPPORTED` (no legacy storage permission is requested).

## Orphan cleanup

`pruneStaleNativeCaptures()` runs ~4 s after `initSettings()` on Android (fire
and forget, never awaited, failures only `console.warn`). It calls
`NativeCamera.pruneStaleCaptures({ maxAgeMs: 48h })`, which deletes only
`sporely-native-*` regular files in `cache/native-camera` whose `lastModified`
is older than 48 h. Recent unreferenced files are kept on purpose. There is no
"wipe the directory on upgrade" migration; existing stale files age out.

## Paths not covered (documented, not silently changed)

- **Import review: "add Sporely Cam photo to an import group"**
  (`import_review.js` `_openCameraForSession`). Sessions are persisted in the
  import store with a different durability contract; sources are not tracked
  there and age out via the 48 h prune.
- **Find detail: "add photo to existing observation"**
  (`find_detail.js` `_addPhotosToObservation`). Uploads directly to Supabase/R2
  without the queue; sources are not tracked and age out via the prune.
- **Photos removed in review / cancelled review** (`cancelReview`). The blobs
  are discarded; the native sources age out via the prune.
- **System camera temp files** (`cache/system_cam_*.jpg`, `openSystemCamera`).
  Outside the native-camera directory and outside this stage.

## Android device QA checklist

1. **Toggle OFF (default).** Take 2–3 Sporely Cam photos → Save.
   Expect: upload proceeds normally; nothing new in the gallery;
   `adb shell run-as com.sporelab.sporely ls cache/native-camera` no longer lists
   the capture files.
2. **Toggle ON.** Settings → Camera → "Save originals to phone" ON. Take 2–3
   photos → Save. Expect: originals appear in Gallery/Google Photos under
   `Pictures/Sporely` as `Sporely_<yyyyMMdd_HHmmss>_<id>.jpg`; EXIF
   DateTimeOriginal and GPS present where the capture had a fix; cloud upload
   unaffected; cache copies gone.
3. **Cancel camera session** (after 1–2 shutter presses). Expect: no gallery
   copies, no leftover capture files.
4. **Kill the app before Save.** Take photos, force-stop from Settings, relaunch.
   Expect: the restored draft still shows the photos; the capture files are
   still present (younger than 48 h) after the startup prune; Save then cleans
   them up (and exports if ON).
5. **Offline Save.** Airplane mode → take photos → Save. Expect: "Queued 1
   observation" toast; cache files deleted (gallery copy written if ON);
   upload resumes from the queue when back online.
6. **Export failure surface** (optional, e.g. deny/limit storage via a full
   device or revoke media access). Expect: find is still saved, toast
   "Find saved, but the original photo could not be saved to your phone",
   cache file still removed.
