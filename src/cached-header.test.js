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

test('renderCachedHeaderProfileButtons NEVER paints an http(s) URL synchronously', () => {
  // Stage B FINAL invariant: even a benign-looking public avatar URL must
  // NOT be assigned to <img src> at the cached-boot reveal — a plain
  // `<img src="…">` triggers a browser-level GET, which violates the
  // "zero avatar network in CACHED / REAUTH" rule. Initials render only;
  // the async cache paint (see media-avatar.test.js) is the sole path
  // that ever swaps in an avatar image, and it uses a `blob:` object URL.
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
    assert.equal(img.src, null, 'public URL is refused synchronously in cached boot')
    assert.equal(img.style.display, 'none')
    assert.equal(label.style.display, '')
    assert.equal(label.textContent, 'A')
  } finally {
    state.user = previousUser
    harness.restore()
  }
})

test('renderCachedHeaderProfileButtons refuses signed URLs (backend-fetch would violate offline invariant)', () => {
  // Signed URLs must never appear in `img.src` during cached boot — they
  // require a token-bearing fetch that we know is failing (that is why we
  // are in cached mode in the first place). Same invariant as public URLs
  // now: initials only, async cache paint fills in the blob if any.
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

test('renderCachedHeaderProfileButtons paints initials across every header target (all four screens)', () => {
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
      // Stage B FINAL: img.src is NOT set to the public URL synchronously
      // (see the "never paints http" test above). Every header target
      // paints initials; an async cache paint (blob URL only) may later
      // swap them out.
      assert.equal(harness.elements[`${key}-img`].src, null, `${key} img has no direct src`)
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
