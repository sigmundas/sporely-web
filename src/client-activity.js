import { getPlatform, isNativeApp } from './platform.js'

const ALLOWED_CLIENTS = new Set([
  'android_app',
  'ios_app',
  'web_pwa',
  'web_browser',
  // `desktop_app` is emitted by the PySide6 desktop app (sporely-py); this
  // web codebase never returns it. Kept in the allow-list so the shared RPC
  // schema and profile CHECK constraint stay in sync across clients.
  'desktop_app',
  'unknown',
])

const VISIBILITY_THROTTLE_MS = 15 * 60 * 1000
let _lastVisibilityRecordAt = 0

export function __resetVisibilityThrottleForTests() {
  _lastVisibilityRecordAt = 0
}

// Returns true if a visibility-triggered call should be issued now. Boot and
// SIGNED_IN callers bypass this — they call recordClientActivity directly.
export function shouldRecordOnVisibility(now = Date.now()) {
  if (now - _lastVisibilityRecordAt >= VISIBILITY_THROTTLE_MS) {
    _lastVisibilityRecordAt = now
    return true
  }
  return false
}

export function detectClient() {
  // Capacitor native detection MUST run first. An iOS Capacitor build still
  // has window.matchMedia and would otherwise be misclassified as web_pwa.
  //
  // Note: the Sporely desktop app is PySide6 (sporely-py), NOT an Electron /
  // Capacitor-electron build, so this web detector never returns
  // 'desktop_app'. Desktop activity is recorded by sporely-py calling the
  // record_client_activity RPC directly with client='desktop_app'.
  if (isNativeApp()) {
    const platform = getPlatform()
    if (platform === 'android') return 'android_app'
    if (platform === 'ios') return 'ios_app'
    return 'unknown'
  }

  try {
    const win = globalThis.window
    if (!win) return 'unknown'
    const isStandalone = !!win.matchMedia?.('(display-mode: standalone)')?.matches
    const iosStandalone = globalThis.navigator?.standalone === true
    if (isStandalone || iosStandalone) return 'web_pwa'
    return 'web_browser'
  } catch (_) {
    return 'unknown'
  }
}

export function getAppVersion() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __APP_VERSION__ !== 'undefined') return String(__APP_VERSION__)
  } catch (_) { /* fall through */ }
  const fromGlobal = globalThis.__APP_VERSION__
  return typeof fromGlobal === 'string' && fromGlobal ? fromGlobal : null
}

// Idempotent across a UTC day — the server upserts by (user, date, client,
// version) and only advances last_seen_at. Safe to call on SIGNED_IN, on boot
// with an existing session, and on visibilitychange → visible.
export async function recordClientActivity(supabase, {
  client = detectClient(),
  version = getAppVersion(),
} = {}) {
  if (!supabase?.rpc) return { called: false, error: null }
  const safeClient = ALLOWED_CLIENTS.has(client) ? client : 'unknown'
  try {
    const { error } = await supabase.rpc('record_client_activity', {
      p_client: safeClient,
      p_app_version: version || null,
    })
    return { called: true, error: error || null, client: safeClient, version: version || null }
  } catch (error) {
    return { called: true, error, client: safeClient, version: version || null }
  }
}

export const __CLIENT_ACTIVITY_INTERNALS__ = { ALLOWED_CLIENTS, VISIBILITY_THROTTLE_MS }
