import { supabase } from '../supabase.js'
import { formatDate, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { fetchFirstImages } from '../images.js'
import { QUEUE_EVENT, getQueuedObservations } from '../sync-queue.js'
import { openFindDetail } from './find_detail.js'

let currentScope = 'mine'
const _cache = {}   // scope → array of observations
let _profileMap = {}

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
    _setFindsView('cards')
  })
  document.getElementById('finds-view-two').addEventListener('click', () => {
    _setFindsView('two')
  })
  document.getElementById('finds-view-three').addEventListener('click', () => {
    _setFindsView('three')
  })
  document.getElementById('finds-view-tiles').addEventListener('click', () => {
    _setFindsView('tiles')
  })

  // Scope tabs
  document.querySelectorAll('.scope-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _setScope(btn.dataset.scope)
      loadFinds()
    })
  })

  window.addEventListener(QUEUE_EVENT, () => {
    if (state.currentScreen === 'finds' && currentScope === 'mine') {
      loadFinds()
    }
  })
}

function _syncScopeTabs() {
  document.querySelectorAll('.scope-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scope === currentScope)
  })
}

function _setScope(scope, options = {}) {
  currentScope = scope || 'mine'
  _syncScopeTabs()

  if (options.resetSearch) {
    state.searchQuery = ''
    const searchInput = document.getElementById('finds-search-input')
    const searchBar = document.getElementById('finds-search-bar')
    if (searchInput) searchInput.value = ''
    if (searchBar) searchBar.classList.remove('open')
  }
}

export async function openFinds(scope = currentScope, options = {}) {
  _setScope(scope, options)
  navigate('finds')
  await loadFinds()
}

function _setFindsView(view) {
  state.findsView = view
  _syncViewBtns()
  _applyFilter()
}

function _syncViewBtns() {
  document.getElementById('finds-view-cards').classList.toggle('active', state.findsView === 'cards')
  document.getElementById('finds-view-two').classList.toggle('active', state.findsView === 'two')
  document.getElementById('finds-view-three').classList.toggle('active', state.findsView === 'three')
  document.getElementById('finds-view-tiles').classList.toggle('active', state.findsView === 'tiles')
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadFinds() {
  const list = document.getElementById('finds-list')
  if (!state.user) return

  _syncScopeTabs()
  list.innerHTML = ''

  if (currentScope === 'mine') {
    await _fetchMine()
  } else if (currentScope === 'friends') {
    await _fetchFriends()
  } else {
    await _fetchCommunity()
  }

  await _loadProfilesForScope(_cache[currentScope] || [])
  _applyFilter()
}

async function _fetchMine() {
  const { data, error } = await supabase
    .from('observations')
    .select('id, user_id, date, captured_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .eq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(100)

  if (error) { showToast(t('finds.couldNotLoad')); _cache['mine'] = []; return }

  const queued = await getQueuedObservations(state.user.id)
  const items = [...queued, ...(data || [])]
  items.sort((a, b) => _sortTs(b) - _sortTs(a))
  _cache['mine'] = items
}

async function _fetchFriends() {
  const { data, error } = await supabase
    .from('observations_friend_view')
    .select('id, user_id, date, captured_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .neq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(100)

  if (error) { _cache['friends'] = []; return }
  _cache['friends'] = data || []
}

async function _fetchCommunity() {
  const { data, error } = await supabase
    .from('observations_community_view')
    .select('id, user_id, date, captured_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .order('date', { ascending: false })
    .limit(100)

  if (error) { _cache['community'] = []; return }
  _cache['community'] = data || []
}

async function _loadProfilesForScope(data) {
  const userIds = [...new Set((data || [])
    .map(obs => obs.user_id)
    .filter(uid => uid && uid !== state.user?.id))]

  if (!userIds.length) {
    _profileMap = {}
    return
  }

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', userIds)

  if (error) {
    console.warn('Could not load observation profiles:', error.message)
    _profileMap = {}
    return
  }

  _profileMap = Object.fromEntries((profiles || []).map(profile => [profile.id, profile]))
}

// ── Filter + dispatch ─────────────────────────────────────────────────────────

function _matches(obs, q) {
  return [obs.common_name, obs.genus, obs.species, obs.location, obs.notes]
    .some(f => f && f.toLowerCase().includes(q))
}

function _sortTs(obs) {
  const primary = obs?.captured_at || obs?.date || obs?._queuedAt || 0
  const ts = new Date(primary).getTime()
  return Number.isFinite(ts) ? ts : 0
}

function _applyFilter() {
  const list     = document.getElementById('finds-list')
  const subtitle = document.getElementById('finds-subtitle')
  const raw  = _cache[currentScope] || []
  const q    = (state.searchQuery || '').toLowerCase().trim()
  const data = q ? raw.filter(obs => _matches(obs, q)) : raw

  if (state.findsView === 'tiles') {
    _renderTiles(list, subtitle, data)
  } else if (state.findsView === 'two') {
    _renderCards(list, subtitle, data, { variant: 'two', isFriends: currentScope === 'friends' })
  } else if (state.findsView === 'three') {
    _renderCards(list, subtitle, data, { variant: 'three', isFriends: currentScope === 'friends' })
  } else {
    _renderCards(list, subtitle, data, { variant: 'cards', isFriends: currentScope === 'friends' })
  }
}

function _imageHtml(source, className, placeholderClass) {
  if (!source?.primaryUrl) return `<div class="${placeholderClass}">🍄</div>`
  const fallbackAttr = source.fallbackUrl && source.fallbackUrl !== source.primaryUrl
    ? ` data-fallback-src="${source.fallbackUrl}"`
    : ''
  return `<img class="${className}" src="${source.primaryUrl}"${fallbackAttr} loading="lazy" decoding="async" alt="">`
}

function _wireImageFallback(root) {
  root.querySelectorAll('img[data-fallback-src]').forEach(img => {
    img.addEventListener('error', () => {
      const fallback = img.dataset.fallbackSrc
      if (!fallback || img.dataset.fallbackApplied === 'true') return
      img.dataset.fallbackApplied = 'true'
      img.src = fallback
    }, { once: true })
  })
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _authorProfile(obs) {
  return _profileMap[obs.user_id] || null
}

function _authorHandle(obs) {
  const profile = _authorProfile(obs)
  if (profile?.username) return `@${profile.username}`
  if (profile?.display_name) return profile.display_name
  return t('common.unknown')
}

function _authorInitial(obs) {
  const profile = _authorProfile(obs)
  const source = profile?.username || profile?.display_name || '?'
  return String(source).replace(/^@/, '').trim().charAt(0).toUpperCase() || '?'
}

function _authorChip(obs, options = {}) {
  if (obs.user_id === state.user?.id) return ''
  const profile = _authorProfile(obs)
  const sizeClass = options.sizeClass || ''
  if (profile?.avatar_url) {
    return `<div class="observation-author-chip ${sizeClass}" title="${_esc(_authorHandle(obs))}">
      <img src="${_esc(profile.avatar_url)}" alt="${_esc(_authorHandle(obs))}" loading="lazy" decoding="async">
    </div>`
  }
  return `<div class="observation-author-chip observation-author-chip--initial ${sizeClass}" title="${_esc(_authorHandle(obs))}">
    ${_esc(_authorInitial(obs))}
  </div>`
}

// ── Render: tiles ─────────────────────────────────────────────────────────────

function _renderTiles(list, subtitle, data) {
  const q = (state.searchQuery || '').trim()
  if (!data.length) {
    subtitle.textContent = q
      ? t('finds.noResults', { query: q })
      : currentScope === 'friends' ? t('finds.noFriends') : t('finds.noObservations')
    list.innerHTML = ''
    return
  }

  subtitle.textContent = tp('finds.observationCount', data.length)

  fetchFirstImages(data.filter(obs => !obs._pendingSync).map(o => o.id), { variant: 'small' }).then(imageUrls => {
    let html = '<div class="find-tiles-grid">'
    data.forEach(obs => {
      const name = obs.common_name
        || (obs.genus && obs.species ? `${obs.genus} ${obs.species}` : obs.genus)
        || t('finds.unidentified')
      const photo = _imageHtml(imageUrls[obs.id], '', 'find-tile-empty')
      html += `<div class="find-tile" data-id="${obs.id}">
        <div class="find-tile-photo">${photo}${_authorChip(obs, { sizeClass: 'observation-author-chip--tile' })}</div>
        <div class="find-tile-name">${name}</div>
      </div>`
    })
    html += '</div>'
    list.innerHTML = html

    list.querySelectorAll('.find-tile[data-id]').forEach(tile => {
      tile.addEventListener('click', () => {
        const obs = data.find(item => String(item.id) === String(tile.dataset.id))
        if (obs?._pendingSync) {
          showToast(t('finds.pendingUpload'))
          return
        }
        openFindDetail(tile.dataset.id)
      })
    })
    _wireImageFallback(list)
  })
}

// ── Render: cards ─────────────────────────────────────────────────────────────

function _renderCards(list, subtitle, data, options) {
  const variant = options?.variant || 'cards'
  const isFriends = !!options?.isFriends
  const q = (state.searchQuery || '').trim()
  if (!data.length) {
    subtitle.textContent = q
      ? t('finds.noResults', { query: q })
      : isFriends ? t('finds.noFriends') : t('finds.noObservationsCapture')
    list.innerHTML = ''
    return
  }

  subtitle.textContent = tp('finds.observationCount', data.length)

  const imageVariant = variant === 'cards' ? 'medium' : variant === 'two' ? 'medium' : 'small'
  fetchFirstImages(data.filter(obs => !obs._pendingSync).map(o => o.id), { variant: imageVariant }).then(imageUrls => {
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
        ? formatDate(new Date(date + 'T12:00:00'), { day: 'numeric', month: 'long', year: 'numeric' })
        : '—'
      html += `<div class="finds-date-sep">
        <div class="finds-date-line"></div>
        <span class="finds-date-label">${dateLabel}</span>
        <div class="finds-date-line"></div>
      </div>
      <div class="finds-grid finds-grid--${variant}">`

      items.forEach(obs => {
        const latin     = obs.genus && obs.species ? `${obs.genus} ${obs.species}` : obs.genus
        const isUnknown = !obs.genus && !obs.common_name
        const displayName = obs.common_name || latin || t('finds.unidentified')
        const nameHtml  = isUnknown
          ? `<span class="find-card-name unidentified">${t('finds.unidentified')}</span>`
          : obs.common_name && latin
            ? `<span class="find-card-name">${obs.common_name} &mdash; <em class="find-card-scientific">${latin}</em></span>`
            : obs.common_name
              ? `<span class="find-card-name">${obs.common_name}</span>`
              : `<span class="find-card-name"><em class="find-card-scientific">${latin}</em></span>`
        const compactNameHtml = isUnknown
          ? `<span class="find-card-name find-card-name--compact unidentified">${t('finds.unidentified')}</span>`
          : `<span class="find-card-name find-card-name--compact">${displayName}</span>`

        const loc = obs.location || (
          obs.gps_latitude && obs.gps_longitude
            ? `${obs.gps_latitude.toFixed(3)}° N, ${obs.gps_longitude.toFixed(3)}° E`
            : null
        )
        const authorHandle = _authorHandle(obs)
        const authorMeta = obs.user_id === state.user?.id
          ? ''
          : `<div class="find-card-author">${_esc(authorHandle)}</div>`

        const statusIcon = obs._pendingSync
          ? `<svg class="find-card-vis-icon find-card-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.8-8.62A6 6 0 0 0 5 13a4 4 0 0 0 .8 7.92H17.5"/><path d="m4 4 16 16"/></svg>`
          : obs.visibility === 'private'
            ? `<svg class="find-card-vis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
            : obs.visibility === 'friends'
              ? `<svg class="find-card-vis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
              : ''
        const locText = obs._pendingSync ? t('finds.pendingUpload') : loc

        const photoInner = _imageHtml(imageUrls[obs.id], '', 'find-card-photo-placeholder')
        const metaLead = obs._pendingSync
          ? `<span class="find-card-loc-text">${t('finds.pendingUpload')}</span>`
          : loc
            ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span class="find-card-loc-text">${loc}</span>`
            : '<span></span>'

        if (variant === 'two') {
          html += `<div class="find-card-wrap find-card-wrap--two">
            <div class="find-card find-card--two${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--two">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
              <div class="find-card-body find-card-body--two">
                ${compactNameHtml}
                ${authorMeta}
                ${locText || statusIcon ? `<div class="find-card-loc">
                  ${metaLead}
                  ${statusIcon}
                </div>` : ''}
              </div>
            </div>
          </div>`
          return
        }

        if (variant === 'three') {
          html += `<div class="find-card-wrap find-card-wrap--three">
            <div class="find-card find-card--three${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--three">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card observation-author-chip--compact' })}</div>
              <div class="find-card-body find-card-body--three">
                ${compactNameHtml}
              </div>
            </div>
          </div>`
          return
        }

        html += `<div class="find-card-wrap">
          <div class="find-card${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
            <div class="find-card-photo-wrap">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
            <div class="find-card-body">
              ${nameHtml}
              ${authorMeta}
              ${locText || statusIcon ? `<div class="find-card-loc">
                ${metaLead}
                ${statusIcon}
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
      card.addEventListener('click', () => {
        const obs = data.find(item => String(item.id) === String(card.dataset.id))
        if (obs?._pendingSync) {
          showToast(t('finds.pendingUpload'))
          return
        }
        openFindDetail(card.dataset.id)
      })
    })
    _wireImageFallback(list)
  })
}
