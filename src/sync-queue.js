import { supabase } from './supabase.js'
import { getSharedAuthSession } from './auth-session.js'
import { insertObservationImage, syncObservationMediaKeys, prepareImageVariants, uploadPreparedObservationImageVariants, imageExtensionForMimeType, buildObservationImageStoragePath } from './images.js'
import { CLOUD_UPLOAD_POLICY_CHANGED_EVENT, fetchCloudPlanProfile } from './cloud-plan.js'
import { canSyncOnCurrentConnection, onConnectionTypeChange } from './settings.js'
import { BackgroundTask } from '@capawesome/capacitor-background-task'
import { isNativeApp } from './platform.js'
import { normalizeObservationVisibility, toCloudVisibility } from './visibility.js'

const DB_NAME = 'sporely_sync'
const STORE_NAME = 'offline_queue'
const QUEUE_EVENT = 'sporely-sync-queue-changed'
const SYNC_SUCCESS_EVENT = 'sporely-sync-upload-complete'
const RETRY_DELAY_MS = 30_000
const BLOCKED_QUEUE_REASON = 'queued item belongs to a different auth user'
const BLOCKED_QUEUE_STAGE = 'blocked'
const QUEUE_NAMESPACE_PREFIX = 'sporely-upload-queue'
const _queuedPreviewUrls = new Map()
let _retryTimer = null
let _currentSyncPromise = null
const _activeQueueOperations = new Set()
let _backgroundTaskRegistered = false
const _devWarnedBlockedQueueItems = new Set()

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

function _isDebugQueueEnabled() {
  try {
    return import.meta.env?.DEV || globalThis.localStorage?.getItem('sporely-debug-sync-queue') === 'true'
  } catch (_) {
    return import.meta.env?.DEV || false
  }
}

function _debugQueue(message, details = {}) {
  if (!_isDebugQueueEnabled()) return
  console.debug(`[sync-queue] ${message}`, details)
}

function _normalizeQueueUserId(value) {
  return String(value || '').trim()
}

function _queueKeyForUser(userId) {
  const normalized = _normalizeQueueUserId(userId) || 'anonymous'
  return `${QUEUE_NAMESPACE_PREFIX}:${normalized}`
}

function _queueUserFromItem(item) {
  return _normalizeQueueUserId(item?.queueUserId || item?.userId || item?.obsPayload?.user_id)
}

function _isBlockedQueueItem(item) {
  return String(item?.syncStage || '').trim() === BLOCKED_QUEUE_STAGE
}

async function _markQueueItemBlocked(itemId, reason, extras = {}) {
  await _updateQueueItem(itemId, current => current ? {
    ...current,
    syncStage: BLOCKED_QUEUE_STAGE,
    syncErrorMessage: reason,
    blockedReason: reason,
    blockedAt: Date.now(),
    blockedByUserId: extras.blockedByUserId || null,
    blockedQueueUserId: extras.blockedQueueUserId || null,
    syncImageIndex: extras.syncImageIndex ?? current.syncImageIndex ?? null,
    syncImageCount: extras.syncImageCount ?? current.syncImageCount ?? null,
    lastAttemptAt: Date.now(),
  } : current)
}

function _warnBlockedQueueItemOnce(itemId, details) {
  if (_devWarnedBlockedQueueItems.has(itemId)) return
  _devWarnedBlockedQueueItems.add(itemId)
  console.warn('Skipping blocked queued upload:', details)
}

function _isArrayBuffer(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function _blobFromStoredBytes(bytes, type = 'image/jpeg') {
  if (!_isArrayBuffer(bytes)) return null
  const data = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Blob([data], { type: type || 'image/jpeg' })
}

async function _blobToStoredBytes(blob) {
  if (!_isBlob(blob)) return null
  return {
    bytes: await blob.arrayBuffer(),
    type: blob.type || 'image/jpeg',
    size: blob.size || 0,
  }
}

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

function _trackQueueOperation(promise) {
  const tracked = Promise.resolve(promise).finally(() => {
    _activeQueueOperations.delete(tracked)
  })
  _activeQueueOperations.add(tracked)
  return tracked
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

  const entry = _normalizeQueuedImages(item?.imageEntries || item?.imageBlobs)[0]
  if (!entry) return null
  const blobToUrl = entry.uploadBlob || entry.blob
  if (!_isBlob(blobToUrl)) return null

  const nextUrl = URL.createObjectURL(blobToUrl)
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
    let nextValue = null
    const req = store.get(itemId)
    req.onerror = () => reject(req.error || tx.error)
    req.onsuccess = () => {
      try {
        const current = req.result || null
        if (!current) return
        nextValue = updater(current)
        if (nextValue) store.put(nextValue)
      } catch (error) {
        tx.abort()
        reject(error)
      }
    }
    tx.oncomplete = () => resolve(nextValue)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('Queue update aborted'))
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
    if (_isBlob(entry)) {
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
    const realBlob = _isBlob(entry?.blob)
      ? entry.blob
      : (_isBlob(entry?.file)
        ? entry.file
        : _blobFromStoredBytes(entry?.blobBytes || entry?.originalBytes, entry?.blobType || entry?.originalType))
    const uploadBlob = _isBlob(entry?.uploadBlob)
      ? entry.uploadBlob
      : _blobFromStoredBytes(entry?.uploadBytes, entry?.uploadType)
    const thumbBlob = _isBlob(entry?.variants?.thumb)
      ? entry.variants.thumb
      : _blobFromStoredBytes(entry?.variantBytes?.thumb, entry?.variantTypes?.thumb)
    return {
      blob: realBlob,
      aiCropRect: entry?.aiCropRect || null,
      aiCropSourceW: entry?.aiCropSourceW ?? null,
      aiCropSourceH: entry?.aiCropSourceH ?? null,
      uploadBlob,
      uploadMeta: entry?.uploadMeta || null,
      variants: thumbBlob ? { thumb: thumbBlob } : (entry?.variants || null),
    }
  }).filter(entry => _isBlob(entry.blob) || _isBlob(entry.uploadBlob))
}

async function _serializeQueuedImagesForStorage(images) {
  const serialized = []
  for (const image of images || []) {
    serialized.push(await _serializeQueuedImageForStorage(image))
  }
  return serialized
}

async function _serializeQueuedImageForStorage(image) {
  const upload = await _blobToStoredBytes(image?.uploadBlob)
  const thumb = await _blobToStoredBytes(image?.variants?.thumb)
  const original = upload ? null : await _blobToStoredBytes(image?.blob)
  return {
    aiCropRect: image?.aiCropRect || null,
    aiCropSourceW: image?.aiCropSourceW ?? null,
    aiCropSourceH: image?.aiCropSourceH ?? null,
    blobBytes: original?.bytes || null,
    blobType: original?.type || null,
    blobSize: original?.size || null,
    uploadBytes: upload?.bytes || null,
    uploadType: upload?.type || null,
    uploadSize: upload?.size || null,
    uploadMeta: image?.uploadMeta || null,
    variantBytes: thumb ? { thumb: thumb.bytes } : null,
    variantTypes: thumb ? { thumb: thumb.type } : null,
    variantSizes: thumb ? { thumb: thumb.size } : null,
  }
}

async function _persistPreparedQueuedImage(itemId, index, preparedImage) {
  const storedImage = await _serializeQueuedImageForStorage(preparedImage)
  await _updateQueueItem(itemId, current => {
    if (!current) return current
    const entries = [...(current.imageEntries || current.imageBlobs || [])]
    entries[index] = {
      ...(entries[index] || {}),
      ...storedImage,
    }
    return {
      ...current,
      imageEntries: entries,
    }
  })
}

export async function enqueueObservation(obsPayload, imageEntries) {
  return _trackQueueOperation(_enqueueObservation(obsPayload, imageEntries))
}

async function _enqueueObservation(obsPayload, imageEntries) {
  const queuedImages = _normalizeQueuedImages(imageEntries)
  const persistentImages = await _serializeQueuedImagesForStorage(queuedImages)
  const db = await openDB()
  const queueUserId = _normalizeQueueUserId(obsPayload.user_id)
  const queueItem = {
    obsPayload,
    imageEntries: persistentImages,
    userId: queueUserId,
    queueUserId,
    queueKey: _queueKeyForUser(queueUserId),
    ts: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.add(queueItem)

    req.onerror = () => reject(req.error || tx.error)
    tx.oncomplete = () => {
      notifyQueueChanged()
      triggerSync()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('Queue write aborted'))
  })
}

export async function getQueuedObservations(userId) {
  if (!userId) return []

  const items = await _readQueueItems()
  const queueKey = _queueKeyForUser(userId)
  const filteredItems = items.filter(item => {
    const itemQueueUserId = _queueUserFromItem(item)
    const itemQueueKey = String(item?.queueKey || '').trim()
    return (itemQueueKey === queueKey || itemQueueUserId === userId) && item?.obsPayload
  })
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
      visibility: normalizeObservationVisibility(item.obsPayload.visibility),
      is_draft: item.obsPayload.is_draft !== false,
      location_precision: item.obsPayload.location_precision || 'exact',
      gps_latitude: item.obsPayload.gps_latitude ?? item.obsPayload.gpsLat ?? null,
      gps_longitude: item.obsPayload.gps_longitude ?? item.obsPayload.gpsLon ?? null,
      gps_altitude: item.obsPayload.gps_altitude ?? item.obsPayload.gpsAltitude ?? null,
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
      _queueKey: item.queueKey || _queueKeyForUser(item.userId),
    }))
}

export async function deleteQueuedObservation(queueId) {
  const numId = parseInt(String(queueId).replace('queued-', ''), 10)
  if (!numId) return

  await _deleteQueueItem(numId)
  notifyQueueChanged()
}

export async function deleteQueuedObservationsForUser(userId) {
  const queueKey = _queueKeyForUser(userId)
  const items = await _readQueueItems()
  const targets = items.filter(item => {
    const itemQueueUserId = _queueUserFromItem(item)
    const itemQueueKey = String(item?.queueKey || '').trim()
    return itemQueueKey === queueKey || itemQueueUserId === userId
  })

  for (const item of targets) {
    await _deleteQueueItem(item.id)
  }
  if (targets.length) notifyQueueChanged()
  return targets.length
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

async function _findRemoteObservationForQueueItem(item) {
  const payload = item?.obsPayload || {}
  const capturedAt = String(payload.captured_at || '').trim()
  const userId = String(item?.userId || payload.user_id || '').trim()
  if (!capturedAt || !userId) return null

  const { data, error } = await supabase
    .from('observations')
    .select('id')
    .eq('user_id', userId)
    .eq('captured_at', capturedAt)
    .order('id', { ascending: false })
    .limit(1)

  if (error) {
    if (error?.message?.includes('captured_at')) return null
    throw error
  }

  return Array.isArray(data) ? data[0]?.id || null : null
}

async function _runSyncQueue() {
  if (!navigator.onLine || !canSyncOnCurrentConnection()) return

  const session = await getSharedAuthSession({ refresh: true })
  if (!session?.user?.id) return
  const authUserId = _normalizeQueueUserId(session.user.id)

  const items = await _readQueueItems()
  if (!items || !items.length) return

  for (const item of items) {
    if (!navigator.onLine) break

    try {
      const queuedImages = _normalizeQueuedImages(item.imageEntries || item.imageBlobs)
      const queueUserId = _queueUserFromItem(item)
      const queueKey = String(item?.queueKey || '').trim() || _queueKeyForUser(queueUserId)
      const observationPayload = item?.obsPayload || {}
      const observationOwnerFieldName = Object.prototype.hasOwnProperty.call(observationPayload, 'user_id')
        ? 'user_id'
        : (Object.prototype.hasOwnProperty.call(observationPayload, 'owner_id')
          ? 'owner_id'
          : (Object.prototype.hasOwnProperty.call(observationPayload, 'created_by') ? 'created_by' : null))
      const observationOwnerValue = observationOwnerFieldName ? observationPayload[observationOwnerFieldName] : null
      const normalizedObservationOwnerValue = _normalizeQueueUserId(observationOwnerValue)
      const action = _isBlockedQueueItem(item)
        ? 'skip'
        : (item.remoteObservationId ? 'upload' : 'insert observation')
      _debugQueue('before processing item', {
        itemId: item.id,
        itemType: observationPayload ? 'observation' : 'unknown',
        authUserId,
        queueUserId,
        queueKey,
        observationOwnerFieldName,
        observationOwnerValue: normalizedObservationOwnerValue || null,
        hasSession: Boolean(session),
        action,
      })

      if (_isBlockedQueueItem(item)) {
        continue
      }

      if (!queueUserId) {
        const reason = 'queued item is missing an auth user id'
        await _markQueueItemBlocked(item.id, reason, {
          blockedByUserId: authUserId,
          blockedQueueUserId: null,
        })
        _warnBlockedQueueItemOnce(item.id, { itemId: item.id, authUserId, queueUserId, reason })
        continue
      }

      if (queueUserId !== authUserId) {
        await _markQueueItemBlocked(item.id, BLOCKED_QUEUE_REASON, {
          blockedByUserId: authUserId,
          blockedQueueUserId: queueUserId,
        })
        _warnBlockedQueueItemOnce(item.id, {
          itemId: item.id,
          authUserId,
          queueUserId,
        })
        continue
      }

      if (normalizedObservationOwnerValue && normalizedObservationOwnerValue !== authUserId) {
        const reason = 'queued observation owner does not match the current auth user'
        await _markQueueItemBlocked(item.id, reason, {
          blockedByUserId: authUserId,
          blockedQueueUserId: queueUserId,
        })
        console.warn('Skipping queued upload with mismatched observation owner:', {
          itemId: item.id,
          authUserId,
          queueUserId,
          observationOwnerFieldName,
          observationOwnerValue: normalizedObservationOwnerValue,
        })
        continue
      }

      let obsId = item.remoteObservationId || null
      let repairedPayload = null

      if (!obsId) {
        obsId = await _findRemoteObservationForQueueItem({
          ...item,
          userId: queueUserId,
          obsPayload: {
            ...observationPayload,
            user_id: authUserId,
          },
        })
        if (obsId) {
          const updatedItem = await _updateQueueItem(item.id, current => current ? {
            ...current,
            remoteObservationId: obsId,
            syncRecoveredRemoteIdAt: Date.now(),
          } : current)
          if (!updatedItem) continue
        }
      }

      // 1. Upload parent observation once, then persist the remote ID for retries.
      if (!obsId) {
        await _setQueueSyncStatus(item.id, 'saving-observation', {
          syncImageCount: queuedImages.length,
        })

        repairedPayload = {
          ...observationPayload,
          user_id: authUserId,
          visibility: toCloudVisibility(observationPayload.visibility, 'public'),
        }
        delete repairedPayload.owner_id
        delete repairedPayload.created_by
        delete repairedPayload.userId
        delete repairedPayload.queueUserId
        delete repairedPayload.queueKey
        delete repairedPayload.remoteObservationId
        if (repairedPayload.gpsLat !== undefined) {
          repairedPayload.gps_latitude = repairedPayload.gpsLat
          delete repairedPayload.gpsLat
        }
        if (repairedPayload.gpsLon !== undefined) {
          repairedPayload.gps_longitude = repairedPayload.gpsLon
          delete repairedPayload.gpsLon
        }
        if (repairedPayload.gpsAltitude !== undefined) {
          repairedPayload.gps_altitude = repairedPayload.gpsAltitude
          delete repairedPayload.gpsAltitude
        }
        if (repairedPayload.photoGps !== undefined) {
          delete repairedPayload.photoGps
        }

        _debugQueue('observation insert payload', {
          itemId: item.id,
          authUserId,
          queueUserId,
          observationOwnerFieldName: 'user_id',
          observationOwnerValue: authUserId,
          payloadKeys: Object.keys(repairedPayload).sort(),
        })

        let { data: obsData, error } = await supabase.from('observations').insert(repairedPayload).select('id').single()
        if (error?.message?.includes('captured_at')) {
          const { captured_at: _capturedAt, ...payloadWithout } = repairedPayload
          ;({ data: obsData, error } = await supabase.from('observations').insert(payloadWithout).select('id').single())
        }
        if (error?.message?.includes('is_draft') || error?.message?.includes('location_precision')) {
          const { is_draft: _isDraft, location_precision: _locationPrecision, ...payloadWithoutPhase7 } = repairedPayload
          ;({ data: obsData, error } = await supabase.from('observations').insert(payloadWithoutPhase7).select('id').single())
        }
        if (error) throw error

        obsId = obsData.id
        const updatedItem = await _updateQueueItem(item.id, current => ({
          ...current,
          remoteObservationId: obsId,
          obsPayload: repairedPayload || current.obsPayload,
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

      let uploadPolicy = _cloudPlanCache.get(queueUserId)
      if (!uploadPolicy) {
        uploadPolicy = await fetchCloudPlanProfile(queueUserId)
        _cloudPlanCache.set(queueUserId, uploadPolicy)
      }
      for (let i = 0; i < queuedImages.length; i++) {
        if (completedImageIndexes.has(i)) continue

        const image = queuedImages[i]
        await _setQueueSyncStatus(item.id, 'uploading-image', {
          syncImageIndex: i + 1,
          syncImageCount: queuedImages.length,
        })
        let preparedImage = image
        const preparedUploadMode = image.uploadMeta?.upload_mode || null
        if (_isBlob(image.blob) && (!image.uploadBlob || preparedUploadMode !== uploadPolicy.uploadMode)) {
          const prepared = await prepareImageVariants(image.blob, uploadPolicy)
          preparedImage = {
            ...image,
            uploadBlob: prepared.uploadBlob,
            uploadMeta: prepared.uploadMeta,
            variants: prepared.variants,
          }
          await _persistPreparedQueuedImage(item.id, i, preparedImage)
        }

        const blobType = preparedImage.uploadBlob?.type || preparedImage.uploadType || ''
        const ext = imageExtensionForMimeType(blobType)
        const path = buildObservationImageStoragePath({
          userId: authUserId,
          observationId: obsId,
          sortOrder: i,
          timestamp: item.ts,
          extension: ext,
        })

        const uploadMeta = await uploadPreparedObservationImageVariants(preparedImage, path, {
          uploadPolicy,
          uploadOrigin: 'web',
          userId: authUserId,
          observationId: obsId,
        })
        await insertObservationImage({
          observation_id: obsId,
          user_id: authUserId,
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
        await _updateQueueItem(item.id, current => current ? {
          ...current,
          remoteObservationId: obsId,
          completedImageIndexes: [...completedImageIndexes].sort((a, b) => a - b),
          syncImageIndex: i + 1,
          syncImageCount: queuedImages.length,
        } : current)
      }

      // 3. Confirm remote DB/image state, then purge from the offline queue.
      await _finalizeSyncedQueueItem(item, obsId, queuedImages, 'local-sync')
    } catch (err) {
      const message = String(err?.message || err || 'Upload failed')
      const unrecoverable = /authenticated user id|missing authenticated user|different signed-in user|missing an auth user id|owner does not match|violates row-level security/i.test(message)
      if (unrecoverable) {
        console.warn('Background sync skipped for queue item', item.id, message)
      } else {
        console.error('Background sync failed for queue item', item.id, err)
      }
      await _setQueueSyncStatus(item.id, unrecoverable ? BLOCKED_QUEUE_STAGE : 'retrying', {
        syncErrorMessage: message,
      })
      if (!unrecoverable) {
        _scheduleSyncRetry()
        break // Network or RLS failure — halt processing to avoid looping errors
      }
    }
  }
}

export async function triggerSync() {
  if (isSyncing) return _currentSyncPromise

  isSyncing = true
  _currentSyncPromise = _trackQueueOperation(_runSyncQueue())
    .finally(() => {
      isSyncing = false
      _currentSyncPromise = null
    })
  return _currentSyncPromise
}

async function _drainQueueForBackgroundTask() {
  const active = [..._activeQueueOperations]
  if (active.length) {
    await Promise.allSettled(active)
  }
  await triggerSync()
}

export async function requestBackgroundSync() {
  if (!isNativeApp()) {
    await triggerSync()
    return
  }
  if (_backgroundTaskRegistered) return
  _backgroundTaskRegistered = true

  try {
    await BackgroundTask.beforeExit(async (data) => {
      const activeId = data?.taskId
      try {
        await _drainQueueForBackgroundTask()
      } catch (error) {
        console.warn('Background sync task failed:', error)
      } finally {
        try {
          if (activeId) {
            BackgroundTask.finish({ taskId: activeId })
          }
        } catch (finishError) {
          console.warn('Background task finish failed:', finishError)
        }
      }
    })
  } catch (error) {
    _backgroundTaskRegistered = false
    console.warn('Background task registration failed:', error)
  }
}

// Boot logic: Listen for connection restoral, and also check when the file is first evaluated.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener(CLOUD_UPLOAD_POLICY_CHANGED_EVENT, () => {
    _cloudPlanCache.clear()
  })
  window.addEventListener('online', triggerSync)
  window.addEventListener('focus', triggerSync)
  window.addEventListener('pageshow', triggerSync)
  onConnectionTypeChange(triggerSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') triggerSync()
    else if (!isNativeApp()) triggerSync()
  })
  setTimeout(() => {
    triggerSync()
    if (isNativeApp()) {
      requestBackgroundSync()
    }
  }, 1000)
}
