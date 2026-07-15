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

// iOS Safari / iOS PWA (Add-to-Home-Screen). Explicitly excludes Capacitor
// native iOS builds. WebKit's transient user activation and multi-getUserMedia
// behaviour differ enough that callers need a reliable "is this iOS web?" gate
// — see HISTORY.md ("iOS Safari geolocation prompt is NOT consent").
export function isIosWebApp() {
  try {
    if (isNativeApp()) return false
    const nav = globalThis.navigator || {}
    const ua = String(nav.userAgent || '')
    const platform = String(nav.platform || '')
    if (/iphone|ipad|ipod/i.test(ua)) return true
    // iPadOS reports as Mac with touch support.
    return /macintosh/i.test(ua)
      && /mac/i.test(platform)
      && Number(nav.maxTouchPoints || 0) > 1
  } catch (_) {
    return false
  }
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
