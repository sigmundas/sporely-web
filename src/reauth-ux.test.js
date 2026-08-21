// Reauth recovery-UX + state-reconciliation regression suite (device-QA
// round: "avatar stays initials until Profile is opened", "Finds stays on
// the stale reauth note after a successful same-user reauth", "REAUTH
// recovery action hidden inside Profile").
//
// Two test styles, following the repo pattern:
//   * behavioral — pure modules (reauth.js, capabilities.js, auth-state.js);
//   * structural — source guards over main.js / screens, which have
//     import-time side effects and cannot be imported here.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { AUTH_STATE, setAuthState, _resetAuthStateForTests } from './auth-state.js'
import { requiresReauthentication } from './capabilities.js'
import { beginReauthentication, setReauthHandler } from './reauth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8')
const homeSource = readFileSync(path.join(__dirname, 'screens/home.js'), 'utf8')
const findsSource = readFileSync(path.join(__dirname, 'screens/finds.js'), 'utf8')
const profileSource = readFileSync(path.join(__dirname, 'screens/profile.js'), 'utf8')
const reauthSource = readFileSync(path.join(__dirname, 'reauth.js'), 'utf8')
const i18nSource = readFileSync(path.join(__dirname, 'i18n.js'), 'utf8')
const indexHtml = readFileSync(path.join(__dirname, '../index.html'), 'utf8')

// Extract a named function's chunk from source (header + following chars).
function _chunk(src, header, span = 2000) {
  const idx = src.indexOf(header)
  assert.ok(idx >= 0, `source must contain ${header}`)
  return src.slice(idx, idx + span)
}

// Extract a top-level function's body: header through the first `\n}` line.
// ONLY valid for unindented module-level functions — a nested function would
// silently truncate at its parent's inner closing brace.
function _fnBody(src, header) {
  const idx = src.indexOf(header)
  assert.ok(idx >= 0, `source must contain ${header}`)
  const end = src.indexOf('\n}', idx)
  assert.ok(end > idx)
  return src.slice(idx, end + 2)
}

beforeEach(() => {
  _resetAuthStateForTests()
  setReauthHandler(null)
})

// ── The single recovery seam (behavioral) ────────────────────────────────────

test('beginReauthentication invokes the injected handler ONLY in AUTHENTICATED_REAUTH_REQUIRED', () => {
  const calls = []
  setReauthHandler(email => calls.push(email))

  setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
  assert.equal(beginReauthentication('me@example.com'), true)
  assert.deepEqual(calls, ['me@example.com'])
})

test('beginReauthentication is a NO-OP in plain-offline CACHED, COMPLETE, and UNAUTHENTICATED', () => {
  const calls = []
  setReauthHandler(email => calls.push(email))

  for (const s of [
    AUTH_STATE.AUTHENTICATED_CACHED,
    AUTH_STATE.AUTHENTICATED_COMPLETE,
    AUTH_STATE.AUTHENTICATED_INCOMPLETE,
    AUTH_STATE.UNAUTHENTICATED,
    AUTH_STATE.RESOLVING,
  ]) {
    setAuthState({ state: s, userId: s.startsWith('authenticated') ? 'u1' : null })
    assert.equal(beginReauthentication('me@example.com'), false, `must not fire in ${s}`)
  }
  assert.deepEqual(calls, [])
})

test('beginReauthentication without an injected handler fails soft (returns false, never throws)', () => {
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
  assert.equal(beginReauthentication(), false)
})

test('requiresReauthentication is true for REAUTH_REQUIRED only — CACHED stays an offline condition', () => {
  assert.equal(requiresReauthentication(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED), true)
  assert.equal(requiresReauthentication(AUTH_STATE.AUTHENTICATED_CACHED), false)
  assert.equal(requiresReauthentication(AUTH_STATE.AUTHENTICATED_COMPLETE), false)
})

test('ONE recovery pathway: main.js injects the handler; Profile/Home/Finds all call beginReauthentication', () => {
  // Exactly one injection point (main.js) + the definition (reauth.js).
  assert.match(mainSource, /setReauthHandler\(/)
  assert.doesNotMatch(homeSource, /setReauthHandler\(/)
  assert.doesNotMatch(findsSource, /setReauthHandler\(/)
  assert.doesNotMatch(profileSource, /setReauthHandler\(/)

  // Every surface routes through the same seam…
  assert.match(profileSource, /beginReauthentication\(/)
  assert.match(homeSource, /beginReauthentication\(/)
  assert.match(findsSource, /beginReauthentication\(/)
  // …and none of them contains its own auth logic.
  for (const [name, src] of [['home.js', homeSource], ['finds.js', findsSource]]) {
    assert.doesNotMatch(src, /showAuthOverlayForReauth/, `${name} must not open the overlay itself`)
    assert.doesNotMatch(src, /switchToLogin/, `${name} must not drive the login form itself`)
    assert.doesNotMatch(src, /auth\.signOut/, `${name} recovery must never sign out`)
  }
  // The seam itself gates on REAUTH_REQUIRED.
  assert.match(reauthSource, /requiresReauthentication\(\)/)
  assert.doesNotMatch(reauthSource, /signOut/)
})

// ── Header identity reconciliation on recovery to COMPLETE ───────────────────

test('cached-like → COMPLETE transition repaints header identity WITHOUT Profile interaction', () => {
  const chunk = _chunk(mainSource, 'function _bindReconnectTriggerToAuthState()')
  assert.match(chunk, /refreshHeaderProfileButtons\(\)/)
  // It must run inside the same-user recovery branch (after COMPLETE), where
  // the capability gate allows the authenticated avatar path.
  const branch = chunk.slice(chunk.indexOf('shouldTriggerReconnect) {'))
  assert.match(branch, /refreshHeaderProfileButtons\(\)/)
})

// ── Finds/Home reconciliation on recovery to COMPLETE ────────────────────────

test('COMPLETE recovery refreshes Finds unconditionally — NOT gated on state.currentScreen', () => {
  const chunk = _chunk(mainSource, 'function _bindReconnectTriggerToAuthState()')
  assert.match(chunk, /requestFindsRefresh\(0\)/)
  assert.doesNotMatch(chunk, /currentScreen/,
    'Finds→Profile→overlay→reauth completes while another surface is active; gating on currentScreen leaves stale REAUTH rendering')
})

test('COMPLETE recovery still drains the queue through the existing deduped triggerSync (same-user gated)', () => {
  const chunk = _chunk(mainSource, 'function _bindReconnectTriggerToAuthState()')
  assert.match(chunk, /wasCached && sameUser/)
  assert.match(chunk, /triggerSync\(\)/)
})

test('Home banner is driven by the auth-state lifecycle, so REAUTH→COMPLETE clears it automatically', () => {
  assert.match(homeSource, /subscribeAuthState\(\(\) => syncHomeSessionNotice\(\)\)/)
  const body = _fnBody(homeSource, 'export function syncHomeSessionNotice()')
  assert.match(body, /requiresReauthentication\(\)/)
  assert.match(body, /banner\.style\.display = reauth \? '' : 'none'/)
  // The sync only touches the banner — cached Home content is never blanked.
  assert.doesNotMatch(body, /innerHTML/)
  const bannerIds = body.match(/getElementById\('([^']+)'\)/g) || []
  for (const call of bannerIds) assert.match(call, /home-reauth-/)
})

// ── Home REAUTH surface ──────────────────────────────────────────────────────

test('Home REAUTH banner exists ABOVE the cached content and keeps that content in the DOM', () => {
  assert.match(indexHtml, /id="home-reauth-banner"/)
  assert.match(indexHtml, /id="home-reauth-btn"/)
  const homeContentIdx = indexHtml.indexOf('<div class="home-content">')
  const bannerIdx = indexHtml.indexOf('id="home-reauth-banner"')
  const gridIdx = indexHtml.indexOf('<div class="action-grid">')
  assert.ok(homeContentIdx > 0 && bannerIdx > homeContentIdx && gridIdx > bannerIdx,
    'banner must sit inside home-content, above the cached sections')
  // Hidden by default — only the REAUTH state reveals it.
  const bannerTag = indexHtml.slice(indexHtml.lastIndexOf('<', bannerIdx), indexHtml.indexOf('>', bannerIdx))
  assert.match(bannerTag, /display:\s*none/)
})

test('Home REAUTH banner uses localized strings and the shared recovery seam', () => {
  const body = _fnBody(homeSource, 'export function syncHomeSessionNotice()')
  assert.match(body, /t\('auth\.sessionExpired'\)/)
  assert.match(body, /t\('home\.sessionExpiredBody'\)/)
  assert.match(body, /t\('auth\.signInAgain'\)/)
  const btnIdx = homeSource.indexOf("getElementById('home-reauth-btn')?.addEventListener")
  assert.ok(btnIdx > 0)
  assert.match(homeSource.slice(btnIdx, btnIdx + 200), /beginReauthentication\(/)
})

// ── Finds REAUTH surface ─────────────────────────────────────────────────────

test('Finds REAUTH note carries the Sign-in-again action; plain-offline CACHED note does NOT', () => {
  const fn = _fnBody(findsSource, 'function _findsOfflineInfoHtml(')
  const reauthBranchStart = fn.indexOf("mode === 'reauth'")
  assert.ok(reauthBranchStart > 0)
  // The branch is a single `return \`…\`` statement — it ends at its newline.
  const reauthBranchEnd = fn.indexOf('\n', fn.indexOf('return', reauthBranchStart))
  const reauthBranch = fn.slice(reauthBranchStart, reauthBranchEnd)
  assert.match(reauthBranch, /finds-reauth-btn/)
  assert.match(reauthBranch, /auth\.sessionExpired/)
  assert.match(reauthBranch, /auth\.signInAgain/)
  // Everything after the reauth branch is the CACHED/offline note: no CTA.
  const cachedBranch = fn.slice(reauthBranchEnd)
  assert.doesNotMatch(cachedBranch, /finds-reauth-btn/)
  assert.doesNotMatch(cachedBranch, /signInAgain/)
})

test('Finds reauth button binds by delegation on the stable list container to the shared seam', () => {
  const idx = findsSource.indexOf("getElementById('finds-list')?.addEventListener('click'")
  assert.ok(idx > 0, 'delegated click binding must exist (the note is re-created on every render)')
  const handler = findsSource.slice(idx, idx + 300)
  assert.match(handler, /finds-reauth-btn/)
  assert.match(handler, /beginReauthentication\(/)
})

// ── Localization ─────────────────────────────────────────────────────────────

test('new recovery copy exists in all four supported locales', () => {
  for (const key of ['auth.sessionExpired', 'auth.signInAgain', 'home.sessionExpiredBody']) {
    const occurrences = i18nSource.split(`'${key}':`).length - 1
    assert.equal(occurrences, 4, `${key} must exist in en, nb_NO, sv_SE and de_DE`)
  }
  assert.match(i18nSource, /'auth\.sessionExpired': 'Økten er utløpt'/)
  assert.match(i18nSource, /'auth\.signInAgain': 'Logg inn igjen'/)
})
