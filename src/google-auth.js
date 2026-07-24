// ── Native Google authentication for Sporely ─────────────────────────────────
// Handles the Android-only Google Sign-In → Supabase signInWithIdToken flow.
// Web and PWA continue to use supabase.auth.signInWithOAuth() elsewhere.
//
// This module intentionally does not know about iNaturalist. It shares only
// the underlying SocialLogin.initialize() call via native-oauth.js.

import { SocialLogin } from '@capgo/capacitor-social-login'
import { supabase } from './supabase.js'
import { getPlatform } from './platform.js'
import {
  ensureNativeOAuthInitialized,
  registerNativeOAuthProviders,
} from './native-oauth.js'

export const GOOGLE_WEB_CLIENT_ID_ENV = String(
  import.meta.env?.VITE_GOOGLE_WEB_CLIENT_ID || '',
).trim()

let _googleWebClientIdOverride = null
let _defaultSocialLoginOverride = null

function _resolveGoogleWebClientId() {
  return _googleWebClientIdOverride ?? GOOGLE_WEB_CLIENT_ID_ENV
}

function _resolveSocialLogin() {
  return _defaultSocialLoginOverride || SocialLogin
}

if (GOOGLE_WEB_CLIENT_ID_ENV) {
  registerNativeOAuthProviders({
    google: {
      webClientId: GOOGLE_WEB_CLIENT_ID_ENV,
      mode: 'online',
    },
  })
}

export function _setGoogleWebClientIdForTests(clientId) {
  _googleWebClientIdOverride = clientId ? String(clientId).trim() : null
}

export function _setDefaultSocialLoginImplForTests(impl) {
  _defaultSocialLoginOverride = impl || null
}

export class GoogleSignInCancelledError extends Error {
  constructor(message = 'Google sign-in was cancelled') {
    super(message)
    this.name = 'GoogleSignInCancelledError'
    this.cancelled = true
  }
}

export class GoogleSignInConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GoogleSignInConfigError'
  }
}

export class GoogleSignInMissingTokenError extends Error {
  constructor(message = 'Google sign-in did not return an ID token') {
    super(message)
    this.name = 'GoogleSignInMissingTokenError'
  }
}

function _isCancellationError(error) {
  if (!error) return false
  if (error.cancelled === true) return true
  const code = String(error.code || error.errorCode || '').toLowerCase()
  if (
    code === 'user_cancelled'
    || code === 'user_canceled'
    || code === 'cancelled'
    || code === 'canceled'
    || code === '12501'
  ) {
    return true
  }
  const message = String(error.message || error || '').toLowerCase()
  return (
    message.includes('user cancel')
    || message.includes('user canceled')
    || message.includes('user cancelled')
    || message.includes('sign in was cancelled')
    || message.includes('sign-in was cancelled')
    || message.includes('activity is cancelled')
    || message.includes('cancelled by user')
    || message.includes('canceled by user')
  )
}

export function isGoogleSignInCancellation(error) {
  return error instanceof GoogleSignInCancelledError || _isCancellationError(error)
}

export function isGoogleNativeConfigured() {
  return Boolean(_resolveGoogleWebClientId())
}

export function isNativeGoogleSignInAvailable(platform) {
  const resolved = platform || (typeof window !== 'undefined' ? getPlatform() : null)
  return resolved === 'android' && isGoogleNativeConfigured()
}

export function extractGoogleIdToken(loginResult) {
  if (!loginResult) return null
  const result = loginResult.result || loginResult
  if (!result || typeof result !== 'object') return null

  const direct = result.idToken || result.id_token || result.identityToken
  if (typeof direct === 'string' && direct.trim()) return direct.trim()

  const credential = result.credential
  if (credential && typeof credential === 'object') {
    const credentialToken = credential.idToken || credential.id_token
    if (typeof credentialToken === 'string' && credentialToken.trim()) {
      return credentialToken.trim()
    }
  }

  const authentication = result.authentication
  if (authentication && typeof authentication === 'object') {
    const authToken = authentication.idToken || authentication.id_token
    if (typeof authToken === 'string' && authToken.trim()) return authToken.trim()
  }

  return null
}

export async function signInWithGoogleNative(options = {}) {
  const platform = options.platform || (typeof window !== 'undefined' ? getPlatform() : null)
  if (platform !== 'android') {
    throw new GoogleSignInConfigError(
      'signInWithGoogleNative is only available on native Android',
    )
  }
  const webClientId = _resolveGoogleWebClientId()
  if (!webClientId) {
    throw new GoogleSignInConfigError(
      'VITE_GOOGLE_WEB_CLIENT_ID is not set; native Google sign-in is not configured',
    )
  }

  const socialLogin = options.socialLoginImpl || _resolveSocialLogin()
  const authClient = options.supabaseClient || supabase

  await ensureNativeOAuthInitialized({ platform, socialLoginImpl: socialLogin })

  // Deliberately pass an empty options object. The plugin's GoogleProvider
  // already applies email/profile/openid by default; any non-null `scopes`
  // array triggers the ModifiedMainActivityForSocialLoginPlugin guard, which
  // is only needed for Google API scopes we do not use. See
  // node_modules/@capgo/capacitor-social-login/android/src/main/java/ee/forgr/capacitor/social/login/GoogleProvider.java
  let loginResult
  try {
    loginResult = await socialLogin.login({
      provider: 'google',
      options: {},
    })
  } catch (error) {
    if (_isCancellationError(error)) {
      throw new GoogleSignInCancelledError(error?.message || undefined)
    }
    throw error
  }

  const idToken = extractGoogleIdToken(loginResult)
  if (!idToken) {
    throw new GoogleSignInMissingTokenError()
  }

  const { data, error } = await authClient.auth.signInWithIdToken({
    provider: 'google',
    token: idToken,
  })
  if (error) throw error

  return { session: data?.session || null, user: data?.user || null, raw: data }
}
