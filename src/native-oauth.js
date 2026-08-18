// ── Native OAuth / SocialLogin runtime ────────────────────────────────────────
// Owns the single cached @capgo/capacitor-social-login initialize() call.
// Feature modules register their provider config here (Google for Sporely
// authentication, generic OAuth2 for the iNaturalist identification
// integration) so we never end up with more than one initialize() invocation
// per app run. This module knows nothing about Sporely's auth session or any
// specific provider semantics — those live with the caller.
//
// Loading rule (Stage A cold-start work): the SocialLogin plugin is heavy
// and only needed on Android when the user actually invokes a native login
// (Google sign-in, iNaturalist connect, or a native OAuth callback). This
// module therefore never imports it eagerly. Both a lazy dynamic import and
// a caller-supplied `socialLoginImpl` override are supported — the latter
// keeps tests hermetic without pulling the plugin into the eager bundle.

import { getPlatform } from './platform.js'
import { mark as _bootMark } from './boot-timings.js'

const _providers = { google: null, oauth2: {} }
let _initPromise = null
let _socialLoginPromise = null
let _socialLoginOverride = null

function _normalizePlatform(input) {
  if (typeof input === 'string' && input.trim()) return input.trim().toLowerCase()
  if (typeof window !== 'undefined') return getPlatform() || null
  return null
}

// Dynamic import cached across the app run. The plugin ships an ESM entry
// point that we deliberately do NOT reference from any statically-imported
// module — that keeps it out of the eager `main-*.js` bundle. Rollup / Vite
// will emit it as a separate lazy chunk.
async function _loadSocialLogin() {
  if (_socialLoginOverride) return _socialLoginOverride
  if (!_socialLoginPromise) {
    _socialLoginPromise = import('@capgo/capacitor-social-login')
      .then(mod => mod?.SocialLogin || mod?.default || null)
      .catch(err => {
        // Reset so a later retry (e.g. after connectivity restored on the
        // Play Services download path) can try again.
        _socialLoginPromise = null
        throw err
      })
  }
  return _socialLoginPromise
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
    _initPromise = (async () => {
      _bootMark('native-oauth-init-start', { platform })
      const socialLogin = options.socialLoginImpl || await _loadSocialLogin()
      if (!socialLogin || typeof socialLogin.initialize !== 'function') {
        throw new Error('SocialLogin plugin is not available on this runtime.')
      }
      const config = _buildCombinedConfig()
      await socialLogin.initialize(config)
      _bootMark('native-oauth-init-end', { platform })
      return { initialized: true, platform, socialLogin }
    })().catch(error => {
      _initPromise = null
      throw error
    })
  }

  return _initPromise
}

// Lazy accessor for feature modules that need to call `socialLogin.login()`
// after initialization. Returns the same instance ensureNativeOAuthInitialized
// prepared, so `initialize` runs at most once per app run.
export async function getNativeSocialLogin(options = {}) {
  if (options.socialLoginImpl) return options.socialLoginImpl
  const result = await ensureNativeOAuthInitialized(options)
  return result?.socialLogin || (await _loadSocialLogin())
}

export function getRegisteredNativeOAuthProvidersForTests() {
  return {
    google: _providers.google ? { ..._providers.google } : null,
    oauth2: { ..._providers.oauth2 },
  }
}

// Test hooks — never called from production paths.
export function _setSocialLoginImplForTests(impl) {
  _socialLoginOverride = impl || null
  if (impl) _socialLoginPromise = Promise.resolve(impl)
  else _socialLoginPromise = null
}

export function resetNativeOAuthStateForTests({ clearProviders = false, clearOverride = false } = {}) {
  _initPromise = null
  _socialLoginPromise = null
  if (clearOverride) _socialLoginOverride = null
  if (clearProviders) {
    _providers.google = null
    _providers.oauth2 = {}
  }
}
