import test from 'node:test'
import assert from 'node:assert/strict'

import { runProfileSetupCompletion, runSetupSignOut } from './profile-setup-flow.js'

test('runProfileSetupCompletion awaits the handler BEFORE closing the overlay', async () => {
  const events = []
  let resolveHandler
  const handlerPromise = new Promise(r => { resolveHandler = r })

  const handler = async persisted => {
    events.push({ step: 'handler:start', persisted })
    await handlerPromise
    events.push({ step: 'handler:end' })
  }
  const close = () => { events.push({ step: 'close' }) }

  const run = runProfileSetupCompletion({ id: 'u1', username: 'alice' }, handler, close)

  // Yield once so `handler:start` fires, then confirm close has NOT run.
  await Promise.resolve()
  assert.deepEqual(events.map(e => e.step), ['handler:start'])

  resolveHandler()
  await run

  assert.deepEqual(events.map(e => e.step), ['handler:start', 'handler:end', 'close'])
  assert.deepEqual(events[0].persisted, { id: 'u1', username: 'alice' })
})

test('runProfileSetupCompletion fails closed: handler error propagates AND close is NOT called', async () => {
  // Critical behavior: a failed Home refresh must leave the setup overlay
  // open. Swallowing the error and closing would expose blank/stale Home.
  const events = []
  const boom = new Error('refreshHome exploded')
  const handler = async () => {
    events.push('handler')
    throw boom
  }
  const close = () => { events.push('close') }

  await assert.rejects(
    () => runProfileSetupCompletion({ id: 'u1' }, handler, close),
    err => err === boom,
  )
  assert.deepEqual(events, ['handler'])
})

test('runProfileSetupCompletion after a failed attempt can be retried and then close on success', async () => {
  // Simulates: user clicks Save → Home refresh fails → setup stays open →
  // user retries → Home refresh succeeds → overlay closes.
  const events = []
  let firstAttempt = true
  const handler = async () => {
    events.push('handler')
    if (firstAttempt) {
      firstAttempt = false
      throw new Error('network')
    }
  }
  const close = () => { events.push('close') }

  await assert.rejects(() => runProfileSetupCompletion({ id: 'u1' }, handler, close))
  assert.deepEqual(events, ['handler'])

  await runProfileSetupCompletion({ id: 'u1' }, handler, close)
  assert.deepEqual(events, ['handler', 'handler', 'close'])
})

test('runProfileSetupCompletion tolerates missing handler / close', async () => {
  await runProfileSetupCompletion({ id: 'u1' }, null, null)
  await runProfileSetupCompletion({ id: 'u1' }, undefined, undefined)
  // no throw
})

// ── runSetupSignOut ────────────────────────────────────────────────────

test('runSetupSignOut awaits a delayed sign-out (overlay stays open until then)', async () => {
  const events = []
  let resolve
  const signOut = () => new Promise(r => { resolve = r; events.push('start') })
  const run = runSetupSignOut(signOut)
  await Promise.resolve() // let signOut start
  assert.deepEqual(events, ['start'])
  // The promise is still pending — the caller's UI would still be showing
  // setup + "Please wait" on the button.
  resolve()
  await run
  assert.deepEqual(events, ['start'])
})

test('runSetupSignOut FAILS CLOSED: a failed sign-out re-throws (caller keeps setup open)', async () => {
  const boom = new Error('network down')
  await assert.rejects(
    () => runSetupSignOut(async () => { throw boom }),
    err => err === boom,
  )
})

test('runSetupSignOut resolves without side effects on success', async () => {
  // On success the caller does NOT close the overlay directly; the
  // centralized SIGNED_OUT handler drives forceCloseProfileOverlay().
  let called = 0
  await runSetupSignOut(async () => { called++ })
  assert.equal(called, 1)
})

test('runSetupSignOut tolerates a missing sign-out function', async () => {
  await runSetupSignOut(null)
  await runSetupSignOut(undefined)
})

test('runProfileSetupCompletion refresh-then-close sequence proves Home is repopulated before dismiss', async () => {
  const events = []
  const persisted = { id: 'u1', username: 'alice', display_name: 'Alice', profile_completed_at: 'now' }
  const homeRefreshes = []

  const handler = async row => {
    events.push('navigate(home)')
    await new Promise(r => setTimeout(r, 5))
    events.push('refreshHome:done')
    homeRefreshes.push(row.username)
    await new Promise(r => setTimeout(r, 5))
    events.push('refreshHeader:done')
  }
  const close = () => { events.push('overlay-hide') }

  await runProfileSetupCompletion(persisted, handler, close)

  assert.deepEqual(events, [
    'navigate(home)',
    'refreshHome:done',
    'refreshHeader:done',
    'overlay-hide',
  ])
  assert.deepEqual(homeRefreshes, ['alice'])
})
