import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getSupabaseOAuthRedirectUrl,
  handleUrlHashError,
  initAuth,
  maybeHandleSupabaseOAuthCallback,
  switchToLogin,
} from './auth.js'
import { clearSharedAuthSessionCache, getSharedAuthSession } from '../auth-session.js'
import { supabase } from '../supabase.js'
import {
  _setDefaultSocialLoginImplForTests,
  _setGoogleWebClientIdForTests,
} from '../google-auth.js'
import { resetNativeOAuthStateForTests } from '../native-oauth.js'

function createAuthElement() {
  const listeners = {}
  return {
    style: {},
    dataset: {},
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    addEventListener(type, handler) {
      listeners[type] = handler
    },
    dispatch(type, event = {}) {
      return listeners[type]?.(event)
    },
  }
}

function installAuthDom(platform = 'android') {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousSignInWithOAuth = supabase.auth.signInWithOAuth

  const elements = {}
  const getElement = id => {
    if (!elements[id]) elements[id] = createAuthElement()
    return elements[id]
  }

  globalThis.window = {
    location: new URL('https://app.sporely.no/'),
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
    },
  }
  globalThis.document = {
    getElementById(id) {
      return getElement(id)
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    body: { dataset: {} },
  }

  return {
    elements,
    restore() {
      globalThis.document = previousDocument
      globalThis.window = previousWindow
      supabase.auth.signInWithOAuth = previousSignInWithOAuth
    },
  }
}

function createHistoryMock() {
  const calls = []
  const history = {
    state: { source: 'test' },
    replaceState(...args) {
      calls.push(args)
    },
  }

  return { history, calls }
}

test('builds the Supabase OAuth callback URL from an explicit origin', () => {
  assert.equal(
    getSupabaseOAuthRedirectUrl('https://example.com'),
    'https://example.com/auth/callback'
  )
})

test('exchanges a Supabase OAuth code, seeds the shared session, and cleans the callback url', async () => {
  clearSharedAuthSessionCache()

  const previousHistory = globalThis.history
  const { history, calls } = createHistoryMock()
  globalThis.history = history

  const exchangeCalls = []
  const fakeSession = { user: { id: 'user-123', email: 'new@example.com' } }
  const fakeClient = {
    auth: {
      async exchangeCodeForSession(code) {
        exchangeCalls.push(code)
        return { data: { session: fakeSession }, error: null }
      },
    },
  }

  try {
    const result = await maybeHandleSupabaseOAuthCallback(
      'https://app.sporely.no/auth/callback?code=code-abc',
      { supabaseClient: fakeClient }
    )

    assert.equal(result.handled, true)
    assert.equal(result.status, 'success')
    assert.deepEqual(result.session, fakeSession)
    assert.deepEqual(exchangeCalls, ['code-abc'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0][2], '/')

    const seededSession = await getSharedAuthSession()
    assert.deepEqual(seededSession, fakeSession)
  } finally {
    globalThis.history = previousHistory
    clearSharedAuthSessionCache()
  }
})

test('returns a clean error for provider-denied Supabase OAuth callbacks', async () => {
  clearSharedAuthSessionCache()

  const previousHistory = globalThis.history
  const { history, calls } = createHistoryMock()
  globalThis.history = history

  const fakeClient = {
    auth: {
      async exchangeCodeForSession() {
        throw new Error('exchange should not run for provider errors')
      },
    },
  }

  try {
    const result = await maybeHandleSupabaseOAuthCallback(
      'https://app.sporely.no/auth/callback?error=access_denied&error_description=Denied%20by%20Google',
      { supabaseClient: fakeClient }
    )

    assert.equal(result.handled, true)
    assert.equal(result.status, 'error')
    assert.equal(result.errorMessage, 'Denied by Google')
    assert.match(result.error.message, /Denied by Google/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][2], '/')
    assert.equal(result.session, undefined)
  } finally {
    globalThis.history = previousHistory
    clearSharedAuthSessionCache()
  }
})

test('legacy auth hash handling ignores the Supabase OAuth callback route', () => {
  const previousWindow = globalThis.window
  globalThis.window = {
    location: new URL('https://app.sporely.no/auth/callback?error=access_denied&error_description=Denied'),
  }

  try {
    assert.equal(handleUrlHashError(), false)
  } finally {
    globalThis.window = previousWindow
  }
})

test('android with missing Google client id never opens the browser OAuth flow', async () => {
  const harness = installAuthDom('android')
  _setGoogleWebClientIdForTests(null)
  _setDefaultSocialLoginImplForTests(null)
  const oauthCalls = []
  const idTokenCalls = []
  const originalSignInWithOAuth = supabase.auth.signInWithOAuth
  const originalSignInWithIdToken = supabase.auth.signInWithIdToken
  supabase.auth.signInWithOAuth = async payload => {
    oauthCalls.push(payload)
    return { error: null }
  }
  supabase.auth.signInWithIdToken = async payload => {
    idTokenCalls.push(payload)
    return { data: { session: null, user: null }, error: null }
  }

  try {
    initAuth(() => {}, true)

    assert.equal(harness.elements['auth-social-login'].style.display, 'flex')

    await harness.elements['google-login-btn'].dispatch('click', {
      preventDefault() {},
    })

    assert.equal(oauthCalls.length, 0, 'browser OAuth must never be called on native Android')
    assert.equal(idTokenCalls.length, 0, 'signInWithIdToken must not run without a client id')
    assert.equal(harness.elements['google-login-btn'].disabled, false, 'button must be re-enabled after config error')
    assert.equal(harness.elements['auth-error'].style.display, 'block')
  } finally {
    supabase.auth.signInWithOAuth = originalSignInWithOAuth
    supabase.auth.signInWithIdToken = originalSignInWithIdToken
    harness.restore()
  }
})

test('android with configured native Google login exchanges ID token via signInWithIdToken', async () => {
  const harness = installAuthDom('android')
  resetNativeOAuthStateForTests({ clearProviders: true })
  _setGoogleWebClientIdForTests('test-google-web-client-id.apps.googleusercontent.com')

  const socialLoginCalls = []
  const socialLogin = {
    async initialize(config) {
      socialLoginCalls.push({ method: 'initialize', config })
    },
    async login(options) {
      socialLoginCalls.push({ method: 'login', options })
      return { provider: 'google', result: { idToken: 'id-token-xyz' } }
    },
  }
  _setDefaultSocialLoginImplForTests(socialLogin)

  const oauthCalls = []
  const idTokenCalls = []
  const originalSignInWithOAuth = supabase.auth.signInWithOAuth
  const originalSignInWithIdToken = supabase.auth.signInWithIdToken
  supabase.auth.signInWithOAuth = async payload => {
    oauthCalls.push(payload)
    return { error: null }
  }
  const session = { access_token: 'sb-token', user: { id: 'user-42', email: 'a@b.co' } }
  supabase.auth.signInWithIdToken = async payload => {
    idTokenCalls.push(payload)
    return { data: { session, user: session.user }, error: null }
  }

  const authenticatedWith = []
  try {
    initAuth(sess => authenticatedWith.push(sess), true)

    await harness.elements['google-login-btn'].dispatch('click', {
      preventDefault() {},
    })

    assert.equal(oauthCalls.length, 0, 'native path must not invoke signInWithOAuth')
    assert.equal(idTokenCalls.length, 1)
    assert.deepEqual(idTokenCalls[0], { provider: 'google', token: 'id-token-xyz' })
    assert.equal(socialLoginCalls[0].method, 'initialize')
    assert.equal(socialLoginCalls[1].method, 'login')
    assert.deepEqual(socialLoginCalls[1].options, {
      provider: 'google',
      options: {},
    })
    assert.equal(authenticatedWith.length, 1)
    assert.equal(authenticatedWith[0].user.id, 'user-42')
  } finally {
    supabase.auth.signInWithOAuth = originalSignInWithOAuth
    supabase.auth.signInWithIdToken = originalSignInWithIdToken
    _setDefaultSocialLoginImplForTests(null)
    _setGoogleWebClientIdForTests(null)
    resetNativeOAuthStateForTests({ clearProviders: true })
    harness.restore()
  }
})

test('switchToLogin keeps social login hidden on iOS native', () => {
  const harness = installAuthDom('ios')

  try {
    switchToLogin()
    assert.equal(harness.elements['auth-social-login'].style.display, 'none')
  } finally {
    harness.restore()
  }
})
