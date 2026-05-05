const ENCODE_CANDIDATES = [
  { type: 'image/webp', quality: 0.8 },
  { type: 'image/jpeg', quality: 0.7 },
]

function _targetSize(sourceWidth, sourceHeight, policy = {}) {
  const width = Math.max(1, Number(sourceWidth) || 0)
  const height = Math.max(1, Number(sourceHeight) || 0)
  let maxEdge = 1600

  if (policy.uploadMode === 'full') {
    const pixels = width * height
    maxEdge = pixels > 13_000_000 ? 4000 : Math.max(width, height)
  }

  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function _encodeCanvas(canvas, candidates = ENCODE_CANDIDATES) {
  for (const candidate of candidates) {
    const blob = await canvas.convertToBlob({
      type: candidate.type,
      quality: candidate.quality,
    })
    if (blob?.type === candidate.type && blob.size > 0) return blob
  }
  throw new Error('Image encoding failed')
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

    canvas = new OffscreenCanvas(target.width, target.height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('OffscreenCanvas context unavailable')
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)

    const fullBlob = await _encodeCanvas(canvas)

    const thumbScale = Math.min(1, 400 / Math.max(target.width, target.height))
    const thumbWidth = Math.max(1, Math.round(target.width * thumbScale))
    const thumbHeight = Math.max(1, Math.round(target.height * thumbScale))
    thumbCanvas = new OffscreenCanvas(thumbWidth, thumbHeight)
    const thumbCtx = thumbCanvas.getContext('2d', { alpha: false })
    if (!thumbCtx) throw new Error('OffscreenCanvas thumbnail context unavailable')
    thumbCtx.drawImage(canvas, 0, 0, thumbWidth, thumbHeight)
    const thumbBlob = await _encodeCanvas(thumbCanvas, [
      { type: 'image/webp', quality: 0.7 },
      { type: 'image/jpeg', quality: 0.65 },
    ])

    const fullBytes = await fullBlob.arrayBuffer()
    const thumbBytes = await thumbBlob.arrayBuffer()
    self.postMessage({
      id,
      result: {
        fullBytes,
        fullType: fullBlob.type,
        fullSize: fullBlob.size,
        thumbBytes,
        thumbType: thumbBlob.type,
        thumbSize: thumbBlob.size,
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
