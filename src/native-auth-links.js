// Native Android App Link handling for Supabase auth callbacks.
//
// - Cold start:  App.getLaunchUrl()  — process the URL the app was launched
//                with, before ordinary auth boot.
// - Warm start:  App.addListener('appUrlOpen', ...) — process URLs that
//                arrive while the app is already running.
//
// Only https://app.sporely.no/auth/callback URLs are accepted. Everything
// else is ignored so unrelated deep links (e.g. share targets) never
// interact with the auth stack.
//
// The Capacitor App plugin proxy is a thenable — returning it from an async
// function makes the Promise machinery call App.then(), which errors on
// native. This module never resolves a promise with the App proxy; it
// wraps it in a plain object.

import { isNativeApp } from './platform.js'

const CALLBACK_HOST = 'app.sporely.no'
const CALLBACK_SCHEME = 'https:'
const CALLBACK_PATH = '/auth/callback'
const DEBUG_CALLBACK_SCHEME = 'com.sporelab.sporely.debug:'
const DEBUG_CALLBACK_HOST = 'auth'

let _listenerHandle = null
let _handledOnce = new Set()   // URL fingerprints already processed (dedup)

export function isSupabaseCallbackUrl(input) {
  try {
    const url = new URL(input)
    const production = url.protocol === CALLBACK_SCHEME
      && url.host === CALLBACK_HOST
      && url.pathname === CALLBACK_PATH
    const debug = url.protocol === DEBUG_CALLBACK_SCHEME
      && url.host === DEBUG_CALLBACK_HOST
      && (url.pathname === '' || url.pathname === '/')
    return production || debug
  } catch (_) {
    return false
  }
}

function _fingerprint(url) {
  // Deduplicate by (code, error) — the sensitive parts. We do NOT log the
  // fingerprint anywhere.
  try {
    const u = new URL(url)
    return `${u.pathname}|${u.searchParams.get('code') || ''}|${u.searchParams.get('error') || ''}`
  } catch (_) {
    return String(url)
  }
}

async function _loadCapacitorAppWrapped() {
  // See auth-turnstile-mobile.js for the same thenable-trap defense.
  if (!isNativeApp()) return { app: null }
  const win = globalThis.window
  if (!win?.Capacitor?.Plugins?.App) return { app: null }
  try {
    const mod = await import('@capacitor/app')
    return { app: mod?.App || null }
  } catch (_) {
    return { app: null }
  }
}

/**
 * Register the appUrlOpen listener exactly once, and process the cold-start
 * launch URL if one is present. Safe to call multiple times — subsequent
 * calls are no-ops.
 *
 * @param {(url: string) => Promise<unknown>} handleCallback  invoked with the
 *   incoming URL when it matches the callback allowlist. Return value ignored.
 */
export async function registerNativeAuthLinkListener(handleCallback) {
  if (!isNativeApp()) return { registered: false, coldStartUrl: null }
  if (_listenerHandle) return { registered: true, coldStartUrl: null }

  const { app } = await _loadCapacitorAppWrapped()
  if (!app) return { registered: false, coldStartUrl: null }

  // Cold-start URL, if any. `getLaunchUrl` returns { url } or null; wrap
  // the whole call so the proxy is never awaited raw.
  let coldStartUrl = null
  try {
    const launch = await Promise.resolve(app.getLaunchUrl())
    const url = launch?.url
    if (typeof url === 'string' && isSupabaseCallbackUrl(url)) {
      const fp = _fingerprint(url)
      if (!_handledOnce.has(fp)) {
        _handledOnce.add(fp)
        coldStartUrl = url
        try { await handleCallback(url) } catch (err) {
          try { console.warn('appUrlOpen cold-start handler failed:', err?.name || 'error') } catch (_) {}
        }
      }
    }
  } catch (_) { /* ignore */ }

  try {
    const handle = await Promise.resolve(app.addListener('appUrlOpen', async event => {
      const url = event?.url
      if (typeof url !== 'string') return
      if (!isSupabaseCallbackUrl(url)) return
      const fp = _fingerprint(url)
      if (_handledOnce.has(fp)) return
      _handledOnce.add(fp)
      try { await handleCallback(url) } catch (err) {
        try { console.warn('appUrlOpen handler failed:', err?.name || 'error') } catch (_) {}
      }
    }))
    _listenerHandle = handle || { remove() {} }
  } catch (_) { /* ignore */ }

  return { registered: !!_listenerHandle, coldStartUrl }
}

export function _resetNativeAuthLinkStateForTests() {
  _listenerHandle = null
  _handledOnce = new Set()
}
