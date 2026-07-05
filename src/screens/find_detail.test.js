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
  detailAiState,
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
    dataset: { identifyServiceTab: service },
    classList: new MockClassList(active ? ['is-active'] : []),
    disabled: false,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
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
