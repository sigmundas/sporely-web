import {
  IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE,
  buildFullImageFitByteCapAttempts,
  buildThumbnailEncodeCandidates,
  scaleDimensionsToMaxPixels,
} from './cloud-media-policy.js'

function _targetSize(sourceWidth, sourceHeight, policy = {}) {
  const width = Math.max(1, Number(sourceWidth) || 0)
  const height = Math.max(1, Number(sourceHeight) || 0)
  const scaled = scaleDimensionsToMaxPixels(
    width,
    height,
    policy.resizeMaxPixels || policy.resize_max_pixels || policy.maxPixels || 0,
    policy.resizeMaxEdge || policy.resize_max_edge,
  )
  return scaled
}

function _debugWorker(message, details = {}, enabled = false) {
  if (!enabled) return
  try {
    console.debug(`[image-pipeline worker] ${message}`, details)
  } catch (_) {}
}

const _canvasExportSupportCache = new Map()

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
  if (typeof OffscreenCanvas === 'undefined') return false

  const probe = (async () => {
    const canvas = new OffscreenCanvas(1, 1)
    try {
      const blob = await canvas.convertToBlob({
        type: normalizedType,
        quality: 0.92,
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

async function _thumbnailEncodeCandidates() {
  const support = await _getCanvasExportSupport()
  return buildThumbnailEncodeCandidates(support)
}

// This function is called from within the worker
async function _encodeCanvas(canvas, candidates, options = {}) {
  const byteCap = Number.isFinite(Number(options.byteCap)) ? Number(options.byteCap) : null
  const verbose = options.verbose === true
  const blockedTypes = new Set()
  let sawEncodedBlob = false
  for (const candidate of candidates) {
    const candidateType = _normalizeCanvasExportMimeType(candidate.type)
    if (!candidateType || blockedTypes.has(candidateType)) continue
    const blob = await canvas.convertToBlob({
      type: candidate.type,
      quality: candidate.quality,
    })
    if (!blob || blob.size <= 0) {
      if (verbose) {
        _debugWorker('Encoding candidate produced no blob', {
          requestedType: candidate.type,
          quality: candidate.quality,
        }, options.isDebugEnabled)
      }
      continue
    }
    if (blob.type !== candidate.type) {
      if (candidateType === 'image/webp') {
        _markCanvasExportSupport(candidate.type, false)
      }
      blockedTypes.add(candidateType)
      if (verbose) {
        _debugWorker('Encoding candidate returned different type', {
          requestedType: candidate.type,
          actualType: blob.type,
          quality: candidate.quality,
          sizeMb: (blob.size / (1024 * 1024)).toFixed(2),
        }, options.isDebugEnabled)
      }
      continue
    }
    sawEncodedBlob = true
    if (byteCap && blob.size > byteCap) {
    if (verbose) {
      _debugWorker('Encoding iteration', { format: candidate.type, quality: candidate.quality, sizeMb: (blob.size / (1024 * 1024)).toFixed(2), limitMb: (byteCap / (1024 * 1024)).toFixed(2), status: 'REJECTED (too large)' }, options.isDebugEnabled)
    }
      continue
    }
    if (verbose) {
      _debugWorker('Encoding iteration', { format: candidate.type, quality: candidate.quality, sizeMb: (blob.size / (1024 * 1024)).toFixed(2), limitMb: (byteCap / (1024 * 1024)).toFixed(2), status: 'ACCEPTED' }, options.isDebugEnabled)
    }
    return {
      blob,
      quality: candidate.quality,
      type: candidate.type,
    }
  }
  if (byteCap && sawEncodedBlob) {
    if (verbose) _debugWorker('All encoding attempts failed byte cap', { limit: byteCap }, options.isDebugEnabled)
    throw new Error(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE) // This error is caught by the worker's onmessage handler
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
  isDebugEnabled = false,
}) {
  const attemptedSizes = new Set()

  const tryEncode = async (width, height) => {
    const canvas = new OffscreenCanvas(width, height)
    try {
      _drawHighQuality(source, sourceWidth, sourceHeight, canvas, width, height)
      return await _encodeCanvas(canvas, candidates, {
        byteCap,
        verbose,
        isDebugEnabled,
      })
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
    if (!String(error?.message || error || '').toLowerCase().includes(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE.toLowerCase())) {
      throw error
    }
  }

  for (const attempt of buildFullImageFitByteCapAttempts(targetWidth, targetHeight)) {
    const fitWidth = attempt.width
    const fitHeight = attempt.height
    const key = `${fitWidth}x${fitHeight}`
    if (attemptedSizes.has(key)) continue
    attemptedSizes.add(key)
    _debugWorker('prepare upload blob: retrying with reduced dimensions', {
      targetWidth: fitWidth,
      targetHeight: fitHeight,
      byteCap,
    }, isDebugEnabled)
    try {
      const encoded = await tryEncode(fitWidth, fitHeight)
      return {
        ...encoded,
        storedWidth: fitWidth,
        storedHeight: fitHeight,
      }
    } catch (error) {
      if (!String(error?.message || error || '').toLowerCase().includes(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE.toLowerCase())) {
        throw error
      }
    }
  }

  throw new Error(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE)
}

function _configureContext(ctx) {
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
    const scratch = new OffscreenCanvas(nextWidth, nextHeight)
    const scratchCtx = scratch.getContext('2d', { alpha: false })
    if (!scratchCtx) break
    _configureContext(scratchCtx)
    scratchCtx.drawImage(currentSource, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight)
    if (currentSource instanceof OffscreenCanvas) scratchCanvases.push(currentSource)
    currentSource = scratch
    currentWidth = nextWidth
    currentHeight = nextHeight
  }

  const targetCtx = targetCanvas.getContext('2d', { alpha: false })
  if (!targetCtx) throw new Error('OffscreenCanvas context unavailable')
  _configureContext(targetCtx)
  targetCtx.drawImage(currentSource, 0, 0, currentWidth, currentHeight, 0, 0, targetWidth, targetHeight)

  if (currentSource instanceof OffscreenCanvas && currentSource !== targetCanvas) scratchCanvases.push(currentSource)
  scratchCanvases.forEach(canvas => {
    canvas.width = 0
    canvas.height = 0
  })
}

self.onmessage = async event => {
  const {
    id,
    bitmap,
    policy = {},
    isDebugEnabled = false,
  } = event.data || {}

  if (!id || !bitmap) return

  let canvas = null
  let thumbCanvas = null

  try {
    const sourceWidth = bitmap.width
    const sourceHeight = bitmap.height
    const fullImagePlan = policy && typeof policy === 'object' ? policy : {}
    const target = _targetSize(sourceWidth, sourceHeight, fullImagePlan)

    canvas = new OffscreenCanvas(target.width, target.height)
    _drawHighQuality(bitmap, sourceWidth, sourceHeight, canvas, target.width, target.height)

    const fullEncoding = await _encodeCanvasWithFitByteCapFallback({
      source: bitmap,
      sourceWidth,
      sourceHeight,
      targetWidth: target.width,
      targetHeight: target.height,
      candidates: fullImagePlan.candidates,
      byteCap: fullImagePlan.byteCap,
      verbose: isDebugEnabled,
      isDebugEnabled,
    })
    const fullBlob = fullEncoding.blob
    _debugWorker('prepare upload blob: full image accepted', {
      runtimePath: fullImagePlan.runtimePath,
      sourceWidth,
      sourceHeight,
      targetWidth: fullEncoding.storedWidth ?? target.width,
      targetHeight: fullEncoding.storedHeight ?? target.height,
      byteCap: fullImagePlan.byteCap,
      acceptedFormat: fullEncoding.type || fullBlob.type || null,
      acceptedQuality: fullEncoding.quality ?? null,
      acceptedBytes: fullBlob.size || 0,
    }, isDebugEnabled)

    const thumbScale = Math.min(1, 400 / Math.max(target.width, target.height))
    const thumbWidth = Math.max(1, Math.round(target.width * thumbScale))
    const thumbHeight = Math.max(1, Math.round(target.height * thumbScale))
    thumbCanvas = new OffscreenCanvas(thumbWidth, thumbHeight)
    _drawHighQuality(canvas, target.width, target.height, thumbCanvas, thumbWidth, thumbHeight)
    const thumbEncoding = await _encodeCanvas(
      thumbCanvas,
      await _thumbnailEncodeCandidates(),
      {
        isDebugEnabled,
        verbose: false,
      },
    )
    const thumbBlob = thumbEncoding.blob
    _debugWorker('prepare upload blob: thumbnail accepted', {
      sourceWidth,
      sourceHeight,
      targetWidth: thumbWidth,
      targetHeight: thumbHeight,
      acceptedFormat: thumbEncoding.type || thumbBlob.type || null,
      acceptedQuality: thumbEncoding.quality ?? null,
      acceptedBytes: thumbBlob.size || 0,
    }, isDebugEnabled)

    const fullBytes = await fullBlob.arrayBuffer()
    const thumbBytes = await thumbBlob.arrayBuffer()
    self.postMessage({
      id,
      result: {
        fullBytes,
        fullType: fullBlob.type,
        fullSize: fullBlob.size,
        encodingQuality: fullEncoding.quality,
        thumbBytes,
        thumbType: thumbBlob.type,
        thumbSize: thumbBlob.size,
        thumbEncodingQuality: thumbEncoding.quality,
        thumbEncodingFormat: thumbBlob.type,
        thumbWidth,
        thumbHeight,
        sourceWidth,
        sourceHeight,
        targetWidth: target.width,
        targetHeight: target.height,
        storedWidth: fullEncoding.storedWidth ?? target.width,
        storedHeight: fullEncoding.storedHeight ?? target.height,
        runtimePath: fullImagePlan.runtimePath,
      },
    }, [fullBytes, thumbBytes])
  } catch (error) {
    self.postMessage({
      id,
      error: String(error?.message || error || 'Image worker failed'),
    })
  } finally {
    bitmap?.close?.()
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
    if (thumbCanvas) {
      thumbCanvas.width = 0
      thumbCanvas.height = 0
    }
  }
}
