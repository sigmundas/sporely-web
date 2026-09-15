import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  _buildDetailAiCachedResults,
  _detailAiCropInputMapChanged,
  _detailAiCropMetaMapChanged,
  _hasAiRunResult,
  _hasStoredAiResult,
  _canRunDetailAiService,
  getDetailDraftExplanationLines,
  _renderDetailAiResults,
  _renderDetailAiTabs,
  _setDetailAiActiveService,
  buildDetailLocationPatch,
  detailLocationActionMode,
  detailAiState,
  formatMicroscopeCapturedAt,
  formatSporeStatsShort,
  loadObservationSporeSummaries,
  microscopeCapturePresentation,
  pickSporeSummaryRow,
  sporeStatsPresentation,
} from './find_detail.js'

class MockClassList {
  constructor(initial = []) {
    this.values = new Set(initial)
  }

  add(...names) {
    names.filter(Boolean).forEach(name => this.values.add(name))
  }

  remove(...names) {
    names.filter(Boolean).forEach(name => this.values.delete(name))
  }

  toggle(name, force) {
    if (force === true) {
      this.values.add(name)
      return true
    }
    if (force === false) {
      this.values.delete(name)
      return false
    }
    if (this.values.has(name)) {
      this.values.delete(name)
      return false
    }
    this.values.add(name)
    return true
  }

  contains(name) {
    return this.values.has(name)
  }

  toString() {
    return Array.from(this.values).join(' ')
  }
}

function makeTab(service, active = false) {
  const icon = { outerHTML: '' }
  const score = { textContent: '', style: {} }
  const label = { insertAdjacentHTML() {} }
  return {
    id: `detail-ai-tab-${service}`,
    dataset: { identifyServiceTab: service },
    classList: new MockClassList(active ? ['is-active'] : []),
    disabled: false,
    tabIndex: -1,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    // The find-detail tabs are a real ARIA tablist; the review screens reuse
    // the same classes outside one, so the renderer checks for the ancestor.
    closest(selector) {
      return selector === '#detail-ai-service-tabs' ? { id: 'detail-ai-service-tabs' } : null
    },
    querySelector(selector) {
      if (selector === '.ai-id-service-tab-icon, .ai-id-dot') return icon
      if (selector === '.ai-id-service-tab-score') return score
      if (selector === '.ai-id-service-tab-label') return label
      return null
    },
  }
}

function makeResultsEl() {
  const items = []
  return {
    innerHTML: '',
    style: {},
    dataset: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    querySelectorAll(selector) {
      if (selector === '[data-identify-result]') return items
      return []
    },
    _items: items,
  }
}

function makeIdentifyResultItem(prediction) {
  return {
    dataset: {
      identifyResult: JSON.stringify(prediction),
    },
    classList: new MockClassList(),
    attributes: {},
    addEventListener() {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
  }
}

function resetDetailState() {
  detailAiState.running = false
  detailAiState.runningByService = {}
  detailAiState.activeService = 'artsorakel'
  detailAiState.availability = {}
  detailAiState.resultsByService = {}
  detailAiState.cachedRows = []
  detailAiState.selectedService = null
  detailAiState.selectedPrediction = null
  detailAiState.selectedPredictionByService = {}
  detailAiState.selectedProbabilityByService = {}
  detailAiState.currentFingerprint = ''
  detailAiState.requestedFingerprint = ''
  detailAiState.currentFingerprintByService = {}
  detailAiState.requestedFingerprintByService = {}
  detailAiState.localInputsChanged = false
  detailAiState.stale = false
}

function withDocument({ tabs = [], resultsEl = makeResultsEl(), staleNote = { style: {} }, runBtn = null } = {}) {
  const previous = globalThis.document
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === '[data-identify-service-tab]') return tabs
      return []
    },
    querySelector(selector) {
      if (selector === '[data-identify-run-button]') return runBtn
      if (selector === '[data-identify-stale-note]') return staleNote
      const scopedTab = /^#detail-ai-service-tabs \[data-identify-service-tab="(.+)"\]$/.exec(selector)
      if (scopedTab) {
        return tabs.find(tab => tab.dataset.identifyServiceTab === scopedTab[1]) || null
      }
      return null
    },
    getElementById(id) {
      if (id === 'detail-ai-results') return resultsEl
      return null
    },
  }
  return () => {
    globalThis.document = previous
  }
}

test('idle find detail AI state stays neutral before any run or cached result', () => {
  resetDetailState()
  const resultsEl = makeResultsEl()
  const restore = withDocument({ resultsEl })

  try {
    _renderDetailAiResults()
    assert.match(resultsEl.innerHTML, /Run AI Photo ID to get suggestions/i)
    assert.doesNotMatch(resultsEl.innerHTML, /review\.runAiIdPrompt/)
    assert.doesNotMatch(resultsEl.innerHTML, /no suggestion|no suggestions|returned no suggestion/i)
  } finally {
    restore()
  }
})

test('find detail redlist summary sits between the date block and the gallery', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

  const summaryIdx = html.indexOf('id="detail-redlist-summary"')
  const socialRowIdx = html.indexOf('id="detail-social-row"')
  const galleryIdx = html.indexOf('id="detail-gallery"')

  assert.ok(summaryIdx >= 0)
  assert.ok(socialRowIdx >= 0)
  assert.ok(galleryIdx > summaryIdx)
  assert.ok(galleryIdx > socialRowIdx)
  assert.match(html, /id="detail-social-row"[\s\S]*id="detail-redlist-summary"[\s\S]*id="detail-gallery"/)
})

function makeSporeSummaryClient(rows) {
  const calls = []
  const client = {
    calls,
    from(table) {
      calls.push({ kind: 'table', table })
      const builder = {
        select() { return builder },
        eq(column, value) {
          calls[calls.length - 1].filter = { column, value }
          return Promise.resolve({ data: rows, error: null })
        },
      }
      return builder
    },
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args })
      return { data: rows, error: null }
    },
  }
  return client
}

test('spore summaries read the owner table directly and viewers go through the gated RPC', async () => {
  const rows = [{ length_p05_um: 8.5, length_p95_um: 10.8 }]

  const ownerClient = makeSporeSummaryClient(rows)
  assert.deepEqual(await loadObservationSporeSummaries({
    client: ownerClient,
    observationId: 42,
    isOwner: true,
  }), { available: true, rows })
  assert.deepEqual(ownerClient.calls, [{
    kind: 'table',
    table: 'observation_spore_summaries',
    filter: { column: 'observation_id', value: 42 },
  }])

  const viewerClient = makeSporeSummaryClient(rows)
  assert.deepEqual(await loadObservationSporeSummaries({
    client: viewerClient,
    observationId: 42,
    isOwner: false,
  }), { available: true, rows })
  assert.deepEqual(viewerClient.calls, [{
    kind: 'rpc',
    name: 'get_public_observation_spore_summaries',
    args: { p_observation_ids: [42] },
  }])

  // Queued/unsynced observations have no cloud row to summarize.
  const localClient = makeSporeSummaryClient(rows)
  assert.deepEqual(await loadObservationSporeSummaries({
    client: localClient,
    observationId: 'local-draft-1',
    isOwner: true,
  }), { available: false, rows: [] })
  assert.equal(localClient.calls.length, 0)
})

test('optional spore statistics failure is non-fatal and unavailable', async () => {
  const previousWarn = console.warn
  console.warn = () => {}
  try {
    const result = await loadObservationSporeSummaries({
      client: { rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) },
      observationId: 43,
      isOwner: false,
    })
    assert.deepEqual(result, { available: false, rows: [] })
  } finally {
    console.warn = previousWarn
  }
})

test('microscope image capture labels never fall back to upload time or leak to viewers', () => {
  const captured = microscopeCapturePresentation({
    image_type: 'microscope',
    captured_at: '2026-08-10T19:42:00Z',
    created_at: '2030-01-01T00:00:00Z',
  }, true)
  assert.match(captured, /2026/)
  assert.doesNotMatch(captured, /2030/)

  assert.equal(microscopeCapturePresentation({
    image_type: 'microscope',
    captured_at: null,
    created_at: '2030-01-01T00:00:00Z',
  }, true), 'Capture time unknown')
  assert.equal(microscopeCapturePresentation({
    image_type: 'microscope',
    captured_at: '2026-08-10T19:42:00Z',
  }, false), null)
  assert.equal(microscopeCapturePresentation({
    image_type: 'field',
    captured_at: '2026-08-10T19:42:00Z',
  }, true), null)
})

test('the spore tagline shows the 5-95 percentile spread as length x width with Q and n', () => {
  assert.equal(formatSporeStatsShort({
    length_p05_um: 8.5,
    length_p95_um: 10.84,
    length_min_um: 3,
    length_max_um: 30,
    width_p05_um: 4.5,
    width_p95_um: 5.75,
    q_p05: 1.74,
    q_p95: 2.12,
    n_spores: 36,
  }), '8.5–10.8 × 4.5–5.8 µm · Q = 1.7–2.1 · n = 36')

  // Length-only measurements still read as a range; Q needs paired widths.
  assert.equal(formatSporeStatsShort({
    length_p05_um: 8.5,
    length_p95_um: 10.8,
    width_p05_um: null,
    width_p95_um: null,
    q_p05: null,
    q_p95: null,
    n_length: 12,
  }), '8.5–10.8 µm · n = 12')

  assert.equal(formatSporeStatsShort({ length_p05_um: null, length_p95_um: null }), '')
  assert.equal(formatSporeStatsShort(null), '')
})

test('the spore tagline never mixes measurement contexts and stays hidden without data', () => {
  const driedKoh = {
    sample_type: 'dried',
    mount_reagent: 'koh',
    n_paired: 30,
    n_spores: 30,
    length_p05_um: 8.5,
    length_p95_um: 10.8,
    width_p05_um: 4.5,
    width_p95_um: 5.8,
  }
  const freshWater = {
    sample_type: 'fresh',
    mount_reagent: 'water',
    n_paired: 4,
    n_spores: 6,
    length_p05_um: 12.1,
    length_p95_um: 14.4,
    width_p05_um: 6.1,
    width_p95_um: 7.2,
  }

  // Best-supported context wins outright; percentiles are never averaged
  // across preparations.
  assert.equal(pickSporeSummaryRow([freshWater, driedKoh]), driedKoh)
  assert.equal(
    sporeStatsPresentation({ available: true, rows: [freshWater, driedKoh] }),
    '8.5–10.8 × 4.5–5.8 µm · n = 30',
  )

  // Equal support falls back to the freshest computation.
  const older = { ...driedKoh, computed_at: '2026-01-01T00:00:00Z', length_p05_um: 9.1 }
  const newer = { ...driedKoh, computed_at: '2026-06-01T00:00:00Z', length_p05_um: 8.5 }
  assert.equal(pickSporeSummaryRow([older, newer]), newer)

  assert.equal(pickSporeSummaryRow([]), null)
  assert.equal(pickSporeSummaryRow([{ n_spores: 3, length_p05_um: null }]), null)
  assert.equal(sporeStatsPresentation({ available: false, rows: [driedKoh] }), null)
  assert.equal(sporeStatsPresentation({ available: true, rows: [] }), null)
  assert.equal(sporeStatsPresentation(null), null)
})

test('microscope timestamps format the instant in the browser timezone across UTC midnight', () => {
  const previousTimezone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const formatted = formatMicroscopeCapturedAt('2026-08-10T00:30:00Z')
    assert.match(formatted, /Aug 9, 2026/)
    assert.doesNotMatch(formatted, /Aug 10, 2026/)
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

test('detail markup and load path keep microscopy metadata owner-only and race-safe', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  assert.match(html, /id="detail-spore-stats" style="display:none"/)
  assert.match(html, /id="photo-viewer-metadata" style="display:none"/)
  assert.match(source, /isOwner: currentObsIsOwner/)
  assert.match(source, /loadGeneration !== detailLoadGeneration/)
  assert.match(source, /ownerSelectFields: isOwner \? DETAIL_OWNER_IMAGE_SELECT_WITH_CUSTOM : undefined/)
  assert.doesNotMatch(source, /created_at[^\n]+captureTimeUnknown/)
})

test('non-owner detail tabs stay disabled until there is a stored result to view', () => {
  resetDetailState()
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat'),
  ]
  const restore = withDocument({ tabs })

  try {
    detailAiState.availability = {
      artsorakel: { available: true, reason: '' },
      inat: { available: true, reason: '' },
    }

    _renderDetailAiTabs()

    assert.equal(_canRunDetailAiService('artsorakel', { status: 'idle' }), false)
    assert.equal(tabs[0].disabled, true)
    assert.equal(tabs[1].disabled, true)
  } finally {
    restore()
  }
})

test('cached rows prefer the exact request fingerprint over newer same-input rows', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-newer',
      image_fingerprint: 'img-1',
      crop_fingerprint: 'crop-1',
      created_at: '2026-05-20T12:00:00Z',
      top_scientific_name: 'Newer match',
      results: [{ scientificName: 'Newer match', probability: 0.84 }],
    },
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-exact',
      image_fingerprint: 'img-1',
      crop_fingerprint: 'crop-1',
      created_at: '2026-05-19T12:00:00Z',
      top_scientific_name: 'Exact match',
      results: [{ scientificName: 'Exact match', probability: 0.91 }],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: {
      requestFingerprint: 'req-exact',
      imageFingerprint: 'img-1',
      cropFingerprint: 'crop-1',
    },
  })

  assert.equal(results.artsorakel.status, 'success')
  assert.equal(results.artsorakel.topScientificName, 'Exact match')
  assert.equal(results.artsorakel.request_fingerprint, 'req-exact')
  assert.equal(results.artsorakel.image_fingerprint, 'img-1')
  assert.equal(results.artsorakel.crop_fingerprint, 'crop-1')
})

test('cached rows do not become stale when only request fingerprint changes', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-old',
      image_fingerprint: 'img-1',
      crop_fingerprint: 'crop-1',
      top_probability: 0.91,
      results: [{ scientificName: 'Amanita muscaria', probability: 0.91 }],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: {
      requestFingerprint: 'req-new',
      imageFingerprint: 'img-1',
      cropFingerprint: 'crop-1',
    },
  })

  assert.equal(results.artsorakel.status, 'success')
  assert.equal(results.artsorakel.predictions[0].scientificName, 'Amanita muscaria')
  assert.equal(results.artsorakel.request_fingerprint, 'req-old')
  assert.equal(results.artsorakel.image_fingerprint, 'img-1')
  assert.equal(results.artsorakel.crop_fingerprint, 'crop-1')
})

test('cached rows become stale when crop fingerprint changes', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-old',
      image_fingerprint: 'img-1',
      crop_fingerprint: 'crop-old',
      results: [{ scientificName: 'Amanita muscaria', probability: 0.91 }],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: {
      requestFingerprint: 'req-new',
      imageFingerprint: 'img-1',
      cropFingerprint: 'crop-new',
    },
  })

  assert.equal(results.artsorakel.status, 'stale')
  assert.equal(results.artsorakel.predictions[0].scientificName, 'Amanita muscaria')
})

test('cached rows become stale when image fingerprint changes', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-old',
      image_fingerprint: 'img-old',
      crop_fingerprint: 'crop-1',
      results: [{ scientificName: 'Amanita muscaria', probability: 0.91 }],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: {
      requestFingerprint: 'req-new',
      imageFingerprint: 'img-new',
      cropFingerprint: 'crop-1',
    },
  })

  assert.equal(results.artsorakel.status, 'stale')
  assert.equal(results.artsorakel.predictions[0].scientificName, 'Amanita muscaria')
})

test('legacy cached rows without input fingerprints do not become stale on request drift', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'stale',
      request_fingerprint: 'req-old',
      results: [{ scientificName: 'Amanita muscaria', probability: 0.91 }],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: {
      requestFingerprint: 'req-new',
      imageFingerprint: 'img-new',
      cropFingerprint: 'crop-new',
    },
  })

  assert.equal(results.artsorakel.status, 'success')
  assert.equal(results.artsorakel.predictions[0].scientificName, 'Amanita muscaria')
})

test('cached rows fall back to the newest row when no request or input fingerprints match', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-old',
      image_fingerprint: 'img-old',
      crop_fingerprint: 'crop-old',
      created_at: '2026-05-19T12:00:00Z',
      top_scientific_name: 'Older row',
      results: [{ scientificName: 'Older row', probability: 0.84 }],
    },
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-new',
      image_fingerprint: 'img-new',
      crop_fingerprint: 'crop-new',
      created_at: '2026-05-20T12:00:00Z',
      top_scientific_name: 'Newest row',
      results: [{ scientificName: 'Newest row', probability: 0.93 }],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: {
      requestFingerprint: 'req-current',
      imageFingerprint: 'img-current',
      cropFingerprint: 'crop-current',
    },
  })

  assert.equal(results.artsorakel.topScientificName, 'Newest row')
  assert.equal(results.artsorakel.status, 'stale')
})

test('detail crop comparisons ignore no-op saves but detect real crop changes', () => {
  const original = new Map([
    ['img-1', {
      aiCropRect: { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.8 },
      aiCropSourceW: 1200,
      aiCropSourceH: 900,
      aiCropIsCustom: true,
    }],
  ])

  const unchangedRows = [
    {
      id: 'img-1',
      ai_crop_x1: 0.1,
      ai_crop_y1: 0.2,
      ai_crop_x2: 0.9,
      ai_crop_y2: 0.8,
      ai_crop_source_w: 1200,
      ai_crop_source_h: 900,
      ai_crop_is_custom: true,
    },
  ]

  const changedRows = [
    {
      id: 'img-1',
      ai_crop_x1: 0.15,
      ai_crop_y1: 0.2,
      ai_crop_x2: 0.9,
      ai_crop_y2: 0.8,
      ai_crop_source_w: 1200,
      ai_crop_source_h: 900,
      ai_crop_is_custom: true,
    },
  ]

  assert.equal(_detailAiCropMetaMapChanged(original, unchangedRows), false)
  assert.equal(_detailAiCropMetaMapChanged(original, changedRows), true)
  assert.equal(_detailAiCropInputMapChanged(original, [
    {
      id: 'img-1',
      ai_crop_x1: 0.1,
      ai_crop_y1: 0.2,
      ai_crop_x2: 0.9,
      ai_crop_y2: 0.8,
      ai_crop_source_w: 1200,
      ai_crop_source_h: 900,
      ai_crop_is_custom: false,
    },
  ]), false)

  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')
  const onCloseStart = source.indexOf('onClose: async committed => {')
  const delBtnStart = source.indexOf('const delBtn = document.createElement', onCloseStart)
  assert.ok(onCloseStart >= 0)
  assert.ok(delBtnStart > onCloseStart)
  const onCloseBlock = source.slice(onCloseStart, delBtnStart)
  assert.ok(onCloseBlock.indexOf('const aiCropChanged = _detailAiCropInputMapChanged(originalCropMetaById)') < onCloseBlock.indexOf('_markDetailAiStale()'))
  assert.ok(onCloseBlock.indexOf('_markDetailAiStale()') < onCloseBlock.indexOf('const cropError = await _persistDetailImageCrops()'))
})

test('stored results remain clickable even when the current availability says unavailable', () => {
  resetDetailState()
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat'),
  ]
  const resultsEl = makeResultsEl()
  const restore = withDocument({ tabs, resultsEl })

  try {
    detailAiState.availability = {
      artsorakel: { available: false, reason: 'Unavailable now' },
      inat: { available: false, reason: 'Unavailable now' },
    }
    detailAiState.resultsByService = {
      artsorakel: { service: 'artsorakel', status: 'success', predictions: [{ scientificName: 'Amanita muscaria' }] },
      inat: { service: 'inat', status: 'unavailable', predictions: [], errorMessage: 'Please log in' },
    }

    _renderDetailAiTabs()
    assert.equal(tabs[0].disabled, false)
    assert.equal(tabs[1].disabled, false)
    assert.equal(tabs[0].attributes['aria-disabled'], 'false')
    assert.equal(tabs[1].attributes['aria-disabled'], 'false')
    assert.equal(tabs[0].classList.contains('is-disabled'), false)
    assert.equal(tabs[1].classList.contains('is-disabled'), false)

    _setDetailAiActiveService('inat')
    assert.equal(tabs[0].classList.contains('is-active'), false)
    assert.equal(tabs[1].classList.contains('is-active'), true)
  } finally {
    restore()
  }
})

test('the provider tabs and result panel form one fused, keyboard-navigable tablist', () => {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  // One container holds both provider buttons and the result panel, so the
  // list reads as the contents of the selected tab.
  const tabGroup = /<div class="detail-ai-tabgroup">([\s\S]*?)<div class="detail-follow-row">/.exec(html)
  assert.ok(tabGroup, 'expected a detail-ai-tabgroup wrapper in the find detail markup')
  assert.match(tabGroup[1], /data-identify-service-tab="artsorakel"/)
  assert.match(tabGroup[1], /data-identify-service-tab="inat"/)
  assert.match(tabGroup[1], /class="detail-ai-results-shell"/)
  assert.match(html, /class="detail-ai-stack is-fused-tabs"/)
  // The run button stays outside the fused surface.
  assert.doesNotMatch(
    /<div class="detail-ai-controls">([\s\S]*?)<\/div>/.exec(html)[1],
    /data-identify-service-tab/,
  )

  // Real tab semantics, not styled buttons.
  assert.match(html, /id="detail-ai-service-tabs" role="tablist"/)
  assert.match(html, /id="detail-ai-tab-artsorakel" role="tab" aria-selected="true" aria-controls="detail-ai-results" tabindex="0"/)
  assert.match(html, /id="detail-ai-tab-inat" role="tab" aria-selected="false" aria-controls="detail-ai-results" tabindex="-1"/)
  assert.match(html, /id="detail-ai-results"[^>]*role="tabpanel"[^>]*aria-labelledby="detail-ai-tab-artsorakel"/)

  // Left/right arrow navigation, gated by the same reachability rule as clicks.
  assert.match(source, /event\.key === 'ArrowRight' \? 1 : event\.key === 'ArrowLeft' \? -1 : 0/)
  assert.match(source, /!_detailAiTabIsActivatable\(nextTab\)/)
  assert.match(source, /if \(!_detailAiTabIsActivatable\(tab\)\) return/)
})

test('rendering the provider tabs keeps aria-selected, roving tabindex and the panel label in sync', () => {
  resetDetailState()
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat'),
  ]
  const resultsEl = makeResultsEl()
  const restore = withDocument({ tabs, resultsEl })

  try {
    detailAiState.availability = {
      artsorakel: { available: true, reason: '' },
      inat: { available: true, reason: '' },
    }
    detailAiState.resultsByService = {
      artsorakel: { service: 'artsorakel', status: 'success', predictions: [{ scientificName: 'Hebeloma crustuliniforme', probability: 0.55 }] },
      inat: { service: 'inat', status: 'success', predictions: [{ scientificName: 'Hebeloma mesophaeum', probability: 0.39 }] },
    }

    _renderDetailAiTabs()
    _renderDetailAiResults()
    assert.equal(tabs[0].attributes['aria-selected'], 'true')
    assert.equal(tabs[1].attributes['aria-selected'], 'false')
    assert.equal(tabs[0].tabIndex, 0)
    assert.equal(tabs[1].tabIndex, -1)
    assert.equal(resultsEl.attributes['aria-labelledby'], 'detail-ai-tab-artsorakel')

    _setDetailAiActiveService('inat')
    assert.equal(tabs[0].attributes['aria-selected'], 'false')
    assert.equal(tabs[1].attributes['aria-selected'], 'true')
    assert.equal(tabs[0].tabIndex, -1)
    assert.equal(tabs[1].tabIndex, 0)
    assert.equal(resultsEl.attributes['aria-labelledby'], 'detail-ai-tab-inat')
  } finally {
    restore()
  }
})

const FUSED_CSS = (() => {
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8')
  const start = css.indexOf('.detail-ai-stack.is-fused-tabs {')
  const block = start >= 0 ? css.slice(start, css.indexOf('.settings-photo-id-mode-grid', start)) : ''
  const tokens = name => {
    const scope = css.slice(css.indexOf(name), css.indexOf('}', css.indexOf(name)))
    return Object.fromEntries(
      Array.from(scope.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)).map(([, k, v]) => [k, v.trim()]),
    )
  }
  // Rough perceptual ordering is enough to assert "which surface is lighter".
  const lightness = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  return { css, block, dark: tokens(':root {'), light: tokens('html.light {'), lightness }
})()

test('the fused tab surfaces are theme tokens, so light and dark invert correctly', () => {
  assert.ok(FUSED_CSS.block, 'expected a fused-tab block in style.css')
  const { block, dark, light, lightness } = FUSED_CSS

  // Selected tab and panel share the raised surface; the idle tab sits one step away.
  assert.match(block, /\.ai-id-service-tab\.is-active \{[\s\S]*?background: var\(--ai-tab-surface-raised\)/)
  assert.match(block, /\.detail-ai-results-shell \{[\s\S]*?background: var\(--ai-tab-surface-raised\)/)
  assert.match(block, /\.ai-id-service-tab \{[\s\S]*?background: var\(--ai-tab-surface-idle\)/)
  assert.match(block, /\.ai-result-row \{[\s\S]*?background: var\(--ai-row-surface\)/)
  // The panel opens into the selected tab rather than closing itself off.
  assert.match(block, /border-top: none/)
  assert.match(block, /border-bottom-color: transparent/)
  assert.match(block, /inset 0 3px 0 0 var\(--ai-tab-indicator\)/)
  // No literal colours in the component: themes come from the tokens alone.
  assert.doesNotMatch(
    block.replace(/rgba\(192, 88, 72, 0\.45\)|rgba\(240, 194, 77, 0\.55\)/g, ''),
    /#[0-9a-fA-F]{3,8}\b/,
  )

  // Both themes must define the whole set, or one theme silently falls back.
  const names = [
    '--ai-tab-surface-raised',
    '--ai-tab-surface-idle',
    '--ai-tab-border',
    '--ai-tab-indicator',
    '--ai-tab-idle-label',
    '--ai-row-surface',
  ]
  for (const name of names) {
    assert.ok(dark[name], `:root is missing ${name}`)
    assert.ok(light[name], `html.light is missing ${name}`)
  }

  // The inversion itself: in light mode the raised surface is DARKER than the
  // idle tab, and in dark mode it is lighter (inherited from the surface ramp).
  assert.ok(
    lightness(light['--ai-tab-surface-raised']) < lightness(light['--ai-tab-surface-idle']),
    'light mode: the raised tab/panel surface should be darker than the idle tab',
  )
  assert.equal(dark['--ai-tab-surface-raised'], 'var(--card-raised)')
  assert.equal(dark['--ai-tab-surface-idle'], 'var(--card)')
  assert.ok(
    lightness(dark['--card-raised']) > lightness(dark['--card']),
    'dark mode: --card-raised should be lighter than --card',
  )
  // The taxon row is one step lighter than the panel it rests on.
  assert.equal(light['--ai-row-surface'], '#ffffff')
  assert.match(dark['--ai-row-surface'], /^rgba\(255,255,255,/)
})

test('the fused tab group keeps its spacing on one shared gutter and flex gaps', () => {
  const { css, block } = FUSED_CSS

  // Card gutter: the button, tab bar and panel all span the same content width,
  // so they can only share edges if the card owns the horizontal padding.
  assert.match(css, /#screen-find-detail \.detail-field \{\s*padding: 18px;/)
  assert.match(block, /\.detail-ai-stack\.is-fused-tabs \{\s*gap: 16px;/)
  assert.match(block, /\.ai-id-service-tab \{[\s\S]*?gap: 7px;[\s\S]*?padding: 12px 13px;/)
  assert.match(block, /\.detail-ai-results-shell \{[\s\S]*?padding: 8px;[\s\S]*?gap: 6px;/)
  assert.match(block, /\.detail-ai-results \{\s*gap: 6px;/)
  assert.match(block, /\.ai-result-row \{\s*padding: 11px 13px;/)
  assert.match(block, /\.ai-result-row-meta \{\s*gap: 8px;/)
  // Stacks use flex + gap, not per-element margins.
  assert.match(css, /#screen-find-detail \.detail-toggle-stack \{[\s\S]*?gap: 12px;[\s\S]*?margin-top: 18px;/)
})

test('the result list is never pinned to display:block, so its flex gap applies', () => {
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  // A `display: block` inline style silently discards the row stack's gap.
  assert.doesNotMatch(source, /resultsEl\.style\.display = 'block'/)
  assert.match(source, /resultsEl\.style\.display = ''/)

  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const toggles = /<div class="detail-toggle-stack">([\s\S]*?)\n {12}<\/div>/.exec(html)
  assert.ok(toggles, 'expected the two toggles to share one flex stack')
  assert.match(toggles[1], /id="detail-uncertain"/)
  assert.match(toggles[1], /id="detail-draft"/)
  assert.doesNotMatch(toggles[1], /margin-top/)
})

test('detail ai run path stays disabled for non-owners and starts from a safe reset state', () => {
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  assert.match(source, /if \(!currentObsIsOwner\) return/)
  assert.match(source, /_applyOwnershipMode\(false\)/)
  assert.match(source, /detail\.onlyOwnerRunAiId/)
  assert.match(source, /Only the owner can run AI Photo ID/)
  assert.doesNotMatch(source, /tab\.disabled = !isOwner \|\| tab\.classList\.contains\('is-disabled'\)/)
  assert.doesNotMatch(source, /photoIdServices\.run\.length/)
  assert.match(source, /showToast\(noRunReason\)/)
})

test('detail add-photo native paths have image pipeline debug available', () => {
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  assert.match(source, /import \{ debugImagePipeline \} from '\.\.\/image-pipeline-debug\.js'/)
  assert.match(source, /debugImagePipeline\('android native camera capture requested'/)
  assert.match(source, /debugImagePipeline\('android native picker returned'/)
  assert.match(source, /console\.warn\('Native image picker failed:', err\)/)
  assert.match(source, /showToast\(t\('profile\.uploadFailed'/)
  assert.match(source, /storage_exif_safe:\s*preparedImage\.uploadMeta\?\.storage_exif_safe === true/)
})

test('detail privacy note treats drafts as free and labels published rows explicitly', () => {
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  assert.match(source, /observationUsesPrivacySlot/)
  assert.match(source, /detail\.published/)
})

test('draft explanation lines stay short and match visibility state', () => {
  const now = Date.parse('2026-06-24T12:00:00Z')

  assert.deepEqual(
    getDetailDraftExplanationLines({
      is_draft: true,
      visibility: 'public',
      created_at: '2026-06-10T12:00:00Z',
      date: '2025-01-01T12:00:00Z',
    }, now),
    ['Only visible to you.', 'Will be public when published.'],
  )

  assert.deepEqual(
    getDetailDraftExplanationLines({
      is_draft: true,
      visibility: 'friends',
      created_at: '2026-03-01T12:00:00Z',
    }, now),
    ['Only visible to you.', 'Will be visible to friends when published.', 'Old draft — review when ready.'],
  )

  assert.deepEqual(
    getDetailDraftExplanationLines({
      is_draft: true,
      visibility: 'private',
      created_at: '2025-11-01T12:00:00Z',
    }, now),
    ['Only visible to you.', 'Private when published.', 'Stale draft — publish, keep as draft, or delete when ready.'],
  )
})

test('selected AI service keeps its own probability and source highlight', () => {
  resetDetailState()
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat'),
  ]
  const restore = withDocument({ tabs })

  try {
    detailAiState.availability = {
      artsorakel: { available: true, reason: '' },
      inat: { available: true, reason: '' },
    }
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'success',
        topProbability: 0.91,
        predictions: [
          { scientificName: 'Amanita muscaria', probability: 0.53 },
          { scientificName: 'Amanita rubescens', probability: 0.91 },
        ],
      },
      inat: {
        service: 'inat',
        status: 'success',
        topProbability: 0.74,
        predictions: [
          { scientificName: 'Amanita muscaria', probability: 0.41 },
        ],
      },
    }
    detailAiState.selectedService = 'artsorakel'
    detailAiState.selectedPrediction = detailAiState.resultsByService.artsorakel.predictions[0]
    detailAiState.selectedPredictionByService = {
      artsorakel: detailAiState.resultsByService.artsorakel.predictions[0],
      inat: detailAiState.resultsByService.inat.predictions[0],
    }
    detailAiState.selectedProbabilityByService = {
      artsorakel: 0.53,
      inat: 0.41,
    }

    _renderDetailAiTabs()

    assert.equal(tabs[0].classList.contains('is-used'), true)
    assert.equal(tabs[1].classList.contains('is-used'), false)
    assert.equal(tabs[0].querySelector('.ai-id-service-tab-score').textContent, '91%')
    assert.equal(tabs[1].querySelector('.ai-id-service-tab-score').textContent, '74%')
    assert.match(tabs[0].querySelector('.ai-id-service-tab-icon, .ai-id-dot').outerHTML, /ai-id-service-tab-icon-check/)
    assert.match(tabs[1].querySelector('.ai-id-service-tab-icon, .ai-id-dot').outerHTML, /ai-id-service-tab-icon-dot/)
  } finally {
    restore()
  }
})

test('stored result tab scores fall back to top probability when no explicit selection is stored', () => {
  resetDetailState()
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat'),
  ]
  const restore = withDocument({ tabs })

  try {
    detailAiState.availability = {
      artsorakel: { available: true, reason: '' },
      inat: { available: true, reason: '' },
    }
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'success',
        topProbability: 0.91,
        predictions: [{ scientificName: 'Amanita muscaria', probability: 0.53 }],
      },
      inat: {
        service: 'inat',
        status: 'success',
        topProbability: 0.74,
        predictions: [{ scientificName: 'Amanita muscaria', probability: 0.41 }],
      },
    }

    _renderDetailAiTabs()

    assert.equal(tabs[0].querySelector('.ai-id-service-tab-score').textContent, '91%')
    assert.equal(tabs[1].querySelector('.ai-id-service-tab-score').textContent, '74%')
  } finally {
    restore()
  }
})

test('detail ai run button reflects the running state while a request is in flight', () => {
  resetDetailState()
  const runBtn = {
    disabled: false,
    attributes: {},
    classList: new MockClassList(),
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    querySelector(selector) {
      if (selector === '[data-identify-run-label]') {
        return { textContent: '' }
      }
      return null
    },
  }
  const restore = withDocument({ runBtn })

  try {
    detailAiState.running = true

    _renderDetailAiTabs()

    assert.equal(runBtn.disabled, true)
    assert.equal(runBtn.classList.contains('is-running'), true)
    assert.equal(runBtn.attributes['aria-disabled'], 'true')
  } finally {
    restore()
  }
})

test('detail AI results only highlight an explicit selected species', () => {
  resetDetailState()

  const first = { scientificName: 'Amanita muscaria', probability: 0.91 }
  const second = { scientificName: 'Amanita rubescens', probability: 0.74 }

  const firstResultsEl = makeResultsEl()
  firstResultsEl._items.push(makeIdentifyResultItem(first), makeIdentifyResultItem(second))
  const firstRestore = withDocument({ resultsEl: firstResultsEl })

  try {
    detailAiState.activeService = 'artsorakel'
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'success',
        predictions: [first, second],
      },
    }
    detailAiState.selectedService = null
    detailAiState.selectedPrediction = null
    detailAiState.selectedPredictionByService = {}

    _renderDetailAiResults()

    assert.equal(firstResultsEl._items[0].classList.contains('is-selected'), false)
    assert.equal(firstResultsEl._items[1].classList.contains('is-selected'), false)
  } finally {
    firstRestore()
  }

  const secondResultsEl = makeResultsEl()
  secondResultsEl._items.push(makeIdentifyResultItem(first), makeIdentifyResultItem(second))
  const secondRestore = withDocument({ resultsEl: secondResultsEl })

  try {
    detailAiState.selectedService = 'artsorakel'
    detailAiState.selectedPrediction = second
    detailAiState.selectedPredictionByService = { artsorakel: second }

    _renderDetailAiResults()

    assert.equal(secondResultsEl._items[0].classList.contains('is-selected'), false)
    assert.equal(secondResultsEl._items[1].classList.contains('is-selected'), true)
    assert.equal(secondResultsEl._items[1].attributes['aria-current'], 'true')
  } finally {
    secondRestore()
  }
})

test('missing cached probabilities fall back to the highest stored prediction', () => {
  resetDetailState()
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat'),
  ]
  const restore = withDocument({ tabs })

  try {
    detailAiState.availability = {
      artsorakel: { available: true, reason: '' },
      inat: { available: true, reason: '' },
    }
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'success',
        topProbability: null,
        topPrediction: null,
        predictions: [{ scientificName: 'Amanita muscaria', probability: 0.91 }],
      },
      inat: {
        service: 'inat',
        status: 'success',
        topProbability: null,
        topPrediction: null,
        predictions: [{ scientificName: 'Amanita muscaria', probability: 0.74 }],
      },
    }

    _renderDetailAiTabs()

    assert.equal(tabs[0].querySelector('.ai-id-service-tab-score').textContent, '91%')
    assert.equal(tabs[1].querySelector('.ai-id-service-tab-score').textContent, '74%')
    assert.match(tabs[0].querySelector('.ai-id-service-tab-icon, .ai-id-dot').outerHTML, /ai-id-service-tab-icon-dot/)
    assert.match(tabs[1].querySelector('.ai-id-service-tab-icon, .ai-id-dot').outerHTML, /ai-id-service-tab-icon-dot/)
  } finally {
    restore()
  }
})

test('no-match and error states still render their stored messages', () => {
  resetDetailState()
  const resultsEl = makeResultsEl()
  const restore = withDocument({ resultsEl })

  try {
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'no_match',
        predictions: [],
      },
    }
    _renderDetailAiResults()
    assert.match(resultsEl.innerHTML, /no suggestion|no suggestions/i)

    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'error',
        predictions: [],
        errorMessage: 'Boom',
      },
    }
    _renderDetailAiResults()
    assert.match(resultsEl.innerHTML, /Boom/)
  } finally {
    restore()
  }
})

test('cached stale results do not show outdated warnings on reopen', () => {
  resetDetailState()
  const resultsEl = makeResultsEl()
  const staleNote = { style: {} }
  const restore = withDocument({ resultsEl, staleNote })

  try {
    detailAiState.activeService = 'artsorakel'
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'stale',
        predictions: [],
        errorMessage: '',
      },
    }
    detailAiState.localInputsChanged = false
    detailAiState.stale = false

    _renderDetailAiResults()

    assert.equal(staleNote.style.display, 'none')
    assert.match(resultsEl.innerHTML, /returned no suggestion/i)
    assert.doesNotMatch(resultsEl.innerHTML, /Results outdated/i)
  } finally {
    restore()
  }
})

test('current-session dirty stale results show the outdated warning', () => {
  resetDetailState()
  const resultsEl = makeResultsEl()
  const staleNote = { style: {} }
  const restore = withDocument({ resultsEl, staleNote })

  try {
    detailAiState.activeService = 'artsorakel'
    detailAiState.resultsByService = {
      artsorakel: {
        service: 'artsorakel',
        status: 'stale',
        predictions: [],
        errorMessage: '',
      },
    }
    detailAiState.localInputsChanged = true
    detailAiState.stale = false

    _renderDetailAiResults()

    assert.equal(staleNote.style.display, '')
    assert.match(resultsEl.innerHTML, /Results outdated/i)
  } finally {
    restore()
  }
})

test('helper predicates distinguish stored results from idle states', () => {
  assert.equal(_hasStoredAiResult(null), false)
  assert.equal(_hasStoredAiResult({ status: 'idle' }), false)
  assert.equal(_hasStoredAiResult({ status: 'success' }), true)
  assert.equal(_hasStoredAiResult({ status: 'no_match' }), true)
  assert.equal(_hasStoredAiResult({ status: 'error' }), true)
  assert.equal(_hasStoredAiResult({ status: 'stale' }), true)
  assert.equal(_hasStoredAiResult({ status: 'unavailable' }), true)

  assert.equal(_hasAiRunResult({ status: 'idle' }), false)
  assert.equal(_hasAiRunResult({ status: 'success' }), true)
  assert.equal(_hasAiRunResult({ status: 'no_match' }), true)
  assert.equal(_hasAiRunResult({ status: 'error' }), true)
  assert.equal(_hasAiRunResult({ status: 'stale' }), true)
  assert.equal(_hasAiRunResult({ status: 'unavailable' }), true)
})

// A Find usually arrives with photo-GPS coordinates, but the photo may have
// been taken at home hours later, so the location it carries can be wrong for
// the collection site. The detail screen therefore offers "Edit location" on a
// Find that has coordinates and "Set location" on one that has none.
test('the location action is Edit when a find has coordinates and Set when it has none', () => {
  assert.equal(detailLocationActionMode({ gps_latitude: 63.43, gps_longitude: 10.39 }), 'edit')
  assert.equal(detailLocationActionMode({ gps_latitude: null, gps_longitude: null }), 'set')
  assert.equal(detailLocationActionMode({}), 'set')
  assert.equal(detailLocationActionMode(null), 'set')
  // Null Island is the shape a missing EXIF fix takes, not a real location.
  assert.equal(detailLocationActionMode({ gps_latitude: 0, gps_longitude: 0 }), 'set')
})

// Accuracy and altitude both belonged to the old position, and neither can be
// recovered for the new one — OpenStreetMap's reverse geocoder carries no
// elevation. Keeping them would label a point placed by eye with a precise
// "± 4 m, 109 m ASL".
test('a hand-placed location drops the accuracy and altitude it can no longer claim', () => {
  const patch = buildDetailLocationPatch(63.441122, 10.401234)
  assert.deepEqual(patch, {
    gps_latitude: 63.441122,
    gps_longitude: 10.401234,
    gps_accuracy: null,
    gps_altitude: null,
  })
  // Nothing else may ride along: the picker moves the point and only the point.
  assert.deepEqual(
    Object.keys(patch).sort(),
    ['gps_accuracy', 'gps_altitude', 'gps_latitude', 'gps_longitude'],
  )
})

test('coordinates the app would refuse to render produce no patch at all', () => {
  assert.equal(buildDetailLocationPatch(null, null), null)
  assert.equal(buildDetailLocationPatch(0, 0), null)
  assert.equal(buildDetailLocationPatch(91, 10), null)
  assert.equal(buildDetailLocationPatch('north', 'east'), null)
})
