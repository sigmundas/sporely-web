import test from 'node:test'
import assert from 'node:assert/strict'

import { isPublicVisibleObservation, matchesFindsStatus } from './finds.js'
import { loadDetailObservation } from './find_detail.js'

test('status filter helper splits drafts and published rows', () => {
  assert.equal(matchesFindsStatus({ is_draft: true }, 'all'), true)
  assert.equal(matchesFindsStatus({ is_draft: false }, 'all'), true)
  assert.equal(matchesFindsStatus({ is_draft: true }, 'drafts'), true)
  assert.equal(matchesFindsStatus({ is_draft: false }, 'drafts'), false)
  assert.equal(matchesFindsStatus({ is_draft: true }, 'published'), false)
  assert.equal(matchesFindsStatus({ is_draft: false }, 'published'), true)
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
