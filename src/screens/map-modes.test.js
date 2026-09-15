// The map screen's non-browsing modes: "focus this Find" and "pick a
// location". Both run on the same Leaflet instance as ordinary browsing, so
// what needs proving is that each one owns the viewport instead of the usual
// fit-to-all-markers, and that the picker writes nothing until confirmed.
//
// This lives in its own file rather than in `map.test.js` because `map.js`
// initialises once per module instance: the DOM stub the buttons are bound to
// has to survive the whole file, and `node --test` gives each file its own
// process.

import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'

import { state } from '../state.js'
import { supabase } from '../supabase.js'
import { registerCssLoader } from '../../test/register-css-loader.mjs'

registerCssLoader()

const OWN_FIND = {
  id: 501,
  user_id: 'user-1',
  gps_latitude: 63.43,
  gps_longitude: 10.39,
  genus: 'Cantharellus',
  species: 'cibarius',
  common_name: 'Chanterelle',
  date: '2026-07-13',
  location: 'Bymarka',
  uncertain: false,
  location_precision: 'exact',
}

const OTHER_FIND = {
  ...OWN_FIND,
  id: 502,
  user_id: 'user-2',
  gps_latitude: 60.39,
  gps_longitude: 5.32,
  location: 'Fløyen',
}

let observations = [OWN_FIND, OTHER_FIND]
// When set, rows are served per scope so a test can make one scope hold the
// find and the others come back empty.
let scopeResults = null

const SCOPE_BY_TABLE = {
  observations: 'mine',
  observations_friend_view: 'friends',
  observations_follow_view: 'feed',
  observations_community_view: 'public',
}

function _rowsForTable(table) {
  if (!scopeResults) return observations
  return scopeResults[SCOPE_BY_TABLE[table]] || []
}
let elements = new Map()
let mapInstances = []
let clusterGroups = []
let layerGroups = []
const restoreStack = []

function _setGlobalProperty(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  restoreStack.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

function _makeElement(id, tagName = 'div') {
  const listeners = {}
  const classes = new Set()
  return {
    id,
    tagName: tagName.toUpperCase(),
    style: { display: '' },
    dataset: {},
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force
        if (on) classes.add(name)
        else classes.delete(name)
        return on
      },
      contains: name => classes.has(name),
    },
    textContent: '',
    value: '',
    disabled: false,
    addEventListener(type, handler) { listeners[type] = handler },
    removeEventListener(type) { delete listeners[type] },
    click() { listeners.click?.({ type: 'click', stopPropagation() {} }) },
    setAttribute() {},
    getAttribute() { return null },
    removeAttribute() {},
    appendChild() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 } },
  }
}

function el(id) {
  if (!elements.has(id)) elements.set(id, _makeElement(id, id === 'camera-video' ? 'video' : 'div'))
  return elements.get(id)
}

function _makeGroup(kind) {
  return {
    kind,
    items: [],
    addTo() { return this },
    clearLayers() { this.items = []; return this },
    addLayer(item) { this.items.push(item); return this },
    removeLayer(item) { this.items = this.items.filter(entry => entry !== item); return this },
    hasLayer(item) { return this.items.includes(item) },
  }
}

function _installLeafletStub(Leaflet) {
  Leaflet.map = () => {
    const instance = {
      center: { lat: 62.5, lng: 15 },
      zoom: 5,
      setViewCalls: [],
      fitBoundsCalls: [],
      addLayer() { return this },
      removeLayer() { return this },
      hasLayer() { return false },
      getZoom() { return this.zoom },
      getCenter() { return this.center },
      setView(coords, zoom) {
        this.center = { lat: coords[0], lng: coords[1] }
        if (Number.isFinite(zoom)) this.zoom = zoom
        this.setViewCalls.push({ coords, zoom })
        return this
      },
      fitBounds(bounds, options) {
        this.fitBoundsCalls.push({ bounds, options })
        return this
      },
      on() { return this },
      invalidateSize() { return this },
    }
    mapInstances.push(instance)
    return instance
  }
  Leaflet.tileLayer = () => ({ addTo() { return this } })
  Leaflet.markerClusterGroup = () => {
    const group = _makeGroup('cluster')
    group.zoomToShowLayerCalls = []
    group.zoomToShowLayer = (marker, done) => {
      group.zoomToShowLayerCalls.push(marker)
      done?.()
    }
    clusterGroups.push(group)
    return group
  }
  Leaflet.layerGroup = () => {
    const group = _makeGroup('layer')
    layerGroups.push(group)
    return group
  }
  Leaflet.marker = (coords, options) => ({
    kind: 'marker',
    coords,
    options,
    popupOpened: 0,
    addTo(group) { group.addLayer(this); this.parentGroup = group; return this },
    bindPopup(popup) { this.popup = popup; return this },
    openPopup() { this.popupOpened += 1; return this },
    on() { return this },
  })
  Leaflet.circle = (coords, options) => ({
    kind: 'circle',
    coords,
    options,
    addTo(group) { group.addLayer(this); this.parentGroup = group; return this },
  })
  Leaflet.divIcon = options => ({ kind: 'divIcon', ...options })
  Leaflet.popup = options => ({
    kind: 'popup',
    options,
    setContent(content) { this.content = content; return this },
  })
  Leaflet.latLngBounds = (...args) => ({ kind: 'bounds', args })
}

const activeMap = () => mapInstances[mapInstances.length - 1]
const pickerLayer = () => layerGroups[layerGroups.length - 1]
const clusterLayer = () => clusterGroups[clusterGroups.length - 1]

let mapModule = null
let loadMapScreen = null
let loadMap = null

before(async () => {
  const window = {
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail }
    },
    screen: { deviceXDPI: 1, logicalXDPI: 1 },
    devicePixelRatio: 1,
    navigator: { userAgent: 'node', platform: 'Linux x86_64' },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
  }
  const document = {
    documentElement: { style: {} },
    hidden: false,
    visibilityState: 'visible',
    getElementById: el,
    createElement: tagName => _makeElement(`auto-${tagName}-${elements.size}`, tagName),
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
  }
  _setGlobalProperty('window', window)
  _setGlobalProperty('document', document)
  _setGlobalProperty('navigator', window.navigator)
  _setGlobalProperty('CustomEvent', window.CustomEvent)
  _setGlobalProperty('requestAnimationFrame', fn => { fn(); return 1 })
  _setGlobalProperty('cancelAnimationFrame', () => {})

  const originalFrom = supabase.from
  supabase.from = table => {
    const chain = {
      select() { return chain },
      eq() { return chain },
      neq() { return chain },
      not() { return chain },
      gte() { return chain },
      then(resolve) { resolve({ data: _rowsForTable(table), error: null }) },
    }
    return chain
  }
  restoreStack.push(() => { supabase.from = originalFrom })

  const { default: Leaflet } = await import('leaflet')
  // `leaflet.markercluster`, which `map.js` pulls in, is a plain script that
  // reads the global `L` at load time and then installs the real
  // `markerClusterGroup` on it — so `map.js` has to be imported before the
  // stub goes in, or the plugin overwrites it.
  _setGlobalProperty('L', Leaflet)
  mapModule = await import('./map.js')
  _installLeafletStub(Leaflet)

  state.user = { id: 'user-1' }
  state.observationScope = 'mine'
  state.mapTimeScope = 'month'
  state.searchQuery = ''

  // Initialise through the loader, the same seam the router and the Find
  // detail screen use, so `initMap()` runs exactly once for this file.
  ;({ loadMapScreen } = await import('../map-loader.js'))
  ;({ loadMap } = mapModule)
  await loadMapScreen()
})

after(() => {
  while (restoreStack.length) {
    try { restoreStack.pop()() } catch {}
  }
})

// Settle the router's unawaited `void loadMapScreen()` before asserting.
async function _settle() {
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

test('the scopes a focus target could live in start from who owns it', () => {
  const { resolveMapFocusScopes } = mapModule

  assert.deepEqual(
    resolveMapFocusScopes({ ownerId: 'user-1' }, 'user-1'),
    ['mine'],
    'the viewer\'s own find is only ever in the "mine" scope',
  )
  // Someone else's find: the map does not know which of its scopes can load
  // it, so it gets an ordered list to walk rather than one guess.
  assert.deepEqual(resolveMapFocusScopes({ ownerId: 'user-2' }, 'user-1'), ['friends', 'public', 'feed'])
  assert.deepEqual(resolveMapFocusScopes({}, null), ['friends', 'public', 'feed'])
})

test('focusing a find selects its marker instead of fitting the map to every marker', async () => {
  const { focusObservationOnMap } = mapModule
  state.observationScope = 'public'
  state.mapTimeScope = 'month'
  state.searchQuery = 'Amanita'
  // The map has already been browsed once in `before()`, so count from here.
  const fitsBefore = activeMap().fitBoundsCalls.length
  clusterLayer().zoomToShowLayerCalls.length = 0

  focusObservationOnMap({ id: OWN_FIND.id, lat: OWN_FIND.gps_latitude, lon: OWN_FIND.gps_longitude, ownerId: 'user-1' })
  await _settle()

  assert.equal(state.observationScope, 'mine', 'the map switched to the scope holding the find')
  assert.equal(state.mapTimeScope, 'all')
  assert.equal(state.searchQuery, '', 'a leftover search must not filter the focused find away')

  const opened = clusterLayer().zoomToShowLayerCalls
  assert.equal(opened.length, 1, 'the focused marker was un-clustered and selected')
  assert.deepEqual(opened[0].coords, [OWN_FIND.gps_latitude, OWN_FIND.gps_longitude])
  assert.equal(opened[0].popupOpened, 1, 'its popup was opened')
  assert.equal(activeMap().fitBoundsCalls.length, fitsBefore, 'focus owns the viewport, so no fit-to-all')
})

// Opening a friend's or a stranger's find from its detail screen must switch
// the map's own scope filter to one that can actually load it — otherwise the
// map arrives on "Mine" and the find is simply not there.
test('focusing someone else\'s find walks the scope filter until the find is loadable', async () => {
  const { focusObservationOnMap } = mapModule
  state.observationScope = 'mine'
  clusterLayer().zoomToShowLayerCalls.length = 0

  // Only the "public" scope returns this find; "friends" comes back empty.
  scopeResults = { friends: [], public: [OTHER_FIND], feed: [], mine: [] }
  try {
    focusObservationOnMap({
      id: OTHER_FIND.id,
      lat: OTHER_FIND.gps_latitude,
      lon: OTHER_FIND.gps_longitude,
      ownerId: 'user-2',
    })
    await _settle()

    assert.equal(state.observationScope, 'public', 'the map filter moved to the scope holding the find')
    const opened = clusterLayer().zoomToShowLayerCalls
    assert.equal(opened.length, 1, 'the find was found and selected after the switch')
    assert.deepEqual(opened[0].coords, [OTHER_FIND.gps_latitude, OTHER_FIND.gps_longitude])
  } finally {
    scopeResults = null
  }
})

test('focusing a find no scope can load still centres on the coordinates the viewer already had', async () => {
  const { focusObservationOnMap } = mapModule
  const before = activeMap().setViewCalls.length
  const fitsBefore = activeMap().fitBoundsCalls.length
  clusterLayer().zoomToShowLayerCalls.length = 0

  focusObservationOnMap({ id: 9999, lat: 59.91, lon: 10.75, ownerId: 'user-2' })
  await _settle()

  assert.equal(clusterLayer().zoomToShowLayerCalls.length, 0, 'there was no marker to select')
  const last = activeMap().setViewCalls.at(-1)
  assert.ok(activeMap().setViewCalls.length > before)
  assert.deepEqual(last.coords, [59.91, 10.75])
  assert.equal(activeMap().fitBoundsCalls.length, fitsBefore)
})

// Arriving on the map from a Find used to be a one-way trip: the map screen
// has no back control of its own.
test('a focused map offers a way back to the find, and drops it on a later plain visit', async () => {
  const { focusObservationOnMap, beginMapScreenVisit } = mapModule
  state.observationScope = 'mine'

  focusObservationOnMap({ id: OWN_FIND.id, lat: OWN_FIND.gps_latitude, lon: OWN_FIND.gps_longitude, ownerId: 'user-1' })
  await _settle()
  assert.equal(el('map-focus-bar').style.display, 'flex', 'the back control is offered while focused')

  // Changing a map filter reloads the map but must not strand the user.
  await loadMap()
  assert.equal(el('map-focus-bar').style.display, 'flex', 'a filter change keeps the way back')

  el('map-focus-back-btn').click()
  await _settle()
  assert.equal(el('map-focus-bar').style.display, 'none', 'taking the way back retires it')

  // Reaching the map the ordinary way afterwards must not resurrect it.
  focusObservationOnMap({ id: OWN_FIND.id, lat: OWN_FIND.gps_latitude, lon: OWN_FIND.gps_longitude, ownerId: 'user-1' })
  await _settle()
  assert.equal(el('map-focus-bar').style.display, 'flex')
  beginMapScreenVisit()
  await loadMap()
  assert.equal(el('map-focus-bar').style.display, 'none', 'a fresh visit to the map is not a focused one')
})

test('the location picker starts at the find, shows the previous point, and cancels without reporting a coordinate', async () => {
  const { openMapLocationPicker, isMapLocationPickerActive } = mapModule
  const saved = []

  openMapLocationPicker({
    lat: OWN_FIND.gps_latitude,
    lon: OWN_FIND.gps_longitude,
    onSave: coords => saved.push(coords),
  })
  await _settle()

  assert.equal(isMapLocationPickerActive(), true)
  assert.deepEqual(
    activeMap().setViewCalls.at(-1).coords,
    [OWN_FIND.gps_latitude, OWN_FIND.gps_longitude],
    'the picker opens on the coordinates the find already has',
  )
  assert.ok(
    clusterLayer().items.every(marker => marker.options.interactive === false),
    'the other finds are context only while picking, not tappable routes off the screen',
  )
  const previous = pickerLayer().items
  assert.equal(previous.length, 1, 'the previous location is drawn as its own subdued marker')
  assert.deepEqual(previous[0].coords, [OWN_FIND.gps_latitude, OWN_FIND.gps_longitude])
  assert.equal(previous[0].options.interactive, false)
  assert.equal(el('map-picker-bar').style.display, 'flex')
  assert.equal(el('map-picker-crosshair').style.display, 'block')
  assert.equal(el('bottom-nav').style.display, 'none', 'Cancel and Save are the only ways out while picking')

  // Panning alone must change nothing.
  activeMap().center = { lat: 63.5, lng: 10.5 }
  el('map-picker-cancel-btn').click()
  await _settle()

  assert.deepEqual(saved, [], 'cancelling reports no coordinate')
  assert.equal(isMapLocationPickerActive(), false)
  assert.equal(el('map-picker-bar').style.display, 'none')
  assert.notEqual(el('bottom-nav').style.display, 'none', 'the browse chrome came back')
  assert.equal(pickerLayer().items.length, 0, 'the previous-location marker was cleared')
})

test('saving the picker reports the viewport centre, not the point it started from', async () => {
  const { openMapLocationPicker, isMapLocationPickerActive } = mapModule
  const saved = []

  openMapLocationPicker({
    lat: OWN_FIND.gps_latitude,
    lon: OWN_FIND.gps_longitude,
    onSave: coords => saved.push(coords),
  })
  await _settle()

  // The user pans the map under the fixed crosshair: the photo was taken at
  // home, the mushroom was found up the hill.
  activeMap().center = { lat: 63.441122, lng: 10.401234 }
  el('map-picker-save-btn').click()
  await _settle()

  assert.deepEqual(saved, [{ lat: 63.441122, lon: 10.401234 }])
  assert.equal(isMapLocationPickerActive(), false)
  assert.equal(el('map-picker-bar').style.display, 'none')
})

test('a find with no coordinates opens the picker without a previous-location marker', async () => {
  const { openMapLocationPicker } = mapModule
  const saved = []

  openMapLocationPicker({ lat: null, lon: null, onSave: coords => saved.push(coords) })
  await _settle()

  assert.equal(pickerLayer().items.length, 0, 'there is no previous point to show')
  activeMap().center = { lat: 58.97, lng: 5.73 }
  el('map-picker-save-btn').click()
  await _settle()

  assert.deepEqual(saved, [{ lat: 58.97, lon: 5.73 }])
})
