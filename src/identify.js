import { t } from './i18n.js'
import { loadInaturalistSession } from './inaturalist.js'
import {
  getDefaultIdService,
  ID_SERVICE_ARTSORAKEL,
  ID_SERVICE_INATURALIST,
  normalizeIdentifyService,
} from './settings.js'

const INAT_SUGGEST_URL = 'https://api.inaturalist.org/v2/taxa/suggest'

function _isBlob(value) {
  return value instanceof Blob || (value && typeof value.size === 'number' && typeof value.type === 'string')
}

function _normalizeString(value) {
  return String(value || '').trim()
}

function _isNumber(value) {
  return Number.isFinite(Number(value))
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
  form.append('image', blob, 'photo.jpg')

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
  return normalizeIdentifyService(service) === ID_SERVICE_INATURALIST
    ? t('detail.identifyInaturalist')
    : t('detail.identifyArtsorakel')
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
    return _isBlob(rawBlob) ? rawBlob : null
  }))).filter(_isBlob)

  if (!preparedBlobs.length) return []

  if (preparedBlobs.length === 1) {
    return _runInaturalistSuggestion(preparedBlobs[0], lang, options)
  }

  const tolerateFailures = options?.tolerateFailures === true
  const responses = tolerateFailures
    ? await Promise.allSettled(preparedBlobs.map(blob => _runInaturalistSuggestion(blob, lang, options)))
        .then(results => {
          const fulfilled = results
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value)
          if (fulfilled.length) return fulfilled
          const firstError = results.find(result => result.status === 'rejected')?.reason
          throw firstError || new Error('iNaturalist failed for all images')
        })
    : await Promise.all(preparedBlobs.map(blob => _runInaturalistSuggestion(blob, lang, options)))

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
  if (importAllBtn) setLabel(importAllBtn, defaultLabel)
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
