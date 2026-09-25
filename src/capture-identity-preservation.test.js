/**
 * Taxonomy-v2 closeout Stage 2 Part B — the capture path preserves identity.
 *
 * The identity boundary has to hold everywhere, and capture is the PRIMARY
 * route for a new Artsorakel-identified observation — the shape of the
 * reported incident. Two defects broke it there:
 *
 *   1. `src/screens/review.js` built the selected taxon from a clicked
 *      prediction WITHOUT `pred.taxonId`, so
 *      `_buildReviewObservationPayload`'s `taxonomySelectionForTaxon` produced
 *      no external selection at all. `NBIC:53482` survived only as
 *      `ai_selected_taxon_id` history and was never offered to resolution.
 *   2. Even with the identifier carried, the queue sent the selection to
 *      `persistObservationTaxonomySelection`, which returns `false` for an
 *      unresolved external selection WITHOUT persisting its tuple — and the
 *      queue ignored that result.
 *
 * These cover the click → queued selection → save → reload chain.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY,
  QUEUED_TAXONOMY_SELECTION_KEY,
  TAXONOMY_IDENTITY_CAPABILITY,
  persistObservationIdentification,
  takeQueuedTaxonomySelection,
  taxonomySelectionForTaxon,
  taxonomySelectionFromObservationRow,
} from './taxonomy-v2.js'

/** Exactly the object `review.js` now builds when a result is clicked. */
function capturedTaxonFromPrediction(pred) {
  const parts = (pred.scientificName || '').split(/\s+/)
  return {
    genus: parts[0] || '',
    specificEpithet: parts[1] || '',
    vernacularName: pred.vernacularName || null,
    scientificName: pred.scientificName || null,
    displayName: pred.displayName,
    taxonId: pred.taxonId || null,
    providerCandidate: true,
  }
}

const ENTOLOMA = {
  service: 'artsorakel',
  taxonId: 'NBIC:53482',
  scientificName: 'Entoloma conferendum',
  vernacularName: 'stjernesporet rødspore',
  displayName: 'stjernesporet rødspore (Entoloma conferendum)',
}

test('clicking a capture result yields a selection that carries the identifier', () => {
  const taxon = capturedTaxonFromPrediction(ENTOLOMA)
  // The regression: this used to be null because `taxonId` was never copied.
  const selection = taxonomySelectionForTaxon(taxon)
  assert.ok(selection, 'a clicked provider result must produce a selection')
  assert.equal(selection.capability, EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(selection.sourceSystem, 'nortaxa')
  assert.equal(selection.namespace, 'nortaxa_taxon_id')
  assert.equal(selection.externalId, '53482')
  assert.equal(selection.rawExternalId, 'NBIC:53482')
  // The name still reaches the observation payload independently.
  assert.equal(taxon.genus, 'Entoloma')
  assert.equal(taxon.specificEpithet, 'conferendum')
})

test('the selection survives the queue envelope', () => {
  const selection = taxonomySelectionForTaxon(capturedTaxonFromPrediction(ENTOLOMA))
  const queued = {
    genus: 'Entoloma',
    species: 'conferendum',
    [QUEUED_TAXONOMY_SELECTION_KEY]: selection,
  }
  const { databasePayload, selection: extracted } = takeQueuedTaxonomySelection(queued)
  assert.deepEqual(extracted, selection)
  // The selection is client metadata and never leaks into provider columns.
  assert.equal(databasePayload[QUEUED_TAXONOMY_SELECTION_KEY], undefined)
  assert.equal(databasePayload.taxon_identity_state, undefined)
})

test('the queue persists the unresolved tuple instead of dropping it', async () => {
  // What the queue now does when resolution finds nothing: write identity and
  // provenance together, with the name left alone (the INSERT already wrote
  // it, and name-without-binding is a coherent state).
  const calls = []
  const client = {
    rpc: async (name, args) => { calls.push({ name, args }); return { error: null } },
  }
  const selection = taxonomySelectionForTaxon(capturedTaxonFromPrediction(ENTOLOMA))

  const result = await persistObservationIdentification(4242, {
    selection, writeName: false,
  }, { supabaseClient: client })

  assert.equal(result.applied, true)
  assert.equal(calls.length, 1)
  const { name, args } = calls[0]
  assert.equal(name, 'set_observation_identification_v2')
  assert.equal(args.p_sporely_taxon_id, null)
  assert.equal(args.p_identity_state, 'external_unresolved')
  assert.equal(args.p_source_system, 'nortaxa')
  assert.equal(args.p_namespace, 'nortaxa_taxon_id')
  assert.equal(args.p_external_id, '53482')
  assert.equal(args.p_raw_external_id, 'NBIC:53482')
  assert.equal(args.p_write_name, false, 'the queued INSERT already wrote the name')
})

test('a captured NBIC identity round-trips through save and reload', () => {
  const selection = taxonomySelectionForTaxon(capturedTaxonFromPrediction(ENTOLOMA))
  // The row as the queue leaves it: name from the INSERT, identity from the
  // atomic writer.
  const row = {
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
  const restored = taxonomySelectionFromObservationRow(row)
  assert.equal(restored.capability, EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(restored.externalId, '53482')
  assert.equal(restored.rawExternalId, 'NBIC:53482')
  assert.equal(restored.sporelyTaxonId, null)
})

test('a resolved capture binds the reviewed concept', async () => {
  // Once Stage 3 restores the bridge, the same captured selection resolves and
  // the atomic writer binds it — with the source tuple retained for audit.
  const calls = []
  const client = {
    rpc: async (name, args) => { calls.push({ name, args }); return { error: null } },
  }
  const selection = taxonomySelectionForTaxon(capturedTaxonFromPrediction(ENTOLOMA))
  const resolved = { ...selection, capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821' }

  await persistObservationIdentification(4242, { selection: resolved, writeName: false }, {
    supabaseClient: client,
  })
  const { args } = calls[0]
  assert.equal(args.p_sporely_taxon_id, '7821')
  assert.equal(args.p_identity_state, 'sporely_v2')
  assert.equal(args.p_external_id, '53482', 'the source tuple stays auditable')
})

test('a native capture selection is unaffected', () => {
  // Capture can also carry a native v2 pick; that must still be a proven
  // Sporely selection, not reinterpreted as a provider candidate.
  const native = {
    identityCapability: TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: '167',
    genus: 'Crystallocystidium',
    specificEpithet: 'albescens',
  }
  assert.deepEqual(taxonomySelectionForTaxon(native), {
    capability: TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: '167',
  })
})
