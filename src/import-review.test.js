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
  __abortImportAiRunsForTests,
  __getImportAiBatchStateForTests,
  __getImportAiStateForTests,
  __renderImportAiControlsForTests,
  __runImportAiBatchForTests,
  __runImportAiComparisonForTests,
  __setImportAiSessionsForTests,
  __setImportAiTestHooks,
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

function manualTimers() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimeoutImpl(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, at: now + Number(delay || 0) })
      return id
    },
    clearTimeoutImpl(id) {
      timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.callback()
      }
      now = target
    },
    get activeCount() {
      return timers.size
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(res => { resolve = res })
  return { promise, resolve }
}

async function waitFor(predicate, attempts = 50) {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Condition did not become true')
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
  session.locationLookup = {
    country_code: 'ca',
    region_id: 'region-123',
  }

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
  assert.equal(obsPayload.country_code, 'CA')
  assert.equal(obsPayload.region_id, 'region-123')
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

test('import-review save payload omits invalid geography values', () => {
  const session = _ensureSessionAiState(makeSession())
  session.locationLookup = {
    country_code: 'Norway',
    region_id: '   ',
  }

  const { obsPayload } = _buildImportObservationPayload(session, { userId: 'user-1' })
  assert.equal(obsPayload.country_code, undefined)
  assert.equal(obsPayload.region_id, undefined)
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

test('import review keeps a successful provider visible while the other is slow or times out', () => {
  const session = _ensureSessionAiState(makeSession())
  session.aiActiveService = 'inat'
  session.aiService = 'inat'
  session.aiServiceState.artsorakel = { status: 'running' }
  session.aiServiceState.inat = { status: 'running' }

  _storeSessionAiServiceResult(session, 'inat', {
    status: 'success',
    predictions: [{
      scientificName: 'Amanita muscaria',
      displayName: 'Amanita muscaria',
      probability: 0.91,
    }],
  })
  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'slow',
    errorMessage: 'Artsorakel is taking longer than usual.',
    predictions: [],
  })

  assert.equal(session.aiActiveService, 'inat')
  assert.equal(session.aiRunning, true)
  assert.equal(session.aiServiceState.inat.status, 'success')
  assert.equal(session.aiServiceState.artsorakel.status, 'slow')

  _storeSessionAiServiceResult(session, 'artsorakel', {
    status: 'timeout',
    errorMessage: 'Artsorakel timed out. Please try again.',
    predictions: [],
  })

  assert.equal(session.aiActiveService, 'inat')
  assert.equal(session.aiRunning, false)
  assert.equal(session.aiServiceState.inat.status, 'success')
  assert.equal(session.aiServiceState.artsorakel.status, 'timeout')
})

test('import review provider lifecycle uses per-provider updates and teardown cancellation', () => {
  const source = fs.readFileSync(new URL('./screens/import_review.js', import.meta.url), 'utf8')

  assert.match(source, /_importAiDependency\('runIdentifyComparisonForBlobs', runIdentifyComparisonForBlobs\)\(/)
  assert.match(source, /onServiceState: result =>/)
  assert.match(source, /shouldAutoActivateIdentifyResult\(\s*result,\s*activeState,\s*importAiManualTabSessions\.has\(sid\)/)
  assert.match(source, /if \(normalized\.aiRunning\) importAiManualTabSessions\.add\(sid\)/)
  assert.match(source, /function _abortImportAiRuns\(\) {[\s\S]*?for \(const controller of importAiRunControllers\.values\(\)\) controller\.abort\(\)/)
  assert.match(source, /function _cancelImport\(\) {[\s\S]*?_abortImportAiRuns\(\)/)
})

test('import review renders independently, reaches batch terminal progress, and rejects obsolete callbacks', async () => {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        return null
      },
      setItem() {},
      removeItem() {},
    },
  })
  const timers = manualTimers()
  const footerStates = []
  const signals = {}
  const oldOperations = {
    artsorakel: deferred(),
    inat: deferred(),
  }
  let runMode = 'timeout'

  __setImportAiTestHooks({
    persistSessions() {},
    renderSessions() {},
    showToast() {},
    updateFooter(batchState) {
      footerStates.push({ ...batchState })
    },
    loadInaturalistSession: async () => ({ connected: true, api_token: 'token' }),
    getAvailableIdentifyServices: async () => [
      { service: 'artsorakel', available: true, reason: '' },
      { service: 'inat', available: true, reason: '' },
    ],
    resolvePhotoIdServices: () => ({
      primary: 'artsorakel',
      run: ['artsorakel', 'inat'],
    }),
    identifyBlobs: async (_blobs, service, _language, options) => {
      signals[service] = options.signal
      options.onImageSent?.()
      if (runMode === 'timeout') {
        if (service === 'artsorakel') return new Promise(() => {})
        options.onIdReceived?.()
        return [{ scientificName: 'Amanita muscaria', probability: 0.91 }]
      }
      if (runMode === 'batch-timeout' || runMode === 'old') return oldOperations[service].promise
      options.onIdReceived?.()
      return service === 'inat'
        ? [{ scientificName: 'Boletus edulis', probability: 0.88 }]
        : []
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  })

  try {
    __setImportAiSessionsForTests([makeSession()])
    const timeoutRun = __runImportAiComparisonForTests('session-1')
    await waitFor(() => __getImportAiStateForTests('session-1')?.aiServiceState?.inat?.status === 'success')

    let sessionState = __getImportAiStateForTests('session-1')
    assert.equal(sessionState.aiActiveService, 'inat')
    assert.equal(sessionState.aiRunning, true)
    assert.match(__renderImportAiControlsForTests('session-1'), /Amanita muscaria/)
    assert.match(__renderImportAiControlsForTests('session-1'), /data-identify-run-button[\s\S]*disabled/)

    timers.advance(20_000)
    await timeoutRun
    sessionState = __getImportAiStateForTests('session-1')
    assert.equal(sessionState.aiServiceState.artsorakel.status, 'timeout')
    assert.equal(sessionState.aiServiceState.inat.status, 'success')
    assert.equal(sessionState.aiActiveService, 'inat')
    assert.equal(sessionState.aiRunning, false)
    assert.match(__renderImportAiControlsForTests('session-1'), /Amanita muscaria/)
    assert.doesNotMatch(__renderImportAiControlsForTests('session-1'), /data-identify-run-button[^>]*disabled/)
    assert.equal(timers.activeCount, 0)

    runMode = 'old'
    signals.artsorakel = null
    signals.inat = null
    __setImportAiSessionsForTests([makeSession()])
    const obsoleteRun = __runImportAiComparisonForTests('session-1')
    await waitFor(() => Boolean(signals.artsorakel && signals.inat))
    __abortImportAiRunsForTests()
    assert.equal(signals.artsorakel.aborted, true)
    assert.equal(signals.inat.aborted, true)

    const nextSession = makeSession()
    __setImportAiSessionsForTests([nextSession])
    runMode = 'new'
    await __runImportAiComparisonForTests('session-1')
    assert.match(__renderImportAiControlsForTests('session-1'), /Boletus edulis/)

    oldOperations.artsorakel.resolve([{ scientificName: 'Stale arts result', probability: 0.99 }])
    oldOperations.inat.resolve([{ scientificName: 'Stale inat result', probability: 0.99 }])
    await obsoleteRun
    assert.match(__renderImportAiControlsForTests('session-1'), /Boletus edulis/)
    assert.doesNotMatch(__renderImportAiControlsForTests('session-1'), /Stale (arts|inat) result/)

    const batchOperations = {
      artsorakel: deferred(),
      inat: deferred(),
    }
    oldOperations.artsorakel = batchOperations.artsorakel
    oldOperations.inat = batchOperations.inat
    runMode = 'batch-timeout'
    footerStates.length = 0
    __setImportAiSessionsForTests([makeSession()])
    const batchRun = __runImportAiBatchForTests()
    await waitFor(() => timers.activeCount === 4)
    timers.advance(20_000)
    await batchRun

    assert.equal(__getImportAiBatchStateForTests().running, false)
    assert.equal(__getImportAiStateForTests('session-1').aiRunning, false)
    assert.equal(__getImportAiStateForTests('session-1').aiServiceState.artsorakel.status, 'timeout')
    assert.equal(__getImportAiStateForTests('session-1').aiServiceState.inat.status, 'timeout')
    assert.equal(footerStates.some(item => item.totalUnits === 2 && item.completedUnits === 2), true)
    assert.equal(footerStates.at(-1).running, false)
    assert.equal(timers.activeCount, 0)
  } finally {
    __abortImportAiRunsForTests()
    __setImportAiTestHooks(null)
    __setImportAiSessionsForTests([])
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage')
    }
  }
})

test('import review source imports the comparison active-service helper', () => {
  const source = fs.readFileSync(new URL('./screens/import_review.js', import.meta.url), 'utf8')
  assert.match(source, /chooseIdentifyComparisonActiveService/)
  assert.match(source, /allowDuringBatch/)
  assert.match(source, /const availabilityList = await _importAiDependency\('getAvailableIdentifyServices', getAvailableIdentifyServices\)/)
  assert.match(source, /sessionAi\.aiAvailability = availability/)
})

test('ai crop overlays only display for custom crops', () => {
  const rect = { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }
  assert.equal(shouldShowAiCropOverlay(rect, false), false)
  assert.equal(shouldShowAiCropOverlay(rect, true), true)
})
