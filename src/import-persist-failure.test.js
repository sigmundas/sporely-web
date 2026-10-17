// G5 I6 regression: a failed import-session save or queue write must never
// clear the group, discard its pending content or present success.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from './auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import { state } from './state.js'
import { t, tp } from './i18n.js'
import { saveImportSessions } from './import-store.js'
import {
  __getImportSessionsForTests,
  __saveAllForTests,
  __setImportAiSessionsForTests,
  __setImportAiTestHooks,
} from './screens/import_review.js'

function element() {
  return { style: {}, disabled: false, textContent: '', addEventListener() {} }
}

const elements = new Map()
globalThis.document = globalThis.document || {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  },
}
globalThis.window = globalThis.window || {}
globalThis.window.confirm = () => true
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {}

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

function harness({ failEnqueueFor = () => false, persistResult = true } = {}) {
  const queue = []
  const toasts = []
  const calls = { cleared: 0, navigated: 0, persisted: [] }
  __setImportAiTestHooks({
    enqueueObservation: async (obsPayload, imageEntries) => {
      if (failEnqueueFor(obsPayload, imageEntries)) {
        throw Object.assign(new Error('The operation failed for reasons unrelated to the database itself'), { name: 'UnknownError' })
      }
      queue.push({ obsPayload, imageEntries })
    },
    showToast: message => toasts.push(message),
    clearImportSessions: async () => { calls.cleared++ },
    openFinds: async () => { calls.navigated++ },
    persistSessions: async sessions => {
      calls.persisted.push(sessions.map(s => s.id))
      return typeof persistResult === 'function' ? persistResult(sessions) : persistResult
    },
    renderSessions: () => {},
  })
  return { queue, toasts, calls }
}

afterEach(() => {
  __setImportAiTestHooks(null)
  __setImportAiSessionsForTests([])
})

state.user = { id: 'test-user' }

test('a queue write failure keeps the group, reports an error and no success', async () => {
  __setImportAiSessionsForTests([makeSession('g1')])
  const { queue, toasts, calls } = harness({ failEnqueueFor: () => true })

  await __saveAllForTests()

  const sessions = __getImportSessionsForTests()
  assert.deepEqual(sessions.map(s => s.id), ['g1'])
  assert.equal(sessions[0].files.length, 2, 'pending content retained')
  assert.equal(queue.length, 0)
  assert.equal(calls.cleared, 0, 'persisted sessions not cleared')
  assert.equal(calls.navigated, 0, 'stays on the review')
  assert.deepEqual(toasts, [t('import.notQueued', { failed: 1 })])
  assert.ok(!toasts.includes(t('import.saved', { count: tp('counts.observation', 1) })), 'no success toast')
  assert.deepEqual(calls.persisted, [['g1']], 'kept group persisted for retry')
})

test('mixed batch: first group queues, second fails and stays; retry queues it once', async () => {
  __setImportAiSessionsForTests([makeSession('g1'), makeSession('g2')])
  let failing = true
  const { queue, toasts, calls } = harness({
    failEnqueueFor: () => failing && queue.length >= 1,
  })

  await __saveAllForTests()

  let sessions = __getImportSessionsForTests()
  assert.equal(queue.length, 1, 'group 1 queued')
  assert.deepEqual(sessions.map(s => s.id), ['g2'], 'only the failed group remains')
  assert.equal(sessions[0].files.length, 2)
  assert.equal(calls.cleared, 0)
  assert.equal(calls.navigated, 0)
  assert.deepEqual(toasts, [t('import.partiallyQueued', { count: tp('counts.observation', 1), failed: 1 })])
  assert.deepEqual(calls.persisted.at(-1), ['g2'])

  failing = false
  await __saveAllForTests()

  sessions = __getImportSessionsForTests()
  assert.equal(queue.length, 2, 'retry queued exactly the failed group')
  assert.equal(sessions.length, 0)
  assert.equal(calls.cleared, 1)
  assert.equal(calls.navigated, 1)
  const imageSets = queue.map(item => item.imageEntries.length)
  assert.deepEqual(imageSets, [2, 2])
})

test('a session save failure is reported and the sessions stay in the review', async () => {
  __setImportAiSessionsForTests([makeSession('g1'), makeSession('g2')])
  const { queue, toasts, calls } = harness({
    persistResult: false,
    failEnqueueFor: () => queue.length >= 1,
  })

  await __saveAllForTests()

  assert.deepEqual(__getImportSessionsForTests().map(s => s.id), ['g2'])
  assert.ok(toasts.includes(t('import.persistFailed')), 'session save failure surfaced')
  assert.ok(!toasts.includes(t('import.saved', { count: tp('counts.observation', 1) })))
  assert.equal(calls.cleared, 0)
})

test('saveImportSessions returns false and does not throw when IndexedDB fails', async () => {
  const previous = globalThis.indexedDB
  const session = makeSession('g1')
  try {
    globalThis.indexedDB = {
      open() {
        const request = {}
        queueMicrotask(() => {
          request.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
          request.onerror?.({ target: request })
        })
        return request
      },
    }
    assert.equal(await saveImportSessions([session]), false)

    // The store write itself aborts.
    globalThis.indexedDB = {
      open() {
        const request = {}
        queueMicrotask(() => {
          request.result = {
            objectStoreNames: { contains: () => true },
            close() {},
            transaction() {
              const tx = { error: Object.assign(new Error('clone'), { name: 'DataCloneError' }) }
              tx.objectStore = () => ({ clear() {}, put() {} })
              queueMicrotask(() => tx.onabort?.())
              return tx
            },
          }
          request.onsuccess?.({ target: request })
        })
        return request
      },
    }
    assert.equal(await saveImportSessions([session]), false)
    // A file that can no longer be read fails before any transaction.
    const unreadable = { ...session, files: [{ type: 'image/jpeg', arrayBuffer: () => Promise.reject(Object.assign(new Error('gone'), { name: 'NotReadableError' })) }] }
    assert.equal(await saveImportSessions([unreadable]), false)
    assert.equal(session.files.length, 2, 'caller content untouched')
  } finally {
    globalThis.indexedDB = previous
  }
})
