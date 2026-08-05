import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from './supabase.js'
import {
  ensureImageIdentitySelect,
  fetchCardImages,
  fetchFirstImages,
  fetchObservationImageRows,
} from './images.js'

function withSupabaseFromStub(stub, fn) {
  const originalFrom = supabase.from
  supabase.from = stub
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      supabase.from = originalFrom
    })
}

function makeTableStub(getRowsForTable, { captureSelects } = {}) {
  return table => {
    return {
      select(selectFields) {
        if (captureSelects) captureSelects.push({ table, selectFields })
        return {
          in() { return this },
          is() { return this },
          order() {
            const result = getRowsForTable(table)
            return Promise.resolve({
              data: Array.isArray(result) ? result : (result?.data || []),
              error: result?.error || null,
            })
          },
        }
      },
    }
  }
}

test('public image rows are merged from the owner raw table and the community image view', async () => {
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
                    id: 1,
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

  assert.ok(calls.includes('observation_images_community_view'), 'community view queried')
  assert.ok(calls.includes('observation_images'), 'owner raw table queried')
})

test('ensureImageIdentitySelect prepends id when omitted and leaves it when present', () => {
  assert.equal(
    ensureImageIdentitySelect('observation_id, storage_path, sort_order, deleted_at'),
    'id, observation_id, storage_path, sort_order, deleted_at',
  )
  assert.equal(
    ensureImageIdentitySelect('id, observation_id'),
    'id, observation_id',
  )
  assert.equal(
    ensureImageIdentitySelect('observations.id, storage_path'),
    'observations.id, storage_path',
  )
})

test('fetchCardImages returns sources for multiple owner observations', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') {
      return [
        { id: 11, observation_id: 101, storage_path: 'u/101/0_a.webp', sort_order: 0 },
        { id: 12, observation_id: 102, storage_path: 'u/102/0_b.webp', sort_order: 0 },
      ]
    }
    return []
  }), async () => {
    const cards = await fetchCardImages([101, 102])
    assert.ok(cards[101]?.first, 'card image survives for obs 101')
    assert.ok(cards[102]?.first, 'card image survives for obs 102')
    assert.equal(cards[101].count, 1)
    assert.equal(cards[102].count, 1)
  })
})

test('mixed owner and community rows both survive the merge', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') {
      return [{ id: 21, observation_id: 101, storage_path: 'u/101/0_a.webp', sort_order: 0 }]
    }
    return [{ id: 22, observation_id: 202, storage_path: 'u/202/0_c.webp', sort_order: 0 }]
  }), async () => {
    const cards = await fetchCardImages([101, 202])
    assert.ok(cards[101]?.first)
    assert.ok(cards[202]?.first)
  })
})

test('duplicate row from both surfaces appears only once', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    const row = { id: 55, observation_id: 500, storage_path: 'u/500/0_x.webp', sort_order: 0 }
    return [row]
  }), async () => {
    const rows = await fetchObservationImageRows([500])
    assert.equal(rows.length, 1)
    const cards = await fetchCardImages([500])
    assert.equal(cards[500].count, 1)
  })
})

test('two images for one observation both survive', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') {
      return [
        { id: 71, observation_id: 700, storage_path: 'u/700/0_a.webp', sort_order: 0 },
        { id: 72, observation_id: 700, storage_path: 'u/700/1_b.webp', sort_order: 1 },
      ]
    }
    return []
  }), async () => {
    const cards = await fetchCardImages([700])
    assert.ok(cards[700].first)
    assert.ok(cards[700].second)
    assert.equal(cards[700].count, 2)
  })
})

test('id is auto-included in the Supabase select even when callers omit it', async () => {
  const captureSelects = []
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') {
      return [
        { id: 81, observation_id: 800, storage_path: 'u/800/0_a.webp', sort_order: 0 },
        { id: 82, observation_id: 801, storage_path: 'u/801/0_b.webp', sort_order: 0 },
      ]
    }
    return []
  }, { captureSelects }), async () => {
    const firsts = await fetchFirstImages([800, 801])
    assert.ok(firsts[800])
    assert.ok(firsts[801])

    const cards = await fetchCardImages([800, 801])
    assert.ok(cards[800]?.first)
    assert.ok(cards[801]?.first)
  })

  for (const call of captureSelects) {
    const fields = String(call.selectFields).split(',').map(s => s.trim())
    assert.ok(fields.includes('id'), `select for ${call.table} must include id, got: ${call.selectFields}`)
  }
})

test('a row missing id does not collapse other rows', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') {
      return [
        { observation_id: 900, storage_path: 'u/900/0_a.webp', sort_order: 0 },
        { id: 91, observation_id: 901, storage_path: 'u/901/0_b.webp', sort_order: 0 },
        { id: 92, observation_id: 902, storage_path: 'u/902/0_c.webp', sort_order: 0 },
      ]
    }
    return []
  }), async () => {
    const rows = await fetchObservationImageRows([900, 901, 902])
    const observationIds = new Set(rows.map(r => r.observation_id))
    assert.ok(observationIds.has(901))
    assert.ok(observationIds.has(902))
    assert.ok(rows.length >= 2, `expected at least the two well-formed rows to survive, got ${rows.length}`)
  })
})
