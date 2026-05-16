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
import { esc as _esc } from './esc.js'

function _isBlob(value) {
  return value instanceof Blob || (value && typeof value.size === 'number' && typeof value.type === 'string')
}

function _normalizeText(value) {
  return String(value ?? '').trim()
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

function _normalizeImageInput(input = {}, index = 0) {
  const cropRect = normalizeAiCropRect(input.cropRect ?? input.aiCropRect ?? null)
  const blob = _isBlob(input.blob) ? input.blob : null
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

function _isDebugPhotoIdEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.sessionStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.location?.search?.includes('debug_ai_id=1')
  } catch (_) {
    return false
  }
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
  const scientificName = _normalizeText(prediction.scientificName || prediction.scientific_name || prediction.name || '')
  const vernacularName = _normalizeText(prediction.vernacularName || prediction.vernacular_name || prediction.commonName || '')
  const displayName = _normalizeText(prediction.displayName || prediction.display_name || '')
  return {
    scientificName: scientificName || null,
    vernacularName: vernacularName || null,
    displayName: displayName || vernacularName || scientificName || t('common.unknown'),
  }
}

export function normalizeIdentifyPrediction(service, prediction = {}) {
  const normalizedService = normalizeIdentifyService(service)
  const probability = _normalizeProbability(
    prediction.probability
    ?? prediction.combined_score
    ?? prediction.vision_score
    ?? prediction.score
  )
  const taxonId = prediction.taxonId ?? prediction.taxon_id ?? prediction.taxon?.id ?? prediction.id ?? null
  const nameInfo = _getPredictionName(prediction)

  return {
    service: normalizedService,
    taxonId: taxonId ?? null,
    probability,
    confidenceText: `${Math.round(probability * 100)}%`,
    scientificName: nameInfo.scientificName,
    vernacularName: nameInfo.vernacularName,
    displayName: nameInfo.displayName,
    adbUrl: prediction.adbUrl || prediction.url || prediction.href || null,
    taxon: prediction.taxon || null,
    rawScore: prediction.rawScore ?? prediction.score ?? prediction.combined_score ?? prediction.vision_score ?? null,
  }
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

export function _renderServiceIcon(serviceState = {}) {
  const status = serviceState.status || 'idle'
  if (status === 'running') {
    return _renderPieSpinnerIcon()
  }
  if (status === 'success' || status === 'stale') {
    return `
      <span class="ai-id-service-tab-icon ai-id-service-tab-icon-check" aria-hidden="true">
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
  return `<span class="ai-id-service-tab-icon ai-id-service-tab-icon-dot" aria-hidden="true"></span>`
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
    .map(prediction => normalizeIdentifyPrediction(normalizedService, prediction))
    .filter(prediction => prediction.displayName)

  const top = normalizedPredictions[0] || null
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
  const images = (inputs.images || inputs.inputs || [])
    .map((item, index) => _normalizeImageInput(item, index))

  const imageFingerprint = _stableFingerprint({
    service,
    observationId,
    language,
    maxEdge,
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
    imageFingerprint,
    cropFingerprint,
  })

  return {
    service,
    observationId,
    language,
    maxEdge,
    images,
    imageFingerprint,
    cropFingerprint,
    requestFingerprint,
  }
}

export async function getIdentifyServiceAvailability(context = {}) {
  const blobs = Array.isArray(context.blobs) ? context.blobs.filter(_isBlob) : []
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
    const probability = Number(resultsByService[service]?.topProbability ?? -1)
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
  const normalizedBlobs = (Array.isArray(blobs) ? blobs : []).map(item => _isBlob(item) ? item : item?.blob).filter(_isBlob)
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
  const client = options.supabaseClient || defaultSupabase
  const { data, error } = await client
    .from('observation_identifications')
    .select('*')
    .eq('observation_id', observationId)
    .order('created_at', { ascending: false })

  if (error) {
    throw error
  }
  return Array.isArray(data) ? data : []
}

export async function maybeLoadCachedIdentification({
  observationId,
  service,
  requestFingerprint,
  supabaseClient = defaultSupabase,
} = {}) {
  if (!observationId || !requestFingerprint) return null
  const normalizedService = normalizeIdentifyService(service)
  const { data, error } = await supabaseClient
    .from('observation_identifications')
    .select('*')
    .eq('observation_id', observationId)
    .eq('service', normalizedService)
    .eq('request_fingerprint', requestFingerprint)
    .maybeSingle()
  if (error) throw error
  return data || null
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

  const normalizedService = normalizeIdentifyService(service)
  const normalizedResult = normalizeIdentifyRunResult(normalizedService, results, {
    status,
    errorMessage,
    language,
    modelVersion,
    imageFingerprint,
    cropFingerprint,
    requestFingerprint,
  })
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
    results: normalizedResult.results,
    top_scientific_name: topPrediction?.scientificName || normalizedResult.topScientificName || null,
    top_vernacular_name: topPrediction?.vernacularName || normalizedResult.topVernacularName || null,
    top_taxon_id: topPrediction?.taxonId || normalizedResult.topTaxonId || null,
    top_probability: topPrediction?.probability ?? normalizedResult.topProbability ?? null,
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
}

export function renderIdentifyServiceTab(serviceState = {}, options = {}) {
  const service = normalizeIdentifyService(serviceState.service)
  const label = _identifyServiceLabel(service)
  const statusClass = [
    'ai-id-service-tab',
    serviceState.active ? 'is-active' : '',
    serviceState.available === false ? 'is-disabled' : '',
    serviceState.status === 'running' ? 'is-running' : '',
    serviceState.status === 'success' || serviceState.status === 'no_match' || serviceState.status === 'stale' ? 'has-results' : '',
    serviceState.status === 'error' ? 'has-error' : '',
  ].filter(Boolean).join(' ')
  const topProbability = Number(serviceState.topProbability ?? serviceState.topScore ?? 0)
  const confidence = getIdentifyConfidenceState(topProbability, { checkThreshold: 0.65 })
  const stateLabel = (serviceState.status === 'success' || serviceState.status === 'stale')
    ? (serviceState.topPrediction?.confidenceText || `${Math.round(topProbability * 100)}%`)
    : ''
  return `
    <button
      type="button"
      class="${statusClass}"
      data-identify-service-tab="${service}"
      ${options.sid != null ? `data-sid="${_esc(options.sid)}"` : ''}
      title="${_esc(serviceState.available === false ? (serviceState.reason || options.unavailableReason || '') : (serviceState.errorMessage || ''))}"
      ${serviceState.available === false ? 'disabled aria-disabled="true"' : ''}
    >
      ${_renderServiceIcon(serviceState)}
      <span class="ai-id-service-tab-label">${_esc(label)}</span>
      ${stateLabel ? `<span class="ai-id-service-tab-score ${confidence.tone}">${renderIdentifyConfidenceBadge(topProbability, { checkThreshold: 0.65 })}</span>` : ''}
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
  const topProbability = Number(serviceState.topProbability ?? serviceState.topScore ?? 0)
  const confidence = getIdentifyConfidenceState(topProbability, { checkThreshold: 0.65 })
  const stateLabel = (serviceState.status === 'success' || serviceState.status === 'stale')
    ? (serviceState.topPrediction?.confidenceText || `${Math.round(topProbability * 100)}%`)
    : ''
  return `
    <span
      class="${statusClass}"
      title="${_esc(serviceState.available === false ? (serviceState.reason || options.unavailableReason || '') : (serviceState.errorMessage || ''))}"
    >
      ${_renderServiceIcon(serviceState)}
      <span class="ai-id-service-state-label">${_esc(label)}</span>
      ${stateLabel ? `<span class="ai-id-service-state-score ${confidence.tone}">${_esc(stateLabel)}</span>` : ''}
    </span>
  `
}

export function renderIdentifyResultRows(service, predictions = []) {
  const normalizedService = normalizeIdentifyService(service)
  return (Array.isArray(predictions) ? predictions : [])
    .map(prediction => normalizeIdentifyPrediction(normalizedService, prediction))
    .map(prediction => `
      <button type="button" class="ai-result-row" data-identify-result='${JSON.stringify(prediction).replace(/'/g, '&#39;')}'>
        <span class="ai-result-row-main">
          ${(() => {
            const display = formatAiSuggestionDisplay(prediction)
            return `
              <span class="ai-result-row-name">${_esc(display.title)}</span>
              ${display.subtitle ? `<span class="ai-result-row-sci">${_esc(display.subtitle)}</span>` : ''}
            `
          })()}
        </span>
        <span class="ai-result-row-score">${renderIdentifyConfidenceBadge(prediction.probability, { checkThreshold: 0.65 })}</span>
      </button>
    `)
    .join('')
}

export {
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
}
