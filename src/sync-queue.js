import { supabase } from './supabase.js'
import { insertObservationImage, syncObservationMediaKeys, uploadObservationImageVariants } from './images.js'
import { fetchCloudPlanProfile } from './cloud-plan.js'

const DB_NAME = 'sporely_sync'
const STORE_NAME = 'offline_queue'
const QUEUE_EVENT = 'sporely-sync-queue-changed'
const RETRY_DELAY_MS = 30_000
const _queuedPreviewUrls = new Map()
let _retryTimer = null

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function readAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

function readOne(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

function notifyQueueChanged() {
  window.dispatchEvent(new CustomEvent(QUEUE_EVENT))
}

function _revokeQueuedPreviewUrl(id) {
  const existing = _queuedPreviewUrls.get(id)
  if (!existing) return
  URL.revokeObjectURL(existing)
  _queuedPreviewUrls.delete(id)
}

function _previewUrlForQueueItem(item) {
  const id = item?.id
  if (!id) return null

  const existing = _queuedPreviewUrls.get(id)
  if (existing) return existing

  const firstBlob = _normalizeQueuedImages(item?.imageEntries || item?.imageBlobs)[0]?.blob
  if (!(firstBlob instanceof Blob)) return null

  const nextUrl = URL.createObjectURL(firstBlob)
  _queuedPreviewUrls.set(id, nextUrl)
  return nextUrl
}

function _pruneQueuedPreviewUrls(activeIds) {
  const keep = new Set(activeIds || [])
  for (const id of _queuedPreviewUrls.keys()) {
    if (!keep.has(id)) _revokeQueuedPreviewUrl(id)
  }
}

async function _readQueueItems() {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  return readAll(store)
}

async function _updateQueueItem(itemId, updater) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)

    readOne(store, itemId)
      .then(current => {
        if (!current) {
          resolve(null)
          return
        }
        const next = updater(current)
        store.put(next)
        tx.oncomplete = () => resolve(next)
        tx.onerror = () => reject(tx.error)
      })
      .catch(reject)
  })
}

async function _deleteQueueItem(itemId) {
  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(itemId)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  _revokeQueuedPreviewUrl(itemId)
}

function _scheduleSyncRetry() {
  if (_retryTimer || !navigator.onLine) return
  _retryTimer = window.setTimeout(() => {
    _retryTimer = null
    triggerSync()
  }, RETRY_DELAY_MS)
}

function _normalizeQueuedImages(imageEntries) {
  return (imageEntries || []).map(entry => {
    if (entry instanceof Blob) {
      return {
        blob: entry,
        aiCropRect: null,
        aiCropSourceW: null,
        aiCropSourceH: null,
      }
    }
    return {
      blob: entry?.blob instanceof Blob ? entry.blob : null,
      aiCropRect: entry?.aiCropRect || null,
      aiCropSourceW: entry?.aiCropSourceW ?? null,
      aiCropSourceH: entry?.aiCropSourceH ?? null,
    }
  }).filter(entry => entry.blob instanceof Blob)
}

export async function enqueueObservation(obsPayload, imageEntries) {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)

  const queuedImages = _normalizeQueuedImages(imageEntries)

  store.add({ 
    obsPayload, 
    imageEntries: queuedImages,
    userId: obsPayload.user_id,
    ts: Date.now() 
  })

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      notifyQueueChanged()
      triggerSync()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function getQueuedObservations(userId) {
  if (!userId) return []

  const items = await _readQueueItems()
  const filteredItems = items.filter(item => item?.userId === userId && item?.obsPayload)
  _pruneQueuedPreviewUrls(filteredItems.map(item => item.id))

  return filteredItems
    .map(item => ({
      id: `queued-${item.id}`,
      user_id: item.userId,
      date: item.obsPayload.date || null,
      captured_at: item.obsPayload.captured_at || null,
      created_at: item.obsPayload.created_at || null,
      genus: item.obsPayload.genus || null,
      species: item.obsPayload.species || null,
      common_name: item.obsPayload.common_name || null,
      location: item.obsPayload.location || null,
      notes: item.obsPayload.notes || null,
      uncertain: !!item.obsPayload.uncertain,
      visibility: item.obsPayload.visibility || 'friends',
      gps_latitude: item.obsPayload.gps_latitude ?? null,
      gps_longitude: item.obsPayload.gps_longitude ?? null,
      source_type: item.obsPayload.source_type || 'personal',
      _pendingSync: true,
      _queuedAt: item.ts || Date.now(),
      _pendingPreviewUrl: _previewUrlForQueueItem(item),
      _pendingPhotoCount: _normalizeQueuedImages(item.imageEntries || item.imageBlobs).length,
      _remoteObservationId: item.remoteObservationId || null,
    }))
}

export async function deleteQueuedObservation(queueId) {
  const numId = parseInt(String(queueId).replace('queued-', ''), 10)
  if (!numId) return

  await _deleteQueueItem(numId)
  notifyQueueChanged()
}

export { QUEUE_EVENT }

let isSyncing = false
const _cloudPlanCache = new Map()

export async function triggerSync() {
  if (isSyncing || !navigator.onLine) return
  
  // Ensure the user hasn't logged out while items were pending
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return

  isSyncing = true

  try {
    const items = await _readQueueItems()

    if (!items || !items.length) return

    for (const item of items) {
      if (!navigator.onLine) break
      
      try {
        let obsId = item.remoteObservationId || null

        // 1. Upload parent observation once, then persist the remote ID for retries.
        if (!obsId) {
          let { data: obsData, error } = await supabase.from('observations').insert(item.obsPayload).select('id').single()
          if (error?.message?.includes('captured_at')) {
            const { captured_at: _, ...payloadWithout } = item.obsPayload
            ;({ data: obsData, error } = await supabase.from('observations').insert(payloadWithout).select('id').single())
          }
          if (error) throw error

          obsId = obsData.id
          const updatedItem = await _updateQueueItem(item.id, current => ({
            ...current,
            remoteObservationId: obsId,
          }))
          if (!updatedItem) continue
        }

        // 2. Upload images
        const queuedImages = _normalizeQueuedImages(item.imageEntries || item.imageBlobs)
        const completedImageIndexes = new Set(
          Array.isArray(item.completedImageIndexes) ? item.completedImageIndexes : []
        )
        let uploadPolicy = _cloudPlanCache.get(item.userId)
        if (!uploadPolicy) {
          uploadPolicy = await fetchCloudPlanProfile(item.userId)
          _cloudPlanCache.set(item.userId, uploadPolicy)
        }
        for (let i = 0; i < queuedImages.length; i++) {
          if (completedImageIndexes.has(i)) continue

          const image = queuedImages[i]
          const blob = image.blob
          const path = `${item.userId}/${obsId}/${i}_${item.ts}.jpg`
          
          const uploadMeta = await uploadObservationImageVariants(blob, path, {
            uploadPolicy,
            uploadOrigin: 'web',
          })
          await insertObservationImage({
            observation_id: obsId,
            user_id: item.userId,
            storage_path: path,
            image_type: 'field',
            sort_order: i,
            aiCropRect: image.aiCropRect,
            aiCropSourceW: image.aiCropSourceW,
            aiCropSourceH: image.aiCropSourceH,
            ...uploadMeta,
          })
          await syncObservationMediaKeys(obsId, path, { sortOrder: i })

          completedImageIndexes.add(i)
          await _updateQueueItem(item.id, current => ({
            ...current,
            remoteObservationId: obsId,
            completedImageIndexes: [...completedImageIndexes].sort((a, b) => a - b),
          }))
        }

        // 3. Purge from offline queue
        await _deleteQueueItem(item.id)
        notifyQueueChanged()
      } catch (err) {
        console.error('Background sync failed for queue item', item.id, err)
        _scheduleSyncRetry()
        break // Network or RLS failure — halt processing to avoid looping errors
      }
    }
  } finally {
    isSyncing = false
  }
}

// Boot logic: Listen for connection restoral, and also check when the file is first evaluated.
window.addEventListener('online', triggerSync)
window.addEventListener('focus', triggerSync)
window.addEventListener('pageshow', triggerSync)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') triggerSync()
})
setTimeout(triggerSync, 1000)
