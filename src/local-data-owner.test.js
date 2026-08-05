import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearLocalDataOwner,
  getLocalDataOwner,
  resolveLocalDataOwner,
  setLocalDataOwner,
} from './local-data-owner.js'

function memStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
  }
}

test('assigns when no prior owner and no legacy data (fresh install)', async () => {
  const storage = memStorage()
  let purgeCalls = 0
  const { outcome } = await resolveLocalDataOwner(
    'user-a',
    async () => { purgeCalls++ },
    { storage, hasLegacyData: async () => false },
  )
  assert.equal(outcome, 'assigned')
  assert.equal(purgeCalls, 0)
  assert.equal(getLocalDataOwner(storage), 'user-a')
})

test('matches when same user cold-starts (force-quit then relaunch preserves drafts)', async () => {
  const storage = memStorage()
  setLocalDataOwner('user-a', storage)
  let purgeCalls = 0
  const { outcome } = await resolveLocalDataOwner(
    'user-a',
    async () => { purgeCalls++ },
    { storage },
  )
  assert.equal(outcome, 'match')
  assert.equal(purgeCalls, 0, 'must not purge same-owner drafts')
  assert.equal(getLocalDataOwner(storage), 'user-a')
})

test('purges + reassigns on cold-start owner mismatch (interrupted sign-out)', async () => {
  const storage = memStorage()
  setLocalDataOwner('user-a', storage)
  let purgeCalls = 0
  const { outcome } = await resolveLocalDataOwner(
    'user-b',
    async () => { purgeCalls++ },
    { storage },
  )
  assert.equal(outcome, 'purged')
  assert.equal(purgeCalls, 1, 'must purge before restoring for user-b')
  assert.equal(getLocalDataOwner(storage), 'user-b')
})

test('FAIL CLOSED: mismatch purge failure keeps the OLD owner marker and returns purge_failed', async () => {
  // If we cannot delete the previous user's drafts, we must not claim to
  // have moved ownership — the next boot must retry the purge and until
  // then boot code MUST NOT restore.
  const storage = memStorage()
  setLocalDataOwner('user-a', storage)
  const { outcome } = await resolveLocalDataOwner(
    'user-b',
    async () => { throw new Error('IDB write barrier') },
    { storage },
  )
  assert.equal(outcome, 'purge_failed')
  assert.equal(getLocalDataOwner(storage), 'user-a', 'owner marker must NOT move on purge failure')
})

test('next boot retries the purge when the previous purge failed', async () => {
  // Simulates a second cold start after a failed purge. The stored owner is
  // still user-a; the current user is user-b; this time purge succeeds and
  // ownership finally moves.
  const storage = memStorage()
  setLocalDataOwner('user-a', storage)
  const attempts = []
  let attempt = 0
  const purge = async () => {
    attempts.push(++attempt)
    if (attempt === 1) throw new Error('IDB write barrier')
  }
  const first = await resolveLocalDataOwner('user-b', purge, { storage })
  assert.equal(first.outcome, 'purge_failed')
  assert.equal(getLocalDataOwner(storage), 'user-a')

  const second = await resolveLocalDataOwner('user-b', purge, { storage })
  assert.equal(second.outcome, 'purged')
  assert.equal(getLocalDataOwner(storage), 'user-b')
  assert.deepEqual(attempts, [1, 2])
})

test('LEGACY: no marker + existing data → purge and assign', async () => {
  // Pre-upgrade install has drafts but no owner marker. On first launch of
  // the new build, treat those drafts as unowned and purge them before
  // associating the stores with the current user. Documented trade-off:
  // may discard one pre-upgrade draft in favor of account isolation.
  const storage = memStorage()
  let purgeCalls = 0
  const { outcome } = await resolveLocalDataOwner(
    'user-a',
    async () => { purgeCalls++ },
    { storage, hasLegacyData: async () => true },
  )
  assert.equal(outcome, 'purged')
  assert.equal(purgeCalls, 1)
  assert.equal(getLocalDataOwner(storage), 'user-a')
})

test('LEGACY FAIL CLOSED: legacy purge failure keeps marker UNSET (retried on next boot)', async () => {
  const storage = memStorage()
  const { outcome } = await resolveLocalDataOwner(
    'user-a',
    async () => { throw new Error('IDB gone') },
    { storage, hasLegacyData: async () => true },
  )
  assert.equal(outcome, 'legacy_purge_failed')
  assert.equal(getLocalDataOwner(storage), null, 'marker must not be set until purge succeeds')
})

test('clearLocalDataOwner removes the marker (called from SIGNED_OUT handler)', () => {
  const storage = memStorage()
  setLocalDataOwner('user-a', storage)
  clearLocalDataOwner(storage)
  assert.equal(getLocalDataOwner(storage), null)
})

test('missing userId assigns without touching storage or purge', async () => {
  const storage = memStorage()
  const { outcome } = await resolveLocalDataOwner('', () => { throw new Error('no purge') }, { storage })
  assert.equal(outcome, 'assigned')
  assert.equal(getLocalDataOwner(storage), null)
})

test('tolerates storage that throws (private-mode Safari)', async () => {
  const throwing = {
    getItem: () => { throw new Error('QuotaExceeded') },
    setItem: () => { throw new Error('QuotaExceeded') },
    removeItem: () => { throw new Error('QuotaExceeded') },
  }
  const { outcome } = await resolveLocalDataOwner('user-a', () => {}, { storage: throwing })
  // No readable marker → treat as fresh install and assign — no purge.
  assert.equal(outcome, 'assigned')
})

test('legacy data check that throws is treated as no legacy data (fail safe → assign)', async () => {
  const storage = memStorage()
  let purgeCalls = 0
  const { outcome } = await resolveLocalDataOwner(
    'user-a',
    async () => { purgeCalls++ },
    { storage, hasLegacyData: async () => { throw new Error('IDB open failed') } },
  )
  // If we can't inspect the stores, assume no legacy data. This is symmetric
  // with private-mode storage: fail safe (do not delete data we don't know
  // belongs to no one).
  assert.equal(outcome, 'assigned')
  assert.equal(purgeCalls, 0)
})
