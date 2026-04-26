import { state } from '../state.js'
import { formatLightReading, t } from '../i18n.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { getDefaultAiCropRect } from '../image_crop.js'
import { getDefaultVisibility } from '../settings.js'
import { openPhotoImportPicker } from './import_review.js'

const CAPTURE_TARGET_WIDTH = 4000
const CAPTURE_TARGET_HEIGHT = 3000
const CAPTURE_MAX_EDGE = 4000
const CAPTURE_JPEG_QUALITY = 0.95
const DEFAULT_EXPOSURE_BIAS_EV = -0.3

function _isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() || ['android', 'ios'].includes(window.Capacitor?.getPlatform?.())
}

export function initCapture() {
  document.getElementById('shutter-btn').addEventListener('click', capturePhoto)
  document.getElementById('done-btn').addEventListener('click', finishCapture)
  document.getElementById('capture-import-btn')?.addEventListener('click', () => {
    void openPhotoImportPicker()
  })
  document.getElementById('camera-retry-btn').addEventListener('click', () => {
    document.getElementById('camera-denied').style.display = 'none'
    startCamera()
  })
}

async function tryGetUserMedia() {
  // Prefer the rear camera and explicitly ask for a 12 MP-ish 4:3 stream.
  // We avoid biasing too hard toward a portrait stream because that can make
  // the live preview feel more cropped than the captured frame.
  const rearDeviceId = await _selectRearCameraDeviceId()
  const highResRearVideo = _cameraConstraints(rearDeviceId)
  const highResAnyRearVideo = _cameraConstraints(null)

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        ...highResRearVideo,
        advanced: [{ zoom: 1 }],
      },
      audio: false,
    })
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          ...highResAnyRearVideo,
          advanced: [{ zoom: 1 }],
        },
        audio: false,
      })
    } catch {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: highResAnyRearVideo,
          audio: false,
        })
      } catch {
        return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      }
    }
  }
}

function _cameraConstraints(deviceId) {
  const constraints = {
    facingMode: { ideal: 'environment' },
    width: { ideal: CAPTURE_TARGET_WIDTH },
    height: { ideal: CAPTURE_TARGET_HEIGHT },
    aspectRatio: { ideal: 4 / 3 },
  }
  if (deviceId) constraints.deviceId = { exact: deviceId }
  return constraints
}

export async function startCamera(options = {}) {
  const preserveBatch = !!options.preserveBatch
  try {
    const stream = await tryGetUserMedia()
    state.cameraStream = stream
    const video = document.getElementById('camera-video')
    video.classList.remove('camera-video-full-frame')
    video.srcObject = stream
    video.onloadedmetadata = async () => {
      try { await video.play() } catch (_) {}
      _syncPreviewFit(video)
      _tuneCameraTrack(stream)
    }
    if (!preserveBatch) {
      state.sessionStart = new Date()
      state.capturedPhotos = []
      state.captureDraft = {
        habitat: '',
        notes: '',
        uncertain: false,
        visibility: getDefaultVisibility(),
      }
    }
    state.batchCount = state.capturedPhotos.length
    document.getElementById('batch-count').textContent = String(state.batchCount)
    document.getElementById('batch-area').style.display = state.batchCount ? 'flex' : 'none'
    simulateLightReading()
  } catch (err) {
    const denied = document.getElementById('camera-denied')
    const body   = document.getElementById('camera-denied-body')

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      const ua = navigator.userAgent
      let instructions
      if (_isNativeApp()) {
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
  }
}

export function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop())
    state.cameraStream = null
  }
  const video = document.getElementById('camera-video')
  if (video) {
    video.onloadedmetadata = null
    video.classList.remove('camera-video-full-frame')
  }
}

async function capturePhoto() {
  const video  = document.getElementById('camera-video')

  if (!video.srcObject) {
    // Demo mode — no real camera
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

    const blobPromise = new Promise((resolve) => {
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.9)
    })
    blobPromise.catch(() => {})

    state.capturedPhotos.push({
      blob: null,
      blobPromise,
      gps: state.gps,
      ts: new Date(),
      emoji,
      aiCropRect: null,
      aiCropSourceW: 800,
      aiCropSourceH: 600,
    })
  } else {
    if (!video.videoWidth || !video.videoHeight) {
      showToast('Camera not fully ready')
      return
    }

    const fallbackDimensions = _fitDimensionsWithinMaxEdge(
      video.videoWidth,
      video.videoHeight,
      CAPTURE_MAX_EDGE,
    )
    const blobPromise = _captureBestAvailableBlob(video)
    const photo = {
      blob: null,
      blobPromise,
      gps: state.gps,
      ts: new Date(),
      emoji: '📸',
      aiCropRect: getDefaultAiCropRect(fallbackDimensions.width, fallbackDimensions.height),
      aiCropSourceW: fallbackDimensions.width,
      aiCropSourceH: fallbackDimensions.height,
    }
    blobPromise
      .then(blob => _readImageDimensions(blob))
      .then(nextDimensions => {
        const dimensions = nextDimensions || fallbackDimensions
        photo.aiCropRect = getDefaultAiCropRect(dimensions.width, dimensions.height)
        photo.aiCropSourceW = dimensions.width
        photo.aiCropSourceH = dimensions.height
      })
      .catch(() => {})
    
    // Add a dummy catch to prevent UnhandledPromiseRejection if it's not awaited immediately
    blobPromise.catch(() => {})

    state.capturedPhotos.push(photo)
  }

  state.batchCount++
  document.getElementById('batch-count').textContent = state.batchCount
  document.getElementById('batch-area').style.display = 'flex'

  // Flash animation
  const vf = document.querySelector('.capture-viewfinder')
  vf.style.transition = ''
  vf.style.opacity    = '0.3'
  setTimeout(() => { vf.style.transition = 'opacity 0.15s'; vf.style.opacity = '1' }, 60)

  showToast(t('capture.photoCaptured', { count: state.batchCount }))
}

async function _selectRearCameraDeviceId() {
  if (!navigator.mediaDevices?.enumerateDevices) return null
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const rearCameras = devices
      .filter(device => device.kind === 'videoinput')
      .map(device => ({
        device,
        label: String(device.label || '').toLowerCase(),
      }))
      .filter(entry => /back|rear|environment|0\b/.test(entry.label))

    const normalLens = rearCameras.find(entry => (
      !/ultra|0\.5|macro|depth|tele|front/.test(entry.label)
      && /back|rear|environment|main|camera 0|0\b/.test(entry.label)
    ))
    return (normalLens || rearCameras.find(entry => !/front/.test(entry.label)))?.device.deviceId || null
  } catch (_) {
    return null
  }
}

function _tuneCameraTrack(stream) {
  const track = stream?.getVideoTracks?.()[0]
  if (!track?.getCapabilities || !track?.applyConstraints) return
  const capabilities = track.getCapabilities()
  const advanced = []

  if (capabilities.zoom && typeof capabilities.zoom.min === 'number' && typeof capabilities.zoom.max === 'number') {
    advanced.push({ zoom: Math.max(capabilities.zoom.min, Math.min(capabilities.zoom.max, 1)) })
  }

  if (
    capabilities.exposureCompensation
    && typeof capabilities.exposureCompensation.min === 'number'
    && typeof capabilities.exposureCompensation.max === 'number'
  ) {
    advanced.push({
      exposureCompensation: Math.max(
        capabilities.exposureCompensation.min,
        Math.min(capabilities.exposureCompensation.max, DEFAULT_EXPOSURE_BIAS_EV),
      ),
    })
  }

  if (advanced.length) {
    track.applyConstraints({ advanced }).catch(() => {})
  }
}

async function _captureBestAvailableBlob(video) {
  const track = video.srcObject?.getVideoTracks?.()[0]
  if (track && typeof window.ImageCapture === 'function') {
    try {
      const imageCapture = new window.ImageCapture(track)
      const photoSettings = await _getPhotoSettings(imageCapture)
      const blob = await imageCapture.takePhoto(photoSettings)
      if (blob instanceof Blob && blob.size > 0) return blob
    } catch (_) {}
  }
  return _captureCanvasBlob(video)
}

async function _getPhotoSettings(imageCapture) {
  if (!imageCapture?.getPhotoCapabilities) {
    return {
      imageWidth: CAPTURE_TARGET_WIDTH,
      imageHeight: CAPTURE_TARGET_HEIGHT,
    }
  }

  try {
    const capabilities = await imageCapture.getPhotoCapabilities()
    return {
      imageWidth: _fitCapabilityValue(capabilities.imageWidth, CAPTURE_TARGET_WIDTH),
      imageHeight: _fitCapabilityValue(capabilities.imageHeight, CAPTURE_TARGET_HEIGHT),
    }
  } catch (_) {
    return {
      imageWidth: CAPTURE_TARGET_WIDTH,
      imageHeight: CAPTURE_TARGET_HEIGHT,
    }
  }
}

function _fitCapabilityValue(capability, target) {
  if (!capability || typeof capability.min !== 'number' || typeof capability.max !== 'number') return target
  return Math.max(capability.min, Math.min(capability.max, target))
}

function _captureCanvasBlob(video) {
  const { width: w, height: h } = _fitDimensionsWithinMaxEdge(
    video.videoWidth,
    video.videoHeight,
    CAPTURE_MAX_EDGE,
  )

  // Create a fresh canvas for each capture to avoid toBlob() race conditions
  // which can cause promises to hang if the shutter is tapped rapidly.
  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('Canvas context unavailable'))
  ctx.drawImage(video, 0, 0, w, h)

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('Image capture failed'))
    }, 'image/jpeg', CAPTURE_JPEG_QUALITY)
  })
}

function _fitDimensionsWithinMaxEdge(width, height, maxEdge) {
  let w = Math.max(1, Number(width) || 1)
  let h = Math.max(1, Number(height) || 1)

  if (w > maxEdge || h > maxEdge) {
    const scale = maxEdge / Math.max(w, h)
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }

  return { width: w, height: h }
}

function _readImageDimensions(blob) {
  if (!(blob instanceof Blob)) return Promise.resolve(null)
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

function finishCapture() {
  stopCamera()
  document.getElementById('bottom-nav').style.display = 'flex'
  navigate('review')
}

function simulateLightReading() {
  if (state.currentScreen !== 'capture') return
  const lux = Math.round(200 + Math.random() * 600)
  const f   = (1.8 + Math.random() * 4).toFixed(1)
  const el  = document.getElementById('light-display')
  if (el) el.textContent = formatLightReading(lux, f)
  setTimeout(simulateLightReading, 3000)
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
