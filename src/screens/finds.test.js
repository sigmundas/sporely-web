import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyDraftAge,
  getFindsFeedSourcePagingState,
  getFindsEffectiveStatusFilter,
  getFindsScopeOptions,
  getFindsSortOptions,
  isFeedPublicObservation,
  isPublicVisibleObservation,
  matchesFindsStatus,
  normalizeFindsSort,
  isFindsStatusControlDisabled,
  shouldHideFindsStatusControl,
  _selectFindsDropdownValue,
} from './finds.js'
import { loadDetailObservation } from './find_detail.js'
import { state } from '../state.js'

function makeClassList(initial = []) {
  const values = new Set(initial)
  return {
    add(...names) {
      names.filter(Boolean).forEach(name => values.add(name))
    },
    remove(...names) {
      names.filter(Boolean).forEach(name => values.delete(name))
    },
    toggle(name, force) {
      if (force === true) {
        values.add(name)
        return true
      }
      if (force === false) {
        values.delete(name)
        return false
      }
      if (values.has(name)) {
        values.delete(name)
        return false
      }
      values.add(name)
      return true
    },
    contains(name) {
      return values.has(name)
    },
  }
}

function makeFindsElement(initial = {}) {
  const { classList: classListValues = [], ...rest } = initial
  return {
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    classList: makeClassList(classListValues),
    dataset: { ...(rest.dataset || {}) },
    style: { ...(rest.style || {}) },
    attributes: {},
    querySelectorAll() {
      return []
    },
    addEventListener() {},
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    ...rest,
  }
}

function installFindsDropdownHarness() {
  const elements = {
    'toast': makeFindsElement(),
    'screen-finds': makeFindsElement(),
    'finds-list': makeFindsElement({ querySelectorAll: () => [] }),
    'finds-scope-stack': makeFindsElement(),
    'finds-scope-control': makeFindsElement(),
    'finds-scope-button': makeFindsElement(),
    'finds-scope-button-prefix': makeFindsElement({ textContent: 'Scope' }),
    'finds-scope-button-value': makeFindsElement({ textContent: 'All' }),
    'finds-scope-menu': makeFindsElement({ querySelectorAll: () => [] }),
    'finds-status-control': makeFindsElement(),
    'finds-status-button': makeFindsElement(),
    'finds-status-button-prefix': makeFindsElement({ textContent: 'Status' }),
    'finds-status-button-value': makeFindsElement({ textContent: 'All' }),
    'finds-status-menu': makeFindsElement({ querySelectorAll: () => [] }),
    'finds-sort-control': makeFindsElement(),
    'finds-sort-button': makeFindsElement(),
    'finds-sort-button-prefix': makeFindsElement({ textContent: 'Sort' }),
    'finds-sort-button-value': makeFindsElement({ textContent: 'Date' }),
    'finds-sort-menu': makeFindsElement({ querySelectorAll: () => [] }),
    'finds-user-bar': makeFindsElement(),
    'finds-user-back': makeFindsElement(),
    'finds-user-card-root': makeFindsElement(),
  }

  const previousDocument = globalThis.document
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout

  globalThis.document = {
    getElementById(id) {
      return elements[id] || null
    },
    querySelector(selector) {
      if (selector === '.finds-scope-stack') return elements['finds-scope-stack']
      return null
    },
    querySelectorAll() {
      return []
    },
    addEventListener() {},
    body: {
      dataset: {},
    },
  }
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}

  return {
    elements,
    restore() {
      globalThis.document = previousDocument
      globalThis.setTimeout = previousSetTimeout
      globalThis.clearTimeout = previousClearTimeout
    },
  }
}

test('status filter helper splits drafts and published rows', () => {
  assert.equal(matchesFindsStatus({ is_draft: true }, 'all'), true)
  assert.equal(matchesFindsStatus({ is_draft: false }, 'all'), true)
  assert.equal(matchesFindsStatus({ is_draft: true }, 'drafts'), true)
  assert.equal(matchesFindsStatus({ is_draft: false }, 'drafts'), false)
  assert.equal(matchesFindsStatus({ is_draft: true }, 'published'), false)
  assert.equal(matchesFindsStatus({ is_draft: false }, 'published'), true)
})

test('finds scope options reflect mine and feed dropdown choices', () => {
  assert.deepEqual(
    getFindsScopeOptions('mine').map(option => option.value),
    ['all', 'private', 'friends', 'public'],
  )
  assert.deepEqual(
    getFindsScopeOptions('mine').map(option => option.label),
    ['All', 'Private', 'Friends', 'Public'],
  )

  assert.deepEqual(
    getFindsScopeOptions('feed').map(option => option.value),
    ['all', 'followed', 'friends', 'public'],
  )
  assert.deepEqual(
    getFindsScopeOptions('feed').map(option => option.label),
    ['All', 'Followed', 'Friends', 'Public'],
  )
})

test('finds sort helper keeps date as default and accepts species', () => {
  assert.equal(normalizeFindsSort('date'), 'date')
  assert.equal(normalizeFindsSort('species'), 'species')
  assert.equal(normalizeFindsSort('unexpected'), 'date')
  assert.deepEqual(
    getFindsSortOptions().map(option => option.value),
    ['date', 'species'],
  )
})

test('finds dropdown pills update after selection', () => {
  const harness = installFindsDropdownHarness()
  const previousState = { ...state }

  try {
    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      searchQuery: '',
      findsScopePrimary: 'mine',
      findsMineScope: 'public',
      findsFeedScope: 'followed',
      findsView: 'cards',
      findsGroupBySpecies: false,
      findsSort: 'date',
      findsSporesOnly: false,
      findsStatusFilter: 'all',
      findsTargetUserId: null,
      findsTargetSummaryLoaded: false,
      findsTargetSummaryComplete: false,
    })

    globalThis.__syncFindsDropdownControls()
    assert.equal(harness.elements['finds-scope-button-value'].textContent, 'Public')
    assert.equal(harness.elements['finds-sort-button-value'].textContent, 'Date')

    _selectFindsDropdownValue('scope', 'friends')
    assert.equal(state.findsMineScope, 'friends')
    assert.equal(harness.elements['finds-scope-button-value'].textContent, 'Friends')
    assert.equal(harness.elements['finds-scope-menu'].hidden, true)

    _selectFindsDropdownValue('sort', 'species')
    assert.equal(state.findsSort, 'species')
    assert.equal(harness.elements['finds-sort-button-value'].textContent, 'Species')
    assert.equal(harness.elements['finds-sort-menu'].hidden, true)
  } finally {
    Object.assign(state, previousState)
    harness.restore()
  }
})

test('user-target finds hides scope and status controls', () => {
  const harness = installFindsDropdownHarness()
  const previousState = { ...state }

  try {
    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsMineScope: 'public',
      findsFeedScope: 'followed',
      findsStatusFilter: 'published',
      findsTargetUserId: 'user-b',
      findsTargetSummaryLoaded: true,
      findsTargetSummaryComplete: true,
      findsTargetUsername: 'userb',
      findsTargetDisplayName: 'User B',
      findsTargetAvatarUrl: '',
      findsTargetBio: '',
      findsTargetRelationship: null,
      findsTargetFinds: 1,
      findsTargetSpecies: 1,
      findsTargetSpores: 0,
    })

    globalThis.__syncFindsScopeControls()
    assert.equal(harness.elements['screen-finds'].classList.contains('is-user-target'), true)
    assert.equal(harness.elements['finds-scope-stack'].hidden, true)
    assert.equal(harness.elements['finds-status-control'].hidden, true)
    assert.equal(harness.elements['finds-scope-control'].hidden, true)

    Object.assign(state, {
      findsTargetUserId: null,
      findsTargetSummaryLoaded: false,
      findsTargetSummaryComplete: false,
    })

    globalThis.__syncFindsScopeControls()
    assert.equal(harness.elements['screen-finds'].classList.contains('is-user-target'), false)
    assert.equal(harness.elements['finds-scope-stack'].hidden, false)
    assert.equal(harness.elements['finds-status-control'].hidden, false)
    assert.equal(harness.elements['finds-scope-control'].hidden, false)
  } finally {
    Object.assign(state, previousState)
    harness.restore()
  }
})

test('draft age classification uses created_at first and falls back to date', () => {
  const now = Date.parse('2026-06-24T12:00:00Z')

  assert.equal(
    classifyDraftAge({
      is_draft: true,
      created_at: '2026-06-10T12:00:00Z',
      date: '2025-01-01T12:00:00Z',
    }, now),
    'active',
  )

  assert.equal(
    classifyDraftAge({
      is_draft: true,
      created_at: '2026-03-15T12:00:00Z',
      date: '2026-06-10T12:00:00Z',
    }, now),
    'old',
  )

  assert.equal(
    classifyDraftAge({
      is_draft: true,
      date: '2025-12-01T12:00:00Z',
    }, now),
    'stale',
  )

  assert.equal(
    classifyDraftAge({
      is_draft: false,
      created_at: '2025-12-01T12:00:00Z',
    }, now),
    'published',
  )

  assert.equal(
    classifyDraftAge({
      is_draft: true,
      created_at: 'not-a-date',
      date: '2026-06-10T12:00:00Z',
    }, now),
    'active',
  )
})

test('feed ignores draft-only status state and keeps published-only filtering', () => {
  assert.equal(getFindsEffectiveStatusFilter('feed', 'drafts'), 'published')
  assert.equal(getFindsEffectiveStatusFilter('feed', 'all'), 'published')
  assert.equal(getFindsEffectiveStatusFilter('mine', 'drafts'), 'drafts')
})

test('feed status control disables while feed is active', () => {
  assert.equal(isFindsStatusControlDisabled('feed'), true)
  assert.equal(isFindsStatusControlDisabled('mine'), false)
  assert.equal(shouldHideFindsStatusControl('user'), true)
  assert.equal(shouldHideFindsStatusControl('mine'), false)
})

test('feed source paging keeps per-scope state separate from the outer feed guard', () => {
  const feedPaging = { loadingMore: true, sourcePaging: null }
  const publicPaging = getFindsFeedSourcePagingState(feedPaging, 'public')

  assert.equal(publicPaging.loadingMore, false)
  assert.notEqual(publicPaging, feedPaging)

  publicPaging.nextOffset = 20
  assert.equal(getFindsFeedSourcePagingState(feedPaging, 'public').nextOffset, 20)
})

test('public feed keeps published public observations and excludes public drafts', () => {
  assert.equal(
    isFeedPublicObservation({
      user_id: 'user-a',
      visibility: 'public',
      is_draft: false,
    }),
    true,
  )

  assert.equal(
    isFeedPublicObservation({
      user_id: 'user-a',
      visibility: 'public',
      is_draft: true,
    }),
    false,
  )

  assert.equal(
    isFeedPublicObservation({
      user_id: 'user-a',
      visibility: 'friends',
      is_draft: false,
    }),
    false,
  )
})

test('public visibility helper excludes drafts and owner rows', () => {
  assert.equal(
    isPublicVisibleObservation({
      user_id: 'user-b',
      visibility: 'public',
      is_draft: false,
    }, 'user-a'),
    true,
  )

  assert.equal(
    isPublicVisibleObservation({
      user_id: 'user-b',
      visibility: 'public',
      is_draft: true,
    }, 'user-a'),
    false,
  )

  assert.equal(
    isPublicVisibleObservation({
      user_id: 'user-a',
      visibility: 'public',
      is_draft: false,
    }, 'user-a'),
    false,
  )
})

test('detail loader returns owner drafts from the base table', async () => {
  const calls = []
  const client = {
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              return {
                async maybeSingle() {
                  calls.push({ table, columns, column, value })
                  if (table === 'observations') {
                    return {
                      data: {
                        id: 696,
                        user_id: 'user-a',
                        visibility: 'public',
                        is_draft: true,
                      },
                      error: null,
                    }
                  }
                  return { data: null, error: null }
                },
              }
            },
          }
        },
      }
    },
  }

  const result = await loadDetailObservation(696, { client })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].table, 'observations')
  assert.equal(result.source, 'observations')
  assert.equal(result.observation?.id, 696)
  assert.equal(result.observation?.is_draft, true)
})

test('detail loader falls back to the community view when the base row is invisible', async () => {
  const calls = []
  const client = {
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              return {
                async maybeSingle() {
                  calls.push({ table, columns, column, value })
                  if (table === 'observations') {
                    return { data: null, error: null }
                  }
                  return {
                    data: {
                      id: 696,
                      user_id: 'user-b',
                      visibility: 'public',
                      is_draft: false,
                    },
                    error: null,
                  }
                },
              }
            },
          }
        },
      }
    },
  }

  const result = await loadDetailObservation(696, { client })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].table, 'observations')
  assert.equal(calls[1].table, 'observations_community_view')
  assert.equal(result.source, 'observations_community_view')
  assert.equal(result.observation?.id, 696)
  assert.equal(result.observation?.is_draft, false)
})
