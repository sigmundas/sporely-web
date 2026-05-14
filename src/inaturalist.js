// src/inaturalist.js (Conceptual file, as it was not provided in context)

import { Preferences } from '@capacitor/preferences';
import { isNativeApp, getPlatform } from './platform.js';

// Environment variables for iNaturalist OAuth
// Native app uses these
export const INAT_NATIVE_CLIENT_ID = import.meta.env.VITE_INAT_NATIVE_CLIENT_ID || 'bJW2eDa8qF8GJIQbQbuG_LBgmOQYRGMh9-Ja58QBqmc';
export const INAT_NATIVE_REDIRECT_URI = import.meta.env.VITE_INAT_NATIVE_REDIRECT_URI || 'com.sporelab.sporely://auth';

// Web/PWA uses these (must be HTTPS)
export const INAT_WEB_CLIENT_ID = import.meta.env.VITE_INAT_WEB_CLIENT_ID || 'CMLiS0BuLpF0-izU9hHTb-j_44SY3A4dhAoTB-uf5_0';
export const INAT_WEB_REDIRECT_URI = import.meta.env.VITE_INAT_WEB_REDIRECT_URI || 'https://app.sporely.no/';

// Storage keys
export const INAT_PENDING_KEY = 'sporely.inat.oauth.pending';
export const INAT_ACCESS_TOKEN_KEY = 'sporely.inat.oauth.access_token';
export const INAT_REFRESH_TOKEN_KEY = 'sporely.inat.oauth.refresh_token';
export const INAT_EXPIRES_AT_KEY = 'sporely.inat.oauth.expires_at';
export const INAT_USERNAME_KEY = 'sporely.inat.oauth.username';
export const INAT_USER_ID_KEY = 'sporely.inat.oauth.user_id';

// PKCE Helper functions
async function generateCodeVerifier() {
  const randomBytes = new Uint8Array(32);
  window.crypto.getRandomValues(randomBytes);
  return btoa(String.fromCharCode.apply(null, randomBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getStorage(storageImpl) {
  return storageImpl || (isNativeApp() ? Preferences : localStorage);
}

export async function setInatItem(key, value, storageImpl) {
  const storage = getStorage(storageImpl);
  if (isNativeApp()) {
    await storage.set({ key, value: String(value) });
  } else {
    storage.setItem(key, String(value));
  }
}

export async function getInatItem(key, storageImpl) {
  const storage = getStorage(storageImpl);
  if (isNativeApp()) {
    const { value } = await storage.get({ key });
    return value;
  } else {
    return storage.getItem(key);
  }
}

export async function removeInatItem(key, storageImpl) {
  const storage = getStorage(storageImpl);
  if (isNativeApp()) {
    await storage.remove({ key });
  } else {
    storage.removeItem(key);
  }
}

export async function saveInatPendingState(state, storageImpl) {
  await setInatItem(INAT_PENDING_KEY, JSON.stringify(state), storageImpl);
}

export async function loadInatPendingState(storageImpl) {
  const value = await getInatItem(INAT_PENDING_KEY, storageImpl);
  return value ? JSON.parse(value) : null;
}

export async function clearInatPendingState(storageImpl) {
  await removeInatItem(INAT_PENDING_KEY, storageImpl);
}

export function isWebInatOAuthConfigured() {
  return !!INAT_WEB_CLIENT_ID && !!INAT_WEB_REDIRECT_URI && INAT_WEB_REDIRECT_URI.startsWith('https://');
}

export async function buildInaturalistAuthorizationUrl(options = {}) {
  const isNative = getPlatform() === 'android' || getPlatform() === 'ios';
  let clientId, redirectUri;

  if (isNative) {
    clientId = INAT_NATIVE_CLIENT_ID;
    redirectUri = INAT_NATIVE_REDIRECT_URI;
  } else { // Web/PWA
    if (!isWebInatOAuthConfigured()) {
      throw new Error('iNaturalist web OAuth is not configured.');
    }
    clientId = INAT_WEB_CLIENT_ID;
    redirectUri = INAT_WEB_REDIRECT_URI;
  }

  const state = options.state || Math.random().toString(36).substring(2);
  const codeVerifier = await generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  await saveInatPendingState({ state, codeVerifier });

  const url = new URL('https://www.inaturalist.org/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'write');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function loadInaturalistSession() {
  const accessToken = await getInatItem(INAT_ACCESS_TOKEN_KEY);
  const refreshToken = await getInatItem(INAT_REFRESH_TOKEN_KEY);
  const expiresAt = Number(await getInatItem(INAT_EXPIRES_AT_KEY));
  const username = await getInatItem(INAT_USERNAME_KEY);
  const userId = await getInatItem(INAT_USER_ID_KEY);

  if (!accessToken || !refreshToken || !username) {
    return { connected: false };
  }

  if (Date.now() < expiresAt) {
    return { connected: true, username, userId, accessToken };
  }

  // Token expired, try to refresh
  const isNative = isNativeApp();
  const clientId = isNative ? INAT_NATIVE_CLIENT_ID : INAT_WEB_CLIENT_ID;
  const redirectUri = isNative ? INAT_NATIVE_REDIRECT_URI : INAT_WEB_REDIRECT_URI;

  const tokenUrl = 'https://www.inaturalist.org/oauth/token';
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('refresh_token', refreshToken);
  params.append('redirect_uri', redirectUri);
  params.append('grant_type', 'refresh_token');

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      body: params,
    });

    if (!response.ok) {
      throw new Error('Refresh token failed');
    }

    const tokenData = await response.json();
    const newExpiresAt = (tokenData.created_at + tokenData.expires_in) * 1000;

    await Promise.all([
      setInatItem(INAT_ACCESS_TOKEN_KEY, tokenData.access_token),
      setInatItem(INAT_REFRESH_TOKEN_KEY, tokenData.refresh_token),
      setInatItem(INAT_EXPIRES_AT_KEY, newExpiresAt),
    ]);

    return { connected: true, username, userId, accessToken: tokenData.access_token };
  } catch (error) {
    console.error('iNaturalist token refresh failed:', error);
    await forgetInaturalistSession();
    return { connected: false };
  }
}

export function parseInaturalistCallbackUrl(url) {
  const urlObj = new URL(url);
  const code = urlObj.searchParams.get('code');
  const state = urlObj.searchParams.get('state');
  const error = urlObj.searchParams.get('error');
  const errorDescription = urlObj.searchParams.get('error_description');

  const isWebCallback = url.startsWith(INAT_WEB_REDIRECT_URI);
  const isNativeCallback = url.startsWith(INAT_NATIVE_REDIRECT_URI);

  if (!isWebCallback && !isNativeCallback) {
    return { kind: 'other', matches_inat: false };
  }

  if (error) {
    return { kind: 'error', error, errorDescription, matches_inat: true };
  }

  if (code && state) {
    return { kind: 'success', code, state, matches_inat: true };
  }

  return { kind: 'other', matches_inat: true };
}

async function fetchUserProfile(accessToken) {
  const response = await fetch('https://api.inaturalist.org/v1/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Failed to fetch user profile: ${response.statusText}`);
  const data = await response.json();
  const user = data.results[0];
  return { id: user.id, login: user.login };
}

export async function completeInaturalistOAuthCallback(code, state) {
  const pendingState = await loadInatPendingState();
  if (!pendingState || pendingState.state !== state) {
    throw new Error('iNaturalist OAuth state mismatch. Please try again.');
  }

  const { codeVerifier } = pendingState;
  const isNative = isNativeApp();
  const clientId = isNative ? INAT_NATIVE_CLIENT_ID : INAT_WEB_CLIENT_ID;
  const redirectUri = isNative ? INAT_NATIVE_REDIRECT_URI : INAT_WEB_REDIRECT_URI;

  const tokenUrl = 'https://www.inaturalist.org/oauth/token';
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('code', code);
  params.append('code_verifier', codeVerifier);
  params.append('redirect_uri', redirectUri);
  params.append('grant_type', 'authorization_code');

  const response = await fetch(tokenUrl, { method: 'POST', body: params });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`iNaturalist token exchange failed: ${errorData.error_description || response.statusText}`);
  }

  const tokenData = await response.json();
  const { access_token, refresh_token, created_at, expires_in } = tokenData;
  const expiresAt = (created_at + expires_in) * 1000;
  const userProfile = await fetchUserProfile(access_token);

  await Promise.all([
    setInatItem(INAT_ACCESS_TOKEN_KEY, access_token),
    setInatItem(INAT_REFRESH_TOKEN_KEY, refresh_token),
    setInatItem(INAT_EXPIRES_AT_KEY, expiresAt),
    setInatItem(INAT_USER_ID_KEY, userProfile.id),
    setInatItem(INAT_USERNAME_KEY, userProfile.login),
    clearInatPendingState(),
  ]);

  return { connected: true, username: userProfile.login, userId: userProfile.id };
}

export async function forgetInaturalistSession() {
  await Promise.all([
    removeInatItem(INAT_ACCESS_TOKEN_KEY),
    removeInatItem(INAT_REFRESH_TOKEN_KEY),
    removeInatItem(INAT_EXPIRES_AT_KEY),
    removeInatItem(INAT_USER_ID_KEY),
    removeInatItem(INAT_USERNAME_KEY),
    clearInatPendingState(),
  ]);
}