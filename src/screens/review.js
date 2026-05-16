import { formatTime, getLocale, getTaxonomyLanguage, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName, createManualTaxon } from '../artsorakel.js'
import {
  buildIdentifyFingerprint,
  debugPhotoId,
  getAvailableIdentifyServices,
  _renderServiceIcon,
  renderIdentifyResultRows,
  renderIdentifyServiceTab,
  markRequestedServicesRunning,
  runIdentifyComparisonForBlobs,
  shouldRunServiceFromTab,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
} from '../ai-identification.js'
import { getIdentifyNoMatchMessage } from '../identify.js'
import { loadInaturalistSession } from '../inaturalist.js'
import { initLocationField, startLocationLookup, getLocationName, resetLocationState } from '../location.js'
import { refreshHome } from './home.js'
import { openFinds } from './finds.js'
import { enqueueObservation } from '../sync-queue.js'
import { openAiCropEditor } from '../ai-crop-editor.js'
import { createImageCropMeta, hasAiCropRect } from '../image_crop.js'
import { getDefaultVisibility, getPhotoIdMode, resolvePhotoIdServices } from '../settings.js'
import { normalizeVisibility, toCloudVisibility } from '../visibility.js'
import { isAndroidNativeApp } from '../camera-actions.js'
import { NativeCamera, isPickerCancel, pickImagesWithNativePhotoPicker, nativePickedPhotoToFile, captureNativePhotoExif, createNativeMetadataHydrationPromise, captureExif, processFile } from './import-helpers.js'
import { getLocationLookup } from '../location.js'

const reviewAiState = {
  running: false,
  hasRun: false,
  activeService: null,
  requestedFingerprint: '',
  currentFingerprint: '',
  availabilityFingerprint: '',
  stale: false,
  availability: {},
  resultsByService: {},
}

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

function _defaultCaptureDraft() {
  return {
    habitat: '',
    notes: '',
    uncertain: false,
    is_draft: true,
    location_precision: 'exact',
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
    <div class="field-meta-row">
      <span class="field-meta-key">${t('review.latLon')}</span>
      <span class="field-meta-val" style="font-variant-numeric: tabular-nums">${coords}</span>
    </div>
    <div class="field-meta-row">
      <span class="field-meta-key">${t('review.gpsAccuracy')}</span>
      <span class="field-meta-val" style="font-variant-numeric: tabular-nums">${accuracy}</span>
    </div>
    <div class="field-meta-row">
      <span class="field-meta-key">${t('review.altitude')}</span>
      <span class="field-meta-val" style="font-variant-numeric: tabular-nums">${altitude}</span>
    </div>
  `
}

function _updateReviewObscureHint() {
  let obscureHint = document.getElementById('review-obscured-hint')
  if (!obscureHint) {
    const obscuredInput = document.getElementById('review-obscured')
    const obscuredRow = obscuredInput?.closest('.field-meta-row')
    if (obscuredRow) {
      obscureHint = document.createElement('div')
      obscureHint.id = 'review-obscured-hint'
      obscureHint.className = 'field-meta-row'
      obscureHint.style.cssText = 'padding-top:4px; border-top:none;'
      obscureHint.innerHTML = `<div class="field-meta-key" style="font-size:10px; color:var(--amber); white-space:normal;">${t('privacySlots.obscureHint') || 'Obscuring a public find uses 1 privacy slot.'}</div>`
      obscuredRow.parentNode.insertBefore(obscureHint, obscuredRow.nextSibling)
      obscuredRow.style.borderBottom = 'none'
    }
  }
  if (obscureHint) {
    const isPro = state.cloudPlan?.cloudPlan === 'pro' || !!state.cloudPlan?.fullResStorageEnabled
    obscureHint.style.display = (!isPro && state.captureDraft.location_precision === 'fuzzed' && state.captureDraft.visibility === 'public') ? 'flex' : 'none'
  }
}

export function initReview() {
  document.getElementById('review-close')?.addEventListener('click', cancelReview)
  document.getElementById('review-cancel-btn')?.addEventListener('click', cancelReview)
  document.getElementById('review-save-btn')?.addEventListener('click', saveObservationBatch)
  document.getElementById('review-habitat')?.addEventListener('input', event => {
    state.captureDraft.habitat = event.target.value
  })
  document.getElementById('review-notes')?.addEventListener('input', event => {
    state.captureDraft.notes = event.target.value
  })
  document.getElementById('review-uncertain')?.addEventListener('change', event => {
    state.captureDraft.uncertain = event.target.checked
    buildReviewGrid()
  })
  document.querySelectorAll('input[name="review-vis"]').forEach(radio => {
    radio.addEventListener('change', event => {
      if (event.target.checked) {
        state.captureDraft.visibility = normalizeVisibility(event.target.value, getDefaultVisibility())
        const group = event.target.closest('.scope-tabs')
        if (group) {
          group.querySelectorAll('.scope-tab').forEach(tab => tab.classList.remove('active'))
          event.target.closest('.scope-tab').classList.add('active')
        }
      }
      _updateReviewObscureHint()
    })
  })
  const draftToggle = document.getElementById('review-draft')
  if (draftToggle) {
    draftToggle.addEventListener('change', event => {
      state.captureDraft.is_draft = event.target.checked
    })
  }
  document.querySelectorAll('input[name="review-location-precision"]').forEach(radio => {
    radio.addEventListener('change', event => {
      if (event.target.checked) state.captureDraft.location_precision = event.target.value
    })
  })

  const reviewObscured = document.getElementById('review-obscured')
  if (reviewObscured) {
    reviewObscured.addEventListener('change', event => {
      state.captureDraft.location_precision = event.target.checked ? 'fuzzed' : 'exact'
      _updateReviewObscureHint()
    })
  }

  initLocationField()
}

export function openImportedReview(session) {
  resetLocationState()
  resetReviewAiState()
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
    visibility: normalizeVisibility(session?.visibility, getDefaultVisibility()),
    is_draft: session?.is_draft !== false,
    location_precision: session?.location_precision || 'exact',
    uncertain: session?.uncertain || false,
  }
  state.reviewContext = {
    source: 'import',
    gps: reviewGps,
    locationName: session?.locationName || '',
    locationLookup: session?.locationLookup || null,
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

export function resetReviewAiState() {
  reviewAiState.running = false
  reviewAiState.hasRun = false
  reviewAiState.activeService = null
  reviewAiState.requestedFingerprint = ''
  reviewAiState.currentFingerprint = ''
  reviewAiState.availabilityFingerprint = ''
  reviewAiState.stale = false
  reviewAiState.availability = {}
  reviewAiState.resultsByService = {}
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

function _reviewLocationLookup() {
  return state.reviewContext?.locationLookup || getLocationLookup() || null
}

function _resolveReviewPhotoIdServices(availability = {}, options = {}) {
  const lookup = _reviewLocationLookup()
  return resolvePhotoIdServices({
    mode: getPhotoIdMode(),
    countryCode: lookup?.country_code || null,
    countryName: lookup?.country_name || null,
    locale: getLocale(),
    inaturalistAvailable: availability?.[ID_SERVICE_INATURALIST]?.available ?? false,
    comparisonRequested: !!options.comparisonRequested,
  })
}

function _mergeReviewServiceState(service, result = {}) {
  const normalizedService = normalizeIdentifyService(service)
  const existing = reviewAiState.resultsByService?.[normalizedService] || {}
  const availability = reviewAiState.availability?.[normalizedService] || {}
  reviewAiState.resultsByService = {
    ...(reviewAiState.resultsByService || {}),
    [normalizedService]: {
      ...existing,
      ...result,
      service: normalizedService,
      available: result.available ?? availability.available ?? false,
      reason: result.reason || availability.reason || '',
    },
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
    const visibility = normalizeVisibility(state.captureDraft.visibility, getDefaultVisibility())
  const visibilityRadio = document.querySelector(`input[name="review-vis"][value="${visibility}"]`)
  if (visibilityRadio) {
    visibilityRadio.checked = true
    const group = visibilityRadio.closest('.scope-tabs')
    if (group) {
      group.querySelectorAll('.scope-tab').forEach(tab => tab.classList.remove('active'))
      visibilityRadio.closest('.scope-tab').classList.add('active')
    }
  }
  const locationInput = document.getElementById('location-name-input')
  if (locationInput) {
    locationInput.value = reviewContext?.source === 'import'
      ? (locationInput.value || reviewContext.locationName || '')
      : (reviewContext?.locationName || locationInput.value || '')
  }
  const reviewObscured = document.getElementById('review-obscured')
  if (reviewObscured) reviewObscured.checked = state.captureDraft.location_precision === 'fuzzed'
  _updateReviewObscureHint()
  const addPhotoBtn = document.getElementById('add-photo-btn');
  if (addPhotoBtn) addPhotoBtn.style.display = 'none';

  const grid = document.getElementById('observation-grid')
  grid.classList.add('review-session-grid')
  let html = ''

  if (count === 0) {
    html = `<div class="capture-session-empty" style="opacity:0.4;pointer-events:none">${t('review.noCaptures')}</div>`
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
    const aiFingerprint = buildIdentifyFingerprint({
      service: ID_SERVICE_ARTSORAKEL,
      language: getTaxonomyLanguage(),
      images: photos.map((photo, index) => ({
        id: `review-${index}`,
        blob: photo.aiBlob instanceof Blob ? photo.aiBlob : photo.blob instanceof Blob ? photo.blob : null,
        cropRect: photo.aiCropRect || null,
        cropSourceW: photo.aiCropSourceW ?? null,
        cropSourceH: photo.aiCropSourceH ?? null,
        sourceType: photo?.aiBlob instanceof Blob ? 'photo.aiBlob' : 'photo.blob',
      })).filter(item => item.blob instanceof Blob),
    })
    reviewAiState.currentFingerprint = aiFingerprint.requestFingerprint
    reviewAiState.stale = Boolean(
      reviewAiState.hasRun
      && reviewAiState.requestedFingerprint
      && reviewAiState.requestedFingerprint !== reviewAiState.currentFingerprint,
    )
    const photoIdServices = _resolveReviewPhotoIdServices(reviewAiState.availability)
    if (!reviewAiState.activeService && Object.keys(reviewAiState.availability || {}).length) {
      reviewAiState.activeService = photoIdServices.primary
    }
    void _syncReviewAiAvailability()

    html = `
      <div class="detail-gallery capture-session-gallery" id="review-gallery"></div>
      <div class="capture-session-summary">${summary}</div>
      <div class="capture-session-crop-status">${croppedCount ? `${croppedCount}/${count} AI crop` : 'Tap a photo to add AI crop'}</div>
      
      <div class="field-meta-section capture-session-species">
        <div class="field-meta-header">${t('detail.species')}</div>
        <div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;">
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
          ${hasBlob ? _renderReviewAiControls() : ''}
          <div class="detail-uncertain-row" style="display:flex;align-items:center;justify-content:space-between;width:100%;">
            <span class="field-meta-key">${t('detail.idNeeded') || 'Uncertain ID'}</span>
            <label class="detail-toggle">
              <input type="checkbox" id="review-uncertain-card" ${state.captureDraft.uncertain ? 'checked' : ''}>
              <div class="detail-toggle-track"><div class="detail-toggle-thumb"></div></div>
            </label>
          </div>
          <div class="detail-draft-row" style="display:flex;align-items:center;justify-content:space-between;width:100%;">
            <span class="field-meta-key">${t('detail.draft') || 'Draft'}</span>
            <label class="detail-toggle">
              <input type="checkbox" id="review-draft-card" ${state.captureDraft.is_draft !== false ? 'checked' : ''}>
              <div class="detail-toggle-track"><div class="detail-toggle-thumb"></div></div>
            </label>
          </div>
        </div>
      </div>`
  }

  grid.innerHTML = html

  // Re-run the idempotent location wiring after the review body/card content
  // has been rebuilt.
  initLocationField()
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
  const runBtn = document.querySelector('[data-identify-run-button]')
  if (runBtn && !runBtn._wired) {
    runBtn._wired = true
    runBtn.addEventListener('click', () => _runReviewComparison())
  }

  document.querySelectorAll('[data-identify-service-tab]').forEach(tab => {
    if (tab._wired) return
    tab._wired = true
    tab.addEventListener('click', () => {
      const service = normalizeIdentifyService(tab.dataset.identifyServiceTab)
      const serviceState = reviewAiState.resultsByService?.[service] || null
      reviewAiState.activeService = service
      _renderReviewAiBlock()
      if (reviewAiState.running) return
      if (serviceState?.available === false) return
      if (shouldRunServiceFromTab(serviceState)) {
        void _runReviewComparison(service)
      }
    })
  })

  // Wire the in-card uncertain toggle (replaces the static #review-uncertain)
  const uncertainCard = document.getElementById('review-uncertain-card')
  if (uncertainCard) {
    uncertainCard.addEventListener('change', event => {
      state.captureDraft.uncertain = event.target.checked
      buildReviewGrid()
    })
  }

  const draftCard = document.getElementById('review-draft-card')
  if (draftCard) {
    draftCard.addEventListener('change', event => {
      state.captureDraft.is_draft = event.target.checked
    })
  }

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
  if (q.length < 2) { ul.style.display = 'none'; ul.innerHTML = ''; return }

  const results = await searchTaxa(q, getTaxonomyLanguage())
  if (!results.length) { ul.style.display = 'none'; ul.innerHTML = ''; return }

  ul.innerHTML = results.map(r =>
    `<li data-idx="${i}" data-taxon='${JSON.stringify(r).replace(/'/g, '&#39;')}'>
      ${r.displayName}
      <span class="taxon-family">${r.family || ''}</span>
    </li>`
  ).join('')
  ul.style.display = 'block'

  ul.querySelectorAll('li').forEach(li => {
    const selectTaxon = event => {
      event.preventDefault()
      event.stopPropagation()
      const taxon = JSON.parse(li.dataset.taxon)
      applyTaxon(i, taxon)
      hideDropdown(i)
      ul.innerHTML = ''
      input.blur?.()
    }
    li.addEventListener('pointerdown', selectTaxon)
    li.addEventListener('mousedown', selectTaxon)
  })
}

function hideDropdown(i) {
  const ul = document.querySelector(`.taxon-dropdown[data-idx="${i}"]`)
  if (ul) {
    ul.style.display = 'none'
    ul.innerHTML = ''
  }
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
      dropdown.innerHTML = ''
    })
    document.querySelectorAll('[data-identify-results]').forEach(result => {
      result.style.display = 'none'
    })
  }
  _syncReviewSpeciesLabel(taxon)
}

function applyTaxon(i, taxon) {
  setSharedTaxon(taxon, { syncInputs: true, hideMenus: true })
}

// ── Identification AI ────────────────────────────────────────────────────────

async function resolveBlob(photo) {
  if (photo.blob instanceof Blob) return photo.blob
  if (photo.blobPromise) return photo.blobPromise
  return null
}

async function _describeReviewBlob(blob) {
  if (!(blob instanceof Blob)) {
    return { blobType: '', blobSize: 0, width: null, height: null }
  }
  try {
    const { getBlobImageDimensions } = await import('../image_crop.js')
    const dims = await getBlobImageDimensions(blob)
    return {
      blobType: blob.type || '',
      blobSize: blob.size || 0,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
    }
  } catch (_) {
    return {
      blobType: blob.type || '',
      blobSize: blob.size || 0,
      width: null,
      height: null,
    }
  }
}

export async function prepareReviewIdentifyInputs(photos = state.capturedPhotos) {
  return (await Promise.all((photos || []).map(async (photo, index) => {
    const blob = photo.aiBlob instanceof Blob ? photo.aiBlob : await resolveBlob(photo)
    if (!(blob instanceof Blob)) return null
    return {
      id: `review-${index}`,
      blob,
      cropRect: photo.aiCropRect || null,
      source: photo?.aiBlob instanceof Blob ? 'photo.aiBlob' : 'photo.blob',
      sourceType: photo?.aiBlob instanceof Blob ? 'photo.aiBlob' : 'photo.blob',
      debug: await _describeReviewBlob(blob),
    }
  }))).filter(Boolean)
}

function _reviewCaptureImages() {
  return (state.capturedPhotos || [])
    .map((photo, index) => ({
      id: `review-${index}`,
      blob: photo.aiBlob instanceof Blob ? photo.aiBlob : photo.blob instanceof Blob ? photo.blob : null,
      cropRect: photo.aiCropRect || null,
      cropSourceW: photo.aiCropSourceW ?? null,
      cropSourceH: photo.aiCropSourceH ?? null,
      sourceType: photo?.aiBlob instanceof Blob ? 'photo.aiBlob' : 'photo.blob',
    }))
    .filter(item => item.blob instanceof Blob)
}

function _reviewAiTabState(service, statusOverride = null) {
  const result = reviewAiState.resultsByService[service] || null
  return {
    service,
    active: reviewAiState.activeService === service,
    available: reviewAiState.availability?.[service]?.available ?? false,
    reason: reviewAiState.availability?.[service]?.reason || '',
    status: statusOverride || result?.status || 'idle',
    errorMessage: result?.errorMessage || '',
    topProbability: result?.topProbability ?? null,
    topPrediction: result?.topPrediction || null,
  }
}

function _reviewAiResultsHtml() {
  const activeService = normalizeIdentifyService(reviewAiState.activeService || _resolveReviewPhotoIdServices(reviewAiState.availability).primary)
  const result = reviewAiState.resultsByService[activeService] || null
  if (result?.status === 'running') {
    return `<div class="ai-results-empty">${t('common.loading')}</div>`
  }
  if (!result?.predictions?.length) {
    if (result?.status === 'unavailable') {
      return `<div class="ai-results-empty">${reviewAiState.availability?.[activeService]?.reason || result.errorMessage || (t('settings.inaturalistLoginMissing') || 'Unavailable')}</div>`
    }
    if (result?.status === 'error') {
      return `<div class="ai-results-empty">${result.errorMessage || (t('common.errorPrefix', { message: t('common.unknown') }) || 'Error')}</div>`
    }
    if (result?.status === 'no_match') {
      return `<div class="ai-results-empty">${getIdentifyNoMatchMessage(activeService)}</div>`
    }
    return `<div class="ai-results-empty">${reviewAiState.stale ? (t('review.resultsOutdated') || 'Results outdated') : (t('review.noMatch') || 'No match')}</div>`
  }
  return renderIdentifyResultRows(activeService, result.predictions)
}

function _reviewAiDebugDump(label, resolution = null, requestedServices = [], sessionInfo = null) {
  debugPhotoId(label, {
    storedPhotoIdMode: getPhotoIdMode(),
    localStoragePhotoIdMode: globalThis.localStorage?.getItem('sporely-photo-id-mode'),
    legacyDefaultIdService: globalThis.localStorage?.getItem('sporely-default-id-service'),
    inaturalistSessionConnected: Boolean(sessionInfo?.connected),
    inaturalistHasApiToken: Boolean(sessionInfo?.api_token || sessionInfo?.apiToken),
    availability: reviewAiState.availability || {},
    photoIdServices: resolution || _resolveReviewPhotoIdServices(reviewAiState.availability),
    requestedServices,
  })
}

async function _runReviewAiService(service, blobs, options = {}) {
  const normalizedService = normalizeIdentifyService(service)
  const comparison = await runIdentifyComparisonForBlobs(
    blobs,
    {
      ...options,
      services: [normalizedService],
      defaultService: normalizedService,
      onServiceState: result => {
        _mergeReviewServiceState(result.service, result)
        reviewAiState.hasRun = Object.values(reviewAiState.resultsByService || {}).some(serviceResult =>
          serviceResult?.status === 'success' || serviceResult?.status === 'no_match'
        )
        _renderReviewAiBlock()
      },
    },
  )
  const result = comparison.resultsByService?.[normalizedService]
  if (result) _mergeReviewServiceState(normalizedService, result)
  return result
}

function _renderReviewAiTabs() {
  document.querySelectorAll('[data-identify-service-tab]').forEach(tab => {
    const service = normalizeIdentifyService(tab.dataset.identifyServiceTab)
    const state = _reviewAiTabState(service)
    tab.classList.toggle('is-active', state.active)
    tab.classList.toggle('is-disabled', !state.available)
    tab.classList.toggle('is-running', state.status === 'running')
    tab.classList.toggle('has-results', state.status === 'success' || state.status === 'no_match' || state.status === 'stale')
    tab.classList.toggle('has-error', state.status === 'error')
    tab.disabled = !state.available
    const icon = tab.querySelector('.ai-id-service-tab-icon')
    if (icon) {
      icon.outerHTML = _renderServiceIcon(state)
    }
    const score = tab.querySelector('.ai-id-service-tab-score')
    if (score) {
      score.textContent = (state.status === 'success' || state.status === 'stale')
        ? (state.topPrediction?.confidenceText || `${Math.round(Number(state.topProbability || 0) * 100)}%`)
        : ''
      score.style.display = score.textContent ? '' : 'none'
    }
  })
}

function _renderReviewAiResults() {
  const resultsEl = document.querySelector('[data-identify-results]')
  if (!resultsEl) return
  resultsEl.innerHTML = _reviewAiResultsHtml()
  resultsEl.querySelectorAll('[data-identify-result]').forEach(result => {
    if (result._wired) return
    result._wired = true
    result.addEventListener('click', event => {
      event.preventDefault()
      const pred = JSON.parse(result.dataset.identifyResult)
      const parts = (pred.scientificName || '').split(/\s+/)
      const taxon = {
        genus: parts[0] || '',
        specificEpithet: parts[1] || '',
        vernacularName: pred.vernacularName || null,
        scientificName: pred.scientificName || null,
        displayName: pred.displayName,
      }
      applyTaxon(0, taxon)
      reviewAiState.resultsByService[normalizeIdentifyService(pred.service)] = {
        ...(reviewAiState.resultsByService[normalizeIdentifyService(pred.service)] || {}),
        selectedTaxon: taxon,
      }
      reviewAiState.stale = reviewAiState.requestedFingerprint !== reviewAiState.currentFingerprint
      _renderReviewAiBlock()
    })
  })
}

function _renderReviewAiBlock() {
  _renderReviewAiTabs()
  _renderReviewAiResults()
}

function _renderReviewAiControls() {
  const services = [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]
  const staleClass = reviewAiState.stale ? ' is-stale' : ''
  const photoIdServices = _resolveReviewPhotoIdServices(reviewAiState.availability)
  const activeService = normalizeIdentifyService(reviewAiState.activeService || photoIdServices.primary)
  const activeResult = reviewAiState.resultsByService[activeService] || null
  const activeState = activeResult?.status || (reviewAiState.running ? 'running' : 'idle')
  const runState = reviewAiState.running ? 'running' : activeState
  const buttonLabel = t('review.aiId') || 'AI Photo ID'
  return `
    <div class="detail-ai-stack${staleClass}" data-identify-comparison-state>
      <div class="detail-ai-controls">
        <button
          type="button"
          class="ai-id-btn ai-id-run-btn"
          data-identify-run-button
          ${reviewAiState.running ? 'disabled' : ''}
        >
          <span data-identify-run-label>${runState === 'running' ? 'Loading...' : buttonLabel}</span>
        </button>
        <div class="detail-ai-service-tabs" role="tablist" aria-label="AI services">
          ${services.map(service => renderIdentifyServiceTab(_reviewAiTabState(service))).join('')}
        </div>
      </div>
      <div class="detail-ai-results-shell">
        ${reviewAiState.stale ? `<div class="detail-ai-stale-note">${t('review.resultsOutdated') || 'Results outdated - run AI Photo ID again.'}</div>` : ''}
        <div class="detail-ai-results" data-identify-results data-identify-service="${activeService}">
          ${_reviewAiResultsHtml()}
        </div>
      </div>
    </div>
  `
}

async function _syncReviewAiAvailability() {
  if (reviewAiState.running) return
  const fingerprint = reviewAiState.currentFingerprint
  if (!fingerprint) return
  const images = _reviewCaptureImages()
  const inaturalistSession = await loadInaturalistSession()
  const availabilityList = await getAvailableIdentifyServices({
    blobs: images.map(item => item.blob),
    inaturalistSession,
  })
  const availabilityFingerprint = JSON.stringify({
    fingerprint,
    availability: availabilityList.map(item => ({
      service: item.service,
      available: !!item.available,
      reason: item.reason || '',
    })),
  })
  if (reviewAiState.availabilityFingerprint === availabilityFingerprint) return
  reviewAiState.availability = Object.fromEntries(availabilityList.map(item => [item.service, item]))
  reviewAiState.availabilityFingerprint = availabilityFingerprint
  if (reviewAiState.currentFingerprint === fingerprint) {
    if (!reviewAiState.activeService) {
      reviewAiState.activeService = _resolveReviewPhotoIdServices(reviewAiState.availability).primary
    }
    _renderReviewAiBlock()
  }
}

async function _runReviewComparison(serviceOverride = null) {
  const overrideService = typeof serviceOverride === 'string'
    ? normalizeIdentifyService(serviceOverride)
    : null
  if (reviewAiState.running) return
  const blobs = await prepareReviewIdentifyInputs()
  if (!blobs.length) {
    showToast(t('detail.noPhotoToIdentify'))
    return
  }

  const fingerprint = buildIdentifyFingerprint({
    service: ID_SERVICE_ARTSORAKEL,
    language: getTaxonomyLanguage(),
    images: blobs,
  })
  reviewAiState.currentFingerprint = fingerprint.requestFingerprint
  reviewAiState.stale = Boolean(reviewAiState.hasRun && reviewAiState.requestedFingerprint && reviewAiState.requestedFingerprint !== fingerprint.requestFingerprint)
  reviewAiState.running = true
  reviewAiState.requestedFingerprint = fingerprint.requestFingerprint

  const inaturalistSession = await loadInaturalistSession()
  const availability = await getAvailableIdentifyServices({
    blobs: blobs.map(item => item.blob),
    inaturalistSession,
  })
  reviewAiState.availability = Object.fromEntries(availability.map(item => [item.service, item]))
  const photoIdServices = _resolveReviewPhotoIdServices(reviewAiState.availability, {
    comparisonRequested: !overrideService,
  })
  const requestedServices = overrideService
    ? [overrideService]
    : photoIdServices.run
  const primaryService = overrideService
    ? requestedServices[0]
    : (requestedServices[0] || photoIdServices.primary)
  _reviewAiDebugDump('review comparison', photoIdServices, requestedServices, inaturalistSession)
  reviewAiState.activeService = primaryService
  reviewAiState.resultsByService = markRequestedServicesRunning(reviewAiState.resultsByService, reviewAiState.availability, requestedServices)
  _renderReviewAiBlock()

  if (!requestedServices.length) {
    reviewAiState.running = false
    reviewAiState.requestedFingerprint = reviewAiState.currentFingerprint
    _renderReviewAiBlock()
    return
  }

  try {
    const tasks = requestedServices.map(service => {
      const startTime = globalThis.performance?.now?.() ?? Date.now()
      console.debug('[photo-id] review start', service, startTime)
      return _runReviewAiService(service, blobs, {
        language: getTaxonomyLanguage(),
        availability: reviewAiState.availability,
        screen: 'review',
      }).then(result => {
        if (result) {
          reviewAiState.resultsByService = {
            ...(reviewAiState.resultsByService || {}),
            [service]: result,
          }
          _renderReviewAiBlock()
        }
        return result
      })
    })

    const settled = await Promise.allSettled(tasks)
    const resultsByService = {}
    requestedServices.forEach((service, index) => {
      const item = settled[index]
      if (item.status === 'fulfilled' && item.value) {
        resultsByService[service] = item.value
      } else {
        resultsByService[service] = {
          service,
          status: 'error',
          predictions: [],
          errorMessage: String(item.reason?.message || item.reason || 'Unknown error'),
        }
      }
    })
    reviewAiState.resultsByService = {
      ...(reviewAiState.resultsByService || {}),
      ...resultsByService,
    }
    reviewAiState.activeService = primaryService
    reviewAiState.stale = false
    reviewAiState.hasRun = Object.values(resultsByService).some(result =>
      result?.status === 'success' || result?.status === 'no_match'
    )
  } catch (error) {
    console.error('Identification error:', error)
    showToast(t('common.errorPrefix', { message: String(error?.message || error || 'Unknown error') }))
  } finally {
    reviewAiState.running = false
    reviewAiState.requestedFingerprint = reviewAiState.currentFingerprint
    reviewAiState.activeService = primaryService
    _renderReviewAiBlock()
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
  reviewAiState.running = false
  reviewAiState.activeService = null
  reviewAiState.hasRun = false
  reviewAiState.requestedFingerprint = ''
  reviewAiState.currentFingerprint = ''
  reviewAiState.availabilityFingerprint = ''
  reviewAiState.stale = false
  reviewAiState.availability = {}
  reviewAiState.resultsByService = {}
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

    const visibility = normalizeVisibility(state.captureDraft.visibility, getDefaultVisibility())
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
      visibility: toCloudVisibility(visibility),
      is_draft: state.captureDraft.is_draft !== false,
      location_precision: state.captureDraft.location_precision || 'exact',
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
    input.accept = '.jpg,.jpeg,.png,.webp,.avif,.heic,.heif,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif'
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
