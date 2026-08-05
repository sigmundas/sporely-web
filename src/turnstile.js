// Cloudflare Turnstile token manager.
//
// Single point of control for CAPTCHA tokens used with Supabase Auth.
// - Never logs tokens.
// - Never stores tokens outside module memory.
// - One token per action, consumed exactly once.
// - Fails closed in production when misconfigured.
// - Delegates to an injected bridge on native platforms (Android iframe overlay).

import { isNativeApp } from './platform.js'

const TURNSTILE_DEV_TEST_KEY = '1x00000000000000000000AA'
const TURNSTILE_TOKEN_TTL_MS = 250_000
const TURNSTILE_LOAD_TIMEOUT_MS = 10_000
const VALID_ACTIONS = new Set(['signup', 'login', 'password_reset'])

export class TurnstileConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TurnstileConfigError'
    this.code = 'TURNSTILE_CONFIG'
  }
}

export class TurnstileChallengeError extends Error {
  constructor(reason, message) {
    super(message || `Turnstile challenge ${reason}`)
    this.name = 'TurnstileChallengeError'
    this.reason = reason
  }
}

export class TurnstileCancelledError extends Error {
  constructor() {
    super('Turnstile challenge cancelled')
    this.name = 'TurnstileCancelledError'
    this.reason = 'cancel'
  }
}

let _envOverride = null

export function _setEnvForTests(env) { _envOverride = env }

function _envMode() {
  if (_envOverride) return _envOverride
  try {
    return {
      prod: !!import.meta.env?.PROD,
      dev: !!import.meta.env?.DEV,
      siteKey: import.meta.env?.VITE_TURNSTILE_SITE_KEY || null,
    }
  } catch (_) {
    return { prod: false, dev: true, siteKey: null }
  }
}

function _resolveSiteKey() {
  const { prod, siteKey } = _envMode()
  if (siteKey) return siteKey
  if (prod) return null
  return TURNSTILE_DEV_TEST_KEY
}

export function isTurnstileConfigured() {
  return !!_resolveSiteKey()
}

const _state = new Map()
let _nativeBridge = null

export function _setNativeBridgeForTests(bridge) { _nativeBridge = bridge }
export function setNativeBridge(bridge) { _nativeBridge = bridge }

function _ensureAction(action) {
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Unknown Turnstile action: ${action}`)
  }
}

function _entry(action) {
  let e = _state.get(action)
  if (!e) {
    e = { widgetId: null, token: null, expiresAt: 0, inFlight: null, resolveToken: null, rejectToken: null }
    _state.set(action, e)
  }
  return e
}

function _turnstile() { return globalThis.window?.turnstile || null }

async function _waitForTurnstileScript(timeoutMs = TURNSTILE_LOAD_TIMEOUT_MS) {
  const start = Date.now()
  while (!_turnstile()) {
    if (Date.now() - start > timeoutMs) return null
    await new Promise(r => setTimeout(r, 50))
  }
  return _turnstile()
}

function _containerFor(action) {
  const doc = globalThis.document
  if (!doc?.querySelector) return null
  return doc.querySelector(`[data-turnstile="${action}"]`)
}

function _renderWidget(action, container, siteKey) {
  const ts = _turnstile()
  if (!ts) throw new TurnstileConfigError('Turnstile script not loaded')
  const entry = _entry(action)
  entry.widgetId = ts.render(container, {
    sitekey: siteKey,
    theme: 'dark',
    action,
    callback: token => _resolveChallenge(action, token),
    'expired-callback': () => _failChallenge(action, 'expired'),
    'error-callback':   () => _failChallenge(action, 'challenge_failed'),
    'timeout-callback': () => _failChallenge(action, 'timeout'),
  })
}

function _resolveChallenge(action, token) {
  const entry = _entry(action)
  entry.token = token
  entry.expiresAt = Date.now() + TURNSTILE_TOKEN_TTL_MS
  const resolve = entry.resolveToken
  entry.resolveToken = null
  entry.rejectToken = null
  entry.inFlight = null
  resolve?.(token)
}

function _failChallenge(action, reason) {
  const entry = _entry(action)
  entry.token = null
  entry.expiresAt = 0
  const reject = entry.rejectToken
  entry.resolveToken = null
  entry.rejectToken = null
  entry.inFlight = null
  reject?.(new TurnstileChallengeError(reason))
}

export function acquireTurnstileToken(action, { signal } = {}) {
  _ensureAction(action)
  const entry = _entry(action)

  if (entry.token && entry.expiresAt > Date.now()) {
    return Promise.resolve(entry.token)
  }
  if (entry.inFlight) return entry.inFlight

  const siteKey = _resolveSiteKey()
  const { prod } = _envMode()
  if (!siteKey) {
    return Promise.reject(new TurnstileConfigError(
      prod
        ? 'Turnstile site key is not configured. Contact support.'
        : 'VITE_TURNSTILE_SITE_KEY is not set; refusing to proceed.'
    ))
  }

  // Create the outer promise synchronously so concurrent callers share it.
  const promise = new Promise((resolve, reject) => {
    entry.resolveToken = resolve
    entry.rejectToken = reject
  })
  entry.inFlight = promise

  if (signal) {
    if (signal.aborted) {
      _rejectPending(action, new TurnstileCancelledError())
      return promise
    }
    signal.addEventListener('abort', () => {
      _rejectPending(action, new TurnstileCancelledError())
    }, { once: true })
  }

  if (isNativeApp()) {
    if (!_nativeBridge) {
      _rejectPending(action, new TurnstileConfigError('Native Turnstile bridge is not registered'))
      return promise
    }
    Promise.resolve()
      .then(() => _nativeBridge(action, { siteKey, signal }))
      .then(result => {
        const token = result?.token
        if (!token) throw new TurnstileChallengeError('challenge_failed')
        _resolveChallenge(action, token)
      })
      .catch(err => _rejectPending(action, err))
    return promise
  }

  ;(async () => {
    const ts = await _waitForTurnstileScript()
    if (!ts) {
      _rejectPending(action, new TurnstileConfigError('Turnstile script failed to load'))
      return
    }
    const container = _containerFor(action)
    if (!container) {
      _rejectPending(action, new TurnstileConfigError(`No Turnstile container for action "${action}"`))
      return
    }
    try {
      if (entry.widgetId === null) {
        _renderWidget(action, container, siteKey)
      } else {
        ts.reset(entry.widgetId)
      }
    } catch (error) {
      _rejectPending(action, error)
    }
  })()

  return promise
}

function _rejectPending(action, error) {
  const entry = _entry(action)
  const reject = entry.rejectToken
  entry.resolveToken = null
  entry.rejectToken = null
  entry.inFlight = null
  reject?.(error)
}

export function consumeTurnstileToken(action) {
  _ensureAction(action)
  const entry = _entry(action)
  const token = entry.token
  if (!token) {
    throw new TurnstileChallengeError('missing', 'No Turnstile token available to consume')
  }
  if (entry.expiresAt <= Date.now()) {
    _resetInternal(action)
    throw new TurnstileChallengeError('expired', 'Turnstile token has expired')
  }
  _resetInternal(action)
  return token
}

function _resetInternal(action) {
  const entry = _entry(action)
  entry.token = null
  entry.expiresAt = 0
  const ts = _turnstile()
  if (ts && entry.widgetId !== null) {
    try { ts.reset(entry.widgetId) } catch (_) { /* ignore */ }
  }
}

export function resetTurnstile(action) {
  _ensureAction(action)
  _resetInternal(action)
}

export function cancelTurnstile(action) {
  _ensureAction(action)
  _rejectPending(action, new TurnstileCancelledError())
  _resetInternal(action)
}

export function _resetAllForTests() {
  _state.clear()
}
