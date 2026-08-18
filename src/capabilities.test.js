import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  canUseAuthenticatedNetwork,
  canPerformCloudMutation,
  canUseOAuthLink,
  canBeginLoginOAuth,
  isOfflineCachedMode,
  requiresReauthentication,
  requireCloudMutation,
  canPerformLocalOperation,
  CAPABILITY_REASON,
} from './capabilities.js'
import { AUTH_STATE, setAuthState, _resetAuthStateForTests } from './auth-state.js'

// The capability messages are pulled from the i18n bundle. We assert on the
// reason codes (which are stable) and on the fact that a message string is
// present (which the UI needs).

function assertDenied(result, reason) {
  assert.equal(result.allowed, false)
  assert.equal(result.reason, reason)
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.length > 0, 'denial must include a user-facing message')
}

describe('capabilities — Stage B2b', () => {
  beforeEach(() => _resetAuthStateForTests())

  it('COMPLETE allows every authenticated network action', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    assert.equal(canUseAuthenticatedNetwork().allowed, true)
    assert.equal(canPerformCloudMutation().allowed, true)
    assert.equal(canUseOAuthLink().allowed, true)
  })

  it('CACHED blocks authenticated network ops with the offline reason', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    assertDenied(canUseAuthenticatedNetwork(), CAPABILITY_REASON.OFFLINE)
    assertDenied(canPerformCloudMutation(), CAPABILITY_REASON.OFFLINE)
    assertDenied(canUseOAuthLink(), CAPABILITY_REASON.OFFLINE)
    assert.equal(isOfflineCachedMode(), true)
    assert.equal(requiresReauthentication(), false)
  })

  it('REAUTH_REQUIRED blocks with the reauth reason', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    assertDenied(canPerformCloudMutation(), CAPABILITY_REASON.REAUTH_REQUIRED)
    assert.equal(isOfflineCachedMode(), false)
    assert.equal(requiresReauthentication(), true)
  })

  it('UNAUTHENTICATED denies mutations but allows the Login OAuth pipeline', () => {
    setAuthState({ state: AUTH_STATE.UNAUTHENTICATED, userId: null })
    assertDenied(canPerformCloudMutation(), CAPABILITY_REASON.UNAUTHENTICATED)
    assert.equal(canBeginLoginOAuth().allowed, true)
  })

  it('AUTHENTICATED_COMPLETE does not allow re-starting the Login OAuth flow', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    assert.equal(canBeginLoginOAuth().allowed, false)
  })

  it('capability results include a stable reason code', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    const denial = canPerformCloudMutation()
    assert.equal(denial.reason, 'offline')

    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    assert.equal(canPerformCloudMutation().reason, 'reauth_required')
  })

  it('canPerformLocalOperation is always allowed regardless of auth state', () => {
    for (const value of Object.values(AUTH_STATE)) {
      setAuthState({ state: value, userId: 'u1' })
      assert.equal(canPerformLocalOperation().allowed, true, `local ops must be allowed in ${value}`)
    }
  })

  it('overrideState lets tests / call sites bypass the module-level snapshot', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    assertDenied(canPerformCloudMutation(AUTH_STATE.AUTHENTICATED_CACHED), CAPABILITY_REASON.OFFLINE)
    assertDenied(canPerformCloudMutation(AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED), CAPABILITY_REASON.REAUTH_REQUIRED)
  })

  it('requireCloudMutation shows the denial toast and returns the capability', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    const toasts = []
    const result = requireCloudMutation({ showToast: msg => toasts.push(msg) })
    assert.equal(result.allowed, false)
    assert.equal(result.reason, 'offline')
    assert.equal(toasts.length, 1)
    assert.equal(typeof toasts[0], 'string')
  })

  it('requireCloudMutation is silent when { silent: true }', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    const toasts = []
    const result = requireCloudMutation({
      showToast: msg => toasts.push(msg),
      silent: true,
    })
    assert.equal(result.allowed, false)
    assert.equal(toasts.length, 0)
  })

  it('requireCloudMutation returns { allowed: true } in COMPLETE without toasting', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'u1' })
    const toasts = []
    const result = requireCloudMutation({ showToast: msg => toasts.push(msg) })
    assert.equal(result.allowed, true)
    assert.equal(toasts.length, 0)
  })

  it('CACHED / REAUTH surfaces the two distinct messages', () => {
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'u1' })
    const offlineMsg = canPerformCloudMutation().message
    setAuthState({ state: AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED, userId: 'u1' })
    const reauthMsg = canPerformCloudMutation().message
    assert.notEqual(offlineMsg, reauthMsg, 'offline vs. reauth messages must be distinguishable')
  })
})
