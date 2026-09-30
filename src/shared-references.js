// "My shared references" — owner-facing list of the caller's reference
// contributions (Stage 2b, web). Web only gets a list + "Stop sharing";
// creating/editing a reference contribution is not a web feature (decision D
// in docs/plans/active/2026-09-30-reference-sharing-consent.md).
import { supabase } from './supabase.js'
import { esc } from './esc.js'
import { formatDate, t } from './i18n.js'

// ── Data ──────────────────────────────────────────────────────────────────

// Normalizes the list RPC's response into a small result object the caller
// can switch on without re-deriving status semantics:
//   { kind: 'ok', contributions }
//   { kind: 'rate_limited', retryAfterSeconds }
//   { kind: 'error', message }
export async function fetchMySharedReferenceContributions() {
  let data, error
  try {
    ;({ data, error } = await supabase.rpc('list_my_shared_reference_contributions'))
  } catch (err) {
    return { kind: 'error', message: err?.message || String(err) }
  }
  if (error) return { kind: 'error', message: error.message || String(error) }
  if (data?.status === 'rate_limited') {
    return { kind: 'rate_limited', retryAfterSeconds: Number(data.retry_after_seconds) || 0 }
  }
  if (data?.status === 'ok') {
    return { kind: 'ok', contributions: Array.isArray(data.contributions) ? data.contributions : [] }
  }
  return { kind: 'error', message: 'Unexpected response' }
}

// Normalizes the withdraw RPC's response. 'updated' and 'no_change' both
// mean the contribution is now withdrawn — treat both as success.
export async function withdrawSharedReferenceContribution(contributionId) {
  let data, error
  try {
    ;({ data, error } = await supabase.rpc('withdraw_reference_contribution', {
      p_contribution_id: contributionId,
    }))
  } catch (err) {
    return { kind: 'error', message: err?.message || String(err) }
  }
  if (error) return { kind: 'error', message: error.message || String(error) }
  const status = data?.status
  if (status === 'updated' || status === 'no_change') return { kind: 'ok' }
  if (status === 'rate_limited') {
    return { kind: 'rate_limited', retryAfterSeconds: Number(data.retry_after_seconds) || 0 }
  }
  if (status === 'forbidden' || status === 'not_found') return { kind: status }
  return { kind: 'error', message: 'Unexpected response' }
}

// Stop sharing: the confirmation (explaining what stopping cannot undo) is
// always shown first; the RPC runs only after the owner confirms and the
// cloud-mutation guard allows it.
//   { kind: 'cancelled' } | { kind: 'blocked' } | withdraw result
export async function stopSharingWithConfirmation(contributionId, {
  confirm = message => globalThis.window?.confirm(message),
  guard = () => true,
  withdraw = withdrawSharedReferenceContribution,
} = {}) {
  if (!contributionId) return { kind: 'cancelled' }
  if (!confirm(t('sharedReferences.stopConfirm'))) return { kind: 'cancelled' }
  if (!guard()) return { kind: 'blocked' }
  return withdraw(contributionId)
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

// One contribution row. `data-contribution-id` + `.shared-ref-stop-btn` are
// the wiring seams the screen module attaches click handlers to.
export function sharedReferenceRowHtml(contribution) {
  const isShared = contribution.status === 'shared'
  const statusLabel = isShared ? t('sharedReferences.statusShared') : t('sharedReferences.statusWithdrawn')
  const statusClass = isShared ? 'shared-ref-status-shared' : 'shared-ref-status-withdrawn'
  const metaParts = [
    t('sharedReferences.revisionLabel', { revision: contribution.current_revision }),
    t('sharedReferences.sharedAtLabel', { date: formatDate(contribution.shared_at) }),
  ]
  if (contribution.withdrawn_at) {
    metaParts.push(t('sharedReferences.stoppedAtLabel', { date: formatDate(contribution.withdrawn_at) }))
  }
  const stopBtnHtml = isShared
    ? `<button type="button" class="friend-remove-btn shared-ref-stop-btn" data-contribution-id="${esc(contribution.contribution_id)}">${esc(t('sharedReferences.stopSharing'))}</button>`
    : ''
  return `<div class="friend-row shared-ref-row" data-contribution-id="${esc(contribution.contribution_id)}">
    <div class="friend-info shared-ref-info">
      <div class="friend-name shared-ref-name"><em>${esc(contribution.canonical_scientific_name)}</em> <span class="shared-ref-status ${statusClass}">${esc(statusLabel)}</span></div>
      <div class="friend-handle shared-ref-meta">${esc(metaParts.join(' · '))}</div>
    </div>
    ${stopBtnHtml}
  </div>`
}

export function sharedReferencesListHtml(contributions) {
  if (!contributions?.length) return sharedReferencesEmptyHtml()
  return contributions.map(sharedReferenceRowHtml).join('')
}
