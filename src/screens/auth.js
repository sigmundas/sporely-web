import { supabase } from '../supabase.js'

const TURNSTILE_SITE_KEY = '0x4AAAAAAC0h9RON_lYu5ib_'
let _captchaToken      = null
let _turnstileWidgetId = null

async function _initTurnstile() {
  for (let i = 0; i < 100; i++) {
    if (window.turnstile) break
    await new Promise(r => setTimeout(r, 50))
  }
  if (!window.turnstile) return
  _turnstileWidgetId = window.turnstile.render('#turnstile-container', {
    sitekey:            TURNSTILE_SITE_KEY,
    theme:              'dark',
    callback:           token  => { _captchaToken = token },
    'expired-callback': ()     => { _captchaToken = null },
    'error-callback':   ()     => { _captchaToken = null },
  })
}

function _resetTurnstile() {
  _captchaToken = null
  if (window.turnstile && _turnstileWidgetId !== null) {
    window.turnstile.reset(_turnstileWidgetId)
  }
}

// Email waiting for confirmation (needed for resend)
let _pendingEmail = null

// ── DOM helpers ───────────────────────────────────────────────────────────────

function showError(msg, allowHtml = false, info = false) {
  const el = document.getElementById('auth-error')
  el.classList.toggle('info', info)
  if (allowHtml) {
    el.innerHTML = msg
  } else {
    el.textContent = msg
  }
  el.style.display = msg ? 'block' : 'none'
}

function setLoading(btn, loading) {
  btn.disabled    = loading
  btn.textContent = loading ? 'Please wait…' : btn.dataset.label
}

function switchToLogin(prefillEmail = '') {
  showError('')
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('login-form').style.display  = 'block'
  if (prefillEmail) document.getElementById('login-email').value = prefillEmail
}

function switchToSignup(prefillEmail = '') {
  showError('')
  document.getElementById('login-form').style.display  = 'none'
  document.getElementById('signup-form').style.display = 'block'
  if (prefillEmail) document.getElementById('signup-email').value = prefillEmail
}

// ── Resend confirmation ────────────────────────────────────────────────────────

function showResendPrompt(email) {
  _pendingEmail = email
  showError(
    `Check your inbox to confirm your account. ` +
    `<a href="#" id="resend-link" style="color:var(--green-accent);font-weight:600;text-decoration:none">` +
    `Resend email</a>`,
    /*allowHtml*/ true,
    /*info*/ true
  )
  document.getElementById('resend-link')?.addEventListener('click', async e => {
    e.preventDefault()
    await doResend(email)
  })
}

async function doResend(email) {
  const { error } = await supabase.auth.resend({ type: 'signup', email })
  if (error) {
    // "already confirmed" means they can just sign in
    if (error.message.toLowerCase().includes('already confirmed')) {
      showError('Your email is already confirmed — try signing in.')
    } else {
      showError(`Could not resend: ${error.message}`)
    }
  } else {
    showError('Confirmation email sent — check your inbox.')
  }
}

// ── URL hash error (e.g. expired OTP link) ────────────────────────────────────

function friendlyHashError(code, description) {
  if (code === 'otp_expired') {
    return 'Your confirmation link has expired. Enter your email below and request a new one.'
  }
  if (code === 'access_denied') {
    return description || 'Access denied. Please try again.'
  }
  return description || 'Something went wrong. Please try again.'
}

export function handleUrlHashError() {
  const hash = window.location.hash.slice(1) // strip leading #
  if (!hash) return

  const params = Object.fromEntries(new URLSearchParams(hash))
  if (!params.error) return

  // Clean the hash from the URL so it doesn't persist on reload
  history.replaceState(null, '', window.location.pathname + window.location.search)

  const msg    = friendlyHashError(params.error_code, params.error_description)
  const email  = params.email || ''

  // Show the auth overlay with the error and a resend link if appropriate
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('app-shell').style.display    = 'none'

  if (params.error_code === 'otp_expired') {
    // Switch to signup view so user can re-enter email
    switchToSignup(email)
    showError(msg)
  } else {
    showError(msg)
  }
}

// ── Main auth init ────────────────────────────────────────────────────────────

export function initAuth(onAuthenticated) {
  const loginForm  = document.getElementById('login-form')
  const signupForm = document.getElementById('signup-form')
  const loginBtn   = document.getElementById('login-btn')
  const signupBtn  = document.getElementById('signup-btn')

  loginBtn.dataset.label  = 'Sign in'
  signupBtn.dataset.label = 'Create account'

  _initTurnstile()

  document.getElementById('show-signup').addEventListener('click', e => {
    e.preventDefault()
    switchToSignup()
  })

  document.getElementById('show-login').addEventListener('click', e => {
    e.preventDefault()
    switchToLogin()
  })

  // ── Login ──────────────────────────────────────────────────────────────────
  loginForm.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const email    = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value

    setLoading(loginBtn, true)
    const { error } = await supabase.auth.signInWithPassword({
      email, password,
      options: { captchaToken: _captchaToken },
    })
    setLoading(loginBtn, false)
    _resetTurnstile()

    if (!error) {
      onAuthenticated()
      return
    }

    // "Email not confirmed" — offer resend
    if (error.message.toLowerCase().includes('not confirmed')) {
      showResendPrompt(email)
    } else {
      showError(error.message)
    }
  })

  // ── Signup ─────────────────────────────────────────────────────────────────
  signupForm.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const email    = document.getElementById('signup-email').value.trim()
    const password = document.getElementById('signup-password').value

    setLoading(signupBtn, true)
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { captchaToken: _captchaToken },
    })
    setLoading(signupBtn, false)
    _resetTurnstile()

    if (error) {
      // "User already registered" — send them to login instead
      if (
        error.message.toLowerCase().includes('already registered') ||
        error.message.toLowerCase().includes('already been registered')
      ) {
        switchToLogin(email)
        showError('An account with that email already exists. Sign in, or use "Forgot password" to reset it.')
      } else {
        showError(error.message)
      }
      return
    }

    // Supabase returns success even for already-registered addresses (security).
    // Check whether we actually got a session.
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      onAuthenticated()
      return
    }

    // No session → email confirmation required
    // data.user being null means address was already registered (and unconfirmed).
    // data.user being present means fresh signup.
    switchToLogin(email)
    showResendPrompt(email)
  })
}

// ── Overlay helpers ───────────────────────────────────────────────────────────

export function showAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('app-shell').style.display    = 'none'
}

export function hideAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'none'
  document.getElementById('app-shell').style.display    = 'block'
}
