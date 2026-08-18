import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTH_STATE,
  getAuthState,
  isAuthorizedForAuthenticatedNetworkOps,
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
