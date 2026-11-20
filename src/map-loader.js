import { currentAccountGeneration } from './account-transition.js'

let mapModulePromise = null
let mapModule = null
let mapInitialized = false

async function ensureMapModule() {
  if (!mapModulePromise) {
    mapModulePromise = import('./screens/map.js')
  }
  const module = await mapModulePromise
  mapModule = module
  if (!mapInitialized) {
    module.initMap()
    mapInitialized = true
  }
  return module
}

/**
 * Synchronously clear the previous account's map data at sign-out or account
 * switch. A no-op until the map has been opened, so it never pulls Leaflet in.
 */
export function resetMapForAccountTransition() {
  try {
    mapModule?.resetMapForAccountTransition?.()
  } catch (err) {
    console.warn('Map reset on account transition failed:', err)
  }
}

export async function loadMapScreen() {
  const module = await ensureMapModule()
  // Only the router calls this, so it marks entering the screen as opposed to
  // the map reloading itself after one of its own filters changed.
  module.beginMapScreenVisit()
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
  // Leaflet may still be loading: a focus requested by the previous account
  // must not land after an account transition.
  const generation = currentAccountGeneration()
  const module = await ensureMapModule()
  if (generation !== currentAccountGeneration()) return undefined
  return module.focusObservationOnMap(target)
}

/**
 * Open the map in location-picker mode. `onSave` runs only when the user
 * confirms; cancelling reports nothing.
 *
 * @param {{ lat?: unknown, lon?: unknown, onSave: (coords: { lat: number, lon: number }) => unknown }} options
 */
export async function openMapLocationPickerScreen(options) {
  // Same as focus: never open the previous account's picker (its coordinate
  // and save callback) after an account transition.
  const generation = currentAccountGeneration()
  const module = await ensureMapModule()
  if (generation !== currentAccountGeneration()) return undefined
  return module.openMapLocationPicker(options)
}
