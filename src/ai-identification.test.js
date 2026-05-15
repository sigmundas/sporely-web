import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  buildIdentifyFingerprint,
  loadObservationIdentifications,
  markIdentificationStaleIfFingerprintChanged,
  maybeLoadCachedIdentification,
  formatAiSuggestionDisplay,
  renderIdentifyResultRows,
  renderIdentifyServiceTab,
  renderIdentifyServiceStateSummary,
  runIdentifyComparisonForBlobs,
  saveIdentificationRun,
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
    probability: 0.91,
  }])

  assert.match(html, /knivkjuke/)
  assert.match(html, /Piptoporus betulinus/)
  assert.doesNotMatch(html, /knivkjuke \(Piptoporus betulinus\)/)
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
  assert.match(running, /ai-id-service-tab-icon-dot/)
  assert.doesNotMatch(running, /Loading/i)

  const success = renderIdentifyServiceTab({
    service: 'artsorakel',
    status: 'success',
    available: true,
    topProbability: 0.87,
  })
  assert.match(success, /ai-id-service-tab-icon-check/)
  assert.match(success, /87%/)

  const lowConfidence = renderIdentifyServiceTab({
    service: 'inat',
    status: 'success',
    available: true,
    topProbability: 0.27,
  })
  assert.match(lowConfidence, /ai-id-service-tab-icon-dot/)
  assert.match(lowConfidence, /ai-id-service-tab-score is-low/)
  assert.match(lowConfidence, /ai-confidence-badge is-low/)
  assert.match(lowConfidence, /27%/)
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
  assert.match(html, /ai-id-service-tab-icon-check/)
  assert.doesNotMatch(html, /ai-confidence-badge/)
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

test('fingerprints change when image or crop inputs change', () => {
  const base = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [
      {
        id: 'img-1',
        blob: { size: 100, type: 'image/jpeg' },
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
        blob: { size: 100, type: 'image/jpeg' },
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
        blob: { size: 120, type: 'image/jpeg' },
        cropRect: { x1: 0, y1: 0, x2: 1, y2: 1 },
      },
    ],
  })

  assert.notEqual(base.requestFingerprint, cropChanged.requestFingerprint)
  assert.notEqual(base.requestFingerprint, imageChanged.requestFingerprint)
})

test('cached identification rows are reused and stale rows are marked when the fingerprint changes', async () => {
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
        scientificName: 'Amanita muscaria',
        vernacularName: 'Fly agaric',
        taxonId: '123',
        probability: 0.91,
      },
    ],
    supabaseClient: client,
  })

  assert.equal(first.status, 'success')
  assert.equal(first.top_scientific_name, 'Amanita muscaria')

  const cached = await maybeLoadCachedIdentification({
    observationId: 'obs-1',
    service: 'artsorakel',
    requestFingerprint: 'req-1',
    supabaseClient: client,
  })
  assert.equal(cached.request_fingerprint, 'req-1')
  assert.equal(cached.top_probability, 0.91)

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
  assert.equal(rows[1].status, 'stale')

  const stale = markIdentificationStaleIfFingerprintChanged(rows, 'req-2')
  assert.equal(stale[0].status, 'success')
  assert.equal(stale[1].status, 'stale')
})
