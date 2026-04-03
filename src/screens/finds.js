import { supabase } from '../supabase.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { fetchFirstImages } from '../images.js'
import { openFindDetail } from './find_detail.js'

let currentScope = 'mine'
const _cache = {}   // scope → array of observations

// ── Init (once at boot) ───────────────────────────────────────────────────────

export function initFinds() {
  document.getElementById('finds-fab')
    .addEventListener('click', () => navigate('capture'))

  // Search bar
  const searchBtn   = document.getElementById('finds-search-btn')
  const searchBar   = document.getElementById('finds-search-bar')
  const searchInput = document.getElementById('finds-search-input')
  const clearBtn    = document.getElementById('finds-search-clear')

  searchBtn.addEventListener('click', () => {
    const open = searchBar.classList.toggle('open')
    if (open) {
      if (state.searchQuery) searchInput.value = state.searchQuery
      searchInput.focus()
    } else {
      searchInput.value = ''
      state.searchQuery = ''
      _applyFilter()
    }
  })

  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value
    _applyFilter()
  })

  clearBtn.addEventListener('click', () => {
    searchInput.value = ''
    state.searchQuery = ''
    _applyFilter()
    searchInput.focus()
  })

  // View toggle
  document.getElementById('finds-view-cards').addEventListener('click', () => {
    state.findsView = 'cards'
    _syncViewBtns()
    _applyFilter()
  })
  document.getElementById('finds-view-tiles').addEventListener('click', () => {
    state.findsView = 'tiles'
    _syncViewBtns()
    _applyFilter()
  })

  // Scope tabs
  document.querySelectorAll('.scope-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scope-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      currentScope = btn.dataset.scope
      loadFinds()
    })
  })
}

function _syncViewBtns() {
  document.getElementById('finds-view-cards').classList.toggle('active', state.findsView === 'cards')
  document.getElementById('finds-view-tiles').classList.toggle('active', state.findsView === 'tiles')
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadFinds() {
  const list = document.getElementById('finds-list')
  if (!state.user) return

  list.innerHTML = ''

  if (currentScope === 'mine') {
    await _fetchMine()
  } else if (currentScope === 'friends') {
    await _fetchFriends()
  } else {
    await _fetchCommunity()
  }

  _applyFilter()
}

async function _fetchMine() {
  const { data, error } = await supabase
    .from('observations')
    .select('id, date, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .eq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(100)

  if (error) { showToast('Could not load finds'); _cache['mine'] = []; return }
  _cache['mine'] = data || []
}

async function _fetchFriends() {
  const { data, error } = await supabase
    .from('observations_friend_view')
    .select('id, date, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .neq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(100)

  if (error) { _cache['friends'] = []; return }
  _cache['friends'] = data || []
}

async function _fetchCommunity() {
  const { data, error } = await supabase
    .from('observations_community_view')
    .select('id, date, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .order('date', { ascending: false })
    .limit(100)

  if (error) { _cache['community'] = []; return }
  _cache['community'] = data || []
}

// ── Filter + dispatch ─────────────────────────────────────────────────────────

function _matches(obs, q) {
  return [obs.common_name, obs.genus, obs.species, obs.location, obs.notes]
    .some(f => f && f.toLowerCase().includes(q))
}

function _applyFilter() {
  const list     = document.getElementById('finds-list')
  const subtitle = document.getElementById('finds-subtitle')
  const raw  = _cache[currentScope] || []
  const q    = (state.searchQuery || '').toLowerCase().trim()
  const data = q ? raw.filter(obs => _matches(obs, q)) : raw

  if (state.findsView === 'tiles') {
    _renderTiles(list, subtitle, data)
  } else {
    _renderCards(list, subtitle, data, currentScope === 'friends')
  }
}

// ── Render: tiles ─────────────────────────────────────────────────────────────

function _renderTiles(list, subtitle, data) {
  if (!data.length) {
    const q = state.searchQuery
    subtitle.textContent = q
      ? `No results for "${q}".`
      : currentScope === 'friends' ? 'No friends\' finds yet.' : 'No observations yet.'
    list.innerHTML = ''
    return
  }

  subtitle.textContent = `${data.length} specimen${data.length !== 1 ? 's' : ''}.`

  fetchFirstImages(data.map(o => o.id)).then(imageUrls => {
    let html = '<div class="find-tiles-grid">'
    data.forEach(obs => {
      const name = obs.common_name
        || (obs.genus && obs.species ? `${obs.genus} ${obs.species}` : obs.genus)
        || '?'
      const imgUrl = imageUrls[obs.id]
      const photo  = imgUrl
        ? `<img src="${imgUrl}" loading="lazy" alt="">`
        : `<div class="find-tile-empty">🍄</div>`
      html += `<div class="find-tile" data-id="${obs.id}">
        <div class="find-tile-photo">${photo}</div>
        <div class="find-tile-name">${name}</div>
      </div>`
    })
    html += '</div>'
    list.innerHTML = html

    list.querySelectorAll('.find-tile[data-id]').forEach(tile => {
      tile.addEventListener('click', () => openFindDetail(tile.dataset.id))
    })
  })
}

// ── Render: cards ─────────────────────────────────────────────────────────────

function _renderCards(list, subtitle, data, isFriends) {
  if (!data.length) {
    const q = state.searchQuery
    subtitle.textContent = q
      ? `No results for "${q}".`
      : isFriends ? 'No friends\' finds yet.' : 'No observations yet — go capture some!'
    list.innerHTML = ''
    return
  }

  subtitle.textContent = `${data.length} specimen${data.length !== 1 ? 's' : ''}.`

  fetchFirstImages(data.map(o => o.id)).then(imageUrls => {
    // Group by date
    const groups = []
    const seen   = {}
    data.forEach(obs => {
      const key = obs.date || '—'
      if (!seen[key]) { seen[key] = []; groups.push({ date: key, items: seen[key] }) }
      seen[key].push(obs)
    })

    let html = '<div class="finds-grid-outer">'
    groups.forEach(({ date, items }) => {
      const dateLabel = date !== '—'
        ? new Date(date + 'T12:00:00').toLocaleDateString('no-NO', { day: 'numeric', month: 'long', year: 'numeric' })
        : '—'
      html += `<div class="finds-date-sep">
        <div class="finds-date-line"></div>
        <span class="finds-date-label">${dateLabel}</span>
        <div class="finds-date-line"></div>
      </div>
      <div class="finds-grid">`

      items.forEach(obs => {
        const latin     = obs.genus && obs.species ? `${obs.genus} ${obs.species}` : obs.genus
        const isUnknown = !obs.genus && !obs.common_name
        const nameHtml  = isUnknown
          ? `<span class="find-card-name unidentified">Unidentified</span>`
          : obs.common_name && latin
            ? `<span class="find-card-name">${obs.common_name} &mdash; <em class="find-card-scientific">${latin}</em></span>`
            : obs.common_name
              ? `<span class="find-card-name">${obs.common_name}</span>`
              : `<span class="find-card-name"><em class="find-card-scientific">${latin}</em></span>`

        const loc = obs.location || (
          obs.gps_latitude && obs.gps_longitude
            ? `${obs.gps_latitude.toFixed(3)}° N, ${obs.gps_longitude.toFixed(3)}° E`
            : null
        )

        const visIcon = obs.visibility === 'private'
          ? `<svg class="find-card-vis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
          : obs.visibility === 'friends'
            ? `<svg class="find-card-vis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
            : ''

        const imgUrl     = imageUrls[obs.id]
        const photoInner = imgUrl
          ? `<img src="${imgUrl}" loading="lazy" alt="">`
          : `<div class="find-card-photo-placeholder">🍄</div>`

        html += `<div class="find-card-wrap">
          <div class="find-card" data-id="${obs.id}">
            <div class="find-card-photo-wrap">${photoInner}</div>
            <div class="find-card-body">
              ${nameHtml}
              ${loc || visIcon ? `<div class="find-card-loc">
                ${loc ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                <span class="find-card-loc-text">${loc}</span>` : '<span></span>'}
                ${visIcon}
              </div>` : ''}
            </div>
          </div>
        </div>`
      })

      html += '</div>'
    })
    html += '</div>'
    list.innerHTML = html

    list.querySelectorAll('.find-card[data-id]').forEach(card => {
      card.addEventListener('click', () => openFindDetail(card.dataset.id))
    })
  })
}
