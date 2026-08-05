import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  beginAccountTransition,
  clearUserScopedUi,
  currentAccountGeneration,
  hideAccountTransitionBlocker,
  isCurrentAccountTransition,
  showAccountTransitionBlocker,
  _CLEARED_TEXT_IDS,
  _CLEARED_HTML_IDS,
  _AVATAR_IMG_IDS,
  _AVATAR_INITIALS_IDS,
  _resetForTests,
} from './account-transition.js'

beforeEach(() => { _resetForTests() })

test('beginAccountTransition increments and currentAccountGeneration reads it', () => {
  const g1 = beginAccountTransition()
  const g2 = beginAccountTransition()
  assert.equal(g2, g1 + 1)
  assert.equal(currentAccountGeneration(), g2)
})

test('isCurrentAccountTransition rejects stale generations', () => {
  const g1 = beginAccountTransition()
  assert.equal(isCurrentAccountTransition(g1, 'u1', 'u1'), true)
  beginAccountTransition()
  // Same expected/actual user, but generation moved on: stale.
  assert.equal(isCurrentAccountTransition(g1, 'u1', 'u1'), false)
})

test('isCurrentAccountTransition rejects mismatched user id', () => {
  const g = beginAccountTransition()
  assert.equal(isCurrentAccountTransition(g, 'u1', 'u2'), false)
})

// ── clearUserScopedUi ──────────────────────────────────────────────────

function fakeDoc() {
  const nodes = new Map()
  const make = (tag = 'div') => {
    const attrs = new Map()
    return {
      tagName: tag,
      textContent: '',
      innerHTML: '',
      value: '',
      style: { display: '' },
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: k => attrs.delete(k),
      getAttribute: k => attrs.get(k),
    }
  }
  return {
    getElementById: id => {
      if (!nodes.has(id)) return null
      return nodes.get(id)
    },
    _make: make,
    _install(id, tag = 'div') {
      const el = make(tag)
      nodes.set(id, el)
      return el
    },
    _installAll(ids, tag = 'div') {
      const map = {}
      for (const id of ids) map[id] = this._install(id, tag)
      return map
    },
  }
}

test('clearUserScopedUi blanks all mapped text/html containers and hides avatars', () => {
  const doc = fakeDoc()
  const textEls = doc._installAll(_CLEARED_TEXT_IDS.filter(id => !id.includes('username') && !id.includes('fullname') && !id.includes('bio')), 'DIV')
  const inputEls = {}
  for (const id of ['profile-username', 'profile-fullname']) {
    inputEls[id] = doc._install(id, 'INPUT')
    inputEls[id].value = 'stale-value'
  }
  inputEls['profile-bio'] = doc._install('profile-bio', 'TEXTAREA')
  inputEls['profile-bio'].value = 'stale-bio'

  const htmlEls = {}
  for (const id of _CLEARED_HTML_IDS) {
    htmlEls[id] = textEls[id] || doc._install(id)
    htmlEls[id].innerHTML = '<div>account A card</div>'
    htmlEls[id].textContent = 'A'
  }
  for (const [id, el] of Object.entries(textEls)) {
    el.textContent = `A-${id}`
  }

  const imgEls = doc._installAll(_AVATAR_IMG_IDS, 'IMG')
  for (const el of Object.values(imgEls)) {
    el.setAttribute('src', 'blob:accountA-avatar')
    el.style.display = 'block'
  }
  const initialsEls = doc._installAll(_AVATAR_INITIALS_IDS)
  for (const el of Object.values(initialsEls)) {
    el.textContent = 'AA'
    el.style.display = 'none'
  }

  clearUserScopedUi(doc)

  for (const [id, el] of Object.entries(htmlEls)) {
    assert.equal(el.innerHTML, '', `${id} innerHTML must be cleared`)
  }
  for (const [id, el] of Object.entries(textEls)) {
    if (_CLEARED_HTML_IDS.includes(id)) continue // already asserted via innerHTML
    assert.equal(el.textContent, '', `${id} textContent must be cleared`)
  }
  for (const [id, el] of Object.entries(inputEls)) {
    assert.equal(el.value, '', `${id} form value must be cleared`)
  }
  for (const [id, el] of Object.entries(imgEls)) {
    assert.equal(el.getAttribute('src'), undefined, `${id} src must be dropped`)
    assert.equal(el.style.display, 'none', `${id} must be hidden`)
  }
  for (const [id, el] of Object.entries(initialsEls)) {
    assert.equal(el.textContent, '', `${id} initials must be cleared`)
    assert.equal(el.style.display, '', `${id} initials must be shown again`)
  }
})

test('clearUserScopedUi tolerates missing document / missing ids', () => {
  clearUserScopedUi(null)                     // no doc
  const doc = fakeDoc()
  clearUserScopedUi(doc)                      // no installed ids
})

// ── blocker toggling ──────────────────────────────────────────────────

test('showAccountTransitionBlocker / hideAccountTransitionBlocker toggle display', () => {
  const doc = fakeDoc()
  const el = doc._install('account-transition-overlay')
  el.style.display = 'none'
  showAccountTransitionBlocker(doc)
  assert.equal(el.style.display, 'flex')
  hideAccountTransitionBlocker(doc)
  assert.equal(el.style.display, 'none')
})

test('blocker toggles are no-ops when the element is missing', () => {
  const doc = fakeDoc()
  showAccountTransitionBlocker(doc)
  hideAccountTransitionBlocker(doc)
  // no throw
})
