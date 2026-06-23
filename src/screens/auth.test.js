import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getSupabaseOAuthRedirectUrl,
  handleUrlHashError,
  maybeHandleSupabaseOAuthCallback,
} from './auth.js'
import { clearSharedAuthSessionCache, getSharedAuthSession } from '../auth-session.js'

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
