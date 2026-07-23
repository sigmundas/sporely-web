import { state } from '../state.js'
import { t } from '../i18n.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { getDefaultAiCropRect } from '../image_crop.js'
import { isIosWebApp, isNativeApp } from '../platform.js'
import { debugImagePipeline, isImagePipelineDebugEnabled } from '../image-pipeline-debug.js'
import { endCameraTimingRun, markCameraStep } from '../camera-timing.js'
import { clearIrisShutter, startPendingIrisShutter } from '../iris-shutter.js'
import { resetReviewAiState } from './review.js'
import { createDefaultObservationDraft } from '../observation-defaults.js'
import { isBlob } from '../observation-shapes.js'
import {
  beginCaptureLocationSession,
  checkLocationCapabilityAndPermission,
  endCaptureLocationSession,
  LOCATION_STATE_CHANGED_EVENT,
  setLocationPreference,
  startLocationWatch,
} from '../geo.js'
import {
  cancelActivePreflight,
  enableCaptureLocationForCurrentSession,
  initCaptureLocationSheet,
  isPreflightCurrent,
  nextPreflightToken,
  showLocationPrompt,
} from '../capture-location-preflight.js'
import { NO_LOCATION_PILL_TEXT, openLocationSettingsOrExplain } from '../location-settings.js'
import { hideLocationFixSheet, initLocationFixSheet, showLocationFixSheet } from '../location-fix-sheet.js'

let cachedPrimaryMainCameraId = null
let primaryMainCameraPromise = null

const CAMERA_VIDEO_WIDTH_IDEAL = 4000
const CAMERA_VIDEO_HEIGHT_IDEAL = 3000
const CAMERA_CAPTURE_MIN_LONG_EDGE = 1000
const PENDING_SHUTTER_CLOSE_MS = 250
const PENDING_SHUTTER_MIN_HOLD_MS = 300
const PENDING_SHUTTER_OPEN_MS = 150
let pendingCaptureCount = 0
let finishCaptureWhenPendingComplete = false
let captureCompleteHandler = null
const stillCaptureCache = new WeakMap()
let captureLocationStateListenerWindow = null
// Gated by first real video frame — see _wireFirstFrameSignal. Prevents users
// tapping the shutter on a stream that has not yet delivered any frames, which
// on iOS Safari can happen if getUserMedia hands back a starved MediaStream.
let firstFrameReady = false
// True from the start of startCamera() until we have either attached a stream
// or bailed out (error / cancel / navigate away). During this window,
// state.cameraStream is null AND video.srcObject is null, so the "no srcObject
// ⇒ demo mode" branch in capturePhoto would otherwise fire — a fast shutter
// press could save a fake emoji capture. Keep the shutter closed instead.
let cameraStartupPending = false
// Explicit demo-mode intent. capturePhoto()'s emoji-canvas branch only fires
// when this is true; a null video.srcObject alone is not treated as consent
// to enter demo mode (it is a symptom of many transient states, not a signal).
let demoModeActive = false

export function _setDemoModeForTests(active) {
  demoModeActive = !!active
  _syncCaptureControls()
}

export function setCaptureCompleteHandler(handler) {
  captureCompleteHandler = typeof handler === 'function' ? handler : null
}

export function initCapture() {
  initCaptureLocationSheet()
  initLocationFixSheet()
  _syncCaptureLocationStatus()
  if (captureLocationStateListenerWindow !== globalThis.window) {
    captureLocationStateListenerWindow = globalThis.window
    window.addEventListener(LOCATION_STATE_CHANGED_EVENT, _syncCaptureLocationStatus)
  }
  const gpsPill = document.querySelector('.capture-gps-pill')
  if (gpsPill && !gpsPill._gpsActionWired) {
    gpsPill._gpsActionWired = true
    gpsPill.addEventListener('click', () => {
      void _handleCaptureGpsPillTap().catch(error => {
        console.warn('GPS pill action failed:', error)
      })
    })
  }
  document.getElementById('shutter-btn').addEventListener('click', () => {
    void capturePhoto().catch(error => {
      console.error('Capture photo failed:', error)
    })
  })
  document.getElementById('done-btn').addEventListener('click', finishCapture)
  document.getElementById('capture-cancel-btn')?.addEventListener('click', cancelCapture)
  document.getElementById('camera-retry-btn').addEventListener('click', () => {
    document.getElementById('camera-denied').style.display = 'none'
    startCamera()
  })
}

function _normalizeCaptureLocationState() {
  const activeFix = state.location.fix || state.captureSessionLocation.fix || null
  const accuracy = Number(activeFix?.accuracy)
  if (activeFix && Number.isFinite(Number(activeFix.lat)) && Number.isFinite(Number(activeFix.lon))) {
    // A valid locked capture fix always wins — never replaced by warnings.
    return {
      text: Number.isFinite(accuracy) ? `Location captured · ±${Math.round(accuracy)} m` : 'Location captured',
      state: 'fix',
    }
  }
  if (state.location.status === 'locating' || state.captureSessionLocation.requestingFreshFix) {
    return {
      text: 'Finding location…',
      state: 'searching',
    }
  }
  return {
    text: NO_LOCATION_PILL_TEXT,
    state: 'none',
    action: 'fix',
  }
}

function _syncCaptureLocationStatus() {
  const pill = document.querySelector('.capture-gps-pill')
  const display = document.getElementById('gps-display')
  if (!pill || !display) return

  const snapshot = _normalizeCaptureLocationState()
  pill.dataset.gpsState = snapshot.state
  if (snapshot.action) {
    pill.dataset.gpsAction = snapshot.action
  } else {
    delete pill.dataset.gpsAction
  }
  display.textContent = snapshot.text
}

async function _handleCaptureGpsPillTap() {
  const pill = document.querySelector('.capture-gps-pill')
  if (!pill?.dataset?.gpsAction) return
  const decision = await showLocationFixSheet()
  if (decision === 'settings') {
    // Opt the app in so geo's visibility-resume path re-checks permission
    // and retries acquisition when the user returns from settings.
    if (state.location.preference !== 'enabled') setLocationPreference('enabled')
    await openLocationSettingsOrExplain()
    return
  }
  if (decision === 'retry') {
    // One short explicit request: opts the preference in and (re)starts the
    // capture-session watch.
    await enableCaptureLocationForCurrentSession()
  }
}

function _stopMediaStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return
  stream.getTracks().forEach(track => track.stop())
}

function _isPermissionDeniedError(err) {
  return err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
}

export function isTinyCameraCaptureDimensions(width, height, minLongestEdge = CAMERA_CAPTURE_MIN_LONG_EDGE) {
  const longestEdge = Math.max(Number(width) || 0, Number(height) || 0)
  const threshold = Math.max(1, Number(minLongestEdge) || CAMERA_CAPTURE_MIN_LONG_EDGE)
  return longestEdge > 0 && longestEdge < threshold
}

function _isClearlyFrontCamera(device) {
  const label = (device?.label || '').toLowerCase()
  return /\b(front|user|selfie)\b/.test(label)
}

async function _primeCameraPermission() {
  let stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
  } catch (err) {
    if (_isPermissionDeniedError(err)) throw err
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  } finally {
    _stopMediaStream(stream)
  }
}

async function _probeDeviceForTorch(device) {
  let stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: device.deviceId } },
      audio: false,
    })
    const track = stream.getVideoTracks()[0]
    const capabilities = typeof track?.getCapabilities === 'function' ? track.getCapabilities() : {}
    if (capabilities?.torch === true) return true

    if (typeof window.ImageCapture === 'function' && track) {
      const imageCapture = new window.ImageCapture(track)
      if (typeof imageCapture.getPhotoCapabilities === 'function') {
        const photoCapabilities = await imageCapture.getPhotoCapabilities()
        if (photoCapabilities?.fillLightMode?.includes?.('flash')) return true
      }
    }

    return false
  } finally {
    _stopMediaStream(stream)
  }
}

async function _getPrimaryMainCameraId() {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) return null
  if (cachedPrimaryMainCameraId) {
    markCameraStep('torchHeuristic:cached', { deviceId: cachedPrimaryMainCameraId })
    return cachedPrimaryMainCameraId
  }
  if (primaryMainCameraPromise) {
    markCameraStep('torchHeuristic:awaitInFlight')
    return primaryMainCameraPromise
  }

  primaryMainCameraPromise = (async () => {
    markCameraStep('torchHeuristic:start')
    try {
      await _primeCameraPermission()
      markCameraStep('torchHeuristic:primed')

      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter(device => device.kind === 'videoinput')
      const candidateDevices = videoDevices.filter(device => !_isClearlyFrontCamera(device))
      const probeDevices = candidateDevices.length ? candidateDevices : videoDevices
      markCameraStep('torchHeuristic:enumerated', { videoDevices: videoDevices.length, probeDevices: probeDevices.length })

      for (const device of probeDevices) {
        try {
          if (await _probeDeviceForTorch(device)) {
            cachedPrimaryMainCameraId = device.deviceId
                if (import.meta.env?.DEV) console.log('Main 1x camera identified via torch capability:', device.label || device.deviceId)
            return cachedPrimaryMainCameraId
          }
        } catch (err) {
          if (import.meta.env?.DEV) console.warn('Torch heuristic: failed to inspect camera:', device.label || device.deviceId, err)
        }
      }

      if (import.meta.env?.DEV) console.log('Torch heuristic: no torch-capable camera found; falling back to environment camera.')
      return null
    } catch (err) {
      if (import.meta.env?.DEV) console.warn('Torch heuristic failed:', err)
      if (_isPermissionDeniedError(err)) throw err
      return null
    } finally {
      primaryMainCameraPromise = null
      markCameraStep('torchHeuristic:end', { deviceId: cachedPrimaryMainCameraId })
    }
  })()

  return primaryMainCameraPromise
}

async function _applyPrimaryLensPreferences(stream) {
  const track = stream?.getVideoTracks?.()[0]
  if (!track) return

  try {
    const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
    if (capabilities.zoom && typeof track.applyConstraints === 'function') {
      const zoomMin = Number(capabilities.zoom.min)
      const zoomMax = Number(capabilities.zoom.max)
      if (Number.isFinite(zoomMin) && Number.isFinite(zoomMax)) {
        const preferredZoom = zoomMin <= 1 && zoomMax >= 1 ? 1 : zoomMin
        await track.applyConstraints({ advanced: [{ zoom: preferredZoom }] })
      }
    }
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('Camera zoom preference could not be applied:', err)
  }

  if (typeof track.getSettings === 'function') {
    if (import.meta.env?.DEV) console.log('Camera stream settings:', track.getSettings())
  }
}

function _getStillCaptureCache(track) {
  if (!track || typeof window.ImageCapture !== 'function') return null
  let entry = stillCaptureCache.get(track)
  if (!entry) {
    entry = {
      imageCapture: new window.ImageCapture(track),
      photoCapabilitiesPromise: null,
      photoSettingsPromise: null,
    }
    stillCaptureCache.set(track, entry)
  }
  return entry
}

async function _getCachedPhotoCapabilities(track) {
  const entry = _getStillCaptureCache(track)
  if (!entry) return null
  if (!entry.photoCapabilitiesPromise) {
    entry.photoCapabilitiesPromise = typeof entry.imageCapture.getPhotoCapabilities === 'function'
      ? entry.imageCapture.getPhotoCapabilities().catch(error => {
        if (import.meta.env?.DEV) console.warn('Photo capabilities cache failed:', error)
        return null
      })
      : Promise.resolve(null)
  }
  return entry.photoCapabilitiesPromise
}

async function _buildStillPhotoSettings(track) {
  const capabilities = await _getCachedPhotoCapabilities(track)
  const photoSettings = {}
  const imageWidth = _finiteMaxRangeValue(capabilities?.imageWidth)
  const imageHeight = _finiteMaxRangeValue(capabilities?.imageHeight)
  if (imageWidth) photoSettings.imageWidth = Math.min(imageWidth, CAMERA_VIDEO_WIDTH_IDEAL)
  if (imageHeight) photoSettings.imageHeight = Math.min(imageHeight, CAMERA_VIDEO_HEIGHT_IDEAL)
  if (capabilities?.fillLightMode?.includes?.('off')) photoSettings.fillLightMode = 'off'
  return photoSettings
}

async function _prefetchStillCaptureData(stream) {
  const track = stream?.getVideoTracks?.()[0]
  if (!track) return
  await _getCachedPhotoCapabilities(track)
}

async function tryGetUserMedia() {
  markCameraStep('tryGetUserMedia:enter', { path: isIosWebApp() ? 'ios' : 'default' })
  // iOS Safari / iOS PWA: skip the priming + per-device probing path. WebKit
  // has documented behaviour where a later getUserMedia call can mute an
  // existing MediaStream, which manifests as a blank preview and black
  // captures. Ask for a single environment-facing stream and stop.
  if (isIosWebApp()) {
    markCameraStep('gUM:ios:start')
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: CAMERA_VIDEO_WIDTH_IDEAL },
        height: { ideal: CAMERA_VIDEO_HEIGHT_IDEAL },
      },
      audio: false,
    })
    markCameraStep('gUM:ios:end')
    await _applyPrimaryLensPreferences(stream)
    markCameraStep('applyPrimaryLensPreferences:end')
    return stream
  }

  // Step 1: Run the torch heuristic to find the primary main lens
  const mainDeviceId = await _getPrimaryMainCameraId()

  // Step 2: Try to start the camera using the exact device ID if found
  if (mainDeviceId) {
    try {
      markCameraStep('gUM:exact:start')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: mainDeviceId },
          width:  { ideal: CAMERA_VIDEO_WIDTH_IDEAL },
          height: { ideal: CAMERA_VIDEO_HEIGHT_IDEAL },
        },
        audio: false
      })
      markCameraStep('gUM:exact:end')
      await _applyPrimaryLensPreferences(stream)
      markCameraStep('applyPrimaryLensPreferences:end')
      return stream
    } catch (err) {
      cachedPrimaryMainCameraId = null
      markCameraStep('gUM:exact:fail', { error: err?.name || String(err) })
      if (import.meta.env?.DEV) console.warn('Failed to start camera with heuristic deviceId, falling back...', err)
    }
  }

  // Step 3: Fallback logic
  try {
    markCameraStep('gUM:facingMode:start')
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: CAMERA_VIDEO_WIDTH_IDEAL },
        height: { ideal: CAMERA_VIDEO_HEIGHT_IDEAL },
      },
      audio: false,
    })
    markCameraStep('gUM:facingMode:end')
    await _applyPrimaryLensPreferences(stream)
    markCameraStep('applyPrimaryLensPreferences:end')
    return stream
  } catch {
    markCameraStep('gUM:facingMode:fail:fallback')
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    markCameraStep('gUM:minimal:end')
    await _applyPrimaryLensPreferences(stream)
    markCameraStep('applyPrimaryLensPreferences:end')
    return stream
  }
}

function _finiteMaxRangeValue(range) {
  const max = Number(range?.max)
  return Number.isFinite(max) && max > 0 ? Math.round(max) : null
}

async function _getImageBlobDimensions(blob) {
  if (!isBlob(blob)) return { width: null, height: null }

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      const dimensions = { width: bitmap.width || null, height: bitmap.height || null }
      bitmap.close?.()
      if (dimensions.width && dimensions.height) return dimensions
    } catch (err) {
      console.warn('Could not read captured image dimensions with createImageBitmap:', err)
    }
  }

  return await new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const dimensions = {
        width: img.naturalWidth || img.width || null,
        height: img.naturalHeight || img.height || null,
      }
      URL.revokeObjectURL(url)
      resolve(dimensions)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve({ width: null, height: null })
    }
    img.src = url
  })
}

async function _takeStillPhoto(video) {
  const stream = video?.srcObject
  const track = stream?.getVideoTracks?.()[0]
  const entry = _getStillCaptureCache(track)
  if (!track || !entry || typeof entry.imageCapture.takePhoto !== 'function') return null

  let photoSettings = {}
  try {
    photoSettings = await _buildStillPhotoSettings(track)
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('Photo capabilities unavailable; taking still with defaults:', err)
  }

  const blob = await entry.imageCapture.takePhoto(photoSettings)
  if (!isBlob(blob)) throw new Error('Still photo capture returned no image')
  if (import.meta.env?.DEV) console.log('Captured still photo via ImageCapture:', {
    bytes: blob.size,
    type: blob.type,
    settings: typeof track.getSettings === 'function' ? track.getSettings() : null,
    photoSettings,
  })
  return blob
}

async function _captureVideoFrame(video) {
  const w = video.videoWidth
  const h = video.videoHeight

  if (!w || !h) {
    showToast(t('capture.cameraNotReady') || 'Camera not fully ready')
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  canvas.getContext('2d').drawImage(video, 0, 0, w, h)

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(nextBlob => {
      if (nextBlob) resolve(nextBlob)
      else reject(new Error('Image capture failed'))
    }, 'image/jpeg', 0.92)
  })

  if (import.meta.env?.DEV) console.log('Captured fallback video frame:', { width: w, height: h, bytes: blob.size })
  return blob
}

async function _restartCameraStreamAfterDegradation() {
  showToast('Camera stream restarted; try again')
  await startCamera({ preserveBatch: true })
}

function _syncCaptureControls() {
  const doneBtn = document.getElementById('done-btn')
  const shutterBtn = document.getElementById('shutter-btn')
  if (doneBtn) {
    doneBtn.disabled = false
    doneBtn.setAttribute('aria-busy', pendingCaptureCount > 0 ? 'true' : 'false')
  }
  if (shutterBtn) {
    // Shutter is ready when either:
    //   (a) a live camera stream is attached AND has delivered its first frame, or
    //   (b) demo mode is explicitly active.
    // Real-camera startup (permission + getUserMedia awaits) MUST block, because
    // state.cameraStream is null during startup and would otherwise look identical
    // to demo mode to any code that only checks video.srcObject.
    const busy = pendingCaptureCount > 0
    const liveReady = !!state.cameraStream && firstFrameReady
    const ready = liveReady || demoModeActive
    shutterBtn.disabled = busy || cameraStartupPending || !ready
    shutterBtn.setAttribute('aria-busy', busy ? 'true' : 'false')
  }
}

function _wireFirstFrameSignal(video, stream) {
  const markReady = () => {
    // Guard against a late callback landing after stopCamera / a stream swap.
    // Both checks are needed: a browser could hold the callback across stream
    // reassignments and fire it after the current session started, in which
    // case state.cameraStream may already be the NEW stream while this closure
    // still references the OLD one. Comparing video.srcObject catches the case
    // where state.cameraStream was reassigned but the element was not.
    if (state.cameraStream !== stream || video.srcObject !== stream) return
    if (firstFrameReady) return
    firstFrameReady = true
    markCameraStep('firstFrameReady')
    endCameraTimingRun('firstFrame')
    _syncCaptureControls()
  }

  if (typeof video.requestVideoFrameCallback === 'function') {
    try {
      video.requestVideoFrameCallback(() => markReady())
      return
    } catch (_) {
      // Fall through to the event-based fallback.
    }
  }

  const handlePlaying = () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      video.removeEventListener('playing', handlePlaying)
      markReady()
    }
  }
  video.addEventListener('playing', handlePlaying)
}

function _setPendingCaptureDelta(delta) {
  pendingCaptureCount = Math.max(0, pendingCaptureCount + delta)
  _syncCaptureControls()
  if (pendingCaptureCount === 0 && finishCaptureWhenPendingComplete) {
    finishCaptureWhenPendingComplete = false
    finishCapture()
  }
}

async function _captureCameraBlob(video) {
  let blob = null
  try {
    const stillBlob = await _takeStillPhoto(video)
    if (isBlob(stillBlob)) blob = stillBlob
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('ImageCapture still photo failed; falling back to video frame:', err)
  }
  if (isBlob(blob)) {
    return {
      blob,
      captureMethod: 'ImageCapture.takePhoto()',
    }
  }
  const fallbackBlob = await _captureVideoFrame(video)
  return {
    blob: fallbackBlob,
    captureMethod: 'canvas video-frame fallback',
  }
}

function _logCaptureDiagnostics(message, details = {}, warn = false) {
  if (!isImagePipelineDebugEnabled()) return
  if (warn) {
    console.warn(`[image-pipeline] ${message}`, details)
    return
  }
  debugImagePipeline(message, details)
}

export async function startCamera(options = {}) {
  const preserveBatch = !!options.preserveBatch
  markCameraStep('startCamera:enter', { preserveBatch })
  stopCamera()
  markCameraStep('startCamera:afterStopCamera')
  // Capturing means the capture-lock window is open by definition: new
  // at-shutter fixes must be accepted again. Review recomputes the window
  // from the (possibly extended) photo timestamps when the batch returns.
  state.captureSessionLocation.captureWindowEndAt = null
  // Mark real-camera startup pending BEFORE awaiting anything — the shutter
  // must stay closed until a stream has attached. The finally block clears
  // the flag on every exit path.
  cameraStartupPending = true
  _syncCaptureControls()
  try {
    const startupToken = nextPreflightToken()

    if (!preserveBatch) {
      state.capturedPhotos = []
      state.captureDraft = createDefaultObservationDraft()
      resetReviewAiState()
    }

    // The camera opens immediately; location is acquired in parallel and
    // never delays the viewfinder (see _startCaptureLocationFlow below).
    const stream = await tryGetUserMedia()
    markCameraStep('tryGetUserMedia:resolved')
    if (!isPreflightCurrent(startupToken)) {
      _stopMediaStream(stream)
      endCameraTimingRun('aborted:preflight')
      return
    }
    state.cameraStream = stream
    firstFrameReady = false
    const video = document.getElementById('camera-video')
    video.classList.remove('camera-video-full-frame')
    video.srcObject = stream
    markCameraStep('video:srcObjectAttached')
    video.onloadedmetadata = async () => {
      try { await video.play() } catch (_) {}
      _syncPreviewFit(video)
    }
    _wireFirstFrameSignal(video, stream)
    void _prefetchStillCaptureData(stream).catch(() => {})

    state.batchCount = state.capturedPhotos.length
    document.getElementById('batch-count').textContent = String(state.batchCount)
    document.getElementById('batch-area').style.display = state.batchCount ? 'flex' : 'none'
    pendingCaptureCount = 0
    finishCaptureWhenPendingComplete = false
    _syncCaptureLocationStatus()

    // Start location AFTER the camera stream is attached so the OS camera
    // and geolocation prompts are never stacked (see HISTORY.md iOS gotchas),
    // and fire-and-forget so GPS never blocks the viewfinder.
    if (!preserveBatch) {
      void _startCaptureLocationFlow(startupToken).catch(error => {
        console.warn('Capture location flow failed:', error)
      })
    }
  } catch (err) {
    markCameraStep('startCamera:error', { name: err?.name || String(err) })
    endCameraTimingRun('error', { name: err?.name || String(err) })
    const denied = document.getElementById('camera-denied')
    const body   = document.getElementById('camera-denied-body')

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      const ua = navigator.userAgent
      let instructions
      if (isNativeApp()) {
        instructions = t('capture.cameraPermissionAndroid')
      } else if (/iPhone|iPad/.test(ua)) {
        instructions = t('capture.cameraPermissionIphone')
      } else if (/Firefox/.test(ua)) {
        instructions = t('capture.cameraPermissionFirefox')
      } else if (/SamsungBrowser/.test(ua)) {
        instructions = t('capture.cameraPermissionSamsung')
      } else {
        instructions = t('capture.cameraPermissionBrowser')
      }
      body.textContent = instructions
      denied.style.display = 'flex'
    } else if (err.name === 'NotFoundError') {
      body.textContent = t('capture.noCameraFound')
      denied.style.display = 'flex'
    } else {
      body.textContent = t('capture.cameraStartFailed', { name: err.name })
      denied.style.display = 'flex'
    }
  } finally {
    cameraStartupPending = false
    _syncCaptureControls()
  }
}

// Runs in parallel with (never before) the camera. Only OS permission
// 'granted' upgrades an undecided preference silently; 'prompt'/'unknown'
// go through the Sporely consent sheet so a fresh button tap separates the
// OS geolocation prompt from the camera prompt (HISTORY.md iOS gotcha).
// Denied/unsupported states show no prompt — the pill reads
// "No location · Tap to fix" and the location-fix sheet takes over.
async function _startCaptureLocationFlow(token) {
  beginCaptureLocationSession()
  if (state.location.preference === 'disabled') return

  const snapshot = await checkLocationCapabilityAndPermission()
  if (!isPreflightCurrent(token)) return
  if (snapshot.capability === 'unsupported' || snapshot.permission === 'denied') return

  if (state.location.preference === 'ask') {
    if (snapshot.permission === 'granted') {
      setLocationPreference('enabled')
    } else {
      const choice = await showLocationPrompt('ask')
      if (!isPreflightCurrent(token) || choice !== 'use') return
      setLocationPreference('enabled')
    }
  }

  if (!isPreflightCurrent(token)) return
  await startLocationWatch({ requestFreshFix: true })
}

export function stopCamera() {
  cancelActivePreflight()
  hideLocationFixSheet(null)
  firstFrameReady = false
  cameraStartupPending = false
  if (state.cameraStream) {
    if (typeof state.cameraStream.getTracks === 'function') {
      state.cameraStream.getTracks().forEach(t => t.stop())
    }
    state.cameraStream = null
  }
  const video = document.getElementById('camera-video')
  if (video) {
    video.onloadedmetadata = null
    video.srcObject = null
    video.classList.remove('camera-video-full-frame')
  }
  _syncCaptureControls()
}

async function capturePhoto() {
  // Defence in depth for the shutter gate. The button's `disabled` prop is
  // authoritative for real UI clicks, but capturePhoto is called from a click
  // handler that dispatches unconditionally in tests — and any future caller
  // must also be safe. Refuse to run while a real camera session is starting,
  // and refuse to run against a live stream that hasn't delivered a frame yet.
  if (cameraStartupPending) return
  if (state.cameraStream && !firstFrameReady) return

  const video  = document.getElementById('camera-video')
  const debugEnabled = isImagePipelineDebugEnabled()
  const track = video?.srcObject?.getVideoTracks?.()[0] || null
  if (debugEnabled) {
    _logCaptureDiagnostics('capture shutter requested', {
      hasCameraStream: !!video?.srcObject,
      batchCount: state.batchCount,
      captureMethod: video?.srcObject ? 'camera' : 'demo canvas',
      videoWidth: video?.videoWidth || null,
      videoHeight: video?.videoHeight || null,
      trackSettings: typeof track?.getSettings === 'function' ? track.getSettings() : null,
    })
  }

  if (!video.srcObject) {
    // No live stream. Only the explicit demoModeActive flag may enter the
    // emoji-canvas branch — a bare null srcObject is not consent to fabricate
    // a photo. Without this guard a shutter press before/between real sessions
    // would save a fake demo capture.
    if (!demoModeActive) return
    // Demo mode — no real camera
    const captureStartAt = performance.now()
    const shutter = startPendingIrisShutter({
      closeMs: PENDING_SHUTTER_CLOSE_MS,
      minHoldMs: PENDING_SHUTTER_MIN_HOLD_MS,
      openMs: PENDING_SHUTTER_OPEN_MS,
    })
    _setPendingCaptureDelta(1)
    if (debugEnabled) {
      _logCaptureDiagnostics('shutter animation started', {
        mode: 'pending',
        captureMethod: 'demo canvas',
      })
      _logCaptureDiagnostics('capture pending UI shown', {
        mode: 'pending',
        captureMethod: 'demo canvas',
      })
    }
    const emoji = ['🍄', '🟡', '🤎', '🍂', '🌿'][state.batchCount % 5]
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 600
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#222'
    ctx.fillRect(0, 0, 800, 600)
    ctx.font = '240px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(emoji, 400, 300)

    let finalizeIris = Promise.resolve()
    try {
      const blob = await new Promise(resolve => {
        canvas.toBlob(nextBlob => resolve(nextBlob), 'image/jpeg', 0.9)
      })
      if (!blob) {
        finalizeIris = shutter.cancel()
        throw new Error('Image capture failed')
      }
      const captureResolvedAt = performance.now()
      if (debugEnabled) {
        const dimensions = await _getImageBlobDimensions(blob)
        _logCaptureDiagnostics('capture output afterMs', {
          afterMs: Math.round(captureResolvedAt - captureStartAt),
          captureMethod: 'demo canvas',
          blobType: blob?.type || null,
          blobSize: blob?.size || 0,
          decodedWidth: dimensions.width,
          decodedHeight: dimensions.height,
          videoWidth: null,
          videoHeight: null,
          trackSettings: null,
        })
      }

      finalizeIris = shutter.release({
        captureAfterMs: captureResolvedAt - captureStartAt,
        captureResolvedAt,
      })

      const blobPromise = Promise.resolve(blob)
      state.capturedPhotos.push({
        blob: null,
        blobPromise,
        gps: state.captureSessionLocation.fix,
        ts: new Date(),
        emoji,
        aiCropRect: null,
        aiCropSourceW: 800,
        aiCropSourceH: 600,
        aiCropIsCustom: false,
      })

      state.batchCount++
      document.getElementById('batch-count').textContent = String(state.batchCount)
      document.getElementById('batch-area').style.display = 'flex'

      const vf = document.querySelector('.capture-viewfinder')
      if (vf) {
        vf.style.transition = ''
        vf.style.opacity    = '0.3'
        setTimeout(() => { vf.style.transition = 'opacity 0.15s'; vf.style.opacity = '1' }, 60)
      }

      showToast(t('capture.photoCaptured', { count: state.batchCount }))
    } finally {
      try {
        await finalizeIris
      } finally {
        if (debugEnabled) {
          _logCaptureDiagnostics('capture pending UI cleared', {
            afterMs: Math.round(performance.now() - captureStartAt),
            mode: 'pending',
            captureMethod: 'demo canvas',
          })
        }
        _setPendingCaptureDelta(-1)
      }
    }
  } else {
    const previewW = video.videoWidth
    const previewH = video.videoHeight
    if (!previewW || !previewH) {
      showToast(t('capture.cameraNotReady') || 'Camera not fully ready')
      return
    }

    if (isTinyCameraCaptureDimensions(previewW, previewH)) {
      console.warn('camera stream degraded before capture', {
        videoWidth: previewW,
        videoHeight: previewH,
        trackSettings: typeof track?.getSettings === 'function' ? track.getSettings() : null,
      })
      await _restartCameraStreamAfterDegradation()
      return
    }

    const captureStartAt = performance.now()
    const shutter = startPendingIrisShutter({
      closeMs: PENDING_SHUTTER_CLOSE_MS,
      minHoldMs: PENDING_SHUTTER_MIN_HOLD_MS,
      openMs: PENDING_SHUTTER_OPEN_MS,
    })
    if (debugEnabled) {
      _logCaptureDiagnostics('shutter animation started', {
        mode: 'pending',
        captureMethod: 'camera',
        hasCameraStream: true,
        videoWidth: previewW,
        videoHeight: previewH,
      })
      _logCaptureDiagnostics('capture pending UI shown', {
        mode: 'pending',
        captureMethod: 'camera',
        hasCameraStream: true,
        videoWidth: previewW,
        videoHeight: previewH,
      })
    }

    _setPendingCaptureDelta(1)
    let finalizeIris = Promise.resolve()
    try {
      const captureResult = await _captureCameraBlob(video)
      const captureResolvedAt = performance.now()
      const blob = captureResult?.blob || null
      const captureMethod = captureResult?.captureMethod || 'camera'
      if (!blob) {
        finalizeIris = shutter.cancel()
        throw new Error('Image capture failed')
      }

      const dimensions = await _getImageBlobDimensions(blob)
      if (debugEnabled) {
        _logCaptureDiagnostics('capture output afterMs', {
          afterMs: Math.round(captureResolvedAt - captureStartAt),
          captureMethod,
          blobType: blob.type || null,
          blobSize: blob.size || 0,
          decodedWidth: dimensions.width,
          decodedHeight: dimensions.height,
          videoWidth: previewW,
          videoHeight: previewH,
          trackSettings: typeof track?.getSettings === 'function' ? track.getSettings() : null,
        })
      }

      if (dimensions.width && dimensions.height && isTinyCameraCaptureDimensions(dimensions.width, dimensions.height)) {
        console.warn('camera stream degraded before capture', {
          captureMethod,
          decodedWidth: dimensions.width,
          decodedHeight: dimensions.height,
          videoWidth: previewW,
          videoHeight: previewH,
          trackSettings: typeof track?.getSettings === 'function' ? track.getSettings() : null,
        })
        finalizeIris = shutter.cancel()
        await _restartCameraStreamAfterDegradation()
        return
      }

      finalizeIris = shutter.release({
        captureAfterMs: captureResolvedAt - captureStartAt,
        captureResolvedAt,
      })

      const acceptedWidth = dimensions.width || previewW
      const acceptedHeight = dimensions.height || previewH
      state.capturedPhotos.push({
        blob,
        blobPromise: Promise.resolve(blob),
        gps: state.captureSessionLocation.fix,
        ts: new Date(),
        emoji: '📸',
        aiCropRect: getDefaultAiCropRect(acceptedWidth, acceptedHeight),
        aiCropSourceW: acceptedWidth,
        aiCropSourceH: acceptedHeight,
        aiCropIsCustom: false,
      })

      state.batchCount++
      document.getElementById('batch-count').textContent = String(state.batchCount)
      document.getElementById('batch-area').style.display = 'flex'

      const vf = document.querySelector('.capture-viewfinder')
      if (vf) {
        vf.style.transition = ''
        vf.style.opacity    = '0.3'
        setTimeout(() => { vf.style.transition = 'opacity 0.15s'; vf.style.opacity = '1' }, 60)
      }

      showToast(t('capture.photoCaptured', { count: state.batchCount }))
    } finally {
      try {
        await finalizeIris
      } finally {
        clearIrisShutter()
        if (debugEnabled) {
          _logCaptureDiagnostics('capture pending UI cleared', {
            afterMs: Math.round(performance.now() - captureStartAt),
            mode: 'pending',
            captureMethod: 'camera',
          })
        }
        _setPendingCaptureDelta(-1)
      }
    }
  }
}

function finishCapture() {
  debugImagePipeline('finish capture requested', {
    pendingCaptureCount,
    batchCount: state.batchCount,
  })
  if (pendingCaptureCount > 0) {
    finishCaptureWhenPendingComplete = true
    showToast(t('capture.savingPhoto') || 'Saving photo...')
    return
  }
  stopCamera()
  document.getElementById('bottom-nav').style.display = 'flex'
  const handler = captureCompleteHandler
  if (handler) {
    captureCompleteHandler = null
    const photos = [...state.capturedPhotos]
    state.capturedPhotos = []
    state.batchCount = 0
    state.reviewContext = null
    endCaptureLocationSession()
    document.getElementById('batch-count').textContent = '0'
    document.getElementById('batch-area').style.display = 'none'
    _syncCaptureControls()
    Promise.resolve(handler(photos)).catch(error => {
      console.error('Capture completion handler failed:', error)
      showToast(error?.message || t('capture.addPhotoError') || 'Could not add captured photo')
    })
    return
  }
  navigate('review')
}

function cancelCapture() {
  debugImagePipeline('cancel capture')
  captureCompleteHandler = null
  stopCamera()
  endCaptureLocationSession()
  state.capturedPhotos = []
  state.reviewContext = null
  state.batchCount = 0
  pendingCaptureCount = 0
  finishCaptureWhenPendingComplete = false
  state.captureDraft = createDefaultObservationDraft()
  resetReviewAiState()
  document.getElementById('batch-count').textContent = '0'
  document.getElementById('batch-area').style.display = 'none'
  _syncCaptureControls()
  document.getElementById('bottom-nav').style.display = 'flex'
  navigate('home')
}

function _syncPreviewFit(video) {
  const vf = document.querySelector('.capture-viewfinder')
  if (!vf || !video?.videoWidth || !video?.videoHeight) return

  const videoAspect = video.videoWidth / video.videoHeight
  const viewportAspect = vf.clientWidth / Math.max(vf.clientHeight, 1)

  // Most rear camera sensors are closer to 4:3 than the tall phone viewport.
  // When the aspect ratios differ a lot, prefer showing the full frame over
  // filling the screen, so the preview matches the captured image more closely.
  video.classList.toggle('camera-video-full-frame', Math.abs(videoAspect - viewportAspect) > 0.18)
}
