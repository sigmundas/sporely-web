import { supabase } from '../supabase.js'
import { formatDate, formatTime, getLocale, getTaxonomyLanguage, t } from '../i18n.js'
import { state } from '../state.js'
import { navigate, goBack } from '../router.js'
import { showToast } from '../toast.js'
import { searchTaxa, formatDisplayName, splitScientificName } from '../artsorakel.js'
import {
  buildIdentifyFingerprint,
  debugPhotoId,
  getAvailableIdentifyServices,
  getIdentifyTopProbability,
  _renderServiceIcon,
  loadObservationIdentifications,
  renderIdentifyResultRows,
  renderIdentifyRedlistSummary,
  getPredictionRedlistCategory,
  getPredictionRedlistCategoriesMap,
  saveIdentificationRun,
  markRequestedServicesRunning,
  shouldRunServiceFromTab,
  wireIdentifyRunButtonPressFeedback,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
} from '../ai-identification.js'
import { fetchCommentAuthorMap, getCommentAuthor } from '../comments.js'
import { deleteObservationMedia, downloadObservationImageBlob, resolveMediaSources, updateObservationImageCrop, prepareImageVariants, uploadPreparedObservationImageVariants, insertObservationImage, syncObservationMediaKeys, imageExtensionForBlob, buildObservationImageStoragePath, fetchObservationImageRows } from '../images.js'
import { classifyDraftAge, loadFinds, openFinds } from './finds.js'
import { openPhotoViewer } from '../photo-viewer.js'
import { openAiCropEditor } from '../ai-crop-editor.js'
import { createImageCropMeta, normalizeAiCropRect, shouldShowAiCropOverlay } from '../image_crop.js'
import { esc as _esc } from '../esc.js'
import { getArtsorakelMaxEdge, getDefaultVisibility, getPhotoIdMode, resolvePhotoIdServices, setLastSyncAt, getUseSystemCamera, NATIVE_CAMERA_JPEG_QUALITY } from '../settings.js'
import { normalizeVisibility, observationUsesPrivacySlot, toCloudVisibility } from '../visibility.js'
import { getIdentifyNoMatchMessage, runIdentifyForBlobs, runIdentifyForMediaKeys } from '../identify.js'
import { loadInaturalistSession } from '../inaturalist.js'
import { refreshHome } from './home.js'
import { loadPeopleSocialState } from './people.js'
import { buildGpsMetaHtml } from './review.js'
import { lookupCoordinateKey, lookupReverseLocation } from '../location-lookup.js'
import { fetchCloudPlanProfile } from '../cloud-plan.js'
import { isAndroidNativeApp } from '../camera-actions.js'
import { playIrisShutter } from '../iris-shutter.js'
import { NativeCamera, isPickerCancel, pickImagesWithNativePhotoPicker, nativePickedPhotoToFile } from './import-helpers.js'
import { setCaptureCompleteHandler } from './capture.js'
import { debugImagePipeline } from '../image-pipeline-debug.js'
import { prepareImageBlobForUpload } from '../image_crop.js'
import { isBlob } from '../observation-shapes.js'

let currentObs    = null
let selectedTaxon = null
let currentObsIsOwner = false
let returnScreenOverride = null
let hideCancelOverride = false
let detailLocationSuggestions = []
let detailLocationLookupKey = ''
let detailLocationAutoApplied = ''
let detailLocationLookup = null
let detailImageRows = []
let detailImageSources = []
let detailAiSources = []
let detailAuthorProfile = null
let detailFriendship = null
let detailFollowState = { user: false, observation: false, taxon: false, genus: false }
let detailPrivacySlotCount = null
const detailAiState = {
  running: false,
  runningByService: {},
  activeService: null,
  availability: {},
  resultsByService: {},
  cachedRows: [],
  selectedService: null,
  selectedPrediction: null,
  selectedPredictionByService: {},
  selectedProbabilityByService: {},
  currentFingerprint: '',
  requestedFingerprint: '',
  currentFingerprintByService: {},
  requestedFingerprintByService: {},
  localInputsChanged: false,
  stale: false,
}

let detailThumbCropObserver = null
let detailThumbCropFrameUpdates = new WeakMap()
let detailImageCropDirty = false

function _clearDetailThumbCropObserver() {
  detailThumbCropObserver?.disconnect()
  detailThumbCropObserver = null
  detailThumbCropFrameUpdates = new WeakMap()
}

function _findDetailGalleryItemByImageId(imageId) {
  const targetId = String(imageId || '').trim()
  if (!targetId) return null
  return Array.from(document.querySelectorAll('#detail-gallery .detail-gallery-item-wrap'))
    .find(item => String(item?.dataset?.imageId || '').trim() === targetId) || null
}

function _renderDetailThumbCropFrame(item, img, rect) {
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

  detailThumbCropFrameUpdates.set(item, update)
  item.__detailThumbCropUpdate = update
  if (typeof ResizeObserver !== 'undefined') {
    if (!detailThumbCropObserver) {
      detailThumbCropObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          detailThumbCropFrameUpdates.get(entry.target)?.()
        }
      })
    }
    detailThumbCropObserver.observe(item)
  }

  const scheduleUpdate = () => requestAnimationFrame(update)
  img.addEventListener('load', scheduleUpdate, { once: true })
  scheduleUpdate()

  return frame
}

function _syncDetailThumbCropOverlay(item, row) {
  if (!item || !row) return
  const img = item.querySelector('.detail-gallery-img')
  if (!img) return

  item.querySelectorAll('.ai-crop-frame--thumb').forEach(node => node.remove())
  detailThumbCropFrameUpdates.delete(item)
  delete item.__detailThumbCropUpdate

  const rect = normalizeAiCropRect({
    x1: row.ai_crop_x1,
    y1: row.ai_crop_y1,
    x2: row.ai_crop_x2,
    y2: row.ai_crop_y2,
  })
  if (!shouldShowAiCropOverlay(rect, row.ai_crop_is_custom === true)) return

  _renderDetailThumbCropFrame(item, img, rect)
  requestAnimationFrame(() => item.__detailThumbCropUpdate?.())
}

function _hasStoredAiResult(result = null) {
  return ['success', 'no_match', 'error', 'stale', 'unavailable'].includes(result?.status)
    || (Array.isArray(result?.predictions) && result.predictions.length > 0)
}

function _hasAiRunResult(result = null) {
  return ['success', 'no_match', 'error', 'unavailable', 'stale'].includes(result?.status)
}

function _tf(key, fallback) {
  const value = t(key)
  return value && value !== key ? value : fallback
}

function _detailAiRunDisabledTitle() {
  return _tf('detail.onlyOwnerRunAiId', 'Only the owner can run AI Photo ID')
}

function _canViewDetailAiResult(service, result = null) {
  void service
  return _hasStoredAiResult(result)
    || result?.status === 'running'
}

function _canRunDetailAiService(service, result = null) {
  const normalizedService = normalizeIdentifyService(service)
  return currentObsIsOwner
    && Boolean(detailAiState.availability?.[normalizedService]?.available)
    && !detailAiState.running
    && !detailAiState.runningByService?.[normalizedService]
    && shouldRunServiceFromTab(result)
}

function _detailAiNormalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function _detailAiObservationScientificName(obs = currentObs) {
  return _detailAiNormalizeText([obs?.genus, obs?.species].filter(Boolean).join(' '))
}

function _buildShareFilenameStem(obs) {
  const sci = [obs?.genus, obs?.species].filter(Boolean).join(' ').trim()
    || obs?.ai_selected_scientific_name
    || obs?.common_name
    || ''
  const date = _shareObservationDate(obs)
  const name = _shareFilenameSlug(sci) || 'sporely'
  return date ? `${name}-${date}` : name
}

function _shareObservationDate(obs) {
  const raw = obs?.date || obs?.captured_at || obs?.created_at
  if (!raw) return ''
  const dt = new Date(raw)
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10)
  return String(raw).slice(0, 10)
}

function _shareFilenameSlug(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
}

function _detailAiObservationCommonName(obs = currentObs) {
  return _detailAiNormalizeText(obs?.common_name || '')
}

function _detailAiPredictionMatchesObservation(prediction = {}, obs = currentObs) {
  const obsScientificName = _detailAiObservationScientificName(obs)
  const obsCommonName = _detailAiObservationCommonName(obs)
  const predictionScientificName = _detailAiNormalizeText(prediction?.scientificName || '')
  const predictionCommonName = _detailAiNormalizeText(prediction?.vernacularName || '')
  const predictionTaxonId = _detailAiNormalizeText(prediction?.taxonId || '')
  const selectedTaxonId = _detailAiNormalizeText(obs?.ai_selected_taxon_id || '')
  const selectedScientificName = _detailAiNormalizeText(obs?.ai_selected_scientific_name || '')

  if (selectedTaxonId && predictionTaxonId && selectedTaxonId === predictionTaxonId) {
    return true
  }
  if (selectedScientificName && predictionScientificName && selectedScientificName === predictionScientificName) {
    return true
  }
  if (obsScientificName && predictionScientificName && obsScientificName === predictionScientificName) {
    return true
  }
  if (obsCommonName && predictionCommonName && obsCommonName === predictionCommonName) {
    return true
  }
  return false
}

function _detailAiPredictionsEquivalent(left = null, right = null) {
  if (!left || !right) return false
  const leftTaxonId = _detailAiNormalizeText(left?.taxonId || '')
  const rightTaxonId = _detailAiNormalizeText(right?.taxonId || '')
  const leftScientificName = _detailAiNormalizeText(left?.scientificName || '')
  const rightScientificName = _detailAiNormalizeText(right?.scientificName || '')
  return (
    (leftTaxonId && rightTaxonId && leftTaxonId === rightTaxonId)
    || (leftScientificName && rightScientificName && leftScientificName === rightScientificName)
  )
}

function _detailAiPredictionMatchRank(prediction = {}, service = null, obs = currentObs) {
  const normalizedService = normalizeIdentifyService(service || prediction?.service)
  const obsScientificName = _detailAiObservationScientificName(obs)
  const obsCommonName = _detailAiObservationCommonName(obs)
  const predictionScientificName = _detailAiNormalizeText(prediction?.scientificName || '')
  const predictionCommonName = _detailAiNormalizeText(prediction?.vernacularName || '')
  const predictionTaxonId = _detailAiNormalizeText(prediction?.taxonId || '')
  const selectedTaxonId = _detailAiNormalizeText(obs?.ai_selected_taxon_id || '')
  const selectedScientificName = _detailAiNormalizeText(obs?.ai_selected_scientific_name || '')
  const selectedService = normalizeIdentifyService(obs?.ai_selected_service || '')
  const probability = Number(prediction?.probability ?? 0)

  if (selectedService && selectedService === normalizedService) return 5000 + probability
  if (selectedTaxonId && predictionTaxonId && selectedTaxonId === predictionTaxonId) return 4000 + probability
  if (selectedScientificName && predictionScientificName && selectedScientificName === predictionScientificName) return 3000 + probability
  if (obsScientificName && predictionScientificName && obsScientificName === predictionScientificName) return 2000 + probability
  if (obsCommonName && predictionCommonName && obsCommonName === predictionCommonName) return 1000 + probability
  if (probability > 0) return probability
  return 0
}

function _detailAiPredictionProbability(prediction = null, fallback = null) {
  if (!prediction) return Number.isFinite(Number(fallback)) ? Number(fallback) : null
  const value = Number(prediction?.probability ?? fallback)
  return Number.isFinite(value) ? value : null
}

function _detailAiHasProbability(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function _detailAiCropMetaFromRow(row = {}) {
  const normalizeNumber = value => {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return {
    aiCropRect: normalizeAiCropRect({
      x1: row.ai_crop_x1,
      y1: row.ai_crop_y1,
      x2: row.ai_crop_x2,
      y2: row.ai_crop_y2,
    }),
    aiCropSourceW: normalizeNumber(row.ai_crop_source_w),
    aiCropSourceH: normalizeNumber(row.ai_crop_source_h),
    aiCropIsCustom: row.ai_crop_is_custom === true,
  }
}

function _detailAiCropMetaFromEdit(meta = {}) {
  const normalizeNumber = value => {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return {
    aiCropRect: normalizeAiCropRect(meta.aiCropRect),
    aiCropSourceW: normalizeNumber(meta.aiCropSourceW),
    aiCropSourceH: normalizeNumber(meta.aiCropSourceH),
    aiCropIsCustom: meta.aiCropIsCustom === true,
  }
}

function _detailAiCropMetaEquals(left = null, right = null) {
  const leftRect = normalizeAiCropRect(left?.aiCropRect)
  const rightRect = normalizeAiCropRect(right?.aiCropRect)
  return (
    leftRect?.x1 === rightRect?.x1
    && leftRect?.y1 === rightRect?.y1
    && leftRect?.x2 === rightRect?.x2
    && leftRect?.y2 === rightRect?.y2
    && (left?.aiCropSourceW ?? null) === (right?.aiCropSourceW ?? null)
    && (left?.aiCropSourceH ?? null) === (right?.aiCropSourceH ?? null)
    && (left?.aiCropIsCustom === true) === (right?.aiCropIsCustom === true)
  )
}

function _detailAiCropInputEquals(left = null, right = null) {
  const leftRect = normalizeAiCropRect(left?.aiCropRect)
  const rightRect = normalizeAiCropRect(right?.aiCropRect)
  return (
    leftRect?.x1 === rightRect?.x1
    && leftRect?.y1 === rightRect?.y1
    && leftRect?.x2 === rightRect?.x2
    && leftRect?.y2 === rightRect?.y2
    && (left?.aiCropSourceW ?? null) === (right?.aiCropSourceW ?? null)
    && (left?.aiCropSourceH ?? null) === (right?.aiCropSourceH ?? null)
  )
}

function _detailAiCropMetaMap(rows = detailImageRows) {
  return new Map((Array.isArray(rows) ? rows : []).map(row => [String(row?.id || ''), _detailAiCropMetaFromRow(row)]))
}

function _detailAiCropMetaMapChanged(originalMap = new Map(), rows = detailImageRows) {
  const currentMap = _detailAiCropMetaMap(rows)
  if (originalMap.size !== currentMap.size) return true
  for (const [id, originalMeta] of originalMap.entries()) {
    const currentMeta = currentMap.get(id)
    if (!currentMeta || !_detailAiCropMetaEquals(originalMeta, currentMeta)) {
      return true
    }
  }
  return false
}

function _detailAiCropInputMapChanged(originalMap = new Map(), rows = detailImageRows) {
  const currentMap = _detailAiCropMetaMap(rows)
  if (originalMap.size !== currentMap.size) return true
  for (const [id, originalMeta] of originalMap.entries()) {
    const currentMeta = currentMap.get(id)
    if (!currentMeta || !_detailAiCropInputEquals(originalMeta, currentMeta)) {
      return true
    }
  }
  return false
}

function _detailAiFingerprintText(value = '') {
  return String(value ?? '').trim()
}

function _detailAiFingerprintFromValue(value = {}) {
  if (typeof value === 'string') {
    return {
      requestFingerprint: _detailAiFingerprintText(value),
      imageFingerprint: '',
      cropFingerprint: '',
    }
  }
  return {
    requestFingerprint: _detailAiFingerprintText(value?.requestFingerprint ?? value?.request_fingerprint ?? ''),
    imageFingerprint: _detailAiFingerprintText(value?.imageFingerprint ?? value?.image_fingerprint ?? ''),
    cropFingerprint: _detailAiFingerprintText(value?.cropFingerprint ?? value?.crop_fingerprint ?? ''),
  }
}

function _detailAiCachedRowTimestamp(row = {}) {
  const rawTimestamp = row?.created_at || row?.updated_at || row?.createdAt || row?.updatedAt || ''
  const parsedTimestamp = Date.parse(rawTimestamp)
  return Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
}

function _detailAiSortRowsNewestFirst(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .slice()
    .sort((left, right) => {
      const timeDelta = _detailAiCachedRowTimestamp(right) - _detailAiCachedRowTimestamp(left)
      if (timeDelta !== 0) return timeDelta
      return String(right?.id || '').localeCompare(String(left?.id || ''))
    })
}

function _detailAiCachedRowMatchesInputs(row = {}, currentFingerprint = {}) {
  const current = _detailAiFingerprintFromValue(currentFingerprint)
  const rowImageFingerprint = _detailAiFingerprintText(row?.image_fingerprint || '')
  const rowCropFingerprint = _detailAiFingerprintText(row?.crop_fingerprint || '')
  if (!current.imageFingerprint || !current.cropFingerprint || !rowImageFingerprint || !rowCropFingerprint) {
    return false
  }
  return rowImageFingerprint === current.imageFingerprint
    && rowCropFingerprint === current.cropFingerprint
}

function _detailAiCachedRowHasInputChange(row = {}, currentFingerprint = {}) {
  const current = _detailAiFingerprintFromValue(currentFingerprint)
  const rowImageFingerprint = _detailAiFingerprintText(row?.image_fingerprint || '')
  const rowCropFingerprint = _detailAiFingerprintText(row?.crop_fingerprint || '')
  const imageChanged = Boolean(rowImageFingerprint && current.imageFingerprint && rowImageFingerprint !== current.imageFingerprint)
  const cropChanged = Boolean(rowCropFingerprint && current.cropFingerprint && rowCropFingerprint !== current.cropFingerprint)
  return imageChanged || cropChanged
}

function _detailAiCachedResultStatus(row = {}, currentFingerprint = {}) {
  const results = Array.isArray(row?.results) ? row.results : []
  const baseStatus = row?.status || (results.length ? 'success' : 'no_match')
  if (_detailAiCachedRowHasInputChange(row, currentFingerprint)) {
    return 'stale'
  }
  if (baseStatus !== 'stale') return baseStatus
  if (row?.error_message) return 'error'
  if (results.length) return 'success'
  return 'no_match'
}

function _detailAiSelectCachedRowForService(rows = [], currentFingerprint = {}) {
  const sortedRows = _detailAiSortRowsNewestFirst(rows)
  const current = _detailAiFingerprintFromValue(currentFingerprint)
  if (current.requestFingerprint) {
    const exactMatch = sortedRows.find(item => _detailAiFingerprintFromValue(item).requestFingerprint === current.requestFingerprint)
    if (exactMatch) return exactMatch
  }
  const inputMatch = sortedRows.find(item => _detailAiCachedRowMatchesInputs(item, current))
  if (inputMatch) return inputMatch
  return sortedRows[0] || null
}

function _detailAiSelectionStateFromResults(resultsByService = {}, obs = currentObs) {
  const explicitSelectedService = obs?.ai_selected_service
    ? normalizeIdentifyService(obs.ai_selected_service)
    : null
  const explicitSelectedProbability = Number(obs?.ai_selected_probability)
  const selectedResult = explicitSelectedService
    ? resultsByService?.[explicitSelectedService] || null
    : null
  const explicitPrediction = selectedResult
    ? (Array.isArray(selectedResult?.predictions) ? selectedResult.predictions : [])
      .find(prediction => _detailAiPredictionMatchesObservation(prediction, obs))
    : null
  return {
    selectedService: explicitSelectedService,
    selectedPrediction: explicitPrediction || null,
    selectedPredictionByService: explicitPrediction && explicitSelectedService
      ? { [explicitSelectedService]: explicitPrediction }
      : {},
    selectedProbabilityByService: explicitSelectedService && Number.isFinite(explicitSelectedProbability)
      ? { [explicitSelectedService]: explicitSelectedProbability }
      : {},
  }
}

export function getDetailDraftExplanationLines(obs = currentObs, now = Date.now()) {
  if (obs?.is_draft !== true) return []

  const lines = [t('detail.draftOnlyVisible') || 'Only visible to you.']
  const visibility = normalizeVisibility(obs.visibility, 'public')
  if (visibility === 'friends') {
    lines.push(t('detail.draftWillBeFriends') || 'Will be visible to friends when published.')
  } else if (visibility === 'private') {
    lines.push(t('detail.draftWillBePrivate') || 'Private when published.')
  } else {
    lines.push(t('detail.draftWillBePublic') || 'Will be public when published.')
  }

  const ageState = classifyDraftAge(obs, now)
  if (ageState === 'old') {
    lines.push(t('detail.oldDraft') || 'Old draft - review when ready.')
  } else if (ageState === 'stale') {
    lines.push(t('detail.staleDraft') || 'Stale draft - publish, keep as draft, or delete when ready.')
  }

  return lines
}

const DETAIL_SELECT = 'id, user_id, date, created_at, captured_at, genus, species, common_name, ai_selected_service, ai_selected_taxon_id, ai_selected_scientific_name, ai_selected_probability, ai_selected_at, location, habitat, notes, uncertain, gps_latitude, gps_longitude, gps_altitude, gps_accuracy, visibility, is_draft, location_precision'
const DETAIL_SELECT_LEGACY = 'id, user_id, date, created_at, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, gps_altitude, gps_accuracy, visibility'
const DETAIL_VIEW_SELECT = 'id, user_id, date, created_at, captured_at, genus, species, common_name, ai_selected_service, ai_selected_taxon_id, ai_selected_scientific_name, ai_selected_probability, ai_selected_at, red_list_category, red_list_categories_json, location, habitat, notes, uncertain, gps_latitude, gps_longitude, visibility, is_draft, location_precision'
const DETAIL_VIEW_SELECT_LEGACY = 'id, user_id, date, created_at, captured_at, genus, species, common_name, location, habitat, notes, uncertain, gps_latitude, gps_longitude, visibility'
const DETAIL_AI_SELECTION_FIELDS = [
  'ai_selected_service',
  'ai_selected_taxon_id',
  'ai_selected_scientific_name',
  'ai_selected_probability',
  'ai_selected_at',
]
const DETAIL_AI_SELECTION_TAXON_FIELDS = [
  'genus',
  'species',
  'common_name',
]
const DETAIL_AI_SELECTION_REDLIST_FIELDS = [
  'red_list_category',
  'red_list_categories_json',
]
const DETAIL_IMAGE_SELECT_WITH_CUSTOM = 'id, storage_path, sort_order, image_type, ai_crop_x1, ai_crop_y1, ai_crop_x2, ai_crop_y2, ai_crop_source_w, ai_crop_source_h, ai_crop_is_custom'
const DETAIL_IMAGE_SELECT_WITHOUT_CUSTOM = 'id, storage_path, sort_order, image_type, ai_crop_x1, ai_crop_y1, ai_crop_x2, ai_crop_y2, ai_crop_source_w, ai_crop_source_h'
const DETAIL_IMAGE_SELECT_BASE = 'id, storage_path, sort_order'
const DETAIL_UNAVAILABLE_SECTION_IDS = [
  'detail-author',
  'detail-social-row',
  'detail-gallery',
  'detail-form',
  'comments-section',
  'detail-footer',
  'detail-readonly-note',
]

function _setDetailUnavailableSectionVisibility(visible) {
  const nextDisplay = visible ? '' : 'none'
  for (const id of DETAIL_UNAVAILABLE_SECTION_IDS) {
    const el = document.getElementById(id)
    if (!el) continue
    el.style.display = nextDisplay
  }
}

function _renderDetailUnavailableState(message = 'Observation not found or not visible.', detail = 'This observation may be private, deleted, or no longer shared with you.') {
  _setDetailUnavailableSectionVisibility(false)

  const commonEl = document.getElementById('detail-title-common')
  const latinEl = document.getElementById('detail-title-latin')
  const noteEl = document.getElementById('detail-readonly-note')
  if (commonEl) commonEl.textContent = message
  if (latinEl) {
    latinEl.textContent = detail
    latinEl.style.display = detail ? 'block' : 'none'
  }
  if (noteEl) {
    noteEl.textContent = detail
    noteEl.style.display = detail ? 'block' : 'none'
  }

  const dateEl = document.getElementById('detail-date')
  const timeEl = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (dateEl) dateEl.textContent = '—'
  if (timeEl) timeEl.style.display = 'none'
  if (timeVal) timeVal.textContent = ''
}

function _clearDetailUnavailableState() {
  _setDetailUnavailableSectionVisibility(true)
  const noteEl = document.getElementById('detail-readonly-note')
  if (noteEl) {
    noteEl.textContent = ''
    noteEl.style.display = 'none'
  }
}

function _normalizeDetailImageRows(rows = []) {
  return (rows || []).map(row => ({
    ...row,
    image_type: row.image_type || 'field',
    ai_crop_x1: row.ai_crop_x1 ?? null,
    ai_crop_y1: row.ai_crop_y1 ?? null,
    ai_crop_x2: row.ai_crop_x2 ?? null,
    ai_crop_y2: row.ai_crop_y2 ?? null,
    ai_crop_source_w: row.ai_crop_source_w ?? null,
    ai_crop_source_h: row.ai_crop_source_h ?? null,
    ai_crop_is_custom: row.ai_crop_is_custom === true,
  }))
}

function _isPhase7ColumnError(error) {
  const message = String(error?.message || '').toLowerCase()
  return !!error && (message.includes('is_draft') || message.includes('location_precision'))
}

function _isMissingObservationColumnError(error, columnNames = []) {
  const message = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  if (!message) return false
  return (Array.isArray(columnNames) ? columnNames : []).some(column => message.includes(`'${String(column).toLowerCase()}'`) || message.includes(String(column).toLowerCase()))
}

function _missingObservationColumnsFromError(error) {
  const message = String(error?.message || error?.details || error?.hint || '')
  const matchedColumns = new Set()
  const regex = /could not find the '([^']+)' column/gi
  let match
  while ((match = regex.exec(message))) {
    matchedColumns.add(match[1])
  }
  return matchedColumns
}

function _removeMissingObservationColumnsFromPatch(patch = {}, error = null, fieldNames = []) {
  const nextPatch = { ...patch }
  const missingColumns = _missingObservationColumnsFromError(error)
  const normalizedMissing = new Set(Array.from(missingColumns, value => String(value).toLowerCase()))
  let removed = false
  for (const field of fieldNames || []) {
    const normalizedField = String(field || '').toLowerCase()
    if (normalizedMissing.has(normalizedField) || _isMissingObservationColumnError(error, [field])) {
      if (field in nextPatch) {
        delete nextPatch[field]
        removed = true
      }
    }
  }
  return { patch: nextPatch, removed }
}

async function _withPhase7Fallback(makeQuery, columns, legacyColumns) {
  const result = await makeQuery(columns)
  if (_isPhase7ColumnError(result.error) || _isMissingObservationColumnError(result.error, DETAIL_AI_SELECTION_FIELDS)) {
    return makeQuery(legacyColumns)
  }
  return result
}

export async function loadDetailObservation(obsId, options = {}) {
  const client = options.client || supabase
  const detailSelect = options.detailSelect || DETAIL_SELECT
  const detailLegacySelect = options.detailLegacySelect || DETAIL_SELECT_LEGACY
  const detailViewSelect = options.detailViewSelect || DETAIL_VIEW_SELECT
  const detailViewLegacySelect = options.detailViewLegacySelect || DETAIL_VIEW_SELECT_LEGACY

  const loadObservation = (table, selectColumns, legacyColumns) => _withPhase7Fallback(
    columns => client
      .from(table)
      .select(columns)
      .eq('id', obsId)
      .maybeSingle(),
    selectColumns,
    legacyColumns,
  )

  try {
    const baseRes = await loadObservation('observations', detailSelect, detailLegacySelect)
    if (baseRes.data) {
      return {
        observation: baseRes.data,
        source: 'observations',
        error: baseRes.error || null,
      }
    }

    const communityRes = await loadObservation('observations_community_view', detailViewSelect, detailViewLegacySelect)
    if (communityRes.data) {
      return {
        observation: communityRes.data,
        source: 'observations_community_view',
        error: baseRes.error || communityRes.error || null,
      }
    }

    return {
      observation: null,
      source: null,
      error: communityRes.error || baseRes.error || null,
    }
  } catch (error) {
    return {
      observation: null,
      source: null,
      error,
    }
  }
}

async function _loadDetailObservationImages(obsId) {
  const rows = await fetchObservationImageRows([obsId], {
    selectFields: DETAIL_IMAGE_SELECT_WITH_CUSTOM,
  })
  if (rows.length) return _normalizeDetailImageRows(rows)

  const withoutCustomRows = await fetchObservationImageRows([obsId], {
    selectFields: DETAIL_IMAGE_SELECT_WITHOUT_CUSTOM,
  })
  if (withoutCustomRows.length) {
    return _normalizeDetailImageRows(withoutCustomRows).map(row => ({
      ...row,
      ai_crop_is_custom: false,
    }))
  }

  const baseRows = await fetchObservationImageRows([obsId], {
    selectFields: DETAIL_IMAGE_SELECT_BASE,
  })
  if (baseRows.length) {
    return _normalizeDetailImageRows(baseRows).map(row => ({
      ...row,
      image_type: 'field',
      ai_crop_x1: null,
      ai_crop_y1: null,
      ai_crop_x2: null,
      ai_crop_y2: null,
      ai_crop_source_w: null,
      ai_crop_source_h: null,
      ai_crop_is_custom: false,
    }))
  }

  return []
}

function _buildDetailAiSelectionPatch(selectionState = {}) {
  const selectedPrediction = selectionState.selectedPrediction || null
  const selectedService = normalizeIdentifyService(
    selectionState.selectedService || selectedPrediction?.service || '',
  )

  if (!selectedPrediction || !selectedService) return null

  const [genus, species] = splitScientificName(selectedPrediction?.scientificName || '')
  const commonName = selectedPrediction?.vernacularName || null
  const redListCategory = getPredictionRedlistCategory(selectedPrediction) || null
  const redListCategoriesMap = getPredictionRedlistCategoriesMap(selectedPrediction)

  return {
    ai_selected_service: selectedService,
    ai_selected_taxon_id: selectedPrediction?.taxonId || null,
    ai_selected_scientific_name: selectedPrediction?.scientificName || null,
    ai_selected_probability: _detailAiPredictionProbability(selectedPrediction),
    ai_selected_at: new Date().toISOString(),
    genus,
    species,
    common_name: commonName,
    red_list_category: redListCategory,
    red_list_categories_json: redListCategoriesMap,
  }
}

async function _persistDetailAiSelection(selectionState = {}) {
  if (!currentObs?.id || !state.user?.id || !currentObsIsOwner) return null

  const patch = _buildDetailAiSelectionPatch(selectionState)
  if (!patch) return null

  let updatePatch = { ...patch }
  let { error } = await supabase
    .from('observations')
    .update(updatePatch)
    .eq('id', currentObs.id)
    .eq('user_id', state.user.id)

  if (error) {
    const redlistFallback = _removeMissingObservationColumnsFromPatch(updatePatch, error, DETAIL_AI_SELECTION_REDLIST_FIELDS)
    if (redlistFallback.removed) {
      updatePatch = redlistFallback.patch
      if (!Object.keys(updatePatch).length) return null
      ;({ error } = await supabase
        .from('observations')
        .update(updatePatch)
        .eq('id', currentObs.id)
        .eq('user_id', state.user.id))
    }
  }

  if (error) {
    const aiFallback = _removeMissingObservationColumnsFromPatch(updatePatch, error, DETAIL_AI_SELECTION_FIELDS)
    if (aiFallback.removed) {
      updatePatch = aiFallback.patch
      if (!Object.keys(updatePatch).length) return null
      ;({ error } = await supabase
        .from('observations')
        .update(updatePatch)
        .eq('id', currentObs.id)
        .eq('user_id', state.user.id))
    }
  }

  if (error) throw error

  currentObs = {
    ...currentObs,
    ...updatePatch,
  }
  _renderDetailAiTabs()
  _renderDetailAiResults()
  return updatePatch
}

async function _persistDetailImageCrops() {
  if (!detailImageCropDirty) return null
  if (!currentObs?.id || !state.user?.id || !currentObsIsOwner) return null

  const settled = await Promise.allSettled(detailImageRows.map(async row => {
    if (!row?.id) return
    await updateObservationImageCrop(row.id, {
      aiCropRect: normalizeAiCropRect({
        x1: row.ai_crop_x1,
        y1: row.ai_crop_y1,
        x2: row.ai_crop_x2,
        y2: row.ai_crop_y2,
      }),
      aiCropSourceW: row.ai_crop_source_w ?? null,
      aiCropSourceH: row.ai_crop_source_h ?? null,
      aiCropIsCustom: row.ai_crop_is_custom === true,
    })
  }))
  const rejected = settled.find(item => item.status === 'rejected')
  if (rejected) {
    console.warn('Failed to persist detail image crops:', rejected.reason)
    return rejected.reason
  }
  detailImageCropDirty = false
  return null
}

export function initFindDetail() {
  const backBtn = document.getElementById('detail-back')
  backBtn.addEventListener('click', _goBack)
  document.getElementById('detail-cancel-btn').addEventListener('click', _goBack)
  document.getElementById('detail-save-btn').addEventListener('click', _save)
  document.getElementById('detail-delete-btn').addEventListener('click', _delete)

  const input    = document.getElementById('detail-taxon-input')
  const dropdown = document.getElementById('detail-taxon-dropdown')
  let debounce

  input.addEventListener('input', () => {
    selectedTaxon = null
    _setDetailHeader({
      fallbackName: input.value.trim() || t('detail.unknownSpecies'),
      uncertain: document.getElementById('detail-uncertain')?.checked,
    })
    clearTimeout(debounce)
    debounce = setTimeout(() => _searchTaxon(input.value.trim(), dropdown), 280)
  })
  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none' }, 200)
  })

  const locationInput = document.getElementById('detail-location')
  if (locationInput) {
    locationInput.addEventListener('focus', () => _renderDetailLocationDropdown(true))
    locationInput.addEventListener('click', () => _renderDetailLocationDropdown(true))
    locationInput.addEventListener('input', () => {
      _renderDetailLocationDropdown(document.activeElement === locationInput)
    })
    locationInput.addEventListener('blur', () => {
      setTimeout(() => _renderDetailLocationDropdown(false), 160)
    })
  }

  const runBtn = document.querySelector('[data-identify-run-button]')
  if (runBtn) {
    wireIdentifyRunButtonPressFeedback(runBtn)
    runBtn.addEventListener('click', () => _runDetailAiComparison())
  }
  document.querySelectorAll('[data-identify-service-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const service = normalizeIdentifyService(tab.dataset.identifyServiceTab)
      const serviceState = detailAiState.resultsByService?.[service] || null
      const canView = _hasStoredAiResult(serviceState) || serviceState?.status === 'running'
      if (tab.disabled || !canView) return
      _setDetailAiActiveService(service)
    })
  })
  document.getElementById('detail-author')?.addEventListener('click', () => {
    void _openAuthorFinds()
  })
  document.getElementById('detail-friend-btn')?.addEventListener('click', _sendFriendRequestFromDetail)
  document.querySelectorAll('input[name="detail-vis"], input[name="detail-location-precision"], #detail-draft').forEach(input => {
    input.addEventListener('change', () => {
      if (input.name === 'detail-vis' && input.checked) {
        const group = input.closest('.scope-tabs')
        if (group) {
          group.querySelectorAll('.scope-tab').forEach(tab => tab.classList.remove('active'))
          input.closest('.scope-tab').classList.add('active')
        }
      }
      _renderPrivacySlotNote()
    })
  })
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.addEventListener('change', _renderPrivacySlotNote)
  document.getElementById('detail-uncertain').addEventListener('change', () => {
    if (!currentObs) return
    const value = document.getElementById('detail-taxon-input').value.trim()
    _setDetailHeader({
      commonName: selectedTaxon?.vernacularName || currentObs.common_name || '',
      genus: selectedTaxon?.genus || currentObs.genus || '',
      species: selectedTaxon?.specificEpithet || currentObs.species || '',
      fallbackName: value || t('detail.unknownSpecies'),
      uncertain: document.getElementById('detail-uncertain')?.checked,
    })
  })

  const commentInput = document.getElementById('comment-input')
  document.getElementById('comment-send-btn').addEventListener('click', _sendComment)
  commentInput.addEventListener('input', _syncDetailCommentComposer)
  commentInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') _sendComment()
  })
  _initMentions(commentInput)
  _syncDetailCommentComposer()
}

export async function openFindDetail(obsId, options = {}) {
  currentObs    = null
  selectedTaxon = null
  currentObsIsOwner = false
  returnScreenOverride = options.returnScreen || null
  hideCancelOverride = !!options.hideCancel
  detailAiState.running = false
  detailAiState.activeService = null
  detailAiState.availability = {}
  detailAiState.resultsByService = {}
  detailAiState.cachedRows = []
  detailAiState.selectedService = null
  detailAiState.selectedPrediction = null
  detailAiState.selectedPredictionByService = {}
  detailAiState.selectedProbabilityByService = {}
  detailAiState.currentFingerprint = ''
  detailAiState.requestedFingerprint = ''
  detailAiState.currentFingerprintByService = {}
  detailAiState.requestedFingerprintByService = {}
  detailAiState.localInputsChanged = false
  detailAiState.stale = false
  detailImageCropDirty = false
  detailLocationLookup = null

  // Update back button label — state.currentScreen is still the previous screen at this point
  const prevLabel = {
    home: t('detail.backHome'),
    finds: t('detail.backFinds'),
    map: t('detail.backMap'),
  }[returnScreenOverride || state.currentScreen] || t('detail.backGeneric')
  const backLabel = document.getElementById('detail-back-label')
  if (backLabel) backLabel.textContent = prevLabel

  _resetForm()
  _clearDetailUnavailableState()
  const cancelBtn = document.getElementById('detail-cancel-btn')
  if (cancelBtn) cancelBtn.style.display = hideCancelOverride ? 'none' : ''
  navigate('find-detail')

  const { observation: obs, error } = await loadDetailObservation(obsId, {
    client: supabase,
  })

  if (!obs) {
    if (error) {
      console.warn('Failed to load observation detail:', {
        observationId: obsId,
        error: {
          code: error?.code || null,
          message: error?.message || '',
          details: error?.details || '',
          hint: error?.hint || '',
        },
      })
    }
    showToast(t('detail.couldNotLoadObservation'))
    _renderDetailUnavailableState()
    return
  }

  currentObs = obs
  currentObsIsOwner = obs.user_id === state.user?.id
  await _loadDetailAuthorAndSocial()
  _applyOwnershipMode(currentObsIsOwner)
  _renderDetailAuthorAndSocial()

  const displayName = formatDisplayName(obs.genus || '', obs.species || '', obs.common_name)
  _setDetailHeader({
    commonName: obs.common_name || '',
    genus: obs.genus || '',
    species: obs.species || '',
    fallbackName: displayName.trim() || t('detail.unknownSpecies'),
    uncertain: !!obs.uncertain,
  })
  document.getElementById('detail-taxon-input').value = displayName.trim()

  document.getElementById('detail-location').value = obs.location || ''
  _startDetailLocationLookup(obs)

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

  const coordsEl = document.getElementById('detail-coords');
  if (coordsEl) {
    coordsEl.innerHTML = buildGpsMetaHtml({
      lat: obs.gps_latitude,
      lon: obs.gps_longitude,
      altitude: obs.gps_altitude,
      accuracy: obs.gps_accuracy,
    })
    coordsEl.style.display = obs.gps_latitude ? 'block' : 'none'
  }

  // Set visibility radio
  const vis = normalizeVisibility(obs.visibility, 'public')
  const visRadio = document.querySelector(`input[name="detail-vis"][value="${vis}"]`)
  if (visRadio) {
    visRadio.checked = true
    document.querySelectorAll('input[name="detail-vis"]').forEach(r => {
      r.closest('.scope-tab').classList.toggle('active', r.checked)
    })
  }
  const draftInput = document.getElementById('detail-draft')
  if (draftInput) draftInput.checked = obs.is_draft !== false
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.checked = obs.location_precision === 'fuzzed'
  detailPrivacySlotCount = null
  _renderPrivacySlotNote()
  _loadPrivacySlotCount()

  const imgData = await _loadDetailObservationImages(obsId)

  const gallery = document.getElementById('detail-gallery')
  _clearDetailThumbCropObserver()
  gallery.innerHTML = ''
  detailImageRows = []
  detailImageSources = []
  detailAiSources = []
  detailAuthorProfile = null
  detailFriendship = null
  detailFollowState = { user: false, observation: false, taxon: false, genus: false }

  let topRow = document.getElementById('detail-top-row');
  let introEl = document.querySelector('.detail-intro');
  if (!topRow && introEl) {
    topRow = document.createElement('div');
    topRow.id = 'detail-top-row';
    topRow.className = 'detail-top-row';
    introEl.parentNode.insertBefore(topRow, introEl);
  }

  let actionBar = document.getElementById('detail-action-bar');
  if (!actionBar) {
    actionBar = document.createElement('div');
    actionBar.id = 'detail-action-bar';
    actionBar.className = 'detail-action-bar';
    const gallery = document.getElementById('detail-gallery');
    if (gallery && gallery.parentNode) {
      gallery.parentNode.insertBefore(actionBar, gallery);
    }
  }

  let bannerEl = document.getElementById('detail-status-banner');
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.id = 'detail-status-banner';
  }
  if (bannerEl.parentNode) {
    bannerEl.parentNode.removeChild(bannerEl);
  }

  bannerEl.innerHTML = '';
  let showBanner = false;

  if (obs.is_draft) {
    const draftStack = document.createElement('div')
    draftStack.className = 'detail-draft-stack'

    const tag = document.createElement('span')
    tag.className = 'detail-status-tag tag-draft'
    tag.textContent = t('detail.draft') || 'Draft'
    draftStack.appendChild(tag)

    const draftCopy = document.createElement('div')
    draftCopy.className = 'detail-draft-copy'
    const ageState = classifyDraftAge(obs)
    const detailLines = getDetailDraftExplanationLines(obs)
    detailLines.forEach((line, index) => {
      const lineEl = document.createElement('span')
      lineEl.textContent = line
      lineEl.className = 'detail-draft-copy-line'
      if (index === 2 && ageState === 'old') {
        lineEl.classList.add('detail-draft-copy-line--old')
      } else if (index === 2 && ageState === 'stale') {
        lineEl.classList.add('detail-draft-copy-line--stale')
      }
      draftCopy.appendChild(lineEl)
    })

    draftStack.appendChild(draftCopy)
    bannerEl.appendChild(draftStack)
    showBanner = true
  }
  if (obs.location_precision === 'fuzzed') {
    const tag = document.createElement('span');
    tag.className = 'detail-status-tag tag-obscured';
    tag.textContent = t('locationPrecision.fuzzed') || 'Obscured';
    bannerEl.appendChild(tag);
    showBanner = true;
  }
  if (normalizeVisibility(obs.visibility, 'public') === 'private') {
    const tag = document.createElement('span');
    tag.className = 'detail-status-tag tag-private';
    tag.textContent = t('visibility.private') || 'Private';
    bannerEl.appendChild(tag);
    showBanner = true;
  }

  bannerEl.style.display = showBanner ? 'flex' : 'none';
  if (topRow && bannerEl.parentNode !== topRow) {
    topRow.appendChild(bannerEl);
  }

  if (imgData?.length) {
    const originalSources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'original' })
    const displaySources = await resolveMediaSources(imgData.map(i => i.storage_path), { variant: 'medium' })
    const aiSources = displaySources
    detailImageRows = [...imgData]
    detailImageSources = [...originalSources]
    detailAiSources = [...aiSources]

    displaySources.forEach((source, index) => {
      _appendDetailGalleryImage(imgData[index], source, aiSources[index] || null, {
        index,
        originalSource: originalSources[index] || null,
      })
    })
  }

  if (currentObsIsOwner) {
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
    addCardContainer.querySelector('.gallery-add-btn-cam').addEventListener('click', () => _openCameraForDetail())
    addCardContainer.querySelector('.gallery-add-btn-file').addEventListener('click', () => _openPickerForDetail())
  }

  await _loadDetailAiCache()

  // Load comments async (don't await)
  _loadComments(obsId)
}

function _mediaSourceUrl(source) {
  return source?.primaryUrl || source?.fallbackUrl || ''
}

function _appendDetailGalleryImage(row, source, aiSource, options = {}) {
  const originalSource = options.originalSource || source
  const displayUrl = _mediaSourceUrl(source) || _mediaSourceUrl(originalSource)
  if (!row || !displayUrl) return null
  const gallery = document.getElementById('detail-gallery')
  if (!gallery) return null

  const index = Number.isInteger(options.index) ? options.index : detailImageRows.length
  const isMicroscope = (row?.image_type || 'field') === 'microscope'
  const container = document.createElement('div')
  container.className = 'detail-gallery-item-wrap'
  container.dataset.imageId = row.id || ''

  const img = document.createElement('img')
  img.className = 'detail-gallery-img'
  img.src = displayUrl
  img.loading = 'lazy'
  img.alt = ''
  img.dataset.storagePath = row.storage_path || ''
  img.dataset.fullSrc = _mediaSourceUrl(originalSource) || displayUrl
  img.dataset.aiSrc = _mediaSourceUrl(aiSource) || displayUrl
  img.dataset.aiFallback = _mediaSourceUrl(originalSource) || _mediaSourceUrl(source) || displayUrl
  img.dataset.aiCropX1 = row.ai_crop_x1 ?? ''
  img.dataset.aiCropY1 = row.ai_crop_y1 ?? ''
  img.dataset.aiCropX2 = row.ai_crop_x2 ?? ''
  img.dataset.aiCropY2 = row.ai_crop_y2 ?? ''
  img.dataset.aiCropSourceW = row.ai_crop_source_w ?? ''
  img.dataset.aiCropSourceH = row.ai_crop_source_h ?? ''
  img.dataset.aiCropIsCustom = row.ai_crop_is_custom === true ? 'true' : ''
  const fallbackSources = [...new Set([
    source.fallbackUrl,
  ].filter(url => url && url !== source.primaryUrl))]
  if (fallbackSources.length) {
    const onError = () => {
      const nextUrl = fallbackSources.shift()
      if (!nextUrl) return
      img.dataset.fallbackApplied = 'true'
      img.src = nextUrl
      if (!fallbackSources.length) {
        img.removeEventListener('error', onError)
      }
    }
    img.addEventListener('error', onError)
  }

  img.style.cursor = 'pointer'
  img.addEventListener('click', () => {
    const galleryImgs = Array.from(gallery.querySelectorAll('.detail-gallery-img'))
    const currentIndex = galleryImgs.indexOf(img)
    const stem = _buildShareFilenameStem(currentObs)
    openPhotoViewer(galleryImgs.map((i, idx) => ({
      src: i.dataset.fullSrc || i.src,
      fallbackSrc: i.src,
      storagePath: i.dataset.storagePath || '',
      filenameStem: galleryImgs.length > 1 ? `${stem}-${idx + 1}` : stem,
    })), Math.max(0, currentIndex))
  })
  container.appendChild(img)
  _syncDetailThumbCropOverlay(container, row)

  if (currentObsIsOwner) {
    if (!isMicroscope) {
      const cropBtn = document.createElement('button')
      cropBtn.className = 'detail-overlay-btn detail-overlay-crop'
      cropBtn.textContent = 'AI crop'
      cropBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const startIndex = detailImageRows.findIndex(r => String(r.id) === String(row.id))
        const originalCropMetaById = _detailAiCropMetaMap()
        openAiCropEditor({
          title: t('crop.editorTitle'),
          startIndex: Math.max(0, startIndex),
          images: detailImageRows.map((r, i) => ({
            url: _mediaSourceUrl(detailImageSources[i]) || _mediaSourceUrl(detailAiSources[i]) || '',
            aiCropRect: normalizeAiCropRect({
              x1: r.ai_crop_x1, y1: r.ai_crop_y1,
              x2: r.ai_crop_x2, y2: r.ai_crop_y2,
            }),
            aiCropSourceW: r.ai_crop_source_w ?? null,
            aiCropSourceH: r.ai_crop_source_h ?? null,
            aiCropIsCustom: r.ai_crop_is_custom === true,
          })),
          onChange: (idx, meta) => {
            const r = detailImageRows[idx]
            if (!r) return
            const nextMeta = _detailAiCropMetaFromEdit(meta)
            const currentMeta = _detailAiCropMetaFromRow(r)
            if (_detailAiCropMetaEquals(currentMeta, nextMeta)) return

            r.ai_crop_x1 = nextMeta.aiCropRect?.x1 ?? null
            r.ai_crop_y1 = nextMeta.aiCropRect?.y1 ?? null
            r.ai_crop_x2 = nextMeta.aiCropRect?.x2 ?? null
            r.ai_crop_y2 = nextMeta.aiCropRect?.y2 ?? null
            r.ai_crop_source_w = nextMeta.aiCropSourceW ?? null
            r.ai_crop_source_h = nextMeta.aiCropSourceH ?? null
            r.ai_crop_is_custom = nextMeta.aiCropIsCustom === true
            detailImageCropDirty = _detailAiCropMetaMapChanged(originalCropMetaById)
            const item = _findDetailGalleryItemByImageId(r.id)
            if (item) {
              const img = item.querySelector('.detail-gallery-img')
              if (img) {
                img.dataset.aiCropX1 = r.ai_crop_x1 ?? ''
                img.dataset.aiCropY1 = r.ai_crop_y1 ?? ''
                img.dataset.aiCropX2 = r.ai_crop_x2 ?? ''
                img.dataset.aiCropY2 = r.ai_crop_y2 ?? ''
                img.dataset.aiCropSourceW = r.ai_crop_source_w ?? ''
                img.dataset.aiCropSourceH = r.ai_crop_source_h ?? ''
                img.dataset.aiCropIsCustom = r.ai_crop_is_custom === true ? 'true' : ''
              }
              _syncDetailThumbCropOverlay(item, r)
            }
          },
          onClose: async committed => {
            if (!committed) return
            if (!_detailAiCropMetaMapChanged(originalCropMetaById)) {
              detailImageCropDirty = false
              return
            }
            const aiCropChanged = _detailAiCropInputMapChanged(originalCropMetaById)
            if (aiCropChanged) {
              _markDetailAiStale()
            }
            const cropError = await _persistDetailImageCrops()
            if (cropError) {
              showToast(t('detail.saveFailed', { message: String(cropError?.message || cropError || 'Unknown error') }))
              return
            }
          },
        })
      })
      container.appendChild(cropBtn)
    }

    const delBtn = document.createElement('button')
    delBtn.className = 'detail-overlay-btn detail-overlay-delete'
    delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>'
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(t('detail.confirmDeleteImage') || 'Delete this image?')) return

      delBtn.disabled = true
      try {
        await supabase
          .from('observation_images')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', row.id)
        const rowIndex = detailImageRows.findIndex(r => String(r.id) === String(row.id))
        if (rowIndex >= 0) {
          detailImageRows.splice(rowIndex, 1)
          detailImageSources.splice(rowIndex, 1)
          detailAiSources.splice(rowIndex, 1)
        }

        const { data: remaining } = await supabase
          .from('observation_images')
          .select('storage_path')
          .eq('observation_id', currentObs.id)
          .is('deleted_at', null)
          .order('sort_order', { ascending: true })
          .limit(1)
        if (remaining && remaining.length > 0) {
          await syncObservationMediaKeys(currentObs.id, remaining[0].storage_path, { sortOrder: 0 })
        } else {
          await supabase.from('observations').update({ image_key: null, thumb_key: null }).eq('id', currentObs.id)
        }
        container.remove()
        _markDetailAiStale()
      } catch (err) {
        console.error('Failed to delete image:', err)
        showToast(err.message)
        delBtn.disabled = false
      }
    })
    container.appendChild(delBtn)
  }

  const addCard = gallery.querySelector('.gallery-add-placeholder')?.closest('.detail-gallery-item-wrap')
  if (addCard && !options.appendAfterAddCard) gallery.insertBefore(container, addCard)
  else gallery.appendChild(container)

  if (!options.skipStateInsert && !detailImageRows.some(r => String(r.id) === String(row.id))) {
    detailImageRows.splice(index, 0, row)
    detailImageSources.splice(index, 0, originalSource)
    detailAiSources.splice(index, 0, aiSource)
  }
  return container
}

function _storagePathExtension(storagePath) {
  const value = String(storagePath || '').trim()
  const name = value.split('/').pop() || value
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
}

const detailImageReadWarnings = new Set()

function _isFetchableDetailImageUrl(url) {
  const text = String(url || '').trim()
  if (!text) return false
  if (text.startsWith('blob:') || text.startsWith('data:')) return true

  try {
    const parsed = new URL(text, globalThis.location?.href || 'https://example.invalid')
    if (globalThis.location?.origin && parsed.origin === globalThis.location.origin) return true
    return parsed.pathname.includes('/storage/v1/object/sign/')
  } catch (_) {
    return false
  }
}

function _detailIdentifyFallbackUrls(img) {
  return [
    img?.dataset?.aiFallback || '',
    img?.dataset?.aiSrc || '',
    img?.dataset?.fullSrc || '',
    img?.src || '',
  ].filter(_isFetchableDetailImageUrl)
}

function _warnDetailImageReadFailure(details = {}) {
  const key = [
    details.observationId || '',
    details.storagePath || '',
  ].join('|')
  if (detailImageReadWarnings.has(key)) return
  detailImageReadWarnings.add(key)
  console.warn('Detail image read failed:', details)
}

function _isDetailAiDebugFlagEnabled(flag) {
  try {
    return globalThis.localStorage?.getItem(flag) === 'true'
  } catch (_) {
    return false
  }
}

function _isDetailAiCacheBypassEnabled() {
  return _isDetailAiDebugFlagEnabled('sporely-debug-ai-bypass-cache')
}

function _isDetailAiNoSaveEnabled() {
  return _isDetailAiDebugFlagEnabled('sporely-debug-ai-no-save')
}

function _detailIdentifyGps(obs = currentObs) {
  const lat = Number(obs?.gps_latitude)
  const lon = Number(obs?.gps_longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001) return null
  return { lat, lon }
}

function _detailIdentifyObservedOn(obs = currentObs) {
  if (obs?.date) return String(obs.date).trim() || null
  const capturedAt = obs?.captured_at ? new Date(obs.captured_at) : null
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) return null
  return `${capturedAt.getFullYear()}-${String(capturedAt.getMonth() + 1).padStart(2, '0')}-${String(capturedAt.getDate()).padStart(2, '0')}`
}

function _readDetailAiCropMeta(source = {}, index = null) {
  const readNumber = value => {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  const dataset = source?.dataset || {}
  const row = Number.isInteger(index) ? detailImageRows[index] : null
  const rowCropRect = row ? normalizeAiCropRect({
    x1: row.ai_crop_x1,
    y1: row.ai_crop_y1,
    x2: row.ai_crop_x2,
    y2: row.ai_crop_y2,
  }) : null
  const datasetCropRect = normalizeAiCropRect({
    x1: source?.aiCropRect?.x1 ?? source?.cropRect?.x1 ?? dataset.aiCropX1,
    y1: source?.aiCropRect?.y1 ?? source?.cropRect?.y1 ?? dataset.aiCropY1,
    x2: source?.aiCropRect?.x2 ?? source?.cropRect?.x2 ?? dataset.aiCropX2,
    y2: source?.aiCropRect?.y2 ?? source?.cropRect?.y2 ?? dataset.aiCropY2,
  })
  return {
    cropRect: rowCropRect || datasetCropRect,
    cropSourceW: readNumber(row?.ai_crop_source_w ?? source?.aiCropSourceW ?? source?.cropSourceW ?? dataset.aiCropSourceW),
    cropSourceH: readNumber(row?.ai_crop_source_h ?? source?.aiCropSourceH ?? source?.cropSourceH ?? dataset.aiCropSourceH),
    cropIsCustom: row?.ai_crop_is_custom === true
      || source?.aiCropIsCustom === true
      || dataset.aiCropIsCustom === 'true',
  }
}

async function _loadDetailIdentifyBlob(img, variant = 'medium') {
  const storagePath = img?.dataset?.storagePath || ''
  const fallbackUrls = _detailIdentifyFallbackUrls(img)
  const viewerMode = currentObs?.user_id === state.user?.id ? 'owner' : 'viewer'

  let lastError = null
  try {
    if (storagePath) {
      const blob = await downloadObservationImageBlob(storagePath, {
        variant,
        allowWorkerDownload: viewerMode === 'owner',
      })
      if (isBlob(blob)) {
        return {
          blob,
          usedFallbackUrl: false,
          sourceMode: 'blob',
          storagePathExtension: _storagePathExtension(storagePath),
          requestedVariant: variant,
        }
      }
      throw new Error('Image download returned invalid data')
    }
  } catch (storageError) {
    lastError = storageError
  }

  for (const url of [...new Set(fallbackUrls)]) {
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`Image fetch failed: ${resp.status}`)
      const contentType = String(resp.headers.get('content-type') || '').trim().toLowerCase()
      if (contentType && !contentType.startsWith('image/')) {
        throw new Error(`Non-image response (${contentType})`)
      }
      const blob = await resp.blob()
      if (!isBlob(blob)) throw new Error('Image fetch returned invalid data')
      return {
        blob,
        usedFallbackUrl: true,
        sourceMode: 'fallback-url',
        storagePathExtension: _storagePathExtension(storagePath),
        requestedVariant: variant,
      }
    } catch (error) {
      lastError = error
    }
  }

  _warnDetailImageReadFailure({
    observationId: currentObs?.id || null,
    storagePath,
    variant,
    viewerMode,
    sourceType: fallbackUrls.length ? 'fallback-url' : 'storage',
    fallbackUrlCount: fallbackUrls.length,
    error: {
      code: lastError?.code || null,
      message: lastError?.message || '',
      details: lastError?.details || '',
      hint: lastError?.hint || '',
    },
  })
  throw new Error(`Could not read this image for identification${lastError?.message ? `: ${lastError.message}` : ''}`)
}

function _isArtsorakelBlobFallbackError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('artsdata ai 500')
    || (message.includes('artsdata ai') && message.includes('500'))
    || (message.includes('endpoint') && message.includes('status=500'))
    || (message.includes('status 500') && message.includes('artsorakel'))
}

function getDetailIdentifySources() {
  const galleryImgs = Array.from(document.querySelectorAll('#detail-gallery img'))
  const hasStoredSources = detailImageRows.length > 0 || detailImageSources.length > 0 || detailAiSources.length > 0
  if (galleryImgs.length || !hasStoredSources) {
    return { galleryImgs, hasStoredSources }
  }

  const pseudoImgs = detailImageRows.map((row, index) => {
    const originalSource = detailImageSources[index] || null
    const aiSource = detailAiSources[index] || null
    return {
      dataset: {
        storagePath: row.storage_path || '',
        aiFallback: originalSource?.fallbackUrl || originalSource?.primaryUrl || '',
        aiSrc: aiSource?.primaryUrl || '',
        fullSrc: originalSource?.primaryUrl || '',
        aiCropX1: row.ai_crop_x1 ?? '',
        aiCropY1: row.ai_crop_y1 ?? '',
        aiCropX2: row.ai_crop_x2 ?? '',
        aiCropY2: row.ai_crop_y2 ?? '',
        aiCropSourceW: row.ai_crop_source_w ?? '',
        aiCropSourceH: row.ai_crop_source_h ?? '',
        aiCropIsCustom: row.ai_crop_is_custom === true ? 'true' : '',
      },
      src: aiSource?.primaryUrl || originalSource?.primaryUrl || '',
      aiCropRect: normalizeAiCropRect({
        x1: row.ai_crop_x1,
        y1: row.ai_crop_y1,
        x2: row.ai_crop_x2,
        y2: row.ai_crop_y2,
      }),
      aiCropSourceW: row.ai_crop_source_w ?? null,
      aiCropSourceH: row.ai_crop_source_h ?? null,
      aiCropIsCustom: row.ai_crop_is_custom === true,
    }
  })

  return {
    galleryImgs: pseudoImgs,
    hasStoredSources,
  }
}

export async function prepareDetailIdentifyInputs(galleryImgs, variant = 'original') {
  const options = typeof variant === 'string'
    ? { variant }
    : (variant || {})
  const chosenVariant = options.variant || 'original'
  const maxEdge = Math.max(1, Number(options.maxEdge || getArtsorakelMaxEdge()) || getArtsorakelMaxEdge())

  return await Promise.all((galleryImgs || []).map(async (img, index) => {
    try {
      const result = await _loadDetailIdentifyBlob(img, chosenVariant)
      if (!isBlob(result.blob)) return null
      const cropMeta = _readDetailAiCropMeta(img, index)
      const gps = _detailIdentifyGps()
      const prepared = await prepareImageBlobForUpload(result.blob, {
        cropRect: cropMeta.cropRect,
        maxEdge,
        forceJpeg: true,
      })
      const finalDebugWidth = prepared.targetWidth ?? prepared.sourceWidth ?? null
      const finalDebugHeight = prepared.targetHeight ?? prepared.sourceHeight ?? null
      return {
        ...result,
        blob: prepared.blob,
        originalBlob: result.blob,
        sourceBlob: result.blob,
        debugPreviewUrl: String(
          img?.dataset?.aiSrc
          || img?.dataset?.fullSrc
          || img?.src
          || '',
        ).trim(),
        cropRect: cropMeta.cropRect,
        cropSourceW: cropMeta.cropSourceW,
        cropSourceH: cropMeta.cropSourceH,
        lat: gps?.lat ?? null,
        lon: gps?.lon ?? null,
        observedOn: _detailIdentifyObservedOn(),
        wasCropped: !!cropMeta.cropRect,
        preparedMeta: prepared,
        preprocessed: true,
        debug: {
          blobType: prepared.outputType || prepared.blob?.type || '',
          blobSize: prepared.outputSize || prepared.blob?.size || 0,
          width: finalDebugWidth,
          height: finalDebugHeight,
          sourceWidth: prepared.sourceWidth ?? null,
          sourceHeight: prepared.sourceHeight ?? null,
        },
      }
    } catch (error) {
      return {
        blob: null,
        error,
        usedFallbackUrl: false,
        sourceMode: 'failed',
        storagePathExtension: _storagePathExtension(img?.dataset?.storagePath || ''),
        requestedVariant: chosenVariant,
        debug: { blobType: '', blobSize: 0, width: null, height: null },
      }
    }
  }))
}

export async function runDetailIdentify(service, galleryImgs, options = {}) {
  const normalizedService = normalizeIdentifyService(service)
  const identifyInputs = Array.isArray(options.identifyInputs)
    && normalizedService !== ID_SERVICE_ARTSORAKEL
    ? options.identifyInputs
    : await prepareDetailIdentifyInputs(galleryImgs, {
        variant: normalizedService === ID_SERVICE_ARTSORAKEL
          ? 'original'
          : (options.variant || 'original'),
        maxEdge: options.maxEdge || getArtsorakelMaxEdge(),
      })
  const blobs = identifyInputs
    .filter(item => isBlob(item?.blob))
  const mediaKeys = (galleryImgs || [])
    .map(img => img?.dataset?.storagePath || '')
    .filter(Boolean)

  const language = options.language || getTaxonomyLanguage()
  const identifyBlobs = options.identifyBlobs || runIdentifyForBlobs
  const identifyMediaKeys = options.identifyMediaKeys || runIdentifyForMediaKeys

  if (blobs.length) {
    try {
      const detailGps = _detailIdentifyGps()
      const identifyOptions = service === ID_SERVICE_ARTSORAKEL
        ? { tolerateFailures: true, maxEdge: getArtsorakelMaxEdge(), screen: 'detail' }
        : {
            tolerateFailures: true,
            screen: 'detail',
            lat: detailGps?.lat ?? null,
            lon: detailGps?.lon ?? null,
            observedOn: _detailIdentifyObservedOn(),
          }
      return await identifyBlobs(identifyInputs, service, language, identifyOptions)
    } catch (error) {
      if (service === ID_SERVICE_ARTSORAKEL && mediaKeys.length && _isArtsorakelBlobFallbackError(error)) {
        return identifyMediaKeys(mediaKeys, service, language, { variant: options.variant || 'original', screen: 'detail' })
      }
      throw error
    }
  }

  if (mediaKeys.length && service === ID_SERVICE_ARTSORAKEL) {
    return identifyMediaKeys(mediaKeys, service, language, { variant: options.variant || 'original', screen: 'detail' })
  }

  if (service === ID_SERVICE_ARTSORAKEL) {
    throw new Error('Could not load observation images for Artsorakel')
  }
  throw new Error('Could not load observation images for iNaturalist')
}

function _detailImageFingerprint(service = ID_SERVICE_ARTSORAKEL) {
  return buildIdentifyFingerprint({
    service,
    observationId: currentObs?.id || null,
    language: getTaxonomyLanguage(),
    preprocessVersion: 2,
    images: detailImageRows.map((row, index) => ({
      id: row.id || `detail-${index}`,
      mediaKey: row.storage_path || null,
      cropRect: normalizeAiCropRect({
        x1: row.ai_crop_x1,
        y1: row.ai_crop_y1,
        x2: row.ai_crop_x2,
        y2: row.ai_crop_y2,
      }),
      cropSourceW: row.ai_crop_source_w ?? null,
      cropSourceH: row.ai_crop_source_h ?? null,
      sourceType: 'media',
    })),
  })
}

function _detailAiTabState(service) {
  const result = detailAiState.resultsByService[service] || null
  const availability = detailAiState.availability?.[service] || null
  const running = !!detailAiState.runningByService?.[service]
  const canView = _canViewDetailAiResult(service, result)
  const canRun = _canRunDetailAiService(service, result)
  const selectedPrediction = detailAiState.selectedPredictionByService?.[service] || null
  const selectedProbability = detailAiState.selectedProbabilityByService?.[service]
  const topProbability = getIdentifyTopProbability(result)
  const displayProbability = _detailAiHasProbability(topProbability)
    ? Number(topProbability)
    : _detailAiHasProbability(selectedProbability)
      ? Number(selectedProbability)
      : _detailAiHasProbability(selectedPrediction?.probability)
        ? Number(selectedPrediction.probability)
        : null
  return {
    service,
    active: detailAiState.activeService === service,
    isUsedForCurrentId: detailAiState.selectedService === service,
    available: availability?.available ?? false,
    reason: availability?.reason || '',
    status: running ? 'running' : (result?.status || 'idle'),
    errorMessage: result?.errorMessage || '',
    topProbability,
    topPrediction: result?.topPrediction || null,
    selectedPrediction,
    selectedProbability,
    displayProbability,
    showCheckmark: detailAiState.selectedService === service && ['success', 'stale'].includes(result?.status || 'idle'),
    hasStored: _hasStoredAiResult(result),
    hasRunResult: _hasAiRunResult(result),
    canView,
    canRun,
    isDisabled: !canView && !canRun,
  }
}

function _detailAiSelectedRedlistPrediction() {
  const selectedService = normalizeIdentifyService(detailAiState.selectedService || detailAiState.activeService || '')
  if (!selectedService) {
    return detailAiState.selectedPrediction || null
  }
  return (
    detailAiState.selectedPredictionByService?.[selectedService]
    || detailAiState.selectedPrediction
    || null
  )
}

function _syncDetailRedlistSummary() {
  const host = document.getElementById('detail-redlist-summary')
  if (!host) return
  const html = renderIdentifyRedlistSummary(_detailAiSelectedRedlistPrediction())
  host.innerHTML = html
  host.style.display = html ? '' : 'none'
}

function _detailPhotoIdLookup() {
  return detailLocationLookup || null
}

function _resolveDetailPhotoIdServices(availability = {}, options = {}) {
  const lookup = _detailPhotoIdLookup()
  return resolvePhotoIdServices({
    mode: getPhotoIdMode(),
    countryCode: lookup?.country_code || null,
    countryName: lookup?.country_name || null,
    locale: getLocale(),
    inaturalistAvailable: availability?.[ID_SERVICE_INATURALIST]?.available ?? false,
    comparisonRequested: !!options.comparisonRequested,
  })
}

function _detailAiServiceIconHtml(state) {
  return _renderServiceIcon(state)
}

function _buildDetailAiCachedResult(row, currentFingerprint = {}) {
  if (!row) return null
  const service = normalizeIdentifyService(row.service)
  const current = _detailAiFingerprintFromValue(currentFingerprint)
  const rowFingerprint = _detailAiFingerprintText(row.request_fingerprint || row.requestFingerprint || '')
  const topProbability = getIdentifyTopProbability({
    topProbability: row.top_probability ?? null,
    topPrediction: row.results?.[0] || null,
    predictions: row.results || [],
  })
  const result = {
    service,
    status: _detailAiCachedResultStatus(row, current),
    predictions: Array.isArray(row.results) ? row.results : [],
    topPrediction: row.results?.[0] ? {
      ...row.results[0],
      confidenceText: `${Math.round(Number(topProbability ?? 0) * 100)}%`,
    } : null,
    topProbability,
    topScientificName: row.top_scientific_name || row.results?.[0]?.scientificName || null,
    topVernacularName: row.top_vernacular_name || row.results?.[0]?.vernacularName || null,
    topTaxonId: row.top_taxon_id || row.results?.[0]?.taxonId || null,
    errorMessage: row.error_message || '',
    request_fingerprint: rowFingerprint,
    image_fingerprint: _detailAiFingerprintText(row.image_fingerprint || row.imageFingerprint || ''),
    crop_fingerprint: _detailAiFingerprintText(row.crop_fingerprint || row.cropFingerprint || ''),
  }
  return result
}

function _buildDetailAiCachedResults(rows = [], currentFingerprintByService = {}) {
  const byService = {}
  for (const service of [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]) {
    const serviceRows = (Array.isArray(rows) ? rows : [])
      .filter(item => normalizeIdentifyService(item.service) === service)
    const row = _detailAiSelectCachedRowForService(serviceRows, currentFingerprintByService[service])
    const result = _buildDetailAiCachedResult(row, currentFingerprintByService[service])
    if (result) byService[service] = result
  }
  return byService
}

function _renderDetailAiTabs() {
  const photoIdServices = _resolveDetailPhotoIdServices(detailAiState.availability)
  const runBtn = document.querySelector('[data-identify-run-button]')
  if (runBtn) {
    const runDisabled = detailAiState.running || !currentObsIsOwner
    runBtn.disabled = runDisabled
    runBtn.setAttribute('aria-disabled', String(runDisabled))
    runBtn.classList.toggle('is-running', detailAiState.running)
    if (detailAiState.running) {
      runBtn.classList.remove('is-pressed')
    }
    const runLabel = runBtn.querySelector('[data-identify-run-label]')
    if (runLabel) {
      runLabel.textContent = detailAiState.running ? 'Loading...' : _tf('review.aiId', 'AI Photo ID')
    }
    if (!currentObsIsOwner) {
      const runTitle = _detailAiRunDisabledTitle()
      runBtn.title = runTitle
      runBtn.setAttribute('aria-label', runTitle)
    } else {
      runBtn.removeAttribute('title')
      runBtn.setAttribute('aria-label', _tf('review.aiId', 'AI Photo ID'))
    }
  }
  document.querySelectorAll('[data-identify-service-tab]').forEach(tab => {
    const service = normalizeIdentifyService(tab.dataset.identifyServiceTab)
    const state = _detailAiTabState(service)
    tab.classList.toggle('is-active', state.active)
    tab.classList.toggle('is-used', state.isUsedForCurrentId)
    tab.classList.toggle('is-disabled', state.isDisabled)
    tab.classList.toggle('is-running', state.status === 'running')
    tab.classList.toggle('has-results', state.status === 'success' || state.status === 'no_match' || state.status === 'stale')
    tab.classList.toggle('has-error', state.status === 'error')
    tab.disabled = state.isDisabled
    tab.setAttribute('aria-disabled', String(state.isDisabled))
    const icon = tab.querySelector('.ai-id-service-tab-icon, .ai-id-dot')
    if (icon) {
      icon.outerHTML = _detailAiServiceIconHtml(state)
    } else {
      const label = tab.querySelector('.ai-id-service-tab-label')
      const iconHtml = _detailAiServiceIconHtml(state)
      if (label) {
        label.insertAdjacentHTML('beforebegin', iconHtml)
      } else {
        tab.insertAdjacentHTML('afterbegin', iconHtml)
      }
    }
    const score = tab.querySelector('.ai-id-service-tab-score')
    if (score) {
      const probability = state.displayProbability
      score.textContent = _detailAiHasProbability(probability)
        ? `${Math.round(Number(probability) * 100)}%`
        : ''
      score.style.display = score.textContent ? '' : 'none'
    }
  })
}

function _renderDetailAiResults() {
  const resultsEl = document.getElementById('detail-ai-results')
  try {
    if (!resultsEl) return
    const activeService = normalizeIdentifyService(detailAiState.activeService)
    const result = detailAiState.resultsByService[activeService] || null
    const showLocalStaleWarning = Boolean(detailAiState.localInputsChanged || detailAiState.stale)
    resultsEl.dataset.identifyService = activeService
    const staleNote = document.querySelector('[data-identify-stale-note]')
    if (staleNote) staleNote.style.display = showLocalStaleWarning ? '' : 'none'
    if (detailAiState.runningByService?.[activeService]) {
      resultsEl.innerHTML = `<div class="ai-results-empty">${t('common.loading')}</div>`
      resultsEl.style.display = 'block'
      return
    }
    if (result?.status === 'running') {
      resultsEl.innerHTML = `<div class="ai-results-empty">${t('common.loading')}</div>`
      resultsEl.style.display = 'block'
      return
    }
    const nonOwnerEmptyMessage = _tf('detail.noStoredAiResults', 'No stored AI results are available for this observation.')
    if (!result || result?.status === 'idle') {
      const isReadOnlyViewer = Boolean(currentObs?.id) && !currentObsIsOwner
      resultsEl.innerHTML = `<div class="ai-results-empty">${isReadOnlyViewer ? nonOwnerEmptyMessage : _tf('review.runAiIdPrompt', 'Run AI Photo ID to get suggestions.')}</div>`
      resultsEl.style.display = 'block'
      return
    }
    if (!result?.predictions?.length) {
      if (showLocalStaleWarning && result?.status === 'stale') {
        resultsEl.innerHTML = `<div class="ai-results-empty">${t('review.resultsOutdated') || 'Results outdated'}</div>`
        resultsEl.style.display = 'block'
        return
      }
      if (result?.status === 'unavailable') {
        resultsEl.innerHTML = `<div class="ai-results-empty">${detailAiState.availability?.[activeService]?.reason || result.errorMessage || (t('settings.inaturalistLoginMissing') || 'Unavailable')}</div>`
        resultsEl.style.display = 'block'
        return
      }
      if (result?.status === 'error' || (result?.status === 'stale' && result.errorMessage)) {
        resultsEl.innerHTML = `<div class="ai-results-empty">${result.errorMessage || (t('common.errorPrefix', { message: t('common.unknown') }) || 'Error')}</div>`
        resultsEl.style.display = 'block'
        return
      }
      if (result?.status === 'no_match') {
        resultsEl.innerHTML = `<div class="ai-results-empty">${getIdentifyNoMatchMessage(activeService)}</div>`
        resultsEl.style.display = 'block'
        return
      }
      const emptyMessage = currentObs?.id && !currentObsIsOwner
        ? nonOwnerEmptyMessage
        : (t('review.noMatch') || 'No match')
      resultsEl.innerHTML = `<div class="ai-results-empty">${emptyMessage}</div>`
      resultsEl.style.display = 'block'
      return
    }

    resultsEl.innerHTML = renderIdentifyResultRows(activeService, result.predictions)
    resultsEl.style.display = 'block'
    const selectedPrediction = detailAiState.selectedService === activeService
      ? (detailAiState.selectedPredictionByService?.[activeService] || detailAiState.selectedPrediction || null)
      : null
    resultsEl.querySelectorAll('[data-identify-result]').forEach(el => {
      const row = el.closest?.('.ai-result-row') || el.parentElement?.closest?.('.ai-result-row') || null
      const prediction = JSON.parse(el.dataset.identifyResult)
      const isSelected = Boolean(_detailAiPredictionsEquivalent(prediction, selectedPrediction))
      el.classList.toggle('is-selected', isSelected)
      el.classList.toggle('is-readonly', Boolean(currentObs?.id) && !currentObsIsOwner)
      row?.classList.toggle('is-selected', isSelected)
      if (isSelected) {
        el.setAttribute('aria-current', 'true')
      } else {
        el.removeAttribute('aria-current')
      }
      el.addEventListener('click', () => {
        if (Boolean(currentObs?.id) && !currentObsIsOwner) return
        const clickedPrediction = JSON.parse(el.dataset.identifyResult)
        const [genus, specificEpithet] = splitScientificName(clickedPrediction.scientificName)
        selectedTaxon = {
          genus,
          specificEpithet,
          vernacularName: clickedPrediction.vernacularName || null,
          displayName: clickedPrediction.displayName,
        }
        detailAiState.selectedService = activeService
        detailAiState.selectedPrediction = clickedPrediction
        detailAiState.selectedPredictionByService = {
          ...(detailAiState.selectedPredictionByService || {}),
          [activeService]: clickedPrediction,
        }
        detailAiState.selectedProbabilityByService = {
          ...(detailAiState.selectedProbabilityByService || {}),
          [activeService]: _detailAiPredictionProbability(clickedPrediction),
        }
        document.getElementById('detail-taxon-input').value = clickedPrediction.displayName
        _setDetailHeader({
          commonName: selectedTaxon.vernacularName || '',
          genus: selectedTaxon.genus || '',
          species: selectedTaxon.specificEpithet || '',
          fallbackName: clickedPrediction.displayName || t('detail.unknownSpecies'),
          uncertain: document.getElementById('detail-uncertain')?.checked,
        })
        _renderDetailAiTabs()
        _renderDetailAiResults()
      })
    })
  } finally {
    _syncDetailRedlistSummary()
  }
}

function _applyDetailAiServiceResult(service, result = {}) {
  const normalizedService = normalizeIdentifyService(service)
  detailAiState.resultsByService = {
    ...(detailAiState.resultsByService || {}),
    [normalizedService]: {
      service: normalizedService,
      status: result.status || 'idle',
      predictions: Array.isArray(result.predictions) ? result.predictions : [],
      topPrediction: result.topPrediction || null,
      topProbability: result.topProbability ?? null,
      topScientificName: result.topScientificName || null,
      topVernacularName: result.topVernacularName || null,
      topTaxonId: result.topTaxonId || null,
      errorMessage: result.errorMessage || '',
      available: result.available ?? detailAiState.availability?.[normalizedService]?.available ?? false,
      reason: result.reason || detailAiState.availability?.[normalizedService]?.reason || '',
      request_fingerprint: result.request_fingerprint || '',
    },
  }
  _renderDetailAiTabs()
  _renderDetailAiResults()
}

function _setDetailAiActiveService(service) {
  detailAiState.activeService = normalizeIdentifyService(service)
  _renderDetailAiTabs()
  _renderDetailAiResults()
}

function _markDetailAiStale() {
  detailAiState.stale = true
  detailAiState.localInputsChanged = true
  _renderDetailAiTabs()
  _renderDetailAiResults()
}

async function _loadDetailAiCache() {
  if (!currentObs?.id) return
  const fingerprints = {
    [ID_SERVICE_ARTSORAKEL]: _detailImageFingerprint(ID_SERVICE_ARTSORAKEL),
    [ID_SERVICE_INATURALIST]: _detailImageFingerprint(ID_SERVICE_INATURALIST),
  }
  detailAiState.currentFingerprintByService = fingerprints
  detailAiState.currentFingerprint = detailAiState.currentFingerprintByService[ID_SERVICE_ARTSORAKEL]?.requestFingerprint || ''
  detailAiState.requestedFingerprintByService = { ...fingerprints }
  detailAiState.requestedFingerprint = detailAiState.currentFingerprint
  const rows = await loadObservationIdentifications(currentObs.id).catch(error => {
    console.warn('Failed to load cached AI rows:', error)
    return []
  })
  detailAiState.cachedRows = rows
  detailAiState.resultsByService = _buildDetailAiCachedResults(rows, detailAiState.currentFingerprintByService)
  const selectionState = _detailAiSelectionStateFromResults(detailAiState.resultsByService, currentObs)
  detailAiState.selectedService = selectionState.selectedService
  detailAiState.selectedPrediction = selectionState.selectedPrediction
  detailAiState.selectedPredictionByService = selectionState.selectedPredictionByService
  detailAiState.selectedProbabilityByService = selectionState.selectedProbabilityByService
  detailAiState.stale = false
  detailAiState.localInputsChanged = false

  const configuredPrimaryService = _resolveDetailPhotoIdServices({}).primary
  const firstStoredService = [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]
    .find(service => _hasStoredAiResult(detailAiState.resultsByService?.[service]))
    || null
  detailAiState.activeService = detailAiState.selectedService
    || firstStoredService
    || detailAiState.activeService
    || configuredPrimaryService

  if (import.meta.env?.DEV || _isDetailAiDebugFlagEnabled('sporely-debug-ai-id')) {
    console.debug('[detail-ai cache load]', {
      observationId: currentObs?.id,
      ownerId: currentObs?.user_id,
      viewerId: state.user?.id,
      currentObsIsOwner,
      rowCount: rows.length,
      rows: rows.map(r => ({
        service: r.service,
        status: r.status,
        top_probability: r.top_probability,
        resultCount: Array.isArray(r.results) ? r.results.length : null,
        request_fingerprint: r.request_fingerprint,
      })),
      resultsByService: Object.fromEntries(
        Object.entries(detailAiState.resultsByService || {}).map(([service, result]) => [
          service,
          {
            status: result?.status,
            topProbability: result?.topProbability,
            predictionCount: result?.predictions?.length || 0,
          },
        ]),
      ),
    })
  }

  _renderDetailAiTabs()
  _renderDetailAiResults()

  try {
    const mediaKeys = detailImageRows.map(row => row.storage_path || '').filter(Boolean)
    const hasDetailImages = detailImageRows.length > 0
    const inaturalistSession = await loadInaturalistSession()
    const availabilityList = await getAvailableIdentifyServices({
      mediaKeys,
      inaturalistSession,
    })
    const inatLoggedIn = Boolean(inaturalistSession?.connected && (inaturalistSession?.api_token || inaturalistSession?.apiToken))
    const inatReason = inatLoggedIn
      ? (hasDetailImages ? '' : _tf('detail.noPhotoToIdentify', 'No usable photo available for iNaturalist.'))
      : _tf('settings.inaturalistLoginMissing', 'Please log in to iNaturalist first.')
    detailAiState.availability = Object.fromEntries(availabilityList.map(item => [item.service, item]))
    detailAiState.availability[ID_SERVICE_INATURALIST] = {
      ...(detailAiState.availability[ID_SERVICE_INATURALIST] || {}),
      service: ID_SERVICE_INATURALIST,
      available: Boolean(inatLoggedIn && hasDetailImages),
      disabled: !Boolean(inatLoggedIn && hasDetailImages),
      reason: inatReason,
    }
  } catch (error) {
    console.warn('Failed to load detail AI availability:', error)
  }

  _renderDetailAiTabs()
  _renderDetailAiResults()
}

async function _runDetailAiComparison(serviceOverride = null) {
  if (!currentObsIsOwner) return
  const overrideService = typeof serviceOverride === 'string'
    ? normalizeIdentifyService(serviceOverride)
    : null
  const sources = getDetailIdentifySources()
  const galleryImgs = sources.galleryImgs
  if (!galleryImgs.length && !sources.hasStoredSources) {
    showToast(t('detail.noPhotoToIdentify'))
    return
  }
  if (detailAiState.running) return

  const identifyInputs = await prepareDetailIdentifyInputs(galleryImgs, { variant: 'original', maxEdge: getArtsorakelMaxEdge() })
  const usableBlobs = identifyInputs
    .filter(item => isBlob(item?.blob))
  const mediaKeys = galleryImgs
    .map(img => img?.dataset?.storagePath || '')
    .filter(Boolean)
  const hasInatBlob = usableBlobs.length > 0
  const inaturalistSession = await loadInaturalistSession()
  const availabilityList = await getAvailableIdentifyServices({
    mediaKeys,
    inaturalistSession,
  })
  const inatLoggedIn = Boolean(inaturalistSession?.connected && (inaturalistSession?.api_token || inaturalistSession?.apiToken))
  const inatReason = inatLoggedIn
    ? (hasInatBlob ? '' : (t('detail.noPhotoToIdentify') || 'No usable photo available for iNaturalist.'))
    : (t('settings.inaturalistLoginMissing') || 'Please log in to iNaturalist first.')
  const availability = Object.fromEntries(availabilityList.map(item => [item.service, item]))
  availability[ID_SERVICE_INATURALIST] = {
    ...(availability[ID_SERVICE_INATURALIST] || {}),
    service: ID_SERVICE_INATURALIST,
    available: Boolean(inatLoggedIn && hasInatBlob),
    disabled: !Boolean(inatLoggedIn && hasInatBlob),
    reason: inatReason,
  }
  const resolution = _resolveDetailPhotoIdServices(availability, {
    comparisonRequested: !overrideService,
  })
  const lookup = _detailPhotoIdLookup()
  const requestedServices = overrideService
    ? [overrideService]
    : resolution.run
  const primaryService = overrideService
    ? requestedServices[0]
    : (requestedServices[0] || resolution.primary)
  if (_isDetailAiCacheBypassEnabled()) {
    console.debug('[photo-id] bypassing cached identification')
  }
  debugPhotoId('detail comparison', {
    storedPhotoIdMode: getPhotoIdMode(),
    localStoragePhotoIdMode: globalThis.localStorage?.getItem('sporely-photo-id-mode'),
    legacyDefaultIdService: globalThis.localStorage?.getItem('sporely-default-id-service'),
    inaturalistSessionConnected: Boolean(inaturalistSession?.connected),
    inaturalistHasApiToken: Boolean(inaturalistSession?.api_token || inaturalistSession?.apiToken),
    availability,
    photoIdServices: resolution,
    resolvedServices: resolution,
    requestedServices,
    mode: resolution.mode,
    countryCode: resolution.countryCode,
    countryName: lookup?.country_name || null,
    locale: resolution.locale,
  })
  detailAiState.running = true
  detailAiState.stale = false
  detailAiState.availability = availability
  detailAiState.runningByService = Object.fromEntries(
    [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST].map(service => [
      service,
      Boolean(availability[service]?.available && requestedServices.includes(service)),
    ]),
  )
  detailAiState.resultsByService = markRequestedServicesRunning(detailAiState.resultsByService, availability, requestedServices)
  detailAiState.activeService = primaryService
  detailAiState.selectedPrediction = null
  detailAiState.selectedPredictionByService = {}

  if (!requestedServices.length) {
    const noRunReason = availability?.[primaryService]?.reason || _tf('detail.noPhotoToIdentify', 'No photo is available for identification.')
    showToast(noRunReason)
    detailAiState.running = false
    detailAiState.runningByService = {}
    _renderDetailAiTabs()
    _renderDetailAiResults()
    return
  }

  detailAiState.localInputsChanged = false
  _renderDetailAiTabs()
  _renderDetailAiResults()

  try {
    await _persistDetailImageCrops()
    const serviceFingerprints = {
      [ID_SERVICE_ARTSORAKEL]: _detailImageFingerprint(ID_SERVICE_ARTSORAKEL),
      [ID_SERVICE_INATURALIST]: _detailImageFingerprint(ID_SERVICE_INATURALIST),
    }
    detailAiState.currentFingerprintByService = serviceFingerprints
    detailAiState.currentFingerprint = detailAiState.currentFingerprintByService[ID_SERVICE_ARTSORAKEL]?.requestFingerprint || ''
    detailAiState.requestedFingerprintByService = { ...serviceFingerprints }
    detailAiState.requestedFingerprint = detailAiState.currentFingerprint
    const tasks = requestedServices.map(service => {
      const serviceAvailability = availability[service]
      if (!serviceAvailability?.available) {
        detailAiState.runningByService = {
          ...(detailAiState.runningByService || {}),
          [service]: false,
        }
        const unavailableResult = {
          service,
          status: 'unavailable',
          predictions: [],
          errorMessage: serviceAvailability?.reason || '',
          available: false,
          reason: serviceAvailability?.reason || '',
        }
        _applyDetailAiServiceResult(service, unavailableResult)
        return Promise.resolve(unavailableResult)
      }

      return _runDetailServiceComparison(service, galleryImgs, {
        identifyInputs,
      }).then(result => {
        detailAiState.runningByService = {
          ...(detailAiState.runningByService || {}),
          [service]: false,
        }
        _applyDetailAiServiceResult(service, result)
        return result
      }).catch(error => {
        detailAiState.runningByService = {
          ...(detailAiState.runningByService || {}),
          [service]: false,
        }
        const failureResult = {
          service,
          status: 'error',
          predictions: [],
          errorMessage: String(error?.message || error || 'Unknown error'),
        }
        _applyDetailAiServiceResult(service, failureResult)
        return failureResult
      })
    })

    const settled = await Promise.allSettled(tasks)
    const resultsByService = {}
    requestedServices.forEach((service, index) => {
      const item = settled[index]
      if (item.status === 'fulfilled') {
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
    detailAiState.resultsByService = {
      ...(detailAiState.resultsByService || {}),
      ...resultsByService,
    }
    detailAiState.activeService = primaryService
    detailAiState.stale = false
    const selectionState = _detailAiSelectionStateFromResults(detailAiState.resultsByService, currentObs)
    detailAiState.selectedService = selectionState.selectedService
    detailAiState.selectedPrediction = selectionState.selectedPrediction
    detailAiState.selectedPredictionByService = selectionState.selectedPredictionByService
    detailAiState.selectedProbabilityByService = selectionState.selectedProbabilityByService
    _renderDetailAiTabs()
    _renderDetailAiResults()

    if (!_isDetailAiNoSaveEnabled()) {
      const saveTasks = requestedServices.map(service => {
        const result = detailAiState.resultsByService?.[service]
        if (!currentObs?.id || !state.user?.id || !result?.service || result.status === 'idle') {
          return Promise.resolve(null)
        }
        const serviceFingerprint = serviceFingerprints[result.service] || _detailImageFingerprint(result.service)
        return saveIdentificationRun({
          observationId: currentObs.id,
          userId: state.user.id,
          service: result.service,
          requestFingerprint: serviceFingerprint.requestFingerprint,
          imageFingerprint: serviceFingerprint.imageFingerprint,
          cropFingerprint: serviceFingerprint.cropFingerprint,
          language: getTaxonomyLanguage(),
          results: result.predictions || [],
          status: result.status,
          errorMessage: result.errorMessage || null,
          topPrediction: result.topPrediction || null,
        })
      })
      if (selectionState.selectedPrediction) {
        saveTasks.push(_persistDetailAiSelection(selectionState).catch(error => {
          console.warn('Failed to persist detail AI selection:', error)
          return null
        }))
      }
      await Promise.allSettled(saveTasks)
    }
  } catch (error) {
    console.error('Identification detail error:', error)
    showToast(t('common.errorPrefix', { message: String(error?.message || error || 'Unknown error') }))
  } finally {
    detailAiState.running = false
    detailAiState.runningByService = {}
    detailAiState.stale = false
    detailAiState.localInputsChanged = false
    _renderDetailAiTabs()
    _renderDetailAiResults()
  }
}

async function _runDetailServiceComparison(service, galleryImgs, options = {}) {
  const result = await runDetailIdentify(service, galleryImgs, {
    variant: 'original',
    identifyInputs: options.identifyInputs,
    lat: _detailIdentifyGps()?.lat ?? null,
    lon: _detailIdentifyGps()?.lon ?? null,
    observedOn: _detailIdentifyObservedOn(),
  })
  return {
    service,
    status: Array.isArray(result) && result.length ? 'success' : 'no_match',
    predictions: result || [],
    topPrediction: result?.[0] || null,
    topProbability: result?.[0]?.probability ?? null,
  }
}

async function _goBack(event) {
  if (event) event.preventDefault()
  if (detailImageCropDirty) {
    const cropError = await _persistDetailImageCrops()
    if (cropError) {
      showToast(t('detail.saveFailed', { message: String(cropError?.message || cropError || 'Unknown error') }))
      return
    }
  }
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
  _clearDetailUnavailableState()
  currentObsIsOwner = false
  document.getElementById('detail-taxon-input').value = ''
  document.getElementById('detail-taxon-dropdown').style.display = 'none'
  document.getElementById('detail-location').value    = ''
  detailLocationSuggestions = []
  detailLocationLookupKey = ''
  detailLocationAutoApplied = ''
  detailLocationLookup = null
  _renderDetailLocationDropdown(false)
  document.getElementById('detail-habitat').value     = ''
  const coordsEl = document.getElementById('detail-coords')
  if (coordsEl) { coordsEl.innerHTML = ''; coordsEl.style.display = 'none' }
  document.getElementById('detail-notes').value       = ''
  document.getElementById('detail-uncertain').checked = false
  _setDetailHeader({ fallbackName: t('detail.unknownSpecies') })
  detailAuthorProfile = null
  detailFriendship = null
  detailFollowState = { user: false, observation: false, taxon: false, genus: false }
  detailPrivacySlotCount = null
  _renderDetailAuthorAndSocial()
  document.getElementById('detail-date').textContent  = '—'
  const timeEl = document.getElementById('detail-time')
  const timeVal = document.getElementById('detail-time-val')
  if (timeEl) timeEl.style.display = 'none'
  if (timeVal) timeVal.textContent = ''
  document.getElementById('detail-gallery').innerHTML = ''
  const aiResults = document.getElementById('detail-ai-results')
  if (aiResults) { aiResults.style.display = 'none'; aiResults.innerHTML = '' }
  const staleNote = document.querySelector('[data-identify-stale-note]')
  if (staleNote) staleNote.style.display = 'none'
  const cancelBtn = document.getElementById('detail-cancel-btn')
  if (cancelBtn) cancelBtn.style.display = ''
  detailAiState.running = false
  detailAiState.activeService = null
  detailAiState.availability = {}
  detailAiState.resultsByService = {}
  detailAiState.cachedRows = []
  detailAiState.selectedService = null
  detailAiState.selectedPrediction = null
  detailAiState.selectedPredictionByService = {}
  detailAiState.selectedProbabilityByService = {}
  detailAiState.currentFingerprint = ''
  detailAiState.requestedFingerprint = ''
  detailAiState.localInputsChanged = false
  detailAiState.stale = false
  detailImageCropDirty = false

  // Reset visibility to default
  const r = document.querySelector(`input[name="detail-vis"][value="${normalizeVisibility(getDefaultVisibility(), 'public')}"]`)
  if (r) {
    r.checked = true
    document.querySelectorAll('input[name="detail-vis"]').forEach(radio => {
      radio.closest('.scope-tab').classList.toggle('active', radio.checked)
    })
  }
  const draftInput = document.getElementById('detail-draft')
  if (draftInput) draftInput.checked = true
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.checked = false
  _renderPrivacySlotNote()

  // Clear comments
  const commentsList = document.getElementById('comments-list')
  if (commentsList) commentsList.innerHTML = ''
  const commentInput = document.getElementById('comment-input')
  if (commentInput) commentInput.value = ''
  _syncDetailCommentComposer()
  _applyOwnershipMode(false)
}

function _startDetailLocationLookup(obs) {
  const lat = Number(obs?.gps_latitude)
  const lon = Number(obs?.gps_longitude)
  const lookupKey = lookupCoordinateKey(lat, lon)
  detailLocationSuggestions = []
  detailLocationLookupKey = lookupKey
  detailLocationAutoApplied = ''
  detailLocationLookup = null
  _renderDetailLocationDropdown(false)
  if (!lookupKey) return

  lookupReverseLocation(lat, lon, {
    onUpdate: updated => _applyDetailLocationLookup(lookupKey, updated),
  })
    .then(result => _applyDetailLocationLookup(lookupKey, result))
    .catch(() => {})
}

function _applyDetailLocationLookup(lookupKey, result) {
  if (lookupKey !== detailLocationLookupKey) return
  detailLocationLookup = result || null
  detailLocationSuggestions = result?.suggestions || []
  const first = detailLocationSuggestions[0] || ''
  const input = document.getElementById('detail-location')
  if (input && first && (!input.value.trim() || input.value.trim() === detailLocationAutoApplied)) {
    input.value = first
    detailLocationAutoApplied = first
  }
  _renderDetailLocationDropdown(document.activeElement === input)
}

function _renderDetailLocationDropdown(show) {
  const dropdown = document.getElementById('detail-location-dropdown')
  const input = document.getElementById('detail-location')
  if (!dropdown || !input) return
  if (!show || !currentObsIsOwner || !detailLocationSuggestions.length) {
    dropdown.style.display = 'none'
    dropdown.innerHTML = ''
    return
  }

  dropdown.innerHTML = detailLocationSuggestions
    .map((name, index) => `<li data-index="${index}">${_esc(name)}</li>`)
    .join('')
  dropdown.style.display = 'block'
  dropdown.querySelectorAll('li').forEach((item, index) => {
    const handleSelect = event => {
      event.preventDefault()
      event.stopPropagation()
      const name = detailLocationSuggestions[index] || ''
      input.value = name
      detailLocationAutoApplied = name
      dropdown.style.display = 'none'
    }
    item.addEventListener('mousedown', handleSelect)
    item.addEventListener('touchstart', handleSelect, { passive: false })
  })
}

function _currentDetailUsesPrivacySlot() {
  const visibility = document.querySelector('input[name="detail-vis"]:checked')?.value || 'public'
  const precision = document.getElementById('detail-obscured')?.checked ? 'fuzzed' : 'exact'
  const isDraft = document.getElementById('detail-draft')?.checked !== false
  return observationUsesPrivacySlot({
    is_draft: isDraft,
    visibility,
    location_precision: precision,
  })
}

function _renderPrivacySlotNote() {
  const note = document.getElementById('detail-privacy-slot-note')
  if (!note) return

  const draftPill = document.getElementById('detail-draft-pill')
  const isDraft = document.getElementById('detail-draft')?.checked !== false
  if (draftPill) draftPill.textContent = isDraft ? t('detail.draft') : (t('detail.published') || t('detail.ready'))

  const isPro = state.cloudPlan?.qualityProfile === 'high' || state.cloudPlan?.cloudPlan === 'pro'
  const currentText = _currentDetailUsesPrivacySlot()
    ? t('privacySlots.currentUses')
    : t('privacySlots.currentFree')

  if (isPro) {
    note.textContent = `${t('privacySlots.pro')} ${currentText}`
    return
  }

  const usageText = Number.isFinite(detailPrivacySlotCount)
    ? t('privacySlots.used', { used: detailPrivacySlotCount, limit: 20 })
    : t('privacySlots.usedUnknown')
  note.textContent = `${usageText} ${currentText}`
}

async function _loadPrivacySlotCount() {
  if (!state.user?.id) return
  const { data, error } = await supabase.rpc('non_public_observation_count', {
    profile_id: state.user.id,
  })
  if (error) {
    detailPrivacySlotCount = null
    _renderPrivacySlotNote()
    return
  }
  const count = Number(data)
  detailPrivacySlotCount = Number.isFinite(count) ? count : null
  _renderPrivacySlotNote()
}

function _profileLabel(profile, fallback = t('common.unknown')) {
  if (profile?.username) return `@${profile.username}`
  if (profile?.display_name) return profile.display_name
  return fallback
}

function _profileInitial(profile, fallback = '?') {
  const source = profile?.username || profile?.display_name || fallback
  return String(source).replace(/^@/, '').trim().charAt(0).toUpperCase() || '?'
}

function _detailAuthorFallbackLabel(userId = '') {
  const shortId = String(userId || '').trim().replace(/-/g, '').slice(0, 8)
  return shortId ? `User ${shortId}` : 'User'
}

async function _loadDetailAuthorAndSocial(options = {}) {
  const preserveAuthorProfile = options.preserveAuthorProfile === true
  const preserveFriendship = options.preserveFriendship === true
  const preserveFollowState = options.preserveFollowState === true
  const previousAuthorProfile = detailAuthorProfile
  const previousFriendship = detailFriendship
  const previousFollowState = { ...detailFollowState }

  if (!preserveAuthorProfile) detailAuthorProfile = null
  if (!preserveFriendship) detailFriendship = null
  if (!preserveFollowState) detailFollowState = { user: false, observation: false, taxon: false, genus: false }

  if (!currentObs?.user_id) {
    _renderDetailAuthorAndSocial()
    _syncDetailCommentComposer()
    return
  }

  const isOwner = currentObs.user_id === state.user?.id
  const canQuerySocial = Boolean(state.user?.id)
  const profilePromise = supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .eq('id', currentObs.user_id)
    .maybeSingle()

  const friendshipPromise = isOwner || !canQuerySocial ? Promise.resolve({ data: [] }) : supabase
    .from('friendships')
    .select('id, requester_id, addressee_id, status')
    .or(`and(requester_id.eq.${state.user.id},addressee_id.eq.${currentObs.user_id}),and(requester_id.eq.${currentObs.user_id},addressee_id.eq.${state.user.id})`)
    .limit(1)

  const taxonFollow = _taxonFollowTarget(currentObs)
  const genusTarget = _hasRealTaxonValue(currentObs.genus) ? String(currentObs.genus || '').trim() : ''
  const followTargets = [currentObs.user_id, currentObs.id, taxonFollow?.targetId, genusTarget].filter(Boolean)
  const followsPromise = isOwner || !canQuerySocial ? Promise.resolve({ data: [] }) : supabase
    .from('follows')
    .select('target_type, target_id')
    .eq('user_id', state.user.id)
    .in('target_type', ['user', 'observation', 'species', 'genus'])
    .in('target_id', followTargets)

  const [profileRes, friendshipRes, followsRes] = await Promise.all([profilePromise, friendshipPromise, followsPromise])

  if (!profileRes.error) {
    detailAuthorProfile = profileRes.data || null
  } else if (preserveAuthorProfile && previousAuthorProfile) {
    detailAuthorProfile = previousAuthorProfile
  }

  if (!friendshipRes.error) {
    detailFriendship = friendshipRes.data?.[0] || null
  } else if (preserveFriendship) {
    detailFriendship = previousFriendship
  }

  if (!followsRes.error) {
    const nextFollowState = { user: false, observation: false, taxon: false, genus: false }
    for (const row of followsRes.data || []) {
      if (row.target_type === 'user' && String(row.target_id) === String(currentObs.user_id)) nextFollowState.user = true
      if (row.target_type === 'observation' && String(row.target_id) === String(currentObs.id)) nextFollowState.observation = true
      if (taxonFollow && row.target_type === taxonFollow.targetType && String(row.target_id).toLowerCase() === String(taxonFollow.targetId).toLowerCase()) nextFollowState.taxon = true
      if (genusTarget && row.target_type === 'genus' && String(row.target_id).toLowerCase() === genusTarget.toLowerCase()) nextFollowState.genus = true
    }
    detailFollowState = nextFollowState
  } else if (preserveFollowState) {
    detailFollowState = previousFollowState
  }

  _renderDetailAuthorAndSocial()
  _syncDetailCommentComposer()
}

function _renderDetailAuthorAndSocial() {
  const authorBtn = document.getElementById('detail-author')
  const authorName = document.getElementById('detail-author-name')
  const authorAvatar = document.getElementById('detail-author-avatar')
  const isOwner = currentObs?.user_id === state.user?.id
  const taxonFollow = _taxonFollowTarget(currentObs)
  const genusAvailable = _hasRealTaxonValue(currentObs?.genus)
  const speciesAvailable = taxonFollow && taxonFollow.targetType === 'species'
  const topRow = document.getElementById('detail-top-row')

  if (authorBtn && currentObs?.user_id) {
    const authorFallback = _detailAuthorFallbackLabel(currentObs.user_id)
    const handle = isOwner ? t('common.you') : _profileLabel(detailAuthorProfile, authorFallback)
    const fullName = isOwner ? '' : (detailAuthorProfile?.display_name || '')
    const showName = fullName && fullName !== detailAuthorProfile?.username
    authorBtn.style.display = 'flex'
    if (authorName) {
      authorName.innerHTML = `<span class="author-handle">${_esc(handle)}</span>${showName ? `<span class="author-role">${_esc(fullName)}</span>` : ''}`
    }
    if (authorAvatar) {
      const avatarUrl = detailAuthorProfile?.avatar_url || ''
      authorAvatar.innerHTML = avatarUrl
        ? `<img src="${_esc(avatarUrl)}" alt="" loading="lazy" decoding="async">`
        : _esc(_profileInitial(detailAuthorProfile, handle))
    }
    if (topRow && authorBtn.parentNode !== topRow) {
      topRow.insertBefore(authorBtn, topRow.firstChild)
    }
  } else if (authorBtn) {
    authorBtn.style.display = 'none'
  }

  let actionBar = document.getElementById('detail-action-bar');
  if (actionBar) {
    const hideActionBar = isOwner || !currentObs?.user_id
    actionBar.classList.toggle('is-hidden', hideActionBar)
    if (hideActionBar) {
      actionBar.style.display = 'none';
    } else {
      actionBar.style.display = 'flex';
      
      const status = detailFriendship?.status || ''
      const accepted = status === 'accepted'
      const pending = status === 'pending'
      
      let friendText = accepted ? 'Friends' : (pending ? 'Pending' : 'Add Friend');
      let followText = '';
      let followAction = '';
      let isFollowActive = false;

      const genusFollowActive = detailFollowState.genus || (detailFollowState.taxon && taxonFollow && taxonFollow.targetType === 'genus')
      if (detailFollowState.user) {
         followText = 'Following User';
         followAction = 'user';
         isFollowActive = true;
      } else if (detailFollowState.observation) {
         followText = 'Following Observation';
         followAction = 'observation';
         isFollowActive = true;
      } else if (detailFollowState.taxon && speciesAvailable) {
         followText = 'Following Species';
         followAction = 'taxon';
         isFollowActive = true;
      } else if (genusFollowActive && genusAvailable) {
         followText = 'Following Genus';
         followAction = 'genus';
         isFollowActive = true;
      }
      
      let followHtml
      if (isFollowActive) {
        followHtml = `
          <button id="new-follow-btn" class="action-btn active" data-action="${followAction}">
            <svg class="follow-btn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>${followText}</span>
          </button>
        `;
      } else {
        followHtml = `
          <div class="follow-dropdown-wrap" id="follow-dropdown-wrap">
            <button id="new-follow-btn" class="action-btn follow-inactive">
              <svg class="follow-btn-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>
              <span>Follow</span>
              <svg class="follow-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>
            <div class="follow-menu" id="follow-menu" style="display: none;">
              <button class="follow-menu-item" data-action="user">
                <span class="follow-menu-title">Follow User</span>
                <span class="follow-menu-sub">${_esc(_profileLabel(detailAuthorProfile, _detailAuthorFallbackLabel(currentObs.user_id)))}</span>
              </button>
              <div class="follow-menu-div"></div>
              <button class="follow-menu-item" data-action="observation">
                <span class="follow-menu-title">Follow Observation</span>
                <span class="follow-menu-sub">#${_esc(String(currentObs.id || '').trim())}</span>
              </button>
              ${speciesAvailable || genusAvailable ? '<div class="follow-menu-div"></div>' : ''}
              ${speciesAvailable ? `
              <button class="follow-menu-item" data-action="taxon">
                <span class="follow-menu-title">Follow Species</span>
                <span class="follow-menu-sub">${_esc(taxonFollow.targetId)}</span>
              </button>
              ${genusAvailable ? '<div class="follow-menu-div"></div>' : ''}
              ` : ''}
              ${genusAvailable ? `
              <button class="follow-menu-item" data-action="genus">
                <span class="follow-menu-title">Follow Genus</span>
                <span class="follow-menu-sub">${_esc(currentObs.genus)}</span>
              </button>
              ` : ''}
            </div>
          </div>
        `;
      }

      actionBar.innerHTML = `
        <button id="new-friend-btn" class="action-btn" ${accepted || pending ? 'disabled' : ''}>
          <svg class="friend-btn-icon ${accepted ? 'is-friend' : ''}" width="20" height="20" viewBox="0 0 24 24" fill="${accepted ? 'var(--red)' : 'none'}" stroke="${accepted ? 'var(--red)' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          <span>${friendText}</span>
        </button>
        ${followHtml}
      `;
      
      document.getElementById('new-friend-btn').addEventListener('click', _sendFriendRequestFromDetail);
      
      const followBtn = document.getElementById('new-follow-btn');
      
      if (isFollowActive) {
        followBtn.addEventListener('click', () => {
          _toggleFollowSpecific(followBtn.dataset.action);
        });
      } else {
        const followWrap = document.getElementById('follow-dropdown-wrap');
        const followMenu = document.getElementById('follow-menu');
        
        followBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpening = followMenu.style.display === 'none';
          followMenu.style.display = isOpening ? 'block' : 'none';
          followBtn.classList.toggle('menu-open', isOpening);
          
          if (isOpening) {
            const closeMenu = (ev) => {
              if (!followWrap.contains(ev.target)) {
                followMenu.style.display = 'none';
                followBtn.classList.remove('menu-open');
                document.removeEventListener('click', closeMenu);
              }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
          }
        });
        
        followMenu.querySelectorAll('.follow-menu-item').forEach(item => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            followMenu.style.display = 'none';
            followBtn.classList.remove('menu-open');
            const action = item.dataset.action;
            _toggleFollowSpecific(action);
          });
        });
      }
    }
  }
}

function _taxonFollowTarget(obs) {
  const genus = String(obs?.genus || '').trim()
  const species = String(obs?.species || '').trim()
  if (_hasRealTaxonValue(genus) && _hasRealTaxonValue(species)) return { targetType: 'species', targetId: `${genus} ${species}` }
  if (_hasRealTaxonValue(genus)) return { targetType: 'genus', targetId: genus }
  return null
}

async function _openAuthorFinds() {
  if (!currentObs?.user_id || currentObs.user_id === state.user?.id) return
  const userId = currentObs.user_id
  const [profileRes, statsRes, relationshipMap] = await Promise.all([
    detailAuthorProfile
      ? Promise.resolve({ data: detailAuthorProfile })
      : supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio')
        .eq('id', userId)
        .maybeSingle(),
    supabase.rpc('get_person_stats', { p_user_id: userId }),
    loadPeopleSocialState([userId]),
  ])

  const profile = profileRes?.data || detailAuthorProfile || null
  const statsRow = Array.isArray(statsRes?.data) ? (statsRes.data[0] || null) : (statsRes?.data || null)
  await openFinds('user', {
    userId,
    username: profile?.username || null,
    displayName: profile?.display_name || null,
    avatarUrl: profile?.avatar_url || '',
    bio: profile?.bio || null,
    finds: statsRow?.public_find_count !== undefined ? Number(statsRow.public_find_count) : currentObs?.finds,
    species: statsRow?.public_species_count !== undefined ? Number(statsRow.public_species_count) : currentObs?.species,
    spores: statsRow?.public_spore_count !== undefined ? Number(statsRow.public_spore_count) : currentObs?.spores,
    relationship: relationshipMap?.[userId] || {
      friendStatus: detailFriendship?.status || null,
      following: detailFollowState.user === true,
    },
    summaryLoaded: true,
    summaryComplete: true,
    resetSearch: true,
    resetFilters: true,
  })
}

function _isUnknownTaxonValue(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (!normalized) return true

  const unknownLabels = new Set([
    '?',
    'unknown',
    'unknown species',
    'unknown genus',
    'unknown taxon',
    'unknown organism',
    'sp',
    'sp.',
    'spp',
    'spp.',
  ])
  const translatedUnknown = String(t('detail.unknownSpecies') || '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (translatedUnknown) unknownLabels.add(translatedUnknown)

  return normalized.startsWith('?')
    || normalized.startsWith('unknown ')
    || unknownLabels.has(normalized)
}

function _hasRealTaxonValue(value) {
  return ! _isUnknownTaxonValue(value)
}

function _isDuplicateSocialWriteError(error) {
  const code = String(error?.code || '')
  const status = Number(error?.status || error?.statusCode || 0)
  const message = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  return code === '23505'
    || status === 409
    || message.includes('duplicate')
    || message.includes('conflict')
}

async function _sendFriendRequestFromDetail() {
  if (!currentObs?.user_id || !state.user?.id || currentObs.user_id === state.user.id) return
  const btn = document.getElementById('new-friend-btn') || document.getElementById('detail-friend-btn')
  if (btn) btn.disabled = true
  try {
    const { data, error } = await supabase
      .from('friendships')
      .insert({ requester_id: state.user.id, addressee_id: currentObs.user_id, status: 'pending' })
      .select('id, requester_id, addressee_id, status')
      .single()

    if (error && !_isDuplicateSocialWriteError(error)) {
      console.warn('Friend request failed:', error)
      showToast(t('social.friendFailed'))
      return
    }

    if (error) {
      console.warn('Friend request already exists; treating as success:', error)
    }

    showToast(t('social.friendRequestSent') || 'Friend request sent')
    detailFriendship = data || detailFriendship || { status: 'pending' }
    await _loadDetailAuthorAndSocial({ preserveAuthorProfile: true, preserveFriendship: true, preserveFollowState: true })
  } catch (error) {
    console.warn('Friend request failed:', error)
    showToast(t('social.friendFailed'))
  } finally {
    if (btn) btn.disabled = false
    _syncDetailCommentComposer()
  }
}

async function _toggleFollowSpecific(kind) {
  if (!currentObs || !state.user?.id || currentObs.user_id === state.user.id) return
  let targetType
  let targetId
  let key

  if (kind === 'genus') {
    if (!_hasRealTaxonValue(currentObs.genus)) return
    targetType = 'genus'
    targetId = String(currentObs.genus || '').trim()
    key = 'genus'
  } else if (kind === 'taxon') {
    const tf = _taxonFollowTarget(currentObs)
    if (!tf) return
    targetType = tf.targetType
    targetId = tf.targetId
    key = 'taxon'
  } else if (kind === 'user') {
    targetType = 'user'
    targetId = currentObs.user_id
    key = 'user'
  } else if (kind === 'observation') {
    targetType = 'observation'
    targetId = currentObs.id
    key = 'observation'
  } else {
    return
  }

  if (!targetId) return;

  const currentlyFollowing = !!detailFollowState[key];
  const btn = document.getElementById('new-follow-btn');
  if (btn) btn.disabled = true

  try {
    if (currentlyFollowing) {
      const { error } = await supabase
        .from('follows')
        .delete()
        .eq('user_id', state.user.id)
        .eq('target_type', targetType)
        .eq('target_id', targetId)
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('follows')
        .upsert({
          user_id: state.user.id,
          target_type: targetType,
          target_id: targetId,
        }, {
          onConflict: 'user_id,target_type,target_id',
        })
      if (error && !_isDuplicateSocialWriteError(error)) throw error
      if (error) {
        console.warn('Follow already existed; treating as success:', error)
      }
    }

    await _loadDetailAuthorAndSocial({
      preserveAuthorProfile: true,
      preserveFriendship: true,
      preserveFollowState: true,
    })
  } catch (error) {
    console.warn('Follow toggle failed:', {
      kind,
      targetType,
      targetId,
      error: {
        code: error?.code || null,
        message: error?.message || '',
        details: error?.details || '',
        hint: error?.hint || '',
      },
    })
    showToast(t('social.followFailed'))
  } finally {
    if (btn) btn.disabled = false
  }
}

function _applyOwnershipMode(isOwner) {
  const readonlyNote = document.getElementById('detail-readonly-note')
  const saveBtn = document.getElementById('detail-save-btn')
  const deleteBtn = document.getElementById('detail-delete-btn')
  const aiRunBtn = document.querySelector('[data-identify-run-button]')
  const aiTabs = Array.from(document.querySelectorAll('[data-identify-service-tab]'))
  const taxonInput = document.getElementById('detail-taxon-input')
  const locationInput = document.getElementById('detail-location')
  const habitatInput = document.getElementById('detail-habitat')
  const notesInput = document.getElementById('detail-notes')
  const uncertainInput = document.getElementById('detail-uncertain')

  if (readonlyNote) {
    readonlyNote.style.display = 'none'
  }
  if (saveBtn) saveBtn.style.display = isOwner ? '' : 'none'
  if (deleteBtn) deleteBtn.style.display = isOwner ? '' : 'none'
  if (aiRunBtn) {
    aiRunBtn.disabled = !isOwner
    aiRunBtn.setAttribute('aria-disabled', String(!isOwner))
    if (!isOwner) {
      const runTitle = _detailAiRunDisabledTitle()
      aiRunBtn.title = runTitle
      aiRunBtn.setAttribute('aria-label', runTitle)
    } else {
      aiRunBtn.removeAttribute('title')
      aiRunBtn.setAttribute('aria-label', _tf('review.aiId', 'AI Photo ID'))
    }
  }
  aiTabs.forEach(tab => {
    tab.disabled = false
    tab.setAttribute('aria-disabled', 'false')
  })
  if (taxonInput) taxonInput.disabled = !isOwner
  if (locationInput) locationInput.readOnly = !isOwner
  if (habitatInput) habitatInput.readOnly = !isOwner
  if (notesInput) notesInput.readOnly = !isOwner
  if (uncertainInput) uncertainInput.disabled = !isOwner
  const draftInput = document.getElementById('detail-draft')
  if (draftInput) draftInput.disabled = !isOwner

  const currentLocationBtn = document.getElementById('detail-current-location-btn')
  if (currentLocationBtn) currentLocationBtn.style.display = 'none'

  document.querySelectorAll('input[name="detail-vis"]').forEach(radio => {
    radio.disabled = !isOwner
    const sharingField = radio.closest('.detail-field')
    if (sharingField) sharingField.style.display = isOwner ? '' : 'none'
  })
  const obscuredInput = document.getElementById('detail-obscured')
  if (obscuredInput) obscuredInput.disabled = !isOwner
  _renderPrivacySlotNote()

  let modContainer = document.getElementById('detail-mod-container')
  if (!isOwner) {
    if (!modContainer) {
      modContainer = document.createElement('div')
      modContainer.id = 'detail-mod-container'
      modContainer.style.marginTop = '24px'
      modContainer.style.paddingTop = '16px'
      modContainer.style.borderTop = '1px solid var(--border-dim)'
      modContainer.style.display = 'flex'
      modContainer.style.gap = '10px'
      
      const blockBtn = document.createElement('button')
      blockBtn.id = 'detail-block-btn'
      blockBtn.className = 'btn-secondary btn-sm'
      blockBtn.style.flex = '1'
      blockBtn.style.color = 'var(--red)'
      blockBtn.textContent = t('detail.blockUser') || 'Block user'
      blockBtn.addEventListener('click', _blockObservationAuthor)
      
      const reportBtn = document.createElement('button')
      reportBtn.id = 'detail-report-btn'
      reportBtn.className = 'btn-secondary btn-sm'
      reportBtn.style.flex = '1'
      reportBtn.style.color = 'var(--amber)'
      reportBtn.textContent = t('detail.reportPost') || 'Report post'
      reportBtn.addEventListener('click', _reportObservation)
      
      modContainer.appendChild(reportBtn)
      modContainer.appendChild(blockBtn)
      
      const body = document.querySelector('#screen-find-detail .review-body')
      if (body) body.appendChild(modContainer)
    }
    modContainer.style.display = 'flex'
  } else {
    if (modContainer) modContainer.style.display = 'none'
  }
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
        uncertain: document.getElementById('detail-uncertain')?.checked,
      })
      dropdown.style.display = 'none'
    })
  })
}

function _setDetailHeader({ commonName = '', genus = '', species = '', fallbackName = t('detail.unknownSpecies'), uncertain = false }) {
  const commonEl = document.getElementById('detail-title-common')
  const latinEl = document.getElementById('detail-title-latin')
  if (!commonEl || !latinEl) return

  const latinName = [genus, species].filter(Boolean).join(' ').trim()
  const primaryName = String(commonName || '').trim() || String(fallbackName || '').trim() || t('detail.unknownSpecies')
  const markedPrimary = uncertain ? `? ${primaryName.replace(/^\?\s*/, '')}` : primaryName.replace(/^\?\s*/, '')
  const markedLatin = uncertain ? `? ${latinName.replace(/^\?\s*/, '')}` : latinName.replace(/^\?\s*/, '')

  commonEl.innerHTML = _esc(markedPrimary)
  const draftBadgeEl = document.getElementById('detail-draft-badge')
  if (draftBadgeEl) {
    draftBadgeEl.style.display = 'none'
  }
  if (latinName && latinName.toLowerCase() !== primaryName.toLowerCase()) {
    latinEl.textContent = markedLatin
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
    location:   document.getElementById('detail-location').value.trim()  || null,
    habitat:    document.getElementById('detail-habitat').value.trim()   || null,
    notes:      document.getElementById('detail-notes').value.trim()     || null,
    uncertain:  document.getElementById('detail-uncertain').checked,
    visibility: toCloudVisibility(document.querySelector('input[name="detail-vis"]:checked')?.value || 'public'),
    is_draft: document.getElementById('detail-draft')?.checked !== false,
    location_precision: document.getElementById('detail-obscured')?.checked ? 'fuzzed' : 'exact',
    ai_selected_service: currentObs.ai_selected_service || null,
    ai_selected_taxon_id: currentObs.ai_selected_taxon_id || null,
    ai_selected_scientific_name: currentObs.ai_selected_scientific_name || null,
    ai_selected_probability: currentObs.ai_selected_probability ?? null,
    ai_selected_at: currentObs.ai_selected_at || null,
    red_list_category: currentObs.red_list_category ?? null,
    red_list_categories_json: currentObs.red_list_categories_json ?? null,
  }

  const taxonInputValue = document.getElementById('detail-taxon-input').value.trim()
  const currentDisplayName = formatDisplayName(
    currentObs.genus || '',
    currentObs.species || '',
    currentObs.common_name || '',
  ).trim()
  const selectedPrediction = detailAiState.selectedPrediction || detailAiState.selectedPredictionByService?.[detailAiState.selectedService] || null

  if (selectedTaxon) {
    patch.genus       = selectedTaxon.genus            || null
    patch.species     = selectedTaxon.specificEpithet  || null
    patch.common_name = selectedTaxon.vernacularName   || null
    patch.ai_selected_service = detailAiState.selectedService || selectedPrediction?.service || null
    patch.ai_selected_taxon_id = selectedPrediction?.taxonId || null
    patch.ai_selected_scientific_name = selectedPrediction?.scientificName || null
    patch.ai_selected_probability = detailAiState.selectedService
      ? detailAiState.selectedProbabilityByService?.[detailAiState.selectedService] ?? selectedPrediction?.probability ?? null
      : selectedPrediction?.probability ?? null
    patch.ai_selected_at = new Date().toISOString()
    if (selectedPrediction) {
      patch.red_list_category = getPredictionRedlistCategory(selectedPrediction) || null
      patch.red_list_categories_json = getPredictionRedlistCategoriesMap(selectedPrediction)
    }
  } else if (taxonInputValue !== currentDisplayName) {
    patch.genus       = null
    patch.species     = taxonInputValue || null
    patch.common_name = null
    patch.ai_selected_service = null
    patch.ai_selected_taxon_id = null
    patch.ai_selected_scientific_name = null
    patch.ai_selected_probability = null
    patch.ai_selected_at = null
    patch.red_list_category = null
    patch.red_list_categories_json = null
  }

  let updatePatch = { ...patch }
  let { error } = await supabase
    .from('observations')
    .update(updatePatch)
    .eq('id', currentObs.id)
    .eq('user_id', state.user.id)

  if (error) {
    const redlistFallback = _removeMissingObservationColumnsFromPatch(updatePatch, error, DETAIL_AI_SELECTION_REDLIST_FIELDS)
    if (redlistFallback.removed) {
      updatePatch = redlistFallback.patch
      ;({ error } = await supabase
        .from('observations')
        .update(updatePatch)
        .eq('id', currentObs.id)
        .eq('user_id', state.user.id))
    }
  }

  if (error) {
    const aiFallback = _removeMissingObservationColumnsFromPatch(updatePatch, error, [
      ...DETAIL_AI_SELECTION_FIELDS,
    ])
    if (aiFallback.removed) {
      updatePatch = aiFallback.patch
      ;({ error } = await supabase
        .from('observations')
        .update(updatePatch)
        .eq('id', currentObs.id)
        .eq('user_id', state.user.id))
    }
  }

  if (error) {
    const legacyFallback = _removeMissingObservationColumnsFromPatch(
      updatePatch,
      error,
      ['is_draft', 'location_precision'],
    )
    if (legacyFallback.removed) {
      updatePatch = legacyFallback.patch
      ;({ error } = await supabase
        .from('observations')
        .update(updatePatch)
        .eq('id', currentObs.id)
        .eq('user_id', state.user.id))
    }
  }

  btn.disabled = false

  if (error) {
    showToast(t('detail.saveFailed', { message: error.message }))
    return
  }

  if (detailImageCropDirty) {
    const cropError = await _persistDetailImageCrops()
    if (cropError) {
      btn.disabled = false
      showToast(t('detail.saveFailed', { message: String(cropError?.message || cropError || 'Unknown error') }))
      return
    }
  }

  setLastSyncAt()
  showToast(t('detail.saved'))
  _loadPrivacySlotCount()
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

  try {
    // Delete storage images first
    const { data: imgData } = await supabase
      .from('observation_images')
      .select('storage_path')
      .eq('observation_id', currentObs.id)

    if (imgData?.length) {
      await deleteObservationMedia(imgData.map(i => i.storage_path))
    }

    const { error } = await supabase
      .from('observations')
      .delete()
      .eq('id', currentObs.id)
      .eq('user_id', state.user.id)

    if (error) { showToast(t('detail.deleteFailed', { message: error.message })); return }

    setLastSyncAt()
    showToast(t('detail.deleted'))
    _goBack()
  } catch (error) {
    showToast(t('detail.deleteFailed', { message: error.message }))
  } finally {
    btn.disabled = false
  }
}

async function _blockObservationAuthor() {
  if (!currentObs || !state.user) return
  if (!confirm(t('detail.blockUserConfirm') || 'Block this user? You will no longer see their posts and comments.')) return
  
  const btn = document.getElementById('detail-block-btn')
  if (btn) btn.disabled = true
  
  const { error } = await supabase.from('user_blocks').insert({
    blocker_id: state.user.id,
    blocked_id: currentObs.user_id
  })
  
  if (error && error.code !== '23505') {
    showToast((t('detail.blockFailed') || 'Failed to block user: ') + error.message)
    if (btn) btn.disabled = false
    return
  }
  
  showToast(t('detail.userBlocked') || 'User blocked.')
  await loadFinds()
  await refreshHome()
  _goBack()
}

async function _reportObservation() {
  if (!currentObs || !state.user) return
  const reason = prompt(t('detail.reportReason') || 'Why are you reporting this post? (e.g. spam, inappropriate)')
  if (!reason) return
  
  const btn = document.getElementById('detail-report-btn')
  if (btn) btn.disabled = true
  
  const { error } = await supabase.from('reports').insert({
    reporter_id: state.user.id,
    reported_user_id: currentObs.user_id,
    observation_id: currentObs.id,
    reason: reason.trim(),
    status: 'pending'
  })
  
  if (error) {
    showToast((t('detail.reportFailed') || 'Failed to report: ') + error.message)
    if (btn) btn.disabled = false
    return
  }
  
  showToast(t('detail.postReported') || 'Post reported to admins.')
  _goBack()
}

async function _loadComments(obsId) {
  const list = document.getElementById('comments-list')
  if (!list) return
  list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('common.loading')}</div>`

  const { data, error } = await supabase
    .from('comments_community_view')
    .select('id, body, created_at, user_id')
    .eq('observation_id', obsId)
    .order('created_at', { ascending: true })

  if (error) {
    console.warn('Comment load failed:', error.message)
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('comments.couldNotLoad')}</div>`
    return
  }

  const visibleComments = data || []

  if (!visibleComments?.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;padding:8px 0">${t('comments.none')}</div>`
    return
  }

  const authorMap = await fetchCommentAuthorMap(visibleComments, state.user)

  list.innerHTML = visibleComments.map(c => {
    const { name, initial } = getCommentAuthor(authorMap[c.user_id])
    const date = formatDate(c.created_at, { day: 'numeric', month: 'short' })
    const isMe = c.user_id === state.user?.id
    const modHtml = !isMe ? `
      <div style="margin-left:auto; display:flex; gap:8px;">
        <button class="comment-report-btn" data-uid="${c.user_id}" data-cid="${c.id}" style="background:none; border:none; color:var(--amber); font-size:11px; cursor:pointer;">Report</button>
        <button class="comment-block-btn" data-uid="${c.user_id}" style="background:none; border:none; color:var(--red); font-size:11px; cursor:pointer;">Block</button>
      </div>
    ` : ''

    return `<div class="comment-row">
      <div class="comment-avatar">${_esc(initial)}</div>
      <div class="comment-body-wrap">
        <div class="comment-meta">
          <span class="comment-author">${_esc(name)}</span>
          <span class="comment-date">${date}</span>
          ${modHtml}
        </div>
        <div class="comment-text">${_esc(c.body)}</div>
      </div>
    </div>`
  }).join('')

  list.querySelectorAll('.comment-report-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const reason = prompt(t('comments.reportReason') || 'Why are you reporting this comment?')
      if (!reason) return
      const uid = btn.dataset.uid
      const cid = btn.dataset.cid
      const { error } = await supabase.from('reports').insert({
        reporter_id: state.user.id,
        reported_user_id: uid,
        comment_id: cid,
        observation_id: obsId,
        reason: reason.trim(),
        status: 'pending'
      })
      if (error) {
        showToast((t('comments.reportFailed') || 'Failed to report: ') + error.message)
        return
      }
      showToast(t('comments.commentReported') || 'Comment reported.')
    })
  })

  list.querySelectorAll('.comment-block-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('comments.blockConfirm') || 'Block this user?')) return
      const uid = btn.dataset.uid
      const { error } = await supabase.from('user_blocks').insert({
        blocker_id: state.user.id,
        blocked_id: uid
      })
      if (error && error.code !== '23505') {
        showToast((t('comments.blockFailed') || 'Failed to block: ') + error.message)
        return
      }
      showToast(t('comments.userBlocked') || 'User blocked.')
      _loadComments(obsId)
      loadFinds()
      refreshHome()
    })
  })
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

function _detailCommentCanPost(obs = currentObs) {
  if (!state.user?.id || !obs?.id) return false
  if (obs.user_id === state.user.id) return true
  const visibility = normalizeVisibility(obs.visibility, 'public')
  if (visibility === 'public') return true
  if (visibility === 'friends') return detailFriendship?.status === 'accepted'
  return false
}

function _detailCommentPermissionMessage(obs = currentObs) {
  const visibility = normalizeVisibility(obs?.visibility, 'public')
  if (!state.user?.id) return 'Sign in to comment.'
  if (obs?.user_id === state.user.id) return ''
  if (visibility === 'friends') {
    return 'Only accepted friends can comment on friends-only observations.'
  }
  if (visibility === 'private') {
    return 'Comments are disabled for private observations.'
  }
  return 'Comments are not available for this observation.'
}

function _syncDetailCommentComposer() {
  const input = document.getElementById('comment-input')
  const btn = document.getElementById('comment-send-btn')
  const row = input?.closest('.comment-input-row')
  if (!input || !btn || !row) return

  const note = document.getElementById('comment-permission-note')
  if (!currentObs?.id) {
    input.disabled = true
    btn.disabled = true
    btn.title = ''
    input.title = ''
    if (note) note.remove()
    return
  }

  const canComment = _detailCommentCanPost()
  const hasText = Boolean(String(input.value || '').trim())
  input.disabled = !canComment
  btn.disabled = !canComment || !hasText
  btn.title = canComment ? '' : _detailCommentPermissionMessage()
  input.title = canComment ? '' : _detailCommentPermissionMessage()

  let noteEl = note
  const permissionMessage = _detailCommentPermissionMessage()
  if (canComment) {
    if (noteEl) noteEl.remove()
    return
  }

  if (!noteEl) {
    noteEl = document.createElement('div')
    noteEl.id = 'comment-permission-note'
    noteEl.style.marginTop = '6px'
    noteEl.style.fontSize = '12px'
    noteEl.style.lineHeight = '1.4'
    noteEl.style.color = 'var(--text-dim)'
    row.insertAdjacentElement('afterend', noteEl)
  }
  noteEl.textContent = permissionMessage
}

async function _sendComment() {
  const input = document.getElementById('comment-input')
  const body = String(input?.value || '').trim()
  const btn = document.getElementById('comment-send-btn')
  if (!body || !currentObs || !_detailCommentCanPost()) return
  if (btn) btn.disabled = true

  try {
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
    if (error && _isMissingObservationColumnError(error, ['mentioned_user_ids'])) {
      ;({ error } = await supabase.from('comments').insert({
        observation_id: currentObs.id,
        user_id: state.user.id,
        body,
      }))
    }
    if (error) {
      const message = String(error?.message || error || 'Unknown error')
      console.warn('Comment insert failed:', {
        observationId: currentObs.id,
        visibility: currentObs.visibility || '',
        viewerMode: currentObs.user_id === state.user?.id ? 'owner' : 'viewer',
        error: {
          code: error?.code || null,
          message: error?.message || '',
          details: error?.details || '',
          hint: error?.hint || '',
        },
      })
      showToast(t('comments.postFailed', { message }))
      return
    }
    input.value = ''
    showToast(t('comments.posted'))
    _syncDetailCommentComposer()
    _loadComments(currentObs.id)
  } catch (error) {
    const message = String(error?.message || error || 'Unknown error')
    console.warn('Comment insert failed:', {
      observationId: currentObs.id,
      visibility: currentObs.visibility || '',
      viewerMode: currentObs.user_id === state.user?.id ? 'owner' : 'viewer',
      error: {
        code: error?.code || null,
        message: error?.message || '',
        details: error?.details || '',
        hint: error?.hint || '',
      },
    })
    showToast(t('comments.postFailed', { message }))
  } finally {
    if (btn) btn.disabled = false
  }
}

async function _openCameraForDetail() {
  if (isAndroidNativeApp()) {
    try {
      const screenPath = 'find_detail:add-photo'
      if (getUseSystemCamera()) {
        const captureSource = 'system camera'
        playIrisShutter({ mode: 'quick' })
        const result = await NativeCamera.openSystemCamera()
        const photos = Array.isArray(result?.photos) ? result.photos : []
        if (!photos.length) return

        _setProgress(0, photos.length, t('import.readingFiles'))
        const files = []
        for (let i = 0; i < photos.length; i++) {
          _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }))
          files.push(await nativePickedPhotoToFile(photos[i], i, { captureSource, screenPath }))
        }
        await _addPhotosToObservation(files)
        return
      }

      const captureSource = 'Sporely native camera'
      const gps = state.gps && Number.isFinite(state.gps.lat) && Number.isFinite(state.gps.lon)
        ? { latitude: state.gps.lat, longitude: state.gps.lon, altitude: state.gps.altitude, accuracy: state.gps.accuracy }
        : null
      const options = { jpegQuality: NATIVE_CAMERA_JPEG_QUALITY }
      if (gps) options.gps = gps
      debugImagePipeline('android native camera capture requested', {
        screenPath,
        captureSource,
        gps,
      })
      playIrisShutter({ mode: 'quick' })
      const result = await NativeCamera.capturePhotos(options)
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
      debugImagePipeline('android native files ready for observation upload', {
        screenPath,
        captureSource,
        fileCount: files.length,
        fileSizes: files.map(file => file?.size || 0),
      })
      await _addPhotosToObservation(files)
    } catch (err) {
      if (isPickerCancel(err)) return
      showToast(`Sporely Cam: ${err?.message || err}`)
      _hideProgress()
    }
  } else {
    const detailObsId = currentObs?.id
    setCaptureCompleteHandler(async photos => {
      navigate('find-detail')
      try {
        const files = []
        for (let i = 0; i < photos.length; i++) {
          const photo = photos[i]
          const blob = photo?.blob || await photo?.blobPromise
          if (!blob) continue
          files.push(new File(
            [blob],
            `sporely-capture-${i + 1}.${imageExtensionForBlob(blob)}`,
            { type: blob.type || 'image/jpeg', lastModified: photo?.ts?.getTime?.() || Date.now() }
          ))
        }
        if (files.length) {
          await _addPhotosToObservation(files)
        }
      } finally {
        if (detailObsId) await openFindDetail(detailObsId)
      }
    })
    navigate('capture')
  }
}

async function _openPickerForDetail() {
  if (isAndroidNativeApp()) {
    try {
      const screenPath = 'find_detail:add-photo'
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
      debugImagePipeline('android native files ready for observation upload', {
        screenPath,
        captureSource,
        fileCount: files.length,
        fileSizes: files.map(file => file?.size || 0),
      })
      await _addPhotosToObservation(files)
      return
    } catch (err) {
      if (isPickerCancel(err)) return
      console.warn('Native image picker failed:', err)
      showToast(t('profile.uploadFailed', { message: String(err?.message || err || 'Unknown error') }))
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
    await _addPhotosToObservation(files)
  }
  input.click()
}

async function _addPhotosToObservation(files) {
  if (!currentObs || !files.length) return

  const obsId = currentObs.id
  const userId = String(state.user?.id || '').trim()
  if (!userId) {
    showToast(t('review.notSignedIn'))
    return
  }
  if (currentObs.user_id && currentObs.user_id !== userId) {
    showToast(t('detail.onlyOwnerEdit'))
    return
  }

  _setProgress(0, files.length, `Adding ${files.length} photo(s)...`)
  const saveBtn = document.getElementById('detail-save-btn')
  if (saveBtn) saveBtn.disabled = true

  try {
    const { data: existingImages } = await supabase
      .from('observation_images')
      .select('sort_order')
      .eq('observation_id', obsId)
      .is('deleted_at', null)
      .order('sort_order', { ascending: false })
      .limit(1)

    let nextSortOrder = 0
    if (existingImages?.length) {
      nextSortOrder = (existingImages[0].sort_order || 0) + 1
    }

    const uploadPolicy = await fetchCloudPlanProfile(userId)

    for (let i = 0; i < files.length; i++) {
      _setProgress(i, files.length, `Uploading ${i + 1} of ${files.length}...`)
      const file = files[i]
      const sortOrder = nextSortOrder + i

      const preparedImage = await prepareImageVariants(file, uploadPolicy)
      let cropMeta
      const storagePath = buildObservationImageStoragePath({
        userId,
        observationId: obsId,
        sortOrder,
        timestamp: Date.now(),
        extension: imageExtensionForBlob(preparedImage.uploadBlob),
      })
      await uploadPreparedObservationImageVariants(preparedImage, storagePath, {
        uploadPolicy,
        userId,
        observationId: obsId,
      })

      try {
        cropMeta = await createImageCropMeta(preparedImage.uploadBlob, { preseed: true })
        await insertObservationImage({
          observation_id: obsId,
          user_id: userId,
          storage_path: storagePath,
          image_type: 'field',
          sort_order: sortOrder,
          ...preparedImage.uploadMeta,
          storage_exif_safe: preparedImage.uploadMeta?.storage_exif_safe === true,
          ...cropMeta,
        })
      } catch (err) {
        await deleteObservationMedia([storagePath]).catch(() => {})
        throw err
      }

      if (sortOrder === 0) {
        await syncObservationMediaKeys(obsId, storagePath, { sortOrder: 0 })
      }

      const { data: insertedRows } = await supabase
        .from('observation_images')
        .select('id, storage_path, sort_order, image_type, ai_crop_x1, ai_crop_y1, ai_crop_x2, ai_crop_y2, ai_crop_source_w, ai_crop_source_h, ai_crop_is_custom')
        .eq('observation_id', obsId)
        .eq('sort_order', sortOrder)
        .is('deleted_at', null)
        .order('id', { ascending: false })
        .limit(1)
      const insertedRow = insertedRows?.[0] || {
        id: `new-${sortOrder}-${Date.now()}`,
        storage_path: storagePath,
        sort_order: sortOrder,
        image_type: 'field',
        ai_crop_x1: cropMeta?.aiCropRect?.x1 ?? null,
        ai_crop_y1: cropMeta?.aiCropRect?.y1 ?? null,
        ai_crop_x2: cropMeta?.aiCropRect?.x2 ?? null,
        ai_crop_y2: cropMeta?.aiCropRect?.y2 ?? null,
        ai_crop_source_w: cropMeta?.aiCropSourceW ?? null,
        ai_crop_source_h: cropMeta?.aiCropSourceH ?? null,
        ai_crop_is_custom: cropMeta?.aiCropIsCustom === true,
      }
      const [originalSource] = await resolveMediaSources([storagePath], { variant: 'original' })
      const [displaySource] = await resolveMediaSources([storagePath], { variant: 'medium' })
      _appendDetailGalleryImage(insertedRow, displaySource, displaySource, { originalSource })
    }

    showToast(`${files.length} photo(s) added.`)
    _markDetailAiStale()
  } catch (err) {
    console.error('Failed to add photos to observation:', err)
    showToast(t('profile.uploadFailed', { message: String(err?.message || err || 'Unknown error') }))
  } finally {
    _hideProgress()
    if (saveBtn) saveBtn.disabled = false
  }
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

export {
  _canRunDetailAiService,
  _canViewDetailAiResult,
  _buildDetailAiCachedResult,
  _buildDetailAiCachedResults,
  _hasAiRunResult,
  _hasStoredAiResult,
  _detailAiCropInputMapChanged,
  _detailAiCropMetaMapChanged,
  detailAiState,
  _setDetailAiActiveService,
  _renderDetailAiTabs,
  _renderDetailAiResults,
}
