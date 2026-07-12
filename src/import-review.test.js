import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { buildIdentifyFingerprint } from './ai-identification.js'
import { shouldShowAiCropOverlay } from './image_crop.js'
import { _buildImportedReviewAiState } from './screens/review.js'
import {
  _buildImportObservationPayload,
  _cloneSessionAiState,
  _ensureSessionAiState,
  _applySessionAiTopPrediction,
  _sessionAiResultState,
  _sessionServiceNeedsRerun,
  _storeSessionAiServiceResult,
} from './screens/import_review.js'

function makeSession() {
  return {
    id: 'session-1',
    files: [new Blob(['a'], { type: 'image/jpeg' })],
    aiFiles: [new Blob(['a'], { type: 'image/jpeg' })],
    imageMeta: [{
      aiCropRect: { x1: 0, y1: 0, x2: 1, y2: 1 },
      aiCropSourceW: 1600,
      aiCropSourceH: 1200,
      aiCropIsCustom: false,
    }],
    aiPredictions: [],
    aiPredictionsByService: {},
    aiServiceState: {},
  }
}

test('import sessions keep service predictions and state separate', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'success',
    predictions: [{
      scientificName: 'Amanita pantherina',
      vernacularName: 'Panther cap',
      probability: 0.53,
    }, {
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      probability: 0.91,
    }],
  }, fingerprint)

  assert.equal(session.aiPredictionsByService.artsorakel.length, 2)
  assert.equal(session.aiServiceState.artsorakel.status, 'success')
  assert.equal(session.aiPredictionsByService.inat.length, 0)
  assert.equal(session.aiServiceState.inat.status, 'idle')

  const artsState = _sessionAiResultState(session, 'artsorakel')
  const inatState = _sessionAiResultState(session, 'inat')
  assert.equal(artsState.status, 'success')
  assert.equal(artsState.topProbability, 0.91)
  assert.equal(artsState.showCheckmark, true)
  assert.equal(inatState.status, 'idle')
})

test('import session terminal states stay stable across fingerprint changes for tab reruns', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'no_match',
    predictions: [],
  }, fingerprint)

  assert.equal(_sessionServiceNeedsRerun(session, 'artsorakel'), false)
  session.imageMeta[0] = {
    ...session.imageMeta[0],
    aiCropRect: { x1: 0.1, y1: 0, x2: 1, y2: 1 },
  }
  assert.equal(_sessionServiceNeedsRerun(session, 'artsorakel'), false)
  assert.equal(_sessionServiceNeedsRerun(session, 'inat'), true)
})

test('import session keeps terminal service states from rerunning on tab clicks', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  for (const status of ['no_match', 'error', 'unavailable']) {
    _storeSessionAiServiceResult(session, 'artsorakel', {
      status,
      predictions: [],
      errorMessage: status === 'error' ? 'Boom' : '',
    }, fingerprint)

    assert.equal(_sessionServiceNeedsRerun(session, 'artsorakel'), false)
  }
})

test('empty import sessions do not default to Artsorakel active service', () => {
  const session = _ensureSessionAiState({
    id: 'session-empty',
    files: [],
    aiPredictionsByService: {},
    aiServiceState: {},
  })

  assert.equal(session.aiActiveService, null)
  assert.equal(session.aiService, null)
})

test('ID All applies the top prediction to the session taxon', () => {
  const session = _ensureSessionAiState(makeSession())
  const applied = _applySessionAiTopPrediction(session, [
    {
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      displayName: 'Fly agaric (Amanita muscaria)',
      probability: 0.91,
    },
    {
      scientificName: 'Amanita pantherina',
      vernacularName: 'Panther cap',
      displayName: 'Panther cap (Amanita pantherina)',
      probability: 0.52,
    },
  ], { service: 'artsorakel' })

  assert.equal(applied, true)
  assert.deepEqual(session.taxon, {
    genus: 'Amanita',
    specificEpithet: 'muscaria',
    vernacularName: 'Fly agaric',
    scientificName: 'Amanita muscaria',
    displayName: 'Fly agaric (Amanita muscaria)',
  })
  assert.equal(session.aiSelectedTaxonSource, 'ai')
  assert.equal(session.aiSelectedService, 'artsorakel')
  assert.equal(session.aiSelectedPrediction.scientificName, 'Amanita muscaria')
  assert.equal(session.aiSelectedProbabilityByService.artsorakel, 0.91)
})

test('import-review save payload keeps the selected AI run and payload fields', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  const predictions = [
    {
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      taxonId: '12345',
      probability: 0.91,
      service: 'artsorakel',
    },
    {
      scientificName: 'Amanita pantherina',
      vernacularName: 'Panther cap',
      taxonId: '67890',
      probability: 0.52,
      service: 'artsorakel',
    },
  ]

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'success',
    predictions,
  }, fingerprint)
  _applySessionAiTopPrediction(session, predictions, { service: 'artsorakel' })

  const { obsPayload } = _buildImportObservationPayload(session, { userId: 'user-1' })
  assert.equal(obsPayload.aiIdentificationRuns.length, 1)
  const run = obsPayload.aiIdentificationRuns[0]
  assert.equal(run.service, 'artsorakel')
  assert.equal(run.requestFingerprint, fingerprint.requestFingerprint)
  assert.equal(run.imageFingerprint, fingerprint.imageFingerprint)
  assert.equal(run.cropFingerprint, fingerprint.cropFingerprint)
  assert.equal(run.status, 'success')
  assert.equal(run.results.length, 2)
  assert.equal(run.results[0].scientificName, 'Amanita muscaria')

  assert.equal(obsPayload.genus, 'Amanita')
  assert.equal(obsPayload.species, 'muscaria')
  assert.equal(obsPayload.common_name, 'Fly agaric')
  assert.equal(obsPayload.ai_selected_service, 'artsorakel')
  assert.equal(obsPayload.ai_selected_taxon_id, '12345')
  assert.equal(obsPayload.ai_selected_scientific_name, 'Amanita muscaria')
  assert.equal(obsPayload.ai_selected_probability, 0.91)
  assert.match(obsPayload.ai_selected_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('import-review warns when queued sessions are missing location data', () => {
  const source = fs.readFileSync(new URL('./screens/import_review.js', import.meta.url), 'utf8')

  assert.match(source, /import-location-hint--warning/)
  assert.match(source, /hasObservationLocation\(session\)/)
  assert.match(source, /common\.locationMissingWarning/)
  assert.match(source, /window\.confirm\(/)
  assert.match(source, /common\.saveWithoutLocationConfirm/)
})

test('import-review save payload preserves both service runs and chooses the best active service', () => {
  const session = _ensureSessionAiState(makeSession())
  const artsFingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })
  const inatFingerprint = buildIdentifyFingerprint({
    service: 'inat',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'success',
    predictions: [{
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      taxonId: '12345',
      probability: 0.81,
      service: 'artsorakel',
    }],
  }, artsFingerprint)
  _storeSessionAiServiceResult(session, 'inat', {
    status: 'success',
    predictions: [{
      scientificName: 'Amanita pantherina',
      vernacularName: 'Panther cap',
      taxonId: '67890',
      probability: 0.94,
      service: 'inat',
    }],
  }, inatFingerprint)

  const { obsPayload } = _buildImportObservationPayload(session, { userId: 'user-1' })
  assert.equal(obsPayload.aiIdentificationRuns.length, 2)
  assert.deepEqual(obsPayload.aiIdentificationRuns.map(run => run.service).sort(), ['artsorakel', 'inat'])
  assert.equal(obsPayload.ai_selected_service, 'inat')
  assert.equal(obsPayload.ai_selected_taxon_id, '67890')
  assert.equal(obsPayload.ai_selected_scientific_name, 'Amanita pantherina')
  assert.equal(obsPayload.ai_selected_probability, 0.94)
})

test('import-review save payload marks a changed crop as stale and fingerprints the edited crop', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'success',
    predictions: [{
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      taxonId: '12345',
      probability: 0.91,
      service: 'artsorakel',
    }],
  }, fingerprint)
  _applySessionAiTopPrediction(session, [{
    scientificName: 'Amanita muscaria',
    vernacularName: 'Fly agaric',
    taxonId: '12345',
    probability: 0.91,
    service: 'artsorakel',
  }], { service: 'artsorakel' })

  session.imageMeta[0] = {
    ...session.imageMeta[0],
    aiCropRect: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
    aiCropIsCustom: true,
  }

  const changedFingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  const { obsPayload } = _buildImportObservationPayload(session, { userId: 'user-1' })
  const run = obsPayload.aiIdentificationRuns[0]

  assert.equal(run.requestFingerprint, changedFingerprint.requestFingerprint)
  assert.equal(run.imageFingerprint, changedFingerprint.imageFingerprint)
  assert.equal(run.cropFingerprint, changedFingerprint.cropFingerprint)
  assert.equal(run.status, 'stale')
})

test('import-review handoff preserves AI state for the review screen', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'success',
    predictions: [{
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      taxonId: '12345',
      probability: 0.91,
      service: 'artsorakel',
    }],
  }, fingerprint)
  _applySessionAiTopPrediction(session, [{
    scientificName: 'Amanita muscaria',
    vernacularName: 'Fly agaric',
    taxonId: '12345',
    probability: 0.91,
    service: 'artsorakel',
  }], { service: 'artsorakel' })

  const cloned = _cloneSessionAiState(session)
  const reviewAiState = _buildImportedReviewAiState(cloned)

  assert.equal(reviewAiState.resultsByService.artsorakel.status, 'success')
  assert.equal(reviewAiState.activeService, 'artsorakel')
  assert.equal(reviewAiState.selectedTaxonSource, 'ai')
  assert.equal(reviewAiState.selectedService, 'artsorakel')
  assert.equal(reviewAiState.selectedPrediction.scientificName, 'Amanita muscaria')
  assert.equal(reviewAiState.selectedPredictionByService.artsorakel.scientificName, 'Amanita muscaria')
  assert.equal(reviewAiState.hasRun, true)
})

test('service state only shows running for the service that is actually running', () => {
  const session = _ensureSessionAiState(makeSession())
  const fingerprint = buildIdentifyFingerprint({
    service: 'artsorakel',
    language: 'en',
    images: [{
      id: 'session-1-0',
      blob: session.aiFiles[0],
      cropRect: session.imageMeta[0].aiCropRect,
      cropSourceW: session.imageMeta[0].aiCropSourceW,
      cropSourceH: session.imageMeta[0].aiCropSourceH,
      sourceType: 'photo.aiBlob',
    }],
  })
  session.aiServiceState.artsorakel = {
    service: 'artsorakel',
    status: 'success',
    topProbability: 0.91,
    topScore: 0.91,
    imageFingerprint: fingerprint.imageFingerprint,
    cropFingerprint: fingerprint.cropFingerprint,
    requestFingerprint: fingerprint.requestFingerprint,
  }
  session.aiServiceState.inat = {
    service: 'inat',
    status: 'running',
    topProbability: null,
    topScore: null,
    imageFingerprint: fingerprint.imageFingerprint,
    cropFingerprint: fingerprint.cropFingerprint,
    requestFingerprint: fingerprint.requestFingerprint,
  }
  session.aiCurrentFingerprint = fingerprint.requestFingerprint
  session.aiRequestedFingerprint = fingerprint.requestFingerprint

  const arts = _sessionAiResultState(session, 'artsorakel')
  const inat = _sessionAiResultState(session, 'inat')

  assert.equal(arts.status, 'success')
  assert.equal(inat.status, 'running')
})

test('import review source imports the comparison active-service helper', () => {
  const source = fs.readFileSync(new URL('./screens/import_review.js', import.meta.url), 'utf8')
  assert.match(source, /chooseIdentifyComparisonActiveService/)
  assert.match(source, /allowDuringBatch/)
  assert.match(source, /const availabilityList = await getAvailableIdentifyServices/)
  assert.match(source, /sessionAi\.aiAvailability = availability/)
})

test('ai crop overlays only display for custom crops', () => {
  const rect = { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }
  assert.equal(shouldShowAiCropOverlay(rect, false), false)
  assert.equal(shouldShowAiCropOverlay(rect, true), true)
})
