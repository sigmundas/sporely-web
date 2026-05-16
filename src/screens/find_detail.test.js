import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { _setDetailAiActiveService } from './find_detail.js'

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
  return {
    dataset: { identifyServiceTab: service },
    classList: new MockClassList(active ? ['is-active'] : []),
    disabled: false,
    querySelector(selector) {
      if (selector === '.ai-id-service-tab-icon') return icon
      if (selector === '.ai-id-service-tab-score') return score
      return null
    },
  }
}

test('find detail service-tab click updates active tab class', () => {
  const tabs = [
    makeTab('artsorakel', true),
    makeTab('inat', false),
  ]
  const runDot = { className: 'ai-id-dot' }
  const runLabel = { textContent: '' }
  const runBtn = {
    disabled: false,
    querySelector(selector) {
      if (selector === '.ai-id-dot') return runDot
      if (selector === '[data-identify-run-label]') return runLabel
      return null
    },
  }
  const previousDocument = globalThis.document

  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === '[data-identify-service-tab]') return tabs
      return []
    },
    querySelector(selector) {
      if (selector === '[data-identify-run-button]') return runBtn
      return null
    },
    getElementById() {
      return null
    },
  }

  try {
    _setDetailAiActiveService('inat')
    assert.equal(tabs[0].classList.contains('is-active'), false)
    assert.equal(tabs[1].classList.contains('is-active'), true)
  } finally {
    globalThis.document = previousDocument
  }
})

test('find detail ai flow defaults to the setting-selected primary service and requires usable blobs for iNaturalist', () => {
  const source = fs.readFileSync(new URL('./find_detail.js', import.meta.url), 'utf8')

  assert.match(source, /detailAiState\.activeService = getDefaultIdService\(\)/)
  assert.match(source, /const identifyInputs = await prepareDetailIdentifyInputs\(sources\.galleryImgs, 'medium'\)/)
  assert.match(source, /const hasInatBlob = usableBlobs\.length > 0/)
  assert.match(source, /available: Boolean\(inatLoggedIn && hasInatBlob\)/)
  assert.match(source, /detailAiState\.activeService = photoIdServices\.primary/)
  assert.match(source, /detailAiState\.activeService = primaryService/)
  assert.match(source, /photoIdServices: resolution/)
  assert.match(source, /const inaturalistSession = await loadInaturalistSession\(\)\s+const availabilityList = await getAvailableIdentifyServices\(\{\s+mediaKeys: detailImageRows\.map\(row => row\.storage_path\)\.filter\(Boolean\),\s+inaturalistSession,/)
  assert.doesNotMatch(source, /chooseIdentifyComparisonActiveService/)
  assert.doesNotMatch(source, /comparison\.activeService/)
  assert.doesNotMatch(source, /activeService = ID_SERVICE_ARTSORAKEL/)
})
