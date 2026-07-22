import { createDefaultObservationDraft } from './observation-defaults.js'
import { getLocationPreference } from './settings.js'

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
    // Once set (last photo timestamp + grace), fixes taken after this
    // moment are rejected for the session fix, so the observation location
    // stays pinned to capture time even if the device keeps moving.
    captureWindowEndAt: null,
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
