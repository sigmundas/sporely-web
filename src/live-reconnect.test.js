// QA round 3 — live reconnect while the process stays alive.
//
// Device result: cold-start reconnect worked, but restoring connectivity in
// a running CACHED app did nothing until a force-close. Root causes covered
// here:
//   * navigator.onLine (stale on Android WebViews) was still a hard gate on
//     queue processing and retry scheduling,
//   * native connectivity events were edge-dependent (a lost false event
//     suppressed the next true event),
//   * the cached watchdog probed conditionally instead of polling the local
//     OS status,
//   * pull-to-refresh while CACHED had no recovery semantics,
//   * the Offline pill and the header Sync tag could render simultaneously,
//   * a second consecutive capture session could stay on "Finding
//     location…" forever (GNSS watch never errors on Android).

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  NATIVE_NETWORK_LOSS_REASON,
  NATIVE_NETWORK_REASON,
  bindNativeNetworkMonitor,
  unbindNativeNetworkMonitor,
  checkNativeConnectivityNow,
} from './native-network.js'
import { state } from './state.js'
import {
  LOCATION_FRESH_FIX_ACQUISITION_TIMEOUT_MS,
  beginCaptureLocationSession,
  endCaptureLocationSession,
  setLocationPreference,
  startLocationWatch,
  stopLocationWatch,
} from './geo.js'
import { CONNECTIVITY_REVALIDATION_REQUEST_EVENT } from './screens/finds.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const readSrc = rel => readFileSync(join(__dirname, rel), 'utf8')

function _stripComments(source) {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

// ── Native OS status poll (watchdog backend) ────────────────────────────────

function makeFakeNetwork({ initialConnected = false } = {}) {
  const listeners = new Map()
  return {
    status: { connected: initialConnected, connectionType: 'wifi' },
    async getStatus() { return { ...this.status } },
    async addListener(event, cb) {
      listeners.set(event, cb)
      return { remove: async () => { listeners.delete(event) } }
    },
    emit(event, payload) { const cb = listeners.get(event); if (cb) cb(payload) },
  }
}

function makeFakeDocument() {
  const listeners = new Map()
  return {
    visibilityState: 'visible',
    addEventListener(event, cb) { listeners.set(event, cb) },
    removeEventListener(event) { listeners.delete(event) },
  }
}

async function withMonitor(fn) {
  await unbindNativeNetworkMonitor()
  try { await fn() } finally { await unbindNativeNetworkMonitor() }
}

test('checkNativeConnectivityNow: getStatus false → loss only, zero restore wake-up', async () => {
  await withMonitor(async () => {
    const restored = []
    const lost = []
    const network = makeFakeNetwork({ initialConnected: false })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: r => restored.push(r),
      onConnectivityLost: r => lost.push(r),
      network,
      app: {},
      native: true,
      documentRef: makeFakeDocument(),
    })
    const connected = await checkNativeConnectivityNow()
    assert.equal(connected, false)
    assert.deepEqual(restored, [], 'disconnected status must not wake revalidation')
    assert.deepEqual(lost, [NATIVE_NETWORK_LOSS_REASON.RESUME_STATUS])
  })
})

test('checkNativeConnectivityNow: getStatus true → exactly the deduped restore wake-up', async () => {
  await withMonitor(async () => {
    const restored = []
    const lost = []
    const network = makeFakeNetwork({ initialConnected: true })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: r => restored.push(r),
      onConnectivityLost: r => lost.push(r),
      network,
      app: {},
      native: true,
      documentRef: makeFakeDocument(),
    })
    const connected = await checkNativeConnectivityNow()
    assert.equal(connected, true)
    assert.deepEqual(restored, [NATIVE_NETWORK_REASON.RESUME_STATUS])
    assert.deepEqual(lost, [])
  })
})

test('checkNativeConnectivityNow: unbound monitor fails soft (null, no callbacks)', async () => {
  await withMonitor(async () => {
    assert.equal(await checkNativeConnectivityNow(), null)
  })
})

// ── navigator.onLine must not gate the queue ────────────────────────────────

test('QA3: navigator.onLine is not consulted anywhere in sync-queue.js (code, not comments)', () => {
  const stripped = _stripComments(readSrc('sync-queue.js'))
  assert.equal(/navigator\.onLine/.test(stripped), false,
    'stale WebView onLine must never gate queue processing, retry scheduling, or keepalive')
})

test('QA3: mid-pass halt uses the capability gate, not navigator.onLine', () => {
  const queue = readSrc('sync-queue.js')
  const idx = queue.indexOf('for (const item of items) {')
  assert.ok(idx > 0)
  const chunk = queue.slice(idx, idx + 300)
  assert.match(chunk, /if \(!canPerformCloudMutation\(\)\.allowed\) break/)
})

test('QA3: retry scheduling works regardless of onLine (only the timer guards)', () => {
  const queue = readSrc('sync-queue.js')
  const idx = queue.indexOf('function _scheduleSyncRetry()')
  const chunk = _stripComments(queue.slice(idx, idx + 900))
  assert.match(chunk, /if \(_retryTimer\) return/)
  assert.equal(/onLine/.test(chunk), false)
})

// ── Pull-to-refresh while CACHED = manual recovery signal ──────────────────

test('QA3: Finds pull-refresh in offline mode dispatches the revalidation-request event', () => {
  const finds = readSrc('screens/finds.js')
  const idx = finds.indexOf('async function _refreshFindsFeed()')
  assert.ok(idx > 0)
  const chunk = finds.slice(idx, idx + 700)
  assert.match(chunk, /_isOfflineFindsMode\(\)/)
  assert.match(chunk, /_requestManualConnectivityRevalidation\('finds-pull-refresh'\)/)
  assert.equal(CONNECTIVITY_REVALIDATION_REQUEST_EVENT, 'sporely-connectivity-revalidation-request')
})

test('QA3: main.js routes the pull-refresh event through the gated revalidation entry point', () => {
  const main = readSrc('main.js')
  assert.match(main, /addEventListener\(CONNECTIVITY_REVALIDATION_REQUEST_EVENT/,
    'main.js must listen for the manual recovery event')
  const idx = main.indexOf('addEventListener(CONNECTIVITY_REVALIDATION_REQUEST_EVENT')
  const chunk = main.slice(idx, idx + 300)
  assert.match(chunk, /requestConnectivityRevalidation\(/,
    'pull-refresh must converge on the SAME deduped, capability-gated pipeline')
  // The user-initiated reason may bypass the retry THROTTLE but never the
  // auth/capability gates: _attemptCachedRevalidation still requires a
  // cached/reauth state and the full probe + session + resolve pipeline.
  const attemptIdx = main.indexOf('async function _attemptCachedRevalidation(')
  const attemptChunk = main.slice(attemptIdx, attemptIdx + 900)
  assert.match(attemptChunk, /if \(!cachedStates\.has\(current\.state\)\) return/)
})

// ── Offline / Sync header chip precedence ───────────────────────────────────

test('QA3: Offline pill supersedes the header Sync tag (never both)', () => {
  const main = readSrc('main.js')
  const idx = main.indexOf('function _setOfflineIndicator(')
  const chunk = main.slice(idx, idx + 900)
  assert.match(chunk, /header-sync-tag/)
  assert.match(chunk, /display = 'none'/)

  const home = readSrc('screens/home.js')
  const syncIdx = home.indexOf('async function checkSyncStatus()')
  const syncChunk = home.slice(syncIdx, syncIdx + 800)
  assert.match(syncChunk, /AUTHENTICATED_COMPLETE/)
  assert.match(syncChunk, /display = 'none'/,
    'non-COMPLETE states must hide the Sync tag (and skip the Supabase probe)')
})

// ── GPS: second consecutive capture session must not stay "Finding location…" ──

function _resetGeoState() {
  state.location = {
    preference: 'enabled',
    capability: 'unknown',
    permission: 'unknown',
    status: 'idle',
    fix: null,
    error: null,
    watchId: null,
  }
  state.captureSessionLocation = {
    fix: null,
    sessionStartAt: null,
    requestingFreshFix: false,
    captureWindowEndAt: null,
  }
}

let _geoRestore = []
function _setGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  _geoRestore.push(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  })
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

function _installGeoEnv(geolocation) {
  _setGlobal('window', { dispatchEvent() { return true } })
  _setGlobal('document', {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
  })
  _setGlobal('navigator', {
    geolocation,
    permissions: { query: async () => ({ state: 'granted' }) },
  })
}

afterEach(() => {
  try { endCaptureLocationSession() } catch (_) { /* env torn down */ }
  try { stopLocationWatch() } catch (_) { /* env torn down */ }
  _resetGeoState()
  while (_geoRestore.length) {
    const restore = _geoRestore.pop()
    try { restore() } catch (_) { /* already restored */ }
  }
})

test('GPS QA3: capture A gets a fix, capture B times out cleanly (no eternal "Finding location…")', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let nextWatchId = 100
  const watchers = new Map()
  _installGeoEnv({
    watchPosition(success, error) {
      const id = ++nextWatchId
      watchers.set(id, { success, error })
      return id
    },
    getCurrentPosition() {},
    clearWatch(id) { watchers.delete(id) },
  })
  _resetGeoState()
  setLocationPreference('enabled')

  // Capture session A: watch delivers a valid fix.
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true })
  const watchA = state.location.watchId
  assert.ok(watchA != null)
  assert.equal(state.captureSessionLocation.requestingFreshFix, true)
  watchers.get(watchA).success({
    coords: { latitude: 63.4, longitude: 10.4, accuracy: 100, altitude: 40 },
    timestamp: Date.now(),
  })
  assert.equal(state.location.status, 'fix')
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)

  // Save → session A ends. Session B: fresh request, GNSS never calls back.
  endCaptureLocationSession()
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true })
  const watchB = state.location.watchId
  assert.ok(watchB != null && watchB !== watchA, 'session B must own a fresh watch')
  assert.equal(state.location.status, 'locating')
  assert.equal(state.captureSessionLocation.requestingFreshFix, true)

  // The configured acquisition timeout elapses with no fix and no error
  // callback (observed Android behavior): the UI must leave the locating
  // state — never remain on "Finding location…" indefinitely.
  t.mock.timers.tick(LOCATION_FRESH_FIX_ACQUISITION_TIMEOUT_MS + 1)
  assert.equal(state.captureSessionLocation.requestingFreshFix, false,
    'requestingFreshFix must clear at the acquisition timeout')
  assert.notEqual(state.location.status, 'locating')
  assert.equal(state.location.error?.kind, 'timeout')
  // The watch keeps listening for a late same-session fix; Save was never
  // blocked on any of this (no coordinates → Save proceeds without GPS).
  assert.equal(state.location.watchId, watchB)
})

test('GPS QA3: a timed-out session-A supervisor cannot mutate session B state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let nextWatchId = 500
  const watchers = new Map()
  _installGeoEnv({
    watchPosition(success, error) {
      const id = ++nextWatchId
      watchers.set(id, { success, error })
      return id
    },
    getCurrentPosition() {},
    clearWatch(id) { watchers.delete(id) },
  })
  _resetGeoState()
  setLocationPreference('enabled')

  // Session A: fresh-fix watch armed, never resolves.
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true })

  // Session A ends (Save) before its acquisition timeout; session B starts
  // and receives a valid fix.
  endCaptureLocationSession()
  beginCaptureLocationSession()
  await startLocationWatch({ requestFreshFix: true })
  const watchB = state.location.watchId
  watchers.get(watchB).success({
    coords: { latitude: 59.9, longitude: 10.7, accuracy: 12, altitude: 8 },
    timestamp: Date.now(),
  })
  assert.equal(state.location.status, 'fix')

  // Any stale session-A timer firing later must not flip session B's state.
  t.mock.timers.tick(LOCATION_FRESH_FIX_ACQUISITION_TIMEOUT_MS * 2)
  assert.equal(state.location.status, 'fix')
  assert.equal(state.location.error, null)
  assert.equal(state.captureSessionLocation.requestingFreshFix, false)
})

// ── QA round 4: network status is a hint, never a prerequisite ──────────────

test('QA4: watchdog tick attempts backend revalidation with NO network-status prerequisite', () => {
  const main = readSrc('main.js')
  const idx = main.indexOf('function _cachedWatchdogTick()')
  assert.ok(idx > 0)
  const code = main.slice(idx, idx + 900)
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
  // Even with Network.getStatus stuck at connected=false, a lost
  // networkStatusChange event, or stale navigator.onLine=false, the watchdog
  // alone must recover: it calls the revalidation entry point directly.
  assert.match(code, /requestConnectivityRevalidation\('cached-watchdog'\)/)
  assert.equal(/getStatus|checkNativeConnectivityNow|onLine|\bconnected\b/.test(code), false,
    'no network-status source may gate the probe')
})

test('QA4: watchdog interval ~15s; automatic throttle below it; force bypass for pull-refresh', () => {
  const main = readSrc('main.js')
  const interval = Number(String(main.match(/CACHED_WATCHDOG_INTERVAL_MS = (\d[\d_]*)/)[1]).replace(/_/g, ''))
  const throttle = Number(String(main.match(/CACHED_REVALIDATION_MIN_RETRY_MS = (\d[\d_]*)/)[1]).replace(/_/g, ''))
  assert.ok(interval >= 10_000 && interval <= 20_000, `~15s expected, saw ${interval}`)
  assert.ok(throttle < interval, 'throttle must not skip watchdog ticks')
  const attemptIdx = main.indexOf('async function _attemptCachedRevalidation(')
  const attemptChunk = main.slice(attemptIdx, attemptIdx + 1100)
  assert.match(attemptChunk, /\{ force = false \}/)
  assert.match(attemptChunk, /if \(!force\b/)
})

test('QA4: pull-refresh dispatches force:true so recovery is immediate even after a failed auto attempt', () => {
  const finds = readSrc('screens/finds.js')
  const idx = finds.indexOf('function _requestManualConnectivityRevalidation(')
  const chunk = finds.slice(idx, idx + 700)
  assert.match(chunk, /force:\s*true/)
  const chunkCode = chunk.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
  assert.equal(/getStatus|onLine/.test(chunkCode), false, 'pull-refresh must probe directly, no status prerequisite')

  const main = readSrc('main.js')
  const listenIdx = main.indexOf('addEventListener(CONNECTIVITY_REVALIDATION_REQUEST_EVENT')
  const listenChunk = main.slice(listenIdx, listenIdx + 400)
  assert.match(listenChunk, /force: event\?\.detail\?\.force === true/)
})

test('QA4: revalidation wake-up listeners bind at module init (runtime downgrade is covered)', () => {
  const main = readSrc('main.js')
  assert.match(main, /function _bindRevalidationWakeupListeners\(\)/)
  assert.match(main, /\n_bindRevalidationWakeupListeners\(\)/,
    'listeners must bind at boot, not only inside the cached-boot reveal path')
  const idx = main.indexOf('function _bindRevalidationWakeupListeners()')
  const chunk = main.slice(idx, idx + 900)
  assert.match(chunk, /'online'/)
  assert.match(chunk, /'focus'/)
  assert.match(chunk, /visibilitychange/)
})

test('QA4: watchdog never polls in COMPLETE or REAUTH_REQUIRED; stops when hidden', () => {
  const main = readSrc('main.js')
  const idx = main.indexOf('function _cachedWatchdogEligible()')
  const chunk = main.slice(idx, idx + 700)
  assert.match(chunk, /!== AUTH_STATE\.AUTHENTICATED_CACHED\) return false/,
    'only AUTHENTICATED_CACHED is eligible — COMPLETE / REAUTH / UNAUTHENTICATED all stop the loop')
  assert.match(chunk, /visibilityState !== 'visible'\) return false/)
  const bindIdx = main.indexOf('function _bindCachedRevalidationWatchdog()')
  const bindChunk = main.slice(bindIdx, bindIdx + 1000)
  assert.match(bindChunk, /else _stopCachedRevalidationWatchdog\(\)/)
})

test('QA4: native connected=true remains the FAST PATH (immediate revalidation, no getStatus re-query)', async () => {
  await withMonitor(async () => {
    const restored = []
    let getStatusCalls = 0
    const listeners = new Map()
    const network = {
      status: { connected: false, connectionType: 'none' },
      async getStatus() { getStatusCalls += 1; return { ...this.status } },
      async addListener(event, cb) {
        listeners.set(event, cb)
        return { remove: async () => { listeners.delete(event) } }
      },
    }
    await bindNativeNetworkMonitor({
      onConnectivityRestored: r => restored.push(r),
      network,
      app: {},
      native: true,
      documentRef: makeFakeDocument(),
    })
    const callsAfterBind = getStatusCalls // bind performs one seed query
    listeners.get('networkStatusChange')({ connected: true, connectionType: 'wifi' })
    assert.deepEqual(restored, [NATIVE_NETWORK_REASON.NETWORK_CHANGE])
    assert.equal(getStatusCalls, callsAfterBind, 'the event handler must not re-query getStatus')
  })
})

// ── QA round 5 — cached reconnect no-op regression ─────────────────────────
//
// Runtime device behavior observed on `main`:
//   1. cold start online → AUTHENTICATED_COMPLETE (userId added to
//      `_resolvedUsers`),
//   2. airplane mode → COMPLETE → AUTHENTICATED_CACHED (`handleConnectivityLost`
//      downgrade; `_resolvedUsers` is deliberately untouched),
//   3. airplane off → round-4 watchdog probes the backend, refreshes the
//      Supabase session, calls `resolveAuthenticatedSessionOnce` with the same
//      user,
//   4. the resolver's dedupe saw `_resolvedUsers.has(user.id)` AND state !==
//      RESOLVING / UNAUTHENTICATED → returned `{ status: 'noop' }`,
//   5. `_resolveAndRouteForUser` was never entered → in-place revalidation
//      never ran → app stayed CACHED until force-quit cleared the in-memory
//      set.
//
// The fix is a semantic tightening of the dedupe: only skip when the current
// auth state is *terminally resolved* (COMPLETE / INCOMPLETE) for the same
// user. CACHED / REAUTH_REQUIRED must fall through so
// `_revalidateCachedRevealInPlace` runs. The behavioral truth table is
// covered by unit tests on the pure `isUserAlreadyResolved` predicate (see
// `auth-state.test.js`); the tests below pin the wiring in production code.

test('QA5: resolveAuthenticatedSessionOnce dedupes via the pure isUserAlreadyResolved predicate', () => {
  const main = readSrc('main.js')
  // The pure predicate is imported from auth-state.js — main.js does not
  // maintain its own copy of the "may this user be skipped?" logic.
  assert.match(main, /import\s*\{[^}]*\bisUserAlreadyResolved\b[^}]*\}\s*from\s*'\.\/auth-state\.js'/,
    'main.js must import isUserAlreadyResolved from auth-state.js')

  // Extract the resolver body and confirm it delegates to the predicate.
  const sig = 'export function resolveAuthenticatedSessionOnce('
  const startIdx = main.indexOf(sig)
  assert.ok(startIdx > 0, 'resolveAuthenticatedSessionOnce must exist')
  const braceIdx = main.indexOf('{', main.indexOf(')', startIdx))
  let depth = 1
  let i = braceIdx + 1
  while (i < main.length && depth > 0) {
    const c = main[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) break
    i++
  }
  const body = main.slice(braceIdx, i + 1)

  assert.match(body, /isUserAlreadyResolved\(\s*user\.id\s*,\s*_resolvedUsers\s*,\s*currentAuth\s*\)/,
    'resolver must call the pure predicate rather than open-code the check')

  // The old open-coded dedupe (state !== RESOLVING && state !== UNAUTHENTICATED)
  // must NOT reappear — that was the buggy formulation the round-5 fix removed.
  const stripped = _stripComments(body)
  assert.equal(/state\s*!==\s*AUTH_STATE\.RESOLVING/.test(stripped), false,
    'the buggy "not RESOLVING and not UNAUTHENTICATED" dedupe must not return — CACHED/REAUTH would slip through again')

  // In-flight single-flight protection is preserved.
  assert.match(body, /_resolutionInFlight\.get\(user\.id\)/)
  assert.match(body, /_resolutionInFlight\.set\(user\.id/)
  assert.match(body, /_resolutionInFlight\.delete\(user\.id\)/)
})

test('QA5: _resolveAndRouteForUser routes CACHED / REAUTH same-user reconnects into in-place revalidation', () => {
  const main = readSrc('main.js')
  const sig = 'async function _resolveAndRouteForUser('
  const startIdx = main.indexOf(sig)
  assert.ok(startIdx > 0, '_resolveAndRouteForUser must exist')
  // Take a generous slice covering the entry-branch — the branch runs before
  // any beginAccountTransition() so the visible cached Home is not blanked.
  const chunk = main.slice(startIdx, startIdx + 1600)
  assert.match(chunk, /AUTH_STATE\.AUTHENTICATED_CACHED/, 'CACHED must be recognized as the in-place branch trigger')
  assert.match(chunk, /AUTH_STATE\.AUTHENTICATED_REAUTH_REQUIRED/, 'REAUTH_REQUIRED must be recognized as the in-place branch trigger')
  assert.match(chunk, /_revalidateCachedRevealInPlace\(user\)/,
    'CACHED / REAUTH same-user reconnects must be handled by _revalidateCachedRevealInPlace before the transition boundary')
})

test('QA5: watchdog reconnect for a same-user CACHED shell reaches the resolver (no early return)', () => {
  const main = readSrc('main.js')
  // The cached-revalidation trigger (the watchdog tick and the wake-up hints)
  // must funnel through resolveAuthenticatedSessionOnce with a
  // `cached_revalidation:` source. Round-5: this call MUST NOT be short-
  // circuited by the resolver's dedupe when state is CACHED — the previous
  // test asserts the predicate; this test pins the call site.
  assert.match(main, /await\s+resolveAuthenticatedSessionOnce\(\s*session\s*,\s*`cached_revalidation:\$\{source\}`\s*\)/,
    'cached revalidation must call resolveAuthenticatedSessionOnce with a cached_revalidation source tag')
})

test('QA5: handleConnectivityLost does not clear _resolvedUsers (fix belongs in the resolver, not the loss handler)', () => {
  const main = readSrc('main.js')
  const sig = 'export function handleConnectivityLost('
  const startIdx = main.indexOf(sig)
  assert.ok(startIdx > 0, 'handleConnectivityLost must exist')
  const braceIdx = main.indexOf('{', main.indexOf(')', startIdx))
  let depth = 1
  let i = braceIdx + 1
  while (i < main.length && depth > 0) {
    const c = main[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0) break
    i++
  }
  const body = main.slice(braceIdx, i + 1)
  assert.equal(/_resolvedUsers\.(delete|clear)\(/.test(body), false,
    'do not paper over the invariant by clearing _resolvedUsers on connectivity loss — the resolver dedupe must be state-aware')
})
