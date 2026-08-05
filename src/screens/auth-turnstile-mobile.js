// Android Turnstile bridge.
//
// Renders an iframe overlay pointing at https://app.sporely.no/auth/turnstile-mobile
// and awaits the token via a strict postMessage handshake:
//   1. Parent -> child: { type: 'sporely.turnstile.hello', nonce, action }
//      posted with targetOrigin 'https://app.sporely.no'.
//   2. Child -> parent: { type: 'sporely.turnstile.result', ... }
//      posted with targetOrigin equal to the parent's origin (captured from
//      the hello message), never '*'.
//
// The iframe uses sandbox="allow-scripts allow-same-origin". Dropping
// allow-same-origin would force the child into an opaque ('null') origin,
// making the parent's strict event.origin check unsatisfiable.

import {
  TurnstileCancelledError,
  TurnstileChallengeError,
} from '../turnstile.js'
import { t } from '../i18n.js'

const HELPER_ORIGIN = 'https://app.sporely.no'
// Load the built file explicitly. Cloudflare Pages' extensionless URL
// resolution can fall through to the SPA index.html for missing routes,
// which would frame the whole app instead of the helper and violate
// frame-ancestors on the main app CSP.
const HELPER_PATH = '/auth/turnstile-mobile.html'
const NONCE_BYTES = 16
// If no hello-ack / result arrives within this window, treat as a load
// failure. Android WebView surfaces net::ERR_BLOCKED_BY_RESPONSE and other
// network errors by rendering its own error page (which never posts back).
const LOAD_TIMEOUT_MS = 12_000

let _outstanding = null   // { nonce, action } or null

function _base64UrlEncode(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return globalThis.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function _generateNonce() {
  const bytes = new Uint8Array(NONCE_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  return _base64UrlEncode(bytes)
}

async function _loadCapacitorApp() {
  // Capacitor plugin proxies are themselves thenables — returning `App`
  // from an async function makes the promise machinery call `.then` on
  // it, producing "App.then() is not implemented on android". Wrap the
  // proxy so it is not accidentally unwrapped.
  const win = globalThis.window
  if (!win?.Capacitor?.Plugins?.App) return { app: null }
  try {
    const mod = await import('@capacitor/app')
    return { app: mod?.App || null }
  } catch (_) {
    return { app: null }
  }
}

function _createOverlay(doc, iframeSrc) {
  const overlay = doc.createElement('div')
  overlay.setAttribute('data-turnstile-mobile-overlay', '1')
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483646',
    'background:rgba(0,0,0,0.86)',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'padding:24px',
  ].join(';')

  const title = doc.createElement('div')
  title.textContent = t('auth.captchaConfirmTitle')
  title.style.cssText = 'color:#fff;font:600 16px/1.4 system-ui,sans-serif;margin-bottom:16px;text-align:center;'

  const iframe = doc.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  iframe.setAttribute('src', iframeSrc)
  iframe.setAttribute('title', 'Turnstile challenge')
  iframe.style.cssText = 'width:min(360px,100%);height:220px;border:0;border-radius:8px;background:#0d1109;'

  const errorMsg = doc.createElement('div')
  errorMsg.setAttribute('data-turnstile-mobile-error', '1')
  errorMsg.style.cssText = 'display:none;color:#f7c948;font:500 14px/1.4 system-ui,sans-serif;margin-top:16px;text-align:center;max-width:320px;'

  const cancelBtn = doc.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = t('common.cancel')
  cancelBtn.style.cssText = 'margin-top:20px;padding:10px 24px;border:0;border-radius:8px;background:#333;color:#fff;font:500 14px system-ui,sans-serif;'

  overlay.appendChild(title)
  overlay.appendChild(iframe)
  overlay.appendChild(errorMsg)
  overlay.appendChild(cancelBtn)
  return { overlay, iframe, errorMsg, cancelBtn }
}

export function acquireNativeTurnstileToken(action) {
  if (_outstanding) {
    return Promise.reject(new TurnstileChallengeError('busy', 'Another Turnstile challenge is already open'))
  }

  const nonce = _generateNonce()
  _outstanding = { nonce, action }

  const doc = globalThis.document
  const win = globalThis.window
  const iframeSrc = `${HELPER_ORIGIN}${HELPER_PATH}?action=${encodeURIComponent(action)}&nonce=${encodeURIComponent(nonce)}`
  const { overlay, iframe, errorMsg, cancelBtn } = _createOverlay(doc, iframeSrc)

  let backListenerHandle = null
  let messageHandler = null
  let iframeLoadHandler = null
  let cancelHandler = null
  let loadTimeout = null
  let settled = false
  let helloAcked = false

  const cleanup = () => {
    settled = true
    _outstanding = null
    if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null }
    if (messageHandler) win.removeEventListener('message', messageHandler)
    if (iframeLoadHandler) iframe.removeEventListener('load', iframeLoadHandler)
    if (cancelHandler) cancelBtn.removeEventListener('click', cancelHandler)
    if (backListenerHandle?.remove) {
      try { backListenerHandle.remove() } catch (_) { /* ignore */ }
    }
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  return new Promise((resolve, reject) => {
    const failLoad = (reason) => {
      if (settled) return
      // Show a user-visible message before tearing down so the user isn't
      // left staring at a blank overlay. The overlay is removed by
      // cleanup(); the promise rejection surfaces a matching error to the
      // auth form which re-enables submit.
      try {
        iframe.style.display = 'none'
        errorMsg.textContent = t('auth.captchaLoadFailed')
        errorMsg.style.display = 'block'
      } catch (_) { /* ignore */ }
      // Log a safe reason code only — never nonce, action payload, or token.
      try { console.warn(`turnstile-mobile: load_failed (${reason})`) } catch (_) { /* ignore */ }
      cleanup()
      reject(new TurnstileChallengeError('load_failed'))
    }

    messageHandler = event => {
      if (settled) return
      if (event.origin !== HELPER_ORIGIN) return
      if (event.source !== iframe.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.nonce !== nonce) return
      if (data.action !== action) return
      if (!_outstanding) return

      // Any well-formed message from the helper counts as proof it loaded.
      helloAcked = true

      if (data.type !== 'sporely.turnstile.result') return

      if (data.status === 'ok' && typeof data.token === 'string' && data.token) {
        cleanup()
        resolve({ token: data.token })
        return
      }
      if (data.status === 'cancel') {
        cleanup()
        reject(new TurnstileCancelledError())
        return
      }
      if (data.status === 'error') {
        const reason = typeof data.reason === 'string' ? data.reason : 'challenge_failed'
        cleanup()
        reject(new TurnstileChallengeError(reason))
        return
      }
    }

    iframeLoadHandler = () => {
      try {
        iframe.contentWindow?.postMessage(
          { type: 'sporely.turnstile.hello', nonce, action },
          HELPER_ORIGIN,
        )
      } catch (_) { /* ignore */ }
    }

    cancelHandler = () => {
      if (settled) return
      cleanup()
      reject(new TurnstileCancelledError())
    }

    win.addEventListener('message', messageHandler)
    iframe.addEventListener('load', iframeLoadHandler)
    cancelBtn.addEventListener('click', cancelHandler)
    doc.body.appendChild(overlay)

    // WebView error pages (net::ERR_BLOCKED_BY_RESPONSE etc.) do fire
    // `load` but never post back. Guard with a timeout — if no valid
    // message has been received by then, treat as load failure.
    loadTimeout = setTimeout(() => {
      if (!helloAcked) failLoad('timeout')
    }, LOAD_TIMEOUT_MS)

    // Async IIFE keeps the plugin proxy inside a scope; the outer
    // Promise never resolves to a thenable value.
    ;(async () => {
      try {
        const { app } = await _loadCapacitorApp()
        if (!app || settled) return
        // Capture into a local; wrap in Promise.resolve so we get a real
        // handle regardless of whether addListener returns a promise or a
        // synchronous handle. The result is stored in a plain-object slot;
        // we never expose the plugin proxy to the outer promise chain.
        const handle = await Promise.resolve(app.addListener('backButton', () => cancelHandler?.()))
        if (settled) {
          try { handle?.remove?.() } catch (_) { /* ignore */ }
          return
        }
        backListenerHandle = handle
      } catch (_) { /* ignore */ }
    })()
  })
}

export function _resetOutstandingForTests() {
  _outstanding = null
}

export const _internals = {
  HELPER_ORIGIN,
  HELPER_PATH,
  LOAD_TIMEOUT_MS,
}
