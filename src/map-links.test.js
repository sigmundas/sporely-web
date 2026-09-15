import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAP_LINK_SERVICES,
  buildExternalMapLinks,
  buildExternalMapUrl,
  resolveExternalMapCoordinates,
} from './map-links.js'

// An exact coordinate with more decimals than any link should ever need, so a
// clamp that fails to apply is visible in the URL rather than rounded away.
const EXACT = { lat: 63.4305149, lon: 10.3950831 }

test('an owner viewing an exact find gets a pinned link at full precision', () => {
  const links = buildExternalMapLinks({ ...EXACT, isOwner: true, locationPrecision: 'exact' })
  assert.deepEqual(links.map(link => link.service), MAP_LINK_SERVICES)

  const byService = Object.fromEntries(links.map(link => [link.service, link.url]))
  assert.equal(byService.google, 'https://www.google.com/maps/search/?api=1&query=63.430515%2C10.395083')
  assert.equal(byService.mapy, 'https://mapy.com/en/turisticka?x=10.395083&y=63.430515&z=17&source=coor&id=10.395083%2C63.430515')
  assert.equal(byService.osm, 'https://www.openstreetmap.org/?mlat=63.430515&mlon=10.395083#map=17/63.430515/10.395083')
})

// The database views already round a fuzzed find to 2 decimals for anyone but
// the owner. The clamp here is the second line of defence: if a view, cache or
// future RPC ever handed a viewer the exact value, the link must not carry it
// out of the app.
test('a non-owner link to an obscured find is clamped to the 2-decimal fuzzing grid', () => {
  for (const service of MAP_LINK_SERVICES) {
    const url = buildExternalMapUrl(service, { ...EXACT, isOwner: false, locationPrecision: 'fuzzed' })
    assert.ok(url.includes('63.43'), `${service} keeps the coarse latitude`)
    assert.ok(!url.includes('63.4305'), `${service} must not leak the exact latitude`)
    assert.ok(!url.includes('10.3950'), `${service} must not leak the exact longitude`)
  }
})

test('an obscured find is centred without a pin for a non-owner, and pinned for its owner', () => {
  const viewer = Object.fromEntries(
    buildExternalMapLinks({ ...EXACT, isOwner: false, locationPrecision: 'fuzzed' })
      .map(link => [link.service, link.url]),
  )
  // A pin on a ~1 km fuzzed point would present the obscured location as an
  // exact one, so the coarse links centre the map instead.
  assert.ok(!viewer.google.includes('search'))
  assert.ok(!viewer.mapy.includes('source=coor'))
  assert.ok(!viewer.osm.includes('mlat'))
  assert.ok(viewer.osm.includes('#map=12/'), 'coarse links open at a coarse zoom')

  const owner = Object.fromEntries(
    buildExternalMapLinks({ ...EXACT, isOwner: true, locationPrecision: 'fuzzed' })
      .map(link => [link.service, link.url]),
  )
  assert.ok(owner.osm.includes('mlat=63.430515'), 'the owner keeps a precise pin on their own find')
})

test('links carry coordinates only', () => {
  const links = buildExternalMapLinks({
    ...EXACT,
    isOwner: true,
    locationPrecision: 'exact',
    // Nothing identifying may reach the URL even if a caller passes it along.
    species: 'Cantharellus cibarius',
    id: 'obs-1',
  })
  for (const { service, url } of links) {
    assert.ok(!/cantharellus|obs-1/i.test(url), `${service} URL stays coordinate-only`)
  }
})

test('unusable coordinates produce no link at all', () => {
  for (const coords of [{ lat: null, lon: null }, { lat: 0, lon: 0 }, { lat: 95, lon: 10 }, { lat: 'x', lon: 'y' }]) {
    assert.equal(resolveExternalMapCoordinates(coords), null)
    assert.deepEqual(buildExternalMapLinks(coords), [])
    assert.equal(buildExternalMapUrl('google', coords), null)
  }
})

test('an unknown service is refused rather than guessed at', () => {
  assert.equal(buildExternalMapUrl('bing', { ...EXACT, isOwner: true }), null)
})
