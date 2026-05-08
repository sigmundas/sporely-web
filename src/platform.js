export function isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.() ||
         ['android', 'ios'].includes(window.Capacitor?.getPlatform?.());
}

export function isAndroidApp() {
  return isNativeApp() && window.Capacitor?.getPlatform?.() === 'android';
}

export function isIOSApp() {
  return isNativeApp() && window.Capacitor?.getPlatform?.() === 'ios';
}