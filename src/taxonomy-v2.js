import { supabase } from './supabase.js'

export const TAXONOMY_IDENTITY_CAPABILITY = 'sporely-taxonomy-v2'
export const LEGACY_TAXONOMY_IDENTITY_CAPABILITY = 'legacy-provider-taxonomy'
export const QUEUED_TAXONOMY_SELECTION_KEY = 'taxonomySelection'

function cleanText(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function cleanId(value) {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function normalizeSearchLanguage(value) {
  const raw = String(value || 'no').trim().toLowerCase().replace('-', '_')
  if (raw.startsWith('nb') || raw.startsWith('nn') || raw.startsWith('no')) return 'no'
  return raw.split('_')[0] || 'no'
}

function displayName(scientificName, vernacularName) {
  const scientific = cleanText(scientificName) || ''
  const vernacular = cleanText(vernacularName)
  if (vernacular && vernacular.toLowerCase() !== scientific.toLowerCase()) {
    return scientific ? `${vernacular} (${scientific})` : vernacular
  }
  return scientific || vernacular || ''
}

export function normalizeTaxonomyV2Result(row = {}) {
  const canonicalScientificName = cleanText(row.canonical_scientific_name)
    || [cleanText(row.genus), cleanText(row.specific_epithet)].filter(Boolean).join(' ')
  const vernacularName = cleanText(row.vernacular_name)
  return {
    identityCapability: TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: cleanId(row.taxon_id),
    parentSporelyTaxonId: cleanId(row.parent_taxon_id),
    taxonRank: cleanText(row.taxon_rank),
    genus: cleanText(row.genus),
    specificEpithet: cleanText(row.specific_epithet),
    canonicalScientificName,
    scientificName: canonicalScientificName,
    family: cleanText(row.family),
    vernacularName,
    vernacularLanguage: cleanText(row.vernacular_language),
    canonicalSourceSystem: cleanText(row.canonical_source_system),
    canonicalExternalId: cleanId(row.canonical_external_id),
    colUsageId: cleanId(row.col_usage_id),
    nortaxaTaxonId: cleanId(row.nortaxa_taxon_id),
    matchedName: cleanText(row.matched_name),
    matchedLanguage: cleanText(row.matched_language),
    matchType: cleanText(row.match_type),
    displayName: displayName(canonicalScientificName, vernacularName),
  }
}

function normalizeLegacyResult(row = {}) {
  const scientificName = cleanText(row.canonical_scientific_name)
    || [cleanText(row.genus), cleanText(row.specific_epithet)].filter(Boolean).join(' ')
  const vernacularName = cleanText(row.vernacular_name)
  return {
    identityCapability: LEGACY_TAXONOMY_IDENTITY_CAPABILITY,
    legacyTaxonId: cleanId(row.taxon_id),
    genus: cleanText(row.genus),
    specificEpithet: cleanText(row.specific_epithet),
    scientificName,
    canonicalScientificName: scientificName,
    family: cleanText(row.family),
    vernacularName,
    norwegianTaxonId: cleanId(row.norwegian_taxon_id),
    swedishTaxonId: cleanId(row.swedish_taxon_id),
    inaturalistTaxonId: cleanId(row.inaturalist_taxon_id),
    artportalenTaxonId: cleanId(row.artportalen_taxon_id),
    matchType: cleanText(row.match_type),
    displayName: displayName(scientificName, vernacularName),
  }
}

function isUnavailableRpcError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  return code === 'PGRST202' || code === '42883'
    || (message.includes('search_taxa_v2') && (message.includes('not found') || message.includes('schema cache')))
}

export async function searchTaxaV2(q, lang = 'no', options = {}) {
  const query = String(q || '').trim()
  if (query.length < 2) return []
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 50))
  const normalizedLang = normalizeSearchLanguage(lang)
  const client = options.supabaseClient || supabase
  const { data, error } = await client.rpc('search_taxa_v2', { q: query, lang: normalizedLang, lim: limit })
  if (!error) {
    if (!data?.length) console.debug('[taxonomy-v2] empty search result', { query, lang: normalizedLang })
    return (data || []).map(normalizeTaxonomyV2Result)
  }

  console.warn('[taxonomy-v2] search RPC failed', {
    query,
    lang: normalizedLang,
    code: error.code || null,
    message: error.message || String(error),
  })
  if (options.legacyFallback === false || !isUnavailableRpcError(error)) return []

  const legacy = await client.rpc('search_taxa', { q: query, lang: normalizedLang, lim: limit })
  if (legacy.error) {
    console.warn('[taxonomy-v2] legacy fallback RPC failed', {
      query,
      code: legacy.error.code || null,
      message: legacy.error.message || String(legacy.error),
    })
    return []
  }
  return (legacy.data || []).map(normalizeLegacyResult)
}

export function taxonomySelectionForTaxon(taxon) {
  if (taxon?.identityCapability !== TAXONOMY_IDENTITY_CAPABILITY || !taxon?.sporelyTaxonId) return null
  return {
    capability: TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: String(taxon.sporelyTaxonId),
  }
}

export function takeQueuedTaxonomySelection(payload = {}) {
  const databasePayload = { ...payload }
  const selection = databasePayload[QUEUED_TAXONOMY_SELECTION_KEY] || null
  delete databasePayload[QUEUED_TAXONOMY_SELECTION_KEY]
  return { databasePayload, selection }
}

export async function persistObservationTaxonomySelection(observationId, selection, options = {}) {
  const client = options.supabaseClient || supabase
  const sporelyTaxonId = selection?.capability === TAXONOMY_IDENTITY_CAPABILITY
    ? selection.sporelyTaxonId
    : null
  const { error } = await client.rpc('set_observation_selected_taxon_v2', {
    p_observation_id: observationId,
    p_sporely_taxon_id: sporelyTaxonId,
  })
  if (!error) return true
  console.warn('[taxonomy-v2] persistence RPC rejected', {
    observationId,
    sporelyTaxonId,
    code: error.code || null,
    message: error.message || String(error),
    category: String(error.message || '').includes('does not own') ? 'ownership_rejection' : 'identity_rejection',
  })
  throw error
}
