import { supabase } from '../supabase.js'
import { formatDate, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { fetchFirstImages, fetchCardImages } from '../images.js'
import { formatScientificName } from '../artsorakel.js'
import {
  QUEUE_EVENT,
  IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE,
  PRIVACY_SLOT_LIMIT_USER_MESSAGE,
  deleteQueuedObservation,
  getQueuedObservations,
  isImageTooLargeForPlanError,
  isPrivacySlotLimitError,
  triggerSync,
} from '../sync-queue.js'
import { openFindDetail } from './find_detail.js'
import { imageHtml, wireImageFallback } from '../image-helpers.js'
import { openPreferredCamera } from '../camera-actions.js'
import { normalizeObservationVisibility } from '../visibility.js'
import { buildPeopleCard, loadPeopleSocialState, wireAvatarFallback, wirePeopleCardActions } from './people.js'


const _cache = {}   // scope → array of observations
let _profileMap = {}
let _pendingScrollRestore = null
const FINDS_PAGE_SIZE = 20
const FINDS_LOAD_MORE_THRESHOLD = 240
const PULL_REFRESH_THRESHOLD = 72
const PULL_REFRESH_MAX = 112
const PULL_REFRESH_TOUCH_SLOP = 10
const FINDS_STATUS_STORAGE_KEY = 'sporely-finds-status'
const LEGACY_FINDS_DRAFT_ONLY_STORAGE_KEY = 'sporely-finds-draft-only'
const FINDS_STATUS_VALUES = new Set(['all', 'drafts', 'published'])
let _pullTracking = false
let _pullStartX = 0
let _pullStartY = 0
let _pullDistance = 0
let _isRefreshing = false
let _queuedRefreshTimer = null
let _loadFindsSeq = 0
let _findsTargetCardLoadedUserId = null
let _findsTargetCardLoadingUserId = null
let _findsTargetCardLoadPromise = null
const _findsPaging = {
  mine: _createPagingState(),
  feed: _createPagingState(),
  friends: _createPagingState(),
  public: _createPagingState(),
  user: _createPagingState(),
}

const MINE_SELECT = 'id, user_id, date, created_at, captured_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type, is_draft, location_precision, spore_statistics'
const MINE_SELECT_LEGACY = 'id, user_id, date, created_at, captured_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, source_type, spore_statistics'
const FEED_SELECT = 'id, user_id, date, created_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude, is_draft, location_precision'
const FEED_SELECT_LEGACY = 'id, user_id, date, created_at, genus, species, common_name, location, notes, uncertain, visibility, gps_latitude, gps_longitude'
const OBSERVATION_SCOPES = new Set(['mine', 'feed', 'friends', 'public'])
const FINDS_PRIMARY_SCOPES = new Set(['mine', 'feed'])
const FINDS_MINE_SCOPES = new Set(['private', 'friends', 'public'])
const FINDS_FEED_SCOPES = new Set(['species', 'friends', 'public'])

function _createPagingState() {
  return {
    nextOffset: 0,
    hasMore: true,
    loadingMore: false,
    initialized: false,
  }
}

function _pagingScopeKey(scope) {
  const normalized = String(scope || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(_findsPaging, normalized) ? normalized : 'mine'
}

function _getPagingState(scope) {
  const key = _pagingScopeKey(scope)
  if (!_findsPaging[key]) _findsPaging[key] = _createPagingState()
  return _findsPaging[key]
}

function _resetPagingState(scope) {
  const key = _pagingScopeKey(scope)
  _findsPaging[key] = _createPagingState()
  return _findsPaging[key]
}

function _pageRange(offset) {
  const from = Math.max(0, Number(offset) || 0)
  return { from, to: from + FINDS_PAGE_SIZE - 1 }
}

function _mergeFindsItems(scope, existingItems, incomingItems) {
  const merged = [...(existingItems || [])]
  const seenIds = new Set(merged.map(item => String(item?.id || '').trim()).filter(Boolean))
  for (const item of incomingItems || []) {
    if (!item) continue
    const itemId = String(item.id || '').trim()
    if (itemId && seenIds.has(itemId)) continue
    if (scope === 'mine' && merged.some(existing => _observationsLikelySame(existing, item))) continue
    merged.push(item)
    if (itemId) seenIds.add(itemId)
  }
  merged.sort((a, b) => _sortTs(b) - _sortTs(a))
  return merged
}

function _setFindsCache(scope, items) {
  _cache[_pagingScopeKey(scope)] = Array.isArray(items) ? items : []
}

function _findsFooterHtml(scope) {
  const paging = _getPagingState(scope)
  if (!paging.initialized) return ''
  if (paging.loadingMore) {
    return `<div class="finds-bottom-sentinel finds-bottom-sentinel--loading">${_esc(t('common.loading'))}</div>`
  }
  if (!paging.hasMore && (_cache[_pagingScopeKey(scope)] || []).length) {
    return `<div class="finds-bottom-sentinel finds-bottom-sentinel--done">No more finds</div>`
  }
  return ''
}

function _normalizeScope(scope) {
  if (scope === 'community') return 'public'
  return OBSERVATION_SCOPES.has(scope) ? scope : 'mine'
}

function _normalizeFindsPrimaryScope(scope) {
  const raw = String(scope || '').trim().toLowerCase()
  return FINDS_PRIMARY_SCOPES.has(raw) ? raw : 'mine'
}

function _normalizeFindsMineScope(scope) {
  const raw = String(scope || '').trim().toLowerCase()
  return FINDS_MINE_SCOPES.has(raw) ? raw : 'public'
}

function _normalizeFindsFeedScope(scope) {
  const raw = String(scope || '').trim().toLowerCase()
  return FINDS_FEED_SCOPES.has(raw) ? raw : 'species'
}

function _findsPrimaryScope() {
  return _normalizeFindsPrimaryScope(state.findsScopePrimary)
}

function _findsSecondaryScope(primary = _findsPrimaryScope()) {
  return primary === 'feed'
    ? _normalizeFindsFeedScope(state.findsFeedScope)
    : _normalizeFindsMineScope(state.findsMineScope)
}

function _normalizeSecondaryScopeForPrimary(primary, scope, fallback = '') {
  const normalized = String(scope || '').trim().toLowerCase()
  if (primary === 'feed') {
    if (normalized === 'species' || normalized === 'friends' || normalized === 'public') {
      return _normalizeFindsFeedScope(normalized)
    }
    return _normalizeFindsFeedScope(fallback || 'species')
  }
  if (normalized === 'private' || normalized === 'friends' || normalized === 'public') {
    return _normalizeFindsMineScope(normalized)
  }
  return _normalizeFindsMineScope(fallback || 'public')
}

function _findsVisibleScope() {
  const primary = _findsPrimaryScope()
  const secondary = _findsSecondaryScope(primary)
  if (primary === 'mine') return 'mine'
  return secondary === 'species' ? 'feed' : secondary
}

function _currentScope() {
  return state.findsTargetUserId ? 'user' : _findsVisibleScope()
}

function _findsSecondaryLabel(primary = _findsPrimaryScope()) {
  return primary === 'feed'
    ? (t('detail.species') || 'Species')
    : (t('visibility.private') || 'Private')
}

function _findsSecondaryScopeLabel(scope, primary = _findsPrimaryScope()) {
  const normalized = String(scope || '').trim().toLowerCase()
  if (normalized === 'friends') return t('scope.friends')
  if (normalized === 'public') return t('scope.community')
  if (primary === 'feed') return _findsSecondaryLabel(primary)
  return t('visibility.private')
}

function _setFindsPrimaryScope(primary, options = {}) {
  const nextPrimary = _normalizeFindsPrimaryScope(primary)
  const previousPrimary = _findsPrimaryScope()
  const previousSecondary = _findsSecondaryScope(previousPrimary)
  state.findsScopePrimary = nextPrimary
  const preservedSecondary = options.secondaryScope !== undefined
    ? options.secondaryScope
    : previousSecondary
  if (nextPrimary === 'feed') {
    state.findsFeedScope = _normalizeSecondaryScopeForPrimary('feed', preservedSecondary, state.findsFeedScope || 'species')
  } else {
    state.findsMineScope = _normalizeSecondaryScopeForPrimary('mine', preservedSecondary, state.findsMineScope || 'public')
  }
}

function _setFindsSecondaryScope(scope, options = {}) {
  const primary = _findsPrimaryScope()
  const normalized = String(scope || '').trim().toLowerCase()
  if (primary === 'feed') {
    if (normalized === 'species' || normalized === 'friends' || normalized === 'public') {
      state.findsFeedScope = _normalizeFindsFeedScope(normalized)
    }
  } else {
    if (normalized === 'private' || normalized === 'friends' || normalized === 'public') {
      state.findsMineScope = _normalizeFindsMineScope(normalized)
    }
  }
  if (options.notify !== false) _showFindsScopeHint()
}

function _showFindsScopeHint() {
  const primary = _findsPrimaryScope()
  const secondary = _findsSecondaryScope(primary)
  const hint = primary === 'feed'
    ? (secondary === 'species'
      ? 'Species you follow'
      : secondary === 'friends'
        ? 'Your friends\' finds'
        : 'Public finds')
    : (secondary === 'private'
      ? 'Your private finds'
      : secondary === 'friends'
        ? 'Finds shared with friends'
        : 'Your public finds')
  showToast(hint)
}

function _normalizeFindsTargetUsername(value, userId = '') {
  const raw = String(value || '').trim().replace(/^@+/, '')
  if (!raw) return null

  const shortId = String(userId || '').trim().replace(/-/g, '').slice(0, 8).toLowerCase()
  const normalized = raw.toLowerCase()
  if (normalized === 'user') return null
  if (shortId && normalized === `user ${shortId}`) return null

  return raw
}

function _normalizeFindsTargetDisplayName(value, userId = '', username = '') {
  const raw = String(value || '').trim()
  if (!raw) return null

  const shortId = String(userId || '').trim().replace(/-/g, '').slice(0, 8).toLowerCase()
  const normalized = raw.replace(/^@+/, '').trim().toLowerCase()
  if (normalized === 'user') return null
  if (shortId && normalized === `user ${shortId}`) return null

  const normalizedUsername = String(username || '').trim().replace(/^@+/, '').toLowerCase()
  if (normalizedUsername && normalized === normalizedUsername) return null

  return raw
}

function _normalizeFindsTargetBio(value) {
  const raw = String(value || '').trim()
  return raw || null
}

function _normalizeFindsTargetAvatarUrl(value) {
  const raw = String(value || '').trim()
  return /^https?:\/\//i.test(raw) ? raw : ''
}

function _normalizeFindsStatusFilter(value) {
  const raw = String(value || '').trim().toLowerCase()
  return FINDS_STATUS_VALUES.has(raw) ? raw : 'all'
}

function _loadStatusFilterPreference() {
  try {
    const raw = globalThis.localStorage?.getItem(FINDS_STATUS_STORAGE_KEY)
    const normalized = _normalizeFindsStatusFilter(raw)
    if (normalized !== 'all' || raw === 'all') return normalized

    const legacy = globalThis.localStorage?.getItem(LEGACY_FINDS_DRAFT_ONLY_STORAGE_KEY)
    if (legacy === 'true') return 'drafts'
    if (legacy === 'false') return 'all'
    return 'all'
  } catch (_) {
    return 'all'
  }
}

function _saveStatusFilterPreference(status) {
  try {
    globalThis.localStorage?.setItem(FINDS_STATUS_STORAGE_KEY, _normalizeFindsStatusFilter(status))
  } catch (_) {}
}

export function isPublicVisibleObservation(obs, viewerId = state.user?.id) {
  const visibility = normalizeObservationVisibility(obs?.visibility)
  if (obs?.is_draft === true) return false
  if (visibility !== 'public') return false
  return String(obs?.user_id || '') !== String(viewerId || '')
}

export function matchesFindsStatus(obs, status = 'all') {
  const normalized = _normalizeFindsStatusFilter(status)
  if (normalized === 'drafts') return obs?.is_draft === true
  if (normalized === 'published') return obs?.is_draft !== true
  return true
}

function _composeFindsTargetPerson(source = {}) {
  const userId = String(source.userId || state.findsTargetUserId || '').trim()
  if (!userId) return null

  const username = _normalizeFindsTargetUsername(
    source.username !== undefined ? source.username : state.findsTargetUsername,
    userId
  )
  const displayName = _normalizeFindsTargetDisplayName(
    source.displayName !== undefined ? source.displayName : state.findsTargetDisplayName,
    userId,
    username
  )
  const avatarUrl = _normalizeFindsTargetAvatarUrl(
    source.avatarUrl !== undefined ? source.avatarUrl : state.findsTargetAvatarUrl
  )
  const bio = _normalizeFindsTargetBio(
    source.bio !== undefined ? source.bio : state.findsTargetBio
  )
  const finds = Number(source.finds !== undefined ? source.finds : state.findsTargetFinds)
  const species = Number(source.species !== undefined ? source.species : state.findsTargetSpecies)
  const spores = Number(source.spores !== undefined ? source.spores : state.findsTargetSpores)
  const relationshipSource = source.relationship !== undefined
    ? source.relationship
    : state.findsTargetRelationship
  const relationship = relationshipSource && typeof relationshipSource === 'object'
    ? {
        friendStatus: relationshipSource.friendStatus || null,
        following: relationshipSource.following === true,
      }
    : null

  return {
    user_id: userId,
    username,
    display_name: displayName,
    avatar_url: avatarUrl,
    bio,
    finds: Number.isFinite(finds) ? finds : 0,
    species: Number.isFinite(species) ? species : 0,
    spores: Number.isFinite(spores) ? spores : 0,
    relationship,
  }
}

function _findsTargetPreviewData() {
  if (!state.findsTargetSummaryLoaded) return null
  return _composeFindsTargetPerson()
}

function _renderFindsTargetCard(root, person) {
  if (!root) return
  root.innerHTML = person
    ? buildPeopleCard(person)
    : `<div class="people-empty" style="padding: 8px 0;">${_esc(t('common.loading'))}</div>`
  if (person) {
    wireAvatarFallback(root)
    wirePeopleCardActions(root)
  }
}

async function _loadFindsTargetCard(userId) {
  const targetUserId = String(userId || '').trim()
  const root = document.getElementById('finds-user-card-root')
  if (!targetUserId || !root) return
  if (state.findsTargetSummaryComplete && _findsTargetCardLoadedUserId === targetUserId) return
  if (_findsTargetCardLoadingUserId === targetUserId && _findsTargetCardLoadPromise) return _findsTargetCardLoadPromise

  _findsTargetCardLoadingUserId = targetUserId
  const loadPromise = (async () => {
    const [profileRes, statsRes, relationshipMap] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio')
        .eq('id', targetUserId)
        .maybeSingle(),
      supabase.rpc('get_person_stats', { p_user_id: targetUserId }),
      loadPeopleSocialState([targetUserId]),
    ])

    if (_currentScope() !== 'user' || String(state.findsTargetUserId || '') !== targetUserId) return

    const profile = profileRes?.data || null
    const statsRow = Array.isArray(statsRes?.data) ? (statsRes.data[0] || null) : (statsRes?.data || null)
    const signedAvatarUrl = profile?.avatar_url && /^https?:\/\//i.test(String(profile.avatar_url))
      ? String(profile.avatar_url)
      : ''
    const signedStateAvatarUrl = state.findsTargetAvatarUrl && /^https?:\/\//i.test(String(state.findsTargetAvatarUrl))
      ? String(state.findsTargetAvatarUrl)
      : ''
    const avatarUrl = signedAvatarUrl || signedStateAvatarUrl || ''

    let person = _composeFindsTargetPerson({
      userId: targetUserId,
      username: profile?.username !== undefined ? profile.username : state.findsTargetUsername,
      displayName: profile?.display_name !== undefined ? profile.display_name : state.findsTargetDisplayName,
      avatarUrl,
      bio: profile?.bio !== undefined ? profile.bio : state.findsTargetBio,
      finds: statsRow?.public_find_count !== undefined ? Number(statsRow.public_find_count) : state.findsTargetFinds,
      species: statsRow?.public_species_count !== undefined ? Number(statsRow.public_species_count) : state.findsTargetSpecies,
      spores: statsRow?.public_spore_count !== undefined ? Number(statsRow.public_spore_count) : state.findsTargetSpores,
      relationship: state.findsTargetRelationship,
    })

    if (!person) {
      person = _composeFindsTargetPerson()
    }

    if (!person) return
    person.relationship = relationshipMap?.[targetUserId] || { friendStatus: null, following: false }

    state.findsTargetUsername = person.username
    state.findsTargetDisplayName = person.display_name
    state.findsTargetAvatarUrl = person.avatar_url
    state.findsTargetBio = person.bio
    state.findsTargetFinds = person.finds
    state.findsTargetSpecies = person.species
    state.findsTargetSpores = person.spores
    state.findsTargetSummaryLoaded = true
    state.findsTargetSummaryComplete = true
    _findsTargetCardLoadedUserId = targetUserId
    _renderFindsTargetCard(root, person)
  })().catch(error => {
    if (import.meta.env?.DEV) {
      console.warn('[finds-user-card] could not hydrate target user', {
        userId: targetUserId,
        error,
      })
    }
    const fallback = _composeFindsTargetPerson()
    if (fallback && _currentScope() === 'user' && String(state.findsTargetUserId || '') === targetUserId) {
      _renderFindsTargetCard(root, fallback)
    }
  }).finally(() => {
    if (_findsTargetCardLoadingUserId === targetUserId) _findsTargetCardLoadingUserId = null
    if (_findsTargetCardLoadPromise === loadPromise) _findsTargetCardLoadPromise = null
  })

  _findsTargetCardLoadPromise = loadPromise
  return loadPromise
}

function _isPhase7ColumnError(error) {
  const message = String(error?.message || '').toLowerCase()
  return !!error && (message.includes('is_draft') || message.includes('location_precision'))
}

async function _withPhase7Fallback(makeQuery, columns, legacyColumns) {
  const result = await makeQuery(columns)
  if (_isPhase7ColumnError(result.error)) return makeQuery(legacyColumns)
  return result
}

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
    normalizeObservationVisibility(obs.visibility),
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
    try {
      await loadFinds()
    } catch (error) {
      console.warn('Finds refresh load failed:', error)
    }
  } finally {
    void triggerSync().catch(error => {
      console.warn('Background sync during finds refresh failed:', error)
    })
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

function _bindInfiniteScroll() {
  const screen = document.getElementById('screen-finds')
  if (!screen || screen.dataset.infiniteScrollBound === 'true') return
  screen.dataset.infiniteScrollBound = 'true'

  let scheduled = false
  const checkBottom = () => {
    scheduled = false
    void _maybeLoadMoreFinds()
  }

  screen.addEventListener('scroll', () => {
    if (scheduled) return
    scheduled = true
    window.requestAnimationFrame(checkBottom)
  }, { passive: true })
}

// ── Init (once at boot) ───────────────────────────────────────────────────────

export function initFinds() {
  state.findsStatusFilter = _loadStatusFilterPreference()
  _syncStatusSelect()
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('portrait').catch(() => {});
  }
  _bindPullToRefresh()
  _bindInfiniteScroll()
  document.getElementById('finds-fab')
    .addEventListener('click', openPreferredCamera)

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
  document.getElementById('finds-filter-spores')?.addEventListener('click', () => {
    state.findsSporesOnly = !state.findsSporesOnly
    _syncSporesToggle()
    _applyFilter()
  })
  document.getElementById('finds-status-select')?.addEventListener('change', event => {
    _setFindsStatusFilter(event.target.value, { persist: true })
    _applyFilter()
  })

  document.getElementById('finds-user-back')?.addEventListener('click', () => {
    openFinds('mine', { resetSearch: true, resetFilters: true })
  })

  // Scope tabs
  document.querySelectorAll('#finds-scope-primary-tabs .scope-tab, #finds-scope-secondary-tabs .scope-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.closest('#finds-scope-primary-tabs')) {
        _setFindsPrimaryScope(btn.dataset.scope)
        _showFindsScopeHint()
      } else {
        _setFindsSecondaryScope(btn.dataset.scope)
      }
      _syncScopeTabs()
      loadFinds()
    })
  })

  window.addEventListener(QUEUE_EVENT, () => {
    if (state.currentScreen === 'finds' && _currentScope() === 'mine') {
      requestFindsRefresh()
    }
  })
}

function _syncScopeTabs() {
  const primaryTabs = document.getElementById('finds-scope-primary-tabs')
  const secondaryTabs = document.getElementById('finds-scope-secondary-tabs')
  const userBar = document.getElementById('finds-user-bar')
  const currentScope = _currentScope()
  const primaryScope = _findsPrimaryScope()
  const secondaryScope = _findsSecondaryScope(primaryScope)

  if (currentScope === 'user') {
    if (primaryTabs) primaryTabs.style.display = 'none'
    if (secondaryTabs) secondaryTabs.style.display = 'none'
    if (userBar) {
      userBar.style.display = 'flex'
      userBar.style.flexDirection = 'column'
      userBar.style.alignItems = 'stretch'
      userBar.style.padding = '12px 18px 0'
      userBar.style.gap = '12px'
      
      const uid = state.findsTargetUserId;
      
      // Just the back button initially, no "Unknown" text
      userBar.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="detail-back-btn" id="finds-user-back" type="button" style="padding:0; margin-right:4px;" aria-label="Back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div id="finds-user-card-root"></div>
      `;
      
      document.getElementById('finds-user-back')?.addEventListener('click', () => {
        openFinds('mine', { resetSearch: true, resetFilters: true })
      })

      if (uid) {
        const root = document.getElementById('finds-user-card-root')
        const preview = _findsTargetPreviewData()
        if (preview) {
          _findsTargetCardLoadedUserId = uid
          _renderFindsTargetCard(root, preview)
        } else {
          _renderFindsTargetCard(root, null)
          void _loadFindsTargetCard(uid)
        }
      }
    }
  } else {
    if (primaryTabs) primaryTabs.style.display = 'inline-flex'
    if (secondaryTabs) secondaryTabs.style.display = 'inline-flex'
    if (userBar) {
      userBar.style.display = 'none'
      userBar.style.flexDirection = ''
      userBar.style.alignItems = 'center'
      userBar.style.padding = '12px 0 0 18px'
      userBar.style.gap = '8px'
    }
    const primaryMineBtn = document.getElementById('finds-scope-mine')
    const primaryFeedBtn = document.getElementById('finds-scope-feed')
    if (primaryMineBtn) primaryMineBtn.textContent = t('scope.mine')
    if (primaryFeedBtn) primaryFeedBtn.textContent = t('scope.feed')

    const secondaryMainBtn = document.getElementById('finds-scope-secondary-main')
    const secondaryFriendsBtn = document.getElementById('finds-scope-secondary-friends')
    const secondaryPublicBtn = document.getElementById('finds-scope-secondary-public')
    if (secondaryMainBtn) {
      secondaryMainBtn.textContent = _findsSecondaryLabel(primaryScope)
      secondaryMainBtn.dataset.scope = primaryScope === 'feed' ? 'species' : 'private'
    }
    if (secondaryFriendsBtn) secondaryFriendsBtn.textContent = t('scope.friends')
    if (secondaryPublicBtn) secondaryPublicBtn.textContent = t('scope.community')

    document.querySelectorAll('#finds-scope-primary-tabs .scope-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scope === primaryScope)
    })
    document.querySelectorAll('#finds-scope-secondary-tabs .scope-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scope === secondaryScope)
    })
  }
}

function _syncSpeciesToggle() {
  const btn = document.getElementById('finds-group-species')
  if (!btn) return
  btn.classList.toggle('active', !!state.findsGroupBySpecies)
  btn.setAttribute('aria-pressed', state.findsGroupBySpecies ? 'true' : 'false')
}

function _syncSporesToggle() {
  const btn = document.getElementById('finds-filter-spores')
  if (!btn) return
  btn.classList.toggle('active', !!state.findsSporesOnly)
  btn.setAttribute('aria-pressed', state.findsSporesOnly ? 'true' : 'false')
}

function _syncStatusSelect() {
  const select = document.getElementById('finds-status-select')
  if (!select) return
  select.value = _normalizeFindsStatusFilter(state.findsStatusFilter)
}

function _setFindsStatusFilter(status, options = {}) {
  const normalized = _normalizeFindsStatusFilter(status)
  state.findsStatusFilter = normalized
  if (options.persist !== false) {
    _saveStatusFilterPreference(normalized)
  }
  _syncStatusSelect()
}

function _setScope(scope, options = {}) {
  const normalized = String(scope || '').trim().toLowerCase()

  if (normalized === 'user') {
    state.findsTargetUserId = options.userId
    state.findsTargetSummaryLoaded = options.summaryLoaded === true
    state.findsTargetSummaryComplete = options.summaryComplete === true
    state.findsTargetUsername = options.username
    state.findsTargetAvatarUrl = options.avatarUrl
    state.findsTargetDisplayName = options.displayName
    state.findsTargetBio = options.bio
    state.findsTargetRelationship = options.relationship || null
    state.findsTargetFinds = options.finds
    state.findsTargetSpecies = options.species
    state.findsTargetSpores = options.spores
    if (state.findsTargetSummaryLoaded) {
      _findsTargetCardLoadedUserId = String(options.userId || '').trim() || null
    } else {
      _findsTargetCardLoadedUserId = null
    }
  } else {
    if (normalized === 'mine' || normalized === 'feed') {
      _setFindsPrimaryScope(normalized, { secondaryScope: options.secondaryScope })
    } else if (normalized === 'private' || normalized === 'friends' || normalized === 'public' || normalized === 'species') {
      _setFindsSecondaryScope(normalized, { notify: false })
    } else {
      _setFindsPrimaryScope('mine', { secondaryScope: options.secondaryScope })
    }

    state.findsTargetUserId = null
    state.findsTargetSummaryLoaded = false
    state.findsTargetUsername = null
    state.findsTargetAvatarUrl = null
    state.findsTargetDisplayName = null
    state.findsTargetBio = null
    state.findsTargetRelationship = null
    state.findsTargetFinds = 0
    state.findsTargetSpecies = 0
    state.findsTargetSpores = 0
    state.findsTargetSummaryComplete = false
    _findsTargetCardLoadedUserId = null
  }

  if (options.resetSearch) {
    state.searchQuery = ''
    const searchInput = document.getElementById('finds-search-input')
    const searchBar = document.getElementById('finds-search-bar')
    if (searchInput) searchInput.value = ''
    if (searchBar) searchBar.classList.remove('open')
  }

  if (options.resetFilters) {
    state.findsGroupBySpecies = false
    state.findsSporesOnly = false
    _setFindsStatusFilter('all', { persist: true })
    _setFindsPrimaryScope(_findsPrimaryScope(), {
      secondaryScope: _findsPrimaryScope() === 'feed' ? 'species' : 'public',
    })
  }

  if (options.groupBySpecies !== undefined) {
    state.findsGroupBySpecies = !!options.groupBySpecies
  }

  if (options.sporesOnly !== undefined) {
    state.findsSporesOnly = !!options.sporesOnly
  }

  if (options.statusFilter !== undefined) {
    _setFindsStatusFilter(options.statusFilter, { persist: false })
  }

  _syncScopeTabs()
  _syncSpeciesToggle()
  _syncSporesToggle()
  _syncStatusSelect()
}

export async function openFinds(scope = _currentScope(), options = {}) {
  _setScope(scope, options)
  navigate('finds')
  await loadFinds()
}

export function requestFindsRefresh(delayMs = 120) {
  if (_queuedRefreshTimer) {
    window.clearTimeout(_queuedRefreshTimer)
  }
  _queuedRefreshTimer = window.setTimeout(() => {
    _queuedRefreshTimer = null
    void loadFinds()
  }, Math.max(0, Number(delayMs) || 0))
}

function _setFindsView(view) {
  state.findsView = view
  _syncViewBtns()
  _applyFilter()
}

function _syncViewBtns() {
  document.querySelectorAll('.finds-view-btns .finds-view-btn').forEach(btn => {
    const active = btn.id === `finds-view-${state.findsView}`
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-checked', active ? 'true' : 'false')
    btn.setAttribute('role', 'radio')
  })
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadFinds() {
  const list = document.getElementById('finds-list')
  if (!state.user) return
  const loadSeq = ++_loadFindsSeq
  const primaryScope = _findsPrimaryScope()
  const secondaryScope = _findsSecondaryScope(primaryScope)
  const currentScope = _currentScope()
  _resetPagingState(currentScope)

  _setFindsCache(currentScope, [])
  if (list) {
    list.innerHTML = `<div class="finds-loading-state">${_esc(t('common.loading'))}</div>`
  }
  const screen = document.getElementById('screen-finds')
  if (screen && _pendingScrollRestore === null) {
    screen.scrollTop = 0
  }

  _syncScopeTabs()
  _syncSpeciesToggle()
  _syncSporesToggle()
  _syncStatusSelect()

  if (currentScope === 'user') {
    await _loadUserPage(state.findsTargetUserId, { loadSeq, reset: true })
  } else if (primaryScope === 'mine') {
    await _loadMinePage({ loadSeq, reset: true })
  } else if (secondaryScope === 'species') {
    await _loadFollowPage({ loadSeq, reset: true })
  } else if (secondaryScope === 'friends') {
    await _loadFriendsPage({ loadSeq, reset: true })
  } else if (secondaryScope === 'public') {
    await _loadCommunityPage({ loadSeq, reset: true })
  } else {
    state.findsScopePrimary = 'mine'
    state.findsMineScope = 'public'
    await _loadMinePage({ loadSeq, reset: true })
  }

  await _loadProfilesForScope(_cache[currentScope] || [], loadSeq)
  if (loadSeq !== _loadFindsSeq) return
  _applyFilter()
  void _maybeLoadMoreFinds()
}

async function _attachSporeFlags(observations) {
  if (!observations || !observations.length) return
  observations.forEach(o => {
    if (o.spore_statistics || o.spore_short) {
      o.has_spores = true
    }
  })
}

async function _loadProfilesForScope(data, loadSeq = _loadFindsSeq) {
  if (loadSeq !== _loadFindsSeq) return false
  const userIds = [...new Set((data || [])
    .map(obs => obs.user_id)
    .filter(uid => uid && uid !== state.user?.id))]

  if (!userIds.length) {
    if (loadSeq !== _loadFindsSeq) return false
    _profileMap = {}
    return true
  }

  const [profilesRes, relationships] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .in('id', userIds),
    loadPeopleSocialState(userIds),
  ])

  if (loadSeq !== _loadFindsSeq) return false

  const { data: profiles, error } = profilesRes
  if (error) {
    console.warn('Could not load observation profiles:', error.message)
    _profileMap = {}
    return false
  }
  
  const paths = userIds.map(uid => `${uid}/avatar.jpg`)
  const { data: signedData } = await supabase.storage.from('avatars').createSignedUrls(paths, 3600)
  if (loadSeq !== _loadFindsSeq) return false
  const signedMap = {}
  if (signedData) {
    signedData.forEach(item => {
      if (item.signedUrl) signedMap[item.path.split('/')[0]] = item.signedUrl
    })
  }

  if (loadSeq !== _loadFindsSeq) return false
  _profileMap = Object.fromEntries((profiles || []).map(profile => {
    if (signedMap[profile.id]) profile.avatar_url = signedMap[profile.id]
    return [profile.id, {
      ...profile,
      relationship: relationships?.[profile.id] || { friendStatus: null, following: false },
    }]
  }))
  return true
}

function _orderedFindsQuery(query) {
  return query
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
}

async function _runPagedFindsQuery(makeQuery, columns, legacyColumns, offset) {
  const { from, to } = _pageRange(offset)
  return _withPhase7Fallback(
    selectedColumns => _orderedFindsQuery(makeQuery(selectedColumns)).range(from, to),
    columns,
    legacyColumns,
  )
}

async function _loadMinePage({ loadSeq, reset = false } = {}) {
  if (!state.user?.id) return false
  const paging = _getPagingState('mine')
  if (paging.loadingMore) return false
  paging.loadingMore = true

  const currentItems = reset ? [] : (_cache['mine'] || [])
  const queuedPromise = reset ? getQueuedObservations(state.user.id) : Promise.resolve([])
  const pagePromise = _runPagedFindsQuery(
    columns => supabase.from('observations').select(columns).eq('user_id', state.user.id),
    MINE_SELECT,
    MINE_SELECT_LEGACY,
    paging.nextOffset,
  )

  try {
    const [queued, pageRes] = await Promise.all([queuedPromise, pagePromise])
    if (loadSeq !== _loadFindsSeq) return false

    const data = pageRes?.data || []
    const error = pageRes?.error || null
    if (error) {
      showToast(t('finds.couldNotLoad'))
      if (reset) _setFindsCache('mine', [])
      paging.hasMore = false
      paging.initialized = true
      return false
    }

    const merged = _mergeFindsItems('mine', currentItems.length ? currentItems : queued, data)
    await _attachSporeFlags(merged)
    _setFindsCache('mine', merged)
    paging.nextOffset += data.length
    paging.hasMore = data.length === FINDS_PAGE_SIZE
    paging.initialized = true
    return true
  } finally {
    paging.loadingMore = false
  }
}

async function _loadFriendsPage({ loadSeq, reset = false } = {}) {
  const paging = _getPagingState('friends')
  if (paging.loadingMore) return false
  paging.loadingMore = true
  const pagePromise = _runPagedFindsQuery(
    columns => supabase
      .from('observations_friend_view')
      .select(columns)
      .neq('user_id', state.user.id),
    FEED_SELECT,
    FEED_SELECT_LEGACY,
    paging.nextOffset,
  )

  try {
    const pageRes = await pagePromise
    if (loadSeq !== _loadFindsSeq) return false
    const data = pageRes?.data || []
    const error = pageRes?.error || null
    if (error) {
      console.error('Failed to fetch friends feed:', error)
      if (reset) _setFindsCache('friends', [])
      paging.hasMore = false
      paging.initialized = true
      return false
    }

    const merged = _mergeFindsItems('friends', reset ? [] : (_cache['friends'] || []), data)
    await _attachSporeFlags(merged)
    _setFindsCache('friends', merged)
    paging.nextOffset += data.length
    paging.hasMore = data.length === FINDS_PAGE_SIZE
    paging.initialized = true
    return true
  } finally {
    paging.loadingMore = false
  }
}

async function _loadCommunityPage({ loadSeq, reset = false } = {}) {
  const paging = _getPagingState('public')
  if (paging.loadingMore) return false
  paging.loadingMore = true
  const pagePromise = _runPagedFindsQuery(
    columns => supabase
      .from('observations_community_view')
      .select(columns),
    FEED_SELECT,
    FEED_SELECT_LEGACY,
    paging.nextOffset,
  )

  try {
    const pageRes = await pagePromise
    if (loadSeq !== _loadFindsSeq) return false
    const rawData = pageRes?.data || []
    const data = rawData.filter(obs => isPublicVisibleObservation(obs))
    const error = pageRes?.error || null
    if (error) {
      console.error('Failed to fetch community feed:', error)
      if (reset) _setFindsCache('public', [])
      paging.hasMore = false
      paging.initialized = true
      return false
    }

    const merged = _mergeFindsItems('public', reset ? [] : (_cache['public'] || []), data)
    await _attachSporeFlags(merged)
    _setFindsCache('public', merged)
    paging.nextOffset += rawData.length
    paging.hasMore = rawData.length === FINDS_PAGE_SIZE
    paging.initialized = true
    return true
  } finally {
    paging.loadingMore = false
  }
}

async function _loadFollowPage({ loadSeq, reset = false } = {}) {
  const paging = _getPagingState('feed')
  if (paging.loadingMore) return false
  paging.loadingMore = true
  const pagePromise = _runPagedFindsQuery(
    columns => supabase
      .from('observations_follow_view')
      .select(columns),
    FEED_SELECT,
    FEED_SELECT_LEGACY,
    paging.nextOffset,
  )

  try {
    const pageRes = await pagePromise
    if (loadSeq !== _loadFindsSeq) return false
    const data = pageRes?.data || []
    const error = pageRes?.error || null
    if (error) {
      console.warn('Failed to fetch followed feed:', error.message)
      if (reset) _setFindsCache('feed', [])
      paging.hasMore = false
      paging.initialized = true
      return false
    }

    const merged = _mergeFindsItems('feed', reset ? [] : (_cache['feed'] || []), data)
    await _attachSporeFlags(merged)
    _setFindsCache('feed', merged)
    paging.nextOffset += data.length
    paging.hasMore = data.length === FINDS_PAGE_SIZE
    paging.initialized = true
    return true
  } finally {
    paging.loadingMore = false
  }
}

async function _loadUserPage(userId, { loadSeq, reset = false } = {}) {
  if (!userId) return false
  const paging = _getPagingState('user')
  if (paging.loadingMore) return false
  paging.loadingMore = true
  const isOwner = String(userId || '') === String(state.user?.id || '')
  const pagePromise = _runPagedFindsQuery(
    columns => (isOwner
      ? supabase
        .from('observations')
        .select(columns)
        .eq('user_id', userId)
      : supabase
        .from('observations_community_view')
        .select(columns)
        .eq('user_id', userId)),
    MINE_SELECT,
    MINE_SELECT_LEGACY,
    paging.nextOffset,
  )

  try {
    const pageRes = await pagePromise
    if (loadSeq !== _loadFindsSeq) return false
    const data = (pageRes?.data || []).filter(obs => {
      if (!obs) return false
      if (String(userId || '') === String(state.user?.id || '')) return true
      return String(obs.user_id || '') === String(userId || '') && isPublicVisibleObservation(obs, state.user?.id)
    })
    const error = pageRes?.error || null
    if (error) {
      showToast(t('finds.couldNotLoad'))
      if (reset) _setFindsCache('user', [])
      paging.hasMore = false
      paging.initialized = true
      return false
    }

    const merged = _mergeFindsItems('user', reset ? [] : (_cache['user'] || []), data)
    await _attachSporeFlags(merged)
    _setFindsCache('user', merged)
    paging.nextOffset += data.length
    paging.hasMore = data.length === FINDS_PAGE_SIZE
    paging.initialized = true
    return true
  } finally {
    paging.loadingMore = false
  }
}

async function _loadCurrentFindsPage({ reset = false } = {}) {
  const currentScope = _currentScope()
  const loadSeq = _loadFindsSeq
  if (currentScope === 'mine') return _loadMinePage({ loadSeq, reset })
  if (currentScope === 'user') return _loadUserPage(state.findsTargetUserId, { loadSeq, reset })
  if (_findsSecondaryScope(_findsPrimaryScope()) === 'species') return _loadFollowPage({ loadSeq, reset })
  if (_findsSecondaryScope(_findsPrimaryScope()) === 'friends') return _loadFriendsPage({ loadSeq, reset })
  return _loadCommunityPage({ loadSeq, reset })
}

async function _maybeLoadMoreFinds() {
  if (state.currentScreen !== 'finds' || _isRefreshing) return

  const currentScope = _currentScope()
  const paging = _getPagingState(currentScope)
  if (!paging.initialized || paging.loadingMore || !paging.hasMore) return

  const scroller = document.getElementById('screen-finds')
  if (!scroller) return

  const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight)
  if (distanceFromBottom > FINDS_LOAD_MORE_THRESHOLD) return

  const loadSeq = _loadFindsSeq
  const loaded = await _loadCurrentFindsPage({ reset: false })
  if (loadSeq !== _loadFindsSeq) return
  if (loaded) {
    await _loadProfilesForScope(_cache[currentScope] || [], loadSeq)
    if (loadSeq !== _loadFindsSeq) return
    _applyFilter()
    void _maybeLoadMoreFinds()
  }
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
  const primaryScope = _findsPrimaryScope()
  const secondaryScope = _findsSecondaryScope(primaryScope)
  const currentScope = _currentScope()
  const statusFilter = _normalizeFindsStatusFilter(state.findsStatusFilter)
  const raw = currentScope === 'user'
    ? (_cache['user'] || [])
    : primaryScope === 'mine'
      ? (_cache['mine'] || [])
      : (_cache[currentScope] || [])
  const q    = (state.searchQuery || '').toLowerCase().trim()
  
  let filtered = raw
  if (currentScope === 'user') {
    filtered = filtered.filter(obs => {
      if (String(obs.user_id || '') !== String(state.findsTargetUserId || '')) return false
      if (String(state.findsTargetUserId || '') === String(state.user?.id || '')) return true
      return isPublicVisibleObservation(obs, state.user?.id)
    })
  } else if (primaryScope === 'mine') {
    filtered = filtered.filter(obs => {
      if (String(obs.user_id || '') !== String(state.user?.id || '')) return false
      const visibility = normalizeObservationVisibility(obs.visibility)
      if (secondaryScope === 'private') return visibility === 'private'
      return visibility === secondaryScope
    })
  } else if (secondaryScope === 'public') {
    filtered = filtered.filter(obs => isPublicVisibleObservation(obs))
  }
  if (state.findsSporesOnly) filtered = filtered.filter(obs => !!obs.has_spores || !!obs.spore_short || !!obs.spore_statistics)
  filtered = filtered.filter(obs => matchesFindsStatus(obs, statusFilter))

  // Search still runs client-side against the loaded pages only. True global
  // search needs server-side filtering and is out of scope for this pass.
  const data = q ? filtered.filter(obs => _matches(obs, q)) : filtered

  if (state.findsGroupBySpecies) {
    _renderBySpecies(list, data, { variant: state.findsView })
    return
  }

  if (state.findsView === 'two') {
    _renderCards(list, data, { variant: 'two', isFriends: currentScope === 'friends' })
  } else if (state.findsView === 'three') {
    _renderCards(list, data, { variant: 'three', isFriends: currentScope === 'friends' })
  } else {
    _renderCards(list, data, { variant: 'cards', isFriends: currentScope === 'friends' })
  }
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
      return obs._syncErrorMessage ? `${t('finds.pendingRetrying')}: ${obs._syncErrorMessage}` : t('finds.pendingRetrying')
    case 'blocked':
      if (obs._syncBlockedReason) return obs._syncBlockedReason
      if (obs._blockedReason) return obs._blockedReason
      if (obs._syncErrorCode === 'privacy_slot_limit' || isPrivacySlotLimitError(obs._syncErrorMessage)) return PRIVACY_SLOT_LIMIT_USER_MESSAGE
      if (obs._syncErrorCode === 'image_too_large_for_plan' || isImageTooLargeForPlanError(obs._syncErrorMessage)) return IMAGE_TOO_LARGE_FOR_PLAN_USER_MESSAGE
      return obs._syncErrorMessage ? `Upload blocked: ${obs._syncErrorMessage}` : 'Upload blocked'
    default:
      return t('finds.pendingUpload')
  }
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
  const isFriend = profile?.relationship?.friendStatus === 'accepted'
  const badge = isFriend
    ? `<span class="relationship-heart-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
      </span>`
    : ''
  const wrapperClass = [
    'observation-author-chip-wrap',
    sizeClass,
    isFriend ? 'is-friend' : '',
  ].filter(Boolean).join(' ')
  if (profile?.avatar_url) {
    return `<div class="${wrapperClass}" title="${_esc(_authorHandle(obs))}">
      <div class="observation-author-chip ${isFriend ? 'is-friend' : ''}">
        <img src="${_esc(profile.avatar_url)}" alt="${_esc(_authorHandle(obs))}" loading="lazy" decoding="async">
      </div>
      ${badge}
    </div>`
  }
  return `<div class="${wrapperClass}" title="${_esc(_authorHandle(obs))}">
    <div class="observation-author-chip observation-author-chip--initial ${isFriend ? 'is-friend' : ''}">
      ${_esc(_authorInitial(obs))}
    </div>
    ${badge}
  </div>`
}

function _draftBadge(obs) {
  return obs?.is_draft === true
    ? `<span class="find-card-draft-badge">${_esc(t('finds.draftBadge'))}</span>`
    : ''
}

function _emptyFindsText(q, options = {}) {
  const currentScope = _currentScope()
  if (q) return t('finds.noResults', { query: q })
  if (state.findsSporesOnly) return t('finds.noSporeMetrics')
  if (currentScope === 'feed') return t('finds.noFollowed')
  if (options.isFriends || currentScope === 'friends') return t('finds.noFriends')
  return options.capture ? t('finds.noObservationsCapture') : t('finds.noObservations')
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

function _renderBySpecies(list, data, options = {}) {
  const variant = options.variant || 'cards'
  const q = (state.searchQuery || '').trim()
  const currentScope = _currentScope()
  if (!data.length) {
    const emptyText = _emptyFindsText(q)
    list.innerHTML = `<div style="padding: 24px 14px; color: var(--text-dim); font-size: 13px; text-align: center;">${_esc(emptyText)}</div>`
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
        const sporesIcon = obs.has_spores
          ? `<svg class="find-card-vis-icon" style="stroke: var(--amber);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="4" ry="8" transform="rotate(30 12 12)"/></svg>`
          : ''
        const metaLead = obs._pendingSync
          ? `<span class="find-card-loc-text">${_esc(_pendingStatusText(obs))}</span>`
          : loc
            ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              <span class="find-card-loc-text">${_esc(loc)}</span>`
            : `<span class="find-card-loc-text">${dateLabel}</span>`

        if (variant === 'two') {
          const photoInner = imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--two">
            <div class="find-card find-card--two${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--two">${photoInner}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
              <div class="find-card-body find-card-body--two">
                ${compactNameHtml}
                <div class="find-card-loc">${metaLead}${sporesIcon}${statusIcon}${_deleteQueueBtn(obs)}</div>
              </div>
            </div>
          </div>`
          continue
        }

        if (variant === 'three') {
          const photoInner = imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--three">
            <div class="find-card find-card--three${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--three">${photoInner}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--card observation-author-chip--compact' })}</div>
              <div class="find-card-body find-card-body--three">
                ${compactNameHtml}
                ${obs._pendingSync ? `<div class="find-card-loc">${sporesIcon}${statusIcon}${_deleteQueueBtn(obs)}</div>` : ''}
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
          ? imageHtml(_pendingImageSource(obs), '', 'find-card-photo-placeholder')
          : cardImg?.second
            ? `<div class="find-card-polaroid">
                <div class="find-card-polaroid-frame">${imageHtml(cardImg.first, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
                <div class="find-card-polaroid-frame">${imageHtml(cardImg.second, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
              </div>`
            : cardImg?.first
              ? `<div class="find-card-polaroid find-card-polaroid--single">
                  <div class="find-card-polaroid-frame find-card-polaroid-frame--single">${imageHtml(cardImg.first, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
                </div>`
              : imageHtml(cardImg, '', 'find-card-photo-placeholder')

        html += `<div class="find-card-wrap">
          <div class="find-card${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
            <div class="find-card-photo-wrap">${photoWrapInner}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
            <div class="find-card-body">
              <div class="find-card-name-row">${nameHtml}${countBadge}</div>
              <div class="find-card-loc">${metaLead}${sporesIcon}${statusIcon}${_deleteQueueBtn(obs)}</div>
            </div>
          </div>
        </div>`
      }

      html += '</div>'
    }

    html += '</div>'
    html += _findsFooterHtml(currentScope)
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
    wireImageFallback(list)
  })
}

// ── Render: tiles ─────────────────────────────────────────────────────────────

function _renderTiles(list, data) {
  const q = (state.searchQuery || '').trim()
  const currentScope = _currentScope()
  if (!data.length) {
    const emptyText = _emptyFindsText(q)
    list.innerHTML = `<div style="padding: 24px 14px; color: var(--text-dim); font-size: 13px; text-align: center;">${_esc(emptyText)}</div>`
    return
  }


  fetchFirstImages(data.filter(obs => !obs._pendingSync).map(o => o.id), { variant: 'small' }).then(imageUrls => {
    let html = '<div class="find-tiles-grid">'
    data.forEach(obs => {
      const name = obs.common_name
        || formatScientificName(obs.genus || '', obs.species || '')
        || t('finds.unidentified')
      const photo = imageHtml(
        obs._pendingSync ? _pendingImageSource(obs) : imageUrls[obs.id],
        '',
        'find-tile-empty'
      )
      html += `<div class="find-tile" data-id="${obs.id}">
        <div class="find-tile-photo">${photo}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--tile' })}</div>
        <div class="find-tile-name">${obs.uncertain ? '? ' : ''}${name}</div>
      </div>`
    })
    html += '</div>'
    html += _findsFooterHtml(currentScope)
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
    wireImageFallback(list)
  })
}

// ── Render: cards ─────────────────────────────────────────────────────────────

function _renderCards(list, data, options) {
  const variant = options?.variant || 'cards'
  const isFriends = !!options?.isFriends
  const q = (state.searchQuery || '').trim()
  const currentScope = _currentScope()
  if (!data.length) {
    const emptyText = _emptyFindsText(q, { isFriends, capture: true })
    list.innerHTML = `<div style="padding: 24px 14px; color: var(--text-dim); font-size: 13px; text-align: center;">${_esc(emptyText)}</div>`
    return
  }


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
          : normalizeObservationVisibility(obs.visibility) === 'private'
            ? `<svg class="find-card-vis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
            : normalizeObservationVisibility(obs.visibility) === 'friends'
              ? `<svg class="find-card-vis-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
              : ''
        const sporesIcon = obs.has_spores
          ? `<svg class="find-card-vis-icon" style="stroke: var(--amber);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="4" ry="8" transform="rotate(30 12 12)"/></svg>`
          : ''
        const locText = obs._pendingSync ? _pendingStatusText(obs) : loc

        const metaLead = obs._pendingSync
          ? `<span class="find-card-loc-text">${_esc(_pendingStatusText(obs))}</span>`
          : loc
            ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span class="find-card-loc-text">${loc}</span>`
            : '<span></span>'

        if (variant === 'two') {
          const photoInner = imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--two">
            <div class="find-card find-card--two${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--two">${photoInner}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
              <div class="find-card-body find-card-body--two">
                ${compactNameHtml}
                ${authorMeta}
                ${locText || statusIcon || sporesIcon ? `<div class="find-card-loc">
                  ${metaLead}
                  ${sporesIcon}${statusIcon}${_deleteQueueBtn(obs)}
                </div>` : ''}
              </div>
            </div>
          </div>`
          return
        }

        if (variant === 'three') {
          const photoInner = imageHtml(
            obs._pendingSync ? _pendingImageSource(obs) : imageData[obs.id],
            '',
            'find-card-photo-placeholder'
          )
          html += `<div class="find-card-wrap find-card-wrap--three">
            <div class="find-card find-card--three${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
              <div class="find-card-photo-wrap find-card-photo-wrap--three">${photoInner}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--card observation-author-chip--compact' })}</div>
              <div class="find-card-body find-card-body--three">
                ${compactNameHtml}
                ${obs._pendingSync ? `<div class="find-card-loc">${sporesIcon}${statusIcon}${_deleteQueueBtn(obs)}</div>` : ''}
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
          ? imageHtml(_pendingImageSource(obs), '', 'find-card-photo-placeholder')
          : cardImg?.second
            ? `<div class="find-card-polaroid">
                <div class="find-card-polaroid-frame">${imageHtml(cardImg.first, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
                <div class="find-card-polaroid-frame">${imageHtml(cardImg.second, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
              </div>`
            : cardImg?.first
              ? `<div class="find-card-polaroid find-card-polaroid--single">
                  <div class="find-card-polaroid-frame find-card-polaroid-frame--single">${imageHtml(cardImg.first, 'find-card-polaroid-img', 'find-card-polaroid-empty')}</div>
                </div>`
              : imageHtml(cardImg, '', 'find-card-photo-placeholder')

        html += `<div class="find-card-wrap">
          <div class="find-card${obs._pendingSync ? ' find-card--pending' : ''}" data-id="${obs.id}">
            <div class="find-card-photo-wrap">${photoWrapInner}${_draftBadge(obs)}${_authorChip(obs, { sizeClass: 'observation-author-chip--card' })}</div>
            <div class="find-card-body">
              <div class="find-card-name-row">${nameHtml}${countBadge}</div>
              ${authorMeta}
              ${locText || statusIcon || sporesIcon ? `<div class="find-card-loc">
                ${metaLead}
                ${sporesIcon}${statusIcon}${_deleteQueueBtn(obs)}
              </div>` : ''}
            </div>
          </div>
        </div>`
      })

      html += '</div>'
    })
    html += '</div>'
    html += _findsFooterHtml(currentScope)
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
    wireImageFallback(list)
  })
}
