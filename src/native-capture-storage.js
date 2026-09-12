// Lifecycle of Sporely Cam (NativeCameraActivity) capture files.
//
// The Android native camera writes each capture to private app cache:
//   getCacheDir()/native-camera/sporely-native-<timestamp>_<id>.jpg
// Those files are temporary working storage for review / AI ID / Save. They
// are NOT a long-term image archive. Once the observation's image bytes are
// durably persisted by enqueueObservation() (the sync queue is the crash-safe
// owner of the bytes from then on) the source file is either exported to the
// user's gallery (setting "Save originals to phone") and deleted, or simply
// deleted.
//
// Ordering contract (must not be weakened):
//   enqueueObservation() succeeds → optional MediaStore copy → delete source.
// Nothing here runs before a successful durable enqueue, and nothing here ever
// throws into the Save flow: a failed gallery copy is reported as a warning
// while the observation stays saved.

import { registerPlugin } from '@capacitor/core'
import { isAndroidApp } from './platform.js'
import { getSaveOriginalsToPhone } from './settings.js'
import { loadReviewDraftStrict } from './review-draft-store.js'

export const NATIVE_CAPTURE_DIR_NAME = 'native-camera'
export const NATIVE_CAPTURE_FILE_PREFIX = 'sporely-native-'
export const NATIVE_CAPTURE_STALE_AFTER_MS = 48 * 60 * 60 * 1000

// Matches ".../native-camera/sporely-native-<digits>_<hex>.jpg" only, so
// imported/photo-picker originals, system-camera temp files and anything
// else can never be treated as a Sporely native-camera capture.
const NATIVE_CAPTURE_PATH_RE = /(?:^|\/)native-camera\/sporely-native-\d+_[A-Za-z0-9-]+\.jpe?g$/i

const _DefaultNativeCamera = registerPlugin('NativeCamera')
let _pluginOverride = null

export function __setNativeCaptureStoragePluginForTests(mock) {
  _pluginOverride = mock || null
}

function _plugin() {
  return _pluginOverride || _DefaultNativeCamera
}

export function normalizeNativeCapturePath(path) {
  if (typeof path !== 'string') return null
  const trimmed = path.trim()
  if (!trimmed) return null
  return trimmed.startsWith('file://') ? trimmed.slice('file://'.length) : trimmed
}

export function isNativeCameraCapturePath(path) {
  const normalized = normalizeNativeCapturePath(path)
  if (!normalized) return false
  return NATIVE_CAPTURE_PATH_RE.test(normalized)
}

// Returns the native-camera source path carried by a photo entry, or null when
// the photo did not originate from Sporely Cam (imports, system camera, web).
export function nativeCaptureSourcePathForPhoto(photo) {
  const candidate = photo?.nativeSourcePath ?? null
  return isNativeCameraCapturePath(candidate) ? normalizeNativeCapturePath(candidate) : null
}

// Pick the source path to attach to a review photo from the native plugin
// result. Only Sporely Cam captures qualify; everything else yields null.
export function nativeCaptureSourcePathFromNativePhoto(nativePhoto) {
  const candidate = nativePhoto?.originalPath || nativePhoto?.path || null
  return isNativeCameraCapturePath(candidate) ? normalizeNativeCapturePath(candidate) : null
}

// Finalize native-camera sources for an observation whose image bytes have
// ALREADY been durably enqueued. Never throws. Returns a summary the caller
// uses to surface a warning when a gallery copy could not be made.
//
// options.exportToGallery — defaults to the user setting.
// options.plugin — injectable NativeCamera plugin (tests).
export async function finalizeNativeCaptureSources(paths, options = {}) {
  const summary = {
    attempted: 0,
    exported: 0,
    exportFailed: 0,
    deleted: 0,
    deleteFailed: 0,
    skipped: 0,
  }
  const candidates = Array.isArray(paths) ? paths : []
  const unique = [...new Set(candidates.map(normalizeNativeCapturePath).filter(Boolean))]
  if (!unique.length) return summary

  const plugin = options.plugin || _plugin()
  const exportToGallery = typeof options.exportToGallery === 'boolean'
    ? options.exportToGallery
    : getSaveOriginalsToPhone()

  for (const path of unique) {
    if (!isNativeCameraCapturePath(path)) {
      summary.skipped += 1
      continue
    }
    summary.attempted += 1

    if (exportToGallery) {
      try {
        await plugin.exportCaptureToGallery({ path })
        summary.exported += 1
      } catch (err) {
        summary.exportFailed += 1
        console.warn('Native capture gallery export failed:', path, err)
      }
    }

    // Delete regardless of export outcome: the durable queue owns the bytes.
    // A failed optional gallery copy must not recreate indefinite cache growth.
    try {
      await plugin.deleteCapture({ path })
      summary.deleted += 1
    } catch (err) {
      summary.deleteFailed += 1
      console.warn('Native capture cleanup failed (will age out after 48h):', path, err)
    }
  }

  return summary
}

// Native-camera sources still referenced by persisted, restorable state. These
// must survive the age-based prune: a review draft restored after >48h still
// expects to export/delete its own sources on Save.
//
// Only the review draft persists nativeSourcePath. Import sessions persist
// blob bytes and metadata only (import-store.js), so a Sporely Cam capture
// added to an import group has no restorable reference and is a true orphan
// once its bytes are in the import store.
export async function collectProtectedNativeCapturePaths(options = {}) {
  const load = options.loadReviewDraft || loadReviewDraftStrict
  const draft = await load()
  const photos = Array.isArray(draft?.photos) ? draft.photos : []
  return [...new Set(photos.map(nativeCaptureSourcePathForPhoto).filter(Boolean))]
}

// Best-effort startup/resume pruning of stranded native-camera files (crash
// or abandoned review). Android only; never throws; never blocks boot.
// Captures referenced by the persisted review draft are passed to native code
// as protected; native re-validates every entry. If the draft cannot be read
// the prune is skipped entirely — never delete potentially live captures.
export async function pruneStaleNativeCaptures(options = {}) {
  if (!options.force && !isAndroidApp()) return null
  const plugin = options.plugin || _plugin()
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : NATIVE_CAPTURE_STALE_AFTER_MS
  let protectedPaths
  try {
    protectedPaths = await collectProtectedNativeCapturePaths(options)
  } catch (err) {
    console.warn('Native capture prune skipped: could not read draft state:', err)
    return null
  }
  try {
    const result = await plugin.pruneStaleCaptures({ maxAgeMs, protectedPaths })
    if (result && (result.deleted > 0 || result.failed > 0)) {
      console.info('Native capture prune:', result)
    }
    return result || null
  } catch (err) {
    console.warn('Native capture prune failed:', err)
    return null
  }
}
