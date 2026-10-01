import test from 'node:test'
import assert from 'node:assert/strict'
import { buildObservationImageStoragePath, randomStorageKeySuffix, resolveMediaSources } from './images.js'

const USER = '8c471394-b274-4933-b830-59805820d93c'

test('buildObservationImageStoragePath uses a random suffix, never the clock', t => {
  t.mock.method(Date, 'now', () => 1789393650123)
  const first = buildObservationImageStoragePath({ userId: USER, observationId: 617, sortOrder: 2, extension: '.webp' })
  const second = buildObservationImageStoragePath({ userId: USER, observationId: 617, sortOrder: 2, extension: 'webp' })
  assert.match(first, new RegExp(`^${USER}/617/2_[0-9a-f]{32}\\.webp$`))
  assert.notEqual(first, second)
  assert.equal(first.includes('1789393650'), false)
  // Variant prefixes are still derivable and stripped as before.
  assert.equal(first.split('/').pop().startsWith('thumb_'), false)
})

test('buildObservationImageStoragePath ignores a legacy timestamp argument', () => {
  const path = buildObservationImageStoragePath({ userId: USER, observationId: 1, timestamp: 1789393650123, random: () => 'abcdef0123456789abcdef0123456789' })
  assert.equal(path, `${USER}/1/0_abcdef0123456789abcdef0123456789.jpg`)
})

test('buildObservationImageStoragePath refuses a weak suffix', () => {
  assert.throws(() => buildObservationImageStoragePath({ userId: USER, observationId: 1, random: () => '' }))
})

test('randomStorageKeySuffix returns 32 hex chars', () => {
  assert.match(randomStorageKeySuffix(), /^[0-9a-f]{32}$/)
})

test('resolveMediaSources renders a keyless non-owner row from worker URLs with an opaque cache key', () => {
  const [source] = resolveMediaSources([{
    id: 28,
    observation_id: 29,
    storage_path: null,
    image_id: 28,
    media_version: 3,
    full_media_url: 'https://upload.sporely.no/m/28/full?v=3',
    thumb_media_url: 'https://upload.sporely.no/m/28/thumb?v=3',
    observation_visibility: 'public',
  }], { variant: 'medium' })
  assert.equal(source.key, 'image:28:v3')
  assert.equal(source.primaryUrl, 'https://upload.sporely.no/m/28/thumb?v=3')
  assert.equal(String(source.primaryUrl).includes('media.sporely.no'), false)
})
