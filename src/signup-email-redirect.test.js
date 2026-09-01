import test from 'node:test'
import assert from 'node:assert/strict'

import * as auth from './screens/auth.js'

const PRODUCTION = 'https://app.sporely.no/auth/callback?flow=signup'
const DEBUG = 'com.sporelab.sporely.debug://auth?flow=signup'

test('signup redirect resolver selects the safe web, localhost, and Android targets', async () => {
  assert.equal(await auth.getSignupEmailRedirectUrl({ origin: 'https://app.sporely.no', isNativeAndroid: false }), PRODUCTION)
  assert.equal(await auth.getSignupEmailRedirectUrl({ origin: 'https://localhost:5173', isNativeAndroid: false }), 'https://localhost:5173/auth/callback?flow=signup')
  assert.equal(await auth.getSignupEmailRedirectUrl({ origin: 'http://localhost:5173', isNativeAndroid: false }), 'http://localhost:5173/auth/callback?flow=signup')
  assert.equal(await auth.getSignupEmailRedirectUrl({ origin: 'http://127.0.0.1:4173', isNativeAndroid: false }), 'http://127.0.0.1:4173/auth/callback?flow=signup')
  assert.equal(await auth.getSignupEmailRedirectUrl({ origin: 'http://[::1]:4173', isNativeAndroid: false }), 'http://[::1]:4173/auth/callback?flow=signup')
  assert.equal(await auth.getSignupEmailRedirectUrl({ isNativeAndroid: true, getNativeAppInfo: async () => ({ id: 'com.sporelab.sporely.debug' }) }), DEBUG)
  assert.equal(await auth.getSignupEmailRedirectUrl({ isNativeAndroid: true, getNativeAppInfo: async () => ({ id: 'com.sporelab.sporely' }) }), PRODUCTION)
  assert.equal(await auth.getSignupEmailRedirectUrl({ isNativeAndroid: true, getNativeAppInfo: async () => { throw new Error('unavailable') } }), PRODUCTION)
})

test('signup and resend both await the shared redirect resolver', async () => {
  assert.equal(typeof auth.signUpWithEmailConfirmation, 'function')
  assert.equal(typeof auth.resendSignupEmailConfirmation, 'function')
  const redirects = []
  const client = {
    auth: {
      async signUp(payload) { redirects.push(payload.options.emailRedirectTo); return { error: null } },
      async resend(payload) { redirects.push(payload.options.emailRedirectTo); return { error: null } },
    },
  }
  const resolveRedirect = async () => DEBUG

  await auth.signUpWithEmailConfirmation({ email: 'a@example.com', password: 'password', captchaToken: 'captcha', client, resolveRedirect })
  await auth.resendSignupEmailConfirmation({ email: 'a@example.com', client, resolveRedirect })
  assert.deepEqual(redirects, [DEBUG, DEBUG])
})
