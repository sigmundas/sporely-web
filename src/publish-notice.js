// Publish notice (Stage 2c, web). A Publish/Cancel confirmation shown on every
// change that makes an observation public and not a draft, and on every move
// of a public observation from approximate to exact location. Plan:
// docs/plans/active/2026-10-01-reference-sharing-roles-and-publish-notice.md,
// "Publish notice (web and desktop)".
//
// Verified public exposure of a published (visibility='public', is_draft=false)
// observation, from the server read surfaces in supabase/migrations — not from
// the edit form. Drafts and private/friends observations are excluded from
// every public surface below.
//
//   Always, to anyone incl. signed-out (observations_community_view, granted to
//   anon in 20260803120000; latest def 20260930181742):
//     species, date, captured_at (time of day), created_at, author, habitat,
//     notes, uncertain flag, red list status, AI identification fields
//     (ai_selected_service/_taxon_id/_scientific_name/_probability/_at).
//   location_precision='exact': location text + exact gps_latitude/longitude
//     (community view; get_public_observation "locationLabel"/"mapLat/Lon",
//     20260721120000).
//   location_precision='fuzzed': region label or country instead of the
//     location text; coordinates rounded to 2 decimals (~1 km) (same sources).
//   Photos: thumbnails and worker full-size media for every non-deleted image,
//     served as stored bytes (search_public_observation_images, 20260809120000;
//     delivery gated on public + not draft). storage_exif_safe only gates the
//     legacy direct "fullUrl". Images with storage_exif_safe=false (older or
//     desktop uploads) may still carry camera GPS, so with approximate
//     location the notice adds a caveat unless every image is known safe. New
//     web uploads are re-encoded and recorded safe (images.js uploadMeta).
//   spore_data_visibility='public' (column default): spore statistics
//     (community view) and spore summary/points/mosaic (get_public_observation).
//     Otherwise those are withheld; microscope photos (with scale bars) and
//     preparation details (contrast, mount, sample) stay public either way.
//     Web never edits this column (desktop does).
//   Comments: readable and writable by signed-in users only, when they can
//     read the observation (phase7_comments_read TO authenticated,
//     20260812120000).
//   References: a use appears (search_public_observation_references,
//     20260930224506) only when the owner's contribution for that set and the
//     observation's species is status='shared' with consent, and the use is a
//     qualifying use — which also requires spore_data_visibility='public'.
//     Unshared attached references are never public.
import { esc } from './esc.js'
import { t } from './i18n.js'
import { fetchMySharedReferenceContributions } from './shared-references.js'

const ROLE_KEYS = {
  compared: 'publishNotice.role.compared',
  supports_identification: 'publishNotice.role.supports_identification',
  contradicts: 'publishNotice.role.contradicts',
}

function isPublic(obs) {
  return String(obs?.visibility || '').toLowerCase() === 'public' && obs?.is_draft === false
}

function isFuzzed(obs) {
  return obs?.location_precision === 'fuzzed'
}

/** True only for a change that makes the observation public and not a draft. */
export function isPublishingTransition(previous, next) {
  return isPublic(next) && !isPublic(previous)
}

/**
 * A notice is needed when the change publishes the observation, or when a
 * public observation's location goes from approximate to exact.
 */
export function needsPublishNotice(previous, next) {
  if (isPublishingTransition(previous, next)) return true
  return isPublic(previous) && isPublic(next) && isFuzzed(previous) && !isFuzzed(next)
}

/**
 * Whether a reference the owner already shared will appear on this
 * observation after the save.
 *   attachedUses: [{ reference_measurement_set_id, role }] | null (unknown)
 *   taxonId: species after this save; undefined = unknown, null = none
 *   sporeDataVisibility: undefined/null = unknown
 *   contributions: fetchMySharedReferenceContributions() result | null
 * Returns { kind: 'yes', matches } | { kind: 'no' } | { kind: 'unknown' }.
 */
export function resolveAlreadySharedFact({ attachedUses, taxonId, sporeDataVisibility, contributions }) {
  if (Array.isArray(attachedUses) && attachedUses.length === 0) return { kind: 'no' }
  if (sporeDataVisibility != null && sporeDataVisibility !== 'public') return { kind: 'no' }
  if (!Array.isArray(attachedUses) || taxonId === undefined) return { kind: 'unknown' }
  if (taxonId === null) return { kind: 'no' }
  if (contributions?.kind !== 'ok') return { kind: 'unknown' }
  const shared = contributions.contributions.filter(c => c?.status === 'shared')
  if (!shared.length) return { kind: 'no' }
  if (shared.some(c => !Object.prototype.hasOwnProperty.call(c, 'source_measurement_set_id'))) {
    return { kind: 'unknown' }
  }
  const matches = []
  for (const c of shared) {
    if (String(c.sporely_taxon_id) !== String(taxonId)) continue
    for (const use of attachedUses) {
      if (String(use.reference_measurement_set_id) === String(c.source_measurement_set_id)) {
        matches.push({ contribution: c, role: use.role })
      }
    }
  }
  // Without the spore-data setting a match may or may not qualify.
  if (sporeDataVisibility == null && matches.length) return { kind: 'unknown' }
  return matches.length ? { kind: 'yes', matches } : { kind: 'no' }
}

/**
 * Pure: the notice's lines for the chosen settings and facts.
 *   imagesExifSafe: true (all images known safe) | false | undefined (unknown)
 */
export function buildPublishNoticeModel({ locationPrecision, sporeDataVisibility, imagesExifSafe, sharedFact }) {
  const fuzzed = locationPrecision === 'fuzzed'
  const exposed = [
    fuzzed ? t('publishNotice.locationFuzzed') : t('publishNotice.locationExact'),
    t('publishNotice.details'),
    t('publishNotice.ai'),
    t('publishNotice.photos'),
    t('publishNotice.microscopy'),
  ]
  const sporeHidden = sporeDataVisibility != null && sporeDataVisibility !== 'public'
  if (!sporeHidden) exposed.push(t('publishNotice.sporeData'))
  const notes = []
  if (fuzzed && imagesExifSafe !== true) notes.push(t('publishNotice.photoLocationCaveat'))
  if (sporeHidden) notes.push(t('publishNotice.sporeDataHidden'))
  notes.push(t('publishNotice.comments'))
  notes.push(t('publishNotice.referencesPrivate'))
  if (sharedFact?.kind === 'yes') {
    for (const { contribution, role } of sharedFact.matches) {
      const name = [contribution.canonical_scientific_name, contribution.source_short_label]
        .filter(v => typeof v === 'string' && v.trim()).join(' · ')
      notes.push(t('publishNotice.alreadyShared', {
        name: name || t('publishNotice.unnamedReference'),
        role: ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : String(role || ''),
      }))
    }
  } else if (sharedFact?.kind !== 'no') {
    notes.push(t('publishNotice.mayAppear'))
  }
  return { title: t('publishNotice.title'), intro: t('publishNotice.intro'), exposed, notes }
}

export function publishNoticeHtml(model) {
  return `<div class="publish-notice-card" role="dialog" aria-modal="true" aria-labelledby="publish-notice-title">
    <div class="publish-notice-title" id="publish-notice-title">${esc(model.title)}</div>
    <div class="publish-notice-body">
      <p>${esc(model.intro)}</p>
      <ul>${model.exposed.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
      ${model.notes.map(line => `<p class="publish-notice-note">${esc(line)}</p>`).join('')}
    </div>
    <div class="publish-notice-actions">
      <button type="button" class="btn-secondary" data-publish-notice="cancel">${esc(t('publishNotice.cancel'))}</button>
      <button type="button" class="btn-primary" data-publish-notice="publish">${esc(t('publishNotice.publish'))}</button>
    </div>
  </div>`
}

/**
 * Shows the overlay; resolves true on Publish, false on Cancel, backdrop or
 * Escape. Focus moves to Cancel and returns to the previously focused element.
 */
export function showPublishNoticeDialog(model, doc = globalThis.document) {
  return new Promise(resolve => {
    if (!doc?.body) { resolve(false); return }
    const previousFocus = doc.activeElement || null
    const overlay = doc.createElement('div')
    overlay.className = 'publish-notice-overlay'
    overlay.innerHTML = publishNoticeHtml(model)
    let done = false
    const onKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault?.()
        finish(false)
      }
    }
    function finish(value) {
      if (done) return
      done = true
      doc.removeEventListener('keydown', onKeydown, true)
      overlay.remove()
      previousFocus?.focus?.()
      resolve(value)
    }
    overlay.addEventListener('click', event => {
      const action = event.target?.closest?.('[data-publish-notice]')?.dataset?.publishNotice
      if (action) finish(action === 'publish')
      else if (event.target === overlay) finish(false)
    })
    doc.addEventListener('keydown', onKeydown, true)
    doc.body.appendChild(overlay)
    overlay.querySelector('[data-publish-notice="cancel"]')?.focus?.()
  })
}

function isOffline() {
  return globalThis.navigator?.onLine === false
}

function settle(run) {
  return Promise.resolve().then(run).catch(error => ({ error }))
}

/**
 * Loads the owner's facts for an existing cloud observation. Every failure
 * leaves the matching fact unknown (never "no").
 *   taxonAfterSave: { known: false } | { known: true, id } (species change)
 */
export async function loadExistingObservationFacts({ client, observationId, userId, taxonAfterSave = null }) {
  const facts = {
    attachedUses: null, taxonId: undefined, sporeDataVisibility: undefined,
    imagesExifSafe: undefined, contributions: null,
  }
  if (isOffline() || !client || observationId == null) return facts
  const [uses, row, images, contributions] = await Promise.all([
    settle(() => client.from('observation_reference_uses')
      .select('reference_measurement_set_id, role')
      .eq('observation_id', observationId).eq('user_id', userId).is('deleted_at', null)),
    settle(() => client.from('observations')
      .select('spore_data_visibility, selected_sporely_taxon_id, resolved_sporely_taxon_id')
      .eq('id', observationId).eq('user_id', userId).maybeSingle()),
    settle(() => client.from('observation_images')
      .select('storage_exif_safe')
      .eq('observation_id', observationId).eq('user_id', userId).is('deleted_at', null)),
    fetchMySharedReferenceContributions().catch(() => null),
  ])
  if (!uses?.error && Array.isArray(uses?.data)) facts.attachedUses = uses.data
  if (!row?.error && row?.data) {
    facts.sporeDataVisibility = row.data.spore_data_visibility ?? 'public'
    facts.taxonId = row.data.selected_sporely_taxon_id ?? row.data.resolved_sporely_taxon_id ?? null
  }
  if (!images?.error && Array.isArray(images?.data)) {
    facts.imagesExifSafe = images.data.every(image => image?.storage_exif_safe === true)
  }
  if (taxonAfterSave) facts.taxonId = taxonAfterSave.known ? (taxonAfterSave.id ?? null) : undefined
  facts.contributions = contributions
  return facts
}

// A new web observation: no references can be attached yet, spore data keeps
// its column default, and its photos are re-encoded on upload (EXIF-safe).
export const NEW_OBSERVATION_FACTS = Object.freeze({
  attachedUses: [], sporeDataVisibility: 'public', imagesExifSafe: true,
})

/**
 * Asks for confirmation when previous -> next needs a notice. Resolves true
 * when no notice is needed or the owner chose Publish.
 */
export async function confirmPublishIfNeeded(previous, next, {
  loadFacts = async () => NEW_OBSERVATION_FACTS,
  showDialog = showPublishNoticeDialog,
} = {}) {
  if (!needsPublishNotice(previous, next)) return true
  let facts
  try { facts = await loadFacts() } catch { facts = {} }
  const sharedFact = resolveAlreadySharedFact(facts || {})
  const model = buildPublishNoticeModel({
    locationPrecision: next.location_precision,
    sporeDataVisibility: facts?.sporeDataVisibility,
    imagesExifSafe: facts?.imagesExifSafe,
    sharedFact,
  })
  return (await showDialog(model)) === true
}
