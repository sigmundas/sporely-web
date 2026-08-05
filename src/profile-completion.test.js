import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { isProfileComplete } from './profile-completion.js'

const COMPLETED_AT = '2026-08-05T12:00:00Z'

test('null profile is not complete', () => {
  assert.equal(isProfileComplete(null), false)
  assert.equal(isProfileComplete(undefined), false)
})

test('auto-seeded username/display_name without profile_completed_at → incomplete', () => {
  // handle_new_user() has just inserted this row.
  assert.equal(isProfileComplete({
    username: 'alice',
    display_name: 'alice',
    profile_completed_at: null,
  }), false)
})

test('user-entered fields but null profile_completed_at → incomplete', () => {
  // User typed values into the Profile screen, but the setup save never
  // reached Supabase — persistence, not local state, decides completeness.
  assert.equal(isProfileComplete({
    username: 'alice.a',
    display_name: 'Alice A',
    profile_completed_at: null,
  }), false)
})

test('username + display_name + profile_completed_at → complete', () => {
  assert.equal(isProfileComplete({
    username: 'alice',
    display_name: 'Alice Anderson',
    profile_completed_at: COMPLETED_AT,
  }), true)
})

test('empty username with completed_at set → incomplete', () => {
  assert.equal(isProfileComplete({
    username: '',
    display_name: 'Alice',
    profile_completed_at: COMPLETED_AT,
  }), false)
})

test('empty display_name with completed_at set → incomplete', () => {
  assert.equal(isProfileComplete({
    username: 'alice',
    display_name: null,
    profile_completed_at: COMPLETED_AT,
  }), false)
})

test('whitespace-only fields do not satisfy completeness', () => {
  assert.equal(isProfileComplete({
    username: '   ',
    display_name: 'Alice',
    profile_completed_at: COMPLETED_AT,
  }), false)
  assert.equal(isProfileComplete({
    username: 'alice',
    display_name: '\t\n',
    profile_completed_at: COMPLETED_AT,
  }), false)
})

test('legacy/backfilled established profile (any non-null completed_at) → complete', () => {
  // The one-time migration wrote coalesce(updated_at, created_at, now()) into
  // profile_completed_at for existing users. Runtime code sees only the value.
  assert.equal(isProfileComplete({
    username: 'legacy_user',
    display_name: 'Legacy User',
    profile_completed_at: '2024-01-01T00:00:00Z',
  }), true)
})

// ── fetchProfileWithSignupRetry error handling ──────────────────────────

let __supabaseCalls = []
let __supabaseResponses = []
function __setSupabaseResponses(responses) {
  __supabaseCalls = []
  __supabaseResponses = [...responses]
}

// Rebuild the supabase-mock harness by intercepting the module. We stub the
// `from().select().eq().maybeSingle()` chain that fetchProfileForCompletion
// uses. Node's ESM loader can't mock imports, so we mount the harness onto
// the real supabase client for the duration of the test.
import { supabase } from './supabase.js'

const originalFrom = supabase.from
function __installSupabaseHarness() {
  supabase.from = () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          __supabaseCalls.push(Date.now())
          if (!__supabaseResponses.length) return { data: null, error: null }
          return __supabaseResponses.shift()
        },
      }),
    }),
  })
}
function __uninstallSupabaseHarness() {
  supabase.from = originalFrom
}

beforeEach(() => {
  __setSupabaseResponses([])
})

test('fetchProfileWithSignupRetry retries when the row is missing', async () => {
  const { fetchProfileWithSignupRetry } = await import('./profile-completion.js')
  __installSupabaseHarness()
  try {
    __setSupabaseResponses([
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 'u1', username: 'alice', display_name: 'Alice', profile_completed_at: COMPLETED_AT }, error: null },
    ])
    const { profile, error } = await fetchProfileWithSignupRetry('u1', { attempts: 4, delayMs: 1 })
    assert.equal(error, null)
    assert.equal(profile?.username, 'alice')
    assert.equal(__supabaseCalls.length, 3)
  } finally {
    __uninstallSupabaseHarness()
  }
})

test('fetchProfileWithSignupRetry surfaces non-missing errors immediately', async () => {
  const { fetchProfileWithSignupRetry } = await import('./profile-completion.js')
  __installSupabaseHarness()
  try {
    // A 401/RLS/network error must NOT be re-tried as if the row were absent.
    __setSupabaseResponses([
      { data: null, error: { code: '42501', message: 'permission denied for table profiles' } },
      { data: { id: 'u1', username: 'alice', display_name: 'Alice', profile_completed_at: COMPLETED_AT }, error: null },
    ])
    const { profile, error } = await fetchProfileWithSignupRetry('u1', { attempts: 4, delayMs: 1 })
    assert.equal(profile, null)
    assert.equal(error?.code, '42501')
    assert.equal(__supabaseCalls.length, 1, 'should not retry through an authorization error')
  } finally {
    __uninstallSupabaseHarness()
  }
})

test('fetchProfileWithSignupRetry returns null profile after exhausted attempts', async () => {
  const { fetchProfileWithSignupRetry } = await import('./profile-completion.js')
  __installSupabaseHarness()
  try {
    __setSupabaseResponses([
      { data: null, error: null },
      { data: null, error: null },
    ])
    const { profile, error } = await fetchProfileWithSignupRetry('u1', { attempts: 2, delayMs: 1 })
    assert.equal(profile, null)
    assert.equal(error, null)
    assert.equal(__supabaseCalls.length, 2)
  } finally {
    __uninstallSupabaseHarness()
  }
})

// ── saveProfileSetup / saveProfileEdit ─────────────────────────────────

function __fakeClient(response = { data: null, error: null }) {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push({ op: 'from', table })
      return {
        update(payload) {
          calls.push({ op: 'update', payload })
          return {
            eq(col, val) {
              calls.push({ op: 'eq', col, val })
              return {
                select(cols) {
                  calls.push({ op: 'select', cols })
                  return {
                    single: async () => {
                      calls.push({ op: 'single' })
                      return response
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  }
}

test('saveProfileSetup writes fields + profile_completed_at in one update', async () => {
  const { saveProfileSetup } = await import('./profile-completion.js')
  const client = __fakeClient({
    data: { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null, bio: null, profile_completed_at: COMPLETED_AT },
    error: null,
  })
  const { persisted, error } = await saveProfileSetup(
    client, 'u1',
    { username: 'alice', display_name: 'Alice', bio: null },
    { now: () => COMPLETED_AT },
  )
  assert.equal(error, null)
  assert.equal(persisted?.profile_completed_at, COMPLETED_AT)
  const updateCall = client.calls.find(c => c.op === 'update')
  assert.deepEqual(updateCall.payload, {
    username: 'alice',
    display_name: 'Alice',
    bio: null,
    profile_completed_at: COMPLETED_AT,
  })
  const selectCall = client.calls.find(c => c.op === 'select')
  assert.match(selectCall.cols, /profile_completed_at/)
  const eqCall = client.calls.find(c => c.op === 'eq')
  assert.deepEqual(eqCall, { op: 'eq', col: 'id', val: 'u1' })
})

test('saveProfileEdit never writes profile_completed_at', async () => {
  const { saveProfileEdit } = await import('./profile-completion.js')
  const client = __fakeClient({ data: { id: 'u1', username: 'alice', display_name: 'Alice' }, error: null })
  await saveProfileEdit(client, 'u1', { username: 'alice', display_name: 'Alice', bio: 'hi' })
  const updateCall = client.calls.find(c => c.op === 'update')
  assert.equal('profile_completed_at' in updateCall.payload, false)
  assert.deepEqual(Object.keys(updateCall.payload).sort(), ['bio', 'display_name', 'username'])
})

test('saveProfileSetup surfaces the Supabase error and returns null persisted', async () => {
  const { saveProfileSetup } = await import('./profile-completion.js')
  const client = __fakeClient({ data: null, error: { code: '23505', message: 'duplicate username' } })
  const { persisted, error } = await saveProfileSetup(
    client, 'u1',
    { username: 'taken', display_name: 'X', bio: null },
    { now: () => COMPLETED_AT },
  )
  assert.equal(persisted, null)
  assert.equal(error?.code, '23505')
})

test('setup save then isProfileComplete on the persisted row → true', async () => {
  // End-to-end shape check: caller routes on the persisted row, not on the
  // local form values.
  const { saveProfileSetup } = await import('./profile-completion.js')
  const client = __fakeClient({
    data: { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null, bio: null, profile_completed_at: COMPLETED_AT },
    error: null,
  })
  const { persisted } = await saveProfileSetup(
    client, 'u1',
    { username: 'alice', display_name: 'Alice', bio: null },
    { now: () => COMPLETED_AT },
  )
  assert.equal(isProfileComplete(persisted), true)
})

test('fetchProfileWithSignupRetry with missing userId returns null without querying', async () => {
  const { fetchProfileWithSignupRetry } = await import('./profile-completion.js')
  __installSupabaseHarness()
  try {
    const { profile, error } = await fetchProfileWithSignupRetry('', { attempts: 2, delayMs: 1 })
    assert.equal(profile, null)
    assert.equal(error, null)
    assert.equal(__supabaseCalls.length, 0)
  } finally {
    __uninstallSupabaseHarness()
  }
})
