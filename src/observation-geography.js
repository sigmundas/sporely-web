function _normalizeCountryCode(value) {
  const code = String(value ?? '').trim().toUpperCase()
  if (!code) return null
  return /^[A-Z]{2}$/.test(code) ? code : null
}

function _normalizeRegionId(value) {
  const regionId = String(value ?? '').trim()
  return regionId || null
}

export function normalizeObservationGeography(value = null) {
  if (!value || typeof value !== 'object') return {}

  const countryCode = _normalizeCountryCode(value.country_code)
  const regionId = _normalizeRegionId(value.region_id)

  const out = {}
  if (countryCode) out.country_code = countryCode
  if (regionId) out.region_id = regionId
  return out
}

export function normalizeCountryCodeForObservation(value) {
  return _normalizeCountryCode(value)
}

export function normalizeRegionIdForObservation(value) {
  return _normalizeRegionId(value)
}
