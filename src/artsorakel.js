/**
 * Artsorakel — species identification + taxon search
 *
 * AI:     POST image → https://ai.artsdatabanken.no (direct, no proxy needed if CORS open)
 * Search: Supabase RPC search_taxa (prefix match on vernacular + scientific names)
 */

import { supabase } from './supabase.js'
import { t } from './i18n.js'
import { createCroppedImageBlob, normalizeAiCropRect } from './image_crop.js'
import { getArtsorakelMaxEdge } from './settings.js'

const ARTSDATA_AI_URL = 'https://ai.artsdatabanken.no'
const ARTSDATA_PROXY_BASE_URL = String(
  import.meta.env.VITE_ARTSORAKEL_BASE_URL || import.meta.env.VITE_MEDIA_UPLOAD_BASE_URL || ''
).replace(/\/+$/, '')

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

function _buildNetworkErrorMessage(error) {
  return String(error?.message || error || '').trim().toLowerCase()
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

async function _resizeForAi(blob) {
  if (!_isBlob(blob)) return blob
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const maxEdge = Math.max(1, getArtsorakelMaxEdge())
        const sourceMaxEdge = Math.max(img.naturalWidth || 0, img.naturalHeight || 0)
        if (!sourceMaxEdge || sourceMaxEdge <= maxEdge) { resolve(blob); return }
        const scale = maxEdge / sourceMaxEdge
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(blob); return }
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob(resized => resolve(_isBlob(resized) ? resized : blob), 'image/jpeg', 0.88)
      } catch (_) {
        resolve(blob)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob) }
    img.src = url
  })
}

/**
 * POST a Blob to Artsdata AI and return up to 5 normalized predictions.
 * Returns null if blob is not a real Blob (demo mode).
 * Throws on network/API error.
 */
export async function runArtsorakel(blob, lang = 'no', options = {}) {
  if (!_isBlob(blob)) return null

  const aiBlob = await _resizeForAi(blob)
  const langNorm = normalizeLang(lang)
  const onImageSent = typeof options?.onImageSent === 'function' ? options.onImageSent : null
  const onIdReceived = typeof options?.onIdReceived === 'function' ? options.onIdReceived : null
  const signal = options?.signal
  let proxyHeaders = null

  async function tryPost(url, fieldName, headers = null) {
    const form = new FormData()
    form.append(fieldName, aiBlob, 'photo.jpg')
    const request = {
      method: 'POST',
      body: form,
      signal,
    }
    if (headers) {
      request.headers = headers
    }
    return fetch(url, request)
  }

  async function runAgainstEndpoint(url, headers = null) {
    let res = await tryPost(url, 'image', headers)
    if (!res.ok) res = await tryPost(url, 'file', headers)
    if (!res.ok) throw new Error(`Artsdata AI ${res.status}`)
    return res
  }

  if (ARTSDATA_PROXY_BASE_URL) {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      proxyHeaders = { Authorization: `Bearer ${session.access_token}` }
    }
  }

  let res = null
  let lastError = null
  onImageSent?.()

  if (ARTSDATA_PROXY_BASE_URL) {
    try {
      res = await runAgainstEndpoint(`${ARTSDATA_PROXY_BASE_URL}/artsorakel`, proxyHeaders)
    } catch (error) {
      lastError = error
      console.warn('Artsorakel proxy failed, falling back to direct endpoint:', error)
    }
  }

  if (!res) {
    try {
      res = await runAgainstEndpoint(ARTSDATA_AI_URL)
    } catch (error) {
      throw lastError || error
    }
  }

  const data = await res.json()
  const predictions = _extractPredictions(data)
  onIdReceived?.(predictions)

  return predictions
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

export async function runArtsorakelForBlobs(blobs, lang = 'no', options = {}) {
  const preparedBlobs = (await Promise.all((blobs || []).map(async item => {
    const rawBlob = _isBlob(item) ? item : item?.blob
    if (!_isBlob(rawBlob)) return null

    // Resize to ≤1MP before cropping so createCroppedImageBlob doesn't OOM
    // on high-resolution imported photos (camera blobs are already ≤1MP via this path too).
    const resizedBlob = await _resizeForAi(rawBlob)

    const cropRect = _isBlob(item) ? null : normalizeAiCropRect(item.cropRect)
    if (!cropRect) return resizedBlob

    try {
      return await createCroppedImageBlob(resizedBlob, cropRect)
    } catch (error) {
      console.warn('AI crop export failed, falling back to resized image:', error)
      return resizedBlob
    }
  }))).filter(blob => _isBlob(blob))

  if (!preparedBlobs.length) return null

  if (preparedBlobs.length === 1) {
    return runArtsorakel(preparedBlobs[0], lang, options)
  }

  const responses = await Promise.all(preparedBlobs.map(blob => runArtsorakel(blob, lang, options)))
  const totalBlobs = preparedBlobs.length
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
