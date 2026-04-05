import { supabase } from '../supabase.js'
import { state } from '../state.js'
import { navigate, goBack } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName, runArtsorakelForBlobs } from '../artsorakel.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { loadFinds } from './finds.js'
import { openPhotoViewer } from '../photo-viewer.js'

let currentObs    = null
let selectedTaxon = null
let currentObsIsOwner = false
let currentLocationOverride = null

export function initFindDetail() {
  const backBtn = document.getElementById('detail-back')
  backBtn.addEventListener('click', _goBack)
  document.getElementById('detail-cancel-btn').addEventListener('click', _goBack)
  document.getElementById('detail-save-btn').addEventListener('click', _save)
  document.getElementById('detail-delete-btn').addEventListener('click', _delete)
  document.getElementById('detail-current-location-btn').addEventListener('click', _useCurrentLocation)

  const input    = document.getElementById('detail-taxon-input')
  const dropdown = document.getElementById('detail-taxon-dropdown')
  let debounce

  input.addEventListener('input', () => {
    selectedTaxon = null
    document.getElementById('detail-title').textContent = input.value.trim() || 'Unknown species'
    clearTimeout(debounce)
    debounce = setTimeout(() => _searchTaxon(input.value.trim(), dropdown), 280)
  })
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none' }, 200)
  })

  document.getElementById('detail-ai-btn').addEventListener('click', _runAI)

  const commentInput = document.getElementById('comment-input')
  document.getElementById('comment-send-btn').addEventListener('click', _sendComment)
  commentInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') _sendComment()
  })
  _initMentions(commentInput)
}

export async function openFindDetail(obsId, exifDebug) {
  currentObs    = null
  selectedTaxon = null
  currentObsIsOwner = false
  currentLocationOverride = null

  // Update back button label — state.currentScreen is still the previous screen at this point
  const prevLabel = { home: 'Home', finds: 'Finds', map: 'Map' }[state.currentScreen] || 'Back'
  const backBtn = document.getElementById('detail-back')
  backBtn.childNodes[backBtn.childNodes.length - 1].textContent = ' ' + prevLabel

  _resetForm()
  navigate('find-detail')

  const { data: obs, error } = await supabase
    .from('observations')
    .select('id, user_id, date, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, visibility')
    .eq('id', obsId)
    .single()

  if (error || !obs) {
    showToast('Could not load observation')
    navigate('finds')
    return
  }

  currentObs = obs
  currentObsIsOwner = obs.user_id === state.user?.id
  _applyOwnershipMode(currentObsIsOwner)

  const displayName = formatDisplayName(obs.genus || '', obs.species || '', obs.common_name)
  const titleName = displayName.trim() || 'Unknown species'
  document.getElementById('detail-title').textContent = titleName
  document.getElementById('detail-taxon-input').value = displayName.trim()
  document.getElementById('detail-location').value    = obs.location  || ''
  document.getElementById('detail-habitat').value     = obs.habitat   || ''
  document.getElementById('detail-notes').value       = obs.notes     || ''
  document.getElementById('detail-uncertain').checked = !!obs.uncertain

  document.getElementById('detail-date').textContent = obs.date
    ? new Date(obs.date).toLocaleDateString('no-NO', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

  // Show capture time from EXIF if available
  const timeEl  = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (obs.captured_at) {
    const t = new Date(obs.captured_at)
    timeVal.textContent = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    timeEl.style.display = 'inline'
  } else {
    timeEl.style.display = 'none'
  }

  const coords = obs.gps_latitude && obs.gps_longitude
    ? `${obs.gps_latitude.toFixed(4)}° N, ${obs.gps_longitude.toFixed(4)}° E`
    : null
  const coordsEl = document.getElementById('detail-coords')
  if (coordsEl) coordsEl.textContent = coords || ''
  if (coordsEl) coordsEl.style.display = coords ? 'block' : 'none'

  // Set visibility radio
  const vis = obs.visibility || 'friends'
  const visRadio = document.querySelector(`input[name="detail-vis"][value="${vis}"]`)
  if (visRadio) visRadio.checked = true

  const { data: imgData } = await supabase
    .from('observation_images')
    .select('storage_path, sort_order')
    .eq('observation_id', obsId)
    .order('sort_order', { ascending: true })

  const gallery = document.getElementById('detail-gallery')
  gallery.innerHTML = ''

  if (imgData?.length) {
    const paths = imgData.map(i => i.storage_path)
    const { data: signed } = await supabase.storage
      .from('observation-images')
      .createSignedUrls(paths, 3600)

    ;(signed || []).forEach(s => {
      if (!s.signedUrl) return
      const img = document.createElement('img')
      img.className = 'detail-gallery-img'
      img.src       = s.signedUrl
      img.loading   = 'lazy'
      img.alt       = ''
      gallery.appendChild(img)
    })

    // Wire gallery images to photo viewer
    const galleryImgs = Array.from(gallery.querySelectorAll('img'))
    galleryImgs.forEach((el, idx) => {
      el.style.cursor = 'pointer'
      el.addEventListener('click', () => {
        openPhotoViewer(galleryImgs.map(i => i.src), idx)
      })
    })
  }

  // Load comments async (don't await)
  _loadComments(obsId)
}

async function _reverseGeocode(lat, lon) {
  try {
    const res = await fetch(
      `https://stedsnavn.artsdatabanken.no/v1/punkt?lat=${lat}&lng=${lon}&zoom=55`
    )
    if (!res.ok) return null
    const data = await res.json()
    return data?.navn || null
  } catch (_) {}
  return null
}

async function _useCurrentLocation() {
  if (!currentObsIsOwner) {
    showToast('Only the owner can overwrite the location')
    return
  }
  if (!state.gps) {
    showToast('Current GPS unavailable')
    return
  }

  const confirmed = window.confirm('Current location will overwrite the existing location. Continue?')
  if (!confirmed) return

  const lat = state.gps.lat
  const lon = state.gps.lon
  const name = await _reverseGeocode(lat, lon)
  const value = name || `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`

  document.getElementById('detail-location').value = value
  document.getElementById('detail-coords').textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`
  document.getElementById('detail-coords').style.display = 'block'
  currentLocationOverride = { lat, lon, location: name || value }
  showToast('Location set from current GPS')
}

async function _runAI() {
  const btn       = document.getElementById('detail-ai-btn')
  const resultsEl = document.getElementById('detail-ai-results')
  const galleryImgs = Array.from(document.querySelectorAll('#detail-gallery img'))
  if (!galleryImgs.length) { showToast('No photo to identify'); return }

  btn.disabled = true
  btn.innerHTML = '<div class="ai-dot"></div> Identifying…'
  resultsEl.style.display = 'none'

  try {
    const blobResults = await Promise.allSettled(
      galleryImgs.map(async img => {
        const resp = await fetch(img.src)
        if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`)
        return resp.blob()
      })
    )
    const blobs = blobResults
      .filter(result => result.status === 'fulfilled' && result.value instanceof Blob)
      .map(result => result.value)
    const predictions = await runArtsorakelForBlobs(blobs, 'no')

    if (!predictions?.length) {
      showToast('No match found')
      return
    }

    resultsEl.innerHTML = predictions.map((p, i) =>
      `<div class="ai-result" data-idx="${i}">
        <span class="ai-prob">${Math.round(p.probability * 100)}%</span>
        <span class="ai-name">${_esc(p.displayName)}</span>
      </div>`
    ).join('')
    resultsEl.style.display = 'block'
    resultsEl._predictions = predictions

    resultsEl.querySelectorAll('.ai-result').forEach((el, i) => {
      el.addEventListener('click', () => {
        const p = predictions[i]
        const parts = (p.scientificName || '').trim().split(' ')
        selectedTaxon = {
          genus:           parts[0] || null,
          specificEpithet: parts[1] || null,
          vernacularName:  p.vernacularName || null,
          displayName:     p.displayName,
        }
        document.getElementById('detail-taxon-input').value = p.displayName
        document.getElementById('detail-title').textContent = p.displayName || 'Unknown species'
        resultsEl.style.display = 'none'
      })
    })
  } catch (err) {
    showToast(`Artsorakel: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.innerHTML = '<div class="ai-dot"></div> Identify with Artsorakel AI'
  }
}

function _goBack(event) {
  if (event) event.preventDefault()
  const prev = goBack()
  if (prev === 'finds') loadFinds()
}

function _resetForm() {
  currentObsIsOwner = false
  currentLocationOverride = null
  document.getElementById('detail-taxon-input').value = ''
  document.getElementById('detail-taxon-dropdown').style.display = 'none'
  document.getElementById('detail-location').value    = ''
  document.getElementById('detail-habitat').value     = ''
  document.getElementById('detail-notes').value       = ''
  document.getElementById('detail-uncertain').checked = false
  document.getElementById('detail-title').textContent = 'Unknown species'
  document.getElementById('detail-date').textContent  = '—'
  const timeEl = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (timeEl) timeEl.style.display = 'none'
  if (timeVal) timeVal.textContent = ''
  document.getElementById('detail-gallery').innerHTML = ''
  const aiResults = document.getElementById('detail-ai-results')
  if (aiResults) { aiResults.style.display = 'none'; aiResults.innerHTML = '' }

  // Reset visibility to default
  const r = document.querySelector('input[name="detail-vis"][value="friends"]')
  if (r) r.checked = true

  // Clear comments
  const commentsList = document.getElementById('comments-list')
  if (commentsList) commentsList.innerHTML = ''
  const commentInput = document.getElementById('comment-input')
  if (commentInput) commentInput.value = ''
  _applyOwnershipMode(true)
}

function _applyOwnershipMode(isOwner) {
  const readonlyNote = document.getElementById('detail-readonly-note')
  const saveBtn = document.getElementById('detail-save-btn')
  const deleteBtn = document.getElementById('detail-delete-btn')
  const aiBtn = document.getElementById('detail-ai-btn')
  const taxonInput = document.getElementById('detail-taxon-input')
  const locationInput = document.getElementById('detail-location')
  const habitatInput = document.getElementById('detail-habitat')
  const notesInput = document.getElementById('detail-notes')
  const uncertainInput = document.getElementById('detail-uncertain')
  const currentLocationBtn = document.getElementById('detail-current-location-btn')

  if (readonlyNote) {
    readonlyNote.style.display = 'none'
  }
  if (saveBtn) saveBtn.style.display = isOwner ? '' : 'none'
  if (deleteBtn) deleteBtn.style.display = isOwner ? '' : 'none'
  if (aiBtn) aiBtn.disabled = !isOwner
  if (taxonInput) taxonInput.disabled = !isOwner
  if (locationInput) locationInput.readOnly = true
  if (habitatInput) habitatInput.readOnly = !isOwner
  if (notesInput) notesInput.readOnly = !isOwner
  if (uncertainInput) uncertainInput.disabled = !isOwner
  if (currentLocationBtn) currentLocationBtn.style.display = isOwner ? 'inline-block' : 'none'

  document.querySelectorAll('input[name="detail-vis"]').forEach(radio => {
    radio.disabled = !isOwner
  })
}

async function _searchTaxon(q, dropdown) {
  if (q.length < 2) { dropdown.style.display = 'none'; return }

  const results = await searchTaxa(q, 'no')
  if (!results.length) { dropdown.style.display = 'none'; return }

  dropdown.innerHTML = results.map(r =>
    `<li data-taxon='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      ${r.displayName}
      <span class="taxon-family">${r.family || ''}</span>
    </li>`
  ).join('')
  dropdown.style.display = 'block'

  dropdown.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', () => {
      selectedTaxon = JSON.parse(li.dataset.taxon)
      document.getElementById('detail-taxon-input').value = selectedTaxon.displayName
      dropdown.style.display = 'none'
    })
  })
}

async function _save() {
  if (!currentObs) return
  if (!currentObsIsOwner) {
    showToast('Only the owner can edit this observation')
    return
  }

  const btn = document.getElementById('detail-save-btn')
  btn.disabled = true

  const patch = {
    habitat:    document.getElementById('detail-habitat').value.trim()   || null,
    notes:      document.getElementById('detail-notes').value.trim()     || null,
    uncertain:  document.getElementById('detail-uncertain').checked,
    visibility: document.querySelector('input[name="detail-vis"]:checked')?.value || 'friends',
  }

  if (currentLocationOverride) {
    patch.location = currentLocationOverride.location || null
    patch.gps_latitude = currentLocationOverride.lat
    patch.gps_longitude = currentLocationOverride.lon
  }

  if (selectedTaxon) {
    patch.genus       = selectedTaxon.genus            || null
    patch.species     = selectedTaxon.specificEpithet  || null
    patch.common_name = selectedTaxon.vernacularName   || null
  }

  const { error } = await supabase
    .from('observations')
    .update(patch)
    .eq('id', currentObs.id)
    .eq('user_id', state.user.id)

  btn.disabled = false

  if (error) {
    showToast(`Save failed: ${error.message}`)
    return
  }

  showToast('Saved ✓')
  _goBack()
}

async function _delete() {
  if (!currentObs) return
  if (!currentObsIsOwner) {
    showToast('Only the owner can delete this observation')
    return
  }
  if (!confirm('Delete this observation? This cannot be undone.')) return

  const btn = document.getElementById('detail-delete-btn')
  btn.disabled = true

  // Delete storage images first
  const { data: imgData } = await supabase
    .from('observation_images')
    .select('storage_path')
    .eq('observation_id', currentObs.id)

  if (imgData?.length) {
    await supabase.storage
      .from('observation-images')
      .remove(imgData.map(i => i.storage_path))
  }

  const { error } = await supabase
    .from('observations')
    .delete()
    .eq('id', currentObs.id)
    .eq('user_id', state.user.id)

  btn.disabled = false

  if (error) { showToast(`Delete failed: ${error.message}`); return }

  showToast('Observation deleted')
  _goBack()
}

async function _loadComments(obsId) {
  const list = document.getElementById('comments-list')
  if (!list) return
  list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">Loading…</div>'

  const { data, error } = await supabase
    .from('comments')
    .select('id, body, created_at, user_id')
    .eq('observation_id', obsId)
    .order('created_at', { ascending: true })

  if (error) {
    console.warn('Comment load failed:', error.message)
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">Could not load comments.</div>'
    return
  }

  if (!data?.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">No comments yet.</div>'
    return
  }

  const authorMap = await fetchCommentAuthorMap(data, state.user)

  list.innerHTML = data.map(c => {
    const { name, initial } = getCommentAuthor(authorMap[c.user_id])
    const date = new Date(c.created_at).toLocaleDateString('no-NO', { day: 'numeric', month: 'short' })
    return `<div class="comment-row">
      <div class="comment-avatar">${_esc(initial)}</div>
      <div class="comment-body-wrap">
        <div class="comment-meta"><span class="comment-author">${_esc(name)}</span><span class="comment-date">${date}</span></div>
        <div class="comment-text">${_esc(c.body)}</div>
      </div>
    </div>`
  }).join('')
}

function _initMentions(input) {
  const container = input.parentElement
  const dropdown = document.createElement('ul')
  dropdown.className = 'mention-dropdown'
  dropdown.style.display = 'none'
  container.style.position = 'relative'
  container.appendChild(dropdown)

  let mentionStart = -1
  let mentionDebounce = null

  input.addEventListener('input', () => {
    const val = input.value
    const caret = input.selectionStart
    const textBefore = val.slice(0, caret)
    const match = textBefore.match(/@(\w*)$/)
    if (match) {
      mentionStart = textBefore.lastIndexOf('@')
      const query = match[1]
      clearTimeout(mentionDebounce)
      mentionDebounce = setTimeout(() => _searchMentions(query, dropdown, input, mentionStart), 200)
    } else {
      mentionStart = -1
      dropdown.style.display = 'none'
      dropdown.innerHTML = ''
    }
  })

  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none' }, 200)
  })
}

async function _searchMentions(query, dropdown, input, mentionStart) {
  if (query.length < 1) { dropdown.style.display = 'none'; return }
  const { data } = await supabase
    .from('profiles')
    .select('id, username, full_name')
    .ilike('username', `${query}%`)
    .limit(5)
  if (!data?.length) { dropdown.style.display = 'none'; return }

  dropdown.innerHTML = data.map((u, i) =>
    `<li data-idx="${i}" data-username="${u.username}">@${u.username}${u.full_name ? ` · ${u.full_name}` : ''}</li>`
  ).join('')
  dropdown.style.display = 'block'
  dropdown._users = data

  dropdown.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', e => {
      e.preventDefault()
      const username = li.dataset.username
      const before = input.value.slice(0, mentionStart)
      const after = input.value.slice(input.selectionStart)
      input.value = before + '@' + username + ' ' + after
      dropdown.style.display = 'none'
      input.focus()
    })
  })
}

async function _sendComment() {
  const input = document.getElementById('comment-input')
  const body = input.value.trim()
  if (!body || !currentObs) return
  const btn = document.getElementById('comment-send-btn')
  btn.disabled = true

  // Extract @mentions and look up user IDs
  const mentionedUsernames = [...body.matchAll(/@(\w+)/g)].map(m => m[1])
  let mentionedUserIds = []
  if (mentionedUsernames.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, username')
      .in('username', mentionedUsernames)
    mentionedUserIds = (profiles || []).map(p => p.id)
  }

  let { error } = await supabase.from('comments').insert({
    observation_id: currentObs.id,
    user_id: state.user.id,
    body,
    mentioned_user_ids: mentionedUserIds.length ? mentionedUserIds : null,
  })
  // Fallback: column may not exist yet — retry without it
  if (error?.message?.includes('mentioned_user_ids')) {
    ;({ error } = await supabase.from('comments').insert({
      observation_id: currentObs.id,
      user_id: state.user.id,
      body,
    }))
  }
  btn.disabled = false
  if (error) { showToast(`Could not post comment: ${error.message}`); return }
  input.value = ''
  showToast('Comment posted ✓')
  _loadComments(currentObs.id)
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
