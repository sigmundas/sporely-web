import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'

function _isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() || ['android', 'ios'].includes(window.Capacitor?.getPlatform?.())
}

export function initCapture() {
  document.getElementById('flash-btn').addEventListener('click', toggleFlash)
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
        visibility: 'friends',
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
        instructions = 'Allow Camera for Sporely in Android app permissions, then tap "Try again".'
      } else if (/iPhone|iPad/.test(ua)) {
        instructions = 'On iPhone: open the Settings app → scroll down to Safari (or your browser) → Camera → Allow.'
      } else if (/Firefox/.test(ua)) {
        instructions = 'In Firefox: tap the lock icon in the address bar → Site permissions → Camera → Allow.'
      } else if (/SamsungBrowser/.test(ua)) {
        instructions = 'In Samsung Internet: tap the lock icon in the address bar → Permissions → Camera → Allow.'
      } else {
        instructions = 'Tap the lock or camera icon in your browser\'s address bar, allow camera access, then tap "Try again".'
      }
      body.textContent = instructions
      denied.style.display = 'flex'
    } else if (err.name === 'NotFoundError') {
      body.textContent = 'No camera was found on this device.'
      denied.style.display = 'flex'
    } else {
      body.textContent = `Camera could not be started (${err.name}). Close other apps using the camera and try again.`
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
  const canvas = document.getElementById('camera-canvas')

  if (!video.srcObject) {
    // Demo mode — no real camera
    const emoji = ['🍄', '🟡', '🤎', '🍂', '🌿'][state.batchCount % 5]
    state.capturedPhotos.push({ blob: null, blobPromise: null, gps: state.gps, ts: new Date(), emoji })
  } else {
    canvas.width  = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)

    // Wrap toBlob in a Promise so finishAndSync can await all blobs before uploading
    const blobPromise = new Promise(resolve =>
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.92)
    )
    state.capturedPhotos.push({ blob: null, blobPromise, gps: state.gps, ts: new Date(), emoji: '📸' })
  }

  state.batchCount++
  document.getElementById('batch-count').textContent = state.batchCount
  document.getElementById('batch-area').style.display = 'flex'

  // Flash animation
  const vf = document.querySelector('.capture-viewfinder')
  vf.style.transition = ''
  vf.style.opacity    = '0.3'
  setTimeout(() => { vf.style.transition = 'opacity 0.15s'; vf.style.opacity = '1' }, 60)

  showToast(`Photo ${state.batchCount} captured`)
}

function finishCapture() {
  stopCamera()
  document.getElementById('bottom-nav').style.display = 'flex'
  navigate('review')
}

function toggleFlash() {
  state.flashOn = !state.flashOn
  const btn = document.getElementById('flash-btn')
  btn.style.background  = state.flashOn ? 'rgba(255,220,100,0.3)' : 'rgba(255,255,255,0.12)'
  btn.style.borderColor = state.flashOn ? 'rgba(255,220,100,0.5)' : 'rgba(255,255,255,0.15)'
  showToast(`Flash ${state.flashOn ? 'on' : 'off'}`)
}

function simulateLightReading() {
  if (state.currentScreen !== 'capture') return
  const lux = Math.round(200 + Math.random() * 600)
  const f   = (1.8 + Math.random() * 4).toFixed(1)
  const el  = document.getElementById('light-display')
  if (el) el.textContent = `LIGHT: ${lux} LUX / F-STOP: ${f}`
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
