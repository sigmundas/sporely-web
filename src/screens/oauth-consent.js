// OAuth 2.1 consent screen for the first-party Sporely Desktop public client.
//
// Flow:
//   1. Read and validate authorization_id from the URL.
//   2. Check for an active browser session; redirect to the main login UI if absent.
//   3. Fetch authorization details and verify the client is the first-party desktop app.
//   4. Show "Sporely Desktop wants to connect" consent UI.
//   5. Approve → navigate to the redirect_url returned by Supabase.
//   6. Deny  → navigate to the redirect_url returned by Supabase.
//
// Security invariants:
//   - No session token, auth code, or PKCE material is logged or placed in the DOM.
//   - Redirect destinations are validated to use http: or https: only.
//   - error/textContent only — no innerHTML on user-visible error elements.
//   - The pending consent sessionStorage entry holds only the opaque authorization_id
//     (no tokens), is consumed immediately on first use, and carries a TTL.

import {
  isValidOAuthAuthorizationId,
  storePendingOAuthConsent,
} from '../oauth-consent-return.js'

const DESKTOP_CLIENT_ID = 'b141fed6-e257-4de1-b784-3a28c777dadf'

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _showLoading(doc) {
  const loading = doc.getElementById('consent-loading')
  const error   = doc.getElementById('consent-error')
  const ui      = doc.getElementById('consent-ui')
  if (loading) loading.style.display = 'block'
  if (error)   error.style.display   = 'none'
  if (ui)      ui.style.display      = 'none'
}

function _showError(doc, message) {
  const loading = doc.getElementById('consent-loading')
  const error   = doc.getElementById('consent-error')
  const ui      = doc.getElementById('consent-ui')
  if (loading) loading.style.display = 'none'
  if (ui)      ui.style.display      = 'none'
  if (error) {
    error.style.display = 'block'
    error.textContent   = message  // textContent only — no XSS risk
  }
}

function _showConsent(doc, { userEmail, clientName }) {
  const loading    = doc.getElementById('consent-loading')
  const error      = doc.getElementById('consent-error')
  const ui         = doc.getElementById('consent-ui')
  const emailEl    = doc.getElementById('consent-user-email')
  const nameEl     = doc.getElementById('consent-client-name')
  if (loading)  loading.style.display  = 'none'
  if (error)    error.style.display    = 'none'
  if (ui)       ui.style.display       = 'block'
  if (emailEl)  emailEl.textContent    = userEmail  || ''
  if (nameEl)   nameEl.textContent     = clientName || 'Sporely Desktop'
}

// ── Redirect helper ───────────────────────────────────────────────────────────

function _isSafeRedirectUrl(urlStr) {
  try {
    const url = new URL(urlStr)
    if (url.protocol === 'https:') return true
    // For plain http, only allow loopback (the desktop OAuth callback).
    // Supabase enforces the registered redirect_uri server-side; this is
    // defence-in-depth against a corrupted or unexpected server response.
    if (url.protocol === 'http:') {
      const h = url.hostname
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    return false
  } catch (_) {
    return false
  }
}

function _navigateTo(win, redirectUrl) {
  if (!_isSafeRedirectUrl(redirectUrl)) return false
  win.location.href = redirectUrl
  return true
}

// ── Error classification ──────────────────────────────────────────────────────

function _isMissingOrExpiredAuthError(error) {
  const status = Number(error?.status || 0)
  // 404 = not found, 410 = gone/expired
  return status === 404 || status === 410
}

// ── Main consent init ─────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {object} options.supabase         - Supabase client
 * @param {Document} [options.document]     - defaults to globalThis.document
 * @param {Window}   [options.window]       - defaults to globalThis.window
 * @param {string}   [options.loginReturnTarget] - URL to redirect to for login (defaults to origin root)
 */
export async function initOAuthConsent({
  supabase,
  document: doc    = globalThis.document,
  window:   win    = globalThis.window,
  loginReturnTarget = null,
} = {}) {
  _showLoading(doc)

  // 1. Read and validate authorization_id
  const params          = new URLSearchParams(win?.location?.search || '')
  const authorizationId = params.get('authorization_id') || ''

  if (!authorizationId) {
    _showError(doc, 'Missing authorization_id parameter.')
    return { status: 'invalid_param', error: 'missing' }
  }
  if (!isValidOAuthAuthorizationId(authorizationId)) {
    _showError(doc, 'Invalid authorization_id format.')
    return { status: 'invalid_param', error: 'format' }
  }

  // 2. Check session
  let session = null
  try {
    const { data, error: sessionError } = await supabase.auth.getSession()
    if (!sessionError) session = data?.session || null
  } catch (_) {
    session = null
  }

  if (!session) {
    storePendingOAuthConsent(authorizationId)
    const target = loginReturnTarget || (win?.location?.origin ? `${win.location.origin}/` : '/')
    win.location.href = target
    return { status: 'redirect_to_login', authorizationId }
  }

  // 3. Fetch authorization details (requires active session)
  let authDetails = null
  let detailsError = null
  try {
    const result = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
    authDetails  = result.data  || null
    detailsError = result.error || null
  } catch (err) {
    detailsError = err
  }

  if (detailsError) {
    const msg = _isMissingOrExpiredAuthError(detailsError)
      ? 'The authorization request has expired or is invalid. Please sign in again from Sporely Desktop.'
      : 'Could not load the authorization request. Please try again.'
    _showError(doc, msg)
    return { status: 'details_error', error: detailsError }
  }

  if (!authDetails) {
    _showError(doc, 'The authorization request has expired or is invalid. Please sign in again from Sporely Desktop.')
    return { status: 'not_found' }
  }

  // 4. An already-consented request returns only its redirect URL.
  if ('redirect_url' in authDetails) {
    if (!_navigateTo(win, authDetails.redirect_url)) {
      _showError(doc, 'Invalid redirect destination.')
      return { status: 'invalid_redirect' }
    }
    return { status: 'already_consented' }
  }

  // 5. Validate this is the first-party desktop client.
  if (authDetails.client?.id !== DESKTOP_CLIENT_ID) {
    _showError(doc, 'Unauthorized OAuth client.')
    return { status: 'unauthorized_client' }
  }

  // 6. Render consent UI
  const userEmail  = session.user?.email || ''
  const clientName = authDetails.client?.name || 'Sporely Desktop'
  _showConsent(doc, { userEmail, clientName })

  // 7. Wire up buttons
  const approveBtn = doc.getElementById('consent-approve')
  const denyBtn    = doc.getElementById('consent-deny')

  function _disableButtons() {
    if (approveBtn) approveBtn.disabled = true
    if (denyBtn)    denyBtn.disabled    = true
  }

  async function _handleApprove() {
    _disableButtons()
    let approveData = null
    let approveError = null
    try {
      const result = await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
      approveData  = result.data  || null
      approveError = result.error || null
    } catch (err) {
      approveError = err
    }
    if (approveError) {
      _showError(doc, 'Authorization failed. Please try signing in again from Sporely Desktop.')
      return { status: 'approve_error', error: approveError }
    }
    const redirectUrl = approveData?.redirect_url
    if (!redirectUrl) {
      _showError(doc, 'Authorization failed. Please try signing in again from Sporely Desktop.')
      return { status: 'no_redirect_url' }
    }
    if (!_navigateTo(win, redirectUrl)) {
      _showError(doc, 'Invalid redirect destination.')
      return { status: 'invalid_redirect' }
    }
    return { status: 'approved', redirectUrl }
  }

  async function _handleDeny() {
    _disableButtons()
    let denyData = null
    let denyError = null
    try {
      const result = await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
      denyData  = result.data  || null
      denyError = result.error || null
    } catch (err) {
      denyError = err
    }
    if (denyError) {
      _showError(doc, 'Could not cancel authorization. Please try again.')
      return { status: 'deny_error', error: denyError }
    }
    const redirectUrl = denyData?.redirect_url
    if (!redirectUrl) {
      _showError(doc, 'Authorization cancelled.')
      return { status: 'denied_no_redirect' }
    }
    if (!_navigateTo(win, redirectUrl)) {
      _showError(doc, 'Authorization cancelled.')
      return { status: 'denied_invalid_redirect' }
    }
    return { status: 'denied', redirectUrl }
  }

  if (approveBtn) approveBtn.addEventListener('click', () => { void _handleApprove() })
  if (denyBtn)    denyBtn.addEventListener('click',    () => { void _handleDeny() })

  return { status: 'ready', authorizationId, userEmail, clientName }
}
