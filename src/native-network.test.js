// Native connectivity monitor (@capacitor/network wrapper) — behavioral
// tests with injected plugin fakes. The monitor is a SIGNAL only: it must
// never import auth/capability/sync modules. Both edges are surfaced —
// false→true wakes the deduped revalidation (onConnectivityRestored) and
// true→false notifies the optional loss callback (onConnectivityLost; QA
// round 2 — see connectivity-loss.test.js). It takes no action itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  NATIVE_NETWORK_REASON,
  bindNativeNetworkMonitor,
  unbindNativeNetworkMonitor,
  _nativeNetworkMonitorStateForTests,
} from './native-network.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const moduleSource = readFileSync(join(__dirname, 'native-network.js'), 'utf8')

function makeFakeNetwork({ initialConnected = false, connectionType = 'wifi' } = {}) {
  const listeners = new Map()
  let removed = 0
  const network = {
    status: { connected: initialConnected, connectionType },
    async getStatus() { return { ...this.status } },
    async addListener(event, cb) {
      listeners.set(event, cb)
      return { remove: async () => { listeners.delete(event); removed += 1 } }
    },
    emit(event, payload) {
      const cb = listeners.get(event)
      if (cb) cb(payload)
    },
    hasListener(event) { return listeners.has(event) },
    removedCount() { return removed },
  }
  return network
}

function makeFakeDocument({ visibilityState = 'visible' } = {}) {
  const listeners = new Map()
  return {
    visibilityState,
    addEventListener(event, cb) { listeners.set(event, cb) },
    removeEventListener(event) { listeners.delete(event) },
    emit(event) { const cb = listeners.get(event); if (cb) cb() },
    hasListener(event) { return listeners.has(event) },
  }
}

function makeFakeApp() {
  const listeners = new Map()
  return {
    async addListener(event, cb) {
      listeners.set(event, cb)
      return { remove: async () => { listeners.delete(event) } }
    },
    emit(event) { const cb = listeners.get(event); if (cb) cb() },
    hasListener(event) { return listeners.has(event) },
  }
}

const noAppPlugin = {} // shape without addListener → resume wiring skipped

async function withMonitor(options, run) {
  try {
    await run()
  } finally {
    await unbindNativeNetworkMonitor()
  }
}

test('bind is a NO-OP on web platforms (browser fallback retained elsewhere)', async () => {
  await withMonitor({}, async () => {
    const network = makeFakeNetwork()
    const result = await bindNativeNetworkMonitor({
      onConnectivityRestored: () => { throw new Error('must not fire on web') },
      network,
      app: noAppPlugin,
      native: false,
      documentRef: makeFakeDocument(),
    })
    assert.deepEqual(result, { bound: false, reason: 'web-platform' })
    assert.equal(network.hasListener('networkStatusChange'), false)
    assert.equal(_nativeNetworkMonitorStateForTests().bound, false)
  })
})

test('bind registers the networkStatusChange listener on native', async () => {
  await withMonitor({}, async () => {
    const network = makeFakeNetwork()
    const doc = makeFakeDocument()
    const result = await bindNativeNetworkMonitor({
      onConnectivityRestored: () => {},
      network,
      app: noAppPlugin,
      native: true,
      documentRef: doc,
    })
    assert.deepEqual(result, { bound: true, reason: 'bound' })
    assert.equal(network.hasListener('networkStatusChange'), true)
    assert.equal(doc.hasListener('visibilitychange'), true)
  })
})

test('bind is idempotent — a second call does not double-register', async () => {
  await withMonitor({}, async () => {
    const network = makeFakeNetwork()
    const first = await bindNativeNetworkMonitor({
      onConnectivityRestored: () => {},
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    assert.equal(first.bound, true)
    const handlesAfterFirst = _nativeNetworkMonitorStateForTests().handleCount
    const second = await bindNativeNetworkMonitor({
      onConnectivityRestored: () => {},
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    assert.deepEqual(second, { bound: true, reason: 'already-bound' })
    assert.equal(_nativeNetworkMonitorStateForTests().handleCount, handlesAfterFirst)
  })
})

test('connected false→true edge requests revalidation with native-network-change', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: false })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    network.emit('networkStatusChange', { connected: false, connectionType: 'none' })
    assert.deepEqual(reasons, [], 'going offline must trigger nothing')
    network.emit('networkStatusChange', { connected: true, connectionType: 'wifi' })
    assert.deepEqual(reasons, [NATIVE_NETWORK_REASON.NETWORK_CHANGE])
  })
})

test('connected === false never wakes the RESTORE path (no upload start)', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: true })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    network.emit('networkStatusChange', { connected: false, connectionType: 'none' })
    network.emit('networkStatusChange', { connected: false, connectionType: 'none' })
    assert.deepEqual(reasons, [])
    assert.equal(_nativeNetworkMonitorStateForTests().lastConnected, false)
  })
})

test('QA3: EVERY connected=true event notifies — wake-up, not edge-dependent (dedupe lives downstream)', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: false })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    // Device QA (round 3): a preceding false event can be lost, or the
    // WebView paused across the transition — connected=true must always wake
    // the deduped revalidation, even with lastConnected already true/null.
    network.emit('networkStatusChange', { connected: true, connectionType: 'wifi' })
    network.emit('networkStatusChange', { connected: true, connectionType: 'wifi' })
    network.emit('networkStatusChange', { connected: true, connectionType: 'cellular' })
    assert.equal(reasons.length, 3, 'every connected=true event is a wake-up')
    assert.ok(reasons.every(reason => reason === NATIVE_NETWORK_REASON.NETWORK_CHANGE))
  })
})

test('binding seeds getStatus WITHOUT notifying (boot already probed)', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: true })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    assert.deepEqual(reasons, [], 'seed must not notify')
    assert.equal(_nativeNetworkMonitorStateForTests().lastConnected, true)
    // QA round 3: a later true EVENT is a wake-up even when the seed already
    // said connected — a lost false edge must not suppress recovery.
    network.emit('networkStatusChange', { connected: true, connectionType: 'wifi' })
    assert.deepEqual(reasons, [NATIVE_NETWORK_REASON.NETWORK_CHANGE])
  })
})

test('foreground visibility runs getStatus and catches a missed reconnect', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: false })
    const doc = makeFakeDocument({ visibilityState: 'visible' })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: doc,
    })
    // Device reconnected while backgrounded; the change event was missed.
    network.status.connected = true
    doc.emit('visibilitychange')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(reasons, [NATIVE_NETWORK_REASON.RESUME_STATUS])
  })
})

test('hidden visibility does NOT run the resume status check', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: false })
    const doc = makeFakeDocument({ visibilityState: 'hidden' })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: doc,
    })
    network.status.connected = true
    doc.emit('visibilitychange')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(reasons, [])
  })
})

test('resume getStatus with connected=false never wakes the RESTORE path', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: false })
    const doc = makeFakeDocument({ visibilityState: 'visible' })
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app: noAppPlugin,
      native: true,
      documentRef: doc,
    })
    doc.emit('visibilitychange')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(reasons, [], 'still offline — nothing to wake')
  })
})

test('Capacitor App resume event also runs the getStatus check', async () => {
  await withMonitor({}, async () => {
    const reasons = []
    const network = makeFakeNetwork({ initialConnected: false })
    const app = makeFakeApp()
    await bindNativeNetworkMonitor({
      onConnectivityRestored: reason => reasons.push(reason),
      network,
      app,
      native: true,
      documentRef: makeFakeDocument(),
    })
    assert.equal(app.hasListener('resume'), true)
    network.status.connected = true
    app.emit('resume')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(reasons, [NATIVE_NETWORK_REASON.RESUME_STATUS])
  })
})

test('unbind removes plugin listeners and DOM listeners', async () => {
  const network = makeFakeNetwork({ initialConnected: false })
  const doc = makeFakeDocument()
  const app = makeFakeApp()
  await bindNativeNetworkMonitor({
    onConnectivityRestored: () => {},
    network,
    app,
    native: true,
    documentRef: doc,
  })
  assert.equal(network.hasListener('networkStatusChange'), true)
  await unbindNativeNetworkMonitor()
  assert.equal(network.hasListener('networkStatusChange'), false)
  assert.equal(network.removedCount() >= 1, true)
  assert.equal(doc.hasListener('visibilitychange'), false)
  assert.equal(app.hasListener('resume'), false)
  assert.deepEqual(_nativeNetworkMonitorStateForTests(), { bound: false, lastConnected: null, handleCount: 0 })
})

test('notify callback failures are contained (one bad subscriber cannot break the monitor)', async () => {
  await withMonitor({}, async () => {
    const network = makeFakeNetwork({ initialConnected: false })
    let calls = 0
    await bindNativeNetworkMonitor({
      onConnectivityRestored: () => { calls += 1; throw new Error('boom') },
      network,
      app: noAppPlugin,
      native: true,
      documentRef: makeFakeDocument(),
    })
    network.emit('networkStatusChange', { connected: true })
    network.emit('networkStatusChange', { connected: false })
    network.emit('networkStatusChange', { connected: true })
    assert.equal(calls, 2, 'monitor keeps working after a callback throw')
  })
})

test('monitor is a pure wake-up signal: no auth/capability/sync imports, no navigator.onLine', () => {
  // connected===true must never be treated as authorization — the module
  // cannot even reach the capability or sync layers.
  assert.equal(/from '\.\/capabilities\.js'/.test(moduleSource), false)
  assert.equal(/from '\.\/auth-state\.js'/.test(moduleSource), false)
  assert.equal(/from '\.\/sync-queue\.js'/.test(moduleSource), false)
  assert.equal(/triggerSync/.test(moduleSource), false)
  const stripped = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.equal(/navigator\.onLine/.test(stripped), false)
})
