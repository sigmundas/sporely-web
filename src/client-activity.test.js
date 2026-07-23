import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectClient,
  recordClientActivity,
  shouldRecordOnVisibility,
  __resetVisibilityThrottleForTests,
  __CLIENT_ACTIVITY_INTERNALS__,
} from './client-activity.js'

const { VISIBILITY_THROTTLE_MS } = __CLIENT_ACTIVITY_INTERNALS__

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  })
}

function installEnv({ native = false, platform = null, standalone = false, iosStandalone = false } = {}) {
  const originalWindow = globalThis.window
  const originalCapacitor = globalThis.Capacitor
  const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  const capacitor = {
    isNativePlatform: () => native,
    getPlatform: () => platform,
  }

  globalThis.window = {
    Capacitor: capacitor,
    matchMedia: query => ({
      matches: query === '(display-mode: standalone)' && standalone,
    }),
  }
  globalThis.Capacitor = capacitor
  setNavigator({ standalone: iosStandalone })

  return {
    restore() {
      globalThis.window = originalWindow
      globalThis.Capacitor = originalCapacitor
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        delete globalThis.navigator
      }
    },
  }
}

function makeSupabase(handler) {
  const calls = []
  return {
    calls,
    rpc: async (name, args) => {
      const call = { name, args }
      calls.push(call)
      if (typeof handler === 'function') return handler(call, calls)
      return { error: null }
    },
  }
}

test('detectClient: Capacitor Android → android_app', () => {
  const env = installEnv({ native: true, platform: 'android' })
  try { assert.equal(detectClient(), 'android_app') } finally { env.restore() }
})

test('detectClient: Capacitor iOS → ios_app (beats PWA display-mode)', () => {
  const env = installEnv({ native: true, platform: 'ios', standalone: true, iosStandalone: true })
  try { assert.equal(detectClient(), 'ios_app') } finally { env.restore() }
})

test('detectClient: web codebase never emits desktop_app — that value is reserved for the PySide6 sporely-py app', () => {
  // If Capacitor ever reported an "electron" platform in this codebase we
  // would still fall through to `unknown` — desktop_app must be produced
  // exclusively by sporely-py wiring.
  const env = installEnv({ native: true, platform: 'electron' })
  try { assert.equal(detectClient(), 'unknown') } finally { env.restore() }
})

test('detectClient: unrecognised native platform → unknown', () => {
  const env = installEnv({ native: true, platform: 'weird-os' })
  try { assert.equal(detectClient(), 'unknown') } finally { env.restore() }
})

test('detectClient: web with display-mode:standalone → web_pwa', () => {
  const env = installEnv({ native: false, standalone: true })
  try { assert.equal(detectClient(), 'web_pwa') } finally { env.restore() }
})

test('detectClient: iOS Safari add-to-home (navigator.standalone) → web_pwa', () => {
  const env = installEnv({ native: false, iosStandalone: true })
  try { assert.equal(detectClient(), 'web_pwa') } finally { env.restore() }
})

test('detectClient: regular browser → web_browser', () => {
  const env = installEnv({ native: false })
  try { assert.equal(detectClient(), 'web_browser') } finally { env.restore() }
})

test('detectClient: window missing → unknown', () => {
  const originalWindow = globalThis.window
  const originalCap = globalThis.Capacitor
  globalThis.window = undefined
  globalThis.Capacitor = undefined
  try { assert.equal(detectClient(), 'unknown') } finally {
    globalThis.window = originalWindow
    globalThis.Capacitor = originalCap
  }
})

test('recordClientActivity forwards detected client + version to the RPC', async () => {
  const env = installEnv({ native: true, platform: 'android' })
  try {
    const supabase = makeSupabase()
    const result = await recordClientActivity(supabase, { version: '0.6.11' })
    assert.equal(result.called, true)
    assert.equal(result.error, null)
    assert.equal(supabase.calls.length, 1)
    assert.equal(supabase.calls[0].name, 'record_client_activity')
    assert.deepEqual(supabase.calls[0].args, { p_client: 'android_app', p_app_version: '0.6.11' })
  } finally { env.restore() }
})

test('recordClientActivity: repeated same-day calls with identical args produce identical RPC payloads (server dedupes)', async () => {
  // The server upserts on (user, date, client, version) — the client just
  // keeps calling; this asserts we don't accidentally rotate values on repeat.
  const env = installEnv({ native: false })
  try {
    const supabase = makeSupabase()
    await recordClientActivity(supabase, { client: 'web_browser', version: '1.0.0' })
    await recordClientActivity(supabase, { client: 'web_browser', version: '1.0.0' })
    assert.equal(supabase.calls.length, 2)
    assert.deepEqual(supabase.calls[0].args, supabase.calls[1].args)
  } finally { env.restore() }
})

test('recordClientActivity: different clients same day → separate RPC calls with distinct client values', async () => {
  const env = installEnv({ native: false })
  try {
    const supabase = makeSupabase()
    await recordClientActivity(supabase, { client: 'web_browser', version: '1.0.0' })
    await recordClientActivity(supabase, { client: 'web_pwa', version: '1.0.0' })
    assert.equal(supabase.calls[0].args.p_client, 'web_browser')
    assert.equal(supabase.calls[1].args.p_client, 'web_pwa')
  } finally { env.restore() }
})

test('recordClientActivity: version change forwarded as separate RPC arg', async () => {
  const env = installEnv({ native: false })
  try {
    const supabase = makeSupabase()
    await recordClientActivity(supabase, { client: 'web_browser', version: '1.0.0' })
    await recordClientActivity(supabase, { client: 'web_browser', version: '1.0.1' })
    assert.equal(supabase.calls[0].args.p_app_version, '1.0.0')
    assert.equal(supabase.calls[1].args.p_app_version, '1.0.1')
  } finally { env.restore() }
})

test('recordClientActivity: coerces invalid client to unknown before sending', async () => {
  const env = installEnv({ native: false })
  try {
    const supabase = makeSupabase()
    await recordClientActivity(supabase, { client: 'not-real', version: null })
    assert.equal(supabase.calls[0].args.p_client, 'unknown')
    assert.equal(supabase.calls[0].args.p_app_version, null)
  } finally { env.restore() }
})

test('recordClientActivity: propagates RPC error without throwing', async () => {
  const env = installEnv({ native: false })
  try {
    const supabase = makeSupabase(() => ({ error: new Error('boom') }))
    const result = await recordClientActivity(supabase, { client: 'web_browser' })
    assert.equal(result.called, true)
    assert.ok(result.error)
  } finally { env.restore() }
})

test('recordClientActivity: no supabase.rpc → no-op', async () => {
  const result = await recordClientActivity({}, { client: 'web_browser' })
  assert.equal(result.called, false)
})

test('shouldRecordOnVisibility: first call fires, subsequent call within 15 min is throttled', () => {
  __resetVisibilityThrottleForTests()
  const t0 = 1_000_000_000
  assert.equal(shouldRecordOnVisibility(t0), true)
  assert.equal(shouldRecordOnVisibility(t0 + 60_000), false)
  assert.equal(shouldRecordOnVisibility(t0 + VISIBILITY_THROTTLE_MS - 1), false)
})

test('shouldRecordOnVisibility: fires again once the throttle window elapses', () => {
  __resetVisibilityThrottleForTests()
  const t0 = 1_000_000_000
  assert.equal(shouldRecordOnVisibility(t0), true)
  assert.equal(shouldRecordOnVisibility(t0 + VISIBILITY_THROTTLE_MS), true)
  // The second successful call resets the window.
  assert.equal(shouldRecordOnVisibility(t0 + VISIBILITY_THROTTLE_MS + 60_000), false)
})

test('shouldRecordOnVisibility: throttle window is roughly 15 minutes', () => {
  assert.equal(VISIBILITY_THROTTLE_MS, 15 * 60 * 1000)
})
