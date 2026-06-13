import test from 'node:test'
import assert from 'node:assert/strict'

import { isPublicVisibleObservation } from './finds.js'
import { loadDetailObservation } from './find_detail.js'

test('public visibility helper keeps public drafts visible and excludes owner rows', () => {
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
    true,
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
                      is_draft: true,
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
  assert.equal(result.observation?.is_draft, true)
})
