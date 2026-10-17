// Persists pending import sessions to IndexedDB so they survive app suspension.
// Blobs are converted to ArrayBuffers for storage (Blobs themselves aren't transferable).
// All async work happens OUTSIDE the IDB transaction to avoid auto-commit.
import { getDefaultVisibility } from './settings.js'
import { normalizeCaptureVisibility } from './visibility.js'
import { debugImagePipeline } from './image-pipeline-debug.js'
import { normalizeIngestMethod } from './observation-shapes.js'
import { normalizeLocationSource } from './location-provenance.js'

const DB_NAME = 'sporely'
const DB_VERSION = 1
const STORE = 'pending_import'

// A blocked open (another connection holds an older version during an
// upgrade) is a failure: waiting for it could stall every later write. If the
// open later succeeds anyway, that late connection is closed at once.
function _open() {
  return new Promise((resolve, reject) => {
    let settled = false
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = ({ target: { result } }) => {
      if (settled) {
        result?.close?.()
        return
      }
      settled = true
      resolve(result)
    }
    req.onerror = ({ target: { error } }) => {
      settled = true
      reject(error)
    }
    req.onblocked = () => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error('IndexedDB open blocked'), { name: 'BlockedError' }))
    }
  })
}

function _txComplete(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
    tx.onabort = () => rej(tx.error || Object.assign(new Error('Transaction aborted'), { name: 'AbortError' }))
  })
}

// Every pending_import write runs through this FIFO chain so writes commit in
// call order: a session snapshot taken before Queue All can never commit after
// the per-group deletes or the final clear. Each operation settles its own
// caller; the chain itself never rejects, so a failed, throwing or blocked
// operation releases the next one.
let _writeChain = Promise.resolve()

export function _enqueueImportStoreWrite(operation) {
  const run = _writeChain.then(() => operation())
  _writeChain = run.then(() => {}, () => {})
  return run
}

// Opens the store, runs `fill(store)` synchronously inside one readwrite
// transaction and waits for it to commit. A synchronous throw from `fill`
// (for example DataCloneError from put()) aborts the transaction so nothing
// it did commits. The connection is closed on every path.
async function _writeTransaction(fill) {
  const db = await _open()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const done = _txComplete(tx)
    try {
      fill(tx.objectStore(STORE))
    } catch (err) {
      done.catch(() => {})
      try { tx.abort() } catch { /* already finished */ }
      throw err
    }
    await done
  } finally {
    db.close()
  }
}

function _blobType(blob, fallback = 'image/jpeg') {
  const type = String(blob?.type || '').trim()
  return type || fallback
}

// Returns true when the sessions were written, false when the write failed.
// Never throws: callers keep the in-memory sessions either way, and must
// surface a false result to the user rather than treat it as saved.
export function saveImportSessions(sessions) {
  // Snapshot the sessions now, in call order; the bytes are read before the
  // transaction opens (awaiting inside an IDB transaction auto-commits it).
  const recordsPromise = _buildSessionRecords(sessions)
  recordsPromise.catch(() => {})
  return _enqueueImportStoreWrite(async () => {
    const records = await recordsPromise
    debugImagePipeline('save import sessions', {
      sessionCount: records.length,
      photoCount: records.reduce((sum, record) => sum + (Array.isArray(record.blobs) ? record.blobs.length : 0), 0),
    })
    await _writeTransaction(store => {
      store.clear()
      for (const r of records) store.put(r)
    })
    return true
  }).catch(err => {
    console.warn('saveImportSessions failed:', describePersistError(err))
    return false
  })
}

// Reads every session's fields and file lists synchronously, so the snapshot
// is the state at call time; only the file bytes arrive later.
function _buildSessionRecords(sessions) {
  try {
    return _sessionRecords(sessions)
  } catch (err) {
    return Promise.reject(err)
  }
}

function _sessionRecords(sessions) {
  return Promise.all(sessions.map(async s => ({
      id: s.id,
      ts: s.ts.getTime(),
      locationName: s.locationName || '',
      locationSuggestions: Array.isArray(s.locationSuggestions) ? [...s.locationSuggestions] : [],
      locationLookup: s.locationLookup || null,
      locationLookupKey: s.locationLookupKey || '',
      locationAutoApplied: s.locationAutoApplied || '',
      taxon: s.taxon || null,
      visibility: normalizeCaptureVisibility(s.visibility, getDefaultVisibility()),
      is_draft: s.is_draft !== false,
      location_precision: s.location_precision || 'exact',
      uncertain: s.uncertain || false,
      aiService: s.aiService || null,
      aiActiveService: s.aiActiveService || null,
      aiStale: !!s.aiStale,
      aiRunning: !!s.aiRunning,
      aiCurrentFingerprint: s.aiCurrentFingerprint || '',
      aiRequestedFingerprint: s.aiRequestedFingerprint || '',
      aiAvailabilityFingerprint: s.aiAvailabilityFingerprint || '',
      aiAvailability: s.aiAvailability || {},
      aiPredictions: Array.isArray(s.aiPredictions) ? s.aiPredictions : [],
      aiPredictionsByService: s.aiPredictionsByService || {},
      aiServiceState: s.aiServiceState || {},
      imageMeta: (s.imageMeta || []).map(meta => ({
        aiCropRect: meta?.aiCropRect || null,
        aiCropSourceW: meta?.aiCropSourceW ?? null,
        aiCropSourceH: meta?.aiCropSourceH ?? null,
        aiCropIsCustom: meta?.aiCropIsCustom === true,
        ingestMethod: normalizeIngestMethod(meta?.ingestMethod),
      })),
      sourceItemIds: [...(s.sourceItemIds || [])],
      photoTimes: [...(s.photoTimes || [])],
      photoGps: (s.photoGps || []).map(gps => ({
        lat: gps?.lat ?? null,
        lon: gps?.lon ?? null,
        altitude: gps?.altitude ?? null,
        accuracy: gps?.accuracy ?? null,
        source: normalizeLocationSource(gps?.source),
      })),
      photoDebug: [...(s.photoDebug || [])],
      gpsLat: s.gpsLat ?? null,
      gpsSource: normalizeLocationSource(s.gpsSource),
      gpsLon: s.gpsLon ?? null,
      gpsAltitude: s.gpsAltitude ?? null,
      gpsAccuracy: s.gpsAccuracy ?? null,
      blobTypes: s.files.map(f => _blobType(f)),
      aiBlobTypes: (s.aiFiles || s.files).map(f => _blobType(f)),
      ...await _readSessionBytes([...s.files], [...(s.aiFiles || s.files)]),
    })))
}

async function _readSessionBytes(files, aiFiles) {
  return {
    blobs: await Promise.all(files.map(f => f.arrayBuffer())),
    aiBlobs: await Promise.all(aiFiles.map(f => f.arrayBuffer())),
  }
}

// Removes one group by its key path. Resolves true only once the delete has
// committed, false on any failure (never throws).
export function deleteImportSession(id) {
  return _enqueueImportStoreWrite(async () => {
    debugImagePipeline('delete import session')
    await _writeTransaction(store => { store.delete(id) })
    return true
  }).catch(err => {
    console.warn('deleteImportSession failed:', describePersistError(err))
    return false
  })
}

// DOMException stringifies to "[object DOMException]" in the Android WebView
// console, which hides which operation failed. Log name and message.
export function describePersistError(err) {
  if (!err) return 'unknown error'
  const name = err.name || err.constructor?.name || 'Error'
  return `${name}: ${err.message || String(err)}`
}

export async function loadImportSessions() {
  try {
    const db = await _open()
    let records
    try {
      const tx = db.transaction(STORE, 'readonly')
      records = await new Promise((res, rej) => {
        const req = tx.objectStore(STORE).getAll()
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
    } finally {
      db.close()
    }
    if (!records?.length) return []

    debugImagePipeline('load import sessions', {
      recordCount: records.length,
      photoCount: records.reduce((sum, record) => sum + (Array.isArray(record.blobs) ? record.blobs.length : 0), 0),
    })

    return records
      .sort((a, b) => a.ts - b.ts)
      .map(r => {
        const files = r.blobs.map((ab, index) => new Blob([ab], { type: r.blobTypes?.[index] || 'image/jpeg' }))
        const blobUrls = files.map(b => URL.createObjectURL(b))
        const aiFiles = (r.aiBlobs || r.blobs).map((ab, index) => new Blob([ab], { type: r.aiBlobTypes?.[index] || r.blobTypes?.[index] || 'image/jpeg' }))
        return {
          id: r.id,
          ts: new Date(r.ts),
          locationName: r.locationName,
          locationSuggestions: Array.isArray(r.locationSuggestions) ? [...r.locationSuggestions] : [],
          locationLookup: r.locationLookup || null,
          locationLookupKey: r.locationLookupKey || '',
          locationAutoApplied: r.locationAutoApplied || '',
          taxon: r.taxon,
          visibility: normalizeCaptureVisibility(r.visibility, getDefaultVisibility()),
          is_draft: r.is_draft !== false,
          location_precision: r.location_precision || 'exact',
          uncertain: r.uncertain || false,
          aiService: r.aiService || null,
          aiActiveService: r.aiActiveService || null,
          aiStale: !!r.aiStale,
          aiRunning: !!r.aiRunning,
          aiCurrentFingerprint: r.aiCurrentFingerprint || '',
          aiRequestedFingerprint: r.aiRequestedFingerprint || '',
          aiAvailabilityFingerprint: r.aiAvailabilityFingerprint || '',
          aiAvailability: r.aiAvailability || {},
          aiPredictions: Array.isArray(r.aiPredictions) ? r.aiPredictions : [],
          aiPredictionsByService: r.aiPredictionsByService || {},
          aiServiceState: r.aiServiceState || {},
          files,
          aiFiles,
          blobUrls,
          sourceItemIds: [...(r.sourceItemIds || [])],
          photoTimes: [...(r.photoTimes || [])],
          photoGps: (r.photoGps || []).map(gps => ({
            lat: gps?.lat ?? null,
            lon: gps?.lon ?? null,
            altitude: gps?.altitude ?? null,
            accuracy: gps?.accuracy ?? null,
            source: normalizeLocationSource(gps?.source),
          })),
          photoDebug: [...(r.photoDebug || [])],
          gpsLat: r.gpsLat ?? null,
          gpsSource: normalizeLocationSource(r.gpsSource),
          gpsLon: r.gpsLon ?? null,
          gpsAltitude: r.gpsAltitude ?? null,
          gpsAccuracy: r.gpsAccuracy ?? null,
          imageMeta: (r.imageMeta || []).map(meta => ({
            aiCropRect: meta?.aiCropRect || null,
            aiCropSourceW: meta?.aiCropSourceW ?? null,
            aiCropSourceH: meta?.aiCropSourceH ?? null,
            aiCropIsCustom: meta?.aiCropIsCustom === true,
            ingestMethod: normalizeIngestMethod(meta?.ingestMethod),
          })),
        }
      })
  } catch (err) {
    console.warn('loadImportSessions failed:', err)
    return []
  }
}

export async function clearImportSessions() {
  try {
    await clearImportSessionsStrict()
  } catch (err) {
    console.warn('clearImportSessions failed:', err)
  }
}

// Strict variant for privacy-sensitive callers (sign-out, account switch,
// cold-start owner-mismatch purge). Throws on failure so the caller can
// avoid clearing the owner marker until the purge actually succeeded.
export function clearImportSessionsStrict() {
  return _enqueueImportStoreWrite(() => {
    debugImagePipeline('clear import sessions (strict)')
    return _writeTransaction(store => { store.clear() })
  })
}
