import { createDefaultObservationDraft } from './observation-defaults.js'
import { normalizeObservationGps } from './observation-shapes.js'
import { getLocationPreference } from './settings.js'

const GPS_FIX_MAX_AGE_MS = 5 * 60 * 1000

function _normalizeLegacyGps(value) {
  if (!value || typeof value !== 'object') return null
  const normalized = normalizeObservationGps(value)
  if (!normalized) return null

  const timestampValue = Number(value.timestamp ?? value.ts)
  return {
    ...normalized,
    timestamp: Number.isFinite(timestampValue) ? timestampValue : Date.now(),
  }
}

function _pruneLegacyGpsFixIfStale() {
  const fix = state.location.fix
  if (!fix || !Number.isFinite(Number(fix.timestamp))) return fix

  const ageMs = Date.now() - Number(fix.timestamp)
  if (Number.isFinite(ageMs) && ageMs > GPS_FIX_MAX_AGE_MS) {
    state.location.fix = null
    if (state.location.status === 'fix' && state.location.watchId == null) {
      state.location.status = 'idle'
    }
    return null
  }

  return fix
}

function _createDefaultLocationState() {
  return {
    preference: getLocationPreference(),
    capability: 'unknown',
    permission: 'unknown',
    status: 'idle',
    fix: null,
    error: null,
    watchId: null,
  }
}

function _createDefaultCaptureSessionLocationState() {
  return {
    fix: null,
    sessionStartAt: null,
    requestingFreshFix: false,
  }
}

export const state = {
  currentScreen: 'home',
  capturedPhotos: [],
  reviewContext: null,
  captureDraft: createDefaultObservationDraft(),
  batchCount: 0,
  sessionStart: null,
  location: _createDefaultLocationState(),
  captureSessionLocation: _createDefaultCaptureSessionLocationState(),
  cameraStream: null,
  user: null,
  cloudPlan: null,
  searchQuery: '',
  observationScope: 'mine',
  findsScopePrimary: 'mine',
  findsMineScope: 'public',
  findsFeedScope: 'followed',
  mapTimeScope: 'month',
  findsView: 'cards',
  findsGroupBySpecies: false,
  findsSort: 'date',
  findsSporesOnly: false,
  findsStatusFilter: 'all',
  findsTargetUserId: null,
  findsTargetSummaryLoaded: false,
  findsTargetUsername: null,
  findsTargetAvatarUrl: null,
  findsTargetDisplayName: null,
  findsTargetBio: null,
  findsTargetRelationship: null,
  findsTargetFinds: 0,
  findsTargetSpecies: 0,
  findsTargetSpores: 0,
  findsTargetSummaryComplete: false,
}

Object.defineProperty(state, 'gps', {
  enumerable: false,
  configurable: true,
  get() {
    return _pruneLegacyGpsFixIfStale()
  },
  set(value) {
    state.location.fix = _normalizeLegacyGps(value)
  },
})
