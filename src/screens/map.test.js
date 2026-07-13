import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { state } from '../state.js'
import { LOCATION_STATE_CHANGED_EVENT } from '../geo.js'
import { supabase } from '../supabase.js'

const defaultLocationState = () => ({
  preference: 'ask',
  capability: 'unknown',
  permission: 'unknown',
  status: 'idle',
  fix: null,
  error: null,
  watchId: null,
})

const defaultCaptureSessionLocationState = () => ({
  fix: null,
  sessionStartAt: null,
  requestingFreshFix: false,
})

let restoreStack = []

function _setGlobalProperty(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  restoreStack.push(() => {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
      return
    }
    Reflect.deleteProperty(globalThis, name)
  })
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

function _restoreGlobals() {
  while (restoreStack.length) {
    const restore = restoreStack.pop()
    try {
      restore()
    } catch {}
  }
}

function _resetState() {
  state.location = defaultLocationState()
  state.captureSessionLocation = defaultCaptureSessionLocationState()
  state.user = null
  state.observationScope = 'mine'
  state.searchQuery = ''
  state.mapTimeScope = 'month'
}

function _makeElement(id, tagName = 'div') {
  const listeners = {}
  return {
    id,
    tagName: tagName.toUpperCase(),
    style: { display: '' },
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false },
    },
    textContent: '',
    value: '',
    disabled: false,
    addEventListener(type, handler) {
      listeners[type] = handler
    },
    removeEventListener(type, handler) {
      if (listeners[type] === handler) delete listeners[type]
    },
    dispatchEvent(event) {
      listeners[event.type]?.(event)
      return true
    },
    setAttribute() {},
    getAttribute() {
      return null
    },
    appendChild() {},
    removeAttribute() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    closest() {
      return null
    },
    getBoundingClientRect() {
      return { width: 0, height: 0, left: 0, top: 0 }
    },
  }
}

function _installEnvironment({ observations }) {
  const elements = new Map()
  const listeners = new Map()
  const window = {
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type
        this.detail = init.detail
      }
    },
    screen: { deviceXDPI: 1, logicalXDPI: 1 },
    devicePixelRatio: 1,
    navigator: { userAgent: 'node', platform: 'Linux x86_64' },
    addEventListener(type, handler) {
      const list = listeners.get(type) || []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || []
      listeners.set(type, list.filter(entry => entry !== handler))
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) {
        handler(event)
      }
      return true
    },
  }
  const document = {
    documentElement: { style: {} },
    hidden: false,
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, _makeElement(id, id === 'camera-video' ? 'video' : 'div'))
      }
      return elements.get(id)
    },
    createElement(tagName) {
      return _makeElement(`auto-${tagName}-${elements.size}`, tagName)
    },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
    },
  }

  _setGlobalProperty('window', window)
  _setGlobalProperty('document', document)
  _setGlobalProperty('navigator', window.navigator)
  _setGlobalProperty('CustomEvent', window.CustomEvent)
  _setGlobalProperty('requestAnimationFrame', fn => {
    fn()
    return 1
  })
  _setGlobalProperty('cancelAnimationFrame', () => {})

  const originalFrom = supabase.from
  supabase.from = () => {
    const chain = {
      select() { return chain },
      eq() { return chain },
      not() { return chain },
      gte() { return chain },
      then(resolve) {
        resolve({ data: observations, error: null })
      },
    }
    return chain
  }
  restoreStack.push(() => {
    supabase.from = originalFrom
  })
}

afterEach(() => {
  _restoreGlobals()
  _resetState()
})

test('map current location uses state.location.fix and stored observations keep their own coordinates', async () => {
  const observations = [
    {
      id: 10,
      user_id: 'user-1',
      gps_latitude: 62.5,
      gps_longitude: 10.5,
      genus: 'Cantharellus',
      species: 'cibarius',
      common_name: 'Chanterelle',
      date: '2026-07-13',
      location: 'Stored location',
      uncertain: false,
      location_precision: 'exact',
    },
  ]
  _installEnvironment({ observations })

  const { default: Leaflet } = await import('leaflet')
  const clusterGroups = []
  const layerGroups = []
  const markers = []

  const makeGroup = kind => ({
    kind,
    items: [],
    addTo() { return this },
    clearLayers() {
      this.items = []
      return this
    },
    addLayer(item) {
      this.items.push(item)
      return this
    },
    removeLayer(item) {
      this.items = this.items.filter(entry => entry !== item)
      return this
    },
    hasLayer(item) {
      return this.items.includes(item)
    },
  })

  Leaflet.map = () => ({
    fitBoundsCalls: [],
    setViewCalls: [],
    addLayer() { return this },
    removeLayer() { return this },
    hasLayer() { return false },
    getZoom() { return 14 },
    fitBounds(bounds, options) {
      this.fitBoundsCalls.push({ bounds, options })
      return this
    },
    setView(coords, zoom) {
      this.setViewCalls.push({ coords, zoom })
      return this
    },
    on() { return this },
    invalidateSize() { return this },
  })
  Leaflet.tileLayer = () => ({ addTo() { return this } })
  Leaflet.markerClusterGroup = () => {
    const group = makeGroup('cluster')
    clusterGroups.push(group)
    return group
  }
  Leaflet.layerGroup = () => {
    const group = makeGroup('layer')
    layerGroups.push(group)
    return group
  }
  Leaflet.marker = (coords, options) => {
    const marker = {
      kind: 'marker',
      coords,
      options,
      popup: null,
      parentGroup: null,
      addTo(group) {
        group.addLayer(this)
        this.parentGroup = group
        return this
      },
      bindPopup(popup) {
        this.popup = popup
        return this
      },
      on() {
        return this
      },
    }
    markers.push(marker)
    return marker
  }
  Leaflet.circle = (coords, options) => ({
    kind: 'circle',
    coords,
    options,
    addTo(group) {
      group.addLayer(this)
      this.parentGroup = group
      return this
    },
  })
  Leaflet.divIcon = options => ({ kind: 'divIcon', ...options })
  Leaflet.popup = options => ({
    kind: 'popup',
    options,
    setContent(content) {
      this.content = content
      return this
    },
  })
  Leaflet.latLngBounds = (...args) => ({ kind: 'bounds', args })
  _setGlobalProperty('L', Leaflet)

  const { initMap, loadMap } = await import('./map.js')
  Leaflet.map = () => ({
    fitBoundsCalls: [],
    setViewCalls: [],
    addLayer() { return this },
    removeLayer() { return this },
    hasLayer() { return false },
    getZoom() { return 14 },
    fitBounds(bounds, options) {
      this.fitBoundsCalls.push({ bounds, options })
      return this
    },
    setView(coords, zoom) {
      this.setViewCalls.push({ coords, zoom })
      return this
    },
    on() { return this },
    invalidateSize() { return this },
  })
  Leaflet.tileLayer = () => ({ addTo() { return this } })
  Leaflet.markerClusterGroup = () => {
    const group = makeGroup('cluster')
    clusterGroups.push(group)
    return group
  }
  Leaflet.layerGroup = () => {
    const group = makeGroup('layer')
    layerGroups.push(group)
    return group
  }
  Leaflet.marker = (coords, options) => {
    const marker = {
      kind: 'marker',
      coords,
      options,
      popup: null,
      parentGroup: null,
      addTo(group) {
        group.addLayer(this)
        this.parentGroup = group
        return this
      },
      bindPopup(popup) {
        this.popup = popup
        return this
      },
      on() {
        return this
      },
    }
    markers.push(marker)
    return marker
  }
  Leaflet.circle = (coords, options) => ({
    kind: 'circle',
    coords,
    options,
    addTo(group) {
      group.addLayer(this)
      this.parentGroup = group
      return this
    },
  })
  Leaflet.divIcon = options => ({ kind: 'divIcon', ...options })
  Leaflet.popup = options => ({
    kind: 'popup',
    options,
    setContent(content) {
      this.content = content
      return this
    },
  })
  Leaflet.latLngBounds = (...args) => ({ kind: 'bounds', args })

  state.user = { id: 'user-1' }
  state.observationScope = 'mine'
  state.searchQuery = ''
  state.mapTimeScope = 'month'
  state.captureSessionLocation.fix = {
    lat: 66.1,
    lon: 11.1,
    accuracy: 9,
    altitude: 77,
    timestamp: Date.now(),
  }
  state.location.fix = null

  initMap()
  await loadMap()

  assert.equal(clusterGroups[0].items.length, 1)
  assert.deepEqual(clusterGroups[0].items[0].coords, [62.5, 10.5])
  assert.equal(layerGroups[1].items.length, 0)

  assert.doesNotThrow(() => window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT }))
  assert.equal(layerGroups[1].items.length, 0)

  state.location.fix = {
    lat: 63.2,
    lon: 10.2,
    accuracy: 5.2,
    altitude: 0,
    timestamp: Date.now(),
  }
  state.captureSessionLocation.fix = {
    lat: 67.3,
    lon: 12.3,
    accuracy: 3.1,
    altitude: 111,
    timestamp: Date.now(),
  }
  window.dispatchEvent({ type: LOCATION_STATE_CHANGED_EVENT })

  assert.equal(layerGroups[1].items.length >= 1, true)
  assert.deepEqual(layerGroups[1].items[0].coords, [63.2, 10.2])
  assert.equal(markers.length > 0, true)
})
