let mapModulePromise = null
let mapInitialized = false

async function ensureMapModule() {
  if (!mapModulePromise) {
    mapModulePromise = import('./screens/map.js')
  }
  const module = await mapModulePromise
  if (!mapInitialized) {
    module.initMap()
    mapInitialized = true
  }
  return module
}

export async function loadMapScreen() {
  const module = await ensureMapModule()
  return module.loadMap()
}

/**
 * Open the observations map zoomed to one find, with its marker selected.
 *
 * Goes through the loader so callers (the Find detail screen) do not pull
 * Leaflet into their own bundle, and so the map keeps a single instance.
 *
 * @param {{ id: string|number, lat: unknown, lon: unknown, ownerId?: string|null }} target
 */
export async function focusObservationOnMapScreen(target) {
  const module = await ensureMapModule()
  return module.focusObservationOnMap(target)
}

/**
 * Open the map in location-picker mode. `onSave` runs only when the user
 * confirms; cancelling reports nothing.
 *
 * @param {{ lat?: unknown, lon?: unknown, onSave: (coords: { lat: number, lon: number }) => unknown }} options
 */
export async function openMapLocationPickerScreen(options) {
  const module = await ensureMapModule()
  return module.openMapLocationPicker(options)
}
