import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { initReview } from './review.js'

test('review service-tab clicks update the ai block without rebuilding the grid', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')
  const start = source.indexOf("tab.addEventListener('click', () => {")
  const end = source.indexOf('// Wire the in-card uncertain toggle (replaces the static #review-uncertain)')

  assert.ok(start >= 0)
  assert.ok(end > start)

  const block = source.slice(start, end)
  assert.match(block, /_renderReviewAiBlock\(\)/)
  assert.match(block, /shouldRunServiceFromTab\(serviceState\)/)
  assert.doesNotMatch(block, /buildReviewGrid\(\)/)

  assert.match(source, /resultsEl\.querySelectorAll\('\[data-identify-result\]'\)/)
  assert.match(source, /_renderReviewAiResults\(\)[\s\S]*resultsEl\.innerHTML = _reviewAiResultsHtml\(\)/)
})

test('review crop hint switches to adjust copy and disappears once a custom crop exists', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /const cropStatusHtml = croppedCount\s*\?\s*''\s*:\s*`<div class="capture-session-crop-status">\$\{t\('review\.aiCropHint'\)\}<\/div>`/)
  assert.match(source, /shouldShowAiCropOverlay\(p\.aiCropRect, p\.aiCropIsCustom\)/)
  assert.doesNotMatch(source, /Tap a photo to add AI crop/)
})

test('review ai flow keeps the setting-selected primary service and refreshes availability without rebuilding the grid', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /reviewAiState\.activeService = _resolveReviewPhotoIdServices\(reviewAiState\.availability\)\.primary/)
  assert.match(source, /const primaryService = overrideService\s*\?\s*requestedServices\[0\]\s*:\s*\(requestedServices\[0\] \|\| photoIdServices\.primary\)/)
  assert.match(source, /reviewAiState\.activeService = primaryService/)
  assert.match(source, /const inaturalistSession = await loadInaturalistSession\(\)\s+const availabilityList = await getAvailableIdentifyServices\(\{\s+blobs: images,\s+inaturalistSession,/)
  assert.match(source, /if \(!reviewAiState\.activeService\) {\s+reviewAiState\.activeService = _resolveReviewPhotoIdServices\(reviewAiState\.availability\)\.primary\s+}/)
  assert.match(source, /reviewAiState\.running = false\s+reviewAiState\.requestedFingerprint = reviewAiState\.currentFingerprint\s+reviewAiState\.activeService = primaryService\s+_renderReviewAiBlock\(\)/)
  assert.doesNotMatch(source, /chooseIdentifyComparisonActiveService/)
  assert.doesNotMatch(source, /comparison\.activeService/)
  assert.doesNotMatch(source, /buildReviewGrid\(\)\s*\/\/.*availability/)
})

test('review keeps ai result state separate from manual taxon selection and queued saves', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /getReviewServiceDisplayProbability/)
  assert.match(source, /selectedPredictionByService/)
  assert.match(source, /selectedProbabilityByService/)
  assert.match(source, /aiIdentificationRuns/)
  assert.match(source, /score\.textContent = _reviewAiHasProbability\(state\.displayProbability\)/)
  assert.doesNotMatch(source, /selectedTaxon:\s*taxon/)
  assert.doesNotMatch(source, /reviewAiState\.resultsByService\[normalizeIdentifyService\(pred\.service\)\]\s*=\s*{\s*\.\.\./)
})

test('review keeps ai results visible after taxon selection and scores follow the top probability first', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  const sharedTaxonStart = source.indexOf('function setSharedTaxon(')
  const sharedTaxonEnd = source.indexOf('function applyTaxon(')
  assert.ok(sharedTaxonStart >= 0)
  assert.ok(sharedTaxonEnd > sharedTaxonStart)
  const sharedTaxonBlock = source.slice(sharedTaxonStart, sharedTaxonEnd)

  assert.match(sharedTaxonBlock, /taxon-dropdown/)
  assert.doesNotMatch(sharedTaxonBlock, /data-identify-results/)
  assert.match(source, /resultsEl\.style\.display = ''/)

  const probabilityStart = source.indexOf('export function getReviewServiceDisplayProbability')
  const probabilityEnd = source.indexOf('// ── Grid build ────────────────────────────────────────────────────────────────')
  assert.ok(probabilityStart >= 0)
  assert.ok(probabilityEnd > probabilityStart)
  const probabilityBlock = source.slice(probabilityStart, probabilityEnd)

  assert.match(probabilityBlock, /getIdentifyTopProbability/)
  assert.match(probabilityBlock, /selectedProbabilityByService/)
  assert.match(probabilityBlock, /selectedPrediction/)
})

test('review init tolerates missing review shell nodes without throwing', () => {
  const previousDocument = globalThis.document
  globalThis.document = {
    getElementById() {
      return null
    },
    querySelectorAll() {
      return []
    },
    querySelector() {
      return null
    },
  }

  try {
    assert.doesNotThrow(() => initReview())
  } finally {
    globalThis.document = previousDocument
  }
})
