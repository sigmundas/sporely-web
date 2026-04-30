import { t } from './i18n.js'
import { navigate } from './router.js'
import { getCameraMode } from './settings.js'

let nativeCameraOpener = null

export function setNativeCameraOpener(opener) {
  nativeCameraOpener = typeof opener === 'function' ? opener : null
}

export function isAndroidNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.()
    && window.Capacitor?.getPlatform?.() === 'android'
}

export function getEffectiveCameraMode() {
  const mode = getCameraMode()
  return mode === 'native' && isAndroidNativeApp() ? 'native' : 'sporely'
}

export function getEffectiveCameraLabel() {
  return t(getEffectiveCameraMode() === 'native' ? 'home.nativeCam' : 'home.sporelyCam')
}

export async function openPreferredCamera() {
  if (getEffectiveCameraMode() === 'native' && nativeCameraOpener) {
    await nativeCameraOpener()
    return
  }
  navigate('capture')
}
