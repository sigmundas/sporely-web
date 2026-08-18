// Persistent record of "the account whose local data live on this device and
// was last successfully server-validated from this build".
//
// This is intentionally a **companion** to `local-data-owner.js` (which tracks
// draft-store ownership) — not a replacement. The two must stay consistent:
// on the cached-authenticated boot path we require `record.userId ===
// getLocalDataOwner()` before revealing anything. If they diverge we fail
// closed (clear this record and fall through to the unauthenticated flow).
//
// FAIL-CLOSED CONTRACT
//   * Malformed JSON => return null.
//   * Missing/mismatched schema version => return null (do not attempt to
//     migrate; the caller falls through to unauth).
//   * Missing userId => return null.
//   * Any storage exception => return null (private-mode Safari etc.).
//   * Never throws.
//
// PRIVACY
//   * NEVER store Supabase access/refresh tokens here. Supabase remains
//     authoritative for its credentials. This record only says "the last
//     successful *online* validation of this device saw user X with this
//     profile/plan".
//   * Cleared by SIGNED_OUT and by account-deletion.

const STORAGE_KEY = 'sporely-last-validated-account-v1'
const SCHEMA_VERSION = 1

function _defaultStorage() {
  try { return globalThis.localStorage } catch { return null }
}

function _safeString(value) {
  if (value == null) return ''
  const s = String(value)
  return s.length ? s : ''
}

function _sanitizeProfileSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return { username: null, display_name: null, avatar_url: null }
  }
  return {
    username: _safeString(summary.username) || null,
    display_name: _safeString(summary.display_name) || null,
    avatar_url: _safeString(summary.avatar_url) || null,
  }
}

function _sanitizeCloudPlan(cloudPlan) {
  if (!cloudPlan || typeof cloudPlan !== 'object') return null
  try {
    // Store only serializable, plan-shaped data. Deep-copy defensively so a
    // future in-memory mutation cannot silently mutate the persisted blob.
    return JSON.parse(JSON.stringify(cloudPlan))
  } catch {
    return null
  }
}

export function readLastValidatedAccount(storage = _defaultStorage()) {
  if (!storage) return null
  let raw
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.version !== SCHEMA_VERSION) return null
  const userId = _safeString(parsed.userId)
  if (!userId) return null

  return {
    version: SCHEMA_VERSION,
    userId,
    email: _safeString(parsed.email) || '',
    profileComplete: parsed.profileComplete === true,
    profileSummary: _sanitizeProfileSummary(parsed.profileSummary),
    cloudPlan: (parsed.cloudPlan && typeof parsed.cloudPlan === 'object') ? parsed.cloudPlan : null,
    lastValidatedAt: Number.isFinite(Number(parsed.lastValidatedAt))
      ? Number(parsed.lastValidatedAt)
      : 0,
  }
}

export function writeLastValidatedAccount(record, storage = _defaultStorage()) {
  if (!storage) return false
  const userId = _safeString(record?.userId)
  if (!userId) return false

  const payload = {
    version: SCHEMA_VERSION,
    userId,
    email: _safeString(record.email) || '',
    profileComplete: record.profileComplete === true,
    profileSummary: _sanitizeProfileSummary(record.profileSummary),
    cloudPlan: _sanitizeCloudPlan(record.cloudPlan),
    lastValidatedAt: Number.isFinite(Number(record.lastValidatedAt))
      ? Number(record.lastValidatedAt)
      : Date.now(),
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function clearLastValidatedAccount(storage = _defaultStorage()) {
  if (!storage) return
  try { storage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

// Updates only the cloudPlan field on the existing record — atomically, and
// only if the current stored record still belongs to `userId`. Called after a
// successful ONLINE cloud-plan fetch to keep the persisted plan current
// without overwriting profile/email in the process.
export function updateLastValidatedCloudPlan(userId, cloudPlan, storage = _defaultStorage()) {
  const uid = _safeString(userId)
  if (!uid) return false
  const current = readLastValidatedAccount(storage)
  if (!current) return false
  if (current.userId !== uid) return false
  return writeLastValidatedAccount({
    ...current,
    cloudPlan: _sanitizeCloudPlan(cloudPlan),
    lastValidatedAt: Date.now(),
  }, storage)
}

// Exposed for tests that need to reason about the storage key without
// duplicating it.
export const LAST_VALIDATED_ACCOUNT_STORAGE_KEY = STORAGE_KEY
export const LAST_VALIDATED_ACCOUNT_SCHEMA_VERSION = SCHEMA_VERSION
