import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDawaSuggestion,
  buildLocationSuggestionsFromNominatim,
  normalizeLocationLookupResult,
} from './location-lookup.js'

test('buildLocationSuggestionsFromNominatim uses flat Nominatim hierarchy up to county level', () => {
  const result = buildLocationSuggestionsFromNominatim({
    display_name: 'Minillastien, Rennebu, Trøndelag, 7393, Norge',
    address: {
      road: 'Minillastien',
      municipality: 'Rennebu',
      county: 'Trøndelag',
      postcode: '7393',
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, [
    'Minillastien',
    'Rennebu',
    'Trøndelag',
  ])
  assert.equal(result.suggestions.every(value => !value.includes(',')), true)
  assert.equal(result.nominatim_display_name, 'Minillastien, Rennebu, Trøndelag, 7393, Norge')
  assert.deepEqual(result.structured_address_fields_used, {
    place: { field: 'road', value: 'Minillastien' },
    municipality: { field: 'municipality', value: 'Rennebu' },
    region: { field: 'county', value: 'Trøndelag' },
    country: { field: 'country', value: 'Norge' },
  })
  assert.deepEqual(result.display_name_parts_used, [
    'Minillastien',
    'Rennebu',
    'Trøndelag',
  ])
})

test('buildLocationSuggestionsFromNominatim accepts nominatim_display_name as an input alias', () => {
  const result = buildLocationSuggestionsFromNominatim({
    nominatim_display_name: 'Minillastien, Rennebu, Trøndelag, 7393, Norge',
    address: {
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, [
    'Minillastien',
    'Rennebu',
    'Trøndelag',
  ])
  assert.equal(result.nominatim_display_name, 'Minillastien, Rennebu, Trøndelag, 7393, Norge')
})

test('buildLocationSuggestionsFromNominatim formats house numbers after street names', () => {
  const result = buildLocationSuggestionsFromNominatim({
    display_name: '10, Strandvegen, Flatanger, Trøndelag, Norge',
    address: {
      road: 'Strandvegen',
      house_number: '10',
      municipality: 'Flatanger',
      county: 'Trøndelag',
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, [
    'Strandvegen 10',
    'Strandvegen',
    'Flatanger',
    'Trøndelag',
  ])
  assert.equal(result.suggestions.includes('10'), false)
})

test('buildLocationSuggestionsFromNominatim falls back to parsed display_name and drops country-only labels when a better location exists', () => {
  const result = buildLocationSuggestionsFromNominatim({
    display_name: 'Minillastien, Rennebu, Trøndelag, 7393, Norge',
    address: {
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, [
    'Minillastien',
    'Rennebu',
    'Trøndelag',
  ])
  assert.equal(result.suggestions.includes('Norge'), false)
})

test('buildLocationSuggestionsFromNominatim ignores house numbers when the location is not street-shaped', () => {
  const result = buildLocationSuggestionsFromNominatim({
    display_name: 'Haraskåret, Flatanger, Trøndelag, Norge',
    address: {
      village: 'Haraskåret',
      house_number: '10',
      county: 'Trøndelag',
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, [
    'Haraskåret',
    'Flatanger',
    'Trøndelag',
  ])
  assert.equal(result.suggestions.includes('10'), false)
})

test('buildLocationSuggestionsFromNominatim keeps country-only output when nothing better exists', () => {
  const result = buildLocationSuggestionsFromNominatim({
    display_name: 'Norge',
    address: {
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, ['Norge'])
})

test('buildLocationSuggestionsFromNominatim keeps a single non-country parsed part over country-only structured data', () => {
  const result = buildLocationSuggestionsFromNominatim({
    display_name: 'Trøndelag, Norge',
    address: {
      country: 'Norge',
      country_code: 'no',
    },
  })

  assert.deepEqual(result.suggestions, ['Trøndelag'])
})

test('buildDawaSuggestion skips numeric postal codes and normalizeLocationLookupResult keeps eight unique entries', () => {
  assert.equal(
    buildDawaSuggestion({
      vejstykke: { navn: 'Søndergade' },
      postnummer: { navn: '7100' },
      kommune: { navn: 'Vejle' },
      region: { navn: 'Region Syddanmark' },
    }),
    'Søndergade, Vejle, Region Syddanmark, Danmark',
  )

  const result = normalizeLocationLookupResult({
    country_code: 'no',
    suggestions: ['A', 'a', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
  })

  assert.deepEqual(result.suggestions, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
})
