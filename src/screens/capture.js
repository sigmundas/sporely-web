import { state } from '../state.js'
import { formatLightReading, t } from '../i18n.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { getDefaultAiCropRect } from '../image_crop.js'
import { getDefaultVisibility } from '../settings.js'

function _isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() || ['android', 'ios'].includes(window.Capacitor?.getPlatform?.())
}

export function initCapture() {
  document.getElementById('shutter-btn').addEventListener('click', capturePhoto)
  document.getElementById('done-btn').addEventListener('click', finishCapture)
  document.getElementById('camera-retry-btn').addEventListener('click', () => {
    document.getElementById('camera-denied').style.display = 'none'
    startCamera()
  })
}

async function tryGetUserMedia() {
  // Prefer the rear camera and explicitly ask for 1x zoom when supported.
  // We avoid biasing too hard toward a portrait stream because that can make
  // the live preview feel more cropped than the captured frame.
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width:  { ideal: 1920 },
        height: { ideal: 1440 },
        advanced: [{ zoom: 1 }],
      },
      audio: false,
    })
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      })
    } catch {
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    }
  }
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
    let w = video.videoWidth
    let h = video.videoHeight

    if (!w || !h) {
      showToast('Camera not fully ready')
      return
    }

    // Scale down to prevent mobile browser OOM crashes from huge blobs
    const maxEdge = 1920
    if (w > maxEdge || h > maxEdge) {
      const scale = maxEdge / Math.max(w, h)
      w = Math.round(w * scale)
      h = Math.round(h * scale)
    }

    // Create a fresh canvas for each capture to avoid toBlob() race conditions
    // which can cause promises to hang if the shutter is tapped rapidly.
    const canvas = document.createElement('canvas')
    canvas.width  = w
    canvas.height = h
    canvas.getContext('2d').drawImage(video, 0, 0, w, h)

    // Wrap toBlob in a Promise so review save can await all blobs before uploading
    const blobPromise = new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob)
        else reject(new Error('Image capture failed'))
      }, 'image/jpeg', 0.92)
    })
    
    // Add a dummy catch to prevent UnhandledPromiseRejection if it's not awaited immediately
    blobPromise.catch(() => {})
    
    state.capturedPhotos.push({
      blob: null,
      blobPromise,
      gps: state.gps,
      ts: new Date(),
      emoji: '📸',
      aiCropRect: getDefaultAiCropRect(w, h),
      aiCropSourceW: w,
      aiCropSourceH: h,
    })
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
