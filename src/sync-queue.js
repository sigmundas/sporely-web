import { supabase } from './supabase.js'
import { insertObservationImage, syncObservationMediaKeys, prepareImageVariants, uploadPreparedObservationImageVariants } from './images.js'
import { fetchCloudPlanProfile } from './cloud-plan.js'

const DB_NAME = 'sporely_sync'
const STORE_NAME = 'offline_queue'
const QUEUE_EVENT = 'sporely-sync-queue-changed'
const SYNC_SUCCESS_EVENT = 'sporely-sync-upload-complete'
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

function notifySyncSuccess(detail) {
  window.dispatchEvent(new CustomEvent(SYNC_SUCCESS_EVENT, { detail }))
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

async function _setQueueSyncStatus(itemId, stage, extras = {}) {
  try {
    await _updateQueueItem(itemId, current => current ? {
      ...current,
      syncStage: stage,
      syncErrorMessage: extras.syncErrorMessage ?? null,
      syncImageIndex: extras.syncImageIndex ?? current.syncImageIndex ?? null,
      syncImageCount: extras.syncImageCount ?? current.syncImageCount ?? null,
      lastAttemptAt: Date.now(),
    } : current)
  } catch (error) {
    console.warn('Failed to update queue sync status', itemId, error)
  }
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
        uploadBlob: null,
        uploadMeta: null,
        variants: null,
      }
    }
    return {
      blob: entry?.blob instanceof Blob ? entry.blob : null,
      aiCropRect: entry?.aiCropRect || null,
      aiCropSourceW: entry?.aiCropSourceW ?? null,
      aiCropSourceH: entry?.aiCropSourceH ?? null,
      uploadBlob: entry?.uploadBlob instanceof Blob ? entry.uploadBlob : null,
      uploadMeta: entry?.uploadMeta || null,
      variants: entry?.variants || null,
    }
  }).filter(entry => entry.blob instanceof Blob || entry.uploadBlob instanceof Blob)
}

export async function enqueueObservation(obsPayload, imageEntries) {
  const db = await openDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)

  const queuedImages = _normalizeQueuedImages(imageEntries)

  let uploadPolicy = _cloudPlanCache.get(obsPayload.user_id)
  if (!uploadPolicy) {
    uploadPolicy = await fetchCloudPlanProfile(obsPayload.user_id)
    _cloudPlanCache.set(obsPayload.user_id, uploadPolicy)
  }

  const preparedImages = []
  for (const image of queuedImages) {
    if (image.blob instanceof Blob && !image.uploadBlob) {
      const prepared = await prepareImageVariants(image.blob, uploadPolicy)
      preparedImages.push({
        ...image,
        uploadBlob: prepared.uploadBlob,
        uploadMeta: prepared.uploadMeta,
        variants: prepared.variants,
      })
    } else {
      preparedImages.push(image)
    }
  }

  store.add({ 
    obsPayload, 
    imageEntries: preparedImages,
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
      _syncStage: item.syncStage || null,
      _syncErrorMessage: item.syncErrorMessage || null,
      _syncImageIndex: item.syncImageIndex ?? null,
      _syncImageCount: item.syncImageCount ?? null,
    }))
}

export async function deleteQueuedObservation(queueId) {
  const numId = parseInt(String(queueId).replace('queued-', ''), 10)
  if (!numId) return

  await _deleteQueueItem(numId)
  notifyQueueChanged()
}

export { QUEUE_EVENT, SYNC_SUCCESS_EVENT }

let isSyncing = false
const _cloudPlanCache = new Map()

async function _fetchRemoteObservationState(observationId) {
  if (!observationId) {
    return {
      observationExists: false,
      imageRows: [],
      completedIndexes: [],
      confirmed: false,
    }
  }

  const [{ data: observationRows, error: observationError }, { data: imageRows, error: imageError }] = await Promise.all([
    supabase
      .from('observations')
      .select('id, image_key, thumb_key')
      .eq('id', observationId)
      .limit(1),
    supabase
      .from('observation_images')
      .select('id, sort_order, storage_path')
      .eq('observation_id', observationId)
      .order('sort_order', { ascending: true }),
  ])

  if (observationError) throw observationError
  if (imageError) throw imageError

  const observation = Array.isArray(observationRows) ? observationRows[0] || null : null
  const rows = Array.isArray(imageRows) ? imageRows : []
  const completedIndexes = rows
    .map(row => Number(row?.sort_order))
    .filter(index => Number.isInteger(index) && index >= 0)

  const firstRow = rows.find(row => Number(row?.sort_order) === 0 && row?.storage_path)
  if (observation && firstRow && (!observation.image_key || !observation.thumb_key)) {
    await syncObservationMediaKeys(observationId, firstRow.storage_path, { sortOrder: 0 })
  }

  return {
    observationExists: !!observation,
    imageRows: rows,
    completedIndexes,
    confirmed: false,
  }
}

async function _finalizeSyncedQueueItem(item, obsId, queuedImages, reason = 'local') {
  const expectedImageCount = queuedImages.length
  await _setQueueSyncStatus(item.id, 'finalizing', {
    syncImageCount: expectedImageCount,
  })

  const remoteState = await _fetchRemoteObservationState(obsId)
  const confirmed = remoteState.observationExists
    && remoteState.completedIndexes.length >= expectedImageCount

  if (!confirmed) {
    throw new Error(`Sync confirmation incomplete for observation ${obsId}`)
  }

  await _deleteQueueItem(item.id)
  notifyQueueChanged()
  notifySyncSuccess({
    observationId: obsId,
    imageCount: expectedImageCount,
    reason,
  })
}

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
        const queuedImages = _normalizeQueuedImages(item.imageEntries || item.imageBlobs)
        let obsId = item.remoteObservationId || null

        // 1. Upload parent observation once, then persist the remote ID for retries.
        if (!obsId) {
          await _setQueueSyncStatus(item.id, 'saving-observation', {
            syncImageCount: queuedImages.length,
          })
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

        // 2. Reconcile against remote state so a stale local queue can heal itself.
        const completedImageIndexes = new Set(
          Array.isArray(item.completedImageIndexes) ? item.completedImageIndexes : []
        )
        await _setQueueSyncStatus(item.id, 'reconciling', {
          syncImageCount: queuedImages.length,
        })
        const remoteState = await _fetchRemoteObservationState(obsId)
        remoteState.completedIndexes.forEach(index => completedImageIndexes.add(index))
        if (completedImageIndexes.size >= queuedImages.length) {
          await _finalizeSyncedQueueItem(item, obsId, queuedImages, 'remote-reconcile')
          continue
        }
        if (remoteState.completedIndexes.length) {
          await _updateQueueItem(item.id, current => current ? {
            ...current,
            completedImageIndexes: [...completedImageIndexes].sort((a, b) => a - b),
          } : current)
        }

        let uploadPolicy = _cloudPlanCache.get(item.userId)
        if (!uploadPolicy) {
          uploadPolicy = await fetchCloudPlanProfile(item.userId)
          _cloudPlanCache.set(item.userId, uploadPolicy)
        }
        for (let i = 0; i < queuedImages.length; i++) {
          if (completedImageIndexes.has(i)) continue

          const image = queuedImages[i]
          await _setQueueSyncStatus(item.id, 'uploading-image', {
            syncImageIndex: i + 1,
            syncImageCount: queuedImages.length,
          })
          let preparedImage = image
          if (!image.uploadBlob && image.blob instanceof Blob) {
            const prepared = await prepareImageVariants(image.blob, uploadPolicy)
            preparedImage = {
              ...image,
              uploadBlob: prepared.uploadBlob,
              uploadMeta: prepared.uploadMeta,
              variants: prepared.variants,
            }
          }

          const path = `${item.userId}/${obsId}/${i}_${item.ts}.jpg`
          
          const uploadMeta = await uploadPreparedObservationImageVariants(preparedImage, path, {
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
            syncImageIndex: i + 1,
            syncImageCount: queuedImages.length,
          }))
        }

        // 3. Confirm remote DB/image state, then purge from the offline queue.
        await _finalizeSyncedQueueItem(item, obsId, queuedImages, 'local-sync')
      } catch (err) {
        console.error('Background sync failed for queue item', item.id, err)
        await _setQueueSyncStatus(item.id, 'retrying', {
          syncErrorMessage: String(err?.message || err || 'Upload failed'),
        })
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
