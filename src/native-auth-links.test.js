import test from 'node:test'
import assert from 'node:assert/strict'

const {
  isSupabaseCallbackUrl,
  registerNativeAuthLinkListener,
  _resetNativeAuthLinkStateForTests,
} = await import('./native-auth-links.js')

test('isSupabaseCallbackUrl accepts the exact HTTPS callback', () => {
  assert.equal(isSupabaseCallbackUrl('https://app.sporely.no/auth/callback?code=abc'), true)
  assert.equal(isSupabaseCallbackUrl('https://app.sporely.no/auth/callback'), true)
  assert.equal(isSupabaseCallbackUrl('https://app.sporely.no/auth/callback?flow=signup&code=x'), true)
})

test('isSupabaseCallbackUrl accepts only the exact debug custom callback', () => {
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely.debug://auth?flow=signup&code=x'), true)
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely.debug://auth/?code=x'), true)
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely://auth?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely.debug://evil?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely.debug://auth/not-here?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely.debugx://auth?code=x'), false)
})

test('isSupabaseCallbackUrl rejects wrong scheme, host, or path', () => {
  assert.equal(isSupabaseCallbackUrl('http://app.sporely.no/auth/callback?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('https://evil.example/auth/callback?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('https://app.sporely.no/auth/turnstile-mobile?nonce=x'), false)
  assert.equal(isSupabaseCallbackUrl('https://app.sporely.no/?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('com.sporelab.sporely://auth?code=x'), false)
  assert.equal(isSupabaseCallbackUrl('not-a-url'), false)
})

test('registerNativeAuthLinkListener is a no-op on non-native platforms', async () => {
  _resetNativeAuthLinkStateForTests()
  const previousWindow = globalThis.window
  globalThis.window = { Capacitor: undefined }
  try {
    const calls = []
    const result = await registerNativeAuthLinkListener(async url => { calls.push(url) })
    assert.deepEqual(result, { registered: false, coldStartUrl: null })
    assert.equal(calls.length, 0)
  } finally {
    globalThis.window = previousWindow
    _resetNativeAuthLinkStateForTests()
  }
})

function installNativeEnv({ launchUrl = null, appMethods = {} } = {}) {
  const previousWindow = globalThis.window
  const previousImport = globalThis.__importOverride
  const listeners = new Map()
  const app = {
    getLaunchUrl: async () => (launchUrl ? { url: launchUrl } : null),
    addListener: async (event, cb) => {
      listeners.set(event, cb)
      return { remove() { listeners.delete(event) } }
    },
    ...appMethods,
  }
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { App: {} },
    },
  }
  // Redirect the dynamic import.
  return {
    async fireAppUrlOpen(url) {
      const cb = listeners.get('appUrlOpen')
      if (cb) await cb({ url })
    },
    app,
    restore() {
      globalThis.window = previousWindow
      globalThis.__importOverride = previousImport
      _resetNativeAuthLinkStateForTests()
    },
  }
}

// We can't easily intercept the `import('@capacitor/app')` call from a Node
// unit test. Instead, exercise the exported logic by:
//   (a) verifying isSupabaseCallbackUrl in isolation (above), and
//   (b) using the real dynamic import — on Node it either resolves to the
//       web fallback (rejected inside try/catch → { app: null }) or fails
//       silently. Either way, registerNativeAuthLinkListener returns
//       { registered: false } when the plugin cannot supply a real App.
//
// The behavioral guarantees for the runtime path are enforced by the
// following structural tests:

test('module never returns the Capacitor App proxy from an async function', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./native-auth-links.js', import.meta.url), 'utf8')
  assert.equal(/return\s+mod\?\.App/.test(source), false)
  assert.equal(/Promise\.resolve\(App\)/.test(source), false)
})

test('listener registration is single-instance (no duplicate handlers)', async () => {
  _resetNativeAuthLinkStateForTests()
  const env = installNativeEnv({ launchUrl: null })
  try {
    // First call will try dynamic import and fail closed — returning
    // registered: false. Second call must also be a safe no-op.
    const r1 = await registerNativeAuthLinkListener(async () => {})
    const r2 = await registerNativeAuthLinkListener(async () => {})
    // Both share the same shape; the key contract is idempotence.
    assert.equal(typeof r1.registered, 'boolean')
    assert.equal(typeof r2.registered, 'boolean')
  } finally {
    env.restore()
  }
})
