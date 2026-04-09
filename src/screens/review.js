import { formatTime, getTaxonomyLanguage, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, runArtsorakelForBlobs, formatDisplayName } from '../artsorakel.js'
import { initLocationField, startLocationLookup, getLocationName, resetLocationState } from '../location.js'
import { refreshHome } from './home.js'
import { enqueueObservation } from '../sync-queue.js'

export function initReview() {
  document.getElementById('review-close')
    .addEventListener('click', cancelReview)
  document.getElementById('add-photo-btn').addEventListener('click', () => navigate('capture'))
  document.getElementById('review-cancel-btn').addEventListener('click', cancelReview)
  document.getElementById('review-save-btn').addEventListener('click', saveObservationBatch)
  document.getElementById('review-habitat').addEventListener('input', event => {
    state.captureDraft.habitat = event.target.value
  })
  document.getElementById('review-notes').addEventListener('input', event => {
    state.captureDraft.notes = event.target.value
  })
  document.getElementById('review-uncertain').addEventListener('change', event => {
    state.captureDraft.uncertain = event.target.checked
  })
  document.querySelectorAll('input[name="review-vis"]').forEach(radio => {
    radio.addEventListener('change', event => {
      if (event.target.checked) state.captureDraft.visibility = event.target.value
    })
  })
  initLocationField()
}

// ── Grid build ────────────────────────────────────────────────────────────────

export function buildReviewGrid() {
  const photos = state.capturedPhotos
  const count  = photos.length
  const reviewCount = document.getElementById('review-count')
  const sharedTaxon = photos.find(photo => photo.taxon)?.taxon || null
  const speciesLabel = sharedTaxon?.displayName
    || (sharedTaxon ? formatDisplayName(sharedTaxon.genus, sharedTaxon.specificEpithet, sharedTaxon.vernacularName) : '')
    || t('detail.unknownSpecies')

  if (reviewCount) {
    reviewCount.textContent = speciesLabel
  }

  // title stays "New observation" — count shown via card carousel

  if (state.sessionStart) {
    document.getElementById('review-time').textContent =
      t('review.capturedRange', {
        start: formatTime(state.sessionStart, { hour: '2-digit', minute: '2-digit' }),
        end: formatTime(new Date(), { hour: '2-digit', minute: '2-digit' }),
      })
  }

  if (state.gps) {
    document.getElementById('review-coords-text').textContent =
      `${state.gps.lat.toFixed(4)}° N, ${state.gps.lon.toFixed(4)}° E`
    document.getElementById('meta-accuracy').textContent =
      `± ${Math.round(state.gps.accuracy)} m`
    if (state.gps.altitude)
      document.getElementById('meta-altitude').textContent =
        `${Math.round(state.gps.altitude)} m ASL`
    document.getElementById('review-location').textContent =
      `${state.gps.lat.toFixed(3)}° N, ${state.gps.lon.toFixed(3)}° E`
    startLocationLookup(state.gps.lat, state.gps.lon)
  }

  document.getElementById('review-habitat').value = state.captureDraft.habitat || ''
  document.getElementById('review-notes').value = state.captureDraft.notes || ''
  document.getElementById('review-uncertain').checked = !!state.captureDraft.uncertain
  const visibility = state.captureDraft.visibility || 'friends'
  const visibilityRadio = document.querySelector(`input[name="review-vis"][value="${visibility}"]`)
  if (visibilityRadio) visibilityRadio.checked = true

  const grid = document.getElementById('observation-grid')
  grid.classList.add('review-session-grid')
  let html = ''

  if (count === 0) {
    html = `<div class="capture-session-card" style="opacity:0.4;pointer-events:none">
      <div class="capture-session-empty">${t('review.noCaptures')}</div>
    </div>`
  } else {
    const displayName = sharedTaxon
      ? formatDisplayName(sharedTaxon.genus, sharedTaxon.specificEpithet, sharedTaxon.vernacularName)
      : ''
    const firstTime = photos[0]?.ts
      ? formatTime(photos[0].ts, { hour: '2-digit', minute: '2-digit' })
      : '—'
    const lastTime = photos[count - 1]?.ts
      ? formatTime(photos[count - 1].ts, { hour: '2-digit', minute: '2-digit' })
      : '—'
    const hasBlob = photos.some(photo => photo.blobPromise || (photo.blob instanceof Blob))
    const summary = count === 1
      ? `${tp('counts.photo', 1)} · ${firstTime}`
      : `${tp('counts.photo', count)} · ${firstTime} - ${lastTime}`

    html = `<div class="capture-session-card">
      <div class="detail-gallery capture-session-gallery" id="review-gallery"></div>
      <div class="capture-session-summary">${summary}</div>
      <div class="detail-field capture-session-species">
        <div class="detail-field-label">${t('detail.species')}</div>
        <div class="taxon-field-wrap">
          <input
            class="taxon-input detail-taxon-input"
            type="text"
            placeholder="${t('detail.unknownSpecies')}"
            value="${displayName}"
            data-idx="0"
            autocomplete="off"
            spellcheck="false"
          />
          <ul class="taxon-dropdown" data-idx="0" style="display:none"></ul>
        </div>
        ${hasBlob ? `<button class="ai-id-btn" id="review-ai-btn" style="margin-top:8px;width:100%">
          <div class="ai-dot"></div> ${t('detail.identifyAI')}
        </button>` : ''}
        <div class="artsorakel-results" data-idx="0" style="display:none"></div>
      </div>
    </div>`
  }

  grid.innerHTML = html

  wireCardEvents()
  loadThumbnails(photos)
}

function loadThumbnails(photos) {
  const gallery = document.getElementById('review-gallery')
  if (!gallery) return

  gallery.innerHTML = ''
  ;(async () => {
    for (const p of photos) {
      let blob = p.blob instanceof Blob ? p.blob : null
      if (!blob && p.blobPromise) blob = await p.blobPromise

      if (blob instanceof Blob) {
        const url = URL.createObjectURL(blob)
        const img = document.createElement('img')
        img.className = 'detail-gallery-img'
        img.src = url
        img.loading = 'lazy'
        img.alt = ''
        gallery.appendChild(img)
        continue
      }

      const placeholder = document.createElement('div')
      placeholder.className = 'capture-session-thumb-placeholder'
      placeholder.textContent = p.emoji || '🍄'
      gallery.appendChild(placeholder)
    }
  })()
}

// ── Per-card event wiring ─────────────────────────────────────────────────────

function wireCardEvents() {
  const aiBtn = document.getElementById('review-ai-btn')
  if (aiBtn) aiBtn.addEventListener('click', () => handleArtsorakelBtn(0))

  // Taxon autocomplete inputs
  document.querySelectorAll('.taxon-input').forEach(input => {
    let debounce
    input.addEventListener('input', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => handleTaxonInput(input), 280)
    })
    input.addEventListener('blur', () => {
      // Delay hide so click on dropdown item registers
      setTimeout(() => hideDropdown(Number(input.dataset.idx)), 200)
    })
  })
}

async function handleTaxonInput(input) {
  const i   = Number(input.dataset.idx)
  const q   = input.value.trim()
  const ul  = document.querySelector(`.taxon-dropdown[data-idx="${i}"]`)
  if (!ul) return

  if (!q) {
    applyTaxon(i, null)
    return
  }
  if (q.length < 2) { ul.style.display = 'none'; return }

  const results = await searchTaxa(q, getTaxonomyLanguage())
  if (!results.length) { ul.style.display = 'none'; return }

  ul.innerHTML = results.map(r =>
    `<li data-idx="${i}" data-taxon='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      ${r.displayName}
      <span class="taxon-family">${r.family || ''}</span>
    </li>`
  ).join('')
  ul.style.display = 'block'

  ul.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', () => {
      const taxon = JSON.parse(li.dataset.taxon)
      applyTaxon(i, taxon)
    })
  })
}

function hideDropdown(i) {
  const ul = document.querySelector(`.taxon-dropdown[data-idx="${i}"]`)
  if (ul) ul.style.display = 'none'
}

function applyTaxon(i, taxon) {
  state.capturedPhotos.forEach(photo => {
    photo.taxon = taxon ? { ...taxon } : null
  })
  document.querySelectorAll('.taxon-input').forEach(input => {
    input.value = taxon?.displayName || ''
  })
  document.querySelectorAll('.taxon-dropdown').forEach(dropdown => {
    dropdown.style.display = 'none'
  })
  document.querySelectorAll('.artsorakel-results').forEach(result => {
    result.style.display = 'none'
  })
}

// ── Artsorakel AI ─────────────────────────────────────────────────────────────

async function resolveBlob(photo) {
  if (photo.blob instanceof Blob) return photo.blob
  if (photo.blobPromise) return photo.blobPromise
  return null
}

async function handleArtsorakelBtn(i) {
  const btn = document.getElementById('review-ai-btn')
  const resultsEl = document.querySelector(`.artsorakel-results[data-idx="${i}"]`)
  if (!btn || !resultsEl) return

  const buttons = [btn]
  buttons.forEach(actionBtn => {
    actionBtn.disabled = true
    actionBtn.innerHTML = `<div class="ai-dot"></div> ${t('review.identifying')}`
  })
  document.querySelectorAll('.artsorakel-results').forEach(result => {
    result.style.display = 'none'
  })

  try {
    const blobs = (await Promise.all(state.capturedPhotos.map(resolveBlob)))
      .filter(blob => blob instanceof Blob)
    const predictions = await runArtsorakelForBlobs(blobs, getTaxonomyLanguage())

    if (!predictions || predictions.length === 0) {
      showToast(t('review.noMatch'))
      return
    }

    resultsEl.innerHTML = predictions.map((p, pi) =>
      `<div class="ai-result" data-pi="${pi}" data-idx="${i}" data-taxon='${JSON.stringify(p).replace(/'/g, '&#39;')}'>
        <span class="ai-prob">${Math.round(p.probability * 100)}%</span>
        <span class="ai-name">${p.displayName}</span>
      </div>`
    ).join('')
    resultsEl.style.display = 'block'

    resultsEl.querySelectorAll('.ai-result').forEach(el => {
      el.addEventListener('click', () => {
        const pred = JSON.parse(el.dataset.taxon)
        // Map AI result to a taxon-shaped object
        const parts = (pred.scientificName || '').split(/\s+/)
        const taxon = {
          genus:           parts[0] || '',
          specificEpithet: parts[1] || '',
          vernacularName:  pred.vernacularName || null,
          scientificName:  pred.scientificName || null,
          displayName:     pred.displayName,
        }
        applyTaxon(i, taxon)
        resultsEl.style.display = 'none'
      })
    })
  } catch (err) {
    if (err.message.includes('CORS') || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      showToast(t('review.aiUnavailable'))
    } else {
      showToast(t('common.artsorakelError', { message: err.message }))
    }
    console.warn('Artsorakel error:', err)
  } finally {
    buttons.forEach(actionBtn => {
      actionBtn.disabled = false
      actionBtn.innerHTML = `<div class="ai-dot"></div> ${t('detail.identifyAI')}`
    })
  }
}

async function runAllArtsorakel() {
  const count = state.capturedPhotos.length
  if (!count) { showToast(t('review.noPhotosToIdentify')); return }
  showToast(t('review.runningAi', { count: tp('counts.photo', count) }))
  for (let i = 0; i < count; i++) {
    await handleArtsorakelBtn(i)
  }
}

// ── Draft / sync ──────────────────────────────────────────────────────────────

function cancelReview() {
  state.capturedPhotos = []
  state.batchCount = 0
  state.captureDraft = {
    habitat: '',
    notes: '',
    uncertain: false,
    visibility: 'friends',
  }
  resetLocationState()
  navigate('home')
}

function _localDate(ts) {
  return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`
}

async function saveObservationBatch() {
  if (!state.user) { showToast(t('review.notSignedIn')); return }
  if (!state.capturedPhotos.length) { showToast(t('review.noPhotosToSync')); return }

  const btn = document.getElementById('review-save-btn')
  if (btn) btn.disabled = true
  showToast(t('review.syncing'))

  try {
    const photos = await Promise.all(
      state.capturedPhotos.map(async p => ({
        ...p,
        blob: p.blobPromise ? await p.blobPromise : (p.blob ?? null),
      }))
    )

    const visibility = state.captureDraft.visibility || 'friends'
    const leadGps = photos.find(photo => photo.gps)?.gps || null
    const leadPhoto = photos[0] || {}
    const taxon = photos.find(photo => photo.taxon)?.taxon || {}
    const obsPayload = {
      user_id:       state.user.id,
      date:          _localDate(leadPhoto.ts || new Date()),
      captured_at:   (leadPhoto.ts || new Date()).toISOString(),
      gps_latitude:  leadGps?.lat ?? null,
      gps_longitude: leadGps?.lon ?? null,
      location:      getLocationName() || null,
      habitat:       state.captureDraft.habitat.trim() || null,
      notes:         state.captureDraft.notes.trim() || null,
      uncertain:     !!state.captureDraft.uncertain,
      source_type:   'personal',
      genus:         taxon.genus || null,
      species:       taxon.specificEpithet || null,
      common_name:   taxon.vernacularName || null,
      visibility,
    }

    const imageBlobs = photos.map(p => p.blob).filter(b => b instanceof Blob)
    await enqueueObservation(obsPayload, imageBlobs)

    showToast(t('review.synced', { count: tp('counts.photo', photos.length) }))
    state.capturedPhotos = []
    state.batchCount = 0
    state.captureDraft = {
      habitat: '',
      notes: '',
      uncertain: false,
      visibility: 'friends',
    }
    resetLocationState()
    await refreshHome()
    navigate('finds')
  } catch (err) {
    showToast(t('review.syncFailed', { message: err.message }))
    console.error('Sync error:', err)
  } finally {
    if (btn) btn.disabled = false
  }
}
