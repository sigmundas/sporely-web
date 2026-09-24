import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY,
  LEGACY_TAXONOMY_IDENTITY_CAPABILITY,
  QUEUED_TAXONOMY_SELECTION_KEY,
  TAXONOMY_IDENTITY_CAPABILITY,
  bridgePrefixedExternalId,
  externalTaxonomySelectionForCandidate,
  normalizeTaxonomyV2Result,
  parsePrefixedExternalId,
  persistObservationTaxonomySelection,
  resolveExternalTaxonomySelection,
  searchTaxaV2,
  takeQueuedTaxonomySelection,
  taxonIdentityPatchForSelection,
  taxonomySelectionForTaxon,
  taxonomySelectionFromObservationRow,
} from './taxonomy-v2.js'

const COL_ONLY_ROW = {
  taxon_id: 167, parent_taxon_id: 166, taxon_rank: 'species',
  genus: 'Crystallocystidium', specific_epithet: 'albescens',
  canonical_scientific_name: 'Crystallocystidium albescens', family: 'Stereaceae',
  vernacular_name: null, vernacular_language: null,
  canonical_source_system: 'col_xr', canonical_external_id: '323XQ',
  col_usage_id: '323XQ', nortaxa_taxon_id: null,
  matched_name: 'Crystallocystidium albescens', matched_language: 'sci', match_type: 'canonical_exact',
}

test('taxonomy-v2 normalization keeps Sporely, COL and NorTaxa namespaces separate', () => {
  const result = normalizeTaxonomyV2Result(COL_ONLY_ROW)
  assert.equal(result.identityCapability, TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(result.sporelyTaxonId, '167')
  assert.equal(result.colUsageId, '323XQ')
  assert.equal(result.nortaxaTaxonId, null)
  assert.equal(result.norwegianTaxonId, undefined)
  assert.equal(result.taxonId, undefined)
  assert.equal(result.displayName, 'Crystallocystidium albescens')
})

test('search normalizes canonical, alias, genus, vernacular and NorTaxa-backed results', async () => {
  const rows = [
    COL_ONLY_ROW,
    { ...COL_ONLY_ROW, taxon_id: 168, taxon_rank: 'genus', specific_epithet: '', canonical_scientific_name: 'Crystallocystidium', match_type: 'canonical_prefix' },
    { ...COL_ONLY_ROW, taxon_id: 169, matched_name: 'Ustilago maydis', match_type: 'scientific_alias_exact' },
    { ...COL_ONLY_ROW, taxon_id: 170, vernacular_name: 'grå torvvokssopp', vernacular_language: 'nb', matched_name: 'grå torvvokssopp', matched_language: 'nb', match_type: 'vernacular_exact' },
    { ...COL_ONLY_ROW, taxon_id: 171, nortaxa_taxon_id: '56449', matched_name: 'NorTaxa name', match_type: 'scientific_alias_exact' },
  ]
  const calls = []
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: rows, error: null } } }
  const results = await searchTaxaV2('Crystallocystidium', 'nb-NO', { supabaseClient: client, bypassCapabilityGate: true })
  assert.equal(calls[0].name, 'search_taxa_v2')
  assert.equal(calls[0].args.lang, 'no')
  assert.deepEqual(results.map(result => result.matchType), ['canonical_exact', 'canonical_prefix', 'scientific_alias_exact', 'vernacular_exact', 'scientific_alias_exact'])
  assert.equal(results[1].specificEpithet, null)
  assert.equal(results[4].nortaxaTaxonId, '56449')
})

test('empty result never falls back and unavailable RPC fallback is capability-separated', async () => {
  const emptyCalls = []
  const emptyClient = { rpc: async name => { emptyCalls.push(name); return { data: [], error: null } } }
  assert.deepEqual(await searchTaxaV2('zzzz-no-result', 'no', { supabaseClient: emptyClient, bypassCapabilityGate: true }), [])
  assert.deepEqual(emptyCalls, ['search_taxa_v2'])

  const calls = []
  const client = { rpc: async name => {
    calls.push(name)
    if (name === 'search_taxa_v2') return { data: null, error: { code: 'PGRST202', message: 'function not found in schema cache' } }
    return { data: [{ taxon_id: 44, genus: 'Legacy', specific_epithet: 'taxon', norwegian_taxon_id: 99 }], error: null }
  } }
  const [result] = await searchTaxaV2('Legacy', 'no', { supabaseClient: client, bypassCapabilityGate: true })
  assert.deepEqual(calls, ['search_taxa_v2', 'search_taxa'])
  assert.equal(result.identityCapability, LEGACY_TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(result.sporelyTaxonId, undefined)
  assert.equal(result.legacyTaxonId, '44')
  assert.equal(result.norwegianTaxonId, '99')
})

test('COL-only and genus selections are queued as client metadata, never provider fields', () => {
  for (const row of [COL_ONLY_ROW, { ...COL_ONLY_ROW, taxon_rank: 'genus', specific_epithet: '', canonical_scientific_name: 'Crystallocystidium' }]) {
    const taxon = normalizeTaxonomyV2Result(row)
    const selection = taxonomySelectionForTaxon(taxon)
    const queued = { genus: taxon.genus, species: taxon.specificEpithet, [QUEUED_TAXONOMY_SELECTION_KEY]: selection }
    const { databasePayload, selection: extracted } = takeQueuedTaxonomySelection(queued)
    assert.deepEqual(extracted, { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '167' })
    assert.equal(databasePayload[QUEUED_TAXONOMY_SELECTION_KEY], undefined)
    assert.equal(databasePayload.artsdata_id, undefined)
    assert.equal(databasePayload.norwegian_taxon_id, undefined)
  }
})

test('manual free text does not manufacture canonical identity', () => {
  assert.equal(taxonomySelectionForTaxon({ manualEntry: true, scientificName: 'Unknown fungus' }), null)
  // A bare integer has no registry behind it, so it cannot become a selection.
  assert.equal(taxonomySelectionForTaxon({ taxonId: '56449', scientificName: 'Amanita muscaria' }), null)
})

test('an Artsorakel NBIC: identifier is preserved instead of being discarded', () => {
  // EXPECTATION FLIP — taxonomy-v2 closeout Stage 2 Part B.
  //
  // This assertion used to read:
  //   assert.equal(taxonomySelectionForTaxon({ taxonId: 'NBIC:56449', ... }), null)
  // which encoded the broken contract: the client held a namespaced external
  // identifier, never parsed it, and silently discarded the identity instead
  // of preserving it. Because nothing was preserved, nothing was ever offered
  // to `resolve_taxon_external_id_v2`.
  //
  // Part B preserves the identifier. Stage 3 restores the NorTaxa bridge in
  // the release so the same tuple RESOLVES; at that point the assertion below
  // is superseded by
  // `resolveExternalTaxonomySelection` returning a proven Sporely selection
  // for `(nortaxa, nortaxa_taxon_id, 53482)` against the real release — see
  // the resolver tests further down, which already exercise both outcomes
  // against a stubbed RPC.
  const selection = taxonomySelectionForTaxon({
    taxonId: 'NBIC:56449', scientificName: 'Amanita muscaria',
  })
  assert.equal(selection.capability, EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(selection.sporelyTaxonId, null)
  assert.equal(selection.sourceSystem, 'nortaxa')
  assert.equal(selection.namespace, 'nortaxa_taxon_id')
  assert.equal(selection.externalId, '56449')
  assert.equal(selection.rawExternalId, 'NBIC:56449')
  assert.equal(selection.scientificName, 'Amanita muscaria')
})

test('a v2 search result still wins over provider-candidate parsing', () => {
  const taxon = normalizeTaxonomyV2Result(COL_ONLY_ROW)
  assert.deepEqual(taxonomySelectionForTaxon(taxon), {
    capability: TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: '167',
  })
})

test('NBIC: parses into its own namespace and keeps the raw value', () => {
  const parsed = parsePrefixedExternalId('NBIC:53482')
  // identity-contract.md: an Artsorakel NBIC: id identifies a scientific NAME.
  assert.equal(parsed.sourceSystem, 'artsorakel')
  assert.equal(parsed.namespace, 'nbic_scientific_name_id')
  assert.equal(parsed.localId, '53482')
  assert.equal(parsed.raw, 'NBIC:53482')

  const bridged = bridgePrefixedExternalId(parsed)
  assert.equal(bridged.sourceSystem, 'nortaxa')
  assert.equal(bridged.namespace, 'nortaxa_taxon_id')
  assert.equal(bridged.localId, '53482')
  // The verbatim provider value survives the bridge.
  assert.equal(bridged.raw, 'NBIC:53482')
  // Never the other Artsdatabanken registry: numeric equality there is
  // coincidence, not identity.
  assert.notEqual(bridged.namespace, 'artsdatabanken_taxon_concept_id')
})

test('a namespace-lost or unknown identifier is never parsed', () => {
  for (const value of ['53482', '', null, undefined, '   ', 'ZZZZ:53482', 'NBIC:']) {
    assert.equal(parsePrefixedExternalId(value), null, String(value))
  }
})

test('resolution binds only on a single unambiguous match', async () => {
  const selection = externalTaxonomySelectionForCandidate({
    taxonId: 'NBIC:53482', scientificName: 'Entoloma conferendum',
  })

  // Single match → proven Sporely identity, source tuple retained.
  const calls = []
  const ok = { rpc: async (name, args) => { calls.push({ name, args }); return { data: [{ taxon_id: 7821 }], error: null } } }
  const resolved = await resolveExternalTaxonomySelection(selection, {
    supabaseClient: ok, bypassCapabilityGate: true,
  })
  assert.deepEqual(calls, [{
    name: 'resolve_taxon_external_id_v2',
    args: {
      p_source_system: 'nortaxa',
      p_namespace: 'nortaxa_taxon_id',
      p_external_id: '53482',
    },
  }])
  assert.equal(resolved.capability, TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(resolved.sporelyTaxonId, '7821')
  assert.equal(resolved.externalId, '53482')
  assert.equal(resolved.rawExternalId, 'NBIC:53482')

  // Empty result → unchanged. This is today's production behaviour: the
  // active release carries zero nortaxa_taxon_id mappings, so the identifier
  // stays preserved-but-unresolved rather than being discarded.
  const empty = { rpc: async () => ({ data: [], error: null }) }
  assert.deepEqual(
    await resolveExternalTaxonomySelection(selection, { supabaseClient: empty, bypassCapabilityGate: true }),
    selection,
  )

  // Ambiguity is never collapsed.
  const ambiguous = { rpc: async () => ({ data: [{ taxon_id: 7821 }, { taxon_id: 9999 }], error: null }) }
  assert.deepEqual(
    await resolveExternalTaxonomySelection(selection, { supabaseClient: ambiguous, bypassCapabilityGate: true }),
    selection,
  )

  // An RPC error must not destroy the source evidence either.
  const failing = { rpc: async () => ({ data: null, error: { code: '42883', message: 'no function' } }) }
  assert.deepEqual(
    await resolveExternalTaxonomySelection(selection, { supabaseClient: failing, bypassCapabilityGate: true }),
    selection,
  )
})

test('an unresolved external identity is never sent to the selected-taxon RPC', async () => {
  const calls = []
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { error: null } } }
  const selection = externalTaxonomySelectionForCandidate({ taxonId: 'NBIC:53482' })

  // Not sent at all — not even as null, which would clear an existing cloud
  // selection on the strength of a failed resolution.
  assert.equal(
    await persistObservationTaxonomySelection(321, selection, { supabaseClient: client }),
    false,
  )
  assert.deepEqual(calls, [])
})

test('identity provenance columns describe resolved and unresolved selections', () => {
  const external = externalTaxonomySelectionForCandidate({ taxonId: 'NBIC:53482' })
  assert.deepEqual(taxonIdentityPatchForSelection(external), {
    taxon_identity_state: 'external_unresolved',
    taxon_identity_source_system: 'nortaxa',
    taxon_identity_namespace: 'nortaxa_taxon_id',
    taxon_identity_external_id: '53482',
    taxon_identity_raw_external_id: 'NBIC:53482',
  })

  const resolved = { ...external, capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821' }
  assert.deepEqual(taxonIdentityPatchForSelection(resolved), {
    taxon_identity_state: 'sporely_v2',
    taxon_identity_source_system: 'nortaxa',
    taxon_identity_namespace: 'nortaxa_taxon_id',
    taxon_identity_external_id: '53482',
    taxon_identity_raw_external_id: 'NBIC:53482',
  })

  // No selection → no patch, so provenance is never blanked by accident.
  assert.equal(taxonIdentityPatchForSelection(null), null)
  assert.equal(taxonIdentityPatchForSelection({ manualEntry: true }), null)
})

test('a preserved external identity round-trips through save and reload', () => {
  const external = externalTaxonomySelectionForCandidate({
    taxonId: 'NBIC:53482', scientificName: 'Entoloma conferendum',
  })
  // What the save path writes.
  const row = {
    genus: 'Entoloma',
    species: 'conferendum',
    ai_selected_scientific_name: 'Entoloma conferendum',
    selected_sporely_taxon_id: null,
    ...taxonIdentityPatchForSelection(external),
  }
  // What a reload reconstructs from it.
  const restored = taxonomySelectionFromObservationRow(row)
  assert.equal(restored.capability, EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(restored.sporelyTaxonId, null)
  assert.equal(restored.sourceSystem, 'nortaxa')
  assert.equal(restored.namespace, 'nortaxa_taxon_id')
  assert.equal(restored.externalId, '53482')
  assert.equal(restored.rawExternalId, 'NBIC:53482')
  assert.equal(restored.scientificName, 'Entoloma conferendum')

  // A resolved row restores as a proven Sporely selection.
  assert.deepEqual(
    taxonomySelectionFromObservationRow({
      selected_sporely_taxon_id: 7821, taxon_identity_state: 'sporely_v2',
    }),
    { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821' },
  )
  // A row with no identity at all restores as nothing.
  assert.equal(taxonomySelectionFromObservationRow({}), null)
  // An incomplete tuple is not a usable external identity.
  assert.equal(taxonomySelectionFromObservationRow({
    taxon_identity_state: 'external_unresolved',
    taxon_identity_source_system: 'nortaxa',
  }), null)
})

test('persistence uses only the narrow taxonomy selection RPC', async () => {
  const calls = []
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { error: null } } }
  await persistObservationTaxonomySelection(123, { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '167' }, { supabaseClient: client })
  assert.deepEqual(calls, [{ name: 'set_observation_selected_taxon_v2', args: { p_observation_id: 123, p_sporely_taxon_id: '167' } }])
})

test('the ordinary Save path preserves a clicked provider candidate', async () => {
  // Taxonomy-v2 closeout Stage 2 Part B, finding 3. The detail screen's AI
  // result click used to build `selectedTaxon` WITHOUT the provider's
  // identifier, so the ordinary Save button's
  // `taxonomySelectionForTaxon(selectedTaxon)` saw nothing, returned null,
  // and `persistObservationTaxonomySelection` then sent
  // `p_sporely_taxon_id: null` — clearing whatever identity the observation
  // already had, while also discarding the provider's own identifier.
  //
  // `selectedTaxon` now carries `taxonId`, so the same call yields a
  // preserved external selection.
  const selectedTaxon = {
    genus: 'Entoloma',
    specificEpithet: 'conferendum',
    vernacularName: 'stjernesporet rødspore',
    displayName: 'stjernesporet rødspore (Entoloma conferendum)',
    taxonId: 'NBIC:53482',
    scientificName: 'Entoloma conferendum',
    providerCandidate: true,
  }
  const selection = taxonomySelectionForTaxon(selectedTaxon)
  assert.equal(selection.capability, EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY)
  assert.equal(selection.externalId, '53482')
  assert.equal(selection.rawExternalId, 'NBIC:53482')

  // And that selection is never sent to the guarded RPC as null.
  const calls = []
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { error: null } } }
  assert.equal(
    await persistObservationTaxonomySelection(917, selection, { supabaseClient: client }),
    false,
  )
  assert.deepEqual(calls, [])

  // Save then reload round-trips the tuple.
  const row = {
    genus: 'Entoloma',
    species: 'conferendum',
    selected_sporely_taxon_id: null,
    ...taxonIdentityPatchForSelection(selection),
  }
  const restored = taxonomySelectionFromObservationRow(row)
  assert.equal(restored.externalId, '53482')
  assert.equal(restored.rawExternalId, 'NBIC:53482')
})

test('manual free text still clears identity explicitly', () => {
  // The clearing path must keep working: replacing the identification with
  // free text leaves no selection, and a null selection through the guarded
  // RPC is the intended, explicit way to drop a bound concept. Only a
  // provider candidate is protected from being read as a clear.
  assert.equal(taxonomySelectionForTaxon(null), null)
  assert.equal(taxonomySelectionForTaxon({
    genus: null, specificEpithet: 'some free text', displayName: 'some free text',
  }), null)
})
