// ── Native OAuth / SocialLogin runtime ────────────────────────────────────────
// Owns the single cached @capgo/capacitor-social-login initialize() call.
// Feature modules register their provider config here (Google for Sporely
// authentication, generic OAuth2 for the iNaturalist identification
// integration) so we never end up with more than one initialize() invocation
// per app run. This module knows nothing about Sporely's auth session or any
// specific provider semantics — those live with the caller.

import { SocialLogin } from '@capgo/capacitor-social-login'
import { getPlatform } from './platform.js'

const _providers = { google: null, oauth2: {} }
let _initPromise = null

function _normalizePlatform(input) {
  if (typeof input === 'string' && input.trim()) return input.trim().toLowerCase()
  if (typeof window !== 'undefined') return getPlatform() || null
  return null
}

export function registerNativeOAuthProviders(patch = {}) {
  if (_initPromise) {
    throw new Error(
      'native OAuth is already initialized; register providers before the first ensureNativeOAuthInitialized() call',
    )
  }
  if (patch.google && typeof patch.google === 'object') {
    _providers.google = { ...(_providers.google || {}), ...patch.google }
  }
  if (patch.oauth2 && typeof patch.oauth2 === 'object') {
    _providers.oauth2 = { ..._providers.oauth2, ...patch.oauth2 }
  }
}

function _buildCombinedConfig() {
  const config = {}
  if (_providers.google) config.google = { ..._providers.google }
  if (Object.keys(_providers.oauth2).length > 0) {
    config.oauth2 = { ..._providers.oauth2 }
  }
  return config
}

export async function ensureNativeOAuthInitialized(options = {}) {
  const platform = _normalizePlatform(options.platform)
  if (platform !== 'android') {
    return { initialized: false, platform }
  }

  if (!_initPromise) {
    const socialLogin = options.socialLoginImpl || SocialLogin
    const config = _buildCombinedConfig()
    _initPromise = socialLogin
      .initialize(config)
      .then(() => ({ initialized: true, platform }))
      .catch(error => {
        _initPromise = null
        throw error
      })
  }

  return _initPromise
}

export function getRegisteredNativeOAuthProvidersForTests() {
  return {
    google: _providers.google ? { ..._providers.google } : null,
    oauth2: { ..._providers.oauth2 },
  }
}

export function resetNativeOAuthStateForTests({ clearProviders = false } = {}) {
  _initPromise = null
  if (clearProviders) {
    _providers.google = null
    _providers.oauth2 = {}
  }
}
