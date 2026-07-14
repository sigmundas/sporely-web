import { formatTime, getLocale, getTaxonomyLanguage, t, tp } from '../i18n.js'
import { state } from '../state.js'
import { navigate } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName, createManualTaxon } from '../artsorakel.js'
import {
  buildIdentifyFingerprint,
  debugPhotoId,
  getAvailableIdentifyServices,
  getIdentifyTopProbability,
  _renderServiceIcon,
  renderIdentifyResultRows,
  renderIdentifyRedlistSummary,
  renderIdentifyServiceTab,
  markRequestedServicesRunning,
  runIdentifyComparisonForBlobs,
  shouldRunServiceFromTab,
  wireIdentifyRunButtonPressFeedback,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
} from '../ai-identification.js'
import { getIdentifyNoMatchMessage } from '../identify.js'
import { loadInaturalistSession } from '../inaturalist.js'
import { initLocationField, openLocationSuggestions, startLocationLookup, getLocationName, resetLocationState } from '../location.js'
import { refreshHome } from './home.js'
import { openFinds } from './finds.js'
import { enqueueObservation } from '../sync-queue.js'
import { openAiCropEditor } from '../ai-crop-editor.js'
import { normalizeAiCropRect, shouldShowAiCropOverlay } from '../image_crop.js'
import { revokeDebugObjectUrl, shouldCaptureDebugPreviewUrls } from '../debug-activity.js'
import { getDefaultVisibility, getPhotoIdMode, resolvePhotoIdServices } from '../settings.js'
import { normalizeVisibility, toCloudVisibility } from '../visibility.js'
import { isAndroidNativeApp } from '../camera-actions.js'
import { playIrisShutter } from '../iris-shutter.js'
import { NativeCamera, isPickerCancel, pickImagesWithNativePhotoPicker, nativePickedPhotoToFile, captureNativePhotoExif, createNativeMetadataHydrationPromise, captureExif, processFile } from './import-helpers.js'
import { getLocationLookup } from '../location.js'
import { lookupCoordinateKey } from '../location-lookup.js'
import {
  endCaptureLocationSession,
  LOCATION_STATE_CHANGED_EVENT,
  requestFreshLocation,
  setLocationPreference,
  startLocationWatch,
} from '../geo.js'
import { debugImagePipeline } from '../image-pipeline-debug.js'
import {
  isBlob,
  isUsableCoordinate as sharedIsUsableCoordinate,
  normalizeCoordinatePair,
  normalizeObservationGps,
} from '../observation-shapes.js'
import {
  createDefaultObservationDraft,
  createDefaultObservationPayload,
} from '../observation-defaults.js'

const reviewAiState = {
  running: false,
  hasRun: false,
  activeService: null,
  selectedService: null,
  selectedPrediction: null,
  selectedPredictionByService: {},
  selectedProbabilityByService: {},
  selectedTaxonSource: null,
  requestedFingerprint: '',
  currentFingerprint: '',
  availabilityFingerprint: '',
  stale: false,
  availability: {},
  resultsByService: {},
}

let reviewLocationStateListenerWindow = null
let reviewLocationStateListener = null
let reviewLocationWarningDismissedSessionKey = null
let reviewLocationLastLookupKey = ''
let reviewSaveLocationSheetResolver = null
let reviewSaveLocationSessionBypassKey = null
let reviewSaveInFlight = false

const reviewDefaultDependencies = {
  enqueueObservation,
  refreshHome,
  openFinds,
  requestFreshLocation,
  openLocationSuggestions,
}

let reviewTestDependencies = null

export function __setReviewTestHooks(overrides = null) {
  reviewTestDependencies = overrides && typeof overrides === 'object' ? { ...overrides } : null
  if (!reviewTestDependencies) {
    reviewSaveInFlight = false
    _hideReviewSaveLocationSheet(null)
  }
}

function _reviewDependency(name) {
  return reviewTestDependencies?.[name] ?? reviewDefaultDependencies[name]
}

function _pickImportedReviewActiveService(resultsByService = {}, defaultService = ID_SERVICE_ARTSORAKEL) {
  const normalizedDefault = normalizeIdentifyService(defaultService)
  const defaultResult = resultsByService[normalizedDefault]
  if (defaultResult?.predictions?.length) return normalizedDefault

  let bestService = normalizedDefault
  let bestProbability = -1
  for (const service of [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]) {
    const probability = Number(getIdentifyTopProbability(resultsByService[service]) ?? -1)
    if (probability > bestProbability) {
      bestProbability = probability
      bestService = service
    }
  }
  return bestService
}

export function _buildImportedReviewAiState(session = null) {
  const requestedFingerprint = String(session?.aiRequestedFingerprint || '').trim()
  const currentFingerprint = String(session?.aiCurrentFingerprint || '').trim()
  const availabilityFingerprint = String(session?.aiAvailabilityFingerprint || '').trim()
  const aiState = {
    running: false,
    hasRun: false,
    activeService: null,
    selectedService: null,
    selectedPrediction: null,
    selectedPredictionByService: {},
    selectedProbabilityByService: {},
    selectedTaxonSource: null,
    requestedFingerprint,
    currentFingerprint,
    availabilityFingerprint,
    stale: Boolean(
      session?.aiStale
      || (requestedFingerprint && currentFingerprint && requestedFingerprint !== currentFingerprint),
    ),
    availability: {},
    resultsByService: {},
  }

  if (!session) return aiState

  const predictionSources = new Set([
    ...Object.keys(session.aiPredictionsByService || {}),
    ...Object.keys(session.aiServiceState || {}),
    ...Object.keys(session.aiAvailability || {}),
    ID_SERVICE_ARTSORAKEL,
    ID_SERVICE_INATURALIST,
  ])

  for (const serviceKey of predictionSources) {
    const service = normalizeIdentifyService(serviceKey)
    const predictions = Array.isArray(session.aiPredictionsByService?.[service]) ? session.aiPredictionsByService[service] : []
    const serviceState = session.aiServiceState?.[service] || {}
    const availability = session.aiAvailability?.[service] || {}
    const topPrediction = serviceState.topPrediction || predictions[0] || null
    const result = {
      service,
      status: serviceState.status || (predictions.length ? 'success' : 'idle'),
      predictions,
      topPrediction,
      topProbability: getIdentifyTopProbability({ ...serviceState, predictions }),
      errorMessage: serviceState.errorMessage || '',
      available: availability.available ?? serviceState.available ?? (serviceState.status !== 'unavailable'),
      reason: availability.reason || serviceState.reason || '',
      imageFingerprint: serviceState.imageFingerprint || '',
      cropFingerprint: serviceState.cropFingerprint || '',
      requestFingerprint: serviceState.requestFingerprint || '',
    }
    aiState.resultsByService[service] = result
    aiState.availability[service] = {
      service,
      available: result.available,
      reason: result.reason,
    }
    if (['success', 'no_match', 'error', 'stale', 'unavailable'].includes(result.status)) {
      aiState.hasRun = true
    }
  }

  const aiSelectionSource = session.aiSelectedTaxonSource || (Object.values(aiState.resultsByService || {}).some(result => Array.isArray(result.predictions) && result.predictions.length > 0) ? 'ai' : null)
  aiState.selectedTaxonSource = aiSelectionSource

  const explicitService = aiSelectionSource === 'ai'
    ? (session.aiSelectedService || session.aiActiveService || session.aiService || null)
    : null
  const defaultService = explicitService || session.aiActiveService || session.aiService || _pickImportedReviewActiveService(aiState.resultsByService, ID_SERVICE_ARTSORAKEL)
  aiState.activeService = _pickImportedReviewActiveService(aiState.resultsByService, defaultService)

  if (aiSelectionSource === 'ai') {
    const selectedService = normalizeIdentifyService(
      session.aiSelectedService
      || aiState.activeService
      || session.aiActiveService
      || session.aiService
      || ID_SERVICE_ARTSORAKEL,
    )
    const selectedPrediction = session.aiSelectedPrediction
      || session.aiSelectedPredictionByService?.[selectedService]
      || aiState.resultsByService?.[selectedService]?.topPrediction
      || null
    aiState.selectedService = selectedService
    aiState.selectedPrediction = selectedPrediction
    aiState.selectedPredictionByService = {
      ...(session.aiSelectedPredictionByService || {}),
    }
    if (selectedPrediction) {
      aiState.selectedPredictionByService[selectedService] = selectedPrediction
    }
    aiState.selectedProbabilityByService = {
      ...(session.aiSelectedProbabilityByService || {}),
    }
    if (selectedService && !Object.prototype.hasOwnProperty.call(aiState.selectedProbabilityByService, selectedService)) {
      aiState.selectedProbabilityByService[selectedService] = selectedPrediction?.probability ?? aiState.resultsByService?.[selectedService]?.topProbability ?? null
    }
  }

  if (!aiState.hasRun) {
    aiState.hasRun = Object.values(aiState.resultsByService || {}).some(result =>
      Array.isArray(result.predictions) && result.predictions.length > 0,
    )
  }

  return aiState
}

let reviewThumbCropObserver = null
let reviewThumbCropFrameUpdates = new WeakMap()

function _clearReviewThumbCropObserver() {
  reviewThumbCropObserver?.disconnect()
  reviewThumbCropObserver = null
  reviewThumbCropFrameUpdates = new WeakMap()
}

function _disposeReviewDebugPreviewUrls(photos = state.capturedPhotos) {
  (photos || []).forEach(photo => {
    if (!photo?._debugPreviewUrl) return
    revokeDebugObjectUrl(photo._debugPreviewUrl)
    delete photo._debugPreviewUrl
  })
}

function _firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function _renderReviewThumbCropFrame(item, img, rect) {
  const normalized = normalizeAiCropRect(rect)
  if (!item || !img || !normalized) return null

  const frame = document.createElement('div')
  frame.className = 'ai-crop-frame ai-crop-frame--thumb'
  frame.setAttribute('aria-hidden', 'true')
  item.appendChild(frame)

  const update = () => {
    if (!item.isConnected || !img.isConnected) return

    const itemRect = item.getBoundingClientRect()
    const imgRect = img.getBoundingClientRect()
    if (!itemRect.width || !itemRect.height || !imgRect.width || !imgRect.height) return

    const left = imgRect.left - itemRect.left + imgRect.width * normalized.x1
    const top = imgRect.top - itemRect.top + imgRect.height * normalized.y1
    const width = imgRect.width * (normalized.x2 - normalized.x1)
    const height = imgRect.height * (normalized.y2 - normalized.y1)

    frame.style.left = `${left}px`
    frame.style.top = `${top}px`
    frame.style.width = `${width}px`
    frame.style.height = `${height}px`
  }

  reviewThumbCropFrameUpdates.set(item, update)
  item.__reviewThumbCropUpdate = update
  if (typeof ResizeObserver !== 'undefined') {
    if (!reviewThumbCropObserver) {
      reviewThumbCropObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          reviewThumbCropFrameUpdates.get(entry.target)?.()
        }
      })
    }
    reviewThumbCropObserver.observe(item)
  }

  const scheduleUpdate = () => requestAnimationFrame(update)
  img.addEventListener('load', scheduleUpdate, { once: true })
  scheduleUpdate()

  return frame
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

export const isUsableCoordinate = sharedIsUsableCoordinate

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
    const isPro = state.cloudPlan?.qualityProfile === 'high' || state.cloudPlan?.cloudPlan === 'pro'
    obscureHint.style.display = (!isPro && state.captureDraft.location_precision === 'fuzzed' && state.captureDraft.visibility === 'public') ? 'flex' : 'none'
  }
}

export function initReview() {
  const currentWindow = globalThis.window
  if (currentWindow && reviewLocationStateListenerWindow !== currentWindow) {
    if (reviewLocationStateListenerWindow?.removeEventListener && reviewLocationStateListener) {
      reviewLocationStateListenerWindow.removeEventListener(LOCATION_STATE_CHANGED_EVENT, reviewLocationStateListener)
    }
    reviewLocationStateListenerWindow = currentWindow
    reviewLocationStateListener = () => {
      if (state.currentScreen !== 'review') return
      _syncReviewLocationStateUi()
    }
    currentWindow.addEventListener(LOCATION_STATE_CHANGED_EVENT, reviewLocationStateListener)
  }

  document.getElementById('review-close')?.addEventListener('click', cancelReview)
  document.getElementById('review-cancel-btn')?.addEventListener('click', cancelReview)
  document.getElementById('review-save-btn')?.addEventListener('click', saveObservationBatch)
  _hideReviewSaveLocationSheet(null)
  _wireReviewSaveLocationSheet()
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
  _clearReviewLocationWarningSuppression()
  reviewLocationLastLookupKey = ''
  Object.assign(reviewAiState, _buildImportedReviewAiState(session))
  const gpsAltitude = _firstFiniteNumber(
    session?.gpsAltitude,
    ...(session?.photoGps || []).map(gps => gps?.altitude),
  )
  const gpsAccuracy = _firstFiniteNumber(
    session?.gpsAccuracy,
    ...(session?.photoGps || []).map(gps => gps?.accuracy),
  )
  const reviewCoords = normalizeCoordinatePair(session?.gpsLat, session?.gpsLon)
  const reviewGps = reviewCoords
    ? {
        ...reviewCoords,
        accuracy: gpsAccuracy,
        altitude: gpsAltitude,
      }
    : null

  const taxon = session?.taxon ? { ...session.taxon } : null
  state.capturedPhotos = (session?.files || []).map((blob, index) => ({
    blob,
    aiBlob: isBlob(session?.aiFiles?.[index]) ? session.aiFiles[index] : blob,
    blobPromise: null,
    gps: reviewGps,
    ts: session?.ts || new Date(),
    emoji: '🖼️',
    aiCropRect: session?.imageMeta?.[index]?.aiCropRect || null,
    aiCropSourceW: session?.imageMeta?.[index]?.aiCropSourceW ?? null,
    aiCropSourceH: session?.imageMeta?.[index]?.aiCropSourceH ?? null,
    aiCropIsCustom: session?.imageMeta?.[index]?.aiCropIsCustom === true,
    taxon: taxon ? { ...taxon } : null,
  }))
  state.batchCount = state.capturedPhotos.length
  state.sessionStart = session?.ts || new Date()
  state.captureSessionLocation.sessionStartAt = state.sessionStart
  state.captureDraft = createDefaultObservationDraft({
    visibility: normalizeVisibility(session?.visibility, getDefaultVisibility()),
    is_draft: session?.is_draft !== false,
    location_precision: session?.location_precision || 'exact',
    uncertain: session?.uncertain || false,
  })
  state.reviewContext = {
    source: 'import',
    gps: reviewGps,
    locationName: session?.locationName || '',
    locationLookup: session?.locationLookup || null,
    metadataPromise: session?.metadataPromise || null,
  }
  state.captureSessionLocation.fix = reviewGps ? { ...reviewGps } : null
  state.captureSessionLocation.requestingFreshFix = false
  _hydrateImportedReviewMetadata(session)
  navigate('review')
}

function _metadataGps(metadataSession) {
  const reviewGps = normalizeCoordinatePair(metadataSession?.gpsLat, metadataSession?.gpsLon)
  if (reviewGps) {
    return {
      ...reviewGps,
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
    normalizeCoordinatePair(gps?.lat, gps?.lon)
  )
  if (!photoGps) return null
  const coords = normalizeCoordinatePair(photoGps.lat, photoGps.lon)
  if (!coords) return null
  return {
    ...coords,
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
  state.captureSessionLocation.fix = { ...reviewGps }
  buildReviewGrid()
  return true
}

export function resetReviewAiState() {
  _clearReviewThumbCropObserver()
  reviewAiState.running = false
  reviewAiState.hasRun = false
  reviewAiState.activeService = null
  reviewAiState.selectedService = null
  reviewAiState.selectedPrediction = null
  reviewAiState.selectedPredictionByService = {}
  reviewAiState.selectedProbabilityByService = {}
  reviewAiState.selectedTaxonSource = null
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
    if (state.reviewContext?.source === 'import') {
      state.captureSessionLocation.fix = { ...reviewGps }
    }
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

function _currentReviewGps() {
  return _cloneReviewGps(_isImportedReview() ? state.reviewContext?.gps : state.captureSessionLocation.fix)
}

function _currentReviewNativeCameraGps() {
  return _currentReviewGps()
}

function _cloneReviewGps(gps) {
  const normalized = normalizeObservationGps(gps)
  if (!normalized) return null
  const timestamp = Number(gps?.timestamp)
  return {
    ...normalized,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
  }
}

function _isImportedReview() {
  return state.reviewContext?.source === 'import'
}

function _currentReviewSessionKey() {
  if (_isImportedReview()) {
    const importSessionMs = state.sessionStart instanceof Date
      ? state.sessionStart.getTime()
      : Number(state.sessionStart)
    return Number.isFinite(importSessionMs) ? `import:${importSessionMs}` : 'import'
  }

  const sessionStartAt = state.captureSessionLocation.sessionStartAt instanceof Date
    ? state.captureSessionLocation.sessionStartAt.getTime()
    : Number(state.captureSessionLocation.sessionStartAt)
  return Number.isFinite(sessionStartAt) ? `live:${sessionStartAt}` : null
}

function _isReviewLocationWarningSuppressed() {
  const sessionKey = _currentReviewSessionKey()
  return !!sessionKey && reviewLocationWarningDismissedSessionKey === sessionKey
}

function _dismissReviewLocationWarningForSession() {
  const sessionKey = _currentReviewSessionKey()
  if (sessionKey) reviewLocationWarningDismissedSessionKey = sessionKey
}

function _clearReviewLocationWarningSuppression() {
  reviewLocationWarningDismissedSessionKey = null
}

function _currentReviewSaveSessionKey() {
  return _currentReviewSessionKey()
}

function _isReviewSaveLocationSuppressed() {
  const sessionKey = _currentReviewSaveSessionKey()
  return !!sessionKey && reviewSaveLocationSessionBypassKey === sessionKey
}

function _setReviewSaveLocationSuppressed() {
  const sessionKey = _currentReviewSaveSessionKey()
  if (sessionKey) reviewSaveLocationSessionBypassKey = sessionKey
}

function _clearReviewSaveLocationSuppression() {
  reviewSaveLocationSessionBypassKey = null
}

function _focusReviewLocationInput() {
  const locationInput = document.getElementById('location-name-input')
  if (!locationInput) return
  try {
    locationInput.focus({ preventScroll: true })
  } catch {
    locationInput.focus()
  }
  _reviewDependency('openLocationSuggestions')()
}

function _syncReviewSaveLocationSheetContent() {
  const overlay = document.getElementById('review-save-location-overlay')
  if (!overlay) return false

  const title = document.getElementById('review-save-location-title')
  const body = document.getElementById('review-save-location-body')
  const retryBtn = document.getElementById('review-save-location-try-again')
  const manualBtn = document.getElementById('review-save-location-manual')
  const saveWithoutBtn = document.getElementById('review-save-location-save-without')

  if (title) title.textContent = 'Location is not ready'
  if (body) body.textContent = 'Sporely could not determine your position.'
  if (retryBtn) retryBtn.textContent = 'Try again'
  if (manualBtn) manualBtn.textContent = 'Enter place manually'
  if (saveWithoutBtn) saveWithoutBtn.textContent = 'Save without coordinates'
  return true
}

function _showReviewSaveLocationSheet() {
  const overlay = document.getElementById('review-save-location-overlay')
  if (!overlay || !_syncReviewSaveLocationSheetContent()) {
    return Promise.resolve('save-without')
  }

  overlay.style.display = 'flex'
  return new Promise(resolve => {
    reviewSaveLocationSheetResolver = resolve
  })
}

function _hideReviewSaveLocationSheet(result = null) {
  const overlay = document.getElementById('review-save-location-overlay')
  if (overlay) overlay.style.display = 'none'
  const resolve = reviewSaveLocationSheetResolver
  reviewSaveLocationSheetResolver = null
  if (typeof resolve === 'function') resolve(result)
}

function _resolveReviewSaveLocationSheet(result = null) {
  _hideReviewSaveLocationSheet(result)
}

function _wireReviewSaveLocationSheet() {
  const overlay = document.getElementById('review-save-location-overlay')
  if (!overlay || overlay._wired) return
  overlay._wired = true

  document.getElementById('review-save-location-try-again')?.addEventListener('click', event => {
    event.preventDefault()
    _resolveReviewSaveLocationSheet('retry')
  })
  document.getElementById('review-save-location-manual')?.addEventListener('click', event => {
    event.preventDefault()
    _resolveReviewSaveLocationSheet('manual')
  })
  document.getElementById('review-save-location-save-without')?.addEventListener('click', event => {
    event.preventDefault()
    _resolveReviewSaveLocationSheet('save-without')
  })
}

function _canAcquireReviewSaveLocation() {
  if (_isImportedReview()) return false
  if (_isReviewSaveLocationSuppressed()) return false
  if (state.location.preference !== 'enabled') return false
  if (state.location.capability === 'unsupported' || state.location.error?.kind === 'unsupported') return false
  if (state.location.permission === 'denied' || state.location.error?.kind === 'permission-denied') return false
  return true
}

function _canonicalReviewSaveGps() {
  return _cloneReviewGps(_isImportedReview() ? state.reviewContext?.gps : state.captureSessionLocation.fix)
}

function _canRequestReviewSaveFreshLocation(sessionToken) {
  if (state.currentScreen !== 'review') return false
  if (_isImportedReview()) return false
  if (_isReviewSaveLocationSuppressed()) return false
  if (state.location.preference !== 'enabled') return false
  return _currentReviewSaveSessionKey() === sessionToken
}

async function _requestReviewSaveLocation() {
  const sessionToken = _currentReviewSaveSessionKey()
  if (!_canRequestReviewSaveFreshLocation(sessionToken)) return null
  await _reviewDependency('requestFreshLocation')({
    maxAgeMs: 30_000,
    timeoutMs: 10_000,
    enableHighAccuracy: true,
    internalOverride: true,
    captureSessionRequestToken: sessionToken,
  })
  if (state.currentScreen !== 'review') return null
  return _canonicalReviewSaveGps()
}

async function _resolveReviewSaveLocation() {
  while (true) {
    if (state.currentScreen !== 'review') {
      return { action: 'abort' }
    }
    if (_isImportedReview()) {
      return { action: 'proceed', gps: _canonicalReviewSaveGps() }
    }
    if (state.location.preference === 'disabled') {
      return { action: 'proceed', gps: null }
    }
    const currentGps = _canonicalReviewSaveGps()
    if (currentGps) return { action: 'proceed', gps: currentGps }
    if (_isReviewSaveLocationSuppressed()) {
      return { action: 'proceed', gps: null }
    }
    if (_canAcquireReviewSaveLocation()) {
      const freshGps = await _requestReviewSaveLocation()
      if (freshGps) return { action: 'proceed', gps: freshGps }
    }
    const decision = await _showReviewSaveLocationSheet()
    if (decision === 'manual') {
      _focusReviewLocationInput()
      return { action: 'manual' }
    }
    if (decision === 'save-without') {
      _setReviewSaveLocationSuppressed()
      return { action: 'proceed', gps: _canonicalReviewSaveGps() }
    }
    if (decision !== 'retry') return { action: 'abort' }
  }
}

function _supportsOpenLocationSettings() {
  const app = globalThis.Capacitor?.Plugins?.App || globalThis.Capacitor?.App || null
  return typeof app?.openSettings === 'function' ? app : null
}

async function _openReviewLocationSettings() {
  const app = _supportsOpenLocationSettings()
  if (!app) return false
  try {
    await app.openSettings.call(app)
    return true
  } catch (error) {
    console.warn('Unable to open location settings:', error)
    return false
  }
}

async function _requestReviewLocationRetry() {
  const sessionToken = _currentReviewSessionKey()
  if (!_canRequestReviewSaveFreshLocation(sessionToken)) return
  await requestFreshLocation({
    maxAgeMs: 0,
    timeoutMs: 10_000,
    enableHighAccuracy: true,
    internalOverride: true,
    captureSessionRequestToken: sessionToken,
  })
  if (state.currentScreen !== 'review' || _isImportedReview()) return
  if (state.location.preference !== 'enabled') return
  await startLocationWatch({
    requestFreshFix: false,
    maxAgeMs: 0,
    enableHighAccuracy: true,
    internalOverride: true,
  })
}

function _syncReviewLocationWarning() {
  const locationWarningEl = document.getElementById('review-location-warning')
  if (!locationWarningEl) return

  const warning = _reviewLocationWarningState()

  if (!warning) {
    locationWarningEl.hidden = true
    locationWarningEl.innerHTML = ''
    delete locationWarningEl.dataset.locationState
    return
  }

  if (warning.kind === 'disabled') {
    locationWarningEl.hidden = false
    locationWarningEl.dataset.locationState = 'disabled'
    locationWarningEl.innerHTML = `
      <div class="review-location-warning-title">${warning.title}</div>
      <div class="review-location-warning-actions">
        <button type="button" class="btn-secondary" data-review-location-action="enable">Enable</button>
      </div>
    `
  } else {
    const openSettings = _supportsOpenLocationSettings()
    const settingsButton = openSettings
      ? '<button type="button" class="btn-secondary" data-review-location-action="open-settings">Open settings</button>'
      : ''
    const tryAgainButton = warning.showTryAgain
      ? '<button type="button" class="btn-secondary" data-review-location-action="try-again">Try again</button>'
      : ''
    locationWarningEl.hidden = false
    locationWarningEl.dataset.locationState = warning.kind
    locationWarningEl.innerHTML = `
      <div class="review-location-warning-header">
        <div class="review-location-warning-title">${warning.title}</div>
        <button type="button" class="review-location-warning-dismiss" aria-label="Dismiss" data-review-location-action="dismiss">×</button>
      </div>
      <div class="review-location-warning-body">${warning.body}</div>
      <div class="review-location-warning-actions">
        ${tryAgainButton}
        ${settingsButton}
        <button type="button" class="btn-secondary" data-review-location-action="continue-without-location">Continue without location</button>
        <button type="button" class="btn-secondary" data-review-location-action="dont-use-location">Don’t use location for future finds</button>
      </div>
    `
  }

  locationWarningEl.querySelectorAll('[data-review-location-action]').forEach(button => {
    if (button._reviewLocationActionWired) return
    button._reviewLocationActionWired = true
    button.addEventListener('click', async event => {
      event.preventDefault()
      const action = button.dataset.reviewLocationAction
      if (action === 'dismiss' || action === 'continue-without-location') {
        _dismissReviewLocationWarningForSession()
        _syncReviewLocationWarning()
        return
      }
      if (action === 'dont-use-location') {
        _dismissReviewLocationWarningForSession()
        setLocationPreference('disabled')
        _syncReviewLocationWarning()
        return
      }
      if (action === 'enable') {
        _clearReviewLocationWarningSuppression()
        setLocationPreference('enabled')
        await _requestReviewLocationRetry()
        buildReviewGrid()
        return
      }
      if (action === 'open-settings') {
        await _openReviewLocationSettings()
        return
      }
      if (action === 'try-again') {
        _clearReviewLocationWarningSuppression()
        await _requestReviewLocationRetry()
        buildReviewGrid()
      }
    })
  })
}

function _syncReviewGpsStatus() {
  const gpsStatusEl = document.getElementById('review-gps-display')
  if (!gpsStatusEl) return

  const reviewGps = _currentReviewGps()
  let text = 'No location captured'
  let stateName = 'idle'

  if (reviewGps) {
    text = Number.isFinite(reviewGps.accuracy)
      ? `Location ready · ±${Math.round(reviewGps.accuracy)} m`
      : 'Location ready'
    stateName = 'fix'
  } else if (_isImportedReview()) {
    text = 'No location captured'
    stateName = 'idle'
  } else if (state.location.preference === 'disabled') {
    text = 'Location not included'
    stateName = 'disabled'
  } else if (state.location.status === 'locating' || state.captureSessionLocation.requestingFreshFix) {
    text = 'Finding location…'
    stateName = 'searching'
  } else if (state.location.capability === 'unsupported' || state.location.error?.kind === 'unsupported') {
    text = 'Automatic location unavailable'
    stateName = 'unavailable'
  } else if (state.location.permission === 'denied' || state.location.error?.kind === 'permission-denied') {
    text = 'Location access is off'
    stateName = 'unavailable'
  } else if (state.location.status === 'timeout' || state.location.error?.kind === 'timeout'
    || state.location.status === 'unavailable' || state.location.error?.kind === 'position-unavailable'
    || state.location.status === 'error') {
    text = 'Couldn’t determine location · Try again'
    stateName = 'unavailable'
  } else {
    text = 'Couldn’t determine location · Try again'
    stateName = 'unavailable'
  }

  const pill = gpsStatusEl.closest('.gps-pill')
  gpsStatusEl.textContent = text
  if (pill) pill.dataset.gpsState = stateName
}

function _syncReviewLocationStateUi() {
  const reviewGps = _currentReviewGps()
  const reviewLocationEl = document.getElementById('review-location')

  if (reviewGps) {
    const coordsText = document.getElementById('review-coords-text')
    if (coordsText) coordsText.textContent = formatLatLon(reviewGps, 4)
    const metaCoordinates = document.getElementById('meta-coordinates')
    if (metaCoordinates) metaCoordinates.textContent = formatLatLon(reviewGps, 5)
    const metaAccuracy = document.getElementById('meta-accuracy')
    if (metaAccuracy) {
      metaAccuracy.textContent = Number.isFinite(reviewGps.accuracy)
        ? `± ${Math.round(reviewGps.accuracy)} m`
        : '—'
    }
    const metaAltitude = document.getElementById('meta-altitude')
    if (metaAltitude) {
      metaAltitude.textContent = Number.isFinite(reviewGps.altitude)
        ? `${Math.round(reviewGps.altitude)} m ASL`
        : '— ASL'
    }

    const lookupKey = lookupCoordinateKey(reviewGps.lat, reviewGps.lon)
    if (reviewLocationEl && reviewLocationLastLookupKey !== lookupKey) {
      reviewLocationEl.textContent = ''
      reviewLocationEl.title = ''
      reviewLocationLastLookupKey = lookupKey
    }
    startLocationLookup(reviewGps.lat, reviewGps.lon)
  } else {
    const coordsText = document.getElementById('review-coords-text')
    if (coordsText) coordsText.textContent = ''
    const metaCoordinates = document.getElementById('meta-coordinates')
    if (metaCoordinates) metaCoordinates.textContent = '—'
    const metaAccuracy = document.getElementById('meta-accuracy')
    if (metaAccuracy) metaAccuracy.textContent = '—'
    const metaAltitude = document.getElementById('meta-altitude')
    if (metaAltitude) metaAltitude.textContent = '— ASL'
    if (reviewLocationEl) {
      reviewLocationEl.textContent = ''
      reviewLocationEl.title = ''
    }
    reviewLocationLastLookupKey = ''
  }

  _syncReviewLocationWarning()
  _syncReviewGpsStatus()
}

function _reviewLocationWarningState() {
  const locationState = state.location || {}
  if (_currentReviewGps()) return null

  if (locationState.preference === 'disabled') {
    return {
      kind: 'disabled',
      title: 'Location not included',
    }
  }

  if (_isReviewLocationWarningSuppressed()) return null

  if (locationState.status === 'locating' || state.captureSessionLocation.requestingFreshFix) return null

  if (locationState.capability === 'unsupported' || locationState.error?.kind === 'unsupported') {
    return {
      kind: 'unsupported',
      title: 'Automatic location unavailable',
      body: 'This platform cannot provide an automatic location. You can enter a place name or continue without location.',
      showTryAgain: false,
    }
  }

  if (locationState.permission === 'denied' || locationState.error?.kind === 'permission-denied') {
    return {
      kind: 'denied',
      title: 'Location not available',
      body: 'Location access is turned off for Sporely. This find will still be saved if you continue, but without location.',
      showTryAgain: true,
    }
  }

  if (locationState.status === 'timeout' || locationState.error?.kind === 'timeout'
    || locationState.status === 'unavailable' || locationState.error?.kind === 'position-unavailable'
    || locationState.status === 'error') {
    return {
      kind: 'unavailable',
      title: 'Location not available',
      body: 'Sporely could not determine your location. This find will still be saved if you continue, but without location.',
      showTryAgain: true,
    }
  }

  return null
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

function _reviewAiHasProbability(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function _reviewAiPredictionProbability(prediction = null, fallback = null) {
  if (!prediction) return _reviewAiHasProbability(fallback) ? Number(fallback) : null
  const value = Number(prediction?.probability ?? fallback)
  return Number.isFinite(value) ? value : null
}

function _reviewAiPredictionsEquivalent(left = null, right = null) {
  if (!left || !right) return false
  const leftTaxonId = String(left?.taxonId || '').trim().toLowerCase()
  const rightTaxonId = String(right?.taxonId || '').trim().toLowerCase()
  const leftScientificName = String(left?.scientificName || '').trim().toLowerCase()
  const rightScientificName = String(right?.scientificName || '').trim().toLowerCase()
  return (
    (leftTaxonId && rightTaxonId && leftTaxonId === rightTaxonId)
    || (leftScientificName && rightScientificName && leftScientificName === rightScientificName)
  )
}

function _reviewAiSelectedPredictionForService(service) {
  const normalizedService = normalizeIdentifyService(service)
  return reviewAiState.selectedPredictionByService?.[normalizedService] || null
}

function _reviewAiSelectedRedlistPrediction() {
  if (reviewAiState.selectedTaxonSource !== 'ai') return null
  const selectedService = normalizeIdentifyService(
    reviewAiState.selectedService || reviewAiState.activeService || '',
  )
  if (!selectedService) {
    return reviewAiState.selectedPrediction || null
  }
  return (
    reviewAiState.selectedPredictionByService?.[selectedService]
    || reviewAiState.selectedPrediction
    || reviewAiState.resultsByService?.[selectedService]?.topPrediction
    || null
  )
}

function _syncReviewRedlistSummary() {
  const host = document.getElementById('review-redlist-summary')
  if (!host) return
  const html = renderIdentifyRedlistSummary(_reviewAiSelectedRedlistPrediction())
  host.innerHTML = html
  host.style.display = html ? '' : 'none'
}

export function getReviewServiceDisplayProbability(service) {
  const normalizedService = normalizeIdentifyService(service)
  const result = reviewAiState.resultsByService?.[normalizedService] || null
  const topProbability = getIdentifyTopProbability(result)
  if (_reviewAiHasProbability(topProbability)) {
    return Number(topProbability)
  }

  const selectedProbability = reviewAiState.selectedProbabilityByService?.[normalizedService]
  if (_reviewAiHasProbability(selectedProbability)) {
    return Number(selectedProbability)
  }

  const selectedPrediction = _reviewAiSelectedPredictionForService(normalizedService)
  if (_reviewAiHasProbability(selectedPrediction?.probability)) {
    return Number(selectedPrediction.probability)
  }

  return null
}

// ── Grid build ────────────────────────────────────────────────────────────────

export function buildReviewGrid() {
  const photos = state.capturedPhotos
  const count  = photos.length
  const reviewContext = state.reviewContext || null
  const reviewGps = _currentReviewGps()

  if (!_isImportedReview() && count > 0 && !state.captureSessionLocation.sessionStartAt) {
    state.captureSessionLocation.sessionStartAt = state.sessionStart || new Date()
  }
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

  _syncReviewLocationStateUi()

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
    if (!locationInput._reviewLocationWarningWired) {
      locationInput._reviewLocationWarningWired = true
      locationInput.addEventListener('input', _syncReviewLocationWarning)
    }
  }
  const reviewObscured = document.getElementById('review-obscured')
  if (reviewObscured) reviewObscured.checked = state.captureDraft.location_precision === 'fuzzed'
  _updateReviewObscureHint()
  const addPhotoBtn = document.getElementById('add-photo-btn');
  if (addPhotoBtn) addPhotoBtn.style.display = 'none';

  const grid = document.getElementById('observation-grid')
  grid.classList.add('review-session-grid')
  let html

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
    const hasBlob = photos.some(photo => photo.blobPromise || isBlob(photo.blob))
    const summary = count === 1
      ? `${tp('counts.photo', 1)} · ${firstTime}`
      : `${tp('counts.photo', count)} · ${firstTime} - ${lastTime}`

    const croppedCount = photos.filter(photo => shouldShowAiCropOverlay(photo.aiCropRect, photo.aiCropIsCustom)).length
    const aiFingerprint = buildIdentifyFingerprint({
      service: ID_SERVICE_ARTSORAKEL,
      language: getTaxonomyLanguage(),
      images: photos.map((photo, index) => ({
        id: `review-${index}`,
        blob: isBlob(photo.aiBlob) ? photo.aiBlob : isBlob(photo.blob) ? photo.blob : null,
        cropRect: photo.aiCropRect || null,
        cropSourceW: photo.aiCropSourceW ?? null,
        cropSourceH: photo.aiCropSourceH ?? null,
        aiCropIsCustom: photo.aiCropIsCustom === true,
        sourceType: isBlob(photo?.aiBlob) ? 'photo.aiBlob' : 'photo.blob',
      })).filter(item => isBlob(item.blob)),
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
    const cropStatusHtml = croppedCount
      ? ''
      : `<div class="capture-session-crop-status">${t('review.aiCropHint')}</div>`

    html = `
      <div class="detail-gallery capture-session-gallery" id="review-gallery"></div>
      <div class="capture-session-summary">${summary}</div>
      ${cropStatusHtml}
      
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
  _syncReviewRedlistSummary()

  // Re-run the idempotent location wiring after the review body/card content
  // has been rebuilt.
  initLocationField()
  wireCardEvents()
  loadThumbnails(photos)
}

function loadThumbnails(photos) {
  const gallery = document.getElementById('review-gallery')
  if (!gallery) return

  _clearReviewThumbCropObserver()

  gallery.innerHTML = ''
  ;(async () => {
    for (let index = 0; index < photos.length; index++) {
      const p = photos[index]
      let blob = isBlob(p.blob) ? p.blob : null
      if (!blob && p.blobPromise) blob = await p.blobPromise

      if (isBlob(blob)) {
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

        if (shouldShowAiCropOverlay(p.aiCropRect, p.aiCropIsCustom)) {
          _renderReviewThumbCropFrame(item, img, p.aiCropRect)
        }

        gallery.appendChild(item)
        if (shouldShowAiCropOverlay(p.aiCropRect, p.aiCropIsCustom)) {
          requestAnimationFrame(() => item.__reviewThumbCropUpdate?.())
        }
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
    wireIdentifyRunButtonPressFeedback(runBtn)
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
        reviewAiState.selectedTaxonSource = 'manual'
        reviewAiState.selectedService = null
        reviewAiState.selectedPrediction = null
      } else if ((currentTaxon?.displayName || '').trim() !== value) {
        setSharedTaxon(createManualTaxon(value), { syncInputs: false, hideMenus: false })
        reviewAiState.selectedTaxonSource = 'manual'
        reviewAiState.selectedService = null
        reviewAiState.selectedPrediction = null
      }
      _syncReviewRedlistSummary()
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
  }
  _syncReviewSpeciesLabel(taxon)
}

function applyTaxon(i, taxon, options = {}) {
  setSharedTaxon(taxon, { syncInputs: true, hideMenus: true })
  if (options.source === 'ai') {
    reviewAiState.selectedTaxonSource = 'ai'
  } else {
    reviewAiState.selectedTaxonSource = 'manual'
    reviewAiState.selectedService = null
    reviewAiState.selectedPrediction = null
  }
  _syncReviewRedlistSummary()
}

// ── Identification AI ────────────────────────────────────────────────────────

async function resolveBlob(photo) {
  if (isBlob(photo.blob)) return photo.blob
  if (photo.blobPromise) return photo.blobPromise
  return null
}

async function _describeReviewBlob(blob) {
  if (!isBlob(blob)) {
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
    const blob = isBlob(photo.aiBlob) ? photo.aiBlob : await resolveBlob(photo)
    const originalBlob = isBlob(photo.blob) ? photo.blob : await resolveBlob(photo)
    if (!isBlob(blob)) return null
    const gps = photo.gps && isUsableCoordinate(photo.gps.lat, photo.gps.lon) ? photo.gps : null
    const debugPreviewUrl = shouldCaptureDebugPreviewUrls() && typeof URL?.createObjectURL === 'function'
      ? (photo._debugPreviewUrl || (photo._debugPreviewUrl = URL.createObjectURL(blob)))
      : ''
    return {
      id: `review-${index}`,
      blob,
      originalBlob: isBlob(originalBlob) ? originalBlob : null,
      cropRect: photo.aiCropRect || null,
      aiCropIsCustom: photo.aiCropIsCustom === true,
      debugPreviewUrl,
      lat: gps?.lat ?? null,
      lon: gps?.lon ?? null,
      observedOn: photo.ts ? _localDate(photo.ts) : null,
      source: isBlob(photo?.aiBlob) ? 'photo.aiBlob' : 'photo.blob',
      sourceType: isBlob(photo?.aiBlob) ? 'photo.aiBlob' : 'photo.blob',
      debug: await _describeReviewBlob(blob),
    }
  }))).filter(Boolean)
}

function _reviewCaptureImages() {
  return (state.capturedPhotos || [])
    .map((photo, index) => ({
      id: `review-${index}`,
      blob: isBlob(photo.aiBlob) ? photo.aiBlob : isBlob(photo.blob) ? photo.blob : null,
      originalBlob: isBlob(photo.blob) ? photo.blob : null,
      cropRect: photo.aiCropRect || null,
      cropSourceW: photo.aiCropSourceW ?? null,
      cropSourceH: photo.aiCropSourceH ?? null,
      aiCropIsCustom: photo.aiCropIsCustom === true,
      lat: photo.gps && isUsableCoordinate(photo.gps.lat, photo.gps.lon) ? Number(photo.gps.lat) : null,
      lon: photo.gps && isUsableCoordinate(photo.gps.lat, photo.gps.lon) ? Number(photo.gps.lon) : null,
      observedOn: photo.ts ? _localDate(photo.ts) : null,
      sourceType: isBlob(photo?.aiBlob) ? 'photo.aiBlob' : 'photo.blob',
    }))
    .filter(item => isBlob(item.blob))
}

function _buildReviewAiIdentificationRuns(photos = state.capturedPhotos) {
  const images = (photos || []).map((photo, index) => ({
    id: `review-${index}`,
    blob: isBlob(photo.aiBlob) ? photo.aiBlob : isBlob(photo.blob) ? photo.blob : null,
    originalBlob: isBlob(photo.blob) ? photo.blob : null,
    cropRect: photo.aiCropRect || null,
    cropSourceW: photo.aiCropSourceW ?? null,
    cropSourceH: photo.aiCropSourceH ?? null,
    aiCropIsCustom: photo.aiCropIsCustom === true,
    sourceType: isBlob(photo?.aiBlob) ? 'photo.aiBlob' : 'photo.blob',
  }))
  const language = getTaxonomyLanguage()
  const runs = []
  for (const service of [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]) {
    const result = reviewAiState.resultsByService?.[service] || null
    if (!result || !['success', 'no_match', 'error', 'unavailable', 'stale'].includes(result.status)) {
      continue
    }
    const status = result.status === 'stale' || (reviewAiState.stale && ['success', 'no_match', 'error', 'unavailable'].includes(result.status))
      ? 'stale'
      : result.status
    const fingerprint = buildIdentifyFingerprint({
      service,
      language,
      images,
    })
    runs.push({
      service,
      requestFingerprint: fingerprint.requestFingerprint,
      imageFingerprint: fingerprint.imageFingerprint,
      cropFingerprint: fingerprint.cropFingerprint,
      language,
      results: Array.isArray(result.predictions) ? result.predictions : [],
      status,
      errorMessage: result.errorMessage || null,
      topPrediction: result.topPrediction || null,
    })
  }
  return runs
}

function _reviewAiTabState(service, statusOverride = null) {
  const result = reviewAiState.resultsByService[service] || null
  const selectedPrediction = _reviewAiSelectedPredictionForService(service)
  const selectedProbability = reviewAiState.selectedProbabilityByService?.[service] ?? null
  const displayProbability = getReviewServiceDisplayProbability(service)
  const hasStored = ['success', 'no_match', 'error', 'stale', 'unavailable'].includes(result?.status)
    || (Array.isArray(result?.predictions) && result.predictions.length > 0)
  const hasRunResult = ['success', 'no_match', 'error', 'unavailable', 'stale'].includes(result?.status)
  return {
    service,
    active: reviewAiState.activeService === service,
    available: reviewAiState.availability?.[service]?.available ?? false,
    reason: reviewAiState.availability?.[service]?.reason || '',
    status: statusOverride || result?.status || 'idle',
    errorMessage: result?.errorMessage || '',
    topProbability: getIdentifyTopProbability(result),
    topPrediction: result?.topPrediction || null,
    selectedPrediction,
    selectedProbability,
    displayProbability,
    showCheckmark: ['success', 'stale'].includes(statusOverride || result?.status || 'idle'),
    hasStored,
    hasRunResult,
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
      screen: options.screen || 'review',
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
      score.textContent = _reviewAiHasProbability(state.displayProbability)
        ? `${Math.round(Number(state.displayProbability) * 100)}%`
        : ''
      score.style.display = score.textContent ? '' : 'none'
    }
  })
}

function _renderReviewAiResults() {
  const resultsEl = document.querySelector('[data-identify-results]')
  if (!resultsEl) return
  resultsEl.innerHTML = _reviewAiResultsHtml()
  resultsEl.style.display = ''
  const activeService = normalizeIdentifyService(reviewAiState.activeService || _resolveReviewPhotoIdServices(reviewAiState.availability).primary)
  const selectedPrediction = _reviewAiSelectedPredictionForService(activeService)
  resultsEl.querySelectorAll('[data-identify-result]').forEach(result => {
    const row = result.closest?.('.ai-result-row') || result.parentElement?.closest?.('.ai-result-row') || null
    if (result._wired) return
    result._wired = true
    const prediction = JSON.parse(result.dataset.identifyResult)
    const isSelected = Boolean(_reviewAiPredictionsEquivalent(prediction, selectedPrediction))
    result.classList.toggle('is-selected', isSelected)
    row?.classList.toggle('is-selected', isSelected)
    result.addEventListener('click', event => {
      event.preventDefault()
      const pred = JSON.parse(result.dataset.identifyResult)
      const service = normalizeIdentifyService(pred.service)
      const parts = (pred.scientificName || '').split(/\s+/)
      const taxon = {
        genus: parts[0] || '',
        specificEpithet: parts[1] || '',
        vernacularName: pred.vernacularName || null,
        scientificName: pred.scientificName || null,
        displayName: pred.displayName,
      }
      reviewAiState.activeService = service
      reviewAiState.selectedTaxonSource = 'ai'
      reviewAiState.selectedService = service
      reviewAiState.selectedPrediction = pred
      reviewAiState.selectedPredictionByService = {
        ...(reviewAiState.selectedPredictionByService || {}),
        [service]: pred,
      }
      reviewAiState.selectedProbabilityByService = {
        ...(reviewAiState.selectedProbabilityByService || {}),
        [service]: _reviewAiPredictionProbability(pred),
      }
      applyTaxon(0, taxon, { source: 'ai' })
      reviewAiState.stale = reviewAiState.requestedFingerprint !== reviewAiState.currentFingerprint
      _renderReviewAiBlock()
    })
  })
}

function _renderReviewAiBlock() {
  _renderReviewAiTabs()
  _renderReviewAiResults()
  _syncReviewRedlistSummary()
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
      <div id="review-redlist-summary" style="display:none"></div>
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
    blobs: images,
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
  reviewAiState.selectedService = null
  reviewAiState.selectedPrediction = null
  reviewAiState.selectedPredictionByService = {}
  reviewAiState.selectedProbabilityByService = {}
  reviewAiState.selectedTaxonSource = null

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
        lat: (() => {
          const gps = state.reviewContext?.gps || state.capturedPhotos.find(photo => photo.gps && isUsableCoordinate(photo.gps.lat, photo.gps.lon))?.gps || null
          return gps && isUsableCoordinate(gps.lat, gps.lon) ? Number(gps.lat) : null
        })(),
        lon: (() => {
          const gps = state.reviewContext?.gps || state.capturedPhotos.find(photo => photo.gps && isUsableCoordinate(photo.gps.lat, photo.gps.lon))?.gps || null
          return gps && isUsableCoordinate(gps.lat, gps.lon) ? Number(gps.lon) : null
        })(),
        observedOn: _localDate(state.capturedPhotos[0]?.ts || state.sessionStart || new Date()),
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
    reviewAiState.stale = false
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
    if (!isBlob(blob)) continue
    reviewImages.push({
      url: URL.createObjectURL(blob),
      aiCropRect: photo.aiCropRect || null,
      aiCropIsCustom: photo.aiCropIsCustom === true,
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
  _disposeReviewDebugPreviewUrls()
  state.capturedPhotos = []
  state.reviewContext = null
  state.batchCount = 0
  state.captureDraft = createDefaultObservationDraft()
  reviewAiState.running = false
  reviewAiState.activeService = null
  reviewAiState.hasRun = false
  reviewAiState.selectedService = null
  reviewAiState.selectedPrediction = null
  reviewAiState.selectedPredictionByService = {}
  reviewAiState.selectedProbabilityByService = {}
  reviewAiState.selectedTaxonSource = null
  reviewAiState.requestedFingerprint = ''
  reviewAiState.currentFingerprint = ''
  reviewAiState.availabilityFingerprint = ''
  reviewAiState.stale = false
  reviewAiState.availability = {}
  reviewAiState.resultsByService = {}
  endCaptureLocationSession()
  _clearReviewLocationWarningSuppression()
  _clearReviewSaveLocationSuppression()
  _hideReviewSaveLocationSheet(null)
  reviewLocationLastLookupKey = ''
  resetLocationState()
  navigate('home')
}

function _localDate(ts) {
  return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`
}

async function saveObservationBatch() {
  if (!state.user) { showToast(t('review.notSignedIn')); return }
  if (!state.capturedPhotos.length) { showToast(t('review.noPhotosToSync')); return }
  if (reviewSaveInFlight) return

  debugImagePipeline('save review batch requested', {
    photoCount: state.capturedPhotos.length,
  })

  const btn = document.getElementById('review-save-btn')
  if (btn) btn.disabled = true
  reviewSaveInFlight = true

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
    const leadPhoto = photos[0] || {}
    const taxon = photos.find(photo => photo.taxon)?.taxon || {}
    const aiIdentificationRuns = _buildReviewAiIdentificationRuns(photos)
    const selectedPrediction = reviewAiState.selectedTaxonSource === 'ai'
      ? (reviewAiState.selectedPrediction || (
          reviewAiState.selectedService
            ? reviewAiState.selectedPredictionByService?.[reviewAiState.selectedService] || null
            : null
        ))
      : null
    const selectedService = reviewAiState.selectedTaxonSource === 'ai' && (reviewAiState.selectedService || selectedPrediction?.service)
      ? normalizeIdentifyService(reviewAiState.selectedService || selectedPrediction?.service || '')
      : null
    const obsPayload = createDefaultObservationPayload({
      user_id: state.user.id,
      date: _localDate(leadPhoto.ts || new Date()),
      captured_at: (leadPhoto.ts || new Date()).toISOString(),
      gps_latitude: null,
      gps_longitude: null,
      gps_altitude: null,
      gps_accuracy: null,
      location: getLocationName() || null,
      habitat: state.captureDraft.habitat.trim() || null,
      notes: state.captureDraft.notes.trim() || null,
      uncertain: !!state.captureDraft.uncertain,
      source_type: 'personal',
      genus: taxon.genus || null,
      species: taxon.specificEpithet || null,
      common_name: taxon.vernacularName || null,
      visibility: toCloudVisibility(visibility),
      is_draft: state.captureDraft.is_draft !== false,
      location_precision: state.captureDraft.location_precision || 'exact',
      ai_selected_service: selectedService || null,
      ai_selected_taxon_id: selectedPrediction?.taxonId || null,
      ai_selected_scientific_name: selectedPrediction?.scientificName || null,
      ai_selected_probability: selectedService
        ? reviewAiState.selectedProbabilityByService?.[selectedService] ?? selectedPrediction?.probability ?? null
        : null,
      ai_selected_at: selectedService ? new Date().toISOString() : null,
      aiIdentificationRuns,
    })

    const locationResult = await _resolveReviewSaveLocation()
    if (state.currentScreen !== 'review' || !locationResult || locationResult.action === 'manual' || locationResult.action === 'abort') return
    const finalGps = _canonicalReviewSaveGps()
    obsPayload.gps_latitude = finalGps?.lat ?? null
    obsPayload.gps_longitude = finalGps?.lon ?? null
    obsPayload.gps_altitude = finalGps?.altitude ?? null
    obsPayload.gps_accuracy = finalGps?.accuracy ?? null

    const imageEntries = photos
      .filter(photo => isBlob(photo.blob))
      .map(photo => ({
        blob: photo.blob,
        aiCropRect: photo.aiCropRect || null,
        aiCropSourceW: photo.aiCropSourceW ?? null,
        aiCropSourceH: photo.aiCropSourceH ?? null,
        aiCropIsCustom: photo.aiCropIsCustom === true,
      }))

    debugImagePipeline('review batch ready for queue', {
      photoCount: photos.length,
      imageEntryCount: imageEntries.length,
    })
      
    _setProgress(0, 1, 'Encoding images for storage...')
    await new Promise(r => setTimeout(r, 100)) // Yield to let button un-press
    await _reviewDependency('enqueueObservation')(obsPayload, imageEntries)

    showToast(t('review.synced', { count: tp('counts.photo', photos.length) }))
    debugImagePipeline('review batch enqueued successfully', {
      photoCount: photos.length,
      imageEntryCount: imageEntries.length,
    })
    _disposeReviewDebugPreviewUrls()
    state.capturedPhotos = []
    state.reviewContext = null
    state.batchCount = 0
    state.captureDraft = createDefaultObservationDraft()
    endCaptureLocationSession()
    _clearReviewLocationWarningSuppression()
    _clearReviewSaveLocationSuppression()
    _hideReviewSaveLocationSheet(null)
    reviewLocationLastLookupKey = ''
    resetLocationState()
    await _reviewDependency('refreshHome')()
    await _reviewDependency('openFinds')('mine', { resetSearch: true })
  } catch (err) {
    showToast(t('review.syncFailed', { message: err.message }))
    console.error('Sync error:', err)
  } finally {
    _disposeReviewDebugPreviewUrls()
    _hideProgress()
    reviewSaveInFlight = false
    if (btn) btn.disabled = false
  }
}

async function _openCameraForReview() {
  if (isAndroidNativeApp()) {
    try {
      const screenPath = 'review:add-photo'
      const captureSource = 'Sporely native camera'
      const reviewGps = _currentReviewNativeCameraGps()
      const gps = reviewGps && isUsableCoordinate(reviewGps.lat, reviewGps.lon)
        ? {
            latitude: reviewGps.lat,
            longitude: reviewGps.lon,
            altitude: reviewGps.altitude,
            accuracy: reviewGps.accuracy,
          }
        : null
      debugImagePipeline('android native camera capture requested', {
        screenPath,
        captureSource,
        gps,
      })
      playIrisShutter({ mode: 'quick' })
      const result = await NativeCamera.capturePhotos(gps ? { gps } : {})
      const photos = Array.isArray(result?.photos) ? result.photos : []
      debugImagePipeline('android native camera capture returned', {
        screenPath,
        captureSource,
        photoCount: photos.length,
        nativeResult: result?.debug || result?.metadata || null,
        photoMeta: photos.map(photo => ({
          name: photo?.name || null,
          mimeType: photo?.mimeType || null,
          format: photo?.format || null,
          size: photo?.size || null,
        })),
      })
      if (!photos.length) return
      _setProgress(0, photos.length, t('import.readingFiles'))
      const files = []
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
        files.push(await nativePickedPhotoToFile(photos[i], i, { captureSource, screenPath }))
      }
      debugImagePipeline('android native files ready for review upload', {
        screenPath,
        captureSource,
        fileCount: files.length,
        fileSizes: files.map(file => file?.size || 0),
      })
      await _addFilesToReview(files, { nativePhotos: photos, captureSource, screenPath })
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
      const screenPath = 'review:add-photo'
      const captureSource = 'native picker/import'
      const result = await pickImagesWithNativePhotoPicker()
      const photos = Array.isArray(result?.photos) ? result.photos : []
      if (!photos.length) return
      debugImagePipeline('android native picker returned', {
        screenPath,
        captureSource,
        photoCount: photos.length,
        photoMeta: photos.map(photo => ({
          name: photo?.name || null,
          mimeType: photo?.mimeType || null,
          format: photo?.format || null,
          size: photo?.size || null,
        })),
      })
      _setProgress(0, photos.length, t('import.readingFiles'))
      const files = []
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
        files.push(await nativePickedPhotoToFile(photos[i], i, { captureSource, screenPath }))
      }
      debugImagePipeline('android native files ready for review upload', {
        screenPath,
        captureSource,
        fileCount: files.length,
        fileSizes: files.map(file => file?.size || 0),
      })
      await _addFilesToReview(files, { nativePhotos: photos, captureSource, screenPath })
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
  const captureSource = options.captureSource || 'Sporely native camera'
  const screenPath = options.screenPath || 'review:add-photo'
  const supportedSelection = _filterUnsupportedBrowserFiles(files, nativePhotos)
  const supportedFiles = supportedSelection.files
  const supportedNativePhotos = supportedSelection.nativePhotos
  if (!supportedFiles.length) return
  _setProgress(0, supportedFiles.length, t('import.readingTimestamps'))

  const withTimes = await Promise.all(supportedFiles.map(async (f, idx) => {
    const nativePhoto = supportedNativePhotos[idx]
    if (nativePhoto) {
      const { time, lat, lon, altitude, accuracy, dbg } = await captureNativePhotoExif(nativePhoto, f, { captureSource, screenPath })
      return { file: f, nativePhoto, metadataPromise: createNativeMetadataHydrationPromise(nativePhoto, f), captureTime: time, lat, lon, altitude, accuracy, dbg }
    }
    const { time, lat, lon, altitude, accuracy, dbg } = await captureExif(f)
    return { file: f, captureTime: time, lat, lon, altitude, accuracy, dbg }
  }))

  let doneCount = 0
  for (let idx = 0; idx < withTimes.length; idx++) {
    const item = withTimes[idx]
    _setProgress(doneCount, supportedFiles.length, t('import.convertingFile', { current: doneCount + 1, total: supportedFiles.length }))
    const processed = await processFile(item.file, { nativePhoto: item.nativePhoto, captureSource, screenPath })
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
      aiCropIsCustom: processed.meta?.aiCropIsCustom === true,
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

function _filterUnsupportedBrowserFiles(files, nativePhotos = []) {
  return { files, nativePhotos }
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
