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

// The shared trusted reveal implementation both cached entry points delegate
// to (Stage B regression fix: no-session boot + profile-fetch-failed fallback
// converge on ONE implementation).
function _extractCachedRevealBody() {
  return _extractFunctionBody(mainSource, 'async function _revealTrustedCachedShell(')
}

test('Stage B1 cached-boot: the cached path does NOT call refreshHome/refreshHomeSafe (zero online Home hydration)', () => {
  for (const body of [_extractCachedBootBody(), _extractCachedRevealBody()]) {
    assert.equal(/\brefreshHome(?:Safe)?\s*\(/.test(body), false, 'cached boot/reveal must not fire an online Home refresh')
  }
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

test('cached boot classifier: explicit auth rejection MUST NOT enter cached (offline) mode', () => {
  assert.match(mainSource, /_isExplicitAuthRejection\(/)
  // Reauth-recovery fix: a server-confirmed rejection with trusted same-user
  // local data reveals AUTHENTICATED_REAUTH_REQUIRED (Sign in again surface)
  // — never AUTHENTICATED_CACHED, and never a silent fall-through that hides
  // queued local work behind the bare login overlay.
  assert.match(mainSource, /cached_boot_auth_reject_reauth/)
  const bootBody = _extractCachedBootBody()
  const rejectIdx = bootBody.indexOf('cached_boot_auth_reject_reauth')
  assert.ok(rejectIdx > 0)
  const rejectBranch = bootBody.slice(rejectIdx, bootBody.indexOf('return true', rejectIdx))
  assert.match(rejectBranch, /AUTHENTICATED_REAUTH_REQUIRED/)
  assert.doesNotMatch(rejectBranch, /AUTHENTICATED_CACHED/)
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
  // The boundary lives in the single shared reveal implementation, and the
  // no-session boot path must delegate to it.
  const revealBody = _extractCachedRevealBody()
  assert.match(revealBody, /beginAccountTransition\(\)/)
  assert.match(revealBody, /clearUserScopedUi\(\)/)
  assert.match(revealBody, /showAccountTransitionBlocker\(\)/)
  assert.match(revealBody, /isCurrentAccountTransition\(/)
  assert.match(_extractCachedBootBody(), /_revealTrustedCachedShell\(/, 'cached boot must route through the shared reveal')
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
  // The cached Home render lives in the shared reveal so BOTH cached entry
  // points (no-session boot + profile-fetch-failure fallback) get it.
  const body = _extractCachedRevealBody()
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

// ── Stage B FINAL: no global state exposure ──────────────────────────────

test('state.js does NOT publish app state on globalThis (privacy: no session/token/user surface via globals)', async () => {
  // Simply importing state.js must not create any `__sporely*` globals.
  // The prior implementation exposed the full app state as
  // `globalThis.__sporelyState` and a user-id resolver as
  // `globalThis.__sporelyCurrentUserId` — the Task 4 audit replaced them
  // with a normal module import in image-helpers.js.
  await import('./state.js')
  const suspiciousKeys = Object.getOwnPropertyNames(globalThis)
    .filter(name => /^__sporely/i.test(name))
  assert.deepEqual(suspiciousKeys, [], `no __sporely* globals allowed on globalThis, found: ${suspiciousKeys.join(', ')}`)
  // Explicit spot-checks for the two names the prior implementation used.
  assert.equal(typeof globalThis.__sporelyState, 'undefined', '__sporelyState must not exist')
  assert.equal(typeof globalThis.__sporelyCurrentUserId, 'undefined', '__sporelyCurrentUserId must not exist')
})

test('state.js source contains no `_publishSporelyState`-style globalThis publisher', () => {
  const stateSource = readFileSync(new URL('./state.js', import.meta.url), 'utf8')
  assert.equal(/globalThis\.__sporely/.test(stateSource), false, 'state.js must not assign any __sporely* on globalThis')
})

// ── Stage B regression fix: persisted-local-session offline cold start ──────
//
// Device QA showed: sign in online → force-stop → airplane mode → relaunch
// produced the blocking "Could not load your profile. TypeError: Failed to
// fetch" error instead of AUTHENTICATED_CACHED. Cause: getSession() returns
// the locally persisted session offline, so init() takes the ONLINE path and
// skips _tryCachedAuthenticatedBoot entirely. These invariants pin the fix.

function _extractFallbackBody() {
  return _extractFunctionBody(mainSource, 'async function _tryCachedFallbackAfterProfileFetchFailure(')
}

test('offline fallback: profile-fetch failure attempts the trusted cached fallback BEFORE the blocking error surface', () => {
  const body = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  const errorIdx = body.indexOf('if (error) {')
  const fallbackIdx = body.indexOf('_tryCachedFallbackAfterProfileFetchFailure(')
  const errorSurfaceIdx = body.indexOf('_showProfileResolutionError(')
  assert.ok(errorIdx > 0, 'error branch must exist')
  assert.ok(fallbackIdx > errorIdx, 'fallback must be attempted inside the error branch (never on the healthy path)')
  assert.ok(errorSurfaceIdx > fallbackIdx, 'the blocking error surface must only show AFTER the fallback declined')
})

test('offline fallback: ALL five gates present, local gates before the probe, probe before the reveal', () => {
  const body = _extractFallbackBody()
  const rejectIdx = body.indexOf('_isExplicitAuthRejection(error)')
  const transportIdx = body.indexOf('_isTransportSessionError(error)')
  const snapshotIdx = body.indexOf('readLastValidatedAccount()')
  const snapshotUserIdx = body.indexOf('snapshot.userId !== user.id')
  const ownerIdx = body.indexOf('owner !== user.id')
  const probeIdx = body.indexOf('await probe()')
  const revealIdx = body.indexOf('_revealTrustedCachedShell(')
  for (const [label, idx] of [
    ['explicit-rejection gate', rejectIdx],
    ['transport classification gate', transportIdx],
    ['snapshot gate', snapshotIdx],
    ['snapshot same-user gate', snapshotUserIdx],
    ['owner same-user gate', ownerIdx],
    ['reachability probe', probeIdx],
    ['shared reveal', revealIdx],
  ]) {
    assert.ok(idx > 0, `${label} must exist in the fallback`)
  }
  // Synchronous local gates strictly precede the (network) probe; the probe
  // strictly precedes the reveal.
  for (const idx of [rejectIdx, transportIdx, snapshotIdx, snapshotUserIdx, ownerIdx]) {
    assert.ok(idx < probeIdx, 'local gates must run before the reachability probe')
  }
  assert.ok(probeIdx < revealIdx, 'the probe must classify UNREACHABLE before any reveal')
  // Backend reachable → denied (existing blocking error stays).
  assert.match(body, /reachability !== 'unreachable'/)
  // The fallback only ever reveals AUTHENTICATED_CACHED — never REAUTH.
  assert.match(body, /targetState:\s*AUTH_STATE\.AUTHENTICATED_CACHED/)
  assert.equal(/AUTHENTICATED_REAUTH_REQUIRED/.test(body), false, 'the fallback must not select REAUTH_REQUIRED (that state means reachable-without-session)')
})

test('offline fallback: healthy resolution path performs NO reachability probe', () => {
  // The probe is confined to the failure-only helper; neither the main
  // resolve pipeline nor the in-place revalidation may reference it.
  const resolveBody = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  assert.equal(/probeBackendReachability|await probe\(/.test(resolveBody), false, '_resolveAndRouteForUser must never probe — Stage A healthy-path startup must stay probe-free')
  const inPlaceBody = _extractFunctionBody(mainSource, 'async function _revalidateCachedRevealInPlace(')
  assert.equal(/probeBackendReachability|await probe\(/.test(inPlaceBody), false, 'in-place revalidation must not add a probe')
})

test('offline fallback: stale-async safety — generation re-verified after the probe and before the error surface', () => {
  const fallbackBody = _extractFallbackBody()
  const probeIdx = fallbackBody.indexOf('await probe()')
  const staleIdx = fallbackBody.indexOf('isCurrentAccountTransition(')
  assert.ok(staleIdx > probeIdx, 'the fallback must re-verify the account transition AFTER awaiting the probe')
  const revealIdx = fallbackBody.indexOf('_revealTrustedCachedShell(')
  assert.ok(staleIdx < revealIdx, 'the stale check must run BEFORE opening the reveal transition')
  // And the error branch itself re-verifies before painting the blocking
  // error, since the fallback may have awaited.
  const resolveBody = _extractFunctionBody(mainSource, 'async function _resolveAndRouteForUser(')
  const fallbackCallIdx = resolveBody.indexOf('_tryCachedFallbackAfterProfileFetchFailure(')
  const errorSurfaceIdx = resolveBody.indexOf('_showProfileResolutionError(')
  const recheck = resolveBody.slice(fallbackCallIdx, errorSurfaceIdx)
  assert.match(recheck, /isCurrentAccountTransition\(/, 'the error surface must be guarded by a post-fallback staleness check')
})

test('offline fallback: single shared cached-reveal implementation (no duplication)', () => {
  // Both entry points delegate to _revealTrustedCachedShell...
  assert.match(_extractCachedBootBody(), /_revealTrustedCachedShell\(/)
  assert.match(_extractFallbackBody(), /_revealTrustedCachedShell\(/)
  // ...and the reveal-only responsibilities appear exactly once in main.js:
  // the cached header paint and the revalidation scheduling are owned by the
  // shared reveal, not re-implemented per entry point.
  const headerCalls = mainSource.match(/renderCachedHeaderProfileButtons\(snapshot/g) || []
  assert.equal(headerCalls.length, 1, 'exactly one cached-header paint site (inside the shared reveal)')
  const scheduleCalls = mainSource.match(/(?<!function )_scheduleCachedRevalidation\(\{/g) || []
  assert.equal(scheduleCalls.length, 1, 'exactly one revalidation-scheduling site (inside the shared reveal) — no new reconnect mechanism')
})

test('offline fallback: cached fallback status is NOT a success status (reconnect re-runs the full pipeline)', () => {
  assert.match(mainSource, /CACHED_OFFLINE_FALLBACK:\s*'cached-offline-fallback'/)
  // _resolvedUsers gating must remain restricted to the two success statuses
  // so a later same-user session (reconnect) still resolves in place.
  const resolveOnce = _extractFunctionBody(mainSource, 'export function resolveAuthenticatedSessionOnce(')
  assert.match(resolveOnce, /'complete-home'/)
  assert.match(resolveOnce, /'incomplete-profile-setup'/)
  assert.equal(/cached-offline-fallback/.test(resolveOnce), false, 'cached fallback must never mark the user as resolved')
})

test('offline fallback: reveal drives the Offline pill from the target state (CACHED shows, REAUTH hides)', () => {
  const revealBody = _extractCachedRevealBody()
  assert.match(revealBody, /_setOfflineIndicator\(_shouldShowOfflineIndicatorForState\(targetState\)\)/)
  assert.equal(/_setOfflineIndicator\(true\)/.test(revealBody), false, 'the reveal must not force the pill on unconditionally')
})
