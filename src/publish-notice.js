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
//   References: attached references are shared by default; the owner can
//     stop sharing one in My shared references. The notice says this once,
//     generically.
//
// Wording (shared with desktop): new web observations are saved to the
// IndexedDB queue (sync-queue.js) and reach the server on the next sync, so
// they say "After the next sync"; find detail edits write to Supabase
// directly, so they pass when: 'save' ("After you save").
//
// Stage 2d triggers not wired on web, because web has no such path: web has
// no reference attach UI (attach-to-public), and web never edits
// spore_data_visibility (spore data private -> public).
//
// "Don't show this again" is stored per signed-in user in
// localStorage (settings.js getShowPublishNotice); Settings turns it back on.
// When suppressed, publishing proceeds without the modal; the precision
// notice has no checkbox and always shows.
import { esc } from './esc.js'
import { t } from './i18n.js'
import { getShowPublishNotice, setShowPublishNotice } from './settings.js'
import { state } from './state.js'

function isPublic(obs) {
  return String(obs?.visibility || '').toLowerCase() === 'public' && obs?.is_draft === false
}

// How much location a public observation shows. The views treat a missing
// value as 'exact' (coalesce(location_precision, 'exact')).
const PRECISION_RANK = { hidden: 0, region: 1, fuzzed: 2, exact: 3 }
function precisionRank(obs) {
  return PRECISION_RANK[obs?.location_precision] ?? PRECISION_RANK.exact
}

/** True only for a change that makes the observation public and not a draft. */
export function isPublishingTransition(previous, next) {
  return isPublic(next) && !isPublic(previous)
}

/**
 * A notice is needed when the change publishes the observation, or when a
 * public observation's location becomes more precise (hidden < region <
 * fuzzed < exact).
 */
export function needsPublishNotice(previous, next) {
  if (isPublishingTransition(previous, next)) return true
  return isPublic(previous) && isPublic(next) && precisionRank(next) > precisionRank(previous)
}

/**
 * Pure: the notice's lines for the chosen settings and facts.
 *   imagesExifSafe: true (all images known safe) | false | undefined (unknown)
 *   when: 'sync' (queued, default) | 'save' (written directly)
 *   kind: 'publish' | 'precision' (already public, location more precise)
 */
export function buildPublishNoticeModel({ locationPrecision, sporeDataVisibility, imagesExifSafe, when = 'sync', kind = 'publish' }) {
  // 'region'/'hidden' show less than fuzzed; the approximate text (and the
  // photo caveat) is the cautious description for them.
  const fuzzed = ['fuzzed', 'region', 'hidden'].includes(locationPrecision)
  const whenText = t(when === 'save' ? 'publishNotice.whenSave' : 'publishNotice.whenSync')
  const caveat = fuzzed && imagesExifSafe !== true ? [t('publishNotice.photoLocationCaveat')] : []
  if (kind === 'precision') {
    return {
      title: t('publishNotice.precisionTitle'),
      intro: t('publishNotice.precisionBody', {
        when: whenText,
        location: t(fuzzed ? 'publishNotice.precisionFuzzed' : 'publishNotice.precisionExact'),
      }),
      exposed: [],
      notes: caveat,
      confirm: t('publishNotice.precisionConfirm'),
      suppressible: false,
    }
  }
  const exposed = [
    t('publishNotice.details'),
    fuzzed ? t('publishNotice.locationFuzzed') : t('publishNotice.locationExact'),
    t('publishNotice.media'),
  ]
  const sporeHidden = sporeDataVisibility != null && sporeDataVisibility !== 'public'
  if (!sporeHidden) exposed.push(t('publishNotice.sporeData'))
  const notes = [...caveat]
  if (sporeHidden) notes.push(t('publishNotice.sporeDataHidden'))
  notes.push(t('publishNotice.references'))
  return {
    title: t('publishNotice.title'),
    intro: t('publishNotice.intro', { when: whenText }),
    exposed,
    notes,
    confirm: t('publishNotice.publish'),
    suppressible: true,
  }
}

export function publishNoticeHtml(model) {
  return `<div class="publish-notice-card" role="dialog" aria-modal="true" aria-labelledby="publish-notice-title">
    <div class="publish-notice-title" id="publish-notice-title">${esc(model.title)}</div>
    <div class="publish-notice-body">
      <p>${esc(model.intro)}</p>
      ${model.exposed.length ? `<ul>${model.exposed.map(line => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}
      ${model.notes.map(line => `<p class="publish-notice-note">${esc(line)}</p>`).join('')}
    </div>
    ${model.suppressible === false ? '' : `<label class="publish-notice-dont-show">
      <input type="checkbox" data-publish-notice-dont-show>
      <span>${esc(t('publishNotice.dontShowAgain'))}</span>
    </label>`}
    <div class="publish-notice-actions">
      <button type="button" class="btn-secondary" data-publish-notice="cancel">${esc(t('publishNotice.cancel'))}</button>
      <button type="button" class="btn-primary" data-publish-notice="publish">${esc(model.confirm || t('publishNotice.publish'))}</button>
    </div>
  </div>`
}

/**
 * Shows the overlay; resolves true on Publish, false on Cancel, backdrop or
 * Escape. Focus moves to Cancel and returns to the previously focused element.
 * On Publish with "Don't show this again" checked, calls onDontShowAgain().
 */
export function showPublishNoticeDialog(model, doc = globalThis.document, { onDontShowAgain } = {}) {
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
      const dontShow = overlay.querySelector('[data-publish-notice-dont-show]')?.checked === true
      doc.removeEventListener('keydown', onKeydown, true)
      overlay.remove()
      previousFocus?.focus?.()
      if (value && dontShow) {
        try { onDontShowAgain?.() } catch (_) {}
      }
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
 * leaves the matching fact unknown.
 */
export async function loadExistingObservationFacts({ client, observationId, userId }) {
  const facts = { sporeDataVisibility: undefined, imagesExifSafe: undefined }
  if (isOffline() || !client || observationId == null) return facts
  const [row, images] = await Promise.all([
    settle(() => client.from('observations')
      .select('spore_data_visibility')
      .eq('id', observationId).eq('user_id', userId).maybeSingle()),
    settle(() => client.from('observation_images')
      .select('storage_exif_safe')
      .eq('observation_id', observationId).eq('user_id', userId).is('deleted_at', null)),
  ])
  if (!row?.error && row?.data) {
    facts.sporeDataVisibility = row.data.spore_data_visibility ?? 'public'
  }
  if (!images?.error && Array.isArray(images?.data)) {
    facts.imagesExifSafe = images.data.every(image => image?.storage_exif_safe === true)
  }
  return facts
}

// A new web observation: spore data keeps its column default, and its photos
// are re-encoded on upload (EXIF-safe).
export const NEW_OBSERVATION_FACTS = Object.freeze({
  sporeDataVisibility: 'public', imagesExifSafe: true,
})

/**
 * Asks for confirmation when previous -> next needs a notice. Resolves true
 * when no notice is needed, the signed-in user suppressed it on this device,
 * or the owner chose Publish.
 */
export async function confirmPublishIfNeeded(previous, next, {
  loadFacts = async () => NEW_OBSERVATION_FACTS,
  showDialog = showPublishNoticeDialog,
  userId = state.user?.id,
  when = 'sync',
} = {}) {
  if (!needsPublishNotice(previous, next)) return true
  const publishing = isPublishingTransition(previous, next)
  // Only the publish notice is suppressible; a more precise location on an
  // already-public observation always asks (same as desktop).
  if (publishing && !getShowPublishNotice(userId)) return true
  let facts
  try { facts = await loadFacts() } catch { facts = {} }
  const model = buildPublishNoticeModel({
    locationPrecision: next.location_precision,
    sporeDataVisibility: facts?.sporeDataVisibility,
    imagesExifSafe: facts?.imagesExifSafe,
    when,
    kind: publishing ? 'publish' : 'precision',
  })
  return (await showDialog(model, undefined, {
    onDontShowAgain: () => setShowPublishNotice(userId, false),
  })) === true
}
