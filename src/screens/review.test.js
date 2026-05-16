import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

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

test('review ai flow keeps the setting-selected primary service and refreshes availability without rebuilding the grid', () => {
  const source = fs.readFileSync(new URL('./review.js', import.meta.url), 'utf8')

  assert.match(source, /reviewAiState\.activeService = getDefaultIdService\(\)/)
  assert.match(source, /reviewAiState\.activeService = photoIdServices\.primary/)
  assert.match(source, /reviewAiState\.activeService = primaryService/)
  assert.match(source, /const inaturalistSession = await loadInaturalistSession\(\)\s+const availabilityList = await getAvailableIdentifyServices\(\{\s+blobs: images\.map\(item => item\.blob\),\s+inaturalistSession,/)
  assert.match(source, /_renderReviewAiBlock\(\)\s*\n\s*}/)
  assert.doesNotMatch(source, /chooseIdentifyComparisonActiveService/)
  assert.doesNotMatch(source, /comparison\.activeService/)
})
