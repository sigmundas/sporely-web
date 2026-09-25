/**
 * Taxonomy-v2 closeout Stage 2 Part B — name and identity are ONE decision.
 *
 * Two defects motivated these, and both lived in the coupling BETWEEN the
 * name write and the identity transition rather than inside either one:
 *
 *   1. `applyIdentificationCoherently` correctly declined to overwrite a good
 *      identification with an unusable candidate, but the identity transition
 *      ran anyway — so the row kept taxon A's name while binding (or clearing
 *      to) taxon B's identity.
 *   2. `_save` wrote the new name BEFORE the identity transition, so a native
 *      RPC rejection reported failure while leaving the new name persisted
 *      beside the previous valid Sporely identity.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from '../auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import {
  aiSelectionWarrantsIdentityTransition,
  buildDetailAiSelectionPatch,
  providerCandidateIsAcceptedAsIdentification,
  saveSelectionWarrantsIdentityTransition,
} from './find_detail.js'

const BOUND_AND_NAMED = {
  id: 917,
  genus: 'Amanita',
  species: 'muscaria',
  common_name: 'Fly agaric',
  selected_sporely_taxon_id: '168873',
  taxon_identity_state: 'sporely_v2',
}

// ── Finding 1: acceptance is one decision ─────────────────────────────────

test('a nameless candidate is not accepted as the identification', () => {
  for (const name of [null, '', '   ', '*** Utdatert versjon ***', '123', '???']) {
    assert.equal(
      providerCandidateIsAcceptedAsIdentification(name), false, String(name),
    )
  }
  // A usable name — binomial or bare genus — IS accepted.
  assert.equal(providerCandidateIsAcceptedAsIdentification('Entoloma conferendum'), true)
  assert.equal(providerCandidateIsAcceptedAsIdentification('Entoloma'), true)
})

test('a nameless candidate keeps the existing name AND leaves identity alone', () => {
  // The chimera at the identity axis. Candidate B carries `NBIC:53482` but no
  // usable name. The patch must keep A's name (it does), and because the
  // candidate is not accepted, B's identity must not be applied either —
  // whether or not its identifier would have resolved.
  const patch = buildDetailAiSelectionPatch(
    {
      selectedService: 'artsorakel',
      selectedPrediction: { scientificName: null, taxonId: 'NBIC:53482' },
    },
    BOUND_AND_NAMED,
  )
  // Name untouched.
  assert.equal('genus' in patch, false)
  assert.equal('species' in patch, false)
  assert.equal('common_name' in patch, false)
  // Not accepted -> the caller must skip the identity transition entirely.
  assert.equal(
    providerCandidateIsAcceptedAsIdentification(null), false,
    'the identity gate is what stops A-name + B-identity',
  )
  // No identity column is written by the patch itself either.
  for (const column of [
    'taxon_identity_state', 'taxon_identity_external_id', 'selected_sporely_taxon_id',
  ]) {
    assert.equal(column in patch, false, column)
  }
  // The identifier survives as provider HISTORY, which is where an
  // unaccepted suggestion belongs.
  assert.equal(patch.ai_selected_taxon_id, 'NBIC:53482')
})

test('a usable candidate is accepted for both name and identity together', () => {
  const patch = buildDetailAiSelectionPatch(
    {
      selectedService: 'artsorakel',
      selectedPrediction: {
        scientificName: 'Entoloma conferendum', taxonId: 'NBIC:53482',
      },
    },
    BOUND_AND_NAMED,
  )
  assert.equal(patch.genus, 'Entoloma')
  assert.equal(patch.species, 'conferendum')
  assert.equal(providerCandidateIsAcceptedAsIdentification('Entoloma conferendum'), true)
})

// ── Finding 1, at both call sites ──────────────────────────────────────────
//
// The defect was entirely in the CALL SITES: each applied the candidate's
// identity even when the name patch had deliberately kept the existing
// identification. These assert the coupling decision each site now makes.

test('the AI save path runs no identity transition for a nameless candidate', () => {
  // Both the resolved and unresolved cases: the gate sits UPSTREAM of
  // resolution, so it does not matter whether `NBIC:53482` would have bound.
  // That is the point — an unaccepted candidate never reaches the resolver.
  for (const prediction of [
    { scientificName: null, taxonId: 'NBIC:53482' },        // would resolve
    { scientificName: null, taxonId: 'NBIC:99999' },        // would not
    { scientificName: '*** Utdatert versjon ***', taxonId: 'NBIC:53482' },
    { scientificName: '', taxonId: 'NBIC:53482' },
    { taxonId: 'NBIC:53482' },
  ]) {
    assert.equal(
      aiSelectionWarrantsIdentityTransition(prediction), false,
      JSON.stringify(prediction),
    )
  }
  // A usable name warrants the transition.
  assert.equal(aiSelectionWarrantsIdentityTransition({
    scientificName: 'Entoloma conferendum', taxonId: 'NBIC:53482',
  }), true)
  assert.equal(aiSelectionWarrantsIdentityTransition(null), false)
})

test('the ordinary Save path runs no identity transition for a nameless provider pick', () => {
  const nameless = {
    genus: null, specificEpithet: null, vernacularName: null,
    taxonId: 'NBIC:53482', scientificName: null, providerCandidate: true,
  }
  assert.equal(saveSelectionWarrantsIdentityTransition(nameless, true), false)

  // A usable provider pick does warrant it.
  assert.equal(saveSelectionWarrantsIdentityTransition({
    ...nameless, scientificName: 'Entoloma conferendum',
  }, true), true)

  // A NATIVE selection is never subject to the name gate: it carries proven
  // identity, which IS the identification, and the name columns are a
  // best-effort projection of it.
  assert.equal(saveSelectionWarrantsIdentityTransition({
    capability: 'sporely-taxonomy-v2', sporelyTaxonId: '167',
    genus: null, specificEpithet: null,
  }, true), true)

  // Manual free text is an explicit clear of both.
  assert.equal(saveSelectionWarrantsIdentityTransition(null, true), true)

  // Nothing changed -> nothing to do.
  assert.equal(saveSelectionWarrantsIdentityTransition(nameless, false), false)
  assert.equal(saveSelectionWarrantsIdentityTransition(null, false), false)
})
