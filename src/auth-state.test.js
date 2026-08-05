import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, getAuthState, setAuthState, subscribeAuthState, _resetAuthStateForTests } from './auth-state.js'

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
