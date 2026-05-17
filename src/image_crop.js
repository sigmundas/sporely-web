export const AI_CROP_ASPECT_RATIO = 1
export const DEFAULT_AI_CROP_COVERAGE = 0.76

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function _loadBlobImage(blob) {
  return new Promise((resolve, reject) => {
    const urlApi = globalThis.URL
    const imageCtor = globalThis.Image
    if (!urlApi?.createObjectURL || typeof imageCtor !== 'function') {
      reject(new Error('Image decode unavailable'))
      return
    }
    const url = urlApi.createObjectURL(blob)
    const img = new imageCtor()
    img.onload = () => {
      urlApi.revokeObjectURL?.(url)
      resolve(img)
    }
    img.onerror = () => {
      urlApi.revokeObjectURL?.(url)
      reject(new Error('Image decode failed'))
    }
    img.src = url
  })
}

function _isBlob(value) {
  return value instanceof Blob || (value && typeof value.size === 'number' && typeof value.type === 'string')
}

async function _decodeBlobImageSource(blob) {
  if (typeof createImageBitmap === 'function' && typeof window !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(blob)
      const width = bitmap.width || null
      const height = bitmap.height || null
      if (width && height) {
        return {
          source: bitmap,
          width,
          height,
          release() {
            bitmap.close?.()
          },
        }
      }
      bitmap.close?.()
    } catch (_) {
      // Fall back to the existing image-element path below.
    }
  }

  const img = await _loadBlobImage(blob)
  return {
    source: img,
    width: img.naturalWidth || img.width || null,
    height: img.naturalHeight || img.height || null,
    release() {
      img.src = ''
    },
  }
}

export function normalizeAiCropRect(rect) {
  if (!rect) return null

  const x1 = Number(rect.x1)
  const y1 = Number(rect.y1)
  const x2 = Number(rect.x2)
  const y2 = Number(rect.y2)

  if (![x1, y1, x2, y2].every(Number.isFinite)) return null

  const left = _clamp(Math.min(x1, x2), 0, 1)
  const top = _clamp(Math.min(y1, y2), 0, 1)
  const right = _clamp(Math.max(x1, x2), 0, 1)
  const bottom = _clamp(Math.max(y1, y2), 0, 1)

  if (right - left < 0.0001 || bottom - top < 0.0001) return null

  return { x1: left, y1: top, x2: right, y2: bottom }
}

export function hasAiCropRect(rect) {
  return !!normalizeAiCropRect(rect)
}

function _getSquareCropBounds(sourceWidth, sourceHeight, rect = null) {
  const width = Number(sourceWidth)
  const height = Number(sourceHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  const normalized = normalizeAiCropRect(rect)
  const left = normalized ? normalized.x1 * width : 0
  const top = normalized ? normalized.y1 * height : 0
  const right = normalized ? normalized.x2 * width : width
  const bottom = normalized ? normalized.y2 * height : height

  const cropWidth = Math.max(1, Math.round(right - left))
  const cropHeight = Math.max(1, Math.round(bottom - top))
  const size = Math.max(1, Math.min(cropWidth, cropHeight))
  const centerX = left + cropWidth / 2
  const centerY = top + cropHeight / 2
  const maxX = Math.max(0, Math.round(width - size))
  const maxY = Math.max(0, Math.round(height - size))

  return {
    x: _clamp(Math.round(centerX - size / 2), 0, maxX),
    y: _clamp(Math.round(centerY - size / 2), 0, maxY),
    size,
  }
}

export function getDefaultAiCropRect(sourceWidth, sourceHeight, options = {}) {
  const width = Number(sourceWidth)
  const height = Number(sourceHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  const coverage = _clamp(
    Number.isFinite(Number(options.coverage))
      ? Number(options.coverage)
      : DEFAULT_AI_CROP_COVERAGE,
    0.1,
    1,
  )

  const cropSize = Math.min(width, height) * coverage
  const x = (width - cropSize) / 2
  const y = (height - cropSize) / 2

  return normalizeAiCropRect({
    x1: x / width,
    y1: y / height,
    x2: (x + cropSize) / width,
    y2: (y + cropSize) / height,
  })
}

export function getCropFrameSize(containerWidth, containerHeight, options = {}) {
  const padding = Math.max(0, Number(options.padding) || 24)
  const widthRatio = _clamp(Number(options.widthRatio) || 0.76, 0.2, 1)

  const maxWidth = Math.max(1, containerWidth - padding * 2)
  const maxHeight = Math.max(1, containerHeight - padding * 2)

  const size = Math.min(maxWidth, maxHeight, containerWidth * widthRatio)

  return {
    width: Math.max(1, Math.round(size)),
    height: Math.max(1, Math.round(size)),
  }
}

export function getBaseCropScale(imageWidth, imageHeight, frameWidth, frameHeight) {
  return Math.max(frameWidth / imageWidth, frameHeight / imageHeight)
}

export function constrainCropOffset({
  imageWidth,
  imageHeight,
  frameWidth,
  frameHeight,
  baseScale,
  zoom,
  offsetX,
  offsetY,
}) {
  const effectiveScale = baseScale * zoom
  const drawnWidth = imageWidth * effectiveScale
  const drawnHeight = imageHeight * effectiveScale

  const maxX = Math.max(0, drawnWidth / 2 - frameWidth / 2)
  const maxY = Math.max(0, drawnHeight / 2 - frameHeight / 2)

  return {
    offsetX: _clamp(offsetX, -maxX, maxX),
    offsetY: _clamp(offsetY, -maxY, maxY),
  }
}

export function getViewportStateFromCropRect({
  imageWidth,
  imageHeight,
  frameWidth,
  frameHeight,
  rect,
}) {
  const normalized = normalizeAiCropRect(rect)
    || getDefaultAiCropRect(imageWidth, imageHeight)

  const cropWidth = (normalized.x2 - normalized.x1) * imageWidth
  const cropHeight = (normalized.y2 - normalized.y1) * imageHeight
  const cropX = normalized.x1 * imageWidth
  const cropY = normalized.y1 * imageHeight

  const baseScale = getBaseCropScale(imageWidth, imageHeight, frameWidth, frameHeight)
  const effectiveScale = Math.max(frameWidth / cropWidth, frameHeight / cropHeight)
  const zoom = Math.max(1, effectiveScale / baseScale)

  const drawnWidth = imageWidth * effectiveScale
  const drawnHeight = imageHeight * effectiveScale
  const rawOffsetX = drawnWidth / 2 - frameWidth / 2 - cropX * effectiveScale
  const rawOffsetY = drawnHeight / 2 - frameHeight / 2 - cropY * effectiveScale

  return {
    zoom,
    ...constrainCropOffset({
      imageWidth,
      imageHeight,
      frameWidth,
      frameHeight,
      baseScale,
      zoom,
      offsetX: rawOffsetX,
      offsetY: rawOffsetY,
    }),
  }
}

export function getCropRectFromViewport({
  imageWidth,
  imageHeight,
  frameWidth,
  frameHeight,
  baseScale,
  zoom,
  offsetX,
  offsetY,
}) {
  const effectiveScale = baseScale * zoom
  const drawnWidth = imageWidth * effectiveScale
  const drawnHeight = imageHeight * effectiveScale
  const sourceX = (drawnWidth / 2 - frameWidth / 2 - offsetX) / effectiveScale
  const sourceY = (drawnHeight / 2 - frameHeight / 2 - offsetY) / effectiveScale
  const sourceWidth = frameWidth / effectiveScale
  const sourceHeight = frameHeight / effectiveScale

  return normalizeAiCropRect({
    x1: sourceX / imageWidth,
    y1: sourceY / imageHeight,
    x2: (sourceX + sourceWidth) / imageWidth,
    y2: (sourceY + sourceHeight) / imageHeight,
  })
}

export async function getBlobImageDimensions(blob) {
  if (!(blob instanceof Blob)) return null
  const img = await _loadBlobImage(blob)
  return {
    width: img.naturalWidth || img.width || null,
    height: img.naturalHeight || img.height || null,
  }
}

async function _prepareAiUploadBlob(blob, options = {}) {
  const inputMeta = {
    inputType: blob?.type || '',
    inputSize: Number(blob?.size || 0),
    sourceWidth: null,
    sourceHeight: null,
    cropRect: null,
    cropSourceW: null,
    cropSourceH: null,
    cropped: false,
    sourceMaxEdge: null,
    targetWidth: null,
    targetHeight: null,
    resized: false,
    converted: false,
    prepared: false,
    fallback: false,
    maxEdge: Math.max(1, Number(options.maxEdge || 1920) || 1920),
  }

  if (!(blob instanceof Blob)) {
    return { blob, ...inputMeta, outputType: inputMeta.inputType, outputSize: inputMeta.inputSize }
  }

  const documentApi = globalThis.document
  const urlApi = globalThis.URL

  if (typeof documentApi === 'undefined' || typeof urlApi === 'undefined') {
    return { blob, ...inputMeta, outputType: inputMeta.inputType, outputSize: inputMeta.inputSize }
  }

  let decoded = null
  let objectUrl = null

  try {
    const cropRect = normalizeAiCropRect(options.cropRect)
    const squareCrop = options.squareCrop === true
    objectUrl = urlApi.createObjectURL(blob)
    const imageCtor = globalThis.Image
    if (typeof imageCtor === 'undefined') {
      throw new Error('Image decode unavailable')
    }
    decoded = await new Promise((resolve, reject) => {
      const nextImg = new imageCtor()
      nextImg.onload = () => resolve({
        source: nextImg,
        width: nextImg.naturalWidth || nextImg.width || null,
        height: nextImg.naturalHeight || nextImg.height || null,
        release() {
          nextImg.src = ''
        },
      })
      nextImg.onerror = () => reject(new Error('Image decode failed'))
      nextImg.src = objectUrl
    })

    const sourceWidth = decoded.width || null
    const sourceHeight = decoded.height || null
    const sourceMaxEdge = Math.max(Number(sourceWidth) || 0, Number(sourceHeight) || 0) || null
    const normalizedCropRect = cropRect && sourceWidth && sourceHeight ? cropRect : null
    const cropBounds = squareCrop
      ? _getSquareCropBounds(sourceWidth, sourceHeight, normalizedCropRect)
      : (normalizedCropRect
        ? {
            x: Math.max(0, Math.round(normalizedCropRect.x1 * sourceWidth)),
            y: Math.max(0, Math.round(normalizedCropRect.y1 * sourceHeight)),
            width: Math.max(1, Math.round((normalizedCropRect.x2 - normalizedCropRect.x1) * sourceWidth)),
            height: Math.max(1, Math.round((normalizedCropRect.y2 - normalizedCropRect.y1) * sourceHeight)),
          }
        : null)
    const workingWidth = cropBounds
      ? (squareCrop ? cropBounds.size : cropBounds.width)
      : sourceWidth
    const workingHeight = cropBounds
      ? (squareCrop ? cropBounds.size : cropBounds.height)
      : sourceHeight
    const workingMaxEdge = Math.max(Number(workingWidth) || 0, Number(workingHeight) || 0) || null
    const needsResize = Number.isFinite(workingMaxEdge) && workingMaxEdge > inputMeta.maxEdge
    const normalizedType = String(blob.type || '').toLowerCase()
    const needsJpeg = options.forceJpeg === true ? normalizedType !== 'image/jpeg' : normalizedType !== 'image/jpeg'

    inputMeta.sourceWidth = sourceWidth
    inputMeta.sourceHeight = sourceHeight
    inputMeta.sourceMaxEdge = sourceMaxEdge
    inputMeta.cropRect = normalizedCropRect
    inputMeta.cropSourceW = sourceWidth
    inputMeta.cropSourceH = sourceHeight
    inputMeta.cropped = !!cropBounds

    if (!sourceWidth || !sourceHeight || (!cropBounds && !needsResize && !needsJpeg)) {
      return {
        blob,
        ...inputMeta,
        outputType: blob.type || '',
        outputSize: Number(blob.size || 0),
      }
    }

    const targetWidth = needsResize
      ? Math.max(1, Math.round(workingWidth * (inputMeta.maxEdge / workingMaxEdge)))
      : workingWidth
    const targetHeight = needsResize
      ? Math.max(1, Math.round(workingHeight * (inputMeta.maxEdge / workingMaxEdge)))
      : workingHeight
    const canvas = documentApi.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas context unavailable')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (cropBounds) {
      const drawWidth = squareCrop ? cropBounds.size : cropBounds.width
      const drawHeight = squareCrop ? cropBounds.size : cropBounds.height
      ctx.drawImage(decoded.source, cropBounds.x, cropBounds.y, drawWidth, drawHeight, 0, 0, targetWidth, targetHeight)
    } else {
      ctx.drawImage(decoded.source, 0, 0, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight)
    }

    const outputBlob = await new Promise(resolve => {
      canvas.toBlob(nextBlob => resolve(_isBlob(nextBlob) ? nextBlob : null), 'image/jpeg', 0.88)
    })
    if (!_isBlob(outputBlob) || outputBlob.type !== 'image/jpeg') {
      throw new Error('JPEG export failed')
    }

    inputMeta.targetWidth = targetWidth
    inputMeta.targetHeight = targetHeight
    inputMeta.resized = needsResize
    inputMeta.converted = needsJpeg || !!cropBounds
    inputMeta.prepared = true
    return {
      blob: outputBlob,
      ...inputMeta,
      outputType: outputBlob.type,
      outputSize: outputBlob.size,
    }
  } catch (error) {
    const errorMessage = String(error?.message || error || '')
    if (globalThis.__SPORLEY_DEBUG_IMAGE_PREP__ === true) {
      console.debug('[image-prep] fallback', {
        inputType: inputMeta.inputType,
        inputSize: inputMeta.inputSize,
        maxEdge: inputMeta.maxEdge,
        errorMessage,
      })
    }
    return {
      blob,
      ...inputMeta,
      fallback: true,
      errorMessage,
      outputType: blob.type || '',
      outputSize: Number(blob.size || 0),
    }
  } finally {
    if (objectUrl) urlApi.revokeObjectURL?.(objectUrl)
    decoded?.release?.()
  }
}

export async function generateAiUploadBlob(blob, cropRect, maxEdge = 1920) {
  const prepared = await _prepareAiUploadBlob(blob, {
    cropRect,
    maxEdge,
    forceJpeg: true,
  })
  return prepared.blob
}

export async function prepareImageBlobForUpload(blob, options = {}) {
  return _prepareAiUploadBlob(blob, options)
}

export async function createImageCropMeta(blob, options = {}) {
  const dims = await getBlobImageDimensions(blob)
  const width = dims?.width || null
  const height = dims?.height || null
  const existingRect = normalizeAiCropRect(options.aiCropRect)

  return {
    aiCropRect: existingRect || (
      options.preseed === false || !width || !height
        ? null
        : getDefaultAiCropRect(width, height, options)
    ),
    aiCropSourceW: width,
    aiCropSourceH: height,
  }
}

export async function createCroppedImageBlob(blob, rect, options = {}) {
  if (!(blob instanceof Blob)) return blob

  const documentApi = globalThis.document
  const urlApi = globalThis.URL
  if (typeof documentApi === 'undefined' || typeof urlApi === 'undefined') {
    return blob
  }

  const normalized = normalizeAiCropRect(rect)
  let decoded = null
  let objectUrl = null

  try {
    objectUrl = urlApi.createObjectURL(blob)
    const imageCtor = globalThis.Image
    if (typeof imageCtor === 'undefined') {
      throw new Error('Image decode unavailable')
    }
    decoded = await new Promise((resolve, reject) => {
      const nextImg = new imageCtor()
      nextImg.onload = () => resolve({
        source: nextImg,
        width: nextImg.naturalWidth || nextImg.width || null,
        height: nextImg.naturalHeight || nextImg.height || null,
        release() {
          nextImg.src = ''
        },
      })
      nextImg.onerror = () => reject(new Error('Image decode failed'))
      nextImg.src = objectUrl
    })

    const sourceWidth = decoded.width || null
    const sourceHeight = decoded.height || null
    const cropBounds = _getSquareCropBounds(sourceWidth, sourceHeight, normalized)
    if (!cropBounds) return blob

    const maxEdge = Number(options.maxEdge)
    const targetSize = Number.isFinite(maxEdge) && maxEdge > 0 && cropBounds.size > maxEdge
      ? Math.max(1, Math.round(maxEdge))
      : cropBounds.size
    const canvas = documentApi.createElement('canvas')
    canvas.width = targetSize
    canvas.height = targetSize
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas context unavailable')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(
      decoded.source,
      cropBounds.x,
      cropBounds.y,
      cropBounds.size,
      cropBounds.size,
      0,
      0,
      targetSize,
      targetSize,
    )

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        cropped => cropped ? resolve(cropped) : reject(new Error('Crop export failed')),
        options.type || 'image/jpeg',
        options.quality ?? 0.92,
      )
    })
  } finally {
    if (objectUrl) urlApi.revokeObjectURL?.(objectUrl)
    decoded?.release?.()
  }
}
