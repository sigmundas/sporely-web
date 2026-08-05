// Hosted Turnstile challenge page for the Capacitor Android app.
//
// The parent (Capacitor WebView) embeds this page as a cross-origin iframe.
// Handshake:
//   1. Parent posts { type: 'sporely.turnstile.hello', nonce, action }
//      with targetOrigin 'https://app.sporely.no'. We validate the parent's
//      origin against a small allowlist of Capacitor origins.
//   2. We render Turnstile and post the result back to the parent's origin
//      captured from that hello — never '*'.
//
// Contains no Supabase or Cloudflare secret. Site key is baked in by Vite
// at build time; production build fails if VITE_TURNSTILE_SITE_KEY is
// missing (see vite.config.js).

const VALID_ACTIONS = new Set(['signup', 'login', 'password_reset'])
const PARENT_ORIGIN_ALLOWLIST = new Set([
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
])
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/

const params = new URLSearchParams(location.search)
const action = params.get('action')
const nonce = params.get('nonce')
const statusEl = document.getElementById('status')

const siteKey =
  (import.meta.env && import.meta.env.VITE_TURNSTILE_SITE_KEY) ||
  ((import.meta.env && !import.meta.env.PROD) ? '1x00000000000000000000AA' : '')

function _setStatus(text) {
  statusEl.textContent = text
}

function _isValidAction(a) {
  return typeof a === 'string' && VALID_ACTIONS.has(a)
}

function _isValidNonce(n) {
  return typeof n === 'string' && NONCE_RE.test(n)
}

if (!_isValidAction(action) || !_isValidNonce(nonce)) {
  _setStatus('Invalid challenge parameters.')
  throw new Error('turnstile-mobile: invalid params')
}

if (!siteKey) {
  _setStatus('CAPTCHA not configured.')
  throw new Error('turnstile-mobile: missing site key')
}

let parentWindow = null
let parentOrigin = null

function _send(result) {
  if (!parentWindow || !parentOrigin) return
  try {
    parentWindow.postMessage(
      { type: 'sporely.turnstile.result', nonce, action, ...result },
      parentOrigin,
    )
  } catch (_) {
    // no fallback — refusing to broadcast to '*'
  }
}

function _renderWidget() {
  if (!globalThis.turnstile) {
    // Retry until the async script loads.
    setTimeout(_renderWidget, 50)
    return
  }
  _setStatus('')
  globalThis.turnstile.render('#widget', {
    sitekey: siteKey,
    action,
    theme: 'dark',
    callback: token => _send({ status: 'ok', token }),
    'expired-callback': () => _send({ status: 'error', reason: 'expired' }),
    'error-callback':   () => _send({ status: 'error', reason: 'challenge_failed' }),
    'timeout-callback': () => _send({ status: 'error', reason: 'timeout' }),
  })
}

const helloTimeout = setTimeout(() => {
  if (!parentWindow) {
    _setStatus('No parent handshake received.')
  }
}, 5000)

window.addEventListener('message', event => {
  if (parentWindow) return // ignore further hellos
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type !== 'sporely.turnstile.hello') return
  if (data.nonce !== nonce) return
  if (data.action !== action) return
  if (event.source !== window.parent) return
  if (!PARENT_ORIGIN_ALLOWLIST.has(event.origin)) return

  clearTimeout(helloTimeout)
  parentWindow = event.source
  parentOrigin = event.origin
  _renderWidget()
})

_setStatus('Waiting for app…')
