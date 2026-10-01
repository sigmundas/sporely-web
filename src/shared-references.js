// "My shared references" — owner-facing list of the caller's reference sets
// (Stage 2d, web). References on a public observation are shared by default;
// the owner can stop sharing a set everywhere and share it again. Web only
// lists and toggles; creating/editing references is not a web feature.
// Plan: docs/plans/active/2026-10-01-reference-sharing-default-on.md.
import { supabase } from './supabase.js'
import { esc } from './esc.js'
import { formatDate, t } from './i18n.js'

// ── Data ──────────────────────────────────────────────────────────────────

// Normalizes list_my_reference_sharing():
//   { kind: 'ok', sets } | { kind: 'rate_limited', retryAfterSeconds } | { kind: 'error', message }
export async function fetchMyReferenceSharing(client = supabase) {
  let data, error
  try {
    ;({ data, error } = await client.rpc('list_my_reference_sharing'))
  } catch (err) {
    return { kind: 'error', message: err?.message || String(err) }
  }
  if (error) return { kind: 'error', message: error.message || String(error) }
  if (data?.status === 'rate_limited') {
    return { kind: 'rate_limited', retryAfterSeconds: Number(data.retry_after_seconds) || 0 }
  }
  if (data?.status === 'ok') {
    return { kind: 'ok', sets: Array.isArray(data.sets) ? data.sets : [] }
  }
  return { kind: 'error', message: 'Unexpected response' }
}

// 'updated' and 'no_change' both mean the set is now in the requested state.
async function callSetRpc(name, setId) {
  let data, error
  try {
    ;({ data, error } = await supabase.rpc(name, { p_source_measurement_set_id: setId }))
  } catch (err) {
    return { kind: 'error', message: err?.message || String(err) }
  }
  if (error) return { kind: 'error', message: error.message || String(error) }
  const status = data?.status
  if (status === 'updated' || status === 'no_change') return { kind: 'ok' }
  if (status === 'rate_limited') {
    return { kind: 'rate_limited', retryAfterSeconds: Number(data.retry_after_seconds) || 0 }
  }
  if (status === 'not_found') return { kind: 'not_found' }
  return { kind: 'error', message: 'Unexpected response' }
}

export function stopSharingReferenceSet(setId) {
  return callSetRpc('stop_sharing_reference_set', setId)
}

export function shareReferenceSetAgain(setId) {
  return callSetRpc('share_reference_set_again', setId)
}

// Stop sharing: the confirmation (what stopping does and cannot undo) is
// always shown first; the RPC runs only after the owner confirms and the
// cloud-mutation guard allows it.
//   { kind: 'cancelled' } | { kind: 'blocked' } | RPC result
export async function stopSharingWithConfirmation(setId, {
  confirm = message => globalThis.window?.confirm(message),
  guard = () => true,
  stop = stopSharingReferenceSet,
} = {}) {
  if (!setId) return { kind: 'cancelled' }
  if (!confirm(t('sharedReferences.stopConfirm'))) return { kind: 'cancelled' }
  if (!guard()) return { kind: 'blocked' }
  return stop(setId)
}

export async function shareAgainGuarded(setId, {
  guard = () => true,
  shareAgain = shareReferenceSetAgain,
} = {}) {
  if (!setId) return { kind: 'cancelled' }
  if (!guard()) return { kind: 'blocked' }
  return shareAgain(setId)
}

/** Set ids the owner stopped sharing (status 'stopped', or hidden and stopped). */
export function stoppedSetIds(sets) {
  return new Set((sets || []).filter(s => s?.stopped_at || s?.status === 'stopped')
    .map(s => s.source_measurement_set_id))
}

// ── Rendering (pure HTML-string builders — no DOM access, testable) ───────

export function sharedReferencesLoadingHtml() {
  return `<div class="shared-ref-empty">${esc(t('sharedReferences.loading'))}</div>`
}

export function sharedReferencesEmptyHtml() {
  return `<div class="shared-ref-empty">${esc(t('sharedReferences.empty'))}</div>`
}

export function sharedReferencesErrorHtml(message) {
  return `<div class="shared-ref-empty">${esc(t('sharedReferences.error', { message }))}</div>`
}

export function sharedReferencesRateLimitedHtml(retryAfterSeconds) {
  return `<div class="shared-ref-empty">${esc(t('sharedReferences.rateLimited', { seconds: retryAfterSeconds }))}</div>`
}

const STATUS = {
  shared: { key: 'sharedReferences.statusShared', cls: 'shared-ref-status-shared' },
  stopped: { key: 'sharedReferences.statusStopped', cls: 'shared-ref-status-stopped' },
  hidden: { key: 'sharedReferences.hiddenByModeration', cls: 'shared-ref-status-hidden' },
}

function listingHtml(c) {
  const parts = [t('sharedReferences.revisionLabel', { revision: c.current_revision })]
  if (c.shared_at) parts.push(t('sharedReferences.sharedAtLabel', { date: formatDate(c.shared_at) }))
  if (c.hidden_at) parts.push(t('sharedReferences.hiddenByModeration'))
  const name = c.canonical_scientific_name || t('sharedReferences.unknownSpecies')
  return `<li class="shared-ref-listing"><em>${esc(name)}</em> · ${esc(parts.join(' · '))}</li>`
}

// One set row. `data-set-id` plus `.shared-ref-stop-btn` /
// `.shared-ref-share-again-btn` are the seams the screen wires clicks to.
export function sharedReferenceSetRowHtml(set) {
  const status = STATUS[set.status] || STATUS.shared
  const stopped = Boolean(set.stopped_at) || set.status === 'stopped'
  const setId = esc(set.source_measurement_set_id)
  const sourceParts = [set.source_short_label, set.source_raw_text]
    .filter(v => typeof v === 'string' && v.trim())
  const title = sourceParts.length ? sourceParts.join(' · ') : t('sharedReferences.unnamedSource')
  const metaParts = [t('sharedReferences.publicObservationCount', { count: Number(set.public_observation_count) || 0 })]
  if (set.stopped_at) metaParts.push(t('sharedReferences.stoppedAtLabel', { date: formatDate(set.stopped_at) }))
  const listings = Array.isArray(set.species_page_contributions) ? set.species_page_contributions : []
  const listingsHtml = listings.length
    ? `<div class="friend-handle shared-ref-listings-label">${esc(t('sharedReferences.speciesPageListings'))}</div><ul class="shared-ref-listings">${listings.map(listingHtml).join('')}</ul>`
    : `<div class="friend-handle shared-ref-listings-label">${esc(t('sharedReferences.noSpeciesPageListing'))}</div>`
  const btnHtml = stopped
    ? `<button type="button" class="friend-remove-btn shared-ref-share-again-btn" data-set-id="${setId}">${esc(t('sharedReferences.shareAgain'))}</button>`
    : `<button type="button" class="friend-remove-btn shared-ref-stop-btn" data-set-id="${setId}">${esc(t('sharedReferences.stopSharing'))}</button>`
  return `<div class="friend-row shared-ref-row" data-set-id="${setId}">
    <div class="friend-info shared-ref-info">
      <div class="friend-name shared-ref-name">${esc(title)} <span class="shared-ref-status ${status.cls}">${esc(t(status.key))}</span></div>
      <div class="friend-handle shared-ref-meta">${esc(metaParts.join(' · '))}</div>
      ${listingsHtml}
    </div>
    ${btnHtml}
  </div>`
}

export function sharedReferencesListHtml(sets) {
  if (!sets?.length) return sharedReferencesEmptyHtml()
  return sets.map(sharedReferenceSetRowHtml).join('')
}
