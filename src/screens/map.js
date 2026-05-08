import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '../supabase.js'
import { formatDate, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { formatDisplayName, formatScientificName } from '../artsorakel.js'
import { navigate } from '../router.js'
import { openFindDetail } from './find_detail.js'
import { esc as _esc } from '../esc.js'

let map          = null
let markerLayer  = null
let currentScope = 'mine'
const _mapData   = { mine: [], friends: [], feed: [], public: [] }   // cached for re-filtering

// ── Init (once at boot) ───────────────────────────────────────────────────────

export function initMap() {
  map = L.map('map-container', { zoomControl: false, attributionControl: true })

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map)

  markerLayer = L.layerGroup().addTo(map)
  map.setView([62.5, 15], 5)

  // Scope toggle
  document.querySelectorAll('.map-scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-scope-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      currentScope = btn.dataset.scope
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
    const { data } = await supabase
      .from('observations')
      .select('id, user_id, gps_latitude, gps_longitude, genus, species, common_name, date, location, uncertain')
      .eq('user_id', state.user.id)
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)
    _mapData.mine    = data || []
    _mapData.friends = []
    _mapData.feed    = []
    _mapData.public  = []

  } else if (currentScope === 'friends') {
    const { data } = await supabase
      .from('observations_friend_view')
      .select('id, user_id, gps_latitude, gps_longitude, genus, species, common_name, date, location, uncertain')
      .neq('user_id', state.user.id)
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)
    _mapData.mine    = []
    _mapData.friends = data || []
    _mapData.feed    = []
    _mapData.public  = []

  } else if (currentScope === 'feed') {
    const { data } = await supabase
      .from('observations_follow_view')
      .select('id, user_id, gps_latitude, gps_longitude, genus, species, common_name, date, location, uncertain')
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)
    _mapData.feed = data || []
  } else if (currentScope === 'public') {
    const { data } = await supabase
      .from('observations_community_view')
      .select('id, user_id, gps_latitude, gps_longitude, genus, species, common_name, date, location, uncertain')
      .not('gps_latitude', 'is', null)
      .not('gps_longitude', 'is', null)
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
  const q = (state.searchQuery || '').toLowerCase().trim()

  const data = _mapData[currentScope] || []
  const filtered = q ? data.filter(o => _matchesMap(o, q)) : data
  _addMarkers(filtered)

  // Fit bounds
  const allLayers = []
  markerLayer.eachLayer(l => allLayers.push(l))
  if (!allLayers.length) {
    if (state.gps) map.setView([state.gps.lat, state.gps.lon], 13)
    return
  }
  const latlngs = allLayers.map(l => l.getLatLng())
  if (latlngs.length === 1) {
    map.setView(latlngs[0], 14)
  } else {
    map.fitBounds(L.latLngBounds(latlngs), { padding: [50, 50], maxZoom: 15 })
  }
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
  })
}
