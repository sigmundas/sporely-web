import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  buildIdentifyFingerprint,
  getIdentifyTopProbability,
  loadObservationIdentifications,
  markIdentificationStaleIfFingerprintChanged,
  markRequestedServicesRunning,
  maybeLoadCachedIdentification,
  formatAiSuggestionDisplay,
  renderIdentifyResultRows,
  renderIdentifyServiceTab,
  renderIdentifyServiceStateSummary,
  resetObservationIdentificationsTableAvailabilityForTests,
  runIdentifyComparisonForBlobs,
  saveIdentificationRun,
  isTerminalAiServiceState,
  canRunService,
  canViewServiceResult,
  shouldRunServiceFromTab,
} from './ai-identification.js'

function createSupabaseStub() {
  const rows = []

  const clone = value => JSON.parse(JSON.stringify(value))

  function matches(row, filters = []) {
    return filters.every(filter => {
      if (filter.op === 'eq') return row?.[filter.field] === filter.value
      if (filter.op === 'neq') return row?.[filter.field] !== filter.value
      return true
    })
  }

  function applyOrder(list, orderBy) {
    if (!orderBy) return list
    const { field, ascending } = orderBy
    return [...list].sort((a, b) => {
      const left = a?.[field]
      const right = b?.[field]
      if (left === right) return 0
      if (left === undefined || left === null) return ascending ? -1 : 1
      if (right === undefined || right === null) return ascending ? 1 : -1
      return ascending
        ? String(left).localeCompare(String(right))
        : String(right).localeCompare(String(left))
    })
  }

  class Query {
    constructor(table, action = 'select', payload = null) {
      this.table = table
      this.action = action
      this.payload = payload
      this.filters = []
      this.orderBy = null
    }

    select() { return this }
    eq(field, value) { this.filters.push({ op: 'eq', field, value }); return this }
    neq(field, value) { this.filters.push({ op: 'neq', field, value }); return this }
    order(field, options = {}) { this.orderBy = { field, ascending: options.ascending !== false }; return this }
    maybeSingle() { return Promise.resolve(this._executeMaybeSingle()) }
    then(resolve, reject) {
      try {
        resolve(this.action === 'select' ? this._executeSelect() : this._executeMaybeSingle())
      } catch (error) {
        reject?.(error)
      }
    }

    _executeMaybeSingle() {
      if (this.action === 'insert') {
        const record = {
          ...clone(this.payload),
          id: this.payload.id || `row-${rows.length + 1}`,
          created_at: this.payload.created_at || new Date().toISOString(),
          updated_at: this.payload.updated_at || new Date().toISOString(),
        }
        rows.push(record)
        return { data: clone(record), error: null }
      }

      if (this.action === 'update') {
        const updated = []
        for (const row of rows) {
          if (!matches(row, this.filters)) continue
          Object.assign(row, clone(this.payload))
          if (!row.updated_at) row.updated_at = new Date().toISOString()
          updated.push(clone(row))
        }
        return { data: updated[0] || null, error: null }
      }

      const results = applyOrder(rows.filter(row => matches(row, this.filters)).map(clone), this.orderBy)
      return { data: results[0] || null, error: null }
    }

    _executeSelect() {
      const results = applyOrder(rows.filter(row => matches(row, this.filters)).map(clone), this.orderBy)
      return { data: results, error: null }
    }
  }

  return {
    rows,
    from() {
      return {
        select: () => new Query('observation_identifications', 'select'),
        insert: payload => new Query('observation_identifications', 'insert', payload),
        update: payload => new Query('observation_identifications', 'update', payload),
      }
    },
  }
}

test('comparison helper skips unavailable iNaturalist and keeps Artsorakel active', async () => {
  const availability = {
    artsorakel: { service: 'artsorakel', available: true, reason: '' },
    inat: { service: 'inat', available: false, reason: 'Please log in to iNaturalist first.' },
  }
  const calls = []

  const result = await runIdentifyComparisonForBlobs([new Blob(['x'], { type: 'image/jpeg' })], {
    availability,
    identifyBlobs: async (_blobs, service) => {
      calls.push(service)
      return service === 'artsorakel'
        ? [{ scientificName: 'Amanita muscaria', vernacularName: 'Fly agaric', probability: 0.91 }]
        : []
    },
  })

  assert.deepEqual(calls, ['artsorakel'])
  assert.equal(result.activeService, 'artsorakel')
  assert.equal(result.resultsByService.artsorakel.status, 'success')
  assert.equal(result.resultsByService.inat.status, 'unavailable')
})

test('comparison helper preserves the working service when the other one fails', async () => {
  const availability = {
    artsorakel: { service: 'artsorakel', available: true, reason: '' },
    inat: { service: 'inat', available: true, reason: '' },
  }

  const result = await runIdentifyComparisonForBlobs([new Blob(['x'], { type: 'image/jpeg' })], {
    availability,
    identifyBlobs: async (_blobs, service) => {
      if (service === 'artsorakel') {
        return [{ scientificName: 'Morchella esculenta', vernacularName: 'Morel', probability: 0.84 }]
      }
      throw new Error('inat failed')
    },
  })

  assert.equal(result.resultsByService.artsorakel.status, 'success')
  assert.equal(result.resultsByService.inat.status, 'error')
  assert.equal(result.resultsByService.artsorakel.predictions[0].scientificName, 'Morchella esculenta')
})

test('observation identification cache helpers tolerate a missing production table', async () => {
  const missingTableError = {
    code: 'PGRST205',
    message: "Could not find the table 'public.observation_identifications' in the schema cache",
  }

  class MissingTableQuery {
    select() { return this }
    eq() { return this }
    order() { return this }
    update() { return this }
    insert() { return this }
    neq() { return this }
    maybeSingle() { return Promise.resolve({ data: null, error: missingTableError }) }
    then(resolve) {
      resolve({ data: null, error: missingTableError })
    }
  }

  const client = {
    from() {
      return new MissingTableQuery()
    },
  }

  assert.deepEqual(await loadObservationIdentifications('obs-1', { supabaseClient: client }), [])
  assert.equal(await maybeLoadCachedIdentification({
    observationId: 'obs-1',
    service: 'artsorakel',
    requestFingerprint: 'fingerprint',
    supabaseClient: client,
  }), null)
  assert.equal(await saveIdentificationRun({
    observationId: 'obs-1',
    userId: 'user-1',
    service: 'artsorakel',
    requestFingerprint: 'fingerprint',
    results: [],
    supabaseClient: client,
  }), null)
})

test('saveIdentificationRun preserves Artsorakel taxon.picture and omits invalid GBIF external ids', async () => {
  resetObservationIdentificationsTableAvailabilityForTests()
  const client = createSupabaseStub()

  const artsorakel = await saveIdentificationRun({
    observationId: 'obs-compact-arts-nia',
    userId: 'user-1',
    service: 'artsorakel',
    requestFingerprint: 'req-arts-nia',
    imageFingerprint: 'img-arts-nia',
    cropFingerprint: 'crop-arts-nia',
    language: 'en',
    results: [
      {
        rank: 1,
        scientificName: 'Top species',
        vernacularName: 'Top common',
        probability: 0.97,
        taxon: {
          scientific_name: 'Top species',
          scientific_name_id: 'NBIC:185988',
          scientific_name_id_shared: 'NIA:d7a2ee18ff94f4dd8b8e2a0ef9efda0aea75d993eec9e66af72182ff',
          infoUrl: 'https://artsdatabanken.no/Taxon/203764',
          picture: 'https://artsdatabanken.no/Media/F47031?mode=128x128',
          redListCategory: 'LC',
          redListSource: 'Artsdatabanken',
        },
      },
    ],
    supabaseClient: client,
  })

  assert.equal(artsorakel.results.length, 1)
  assert.equal(artsorakel.top_scientific_name, 'Top species')
  assert.equal(artsorakel.top_taxon_id, 'NBIC:185988')
  assert.equal(artsorakel.top_species_url, 'https://artsdatabanken.no/Taxon/203764')
  assert.equal(artsorakel.top_redlist_category, 'LC')

  const storedArtsorakel = client.rows[0].results[0]
  assert.equal(storedArtsorakel.scientific_name, 'Top species')
  assert.equal(storedArtsorakel.vernacular_name, 'Top common')
  assert.equal(storedArtsorakel.taxon_id, 'NBIC:185988')
  assert.equal(storedArtsorakel.species_url, 'https://artsdatabanken.no/Taxon/203764')
  assert.equal(storedArtsorakel.picture_url, 'https://artsdatabanken.no/Media/F47031?mode=128x128')
  assert.equal(storedArtsorakel.redlist_category, 'LC')
  assert.equal(storedArtsorakel.redlist_source, 'Artsdatabanken')
  assert.equal(Object.prototype.hasOwnProperty.call(storedArtsorakel, 'external_ids'), false)
})

test('saveIdentificationRun stores compact candidates and keeps top fields from the highest-ranked one', async () => {
  resetObservationIdentificationsTableAvailabilityForTests()
  const client = createSupabaseStub()

  const artsorakel = await saveIdentificationRun({
    observationId: 'obs-compact-arts',
    userId: 'user-1',
    service: 'artsorakel',
    requestFingerprint: 'req-arts',
    imageFingerprint: 'img-arts',
    cropFingerprint: 'crop-arts',
    language: 'en',
    results: [
      {
        rank: 2,
        scientificName: 'Second species',
        vernacularName: 'Second common',
        taxonId: 'NBIC:200000',
        speciesUrl: 'https://artsdatabanken.no/Taxon/200000',
        redlistCategory: 'NT',
        probability: 0.42,
        raw: {
          taxon: {
            scientific_name_id_shared: 'GBIF:2000000',
          },
        },
      },
      {
        rank: 1,
        scientificName: 'Top species',
        vernacularName: 'Top common',
        probability: 0.97,
        pictureUrl: 'https://artsdatabanken.no/Media/F47031?mode=128x128',
        taxon: {
          scientific_name_id: 'NBIC:185988',
          scientific_name_id_shared: 'GBIF:6092830',
          infoUrl: 'https://artsdatabanken.no/Taxon/203764',
          redListCategory: 'LC',
          redListSource: 'Artsdatabanken',
        },
      },
    ],
    supabaseClient: client,
  })

  assert.equal(artsorakel.results.length, 2)
  assert.equal(artsorakel.top_scientific_name, 'Top species')
  assert.equal(artsorakel.top_vernacular_name, 'Top common')
  assert.equal(artsorakel.top_taxon_id, 'NBIC:185988')
  assert.equal(artsorakel.top_probability, 0.97)
  assert.equal(artsorakel.top_species_url, 'https://artsdatabanken.no/Taxon/203764')
  assert.equal(artsorakel.top_redlist_category, 'LC')
  assert.equal(artsorakel.top_redlist_source, 'Artsdatabanken')

  const storedArtsorakel = client.rows[0].results
  assert.equal(storedArtsorakel.length, 2)
  assert.equal(storedArtsorakel[0].rank, 2)
  assert.equal(storedArtsorakel[1].rank, 1)
  for (const candidate of storedArtsorakel) {
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'raw'), false)
    for (const field of ['scientificName', 'vernacularName', 'taxonId', 'speciesUrl', 'redlistCategory']) {
      assert.equal(Object.prototype.hasOwnProperty.call(candidate, field), false)
    }
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'scientific_name'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'vernacular_name'), true)
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, 'taxon_id'), true)
  }
  assert.equal(storedArtsorakel[0].scientific_name, 'Second species')
  assert.equal(storedArtsorakel[0].vernacular_name, 'Second common')
  assert.equal(storedArtsorakel[0].taxon_id, 'NBIC:200000')
  assert.equal(storedArtsorakel[0].species_url, 'https://artsdatabanken.no/Taxon/200000')
  assert.equal(storedArtsorakel[0].redlist_category, 'NT')
  assert.equal(storedArtsorakel[0].external_ids.gbif, '2000000')
  assert.equal(storedArtsorakel[0].external_ids.nbic, undefined)
  assert.equal(storedArtsorakel[1].scientific_name, 'Top species')
  assert.equal(storedArtsorakel[1].vernacular_name, 'Top common')
  assert.equal(storedArtsorakel[1].taxon_id, 'NBIC:185988')
  assert.equal(storedArtsorakel[1].species_url, 'https://artsdatabanken.no/Taxon/203764')
  assert.equal(storedArtsorakel[1].redlist_category, 'LC')
  assert.equal(storedArtsorakel[1].picture_url, 'https://artsdatabanken.no/Media/F47031?mode=128x128')
  assert.equal(storedArtsorakel[1].external_ids.gbif, '6092830')
  assert.equal(storedArtsorakel[1].external_ids.nbic, undefined)

  const inat = await saveIdentificationRun({
    observationId: 'obs-compact-inat',
    userId: 'user-1',
    service: 'inat',
    requestFingerprint: 'req-inat',
    imageFingerprint: 'img-inat',
    cropFingerprint: 'crop-inat',
    language: 'en',
    results: [
      {
        rank: 1,
        scientificName: 'Amanita muscaria',
        vernacularName: 'Fly agaric',
        taxonId: '12345',
        probability: 0.91,
        raw: {
          taxon: {
            gbif_id: 'GBIF:6092830',
          },
        },
      },
    ],
    supabaseClient: client,
  })

  const storedInat = client.rows[1].results[0]
  assert.equal(inat.results.length, 1)
  assert.equal(storedInat.taxon_id, '12345')
  assert.equal(storedInat.species_url, 'https://www.inaturalist.org/taxa/12345')
  assert.equal(storedInat.external_ids.gbif, '6092830')
  assert.equal(storedInat.external_ids.inat, undefined)
})

test('formatting AI suggestions keeps vernacular and scientific names on separate lines', () => {
  const display = formatAiSuggestionDisplay({
    vernacularName: 'knivkjuke',
    scientificName: 'Piptoporus betulinus',
    displayName: 'knivkjuke (Piptoporus betulinus)',
  })

  assert.deepEqual(display, {
    title: 'knivkjuke',
    subtitle: 'Piptoporus betulinus',
  })

  const html = renderIdentifyResultRows('artsorakel', [{
    vernacularName: 'knivkjuke',
    scientificName: 'Piptoporus betulinus',
    taxonId: '47274',
    speciesUrl: 'https://artsdatabanken.no/Pages/298179',
    probability: 0.91,
  }])

  assert.match(html, /knivkjuke/)
  assert.match(html, /Piptoporus betulinus/)
  assert.doesNotMatch(html, /knivkjuke \(Piptoporus betulinus\)/)
  assert.match(html, /ai-result-row-link/)
  assert.match(html, /artsdatabanken\.no\/Pages\/298179/)

  const inatHtml = renderIdentifyResultRows('inat', [{
    vernacularName: 'Fly agaric',
    scientificName: 'Amanita muscaria',
    taxonId: '12345',
    probability: 0.91,
  }])
  assert.match(inatHtml, /ai-result-row-link/)
  assert.match(inatHtml, /inaturalist\.org\/taxa\/12345/)
})

test('service tabs render no-match, running, and success states with the right icon semantics', () => {
  const noMatch = renderIdentifyServiceTab({
    service: 'artsorakel',
    status: 'no_match',
    available: true,
  })
  assert.match(noMatch, /ai-id-service-tab-icon-x/)
  assert.doesNotMatch(noMatch, /Loading/i)

  const running = renderIdentifyServiceTab({
    service: 'inat',
    status: 'running',
    available: true,
  })
  assert.match(running, /ai-pie-spinner/)
  assert.doesNotMatch(running, /Loading/i)

  const success = renderIdentifyServiceTab({
    service: 'artsorakel',
    status: 'success',
    available: true,
    topProbability: 0.87,
  })
  assert.match(success, /ai-id-service-tab-icon-check is-good/)
  assert.match(success, /87%/)

  const lowConfidence = renderIdentifyServiceTab({
    service: 'inat',
    status: 'success',
    available: true,
    topProbability: 0.27,
  })
  assert.match(lowConfidence, /ai-id-service-tab-icon-check is-low/)
  assert.match(lowConfidence, /ai-id-service-tab-score is-low/)
  assert.match(lowConfidence, /ai-confidence-badge is-low/)
  assert.match(lowConfidence, /27%/)
})

test('service tabs keep a hidden score slot before results arrive', () => {
  const html = renderIdentifyServiceTab({
    service: 'artsorakel',
    status: 'idle',
    available: true,
  })

  assert.match(html, /ai-id-service-tab-score/)
  assert.match(html, /style="display:none"/)
})

test('service tabs prefer explicit display probability over stored top probability', () => {
  const html = renderIdentifyServiceTab({
    service: 'artsorakel',
    status: 'idle',
    available: true,
    displayProbability: 0.53,
    topProbability: 0.91,
  })

  assert.match(html, /53%/)
  assert.doesNotMatch(html, /91%/)
})

test('service tabs accept a session id for scoped wiring', () => {
  const html = renderIdentifyServiceTab({
    service: 'artsorakel',
    status: 'idle',
    available: true,
  }, { sid: 'session-42' })

  assert.match(html, /data-sid="session-42"/)
})

test('service tabs keep stored unavailable results clickable while disabling idle unavailable tabs', () => {
  const storedUnavailable = renderIdentifyServiceTab({
    service: 'inat',
    status: 'unavailable',
    available: false,
    errorMessage: 'Please log in',
  })
  assert.doesNotMatch(storedUnavailable, /(?:^|[\s<])disabled(?:\s|=|>)/)
  assert.match(storedUnavailable, /aria-disabled="false"/)

  const idleUnavailable = renderIdentifyServiceTab({
    service: 'inat',
    status: 'idle',
    available: false,
  })
  assert.match(idleUnavailable, /(?:^|[\s<])disabled(?:\s|=|>)/)
  assert.match(idleUnavailable, /aria-disabled="true"/)

  assert.equal(canViewServiceResult({ status: 'unavailable' }), true)
  assert.equal(canRunService({ status: 'idle', available: false }), false)
})

test('collapsed AI status chips render the active service and confidence percentage', () => {
  const html = renderIdentifyServiceStateSummary({
    service: 'inat',
    active: true,
    available: true,
    status: 'success',
    topProbability: 0.87,
  })

  assert.match(html, /ai-id-service-state/)
  assert.match(html, /iNaturalist/)
  assert.match(html, /87%/)
  assert.match(html, /ai-id-service-tab-icon-check is-good/)
  assert.doesNotMatch(html, /ai-confidence-badge/)
})

test('top probability falls back to the highest prediction when explicit top fields are missing', () => {
  assert.equal(getIdentifyTopProbability({
    predictions: [
      { probability: 0.22 },
      { probability: 0.91 },
      { probability: 0.54 },
    ],
  }), 0.91)
})

test('confidence score spans do not use filled backgrounds', () => {
  const css = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  for (const tone of ['good', 'warn', 'low']) {
    assert.doesNotMatch(
      css,
      new RegExp(`\\.ai-id-service-tab-score\\.${tone}[\\s\\S]*background:`, 'm'),
    )
  }
})

test('requested services keep the other service state intact while one service reruns', () => {
  const existing = {
    artsorakel: {
      service: 'artsorakel',
      status: 'success',
      available: true,
      predictions: [{ scientificName: 'Amanita muscaria' }],
      topProbability: 0.92,
    },
    inat: {
      service: 'inat',
      status: 'success',
      available: true,
      predictions: [{ scientificName: 'Amanita pantherina' }],
      topProbability: 0.81,
    },
  }

  const next = markRequestedServicesRunning(existing, {
    artsorakel: { available: true, reason: '' },
    inat: { available: true, reason: '' },
  }, ['inat'])

  assert.equal(next.artsorakel.status, 'success')
  assert.equal(next.artsorakel.predictions[0].scientificName, 'Amanita muscaria')
  assert.equal(next.inat.status, 'running')
  assert.equal(next.inat.predictions[0].scientificName, 'Amanita pantherina')
})

test('terminal AI service states do not rerun from tab clicks', () => {
  for (const status of ['no_match', 'error', 'unavailable']) {
    assert.equal(isTerminalAiServiceState({ status }), true)
    assert.equal(shouldRunServiceFromTab({ status }), false)
  }

  assert.equal(isTerminalAiServiceState({ status: 'success' }), true)
  assert.equal(shouldRunServiceFromTab({ status: 'success' }), false)
  assert.equal(shouldRunServiceFromTab({ status: 'idle' }), true)
  assert.equal(shouldRunServiceFromTab({ status: 'stale' }), true)
  assert.equal(shouldRunServiceFromTab({ status: 'running' }), false)
})

test('fingerprints change when image or crop inputs change', () => {
  const blob100 = new Blob([new Uint8Array(100)], { type: 'image/jpeg' })
  const blob120 = new Blob([new Uint8Array(120)], { type: 'image/jpeg' })
  const base = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [
      {
        id: 'img-1',
        blob: blob100,
        cropRect: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
    ],
  })
  const cropChanged = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [
      {
        id: 'img-1',
        blob: blob100,
        cropRect: { x1: 0.1, y1: 0, x2: 1, y2: 1 },
      },
    ],
  })
  const imageChanged = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [
      {
        id: 'img-2',
        blob: blob120,
        cropRect: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
    ],
  })

  assert.notEqual(base.requestFingerprint, cropChanged.requestFingerprint)
  assert.notEqual(base.requestFingerprint, imageChanged.requestFingerprint)
})

test('cached identification rows are reused and stale rows are marked when the fingerprint changes', async () => {
  resetObservationIdentificationsTableAvailabilityForTests()
  const client = createSupabaseStub()
  const first = await saveIdentificationRun({
    observationId: 'obs-1',
    userId: 'user-1',
    service: 'artsorakel',
    requestFingerprint: 'req-1',
    imageFingerprint: 'img-1',
    cropFingerprint: 'crop-1',
    language: 'en',
    results: [
      {
        rank: 1,
        scientific_name: 'Gloeophyllum odoratum',
        vernacular_name: 'Lukttjæresopp',
        taxon_id: 'NBIC:56449',
        species_url: 'https://artsdatabanken.no/Pages/361402',
        redlist_category: 'LC',
        redlist_source: 'Artsdatabanken',
        probability: 0.97,
      },
      {
        scientificName: 'Morchella esculenta',
        vernacularName: 'Morel',
        taxonId: '456',
        speciesUrl: 'https://artsdatabanken.no/Pages/456',
        redlistCategory: 'NT',
        probability: 0.77,
      },
    ],
    supabaseClient: client,
  })

  assert.equal(first.status, 'success')
  assert.equal(first.results.length, 2)
  assert.equal(first.results[0].scientific_name, 'Gloeophyllum odoratum')
  assert.equal(first.results[1].scientific_name, 'Morchella esculenta')
  assert.equal(first.results[1].species_url, 'https://artsdatabanken.no/Pages/456')
  assert.equal(first.results[1].redlist_category, 'NT')
  assert.equal(first.top_scientific_name, 'Gloeophyllum odoratum')
  assert.equal(first.top_vernacular_name, 'Lukttjæresopp')
  assert.equal(first.top_taxon_id, 'NBIC:56449')
  assert.equal(first.top_probability, 0.97)
  assert.equal(first.top_species_url, 'https://artsdatabanken.no/Pages/361402')
  assert.equal(first.top_redlist_category, 'LC')
  assert.equal(first.top_redlist_source, 'Artsdatabanken')

  const cached = await maybeLoadCachedIdentification({
    observationId: 'obs-1',
    service: 'artsorakel',
    requestFingerprint: 'req-1',
    supabaseClient: client,
  })
  assert.equal(cached.request_fingerprint, 'req-1')
  assert.equal(cached.image_fingerprint, 'img-1')
  assert.equal(cached.crop_fingerprint, 'crop-1')
  assert.equal(cached.results.length, 2)
  assert.equal(cached.top_probability, 0.97)
  assert.equal(cached.top_species_url, 'https://artsdatabanken.no/Pages/361402')
  assert.equal(cached.top_redlist_category, 'LC')

  await new Promise(resolve => setTimeout(resolve, 2))

  await saveIdentificationRun({
    observationId: 'obs-1',
    userId: 'user-1',
    service: 'artsorakel',
    requestFingerprint: 'req-2',
    imageFingerprint: 'img-2',
    cropFingerprint: 'crop-2',
    language: 'en',
    results: [
      {
        scientificName: 'Morchella esculenta',
        vernacularName: 'Morel',
        taxonId: '456',
        probability: 0.77,
      },
    ],
    supabaseClient: client,
  })

  const rows = await loadObservationIdentifications('obs-1', { supabaseClient: client })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].request_fingerprint, 'req-2')
  assert.equal(rows[0].image_fingerprint, 'img-2')
  assert.equal(rows[0].crop_fingerprint, 'crop-2')
  assert.equal(rows[0].results.length, 1)
  assert.equal(rows[1].status, 'stale')
  assert.equal(rows[1].image_fingerprint, 'img-1')
  assert.equal(rows[1].crop_fingerprint, 'crop-1')

  const stale = markIdentificationStaleIfFingerprintChanged(rows, 'req-2')
  assert.equal(stale[0].status, 'success')
  assert.equal(stale[1].status, 'stale')
})

test('old bloated identification rows still normalize on read', async () => {
  resetObservationIdentificationsTableAvailabilityForTests()
  const client = createSupabaseStub()
  client.rows.push({
    id: 'old-row-1',
    observation_id: 'obs-old',
    user_id: 'user-1',
    service: 'artsorakel',
    source: 'ai',
    status: 'success',
    request_fingerprint: 'req-old',
    image_fingerprint: 'img-old',
    crop_fingerprint: 'crop-old',
    results: [
      {
        rank: 1,
        scientificName: 'Old species',
        vernacularName: 'Old common',
        taxonId: 'NBIC:555555',
        speciesUrl: 'https://artsdatabanken.no/Taxon/555555',
        redlistCategory: 'VU',
        raw: {
          taxon: {
            scientificName: 'Old species',
            vernacularName: 'Old common',
            scientific_name_id: 'NBIC:555555',
            infoUrl: 'https://artsdatabanken.no/Taxon/555555',
            redListCategory: 'VU',
            redListSource: 'Artsdatabanken',
          },
        },
      },
    ],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  })

  const cached = await maybeLoadCachedIdentification({
    observationId: 'obs-old',
    service: 'artsorakel',
    requestFingerprint: 'req-old',
    supabaseClient: client,
  })

  assert.equal(cached.request_fingerprint, 'req-old')
  assert.equal(cached.results.length, 1)
  assert.equal(cached.results[0].scientific_name, 'Old species')
  assert.equal(cached.results[0].scientificName, 'Old species')
  assert.equal(cached.results[0].vernacular_name, 'Old common')
  assert.equal(cached.results[0].taxon_id, 'NBIC:555555')
  assert.equal(cached.results[0].species_url, 'https://artsdatabanken.no/Taxon/555555')
  assert.equal(cached.results[0].redlist_category, 'VU')
  assert.equal(cached.top_scientific_name, 'Old species')
  assert.equal(cached.top_vernacular_name, 'Old common')
  assert.equal(cached.top_taxon_id, 'NBIC:555555')
  assert.equal(cached.top_species_url, 'https://artsdatabanken.no/Taxon/555555')
  assert.equal(cached.top_redlist_category, 'VU')
})
