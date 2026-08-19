import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTH_STATE,
  getAuthState,
  isAuthorizedForAuthenticatedNetworkOps,
  isTerminallyResolvedAuthState,
  isUserAlreadyResolved,
  setAuthState,
  subscribeAuthState,
  _resetAuthStateForTests,
} from './auth-state.js'

beforeEach(() => {
  _resetAuthStateForTests()
})

test('initial state is resolving with no user', () => {
  assert.deepEqual(getAuthState(), { state: AUTH_STATE.RESOLVING, userId: null })
})

test('transitions notify subscribers', () => {
  const seen = []
  subscribeAuthState(s => seen.push({ ...s }))
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: 'user-a' })
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'user-a' })
  assert.equal(seen.length, 3)
  assert.equal(seen[0].state, AUTH_STATE.RESOLVING)
  assert.equal(seen[1].state, AUTH_STATE.AUTHENTICATED_INCOMPLETE)
  assert.equal(seen[2].state, AUTH_STATE.AUTHENTICATED_COMPLETE)
})

test('identical transitions are collapsed', () => {
  const seen = []
  subscribeAuthState(s => seen.push({ ...s }))
  setAuthState({ state: AUTH_STATE.RESOLVING, userId: null })
  assert.equal(seen.length, 1, 'no re-notify when nothing changed')
})

test('unsubscribe stops notifications', () => {
  let notified = 0
  const off = subscribeAuthState(() => { notified++ })
  off()
  setAuthState({ state: AUTH_STATE.UNAUTHENTICATED, userId: null })
  assert.equal(notified, 1, 'only the initial synchronous callback fired')
})

test('user-id switch notifies even at same state', () => {
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'user-a' })
  const seen = []
  subscribeAuthState(s => seen.push({ ...s }))
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'user-b' })
  assert.equal(seen.length, 2)
  assert.equal(seen[1].userId, 'user-b')
})

test('AUTHENTICATED_CACHED is a distinct state from AUTHENTICATED_COMPLETE', () => {
  // Stage B1: cached-authenticated boot must not be conflated with a fully
  // server-validated session. Different consumers may need to gate on one
  // and not the other (upload flows require _COMPLETE; header/shell only
  // needs _CACHED to render local data).
  assert.notEqual(AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.AUTHENTICATED_COMPLETE)
  assert.notEqual(AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.RESOLVING)
  assert.notEqual(AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.UNAUTHENTICATED)
  assert.notEqual(AUTH_STATE.AUTHENTICATED_CACHED, AUTH_STATE.AUTHENTICATED_INCOMPLETE)

  const seen = []
  subscribeAuthState(s => seen.push({ ...s }))
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'user-a' })
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'user-a' })
  // Initial + cached + complete
  assert.equal(seen.length, 3)
  assert.equal(seen[1].state, AUTH_STATE.AUTHENTICATED_CACHED)
  assert.equal(seen[2].state, AUTH_STATE.AUTHENTICATED_COMPLETE)
})

test('AUTHENTICATED_REAUTH_REQUIRED is distinct from CACHED and COMPLETE', () => {
  // Stage B1 refinement: null-session-but-backend-reachable must be
  // distinguishable from null-session-but-backend-unreachable so
  // authenticated network ops can be gated only on _COMPLETE.
  assert.notEqual(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, AUTH_STATE.AUTHENTICATED_CACHED)
  assert.notEqual(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, AUTH_STATE.AUTHENTICATED_COMPLETE)
  assert.notEqual(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, AUTH_STATE.UNAUTHENTICATED)
})

test('isTerminallyResolvedAuthState: only COMPLETE and INCOMPLETE are terminal', () => {
  // Round-5 live-reconnect regression. The resolver's `_resolvedUsers` dedupe
  // uses this predicate: CACHED / REAUTH_REQUIRED must NOT count as terminal
  // so a same-user reconnect re-enters the resolver and reaches the in-place
  // revalidation branch. Every state is proven explicitly.
  assert.equal(isTerminallyResolvedAuthState(AUTH_STATE.AUTHENTICATED_COMPLETE), true)
  assert.equal(isTerminallyResolvedAuthState(AUTH_STATE.AUTHENTICATED_INCOMPLETE), true)
  assert.equal(isTerminallyResolvedAuthState(AUTH_STATE.AUTHENTICATED_CACHED), false,
    'CACHED is a trusted-cache reveal, not a validated resolution — reconnect must re-enter')
  assert.equal(isTerminallyResolvedAuthState(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED), false,
    'REAUTH_REQUIRED is a trusted-cache reveal, not a validated resolution — reconnect must re-enter')
  assert.equal(isTerminallyResolvedAuthState(AUTH_STATE.RESOLVING), false)
  assert.equal(isTerminallyResolvedAuthState(AUTH_STATE.UNAUTHENTICATED), false)
  assert.equal(isTerminallyResolvedAuthState(undefined), false)
  assert.equal(isTerminallyResolvedAuthState(null), false)
  assert.equal(isTerminallyResolvedAuthState('nonsense'), false)
})

test('isUserAlreadyResolved: full behavioral truth table across every auth state', () => {
  // Round-5 live-reconnect regression — the resolver dedupe MUST NOT skip a
  // same-user resolution attempt when the current state is CACHED /
  // REAUTH_REQUIRED, even though the user is present in `_resolvedUsers` from
  // the previous online resolution. This test locks in the full truth table.
  const uid = 'user-A'
  const otherUid = 'user-B'
  const resolved = new Set([uid])
  const empty = new Set()

  // Every terminally resolved same-user pair must dedupe (== true).
  for (const state of [AUTH_STATE.AUTHENTICATED_COMPLETE, AUTH_STATE.AUTHENTICATED_INCOMPLETE]) {
    assert.equal(isUserAlreadyResolved(uid, resolved, { state, userId: uid }), true,
      `${state} + same user + present in resolvedUsers → skip`)
  }

  // Every non-terminal state for the same user must fall through (== false).
  // These are the states the runtime landed in when the bug fired.
  for (const state of [
    AUTH_STATE.AUTHENTICATED_CACHED,
    AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED,
    AUTH_STATE.RESOLVING,
    AUTH_STATE.UNAUTHENTICATED,
  ]) {
    assert.equal(isUserAlreadyResolved(uid, resolved, { state, userId: uid }), false,
      `${state} + same user in resolvedUsers → MUST re-enter resolver`)
  }

  // User not yet in the resolvedUsers set — never dedupe, regardless of state.
  for (const state of Object.values(AUTH_STATE)) {
    assert.equal(isUserAlreadyResolved(uid, empty, { state, userId: uid }), false,
      `${state} but not in resolvedUsers → resolve`)
  }

  // Different-user auth state — never dedupe (account-switch isolation).
  assert.equal(
    isUserAlreadyResolved(uid, resolved, { state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: otherUid }),
    false,
    'auth state belongs to another user → same-user dedupe must not apply')

  // Degenerate inputs must be treated as "not resolved" (fail-open into the
  // resolver rather than silently no-op).
  assert.equal(isUserAlreadyResolved(null, resolved, { state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: uid }), false)
  assert.equal(isUserAlreadyResolved(uid, null, { state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: uid }), false)
  assert.equal(isUserAlreadyResolved(uid, resolved, null), false)
  assert.equal(isUserAlreadyResolved(uid, resolved, { state: undefined, userId: uid }), false)
})

test('isAuthorizedForAuthenticatedNetworkOps: only AUTHENTICATED_COMPLETE returns true', () => {
  // Every other state must gate authenticated network ops:
  // RESOLVING (in flight), UNAUTHENTICATED (no user), AUTHENTICATED_INCOMPLETE
  // (setup pending), AUTHENTICATED_CACHED (no live session), and
  // AUTHENTICATED_REAUTH_REQUIRED (backend reachable but session missing/expired).
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_COMPLETE), true)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_CACHED), false)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED), false)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.AUTHENTICATED_INCOMPLETE), false)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.RESOLVING), false)
  assert.equal(isAuthorizedForAuthenticatedNetworkOps(AUTH_STATE.UNAUTHENTICATED), false)
})
