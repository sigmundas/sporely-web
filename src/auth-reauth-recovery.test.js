// Reauth-recovery regression suite.
//
// Root cause of the Android "login limbo": (1) supabase-js reports session
// refresh failures via the `{ data, error }` channel WITHOUT throwing, and
// getSharedAuthSession discarded the error — so every downstream
// `_isExplicitAuthRejection` gate was dead code; (2) auth-js initialize()
// can remove a session and emit SIGNED_OUT before main.js subscribes; (3)
// AUTHENTICATED_REAUTH_REQUIRED had NO user-visible exit (no sign-in action
// anywhere in the cached shell).
//
// Two test styles, following the repo pattern:
//   * behavioral — pure modules with an injected fake supabase singleton;
//   * structural — source guards over main.js / profile.js / auth.js, which
//     have import-time side effects and cannot be imported here.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const profileSource = readFileSync(path.join(__dirname, 'screens/profile.js'), 'utf8')
const authScreenSource = readFileSync(path.join(__dirname, 'screens/auth.js'), 'utf8')
const i18nSource = readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const indexHtml = readFileSync(path.join(__dirname, '../index.html'), 'utf8')

// ── Fake supabase singleton (installed BEFORE ./supabase.js is imported) ────
let _fakeGetSession = async () => ({ data: { session: null }, error: null })
const _earlyListeners = []
globalThis.__sporelySupabaseClient__ = {
  auth: {
    onAuthStateChange(cb) {
      _earlyListeners.push(cb)
      return { data: { subscription: { unsubscribe() {} } } }
    },
    getSession() { return _fakeGetSession() },
  },
}

const { hadEarlyBootSignOut, stopEarlyAuthEventCapture, getEarlyBootAuthEvents } = await import('./supabase.js')
const { clearSharedAuthSessionCache, getSharedAuthSession } = await import('./auth-session.js')
const { canBeginLoginOAuth } = await import('./capabilities.js')
const { AUTH_STATE } = await import('./auth-state.js')

beforeEach(() => {
  clearSharedAuthSessionCache()
})

// ── (H2) getSession errors must surface, not vanish ─────────────────────────

test('getSharedAuthSession THROWS when getSession returns { session: null, error } (was silently swallowed)', async () => {
  const rejection = Object.assign(new Error('Invalid Refresh Token: Already Used'), { code: 'refresh_token_already_used' })
  _fakeGetSession = async () => ({ data: { session: null }, error: rejection })
  await assert.rejects(() => getSharedAuthSession({ refresh: true }), err => err === rejection)
})

test('getSharedAuthSession returns the session when a session AND an error coexist (never discard a usable session)', async () => {
  const session = { user: { id: 'u1' }, access_token: 'x' }
  _fakeGetSession = async () => ({ data: { session }, error: new Error('background refresh hiccup') })
  assert.equal(await getSharedAuthSession({ refresh: true }), session)
})

test('getSharedAuthSession stays non-throwing for a plain null session with no error', async () => {
  _fakeGetSession = async () => ({ data: { session: null }, error: null })
  assert.equal(await getSharedAuthSession({ refresh: true }), null)
})

// ── (H1) early boot SIGNED_OUT capture ───────────────────────────────────────

test('SIGNED_OUT emitted during auth-js initialize (before main.js subscribes) is captured; capture stops on demand', () => {
  assert.equal(hadEarlyBootSignOut(), false)
  for (const cb of _earlyListeners) cb('SIGNED_OUT', null)
  assert.equal(hadEarlyBootSignOut(), true)
  assert.deepEqual(getEarlyBootAuthEvents(), ['SIGNED_OUT'])
  stopEarlyAuthEventCapture()
  for (const cb of _earlyListeners) cb('TOKEN_REFRESHED', null)
  assert.deepEqual(getEarlyBootAuthEvents(), ['SIGNED_OUT'])
})

// ── (escape hatch) capability carve-out ──────────────────────────────────────

test('canBeginLoginOAuth ALLOWS the sign-in pipeline in AUTHENTICATED_REAUTH_REQUIRED (the only exit from that state)', () => {
  assert.equal(canBeginLoginOAuth(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED).allowed, true)
  assert.equal(canBeginLoginOAuth(AUTH_STATE.AUTHENTICATED_COMPLETE).allowed, false)
  assert.equal(canBeginLoginOAuth(AUTH_STATE.AUTHENTICATED_CACHED).allowed, false)
})

// ── Structural guards over main.js ───────────────────────────────────────────

function _extractFunctionBody(source, header) {
  const start = source.indexOf(header)
  assert.ok(start >= 0, `function header not found: ${header}`)
  // Skip past the (possibly destructured) parameter list so the body brace
  // is found, not a default-object brace inside the parens.
  const paren = source.indexOf('(', start)
  let pdepth = 1
  let j = paren + 1
  while (j < source.length && pdepth > 0) {
    const c = source[j]
    if (c === '(') pdepth++
    else if (c === ')') pdepth--
    if (pdepth === 0) break
    j++
  }
  const braceIdx = source.indexOf('{', j)
  let depth = 1
  let i = braceIdx + 1
  while (i < source.length && depth > 0) {
    const c = source[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) break
    i++
  }
  return source.slice(braceIdx, i + 1)
}

test('cached revalidation pins REAUTH_REQUIRED on a server rejection instead of dispatching signOut', () => {
  const body = _extractFunctionBody(mainSource, "async function _attemptCachedRevalidation(source")
  assert.doesNotMatch(body, /signOut\s*\(/, 'auth rejection during revalidation must pin REAUTH_REQUIRED, not purge via signOut')
  const rejectIdx = body.indexOf('cached_revalidation_auth_rejected')
  assert.ok(rejectIdx > 0)
  const branch = body.slice(rejectIdx, body.indexOf('return', rejectIdx))
  assert.match(branch, /_syncCachedStateWithReachability\(current\.userId,\s*'reachable'\)/)
})

// auth-js emits SIGNED_OUT ITSELF when it removes an unrecoverable stored
// session (`_callRefreshToken` → `_removeSession` on a non-retryable refresh
// rejection). Removing our own signOut() call is not enough — the deferred
// SIGNED_OUT handler must classify the event, or the purge still destroys
// queued observations one macrotask after the rejection is observed.
test('SIGNED_OUT handler: internal session loss for the trusted same-user shell pins REAUTH_REQUIRED before any purge', () => {
  const body = _extractFunctionBody(mainSource, 'async function _handleDeferredAuthEvent(')
  const signedOutIdx = body.indexOf("event === 'SIGNED_OUT'")
  assert.ok(signedOutIdx > 0)
  const block = body.slice(signedOutIdx)
  const classifyIdx = block.indexOf('consumeExplicitSignOutRequest()')
  const lossIdx = block.indexOf('_isInternalSessionLossForTrustedUser()')
  const purgeIdx = block.indexOf('clearLastValidatedAccount()')
  assert.ok(classifyIdx > 0, 'handler must consume the explicit-sign-out flag')
  assert.ok(lossIdx > 0, 'handler must check for internal session loss')
  assert.ok(purgeIdx > lossIdx, 'classification must run BEFORE the purge')
  const lossBranch = block.slice(lossIdx, purgeIdx)
  assert.match(lossBranch, /AUTHENTICATED_REAUTH_REQUIRED/)
  assert.doesNotMatch(lossBranch, /_purgeUserDrafts|clearLocalDataOwner|clearHomeCache/)
})

test('internal-session-loss downgrade requires ALL identity markers to agree (fails closed to the purge)', () => {
  const body = _extractFunctionBody(mainSource, 'function _isInternalSessionLossForTrustedUser(')
  assert.match(body, /readLastValidatedAccount/)
  assert.match(body, /getLocalDataOwner/)
  assert.match(body, /current\.userId === snapshot\.userId/)
  assert.match(body, /state\.user\?\.id === snapshot\.userId/)
})

test('every signOut in src/ routes through the explicit seam (a raw call would be misclassified as session loss)', async () => {
  const { execSync } = await import('node:child_process')
  const out = execSync(
    "grep -rln 'supabase\\.auth\\.signOut(' --include='*.js' . | grep -v '.test.' || true",
    { cwd: __dirname, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean)
  assert.deepEqual(out, ['./auth-signout.js'], `raw supabase.auth.signOut( found outside auth-signout.js: ${out.join(', ')}`)
})

test('performExplicitSignOut flags the request; the flag is one-shot and persists across a thrown signOut', async () => {
  let shouldThrow = false
  globalThis.__sporelySupabaseClient__.auth.signOut = async () => {
    if (shouldThrow) throw new Error('network down')
    return { error: null }
  }
  const { performExplicitSignOut, consumeExplicitSignOutRequest, _resetExplicitSignOutForTests } = await import('./auth-signout.js')
  _resetExplicitSignOutForTests()
  assert.equal(consumeExplicitSignOutRequest(), false)
  await performExplicitSignOut()
  assert.equal(consumeExplicitSignOutRequest(), true)
  assert.equal(consumeExplicitSignOutRequest(), false, 'flag must be one-shot')
  shouldThrow = true
  await assert.rejects(() => performExplicitSignOut())
  assert.equal(consumeExplicitSignOutRequest(), true, 'a thrown explicit signOut must still honor the sign-out intent on the next SIGNED_OUT')
  _resetExplicitSignOutForTests()
})

test('same-user in-place revalidation to COMPLETE dismisses the reauth sign-in overlay', () => {
  const body = _extractFunctionBody(mainSource, 'async function _revalidateCachedRevealInPlace(')
  const completeIdx = body.indexOf('AUTH_STATE.AUTHENTICATED_COMPLETE')
  assert.ok(completeIdx > 0)
  assert.ok(body.indexOf('hideAuthOverlay()', completeIdx) > 0, 'overlay must be hidden after the COMPLETE transition')
})

test('main.js wires the shared "Sign in again" recovery through the EXISTING auth pipeline (no parallel state machine)', () => {
  assert.match(mainSource, /setReauthHandler\(/)
  const handlerIdx = mainSource.indexOf('setReauthHandler(')
  const handler = mainSource.slice(handlerIdx, handlerIdx + 400)
  assert.match(handler, /ensureAuthUiInitialized\(/)
  assert.match(handler, /switchToLogin\(/)
  assert.match(handler, /showAuthOverlayForReauth\(\)/)
  assert.doesNotMatch(handler, /signOut/, 'reauth must authenticate FIRST — never sign out first')
})

test('main.js stops the early auth-event capture once its own subscription is live', () => {
  const subIdx = mainSource.indexOf('supabase.auth.onAuthStateChange((event, session)')
  assert.ok(subIdx > 0)
  assert.ok(mainSource.indexOf('stopEarlyAuthEventCapture()', subIdx) > 0)
})

test('boot-time explicit rejection reveal is tagged with the auth-rejected reason (diagnosable next time)', () => {
  const body = _extractFunctionBody(mainSource, 'async function _tryCachedAuthenticatedBoot(')
  assert.match(body, /reason:\s*'auth-rejected'/)
  assert.match(body, /hadEarlyBootSignOut\(\)/)
  assert.match(body, /session-removed-at-init/)
})

// ── Structural guards over the recovery surface ──────────────────────────────

test('Profile sheet: reauth banner exists, is gated on requiresReauthentication, and its action never signs out', () => {
  assert.match(profileSource, /import \{ beginReauthentication \} from '\.\.\/reauth\.js'/)
  assert.match(profileSource, /requiresReauthentication\(\)/)
  assert.match(indexHtml, /id="profile-reauth-banner"/)
  assert.match(indexHtml, /id="profile-reauth-btn"/)
  const btnIdx = profileSource.indexOf("getElementById('profile-reauth-btn')")
  assert.ok(btnIdx > 0)
  const clickHandler = profileSource.slice(btnIdx, btnIdx + 300)
  assert.doesNotMatch(clickHandler, /signOut/)
  assert.match(clickHandler, /beginReauthentication\(/)
})

test('Profile sheet: gated states render the cached snapshot instead of firing authenticated reads', () => {
  const body = _extractFunctionBody(profileSource, 'export async function loadProfile(')
  const gateIdx = body.indexOf('canUseAuthenticatedNetwork()')
  const fetchIdx = body.indexOf('_loadProfileData()')
  assert.ok(gateIdx > 0 && fetchIdx > gateIdx, 'capability gate must run before any profile network read')
  assert.match(body, /_renderProfileFromCachedSnapshot\(\)/)
  // Cached render must be same-user only (privacy: no cross-account leak).
  const cachedBody = _extractFunctionBody(profileSource, 'function _renderProfileFromCachedSnapshot(')
  assert.match(cachedBody, /snapshot\.userId === uid/)
})

test('auth overlay: reauth variant exposes a non-destructive cancel; plain overlay paths always hide it', () => {
  assert.match(authScreenSource, /export function showAuthOverlayForReauth\(/)
  assert.match(indexHtml, /id="auth-reauth-cancel"/)
  const show = _extractFunctionBody(authScreenSource, 'export function showAuthOverlay(')
  const hide = _extractFunctionBody(authScreenSource, 'export function hideAuthOverlay(')
  assert.match(show, /_setReauthCancelVisible\(false\)/)
  assert.match(hide, /_setReauthCancelVisible\(false\)/)
})

test('reauth strings are localized in every supported locale', () => {
  for (const key of ['profile.sessionExpired', 'profile.sessionExpiredBody', 'profile.signInAgain', 'auth.reauthNotNow']) {
    const occurrences = i18nSource.split(`'${key}'`).length - 1
    assert.equal(occurrences, 4, `${key} must be present in en, nb_NO, sv_SE, de_DE (found ${occurrences})`)
  }
})

// ── Diagnostics safety ────────────────────────────────────────────────────────

test('no auth logging path emits tokens or raw auth payloads', () => {
  // The safe logger only receives event names / codes; guard the new call
  // sites against accidentally logging session objects or tokens.
  for (const banned of [/_authLog\([^)]*access_token/, /_authLog\([^)]*refresh_token/, /_authLog\([^)]*\bsession\b\s*[,}]/]) {
    assert.doesNotMatch(mainSource, banned)
  }
})
