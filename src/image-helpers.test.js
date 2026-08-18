import test from 'node:test'
import assert from 'node:assert/strict'

import { imageHtml, wireImageFallback } from './image-helpers.js'
import { AUTH_STATE, setAuthState, _resetAuthStateForTests } from './auth-state.js'
import { state } from './state.js'

test('public authorized media remains a direct image URL', () => {
  const html = imageHtml({
    primaryUrl: 'https://upload.sporely.no/m/4960/thumb?v=1',
    fallbackUrl: null,
  }, 'photo', 'placeholder')

  assert.match(html, /src="https:\/\/upload\.sporely\.no\/m\/4960\/thumb\?v=1"/)
  assert.doesNotMatch(html, /data-protected-media-url/)
})

test('protected media exposes only its Worker URL for authenticated hydration', () => {
  const html = imageHtml({
    primaryUrl: null,
    fallbackUrl: null,
    protectedUrl: 'https://upload.sporely.no/m/4962/thumb?v=7',
  }, 'photo', 'placeholder')

  assert.match(html, /data-protected-media-url="https:\/\/upload\.sporely\.no\/m\/4962\/thumb\?v=7"/)
  assert.doesNotMatch(html, /media\.sporely\.no/)
  assert.doesNotMatch(html, /Bearer|secret-token/)
})

// ── Task 2 regression: unresolved identity + CACHED must NOT set img.src ──

function _stubKeyedImg({ publicUrl = '', protectedUrl = '' } = {}) {
  return {
    dataset: {
      mediaCache: '1',
      mediaKind: 'observation-thumb',
      mediaScope: 'public',
      mediaKey: 'obs/1.jpg',
      mediaVariant: 'thumb',
      mediaPublicUrl: publicUrl,
      ...(protectedUrl ? { mediaProtectedUrl: protectedUrl } : {}),
    },
    _src: null,
    set src(v) { this._src = String(v || '') },
    get src() { return this._src },
    removeAttribute(name) { if (name === 'src') this._src = null },
    addEventListener() {},
  }
}

function _stubRoot(images) {
  return {
    querySelectorAll(selector) {
      if (selector === 'img[data-media-cache="1"]') return images.filter(i => i.dataset.mediaCache === '1')
      return []
    },
  }
}

test('CACHED + keyed public media + unresolved identity: zero fetch, no src assignment', () => {
  // Simulate: state.user is unset (identity cannot resolve to a userId),
  // capability gate denies (CACHED). wireImageFallback must NOT assign
  // publicUrl to img.src and MUST NOT fire a fetch.
  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = () => { fetchCalls += 1; return Promise.reject(new Error('unexpected fetch')) }
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'user-a' })
  const previousUser = state.user
  state.user = null // force identity resolution failure

  try {
    const img = _stubKeyedImg({ publicUrl: 'https://media.example/x.jpg' })
    wireImageFallback(_stubRoot([img]))
    assert.equal(img.src, null, 'no src assignment when identity is unresolved and capability denies')
    assert.equal(fetchCalls, 0, 'zero remote fetch attempts')
  } finally {
    state.user = previousUser
    globalThis.fetch = previousFetch
    _resetAuthStateForTests()
  }
})

test('REAUTH_REQUIRED + keyed public media + unresolved identity: zero fetch, no src assignment', () => {
  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = () => { fetchCalls += 1; return Promise.reject(new Error('unexpected fetch')) }
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'user-a' })
  const previousUser = state.user
  state.user = null

  try {
    const img = _stubKeyedImg({ publicUrl: 'https://media.example/x.jpg' })
    wireImageFallback(_stubRoot([img]))
    assert.equal(img.src, null)
    assert.equal(fetchCalls, 0)
  } finally {
    state.user = previousUser
    globalThis.fetch = previousFetch
    _resetAuthStateForTests()
  }
})

test('COMPLETE + keyed public media + unresolved identity: publicUrl fallback IS applied', () => {
  // The online-display fallback is preserved when the capability gate
  // allows network use — this is the "cache misses must not break online
  // display fallback" invariant for cases where the cache cannot own the
  // render (e.g. no user id at wire time).
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'user-a' })
  const previousUser = state.user
  state.user = null // still unresolved (userId not yet bound to state)

  try {
    const img = _stubKeyedImg({ publicUrl: 'https://media.example/x.jpg' })
    wireImageFallback(_stubRoot([img]))
    assert.equal(img.src, 'https://media.example/x.jpg')
  } finally {
    state.user = previousUser
    _resetAuthStateForTests()
  }
})
