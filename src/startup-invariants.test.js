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

function _extractCachedBootBody() {
  const startIdx = mainSource.indexOf('async function _tryCachedAuthenticatedBoot(')
  assert.ok(startIdx > 0, 'cached-boot function must exist')
  // Skip past the parameter list first so a destructuring `{ ... }` in the
  // signature does not confuse the balanced walk that follows.
  let paren = mainSource.indexOf('(', startIdx)
  let pdepth = 1
  let j = paren + 1
  while (j < mainSource.length && pdepth > 0) {
    const c = mainSource[j]
    if (c === '(') pdepth++
    else if (c === ')') pdepth--
    if (pdepth === 0) break
    j++
  }
  const braceIdx = mainSource.indexOf('{', j)
  let depth = 1
  let i = braceIdx + 1
  while (i < mainSource.length && depth > 0) {
    const c = mainSource[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) break
    i++
  }
  return mainSource.slice(braceIdx, i + 1)
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
  const persistIdx = mainSource.indexOf('_persistLastValidatedAccountSnapshot(')
  assert.ok(persistIdx > 0, 'snapshot writer must be called from _resolveAndRouteForUser')
  const revealIdx = mainSource.indexOf('hideAccountTransitionBlocker()')
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
