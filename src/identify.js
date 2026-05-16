import { t } from './i18n.js'
import { loadInaturalistSession } from './inaturalist.js'
import { getBlobImageDimensions, prepareImageBlobForUpload } from './image_crop.js'
import {
  getDefaultIdService,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
} from './settings.js'

const INAT_SUGGEST_URL = 'https://api.inaturalist.org/v2/taxa/suggest'
const INAT_MAX_EDGE = 1920
const INAT_DEBUG_REQUESTS_KEY = 'sporely-debug-inaturalist'

function _isDebugAiIdEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.localStorage?.getItem('sporely-debug-inat-oauth') === 'true'
      || globalThis.sessionStorage?.getItem('sporely-debug-ai-id') === 'true'
      || globalThis.location?.search?.includes('debug_ai_id=1')
  } catch (_) {
    return false
  }
}

function _isDebugInaturalistRequestsEnabled() {
  try {
    return globalThis.localStorage?.getItem(INAT_DEBUG_REQUESTS_KEY) === 'true'
  } catch (_) {
    return false
  }
}

function _debugAiId(message, details = {}) {
  if (!_isDebugAiIdEnabled()) return
  console.debug(`[ai-id] ${message}`, details)
}

function _getInaturalistDebugStore() {
  if (!globalThis.__sporelyAiDebug || typeof globalThis.__sporelyAiDebug !== 'object') {
    globalThis.__sporelyAiDebug = {}
  }
  if (!Array.isArray(globalThis.__sporelyAiDebug.inat)) {
    globalThis.__sporelyAiDebug.inat = []
  }
  return globalThis.__sporelyAiDebug.inat
}

function _trimInaturalistDebugStore() {
  const store = _getInaturalistDebugStore()
  while (store.length > 20) {
    const removed = store.shift()
    for (const image of removed?.images || []) {
      try {
        if (image?.objectUrl) globalThis.URL?.revokeObjectURL?.(image.objectUrl)
      } catch (_) {}
    }
  }
}

async function _buildInaturalistDebugEntry({
  aiBlob,
  preparedMeta,
  options = {},
  url,
  fieldName = 'image',
  imageIndex = 0,
  imageCount = 1,
}) {
  const dimensions = preparedMeta?.targetWidth && preparedMeta?.targetHeight
    ? { width: preparedMeta.targetWidth, height: preparedMeta.targetHeight }
    : (await getBlobImageDimensions(aiBlob).catch(() => null))
  const objectUrl = globalThis.URL?.createObjectURL?.(aiBlob) || ''
  return {
    timestamp: new Date().toISOString(),
    service: ID_SERVICE_INATURALIST,
    screen: options.screen || '',
    endpoint: url,
    fieldName,
    imageCount,
    imageIndex,
    images: [{
      blobType: aiBlob?.type || '',
      blobSize: Number(aiBlob?.size || 0),
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      objectUrl,
      wasCropped: !!preparedMeta?.cropped,
      cropRect: preparedMeta?.cropRect || null,
      cropSourceW: preparedMeta?.cropSourceW ?? null,
      cropSourceH: preparedMeta?.cropSourceH ?? null,
      sourceWidth: preparedMeta?.sourceWidth ?? null,
      sourceHeight: preparedMeta?.sourceHeight ?? null,
      maxEdge: preparedMeta?.maxEdge ?? null,
    }],
  }
}

async function _logInaturalistRequestIfEnabled({
  aiBlob,
  preparedMeta,
  options = {},
  url,
  fieldName = 'image',
  imageIndex = 0,
  imageCount = 1,
}) {
  if (!_isDebugInaturalistRequestsEnabled()) return
  try {
    const entry = await _buildInaturalistDebugEntry({
      aiBlob,
      preparedMeta,
      options,
      url,
      fieldName,
      imageIndex,
      imageCount,
    })
    const store = _getInaturalistDebugStore()
    store.push(entry)
    _trimInaturalistDebugStore()
    console.debug('[inaturalist-debug] outgoing request', entry)
  } catch (error) {
    console.warn('[inaturalist-debug] request logging failed', error)
  }
}

function _isBlob(value) {
  return value instanceof Blob || (value && typeof value.size === 'number' && typeof value.type === 'string')
}

function _normalizeString(value) {
  return String(value || '').trim()
}

function _isNumber(value) {
  return Number.isFinite(Number(value))
}

function _buildInaturalistFilename(blob) {
  const type = String(blob?.type || '').toLowerCase()
  if (type === 'image/jpeg' || type === 'image/jpg' || !type) return 'photo.jpg'
  if (type === 'image/png') return 'photo.png'
  if (type === 'image/webp') return 'photo.webp'
  if (type === 'image/avif') return 'photo.avif'
  if (type === 'image/heic') return 'photo.heic'
  if (type === 'image/heif') return 'photo.heif'
  return 'photo.jpg'
}

function _toFraction(score) {
  const value = Number(score)
  if (!Number.isFinite(value)) return 0
  if (value > 1) return Math.max(0, Math.min(1, value / 100))
  return Math.max(0, Math.min(1, value))
}

function _scoreToText(service, score) {
  const normalized = _toFraction(score)
  if (service === ID_SERVICE_INATURALIST) {
    return `${Math.round(normalized * 100)}%`
  }
  return normalized.toFixed(2)
}

function _firstCommonName(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = _firstCommonName(item)
      if (name) return name
    }
    return ''
  }

  if (value && typeof value === 'object') {
    for (const key of ['en', 'no', 'nb', 'sv', 'da', 'de']) {
      const name = _firstCommonName(value[key])
      if (name) return name
    }
    for (const item of Object.values(value)) {
      const name = _firstCommonName(item)
      if (name) return name
    }
    return ''
  }

  const text = _normalizeString(value)
  if (!text) return ''
  return text.replace(/^\s*['"]|['"]\s*$/g, '')
}

function _scientificName(taxon = {}) {
  return _normalizeString(taxon.scientificName || taxon.scientific_name || taxon.name || taxon.slug)
}

function _preferredCommonName(taxon = {}) {
  for (const key of ['preferred_common_name', 'preferred_common_names', 'common_name', 'common_names']) {
    const name = _firstCommonName(taxon[key])
    if (name) return name
  }
  return ''
}

function _combinePredictions(predictionLists, totalBlobs) {
  const combined = new Map()

  predictionLists
    .filter(Array.isArray)
    .forEach(predictions => {
      predictions.forEach(prediction => {
        const key = prediction.taxonId || prediction.scientificName?.toLowerCase() || prediction.displayName?.toLowerCase()
        if (!key) return
        const existing = combined.get(key) || {
          ...prediction,
          probabilitySum: 0,
          hitCount: 0,
        }
        existing.probabilitySum += Number(prediction.probability || 0)
        existing.hitCount += 1
        existing.probability = existing.probabilitySum / Math.max(1, totalBlobs)
        if (!existing.scientificName && prediction.scientificName) existing.scientificName = prediction.scientificName
        if (!existing.vernacularName && prediction.vernacularName) existing.vernacularName = prediction.vernacularName
        if (!existing.displayName && prediction.displayName) existing.displayName = prediction.displayName
        if (!existing.adbUrl && prediction.adbUrl) existing.adbUrl = prediction.adbUrl
        combined.set(key, existing)
      })
    })

  return Array.from(combined.values())
    .sort((a, b) =>
      b.probabilitySum - a.probabilitySum
      || b.hitCount - a.hitCount
      || b.probability - a.probability
    )
    .slice(0, 5)
    .map(({ probabilitySum, hitCount, ...prediction }) => prediction)
}

function _extractPredictionItems(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of ['results', 'predictions', 'items', 'data']) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  return []
}

function _normalizeInaturalistPrediction(prediction) {
  const taxon = prediction?.taxon && typeof prediction.taxon === 'object'
    ? prediction.taxon
    : prediction || {}
  const scientificName = _scientificName(taxon)
  const vernacularName = _preferredCommonName(taxon)
  const displayName = vernacularName && scientificName && vernacularName.toLowerCase() !== scientificName.toLowerCase()
    ? `${vernacularName} (${scientificName})`
    : vernacularName || scientificName || t('common.unknown')

  const score = _isNumber(prediction?.combined_score)
    ? prediction.combined_score
    : (_isNumber(prediction?.vision_score) ? prediction.vision_score : prediction?.score)

  return {
    service: ID_SERVICE_INATURALIST,
    taxonId: taxon.id || null,
    probability: _toFraction(score),
    scientificName: scientificName || null,
    vernacularName: vernacularName || null,
    displayName,
    adbUrl: taxon.id ? `https://www.inaturalist.org/taxa/${taxon.id}` : 'https://www.inaturalist.org',
    rawScore: score ?? null,
    taxon,
  }
}

async function _runInaturalistSuggestion(blob, lang = 'en', options = {}) {
  const session = await loadInaturalistSession(options.storage)
  const apiToken = _normalizeString(session?.api_token)
  if (!apiToken) {
    throw new Error(t('settings.inaturalistLoginMissing'))
  }
  if (typeof options?.onImageSent === 'function') {
    options.onImageSent()
  }

  const prepared = options.prepared === true && _isBlob(options.preparedBlob)
    ? {
        blob: options.preparedBlob,
        inputType: blob.type || '',
        inputSize: Number(blob.size || 0),
        outputType: options.preparedBlob.type || '',
        outputSize: Number(options.preparedBlob.size || 0),
        sourceWidth: options.preparedMeta?.sourceWidth ?? null,
        sourceHeight: options.preparedMeta?.sourceHeight ?? null,
        sourceMaxEdge: options.preparedMeta?.sourceMaxEdge ?? null,
        targetWidth: options.preparedMeta?.targetWidth ?? null,
        targetHeight: options.preparedMeta?.targetHeight ?? null,
        resized: !!options.preparedMeta?.resized,
        converted: !!options.preparedMeta?.converted,
        prepared: true,
        fallback: !!options.preparedMeta?.fallback,
        cropRect: options.preparedMeta?.cropRect || null,
        cropSourceW: options.preparedMeta?.cropSourceW ?? null,
        cropSourceH: options.preparedMeta?.cropSourceH ?? null,
        cropped: !!options.preparedMeta?.cropped,
        maxEdge: Math.max(1, Number(options.preparedMeta?.maxEdge || options.maxEdge || INAT_MAX_EDGE) || INAT_MAX_EDGE),
      }
    : await prepareImageBlobForUpload(blob, {
        maxEdge: Math.max(1, Number(options.maxEdge || INAT_MAX_EDGE) || INAT_MAX_EDGE),
        forceJpeg: true,
        cropRect: options.cropRect,
      })
  const aiBlob = prepared.blob
  const filename = _buildInaturalistFilename(aiBlob)
  const dims = prepared.sourceWidth && prepared.sourceHeight
    ? { width: prepared.sourceWidth, height: prepared.sourceHeight }
    : (await getBlobImageDimensions(blob).catch(() => null))

  _debugAiId('prepared inaturalist upload', {
    service: ID_SERVICE_INATURALIST,
    screen: options.screen || '',
    inputType: blob?.type || '',
    inputSize: Number(blob?.size || 0),
    decodedWidth: dims?.width ?? null,
    decodedHeight: dims?.height ?? null,
    preparedType: aiBlob?.type || '',
    preparedSize: Number(aiBlob?.size || 0),
    filename,
  })

  const form = new FormData()
  form.append('source', 'visual')
  form.append('locale', String(lang || 'en'))
  form.append('fields', JSON.stringify({
    combined_score: true,
    vision_score: true,
    taxon: {
      id: true,
      name: true,
      rank: true,
      preferred_common_name: true,
      preferred_common_names: true,
      common_name: true,
      common_names: true,
    },
  }))
  if (_isNumber(options?.lat)) form.append('lat', String(options.lat))
  if (_isNumber(options?.lon)) form.append('lng', String(options.lon))
  if (options?.observedOn) form.append('observed_on', String(options.observedOn))
  form.append('image', aiBlob, filename)
  await _logInaturalistRequestIfEnabled({
    aiBlob,
    preparedMeta: prepared,
    options,
    url: INAT_SUGGEST_URL,
    fieldName: 'image',
    imageIndex: Number(options.imageIndex || 0),
    imageCount: Number(options.totalImages || 1),
  })

  const response = await (options.fetchImpl || fetch)(INAT_SUGGEST_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: form,
    signal: options?.signal,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload?.error_description || payload?.error || payload?.message || 'iNaturalist suggestion failed')
  }

  const predictions = _extractPredictionItems(payload)
    .map(_normalizeInaturalistPrediction)
    .filter(prediction => prediction.displayName)
    .sort((a, b) => b.probability - a.probability)
  if (typeof options?.onIdReceived === 'function') {
    options.onIdReceived(predictions)
  }
  return predictions
}

export function getIdentifyServiceLabel(service) {
  return normalizeIdentifyService(service) === ID_SERVICE_INATURALIST
    ? t('settings.idServiceInaturalist')
    : t('settings.idServiceArtsorakel')
}

export function getIdentifyButtonLabel(service) {
  return t('review.aiId') || 'AI Photo ID'
}

export function getIdentifyBusyLabel(service) {
  return normalizeIdentifyService(service) === ID_SERVICE_INATURALIST
    ? t('review.identifyingInaturalist')
    : t('review.identifyingArtsorakel')
}

export function getIdentifyNoMatchMessage(service) {
  return normalizeIdentifyService(service) === ID_SERVICE_INATURALIST
    ? t('review.noMatchInaturalist')
    : t('review.noMatchArtsorakel')
}

export function getIdentifyUnavailableMessage(service) {
  return normalizeIdentifyService(service) === ID_SERVICE_INATURALIST
    ? t('review.inaturalistUnavailable')
    : t('review.aiUnavailable')
}

export function formatIdentifyScore(service, score) {
  return _scoreToText(normalizeIdentifyService(service), score)
}

export async function runInaturalistForBlobs(blobs, lang = 'en', options = {}) {
  const preparedBlobs = (await Promise.all((blobs || []).map(async item => {
    const rawBlob = _isBlob(item) ? item : item?.blob
    if (!_isBlob(rawBlob)) return null

    if (item?.preprocessed === true && _isBlob(item.blob)) {
      return {
        blob: item.blob,
        preparedMeta: item.preparedMeta || item.debug || {},
      }
    }

    const prepared = await prepareImageBlobForUpload(rawBlob, {
      maxEdge: Math.max(1, Number(options.maxEdge || INAT_MAX_EDGE) || INAT_MAX_EDGE),
      forceJpeg: true,
      cropRect: item?.cropRect,
    })
    return {
      blob: prepared.blob,
      preparedMeta: prepared,
    }
  }))).filter(item => _isBlob(item?.blob))

  if (!preparedBlobs.length) return []

  if (preparedBlobs.length === 1) {
    const [single] = preparedBlobs
    return _runInaturalistSuggestion(single.blob, lang, {
      ...options,
      prepared: true,
      preparedBlob: single.blob,
      preparedMeta: single.preparedMeta,
    })
  }

  const tolerateFailures = options?.tolerateFailures === true
  const responses = tolerateFailures
    ? await Promise.allSettled(preparedBlobs.map((item, index) => _runInaturalistSuggestion(item.blob, lang, {
        ...options,
        prepared: true,
        preparedBlob: item.blob,
        preparedMeta: item.preparedMeta,
        imageIndex: index,
        totalImages: preparedBlobs.length,
      })))
        .then(results => {
          const fulfilled = results
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value)
          if (fulfilled.length) return fulfilled
          const firstError = results.find(result => result.status === 'rejected')?.reason
          throw firstError || new Error('iNaturalist failed for all images')
        })
    : await Promise.all(preparedBlobs.map((item, index) => _runInaturalistSuggestion(item.blob, lang, {
        ...options,
        prepared: true,
        preparedBlob: item.blob,
        preparedMeta: item.preparedMeta,
        imageIndex: index,
        totalImages: preparedBlobs.length,
      })))

  return _combinePredictions(responses, preparedBlobs.length)
}

export async function runIdentifyForBlobs(blobs, service, lang = 'en', options = {}) {
  const normalized = normalizeIdentifyService(service)
  if (normalized === ID_SERVICE_INATURALIST) {
    return runInaturalistForBlobs(blobs, lang, options)
  }
  const { runArtsorakelForBlobs } = await import('./artsorakel.js')
  return runArtsorakelForBlobs(blobs, lang, options)
}

export async function runIdentifyForMediaKeys(mediaKeys, service, lang = 'en', options = {}) {
  const normalized = normalizeIdentifyService(service)
  if (normalized === ID_SERVICE_INATURALIST) {
    throw new Error('iNaturalist suggestions require images.')
  }
  const { runArtsorakelForMediaKeys } = await import('./artsorakel.js')
  return runArtsorakelForMediaKeys(mediaKeys, lang, options)
}

export function syncIdentifyButtonLabels() {
  const defaultService = getDefaultIdService()
  const defaultLabel = getIdentifyButtonLabel(defaultService)
  const setLabel = (el, label) => {
    if (!el) return
    if (el.querySelector?.('.ai-id-dot') || el.querySelector?.('.ai-dot')) {
      el.innerHTML = `<span class="ai-id-dot"></span> ${label}`
    } else {
      el.textContent = label
    }
  }
  document.querySelectorAll('[data-identify-default-label]').forEach(el => {
    setLabel(el, defaultLabel)
  })
  const importAllBtn = document.getElementById('import-ai-all-btn')
  if (importAllBtn) setLabel(importAllBtn, t('import.aiIdAll') || 'ID All')
  document.querySelectorAll('[data-identify-service-label]').forEach(el => {
    const service = el.dataset.identifyServiceLabel
    setLabel(el, getIdentifyServiceLabel(service))
  })
  document.querySelectorAll('[data-identify-service-button]').forEach(el => {
    const service = el.dataset.identifyServiceButton
    setLabel(el, getIdentifyButtonLabel(service))
  })
}

export {
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
}
