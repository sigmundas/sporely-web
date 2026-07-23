// Route "Open location settings" from the location-fix sheet to the right
// Android settings screen. On non-native platforms (or if the intent can't
// be resolved) fall back to a concise instructions toast.
//
// The native side lives in android/app/src/main/java/com/sporelab/sporely/
// LocationSettingsPlugin.java — Capacitor plugin name "LocationSettings",
// method openLocationSettings() which tries the system Location toggle
// first and falls back to this app's details page.
import { showToast } from './toast.js'

export const NO_LOCATION_PILL_TEXT = 'No location · Tap to fix'
export const LOCATION_ENABLE_INSTRUCTIONS =
  'Turn on location in your device or browser settings and allow Sporely to use it, then return here.'

function _locationSettingsPlugin() {
  const plugins = globalThis.Capacitor?.Plugins
  const plugin = plugins?.LocationSettings
  return typeof plugin?.openLocationSettings === 'function' ? plugin : null
}

export function supportsOpenAppSettings() {
  return _locationSettingsPlugin()
}

export async function openLocationSettingsOrExplain() {
  const plugin = _locationSettingsPlugin()
  if (plugin) {
    try {
      const result = await plugin.openLocationSettings()
      if (result?.opened && result.opened !== 'none') return true
    } catch (error) {
      console.warn('Unable to open location settings:', error)
    }
  }
  showToast(LOCATION_ENABLE_INSTRUCTIONS)
  return false
}
