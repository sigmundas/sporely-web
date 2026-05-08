import { supabase } from '../supabase.js'
import { getLocale, setLocale, t } from '../i18n.js'
import { isNativeApp } from '../platform.js'

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '0x4AAAAAAC0h9RON_lYu5ib_'
let _captchaToken      = null
let _turnstileWidgetId = null

function _isLocalTestingHost(hostname = window.location.hostname) {
  if (!hostname) return false

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local')
  ) {
    return true
  }

  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false
  const [a, b] = hostname.split('.').map(Number)

  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  )
}

const BYPASS_TURNSTILE = isNativeApp() || (import.meta.env.DEV && _isLocalTestingHost())
const PASSWORD_RESET_WEB_ORIGIN = 'https://app.sporely.no'
const PERSIST_AUTH_DRAFTS = import.meta.env.DEV
const AUTH_DRAFT_KEY = 'sporely-auth-draft'
const PASSWORD_RECOVERY_HINT_KEY = 'sporely-password-recovery-hint'
const PASSWORD_RECOVERY_HINT_TTL_MS = 1000 * 60 * 60

async function _initTurnstile() {
  if (BYPASS_TURNSTILE) return
  // Don't render a second widget if one already exists
  if (_turnstileWidgetId !== null) return

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

async function _withTimeout(promise, timeoutMs, label) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timeoutId)
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

export function showAuthError(msg, allowHtml = false, info = false) {
  showError(msg, allowHtml, info)
}

function _setPasswordRecoveryHint(email = '') {
  try {
    localStorage.setItem(PASSWORD_RECOVERY_HINT_KEY, JSON.stringify({
      email,
      createdAt: Date.now(),
    }))
  } catch {}
}

export function hasPasswordRecoveryHint() {
  try {
    const raw = localStorage.getItem(PASSWORD_RECOVERY_HINT_KEY)
    if (!raw) return false

    const parsed = JSON.parse(raw)
    const createdAt = Number(parsed?.createdAt || 0)
    if (!createdAt || (Date.now() - createdAt) > PASSWORD_RECOVERY_HINT_TTL_MS) {
      localStorage.removeItem(PASSWORD_RECOVERY_HINT_KEY)
      return false
    }

    return true
  } catch {
    return false
  }
}

export function clearPasswordRecoveryHint() {
  try {
    localStorage.removeItem(PASSWORD_RECOVERY_HINT_KEY)
  } catch {}
}

function _getInitialAuthParams() {
  const params = new URLSearchParams(window.location.search)
  const hash = (window.__INITIAL_HASH__ || window.location.hash).replace(/^#/, '')

  if (!hash) return params

  const hashParams = new URLSearchParams(hash)
  hashParams.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value)
  })

  return params
}

export function getInitialAuthState() {
  const params = _getInitialAuthParams()
  const pathname = window.location.pathname || ''
  const isError = params.has('error') || params.has('error_code')
  const isRecovery = !isError && (
    pathname.includes('reset-password') ||
    params.get('flow') === 'recovery' ||
    params.get('screen') === 'reset-password' ||
    params.get('type') === 'recovery' ||
    (params.has('access_token') && params.get('type') === 'recovery') ||
    (params.has('code') && (
      pathname.includes('reset-password') ||
      params.get('type') === 'recovery' ||
      params.get('flow') === 'recovery' ||
      params.get('screen') === 'reset-password'
    ))
  )

  return { params, pathname, isError, isRecovery }
}

function _readAuthDraft() {
  if (!PERSIST_AUTH_DRAFTS) return {}
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_DRAFT_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function _writeAuthDraft(patch) {
  if (!PERSIST_AUTH_DRAFTS) return
  const next = { ..._readAuthDraft(), ...patch }
  sessionStorage.setItem(AUTH_DRAFT_KEY, JSON.stringify(next))
}

function _clearAuthDraft() {
  if (!PERSIST_AUTH_DRAFTS) return
  sessionStorage.removeItem(AUTH_DRAFT_KEY)
}

function _restoreAuthDraft() {
  const draft = _readAuthDraft()
  if (draft.mode === 'signup') {
    switchToSignup(draft.signupEmail || '')
  } else {
    switchToLogin(draft.loginEmail || '')
  }

  if (typeof draft.loginEmail === 'string') {
    document.getElementById('login-email').value = draft.loginEmail
  }
  if (typeof draft.loginPassword === 'string') {
    document.getElementById('login-password').value = draft.loginPassword
  }
  if (typeof draft.signupEmail === 'string') {
    document.getElementById('signup-email').value = draft.signupEmail
  }
  if (typeof draft.signupPassword === 'string') {
    document.getElementById('signup-password').value = draft.signupPassword
  }
}

function _persistAuthInputs() {
  if (!PERSIST_AUTH_DRAFTS) return

  const sync = () => {
    _writeAuthDraft({
      mode: document.getElementById('signup-form').style.display === 'none' ? 'login' : 'signup',
      loginEmail: document.getElementById('login-email').value,
      loginPassword: document.getElementById('login-password').value,
      signupEmail: document.getElementById('signup-email').value,
      signupPassword: document.getElementById('signup-password').value,
    })
  }

  ;['login-email', 'login-password', 'signup-email', 'signup-password'].forEach(id => {
    document.getElementById(id).addEventListener('input', sync)
  })

  sync()
}

function _captchaErrorMessage(message) {
  const text = String(message || '')
  const lower = text.toLowerCase()

  if (BYPASS_TURNSTILE && (lower.includes('captcha') || lower.includes('turnstile') || lower.includes('challenge'))) {
    return t('auth.localCaptchaHint')
  }

  return text
}

function setLoading(btn, loading) {
  btn.disabled    = loading
  btn.textContent = loading ? t('common.pleaseWait') : btn.dataset.label
}

function _validatePasswordRequirements(password) {
  const value = String(password || '')
  if (value.length < 8) {
    return t('auth.passwordMin')
  }
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return t('auth.passwordRequirements')
  }
  return ''
}

function _getPasswordResetRedirectUrl() {
  const origin = window.location.origin
  const hostname = window.location.hostname

  if (isNativeApp()) {
    return `${PASSWORD_RESET_WEB_ORIGIN}/?flow=recovery&screen=reset-password`
  }

  const isExactViteLocalhost =
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') &&
    window.location.port === '5173'

  const resetOrigin = isExactViteLocalhost ? origin : PASSWORD_RESET_WEB_ORIGIN
  return `${resetOrigin}/?flow=recovery&screen=reset-password`
}

async function _waitForSession(maxAttempts = 5, delayMs = 150) {
  for (let i = 0; i < maxAttempts; i++) {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user) return session
    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return null
}

export function switchToLogin(prefillEmail = '', resetMessage = false) {
  showError('')
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('forgot-password-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'none'
  document.getElementById('login-form').style.display  = 'block'
  // Hide Turnstile on the login view — captcha is signup-only
  const tc = document.getElementById('turnstile-container')
  if (tc) tc.style.display = 'none'
  if (prefillEmail) document.getElementById('login-email').value = prefillEmail
  _writeAuthDraft({ mode: 'login', loginEmail: prefillEmail || document.getElementById('login-email').value })
  if (resetMessage) {
    showError(t('auth.passwordUpdated'), false, true)
  }
}

function switchToSignup(prefillEmail = '') {
  showError('')
  document.getElementById('login-form').style.display  = 'none'
  document.getElementById('forgot-password-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'none'
  document.getElementById('signup-form').style.display = 'block'
  // Show and init Turnstile when entering signup view
  const tc = document.getElementById('turnstile-container')
  if (tc) tc.style.display = 'flex'
  _initTurnstile()
  if (prefillEmail) document.getElementById('signup-email').value = prefillEmail
  _writeAuthDraft({ mode: 'signup', signupEmail: prefillEmail || document.getElementById('signup-email').value })
}

export function switchToForgotPassword(prefillEmail = '') {
  showError('')
  document.getElementById('login-form').style.display = 'none'
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'none'
  document.getElementById('forgot-password-form').style.display = 'block'
  const tc = document.getElementById('turnstile-container')
  if (tc) tc.style.display = 'none'
  if (prefillEmail) document.getElementById('forgot-email').value = prefillEmail
}

export function switchToResetPassword() {
  showError('')
  document.getElementById('login-form').style.display = 'none'
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('forgot-password-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'block'
  const tc = document.getElementById('turnstile-container')
  if (tc) tc.style.display = 'none'
  document.getElementById('new-password').value = ''
  document.getElementById('confirm-new-password').value = ''
}

// ── Resend confirmation ────────────────────────────────────────────────────────

function showResendPrompt(email) {
  _pendingEmail = email
  showError(
    `${t('auth.checkInbox')} ` +
    `<a href="#" id="resend-link" style="color:var(--green-accent);font-weight:600;text-decoration:none">` +
    `${t('auth.resendEmail')}</a>`,
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
      showError(t('auth.emailAlreadyConfirmed'))
    } else {
      showError(t('auth.couldNotResend', { message: error.message }))
    }
  } else {
    showError(t('auth.confirmationSent'))
  }
}

// ── URL hash error (e.g. expired OTP link) ────────────────────────────────────

function friendlyHashError(code, description) {
  if (code === 'otp_expired') {
    return t('auth.confirmationExpired')
  }
  if (code === 'access_denied') {
    return description || t('auth.accessDenied')
  }
  return description || t('auth.genericError')
}

export function handleUrlHashError() {
  const { params } = getInitialAuthState()
  const values = Object.fromEntries(params)
  if (!values.error) return false

  // Clean auth params from the URL so they don't persist on reload
  history.replaceState(null, '', window.location.pathname)

  const msg    = friendlyHashError(values.error_code, values.error_description)
  const email  = values.email || ''

  // Show the auth overlay with the error and a resend link if appropriate
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('app-shell').style.display    = 'none'

  if (values.error_code === 'otp_expired') {
    // Switch to signup view so user can re-enter email
    switchToSignup(email)
    showError(msg)
  } else {
    switchToLogin(email)
    showError(msg)
  }
  
  return true
}

// ── Main auth init ────────────────────────────────────────────────────────────

export function initAuth(onAuthenticated, skipDraftRestore = false) {
  const loginForm  = document.getElementById('login-form')
  const signupForm = document.getElementById('signup-form')
  const forgotForm = document.getElementById('forgot-password-form')
  const resetForm  = document.getElementById('reset-password-form')
  const loginBtn   = document.getElementById('login-btn')
  const signupBtn  = document.getElementById('signup-btn')
  const forgotBtn  = document.getElementById('forgot-btn')
  const resetBtn   = document.getElementById('reset-password-btn')
  const languageSelect = document.getElementById('auth-language-select')

  loginBtn.dataset.label  = t('auth.signIn')
  signupBtn.dataset.label = t('auth.createAccount')
  forgotBtn.dataset.label = t('auth.sendResetLink')
  resetBtn.dataset.label  = t('auth.updatePassword')
  if (languageSelect) {
    languageSelect.value = getLocale()
    languageSelect.addEventListener('change', () => {
      setLocale(languageSelect.value)
    })
  }

  if (!skipDraftRestore) {
    _restoreAuthDraft()
  }
  _persistAuthInputs()
  // Turnstile is initialised lazily when the user switches to the signup view

  document.getElementById('show-signup').addEventListener('click', e => {
    e.preventDefault()
    switchToSignup()
  })

  document.getElementById('show-login').addEventListener('click', e => {
    e.preventDefault()
    switchToLogin()
  })

  document.getElementById('show-forgot-password')?.addEventListener('click', e => {
    e.preventDefault()
    switchToForgotPassword(document.getElementById('login-email').value)
  })

  document.getElementById('show-login-from-forgot')?.addEventListener('click', e => {
    e.preventDefault()
    switchToLogin()
  })

  document.getElementById('show-login-from-reset')?.addEventListener('click', async e => {
    e.preventDefault()
    clearPasswordRecoveryHint()
    history.replaceState(null, '', '/')
    switchToLogin()
    await supabase.auth.signOut().catch(error => {
      console.warn('Sign-out while leaving password reset did not finish cleanly:', error)
    })
  })

  // ── Login ──────────────────────────────────────────────────────────────────
  loginForm.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const email    = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value

    try {
      setLoading(loginBtn, true)
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })

      if (!error) {
        const session = data?.session || await _waitForSession()
        if (session?.user) {
          _clearAuthDraft()
          onAuthenticated(session)
          return
        }
        showError(t('common.errorPrefix', { message: 'Sign-in succeeded but no session was available yet. Please try again.' }))
        return
      }

      // "Email not confirmed" — offer resend
      if (error.message.toLowerCase().includes('not confirmed')) {
        showResendPrompt(email)
      } else {
        showError(_captchaErrorMessage(error.message))
      }
    } catch (error) {
      console.error('Sign-in failed unexpectedly:', error)
      showError(_captchaErrorMessage(error?.message || String(error)))
    } finally {
      setLoading(loginBtn, false)
    }
  })

  // ── Signup ─────────────────────────────────────────────────────────────────
  signupForm.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const email    = document.getElementById('signup-email').value.trim()
    const password = document.getElementById('signup-password').value

    const passwordValidationMessage = _validatePasswordRequirements(password)
    if (passwordValidationMessage) {
      showError(passwordValidationMessage)
      return
    }

    try {
      setLoading(signupBtn, true)
      const signUpPayload = { email, password }
      if (!BYPASS_TURNSTILE) {
        signUpPayload.options = { captchaToken: _captchaToken }
      }
      const { data, error } = await supabase.auth.signUp(signUpPayload)
      _resetTurnstile()

      if (error) {
        // "User already registered" — send them to login instead
        if (
          error.message.toLowerCase().includes('already registered') ||
          error.message.toLowerCase().includes('already been registered')
        ) {
          switchToLogin(email)
          showError(t('auth.existingAccount'))
        } else {
          showError(_captchaErrorMessage(error.message))
        }
        return
      }

      // Supabase returns success even for already-registered addresses (security).
      // Check whether we actually got a session.
      const session = await _waitForSession()
      if (session?.user) {
        _clearAuthDraft()
        onAuthenticated(session)
        return
      }

      // No session → email confirmation required
      // data.user being null means address was already registered (and unconfirmed).
      // data.user being present means fresh signup.
      switchToLogin(email)
      showResendPrompt(email)
    } catch (error) {
      console.error('Sign-up failed unexpectedly:', error)
      showError(_captchaErrorMessage(error?.message || String(error)))
    } finally {
      setLoading(signupBtn, false)
    }
  })

  // ── Forgot Password ────────────────────────────────────────────────────────
  forgotForm?.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const email = document.getElementById('forgot-email').value.trim()
    
    try {
      setLoading(forgotBtn, true)

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: _getPasswordResetRedirectUrl()
      })
      
      if (error) {
        showError(_captchaErrorMessage(error.message))
      } else {
        _setPasswordRecoveryHint(email)
        showError(t('auth.resetEmailSent'), false, true)
      }
    } catch (error) {
      console.error('Reset-password email failed unexpectedly:', error)
      showError(error?.message || String(error))
    } finally {
      setLoading(forgotBtn, false)
    }
  })

  // ── Reset Password ─────────────────────────────────────────────────────────
  resetForm?.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const newPassword = document.getElementById('new-password').value.trim()
    const confirmNewPassword = document.getElementById('confirm-new-password').value.trim()

    if (newPassword !== confirmNewPassword) {
      showError(t('auth.passwordsDontMatch'))
      return
    }
    const passwordValidationMessage = _validatePasswordRequirements(newPassword)
    if (passwordValidationMessage) {
      showError(passwordValidationMessage)
      return
    }
    try {
      setLoading(resetBtn, true)
      const { error } = await _withTimeout(
        supabase.auth.updateUser({ password: newPassword }),
        15000,
        'Password update is taking longer than expected. Please try again.'
      )
      
      if (error) {
        showError(error.message)
      } else {
        clearPasswordRecoveryHint()
        switchToLogin('', true)
        await _withTimeout(
          supabase.auth.signOut(),
          5000,
          'Sign-out is taking longer than expected.'
        ).catch(error => {
          console.warn('Sign-out after password reset did not finish cleanly:', error)
        })
        history.replaceState(null, '', '/')
      }
    } catch (error) {
      console.error('Password update failed unexpectedly:', error)
      showError(error?.message || String(error))
    } finally {
      setLoading(resetBtn, false)
    }
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
