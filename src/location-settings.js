// Shared helpers for the GPS pill on the capture and review screens, and for
// routing "Open location settings" to the native app-settings screen or to
// concise instructions on the web.
import { showToast } from './toast.js'

export const NO_LOCATION_PILL_TEXT = 'No location · Tap to fix'
export const LOCATION_ENABLE_INSTRUCTIONS =
  'Turn on location in your device or browser settings and allow Sporely to use it, then return here.'

export function supportsOpenAppSettings() {
  const app = globalThis.Capacitor?.Plugins?.App || globalThis.Capacitor?.App || null
  return typeof app?.openSettings === 'function' ? app : null
}

export async function openLocationSettingsOrExplain() {
  const app = supportsOpenAppSettings()
  if (app) {
    try {
      await app.openSettings.call(app)
      return true
    } catch (error) {
      console.warn('Unable to open location settings:', error)
    }
  }
  showToast(LOCATION_ENABLE_INSTRUCTIONS)
  return false
}
