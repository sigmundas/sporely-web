import { supabase } from '../supabase.js'
import { formatDate, formatTime, getTaxonomyLanguage, t } from '../i18n.js'
import { state } from '../state.js'
import { navigate, goBack } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName, runArtsorakelForBlobs } from '../artsorakel.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { resolveMediaSources } from '../images.js'
import { loadFinds, openFinds } from './finds.js'
import { openPhotoViewer } from '../photo-viewer.js'

let currentObs    = null
let selectedTaxon = null
let currentObsIsOwner = false
let currentLocationOverride = null
let returnScreenOverride = null

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
    _setDetailHeader({ fallbackName: input.value.trim() || t('detail.unknownSpecies') })
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

export async function openFindDetail(obsId, options = {}) {
  currentObs    = null
  selectedTaxon = null
  currentObsIsOwner = false
  currentLocationOverride = null
  returnScreenOverride = options.returnScreen || null

  // Update back button label — state.currentScreen is still the previous screen at this point
  const prevLabel = {
    home: t('detail.backHome'),
    finds: t('detail.backFinds'),
    map: t('detail.backMap'),
  }[returnScreenOverride || state.currentScreen] || t('detail.backGeneric')
  const backLabel = document.getElementById('detail-back-label')
  if (backLabel) backLabel.textContent = prevLabel

  _resetForm()
  navigate('find-detail')

  const { data: obs, error } = await supabase
    .from('observations')
    .select('id, user_id, date, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, visibility')
    .eq('id', obsId)
    .single()

  if (error || !obs) {
    showToast(t('detail.couldNotLoadObservation'))
    navigate('finds')
    return
  }

  currentObs = obs
  currentObsIsOwner = obs.user_id === state.user?.id
  _applyOwnershipMode(currentObsIsOwner)

  const displayName = formatDisplayName(obs.genus || '', obs.species || '', obs.common_name)
  _setDetailHeader({
    commonName: obs.common_name || '',
    genus: obs.genus || '',
    species: obs.species || '',
    fallbackName: displayName.trim() || t('detail.unknownSpecies'),
  })
  document.getElementById('detail-taxon-input').value = displayName.trim()
  const coords = obs.gps_latitude && obs.gps_longitude
    ? `${obs.gps_latitude.toFixed(4)}° N, ${obs.gps_longitude.toFixed(4)}° E`
    : null

  document.getElementById('detail-location').value    = obs.location || coords || ''
  document.getElementById('detail-habitat').value     = obs.habitat   || ''
  document.getElementById('detail-notes').value       = obs.notes     || ''
  document.getElementById('detail-uncertain').checked = !!obs.uncertain

  document.getElementById('detail-date').textContent = obs.date
    ? formatDate(obs.date, { day: 'numeric', month: 'short', year: 'numeric' })
    : '—'

  // Show capture time from EXIF if available
  const timeEl  = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (obs.captured_at) {
    const t = new Date(obs.captured_at)
    timeVal.textContent = formatTime(t, { hour: '2-digit', minute: '2-digit' })
    timeEl.style.display = 'inline'
  } else {
    timeEl.style.display = 'none'
  }

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
    const sources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'original' })

    sources.forEach(source => {
      if (!source?.primaryUrl && !source?.fallbackUrl) return
      const img = document.createElement('img')
      img.className = 'detail-gallery-img'
      img.src       = source.primaryUrl || source.fallbackUrl
      img.loading   = 'lazy'
      img.alt       = ''
      if (source.fallbackUrl && source.fallbackUrl !== source.primaryUrl) {
        img.addEventListener('error', () => {
          if (img.dataset.fallbackApplied === 'true') return
          img.dataset.fallbackApplied = 'true'
          img.src = source.fallbackUrl
        }, { once: true })
      }
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
    showToast(t('detail.onlyOwnerOverwriteLocation'))
    return
  }
  if (!state.gps) {
    showToast(t('detail.currentGpsUnavailable'))
    return
  }

  const confirmed = window.confirm(t('detail.overwriteLocationConfirm'))
  if (!confirmed) return

  const lat = state.gps.lat
  const lon = state.gps.lon
  const name = await _reverseGeocode(lat, lon)
  const value = name || `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`

  document.getElementById('detail-location').value = value
  document.getElementById('detail-coords').textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`
  document.getElementById('detail-coords').style.display = 'block'
  currentLocationOverride = { lat, lon, location: name || value }
  showToast(t('detail.locationSet'))
}

async function _runAI() {
  const btn       = document.getElementById('detail-ai-btn')
  const resultsEl = document.getElementById('detail-ai-results')
  const galleryImgs = Array.from(document.querySelectorAll('#detail-gallery img'))
  if (!galleryImgs.length) { showToast(t('detail.noPhotoToIdentify')); return }

  btn.disabled = true
  btn.innerHTML = `<div class="ai-dot"></div> ${t('review.identifying')}`
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
    const predictions = await runArtsorakelForBlobs(blobs, getTaxonomyLanguage())

    if (!predictions?.length) {
      showToast(t('review.noMatch'))
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
        _setDetailHeader({
          commonName: selectedTaxon.vernacularName || '',
          genus: selectedTaxon.genus || '',
          species: selectedTaxon.specificEpithet || '',
          fallbackName: p.displayName || t('detail.unknownSpecies'),
        })
        resultsEl.style.display = 'none'
      })
    })
  } catch (err) {
    showToast(t('common.artsorakelError', { message: err.message }))
  } finally {
    btn.disabled = false
    btn.innerHTML = `<div class="ai-dot"></div> ${t('detail.identifyAI')}`
  }
}

function _goBack(event) {
  if (event) event.preventDefault()
  if (returnScreenOverride) {
    const target = returnScreenOverride
    returnScreenOverride = null
    if (target === 'finds') {
      openFinds('mine', { resetSearch: true })
      return
    }
    navigate(target)
    return
  }
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
  _setDetailHeader({ fallbackName: t('detail.unknownSpecies') })
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

  const results = await searchTaxa(q, getTaxonomyLanguage())
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
      _setDetailHeader({
        commonName: selectedTaxon.vernacularName || '',
        genus: selectedTaxon.genus || '',
        species: selectedTaxon.specificEpithet || '',
        fallbackName: selectedTaxon.displayName || t('detail.unknownSpecies'),
      })
      dropdown.style.display = 'none'
    })
  })
}

function _setDetailHeader({ commonName = '', genus = '', species = '', fallbackName = t('detail.unknownSpecies') }) {
  const commonEl = document.getElementById('detail-title-common')
  const latinEl = document.getElementById('detail-title-latin')
  if (!commonEl || !latinEl) return

  const latinName = [genus, species].filter(Boolean).join(' ').trim()
  const primaryName = String(commonName || '').trim() || String(fallbackName || '').trim() || t('detail.unknownSpecies')

  commonEl.textContent = primaryName
  if (latinName && latinName.toLowerCase() !== primaryName.toLowerCase()) {
    latinEl.textContent = latinName
    latinEl.style.display = 'block'
  } else {
    latinEl.textContent = ''
    latinEl.style.display = 'none'
  }
}

async function _save() {
  if (!currentObs) return
  if (!currentObsIsOwner) {
    showToast(t('detail.onlyOwnerEdit'))
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
    showToast(t('detail.saveFailed', { message: error.message }))
    return
  }

  showToast(t('detail.saved'))
  _goBack()
}

async function _delete() {
  if (!currentObs) return
  if (!currentObsIsOwner) {
    showToast(t('detail.onlyOwnerDelete'))
    return
  }
  if (!confirm(t('detail.deleteConfirm'))) return

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

  if (error) { showToast(t('detail.deleteFailed', { message: error.message })); return }

  showToast(t('detail.deleted'))
  _goBack()
}

async function _loadComments(obsId) {
  const list = document.getElementById('comments-list')
  if (!list) return
  list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('common.loading')}</div>`

  const { data, error } = await supabase
    .from('comments')
    .select('id, body, created_at, user_id')
    .eq('observation_id', obsId)
    .order('created_at', { ascending: true })

  if (error) {
    console.warn('Comment load failed:', error.message)
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('comments.couldNotLoad')}</div>`
    return
  }

  if (!data?.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('comments.none')}</div>`
    return
  }

  const authorMap = await fetchCommentAuthorMap(data, state.user)

  list.innerHTML = data.map(c => {
    const { name, initial } = getCommentAuthor(authorMap[c.user_id])
    const date = formatDate(c.created_at, { day: 'numeric', month: 'short' })
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
  if (error) { showToast(t('comments.postFailed', { message: error.message })); return }
  input.value = ''
  showToast(t('comments.posted'))
  _loadComments(currentObs.id)
}

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
