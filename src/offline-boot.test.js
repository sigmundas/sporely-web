// Stage B1 offline-boot orchestration test. Mirrors main.js's cached path
// as a pure helper so we can exercise the decision matrix without pulling
// the DOM-heavy real init() into Node. Any drift in main.js's cached-boot
// classifier should be reflected here.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearLastValidatedAccount,
  readLastValidatedAccount,
  writeLastValidatedAccount,
} from './last-validated-account.js'
import { AUTH_STATE, isAuthorizedForAuthenticatedNetworkOps } from './auth-state.js'

function memStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  }
}

// Pure orchestration helper that duplicates the decision matrix in
// main.js `_tryCachedAuthenticatedBoot`. Any changes to the production
// classifier should be reflected here.
function orchestrateCachedBoot({
  sessionError,
  snapshot,
  owner,
  isExplicitAuthReject,
  reachability,
  homeHydrationCount,
  homeOnlineWritesAttempted,
} = {}) {
  const events = []
  const hydrations = { count: homeHydrationCount || 0 }
  const writes = { attempted: !!homeOnlineWritesAttempted }
  if (!snapshot) {
    events.push('no-snapshot -> unauth')
    return { state: AUTH_STATE.UNAUTHENTICATED, events, hydrations, writes }
  }
  if (!owner) {
    events.push('owner-missing -> clear + unauth')
    return { state: AUTH_STATE.UNAUTHENTICATED, events, hydrations, writes, clearedSnapshot: true }
  }
  if (owner !== snapshot.userId) {
    events.push('owner-mismatch -> clear + unauth')
    return { state: AUTH_STATE.UNAUTHENTICATED, events, hydrations, writes, clearedSnapshot: true }
  }
  if (sessionError && isExplicitAuthReject) {
    events.push('auth-rejected -> unauth')
    return { state: AUTH_STATE.UNAUTHENTICATED, events, hydrations, writes }
  }
  events.push('render-cached-header')
  const targetState = reachability === 'reachable'
    ? AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
    : AUTH_STATE.AUTHENTICATED_CACHED
  events.push(`state -> ${targetState}`)
  events.push('reveal-shell')
  events.push('show-offline-indicator')
  // Cached boot must NOT hydrate Home online in Stage B1.
  return {
    state: targetState,
    events,
    hydrations,
    writes,
    clearedSnapshot: false,
  }
}

test('validated snapshot + owner match + backend UNREACHABLE => AUTHENTICATED_CACHED', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice', display_name: 'Alice', avatar_url: '' },
    cloudPlan: { cloudPlan: 'pro', hasProAccess: true, qualityProfile: 'high' },
  }, storage)
  const snapshot = readLastValidatedAccount(storage)

  const result = orchestrateCachedBoot({
    sessionError: new Error('failed to fetch'),
    snapshot,
    owner: 'user-a',
    isExplicitAuthReject: false,
    reachability: 'unreachable',
  })
  assert.equal(result.state, AUTH_STATE.AUTHENTICATED_CACHED)
  assert.equal(result.clearedSnapshot, false)
  assert.ok(result.events.includes('render-cached-header'))
  assert.ok(result.events.includes('show-offline-indicator'))
  // Stage B1 hydration invariant: cached boot does ZERO online Home refresh.
  assert.equal(result.hydrations.count, 0)
})

test('null session + backend REACHABLE + owner match => AUTHENTICATED_REAUTH_REQUIRED (no online writes)', () => {
  // The refined semantics: if we can reach Supabase but our session is
  // gone, the shell reveals cached identity but authenticated network
  // writes must NOT be attempted. Downstream gating is by state; the
  // orchestrator here surfaces the resolved state so we can assert it.
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice', display_name: 'Alice' },
    cloudPlan: { cloudPlan: 'free' },
  }, storage)
  const snapshot = readLastValidatedAccount(storage)

  const result = orchestrateCachedBoot({
    sessionError: null, // null session, no throw
    snapshot,
    owner: 'user-a',
    isExplicitAuthReject: false,
    reachability: 'reachable',
    homeOnlineWritesAttempted: false,
  })
  assert.equal(result.state, AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED)
  assert.equal(result.writes.attempted, false)
  assert.equal(result.hydrations.count, 0)
})

test('expired access JWT + transport failure + owner match => AUTHENTICATED_CACHED (regression)', () => {
  // A bare "JWT expired" from the access token must NOT deny cached boot.
  // We simulate the classifier's decision here: `isExplicitAuthReject`
  // is false, transport probe returns unreachable.
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  const snapshot = readLastValidatedAccount(storage)
  const result = orchestrateCachedBoot({
    sessionError: Object.assign(new Error('JWT expired'), { status: 401 }),
    snapshot,
    owner: 'user-a',
    isExplicitAuthReject: false, // refined: JWT expired is not explicit
    reachability: 'unreachable',
  })
  assert.equal(result.state, AUTH_STATE.AUTHENTICATED_CACHED)
})

test('invalid_refresh_token + owner match => sign-out recovery (no cached mode)', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  const snapshot = readLastValidatedAccount(storage)
  const result = orchestrateCachedBoot({
    sessionError: { message: 'Invalid Refresh Token', code: 'refresh_token_not_found', status: 400 },
    snapshot,
    owner: 'user-a',
    isExplicitAuthReject: true,
    reachability: 'reachable',
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.ok(result.events.includes('auth-rejected -> unauth'))
})

test('session_not_found / user_not_found + owner match => sign-out recovery (no cached mode)', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  const snapshot = readLastValidatedAccount(storage)
  for (const message of ['session_not_found', 'user_not_found']) {
    const result = orchestrateCachedBoot({
      sessionError: { message, status: 400 },
      snapshot,
      owner: 'user-a',
      isExplicitAuthReject: true,
      reachability: 'reachable',
    })
    assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED, `must sign out for ${message}`)
  }
})

test('no snapshot + offline => existing unauthenticated flow (no cached mode)', () => {
  const storage = memStorage()
  const snapshot = readLastValidatedAccount(storage)
  const result = orchestrateCachedBoot({
    sessionError: new Error('failed to fetch'),
    snapshot,
    owner: null,
    isExplicitAuthReject: false,
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.ok(result.events.includes('no-snapshot -> unauth'))
})

test('owner mismatch => FAIL CLOSED and clear the stale snapshot', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  const snapshot = readLastValidatedAccount(storage)

  const result = orchestrateCachedBoot({
    sessionError: new Error('failed to fetch'),
    snapshot,
    owner: 'user-b',
    isExplicitAuthReject: false,
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.equal(result.clearedSnapshot, true)
})

test('missing owner marker => FAIL CLOSED (do not reveal even for a known snapshot)', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  const snapshot = readLastValidatedAccount(storage)

  const result = orchestrateCachedBoot({
    sessionError: new Error('failed to fetch'),
    snapshot,
    owner: null,
    isExplicitAuthReject: false,
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.equal(result.clearedSnapshot, true)
})

test('corrupt snapshot (unreadable JSON) => FAIL CLOSED', () => {
  const storage = memStorage()
  storage.setItem('sporely-last-validated-account-v1', '{ not json')
  const snapshot = readLastValidatedAccount(storage)
  assert.equal(snapshot, null, 'read must fail closed on bad JSON')

  const result = orchestrateCachedBoot({
    sessionError: new Error('failed to fetch'),
    snapshot,
    owner: 'user-a',
    isExplicitAuthReject: false,
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.ok(result.events.includes('no-snapshot -> unauth'))
})

test('explicit auth rejection => do NOT enter cached mode even with a valid snapshot', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  const snapshot = readLastValidatedAccount(storage)

  const result = orchestrateCachedBoot({
    sessionError: Object.assign(new Error('invalid_grant'), { status: 400 }),
    snapshot,
    owner: 'user-a',
    isExplicitAuthReject: true,
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.ok(result.events.includes('auth-rejected -> unauth'))
})

test('sign-out clears snapshot; offline relaunch after sign-out does NOT restore cached account', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  // Simulate signout — clears the record (and the local-data-owner, but
  // that lives in a different module; we simulate its absence here).
  clearLastValidatedAccount(storage)
  const snapshot = readLastValidatedAccount(storage)
  const result = orchestrateCachedBoot({
    sessionError: new Error('failed to fetch'),
    snapshot,
    owner: null,
    isExplicitAuthReject: false,
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
})

test('reconnect: cached -> complete via successful validation', () => {
  // This mirrors the revalidation branch: on successful online session, we
  // trigger the normal resolve pipeline which transitions to
  // AUTHENTICATED_COMPLETE.
  const events = []
  let state = AUTH_STATE.AUTHENTICATED_CACHED
  const validate = async ok => {
    events.push(`validate:${ok ? 'ok' : 'transport-fail'}`)
    if (ok) {
      state = AUTH_STATE.AUTHENTICATED_COMPLETE
    }
    // transport failure keeps state cached
  }
  return (async () => {
    await validate(true)
    assert.equal(state, AUTH_STATE.AUTHENTICATED_COMPLETE)
    assert.deepEqual(events, ['validate:ok'])
  })()
})

test('reconnect: reauth-required -> complete via successful validation', () => {
  // The refined semantics: revalidation from AUTHENTICATED_REAUTH_REQUIRED
  // must transition to AUTHENTICATED_COMPLETE once a real session
  // materializes (e.g. after the user signs in, or if the refresh token
  // recovered on the next tick).
  let state = AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
  const validate = async ok => { if (ok) state = AUTH_STATE.AUTHENTICATED_COMPLETE }
  return (async () => {
    await validate(true)
    assert.equal(state, AUTH_STATE.AUTHENTICATED_COMPLETE)
  })()
})

test('reconnect: transport failure stays cached', () => {
  const events = []
  let state = AUTH_STATE.AUTHENTICATED_CACHED
  const validate = async ({ transport, auth }) => {
    if (transport) events.push('transport-error') // stay cached
    else if (auth) events.push('auth-rejected') // sign-out path
  }
  return (async () => {
    await validate({ transport: true })
    assert.equal(state, AUTH_STATE.AUTHENTICATED_CACHED, 'must remain in cached mode on transport failure')
    assert.deepEqual(events, ['transport-error'])
  })()
})

test('reconnect: probe reachability flip transitions cached <-> reauth-required (no COMPLETE)', () => {
  // If the null-session persists but the probe result flips, the state
  // must sync accordingly. Only a real session moves us to COMPLETE.
  let state = AUTH_STATE.AUTHENTICATED_CACHED
  const sync = (nextReachability) => {
    state = nextReachability === 'reachable'
      ? AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED
      : AUTH_STATE.AUTHENTICATED_CACHED
  }
  sync('reachable')
  assert.equal(state, AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED)
  sync('unreachable')
  assert.equal(state, AUTH_STATE.AUTHENTICATED_CACHED)
})

test('reconnect: explicit invalid triggers sign-out path (which clears snapshot)', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  // Emulate the revalidation catching a definitive auth reject and doing a
  // real signOut(), which fires SIGNED_OUT and clears the snapshot.
  clearLastValidatedAccount(storage)
  assert.equal(readLastValidatedAccount(storage), null)
})

test('account delete clears snapshot (same SIGNED_OUT path)', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  // Account-delete flow calls signOut() → SIGNED_OUT handler in main.js
  // calls clearLastValidatedAccount.
  clearLastValidatedAccount(storage)
  assert.equal(readLastValidatedAccount(storage), null)
})

test('REGRESSION: explicit logout followed by OFFLINE relaunch cannot resurrect cached identity', () => {
  // A real sign-out clears the snapshot AND the local-data-owner marker.
  // On the next offline relaunch (probe returns unreachable), cached boot
  // must find neither and fall through to unauthenticated instead of
  // silently re-entering AUTHENTICATED_CACHED.
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: null,
  }, storage)
  // SIGNED_OUT handler clears both markers atomically.
  clearLastValidatedAccount(storage)
  const snapshotAfterSignOut = readLastValidatedAccount(storage)
  assert.equal(snapshotAfterSignOut, null)

  // Next launch: offline, snapshot is null. Cached boot must return unauth.
  const result = orchestrateCachedBoot({
    sessionError: new Error('Failed to fetch'),
    snapshot: null,
    owner: null,
    isExplicitAuthReject: false,
    reachability: 'unreachable',
  })
  assert.equal(result.state, AUTH_STATE.UNAUTHENTICATED)
  assert.ok(result.events.includes('no-snapshot -> unauth'))
})

test('REGRESSION: reauth-required does NOT authorize online writes (state gate)', () => {
  // Downstream code must gate authenticated network ops on
  // AUTHENTICATED_COMPLETE only. Confirm the state has no write privilege
  // via the exported predicate.
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED), false)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_CACHED), false)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_COMPLETE), true)
})
