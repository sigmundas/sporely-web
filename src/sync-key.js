// Per-record sync identity for web and Android (docs/supabase-sync-contract.md,
// "Per-record sync_key identity").
//
// A sync_key is a random uuid minted locally before the first upload and
// persisted with the queued item, so a retry repeats the same POST. A 23505 on
// the table's *_user_sync_key_uidx means the earlier POST landed: the row is
// fetched by (owner, key), checked and adopted without any PATCH. Any other
// 23505, 23503 or 4xx is a plain error. Web never sends desktop_id.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

export const SYNC_KEY_INDEXES = Object.freeze({
  observations: 'observations_user_sync_key_uidx',
  observation_images: 'observation_images_user_sync_key_uidx',
  spore_measurements: 'spore_measurements_user_sync_key_uidx',
})

export const SYNC_IDENTITY_CONFLICT_CODE = 'sync_identity_conflict'
export const SYNC_IDENTITY_CONFLICT_USER_MESSAGE = 'This item already exists in the cloud with different content. It was not uploaded again and nothing in the cloud was changed.'

export class SyncIdentityConflictError extends Error {
  constructor(table, reason, details = {}) {
    super(`${SYNC_IDENTITY_CONFLICT_USER_MESSAGE} (${table}: ${reason})`)
    this.name = 'SyncIdentityConflictError'
    this.code = SYNC_IDENTITY_CONFLICT_CODE
    this.table = table
    this.reason = reason
    this.fields = Array.isArray(details.fields) ? details.fields : []
  }
}

export function isSyncKey(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

// crypto.randomUUID(), falling back to crypto.getRandomValues (older Android
// WebViews and non-secure contexts lack randomUUID). Never Math.random.
export function mintSyncKey(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') {
    const key = String(cryptoImpl.randomUUID()).toLowerCase()
    if (isSyncKey(key)) return key
  }
  if (typeof cryptoImpl?.getRandomValues !== 'function') {
    throw new Error('No secure random source is available to create a sync key')
  }
  const bytes = new Uint8Array(16)
  cryptoImpl.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Keeps an existing key; mints only when there is none.
export function ensureSyncKey(value, cryptoImpl = globalThis.crypto) {
  return isSyncKey(value) ? value : mintSyncKey(cryptoImpl)
}

// Only a 23505 naming this table's per-owner key index means "adopt". The
// legacy UNIQUE(desktop_id, user_id) and every other constraint are also
// 23505, and stay plain errors.
export function isSyncKeyConflict(error, table) {
  const index = SYNC_KEY_INDEXES[table]
  if (!index || !error) return false
  if (String(error.code || '').trim() !== '23505') return false
  const text = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`
  return new RegExp(`(^|[^a-z0-9_])${index}([^a-z0-9_]|$)`, 'i').test(text)
}

// The owner's row with this key. Filtered by owner in the query and checked
// again here, so adoption can never cross owners.
export async function fetchOwnRowBySyncKey(client, table, { userId, syncKey }) {
  if (!userId || !isSyncKey(syncKey)) throw new Error(`Cannot look up ${table} without an owner and a sync key`)
  const { data, error } = await client
    .from(table)
    .select('*')
    .eq('user_id', userId)
    .eq('sync_key', syncKey)
    .limit(2)
  if (error) throw error
  const rows = (Array.isArray(data) ? data : [])
    .filter(row => String(row?.user_id || '') === String(userId) && row?.sync_key === syncKey)
  if (rows.length !== 1) {
    throw new Error(`Could not read back the existing ${table} row for this upload; it will be retried`)
  }
  return rows[0]
}

function _canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(_canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${_canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function _isNumeric(value) {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
}

// Columns stored as `real` (float4), which round-trip a JS double with float4
// precision. Every other number (double precision coordinates, integers)
// must match at double precision.
export const SYNC_FLOAT4_FIELDS = Object.freeze({
  observations: Object.freeze(['gps_altitude', 'gps_accuracy']),
  observation_images: Object.freeze([]),
})

// Supabase runs Postgres with extra_float_digits = 0, so the server prints a
// double with 15 and a real with 6 significant digits (DBL_DIG / FLT_DIG): a
// stored 62.34566944444445 reads back as 62.3456694444444. A value equals the
// stored one when it prints the same at that precision; any difference the
// server can show still differs.
function _sameFloat8(a, b) {
  return a === b || a.toPrecision(15) === b.toPrecision(15)
}

function _sameFloat4(a, b) {
  return Math.fround(a) === Math.fround(b) || Math.fround(a).toPrecision(6) === b.toPrecision(6)
}

function _sameValue(sent, stored, float4 = false) {
  if (sent === null || sent === undefined) return stored === null || stored === undefined
  if (stored === null || stored === undefined) return false
  if (typeof sent === 'boolean' || typeof stored === 'boolean') return sent === stored
  if ((typeof sent === 'number' || typeof stored === 'number') && _isNumeric(sent) && _isNumeric(stored)) {
    return float4 ? _sameFloat4(Number(sent), Number(stored)) : _sameFloat8(Number(sent), Number(stored))
  }
  if (typeof sent === 'string' && typeof stored === 'string') {
    if (sent === stored) return true
    if (DATE_ONLY_RE.test(stored) && DATE_TIME_RE.test(sent)) return sent.slice(0, 10) === stored
    if (DATE_TIME_RE.test(sent) && DATE_TIME_RE.test(stored)) {
      const a = Date.parse(sent)
      const b = Date.parse(stored)
      return Number.isFinite(a) && a === b
    }
    return false
  }
  if (typeof sent === 'object' && typeof stored === 'object') return _canonicalJson(sent) === _canonicalJson(stored)
  return false
}

// Fields of the sent payload whose stored value differs. Fields the row does
// not have (a column the target lacks) and explicitly ignored fields are not
// compared.
export function syncRowDifferences(sentPayload, row, { table = null, ignore = [] } = {}) {
  const skip = new Set(['id', 'sync_key', ...ignore])
  const float4 = new Set(SYNC_FLOAT4_FIELDS[table] || [])
  const differing = []
  for (const [field, sent] of Object.entries(sentPayload || {})) {
    if (skip.has(field) || sent === undefined) continue
    if (!row || !Object.prototype.hasOwnProperty.call(row, field)) continue
    if (!_sameValue(sent, row[field], float4.has(field))) differing.push(field)
  }
  return differing
}
