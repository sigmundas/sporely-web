import { supabase } from '../supabase.js'
import { formatDate, t } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { getEffectiveCameraLabel, getEffectiveCameraMode, openPreferredCamera } from '../camera-actions.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { fetchFirstImages } from '../images.js'
import { formatScientificName } from '../artsorakel.js'
import { openFindDetail } from './find_detail.js'
import { openPhotoImportPicker } from './import_review.js'
import { openFinds } from './finds.js'
import { refreshHeaderProfileButtons } from './profile.js'

function _imageHtml(source, className, placeholderHtml) {
  if (!source?.primaryUrl) return placeholderHtml
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

export async function initHome() {
  document.getElementById('home-fab').addEventListener('click', openPreferredCamera)
  document.getElementById('ac-camera')?.addEventListener('click', openPreferredCamera)
  document.getElementById('ac-import').addEventListener('click', () => openPhotoImportPicker())
  document.getElementById('recent-history-link').addEventListener('click', () => navigate('finds'))
  _syncCameraAction()
  window.addEventListener('sporely-camera-mode-change', _syncCameraAction)

  document.getElementById('hstat-obs-btn').addEventListener('click', () => openFinds('mine'))
  document.getElementById('hstat-sp-btn').addEventListener('click', () => openFinds('mine', { groupBySpecies: true }))

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

  await refreshHome()
}

function _syncCameraAction() {
  const camera = document.getElementById('ac-camera')
  if (!camera) return
  camera.dataset.cameraMode = getEffectiveCameraMode()
  const label = camera.querySelector('.action-card-label')
  if (label) label.textContent = getEffectiveCameraLabel()
}

export async function refreshHome() {
  _syncCameraAction()
  await Promise.all([loadRecentFinds(), loadRecentComments(), loadStats(), checkSyncStatus(), refreshHeaderProfileButtons()])
}

// ── Mixed feed ────────────────────────────────────────────────────────────────

async function loadRecentFinds() {
  const list = document.getElementById('recent-finds-list')
  if (!state.user) { list.innerHTML = ''; return }

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

  const mine    = (myRes.data    || []).map(o => ({ ...o, _owner: 'mine' }))
  const friends = (friendRes.data || []).map(o => ({ ...o, _owner: 'friend' }))

  // Merge and sort by upload time, take top 4
  const combined = [...mine, ...friends]
    .sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date))
    .slice(0, 4)

  if (!combined.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">${t('home.noObservations')}</p>`
    return
  }

  const profileMap = await _loadProfileMap(combined)
  const imageUrls = await fetchFirstImages(combined.map(o => o.id), { variant: 'medium' })

  list.innerHTML = combined.map(obs => {
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
      imageUrls[obs.id],
      'find-thumb',
      '<div class="find-thumb-placeholder">🍄</div>',
    )
    const dot = `<div class="find-owner-dot ${obs._owner}"></div>`
    const authorChip = _homeAuthorChip(obs, profileMap)

    return `<div class="find-row" data-id="${obs.id}" style="cursor:pointer">
      <div class="find-thumb-wrap">${thumb}${authorChip}</div>
      <div class="find-meta">
        <div class="find-common${isIdentified ? '' : ' unidentified'}" style="display:flex;align-items:center;gap:5px">${dot}${displayName}</div>
        ${subtitle ? `<div class="find-latin">${subtitle}</div>` : ''}
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
}

async function loadRecentComments() {
  const list = document.getElementById('recent-comments-list')
  if (!list) return
  if (!state.user) { list.innerHTML = ''; return }

  const { data, error } = await supabase
    .from('comments')
    .select('id, body, created_at, user_id, observation_id')
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    console.warn('Recent comments load failed:', error.message)
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">${t('comments.couldNotLoad')}</p>`
    return
  }

  // Also fetch comments that mention the current user (column may not exist yet — ignore error)
  const { data: mentionData } = await supabase
    .from('comments')
    .select('id, body, created_at, user_id, observation_id')
    .contains('mentioned_user_ids', [state.user.id])
    .order('created_at', { ascending: false })
    .limit(3)
    .then(r => r.error?.message?.includes('mentioned_user_ids') ? { data: [] } : r)

  const { data: blocks } = await supabase
    .from('user_blocks')
    .select('blocked_id')
    .eq('blocker_id', state.user.id)
  const blockedIds = new Set((blocks || []).map(b => b.blocked_id))

  // Merge and deduplicate by id, sort by created_at desc, limit 5
  const seen = new Set((data || []).map(c => c.id))
  const merged = [...(data || [])]
  for (const c of (mentionData || [])) {
    if (!seen.has(c.id)) { seen.add(c.id); merged.push(c) }
  }
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const combined = merged.filter(c => !blockedIds.has(c.user_id)).slice(0, 5)

  if (!combined.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">${t('comments.none')}</p>`
    return
  }

  const authorMap = await fetchCommentAuthorMap(combined, state.user)

  const obsIds = [...new Set(combined.filter(c => c.observation_id).map(c => c.observation_id))]
  let obsMap = {}
  if (obsIds.length) {
    const { data: obsData } = await supabase
      .from('observations')
      .select('id, genus, species, common_name')
      .in('id', obsIds)
    ;(obsData || []).forEach(o => { obsMap[o.id] = o })
  }
  const imageUrls = obsIds.length ? await fetchFirstImages(obsIds, { variant: 'small' }) : {}

  list.innerHTML = combined.map(comment => {
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
}

// ── Quick stats ───────────────────────────────────────────────────────────────

async function loadStats() {
  const uid = state.user?.id
  if (!uid) return

  const [{ count: obsCount }, { data: sp }, sporeRes] = await Promise.all([
    supabase.from('observations').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    supabase.from('observations').select('genus, species').eq('user_id', uid).not('genus', 'is', null),
    supabase.from('spore_measurements').select('*', { count: 'exact', head: true }).eq('user_id', uid),
  ])

  if (sporeRes.error) {
    console.warn('Spore measurement stats load failed:', sporeRes.error.message)
  }

  document.getElementById('hstat-obs').textContent =
    obsCount ?? '—'
  document.getElementById('hstat-sp').textContent =
    new Set((sp || []).map(o => `${o.genus}|${o.species}`)).size || 0
  document.getElementById('hstat-spores').textContent =
    sporeRes.count ?? '—'
}

// ── Sync check ────────────────────────────────────────────────────────────────

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

async function _loadProfileMap(observations) {
  const userIds = [...new Set((observations || [])
    .map(obs => obs.user_id)
    .filter(uid => uid && uid !== state.user?.id))]

  if (!userIds.length) return {}

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', userIds)

  if (error) {
    console.warn('Could not load recent-find profiles:', error.message)
    return {}
  }

  return Object.fromEntries((data || []).map(profile => [profile.id, profile]))
}

function _homeAuthorChip(obs, profileMap) {
  if (obs._owner === 'mine' || obs.user_id === state.user?.id) return ''
  const profile = profileMap[obs.user_id]
  const label = profile?.username ? `@${profile.username}` : (profile?.display_name || t('common.unknown'))
  if (profile?.avatar_url) {
    return `<div class="observation-author-chip observation-author-chip--home" title="${_esc(label)}">
      <img src="${_esc(profile.avatar_url)}" alt="${_esc(label)}" loading="lazy" decoding="async">
    </div>`
  }
  const initial = String(profile?.username || profile?.display_name || '?').replace(/^@/, '').trim().charAt(0).toUpperCase() || '?'
  return `<div class="observation-author-chip observation-author-chip--initial observation-author-chip--home" title="${_esc(label)}">${_esc(initial)}</div>`
}
