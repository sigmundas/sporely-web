import { Capacitor } from '@capacitor/core'
import { CameraPreview } from '@capgo/camera-preview'
import { state } from '../state.js'
import { t } from '../i18n.js'
import { navigate, goBack } from '../router.js'
import { showToast } from '../toast.js'
import { getDefaultAiCropRect } from '../image_crop.js'
import { getDefaultVisibility } from '../settings.js'
import { openPhotoImportPicker } from './import_review.js'

const isAndroidNative = !!window.Capacitor?.isNativePlatform?.() && window.Capacitor?.getPlatform?.() === 'android'

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
    if (isAndroidNative) {
      const video = document.getElementById('camera-video')
      if (video) video.style.display = 'none'
      
      // Ensure software keyboard is closed so screen dimensions are accurate
      if (document.activeElement) document.activeElement.blur()
      
      // Step 1: Wait for DOM to settle
      await new Promise(resolve => setTimeout(resolve, 150))
      
      // Align the top of the camera feed exactly with the top of the screen (4:3 ratio)
      const yPos = 0
      const camWidth = Math.round(window.innerWidth)
      const camHeight = Math.round(camWidth * (4 / 3))
      
      let zoomValues = [0.5, 1, 2, 3]
      if (CameraPreview.getZoomButtonValues) {
        try {
          const res = await CameraPreview.getZoomButtonValues()
          if (Array.isArray(res)) zoomValues = res
          else if (res && Array.isArray(res.values)) zoomValues = res.values
        } catch (e) {}
      }
      
      const zoomContainer = document.getElementById('zoom-controls')
      if (zoomContainer) {
        zoomContainer.innerHTML = ''
        zoomValues.forEach(val => {
          const btn = document.createElement('button')
          btn.className = 'zoom-btn'
          btn.textContent = val + 'x'
          if (val === 1) btn.classList.add('active')
          btn.onclick = async () => {
            const buttonValue = String(val) + 'x'
            const numericZoom = parseFloat(buttonValue.replace('x', ''))
            
            try {
              await CameraPreview.setZoom({ zoom: numericZoom })
              
              if (CameraPreview.getAvailableDevices && CameraPreview.setDeviceId) {
                // 1. Fetch all physical cameras
                const res = await CameraPreview.getAvailableDevices()
                const devices = res.devices || res.values || (Array.isArray(res) ? res : [])

                // 2. Filter to only get the rear-facing physical lenses
                const rearLenses = devices.filter(d => 
                  String(d.position || '').toLowerCase() === 'rear' || 
                  String(d.position || '').toLowerCase() === 'back' ||
                  String(d.lensFacing || '').toLowerCase() === 'back' ||
                  String(d.lensFacing || '') === '1'
                )

                // Samsung typically lists the main camera first, ultra-wide second, and telephoto third. 
                // We map our buttons directly to these physical array indexes.
                let targetId = null
                if (buttonValue === '0.5x' && rearLenses.length > 1) {
                  targetId = rearLenses[1].deviceId // Usually the ultra-wide
                } else if (buttonValue === '3x' && rearLenses.length > 2) {
                  targetId = rearLenses[2].deviceId // Usually the telephoto
                } else if (rearLenses.length > 0) {
                  targetId = rearLenses[0].deviceId // Default to 1x main
                }

                // 3. Force the hardware to switch lenses
                if (targetId) {
                  await CameraPreview.setDeviceId({ deviceId: targetId })
                }
              }
            } catch (e) {
              console.warn('Lens switch error', e)
            }
            
            document.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'))
            btn.classList.add('active')
          }
          zoomContainer.appendChild(btn)
        })
      }

      await CameraPreview.start({
        position: 'rear',
        toBack: false, // SILVER BULLET: Renders ON TOP of the webview, killing the flicker
        enableZoom: true,
        x: 0,
        y: yPos,
        width: camWidth,
        height: camHeight,
        aspectMode: 'fit',
      })
      try {
        await CameraPreview.setZoom({ zoom: 1.0 })
      } catch (zoomErr) {}

      state.cameraStream = 'native'
    } else {
      const stream = await tryGetUserMedia()
      state.cameraStream = stream
      const video = document.getElementById('camera-video')
      video.classList.remove('camera-video-full-frame')
      video.srcObject = stream
      video.onloadedmetadata = async () => {
        try { await video.play() } catch (_) {}
        _syncPreviewFit(video)
      }
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
  if (isAndroidNative) {
    CameraPreview.stop().catch(() => {})
    
    const video = document.getElementById('camera-video')
    if (video) video.style.display = ''
    
    state.cameraStream = null
  } else if (state.cameraStream) {
    if (state.cameraStream !== 'native' && typeof state.cameraStream.getTracks === 'function') {
      state.cameraStream.getTracks().forEach(t => t.stop())
    }
    state.cameraStream = null
  }
  const video = document.getElementById('camera-video')
  if (video) {
    video.onloadedmetadata = null
    video.classList.remove('camera-video-full-frame')
  }
}

function capturePhoto() {
  if (isAndroidNative) {
    const blobPromise = new Promise(async (resolve, reject) => {
      try {
        const result = await CameraPreview.capture({ storeToFile: true, withExifLocation: true })
        const filePath = result.value || result.path || (typeof result === 'string' ? result : null)
        if (!filePath) throw new Error('No file returned from native camera')
        const fileUrl = Capacitor.convertFileSrc(filePath)
        const res = await fetch(fileUrl)
        const blob = await res.blob()
        resolve(blob)
      } catch (err) {
        reject(err)
      }
    })
    
    blobPromise.catch(() => {}) // Prevent UnhandledPromiseRejection
    
    state.capturedPhotos.push({
      blob: null,
      blobPromise,
      gps: state.gps, // Native capture keeps EXIF GPS, but keep app GPS for redundancy
      ts: new Date(),
      emoji: '📸',
      aiCropRect: null,
      aiCropSourceW: null,
      aiCropSourceH: null,
    })
  } else {
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
