import { state } from '../state.js'
import { t } from '../i18n.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { getDefaultAiCropRect } from '../image_crop.js'
import { getDefaultVisibility } from '../settings.js'
import { openPhotoImportPicker } from './import_review.js'

function _isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() || ['android', 'ios'].includes(window.Capacitor?.getPlatform?.())
}

let cachedPrimaryMainCameraId = null
let primaryMainCameraPromise = null

const CAMERA_VIDEO_WIDTH_IDEAL = 4000
const CAMERA_VIDEO_HEIGHT_IDEAL = 3000

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

function _stopMediaStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return
  stream.getTracks().forEach(track => track.stop())
}

function _isPermissionDeniedError(err) {
  return err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
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
  if (cachedPrimaryMainCameraId) return cachedPrimaryMainCameraId
  if (primaryMainCameraPromise) return primaryMainCameraPromise

  primaryMainCameraPromise = (async () => {
    try {
      await _primeCameraPermission()

      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = devices.filter(device => device.kind === 'videoinput')
      const candidateDevices = videoDevices.filter(device => !_isClearlyFrontCamera(device))
      const probeDevices = candidateDevices.length ? candidateDevices : videoDevices

      for (const device of probeDevices) {
        try {
          if (await _probeDeviceForTorch(device)) {
            cachedPrimaryMainCameraId = device.deviceId
            console.log('Main 1x camera identified via torch capability:', device.label || device.deviceId)
            return cachedPrimaryMainCameraId
          }
        } catch (err) {
          console.warn('Torch heuristic: failed to inspect camera:', device.label || device.deviceId, err)
        }
      }

      console.log('Torch heuristic: no torch-capable camera found; falling back to environment camera.')
      return null
    } catch (err) {
      console.warn('Torch heuristic failed:', err)
      if (_isPermissionDeniedError(err)) throw err
      return null
    } finally {
      primaryMainCameraPromise = null
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
    console.warn('Camera zoom preference could not be applied:', err)
  }

  if (typeof track.getSettings === 'function') {
    console.log('Camera stream settings:', track.getSettings())
  }
}

async function tryGetUserMedia() {
  // Step 1: Run the torch heuristic to find the primary main lens
  const mainDeviceId = await _getPrimaryMainCameraId()

  // Step 2: Try to start the camera using the exact device ID if found
  if (mainDeviceId) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: mainDeviceId },
          width:  { ideal: CAMERA_VIDEO_WIDTH_IDEAL },
          height: { ideal: CAMERA_VIDEO_HEIGHT_IDEAL },
        },
        audio: false
      })
      await _applyPrimaryLensPreferences(stream)
      return stream
    } catch (err) {
      cachedPrimaryMainCameraId = null
      console.warn('Failed to start camera with heuristic deviceId, falling back...', err)
    }
  }

  // Step 3: Fallback logic
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: CAMERA_VIDEO_WIDTH_IDEAL },
        height: { ideal: CAMERA_VIDEO_HEIGHT_IDEAL },
      },
      audio: false,
    })
    await _applyPrimaryLensPreferences(stream)
    return stream
  } catch {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: CAMERA_VIDEO_WIDTH_IDEAL },
          height: { ideal: CAMERA_VIDEO_HEIGHT_IDEAL },
        },
        audio: false,
      })
      await _applyPrimaryLensPreferences(stream)
      return stream
    } catch {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      await _applyPrimaryLensPreferences(stream)
      return stream
    }
  }
}

function _isBlob(value) {
  return value instanceof Blob || (value && typeof value.size === 'number' && typeof value.type === 'string')
}

function _finiteMaxRangeValue(range) {
  const max = Number(range?.max)
  return Number.isFinite(max) && max > 0 ? Math.round(max) : null
}

async function _getImageBlobDimensions(blob) {
  if (!_isBlob(blob)) return { width: null, height: null }

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
  if (!track || typeof window.ImageCapture !== 'function') return null

  const imageCapture = new window.ImageCapture(track)
  if (typeof imageCapture.takePhoto !== 'function') return null

  const photoSettings = {}
  try {
    if (typeof imageCapture.getPhotoCapabilities === 'function') {
      const capabilities = await imageCapture.getPhotoCapabilities()
      const imageWidth = _finiteMaxRangeValue(capabilities?.imageWidth)
      const imageHeight = _finiteMaxRangeValue(capabilities?.imageHeight)
      if (imageWidth) photoSettings.imageWidth = imageWidth
      if (imageHeight) photoSettings.imageHeight = imageHeight
      if (capabilities?.fillLightMode?.includes?.('off')) photoSettings.fillLightMode = 'off'
    }
  } catch (err) {
    console.warn('Photo capabilities unavailable; taking still with defaults:', err)
  }

  const blob = await imageCapture.takePhoto(photoSettings)
  if (!_isBlob(blob)) throw new Error('Still photo capture returned no image')
  console.log('Captured still photo via ImageCapture:', {
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
    showToast('Camera not fully ready')
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

  console.log('Captured fallback video frame:', { width: w, height: h, bytes: blob.size })
  return blob
}

async function _captureCameraBlob(video) {
  try {
    const stillBlob = await _takeStillPhoto(video)
    if (_isBlob(stillBlob)) return stillBlob
  } catch (err) {
    console.warn('ImageCapture still photo failed; falling back to video frame:', err)
  }
  return await _captureVideoFrame(video)
}

export async function startCamera(options = {}) {
  const preserveBatch = !!options.preserveBatch
  try {
    stopCamera()
    const stream = await tryGetUserMedia()
    state.cameraStream = stream
    const video = document.getElementById('camera-video')
    video.classList.remove('camera-video-full-frame')
    video.srcObject = stream
    video.onloadedmetadata = async () => {
      try { await video.play() } catch (_) {}
      _syncPreviewFit(video)
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
}

function capturePhoto() {
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
    const previewW = video.videoWidth
    const previewH = video.videoHeight
    if (!previewW || !previewH) {
      showToast('Camera not fully ready')
      return
    }

    const photo = {
      blob: null,
      blobPromise: null,
      gps: state.gps,
      ts: new Date(),
      emoji: '📸',
      aiCropRect: getDefaultAiCropRect(previewW, previewH),
      aiCropSourceW: previewW,
      aiCropSourceH: previewH,
    }

    const blobPromise = _captureCameraBlob(video).then(async blob => {
      const dimensions = await _getImageBlobDimensions(blob)
      if (dimensions.width && dimensions.height) {
        photo.aiCropRect = getDefaultAiCropRect(dimensions.width, dimensions.height)
        photo.aiCropSourceW = dimensions.width
        photo.aiCropSourceH = dimensions.height
      }
      return blob
    })
    
    // Add a dummy catch to prevent UnhandledPromiseRejection if it's not awaited immediately
    blobPromise.catch(() => {})

    photo.blobPromise = blobPromise
    state.capturedPhotos.push(photo)
  }

  state.batchCount++
  document.getElementById('batch-count').textContent = state.batchCount
  document.getElementById('batch-area').style.display = 'flex'

  // Flash animation
  const vf = document.querySelector('.capture-viewfinder')
  if (vf) {
    vf.style.transition = ''
    vf.style.opacity    = '0.3'
    setTimeout(() => { vf.style.transition = 'opacity 0.15s'; vf.style.opacity = '1' }, 60)
  }

  showToast(t('capture.photoCaptured', { count: state.batchCount }))
}

function finishCapture() {
  stopCamera()
  document.getElementById('bottom-nav').style.display = 'flex'
  navigate('review')
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
