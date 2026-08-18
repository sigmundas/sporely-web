// Stage B device-QA regression fix — persisted-local-session offline cold
// start. Device sequence: sign in online → warm caches → force-stop →
// airplane mode → relaunch. `supabase.auth.getSession()` returns the locally
// persisted session offline, so init() takes the ONLINE resolution path and
// the profile fetch fails with "TypeError: Failed to fetch" — previously
// surfacing the blocking profile-resolution error instead of the cached
// shell.
//
// These tests mirror main.js's `_resolveAndRouteForUser` error branch and
// `_tryCachedFallbackAfterProfileFetchFailure` gate order EXACTLY (the
// structural tests in startup-invariants.test.js pin the production code to
// the same order), while using the REAL modules for everything that can run
// in Node: last-validated-account, local-data-owner, auth-classification
// (classifiers + reachability probe), account-transition generations,
// auth-state machine and the capability gate.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearLastValidatedAccount,
  readLastValidatedAccount,
  writeLastValidatedAccount,
} from './last-validated-account.js'
import { clearLocalDataOwner, getLocalDataOwner, setLocalDataOwner } from './local-data-owner.js'
import {
  isExplicitAuthRejection,
  isTransportSessionError,
  probeBackendReachability,
} from './auth-classification.js'
import {
  beginAccountTransition,
  currentAccountGeneration,
  isCurrentAccountTransition,
  _resetForTests as resetAccountTransitions,
} from './account-transition.js'
import {
  AUTH_STATE,
  getAuthState,
  setAuthState,
  subscribeAuthState,
  _resetAuthStateForTests,
} from './auth-state.js'
import { canUseAuthenticatedNetwork } from './capabilities.js'

const USER_A = 'user-aaaa-1111'
const USER_B = 'user-bbbb-2222'

function memStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
  }
}

function writeSnapshotFor(userId, storage) {
  writeLastValidatedAccount({
    userId,
    email: `${userId}@example.com`,
    profileComplete: true,
    profileSummary: { username: 'alice', display_name: 'Alice', avatar_url: null },
    cloudPlan: { cloudPlan: 'pro', hasProAccess: true, _source: 'CACHED' },
  }, storage)
}

// The exact error shape supabase-js/postgrest-js produces when the WebView's
// fetch throws offline (observed verbatim in Android device QA).
function offlineProfileError() {
  return { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }
}

// fetch stubs driving the REAL probeBackendReachability classification.
const fetchUnreachable = async () => { throw new TypeError('Failed to fetch') }
const fetchReachable = async () => ({ status: 200 })

// ── Mirror of main.js `_tryCachedFallbackAfterProfileFetchFailure` ─────────
// Gate order MUST match production: rejection → transport → snapshot →
// snapshot-user → owner → probe → staleness → shared reveal.
async function orchestrateCachedFallback({ user, error, storage, generation, probe, probeCalls, reveal }) {
  if (!user?.id) return 'denied'
  if (isExplicitAuthRejection(error)) return 'denied'
  if (!isTransportSessionError(error)) return 'denied'
  const snapshot = readLastValidatedAccount(storage)
  if (!snapshot) return 'denied'
  if (snapshot.userId !== user.id) return 'denied'
  const owner = getLocalDataOwner(storage)
  if (!owner || owner !== user.id) return 'denied'
  probeCalls.count += 1
  let reachability
  try { reachability = await probe() } catch { reachability = 'unreachable' }
  if (reachability !== 'unreachable') return 'denied'
  if (!isCurrentAccountTransition(generation, user.id, user.id)) return 'stale'
  return reveal({ snapshot, targetState: AUTH_STATE.AUTHENTICATED_CACHED, reachability })
}

// ── Mirror of main.js `_revealTrustedCachedShell` ───────────────────────────
// The single shared cached-reveal: header from snapshot, state → target,
// reveal, cached-only Home render, existing revalidation scheduler. ZERO
// online Home hydration.
function makeSharedReveal({ events, counters }) {
  return ({ snapshot, targetState }) => {
    beginAccountTransition()
    events.push('render-cached-header')
    setAuthState({ state: targetState, userId: snapshot.userId })
    events.push('reveal-shell')
    counters.cachedHomeRenders += 1 // renderHomeFromCache — strictly local
    events.push('render-home-from-cache')
    events.push('schedule-cached-revalidation') // existing scheduler, no new mechanism
    return 'revealed'
  }
}

// ── Mirror of main.js `_resolveAndRouteForUser` (initial boot slice) ────────
async function orchestrateInitialResolution({ session, fetchProfile, storage, probe }) {
  const events = []
  const counters = { cachedHomeRenders: 0, homeNetworkRefreshes: 0 }
  const probeCalls = { count: 0 }
  const reveal = makeSharedReveal({ events, counters })
  const user = session.user

  const generation = beginAccountTransition()
  const { profile, error } = await fetchProfile(user.id)
  if (error) {
    const fallback = await orchestrateCachedFallback({ user, error, storage, generation, probe, probeCalls, reveal })
    if (fallback === 'revealed') {
      return { status: 'cached-offline-fallback', events, counters, probeCalls }
    }
    if (fallback === 'stale') return { status: 'stale', events, counters, probeCalls }
    events.push('profile-resolution-error-shown')
    return { status: 'profile-fetch-failed', events, counters, probeCalls }
  }
  // COMPLETE branch (unchanged Stage A/B path): header → reveal → exactly one
  // online Home refresh. No probe anywhere on this path.
  assert.ok(profile, 'complete branch requires a profile')
  events.push('refresh-header-online')
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: user.id })
  events.push('reveal-shell')
  counters.homeNetworkRefreshes += 1
  events.push('refresh-home-online')
  return { status: 'complete-home', events, counters, probeCalls }
}

// ── Mirror of main.js `_revalidateCachedRevealInPlace` (reconnect) ─────────
async function orchestrateInPlaceRevalidation({ user, fetchProfile, counters, events }) {
  const generation = currentAccountGeneration()
  const { profile, error } = await fetchProfile(user.id)
  if (!isCurrentAccountTransition(generation, user.id, user.id)) return { status: 'stale' }
  if (error) return { status: 'cached-revalidation-deferred' }
  assert.ok(profile)
  events.push('refresh-header-online')
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: user.id })
  counters.homeNetworkRefreshes += 1
  events.push('refresh-home-online')
  return { status: 'complete-home' }
}

function freshWorld({ snapshotUser = USER_A, ownerUser = USER_A } = {}) {
  resetAccountTransitions()
  _resetAuthStateForTests()
  const storage = memStorage()
  if (snapshotUser) writeSnapshotFor(snapshotUser, storage)
  if (ownerUser) setLocalDataOwner(ownerUser, storage)
  return { storage }
}

// Mirrors main.js `_shouldShowOfflineIndicatorForState` + the boot-bound
// subscription that drives the pill.
function bindOfflinePillMirror() {
  const pill = { visible: false }
  const unsubscribe = subscribeAuthState(next => {
    pill.visible = next?.state === AUTH_STATE.AUTHENTICATED_CACHED
  })
  return { pill, unsubscribe }
}

// 1. Local session user A + valid A snapshot/owner + transport failure +
//    probe unreachable → AUTHENTICATED_CACHED revealed.
test('scenario 1: offline cold start with persisted local session reveals AUTHENTICATED_CACHED', async () => {
  const { storage } = freshWorld()
  const result = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
  })
  assert.equal(result.status, 'cached-offline-fallback')
  assert.equal(getAuthState().state, AUTH_STATE.AUTHENTICATED_CACHED)
  assert.equal(getAuthState().userId, USER_A)
  assert.ok(result.events.includes('render-cached-header'))
  assert.ok(result.events.includes('reveal-shell'))
})

// 2. Same scenario → cached Home path used, no profile-resolution error
//    overlay, zero Home network hydration, Offline pill shown.
test('scenario 2: fallback uses the cached Home path with zero network hydration and no error overlay', async () => {
  const { storage } = freshWorld()
  const { pill, unsubscribe } = bindOfflinePillMirror()
  try {
    const result = await orchestrateInitialResolution({
      session: { user: { id: USER_A, email: 'a@example.com' } },
      fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
      storage,
      probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
    })
    assert.equal(result.status, 'cached-offline-fallback')
    assert.ok(result.events.includes('render-home-from-cache'), 'cached Home render must run')
    assert.ok(result.events.includes('schedule-cached-revalidation'), 'existing revalidation scheduler must be reused')
    assert.equal(result.events.includes('profile-resolution-error-shown'), false, 'no blocking profile error on the offline path')
    assert.equal(result.counters.homeNetworkRefreshes, 0, 'ZERO Home network hydration in cached mode')
    assert.equal(result.counters.cachedHomeRenders, 1)
    assert.equal(pill.visible, true, 'Offline pill must be shown in AUTHENTICATED_CACHED')
    // Media/network capability is denied in cached mode (loader consults this
    // exact gate before any remote fetch).
    assert.equal(canUseAuthenticatedNetwork().allowed, false)
  } finally {
    unsubscribe()
  }
})

// 3. Local session A + valid snapshot/owner + profile error + probe
//    REACHABLE → existing profile error surface remains (never disguise
//    RLS/schema/server failures as offline).
test('scenario 3: backend reachable keeps the existing blocking profile-resolution error', async () => {
  const { storage } = freshWorld()
  const result = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchReachable, timeoutMs: 200 }),
  })
  assert.equal(result.status, 'profile-fetch-failed')
  assert.ok(result.events.includes('profile-resolution-error-shown'))
  assert.equal(getAuthState().state, AUTH_STATE.RESOLVING, 'no cached reveal happened')
  assert.equal(result.probeCalls.count, 1, 'reachability was probed exactly once, after the failure')
})

test('scenario 3b: non-transport server errors keep the error surface WITHOUT probing', async () => {
  const { storage } = freshWorld()
  const result = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    // A well-formed PostgREST/RLS-style failure — reachable by definition.
    fetchProfile: async () => ({ profile: null, error: { message: 'permission denied for table profiles', code: '42501' } }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
  })
  assert.equal(result.status, 'profile-fetch-failed')
  assert.equal(result.probeCalls.count, 0, 'a server-shaped error must not trigger a probe')
})

// 4. Session user differs from trusted snapshot → fail closed.
test('scenario 4: snapshot belongs to a different user → fallback denied, no reveal, no probe', async () => {
  const { storage } = freshWorld({ snapshotUser: USER_B, ownerUser: USER_A })
  const result = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
  })
  assert.equal(result.status, 'profile-fetch-failed')
  assert.equal(result.counters.cachedHomeRenders, 0, "another user's cached data must never render")
  assert.equal(result.probeCalls.count, 0, 'identity gates run before the probe')
  assert.notEqual(getAuthState().state, AUTH_STATE.AUTHENTICATED_CACHED)
})

// 5. Local data owner differs → fail closed.
test('scenario 5: local data owner is a different user → fallback denied, no reveal', async () => {
  const { storage } = freshWorld({ snapshotUser: USER_A, ownerUser: USER_B })
  const result = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
  })
  assert.equal(result.status, 'profile-fetch-failed')
  assert.equal(result.counters.cachedHomeRenders, 0)
  assert.equal(result.probeCalls.count, 0)
  assert.notEqual(getAuthState().state, AUTH_STATE.AUTHENTICATED_CACHED)
})

// 6. Explicit auth rejection → existing rejection behavior, never cached
//    fallback.
test('scenario 6: explicit server-confirmed auth rejection denies the fallback', async () => {
  for (const message of ['session_not_found', 'user_not_found', 'invalid_refresh_token', 'invalid_grant']) {
    const { storage } = freshWorld()
    const rejection = Object.assign(new Error(message), { status: 400 })
    assert.equal(isExplicitAuthRejection(rejection), true, `${message} must classify as explicit rejection`)
    const result = await orchestrateInitialResolution({
      session: { user: { id: USER_A, email: 'a@example.com' } },
      fetchProfile: async () => ({ profile: null, error: rejection }),
      storage,
      probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
    })
    assert.equal(result.status, 'profile-fetch-failed', `${message} must keep the existing error/rejection surface`)
    assert.equal(result.probeCalls.count, 0, 'rejections are decided without probing')
    assert.notEqual(getAuthState().state, AUTH_STATE.AUTHENTICATED_CACHED)
  }
})

// 7. Healthy online local session → no additional reachability probe,
//    existing COMPLETE startup unchanged.
test('scenario 7: healthy online cold start stays probe-free with exactly one Home refresh', async () => {
  const { storage } = freshWorld()
  const { pill, unsubscribe } = bindOfflinePillMirror()
  try {
    const result = await orchestrateInitialResolution({
      session: { user: { id: USER_A, email: 'a@example.com' } },
      fetchProfile: async () => ({
        profile: { id: USER_A, username: 'alice', display_name: 'Alice', profile_completed_at: '2026-01-01' },
        error: null,
      }),
      storage,
      probe: () => { throw new Error('probe must never run on the healthy path') },
    })
    assert.equal(result.status, 'complete-home')
    assert.equal(result.probeCalls.count, 0, 'ZERO probes on the healthy path — Stage A startup preserved')
    assert.equal(result.counters.homeNetworkRefreshes, 1, 'exactly one startup Home hydration')
    assert.equal(getAuthState().state, AUTH_STATE.AUTHENTICATED_COMPLETE)
    assert.equal(pill.visible, false)
    assert.equal(canUseAuthenticatedNetwork().allowed, true)
  } finally {
    unsubscribe()
  }
})

// 8. Reconnect after the new cached fallback → same-user in-place COMPLETE
//    transition, one Home refresh, media misses become network-capable,
//    Offline pill clears.
test('scenario 8: reconnect after cached fallback revalidates in place — one refresh, capability + pill flip', async () => {
  const { storage } = freshWorld()
  const { pill, unsubscribe } = bindOfflinePillMirror()
  try {
    const boot = await orchestrateInitialResolution({
      session: { user: { id: USER_A, email: 'a@example.com' } },
      fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
      storage,
      probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
    })
    assert.equal(boot.status, 'cached-offline-fallback')
    assert.equal(pill.visible, true)
    assert.equal(canUseAuthenticatedNetwork().allowed, false, 'cached media misses must not fetch remotely yet')

    // The fallback status is NOT a success status, so the reconnect
    // revalidation re-enters the pipeline; with state CACHED + same user it
    // takes the in-place path (no blocker, no DOM blank).
    const events = []
    const reconnect = await orchestrateInPlaceRevalidation({
      user: { id: USER_A, email: 'a@example.com' },
      fetchProfile: async () => ({
        profile: { id: USER_A, username: 'alice', display_name: 'Alice', profile_completed_at: '2026-01-01' },
        error: null,
      }),
      counters: boot.counters,
      events,
    })
    assert.equal(reconnect.status, 'complete-home')
    assert.equal(getAuthState().state, AUTH_STATE.AUTHENTICATED_COMPLETE)
    assert.equal(boot.counters.homeNetworkRefreshes, 1, 'exactly ONE Home refresh across the reconnect')
    assert.equal(pill.visible, false, 'Offline pill must clear on COMPLETE')
    assert.equal(canUseAuthenticatedNetwork().allowed, true, 'cached media misses become network-capable')
  } finally {
    unsubscribe()
  }
})

// 9. Sign-out semantics unchanged: an explicit sign-out revokes offline
//    trust; the fallback can never resurrect the account afterwards.
test('scenario 9: sign-out clears the snapshot/owner and the fallback fails closed afterwards', async () => {
  const { storage } = freshWorld()
  // Boot into the cached fallback first.
  const boot = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
  })
  assert.equal(boot.status, 'cached-offline-fallback')

  // Mirror of the SIGNED_OUT handler's trust revocation (unchanged by this
  // fix): snapshot cleared unconditionally, owner cleared after purge.
  clearLastValidatedAccount(storage)
  clearLocalDataOwner(storage)
  setAuthState({ state: AUTH_STATE.UNAUTHENTICATED, userId: null })
  assert.equal(readLastValidatedAccount(storage), null)

  // A later resolution failure (even with a lingering session object) must
  // not re-reveal the cached shell.
  const relaunch = await orchestrateInitialResolution({
    session: { user: { id: USER_A, email: 'a@example.com' } },
    fetchProfile: async () => ({ profile: null, error: offlineProfileError() }),
    storage,
    probe: () => probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }),
  })
  assert.equal(relaunch.status, 'profile-fetch-failed')
  assert.equal(relaunch.counters.cachedHomeRenders, 0)
  assert.notEqual(getAuthState().state, AUTH_STATE.AUTHENTICATED_CACHED)
})

// Account-transition safety: a newer transition beginning while the probe is
// in flight must yield 'stale' — the fallback paints nothing.
test('stale-async safety: a newer account transition during the probe suppresses the reveal', async () => {
  const { storage } = freshWorld()
  const events = []
  const counters = { cachedHomeRenders: 0, homeNetworkRefreshes: 0 }
  const probeCalls = { count: 0 }
  const reveal = makeSharedReveal({ events, counters })
  const generation = beginAccountTransition()

  const outcome = await orchestrateCachedFallback({
    user: { id: USER_A },
    error: offlineProfileError(),
    storage,
    generation,
    probe: async () => {
      // Account B's sign-in supersedes us mid-probe.
      beginAccountTransition()
      return 'unreachable'
    },
    probeCalls,
    reveal,
  })
  assert.equal(outcome, 'stale')
  assert.equal(counters.cachedHomeRenders, 0, 'a stale fallback must paint nothing')
  assert.equal(events.length, 0)
})

// The REAL probe classifies the exact device failure shape as unreachable
// and a served response as reachable (sanity of the classification inputs).
test('probe classification: TypeError("Failed to fetch") → unreachable; HTTP 200 → reachable', async () => {
  assert.equal(await probeBackendReachability({ fetchImpl: fetchUnreachable, timeoutMs: 200 }), 'unreachable')
  assert.equal(await probeBackendReachability({ fetchImpl: fetchReachable, timeoutMs: 200 }), 'reachable')
  // And the transport classifier accepts the postgrest-wrapped error shape.
  assert.equal(isTransportSessionError(offlineProfileError()), true)
  assert.equal(isExplicitAuthRejection(offlineProfileError()), false)
})
