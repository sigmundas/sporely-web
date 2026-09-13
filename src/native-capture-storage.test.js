import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NATIVE_CAPTURE_STALE_AFTER_MS,
  collectProtectedNativeCapturePaths,
  finalizeNativeCaptureSources,
  isNativeCameraCapturePath,
  nativeCaptureSourcePathForPhoto,
  nativeCaptureSourcePathFromNativePhoto,
  pruneStaleNativeCaptures,
} from './native-capture-storage.js'
import { getSaveOriginalsToPhone, setSaveOriginalsToPhone } from './settings.js'

const CACHE = '/data/user/0/com.sporelab.sporely/cache'
const CAPTURE_A = `${CACHE}/native-camera/sporely-native-1757600000000_a1b2c3.jpg`
const CAPTURE_B = `${CACHE}/native-camera/sporely-native-1757600001000_d4e5f6.jpg`
const SYSTEM_CAM = `${CACHE}/system_cam_123.jpg`
const PICKER = 'content://media/external/images/media/42'

function createLocalStorageStub() {
  const store = new Map()
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null },
    setItem(key, value) { store.set(String(key), String(value)) },
    removeItem(key) { store.delete(String(key)) },
    clear() { store.clear() },
  }
}

function withLocalStorage(fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: createLocalStorageStub() })
  try {
    return fn()
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

// Fake NativeCamera plugin that models the cache directory as a Set of paths
// and records call order so ordering (export before delete) is observable.
function createFakePlugin({ files = [], exportFails = () => false, deleteFails = () => false } = {}) {
  const cache = new Set(files)
  const gallery = []
  const calls = []
  return {
    cache,
    gallery,
    calls,
    async exportCaptureToGallery({ path }) {
      calls.push(['export', path])
      if (!cache.has(path)) throw new Error('source missing')
      if (exportFails(path)) throw new Error('MediaStore refused')
      gallery.push(path)
      return { uri: `content://media/external/images/media/${gallery.length}` }
    },
    async deleteCapture({ path }) {
      calls.push(['delete', path])
      if (deleteFails(path)) throw new Error('delete failed')
      cache.delete(path)
      return { deleted: true }
    },
    async pruneStaleCaptures(args) {
      calls.push(['prune', args])
      return { scanned: 0, deleted: 0, retained: 0, protectedRetained: 0, protectedIgnored: 0, skipped: 0, failed: 0 }
    },
  }
}

// ── A. setting default + persistence ─────────────────────────────────────────

test('Save originals to phone defaults OFF and round-trips through localStorage', () => {
  withLocalStorage(() => {
    assert.equal(getSaveOriginalsToPhone(), false)
    setSaveOriginalsToPhone(true)
    assert.equal(globalThis.localStorage.getItem('sporely-save-originals-to-phone'), '1')
    assert.equal(getSaveOriginalsToPhone(), true)
    setSaveOriginalsToPhone(false)
    assert.equal(globalThis.localStorage.getItem('sporely-save-originals-to-phone'), '0')
    assert.equal(getSaveOriginalsToPhone(), false)
  })
})

// ── path classification ──────────────────────────────────────────────────────

test('only Sporely native-camera cache JPEGs classify as capture sources', () => {
  assert.equal(isNativeCameraCapturePath(CAPTURE_A), true)
  assert.equal(isNativeCameraCapturePath(`file://${CAPTURE_A}`), true)
  assert.equal(isNativeCameraCapturePath(SYSTEM_CAM), false)
  assert.equal(isNativeCameraCapturePath(PICKER), false)
  assert.equal(isNativeCameraCapturePath(`${CACHE}/sporely-native-1_a.jpg`), false)
  assert.equal(isNativeCameraCapturePath(`${CACHE}/native-camera/other.jpg`), false)
  assert.equal(isNativeCameraCapturePath(`${CACHE}/native-camera/sporely-native-1_a.png`), false)
  assert.equal(isNativeCameraCapturePath(null), false)
  assert.equal(isNativeCameraCapturePath(''), false)

  assert.equal(nativeCaptureSourcePathFromNativePhoto({ path: CAPTURE_A, originalPath: CAPTURE_A }), CAPTURE_A)
  assert.equal(nativeCaptureSourcePathFromNativePhoto({ path: SYSTEM_CAM, originalPath: SYSTEM_CAM }), null)
  assert.equal(nativeCaptureSourcePathFromNativePhoto({ path: PICKER }), null)
  assert.equal(nativeCaptureSourcePathFromNativePhoto(null), null)

  assert.equal(nativeCaptureSourcePathForPhoto({ nativeSourcePath: `file://${CAPTURE_A}` }), CAPTURE_A)
  assert.equal(nativeCaptureSourcePathForPhoto({ nativeSourcePath: PICKER }), null)
  assert.equal(nativeCaptureSourcePathForPhoto({}), null)
})

// ── B. setting OFF: delete only, no gallery export ───────────────────────────

test('finalize with setting OFF deletes sources without exporting', async () => {
  const plugin = createFakePlugin({ files: [CAPTURE_A, CAPTURE_B, SYSTEM_CAM] })
  const summary = await finalizeNativeCaptureSources([CAPTURE_A, CAPTURE_B], { plugin, exportToGallery: false })

  assert.deepEqual(plugin.gallery, [])
  assert.equal(plugin.cache.has(CAPTURE_A), false)
  assert.equal(plugin.cache.has(CAPTURE_B), false)
  assert.equal(plugin.cache.has(SYSTEM_CAM), true)
  assert.deepEqual(plugin.calls, [['delete', CAPTURE_A], ['delete', CAPTURE_B]])
  assert.equal(summary.attempted, 2)
  assert.equal(summary.exported, 0)
  assert.equal(summary.deleted, 2)
  assert.equal(summary.exportFailed, 0)
})

test('finalize reads the persisted setting when exportToGallery is not forced', async () => {
  await withLocalStorage(async () => {
    setSaveOriginalsToPhone(true)
    const plugin = createFakePlugin({ files: [CAPTURE_A] })
    await finalizeNativeCaptureSources([CAPTURE_A], { plugin })
    assert.deepEqual(plugin.gallery, [CAPTURE_A])

    setSaveOriginalsToPhone(false)
    const plugin2 = createFakePlugin({ files: [CAPTURE_A] })
    await finalizeNativeCaptureSources([CAPTURE_A], { plugin: plugin2 })
    assert.deepEqual(plugin2.gallery, [])
    assert.equal(plugin2.cache.has(CAPTURE_A), false)
  })
})

// ── C + H. setting ON: export the original, then delete, per source ──────────

test('finalize with setting ON exports each original before deleting it', async () => {
  const plugin = createFakePlugin({ files: [CAPTURE_A, CAPTURE_B] })
  const summary = await finalizeNativeCaptureSources([CAPTURE_A, CAPTURE_B], { plugin, exportToGallery: true })

  assert.deepEqual(plugin.gallery, [CAPTURE_A, CAPTURE_B])
  assert.equal(plugin.cache.size, 0)
  // Export uses the native source path (the original JPEG), and each source is
  // exported strictly before it is deleted.
  assert.deepEqual(plugin.calls, [
    ['export', CAPTURE_A], ['delete', CAPTURE_A],
    ['export', CAPTURE_B], ['delete', CAPTURE_B],
  ])
  assert.equal(summary.exported, 2)
  assert.equal(summary.deleted, 2)
  assert.equal(summary.exportFailed, 0)
})

// ── E. gallery export failure: still deleted, warning reported ───────────────

test('a failed gallery export is reported, does not throw, and still frees the cache source', async () => {
  const plugin = createFakePlugin({
    files: [CAPTURE_A, CAPTURE_B],
    exportFails: path => path === CAPTURE_B,
  })
  const summary = await finalizeNativeCaptureSources([CAPTURE_A, CAPTURE_B], { plugin, exportToGallery: true })

  assert.deepEqual(plugin.gallery, [CAPTURE_A])
  assert.equal(plugin.cache.size, 0, 'export failure must not leave private cache garbage')
  assert.equal(summary.exported, 1)
  assert.equal(summary.exportFailed, 1)
  assert.equal(summary.deleted, 2)
})

test('a failed delete is reported without throwing', async () => {
  const plugin = createFakePlugin({ files: [CAPTURE_A], deleteFails: () => true })
  const summary = await finalizeNativeCaptureSources([CAPTURE_A], { plugin, exportToGallery: false })
  assert.equal(summary.deleteFailed, 1)
  assert.equal(summary.deleted, 0)
})

// ── only Sporely-owned capture files are ever touched ────────────────────────

test('finalize skips non-capture paths and de-duplicates', async () => {
  const plugin = createFakePlugin({ files: [CAPTURE_A, SYSTEM_CAM] })
  const summary = await finalizeNativeCaptureSources(
    [CAPTURE_A, `file://${CAPTURE_A}`, SYSTEM_CAM, PICKER, null, '', 42],
    { plugin, exportToGallery: true },
  )
  assert.deepEqual(plugin.calls, [['export', CAPTURE_A], ['delete', CAPTURE_A]])
  assert.equal(plugin.cache.has(SYSTEM_CAM), true)
  assert.equal(summary.attempted, 1)
  assert.equal(summary.skipped, 2)
})

test('finalize with no sources is a no-op that never touches the plugin', async () => {
  const plugin = createFakePlugin()
  const summary = await finalizeNativeCaptureSources([], { plugin, exportToGallery: true })
  assert.deepEqual(plugin.calls, [])
  assert.equal(summary.attempted, 0)
  const summary2 = await finalizeNativeCaptureSources(undefined, { plugin })
  assert.equal(summary2.attempted, 0)
})

// ── G. orphan prune wiring ───────────────────────────────────────────────────

const _noDraft = async () => null

test('prune requests the 48h cutoff and swallows plugin failures', async () => {
  const plugin = createFakePlugin()
  const result = await pruneStaleNativeCaptures({ plugin, force: true, loadReviewDraft: _noDraft })
  assert.deepEqual(plugin.calls, [['prune', { maxAgeMs: NATIVE_CAPTURE_STALE_AFTER_MS, protectedPaths: [] }]])
  assert.equal(NATIVE_CAPTURE_STALE_AFTER_MS, 48 * 60 * 60 * 1000)
  assert.equal(result.deleted, 0)

  const failing = {
    async pruneStaleCaptures() { throw new Error('boom') },
  }
  const previousWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  try {
    const failed = await pruneStaleNativeCaptures({ plugin: failing, force: true, loadReviewDraft: _noDraft })
    assert.equal(failed, null)
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = previousWarn
  }
})

test('prune is skipped off Android unless forced', async () => {
  const plugin = createFakePlugin()
  const result = await pruneStaleNativeCaptures({ plugin, loadReviewDraft: _noDraft })
  assert.equal(result, null)
  assert.deepEqual(plugin.calls, [])
})

// ── draft-referenced captures are protected from the age-based prune ─────────

test('captures referenced by the persisted review draft are passed as protected paths', async () => {
  const loadReviewDraft = async () => ({
    photos: [
      { nativeSourcePath: CAPTURE_A },
      { nativeSourcePath: `file://${CAPTURE_B}` },
      { nativeSourcePath: CAPTURE_A },          // duplicate
      { nativeSourcePath: SYSTEM_CAM },         // not a Sporely Cam capture
      { nativeSourcePath: PICKER },
      { nativeSourcePath: null },
      {},
    ],
  })
  assert.deepEqual(await collectProtectedNativeCapturePaths({ loadReviewDraft }), [CAPTURE_A, CAPTURE_B])

  const plugin = createFakePlugin()
  await pruneStaleNativeCaptures({ plugin, force: true, loadReviewDraft })
  assert.deepEqual(plugin.calls, [['prune', {
    maxAgeMs: NATIVE_CAPTURE_STALE_AFTER_MS,
    protectedPaths: [CAPTURE_A, CAPTURE_B],
  }]])
})

test('no draft → nothing protected; age-based cleanup runs as the orphan fallback', async () => {
  assert.deepEqual(await collectProtectedNativeCapturePaths({ loadReviewDraft: _noDraft }), [])
  assert.deepEqual(await collectProtectedNativeCapturePaths({ loadReviewDraft: async () => ({ photos: [] }) }), [])
  const plugin = createFakePlugin()
  await pruneStaleNativeCaptures({ plugin, force: true, loadReviewDraft: _noDraft })
  assert.equal(plugin.calls.length, 1)
  assert.deepEqual(plugin.calls[0][1].protectedPaths, [])
})

test('a failed draft read skips the prune entirely instead of deleting unprotected', async () => {
  const plugin = createFakePlugin()
  const previousWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args)
  try {
    const result = await pruneStaleNativeCaptures({
      plugin,
      force: true,
      loadReviewDraft: async () => { throw new Error('IndexedDB blocked') },
    })
    assert.equal(result, null)
    assert.deepEqual(plugin.calls, [], 'native prune must not run without draft protection')
    assert.equal(warnings.length, 1)
  } finally {
    console.warn = previousWarn
  }
})
