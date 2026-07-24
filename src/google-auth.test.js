import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GoogleSignInCancelledError,
  GoogleSignInConfigError,
  GoogleSignInMissingTokenError,
  extractGoogleIdToken,
  isNativeGoogleSignInAvailable,
  signInWithGoogleNative,
  _setDefaultSocialLoginImplForTests,
  _setGoogleWebClientIdForTests,
} from './google-auth.js'
import { resetNativeOAuthStateForTests } from './native-oauth.js'

const TEST_CLIENT_ID = 'test-google-web-client-id.apps.googleusercontent.com'

function makeSupabaseMock({ session = null, user = null, error = null } = {}) {
  const calls = []
  return {
    calls,
    auth: {
      async signInWithIdToken(payload) {
        calls.push({ method: 'signInWithIdToken', payload })
        if (error) return { data: null, error }
        return { data: { session, user }, error: null }
      },
    },
  }
}

function makeSocialLoginMock({
  initializeError = null,
  loginResult = null,
  loginError = null,
} = {}) {
  const calls = []
  return {
    calls,
    async initialize(config) {
      calls.push({ method: 'initialize', config })
      if (initializeError) throw initializeError
    },
    async login(options) {
      calls.push({ method: 'login', options })
      if (loginError) throw loginError
      return loginResult
    },
  }
}

test.beforeEach(() => {
  resetNativeOAuthStateForTests({ clearProviders: true })
  _setGoogleWebClientIdForTests(TEST_CLIENT_ID)
  _setDefaultSocialLoginImplForTests(null)
})

test.after(() => {
  _setGoogleWebClientIdForTests(null)
  _setDefaultSocialLoginImplForTests(null)
  resetNativeOAuthStateForTests({ clearProviders: true })
})

test('extractGoogleIdToken reads nested result.idToken', () => {
  assert.equal(
    extractGoogleIdToken({ provider: 'google', result: { idToken: 'abc' } }),
    'abc',
  )
})

test('extractGoogleIdToken reads snake_case and credential shapes', () => {
  assert.equal(
    extractGoogleIdToken({ result: { id_token: 'snake' } }),
    'snake',
  )
  assert.equal(
    extractGoogleIdToken({ result: { credential: { idToken: 'nested' } } }),
    'nested',
  )
  assert.equal(
    extractGoogleIdToken({ result: { authentication: { id_token: 'auth' } } }),
    'auth',
  )
})

test('extractGoogleIdToken returns null when no token is present', () => {
  assert.equal(extractGoogleIdToken(null), null)
  assert.equal(extractGoogleIdToken({}), null)
  assert.equal(extractGoogleIdToken({ result: { email: 'x@y.z' } }), null)
})

test('isNativeGoogleSignInAvailable requires android platform and configured client id', () => {
  assert.equal(isNativeGoogleSignInAvailable('android'), true)
  assert.equal(isNativeGoogleSignInAvailable('ios'), false)
  assert.equal(isNativeGoogleSignInAvailable('web'), false)

  _setGoogleWebClientIdForTests(null)
  assert.equal(isNativeGoogleSignInAvailable('android'), false)
})

test('signInWithGoogleNative on Android exchanges the ID token via supabase.signInWithIdToken', async () => {
  const session = { access_token: 'sb-access', user: { id: 'user-1', email: 'a@b.co' } }
  const supabaseClient = makeSupabaseMock({ session, user: session.user })
  const socialLogin = makeSocialLoginMock({
    loginResult: {
      provider: 'google',
      result: { idToken: 'google-id-token' },
    },
  })

  const result = await signInWithGoogleNative({
    platform: 'android',
    socialLoginImpl: socialLogin,
    supabaseClient,
  })

  assert.equal(socialLogin.calls[0].method, 'initialize')
  assert.equal(socialLogin.calls[1].method, 'login')
  assert.deepEqual(socialLogin.calls[1].options, {
    provider: 'google',
    options: {},
  })
  assert.equal(supabaseClient.calls.length, 1)
  assert.deepEqual(supabaseClient.calls[0].payload, {
    provider: 'google',
    token: 'google-id-token',
  })
  assert.deepEqual(result.session, session)
})

test('signInWithGoogleNative handles nested credential id tokens', async () => {
  const supabaseClient = makeSupabaseMock({ session: { user: { id: 'u' } } })
  const socialLogin = makeSocialLoginMock({
    loginResult: {
      provider: 'google',
      result: { credential: { idToken: 'nested-token' } },
    },
  })

  await signInWithGoogleNative({
    platform: 'android',
    socialLoginImpl: socialLogin,
    supabaseClient,
  })

  assert.equal(supabaseClient.calls[0].payload.token, 'nested-token')
})

test('signInWithGoogleNative throws GoogleSignInCancelledError when the user cancels', async () => {
  const supabaseClient = makeSupabaseMock()
  const socialLogin = makeSocialLoginMock({
    loginError: Object.assign(new Error('The user canceled the sign-in flow.'), {
      code: '12501',
    }),
  })

  await assert.rejects(
    () => signInWithGoogleNative({
      platform: 'android',
      socialLoginImpl: socialLogin,
      supabaseClient,
    }),
    err => err instanceof GoogleSignInCancelledError,
  )
  assert.equal(supabaseClient.calls.length, 0)
})

test('signInWithGoogleNative throws GoogleSignInMissingTokenError when no ID token is returned', async () => {
  const supabaseClient = makeSupabaseMock()
  const socialLogin = makeSocialLoginMock({
    loginResult: { provider: 'google', result: { email: 'a@b.co' } },
  })

  await assert.rejects(
    () => signInWithGoogleNative({
      platform: 'android',
      socialLoginImpl: socialLogin,
      supabaseClient,
    }),
    err => err instanceof GoogleSignInMissingTokenError,
  )
  assert.equal(supabaseClient.calls.length, 0)
})

test('signInWithGoogleNative surfaces initialization failure', async () => {
  const supabaseClient = makeSupabaseMock()
  const socialLogin = makeSocialLoginMock({
    initializeError: new Error('plugin init exploded'),
  })

  await assert.rejects(
    () => signInWithGoogleNative({
      platform: 'android',
      socialLoginImpl: socialLogin,
      supabaseClient,
    }),
    /plugin init exploded/,
  )
  assert.equal(supabaseClient.calls.length, 0)
})

test('signInWithGoogleNative surfaces Supabase signInWithIdToken failure', async () => {
  const supabaseClient = makeSupabaseMock({
    error: Object.assign(new Error('supabase rejected the ID token'), {
      status: 400,
    }),
  })
  const socialLogin = makeSocialLoginMock({
    loginResult: { result: { idToken: 'good-token' } },
  })

  await assert.rejects(
    () => signInWithGoogleNative({
      platform: 'android',
      socialLoginImpl: socialLogin,
      supabaseClient,
    }),
    /supabase rejected the ID token/,
  )
})

test('signInWithGoogleNative throws GoogleSignInConfigError when the client id is missing', async () => {
  _setGoogleWebClientIdForTests(null)
  const supabaseClient = makeSupabaseMock()
  const socialLogin = makeSocialLoginMock()

  await assert.rejects(
    () => signInWithGoogleNative({
      platform: 'android',
      socialLoginImpl: socialLogin,
      supabaseClient,
    }),
    err => err instanceof GoogleSignInConfigError,
  )
  assert.equal(socialLogin.calls.length, 0)
})

test('regression: native Google login never requests additional Google API scopes', async () => {
  // The @capgo/capacitor-social-login GoogleProvider (v8.3.22) already applies
  // email/profile/openid by default and rejects any non-null `scopes` array
  // unless the host activity is ModifiedMainActivityForSocialLoginPlugin.
  // Sporely only needs an ID token for Supabase, so we must never pass scopes.
  const supabaseClient = makeSupabaseMock({ session: { user: { id: 'u' } } })
  const socialLogin = makeSocialLoginMock({
    loginResult: { result: { idToken: 'tok' } },
  })

  await signInWithGoogleNative({
    platform: 'android',
    socialLoginImpl: socialLogin,
    supabaseClient,
  })

  const loginCall = socialLogin.calls.find(c => c.method === 'login')
  assert.ok(loginCall, 'expected a login call')
  assert.equal(loginCall.options.provider, 'google')
  assert.ok(
    loginCall.options.options && typeof loginCall.options.options === 'object',
    'expected options.options to be an object',
  )
  assert.equal(
    Object.prototype.hasOwnProperty.call(loginCall.options.options, 'scopes'),
    false,
    'scopes must not be present in the native login options',
  )
})

test('signInWithGoogleNative refuses non-android platforms', async () => {
  await assert.rejects(
    () => signInWithGoogleNative({ platform: 'ios' }),
    err => err instanceof GoogleSignInConfigError,
  )
})
