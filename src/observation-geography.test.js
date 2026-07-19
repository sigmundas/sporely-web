import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeCountryCodeForObservation,
  normalizeObservationGeography,
  normalizeRegionIdForObservation,
} from './observation-geography.js'

test('normalizeCountryCodeForObservation accepts ISO-shaped country codes and rejects malformed values', () => {
  assert.equal(normalizeCountryCodeForObservation(null), null)
  assert.equal(normalizeCountryCodeForObservation(''), null)
  assert.equal(normalizeCountryCodeForObservation('  '), null)
  assert.equal(normalizeCountryCodeForObservation('Norway'), null)
  assert.equal(normalizeCountryCodeForObservation('N'), null)
  assert.equal(normalizeCountryCodeForObservation('123'), null)

  assert.equal(normalizeCountryCodeForObservation('no'), 'NO')
  assert.equal(normalizeCountryCodeForObservation(' ca '), 'CA')
  assert.equal(normalizeCountryCodeForObservation('us'), 'US')
})

test('normalizeObservationGeography keeps only valid country and region values', () => {
  assert.deepEqual(normalizeObservationGeography(null), {})
  assert.deepEqual(normalizeObservationGeography({}), {})
  assert.deepEqual(normalizeObservationGeography({
    country_code: 'ca',
    region_id: '  region-123  ',
  }), {
    country_code: 'CA',
    region_id: 'region-123',
  })
  assert.deepEqual(normalizeObservationGeography({
    country_code: 'Norway',
    region_id: '   ',
  }), {})
})

test('normalizeRegionIdForObservation trims whitespace and omits blank values', () => {
  assert.equal(normalizeRegionIdForObservation(null), null)
  assert.equal(normalizeRegionIdForObservation(''), null)
  assert.equal(normalizeRegionIdForObservation('   '), null)
  assert.equal(normalizeRegionIdForObservation('region-456'), 'region-456')
})
