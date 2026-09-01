import test from 'node:test'
import assert from 'node:assert/strict'
import { blockedUserRowHtmlForTests } from './profile.js'
import * as profileScreen from './profile.js'
import { AUTH_STATE, _resetAuthStateForTests, setAuthState } from '../auth-state.js'

test('blocked-user fallback avatar escapes a display-name-derived initial', () => {
  const html = blockedUserRowHtmlForTests({
    blocked_id: 'blocked-user-id',
    username: null,
    display_name: '<script>alert(1)</script>',
    avatar_url: null,
  })

  assert.match(html, /<div class="friend-avatar">&lt;<\/div>/)
  assert.doesNotMatch(html, /<div class="friend-avatar"><script>/)
  assert.match(html, /<div class="friend-email">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/)
})

function makeProfileClient(response) {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push({ op: 'from', table })
      return {
        update(payload) {
          calls.push({ op: 'update', payload })
          return {
            eq(column, value) {
              calls.push({ op: 'eq', column, value })
              return {
                select() {
                  return { single: async () => response }
                },
              }
            },
          }
        },
      }
    },
  }
}

test('incomplete setup save reaches saveProfileSetup and persists completion atomically', async () => {
  // This fails if the setup flow is routed through the ordinary cloud-mutation
  // gate, or if it no longer uses the setup saver that writes completion.
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: 'u1' })
  assert.equal(typeof profileScreen.saveProfileMutation, 'function')
  const client = makeProfileClient({
    data: { id: 'u1', username: 'alice', display_name: 'Alice', bio: null, avatar_url: null, profile_completed_at: '2026-09-01T12:00:00Z' },
    error: null,
  })

  const result = await profileScreen.saveProfileMutation({
    setup: true,
    client,
    userId: 'u1',
    fields: { username: 'alice', display_name: 'Alice', bio: null },
    showToast: () => {},
  })

  assert.equal(result.allowed, true)
  assert.equal(result.persisted?.profile_completed_at, '2026-09-01T12:00:00Z')
  const update = client.calls.find(call => call.op === 'update')
  assert.deepEqual(update?.payload, {
    username: 'alice',
    display_name: 'Alice',
    bio: null,
    profile_completed_at: update?.payload.profile_completed_at,
  })
})

test('ordinary profile edit remains blocked while setup is incomplete', async () => {
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: 'u1' })
  assert.equal(typeof profileScreen.saveProfileMutation, 'function')
  const client = makeProfileClient({ data: null, error: null })

  const result = await profileScreen.saveProfileMutation({
    setup: false,
    client,
    userId: 'u1',
    fields: { username: 'alice', display_name: 'Alice', bio: null },
    showToast: () => {},
  })

  assert.equal(result.allowed, false)
  assert.equal(client.calls.length, 0)
})
