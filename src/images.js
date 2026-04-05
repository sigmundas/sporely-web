import { supabase } from './supabase.js'

const SIGNED_URL_TTL_SECONDS = 3600
const SIGNED_URL_CACHE = new Map()
const THUMB_VARIANTS = {
  small: { maxEdge: 240, quality: 0.74 },
  medium: { maxEdge: 720, quality: 0.82 },
}

function _splitPath(storagePath) {
  const parts = String(storagePath || '').split('/')
  const fileName = parts.pop() || ''
  return { dir: parts.join('/'), fileName }
}

export function getVariantPath(storagePath, variant = 'original') {
  if (!storagePath || variant === 'original') return storagePath
  const { dir, fileName } = _splitPath(storagePath)
  return dir ? `${dir}/thumb_${variant}_${fileName}` : `thumb_${variant}_${fileName}`
}

async function _uploadToStorage(path, blob) {
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

async function _getSignedUrlMap(paths, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))]
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
  const requestedPaths = variant === 'original'
    ? originalPaths
    : originalPaths.flatMap(path => [getVariantPath(path, variant), path])
  const signed = await _getSignedUrlMap(requestedPaths)

  const sources = {}
  Object.entries(firstPaths).forEach(([obsId, originalPath]) => {
    const fallbackUrl = signed[originalPath] || null
    const primaryUrl = variant === 'original'
      ? fallbackUrl
      : (signed[getVariantPath(originalPath, variant)] || fallbackUrl)
    if (primaryUrl || fallbackUrl) {
      sources[obsId] = { primaryUrl, fallbackUrl }
    }
  })

  return sources
}
