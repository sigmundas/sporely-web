import { supabase } from '../supabase.js'
import { formatDate, t } from '../i18n.js'
import { state } from '../state.js'
import { getEffectiveCameraLabel, openPreferredCamera } from '../camera-actions.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { fetchFirstImages } from '../images.js'
import { formatScientificName } from '../artsorakel.js'
import { showToast } from '../toast.js'
import { openFindDetail } from './find_detail.js'
import { openPhotoImportPicker } from './import_review.js'
import { openFinds } from './finds.js'
import { imageHtml as _imageHtml, wireImageFallback as _wireImageFallback } from '../image-helpers.js'
import { mark as _bootMark } from '../boot-timings.js'
import { AUTH_STATE, getAuthState } from '../auth-state.js'
import { readHomeCache, writeHomeCache } from '../home-cache.js'

function _isDebugCommentQueryEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-comment-queries') === 'true'
  } catch (_) {
    return false
  }
}

const MENTION_PREVIEW_CACHE_KEY = 'sporely-mention-preview-unavailable'
let _mentionPreviewAvailable = null
let _friendRequestMenuListenerBound = false

function _debugCommentQuery(message, details = {}) {
  if (!_isDebugCommentQueryEnabled()) return
  console.debug(`[home-comments] ${message}`, details)
}

function _isMentionPreviewUnavailablePermanently() {
  try {
    return globalThis.sessionStorage?.getItem(MENTION_PREVIEW_CACHE_KEY) === 'true'
  } catch (_) {
    return false
  }
}

function _markMentionPreviewUnavailable() {
  _mentionPreviewAvailable = false
  try {
    globalThis.sessionStorage?.setItem(MENTION_PREVIEW_CACHE_KEY, 'true')
  } catch (_) {}
}

function _canLoadMentionPreview() {
  if (_mentionPreviewAvailable === false) return false
  if (_isMentionPreviewUnavailablePermanently()) {
    _mentionPreviewAvailable = false
    return false
  }
  return true
}

function _isMissingMentionPreviewSupport(error) {
  const message = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  return (
    message.includes('mentioned_user_ids')
    || message.includes('could not find the table')
    || message.includes('schema cache')
    || message.includes('does not exist')
    || error?.code === 'PGRST205'
  )
}

// UI-only bootstrap for the Home screen. Bind interaction handlers; do NOT
// trigger the network. Startup owns exactly one `refreshHome()` — kicking off
// another one from `initHome()` would double-hydrate every launch.
export function initHome() {
  document.getElementById('home-fab').addEventListener('click', () => openPreferredCamera('home-fab'))
  document.getElementById('ac-camera')?.addEventListener('click', () => openPreferredCamera('ac-camera'))
  document.getElementById('ac-import').addEventListener('click', () => openPhotoImportPicker())
  document.getElementById('recent-history-link').addEventListener('click', () => {
    openFinds('feed', { resetSearch: true, secondaryScope: 'public' })
  })
  _syncCameraAction()

  document.getElementById('hstat-obs-btn').addEventListener('click', () => openFinds('mine', { resetSearch: true, resetFilters: true }))
  document.getElementById('hstat-sp-btn').addEventListener('click', () => openFinds('mine', { resetSearch: true, resetFilters: true, groupBySpecies: true }))
  document.getElementById('hstat-spores-btn')?.addEventListener('click', () => openFinds('mine', { resetSearch: true, resetFilters: true }))

  // EXIF warning modal events for Android web
  const warningOverlay = document.getElementById('exif-warning-overlay')
  const dontShowCheckbox = document.getElementById('exif-warning-dont-show')
  const browseInput = document.getElementById('import-browse-input')

  document.getElementById('exif-warning-cancel')?.addEventListener('click', () => {
    warningOverlay.style.display = 'none'
  })
  document.getElementById('exif-warning-continue')?.addEventListener('click', () => {
    if (dontShowCheckbox?.checked) localStorage.setItem('sporely-hide-exif-warning', '1')
    warningOverlay.style.display = 'none'
    browseInput?.click()
  })
}

function _syncCameraAction() {
  const camera = document.getElementById('ac-camera')
  if (!camera) return
  const label = camera.querySelector('.action-card-label')
  if (label) label.textContent = getEffectiveCameraLabel()
}

// ── Cache-first orchestration (Stage B2a) ────────────────────────────────────
//
// Home is split into fetch*Model() (network → plain data) and render*()
// (plain data → DOM) pairs so the same renderers serve both the persisted
// cache and fresh online data:
//
//   readHomeCache(userId) → renderHomeModel(model)          [local-only]
//   fetch*Model()         → render*() → writeHomeCache(...) [online]
//
// While the auth state is AUTHENTICATED_CACHED or
// AUTHENTICATED_REAUTH_REQUIRED, refreshHome/refreshHomeSafe perform ZERO
// network hydration and re-render from the cache instead — Home Supabase
// traffic only resumes once the app returns to AUTHENTICATED_COMPLETE.

const _OFFLINE_GATED_AUTH_STATES = new Set([
  AUTH_STATE.AUTHENTICATED_CACHED,
  AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED,
])

function _isHomeNetworkGated() {
  return _OFFLINE_GATED_AUTH_STATES.has(getAuthState().state)
}

// Tracks which sections currently show real content (cached or fresh) for
// the current user, so a failed online refresh keeps good content visible
// instead of replacing it with an inline error (Stage B2a error semantics).
let _renderedForUserId = null
const _renderedSections = new Set()

function _sectionTrackingUserId() {
  return state.user?.id || null
}

function _markSectionRendered(section) {
  const uid = _sectionTrackingUserId()
  if (_renderedForUserId !== uid) {
    _renderedForUserId = uid
    _renderedSections.clear()
  }
  _renderedSections.add(section)
}

function _hasRenderedSection(section) {
  return _renderedForUserId === _sectionTrackingUserId() && _renderedSections.has(section)
}

// Called by main.js when the signed-in user changes / signs out so stale
// "this section already has content" flags cannot suppress error states for
// the next account.
export function resetHomeSectionTracking() {
  _renderedForUserId = null
  _renderedSections.clear()
}

// Renders an assembled Home model (cached or fresh). Only sections present
// in the model are touched.
export function renderHomeModel(model) {
  if (!model || typeof model !== 'object') return
  if (model.recentFinds) renderRecentFinds(model.recentFinds)
  if (model.friendRequests) renderFriendRequests(model.friendRequests)
  if (model.recentComments) renderRecentComments(model.recentComments)
  if (model.stats) renderStats(model.stats)
}

// Local-only cached render for boot / offline navigation. Reads the given
// user's persisted Home model and renders it; when no cache exists, renders
// offline empty states so the shell is never a permanent skeleton. Returns
// true when a cached model was rendered.
export async function renderHomeFromCache(userId, { emptyStatesWhenMissing = true, timeoutMs } = {}) {
  const uid = String(userId || '').trim()
  if (!uid) return false
  _bootMark('home-cache-read-started')
  let cached = null
  try {
    // `timeoutMs` lets the caller bound how long this read may take. The
    // online boot path passes a short budget because the network refresh is
    // sequenced after this render — a hung IndexedDB must cost milliseconds
    // there, not seconds. Offline paths use the store's default: the cache
    // is the only content, so a longer wait is the better trade.
    cached = await readHomeCache(uid, timeoutMs !== undefined ? { timeoutMs } : {})
  } catch (err) {
    console.warn('Home cache read failed:', err)
  }
  _bootMark('home-cache-read-completed', { hit: !!cached })
  // Never render one user's cache while another user is current.
  if (state.user?.id && state.user.id !== uid) return false
  if (cached?.model) {
    renderHomeModel(cached.model)
    _bootMark('home-cache-rendered', { ageMs: cached.ageMs ?? -1 })
    return true
  }
  if (emptyStatesWhenMissing) renderHomeOfflineEmptyStates()
  return false
}

// No cache + no network: replace boot skeletons with a quiet offline notice
// so the user is not staring at shimmering placeholders forever. Sections
// that render nothing when empty (friend requests) stay hidden.
export function renderHomeOfflineEmptyStates() {
  const message = _esc(t('home.offlineNoCache'))
  for (const id of ['recent-finds-list', 'recent-comments-list']) {
    const el = document.getElementById(id)
    if (el && !_hasRenderedSection(id)) {
      el.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">${message}</p>`
    }
  }
  const frList = document.getElementById('home-friend-requests-list')
  const frSection = document.getElementById('home-friend-requests-title')?.closest('.section-header')
  if (frList && frSection && !_hasRenderedSection('friendRequests')) {
    frList.innerHTML = ''
    frSection.style.display = 'none'
  }
}

// Network hydration for Home. The header avatar/initials are refreshed by
// the auth-resolution path (or by explicit navigation), NOT here — routing
// that through refreshHome() previously double-fired every navigation and
// every startup.
//
// After the app shell has been revealed (Stage A reveal-before-hydrate work),
// a section-level failure must not throw the user back behind the auth
// overlay. `refreshHomeSafe` wraps every loader and renders an inline error
// state (or preserves already-rendered cached content) instead of
// propagating; `refreshHome` additionally rethrows the first failure for
// callers that need to await a successful refresh.
export async function refreshHome() {
  const results = await refreshHomeSafe()
  const rejected = results.find(res => res?.status === 'rejected')
  if (rejected) throw rejected.reason
}

function _renderSectionError(id, message) {
  const el = document.getElementById(id)
  if (!el) return
  const safe = _esc(message || t('common.error'))
  el.innerHTML = `<p class="home-section-error" style="color:var(--text-dim);font-size:13px;padding:12px 0">${safe}</p>`
}

// Section registry for the online refresh: fetcher → renderer → persisted
// model key → DOM container for inline errors (null = no visible list).
const _HOME_SECTIONS = [
  { key: 'recentFinds', fetch: fetchRecentFindsModel, render: renderRecentFinds, errorContainerId: 'recent-finds-list' },
  { key: 'friendRequests', fetch: fetchFriendRequestsModel, render: renderFriendRequests, errorContainerId: 'home-friend-requests-list' },
  { key: 'recentComments', fetch: fetchRecentCommentsModel, render: renderRecentComments, errorContainerId: 'recent-comments-list' },
  { key: 'stats', fetch: fetchStatsModel, render: renderStats, errorContainerId: null },
]

// Exactly ONE Home network hydration per call: every section fetch runs in
// parallel, fulfilled sections render (and are persisted), rejected sections
// keep their currently-rendered cached/fresh content when they have any.
// While the auth state is cached/offline, this performs ZERO network calls
// and re-renders from the local cache instead.
export async function refreshHomeSafe() {
  _syncCameraAction()

  if (_isHomeNetworkGated()) {
    // Offline/cached mode: never hit Supabase from Home. Re-render whatever
    // the cache holds so navigation back to Home stays populated.
    const uid = state.user?.id
    if (uid) await renderHomeFromCache(uid)
    return []
  }

  const uid = state.user?.id
  if (!uid) return []

  _bootMark('home-refresh-start')
  _bootMark('home-network-refresh-started')

  const settled = await Promise.allSettled([
    ..._HOME_SECTIONS.map(section => section.fetch()),
    checkSyncStatus(),
  ])

  const freshSections = {}
  _HOME_SECTIONS.forEach((section, i) => {
    const res = settled[i]
    if (res.status === 'fulfilled') {
      try {
        section.render(res.value)
        freshSections[section.key] = res.value
      } catch (err) {
        console.warn(`Home section render failed (${section.key}):`, err)
      }
      return
    }
    console.warn(`Home section refresh failed (${section.key}):`, res.reason)
    // Cached (or previously fresh) content beats an error message. Only
    // render the inline error when the section has nothing to show.
    if (section.errorContainerId && !_hasRenderedSection(section.key)) {
      _renderSectionError(
        section.errorContainerId,
        t('common.errorPrefix', { message: res.reason?.message || t('common.error') }),
      )
    }
  })

  _bootMark('home-network-refresh-completed', {
    fresh: Object.keys(freshSections).length,
    failed: _HOME_SECTIONS.length - Object.keys(freshSections).length,
  })
  _bootMark('home-refresh-end')

  // Persist in the background; a cache write must never delay or fail the
  // refresh itself.
  void _persistFreshHomeSections(uid, freshSections).catch(err => {
    console.warn('Home cache persist failed:', err)
  })

  return settled
}

// Cache-write policy (Stage B2a): only trustworthy fresh data is written.
//   * Nothing is written unless at least one section fetched successfully.
//   * Sections that failed keep their previous cached value (merge), so a
//     temporary network failure can never destroy a good offline cache.
//   * Writes are userId-gated and require AUTHENTICATED_COMPLETE — a
//     cached/offline session never overwrites the persisted model.
async function _persistFreshHomeSections(userId, freshSections) {
  const keys = Object.keys(freshSections || {})
  if (!keys.length) return
  const auth = getAuthState()
  if (auth.state !== AUTH_STATE.AUTHENTICATED_COMPLETE) return
  if (auth.userId !== userId || state.user?.id !== userId) return

  const persistable = {}
  if (freshSections.recentFinds) persistable.recentFinds = _persistableRecentFinds(freshSections.recentFinds)
  if (freshSections.friendRequests) persistable.friendRequests = _persistableFriendRequests(freshSections.friendRequests)
  if (freshSections.recentComments) persistable.recentComments = _persistableRecentComments(freshSections.recentComments)
  if (freshSections.stats) persistable.stats = freshSections.stats

  const existing = await readHomeCache(userId)
  const model = { ...(existing?.model || {}), ...persistable }
  const ok = await writeHomeCache(userId, model)
  if (ok) _bootMark('home-cache-write-completed', { sections: keys.length })
}

// ── Persistable transforms ────────────────────────────────────────────────────
//
// The in-memory model may carry transport-bound values that render fine
// online but must not be persisted:
//   * `protectedUrl` — authorized worker URL that requires a live session.
//   * signed URLs (`?token=` / `/object/sign/`) — expire; avatars from
//     `_loadProfileMap` are signed.
// The persisted image shape keeps the stable media `key` so Stage B3 can
// later resolve it against a user-scoped blob cache; offline, a missing
// primaryUrl degrades to the mushroom placeholder.

function _durableUrlOrNull(url) {
  const value = String(url || '').trim()
  if (!value) return null
  if (value.startsWith('data:image/')) return value
  if (!/^https?:\/\//i.test(value)) return null
  if (/[?&]token=/.test(value)) return null
  if (/\/object\/sign\//.test(value)) return null
  return value
}

function _persistableImageSource(source) {
  if (!source) return null
  return {
    key: source.key || '',
    primaryUrl: _durableUrlOrNull(source.primaryUrl),
    fallbackUrl: _durableUrlOrNull(source.fallbackUrl),
  }
}

function _persistableProfileMap(profiles) {
  return Object.fromEntries(Object.entries(profiles || {}).map(([id, profile]) => [id, {
    ...profile,
    avatar_url: _durableUrlOrNull(profile?.avatar_url),
  }]))
}

function _persistableRecentFinds(model) {
  return {
    items: (model.items || []).map(item => ({ ...item, image: _persistableImageSource(item.image) })),
    profiles: _persistableProfileMap(model.profiles),
  }
}

function _persistableFriendRequests(model) {
  return {
    pending: model.pending || [],
    accepted: model.accepted || [],
    profiles: _persistableProfileMap(model.profiles),
  }
}

function _persistableRecentComments(model) {
  return {
    items: model.items || [],
    authors: model.authors || {},
    observations: model.observations || {},
    images: Object.fromEntries(Object.entries(model.images || {}).map(([obsId, source]) => [
      obsId, _persistableImageSource(source),
    ]).filter(([, source]) => source)),
  }
}

// ── Mixed feed ────────────────────────────────────────────────────────────────

async function fetchRecentFindsModel() {
  if (!state.user) return { items: [], profiles: {} }

  // Fetch mine and friends' latest by upload/created time in parallel
  const [myRes, friendRes] = await Promise.all([
    supabase
      .from('observations')
      .select('id, user_id, date, created_at, genus, species, common_name, gps_latitude, gps_longitude, location, visibility')
      .eq('user_id', state.user.id)
      .order('created_at', { ascending: false })
      .limit(3),
    supabase
      .from('observations_friend_view')
      .select('id, user_id, date, created_at, genus, species, common_name, gps_latitude, gps_longitude, location, visibility')
      .neq('user_id', state.user.id)
      .order('created_at', { ascending: false })
      .limit(3),
  ])

  if (myRes.error && friendRes.error) throw myRes.error

  const mine    = (myRes.data    || []).map(o => ({ ...o, _owner: 'mine' }))
  const friends = (friendRes.data || []).map(o => ({ ...o, _owner: 'friend' }))

  // Merge and sort by upload time, take top 4
  const combined = [...mine, ...friends]
    .sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date))
    .slice(0, 4)

  if (!combined.length) return { items: [], profiles: {} }

  const profileMap = await _loadProfileMap(combined)
  const imageUrls = await fetchFirstImages(combined.map(o => o.id), { variant: 'medium' })

  return {
    items: combined.map(obs => ({ ...obs, image: imageUrls[obs.id] || null })),
    profiles: profileMap,
  }
}

function renderRecentFinds(model) {
  const list = document.getElementById('recent-finds-list')
  if (!list) return
  const items = model?.items || []
  const profileMap = model?.profiles || {}

  if (!items.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">${t('home.noObservations')}</p>`
    _markSectionRendered('recentFinds')
    return
  }

  list.innerHTML = items.map(obs => {
    const latin       = formatScientificName(obs.genus || '', obs.species || '')
    const displayName = obs.common_name || latin || t('home.unidentified')
    const subtitle    = obs.common_name && latin ? latin : null
    const isIdentified = !!(latin || obs.common_name)
    const loc    = obs.location || (
      obs.gps_latitude && obs.gps_longitude
        ? `${obs.gps_latitude.toFixed(2)}°N, ${obs.gps_longitude.toFixed(2)}°E`
        : '—'
    )
    const thumb = _imageHtml(
      obs.image,
      'find-thumb',
      '<div class="find-thumb-placeholder">🍄</div>',
    )
    const dot = `<div class="find-owner-dot ${obs._owner}"></div>`
    const authorLabel = _homeAuthorLabel(obs, profileMap)

    return `<div class="find-row" data-id="${obs.id}" style="cursor:pointer">
      <div class="find-thumb-wrap">${thumb}</div>
      <div class="find-meta">
        <div class="find-common${isIdentified ? '' : ' unidentified'}" style="display:flex;align-items:center;gap:5px">${dot}${displayName}</div>
        <div class="find-meta-line">
          ${subtitle ? `<div class="find-latin">${subtitle}</div>` : '<div class="find-latin find-latin--empty"></div>'}
          ${authorLabel ? `<div class="find-owner-name">${authorLabel}</div>` : ''}
        </div>
        <div class="find-location">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${loc}
        </div>
      </div>
    </div>`
  }).join('')

  list.querySelectorAll('.find-row[data-id]').forEach(row => {
    row.addEventListener('click', () => openFindDetail(row.dataset.id))
  })
  _wireImageFallback(list)
  _markSectionRendered('recentFinds')
}

async function fetchFriendRequestsModel() {
  if (!state.user) return { pending: [], accepted: [], profiles: {} }

  const { data: requests, error } = await supabase
    .from('friendships')
    .select('id, requester_id, addressee_id, status, created_at, updated_at')
    .eq('addressee_id', state.user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  const { data: acceptedRows, error: acceptedError } = await supabase
    .from('friendships')
    .select('id, requester_id, addressee_id, status, created_at, updated_at')
    .eq('requester_id', state.user.id)
    .eq('status', 'accepted')
    .order('updated_at', { ascending: false })

  if (error) throw error
  if (acceptedError) {
    console.warn('Accepted friend notifications load failed:', acceptedError.message)
  }

  const pending = requests || []
  const accepted = _filterUnseenAcceptedFriendNotifications(acceptedRows || [])
  if (!pending.length && !accepted.length) {
    return { pending: [], accepted: [], profiles: {} }
  }

  const requesterIds = [...new Set([
    ...pending.map(req => req.requester_id),
    ...accepted.map(req => req.addressee_id),
  ])]
  const { data: profiles } = await supabase
    .from('public_profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', requesterIds)
  const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]))

  return { pending, accepted, profiles: profileMap }
}

function renderFriendRequests(model) {
  const list = document.getElementById('home-friend-requests-list')
  const section = document.getElementById('home-friend-requests-title')?.closest('.section-header')
  if (!list || !section) return

  const pending = model?.pending || []
  const accepted = model?.accepted || []
  const profileMap = model?.profiles || {}

  if (!pending.length && !accepted.length) {
    list.innerHTML = ''
    section.style.display = 'none'
    _markSectionRendered('friendRequests')
    return
  }

  section.style.display = ''
  list.innerHTML = [
    ...pending.map(req => _renderFriendRequestRow(req, profileMap)),
    ...accepted.map(req => _renderFriendAcceptedRow(req, profileMap)),
  ].join('')

  _bindFriendRequestMenuInteractions(list, profileMap)
  _bindFriendAcceptedRows(list, profileMap)
  _markSectionRendered('friendRequests')
}

function _renderFriendRequestRow(req, profileMap) {
  const profile = profileMap[req.requester_id] || {}
  const displayName = profile.display_name || profile.username || t('common.unknown')
  const username = profile.username ? `@${profile.username}` : ''
  const initials = _esc(_initials(profile.display_name || profile.username || '?'))
  const avatar = profile.avatar_url && /^https?:\/\//i.test(String(profile.avatar_url))
    ? `<img class="home-friend-request-avatar" src="${_esc(profile.avatar_url)}" alt="" loading="lazy" decoding="async">`
    : `<div class="home-friend-request-avatar home-friend-request-avatar--fallback">${initials}</div>`
  const requestDate = req.created_at ? formatDate(req.created_at, { day: 'numeric', month: 'short' }) : ''
  return `
    <div class="home-comment-row home-friend-request-row" data-request-id="${_esc(req.id)}" data-user-id="${_esc(req.requester_id)}" data-kind="pending">
      <div class="comment-obs-thumb-wrap">${avatar}</div>
      <div class="home-comment-body">
        <div class="home-comment-meta">
          <span class="home-comment-author">${_esc(displayName)}</span>
          ${username ? `<span class="home-comment-date">${_esc(username)}</span>` : ''}
          ${requestDate ? `<span class="home-comment-date">${_esc(requestDate)}</span>` : ''}
        </div>
        <div class="home-comment-text">${_esc(t('home.friendRequestNote'))}</div>
      </div>
      <div class="home-friend-request-actions">
        <button class="home-friend-request-menu-btn" type="button" aria-label="${_esc(t('home.friendRequestActions'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <div class="home-friend-request-menu" style="display:none">
          <button class="home-friend-request-menu-item" data-action="accept" type="button">${_esc(t('profile.accept'))}</button>
          <button class="home-friend-request-menu-item" data-action="decline" type="button">${_esc(t('profile.decline'))}</button>
        </div>
      </div>
    </div>
  `
}

function _renderFriendAcceptedRow(req, profileMap) {
  const profile = profileMap[req.addressee_id] || {}
  const displayName = profile.display_name || profile.username || t('common.unknown')
  const username = profile.username ? `@${profile.username}` : ''
  const initials = _esc(_initials(profile.display_name || profile.username || '?'))
  const avatar = profile.avatar_url && /^https?:\/\//i.test(String(profile.avatar_url))
    ? `<img class="home-friend-request-avatar" src="${_esc(profile.avatar_url)}" alt="" loading="lazy" decoding="async">`
    : `<div class="home-friend-request-avatar home-friend-request-avatar--fallback">${initials}</div>`
  const acceptedDate = req.updated_at ? formatDate(req.updated_at, { day: 'numeric', month: 'short' }) : ''
  return `
    <div class="home-comment-row home-friend-request-row home-friend-request-row--accepted" data-kind="accepted" data-request-id="${_esc(req.id)}" data-user-id="${_esc(req.addressee_id)}">
      <div class="comment-obs-thumb-wrap">${avatar}</div>
      <div class="home-comment-body">
        <div class="home-comment-meta">
          <span class="home-comment-author">${_esc(displayName)}</span>
          ${username ? `<span class="home-comment-date">${_esc(username)}</span>` : ''}
          ${acceptedDate ? `<span class="home-comment-date">${_esc(acceptedDate)}</span>` : ''}
        </div>
        <div class="home-comment-text">${_esc(t('home.friendAccepted'))}</div>
      </div>
      <div class="home-friend-request-status">
        <svg class="home-friend-request-heart" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
      </div>
    </div>
  `
}

function _acceptedFriendSeenKey() {
  return `sporely-seen-friend-accepted:${state.user?.id || ''}`
}

function _loadSeenAcceptedFriendIds() {
  try {
    const raw = globalThis.localStorage?.getItem(_acceptedFriendSeenKey())
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.map(id => String(id || '').trim()).filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

function _saveSeenAcceptedFriendIds(ids) {
  try {
    globalThis.localStorage?.setItem(_acceptedFriendSeenKey(), JSON.stringify([...ids]))
  } catch {}
}

function _filterUnseenAcceptedFriendNotifications(rows) {
  const seen = _loadSeenAcceptedFriendIds()
  const unseen = []
  let changed = false
  for (const row of rows || []) {
    const rowId = String(row?.id || '').trim()
    if (!rowId) continue
    if (seen.has(rowId)) continue
    unseen.push(row)
    seen.add(rowId)
    changed = true
  }
  if (changed) _saveSeenAcceptedFriendIds(seen)
  return unseen
}

function _bindFriendRequestMenuInteractions(list, profileMap) {
  if (!list) return
  if (!_friendRequestMenuListenerBound) {
    _friendRequestMenuListenerBound = true
    document.addEventListener('click', event => {
      if (event.target.closest('.home-friend-request-row')) return
      document.querySelectorAll('.home-friend-request-menu').forEach(node => { node.style.display = 'none' })
    })
  }

  list.querySelectorAll('.home-friend-request-row').forEach(row => {
    if (row.dataset.kind !== 'pending') return
    row.addEventListener('click', event => {
      if (event.target.closest('.home-friend-request-actions')) return
      const userId = row.dataset.userId
      const profile = profileMap[userId] || {}
      openFinds('user', {
        userId,
        username: profile.username || null,
        displayName: profile.display_name || null,
        avatarUrl: profile.avatar_url || '',
        summaryLoaded: false,
        resetSearch: true,
        resetFilters: true,
      })
    })

    const menuBtn = row.querySelector('.home-friend-request-menu-btn')
    const menu = row.querySelector('.home-friend-request-menu')
    menuBtn?.addEventListener('click', event => {
      event.stopPropagation()
      const isOpening = menu.style.display === 'none' || !menu.style.display
      document.querySelectorAll('.home-friend-request-menu').forEach(node => { node.style.display = 'none' })
      if (!isOpening) return
      menu.style.display = 'block'
    })

    row.querySelectorAll('.home-friend-request-menu-item').forEach(btn => {
      btn.addEventListener('click', async event => {
        event.stopPropagation()
        menu.style.display = 'none'
        await _handleFriendRequestAction(row.dataset.requestId, row.dataset.userId, btn.dataset.action)
      })
    })
  })
}

function _bindFriendAcceptedRows(list, profileMap) {
  if (!list) return
  list.querySelectorAll('.home-friend-request-row[data-kind="accepted"]').forEach(row => {
    row.addEventListener('click', () => {
      const userId = row.dataset.userId
      const profile = profileMap[userId] || {}
      openFinds('user', {
        userId,
        username: profile.username || null,
        displayName: profile.display_name || null,
        avatarUrl: profile.avatar_url || '',
        summaryLoaded: false,
        resetSearch: true,
        resetFilters: true,
      })
    })
  })
}

async function _handleFriendRequestAction(requestId, userId, action) {
  const normalizedRequestId = String(requestId || '').trim()
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedRequestId || !normalizedUserId || !state.user?.id) return

  try {
    if (action === 'accept') {
      const { error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', normalizedRequestId)
      if (error) throw error
      showToast(t('profile.friendAccepted'))
    } else if (action === 'decline') {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', normalizedRequestId)
      if (error) throw error
      showToast(t('profile.friendRemoved'))
    } else {
      return
    }
    renderFriendRequests(await fetchFriendRequestsModel())
  } catch (error) {
    console.warn('Friend request action failed:', error)
    showToast(t('common.errorPrefix', { message: error?.message || t('common.error') }))
  }
}

async function fetchRecentCommentsModel() {
  if (!state.user) return { items: [], authors: {}, observations: {}, images: {} }

  _debugCommentQuery('latest comments view query', {
    userId: state.user.id,
    limit: 5,
    intent: 'load latest visible comments',
  })

  const { data, error } = await supabase
    .from('comments_community_view')
    .select('id, body, created_at, user_id, observation_id')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) throw error

  let mentionData = []
  if (_canLoadMentionPreview()) {
    _debugCommentQuery('mention preview view query', {
      userId: state.user.id,
      limit: 3,
      intent: 'load comments that mention the current user',
      filter: 'mentioned_user_ids contains auth user id',
    })

    try {
      const { data: mentionedRows, error: mentionError } = await supabase
        .from('comments_community_view')
        .select('id, body, created_at, user_id, observation_id, mentioned_user_ids')
        .contains('mentioned_user_ids', [state.user.id])
        .order('created_at', { ascending: false })
        .limit(3)
      if (mentionError) throw mentionError
      mentionData = mentionedRows || []
    } catch (mentionError) {
      if (_isMissingMentionPreviewSupport(mentionError)) {
        _markMentionPreviewUnavailable()
        _debugCommentQuery('mention preview unavailable; skipping future mention lookups', {
          userId: state.user.id,
          message: String(mentionError?.message || mentionError || ''),
        })
      } else {
        console.warn('Recent comments mention load failed:', mentionError.message)
      }
    }
  }

  // Merge and deduplicate by id, sort by created_at desc, limit 5
  const seen = new Set((data || []).map(c => c.id))
  const merged = [...(data || [])]
  for (const c of (mentionData || [])) {
    if (!seen.has(c.id)) { seen.add(c.id); merged.push(c) }
  }
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const combined = merged.slice(0, 5).map(({ mentioned_user_ids: _drop, ...c }) => c)

  if (!combined.length) return { items: [], authors: {}, observations: {}, images: {} }

  const authorMap = await fetchCommentAuthorMap(combined, state.user)

  const obsIds = [...new Set(combined.filter(c => c.observation_id).map(c => c.observation_id))]
  let obsMap = {}
  if (obsIds.length) {
    const { data: obsData } = await supabase
      .from('observations')
      .select('id, genus, species, common_name')
      .in('id', obsIds)
    ;(obsData || []).forEach(o => { obsMap[o.id] = o })
    const missingObsIds = obsIds.filter(id => !obsMap[id])
    if (missingObsIds.length) {
      const { data: publicObsData } = await supabase
        .from('observations_community_view')
        .select('id, genus, species, common_name')
        .in('id', missingObsIds)
      ;(publicObsData || []).forEach(o => { obsMap[o.id] = o })
    }
  }
  const imageUrls = obsIds.length ? await fetchFirstImages(obsIds, { variant: 'small' }) : {}

  return { items: combined, authors: authorMap, observations: obsMap, images: imageUrls }
}

function renderRecentComments(model) {
  const list = document.getElementById('recent-comments-list')
  if (!list) return
  const items = model?.items || []
  const authorMap = model?.authors || {}
  const obsMap = model?.observations || {}
  const imageUrls = model?.images || {}

  if (!items.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">${t('comments.none')}</p>`
    _markSectionRendered('recentComments')
    return
  }

  list.innerHTML = items.map(comment => {
    const { name, initial } = getCommentAuthor(authorMap[comment.user_id])
    const date = formatDate(comment.created_at, { day: 'numeric', month: 'short' })
    const obs = obsMap[comment.observation_id]
    const species = obs
      ? (obs.common_name || formatScientificName(obs.genus || '', obs.species || '') || '')
      : ''
    const thumb = obs
      ? _imageHtml(
        imageUrls[comment.observation_id],
        'comment-obs-thumb',
        '<div class="comment-obs-thumb comment-obs-placeholder">🍄</div>',
      )
      : ''

    return `<div class="home-comment-row" ${obs ? `data-obs-id="${obs.id}" style="cursor:pointer"` : ''}>
      ${thumb ? `<div class="comment-obs-thumb-wrap">${thumb}</div>` : `<div class="comment-avatar">${_esc(initial)}</div>`}
      <div class="home-comment-body">
        <div class="home-comment-meta">
          <span class="home-comment-author">${_esc(name)}</span>
          ${species ? `<span class="home-comment-species">${_esc(species)}</span>` : ''}
          <span class="home-comment-date">${date}</span>
        </div>
        <div class="home-comment-text">${_esc(comment.body)}</div>
      </div>
    </div>`
  }).join('')

  list.querySelectorAll('.home-comment-row[data-obs-id]').forEach(row => {
    row.addEventListener('click', () => openFindDetail(row.dataset.obsId))
  })
  _wireImageFallback(list)
  _markSectionRendered('recentComments')
}

// ── Quick stats ───────────────────────────────────────────────────────────────

async function fetchStatsModel() {
  const uid = state.user?.id
  if (!uid) return { observations: null, species: null, sporeMeasurements: null }

  const [obsRes, spRes, sporeRes] = await Promise.all([
    supabase.from('observations').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    supabase.from('observations').select('genus, species').eq('user_id', uid).not('genus', 'is', null),
    supabase.from('spore_measurements').select('*', { count: 'exact', head: true }).eq('user_id', uid),
  ])

  // Any failed sub-query fails the whole section — a partial result (for
  // example species silently computing to 0) must never render as truth or
  // overwrite a previously good cached value.
  const failed = obsRes.error || spRes.error || sporeRes.error
  if (failed) throw failed

  return {
    observations: obsRes.count ?? null,
    species: new Set((spRes.data || []).map(o => `${o.genus}|${o.species}`)).size || 0,
    sporeMeasurements: sporeRes.count ?? null,
  }
}

function renderStats(model) {
  const values = [
    ['hstat-obs', model?.observations],
    ['hstat-sp', model?.species],
    ['hstat-spores', model?.sporeMeasurements],
  ]
  for (const [id, value] of values) {
    const el = document.getElementById(id)
    if (el) el.textContent = value ?? '—'
  }
  _markSectionRendered('stats')
}

// ── Sync check ────────────────────────────────────────────────────────────────
//
// Online-only connectivity probe controlling the header "Sync" tag. This is
// deliberately NOT part of the cached Home model — it answers "can Supabase
// be reached right now", which a persisted snapshot cannot. Pending-upload
// state remains owned by the local sync queue (sync-queue.js), never by the
// Home cache.

async function checkSyncStatus() {
  const tag = document.getElementById('header-sync-tag')
  try {
    const { error } = await supabase.from('observations').select('id').limit(1)
    if (!error && tag) tag.style.display = 'flex'
  } catch {
    if (tag) tag.style.display = 'none'
  }
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _initials(value) {
  if (!value) return '?'
  return String(value)
    .replace(/^@/, '')
    .split(/[\s@.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join('') || '?'
}

async function _loadProfileMap(observations) {
  const userIds = [...new Set((observations || [])
    .map(obs => obs.user_id)
    .filter(uid => uid && uid !== state.user?.id))]

  if (!userIds.length) return {}

  const { data, error } = await supabase
    .from('public_profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', userIds)

  if (error) {
    console.warn('Could not load recent-find profiles:', error.message)
    return {}
  }

  const paths = userIds.map(uid => `${uid}/avatar.jpg`)
  const { data: signedData } = await supabase.storage.from('avatars').createSignedUrls(paths, 3600)
  const signedMap = {}
  if (signedData) {
    signedData.forEach(item => {
      if (item.signedUrl) signedMap[item.path.split('/')[0]] = item.signedUrl
    })
  }

  return Object.fromEntries((data || []).map(profile => {
    const normalizedUsername = _normalizeHomeUsername(profile.username)
    const normalizedProfile = {
      ...profile,
      username: normalizedUsername || profile.username || '',
      display_name: _normalizeHomeUsername(profile.display_name) || profile.display_name || '',
    }
    if (signedMap[profile.id]) normalizedProfile.avatar_url = signedMap[profile.id]
    return [profile.id, normalizedProfile]
  }))
}

function _homeAuthorLabel(obs, profileMap) {
  if (obs._owner === 'mine' || obs.user_id === state.user?.id) return ''
  const profile = profileMap[obs.user_id] || {};
  const username = _normalizeHomeUsername(profile.username)
  if (username) {
    return _homeAuthorPill(profile, username)
  }
  const label = _normalizeHomeUsername(profile.display_name) || t('common.unknown')
  return _homeAuthorPill(profile, label, true)
}

function _normalizeHomeUsername(value) {
  const raw = String(value || '').trim().replace(/^@+/, '')
  if (!raw) return ''
  return raw.split('@')[0].trim()
}

function _homeAuthorPill(profile, label, useDisplayName = false) {
  const avatar = _homeAuthorAvatarHtml(profile, label)
  const text = _esc(useDisplayName ? label : label)
  return `<span class="find-owner-name-pill">${avatar}<span class="find-owner-name-text">${text}</span></span>`
}

function _homeAuthorAvatarHtml(profile, label) {
  const initials = _esc(_initials(profile.username || profile.display_name || label || '?'))
  const avatarUrl = String(profile.avatar_url || '').trim()
  if (avatarUrl) {
    return `<img class="find-owner-name-avatar" src="${_esc(avatarUrl)}" alt="" loading="lazy" decoding="async">`
  }
  return `<span class="find-owner-name-avatar find-owner-name-avatar--fallback">${initials}</span>`
}
