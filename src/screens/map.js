import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import { supabase } from '../supabase.js'
import { formatDate, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { formatDisplayName, formatScientificName } from '../artsorakel.js'
import { navigate } from '../router.js'
import { openFindDetail } from './find_detail.js'
import { esc as _esc } from '../esc.js'

let map          = null
let markerLayer  = null
let fuzzedCircleLayer = null
let locationLayer = null
const _mapData   = { mine: [], friends: [], feed: [], public: [] }   // cached for re-filtering
const OBSERVATION_SCOPES = new Set(['mine', 'feed', 'friends', 'public'])
const MAP_TIME_SCOPES = new Set(['all', 'day', 'week', 'month'])
const MAP_SELECT = 'id, user_id, gps_latitude, gps_longitude, genus, species, common_name, date, location, uncertain, location_precision'
const MAP_SELECT_LEGACY = 'id, user_id, gps_latitude, gps_longitude, genus, species, common_name, date, location, uncertain'

function _normalizeScope(scope) {
  if (scope === 'community') return 'public'
  return OBSERVATION_SCOPES.has(scope) ? scope : 'mine'
}

function _currentScope() {
  return _normalizeScope(state.observationScope)
}

function _normalizeTimeScope(scope) {
  return MAP_TIME_SCOPES.has(scope) ? scope : 'month'
}

function _currentTimeScope() {
  return _normalizeTimeScope(state.mapTimeScope)
}

function _syncMapScopeBtns() {
  const currentScope = _currentScope()
  document.querySelectorAll('.map-scope-btn').forEach(btn => {
    btn.classList.toggle('active', _normalizeScope(btn.dataset.scope) === currentScope)
  })
}

function _syncMapTimeBtns() {
  const currentTimeScope = _currentTimeScope()
  document.querySelectorAll('.map-time-btn').forEach(btn => {
    btn.classList.toggle('active', _normalizeTimeScope(btn.dataset.time) === currentTimeScope)
  })
}

function _timeFilterCutoff() {
  const now = Date.now()
  switch (_currentTimeScope()) {
    case 'all':
      return null
    case 'day':
      return new Date(now - 24 * 60 * 60 * 1000)
    case 'week':
      return new Date(now - 7 * 24 * 60 * 60 * 1000)
    case 'month':
      return new Date(now - 30 * 24 * 60 * 60 * 1000)
    default:
      return null
  }
}

function _applyTimeFilter(query) {
  const cutoff = _timeFilterCutoff()
  return cutoff ? query.gte('date', _dateOnlyString(cutoff)) : query
}

function _dateOnlyString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function _hasValidLocation() {
  return Number.isFinite(state.gps?.lat) && Number.isFinite(state.gps?.lon)
}

function _syncLocationBtn() {
  const btn = document.getElementById('map-locate-btn')
  if (!btn) return
  const label = t('detail.currentLocation')
  btn.setAttribute('aria-label', label)
  btn.title = label
  btn.disabled = !_hasValidLocation()
}

function _currentLocationBounds() {
  if (!_hasValidLocation()) return null

  const lat = state.gps.lat
  const lon = state.gps.lon
  const latDelta = 1_000 / 111_320
  const lonDelta = 1_000 / (111_320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
  return L.latLngBounds(
    [lat - latDelta, lon - lonDelta],
    [lat + latDelta, lon + lonDelta],
  )
}

function _centerOnCurrentLocation() {
  const bounds = _currentLocationBounds()
  if (!bounds || !map) return
  map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 })
}

function _syncFuzzedCircleVisibility() {
  if (!map || !fuzzedCircleLayer) return
  const shouldShow = map.getZoom() >= 13
  if (shouldShow && !map.hasLayer(fuzzedCircleLayer)) {
    fuzzedCircleLayer.addTo(map)
  } else if (!shouldShow && map.hasLayer(fuzzedCircleLayer)) {
    map.removeLayer(fuzzedCircleLayer)
  }
}

function _renderCurrentLocation() {
  if (!locationLayer) return
  locationLayer.clearLayers()
  _syncLocationBtn()
  if (!_hasValidLocation()) return

  const { lat, lon, accuracy } = state.gps
  const icon = L.divIcon({
    className: '',
    html: `
      <div class="map-location-marker">
        <span class="map-location-marker__halo" aria-hidden="true"></span>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.18 7 13 7 13s7-7.82 7-13c0-3.87-3.13-7-7-7Zm0 9.25A2.25 2.25 0 1 1 12 6.75a2.25 2.25 0 0 1 0 4.5Z" fill="currentColor"/>
        </svg>
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 31],
    popupAnchor: [0, -18],
  })

  L.marker([lat, lon], { icon, interactive: false }).addTo(locationLayer)

  if (Number.isFinite(accuracy) && accuracy > 0) {
    L.circle([lat, lon], {
      radius: accuracy,
      className: 'map-location-accuracy',
      color: '#8fc8ff',
      fillColor: '#8fc8ff',
      fillOpacity: 0.12,
      opacity: 0.4,
      weight: 1,
    }).addTo(locationLayer)
  }
}

async function _withLocationPrecisionFallback(makeQuery) {
  const result = await makeQuery(MAP_SELECT)
  if (String(result.error?.message || '').toLowerCase().includes('location_precision')) {
    return makeQuery(MAP_SELECT_LEGACY)
  }
  return result
}

// ── Init (once at boot) ───────────────────────────────────────────────────────

export function initMap() {
  map = L.map('map-container', { zoomControl: false, attributionControl: true })

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)

  markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 15,
    maxClusterRadius: zoom => zoom < 8 ? 70 : zoom < 12 ? 50 : 35,
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount()
      const sizeClass =
        count < 10 ? 'map-cluster--small'
        : count < 100 ? 'map-cluster--medium'
        : 'map-cluster--large'

      return L.divIcon({
        className: '',
        html: `<div class="map-cluster ${sizeClass}">${count}</div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      })
    },
  }).addTo(map)
  fuzzedCircleLayer = L.layerGroup().addTo(map)
  locationLayer = L.layerGroup().addTo(map)
  map.setView([62.5, 15], 5)
  map.on('zoomend', _syncFuzzedCircleVisibility)
  _syncFuzzedCircleVisibility()

  document.getElementById('map-locate-btn')?.addEventListener('click', _centerOnCurrentLocation)
  window.addEventListener('sporely:gps-updated', _renderCurrentLocation)

  // Scope toggle
  document.querySelectorAll('.map-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.observationScope = _normalizeScope(btn.dataset.scope)
      _syncMapScopeBtns()
      loadMap()
    })
  })

  document.querySelectorAll('.map-time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mapTimeScope = _normalizeTimeScope(btn.dataset.time)
      _syncMapTimeBtns()
      loadMap()
    })
  })

  // Search input with species autocomplete
  const searchInput = document.getElementById('map-search-input')
  const clearBtn    = document.getElementById('map-search-clear')
  const dropdown    = document.getElementById('map-search-dropdown')
  let _searchDebounce = null

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value
    clearBtn.style.display = state.searchQuery ? 'flex' : 'none'
    _applyMapFilter()

    clearTimeout(_searchDebounce)
    const q = searchInput.value.trim()
    if (q.length < 2) { dropdown.style.display = 'none'; return }
    _searchDebounce = setTimeout(async () => {
      const results = _getMapAutocompleteSuggestions(q)
      if (!results.length || searchInput.value.trim() !== q) { dropdown.style.display = 'none'; return }
      dropdown.innerHTML = results.map(r =>
        `<li data-name="${_esc(r.queryValue)}">${_esc(r.displayName)}${r.meta ? `<span class="taxon-family">${_esc(r.meta)}</span>` : ''}</li>`
      ).join('')
      dropdown.style.display = 'block'
      dropdown.querySelectorAll('li').forEach(li => {
        li.addEventListener('mousedown', () => {
          searchInput.value = li.dataset.name
          state.searchQuery = li.dataset.name
          clearBtn.style.display = 'flex'
          dropdown.style.display = 'none'
          _applyMapFilter()
        })
      })
    }, 280)
  })

  searchInput.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none' }, 150)
  })

  clearBtn.addEventListener('click', () => {
    searchInput.value = ''
    state.searchQuery = ''
    clearBtn.style.display = 'none'
    dropdown.style.display = 'none'
    _applyMapFilter()
  })
}

// ── Load (called on navigate) ─────────────────────────────────────────────────

export async function loadMap() {
  requestAnimationFrame(() => map?.invalidateSize())
  if (!state.user) return
  const currentScope = _currentScope()
  _syncMapScopeBtns()
  _syncMapTimeBtns()
  _syncLocationBtn()

  // Pre-fill search from shared state
  const searchInput = document.getElementById('map-search-input')
  const clearBtn    = document.getElementById('map-search-clear')
  if (searchInput) {
    searchInput.value = state.searchQuery || ''
    if (clearBtn) clearBtn.style.display = state.searchQuery ? 'flex' : 'none'
  }

  document.querySelectorAll('.map-scope-btn[data-scope="mine"]').forEach(el => el.textContent = t('scope.mine'))
  document.querySelectorAll('.map-scope-btn[data-scope="feed"]').forEach(el => el.textContent = t('scope.feed'))
  document.querySelectorAll('.map-scope-btn[data-scope="friends"]').forEach(el => el.textContent = t('scope.friends'))
  document.querySelectorAll('.map-scope-btn[data-scope="public"]').forEach(el => el.textContent = t('scope.community'))

  if (currentScope === 'mine') {
    const { data } = await _withLocationPrecisionFallback(columns => _applyTimeFilter(supabase
      .from('observations')
      .select(columns)
      .eq('user_id', state.user.id)
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)))
    _mapData.mine    = data || []
    _mapData.friends = []
    _mapData.feed    = []
    _mapData.public  = []

  } else if (currentScope === 'friends') {
    const { data } = await _withLocationPrecisionFallback(columns => _applyTimeFilter(supabase
      .from('observations_friend_view')
      .select(columns)
      .neq('user_id', state.user.id)
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)))
    _mapData.mine    = []
    _mapData.friends = data || []
    _mapData.feed    = []
    _mapData.public  = []

  } else if (currentScope === 'feed') {
    const { data } = await _withLocationPrecisionFallback(columns => _applyTimeFilter(supabase
      .from('observations_follow_view')
      .select(columns)
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)))
    _mapData.feed = data || []
  } else if (currentScope === 'public') {
    const { data } = await _withLocationPrecisionFallback(columns => _applyTimeFilter(supabase
      .from('observations_community_view')
      .select(columns)
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)))
    _mapData.public = data || []
  } else {
    _mapData.mine    = []
    _mapData.friends = []
    _mapData.feed    = []
    _mapData.public  = []
  }

  _applyMapFilter()
}

// ── Filter + render markers ───────────────────────────────────────────────────

function _mapSearchPool() {
  const currentScope = _currentScope()
  return _mapData[currentScope] || []
}

function _displayNameForObservation(obs) {
  return formatDisplayName(obs.genus || '', obs.species || '', obs.common_name || '')
}

function _getMapAutocompleteSuggestions(query) {
  const q = String(query || '').trim().toLowerCase()
  if (q.length < 2) return []

  const ranked = new Map()
  for (const obs of _mapSearchPool()) {
    const scientificName = formatScientificName(obs.genus || '', obs.species || '')
    const commonName = String(obs.common_name || '').trim()
    const haystacks = [scientificName, commonName].filter(Boolean)
    if (!haystacks.length || !haystacks.some(text => text.toLowerCase().includes(q))) continue

    const key = scientificName.toLowerCase() || commonName.toLowerCase()
    const existing = ranked.get(key) || {
      queryValue: scientificName || commonName,
      displayName: _displayNameForObservation(obs) || scientificName || commonName,
      count: 0,
    }
    existing.count += 1
    ranked.set(key, existing)
  }

  return Array.from(ranked.values())
    .sort((a, b) =>
      b.count - a.count
      || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    )
    .slice(0, 12)
    .map(item => ({
      ...item,
      meta: tp('finds.observationCount', item.count).replace(/\.$/, ''),
    }))
}

function _matchesMap(obs, q) {
  return [obs.common_name, obs.genus, obs.species, obs.location]
    .some(f => f && f.toLowerCase().includes(q))
}

function _applyMapFilter() {
  markerLayer.clearLayers()
  fuzzedCircleLayer?.clearLayers()
  const q = (state.searchQuery || '').toLowerCase().trim()
  const currentScope = _currentScope()

  const data = _mapData[currentScope] || []
  const filtered = q ? data.filter(o => _matchesMap(o, q)) : data
  _addMarkers(filtered)
  _renderCurrentLocation()
  _syncFuzzedCircleVisibility()

  // Fit bounds
  const latlngs = filtered
    .map(o => [o.gps_latitude, o.gps_longitude])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))

  if (!latlngs.length) {
    const bounds = _currentLocationBounds()
    if (bounds) {
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 })
    }
    _syncFuzzedCircleVisibility()
    return
  }
  if (latlngs.length === 1) {
    map.setView(latlngs[0], 14)
  } else {
    map.fitBounds(L.latLngBounds(latlngs), { padding: [50, 50], maxZoom: 15 })
  }
  _syncFuzzedCircleVisibility()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _addMarkers(observations) {
  observations.forEach(obs => {
    const name = formatDisplayName(obs.genus || '', obs.species || '', obs.common_name || '')
      || t('detail.unknownSpecies')
    const date = obs.date
      ? formatDate(obs.date, { day: 'numeric', month: 'short', year: 'numeric' })
      : ''

    const isOwn = obs.user_id === state.user?.id
    const pinClass = [
      'map-pin',
      !isOwn ? 'map-pin--friend' : '',
      obs.uncertain ? 'map-pin--uncertain' : '',
    ].filter(Boolean).join(' ')

    const icon = L.divIcon({
      className: '',
      html: `<div class="${pinClass}"></div>`,
      iconSize:    [18, 18],
      iconAnchor:  [9, 9],
      popupAnchor: [0, -12],
    })

    const popup = L.popup({ maxWidth: 220, minWidth: 160, className: 'map-popup-wrap' })
      .setContent(`
        <div class="map-popup">
          <div class="map-popup-name">${_esc(name)}</div>
          <div class="map-popup-date">${_esc(date)}</div>
          ${obs.location ? `<div class="map-popup-loc">${_esc(obs.location)}</div>` : ''}
          <button class="map-popup-btn" data-id="${obs.id}">${t('map.viewDetails')}</button>
        </div>
      `)

    const marker = L.marker([obs.gps_latitude, obs.gps_longitude], { icon }).bindPopup(popup)
    marker.on('popupopen', () => {
      const btn = document.querySelector(`.map-popup-btn[data-id="${obs.id}"]`)
      if (btn) btn.addEventListener('click', () => openFindDetail(obs.id))
    })
    marker.addTo(markerLayer)
    if (obs.location_precision === 'fuzzed') {
      L.circle([obs.gps_latitude, obs.gps_longitude], {
        radius: 600,
        className: 'map-fuzzed-circle',
        color: '#5a9e62',
        fillColor: '#5a9e62',
        fillOpacity: 0.12,
        opacity: 0.45,
        weight: 1.5,
        interactive: false,
      }).addTo(fuzzedCircleLayer)
    }
  })
}
