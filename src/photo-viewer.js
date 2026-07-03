// Full-screen photo viewer with pinch-to-zoom, pan, and swipe navigation

import { showToast } from './toast.js'
import { downloadObservationImageBlob } from './images.js'
import { isNativeApp } from './platform.js'

let _photos = []
let _current = 0
let _scale = 1
let _panX = 0
let _panY = 0
let _startTouches = null
let _startScale = 1
let _startPanX = 0
let _startPanY = 0
let _lastTap = 0

let _overlay, _img, _counter, _prevBtn, _nextBtn, _shareBtn, _shareMenu

export function initPhotoViewer() {
  _overlay = document.getElementById('photo-viewer')
  _img = document.getElementById('photo-viewer-img')
  _counter = document.getElementById('photo-viewer-counter')
  _prevBtn = document.getElementById('photo-viewer-prev')
  _nextBtn = document.getElementById('photo-viewer-next')
  _shareBtn = document.getElementById('photo-viewer-share')
  _shareMenu = document.getElementById('photo-viewer-share-menu')

  document.getElementById('photo-viewer-close').addEventListener('click', closePhotoViewer)
  _overlay.addEventListener('click', e => {
    if (e.target === _overlay) closePhotoViewer()
    else if (!e.target.closest('#photo-viewer-share') && !e.target.closest('#photo-viewer-share-menu')) {
      _hideShareMenu()
    }
  })
  _prevBtn.addEventListener('click', () => _navigate(-1))
  _nextBtn.addEventListener('click', () => _navigate(1))

  _shareBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    _toggleShareMenu()
  })
  _shareMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-share-action]')
    if (!btn) return
    e.stopPropagation()
    _hideShareMenu()
    if (btn.dataset.shareAction === 'share') _shareCurrent({ reduced: false })
    else if (btn.dataset.shareAction === 'share-small') _shareCurrent({ reduced: true })
    else if (btn.dataset.shareAction === 'save') _saveCurrent()
  })

  _img.addEventListener('touchstart', _onTouchStart, { passive: false })
  _img.addEventListener('touchmove', _onTouchMove, { passive: false })
  _img.addEventListener('touchend', _onTouchEnd, { passive: false })

  _img.addEventListener('error', () => {
    if (_img.dataset.fallbackSrc && _img.dataset.fallbackApplied !== 'true') {
      _img.dataset.fallbackApplied = 'true'
      _img.src = _img.dataset.fallbackSrc
    }
  })

  document.addEventListener('keydown', e => {
    if (_overlay.style.display === 'none') return
    if (e.key === 'ArrowLeft') _navigate(-1)
    if (e.key === 'ArrowRight') _navigate(1)
    if (e.key === 'Escape') closePhotoViewer()
  })
}

export function openPhotoViewer(photos, startIndex = 0) {
  _photos = photos
  _current = Math.max(0, Math.min(startIndex, photos.length - 1))
  _overlay.style.display = 'flex'
  document.body.style.overflow = 'hidden'
  _showCurrent()
}

export function closePhotoViewer() {
  _overlay.style.display = 'none'
  document.body.style.overflow = ''
  _hideShareMenu()
  _resetTransform()
  _photos = []
}

function _toggleShareMenu() {
  if (!_shareMenu) return
  _shareMenu.style.display = _shareMenu.style.display === 'none' ? 'flex' : 'none'
}

function _hideShareMenu() {
  if (_shareMenu) _shareMenu.style.display = 'none'
}

function _currentPhoto() {
  return _photos[_current] || null
}

function _currentSrc() {
  const photo = _currentPhoto()
  if (!photo) return ''
  return typeof photo === 'string' ? photo : (photo?.src || '')
}

function _currentStoragePath() {
  const photo = _currentPhoto()
  return (photo && typeof photo === 'object' && photo.storagePath) || ''
}

async function _fetchCurrentBlob() {
  const storagePath = _currentStoragePath()
  if (storagePath) {
    try {
      const blob = await downloadObservationImageBlob(storagePath, { variant: 'original' })
      if (blob) return blob
    } catch (_) { /* fall through to direct fetch */ }
  }
  const src = _currentSrc()
  if (!src) throw new Error('no-image')
  const res = await fetch(src)
  if (!res.ok) throw new Error(`fetch failed (${res.status})`)
  return res.blob()
}

function _currentFilenameStem() {
  const photo = _currentPhoto()
  return (photo && typeof photo === 'object' && photo.filenameStem) || ''
}

function _filenameFor(blob) {
  const ext = _extForBlob(blob)
  const stem = _currentFilenameStem()
  if (stem) return `${stem}.${ext}`
  const candidates = [_currentStoragePath(), _currentSrc()].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, globalThis.location?.href)
      const last = url.pathname.split('/').pop() || ''
      if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last
    } catch (_) { /* ignore */ }
    const last = candidate.split('/').pop()
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last
  }
  return `sporely-${Date.now()}.${ext}`
}

function _extForBlob(blob) {
  const type = blob?.type || ''
  if (type.includes('png')) return 'png'
  if (type.includes('webp')) return 'webp'
  if (type.includes('gif')) return 'gif'
  if (type.includes('heic')) return 'heic'
  return 'jpg'
}

const REDUCED_SHARE_MAX_EDGE = 1200
const REDUCED_SHARE_QUALITY = 0.85

async function _shareCurrent({ reduced = false } = {}) {
  let blob = null
  let name = ''
  try {
    const original = await _fetchCurrentBlob()
    if (reduced) {
      blob = await _resizeBlobToJpeg(original, REDUCED_SHARE_MAX_EDGE, REDUCED_SHARE_QUALITY)
      const stem = _currentFilenameStem() || `sporely-${Date.now()}`
      name = `${stem}-small.jpg`
    } else {
      blob = original
      name = _filenameFor(original)
    }

    if (isNativeApp()) {
      await _shareBlobNative(blob, name)
      return
    }
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' })
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: name })
      return
    }
    throw new Error('Web Share API unavailable')
  } catch (err) {
    if (err?.name === 'AbortError') return
    if (blob && name) {
      try {
        await _persistBlob(blob, name)
        showToast(`Share unavailable — saved as ${name}`)
        return
      } catch (_) { /* fall through */ }
    }
    showToast(`Share failed: ${err?.message || err}`)
  }
}

async function _shareBlobNative(blob, filename) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ])
  const base64 = await _blobToBase64(blob)
  const written = await Filesystem.writeFile({
    path: `share/${filename}`,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  })
  const uri = written?.uri
  if (!uri) throw new Error('Failed to stage file for share')
  await Share.share({
    title: filename,
    url: uri,
    dialogTitle: 'Share image',
  })
}

async function _resizeBlobToJpeg(blob, maxEdge, quality) {
  const bitmap = await _decodeBlob(blob)
  const srcW = bitmap.width || 0
  const srcH = bitmap.height || 0
  const longest = Math.max(srcW, srcH)
  const scale = longest > maxEdge ? maxEdge / longest : 1
  const outW = Math.max(1, Math.round(srcW * scale))
  const outH = Math.max(1, Math.round(srcH * scale))
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, outW, outH)
  bitmap.close?.()
  const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!out) throw new Error('Failed to encode reduced image')
  return out
}

async function _decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob)
    } catch (_) { /* fall through to <img> decode */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')) }
    img.src = url
  })
}

async function _saveCurrent() {
  try {
    const blob = await _fetchCurrentBlob()
    const name = _filenameFor(blob)
    await _persistBlob(blob, name)
    showToast(`Saved ${name}`)
  } catch (err) {
    showToast(`Save failed: ${err?.message || err}`)
  }
}

async function _persistBlob(blob, filename) {
  if (isNativeApp()) {
    await _saveBlobToNativeFilesystem(blob, filename)
    return
  }
  _saveBlobViaAnchor(blob, filename)
}

function _saveBlobViaAnchor(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function _saveBlobToNativeFilesystem(blob, filename) {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const base64 = await _blobToBase64(blob)
  await Filesystem.writeFile({
    path: `Sporely/${filename}`,
    data: base64,
    directory: Directory.Documents,
    recursive: true,
  })
}

function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}

function _showCurrent() {
  _resetTransform()
  _hideShareMenu()
  const photo = _photos[_current]
  _img.src = typeof photo === 'string' ? photo : (photo?.src || '')
  if (typeof photo === 'object' && photo.fallbackSrc) {
    _img.dataset.fallbackSrc = photo.fallbackSrc
    _img.dataset.fallbackApplied = 'false'
  } else {
    delete _img.dataset.fallbackSrc
    delete _img.dataset.fallbackApplied
  }
  _counter.textContent = _photos.length > 1 ? `${_current + 1} / ${_photos.length}` : ''
  _prevBtn.style.display = (_current > 0 && _photos.length > 1) ? 'flex' : 'none'
  _nextBtn.style.display = (_current < _photos.length - 1 && _photos.length > 1) ? 'flex' : 'none'
}

function _navigate(dir) {
  const next = _current + dir
  if (next < 0 || next >= _photos.length) return
  _current = next
  _showCurrent()
}

function _resetTransform() {
  _scale = 1; _panX = 0; _panY = 0
  if (_img) _applyTransform()
}

function _applyTransform() {
  _img.style.transform = `translate(${_panX}px, ${_panY}px) scale(${_scale})`
}

function _constrainPan() {
  const rect = _img.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  const imgW = rect.width / _scale, imgH = rect.height / _scale
  const maxX = Math.max(0, (imgW * _scale - vw) / 2)
  const maxY = Math.max(0, (imgH * _scale - vh) / 2)
  _panX = Math.max(-maxX, Math.min(maxX, _panX))
  _panY = Math.max(-maxY, Math.min(maxY, _panY))
}

function _dist(t1, t2) {
  return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
}

function _onTouchStart(e) {
  _startTouches = Array.from(e.touches)
  _startScale = _scale
  _startPanX = _panX
  _startPanY = _panY

  // Double-tap detection
  if (e.touches.length === 1) {
    const now = Date.now()
    if (now - _lastTap < 300) {
      // Double tap — toggle zoom
      if (_scale > 1) {
        _resetTransform()
      } else {
          const cx = window.innerWidth / 2
          const cy = window.innerHeight / 2
          const tx = e.touches[0].clientX
          const ty = e.touches[0].clientY
        _scale = 2.5
          _panX = tx - cx - (tx - cx - _panX) * 2.5
          _panY = ty - cy - (ty - cy - _panY) * 2.5
          _constrainPan()
        _applyTransform()
      }
      _lastTap = 0
      e.preventDefault()
      return
    }
    _lastTap = now
  }
}

function _onTouchMove(e) {
  e.preventDefault()
  if (e.touches.length === 2 && _startTouches?.length === 2) {
    // Pinch-to-zoom
    const startDist = _dist(_startTouches[0], _startTouches[1])
    const nowDist = _dist(e.touches[0], e.touches[1])
    _scale = Math.max(1, Math.min(8, _startScale * (nowDist / startDist)))

    // Pan toward midpoint
    const mx0 = (_startTouches[0].clientX + _startTouches[1].clientX) / 2
    const my0 = (_startTouches[0].clientY + _startTouches[1].clientY) / 2
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2
    
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const ratio = _scale / _startScale
    _panX = mx - cx - (mx0 - cx - _startPanX) * ratio
    _panY = my - cy - (my0 - cy - _startPanY) * ratio

    _constrainPan()
    _applyTransform()
  } else if (e.touches.length === 1 && _startTouches?.length === 1) {
    if (_scale > 1) {
      // Pan only when zoomed
      _panX = _startPanX + (e.touches[0].clientX - _startTouches[0].clientX)
      _panY = _startPanY + (e.touches[0].clientY - _startTouches[0].clientY)
      _constrainPan()
      _applyTransform()
    }
  }
}

function _onTouchEnd(e) {
  if (e.changedTouches.length === 1 && e.touches.length === 0 && _scale <= 1 && _startTouches?.length === 1) {
    const dx = e.changedTouches[0].clientX - _startTouches[0].clientX
    const dy = e.changedTouches[0].clientY - _startTouches[0].clientY
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      _navigate(dx < 0 ? 1 : -1)
    }
  }
  if (_scale < 1) { _scale = 1; _applyTransform() }
}
