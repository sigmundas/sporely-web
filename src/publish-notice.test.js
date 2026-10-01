import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from './supabase.js'
import { setLocale, t } from './i18n.js'
import { state } from './state.js'
import {
  buildPublishNoticeModel,
  confirmPublishIfNeeded,
  isPublishingTransition,
  loadExistingObservationFacts,
  publishNoticeHtml,
  resolveAlreadySharedFact,
} from './publish-notice.js'
import { TAXONOMY_IDENTITY_CAPABILITY } from './taxonomy-v2.js'
import { detailTaxonAfterSave } from './screens/find_detail.js'
import { _confirmReviewPublish } from './screens/review.js'
import { _confirmImportSessionPublish } from './screens/import_review.js'

setLocale('en')

const PUB = { visibility: 'public', is_draft: false }
const SHARED = {
  contribution_id: 'c1', status: 'shared', sporely_taxon_id: 42,
  canonical_scientific_name: 'Amanita muscaria', source_short_label: 'Funga Nordica',
  source_measurement_set_id: 'set-1',
}
const ok = rows => ({ kind: 'ok', contributions: rows })
const USES = [{ reference_measurement_set_id: 'set-1', role: 'supports_identification' }]

test('publishing transition: only into public and not draft', () => {
  assert.equal(isPublishingTransition({ visibility: 'public', is_draft: true }, PUB), true)
  assert.equal(isPublishingTransition({ visibility: 'private', is_draft: false }, PUB), true)
  assert.equal(isPublishingTransition({ visibility: 'friends', is_draft: false }, PUB), true)
  assert.equal(isPublishingTransition(PUB, PUB), false, 'already-public edit that stays public')
  assert.equal(isPublishingTransition({ visibility: 'private', is_draft: true }, { visibility: 'public', is_draft: true }), false, 'draft save')
  assert.equal(isPublishingTransition(PUB, { visibility: 'public', is_draft: true }), false)
  assert.equal(isPublishingTransition({ visibility: 'private', is_draft: true }, { visibility: 'private', is_draft: false }), false)
})

test('confirm: no dialog when not publishing; Cancel returns false; Publish true', async () => {
  let shown = 0
  const showDialog = async () => { shown += 1; return false }
  assert.equal(await confirmPublishIfNeeded(PUB, PUB, { showDialog }), true)
  assert.equal(await confirmPublishIfNeeded({ visibility: 'public', is_draft: true }, { visibility: 'public', is_draft: true }, { showDialog }), true)
  assert.equal(shown, 0)
  assert.equal(await confirmPublishIfNeeded({ visibility: 'private', is_draft: false }, PUB, { showDialog }), false)
  assert.equal(await confirmPublishIfNeeded({ visibility: 'private', is_draft: false }, PUB, { showDialog: async () => true }), true)
  assert.equal(shown, 1)
})

test('already-shared fact: matched, unmatched, unknown', () => {
  const base = { attachedUses: USES, taxonId: 42, sporeDataVisibility: 'public' }
  const yes = resolveAlreadySharedFact({ ...base, contributions: ok([SHARED]) })
  assert.equal(yes.kind, 'yes')
  assert.equal(yes.matches[0].role, 'supports_identification')
  assert.equal(resolveAlreadySharedFact({ ...base, taxonId: 7, contributions: ok([SHARED]) }).kind, 'no')
  assert.equal(resolveAlreadySharedFact({ ...base, contributions: ok([{ ...SHARED, status: 'withdrawn' }]) }).kind, 'no')
  assert.equal(resolveAlreadySharedFact({ ...base, attachedUses: [], contributions: ok([SHARED]) }).kind, 'no')
  assert.equal(resolveAlreadySharedFact({ ...base, sporeDataVisibility: 'private', contributions: ok([SHARED]) }).kind, 'no')
  // unknown cases
  const { source_measurement_set_id: _s, ...withoutField } = SHARED
  assert.equal(resolveAlreadySharedFact({ ...base, contributions: ok([withoutField]) }).kind, 'unknown', 'field absent')
  assert.equal(resolveAlreadySharedFact({ ...base, contributions: { kind: 'rate_limited', retryAfterSeconds: 5 } }).kind, 'unknown')
  assert.equal(resolveAlreadySharedFact({ ...base, contributions: { kind: 'error', message: 'x' } }).kind, 'unknown')
  assert.equal(resolveAlreadySharedFact({ ...base, contributions: null }).kind, 'unknown', 'offline / not loaded')
  assert.equal(resolveAlreadySharedFact({ ...base, attachedUses: null, contributions: ok([SHARED]) }).kind, 'unknown')
  assert.equal(resolveAlreadySharedFact({ ...base, taxonId: undefined, contributions: ok([SHARED]) }).kind, 'unknown')
})

test('species change in the same save is matched against the new species', async () => {
  const client = fakeClient({ uses: USES, row: { spore_data_visibility: 'public', selected_sporely_taxon_id: 7 } })
  await withRpc(() => ({ data: { status: 'ok', contributions: [SHARED] }, error: null }), async () => {
    const before = await loadExistingObservationFacts({ client, observationId: 1, userId: 'u' })
    assert.equal(resolveAlreadySharedFact(before).kind, 'no', 'stored species 7 does not match')
    const after = await loadExistingObservationFacts({ client, observationId: 1, userId: 'u', taxonAfterSave: { known: true, id: '42' } })
    assert.equal(resolveAlreadySharedFact(after).kind, 'yes')
    const unknown = await loadExistingObservationFacts({ client, observationId: 1, userId: 'u', taxonAfterSave: { known: false } })
    assert.equal(resolveAlreadySharedFact(unknown).kind, 'unknown')
  })
  assert.deepEqual(detailTaxonAfterSave(null, false), null)
  assert.deepEqual(detailTaxonAfterSave({ identityCapability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: 42 }, true), { known: true, id: '42' })
  assert.deepEqual(detailTaxonAfterSave(null, true), { known: false }, 'free text change is unknown')
})

test('lookup failures leave the fact unknown', async () => {
  const failing = fakeClient({ usesError: true, rowError: true })
  await withRpc(() => { throw new Error('offline') }, async () => {
    const facts = await loadExistingObservationFacts({ client: failing, observationId: 1, userId: 'u' })
    assert.equal(resolveAlreadySharedFact(facts).kind, 'unknown')
  })
  await withRpc(() => ({ data: { status: 'rate_limited', retry_after_seconds: 3 }, error: null }), async () => {
    const facts = await loadExistingObservationFacts({ client: fakeClient({ uses: USES, row: { spore_data_visibility: 'public', selected_sporely_taxon_id: 42 } }), observationId: 1, userId: 'u' })
    assert.equal(resolveAlreadySharedFact(facts).kind, 'unknown')
  })
})

test('notice text: location precision, spore data, reference lines', () => {
  const exact = buildPublishNoticeModel({ locationPrecision: 'exact', sporeDataVisibility: 'public', sharedFact: { kind: 'no' } })
  assert.ok(exact.exposed.includes(t('publishNotice.locationExact')))
  assert.ok(!exact.exposed.includes(t('publishNotice.locationFuzzed')))
  assert.ok(exact.exposed.includes(t('publishNotice.sporeData')))
  assert.ok(exact.notes.includes(t('publishNotice.referencesPrivate')))
  assert.ok(!exact.notes.includes(t('publishNotice.mayAppear')), 'no already-shared line when it does not apply')

  const fuzzed = buildPublishNoticeModel({ locationPrecision: 'fuzzed', sporeDataVisibility: 'private', sharedFact: { kind: 'no' } })
  assert.ok(fuzzed.exposed.includes(t('publishNotice.locationFuzzed')))
  assert.ok(!fuzzed.exposed.includes(t('publishNotice.sporeData')))
  assert.ok(fuzzed.notes.includes(t('publishNotice.sporeDataHidden')))

  const unknown = buildPublishNoticeModel({ locationPrecision: 'exact', sharedFact: { kind: 'unknown' } })
  assert.ok(unknown.notes.includes('References you have shared may appear on this observation.'))
  assert.ok(unknown.exposed.includes(t('publishNotice.sporeData')), 'unknown spore visibility is disclosed as public')

  const yes = buildPublishNoticeModel({ locationPrecision: 'exact', sporeDataVisibility: 'public', sharedFact: { kind: 'yes', matches: [{ contribution: SHARED, role: 'supports_identification' }] } })
  const line = yes.notes.find(n => n.includes('Amanita muscaria'))
  assert.match(line, /Funga Nordica/)
  assert.match(line, /supports the identification/)
  assert.ok(!yes.notes.includes(t('publishNotice.mayAppear')))
  const html = publishNoticeHtml(yes)
  assert.match(html, /data-publish-notice="publish"/)
  assert.match(html, /data-publish-notice="cancel"/)
  assert.doesNotMatch(html, /don.t show/i)
})

test('dialog receives the chosen settings', async () => {
  let model
  await confirmPublishIfNeeded({ visibility: 'public', is_draft: true }, { ...PUB, location_precision: 'fuzzed' }, {
    showDialog: async m => { model = m; return true },
  })
  assert.ok(model.exposed.includes(t('publishNotice.locationFuzzed')))
  assert.ok(!model.notes.includes(t('publishNotice.mayAppear')), 'new observation has no attached references')
})

test('review and import: notice only on publishing toggles; Cancel leaves state', async () => {
  let shown = 0
  const options = { showDialog: async () => { shown += 1; return false } }
  state.captureDraft = { ...(state.captureDraft || {}), visibility: 'public', is_draft: true, location_precision: 'exact' }
  assert.equal(await _confirmReviewPublish({ is_draft: false }, options), false)
  assert.equal(state.captureDraft.is_draft, true)
  assert.equal(await _confirmReviewPublish({ visibility: 'private' }, options), true)
  state.captureDraft.visibility = 'private'
  state.captureDraft.is_draft = false
  assert.equal(await _confirmReviewPublish({ visibility: 'public' }, options), false)
  assert.equal(shown, 2)

  const session = { visibility: 'public', is_draft: true, location_precision: 'fuzzed' }
  assert.equal(await _confirmImportSessionPublish(session, { is_draft: false }, options), false)
  assert.deepEqual(session, { visibility: 'public', is_draft: true, location_precision: 'fuzzed' })
  assert.equal(await _confirmImportSessionPublish(session, { visibility: 'friends' }, options), true)
  assert.equal(shown, 3)
})

function fakeClient({ uses = [], row = null, usesError = false, rowError = false }) {
  return {
    from(table) {
      const result = table === 'observation_reference_uses'
        ? (usesError ? { data: null, error: { message: 'x' } } : { data: uses, error: null })
        : (rowError ? { data: null, error: { message: 'x' } } : { data: row, error: null })
      const chain = {
        select: () => chain, eq: () => chain, is: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
      }
      return chain
    },
  }
}

function withRpc(behavior, run) {
  const original = supabase.rpc
  supabase.rpc = async (...args) => behavior(...args)
  return Promise.resolve().then(run).finally(() => { supabase.rpc = original })
}
