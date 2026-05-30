import test from 'node:test'
import assert from 'node:assert/strict'

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
