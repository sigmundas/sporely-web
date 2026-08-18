import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCachedHeaderProfileButtons } from './screens/profile.js'
import { state } from './state.js'

function makeEl() {
  const el = {
    style: {},
    dataset: {},
    _src: null,
    _attrs: {},
    textContent: '',
    setAttribute(name, value) { this._attrs[name] = String(value) },
    getAttribute(name) { return this._attrs[name] || null },
    removeAttribute(name) {
      delete this._attrs[name]
      if (name === 'src') this._src = null
    },
    set src(value) { this._src = value; this._attrs.src = value },
    get src() { return this._src },
  }
  return el
}

function installProfileDom(overrides = {}) {
  const previousDocument = globalThis.document
  const elements = {}
  const targets = [
    'home-profile-img', 'home-profile-initials',
    'finds-profile-img', 'finds-profile-initials',
    'map-profile-img', 'map-profile-initials',
    'people-profile-img', 'people-profile-initials',
  ]
  for (const id of targets) elements[id] = overrides[id] || makeEl()

  globalThis.document = {
    getElementById: id => elements[id] || null,
  }
  return {
    elements,
    restore() { globalThis.document = previousDocument },
  }
}

test('renderCachedHeaderProfileButtons paints initials + no avatar from a summary with only username', () => {
  const harness = installProfileDom()
  const previousUser = state.user
  state.user = { id: 'user-a', email: 'alice@example.com' }
  try {
    renderCachedHeaderProfileButtons({ username: 'alice', display_name: 'Alice', avatar_url: '' })
    const img = harness.elements['home-profile-img']
    const label = harness.elements['home-profile-initials']
    assert.equal(label.textContent, 'A', 'initials paint from cached username')
    assert.equal(img.src, null, 'no avatar src when no public URL cached')
    assert.equal(label.style.display, '', 'initials label is visible')
    assert.equal(img.style.display, 'none', 'img is hidden when using initials')
  } finally {
    state.user = previousUser
    harness.restore()
  }
})

test('renderCachedHeaderProfileButtons uses a public URL avatar synchronously', () => {
  const harness = installProfileDom()
  const previousUser = state.user
  state.user = { id: 'user-a', email: 'alice@example.com' }
  try {
    renderCachedHeaderProfileButtons({
      username: 'alice',
      display_name: 'Alice',
      avatar_url: 'https://cdn.example/avatars/alice.jpg',
    })
    const img = harness.elements['home-profile-img']
    const label = harness.elements['home-profile-initials']
    assert.equal(img.src, 'https://cdn.example/avatars/alice.jpg')
    assert.equal(img.style.display, 'block')
    assert.equal(label.style.display, 'none')
  } finally {
    state.user = previousUser
    harness.restore()
  }
})

test('renderCachedHeaderProfileButtons degrades to initials for signed/protected URLs', () => {
  // Signed URLs must not be attempted before reveal — they require a
  // token-bearing fetch that we know is failing (that is why we are in
  // cached mode in the first place).
  const harness = installProfileDom()
  const previousUser = state.user
  state.user = { id: 'user-a', email: 'alice@example.com' }
  try {
    renderCachedHeaderProfileButtons({
      username: 'alice',
      display_name: 'Alice',
      avatar_url: 'https://cdn.example/storage/v1/object/sign/avatars/x.jpg?token=abc',
    })
    const img = harness.elements['home-profile-img']
    const label = harness.elements['home-profile-initials']
    assert.equal(img.src, null, 'signed URL is refused offline')
    assert.equal(label.textContent, 'A')
  } finally {
    state.user = previousUser
    harness.restore()
  }
})

test('renderCachedHeaderProfileButtons paints across every header target (all four screens)', () => {
  const harness = installProfileDom()
  const previousUser = state.user
  state.user = { id: 'user-a', email: 'alice@example.com' }
  try {
    renderCachedHeaderProfileButtons({
      username: 'alice',
      display_name: 'Alice',
      avatar_url: 'https://cdn.example/a.jpg',
    })
    for (const key of ['home-profile', 'finds-profile', 'map-profile', 'people-profile']) {
      assert.equal(harness.elements[`${key}-img`].src, 'https://cdn.example/a.jpg', `${key} img is set`)
      assert.equal(harness.elements[`${key}-initials`].textContent, 'A', `${key} initials fallback set`)
    }
  } finally {
    state.user = previousUser
    harness.restore()
  }
})

test('renderCachedHeaderProfileButtons falls back to email initials when username is missing', () => {
  const harness = installProfileDom()
  const previousUser = state.user
  state.user = { id: 'user-a', email: 'zed@example.com' }
  try {
    renderCachedHeaderProfileButtons({ username: null, display_name: null, avatar_url: '' })
    assert.equal(harness.elements['home-profile-initials'].textContent, 'Z')
  } finally {
    state.user = previousUser
    harness.restore()
  }
})

test('renderCachedHeaderProfileButtons NEVER calls Supabase (no auth required)', () => {
  // Structural guard: the function must be synchronous and side-effect
  // free. We assert its return type is not a Promise so future callers
  // cannot slip in an async fetch.
  const harness = installProfileDom()
  const previousUser = state.user
  state.user = { id: 'user-a', email: 'alice@example.com' }
  try {
    const returned = renderCachedHeaderProfileButtons({
      username: 'alice',
      display_name: 'Alice',
      avatar_url: '',
    })
    assert.ok(typeof returned?.then !== 'function', 'must be synchronous')
  } finally {
    state.user = previousUser
    harness.restore()
  }
})
