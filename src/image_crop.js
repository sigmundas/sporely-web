export const AI_CROP_ASPECT_RATIO = 1
export const DEFAULT_AI_CROP_COVERAGE = 0.76

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function _loadBlobImage(blob) {
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

export function getDefaultAiCropRect(sourceWidth, sourceHeight, options = {}) {
  const width = Number(sourceWidth)
  const height = Number(sourceHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  const aspectRatio = Number(options.aspectRatio) > 0
    ? Number(options.aspectRatio)
    : AI_CROP_ASPECT_RATIO
  const coverage = _clamp(
    Number.isFinite(Number(options.coverage))
      ? Number(options.coverage)
      : DEFAULT_AI_CROP_COVERAGE,
    0.1,
    1,
  )

  let cropWidth = width
  let cropHeight = cropWidth / aspectRatio
  if (cropHeight > height) {
    cropHeight = height
    cropWidth = cropHeight * aspectRatio
  }

  cropWidth *= coverage
  cropHeight *= coverage

  const x = (width - cropWidth) / 2
  const y = (height - cropHeight) / 2

  return normalizeAiCropRect({
    x1: x / width,
    y1: y / height,
    x2: (x + cropWidth) / width,
    y2: (y + cropHeight) / height,
  })
}

export function getCropFrameSize(containerWidth, containerHeight, options = {}) {
  const aspectRatio = Number(options.aspectRatio) > 0
    ? Number(options.aspectRatio)
    : AI_CROP_ASPECT_RATIO
  const padding = Math.max(0, Number(options.padding) || 24)
  const widthRatio = _clamp(Number(options.widthRatio) || 0.76, 0.2, 1)

  const maxWidth = Math.max(1, containerWidth - padding * 2)
  const maxHeight = Math.max(1, containerHeight - padding * 2)

  let width = Math.min(maxWidth, containerWidth * widthRatio)
  let height = width / aspectRatio

  if (height > maxHeight) {
    height = maxHeight
    width = height * aspectRatio
  }

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
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
  const normalized = normalizeAiCropRect(rect)
  if (!(blob instanceof Blob) || !normalized) return blob

  const img = await _loadBlobImage(blob)
  const sourceWidth = img.naturalWidth || img.width
  const sourceHeight = img.naturalHeight || img.height
  if (!sourceWidth || !sourceHeight) return blob

  const cropWidth = Math.max(1, Math.round((normalized.x2 - normalized.x1) * sourceWidth))
  const cropHeight = Math.max(1, Math.round((normalized.y2 - normalized.y1) * sourceHeight))
  const sourceX = Math.max(0, Math.round(normalized.x1 * sourceWidth))
  const sourceY = Math.max(0, Math.round(normalized.y1 * sourceHeight))

  const canvas = document.createElement('canvas')
  canvas.width = cropWidth
  canvas.height = cropHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas context unavailable')

  ctx.drawImage(
    img,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      cropped => cropped ? resolve(cropped) : reject(new Error('Crop export failed')),
      options.type || 'image/jpeg',
      options.quality ?? 0.92,
    )
  })
}
