import test from 'node:test'
import assert from 'node:assert/strict'

import { supabase } from './supabase.js'
import { normalizeAiCropRect } from './image_crop.js'
import { ID_SERVICE_ARTSORAKEL } from './identify.js'
import {
  prepareReviewIdentifyInputs,
} from './screens/review.js'
import {
  prepareDetailIdentifyInputs,
  runDetailIdentify,
} from './screens/find_detail.js'
import {
  runArtsorakel,
  runArtsorakelForBlobs,
  runArtsorakelForMediaKeys,
} from './artsorakel.js'

const TEST_APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

function makeResponse({ ok = true, status = 200, statusText = 'OK', jsonBody = null, textBody = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    async json() {
      if (jsonBody !== null) return jsonBody
      throw new Error('No JSON body configured')
    },
    async text() {
      if (textBody) return textBody
      if (jsonBody !== null) return JSON.stringify(jsonBody)
      return ''
    },
  }
}

function installHarness() {
  const originalFetch = globalThis.fetch
  const originalFormData = globalThis.FormData
  const originalImage = globalThis.Image
  const originalDocument = globalThis.document
  const originalLocalStorage = globalThis.localStorage
  const originalAiDebug = globalThis.__sporelyAiDebug
  const originalTestEnv = globalThis.__SPORLEY_TEST_ENV__
  const originalCreateObjectURL = globalThis.URL?.createObjectURL
  const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL
  const originalGetSession = supabase.auth.getSession
  const originalStorageFrom = supabase.storage.from

  const blobDimensions = new WeakMap()
  const objectUrlToBlob = new Map()
  let urlSeq = 0
  let canvasToBlobCount = 0
  let fetchImpl = async () => makeResponse()
  let proxySession = null
  let storageDownloadImpl = async () => ({ data: null, error: new Error('download not configured') })

  class MockCanvas {
    constructor() {
      this.width = 0
      this.height = 0
    }

    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        drawImage() {},
      }
    }

    toBlob(callback, type) {
      canvasToBlobCount += 1
      callback(new Blob([`${type || 'image/jpeg'}:${this.width}x${this.height}`], {
        type: type || 'image/jpeg',
      }))
    }
  }

  class MockImage {
    set src(url) {
      const blob = objectUrlToBlob.get(url)
      const dims = blobDimensions.get(blob) || { width: 1200, height: 800 }
      this.naturalWidth = dims.width
      this.naturalHeight = dims.height
      this.width = dims.width
      this.height = dims.height
      queueMicrotask(() => {
        if (blob) {
          this.onload?.()
        } else {
          this.onerror?.(new Error('Missing blob for object URL'))
        }
      })
    }
  }

  class MockFormData {
    constructor() {
      this.entries = []
    }

    append(name, value, filename) {
      this.entries.push({ name, value, filename })
    }

    get(name) {
      return this.entries.find(entry => entry.name === name)?.value ?? null
    }
  }

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

  globalThis.fetch = async (...args) => fetchImpl(...args)
  globalThis.FormData = MockFormData
  globalThis.Image = MockImage
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return new MockCanvas()
      throw new Error(`Unexpected element: ${tag}`)
    },
  }
  const localStorageStore = new Map()
  globalThis.localStorage = {
    getItem(key) {
      return localStorageStore.has(key) ? localStorageStore.get(key) : null
    },
    setItem(key, value) {
      localStorageStore.set(String(key), String(value))
    },
    removeItem(key) {
      localStorageStore.delete(String(key))
    },
  }
  globalThis.__SPORLEY_TEST_ENV__ = {}
  globalThis.__sporelyAiDebug = {}
  defineUrlMethod('createObjectURL', blob => {
    const url = `blob:test-${++urlSeq}`
    objectUrlToBlob.set(url, blob)
    return url
  })
  defineUrlMethod('revokeObjectURL', url => {
    objectUrlToBlob.delete(url)
  })
  supabase.auth.getSession = async () => ({
    data: { session: proxySession ? { access_token: proxySession } : null },
  })
  supabase.storage.from = () => ({
    download: storageDownloadImpl,
  })

  return {
    setFetch(fn) {
      fetchImpl = fn
    },
    setBlobDimensions(blob, width, height) {
      blobDimensions.set(blob, { width, height })
    },
    setEnv(env) {
      globalThis.__SPORLEY_TEST_ENV__ = { ...env }
    },
    setProxySession(token) {
      proxySession = token
    },
    setStorageDownloadImpl(fn) {
      storageDownloadImpl = fn
    },
    getCanvasToBlobCount() {
      return canvasToBlobCount
    },
    restore() {
      globalThis.fetch = originalFetch
      globalThis.FormData = originalFormData
      globalThis.Image = originalImage
      globalThis.document = originalDocument
      globalThis.localStorage = originalLocalStorage
      globalThis.__sporelyAiDebug = originalAiDebug
      globalThis.__SPORLEY_TEST_ENV__ = originalTestEnv
      defineUrlMethod('createObjectURL', originalCreateObjectURL)
      defineUrlMethod('revokeObjectURL', originalRevokeObjectURL)
      supabase.auth.getSession = originalGetSession
      supabase.storage.from = originalStorageFrom
    },
  }
}

async function withHarness(fn) {
  const harness = installHarness()
  try {
    return await fn(harness)
  } finally {
    harness.restore()
  }
}

test('converts a small WebP blob to JPEG before posting', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['webp'], { type: 'image/webp' })
    harness.setBlobDimensions(blob, 800, 600)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no')

    const form = calls[0].init.body
    const sent = form.get('image')
    const headers = new Headers(calls[0].init.headers)
    assert.equal(calls[0].url, 'https://ai.artsdatabanken.no')
    assert.equal(sent.type, 'image/jpeg')
    assert.equal(form.entries[0].filename, 'photo.jpg')
    assert.equal(headers.get('X-App-Name'), 'Sporely')
    assert.equal(headers.get('X-App-Version'), TEST_APP_VERSION)
  })
})

test('keeps a small JPEG blob as JPEG when no resize is needed', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 400, 300)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no')

    const form = calls[0].init.body
    assert.equal(form.get('image'), blob)
    assert.equal(form.entries[0].filename, 'photo.jpg')
    assert.equal(form.get('image').type, 'image/jpeg')
  })
})

test('resizes a large JPEG blob and posts JPEG output', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['jpeg-large'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 2200, 1800)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no')

    const sent = calls[0].init.body.get('image')
    assert.notEqual(sent, blob)
    assert.equal(sent.type, 'image/jpeg')
    assert.equal(calls[0].init.body.entries[0].filename, 'photo.jpg')
  })
})

test('resizes and converts a large WebP blob to JPEG', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['webp-large'], { type: 'image/webp' })
    harness.setBlobDimensions(blob, 2200, 1800)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no')

    const sent = calls[0].init.body.get('image')
    assert.equal(sent.type, 'image/jpeg')
    assert.notEqual(sent, blob)
    assert.equal(calls[0].init.body.entries[0].filename, 'photo.jpg')
  })
})

test('runArtsorakelForBlobs avoids a second JPEG conversion when the blob is already prepared', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 400, 300)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [{ probability: 0.9, taxon: { scientificName: 'Amanita muscaria' } }] } })
    })

    await runArtsorakelForBlobs([
      {
        blob,
        cropRect: normalizeAiCropRect({ x1: 0.1, y1: 0.1, x2: 0.7, y2: 0.7 }),
      },
    ], 'no')

    assert.equal(harness.getCanvasToBlobCount(), 1)
    assert.equal(calls[0].init.body.get('image').type, 'image/jpeg')
  })
})

test('runArtsorakel uses a filename that matches the prepared blob type', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['prepared'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 900, 700)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no', {
      prepared: true,
      preparedBlob: blob,
    })

    assert.equal(calls[0].init.body.entries[0].filename, 'photo.jpg')
    assert.equal(calls[0].init.body.get('image').type, 'image/jpeg')
  })
})

test('retries multipart field "file" after "image" fails', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 800, 600)
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        return makeResponse({ ok: false, status: 500, statusText: 'Server Error', textBody: 'image failed' })
      }
      return makeResponse({ jsonBody: { predictions: [{ probability: 0.8, taxon: { scientificName: 'Boletus edulis' } }] } })
    })

    await runArtsorakel(blob, 'no')

    assert.equal(calls.length, 2)
    assert.equal(calls[0].init.body.entries[0].name, 'image')
    assert.equal(calls[1].init.body.entries[0].name, 'file')
  })
})

test('falls back to direct Artsorakel when the proxy fails', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['webp'], { type: 'image/webp' })
    harness.setBlobDimensions(blob, 800, 600)
    harness.setEnv({ VITE_ARTSORAKEL_BASE_URL: 'https://proxy.example' })
    harness.setProxySession('proxy-token')
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith('https://proxy.example')) {
        return makeResponse({ ok: false, status: 500, statusText: 'Proxy Error', textBody: 'proxy failed' })
      }
      return makeResponse({ jsonBody: { predictions: [{ probability: 0.9, taxon: { scientificName: 'Cantharellus cibarius' } }] } })
    })

    await runArtsorakel(blob, 'no')

    const proxyHeaders = new Headers(calls[0].init.headers)
    const directHeaders = new Headers(calls[2].init.headers)
    assert.equal(calls[0].url, 'https://proxy.example/artsorakel')
    assert.equal(calls[1].url, 'https://proxy.example/artsorakel')
    assert.equal(calls[2].url, 'https://ai.artsdatabanken.no')
    assert.equal(proxyHeaders.get('X-App-Name'), 'Sporely')
    assert.equal(proxyHeaders.get('X-App-Version'), TEST_APP_VERSION)
    assert.equal(directHeaders.get('X-App-Name'), 'Sporely')
    assert.equal(directHeaders.get('X-App-Version'), TEST_APP_VERSION)
  })
})

test('throws an error with endpoint and blob metadata when both proxy and direct fail', async () => {
  await withHarness(async harness => {
    const blob = new Blob(['webp'], { type: 'image/webp' })
    harness.setBlobDimensions(blob, 1700, 1300)
    harness.setEnv({ VITE_ARTSORAKEL_BASE_URL: 'https://proxy.example' })
    harness.setProxySession('proxy-token')
    harness.setFetch(async () => makeResponse({ ok: false, status: 500, statusText: 'Server Error', textBody: 'bad news' }))

    await assert.rejects(
      runArtsorakel(blob, 'no'),
      error => {
        assert.match(error.message, /proxy/i)
        assert.match(error.message, /direct/i)
        assert.match(error.message, /status=500/)
        assert.match(error.message, /body=bad news/)
        assert.match(error.message, /blob=image\/jpeg:/)
        return true
      },
    )
  })
})

test('does not use VITE_MEDIA_UPLOAD_BASE_URL as an implicit Artsorakel proxy', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 800, 600)
    harness.setEnv({ VITE_MEDIA_UPLOAD_BASE_URL: 'https://upload.example' })
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no')

    assert.equal(calls[0].url, 'https://ai.artsdatabanken.no')
    assert.equal(calls.some(call => call.url.startsWith('https://upload.example')), false)
  })
})

test('logs direct Artsorakel debug entries with the shared service id', async () => {
  await withHarness(async harness => {
    const calls = []
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 800, 600)
    globalThis.localStorage.setItem('sporely-debug-artsorakel', 'true')
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    await runArtsorakel(blob, 'no')

    assert.equal(calls.length, 1)
    assert.equal(globalThis.__sporelyAiDebug.artsorakel.length, 1)
    assert.equal(globalThis.__sporelyAiDebug.artsorakel[0].service, 'artsorakel')
    assert.equal(globalThis.__sporelyAiDebug.artsorakel[0].endpoint, 'https://ai.artsdatabanken.no')
  })
})

test('debug logging failures do not break the Artsorakel request', async () => {
  await withHarness(async harness => {
    const calls = []
    const warnings = []
    const originalWarn = console.warn
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    harness.setBlobDimensions(blob, 800, 600)
    globalThis.localStorage.setItem('sporely-debug-artsorakel', 'true')
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      value: () => {
        throw new Error('debug explode')
      },
      configurable: true,
      writable: true,
    })
    console.warn = (...args) => {
      warnings.push(args)
    }
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })

    try {
      await runArtsorakel(blob, 'no')
    } finally {
      console.warn = originalWarn
    }

    assert.equal(calls.length, 1)
    assert.equal(globalThis.__sporelyAiDebug?.artsorakel?.length || 0, 0)
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0] || ''), /artsorakel-debug/)
    assert.match(String(warnings[0][1]?.message || warnings[0][1] || ''), /debug explode/)
  })
})

test('runArtsorakelForMediaKeys requires a real Artsorakel proxy', async () => {
  await withHarness(async harness => {
    const calls = []
    harness.setEnv({ VITE_MEDIA_UPLOAD_BASE_URL: 'https://upload.example' })
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({ jsonBody: { predictions: [] } })
    })
    await assert.rejects(
      runArtsorakelForMediaKeys(['media/key.jpg'], 'no'),
      error => {
        assert.match(error.message, /Artsorakel media proxy unavailable/)
        return true
      },
    )
    assert.equal(calls.length, 0)
  })
})

test('runArtsorakelForMediaKeys sends app headers to the proxy', async () => {
  await withHarness(async harness => {
    const calls = []
    harness.setEnv({ VITE_ARTSORAKEL_BASE_URL: 'https://proxy.example' })
    harness.setProxySession('proxy-token')
    harness.setFetch(async (url, init) => {
      calls.push({ url, init })
      return makeResponse({
        jsonBody: {
          ok: true,
          total: 1,
          responses: [{
            key: 'media/key.jpg',
            data: { predictions: [] },
          }],
          errors: [],
        },
      })
    })

    await runArtsorakelForMediaKeys(['media/key.jpg'], 'no')

    const headers = new Headers(calls[0].init.headers)
    assert.equal(calls[0].url, 'https://proxy.example/artsorakel/media')
    assert.equal(headers.get('Authorization'), 'Bearer proxy-token')
    assert.equal(headers.get('X-App-Name'), 'Sporely')
    assert.equal(headers.get('X-App-Version'), TEST_APP_VERSION)
  })
})

test('detail view falls back to media-key identify after an Artsdata AI 500', async () => {
  await withHarness(async harness => {
    const storedBlob = new Blob(['stored'], { type: 'image/webp' })
    harness.setBlobDimensions(storedBlob, 1800, 1200)
    harness.setStorageDownloadImpl(async () => ({
      data: storedBlob,
      error: null,
    }))

    let blobIdentifyCalls = 0
    let mediaKeyIdentifyCalls = 0
    const galleryImgs = [{
      dataset: {
        storagePath: 'user/42/observation/image.webp',
        aiFallback: 'https://example.invalid/fallback.webp',
        aiSrc: 'https://example.invalid/source.webp',
      },
      src: 'https://example.invalid/source.webp',
    }]

    const predictions = await runDetailIdentify(ID_SERVICE_ARTSORAKEL, galleryImgs, {
      identifyBlobs: async () => {
        blobIdentifyCalls += 1
        throw new Error('Artsdata AI 500: proxy endpoint https://proxy.example/artsorakel status=500 body=bad news blob=image/webp:1234')
      },
      identifyMediaKeys: async keys => {
        mediaKeyIdentifyCalls += 1
        assert.deepEqual(keys, ['user/42/observation/image.webp'])
        return [{ probability: 0.91, scientificName: 'Boletus edulis', displayName: 'King bolete' }]
      },
    })

    assert.equal(blobIdentifyCalls, 1)
    assert.equal(mediaKeyIdentifyCalls, 1)
    assert.equal(predictions[0].displayName, 'King bolete')
  })
})

test('detail Artsorakel identify loads the original image before maxEdge downscale', async () => {
  await withHarness(async harness => {
    const requestedPaths = []
    const sourceBlob = new Blob(['original'], { type: 'image/webp' })
    harness.setBlobDimensions(sourceBlob, 2400, 1600)
    harness.setStorageDownloadImpl(async path => {
      requestedPaths.push(path)
      return {
        data: sourceBlob,
        error: null,
      }
    })

    const galleryImgs = [{
      dataset: {
        storagePath: 'user/42/observation/image.webp',
        aiFallback: 'https://example.invalid/fallback.webp',
        aiSrc: 'https://example.invalid/source.webp',
      },
      src: 'https://example.invalid/source.webp',
    }]

    const predictions = await runDetailIdentify(ID_SERVICE_ARTSORAKEL, galleryImgs, {
      identifyBlobs: async inputs => {
        assert.equal(inputs[0].requestedVariant, 'original')
        assert.equal(inputs[0].blob.type, 'image/jpeg')
        return [{ probability: 0.91, scientificName: 'Boletus edulis' }]
      },
    })

    assert.equal(requestedPaths[0], 'user/42/observation/image.webp')
    assert.equal(predictions[0].scientificName, 'Boletus edulis')
  })
})

test('review inputs prefer current-session aiBlob values', async () => {
  await withHarness(async harness => {
    const aiBlob = new Blob(['ai'], { type: 'image/webp' })
    const rawBlob = new Blob(['raw'], { type: 'image/jpeg' })
    harness.setBlobDimensions(aiBlob, 1400, 1000)
    harness.setBlobDimensions(rawBlob, 1400, 1000)

    const inputs = await prepareReviewIdentifyInputs([
      {
        aiBlob,
        blob: rawBlob,
        aiCropRect: normalizeAiCropRect({ x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }),
      },
      {
        blob: rawBlob,
      },
    ])

    assert.equal(inputs[0].source, 'photo.aiBlob')
    assert.equal(inputs[0].blob, aiBlob)
    assert.equal(inputs[1].source, 'photo.blob')
    assert.equal(inputs[1].blob, rawBlob)
  })
})

test('detail identify helper exposes the storage-path fallback path for debugging', async () => {
  await withHarness(async harness => {
    const storedBlob = new Blob(['stored'], { type: 'image/webp' })
    harness.setBlobDimensions(storedBlob, 1500, 1500)
    harness.setStorageDownloadImpl(async () => ({
      data: storedBlob,
      error: null,
    }))

    const inputs = await prepareDetailIdentifyInputs([{
      dataset: {
        storagePath: 'user/1/2/image.webp',
        aiFallback: 'https://example.invalid/medium.webp',
        aiSrc: 'https://example.invalid/original.webp',
      },
      src: 'https://example.invalid/original.webp',
    }], 'medium')

    assert.equal(inputs[0].sourceMode, 'blob')
    assert.equal(inputs[0].usedFallbackUrl, false)
    assert.equal(inputs[0].requestedVariant, 'medium')
    assert.equal(inputs[0].storagePathExtension, 'webp')
    assert.equal(inputs[0].blob.type, 'image/jpeg')
    assert.equal(inputs[0].debug.blobType, 'image/jpeg')
    assert.equal(inputs[0].debug.width, 500)
    assert.equal(inputs[0].debug.height, 500)
  })
})
