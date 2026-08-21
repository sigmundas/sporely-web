import { supabase } from '../supabase.js'
import { getSharedAuthSession, seedSharedAuthSession } from '../auth-session.js'
import { performExplicitSignOut } from '../auth-signout.js'
import { getLocale, setLocale, t } from '../i18n.js'
import { isAndroidApp, isNativeApp } from '../platform.js'
import {
  GoogleSignInCancelledError,
  GoogleSignInConfigError,
  GoogleSignInMissingTokenError,
  isGoogleNativeConfigured,
  isNativeGoogleSignInAvailable,
  signInWithGoogleNative,
} from '../google-auth.js'
import {
  acquireTurnstileToken,
  consumeTurnstileToken,
  resetTurnstile,
  setNativeBridge,
  TurnstileCancelledError,
  TurnstileChallengeError,
  TurnstileConfigError,
} from '../turnstile.js'
import { acquireNativeTurnstileToken } from './auth-turnstile-mobile.js'

setNativeBridge(acquireNativeTurnstileToken)

const SUPABASE_OAUTH_CALLBACK_PATH = '/auth/callback'
const SUPABASE_OAUTH_FALLBACK_ORIGIN = 'https://app.sporely.no'
const SUPABASE_EMAIL_CONFIRM_REDIRECT = 'https://app.sporely.no/auth/callback?flow=signup'
const PASSWORD_RESET_WEB_ORIGIN = 'https://app.sporely.no'

export function getSignupEmailRedirectUrl() {
  return SUPABASE_EMAIL_CONFIRM_REDIRECT
}
const PERSIST_AUTH_DRAFTS = !!import.meta.env?.DEV
const AUTH_DRAFT_KEY = 'sporely-auth-draft'
const PASSWORD_RECOVERY_HINT_KEY = 'sporely-password-recovery-hint'
const PASSWORD_RECOVERY_HINT_TTL_MS = 1000 * 60 * 60

async function _obtainCaptchaToken(action) {
  await acquireTurnstileToken(action)
  return consumeTurnstileToken(action)
}

function _handleCaptchaError(action, error) {
  resetTurnstile(action)
  if (error instanceof TurnstileCancelledError) {
    return t('auth.captchaCancelled')
  }
  if (error instanceof TurnstileConfigError) {
    return error.message || t('auth.captchaConfig')
  }
  if (error instanceof TurnstileChallengeError) {
    return t('auth.captchaFailed')
  }
  return null
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

function _replaceAuthCallbackUrl(path = '/') {
  if (!globalThis.history?.replaceState) return
  try {
    history.replaceState(history.state, '', path)
  } catch (error) {
    console.warn('Failed to clean auth callback URL:', error)
  }
}

function _cleanString(value) {
  return String(value || '').trim()
}

function _friendlySupabaseOAuthError(errorCode, errorDescription) {
  const code = String(errorCode || '').trim().toLowerCase()
  if (code === 'access_denied') {
    return errorDescription || t('auth.accessDenied')
  }
  return errorDescription || t('auth.genericError')
}

function _setSocialLoginVisibility(visible) {
  const section = document.getElementById('auth-social-login')
  if (section) section.style.display = visible ? 'flex' : 'none'
}

function _shouldShowSocialLogin() {
  return !isNativeApp() || isAndroidApp()
}

export function getSupabaseOAuthRedirectUrl(origin = globalThis.location?.origin || SUPABASE_OAUTH_FALLBACK_ORIGIN) {
  return new URL(SUPABASE_OAUTH_CALLBACK_PATH, `${origin}`).toString()
}

export async function maybeHandleSupabaseOAuthCallback(input, options = {}) {
  const locationHref = globalThis.location?.href || `${SUPABASE_OAUTH_FALLBACK_ORIGIN}/`
  const url = new URL(input, locationHref)
  if (url.pathname !== SUPABASE_OAUTH_CALLBACK_PATH) {
    return { handled: false, scrubUrl: false, status: 'ignored' }
  }

  const code = _cleanString(url.searchParams.get('code'))
  const error = _cleanString(url.searchParams.get('error'))
  const errorDescription = _cleanString(url.searchParams.get('error_description'))

  if (!code && !error && !errorDescription) {
    return { handled: false, scrubUrl: false, status: 'ignored' }
  }

  const scrubUrl = () => _replaceAuthCallbackUrl('/')

  if (error || errorDescription) {
    const errorMessage = _friendlySupabaseOAuthError(error, errorDescription)
    scrubUrl()
    return {
      handled: true,
      scrubUrl: true,
      status: 'error',
      error: new Error(errorMessage),
      errorMessage,
    }
  }

  const authClient = options.supabaseClient || supabase

  try {
    const { data, error: exchangeError } = await authClient.auth.exchangeCodeForSession(code)
    scrubUrl()

    if (exchangeError) {
      return {
        handled: true,
        scrubUrl: true,
        status: 'error',
        error: exchangeError,
        errorMessage: exchangeError.message || t('auth.genericError'),
      }
    }

    const session = data?.session || null
    if (session) {
      seedSharedAuthSession(session)
    }

    return {
      handled: true,
      scrubUrl: true,
      status: 'success',
      session,
    }
  } catch (error) {
    scrubUrl()
    return {
      handled: true,
      scrubUrl: true,
      status: 'error',
      error,
      errorMessage: error?.message || t('auth.genericError'),
    }
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
  return String(message || '')
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

function _usernameFromEmail(email) {
  const raw = String(email || '').trim()
  if (!raw) return ''
  const [localPart] = raw.split('@')
  return localPart.trim()
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
    // getSharedAuthSession now surfaces refresh errors as throws; right
    // after a fresh sign-in a transient failure must keep the retry loop
    // alive, not abort the whole flow on the first attempt.
    let session = null
    try { session = await getSharedAuthSession({ refresh: true }) }
    catch (_) { session = null }
    if (session?.user) return session
    if (i < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return null
}

function _resetAllTurnstileActions() {
  resetTurnstile('signup')
  resetTurnstile('login')
  resetTurnstile('password_reset')
}

export function switchToLogin(prefillEmail = '', resetMessage = false) {
  showError('')
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('forgot-password-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'none'
  document.getElementById('login-form').style.display  = 'block'
  _setSocialLoginVisibility(_shouldShowSocialLogin())
  _resetAllTurnstileActions()
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
  _setSocialLoginVisibility(_shouldShowSocialLogin())
  _resetAllTurnstileActions()
  if (prefillEmail) document.getElementById('signup-email').value = prefillEmail
  _writeAuthDraft({ mode: 'signup', signupEmail: prefillEmail || document.getElementById('signup-email').value })
}

export function switchToForgotPassword(prefillEmail = '') {
  showError('')
  document.getElementById('login-form').style.display = 'none'
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'none'
  document.getElementById('forgot-password-form').style.display = 'block'
  _setSocialLoginVisibility(false)
  _resetAllTurnstileActions()
  if (prefillEmail) document.getElementById('forgot-email').value = prefillEmail
}

export function switchToResetPassword() {
  showError('')
  document.getElementById('login-form').style.display = 'none'
  document.getElementById('signup-form').style.display = 'none'
  document.getElementById('forgot-password-form').style.display = 'none'
  document.getElementById('reset-password-form').style.display = 'block'
  _setSocialLoginVisibility(false)
  _resetAllTurnstileActions()
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
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: SUPABASE_EMAIL_CONFIRM_REDIRECT },
  })
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
  if (window.location.pathname === SUPABASE_OAUTH_CALLBACK_PATH) {
    return false
  }
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
  const socialLoginSection = document.getElementById('auth-social-login')
  const googleLoginBtn = document.getElementById('google-login-btn')
  const languageSelect = document.getElementById('auth-language-select')

  loginBtn.dataset.label  = t('auth.signIn')
  signupBtn.dataset.label = t('auth.createAccount')
  forgotBtn.dataset.label = t('auth.sendResetLink')
  resetBtn.dataset.label  = t('auth.updatePassword')
  _setSocialLoginVisibility(_shouldShowSocialLogin())
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

  if (socialLoginSection) {
    socialLoginSection.style.display = _shouldShowSocialLogin() ? 'flex' : 'none'
  }
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', async () => {
      if (!_shouldShowSocialLogin()) return
      showError('')
      googleLoginBtn.disabled = true

      // On native Android we must never fall back to the browser OAuth flow:
      // that leaks the session into the system browser and (as observed on
      // Samsung) never returns the user to the app. Missing Google config on
      // native surfaces as an error, never as a browser redirect.
      if (isAndroidApp() && isNativeApp()) {
        if (!isGoogleNativeConfigured()) {
          console.error('Native Google sign-in is not configured (VITE_GOOGLE_WEB_CLIENT_ID missing).')
          showError(t('auth.genericError'))
          googleLoginBtn.disabled = false
          return
        }
        try {
          const { session } = await signInWithGoogleNative()
          const resolvedSession = session || await _waitForSession()
          if (resolvedSession?.user) {
            _clearAuthDraft()
            // Await routing so this branch does not complete while account
            // resolution is still in flight. The direct result and the
            // deferred SIGNED_IN event both funnel through
            // resolveAuthenticatedSessionOnce(), so the second call is a
            // no-op — but returning early here would race the finally
            // block that re-enables the Google button.
            await onAuthenticated(resolvedSession)
            return
          }
          showError(t('auth.genericError'))
        } catch (error) {
          if (error instanceof GoogleSignInCancelledError) {
            // User dismissed the picker — not an error worth surfacing.
          } else if (error instanceof GoogleSignInMissingTokenError) {
            console.error('Native Google sign-in returned no ID token:', error)
            showError(t('auth.genericError'))
          } else if (error instanceof GoogleSignInConfigError) {
            console.error('Native Google sign-in is not configured:', error)
            showError(t('auth.genericError'))
          } else {
            console.error('Native Google sign-in failed unexpectedly:', error)
            showError(error?.message || t('auth.genericError'))
          }
        } finally {
          // Always restore the Google button so a rejected routing does not
          // leave it stuck disabled.
          googleLoginBtn.disabled = false
        }
        return
      }

      // Web / PWA: use the standard Supabase OAuth browser redirect.
      try {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: getSupabaseOAuthRedirectUrl(),
          },
        })

        if (error) {
          showError(error.message || t('auth.genericError'))
          googleLoginBtn.disabled = false
        }
      } catch (error) {
        console.error('Google sign-in failed unexpectedly:', error)
        showError(error?.message || t('auth.genericError'))
        googleLoginBtn.disabled = false
      }
    })
  }

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
    await performExplicitSignOut().catch(error => {
      console.warn('Sign-out while leaving password reset did not finish cleanly:', error)
    })
  })

  // ── Login ──────────────────────────────────────────────────────────────────
  loginForm.addEventListener('submit', async e => {
    e.preventDefault()
    showError('')
    const email    = document.getElementById('login-email').value.trim()
    const password = document.getElementById('login-password').value

    let captchaToken
    try {
      setLoading(loginBtn, true)
      try {
        captchaToken = await _obtainCaptchaToken('login')
      } catch (captchaError) {
        const captchaMessage = _handleCaptchaError('login', captchaError)
        if (captchaMessage) {
          showError(captchaMessage)
          return
        }
        throw captchaError
      }
      try { console.info('[auth] password_signin_started', { hasToken: !!captchaToken }) } catch (_) {}
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
        options: { captchaToken },
      })
      try { console.info('[auth] password_signin_completed', { ok: !error, code: error?.code || error?.name || null }) } catch (_) {}
      if (error) resetTurnstile('login')

      if (!error) {
        const session = data?.session || await _waitForSession()
        if (session?.user) {
          _clearAuthDraft()
          await onAuthenticated(session)
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

    let captchaToken
    try {
      setLoading(signupBtn, true)
      try {
        captchaToken = await _obtainCaptchaToken('signup')
      } catch (captchaError) {
        const captchaMessage = _handleCaptchaError('signup', captchaError)
        if (captchaMessage) {
          showError(captchaMessage)
          return
        }
        throw captchaError
      }
      const signUpPayload = {
        email,
        password,
        options: {
          captchaToken,
          emailRedirectTo: SUPABASE_EMAIL_CONFIRM_REDIRECT,
        },
      }
      const { error } = await supabase.auth.signUp(signUpPayload)
      if (error) resetTurnstile('signup')

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
        const username = _usernameFromEmail(session.user.email || email)
        if (username) {
          const { error: profileError } = await supabase
            .from('profiles')
            .update({ username })
            .eq('id', session.user.id)
          if (profileError) {
            console.warn('Could not seed username from signup email:', profileError.message)
          }
        }
        _clearAuthDraft()
        await onAuthenticated(session)
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
    
    let captchaToken
    try {
      setLoading(forgotBtn, true)
      try {
        captchaToken = await _obtainCaptchaToken('password_reset')
      } catch (captchaError) {
        const captchaMessage = _handleCaptchaError('password_reset', captchaError)
        if (captchaMessage) {
          showError(captchaMessage)
          return
        }
        throw captchaError
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: _getPasswordResetRedirectUrl(),
        captchaToken,
      })
      if (error) resetTurnstile('password_reset')

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
          performExplicitSignOut(),
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
  _setReauthCancelVisible(false)
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('app-shell').style.display    = 'none'
}

export function hideAuthOverlay() {
  _setReauthCancelVisible(false)
  document.getElementById('auth-overlay').style.display = 'none'
  document.getElementById('app-shell').style.display    = 'block'
}

// REAUTH_REQUIRED recovery variant: same overlay, plus a non-destructive
// "Not now" escape back to the cached shell. Shown ONLY on this path — the
// ordinary UNAUTHENTICATED overlay has no shell to return to, so plain
// showAuthOverlay()/hideAuthOverlay() always hide the cancel action.
export function showAuthOverlayForReauth() {
  document.getElementById('auth-overlay').style.display = 'flex'
  document.getElementById('app-shell').style.display    = 'none'
  _setReauthCancelVisible(true)
}

function _setReauthCancelVisible(visible) {
  const cancel = document.getElementById('auth-reauth-cancel')
  if (!cancel) return
  cancel.style.display = visible ? 'block' : 'none'
  if (!visible) return
  const link = cancel.querySelector('a')
  if (link) link.textContent = t('auth.reauthNotNow')
  if (cancel.dataset.bound !== 'true') {
    cancel.dataset.bound = 'true'
    link?.addEventListener('click', e => {
      e.preventDefault()
      hideAuthOverlay()
    })
  }
}
