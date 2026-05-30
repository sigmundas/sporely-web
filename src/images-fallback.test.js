import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkerUploadHeaders,
  canUseDirectSupabaseStorageFallback,
  resolveMediaSources,
  uploadPreparedObservationImageVariants,
} from './images.js'
import { supabase } from './supabase.js'

function withTestEnv(env, fn) {
  const previous = globalThis.__SPORLEY_TEST_ENV__
  globalThis.__SPORLEY_TEST_ENV__ = { ...(previous || {}), ...env }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.__SPORLEY_TEST_ENV__ = previous
    })
}

test('direct Supabase storage fallback stays opt-in only', async () => {
  await withTestEnv({}, async () => {
    assert.equal(canUseDirectSupabaseStorageFallback(), false)
  })

  await withTestEnv({ VITE_ALLOW_SUPABASE_STORAGE_FALLBACK: 'true' }, async () => {
    assert.equal(canUseDirectSupabaseStorageFallback(), true)
  })
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

test('resolveMediaSources prefers public R2 URLs and skips signed Supabase URLs by default', async () => {
  const originalStorageFrom = supabase.storage.from
  let createSignedUrlsCalled = false
  supabase.storage.from = () => ({
    createSignedUrls: async () => {
      createSignedUrlsCalled = true
      return { data: [] }
    },
  })

  try {
    await withTestEnv({}, async () => {
      const [source] = await resolveMediaSources(
        ['8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp'],
        { variant: 'medium' },
      )

      assert.equal(source.primaryUrl, 'https://media.sporely.no/8c471394-b274-4933-b830-59805820d93c/617/thumb_0_1780071867059.webp')
      assert.equal(source.fallbackUrl, 'https://media.sporely.no/8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp')
      assert.equal(source.supabaseFallbackUrl, null)
      assert.equal(createSignedUrlsCalled, false)
    })
  } finally {
    supabase.storage.from = originalStorageFrom
  }
})

test('uploadPreparedObservationImageVariants fails loudly when worker upload is missing and fallback is disabled', async () => {
  await withTestEnv({}, async () => {
    const preparedImage = {
      uploadBlob: new Blob(['x'], { type: 'image/jpeg' }),
      uploadMeta: {
        upload_mode: 'full',
        quality_profile: 'standard',
        encoding_quality: 80,
        encoding_format: 'image/jpeg',
        source_width: 100,
        source_height: 80,
        stored_width: 100,
        stored_height: 80,
        stored_bytes: 1,
      },
      variants: {},
      variantMeta: null,
    }

    await assert.rejects(
      uploadPreparedObservationImageVariants(
        preparedImage,
        '8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp',
        { userId: '8c471394-b274-4933-b830-59805820d93c' },
      ),
      /Media upload worker is not configured; refusing Supabase Storage fallback because R2 is canonical\./,
    )
  })
})
