// Structural + orchestration invariants that Stage B1 must preserve:
//
//   * Exactly ONE online Home hydration on an ordinary authenticated cold
//     boot (Stage A guarantee; Stage B1 must not double-hit it).
//   * Cached boot performs ZERO online Home refresh until revalidation
//     succeeds.
//   * The cached-boot code path exists in main.js and integrates
//     last-validated-account.
//   * The SIGNED_OUT handler clears the last-validated-account snapshot
//     alongside clearLocalDataOwner.
//   * Snapshot is persisted ONLY on the COMPLETE branch after a successful
//     profile fetch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8')

test('Stage A hydration invariant: initHome() must NOT call refreshHome', () => {
  const homeSource = readFileSync(new URL('./screens/home.js', import.meta.url), 'utf8')
  // Extract initHome body via balanced-brace walk.
  const idx = homeSource.indexOf('export function initHome()')
  assert.ok(idx > 0, 'initHome must exist')
  const braceOpen = homeSource.indexOf('{', idx)
  let depth = 1
  let i = braceOpen + 1
  while (i < homeSource.length && depth > 0) {
    const c = homeSource[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) break
    i++
  }
  const body = homeSource.slice(braceOpen, i + 1)
  assert.equal(/\brefreshHome(?:Safe)?\s*\(/.test(body), false, 'initHome must not fire refreshHome — Stage A invariant')
})

test('Stage B1 cached-boot: main.js contains a cached-boot path integrating last-validated-account', () => {
  assert.match(mainSource, /_tryCachedAuthenticatedBoot/)
  assert.match(mainSource, /readLastValidatedAccount/)
  assert.match(mainSource, /renderCachedHeaderProfileButtons/)
  assert.match(mainSource, /AUTHENTICATED_CACHED/)
  // Stage B1 refinement: the second cached-mode state must exist and be
  // wired at the reveal site.
  assert.match(mainSource, /AUTHENTICATED_REAUTH_REQUIRED/)
})

function _extractFunctionBody(source, signature) {
  const startIdx = source.indexOf(signature)
  assert.ok(startIdx > 0, `${signature} must exist`)
  // Skip past the parameter list first so a destructuring `{ ... }` in the
  // signature does not confuse the balanced walk that follows.
  let paren = source.indexOf('(', startIdx)
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

function _extractCachedBootBody() {
  return _extractFunctionBody(mainSource, 'async function _tryCachedAuthenticatedBoot(')
}

test('Stage B1 cached-boot: the cached path does NOT call refreshHome/refreshHomeSafe (zero online Home hydration)', () => {
  const body = _extractCachedBootBody()
  assert.equal(/\brefreshHome(?:Safe)?\s*\(/.test(body), false, 'cached boot must not fire an online Home refresh')
})

test('SIGNED_OUT handler clears the last-validated-account snapshot', () => {
  // Look at the SIGNED_OUT block specifically.
  const idx = mainSource.indexOf("event === 'SIGNED_OUT'")
  assert.ok(idx > 0)
  const chunk = mainSource.slice(idx, idx + 2500)
  assert.match(chunk, /clearLastValidatedAccount\(\)/)
})

test('COMPLETE branch persists the last-validated-account snapshot only after successful resolve', () => {
  // The write must happen after refreshHeaderProfileButtons + navigate('home').
  // Scoped to _resolveAndRouteForUser so the Stage B2a in-place revalidation
  // helper (which persists without a reveal — the shell is already up) does
  // not confuse the positional check.
  const body = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  const persistIdx = body.indexOf('_persistLastValidatedAccountSnapshot(')
  assert.ok(persistIdx > 0, 'snapshot writer must be called from _resolveAndRouteForUser')
  const revealIdx = body.indexOf('hideAccountTransitionBlocker()')
  assert.ok(revealIdx > 0)
  // Snapshot write scheduled after reveal so a slow plan fetch does not
  // delay the shell.
  assert.ok(persistIdx > revealIdx, 'snapshot write must be scheduled after reveal, not before')
})

test('cached-plan fallback path does NOT overwrite the persisted plan (uses NETWORK-tagged results only)', () => {
  // Structural check: the writer inspects getCloudPlanSource() before
  // choosing which plan to persist.
  assert.match(mainSource, /getCloudPlanSource\(cloudPlan\)/)
  assert.match(mainSource, /CLOUD_PLAN_SOURCE\.NETWORK/)
})

test('cached boot classifier: explicit auth rejection MUST NOT enter cached mode', () => {
  assert.match(mainSource, /_isExplicitAuthRejection\(/)
  assert.match(mainSource, /cached_boot_skipped_auth_reject/)
})

test('background revalidation: online + visibilitychange are wired', () => {
  assert.match(mainSource, /_scheduleCachedRevalidation/)
  assert.match(mainSource, /addEventListener\('online'/)
  assert.match(mainSource, /visibilitychange/)
})

test('boot timings: new B1 marks are emitted at the appropriate call sites', () => {
  for (const label of [
    'last-validated-account-loaded',
    'cached-auth-selected',
    'cached-header-rendered',
    'revalidation-started',
    'revalidation-completed',
    // Stage B1 refinement: reachability probe marks.
    'reachability-probe-started',
    'reachability-probe-completed',
  ]) {
    assert.match(mainSource, new RegExp(`_bootMark\\('${label.replace(/-/g, '-')}`))
  }
})

test('Stage B1 refinement: the unconditional 3-second post-reveal retry is removed', () => {
  // Regression guard: the earlier `setTimeout(() => trigger('post-reveal-retry'), 3000)`
  // must not reappear as-is. A single deferred re-probe is fine (guarded by
  // initialReachability === 'unreachable'), but it must not fire on every
  // cached boot regardless of state.
  const idx = mainSource.indexOf('_scheduleCachedRevalidation')
  assert.ok(idx > 0)
  const chunk = mainSource.slice(idx, idx + 4000)
  assert.equal(/setTimeout\([^)]*3000\)/.test(chunk), false, "old 3s unconditional timer must not be present")
  // A guarded single-shot re-probe is allowed (5s in the refined design).
  assert.match(chunk, /initialReachability\s*===\s*'unreachable'/)
})

test('Stage B1 refinement: main.js imports classifier + probe from auth-classification module', () => {
  assert.match(mainSource, /import\s*\{[^}]*isExplicitAuthRejection[^}]*\}\s*from\s*'\.\/auth-classification\.js'/)
  assert.match(mainSource, /probeBackendReachability/)
})

test('no navigator.onLine is used as auth authority anywhere in main.js', () => {
  // A hint-level use in the UI is fine; the classifier must not depend on
  // it. Strip line and block comments before scanning so the plan-explaining
  // comment does not fail the invariant.
  const stripped = mainSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.equal(/navigator\.onLine/.test(stripped), false, 'navigator.onLine must never gate cached-boot decision (code, not comments)')
})

test('cached-boot preserves account-transition boundary (blocker + STALE recheck)', () => {
  const body = _extractCachedBootBody()
  assert.match(body, /beginAccountTransition\(\)/)
  assert.match(body, /clearUserScopedUi\(\)/)
  assert.match(body, /showAccountTransitionBlocker\(\)/)
  assert.match(body, /isCurrentAccountTransition\(/)
})

// ── Stage B2a: Home read-model cache ─────────────────────────────────────────

const homeSource = readFileSync(new URL('./screens/home.js', import.meta.url), 'utf8')

test('B2a online boot: cached Home render strictly precedes the single online refresh', () => {
  const body = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  const cacheIdx = body.indexOf('renderHomeFromCache(')
  const refreshIdx = body.indexOf('refreshHomeSafe()')
  assert.ok(cacheIdx > 0, 'COMPLETE branch must render the cached Home model')
  assert.ok(refreshIdx > 0, 'COMPLETE branch must perform the online refresh')
  assert.ok(cacheIdx < refreshIdx, 'cache render must be sequenced before the network refresh so stale data never paints over fresh data')
})

test('B2a online boot: exactly ONE Home network hydration in the COMPLETE branch', () => {
  // The `await refreshHome()` inside the profile-setup completion callback is
  // a separate user-triggered flow (first-run setup), not the cold-boot
  // hydration — only the post-reveal refreshHomeSafe() counts here.
  const body = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  const calls = body.match(/\brefreshHomeSafe\s*\(/g) || []
  assert.equal(calls.length, 1, 'the COMPLETE branch must own exactly one Home refresh call')
})

test('B2a cached boot: renders the persisted Home model, still with zero online Home refresh', () => {
  const body = _extractCachedBootBody()
  assert.match(body, /renderHomeFromCache\(/)
  assert.equal(/\brefreshHome(?:Safe)?\s*\(/.test(body), false)
})

test('B2a reconnect: same-user cached reveal revalidates in place (no blocker, no DOM blank, one refresh)', () => {
  assert.match(mainSource, /_revalidateCachedRevealInPlace/)
  const body = _extractFunctionBody(mainSource, 'async function _revalidateCachedRevealInPlace(')
  assert.equal(/clearUserScopedUi\(\)/.test(body), false, 'in-place revalidation must not blank the visible cached Home')
  assert.equal(/showAccountTransitionBlocker\(\)/.test(body), false, 'in-place revalidation must not show the blocker')
  const calls = body.match(/\brefreshHome(?:Safe)?\s*\(/g) || []
  assert.equal(calls.length, 1, 'in-place revalidation owns exactly one Home refresh')
  assert.match(body, /isCurrentAccountTransition\(/, 'in-place revalidation must still respect a superseding transition')
})

test('B2a reconnect: in-place path is gated on SAME user id in both auth state and state.user', () => {
  const body = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  assert.match(body, /authAtEntry\.userId === user\?\.id/)
  assert.match(body, /state\.user\?\.id === user\?\.id/)
})

test('B2a offline gating: refreshHomeSafe performs zero network hydration in cached/reauth states', () => {
  const body = _extractFunctionBody(homeSource, 'export async function refreshHomeSafe(')
  assert.match(body, /_isHomeNetworkGated\(\)/)
  assert.match(homeSource, /AUTH_STATE\.AUTHENTICATED_CACHED/)
  assert.match(homeSource, /AUTH_STATE\.AUTHENTICATED_REAUTH_REQUIRED/)
})

test('B2a cache-write policy: persists only under AUTHENTICATED_COMPLETE with matching userId', () => {
  const body = _extractFunctionBody(homeSource, 'async function _persistFreshHomeSections(')
  assert.match(body, /AUTH_STATE\.AUTHENTICATED_COMPLETE/)
  assert.match(body, /auth\.userId !== userId/)
  // Merge-preserve: failed sections keep their previous cached value.
  assert.match(body, /existing\?\.model/)
})

test('B2a lifecycle: SIGNED_OUT clears the Home cache alongside the B1 snapshot', () => {
  const idx = mainSource.indexOf("event === 'SIGNED_OUT'")
  assert.ok(idx > 0)
  const chunk = mainSource.slice(idx, idx + 4000)
  assert.match(chunk, /clearHomeCache\(|clearAllHomeCaches\(/)
})

test('B2a lifecycle: explicit sign-out revokes offline trust UNCONDITIONALLY, before and independent of purge outcome', () => {
  const idx = mainSource.indexOf("event === 'SIGNED_OUT'")
  assert.ok(idx > 0)
  const chunk = mainSource.slice(idx, idx + 4000)
  const revokeIdx = chunk.indexOf('clearLastValidatedAccount()')
  const purgeIdx = chunk.indexOf('_purgeUserDrafts()')
  const purgeOkIdx = chunk.indexOf('if (purgeOk)')
  assert.ok(revokeIdx > 0, 'snapshot must be cleared in the SIGNED_OUT handler')
  assert.ok(purgeIdx > 0 && purgeOkIdx > 0)
  assert.ok(revokeIdx < purgeIdx, 'offline trust must be revoked BEFORE the draft purge — a purge failure must never preserve a bootable offline identity')
  // The Home cache clear must also sit outside the purge-success gate.
  const cacheClearIdx = chunk.search(/clearHomeCache\(|clearAllHomeCaches\(/)
  const purgeOkBlockEnd = chunk.indexOf('}', purgeOkIdx)
  assert.ok(cacheClearIdx > purgeOkBlockEnd || cacheClearIdx < purgeOkIdx, 'Home cache clear must not be gated on purge success')
})

test('B2a online boot: the cache read is bounded by a short startup budget', () => {
  const body = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  const cacheCallIdx = body.indexOf('renderHomeFromCache(')
  assert.ok(cacheCallIdx > 0)
  const callChunk = body.slice(cacheCallIdx, cacheCallIdx + 300)
  assert.match(callChunk, /HOME_CACHE_ONLINE_BOOT_BUDGET_MS/, 'online-path cache read must carry the startup budget so a hung IndexedDB cannot delay the network refresh')
  const budget = mainSource.match(/HOME_CACHE_ONLINE_BOOT_BUDGET_MS = (\d+)/)
  assert.ok(budget && Number(budget[1]) <= 1000, 'the online boot cache budget must stay well under a second')
})

test('B2a lifecycle: account switch purges the previous user\'s Home cache', () => {
  const body = _extractFunctionBody(mainSource, 'async function _ensureAppReadyForUser(')
  assert.match(body, /clearHomeCache\(previousUserId\)/)
})

test('B2a boot timings: cache marks are emitted from home.js', () => {
  for (const label of [
    'home-cache-read-started',
    'home-cache-read-completed',
    'home-cache-rendered',
    'home-network-refresh-started',
    'home-network-refresh-completed',
    'home-cache-write-completed',
  ]) {
    assert.match(homeSource, new RegExp(`_bootMark\\('${label}`))
  }
})

test('B2a account isolation: clearUserScopedUi targets the REAL Home container ids', () => {
  const transitionSource = readFileSync(new URL('./account-transition.js', import.meta.url), 'utf8')
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  for (const id of ['recent-finds-list', 'recent-comments-list', 'home-friend-requests-list', 'hstat-obs', 'hstat-sp', 'hstat-spores']) {
    assert.match(transitionSource, new RegExp(`'${id}'`), `${id} must be in the cleared-id lists`)
    assert.match(indexHtml, new RegExp(`id="${id}"`), `${id} must exist in index.html (guards against silent drift)`)
  }
})

test('B2a media seam: persisted image sources never carry protectedUrl or signed URLs', () => {
  const body = _extractFunctionBody(homeSource, 'function _persistableImageSource(')
  assert.equal(/protectedUrl/.test(body), false, 'protectedUrl is session-bound transport state and must not persist')
  assert.match(body, /_durableUrlOrNull\(/)
  const urlGuard = _extractFunctionBody(homeSource, 'function _durableUrlOrNull(')
  assert.match(urlGuard, /token=/)
  assert.ok(urlGuard.includes('object') && urlGuard.includes('sign'), 'signed-path guard must be present')
})
