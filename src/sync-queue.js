import { supabase } from './supabase.js'
import { syncObservationMediaKeys, uploadObservationImageVariants } from './images.js'

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

export async function enqueueObservation(obsPayload, imageBlobs) {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  
  // IndexedDB inherently supports saving raw File and Blob objects!
  store.add({ 
    obsPayload, 
    imageBlobs, 
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

export { QUEUE_EVENT }

let isSyncing = false

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
        for (let i = 0; i < item.imageBlobs.length; i++) {
          const blob = item.imageBlobs[i]
          const path = `${item.userId}/${obsId}/${i}_${item.ts}.jpg`
          
          await uploadObservationImageVariants(blob, path)
          await supabase.from('observation_images').insert({ observation_id: obsId, user_id: item.userId, storage_path: path, image_type: 'field', sort_order: i })
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
