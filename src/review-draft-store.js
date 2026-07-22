// Persists the live (camera) review session to IndexedDB so photos survive
// a crash or force-quit before the observation reaches the sync queue.
// Imported reviews are already covered by import-store.js.
//
// Uses its own database: import-store.js owns the 'sporely' DB at version 1,
// and adding an object store there would force a coordinated version bump.
//
// Blobs are converted to ArrayBuffers for storage; all async work happens
// OUTSIDE the IDB transaction to avoid auto-commit. Every operation degrades
// gracefully (warn, never throw) — persistence failures must not block saves.
import { debugImagePipeline } from './image-pipeline-debug.js'
import { isBlob } from './observation-shapes.js'

const DB_NAME = 'sporely-review-drafts'
const DB_VERSION = 1
const STORE = 'review_draft'
const DRAFT_ID = 'current'
const DRAFT_SCHEMA_VERSION = 1

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

function _blobType(blob, fallback = 'image/jpeg') {
  const type = String(blob?.type || '').trim()
  return type || fallback
}

function _tsMs(value) {
  const ms = value instanceof Date ? value.getTime() : Number(value)
  return Number.isFinite(ms) ? ms : null
}

function _cloneGps(gps) {
  if (!gps) return null
  return {
    lat: gps.lat ?? null,
    lon: gps.lon ?? null,
    accuracy: gps.accuracy ?? null,
    altitude: gps.altitude ?? null,
    timestamp: gps.timestamp ?? null,
  }
}

async function _resolvePhotoBlob(photo) {
  if (isBlob(photo?.blob)) return photo.blob
  if (photo?.blobPromise) {
    try {
      const blob = await photo.blobPromise
      return isBlob(blob) ? blob : null
    } catch {
      return null
    }
  }
  return null
}

export async function saveReviewDraft(draft) {
  try {
    const photos = draft?.photos || []
    const resolvedBlobs = await Promise.all(photos.map(_resolvePhotoBlob))
    const entries = photos
      .map((photo, index) => ({ photo, blob: resolvedBlobs[index] }))
      .filter(entry => isBlob(entry.blob))
    if (!entries.length) return

    const record = {
      id: DRAFT_ID,
      schemaVersion: DRAFT_SCHEMA_VERSION,
      savedAt: Date.now(),
      sessionStartAt: _tsMs(draft.sessionStartAt),
      captureWindowEndAt: _tsMs(draft.captureWindowEndAt),
      sessionFix: _cloneGps(draft.sessionFix),
      captureDraft: draft.captureDraft ? { ...draft.captureDraft } : null,
      locationName: draft.locationName || '',
      photos: entries.map(({ photo }) => ({
        ts: _tsMs(photo.ts),
        gps: _cloneGps(photo.gps),
        emoji: photo.emoji || '📸',
        taxon: photo.taxon ? { ...photo.taxon } : null,
        aiCropRect: photo.aiCropRect || null,
        aiCropSourceW: photo.aiCropSourceW ?? null,
        aiCropSourceH: photo.aiCropSourceH ?? null,
        aiCropIsCustom: photo.aiCropIsCustom === true,
      })),
      blobs: await Promise.all(entries.map(({ blob }) => blob.arrayBuffer())),
      blobTypes: entries.map(({ blob }) => _blobType(blob)),
      aiBlobs: await Promise.all(entries.map(({ photo, blob }) =>
        (isBlob(photo.aiBlob) ? photo.aiBlob : blob).arrayBuffer(),
      )),
      aiBlobTypes: entries.map(({ photo, blob }) => _blobType(isBlob(photo.aiBlob) ? photo.aiBlob : blob)),
    }

    debugImagePipeline('save review draft', { photoCount: record.photos.length })

    const db = await _open()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    await _txComplete(tx)
    db.close()
  } catch (err) {
    console.warn('saveReviewDraft failed:', err)
  }
}

export async function updateReviewDraftFields(fields) {
  try {
    const db = await _open()
    const readTx = db.transaction(STORE, 'readonly')
    const record = await new Promise((res, rej) => {
      const req = readTx.objectStore(STORE).getAll()
      req.onsuccess = () => res((req.result || []).find(r => r.id === DRAFT_ID) || null)
      req.onerror = () => rej(req.error)
    })
    if (!record) {
      db.close()
      return
    }
    if (fields?.captureDraft) record.captureDraft = { ...fields.captureDraft }
    if (fields?.locationName !== undefined) record.locationName = fields.locationName || ''
    record.savedAt = Date.now()
    const writeTx = db.transaction(STORE, 'readwrite')
    writeTx.objectStore(STORE).put(record)
    await _txComplete(writeTx)
    db.close()
  } catch (err) {
    console.warn('updateReviewDraftFields failed:', err)
  }
}

export async function loadReviewDraft() {
  try {
    const db = await _open()
    const tx = db.transaction(STORE, 'readonly')
    const records = await new Promise((res, rej) => {
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    db.close()
    const record = (records || []).find(r => r.id === DRAFT_ID)
    if (!record) return null
    if (record.schemaVersion !== DRAFT_SCHEMA_VERSION) {
      console.warn('Discarding review draft with unknown schema version:', record.schemaVersion)
      await clearReviewDraft()
      return null
    }
    if (!Array.isArray(record.blobs) || !record.blobs.length) return null

    debugImagePipeline('load review draft', { photoCount: record.blobs.length })

    return {
      savedAt: record.savedAt ?? null,
      sessionStartAt: record.sessionStartAt ?? null,
      captureWindowEndAt: record.captureWindowEndAt ?? null,
      sessionFix: _cloneGps(record.sessionFix),
      captureDraft: record.captureDraft ? { ...record.captureDraft } : null,
      locationName: record.locationName || '',
      photos: record.blobs.map((buffer, index) => {
        const meta = record.photos?.[index] || {}
        const blob = new Blob([buffer], { type: record.blobTypes?.[index] || 'image/jpeg' })
        const aiBuffer = record.aiBlobs?.[index]
        return {
          blob,
          aiBlob: aiBuffer
            ? new Blob([aiBuffer], { type: record.aiBlobTypes?.[index] || record.blobTypes?.[index] || 'image/jpeg' })
            : blob,
          blobPromise: null,
          gps: _cloneGps(meta.gps),
          ts: meta.ts != null ? new Date(meta.ts) : new Date(),
          emoji: meta.emoji || '📸',
          taxon: meta.taxon ? { ...meta.taxon } : null,
          aiCropRect: meta.aiCropRect || null,
          aiCropSourceW: meta.aiCropSourceW ?? null,
          aiCropSourceH: meta.aiCropSourceH ?? null,
          aiCropIsCustom: meta.aiCropIsCustom === true,
        }
      }),
    }
  } catch (err) {
    console.warn('loadReviewDraft failed:', err)
    return null
  }
}

export async function clearReviewDraft() {
  try {
    debugImagePipeline('clear review draft')
    const db = await _open()
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    await _txComplete(tx)
    db.close()
  } catch (err) {
    console.warn('clearReviewDraft failed:', err)
  }
}
