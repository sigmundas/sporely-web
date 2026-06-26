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

test('android native auth keeps Google sign-in visible and clickable', async () => {
  const harness = installAuthDom('android')
  const oauthCalls = []
  const originalSignInWithOAuth = supabase.auth.signInWithOAuth
  supabase.auth.signInWithOAuth = async payload => {
    oauthCalls.push(payload)
    return { error: null }
  }

  try {
    initAuth(() => {}, true)

    assert.equal(harness.elements['auth-social-login'].style.display, 'flex')

    await harness.elements['google-login-btn'].dispatch('click', {
      preventDefault() {},
    })

    assert.equal(oauthCalls.length, 1)
    assert.equal(oauthCalls[0].provider, 'google')
    assert.match(String(oauthCalls[0].options?.redirectTo || ''), /\/auth\/callback$/)
  } finally {
    supabase.auth.signInWithOAuth = originalSignInWithOAuth
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
