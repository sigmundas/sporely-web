import { supabase } from './supabase.js'
import { canPerformCloudMutation } from './capabilities.js'

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
  // Stage B2b: taxonomy search is a Supabase RPC. In CACHED / REAUTH_REQUIRED
  // there is no useful backend session — dispatching would either fail
  // (offline) or return 401 (reauth). We suppress dispatch BEFORE the RPC
  // fires so the user's typing doesn't spam auth-error toasts. Callers
  // treat this as "no results yet". Already-selected taxonomy values on
  // an observation remain intact (they live in observation state, not
  // here).
  if (options.bypassCapabilityGate !== true && !canPerformCloudMutation().allowed) return []
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

// ── Preserved external identifiers (taxonomy-v2 closeout Stage 2 Part B) ────
//
// A provider candidate carries a namespaced external identifier, not a Sporely
// ID. Before this change the client dropped it: `taxonomySelectionForTaxon`
// required `sporelyTaxonId` and returned null for anything else, so an
// Artsorakel `NBIC:53482` result produced no selection at all and the
// identifier never reached `resolve_taxon_external_id_v2`.
//
// Failure to resolve is now a STATE, not an absence. An external identifier is
// preserved as `(source_system, namespace, external_id)` plus the verbatim
// provider string, and is offered to the resolver before the client concludes
// there is no Sporely identity.

export const EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY = 'external-taxonomy-identifier'

/**
 * Prefix registry. `identity-contract.md` assigns an Artsorakel `NBIC:` value
 * to `(artsorakel, nbic_scientific_name_id)` — it identifies a scientific
 * NAME, not a taxon concept.
 */
const PREFIXED_ID_REGISTRY = {
  NBIC: { sourceSystem: 'artsorakel', namespace: 'nbic_scientific_name_id' },
}

/**
 * Declared, evidenced namespace bridges.
 *
 * `identity-contract.md` states that the NorTaxa Darwin Core archive's
 * `dwc:taxonID` values ARE Artsnavnebase scientific-name IDs — the registry
 * Artsorakel returns under `NBIC:` — so an Artsorakel name id may be looked up
 * as a `nortaxa_taxon_id`. It must NEVER be bridged to
 * `artsdatabanken_taxon_concept_id`: numeric equality across those two
 * Artsdatabanken registries is coincidence, not identity.
 */
const NAMESPACE_BRIDGES = {
  nbic_scientific_name_id: {
    sourceSystem: 'nortaxa',
    namespace: 'nortaxa_taxon_id',
    evidence: 'identity-contract.md: nortaxa dwc:taxonID values are Artsnavnebase scientific-name IDs',
  },
}

/**
 * Parse `"NBIC:53482"` into its namespaced tuple, retaining the raw value.
 *
 * Returns null for empty input, an unknown prefix, and — importantly — a bare
 * integer. A namespace-lost integer carries no evidence of which registry
 * produced it, so accepting one would invent a namespace.
 */
export function parsePrefixedExternalId(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const match = /^([A-Za-z][A-Za-z0-9_]*):(.+)$/.exec(raw)
  if (!match) return null
  const registered = PREFIXED_ID_REGISTRY[match[1].toUpperCase()]
  if (!registered) return null
  const localId = match[2].trim()
  if (!localId) return null
  return {
    raw,
    sourceSystem: registered.sourceSystem,
    namespace: registered.namespace,
    localId,
    numericComponent: /^\d+$/.test(localId) ? localId : null,
  }
}

/** The same identifier expressed in its declared bridge namespace, or null. */
export function bridgePrefixedExternalId(parsed) {
  if (!parsed) return null
  const bridge = NAMESPACE_BRIDGES[parsed.namespace]
  if (!bridge || !parsed.numericComponent) return null
  return {
    ...parsed,
    sourceSystem: bridge.sourceSystem,
    namespace: bridge.namespace,
    localId: parsed.numericComponent,
    bridgeEvidence: bridge.evidence,
  }
}

/**
 * Build an unresolved external taxonomy selection from a provider candidate.
 *
 * Carries no `sporelyTaxonId`: an unresolved external identifier has no
 * Sporely identity, whatever its digits happen to equal. The provider's
 * scientific-name and rank snapshot travel with it so a failure to resolve
 * cannot destroy the source prediction.
 */
export function externalTaxonomySelectionForCandidate(candidate) {
  const parsed = parsePrefixedExternalId(
    candidate?.taxonId ?? candidate?.taxon_id ?? candidate?.scientific_name_id,
  )
  if (!parsed) return null
  const target = bridgePrefixedExternalId(parsed) || parsed
  return {
    capability: EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: null,
    sourceSystem: target.sourceSystem,
    namespace: target.namespace,
    externalId: target.localId,
    // Retained per identity-contract.md, even after a successful bridge.
    rawExternalId: parsed.raw,
    scientificName: cleanText(candidate?.scientificName ?? candidate?.scientific_name),
    taxonRank: cleanText(candidate?.taxonRank ?? candidate?.taxon_rank),
  }
}

export function taxonomySelectionForTaxon(taxon) {
  if (taxon?.identityCapability === TAXONOMY_IDENTITY_CAPABILITY && taxon?.sporelyTaxonId) {
    return {
      capability: TAXONOMY_IDENTITY_CAPABILITY,
      sporelyTaxonId: String(taxon.sporelyTaxonId),
    }
  }
  // A provider candidate: keep its namespaced identifier instead of dropping
  // it. `resolveExternalTaxonomySelection` is what may later turn this into a
  // Sporely identity; nothing else may.
  return externalTaxonomySelectionForCandidate(taxon)
}

/** Whether a selection carries a proven Sporely-owned identity. */
export function isProvenSporelySelection(selection) {
  return selection?.capability === TAXONOMY_IDENTITY_CAPABILITY
    && !!selection?.sporelyTaxonId
}

/**
 * Offer a preserved external identifier to the authoritative resolver.
 *
 * Returns a proven Sporely selection on a single unambiguous match, and the
 * unchanged external selection otherwise. Ambiguity is never collapsed and a
 * failed or errored resolution never discards the source evidence — the
 * caller keeps a truthful "identified text, unresolved identity" state.
 *
 * Today `resolve_taxon_external_id_v2` returns nothing for any NorTaxa
 * identifier, because the active release carries zero `nortaxa_taxon_id`
 * mappings. Stage 3 restores the bridge; this call is what makes the fix
 * observable from the client without further client changes.
 */
export async function resolveExternalTaxonomySelection(selection, options = {}) {
  if (selection?.capability !== EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY) return selection || null
  if (!selection.sourceSystem || !selection.namespace || !selection.externalId) return selection
  if (options.bypassCapabilityGate !== true && !canPerformCloudMutation().allowed) return selection
  const client = options.supabaseClient || supabase
  const { data, error } = await client.rpc('resolve_taxon_external_id_v2', {
    p_source_system: selection.sourceSystem,
    p_namespace: selection.namespace,
    p_external_id: selection.externalId,
  })
  if (error) {
    console.warn('[taxonomy-v2] external-id resolution failed', {
      sourceSystem: selection.sourceSystem,
      namespace: selection.namespace,
      externalId: selection.externalId,
      code: error.code || null,
      message: error.message || String(error),
    })
    return selection
  }
  const matches = (data || []).filter(row => row?.taxon_id !== null && row?.taxon_id !== undefined)
  const distinct = new Set(matches.map(row => String(row.taxon_id)))
  if (distinct.size !== 1) {
    if (distinct.size > 1) {
      console.warn('[taxonomy-v2] external identifier is ambiguous; leaving unresolved', {
        namespace: selection.namespace,
        externalId: selection.externalId,
        matches: distinct.size,
      })
    }
    return selection
  }
  return {
    ...selection,
    capability: TAXONOMY_IDENTITY_CAPABILITY,
    sporelyTaxonId: String(matches[0].taxon_id),
    // The source tuple stays on the selection so the resolution is auditable.
    resolvedFromExternalId: true,
  }
}

/**
 * The observation columns that persist a preserved external identifier.
 *
 * Kept in this module so the save path and its regressions agree on one list.
 * Mirrors the desktop client's `observations.taxon_identity_*` columns.
 */
export const TAXON_IDENTITY_COLUMNS = [
  'taxon_identity_state',
  'taxon_identity_source_system',
  'taxon_identity_namespace',
  'taxon_identity_external_id',
  'taxon_identity_raw_external_id',
]

export const TAXON_IDENTITY_STATE_SPORELY = 'sporely_v2'
export const TAXON_IDENTITY_STATE_EXTERNAL_UNRESOLVED = 'external_unresolved'

/**
 * Observation columns for a selection, resolved or not.
 *
 * Returns null when there is nothing to say, so a caller that never obtained
 * a selection does not blank a row's existing provenance.
 */
export function taxonIdentityPatchForSelection(selection) {
  if (!selection) return null
  if (isProvenSporelySelection(selection)) {
    return {
      taxon_identity_state: TAXON_IDENTITY_STATE_SPORELY,
      taxon_identity_source_system: selection.sourceSystem || 'sporely',
      taxon_identity_namespace: selection.namespace || 'sporely_taxon_id',
      taxon_identity_external_id: selection.externalId || String(selection.sporelyTaxonId),
      taxon_identity_raw_external_id: selection.rawExternalId || null,
    }
  }
  if (selection.capability !== EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY) return null
  return {
    taxon_identity_state: TAXON_IDENTITY_STATE_EXTERNAL_UNRESOLVED,
    taxon_identity_source_system: selection.sourceSystem,
    taxon_identity_namespace: selection.namespace,
    taxon_identity_external_id: selection.externalId,
    taxon_identity_raw_external_id: selection.rawExternalId || null,
  }
}

/** Rebuild a selection from persisted observation columns, for reload. */
export function taxonomySelectionFromObservationRow(row = {}) {
  const state = cleanText(row.taxon_identity_state)
  const sporelyTaxonId = cleanId(row.selected_sporely_taxon_id)
  if (state === TAXON_IDENTITY_STATE_EXTERNAL_UNRESOLVED) {
    const sourceSystem = cleanText(row.taxon_identity_source_system)
    const namespace = cleanText(row.taxon_identity_namespace)
    const externalId = cleanId(row.taxon_identity_external_id)
    if (!sourceSystem || !namespace || !externalId) return null
    return {
      capability: EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY,
      sporelyTaxonId: null,
      sourceSystem,
      namespace,
      externalId,
      rawExternalId: cleanId(row.taxon_identity_raw_external_id) || externalId,
      scientificName: cleanText(row.ai_selected_scientific_name)
        || [cleanText(row.genus), cleanText(row.species)].filter(Boolean).join(' ')
        || null,
      taxonRank: null,
    }
  }
  if (sporelyTaxonId) {
    return { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId }
  }
  return null
}

export function takeQueuedTaxonomySelection(payload = {}) {
  const databasePayload = { ...payload }
  const selection = databasePayload[QUEUED_TAXONOMY_SELECTION_KEY] || null
  delete databasePayload[QUEUED_TAXONOMY_SELECTION_KEY]
  return { databasePayload, selection }
}

export async function persistObservationTaxonomySelection(observationId, selection, options = {}) {
  const client = options.supabaseClient || supabase
  // Only a proven Sporely selection reaches the RPC. An unresolved external
  // identifier must NOT be sent as null either: that would clear an existing
  // cloud selection on the strength of a failed resolution. Its evidence is
  // persisted through `taxonIdentityPatchForSelection` instead.
  if (selection?.capability === EXTERNAL_TAXONOMY_IDENTITY_CAPABILITY
      && !selection.sporelyTaxonId) {
    return false
  }
  const sporelyTaxonId = isProvenSporelySelection(selection)
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

/**
 * Write an observation's identification atomically.
 *
 * The bound concept, its provenance and the accepted name are ONE change. They
 * are written by a single `set_observation_identification_v2` call so they
 * cannot end up describing different taxa — no client ordering or compensation
 * can achieve that, because compensation is itself a write that can fail.
 *
 * Returns `{ applied: true }` on success, or `{ applied: false, unavailable:
 * true }` when the function is not deployed on this backend, so the caller can
 * fall back to the pre-atomic sequence. Any other error is thrown.
 */
export async function persistObservationIdentification(observationId, {
  selection = null,
  writeName = false,
  genus = null,
  species = null,
  commonName = null,
} = {}, options = {}) {
  const client = options.supabaseClient || supabase
  const columns = taxonIdentityPatchForSelection(selection)
  const sporelyTaxonId = isProvenSporelySelection(selection)
    ? selection.sporelyTaxonId
    : null
  const { error } = await client.rpc('set_observation_identification_v2', {
    p_observation_id: observationId,
    p_sporely_taxon_id: sporelyTaxonId,
    p_identity_state: columns?.taxon_identity_state ?? null,
    p_source_system: columns?.taxon_identity_source_system ?? null,
    p_namespace: columns?.taxon_identity_namespace ?? null,
    p_external_id: columns?.taxon_identity_external_id ?? null,
    p_raw_external_id: columns?.taxon_identity_raw_external_id ?? null,
    p_write_name: Boolean(writeName),
    p_genus: genus,
    p_species: species,
    p_common_name: commonName,
  })
  if (!error) return { applied: true, columns, selectedSporelyTaxonId: sporelyTaxonId }
  if (isUnavailableIdentificationRpc(error)) {
    console.warn('[taxonomy-v2] atomic identification RPC not deployed; falling back', {
      code: error.code || null,
    })
    return { applied: false, unavailable: true }
  }
  console.warn('[taxonomy-v2] atomic identification RPC rejected', {
    observationId,
    sporelyTaxonId,
    code: error.code || null,
    message: error.message || String(error),
  })
  throw error
}

/** Whether an error means `set_observation_identification_v2` is absent. */
export function isUnavailableIdentificationRpc(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  return code === 'PGRST202' || code === '42883'
    || (message.includes('set_observation_identification_v2')
      && (message.includes('not found') || message.includes('schema cache')
        || message.includes('does not exist')))
}
