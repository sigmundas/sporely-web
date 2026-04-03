import { supabase } from '../supabase.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { showAuthOverlay } from './auth.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { fetchFirstImages } from '../images.js'
import { openFindDetail } from './find_detail.js'
import { openImportPicker } from './import_review.js'

export async function initHome() {
  document.getElementById('qa-new-obs').addEventListener('click', () => navigate('capture'))
  document.getElementById('ac-view-obs').addEventListener('click', () => navigate('finds'))
  document.getElementById('ac-import').addEventListener('click', openImportPicker)
  document.getElementById('recent-history-link').addEventListener('click', () => navigate('finds'))

  await refreshHome()
}

export async function refreshHome() {
  await Promise.all([loadRecentFinds(), loadRecentComments(), loadStats(), checkSyncStatus()])
}

// ── Mixed feed ────────────────────────────────────────────────────────────────

async function loadRecentFinds() {
  const list = document.getElementById('recent-finds-list')
  if (!state.user) { list.innerHTML = ''; return }

  // Fetch mine and friends' latest in parallel
  const [myRes, friendRes] = await Promise.all([
    supabase
      .from('observations')
      .select('id, date, genus, species, common_name, gps_latitude, gps_longitude, location')
      .eq('user_id', state.user.id)
      .order('date', { ascending: false })
      .limit(3),
    supabase
      .from('observations_friend_view')
      .select('id, date, genus, species, common_name, gps_latitude, gps_longitude, location')
      .neq('user_id', state.user.id)
      .order('date', { ascending: false })
      .limit(3),
  ])

  const mine    = (myRes.data    || []).map(o => ({ ...o, _owner: 'mine' }))
  const friends = (friendRes.data || []).map(o => ({ ...o, _owner: 'friend' }))

  // Merge and sort by date, take top 5
  const combined = [...mine, ...friends]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5)

  if (!combined.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">No observations yet.</p>`
    return
  }

  const imageUrls = await fetchFirstImages(combined.map(o => o.id))

  list.innerHTML = combined.map(obs => {
    const latin       = obs.genus && obs.species ? `${obs.genus} ${obs.species}` : obs.genus
    const displayName = obs.common_name || latin || 'Unidentified'
    const subtitle    = obs.common_name && latin ? latin : null
    const isIdentified = !!(obs.genus || obs.common_name)
    const loc    = obs.location || (
      obs.gps_latitude && obs.gps_longitude
        ? `${obs.gps_latitude.toFixed(2)}°N, ${obs.gps_longitude.toFixed(2)}°E`
        : '—'
    )
    const imgUrl = imageUrls[obs.id]
    const thumb  = imgUrl
      ? `<img class="find-thumb" src="${imgUrl}" loading="lazy" alt="">`
      : `<div class="find-thumb-placeholder">🍄</div>`

    const dot = `<div class="find-owner-dot ${obs._owner}"></div>`

    return `<div class="find-row" data-id="${obs.id}" style="cursor:pointer">
      ${thumb}
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
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">Could not load comments.</p>`
    return
  }

  // Also fetch comments that mention the current user
  const { data: mentionData } = await supabase
    .from('comments')
    .select('id, body, created_at, user_id, observation_id')
    .contains('mentioned_user_ids', [state.user.id])
    .order('created_at', { ascending: false })
    .limit(3)

  // Merge and deduplicate by id, sort by created_at desc, limit 5
  const seen = new Set((data || []).map(c => c.id))
  const merged = [...(data || [])]
  for (const c of (mentionData || [])) {
    if (!seen.has(c.id)) { seen.add(c.id); merged.push(c) }
  }
  merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const combined = merged.slice(0, 5)

  if (!combined.length) {
    list.innerHTML = `<p style="color:var(--text-dim);font-size:13px;padding:12px 0">No comments yet.</p>`
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
  const imageUrls = obsIds.length ? await fetchFirstImages(obsIds) : {}

  list.innerHTML = combined.map(comment => {
    const { name, initial } = getCommentAuthor(authorMap[comment.user_id])
    const date = new Date(comment.created_at).toLocaleDateString('no-NO', { day: 'numeric', month: 'short' })
    const obs = obsMap[comment.observation_id]
    const imgUrl = imageUrls[comment.observation_id]
    const species = obs
      ? (obs.common_name || (obs.genus && obs.species ? `${obs.genus} ${obs.species}` : obs.genus) || '')
      : ''
    const thumb = imgUrl
      ? `<img class="comment-obs-thumb" src="${imgUrl}" loading="lazy" alt="">`
      : (obs ? `<div class="comment-obs-thumb comment-obs-placeholder">🍄</div>` : '')

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
}

// ── Quick stats ───────────────────────────────────────────────────────────────

async function loadStats() {
  const uid = state.user?.id
  if (!uid) return

  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)

  const [{ count: obsCount }, { data: sp }, friendRes] = await Promise.all([
    supabase.from('observations').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    supabase.from('observations').select('genus, species').eq('user_id', uid).not('genus', 'is', null),
    supabase.from('observations_friend_view')
      .select('user_id')
      .gte('date', weekAgo.toISOString().slice(0, 10)),
  ])

  document.getElementById('hstat-obs').textContent =
    obsCount ?? '—'
  document.getElementById('hstat-sp').textContent =
    new Set((sp || []).map(o => `${o.genus}|${o.species}`)).size || 0
  document.getElementById('hstat-friends').textContent =
    new Set((friendRes.data || []).map(o => o.user_id)).size || 0
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
