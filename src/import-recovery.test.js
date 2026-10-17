// Android import recovery (formerly G5 I6), Stage 1: the saved import sessions
// (`sporely` / `pending_import`) and the sync queue (`sporely_sync`) are
// separate databases. These tests run the production store, Queue All and
// Cancel code against a fake IndexedDB that models what matters here: a
// transaction commits all of its operations or none, an aborted transaction
// rolls back, an open can be blocked, and a commit can be held open to stand
// in for a process that dies before it lands. Each test names the fix it
// depends on; docs/verification/2026-10-android-import-recovery.md records
// that each one fails with that fix disabled.
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from './auth-state.js'
// CACHED: queueing is local-only and triggerSync() stays off the network.
setAuthState({ state: AUTH_STATE.AUTHENTICATED_CACHED, userId: 'test-user' })

import { state } from './state.js'
import { t, tp } from './i18n.js'
import { INGEST_METHOD } from './observation-shapes.js'
import {
  _enqueueImportStoreWrite,
  clearImportSessionsStrict,
  deleteImportSession,
  loadImportSessions,
  saveImportSessions,
} from './import-store.js'
import { enqueueObservation } from './sync-queue.js'
import {
  _buildImportSourceItem,
  __cancelImportForTests,
  __getImportSessionsForTests,
  __removeImportSourceItemsForTests,
  __saveAllForTests,
  __setImportAiSessionsForTests,
  __setImportAiTestHooks,
  __setImportSourceItemsForTests,
} from './screens/import_review.js'

// ── DOM / window stubs (same shape as import-persist-failure.test.js) ───────
const elements = new Map()
globalThis.document = globalThis.document || {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { style: {}, disabled: false, textContent: '', addEventListener() {} })
    return elements.get(id)
  },
}
globalThis.window = globalThis.window || {}
globalThis.window.confirm = () => true
globalThis.window.dispatchEvent = () => true
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {}

// ── Fake IndexedDB ──────────────────────────────────────────────────────────
function domError(name, message = name) {
  return Object.assign(new Error(message), { name })
}

function createFakeIndexedDb() {
  const databases = new Map()
  const log = []
  const faults = {
    blockOpens: 0, // the next N opens fire onblocked
    succeedAfterBlock: false, // a blocked open later succeeds anyway
    putThrowsOnCall: 0, // the Nth put() throws DataCloneError synchronously
    failCommit: null, // (dbName, ops) => Error | null
    holdCommit: null, // (dbName, ops) => Promise | null
  }
  let putCalls = 0
  let openConnections = 0
  let nextKey = 1

  function storeOf(dbName) {
    if (!databases.has(dbName)) databases.set(dbName, new Map())
    return databases.get(dbName)
  }

  function makeTransaction(dbName, mode, options) {
    const ops = []
    const committed = storeOf(dbName)
    let txState = 'active'
    const tx = {
      mode,
      options,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => store,
      abort() {
        if (txState !== 'active') throw domError('InvalidStateError')
        txState = 'aborted'
        log.push({ type: 'abort', dbName, ops: ops.map(op => op[0]) })
        setTimeout(() => tx.onabort?.({ target: tx }), 0)
      },
    }
    const request = () => ({ onsuccess: null, onerror: null, result: undefined, error: null })
    const store = {
      clear() { ops.push(['clear']) },
      put(value) {
        putCalls++
        if (faults.putThrowsOnCall && putCalls === faults.putThrowsOnCall) throw domError('DataCloneError')
        ops.push(['put', structuredClone(value)])
      },
      delete(key) { ops.push(['delete', key]) },
      add(value) {
        const req = request()
        ops.push(['add', structuredClone(value)])
        // A request succeeds before its transaction commits; only
        // oncomplete means the write is durable.
        setTimeout(() => req.onsuccess?.({ target: req }), 0)
        return req
      },
      getAll() {
        const req = request()
        setTimeout(() => {
          req.result = [...committed.values()].map(value => structuredClone(value))
          req.onsuccess?.({ target: req })
        }, 0)
        return req
      },
    }
    log.push({ type: 'tx', dbName, mode, options })
    setTimeout(async () => {
      if (txState !== 'active') return
      const hold = faults.holdCommit?.(dbName, ops)
      if (hold) await hold
      if (txState !== 'active') return
      const err = faults.failCommit?.(dbName, ops)
      if (err) {
        txState = 'aborted'
        tx.error = err
        log.push({ type: 'commit-failed', dbName, ops: ops.map(op => op[0]) })
        tx.onerror?.({ target: tx })
        tx.onabort?.({ target: tx })
        return
      }
      for (const [kind, arg] of ops) {
        if (kind === 'clear') committed.clear()
        else if (kind === 'put') committed.set(arg.id, arg)
        else if (kind === 'delete') committed.delete(arg)
        else if (kind === 'add') committed.set(nextKey, { ...arg, id: nextKey++ })
      }
      txState = 'done'
      log.push({ type: 'commit', dbName, ops: ops.map(op => (op[0] === 'delete' ? `delete:${op[1]}` : op[0])) })
      tx.oncomplete?.({ target: tx })
    }, 0)
    return tx
  }

  return {
    faults,
    log,
    get openConnections() { return openConnections },
    ids(dbName = 'sporely') { return [...storeOf(dbName).keys()].sort() },
    records(dbName) { return [...storeOf(dbName).values()] },
    open(name) {
      const req = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null }
      const succeed = () => {
        openConnections++
        let closed = false
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {
            if (closed) return
            closed = true
            openConnections--
          },
          transaction: (_store, mode, options) => makeTransaction(name, mode, options),
        }
        req.onsuccess?.({ target: req })
      }
      setTimeout(() => {
        if (faults.blockOpens > 0) {
          faults.blockOpens--
          req.onblocked?.({ target: req })
          if (faults.succeedAfterBlock) setTimeout(succeed, 0)
          return
        }
        succeed()
      }, 0)
      return req
    },
  }
}

// ── Fixtures and harness ────────────────────────────────────────────────────
function makeSession(id) {
  return {
    id,
    ts: new Date('2026-10-16T21:52:00Z'),
    files: [new Blob([`${id}-a`], { type: 'image/jpeg' }), new Blob([`${id}-b`], { type: 'image/jpeg' })],
    aiFiles: [new Blob([`${id}-a`], { type: 'image/jpeg' }), new Blob([`${id}-b`], { type: 'image/jpeg' })],
    blobUrls: [],
    sourceItemIds: [`${id}-s1`, `${id}-s2`],
    photoTimes: [],
    photoGps: [],
    photoDebug: [],
    imageMeta: [],
    gpsLat: 63.43,
    gpsLon: 10.39,
    gpsAltitude: 10,
    gpsAccuracy: 5,
    gpsSource: 'photo_exif',
    aiPredictions: [],
    aiPredictionsByService: {},
    aiServiceState: {},
  }
}

const enqueueFailure = () => domError('UnknownError', 'The operation failed for reasons unrelated to the database itself')

// The group a queue item came from, read from its first photo's bytes.
async function groupOf(item) {
  const text = await item.imageEntries[0].blob.text()
  return text.split('-')[0]
}

// Real store (save, delete, strict clear) and the real Queue All; only the
// sync-queue write, toasts, rendering and navigation are replaced.
function harness({ enqueue = async () => {}, ...overrides } = {}) {
  const queue = []
  const toasts = []
  const calls = { navigated: 0 }
  __setImportAiTestHooks({
    enqueueObservation: async (obsPayload, imageEntries) => {
      await enqueue(obsPayload, imageEntries)
      queue.push({ obsPayload, imageEntries })
    },
    showToast: message => toasts.push(message),
    openFinds: async () => { calls.navigated++ },
    renderSessions: () => {},
    ...overrides,
  })
  return { queue, toasts, calls }
}

// Resolves once every store write issued so far has settled.
function storeIdle() {
  return _enqueueImportStoreWrite(() => {})
}

let idb
let previousIndexedDb
beforeEach(() => {
  previousIndexedDb = globalThis.indexedDB
  idb = createFakeIndexedDb()
  globalThis.indexedDB = idb
  state.user = { id: 'test-user' }
  globalThis.window.confirm = () => true
})

afterEach(async () => {
  __setImportAiTestHooks(null)
  __setImportAiSessionsForTests([])
  await storeIdle()
  globalThis.indexedDB = previousIndexedDb
})

// ── T1 ──────────────────────────────────────────────────────────────────────
test('T1 a put() that throws synchronously aborts the save and keeps the stored groups', async () => {
  assert.equal(await saveImportSessions([makeSession('A'), makeSession('B')]), true)
  assert.deepEqual(idb.ids(), ['A', 'B'])

  idb.faults.putThrowsOnCall = 4 // A, B above; then C ok, D throws
  const ok = await saveImportSessions([makeSession('C'), makeSession('D'), makeSession('E')])

  assert.equal(ok, false)
  assert.deepEqual(idb.ids(), ['A', 'B'], 'the clear and the earlier put rolled back')
  assert.ok(idb.log.some(entry => entry.type === 'abort'), 'transaction aborted')
  assert.equal(idb.openConnections, 0, 'connection closed')
})

// ── T2 ──────────────────────────────────────────────────────────────────────
test('T2 a group is deleted only after its enqueue resolved, and never after a rejection', async () => {
  const events = []
  await saveImportSessions([makeSession('A'), makeSession('B'), makeSession('C')])
  __setImportAiSessionsForTests([makeSession('A'), makeSession('B'), makeSession('C')])
  const { queue } = harness({
    enqueue: async (_payload, imageEntries) => {
      const group = await groupOf({ imageEntries })
      events.push(`enqueue:${group}:start`)
      await new Promise(resolve => setTimeout(resolve, 5))
      if (group === 'B') {
        events.push('enqueue:B:rejected')
        throw enqueueFailure()
      }
      events.push(`enqueue:${group}:resolved`)
    },
    deleteImportSession: async id => {
      events.push(`delete:${id}:start`)
      const ok = await deleteImportSession(id)
      events.push(`delete:${id}:${ok ? 'committed' : 'failed'}`)
      return ok
    },
  })

  await __saveAllForTests()

  assert.deepEqual(events, [
    'enqueue:A:start', 'enqueue:A:resolved', 'delete:A:start', 'delete:A:committed',
    'enqueue:B:start', 'enqueue:B:rejected',
    'enqueue:C:start', 'enqueue:C:resolved', 'delete:C:start', 'delete:C:committed',
  ])
  assert.equal(queue.length, 2)
  assert.deepEqual(idb.ids(), ['B'])
})

// ── T3 ──────────────────────────────────────────────────────────────────────
test('T3 process death while B is being queued: only B is stored and restored', async () => {
  await saveImportSessions([makeSession('A'), makeSession('B')])
  __setImportAiSessionsForTests([makeSession('A'), makeSession('B')])
  let enqueueBStarted
  const bStarted = new Promise(resolve => { enqueueBStarted = resolve })
  harness({
    enqueue: async (_payload, imageEntries) => {
      if ((await imageEntries[0].blob.text()).startsWith('B')) {
        enqueueBStarted()
        await new Promise(() => {}) // the process dies here: never settles
      }
    },
  })

  void __saveAllForTests()
  await bStarted
  await storeIdle()

  assert.deepEqual(idb.ids(), ['B'], 'queued A was removed before B was queued')
  const restored = await loadImportSessions()
  assert.deepEqual(restored.map(session => session.id), ['B'])
})

// ── T4 ──────────────────────────────────────────────────────────────────────
test('T4 Codex: queue A, fail B, fail the rewrite, restart, retry: one A and one B', async () => {
  await saveImportSessions([makeSession('A'), makeSession('B')])
  __setImportAiSessionsForTests([makeSession('A'), makeSession('B')])
  let failB = true
  const { queue, toasts } = harness({
    enqueue: async (_payload, imageEntries) => {
      if (failB && (await imageEntries[0].blob.text()).startsWith('B')) {
        // From here on every full rewrite (clear + put) fails.
        idb.faults.failCommit = (dbName, ops) => (ops.some(op => op[0] === 'clear') ? domError('QuotaExceededError') : null)
        throw enqueueFailure()
      }
    },
  })

  await __saveAllForTests()
  assert.ok(toasts.includes(t('import.persistFailed')), 'failed rewrite is reported')
  assert.deepEqual(__getImportSessionsForTests().map(s => s.id), ['B'])

  // Restart: memory is gone; the review is restored from the store.
  idb.faults.failCommit = null
  failB = false
  __setImportAiSessionsForTests([])
  const restored = await loadImportSessions()
  assert.deepEqual(restored.map(session => session.id), ['B'], 'A is not restored')
  __setImportAiSessionsForTests(restored)
  await __saveAllForTests()

  const groups = await Promise.all(queue.map(groupOf))
  assert.deepEqual(groups.sort(), ['A', 'B'], 'each group queued exactly once')
  assert.deepEqual(idb.ids(), [])
})

// ── T5 ──────────────────────────────────────────────────────────────────────
test('T5 delete(A) fails and the rewrite fails: the user is warned, no success', async () => {
  await saveImportSessions([makeSession('A'), makeSession('B')])
  __setImportAiSessionsForTests([makeSession('A'), makeSession('B')])
  const { queue, toasts, calls } = harness({
    enqueue: async (_payload, imageEntries) => {
      idb.faults.failCommit = () => domError('UnknownError')
      if ((await imageEntries[0].blob.text()).startsWith('B')) throw enqueueFailure()
    },
  })

  await __saveAllForTests()

  assert.equal(queue.length, 1, 'A queued once and not re-queued')
  assert.deepEqual(__getImportSessionsForTests().map(s => s.id), ['B'])
  assert.ok(toasts.includes(t('import.persistFailed')), 'persist failure surfaced')
  assert.ok(!toasts.some(message => message === t('import.saved', { count: tp('counts.observation', 1) })), 'no success toast')
  assert.equal(calls.navigated, 0)
})

test('T5 all queued but the deletes and the strict clear fail: warned, not reported as a clean save', async () => {
  await saveImportSessions([makeSession('A')])
  __setImportAiSessionsForTests([makeSession('A')])
  const { queue, toasts } = harness({
    enqueue: async () => { idb.faults.failCommit = () => domError('UnknownError') },
  })

  await __saveAllForTests()

  assert.equal(queue.length, 1)
  assert.deepEqual(toasts, [t('import.queuedClearFailed', { count: tp('counts.observation', 1) })])
  assert.deepEqual(idb.ids(), ['A'], 'the store really still holds A; the warning is truthful')
})

// ── T6 ──────────────────────────────────────────────────────────────────────
test('T6 a slow session write begun before Queue All cannot resurrect queued groups', async () => {
  __setImportAiSessionsForTests([makeSession('A'), makeSession('B')])
  harness()
  // A fire-and-forget _persistSessions() from a UI handler, still reading
  // its file bytes when the user taps Queue All.
  let releaseBytes
  const bytesGate = new Promise(resolve => { releaseBytes = resolve })
  const snapshotA = makeSession('A')
  const slowFile = snapshotA.files[0]
  snapshotA.files = [{ type: 'image/jpeg', arrayBuffer: async () => { await bytesGate; return slowFile.arrayBuffer() } }, snapshotA.files[1]]
  const slowSave = saveImportSessions([snapshotA, makeSession('B')])

  const saving = __saveAllForTests()
  // Release the bytes when Queue All finishes, or after 300 ms if Queue All
  // is (correctly) waiting behind the slow write.
  await Promise.race([saving, new Promise(resolve => setTimeout(resolve, 300))])
  releaseBytes()
  await saving
  assert.equal(await slowSave, true)
  await storeIdle()

  assert.deepEqual(idb.ids(), [], 'no queued group left in the store')
})

// ── T7 ──────────────────────────────────────────────────────────────────────
test('T7 a rejected, a throwing and a blocked write each settle and release the chain', async () => {
  const ran = []
  const within = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} never settled`)), 1000)),
  ])
  const rejected = _enqueueImportStoreWrite(async () => { ran.push('rejected'); throw domError('UnknownError', 'r') })
  const throwing = _enqueueImportStoreWrite(() => { ran.push('throwing'); throw domError('DataCloneError', 't') })
  idb.faults.blockOpens = 2
  idb.faults.succeedAfterBlock = true
  const blockedSave = saveImportSessions([makeSession('A')])
  const blockedStrictClear = clearImportSessionsStrict()
  const next = deleteImportSession('nothing-here')

  await assert.rejects(within(rejected, 'rejected op'), { message: 'r' })
  await assert.rejects(within(throwing, 'throwing op'), { name: 'DataCloneError', message: 't' })
  assert.equal(await within(blockedSave, 'blocked save'), false)
  await assert.rejects(within(blockedStrictClear, 'blocked strict clear'), { name: 'BlockedError' })
  assert.equal(await within(next, 'next op'), true, 'the following write still ran and committed')
  assert.deepEqual(ran, ['rejected', 'throwing'])
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(idb.openConnections, 0, 'late connections from the blocked opens were closed')
})

// ── T8 ──────────────────────────────────────────────────────────────────────
test('T8 Home/Cancel with groups: declining changes nothing; confirming discards', async () => {
  await saveImportSessions([makeSession('A'), makeSession('B')])
  __setImportAiSessionsForTests([makeSession('A'), makeSession('B')])
  const prompts = []
  const navigations = []
  let answer = false
  harness({
    confirm: message => { prompts.push(message); return answer },
    navigate: screen => navigations.push(screen),
  })

  __cancelImportForTests()
  await storeIdle()
  assert.deepEqual(prompts, [t('import.discardConfirm', { groups: tp('counts.group', 2) })])
  assert.deepEqual(__getImportSessionsForTests().map(s => s.id), ['A', 'B'], 'memory unchanged')
  assert.deepEqual(idb.ids(), ['A', 'B'], 'store unchanged')
  assert.deepEqual(navigations, [], 'stays on the review')

  answer = true
  __cancelImportForTests()
  await storeIdle()
  assert.equal(prompts.length, 2)
  assert.deepEqual(__getImportSessionsForTests(), [])
  assert.deepEqual(idb.ids(), [])
  assert.deepEqual(navigations, ['home'])
})

test('T8 Home/Cancel with no groups: no prompt', async () => {
  __setImportAiSessionsForTests([])
  const prompts = []
  const navigations = []
  harness({
    confirm: message => { prompts.push(message); return false },
    navigate: screen => navigations.push(screen),
  })

  __cancelImportForTests()
  await storeIdle()

  assert.deepEqual(prompts, [])
  assert.deepEqual(navigations, ['home'])
})

// ── T9 ──────────────────────────────────────────────────────────────────────
test('T9 mixed methods before rejection: the kept group keeps both photos and methods; retry queues them', async () => {
  const T0 = Date.parse('2026-10-12T09:00:00Z')
  const photo = (label, method, captureTime) => _buildImportSourceItem(`sel-${label}`, { captureTime }, {
    blob: new Blob([`G-${label}`], { type: 'image/jpeg' }),
    aiBlob: new Blob([`ai-${label}`], { type: 'image/jpeg' }),
    meta: { aiCropRect: null, aiCropSourceW: 100, aiCropSourceH: 100, aiCropIsCustom: false },
  }, method)
  // Native picker A and B, then a file-picker photo C added to the same
  // group; B is removed afterwards.
  const items = [
    photo('A', INGEST_METHOD.NATIVE_PICKER, T0),
    photo('B', INGEST_METHOD.NATIVE_PICKER, T0 + 10_000),
    photo('C', INGEST_METHOD.WEB_FILE_PICKER, T0 + 20_000),
  ]
  try {
    assert.equal(__setImportSourceItemsForTests(items)[0].files.length, 3)
    const grouped = __removeImportSourceItemsForTests(['sel-B'])
    assert.equal(grouped.length, 1)
    for (const session of grouped) Object.assign(session, { gpsLat: 63.43, gpsLon: 10.39, gpsAltitude: 10, gpsAccuracy: 5 })

    let reject = true
    const { queue } = harness({
      enqueue: async () => { if (reject) throw enqueueFailure() },
    })
    await __saveAllForTests()

    const methodsAndBytes = async session => Promise.all(session.files.map(async (file, index) => [
      await file.text(), session.imageMeta[index]?.ingestMethod,
    ]))
    const expected = [['G-A', INGEST_METHOD.NATIVE_PICKER], ['G-C', INGEST_METHOD.WEB_FILE_PICKER]]
    const kept = __getImportSessionsForTests()
    assert.equal(kept.length, 1)
    assert.deepEqual(await methodsAndBytes(kept[0]), expected, 'kept in memory')
    const stored = await loadImportSessions()
    assert.deepEqual(await methodsAndBytes(stored[0]), expected, 'kept in the store')

    reject = false
    await __saveAllForTests()
    assert.equal(queue.length, 1)
    const queued = await Promise.all(queue[0].imageEntries.map(async entry => [await entry.blob.text(), entry.ingestMethod]))
    assert.deepEqual(queued, expected, 'retry queues the same photos and methods')
  } finally {
    __setImportSourceItemsForTests([])
  }
})

// ── T10 ─────────────────────────────────────────────────────────────────────
test('T10 enqueueObservation opens a strict-durability transaction and resolves only on oncomplete', async () => {
  let releaseCommit
  idb.faults.holdCommit = dbName => (dbName === 'sporely_sync'
    ? new Promise(resolve => { releaseCommit = resolve })
    : null)

  let settled = false
  const queued = enqueueObservation({ user_id: 'test-user' }, []).then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))

  const queueTx = idb.log.find(entry => entry.type === 'tx' && entry.dbName === 'sporely_sync')
  assert.deepEqual(queueTx.options, { durability: 'strict' })
  assert.equal(queueTx.mode, 'readwrite')
  assert.equal(settled, false, 'not resolved by the add request or before the commit')
  assert.ok(releaseCommit, 'commit is being held')

  releaseCommit()
  await queued
  assert.equal(settled, true)
  assert.equal(idb.records('sporely_sync').length, 1)
})

test('T10 an aborted queue commit rejects and nothing is queued', async () => {
  idb.faults.failCommit = dbName => (dbName === 'sporely_sync' ? domError('QuotaExceededError') : null)
  await assert.rejects(enqueueObservation({ user_id: 'test-user' }, []), { name: 'QuotaExceededError' })
  assert.equal(idb.records('sporely_sync').length, 0)
})
