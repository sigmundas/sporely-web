// Native device-connectivity monitor (@capacitor/network).
//
// Purpose: on Capacitor builds the WebView's `online` event is not a
// reliable reconnect signal (device QA: airplane-mode off was not noticed).
// This module surfaces the OS connectivity change as a WAKE-UP SIGNAL only:
//
//   * `networkStatusChange` with connected false→true, and
//   * a `Network.getStatus()` check when the app returns to the foreground
//     (covers a reconnect that happened while backgrounded, where the
//     change event was missed).
//
// INVARIANTS (Stage B):
//   * `connected === true` is NEVER treated as AUTHENTICATED_COMPLETE or as
//     backend reachability — the caller's revalidation path still runs the
//     Supabase reachability probe and the full session/profile pipeline,
//     and uploads stay gated on canPerformCloudMutation().
//   * `connected === false` arms the next false→true edge AND (QA round 2)
//     notifies the optional onConnectivityLost callback so a stale
//     AUTHENTICATED_COMPLETE can downgrade promptly. This module itself
//     never signs out, never clears sessions/caches, never touches queued
//     work — the downgrade policy lives entirely in the caller (main.js).
//   * Web/PWA builds never load the plugin — the existing `online` /
//     `visibilitychange` / `focus` fallbacks remain the browser mechanism.
//   * All signals converge on ONE caller-provided callback which is
//     expected to dedupe (main.js: requestConnectivityRevalidation()).
//
// The Capacitor plugin proxy is a thenable — never resolve a promise with
// the raw proxy (see native-auth-links.js for the same defense).

import { isNativeApp } from './platform.js'

export const NATIVE_NETWORK_REASON = Object.freeze({
  NETWORK_CHANGE: 'native-network-change',
  RESUME_STATUS: 'native-resume-status',
})

export const NATIVE_NETWORK_LOSS_REASON = Object.freeze({
  NETWORK_CHANGE: 'native-network-change-lost',
  RESUME_STATUS: 'native-resume-status-lost',
})

let _bound = false
let _listenerHandles = []
let _removeDomListeners = []
let _lastConnected = null
let _boundNetworkPlugin = null
let _boundNotify = null
let _boundNotifyLost = null

// Dev-only connectivity tracing for Android logcat / WebView console (QA
// round 3 live-reconnect instrumentation). No tokens/URLs are ever logged.
function _netLog(message) {
  try { console.info(`[network] ${message}`) } catch (_) { /* no console */ }
}

async function _loadNetworkPluginWrapped() {
  try {
    const mod = await import('@capacitor/network')
    return { network: mod?.Network || null }
  } catch (_) {
    return { network: null }
  }
}

async function _loadAppPluginWrapped() {
  try {
    const mod = await import('@capacitor/app')
    return { app: mod?.App || null }
  } catch (_) {
    return { app: null }
  }
}

function _safeNotify(notify, reason) {
  try { notify(reason) } catch (err) {
    try { console.warn('native-network notify failed:', err?.name || 'error') } catch (_) {}
  }
}

// Foreground/resume check: the device may have reconnected while the app was
// backgrounded and the change event never reached the WebView. getStatus()
// is a local OS query (no network I/O). `connected === true` only wakes the
// deduped revalidation — it proves nothing about Supabase reachability.
async function _checkStatusAndNotify(network, notify, notifyLost) {
  let status
  try {
    status = await Promise.resolve(network.getStatus())
  } catch (_) {
    return null
  }
  const connected = status?.connected === true
  _lastConnected = connected
  _netLog(`watchdog getStatus connected=${connected}`)
  if (connected) {
    _safeNotify(notify, NATIVE_NETWORK_REASON.RESUME_STATUS)
  } else if (typeof notifyLost === 'function') {
    // Foreground/resume with the device reporting NO connectivity: surface
    // the loss so a stale AUTHENTICATED_COMPLETE can downgrade without
    // waiting for a request to fail (QA: airplane mode while COMPLETE).
    _safeNotify(notifyLost, NATIVE_NETWORK_LOSS_REASON.RESUME_STATUS)
  }
  return connected
}

// On-demand OS connectivity check (QA round 3): the cached-mode watchdog
// polls this (~5s) because on some Android devices/WebViews the
// `networkStatusChange` event is simply never delivered while the app is
// foregrounded (observed: airplane-off left the app in CACHED until a
// process restart). This is a LOCAL native status query — zero network I/O —
// and it funnels through the exact same notify callbacks as the event path,
// so downstream dedupe/throttle still applies. Returns the boolean status,
// or null when the monitor is not bound / the plugin query failed.
export async function checkNativeConnectivityNow() {
  if (!_bound || !_boundNetworkPlugin || !_boundNotify) return null
  return _checkStatusAndNotify(_boundNetworkPlugin, _boundNotify, _boundNotifyLost)
}

/**
 * Bind the native connectivity monitor exactly once. No-op on web builds.
 *
 * @param {object} options
 * @param {(reason: string) => void} options.onConnectivityRestored —
 *   invoked with a NATIVE_NETWORK_REASON when the device reports
 *   connectivity. MUST be idempotent/deduped by the caller.
 * @param {(reason: string) => void} [options.onConnectivityLost] —
 *   invoked with a NATIVE_NETWORK_LOSS_REASON on the true→false edge or a
 *   `getStatus().connected === false` resume check. The caller decides
 *   whether/how to downgrade auth state; this module NEVER signs out,
 *   clears sessions/caches or touches queued work.
 * @param {object} [options.network]  — injected Network plugin (tests).
 * @param {object} [options.app]      — injected App plugin (tests).
 * @param {boolean} [options.native]  — injected platform flag (tests).
 * @param {Document} [options.documentRef] — injected document (tests).
 * @returns {{ bound: boolean, reason: string }}
 */
export async function bindNativeNetworkMonitor({
  onConnectivityRestored,
  onConnectivityLost = null,
  network = null,
  app = null,
  native = isNativeApp(),
  documentRef = (typeof document !== 'undefined' ? document : null),
} = {}) {
  if (typeof onConnectivityRestored !== 'function') return { bound: false, reason: 'no-callback' }
  if (!native) return { bound: false, reason: 'web-platform' }
  if (_bound) return { bound: true, reason: 'already-bound' }
  _bound = true

  const networkPlugin = network || (await _loadNetworkPluginWrapped()).network
  if (!networkPlugin) {
    _bound = false
    return { bound: false, reason: 'plugin-unavailable' }
  }
  const notify = onConnectivityRestored
  const notifyLost = typeof onConnectivityLost === 'function' ? onConnectivityLost : null
  _boundNetworkPlugin = networkPlugin
  _boundNotify = notify
  _boundNotifyLost = notifyLost

  // 1. Device-connectivity change events. QA round 3: these are WAKE-UPS,
  //    not edge-dependent events. `connected === true` ALWAYS notifies the
  //    restore callback — even when `_lastConnected` was already true or
  //    null (a preceding false event may have been lost, or the WebView was
  //    paused across the transition). Deduplication belongs downstream:
  //    every wake-up converges on the single `_cachedRevalidationInFlight`
  //    guard (and the backend-attempt throttle) in main.js, so redundant
  //    notifications are harmless. `connected === false` likewise always
  //    notifies the loss callback, which self-guards on auth state.
  try {
    const handle = await Promise.resolve(networkPlugin.addListener('networkStatusChange', status => {
      const connected = status?.connected === true
      _lastConnected = connected
      _netLog(`status-change connected=${connected}`)
      if (!connected) {
        if (notifyLost) _safeNotify(notifyLost, NATIVE_NETWORK_LOSS_REASON.NETWORK_CHANGE)
        return
      }
      _safeNotify(notify, NATIVE_NETWORK_REASON.NETWORK_CHANGE)
    }))
    if (handle) _listenerHandles.push(handle)
  } catch (err) {
    try { console.warn('networkStatusChange listener failed:', err?.name || 'error') } catch (_) {}
  }

  // 2. Seed the last-known state so a later false→true edge is detected.
  //    Deliberately does NOT notify — boot/reveal paths already probed.
  try {
    const status = await Promise.resolve(networkPlugin.getStatus())
    if (typeof status?.connected === 'boolean') _lastConnected = status.connected
  } catch (_) { /* stay null — first change event seeds it */ }

  // 3. Resume checks: both the WebView visibility signal and the Capacitor
  //    App resume event funnel into the same getStatus() check — on some
  //    Android WebViews only one of the two fires reliably. The upstream
  //    dedupe collapses double-fires into one revalidation.
  if (documentRef?.addEventListener) {
    const onVisibility = () => {
      if (documentRef.visibilityState !== 'visible') return
      void _checkStatusAndNotify(networkPlugin, notify, notifyLost)
    }
    documentRef.addEventListener('visibilitychange', onVisibility)
    _removeDomListeners.push(() => {
      try { documentRef.removeEventListener('visibilitychange', onVisibility) } catch (_) {}
    })
  }
  const appPlugin = app || (await _loadAppPluginWrapped()).app
  if (appPlugin?.addListener) {
    try {
      const handle = await Promise.resolve(appPlugin.addListener('resume', () => {
        void _checkStatusAndNotify(networkPlugin, notify, notifyLost)
      }))
      if (handle) _listenerHandles.push(handle)
    } catch (err) {
      try { console.warn('app resume listener failed:', err?.name || 'error') } catch (_) {}
    }
  }

  return { bound: true, reason: 'bound' }
}

// Cleanup — removes plugin listeners and DOM listeners. Used on pagehide
// (app teardown) and by tests. Safe to call when never bound.
export async function unbindNativeNetworkMonitor() {
  const handles = _listenerHandles
  const domRemovers = _removeDomListeners
  _listenerHandles = []
  _removeDomListeners = []
  _bound = false
  _lastConnected = null
  _boundNetworkPlugin = null
  _boundNotify = null
  _boundNotifyLost = null
  for (const handle of handles) {
    try { await Promise.resolve(handle?.remove?.()) } catch (_) { /* ignore */ }
  }
  for (const remove of domRemovers) {
    try { remove() } catch (_) { /* ignore */ }
  }
}

// Test-only introspection.
export function _nativeNetworkMonitorStateForTests() {
  return { bound: _bound, lastConnected: _lastConnected, handleCount: _listenerHandles.length }
}
