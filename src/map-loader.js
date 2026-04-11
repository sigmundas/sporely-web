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
