import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyFindsMineScope,
  applyFindsMineStatus,
  applyFindsSearchFilter,
  buildFindsSearchOrFilter,
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
  loadFinds,
  _applyFilter,
  _getFindsCacheForTests,
  _getFindsPagingStateForTests,
  _handleFindsSearchInput,
  _invalidateFindsSearchPagingOnInput,
  _maybeLoadMoreFinds,
  _matches,
  _reloadFindsForSearch,
  _runPagedFindsQuery,
  _scheduleFindsSearchReload,
  _selectFindsDropdownValue,
} from './finds.js'
import { loadDetailObservation } from './find_detail.js'
import { resetObservationIdentificationsTableAvailabilityForTests } from '../ai-identification.js'
import { state } from '../state.js'
import { supabase } from '../supabase.js'

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

// ── Stage 1: server-side search-aware pagination ────────────────────────────

test('empty or whitespace-only search applies no server search filter', () => {
  assert.equal(buildFindsSearchOrFilter(''), '')
  assert.equal(buildFindsSearchOrFilter('   '), '')
  assert.equal(buildFindsSearchOrFilter(null), '')
  assert.equal(buildFindsSearchOrFilter(undefined), '')

  const calls = []
  const query = { or(filter) { calls.push(filter); return this } }
  assert.equal(applyFindsSearchFilter(query, '   '), query)
  assert.deepEqual(calls, [], '.or() must not be called for an empty/whitespace query')
})

test('search filter covers the five preserved fields with a safely quoted ilike pattern', () => {
  const filter = buildFindsSearchOrFilter('cortinarius')
  assert.equal(
    filter,
    [
      'common_name.ilike."%cortinarius%"',
      'genus.ilike."%cortinarius%"',
      'species.ilike."%cortinarius%"',
      'location.ilike."%cortinarius%"',
      'notes.ilike."%cortinarius%"',
    ].join(','),
  )

  const calls = []
  const query = { or(f) { calls.push(f); return this } }
  applyFindsSearchFilter(query, '  Cortinarius  ')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^common_name\.ilike\."%Cortinarius%"/, 'query is trimmed but not case-folded')
})

test('search filter escapes PostgREST reserved characters and ilike wildcards without breaking or broadening the query', () => {
  // `,` `.` `:` `(` `)` are PostgREST or()-list reserved characters; `%` `_`
  // are ILIKE wildcards; `*` is PostgREST's ILIKE alias for `%`; `"` and `\`
  // must survive the double-quoted value itself. A single or() filter string
  // must still parse as exactly 5 comma-separated column conditions.
  const raw = 'a,b.c:d(e)f%g_h*i"j\\k'
  const filter = buildFindsSearchOrFilter(raw)

  // Exactly 5 top-level conditions: one per FINDS_SEARCH_FIELDS entry. A
  // naive split(',') would over-segment because the raw value itself
  // contains a comma inside the quoted portion.
  const topLevel = filter.match(/(?:common_name|genus|species|location|notes)\.ilike\./g)
  assert.equal(topLevel.length, 5, `expected 5 field conditions, got: ${filter}`)

  // The quoted pattern is escaped so that, after PostgREST unescapes the
  // surrounding quotes, the literal ILIKE pattern is `%<ilike-escaped raw>%`.
  const expectedIlikeEscaped = raw.replace(/\\/g, '\\\\').replace(/[%_*]/g, m => `\\${m}`)
  const expectedPattern = `%${expectedIlikeEscaped}%`
  const expectedQuoted = `"${expectedPattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  assert.equal(filter, [
    `common_name.ilike.${expectedQuoted}`,
    `genus.ilike.${expectedQuoted}`,
    `species.ilike.${expectedQuoted}`,
    `location.ilike.${expectedQuoted}`,
    `notes.ilike.${expectedQuoted}`,
  ].join(','))

  // The raw value's own commas/parens must not appear as unescaped top-level
  // separators/grouping — every comma in `filter` other than the 4 field
  // separators must be inside the quoted value.
  const fieldSeparatorCount = 4
  const totalCommas = (filter.match(/,/g) || []).length
  assert.equal(totalCommas, fieldSeparatorCount + (raw.match(/,/g) || []).length * 5)
})

test('search predicate is applied before .range() for every source (Mine/Feed/user-target share one pipeline)', async () => {
  const previousSearchQuery = state.searchQuery
  try {
    for (const [label, columns, legacyColumns] of [
      ['mine', 'id, common_name', 'id'],
      ['feed-source', 'id, common_name, location', 'id'],
      ['user-target', 'id, common_name, notes', 'id'],
    ]) {
      const calls = []
      const fakeQuery = {
        eq() { calls.push('eq'); return this },
        or(filter) { calls.push('or:' + filter); return this },
        order() { calls.push('order'); return this },
        range(from, to) { calls.push(`range:${from}-${to}`); return { data: [], error: null } },
      }
      state.searchQuery = 'corti'
      await _runPagedFindsQuery(() => fakeQuery, columns, legacyColumns, 0)

      const orIndex = calls.findIndex(c => c.startsWith('or:'))
      const rangeIndex = calls.findIndex(c => c.startsWith('range:'))
      assert.ok(orIndex !== -1, `${label}: expected a .or() search filter call`)
      assert.ok(rangeIndex !== -1, `${label}: expected a .range() call`)
      assert.ok(orIndex < rangeIndex, `${label}: search predicate must be applied before .range()`)
      assert.match(calls[orIndex], /corti/, `${label}: filter must reference the normalized search text`)
    }
  } finally {
    state.searchQuery = previousSearchQuery
  }
})

// Fake PostgREST-shaped client for full-pipeline paging/search tests below.
// Each `.from(table)` call returns its own recording chain; the terminal
// `.range()` call looks up a response from `responsesByCallIndex[callIndex]`
// (one entry per successive call against that table), which may be a plain
// `{ data, error }` object or a Promise resolving to one — this lets a test
// hold a page's response open (unresolved) to simulate an in-flight request.
function makeFindsPagingClient(responsesByTable) {
  const calls = []
  const callIndexByTable = {}
  const nextResponse = table => {
    const index = callIndexByTable[table] || 0
    callIndexByTable[table] = index + 1
    const responses = responsesByTable[table] || []
    return responses[Math.min(index, responses.length - 1)] || { data: [], error: null }
  }
  return {
    calls,
    client: {
      from(table) {
        const chain = {
          select(columns) { calls.push({ table, op: 'select', columns }); return chain },
          eq(col, val) { calls.push({ table, op: 'eq', col, val }); return chain },
          neq(col, val) { calls.push({ table, op: 'neq', col, val }); return chain },
          or(filter) { calls.push({ table, op: 'or', filter }); return chain },
          order(col, opts) { calls.push({ table, op: 'order', col, opts }); return chain },
          range(from, to) {
            calls.push({ table, op: 'range', from, to })
            return nextResponse(table)
          },
          // Only used by the red-list enrichment lookup
          // (loadObservationRedlistSummaries) in the tests below — it is a
          // terminal call on its own table, like .range() is for observations.
          in(col, vals) {
            calls.push({ table, op: 'in', col, vals })
            return nextResponse(table)
          },
        }
        return chain
      },
    },
  }
}

// `loadFinds()` (unlike `_reloadFindsForSearch()`) also syncs the scope/
// status/sort dropdown controls, which touch a few more read-only DOM
// query methods. Extending the minimal `{ getElementById: () => undefined }`
// stub used elsewhere in this file with harmless empty results for those
// keeps `finds-list` (and everything else) absent, so `_applyFilter`'s
// render step still no-ops exactly as it does with the plain stub.
function makeMinimalFindsDocument(overrides = {}) {
  return {
    getElementById: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    ...overrides,
  }
}

test('_matches keeps matching queued/local observations client-side, unchanged by server-side search', () => {
  const queued = {
    common_name: 'Fly agaric',
    genus: 'Amanita',
    species: 'muscaria',
    location: 'Bymarka',
    notes: 'bright red cap',
    uncertain: false,
    _pendingSync: true,
  }
  assert.equal(_matches(queued, 'fly agaric'), true)
  assert.equal(_matches(queued, 'bymarka'), true)
  assert.equal(_matches(queued, 'bright red'), true)
  assert.equal(_matches(queued, 'nonexistent'), false)
})

// Minimal empty-queue IndexedDB stub (see src/import-store.test.js for the
// fuller pattern this trims down) so `_loadMinePage`'s `getQueuedObservations`
// call resolves to `[]` instead of touching a real IDB, without pulling
// offline-queue behavior into these online-search-pagination tests.
function installEmptyQueueIndexedDbStub() {
  const previous = globalThis.indexedDB
  globalThis.indexedDB = {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          transaction() {
            return {
              objectStore() {
                return {
                  getAll() {
                    const req = {}
                    queueMicrotask(() => { req.result = []; req.onsuccess?.({ target: req }) })
                    return req
                  },
                }
              },
            }
          },
          close() {},
        }
        request.onsuccess?.({ target: request })
      })
      return request
    },
  }
  return () => { globalThis.indexedDB = previous }
}

test('changing the search query ties paging to the new query and a stale in-flight response cannot be appended (user-target)', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  globalThis.document = { getElementById: () => undefined }
  let resolveStale
  const stalePromise = new Promise(resolve => { resolveStale = resolve })

  try {
    // First call ("corti"): a full page (20 rows) that never resolves until
    // we release it below, simulating a slow in-flight request.
    // Second call ("cortinarius", fired before the first resolves): a short
    // page (3 rows) that resolves immediately, so it is the authoritative
    // — and last-committed — response.
    const staleRows = Array.from({ length: 20 }, (_, i) => ({ id: String(900 + i), user_id: 'user-a', common_name: `stale-${i}`, top_redlist_category: 'LC' }))
    const freshRows = [
      { id: '801', user_id: 'user-a', common_name: 'fresh-1', top_redlist_category: 'LC' },
      { id: '802', user_id: 'user-a', common_name: 'fresh-2', top_redlist_category: 'LC' },
      { id: '803', user_id: 'user-a', common_name: 'fresh-3', top_redlist_category: 'LC' },
    ]
    const { client, calls } = makeFindsPagingClient({
      observations: [
        stalePromise.then(() => ({ data: staleRows, error: null })),
        { data: freshRows, error: null },
      ],
    })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a', // owner user-target path: no queued-item/profile network calls
      searchQuery: 'corti',
    })

    const firstReload = _reloadFindsForSearch()
    state.searchQuery = 'cortinarius'
    const secondReload = _reloadFindsForSearch()
    await secondReload

    const rangeCallsAfterSecond = calls.filter(c => c.op === 'range' && c.table === 'observations')
    assert.equal(rangeCallsAfterSecond.length, 2, 'both the stale and fresh queries must have been issued')
    const secondOrCall = calls.filter(c => c.op === 'or' && c.table === 'observations')[1]
    assert.match(secondOrCall.filter, /cortinarius/, 'the second (authoritative) query used the new search text')

    // The authoritative (fresh) response must already be the committed
    // cache/paging state before the stale one is even released.
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['801', '802', '803'])
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 3)
    assert.equal(_getFindsPagingStateForTests('user').searchKey, 'cortinarius')

    resolveStale()
    await firstReload

    // If the stale response had been allowed to land after the fresh one, it
    // would leave 20 accumulated/replaced rows (ids 900-919) behind instead.
    const finalOrCalls = calls.filter(c => c.op === 'or' && c.table === 'observations')
    assert.equal(finalOrCalls.length, 2, 'no further queries were issued once the stale response resolved')
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['801', '802', '803'], 'the stale response must not have been appended once released')
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 3, 'the stale response must not have advanced the current paging offset')
  } finally {
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test('an equivalent normalized search edit (whitespace only) does not reset paging, but a real text change does', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  globalThis.document = makeMinimalFindsDocument()

  try {
    const page = Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), user_id: 'user-a', common_name: `corti-${i}`, top_redlist_category: 'LC' }))
    const { client } = makeFindsPagingClient({ observations: [{ data: page, error: null }] })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      searchQuery: 'corti',
    })

    await loadFinds()
    const pagingAfterLoad = _getFindsPagingStateForTests('user')
    assert.equal(pagingAfterLoad.nextOffset, 20)
    assert.equal(pagingAfterLoad.searchKey, 'corti')

    // Whitespace-only edit: normalizes to the same value already committed.
    state.searchQuery = '  corti  '
    const changed = _invalidateFindsSearchPagingOnInput()
    assert.equal(changed, false, 'a normalized-equivalent edit must not report a change')
    assert.equal(_getFindsPagingStateForTests('user'), pagingAfterLoad, 'paging state object must not be replaced for an equivalent query')
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 20, 'offset must survive an equivalent-query edit')

    // A real text change must invalidate immediately, ahead of the debounce.
    state.searchQuery = 'cortinarius'
    const reallyChanged = _invalidateFindsSearchPagingOnInput()
    assert.equal(reallyChanged, true)
    assert.notEqual(_getFindsPagingStateForTests('user'), pagingAfterLoad, 'a real query change must reset to a fresh paging state')
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 0)
    assert.equal(_getFindsPagingStateForTests('user').searchKey, 'cortinarius')
  } finally {
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test('a load-more triggered while a search is still debouncing cannot use the old query offset against the new query text', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  // "screen-finds" starts far from its bottom so `loadFinds()`'s own
  // fire-and-forget post-load `_maybeLoadMoreFinds()` check (which would
  // otherwise race this test's own manual calls below and consume the
  // second queued page prematurely) does not trigger; the test switches it
  // to "near bottom" itself right before the load-more assertions it owns.
  let nearBottom = false
  globalThis.document = makeMinimalFindsDocument({
    getElementById(id) {
      if (id === 'screen-finds') {
        return nearBottom
          ? { scrollHeight: 1000, scrollTop: 850, clientHeight: 100, classList: { toggle() {} } }
          : { scrollHeight: 1000, scrollTop: 0, clientHeight: 100, classList: { toggle() {} } }
      }
      return undefined
    },
  })

  try {
    const firstPage = Array.from({ length: 20 }, (_, i) => ({ id: String(200 + i), user_id: 'user-a', common_name: `corti-${i}`, top_redlist_category: 'LC' }))
    const nextPageOfNewQuery = [
      { id: '301', user_id: 'user-a', common_name: 'cortinarius-1', top_redlist_category: 'LC' },
    ]
    const { client, calls } = makeFindsPagingClient({
      observations: [{ data: firstPage, error: null }, { data: nextPageOfNewQuery, error: null }],
    })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      // Not 'finds' yet: `loadFinds()`'s own fire-and-forget post-load
      // `_maybeLoadMoreFinds()` check bails out on this alone, so it cannot
      // race this test's own manual load-more call below regardless of
      // microtask interleaving (its first page has `hasMore: true`, so the
      // scroll position alone would not have been a reliable guard).
      currentScreen: 'not-finds-yet',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      searchQuery: 'corti',
    })

    await loadFinds()
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 20)
    assert.equal(_getFindsPagingStateForTests('user').hasMore, true)

    // Typing narrows the visible query but the debounce has not fired yet.
    state.searchQuery = 'cortinarius'
    _invalidateFindsSearchPagingOnInput()
    state.currentScreen = 'finds'
    nearBottom = true

    // A scroll-triggered load-more firing in this gap must not be able to
    // reuse the old (offset 20) paging state against the new query text —
    // the freshly reset paging state is not `initialized` yet, so the
    // scroll-threshold path must not issue a request at all until the
    // debounced authoritative reload (below) establishes a real first page.
    await _maybeLoadMoreFinds()
    const rangeCallsBeforeReload = calls.filter(c => c.op === 'range' && c.table === 'observations')
    assert.equal(rangeCallsBeforeReload.length, 1, 'load-more must not fire against an un-initialized (query-changed) paging state')

    // The debounce now fires the authoritative reload for the new query.
    await _reloadFindsForSearch()
    const rangeCallsAfterReload = calls.filter(c => c.op === 'range' && c.table === 'observations')
    assert.equal(rangeCallsAfterReload.length, 2)
    assert.equal(rangeCallsAfterReload[1].from, 0, 'the authoritative reload for the new query must start at offset 0, not the old offset 20')
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['301'])
  } finally {
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test("an older request's awaited red-list enrichment cannot overwrite a newer completed search's cache", async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  globalThis.document = { getElementById: () => undefined }
  resetObservationIdentificationsTableAvailabilityForTests()
  let resolveStaleRedlist
  const staleRedlistPromise = new Promise(resolve => { resolveStaleRedlist = resolve })

  try {
    // Stale ("first") rows have no red-list data yet, so loading them awaits
    // a red-list lookup that we hold open below. Fresh ("second") rows
    // already carry red-list data, so their load completes without any
    // further network wait — it must win the cache regardless.
    const staleRows = [
      { id: '401', user_id: 'user-a', common_name: 'first-1' },
      { id: '402', user_id: 'user-a', common_name: 'first-2' },
    ]
    const freshRows = [
      { id: '501', user_id: 'user-a', common_name: 'second-1', top_redlist_category: 'LC' },
    ]
    const { client, calls } = makeFindsPagingClient({
      observations: [{ data: staleRows, error: null }, { data: freshRows, error: null }],
      observation_identifications_community_view: [staleRedlistPromise.then(() => ({ data: [], error: null }))],
    })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      searchQuery: 'first',
    })

    const firstReload = _reloadFindsForSearch()

    // Let the stale (first) request run all the way up to the point where
    // it is parked awaiting the still-open red-list lookup — i.e. past its
    // own page-fetch loadSeq guard — before the query changes underneath
    // it. Otherwise the second request's loadSeq bump would instead catch
    // the stale request at its earlier (page-fetch) guard, never
    // exercising the later (post-enrichment) guard this test targets.
    while (!calls.some(c => c.op === 'in' && c.table === 'observation_identifications_community_view')) {
      await Promise.resolve()
    }

    state.searchQuery = 'second'
    const secondReload = _reloadFindsForSearch()
    await secondReload

    // The fresh request needed no red-list wait, so it is already committed.
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['501'])

    const redlistCallsSoFar = calls.filter(c => c.op === 'in' && c.table === 'observation_identifications_community_view')
    assert.equal(redlistCallsSoFar.length, 1, 'only the stale request should have needed a red-list lookup')

    // Now let the stale request's red-list lookup resolve. Its own guard
    // must stop it from overwriting the already-newer committed cache.
    resolveStaleRedlist()
    await firstReload

    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['501'], "the stale request's late enrichment must not have overwritten the newer cache")
  } finally {
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
    resetObservationIdentificationsTableAvailabilityForTests()
  }
})

test('clearing the search resets to the unfiltered server query', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  globalThis.document = makeMinimalFindsDocument()

  try {
    const filteredRows = [{ id: '601', user_id: 'user-a', common_name: 'corti-1', top_redlist_category: 'LC' }]
    const unfilteredRows = [
      { id: '701', user_id: 'user-a', common_name: 'corti-1', top_redlist_category: 'LC' },
      { id: '702', user_id: 'user-a', common_name: 'unrelated', top_redlist_category: 'LC' },
    ]
    const { client, calls } = makeFindsPagingClient({
      observations: [{ data: filteredRows, error: null }, { data: unfilteredRows, error: null }],
    })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      searchQuery: 'corti',
    })

    await loadFinds()
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['601'])

    state.searchQuery = ''
    await _reloadFindsForSearch()

    const orCalls = calls.filter(c => c.op === 'or' && c.table === 'observations')
    assert.equal(orCalls.length, 1, 'clearing the search must not add a server search filter for the unfiltered reload')
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['701', '702'])
    assert.equal(_getFindsPagingStateForTests('user').searchKey, '')
  } finally {
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

// Minimal fake `finds-list` element: a real settable `innerHTML` plus the
// read-only DOM methods `_renderCards` calls after committing (`_wireDeleteButtons`,
// `wireImageFallback`) so a full nonempty render can run to completion.
function makeFindsListElement() {
  return {
    innerHTML: '',
    querySelectorAll() { return [] },
  }
}

// These render-ordering tests below drive `_reloadFindsForSearch()` directly
// rather than through the real debounce timer, so the timer itself must be
// neutralized — otherwise `_handleFindsSearchInput()` leaves a real ~250ms
// `setTimeout` pending that fires after the test (and its `finally` restores
// `globalThis.document`/`supabase.from`), corrupting later tests.
function installNoopFindsTimers() {
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = () => 0
  globalThis.clearTimeout = () => {}
  return () => {
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
  }
}

// Combined fake PostgREST-shaped client for the two tests below: routes the
// `observations` table through the same paging/search recording chain as
// `makeFindsPagingClient` above, and routes every other table (the image
// tables `fetchObservationImageRows` queries — `observation_images` and its
// community view) through a `select().in().is().order()` chain that is
// itself the awaited (thenable) value, matching how supabase-js query
// builders behave. `imagesPending`, while set, holds every image-table
// response open until `releaseImages()` is called, so a test can suspend a
// render at its `await fetchCardImages(...)` point and resume it on demand.
function makeFindsRenderClient(observationsResponses) {
  const calls = []
  let obsCallIndex = 0
  let releaseImages
  let imagesPending = null
  return {
    calls,
    holdImages() {
      imagesPending = new Promise(resolve => { releaseImages = resolve })
    },
    releaseImages() {
      releaseImages?.()
      imagesPending = null
    },
    client: {
      from(table) {
        if (table === 'observations') {
          const chain = {
            select() { return chain },
            eq() { return chain },
            neq() { return chain },
            or(filter) { calls.push({ table, op: 'or', filter }); return chain },
            order() { return chain },
            range(from, to) {
              calls.push({ table, op: 'range', from, to })
              const idx = obsCallIndex++
              return observationsResponses[Math.min(idx, observationsResponses.length - 1)]
            },
          }
          return chain
        }
        calls.push({ table, op: 'image-query' })
        const chain = {
          select() { return chain },
          in() { return chain },
          is() { return chain },
          order() { return chain },
          then(resolve, reject) {
            const result = { data: [], error: null }
            return (imagesPending ? imagesPending.then(() => result) : Promise.resolve(result)).then(resolve, reject)
          },
        }
        return chain
      },
    },
  }
}

test('typing narrows cached cards locally and the render commits after debounce invalidation, including an async image lookup still pending', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  const list = makeFindsListElement()
  globalThis.document = makeMinimalFindsDocument({
    getElementById: id => (id === 'finds-list' ? list : undefined),
  })
  const restoreTimers = installNoopFindsTimers()

  try {
    const rows = [
      { id: '901', user_id: 'user-a', common_name: 'cortinarius-1', top_redlist_category: 'LC' },
      { id: '902', user_id: 'user-a', common_name: 'unrelated', top_redlist_category: 'LC' },
    ]
    const renderClient = makeFindsRenderClient([{ data: rows, error: null }])
    supabase.from = renderClient.client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      findsView: 'cards',
      searchQuery: '',
    })

    await loadFinds()
    assert.ok(list.innerHTML.includes('cortinarius-1') && list.innerHTML.includes('unrelated'), 'initial unfiltered render committed both rows')

    // Typing narrows the already-cached rows locally. Hold the image lookup
    // open so the render is suspended past the point where the old (buggy)
    // ordering would have already discarded it via a later invalidation.
    renderClient.holdImages()
    const renderPromise = _handleFindsSearchInput('cortinarius')
    await Promise.resolve(); await Promise.resolve()

    renderClient.releaseImages()
    const committed = await renderPromise
    assert.equal(committed, true, 'the local narrowing render must commit, not be discarded')
    assert.ok(list.innerHTML.includes('cortinarius-1'), 'the matching row rendered')
    assert.ok(!list.innerHTML.includes('unrelated'), 'the non-matching row was narrowed out locally')
  } finally {
    restoreTimers()
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test('a same-query debounced reload starting while its own authoritative page is still unresolved does not discard the in-flight local narrowing render; the authoritative response still replaces it once it resolves', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  const list = makeFindsListElement()
  globalThis.document = makeMinimalFindsDocument({
    getElementById: id => (id === 'finds-list' ? list : undefined),
  })
  const restoreTimers = installNoopFindsTimers()

  try {
    const initialRows = [
      { id: '911', user_id: 'user-a', common_name: 'cortinarius-1', top_redlist_category: 'LC' },
      { id: '912', user_id: 'user-a', common_name: 'unrelated', top_redlist_category: 'LC' },
    ]
    const freshRows = [
      { id: '921', user_id: 'user-a', common_name: 'cortinarius-fresh', top_redlist_category: 'LC' },
    ]
    let resolveAuthoritative
    const authoritativePromise = new Promise(resolve => { resolveAuthoritative = resolve })
    const renderClient = makeFindsRenderClient([
      { data: initialRows, error: null },
      authoritativePromise.then(() => ({ data: freshRows, error: null })),
    ])
    supabase.from = renderClient.client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      findsView: 'cards',
      searchQuery: '',
    })

    await loadFinds()
    assert.ok(list.innerHTML.includes('cortinarius-1') && list.innerHTML.includes('unrelated'), 'initial unfiltered render committed both rows')

    // Typing begins the local narrowing render (held on its image lookup).
    renderClient.holdImages()
    const localRenderPromise = _handleFindsSearchInput('cortinarius')

    // The debounce "fires" while the authoritative page's own server
    // response is still unresolved — it must not discard the local render
    // above (third review-pass correction).
    const reloadPromise = _reloadFindsForSearch()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    // Releasing images now lets ONLY the local render's fetchCardImages
    // resolve (the authoritative page itself is still held, so its own
    // render has not begun yet) — it must commit the locally narrowed rows.
    renderClient.releaseImages()
    const localCommitted = await localRenderPromise
    assert.equal(localCommitted, true, 'the local narrowing render must commit while the authoritative page is still unresolved')
    assert.ok(list.innerHTML.includes('cortinarius-1'), 'the matching cached row rendered locally')
    assert.ok(!list.innerHTML.includes('unrelated'), 'the non-matching cached row was narrowed out locally')

    // Now let the authoritative page resolve; its own render must replace
    // the local one.
    resolveAuthoritative()
    await reloadPromise
    assert.ok(list.innerHTML.includes('cortinarius-fresh'), 'the authoritative response replaced the local result')
    assert.ok(!list.innerHTML.includes('cortinarius-1'), 'the stale locally-narrowed row no longer appears once the authoritative response commits')
  } finally {
    restoreTimers()
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test('a local narrowing render whose image lookup resolves after the authoritative response already began rendering does not overwrite it', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  const list = makeFindsListElement()
  globalThis.document = makeMinimalFindsDocument({
    getElementById: id => (id === 'finds-list' ? list : undefined),
  })
  const restoreTimers = installNoopFindsTimers()

  try {
    const initialRows = [
      { id: '931', user_id: 'user-a', common_name: 'cortinarius-cached-stale', top_redlist_category: 'LC' },
      { id: '932', user_id: 'user-a', common_name: 'unrelated', top_redlist_category: 'LC' },
    ]
    const freshRows = [
      { id: '941', user_id: 'user-a', common_name: 'cortinarius-fresh', top_redlist_category: 'LC' },
    ]
    // Unlike the previous test, the authoritative page's own server response
    // resolves immediately here — only the shared image lookup is held, so
    // the authoritative render reaches its own (later) render sequence
    // before either render's image lookup resolves.
    const renderClient = makeFindsRenderClient([
      { data: initialRows, error: null },
      { data: freshRows, error: null },
    ])
    supabase.from = renderClient.client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      findsView: 'cards',
      searchQuery: '',
    })

    await loadFinds()

    renderClient.holdImages()
    const localRenderPromise = _handleFindsSearchInput('cortinarius')
    const reloadPromise = _reloadFindsForSearch()
    // Let the authoritative reload run all the way up to its own (later)
    // fetchCardImages call, which also blocks on the same held gate.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    renderClient.releaseImages()
    const [localCommitted] = await Promise.all([localRenderPromise, reloadPromise])

    assert.equal(localCommitted, false, 'the stale local render (older render sequence) must not commit once superseded')
    assert.ok(list.innerHTML.includes('cortinarius-fresh'), 'the authoritative response committed')
    assert.ok(!list.innerHTML.includes('cortinarius-cached-stale'), 'the late-resolving local render must not have overwritten the authoritative result')
    assert.ok(!list.innerHTML.includes('unrelated'), 'the late-resolving local render must not have overwritten the authoritative result')
  } finally {
    restoreTimers()
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

// Fake, controllable setTimeout/clearTimeout so the test can observe exactly
// when the search-reload debounce timer is (re)armed vs. left alone, and can
// fire it deterministically instead of waiting on a real 250ms timer.
//
// Only intercepts calls made with the debounce's own delay (250ms,
// FINDS_SEARCH_DEBOUNCE_MS in finds.js) — every other delay passes through to
// the real timer unmodified. This matters because unrelated background
// timers (e.g. the imported `supabase` client's own session/connection
// housekeeping) keep running for real during a test and are not otherwise
// distinguishable from calls this test cares about; without this filter, one
// of those unrelated real timers can coincidentally fire while this fake is
// installed and inflate `pendingCount`, an occasional false failure with no
// connection to search-debounce correctness.
function installFakeFindsTimers() {
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  let nextId = 1
  const timers = new Map()
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms !== 250) return previousSetTimeout(fn, ms, ...rest)
    const id = nextId++
    timers.set(id, fn)
    return id
  }
  globalThis.clearTimeout = (id) => {
    if (timers.has(id)) { timers.delete(id); return }
    previousClearTimeout(id)
  }
  return {
    get pendingCount() { return timers.size },
    fireAll() {
      const pending = Array.from(timers.values())
      timers.clear()
      pending.forEach(fn => fn())
    },
    restore() {
      globalThis.setTimeout = previousSetTimeout
      globalThis.clearTimeout = previousClearTimeout
    },
  }
}

test('an equivalent normalized edit does not arm or disturb the debounce timer, so a page-one reload is not forced after browsing further pages', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  let nearBottom = false
  globalThis.document = makeMinimalFindsDocument({
    getElementById(id) {
      if (id === 'screen-finds') {
        return nearBottom
          ? { scrollHeight: 1000, scrollTop: 850, clientHeight: 100, classList: { toggle() {} } }
          : { scrollHeight: 1000, scrollTop: 0, clientHeight: 100, classList: { toggle() {} } }
      }
      return undefined
    },
  })
  const timers = installFakeFindsTimers()

  try {
    const firstPage = Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), user_id: 'user-a', common_name: `corti-${i}`, top_redlist_category: 'LC' }))
    const secondPage = Array.from({ length: 20 }, (_, i) => ({ id: String(200 + i), user_id: 'user-a', common_name: `corti-${20 + i}`, top_redlist_category: 'LC' }))
    const freshPage = [{ id: '301', user_id: 'user-a', common_name: 'cortinarius-1', top_redlist_category: 'LC' }]
    const { client, calls } = makeFindsPagingClient({
      observations: [{ data: firstPage, error: null }, { data: secondPage, error: null }, { data: freshPage, error: null }],
    })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      searchQuery: 'corti',
    })

    await loadFinds()
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 20)

    // Browse further pages (unrelated to the search box) so paging state
    // moves well past the first page.
    nearBottom = true
    state.currentScreen = 'finds'
    await _maybeLoadMoreFinds()
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 40, 'a second page was loaded via scroll, independent of search input')
    const rangeCallsBeforeEdit = calls.filter(c => c.op === 'range' && c.table === 'observations').length

    // An equivalent normalized edit (trailing whitespace) must not arm a
    // reload timer at all.
    _handleFindsSearchInput('corti ')
    assert.equal(timers.pendingCount, 0, 'an equivalent edit must not schedule a debounce timer')
    timers.fireAll()
    await Promise.resolve()
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 40, 'an equivalent edit must not reset paging back to page one')
    assert.equal(calls.filter(c => c.op === 'range' && c.table === 'observations').length, rangeCallsBeforeEdit, 'an equivalent edit must not issue any additional query')

    // A real text change must still arm exactly one timer, and firing it
    // must run the authoritative reload from a fresh page one.
    _handleFindsSearchInput('cortinarius')
    assert.equal(timers.pendingCount, 1, 'a real query change must arm the debounce timer')
    timers.fireAll()
    for (let i = 0; i < 20 && _getFindsPagingStateForTests('user').nextOffset === 0; i++) {
      await Promise.resolve()
    }

    assert.equal(_getFindsPagingStateForTests('user').searchKey, 'cortinarius')
    assert.equal(_getFindsPagingStateForTests('user').nextOffset, 1)
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['301'])
  } finally {
    timers.restore()
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test('an equivalent normalized edit while a real-change timer is already pending leaves that same pending reload untouched', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  globalThis.document = makeMinimalFindsDocument()
  const timers = installFakeFindsTimers()

  try {
    const freshPage = [{ id: '401', user_id: 'user-a', common_name: 'cortinarius-1', top_redlist_category: 'LC' }]
    const { client, calls } = makeFindsPagingClient({
      observations: [{ data: [], error: null }, { data: freshPage, error: null }],
    })
    supabase.from = client.from

    Object.assign(state, {
      user: { id: 'user-a' },
      currentScreen: 'finds',
      findsScopePrimary: 'mine',
      findsTargetUserId: 'user-a',
      searchQuery: 'corti',
    })

    await loadFinds()

    // A real query change arms the debounce timer.
    _handleFindsSearchInput('cortinarius')
    assert.equal(timers.pendingCount, 1, 'a real query change must arm the debounce timer')
    const rangeCallsAfterRealChange = calls.filter(c => c.op === 'range' && c.table === 'observations').length

    // A subsequent equivalent-normalized edit while that timer is still
    // pending must leave it exactly as it was — not cancel it, not arm a
    // second one, and not issue any query of its own.
    _handleFindsSearchInput('cortinarius ')
    assert.equal(timers.pendingCount, 1, 'an equivalent edit must not cancel or duplicate the already-pending real-change timer')
    assert.equal(calls.filter(c => c.op === 'range' && c.table === 'observations').length, rangeCallsAfterRealChange, 'an equivalent edit must not issue a query of its own')

    // Firing the (single, untouched) timer must still run exactly one
    // authoritative reload, for the real changed query.
    timers.fireAll()
    for (let i = 0; i < 20 && _getFindsPagingStateForTests('user').nextOffset === 0; i++) {
      await Promise.resolve()
    }
    assert.equal(_getFindsPagingStateForTests('user').searchKey, 'cortinarius')
    assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['401'])
    assert.equal(calls.filter(c => c.op === 'range' && c.table === 'observations').length, rangeCallsAfterRealChange + 1, 'exactly one reload query fired')
  } finally {
    timers.restore()
    supabase.from = previousFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
  }
})

test('Mine, each Feed source (public/friends/followed), and user-target each apply the search predicate before paging their own table/view', async () => {
  const previousFrom = supabase.from
  const previousState = { ...state }
  const previousDocument = globalThis.document
  const restoreIndexedDb = installEmptyQueueIndexedDbStub()
  const previousStorageFrom = supabase.storage.from
  // Feed-source rows are owned by a different user, so `_loadProfilesForScope`
  // will look their profile/avatar up — stub storage so that stays local
  // instead of making a real network call (see src/artsorakel.test.js for
  // this same pattern).
  supabase.storage.from = () => ({ createSignedUrls: async () => ({ data: [], error: null }) })
  globalThis.document = makeMinimalFindsDocument()

  try {
    // Mine
    {
      const rows = [{ id: '1001', user_id: 'user-a', common_name: 'mine-match', top_redlist_category: 'LC' }]
      const { client, calls } = makeFindsPagingClient({ observations: [{ data: rows, error: null }] })
      supabase.from = client.from
      Object.assign(state, {
        user: { id: 'user-a' },
        currentScreen: 'finds',
        findsScopePrimary: 'mine',
        findsMineScope: 'all',
        findsStatusFilter: 'all',
        findsTargetUserId: null,
        searchQuery: 'mine-match',
      })
      await loadFinds()
      const orIndex = calls.findIndex(c => c.op === 'or')
      const rangeIndex = calls.findIndex(c => c.op === 'range')
      assert.ok(orIndex !== -1 && orIndex < rangeIndex, 'Mine: search predicate must be applied before .range()')
      assert.deepEqual(_getFindsCacheForTests('mine').map(o => o.id), ['1001'])
    }

    // Feed sources: public, friends, followed
    const feedSources = [
      { findsFeedScope: 'all', table: 'observations_community_view', row: { id: '2001', user_id: 'user-b', common_name: 'public-match', visibility: 'public', is_draft: false, top_redlist_category: 'LC' } },
      { findsFeedScope: 'friends', table: 'observations_friend_view', row: { id: '2002', user_id: 'user-c', common_name: 'friends-match', is_draft: false, top_redlist_category: 'LC' } },
      { findsFeedScope: 'followed', table: 'observations_follow_view', row: { id: '2003', user_id: 'user-d', common_name: 'followed-match', is_draft: false, top_redlist_category: 'LC' } },
    ]
    for (const { findsFeedScope, table, row } of feedSources) {
      const { client, calls } = makeFindsPagingClient({ [table]: [{ data: [row], error: null }] })
      supabase.from = client.from
      Object.assign(state, {
        user: { id: 'user-a' },
        currentScreen: 'finds',
        findsScopePrimary: 'feed',
        findsFeedScope,
        findsTargetUserId: null,
        searchQuery: row.common_name,
      })
      await loadFinds()
      const tableCalls = calls.filter(c => c.table === table)
      const orIndex = tableCalls.findIndex(c => c.op === 'or')
      const rangeIndex = tableCalls.findIndex(c => c.op === 'range')
      assert.ok(orIndex !== -1 && orIndex < rangeIndex, `Feed ${findsFeedScope}: search predicate must be applied before .range() on ${table}`)
      assert.deepEqual(_getFindsCacheForTests('feed').map(o => o.id), [row.id], `Feed ${findsFeedScope}: only the matching row from ${table} should be cached`)
    }

    // User-target (non-owner path uses observations_community_view)
    {
      const rows = [{ id: '3001', user_id: 'user-e', common_name: 'target-match', visibility: 'public', is_draft: false, top_redlist_category: 'LC' }]
      const { client, calls } = makeFindsPagingClient({ observations_community_view: [{ data: rows, error: null }] })
      supabase.from = client.from
      Object.assign(state, {
        user: { id: 'user-a' },
        currentScreen: 'finds',
        findsScopePrimary: 'mine',
        findsTargetUserId: 'user-e',
        searchQuery: 'target-match',
      })
      await loadFinds()
      const orIndex = calls.findIndex(c => c.op === 'or')
      const rangeIndex = calls.findIndex(c => c.op === 'range')
      assert.ok(orIndex !== -1 && orIndex < rangeIndex, 'user-target: search predicate must be applied before .range()')
      assert.deepEqual(_getFindsCacheForTests('user').map(o => o.id), ['3001'])
    }
  } finally {
    supabase.from = previousFrom
    supabase.storage.from = previousStorageFrom
    Object.assign(state, previousState)
    globalThis.document = previousDocument
    restoreIndexedDb()
  }
})

// Faithful pure-JS re-implementation of the exact three-stage pipeline a
// filter value goes through in production, used to prove literal-character
// matching semantics deterministically (no live server dependency in CI):
//   1) this file's own quoting (`_quoteFindsFilterValue`, exercised via
//      `buildFindsSearchOrFilter`) — reversed here the same way PostgREST's
//      or()-list quoted-value grammar reverses it (unescape `\"` and `\\`);
//   2) PostgREST v12.2.3's unconditional `T.map star` (`*` -> `%`) over the
//      raw ilike/like filter value, applied before Postgres ever sees it;
//   3) Postgres ILIKE with the default backslash escape character.
// Stage 2/3 were independently confirmed against a live local PostgREST
// instance (synthetic rows, ilike/or() queries) during this correction pass;
// see the plan's Stage 1 record for the transcript.
function _unquotePostgrestFilterValue(quoted) {
  const inner = quoted.slice(1, -1)
  let result = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      result += inner[i + 1]
      i++
    } else {
      result += inner[i]
    }
  }
  return result
}

function _applyPostgrestStarSubstitution(value) {
  return value.replace(/\*/g, '%')
}

function _matchesPostgresIlike(text, pattern) {
  let regex = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      regex += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i++
    } else if (ch === '%') {
      regex += '.*'
    } else if (ch === '_') {
      regex += '.'
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  regex += '$'
  return new RegExp(regex, 'is').test(text)
}

function _simulateFindsSearchIlike(searchQuery, candidateText) {
  const filter = buildFindsSearchOrFilter(searchQuery)
  const quoted = filter.match(/\.ilike\.("(?:[^"\\]|\\.)*")/)[1]
  const afterQuoting = _unquotePostgrestFilterValue(quoted)
  const afterStarSubstitution = _applyPostgrestStarSubstitution(afterQuoting)
  return _matchesPostgresIlike(candidateText, afterStarSubstitution)
}

test('special characters in search text match their literal counterpart without breaking or broadening the query', () => {
  const cases = [
    { label: 'percent', query: 'a%b', matches: 'xa%bx', notMatches: ['xaZZbx', 'xaQb'] },
    { label: 'underscore', query: 'a_b', matches: 'xa_bx', notMatches: ['xaZbx'] },
    { label: 'backslash', query: 'a\\b', matches: 'xa\\bx', notMatches: ['xabx'] },
    { label: 'quote', query: 'a"b', matches: 'xa"bx', notMatches: ['xabx'] },
    { label: 'comma', query: 'a,b', matches: 'xa,bx', notMatches: ['xabx'] },
    { label: 'dot', query: 'a.b', matches: 'xa.bx', notMatches: ['xaZb'] },
    { label: 'colon', query: 'a:b', matches: 'xa:bx', notMatches: ['xabx'] },
    { label: 'parens', query: 'a(b)c', matches: 'xa(b)cx', notMatches: ['xabcx'] },
  ]
  for (const { label, query, matches, notMatches } of cases) {
    assert.equal(_simulateFindsSearchIlike(query, matches), true, `${label}: must match its own literal text`)
    for (const candidate of notMatches) {
      assert.equal(_simulateFindsSearchIlike(query, candidate), false, `${label}: must not broaden to match "${candidate}"`)
    }
  }

  // Documented, evidenced exception (plan Stage 1 record): PostgREST maps
  // every `*` to `%` before Postgres ever applies the escape character, so a
  // literal `*` cannot be matched through this filter surface. This must not
  // break the query, and — critically — must not broaden it into a wildcard
  // (a bare unescaped `*` would match everything; this must not).
  assert.equal(_simulateFindsSearchIlike('*', 'contains a literal * star'), false, 'a literal * search must not find a literal * (documented PostgREST limitation)')
  assert.equal(_simulateFindsSearchIlike('*', 'contains a literal % percent'), true, 'a literal * search resolves to matching a literal % instead, per the documented PostgREST star->percent substitution')
  assert.equal(_simulateFindsSearchIlike('*', 'unrelated text'), false, 'a literal * search must not broaden into an unescaped wildcard matching everything')
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
