import { Preferences } from '@capacitor/preferences';
import { state } from '../state.js';
import { formatDate, formatTime, getTaxonomyLanguage, t, tp, translateVisibility } from '../i18n.js';
import { navigate } from '../router.js';
import { showToast } from '../toast.js';
import { searchTaxa, formatDisplayName, createManualTaxon } from '../artsorakel.js';
import { enqueueObservation } from '../sync-queue.js';
import { openFinds } from './finds.js';
import { openImportedReview } from './review.js';
import { saveImportSessions, clearImportSessions } from '../import-store.js';
import { openAiCropEditor } from '../ai-crop-editor.js';
import { createImageCropMeta, hasAiCropRect } from '../image_crop.js';
import { getDefaultIdService, getDefaultVisibility, getPhotoGapMinutes, setPhotoGapMinutes, getUseSystemCamera, NATIVE_CAMERA_JPEG_QUALITY } from '../settings.js';
import { normalizeCaptureVisibility, normalizeVisibility, toCloudVisibility } from '../visibility.js';
import { lookupCoordinateKey, lookupReverseLocation } from '../location-lookup.js';
import { isAndroidNativeApp } from '../camera-actions.js';
import { loadInaturalistSession } from '../inaturalist.js';
import { NativeCamera, isPickerCancel, pickImagesWithNativePhotoPicker, nativePickedPhotoToFile, captureNativePhotoExif, createNativeMetadataHydrationPromise, captureExif, processFile } from './import-helpers.js';
import { getIdentifyNoMatchMessage, getIdentifyUnavailableMessage, runIdentifyForBlobs, ID_SERVICE_INATURALIST } from '../identify.js';
import {
  buildIdentifyFingerprint,
  getAvailableIdentifyServices,
  getIdentifyConfidenceState,
  renderIdentifyResultRows,
  renderIdentifyServiceTab,
  renderIdentifyServiceStateSummary,
  ID_SERVICE_ARTSORAKEL,
  normalizeIdentifyService,
} from '../ai-identification.js';

let sessions = [];
let expandedSessionIds = new Set();
let sourceItems = [];
const importAiBatchState = {
  running: false,
  completedUnits: 0,
  totalUnits: 0,
  defaultServiceAvailable: true,
  defaultServiceReason: '',
  defaultServiceLabel: '',
};

function _isBlob(b) {
  return b instanceof Blob || (b && typeof b.size === 'number' && typeof b.type === 'string')
}

function _persistSessions() {
  saveImportSessions(sessions);
}

function _resetImportAiBatchState() {
  importAiBatchState.running = false;
  importAiBatchState.completedUnits = 0;
  importAiBatchState.totalUnits = 0;
  importAiBatchState.defaultServiceLabel = '';
}

function _getBatchAiTargets() {
  return sessions.filter(session => Array.isArray(session?.files) && session.files.length > 0);
}

function _getBatchAiTotalUnits(targets = _getBatchAiTargets()) {
  return targets.reduce((sum, session) => sum + ((session.files?.length || 0) * 2), 0);
}

function _incrementBatchAiProgress(step = 1) {
  importAiBatchState.completedUnits = Math.min(
    importAiBatchState.totalUnits,
    importAiBatchState.completedUnits + step,
  );
  _updateImportFooterUi();
}

function _applySessionAiPrediction(session, prediction) {
  if (!session || !prediction) return false;
  const parts = String(prediction.scientificName || '').trim().split(/\s+/);
  session.taxon = {
    genus: parts[0] || null,
    specificEpithet: parts[1] || null,
    vernacularName: prediction.vernacularName || null,
    scientificName: prediction.scientificName || null,
    displayName: prediction.displayName,
  };
  return true;
}

function _applySessionAiTopPrediction(session, predictions = []) {
  if (!Array.isArray(predictions) || !predictions.length) return false;
  return _applySessionAiPrediction(session, predictions[0]);
}

function _storeSessionAiServiceResult(session, service, result = {}, fingerprint = null) {
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return null
  const svc = normalizeIdentifyService(service)
  const predictions = Array.isArray(result.predictions) ? result.predictions : []
  const status = result.status || (predictions.length ? 'success' : 'no_match')
  const nextState = {
    ..._emptyServiceState(),
    ...(normalized.aiServiceState?.[svc] || {}),
    status,
    topScore: Number.isFinite(Number(result.topProbability))
      ? Number(result.topProbability)
      : (Number.isFinite(Number(predictions[0]?.probability)) ? Number(predictions[0].probability) : null),
    topProbability: Number.isFinite(Number(result.topProbability))
      ? Number(result.topProbability)
      : (Number.isFinite(Number(predictions[0]?.probability)) ? Number(predictions[0].probability) : null),
    errorMessage: result.errorMessage || '',
    requestFingerprint: fingerprint?.requestFingerprint || result.requestFingerprint || '',
    imageFingerprint: fingerprint?.imageFingerprint || result.imageFingerprint || '',
    cropFingerprint: fingerprint?.cropFingerprint || result.cropFingerprint || '',
  }

  normalized.aiPredictionsByService[svc] = predictions
  normalized.aiServiceState[svc] = nextState
  normalized.aiActiveService = svc
  normalized.aiService = svc
  normalized.aiPredictions = predictions
  return nextState
}

function _emptyServiceState() {
  return {
    status: 'idle',
    topScore: null,
    topProbability: null,
    errorMessage: '',
    requestFingerprint: '',
    imageFingerprint: '',
    cropFingerprint: '',
  };
}

function _normalizePredictionList(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray(value.predictions)) return value.predictions
  return []
}

function _normalizeLegacyServiceState(value, predictions = []) {
  if (!value || typeof value !== 'object') {
    return {
      ..._emptyServiceState(),
      status: Array.isArray(predictions) && predictions.length ? 'success' : 'idle',
    }
  }

  const status = value.status || (Array.isArray(predictions) && predictions.length ? 'success' : 'idle')
  const topScore = Number.isFinite(Number(value.topScore))
    ? Number(value.topScore)
    : (Number.isFinite(Number(value.topProbability)) ? Number(value.topProbability) : null)

  return {
    ..._emptyServiceState(),
    ...value,
    status,
    topScore,
    topProbability: topScore,
    errorMessage: value.errorMessage || value.error || '',
    requestFingerprint: value.requestFingerprint || value.request_fingerprint || '',
    imageFingerprint: value.imageFingerprint || value.image_fingerprint || '',
    cropFingerprint: value.cropFingerprint || value.crop_fingerprint || '',
  }
}

function _ensureSessionAiState(session) {
  if (!session) return null;
  if (!session.aiPredictionsByService || typeof session.aiPredictionsByService !== 'object') session.aiPredictionsByService = {};
  if (!session.aiServiceState || typeof session.aiServiceState !== 'object') session.aiServiceState = {};
  if (!session.aiAvailability) session.aiAvailability = {};
  if (!session.aiActiveService) session.aiActiveService = getDefaultIdService();
  if (!session.aiCurrentFingerprint) session.aiCurrentFingerprint = '';
  if (!session.aiRequestedFingerprint) session.aiRequestedFingerprint = '';
  if (!session.aiAvailabilityFingerprint) session.aiAvailabilityFingerprint = '';
  const legacyService = normalizeIdentifyService(session.aiService || session.aiActiveService || getDefaultIdService());
  if (Array.isArray(session.aiPredictions) && session.aiPredictions.length && !session.aiPredictionsByService[legacyService]) {
    session.aiPredictionsByService[legacyService] = session.aiPredictions;
  }

  for (const service of [ID_SERVICE_ARTSORAKEL, ID_SERVICE_INATURALIST]) {
    const predictions = _normalizePredictionList(session.aiPredictionsByService[service])
    session.aiPredictionsByService[service] = predictions
    session.aiServiceState[service] = _normalizeLegacyServiceState(session.aiServiceState[service], predictions)
    if (!session.aiServiceState[service].status || session.aiServiceState[service].status === 'idle') {
      session.aiServiceState[service].status = predictions.length ? 'success' : 'idle'
    }
    if (predictions.length && !session.aiServiceState[service].topScore && Number.isFinite(Number(predictions[0]?.probability))) {
      session.aiServiceState[service].topScore = Number(predictions[0].probability)
      session.aiServiceState[service].topProbability = Number(predictions[0].probability)
    }
  }

  session.aiActiveService = normalizeIdentifyService(session.aiActiveService || session.aiService || getDefaultIdService());
  session.aiService = session.aiActiveService;
  return session;
}

function _sessionAiInputs(session) {
  return (session?.files || []).map((blob, index) => ({
    id: `session-${session.id}-${index}`,
    blob: _isBlob(session.aiFiles?.[index]) ? session.aiFiles[index] : blob,
    cropRect: session.imageMeta?.[index]?.aiCropRect || null,
    cropSourceW: session.imageMeta?.[index]?.aiCropSourceW ?? null,
    cropSourceH: session.imageMeta?.[index]?.aiCropSourceH ?? null,
    source: _isBlob(session.aiFiles?.[index]) ? 'session.aiFiles' : 'session.files',
    sourceType: _isBlob(session.aiFiles?.[index]) ? 'session.aiFiles' : 'session.files',
  })).filter(item => _isBlob(item.blob));
}

function _sessionAiFingerprint(session) {
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return null
  return buildIdentifyFingerprint({
    service: ID_SERVICE_ARTSORAKEL,
    language: getTaxonomyLanguage(),
    images: _sessionAiInputs(session),
  })
}

async function _syncSessionAiAvailability(session) {
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return
  const fingerprint = _sessionAiFingerprint(normalized)
  if (!fingerprint) return
  const availabilityList = await getAvailableIdentifyServices({
    blobs: _sessionAiInputs(normalized).map(item => item.blob),
  })
  const availabilityFingerprint = JSON.stringify({
    fingerprint: fingerprint.requestFingerprint,
    availability: availabilityList.map(item => ({
      service: item.service,
      available: !!item.available,
      reason: item.reason || '',
    })),
  })
  if (normalized.aiAvailabilityFingerprint === availabilityFingerprint) return
  normalized.aiAvailability = Object.fromEntries(availabilityList.map(item => [item.service, item]))
  normalized.aiAvailabilityFingerprint = availabilityFingerprint
  if (normalized.aiCurrentFingerprint === fingerprint.requestFingerprint) {
    renderSessions()
  }
}

async function _syncImportAiDefaultAvailability() {
  const defaultService = getDefaultIdService()
  let available = true
  let reason = ''
  let label = defaultService === ID_SERVICE_INATURALIST
    ? (t('settings.idServiceInaturalist') || 'iNaturalist')
    : (t('settings.idServiceArtsorakel') || 'Artsorakel')

  if (defaultService === ID_SERVICE_INATURALIST) {
    const session = await loadInaturalistSession()
    available = Boolean(session?.connected && (session?.api_token || session?.apiToken))
    reason = available ? '' : (t('settings.inaturalistLoginMissing') || 'Please log in to iNaturalist first.')
  } else {
    const hasTargets = _getBatchAiTargets().length > 0
    available = hasTargets
    reason = hasTargets ? '' : (t('review.noPhotosToIdentify') || t('review.noCaptures') || 'No images available.')
  }

  const changed = importAiBatchState.defaultServiceAvailable !== available
    || importAiBatchState.defaultServiceReason !== reason
    || importAiBatchState.defaultServiceLabel !== label
  importAiBatchState.defaultServiceAvailable = available
  importAiBatchState.defaultServiceReason = reason
  importAiBatchState.defaultServiceLabel = label
  if (changed) _updateImportFooterUi()
}

function _sessionAiResultState(session, service) {
  const normalized = _ensureSessionAiState(session)
  const svc = normalizeIdentifyService(service)
  const predictions = normalized?.aiPredictionsByService?.[svc] || []
  const serviceState = normalized?.aiServiceState?.[svc] || _emptyServiceState()
  const availability = normalized?.aiAvailability?.[svc] || null
  const fingerprint = _sessionAiFingerprint(normalized)
  const stale = Boolean(
    fingerprint?.imageFingerprint
    && fingerprint?.cropFingerprint
    && (
      serviceState?.imageFingerprint !== fingerprint.imageFingerprint
      || serviceState?.cropFingerprint !== fingerprint.cropFingerprint
    )
    && (serviceState.status !== 'idle' || predictions.length)
  )
  const status = stale
    ? 'stale'
    : (serviceState.status || (predictions.length ? 'success' : 'idle'))
  const topProbability = Number.isFinite(Number(serviceState.topScore))
    ? Number(serviceState.topScore)
    : (predictions[0]?.probability ?? null)
  return {
    service: svc,
    active: normalized?.aiActiveService === svc,
    available: availability?.available ?? false,
    reason: availability?.reason || '',
    status: normalized?.aiRunning ? 'running' : status,
    topPrediction: predictions[0] || null,
    topProbability,
    errorMessage: serviceState.errorMessage || '',
    stale,
  }
}

function _renderSessionAiResults(session) {
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return ''
  const activeService = normalizeIdentifyService(normalized.aiActiveService)
  const predictions = normalized.aiPredictionsByService?.[activeService] || []
  const serviceState = normalized.aiServiceState?.[activeService] || _emptyServiceState()
  if (predictions.length) {
    return renderIdentifyResultRows(activeService, predictions)
  }
  if (serviceState.status === 'unavailable') {
    return `<div class="ai-results-empty">${normalized.aiAvailability?.[activeService]?.reason || serviceState.errorMessage || (t('settings.inaturalistLoginMissing') || 'Unavailable')}</div>`
  }
  if (serviceState.status === 'error') {
    return `<div class="ai-results-empty">${serviceState.errorMessage || (t('common.errorPrefix', { message: t('common.unknown') }) || 'Error')}</div>`
  }
  if (normalized.aiRunning) {
    return `<div class="ai-results-empty">${t('import.identifying') || t('common.loading')}</div>`
  }
  if (serviceState.status === 'stale' || normalized.aiStale) {
    return `<div class="ai-results-empty">${t('review.resultsOutdated') || 'Results outdated'}</div>`
  }
  if (serviceState.status === 'no_match') {
    return `<div class="ai-results-empty">${getIdentifyNoMatchMessage(activeService)}</div>`
  }
  return `<div class="ai-results-empty">${t('review.noMatch') || 'No match'}</div>`
}

function _renderSessionAiControls(session) {
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return ''
  const fingerprint = _sessionAiFingerprint(normalized)
  if (fingerprint) {
    normalized.aiCurrentFingerprint = fingerprint.requestFingerprint
    normalized.aiStale = Boolean(
      normalized.aiRequestedFingerprint
      && normalized.aiRequestedFingerprint !== fingerprint.requestFingerprint
      && Object.values(normalized.aiServiceState || {}).some(item => item?.status && item.status !== 'idle')
    )
  }
  void _syncSessionAiAvailability(normalized)
  const activeService = normalizeIdentifyService(normalized.aiActiveService)
  const activeResult = normalized.aiServiceState?.[activeService] || _emptyServiceState()
  const activePredictions = normalized.aiPredictionsByService?.[activeService] || []
  const confidence = getIdentifyConfidenceState(activeResult.topProbability ?? activeResult.topScore ?? 0, { checkThreshold: 0.65 })
  const runState = normalized.aiRunning
    ? 'running'
    : (activeResult.status || (activePredictions.length ? 'success' : 'idle'))
  const anyAvailable = Object.values(normalized.aiAvailability || {}).some(item => item?.available)
  const runLabel = t('review.aiId') || 'AI Photo ID'
  const staleNote = normalized.aiStale ? `<div class="detail-ai-stale-note">${t('review.resultsOutdated') || 'Results outdated - run AI Photo ID again.'}</div>` : ''
  return `
    <div class="detail-ai-stack" data-identify-comparison-state data-sid="${escHtml(normalized.id)}">
      <div class="detail-ai-controls">
        <button class="ai-id-btn ai-id-run-btn" type="button" data-identify-run-button data-sid="${escHtml(normalized.id)}" ${normalized.aiRunning || !anyAvailable ? 'disabled' : ''}>
          <span class="ai-id-dot ${runState === 'running' ? 'is-running' : runState === 'success' || runState === 'stale' ? (confidence.icon === 'check' ? 'is-complete' : confidence.tone) : runState === 'no_match' ? 'is-complete' : runState === 'unavailable' ? 'is-unavailable' : runState === 'error' ? 'is-error' : ''}"></span>
          <span>${escHtml(runLabel)}</span>
        </button>
        <div class="detail-ai-service-tabs" role="tablist" aria-label="AI services">
          ${renderIdentifyServiceTab(_sessionAiResultState(normalized, ID_SERVICE_ARTSORAKEL))}
          ${renderIdentifyServiceTab(_sessionAiResultState(normalized, ID_SERVICE_INATURALIST))}
        </div>
      </div>
      <div class="detail-ai-results-shell">
        ${staleNote}
        <div class="detail-ai-results ai-results-import" data-sid="${escHtml(normalized.id)}" data-identify-results data-identify-service="${activeService}">
          ${_renderSessionAiResults(normalized)}
        </div>
      </div>
    </div>
  `;
}

function _sessionServiceNeedsRerun(session, service) {
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return false
  const svc = normalizeIdentifyService(service)
  const state = normalized.aiServiceState?.[svc] || _emptyServiceState()
  const predictions = normalized.aiPredictionsByService?.[svc] || []
  const fingerprint = _sessionAiFingerprint(normalized)
  const stale = Boolean(
    fingerprint?.imageFingerprint
    && fingerprint?.cropFingerprint
    && (
      state.imageFingerprint !== fingerprint.imageFingerprint
      || state.cropFingerprint !== fingerprint.cropFingerprint
    )
    && (state.status !== 'idle' || predictions.length),
  )
  return stale || state.status === 'idle'
}

async function _runSessionAiService(sid, service, options = {}) {
  const session = sessionById(sid)
  if (!session?.files?.length || (importAiBatchState.running && !options.allowDuringBatch)) return
  const normalized = _ensureSessionAiState(session)
  if (!normalized) return
  const svc = normalizeIdentifyService(service)
  const fingerprint = _sessionAiFingerprint(normalized)
  if (!fingerprint) return

  const availabilityList = await getAvailableIdentifyServices({
    blobs: _sessionAiInputs(normalized).map(item => item.blob),
  })
  const availability = Object.fromEntries(availabilityList.map(item => [item.service, item]))
  normalized.aiAvailability = availability
  normalized.aiAvailabilityFingerprint = fingerprint.requestFingerprint

  const serviceAvailability = availability[svc]
  if (!serviceAvailability?.available) {
    _storeSessionAiServiceResult(session, svc, {
      status: 'unavailable',
      errorMessage: serviceAvailability?.reason || '',
      predictions: [],
    }, fingerprint)
    normalized.aiRunning = false
    _persistSessions()
    renderSessions()
    return
  }

  normalized.aiRunning = true
  normalized.aiActiveService = svc
  normalized.aiService = svc
  normalized.aiCurrentFingerprint = fingerprint.requestFingerprint
  normalized.aiRequestedFingerprint = fingerprint.requestFingerprint
  normalized.aiServiceState[svc] = {
    ..._emptyServiceState(),
    ...(normalized.aiServiceState?.[svc] || {}),
    status: 'running',
    requestFingerprint: fingerprint.requestFingerprint,
  }
  _persistSessions()
  renderSessions()

  try {
    const predictions = await runIdentifyForBlobs(
      _sessionAiInputs(normalized).map(item => ({
        blob: item.blob,
        cropRect: item.cropRect,
      })),
      svc,
      getTaxonomyLanguage(),
      {
        screen: 'import-review',
        availability,
        onImageSent: options.onImageSent,
        onIdReceived: options.onIdReceived,
      },
    )

    _storeSessionAiServiceResult(session, svc, {
      status: Array.isArray(predictions) && predictions.length ? 'success' : 'no_match',
      predictions: Array.isArray(predictions) ? predictions : [],
    }, fingerprint)
  } catch (err) {
    _storeSessionAiServiceResult(session, svc, {
      status: 'error',
      errorMessage: String(err?.message || err || 'Unknown error'),
      predictions: [],
    }, fingerprint)
    console.error('Session identification AI error:', err)
  } finally {
    normalized.aiRunning = false
    normalized.aiService = normalized.aiActiveService
    normalized.aiPredictions = normalized.aiPredictionsByService?.[svc] || []
    _persistSessions()
    renderSessions()
  }
}

async function _runSessionAiComparison(sid) {
  const session = sessionById(sid)
  if (!session?.files?.length || importAiBatchState.running) return
  const service = getDefaultIdService()
  const serviceLabel = service === ID_SERVICE_INATURALIST
    ? (t('settings.idServiceInaturalist') || 'iNaturalist')
    : (t('settings.idServiceArtsorakel') || 'Artsorakel')
  importAiBatchState.defaultServiceLabel = serviceLabel
  const sessionAi = _ensureSessionAiState(session)
  if (!sessionAi) return
  await _runSessionAiService(sid, service)

  const serviceState = sessionAi.aiServiceState?.[service] || _emptyServiceState()
  if (serviceState.status === 'no_match') {
    showToast(getIdentifyNoMatchMessage(service))
  } else if (serviceState.status === 'error') {
    showToast(getIdentifyUnavailableMessage(service))
  } else if (serviceState.status === 'unavailable') {
    showToast(serviceState.errorMessage || getIdentifyUnavailableMessage(service))
  }
}

function _updateImportFooterUi() {
  const backBtn = document.getElementById('import-back');
  const cancelBtn = document.getElementById('import-cancel-btn');
  const aiBtn = document.getElementById('import-ai-all-btn');
  const saveBtn = document.getElementById('import-save-btn');
  const progress = document.getElementById('import-ai-progress');
  const progressFill = document.getElementById('import-ai-progress-fill');
  const progressText = document.getElementById('import-ai-progress-text');
  const hasTargets = _getBatchAiTargets().length > 0;
  const running = importAiBatchState.running;
  const total = importAiBatchState.totalUnits;
  const done = importAiBatchState.completedUnits;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (backBtn) backBtn.disabled = running;
  if (cancelBtn) cancelBtn.disabled = running;
  if (saveBtn) saveBtn.disabled = running;
  if (aiBtn) {
    aiBtn.textContent = t('import.aiIdAll') || 'ID All';
    const unavailable = importAiBatchState.defaultServiceAvailable === false;
    aiBtn.disabled = running || !hasTargets || unavailable;
    aiBtn.title = unavailable ? importAiBatchState.defaultServiceReason || '' : '';
  }
  if (progress) progress.style.display = running && total > 0 ? 'flex' : 'none';
  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressText) progressText.textContent = total > 0 ? `${done}/${total}` : '';

  document
    .querySelectorAll('#import-session-list .import-card-delete, #import-session-list .import-strip-delete, #import-session-list .import-vis-radio, #import-session-list .import-taxon-input')
    .forEach(el => {
      el.disabled = running;
    });

  const footerText = document.querySelector('#screen-import-review .sync-footer-text');
  if (footerText) {
    if (running && importAiBatchState.defaultServiceLabel) {
      footerText.textContent = t('import.photoIdBy', { service: importAiBatchState.defaultServiceLabel })
    } else if (importAiBatchState.defaultServiceAvailable === false && importAiBatchState.defaultServiceReason) {
      footerText.textContent = importAiBatchState.defaultServiceReason
    } else {
      footerText.textContent = t('review.createsMany')
    }
  }
}

async function _runAiIdAll() {
  if (importAiBatchState.running) return;
  const targets = _getBatchAiTargets();
  const totalUnits = _getBatchAiTotalUnits(targets);
  if (!targets.length || totalUnits <= 0) return;
  const service = getDefaultIdService();
  importAiBatchState.defaultServiceLabel = service === ID_SERVICE_INATURALIST
    ? (t('settings.idServiceInaturalist') || 'iNaturalist')
    : (t('settings.idServiceArtsorakel') || 'Artsorakel')
  if (service === ID_SERVICE_INATURALIST) {
    const session = await loadInaturalistSession();
    const inatAvailable = Boolean(session?.connected && (session?.api_token || session?.apiToken));
    if (!inatAvailable) {
      showToast(getIdentifyUnavailableMessage(service));
      importAiBatchState.defaultServiceAvailable = false;
      importAiBatchState.defaultServiceReason = getIdentifyUnavailableMessage(service);
      _updateImportFooterUi();
      return;
    }
  }

  importAiBatchState.running = true;
  importAiBatchState.completedUnits = 0;
  importAiBatchState.totalUnits = totalUnits;
  _updateImportFooterUi();

  let successCount = 0;
  let noMatchCount = 0;
  let failureCount = 0;

  try {
    for (const session of targets) {
      try {
        const normalized = _ensureSessionAiState(session);
        normalized.aiServiceState[service] = {
          ..._emptyServiceState(),
          ...(normalized.aiServiceState?.[service] || {}),
          status: 'running',
        };
        _persistSessions();
        renderSessions();
        await _runSessionAiService(session.id, service, {
          onImageSent: () => _incrementBatchAiProgress(),
          onIdReceived: () => _incrementBatchAiProgress(),
          allowDuringBatch: true,
        });
        const sessionState = _ensureSessionAiState(session);
        const predictions = sessionState.aiPredictionsByService?.[service] || [];
        if (_applySessionAiTopPrediction(session, predictions)) {
          _persistSessions();
          renderSessions();
        }
        const serviceState = _ensureSessionAiState(session).aiServiceState?.[service] || _emptyServiceState();
        if (serviceState.status === 'success') successCount++;
        else if (serviceState.status === 'no_match') noMatchCount++;
        else failureCount++;
        _persistSessions();
        renderSessions();
      } catch (err) {
        failureCount++;
        console.error('Batch identification AI error:', err);
      }
    }
  } finally {
    _resetImportAiBatchState();
    _updateImportFooterUi();
  }

  if (failureCount && successCount === 0 && noMatchCount === 0) {
    showToast(getIdentifyUnavailableMessage(service));
  } else if (!successCount && noMatchCount > 0) {
    showToast(getIdentifyNoMatchMessage(service));
  } else if (failureCount > 0) {
    showToast(getIdentifyUnavailableMessage(service));
  }
}

function _syncPhotoGapDisplays(value = getPhotoGapMinutes()) {
  const isSeconds = value < 1;
  const displayValue = String(isSeconds ? Math.round(value * 60) : Math.round(value));
  const unitText = isSeconds ? 'sec' : 'min';

  const importGapInput = document.getElementById('import-gap-input');
  if (importGapInput) {
    importGapInput.value = value;
    importGapInput.textContent = displayValue;
  }
  const importGapUnit = document.getElementById('import-gap-unit');
  if (importGapUnit) importGapUnit.textContent = unitText;

  const settingsGapInput = document.getElementById('settings-gap-input');
  if (settingsGapInput) {
    settingsGapInput.value = value;
    settingsGapInput.textContent = displayValue;
  }
  const settingsGapUnit = document.getElementById('settings-gap-unit');
  if (settingsGapUnit) settingsGapUnit.textContent = unitText;

  return value;
}

function _disposeSessionBlobUrls(items = sessions) {
  (items || []).forEach(session => {
    (session?.blobUrls || []).forEach(url => URL.revokeObjectURL(url));
  });
}

function _groupSourceItems(items, gapMs) {
  if (!items.length) return [];
  const grouped = [[items[0]]];
  for (let i = 1; i < items.length; i++) {
    const prev = grouped[grouped.length - 1];
    const gap = items[i].captureTime - prev[prev.length - 1].captureTime;
    if (gap <= gapMs) prev.push(items[i]);
    else grouped.push([items[i]]);
  }
  return grouped;
}

function _groupKey(items) {
  return (items || []).map(item => item.id).join('|');
}

function _buildSessionsFromSourceItems() {
  const previousByKey = new Map(
    sessions.map(session => [_groupKey((session.sourceItemIds || []).map(id => ({ id }))), session])
  );
  const gapMs = getPhotoGapMinutes() * 60_000;
  const grouped = _groupSourceItems(sourceItems, gapMs);

  _disposeSessionBlobUrls(sessions);

  sessions = grouped.map((group, idx) => {
    const key = _groupKey(group);
    const previous = previousByKey.get(key);
    const exifGps = group.find(item => _isUsableCoordinate(item.lat, item.lon));
    return {
      id: previous?.id || `s${idx}`,
      sourceItemIds: group.map(item => item.id),
      files: group.map(item => item.blob),
      aiFiles: group.map(item => _isBlob(item.aiBlob) ? item.aiBlob : item.blob),
      blobUrls: group.map(item => URL.createObjectURL(item.blob || item.aiBlob)),
      imageMeta: group.map(item => item.meta),
      metadataPromises: group.map(item => item.metadataPromise || null),
      photoTimes: group.map(item => item.captureTime),
      photoGps: group.map(item => ({ lat: item.lat, lon: item.lon, altitude: item.altitude ?? null, accuracy: item.accuracy ?? null })),
      photoDebug: group.map(item => item.dbg || null),
      ts: new Date(group[0].captureTime),
      gpsLat: exifGps?.lat ?? null,
      gpsLon: exifGps?.lon ?? null,
      gpsAltitude: exifGps?.altitude ?? null,
      gpsAccuracy: exifGps?.accuracy ?? null,
      locationName: previous?.locationName || '',
      locationSuggestions: Array.isArray(previous?.locationSuggestions) ? [...previous.locationSuggestions] : [],
      locationLookup: previous?.locationLookup || null,
      locationLookupKey: previous?.locationLookupKey || '',
      locationAutoApplied: previous?.locationAutoApplied || '',
      taxon: previous?.taxon || null,
      visibility: normalizeCaptureVisibility(previous?.visibility, getDefaultVisibility()),
      is_draft: previous?.is_draft !== false,
      location_precision: previous?.location_precision || 'exact',
      uncertain: previous?.uncertain || false,
      exifDebug: group.map(item => item.dbg).filter(Boolean),
    };
  });
}

function _flattenSourceItemsFromSessions(savedSessions) {
  let fallbackCounter = 0;
  return (savedSessions || []).flatMap(session =>
    (session.files || []).map((blob, index) => ({
      id: session.sourceItemIds?.[index] || `restored-${fallbackCounter++}`,
      blob,
      aiBlob: _isBlob(session.aiFiles?.[index]) ? session.aiFiles[index] : blob,
      meta: session.imageMeta?.[index] || {
        aiCropRect: null,
        aiCropSourceW: null,
        aiCropSourceH: null,
      },
      metadataPromise: session.metadataPromises?.[index] || null,
      captureTime: session.photoTimes?.[index] || session.ts?.getTime?.() || Date.now(),
      lat: session.photoGps?.[index]?.lat ?? null,
      lon: session.photoGps?.[index]?.lon ?? null,
      altitude: session.photoGps?.[index]?.altitude ?? null,
      accuracy: session.photoGps?.[index]?.accuracy ?? null,
      dbg: session.photoDebug?.[index] || null,
    }))
  );
}

function _ensureSessionImageMeta(session) {
  if (!session) return [];
  if (!Array.isArray(session.imageMeta)) session.imageMeta = [];
  while (session.imageMeta.length < session.files.length) {
    session.imageMeta.push({
      aiCropRect: null,
      aiCropSourceW: null,
      aiCropSourceH: null,
    });
  }
  return session.imageMeta;
}

function _applyMetadataToSession(session, index, metadata) {
  if (!session || !metadata) return false;
  const lat = Number(metadata.lat);
  const lon = Number(metadata.lon);
  const hasGps = _isUsableCoordinate(lat, lon);
  const altitude = Number(metadata.altitude);
  const accuracy = Number(metadata.accuracy);
  const time = Number(metadata.time);
  let changed = false;

  if (Number.isFinite(time) && session.photoTimes?.[index] !== time) {
    session.photoTimes[index] = time;
    if (index === 0) session.ts = new Date(time);
    changed = true;
  }

  if (hasGps) {
    if (!Array.isArray(session.photoGps)) session.photoGps = [];
    session.photoGps[index] = {
      ...(session.photoGps[index] || {}),
      lat,
      lon,
      altitude: Number.isFinite(altitude) ? altitude : (session.photoGps[index]?.altitude ?? null),
      accuracy: Number.isFinite(accuracy) ? accuracy : (session.photoGps[index]?.accuracy ?? null),
    };
    if (session.gpsLat === null || session.gpsLon === null) {
      session.gpsLat = lat;
      session.gpsLon = lon;
      session.gpsAltitude = Number.isFinite(altitude) ? altitude : null;
      session.gpsAccuracy = Number.isFinite(accuracy) ? accuracy : null;
      changed = true;
    }
    if (session.gpsAltitude == null && Number.isFinite(altitude)) {
      session.gpsAltitude = altitude;
      changed = true;
    }
    if (session.gpsAccuracy == null && Number.isFinite(accuracy)) {
      session.gpsAccuracy = accuracy;
      changed = true;
    }
  }

  return changed;
}

function _attachSessionMetadataHydration() {
  sessions.forEach(session => {
    if (session.metadataPromise || !Array.isArray(session.metadataPromises)) return;
    const pending = session.metadataPromises
      .map((promise, index) => promise ? { promise, index } : null)
      .filter(Boolean);
    if (!pending.length) return;

    session.metadataPromise = Promise.allSettled(pending.map(item => item.promise)).then(results => {
      let changed = false;
      results.forEach((result, resultIndex) => {
        if (result.status !== 'fulfilled') return;
        const index = pending[resultIndex].index;
        changed = _applyMetadataToSession(session, index, result.value) || changed;
      });
      if (changed) {
        _persistSessions();
        if (state.currentScreen === 'import-review') {
          renderSessions();
          _prefillSessionLocations();
        }
      }
      return session;
    });
  });
}

function sessionById(sid) {
  return sessions.find(s => s.id === sid);
}

export function initImportReview() {
  document.getElementById('import-back').addEventListener('click', _cancelImport);
  document.getElementById('import-cancel-btn').addEventListener('click', _cancelImport);
  document.getElementById('import-ai-all-btn').addEventListener('click', _runAiIdAll);
  document.getElementById('import-save-btn').addEventListener('click', saveAll);
  document.getElementById('import-photo-input').addEventListener('change', handleFileSelect);
  document.getElementById('import-browse-input').addEventListener('change', handleFileSelect);
  _updateImportFooterUi();
  void _syncImportAiDefaultAvailability();
  document.getElementById('import-gap-decrement')?.addEventListener('click', () => {
    const current = getPhotoGapMinutes();
    _applyImportPhotoGapChange(current <= 1 ? current - (5 / 60) : current - 1);
  });
  document.getElementById('import-gap-increment')?.addEventListener('click', () => {
    const current = getPhotoGapMinutes();
    let next = current < 1 ? current + (5 / 60) : current + 1;
    if (Math.abs(next - 1) < 0.001) next = 1;
    _applyImportPhotoGapChange(next);
  });
  _syncPhotoGapDisplays();
}

function _applyImportPhotoGapChange(value) {
  const normalized = setPhotoGapMinutes(value);
  _syncPhotoGapDisplays(normalized);
  if (!sourceItems.length) return;

  expandedSessionIds = new Set();
  _buildSessionsFromSourceItems();
  if (sessions.length === 1) {
    const session = sessions[0];
    session.blobUrls.forEach(url => URL.revokeObjectURL(url));
    sessions = [];
    expandedSessionIds = new Set();
    sourceItems = [];
    clearImportSessions();
    openImportedReview(session);
    return;
  }
  if (!sessions.length) {
    clearImportSessions();
    navigate('home');
    return;
  }
  _persistSessions();
  renderSessions();
  _prefillSessionLocations();
}

function _cancelImport() {
  if (importAiBatchState.running) return;
  _disposeSessionBlobUrls();
  clearImportSessions();
  sessions = [];
  expandedSessionIds = new Set();
  sourceItems = [];
  _resetImportAiBatchState();
  navigate('home');
}

// Restore a previously-saved import session (app was killed mid-review)
export function restoreImportSessions(savedSessions) {
  sessions = savedSessions;
  sourceItems = _flattenSourceItemsFromSessions(savedSessions);
  expandedSessionIds = new Set(savedSessions.map(session => session.id));
  _resetImportAiBatchState();
  navigate('import-review');
  renderSessions();
}

export async function openPhotoImportPicker() {
  if (isAndroidNativeApp()) {
    try {
      const result = await pickImagesWithNativePhotoPicker();
      await _handleNativePhotoResult(result);
      return;
    } catch (err) {
      if (isPickerCancel(err)) return;
      console.warn('Native photo picker failed, falling back to browser input:', err);
      _hideProgress();
    }
  }

  // Android Chrome strips EXIF from "image/*" input. Use the browse input for Android web.
  if (/android/i.test(navigator.userAgent)) {
    if (localStorage.getItem('sporely-hide-exif-warning') !== '1') {
      const overlay = document.getElementById('exif-warning-overlay');
      const dontShow = document.getElementById('exif-warning-dont-show');
      if (overlay && dontShow) {
        dontShow.checked = false;
        overlay.style.display = 'flex';
        return;
      }
    }
    _openBrowserFileInput('import-browse-input');
  } else {
    _openBrowserFileInput('import-photo-input');
  }
}

export async function openNativeCamera() {
  if (!isAndroidNativeApp()) {
    showToast('Sporely Cam is available in the Android app.')
    return
  }

  try {
    if (getUseSystemCamera()) {
      const result = await NativeCamera.openSystemCamera();
      await _handleNativePhotoResult(result);
      return;
    }

    const { value: useHdrStr } = await Preferences.get({ key: 'useHdr' });
    const useHdr = useHdrStr !== 'false';

    const gps = state.gps && Number.isFinite(state.gps.lat) && Number.isFinite(state.gps.lon)
      ? {
          latitude: state.gps.lat,
          longitude: state.gps.lon,
          altitude: Number.isFinite(state.gps.altitude) ? state.gps.altitude : null,
          accuracy: Number.isFinite(state.gps.accuracy) ? state.gps.accuracy : null,
        }
      : null

    const options = { useHdr, jpegQuality: NATIVE_CAMERA_JPEG_QUALITY };
    if (gps) options.gps = gps;
    await _handleNativePhotoResult(await NativeCamera.capturePhotos(options))
  } catch (err) {
    if (isPickerCancel(err)) return
    console.warn('Sporely camera failed:', err)
    showToast(`Sporely Cam: ${err?.message || err}`)
    _hideProgress()
  }
}

async function _handleNativePhotoResult(result) {
  const photos = Array.isArray(result?.photos) ? result.photos
    : Array.isArray(result?.files) ? result.files
      : [];
  if (!photos.length) return;

  _setProgress(0, photos.length, t('import.readingFiles'));

  const files = [];
  for (let i = 0; i < photos.length; i++) {
    _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }));
    files.push(await nativePickedPhotoToFile(photos[i], i));
  }
  await _handleSelectedFilesWithFeedback(files, { nativePhotos: photos });
}

export async function openFileImportPicker() {
  if (isAndroidNativeApp()) {
    try {
      await _handleNativePhotoResult(await pickImagesWithNativePhotoPicker());
      return;
    } catch (err) {
      if (isPickerCancel(err)) return;
      console.warn('Native photo picker failed, falling back to browser input:', err);
      _hideProgress();
    }
  }

  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [{
          description: 'Photos',
          accept: {
            'image/jpeg': ['.jpg', '.jpeg'],
            'image/png': ['.png'],
            'image/webp': ['.webp'],
            'image/avif': ['.avif'],
            'image/heic': ['.heic'],
            'image/heif': ['.heif'],
          },
        }],
      });
      const files = await Promise.all(handles.map(handle => handle.getFile()));
      await _handleSelectedFilesWithFeedback(files);
      return;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('showOpenFilePicker failed, falling back to input:', err);
      } else {
        return;
      }
    }
  }

  _openBrowserFileInput('import-browse-input');
}

export async function handleFileSelect(event) {
  const files = Array.from(event.target.files || []);
  if (event.target) event.target.value = '';
  await _handleSelectedFilesWithFeedback(files);
}

async function handleSelectedFiles(files, options = {}) {
  if (!files.length) return;
  const nativePhotos = Array.isArray(options.nativePhotos) ? options.nativePhotos : [];

  _setProgress(0, files.length, t('import.readingTimestamps'));

  // Read EXIF capture time + GPS for each file.
  // Android/iOS often set file.lastModified to sync date, not shutter time.
  const withTimes = await Promise.all(files.map(async (f, idx) => {
    const nativePhoto = nativePhotos[idx];
    if (nativePhoto) {
      const { time, lat, lon, altitude, accuracy, dbg } = await captureNativePhotoExif(nativePhoto, f);
      return {
        file: f,
        nativePhoto,
        metadataPromise: createNativeMetadataHydrationPromise(nativePhoto, f),
        captureTime: time,
        lat,
        lon,
        altitude,
        accuracy,
        dbg,
      };
    }
    const { time, lat, lon, altitude, accuracy, dbg } = await captureExif(f);
    return { file: f, captureTime: time, lat, lon, altitude, accuracy, dbg };
  }));

  // Sort by actual capture time
  withTimes.sort((a, b) => a.captureTime - b.captureTime);

  // Convert to JPEG sequentially — avoids exhausting mobile memory with parallel decodes.
  _disposeSessionBlobUrls();
  sessions = [];
  expandedSessionIds = new Set();
  sourceItems = [];
  let doneCount = 0;
  for (let idx = 0; idx < withTimes.length; idx++) {
    const item = withTimes[idx];
    _setProgress(doneCount, files.length, t('import.convertingFile', { current: doneCount + 1, total: files.length }));
    const processed = await processFile(item.file, { nativePhoto: item.nativePhoto });
    sourceItems.push({
      id: `i${idx}`,
      blob: processed.blob,
      aiBlob: processed.aiBlob || processed.blob,
      meta: processed.meta,
      metadataPromise: item.metadataPromise || null,
      captureTime: item.captureTime,
      lat: item.lat ?? null,
      lon: item.lon ?? null,
      altitude: item.altitude ?? null,
      accuracy: item.accuracy ?? null,
      dbg: item.dbg || null,
    });
    doneCount++;
  }

  _buildSessionsFromSourceItems();
  _attachSessionMetadataHydration();

  _hideProgress();

  // Single group → open the same Review screen as camera capture.
  if (sessions.length === 1) {
    const session = sessions[0];
    session.blobUrls.forEach(url => URL.revokeObjectURL(url));
    sessions = [];
    expandedSessionIds = new Set();
    sourceItems = [];
    openImportedReview(session);
    return;
  }

  // Persist to IndexedDB so state survives app suspension
  _persistSessions()

  navigate('import-review');
  renderSessions();
  _prefillSessionLocations();
}

// ── Progress overlay ─────────────────────────────────────────────────────────
function _setProgress(done, total, label) {
  const overlay = document.getElementById('import-progress');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  document.getElementById('import-progress-fill').style.width = pct + '%';
  document.getElementById('import-progress-label').textContent = label || t('import.processing');
}

function _hideProgress() {
  const overlay = document.getElementById('import-progress');
  if (overlay) overlay.style.display = 'none';
}

function _prefillSessionLocations() {
  sessions.forEach(async session => {
    const lat = Number(session.gpsLat);
    const lon = Number(session.gpsLon);
    const lookupKey = lookupCoordinateKey(lat, lon);
    if (!lookupKey) return;
    if (session.locationLookupKey === lookupKey && Array.isArray(session.locationSuggestions)) return;

    session.locationLookupKey = lookupKey;
    const previousAuto = session.locationAutoApplied || '';
    try {
      const result = await lookupReverseLocation(lat, lon, {
        onUpdate: updated => _applySessionLocationLookup(session.id, lookupKey, updated),
      });
      if (session.locationLookupKey !== lookupKey) return;
      _applySessionLocationLookup(session.id, lookupKey, result, previousAuto);
    } catch (_) {}
  });
}

function _applySessionLocationLookup(sessionId, lookupKey, result, previousAuto = null) {
  const session = sessionById(sessionId);
  if (!session || session.locationLookupKey !== lookupKey) return;

  const nextSuggestions = result?.suggestions || [];
  session.locationSuggestions = nextSuggestions;
  session.locationLookup = result || null;
  const first = nextSuggestions[0] || '';
  const autoValue = previousAuto ?? session.locationAutoApplied ?? '';
  if (first && (!session.locationName || session.locationName === autoValue)) {
    session.locationName = first;
    session.locationAutoApplied = first;
  }

  _syncLocationInput(session);
  _persistSessions();
}

function _syncLocationInput(session) {
  if (!session?.id) return;
  const input = document.querySelector(`.import-loc-input[data-sid="${session.id}"]`);
  const locEl = document.querySelector(`.import-card[data-sid="${session.id}"] .import-card-loc`);
  if (input) input.value = session.locationName || '';
  if (locEl) locEl.textContent = session.locationName || '—';
  _renderImportLocationDropdown(session.id, false);
}

function _openBrowserFileInput(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = '';
  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return;
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'InvalidStateError') {
        console.warn('showPicker() failed, falling back to click():', err);
      }
    }
  }
  input.click();
}

async function _handleSelectedFilesWithFeedback(files, options = {}) {
  try {
    await handleSelectedFiles(files, options);
  } catch (err) {
    console.error('Photo import failed:', err);
    _hideProgress();
    showToast(t('import.failed'));
  }
}

function _coerceExifDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes(':') && value.includes(' ')
      ? value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
      : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

async function _getExifr() {
  if (!exifrModulePromise) {
    exifrModulePromise = import('exifr/dist/full.esm.mjs').then(module => module.default);
  }
  return exifrModulePromise;
}

async function _nativePickedPhotoToFile(photo, index) {
  let mimeType = _normalizeNativeMimeType(photo?.mimeType, photo?.format);
  let path = photo.path;

  // Use the plugin's native convertHeicToJpeg (High Speed) if the format is HEIC
  if (mimeType === 'image/heic' || mimeType === 'image/heif' || photo?.format === 'heic' || photo?.format === 'heif') {
    try {
      if (window.Capacitor?.Plugins?.FilePicker?.convertHeicToJpeg) {
        const converted = await FilePicker.convertHeicToJpeg({ path });
        path = converted.path;
        mimeType = 'image/jpeg';
      }
    } catch (e) {
      console.warn('Native HEIC conversion failed:', e);
    }
  }

  // Fast native file read using Capacitor protocol (avoids blocking base64 encode)
  const url = Capacitor.convertFileSrc(_normalizeNativePathForFetch(path));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read native photo (${res.status})`);
  const blob = await res.blob();

  const fileName = _guessNativeFileName(photo, index, mimeType);
  return new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });
}

function _shouldHydrateNativeMetadata(photo, file) {
  if (!isAndroidApp()) return false;
  if (!photo?.originalPath) return false;
  if (photo.originalPath === photo.path && !_isHeicLike(file)) return false;
  const rawGps = _extractLatLonFromRawGps(photo.exif);
  return rawGps.lat === null || rawGps.lon === null;
}

function _createNativeMetadataHydrationPromise(photo, file) {
  if (!_shouldHydrateNativeMetadata(photo, file)) return null;
  return _captureNativeOriginalExif(photo).catch(error => ({
    time: file.lastModified || Date.now(),
    lat: null,
    lon: null,
    altitude: null,
    accuracy: null,
    dbg: {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      nativePath: photo?.path || null,
      originalPath: photo?.originalPath || null,
      backgroundExifError: String(error),
    },
  }));
}

async function _captureNativeOriginalExif(photo) {
  const path = photo?.originalPath || photo?.path;
  if (!path) throw new Error('Missing native original path');
  const mimeType = _normalizeNativeMimeType(photo?.originalMimeType || photo?.mimeType, photo?.originalFormat || photo?.format);
  const url = Capacitor.convertFileSrc(_normalizeNativePathForFetch(path));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read native original photo (${res.status})`);
  const blob = await res.blob();
  const fileName = _guessNativeFileName({
    name: photo?.name || '',
    mimeType,
    format: photo?.originalFormat || photo?.format,
  }, 0, mimeType);
  const originalFile = new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });
  return _captureExif(originalFile);
}

function _normalizeNativePathForFetch(path) {
  const value = String(path || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return value.startsWith('/') ? `file://${value}` : value;
}

function _normalizeNativeMimeType(mimeType, format) {
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  if (normalizedMime) return normalizedMime;
  const normalizedFormat = String(format || '').trim().toLowerCase();
  if (normalizedFormat === 'jpg') return 'image/jpeg';
  if (normalizedFormat) return `image/${normalizedFormat}`;
  return 'image/jpeg';
}

function _guessNativeFileName(photo, index, mimeType) {
  const fromName = String(photo?.name || '').trim();
  if (fromName) return fromName;
  const ext = mimeType === 'image/heic' ? '.heic'
    : mimeType === 'image/heif' ? '.heif'
    : mimeType === 'image/png' ? '.png'
    : '.jpg';
  return `native-import-${index + 1}${ext}`;
}

function _filesystemReadResultToBlob(data, mimeType) {
  if (data instanceof Blob) return data;
  if (typeof data !== 'string') throw new Error('Unexpected Filesystem.readFile result');
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function _coerceExifNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.numerator) && Number.isFinite(value.denominator) && value.denominator) {
      return value.numerator / value.denominator;
    }
    if (Number.isFinite(value.num) && Number.isFinite(value.den) && value.den) {
      return value.num / value.den;
    }
  }
  return null;
}

function _isUsableCoordinate(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001);
}

function _toDecimalDegrees(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const parts = value.map(_coerceExifNumber).filter(part => part !== null);
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] + (parts[1] / 60);
    return parts[0] + (parts[1] / 60) + (parts[2] / 3600);
  }
  return _coerceExifNumber(value);
}

function _withHemisphere(value, ref, negativeRef) {
  if (value === null) return null;
  const normalized = String(ref || '').trim().toUpperCase();
  if (normalized === negativeRef) return -Math.abs(value);
  return Math.abs(value);
}

function _extractLatLonFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return { lat: null, lon: null };

  let lat = rawGps.latitude;
  let lon = rawGps.longitude;

  if (lat == null) lat = _withHemisphere(_toDecimalDegrees(rawGps.GPSLatitude), rawGps.GPSLatitudeRef, 'S');
  if (lon == null) lon = _withHemisphere(_toDecimalDegrees(rawGps.GPSLongitude), rawGps.GPSLongitudeRef, 'W');

  lat = _coerceExifNumber(lat);
  lon = _coerceExifNumber(lon);
  if (!_isUsableCoordinate(lat, lon)) return { lat: null, lon: null };
  return { lat, lon };
}

function _extractAltitudeFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null;
  const candidates = [
    rawGps.altitude,
    rawGps.GPSAltitude,
    rawGps.GpsAltitude,
  ];
  let altitude = null;
  for (const candidate of candidates) {
    altitude = _coerceExifNumber(candidate);
    if (altitude !== null) break;
  }
  if (!Number.isFinite(altitude)) return null;
  const ref = _coerceExifNumber(rawGps.GPSAltitudeRef ?? rawGps.GpsAltitudeRef);
  return ref === 1 ? -Math.abs(altitude) : altitude;
}

function _extractAccuracyFromRawGps(rawGps) {
  if (!rawGps || typeof rawGps !== 'object') return null;
  const candidates = [
    rawGps.GPSHPositioningError,
    rawGps.accuracy
  ];
  let accuracy = null;
  for (const candidate of candidates) {
    accuracy = _coerceExifNumber(candidate);
    if (accuracy !== null && accuracy > 0) break;
  }
  if (!Number.isFinite(accuracy)) return null;
  return accuracy;
}

async function _captureNativePhotoExif(photo, file) {
  let time = file.lastModified || Date.now();
  let lat = null;
  let lon = null;
  let altitude = null;
  let accuracy = null;
  const dbg = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    nativePath: photo?.path || null,
    nativeMimeType: photo?.mimeType || null,
  };

  if (photo?.exif && typeof photo.exif === 'object') {
    dbg.nativeExif = JSON.stringify(photo.exif);
    const rawNativeGps = _extractLatLonFromRawGps(photo.exif);
    if (rawNativeGps.lat !== null) lat = rawNativeGps.lat;
    if (rawNativeGps.lon !== null) lon = rawNativeGps.lon;
    altitude = _extractAltitudeFromRawGps(photo.exif);
    accuracy = _extractAccuracyFromRawGps(photo.exif);

    const dt = _coerceExifDate(photo.exif.DateTimeOriginal || photo.exif.CreateDate || photo.exif.ModifyDate || photo.capturedAt);
    if (dt) time = dt.getTime();

    // Custom Android NativePhotoPicker already did the expensive metadata read
    // before optional HEIC conversion. Trust that result and avoid a slow JS
    // exifr fallback over the converted cache JPEG, especially for single HEIC imports.
    return { time, lat, lon, altitude, accuracy, dbg };
  }

  try {
    // FAST PATH: Extract EXIF natively without loading the file into JS memory
    const exif = window.Capacitor?.Plugins?.FilePicker?.getExif ? await FilePicker.getExif({ path: photo.path }) : null;
    if (exif) {
      dbg.nativeExif = JSON.stringify(exif);
      const rawNativeGps = _extractLatLonFromRawGps(exif);
      if (rawNativeGps.lat !== null) lat = rawNativeGps.lat;
      if (rawNativeGps.lon !== null) lon = rawNativeGps.lon;
      altitude = _extractAltitudeFromRawGps(exif);
      accuracy = _extractAccuracyFromRawGps(exif);

      const dt = _coerceExifDate(exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || photo.capturedAt);
      if (dt) time = dt.getTime();

      // If native extraction found the coordinates, return immediately! (Lightning fast)
      if (lat !== null && lon !== null) {
        return { time, lat, lon, altitude, accuracy, dbg };
      }
    }
  } catch (err) {
    console.warn('Native EXIF extraction failed, trying JS fallback:', err);
  }

  // SLOW PATH: Only run the JS fallback if native EXIF failed or lacked GPS
  try {
    const jsExif = await _captureExif(file);
    if (jsExif.lat !== null) lat = jsExif.lat;
    if (jsExif.lon !== null) lon = jsExif.lon;
    if (jsExif.altitude !== null) altitude = jsExif.altitude;
    if (jsExif.accuracy !== null) accuracy = jsExif.accuracy;
    if (jsExif.time) time = jsExif.time;
    dbg.jsFallback = true;
  } catch (err) {
    console.warn('JS EXIF extraction fallback failed:', err);
  }

  return { time, lat, lon, altitude, accuracy, dbg };
}

async function _captureExif(file) {
  const exifr = await _getExifr();
  let time = file.lastModified;
  let lat  = null;
  let lon  = null;
  let altitude = null;
  let accuracy = null;
  let dbg  = { fileName: file.name, fileSize: file.size, fileType: file.type, bufSize: 0, gpsResult: null, gpsError: null, exifError: null };
  const fullRead = _isHeicLike(file) ? { chunked: false } : {};

  const setGps = (res) => {
    const nextLat = _coerceExifNumber(res?.latitude);
    const nextLon = _coerceExifNumber(res?.longitude);
    if (_isUsableCoordinate(nextLat, nextLon)) {
      lat = nextLat;
      lon = nextLon;
    }
    const nextAltitude = _extractAltitudeFromRawGps(res);
    if (nextAltitude !== null) altitude = nextAltitude;
    const nextAccuracy = _extractAccuracyFromRawGps(res);
    if (nextAccuracy !== null) accuracy = nextAccuracy;
  };

  // Read the full file into an ArrayBuffer before passing to exifr.
  // exifr uses chunked reads in the browser and can miss GPS data in HEIC files
  // if the GPS box falls outside the initial chunk window.
  // Optimization: Read only the first 2MB instead of the entire 10MB+ file
  let buf;
  try {
    buf = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
    dbg.bufSize = buf.byteLength;
  } catch (e) {
    dbg.bufError = String(e);
    console.warn('[EXIF] arrayBuffer() failed:', e);
    return { time, lat, lon, altitude, dbg };
  }

  // Try the original File first. exifr officially supports HEIC/HEIF blobs/files,
  // and this path lets it follow container pointers itself instead of depending on
  // our manual buffer strategy.
  try {
    const exif = await exifr.parse(file, { pick: EXIF_DATETIME_PICK, ...fullRead });
    const dt = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
    if (dt instanceof Date) time = dt.getTime();
    dbg.exifFile = exif ? JSON.stringify(exif) : 'null';
  } catch (e) {
    dbg.exifFileError = String(e);
    console.warn('[EXIF] parseExif(file) failed:', e);
  }

  try {
    const exif = await exifr.parse(buf, { pick: EXIF_DATETIME_PICK });
    const dt = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
    if (dt instanceof Date) time = dt.getTime();
  } catch (e) {
    dbg.exifError = String(e);
    console.warn('[EXIF] parseExif(buffer) failed:', e);
  }

  // Try parseGps() first; fall back to parse({gps:true}) for formats where gps() alone may fail
  try {
    const gpsResult = await exifr.gps(file, fullRead);
    dbg.gpsResult = gpsResult ? JSON.stringify(gpsResult) : 'null';
    setGps(gpsResult);
  } catch (e) {
    dbg.gpsError = String(e);
    console.warn('[EXIF] parseGps(file) failed:', e);
  }

  if (lat === null) {
    try {
      const gpsResult = await exifr.gps(buf);
      dbg.gpsBufferResult = gpsResult ? JSON.stringify(gpsResult) : 'null';
      setGps(gpsResult);
    } catch (e) {
      dbg.gpsBufferError = String(e);
      console.warn('[EXIF] parseGps(buffer) failed:', e);
    }
  }

  // Second attempt using parse({gps:true}) if parseGps returned nothing
  if (lat === null) {
    try {
      const fallback = await exifr.parse(file, { gps: true, tiff: true, xmp: true, ...fullRead });
      dbg.gpsFallback = fallback ? JSON.stringify(fallback) : 'null';
      setGps(fallback);
    } catch (e) {
      dbg.gpsFallbackError = String(e);
      console.warn('[EXIF] parse(file, {gps:true}) fallback failed:', e);
    }
  }

  if (lat === null) {
    try {
      const fallback = await exifr.parse(buf, { gps: true, tiff: true, xmp: true });
      dbg.gpsBufferFallback = fallback ? JSON.stringify(fallback) : 'null';
      setGps(fallback);
    } catch (e) {
      dbg.gpsBufferFallbackError = String(e);
      console.warn('[EXIF] parse(buffer, {gps:true}) fallback failed:', e);
    }
  }

  // Last attempt: read raw GPS tags and convert them ourselves, mirroring the
  // Python app's HEIC path where we decode GPS IFD data and then derive decimal coords.
  if (lat === null) {
    try {
      const rawGps = await exifr.parse(file, {
        pick: RAW_GPS_PICK,
        gps: true,
        tiff: true,
        reviveValues: false,
        translateValues: false,
        ...fullRead,
      });
      dbg.rawGpsFile = rawGps ? JSON.stringify(rawGps) : 'null';
      const extracted = _extractLatLonFromRawGps(rawGps);
      setGps({ ...rawGps, latitude: extracted.lat, longitude: extracted.lon });
    } catch (e) {
      dbg.rawGpsFileError = String(e);
      console.warn('[EXIF] raw GPS file parse failed:', e);
    }
  }

  if (lat === null) {
    try {
      const rawGps = await exifr.parse(buf, {
        pick: RAW_GPS_PICK,
        gps: true,
        tiff: true,
        reviveValues: false,
        translateValues: false,
      });
      dbg.rawGpsBuffer = rawGps ? JSON.stringify(rawGps) : 'null';
      const extracted = _extractLatLonFromRawGps(rawGps);
      setGps({ ...rawGps, latitude: extracted.lat, longitude: extracted.lon });
    } catch (e) {
      dbg.rawGpsBufferError = String(e);
      console.warn('[EXIF] raw GPS buffer parse failed:', e);
    }
  }

  return { time, lat, lon, altitude, accuracy, dbg };
}

// Prepare an imported file for preview + AI without eagerly re-encoding the full upload blob.
// Strategy: if the browser can decode the image, keep the original file for upload/preview and
// only generate a reduced AI JPEG. This avoids expensive full-resolution canvas encodes on
// Android imports. If decode fails (e.g. some HEIC flows outside Safari/native conversion),
// we fall back to the original file as-is.
function _isAndroidNativeJpegImport(file, nativePhoto) {
  return isAndroidApp()
    && !!nativePhoto
    && file?.type === 'image/jpeg';
}

async function _processFile(file, options = {}) {
  if (_isAndroidNativeJpegImport(file, options.nativePhoto)) {
    return {
      blob: file,
      aiBlob: file,
      meta: {
        aiCropRect: null,
        aiCropSourceW: null,
        aiCropSourceH: null,
      },
    };
  }

  // 1. Browser-decodable path.
  try {
    const { blob, aiBlob, metaSource } = await _prepareImportBlobs(file);
    const meta = await createImageCropMeta(metaSource || blob, { preseed: true });
    return { blob, aiBlob, meta };
  } catch (_) {}

  // 2. Final fallback — original file (may still show blank if browser can't decode it).
  const meta = await createImageCropMeta(file, { preseed: true }).catch(() => ({
    aiCropRect: null,
    aiCropSourceW: null,
    aiCropSourceH: null,
  }));
  return { blob: file, aiBlob: file, meta };
}

export function renderSessions() {
  const list = document.getElementById('import-session-list');
  const countEl = document.getElementById('import-session-count');
  const groupingControls = document.getElementById('import-grouping-controls');
  const gapInput = document.getElementById('import-gap-input');
  const gapLabel = document.getElementById('import-gap-label');
  const gapUnit = document.getElementById('import-gap-unit');

  const n = sessions.length;
  countEl.textContent = tp('counts.group', n);
  if (gapLabel) gapLabel.textContent = t('settings.newObservationAfter');
  if (gapInput) _syncPhotoGapDisplays();
  if (groupingControls) groupingControls.style.display = n > 1 ? 'block' : 'none';

  list.innerHTML = sessions.map(session => buildCardHTML(session)).join('');

  list.querySelectorAll('.import-card-main[data-sid]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.import-card-delete')) return;
      const sid = el.dataset.sid;
      const card = el.closest('.import-card');
      const expanded = card.querySelector('.import-card-expanded');
      const isOpen = expanded.style.display !== 'none';
      if (isOpen) {
        expanded.style.display = 'none';
        expandedSessionIds.delete(sid);
      } else {
        expanded.style.display = 'block';
        expandedSessionIds.add(sid);
        _wireCard(sid);
      }
    });
  });

  list.querySelectorAll('.import-card-delete[data-sid]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sid = btn.dataset.sid;
      const session = sessionById(sid);
      if (session) {
        const removeIds = new Set(session.sourceItemIds || []);
        sourceItems = sourceItems.filter(item => !removeIds.has(item.id));
        expandedSessionIds.delete(sid);
        _buildSessionsFromSourceItems();
        if (!sessions.length) clearImportSessions();
        else _persistSessions();
        renderSessions();
        _prefillSessionLocations();
      }
    });
  });

  list.querySelectorAll('.import-strip-delete[data-sid]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sid = btn.dataset.sid;
      const idx = parseInt(btn.dataset.idx, 10);
      const session = sessionById(sid);
      if (!session) return;
      const removeId = session.sourceItemIds?.[idx];
      if (removeId) {
        sourceItems = sourceItems.filter(item => item.id !== removeId);
      }
      if (session.files.length <= 1) expandedSessionIds.delete(sid);
      _buildSessionsFromSourceItems();
      if (!sessions.length) clearImportSessions();
      else _persistSessions();
      renderSessions();
      _prefillSessionLocations();
    });
  });

  list.querySelectorAll('.import-vis-radio[data-sid]').forEach(input => {
    input.addEventListener('change', () => {
      const s = sessionById(input.dataset.sid);
      if (s) s.visibility = normalizeCaptureVisibility(input.value, getDefaultVisibility());
      _persistSessions();
      
      const group = input.closest('.scope-tabs');
      if (group) {
        group.querySelectorAll('.scope-tab').forEach(tab => tab.classList.remove('active'));
        input.closest('.scope-tab').classList.add('active');
      }
    });
  });

  list.querySelectorAll('.import-draft-checkbox[data-sid]').forEach(input => {
    input.addEventListener('change', () => {
      const s = sessionById(input.dataset.sid);
      if (s) s.is_draft = input.checked;
      _persistSessions();
    });
  });

  list.querySelectorAll('.import-obscure-checkbox[data-sid]').forEach(input => {
    input.addEventListener('change', () => {
      const s = sessionById(input.dataset.sid);
      if (s) s.location_precision = input.checked ? 'fuzzed' : 'exact';
      _persistSessions();
    });
  });

  list.querySelectorAll('.import-uncertain-checkbox[data-sid]').forEach(input => {
    input.addEventListener('change', () => {
      const s = sessionById(input.dataset.sid);
      if (s) {
        s.uncertain = input.checked;
        const card = input.closest('.import-card');
        if (card) {
          const speciesEl = card.querySelector('.import-card-species');
          if (speciesEl && s.taxon) {
            speciesEl.innerHTML = escHtml(s.uncertain ? `? ${s.taxon.displayName.replace(/^\?\s*/, '')}` : s.taxon.displayName.replace(/^\?\s*/, ''));
          }
        }
      }
      _persistSessions();
    });
  });

  list.querySelectorAll('.import-card-expanded[data-sid]').forEach(expanded => {
    const sid = expanded.dataset.sid;
    const isOpen = expandedSessionIds.has(sid);
    expanded.style.display = isOpen ? 'block' : 'none';
    if (isOpen) _wireCard(sid);
  });

  _updateImportFooterUi();
  void _syncImportAiDefaultAvailability();
}

function buildCardHTML(session) {
  const sid = session.id;
  const dateStr = formatDate(session.ts, { month: 'short', day: 'numeric' });
  const timeStr = formatTime(session.ts, { hour: '2-digit', minute: '2-digit', hour12: false });
  const photoCount = session.files.length;
  const imageMeta = _ensureSessionImageMeta(session);
  const croppedCount = imageMeta.filter(meta => hasAiCropRect(meta?.aiCropRect)).length;
  const speciesText = session.taxon
    ? escHtml(session.uncertain ? `? ${session.taxon.displayName.replace(/^\?\s*/, '')}` : session.taxon.displayName.replace(/^\?\s*/, ''))
    : `<span style="opacity:0.45">${t('detail.unknownSpecies')}</span>`;
  const activeService = normalizeIdentifyService(session.aiActiveService || getDefaultIdService());
  const aiStateHtml = session.files.length
    ? renderIdentifyServiceStateSummary(_sessionAiResultState(session, activeService))
    : '';
  const stackImgs = session.blobUrls.slice(0, 3);
  const polaroids = stackImgs.map((url, i) =>
    `<div class="polaroid-print polaroid-p${i}"><img src="${escHtml(url)}"></div>`
  ).join('');

  const stripItems = session.blobUrls.map((url, i) =>
    `<div class="import-strip-item" data-sid="${sid}" data-idx="${i}">
      <img src="${escHtml(url)}" class="import-strip-thumb" loading="lazy">
      ${hasAiCropRect(imageMeta[i]?.aiCropRect) ? '<div class="ai-crop-thumb-badge">AI crop</div>' : ''}
      <button class="import-strip-delete" data-sid="${sid}" data-idx="${i}">×</button>
    </div>`
  ).join('') + `
    <div class="import-strip-item import-strip-add" data-sid="${sid}">
      <button class="import-strip-add-file" data-sid="${sid}" type="button" aria-label="${t('import.upload') || 'Upload'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <span>${t('import.upload') || 'Upload'}</span>
      </button>
    </div>
  `;

  const taxonVal = session.taxon ? escHtml(session.taxon.displayName) : '';
  const locVal = escHtml(session.locationName);
  const sessionVisibility = normalizeCaptureVisibility(session.visibility, getDefaultVisibility());
  const visChecked = v => sessionVisibility === v ? 'checked' : '';
  const heicWithoutGps = session.gpsLat === null && (session.exifDebug || []).some(d =>
    /\.(heic|heif)$/i.test(d?.fileName || '') || /heic|heif/i.test(d?.fileType || '')
  );
  const missingGpsHint = heicWithoutGps
    ? `<div class="import-location-hint">${t('import.noHeicGps')}</div>`
    : '';

  return `<div class="import-card" data-sid="${sid}">
  <div class="import-card-main" data-sid="${sid}">
    <div class="polaroid-stack">
      ${polaroids}
    </div>
    <div class="import-card-info">
      <div class="import-card-datetime">
        <div class="import-card-datetime-main">
          <span>${dateStr}</span>
          <span>${timeStr}</span>
        </div>
        <div class="import-card-count">${tp('counts.photo', photoCount)}</div>
      </div>
      <div class="import-card-loc">${session.locationName ? escHtml(session.locationName) : '—'}</div>
      <div class="import-card-species">${speciesText}</div>
      ${aiStateHtml ? `<div class="import-card-ai-state">${aiStateHtml}</div>` : ''}
    </div>
    <button class="import-card-delete" data-sid="${sid}" aria-label="${t('common.delete')}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    </button>
  </div>
  <div class="import-card-expanded" data-sid="${sid}" style="display:none">
    <div class="import-photo-strip">
      ${stripItems}
    </div>
    <div class="import-location-hint import-card-crop-hint">${t('crop.noCropHint')}</div>
    <div class="detail-field" style="margin-top:12px">
      <div class="detail-field-label">${t('detail.species')}</div>
      <div class="taxon-field-wrap">
        <input class="taxon-input import-taxon-input" type="text" placeholder="${t('detail.unknownSpecies')}"
          data-sid="${sid}" autocomplete="off" spellcheck="false"
          value="${taxonVal}">
        <ul class="taxon-dropdown import-taxon-dropdown" data-sid="${sid}" style="display:none"></ul>
      </div>
      ${session.files.length ? _renderSessionAiControls(session) : ''}
    </div>
    <div class="detail-field" style="margin-top:4px">
      <div class="detail-field-label">${t('detail.location')}</div>
      <div class="location-suggest-wrap import-location-wrap">
        <input class="detail-text-input import-loc-input" type="text"
          data-sid="${sid}" placeholder="—" autocomplete="off" spellcheck="false"
          value="${locVal}">
        <ul class="location-suggestion-dropdown import-location-dropdown" data-sid="${sid}" style="display:none"></ul>
      </div>
      ${missingGpsHint}
    </div>
    <div class="detail-field" style="margin-top:8px">
      <div class="vis-radio-group" style="flex-wrap: wrap; gap: 8px;">
        <label class="detail-pill-toggle"><input type="checkbox" class="import-uncertain-checkbox" data-sid="${sid}" ${session.uncertain ? 'checked' : ''}> <span>${escHtml(t('detail.idNeeded'))}</span></label>
        <label class="detail-pill-toggle"><input type="checkbox" class="import-draft-checkbox" data-sid="${sid}" ${session.is_draft !== false ? 'checked' : ''}> <span>${escHtml(t('detail.draft'))}</span></label>
        <label class="detail-pill-toggle"><input type="checkbox" class="import-obscure-checkbox" data-sid="${sid}" ${session.location_precision === 'fuzzed' ? 'checked' : ''}> <span>${escHtml(t('locationPrecision.fuzzed'))}</span></label>
      </div>
    </div>
    <div class="detail-field" style="margin-top:8px">
      <div class="detail-field-label">${t('detail.sharing')}</div>
      <div class="scope-tabs" style="display:inline-flex">
        <label class="scope-tab ${sessionVisibility === 'private' ? 'active' : ''}"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="private" ${visChecked('private')}> <span>${translateVisibility('private')}</span></label>
        <label class="scope-tab ${sessionVisibility === 'friends' ? 'active' : ''}"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="friends" ${visChecked('friends')}> <span>${translateVisibility('friends')}</span></label>
        <label class="scope-tab ${sessionVisibility === 'public' ? 'active' : ''}"><input type="radio" class="import-vis-radio" name="vis-${sid}" data-sid="${sid}" value="public" ${visChecked('public')}> <span>${translateVisibility('public')}</span></label>
      </div>
    </div>
  </div>
  <input type="hidden" class="import-lat-input" data-sid="${sid}" value="${session.gpsLat ?? ''}">
  <input type="hidden" class="import-lon-input" data-sid="${sid}" value="${session.gpsLon ?? ''}">
</div>`;
}

function _wireImportLocationInput(sid, card) {
  const input = card.querySelector(`.import-loc-input[data-sid="${sid}"]`);
  if (!input || input._wired) return;
  input._wired = true;

  input.addEventListener('focus', () => _renderImportLocationDropdown(sid, true));
  input.addEventListener('click', () => _renderImportLocationDropdown(sid, true));
  input.addEventListener('input', () => {
    const session = sessionById(sid);
    if (!session) return;
    session.locationName = input.value.trim();
    const locEl = card.querySelector('.import-card-loc');
    if (locEl) locEl.textContent = session.locationName || '—';
    _persistSessions();
    _renderImportLocationDropdown(sid, document.activeElement === input);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => _renderImportLocationDropdown(sid, false), 160);
  });
}

function _renderImportLocationDropdown(sid, show) {
  const session = sessionById(sid);
  const dropdown = document.querySelector(`.import-location-dropdown[data-sid="${sid}"]`);
  const input = document.querySelector(`.import-loc-input[data-sid="${sid}"]`);
  if (!dropdown || !input) return;

  const options = Array.isArray(session?.locationSuggestions) ? session.locationSuggestions : [];
  if (!show || !options.length) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  dropdown.innerHTML = options
    .map((name, index) => `<li data-index="${index}">${escHtml(name)}</li>`)
    .join('');
  dropdown.style.display = 'block';
  dropdown.querySelectorAll('li').forEach((item, index) => {
    const handleSelect = event => {
      event.preventDefault();
      event.stopPropagation();
      const name = options[index] || '';
      const nextSession = sessionById(sid);
      if (nextSession) {
        nextSession.locationName = name;
        nextSession.locationAutoApplied = name;
      }
      input.value = name;
      const locEl = document.querySelector(`.import-card[data-sid="${sid}"] .import-card-loc`);
      if (locEl) locEl.textContent = name || '—';
      dropdown.style.display = 'none';
      _persistSessions();
    }
    item.addEventListener('mousedown', handleSelect);
    item.addEventListener('touchstart', handleSelect, { passive: false });
  });
}

function _wireCard(sid) {
  const card = document.querySelector(`.import-card[data-sid="${sid}"]`);
  if (!card) return;
  _wireImportLocationInput(sid, card);

  const input = card.querySelector(`.import-taxon-input[data-sid="${sid}"]`);
  const dropdown = card.querySelector(`.import-taxon-dropdown[data-sid="${sid}"]`);
  if (!input || !dropdown || input._wired) return;
  input._wired = true;
  _ensureSessionImageMeta(sessionById(sid));

  let debounceTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    const session = sessionById(sid);
    if (session) {
      session.taxon = createManualTaxon(q);
      _persistSessions();
    }
    if (!q) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
    debounceTimer = setTimeout(async () => {
      try {
        if (q.length < 2) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
        const results = await searchTaxa(q, getTaxonomyLanguage());
        if (!results?.length) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
        dropdown.innerHTML = results.map((r, i) => {
          const display = formatDisplayName(r.genus, r.specificEpithet, r.vernacularName);
          return `<li data-idx="${i}">${escHtml(display)}</li>`;
        }).join('');
        dropdown.style.display = 'block';
        dropdown.querySelectorAll('li').forEach((li, i) => {
          const selectTaxon = event => {
            event.preventDefault();
            event.stopPropagation();
            const r = results[i];
            const display = formatDisplayName(r.genus, r.specificEpithet, r.vernacularName);
            const session = sessionById(sid);
            if (session) {
              session.taxon = {
                genus: r.genus || null,
                specificEpithet: r.specificEpithet || null,
                vernacularName: r.vernacularName || null,
                displayName: display,
              };
              _persistSessions();
            }
            input.value = display;
            dropdown.style.display = 'none';
            dropdown.innerHTML = '';
            input.blur?.();
            renderSessions();
          };
          li.addEventListener('pointerdown', selectTaxon);
          li.addEventListener('mousedown', selectTaxon);
        });
      } catch (_) { dropdown.style.display = 'none'; }
    }, 280);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { dropdown.style.display = 'none'; }, 200);
  });

  const session = sessionById(sid)
  card.querySelectorAll(`.import-strip-item[data-sid="${sid}"]`).forEach(item => {
    if (item._wired) return
    if (item.classList.contains('import-strip-add')) return
    item._wired = true
    item.addEventListener('click', event => {
      if (event.target.closest('.import-strip-delete')) return
      const session = sessionById(sid)
      if (!session) return
      const startIndex = parseInt(item.dataset.idx, 10) || 0
      _openSessionCropEditor(session, startIndex)
    })
  })
  const addFileBtn = card.querySelector(`.import-strip-add-file[data-sid="${sid}"]`)
  if (addFileBtn && !addFileBtn._wired) {
    addFileBtn._wired = true
    addFileBtn.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      void _openFileImportForSession(sid)
    })
  }
  const aiRunBtn = card.querySelector(`[data-identify-run-button][data-sid="${sid}"]`)
  const aiResults = card.querySelector(`[data-identify-results][data-sid="${sid}"]`)
  if (aiRunBtn && !aiRunBtn._wired) {
    aiRunBtn._wired = true
    aiRunBtn.addEventListener('click', () => _runSessionAiComparison(sid))
  }

  card.querySelectorAll('[data-identify-service-tab][data-sid]').forEach(tab => {
    if (tab._wired) return
    tab._wired = true
    tab.addEventListener('click', () => {
      const session = sessionById(sid)
      if (!session) return
      const service = normalizeIdentifyService(tab.dataset.identifyServiceTab)
      const normalized = _ensureSessionAiState(session)
      session.aiActiveService = service
      session.aiService = service
      _persistSessions()
      renderSessions()
      if (_sessionServiceNeedsRerun(normalized, service)) {
        void _runSessionAiService(sid, service)
      }
    })
  })

  if (aiResults) {
    aiResults.querySelectorAll('[data-identify-result]').forEach(el => {
      if (el._wired) return
      el._wired = true
      el.addEventListener('click', () => {
        const prediction = JSON.parse(el.dataset.identifyResult)
        const session = sessionById(sid)
        if (!session) return
        if (!_applySessionAiPrediction(session, prediction)) return
        const serviceKey = normalizeIdentifyService(prediction.service || session.aiActiveService || getDefaultIdService())
        session.aiActiveService = serviceKey
        session.aiService = serviceKey
        session.aiPredictionsByService ||= {}
        _persistSessions()
        input.value = prediction.displayName
        input.blur?.()
        renderSessions()
      })
    })
  }

  void _syncSessionAiAvailability(session)
}

async function _openFileImportForSession(sid) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = 'image/*'
  if (/android/i.test(navigator.userAgent)) {
    input.accept = '.jpg,.jpeg,.png,.webp,.avif,.heic,.heif,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif'
  }
  input.onchange = async event => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return
    await _addFilesToSession(sid, files)
  }
  input.click()
}

function _openSessionCropEditor(session, startIndex = 0) {
  const imageMeta = _ensureSessionImageMeta(session)
  openAiCropEditor({
    title: t('crop.editorTitle'),
    startIndex,
    images: session.blobUrls.map((url, index) => ({
      url,
      aiCropRect: imageMeta[index]?.aiCropRect || null,
    })),
    onChange: (index, nextMeta) => {
      imageMeta[index] = {
        ...imageMeta[index],
        ...nextMeta,
      }
    },
    onClose: committed => {
      if (committed) {
        _persistSessions()
        renderSessions()
      }
    },
  })
}

async function saveAll() {
  if (importAiBatchState.running) return;
  const saveBtn = document.getElementById('import-save-btn');
  saveBtn.disabled = true;

  const activeSessions = sessions.filter(s => s.files.length > 0);
  if (!activeSessions.length) {
    saveBtn.disabled = false;
    await openFinds('mine', { resetSearch: true });
    return;
  }

  const allBlobUrls = sessions.flatMap(s => s.blobUrls);
  let savedCount = 0;

  _setProgress(0, activeSessions.length, t('import.processing'));
  await new Promise(r => setTimeout(r, 100)); // Yield to let button un-press

  for (let i = 0; i < activeSessions.length; i++) {
    const session = activeSessions[i];
    try {
      if ((session.gpsLat === null || session.gpsLon === null) && session.metadataPromise) {
        await session.metadataPromise;
      }
      const obsPayload = {
        user_id: state.user.id,
        date: _localDate(session.ts),
        captured_at: session.ts.toISOString(),
        gps_latitude: session.gpsLat ?? null,
        gps_longitude: session.gpsLon ?? null,
        gps_altitude: session.gpsAltitude ?? null,
        gps_accuracy: session.gpsAccuracy ?? null,
        location: session.locationName || null,
        source_type: 'personal',
        genus: session.taxon?.genus || null,
        species: session.taxon?.specificEpithet || null,
        common_name: session.taxon?.vernacularName || null,
        visibility: toCloudVisibility(normalizeVisibility(session.visibility, getDefaultVisibility())),
        is_draft: session.is_draft !== false,
        location_precision: session.location_precision || 'exact',
        uncertain: !!session.uncertain,
      };

      _ensureSessionImageMeta(session);
      await enqueueObservation(obsPayload, session.files.map((blob, index) => ({
        blob,
        aiCropRect: session.imageMeta[index]?.aiCropRect || null,
        aiCropSourceW: session.imageMeta[index]?.aiCropSourceW ?? null,
        aiCropSourceH: session.imageMeta[index]?.aiCropSourceH ?? null,
      })));
      savedCount++;
      _setProgress(i + 1, activeSessions.length, t('import.processing'));
    } catch (err) {
      console.error('Failed to save session', session.id, err);
      showToast(t('import.failedOneGroup'));
    }
  }

  allBlobUrls.forEach(url => URL.revokeObjectURL(url));
  sessions = [];
  expandedSessionIds = new Set();
  sourceItems = [];
  clearImportSessions();
  if (savedCount > 0) showToast(t('import.saved', { count: tp('counts.observation', savedCount) }));
  _hideProgress();
  saveBtn.disabled = false;
  await openFinds('mine', { resetSearch: true });
}

function _getScaledSize(width, height, maxEdge) {
  if (!width || !height || !maxEdge) return { width, height };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function _canvasToJpegBlob(img, width, height, quality = 0.88) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas context unavailable'));
      return;
    }

    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

// Returns the original file for preview/upload plus a reduced JPEG for AI inference.
// Works for any image format the browser can decode via <img>.
function _prepareImportBlobs(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          reject(new Error('zero dimensions — format not supported by this browser'));
          return;
        }

        const aiSize = _getScaledSize(w, h, IMPORT_AI_MAX_EDGE);
        const aiBlob = aiSize.width === w
          && aiSize.height === h
          && file.type === 'image/jpeg'
          ? file
          : await _canvasToJpegBlob(img, aiSize.width, aiSize.height, 0.88);

        resolve({
          blob: file,
          aiBlob,
          metaSource: file,
        });
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}

// ── Session specific additions ────────────────────────────────────────────────

async function _openCameraForSession(sid) {
  if (isAndroidNativeApp()) {
    try {
      if (getUseSystemCamera()) {
        const result = await NativeCamera.openSystemCamera();
        const photos = Array.isArray(result?.photos) ? result.photos : [];
        if (!photos.length) return;
        _setProgress(0, photos.length, t('import.readingFiles'));
        const files = [];
        for (let i = 0; i < photos.length; i++) {
          _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }));
          files.push(await nativePickedPhotoToFile(photos[i], i));
        }
        await _addFilesToSession(sid, files, { nativePhotos: photos });
        return;
      }

      const { value: useHdrStr } = await Preferences.get({ key: 'useHdr' });
      const useHdr = useHdrStr !== 'false';

      const gps = state.gps && Number.isFinite(state.gps.lat) && Number.isFinite(state.gps.lon)
        ? { latitude: state.gps.lat, longitude: state.gps.lon, altitude: state.gps.altitude, accuracy: state.gps.accuracy }
        : null;

      const options = { useHdr, jpegQuality: NATIVE_CAMERA_JPEG_QUALITY };
      if (gps) options.gps = gps;
      const result = await NativeCamera.capturePhotos(options);
      const photos = Array.isArray(result?.photos) ? result.photos : [];
      if (!photos.length) return;
      
      _setProgress(0, photos.length, t('import.readingFiles'));
      const files = [];
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }));
        files.push(await nativePickedPhotoToFile(photos[i], i));
      }
      await _addFilesToSession(sid, files, { nativePhotos: photos });
    } catch (err) {
      if (isPickerCancel(err)) return;
      showToast(`Sporely Cam: ${err?.message || err}`);
      _hideProgress();
    }
  } else {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      await _addFilesToSession(sid, files);
    };
    input.click();
  }
}

async function _openPickerForSession(sid) {
  if (isAndroidNativeApp()) {
    try {
      const result = await pickImagesWithNativePhotoPicker();
      const photos = Array.isArray(result?.photos) ? result.photos : [];
      if (!photos.length) return;
      _setProgress(0, photos.length, t('import.readingFiles'));
      const files = [];
      for (let i = 0; i < photos.length; i++) {
        _setProgress(i, photos.length, t('import.importingFile', { current: i + 1, total: photos.length }));
        files.push(await nativePickedPhotoToFile(photos[i], i));
      }
      await _addFilesToSession(sid, files, { nativePhotos: photos });
      return;
    } catch (err) {
      if (isPickerCancel(err)) return;
      _hideProgress();
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*';
  if (/android/i.test(navigator.userAgent)) {
    input.accept = '.jpg,.jpeg,.png,.webp,.avif,.heic,.heif,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif';
  }
  input.onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await _addFilesToSession(sid, files);
  };
  input.click();
}

async function _addFilesToSession(sid, files, options = {}) {
  const session = sessionById(sid);
  if (!session || !files.length) return;
  const nativePhotos = Array.isArray(options.nativePhotos) ? options.nativePhotos : [];
  _setProgress(0, files.length, t('import.readingTimestamps'));
  
  const withTimes = await Promise.all(files.map(async (f, idx) => {
    const nativePhoto = nativePhotos[idx];
    if (nativePhoto) {
      const { time, lat, lon, altitude, accuracy, dbg } = await captureNativePhotoExif(nativePhoto, f);
      return { file: f, nativePhoto, metadataPromise: createNativeMetadataHydrationPromise(nativePhoto, f), captureTime: time, lat, lon, altitude, accuracy, dbg };
    }
    const { time, lat, lon, altitude, accuracy, dbg } = await captureExif(f);
    return { file: f, captureTime: time, lat, lon, altitude, accuracy, dbg };
  }));

  let doneCount = 0;
  for (let idx = 0; idx < withTimes.length; idx++) {
    const item = withTimes[idx];
    _setProgress(doneCount, files.length, t('import.convertingFile', { current: doneCount + 1, total: files.length }));
    const processed = await processFile(item.file, { nativePhoto: item.nativePhoto });
    const newItem = {
      id: `i_add_${Date.now()}_${idx}`,
      blob: processed.blob,
      aiBlob: processed.aiBlob || processed.blob,
      meta: processed.meta,
      metadataPromise: item.metadataPromise || null,
      captureTime: session.ts.getTime(), // Force to match session so it is not ripped out by photo gap
      lat: item.lat ?? null,
      lon: item.lon ?? null,
      altitude: item.altitude ?? null,
      accuracy: item.accuracy ?? null,
      dbg: item.dbg || null,
    };
    sourceItems.push(newItem);
    session.sourceItemIds.push(newItem.id);
    session.files.push(newItem.blob);
    session.aiFiles.push(newItem.aiBlob);
    session.blobUrls.push(URL.createObjectURL(newItem.blob || newItem.aiBlob));
    session.imageMeta.push(newItem.meta);
    session.metadataPromises.push(newItem.metadataPromise);
    session.photoTimes.push(newItem.captureTime);
    session.photoGps.push({ lat: newItem.lat, lon: newItem.lon, altitude: newItem.altitude, accuracy: newItem.accuracy });
    session.photoDebug.push(newItem.dbg);
    
    if (session.gpsLat === null && _isUsableCoordinate(newItem.lat, newItem.lon)) {
      session.gpsLat = newItem.lat;
      session.gpsLon = newItem.lon;
      session.gpsAltitude = newItem.altitude;
      session.gpsAccuracy = newItem.accuracy;
    }
    doneCount++;
  }
  
  _hideProgress();
  _attachSessionMetadataHydration();
  _persistSessions();
  renderSessions();
  _prefillSessionLocations();
}

// Use local date string to avoid UTC midnight shift
function _localDate(ts) {
  return `${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')}`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export {
  _ensureSessionAiState,
  _sessionAiResultState,
  _storeSessionAiServiceResult,
  _sessionServiceNeedsRerun,
  _applySessionAiPrediction,
  _applySessionAiTopPrediction,
}
