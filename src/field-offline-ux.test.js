// Focused regression tests for the field-offline UX + reconnect polish
// pass. Exercises: GPS timeout budgets, capability gating around the two
// cached reveal states, the intentional offline i18n wording, the
// queue-read isolation contract that Finds relies on, and the native
// reconnect wiring (single deduped revalidation entry point, COMPLETE-
// transition sync trigger, bounded cached-mode watchdog).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { AUTH_STATE } from './auth-state.js'
import { canPerformCloudMutation } from './capabilities.js'
import { t } from './i18n.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const readSrc = rel => readFileSync(join(__dirname, rel), 'utf8')

function _extractFunctionChunk(source, marker, span = 4000) {
  const idx = source.indexOf(marker)
  assert.ok(idx >= 0, `expected to find ${marker}`)
  return source.slice(idx, idx + span)
}

test('GPS field-capture timeout allows slow offline GNSS (>= 30s)', () => {
  // review.js: the sheet's "Try again" tap in the field save flow.
  const review = readSrc('screens/review.js')
  const reviewMatch = review.match(/requestFreshLocation'\)\(\{[\s\S]*?timeoutMs:\s*(\d[\d_]*)/)
  assert.ok(reviewMatch, 'expected requestFreshLocation call in review.js')
  const reviewTimeout = Number(String(reviewMatch[1]).replace(/_/g, ''))
  assert.ok(reviewTimeout >= 30_000, `review.js timeoutMs should be >= 30000, saw ${reviewTimeout}`)

  // import_review.js: the initial native-camera location request.
  const importReview = readSrc('screens/import_review.js')
  const importMatch = importReview.match(/requestFreshLocation\(\{[\s\S]*?timeoutMs:\s*(\d[\d_]*)/)
  assert.ok(importMatch, 'expected requestFreshLocation call in import_review.js')
  const importTimeout = Number(String(importMatch[1]).replace(/_/g, ''))
  assert.ok(importTimeout >= 30_000, `import_review.js timeoutMs should be >= 30000, saw ${importTimeout}`)
})

test('enableHighAccuracy preserved for the field GPS request', () => {
  const review = readSrc('screens/review.js')
  assert.match(review, /requestFreshLocation'\)\(\{[\s\S]*?enableHighAccuracy:\s*true/)
  const importReview = readSrc('screens/import_review.js')
  assert.match(importReview, /requestFreshLocation\(\{[\s\S]*?enableHighAccuracy:\s*true/)
})

test('geolocation acquisition has NO auth/network capability gate', () => {
  // GPS works in AUTHENTICATED_CACHED (airplane mode). geo.js must gate only
  // on the location preference / internal-override token — never on the
  // auth-state machine, the capability module, or navigator.onLine.
  const geo = readSrc('geo.js')
  assert.equal(/from '\.\/capabilities\.js'/.test(geo), false, 'geo.js must not import capabilities.js')
  assert.equal(/from '\.\/auth-state\.js'/.test(geo), false, 'geo.js must not import auth-state.js')
  assert.equal(/canPerformCloudMutation|canUseAuthenticatedNetwork/.test(geo), false)
  const strippedGeo = geo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.equal(/navigator\.onLine/.test(strippedGeo), false, 'geolocation must not consult navigator.onLine')
})

test('cached / reauth states deny cloud mutation; COMPLETE allows it', () => {
  assert.equal(canPerformCloudMutation(AUTH_STATE.AUTHENTICATED_COMPLETE).allowed, true)
  const cached = canPerformCloudMutation(AUTH_STATE.AUTHENTICATED_CACHED)
  assert.equal(cached.allowed, false)
  assert.equal(cached.reason, 'offline')
  const reauth = canPerformCloudMutation(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED)
  assert.equal(reauth.allowed, false)
  assert.equal(reauth.reason, 'reauth_required')
})

test('intentional offline Finds wording is defined per locale', () => {
  // Verify translations by scanning the i18n source directly so we don't
  // need a DOM to swap locales.
  const i18n = readSrc('i18n.js')
  const requiredKeys = [
    'finds.offlineTitle',
    'finds.offlineQueuedBody',
    'finds.offlineEmptyBody',
    'finds.offlineReauthBody',
    'finds.pendingWaitingConnection',
    'finds.pendingWaitingSignIn',
    'finds.pendingWaitingUpload',
  ]
  for (const key of requiredKeys) {
    const matches = i18n.match(new RegExp(`'${key}':`, 'g')) || []
    assert.ok(matches.length >= 4, `expected ${key} in >=4 locales, saw ${matches.length}`)
  }
  // Default-English `t()` returns the value straight from the map — the
  // spec wording, verbatim.
  assert.equal(t('finds.offlineTitle'), 'Finds offline')
  assert.equal(t('finds.offlineQueuedBody'), 'Saved observations on this device are shown below. Reconnect to load your other Finds.')
  assert.equal(t('finds.offlineEmptyBody'), 'Reconnect to load your Finds. You can still capture new observations while offline.')
  assert.equal(t('finds.offlineReauthBody'), 'Sign in to load your Finds and upload saved observations.')
})

test('the old "Finds aren’t available offline yet" headline is gone', () => {
  const i18n = readSrc('i18n.js')
  assert.equal(/aren’t available offline yet/.test(i18n), false)
  const finds = readSrc('screens/finds.js')
  assert.equal(/offlineCachedTitle|olderRequireConnection/.test(finds), false)
})

test('Finds screen renders the offline shell instead of "Loading…" in cached/reauth', () => {
  const src = readSrc('screens/finds.js')
  assert.match(src, /_isOfflineFindsMode\(\)/)
  assert.match(src, /_renderFindsOfflineShell/)
  // The offline path must short-circuit BEFORE loadFinds sets the
  // "Loading…" placeholder. Extract loadFinds() and enforce ordering there.
  const loadFindsMatch = src.match(/export async function loadFinds\(\)[\s\S]*?\n\}\n/)
  assert.ok(loadFindsMatch, 'expected loadFinds() body')
  const body = loadFindsMatch[0]
  const offlineIdx = body.indexOf('_renderFindsOfflineShell(list')
  const loadingIdx = body.indexOf(`finds-loading-state`)
  assert.ok(offlineIdx > 0 && loadingIdx > 0 && offlineIdx < loadingIdx,
    'loadFinds() must short-circuit to the offline shell before the loading placeholder')
})

test('offline info renders as a contained note, queue cards FIRST', () => {
  const src = readSrc('screens/finds.js')
  // Contained layout class — no raw edge-to-edge text.
  assert.match(src, /finds-offline-note/)
  const css = readSrc('style.css')
  const noteIdx = css.indexOf('.finds-offline-note {')
  assert.ok(noteIdx > 0, 'style.css must style .finds-offline-note')
  const noteChunk = css.slice(noteIdx, noteIdx + 400)
  assert.match(noteChunk, /margin:\s*[^;]*14px/, 'note must share the cards\' 14px horizontal margins')
  assert.match(noteChunk, /border(-radius)?:/, 'note must be a contained block, not a bare paragraph')
  // The old full-width shell class is gone.
  assert.equal(/finds-offline-shell/.test(css), false)
  assert.equal(/finds-offline-shell/.test(src), false)

  // Note-first hierarchy: in the card renderer the offline note is
  // prepended BEFORE the grid html (queue cards render below it).
  const renderChunk = _extractFunctionChunk(src, 'function _renderCards(list, data, options)', 12_000)
  const noteIdx2 = renderChunk.indexOf('_findsOfflineInfoHtml(true)')
  const gridIdx = renderChunk.indexOf("html += '<div class=\"finds-grid-outer\">'")
  const footerIdx = renderChunk.indexOf('_findsFooterHtml(currentScope)')
  assert.ok(noteIdx2 > 0 && gridIdx > noteIdx2 && footerIdx > gridIdx,
    'offline note must be prepended before queue cards + footer')
})

test('offline wording: with-queue vs without-queue bodies are distinct and mode-aware', () => {
  const src = readSrc('screens/finds.js')
  const infoChunk = _extractFunctionChunk(src, 'function _findsOfflineInfoHtml(hasQueueCards)', 1600)
  assert.match(infoChunk, /hasQueueCards\s*\?\s*t\('finds\.offlineQueuedBody'\)\s*:\s*t\('finds\.offlineEmptyBody'\)/)
  assert.match(infoChunk, /finds\.offlineReauthBody/)
  assert.match(infoChunk, /finds\.offlineTitle/)
})

test('offline empty state never shows "No observations yet" and reconnect race shows loading', () => {
  const src = readSrc('screens/finds.js')
  for (const marker of ['function _renderCards(list, data, options)', 'function _renderBySpecies(list, data, options = {})']) {
    const chunk = _extractFunctionChunk(src, marker, 2200)
    const offlineGuardIdx = chunk.indexOf('_isOfflineFindsMode()')
    const syncGuardIdx = chunk.indexOf('hasActiveSyncPass()')
    const emptyTextIdx = chunk.indexOf('_emptyFindsText(')
    assert.ok(offlineGuardIdx > 0 && offlineGuardIdx < emptyTextIdx,
      `${marker}: offline note must take precedence over the generic empty text`)
    assert.ok(syncGuardIdx > 0 && syncGuardIdx < emptyTextIdx,
      `${marker}: an active sync pass must show loading, not "No observations yet"`)
  }
})

test('remote-only Finds controls are disabled offline (scope/status/sort dropdowns)', () => {
  const src = readSrc('screens/finds.js')
  const chunk = _extractFunctionChunk(src, 'function _findsDropdownShouldDisable(key)', 900)
  assert.match(chunk, /_isOfflineFindsMode\(\)/)
  assert.match(chunk, /return true/)
  // The disable machinery applies .is-disabled + button.disabled.
  assert.match(src, /control\.classList\.toggle\('is-disabled', disabled\)/)
  assert.match(src, /button\.disabled = disabled/)
})

test('QUEUE_EVENT listener refreshes Finds offline regardless of scope', () => {
  const src = readSrc('screens/finds.js')
  assert.match(src, /QUEUE_EVENT[\s\S]{0,400}_isOfflineFindsMode/)
})

test('queue cards in cached mode say "Waiting for connection" (retrying items included)', () => {
  const src = readSrc('screens/finds.js')
  const chunk = _extractFunctionChunk(src, 'function _pendingStatusText(obs)', 1400)
  assert.match(chunk, /finds\.pendingWaitingConnection/)
  assert.match(chunk, /finds\.pendingWaitingSignIn/)
  // Only mid-upload and blocked items keep their stage text offline; a
  // stranded 'retrying' item shows the offline wording (no retry can run).
  assert.match(chunk, /stage !== 'blocked' && stage !== 'uploading-image'/)
})

test('sync-queue triggerSync remains gated by canPerformCloudMutation (B2b invariant)', () => {
  const src = readSrc('sync-queue.js')
  assert.match(src, /canPerformCloudMutation\(\)\.allowed/)
})

test('COMPLETE transition is the authoritative upload trigger (same user, cached→complete)', () => {
  const src = readSrc('main.js')
  assert.match(src, /_bindReconnectTriggerToAuthState/)
  assert.match(src, /AUTHENTICATED_COMPLETE[\s\S]{0,400}triggerSync\(\)/)
  // Same-user + was-cached gating.
  const chunk = _extractFunctionChunk(src, 'function _bindReconnectTriggerToAuthState()', 1800)
  assert.match(chunk, /AUTHENTICATED_REAUTH_REQUIRED/)
  assert.match(chunk, /sameUser/)
  assert.match(chunk, /wasCached && sameUser/)
  // Refreshes Finds automatically on reconnect while visible.
  assert.match(src, /state\.currentScreen === 'finds'[\s\S]{0,200}requestFindsRefresh/)
})

test('all connectivity signals converge on ONE deduped revalidation entry point', () => {
  const src = readSrc('main.js')
  // The single entry point exists and routes non-COMPLETE states into the
  // in-flight-guarded revalidation; COMPLETE only nudges the (self-deduping,
  // capability-gated) sync queue.
  const entryChunk = _extractFunctionChunk(src, 'function requestConnectivityRevalidation(reason,', 700)
  assert.match(entryChunk, /AUTHENTICATED_COMPLETE/)
  assert.match(entryChunk, /triggerSync\(\)/)
  assert.match(entryChunk, /_attemptCachedRevalidation\(reason, options\)/)
  // Native monitor funnels into it.
  assert.match(src, /bindNativeNetworkMonitor\(\{\s*onConnectivityRestored: reason => requestConnectivityRevalidation\(reason\)/)
  // Web/window wake-up listeners funnel into it too — bound at module init
  // (QA4) so runtime COMPLETE→CACHED downgrades are covered, not just the
  // cached-boot reveal path.
  const wakeupChunk = _extractFunctionChunk(src, 'function _bindRevalidationWakeupListeners()', 1000)
  assert.match(wakeupChunk, /trigger\('web-online'\)/)
  assert.match(wakeupChunk, /trigger\('focus'\)/)
  assert.match(wakeupChunk, /trigger\('visibility'\)/)
  assert.match(wakeupChunk, /requestConnectivityRevalidation\(reason\)/)
  // The dedupe itself: one in-flight backend revalidation per burst.
  const attemptChunk = _extractFunctionChunk(src, 'async function _attemptCachedRevalidation(source', 700)
  assert.match(attemptChunk, /if \(_cachedRevalidationInFlight\) return/)
})

test('native connectivity is a wake-up only — no capability bypass in main.js wiring', () => {
  const src = readSrc('main.js')
  const entryChunk = _extractFunctionChunk(src, 'function requestConnectivityRevalidation(reason,', 700)
  // In non-COMPLETE states the ONLY action is the revalidation pipeline —
  // no direct upload, no state force.
  const nonCompleteBranch = entryChunk.slice(entryChunk.indexOf('_attemptCachedRevalidation'))
  assert.equal(/setAuthState/.test(nonCompleteBranch), false)
  // triggerSync appears only inside the COMPLETE branch of the entry point.
  const completeIdx = entryChunk.indexOf('AUTHENTICATED_COMPLETE')
  const triggerIdx = entryChunk.indexOf('triggerSync()')
  const attemptIdx = entryChunk.indexOf('_attemptCachedRevalidation')
  assert.ok(completeIdx > 0 && triggerIdx > completeIdx && triggerIdx < attemptIdx)
})

test('cached-mode watchdog (QA4): direct ~15s backend revalidation, NO network-status prerequisite', () => {
  const src = readSrc('main.js')
  const intervalMatch = src.match(/CACHED_WATCHDOG_INTERVAL_MS = (\d[\d_]*)/)
  assert.ok(intervalMatch, 'watchdog interval constant expected')
  const interval = Number(String(intervalMatch[1]).replace(/_/g, ''))
  assert.ok(interval >= 10_000 && interval <= 20_000, `~15s watchdog interval expected, saw ${interval}`)

  const eligibleChunk = _extractFunctionChunk(src, 'function _cachedWatchdogEligible()', 700)
  assert.match(eligibleChunk, /!== AUTH_STATE\.AUTHENTICATED_CACHED\) return false/)
  assert.match(eligibleChunk, /visibilityState !== 'visible'\) return false/)
  assert.match(eligibleChunk, /state\.user\?\.id !== current\.userId\) return false/)

  // Stops when the state leaves AUTHENTICATED_CACHED (COMPLETE / REAUTH /
  // UNAUTHENTICATED / account transition / sign-out) and when hidden —
  // never a permanent COMPLETE or REAUTH poller.
  const bindChunk = _extractFunctionChunk(src, 'function _bindCachedRevalidationWatchdog()', 1000)
  assert.match(bindChunk, /=== AUTH_STATE\.AUTHENTICATED_CACHED\) _armCachedRevalidationWatchdog\(\)/)
  assert.match(bindChunk, /else _stopCachedRevalidationWatchdog\(\)/)

  // THE round-4 invariant: the tick attempts a backend revalidation DIRECTLY.
  // Device QA proved twice that native connectivity state must never be a
  // prerequisite — no Network.getStatus, no checkNativeConnectivityNow, no
  // navigator.onLine, no connected flag before the probe.
  const tickChunk = _extractFunctionChunk(src, 'function _cachedWatchdogTick()', 900)
  assert.match(tickChunk, /requestConnectivityRevalidation\('cached-watchdog'\)/)
  const tickCode = tickChunk
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.equal(/getStatus|checkNativeConnectivityNow|onLine|\bconnected\b/.test(tickCode), false,
    'watchdog tick must not gate the backend probe on any network-status source')

  // Automatic attempts are throttled BELOW the watchdog interval (so ticks
  // are never skipped) and explicit pull-refresh bypasses the throttle.
  const throttleMatch = src.match(/CACHED_REVALIDATION_MIN_RETRY_MS = (\d[\d_]*)/)
  assert.ok(throttleMatch, 'backend revalidation throttle constant expected')
  const throttle = Number(String(throttleMatch[1]).replace(/_/g, ''))
  assert.ok(throttle < interval, 'throttle must be below the watchdog interval')
  const attemptChunk = _extractFunctionChunk(src, 'async function _attemptCachedRevalidation(', 1100)
  assert.match(attemptChunk, /_lastRevalidationAttemptAt < CACHED_REVALIDATION_MIN_RETRY_MS/)
  assert.match(attemptChunk, /force/)
  assert.match(attemptChunk, /USER_INITIATED_REVALIDATION_REASONS\.has\(source\)/)
})

test('queue read API filters by current user id (privacy isolation)', () => {
  // getQueuedObservations enforces owner filtering by both queueKey and
  // queueUserId — Finds must never render user B's queue for user A.
  const src = readSrc('sync-queue.js')
  assert.match(src, /export async function getQueuedObservations\(userId\)/)
  assert.match(src, /itemQueueKey === queueKey \|\| itemQueueUserId === userId/)
})

test('different-user transition cannot sync the prior user\'s queue', () => {
  // Two layers: (1) the reconnect trigger requires prev/last COMPLETE uid to
  // equal the new uid; (2) the sync pass itself blocks items whose
  // queueUserId differs from the authenticated user.
  const main = readSrc('main.js')
  const chunk = _extractFunctionChunk(main, 'function _bindReconnectTriggerToAuthState()', 1800)
  assert.match(chunk, /prevUid === nextUid \|\| _lastAuthCompleteUserId === nextUid/)
  const queue = readSrc('sync-queue.js')
  assert.match(queue, /queueUserId !== authUserId/)
  assert.match(queue, /BLOCKED_QUEUE_REASON/)
})
