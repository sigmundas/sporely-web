import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IDENTIFICATION_IDENTIFIED,
  IDENTIFICATION_UNIDENTIFIED,
  IDENTIFICATION_UNRESOLVED_IDENTITY,
  isObservationUnidentified,
  observationIdentificationState,
} from './observation-identity.js'

// Taxonomy-v2 closeout Stage 2 Part B, required regressions 4 and 5.

test('an unresolved external identity renders as identified, not unidentified', () => {
  const obs = {
    genus: 'Entoloma',
    species: 'conferendum',
    common_name: 'stjernesporet rødspore',
    selected_sporely_taxon_id: null,
    taxon_identity_state: 'external_unresolved',
    taxon_identity_source_system: 'nortaxa',
    taxon_identity_namespace: 'nortaxa_taxon_id',
    taxon_identity_external_id: '53482',
    taxon_identity_raw_external_id: 'NBIC:53482',
  }
  assert.equal(observationIdentificationState(obs), IDENTIFICATION_UNRESOLVED_IDENTITY)
  // The decisive assertion: this observation must NOT be treated as
  // unidentified anywhere in the UI.
  assert.equal(isObservationUnidentified(obs), false)
})

test('a genuinely name-less observation is still unidentified', () => {
  // The observation 917 shape: media exists, every name column is null, and
  // no identity is bound.
  const obs = {
    genus: null,
    species: null,
    common_name: null,
    selected_sporely_taxon_id: null,
    resolved_sporely_taxon_id: null,
  }
  assert.equal(observationIdentificationState(obs), IDENTIFICATION_UNIDENTIFIED)
  assert.equal(isObservationUnidentified(obs), true)
  // Empty strings are not names either.
  assert.equal(isObservationUnidentified({ genus: '', species: '  ', common_name: '' }), true)
  assert.equal(isObservationUnidentified({}), true)
})

test('a name-less observation with a preserved identifier is still unidentified', () => {
  // Preserving an identifier does not invent a name. Unidentified is about
  // the absence of a name, not the absence of a binding.
  assert.equal(isObservationUnidentified({
    genus: null,
    species: null,
    common_name: null,
    taxon_identity_state: 'external_unresolved',
    taxon_identity_source_system: 'nortaxa',
    taxon_identity_namespace: 'nortaxa_taxon_id',
    taxon_identity_external_id: '53482',
  }), true)
})

test('a bound Sporely identity is plainly identified', () => {
  assert.equal(observationIdentificationState({
    genus: 'Conocybe',
    species: 'rugosa',
    selected_sporely_taxon_id: 83668,
    taxon_identity_state: 'sporely_v2',
  }), IDENTIFICATION_IDENTIFIED)
})

test('a resolved row is identified even though it kept its source tuple', () => {
  // After resolution the external evidence is retained for audit. That must
  // not make the row look unresolved.
  assert.equal(observationIdentificationState({
    genus: 'Entoloma',
    species: 'conferendum',
    selected_sporely_taxon_id: 7821,
    taxon_identity_state: 'sporely_v2',
    taxon_identity_source_system: 'nortaxa',
    taxon_identity_namespace: 'nortaxa_taxon_id',
    taxon_identity_external_id: '53482',
  }), IDENTIFICATION_IDENTIFIED)
})

test('a vernacular-only identification counts as identified', () => {
  assert.equal(isObservationUnidentified({ common_name: 'rødrandkjuke' }), false)
})

test('a row saved before the provenance columns existed is still classified', () => {
  // A complete source tuple with no state column still signals an unresolved
  // external identity.
  assert.equal(observationIdentificationState({
    genus: 'Entoloma',
    species: 'conferendum',
    taxon_identity_source_system: 'nortaxa',
    taxon_identity_namespace: 'nortaxa_taxon_id',
    taxon_identity_external_id: '53482',
  }), IDENTIFICATION_UNRESOLVED_IDENTITY)
  // A plain pre-Stage-2 identified row is simply identified.
  assert.equal(observationIdentificationState({
    genus: 'Amanita', species: 'muscaria',
  }), IDENTIFICATION_IDENTIFIED)
})

test('a stored genus-only identification renders as identified', () => {
  // Stage 2 Part B finding: a genus-only provider result used to land only in
  // `ai_selected_scientific_name`, so the observation still rendered as
  // unidentified. The fix is at the WRITE boundary — a lone genus is now
  // stored in `genus` — and this is the display half of it.
  assert.equal(observationIdentificationState({
    genus: 'Entoloma', species: null, common_name: null,
  }), IDENTIFICATION_IDENTIFIED)
  assert.equal(isObservationUnidentified({ genus: 'Entoloma' }), false)
})

test('AI history alone is NOT an identification', () => {
  // Deliberate: the classifier does not read `ai_selected_*`. "The AI
  // suggested something" is not "the observer accepted an identification",
  // and the plan requires the two be kept apart. The correct fix for a usable
  // provider name is to store it as an identification, not to teach the
  // display to treat suggestion history as one.
  assert.equal(observationIdentificationState({
    genus: null,
    species: null,
    common_name: null,
    ai_selected_service: 'artsorakel',
    ai_selected_taxon_id: 'NBIC:53482',
    ai_selected_scientific_name: 'Entoloma conferendum',
  }), IDENTIFICATION_UNIDENTIFIED)
})
