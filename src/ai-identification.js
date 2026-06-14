import { supabase as defaultSupabase } from './supabase.js'
import { t } from './i18n.js'
import { loadInaturalistSession } from './inaturalist.js'
import {
  getDefaultIdService,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
} from './settings.js'
import { normalizeAiCropRect } from './image_crop.js'
import {
  formatIdentifyScore,
  runIdentifyForBlobs,
  runIdentifyForMediaKeys,
} from './identify.js'
import { isBlob } from './observation-shapes.js'
import { esc as _esc } from './esc.js'

/**
 * AI identification image input shape. Callers pass the decode blob plus the
 * optional original/source blob, crop metadata, and storage key context.
 *
 * @typedef {Object} IdentifyImageInput
 * @property {Blob|null} [blob]
 * @property {Blob|null} [originalBlob]
 * @property {Blob|null} [sourceBlob]
 * @property {Object|null} [cropRect]
 * @property {number|null} [cropSourceW]
 * @property {number|null} [cropSourceH]
 * @property {string|null} [mediaKey]
 * @property {string|null} [media_key]
 * @property {string|null} [storagePath]
 * @property {string|null} [storage_path]
 * @property {string|null} [key]
 * @property {string|null} [path]
 * @property {string|null} [sourceType]
 */

const OBSERVATION_IDENTIFICATIONS_MISSING_CACHE_KEY = 'sporely-observation-identifications-missing'
const OBSERVATION_IDENTIFICATIONS_COMMUNITY_VIEW = 'observation_identifications_community_view'
let _observationIdentificationsAvailable = null

function _normalizeText(value) {
  return String(value ?? '').trim()
}

function _normalizeNullableText(value) {
  const text = _normalizeText(value)
  return text ? text : null
}

function _normalizeProbability(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  if (number > 1) return Math.max(0, Math.min(1, number / 100))
  return Math.max(0, Math.min(1, number))
}

function _toFraction(score) {
  return _normalizeProbability(score)
}

function _hasFiniteScore(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function _getPredictionSourceObjects(prediction = {}) {
  return [
    prediction,
    prediction.raw,
    prediction.external_ids,
    prediction.raw?.external_ids,
    prediction.taxon,
    prediction.raw?.taxon,
  ].filter(source => source && typeof source === 'object')
}

function _findPredictionTextValue(prediction = {}, keys = []) {
  for (const source of _getPredictionSourceObjects(prediction)) {
    for (const key of keys) {
      const text = _normalizeNullableText(source?.[key])
      if (text) return text
    }
  }
  return null
}

function _getPredictionTaxon(prediction = {}) {
  return prediction.taxon || prediction.raw?.taxon || null
}

function _getPredictionPictureUrl(prediction = {}) {
  return _findPredictionTextValue(prediction, [
    'picture_url',
    'pictureUrl',
    'picture',
    'photo_url',
    'photoUrl',
    'image_url',
    'imageUrl',
    'thumbnail_url',
    'thumbnailUrl',
    'media_url',
    'mediaUrl',
  ])
}

function _highestPredictionProbability(predictions = []) {
  let highest = null
  for (const prediction of Array.isArray(predictions) ? predictions : []) {
    const value = Number(prediction?.probability)
    if (!Number.isFinite(value)) continue
    if (highest === null || value > highest) {
      highest = value
    }
  }
  return highest
}

export function getIdentifyTopProbability(result = null) {
  if (_hasFiniteScore(result?.topProbability)) {
    return Number(result.topProbability)
  }
  if (_hasFiniteScore(result?.topPrediction?.probability)) {
    return Number(result.topPrediction.probability)
  }
  if (_hasFiniteScore(result?.topScore)) {
    return Number(result.topScore)
  }
  const predictionProbability = _highestPredictionProbability(result?.predictions)
  if (predictionProbability !== null) {
    return predictionProbability
  }
  return _highestPredictionProbability(result?.results)
}

function _selectIdentifySourceBlob(item = null) {
  if (isBlob(item?.originalBlob)) return item.originalBlob
  if (isBlob(item?.sourceBlob)) return item.sourceBlob
  if (isBlob(item?.blob)) return item.blob
  return isBlob(item) ? item : null
}

/**
 * @param {IdentifyImageInput} input
 * @param {number} index
 * @returns {Object}
 */
function _normalizeImageInput(input = {}, index = 0) {
  const cropRect = normalizeAiCropRect(input.cropRect ?? input.aiCropRect ?? null)
  const blob = _selectIdentifySourceBlob(input)
  const mediaKey = _normalizeText(
    input.mediaKey
    || input.media_key
    || input.storagePath
    || input.storage_path
    || input.key
    || input.path
    || ''
  )
  const sourceWidthValue = input.cropSourceW ?? input.cropSourceWidth ?? input.aiCropSourceW
  const sourceHeightValue = input.cropSourceH ?? input.cropSourceHeight ?? input.aiCropSourceH
  const sourceWidth = Number.isFinite(Number(sourceWidthValue))
    ? Number(sourceWidthValue)
    : null
  const sourceHeight = Number.isFinite(Number(sourceHeightValue))
    ? Number(sourceHeightValue)
    : null

  return {
    index,
    mediaKey: mediaKey || null,
    blobType: blob?.type || _normalizeText(input.blobType ?? ''),
    blobSize: Number.isFinite(Number(input.blobSize ?? blob?.size))
      ? Number(input.blobSize ?? blob?.size)
      : null,
    cropRect,
    cropSourceW: sourceWidth,
    cropSourceH: sourceHeight,
    updatedAt: input.updatedAt ?? input.updated_at ?? null,
    sourceType: _normalizeText(input.sourceType || (mediaKey ? 'media' : 'blob')) || null,
  }
}

function _stableFingerprint(payload) {
  return JSON.stringify(payload)
}

function _identifyServiceLabel(service) {
  return normalizeIdentifyService(service) === ID_SERVICE_INATURALIST
    ? (t('settings.idServiceInaturalist') || 'iNaturalist')
    : (t('settings.idServiceArtsorakel') || 'Artsorakel')
}

function _normalizeObservationIdentificationRow(row = {}) {
  const service = normalizeIdentifyService(row.service)
  const results = (Array.isArray(row.results) ? row.results : [])
    .map((result, index) => normalizeStoredIdentificationCandidate(result, service, index))
    .filter(result => result.displayName)
  const top = _getTopIdentifyPrediction(results)
  return {
    ...row,
    service,
    status: row.status || (results.length ? 'success' : 'no_match'),
    results,
    top_probability: row.top_probability ?? top?.probability ?? null,
    top_scientific_name: row.top_scientific_name || top?.scientific_name || top?.scientificName || null,
    top_vernacular_name: row.top_vernacular_name || top?.vernacular_name || top?.vernacularName || null,
    top_taxon_id: row.top_taxon_id || top?.taxon_id || top?.taxonId || null,
    top_species_url: row.top_species_url || top?.species_url || top?.speciesUrl || null,
    top_redlist_category: row.top_redlist_category || top?.redlist_category || top?.redlistCategory || null,
    top_redlist_status: row.top_redlist_status || top?.redlist_status || top?.redlistStatus || null,
    top_redlist_source: row.top_redlist_source || top?.redlist_source || top?.redlistSource || null,
    image_fingerprint: row.image_fingerprint || '',
    crop_fingerprint: row.crop_fingerprint || '',
    request_fingerprint: row.request_fingerprint || '',
    error_message: row.error_message || '',
  }
}

function _isDebugPhotoIdEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.sessionStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.location?.search?.includes('debug_ai_id=1')
  } catch (_) {
    return false
  }
}

function _isMissingObservationIdentificationsTableError(error) {
  const message = String(error?.message || error?.details || error?.hint || '').toLowerCase()
  return (
    error?.code === 'PGRST205'
    || (message.includes('observation_identifications') && (
      message.includes('could not find the table')
      || message.includes('schema cache')
      || message.includes('does not exist')
    ))
  )
}

function _isObservationIdentificationsTableUnavailable() {
  if (_observationIdentificationsAvailable === false) return true
  try {
    if (globalThis.sessionStorage?.getItem(OBSERVATION_IDENTIFICATIONS_MISSING_CACHE_KEY) === 'true') {
      _observationIdentificationsAvailable = false
      return true
    }
  } catch (_) {}
  return false
}

function _markObservationIdentificationsTableMissing() {
  _observationIdentificationsAvailable = false
  try {
    globalThis.sessionStorage?.setItem(OBSERVATION_IDENTIFICATIONS_MISSING_CACHE_KEY, 'true')
  } catch (_) {}
}

export function resetObservationIdentificationsTableAvailabilityForTests() {
  _observationIdentificationsAvailable = null
  try {
    globalThis.sessionStorage?.removeItem(OBSERVATION_IDENTIFICATIONS_MISSING_CACHE_KEY)
  } catch (_) {}
}

export function debugPhotoId(message, details = {}) {
  if (!_isDebugPhotoIdEnabled()) return
  console.debug(`[photo-id] ${message}`, details)
}

export function _renderPieSpinnerIcon(tone = '') {
  return `<span class="ai-id-service-tab-icon ai-pie-spinner ${tone}" aria-hidden="true">
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path class="ai-pie-spinner-fill" pathLength="100" d="M8 4 A4 4 0 1 1 8 12 A4 4 0 1 1 8 4" />
    </svg>
  </span>`
}

export function _renderPieSpinnerDot(tone = '') {
  return `<span class="ai-id-dot ai-pie-spinner ${tone}" aria-hidden="true">
    <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path class="ai-pie-spinner-fill" pathLength="100" d="M8 4 A4 4 0 1 1 8 12 A4 4 0 1 1 8 4" />
    </svg>
  </span>`
}

function _getPredictionName(prediction = {}) {
  const scientificName = _normalizeText(_findPredictionTextValue(prediction, [
    'scientificName',
    'scientific_name',
    'name',
  ]) || '')
  const vernacularName = _normalizeText(_findPredictionTextValue(prediction, [
    'vernacularName',
    'vernacular_name',
    'commonName',
    'common_name',
  ]) || '')
  const displayName = _normalizeText(_findPredictionTextValue(prediction, [
    'displayName',
    'display_name',
  ]) || '')
  return {
    scientificName: scientificName || null,
    vernacularName: vernacularName || null,
    displayName: displayName || vernacularName || scientificName || t('common.unknown'),
  }
}

function _getPredictionRank(prediction = {}, fallbackRank = null) {
  const value = Number(prediction?.rank)
  if (Number.isFinite(value) && value > 0) return Math.floor(value)
  const fallbackValue = Number(fallbackRank)
  if (Number.isFinite(fallbackValue) && fallbackValue > 0) return Math.floor(fallbackValue)
  return null
}

function _getPredictionTaxonId(prediction = {}) {
  return _findPredictionTextValue(prediction, [
    'taxon_id',
    'taxonId',
    'scientific_name_id',
    'scientific_name_id_shared',
    'id',
  ])
}

function _getPredictionSpeciesUrl(service, prediction = {}, taxonId = null) {
  if (normalizeIdentifyService(service) === ID_SERVICE_INATURALIST && taxonId) {
    return `https://www.inaturalist.org/taxa/${taxonId}`
  }
  return _normalizeNullableText(_findPredictionTextValue(prediction, [
    'species_url',
    'speciesUrl',
    'adbUrl',
    'url',
    'href',
    'link',
    'uri',
    'infoUrl',
    'infoURL',
    'info_url',
  ]))
}

function _getPredictionRedlistMetadata(prediction = {}) {
  const taxon = _getPredictionTaxon(prediction)
  return {
    redlistCategory: _normalizeNullableText(
      _findPredictionTextValue(prediction, [
        'redlist_category',
        'redlistCategory',
        'redListCategory',
      ])
      || taxon?.redListCategories?.NO
    ),
    redlistStatus: _normalizeNullableText(
      _findPredictionTextValue(prediction, [
        'redlist_status',
        'redlistStatus',
        'redListStatus',
      ])
    ),
    redlistSource: _normalizeNullableText(
      _findPredictionTextValue(prediction, [
        'redlist_source',
        'redlistSource',
        'redListSource',
      ])
    ),
  }
}

export function normalizeIdentifyPrediction(service, prediction = {}, rank = null) {
  const normalizedService = normalizeIdentifyService(service)
  const probability = _normalizeProbability(
    prediction.probability
    ?? prediction.combined_score
    ?? prediction.vision_score
    ?? prediction.score
  )
  const taxonId = _getPredictionTaxonId(prediction)
  const nameInfo = _getPredictionName(prediction)
  const speciesUrl = _getPredictionSpeciesUrl(normalizedService, prediction, taxonId)
  const redlistMetadata = _getPredictionRedlistMetadata(prediction)

  return {
    service: normalizedService,
    rank: _getPredictionRank(prediction, rank),
    taxonId: taxonId ?? null,
    taxon_id: taxonId ?? null,
    probability,
    confidenceText: `${Math.round(probability * 100)}%`,
    scientificName: nameInfo.scientificName,
    scientific_name: nameInfo.scientificName,
    vernacularName: nameInfo.vernacularName,
    vernacular_name: nameInfo.vernacularName,
    displayName: nameInfo.displayName,
    adbUrl: prediction.adbUrl || prediction.url || prediction.href || speciesUrl || null,
    species_url: speciesUrl,
    speciesUrl,
    redlist_category: redlistMetadata.redlistCategory,
    redlistCategory: redlistMetadata.redlistCategory,
    redlist_status: redlistMetadata.redlistStatus,
    redlistStatus: redlistMetadata.redlistStatus,
    redlist_source: redlistMetadata.redlistSource,
    redlistSource: redlistMetadata.redlistSource,
    taxon: prediction.taxon || null,
    raw: prediction.raw ?? prediction,
    rawScore: prediction.rawScore ?? prediction.score ?? prediction.combined_score ?? prediction.vision_score ?? null,
  }
}

function _getTopIdentifyPrediction(predictions = []) {
  let top = null
  let topRank = null
  for (let index = 0; index < (Array.isArray(predictions) ? predictions.length : 0); index += 1) {
    const prediction = predictions[index]
    if (!prediction) continue
    const rank = _getPredictionRank(prediction, index + 1)
    if (top === null || (rank !== null && (topRank === null || rank < topRank))) {
      top = prediction
      topRank = rank
    }
  }
  return top
}

export function formatAiSuggestionDisplay(prediction = {}) {
  const scientificName = _normalizeText(prediction.scientificName || prediction.scientific_name || prediction.name || '')
  const vernacularName = _normalizeText(prediction.vernacularName || prediction.vernacular_name || prediction.commonName || '')

  if (vernacularName && scientificName && vernacularName.toLowerCase() !== scientificName.toLowerCase()) {
    return {
      title: vernacularName,
      subtitle: scientificName,
    }
  }

  if (vernacularName) {
    return {
      title: vernacularName,
      subtitle: '',
    }
  }

  return {
    title: scientificName || _normalizeText(prediction.displayName || prediction.display_name || '') || t('common.unknown'),
    subtitle: '',
  }
}

function _getPredictionSpeciesLinkUrl(prediction = {}) {
  const service = normalizeIdentifyService(prediction.service)
  const speciesUrl = _normalizeNullableText(
    prediction.speciesUrl
    ?? prediction.species_url
    ?? prediction.adbUrl
    ?? prediction.url
    ?? prediction.href
  )
  if (service === ID_SERVICE_ARTSORAKEL && speciesUrl) {
    return speciesUrl
  }

  if (service === ID_SERVICE_INATURALIST && speciesUrl) {
    return speciesUrl
  }

  const taxonId = _normalizeNullableText(prediction.taxonId ?? prediction.taxon_id)
  if (!taxonId) return null
  if (service === ID_SERVICE_INATURALIST) {
    return `https://www.inaturalist.org/taxa/${encodeURIComponent(taxonId)}`
  }
  return null
}

function _getPredictionSpeciesLinkLabel(prediction = {}) {
  const service = normalizeIdentifyService(prediction.service)
  return service === ID_SERVICE_INATURALIST
    ? 'Open iNaturalist taxon'
    : 'Open Artsobservasjoner taxon'
}

function renderIdentifyResultSpeciesLink(prediction = {}) {
  const url = _getPredictionSpeciesLinkUrl(prediction)
  if (!url) return ''
  const label = _getPredictionSpeciesLinkLabel(prediction)
  return `
    <a
      class="ai-result-row-link"
      href="${_esc(url)}"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="${_esc(label)}"
      title="${_esc(label)}"
    >
      <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <path d="M5 3H3v10h10V9" />
        <path d="M8 8l6-6" />
        <path d="M10 2h4v4" />
      </svg>
    </a>
  `
}

export function _renderServiceIcon(serviceState = {}) {
  const status = serviceState.status || 'idle'
  const showCheckmark = serviceState.showCheckmark ?? (status === 'success' || status === 'stale')
  const probability = _hasFiniteScore(serviceState.displayProbability)
    ? Number(serviceState.displayProbability)
    : getIdentifyTopProbability(serviceState)
  const confidence = probability !== null
    ? getIdentifyConfidenceState(probability)
    : null
  const toneClass = confidence?.tone ? ` ${confidence.tone}` : ''
  if (status === 'running') {
    return _renderPieSpinnerIcon()
  }
  if (status === 'success' || status === 'stale') {
    if (!showCheckmark) {
      return `<span class="ai-id-service-tab-icon ai-id-service-tab-icon-dot${toneClass}" aria-hidden="true"></span>`
    }
    return `
      <span class="ai-id-service-tab-icon ai-id-service-tab-icon-check${toneClass}" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
          <path d="M4 8 L7 11 L13 4" />
        </svg>
      </span>
    `
  }
  if (status === 'no_match' || status === 'error') {
    return `
      <span class="ai-id-service-tab-icon ai-id-service-tab-icon-x ${status === 'error' ? 'is-error' : ''}" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
          <path d="M4 4 12 12M12 4 4 12" />
        </svg>
      </span>
    `
  }
  if (serviceState.available === false) {
    return `<span class="ai-id-service-tab-icon ai-id-service-tab-icon-dot is-unavailable" aria-hidden="true"></span>`
  }
  return `<span class="ai-id-service-tab-icon ai-id-service-tab-icon-dot${toneClass}" aria-hidden="true"></span>`
}

export function getIdentifyConfidenceState(score, options = {}) {
  const value = _toFraction(score)
  const lowThreshold = Number.isFinite(Number(options.lowThreshold)) ? Number(options.lowThreshold) : 0.4
  const warnThreshold = Number.isFinite(Number(options.warnThreshold)) ? Number(options.warnThreshold) : 0.6
  const checkThreshold = Number.isFinite(Number(options.checkThreshold)) ? Number(options.checkThreshold) : 0.65

  if (value >= checkThreshold) {
    return { tone: 'is-good', icon: 'check', value }
  }
  if (value < lowThreshold) {
    return { tone: 'is-low', icon: 'dot', value }
  }
  if (value < warnThreshold) {
    return { tone: 'is-warn', icon: 'dot', value }
  }
  return { tone: 'is-good', icon: 'dot', value }
}

export function renderIdentifyConfidenceBadge(score, options = {}) {
  const confidence = getIdentifyConfidenceState(score, options)
  const percent = `${Math.round(confidence.value * 100)}%`
  if (confidence.icon === 'check') {
    return `
      <span class="ai-confidence-badge ${confidence.tone}" aria-hidden="true">
        <span class="ai-confidence-badge-icon ai-confidence-badge-icon-check">
          <svg viewBox="0 0 16 16" focusable="false" aria-hidden="true">
            <path d="M3.2 8.7 6.3 11.8 12.8 4.8" />
          </svg>
        </span>
        <span class="ai-confidence-badge-value">${_esc(percent)}</span>
      </span>
    `
  }
  return `
    <span class="ai-confidence-badge ${confidence.tone}" aria-hidden="true">
      <span class="ai-confidence-badge-value">${_esc(percent)}</span>
    </span>
  `
}

export function normalizeIdentifyRunResult(service, predictions = [], metadata = {}) {
  const normalizedService = normalizeIdentifyService(service)
  const normalizedPredictions = (Array.isArray(predictions) ? predictions : [])
    .map((prediction, index) => normalizeIdentifyPrediction(normalizedService, prediction, index + 1))
    .filter(prediction => prediction.displayName)

  const top = _getTopIdentifyPrediction(normalizedPredictions)
  const status = metadata.status
    || (metadata.errorMessage ? 'error' : (normalizedPredictions.length ? 'success' : 'no_match'))

  return {
    service: normalizedService,
    status,
    predictions: normalizedPredictions,
    predictionCount: normalizedPredictions.length,
    topPrediction: top,
    topProbability: top?.probability ?? null,
    topScientificName: top?.scientificName ?? null,
    topVernacularName: top?.vernacularName ?? null,
    topTaxonId: top?.taxonId ?? null,
    topSpeciesUrl: top?.species_url ?? top?.speciesUrl ?? null,
    topRedlistCategory: top?.redlist_category ?? top?.redlistCategory ?? null,
    topRedlistStatus: top?.redlist_status ?? top?.redlistStatus ?? null,
    topRedlistSource: top?.redlist_source ?? top?.redlistSource ?? null,
    errorMessage: metadata.errorMessage || null,
    unavailableReason: metadata.unavailableReason || null,
    language: metadata.language || null,
    modelVersion: metadata.modelVersion || null,
    imageFingerprint: metadata.imageFingerprint || null,
    cropFingerprint: metadata.cropFingerprint || null,
    requestFingerprint: metadata.requestFingerprint || null,
    results: normalizedPredictions,
  }
}

export function buildIdentifyFingerprint(inputs = {}) {
  const service = normalizeIdentifyService(inputs.service)
  const language = _normalizeText(inputs.language || 'en') || 'en'
  const observationId = inputs.observationId ?? null
  const maxEdge = Number.isFinite(Number(inputs.maxEdge)) ? Number(inputs.maxEdge) : null
  const preprocessVersion = Number.isFinite(Number(inputs.preprocessVersion))
    ? Number(inputs.preprocessVersion)
    : 2
  const images = (inputs.images || inputs.inputs || [])
    .map((item, index) => _normalizeImageInput(item, index))

  const imageFingerprint = _stableFingerprint({
    service,
    observationId,
    language,
    maxEdge,
    preprocessVersion,
    images: images.map(image => ({
      id: image.id,
      mediaKey: image.mediaKey,
      blobType: image.blobType,
      blobSize: image.blobSize,
      updatedAt: image.updatedAt,
    })),
  })

  const cropFingerprint = _stableFingerprint({
    service,
    preprocessVersion,
    images: images.map(image => ({
      cropRect: image.cropRect,
      cropSourceW: image.cropSourceW,
      cropSourceH: image.cropSourceH,
    })),
  })

  const requestFingerprint = _stableFingerprint({
    service,
    observationId,
    language,
    maxEdge,
    preprocessVersion,
    imageFingerprint,
    cropFingerprint,
  })

  return {
    service,
    observationId,
    language,
    maxEdge,
    preprocessVersion,
    images,
    imageFingerprint,
    cropFingerprint,
    requestFingerprint,
  }
}

export async function getIdentifyServiceAvailability(context = {}) {
  const blobs = Array.isArray(context.blobs)
    ? context.blobs.map(item => _selectIdentifySourceBlob(item)).filter(isBlob)
    : []
  const mediaKeys = Array.isArray(context.mediaKeys)
    ? context.mediaKeys.map(value => _normalizeText(value)).filter(Boolean)
    : []
  const hasArtsorakelInput = blobs.length > 0 || mediaKeys.length > 0
  const session = context.inaturalistSession ?? await loadInaturalistSession(context.inaturalistStorage)
  const inatConnected = Boolean(session?.connected && _normalizeText(session?.api_token || session?.apiToken))
  const inatReason = inatConnected ? '' : (t('settings.inaturalistLoginMissing') || 'Please log in to iNaturalist first.')

  return {
    artsorakel: {
      service: ID_SERVICE_ARTSORAKEL,
      available: hasArtsorakelInput,
      disabled: !hasArtsorakelInput,
      reason: hasArtsorakelInput ? '' : (t('detail.noPhotoToIdentify') || t('review.noCaptures') || 'No images available.'),
    },
    inat: {
      service: ID_SERVICE_INATURALIST,
      available: inatConnected,
      disabled: !inatConnected,
      reason: inatReason,
    },
  }
}

export async function getAvailableIdentifyServices(context = {}) {
  const availability = await getIdentifyServiceAvailability(context)
  return [availability.artsorakel, availability.inat]
}

export function chooseIdentifyComparisonActiveService(resultsByService = {}, defaultService = getDefaultIdService()) {
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

export function isTerminalAiServiceState(serviceState = null) {
  return ['success', 'no_match', 'error', 'unavailable'].includes(serviceState?.status)
}

export function shouldRunServiceFromTab(serviceState = null) {
  return !serviceState || serviceState.status === 'idle' || serviceState.status === 'stale'
}

export function canViewServiceResult(serviceState = null) {
  return Boolean(
    serviceState?.canView
    || ['success', 'no_match', 'error', 'stale', 'unavailable'].includes(serviceState?.status)
    || Array.isArray(serviceState?.predictions) && serviceState.predictions.length > 0
    || serviceState?.status === 'running'
    || serviceState?.active
  )
}

export function canRunService(serviceState = null) {
  if (typeof serviceState?.canRun === 'boolean') return serviceState.canRun
  return serviceState?.available !== false && shouldRunServiceFromTab(serviceState)
}

export function markRequestedServicesRunning(existingResults = {}, availability = {}, requestedServices = []) {
  const requested = new Set(
    (Array.isArray(requestedServices) ? requestedServices : [])
      .map(service => normalizeIdentifyService(service)),
  )
  const next = {}
  for (const service of [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]) {
    const existing = existingResults?.[service] || {}
    const serviceAvailability = availability?.[service] || {}
    const available = serviceAvailability.available ?? existing.available ?? false
    const reason = serviceAvailability.reason || existing.reason || ''
    const isRequested = requested.has(service)
    const status = isRequested
      ? (available ? 'running' : 'unavailable')
      : (existing.status || (available ? 'idle' : 'unavailable'))
    next[service] = {
      ...existing,
      service,
      available,
      reason,
      status,
      errorMessage: isRequested
        ? (available ? '' : (existing.errorMessage || reason || ''))
        : (existing.errorMessage || ''),
    }
  }
  return next
}

function _buildServiceOptions(service, options = {}) {
  const language = options.language || 'en'
  const shared = {
    language,
    storage: options.storage,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    onImageSent: options.onImageSent,
    onIdReceived: options.onIdReceived,
    screen: options.screen,
    tolerateFailures: true,
  }

  if (service === ID_SERVICE_ARTSORAKEL) {
    return {
      ...shared,
      maxEdge: options.maxEdge,
    }
  }
  return shared
}

async function _runIdentifyService(service, context = {}) {
  const normalizedService = normalizeIdentifyService(service)
  const availabilityMap = context.availability || await getIdentifyServiceAvailability(context)
  const availability = availabilityMap[normalizedService]
  if (!availability?.available) {
    return {
      ...normalizeIdentifyRunResult(normalizedService, [], {
        status: 'unavailable',
        unavailableReason: availability?.reason || '',
        language: context.language || 'en',
      }),
      available: false,
    }
  }

  const language = context.language || 'en'
  const blobs = Array.isArray(context.blobs) ? context.blobs : []
  const mediaKeys = Array.isArray(context.mediaKeys) ? context.mediaKeys : []
  const identifyBlobs = context.identifyBlobs || runIdentifyForBlobs
  const identifyMediaKeys = context.identifyMediaKeys || runIdentifyForMediaKeys

  if (normalizedService === ID_SERVICE_INATURALIST && !blobs.length) {
    return {
      ...normalizeIdentifyRunResult(normalizedService, [], {
        status: 'unavailable',
        unavailableReason: availability.reason || (t('detail.noPhotoToIdentify') || 'No images available.'),
        language,
      }),
      available: false,
    }
  }

  try {
    let predictions = []
    if (normalizedService === ID_SERVICE_ARTSORAKEL && !blobs.length && mediaKeys.length) {
      predictions = await identifyMediaKeys(mediaKeys, normalizedService, language, _buildServiceOptions(normalizedService, context))
    } else if (normalizedService === ID_SERVICE_ARTSORAKEL) {
      predictions = await identifyBlobs(blobs, normalizedService, language, _buildServiceOptions(normalizedService, context))
    } else {
      predictions = await identifyBlobs(blobs, normalizedService, language, _buildServiceOptions(normalizedService, context))
    }
    return normalizeIdentifyRunResult(normalizedService, predictions, {
      status: Array.isArray(predictions) && predictions.length ? 'success' : 'no_match',
      language,
    })
  } catch (error) {
    return normalizeIdentifyRunResult(normalizedService, [], {
      status: 'error',
      errorMessage: String(error?.message || error || 'Unknown error'),
      language,
    })
  }
}

export async function runIdentifyComparisonForBlobs(blobs, options = {}) {
  const normalizedBlobs = (Array.isArray(blobs) ? blobs : []).filter(item => _selectIdentifySourceBlob(item))
  const serviceAvailability = options.availability || await getIdentifyServiceAvailability({
    blobs: normalizedBlobs,
    mediaKeys: options.mediaKeys || [],
    inaturalistSession: options.inaturalistSession,
    inaturalistStorage: options.inaturalistStorage,
  })
  const services = (options.services || [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST])
    .map(service => normalizeIdentifyService(service))
    .filter((service, index, list) => list.indexOf(service) === index)

  const tasks = services.map(async service => {
    const result = await _runIdentifyService(service, {
      ...options,
      availability: serviceAvailability,
      blobs: normalizedBlobs,
      mediaKeys: options.mediaKeys || [],
      language: options.language || 'en',
    })
    options.onServiceState?.(result)
    return result
  })

  const settled = await Promise.allSettled(tasks)
  const resultsByService = {}
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value?.service) {
      resultsByService[item.value.service] = item.value
    }
  }

  const activeService = chooseIdentifyComparisonActiveService(resultsByService, options.defaultService || getDefaultIdService())
  return {
    activeService,
    resultsByService,
    availability: serviceAvailability,
  }
}

export async function runIdentifyComparisonForMediaKeys(mediaKeys, options = {}) {
  const normalizedMediaKeys = Array.isArray(mediaKeys)
    ? mediaKeys.map(value => _normalizeText(value)).filter(Boolean)
    : []
  return runIdentifyComparisonForBlobs(options.blobs || [], {
    ...options,
    mediaKeys: normalizedMediaKeys,
  })
}

export async function loadObservationIdentifications(observationId, options = {}) {
  if (!observationId) return []
  if (_isObservationIdentificationsTableUnavailable()) return []
  const client = options.supabaseClient || defaultSupabase
  try {
    const readRows = table => client
      .from(table)
      .select('*')
      .eq('observation_id', observationId)
      .order('created_at', { ascending: false })

    const communityRes = await readRows(OBSERVATION_IDENTIFICATIONS_COMMUNITY_VIEW)
    if (!communityRes.error) {
      return (Array.isArray(communityRes.data) ? communityRes.data : []).map(_normalizeObservationIdentificationRow)
    }

    const fallbackRes = await readRows('observation_identifications')
    if (fallbackRes.error) {
      if (_isMissingObservationIdentificationsTableError(fallbackRes.error)) {
        _markObservationIdentificationsTableMissing()
        return []
      }
      throw fallbackRes.error
    }
    return (Array.isArray(fallbackRes.data) ? fallbackRes.data : []).map(_normalizeObservationIdentificationRow)
  } catch (error) {
    if (_isMissingObservationIdentificationsTableError(error)) {
      _markObservationIdentificationsTableMissing()
      return []
    }
    throw error
  }
}

export async function maybeLoadCachedIdentification({
  observationId,
  service,
  requestFingerprint,
  supabaseClient = defaultSupabase,
} = {}) {
  if (!observationId || !requestFingerprint) return null
  if (_isObservationIdentificationsTableUnavailable()) return null
  const normalizedService = normalizeIdentifyService(service)
  try {
    const readRow = table => supabaseClient
      .from(table)
      .select('*')
      .eq('observation_id', observationId)
      .eq('service', normalizedService)
      .eq('request_fingerprint', requestFingerprint)
      .maybeSingle()

    const communityRes = await readRow(OBSERVATION_IDENTIFICATIONS_COMMUNITY_VIEW)
    if (!communityRes.error) {
      return communityRes.data ? _normalizeObservationIdentificationRow(communityRes.data) : null
    }

    const fallbackRes = await readRow('observation_identifications')
    if (fallbackRes.error) {
      if (_isMissingObservationIdentificationsTableError(fallbackRes.error)) {
        _markObservationIdentificationsTableMissing()
        return null
      }
      throw fallbackRes.error
    }
    return fallbackRes.data ? _normalizeObservationIdentificationRow(fallbackRes.data) : null
  } catch (error) {
    if (_isMissingObservationIdentificationsTableError(error)) {
      _markObservationIdentificationsTableMissing()
      return null
    }
    throw error
  }
}

export function markIdentificationStaleIfFingerprintChanged(rows = [], currentFingerprint = '') {
  const fingerprint = _normalizeText(currentFingerprint)
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (!row) return row
    if (_normalizeText(row.request_fingerprint) === fingerprint) return row
    if (row.status === 'stale') return row
    return { ...row, status: 'stale' }
  })
}

function _stripIdentifierNamespace(value, namespace) {
  const text = _normalizeText(value)
  if (!text) return null
  const prefix = `${_normalizeText(namespace)}:`
  if (!prefix || text.length <= prefix.length) return text
  return text.toLowerCase().startsWith(prefix.toLowerCase())
    ? _normalizeText(text.slice(prefix.length))
    : text
}

function _normalizeExternalIdentifierValue(value, namespace, taxonId) {
  const text = _normalizeNullableText(value)
  if (!text) return null
  const normalizedValue = namespace ? _stripIdentifierNamespace(text, namespace) : text
  if (!normalizedValue) return null
  const normalizedTaxonId = _normalizeText(taxonId).toLowerCase()
  if (normalizedTaxonId && normalizedValue.toLowerCase() === normalizedTaxonId) return null
  return normalizedValue
}

function _normalizeGbifExternalIdentifierValue(value, taxonId) {
  const normalizedValue = _normalizeExternalIdentifierValue(value, 'gbif', taxonId)
  return normalizedValue && /^\d+$/.test(normalizedValue) ? normalizedValue : null
}

function _buildStoredIdentificationExternalIds(candidate = {}, service = null, taxonId = null) {
  const normalizedService = normalizeIdentifyService(service || candidate.service)
  const externalIds = {}
  const setExternalId = (key, value, namespace = key) => {
    const normalizedValue = _normalizeExternalIdentifierValue(value, namespace, taxonId)
    if (normalizedValue) externalIds[key] = normalizedValue
  }

  const gbifValue = _normalizeGbifExternalIdentifierValue(_findPredictionTextValue(candidate, [
    'gbif',
    'gbif_id',
    'gbifId',
    'scientific_name_id_shared',
  ]), taxonId)
  if (gbifValue) externalIds.gbif = gbifValue

  if (normalizedService !== ID_SERVICE_INATURALIST) {
    setExternalId('inat', _findPredictionTextValue(candidate, [
      'inat',
      'inat_id',
      'inatId',
      'inaturalist_taxon_id',
      'inaturalistTaxonId',
    ]), 'inat')
  }

  if (!_normalizeText(taxonId).toLowerCase().startsWith('nbic:')) {
    setExternalId('nbic', _findPredictionTextValue(candidate, [
      'nbic',
      'nbic_id',
      'nbicId',
      'scientific_name_id',
    ]), 'nbic')
  }

  return externalIds
}

function normalizeStoredIdentificationCandidate(candidate = {}, service = null, index = 0) {
  return normalizeIdentifyPrediction(
    normalizeIdentifyService(service || candidate.service),
    candidate,
    index + 1,
  )
}

function compactIdentificationCandidate(candidate = {}, service = null, index = 0) {
  const normalized = normalizeStoredIdentificationCandidate(candidate, service, index)
  const taxonId = _normalizeNullableText(normalized.taxon_id ?? normalized.taxonId)
  const scientificName = _normalizeNullableText(normalized.scientific_name ?? normalized.scientificName)
  const vernacularName = _normalizeNullableText(normalized.vernacular_name ?? normalized.vernacularName)
  const speciesUrl = _normalizeNullableText(normalized.species_url ?? normalized.speciesUrl)
  const redlistCategory = _normalizeNullableText(normalized.redlist_category ?? normalized.redlistCategory)
  const redlistStatus = _normalizeNullableText(normalized.redlist_status ?? normalized.redlistStatus)
  const redlistSource = _normalizeNullableText(normalized.redlist_source ?? normalized.redlistSource)
  const pictureUrl = _getPredictionPictureUrl(candidate)
  const probability = Number(normalized.probability)
  const compacted = {
    rank: Number.isFinite(Number(normalized.rank)) ? Number(normalized.rank) : index + 1,
    service: normalized.service,
  }

  if (taxonId) compacted.taxon_id = taxonId
  if (scientificName) compacted.scientific_name = scientificName
  if (vernacularName) compacted.vernacular_name = vernacularName
  if (Number.isFinite(probability)) compacted.probability = probability
  if (speciesUrl) compacted.species_url = speciesUrl
  if (redlistCategory) compacted.redlist_category = redlistCategory
  if (redlistStatus) compacted.redlist_status = redlistStatus
  if (redlistSource) compacted.redlist_source = redlistSource
  if (pictureUrl) compacted.picture_url = pictureUrl

  const externalIds = _buildStoredIdentificationExternalIds(candidate, normalized.service, taxonId)
  if (Object.keys(externalIds).length) compacted.external_ids = externalIds

  return compacted
}

export async function saveIdentificationRun({
  observationId,
  userId,
  service,
  requestFingerprint,
  imageFingerprint,
  cropFingerprint,
  language,
  modelVersion = null,
  status = 'success',
  results = [],
  errorMessage = null,
  topPrediction = null,
  supabaseClient = defaultSupabase,
} = {}) {
  if (!observationId || !userId || !requestFingerprint) return null
  if (_isObservationIdentificationsTableUnavailable()) return null

  const normalizedService = normalizeIdentifyService(service)
  try {
    const normalizedResult = normalizeIdentifyRunResult(normalizedService, results, {
      status,
      errorMessage,
      language,
      modelVersion,
      imageFingerprint,
      cropFingerprint,
      requestFingerprint,
    })
    const compactedResults = normalizedResult.results.map((result, index) =>
      compactIdentificationCandidate(result, normalizedService, index),
    )
    const topResult = _getTopIdentifyPrediction(compactedResults)
    const payload = {
      observation_id: observationId,
      user_id: userId,
      service: normalizedService,
      source: 'ai',
      status: normalizedResult.status,
      image_fingerprint: imageFingerprint || '',
      crop_fingerprint: cropFingerprint || null,
      request_fingerprint: requestFingerprint,
      language: language || null,
      model_version: modelVersion || null,
      results: compactedResults,
      top_scientific_name: topResult?.scientific_name || null,
      top_vernacular_name: topResult?.vernacular_name || null,
      top_taxon_id: topResult?.taxon_id || null,
      top_probability: topResult?.probability ?? null,
      top_species_url: topResult?.species_url || null,
      top_redlist_category: topResult?.redlist_category || null,
      top_redlist_status: topResult?.redlist_status || null,
      top_redlist_source: topResult?.redlist_source || null,
      error_message: errorMessage || null,
      updated_at: new Date().toISOString(),
    }

    const { data: existing, error: loadError } = await supabaseClient
      .from('observation_identifications')
      .select('id')
      .eq('observation_id', observationId)
      .eq('service', normalizedService)
      .eq('request_fingerprint', requestFingerprint)
      .maybeSingle()
    if (loadError) throw loadError

    if (existing?.id) {
      const { data, error } = await supabaseClient
        .from('observation_identifications')
        .update(payload)
        .eq('id', existing.id)
        .select('*')
        .maybeSingle()
      if (error) throw error
      return data || null
    }

    const { error: staleError } = await supabaseClient
      .from('observation_identifications')
      .update({ status: 'stale', updated_at: new Date().toISOString() })
      .eq('observation_id', observationId)
      .eq('service', normalizedService)
      .neq('request_fingerprint', requestFingerprint)
    if (staleError) throw staleError

    const { data, error } = await supabaseClient
      .from('observation_identifications')
      .insert(payload)
      .select('*')
      .maybeSingle()
    if (error) throw error
    return data || null
  } catch (error) {
    if (_isMissingObservationIdentificationsTableError(error)) {
      _markObservationIdentificationsTableMissing()
      if (_isDebugPhotoIdEnabled()) {
        console.debug('[photo-id] skipping observation_identifications write; table is unavailable', {
          observationId,
          service: normalizedService,
        })
      }
      return null
    }
    throw error
  }
}

export function renderIdentifyServiceTab(serviceState = {}, options = {}) {
  const service = normalizeIdentifyService(serviceState.service)
  const label = _identifyServiceLabel(service)
  const canView = canViewServiceResult(serviceState)
  const canRun = canRunService(serviceState)
  const isDisabled = !canView && !canRun
  const statusClass = [
    'ai-id-service-tab',
    serviceState.active ? 'is-active' : '',
    isDisabled ? 'is-disabled' : '',
    serviceState.status === 'running' ? 'is-running' : '',
    serviceState.status === 'success' || serviceState.status === 'no_match' || serviceState.status === 'stale' ? 'has-results' : '',
    serviceState.status === 'error' ? 'has-error' : '',
  ].filter(Boolean).join(' ')
  const explicitDisplayProbability = _hasFiniteScore(serviceState.displayProbability)
    ? Number(serviceState.displayProbability)
    : null
  const topProbability = getIdentifyTopProbability(serviceState)
  const badgeProbability = explicitDisplayProbability ?? topProbability
  const confidence = getIdentifyConfidenceState(badgeProbability ?? 0, { checkThreshold: 0.65 })
  const shouldShowScore = explicitDisplayProbability !== null || serviceState.status === 'success' || serviceState.status === 'stale'
  const stateLabel = shouldShowScore && badgeProbability !== null
    ? `${Math.round(Number(badgeProbability) * 100)}%`
    : ''
  const scoreMarkup = stateLabel && badgeProbability !== null
    ? renderIdentifyConfidenceBadge(badgeProbability, { checkThreshold: 0.65 })
    : ''
  const scoreToneClass = stateLabel && confidence.tone ? ` ${confidence.tone}` : ''
  return `
    <button
      type="button"
      class="${statusClass}"
      data-identify-service-tab="${service}"
      ${options.sid != null ? `data-sid="${_esc(options.sid)}"` : ''}
      title="${_esc(serviceState.available === false ? (serviceState.reason || options.unavailableReason || '') : (serviceState.errorMessage || ''))}"
      ${isDisabled ? 'disabled aria-disabled="true"' : 'aria-disabled="false"'}
    >
      ${_renderServiceIcon(serviceState)}
      <span class="ai-id-service-tab-label">${_esc(label)}</span>
      <span class="ai-id-service-tab-score${scoreToneClass}"${stateLabel ? '' : ' style="display:none"'}>${scoreMarkup}</span>
    </button>
  `
}

export function renderIdentifyServiceStateSummary(serviceState = {}, options = {}) {
  const service = normalizeIdentifyService(serviceState.service)
  const label = _identifyServiceLabel(service)
  const statusClass = [
    'ai-id-service-state',
    serviceState.active ? 'is-active' : '',
    serviceState.available === false ? 'is-disabled' : '',
    serviceState.status === 'running' ? 'is-running' : '',
    serviceState.status === 'success' || serviceState.status === 'no_match' || serviceState.status === 'stale' ? 'has-results' : '',
    serviceState.status === 'error' ? 'has-error' : '',
  ].filter(Boolean).join(' ')
  const explicitDisplayProbability = _hasFiniteScore(serviceState.displayProbability)
    ? Number(serviceState.displayProbability)
    : null
  const topProbability = getIdentifyTopProbability(serviceState)
  const badgeProbability = explicitDisplayProbability ?? topProbability
  const confidence = getIdentifyConfidenceState(badgeProbability ?? 0, { checkThreshold: 0.65 })
  const shouldShowScore = explicitDisplayProbability !== null || serviceState.status === 'success' || serviceState.status === 'stale'
  const stateLabel = shouldShowScore && badgeProbability !== null
    ? `${Math.round(Number(badgeProbability) * 100)}%`
    : ''
  return `
    <span
      class="${statusClass}"
      title="${_esc(serviceState.available === false ? (serviceState.reason || options.unavailableReason || '') : (serviceState.errorMessage || ''))}"
    >
      ${_renderServiceIcon(serviceState)}
      <span class="ai-id-service-state-label">${_esc(label)}</span>
      ${stateLabel && badgeProbability !== null ? `<span class="ai-id-service-state-score ${confidence.tone}">${_esc(stateLabel)}</span>` : ''}
    </span>
  `
}

export function renderIdentifyResultRows(service, predictions = []) {
  const normalizedService = normalizeIdentifyService(service)
  return (Array.isArray(predictions) ? predictions : [])
    .map(prediction => normalizeIdentifyPrediction(normalizedService, prediction))
    .map(prediction => `
      <div class="ai-result-row">
        <button type="button" class="ai-result-row-button" data-identify-result='${JSON.stringify(prediction).replace(/'/g, '&#39;')}'>
          <span class="ai-result-row-main">
            ${(() => {
              const display = formatAiSuggestionDisplay(prediction)
              return `
                <span class="ai-result-row-name">${_esc(display.title)}</span>
                ${display.subtitle ? `<span class="ai-result-row-sci">${_esc(display.subtitle)}</span>` : ''}
              `
            })()}
          </span>
        </button>
        <span class="ai-result-row-meta">
          ${renderIdentifyResultSpeciesLink(prediction)}
          <span class="ai-result-row-score">${renderIdentifyConfidenceBadge(prediction.probability, { checkThreshold: 0.65 })}</span>
        </span>
      </div>
    `)
    .join('')
}

export function wireIdentifyRunButtonPressFeedback(button) {
  if (!button || button._identifyRunPressWired) return
  button._identifyRunPressWired = true

  let releaseTimer = null

  const clearTimer = () => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
  }

  const clearPressed = () => {
    clearTimer()
    button.classList.remove('is-pressed')
  }

  const markPressed = () => {
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return
    clearTimer()
    button.classList.add('is-pressed')
  }

  const scheduleRelease = () => {
    clearTimer()
    releaseTimer = setTimeout(() => {
      releaseTimer = null
      if (button.classList.contains('is-running')) return
      button.classList.remove('is-pressed')
    }, 160)
  }

  button.addEventListener('pointerdown', markPressed)
  button.addEventListener('pointerup', scheduleRelease)
  button.addEventListener('pointercancel', clearPressed)
  button.addEventListener('blur', clearPressed)
  button.addEventListener('keydown', event => {
    if (event.repeat) return
    if (event.key !== ' ' && event.key !== 'Enter') return
    markPressed()
  })
  button.addEventListener('keyup', event => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    scheduleRelease()
  })
}

export {
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
}
