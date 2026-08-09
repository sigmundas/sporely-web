import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import worker, {
  MEDIA_VARIANTS as MEDIA_VARIANTS_STAGE2,
  LEGACY_UPLOAD_TYPES as LEGACY_UPLOAD_TYPES_STAGE2,
  normalizeUploadType as normalizeUploadType_STAGE2,
  resolveMediaStorageMode as resolveMediaStorageMode_STAGE2,
  selectUploadBucket as selectUploadBucket_STAGE2,
  deriveThumbKey as deriveThumbKey_STAGE2,
} from './index.js'

const TEST_ENV = {
  ALLOWED_ORIGINS: 'https://app.sporely.no,https://localhost,http://localhost:5173',
}

function headerList(text) {
  return String(text || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
}

function createHs256Jwt(secret, claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode(claims)
  const signingInput = `${header}.${payload}`
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

function createWorkerAuthToken() {
  const jwtSecret = 'worker-test-secret'
  const token = createHs256Jwt(jwtSecret, {
    sub: 'user-123',
    iss: 'https://example.supabase.co/auth/v1',
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  })
  return { jwtSecret, token }
}

function installProfileFetchMock(profileRow, storageDeltaRow = null) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input?.url || '')
    if (url.includes('/rest/v1/profiles?')) {
      return new Response(JSON.stringify([profileRow]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }
    if (url.includes('/rest/v1/rpc/apply_profile_storage_delta')) {
      return new Response(JSON.stringify([storageDeltaRow || {
        total_storage_bytes: 420240170,
        storage_used_bytes: 420240170,
        image_count: 244,
      }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

function buildUploadRequest({
  token,
  bodyBytes,
  uploadMode,
  uploadVariant,
  cloudPlan,
  qualityProfile,
  sourceWidth,
  sourceHeight,
  storedWidth,
  storedHeight,
  contentType = 'image/webp',
  origin = 'https://localhost',
}) {
  return new Request('https://upload.sporely.no/upload/user-123/obs-123/0_000000.webp', {
    method: 'PUT',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Sporely-Upload-Mode': uploadMode,
      'X-Sporely-Upload-Variant': uploadVariant,
      'X-Sporely-Cloud-Plan': cloudPlan,
      'X-Sporely-Quality-Profile': qualityProfile,
      'X-Sporely-Encoding-Format': contentType,
      'X-Sporely-Source-Width': String(sourceWidth),
      'X-Sporely-Source-Height': String(sourceHeight),
      'X-Sporely-Stored-Width': String(storedWidth),
      'X-Sporely-Stored-Height': String(storedHeight),
    },
    body: Buffer.alloc(bodyBytes, 1),
  })
}

function assertTooLargeDetails(payload, expectedReason, {
  cloudPlan = 'pro',
  qualityProfile = 'high',
  uploadMode = 'full',
  uploadVariant = 'full',
  storagePath = null,
} = {}) {
  assert.equal(payload.error, 'image_too_large_for_plan')
  assert.equal(payload.message, 'Image too large for plan')
  assert.equal(payload.details.reason, expectedReason)
  assert.ok(Number.isInteger(payload.details.bodyBytes))
  assert.ok(Number.isInteger(payload.details.planByteCap))
  assert.equal(payload.details.configuredByteCap, payload.details.planByteCap)
  assert.ok(Number.isInteger(payload.details.storedWidth))
  assert.ok(Number.isInteger(payload.details.storedHeight))
  assert.ok(Number.isInteger(payload.details.storedPixels))
  assert.ok(Number.isInteger(payload.details.storedPixelCap))
  assert.ok(Number.isInteger(payload.details.resizeMaxEdge))
  assert.equal(payload.details.uploadMode, uploadMode)
  assert.equal(payload.details.uploadVariant, uploadVariant)
  assert.equal(payload.details.encodingFormat, 'image/webp')
  assert.equal(payload.details.contentType, 'image/webp')
  assert.equal(payload.details.cloudPlan, cloudPlan)
  assert.equal(payload.details.qualityProfile, qualityProfile)
  assert.ok(typeof payload.details.storagePath === 'string' && payload.details.storagePath.length > 0)
  if (storagePath !== null) assert.equal(payload.details.storagePath, storagePath)
}

test('OPTIONS preflight allows the Android upload metadata headers', async () => {
  const request = new Request('https://upload.sporely.no/upload/8c471394-b274-4933-b830-59805820d93c/619/0_test.webp', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://localhost',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type,cache-control,x-sporely-source-height,x-sporely-source-width,x-sporely-stored-height,x-sporely-stored-width,x-sporely-encoding-quality,x-sporely-encoding-format,x-sporely-upload-mode,x-sporely-upload-variant,x-sporely-upload-type,x-sporely-image-id,x-sporely-mosaic-id,x-sporely-cloud-plan,x-sporely-quality-profile',
    },
  })

  const response = await worker.fetch(request, TEST_ENV, {})

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://localhost')
  assert.equal(response.headers.get('Access-Control-Max-Age'), '86400')

  const methods = headerList(response.headers.get('Access-Control-Allow-Methods'))
  for (const method of ['get', 'put', 'delete', 'options']) {
    assert.ok(methods.includes(method), `expected allow-methods to include ${method}`)
  }

  const allowHeaders = headerList(response.headers.get('Access-Control-Allow-Headers'))
  for (const header of [
    'authorization',
    'content-type',
    'cache-control',
    'x-sporely-source-height',
    'x-sporely-source-width',
    'x-sporely-stored-height',
    'x-sporely-stored-width',
    'x-sporely-encoding-quality',
    'x-sporely-encoding-format',
    'x-sporely-upload-mode',
    'x-sporely-upload-variant',
    'x-sporely-upload-type',
    'x-sporely-image-id',
    'x-sporely-mosaic-id',
    'x-sporely-cloud-plan',
    'x-sporely-quality-profile',
  ]) {
    assert.ok(allowHeaders.includes(header), `expected allow-headers to include ${header}`)
  }
})

test('normal worker responses keep CORS headers', async () => {
  const request = new Request('https://upload.sporely.no/healthz', {
    method: 'GET',
    headers: {
      Origin: 'https://localhost',
    },
  })

  const response = await worker.fetch(request, TEST_ENV, {})
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://localhost')
  assert.equal(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase().includes('x-sporely-source-height'), true)
})

test('error responses keep CORS headers', async () => {
  const request = new Request('https://upload.sporely.no/nope', {
    method: 'GET',
    headers: {
      Origin: 'https://localhost',
    },
  })

  const response = await worker.fetch(request, TEST_ENV, {})
  const payload = await response.json()

  assert.equal(response.status, 404)
  assert.equal(payload.error, 'not_found')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://localhost')
  assert.equal(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase().includes('x-sporely-source-height'), true)
})

test('healthz exposes media policy values', async () => {
  const request = new Request('https://upload.sporely.no/healthz', {
    method: 'GET',
  })

  const response = await worker.fetch(request, TEST_ENV, {})
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.service, 'sporely-r2-upload-worker')
  assert.equal(payload.workerVersion, 'sporely-r2-upload-worker@source')
  assert.deepEqual(payload.mediaPolicy, {
    fullResizeMaxPixels: 21_000_000,
    fullResizeMaxEdge: 5_300,
    standardFullByteCap: 1_500_000,
    highFullByteCap: 5_000_000,
  })
})

test('legacy full upload without image identity succeeds under the plan caps', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true,
    cloud_plan: 'pro',
    storage_quota_bytes: null,
    total_storage_bytes: 420240170,
    storage_used_bytes: 420240170,
    image_count: 244,
    is_banned: false,
  })

  const mediaBucket = {
    head: async () => null,
    put: async () => ({ etag: 'etag-123' }),
  }

  try {
    const response = await worker.fetch(
      buildUploadRequest({
        token,
        bodyBytes: 2_100_001,
        uploadMode: 'full',
        uploadVariant: 'full',
        cloudPlan: 'pro',
        qualityProfile: 'high',
        sourceWidth: 5_184,
        sourceHeight: 3_888,
        storedWidth: 5_184,
        storedHeight: 3_888,
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: mediaBucket,
        MEDIA_PUBLIC_BASE_URL: 'https://media.sporely.no',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    const payload = await response.json()

    assert.equal(response.status, 201)
    assert.equal(payload.ok, true)
    assert.equal(payload.key, 'user-123/obs-123/0_000000.webp')
    assert.equal(payload.size, 2_100_001)
    assert.equal(payload.url, 'https://media.sporely.no/user-123/obs-123/0_000000.webp')
    assert.equal(payload.etag, 'etag-123')
  } finally {
    restoreFetch()
  }
})

test('legacy thumbnail upload without image identity succeeds', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true, cloud_plan: 'pro', storage_quota_bytes: null,
    total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
  })
  try {
    const response = await worker.fetch(
      buildUploadRequest({
        token, bodyBytes: 1234, uploadMode: 'reduced', uploadVariant: 'thumb',
        cloudPlan: 'pro', qualityProfile: 'high', sourceWidth: 1200,
        sourceHeight: 900, storedWidth: 360, storedHeight: 270,
      }),
      {
        ...TEST_ENV,
        MEDIA_STORAGE_MODE: 'legacy',
        MEDIA_BUCKET: { head: async () => null, put: async () => ({ etag: 'thumb-etag' }) },
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      }, {},
    )
    const payload = await response.json()
    assert.equal(response.status, 201)
    assert.equal(payload.key, 'user-123/obs-123/0_000000.webp')
  } finally { restoreFetch() }
})

test('legacy desktop spore_mosaic upload without mosaic identity succeeds', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true, cloud_plan: 'pro', storage_quota_bytes: null,
    total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
  })
  try {
    const response = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/obs-123/spore_mosaic.webp', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/webp',
          'X-Sporely-Upload-Mode': 'reduced',
          'X-Sporely-Upload-Variant': 'spore_mosaic',
          'X-Sporely-Cloud-Plan': 'pro',
          'X-Sporely-Quality-Profile': 'high',
        },
        body: new TextEncoder().encode('MOSAIC'),
      }),
      {
        ...TEST_ENV,
        MEDIA_STORAGE_MODE: 'legacy',
        MEDIA_BUCKET: { head: async () => null, put: async () => ({ etag: 'mosaic-etag' }) },
        MEDIA_PUBLIC_BASE_URL: 'https://media.sporely.no',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      }, {},
    )
    const payload = await response.json()
    assert.equal(response.status, 201)
    assert.equal(payload.key, 'user-123/obs-123/spore_mosaic.webp')
    assert.equal(payload.url, 'https://media.sporely.no/user-123/obs-123/spore_mosaic.webp')
  } finally { restoreFetch() }
})

test('full free standard uploads over 1.5 MB fail with a byte cap reason', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: false,
    cloud_plan: 'free',
    storage_quota_bytes: 0,
    total_storage_bytes: 0,
    storage_used_bytes: 0,
    image_count: 0,
    is_banned: false,
  })

  try {
    const response = await worker.fetch(
      buildUploadRequest({
        token,
        bodyBytes: 1_600_001,
        uploadMode: 'full',
        uploadVariant: 'full',
        cloudPlan: 'free',
        qualityProfile: 'standard',
        sourceWidth: 5_184,
        sourceHeight: 3_888,
        storedWidth: 5_184,
        storedHeight: 3_888,
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: { head: async () => null, put: async () => ({ etag: 'etag-1' }) },
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    const payload = await response.json()

    assert.equal(response.status, 413)
    assertTooLargeDetails(payload, 'byte_cap', {
      cloudPlan: 'free',
      qualityProfile: 'standard',
      storagePath: 'user-123/obs-123/0_000000.webp',
    })
    assert.equal(payload.details.planByteCap, 1_500_000)
  } finally {
    restoreFetch()
  }
})

test('full pro high uploads above 21 MP fail with a pixel cap reason', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true,
    cloud_plan: 'pro',
    storage_quota_bytes: null,
    total_storage_bytes: 0,
    storage_used_bytes: 0,
    image_count: 0,
    is_banned: false,
  })

  try {
    const response = await worker.fetch(
      buildUploadRequest({
        token,
        bodyBytes: 2_100_001,
        uploadMode: 'full',
        uploadVariant: 'full',
        cloudPlan: 'pro',
        qualityProfile: 'high',
        sourceWidth: 6_000,
        sourceHeight: 3_600,
        storedWidth: 6_000,
        storedHeight: 3_600,
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: { head: async () => null, put: async () => ({ etag: 'etag-2' }) },
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    const payload = await response.json()

    assert.equal(response.status, 413)
    assertTooLargeDetails(payload, 'pixel_cap')
    assert.equal(payload.details.storedPixels, 6_000 * 3_600)
    assert.equal(payload.details.storedPixelCap, 21_000_000)
  } finally {
    restoreFetch()
  }
})

test('full pro high uploads above the edge cap fail with an edge cap reason', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true,
    cloud_plan: 'pro',
    storage_quota_bytes: null,
    total_storage_bytes: 0,
    storage_used_bytes: 0,
    image_count: 0,
    is_banned: false,
  })

  try {
    const response = await worker.fetch(
      buildUploadRequest({
        token,
        bodyBytes: 2_100_001,
        uploadMode: 'full',
        uploadVariant: 'full',
        cloudPlan: 'pro',
        qualityProfile: 'high',
        sourceWidth: 5_301,
        sourceHeight: 1_000,
        storedWidth: 5_301,
        storedHeight: 1_000,
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: { head: async () => null, put: async () => ({ etag: 'etag-3' }) },
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    const payload = await response.json()

    assert.equal(response.status, 413)
    assertTooLargeDetails(payload, 'edge_cap')
    assert.equal(payload.details.storedWidth, 5_301)
    assert.equal(payload.details.storedHeight, 1_000)
    assert.equal(payload.details.resizeMaxEdge, 5_300)
  } finally {
    restoreFetch()
  }
})

// ═══════════════════════════════════════════════════════════════════
// Stage 2a amendment — mode + variant + delivery route coverage.
// ═══════════════════════════════════════════════════════════════════

function makeMockBucketStage2(initial = {}) {
  const objects = new Map(Object.entries(initial))
  return {
    async head(key) {
      const v = objects.get(key)
      return v ? { size: v.body?.byteLength ?? 0, etag: v.etag || 'etag' } : null
    },
    async get(key) {
      const v = objects.get(key)
      if (!v) return null
      return {
        body: v.body,
        httpEtag: v.etag || 'etag',
        writeHttpMetadata(headers) {
          headers.set('Content-Type', v.contentType || 'image/webp')
        },
      }
    },
    async put(key, body, opts) {
      objects.set(key, { body, ...(opts?.httpMetadata || {}), etag: 'etag-put' })
      return { etag: 'etag-put' }
    },
    async delete(key) { objects.delete(key) },
  }
}

function installMockFetchStage2(handlers) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    for (const [pattern, handler] of handlers) {
      if (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)) {
        const result = await handler({ url, init })
        return new Response(JSON.stringify(result.body ?? []), {
          status: result.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return new Response('null', { status: 404 })
  }
  return () => { globalThis.fetch = originalFetch }
}

function baseDeliveryEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    ALLOWED_ORIGINS: 'https://app.sporely.no,https://localhost:5173',
    MEDIA_PUBLIC_BASE_URL: 'https://media.sporely.no',
    MAX_UPLOAD_BYTES: '15728640',
    MEDIA_STORAGE_MODE: 'legacy',
    MEDIA_BUCKET: makeMockBucketStage2(),
    ...overrides,
  }
}

// ── Pure helpers ─────────────────────────────────────────────────

test('Stage2a: MEDIA_VARIANTS allowlist is exactly {full,thumb,original} (mosaic moved to /mm/)', () => {
  assert.deepEqual(
    Array.from(MEDIA_VARIANTS_STAGE2).sort(),
    ['full','original','thumb'].sort(),
  )
})

test('Stage2a: legacy upload types remain separate from delivery variants', () => {
  assert.deepEqual(
    Array.from(LEGACY_UPLOAD_TYPES_STAGE2).sort(),
    ['full', 'original', 'spore_mosaic', 'thumb'].sort(),
  )
  assert.equal(normalizeUploadType_STAGE2('small'), 'thumb')
  assert.equal(MEDIA_VARIANTS_STAGE2.has('spore_mosaic'), false)
})

test('Stage2a: deriveThumbKey shape', () => {
  assert.equal(deriveThumbKey_STAGE2('u/o/0_123.webp'), 'u/o/thumb_0_123.webp')
  assert.equal(deriveThumbKey_STAGE2('u/o/thumb_0_123.webp'), 'u/o/thumb_0_123.webp')
  assert.equal(deriveThumbKey_STAGE2('u/o/small_0_123.webp'), 'u/o/thumb_0_123.webp')
  assert.equal(deriveThumbKey_STAGE2(''), '')
})

test('Stage2a: resolveMediaStorageMode defaults to legacy', () => {
  assert.equal(resolveMediaStorageMode_STAGE2({}), 'legacy')
  assert.equal(resolveMediaStorageMode_STAGE2({ MEDIA_STORAGE_MODE: 'private' }), 'private')
})

test('Stage2a: resolveMediaStorageMode rejects unknown values', () => {
  assert.throws(() => resolveMediaStorageMode_STAGE2({ MEDIA_STORAGE_MODE: 'permissive' }))
})

test('Stage2a: private mode requires PRIVATE_MEDIA_BUCKET binding', () => {
  assert.throws(
    () => selectUploadBucket_STAGE2({ MEDIA_STORAGE_MODE: 'private', MEDIA_BUCKET: makeMockBucketStage2() }),
    /PRIVATE_MEDIA_BUCKET binding is missing/,
  )
})

test('Stage2a: private mode NEVER falls back to MEDIA_BUCKET', () => {
  const legacy = makeMockBucketStage2()
  const priv = makeMockBucketStage2()
  const target = selectUploadBucket_STAGE2({
    MEDIA_STORAGE_MODE: 'private',
    MEDIA_BUCKET: legacy,
    PRIVATE_MEDIA_BUCKET: priv,
  })
  assert.equal(target.name, 'private')
  assert.strictEqual(target.bucket, priv)
})

test('Stage2a: legacy mode requires MEDIA_BUCKET binding', () => {
  assert.throws(() => selectUploadBucket_STAGE2({ MEDIA_STORAGE_MODE: 'legacy' }))
})

// ── /healthz ────────────────────────────────────────────────────

test('Stage2a: /healthz reports mode + bindings without secrets', async () => {
  const env = baseDeliveryEnv({
    MEDIA_STORAGE_MODE: 'private',
    MEDIA_BUCKET: makeMockBucketStage2(),
    PRIVATE_MEDIA_BUCKET: makeMockBucketStage2(),
  })
  const res = await worker.fetch(new Request('https://upload.sporely.no/healthz'), env, {})
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.mediaStorageMode, 'private')
  assert.equal(body.legacyBucketBound, true)
  assert.equal(body.privateBucketBound, true)
  assert.deepEqual(body.supportedMediaVariants, ['full', 'thumb', 'original'])
  assert.deepEqual(body.bindings, { hasMediaBucket: true, hasPrivateMediaBucket: true })
  const serialized = JSON.stringify(body)
  assert.ok(!serialized.includes('test-service-role'), 'service role leaked in /healthz')
})

test('Stage2a: /healthz surfaces invalid mode rather than silently defaulting', async () => {
  const env = baseDeliveryEnv({ MEDIA_STORAGE_MODE: 'permissive' })
  const res = await worker.fetch(new Request('https://upload.sporely.no/healthz'), env, {})
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.mediaStorageMode, null)
  assert.match(body.mediaStorageModeError, /invalid_media_storage_mode/)
})

// ── /m/<id>/<variant>?v=<v> ─────────────────────────────────────

test('Stage2a: /m/ rejects malformed image_id with 404', async () => {
  const restore = installMockFetchStage2([])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/abc/thumb?v=1'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a: /m/ rejects unsupported variants with 404', async () => {
  const restore = installMockFetchStage2([])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/1/notavariant?v=1'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a: /m/ requires ?v= (missing version → 404)', async () => {
  const restore = installMockFetchStage2([])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/1/thumb'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a: /m/ anon on public row matching version returns bytes', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: true, storage_path: 'u/o/full.webp', canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'public', reason: 'public',
    }] })],
  ])
  const env = baseDeliveryEnv({
    MEDIA_BUCKET: makeMockBucketStage2({
      'u/o/full.webp': { body: new TextEncoder().encode('OK') },
    }),
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/full?v=5'), env, {})
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Cache-Control'), 'no-store',
      'Stage 2a defaults to no-store for ALL /m/ responses')
    assert.match(res.headers.get('Vary') || '', /Authorization/)
    assert.equal(await res.text(), 'OK')
  } finally { restore() }
})

test('Stage2a: /m/ obsolete version returns 404 (revocation invariant)', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: true, storage_path: 'u/o/full.webp', canonical_bucket: 'legacy',
      media_version: 7, cache_class: 'public', reason: 'public',
    }] })],
  ])
  const env = baseDeliveryEnv({
    MEDIA_BUCKET: makeMockBucketStage2({
      'u/o/full.webp': { body: new TextEncoder().encode('SHOULD_NOT_LEAK') },
    }),
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/full?v=5'), env, {})
    assert.equal(res.status, 404, 'obsolete ?v= must NOT serve current bytes')
  } finally { restore() }
})

test('Stage2a: /m/ RPC "deny" translates to 404 (no existence disclosure)', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: false, storage_path: null, canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'deny', reason: 'denied',
    }] })],
  ])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/101/full?v=5'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

for (const accessCase of [
  { name: 'owner can read private full media', caller: 'owner-1', variant: 'full', allowed: true, reason: 'owner' },
  { name: 'friend can read friends-visible full media', caller: 'friend-1', variant: 'full', allowed: true, reason: 'friend' },
  { name: 'unrelated user cannot read friends-visible full media', caller: 'other-1', variant: 'full', allowed: false, reason: 'denied' },
  { name: 'friend cannot read original media', caller: 'friend-1', variant: 'original', allowed: false, reason: 'original_owner_only' },
  { name: 'banned-owner media is denied', caller: 'viewer-1', variant: 'full', allowed: false, reason: 'owner_banned' },
]) {
  test(`Stage2a: ${accessCase.name}`, async () => {
    const jwtSecret = 'worker-test-secret'
    const token = buildJwtForSub(accessCase.caller, jwtSecret)
    const restore = installMockFetchStage2([
      ['/rest/v1/rpc/media_authorize_delivery', async ({ init }) => {
        const payload = JSON.parse(init.body)
        assert.equal(payload.p_caller, accessCase.caller)
        assert.equal(payload.p_variant, accessCase.variant)
        return { status: 200, body: [{
          allowed: accessCase.allowed,
          storage_path: accessCase.allowed ? 'u/o/full.webp' : null,
          canonical_bucket: 'legacy', media_version: 5,
          cache_class: accessCase.allowed ? 'private-short' : 'deny',
          reason: accessCase.reason,
        }] }
      }],
    ])
    const env = baseDeliveryEnv({
      SUPABASE_JWT_SECRET: jwtSecret,
      MEDIA_BUCKET: makeMockBucketStage2({
        'u/o/full.webp': { body: new TextEncoder().encode('AUTHORIZED') },
      }),
    })
    try {
      const res = await worker.fetch(new Request(
        `https://upload.sporely.no/m/100/${accessCase.variant}?v=5`,
        { headers: { Authorization: `Bearer ${token}` } },
      ), env, {})
      assert.equal(res.status, accessCase.allowed ? 200 : 404)
      if (accessCase.allowed) assert.equal(await res.text(), 'AUTHORIZED')
    } finally { restore() }
  })
}

test('Stage2a: /m/ tombstone returns 404 (no bytes to any caller)', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: false, storage_path: null, canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'deny', reason: 'deleted',
    }] })],
  ])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/102/full?v=5'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a: /m/ object missing after authorization returns 404 (mid-purge race invisible)', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: true, storage_path: 'u/o/missing.webp', canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'public', reason: 'public',
    }] })],
  ])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/full?v=5'),
      baseDeliveryEnv({ MEDIA_BUCKET: makeMockBucketStage2() /* empty */ }), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a: /m/ selects PRIVATE_MEDIA_BUCKET when canonical_bucket=private', async () => {
  const legacy = makeMockBucketStage2({
    'u/o/full.webp': { body: new TextEncoder().encode('LEGACY') },
  })
  const priv = makeMockBucketStage2({
    'u/o/full.webp': { body: new TextEncoder().encode('PRIVATE') },
  })
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: true, storage_path: 'u/o/full.webp', canonical_bucket: 'private',
      media_version: 5, cache_class: 'public', reason: 'public',
    }] })],
  ])
  const env = baseDeliveryEnv({ MEDIA_BUCKET: legacy, PRIVATE_MEDIA_BUCKET: priv })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/full?v=5'), env, {})
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'PRIVATE',
      'when the row is private, the private bucket must be served')
  } finally { restore() }
})

test('Stage2a: /m/ RPC failure surfaces as 500 not 200 with default body', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('boom', { status: 500 })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/full?v=5'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 500)
  } finally { globalThis.fetch = originalFetch }
})

// ═══════════════════════════════════════════════════════════════════
// Stage 2a amendment (round 2) — variant matrix, overwrite safety,
// key mismatch, cross-user image_id rejection.
// ═══════════════════════════════════════════════════════════════════

function buildJwtForSub(sub, jwtSecret = 'worker-test-secret') {
  return createHs256Jwt(jwtSecret, {
    sub, iss: 'https://example.supabase.co/auth/v1',
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  })
}

test('Stage2a-r2: /m/thumb derives thumb_ prefix from RPC storage_path', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: true, storage_path: 'u/o/full.webp', canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'public', reason: 'public',
    }] })],
  ])
  const env = baseDeliveryEnv({
    MEDIA_BUCKET: makeMockBucketStage2({
      'u/o/thumb_full.webp': { body: new TextEncoder().encode('THUMB_BYTES') },
      'u/o/full.webp':      { body: new TextEncoder().encode('FULL_BYTES') },
    }),
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/thumb?v=5'), env, {})
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'THUMB_BYTES',
      'thumb variant must derive `thumb_<name>` key, not fetch storage_path')
  } finally { restore() }
})

test('Stage2a-r2: /m/original forwards owner JWT as p_caller (via mocked RPC)', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const seenPayloads = []
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async ({ init }) => {
      const payload = JSON.parse(init.body)
      seenPayloads.push(payload)
      // Simulate the SQL RPC: owner-only for 'original'.
      if (payload.p_variant === 'original' && payload.p_caller === 'user-123') {
        return { status: 200, body: [{
          allowed: true, storage_path: 'u/o/full.orig.webp', canonical_bucket: 'legacy',
          media_version: 5, cache_class: 'private-short', reason: 'owner_original',
        }] }
      }
      return { status: 200, body: [{
        allowed: false, storage_path: null, canonical_bucket: 'legacy',
        media_version: 5, cache_class: 'deny', reason: 'original_owner_only',
      }] }
    }],
  ])
  const env = { ...baseDeliveryEnv(), SUPABASE_JWT_SECRET: jwtSecret,
    MEDIA_BUCKET: makeMockBucketStage2({
      'u/o/full.orig.webp': { body: new TextEncoder().encode('ORIG_BYTES') },
    }),
  }
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/original?v=5', {
        headers: { Authorization: `Bearer ${token}` },
      }), env, {})
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'ORIG_BYTES')
    assert.deepEqual(seenPayloads[0], {
      p_image_id: 100, p_variant: 'original', p_caller: 'user-123',
    })
  } finally { restore() }
})

test('Stage2a-r2: /m/original as anon → 404 (owner-only)', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_delivery', async () => ({ status: 200, body: [{
      allowed: false, storage_path: null, canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'deny', reason: 'original_owner_only',
    }] })],
  ])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/100/original?v=5'),
      baseDeliveryEnv(), {})
    assert.equal(res.status, 404, 'anon must not receive original bytes')
  } finally { restore() }
})

// Round-3: `mosaic` is no longer an /m/ variant. Coverage of
// spore-data-visibility gating is on the /mm/ route — see the
// Stage2a-r3 mosaic tests below.

// ── Overwrite refusal preserves previously-valid object ─────────────

// Round-3 note: the round-2 "overwrite refused with 409" test has been
// superseded by the round-3 promote/rollback state machine. The
// invariant "prior bytes preserved on post-write failure" is now
// covered by:
//   * Stage2a-r3: overwrite in private mode PROMOTES temp→final on success
//   * Stage2a-r3: overwrite in private mode PRESERVES prior bytes when
//     canonical_bucket PATCH fails

test('Stage2a-r2: private-mode upload requires X-Sporely-Image-Id', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true, cloud_plan: 'pro', storage_quota_bytes: null,
    total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/new.webp', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/webp',
          'Content-Length': '5',
        },
        body: new TextEncoder().encode('BYTES'),
      }),
      {
        ...TEST_ENV,
        MEDIA_STORAGE_MODE: 'private',
        PRIVATE_MEDIA_BUCKET: makeMockBucketStage2(),
        MEDIA_BUCKET: makeMockBucketStage2(),
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'image_id_required')
  } finally { restoreFetch() }
})

test('Stage2a-r2: private mode rejects mosaic upload instead of using legacy validation', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true, cloud_plan: 'pro', storage_quota_bytes: null,
    total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/mosaic.webp', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/webp',
          'X-Sporely-Upload-Variant': 'spore_mosaic',
        },
        body: new TextEncoder().encode('MOSAIC'),
      }),
      {
        ...TEST_ENV,
        MEDIA_STORAGE_MODE: 'private',
        PRIVATE_MEDIA_BUCKET: makeMockBucketStage2(),
        MEDIA_BUCKET: makeMockBucketStage2(),
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      }, {},
    )
    assert.equal(res.status, 501)
    assert.equal((await res.json()).error, 'private_mosaic_upload_not_ready')
  } finally { restoreFetch() }
})


// ═══════════════════════════════════════════════════════════════════
// Stage 2a amendment (round 3) — /mm/ mosaic route, overwrite state
// machine preserves prior bytes on failure, integrity denial.
// ═══════════════════════════════════════════════════════════════════

test('Stage2a-r3: /mm/ rejects malformed mosaic_id with 404', async () => {
  const restore = installMockFetchStage2([])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/mm/abc?v=1'), baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a-r3: /mm/ requires ?v= (missing version → 404)', async () => {
  const restore = installMockFetchStage2([])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/mm/1'), baseDeliveryEnv(), {})
    assert.equal(res.status, 404)
  } finally { restore() }
})

test('Stage2a-r3: /mm/ hits media_authorize_mosaic_delivery (not the image RPC)', async () => {
  const seenPaths = []
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_mosaic_delivery', async ({ url }) => {
      seenPaths.push(url)
      return { status: 200, body: [{
        allowed: true, storage_key: 'u/o/mosaic.webp', canonical_bucket: 'legacy',
        media_version: 3, cache_class: 'public', reason: 'public',
      }] }
    }],
    ['/rest/v1/rpc/media_authorize_delivery', async ({ url }) => {
      seenPaths.push(url)
      return { status: 200, body: [{ allowed: false, reason: 'wrong_rpc' }] }
    }],
  ])
  const env = baseDeliveryEnv({
    MEDIA_BUCKET: makeMockBucketStage2({
      'u/o/mosaic.webp': { body: new TextEncoder().encode('MOSAIC_BYTES') },
    }),
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/mm/42?v=3'), env, {})
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'MOSAIC_BYTES')
    assert.equal(res.headers.get('Cache-Control'), 'no-store')
    assert.equal(seenPaths.length, 1)
    assert.match(seenPaths[0], /media_authorize_mosaic_delivery/,
      'must hit the mosaic RPC, not the image RPC')
  } finally { restore() }
})

test('Stage2a-r3: /mm/ obsolete version returns 404', async () => {
  const restore = installMockFetchStage2([
    ['/rest/v1/rpc/media_authorize_mosaic_delivery', async () => ({ status: 200, body: [{
      allowed: true, storage_key: 'u/o/mosaic.webp', canonical_bucket: 'legacy',
      media_version: 5, cache_class: 'public', reason: 'public',
    }] })],
  ])
  const env = baseDeliveryEnv({
    MEDIA_BUCKET: makeMockBucketStage2({
      'u/o/mosaic.webp': { body: new TextEncoder().encode('X') },
    }),
  })
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/mm/42?v=3'), env, {})
    assert.equal(res.status, 404, 'obsolete mosaic ?v= must deny')
  } finally { restore() }
})

test('Stage2a-r3: /m/ rejects mosaic variant (no longer in allowlist)', async () => {
  const restore = installMockFetchStage2([])
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/m/1/mosaic?v=1'), baseDeliveryEnv(), {})
    assert.equal(res.status, 404, 'mosaic must not be a valid image variant')
  } finally { restore() }
})

// ── Overwrite state machine ─────────────────────────────────────────

test('Stage2a-r3: overwrite in private mode PROMOTES temp→final on success', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const priv = makeMockBucketStage2({
    'user-123/existing.webp': { body: new TextEncoder().encode('PRIOR_BYTES') },
  })

  const originalFetch = globalThis.fetch
  const patchCalls = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || '')
    if (url.includes('/rest/v1/profiles?')) {
      return new Response(JSON.stringify([{
        is_pro: true, cloud_plan: 'pro', storage_quota_bytes: null,
        total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
      }]), { status: 200 })
    }
    if (url.includes('/rest/v1/observation_images?')) {
      // Row lookup for image_id validation.
      return new Response(JSON.stringify([{
        id: 42, storage_path: 'user-123/existing.webp', canonical_bucket: 'private',
      }]), { status: 200 })
    }
    if (url.includes('/rest/v1/rpc/apply_profile_storage_delta')) {
      return new Response(JSON.stringify([{
        total_storage_bytes: 100, storage_used_bytes: 100, image_count: 1,
      }]), { status: 200 })
    }
    if (init?.method === 'PATCH' && url.includes('/rest/v1/observation_images?id=eq.42')) {
      patchCalls.push('canonical_bucket_patch')
      return new Response(JSON.stringify([{}]), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/existing.webp', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/webp',
          'Content-Length': '3',
          'X-Sporely-Image-Id': '42',
          'X-Sporely-Upload-Variant': 'full',
        },
        body: new TextEncoder().encode('NEW'),
      }),
      {
        ...TEST_ENV,
        MEDIA_STORAGE_MODE: 'private',
        PRIVATE_MEDIA_BUCKET: priv,
        MEDIA_BUCKET: makeMockBucketStage2(),
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 201, 'successful overwrite must promote and return 201')
    // After promotion, the final key holds the NEW bytes.
    const final = await priv.get('user-123/existing.webp')
    assert.equal(new TextDecoder().decode(await final.body), 'NEW',
      'final key must now hold the new bytes after promotion')
  } finally { globalThis.fetch = originalFetch }
})

test('Stage2a-r3: overwrite in private mode PRESERVES prior bytes when canonical_bucket PATCH fails',
  async () => {
    const { jwtSecret, token } = createWorkerAuthToken()
    const priv = makeMockBucketStage2({
      'user-123/existing.webp': { body: new TextEncoder().encode('PRIOR_BYTES_INTACT') },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url || '')
      if (url.includes('/rest/v1/profiles?')) {
        return new Response(JSON.stringify([{
          is_pro: true, cloud_plan: 'pro', storage_quota_bytes: null,
          total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
        }]), { status: 200 })
      }
      if (url.includes('/rest/v1/observation_images?')) {
        // For the row-lookup GET, return a matching row. For the PATCH,
        // return a failure to trigger rollback.
        if (init?.method === 'PATCH') {
          return new Response('rpc error', { status: 500 })
        }
        return new Response(JSON.stringify([{
          id: 42, storage_path: 'user-123/existing.webp', canonical_bucket: 'legacy',
        }]), { status: 200 })
      }
      if (url.includes('/rest/v1/rpc/apply_profile_storage_delta')) {
        return new Response(JSON.stringify([{
          total_storage_bytes: 100, storage_used_bytes: 100, image_count: 1,
        }]), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }
    try {
      const res = await worker.fetch(
        new Request('https://upload.sporely.no/upload/user-123/existing.webp', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'image/webp',
            'Content-Length': '4',
            'X-Sporely-Image-Id': '42',
            'X-Sporely-Upload-Variant': 'full',
          },
          body: new TextEncoder().encode('BAD!'),
        }),
        {
          ...TEST_ENV,
          MEDIA_STORAGE_MODE: 'private',
          PRIVATE_MEDIA_BUCKET: priv,
          MEDIA_BUCKET: makeMockBucketStage2(),
          SUPABASE_URL: 'https://example.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
          SUPABASE_JWT_SECRET: jwtSecret,
        },
        {},
      )
      assert.equal(res.status, 500,
        'canonical_bucket PATCH failure surfaces as 500')
      // Prior bytes must be intact — no promotion occurred.
      const final = await priv.get('user-123/existing.webp')
      const raw = new TextDecoder().decode(await final.body)
      assert.equal(raw, 'PRIOR_BYTES_INTACT',
        'prior bytes destroyed by rejected overwrite (invariant violated)')
    } finally { globalThis.fetch = originalFetch }
  })

// ── DELETE /upload/<key> attempts both legacy + private buckets ───────

function makeTrackedBucket(entries = {}) {
  const store = new Map(Object.entries(entries))
  const events = []
  return {
    events,
    head: async key => {
      events.push({ op: 'head', key })
      if (!store.has(key)) return null
      return { size: store.get(key).size }
    },
    delete: async key => {
      events.push({ op: 'delete', key })
      store.delete(key)
    },
    _has: key => store.has(key),
  }
}

test('DELETE /upload/<key>: removes from BOTH legacy and private buckets when both are bound', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true,
    cloud_plan: 'pro',
    storage_quota_bytes: null,
    total_storage_bytes: 3000,
    storage_used_bytes: 3000,
    image_count: 3,
    is_banned: false,
  })
  const legacyBucket = makeTrackedBucket({ 'user-123/a/full.webp': { size: 1000 } })
  const privateBucket = makeTrackedBucket({ 'user-123/a/full.webp': { size: 500 } })

  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/a/full.webp', {
        method: 'DELETE',
        headers: {
          Origin: 'https://localhost',
          Authorization: `Bearer ${token}`,
        },
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: legacyBucket,
        PRIVATE_MEDIA_BUCKET: privateBucket,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.buckets.legacy, true)
    assert.equal(body.buckets.private, true)
    // Both buckets received a delete call.
    assert.ok(legacyBucket.events.some(e => e.op === 'delete' && e.key === 'user-123/a/full.webp'))
    assert.ok(privateBucket.events.some(e => e.op === 'delete' && e.key === 'user-123/a/full.webp'))
    assert.equal(legacyBucket._has('user-123/a/full.webp'), false)
    assert.equal(privateBucket._has('user-123/a/full.webp'), false)
  } finally { restoreFetch() }
})

test('DELETE /upload/<key>: works when object lives ONLY in the private bucket', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: true,
    cloud_plan: 'pro',
    storage_quota_bytes: null,
    total_storage_bytes: 500,
    storage_used_bytes: 500,
    image_count: 1,
    is_banned: false,
  })
  const legacyBucket = makeTrackedBucket()
  const privateBucket = makeTrackedBucket({ 'user-123/a/full.webp': { size: 500 } })

  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/a/full.webp', {
        method: 'DELETE',
        headers: { Origin: 'https://localhost', Authorization: `Bearer ${token}` },
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: legacyBucket,
        PRIVATE_MEDIA_BUCKET: privateBucket,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.buckets.legacy, false)
    assert.equal(body.buckets.private, true)
    assert.equal(privateBucket._has('user-123/a/full.webp'), false)
  } finally { restoreFetch() }
})

test('DELETE /upload/<key>: works when object lives ONLY in the legacy bucket', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: false,
    cloud_plan: 'free',
    storage_quota_bytes: null,
    total_storage_bytes: 1000,
    storage_used_bytes: 1000,
    image_count: 1,
    is_banned: false,
  })
  const legacyBucket = makeTrackedBucket({ 'user-123/legacy/full.webp': { size: 1000 } })
  const privateBucket = makeTrackedBucket()

  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/legacy/full.webp', {
        method: 'DELETE',
        headers: { Origin: 'https://localhost', Authorization: `Bearer ${token}` },
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: legacyBucket,
        PRIVATE_MEDIA_BUCKET: privateBucket,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.buckets.legacy, true)
    assert.equal(body.buckets.private, false)
    assert.equal(legacyBucket._has('user-123/legacy/full.webp'), false)
  } finally { restoreFetch() }
})

test('DELETE /upload/<key>: missing-from-both is a 200 no-op (idempotent for account deletion retry)', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: false,
    cloud_plan: 'free',
    storage_quota_bytes: null,
    total_storage_bytes: 0,
    storage_used_bytes: 0,
    image_count: 0,
    is_banned: false,
  })
  const legacyBucket = makeTrackedBucket()
  const privateBucket = makeTrackedBucket()

  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/user-123/nope.webp', {
        method: 'DELETE',
        headers: { Origin: 'https://localhost', Authorization: `Bearer ${token}` },
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: legacyBucket,
        PRIVATE_MEDIA_BUCKET: privateBucket,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.buckets.legacy, false)
    assert.equal(body.buckets.private, false)
  } finally { restoreFetch() }
})

test('DELETE /upload/<key>: refuses when NEITHER bucket binding is configured', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const res = await worker.fetch(
    new Request('https://upload.sporely.no/upload/user-123/a.webp', {
      method: 'DELETE',
      headers: { Origin: 'https://localhost', Authorization: `Bearer ${token}` },
    }),
    {
      ...TEST_ENV,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_JWT_SECRET: jwtSecret,
    },
    {},
  )
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.equal(body.error, 'missing_bucket')
})

test('DELETE /upload/<key>: still enforces key must start with authenticated user id', async () => {
  const { jwtSecret, token } = createWorkerAuthToken()
  const restoreFetch = installProfileFetchMock({
    is_pro: false, cloud_plan: 'free', storage_quota_bytes: null,
    total_storage_bytes: 0, storage_used_bytes: 0, image_count: 0, is_banned: false,
  })
  const legacyBucket = makeTrackedBucket({ 'other-user/foo.webp': { size: 1 } })
  const privateBucket = makeTrackedBucket()
  try {
    const res = await worker.fetch(
      new Request('https://upload.sporely.no/upload/other-user/foo.webp', {
        method: 'DELETE',
        headers: { Origin: 'https://localhost', Authorization: `Bearer ${token}` },
      }),
      {
        ...TEST_ENV,
        MEDIA_BUCKET: legacyBucket,
        PRIVATE_MEDIA_BUCKET: privateBucket,
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_JWT_SECRET: jwtSecret,
      },
      {},
    )
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.error, 'key_not_allowed')
    // Ensure no delete was issued to either bucket.
    assert.equal(legacyBucket.events.filter(e => e.op === 'delete').length, 0)
    assert.equal(privateBucket.events.filter(e => e.op === 'delete').length, 0)
  } finally { restoreFetch() }
})
