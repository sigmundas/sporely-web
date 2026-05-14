import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInaturalistAuthorizationUrl,
  clearInatPendingState,
  completeInaturalistOAuthCallback,
  loadInatPendingState,
  loadInaturalistSession,
  parseInaturalistCallbackUrl,
  saveInatPendingState,
  setInatItem,
  INAT_ACCESS_TOKEN_KEY,
  INAT_API_TOKEN_EXPIRES_AT_KEY,
  INAT_API_TOKEN_KEY,
  INAT_PENDING_KEY,
  INAT_REDIRECT_URI,
  INAT_USER_ID_KEY,
  INAT_USERNAME_KEY,
  isWebInatOAuthConfigured,
} from './inaturalist.js'

function createMemoryStorage() {
  const data = new Map()
  return {
    async getItem(key) {
      return data.has(key) ? data.get(key) : null
    },
    async setItem(key, value) {
      data.set(key, String(value))
    },
    async removeItem(key) {
      data.delete(key)
    },
    snapshot() {
      return Object.fromEntries(data.entries())
    },
  }
}

// Mock platform.js for tests
let isNativeAppMock = false;
global.isNativeApp = () => isNativeAppMock;

function jsonResponse(body, ok = true) {
  return {
    ok,
    async json() {
      return body
    },
  }
}

test('builds a native iNaturalist authorization URL with the exact redirect URI', () => {
  isNativeAppMock = true; // Simulate native app for this test
  const url = new URL(buildInaturalistAuthorizationUrl({
    state: 'state-123',
    codeChallenge: 'challenge-abc',
    platform: 'android', // Explicitly pass platform
  }))

  assert.equal(url.origin, 'https://www.inaturalist.org')
  assert.equal(url.pathname, '/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), INAT_NATIVE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), INAT_REDIRECT_URI)
  assert.equal(url.searchParams.get('state'), 'state-123')
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-abc')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
})

test('saves and loads the pending PKCE state', async () => {
  const storage = createMemoryStorage()
  const pending = {
    state: 'state-abc',
    code_verifier: 'verifier-abc',
    redirect_uri: INAT_REDIRECT_URI,
    platform: 'android',
    created_at: 123456,
  }

  await saveInatPendingState(pending, storage)
  assert.deepEqual(await loadInatPendingState(storage), pending)
  await clearInatPendingState(storage)
  assert.equal(await loadInatPendingState(storage), null)
})

test('parses the native callback URL and ignores unrelated URLs', () => {
  const parsed = parseInaturalistCallbackUrl(`${INAT_REDIRECT_URI}?code=code-1&state=state-1`)
  assert.equal(parsed.kind, 'inat')
  assert.equal(parsed.matches_inat, true)
  assert.equal(parsed.has_code, true)
  assert.equal(parsed.has_state, true)
  assert.equal(parsed.code, 'code-1')
  assert.equal(parsed.state, 'state-1')

  const other = parseInaturalistCallbackUrl('https://example.com/callback?code=code-1&state=state-1')
  assert.equal(other.kind, 'other')
  assert.equal(other.matches_inat, false)
})

test('rejects a callback with the wrong state', async () => {
  const storage = createMemoryStorage()
  await saveInatPendingState({
    state: 'expected-state',
    code_verifier: 'verifier-1',
    redirect_uri: INAT_REDIRECT_URI,
    platform: 'android',
    created_at: 123,
  }, storage)

  await assert.rejects(
    completeInaturalistOAuthCallback(`${INAT_REDIRECT_URI}?code=code-1&state=wrong-state`, {
      storage,
      fetchImpl: async () => jsonResponse({}),
    }),
    /authorization state mismatch/i,
  )
})

test('completes the callback once and returns the saved session on duplicate delivery', async () => {
  const storage = createMemoryStorage()
  const calls = []

  await saveInatPendingState({
    state: 'expected-state',
    code_verifier: 'verifier-1',
    redirect_uri: INAT_REDIRECT_URI,
    platform: 'android',
    created_at: 123,
  }, storage)

  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/oauth/token')) {
      return jsonResponse({ access_token: 'access-123' })
    }
    if (url.endsWith('/users/api_token')) {
      return jsonResponse({ api_token: 'api-456' })
    }
    if (url.endsWith('/v1/users/me')) {
      return jsonResponse({ results: [{ login: 'fungi_fan', id: 42 }] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const callbackUrl = `${INAT_REDIRECT_URI}?code=code-1&state=expected-state`
  const first = await completeInaturalistOAuthCallback(callbackUrl, { storage, fetchImpl })
  const second = await completeInaturalistOAuthCallback(callbackUrl, { storage, fetchImpl })

  assert.equal(first.connected, true)
  assert.equal(first.username, 'fungi_fan')
  assert.equal(second.connected, true)
  assert.equal(second.username, 'fungi_fan')
  assert.equal(calls.filter(url => url.endsWith('/oauth/token')).length, 1)
  assert.equal(calls.filter(url => url.endsWith('/users/api_token')).length, 1)
  assert.equal(calls.filter(url => url.endsWith('/v1/users/me')).length, 1)
})

test('loads a connected iNaturalist session from persisted keys', async () => {
  const storage = createMemoryStorage()
  await setInatItem(INAT_ACCESS_TOKEN_KEY, 'access-123', storage)
  await setInatItem(INAT_API_TOKEN_KEY, 'api-456', storage)
  await setInatItem(INAT_API_TOKEN_EXPIRES_AT_KEY, '9999999999999', storage)
  await setInatItem(INAT_USERNAME_KEY, 'fungi_fan', storage)
  await setInatItem(INAT_USER_ID_KEY, '42', storage)

  const session = await loadInaturalistSession(storage)
  assert.equal(session.connected, true)
  assert.equal(session.logged_in, true)
  assert.equal(session.has_access_token, true)
  assert.equal(session.username, 'fungi_fan')
  assert.equal(session.user_id, '42')
})
