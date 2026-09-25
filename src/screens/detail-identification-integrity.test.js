/**
 * Taxonomy-v2 closeout Stage 2 Part B — the observation save boundary.
 *
 * `buildDetailAiSelectionPatch` used to be applied unconditionally, so a
 * provider candidate whose scientific name was absent or unparseable wrote
 * null `genus`, null `species` and null `common_name` over an existing
 * identification. That is the "renders as unidentified" condition, and it is
 * independent of taxonomy resolution: failing to bind
 * `selected_sporely_taxon_id` does not by itself clear those columns.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from '../auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import {
  applyIdentificationCoherently,
  buildDetailAiSelectionPatch,
  providerNameToIdentificationColumns,
} from './find_detail.js'

const IDENTIFIED_OBS = {
  id: 917,
  genus: 'Entoloma',
  species: 'conferendum',
  common_name: 'stjernesporet rødspore',
}

function _artsorakelSelection(prediction) {
  return { selectedService: 'artsorakel', selectedPrediction: prediction }
}

test('an unparseable candidate never clears an existing identification', () => {
  // Required regression 2. A name that is neither a binomial nor a plausible
  // genus token yields `[null, null]`; the previous patch sent those nulls
  // straight to the observation row.
  const patch = buildDetailAiSelectionPatch(
    _artsorakelSelection({ scientificName: '*** Utdatert versjon ***', taxonId: 'NBIC:53482' }),
    IDENTIFIED_OBS,
  )
  assert.equal('genus' in patch, false)
  assert.equal('species' in patch, false)
  // The AI-identification history is still recorded — it is a separate
  // record from the accepted observation identity.
  assert.equal(patch.ai_selected_taxon_id, 'NBIC:53482')
  assert.equal(patch.ai_selected_scientific_name, '*** Utdatert versjon ***')
})

test('a genus-only provider result is stored as a genus, not discarded', () => {
  // Stage 2 Part B: "if a provider returned a usable scientific name, that
  // name is what gets stored". A lone genus used to land only in
  // `ai_selected_scientific_name`, which the display classifier ignores — so
  // a freshly identified observation still rendered as unidentified.
  assert.deepEqual(providerNameToIdentificationColumns('Entoloma'), ['Entoloma', null])
  const patch = buildDetailAiSelectionPatch(
    _artsorakelSelection({ scientificName: 'Entoloma', taxonId: 'NBIC:53482' }),
    { id: 917, genus: null, species: null, common_name: null },
  )
  assert.equal(patch.genus, 'Entoloma')
  assert.equal(patch.species, null)
})

test('a genus token is only accepted when it actually looks like one', () => {
  for (const value of ['', null, '   ', '123', 'entoloma?', '*** Utdatert versjon ***', 'NBIC:53482']) {
    assert.deepEqual(
      providerNameToIdentificationColumns(value), [null, null], String(value),
    )
  }
  // A real binomial is untouched by the genus-token branch.
  assert.deepEqual(
    providerNameToIdentificationColumns('Entoloma conferendum'),
    ['Entoloma', 'conferendum'],
  )
})

test('an absent candidate name never clears an existing identification', () => {
  for (const prediction of [
    { scientificName: null, taxonId: 'NBIC:53482' },
    { scientificName: '', taxonId: 'NBIC:53482' },
    { taxonId: 'NBIC:53482' },
  ]) {
    const patch = buildDetailAiSelectionPatch(_artsorakelSelection(prediction), IDENTIFIED_OBS)
    assert.equal('genus' in patch, false)
    assert.equal('species' in patch, false)
    assert.equal('common_name' in patch, false)
  }
})

test('an identification is replaced as a coherent unit, never merged', () => {
  // The defect this replaced: merging field by field manufactured taxa that
  // do not exist. Existing `Amanita muscaria` / `Fly agaric` plus a provider
  // result named only `Entoloma` produced `Entoloma muscaria` / `Fly agaric`.
  // A missing component must never be inherited from a DIFFERENT taxon.
  const existing = { id: 1, genus: 'Amanita', species: 'muscaria', common_name: 'Fly agaric' }

  // Existing species -> genus-only replacement.
  const genusOnly = buildDetailAiSelectionPatch(
    _artsorakelSelection({ scientificName: 'Entoloma', taxonId: 'NBIC:53482' }),
    existing,
  )
  assert.equal(genusOnly.genus, 'Entoloma')
  assert.equal(genusOnly.species, null, 'muscaria must not survive onto Entoloma')
  assert.equal(genusOnly.common_name, null, 'Fly agaric must not survive onto Entoloma')

  // Different species, provider has no vernacular.
  const differentSpecies = buildDetailAiSelectionPatch(
    _artsorakelSelection({ scientificName: 'Entoloma conferendum', taxonId: 'NBIC:53482' }),
    existing,
  )
  assert.equal(differentSpecies.genus, 'Entoloma')
  assert.equal(differentSpecies.species, 'conferendum')
  assert.equal(
    differentSpecies.common_name, null,
    "Amanita's vernacular must not be carried onto Entoloma conferendum",
  )
})

test('a usable provider name is written, which is the whole point', () => {
  // Required regression 6: `Entoloma conferendum` selected from an Artsorakel
  // result saves non-null genus and species.
  const patch = buildDetailAiSelectionPatch(
    _artsorakelSelection({
      scientificName: 'Entoloma conferendum',
      vernacularName: 'stjernesporet rødspore',
      taxonId: 'NBIC:53482',
    }),
    { id: 917, genus: null, species: null, common_name: null },
  )
  assert.equal(patch.genus, 'Entoloma')
  assert.equal(patch.species, 'conferendum')
  assert.equal(patch.common_name, 'stjernesporet rødspore')
})

test('a first-time selection may still write an explicit null', () => {
  // There is nothing to protect on an unidentified observation, so a field
  // the provider omitted is written as null rather than being withheld.
  // Absence and clearing stay distinguishable: the guard only refuses to
  // OVERWRITE a value that exists.
  const patch = buildDetailAiSelectionPatch(
    _artsorakelSelection({ scientificName: '???', taxonId: 'NBIC:53482' }),
    { id: 918, genus: null, species: null, common_name: '' },
  )
  assert.equal(patch.genus, null)
  assert.equal(patch.species, null)
  assert.equal(patch.common_name, null)
})

test('a selection with no prediction produces no patch at all', () => {
  assert.equal(buildDetailAiSelectionPatch({}, IDENTIFIED_OBS), null)
  assert.equal(buildDetailAiSelectionPatch({ selectedService: 'artsorakel' }, IDENTIFIED_OBS), null)
})

test('the guard works with no existing observation supplied', () => {
  // Defensive: a caller that cannot supply the current row must not crash,
  // and must not be able to withhold fields it has no basis to withhold.
  const patch = buildDetailAiSelectionPatch(
    _artsorakelSelection({ scientificName: '???', taxonId: 'NBIC:53482' }),
  )
  assert.equal(patch.genus, null)
  assert.equal(patch.species, null)
})

test('the shared helper is what both save paths use', () => {
  // The ordinary Save button builds its identification columns through this
  // same helper, so a provider candidate cannot erase — or chimerise — an
  // identification via that second route either.
  const patch = {}
  applyIdentificationCoherently(
    patch,
    { genus: null, species: null, common_name: null },
    IDENTIFIED_OBS,
  )
  assert.deepEqual(patch, {}, 'nothing usable proposed -> nothing touched')

  const replaced = {}
  applyIdentificationCoherently(
    replaced,
    { genus: 'Entoloma', species: null, common_name: null },
    { id: 1, genus: 'Amanita', species: 'muscaria', common_name: 'Fly agaric' },
  )
  assert.deepEqual(
    replaced, { genus: 'Entoloma', species: null, common_name: null },
    'a usable name replaces all three together',
  )

  const fresh = {}
  applyIdentificationCoherently(
    fresh,
    { genus: 'Entoloma', species: null, common_name: null },
    { genus: null, species: null, common_name: null },
  )
  assert.deepEqual(fresh, { genus: 'Entoloma', species: null, common_name: null })
})
