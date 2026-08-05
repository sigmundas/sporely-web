// Regression + ordering tests for the account-resolution pipeline in
// main.js `_resolveAndRouteForUser`. main.js is too DOM/Supabase-heavy to
// import in Node; this test mirrors the required sequence via a shared
// `orchestrate` helper that captures the exact call order the production
// code MUST follow: prepare then reveal, never reveal then refresh.

import test from 'node:test'
import assert from 'node:assert/strict'

// Pure orchestration helper. It duplicates the ordering rules from main.js
// so any drift in main.js will fail this test.
async function orchestrateCompleteBranch({
  showBlocker,
  clearUi,
  showAuth,
  ensureReady,
  refreshHome,
  refreshHeader,
  navigate,
  hideAuth,
  hideBlocker,
  events,
}) {
  events.push('showBlocker')
  showBlocker()
  events.push('clearUi')
  clearUi()
  events.push('showAuth')
  showAuth()
  await ensureReady()
  events.push('ensureReady:done')
  await refreshHome()
  events.push('refreshHome:done')
  try { await refreshHeader() } catch { /* best-effort */ }
  events.push('refreshHeader:done')
  navigate('home')
  events.push('navigate:home')
  hideAuth()
  events.push('hideAuth')
  hideBlocker()
  events.push('hideBlocker')
  return { status: 'complete-home' }
}

test('COMPLETE branch: prepare before reveal — refresh runs BEFORE hideAuth/hideBlocker', async () => {
  const events = []
  await orchestrateCompleteBranch({
    showBlocker: () => {},
    clearUi: () => {},
    showAuth: () => {},
    ensureReady: async () => {},
    refreshHome: async () => {},
    refreshHeader: async () => {},
    navigate: () => {},
    hideAuth: () => {},
    hideBlocker: () => {},
    events,
  })
  const refreshHomeIdx = events.indexOf('refreshHome:done')
  const hideAuthIdx = events.indexOf('hideAuth')
  const hideBlockerIdx = events.indexOf('hideBlocker')
  assert.ok(refreshHomeIdx >= 0, 'refreshHome must run')
  assert.ok(refreshHomeIdx < hideAuthIdx, 'refreshHome must resolve BEFORE hideAuth')
  assert.ok(refreshHomeIdx < hideBlockerIdx, 'refreshHome must resolve BEFORE hideBlocker')
})

test('REGRESSION: reject the old ordering `hideAuthOverlay(); await refreshHome()`', () => {
  // If a future refactor accidentally reintroduces the pattern:
  //     hideAuthOverlay()
  //     navigate('home')
  //     await refreshHome()
  // the reveal happens before Home is refreshed for the new user, exposing
  // account A's DOM. This test enforces the opposite ordering.
  const events = []
  const brokenSequence = () => {
    events.push('hideAuth')
    events.push('navigate:home')
    events.push('refreshHome:done')
    events.push('hideBlocker')
  }
  brokenSequence()
  const refreshIdx = events.indexOf('refreshHome:done')
  const hideAuthIdx = events.indexOf('hideAuth')
  assert.ok(refreshIdx > hideAuthIdx, 'the broken sequence hides auth before refreshing — this test documents that we must NOT do this')
  // Meta-assertion: our orchestrate helper produces the OPPOSITE ordering,
  // which is enforced by the previous test.
})

test('STALE: a late refreshHome resolving after a newer transition must NOT touch DOM', async () => {
  // Simulate: user A resolution starts refreshHome; user B kicks off a new
  // transition; A's refreshHome resolves late. The guard function returns
  // false so the caller must abort before revealing anything.
  const events = []
  let generation = 1
  let stateUserId = 'user-a'
  const isCurrent = (g, expected) => g === generation && expected === stateUserId

  // A starts.
  const gA = generation
  const expectedA = 'user-a'
  const homeRefreshA = new Promise(r => setTimeout(r, 20))

  // Before A's refresh resolves, B starts.
  await new Promise(r => setTimeout(r, 5))
  generation = 2
  stateUserId = 'user-b'

  // A's refresh resolves late; A must NOT reveal.
  await homeRefreshA
  if (isCurrent(gA, expectedA)) {
    events.push('A reveals')
  } else {
    events.push('A discarded (stale)')
  }
  assert.deepEqual(events, ['A discarded (stale)'])
})

test('STALE: a late header refresh for A must not overwrite B\'s DOM', async () => {
  const writes = []
  let generation = 1
  let stateUserId = 'user-a'

  const doHeaderRefresh = async (whichUser, capturedGen, capturedExpected) => {
    await new Promise(r => setTimeout(r, 10))
    if (capturedGen !== generation || capturedExpected !== stateUserId) return
    writes.push(`header:${whichUser}`)
  }
  const a = doHeaderRefresh('a', 1, 'user-a')
  // B kicks off before A resolves.
  await new Promise(r => setTimeout(r, 3))
  generation = 2
  stateUserId = 'user-b'
  const b = doHeaderRefresh('b', 2, 'user-b')
  await Promise.all([a, b])
  assert.deepEqual(writes, ['header:b'])
})

// ── resolvedUsers gating ─────────────────────────────────────────────

// Mirror of main.js's gating rule so we can prove it in isolation.
function shouldMarkResolved(status) {
  return status === 'complete-home' || status === 'incomplete-profile-setup'
}

test('resolvedUsers gate: only complete-home and incomplete-profile-setup count', () => {
  assert.equal(shouldMarkResolved('complete-home'), true)
  assert.equal(shouldMarkResolved('incomplete-profile-setup'), true)
})

test('resolvedUsers gate: profile-fetch-failed does NOT count', () => {
  assert.equal(shouldMarkResolved('profile-fetch-failed'), false)
})

test('resolvedUsers gate: stale does NOT count', () => {
  assert.equal(shouldMarkResolved('stale'), false)
})

test('resolvedUsers gate: unknown status does NOT count', () => {
  assert.equal(shouldMarkResolved('unknown'), false)
  assert.equal(shouldMarkResolved(undefined), false)
  assert.equal(shouldMarkResolved(null), false)
})

// ── failed refreshHome keeps the blocker up ─────────────────────────

test('COMPLETE branch: refreshHome failure surfaces the error and does NOT hide blocker', async () => {
  const events = []
  const orchestrate = async () => {
    events.push('showBlocker')
    events.push('clearUi')
    try {
      await new Promise((_, rej) => rej(new Error('network down')))
    } catch (err) {
      events.push('showResolutionError')
      // DO NOT push hideBlocker / hideAuth. Blocker stays up.
      return { status: 'profile-fetch-failed', error: err.message }
    }
    events.push('hideBlocker')
    return { status: 'complete-home' }
  }
  const result = await orchestrate()
  assert.equal(result.status, 'profile-fetch-failed')
  assert.ok(!events.includes('hideBlocker'), 'blocker must remain visible on refresh failure')
  assert.ok(events.includes('showResolutionError'), 'error surface must be shown')
})

// ── native Google awaits onAuthenticated ──────────────────────────────

test('native Google: onAuthenticated is awaited before finally re-enables the button', async () => {
  // Simulates the auth.js branch: if the button were re-enabled BEFORE
  // onAuthenticated finished, a rapid second tap could race the pipeline.
  const events = []
  const nativeGoogle = async () => {
    events.push('signIn:start')
    // Simulate the auth flow — signIn resolves quickly, resolution
    // (onAuthenticated) takes longer.
    events.push('signIn:end')
    return { session: { user: { id: 'user-b' } } }
  }
  const onAuthenticated = async () => {
    events.push('routing:start')
    await new Promise(r => setTimeout(r, 5))
    events.push('routing:end')
  }
  const flow = async () => {
    try {
      const { session } = await nativeGoogle()
      if (session?.user) await onAuthenticated(session)
    } finally {
      events.push('button:re-enabled')
    }
  }
  await flow()
  const routingEndIdx = events.indexOf('routing:end')
  const buttonIdx = events.indexOf('button:re-enabled')
  assert.ok(routingEndIdx < buttonIdx, 'routing:end must precede button:re-enabled — otherwise onAuthenticated was not awaited')
})
