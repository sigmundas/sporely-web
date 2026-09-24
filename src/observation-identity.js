/**
 * How an observation's identification should be presented.
 *
 * Taxonomy-v2 closeout Stage 2 Part B. The list and home screens each decided
 * "unidentified" inline from `!latin && !obs.common_name`. That rule is
 * correct, but it was duplicated and it had no name, so nothing stated the
 * distinction the closeout cares about:
 *
 *   * `identified`   — a bound Sporely concept, or a name with no identity
 *                      question outstanding;
 *   * `unresolved`   — a usable scientific name whose external identifier has
 *                      not resolved to a Sporely concept. Still identified;
 *   * `unidentified` — the genuine no-name case, and ONLY that.
 *
 * An observation with a valid provider scientific name must never render as
 * unidentified just because `selected_sporely_taxon_id` is null. "Unidentified"
 * is reserved for an observation that carries no name at all.
 */

export const IDENTIFICATION_IDENTIFIED = 'identified'
export const IDENTIFICATION_UNRESOLVED_IDENTITY = 'identified_unresolved_identity'
export const IDENTIFICATION_UNIDENTIFIED = 'unidentified'

export const TAXON_IDENTITY_STATE_EXTERNAL_UNRESOLVED = 'external_unresolved'

function _text(value) {
  const text = String(value ?? '').trim()
  return text || null
}

/**
 * Whether the observation carries any usable identification text.
 *
 * Deliberately includes `common_name`: a vernacular-only identification is an
 * identification, and both screens already treated it as one.
 */
export function hasIdentificationName(obs = {}) {
  return !!(_text(obs.genus) || _text(obs.species) || _text(obs.common_name))
}

/** Whether a preserved external identifier is still waiting to resolve. */
export function hasUnresolvedExternalIdentity(obs = {}) {
  if (_text(obs.selected_sporely_taxon_id)) return false
  if (_text(obs.taxon_identity_state) === TAXON_IDENTITY_STATE_EXTERNAL_UNRESOLVED) {
    return true
  }
  // Rows saved before the provenance columns existed still expose the
  // condition through a complete source tuple.
  return !!(
    _text(obs.taxon_identity_source_system)
    && _text(obs.taxon_identity_namespace)
    && _text(obs.taxon_identity_external_id)
  )
}

/**
 * Classify an observation row for display.
 *
 * `unidentified` requires the absence of every name field. A row with a name
 * and an unresolved external identifier is `identified_unresolved_identity`,
 * which renders as its name — not as unidentified.
 */
export function observationIdentificationState(obs = {}) {
  if (!hasIdentificationName(obs)) return IDENTIFICATION_UNIDENTIFIED
  if (hasUnresolvedExternalIdentity(obs)) return IDENTIFICATION_UNRESOLVED_IDENTITY
  return IDENTIFICATION_IDENTIFIED
}

/** Convenience predicate for the screens' existing `isUnknown` branches. */
export function isObservationUnidentified(obs = {}) {
  return observationIdentificationState(obs) === IDENTIFICATION_UNIDENTIFIED
}
