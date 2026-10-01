import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// In-memory localStorage for the per-user "Don't show this again" setting.
const memoryStore = new Map()
globalThis.localStorage = {
  getItem: key => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => { memoryStore.set(key, String(value)) },
  removeItem: key => { memoryStore.delete(key) },
}

import { setLocale, t } from './i18n.js'
import { state } from './state.js'
import {
  buildPublishNoticeModel,
  confirmPublishIfNeeded,
  isPublishingTransition,
  loadExistingObservationFacts,
  publishNoticeHtml,
} from './publish-notice.js'
import { getShowPublishNotice, publishNoticeSuppressedKey, setShowPublishNotice } from './settings.js'
import { _confirmReviewPublish } from './screens/review.js'
import { _confirmImportSessionPublish } from './screens/import_review.js'

setLocale('en')

const PUB = { visibility: 'public', is_draft: false }
const REFERENCES_EN = 'References on a public observation are public: on the observation and its plots, as the version you attached, and in the species-page listing under your name, updated when you edit the reference in your library. This includes references you attach later. You can stop sharing a reference in My shared references.'

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

test('existing facts: spore data and photo safety; failures stay unknown', async () => {
  const facts = await loadExistingObservationFacts({
    client: fakeClient({ row: { spore_data_visibility: 'private' }, images: [{ storage_exif_safe: true }] }),
    observationId: 1, userId: 'u',
  })
  assert.equal(facts.sporeDataVisibility, 'private')
  assert.equal(facts.imagesExifSafe, true)
  const failing = await loadExistingObservationFacts({ client: fakeClient({ rowError: true }), observationId: 1, userId: 'u' })
  assert.equal(failing.sporeDataVisibility, undefined)
})

test('notice text: location precision, spore data, references public by default', () => {
  const exact = buildPublishNoticeModel({ locationPrecision: 'exact', sporeDataVisibility: 'public' })
  assert.ok(exact.exposed.includes(t('publishNotice.locationExact')))
  assert.ok(!exact.exposed.includes(t('publishNotice.locationFuzzed')))
  assert.ok(exact.exposed.includes(t('publishNotice.sporeData')))
  assert.ok(exact.notes.includes(REFERENCES_EN))
  assert.equal(t('publishNotice.references'), REFERENCES_EN)

  const fuzzed = buildPublishNoticeModel({ locationPrecision: 'fuzzed', sporeDataVisibility: 'private' })
  assert.ok(fuzzed.exposed.includes(t('publishNotice.locationFuzzed')))
  assert.ok(!fuzzed.exposed.includes(t('publishNotice.sporeData')))
  assert.ok(fuzzed.notes.includes(t('publishNotice.sporeDataHidden')))
  assert.ok(fuzzed.notes.includes(REFERENCES_EN))

  const unknown = buildPublishNoticeModel({ locationPrecision: 'exact' })
  assert.ok(unknown.exposed.includes(t('publishNotice.sporeData')), 'unknown spore visibility is disclosed as public')

  const html = publishNoticeHtml(exact)
  assert.match(html, /data-publish-notice="publish"/)
  assert.match(html, /data-publish-notice="cancel"/)
  assert.match(html, /data-publish-notice-dont-show/)
  assert.match(html, /Don&#39;t show this again \(on this device\)|Don't show this again \(on this device\)/)
})

test('removed reference lines are gone from the notice and every locale', () => {
  const model = buildPublishNoticeModel({ locationPrecision: 'exact', sporeDataVisibility: 'public' })
  const all = [...model.exposed, ...model.notes].join('\n')
  assert.doesNotMatch(all, /stay private unless you share them/)
  assert.doesNotMatch(all, /already shared|may appear on this observation/i)
  assert.doesNotMatch(all, /stopped sharing/, 'opted-out line ships with step 4')
  const i18nSource = fs.readFileSync(new URL('./i18n.js', import.meta.url), 'utf8')
  const locales = ['en', 'nb_NO', 'sv_SE', 'de_DE']
  const starts = locales.map(locale => i18nSource.indexOf(`\n  ${locale}: {`))
  starts.forEach(start => assert.ok(start > 0))
  for (let i = 0; i < locales.length; i++) {
    const block = i18nSource.slice(starts[i], starts[i + 1] ?? i18nSource.length)
    for (const key of ['referencesPrivate', 'alreadyShared', 'mayAppear', 'unnamedReference', 'role.compared']) {
      assert.ok(!block.includes(`'publishNotice.${key}':`), `${locales[i]} still defines ${key}`)
    }
    for (const key of ['publishNotice.references', 'publishNotice.dontShowAgain', 'settings.showPublishNotice', 'settings.privacy']) {
      assert.ok(block.includes(`'${key}':`), `${locales[i]} is missing ${key}`)
    }
  }
})

test('dialog receives the chosen settings', async () => {
  let model
  await confirmPublishIfNeeded({ visibility: 'public', is_draft: true }, { ...PUB, location_precision: 'fuzzed' }, {
    showDialog: async m => { model = m; return true },
  })
  assert.ok(model.exposed.includes(t('publishNotice.locationFuzzed')))
  assert.ok(model.notes.includes(REFERENCES_EN))
})

test("don't show again: per user, skips the modal incl. precision increase; Settings restores", async () => {
  memoryStore.clear()
  let shown = 0
  const checkDontShow = async (_model, _doc, { onDontShowAgain }) => { shown += 1; onDontShowAgain(); return true }
  const showDialog = async () => { shown += 1; return false }
  const privateObs = { visibility: 'private', is_draft: false }
  assert.equal(await confirmPublishIfNeeded(privateObs, PUB, { userId: 'user-a', showDialog: checkDontShow }), true)
  assert.equal(shown, 1)
  assert.equal(memoryStore.get(publishNoticeSuppressedKey('user-a')), '1', 'stored under a key with the user id')
  assert.equal(getShowPublishNotice('user-a'), false)

  assert.equal(await confirmPublishIfNeeded(privateObs, PUB, { userId: 'user-a', showDialog }), true)
  assert.equal(await confirmPublishIfNeeded(
    { ...PUB, location_precision: 'fuzzed' }, { ...PUB, location_precision: 'exact' }, { userId: 'user-a', showDialog },
  ), true, 'precision increase proceeds without the modal')
  assert.equal(shown, 1, 'suppressed: no modal')

  assert.equal(getShowPublishNotice('user-b'), true, 'another user on this device still sees it')
  assert.equal(await confirmPublishIfNeeded(privateObs, PUB, { userId: 'user-b', showDialog }), false)
  assert.equal(shown, 2)

  setShowPublishNotice('user-a', true)
  assert.equal(getShowPublishNotice('user-a'), true)
  assert.equal(await confirmPublishIfNeeded(privateObs, PUB, { userId: 'user-a', showDialog }), false)
  assert.equal(shown, 3, 'Settings toggle restores the notice')

  const defaultUser = state.user
  state.user = { id: 'user-c' }
  try {
    setShowPublishNotice('user-c', false)
    assert.equal(await confirmPublishIfNeeded(privateObs, PUB, { showDialog }), true, 'defaults to the signed-in user')
    assert.equal(shown, 3)
  } finally {
    state.user = defaultUser
    memoryStore.clear()
  }
  assert.equal(getShowPublishNotice(null), true, 'no user: always shown')
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

test('Settings toggle is wired per signed-in user and translated', () => {
  const mainSource = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8')
  const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const i18nSource = fs.readFileSync(new URL('./i18n.js', import.meta.url), 'utf8')
  assert.match(indexSource, /<input type="checkbox" id="settings-publish-notice-toggle" checked>/)
  assert.match(mainSource, /setShowPublishNotice\(state\.user\?\.id, !!event\.currentTarget\.checked\)/)
  assert.match(mainSource, /publishNoticeToggle\.checked = getShowPublishNotice\(state\.user\?\.id\)/)
  assert.match(i18nSource, /setText\('#settings-publish-notice-label', 'settings\.showPublishNotice'\)/)
  assert.match(mainSource, /publishNoticeToggle\.disabled = !state\.user\?\.id/, 'disabled when signed out')
})

test('locales: German notice uses one register (du); shared-references labels match the notice', () => {
  const i18nSource = fs.readFileSync(new URL('./i18n.js', import.meta.url), 'utf8')
  const de = i18nSource.slice(i18nSource.indexOf('\n  de_DE: {'))
  const deNotice = de.split('\n').filter(line => /'(publishNotice\.|settings\.showPublishNotice)/.test(line)).join('\n')
  assert.doesNotMatch(deNotice, /\b(Sie|Ihr|Ihre|Ihren|Ihnen|Ihrer)\b/, 'no formal register in the German notice')
  const enKeys = [...i18nSource.slice(0, i18nSource.indexOf('\n  nb_NO: {')).matchAll(/'(sharedReferences\.[^']+)':/g)].map(m => m[1])
  assert.ok(enKeys.includes('sharedReferences.sectionTitle'))
  const titles = { sv_SE: 'Mina delade referenser', de_DE: 'Meine geteilten Referenzen' }
  for (const [locale, title] of Object.entries(titles)) {
    const start = i18nSource.indexOf(`\n  ${locale}: {`)
    const next = locale === 'sv_SE' ? i18nSource.indexOf('\n  de_DE: {') : i18nSource.length
    const block = i18nSource.slice(start, next)
    for (const key of enKeys) assert.ok(block.includes(`'${key}':`), `${locale} is missing ${key}`)
    assert.ok(block.includes(`'sharedReferences.sectionTitle': '${title}'`))
    assert.ok(block.includes(`„${title}“`) || block.includes(`i ${title}.`), `${locale} notice names ${title}`)
  }
})

function fakeClient({ row = null, images = [], rowError = false }) {
  return {
    from(table) {
      const result = table === 'observation_images'
        ? { data: images, error: null }
        : (rowError ? { data: null, error: { message: 'x' } } : { data: row, error: null })
      const chain = {
        select: () => chain, eq: () => chain, is: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
      }
      return chain
    },
  }
}
