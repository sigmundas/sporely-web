import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from '../supabase.js'
import { state } from '../state.js'
import { buildPeopleCard, loadPeople } from './people.js'

test('loadPeople sends a null RPC query for empty search', async () => {
  const originalRpc = supabase.rpc
  const originalDocument = globalThis.document
  const originalWindow = globalThis.window
  const originalUser = state.user
  const originalScreen = state.currentScreen
  const calls = []

  const list = {
    innerHTML: '',
    querySelectorAll() {
      return []
    },
  }
  const subtitle = { textContent: '' }
  const clearBtn = { style: { display: '' } }

  globalThis.document = {
    getElementById(id) {
      if (id === 'people-list') return list
      if (id === 'people-subtitle') return subtitle
      if (id === 'people-search-clear') return clearBtn
      if (id === 'people-search-input') return { value: '' }
      return null
    },
  }
  globalThis.window = {
    requestAnimationFrame(fn) {
      return fn()
    },
  }

  state.user = { id: 'test-user' }
  state.currentScreen = 'people'
  supabase.rpc = async (name, args) => {
    calls.push({ name, args })
    return { data: [], error: null }
  }

  try {
    await loadPeople({ query: '' })
  } finally {
    supabase.rpc = originalRpc
    globalThis.document = originalDocument
    globalThis.window = originalWindow
    state.user = originalUser
    state.currentScreen = originalScreen
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'search_people_directory')
  assert.equal(calls[0].args.p_limit, 50)
  assert.equal(calls[0].args.p_offset, 0)
  assert.equal(calls[0].args.p_query, null)
})

test('buildPeopleCard renders relationship actions', () => {
  const html = buildPeopleCard({
    user_id: 'user-123',
    username: 'alex',
    display_name: 'Alex',
    bio: 'Short bio',
    finds: 4,
    species: 2,
    spores: 1,
    relationship: {
      friendStatus: 'accepted',
      following: true,
    },
  })

  assert.match(html, /people-social-btn is-following is-friend/)
  assert.match(html, /Friends/)
  assert.match(html, /Unfriend/)
  assert.match(html, /Unfollow/)
  assert.doesNotMatch(html, /people-social-heart/)
})
