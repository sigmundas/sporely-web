// External map service links for an observation's location.
//
// Every link is built from the coordinates the current viewer is already
// allowed to see. Non-owners receive fuzzed coordinates from the database
// views (`round(gps_latitude, 2)`), so the only exposure risk left is on the
// client: a link that carries more precision than the screen does, or one that
// drops a pin on a fuzzed point and so presents ~1 km of uncertainty as an
// exact spot. Both are handled here rather than at each call site.
//
// - Owners get their own exact coordinates with a pin. Navigating back to a
//   find is the point of the feature and the owner already sees 5 decimals in
//   the detail screen.
// - Anyone else looking at an obscured find gets the coordinates clamped to the
//   same 2-decimal grid the server fuzzes to (defence in depth: a future view
//   or cache that leaked exact values could not widen the link), centred at a
//   coarse zoom with no marker.
//
// Links carry coordinates only — never the species, notes, or observation id —
// so nothing identifying leaves the app in a URL the user may paste elsewhere.

import { normalizeCoordinatePair } from './observation-shapes.js'

export const MAP_LINK_SERVICES = ['google', 'mapy', 'osm']

// Matches the server-side `round(gps_latitude::numeric, 2)` fuzzing grid.
const FUZZED_DECIMALS = 2
const EXACT_DECIMALS = 6
const EXACT_ZOOM = 17
const FUZZED_ZOOM = 12

function _round(value, decimals) {
  return Number(value.toFixed(decimals))
}

/**
 * Decide which coordinates and what presentation an external link may use.
 *
 * @param {object} options
 * @param {unknown} options.lat
 * @param {unknown} options.lon
 * @param {boolean} [options.isOwner] whether the viewer owns the observation
 * @param {unknown} [options.locationPrecision] the observation's `location_precision`
 * @returns {{ lat: number, lon: number, precise: boolean, zoom: number } | null}
 */
export function resolveExternalMapCoordinates({ lat, lon, isOwner = false, locationPrecision = 'exact' } = {}) {
  const coords = normalizeCoordinatePair(lat, lon)
  if (!coords) return null

  const obscured = String(locationPrecision || 'exact').trim().toLowerCase() === 'fuzzed'
  // The owner is the one person entitled to the exact position of an obscured
  // find; for everyone else obscured means obscured, in the link too.
  const precise = !obscured || isOwner === true
  const decimals = precise ? EXACT_DECIMALS : FUZZED_DECIMALS

  return {
    lat: _round(coords.lat, decimals),
    lon: _round(coords.lon, decimals),
    precise,
    zoom: precise ? EXACT_ZOOM : FUZZED_ZOOM,
  }
}

function _googleUrl({ lat, lon, precise, zoom }) {
  return precise
    ? `https://www.google.com/maps/search/?api=1&query=${lat}%2C${lon}`
    : `https://www.google.com/maps/@${lat},${lon},${zoom}z`
}

function _mapyUrl({ lat, lon, precise, zoom }) {
  const base = `https://mapy.com/en/turisticka?x=${lon}&y=${lat}&z=${zoom}`
  return precise ? `${base}&source=coor&id=${lon}%2C${lat}` : base
}

function _osmUrl({ lat, lon, precise, zoom }) {
  return precise
    ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`
    : `https://www.openstreetmap.org/#map=${zoom}/${lat}/${lon}`
}

const BUILDERS = {
  google: _googleUrl,
  mapy: _mapyUrl,
  osm: _osmUrl,
}

/**
 * Build the external-map URL for one service, or `null` when the observation
 * has no usable coordinates.
 *
 * @param {'google'|'mapy'|'osm'} service
 * @param {object} options same shape as `resolveExternalMapCoordinates`
 * @returns {string | null}
 */
export function buildExternalMapUrl(service, options = {}) {
  const build = BUILDERS[service]
  if (!build) return null
  const resolved = resolveExternalMapCoordinates(options)
  return resolved ? build(resolved) : null
}

/**
 * Build every external-map link for a location, in menu order.
 *
 * @param {object} options same shape as `resolveExternalMapCoordinates`
 * @returns {Array<{ service: string, url: string }>} empty when unusable
 */
export function buildExternalMapLinks(options = {}) {
  const resolved = resolveExternalMapCoordinates(options)
  if (!resolved) return []
  return MAP_LINK_SERVICES.map(service => ({
    service,
    url: BUILDERS[service](resolved),
  }))
}
