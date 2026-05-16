/**
 * Artsorakel — species identification + taxon search
 *
 * AI:     POST image → https://ai.artsdatabanken.no (direct, no proxy needed if CORS open)
 * Search: Supabase RPC search_taxa (prefix match on vernacular + scientific names)
 */

import { supabase } from './supabase.js'
import { t } from './i18n.js'
import { getBlobImageDimensions, normalizeAiCropRect, prepareImageBlobForUpload } from './image_crop.js'
import { getArtsorakelMaxEdge } from './settings.js'

const ARTSDATA_AI_URL = 'https://ai.artsdatabanken.no'

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

function _envText(key) {
  return String(globalThis.__SPORLEY_TEST_ENV__?.[key] ?? import.meta.env?.[key] ?? '').trim()
}

function _getArtsorakelProxyBaseUrl() {
  return _envText('VITE_ARTSORAKEL_BASE_URL').replace(/\/+$/, '')
}

function _buildNetworkErrorMessage(error) {
  return String(error?.message || error || '').trim().toLowerCase()
}

function _isArtsorakelDebugEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-artsorakel') === 'true'
  } catch (_) {
    return false
  }
}

function _getArtsorakelDebugStore() {
  if (!globalThis.__sporelyAiDebug || typeof globalThis.__sporelyAiDebug !== 'object') {
    globalThis.__sporelyAiDebug = {}
  }
  if (!Array.isArray(globalThis.__sporelyAiDebug.artsorakel)) {
    globalThis.__sporelyAiDebug.artsorakel = []
  }
  return globalThis.__sporelyAiDebug.artsorakel
}

function _trimArtsorakelDebugStore() {
  const store = _getArtsorakelDebugStore()
  while (store.length > 20) {
    const removed = store.shift()
    for (const image of removed?.images || []) {
      try {
        if (image?.objectUrl) globalThis.URL?.revokeObjectURL?.(image.objectUrl)
      } catch (_) {}
    }
  }
}

async function _buildArtsorakelDebugEntry({
  aiBlob,
  preparedMeta,
  options = {},
  url,
  fieldName,
  imageIndex = 0,
  imageCount = 1,
}) {
  const dimensions = preparedMeta?.targetWidth && preparedMeta?.targetHeight
    ? { width: preparedMeta.targetWidth, height: preparedMeta.targetHeight }
    : (await getBlobImageDimensions(aiBlob).catch(() => null))
  const objectUrl = globalThis.URL?.createObjectURL?.(aiBlob) || ''
  return {
    timestamp: new Date().toISOString(),
    service: ID_SERVICE_ARTSORAKEL,
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

async function _logArtsorakelRequestIfEnabled({
  aiBlob,
  preparedMeta,
  options = {},
  url,
  fieldName,
  imageIndex = 0,
  imageCount = 1,
}) {
  if (!_isArtsorakelDebugEnabled() || url !== ARTSDATA_AI_URL) return
  const entry = await _buildArtsorakelDebugEntry({
    aiBlob,
    preparedMeta,
    options,
    url,
    fieldName,
    imageIndex,
    imageCount,
  })
  const store = _getArtsorakelDebugStore()
  store.push(entry)
  _trimArtsorakelDebugStore()
  console.debug('[artsorakel-debug] outgoing request', entry)
}

export function isArtsorakelNetworkError(error) {
  const message = _buildNetworkErrorMessage(error)
  return (
    message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('load failed')
    || message.includes('fetch failed')
    || message.includes('network request failed')
  )
}

// ── Language helpers ──────────────────────────────────────────────────────────

export function normalizeLang(code = 'no') {
  const raw = String(code).toLowerCase().replace('-', '_')
  if (raw.startsWith('nb') || raw.startsWith('nn') || raw.startsWith('no')) return 'no'
  if (raw.startsWith('sv')) return 'sv'
  if (raw.startsWith('da')) return 'da'
  if (raw.startsWith('de')) return 'de'
  if (raw.startsWith('en')) return 'en'
  return raw.slice(0, 2) || 'no'
}

export function formatScientificName(genus, specificEpithet) {
  return [genus, specificEpithet]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
}

export function formatDisplayName(genus, specificEpithet, vernacularName) {
  const sci  = formatScientificName(genus, specificEpithet)
  const vern = vernacularName?.trim()
  if (vern && vern.toLowerCase() !== sci.toLowerCase()) return `${vern} (${sci})`
  return sci
}

export function createManualTaxon(value) {
  const displayName = String(value || '').trim()
  if (!displayName) return null
  return {
    genus: null,
    specificEpithet: displayName,
    vernacularName: null,
    scientificName: displayName,
    displayName,
    manualEntry: true,
  }
}

// ── Taxon search (Supabase RPC) ───────────────────────────────────────────────

export async function searchTaxa(q, lang = 'no') {
  if (!q || q.trim().length < 2) return []
  const { data, error } = await supabase.rpc('search_taxa', {
    q:    q.trim(),
    lang: normalizeLang(lang),
    lim:  20,
  })
  if (error) { console.warn('Taxa search error:', error.message); return [] }
  return (data || []).map(row => ({
    taxonId:            row.taxon_id,
    genus:              row.genus,
    specificEpithet:    row.specific_epithet,
    family:             row.family,
    vernacularName:     row.vernacular_name || null,
    scientificName:     row.canonical_scientific_name || `${row.genus} ${row.specific_epithet}`.trim(),
    norwegianTaxonId:   row.norwegian_taxon_id  || null,
    swedishTaxonId:     row.swedish_taxon_id    || null,
    inaturalistTaxonId: row.inaturalist_taxon_id|| null,
    artportalenTaxonId: row.artportalen_taxon_id|| null,
    displayName:        formatDisplayName(row.genus, row.specific_epithet, row.vernacular_name),
    matchType:          row.match_type,
  }))
}

// ── Artsdata AI ───────────────────────────────────────────────────────────────

function pickVernacular(taxon, lang) {
  const map = taxon.vernacularNames || {}
  // Exact language match first
  if (map[lang]?.trim()) return map[lang].trim()
  for (const [code, v] of Object.entries(map)) {
    if (normalizeLang(code) === lang && v?.trim()) return v.trim()
  }
  // Fallback: root vernacularName, then any available
  if (taxon.vernacularName?.trim()) return taxon.vernacularName.trim()
  for (const v of Object.values(map)) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function pickUrl(pred, taxon) {
  for (const obj of [pred, taxon]) {
    if (!obj) continue
    for (const key of ['infoURL', 'infoUrl', 'info_url', 'url', 'link', 'href', 'uri']) {
      if (typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key]
    }
  }
  const id = taxon.taxonId || taxon.id
  if (id) return `https://artsdatabanken.no/arter/takson/${id}`
  return 'https://artsdatabanken.no'
}

function _buildArtsorakelFilename(blob) {
  const type = String(blob?.type || '').toLowerCase()
  if (type === 'image/jpeg' || type === 'image/jpg') return 'photo.jpg'
  if (type === 'image/webp') return 'photo.webp'
  if (type === 'image/png') return 'photo.png'
  if (type === 'image/avif') return 'photo.avif'
  if (type === 'image/heic') return 'photo.heic'
  if (type === 'image/heif') return 'photo.heif'
  return 'photo.jpg'
}

function _shortText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function _responseBodyExcerpt(payload) {
  if (!payload) return ''
  if (typeof payload === 'string') return _shortText(payload)
  if (typeof payload === 'object') {
    return _shortText(
      payload.message
      || payload.error_description
      || payload.error
      || payload.detail
      || JSON.stringify(payload)
    )
  }
  return _shortText(String(payload))
}

function _endpointMeta(kind, url) {
  try {
    const parsed = new URL(url)
    return { kind, origin: parsed.origin, path: parsed.pathname }
  } catch (_) {
    return { kind, origin: '', path: String(url || '') }
  }
}

async function _prepareArtsorakelImageBlob(blob, options = {}) {
  const prepared = await prepareImageBlobForUpload(blob, {
    ...options,
    maxEdge: Math.max(1, Number(options.maxEdge || getArtsorakelMaxEdge()) || 1),
  })
  return prepared
}

/**
 * POST a Blob to Artsdata AI and return up to 5 normalized predictions.
 * Returns null if blob is not a real Blob (demo mode).
 * Throws on network/API error.
 */
export async function runArtsorakel(blob, lang = 'no', options = {}) {
  if (!_isBlob(blob)) return null

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
        cropRect: options.preparedMeta?.cropRect || null,
        cropSourceW: options.preparedMeta?.cropSourceW ?? null,
        cropSourceH: options.preparedMeta?.cropSourceH ?? null,
        cropped: !!options.preparedMeta?.cropped,
        targetWidth: options.preparedMeta?.targetWidth ?? null,
        targetHeight: options.preparedMeta?.targetHeight ?? null,
        resized: !!options.preparedMeta?.resized,
        converted: !!options.preparedMeta?.converted,
        prepared: true,
        fallback: !!options.preparedMeta?.fallback,
        maxEdge: Math.max(1, Number(options.preparedMeta?.maxEdge || getArtsorakelMaxEdge()) || 1),
      }
    : await _prepareArtsorakelImageBlob(blob, options)

  const aiBlob = prepared.blob
  const langNorm = normalizeLang(lang)
  const onImageSent = typeof options?.onImageSent === 'function' ? options.onImageSent : null
  const onIdReceived = typeof options?.onIdReceived === 'function' ? options.onIdReceived : null
  const signal = options?.signal

  async function tryPost(url, fieldName, headers = null, kind = 'direct') {
    const form = new FormData()
    form.append(fieldName, aiBlob, _buildArtsorakelFilename(aiBlob))
    const request = {
      method: 'POST',
      body: form,
      signal,
    }
    if (headers) {
      request.headers = headers
    }
    await _logArtsorakelRequestIfEnabled({
      aiBlob,
      preparedMeta: prepared,
      options,
      url,
      fieldName,
      imageIndex: Number(options.imageIndex || 0),
      imageCount: Number(options.totalImages || 1),
    })
    const response = await fetch(url, request)
    if (!response.ok) {
      let payload = null
      try {
        const text = typeof response.text === 'function' ? await response.text() : ''
        try {
          payload = text ? JSON.parse(text) : null
        } catch (_) {
          payload = text
        }
      } catch (_) {}
      const meta = _endpointMeta(kind, url)
      const error = new Error(
        `${meta.kind} endpoint ${meta.origin}${meta.path} field=${fieldName} status=${response.status}${response.statusText ? ` ${response.statusText}` : ''}${_responseBodyExcerpt(payload) ? ` body=${_responseBodyExcerpt(payload)}` : ''} blob=${aiBlob.type || 'unknown'}:${aiBlob.size || 0}`
      )
      error.status = response.status
      error.statusText = response.statusText
      error.endpointKind = meta.kind
      error.endpointOrigin = meta.origin
      error.endpointPath = meta.path
      error.fieldName = fieldName
      error.responseBody = payload
      error.blobType = aiBlob.type || ''
      error.blobSize = aiBlob.size || 0
      throw error
    }
    return response
  }

  async function runAgainstEndpoint(url, headers = null, kind = 'direct') {
    const attempts = []
    let lastError = null
    for (const fieldName of ['image', 'file']) {
      try {
        const response = await tryPost(url, fieldName, headers, kind)
        return response
      } catch (error) {
        lastError = error
        attempts.push(error)
      }
    }
    const endpoint = _endpointMeta(kind, url)
    const details = attempts.length ? ` ${attempts.map(err => err.message).join(' | ')}` : ''
    const error = new Error(`Artsdata AI ${endpoint.kind} failed:${details}`.trim())
    error.cause = lastError || null
    error.attempts = attempts
    throw error
  }

  const proxyBaseUrl = _getArtsorakelProxyBaseUrl()
  let proxyHeaders = null

  if (proxyBaseUrl) {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      proxyHeaders = { Authorization: `Bearer ${session.access_token}` }
    }
  }

  let res = null
  let lastError = null
  onImageSent?.()

  if (proxyBaseUrl) {
    try {
      res = await runAgainstEndpoint(`${proxyBaseUrl}/artsorakel`, proxyHeaders, 'proxy')
    } catch (error) {
      lastError = error
      console.warn('Artsorakel proxy failed, falling back to direct endpoint:', error)
    }
  }

  if (!res) {
    try {
      res = await runAgainstEndpoint(ARTSDATA_AI_URL, null, 'direct')
    } catch (error) {
      const combined = lastError
        ? new Error(`${lastError.message}; direct fallback failed: ${error.message}`)
        : error
      if (combined === error) throw error
      combined.cause = error
      combined.proxyError = lastError
      combined.directError = error
      throw combined
    }
  }

  const data = await res.json()
  const predictions = _extractPredictions(data)
  onIdReceived?.(predictions)

  return _normalizePredictions(predictions, langNorm)
}

function _extractPredictions(data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []

  for (const key of ['predictions', 'results', 'matches', 'items', 'data']) {
    if (Array.isArray(data[key])) return data[key]
  }

  if (Array.isArray(data?.data?.predictions)) return data.data.predictions
  if (Array.isArray(data?.result?.predictions)) return data.result.predictions
  if (data?.taxon || data?.scientificName || data?.probability) return [data]
  return []
}

function _normalizePredictions(data, langNorm) {
  return _extractPredictions(data)
    .filter(p => p?.taxon?.vernacularName !== '*** Utdatert versjon ***')
    .slice(0, 5)
    .map(pred => {
      const taxon = pred.taxon || {}
      const sci   = (taxon.scientificName || taxon.scientific_name || taxon.name || '').trim()
      const vern  = pickVernacular(taxon, langNorm)
      return {
        taxonId:        taxon.taxonId || taxon.id || null,
        probability:    Number(pred.probability || 0),
        scientificName: sci || null,
        vernacularName: vern || null,
        displayName:    vern && sci && vern.toLowerCase() !== sci.toLowerCase()
                          ? `${vern} (${sci})` : vern || sci || t('common.unknown'),
        adbUrl:         pickUrl(pred, taxon),
      }
    })
}

function _combinePredictionResponses(responses, totalBlobs) {
  const combined = new Map()

  responses
    .filter(predictions => Array.isArray(predictions))
    .forEach(predictions => {
      predictions.forEach(prediction => {
        const key = prediction.taxonId
          || prediction.scientificName?.toLowerCase()
          || prediction.displayName?.toLowerCase()
        if (!key) return

        const existing = combined.get(key) || {
          ...prediction,
          probabilitySum: 0,
          hitCount: 0,
        }

        existing.probabilitySum += Number(prediction.probability || 0)
        existing.hitCount += 1
        existing.probability = existing.probabilitySum / totalBlobs
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

export async function runArtsorakelForBlobs(blobs, lang = 'no', options = {}) {
  const preparedBlobs = (await Promise.all((blobs || []).map(async item => {
    const rawBlob = _isBlob(item) ? item : item?.blob
    if (!_isBlob(rawBlob)) return null

    if (item?.preprocessed === true && _isBlob(item.blob)) {
      return {
        blob: item.blob,
        preparedMeta: item.preparedMeta || item.debug || {},
      }
    }

    const cropRect = normalizeAiCropRect(item?.cropRect)
    const prepared = await _prepareArtsorakelImageBlob(rawBlob, {
      ...options,
      cropRect,
    })
    return { blob: prepared.blob, preparedMeta: prepared }
  }))).filter(item => _isBlob(item?.blob))

  if (!preparedBlobs.length) return null

  if (preparedBlobs.length === 1) {
    const [single] = preparedBlobs
    return runArtsorakel(single.blob, lang, {
      ...options,
      prepared: true,
      preparedBlob: single.blob,
      preparedMeta: single.preparedMeta,
      totalImages: preparedBlobs.length,
      imageIndex: 0,
    })
  }

  const tolerateFailures = options?.tolerateFailures === true
  const responses = tolerateFailures
    ? await Promise.allSettled(preparedBlobs.map((item, index) => runArtsorakel(item.blob, lang, {
        ...options,
        prepared: true,
        preparedBlob: item.blob,
        preparedMeta: item.preparedMeta,
        totalImages: preparedBlobs.length,
        imageIndex: index,
      })))
        .then(results => {
          const fulfilled = results
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value)
          if (fulfilled.length) return fulfilled
          const firstError = results.find(result => result.status === 'rejected')?.reason
          throw firstError || new Error('Artsorakel failed for all images')
        })
    : await Promise.all(preparedBlobs.map((item, index) => runArtsorakel(item.blob, lang, {
        ...options,
        prepared: true,
        preparedBlob: item.blob,
        preparedMeta: item.preparedMeta,
        totalImages: preparedBlobs.length,
        imageIndex: index,
      })))
  return _combinePredictionResponses(responses, preparedBlobs.length)
}

export async function runArtsorakelForMediaKeys(mediaKeys, lang = 'no', options = {}) {
  const keys = [...new Set((mediaKeys || [])
    .map(key => String(key || '').trim())
    .filter(Boolean))]
  if (!keys.length) return null
  const proxyBaseUrl = _getArtsorakelProxyBaseUrl()
  if (!proxyBaseUrl) {
    throw new Error('Artsorakel media proxy unavailable')
  }

  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token
  if (!accessToken) throw new Error('Missing authenticated session for Artsorakel media')

  const response = await fetch(`${proxyBaseUrl}/artsorakel/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      keys,
      variant: options?.variant || 'medium',
      lang: normalizeLang(lang),
    }),
    signal: options?.signal,
  })

  if (!response.ok) {
    let detail = response.statusText || 'Artsorakel media failed'
    try {
      const payload = await response.json()
      if (payload?.message) detail = payload.message
    } catch (_) {}
    throw new Error(`Artsorakel media failed: ${detail}`)
  }

  const payload = await response.json()
  const langNorm = normalizeLang(lang)
  const responses = (payload?.responses || [])
    .map(item => _normalizePredictions(item?.data || item, langNorm))
  if (!responses.length) return []
  return _combinePredictionResponses(responses, Number(payload?.total || responses.length) || responses.length)
}
