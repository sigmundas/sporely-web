import { supabase } from '../supabase.js'
import { formatDate, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { fetchFirstImages, fetchCardImages } from '../images.js'
import { formatScientificName } from '../artsorakel.js'
import { QUEUE_EVENT, getQueuedObservations, deleteQueuedObservation, triggerSync } from '../sync-queue.js'
import { openFindDetail } from './find_detail.js'

let currentScope = 'mine'
const _cache = {}   // scope → array of observations
let _profileMap = {}
let _pendingScrollRestore = null
const PULL_REFRESH_THRESHOLD = 72
const PULL_REFRESH_MAX = 112
const PULL_REFRESH_TOUCH_SLOP = 10
let _pullTracking = false
let _pullStartX = 0
let _pullStartY = 0
let _pullDistance = 0
let _isRefreshing = false

function _formatFingerprintCoord(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  return num.toFixed(5)
}

function _normalizeObservationText(value) {
  return String(value || '').trim().toLowerCase()
}

function _observationMatchKey(obs) {
  if (!obs) return ''
  return [
    obs.user_id || '',
    obs.source_type || '',
    obs.date || '',
    obs.genus || '',
    obs.species || '',
    obs.common_name || '',
    obs.visibility || '',
    _formatFingerprintCoord(obs.gps_latitude),
    _formatFingerprintCoord(obs.gps_longitude),
  ].join('|')
}

function _observationTimeMs(obs) {
  const raw = obs?.captured_at || obs?.created_at || obs?._queuedAt || obs?.date || 0
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function _observationsLikelySame(queuedObs, syncedObs) {
  if (!queuedObs || !syncedObs) return false
  if (queuedObs._remoteObservationId && String(queuedObs._remoteObservationId) === String(syncedObs.id)) return true
  
  if (_observationMatchKey(queuedObs) !== _observationMatchKey(syncedObs)) return false

  const queuedLocation = _normalizeObservationText(queuedObs.location)
  const syncedLocation = _normalizeObservationText(syncedObs.location)
  if (queuedLocation && syncedLocation && queuedLocation !== syncedLocation) return false

  const queuedNotes = _normalizeObservationText(queuedObs.notes)
  const syncedNotes = _normalizeObservationText(syncedObs.notes)
  if (queuedNotes && syncedNotes && queuedNotes !== syncedNotes) return false

  const queuedTime = _observationTimeMs(queuedObs)
  const syncedTime = _observationTimeMs(syncedObs)
  if (!queuedTime || !syncedTime) return true

  return Math.abs(queuedTime - syncedTime) <= 15 * 60 * 1000
}

function _setRefreshIndicator(distance = 0, stateName = 'idle') {
  const wrap = document.getElementById('finds-refresh')
  const label = document.getElementById('finds-refresh-label')
  if (!wrap || !label) return

  wrap.style.height = distance > 0 ? `${Math.round(distance)}px` : '0px'
  wrap.dataset.state = stateName
  label.textContent = t(
    stateName === 'refreshing'
      ? 'finds.refreshing'
      : stateName === 'ready'
        ? 'finds.releaseToRefresh'
        : 'finds.pullToRefresh'
  )
}

async function _refreshFindsFeed() {
  if (_isRefreshing) return
  _isRefreshing = true
  _setRefreshIndicator(56, 'refreshing')
  try {
    await triggerSync()
    await loadFinds()
  } finally {
    _isRefreshing = false
    _pullDistance = 0
    _setRefreshIndicator(0, 'idle')
  }
}

function _bindPullToRefresh() {
  const screen = document.getElementById('screen-finds')
  if (!screen || screen.dataset.pullRefreshBound === 'true') return
  screen.dataset.pullRefreshBound = 'true'

  screen.addEventListener('touchstart', event => {
    if (_isRefreshing) return
    if (event.touches.length !== 1) return
    if (screen.scrollTop > 0) return
    if (event.target.closest('input, textarea, select, button, a, label')) return
    if (event.target.closest('.finds-header, .scope-tabs, .finds-topbar, .finds-refresh')) return

    _pullTracking = true
    _pullStartX = event.touches[0].clientX
    _pullStartY = event.touches[0].clientY
    _pullDistance = 0
  }, { passive: true })

  screen.addEventListener('touchmove', event => {
    if (!_pullTracking || _isRefreshing) return
    if (screen.scrollTop > 0) {
      _pullTracking = false
      _pullDistance = 0
      _setRefreshIndicator(0, 'idle')
      return
    }

    const deltaX = event.touches[0].clientX - _pullStartX
    const deltaY = event.touches[0].clientY - _pullStartY
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      _pullTracking = false
      _pullDistance = 0
      _setRefreshIndicator(0, 'idle')
      return
    }
    if (deltaY <= 0) {
      _pullDistance = 0
      _setRefreshIndicator(0, 'idle')
      return
    }
    if (deltaY < PULL_REFRESH_TOUCH_SLOP) return

    event.preventDefault()
    _pullDistance = Math.min(PULL_REFRESH_MAX, deltaY * 0.5)
    _setRefreshIndicator(
      _pullDistance,
      _pullDistance >= PULL_REFRESH_THRESHOLD ? 'ready' : 'idle'
    )
  }, { passive: false })

  function _finishPull() {
    if (!_pullTracking) return
    _pullTracking = false
    if (_pullDistance >= PULL_REFRESH_THRESHOLD) {
      void _refreshFindsFeed()
      return
    }
    _pullDistance = 0
    _setRefreshIndicator(0, 'idle')
  }

  screen.addEventListener('touchend', _finishPull)
  screen.addEventListener('touchcancel', _finishPull)
}

// ── Init (once at boot) ───────────────────────────────────────────────────────

export function initFinds() {
  _bindPullToRefresh()
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
  // Species grouping toggle
  document.getElementById('finds-group-species').addEventListener('click', () => {
    state.findsGroupBySpecies = !state.findsGroupBySpecies
    _syncSpeciesToggle()
    _applyFilter()
  })
  document.getElementById('finds-filter-uncertain').addEventListener('click', () => {
    state.findsUncertainOnly = !state.findsUncertainOnly
    _syncUncertainToggle()
    _applyFilter()
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

function _syncSpeciesToggle() {
  document.getElementById('finds-group-species')
    ?.classList.toggle('active', !!state.findsGroupBySpecies)
}

function _syncUncertainToggle() {
  const btn = document.getElementById('finds-filter-uncertain')
  if (!btn) return
  btn.classList.toggle('active', !!state.findsUncertainOnly)
  btn.setAttribute('aria-pressed', state.findsUncertainOnly ? 'true' : 'false')
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

  if (options.groupBySpecies !== undefined) {
    state.findsGroupBySpecies = !!options.groupBySpecies
    _syncSpeciesToggle()
  }

  if (options.uncertainOnly !== undefined) {
    state.findsUncertainOnly = !!options.uncertainOnly
    _syncUncertainToggle()
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
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadFinds() {
  const list = document.getElementById('finds-list')
  if (!state.user) return

  _syncScopeTabs()
  _syncSpeciesToggle()
  _syncUncertainToggle()
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
    .select('id, user_id, date, created_at, captured_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type')
    .eq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(100)

  if (error) { showToast(t('finds.couldNotLoad')); _cache['mine'] = []; return }

  const queued = await getQueuedObservations(state.user.id)
  const synced = (data || []).filter(obs => !queued.some(queuedObs => _observationsLikelySame(queuedObs, obs)))
  const items = [...queued, ...synced]
  items.sort((a, b) => _sortTs(b) - _sortTs(a))
  _cache['mine'] = items
}

async function _fetchFriends() {
  const { data, error } = await supabase
    .from('observations_friend_view')
    .select('id, user_id, date, created_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude')
    .neq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(100)

  if (error) { 
    console.error('Failed to fetch friends feed:', error)
    _cache['friends'] = []; 
    return 
  }
  _cache['friends'] = data || []
}

async function _fetchCommunity() {
  const { data, error } = await supabase
    .from('observations_community_view')
    .select('id, user_id, date, created_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude')
    .order('date', { ascending: false })
    .limit(100)

  if (error) { 
    console.error('Failed to fetch community feed:', error)
    _cache['community'] = []; 
    return 
  }
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
  return [obs.common_name, obs.genus, obs.species, obs.location, obs.notes, obs.uncertain ? 'uncertain id' : '']
    .some(f => f && f.toLowerCase().includes(q))
}

function _sortTs(obs) {
  const primary = obs?.captured_at || obs?.created_at || obs?.date || obs?._queuedAt || 0
  const ts = new Date(primary).getTime()
  return Number.isFinite(ts) ? ts : 0
}

function _applyFilter() {
  const list     = document.getElementById('finds-list')
  const subtitle = document.getElementById('finds-subtitle')
  const raw  = _cache[currentScope] || []
  const q    = (state.searchQuery || '').toLowerCase().trim()
  const filtered = state.findsUncertainOnly ? raw.filter(obs => !!obs.uncertain) : raw
  const data = q ? filtered.filter(obs => _matches(obs, q)) : filtered

  if (state.findsGroupBySpecies) {
    _renderBySpecies(list, subtitle, data, { variant: state.findsView })
    return
  }

  if (state.findsView === 'two') {
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

function _pendingImageSource(obs) {
  if (!obs?._pendingPreviewUrl) return null
  return {
    primaryUrl: obs._pendingPreviewUrl,
    fallbackUrl: null,
  }
}

function _pendingStatusText(obs) {
  if (!obs?._pendingSync) return ''
  const total = Math.max(0, Number(obs._syncImageCount || obs._pendingPhotoCount || 0))
  const current = Math.max(1, Number(obs._syncImageIndex || 1))

  switch (obs._syncStage) {
    case 'saving-observation':
    case 'reconciling':
    case 'finalizing':
      return t('finds.pendingFinalizing')
    case 'uploading-image':
      return total > 0
        ? t('finds.pendingUploading', { current: Math.min(current, total), total })
        : t('finds.pendingUpload')
    case 'retrying':
      return t('finds.pendingRetrying')
    default:
      return t('finds.pendingUpload')
  }
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

function _deleteQueueBtn(obs) {
  if (!obs._pendingSync) return ''
  return `<button class="find-card-delete-btn" data-delete-id="${_esc(obs.id)}">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<polyline points="3 6 5 6 21 6"/>` +
    `<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>` +
    `<path d="M10 11v6"/><path d="M14 11v6"/>` +
    `<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>` +
    `</svg></button>`
}

function _wireDeleteButtons(root) {
  root.querySelectorAll('.find-card-delete-btn[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      _pendingScrollRestore = document.getElementById('screen-finds')?.scrollTop ?? null
      await deleteQueuedObservation(btn.dataset.deleteId)
      loadFinds()
    })
  })
}

function _restoreScroll() {
  if (_pendingScrollRestore === null) return
  const scroller = document.getElementById('screen-finds')
  if (scroller) scroller.scrollTop = _pendingScrollRestore
  _pendingScrollRestore = null
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

// ── Render: by species ────────────────────────────────────────────────────────

function _speciesKey(obs) {
  const genus = obs.genus || ''
  const species = obs.species || ''
  const common = obs.common_name || ''
  if (!genus && !species && !common) return '\x00unidentified'
  return `${genus}|${species}|${common}`.toLowerCase()
}

function _speciesLabel(obs) {
  const latin = formatScientificName(obs.genus || '', obs.species || '')
  const label = obs.common_name && latin ? `${obs.common_name} — ${latin}` : (obs.common_name || latin || t('finds.unidentified'))
  return obs.uncertain ? `? ${label}` : label
}

function _uncertainPrefix(obs) {
  return obs?.uncertain ? '<span class="find-card-uncertain" aria-label="Uncertain ID">?</span> ' : ''
}

function _renderBySpecies(list, subtitle, data, options = {}) {
  const variant = options.variant || 'cards'
  const q = (state.searchQuery || '').trim()
  if (!data.length) {
    subtitle.textContent = q
      ? t('finds.noResults', { query: q })
      : currentScope === 'friends' ? t('finds.noFriends') : t('finds.noObservations')
    list.innerHTML = ''
    return
  }

  // Group by species key, preserving first-seen insertion order
  const groupMap = new Map()
  for (const obs of data) {
    const key = _speciesKey(obs)
    if (!groupMap.has(key)) groupMap.set(key, { label: _speciesLabel(obs), items: [] })
    groupMap.get(key).items.push(obs)
  }

  // Sort groups: identified first (alphabetically), unidentified last
  const groups = [...groupMap.entries()]
    .sort(([ka, a], [kb, b]) => {
      if (ka === '\x00unidentified') return 1
      if (kb === '\x00unidentified') return -1
      return a.label.localeCompare(b.label)
    })

  const speciesCount = groups.filter(([k]) => k !== '\x00unidentified').length
  subtitle.textContent = `${tp('finds.observationCount', data.length)} · ${tp('finds.speciesCount', speciesCount)}`

  const allObs = groups.flatMap(([, g]) => g.items).filter(o => !o._pendingSync)
  const imageVariant = variant === 'cards' ? 'medium' : 'small'
  const imagePromise = variant === 'cards'
    ? fetchCardImages(allObs.map(o => o.id), { variant: imageVariant })
    : fetchFirstImages(allObs.map(o => o.id), { variant: imageVariant })

  imagePromise.then(imageData => {
    let html = '<div class="finds-grid-outer">'

    for (const [, group] of groups) {
      const count = group.items.length
      html += `<div class="finds-date-sep">
        <div class="finds-date-line"></div>
        <span class="finds-date-label">${_esc(group.label)}</span>
        <div class="finds-date-line"></div>
      </div>
      <div class="finds-species-meta">${tp('finds.observationCount', count)}</div>
      <div class="finds-grid finds-grid--${variant}">`

      for (const obs of group.items) {
        const latin = formatScientificName(obs.genus || '', obs.species || '')
        const isUnknown = !latin && !obs.common_name
        const displayName = obs.common_name || latin || t('finds.unidentified')
        const uncertainPrefix = _uncertainPrefix(obs)
        const nameHtml = isUnknown
          ? `<span class="find-card-name unidentified">${uncertainPrefix}${t('finds.unidentified')}</span>`
          : obs.common_name && latin
            ? `<span class="find-card-name">${uncertainPrefix}${obs.common_name} &mdash; <em class="find-card-scientific">${latin}</em></span>`
            : obs.common_name
              ? `<span class="find-card-name">${uncertainPrefix}${obs.common_name}</span>`
              : `<span class="find-card-name">${uncertainPrefix}<em class="find-card-scientific">${latin}</em></span>`
        const compactNameHtml = isUnknown
          ? `<span class="find-card-name find-card-name--compact unidentified">${uncertainPrefix}${t('finds.unidentified')}</span>`
          : `<span class="find-card-name find-card-name--compact">${uncertainPrefix}${displayName}</span>`
        const loc = obs.location || (obs.gps_latitude && obs.gps_longitude
          ? `${obs.gps_latitude.toFixed(3)}° N, ${obs.gps_longitude.toFixed(3)}° E`
          : null)
        const dateLabel = obs.date
          ? formatDate(new Date(obs.date + 'T12:00:00'), { day: 'numeric', month: 'short' })
          : '—'
        const statusIcon = obs._pendingSync
          ? `<svg class="find-card-vis-icon find-card-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.8-8.62A6 6 0 0 0 5 13a4 4 0 0 0 .8 7.92H17.5"/><path d="m4 4 16 16"/></svg>`
          : ''
        const metaLead = obs._pendingSync
          ? `<span class="find-card-loc-text">${_esc(_pendingStatusText(obs))}</span>`
          : loc
            ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span class="find-card-loc-text">${_esc(loc)}</span>`
            : `<span class="find-card-loc-text">${dateLabel}</span>`

        if (variant === 'two') {
          const photoInner = _imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--two">
            <div class="find-card find-card--two${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--two">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
              <div class="find-card-body find-card-body--two">
                ${compactNameHtml}
                <div class="find-card-loc">${metaLead}${statusIcon}${_deleteQueueBtn(obs)}</div>
              </div>
            </div>
          </div>`
          continue
        }

        if (variant === 'three') {
          const photoInner = _imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--three">
            <div class="find-card find-card--three${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--three">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card observation-author-chip--compact' })}</div>
              <div class="find-card-body find-card-body--three">
                ${compactNameHtml}
                ${obs._pendingSync ? `<div class="find-card-loc">${statusIcon}${_deleteQueueBtn(obs)}</div>` : ''}
              </div>
            </div>
          </div>`
          continue
        }

        const cardImg = imageData[obs.id]
        const photoCount = obs._pendingSync ? (obs._pendingPhotoCount || 0) : (cardImg?.count || 0)
        const countBadge = photoCount > 1
          ? `<span class="find-card-photo-count">(${photoCount})</span>`
          : ''
        const photoWrapInner = obs._pendingSync
          ? _imageHtml(_pendingImageSource(obs), '', 'find-card-photo-placeholder')
          : cardImg?.second
            ? `<div class="find-card-polaroid">
                <div class="find-card-polaroid-frame">${_imageHtml(cardImg.first, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
                <div class="find-card-polaroid-frame">${_imageHtml(cardImg.second, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
              </div>`
            : _imageHtml(cardImg?.first || cardImg, '', 'find-card-photo-placeholder')

        html += `<div class="find-card-wrap">
          <div class="find-card${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
            <div class="find-card-photo-wrap">${photoWrapInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
            <div class="find-card-body">
              <div class="find-card-name-row">${nameHtml}${countBadge}</div>
              <div class="find-card-loc">${metaLead}${statusIcon}${_deleteQueueBtn(obs)}</div>
            </div>
          </div>
        </div>`
      }

      html += '</div>'
    }

    html += '</div>'
    list.innerHTML = html
    _restoreScroll()

    list.querySelectorAll('.find-card[data-id]').forEach(card => {
      card.addEventListener('click', () => {
        const obs = data.find(item => String(item.id) === String(card.dataset.id))
        if (obs?._pendingSync) { showToast(_pendingStatusText(obs)); return }
        _pendingScrollRestore = document.getElementById('screen-finds')?.scrollTop ?? null
        openFindDetail(card.dataset.id)
      })
    })
    _wireDeleteButtons(list)
    _wireImageFallback(list)
  })
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
        || formatScientificName(obs.genus || '', obs.species || '')
        || t('finds.unidentified')
      const photo = _imageHtml(
        obs._pendingSync ? _pendingImageSource(obs) : imageUrls[obs.id],
        '',
        'find-tile-empty'
      )
      html += `<div class="find-tile" data-id="${obs.id}">
        <div class="find-tile-photo">${photo}${_authorChip(obs, { sizeClass: 'observation-author-chip--tile' })}</div>
        <div class="find-tile-name">${obs.uncertain ? '? ' : ''}${name}</div>
      </div>`
    })
    html += '</div>'
    list.innerHTML = html

    list.querySelectorAll('.find-tile[data-id]').forEach(tile => {
      tile.addEventListener('click', () => {
        const obs = data.find(item => String(item.id) === String(tile.dataset.id))
        if (obs?._pendingSync) {
          showToast(_pendingStatusText(obs))
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

  const nonPending = data.filter(obs => !obs._pendingSync).map(o => o.id)
  const imageVariant = variant === 'cards' ? 'medium' : 'small'
  const imagePromise = variant === 'cards'
    ? fetchCardImages(nonPending, { variant: imageVariant })
    : fetchFirstImages(nonPending, { variant: imageVariant })

  imagePromise.then(imageData => {
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
        const latin     = formatScientificName(obs.genus || '', obs.species || '')
        const isUnknown = !latin && !obs.common_name
        const displayName = obs.common_name || latin || t('finds.unidentified')
        const uncertainPrefix = _uncertainPrefix(obs)
        const nameHtml  = isUnknown
          ? `<span class="find-card-name unidentified">${uncertainPrefix}${t('finds.unidentified')}</span>`
          : obs.common_name && latin
            ? `<span class="find-card-name">${uncertainPrefix}${obs.common_name} &mdash; <em class="find-card-scientific">${latin}</em></span>`
            : obs.common_name
              ? `<span class="find-card-name">${uncertainPrefix}${obs.common_name}</span>`
              : `<span class="find-card-name">${uncertainPrefix}<em class="find-card-scientific">${latin}</em></span>`
        const compactNameHtml = isUnknown
          ? `<span class="find-card-name find-card-name--compact unidentified">${uncertainPrefix}${t('finds.unidentified')}</span>`
          : `<span class="find-card-name find-card-name--compact">${uncertainPrefix}${displayName}</span>`

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
        const locText = obs._pendingSync ? _pendingStatusText(obs) : loc

        const metaLead = obs._pendingSync
          ? `<span class="find-card-loc-text">${_esc(_pendingStatusText(obs))}</span>`
          : loc
            ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span class="find-card-loc-text">${loc}</span>`
            : '<span></span>'

        if (variant === 'two') {
          const photoInner = _imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--two">
            <div class="find-card find-card--two${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--two">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
              <div class="find-card-body find-card-body--two">
                ${compactNameHtml}
                ${authorMeta}
                ${locText || statusIcon ? `<div class="find-card-loc">
                  ${metaLead}
                  ${statusIcon}${_deleteQueueBtn(obs)}
                </div>` : ''}
              </div>
            </div>
          </div>`
          return
        }

        if (variant === 'three') {
          const photoInner = _imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--three">
            <div class="find-card find-card--three${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--three">${photoInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card observation-author-chip--compact' })}</div>
              <div class="find-card-body find-card-body--three">
                ${compactNameHtml}
                ${obs._pendingSync ? `<div class="find-card-loc">${statusIcon}${_deleteQueueBtn(obs)}</div>` : ''}
              </div>
            </div>
          </div>`
          return
        }

        // Single-column cards view — polaroid layout with up to 2 photos
        const cardImg = imageData[obs.id]
        const photoCount = obs._pendingSync ? (obs._pendingPhotoCount || 0) : (cardImg?.count || 0)
        const countBadge = photoCount > 1
          ? `<span class="find-card-photo-count">(${photoCount})</span>`
          : ''
        const photoWrapInner = obs._pendingSync
          ? _imageHtml(_pendingImageSource(obs), '', 'find-card-photo-placeholder')
          : cardImg?.second
            ? `<div class="find-card-polaroid">
                <div class="find-card-polaroid-frame">${_imageHtml(cardImg.first, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
                <div class="find-card-polaroid-frame">${_imageHtml(cardImg.second, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
              </div>`
            : _imageHtml(cardImg?.first || cardImg, '', 'find-card-photo-placeholder')

        html += `<div class="find-card-wrap">
          <div class="find-card${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
            <div class="find-card-photo-wrap">${photoWrapInner}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
            <div class="find-card-body">
              <div class="find-card-name-row">${nameHtml}${countBadge}</div>
              ${authorMeta}
              ${locText || statusIcon ? `<div class="find-card-loc">
                ${metaLead}
                ${statusIcon}${_deleteQueueBtn(obs)}
              </div>` : ''}
            </div>
          </div>
        </div>`
      })

      html += '</div>'
    })
    html += '</div>'
    list.innerHTML = html
    _restoreScroll()

    list.querySelectorAll('.find-card[data-id]').forEach(card => {
      card.addEventListener('click', () => {
        const obs = data.find(item => String(item.id) === String(card.dataset.id))
        if (obs?._pendingSync) {
          showToast(_pendingStatusText(obs))
          return
        }
        _pendingScrollRestore = document.getElementById('screen-finds')?.scrollTop ?? null
        openFindDetail(card.dataset.id)
      })
    })
    _wireDeleteButtons(list)
    _wireImageFallback(list)
  })
}
