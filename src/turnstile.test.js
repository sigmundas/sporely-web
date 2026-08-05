import test from 'node:test'
import assert from 'node:assert/strict'

const {
  acquireTurnstileToken,
  consumeTurnstileToken,
  resetTurnstile,
  cancelTurnstile,
  isTurnstileConfigured,
  setNativeBridge,
  _setNativeBridgeForTests,
  _setEnvForTests,
  _resetAllForTests,
  TurnstileConfigError,
  TurnstileChallengeError,
  TurnstileCancelledError,
} = await import('./turnstile.js')

function installBrowserDom({ platform = 'web', siteKey = '1x00000000000000000000AA' } = {}) {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const container = { id: 'ts-container' }
  const capacitorNative = platform === 'android' || platform === 'ios'
  const state = {
    lastRender: null,
    resets: 0,
    widgetSeq: 1,
  }

  globalThis.document = {
    querySelector(selector) {
      if (selector.startsWith('[data-turnstile=')) return container
      return null
    },
  }

  globalThis.window = {
    Capacitor: capacitorNative
      ? { isNativePlatform: () => true, getPlatform: () => platform }
      : undefined,
    turnstile: {
      render(target, config) {
        state.lastRender = { target, config }
        return state.widgetSeq++
      },
      reset(id) {
        state.resets++
        state.lastResetId = id
      },
      remove() {},
    },
  }

  _setEnvForTests({ prod: false, dev: true, siteKey })

  return {
    state,
    triggerSuccess(token = 'ts-token') {
      state.lastRender.config.callback(token)
    },
    triggerExpired() {
      state.lastRender.config['expired-callback']()
    },
    triggerError() {
      state.lastRender.config['error-callback']()
    },
    restore() {
      globalThis.window = previousWindow
      globalThis.document = previousDocument
      _setNativeBridgeForTests(null)
      _setEnvForTests(null)
      _resetAllForTests()
    },
  }
}

async function _tick() { await new Promise(r => setTimeout(r, 10)) }

test('acquire → consume returns the token exactly once', async () => {
  const h = installBrowserDom()
  try {
    const p = acquireTurnstileToken('signup')
    await _tick()
    h.triggerSuccess('token-abc')
    const token = await p
    assert.equal(token, 'token-abc')
    assert.equal(consumeTurnstileToken('signup'), 'token-abc')
    assert.throws(() => consumeTurnstileToken('signup'), /No Turnstile token/)
  } finally {
    h.restore()
  }
})

test('acquire waits for turnstile callback', async () => {
  const h = installBrowserDom()
  try {
    const p = acquireTurnstileToken('login')
    let resolvedWith = null
    p.then(t => { resolvedWith = t })
    await new Promise(r => setTimeout(r, 10))
    assert.equal(resolvedWith, null)
    h.triggerSuccess('later-token')
    assert.equal(await p, 'later-token')
  } finally {
    h.restore()
  }
})

test('expired callback rejects in-flight acquire', async () => {
  const h = installBrowserDom()
  try {
    const p = acquireTurnstileToken('signup')
    await _tick()
    h.triggerExpired()
    await assert.rejects(p, err => err instanceof TurnstileChallengeError && err.reason === 'expired')
  } finally {
    h.restore()
  }
})

test('error callback rejects in-flight acquire', async () => {
  const h = installBrowserDom()
  try {
    const p = acquireTurnstileToken('signup')
    await _tick()
    h.triggerError()
    await assert.rejects(p, err => err instanceof TurnstileChallengeError && err.reason === 'challenge_failed')
  } finally {
    h.restore()
  }
})

test('concurrent acquire for same action shares the pending promise', async () => {
  const h = installBrowserDom()
  try {
    const a = acquireTurnstileToken('signup')
    const b = acquireTurnstileToken('signup')
    assert.equal(a, b, 'the same promise must be returned to concurrent callers')
    await _tick()
    h.triggerSuccess('shared-token')
    assert.equal(await a, 'shared-token')
    assert.equal(await b, 'shared-token')
    // Only one consume succeeds.
    assert.equal(consumeTurnstileToken('signup'), 'shared-token')
    assert.throws(() => consumeTurnstileToken('signup'))
  } finally {
    h.restore()
  }
})

test('reset clears token before consume', async () => {
  const h = installBrowserDom()
  try {
    const p = acquireTurnstileToken('signup')
    await _tick()
    h.triggerSuccess('tok')
    await p
    resetTurnstile('signup')
    assert.throws(() => consumeTurnstileToken('signup'))
  } finally {
    h.restore()
  }
})

test('cancel rejects in-flight acquire', async () => {
  const h = installBrowserDom()
  try {
    const p = acquireTurnstileToken('signup')
    // Silence potential unhandled rejection during scheduling — attach a no-op handler.
    p.catch(() => {})
    cancelTurnstile('signup')
    await assert.rejects(p, err => err instanceof TurnstileCancelledError)
  } finally {
    h.restore()
  }
})

test('PROD + missing site key throws TurnstileConfigError', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = { turnstile: {}, Capacitor: undefined }
  globalThis.document = { querySelector: () => ({}) }
  _setEnvForTests({ prod: true, dev: false, siteKey: null })
  try {
    _resetAllForTests()
    assert.equal(isTurnstileConfigured(), false)
    await assert.rejects(
      acquireTurnstileToken('signup'),
      err => err instanceof TurnstileConfigError,
    )
  } finally {
    _setEnvForTests(null)
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    _resetAllForTests()
  }
})

test('DEV + missing site key uses Cloudflare test key', async () => {
  const h = installBrowserDom({ siteKey: '' })
  try {
    assert.equal(isTurnstileConfigured(), true)
    const p = acquireTurnstileToken('signup')
    await _tick()
    assert.equal(h.state.lastRender.config.sitekey, '1x00000000000000000000AA')
    h.triggerSuccess('t')
    await p
  } finally {
    h.restore()
  }
})

test('native path delegates to injected bridge', async () => {
  const h = installBrowserDom({ platform: 'android' })
  try {
    let calledWith = null
    _setNativeBridgeForTests(async (action) => {
      calledWith = action
      return { token: 'native-token' }
    })
    const token = await acquireTurnstileToken('login')
    assert.equal(token, 'native-token')
    assert.equal(calledWith, 'login')
    assert.equal(consumeTurnstileToken('login'), 'native-token')
  } finally {
    h.restore()
  }
})

test('setNativeBridge is exported for wiring', () => {
  const noop = async () => ({ token: '' })
  setNativeBridge(noop)
  setNativeBridge(null)
})

test('unknown action throws', () => {
  assert.throws(() => resetTurnstile('bogus'), /Unknown Turnstile action/)
})
