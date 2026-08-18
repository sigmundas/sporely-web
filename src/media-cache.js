// Stage B — user-scoped persistent media cache.
//
// This module is the SOLE authority for persisted image blobs used by the
// Stage-B offline shell (Home observation thumbnails, Home recent-comment
// thumbnails, protected/authorized variants of those, and the header/profile
// avatar). It is NOT a general-purpose media store — full-resolution
// observation media, detail-screen images, and everything Stage C plans to
// cache are out of scope.
//
// STORAGE
//   * IndexedDB database `sporely-media-cache`, version 1.
//   * Object store `media_blobs`, keyPath `cacheKey`.
//   * Record shape:
//       {
//         version:        1,
//         cacheKey:       'v1|<userId>|<mediaKind>|<privacyScope>|<mediaKey>|<variant>',
//         userId:         '<uuid>',
//         mediaKind:      'observation-thumb' | 'avatar',
//         privacyScope:   'public' | 'protected' | 'self',
//         mediaKey:       '<canonical storage key or "self:<userId>">',
//         variant:        'thumb' | 'original',
//         contentType:    'image/webp' | ...,
//         sizeBytes:      <int>,
//         createdAt:      <ms>,
//         updatedAt:      <ms>,
//         lastAccessedAt: <ms>,
//         blob:           <Blob>
//       }
//
// PRIVACY / FAIL-CLOSED
//   * userId is mandatory on every read/write. A missing userId => null / false.
//   * Cross-user records fail closed: `readCachedMedia(...)` re-verifies that
//     the stored record's `userId` matches the requested userId, and refuses
//     to render a record it did not just author.
//   * Public and protected records for the SAME observation are stored under
//     DIFFERENT cacheKeys (privacyScope segment). One scope never aliases the
//     other.
//   * Malformed records => null (missing schema version, missing userId,
//     missing/blob-less body).
//   * Schema mismatch or "future version" => null (fail-soft local miss).
//   * We NEVER persist Supabase access/refresh tokens, signed URLs, worker
//     bearer tokens, or the media worker origin as part of the cache identity
//     or metadata. Cache identity is derived from the durable media key.
//   * Storage exceptions never bubble to callers — cached media is a
//     progressive enhancement.
//
// LIMITS
//   * Total store cap: 64 MiB.
//   * Per-entry cap: 5 MiB.
//   * Eviction: LRU by `lastAccessedAt`, oldest first. LRU is enforced on
//     write. QuotaExceededError also triggers an evict + retry once.
//   * A read touches `lastAccessedAt` (best-effort — a touch failure never
//     fails the read).
//   * Constants exported for tests.

const DB_NAME = 'sporely-media-cache'
const DB_VERSION = 1
const STORE = 'media_blobs'
const SCHEMA_VERSION = 1

export const MEDIA_CACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const MEDIA_CACHE_MAX_ENTRY_BYTES = 5 * 1024 * 1024
export const MEDIA_CACHE_SCHEMA_VERSION = SCHEMA_VERSION

export const MEDIA_KIND = Object.freeze({
  OBSERVATION_THUMB: 'observation-thumb',
  AVATAR: 'avatar',
})

export const MEDIA_PRIVACY_SCOPE = Object.freeze({
  PUBLIC: 'public',
  PROTECTED: 'protected',
  SELF: 'self',
})

// The set of "variant" strings we normalize down to canonical values. Only
// two variants are cacheable in Stage B: a small "thumb" for observation
// media, and "original" for the avatar (a self-only tiny image).
const _KNOWN_THUMB_VARIANTS = new Set(['thumb', 'small', 'medium', 'cards'])

export function normalizeMediaVariant(variant, mediaKind) {
  const raw = String(variant || '').trim().toLowerCase()
  if (mediaKind === MEDIA_KIND.AVATAR) return 'original'
  if (!raw) return 'thumb'
  if (_KNOWN_THUMB_VARIANTS.has(raw)) return 'thumb'
  return raw
}

function _safe(value) {
  return String(value ?? '').trim()
}

// Build the cache identity string. Cache identity is a strict function of:
//   userId + mediaKind + privacyScope + mediaKey + variant
// It never includes signed URLs, tokens, or worker origins. Callers derive
// `mediaKey` from a durable storage key, not from a transport URL.
export function buildMediaCacheKey({ userId, mediaKind, privacyScope, mediaKey, variant } = {}) {
  const uid = _safe(userId)
  const kind = _safe(mediaKind)
  const scope = _safe(privacyScope)
  const key = _safe(mediaKey)
  const norm = normalizeMediaVariant(variant, kind)
  if (!uid || !kind || !scope || !key || !norm) return ''
  return `v${SCHEMA_VERSION}|${uid}|${kind}|${scope}|${key}|${norm}`
}

// ── IndexedDB backend ────────────────────────────────────────────────────────

function _idbAvailable() {
  try { return typeof indexedDB !== 'undefined' } catch { return false }
}

function _open() {
  return new Promise((resolve, reject) => {
    let req
    try { req = indexedDB.open(DB_NAME, DB_VERSION) }
    catch (err) { reject(err); return }
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'cacheKey' })
      }
    }
    req.onsuccess = ({ target: { result } }) => resolve(result)
    req.onerror = ({ target: { error } }) => reject(error)
  })
}

function _txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

// Real IndexedDB-backed implementation. Every operation opens and closes so
// there is no long-lived connection across process death.
const _idbBackend = {
  async get(cacheKey) {
    if (!_idbAvailable()) return null
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readonly')
      return await new Promise((resolve, reject) => {
        const r = tx.objectStore(STORE).get(cacheKey)
        r.onsuccess = () => resolve(r.result ?? null)
        r.onerror = () => reject(r.error)
      })
    } finally { db.close() }
  },
  async put(record) {
    if (!_idbAvailable()) return
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      await _txDone(tx)
    } finally { db.close() }
  },
  async delete(cacheKey) {
    if (!_idbAvailable()) return
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(cacheKey)
      await _txDone(tx)
    } finally { db.close() }
  },
  async getAll() {
    if (!_idbAvailable()) return []
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readonly')
      return await new Promise((resolve, reject) => {
        const r = tx.objectStore(STORE).getAll()
        r.onsuccess = () => resolve(Array.isArray(r.result) ? r.result : [])
        r.onerror = () => reject(r.error)
      })
    } finally { db.close() }
  },
  async clear() {
    if (!_idbAvailable()) return
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      await _txDone(tx)
    } finally { db.close() }
  },
}

// ── Record validation ────────────────────────────────────────────────────────

function _isBlobLike(value) {
  if (!value) return false
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  // In Node tests we allow a duck-typed blob-ish shape { size, type,
  // arrayBuffer() }.
  return typeof value.size === 'number' && typeof value.type === 'string'
}

function _validateRecord(record, expectedUserId, expectedCacheKey) {
  if (!record || typeof record !== 'object') return null
  if (record.version !== SCHEMA_VERSION) return null
  if (!_isBlobLike(record.blob)) return null
  if (!_safe(record.userId)) return null
  if (expectedUserId && record.userId !== expectedUserId) return null
  if (expectedCacheKey && record.cacheKey !== expectedCacheKey) return null
  if (!_safe(record.cacheKey)) return null
  if (!_safe(record.mediaKind)) return null
  if (!_safe(record.privacyScope)) return null
  if (!_safe(record.mediaKey)) return null
  return record
}

function _isImageContentType(contentType) {
  return String(contentType || '').toLowerCase().startsWith('image/')
}

// ── Public API ───────────────────────────────────────────────────────────────

// Reads a persisted media entry. Never throws. Returns `null` on any failure,
// mismatch, or missing record. Touches `lastAccessedAt` on hit; a failed touch
// does not fail the read.
export async function readCachedMedia(identity, { backend = _idbBackend, now = Date.now } = {}) {
  const cacheKey = buildMediaCacheKey(identity)
  const uid = _safe(identity?.userId)
  if (!cacheKey || !uid) return null
  let record
  try { record = await backend.get(cacheKey) }
  catch { return null }
  const valid = _validateRecord(record, uid, cacheKey)
  if (!valid) return null
  // Best-effort LRU touch. A touch failure never fails the read.
  const touched = { ...valid, lastAccessedAt: now() }
  try { await backend.put(touched) } catch { /* ignore */ }
  return {
    userId: valid.userId,
    mediaKind: valid.mediaKind,
    privacyScope: valid.privacyScope,
    mediaKey: valid.mediaKey,
    variant: valid.variant,
    contentType: valid.contentType,
    sizeBytes: valid.sizeBytes,
    createdAt: valid.createdAt,
    updatedAt: valid.updatedAt,
    lastAccessedAt: touched.lastAccessedAt,
    blob: valid.blob,
  }
}

// Persist a fresh media entry. Enforces the per-entry cap, image-content-type
// guard, and LRU eviction to keep the store under MEDIA_CACHE_MAX_TOTAL_BYTES.
// Returns true on success, false when the write was refused (oversized,
// non-image, missing identity) or when the storage layer failed.
export async function writeCachedMedia(identity, blob, {
  backend = _idbBackend,
  now = Date.now,
  maxTotalBytes = MEDIA_CACHE_MAX_TOTAL_BYTES,
  maxEntryBytes = MEDIA_CACHE_MAX_ENTRY_BYTES,
} = {}) {
  const cacheKey = buildMediaCacheKey(identity)
  const uid = _safe(identity?.userId)
  if (!cacheKey || !uid) return false
  if (!_isBlobLike(blob)) return false
  const size = Number(blob.size || 0)
  if (!Number.isFinite(size) || size <= 0) return false
  if (size > maxEntryBytes) return false
  const contentType = String(blob.type || '').toLowerCase()
  if (!_isImageContentType(contentType)) return false

  const nowMs = now()
  const record = {
    version: SCHEMA_VERSION,
    cacheKey,
    userId: uid,
    mediaKind: _safe(identity.mediaKind),
    privacyScope: _safe(identity.privacyScope),
    mediaKey: _safe(identity.mediaKey),
    variant: normalizeMediaVariant(identity.variant, identity.mediaKind),
    contentType,
    sizeBytes: size,
    createdAt: nowMs,
    updatedAt: nowMs,
    lastAccessedAt: nowMs,
    blob,
  }

  // Pre-emptive LRU: evict older entries to make room for the incoming record
  // if adding it would exceed the cap. Reserved entries currently in use
  // (mainly the record we are about to write, if it existed already) are not
  // eligible for eviction here.
  try {
    let all
    try { all = await backend.getAll() }
    catch { all = [] }
    if (Array.isArray(all) && all.length) {
      const existingIndex = all.findIndex(r => r?.cacheKey === cacheKey)
      let totalBytes = 0
      for (const r of all) totalBytes += Number(r?.sizeBytes || 0)
      if (existingIndex >= 0) totalBytes -= Number(all[existingIndex]?.sizeBytes || 0)
      const projected = totalBytes + size
      if (projected > maxTotalBytes) {
        const evictable = all
          .filter((r, i) => i !== existingIndex && _safe(r?.cacheKey))
          .sort((a, b) => (Number(a?.lastAccessedAt || 0) - Number(b?.lastAccessedAt || 0)))
        let remaining = projected - maxTotalBytes
        for (const victim of evictable) {
          if (remaining <= 0) break
          try { await backend.delete(victim.cacheKey) } catch { /* ignore */ }
          remaining -= Number(victim?.sizeBytes || 0)
        }
      }
    }
  } catch { /* eviction is best-effort; do not block the write */ }

  try {
    await backend.put(record)
    return true
  } catch (err) {
    // On QuotaExceededError attempt one aggressive evict + retry.
    const name = String(err?.name || '')
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      try {
        const all = await backend.getAll()
        const sorted = (all || [])
          .filter(r => _safe(r?.cacheKey) && r.cacheKey !== cacheKey)
          .sort((a, b) => (Number(a?.lastAccessedAt || 0) - Number(b?.lastAccessedAt || 0)))
        for (const victim of sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4)))) {
          try { await backend.delete(victim.cacheKey) } catch { /* ignore */ }
        }
        await backend.put(record)
        return true
      } catch { /* fall through to false */ }
    }
    return false
  }
}

// Explicit eviction — used when a protected fetch returns 401/403/404 and the
// cached entry is no longer trustworthy.
export async function deleteCachedMedia(identity, { backend = _idbBackend } = {}) {
  const cacheKey = buildMediaCacheKey(identity)
  if (!cacheKey) return false
  try { await backend.delete(cacheKey) ; return true } catch { return false }
}

// Remove every persisted entry belonging to `userId`. Sign-out, account
// switch and account deletion call this.
export async function clearMediaCacheForUser(userId, { backend = _idbBackend } = {}) {
  const uid = _safe(userId)
  if (!uid) return false
  try {
    const all = await backend.getAll()
    if (!Array.isArray(all)) return true
    const targets = all.filter(r => r?.userId === uid && _safe(r?.cacheKey))
    for (const record of targets) {
      try { await backend.delete(record.cacheKey) } catch { /* ignore */ }
    }
    return true
  } catch { return false }
}

// Clear ALL persisted media. Wired to Settings → Clear local cache.
export async function clearAllCachedMedia({ backend = _idbBackend } = {}) {
  try { await backend.clear(); return true } catch { return false }
}

// Test-only introspection: returns a summary of what is stored (no blobs).
export async function summarizeCachedMediaForTests({ backend = _idbBackend } = {}) {
  try {
    const all = await backend.getAll()
    return (all || []).map(r => ({
      cacheKey: r?.cacheKey,
      userId: r?.userId,
      mediaKind: r?.mediaKind,
      privacyScope: r?.privacyScope,
      mediaKey: r?.mediaKey,
      variant: r?.variant,
      sizeBytes: r?.sizeBytes,
      lastAccessedAt: r?.lastAccessedAt,
    }))
  } catch { return [] }
}

// Exposed so the loader (in the same package) can substitute an in-memory
// backend from tests without exposing the module-private singleton.
export function _defaultBackendForTests() { return _idbBackend }

export const _internalsForTests = Object.freeze({
  DB_NAME,
  STORE,
  SCHEMA_VERSION,
})
