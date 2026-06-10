import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import worker from './index.js'

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
      'Access-Control-Request-Headers': 'authorization,content-type,cache-control,x-sporely-source-height,x-sporely-source-width,x-sporely-stored-height,x-sporely-stored-width,x-sporely-encoding-quality,x-sporely-encoding-format,x-sporely-upload-mode,x-sporely-upload-variant,x-sporely-cloud-plan,x-sporely-quality-profile',
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

test('full pro high webp uploads at 5184x3888 succeed under the plan caps', async () => {
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
