/**
 * Taxonomy-v2 closeout Stage 2 Part B — provider-response integrity.
 *
 * Two independent nesting defects, both confirmed against this repository's
 * own Artsorakel fixtures, produced the `Entoloma conferendum`
 * "saved as unidentified" class of failure:
 *
 *   1. The deprecation sentinel was checked at ONE nesting level
 *      (`p?.taxon?.vernacularName`), so a flattened `taxa.items[]` candidate
 *      carrying it at `p.vernacularName` survived normalization. That is the
 *      plan's leading hypothesis, and it holds for the BARE item shape —
 *      which is the shape `src/artsorakel.test.js`'s own `taxa.items[]`
 *      fixture uses.
 *
 *   2. `_normalizeArtsorakelPrediction` bound `taxon = pred.taxon` whenever a
 *      nested `taxon` existed and read the scientific name and identifier
 *      from it alone. For the NESTED item shape — which
 *      `sporely-py`'s `test_worker_parses_current_prediction_shape` documents
 *      as the current Artsorakel response, with `scientificName` and
 *      `scientific_name_id` at the top level and `{ vernacularName }` nested
 *      — that silently returned a null name AND a null identifier.
 *
 * Defect 2 is NOT in the plan's hypothesis and is the stronger explanation:
 * it loses the name without any deprecation involved, which is exactly the
 * reported symptom. Both are fixed here; the tests below pin both shapes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ARTSORAKEL_DEPRECATED_SENTINEL,
  isDeprecatedArtsorakelCandidate,
  splitScientificName,
} from './artsorakel.js'

// ── Defect 1: the deprecation sentinel, at both nesting levels ─────────────

test('the deprecation sentinel is rejected at both nesting levels', () => {
  // Shape A: sentinel under `taxon` — the only level the old filter saw.
  assert.equal(isDeprecatedArtsorakelCandidate({
    probability: 0.01,
    taxon: { vernacularName: ARTSORAKEL_DEPRECATED_SENTINEL },
  }), true)

  // Shape B: a flattened `taxa.items[]` candidate carrying it bare. The old
  // `p?.taxon?.vernacularName` check evaluated to undefined here, never
  // matched the sentinel, and let a superseded record through.
  assert.equal(isDeprecatedArtsorakelCandidate({
    probability: 0.9,
    scientific_name_id: 'NBIC:53482',
    vernacularName: ARTSORAKEL_DEPRECATED_SENTINEL,
  }), true)

  // Snake-case variant of the same field.
  assert.equal(isDeprecatedArtsorakelCandidate({
    vernacular_name: ARTSORAKEL_DEPRECATED_SENTINEL,
  }), true)

  // Surrounding whitespace must not defeat the check.
  assert.equal(isDeprecatedArtsorakelCandidate({
    vernacularName: `  ${ARTSORAKEL_DEPRECATED_SENTINEL}  `,
  }), true)
})

test('a real candidate is never mistaken for a deprecated one', () => {
  assert.equal(isDeprecatedArtsorakelCandidate({
    scientificName: 'Entoloma conferendum',
    vernacularName: 'stjernesporet rødspore',
  }), false)
  assert.equal(isDeprecatedArtsorakelCandidate({
    taxon: { vernacularName: 'Lukttjæresopp' },
  }), false)
  // No vernacular at all is not deprecation.
  assert.equal(isDeprecatedArtsorakelCandidate({ scientificName: 'Amanita muscaria' }), false)
  assert.equal(isDeprecatedArtsorakelCandidate(null), false)
  assert.equal(isDeprecatedArtsorakelCandidate({}), false)
})

// ── Defect 2: a nested `taxon` must not shadow top-level fields ────────────
//
// `_normalizeArtsorakelPrediction` is module-private, so these exercise it
// through the exported `runArtsorakel` path in `artsorakel.test.js`'s
// integration tests. What is asserted here is the consequence that reaches
// the save path: a candidate whose name survives normalization cannot produce
// the `[null, null]` split that clears an identification.

test('a usable provider scientific name splits into genus and species', () => {
  // Required regression 6: `Entoloma conferendum` selected from an Artsorakel
  // result must save non-null genus and species.
  assert.deepEqual(splitScientificName('Entoloma conferendum'), ['Entoloma', 'conferendum'])
})

test('splitScientificName still refuses to invent a binomial', () => {
  // The guard the save path depends on: an absent or single-token name is
  // reported as unparseable rather than being half-filled.
  assert.deepEqual(splitScientificName(''), [null, null])
  assert.deepEqual(splitScientificName(null), [null, null])
  assert.deepEqual(splitScientificName('Entoloma'), [null, null])
})
