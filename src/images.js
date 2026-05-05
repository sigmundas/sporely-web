import { supabase } from './supabase.js'
import { normalizeAiCropRect } from './image_crop.js'
import { getEffectiveCloudUploadPolicy } from './cloud-plan.js'

const SIGNED_URL_TTL_SECONDS = 3600
const SIGNED_URL_CACHE = new Map()
const MEDIA_BASE_URL = String(import.meta.env.VITE_MEDIA_BASE_URL || 'https://media.sporely.no').replace(/\/+$/, '')
const MEDIA_UPLOAD_BASE_URL = String(import.meta.env.VITE_MEDIA_UPLOAD_BASE_URL || '').replace(/\/+$/, '')
const UPLOAD_METADATA_FIELDS = [
  'upload_mode',
  'source_width',
  'source_height',
  'stored_width',
  'stored_height',
  'stored_bytes',
]

const SUPABASE_STORAGE_PATH_PATTERNS = [
  /\/storage\/v1\/object\/authenticated\/observation-images\/(.+)$/i,
  /\/storage\/v1\/object\/public\/observation-images\/(.+)$/i,
  /\/storage\/v1\/object\/observation-images\/(.+)$/i,
]

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

export function normalizeMediaKey(value) {
  const text = String(value || '').trim()
  if (!text) return ''

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const normalizedBase = MEDIA_BASE_URL.toLowerCase()
      const normalizedText = text.toLowerCase()
      if (normalizedText.startsWith(`${normalizedBase}/`)) {
        return text.slice(MEDIA_BASE_URL.length + 1).replace(/^\/+/, '')
      }
      const rawPath = url.pathname.replace(/^\/+/, '')
      for (const pattern of SUPABASE_STORAGE_PATH_PATTERNS) {
        const match = url.pathname.match(pattern)
        if (match?.[1]) return match[1].replace(/^\/+/, '')
      }
      if (rawPath.startsWith('observation-images/')) return rawPath.slice('observation-images/'.length)
      if (rawPath.startsWith('sporely-media/')) return rawPath.slice('sporely-media/'.length)
      return rawPath
    } catch (_) {
      return text
    }
  }

  if (text.startsWith('observation-images/')) return text.slice('observation-images/'.length)
  if (text.startsWith('sporely-media/')) return text.slice('sporely-media/'.length)
  return text.replace(/^\/+/, '')
}

function _splitPath(storagePath) {
  const parts = normalizeMediaKey(storagePath).split('/')
  const fileName = parts.pop() || ''
  return { dir: parts.join('/'), fileName }
}

export function getVariantPath(storagePath, variant = 'original') {
  const key = normalizeMediaKey(storagePath)
  if (!key || variant === 'original') return key
  const { dir, fileName } = _splitPath(storagePath)
  return dir ? `${dir}/${variant}_${fileName}` : `${variant}_${fileName}`
}

export function getPublicMediaUrl(storagePath, variant = 'original') {
  const key = normalizeMediaKey(storagePath)
  if (!key) return ''
  
  if (variant !== 'original') {
    const variantKey = getVariantPath(storagePath, variant)
    return `${MEDIA_BASE_URL}/${variantKey}`
  }
  return `${MEDIA_BASE_URL}/${key}`
}

export function clearMediaUrlCache() {
  SIGNED_URL_CACHE.clear()
}

function _encodeObjectKey(storagePath) {
  return normalizeMediaKey(storagePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

async function _uploadViaWorker(path, blob, options = {}) {
  const normalizedPath = normalizeMediaKey(path)
  if (!normalizedPath) throw new Error('Missing storage path')

  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media upload')

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': blob?.type || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
  }

  const arrayBuffer = await blob.arrayBuffer()

  const response = await fetch(`${MEDIA_UPLOAD_BASE_URL}/upload/${_encodeObjectKey(normalizedPath)}`, {
    method: 'PUT',
    headers,
    body: arrayBuffer,
  })

  if (!response.ok) {
    let detail = response.statusText || 'Upload failed'
    try {
      const payload = await response.json()
      if (payload?.message) detail = payload.message
    } catch (_) {}
    throw new Error(`Worker upload failed: ${detail}`)
  }
}

async function _deleteViaWorker(path) {
  const normalizedPath = normalizeMediaKey(path)
  if (!normalizedPath) return

  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media delete')

  const response = await fetch(`${MEDIA_UPLOAD_BASE_URL}/upload/${_encodeObjectKey(normalizedPath)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok && response.status !== 404) {
    let detail = response.statusText || 'Delete failed'
    try {
      const payload = await response.json()
      if (payload?.message) detail = payload.message
    } catch (_) {}
    throw new Error(`Worker delete failed: ${detail}`)
  }
}

async function _downloadViaWorker(path) {
  const normalizedPath = normalizeMediaKey(path)
  if (!normalizedPath) throw new Error('Missing storage path')

  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media download')

  const response = await fetch(`${MEDIA_UPLOAD_BASE_URL}/upload/${_encodeObjectKey(normalizedPath)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    let detail = response.statusText || 'Download failed'
    try {
      const payload = await response.json()
      if (payload?.message) detail = payload.message
    } catch (_) {}
    throw new Error(`Worker download failed: ${detail}`)
  }

  const blob = await response.blob()
  if (!_isBlob(blob)) throw new Error('Worker download returned invalid data')
  return blob
}

async function _uploadToStorage(path, blob, options = {}) {
  if (MEDIA_UPLOAD_BASE_URL) {
    await _uploadViaWorker(path, blob, options)
    return
  }
  const { error } = await supabase.storage
    .from('observation-images')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
}

function _loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image decode failed'))
    }
    img.src = url
  })
}

function _fitWithinMaxPixels(width, height, maxPixels, options = {}) {
  const pixels = Math.max(1, Number(width) || 0) * Math.max(1, Number(height) || 0)
  const resizeThresholdPixels = Math.max(Number(maxPixels) || 0, Number(options.resizeThresholdPixels) || 0)
  if (!maxPixels || pixels <= maxPixels || (resizeThresholdPixels && pixels < resizeThresholdPixels)) {
    return {
      targetWidth: width,
      targetHeight: height,
      resized: false,
    }
  }
  const scale = Math.sqrt(maxPixels / pixels)
  return {
    targetWidth: Math.max(1, Math.round(width * scale)),
    targetHeight: Math.max(1, Math.round(height * scale)),
    resized: true,
  }
}

let _bestMimeType = null
function _getBestMimeType() {
  if (_bestMimeType) return _bestMimeType
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    if (canvas.toDataURL('image/avif').startsWith('data:image/avif')) _bestMimeType = 'image/avif'
    else if (canvas.toDataURL('image/webp').startsWith('data:image/webp')) _bestMimeType = 'image/webp'
    else _bestMimeType = 'image/jpeg'
  } catch (e) {
    _bestMimeType = 'image/jpeg'
  }
  return _bestMimeType
}

async function _prepareUploadBlob(blob, uploadPolicy) {
  if (!_isBlob(blob)) throw new Error('Missing image blob')

  const policy = uploadPolicy || getEffectiveCloudUploadPolicy()
  
  let img
  try {
    img = await _loadImage(blob)
  } catch (err) {
    // Browser cannot decode the image (e.g. HEIC fallback). Just upload original.
    return {
      uploadBlob: blob,
      variants: {},
      uploadMeta: {
        upload_mode: 'full',
        source_width: null,
        source_height: null,
        stored_width: null,
        stored_height: null,
        stored_bytes: blob.size || 0,
      },
    }
  }

  const sourceWidth = img.naturalWidth || img.width
  const sourceHeight = img.naturalHeight || img.height
  if (!sourceWidth || !sourceHeight) {
    return {
      uploadBlob: blob,
      variants: {},
      uploadMeta: {
        upload_mode: 'full',
        source_width: null,
        source_height: null,
        stored_width: null,
        stored_height: null,
        stored_bytes: blob.size || 0,
      },
    }
  }

  let maxEdge = 1600
  if (policy.uploadMode === 'full') {
    const pixels = sourceWidth * sourceHeight
    if (pixels > 13000000) {
      maxEdge = 4000
    } else {
      maxEdge = Math.max(sourceWidth, sourceHeight)
    }
  }

  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale))
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale))

  let uploadBlob = blob

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas context unavailable')
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

  const mimeType = _getBestMimeType()
  const quality = mimeType === 'image/jpeg' ? 0.88 : 0.85

  const fullBlob = await new Promise((resolve) => {
    canvas.toBlob(b => resolve(b || blob), mimeType, quality)
  })
  
  await new Promise(r => setTimeout(r, 20)) // Yield to UI thread

  const thumbScale = Math.min(1, 400 / Math.max(targetWidth, targetHeight))
  const thumbWidth = Math.max(1, Math.round(targetWidth * thumbScale))
  const thumbHeight = Math.max(1, Math.round(targetHeight * thumbScale))

  const thumbCanvas = document.createElement('canvas')
  thumbCanvas.width = thumbWidth
  thumbCanvas.height = thumbHeight
  const thumbCtx = thumbCanvas.getContext('2d')
  if (thumbCtx) {
    thumbCtx.drawImage(canvas, 0, 0, thumbWidth, thumbHeight)
  }
  
  const thumbBlob = await new Promise((resolve) => {
    thumbCanvas.toBlob(b => resolve(b), mimeType, 0.70)
  })
  
  await new Promise(r => setTimeout(r, 20)) // Yield to UI thread

  canvas.width = 0
  canvas.height = 0
  thumbCanvas.width = 0
  thumbCanvas.height = 0
  URL.revokeObjectURL(img.src)

  return {
    uploadBlob: fullBlob,
    variants: thumbBlob ? { thumb: thumbBlob } : {},
    uploadMeta: {
      upload_mode: policy.uploadMode || 'reduced',
      source_width: sourceWidth,
      source_height: sourceHeight,
      stored_width: targetWidth,
      stored_height: targetHeight,
      stored_bytes: fullBlob.size || 0,
    },
  }
}

export async function prepareImageVariants(blob, uploadPolicy) {
  const policy = uploadPolicy || getEffectiveCloudUploadPolicy()
  const { uploadBlob, uploadMeta, variants } = await _prepareUploadBlob(blob, policy)

  return { uploadBlob, uploadMeta, variants }
}

export async function uploadPreparedObservationImageVariants(preparedImage, storagePath, options = {}) {
  const uploadPolicy = options?.uploadPolicy || getEffectiveCloudUploadPolicy()
  const uploadOptions = {
    uploadMode: preparedImage.uploadMeta.upload_mode,
    cloudPlan: uploadPolicy.cloudPlan,
    uploadOrigin: options?.uploadOrigin || 'web',
  }

  await _uploadToStorage(storagePath, preparedImage.uploadBlob, uploadOptions)
  if (preparedImage.variants?.thumb) {
    const thumbPath = getVariantPath(storagePath, 'thumb')
    await _uploadToStorage(thumbPath, preparedImage.variants.thumb, uploadOptions)
  }
  return preparedImage.uploadMeta
}

export async function uploadObservationImageVariants(blob, storagePath, options = {}) {
  const uploadPolicy = options?.uploadPolicy || getEffectiveCloudUploadPolicy()
  const preparedImage = await prepareImageVariants(blob, uploadPolicy)
  return uploadPreparedObservationImageVariants(preparedImage, storagePath, options)
}

function _isMissingColumnError(error, columnName) {
  const text = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  const column = String(columnName || '').toLowerCase()
  return !!column
    && text.includes(column)
    && (text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find'))
}

export async function deleteObservationMedia(paths) {
  const normalized = [...new Set((paths || [])
    .map(normalizeMediaKey)
    .filter(Boolean)
  )]
  if (!normalized.length) return

  if (MEDIA_UPLOAD_BASE_URL) {
    await Promise.all(normalized.map(path => _deleteViaWorker(path)))
    return
  }

  const { error } = await supabase.storage
    .from('observation-images')
    .remove(normalized)

  if (error) throw new Error(`Storage delete failed: ${error.message}`)
}

export async function downloadObservationImageBlob(storagePath, options = {}) {
  const originalPath = normalizeMediaKey(storagePath)
  if (!originalPath) throw new Error('Missing image storage path')

  const variant = options.variant || 'medium'
  const candidatePaths = variant === 'original'
    ? [originalPath]
    : [getVariantPath(originalPath, variant), originalPath]

  let lastError = null
  for (const path of [...new Set(candidatePaths.filter(Boolean))]) {
    if (MEDIA_UPLOAD_BASE_URL) {
      try {
        const data = await _downloadViaWorker(path)
        if (_isBlob(data)) return data
      } catch (err) {
        lastError = err
      }
    }

    const { data, error } = await supabase.storage
      .from('observation-images')
      .download(path)
    if (!error && _isBlob(data)) return data
    lastError = error
  }

  throw new Error(`Image download failed: ${lastError?.message || originalPath}`)
}

export async function insertObservationImage(observationImage) {
  const cropRect = normalizeAiCropRect(observationImage?.aiCropRect)
  const cropSourceW = observationImage?.aiCropSourceW ?? null
  const cropSourceH = observationImage?.aiCropSourceH ?? null
  const basePayload = {
    observation_id: observationImage?.observation_id,
    user_id: observationImage?.user_id,
    storage_path: normalizeMediaKey(observationImage?.storage_path),
    image_type: observationImage?.image_type || 'field',
    sort_order: observationImage?.sort_order ?? 0,
  }

  const payloadWithCrop = {
    ...basePayload,
    ai_crop_x1: cropRect?.x1 ?? null,
    ai_crop_y1: cropRect?.y1 ?? null,
    ai_crop_x2: cropRect?.x2 ?? null,
    ai_crop_y2: cropRect?.y2 ?? null,
    ai_crop_source_w: cropSourceW,
    ai_crop_source_h: cropSourceH,
  }
  const payloadWithUploadMeta = {
    ...payloadWithCrop,
    upload_mode: observationImage?.upload_mode || null,
    source_width: observationImage?.source_width ?? null,
    source_height: observationImage?.source_height ?? null,
    stored_width: observationImage?.stored_width ?? null,
    stored_height: observationImage?.stored_height ?? null,
    stored_bytes: observationImage?.stored_bytes ?? null,
  }

  const { error } = await supabase
    .from('observation_images')
    .insert(payloadWithUploadMeta)

  if (!error) return true

  const cropFieldNames = [
    'ai_crop_x1',
    'ai_crop_y1',
    'ai_crop_x2',
    'ai_crop_y2',
    'ai_crop_source_w',
    'ai_crop_source_h',
  ]

  const uploadFieldMissing = UPLOAD_METADATA_FIELDS.some(field => _isMissingColumnError(error, field))
  if (uploadFieldMissing) {
    const { error: retryError } = await supabase
      .from('observation_images')
      .insert(payloadWithCrop)
    if (!retryError) return false
    if (!cropFieldNames.some(field => _isMissingColumnError(retryError, field))) {
      throw retryError
    }
    const { error: fallbackError } = await supabase
      .from('observation_images')
      .insert(basePayload)
    if (fallbackError) throw fallbackError
    return false
  }

  if (!cropFieldNames.some(field => _isMissingColumnError(error, field))) {
    throw error
  }

  const { error: fallbackError } = await supabase
    .from('observation_images')
    .insert(basePayload)

  if (fallbackError) throw fallbackError
  return false
}

export async function updateObservationImageCrop(imageId, cropData) {
  if (!imageId) return
  const cropRect = normalizeAiCropRect(cropData?.aiCropRect)
  const { error } = await supabase
    .from('observation_images')
    .update({
      ai_crop_x1: cropRect?.x1 ?? null,
      ai_crop_y1: cropRect?.y1 ?? null,
      ai_crop_x2: cropRect?.x2 ?? null,
      ai_crop_y2: cropRect?.y2 ?? null,
      ai_crop_source_w: cropData?.aiCropSourceW ?? null,
      ai_crop_source_h: cropData?.aiCropSourceH ?? null,
    })
    .eq('id', imageId)
  if (error && !_isMissingColumnError(error, 'ai_crop_x1')) {
    console.warn('updateObservationImageCrop failed:', error)
  }
}

export async function syncObservationMediaKeys(observationId, storagePath, options = {}) {
  if (!observationId) return
  const sortOrder = options.sortOrder
  if (sortOrder !== undefined && sortOrder !== null && Number(sortOrder) !== 0) return false

  const imageKey = normalizeMediaKey(storagePath)
  if (!imageKey) return false
  const thumbKey = getVariantPath(imageKey, 'small')

  const { error: combinedError } = await supabase
    .from('observations')
    .update({ image_key: imageKey, thumb_key: thumbKey })
    .eq('id', observationId)
  if (!combinedError) return true

  const combinedIsColumnError = _isMissingColumnError(combinedError, 'image_key')
    || _isMissingColumnError(combinedError, 'thumb_key')
  if (!combinedIsColumnError) {
    console.warn('Observation media key sync failed:', combinedError)
    return false
  }

  const fieldPayloads = [
    ['image_key', imageKey],
    ['thumb_key', thumbKey],
  ]
  for (const [field, value] of fieldPayloads) {
    const { error } = await supabase
      .from('observations')
      .update({ [field]: value })
      .eq('id', observationId)
    if (error && !_isMissingColumnError(error, field)) {
      console.warn(`Observation ${field} sync failed:`, error)
      return false
    }
  }
  return true
}

async function _getSignedUrlMap(paths, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const uniquePaths = [...new Set((paths || []).map(normalizeMediaKey).filter(Boolean))]
  if (!uniquePaths.length) return {}

  const now = Date.now()
  const urls = {}
  const missing = []

  uniquePaths.forEach(path => {
    const cached = SIGNED_URL_CACHE.get(path)
    if (cached && cached.expiresAt > now) {
      urls[path] = cached.url
    } else {
      missing.push(path)
    }
  })

  if (missing.length) {
    const { data } = await supabase.storage
      .from('observation-images')
      .createSignedUrls(missing, expiresIn)

    ;(data || []).forEach(item => {
      if (!item?.path || !item?.signedUrl) return
      urls[item.path] = item.signedUrl
      SIGNED_URL_CACHE.set(item.path, {
        url: item.signedUrl,
        expiresAt: now + Math.max(1, expiresIn - 30) * 1000,
      })
    })
  }

  return urls
}

export async function resolveMediaSources(paths, options = {}) {
  const variant = options.variant || 'original'
  const normalizedPaths = (paths || []).map(normalizeMediaKey)
  const requestedPaths = variant === 'original'
    ? normalizedPaths
    : normalizedPaths.flatMap(path => [getVariantPath(path, variant), path])
  const signed = await _getSignedUrlMap(requestedPaths)

  return normalizedPaths.map(originalPath => {
    if (!originalPath) return { key: '', primaryUrl: null, fallbackUrl: null }
    const variantPath = getVariantPath(originalPath, variant)
    
    let fallbackUrl = variant === 'original' ? signed[originalPath] || null : null;
    if (variant !== 'original') {
      fallbackUrl = signed[variantPath] || signed[originalPath] || getPublicMediaUrl(originalPath, 'original');
    }
    
    const primaryUrl = getPublicMediaUrl(originalPath, variant) || fallbackUrl
    return {
      key: originalPath,
      primaryUrl,
      fallbackUrl,
    }
  })
}

/**
 * Given an array of observation IDs, returns a map of
 * { obsId -> { primaryUrl, fallbackUrl } } for the first image.
 */
export async function fetchFirstImages(obsIds, options = {}) {
  if (!obsIds.length) return {}
  const variant = options.variant || 'medium'

  const { data, error } = await supabase
    .from('observation_images')
    .select('observation_id, storage_path')
    .in('observation_id', obsIds)
    .order('sort_order', { ascending: true })

  if (error || !data?.length) return {}

  const firstPaths = {}
  for (const img of data) {
    if (!firstPaths[img.observation_id]) {
      firstPaths[img.observation_id] = img.storage_path
    }
  }

  const originalPaths = Object.values(firstPaths)
  const sourcesByPath = new Map()
  const sources = await resolveMediaSources(originalPaths, { variant })
  sources.forEach(source => {
    if (source?.key) sourcesByPath.set(source.key, source)
  })

  const imageSources = {}
  Object.entries(firstPaths).forEach(([obsId, originalPath]) => {
    const normalizedPath = normalizeMediaKey(originalPath)
    const source = sourcesByPath.get(normalizedPath)
    const primaryUrl = source?.primaryUrl || null
    const fallbackUrl = source?.fallbackUrl || null
    if (primaryUrl || fallbackUrl) {
      imageSources[obsId] = { primaryUrl, fallbackUrl }
    }
  })

  return imageSources
}

/**
 * Like fetchFirstImages but returns up to two image sources per observation plus
 * the total image count. Used by the single-column cards view.
 * Returns { [obsId]: { first, second, count } } where second may be null.
 */
export async function fetchCardImages(obsIds, options = {}) {
  if (!obsIds.length) return {}
  const variant = options.variant || 'medium'

  const { data, error } = await supabase
    .from('observation_images')
    .select('observation_id, storage_path')
    .in('observation_id', obsIds)
    .order('sort_order', { ascending: true })

  if (error || !data?.length) return {}

  // Collect first two paths + count per observation
  const firstTwo = {}
  const counts = {}
  for (const img of data) {
    const id = img.observation_id
    counts[id] = (counts[id] || 0) + 1
    if (!firstTwo[id]) {
      firstTwo[id] = [img.storage_path]
    } else if (firstTwo[id].length === 1) {
      firstTwo[id].push(img.storage_path)
    }
  }

  const allPaths = Object.values(firstTwo).flat()
  const sourcesByPath = new Map()
  const sources = await resolveMediaSources(allPaths, { variant })
  sources.forEach(source => {
    if (source?.key) sourcesByPath.set(source.key, source)
  })

  const result = {}
  for (const [obsId, paths] of Object.entries(firstTwo)) {
    const toSource = path => {
      const normalized = normalizeMediaKey(path)
      const s = sourcesByPath.get(normalized)
      return (s?.primaryUrl || s?.fallbackUrl) ? s : null
    }
    result[obsId] = {
      first: toSource(paths[0]),
      second: paths[1] ? toSource(paths[1]) : null,
      count: counts[obsId] || 1,
    }
  }

  return result
}
