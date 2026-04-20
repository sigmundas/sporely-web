import { formatTime, getTaxonomyLanguage, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, runArtsorakelForBlobs, formatDisplayName, createManualTaxon, isArtsorakelNetworkError } from '../artsorakel.js'
import { initLocationField, startLocationLookup, getLocationName, resetLocationState } from '../location.js'
import { refreshHome } from './home.js'
import { openFinds } from './finds.js'
import { enqueueObservation } from '../sync-queue.js'
import { openAiCropEditor } from '../ai-crop-editor.js'
import { hasAiCropRect } from '../image_crop.js'
import { getDefaultVisibility } from '../settings.js'

function _defaultCaptureDraft() {
  return {
    habitat: '',
    notes: '',
    uncertain: false,
    visibility: getDefaultVisibility(),
  }
}

function _firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function _formatCoordinate(value, positive, negative, digits = 5) {
  if (!Number.isFinite(value)) return ''
  const hemi = value < 0 ? negative : positive
  return `${Math.abs(value).toFixed(digits)}° ${hemi}`
}

function _formatLatLon(gps, digits = 5) {
  if (!gps || !_isUsableCoordinate(gps.lat, gps.lon)) return '—'
  return `${_formatCoordinate(gps.lat, 'N', 'S', digits)}, ${_formatCoordinate(gps.lon, 'E', 'W', digits)}`
}

function _isUsableCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false
  return !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
}

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
    buildReviewGrid()
  })
  document.querySelectorAll('input[name="review-vis"]').forEach(radio => {
    radio.addEventListener('change', event => {
      if (event.target.checked) state.captureDraft.visibility = event.target.value
    })
  })
  initLocationField()
}

export function openImportedReview(session) {
  resetLocationState()
  const gpsAltitude = _firstFiniteNumber(
    session?.gpsAltitude,
    ...(session?.photoGps || []).map(gps => gps?.altitude),
  )
  const sessionLat = Number(session?.gpsLat)
  const sessionLon = Number(session?.gpsLon)
  const reviewGps = _isUsableCoordinate(sessionLat, sessionLon)
    ? {
        lat: sessionLat,
        lon: sessionLon,
        accuracy: null,
        altitude: gpsAltitude,
      }
    : null

  const taxon = session?.taxon ? { ...session.taxon } : null
  state.capturedPhotos = (session?.files || []).map((blob, index) => ({
    blob,
    aiBlob: session?.aiFiles?.[index] instanceof Blob ? session.aiFiles[index] : blob,
    blobPromise: null,
    gps: reviewGps,
    ts: session?.ts || new Date(),
    emoji: '🖼️',
    aiCropRect: session?.imageMeta?.[index]?.aiCropRect || null,
    aiCropSourceW: session?.imageMeta?.[index]?.aiCropSourceW ?? null,
    aiCropSourceH: session?.imageMeta?.[index]?.aiCropSourceH ?? null,
    taxon: taxon ? { ...taxon } : null,
  }))
  state.batchCount = state.capturedPhotos.length
  state.sessionStart = session?.ts || new Date()
  state.captureDraft = {
    ..._defaultCaptureDraft(),
    visibility: session?.visibility || getDefaultVisibility(),
  }
  state.reviewContext = {
    source: 'import',
    gps: reviewGps,
    locationName: session?.locationName || '',
    metadataPromise: session?.metadataPromise || null,
  }
  _hydrateImportedReviewMetadata(session)
  navigate('review')
}

function _metadataGps(metadataSession) {
  const lat = Number(metadataSession?.gpsLat)
  const lon = Number(metadataSession?.gpsLon)
  if (_isUsableCoordinate(lat, lon)) {
    return {
      lat,
      lon,
      accuracy: null,
      altitude: _firstFiniteNumber(
        metadataSession?.gpsAltitude,
        ...(metadataSession?.photoGps || []).map(gps => gps?.altitude),
      ),
    }
  }
  const photoGps = (metadataSession?.photoGps || []).find(gps =>
    _isUsableCoordinate(Number(gps?.lat), Number(gps?.lon))
  )
  if (!photoGps) return null
  return {
    lat: Number(photoGps.lat),
    lon: Number(photoGps.lon),
    accuracy: null,
    altitude: _firstFiniteNumber(photoGps.altitude),
  }
}

function _applyImportedReviewGps(reviewGps) {
  if (!reviewGps) return false
  state.capturedPhotos.forEach(photo => {
    photo.gps = reviewGps
  })
  if (state.reviewContext?.source === 'import') {
    state.reviewContext.gps = reviewGps
  }
  buildReviewGrid()
  return true
}

function _hydrateImportedReviewMetadata(session) {
  const promise = session?.metadataPromise
  if (!promise) return
  promise.then(metadataSession => {
    if (state.reviewContext?.source !== 'import') return
    if (state.reviewContext.gps) return
    const reviewGps = _metadataGps(metadataSession)
    if (reviewGps) _applyImportedReviewGps(reviewGps)
  }).catch(error => {
    console.warn('Import metadata hydration failed:', error)
  })
}

async function _awaitImportedReviewMetadata() {
  const promise = state.reviewContext?.metadataPromise
  if (!promise) return
  if (state.reviewContext.gps) return
  try {
    const metadataSession = await promise
    if (state.reviewContext?.source !== 'import' || state.reviewContext.gps) return
    const reviewGps = _metadataGps(metadataSession)
    if (reviewGps) _applyImportedReviewGps(reviewGps)
  } catch (error) {
    console.warn('Import metadata hydration failed before save:', error)
  }
}

// ── Grid build ────────────────────────────────────────────────────────────────

export function buildReviewGrid() {
  const photos = state.capturedPhotos
  const count  = photos.length
  const reviewContext = state.reviewContext || null
  const reviewGps = reviewContext?.source === 'import'
    ? (reviewContext.gps || null)
    : (state.gps || null)
  const reviewCount = document.getElementById('review-count')
  const sharedTaxon = photos.find(photo => photo.taxon)?.taxon || null
  const speciesLabel = sharedTaxon?.displayName
    || (sharedTaxon ? formatDisplayName(sharedTaxon.genus, sharedTaxon.specificEpithet, sharedTaxon.vernacularName) : '')
    || t('detail.unknownSpecies')

  if (reviewCount) {
    reviewCount.textContent = state.captureDraft.uncertain
      ? `? ${String(speciesLabel).replace(/^\?\s*/, '')}`
      : String(speciesLabel).replace(/^\?\s*/, '')
  }

  // title stays "New observation" — count shown via card carousel

  if (photos.length) {
    const firstTs = photos[0]?.ts || state.sessionStart || new Date()
    const lastTs = photos[photos.length - 1]?.ts || firstTs
    document.getElementById('review-time').textContent =
      t('review.capturedRange', {
        start: formatTime(firstTs, { hour: '2-digit', minute: '2-digit' }),
        end: formatTime(lastTs, { hour: '2-digit', minute: '2-digit' }),
      })
  }

  if (reviewGps) {
    document.getElementById('review-coords-text').textContent =
      _formatLatLon(reviewGps, 4)
    const metaCoordinates = document.getElementById('meta-coordinates')
    if (metaCoordinates) metaCoordinates.textContent = _formatLatLon(reviewGps, 5)
    document.getElementById('meta-accuracy').textContent = Number.isFinite(reviewGps.accuracy)
      ? `± ${Math.round(reviewGps.accuracy)} m`
      : '—'
    if (Number.isFinite(reviewGps.altitude))
      document.getElementById('meta-altitude').textContent =
        `${Math.round(reviewGps.altitude)} m ASL`
    else
      document.getElementById('meta-altitude').textContent = '— ASL'
    document.getElementById('review-location').textContent =
      _formatLatLon(reviewGps, 3)
    startLocationLookup(reviewGps.lat, reviewGps.lon)
  } else {
    document.getElementById('review-coords-text').textContent = ''
    const metaCoordinates = document.getElementById('meta-coordinates')
    if (metaCoordinates) metaCoordinates.textContent = '—'
    document.getElementById('meta-accuracy').textContent = '—'
    document.getElementById('meta-altitude').textContent = '— ASL'
    document.getElementById('review-location').textContent = ''
  }

  document.getElementById('review-habitat').value = state.captureDraft.habitat || ''
  document.getElementById('review-notes').value = state.captureDraft.notes || ''
  document.getElementById('review-uncertain').checked = !!state.captureDraft.uncertain
  const visibility = state.captureDraft.visibility || getDefaultVisibility()
  const visibilityRadio = document.querySelector(`input[name="review-vis"][value="${visibility}"]`)
  if (visibilityRadio) visibilityRadio.checked = true
  const locationInput = document.getElementById('location-name-input')
  if (locationInput) {
    locationInput.value = reviewContext?.source === 'import'
      ? (reviewContext.locationName || '')
      : (reviewContext?.locationName || locationInput.value || '')
  }
  const addPhotoBtn = document.getElementById('add-photo-btn')
  if (addPhotoBtn) addPhotoBtn.style.display = reviewContext?.source === 'import' ? 'none' : ''

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

    const croppedCount = photos.filter(photo => hasAiCropRect(photo.aiCropRect)).length

    html = `<div class="capture-session-card">
      <div class="detail-gallery capture-session-gallery" id="review-gallery"></div>
      <div class="capture-session-summary">${summary}</div>
      <div class="capture-session-crop-status">${croppedCount ? `${croppedCount}/${count} AI crop` : 'Tap a photo to add AI crop'}</div>
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
    for (let index = 0; index < photos.length; index++) {
      const p = photos[index]
      let blob = p.blob instanceof Blob ? p.blob : null
      if (!blob && p.blobPromise) blob = await p.blobPromise

      if (blob instanceof Blob) {
        const url = URL.createObjectURL(blob)
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'ai-crop-gallery-item'
        item.addEventListener('click', () => _openReviewCropEditor(index))

        const img = document.createElement('img')
        img.className = 'detail-gallery-img'
        img.src = url
        img.loading = 'lazy'
        img.alt = ''
        item.appendChild(img)

        if (hasAiCropRect(p.aiCropRect)) {
          const badge = document.createElement('div')
          badge.className = 'ai-crop-thumb-badge'
          badge.textContent = 'AI crop'
          item.appendChild(badge)
        }

        gallery.appendChild(item)
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
      const value = input.value.trim()
      const currentTaxon = state.capturedPhotos.find(photo => photo.taxon)?.taxon || null
      if (!value) {
        setSharedTaxon(null, { syncInputs: false, hideMenus: false })
      } else if ((currentTaxon?.displayName || '').trim() !== value) {
        setSharedTaxon(createManualTaxon(value), { syncInputs: false, hideMenus: false })
      }
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

function _syncReviewSpeciesLabel(taxon = null) {
  const reviewCount = document.getElementById('review-count')
  if (!reviewCount) return
  const currentTaxon = taxon || state.capturedPhotos.find(photo => photo.taxon)?.taxon || null
  reviewCount.textContent = currentTaxon?.displayName
    || (currentTaxon ? formatDisplayName(currentTaxon.genus, currentTaxon.specificEpithet, currentTaxon.vernacularName) : '')
    || t('detail.unknownSpecies')
}

function setSharedTaxon(taxon, options = {}) {
  state.capturedPhotos.forEach(photo => {
    photo.taxon = taxon ? { ...taxon } : null
  })
  if (options.syncInputs) {
    document.querySelectorAll('.taxon-input').forEach(input => {
      input.value = taxon?.displayName || ''
    })
  }
  if (options.hideMenus !== false) {
    document.querySelectorAll('.taxon-dropdown').forEach(dropdown => {
      dropdown.style.display = 'none'
    })
    document.querySelectorAll('.artsorakel-results').forEach(result => {
      result.style.display = 'none'
    })
  }
  _syncReviewSpeciesLabel(taxon)
}

function applyTaxon(i, taxon) {
  setSharedTaxon(taxon, { syncInputs: true, hideMenus: true })
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
    const blobs = (await Promise.all(state.capturedPhotos.map(async photo => ({
      blob: photo.aiBlob instanceof Blob ? photo.aiBlob : await resolveBlob(photo),
      cropRect: photo.aiCropRect || null,
    }))))
      .filter(item => item.blob instanceof Blob)
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
    const message = String(err?.message || 'Unknown error')
    if (isArtsorakelNetworkError(err) || message.includes('CORS')) {
      showToast(t('review.aiUnavailable'))
    } else {
      showToast(t('common.artsorakelError', { message }))
    }
    console.warn('Artsorakel error:', err)
  } finally {
    buttons.forEach(actionBtn => {
      actionBtn.disabled = false
      actionBtn.innerHTML = `<div class="ai-dot"></div> ${t('detail.identifyAI')}`
    })
  }
}

async function _openReviewCropEditor(startIndex = 0) {
  const reviewImages = []
  const indexMap = []

  for (let photoIndex = 0; photoIndex < state.capturedPhotos.length; photoIndex++) {
    const photo = state.capturedPhotos[photoIndex]
    const blob = await resolveBlob(photo)
    if (!(blob instanceof Blob)) continue
    reviewImages.push({
      url: URL.createObjectURL(blob),
      aiCropRect: photo.aiCropRect || null,
    })
    indexMap.push(photoIndex)
  }

  const startEditorIndex = Math.max(0, indexMap.indexOf(startIndex))
  if (!reviewImages.length) return

  openAiCropEditor({
    title: t('crop.editorTitle'),
    startIndex: startEditorIndex,
    images: reviewImages,
    onChange: (index, nextMeta) => {
      const photoIndex = indexMap[index]
      state.capturedPhotos[photoIndex] = {
        ...state.capturedPhotos[photoIndex],
        ...nextMeta,
      }
    },
    onClose: committed => {
      reviewImages.forEach(image => URL.revokeObjectURL(image.url))
      if (committed) buildReviewGrid()
    },
  })
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
  state.reviewContext = null
  state.batchCount = 0
  state.captureDraft = _defaultCaptureDraft()
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
    await _awaitImportedReviewMetadata()
    const photos = await Promise.all(
      state.capturedPhotos.map(async p => ({
        ...p,
        blob: p.blobPromise ? await p.blobPromise : (p.blob ?? null),
      }))
    )

    const visibility = state.captureDraft.visibility || getDefaultVisibility()
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

    const imageEntries = photos
      .filter(photo => photo.blob instanceof Blob)
      .map(photo => ({
        blob: photo.blob,
        aiCropRect: photo.aiCropRect || null,
        aiCropSourceW: photo.aiCropSourceW ?? null,
        aiCropSourceH: photo.aiCropSourceH ?? null,
      }))
    await enqueueObservation(obsPayload, imageEntries)

    showToast(t('review.synced', { count: tp('counts.photo', photos.length) }))
    state.capturedPhotos = []
    state.reviewContext = null
    state.batchCount = 0
    state.captureDraft = _defaultCaptureDraft()
    resetLocationState()
    await refreshHome()
    await openFinds('mine', { resetSearch: true })
  } catch (err) {
    showToast(t('review.syncFailed', { message: err.message }))
    console.error('Sync error:', err)
  } finally {
    if (btn) btn.disabled = false
  }
}
