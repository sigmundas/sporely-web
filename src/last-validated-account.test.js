import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LAST_VALIDATED_ACCOUNT_SCHEMA_VERSION,
  LAST_VALIDATED_ACCOUNT_STORAGE_KEY,
  clearLastValidatedAccount,
  readLastValidatedAccount,
  updateLastValidatedCloudPlan,
  writeLastValidatedAccount,
} from './last-validated-account.js'

function memStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
    _raw() { return map.get(LAST_VALIDATED_ACCOUNT_STORAGE_KEY) || null },
  }
}

function throwingStorage() {
  return {
    getItem() { throw new Error('QuotaExceeded') },
    setItem() { throw new Error('QuotaExceeded') },
    removeItem() { throw new Error('QuotaExceeded') },
  }
}

test('writeLastValidatedAccount + readLastValidatedAccount roundtrip preserves the accepted fields', () => {
  const storage = memStorage()
  const written = writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice', display_name: 'Alice A.', avatar_url: 'https://ex/a.jpg' },
    cloudPlan: { cloudPlan: 'pro', hasProAccess: true, qualityProfile: 'high' },
    lastValidatedAt: 1_700_000_000_000,
  }, storage)
  assert.equal(written, true)

  const record = readLastValidatedAccount(storage)
  assert.ok(record)
  assert.equal(record.version, LAST_VALIDATED_ACCOUNT_SCHEMA_VERSION)
  assert.equal(record.userId, 'user-a')
  assert.equal(record.email, 'a@example.com')
  assert.equal(record.profileComplete, true)
  assert.deepEqual(record.profileSummary, {
    username: 'alice',
    display_name: 'Alice A.',
    avatar_url: 'https://ex/a.jpg',
  })
  assert.equal(record.cloudPlan.cloudPlan, 'pro')
  assert.equal(record.cloudPlan.hasProAccess, true)
  assert.equal(record.lastValidatedAt, 1_700_000_000_000)
})

test('readLastValidatedAccount returns null when nothing has been persisted', () => {
  const storage = memStorage()
  assert.equal(readLastValidatedAccount(storage), null)
})

test('malformed JSON causes read to FAIL CLOSED (returns null)', () => {
  const storage = memStorage()
  storage.setItem(LAST_VALIDATED_ACCOUNT_STORAGE_KEY, '{ this is not json')
  assert.equal(readLastValidatedAccount(storage), null)
})

test('schema-version mismatch FAILS CLOSED', () => {
  const storage = memStorage()
  storage.setItem(LAST_VALIDATED_ACCOUNT_STORAGE_KEY, JSON.stringify({
    version: LAST_VALIDATED_ACCOUNT_SCHEMA_VERSION + 1,
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
  }))
  assert.equal(readLastValidatedAccount(storage), null)
})

test('missing userId FAILS CLOSED (never allow anonymous cached record)', () => {
  const storage = memStorage()
  storage.setItem(LAST_VALIDATED_ACCOUNT_STORAGE_KEY, JSON.stringify({
    version: LAST_VALIDATED_ACCOUNT_SCHEMA_VERSION,
    userId: '',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
  }))
  assert.equal(readLastValidatedAccount(storage), null)
})

test('writeLastValidatedAccount without userId is a no-op and does not persist', () => {
  const storage = memStorage()
  const ok = writeLastValidatedAccount({
    userId: '',
    email: 'a@example.com',
  }, storage)
  assert.equal(ok, false)
  assert.equal(storage._raw(), null)
})

test('read tolerates a storage that throws on getItem (private-mode Safari)', () => {
  assert.equal(readLastValidatedAccount(throwingStorage()), null)
})

test('write tolerates a storage that throws on setItem', () => {
  const ok = writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: {},
  }, throwingStorage())
  assert.equal(ok, false)
})

test('clearLastValidatedAccount removes the record', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
  }, storage)
  assert.ok(readLastValidatedAccount(storage))
  clearLastValidatedAccount(storage)
  assert.equal(readLastValidatedAccount(storage), null)
})

test('clearLastValidatedAccount tolerates throwing storage', () => {
  // Must not raise; the boot path relies on this being safe.
  clearLastValidatedAccount(throwingStorage())
})

test('updateLastValidatedCloudPlan preserves profileSummary and email on a userId match', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice', display_name: 'Alice', avatar_url: '' },
    cloudPlan: { cloudPlan: 'free', hasProAccess: false },
    lastValidatedAt: 1_700_000_000_000,
  }, storage)

  const ok = updateLastValidatedCloudPlan('user-a', {
    cloudPlan: 'pro',
    hasProAccess: true,
    qualityProfile: 'high',
  }, storage)
  assert.equal(ok, true)

  const record = readLastValidatedAccount(storage)
  assert.equal(record.userId, 'user-a')
  assert.equal(record.email, 'a@example.com')
  assert.equal(record.profileSummary.username, 'alice')
  assert.equal(record.cloudPlan.cloudPlan, 'pro')
  assert.equal(record.cloudPlan.hasProAccess, true)
  // lastValidatedAt must be updated to a real timestamp (>= previous).
  assert.ok(record.lastValidatedAt > 0)
})

test('updateLastValidatedCloudPlan on a userId MISMATCH does NOT overwrite the record', () => {
  // Prevents an accidental cross-account plan overwrite in flight during an
  // account transition.
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileComplete: true,
    profileSummary: { username: 'alice' },
    cloudPlan: { cloudPlan: 'free' },
  }, storage)
  const ok = updateLastValidatedCloudPlan('user-b', { cloudPlan: 'pro' }, storage)
  assert.equal(ok, false)
  const record = readLastValidatedAccount(storage)
  assert.equal(record.userId, 'user-a')
  assert.equal(record.cloudPlan.cloudPlan, 'free')
})

test('updateLastValidatedCloudPlan is a no-op when no record exists', () => {
  const storage = memStorage()
  const ok = updateLastValidatedCloudPlan('user-a', { cloudPlan: 'pro' }, storage)
  assert.equal(ok, false)
  assert.equal(readLastValidatedAccount(storage), null)
})

test('never persists Supabase auth tokens even if a caller passes them in', () => {
  // Guard against a careless caller stuffing a session object into the
  // record: the fields we accept are enumerated on write, so the persisted
  // JSON must not contain access_token / refresh_token.
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: { username: 'alice' },
    cloudPlan: { cloudPlan: 'free' },
    access_token: 'SUPER-SECRET',
    refresh_token: 'SUPER-SECRET-REFRESH',
    session: { access_token: 'x', refresh_token: 'y' },
  }, storage)
  const raw = storage._raw()
  assert.ok(raw)
  assert.equal(raw.includes('SUPER-SECRET'), false, 'must not persist access token')
  assert.equal(raw.includes('SUPER-SECRET-REFRESH'), false, 'must not persist refresh token')
  assert.equal(raw.includes('refresh_token'), false)
  assert.equal(raw.includes('access_token'), false)
})

test('profileSummary and cloudPlan are sanitized on write (nested non-object cloudPlan becomes null)', () => {
  const storage = memStorage()
  writeLastValidatedAccount({
    userId: 'user-a',
    email: 'a@example.com',
    profileSummary: 'not-an-object',
    cloudPlan: 42, // not an object, must become null
  }, storage)
  const record = readLastValidatedAccount(storage)
  assert.deepEqual(record.profileSummary, {
    username: null,
    display_name: null,
    avatar_url: null,
  })
  assert.equal(record.cloudPlan, null)
})
