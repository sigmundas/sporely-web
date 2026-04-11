import {
  AI_CROP_ASPECT_RATIO,
  constrainCropOffset,
  getBaseCropScale,
  getCropFrameSize,
  getCropRectFromViewport,
  getDefaultAiCropRect,
  getViewportStateFromCropRect,
  normalizeAiCropRect,
} from './image_crop.js'

let overlay = null
let titleEl = null
let counterEl = null
let viewportEl = null
let imageEl = null
let prevBtn = null
let nextBtn = null
let resetBtn = null
let cancelBtn = null
let saveBtn = null

let session = null
let currentIndex = 0
let imageWidth = 0
let imageHeight = 0
let frameWidth = 0
let frameHeight = 0
let baseScale = 1
let zoom = 1
let offsetX = 0
let offsetY = 0
let pointers = new Map()
let pinchStartDistance = 0
let pinchStartZoom = 1
let dragStartX = 0
let dragStartY = 0
let dragStartOffsetX = 0
let dragStartOffsetY = 0

function _applyImageTransform() {
  if (!imageEl || !viewportEl || !imageWidth || !imageHeight) return

  const effectiveScale = baseScale * zoom
  const drawnWidth = imageWidth * effectiveScale
  const drawnHeight = imageHeight * effectiveScale
  const left = viewportEl.clientWidth / 2 + offsetX - drawnWidth / 2
  const top = viewportEl.clientHeight / 2 + offsetY - drawnHeight / 2

  imageEl.style.width = `${drawnWidth}px`
  imageEl.style.height = `${drawnHeight}px`
  imageEl.style.left = `${left}px`
  imageEl.style.top = `${top}px`
}

function _constrainOffsets() {
  const next = constrainCropOffset({
    imageWidth,
    imageHeight,
    frameWidth,
    frameHeight,
    baseScale,
    zoom,
    offsetX,
    offsetY,
  })
  offsetX = next.offsetX
  offsetY = next.offsetY
}

function _commitCurrentCrop() {
  if (!session?.images?.[currentIndex] || !imageWidth || !imageHeight) return

  const rect = getCropRectFromViewport({
    imageWidth,
    imageHeight,
    frameWidth,
    frameHeight,
    baseScale,
    zoom,
    offsetX,
    offsetY,
  })

  session.onChange?.(currentIndex, {
    aiCropRect: rect,
    aiCropSourceW: imageWidth,
    aiCropSourceH: imageHeight,
  })
}

function _syncChrome() {
  if (!session) return

  titleEl.textContent = session.title || 'AI crop'
  counterEl.textContent = session.images.length > 1 ? `${currentIndex + 1} / ${session.images.length}` : ''
  prevBtn.style.display = currentIndex > 0 ? 'flex' : 'none'
  nextBtn.style.display = currentIndex < session.images.length - 1 ? 'flex' : 'none'
}

function _resetCurrentCrop() {
  if (!imageWidth || !imageHeight) return

  const rect = getDefaultAiCropRect(imageWidth, imageHeight, {
    aspectRatio: AI_CROP_ASPECT_RATIO,
  })
  const state = getViewportStateFromCropRect({
    imageWidth,
    imageHeight,
    frameWidth,
    frameHeight,
    rect,
  })
  zoom = state.zoom
  offsetX = state.offsetX
  offsetY = state.offsetY
  _applyImageTransform()
}

function _loadCurrentImage() {
  if (!session?.images?.length) return

  const item = session.images[currentIndex]
  imageWidth = 0
  imageHeight = 0
  imageEl.style.width = '0px'
  imageEl.style.height = '0px'
  imageEl.src = item.url

  _syncChrome()
}

function _showIndex(index) {
  if (!session?.images?.length) return
  currentIndex = Math.max(0, Math.min(index, session.images.length - 1))
  _loadCurrentImage()
}

function _navigate(delta) {
  if (!session) return
  const nextIndex = currentIndex + delta
  if (nextIndex < 0 || nextIndex >= session.images.length) return
  _commitCurrentCrop()
  _showIndex(nextIndex)
}

function _dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function _close(commit) {
  if (commit) _commitCurrentCrop()
  if (!overlay) return
  overlay.style.display = 'none'
  document.body.style.overflow = ''
  imageEl.removeAttribute('src')
  session?.onClose?.(commit)
  session = null
  pointers.clear()
}

export function initAiCropEditor() {
  overlay = document.getElementById('ai-crop-editor')
  titleEl = document.getElementById('ai-crop-title')
  counterEl = document.getElementById('ai-crop-counter')
  viewportEl = document.getElementById('ai-crop-viewport')
  imageEl = document.getElementById('ai-crop-image')
  prevBtn = document.getElementById('ai-crop-prev')
  nextBtn = document.getElementById('ai-crop-next')
  resetBtn = document.getElementById('ai-crop-reset')
  cancelBtn = document.getElementById('ai-crop-cancel')
  saveBtn = document.getElementById('ai-crop-save')

  overlay.addEventListener('click', event => {
    if (event.target === overlay) _close(false)
  })

  prevBtn.addEventListener('click', () => _navigate(-1))
  nextBtn.addEventListener('click', () => _navigate(1))
  resetBtn.addEventListener('click', _resetCurrentCrop)
  cancelBtn.addEventListener('click', () => _close(false))
  saveBtn.addEventListener('click', () => _close(true))

  viewportEl.addEventListener('pointerdown', event => {
    if (!session) return
    event.preventDefault()
    viewportEl.setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.size === 1) {
      dragStartX = event.clientX
      dragStartY = event.clientY
      dragStartOffsetX = offsetX
      dragStartOffsetY = offsetY
    }

    if (pointers.size === 2) {
      const pts = [...pointers.values()]
      pinchStartDistance = _dist(pts[0], pts[1])
      pinchStartZoom = zoom
    }
  })

  viewportEl.addEventListener('pointermove', event => {
    if (!session || !pointers.has(event.pointerId)) return

    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const pts = [...pointers.values()]

    if (pts.length === 1) {
      offsetX = dragStartOffsetX + (event.clientX - dragStartX)
      offsetY = dragStartOffsetY + (event.clientY - dragStartY)
    } else if (pts.length === 2 && pinchStartDistance > 0) {
      const nextDistance = _dist(pts[0], pts[1])
      zoom = Math.max(1, Math.min(8, pinchStartZoom * (nextDistance / pinchStartDistance)))
    }

    _constrainOffsets()
    _applyImageTransform()
  })

  const endPointer = event => {
    pointers.delete(event.pointerId)
    if (pointers.size === 1) {
      const [remaining] = pointers.values()
      dragStartX = remaining.x
      dragStartY = remaining.y
      dragStartOffsetX = offsetX
      dragStartOffsetY = offsetY
    }
    if (pointers.size < 2) pinchStartDistance = 0
  }

  viewportEl.addEventListener('pointerup', endPointer)
  viewportEl.addEventListener('pointercancel', endPointer)

  viewportEl.addEventListener('wheel', event => {
    if (!session) return
    event.preventDefault()
    zoom = Math.max(1, Math.min(8, zoom * (event.deltaY < 0 ? 1.08 : 0.92)))
    _constrainOffsets()
    _applyImageTransform()
  }, { passive: false })

  imageEl.addEventListener('load', () => {
    imageWidth = imageEl.naturalWidth || 0
    imageHeight = imageEl.naturalHeight || 0
    if (!imageWidth || !imageHeight) return

    const frame = getCropFrameSize(viewportEl.clientWidth, viewportEl.clientHeight, {
      aspectRatio: AI_CROP_ASPECT_RATIO,
      widthRatio: 0.76,
      padding: 24,
    })
    frameWidth = frame.width
    frameHeight = frame.height
    viewportEl.style.setProperty('--ai-crop-frame-w', `${frameWidth}px`)
    viewportEl.style.setProperty('--ai-crop-frame-h', `${frameHeight}px`)

    baseScale = getBaseCropScale(imageWidth, imageHeight, frameWidth, frameHeight)
    const rect = normalizeAiCropRect(session.images[currentIndex]?.aiCropRect)
      || getDefaultAiCropRect(imageWidth, imageHeight)
    const state = getViewportStateFromCropRect({
      imageWidth,
      imageHeight,
      frameWidth,
      frameHeight,
      rect,
    })
    zoom = state.zoom
    offsetX = state.offsetX
    offsetY = state.offsetY
    _applyImageTransform()
  })

  document.addEventListener('keydown', event => {
    if (!session || overlay.style.display === 'none') return
    if (event.key === 'Escape') _close(false)
    if (event.key === 'ArrowLeft') _navigate(-1)
    if (event.key === 'ArrowRight') _navigate(1)
  })
}

export function openAiCropEditor(options) {
  if (!overlay || !options?.images?.length) return

  session = {
    title: options.title || 'AI crop',
    images: options.images,
    onChange: options.onChange,
    onClose: options.onClose,
  }

  currentIndex = Math.max(0, Math.min(options.startIndex || 0, options.images.length - 1))
  overlay.style.display = 'flex'
  document.body.style.overflow = 'hidden'
  _showIndex(currentIndex)
}
