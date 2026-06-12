import { debugImagePipeline } from './image-pipeline-debug.js'

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
  durationMs: 250,
  openAngle: 50,
  closedAngle: 13,
  hold: false,
  irisScale: 6,
  curveExponent: 2.35,
  curveStrength: 18,
  bladeLength: 120,
  bladeWidth: 44,
  bladeSamples: 24,
  pivotRadius: 96,
  bladeBackOverhang: 5.5,
}

const DEFAULT_PENDING_SHUTTER_TIMING = {
  closeMs: 250,
  minHoldMs: 300,
  openMs: 150,
}

export const IRIS_BLADE_PATH_D = 'M -79.050967,-36.693239 C -197.91366,56.591496 -94.056754,137.06665 22.020885,98.809356 31.337039,95.73891 25.736889,79.983604 28.329989,67.293163 33.531408,41.837808 40.507132,10.973915 72.390971,-11.010864 95.098917,-26.909528 111.66924,-38.688794 135.20597,-48.762471 126.17785,-63.049848 99.181976,-102.1146 23.072759,-82.989494 c -35.033969,8.803513 -67.409698,20.355718 -102.123726,46.296255 z'

const BLADE_COUNT = 6
const VIEWBOX_SIZE = 240
const VIEWBOX_HALF = VIEWBOX_SIZE / 2
const VIEWBOX_MIN = -VIEWBOX_HALF

let liveFlashTimer = null
let liveCapturePending = false
let liveCapturePhase = 'idle'
let livePendingIrisState = null

let debugOverlayRoot = null
let debugOverlayScene = null
let debugOverlayTimer = null
let debugOverlayToken = 0
let debugPendingIrisState = null
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

function _setLiveCapturePhase(phase = 'idle') {
  liveCapturePhase = phase
  const vf = _getCaptureViewfinder()
  if (!vf) return

  const normalized = String(phase || 'idle').trim()
  const isIdle = normalized === 'idle'
  const isClosing = normalized === 'closing'
  const isHeld = normalized === 'held'
  const isOpening = normalized === 'opening'

  vf.classList.toggle('is-iris-pending', isClosing || isHeld)
  vf.classList.toggle('is-iris-closing', isClosing)
  vf.classList.toggle('is-iris-opening', isOpening)
  vf.dataset.irisPhase = isIdle ? '' : normalized
  if (isIdle) {
    delete vf.dataset.irisPhase
  }

  liveCapturePending = isClosing || isHeld
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

function _normalizePendingShutterTiming(options = {}) {
  return {
    closeMs: Math.max(20, Number(options.closeMs) || DEFAULT_PENDING_SHUTTER_TIMING.closeMs),
    minHoldMs: Math.max(0, Number(options.minHoldMs) || DEFAULT_PENDING_SHUTTER_TIMING.minHoldMs),
    openMs: Math.max(20, Number(options.openMs) || DEFAULT_PENDING_SHUTTER_TIMING.openMs),
  }
}

function _cancelPendingIrisTimers(state) {
  if (!state) return
  if (state.closeTimer) {
    clearTimeout(state.closeTimer)
    state.closeTimer = null
  }
  if (state.openTimer) {
    clearTimeout(state.openTimer)
    state.openTimer = null
  }
  if (state.cleanupTimer) {
    clearTimeout(state.cleanupTimer)
    state.cleanupTimer = null
  }
}

function _clearPendingIrisState(state, { immediate = false } = {}) {
  if (!state || state.cleanedUp) return
  state.cleanedUp = true
  _cancelPendingIrisTimers(state)
  if (state.openPromiseResolve) {
    const resolve = state.openPromiseResolve
    state.openPromiseResolve = null
    resolve()
  }
  _setLiveCapturePhase('idle')
  if (immediate) {
    _setLiveCaptureState(false)
  } else {
    _setLiveCaptureState(false)
  }
  if (livePendingIrisState === state) {
    livePendingIrisState = null
  }
}

function _clearPendingDebugState(state) {
  if (!state || state.cleanedUp) return
  state.cleanedUp = true
  if (state.closeTimer) {
    clearTimeout(state.closeTimer)
    state.closeTimer = null
  }
  if (state.openTimer) {
    clearTimeout(state.openTimer)
    state.openTimer = null
  }
  if (state.cleanupTimer) {
    clearTimeout(state.cleanupTimer)
    state.cleanupTimer = null
  }
  if (debugPendingIrisState === state) {
    debugPendingIrisState = null
  }
  if (debugOverlayRoot) {
    debugOverlayRoot.classList.remove('is-visible', 'is-playing', 'is-holding', 'mode-pending', 'mode-quick', 'is-closing', 'is-opening')
    debugOverlayRoot.hidden = true
    if (debugOverlayScene) debugOverlayScene.innerHTML = ''
  }
}

function _logPendingIris(message, details = {}) {
  debugImagePipeline(message, details)
}

function _setPendingDebugPhase(overlay, phase) {
  if (!overlay) return
  const normalized = String(phase || 'idle').trim()
  overlay.classList.toggle('is-closing', normalized === 'closing')
  overlay.classList.toggle('is-holding', normalized === 'held')
  overlay.classList.toggle('is-opening', normalized === 'opening')
}

function _createPendingDebugShutterController(options = {}) {
  const timing = _normalizePendingShutterTiming(options)
  const overlay = _renderDebugOverlay({
    ...DEFAULT_DEBUG_OPTIONS,
    ...debugOptions,
    ...options,
    durationMs: timing.closeMs,
    mode: 'pending',
    hold: false,
  })
  if (!overlay) {
    return {
      release: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    }
  }

  const state = {
    overlay,
    timing,
    startAt: performance.now(),
    closedAt: null,
    captureResolvedAt: null,
    released: false,
    cleanedUp: false,
    closeTimer: null,
    openTimer: null,
    cleanupTimer: null,
  }

  if (debugPendingIrisState && debugPendingIrisState !== state) {
    _clearPendingDebugState(debugPendingIrisState)
  }
  debugPendingIrisState = state

  overlay.hidden = false
  overlay.classList.remove('is-playing', 'is-holding', 'is-visible', 'mode-quick')
  overlay.classList.add('is-visible', 'mode-pending', 'is-closing')
  overlay.style.setProperty('--iris-debug-close-duration', `${timing.closeMs}ms`)
  overlay.style.setProperty('--iris-debug-open-duration', `${timing.openMs}ms`)
  void overlay.getBoundingClientRect()
  _setPendingDebugPhase(overlay, 'closing')

  state.closeTimer = setTimeout(() => {
    if (debugPendingIrisState !== state || state.cleanedUp) return
    state.closeTimer = null
    state.closedAt = performance.now()
    _setPendingDebugPhase(overlay, 'held')
  }, timing.closeMs)

  const scheduleOpen = () => {
    if (state.cleanedUp || state.released) return Promise.resolve()
    state.released = true
    const openPromise = new Promise(resolve => {
      const finish = () => {
        if (debugPendingIrisState !== state || state.cleanedUp) {
          resolve()
          return
        }
        _setPendingDebugPhase(overlay, 'opening')
        state.cleanupTimer = setTimeout(() => {
          if (debugPendingIrisState !== state || state.cleanedUp) {
            resolve()
            return
          }
          _clearPendingDebugState(state)
          resolve()
        }, timing.openMs)
      }

      const now = performance.now()
      const openAt = Math.max(
        (state.closedAt || state.startAt + timing.closeMs) + timing.minHoldMs,
        state.captureResolvedAt || now,
      )
      const waitMs = Math.max(0, openAt - now)

      if (state.openTimer) {
        clearTimeout(state.openTimer)
        state.openTimer = null
      }

      if (waitMs > 0) {
        state.openTimer = setTimeout(() => {
          state.openTimer = null
          finish()
        }, waitMs)
        return
      }

      finish()
    })

    return openPromise
  }

  return {
    release: ({ captureAfterMs = null, captureResolvedAt = null } = {}) => {
      if (Number.isFinite(captureAfterMs)) {
        state.captureAfterMs = Number(captureAfterMs)
      }
      state.captureResolvedAt = Number.isFinite(captureResolvedAt) ? Number(captureResolvedAt) : performance.now()
      return scheduleOpen()
    },
    cancel: () => {
      _clearPendingDebugState(state)
      return Promise.resolve()
    },
  }
}

function _createPendingIrisController(options = {}) {
  const timing = _normalizePendingShutterTiming(options)
  const state = {
    timing,
    startAt: performance.now(),
    closedAt: null,
    releaseRequestedAt: null,
    captureResolvedAt: null,
    closeTimer: null,
    openTimer: null,
    cleanupTimer: null,
    released: false,
    cancelled: false,
    cleanedUp: false,
    openPromise: null,
    openPromiseResolve: null,
  }

  if (livePendingIrisState && livePendingIrisState !== state) {
    _clearPendingIrisState(livePendingIrisState, { immediate: true })
  }
  livePendingIrisState = state

  const vf = _getCaptureViewfinder()
  if (vf) {
    vf.style.setProperty('--iris-live-close-duration', `${timing.closeMs}ms`)
    vf.style.setProperty('--iris-live-open-duration', `${timing.openMs}ms`)
  }

  _setLiveCapturePhase('closing')
  _logPendingIris('shutter close started', {
    closeMs: timing.closeMs,
    minHoldMs: timing.minHoldMs,
    openMs: timing.openMs,
  })

  state.closeTimer = setTimeout(() => {
    if (livePendingIrisState !== state || state.cancelled || state.cleanedUp) return
    state.closeTimer = null
    state.closedAt = performance.now()
    _setLiveCapturePhase('held')
    _logPendingIris('shutter closed', {
      closeMs: timing.closeMs,
      minHoldMs: timing.minHoldMs,
      openMs: timing.openMs,
    })
    if (state.released) scheduleOpenIfReady()
  }, timing.closeMs)

  const ensureOpenPromise = () => {
    if (state.openPromise) return state.openPromise
    state.openPromise = new Promise(resolve => {
      state.openPromiseResolve = resolve
    })
    return state.openPromise
  }

  const resolveOpenPromise = () => {
    if (!state.openPromiseResolve) return
    const resolve = state.openPromiseResolve
    state.openPromiseResolve = null
    resolve()
  }

  const finishOpen = () => {
    if (state.cancelled || state.cleanedUp) return
    _setLiveCapturePhase('opening')
    state.cleanupTimer = setTimeout(() => {
      if (livePendingIrisState !== state || state.cancelled || state.cleanedUp) return
      _clearPendingIrisState(state, { immediate: false })
      _logPendingIris('shutter opened', {
        captureAfterMs: Number.isFinite(state.captureAfterMs) ? Math.round(state.captureAfterMs) : null,
        closedHoldMs: Number.isFinite(state.closedHoldMs) ? Math.round(state.closedHoldMs) : null,
        waitedForCapture: !!state.waitedForCapture,
        waitedForMinHold: !!state.waitedForMinHold,
      })
      resolveOpenPromise()
    }, timing.openMs)
  }

  const scheduleOpenIfReady = () => {
    if (state.cancelled || state.cleanedUp) return
    if (!state.released || !state.closedAt || state.captureResolvedAt === null) return

    const now = performance.now()
    const openAt = Math.max(
      state.closedAt + timing.minHoldMs,
      state.captureResolvedAt,
    )
    const waitMs = Math.max(0, openAt - now)

    state.closedHoldMs = Math.max(0, openAt - state.closedAt)
    state.waitedForCapture = state.captureResolvedAt > state.closedAt + timing.minHoldMs
    state.waitedForMinHold = now < state.closedAt + timing.minHoldMs

    if (state.openTimer) {
      clearTimeout(state.openTimer)
      state.openTimer = null
    }

    if (waitMs > 0) {
      state.openTimer = setTimeout(() => {
        state.openTimer = null
        finishOpen()
      }, waitMs)
      return
    }

    finishOpen()
  }

  const scheduleOpen = () => {
    if (state.cancelled || state.cleanedUp || state.released) return ensureOpenPromise()
    state.released = true
    state.releaseRequestedAt = performance.now()
    state.captureAfterMs = Number.isFinite(state.captureAfterMs) ? state.captureAfterMs : null
    const openPromise = ensureOpenPromise()
    scheduleOpenIfReady()
    _logPendingIris('shutter release requested', {
      captureAfterMs: Number.isFinite(state.captureAfterMs) ? Math.round(state.captureAfterMs) : null,
      closedHoldMs: Number.isFinite(state.closedHoldMs) ? Math.round(state.closedHoldMs) : null,
      waitedForCapture: !!state.waitedForCapture,
      waitedForMinHold: !!state.waitedForMinHold,
    })
    return openPromise
  }

  const cancel = () => {
    if (state.cancelled || state.cleanedUp) return Promise.resolve()
    state.cancelled = true
    _logPendingIris('shutter cancel requested', {
      captureAfterMs: Number.isFinite(state.captureAfterMs) ? Math.round(state.captureAfterMs) : null,
    })
    _clearPendingIrisState(state, { immediate: true })
    resolveOpenPromise()
    return Promise.resolve()
  }

  return {
    release: ({ captureAfterMs = null, captureResolvedAt = null } = {}) => {
      if (Number.isFinite(captureAfterMs)) state.captureAfterMs = Number(captureAfterMs)
      state.captureResolvedAt = Number.isFinite(captureResolvedAt) ? Number(captureResolvedAt) : performance.now()
      return scheduleOpen()
    },
    cancel,
  }
}

function _playIrisOverlay(options) {
  const overlay = _renderDebugOverlay(options)
  if (!overlay) return null
  _animateDebugOverlay(overlay, options.mode, options)
  return overlay
}

export function startPendingIrisShutter(options = {}) {
  const liveController = _createPendingIrisController({
    ...DEFAULT_PENDING_SHUTTER_TIMING,
    ...options,
    mode: 'pending',
  })
  if (!_isDebugEnabled()) return liveController

  const debugController = _createPendingDebugShutterController({
    ...DEFAULT_PENDING_SHUTTER_TIMING,
    ...options,
  })

  return {
    release: releaseOptions => {
      const liveRelease = liveController.release(releaseOptions)
      void debugController.release(releaseOptions).catch(() => {})
      return liveRelease
    },
    cancel: () => {
      void liveController.cancel()
      void debugController.cancel()
      return Promise.resolve()
    },
  }
}

export function playIrisShutter({ mode = 'pending', ...options } = {}) {
  const reduced = _prefersReducedMotion()
  const durationMs = reduced
    ? LIVE_FLASH_REDUCED_DURATION_MS[mode] || LIVE_FLASH_REDUCED_DURATION_MS.pending
    : LIVE_FLASH_DURATION_MS[mode] || LIVE_FLASH_DURATION_MS.pending

  if (mode === 'pending') {
    _setLiveCaptureState(true)
  }

  if (reduced) {
    _startSimpleFlash(mode, durationMs)
    return {
      release: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    }
  }

  if (mode === 'pending') {
    return startPendingIrisShutter({
      ...options,
      closeMs: options.closeMs ?? DEFAULT_PENDING_SHUTTER_TIMING.closeMs,
      minHoldMs: options.minHoldMs ?? DEFAULT_PENDING_SHUTTER_TIMING.minHoldMs,
      openMs: options.openMs ?? DEFAULT_PENDING_SHUTTER_TIMING.openMs,
    })
  }

  _playIrisOverlay({
    ...DEFAULT_DEBUG_OPTIONS,
    ...options,
    mode,
    durationMs,
    hold: mode === 'pending',
  })
  return {
    release: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  }
}

export function clearIrisShutter() {
  if (livePendingIrisState) {
    livePendingIrisState.cancelled = true
    _clearPendingIrisState(livePendingIrisState, { immediate: true })
  }
  if (liveFlashTimer) {
    clearTimeout(liveFlashTimer)
    liveFlashTimer = null
  }
  const vf = _getCaptureViewfinder()
  if (vf) {
    vf.classList.remove('is-iris-flash', 'is-iris-flash-armed', 'is-iris-pending', 'is-iris-closing', 'is-iris-opening')
    delete vf.dataset.irisFlashMode
    delete vf.dataset.irisPhase
  }

  _setLiveCaptureState(false)
  clearIrisDebug()
}

function _buildDebugBladeMarkup(index, options) {
  const baseAngle = index * (360 / BLADE_COUNT)
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
        <path class="iris-debug-blade-path" d="${IRIS_BLADE_PATH_D}"></path>
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
  // Static blade path ignores overhang; keep this option as a no-op for compatibility.
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
  // Compatibility-only: the static blade path ignores back overhang.
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
  if (debugPendingIrisState) {
    debugPendingIrisState.cleanedUp = true
    if (debugPendingIrisState.closeTimer) clearTimeout(debugPendingIrisState.closeTimer)
    if (debugPendingIrisState.openTimer) clearTimeout(debugPendingIrisState.openTimer)
    if (debugPendingIrisState.cleanupTimer) clearTimeout(debugPendingIrisState.cleanupTimer)
    debugPendingIrisState.closeTimer = null
    debugPendingIrisState.openTimer = null
    debugPendingIrisState.cleanupTimer = null
    debugPendingIrisState = null
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
