// Publish notice: drives the real change handlers and the find-detail save
// with a minimal fake DOM, plus the dialog's Cancel/Escape/focus behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from './auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import { supabase } from './supabase.js'
import { setLocale, t } from './i18n.js'
import { state } from './state.js'
import {
  buildPublishNoticeModel,
  confirmPublishIfNeeded,
  needsPublishNotice,
  showPublishNoticeDialog,
} from './publish-notice.js'
import {
  __setReviewPublishNoticeOptionsForTests,
  _handleReviewDraftChange,
  _handleReviewObscuredChange,
  _handleReviewVisibilityChange,
} from './screens/review.js'
import {
  __setImportAiSessionsForTests,
  __setImportAiTestHooks,
  __setImportPublishNoticeOptionsForTests,
  _handleImportDraftChange,
  _handleImportPrecisionChange,
  _handleImportVisibilityChange,
} from './screens/import_review.js'
import {
  __saveDetailForTests,
  __setDetailPublishTestState,
  detailLocationPrecisionForSave,
  detailPrecisionIsObscured,
} from './screens/find_detail.js'

setLocale('en')

// ── Minimal fake DOM ──────────────────────────────────────────────────────

function classList(initial = []) {
  const set = new Set(initial)
  return {
    add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
    toggle: (c, on) => { if (on ?? !set.has(c)) set.add(c); else set.delete(c) },
  }
}

function el({ id = '', name = '', value = '', checked = false, classes = [], dataset = {}, parent = null } = {}) {
  const node = {
    id, name, value, checked, disabled: false, dataset, parent, children: [],
    classList: classList(classes), style: {}, textContent: '',
    closest(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null
      for (let n = this; n; n = n.parent) if (cls && n.classList.contains(cls)) return n
      return null
    },
    querySelectorAll(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null
      const out = []
      const walk = n => n.children.forEach(c => { if (cls && c.classList.contains(cls)) out.push(c); walk(c) })
      walk(this)
      return out
    },
    focus() { focused = this },
  }
  if (parent) parent.children.push(node)
  return node
}
let focused = null

function radioGroup({ name, values, checkedValue, inputClass, dataset = {} }) {
  const group = el({ classes: ['scope-tabs'] })
  const radios = values.map(value => {
    const tab = el({ classes: ['scope-tab', ...(value === checkedValue ? ['active'] : [])], parent: group })
    return el({ name, value, checked: value === checkedValue, classes: inputClass ? [inputClass] : [], dataset, parent: tab })
  })
  return { group, radios }
}

function installDocument(byId = {}, inputs = []) {
  const previous = globalThis.document
  globalThis.document = {
    getElementById: id => byId[id] || null,
    querySelectorAll(selector) {
      const m = /^input\[name="([^"]+)"\]$/.exec(selector)
      return m ? inputs.filter(i => i.name === m[1]) : []
    },
    querySelector(selector) {
      const m = /^input\[name="([^"]+)"\]:checked$/.exec(selector)
      return m ? inputs.find(i => i.name === m[1] && i.checked) || null : null
    },
    createElement: () => el(),
  }
  return () => { globalThis.document = previous }
}

function dialogRecorder(answer) {
  const calls = []
  return { calls, showDialog: async model => { calls.push(model); return answer } }
}

// ── review.js ─────────────────────────────────────────────────────────────

test('review visibility: Cancel keeps captureDraft and restores the radios', async () => {
  const { radios } = radioGroup({ name: 'review-vis', values: ['private', 'friends', 'public'], checkedValue: 'private' })
  const restore = installDocument({}, radios)
  const dialog = dialogRecorder(false)
  __setReviewPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  state.capturedPhotos = []
  state.captureDraft = { visibility: 'private', is_draft: false, location_precision: 'fuzzed' }
  try {
    radios[0].checked = false
    radios[2].checked = true
    await _handleReviewVisibilityChange({ target: radios[2] })
    assert.equal(dialog.calls.length, 1)
    assert.equal(state.captureDraft.visibility, 'private')
    assert.equal(radios[0].checked, true)
    assert.equal(radios[2].checked, false)
    assert.ok(radios[0].closest('.scope-tab').classList.contains('active'))
    assert.ok(dialog.calls[0].exposed.includes(t('publishNotice.locationFuzzed')))
  } finally { restore(); __setReviewPublishNoticeOptionsForTests(undefined) }
})

test('review visibility: Publish applies; non-publishing change shows nothing', async () => {
  const { radios } = radioGroup({ name: 'review-vis', values: ['private', 'friends', 'public'], checkedValue: 'private' })
  const restore = installDocument({}, radios)
  const dialog = dialogRecorder(true)
  __setReviewPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  state.captureDraft = { visibility: 'private', is_draft: true, location_precision: 'exact' }
  try {
    radios[2].checked = true
    await _handleReviewVisibilityChange({ target: radios[2] })
    assert.equal(dialog.calls.length, 0, 'still a draft: no notice')
    assert.equal(state.captureDraft.visibility, 'public')
  } finally { restore(); __setReviewPublishNoticeOptionsForTests(undefined) }
})

test('review draft toggle: Cancel re-checks draft and keeps state', async () => {
  const toggle = el({ id: 'review-draft', checked: false })
  const restore = installDocument({ 'review-draft': toggle })
  const dialog = dialogRecorder(false)
  __setReviewPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  state.captureDraft = { visibility: 'public', is_draft: true, location_precision: 'exact' }
  try {
    await _handleReviewDraftChange({ target: toggle })
    assert.equal(dialog.calls.length, 1)
    assert.equal(toggle.checked, true)
    assert.equal(state.captureDraft.is_draft, true)
  } finally { restore(); __setReviewPublishNoticeOptionsForTests(undefined) }
})

test('review precision: approximate -> exact on a public item re-confirms; Cancel keeps fuzzed', async () => {
  const obscured = el({ id: 'review-obscured', checked: false })
  const restore = installDocument({ 'review-obscured': obscured })
  const dialog = dialogRecorder(false)
  __setReviewPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  state.captureDraft = { visibility: 'public', is_draft: false, location_precision: 'fuzzed' }
  try {
    await _handleReviewObscuredChange({ target: obscured })
    assert.equal(dialog.calls.length, 1)
    assert.equal(dialog.calls[0].title, t('publishNotice.precisionTitle'))
    assert.match(dialog.calls[0].intro, /^After the next sync, .*the exact location/)
    assert.equal(state.captureDraft.location_precision, 'fuzzed')
    assert.equal(obscured.checked, true)
    // exact -> fuzzed needs no notice
    state.captureDraft.location_precision = 'exact'
    obscured.checked = true
    await _handleReviewObscuredChange({ target: obscured })
    assert.equal(dialog.calls.length, 1)
    assert.equal(state.captureDraft.location_precision, 'fuzzed')
  } finally { restore(); __setReviewPublishNoticeOptionsForTests(undefined) }
})

// ── import_review.js ──────────────────────────────────────────────────────

test('import draft checkbox: Cancel re-checks and leaves the session', async () => {
  const persisted = []
  __setImportAiTestHooks({ persistSessions: s => persisted.push(s) })
  const session = { id: 's1', visibility: 'public', is_draft: true, location_precision: 'exact' }
  __setImportAiSessionsForTests([session])
  const dialog = dialogRecorder(false)
  __setImportPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  const input = el({ checked: false, dataset: { sid: 's1' } })
  try {
    await _handleImportDraftChange(input)
    assert.equal(dialog.calls.length, 1)
    assert.equal(input.checked, true)
    assert.equal(session.is_draft, true)
    assert.equal(persisted.length, 0)
  } finally { __setImportPublishNoticeOptionsForTests(undefined); __setImportAiTestHooks(null) }
})

test('import visibility: Cancel restores the radios and leaves the session', async () => {
  __setImportAiTestHooks({ persistSessions: () => {} })
  const session = { id: 's2', visibility: 'friends', is_draft: false, location_precision: 'exact' }
  __setImportAiSessionsForTests([session])
  const dialog = dialogRecorder(false)
  __setImportPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  const { radios } = radioGroup({ name: 'vis-s2', values: ['private', 'friends', 'public'], checkedValue: 'friends', inputClass: 'import-vis-radio', dataset: { sid: 's2' } })
  try {
    radios[1].checked = false
    radios[2].checked = true
    await _handleImportVisibilityChange(radios[2])
    assert.equal(dialog.calls.length, 1)
    assert.equal(session.visibility, 'friends')
    assert.equal(radios[1].checked, true)
    assert.equal(radios[2].checked, false)
  } finally { __setImportPublishNoticeOptionsForTests(undefined); __setImportAiTestHooks(null) }
})

// ── find_detail.js _save ──────────────────────────────────────────────────

function detailDom({ draft, visibility, obscured }) {
  const { radios } = radioGroup({ name: 'detail-vis', values: ['private', 'friends', 'public'], checkedValue: visibility })
  const byId = {
    'detail-save-btn': el({ id: 'detail-save-btn' }),
    'detail-location': el({ value: 'Secret spot' }),
    'detail-habitat': el({ value: '' }),
    'detail-notes': el({ value: '' }),
    'detail-uncertain': el({ checked: false }),
    'detail-draft': el({ checked: draft }),
    'detail-obscured': el({ checked: obscured }),
    'detail-taxon-input': el({ value: '' }),
    toast: el({ id: 'toast' }),
  }
  return { byId, radios, restore: installDocument(byId, radios) }
}

function recordSupabase() {
  const writes = []
  const original = supabase.from
  const originalRpc = supabase.rpc
  supabase.from = table => {
    const chain = {
      select: () => chain, eq: () => chain, is: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: { spore_data_visibility: 'public', selected_sporely_taxon_id: null }, error: null }),
      update: patch => { writes.push({ table, patch }); return { eq: () => ({ eq: () => Promise.resolve({ error: { message: 'stop here' } }) }) } },
    }
    return chain
  }
  supabase.rpc = async () => ({ data: { status: 'ok', contributions: [] }, error: null })
  return { writes, restore: () => { supabase.from = original; supabase.rpc = originalRpc } }
}

test('find detail save: Cancel writes nothing and restores the controls', async () => {
  state.user = { id: 'owner-1' }
  const obs = { id: 5, user_id: 'owner-1', visibility: 'public', is_draft: true, location_precision: 'fuzzed' }
  const dom = detailDom({ draft: false, visibility: 'public', obscured: false })
  const db = recordSupabase()
  const dialog = dialogRecorder(false)
  __setDetailPublishTestState({ obs, isOwner: true, publishNoticeOptions: { showDialog: dialog.showDialog } })
  try {
    await __saveDetailForTests()
    assert.equal(dialog.calls.length, 1)
    assert.deepEqual(db.writes, [])
    assert.equal(dom.byId['detail-draft'].checked, true)
    assert.equal(dom.byId['detail-obscured'].checked, true)
    assert.equal(dom.byId['detail-save-btn'].disabled, false)
  } finally { dom.restore(); db.restore(); __setDetailPublishTestState() }
})

test('find detail save: Publish proceeds to the write; already-public save shows nothing', async () => {
  state.user = { id: 'owner-1' }
  const db = recordSupabase()
  const dialog = dialogRecorder(true)
  let dom = detailDom({ draft: false, visibility: 'public', obscured: false })
  __setDetailPublishTestState({ obs: { id: 6, user_id: 'owner-1', visibility: 'private', is_draft: false, location_precision: 'exact' }, publishNoticeOptions: { showDialog: dialog.showDialog } })
  try {
    await __saveDetailForTests()
    assert.equal(dialog.calls.length, 1)
    assert.match(dialog.calls[0].intro, /^After you save, /, 'detail edits write directly')
    assert.equal(db.writes.filter(w => w.table === 'observations').length, 1)
    dom.restore()
    dom = detailDom({ draft: false, visibility: 'public', obscured: false })
    __setDetailPublishTestState({ obs: { id: 7, user_id: 'owner-1', visibility: 'public', is_draft: false, location_precision: 'exact' }, publishNoticeOptions: { showDialog: dialog.showDialog } })
    await __saveDetailForTests()
    assert.equal(dialog.calls.length, 1, 'already public, stays public')
  } finally { dom.restore(); db.restore(); __setDetailPublishTestState() }
})

// ── rules ─────────────────────────────────────────────────────────────────

test('precision increase on a public item needs a notice; decrease does not', () => {
  const pub = { visibility: 'public', is_draft: false }
  assert.equal(needsPublishNotice({ ...pub, location_precision: 'fuzzed' }, { ...pub, location_precision: 'exact' }), true)
  assert.equal(needsPublishNotice({ ...pub, location_precision: 'exact' }, { ...pub, location_precision: 'fuzzed' }), false)
  assert.equal(needsPublishNotice({ ...pub, location_precision: 'exact' }, { ...pub, location_precision: 'exact' }), false)
})

test('photo location caveat: approximate location unless every image is known safe', async () => {
  const model = safe => buildPublishNoticeModel({ locationPrecision: 'fuzzed', sporeDataVisibility: 'public', imagesExifSafe: safe })
  const caveat = t('publishNotice.photoLocationCaveat')
  assert.ok(model(false).notes.includes(caveat))
  assert.ok(model(undefined).notes.includes(caveat), 'unknown shows the caveat')
  assert.ok(!model(true).notes.includes(caveat))
  assert.ok(!buildPublishNoticeModel({ locationPrecision: 'exact', imagesExifSafe: false }).notes.includes(caveat))
  const seen = []
  await confirmPublishIfNeeded({ visibility: 'private', is_draft: false }, { visibility: 'public', is_draft: false, location_precision: 'fuzzed' }, {
    loadFacts: async () => ({ sporeDataVisibility: 'public', imagesExifSafe: false }),
    showDialog: async m => { seen.push(m); return false },
  })
  assert.ok(seen[0].notes.includes(caveat))
})

test('simplified notice: no comments line; hidden spore wording', () => {
  const m = buildPublishNoticeModel({ locationPrecision: 'exact', sporeDataVisibility: 'private', imagesExifSafe: true })
  assert.ok(!m.exposed.includes(t('publishNotice.sporeData')))
  assert.ok(m.notes.includes('Spore measurements stay hidden.'))
  assert.ok(m.exposed.includes(t('publishNotice.media')), 'microscope photos stay public')
  assert.doesNotMatch([...m.exposed, ...m.notes].join('\n'), /comment/i)
})

// ── dialog ────────────────────────────────────────────────────────────────

function fakeDialogDocument() {
  const listeners = {}
  const appended = []
  const opener = { focus() { focused = opener } }
  focused = opener
  const doc = {
    activeElement: opener,
    body: { appendChild: node => appended.push(node) },
    addEventListener: (type, fn) => { listeners[type] = fn },
    removeEventListener: type => { delete listeners[type] },
    createElement() {
      const buttons = {}
      let html = ''
      const overlay = {
        removed: false,
        set innerHTML(value) {
          html = value
          for (const action of ['cancel', 'publish']) {
            if (html.includes(`data-publish-notice="${action}"`)) {
              buttons[action] = { dataset: { publishNotice: action }, focus() { focused = this }, closest() { return this } }
            }
          }
        },
        clickListener: null,
        addEventListener(type, fn) { if (type === 'click') this.clickListener = fn },
        dontShow: { checked: false },
        querySelector(sel) {
          if (sel === '[data-publish-notice-dont-show]') return html.includes('data-publish-notice-dont-show') ? this.dontShow : null
          return buttons[/"(\w+)"/.exec(sel)[1]] || null
        },
        remove() { this.removed = true },
        buttons,
      }
      return overlay
    },
  }
  return { doc, listeners, appended, opener }
}

test('dialog: Escape cancels, focus goes to Cancel and returns to the opener', async () => {
  const { doc, listeners, appended, opener } = fakeDialogDocument()
  const model = buildPublishNoticeModel({ locationPrecision: 'exact' })
  const pending = showPublishNoticeDialog(model, doc)
  const overlay = appended[0]
  assert.equal(focused, overlay.buttons.cancel)
  listeners.keydown({ key: 'Escape', preventDefault() {} })
  assert.equal(await pending, false)
  assert.equal(overlay.removed, true)
  assert.equal(focused, opener)
  assert.equal(listeners.keydown, undefined)
})

test('dialog: Publish button resolves true; Cancel button false', async () => {
  for (const [action, expected] of [['publish', true], ['cancel', false]]) {
    const { doc, appended } = fakeDialogDocument()
    const pending = showPublishNoticeDialog(buildPublishNoticeModel({ locationPrecision: 'exact' }), doc)
    const overlay = appended[0]
    overlay.clickListener({ target: overlay.buttons[action] })
    assert.equal(await pending, expected)
  }
})

test("dialog: Don't show this again is reported only on Publish", async () => {
  for (const [action, checked, expectedCalls] of [['publish', true, 1], ['publish', false, 0], ['cancel', true, 0]]) {
    const { doc, appended } = fakeDialogDocument()
    let calls = 0
    const pending = showPublishNoticeDialog(buildPublishNoticeModel({ locationPrecision: 'exact' }), doc, { onDontShowAgain: () => { calls += 1 } })
    const overlay = appended[0]
    overlay.dontShow.checked = checked
    overlay.clickListener({ target: overlay.buttons[action] })
    await pending
    assert.equal(calls, expectedCalls, `${action} checked=${checked}`)
  }
})

// ── location precision levels ─────────────────────────────────────────────

test('more precise location on a public item needs a notice at every level', () => {
  const pub = { visibility: 'public', is_draft: false }
  const at = p => ({ ...pub, location_precision: p })
  for (const [from, to] of [['hidden', 'exact'], ['region', 'exact'], ['fuzzed', 'exact'], ['hidden', 'fuzzed'], ['region', 'fuzzed'], ['hidden', 'region']]) {
    assert.equal(needsPublishNotice(at(from), at(to)), true, `${from} -> ${to}`)
  }
  for (const [from, to] of [['exact', 'fuzzed'], ['fuzzed', 'hidden'], ['hidden', 'hidden'], ['region', 'region']]) {
    assert.equal(needsPublishNotice(at(from), at(to)), false, `${from} -> ${to}`)
  }
})

test('find detail keeps a stored hidden/region precision while the box stays checked', () => {
  assert.equal(detailPrecisionIsObscured('hidden'), true)
  assert.equal(detailPrecisionIsObscured('region'), true)
  assert.equal(detailLocationPrecisionForSave('hidden', true), 'hidden')
  assert.equal(detailLocationPrecisionForSave('region', true), 'region')
  assert.equal(detailLocationPrecisionForSave('exact', true), 'fuzzed')
  assert.equal(detailLocationPrecisionForSave('hidden', false), 'exact')
})

test('edit notes on a hidden public observation keeps hidden and shows no notice', async () => {
  state.user = { id: 'owner-1' }
  const db = recordSupabase()
  const dialog = dialogRecorder(true)
  // the screen shows a hidden observation as obscured (checked)
  const dom = detailDom({ draft: false, visibility: 'public', obscured: true })
  dom.byId['detail-notes'].value = 'new note'
  __setDetailPublishTestState({ obs: { id: 8, user_id: 'owner-1', visibility: 'public', is_draft: false, location_precision: 'hidden' }, publishNoticeOptions: { showDialog: dialog.showDialog } })
  try {
    await __saveDetailForTests()
    assert.equal(dialog.calls.length, 0)
    const write = db.writes.find(w => w.table === 'observations')
    assert.equal(write.patch.location_precision, 'hidden')
    assert.equal(write.patch.notes, 'new note')
  } finally { dom.restore(); db.restore(); __setDetailPublishTestState() }
})

test('find detail: unchecking obscured on a fuzzed public observation shows the notice', async () => {
  state.user = { id: 'owner-1' }
  const db = recordSupabase()
  const dialog = dialogRecorder(false)
  const dom = detailDom({ draft: false, visibility: 'public', obscured: false })
  __setDetailPublishTestState({ obs: { id: 9, user_id: 'owner-1', visibility: 'public', is_draft: false, location_precision: 'fuzzed' }, publishNoticeOptions: { showDialog: dialog.showDialog } })
  try {
    await __saveDetailForTests()
    assert.equal(dialog.calls.length, 1)
    assert.deepEqual(db.writes, [])
    assert.equal(dom.byId['detail-obscured'].checked, true)
  } finally { dom.restore(); db.restore(); __setDetailPublishTestState() }
})

test('import obscure checkbox: approximate -> exact on a public item re-confirms; Cancel keeps it', async () => {
  const persisted = []
  __setImportAiTestHooks({ persistSessions: s => persisted.push(s) })
  const session = { id: 's3', visibility: 'public', is_draft: false, location_precision: 'fuzzed' }
  __setImportAiSessionsForTests([session])
  const dialog = dialogRecorder(false)
  __setImportPublishNoticeOptionsForTests({ showDialog: dialog.showDialog })
  const input = el({ checked: false, dataset: { sid: 's3' } })
  try {
    await _handleImportPrecisionChange(input)
    assert.equal(dialog.calls.length, 1)
    assert.equal(input.checked, true)
    assert.equal(session.location_precision, 'fuzzed')
    assert.equal(persisted.length, 0)
  } finally { __setImportPublishNoticeOptionsForTests(undefined); __setImportAiTestHooks(null) }
})
