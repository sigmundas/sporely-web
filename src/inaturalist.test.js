import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INAT_ACCESS_TOKEN_KEY,
  INAT_ANDROID_CLIENT_ID,
  INAT_ANDROID_REDIRECT_URI,
  INAT_API_TOKEN_CREATED_AT_KEY,
  INAT_API_TOKEN_EXPIRES_AT_KEY,
  INAT_API_TOKEN_KEY,
  INAT_WEB_CLIENT_ID,
  INAT_WEB_REDIRECT_URI,
  buildInaturalistAuthorizationUrl,
  clearInatPendingState,
  completeInaturalistOAuthCallback,
  connectInaturalist,
  initializeInaturalistOAuth,
  loadInatPendingState,
  loadInaturalistSession,
  maybeHandleInaturalistOAuthReturn,
  normalizeCapgoOAuth2Result,
  parseInaturalistCallbackUrl,
  resetInaturalistOAuthStateForTests,
  saveInatPendingState,
  persistInaturalistSession,
  setInatItem,
  getInatItem,
  removeInatItem,
  INAT_USER_ID_KEY,
  INAT_USERNAME_KEY,
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

function createRuntimeStorageMocks({ platform = 'android', native = true } = {}) {
  const originalWindow = globalThis.window
  const originalCapacitor = globalThis.Capacitor
  const originalLocalStorage = globalThis.localStorage
  const localStorageCalls = {
    getItem: 0,
    setItem: 0,
    removeItem: 0,
  }
  const localStorageData = new Map()
  const windowStorageCalls = {
    get: 0,
    set: 0,
    remove: 0,
  }
  const windowStorageData = new Map()

  const capacitor = {
    isNativePlatform: () => native,
    getPlatform: () => platform,
  }

  const localStorage = {
    getItem(key) {
      localStorageCalls.getItem += 1
      return localStorageData.has(key) ? localStorageData.get(key) : null
    },
    setItem(key, value) {
      localStorageCalls.setItem += 1
      localStorageData.set(key, String(value))
    },
    removeItem(key) {
      localStorageCalls.removeItem += 1
      localStorageData.delete(key)
    },
  }
  const windowLocalStorage = {
    getItem(key) {
      windowStorageCalls.get += 1
      return windowStorageData.has(key) ? windowStorageData.get(key) : null
    },
    setItem(key, value) {
      windowStorageCalls.set += 1
      windowStorageData.set(key, String(value))
    },
    removeItem(key) {
      windowStorageCalls.remove += 1
      windowStorageData.delete(key)
    },
  }
  globalThis.localStorage = localStorage
  globalThis.window = { Capacitor: capacitor, localStorage: windowLocalStorage }
  globalThis.Capacitor = capacitor

  return {
    localStorageCalls,
    localStorageData,
    preferencesCalls: windowStorageCalls,
    preferencesData: windowStorageData,
    restore() {
      globalThis.window = originalWindow
      globalThis.Capacitor = originalCapacitor
      globalThis.localStorage = originalLocalStorage
    },
  }
}

function jsonResponse(body, ok = true) {
  return {
    ok,
    async json() {
      return body
    },
  }
}

async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Buffer.from(new Uint8Array(hash)).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

test('builds the web authorization URL with the web client and callback redirect', async () => {
  const storage = createMemoryStorage()
  const verifier = 'web-verifier-123'
  const state = 'web-state-123'
  const url = new URL(await buildInaturalistAuthorizationUrl({
    platform: 'web',
    state,
    codeVerifier: verifier,
    storage,
  }))

  assert.equal(url.origin, 'https://www.inaturalist.org')
  assert.equal(url.pathname, '/oauth/authorize')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), INAT_WEB_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), INAT_WEB_REDIRECT_URI)
  assert.equal(url.searchParams.get('state'), state)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(verifier))

  const pending = await loadInatPendingState(storage)
  assert.equal(pending.flow, 'inat-oauth')
  assert.equal(pending.state, state)
  assert.equal(pending.code_verifier, verifier)
  assert.equal(pending.client_id, INAT_WEB_CLIENT_ID)
  assert.equal(pending.redirect_uri, INAT_WEB_REDIRECT_URI)
  assert.equal(pending.platform, 'web')
  assert.equal(Number.isFinite(pending.created_at), true)
})

test('builds the android authorization URL with the android client and callback redirect', async () => {
  const storage = createMemoryStorage()
  const verifier = 'android-verifier-123'
  const state = 'android-state-123'
  const url = new URL(await buildInaturalistAuthorizationUrl({
    platform: 'android',
    state,
    codeVerifier: verifier,
    storage,
  }))

  assert.equal(url.searchParams.get('client_id'), INAT_ANDROID_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), INAT_ANDROID_REDIRECT_URI)
  assert.equal(url.searchParams.get('state'), state)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(verifier))

  const pending = await loadInatPendingState(storage)
  assert.equal(pending.flow, 'inat-oauth')
  assert.equal(pending.client_id, INAT_ANDROID_CLIENT_ID)
  assert.equal(pending.redirect_uri, INAT_ANDROID_REDIRECT_URI)
  assert.equal(pending.platform, 'android')
})

test('saves, loads, and clears the pending PKCE state', async () => {
  const storage = createMemoryStorage()
  const pending = {
    flow: 'inat-oauth',
    state: 'state-abc',
    code_verifier: 'verifier-abc',
    client_id: INAT_WEB_CLIENT_ID,
    redirect_uri: INAT_WEB_REDIRECT_URI,
    platform: 'web',
    created_at: 123456,
  }

  await saveInatPendingState(pending, storage)
  assert.deepEqual(await loadInatPendingState(storage), pending)
  await clearInatPendingState(storage)
  assert.equal(await loadInatPendingState(storage), null)
})

test('default native runtime writes iNaturalist session data to Preferences instead of localStorage', async () => {
  const runtime = createRuntimeStorageMocks({ platform: 'android', native: true })
  try {
    await persistInaturalistSession({
      connected: true,
      logged_in: true,
      username: 'fungi_fan',
      user_id: 42,
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      api_token: 'api-456',
      api_token_created_at: 1000,
      api_token_expires_at: 2000,
      platform: 'android',
    })

    assert.equal(runtime.preferencesData.get(`CapacitorStorage.${INAT_USERNAME_KEY}`), 'fungi_fan')
    assert.equal(runtime.preferencesData.get(`CapacitorStorage.${INAT_API_TOKEN_KEY}`), 'api-456')
    assert.equal(runtime.localStorageData.has(INAT_USERNAME_KEY), false)
    assert.equal(runtime.localStorageData.has(INAT_API_TOKEN_KEY), false)
    assert.ok(runtime.preferencesCalls.set > 0)
    assert.equal(runtime.localStorageCalls.setItem, 0)
  } finally {
    runtime.restore()
  }
})

test('default native runtime reads iNaturalist session data from Preferences', async () => {
  const runtime = createRuntimeStorageMocks({ platform: 'android', native: true })
  try {
    runtime.preferencesData.set(`CapacitorStorage.${INAT_ACCESS_TOKEN_KEY}`, 'access-123')
    runtime.preferencesData.set(`CapacitorStorage.${INAT_API_TOKEN_KEY}`, 'api-456')
    runtime.preferencesData.set(`CapacitorStorage.${INAT_API_TOKEN_CREATED_AT_KEY}`, String(Date.now()))
    runtime.preferencesData.set(`CapacitorStorage.${INAT_API_TOKEN_EXPIRES_AT_KEY}`, String(Date.now() + 60_000))
    runtime.preferencesData.set(`CapacitorStorage.${INAT_USERNAME_KEY}`, 'fungi_fan')
    runtime.preferencesData.set(`CapacitorStorage.${INAT_USER_ID_KEY}`, '42')

    const session = await loadInaturalistSession(undefined, {
      fetchImpl: async () => {
        throw new Error('unexpected refresh request')
      },
    })

    assert.equal(session.connected, true)
    assert.equal(session.username, 'fungi_fan')
    assert.equal(session.api_token, 'api-456')
    assert.equal(session.user_id, '42')
    assert.equal(runtime.localStorageCalls.getItem, 0)
    assert.ok(runtime.preferencesCalls.get > 0)
  } finally {
    runtime.restore()
  }
})

test('default web runtime writes iNaturalist session data to localStorage', async () => {
  const runtime = createRuntimeStorageMocks({ platform: 'web', native: false })
  try {
    await persistInaturalistSession({
      connected: true,
      logged_in: true,
      username: 'fungi_fan',
      user_id: 42,
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      api_token: 'api-456',
      api_token_created_at: 1000,
      api_token_expires_at: 2000,
      platform: 'web',
    })

    assert.equal(runtime.localStorageData.get(INAT_USERNAME_KEY), 'fungi_fan')
    assert.equal(runtime.localStorageData.get(INAT_API_TOKEN_KEY), 'api-456')
    assert.equal(runtime.preferencesData.has(INAT_USERNAME_KEY), false)
    assert.equal(runtime.preferencesData.has(INAT_API_TOKEN_KEY), false)
    assert.ok(runtime.localStorageCalls.setItem > 0)
    assert.equal(runtime.preferencesCalls.set, 0)
  } finally {
    runtime.restore()
  }
})

test('injected memory storage still works for the iNaturalist storage helpers', async () => {
  const storage = createMemoryStorage()

  await setInatItem(INAT_USERNAME_KEY, 'fungi_fan', storage)
  assert.equal(await getInatItem(INAT_USERNAME_KEY, storage), 'fungi_fan')

  await removeInatItem(INAT_USERNAME_KEY, storage)
  assert.equal(await getInatItem(INAT_USERNAME_KEY, storage), null)
})

test('parses canonical callbacks and only rescues the root path when pending state matches', async () => {
  const pending = {
    flow: 'inat-oauth',
    state: 'expected-state',
    code_verifier: 'verifier-1',
    client_id: INAT_WEB_CLIENT_ID,
    redirect_uri: INAT_WEB_REDIRECT_URI,
    platform: 'web',
    created_at: 123,
  }

  const canonical = await parseInaturalistCallbackUrl(`${INAT_WEB_REDIRECT_URI}?code=code-1&state=state-1`)
  assert.equal(canonical.kind, 'success')
  assert.equal(canonical.matches_inat, true)
  assert.equal(canonical.code, 'code-1')
  assert.equal(canonical.state, 'state-1')

  const android = await parseInaturalistCallbackUrl(`${INAT_ANDROID_REDIRECT_URI}?code=code-2&state=state-2`)
  assert.equal(android.kind, 'success')
  assert.equal(android.matches_inat, true)

  const rescued = await parseInaturalistCallbackUrl('https://app.sporely.no/?code=code-3&state=expected-state', {
    pendingState: pending,
  })
  assert.equal(rescued.kind, 'success')
  assert.equal(rescued.matches_inat, true)
  assert.equal(rescued.redirect_uri, INAT_WEB_REDIRECT_URI)

  const wrongState = await parseInaturalistCallbackUrl('https://app.sporely.no/?code=code-3&state=wrong-state', {
    pendingState: pending,
  })
  assert.equal(wrongState.kind, 'other')
  assert.equal(wrongState.matches_inat, false)

  const noPending = await parseInaturalistCallbackUrl('https://app.sporely.no/?code=code-3&state=expected-state')
  assert.equal(noPending.kind, 'other')
  assert.equal(noPending.matches_inat, false)

  const recoveryQuery = await parseInaturalistCallbackUrl('https://app.sporely.no/?flow=recovery&code=code-4&state=expected-state')
  assert.equal(recoveryQuery.kind, 'other')
  assert.equal(recoveryQuery.matches_inat, false)

  const recoveryHash = await parseInaturalistCallbackUrl('https://app.sporely.no/#access_token=abc&refresh_token=def&type=recovery')
  assert.equal(recoveryHash.kind, 'other')
  assert.equal(recoveryHash.matches_inat, false)
})

test('completes the callback using the pending redirect URI exactly and persists the session', async () => {
  const storage = createMemoryStorage()
  const calls = []

  await saveInatPendingState({
    flow: 'inat-oauth',
    state: 'expected-state',
    code_verifier: 'verifier-1',
    client_id: INAT_WEB_CLIENT_ID,
    redirect_uri: INAT_WEB_REDIRECT_URI,
    platform: 'web',
    created_at: 123,
  }, storage)

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/oauth/token')) {
      const body = options.body
      assert.equal(body.get('client_id'), INAT_WEB_CLIENT_ID)
      assert.equal(body.get('redirect_uri'), INAT_WEB_REDIRECT_URI)
      assert.equal(body.get('code'), 'code-1')
      assert.equal(body.get('code_verifier'), 'verifier-1')
      assert.equal(body.get('grant_type'), 'authorization_code')
      return jsonResponse({
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        created_at: 100,
        expires_in: 3600,
      })
    }
    if (url.endsWith('/users/api_token')) {
      assert.equal(options.headers.Authorization, 'Bearer access-123')
      return jsonResponse({ api_token: 'api-456' })
    }
    if (url.endsWith('/v1/users/me')) {
      assert.equal(options.headers.Authorization, 'api-456')
      return jsonResponse({
        results: [{ id: 42, login: 'fungi_fan' }],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const session = await completeInaturalistOAuthCallback(`${INAT_WEB_REDIRECT_URI}?code=code-1&state=expected-state`, {
    storage,
    fetchImpl,
  })

  assert.equal(session.connected, true)
  assert.equal(session.logged_in, true)
  assert.equal(session.username, 'fungi_fan')
  assert.equal(session.user_id, 42)
  assert.equal(session.access_token, 'access-123')
  assert.equal(session.api_token, 'api-456')
  assert.equal(await loadInatPendingState(storage), null)
  assert.equal(calls.filter(call => call.url.endsWith('/oauth/token')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/users/api_token')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/v1/users/me')).length, 1)
  assert.ok(calls.findIndex(call => call.url.endsWith('/users/api_token')) < calls.findIndex(call => call.url.endsWith('/v1/users/me')))
})

test('duplicate callback returns the stored session without another token exchange', async () => {
  const storage = createMemoryStorage()
  const calls = []

  await saveInatPendingState({
    flow: 'inat-oauth',
    state: 'expected-state',
    code_verifier: 'verifier-1',
    client_id: INAT_WEB_CLIENT_ID,
    redirect_uri: INAT_WEB_REDIRECT_URI,
    platform: 'web',
    created_at: 123,
  }, storage)

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.endsWith('/oauth/token')) {
      return jsonResponse({
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        created_at: 100,
        expires_in: 3600,
      })
    }
    if (url.endsWith('/users/api_token')) {
      return jsonResponse({ api_token: 'api-456' })
    }
    if (url.endsWith('/v1/users/me')) {
      assert.equal(options.headers.Authorization, 'api-456')
      return jsonResponse({ results: [{ id: 42, login: 'fungi_fan' }] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const callbackUrl = `${INAT_WEB_REDIRECT_URI}?code=code-1&state=expected-state`
  const first = await completeInaturalistOAuthCallback(callbackUrl, { storage, fetchImpl })
  const second = await completeInaturalistOAuthCallback(callbackUrl, { storage, fetchImpl })

  assert.equal(first.connected, true)
  assert.equal(second.connected, true)
  assert.equal(second.api_token, 'api-456')
  assert.equal(calls.filter(call => call.url.endsWith('/oauth/token')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/users/api_token')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/v1/users/me')).length, 1)
})

test('native initialization uses the Capgo generic OAuth2 provider config', async () => {
  resetInaturalistOAuthStateForTests()
  const calls = []
  const socialLogin = {
    async initialize(options) {
      calls.push({ method: 'initialize', options })
    },
    async login() {
      throw new Error('login should not be called in initialize test')
    },
  }

  const result = await initializeInaturalistOAuth({
    platform: 'android',
    socialLoginImpl: socialLogin,
  })

  assert.equal(result.initialized, true)
  assert.equal(result.platform, 'android')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'initialize')
  assert.deepEqual(calls[0].options, {
    oauth2: {
      inaturalist: {
        appId: INAT_ANDROID_CLIENT_ID,
        authorizationBaseUrl: 'https://www.inaturalist.org/oauth/authorize',
        accessTokenEndpoint: 'https://www.inaturalist.org/oauth/token',
        redirectUrl: INAT_ANDROID_REDIRECT_URI,
        scope: 'write',
        pkceEnabled: true,
        responseType: 'code',
      },
    },
  })
})

test('normalizeCapgoOAuth2Result extracts the access token from common plugin result shapes', () => {
  const nested = normalizeCapgoOAuth2Result({
    provider: 'oauth2',
    result: {
      providerId: 'inaturalist',
      accessToken: {
        token: 'access-123',
        refreshToken: 'refresh-123',
        tokenType: 'bearer',
      },
      refreshToken: 'refresh-123',
      expiresIn: 3600,
      scope: ['write'],
    },
  })
  assert.equal(nested.access_token, 'access-123')
  assert.equal(nested.refresh_token, 'refresh-123')
  assert.equal(nested.providerId, 'inaturalist')

  const flat = normalizeCapgoOAuth2Result({
    provider: 'oauth2',
    result: {
      providerId: 'inaturalist',
      accessToken: 'access-456',
      refreshToken: 'refresh-456',
      expires_in: 1800,
      scope: 'write offline_access',
    },
  })
  assert.equal(flat.access_token, 'access-456')
  assert.equal(flat.refresh_token, 'refresh-456')
  assert.deepEqual(flat.scope, ['write', 'offline_access'])
})

test('native connect path fetches profile and API token, then persists a normalized session', async () => {
  resetInaturalistOAuthStateForTests()
  const storage = createMemoryStorage()
  const calls = []
  const socialLogin = {
    async initialize() {
      calls.push({ method: 'initialize' })
    },
    async login(options) {
      calls.push({ method: 'login', options })
      return {
        provider: 'oauth2',
        result: {
          providerId: 'inaturalist',
          accessToken: { token: 'access-123', tokenType: 'bearer' },
          refreshToken: 'refresh-123',
          expiresIn: 3600,
          scope: ['write'],
        },
      }
    },
  }

  const fetchImpl = async (url, options = {}) => {
    calls.push({ method: 'fetch', url, options })
    if (url.endsWith('/users/api_token')) {
      assert.equal(options.headers.Authorization, 'Bearer access-123')
      return jsonResponse({ api_token: 'api-456' })
    }
    if (url.endsWith('/v1/users/me')) {
      assert.equal(options.headers.Authorization, 'api-456')
      return jsonResponse({ results: [{ id: 42, login: 'fungi_fan' }] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const session = await connectInaturalist({
    platform: 'android',
    socialLoginImpl: socialLogin,
    fetchImpl,
    storage,
  })

  assert.equal(calls[0].method, 'initialize')
  assert.equal(calls[1].method, 'login')
  assert.equal(calls[1].options.provider, 'oauth2')
  assert.equal(calls[1].options.options.providerId, 'inaturalist')
  assert.equal(calls[1].options.options.scope, 'write')
  assert.equal(session.connected, true)
  assert.equal(session.platform, 'android')
  assert.equal(session.username, 'fungi_fan')
  assert.equal(session.api_token, 'api-456')
  assert.equal(session.apiToken, 'api-456')
  const fetchCalls = calls.filter(call => call.url)
  assert.ok(fetchCalls.findIndex(call => call.url.endsWith('/users/api_token')) < fetchCalls.findIndex(call => call.url.endsWith('/v1/users/me')))
  assert.equal(await loadInatPendingState(storage), null)

  const loaded = await loadInaturalistSession(storage, {
    fetchImpl: async () => {
      throw new Error('unexpected refresh request')
    },
  })
  assert.equal(loaded.connected, true)
  assert.equal(loaded.api_token, 'api-456')
})

test('native connect path fails cleanly when the plugin login rejects', async () => {
  resetInaturalistOAuthStateForTests()
  const storage = createMemoryStorage()
  const socialLogin = {
    async initialize() {},
    async login() {
      throw new Error('user cancelled')
    },
  }

  await assert.rejects(
    connectInaturalist({
      platform: 'android',
      socialLoginImpl: socialLogin,
      storage,
      fetchImpl: async () => {
        throw new Error('unexpected fetch')
      },
    }),
    /user cancelled/i,
  )

  const loaded = await loadInaturalistSession(storage)
  assert.equal(loaded.connected, false)
  assert.equal((await loadInatPendingState(storage)), null)
})

test('native connect path does not persist a partial session if api token lookup fails', async () => {
  resetInaturalistOAuthStateForTests()
  const storage = createMemoryStorage()
  const socialLogin = {
    async initialize() {},
    async login() {
      return {
        provider: 'oauth2',
        result: {
          providerId: 'inaturalist',
          accessToken: { token: 'access-123', tokenType: 'bearer' },
          refreshToken: 'refresh-123',
          expiresIn: 3600,
        },
      }
    },
  }

  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/v1/users/me')) {
      throw new Error('profile should not be fetched when api token lookup fails')
    }
    if (url.endsWith('/users/api_token')) {
      return jsonResponse({ error: 'nope' }, false)
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await assert.rejects(
    connectInaturalist({
      platform: 'android',
      socialLoginImpl: socialLogin,
      storage,
      fetchImpl,
    }),
    /nope/i,
  )

  const loaded = await loadInaturalistSession(storage)
  assert.equal(loaded.connected, false)
  assert.equal(await loadInatPendingState(storage), null)
})

test('native connect path does not persist a partial session if profile lookup fails after api token success', async () => {
  resetInaturalistOAuthStateForTests()
  const storage = createMemoryStorage()
  const socialLogin = {
    async initialize() {},
    async login() {
      return {
        provider: 'oauth2',
        result: {
          providerId: 'inaturalist',
          accessToken: { token: 'access-123', tokenType: 'bearer' },
          refreshToken: 'refresh-123',
          expiresIn: 3600,
        },
      }
    },
  }

  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/users/api_token')) {
      assert.equal(options.headers.Authorization, 'Bearer access-123')
      return jsonResponse({ api_token: 'api-456' })
    }
    if (url.endsWith('/v1/users/me')) {
      assert.equal(options.headers.Authorization, 'api-456')
      return jsonResponse({ error: 'unauthorized' }, false)
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await assert.rejects(
    connectInaturalist({
      platform: 'android',
      socialLoginImpl: socialLogin,
      storage,
      fetchImpl,
    }),
    /unauthorized/i,
  )

  const loaded = await loadInaturalistSession(storage)
  assert.equal(loaded.connected, false)
  assert.equal(await loadInatPendingState(storage), null)
})

test('maybeHandleInaturalistOAuthReturn does not consume non-iNaturalist URLs and distinguishes scrub behavior', async () => {
  const storage = createMemoryStorage()
  await saveInatPendingState({
    flow: 'inat-oauth',
    state: 'expected-state',
    code_verifier: 'verifier-1',
    client_id: INAT_WEB_CLIENT_ID,
    redirect_uri: INAT_WEB_REDIRECT_URI,
    platform: 'web',
    created_at: 123,
  }, storage)

  const ignored = await maybeHandleInaturalistOAuthReturn('https://app.sporely.no/?flow=recovery&code=code-1&state=expected-state', {
    storage,
    fetchImpl: async () => jsonResponse({}),
  })
  assert.equal(ignored.handled, false)
  assert.equal(ignored.scrubUrl, false)

  const denied = await maybeHandleInaturalistOAuthReturn(`${INAT_WEB_REDIRECT_URI}?error=access_denied&error_description=Denied`, {
    storage,
    fetchImpl: async () => jsonResponse({}),
  })
  assert.equal(denied.handled, true)
  assert.equal(denied.scrubUrl, true)
  assert.equal(denied.status, 'provider-denied')

  const failed = await maybeHandleInaturalistOAuthReturn(`${INAT_WEB_REDIRECT_URI}?code=code-1&state=expected-state`, {
    storage,
    fetchImpl: async (url) => {
      if (url.endsWith('/oauth/token')) {
        return jsonResponse({ access_token: 'access-123' })
      }
      if (url.endsWith('/users/api_token')) {
        return jsonResponse({ api_token: 'api-456' })
      }
      if (url.endsWith('/v1/users/me')) {
        return jsonResponse({ error: 'profile failed' }, false)
      }
      throw new Error(`Unexpected URL: ${url}`)
    },
  })
  assert.equal(failed.handled, true)
  assert.equal(failed.scrubUrl, false)
  assert.equal(failed.status, 'error')
})

test('loads a connected iNaturalist session using the compatibility field names', async () => {
  const storage = createMemoryStorage()
  await setInatItem(INAT_ACCESS_TOKEN_KEY, 'access-123', storage)
  await setInatItem(INAT_API_TOKEN_KEY, 'api-456', storage)
  await setInatItem(INAT_API_TOKEN_CREATED_AT_KEY, String(Date.now()), storage)
  await setInatItem(INAT_API_TOKEN_EXPIRES_AT_KEY, String(Date.now() + 1000 * 60 * 60), storage)
  await setInatItem(INAT_USERNAME_KEY, 'fungi_fan', storage)
  await setInatItem(INAT_USER_ID_KEY, '42', storage)

  const session = await loadInaturalistSession(storage, {
    fetchImpl: async () => {
      throw new Error('unexpected refresh request')
    },
  })

  assert.equal(session.connected, true)
  assert.equal(session.logged_in, true)
  assert.equal(session.username, 'fungi_fan')
  assert.equal(session.user_id, '42')
  assert.equal(session.userId, '42')
  assert.equal(session.access_token, 'access-123')
  assert.equal(session.accessToken, 'access-123')
  assert.equal(session.api_token, 'api-456')
  assert.equal(session.apiToken, 'api-456')
})
