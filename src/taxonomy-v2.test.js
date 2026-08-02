import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEGACY_TAXONOMY_IDENTITY_CAPABILITY,
  QUEUED_TAXONOMY_SELECTION_KEY,
  TAXONOMY_IDENTITY_CAPABILITY,
  normalizeTaxonomyV2Result,
  persistObservationTaxonomySelection,
  searchTaxaV2,
  takeQueuedTaxonomySelection,
  taxonomySelectionForTaxon,
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
  const results = await searchTaxaV2('Crystallocystidium', 'nb-NO', { supabaseClient: client })
  assert.equal(calls[0].name, 'search_taxa_v2')
  assert.equal(calls[0].args.lang, 'no')
  assert.deepEqual(results.map(result => result.matchType), ['canonical_exact', 'canonical_prefix', 'scientific_alias_exact', 'vernacular_exact', 'scientific_alias_exact'])
  assert.equal(results[1].specificEpithet, null)
  assert.equal(results[4].nortaxaTaxonId, '56449')
})

test('empty result never falls back and unavailable RPC fallback is capability-separated', async () => {
  const emptyCalls = []
  const emptyClient = { rpc: async name => { emptyCalls.push(name); return { data: [], error: null } } }
  assert.deepEqual(await searchTaxaV2('zzzz-no-result', 'no', { supabaseClient: emptyClient }), [])
  assert.deepEqual(emptyCalls, ['search_taxa_v2'])

  const calls = []
  const client = { rpc: async name => {
    calls.push(name)
    if (name === 'search_taxa_v2') return { data: null, error: { code: 'PGRST202', message: 'function not found in schema cache' } }
    return { data: [{ taxon_id: 44, genus: 'Legacy', specific_epithet: 'taxon', norwegian_taxon_id: 99 }], error: null }
  } }
  const [result] = await searchTaxaV2('Legacy', 'no', { supabaseClient: client })
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

test('manual free text and provider predictions do not manufacture canonical identity', () => {
  assert.equal(taxonomySelectionForTaxon({ manualEntry: true, scientificName: 'Unknown fungus' }), null)
  assert.equal(taxonomySelectionForTaxon({ taxonId: 'NBIC:56449', scientificName: 'Amanita muscaria' }), null)
})

test('persistence uses only the narrow taxonomy selection RPC', async () => {
  const calls = []
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { error: null } } }
  await persistObservationTaxonomySelection(123, { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '167' }, { supabaseClient: client })
  assert.deepEqual(calls, [{ name: 'set_observation_selected_taxon_v2', args: { p_observation_id: 123, p_sporely_taxon_id: '167' } }])
})
