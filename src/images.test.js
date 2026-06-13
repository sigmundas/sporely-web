import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from './supabase.js'
import { fetchFirstImages, fetchObservationImageRows } from './images.js'

function withSupabaseFromStub(stub, fn) {
  const originalFrom = supabase.from
  supabase.from = stub
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      supabase.from = originalFrom
    })
}

test('public image rows are read from the community image view first', async () => {
  const calls = []

  await withSupabaseFromStub(table => {
    calls.push(table)
    return {
      select() {
        return {
          in() { return this },
          is() { return this },
          order() {
            return Promise.resolve({
              data: table === 'observation_images_community_view'
                ? [{
                    observation_id: 696,
                    storage_path: 'user-a/696/0_123.webp',
                    sort_order: 0,
                  }]
                : [],
              error: null,
            })
          },
        }
      },
    }
  }, async () => {
    const rows = await fetchObservationImageRows([696])
    assert.equal(rows.length, 1)

    const sources = await fetchFirstImages([696], { variant: 'medium' })
    assert.equal(sources[696].primaryUrl, 'https://media.sporely.no/user-a/696/thumb_0_123.webp')
    assert.equal(sources[696].fallbackUrl, 'https://media.sporely.no/user-a/696/0_123.webp')
  })

  assert.equal(calls[0], 'observation_images_community_view')
})
