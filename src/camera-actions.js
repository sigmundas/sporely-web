import { t } from './i18n.js'
import { navigate } from './router.js'
import { getUseSystemCamera } from './settings.js'

const ANDROID_WEB_CAMERA_WARNING_KEY = 'sporely-hide-android-web-camera-warning'

let nativeCameraOpener = null

export function setNativeCameraOpener(opener) {
  nativeCameraOpener = typeof opener === 'function' ? opener : null
}

export function isAndroidNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.()
    && window.Capacitor?.getPlatform?.() === 'android'
}

function _isIosWebApp() {
  const ua = navigator.userAgent || ''
  const navPlatform = navigator.platform || ''
  const capacitorPlatform = window.Capacitor?.getPlatform?.()
  if (window.Capacitor?.isNativePlatform?.()) return false
  return capacitorPlatform === 'ios'
    || /iphone|ipad|ipod/i.test(ua)
    || (/macintosh/i.test(ua) && /mac/i.test(navPlatform) && Number(navigator.maxTouchPoints || 0) > 1)
}

function _isAndroidWebApp() {
  const platform = window.Capacitor?.getPlatform?.()
  if (window.Capacitor?.isNativePlatform?.() || platform === 'android') return false
  return /android/i.test(navigator.userAgent || '')
}

export function getEffectiveCameraLabel() {
  if (isAndroidNativeApp()) {
    return t(getUseSystemCamera() ? 'home.nativeCam' : 'home.sporelyCam')
  }
  return t(_isIosWebApp() ? 'home.sporelyCam' : 'home.webCam')
}

export async function openPreferredCamera() {
  if (isAndroidNativeApp() && nativeCameraOpener) {
    await nativeCameraOpener()
    return
  }
  if (_isAndroidWebApp() && localStorage.getItem(ANDROID_WEB_CAMERA_WARNING_KEY) !== '1') {
    _showAndroidWebCameraWarning()
    return
  }
  navigate('capture')
}

export function initCameraFallbackWarning() {
  const overlay = document.getElementById('android-web-camera-warning-overlay')
  const dontShow = document.getElementById('android-web-camera-warning-dont-show')
  if (!overlay || overlay._wired) return
  overlay._wired = true

  document.getElementById('android-web-camera-warning-cancel')?.addEventListener('click', () => {
    overlay.style.display = 'none'
  })
  document.getElementById('android-web-camera-warning-continue')?.addEventListener('click', () => {
    if (dontShow?.checked) localStorage.setItem(ANDROID_WEB_CAMERA_WARNING_KEY, '1')
    overlay.style.display = 'none'
    navigate('capture')
  })
}

function _showAndroidWebCameraWarning() {
  const overlay = document.getElementById('android-web-camera-warning-overlay')
  const dontShow = document.getElementById('android-web-camera-warning-dont-show')
  if (!overlay) {
    navigate('capture')
    return
  }
  if (dontShow) dontShow.checked = false
  overlay.style.display = 'flex'
}
