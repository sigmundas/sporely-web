import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ensureNativeOAuthInitialized,
  getRegisteredNativeOAuthProvidersForTests,
  registerNativeOAuthProviders,
  resetNativeOAuthStateForTests,
} from './native-oauth.js'

test.beforeEach(() => {
  resetNativeOAuthStateForTests({ clearProviders: true })
})

test.after(() => {
  resetNativeOAuthStateForTests({ clearProviders: true })
})

test('ensureNativeOAuthInitialized skips non-android platforms without calling initialize', async () => {
  const calls = []
  const socialLogin = {
    async initialize(config) {
      calls.push(config)
    },
    async login() {},
  }

  const result = await ensureNativeOAuthInitialized({
    platform: 'web',
    socialLoginImpl: socialLogin,
  })

  assert.equal(result.initialized, false)
  assert.equal(result.platform, 'web')
  assert.equal(calls.length, 0)
})

test('ensureNativeOAuthInitialized triggers a single initialize call for merged providers', async () => {
  registerNativeOAuthProviders({
    google: { webClientId: 'g-id', mode: 'online' },
  })
  registerNativeOAuthProviders({
    oauth2: {
      inaturalist: {
        appId: 'inat-client-id',
        authorizationBaseUrl: 'https://example/auth',
        accessTokenEndpoint: 'https://example/token',
        redirectUrl: 'com.sporelab.sporely://auth',
        scope: 'write',
        pkceEnabled: true,
        responseType: 'code',
      },
    },
  })

  const calls = []
  const socialLogin = {
    async initialize(config) {
      calls.push(config)
    },
    async login() {},
  }

  const first = await ensureNativeOAuthInitialized({
    platform: 'android',
    socialLoginImpl: socialLogin,
  })
  const second = await ensureNativeOAuthInitialized({
    platform: 'android',
    socialLoginImpl: socialLogin,
  })

  assert.equal(first.initialized, true)
  assert.equal(second.initialized, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    google: { webClientId: 'g-id', mode: 'online' },
    oauth2: {
      inaturalist: {
        appId: 'inat-client-id',
        authorizationBaseUrl: 'https://example/auth',
        accessTokenEndpoint: 'https://example/token',
        redirectUrl: 'com.sporelab.sporely://auth',
        scope: 'write',
        pkceEnabled: true,
        responseType: 'code',
      },
    },
  })
})

test('registerNativeOAuthProviders after initialization throws', async () => {
  registerNativeOAuthProviders({ google: { webClientId: 'g' } })
  const socialLogin = { async initialize() {}, async login() {} }
  await ensureNativeOAuthInitialized({ platform: 'android', socialLoginImpl: socialLogin })

  assert.throws(
    () => registerNativeOAuthProviders({ oauth2: { later: {} } }),
    /already initialized/,
  )
})

test('failed initialize clears the cache so retry can occur', async () => {
  registerNativeOAuthProviders({ google: { webClientId: 'g' } })
  let attempt = 0
  const socialLogin = {
    async initialize() {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
    },
    async login() {},
  }

  await assert.rejects(
    () => ensureNativeOAuthInitialized({ platform: 'android', socialLoginImpl: socialLogin }),
    /boom/,
  )

  const retry = await ensureNativeOAuthInitialized({
    platform: 'android',
    socialLoginImpl: socialLogin,
  })
  assert.equal(retry.initialized, true)
  assert.equal(attempt, 2)
})

test('getRegisteredNativeOAuthProvidersForTests returns a snapshot copy', () => {
  registerNativeOAuthProviders({ google: { webClientId: 'g' } })
  const snapshot = getRegisteredNativeOAuthProvidersForTests()
  snapshot.google.webClientId = 'mutated'
  const fresh = getRegisteredNativeOAuthProvidersForTests()
  assert.equal(fresh.google.webClientId, 'g')
})
