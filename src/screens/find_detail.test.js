import test from 'node:test'
import assert from 'node:assert/strict'

import {
  _buildDetailAiCachedResults,
  _hasAiRunResult,
  _hasStoredAiResult,
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
  return {
    innerHTML: '',
    style: {},
    dataset: {},
    querySelectorAll() {
      return []
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

test('cached rows select the matching fingerprint and mark older rows stale', () => {
  const rows = [
    {
      service: 'artsorakel',
      status: 'success',
      request_fingerprint: 'req-1',
      top_probability: 0.91,
      results: [{ scientificName: 'Amanita muscaria', probability: 0.91 }],
    },
    {
      service: 'inat',
      status: 'no_match',
      request_fingerprint: 'old-inat',
      results: [],
    },
  ]

  const results = _buildDetailAiCachedResults(rows, {
    artsorakel: 'req-1',
    inat: 'new-inat',
  })

  assert.equal(results.artsorakel.status, 'success')
  assert.equal(results.artsorakel.predictions[0].scientificName, 'Amanita muscaria')
  assert.equal(results.inat.status, 'stale')
  assert.equal(results.inat.predictions.length, 0)
  assert.deepEqual(_buildDetailAiCachedResults([], { artsorakel: 'req-1' }), {})
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
    assert.equal(tabs[0].querySelector('.ai-id-service-tab-score').textContent, '53%')
    assert.equal(tabs[1].querySelector('.ai-id-service-tab-score').textContent, '41%')
  } finally {
    restore()
  }
})

test('missing cached probabilities do not render as 0%', () => {
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

    assert.equal(tabs[0].querySelector('.ai-id-service-tab-score').textContent, '')
    assert.equal(tabs[1].querySelector('.ai-id-service-tab-score').textContent, '')
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
