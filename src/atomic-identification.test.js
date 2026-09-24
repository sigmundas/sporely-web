/**
 * Taxonomy-v2 closeout Stage 2 Part B — the identification is ONE write.
 *
 * An observation's identification is three things that must agree: the bound
 * concept, its provenance, and the accepted name. Writing them in separate
 * statements leaves a boundary at every join where the row can describe one
 * taxon by name and another by identity, and no client-side ordering fixes
 * that:
 *
 *   * identity first  -> a bound concept beside the OLD name if the name write fails;
 *   * name first      -> the NEW name beside the old concept if the RPC rejects;
 *   * compensation    -> itself a write that can fail, so the split is merely
 *                        narrowed and, worse, can go unreported.
 *
 * Two concrete failures were reproduced against the compensating design before
 * it was replaced:
 *
 *   * `commitIdentificationTransaction` awaited its identity step as if it
 *     were atomic, but that step bound through the RPC and THEN wrote
 *     provenance; a provenance failure left `{bound:"B", rolledBack:false}`;
 *   * the AI save path did not use the helper at all.
 *
 * `set_observation_identification_v2` writes all of it in a single statement,
 * so these states are unreachable rather than compensated. These tests pin
 * that the client actually uses one call and never splits the coupled set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TAXONOMY_IDENTITY_CAPABILITY,
  externalTaxonomySelectionForCandidate,
  persistObservationIdentification,
} from './taxonomy-v2.js'

function stubClient(behaviour = () => ({ error: null })) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => { calls.push({ name, args }); return behaviour(name, args) },
  }
}

const NATIVE = { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821' }

test('the whole coupled identification travels in ONE rpc call', async () => {
  const client = stubClient()
  const result = await persistObservationIdentification(917, {
    selection: NATIVE,
    writeName: true,
    genus: 'Entoloma',
    species: 'conferendum',
    commonName: 'stjernesporet rødspore',
  }, { supabaseClient: client })

  assert.equal(result.applied, true)
  assert.equal(client.calls.length, 1, 'more than one write is a split waiting to happen')
  const { name, args } = client.calls[0]
  assert.equal(name, 'set_observation_identification_v2')
  // Identity, provenance and name are all arguments of the same call.
  assert.equal(args.p_observation_id, 917)
  assert.equal(args.p_sporely_taxon_id, '7821')
  assert.equal(args.p_identity_state, 'sporely_v2')
  assert.equal(args.p_write_name, true)
  assert.equal(args.p_genus, 'Entoloma')
  assert.equal(args.p_species, 'conferendum')
  assert.equal(args.p_common_name, 'stjernesporet rødspore')
})

test('an unresolved external identity carries its tuple and no bound concept', async () => {
  const client = stubClient()
  const selection = externalTaxonomySelectionForCandidate({
    taxonId: 'NBIC:53482', scientificName: 'Entoloma conferendum',
  })
  await persistObservationIdentification(917, {
    selection,
    writeName: true,
    genus: 'Entoloma',
    species: 'conferendum',
    commonName: null,
  }, { supabaseClient: client })

  const { args } = client.calls[0]
  assert.equal(args.p_sporely_taxon_id, null, 'an unresolved identifier is not a binding')
  assert.equal(args.p_identity_state, 'external_unresolved')
  assert.equal(args.p_source_system, 'nortaxa')
  assert.equal(args.p_namespace, 'nortaxa_taxon_id')
  assert.equal(args.p_external_id, '53482')
  assert.equal(args.p_raw_external_id, 'NBIC:53482')
  // ...and the name goes with it, in the same statement.
  assert.equal(args.p_genus, 'Entoloma')
  assert.equal(args.p_species, 'conferendum')
})

test('a rejected candidate leaves the name alone in the same call', async () => {
  // `p_write_name = false` makes the database keep the existing name, so there
  // is no separate "don't touch the name" client branch that could drift.
  const client = stubClient()
  await persistObservationIdentification(917, {
    selection: null, writeName: false,
  }, { supabaseClient: client })
  const { args } = client.calls[0]
  assert.equal(args.p_write_name, false)
  assert.equal(args.p_identity_state, null)
  assert.equal(args.p_sporely_taxon_id, null)
})

test('a missing function is reported as unavailable, not as success', async () => {
  // The migration may not be deployed yet; the caller falls back rather than
  // silently believing the identification was written.
  for (const error of [
    { code: 'PGRST202', message: 'function not found in schema cache' },
    { code: '42883', message: 'function set_observation_identification_v2 does not exist' },
  ]) {
    const client = stubClient(() => ({ error }))
    const result = await persistObservationIdentification(917, {
      selection: NATIVE, writeName: true, genus: 'Entoloma',
    }, { supabaseClient: client })
    assert.equal(result.applied, false)
    assert.equal(result.unavailable, true)
  }
})

test('a rejected identification throws — it never reports success', async () => {
  const client = stubClient(() => ({
    error: { code: '22023', message: 'sporely_taxon_id 4242 is missing from the active taxonomy-v2 release' },
  }))
  await assert.rejects(
    persistObservationIdentification(917, {
      selection: { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '4242' },
      writeName: true,
      genus: 'Entoloma',
    }, { supabaseClient: client }),
    // The Supabase client surfaces plain error objects, and this wrapper
    // rethrows them unchanged — matching `persistObservationTaxonomySelection`.
    error => error.code === '22023'
      && /missing from the active taxonomy-v2 release/.test(error.message),
  )
  // Exactly one attempt, and nothing else was written alongside it.
  assert.equal(client.calls.length, 1)
})

test('an ownership rejection also throws rather than degrading', async () => {
  const client = stubClient(() => ({
    error: { code: '42501', message: 'observation not found or caller does not own it' },
  }))
  await assert.rejects(
    persistObservationIdentification(917, { selection: NATIVE, writeName: true }, { supabaseClient: client }),
    error => error.code === '42501' && /does not own it/.test(error.message),
  )
})

// ── Fail closed when the atomic writer is unavailable ─────────────────────

test('an unavailable writer performs NO legacy identity write and NO name write', async () => {
  // The blocker this replaced: the client fell back to
  // `set_observation_selected_taxon_v2` and then let the caller write the name
  // separately — the exact split the atomic RPC exists to remove. A failing
  // second write left the new identity beside the old name, and for an
  // unresolved selection the fallback cleared the binding while never
  // persisting the (source_system, namespace, external_id) tuple.
  //
  // There is no safe partial application, so the only correct behaviour is to
  // refuse and leave the observation exactly as it was.
  const { IdentificationUnavailableError } = await import('./screens/find_detail.js')

  for (const selection of [
    { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821' },
    externalTaxonomySelectionForCandidate({ taxonId: 'NBIC:53482' }),
    null,
  ]) {
    const client = stubClient(() => ({
      error: { code: 'PGRST202', message: 'function not found in schema cache' },
    }))
    const result = await persistObservationIdentification(917, {
      selection, writeName: true, genus: 'Entoloma', species: 'conferendum',
    }, { supabaseClient: client })

    assert.equal(result.applied, false)
    assert.equal(result.unavailable, true)
    // Only the atomic attempt was made. Crucially NOT the legacy identity RPC.
    assert.deepEqual(
      client.calls.map(call => call.name),
      ['set_observation_identification_v2'],
      'the legacy selected-taxon RPC must never be used as a fallback',
    )
    assert.equal(
      client.calls.some(call => call.name === 'set_observation_selected_taxon_v2'),
      false,
    )
  }

  assert.equal(typeof IdentificationUnavailableError, 'function')
  const refusal = new IdentificationUnavailableError()
  assert.equal(refusal.identificationUnavailable, true)
  assert.match(refusal.message, /left unchanged/)
})

test('"no function" is never treated as "no provenance columns"', async () => {
  // The fallback's stated justification was that a missing function implies
  // missing columns. It does not: the columns land in 20260922120000 and the
  // function in 20260922140000, and PostgREST's schema cache can lag a
  // deployed function. So nothing about column availability may be inferred,
  // and the client must not write a reduced "identity-only" shape.
  const client = stubClient(() => ({
    error: { code: 'PGRST202', message: 'function not found in schema cache' },
  }))
  const selection = externalTaxonomySelectionForCandidate({ taxonId: 'NBIC:53482' })
  const result = await persistObservationIdentification(917, {
    selection, writeName: true, genus: 'Entoloma', species: 'conferendum',
  }, { supabaseClient: client })

  assert.equal(result.unavailable, true)
  // No degraded write of any shape was attempted.
  assert.equal(client.calls.length, 1)
  assert.equal(result.columns, undefined, 'nothing is reported as persisted')
})
