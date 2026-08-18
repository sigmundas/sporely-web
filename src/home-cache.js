// Stage B2a: user-scoped persistent cache for the assembled Home read model.
//
// This stores the PRESENTATION-relevant, normalized Home model — not raw
// Supabase responses. The record shape is:
//
//   { version, userId, updatedAt, model }
//
// where `model` is the plain-data Home read model assembled by
// `screens/home.js` (recentFinds / friendRequests / recentComments / stats).
//
// STORAGE: IndexedDB (`sporely-home-cache` / store `home_models`, keyPath
// `userId`). The model can grow with Home; localStorage is deliberately not
// used. One record per user — writes for user B never touch user A's record,
// and reads are keyed strictly by the requested userId.
//
// FAIL-CLOSED CONTRACT
//   * Missing userId => null / false. There is NO "last cache" fallback —
//     a cache read without a user id is a programming error and returns null.
//   * Schema-version mismatch => null (no migration attempt; the caller
//     refreshes online and overwrites).
//   * Record.userId !== requested userId => null (cross-user reads are
//     impossible by keying, but double-check the stored record anyway).
//   * Malformed / non-object model => null.
//   * Any storage exception, including IndexedDB being unavailable => null /
//     false. Cache failures must never block startup.
//   * Reads never hit the network and never throw. A read that exceeds
//     `timeoutMs` resolves null so a hung IndexedDB cannot stall boot.
//
// STALENESS: stale-while-revalidate. There is NO TTL that hides data — a
// week-old model still renders offline. `updatedAt` (+ derived `ageMs`) is
// returned as metadata so callers MAY surface age; expiry is not enforced
// here.
//
// PRIVACY
//   * NEVER stores Supabase access/refresh tokens. The deep scrub below
//     drops token-named keys defensively.
//   * Signed URLs (`?token=` / `/object/sign/`) and session-bound
//     `protectedUrl` values are stripped on write — they are transport
//     state, not durable data. B3 will resolve the persisted stable media
//     `key` to a user-scoped blob store instead.
//   * Cleared per-user on sign-out / account delete / account switch, and
//     entirely by "Clear local cache".

const DB_NAME = 'sporely-home-cache'
const DB_VERSION = 1
const STORE = 'home_models'
const SCHEMA_VERSION = 1
const DEFAULT_READ_TIMEOUT_MS = 4000

// Only these top-level model sections are persisted. Anything else the
// assembler attaches (transient flags, promises, DOM refs) is dropped.
const MODEL_SECTIONS = ['recentFinds', 'friendRequests', 'recentComments', 'stats']

// Keys that must never survive a cache write, wherever they appear.
const FORBIDDEN_KEYS = new Set(['protectedUrl', 'access_token', 'refresh_token', 'accessToken', 'refreshToken', 'token'])

function _looksLikeSignedUrl(value) {
  return /[?&]token=/.test(value) || /\/object\/sign\//.test(value)
}

// Recursively copy plain data, dropping forbidden keys and nulling
// signed-URL strings. Non-plain values (functions, DOM nodes, promises)
// are dropped by the JSON round-trip performed before this walk.
function _scrub(value) {
  if (typeof value === 'string') {
    return _looksLikeSignedUrl(value) ? null : value
  }
  if (Array.isArray(value)) return value.map(_scrub)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue
      out[key] = _scrub(v)
    }
    return out
  }
  return value
}

function _sanitizeModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null
  let plain
  try {
    plain = JSON.parse(JSON.stringify(model))
  } catch {
    return null
  }
  if (!plain || typeof plain !== 'object') return null
  const out = {}
  for (const section of MODEL_SECTIONS) {
    if (plain[section] !== undefined && plain[section] !== null) {
      out[section] = _scrub(plain[section])
    }
  }
  return out
}

// ── IndexedDB backend ────────────────────────────────────────────────────────
// Same open/tx pattern as import-store.js. Every operation opens, acts and
// closes; there is no long-lived connection to leak across process death.

function _open() {
  return new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      reject(err)
      return
    }
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'userId' })
      }
    }
    req.onsuccess = ({ target: { result } }) => resolve(result)
    req.onerror = ({ target: { error } }) => reject(error)
  })
}

function _txComplete(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error)
  })
}

const _idbBackend = {
  async get(userId) {
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readonly')
      return await new Promise((res, rej) => {
        const req = tx.objectStore(STORE).get(userId)
        req.onsuccess = () => res(req.result ?? null)
        req.onerror = () => rej(req.error)
      })
    } finally {
      db.close()
    }
  },
  async put(record) {
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      await _txComplete(tx)
    } finally {
      db.close()
    }
  },
  async delete(userId) {
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(userId)
      await _txComplete(tx)
    } finally {
      db.close()
    }
  },
  async clear() {
    const db = await _open()
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      await _txComplete(tx)
    } finally {
      db.close()
    }
  },
}

function _safeUserId(userId) {
  const s = String(userId ?? '').trim()
  return s || null
}

// ── Public API ───────────────────────────────────────────────────────────────

// Local-only read. Resolves `{ userId, updatedAt, ageMs, model }` or null.
// Never throws; never touches the network; resolves null after `timeoutMs`
// if IndexedDB hangs so boot can proceed.
export async function readHomeCache(userId, { backend = _idbBackend, timeoutMs = DEFAULT_READ_TIMEOUT_MS, now = Date.now } = {}) {
  const uid = _safeUserId(userId)
  if (!uid) return null

  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  let record
  try {
    record = await Promise.race([backend.get(uid), timeout])
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  if (record === undefined) return null // timed out
  if (!record || typeof record !== 'object') return null
  if (record.version !== SCHEMA_VERSION) return null
  if (record.userId !== uid) return null
  if (!record.model || typeof record.model !== 'object' || Array.isArray(record.model)) return null

  const updatedAt = Number.isFinite(Number(record.updatedAt)) ? Number(record.updatedAt) : 0
  return {
    userId: uid,
    updatedAt,
    ageMs: updatedAt ? Math.max(0, now() - updatedAt) : null,
    model: record.model,
  }
}

// Persist a fresh assembled model for `userId`. Returns true on success.
// Sanitizes to plain data, drops unknown sections, scrubs signed URLs and
// token-named keys. Never throws.
export async function writeHomeCache(userId, model, { backend = _idbBackend, now = Date.now } = {}) {
  const uid = _safeUserId(userId)
  if (!uid) return false
  const sanitized = _sanitizeModel(model)
  if (!sanitized || !Object.keys(sanitized).length) return false
  try {
    await backend.put({
      version: SCHEMA_VERSION,
      userId: uid,
      updatedAt: now(),
      model: sanitized,
    })
    return true
  } catch {
    return false
  }
}

export async function clearHomeCache(userId, { backend = _idbBackend } = {}) {
  const uid = _safeUserId(userId)
  if (!uid) return false
  try {
    await backend.delete(uid)
    return true
  } catch {
    return false
  }
}

export async function clearAllHomeCaches({ backend = _idbBackend } = {}) {
  try {
    await backend.clear()
    return true
  } catch {
    return false
  }
}

// Exposed for tests.
export const HOME_CACHE_SCHEMA_VERSION = SCHEMA_VERSION
export const HOME_CACHE_MODEL_SECTIONS = MODEL_SECTIONS
export const _sanitizeModelForTests = _sanitizeModel
