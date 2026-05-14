// Persists pending import sessions to IndexedDB so they survive app suspension.
// Blobs are converted to ArrayBuffers for storage (Blobs themselves aren't transferable).
// All async work happens OUTSIDE the IDB transaction to avoid auto-commit.
import { getDefaultVisibility } from './settings.js'
import { normalizeCaptureVisibility } from './visibility.js'

const DB_NAME = 'sporely'
const DB_VERSION = 1
const STORE = 'pending_import'

function _open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
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

export async function saveImportSessions(sessions) {
  try {
    // Convert all blobs → ArrayBuffers before opening the transaction
    // (awaiting inside an IDB transaction causes auto-commit)
    const records = await Promise.all(sessions.map(async s => ({
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
      imageMeta: (s.imageMeta || []).map(meta => ({
        aiCropRect: meta?.aiCropRect || null,
        aiCropSourceW: meta?.aiCropSourceW ?? null,
        aiCropSourceH: meta?.aiCropSourceH ?? null,
      })),
      sourceItemIds: [...(s.sourceItemIds || [])],
      photoTimes: [...(s.photoTimes || [])],
      photoGps: (s.photoGps || []).map(gps => ({
        lat: gps?.lat ?? null,
        lon: gps?.lon ?? null,
        altitude: gps?.altitude ?? null,
      })),
      photoDebug: [...(s.photoDebug || [])],
      gpsLat: s.gpsLat ?? null,
      gpsLon: s.gpsLon ?? null,
      gpsAltitude: s.gpsAltitude ?? null,
      gpsAccuracy: s.gpsAccuracy ?? null,
      blobs: await Promise.all(s.files.map(f => f.arrayBuffer())),
      aiBlobs: await Promise.all((s.aiFiles || s.files).map(f => f.arrayBuffer())),
    })))

    const db = await _open()
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.clear()
    for (const r of records) store.put(r)
    await _txComplete(tx)
    db.close()
  } catch (err) {
    console.warn('saveImportSessions failed:', err)
  }
}

export async function loadImportSessions() {
  try {
    const db = await _open()
    const tx = db.transaction(STORE, 'readonly')
    const records = await new Promise((res, rej) => {
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    db.close()
    if (!records?.length) return []

    return records
      .sort((a, b) => a.ts - b.ts)
      .map(r => {
        const files = r.blobs.map(ab => new Blob([ab], { type: 'image/jpeg' }))
        const blobUrls = files.map(b => URL.createObjectURL(b))
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
          files,
          aiFiles: (r.aiBlobs || r.blobs).map(ab => new Blob([ab], { type: 'image/jpeg' })),
          blobUrls,
          sourceItemIds: [...(r.sourceItemIds || [])],
          photoTimes: [...(r.photoTimes || [])],
          photoGps: (r.photoGps || []).map(gps => ({
            lat: gps?.lat ?? null,
            lon: gps?.lon ?? null,
            altitude: gps?.altitude ?? null,
          })),
          photoDebug: [...(r.photoDebug || [])],
          gpsLat: r.gpsLat ?? null,
          gpsLon: r.gpsLon ?? null,
          gpsAltitude: r.gpsAltitude ?? null,
          gpsAccuracy: r.gpsAccuracy ?? null,
          imageMeta: (r.imageMeta || []).map(meta => ({
            aiCropRect: meta?.aiCropRect || null,
            aiCropSourceW: meta?.aiCropSourceW ?? null,
            aiCropSourceH: meta?.aiCropSourceH ?? null,
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
    const db = await _open()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await _txComplete(tx)
    db.close()
  } catch (err) {
    console.warn('clearImportSessions failed:', err)
  }
}
