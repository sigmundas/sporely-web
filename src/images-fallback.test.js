import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkerUploadHeaders,
  canUseLegacySupabaseStorageFallbackForTestsOnly,
  prepareImageVariants,
  resolveMediaSources,
  uploadPreparedObservationImageVariants,
  UNDECODABLE_IMAGE_USER_MESSAGE,
} from './images.js'
import { buildCloudUploadPolicy } from './cloud-media-policy.js'
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

function withImagePipelineHarness({ decodeFails = false, width = 1600, height = 1200 } = {}, fn) {
  const originalImage = globalThis.Image
  const originalDocument = globalThis.document
  const originalHTMLCanvasElement = globalThis.HTMLCanvasElement
  const originalCreateObjectURL = globalThis.URL?.createObjectURL
  const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL

  const defineUrlMethod = (name, value) => {
    try {
      Object.defineProperty(globalThis.URL, name, {
        value,
        configurable: true,
        writable: true,
      })
    } catch (_) {
      try {
        globalThis.URL[name] = value
      } catch (_) {}
    }
  }

  class MockImage {
    constructor() {
      this.naturalWidth = width
      this.naturalHeight = height
      this.width = width
      this.height = height
    }

    set src(_value) {
      queueMicrotask(() => {
        if (decodeFails) {
          this.onerror?.(new Error('Image decode failed'))
          return
        }
        this.onload?.()
      })
    }
  }

  class MockCanvas {
    constructor() {
      this.width = 0
      this.height = 0
    }

    getContext() {
      return {
        fillRect() {},
        drawImage() {},
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
        fillStyle: '#000',
      }
    }

    toBlob(callback, type) {
      callback(new Blob([`${type || 'image/jpeg'}:${this.width}x${this.height}`], {
        type: type || 'image/jpeg',
      }))
    }
  }

  globalThis.Image = MockImage
  globalThis.HTMLCanvasElement = MockCanvas
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`)
      return new MockCanvas()
    },
  }
  defineUrlMethod('createObjectURL', () => 'blob:test-image')
  defineUrlMethod('revokeObjectURL', () => {})

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.Image = originalImage
      globalThis.HTMLCanvasElement = originalHTMLCanvasElement
      globalThis.document = originalDocument
      defineUrlMethod('createObjectURL', originalCreateObjectURL)
      defineUrlMethod('revokeObjectURL', originalRevokeObjectURL)
    })
}

function withWorkerImagePipelineHarness({ width = 1600, height = 1200 } = {}, fn) {
  const originalWorker = globalThis.Worker
  const originalCreateImageBitmap = globalThis.createImageBitmap
  const originalOffscreenCanvas = globalThis.OffscreenCanvas

  class MockWorker {
    constructor() {
      this.onmessage = null
      this.onerror = null
    }

    postMessage(message) {
      queueMicrotask(() => {
        this.onmessage?.({
          data: {
            id: message.id,
            result: {
              fullBytes: new Uint8Array([1, 2, 3]).buffer,
              fullType: 'image/webp',
              fullSize: 3,
              sourceWidth: width,
              sourceHeight: height,
              targetWidth: width,
              targetHeight: height,
              storedWidth: width,
              storedHeight: height,
              encodingQuality: 82,
              thumbBytes: new Uint8Array([4, 5]).buffer,
              thumbType: 'image/webp',
              thumbSize: 2,
              thumbWidth: 40,
              thumbHeight: 30,
              thumbEncodingQuality: 75,
              thumbEncodingFormat: 'image/webp',
            },
          },
        })
      })
    }

    terminate() {}
  }

  globalThis.Worker = MockWorker
  globalThis.createImageBitmap = async () => ({
    width,
    height,
    close() {},
  })
  globalThis.OffscreenCanvas = class {}

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.Worker = originalWorker
      globalThis.createImageBitmap = originalCreateImageBitmap
      globalThis.OffscreenCanvas = originalOffscreenCanvas
    })
}

function withSupabaseSignedUrlTrap(fn) {
  const originalStorageFrom = supabase.storage.from
  supabase.storage.from = () => ({
    createSignedUrls: () => {
      throw new Error('unexpected Supabase signed URL request for observation media')
    },
  })

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      supabase.storage.from = originalStorageFrom
    })
}

test('legacy Supabase storage fallback stays tests-only and DEV alone does not enable it', async () => {
  await withTestEnv({}, async () => {
    assert.equal(canUseLegacySupabaseStorageFallbackForTestsOnly(), false)
  })

  await withTestEnv({ DEV: 'true' }, async () => {
    assert.equal(canUseLegacySupabaseStorageFallbackForTestsOnly(), false)
  })

  await withTestEnv({ VITE_ALLOW_SUPABASE_STORAGE_FALLBACK_FOR_TESTS_ONLY: 'true' }, async () => {
    assert.equal(canUseLegacySupabaseStorageFallbackForTestsOnly(), false)
  })

  await withTestEnv({ MODE: 'test', VITE_ALLOW_SUPABASE_STORAGE_FALLBACK_FOR_TESTS_ONLY: 'true' }, async () => {
    assert.equal(canUseLegacySupabaseStorageFallbackForTestsOnly(), true)
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

test('worker uploads go through the media worker and never touch Supabase Storage', async () => {
  const originalGetSession = supabase.auth.getSession
  const originalFetch = globalThis.fetch
  const originalStorageFrom = supabase.storage.from
  const requests = []

  supabase.auth.getSession = async () => ({
    data: {
      session: {
        access_token: 'token-123',
      },
    },
  })
  supabase.storage.from = () => {
    throw new Error('unexpected Supabase Storage access during worker upload')
  }
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: String(init.method || 'GET') })
    return new Response(null, { status: 200 })
  }

  try {
    await withTestEnv({
      MODE: 'test',
      VITE_MEDIA_UPLOAD_BASE_URL: 'https://upload.example',
    }, async () => {
      const preparedImage = {
        uploadBlob: new Blob(['full'], { type: 'image/jpeg' }),
        variants: {
          thumb: new Blob(['thumb'], { type: 'image/jpeg' }),
        },
        uploadMeta: {
          upload_mode: 'full',
          quality_profile: 'standard',
          encoding_quality: 80,
          encoding_format: 'image/jpeg',
          source_width: 100,
          source_height: 80,
          stored_width: 100,
          stored_height: 80,
          stored_bytes: 4,
        },
        variantMeta: {
          thumb: {
            upload_mode: 'full',
            quality_profile: 'standard',
            encoding_quality: 80,
            encoding_format: 'image/jpeg',
            source_width: 100,
            source_height: 80,
            stored_width: 40,
            stored_height: 32,
            stored_bytes: 5,
          },
        },
      }

      await uploadPreparedObservationImageVariants(
        preparedImage,
        '8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp',
        {
          userId: '8c471394-b274-4933-b830-59805820d93c',
          observationId: 617,
        },
      )
    })

    assert.deepEqual(requests.map(entry => entry.method), ['PUT', 'PUT'])
    assert.deepEqual(requests.map(entry => entry.url), [
      'https://upload.example/upload/8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp',
      'https://upload.example/upload/8c471394-b274-4933-b830-59805820d93c/617/thumb_0_1780071867059.webp',
    ])
  } finally {
    supabase.auth.getSession = originalGetSession
    supabase.storage.from = originalStorageFrom
    globalThis.fetch = originalFetch
  }
})

test('prepareImageVariants rejects undecodable HEIC instead of returning the raw blob', async () => {
  await withImagePipelineHarness({ decodeFails: true }, async () => {
    const policy = buildCloudUploadPolicy({ cloud_plan: 'free' }, { uploadMode: 'full' })
    const blob = new Blob(['heic'], { type: 'image/heic' })

    await assert.rejects(
      prepareImageVariants(blob, policy),
      error => {
        assert.equal(error.code, 'image_undecodable')
        assert.equal(error.message, UNDECODABLE_IMAGE_USER_MESSAGE)
        assert.match(error.message, /convert the image to JPEG\/WebP first/i)
        return true
      },
    )
  })
})

test('prepareImageVariants re-encodes converted HEIC-to-JPEG blobs through the canvas path', async () => {
  await withImagePipelineHarness({ decodeFails: false }, async () => {
    const policy = buildCloudUploadPolicy({ cloud_plan: 'free' }, { uploadMode: 'full' })
    const blob = new Blob(['converted-heic-jpeg'], { type: 'image/jpeg' })

    const prepared = await prepareImageVariants(blob, policy)

    assert.notEqual(prepared.uploadBlob, blob)
    assert.match(prepared.uploadBlob.type, /^image\/(webp|jpeg)$/)
    assert.ok(prepared.variants.thumb)
    assert.match(prepared.variants.thumb.type, /^image\/(webp|jpeg)$/)
    assert.equal(prepared.uploadMeta.source_width, 1600)
    assert.equal(prepared.uploadMeta.source_height, 1200)
    assert.equal(prepared.uploadMeta.stored_width, 1600)
    assert.equal(prepared.uploadMeta.stored_height, 1200)
    assert.equal(prepared.uploadMeta.storage_exif_safe, true)
  })
})

test('prepareImageVariants marks worker-prepared uploads as exif-safe', async () => {
  await withWorkerImagePipelineHarness({}, async () => {
    const policy = buildCloudUploadPolicy({ cloud_plan: 'free' }, { uploadMode: 'full' })
    const blob = new Blob(['worker-prepared'], { type: 'image/jpeg' })

    const prepared = await prepareImageVariants(blob, policy)

    assert.notEqual(prepared.uploadBlob, blob)
    assert.equal(prepared.uploadMeta.storage_exif_safe, true)
    assert.ok(prepared.variants.thumb)
  })
})

test('normal observation media resolution stays on public R2 URLs and never asks Supabase for signed URLs', async () => {
  await withSupabaseSignedUrlTrap(async () => {
    await withTestEnv({}, async () => {
      const [source] = await resolveMediaSources(
        ['8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp'],
        { variant: 'medium' },
      )

      assert.equal(source.primaryUrl, 'https://media.sporely.no/8c471394-b274-4933-b830-59805820d93c/617/thumb_0_1780071867059.webp')
      assert.equal(source.fallbackUrl, 'https://media.sporely.no/8c471394-b274-4933-b830-59805820d93c/617/0_1780071867059.webp')
    })
  })
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
