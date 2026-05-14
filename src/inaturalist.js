import { Preferences } from '@capacitor/preferences'
import { SocialLogin } from '@capgo/capacitor-social-login'
import { getPlatform } from './platform.js'

export const INAT_WEB_CLIENT_ID = import.meta.env?.VITE_INAT_WEB_CLIENT_ID || 'CMLiS0BuLpF0-izU9hHTb-j_44SY3A4dhAoTB-uf5_0'
export const INAT_WEB_REDIRECT_URI = import.meta.env?.VITE_INAT_WEB_REDIRECT_URI || 'https://app.sporely.no/auth/inaturalist/callback'
export const INAT_ANDROID_CLIENT_ID = import.meta.env?.VITE_INAT_ANDROID_CLIENT_ID || 'bJW2eDa8qF8GJIQbQbuG_LBgmOQYRGMh9-Ja58QBqmc'
export const INAT_ANDROID_REDIRECT_URI = import.meta.env?.VITE_INAT_ANDROID_REDIRECT_URI || 'com.sporelab.sporely://auth'
export const INAT_NATIVE_CLIENT_ID = INAT_ANDROID_CLIENT_ID
export const INAT_NATIVE_REDIRECT_URI = INAT_ANDROID_REDIRECT_URI

export const INAT_PENDING_KEY = 'sporely.inat.oauth.pending'
export const INAT_ACCESS_TOKEN_KEY = 'sporely.inat.oauth.access_token'
export const INAT_REFRESH_TOKEN_KEY = 'sporely.inat.oauth.refresh_token'
export const INAT_EXPIRES_AT_KEY = 'sporely.inat.oauth.expires_at'
export const INAT_API_TOKEN_KEY = 'sporely.inat.oauth.api_token'
export const INAT_API_TOKEN_CREATED_AT_KEY = 'sporely.inat.oauth.api_token_created_at'
export const INAT_API_TOKEN_EXPIRES_AT_KEY = 'sporely.inat.oauth.api_token_expires_at'
export const INAT_USERNAME_KEY = 'sporely.inat.oauth.username'
export const INAT_USER_ID_KEY = 'sporely.inat.oauth.user_id'
export const INAT_CLIENT_ID_KEY = 'sporely.inat.oauth.client_id'
export const INAT_REDIRECT_URI_KEY = 'sporely.inat.oauth.redirect_uri'
export const INAT_PLATFORM_KEY = 'sporely.inat.oauth.platform'

const INAT_AUTH_URL = 'https://www.inaturalist.org/oauth/authorize'
const INAT_TOKEN_URL = 'https://www.inaturalist.org/oauth/token'
const INAT_API_TOKEN_URL = 'https://www.inaturalist.org/users/api_token'
const INAT_USER_PROFILE_URL = 'https://api.inaturalist.org/v1/users/me'
const INAT_WEB_CALLBACK_PATH = '/auth/inaturalist/callback'
const INAT_DEFAULT_SCOPE = 'write'
const INAT_NATIVE_PROVIDER_ID = 'inaturalist'
const API_TOKEN_LIFETIME_MS = 20 * 60 * 60 * 1000
const DEBUG_INAT_OAUTH = true
const SUCCESSFUL_SESSION_KEYS = [
  INAT_ACCESS_TOKEN_KEY,
  INAT_REFRESH_TOKEN_KEY,
  INAT_EXPIRES_AT_KEY,
  INAT_API_TOKEN_KEY,
  INAT_API_TOKEN_CREATED_AT_KEY,
  INAT_API_TOKEN_EXPIRES_AT_KEY,
  INAT_USERNAME_KEY,
  INAT_USER_ID_KEY,
  INAT_CLIENT_ID_KEY,
  INAT_REDIRECT_URI_KEY,
  INAT_PLATFORM_KEY,
]

let _socialLoginInitPromise = null

function _getCrypto() {
  const cryptoImpl = globalThis.crypto
  if (!cryptoImpl?.getRandomValues || !cryptoImpl?.subtle) {
    throw new Error('Cryptography APIs are not available.')
  }
  return cryptoImpl
}

function _bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return globalThis.btoa(binary)
}

function _base64UrlEncode(bytes) {
  return _bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function _utf8Bytes(text) {
  return new TextEncoder().encode(String(text))
}

function _nowMs() {
  return Date.now()
}

function _nowSeconds() {
  return Math.floor(_nowMs() / 1000)
}

function _defaultFetch() {
  if (typeof fetch !== 'function') {
    throw new Error('Fetch is not available.')
  }
  return fetch
}

function _isDebugInatOAuthEnabled() {
  try {
    return globalThis.localStorage?.getItem('sporely-debug-inat-oauth') === 'true'
      || globalThis.sessionStorage?.getItem('sporely-debug-inat-oauth') === 'true'
      || globalThis.location?.search?.includes('debug_inat_oauth=1')
  } catch (_) {
    return false
  }
}

function _debugInatOAuth(message, details = {}) {
  if (!DEBUG_INAT_OAUTH && !_isDebugInatOAuthEnabled()) return
  console.debug(`[inat-oauth] ${message}`, details)
}

function _normalizePlatform(platform) {
  const value = String(platform || '').trim().toLowerCase()
  return value === 'android' ? 'android' : 'web'
}

function _selectedPlatform(options = {}) {
  if (options.platform) return _normalizePlatform(options.platform)
  return _normalizePlatform(typeof window !== 'undefined' ? getPlatform() : null)
}

function _platformConfig(platform) {
  return platform === 'android'
    ? {
        platform: 'android',
        client_id: INAT_ANDROID_CLIENT_ID,
        redirect_uri: INAT_ANDROID_REDIRECT_URI,
      }
    : {
        platform: 'web',
        client_id: INAT_WEB_CLIENT_ID,
        redirect_uri: INAT_WEB_REDIRECT_URI,
      }
}

function _nativeOAuthConfig() {
  return {
    oauth2: {
      [INAT_NATIVE_PROVIDER_ID]: {
        appId: INAT_ANDROID_CLIENT_ID,
        authorizationBaseUrl: INAT_AUTH_URL,
        accessTokenEndpoint: INAT_TOKEN_URL,
        redirectUrl: INAT_ANDROID_REDIRECT_URI,
        scope: INAT_DEFAULT_SCOPE,
        pkceEnabled: true,
        responseType: 'code',
      },
    },
  }
}

function _pluginAccessTokenValue(accessToken) {
  if (!accessToken) return ''
  if (typeof accessToken === 'string') return accessToken.trim()
  if (typeof accessToken === 'object') {
    return _cleanString(
      accessToken.token
      || accessToken.accessToken
      || accessToken.value
      || accessToken.raw
    )
  }
  return _cleanString(accessToken)
}

function _isNativeRuntime() {
  return !!globalThis.Capacitor?.isNativePlatform?.()
    || (typeof window !== 'undefined' && getPlatform() === 'android')
}

function _storageFor(storageImpl) {
  if (storageImpl?.kind && storageImpl?.storage) return storageImpl
  if (storageImpl) return { kind: 'custom', storage: storageImpl }
  if (_isNativeRuntime()) return { kind: 'preferences', storage: Preferences }
  return { kind: 'localStorage', storage: globalThis.localStorage }
}

async function _readStorageValue(adapterOrStorage, key) {
  const adapter = adapterOrStorage?.kind ? adapterOrStorage : _storageFor(adapterOrStorage)
  if (adapter.kind === 'preferences') {
    const { value } = await adapter.storage.get({ key })
    return value ?? null
  }
  if (typeof adapter.storage?.getItem === 'function') {
    return adapter.storage.getItem(key)
  }
  if (typeof adapter.storage?.get === 'function') {
    const { value } = await adapter.storage.get({ key })
    return value ?? null
  }
  return null
}

async function _writeStorageValue(adapterOrStorage, key, value) {
  const adapter = adapterOrStorage?.kind ? adapterOrStorage : _storageFor(adapterOrStorage)
  if (adapter.kind === 'preferences') {
    await adapter.storage.set({ key, value: String(value) })
    return
  }
  if (typeof adapter.storage?.setItem === 'function') {
    adapter.storage.setItem(key, String(value))
    return
  }
  if (typeof adapter.storage?.set === 'function') {
    await adapter.storage.set({ key, value: String(value) })
  }
}

async function _removeStorageValue(adapterOrStorage, key) {
  const adapter = adapterOrStorage?.kind ? adapterOrStorage : _storageFor(adapterOrStorage)
  if (adapter.kind === 'preferences') {
    await adapter.storage.remove({ key })
    return
  }
  if (typeof adapter.storage?.removeItem === 'function') {
    adapter.storage.removeItem(key)
    return
  }
  if (typeof adapter.storage?.remove === 'function') {
    await adapter.storage.remove({ key })
  }
}

function _cleanString(value) {
  return String(value ?? '').trim()
}

function _parseTimestamp(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function _isExpired(expiresAtMs) {
  return Number.isFinite(expiresAtMs) && _nowMs() >= Number(expiresAtMs)
}

async function _jsonOrNull(response) {
  try {
    return await response.json()
  } catch (_) {
    return null
  }
}

async function _responseBody(response) {
  if (typeof response?.text === 'function') {
    try {
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch (_) {
        return text
      }
    } catch (_) {
      return null
    }
  }
  return _jsonOrNull(response)
}

function _httpErrorMessage(label, response, payload) {
  const statusPart = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim()
  const payloadMessage = payload && typeof payload === 'object'
    ? payload.error_description || payload.error || payload.message || payload.detail || null
    : (typeof payload === 'string' ? payload.trim() || null : null)
  const bodyPart = payloadMessage ? ` ${payloadMessage}` : ''
  return `${label} failed: ${statusPart}${bodyPart}`
}

async function _fetchJson(fetchImpl, url, options = {}) {
  const { label, ...fetchOptions } = options || {}
  const response = await fetchImpl(url, fetchOptions)
  const payload = await _responseBody(response)
  if (!response.ok) {
    throw new Error(_httpErrorMessage(label || url, response, payload))
  }
  return payload
}

async function _generateRandomBase64Url(bytesLength) {
  const cryptoImpl = _getCrypto()
  const bytes = new Uint8Array(bytesLength)
  cryptoImpl.getRandomValues(bytes)
  return _base64UrlEncode(bytes)
}

async function _generateCodeVerifier() {
  return _generateRandomBase64Url(64)
}

async function _generateCodeChallenge(verifier) {
  const cryptoImpl = _getCrypto()
  const hash = await cryptoImpl.subtle.digest('SHA-256', _utf8Bytes(verifier))
  return _base64UrlEncode(new Uint8Array(hash))
}

function _isSuccessfulSession(session) {
  return Boolean(
    session
    && _cleanString(session.api_token)
    && _cleanString(session.username)
  )
}

function _normalizeSessionShape({
  access_token = null,
  refresh_token = null,
  expires_at = null,
  api_token = null,
  api_token_created_at = null,
  api_token_expires_at = null,
  username = null,
  user_id = null,
  client_id = null,
  redirect_uri = null,
  platform = null,
} = {}) {
  const normalizedUserId = user_id ?? null
  const normalizedUsername = username ?? null
  const normalizedAccessToken = access_token ?? null
  const normalizedApiToken = api_token ?? null
  const hasValidApiToken = Boolean(_cleanString(normalizedApiToken) && (api_token_expires_at === null || !_isExpired(api_token_expires_at)))
  const hasUsername = Boolean(_cleanString(normalizedUsername))
  const connected = hasValidApiToken && hasUsername

  return {
    connected,
    logged_in: connected,
    username: normalizedUsername,
    user_id: normalizedUserId,
    userId: normalizedUserId,
    access_token: normalizedAccessToken,
    accessToken: normalizedAccessToken,
    refresh_token: refresh_token ?? null,
    refreshToken: refresh_token ?? null,
    api_token: normalizedApiToken,
    apiToken: normalizedApiToken,
    expires_at: expires_at ?? null,
    expiresAt: expires_at ?? null,
    api_token_created_at: api_token_created_at ?? null,
    apiTokenCreatedAt: api_token_created_at ?? null,
    api_token_expires_at: api_token_expires_at ?? null,
    apiTokenExpiresAt: api_token_expires_at ?? null,
    client_id: client_id ?? null,
    clientId: client_id ?? null,
    redirect_uri: redirect_uri ?? null,
    redirectUri: redirect_uri ?? null,
    platform: platform ?? null,
  }
}

async function _loadStoredSession(storageImpl) {
  const storage = _storageFor(storageImpl)
  const values = await Promise.all([
    _readStorageValue(storage, INAT_ACCESS_TOKEN_KEY),
    _readStorageValue(storage, INAT_REFRESH_TOKEN_KEY),
    _readStorageValue(storage, INAT_EXPIRES_AT_KEY),
    _readStorageValue(storage, INAT_API_TOKEN_KEY),
    _readStorageValue(storage, INAT_API_TOKEN_CREATED_AT_KEY),
    _readStorageValue(storage, INAT_API_TOKEN_EXPIRES_AT_KEY),
    _readStorageValue(storage, INAT_USERNAME_KEY),
    _readStorageValue(storage, INAT_USER_ID_KEY),
    _readStorageValue(storage, INAT_CLIENT_ID_KEY),
    _readStorageValue(storage, INAT_REDIRECT_URI_KEY),
    _readStorageValue(storage, INAT_PLATFORM_KEY),
  ])

  return _normalizeSessionShape({
    access_token: values[0],
    refresh_token: values[1],
    expires_at: _parseTimestamp(values[2]),
    api_token: values[3],
    api_token_created_at: _parseTimestamp(values[4]),
    api_token_expires_at: _parseTimestamp(values[5]),
    username: values[6],
    user_id: values[7],
    client_id: values[8],
    redirect_uri: values[9],
    platform: values[10],
  })
}

async function _persistSession(session, storageImpl) {
  const storage = _storageFor(storageImpl)
  await Promise.all([
    _writeStorageValue(storage, INAT_ACCESS_TOKEN_KEY, session.access_token ?? ''),
    _writeStorageValue(storage, INAT_REFRESH_TOKEN_KEY, session.refresh_token ?? ''),
    _writeStorageValue(storage, INAT_EXPIRES_AT_KEY, session.expires_at ?? ''),
    _writeStorageValue(storage, INAT_API_TOKEN_KEY, session.api_token ?? ''),
    _writeStorageValue(storage, INAT_API_TOKEN_CREATED_AT_KEY, session.api_token_created_at ?? ''),
    _writeStorageValue(storage, INAT_API_TOKEN_EXPIRES_AT_KEY, session.api_token_expires_at ?? ''),
    _writeStorageValue(storage, INAT_USERNAME_KEY, session.username ?? ''),
    _writeStorageValue(storage, INAT_USER_ID_KEY, session.user_id ?? ''),
    _writeStorageValue(storage, INAT_CLIENT_ID_KEY, session.client_id ?? ''),
    _writeStorageValue(storage, INAT_REDIRECT_URI_KEY, session.redirect_uri ?? ''),
    _writeStorageValue(storage, INAT_PLATFORM_KEY, session.platform ?? ''),
  ])
}

export async function persistInaturalistSession(session, storageImpl) {
  await _persistSession(session, storageImpl)
}

export function normalizeCapgoOAuth2Result(pluginResult) {
  const result = pluginResult?.result || pluginResult || {}
  const accessToken = _pluginAccessTokenValue(result.accessToken)
  const refreshToken = _cleanString(result.refreshToken || result.refresh_token)
  const idToken = _cleanString(result.idToken || result.id_token)
  const tokenType = _cleanString(result.tokenType || result.token_type || 'bearer')
  const scope = Array.isArray(result.scope)
    ? result.scope.map(value => _cleanString(value)).filter(Boolean)
    : String(result.scope || '')
        .split(/\s+/)
        .map(value => value.trim())
        .filter(Boolean)
  const expiresIn = Number.isFinite(Number(result.expiresIn))
    ? Number(result.expiresIn)
    : (Number.isFinite(Number(result.expires_in)) ? Number(result.expires_in) : null)

  return {
    providerId: _cleanString(result.providerId || pluginResult?.providerId || INAT_NATIVE_PROVIDER_ID),
    access_token: accessToken || null,
    accessToken: accessToken || null,
    refresh_token: refreshToken || null,
    refreshToken: refreshToken || null,
    id_token: idToken || null,
    idToken: idToken || null,
    token_type: tokenType || 'bearer',
    tokenType: tokenType || 'bearer',
    scope,
    expires_in: expiresIn,
    expiresIn,
    resourceData: result.resourceData ?? null,
    raw: pluginResult,
  }
}

export async function fetchInaturalistProfile(accessToken, fetchImpl = _defaultFetch()) {
  _debugInatOAuth('profile fetch with oauth access token requested', {
    url: INAT_USER_PROFILE_URL,
  })
  return _fetchUserProfileWithOauthAccessToken(accessToken, fetchImpl)
}

async function _fetchUserProfileWithOauthAccessToken(accessToken, fetchImpl = _defaultFetch()) {
  const response = await fetchImpl(INAT_USER_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const payload = await _responseBody(response)
  _debugInatOAuth('profile fetch completed', {
    url: INAT_USER_PROFILE_URL,
    status: response.status,
    ok: response.ok,
  })
  if (!response.ok) {
    throw new Error(_httpErrorMessage('iNaturalist profile fetch', response, payload))
  }
  const user = payload?.results?.[0] || payload?.user || payload?.data?.[0] || {}
  const userId = user.id ?? user.user_id ?? user.userId ?? null
  const login = user.login ?? user.name ?? user.username ?? null
  if (userId === null || !_cleanString(login)) {
    throw new Error('Failed to read iNaturalist user profile.')
  }
  return { id: userId, login: String(login) }
}

export async function fetchInaturalistProfileWithApiToken(apiToken, fetchImpl = _defaultFetch()) {
  const response = await fetchImpl(INAT_USER_PROFILE_URL, {
    headers: {
      Authorization: apiToken,
    },
  })
  const payload = await _responseBody(response)
  _debugInatOAuth('profile fetch with api token completed', {
    url: INAT_USER_PROFILE_URL,
    status: response.status,
    ok: response.ok,
  })
  if (!response.ok) {
    throw new Error(_httpErrorMessage('iNaturalist profile fetch', response, payload))
  }
  const user = payload?.results?.[0] || payload?.user || payload?.data?.[0] || {}
  const userId = user.id ?? user.user_id ?? user.userId ?? null
  const login = user.login ?? user.name ?? user.username ?? null
  if (userId === null || !_cleanString(login)) {
    throw new Error('Failed to read iNaturalist user profile.')
  }
  return { id: userId, login: String(login) }
}

export async function fetchInaturalistApiToken(accessToken, fetchImpl = _defaultFetch()) {
  const response = await fetchImpl(INAT_API_TOKEN_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const payload = await _responseBody(response)
  _debugInatOAuth('api token fetch completed', {
    url: INAT_API_TOKEN_URL,
    status: response.status,
    ok: response.ok,
  })
  if (!response.ok) {
    throw new Error(_httpErrorMessage('iNaturalist API token fetch', response, payload))
  }
  const apiToken = _cleanString(payload?.api_token)
  if (!apiToken) {
    throw new Error('iNaturalist API token response did not include api_token.')
  }
  return {
    api_token: apiToken,
    apiToken,
  }
}

export async function completeNativeInaturalistLogin(pluginResult, options = {}) {
  const normalized = normalizeCapgoOAuth2Result(pluginResult)
  const accessToken = _cleanString(normalized.access_token)
  if (!accessToken) {
    _debugInatOAuth('native OAuth login returned no access token', {
      providerId: normalized.providerId,
    })
    throw new Error('native OAuth login returned no access token')
  }

  const fetchImpl = options.fetchImpl || _defaultFetch()
  const storage = _storageFor(options.storage)
  const currentPlatform = typeof window !== 'undefined' ? getPlatform() : null
  _debugInatOAuth('complete native login started', {
    selectedPlatform: _normalizePlatform(options.platform || currentPlatform),
    capacitorPlatform: currentPlatform,
    capacitorNative: !!globalThis.Capacitor?.isNativePlatform?.(),
    storageKind: storage.kind,
    hasInitializeCompleted: true,
  })
  const apiToken = await fetchInaturalistApiToken(accessToken, fetchImpl)
  const profile = await fetchInaturalistProfileWithApiToken(apiToken.api_token, fetchImpl)
  const now = _nowMs()
  const session = {
    connected: true,
    logged_in: true,
    username: profile.login,
    user_id: profile.id,
    userId: profile.id,
    access_token: accessToken,
    accessToken: accessToken,
    refresh_token: normalized.refresh_token || null,
    refreshToken: normalized.refresh_token || null,
    api_token: apiToken.api_token,
    apiToken: apiToken.apiToken,
    api_token_created_at: now,
    apiTokenCreatedAt: now,
    api_token_expires_at: now + API_TOKEN_LIFETIME_MS,
    apiTokenExpiresAt: now + API_TOKEN_LIFETIME_MS,
    expires_at: normalized.expires_in !== null ? now + (Number(normalized.expires_in) * 1000) : null,
    expiresAt: normalized.expires_in !== null ? now + (Number(normalized.expires_in) * 1000) : null,
    platform: _normalizePlatform(options.platform || currentPlatform || 'android'),
    client_id: INAT_ANDROID_CLIENT_ID,
    redirect_uri: INAT_ANDROID_REDIRECT_URI,
    scope: normalized.scope,
    token_type: normalized.tokenType,
  }
  _debugInatOAuth('persisting native session', {
    storageKind: storage.kind,
    hasAccessToken: true,
    hasApiToken: true,
    hasUsername: Boolean(profile.login),
  })
  await persistInaturalistSession(session, storage)
  const readbackApiToken = await _readStorageValue(storage, INAT_API_TOKEN_KEY)
  const readbackUsername = await _readStorageValue(storage, INAT_USERNAME_KEY)
  _debugInatOAuth(`session persisted to ${storage.kind}: api_token=${Boolean(readbackApiToken)} username=${Boolean(readbackUsername)}`, {
    storageKind: storage.kind,
    apiTokenExists: Boolean(readbackApiToken),
    usernameExists: Boolean(readbackUsername),
  })
  if (!readbackApiToken || !readbackUsername) {
    _debugInatOAuth(`session readback failed from ${storage.kind}`, {
      storageKind: storage.kind,
      apiTokenExists: Boolean(readbackApiToken),
      usernameExists: Boolean(readbackUsername),
    })
  }
  _debugInatOAuth('persisted native session', {
    platform: session.platform,
    providerId: normalized.providerId,
    redirectUrl: session.redirect_uri,
    hasAccessToken: Boolean(accessToken),
    tokenStatus: 'ok',
    profileStatus: 'ok',
    apiTokenStatus: 'ok',
    persistedFields: ['access_token', 'refresh_token', 'api_token', 'username', 'user_id'],
  })
  return _normalizeSessionShape(session)
}

export async function initializeInaturalistOAuth(options = {}) {
  const platform = _normalizePlatform(options.platform || (typeof window !== 'undefined' ? getPlatform() : null))
  if (platform !== 'android') return { initialized: false, platform }

  if (!_socialLoginInitPromise) {
    const socialLogin = options.socialLoginImpl || SocialLogin
    const initConfig = _nativeOAuthConfig()
    _debugInatOAuth('initializing native social login', {
      platform,
      providerId: INAT_NATIVE_PROVIDER_ID,
      redirectUrl: initConfig.oauth2[INAT_NATIVE_PROVIDER_ID].redirectUrl,
    })
    _socialLoginInitPromise = socialLogin.initialize(initConfig)
      .then(() => {
        _debugInatOAuth('SocialLogin.initialize completed', {
          platform,
          providerId: INAT_NATIVE_PROVIDER_ID,
        })
        return { initialized: true, platform }
      })
      .catch(error => {
        _socialLoginInitPromise = null
        throw error
      })
  }

  return _socialLoginInitPromise
}

export async function connectInaturalist(options = {}) {
  const platform = _normalizePlatform(options.platform || (typeof window !== 'undefined' ? getPlatform() : null))
  if (platform === 'android') {
    await initializeInaturalistOAuth({
      platform,
      socialLoginImpl: options.socialLoginImpl,
    })
    const socialLogin = options.socialLoginImpl || SocialLogin
    const loginResult = await socialLogin.login({
      provider: 'oauth2',
      options: {
        providerId: INAT_NATIVE_PROVIDER_ID,
        scope: INAT_DEFAULT_SCOPE,
      },
    })
    console.log('[inat-oauth] raw plugin result shape', {
      hasResult: !!loginResult,
      topKeys: loginResult ? Object.keys(loginResult) : [],
      resultKeys: loginResult?.result ? Object.keys(loginResult.result) : [],
      accessTokenKeys: loginResult?.result?.accessToken
        ? Object.keys(loginResult.result.accessToken)
        : [],
      hasAccessTokenToken: !!loginResult?.result?.accessToken?.token,
    })
    const normalizedResult = normalizeCapgoOAuth2Result(loginResult)
    _debugInatOAuth('native login returned', {
      platform,
      providerId: INAT_NATIVE_PROVIDER_ID,
      redirectUrl: INAT_ANDROID_REDIRECT_URI,
      hasAccessToken: Boolean(normalizedResult.access_token),
      tokenStatus: 'received',
    })
    if (!normalizedResult.access_token) {
      _debugInatOAuth('native OAuth login returned no access token', {
        platform,
        providerId: normalizedResult.providerId,
      })
      throw new Error('native OAuth login returned no access token')
    }
    return completeNativeInaturalistLogin(loginResult, options)
  }

  const authUrl = await buildInaturalistAuthorizationUrl({
    ...options,
    platform: 'web',
  })
  if (typeof options.onWebRedirect === 'function') {
    options.onWebRedirect(authUrl)
  } else if (typeof window !== 'undefined' && window.location) {
    window.location.href = authUrl
  }
  return { redirected: true, authUrl }
}

export function resetInaturalistOAuthStateForTests() {
  _socialLoginInitPromise = null
}

async function _refreshAccessTokenIfNeeded(session, storageImpl, fetchImpl = _defaultFetch()) {
  const accessToken = _cleanString(session.access_token)
  const refreshToken = _cleanString(session.refresh_token)
  if (accessToken && !_isExpired(session.expires_at)) {
    return session
  }
  if (!refreshToken) {
    return session
  }

  const platform = _normalizePlatform(session.platform || 'web')
  const config = _platformConfig(platform)
  const clientId = _cleanString(session.client_id) || config.client_id
  const redirectUri = _cleanString(session.redirect_uri) || config.redirect_uri
  if (!clientId || !redirectUri) {
    return session
  }

  const params = new URLSearchParams()
  params.set('client_id', clientId)
  params.set('redirect_uri', redirectUri)
  params.set('grant_type', 'refresh_token')
  params.set('refresh_token', refreshToken)

  try {
    const tokenData = await _fetchJson(fetchImpl, INAT_TOKEN_URL, {
      method: 'POST',
      body: params,
      label: 'iNaturalist access token refresh',
    })

    const nextAccessToken = _cleanString(tokenData?.access_token)
    if (!nextAccessToken) {
      return session
    }

    const nextRefreshToken = _cleanString(tokenData?.refresh_token) || refreshToken
    const createdAtSeconds = Number.isFinite(Number(tokenData?.created_at)) ? Number(tokenData.created_at) : _nowSeconds()
    const expiresInSeconds = Number.isFinite(Number(tokenData?.expires_in)) ? Number(tokenData.expires_in) : null
    const expiresAt = expiresInSeconds !== null ? ((createdAtSeconds + expiresInSeconds) * 1000) : session.expires_at

    const nextSession = {
      ...session,
      access_token: nextAccessToken,
      refresh_token: nextRefreshToken,
      expires_at: expiresAt ?? null,
      client_id: clientId,
      redirect_uri: redirectUri,
      platform,
    }
    await _persistSession(nextSession, storageImpl)
    return nextSession
  } catch (error) {
    console.warn('iNaturalist access token refresh failed:', error)
    return session
  }
}

async function _refreshApiTokenIfNeeded(session, storageImpl, fetchImpl = _defaultFetch()) {
  const apiToken = _cleanString(session.api_token)
  if (apiToken && !_isExpired(session.api_token_expires_at)) {
    return session
  }

  const accessToken = _cleanString(session.access_token)
  if (!accessToken) {
    return session
  }

  try {
    const payload = await _fetchJson(fetchImpl, INAT_API_TOKEN_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      label: 'iNaturalist API token refresh',
    })
    const nextApiToken = _cleanString(payload?.api_token)
    if (!nextApiToken) {
      return session
    }
    const createdAt = _nowMs()
    const nextSession = {
      ...session,
      api_token: nextApiToken,
      api_token_created_at: createdAt,
      api_token_expires_at: createdAt + API_TOKEN_LIFETIME_MS,
    }
    await _persistSession(nextSession, storageImpl)
    return nextSession
  } catch (error) {
    console.warn('iNaturalist API token refresh failed:', error)
    return session
  }
}

async function _fetchUserProfile(accessToken, fetchImpl = _defaultFetch()) {
  const payload = await _fetchJson(fetchImpl, INAT_USER_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    label: 'iNaturalist profile fetch',
  })
  const user = payload?.results?.[0] || payload?.user || payload?.data?.[0] || {}
  const userId = user.id ?? user.user_id ?? user.userId ?? null
  const login = user.login ?? user.name ?? user.username ?? null
  if (userId === null || !_cleanString(login)) {
    throw new Error('Failed to read iNaturalist user profile.')
  }
  return { id: userId, login: String(login) }
}

function _looksLikeRootRescue(pathname) {
  return pathname === '' || pathname === '/'
}

function _isWebCallback(urlObj) {
  return urlObj.pathname === INAT_WEB_CALLBACK_PATH
}

function _isAndroidCallback(urlObj) {
  return urlObj.protocol === 'com.sporelab.sporely:' && urlObj.hostname === 'auth'
}

function _pendingMatchesState(pendingState, state) {
  return !!pendingState
    && pendingState.flow === 'inat-oauth'
    && _cleanString(pendingState.state) === _cleanString(state)
}

function _hasSupabaseRecoveryIndicators(urlObj) {
  const hashParams = new URLSearchParams(String(urlObj.hash || '').replace(/^#/, ''))
  const read = key => urlObj.searchParams.get(key) || hashParams.get(key)

  return (
    read('flow') === 'recovery'
    || read('type') === 'recovery'
    || read('screen') === 'reset-password'
    || urlObj.searchParams.has('access_token')
    || hashParams.has('access_token')
    || urlObj.searchParams.has('refresh_token')
    || hashParams.has('refresh_token')
    || urlObj.searchParams.has('token_hash')
    || hashParams.has('token_hash')
  )
}

export async function setInatItem(key, value, storageImpl) {
  const storage = _storageFor(storageImpl)
  await _writeStorageValue(storage, key, value)
}

export async function getInatItem(key, storageImpl) {
  const storage = _storageFor(storageImpl)
  return _readStorageValue(storage, key)
}

export async function removeInatItem(key, storageImpl) {
  const storage = _storageFor(storageImpl)
  await _removeStorageValue(storage, key)
}

export async function saveInatPendingState(state, storageImpl) {
  await setInatItem(INAT_PENDING_KEY, JSON.stringify(state), storageImpl)
}

export async function loadInatPendingState(storageImpl) {
  const value = await getInatItem(INAT_PENDING_KEY, storageImpl)
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

export async function clearInatPendingState(storageImpl) {
  await removeInatItem(INAT_PENDING_KEY, storageImpl)
}

export function isWebInatOAuthConfigured() {
  return _cleanString(INAT_WEB_CLIENT_ID) !== '' && INAT_WEB_REDIRECT_URI.startsWith('https://')
}

export async function buildInaturalistAuthorizationUrl(options = {}) {
  const platform = _selectedPlatform(options)
  const config = _platformConfig(platform)
  if (!config.client_id || !config.redirect_uri) {
    throw new Error('iNaturalist OAuth is not configured for this platform.')
  }

  const state = _cleanString(options.state) || await _generateRandomBase64Url(16)
  const codeVerifier = _cleanString(options.code_verifier || options.codeVerifier) || await _generateCodeVerifier()
  const codeChallenge = _cleanString(options.code_challenge || options.codeChallenge) || await _generateCodeChallenge(codeVerifier)
  const pending = {
    flow: 'inat-oauth',
    state,
    code_verifier: codeVerifier,
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    platform: config.platform,
    created_at: _nowMs(),
  }

  await saveInatPendingState(pending, options.storage)

  const url = new URL(INAT_AUTH_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.client_id)
  url.searchParams.set('redirect_uri', config.redirect_uri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', options.scope ? String(options.scope) : INAT_DEFAULT_SCOPE)
  return url.toString()
}

export async function loadInaturalistSession(storageImpl, options = {}) {
  let session = await _loadStoredSession(storageImpl)
  const fetchImpl = options.fetchImpl || _defaultFetch()

  session = await _refreshAccessTokenIfNeeded(session, storageImpl, fetchImpl)
  session = await _refreshApiTokenIfNeeded(session, storageImpl, fetchImpl)

  return _normalizeSessionShape(session)
}

export async function completeInaturalistOAuthCallback(input, stateOrOptions, maybeOptions) {
  let code = null
  let state = null
  let options = {}

  if (typeof input === 'string' && typeof stateOrOptions === 'string') {
    code = input
    state = stateOrOptions
    options = maybeOptions || {}
  } else if (typeof input === 'string') {
    const urlObj = new URL(input)
    code = urlObj.searchParams.get('code')
    state = urlObj.searchParams.get('state')
    options = stateOrOptions || {}
  } else if (input && typeof input === 'object') {
    code = input.code || null
    state = input.state || null
    options = stateOrOptions || {}
  } else {
    options = stateOrOptions || {}
  }

  code = _cleanString(code)
  state = _cleanString(state)
  if (!code || !state) {
    throw new Error('iNaturalist OAuth callback is missing code or state.')
  }

  const storage = _storageFor(options.storage)
  const pendingState = await loadInatPendingState(storage)
  const storedSession = await _loadStoredSession(storage)
  if (!pendingState) {
    if (_isSuccessfulSession(storedSession)) {
      return _normalizeSessionShape(storedSession)
    }
    throw new Error('iNaturalist OAuth state mismatch. Please try again.')
  }
  if (pendingState.flow !== 'inat-oauth' || _cleanString(pendingState.state) !== state) {
    throw new Error('iNaturalist OAuth state mismatch. Please try again.')
  }

  const clientId = _cleanString(pendingState.client_id)
  const redirectUri = _cleanString(pendingState.redirect_uri)
  const codeVerifier = _cleanString(pendingState.code_verifier)
  if (!clientId || !redirectUri || !codeVerifier) {
    throw new Error('iNaturalist OAuth pending state is incomplete.')
  }

  const fetchImpl = options.fetchImpl || _defaultFetch()
  const params = new URLSearchParams()
  params.set('grant_type', 'authorization_code')
  params.set('client_id', clientId)
  params.set('redirect_uri', redirectUri)
  params.set('code', code)
  params.set('code_verifier', codeVerifier)

  const tokenData = await _fetchJson(fetchImpl, INAT_TOKEN_URL, {
    method: 'POST',
    body: params,
    label: 'iNaturalist token exchange',
  })

  const accessToken = _cleanString(tokenData?.access_token)
  if (!accessToken) {
    throw new Error('iNaturalist token exchange failed: missing access token.')
  }
  const refreshToken = _cleanString(tokenData?.refresh_token)
  const createdAtSeconds = Number.isFinite(Number(tokenData?.created_at)) ? Number(tokenData.created_at) : _nowSeconds()
  const expiresInSeconds = Number.isFinite(Number(tokenData?.expires_in)) ? Number(tokenData.expires_in) : null
  const expiresAt = expiresInSeconds !== null ? ((createdAtSeconds + expiresInSeconds) * 1000) : null

  const apiToken = await fetchInaturalistApiToken(accessToken, fetchImpl)
  const userProfile = await fetchInaturalistProfileWithApiToken(apiToken.api_token, fetchImpl)

  const now = _nowMs()
  const nextSession = {
    access_token: accessToken,
    refresh_token: refreshToken || storedSession.refresh_token || null,
    expires_at: expiresAt,
    api_token: apiToken.api_token,
    api_token_created_at: now,
    api_token_expires_at: now + API_TOKEN_LIFETIME_MS,
    username: userProfile.login,
    user_id: userProfile.id,
    client_id: clientId,
    redirect_uri: redirectUri,
    platform: pendingState.platform || _platformConfig(_normalizePlatform(pendingState.platform)).platform,
  }

  await _persistSession(nextSession, storage)
  await clearInatPendingState(storage)
  return _normalizeSessionShape(nextSession)
}

export async function maybeHandleInaturalistOAuthReturn(url, options = {}) {
  let parsed
  try {
    const pendingState = await loadInatPendingState(options.storage)
    parsed = await parseInaturalistCallbackUrl(url, { pendingState, storage: options.storage })
  } catch (error) {
    options.onError?.(error)
    return { handled: false, scrubUrl: false, status: 'error', error }
  }

  if (parsed.kind === 'other') {
    return { handled: false, scrubUrl: false, status: 'ignored' }
  }

  if (parsed.kind === 'error') {
    const error = new Error(parsed.errorDescription || parsed.error || 'iNaturalist OAuth failed.')
    options.onError?.(error)
    return { handled: true, scrubUrl: true, status: 'provider-denied', error }
  }

  try {
    const session = await completeInaturalistOAuthCallback(parsed, { storage: options.storage, fetchImpl: options.fetchImpl })
    options.onSuccess?.(session)
    return { handled: true, scrubUrl: true, status: 'success', session }
  } catch (error) {
    options.onError?.(error)
    return { handled: true, scrubUrl: false, status: 'error', error }
  }
}

export async function parseInaturalistCallbackUrl(url, options = {}) {
  const urlObj = new URL(url, globalThis.location?.href || 'https://app.sporely.no/')
  const code = urlObj.searchParams.get('code')
  const state = urlObj.searchParams.get('state')
  const error = urlObj.searchParams.get('error')
  const errorDescription = urlObj.searchParams.get('error_description')
  const pendingState = options.pendingState || null

  const isWebCallback = _isWebCallback(urlObj)
  const isAndroidCallback = _isAndroidCallback(urlObj)
  const isCanonicalCallback = isWebCallback || isAndroidCallback
  if (!isCanonicalCallback && _hasSupabaseRecoveryIndicators(urlObj)) {
    return { kind: 'other', matches_inat: false }
  }
  const isRootRescue = _looksLikeRootRescue(urlObj.pathname) && _cleanString(code) && _cleanString(state)

  if (isCanonicalCallback) {
    if (error) {
      return {
        kind: 'error',
        error,
        errorDescription,
        code,
        state,
        matches_inat: true,
        platform: isAndroidCallback ? 'android' : 'web',
        redirect_uri: isAndroidCallback ? INAT_ANDROID_REDIRECT_URI : INAT_WEB_REDIRECT_URI,
      }
    }
    if (_cleanString(code) && _cleanString(state)) {
      return {
        kind: 'success',
        code,
        state,
        matches_inat: true,
        platform: isAndroidCallback ? 'android' : 'web',
        redirect_uri: isAndroidCallback ? INAT_ANDROID_REDIRECT_URI : INAT_WEB_REDIRECT_URI,
      }
    }
    return { kind: 'other', matches_inat: true }
  }

  if (isRootRescue && _pendingMatchesState(pendingState, state)) {
    return {
      kind: 'success',
      code,
      state,
      matches_inat: true,
      platform: pendingState.platform || 'web',
      redirect_uri: pendingState.redirect_uri || INAT_WEB_REDIRECT_URI,
    }
  }

  return { kind: 'other', matches_inat: false }
}

export async function forgetInaturalistSession() {
  const storage = _storageFor()
  await Promise.all(SUCCESSFUL_SESSION_KEYS.map(key => removeInatItem(key, storage)))
  await clearInatPendingState(storage)
}
