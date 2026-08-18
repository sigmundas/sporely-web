// QA round 2 — connectivity LOSS + multi-item queue integrity.
//
// Covers:
//   * native networkStatusChange true→false edge and resume
//     getStatus()===false both invoke the loss callback (Issue 1),
//   * main.js downgrade wiring: COMPLETE→CACHED same-user only, identity
//     invariants fail closed, no sign-out/purge, Finds swaps immediately,
//   * Save is local-first / transport-safe (Issue 2): nothing before the
//     durable queue write performs network I/O and post-save navigation
//     failures cannot surface as "Could not queue observation",
//   * multi-item queue integrity (Issue 3): remote recovery is gated on a
//     persisted prior insert attempt, never resolves to a remote id claimed
//     by another queue item, and finalization deletes ONLY the confirmed
//     item.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  NATIVE_NETWORK_LOSS_REASON,
  NATIVE_NETWORK_REASON,
  bindNativeNetworkMonitor,
  unbindNativeNetworkMonitor,
} from './native-network.js'
import {
  pickRecoveredRemoteObservationId,
  shouldAttemptRemoteRecovery,
} from './sync-queue.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const readSrc = rel => readFileSync(join(__dirname, rel), 'utf8')

function makeFakeNetwork({ initialConnected = false, connectionType = 'wifi' } = {}) {
  const listeners = new Map()
  return {
    status: { connected: initialConnected, connectionType },
    async getStatus() { return { ...this.status } },
    async addListener(event, cb) {
      listeners.set(event, cb)
      return { remove: async () => { listeners.delete(event) } }
    },
    emit(event, payload) { const cb = listeners.get(event); if (cb) cb(payload) },
  }
}

function makeFakeDocument({ visibilityState = 'visible' } = {}) {
  const listeners = new Map()
  return {
    visibilityState,
    addEventListener(event, cb) { listeners.set(event, cb) },
    removeEventListener(event) { listeners.delete(event) },
    emit(event) { const cb = listeners.get(event); if (cb) cb() },
  }
}

const noAppPlugin = {}

async function withMonitor(run) {
  try { await run() } finally { await unbindNativeNetworkMonitor() }
}

// ── Issue 1: native loss edge ────────────────────────────────────────────────

test('L1/QA3: connected=false events invoke onConnectivityLost (wake-up; downstream self-guards)', async () => {
  await withMonitor(async () => {
    const lost = []
    const restored = []
    const network = makeFakeNetwork({ initialConnected: true })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => restored.push(reason),
      onConnectivityLost: reason => lost.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    network.emit('networkStatusChange', { connected: false, connectionType: 'none' })
    network.emit('networkStatusChange', { connected: false, connectionType: 'none' })
    // QA round 3: wake-up semantics — every false event notifies; the loss
    // handler self-guards (only a stale COMPLETE downgrades, so repeats
    // no-op downstream). A loss must still never wake the restore path.
    assert.deepEqual(lost, [
      NATIVE_NETWORK_LOSS_REASON.NETWORK_CHANGE,
      NATIVE_NETWORK_LOSS_REASON.NETWORK_CHANGE,
    ])
    assert.deepEqual(restored, [], 'a loss edge must never wake the restore path')
  })
})

test('L5: resume getStatus()===false invokes the loss callback (backgrounded disconnect)', async () => {
  await withMonitor(async () => {
    const lost = []
    const restored = []
    const network = makeFakeNetwork({ initialConnected: true })
    const doc = makeFakeDocument({ visibilityState: 'visible' })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => restored.push(reason),
      onConnectivityLost: reason => lost.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: doc,
    })
    network.status = { connected: false, connectionType: 'none' } // dropped while backgrounded
    doc.emit('visibilitychange')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(lost, [NATIVE_NETWORK_LOSS_REASON.RESUME_STATUS])
    assert.deepEqual(restored, [])
  })
})

test('L7/QA3: transient false/true burst — every event is a wake-up; downstream dedupes', async () => {
  await withMonitor(async () => {
    const lost = []
    const restored = []
    const network = makeFakeNetwork({ initialConnected: true })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => restored.push(reason),
      onConnectivityLost: reason => lost.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    network.emit('networkStatusChange', { connected: false })
    network.emit('networkStatusChange', { connected: true })
    network.emit('networkStatusChange', { connected: true })
    // QA round 3: connectivity events are wake-ups, not edges. The loss
    // callback self-guards on auth state (COMPLETE only) and every restore
    // converges on the single in-flight + throttled revalidation guard in
    // main.js, so repeated notifications cannot duplicate account
    // transitions or queue processors.
    assert.deepEqual(lost, [NATIVE_NETWORK_LOSS_REASON.NETWORK_CHANGE])
    assert.deepEqual(restored, [
      NATIVE_NETWORK_REASON.NETWORK_CHANGE,
      NATIVE_NETWORK_REASON.NETWORK_CHANGE,
    ])
  })
})

// ── Issue 1: main.js downgrade wiring (source contracts) ───────────────────

test('handleConnectivityLost downgrades same user COMPLETE→CACHED behind identity gates', () => {
  const main = readSrc('main.js')
  const idx = main.indexOf('export function handleConnectivityLost(')
  assert.ok(idx > 0, 'main.js must export handleConnectivityLost')
  const chunk = main.slice(idx, idx + 2400)
  // Gate 1: only a stale COMPLETE downgrades.
  assert.match(chunk, /AUTHENTICATED_COMPLETE/)
  // Gates 2-4: state.user, validated snapshot and local-data owner must all
  // match the auth userId — otherwise fail closed (no downgrade).
  assert.match(chunk, /state\.user\?\.id !== uid/)
  assert.match(chunk, /readLastValidatedAccount/)
  assert.match(chunk, /getLocalDataOwner/)
  // Same-user downgrade, never a sign-out or purge.
  assert.match(chunk, /setAuthState\(\{ state: AUTH_STATE\.AUTHENTICATED_CACHED, userId: uid \}\)/)
  assert.equal(/signOut|clearUserScopedUi|deleteQueued|clearLocalDataOwner/.test(chunk), false,
    'loss downgrade must not sign out, purge caches or touch queued work')
  // E: Finds swaps to the offline state immediately.
  assert.match(chunk, /currentScreen === 'finds'[\s\S]*?requestFindsRefresh\(0\)/)
})

test('native monitor is bound with BOTH callbacks; window offline is a loss hint', () => {
  const main = readSrc('main.js')
  assert.match(main, /bindNativeNetworkMonitor\(\{[\s\S]*?onConnectivityRestored:[\s\S]*?onConnectivityLost:\s*reason => handleConnectivityLost\(reason\)/)
  assert.match(main, /addEventListener\('offline', \(\) => \{ void handleConnectivityLost\('window-offline'\) \}\)/)
})

test('no permanent COMPLETE poller: watchdog stays CACHED-only', () => {
  const main = readSrc('main.js')
  const idx = main.indexOf('function _cachedWatchdogEligible()')
  assert.ok(idx > 0)
  const chunk = main.slice(idx, idx + 600)
  assert.match(chunk, /!== AUTH_STATE\.AUTHENTICATED_CACHED\) return false/)
})

// ── Issue 2: local-first Save ───────────────────────────────────────────────

test('review Save performs no network I/O before the durable queue write', () => {
  const review = readSrc('screens/review.js')
  const start = review.indexOf('async function saveObservationBatch()')
  assert.ok(start > 0)
  const enqueueIdx = review.indexOf("_reviewDependency('enqueueObservation')", start)
  assert.ok(enqueueIdx > start)
  const preQueue = review.slice(start, enqueueIdx)
  assert.equal(/supabase|fetchCloudPlanProfile|prepareImageVariants|refreshHome|openFinds\(/.test(preQueue), false,
    'nothing between Save start and enqueueObservation may hit the network')
})

test('post-save refresh/navigation failures cannot surface as "Could not queue observation"', () => {
  const review = readSrc('screens/review.js')
  const start = review.indexOf('async function saveObservationBatch()')
  const enqueueIdx = review.indexOf("_reviewDependency('enqueueObservation')", start)
  const catchIdx = review.indexOf("t('review.syncFailed'", start)
  assert.ok(catchIdx > enqueueIdx)
  const postQueue = review.slice(enqueueIdx, catchIdx)
  // refreshHome and openFinds each run inside their own try/catch so a
  // transport error after the durable write never reaches the outer catch.
  const refreshIdx = postQueue.indexOf("_reviewDependency('refreshHome')")
  const findsIdx = postQueue.indexOf("_reviewDependency('openFinds')")
  assert.ok(refreshIdx > 0 && findsIdx > 0)
  assert.match(postQueue.slice(Math.max(0, refreshIdx - 250), refreshIdx), /try\s*\{/)
  assert.match(postQueue.slice(Math.max(0, findsIdx - 250), findsIdx), /try\s*\{/)
})

test('sync pass survives a transport failure during session refresh (stale-COMPLETE race)', () => {
  const queue = readSrc('sync-queue.js')
  const idx = queue.indexOf('async function _runSyncQueue()')
  const chunk = queue.slice(idx, idx + 1600)
  assert.match(chunk, /try\s*\{\s*\n\s*session = await getSharedAuthSession\(\{ refresh: true \}\)\s*\n\s*\} catch/)
})

test('enqueueObservation is IndexedDB-only (no supabase/network before the commit)', () => {
  const queue = readSrc('sync-queue.js')
  const idx = queue.indexOf('async function _enqueueObservation(')
  assert.ok(idx > 0)
  const end = queue.indexOf('export async function getQueuedObservations', idx)
  const chunk = queue.slice(idx, end)
  assert.equal(/supabase|fetch\(|getSharedAuthSession|fetchCloudPlanProfile/.test(chunk), false)
})

// ── Issue 3: multi-item queue integrity ─────────────────────────────────────

test('K5: a fresh queue item NEVER runs remote recovery (captured_at collision safety)', () => {
  // Q2/Q3 saved offline with the same captured_at as Q1 must insert their
  // own remote rows — recovery is reserved for items whose earlier insert
  // attempt lost its response.
  assert.equal(shouldAttemptRemoteRecovery({ id: 2, obsPayload: { captured_at: '2026-08-18T10:00:00Z' } }), false)
  assert.equal(shouldAttemptRemoteRecovery({ id: 2, syncInsertAttemptedAt: null }), false)
  assert.equal(shouldAttemptRemoteRecovery(null), false)
})

test('K4: an item with a lost insert response IS eligible for reconciliation', () => {
  assert.equal(shouldAttemptRemoteRecovery({ id: 1, syncInsertAttemptedAt: 1_755_000_000_000 }), true)
  // …unless it already has its remote id (nothing to recover).
  assert.equal(shouldAttemptRemoteRecovery({ id: 1, syncInsertAttemptedAt: 1_755_000_000_000, remoteObservationId: 'r1' }), false)
})

test('recovery never resolves to a remote id claimed by another queue item', () => {
  assert.equal(pickRecoveredRemoteObservationId(['r1'], new Set(['r1'])), null)
  assert.equal(pickRecoveredRemoteObservationId(['r1', 'r2'], new Set(['r1'])), 'r2')
  assert.equal(pickRecoveredRemoteObservationId([], new Set()), null)
  assert.equal(pickRecoveredRemoteObservationId(['r3'], new Set()), 'r3')
})

test('processor: attempt marker persists BEFORE the insert; new ids are claimed', () => {
  const queue = readSrc('sync-queue.js')
  const loopIdx = queue.indexOf('for (const item of items) {')
  assert.ok(loopIdx > 0)
  const chunk = queue.slice(loopIdx)
  const markerIdx = chunk.indexOf('syncInsertAttemptedAt: Date.now()')
  const insertIdx = chunk.indexOf(".from('observations').insert(")
  assert.ok(markerIdx > 0 && insertIdx > markerIdx, 'attempt marker must persist before the insert request')
  assert.match(chunk, /obsId = obsData\.id\s*\n\s*claimedRemoteIds\.add\(obsId\)/)
  // Recovery is gated and claim-aware.
  assert.match(chunk, /if \(!obsId && shouldAttemptRemoteRecovery\(item\)\)/)
  assert.match(chunk, /_findRemoteObservationForQueueItem\(\{[\s\S]*?\}, claimedRemoteIds\)/)
  // The claimed set is seeded from EVERY item's persisted remote id.
  assert.match(queue, /const claimedRemoteIds = new Set\(\s*\n\s*items\.map\(other => other\?\.remoteObservationId\)\.filter\(Boolean\)/)
})

test('J: finalization deletes ONLY the confirmed item, after remote proof', () => {
  const queue = readSrc('sync-queue.js')
  const idx = queue.indexOf('async function _finalizeSyncedQueueItem(')
  assert.ok(idx > 0)
  const chunk = queue.slice(idx, idx + 1200)
  // Remote confirmation (parent row + full image count) precedes deletion.
  const confirmIdx = chunk.indexOf('remoteState.observationExists')
  const countIdx = chunk.indexOf('completedIndexes.length >= expectedImageCount')
  const throwIdx = chunk.indexOf('Sync confirmation incomplete')
  const deleteIdx = chunk.indexOf('_deleteQueueItem(item.id)')
  assert.ok(confirmIdx > 0 && countIdx > 0 && throwIdx > 0 && deleteIdx > throwIdx,
    'delete must follow the remote-confirmation throw guard')
  // Only the finalized item's own id is ever deleted (Q1 cannot delete Q2/Q3).
  const loopChunk = queue.slice(queue.indexOf('for (const item of items) {'))
  const deleteCalls = loopChunk.match(/_deleteQueueItem\(([^)]*)\)/g) || []
  assert.deepEqual(deleteCalls, [], 'the processing loop must never delete directly — only _finalizeSyncedQueueItem may')
})

test('K2/K3: a retryable error halts the pass, retaining the failed and later items', () => {
  const queue = readSrc('sync-queue.js')
  const loopChunk = queue.slice(queue.indexOf('for (const item of items) {'))
  // Retryable failures mark the item 'retrying' and break — later items stay
  // queued untouched; the scheduled retry pass resumes them (no duplicate
  // insert for finished items because their queue records are already gone).
  assert.match(loopChunk, /'retrying',[\s\S]*?_scheduleSyncRetry\(\)\s*\n\s*break/)
})

// ── Issue 3 (Finds side): remote rows must never collapse into one card ─────

test('G/I: three synced offline captures all remain visible after reconnect merge', async () => {
  const { _mergeFindsItems } = await import('./screens/finds.js')
  // Q1/Q2/Q3: same user, same date, unidentified, no GPS/notes — captured
  // minutes apart (the exact device-QA shape). After upload they are three
  // DISTINCT remote rows; the merge must keep all three.
  const base = {
    user_id: 'user-a',
    source_type: 'personal',
    date: '2026-08-18',
    genus: null,
    species: null,
    common_name: null,
    visibility: 'private',
    gps_latitude: null,
    gps_longitude: null,
    location: null,
    notes: null,
  }
  const remoteRows = [
    { ...base, id: 'r3', captured_at: '2026-08-18T10:08:00.000Z', created_at: '2026-08-18T10:20:03.000Z' },
    { ...base, id: 'r2', captured_at: '2026-08-18T10:04:00.000Z', created_at: '2026-08-18T10:20:02.000Z' },
    { ...base, id: 'r1', captured_at: '2026-08-18T10:00:00.000Z', created_at: '2026-08-18T10:20:01.000Z' },
  ]
  const merged = _mergeFindsItems('mine', [], remoteRows)
  assert.deepEqual(merged.map(o => o.id).sort(), ['r1', 'r2', 'r3'],
    'remote-vs-remote likely-same matching must never drop distinct observations')
})

test('pending-vs-remote dedup still collapses a queued card with its synced row', async () => {
  const { _mergeFindsItems } = await import('./screens/finds.js')
  const queued = {
    id: 'queued-7',
    _pendingSync: true,
    user_id: 'user-a',
    source_type: 'personal',
    date: '2026-08-18',
    genus: null,
    species: null,
    common_name: null,
    visibility: 'private',
    gps_latitude: null,
    gps_longitude: null,
    location: null,
    notes: null,
    captured_at: '2026-08-18T10:00:00.000Z',
  }
  const remote = { ...queued, id: 'r1', _pendingSync: undefined }
  const merged = _mergeFindsItems('mine', [queued], [remote])
  assert.equal(merged.length, 1, 'a synced twin of a still-queued card must not double-render')
  assert.equal(merged[0].id, 'queued-7')
})

test('explicit remote-id linkage dedupes regardless of field similarity', async () => {
  const { _mergeFindsItems } = await import('./screens/finds.js')
  const queued = {
    id: 'queued-9',
    _pendingSync: true,
    _remoteObservationId: 'r9',
    user_id: 'user-a',
    date: '2026-08-18',
    notes: 'totally different notes',
    captured_at: '2026-08-18T09:00:00.000Z',
  }
  const remote = {
    id: 'r9',
    user_id: 'user-a',
    date: '2026-08-18',
    notes: null,
    captured_at: '2026-08-18T09:00:00.000Z',
  }
  const merged = _mergeFindsItems('mine', [queued], [remote])
  assert.equal(merged.length, 1)
})
