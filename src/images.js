import { supabase } from './supabase.js'
import { getSharedAuthSession } from './auth-session.js'
import { normalizeAiCropRect } from './image_crop.js'
import { getEffectiveCloudUploadPolicy } from './cloud-plan.js'
import {
  IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE,
  buildFullImagePreparationPolicy,
  buildThumbnailEncodeCandidates,
  getFullImageEncodeRetryJump,
  looksLikeIosWebKitRuntime,
  scaleDimensionsToMaxPixels,
} from './cloud-media-policy.js'
import { debugImagePipeline, isImagePipelineDebugEnabled } from './image-pipeline-debug.js'
import { isBlob } from './observation-shapes.js'

const DEFAULT_MEDIA_BASE_URL = 'https://media.sporely.no'
const OBSERVATION_IMAGES_COMMUNITY_VIEW = 'observation_images_community_view'
const UPLOAD_METADATA_FIELDS = [
  'upload_mode',
  'source_width',
  'source_height',
  'stored_width',
  'stored_height',
  'stored_bytes',
  'storage_exif_safe',
]

export const UNDECODABLE_IMAGE_USER_MESSAGE = 'This browser could not decode this image format. Please convert the image to JPEG/WebP first, or upload from a device/browser that supports HEIC conversion.'

const SUPABASE_STORAGE_PATH_PATTERNS = [
  /\/storage\/v1\/object\/authenticated\/observation-images\/(.+)$/i,
  /\/storage\/v1\/object\/public\/observation-images\/(.+)$/i,
  /\/storage\/v1\/object\/observation-images\/(.+)$/i,
]

const _canvasExportSupportCache = new Map()

function _envText(key, fallback = '') {
  return String(globalThis.__SPORLEY_TEST_ENV__?.[key] ?? import.meta.env?.[key] ?? fallback ?? '').trim()
}

function _envFlag(key) {
  return ['1', 'true', 'yes', 'on'].includes(_envText(key).toLowerCase())
}

function _isTestModeEnabled() {
  const mode = _envText('MODE', '').toLowerCase()
  const testFlag = String(globalThis.__SPORLEY_TEST_ENV__?.TEST ?? import.meta.env?.TEST ?? '').trim().toLowerCase()
  return mode === 'test' || ['1', 'true', 'yes', 'on'].includes(testFlag)
}

function getMediaBaseUrl() {
  return _envText('VITE_MEDIA_BASE_URL', DEFAULT_MEDIA_BASE_URL).replace(/\/+$/, '')
}

function getMediaUploadBaseUrl() {
  return _envText('VITE_MEDIA_UPLOAD_BASE_URL', '').replace(/\/+$/, '')
}

function _isDebugMediaUploadEnabled() {
  try {
    return import.meta.env?.DEV
      || globalThis.localStorage?.getItem('sporely-debug-upload-keys') === 'true'
  } catch (_) {
    return false
  }
}

function _normalizeCanvasExportMimeType(type) {
  return String(type || '').split(';')[0].trim().toLowerCase()
}

function _markCanvasExportSupport(type, supported) {
  const normalizedType = _normalizeCanvasExportMimeType(type)
  if (!normalizedType) return
  _canvasExportSupportCache.set(normalizedType, Promise.resolve(!!supported))
}

async function _probeCanvasExportSupport(type) {
  const normalizedType = _normalizeCanvasExportMimeType(type)
  if (!normalizedType) return false
  const cached = _canvasExportSupportCache.get(normalizedType)
  if (cached) return cached
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined') return false

  const probe = (async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    try {
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return false
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, 1, 1)
      const blob = await new Promise(resolve => {
        canvas.toBlob(nextBlob => resolve(nextBlob), normalizedType, 0.92)
      })
      return !!blob && blob.size > 0 && _normalizeCanvasExportMimeType(blob.type) === normalizedType
    } catch (_) {
      return false
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  })()

  _canvasExportSupportCache.set(normalizedType, probe)
  const supported = await probe
  _markCanvasExportSupport(normalizedType, supported)
  return supported
}

async function _getCanvasExportSupport() {
  const [webp, jpeg] = await Promise.all([
    _probeCanvasExportSupport('image/webp'),
    _probeCanvasExportSupport('image/jpeg'),
  ])
  return { webp, jpeg }
}

function _getRuntimeCanvasPolicyContext() {
  try {
    return {
      userAgent: globalThis.navigator?.userAgent || '',
      platform: globalThis.navigator?.platform || '',
      vendor: globalThis.navigator?.vendor || '',
      maxTouchPoints: globalThis.navigator?.maxTouchPoints || 0,
    }
  } catch (_) {
    return {}
  }
}

export function canUseLegacySupabaseStorageFallbackForTestsOnly() {
  return _envFlag('VITE_ALLOW_SUPABASE_STORAGE_FALLBACK_FOR_TESTS_ONLY') && _isTestModeEnabled()
}

export function buildWorkerUploadHeaders({
  blob,
  options = {},
  uploadMeta = {},
  accessToken = '',
} = {}) {
  const headers = {
    Authorization: `Bearer ${String(accessToken || '').trim()}`,
    'Content-Type': blob?.type || 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
  }

  const uploadVariant = String(options?.uploadVariant || uploadMeta?.upload_variant || 'full').trim().toLowerCase() || 'full'
  const sourceWidth = Number.isFinite(Number(uploadMeta?.source_width)) ? Number(uploadMeta.source_width) : null
  const sourceHeight = Number.isFinite(Number(uploadMeta?.source_height)) ? Number(uploadMeta.source_height) : null
  const storedWidth = Number.isFinite(Number(uploadMeta?.stored_width)) ? Number(uploadMeta.stored_width) : null
  const storedHeight = Number.isFinite(Number(uploadMeta?.stored_height)) ? Number(uploadMeta.stored_height) : null
  const encodingQuality = Number.isFinite(Number(uploadMeta?.encoding_quality)) ? Number(uploadMeta.encoding_quality) : null
  const encodingFormat = String(options?.encodingFormat || uploadMeta?.encoding_format || blob?.type || '').trim()

  headers['X-Sporely-Upload-Mode'] = String(options?.uploadMode || uploadMeta?.upload_mode || 'reduced')
  headers['X-Sporely-Upload-Variant'] = uploadVariant
  headers['X-Sporely-Cloud-Plan'] = String(options?.cloudPlan || uploadMeta?.cloud_plan || 'free')
  headers['X-Sporely-Quality-Profile'] = String(options?.qualityProfile || uploadMeta?.quality_profile || 'standard')
  if (encodingQuality !== null) headers['X-Sporely-Encoding-Quality'] = String(encodingQuality)
  if (encodingFormat) headers['X-Sporely-Encoding-Format'] = encodingFormat
  if (sourceWidth !== null) headers['X-Sporely-Source-Width'] = String(sourceWidth)
  if (sourceHeight !== null) headers['X-Sporely-Source-Height'] = String(sourceHeight)
  if (storedWidth !== null) headers['X-Sporely-Stored-Width'] = String(storedWidth)
  if (storedHeight !== null) headers['X-Sporely-Stored-Height'] = String(storedHeight)

  return headers
}

function _buildUploadMediaError(message, details = {}) {
  const error = new Error(String(message || IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE))
  if (details && typeof details === 'object') {
    error.details = { ...details }
  }
  return error
}

function _isImageTooLargeForPlanError(error) {
  const text = String(error?.message || error || '').toLowerCase()
  return text.includes('image too large for plan')
    || text.includes('too large for your plan')
}

function _mediaStorageFallbackDisabledError() {
  return new Error('Media upload worker is not configured; refusing Supabase Storage fallback because R2 is canonical.')
}

function _buildUndecodableImageError(details = {}) {
  const error = new Error(UNDECODABLE_IMAGE_USER_MESSAGE)
  error.name = 'ImageUndecodableError'
  error.code = 'image_undecodable'
  if (details && typeof details === 'object') {
    error.details = { ...details }
  }
  return error
}

export function normalizeMediaKey(value) {
  const text = String(value || '').trim()
  if (!text) return ''

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const mediaBaseUrl = getMediaBaseUrl()
      const normalizedBase = mediaBaseUrl.toLowerCase()
      const normalizedText = text.toLowerCase()
      if (normalizedText.startsWith(`${normalizedBase}/`)) {
        return text.slice(mediaBaseUrl.length + 1).replace(/^\/+/, '')
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

export function buildObservationImageStoragePath({
  userId,
  observationId,
  sortOrder = 0,
  timestamp = Date.now(),
  extension = 'jpg',
} = {}) {
  const normalizedUserId = normalizeMediaKey(userId)
  const normalizedObservationId = String(observationId || '').trim()
  const normalizedSortOrder = Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0
  const normalizedTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now()
  const normalizedExtension = String(extension || '').trim().replace(/^\./, '') || 'jpg'
  return `${normalizedUserId}/${normalizedObservationId}/${normalizedSortOrder}_${normalizedTimestamp}.${normalizedExtension}`
}

export function assertObservationImageStoragePathUserPrefix(storagePath, userId, context = {}) {
  const normalizedPath = normalizeMediaKey(storagePath)
  const normalizedUserId = normalizeMediaKey(userId)
  if (!normalizedPath) throw new Error('Missing storage path')
  if (!normalizedUserId) throw new Error('Missing authenticated user id for image upload')

  if (!normalizedPath.startsWith(`${normalizedUserId}/`)) {
    const diagnostics = {
      authUserId: normalizedUserId,
      keyPrefix: normalizedPath.split('/').slice(0, 2).join('/'),
      observationId: context.observationId ?? null,
      imageId: context.imageId ?? null,
    }
    if (_isDebugMediaUploadEnabled()) {
      console.debug('[media-upload] invalid storage key prefix', diagnostics)
    }
    throw new Error('Upload key must start with the authenticated user id')
  }

  return normalizedPath
}

function _splitPath(storagePath) {
  const parts = normalizeMediaKey(storagePath).split('/')
  const fileName = parts.pop() || ''
  return { dir: parts.join('/'), fileName }
}

function _stripLegacyVariantPrefixes(fileName) {
  return String(fileName || '')
    .replace(/^(?:thumb_|medium_|small_|cards_)+/i, '')
}

export function imageExtensionForMimeType(type) {
  const normalized = String(type || '').split(';')[0].trim().toLowerCase()
  if (normalized === 'image/webp') return 'webp'
  if (normalized === 'image/avif') return 'avif'
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg'
  if (normalized === 'image/heic') return 'heic'
  if (normalized === 'image/heif') return 'heif'
  return 'jpg'
}

export function imageExtensionForBlob(blob) {
  return imageExtensionForMimeType(blob?.type)
}

export function getVariantPath(storagePath, variant = 'original') {
  const key = normalizeMediaKey(storagePath)
  if (!key || variant === 'original') return key
  const { dir, fileName } = _splitPath(storagePath)
  const variantName = ['thumb', 'small', 'medium', 'cards'].includes(String(variant || '').toLowerCase())
    ? `thumb_${_stripLegacyVariantPrefixes(fileName)}`
    : `${variant}_${fileName}`
  return dir ? `${dir}/${variantName}` : variantName
}

export function getPublicMediaUrl(storagePath, variant = 'original') {
  const key = normalizeMediaKey(storagePath)
  if (!key) return ''
  const mediaBaseUrl = getMediaBaseUrl()
  
  if (variant !== 'original') {
    const variantKey = getVariantPath(storagePath, variant)
    return `${mediaBaseUrl}/${variantKey}`
  }
  return `${mediaBaseUrl}/${key}`
}

export function clearMediaUrlCache() {
  // Observation media no longer uses a signed-URL cache. Keep this as a
  // compatibility no-op for the settings "clear cache" action.
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

  const session = await getSharedAuthSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media upload')

  const mediaUploadBaseUrl = getMediaUploadBaseUrl()
  const headers = buildWorkerUploadHeaders({
    blob,
    options,
    uploadMeta: options?.uploadMeta || {},
    accessToken,
  })

  const arrayBuffer = await blob.arrayBuffer()

  const response = await fetch(`${mediaUploadBaseUrl}/upload/${_encodeObjectKey(normalizedPath)}`, {
    method: 'PUT',
    headers,
    body: arrayBuffer,
  })

  if (!response.ok) {
    let responseBodyText = ''
    try {
      responseBodyText = await response.clone().text()
    } catch (_) {}
    const uploadDetails = {
      status: response.status,
      statusText: response.statusText || '',
      bodyText: responseBodyText ? responseBodyText.slice(0, 1000) : null,
      blobSize: Number(blob?.size || 0),
      uploadVariant: String(options?.uploadVariant || options?.uploadMeta?.upload_variant || 'full').trim().toLowerCase() || 'full',
      uploadMode: String(options?.uploadMode || options?.uploadMeta?.upload_mode || 'reduced').trim().toLowerCase() || 'reduced',
      cloudPlan: String(options?.cloudPlan || options?.uploadMeta?.cloud_plan || 'free').trim().toLowerCase() || 'free',
      storagePath: normalizedPath,
    }
    console.error('[media-upload] worker upload failed', uploadDetails)
    const detail = uploadDetails.bodyText || uploadDetails.statusText || 'Upload failed'
    throw new Error(`Worker upload failed (${uploadDetails.status}): ${detail}`)
  }
}

async function _deleteViaWorker(path) {
  const normalizedPath = normalizeMediaKey(path)
  if (!normalizedPath) return

  const session = await getSharedAuthSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media delete')

  const mediaUploadBaseUrl = getMediaUploadBaseUrl()
  const response = await fetch(`${mediaUploadBaseUrl}/upload/${_encodeObjectKey(normalizedPath)}`, {
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

  const session = await getSharedAuthSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for media download')

  const mediaUploadBaseUrl = getMediaUploadBaseUrl()
  const response = await fetch(`${mediaUploadBaseUrl}/upload/${_encodeObjectKey(normalizedPath)}`, {
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
  if (!isBlob(blob)) throw new Error('Worker download returned invalid data')
  return blob
}

async function _downloadViaSupabaseStorage(path) {
  const normalizedPath = normalizeMediaKey(path)
  if (!normalizedPath) throw new Error('Missing storage path')

  const { data, error } = await supabase.storage
    .from('observation-images')
    .download(normalizedPath)

  if (error) throw new Error(`Storage download failed: ${error.message}`)
  if (!isBlob(data)) throw new Error('Storage download returned invalid data')
  return data
}

async function _uploadToStorage(path, blob, options = {}) {
  const mediaUploadBaseUrl = getMediaUploadBaseUrl()
  if (mediaUploadBaseUrl) {
    await _uploadViaWorker(path, blob, options)
    return
  }
  if (!canUseLegacySupabaseStorageFallbackForTestsOnly()) {
    throw _mediaStorageFallbackDisabledError()
  }
  const { error } = await supabase.storage
    .from('observation-images')
    .upload(path, blob, { contentType: blob?.type || 'image/jpeg', upsert: true })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
}

function _loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      img._sporelyObjectUrl = url
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Image decode failed'))
    }
    img.src = url
  })
}

function _releaseImage(img) {
  const url = img?._sporelyObjectUrl
  if (url) URL.revokeObjectURL(url)
  if (img) img.src = ''
}

function _targetSizeForPolicy(width, height, uploadPolicy, fullImagePlan = null) {
  const sourceWidth = Math.max(1, Number(width) || 0)
  const sourceHeight = Math.max(1, Number(height) || 0)
  const policy = fullImagePlan || uploadPolicy || getEffectiveCloudUploadPolicy()
  const scaled = scaleDimensionsToMaxPixels(
    sourceWidth,
    sourceHeight,
    policy.resizeMaxPixels || policy.resize_max_pixels || policy.maxPixels || 0,
    policy.resizeMaxEdge || policy.resize_max_edge,
  )
  return {
    targetWidth: scaled.width,
    targetHeight: scaled.height,
  }
}

async function _thumbnailEncodeCandidates() {
  const support = await _getCanvasExportSupport()
  return buildThumbnailEncodeCandidates(support)
}

async function _buildFullImagePreparationPlan(uploadPolicy) {
  const policy = uploadPolicy || getEffectiveCloudUploadPolicy()
  const exportSupport = await _getCanvasExportSupport()
  return buildFullImagePreparationPolicy(policy, _getRuntimeCanvasPolicyContext(), exportSupport)
}

let _imageWorker = null
let _imageWorkerSeq = 0
const _imageWorkerRequests = new Map()

function _getImageWorker() {
  if (_imageWorker) return _imageWorker
  if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    debugImagePipeline('get image worker: worker not supported or unavailable')
    return null
  }
  _imageWorker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' })
  _imageWorker.onmessage = event => {
    const { id, result, error } = event.data || {}
    const pending = _imageWorkerRequests.get(id)
    if (!pending) return
    _imageWorkerRequests.delete(id)
    if (error) pending.reject(new Error(error))
    else pending.resolve(result)
  }
  _imageWorker.onerror = event => {
    const error = new Error(event?.message || 'Image worker failed')
    for (const pending of _imageWorkerRequests.values()) pending.reject(error)
    _imageWorkerRequests.clear()
    _imageWorker?.terminate?.()
    _imageWorker = null
  }
  return _imageWorker
}

async function _canvasToEncodedBlob(canvas, candidates = [], options = {}) {
  const byteCap = Number.isFinite(Number(options.byteCap)) ? Number(options.byteCap) : null
  const verbose = options.verbose === true
  const runtimePath = String(options.runtimePath || '').trim()
  const blockedTypes = new Set()
  let sawEncodedBlob = false
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const candidateType = _normalizeCanvasExportMimeType(candidate.type)
    if (!candidateType || blockedTypes.has(candidateType)) continue
    const blob = await new Promise(resolve => {
      canvas.toBlob(nextBlob => resolve(nextBlob), candidate.type, candidate.quality)
    })
    if (!blob || blob.size <= 0) {
      if (verbose) {
        debugImagePipeline('Encoding candidate produced no blob', {
          requestedType: candidate.type,
          quality: candidate.quality,
        })
      }
      continue
    }
    if (blob.type !== candidate.type) {
      if (candidateType === 'image/webp') {
        _markCanvasExportSupport(candidate.type, false)
      }
      blockedTypes.add(candidateType)
      if (verbose) {
        debugImagePipeline('Encoding candidate returned different type', {
          requestedType: candidate.type,
          actualType: blob.type,
          quality: candidate.quality,
          sizeMb: (blob.size / (1024 * 1024)).toFixed(2),
        })
      }
      continue
    }
    sawEncodedBlob = true

    const sizeMb = (blob.size / (1024 * 1024)).toFixed(2)
    const limitMb = byteCap ? (byteCap / (1024 * 1024)).toFixed(2) : 'none'
    if (verbose) {
      debugImagePipeline('Encoding iteration', {
        format: candidate.type,
        quality: candidate.quality,
        sizeMb: `${sizeMb} MB`,
        limitMb: `${limitMb} MB`,
        status: byteCap && blob.size > byteCap ? 'REJECTED (too large)' : 'ACCEPTED'
      })
    }

    if (byteCap && blob.size > byteCap) {
      const jump = getFullImageEncodeRetryJump({
        runtimePath,
        candidates,
        currentIndex: index,
        rejectedBytes: blob.size,
        byteCap,
      })
      if (jump && verbose) {
        debugImagePipeline('Encoding iteration jump', {
          runtimePath,
          rejectedQuality: candidate.quality,
          rejectedBytes: blob.size,
          byteCap,
          overshootRatio: Number(jump.overshootRatio.toFixed(3)),
          nextQuality: jump.nextQuality,
        })
      }
      if (jump) {
        index = Math.max(index, jump.nextIndex - 1)
      }
      continue
    }
    return {
      blob,
      quality: candidate.quality,
      type: candidate.type,
    }
  }
  if (byteCap && sawEncodedBlob) {
    if (verbose) debugImagePipeline('All encoding attempts failed byte cap', { limit: byteCap })
    throw _buildUploadMediaError(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE, {
      byteCap,
    })
  }
  throw new Error('Image encoding failed')
}

async function _encodeCanvasWithFitByteCapFallback({
  source,
  sourceWidth,
  sourceHeight,
  targetWidth,
  targetHeight,
  candidates,
  byteCap,
  verbose = false,
  runtimePath = '',
}) {
  const attemptedSizes = new Set([`${targetWidth}x${targetHeight}`])
  const tryEncode = async (width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      _drawHighQuality(source, sourceWidth, sourceHeight, canvas, width, height)
      return await _canvasToEncodedBlob(canvas, candidates, { byteCap, verbose, runtimePath })
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  try {
    const encoded = await tryEncode(targetWidth, targetHeight)
    return {
      ...encoded,
      storedWidth: targetWidth,
      storedHeight: targetHeight,
    }
  } catch (error) {
    if (String(error?.message || error || '').toLowerCase().indexOf(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE.toLowerCase()) === -1) {
      throw error
    }
  }

  for (const attempt of buildFullImageFitByteCapAttempts(targetWidth, targetHeight)) {
    const fitWidth = attempt.width
    const fitHeight = attempt.height
    const key = `${fitWidth}x${fitHeight}`
    if (attemptedSizes.has(key)) continue
    attemptedSizes.add(key)
    debugImagePipeline('prepare upload blob: retrying with reduced dimensions', {
      targetWidth: fitWidth,
      targetHeight: fitHeight,
      byteCap,
    })
    try {
      const encoded = await tryEncode(fitWidth, fitHeight)
      return {
        ...encoded,
        storedWidth: fitWidth,
        storedHeight: fitHeight,
      }
    } catch (error) {
      if (String(error?.message || error || '').toLowerCase().indexOf(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE.toLowerCase()) === -1) {
        throw error
      }
    }
  }

  throw _buildUploadMediaError(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE, { byteCap })
}

function _configureCanvasContext(ctx) {
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
}

function _drawHighQuality(source, sourceWidth, sourceHeight, targetCanvas, targetWidth, targetHeight) {
  let currentSource = source
  let currentWidth = sourceWidth
  let currentHeight = sourceHeight
  const scratchCanvases = []

  while (currentWidth / targetWidth > 2 || currentHeight / targetHeight > 2) {
    const nextWidth = Math.max(targetWidth, Math.round(currentWidth / 2))
    const nextHeight = Math.max(targetHeight, Math.round(currentHeight / 2))
    const scratch = document.createElement('canvas')
    scratch.width = nextWidth
    scratch.height = nextHeight
    const scratchCtx = scratch.getContext('2d', { alpha: false })
    if (!scratchCtx) break
    _configureCanvasContext(scratchCtx)
    scratchCtx.drawImage(currentSource, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight)
    if (currentSource instanceof HTMLCanvasElement) scratchCanvases.push(currentSource)
    currentSource = scratch
    currentWidth = nextWidth
    currentHeight = nextHeight
  }

  const targetCtx = targetCanvas.getContext('2d', { alpha: false })
  if (!targetCtx) throw new Error('Canvas context unavailable')
  _configureCanvasContext(targetCtx)
  targetCtx.drawImage(currentSource, 0, 0, currentWidth, currentHeight, 0, 0, targetWidth, targetHeight)

  if (currentSource instanceof HTMLCanvasElement && currentSource !== targetCanvas) scratchCanvases.push(currentSource)
  scratchCanvases.forEach(canvas => {
    canvas.width = 0
    canvas.height = 0
  })
}

async function _prepareUploadBlobInWorker(blob, policy) {
  const worker = _getImageWorker()
  if (!worker) return null
  const normalizedType = String(blob?.type || '').split(';')[0].trim().toLowerCase()
  if (normalizedType === 'image/heic' || normalizedType === 'image/heif') return null
  if (normalizedType && !normalizedType.startsWith('image/')) return null
  const isDebugEnabled = isImagePipelineDebugEnabled()
  debugImagePipeline('prepare upload blob in worker: creating image bitmap', { blobType: blob.type, blobSize: blob.size }, isDebugEnabled)
  const bitmap = await createImageBitmap(blob)
  debugImagePipeline('prepare upload blob in worker: image bitmap created', { width: bitmap.width, height: bitmap.height }, isDebugEnabled)
  const runtimeContext = _getRuntimeCanvasPolicyContext()
  const fullImagePlan = await _buildFullImagePreparationPlan(policy)
  debugImagePipeline('resolved full image policy', {
    runtimePath: fullImagePlan.runtimePath,
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
    resizeMaxPixels: fullImagePlan.resizeMaxPixels,
    byteCap: fullImagePlan.byteCap,
    webpEncodeSupported: fullImagePlan.candidates.some(candidate => candidate.type === 'image/webp'),
    isIosWebKit: looksLikeIosWebKitRuntime(runtimeContext),
  }, isDebugEnabled)
  const id = `image-${++_imageWorkerSeq}`
  const result = await new Promise((resolve, reject) => {
    _imageWorkerRequests.set(id, { resolve, reject })
    try {
      debugImagePipeline('prepare upload blob in worker: posting message to worker', { id, isDebugEnabled }, isDebugEnabled)
      worker.postMessage({ id, bitmap, policy: fullImagePlan, isDebugEnabled }, [bitmap])
    } catch (error) {
      _imageWorkerRequests.delete(id)
      bitmap?.close?.()
      reject(error)
    }
  })
  if (!result?.fullBytes || !result?.fullType) return null
  debugImagePipeline('prepare upload blob in worker: worker returned complete result', { id, result }, isDebugEnabled)
  const sizeMb = (result.fullBytes.byteLength / (1024 * 1024)).toFixed(2)
  debugImagePipeline('Worker encoding result', {
    format: result.fullType,
    quality: result.encodingQuality,
    sizeMb: `${sizeMb} MB`,
    sourceRes: `${result.sourceWidth}x${result.sourceHeight}`,
    targetRes: `${result.targetWidth}x${result.targetHeight}`,
    storedRes: `${result.storedWidth || result.targetWidth}x${result.storedHeight || result.targetHeight}`,
  })

  const uploadBlob = new Blob([result.fullBytes], { type: result.fullType })
  const thumbBlob = result.thumbBytes && result.thumbType
    ? new Blob([result.thumbBytes], { type: result.thumbType })
    : null
  const thumbMeta = thumbBlob ? {
    upload_mode: policy.uploadMode || 'reduced',
    quality_profile: policy.qualityProfile || 'standard',
    encoding_quality: result.thumbEncodingQuality ?? null,
    encoding_format: result.thumbEncodingFormat || thumbBlob.type || null,
    source_width: result.sourceWidth,
    source_height: result.sourceHeight,
    stored_width: result.thumbWidth ?? null,
    stored_height: result.thumbHeight ?? null,
    stored_bytes: thumbBlob.size || result.thumbSize || 0,
  } : null
  return {
    uploadBlob,
    variants: thumbBlob ? { thumb: thumbBlob } : {},
    variantMeta: thumbMeta ? { thumb: thumbMeta } : null,
    uploadMeta: {
      upload_mode: policy.uploadMode || 'reduced',
      quality_profile: policy.qualityProfile || 'standard',
      encoding_quality: result.encodingQuality ?? policy.fullImageWebpQuality ?? null,
      encoding_format: result.fullType || uploadBlob.type || null,
      source_width: result.sourceWidth,
      source_height: result.sourceHeight,
      stored_width: result.storedWidth ?? result.targetWidth,
      stored_height: result.storedHeight ?? result.targetHeight,
      stored_bytes: uploadBlob.size || result.fullSize || 0,
      storage_exif_safe: true,
    },
  }
}

async function _prepareUploadBlob(blob, uploadPolicy) {
  if (!isBlob(blob)) throw new Error('Missing image blob')

  const policy = uploadPolicy || getEffectiveCloudUploadPolicy()

  try {
    const prepared = await _prepareUploadBlobInWorker(blob, policy) // This will now pass the debug flag
    if (prepared) {
      return prepared
    } else {
      debugImagePipeline('prepare upload blob: worker returned null, falling back to main thread', { blobType: blob.type })
    }
  } catch (err) {
    if (_isImageTooLargeForPlanError(err)) throw err
    console.warn('Image worker processing failed; falling back to main thread:', err)
    debugImagePipeline('prepare upload blob: worker processing failed, falling back to main thread', { error: err.message })
  }

  let img
  try {
    debugImagePipeline('prepare upload blob: attempting main thread _loadImage', { blobType: blob.type })
    img = await _loadImage(blob)
  } catch (err) {
    debugImagePipeline('prepare upload blob: browser could not decode image; failing closed', {
      type: blob.type,
      sizeMb: (blob.size / (1024 * 1024)).toFixed(2)
    })
    throw _buildUndecodableImageError({
      blobType: blob.type || null,
      blobSize: blob.size || 0,
      stage: 'load-image',
      originalError: String(err?.message || err || '') || null,
    })
  }

  const sourceWidth = img.naturalWidth || img.width
  const sourceHeight = img.naturalHeight || img.height
  if (!sourceWidth || !sourceHeight) {
    _releaseImage(img)
    debugImagePipeline('prepare upload blob: decoded image had no dimensions; failing closed', {
      type: blob.type,
      sizeMb: (blob.size / (1024 * 1024)).toFixed(2)
    })
    throw _buildUndecodableImageError({
      blobType: blob.type || null,
      blobSize: blob.size || 0,
      stage: 'missing-dimensions',
    })
  }

  debugImagePipeline('prepare upload blob: main thread _loadImage successful', { sourceWidth: sourceWidth, sourceHeight: sourceHeight })
  const fullImagePlan = await _buildFullImagePreparationPlan(policy)
  const { targetWidth, targetHeight } = _targetSizeForPolicy(sourceWidth, sourceHeight, policy, fullImagePlan)

  const canvas = document.createElement('canvas')
  const thumbCanvas = document.createElement('canvas')
  try {
    canvas.width = targetWidth
    canvas.height = targetHeight
    debugImagePipeline('prepare upload blob: drawing full image to canvas', { targetWidth, targetHeight })
    _drawHighQuality(img, sourceWidth, sourceHeight, canvas, targetWidth, targetHeight)

    debugImagePipeline('prepare upload blob: encoding full image', {
      runtimePath: fullImagePlan.runtimePath,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      byteCap: fullImagePlan.byteCap,
      candidates: fullImagePlan.candidates.map(candidate => `${candidate.type}@${candidate.quality}`),
    })
    const fullEncoding = await _encodeCanvasWithFitByteCapFallback({
      source: img,
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight,
      candidates: fullImagePlan.candidates,
      byteCap: fullImagePlan.byteCap,
      verbose: isImagePipelineDebugEnabled(),
      runtimePath: fullImagePlan.runtimePath,
    })
    const fullBlob = fullEncoding.blob
    await new Promise(r => setTimeout(r, 20)) // Yield to UI thread
    debugImagePipeline('prepare upload blob: full image accepted', {
      runtimePath: fullImagePlan.runtimePath,
      sourceWidth,
      sourceHeight,
      targetWidth: fullEncoding.storedWidth ?? targetWidth,
      targetHeight: fullEncoding.storedHeight ?? targetHeight,
      byteCap: fullImagePlan.byteCap,
      acceptedFormat: fullEncoding.type || fullBlob.type || null,
      acceptedQuality: fullEncoding.quality ?? null,
      acceptedBytes: fullBlob.size || 0,
    })

    const thumbScale = Math.min(1, 400 / Math.max(targetWidth, targetHeight))
    const thumbWidth = Math.max(1, Math.round(targetWidth * thumbScale))
    const thumbHeight = Math.max(1, Math.round(targetHeight * thumbScale))
    thumbCanvas.width = thumbWidth
    thumbCanvas.height = thumbHeight
    _drawHighQuality(canvas, targetWidth, targetHeight, thumbCanvas, thumbWidth, thumbHeight)
    const thumbEncoding = await _canvasToEncodedBlob(
      thumbCanvas,
      await _thumbnailEncodeCandidates(),
      {
        verbose: isImagePipelineDebugEnabled(),
      },
    )
    const thumbBlob = thumbEncoding.blob
    await new Promise(r => setTimeout(r, 20)) // Yield to UI thread
    if (isImagePipelineDebugEnabled()) {
      debugImagePipeline('prepare upload blob: thumbnail accepted', {
        sourceWidth,
        sourceHeight,
        targetWidth: thumbWidth,
        targetHeight: thumbHeight,
        acceptedFormat: thumbEncoding.type || thumbBlob.type || null,
        acceptedQuality: thumbEncoding.quality ?? null,
        acceptedBytes: thumbBlob.size || 0,
      })
    }

    return {
      uploadBlob: fullBlob,
      variants: thumbBlob ? { thumb: thumbBlob } : {},
      variantMeta: thumbBlob ? {
        thumb: {
          upload_mode: policy.uploadMode || 'reduced',
          quality_profile: policy.qualityProfile || 'standard',
          encoding_quality: thumbEncoding.quality ?? null,
          encoding_format: thumbEncoding.type || thumbBlob.type || null,
          source_width: sourceWidth,
          source_height: sourceHeight,
          stored_width: thumbWidth,
          stored_height: thumbHeight,
          stored_bytes: thumbBlob.size || 0,
        },
      } : null,
      uploadMeta: {
        upload_mode: policy.uploadMode || 'reduced',
        quality_profile: policy.qualityProfile || 'standard',
        encoding_quality: fullEncoding.quality ?? policy.fullImageWebpQuality ?? null,
        encoding_format: fullEncoding.type || fullBlob.type || null,
        source_width: sourceWidth,
        source_height: sourceHeight,
        stored_width: fullEncoding.storedWidth ?? targetWidth,
        stored_height: fullEncoding.storedHeight ?? targetHeight,
        stored_bytes: fullBlob.size || 0,
        storage_exif_safe: true,
      },
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
    thumbCanvas.width = 0
    thumbCanvas.height = 0
    _releaseImage(img)
  }
}

export async function prepareImageVariants(blob, uploadPolicy) {
  const policy = uploadPolicy || getEffectiveCloudUploadPolicy()
  debugImagePipeline('prepare image variants', {
    blobType: blob?.type || '',
    blobSize: blob?.size || 0,
    uploadMode: policy.uploadMode || 'reduced',
  })
  const { uploadBlob, uploadMeta, variants, variantMeta } = await _prepareUploadBlob(blob, policy)

  return { uploadBlob, uploadMeta, variants, variantMeta }
}

export async function uploadPreparedObservationImageVariants(preparedImage, storagePath, options = {}) {
  const uploadPolicy = options?.uploadPolicy || getEffectiveCloudUploadPolicy()
  const normalizedPath = assertObservationImageStoragePathUserPrefix(storagePath, options?.userId, {
    observationId: options?.observationId,
    imageId: options?.imageId,
  })
  debugImagePipeline('upload prepared observation image variants', {
    uploadMode: preparedImage.uploadMeta?.upload_mode || uploadPolicy.uploadMode || 'reduced',
    qualityProfile: preparedImage.uploadMeta?.quality_profile || uploadPolicy.qualityProfile || 'standard',
    hasThumb: !!preparedImage.variants?.thumb,
  })
  const thumbMeta = preparedImage.variantMeta?.thumb || null
  const uploadOptions = {
    uploadMode: preparedImage.uploadMeta?.upload_mode || uploadPolicy.uploadMode,
    cloudPlan: uploadPolicy.cloudPlan,
    qualityProfile: preparedImage.uploadMeta?.quality_profile || uploadPolicy.qualityProfile || 'standard',
    uploadMeta: preparedImage.uploadMeta || null,
    uploadVariant: 'full',
    uploadOrigin: options?.uploadOrigin || 'web',
  }

  await _uploadToStorage(normalizedPath, preparedImage.uploadBlob, uploadOptions)
  if (preparedImage.variants?.thumb) {
    const thumbPath = getVariantPath(normalizedPath, 'thumb')
    await _uploadToStorage(thumbPath, preparedImage.variants.thumb, {
      ...uploadOptions,
      uploadVariant: 'thumb',
      uploadMeta: thumbMeta || preparedImage.uploadMeta || null,
    })
  }
  return preparedImage.uploadMeta
}

export async function uploadObservationImageVariants(blob, storagePath, options = {}) {
  const uploadPolicy = options?.uploadPolicy || getEffectiveCloudUploadPolicy()
  debugImagePipeline('upload observation image variants', {
    blobType: blob?.type || '',
    blobSize: blob?.size || 0,
  })
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

function _isFetchableImageUrl(url) {
  const text = String(url || '').trim()
  if (!text) return false
  if (text.startsWith('blob:') || text.startsWith('data:')) return true

  try {
    const parsed = new URL(text, globalThis.location?.href || 'https://example.invalid')
    if (globalThis.location?.origin && parsed.origin === globalThis.location.origin) return true
    return parsed.pathname.includes('/storage/v1/object/sign/')
  } catch (_) {
    return false
  }
}

async function _fetchImageBlobFromUrl(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Image fetch failed: ${response.status}`)
  }
  const contentType = String(response.headers.get('content-type') || '').trim().toLowerCase()
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`Non-image response (${contentType})`)
  }
  const blob = await response.blob()
  if (!isBlob(blob)) throw new Error('Image fetch returned invalid data')
  return blob
}

function _isAiCropWriteDebugEnabled() {
  try {
    return Boolean(import.meta.env?.DEV)
      || globalThis.localStorage?.getItem('sporely-debug-dashboard') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-image-pipeline') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-artsorakel') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-inaturalist') === 'true'
  } catch (_) {
    return Boolean(import.meta.env?.DEV)
  }
}

function _shouldWarnAiCropFallback() {
  return _isAiCropWriteDebugEnabled()
}

function _formatSupabaseError(error) {
  return {
    code: error?.code || null,
    message: error?.message || '',
    details: error?.details || '',
    hint: error?.hint || '',
    status: error?.status || error?.statusCode || null,
  }
}

function _logAiCropWriteError(action, payload, error, details = {}) {
  if (!_isAiCropWriteDebugEnabled()) return
  console.warn(`[${action}] Supabase crop write failed`, {
    ...details,
    payload,
    error: _formatSupabaseError(error),
  })
}

function _warnMissingAiCropCustomFallback(action, error, details = {}) {
  if (!_shouldWarnAiCropFallback()) return
  console.warn(`[${action}] observation_images.ai_crop_is_custom missing; saving crop without custom flag`, {
    ...details,
    error: {
      ..._formatSupabaseError(error),
    },
  })
}

export async function deleteObservationMedia(paths) {
  const normalized = [...new Set((paths || [])
    .map(normalizeMediaKey)
    .filter(Boolean)
  )]
  if (!normalized.length) return

  const withVariants = [...new Set(normalized.flatMap(path => [
    path,
    getVariantPath(path, 'thumb'),
  ]))]

  const mediaUploadBaseUrl = getMediaUploadBaseUrl()
  if (mediaUploadBaseUrl) {
    await Promise.all(withVariants.map(path => _deleteViaWorker(path)))
    return
  }
  if (!canUseLegacySupabaseStorageFallbackForTestsOnly()) {
    throw _mediaStorageFallbackDisabledError()
  }

  const { error } = await supabase.storage
    .from('observation-images')
    .remove(withVariants)

  if (error) throw new Error(`Storage delete failed: ${error.message}`)
}

export async function downloadObservationImageBlob(storagePath, options = {}) {
  const originalPath = normalizeMediaKey(storagePath)
  if (!originalPath) throw new Error('Missing image storage path')
  debugImagePipeline('download observation image blob', {
    variant: options.variant || 'medium',
  })

  const variant = options.variant || 'medium'
  const allowWorkerDownload = options.allowWorkerDownload !== false
  const sourceList = await resolveMediaSources([originalPath], { variant })
  const source = sourceList[0] || null
  const mediaUploadBaseUrl = getMediaUploadBaseUrl()
  let lastError = null

  if (allowWorkerDownload && mediaUploadBaseUrl) {
    // Prefer the authenticated worker for blob reads. Public media URLs are
    // fine for <img> tags, but cross-origin fetches there can trip CORB and are
    // not reliable for blob decoding.
    const candidatePaths = variant === 'original'
      ? [originalPath]
      : [getVariantPath(originalPath, variant), originalPath]
    for (const path of [...new Set(candidatePaths.filter(Boolean))]) {
      try {
        const data = await _downloadViaWorker(path)
        if (isBlob(data)) return data
      } catch (err) {
        lastError = err
      }
    }
  }

  if (allowWorkerDownload) {
    const candidatePaths = variant === 'original'
      ? [originalPath]
      : [getVariantPath(originalPath, variant), originalPath]
    for (const path of [...new Set(candidatePaths.filter(Boolean))]) {
      try {
        const data = await _downloadViaSupabaseStorage(path)
        if (isBlob(data)) return data
      } catch (err) {
        lastError = err
      }
    }
  }

  const candidateUrls = []
  if (source?.primaryUrl && _isFetchableImageUrl(source.primaryUrl)) {
    candidateUrls.push(source.primaryUrl)
  }
  if (source?.fallbackUrl && _isFetchableImageUrl(source.fallbackUrl)) {
    candidateUrls.push(source.fallbackUrl)
  }

  for (const url of [...new Set(candidateUrls.filter(Boolean))]) {
    try {
      const data = await _fetchImageBlobFromUrl(url)
      if (isBlob(data)) return data
    } catch (err) {
      lastError = err
    }
  }

  if (!lastError) {
    lastError = new Error('Cross-origin media blobs require the authenticated media worker or same-origin media URLs.')
  }

  throw new Error(`Image download failed: ${lastError?.message || originalPath}`)
}

export async function insertObservationImage(observationImage) {
  const cropRect = normalizeAiCropRect(observationImage?.aiCropRect)
  const cropSourceW = observationImage?.aiCropSourceW ?? null
  const cropSourceH = observationImage?.aiCropSourceH ?? null
  const aiCropIsCustom = observationImage?.aiCropIsCustom === true
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
    ai_crop_is_custom: aiCropIsCustom,
  }
  const payloadWithUploadMeta = {
    ...payloadWithCrop,
    upload_mode: observationImage?.upload_mode || null,
    source_width: observationImage?.source_width ?? null,
    source_height: observationImage?.source_height ?? null,
    stored_width: observationImage?.stored_width ?? null,
    stored_height: observationImage?.stored_height ?? null,
    stored_bytes: observationImage?.stored_bytes ?? null,
    storage_exif_safe: observationImage?.storage_exif_safe === true,
  }

  if (_isAiCropWriteDebugEnabled()) {
    console.debug('[insertObservationImage] payload', {
      observationId: basePayload.observation_id ?? null,
      payload: payloadWithUploadMeta,
    })
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
    'ai_crop_is_custom',
  ]

  const uploadFieldMissing = UPLOAD_METADATA_FIELDS.some(field => _isMissingColumnError(error, field))
  if (uploadFieldMissing) {
    const { error: retryError } = await supabase
      .from('observation_images')
      .insert(payloadWithCrop)
    if (!retryError) return false
    if (_isMissingColumnError(retryError, 'ai_crop_is_custom')) {
      _warnMissingAiCropCustomFallback('insertObservationImage', retryError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        payload: payloadWithCrop,
      })
      const payloadWithoutCustom = { ...payloadWithCrop }
      delete payloadWithoutCustom.ai_crop_is_custom
      const { error: cropRetryError } = await supabase
        .from('observation_images')
        .insert(payloadWithoutCustom)
      if (!cropRetryError) return false
      _logAiCropWriteError('insertObservationImage', payloadWithoutCustom, cropRetryError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        phase: 'retry-without-custom',
      })
      if (!cropFieldNames.filter(field => field !== 'ai_crop_is_custom').some(field => _isMissingColumnError(cropRetryError, field))) {
        throw cropRetryError
      }
      _logAiCropWriteError('insertObservationImage', payloadWithoutCustom, cropRetryError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        phase: 'base-fallback',
      })
    } else if (!cropFieldNames.filter(field => field !== 'ai_crop_is_custom').some(field => _isMissingColumnError(retryError, field))) {
      _logAiCropWriteError('insertObservationImage', payloadWithCrop, retryError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        phase: 'retry-with-crop',
      })
      throw retryError
    } else {
      _logAiCropWriteError('insertObservationImage', payloadWithCrop, retryError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        phase: 'base-fallback',
      })
    }
    const { error: fallbackError } = await supabase
      .from('observation_images')
      .insert(basePayload)
    if (fallbackError) {
      _logAiCropWriteError('insertObservationImage', basePayload, fallbackError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        phase: 'base-fallback',
      })
      throw fallbackError
    }
    return false
  }

  if (_isMissingColumnError(error, 'ai_crop_is_custom')) {
    _warnMissingAiCropCustomFallback('insertObservationImage', error, {
      observationId: basePayload.observation_id ?? null,
      storagePath: basePayload.storage_path || '',
      payload: payloadWithCrop,
    })
    const payloadWithoutCustom = { ...payloadWithCrop }
    delete payloadWithoutCustom.ai_crop_is_custom
    const { error: retryError } = await supabase
      .from('observation_images')
      .insert(payloadWithoutCustom)
    if (!retryError) return false
    _logAiCropWriteError('insertObservationImage', payloadWithoutCustom, retryError, {
      observationId: basePayload.observation_id ?? null,
      storagePath: basePayload.storage_path || '',
      phase: 'retry-without-custom',
    })
    if (!cropFieldNames.filter(field => field !== 'ai_crop_is_custom').some(field => _isMissingColumnError(retryError, field))) {
      throw retryError
    }
    const { error: fallbackError } = await supabase
      .from('observation_images')
      .insert(basePayload)
    if (fallbackError) {
      _logAiCropWriteError('insertObservationImage', basePayload, fallbackError, {
        observationId: basePayload.observation_id ?? null,
        storagePath: basePayload.storage_path || '',
        phase: 'base-fallback',
      })
      throw fallbackError
    }
    return false
  }

  if (!cropFieldNames.filter(field => field !== 'ai_crop_is_custom').some(field => _isMissingColumnError(error, field))) {
    _logAiCropWriteError('insertObservationImage', payloadWithUploadMeta, error, {
      observationId: basePayload.observation_id ?? null,
      storagePath: basePayload.storage_path || '',
      phase: 'initial',
    })
    throw error
  }
  _logAiCropWriteError('insertObservationImage', payloadWithUploadMeta, error, {
    observationId: basePayload.observation_id ?? null,
    storagePath: basePayload.storage_path || '',
    phase: 'base-fallback',
  })

  const { error: fallbackError } = await supabase
    .from('observation_images')
    .insert(basePayload)

  if (fallbackError) {
    _logAiCropWriteError('insertObservationImage', basePayload, fallbackError, {
      observationId: basePayload.observation_id ?? null,
      storagePath: basePayload.storage_path || '',
      phase: 'base-fallback',
    })
    throw fallbackError
  }
  return false
}

export async function updateObservationImageCrop(imageId, cropData) {
  if (!imageId) return false
  const cropRect = normalizeAiCropRect(cropData?.aiCropRect)
  const aiCropIsCustom = cropData?.aiCropIsCustom === true
  const payload = {
    ai_crop_x1: cropRect?.x1 ?? null,
    ai_crop_y1: cropRect?.y1 ?? null,
    ai_crop_x2: cropRect?.x2 ?? null,
    ai_crop_y2: cropRect?.y2 ?? null,
    ai_crop_source_w: cropData?.aiCropSourceW ?? null,
    ai_crop_source_h: cropData?.aiCropSourceH ?? null,
    ai_crop_is_custom: aiCropIsCustom,
  }
  if (_isAiCropWriteDebugEnabled()) {
    console.debug('[updateObservationImageCrop] payload', { imageId, payload })
  }
  const { error } = await supabase
    .from('observation_images')
    .update(payload)
    .eq('id', imageId)
  if (!error) return true
  if (_isMissingColumnError(error, 'ai_crop_is_custom')) {
    _warnMissingAiCropCustomFallback('updateObservationImageCrop', error, {
      imageId,
      payload,
    })
    const retryPayload = {
      ai_crop_x1: cropRect?.x1 ?? null,
      ai_crop_y1: cropRect?.y1 ?? null,
      ai_crop_x2: cropRect?.x2 ?? null,
      ai_crop_y2: cropRect?.y2 ?? null,
      ai_crop_source_w: cropData?.aiCropSourceW ?? null,
      ai_crop_source_h: cropData?.aiCropSourceH ?? null,
    }
    const { error: retryError } = await supabase
      .from('observation_images')
      .update(retryPayload)
      .eq('id', imageId)
    if (!retryError) return true
    _logAiCropWriteError('updateObservationImageCrop', retryPayload, retryError, {
      imageId,
      phase: 'retry-without-custom',
    })
    throw retryError
  }

  _logAiCropWriteError('updateObservationImageCrop', payload, error, {
    imageId,
    phase: 'initial',
  })
  throw error
}

export async function syncObservationMediaKeys(observationId, storagePath, options = {}) {
  if (!observationId) return
  const sortOrder = options.sortOrder
  if (sortOrder !== undefined && sortOrder !== null && Number(sortOrder) !== 0) return false

  const imageKey = normalizeMediaKey(storagePath)
  if (!imageKey) return false
  const thumbKey = getVariantPath(imageKey, 'thumb')

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

export async function resolveMediaSources(paths, options = {}) {
  const variant = options.variant || 'original'
  const normalizedPaths = (paths || []).map(normalizeMediaKey)

  return normalizedPaths.map(originalPath => {
    if (!originalPath) return { key: '', primaryUrl: null, fallbackUrl: null }
    const canonicalOriginalPath = (() => {
      const { dir, fileName } = _splitPath(originalPath)
      const stripped = _stripLegacyVariantPrefixes(fileName)
      return stripped && stripped !== fileName
        ? (dir ? `${dir}/${stripped}` : stripped)
        : originalPath
    })()
    const originalUrl = getPublicMediaUrl(canonicalOriginalPath, 'original')
    const variantUrl = getPublicMediaUrl(canonicalOriginalPath, variant)

    if (variant === 'original') {
      return {
        key: canonicalOriginalPath,
        primaryUrl: originalUrl,
        fallbackUrl: null,
      }
    }
    const fallbackUrl = originalUrl !== variantUrl ? originalUrl : null
    return {
      key: canonicalOriginalPath,
      primaryUrl: variantUrl,
      fallbackUrl,
    }
  })
}

async function _fetchObservationImageRowsFrom(table, obsIds, selectFields) {
  return supabase
    .from(table)
    .select(selectFields)
    .in('observation_id', obsIds)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
}

export async function fetchObservationImageRows(obsIds, options = {}) {
  if (!obsIds.length) return []
  const selectFields = options.selectFields || 'id, observation_id, storage_path, sort_order, image_type, ai_crop_x1, ai_crop_y1, ai_crop_x2, ai_crop_y2, ai_crop_source_w, ai_crop_source_h, ai_crop_is_custom, deleted_at'

  const communityRes = await _fetchObservationImageRowsFrom(OBSERVATION_IMAGES_COMMUNITY_VIEW, obsIds, selectFields)
  if (!communityRes.error) {
    return communityRes.data || []
  }

  const fallbackRes = await _fetchObservationImageRowsFrom('observation_images', obsIds, selectFields)
  if (!fallbackRes.error) {
    return fallbackRes.data || []
  }

  return []
}

/**
 * Given an array of observation IDs, returns a map of
 * { obsId -> { primaryUrl, fallbackUrl } } for the first image.
 */
export async function fetchFirstImages(obsIds, options = {}) {
  if (!obsIds.length) return {}
  const variant = options.variant || 'medium'
  const data = await fetchObservationImageRows(obsIds, {
    selectFields: 'observation_id, storage_path, sort_order, deleted_at',
  })
  if (!data.length) return {}

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
  const data = await fetchObservationImageRows(obsIds, {
    selectFields: 'observation_id, storage_path, sort_order, deleted_at',
  })
  if (!data.length) return {}

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
