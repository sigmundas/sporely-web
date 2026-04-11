import { supabase } from './supabase.js'
import { normalizeAiCropRect } from './image_crop.js'

const SIGNED_URL_TTL_SECONDS = 3600
const SIGNED_URL_CACHE = new Map()
const MEDIA_BASE_URL = String(import.meta.env.VITE_MEDIA_BASE_URL || 'https://media.sporely.no').replace(/\/+$/, '')
const MEDIA_UPLOAD_BASE_URL = String(import.meta.env.VITE_MEDIA_UPLOAD_BASE_URL || '').replace(/\/+$/, '')
const THUMB_VARIANTS = {
  small: { maxEdge: 240, quality: 0.82 },
  medium: { maxEdge: 720, quality: 0.82 },
}

const SUPABASE_STORAGE_PATH_PATTERNS = [
  /\/storage\/v1\/object\/authenticated\/observation-images\/(.+)$/i,
  /\/storage\/v1\/object\/public\/observation-images\/(.+)$/i,
  /\/storage\/v1\/object\/observation-images\/(.+)$/i,
]

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
  return dir ? `${dir}/thumb_${variant}_${fileName}` : `thumb_${variant}_${fileName}`
}

export function getPublicMediaUrl(storagePath, variant = 'original') {
  const key = getVariantPath(storagePath, variant)
  if (!key) return ''
  return `${MEDIA_BASE_URL}/${key}`
}

function _encodeObjectKey(storagePath) {
  return normalizeMediaKey(storagePath)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

async function _uploadViaWorker(path, blob) {
  const normalizedPath = normalizeMediaKey(path)
  if (!normalizedPath) throw new Error('Missing storage path')

  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media upload')

  const response = await fetch(`${MEDIA_UPLOAD_BASE_URL}/upload/${_encodeObjectKey(normalizedPath)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': blob?.type || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: blob,
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

async function _uploadToStorage(path, blob) {
  if (MEDIA_UPLOAD_BASE_URL) {
    await _uploadViaWorker(path, blob)
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

async function _createThumbnailBlob(blob, maxEdge, quality) {
  if (!(blob instanceof Blob)) return null

  const img = await _loadImage(blob)
  const width = img.naturalWidth || img.width
  const height = img.naturalHeight || img.height
  if (!width || !height) throw new Error('Image has zero dimensions')

  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))

  if (scale === 1 && blob.type === 'image/jpeg') return blob

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas context unavailable')
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      thumbBlob => thumbBlob ? resolve(thumbBlob) : reject(new Error('Thumbnail encode failed')),
      'image/jpeg',
      quality,
    )
  })
}

export async function uploadObservationImageVariants(blob, storagePath) {
  await _uploadToStorage(storagePath, blob)

  const uploads = Object.entries(THUMB_VARIANTS).map(async ([variant, config]) => {
    try {
      const thumbBlob = await _createThumbnailBlob(blob, config.maxEdge, config.quality)
      if (!(thumbBlob instanceof Blob)) return
      await _uploadToStorage(getVariantPath(storagePath, variant), thumbBlob)
    } catch (err) {
      console.warn(`Thumbnail upload failed for ${variant}:`, err)
    }
  })

  await Promise.all(uploads)
}

function _isMissingColumnError(error, columnName) {
  const text = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  const column = String(columnName || '').toLowerCase()
  return !!column
    && text.includes(column)
    && (text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find'))
}

export async function deleteObservationMedia(paths) {
  const normalized = [...new Set((paths || []).map(normalizeMediaKey).filter(Boolean))]
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

  const { error } = await supabase
    .from('observation_images')
    .insert(payloadWithCrop)

  if (!error) return true

  const cropFieldNames = [
    'ai_crop_x1',
    'ai_crop_y1',
    'ai_crop_x2',
    'ai_crop_y2',
    'ai_crop_source_w',
    'ai_crop_source_h',
  ]

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
    const fallbackUrl = variant === 'original'
      ? (signed[originalPath] || null)
      : (signed[variantPath] || signed[originalPath] || null)
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
