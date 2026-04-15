import { supabase } from './supabase.js'
import { insertObservationImage, syncObservationMediaKeys, uploadObservationImageVariants } from './images.js'
import { fetchCloudPlanProfile } from './cloud-plan.js'

const DB_NAME = 'sporely_sync'
const STORE_NAME = 'offline_queue'
const QUEUE_EVENT = 'sporely-sync-queue-changed'

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

function notifyQueueChanged() {
  window.dispatchEvent(new CustomEvent(QUEUE_EVENT))
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

  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  const items = await readAll(store)

  return items
    .filter(item => item?.userId === userId && item?.obsPayload)
    .map(item => ({
      id: `queued-${item.id}`,
      user_id: item.userId,
      date: item.obsPayload.date || null,
      captured_at: item.obsPayload.captured_at || null,
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
    }))
}

export async function deleteQueuedObservation(queueId) {
  const numId = parseInt(String(queueId).replace('queued-', ''), 10)
  if (!numId) return

  const db = await openDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(numId)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
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
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    
    const items = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

    if (!items || !items.length) return

    for (const item of items) {
      if (!navigator.onLine) break
      
      try {
        // 1. Upload parent observation
        let { data: obsData, error } = await supabase.from('observations').insert(item.obsPayload).select('id').single()
        if (error?.message?.includes('captured_at')) {
          const { captured_at: _, ...payloadWithout } = item.obsPayload
          ;({ data: obsData, error } = await supabase.from('observations').insert(payloadWithout).select('id').single())
        }
        if (error) throw error

        // 2. Upload images
        const obsId = obsData.id
        const queuedImages = _normalizeQueuedImages(item.imageEntries || item.imageBlobs)
        let uploadPolicy = _cloudPlanCache.get(item.userId)
        if (!uploadPolicy) {
          uploadPolicy = await fetchCloudPlanProfile(item.userId)
          _cloudPlanCache.set(item.userId, uploadPolicy)
        }
        for (let i = 0; i < queuedImages.length; i++) {
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
        }

        // 3. Purge from offline queue
        await new Promise((res, rej) => {
          const delTx = db.transaction(STORE_NAME, 'readwrite')
          delTx.objectStore(STORE_NAME).delete(item.id)
          delTx.oncomplete = res
          delTx.onerror = rej
        })
        notifyQueueChanged()
      } catch (err) {
        console.error('Background sync failed for queue item', item.id, err)
        break // Network or RLS failure — halt processing to avoid looping errors
      }
    }
  } finally {
    isSyncing = false
  }
}

// Boot logic: Listen for connection restoral, and also check when the file is first evaluated.
window.addEventListener('online', triggerSync)
setTimeout(triggerSync, 1000)
