import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyFindsMineScope,
  applyFindsMineStatus,
  classifyDraftAge,
  compareFindsByScientificName,
  createFindsRenderGuard,
  getFindsFeedSourcePagingState,
  getFindsEffectiveStatusFilter,
  getFindsScopeOptions,
  getFindsSortOptions,
  isFeedPublicObservation,
  isPublicVisibleObservation,
  matchesFindsStatus,
  formatFindsDateTimeLabel,
  normalizeFindsSort,
  isFindsStatusControlDisabled,
  renderFindsRedlistTag,
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

test('finds render guard rejects older async renders after a new render or load starts', async () => {
  const guard = createFindsRenderGuard()
  const commits = []
  let finishFirst
  let finishSecond
  const firstImages = new Promise(resolve => { finishFirst = resolve })
  const secondImages = new Promise(resolve => { finishSecond = resolve })
  const commitAfterImages = async (renderSequence, images) => {
    const value = await images
    if (guard.isCurrent(renderSequence)) commits.push(value)
  }

  const firstRender = guard.begin()
  const firstCommit = commitAfterImages(firstRender, firstImages)
  const secondRender = guard.begin()
  const secondCommit = commitAfterImages(secondRender, secondImages)

  assert.equal(guard.isCurrent(firstRender), false)
  assert.equal(guard.isCurrent(secondRender), true)

  finishSecond('new cards')
  await secondCommit
  finishFirst('stale cards')
  await firstCommit
  assert.deepEqual(commits, ['new cards'])

  guard.invalidate()
  assert.equal(guard.isCurrent(secondRender), false)
})

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
    ['all', 'followed', 'friends'],
  )
  assert.deepEqual(
    getFindsScopeOptions('feed').map(option => option.label),
    ['All', 'Followed', 'Friends'],
  )
})

test('mine scope is applied before paging the observations query', () => {
  const calls = []
  const query = {
    eq(column, value) {
      calls.push({ column, value })
      return this
    },
  }

  assert.equal(applyFindsMineScope(query, 'public'), query)
  assert.deepEqual(calls, [{ column: 'visibility', value: 'public' }])

  calls.length = 0
  assert.equal(applyFindsMineScope(query, 'all'), query)
  assert.deepEqual(calls, [])
})

test('mine status is applied before paging when draft status is supported', () => {
  const calls = []
  const query = {
    eq(column, value) {
      calls.push({ column, value })
      return this
    },
  }

  assert.equal(applyFindsMineStatus(query, 'published'), query)
  assert.deepEqual(calls, [{ column: 'is_draft', value: false }])

  calls.length = 0
  assert.equal(applyFindsMineStatus(query, 'drafts'), query)
  assert.deepEqual(calls, [{ column: 'is_draft', value: true }])

  calls.length = 0
  assert.equal(applyFindsMineStatus(query, 'published', false), query)
  assert.deepEqual(calls, [])
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

test('species sort orders by scientific name instead of common name', () => {
  const agaricus = {
    genus: 'Agaricus',
    species: 'campestris',
    common_name: 'Zebra mushroom',
  }
  const boletus = {
    genus: 'Boletus',
    species: 'edulis',
    common_name: 'Apple mushroom',
  }
  const commonNameOnly = {
    common_name: 'A common name without taxonomy',
  }

  assert.ok(compareFindsByScientificName(agaricus, boletus) < 0)
  assert.ok(compareFindsByScientificName(boletus, agaricus) > 0)
  assert.ok(compareFindsByScientificName(agaricus, commonNameOnly) < 0)
})

test('finds redlist tag helper renders only the tag in a thumbnail-friendly badge', () => {
  const html = renderFindsRedlistTag({
    top_redlist_category: 'LC',
    top_redlist_source: 'Artsdatabanken',
  })

  assert.match(html, /ai-result-row-redlist/)
  assert.match(html, />LC<\/span>/)
  assert.doesNotMatch(html, /ai-redlist-summary-text/)
})

test('finds card date-time helper formats dd-mm hh:mm and prefers captured_at', () => {
  const capturedAt = new Date(2026, 5, 24, 12, 34, 0).toISOString()
  const createdAt = new Date(2026, 5, 25, 8, 9, 0).toISOString()

  assert.equal(
    formatFindsDateTimeLabel({
      captured_at: capturedAt,
      created_at: createdAt,
    }),
    '24-06 12:34',
  )

  assert.equal(
    formatFindsDateTimeLabel({
      created_at: createdAt,
    }),
    '25-06 08:09',
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

  assert.equal(
    isFeedPublicObservation({
      user_id: 'user-a',
      visibility: 'public',
      is_draft: false,
    }, 'user-a'),
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

test('detail loader returns owner drafts from the base table and stops', async () => {
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

  assert.equal(calls.length, 1, 'owner path must not consult non-owner views')
  assert.equal(calls[0].table, 'observations')
  assert.equal(result.source, 'observations')
  assert.equal(result.observation?.id, 696)
  assert.equal(result.observation?.is_draft, true)
  assert.equal(result.outcome, 'observation')
})

// Helper: build a mock supabase-js client that records every
// .from(...).select(...).eq(...).maybeSingle() call in `calls` and
// returns the queued response for that (table, sequence) pair.
function makeSequencedClient(routes) {
  const calls = []
  const cursors = new Map()
  return {
    calls,
    client: {
      from(table) {
        return {
          select(columns) {
            return {
              eq(column, value) {
                return {
                  async maybeSingle() {
                    const index = cursors.get(table) ?? 0
                    cursors.set(table, index + 1)
                    calls.push({ table, columns, column, value })
                    const sequence = routes[table] || []
                    if (!sequence.length) return { data: null, error: null }
                    const response = sequence[Math.min(index, sequence.length - 1)]
                    if (typeof response === 'function') {
                      return response({ columns, index })
                    }
                    return response
                  },
                }
              },
            }
          },
        }
      },
    },
  }
}

test('detail loader falls back to community view for a public non-owner row and stops', async () => {
  const communityRow = {
    id: 720,
    user_id: 'user-b',
    visibility: 'public',
    is_draft: false,
    genus: 'Boletus',
    species: 'edulis',
    location_precision: 'exact',
    gps_latitude: 63.1,
    gps_longitude: 10.1,
    red_list_category: 'LC',
    red_list_categories_json: { NO: 'LC' },
  }
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [{ data: communityRow, error: null }],
    observations_friend_view: [{ data: { id: 720, user_id: 'user-b' }, error: null }],
  })

  const result = await loadDetailObservation(720, { client })

  const observationsCalls = calls.filter(c => c.table === 'observations')
  const communityCalls = calls.filter(c => c.table === 'observations_community_view')
  const friendCalls = calls.filter(c => c.table === 'observations_friend_view')

  assert.equal(observationsCalls.length, 1)
  assert.equal(communityCalls.length, 1)
  assert.equal(friendCalls.length, 0, 'friend view must NOT be queried once community view returns a row')
  assert.equal(result.source, 'observations_community_view')
  assert.equal(result.observation?.id, 720)
  assert.equal(result.observation?.visibility, 'public')
  assert.equal(result.observation?.red_list_category, 'LC')
  assert.equal(result.outcome, 'observation')
})

test('detail loader retries community view without red-list columns on 42703 for a public row', async () => {
  const publicRow = {
    id: 701,
    user_id: 'user-b',
    visibility: 'public',
    is_draft: false,
    genus: 'Amanita',
    species: 'muscaria',
    location_precision: 'exact',
    gps_latitude: 63.4,
    gps_longitude: 10.4,
  }
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [
      {
        data: null,
        error: {
          code: '42703',
          message: "column observations_community_view.red_list_category does not exist",
        },
      },
      { data: publicRow, error: null },
    ],
    observations_friend_view: [{ data: null, error: null }],
  })

  const result = await loadDetailObservation(701, { client })

  const communityCalls = calls.filter(call => call.table === 'observations_community_view')
  const friendCalls = calls.filter(call => call.table === 'observations_friend_view')
  assert.equal(communityCalls.length, 2)
  assert.match(communityCalls[0].columns, /red_list_category/)
  assert.match(communityCalls[0].columns, /red_list_categories_json/)
  assert.doesNotMatch(communityCalls[1].columns, /red_list_category/)
  assert.doesNotMatch(communityCalls[1].columns, /red_list_categories_json/)
  assert.match(communityCalls[1].columns, /ai_selected_service/)
  assert.match(communityCalls[1].columns, /is_draft/)
  assert.equal(friendCalls.length, 0, 'friend view must not be consulted after a successful community-view retry')
  assert.equal(result.outcome, 'observation')
  assert.equal(result.source, 'observations_community_view')
  assert.equal(result.observation?.id, 701)
})

test('detail loader retries only when the missing column is red-list', async () => {
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [
      {
        data: null,
        error: {
          code: '42703',
          message: "column observations_community_view.unrelated_column does not exist",
        },
      },
    ],
    observations_friend_view: [{ data: null, error: null }],
  })

  const result = await loadDetailObservation(899, { client })

  const communityCalls = calls.filter(call => call.table === 'observations_community_view')
  const friendCalls = calls.filter(call => call.table === 'observations_friend_view')
  assert.equal(communityCalls.length, 1, 'unrelated 42703 errors must not trigger the red-list retry')
  assert.equal(friendCalls.length, 0, 'community-view query error must NOT fall through to friend view')
  assert.equal(result.outcome, 'error')
  assert.equal(result.observation, null)
  assert.equal(result.source, null)
  assert.equal(result.error?.code, '42703')
})

test('community view query error does not fall through to friend view', async () => {
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [
      {
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for view observations_community_view',
        },
      },
    ],
    observations_friend_view: [{
      data: { id: 899, user_id: 'friend-id', visibility: 'friends' },
      error: null,
    }],
  })

  const result = await loadDetailObservation(899, { client })

  const communityCalls = calls.filter(call => call.table === 'observations_community_view')
  const friendCalls = calls.filter(call => call.table === 'observations_friend_view')
  assert.equal(communityCalls.length, 1)
  assert.equal(friendCalls.length, 0, 'community-view error must NOT be masked by a friend-view lookup')
  assert.equal(result.outcome, 'error')
  assert.equal(result.error?.code, '42501')
})

test('friend view query error surfaces as outcome=error', async () => {
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [{ data: null, error: null }],
    observations_friend_view: [
      {
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for view observations_friend_view',
        },
      },
    ],
  })

  const result = await loadDetailObservation(899, { client })

  const friendCalls = calls.filter(call => call.table === 'observations_friend_view')
  assert.equal(friendCalls.length, 1)
  assert.equal(result.outcome, 'error')
  assert.equal(result.error?.code, '42501')
})

test('detail loader returns clean no-row when all three surfaces return no row', async () => {
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [{ data: null, error: null }],
    observations_friend_view: [{ data: null, error: null }],
  })

  const result = await loadDetailObservation(899, { client })

  assert.equal(calls.filter(c => c.table === 'observations').length, 1)
  assert.equal(calls.filter(c => c.table === 'observations_community_view').length, 1)
  assert.equal(calls.filter(c => c.table === 'observations_friend_view').length, 1)
  assert.equal(result.outcome, 'no-row')
  assert.equal(result.observation, null)
  assert.equal(result.error, null)
  assert.equal(result.source, null)
})

test('detail loader propagates thrown errors as outcome=error', async () => {
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  throw new Error('network down')
                },
              }
            },
          }
        },
      }
    },
  }

  const result = await loadDetailObservation(899, { client })
  assert.equal(result.outcome, 'error')
  assert.equal(result.observation, null)
  assert.match(String(result.error?.message || result.error || ''), /network down/)
})

// Realistic observation-899 fixture: friends-only observation
// authored by an accepted friend. Community view returns clean
// no-row (public-only predicate), friend view returns the row.
// This mirrors the actual production flow after the migration and
// frontend fallback chain are deployed together.
test('regression: observation 899 loads via friend view for a non-owner accepted friend', async () => {
  const friendRow = {
    id: 899,
    user_id: 'friend-user-id',
    visibility: 'friends',
    is_draft: false,
    genus: 'Cortinarius',
    species: 'violaceus',
    common_name: 'Violet Webcap',
    location: 'Trondheim',
    location_precision: 'exact',
    gps_latitude: 63.42,
    gps_longitude: 10.39,
    ai_selected_service: 'artsorakel',
    ai_selected_scientific_name: 'Cortinarius violaceus',
    red_list_category: 'VU',
    red_list_categories_json: { NO: 'VU' },
  }
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [{ data: null, error: null }],
    observations_friend_view: [{ data: friendRow, error: null }],
  })

  const result = await loadDetailObservation(899, { client })

  assert.equal(result.outcome, 'observation')
  assert.equal(result.source, 'observations_friend_view')
  assert.equal(result.observation?.id, 899)
  assert.equal(result.observation?.visibility, 'friends')
  assert.equal(result.observation?.genus, 'Cortinarius')
  assert.equal(result.observation?.species, 'violaceus')
  assert.equal(result.observation?.location, 'Trondheim')
  assert.equal(result.observation?.location_precision, 'exact')
  assert.equal(result.observation?.gps_latitude, 63.42)
  assert.equal(result.observation?.red_list_category, 'VU')

  const communityCalls = calls.filter(c => c.table === 'observations_community_view')
  const friendCalls = calls.filter(c => c.table === 'observations_friend_view')
  assert.equal(communityCalls.length, 1)
  assert.equal(friendCalls.length, 1)
})

// Deployment-skew test: a briefly older friend view lacks both the
// AI-selection columns AND the red-list columns. The generic
// compatibility retry must recover: drop red-list first, then fall
// back to the legacy select on the subsequent 42703 for ai_selected_*.
test('detail loader recovers from an old friend view missing both AI-selection and red-list columns', async () => {
  const friendRowLegacy = {
    id: 899,
    user_id: 'friend-user-id',
    visibility: 'friends',
    is_draft: false,
    genus: 'Cortinarius',
    species: 'violaceus',
    location_precision: 'exact',
    gps_latitude: 63.42,
    gps_longitude: 10.39,
  }
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [{ data: null, error: null }],
    observations_friend_view: [
      {
        data: null,
        error: {
          code: '42703',
          message: "column observations_friend_view.red_list_category does not exist",
        },
      },
      {
        data: null,
        error: {
          code: '42703',
          message: "column observations_friend_view.ai_selected_service does not exist",
        },
      },
      { data: friendRowLegacy, error: null },
    ],
  })

  const result = await loadDetailObservation(899, { client })

  const friendCalls = calls.filter(call => call.table === 'observations_friend_view')
  assert.equal(friendCalls.length, 3, 'friend view must go full → no-redlist → legacy select')
  assert.match(friendCalls[0].columns, /red_list_category/)
  assert.match(friendCalls[0].columns, /ai_selected_service/)
  assert.doesNotMatch(friendCalls[1].columns, /red_list_category/)
  assert.doesNotMatch(friendCalls[1].columns, /red_list_categories_json/)
  assert.match(friendCalls[1].columns, /ai_selected_service/)
  assert.doesNotMatch(friendCalls[2].columns, /ai_selected_service/)
  assert.doesNotMatch(friendCalls[2].columns, /red_list_category/)
  assert.equal(result.outcome, 'observation')
  assert.equal(result.source, 'observations_friend_view')
  assert.equal(result.observation?.id, 899)
})

test('detail loader recovers from an old community view missing both AI-selection and red-list columns', async () => {
  const publicRowLegacy = {
    id: 702,
    user_id: 'user-b',
    visibility: 'public',
    is_draft: false,
    genus: 'Amanita',
    species: 'muscaria',
  }
  const { client, calls } = makeSequencedClient({
    observations: [{ data: null, error: null }],
    observations_community_view: [
      {
        data: null,
        error: {
          code: '42703',
          message: "column observations_community_view.red_list_category does not exist",
        },
      },
      {
        data: null,
        error: {
          code: '42703',
          message: "column observations_community_view.ai_selected_service does not exist",
        },
      },
      { data: publicRowLegacy, error: null },
    ],
    observations_friend_view: [{ data: null, error: null }],
  })

  const result = await loadDetailObservation(702, { client })

  const communityCalls = calls.filter(call => call.table === 'observations_community_view')
  const friendCalls = calls.filter(call => call.table === 'observations_friend_view')
  assert.equal(communityCalls.length, 3, 'community view must go full → no-redlist → legacy select')
  assert.doesNotMatch(communityCalls[2].columns, /ai_selected_service/)
  assert.doesNotMatch(communityCalls[2].columns, /red_list_category/)
  assert.equal(friendCalls.length, 0)
  assert.equal(result.outcome, 'observation')
  assert.equal(result.source, 'observations_community_view')
})
