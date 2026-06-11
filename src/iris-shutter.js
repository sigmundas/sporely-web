const LIVE_FLASH_DURATION_MS = {
  pending: 1000,
  quick: 100,
}

const LIVE_FLASH_REDUCED_DURATION_MS = {
  pending: 70,
  quick: 40,
}

const DEFAULT_DEBUG_OPTIONS = {
  opacity: 1,
  openAngle: 60,
  closedAngle: 13,
  durationMs: 1800,
  hold: false,
  irisScale: 5,
  curveExponent: 2.35,
  curveStrength: 18,
  bladeLength: 120,
  bladeWidth: 44,
  bladeSamples: 24,
  pivotRadius: 96,
  bladeBackOverhang: 5.5,
}

const BLADE_COUNT = 6
const VIEWBOX_SIZE = 240
const VIEWBOX_HALF = VIEWBOX_SIZE / 2
const VIEWBOX_MIN = -VIEWBOX_HALF

let liveFlashTimer = null
let liveCapturePending = false

let debugOverlayRoot = null
let debugOverlayScene = null
let debugOverlayTimer = null
let debugOverlayToken = 0
let debugOptions = { ...DEFAULT_DEBUG_OPTIONS }

function _prefersReducedMotion() {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  } catch (_) {
    return false
  }
}

function _isDebugEnabled() {
  try {
    return !!(import.meta.env?.DEV || globalThis.location?.hostname === 'localhost')
  } catch (_) {
    return false
  }
}

function _round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(Number(value) * scale) / scale
}

function _formatNumber(value) {
  return Number.isFinite(value) ? String(_round(value, 3)) : '0'
}

function _formatDegrees(value) {
  return `${_round(value, 2)}deg`
}

function _getCaptureViewfinder() {
  return document.querySelector('.capture-viewfinder')
}

function _setLiveCaptureState(active) {
  liveCapturePending = !!active
  const vf = _getCaptureViewfinder()
  if (!vf) return
  vf.classList.toggle('is-iris-pending', liveCapturePending)
}

function _startSimpleFlash(mode, durationMs) {
  const vf = _getCaptureViewfinder()
  if (!vf) return
  vf.classList.add('is-iris-flash')
  vf.dataset.irisFlashMode = mode
  void vf.getBoundingClientRect()
  vf.classList.add('is-iris-flash-armed')

  if (liveFlashTimer) clearTimeout(liveFlashTimer)
  liveFlashTimer = setTimeout(() => {
    liveFlashTimer = null
    vf.classList.remove('is-iris-flash', 'is-iris-flash-armed')
    delete vf.dataset.irisFlashMode
  }, durationMs)
}

function _playIrisOverlay(options) {
  const overlay = _renderDebugOverlay(options)
  if (!overlay) return null
  _animateDebugOverlay(overlay, options.mode, options)
  return overlay
}

export function playIrisShutter({ mode = 'pending' } = {}) {
  const reduced = _prefersReducedMotion()
  const durationMs = reduced
    ? LIVE_FLASH_REDUCED_DURATION_MS[mode] || LIVE_FLASH_REDUCED_DURATION_MS.pending
    : LIVE_FLASH_DURATION_MS[mode] || LIVE_FLASH_DURATION_MS.pending

  if (mode === 'pending') {
    _setLiveCaptureState(true)
  }

  if (reduced) {
    _startSimpleFlash(mode, durationMs)
    return
  }

  _playIrisOverlay({
    ...DEFAULT_DEBUG_OPTIONS,
    mode,
    durationMs,
    hold: mode === 'pending',
  })
}

export function clearIrisShutter() {
  if (liveFlashTimer) {
    clearTimeout(liveFlashTimer)
    liveFlashTimer = null
  }
  const vf = _getCaptureViewfinder()
  if (vf) {
    vf.classList.remove('is-iris-flash', 'is-iris-flash-armed', 'is-iris-pending')
    delete vf.dataset.irisFlashMode
  }

  _setLiveCaptureState(false)
  clearIrisDebug()
}

function _buildBladePath({
  curveExponent,
  curveStrength,
  bladeLength,
  bladeWidth,
  bladeSamples,
  bladeBackOverhang,
}) {
  const baseY = 0
  const tipY = bladeLength
  const back = Math.max(0, Number(bladeBackOverhang) || 0)
  const outerBaseX = -bladeWidth * (0.56 + back * 0.88)
  const outerTipX = -bladeWidth * (0.22 + back * 0.52)
  const innerBaseX = bladeWidth * 0.12
  const innerTipX = bladeWidth * 0.58

  const innerEdge = []
  for (let i = 0; i <= bladeSamples; i += 1) {
    const t = i / bladeSamples
    const eased = Math.pow(t, curveExponent)
    const y = baseY + bladeLength * t
    const taper = bladeWidth * (0.08 + 0.24 * (1 - t))
    const x = innerBaseX + taper + curveStrength * eased
    innerEdge.push([x, y])
  }

  const d = []
  d.push(`M ${_formatNumber(outerBaseX)} ${_formatNumber(baseY)}`)
  d.push(`C ${_formatNumber(outerBaseX - 7)} ${_formatNumber(baseY + bladeLength * 0.16)}, ${_formatNumber(outerTipX - 10)} ${_formatNumber(tipY - bladeLength * 0.14)}, ${_formatNumber(outerTipX)} ${_formatNumber(tipY)}`)
  d.push(`Q ${_formatNumber(-bladeWidth * 0.05)} ${_formatNumber(tipY + 8)}, ${_formatNumber(innerTipX)} ${_formatNumber(tipY)}`)
  for (let i = innerEdge.length - 1; i >= 0; i -= 1) {
    const [x, y] = innerEdge[i]
    d.push(`L ${_formatNumber(x)} ${_formatNumber(y)}`)
  }
  d.push(`Q ${_formatNumber(innerBaseX)} ${_formatNumber(baseY + bladeLength * 0.08)}, ${_formatNumber(outerBaseX)} ${_formatNumber(baseY)}`)
  d.push('Z')
  return d.join(' ')
}

export function buildIrisBladePathData(params = {}) {
  return _buildBladePath({
    curveExponent: Number.isFinite(params.curveExponent) ? params.curveExponent
      : Number.isFinite(params.bladeCurveExponent) ? params.bladeCurveExponent
        : DEFAULT_DEBUG_OPTIONS.curveExponent,
    curveStrength: Number.isFinite(params.curveStrength) ? params.curveStrength
      : Number.isFinite(params.bladeCurveStrength) ? params.bladeCurveStrength
        : DEFAULT_DEBUG_OPTIONS.curveStrength,
    bladeLength: Number.isFinite(params.bladeLength) ? params.bladeLength : DEFAULT_DEBUG_OPTIONS.bladeLength,
    bladeWidth: Number.isFinite(params.bladeWidth) ? params.bladeWidth : DEFAULT_DEBUG_OPTIONS.bladeWidth,
    bladeSamples: Number.isFinite(params.bladeSamples) ? params.bladeSamples : DEFAULT_DEBUG_OPTIONS.bladeSamples,
    bladeBackOverhang: Number.isFinite(params.bladeBackOverhang) ? params.bladeBackOverhang : DEFAULT_DEBUG_OPTIONS.bladeBackOverhang,
  })
}

function _buildDebugBladeMarkup(index, options) {
  const baseAngle = index * (360 / BLADE_COUNT)
  const bladePath = buildIrisBladePathData(options)
  return `
    <div class="iris-debug-blade" style="
      --iris-base-angle: ${_formatDegrees(baseAngle)};
      --iris-open-angle: ${_formatDegrees(options.openAngle)};
      --iris-closed-angle: ${_formatDegrees(options.closedAngle)};
      --iris-pivot-radius: ${_round(options.pivotRadius, 1)}px;
      --iris-duration: ${_round(options.durationMs, 1)}ms;
      --iris-opacity: ${_round(options.opacity, 3)};
      --iris-scale: ${_round(options.irisScale, 3)};
    ">
      <svg class="iris-debug-blade-svg" viewBox="${VIEWBOX_MIN} ${VIEWBOX_MIN} ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}" aria-hidden="true" focusable="false">
        <path class="iris-debug-blade-path" d="${bladePath}"></path>
      </svg>
    </div>
  `
}

function _ensureDebugOverlay() {
  if (debugOverlayRoot?.isConnected) return debugOverlayRoot

  const host = document.getElementById('app') || document.body
  if (!host) return null

  debugOverlayRoot = document.createElement('div')
  debugOverlayRoot.id = 'sporely-iris-debug-overlay'
  debugOverlayRoot.className = 'iris-debug-overlay'
  debugOverlayRoot.setAttribute('aria-hidden', 'true')
  debugOverlayRoot.hidden = true
  debugOverlayRoot.innerHTML = `
    <div class="iris-debug-scrim"></div>
    <div class="iris-debug-stage"></div>
  `
  host.appendChild(debugOverlayRoot)
  debugOverlayScene = debugOverlayRoot.querySelector('.iris-debug-stage')
  return debugOverlayRoot
}

function _applyDebugOverlayOptions(options) {
  const overlay = _ensureDebugOverlay()
  if (!overlay) return null

  overlay.style.setProperty('--iris-debug-opacity', String(options.opacity))
  overlay.style.setProperty('--iris-debug-duration', `${_round(options.durationMs, 1)}ms`)
  overlay.style.setProperty('--iris-debug-open-angle', _formatDegrees(options.openAngle))
  overlay.style.setProperty('--iris-debug-closed-angle', _formatDegrees(options.closedAngle))
  overlay.style.setProperty('--iris-debug-pivot-radius', `${_round(options.pivotRadius, 1)}px`)
  overlay.style.setProperty('--iris-debug-blade-length', `${_round(options.bladeLength, 1)}px`)
  overlay.style.setProperty('--iris-debug-blade-width', `${_round(options.bladeWidth, 1)}px`)
  overlay.style.setProperty('--iris-debug-curve-exponent', String(options.curveExponent))
  overlay.style.setProperty('--iris-debug-curve-strength', String(options.curveStrength))
  overlay.style.setProperty('--iris-debug-scale', String(options.irisScale))
  overlay.style.setProperty('--iris-debug-back-overhang', String(options.bladeBackOverhang))
  return overlay
}

function _renderDebugOverlay(options) {
  const overlay = _applyDebugOverlayOptions(options)
  if (!overlay) return null

  const scene = debugOverlayScene || overlay.querySelector('.iris-debug-stage')
  if (!scene) return null

  scene.innerHTML = Array.from({ length: BLADE_COUNT }, (_, index) => _buildDebugBladeMarkup(index, options)).join('')
  return overlay
}

function _animateDebugOverlay(overlay, mode, options) {
  if (!overlay) return
  debugOverlayToken += 1
  const token = debugOverlayToken

  if (debugOverlayTimer) {
    clearTimeout(debugOverlayTimer)
    debugOverlayTimer = null
  }

  overlay.hidden = false
  overlay.classList.remove('is-holding', 'is-visible', 'mode-pending', 'mode-quick', 'is-playing')
  overlay.classList.add('is-visible', `mode-${mode}`)

  void overlay.getBoundingClientRect()
  overlay.classList.add('is-playing')

  if (options.hold) {
    debugOverlayTimer = setTimeout(() => {
      if (token !== debugOverlayToken || !overlay.isConnected) return
      overlay.classList.remove('is-playing')
      overlay.classList.add('is-holding')
    }, Math.max(0, options.durationMs))
    return
  }

  debugOverlayTimer = setTimeout(() => {
    if (token !== debugOverlayToken || !overlay.isConnected) return
    clearIrisDebug()
  }, Math.max(0, options.durationMs) + 40)
}

export function setIrisDebug(options = {}) {
  debugOptions = {
    ...debugOptions,
    ...options,
  }
  const overlay = debugOverlayRoot
  if (!overlay || overlay.hidden) return debugOptions

  const currentOptions = {
    ...DEFAULT_DEBUG_OPTIONS,
    ...debugOptions,
  }
  _applyDebugOverlayOptions(currentOptions)
  return currentOptions
}

export function playIrisDebug(options = {}) {
  const currentOptions = {
    ...DEFAULT_DEBUG_OPTIONS,
    ...debugOptions,
    ...options,
  }
  currentOptions.durationMs = Number.isFinite(options.durationMs)
    ? Math.max(20, Number(options.durationMs))
    : Math.max(20, Number(currentOptions.durationMs) || DEFAULT_DEBUG_OPTIONS.durationMs)
  currentOptions.opacity = Number.isFinite(options.opacity)
    ? Math.max(0, Math.min(1, Number(options.opacity)))
    : Math.max(0, Math.min(1, Number(currentOptions.opacity)))
  currentOptions.openAngle = Number.isFinite(options.openAngle)
    ? Number(options.openAngle)
    : Number(currentOptions.openAngle)
  currentOptions.closedAngle = Number.isFinite(options.closedAngle)
    ? Number(options.closedAngle)
    : Number(currentOptions.closedAngle)
  currentOptions.bladeLength = Number.isFinite(options.bladeLength)
    ? Number(options.bladeLength)
    : Number(currentOptions.bladeLength)
  currentOptions.bladeWidth = Number.isFinite(options.bladeWidth)
    ? Number(options.bladeWidth)
    : Number(currentOptions.bladeWidth)
  currentOptions.bladeSamples = Number.isFinite(options.bladeSamples)
    ? Math.max(8, Math.round(Number(options.bladeSamples)))
    : Math.max(8, Math.round(Number(currentOptions.bladeSamples) || DEFAULT_DEBUG_OPTIONS.bladeSamples))
  currentOptions.curveExponent = Number.isFinite(options.curveExponent)
    ? Number(options.curveExponent)
    : Number(currentOptions.curveExponent)
  currentOptions.curveStrength = Number.isFinite(options.curveStrength)
    ? Number(options.curveStrength)
    : Number(currentOptions.curveStrength)
  currentOptions.pivotRadius = Number.isFinite(options.pivotRadius)
    ? Number(options.pivotRadius)
    : Number(currentOptions.pivotRadius)
  currentOptions.hold = !!options.hold
  currentOptions.irisScale = Number.isFinite(options.irisScale)
    ? Math.max(0.1, Number(options.irisScale))
    : Math.max(0.1, Number(currentOptions.irisScale) || DEFAULT_DEBUG_OPTIONS.irisScale)
  currentOptions.bladeBackOverhang = Number.isFinite(options.bladeBackOverhang)
    ? Math.max(0, Number(options.bladeBackOverhang))
    : Math.max(0, Number(currentOptions.bladeBackOverhang) || DEFAULT_DEBUG_OPTIONS.bladeBackOverhang)
  currentOptions.mode = options.mode === 'quick' ? 'quick' : 'pending'

  const overlay = _playIrisOverlay(currentOptions)
  if (!overlay) return currentOptions
  return currentOptions
}

export function clearIrisDebug() {
  debugOverlayToken += 1
  if (debugOverlayTimer) {
    clearTimeout(debugOverlayTimer)
    debugOverlayTimer = null
  }

  if (!debugOverlayRoot) return
  debugOverlayRoot.classList.remove('is-visible', 'is-playing', 'is-holding', 'mode-pending', 'mode-quick')
  debugOverlayRoot.hidden = true
  if (debugOverlayScene) debugOverlayScene.innerHTML = ''
}

export function installIrisShutterDebugControls() {
  if (!_isDebugEnabled()) return
  globalThis.__sporelyPlayIris = options => playIrisDebug(options)
  globalThis.__sporelyClearIris = () => clearIrisDebug()
  globalThis.__sporelySetIrisDebug = options => setIrisDebug(options)
}
