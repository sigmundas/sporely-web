import { recordDebugJsonResponse } from './debug-activity.js'
import {
  MAX_LOCATION_SUGGESTIONS,
  buildDawaSuggestion,
  buildLocationSuggestionsFromNominatim,
  dedupeText,
} from './location-suggestion-builder.js'

export { buildDawaSuggestion, buildLocationSuggestionsFromNominatim } from './location-suggestion-builder.js'

const LOCATION_LOOKUP_BASE_URL = String(
  import.meta.env?.VITE_LOCATION_LOOKUP_BASE_URL || import.meta.env?.VITE_MEDIA_UPLOAD_BASE_URL || ''
).replace(/\/+$/, '')
const ARTS_MAX_DIST = 0.006
const INTERNATIONAL_LOOKUP_INTERVAL_MS = 1000

let internationalLookupQueue = Promise.resolve()
let lastInternationalLookupStartedAt = 0

export function isUsableLookupCoordinate(lat, lon) {
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001)
}

export function lookupCoordinateKey(lat, lon, digits = 5) {
  if (!isUsableLookupCoordinate(lat, lon)) return ''
  return `${Number(lat).toFixed(digits)},${Number(lon).toFixed(digits)}`
}

export function normalizeLocationLookupResult(raw, lat = null, lon = null) {
  const countryCode = String(raw?.country_code || raw?.countryCode || '').trim().toLowerCase()
  const suggestions = dedupeText(
    raw?.suggestions || raw?.places || raw?.debug?.final_suggestions || []
  ).slice(0, MAX_LOCATION_SUGGESTIONS)

  return {
    suggestions,
    latitude: _finiteOrNull(raw?.latitude ?? lat),
    longitude: _finiteOrNull(raw?.longitude ?? lon),
    country_code: countryCode || null,
    country_name: _stringOrNull(raw?.country_name || raw?.countryName),
    nominatim_display_name: _stringOrNull(raw?.nominatim_display_name || raw?.nominatimDisplayName),
    debug: raw?.debug && typeof raw.debug === 'object' ? raw.debug : null,
    source: _stringOrNull(raw?.source),
  }
}

export async function lookupReverseLocation(lat, lon, options = {}) {
  const latitude = Number(lat)
  const longitude = Number(lon)
  if (!isUsableLookupCoordinate(latitude, longitude)) return normalizeLocationLookupResult({}, latitude, longitude)

  const norway = await lookupNorwayLocation(latitude, longitude, options)
  if (norway) {
    if (typeof options.onUpdate === 'function') {
      queueInternationalLookup(() => lookupInternationalLocation(latitude, longitude, options))
        .then(international => {
          options.onUpdate(mergeLocationLookupResults(norway, international))
        })
        .catch(() => {})
    }
    return norway
  }

  return queueInternationalLookup(() => lookupInternationalLocation(latitude, longitude, options))
}

export function mergeLocationLookupResults(primary, secondary) {
  const countryCode = primary?.country_code || secondary?.country_code || null
  return normalizeLocationLookupResult({
    suggestions: [
      ...(primary?.suggestions || []),
      ...(secondary?.suggestions || []),
    ],
    latitude: primary?.latitude ?? secondary?.latitude ?? null,
    longitude: primary?.longitude ?? secondary?.longitude ?? null,
    country_code: countryCode,
    country_name: primary?.country_name || secondary?.country_name || null,
    nominatim_display_name: secondary?.nominatim_display_name || primary?.nominatim_display_name || null,
    debug: secondary?.debug || primary?.debug || null,
    source: primary?.source || secondary?.source || null,
  })
}

async function lookupInternationalLocation(latitude, longitude, options = {}) {
  if (LOCATION_LOOKUP_BASE_URL) {
    try {
      const url = new URL(`${LOCATION_LOOKUP_BASE_URL}/reverse-location`)
      url.searchParams.set('lat', String(latitude))
      url.searchParams.set('lon', String(longitude))
      url.searchParams.set('prefer', 'international')
      const payload = await fetchJson(url, options)
      return normalizeLocationLookupResult(payload, latitude, longitude)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
    }
  }

  return lookupReverseLocationDirect(latitude, longitude, options)
}

async function lookupNorwayLocation(lat, lon, options = {}) {
  try {
    const url = new URL('https://stedsnavn.artsdatabanken.no/v1/punkt')
    url.searchParams.set('lat', String(lat))
    url.searchParams.set('lng', String(lon))
    url.searchParams.set('zoom', '45')
    const artsdata = await fetchJson(url, options)
    const name = _stringOrNull(artsdata?.navn)
    const dist = Number(artsdata?.dist)
    if (!name || !Number.isFinite(dist) || dist > ARTS_MAX_DIST) return null
    return normalizeLocationLookupResult({
      suggestions: [name],
      latitude: lat,
      longitude: lon,
      country_code: 'no',
      country_name: 'Norge',
      source: 'artsdatabanken',
    }, lat, lon)
  } catch (_) {
    return null
  }
}

function queueInternationalLookup(task) {
  const run = internationalLookupQueue
    .catch(() => {})
    .then(async () => {
      const elapsed = Date.now() - lastInternationalLookupStartedAt
      if (elapsed < INTERNATIONAL_LOOKUP_INTERVAL_MS) {
        await delay(INTERNATIONAL_LOOKUP_INTERVAL_MS - elapsed)
      }
      lastInternationalLookupStartedAt = Date.now()
      return task()
    })
  internationalLookupQueue = run.catch(() => {})
  return run
}

async function lookupReverseLocationDirect(lat, lon, options = {}) {
  let nominatim = null
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse')
    url.searchParams.set('lat', String(lat))
    url.searchParams.set('lon', String(lon))
    url.searchParams.set('format', 'json')
    url.searchParams.set('addressdetails', '1')
    nominatim = await fetchJson(url, options)
  } catch (_) {}

  const address = nominatim?.address || {}
  const countryCode = String(address.country_code || '').trim().toLowerCase()
  const nominatimDetails = buildLocationSuggestionsFromNominatim(nominatim || {})
  let suggestions = [...nominatimDetails.suggestions]
  let source = 'nominatim'

  if (countryCode === 'no') {
    try {
      const url = new URL('https://stedsnavn.artsdatabanken.no/v1/punkt')
      url.searchParams.set('lat', String(lat))
      url.searchParams.set('lng', String(lon))
      url.searchParams.set('zoom', '45')
      const artsdata = await fetchJson(url, options)
      const name = _stringOrNull(artsdata?.navn)
      const dist = Number(artsdata?.dist)
      if (name && Number.isFinite(dist) && dist <= 0.006) {
        suggestions = [name, ...nominatimDetails.suggestions]
        source = 'artsdatabanken'
      }
    } catch (_) {}
  } else if (countryCode === 'dk') {
    try {
      const url = new URL('https://api.dataforsyningen.dk/adgangsadresser/reverse')
      url.searchParams.set('x', String(lon))
      url.searchParams.set('y', String(lat))
      const dawa = await fetchJson(url, options)
      const label = buildDawaSuggestion(dawa)
      if (label) {
        suggestions = [label, ...nominatimDetails.suggestions]
        source = 'dawa'
      }
    } catch (_) {}
  }

  const finalSuggestions = dedupeText(suggestions).slice(0, MAX_LOCATION_SUGGESTIONS)
  const locationDebug = {
    raw_nominatim_display_name: nominatimDetails.nominatim_display_name,
    structured_address_fields_used: nominatimDetails.structured_address_fields_used,
    display_name_parts_used: nominatimDetails.display_name_parts_used,
    final_suggestions: finalSuggestions,
  }

  if (nominatim) {
    recordDebugJsonResponse({
      source: 'location-lookup',
      label: 'location lookup summary',
      endpoint: 'https://nominatim.openstreetmap.org/reverse',
      status: 200,
      ok: true,
      body: {
        ...locationDebug,
        country_code: countryCode || null,
        country_name: address.country || null,
        source,
      },
    })
  }

  return normalizeLocationLookupResult({
    suggestions: finalSuggestions,
    latitude: lat,
    longitude: lon,
    country_code: countryCode,
    country_name: address.country,
    nominatim_display_name: nominatim?.display_name,
    debug: locationDebug,
    source,
  }, lat, lon)
}

export function buildNominatimSuggestions(address = {}, displayName = '') {
  return buildLocationSuggestionsFromNominatim({
    address,
    display_name: displayName,
  }).suggestions
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: options.signal,
    headers: { Accept: 'application/json' },
  })
  const payload = await response.json().catch(() => null)
  recordDebugJsonResponse({
    source: 'location-lookup',
    label: String(url),
    endpoint: String(url),
    status: response.status,
    ok: response.ok,
    body: payload,
  })
  if (!response.ok) throw new Error(`Location lookup failed: ${response.status}`)
  return payload
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function _stringOrNull(value) {
  const text = String(value || '').trim()
  return text || null
}

function _finiteOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
