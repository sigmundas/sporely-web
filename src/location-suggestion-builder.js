const MAX_LOCATION_SUGGESTIONS = 8
const POSTAL_CODE_RE = /^\d{4,6}$/
const COUNTRY_ALIASES_BY_CODE = new Map([
  ['NO', ['Norge', 'Norway', 'Noreg']],
  ['DK', ['Danmark', 'Denmark']],
  ['SE', ['Sverige', 'Sweden']],
  ['FI', ['Suomi', 'Finland']],
  ['IS', ['Ísland', 'Iceland']],
  ['FO', ['Føroyar', 'Faroe Islands']],
  ['GL', ['Kalaallit Nunaat', 'Greenland']],
  ['AX', ['Aland', 'Åland', 'Aland Islands', 'Åland Islands']],
])

export { MAX_LOCATION_SUGGESTIONS }

export function buildLocationSuggestionsFromNominatim(payload = {}) {
  const address = _objectOrNull(payload?.address)
  const nominatimDisplayName = _stringOrNull(
    payload?.display_name || payload?.nominatim_display_name || payload?.nominatimDisplayName
  )
  const structured = _buildStructuredLocationSuggestions(address)
  const displayNameParts = _cleanDisplayNameParts(nominatimDisplayName, address).slice(0, 5)
  const useStructuredSuggestions = Boolean(structured.fieldsUsed.house_number)
  const suggestions = dedupeText(
    useStructuredSuggestions
      ? structured.suggestions
      : (displayNameParts.length ? displayNameParts : structured.suggestions)
  ).slice(0, MAX_LOCATION_SUGGESTIONS)

  return {
    suggestions,
    nominatim_display_name: nominatimDisplayName,
    structured_address_fields_used: structured.fieldsUsed,
    display_name_parts_used: displayNameParts,
  }
}

export function buildDawaSuggestion(dawa = {}) {
  return dedupeText([
    dawa?.vejstykke?.navn,
    _nonPostalText(dawa?.postnummer?.navn),
    dawa?.kommune?.navn,
    dawa?.region?.navn,
    'Danmark',
  ]).join(', ')
}

export function dedupeText(values) {
  const seen = new Set()
  const result = []
  for (const value of values || []) {
    const text = _stringOrNull(value)
    if (!text) continue
    const key = _normalizeKey(text)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function _buildStructuredLocationSuggestions(address = {}) {
  const fieldsUsed = {}
  const street = _pickFirstField(address, [
    'road',
    'footway',
    'path',
    'pedestrian',
    'cycleway',
    'track',
    'living_street',
  ])
  const houseNumber = _stringOrNull(address.house_number)
  const streetLabel = street?.value
    ? _composeStreetLabel(street.value, houseNumber)
    : null
  if (streetLabel) {
    fieldsUsed.place = { field: street.field, value: streetLabel }
    if (houseNumber) {
      fieldsUsed.house_number = { field: 'house_number', value: houseNumber }
    }
  }

  const place = streetLabel ? null : _pickFirstField(address, [
    'amenity',
    'neighbourhood',
    'suburb',
    'hamlet',
    'village',
    'town',
    'city',
    'locality',
  ])
  if (place) fieldsUsed.place = place

  const municipality = _pickFirstField(address, [
    'municipality',
    'municipality_district',
    'city',
    'town',
    'village',
    'hamlet',
    'locality',
    'suburb',
    'neighbourhood',
    'borough',
    'district',
  ], [place?.value])
  if (municipality) fieldsUsed.municipality = municipality

  const region = _pickFirstField(address, [
    'county',
    'state',
    'region',
    'state_district',
    'province',
  ], [place?.value, municipality?.value])
  if (region) fieldsUsed.region = region

  const country = _pickFirstField(address, [
    'country',
  ], [place?.value, municipality?.value, region?.value])
  if (country) fieldsUsed.country = country

  const levels = []
  if (streetLabel) {
    levels.push(streetLabel)
    if (_normalizeKey(street?.value) !== _normalizeKey(streetLabel)) {
      levels.push(street.value)
    }
  } else if (place?.value) {
    levels.push(place.value)
  }
  if (municipality?.value) levels.push(municipality.value)
  if (region?.value) levels.push(region.value)
  if (!levels.length && country?.value) {
    return {
      suggestions: [country.value],
      fieldsUsed,
    }
  }

  return {
    suggestions: _buildOrderedSuggestions(levels),
    fieldsUsed,
  }
}

function _buildOrderedSuggestions(parts) {
  return dedupeText(parts)
}

function _composeStreetLabel(streetName, houseNumber) {
  const street = _stringOrNull(streetName)
  if (!street) return null
  const number = _stringOrNull(houseNumber)
  if (!number) return street
  return `${street} ${number}`
}

function _cleanDisplayNameParts(displayName, address = {}) {
  const parts = String(displayName || '')
    .split(',')
    .map(part => _stringOrNull(part))
    .filter(Boolean)

  if (!parts.length) return []

  const filtered = parts.filter(part => !_isPostalCodeLike(part))
  const countryAliases = _countryAliases(address)

  while (filtered.length > 1 && _isCountryLikePart(filtered[filtered.length - 1], countryAliases)) {
    filtered.pop()
  }

  return dedupeText(filtered)
}

function _countryAliases(address = {}) {
  const aliases = new Set()
  const countryName = _stringOrNull(address.country)
  if (countryName) aliases.add(_normalizeKey(countryName))

  const countryCode = _stringOrNull(address.country_code).toUpperCase()
  if (countryCode) {
    const codeAliases = COUNTRY_ALIASES_BY_CODE.get(countryCode) || []
    for (const alias of codeAliases) {
      aliases.add(_normalizeKey(alias))
    }
    if (typeof globalThis.Intl?.DisplayNames === 'function') {
      for (const locale of ['nb', 'en']) {
        try {
          const displayNames = new Intl.DisplayNames([locale], { type: 'region' })
          const localized = displayNames.of(countryCode)
          if (localized) aliases.add(_normalizeKey(localized))
        } catch (_) {}
      }
    }
  }

  return aliases
}

function _isCountryLikePart(value, countryAliases) {
  const key = _normalizeKey(value)
  if (!key) return false
  return countryAliases.has(key)
}

function _pickFirstField(address, fields, excludedValues = []) {
  const excluded = new Set(
    (excludedValues || [])
      .map(value => _normalizeKey(value))
      .filter(Boolean)
  )
  for (const field of fields) {
    const value = _stringOrNull(address?.[field])
    if (!value) continue
    const key = _normalizeKey(value)
    if (excluded.has(key)) continue
    return { field, value }
  }
  return null
}

function _isPostalCodeLike(value) {
  const text = _stringOrNull(value)
  if (!text) return false
  return POSTAL_CODE_RE.test(text)
}

function _nonPostalText(value) {
  const text = _stringOrNull(value)
  if (!text || _isPostalCodeLike(text)) return null
  return text
}

function _normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function _objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function _stringOrNull(value) {
  const text = String(value || '').trim()
  return text || null
}
