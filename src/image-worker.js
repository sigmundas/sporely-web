import {
  CLOUD_THUMB_JPEG_QUALITY,
  CLOUD_THUMB_WEBP_QUALITY,
  IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE,
  buildFullImageWebpQualityAttempts,
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

async function _encodeCanvas(canvas, candidates, options = {}) {
  const byteCap = Number.isFinite(Number(options.byteCap)) ? Number(options.byteCap) : null
  let sawEncodedBlob = false
  for (const candidate of candidates) {
    const blob = await canvas.convertToBlob({
      type: candidate.type,
      quality: candidate.quality,
    })
    if (blob?.type !== candidate.type || blob.size <= 0) continue
    sawEncodedBlob = true
    if (byteCap && blob.size > byteCap) continue
    return {
      blob,
      quality: candidate.quality,
      type: candidate.type,
    }
  }
  if (byteCap && sawEncodedBlob) {
    throw new Error(IMAGE_TOO_LARGE_FOR_PLAN_MESSAGE)
  }
  throw new Error('Image encoding failed')
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
  const { id, bitmap, policy } = event.data || {}
  if (!id || !bitmap) return

  let canvas = null
  let thumbCanvas = null

  try {
    const sourceWidth = bitmap.width
    const sourceHeight = bitmap.height
    const target = _targetSize(sourceWidth, sourceHeight, policy)
    const fullCandidates = (() => {
      const qualities = Array.isArray(policy?.fullImageWebpQualityAttempts) && policy.fullImageWebpQualityAttempts.length
        ? policy.fullImageWebpQualityAttempts
        : buildFullImageWebpQualityAttempts(policy?.qualityProfile)
      const candidates = qualities.map(quality => ({
        type: 'image/webp',
        quality,
      }))
      candidates.push({
        type: 'image/jpeg',
        quality: policy?.fullImageWebpQuality || qualities[0] || 0.65,
      })
      return candidates
    })()

    canvas = new OffscreenCanvas(target.width, target.height)
    _drawHighQuality(bitmap, sourceWidth, sourceHeight, canvas, target.width, target.height)

    const fullEncoding = await _encodeCanvas(canvas, fullCandidates, {
      byteCap: policy?.fullImageByteCap,
    })
    const fullBlob = fullEncoding.blob

    const thumbScale = Math.min(1, 400 / Math.max(target.width, target.height))
    const thumbWidth = Math.max(1, Math.round(target.width * thumbScale))
    const thumbHeight = Math.max(1, Math.round(target.height * thumbScale))
    thumbCanvas = new OffscreenCanvas(thumbWidth, thumbHeight)
    _drawHighQuality(canvas, target.width, target.height, thumbCanvas, thumbWidth, thumbHeight)
    const thumbEncoding = await _encodeCanvas(thumbCanvas, [
      { type: 'image/webp', quality: CLOUD_THUMB_WEBP_QUALITY },
      { type: 'image/jpeg', quality: CLOUD_THUMB_JPEG_QUALITY },
    ])
    const thumbBlob = thumbEncoding.blob

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
