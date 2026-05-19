import { getDefaultVisibility } from './settings.js'

/**
 * Default mutable draft state used by capture and review screens.
 * @param {Object} [overrides={}]
 * @returns {Object}
 */
export function createDefaultObservationDraft(overrides = {}) {
  return {
    habitat: '',
    notes: '',
    uncertain: false,
    is_draft: true,
    location_precision: 'exact',
    visibility: getDefaultVisibility(),
    ...overrides,
  }
}

/**
 * Base observation payload shared by review/import save paths and the queue.
 * Callers override the fields they already know while keeping defaults aligned.
 * @param {Object} [overrides={}]
 * @returns {Object}
 */
export function createDefaultObservationPayload(overrides = {}) {
  return {
    user_id: null,
    date: null,
    captured_at: null,
    location: null,
    habitat: null,
    notes: null,
    uncertain: false,
    source_type: 'personal',
    genus: null,
    species: null,
    common_name: null,
    visibility: getDefaultVisibility(),
    is_draft: true,
    location_precision: 'exact',
    gps_latitude: null,
    gps_longitude: null,
    gps_altitude: null,
    gps_accuracy: null,
    ...overrides,
  }
}
