// src/platform.js (Conceptual file, as it was not provided in context)

export function getPlatform() {
  return globalThis.window?.Capacitor?.getPlatform?.();
}

export function isNativeApp() {
  return !!globalThis.window?.Capacitor?.isNativePlatform?.();
}

export function isAndroidApp() {
  return getPlatform() === 'android';
}

export function isPhoneWebApp() {
  try {
    if (isNativeApp()) return false

    const nav = globalThis.navigator || {}
    const ua = String(nav.userAgent || '')
    const uaDataMobile = nav.userAgentData?.mobile
    if (typeof uaDataMobile === 'boolean') return uaDataMobile

    if (/android/i.test(ua)) return true
    if (/iphone|ipod/i.test(ua)) return true
    if (/ipad/i.test(ua)) return true

    const platform = String(nav.platform || '')
    return /macintosh/i.test(ua)
      && /mac/i.test(platform)
      && Number(nav.maxTouchPoints || 0) > 1
  } catch (_) {
    return false
  }
}
