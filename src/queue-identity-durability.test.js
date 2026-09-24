/**
 * Taxonomy-v2 closeout Stage 2 Part B — the queue must not finalize away a
 * preserved external identity.
 *
 * `_finalizeSyncedQueueItem` confirms only that the observation and its media
 * exist before deleting the queue item and reporting sync success. So any
 * identity step that returns NORMALLY without persisting causes the preserved
 * `(source_system, namespace, external_id)` tuple to be dropped from durable
 * queued state and never reach the observation.
 *
 * Two earlier drafts did exactly that:
 *
 *   1. an unavailable atomic writer merely logged a warning and returned;
 *   2. the "proven selection" fallback also caught successfully RESOLVED
 *      external selections, persisting their Sporely ID through the narrow RPC
 *      while dropping the tuple.
 *
 * Throwing instead routes the item into the queue's ordinary retryable-failure
 * path — `classifyQueueSyncError` defaults to `isRetryable: true`, the item is
 * kept with its already-persisted `remoteObservationId`, and a retry reuses
 * that observation rather than creating a duplicate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { AUTH_STATE, setAuthState } from './auth-state.js'
setAuthState({ state: AUTH_STATE.AUTHENTICATED_COMPLETE, userId: 'test-user' })

import { _persistQueuedTaxonomyIdentity, classifyQueueSyncError } from './sync-queue.js'
import {
  TAXONOMY_IDENTITY_CAPABILITY,
  externalTaxonomySelectionForCandidate,
} from './taxonomy-v2.js'

const OBS = 4242
const UNAVAILABLE = async () => ({ applied: false, unavailable: true })
const UNRESOLVED = externalTaxonomySelectionForCandidate({ taxonId: 'NBIC:53482' })
const RESOLVED = {
  ...UNRESOLVED, capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '7821',
}
const NATIVE = { capability: TAXONOMY_IDENTITY_CAPABILITY, sporelyTaxonId: '167' }

function deps({ persistAtomic = async () => ({ applied: true }), resolveTo = null } = {}) {
  const narrowCalls = []
  const atomicCalls = []
  return {
    narrowCalls,
    atomicCalls,
    resolveExternal: async selection => resolveTo || selection,
    persistAtomic: async (id, payload) => {
      atomicCalls.push({ id, payload })
      return persistAtomic(id, payload)
    },
    persistNarrow: async (id, selection) => { narrowCalls.push({ id, selection }) },
  }
}

test('an UNRESOLVED external selection fails retryably when the writer is absent', async () => {
  const d = deps({ persistAtomic: UNAVAILABLE })
  await assert.rejects(
    _persistQueuedTaxonomyIdentity(OBS, UNRESOLVED, d),
    error => error.identificationUnavailable === true,
    'returning normally would let the queue finalize and delete the tuple',
  )
  // And it must NOT have fallen back to the narrow RPC.
  assert.deepEqual(d.narrowCalls, [])
  // The thrown error is retryable, so the item is kept for a later pass.
  assert.equal(classifyQueueSyncError(new Error('x')).isRetryable, true)
})

test('a RESOLVED external selection also fails retryably rather than dropping its tuple', async () => {
  // The second defect: "proven" included resolved external selections, so the
  // narrow RPC persisted the Sporely ID and silently lost the source tuple.
  const d = deps({ persistAtomic: UNAVAILABLE, resolveTo: RESOLVED })
  await assert.rejects(
    _persistQueuedTaxonomyIdentity(OBS, UNRESOLVED, d),
    error => error.identificationUnavailable === true,
  )
  assert.deepEqual(
    d.narrowCalls, [],
    'a resolved external identity must not be persisted without its tuple',
  )
})

test('a native-only selection may still use the narrow RPC', async () => {
  // Nothing to lose: no tuple, and the guarded RPC writes one column.
  const d = deps({ persistAtomic: UNAVAILABLE })
  await _persistQueuedTaxonomyIdentity(OBS, NATIVE, d)
  assert.equal(d.narrowCalls.length, 1)
  assert.equal(d.narrowCalls[0].selection.sporelyTaxonId, '167')
})

test('a retry after the writer becomes available preserves the tuple on the same observation', async () => {
  // First pass: unavailable -> throw -> the queue keeps the item and its
  // remoteObservationId.
  const first = deps({ persistAtomic: UNAVAILABLE })
  await assert.rejects(_persistQueuedTaxonomyIdentity(OBS, UNRESOLVED, first))

  // Retry: the migration is now deployed. The SAME observation id is reused,
  // so no duplicate observation is created, and the tuple lands.
  const second = deps()
  await _persistQueuedTaxonomyIdentity(OBS, UNRESOLVED, second)

  assert.equal(second.atomicCalls.length, 1)
  const { id, payload } = second.atomicCalls[0]
  assert.equal(id, OBS, 'the retry must reuse the already-created observation')
  assert.equal(payload.selection.sourceSystem, 'nortaxa')
  assert.equal(payload.selection.namespace, 'nortaxa_taxon_id')
  assert.equal(payload.selection.externalId, '53482')
  assert.equal(payload.selection.rawExternalId, 'NBIC:53482')
  assert.equal(payload.writeName, false, 'the queued INSERT already wrote the name')
  assert.deepEqual(second.narrowCalls, [])
})

test('the happy path resolves before writing and never touches the narrow RPC', async () => {
  const d = deps({ resolveTo: RESOLVED })
  await _persistQueuedTaxonomyIdentity(OBS, UNRESOLVED, d)
  assert.equal(d.atomicCalls.length, 1)
  assert.equal(d.atomicCalls[0].payload.selection.sporelyTaxonId, '7821')
  // The source tuple is retained across resolution, for audit.
  assert.equal(d.atomicCalls[0].payload.selection.externalId, '53482')
  assert.deepEqual(d.narrowCalls, [])
})

test('a resolution that throws keeps the identifier and still writes atomically', async () => {
  const d = deps()
  d.resolveExternal = async () => { throw new Error('network down') }
  await _persistQueuedTaxonomyIdentity(OBS, UNRESOLVED, d)
  assert.equal(d.atomicCalls[0].payload.selection.externalId, '53482')
  assert.equal(d.atomicCalls[0].payload.selection.sporelyTaxonId, null)
})
