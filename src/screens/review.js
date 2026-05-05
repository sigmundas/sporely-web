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
import { createImageCropMeta, hasAiCropRect } from '../image_crop.js'
import { getDefaultVisibility } from '../settings.js'
import { isAndroidNativeApp } from '../camera-actions.js'
import { NativeCamera, isPickerCancel, pickImagesWithNativePhotoPicker, nativePickedPhotoToFile, captureNativePhotoExif, createNativeMetadataHydrationPromise, captureExif, processFile } from './import-helpers.js'

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

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

export function formatCoordinate(value, positive, negative, digits = 5) {
  if (!Number.isFinite(value)) return ''
  const hemi = value < 0 ? negative : positive
  return `${Math.abs(value).toFixed(digits)}° ${hemi}`
}

export function formatLatLon(gps, digits = 5) {
  if (!gps || !isUsableCoordinate(gps.lat, gps.lon)) return '—'
  return `${formatCoordinate(gps.lat, 'N', 'S', digits)}, ${formatCoordinate(gps.lon, 'E', 'W', digits)}`
}

export function isUsableCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false
  return !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
}

export function buildGpsMetaHtml(gps) {
  if (!gps || !isUsableCoordinate(gps.lat, gps.lon)) return ''
  
  const coords = formatLatLon(gps, 5)
  const accuracy = Number.isFinite(gps.accuracy) ? `± ${Math.round(gps.accuracy)} m` : '—'
  const altitude = Number.isFinite(gps.altitude) ? `${Math.round(gps.altitude)} m ASL` : '— ASL'
  
  return `
    <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:13px;">
      <span style="color:var(--text-dim)">${t('review.latLon')}</span>
      <span style="font-variant-numeric: tabular-nums">${coords}</span>
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:13px;">
      <span style="color:var(--text-dim)">${t('review.gpsAccuracy')}</span>
      <span style="font-variant-numeric: tabular-nums">${accuracy}</span>
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:13px;">
      <span style="color:var(--text-dim)">${t('review.altitude')}</span>
      <span style="font-variant-numeric: tabular-nums">${altitude}</span>
    </div>
  `
}

export function initReview() {
  document.getElementById('review-close')
    .addEventListener('click', cancelReview)
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
  const gpsAccuracy = _firstFiniteNumber(
    session?.gpsAccuracy,
    ...(session?.photoGps || []).map(gps => gps?.accuracy),
  )
  const sessionLat = Number(session?.gpsLat)
  const sessionLon = Number(session?.gpsLon)
  const reviewGps = isUsableCoordinate(sessionLat, sessionLon)
    ? {
        lat: sessionLat,
        lon: sessionLon,
        accuracy: gpsAccuracy,
        altitude: gpsAltitude,
      }
    : null

  const taxon = session?.taxon ? { ...session.taxon } : null
  state.capturedPhotos = (session?.files || []).map((blob, index) => ({
    blob,
    aiBlob: _isBlob(session?.aiFiles?.[index]) ? session.aiFiles[index] : blob,
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
  if (isUsableCoordinate(lat, lon)) {
    return {
      lat,
      lon,
        accuracy: _firstFiniteNumber(
          metadataSession?.gpsAccuracy,
          ...(metadataSession?.photoGps || []).map(gps => gps?.accuracy),
        ),
      altitude: _firstFiniteNumber(
        metadataSession?.gpsAltitude,
        ...(metadataSession?.photoGps || []).map(gps => gps?.altitude),
      ),
    }
  }
  const photoGps = (metadataSession?.photoGps || []).find(gps =>
    isUsableCoordinate(Number(gps?.lat), Number(gps?.lon))
  )
  if (!photoGps) return null
  return {
    lat: Number(photoGps.lat),
    lon: Number(photoGps.lon),
      accuracy: _firstFiniteNumber(photoGps.accuracy),
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

function _mergeHydratedGps(reviewGps) {
  if (!reviewGps) return false
  if (!state.reviewContext.gps) {
    return _applyImportedReviewGps(reviewGps)
  }
  let changed = false
  if (state.reviewContext.gps.altitude == null && reviewGps.altitude != null) {
    state.reviewContext.gps.altitude = reviewGps.altitude
    changed = true
  }
  if (state.reviewContext.gps.accuracy == null && reviewGps.accuracy != null) {
    state.reviewContext.gps.accuracy = reviewGps.accuracy
    changed = true
  }
  if (changed) {
    state.capturedPhotos.forEach(photo => {
      if (photo.gps) {
        if (photo.gps.altitude == null && reviewGps.altitude != null) photo.gps.altitude = reviewGps.altitude;
        if (photo.gps.accuracy == null && reviewGps.accuracy != null) photo.gps.accuracy = reviewGps.accuracy;
      } else {
        photo.gps = { ...reviewGps };
      }
    })
    buildReviewGrid()
  }
  return changed
}

function _hydrateImportedReviewMetadata(session) {
  const promise = session?.metadataPromise
  if (!promise) return
  promise.then(metadataSession => {
    if (state.reviewContext?.source !== 'import') return
    const reviewGps = _metadataGps(metadataSession)
    _mergeHydratedGps(reviewGps)
  }).catch(error => {
    console.warn('Import metadata hydration failed:', error)
  })
}

async function _awaitImportedReviewMetadata() {
  const promise = state.reviewContext?.metadataPromise
  if (!promise) return
  try {
    const metadataSession = await promise
    if (state.reviewContext?.source !== 'import') return
    const reviewGps = _metadataGps(metadataSession)
    _mergeHydratedGps(reviewGps)
  } catch (error) {
    console.warn('Import metadata hydration failed before save:', error)
  }
}

// ── Grid build ────────────────────────────────────────────────────────────────

export function buildReviewGrid() {
  const photos = state.capturedPhotos
  const count  = photos.length
  const reviewContext = state.reviewContext || null
  const leadPhotoWithGps = photos.find(p => p.gps && isUsableCoordinate(p.gps.lat, p.gps.lon))
  const captureGps = leadPhotoWithGps?.gps || photos[0]?.gps || null

  const reviewGps = reviewContext?.source === 'import'
    ? (reviewContext.gps || null)
    : captureGps
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
      formatLatLon(reviewGps, 4)
    const metaCoordinates = document.getElementById('meta-coordinates')
    if (metaCoordinates) metaCoordinates.textContent = formatLatLon(reviewGps, 5)
    document.getElementById('meta-accuracy').textContent = Number.isFinite(reviewGps.accuracy)
      ? `± ${Math.round(reviewGps.accuracy)} m`
      : '—'
    if (Number.isFinite(reviewGps.altitude))
      document.getElementById('meta-altitude').textContent =
        `${Math.round(reviewGps.altitude)} m ASL`
    else
      document.getElementById('meta-altitude').textContent = '— ASL'
    document.getElementById('review-location').textContent =
      formatLatLon(reviewGps, 3)
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
      ? (locationInput.value || reviewContext.locationName || '')
      : (reviewContext?.locationName || locationInput.value || '')
  }
  const addPhotoBtn = document.getElementById('add-photo-btn');
  if (addPhotoBtn) addPhotoBtn.style.display = 'none';

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
      let blob = _isBlob(p.blob) ? p.blob : null
      if (!blob && p.blobPromise) blob = await p.blobPromise

      if (_isBlob(blob)) {
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

    const addCardContainer = document.createElement('div')
    addCardContainer.className = 'detail-gallery-item-wrap'
    addCardContainer.innerHTML = `
      <div class="gallery-add-placeholder">
        <div class="gallery-add-title">${t('import.addImage') || 'Add Image'}</div>
        <div class="gallery-add-btn-wrap">
          <button class="gallery-add-btn gallery-add-btn-cam" type="button" aria-label="Add from camera">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h3l1.6-2h4.8L16 6h3a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/></svg>
            <span>${t('import.camera') || 'Camera'}</span>
          </button>
          <button class="gallery-add-btn gallery-add-btn-file" type="button" aria-label="Add from file">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>${t('import.upload') || 'Upload'}</span>
          </button>
        </div>
      </div>
    `
    gallery.appendChild(addCardContainer)
    addCardContainer.querySelector('.gallery-add-btn-cam').addEventListener('click', _openCameraForReview)
    addCardContainer.querySelector('.gallery-add-btn-file').addEventListener('click', _openPickerForReview)
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
      blob: _isBlob(photo.aiBlob) ? photo.aiBlob : await resolveBlob(photo),
      cropRect: photo.aiCropRect || null,
    }))))
      .filter(item => _isBlob(item.blob))
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
    if (!_isBlob(blob)) continue
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
  
  _setProgress(0, 1, 'Preparing observation...')

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
      gps_altitude:  leadGps?.altitude ?? null,
      gps_accuracy:  leadGps?.accuracy ?? null,
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
      .filter(photo => _isBlob(photo.blob))
      .map(photo => ({
        blob: photo.blob,
        aiCropRect: photo.aiCropRect || null,
        aiCropSourceW: photo.aiCropSourceW ?? null,
        aiCropSourceH: photo.aiCropSourceH ?? null,
      }))
      
    _setProgress(0, 1, 'Encoding images for storage...')
    await new Promise(r => setTimeout(r, 100)) // Yield to let button un-press
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
    _hideProgress()
    if (btn) btn.disabled = false
  }
}

async function _openCameraForReview() {
  if (isAndroidNativeApp()) {
    try {
      const gps = state.gps && isUsableCoordinate(state.gps.lat, state.gps.lon)
        ? { latitude: state.gps.lat, longitude: state.gps.lon, altitude: state.gps.altitude, accuracy: state.gps.accuracy }
        : null
      const result = await NativeCamera.capturePhotos(gps ? { gps } : {})
      const photos = Array.isArray(result?.photos) ? result.photos : []
      if (!photos.length) return
      _setProgress(0, photos.length, t('import.readingFiles'))
      const files = []
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
        files.push(await nativePickedPhotoToFile(photos[i], i))
      }
      await _addFilesToReview(files, { nativePhotos: photos })
    } catch (err) {
      if (isPickerCancel(err)) return
      showToast(`Sporely Cam: ${err?.message || err}`)
      _hideProgress()
    }
  } else {
    navigate('capture')
  }
}

async function _openPickerForReview() {
  if (isAndroidNativeApp()) {
    try {
      const result = await pickImagesWithNativePhotoPicker()
      const photos = Array.isArray(result?.photos) ? result.photos : []
      if (!photos.length) return
      _setProgress(0, photos.length, t('import.readingFiles'))
      const files = []
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
        files.push(await nativePickedPhotoToFile(photos[i], i))
      }
      await _addFilesToReview(files, { nativePhotos: photos })
      return
    } catch (err) {
      if (isPickerCancel(err)) return
      _hideProgress()
    }
  }

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'image/*'
  if (/android/i.test(navigator.userAgent)) {
    input.accept = '.jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif'
  }
  input.onchange = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    await _addFilesToReview(files)
  }
  input.click()
}

async function _addFilesToReview(files, options = {}) {
  const nativePhotos = Array.isArray(options.nativePhotos) ? options.nativePhotos : []
  _setProgress(0, files.length, t('import.readingTimestamps'))

  const withTimes = await Promise.all(files.map(async (f, idx) => {
    const nativePhoto = nativePhotos[idx]
    if (nativePhoto) {
      const { time, lat, lon, altitude, accuracy, dbg } = await captureNativePhotoExif(nativePhoto, f)
      return { file: f, nativePhoto, metadataPromise: createNativeMetadataHydrationPromise(nativePhoto, f), captureTime: time, lat, lon, altitude, accuracy, dbg }
    }
    const { time, lat, lon, altitude, accuracy, dbg } = await captureExif(f)
    return { file: f, captureTime: time, lat, lon, altitude, accuracy, dbg }
  }))

  let doneCount = 0
  for (let idx = 0; idx < withTimes.length; idx++) {
    const item = withTimes[idx]
    _setProgress(doneCount, files.length, t('import.convertingFile', { current: doneCount + 1, total: files.length }))
    const processed = await processFile(item.file, { nativePhoto: item.nativePhoto })
    const gps = isUsableCoordinate(item.lat, item.lon) ? { lat: item.lat, lon: item.lon, altitude: item.altitude, accuracy: item.accuracy } : null

    const newPhoto = {
      blob: processed.blob,
      aiBlob: processed.aiBlob || processed.blob,
      blobPromise: null,
      gps,
      ts: new Date(item.captureTime),
      emoji: '🖼️',
      aiCropRect: processed.meta?.aiCropRect || null,
      aiCropSourceW: processed.meta?.aiCropSourceW ?? null,
      aiCropSourceH: processed.meta?.aiCropSourceH ?? null,
      taxon: state.capturedPhotos[0]?.taxon || null,
    }
    state.capturedPhotos.push(newPhoto)
    doneCount++
  }

  state.capturedPhotos.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  state.batchCount = state.capturedPhotos.length

  _hideProgress()
  buildReviewGrid()
}

function _setProgress(done, total, label) {
  const overlay = document.getElementById('import-progress')
  if (!overlay) return
  overlay.style.display = 'flex'
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  document.getElementById('import-progress-fill').style.width = pct + '%'
  document.getElementById('import-progress-label').textContent = label || t('import.processing')
}

function _hideProgress() {
  const overlay = document.getElementById('import-progress')
  if (overlay) overlay.style.display = 'none'
}
