import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkerUploadHeaders,
  canUseDirectSupabaseStorageFallback,
} from './images.js'

test('direct Supabase storage fallback stays disabled outside dev builds', () => {
  assert.equal(canUseDirectSupabaseStorageFallback(), false)
})

test('worker upload headers carry the selected quality profile', () => {
  const headers = buildWorkerUploadHeaders({
    blob: new Blob(['x'], { type: 'image/webp' }),
    accessToken: 'token-123',
    options: {
      uploadMode: 'full',
      cloudPlan: 'pro',
      qualityProfile: 'high',
      uploadVariant: 'full',
    },
    uploadMeta: {
      encoding_quality: 80,
      encoding_format: 'image/webp',
      source_width: 4000,
      source_height: 3000,
      stored_width: 4000,
      stored_height: 3000,
    },
  })

  assert.equal(headers.Authorization, 'Bearer token-123')
  assert.equal(headers['X-Sporely-Upload-Mode'], 'full')
  assert.equal(headers['X-Sporely-Cloud-Plan'], 'pro')
  assert.equal(headers['X-Sporely-Quality-Profile'], 'high')
  assert.equal(headers['X-Sporely-Encoding-Quality'], '80')
  assert.equal(headers['X-Sporely-Encoding-Format'], 'image/webp')
  assert.equal(headers['X-Sporely-Source-Width'], '4000')
  assert.equal(headers['X-Sporely-Source-Height'], '3000')
  assert.equal(headers['X-Sporely-Stored-Width'], '4000')
  assert.equal(headers['X-Sporely-Stored-Height'], '3000')
})
