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
