import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from './supabase.js'
import {
  CLOUD_PLAN_SOURCE,
  fetchCloudPlanProfile,
  getCloudPlanSource,
  mergeCloudPlanForOfflineFallback,
  reviveCachedCloudPlan,
} from './cloud-plan.js'

function withStubbedSupabaseFrom(behavior, run) {
  const original = supabase.from
  supabase.from = () => ({
    select() { return this },
    eq() { return this },
    async single() { return behavior() },
  })
  return Promise.resolve().then(run).finally(() => {
    supabase.from = original
  })
}

test('successful policy fetch is tagged as NETWORK and carries the Pro flag through', async () => {
  await withStubbedSupabaseFrom(
    () => ({
      data: {
        cloud_plan: 'pro',
        is_pro: true,
        full_res_storage_enabled: true,
        storage_quota_bytes: 20_000_000_000,
        storage_used_bytes: 1_000_000,
        image_count: 12,
      },
      error: null,
    }),
    async () => {
      const policy = await fetchCloudPlanProfile('user-a')
      assert.equal(getCloudPlanSource(policy), CLOUD_PLAN_SOURCE.NETWORK)
      assert.equal(policy.hasProAccess, true)
      assert.equal(policy.cloudPlan, 'pro')
      assert.equal(policy.qualityProfile, 'high')
    },
  )
})

test('network-error path returns a default policy tagged FALLBACK — safe to identify from tag', async () => {
  await withStubbedSupabaseFrom(
    () => ({ data: null, error: { message: 'network down' } }),
    async () => {
      const policy = await fetchCloudPlanProfile('user-a')
      assert.equal(getCloudPlanSource(policy), CLOUD_PLAN_SOURCE.FALLBACK)
      // The default policy is Free — but this is exactly why callers must
      // not persist it. Downgrading a Pro user offline is one of the
      // failure modes Stage B1 exists to prevent.
      assert.equal(policy.cloudPlan, 'free')
    },
  )
})

test('missing-column errors return a NETWORK-tagged default (schema deploy case is not a live downgrade)', async () => {
  await withStubbedSupabaseFrom(
    () => ({ data: null, error: { message: 'column profiles.cloud_plan does not exist' } }),
    async () => {
      const policy = await fetchCloudPlanProfile('user-a')
      assert.equal(getCloudPlanSource(policy), CLOUD_PLAN_SOURCE.NETWORK)
    },
  )
})

test('thrown network error is caught and returned as FALLBACK', async () => {
  await withStubbedSupabaseFrom(
    () => { throw new Error('failed to fetch') },
    async () => {
      const policy = await fetchCloudPlanProfile('user-a')
      assert.equal(getCloudPlanSource(policy), CLOUD_PLAN_SOURCE.FALLBACK)
    },
  )
})

test('fetchCloudPlanProfile without a userId returns a FALLBACK-tagged default (never NETWORK)', async () => {
  const policy = await fetchCloudPlanProfile('')
  assert.equal(getCloudPlanSource(policy), CLOUD_PLAN_SOURCE.FALLBACK)
})

test('reviveCachedCloudPlan produces a CACHED-tagged policy from a persisted Pro record', () => {
  const cached = {
    cloudPlan: 'pro',
    hasProAccess: true,
    qualityProfile: 'high',
    fullResStorageEnabled: true,
    storageQuotaBytes: 20_000_000_000,
    storageUsedBytes: 5_000_000,
    imageCount: 42,
  }
  const revived = reviveCachedCloudPlan(cached)
  assert.equal(getCloudPlanSource(revived), CLOUD_PLAN_SOURCE.CACHED)
  assert.equal(revived.hasProAccess, true)
  assert.equal(revived.cloudPlan, 'pro')
  assert.equal(revived.qualityProfile, 'high')
})

test('reviveCachedCloudPlan returns null for a missing/invalid cached record', () => {
  assert.equal(reviveCachedCloudPlan(null), null)
  assert.equal(reviveCachedCloudPlan(undefined), null)
  assert.equal(reviveCachedCloudPlan('not-a-plan'), null)
})

test('_source tag is non-enumerable so it does not leak into JSON.stringify', () => {
  // The Stage B1 snapshot writer persists the plan verbatim; if the tag
  // were enumerable it would end up in the record and confuse a later
  // read. Guarding this here so the writer stays simple.
  const cached = { cloudPlan: 'free', hasProAccess: false, qualityProfile: 'standard' }
  const revived = reviveCachedCloudPlan(cached)
  const json = JSON.stringify(revived)
  assert.equal(json.includes('_source'), false, 'tag must not appear in JSON')
})

// Stage B FINAL — mergeCloudPlanForOfflineFallback rules. Callers in main.js
// (settings/refresh, in-place revalidation, cold boot) and profile.js
// (_loadProfileData) must funnel every assignment through this helper so
// that a FALLBACK response can never silently downgrade a Pro user offline.

function proNetwork() {
  const revived = reviveCachedCloudPlan({ cloudPlan: 'pro', hasProAccess: true, qualityProfile: 'high' })
  // Re-tag as NETWORK to simulate a real successful fetch.
  Object.defineProperty(revived, '_source', {
    value: CLOUD_PLAN_SOURCE.NETWORK,
    enumerable: false, writable: true, configurable: true,
  })
  return revived
}

function proCached() {
  return reviveCachedCloudPlan({ cloudPlan: 'pro', hasProAccess: true, qualityProfile: 'high' })
}

function freeFallback() {
  const plan = reviveCachedCloudPlan({ cloudPlan: 'free', hasProAccess: false, qualityProfile: 'standard' })
  Object.defineProperty(plan, '_source', {
    value: CLOUD_PLAN_SOURCE.FALLBACK,
    enumerable: false, writable: true, configurable: true,
  })
  return plan
}

test('merge: NETWORK plan replaces every prior value', () => {
  const current = proCached()
  const next = freeFallback()
  Object.defineProperty(next, '_source', { value: CLOUD_PLAN_SOURCE.NETWORK, enumerable: false, writable: true, configurable: true })
  const merged = mergeCloudPlanForOfflineFallback(current, next)
  assert.strictEqual(merged, next)
})

test('merge: FALLBACK plan does NOT clobber a CACHED plan (offline Pro protection)', () => {
  const cached = proCached()
  const fallback = freeFallback()
  const merged = mergeCloudPlanForOfflineFallback(cached, fallback)
  assert.strictEqual(merged, cached)
  assert.equal(merged.hasProAccess, true)
})

test('merge: FALLBACK plan does NOT clobber a NETWORK plan either', () => {
  const network = proNetwork()
  const fallback = freeFallback()
  const merged = mergeCloudPlanForOfflineFallback(network, fallback)
  assert.strictEqual(merged, network)
})

test('merge: FALLBACK plan is accepted when nothing better is known (fresh boot)', () => {
  const fallback = freeFallback()
  const merged = mergeCloudPlanForOfflineFallback(null, fallback)
  assert.strictEqual(merged, fallback)
})

test('merge: CACHED plan is accepted when current is null', () => {
  const cached = proCached()
  const merged = mergeCloudPlanForOfflineFallback(null, cached)
  assert.strictEqual(merged, cached)
})

test('merge: CACHED plan does NOT downgrade a NETWORK plan (avoid mid-session flap)', () => {
  const network = proNetwork()
  const cached = proCached()
  const merged = mergeCloudPlanForOfflineFallback(network, cached)
  assert.strictEqual(merged, network)
})
