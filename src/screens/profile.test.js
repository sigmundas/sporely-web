import test from 'node:test'
import assert from 'node:assert/strict'
import { blockedUserRowHtmlForTests, forceCloseProfileOverlay, openProfileOverlay } from './profile.js'
import * as profileScreen from './profile.js'
import { AUTH_STATE, _resetAuthStateForTests, setAuthState } from '../auth-state.js'
import { showProfileOverlay } from '../profile-overlay.js'
import { state } from '../state.js'
import { supabase } from '../supabase.js'

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

test('force-closing an already hidden profile cannot hide the next setup overlay', () => {
  // Regression: account transition force-close runs before Profile Setup
  // opens. A stale transitionend callback must not dismiss that new overlay.
  const previousDocument = globalThis.document
  const listeners = {}
  const overlay = {
    inert: true,
    dataset: {},
    style: { display: 'none' },
    attributes: {},
    classList: {
      open: false,
      add(name) { if (name === 'open') this.open = true },
      remove(name) { if (name === 'open') this.open = false },
      contains(name) { return name === 'open' && this.open },
    },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    addEventListener(type, handler) { listeners[type] = handler },
  }
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      return id === 'profile-overlay' ? overlay : null
    },
  }

  try {
    forceCloseProfileOverlay()
    showProfileOverlay({ overlay })
    overlay.classList.add('open')
    listeners.transitionend?.()

    assert.equal(overlay.style.display, 'block')
    assert.equal(overlay.classList.contains('open'), true)
  } finally {
    globalThis.document = previousDocument
  }
})

function makeProfileSetupDom() {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        textContent: '',
        disabled: false,
        inert: false,
        dataset: {},
        style: {},
        classList: { add() {}, remove() {}, contains() { return false } },
        setAttribute() {},
        addEventListener() {},
        removeAttribute() {},
      })
    }
    return elements.get(id)
  }
  const overlay = element('profile-overlay')
  overlay.style.display = 'none'
  return {
    elements,
    document: {
      activeElement: null,
      getElementById: element,
      querySelector() { return null },
      querySelectorAll() { return [] },
      contains() { return true },
    },
  }
}

test('incomplete setup loads only the profile and enables prefilled setup fields', async () => {
  // Regression: setup is the one incomplete-state exception. It needs the
  // profiles row, but must not load friends or pending requests.
  const previousDocument = globalThis.document
  const previousAnimationFrame = globalThis.requestAnimationFrame
  const previousFrom = supabase.from
  const previousUser = state.user
  const { document, elements } = makeProfileSetupDom()
  const calls = []
  globalThis.document = document
  globalThis.requestAnimationFrame = callback => callback()
  state.user = { id: 'u1', email: 'alice@example.com' }
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: 'u1' })
  supabase.from = table => {
    calls.push(table)
    assert.equal(table, 'profiles', 'setup must not load unrelated data')
    return {
      select() {
        return {
          eq() {
            return {
              single: async () => ({
                data: { username: 'alice', display_name: 'Alice', bio: 'Loves mushrooms', avatar_url: null },
              }),
            }
          },
        }
      },
    }
  }

  try {
    await openProfileOverlay({ setup: true })
    assert.equal(elements.get('profile-username').value, 'alice')
    assert.equal(elements.get('profile-fullname').value, 'Alice')
    assert.equal(elements.get('profile-bio').value, 'Loves mushrooms')
    assert.equal(elements.get('profile-username').disabled, false)
    assert.equal(elements.get('profile-fullname').disabled, false)
    assert.equal(elements.get('profile-bio').disabled, false)
    assert.equal(elements.get('profile-save-btn').disabled, false)
    assert.equal(elements.get('profile-avatar-btn').disabled, true)
    assert.deepEqual(calls, ['profiles'])
  } finally {
    forceCloseProfileOverlay()
    supabase.from = previousFrom
    state.user = previousUser
    globalThis.document = previousDocument
    globalThis.requestAnimationFrame = previousAnimationFrame
  }
})

test('ordinary incomplete Profile remains disabled and network-free', async () => {
  const previousDocument = globalThis.document
  const previousAnimationFrame = globalThis.requestAnimationFrame
  const previousFrom = supabase.from
  const previousUser = state.user
  const { document, elements } = makeProfileSetupDom()
  globalThis.document = document
  globalThis.requestAnimationFrame = callback => callback()
  state.user = { id: 'u1', email: 'alice@example.com' }
  _resetAuthStateForTests()
  setAuthState({ state: AUTH_STATE.AUTHENTICATED_INCOMPLETE, userId: 'u1' })
  supabase.from = () => { throw new Error('ordinary incomplete Profile must not dispatch') }

  try {
    await openProfileOverlay({ setup: false })
    for (const id of ['profile-username', 'profile-fullname', 'profile-bio', 'profile-save-btn']) {
      assert.equal(elements.get(id).disabled, true)
    }
  } finally {
    forceCloseProfileOverlay()
    supabase.from = previousFrom
    state.user = previousUser
    globalThis.document = previousDocument
    globalThis.requestAnimationFrame = previousAnimationFrame
  }
})

for (const stateValue of [
  AUTH_STATE.AUTHENTICATED_CACHED,
  AUTH_STATE.AUTHENTICATED_REAUTH_REQUIRED,
  AUTH_STATE.RESOLVING,
  AUTH_STATE.UNAUTHENTICATED,
]) {
  test(`setup remains disabled and network-free in ${stateValue}`, async () => {
    const previousDocument = globalThis.document
    const previousAnimationFrame = globalThis.requestAnimationFrame
    const previousFrom = supabase.from
    const previousUser = state.user
    const { document, elements } = makeProfileSetupDom()
    globalThis.document = document
    globalThis.requestAnimationFrame = callback => callback()
    state.user = { id: 'u1', email: 'alice@example.com' }
    _resetAuthStateForTests()
    setAuthState({ state: stateValue, userId: stateValue === AUTH_STATE.UNAUTHENTICATED ? null : 'u1' })
    supabase.from = () => { throw new Error('setup must not dispatch while capability is denied') }

    try {
      await openProfileOverlay({ setup: true })
      for (const id of ['profile-username', 'profile-fullname', 'profile-bio', 'profile-save-btn']) {
        assert.equal(elements.get(id).disabled, true)
      }
    } finally {
      forceCloseProfileOverlay()
      supabase.from = previousFrom
      state.user = previousUser
      globalThis.document = previousDocument
      globalThis.requestAnimationFrame = previousAnimationFrame
    }
  })
}

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
