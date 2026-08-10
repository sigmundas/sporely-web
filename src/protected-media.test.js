import test from 'node:test'
import assert from 'node:assert/strict'

import { ProtectedMediaLoader } from './protected-media.js'

function element() {
  const attributes = new Map()
  return {
    dataset: {},
    src: '',
    removeAttribute(name) {
      attributes.delete(name)
      if (name === 'src') this.src = ''
    },
  }
}

function imageResponse({ status = 200, type = 'image/webp' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => type },
    blob: async () => new Blob(['image'], { type }),
  }
}

function createHarness(responses = [imageResponse()]) {
  const requests = []
  const created = []
  const revoked = []
  let nextObjectUrl = 1
  const loader = new ProtectedMediaLoader({
    getSession: async () => ({ access_token: 'secret-token', user: { id: 'user-a' } }),
    fetch: async (url, options) => {
      requests.push({ url, options })
      return responses[Math.min(requests.length - 1, responses.length - 1)]
    },
    createObjectURL: blob => {
      const url = `blob:protected-${nextObjectUrl++}`
      created.push({ url, blob })
      return url
    },
    revokeObjectURL: url => revoked.push(url),
  })
  return { loader, requests, created, revoked }
}

test('protected media uses a bearer header without putting the token in the URL', async () => {
  const { loader, requests } = createHarness()
  const img = element()
  const workerUrl = 'https://upload.sporely.no/m/4962/thumb?v=7'

  const objectUrl = await loader.bind(img, workerUrl)

  assert.equal(objectUrl, 'blob:protected-1')
  assert.equal(img.src, 'blob:protected-1')
  assert.equal(requests[0].url, workerUrl)
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token')
  assert.equal(requests[0].url.includes('secret-token'), false)
})

test('changing media version fetches again and revokes the previous object URL', async () => {
  const { loader, requests, revoked } = createHarness()
  const img = element()

  await loader.bind(img, 'https://upload.sporely.no/m/4962/full?v=7')
  await loader.bind(img, 'https://upload.sporely.no/m/4962/full?v=8')

  assert.equal(requests.length, 2)
  assert.deepEqual(revoked, ['blob:protected-1'])
  assert.equal(img.src, 'blob:protected-2')
})

test('logout revokes object URLs and drops the previous principal bindings', async () => {
  const { loader, requests, revoked } = createHarness()
  const img = element()
  await loader.bind(img, 'https://upload.sporely.no/m/4962/full?v=7')

  loader.handleSessionChange(null)
  assert.deepEqual(revoked, ['blob:protected-1'])
  assert.equal(img.src, '')

  loader.handleSessionChange({ access_token: 'next-token', user: { id: 'user-b' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  assert.equal(img.src, '')
})

test('token refresh revokes and refetches with the new bearer token', async () => {
  const { loader, requests, revoked } = createHarness()
  const img = element()
  await loader.bind(img, 'https://upload.sporely.no/m/4962/full?v=7')

  loader.handleSessionChange({ access_token: 'refreshed-token', user: { id: 'user-a' } })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(revoked, ['blob:protected-1'])
  assert.equal(requests.length, 2)
  assert.equal(requests[1].options.headers.Authorization, 'Bearer refreshed-token')
  assert.equal(img.src, 'blob:protected-2')
})

test('direct account switch revokes and does not reuse the previous principal binding', async () => {
  const { loader, requests, revoked } = createHarness()
  const img = element()
  await loader.bind(img, 'https://upload.sporely.no/m/4962/full?v=7')

  loader.handleSessionChange({ access_token: 'user-b-token', user: { id: 'user-b' } })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(revoked, ['blob:protected-1'])
  assert.equal(requests.length, 1)
  assert.equal(img.src, '')
})

for (const status of [401, 403, 404]) {
  test(`${status} fails closed without requesting a legacy CDN URL`, async () => {
    const { loader, requests, created } = createHarness([imageResponse({ status })])
    const img = element()

    const result = await loader.bind(img, 'https://upload.sporely.no/m/4962/thumb?v=7')

    assert.equal(result, null)
    assert.equal(img.src, '')
    assert.equal(created.length, 0)
    assert.equal(requests.length, 1)
    assert.equal(requests.some(request => request.url.includes('media.sporely.no')), false)
  })
}

test('dispose revokes every active protected object URL exactly once', async () => {
  const { loader, revoked } = createHarness()
  await loader.bind(element(), 'https://upload.sporely.no/m/1/thumb?v=1')
  await loader.bind(element(), 'https://upload.sporely.no/m/2/thumb?v=1')

  loader.dispose()
  loader.dispose()

  assert.deepEqual(revoked, ['blob:protected-1', 'blob:protected-2'])
})
