import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'

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
  // Request portrait-oriented video so object-fit:cover doesn't over-crop.
  // zoom:1 is ignored on platforms that don't support it (iOS), but helps on Android.
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width:  { ideal: 1080 },
        height: { ideal: 1920 },
        advanced: [{ zoom: 1 }],
      },
      audio: false,
    })
  } catch {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1920 } },
        audio: false,
      })
    } catch {
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    }
  }
}

export async function startCamera() {
  try {
    const stream = await tryGetUserMedia()
    state.cameraStream = stream
    const video = document.getElementById('camera-video')
    video.srcObject = stream
    video.addEventListener('loadedmetadata', _fixVideoOrientation, { once: true })
    state.sessionStart = new Date()
    state.batchCount = 0
    state.capturedPhotos = []
    document.getElementById('batch-count').textContent = '0'
    document.getElementById('batch-area').style.display = 'none'
    simulateLightReading()
  } catch (err) {
    const denied = document.getElementById('camera-denied')
    const body   = document.getElementById('camera-denied-body')

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      const ua = navigator.userAgent
      let instructions
      if (/iPhone|iPad/.test(ua)) {
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

function _fixVideoOrientation() {
  const video = document.getElementById('camera-video')
  if (!video || video.videoWidth <= video.videoHeight) return // already portrait

  // Android delivers a landscape-oriented stream even when held in portrait.
  // Rotate the video element 90° and swap its logical dimensions so it fills
  // the portrait viewfinder without letterboxing.
  const container = video.parentElement
  video.style.position  = 'absolute'
  video.style.top       = '50%'
  video.style.left      = '50%'
  video.style.width     = container.clientHeight + 'px'
  video.style.height    = container.clientWidth  + 'px'
  video.style.transform = 'translate(-50%, -50%) rotate(90deg)'
  video.style.objectFit = 'contain'
}

export function stopCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(t => t.stop())
    state.cameraStream = null
  }
  const video = document.getElementById('camera-video')
  if (video) {
    video.style.cssText = ''  // reset any orientation overrides
    video.srcObject = null
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
