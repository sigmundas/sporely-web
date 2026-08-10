import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from './supabase.js'
import {
  ensureImageIdentitySelect,
  fetchCardImages,
  fetchFirstImages,
  fetchObservationImageRows,
  resolveMediaSources,
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

test('authorized full URL wins without changing the storage identity', () => {
  const [source] = resolveMediaSources([{
    full_media_url: 'https://upload.sporely.no/m/4960/full?v=1',
    storage_path: 'user/obs/image.webp',
  }], { variant: 'original' })

  assert.equal(source.primaryUrl, 'https://upload.sporely.no/m/4960/full?v=1')
  assert.equal(source.key, 'user/obs/image.webp')
})

test('authorized thumbnail wins over camelCase and legacy thumbnail fields', () => {
  const [snakeSource] = resolveMediaSources([{
    thumb_media_url: 'https://upload.sporely.no/m/4960/thumb?v=1',
    thumb_key: 'user/obs/thumb_image.webp',
    storage_path: 'user/obs/image.webp',
  }], { variant: 'medium' })
  const [camelSource] = resolveMediaSources([{
    thumbMediaUrl: 'https://upload.sporely.no/m/4961/thumb?v=2',
    thumbUrl: 'https://media.sporely.no/user/obs/thumb_old.webp',
    fullMediaUrl: 'https://upload.sporely.no/m/4961/full?v=2',
  }], { variant: 'thumb' })

  assert.equal(snakeSource.primaryUrl, 'https://upload.sporely.no/m/4960/thumb?v=1')
  assert.equal(camelSource.primaryUrl, 'https://upload.sporely.no/m/4961/thumb?v=2')
  assert.equal(camelSource.key, '', 'an authorized URL must not become a storage key')
})

test('empty authorized fields fall back to exact legacy URLs', () => {
  const [source] = resolveMediaSources([{
    full_media_url: ' ',
    thumb_media_url: null,
    storage_path: 'user/obs/image.webp',
    thumb_key: 'user/obs/thumb_image.webp',
  }], { variant: 'medium' })

  assert.equal(source.primaryUrl, 'https://media.sporely.no/user/obs/thumb_image.webp')
  assert.equal(source.fallbackUrl, 'https://media.sporely.no/user/obs/image.webp')
  assert.equal(source.key, 'user/obs/image.webp')
})

test('protected authorized URL is separated from direct img-src and legacy fallback', () => {
  const [source] = resolveMediaSources([{
    full_media_url: 'https://upload.sporely.no/m/4960/full?v=1',
    thumb_media_url: 'https://upload.sporely.no/m/4960/thumb?v=1',
    observation_visibility: 'friends',
    storage_path: 'user/obs/image.webp',
  }], { variant: 'thumb' })

  assert.equal(source.primaryUrl, null)
  assert.equal(source.fallbackUrl, null)
  assert.equal(source.protectedUrl, 'https://upload.sporely.no/m/4960/thumb?v=1')
  assert.equal(source.key, 'user/obs/image.webp')
})

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

test('public card image prefers authorized projection URL', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') return []
    return [{
      id: 4960,
      image_id: 4960,
      observation_id: 697,
      storage_path: 'user-a/697/0_123.webp',
      sort_order: 0,
      observation_visibility: 'public',
      media_version: 1,
      full_media_url: 'https://upload.sporely.no/m/4960/full?v=1',
      thumb_media_url: 'https://upload.sporely.no/m/4960/thumb?v=1',
    }]
  }), async () => {
    const sources = await fetchFirstImages([697], { variant: 'medium' })
    assert.equal(sources[697].primaryUrl, 'https://upload.sporely.no/m/4960/thumb?v=1')
    assert.equal(sources[697].fallbackUrl, 'https://upload.sporely.no/m/4960/full?v=1')
  })
})

test('friends-only card image uses authenticated Worker delivery without a legacy fallback', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') return []
    return [{
      id: 4962,
      observation_id: 698,
      storage_path: 'user-a/698/0_123.webp',
      sort_order: 0,
      observation_visibility: 'friends',
      full_media_url: 'https://upload.sporely.no/m/4962/full?v=1',
      thumb_media_url: 'https://upload.sporely.no/m/4962/thumb?v=1',
    }]
  }), async () => {
    const sources = await fetchFirstImages([698], { variant: 'medium' })
    assert.equal(sources[698].primaryUrl, null)
    assert.equal(sources[698].fallbackUrl, null)
    assert.equal(sources[698].protectedUrl, 'https://upload.sporely.no/m/4962/thumb?v=1')
  })
})

test('community projection enriches a duplicate raw row with authorized public URLs', async () => {
  await withSupabaseFromStub(makeTableStub(table => {
    if (table === 'observation_images') {
      return [{ id: 6001, observation_id: 699, storage_path: 'u/699/0.webp', sort_order: 0 }]
    }
    return [{
      id: 6001,
      observation_id: 699,
      storage_path: 'u/699/0.webp',
      sort_order: 0,
      observation_visibility: 'public',
      media_version: 3,
      full_media_url: 'https://upload.sporely.no/m/6001/full?v=3',
      thumb_media_url: 'https://upload.sporely.no/m/6001/thumb?v=3',
    }]
  }), async () => {
    const sources = await fetchFirstImages([699], { variant: 'medium' })
    assert.equal(sources[699].primaryUrl, 'https://upload.sporely.no/m/6001/thumb?v=3')
  })
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

test('owner-only image fields are selected from raw rows but never from the community projection', async () => {
  const captureSelects = []
  await withSupabaseFromStub(makeTableStub(table => table === 'observation_images'
    ? [{ id: 88, observation_id: 808, image_type: 'microscope', captured_at: '2026-08-10T19:42:00Z' }]
    : [], { captureSelects }), async () => {
    const rows = await fetchObservationImageRows([808], {
      selectFields: 'id, observation_id, image_type',
      ownerSelectFields: 'id, observation_id, image_type, captured_at',
    })
    assert.equal(rows[0].captured_at, '2026-08-10T19:42:00Z')
  })

  const ownerSelect = captureSelects.find(call => call.table === 'observation_images')?.selectFields || ''
  const communitySelects = captureSelects
    .filter(call => call.table === 'observation_images_community_view')
    .map(call => call.selectFields)
  assert.match(ownerSelect, /captured_at/)
  assert.ok(communitySelects.length > 0)
  communitySelects.forEach(selectFields => assert.doesNotMatch(selectFields, /captured_at/))
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
