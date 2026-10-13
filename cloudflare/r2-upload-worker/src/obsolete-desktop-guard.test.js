import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import worker from './index.js'
import {
  UPGRADE_REQUIRED_CODE,
  UPGRADE_REQUIRED_MESSAGE,
  isMediaMutationRequest,
  isObsoleteDesktopRequest,
  obsoleteDesktopRefusal,
} from './obsolete-desktop-guard.js'

const PYTHON_UA = 'python-requests/2.32.3'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36'
const UPLOAD_URL = 'https://upload.sporely.no/upload/user-123/obs-123/0_000000.webp'
const JWT_SECRET = 'worker-test-secret'

// Union of _CLOUD_AUTH_ERROR_HINTS and _SUPABASE_TRANSIENT_ERROR_HINTS in the
// shipped desktops (v0.8.13, v0.9.1, v0.9.11, v0.9.15, v0.9.18, v0.9.19,
// v0.9.25, ee6f2af).
const SHIPPED_DESKTOP_HINT_WORDS = [
  'jwt expired', 'invalid jwt', 'expired access token', 'access token expired',
  'auth refresh failed', 'token expired', 'session expired', 'authentication failed',
  'invalid_grant', 'not logged in', 'unauthorized', 'pgrst301', 'pgrst303', 'captcha_failed',
  'bad gateway', 'connection aborted', 'connection refused', 'connection reset',
  'could not connect to server', 'gateway timeout', 'postgrest unavailable', 'schema cache',
  'service unavailable', 'temporarily unavailable', 'timed out', 'timeout',
]

function createToken() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'user-123',
    iss: 'https://example.supabase.co/auth/v1',
    aud: 'authenticated',
    exp: now + 3600,
    iat: now,
  })}`
  const signature = createHmac('sha256', JWT_SECRET).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

// A bucket that records every call and can hold objects.
function trackedBucket(entries = {}) {
  const store = new Map(Object.entries(entries))
  const events = []
  return {
    events,
    head: async key => {
      events.push({ op: 'head', key })
      return store.has(key) ? { size: store.get(key).size } : null
    },
    get: async key => {
      events.push({ op: 'get', key })
      return null
    },
    put: async (key, body) => {
      events.push({ op: 'put', key })
      store.set(key, { size: body?.byteLength ?? 0 })
      return { etag: 'etag-1' }
    },
    delete: async key => {
      events.push({ op: 'delete', key })
      store.delete(key)
    },
    has: key => store.has(key),
  }
}

// Answers the worker's Supabase calls and records them.
function installSupabaseMock() {
  const originalFetch = globalThis.fetch
  const calls = []
  const storage = [{ total_storage_bytes: 1000, storage_used_bytes: 1000, image_count: 1 }]
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '')
    calls.push({ url, method: init?.method || 'GET' })
    const json = body => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    if (url.includes('/rest/v1/profiles?')) {
      return json([{
        is_pro: true,
        cloud_plan: 'pro',
        storage_quota_bytes: null,
        total_storage_bytes: 1000,
        storage_used_bytes: 1000,
        image_count: 1,
        is_banned: false,
      }])
    }
    if (url.includes('/rest/v1/rpc/apply_profile_storage_delta')) return json(storage)
    if (url.includes('/rest/v1/rpc/prepare_media_object_deletion')) return json(null)
    if (url.includes('/rest/v1/rpc/finalize_media_object_deletion')) return json(storage)
    throw new Error(`Unexpected fetch call: ${url}`)
  }
  return { calls, restore: () => { globalThis.fetch = originalFetch } }
}

function workerEnv(bucket) {
  return {
    ALLOWED_ORIGINS: 'https://app.sporely.no',
    MEDIA_BUCKET: bucket,
    MEDIA_PUBLIC_BASE_URL: 'https://media.sporely.no',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: JWT_SECRET,
  }
}

// The request a shipped desktop sends (utils/r2_storage.py worker client),
// with a valid token, so only the brake can stop it.
function desktopUpload(userAgent, extraHeaders = {}) {
  return new Request(UPLOAD_URL, {
    method: 'PUT',
    headers: {
      'User-Agent': userAgent,
      Authorization: `Bearer ${createToken()}`,
      'Content-Type': 'image/webp',
      'X-Sporely-Upload-Mode': 'full',
      'X-Sporely-Upload-Variant': 'full',
      'X-Sporely-Cloud-Plan': 'pro',
      'X-Sporely-Quality-Profile': 'standard',
      'X-Sporely-Encoding-Format': 'image/webp',
      'X-Sporely-Source-Width': '800',
      'X-Sporely-Source-Height': '600',
      'X-Sporely-Stored-Width': '800',
      'X-Sporely-Stored-Height': '600',
      ...extraHeaders,
    },
    body: Buffer.alloc(1000, 1),
  })
}

function desktopDelete(userAgent, extraHeaders = {}) {
  return new Request(UPLOAD_URL, {
    method: 'DELETE',
    headers: {
      'User-Agent': userAgent,
      Authorization: `Bearer ${createToken()}`,
      ...extraHeaders,
    },
  })
}

async function assertUpgradeRequired(response, { origin = null } = {}) {
  assert.equal(response.status, 426)
  assert.equal(response.headers.get('X-Sporely-Error-Code'), UPGRADE_REQUIRED_CODE)
  assert.equal(response.headers.get('Content-Type'), 'application/json')
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'X-Sporely-Error-Code')
  if (origin) assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin)
  assert.deepEqual(await response.json(), {
    error: UPGRADE_REQUIRED_CODE,
    message: UPGRADE_REQUIRED_MESSAGE,
  })
}

// ── Pure guard ────────────────────────────────────────────────────────

test('guard: the message matches the database refusal', () => {
  assert.equal(
    UPGRADE_REQUIRED_MESSAGE,
    'Sporely Desktop must be updated before it can upload to Sporely Cloud. Install the latest version from sporely.no. Nothing was changed in the cloud.',
  )
})

test('guard: message and code contain no shipped-desktop auth or transient hint word', () => {
  const text = `${UPGRADE_REQUIRED_MESSAGE} ${UPGRADE_REQUIRED_CODE}`.toLowerCase()
  for (const word of SHIPPED_DESKTOP_HINT_WORDS) {
    assert.equal(text.includes(word), false, `refusal must not contain "${word}"`)
  }
})

test('guard: identifies shipped desktops by the python-requests User-Agent, case-insensitively', () => {
  const at = headers => new Request(UPLOAD_URL, { method: 'PUT', headers })
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': PYTHON_UA })), true)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': 'Python-Requests/2.28.1' })), true)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': PYTHON_UA, 'X-Sporely-Sync-Identity': '1' })), true)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': PYTHON_UA, 'X-Sporely-Sync-Identity': '2' })), false)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': BROWSER_UA })), false)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': WEBVIEW_UA })), false)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': 'Sporely/AI' })), false)
  assert.equal(isObsoleteDesktopRequest(at({ 'User-Agent': 'xpython-requests/2.0' })), false)
  assert.equal(isObsoleteDesktopRequest(at({})), false)
})

test('guard: only non-read methods under /upload/ are media mutations', () => {
  const at = (method, path) => new Request(`https://upload.sporely.no${path}`, { method })
  for (const method of ['PUT', 'DELETE', 'POST', 'PATCH']) {
    assert.equal(isMediaMutationRequest(at(method, '/upload/user-123/a.webp')), true, method)
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(isMediaMutationRequest(at(method, '/upload/user-123/a.webp')), false, method)
  }
  assert.equal(isMediaMutationRequest(at('POST', '/artsorakel')), false)
  assert.equal(isMediaMutationRequest(at('POST', '/artsorakel/media')), false)
  assert.equal(isMediaMutationRequest(at('GET', '/reverse-location')), false)
  assert.equal(isMediaMutationRequest(at('GET', '/m/1/full')), false)
  assert.equal(isMediaMutationRequest(at('GET', '/mm/1')), false)
})

test('guard: refusal is 426 with the error code, JSON body and the given CORS headers', async () => {
  const cors = new Headers({
    'Access-Control-Allow-Origin': 'https://app.sporely.no',
    'Access-Control-Expose-Headers': 'X-Sporely-Error-Code',
  })
  const response = obsoleteDesktopRefusal(
    new Request(UPLOAD_URL, { method: 'DELETE', headers: { 'User-Agent': PYTHON_UA } }),
    cors,
  )
  await assertUpgradeRequired(response, { origin: 'https://app.sporely.no' })
})

test('guard: returns null for requests that may proceed', () => {
  const allowed = [
    new Request(UPLOAD_URL, { method: 'PUT', headers: { 'User-Agent': BROWSER_UA } }),
    new Request(UPLOAD_URL, { method: 'PUT', headers: { 'User-Agent': PYTHON_UA, 'X-Sporely-Sync-Identity': '2' } }),
    new Request(UPLOAD_URL, { method: 'GET', headers: { 'User-Agent': PYTHON_UA } }),
    new Request('https://upload.sporely.no/artsorakel', { method: 'POST', headers: { 'User-Agent': PYTHON_UA } }),
  ]
  for (const request of allowed) {
    assert.equal(obsoleteDesktopRefusal(request, new Headers()), null, `${request.method} ${request.url}`)
  }
})

// ── Wired into the worker ─────────────────────────────────────────────

for (const route of [
  { name: 'PUT /upload/<key> (create or replace)', build: () => desktopUpload(PYTHON_UA) },
  {
    name: 'PUT /upload/<key> binding an image row',
    build: () => desktopUpload(PYTHON_UA, { 'X-Sporely-Image-Id': '42', 'X-Sporely-Upload-Type': 'full' }),
  },
  {
    name: 'PUT /upload/<key> binding a mosaic row',
    build: () => desktopUpload(PYTHON_UA, { 'X-Sporely-Mosaic-Id': '7', 'X-Sporely-Upload-Type': 'spore_mosaic' }),
  },
  { name: 'DELETE /upload/<key>', build: () => desktopDelete(PYTHON_UA) },
  {
    name: 'DELETE /upload/<key> with sync-identity 1',
    build: () => desktopDelete(PYTHON_UA, { 'X-Sporely-Sync-Identity': '1' }),
  },
  {
    name: 'POST /upload/<key>',
    build: () => new Request(UPLOAD_URL, { method: 'POST', headers: { 'User-Agent': PYTHON_UA } }),
  },
]) {
  test(`worker: old desktop ${route.name} is refused with 426 and no R2 or Supabase call`, async () => {
    const bucket = trackedBucket({ 'user-123/obs-123/0_000000.webp': { size: 1000 } })
    const privateBucket = trackedBucket({ 'user-123/obs-123/0_000000.webp': { size: 1000 } })
    const supabase = installSupabaseMock()
    try {
      const response = await worker.fetch(
        route.build(),
        { ...workerEnv(bucket), PRIVATE_MEDIA_BUCKET: privateBucket },
        {},
      )
      await assertUpgradeRequired(response)
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
      assert.deepEqual(bucket.events, [], 'legacy bucket untouched')
      assert.deepEqual(privateBucket.events, [], 'private bucket untouched')
      assert.equal(bucket.has('user-123/obs-123/0_000000.webp'), true)
      assert.equal(privateBucket.has('user-123/obs-123/0_000000.webp'), true)
      assert.deepEqual(supabase.calls, [], 'no quota, row or JWKS call')
    } finally {
      supabase.restore()
    }
  })
}

test('worker: refusal keeps the usual CORS headers for an allowed origin', async () => {
  const response = await worker.fetch(
    new Request(UPLOAD_URL, {
      method: 'DELETE',
      headers: { 'User-Agent': PYTHON_UA, Origin: 'https://app.sporely.no' },
    }),
    workerEnv(trackedBucket()),
    {},
  )
  await assertUpgradeRequired(response, { origin: 'https://app.sporely.no' })
  assert.equal(response.headers.get('Vary'), 'Origin')
})

test('worker: the same upload succeeds from a browser and from Android WebView', async () => {
  for (const userAgent of [BROWSER_UA, WEBVIEW_UA]) {
    const bucket = trackedBucket()
    const supabase = installSupabaseMock()
    try {
      const response = await worker.fetch(desktopUpload(userAgent), workerEnv(bucket), {})
      assert.equal(response.status, 201, userAgent)
      assert.ok(bucket.events.some(event => event.op === 'put'), 'object written')
    } finally {
      supabase.restore()
    }
  }
})

test('worker: the same upload succeeds with x-sporely-sync-identity: 2', async () => {
  const bucket = trackedBucket()
  const supabase = installSupabaseMock()
  try {
    const response = await worker.fetch(
      desktopUpload(PYTHON_UA, { 'X-Sporely-Sync-Identity': '2' }),
      workerEnv(bucket),
      {},
    )
    assert.equal(response.status, 201)
    assert.ok(bucket.events.some(event => event.op === 'put'), 'object written')
  } finally {
    supabase.restore()
  }
})

test('worker: the same delete succeeds from a browser and with x-sporely-sync-identity: 2', async () => {
  for (const [userAgent, extra] of [[BROWSER_UA, {}], [PYTHON_UA, { 'X-Sporely-Sync-Identity': '2' }]]) {
    const bucket = trackedBucket({ 'user-123/obs-123/0_000000.webp': { size: 1000 } })
    const supabase = installSupabaseMock()
    try {
      const response = await worker.fetch(desktopDelete(userAgent, extra), workerEnv(bucket), {})
      assert.equal(response.status, 200, userAgent)
      assert.equal(bucket.has('user-123/obs-123/0_000000.webp'), false, 'object deleted')
    } finally {
      supabase.restore()
    }
  }
})

test('worker: read routes and non-media services are not braked for old desktops', async () => {
  const env = workerEnv(trackedBucket())
  const reads = [
    new Request(UPLOAD_URL, { method: 'GET', headers: { 'User-Agent': PYTHON_UA } }),
    new Request(UPLOAD_URL, { method: 'HEAD', headers: { 'User-Agent': PYTHON_UA } }),
    new Request('https://upload.sporely.no/m/1/full?v=1', { method: 'GET', headers: { 'User-Agent': PYTHON_UA } }),
    new Request('https://upload.sporely.no/mm/1?v=1', { method: 'GET', headers: { 'User-Agent': PYTHON_UA } }),
    new Request('https://upload.sporely.no/artsorakel', { method: 'POST', headers: { 'User-Agent': PYTHON_UA } }),
    new Request('https://upload.sporely.no/artsorakel/media', { method: 'POST', headers: { 'User-Agent': PYTHON_UA } }),
    new Request('https://upload.sporely.no/reverse-location?lat=60&lon=10', { method: 'GET', headers: { 'User-Agent': PYTHON_UA } }),
  ]
  const supabase = installSupabaseMock()
  try {
    for (const request of reads) {
      const response = await worker.fetch(request, env, {})
      assert.notEqual(response.status, 426, `${request.method} ${request.url}`)
      assert.notEqual(response.headers.get('X-Sporely-Error-Code'), UPGRADE_REQUIRED_CODE)
    }
  } finally {
    supabase.restore()
  }

  const health = await worker.fetch(
    new Request('https://upload.sporely.no/healthz', { headers: { 'User-Agent': PYTHON_UA } }),
    env,
    {},
  )
  assert.equal(health.status, 200)
})

test('worker: OPTIONS preflight from an old desktop is answered normally', async () => {
  const response = await worker.fetch(
    new Request(UPLOAD_URL, {
      method: 'OPTIONS',
      headers: {
        'User-Agent': PYTHON_UA,
        Origin: 'https://app.sporely.no',
        'Access-Control-Request-Method': 'PUT',
      },
    }),
    workerEnv(trackedBucket()),
    {},
  )
  assert.equal(response.status, 204)
})
