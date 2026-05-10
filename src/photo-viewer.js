// Full-screen photo viewer with pinch-to-zoom, pan, and swipe navigation

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

let _overlay, _img, _counter, _prevBtn, _nextBtn

export function initPhotoViewer() {
  _overlay = document.getElementById('photo-viewer')
  _img = document.getElementById('photo-viewer-img')
  _counter = document.getElementById('photo-viewer-counter')
  _prevBtn = document.getElementById('photo-viewer-prev')
  _nextBtn = document.getElementById('photo-viewer-next')

  document.getElementById('photo-viewer-close').addEventListener('click', closePhotoViewer)
  _overlay.addEventListener('click', e => { if (e.target === _overlay) closePhotoViewer() })
  _prevBtn.addEventListener('click', () => _navigate(-1))
  _nextBtn.addEventListener('click', () => _navigate(1))

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
  _resetTransform()
  _photos = []
}

function _showCurrent() {
  _resetTransform()
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
