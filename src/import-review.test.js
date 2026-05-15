import test from 'node:test'
import assert from 'node:assert/strict'

import { buildIdentifyFingerprint } from './ai-identification.js'
import {
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
      scientificName: 'Amanita muscaria',
      vernacularName: 'Fly agaric',
      probability: 0.91,
    }],
  }, fingerprint)

  assert.equal(session.aiPredictionsByService.artsorakel.length, 1)
  assert.equal(session.aiServiceState.artsorakel.status, 'success')
  assert.equal(session.aiPredictionsByService.inat.length, 0)
  assert.equal(session.aiServiceState.inat.status, 'idle')

  const artsState = _sessionAiResultState(session, 'artsorakel')
  const inatState = _sessionAiResultState(session, 'inat')
  assert.equal(artsState.status, 'success')
  assert.equal(artsState.topProbability, 0.91)
  assert.equal(inatState.status, 'idle')
})

test('import session service rerun detection only trips when the fingerprint changes', () => {
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
  assert.equal(_sessionServiceNeedsRerun(session, 'artsorakel'), true)
  assert.equal(_sessionServiceNeedsRerun(session, 'inat'), true)
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
  ])

  assert.equal(applied, true)
  assert.deepEqual(session.taxon, {
    genus: 'Amanita',
    specificEpithet: 'muscaria',
    vernacularName: 'Fly agaric',
    scientificName: 'Amanita muscaria',
    displayName: 'Fly agaric (Amanita muscaria)',
  })
})
